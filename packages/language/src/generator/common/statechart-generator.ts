import { AstUtils, type AstNode } from 'langium';
import * as ast from '../../generated/ast.js';
import { qualifiedName } from '../../statemachine-scope.js';
import { importKind, instanceVariables } from '../../imports.js';
import { storageOfTypeReference } from '../../cpp-storage.js';
import type { CppResolvedType } from '../../cpp-header/model.js';
import { typeOfVariable, type DevmType } from '../../typesystem.js';
import { entryPointOf, nodeText, transitionLabel } from '../../model-utils.js';
import { StatechartInterpreter, type ExecutionMode, type ExecutionOrder } from '../../simulation/interpreter.js';
import { isFinalState, ModelIndex, type RegionNode, type TargetVertex } from '../../simulation/model-index.js';
import { CBlock, cInteger, commentText, indent, stripParens, UniqueNames } from './code.js';
import { ExpressionCompiler, type Code, type ExpressionContext, type Helper } from './expressions.js';

/**
 * The language-neutral part of the C and C++ code generators: analysis of the state machine (names
 * of states, regions, pseudo states, transitions, events and timers) and the structure of the
 * generated code, which implements docs/semantics.md exactly like the interpreter: one function per
 * state (`enter_…`, `enseq_…`, `exit_…`, `react_…`), region (`renter_…`, `rexit_…`, `rfinal_…`,
 * `rrestore_…`), pseudo state (`choice_…`, `history_…`, …) and transition (`transition_N`).
 *
 * The generated statements use the C-family syntax common to C and C++; everything that differs
 * (how the state machine data is accessed, how generated functions are called, type names, strings,
 * errors, timers, the runtime and the API) is provided by the subclasses through the abstract hooks.
 * Functions are generated on demand, so that there are no unused functions.
 */

/** Thrown for models that cannot be translated; reported as a diagnostic. */
export class GeneratorError extends Error {
    constructor(message: string, readonly node?: AstNode) {
        super(message);
    }
}

/** Message of the generator diagnostic for models with submachine instances (docs/semantics.md §9). */
export const SUBMACHINES_NOT_SUPPORTED = 'Submachine instances are not supported by the C/C++ generator yet';

/** Message of the C generator diagnostic for models using C/C++ header imports (docs/cpp-integration.md). */
export const CPP_TYPES_NOT_SUPPORTED = 'C++ header types are not supported by the C generator';

/**
 * The first use of C/C++ header imports or C++ types in a state machine (a header import, a type
 * reference resolved as C++ type, a C++ constant or enumerator), `undefined` if there is none.
 */
export function cppTypeUsage(machine: ast.StateMachine): AstNode | undefined {
    const header = machine.imports.flatMap(i => i.paths).find(p => p.path && importKind(p.path) === 'header');
    if (header) {
        return header;
    }
    for (const node of AstUtils.streamAst(machine)) {
        if (ast.isCppReference(node) || (ast.isTypeReference(node) && storageOfTypeReference(node) !== undefined)) {
            return node;
        }
    }
    return undefined;
}

/** Nanoseconds per time unit. */
export const NS_PER_UNIT: Record<string, bigint> = { s: 1000000000n, ms: 1000000n, us: 1000n, ns: 1n };

/** Kinds of runtime errors of the generated code (not every target has all of them). */
export type ErrorKind = 'division_by_zero' | 'shift_out_of_range' | 'invalid_conversion' | 'no_enabled_transition'
    | 'no_initial_transition' | 'invalid_time' | 'loop' | 'queue_overflow' | 'string_overflow' | 'index_out_of_bounds';

export interface EnterTarget {
    vertex: TargetVertex;
    entryPoint?: string;
}

/** A time event: a time trigger of a state or of the state machine. */
export interface TimerInfo {
    trigger: ast.TimeTrigger;
    owner: ast.State | ast.StateMachine;
    /** `statechart` or the name of the owner state (`Operating_Red`). */
    ownerName: string;
    /** Index of the trigger among the time triggers of its owner. */
    index: number;
}

/** A generated (internal) function of the state machine. */
export interface GeneratedFunction {
    name: string;
    returnType: DevmType;
    /** Parameters besides the state machine (`int item`). */
    params: string[];
    comment: string;
    body: CBlock;
    order: number;
}

/** A scope of the definition section: the unnamed interface, a named interface or the internal scope. */
export interface ScopeInfo {
    kind: 'default' | 'named' | 'internal';
    /** Name of a named interface. */
    name?: string;
    /** Names of the variables of the scope. */
    names: UniqueNames;
}

export interface NamingOptions {
    /** Identifiers that generated names must not use. */
    keywords: ReadonlySet<string>;
    /** State names that are used by the generated code itself (`NO_STATE`, ...). */
    reservedStateNames: string[];
}

export abstract class StatechartGenerator implements ExpressionContext {

    protected readonly index: ModelIndex;
    protected readonly mode: ExecutionMode;
    protected readonly order: ExecutionOrder;
    protected readonly cyclePeriod: number;
    protected readonly maxMicrosteps: number;
    protected readonly expressions: ExpressionCompiler;

    protected readonly stateNames = new Map<ast.State, string>();
    protected readonly regionNames = new Map<RegionNode, string>();
    protected readonly pseudoNames = new Map<ast.PseudoState, string>();
    protected readonly eventNames = new Map<ast.EventDeclaration, string>();
    protected readonly variableMembers = new Map<ast.VariableDeclaration, string>();
    protected readonly declarationScopes = new Map<ast.Declaration, ScopeInfo>();
    protected readonly scopes = new Map<string, ScopeInfo>();
    protected readonly variableTypes = new Map<ast.VariableDeclaration, DevmType>();
    protected readonly transitionNumbers = new Map<ast.Transition, number>();
    protected readonly timers: TimerInfo[] = [];
    protected readonly timerByTrigger = new Map<ast.TimeTrigger, TimerInfo>();
    protected readonly regions: RegionNode[] = [];
    protected readonly historyRegions = new Set<RegionNode>();
    protected readonly finalRegions = new Set<RegionNode>();

    protected readonly functions = new Map<string, GeneratedFunction>();
    private readonly pending: Array<() => void> = [];
    protected readonly helpers = new Set<Helper>();
    private functionOrder = 0;

    constructor(protected readonly machine: ast.StateMachine, maxMicrosteps: number | undefined, naming: NamingOptions) {
        const instance = instanceVariables(machine)[0];
        if (instance) {
            throw new GeneratorError(`${SUBMACHINES_NOT_SUPPORTED} ('${instance.name}'); simulate the model or use state machines without instances.`, instance);
        }
        this.index = new ModelIndex(machine);
        const interpreter = new StatechartInterpreter(machine);
        this.mode = interpreter.executionMode;
        this.order = interpreter.executionOrder;
        this.cyclePeriod = interpreter.cyclePeriod;
        this.maxMicrosteps = maxMicrosteps ?? 1000;
        this.expressions = new ExpressionCompiler(this);
        this.collectNames(naming);
    }

    // -----------------------------------------------------------------------------------------
    // Hooks of the target language

    /** A call of a generated function (`enter_A(h)` in C, `enter_A()` in C++); `args` without the state machine. */
    protected abstract call(fn: string, args?: string): string;
    /** Access of a runtime field of the state machine (`h->active` in C, `active` in C++). */
    protected abstract field(name: string): string;
    /** The constant of a state in the state enum. */
    protected abstract stateConstant(state: ast.State): string;
    protected abstract get noState(): string;
    protected abstract get finalState(): string;
    /** Index of a state in the `entered` / `exited` arrays. */
    protected abstract stateSlot(state: ast.State): string;
    /** Constant identifying a time event. */
    protected abstract timerConstant(timer: TimerInfo): string;
    /** Constant identifying an event (index into `present`). */
    protected abstract eventConstant(event: ast.EventDeclaration): string;
    /** Type of the state enum. */
    protected abstract get stateType(): string;
    /** Name of the constant limiting the number of transitions per step. */
    protected abstract get maxMicrostepsConstant(): string;
    /** Statement reporting a runtime error (docs/semantics.md); `node` is the model element that failed. */
    protected abstract errorCall(kind: ErrorKind, message: string, node?: AstNode): string;
    /** Statement starting the timer of a time event (duration in ns). */
    protected abstract setTimer(timer: TimerInfo, duration: string, periodic: boolean): string;
    /** Statement stopping the timer of a time event. */
    protected abstract unsetTimer(timer: TimerInfo): string;
    /** Names of the runtime functions, in the order of the source file (before the functions of states etc.). */
    protected abstract get runtimeFunctions(): readonly string[];

    // ExpressionContext (dialect part)
    abstract eventValue(event: ast.EventDeclaration): string;
    abstract operationCall(operation: ast.OperationDeclaration, args: Code[][]): string;
    abstract operationResult(type: DevmType, call: string): string;
    abstract raise(event: ast.EventDeclaration, block: CBlock): void;
    abstract withHandle(args: string): string;
    abstract typeName(type: DevmType): string;
    abstract toReal(text: string): string;
    abstract store(target: string, type: DevmType, value: string): string;
    abstract compareStrings(left: Code, right: Code, operator: '==' | '!='): string;
    abstract concatStrings(left: Code, right: Code): string;
    abstract variable(variable: ast.VariableDeclaration): string;

    // -----------------------------------------------------------------------------------------
    // Names

    private collectNames(naming: NamingOptions): void {
        const states = new UniqueNames(naming.reservedStateNames);
        for (const state of this.index.states) {
            this.stateNames.set(state, states.get(qualifiedName(state).replace(/\./g, '_')));
        }
        const regionNames = new UniqueNames([]);
        const pseudoNames = new UniqueNames([]);
        const addRegion = (region: RegionNode) => {
            this.regions.push(region);
            let name: string;
            if (ast.isStateMachine(region)) {
                name = 'main';
            } else if (ast.isState(region)) {
                name = this.stateNames.get(region)!;
            } else {
                const owner = region.$container;
                name = `${this.stateNames.get(owner)}_${region.name ?? `region${owner.regions.indexOf(region) + 1}`}`;
            }
            this.regionNames.set(region, regionNames.get(name));
        };
        addRegion(this.machine);
        for (const state of this.index.states) {
            this.index.regionsOf(state).forEach(addRegion);
        }
        for (const node of AstUtils.streamAllContents(this.machine)) {
            if (ast.isPseudoState(node)) {
                this.pseudoNames.set(node, pseudoNames.get(qualifiedName(node).replace(/\./g, '_')));
                if (node.kind === 'history' || node.kind === 'deephistory') {
                    const region = this.index.regionOf(node);
                    this.historyRegions.add(region);
                    if (node.kind === 'deephistory') {
                        this.addDeepHistoryRegions(region);
                    }
                }
            } else if (ast.isTransition(node)) {
                if (node.final) {
                    this.finalRegions.add(this.index.regionOf(this.index.targetOf(node)));
                }
            }
        }
        const transitions = AstUtils.streamAllContents(this.machine).filter(ast.isTransition).toArray()
            .sort((a, b) => (a.$cstNode?.offset ?? 0) - (b.$cstNode?.offset ?? 0));
        transitions.forEach((transition, i) => this.transitionNumbers.set(transition, i + 1));

        const events = new UniqueNames(naming.keywords);
        for (const scope of this.machine.scopes) {
            let key: string;
            let info: ScopeInfo;
            if (ast.isInternalScope(scope)) {
                key = '#internal';
                info = { kind: 'internal', names: new UniqueNames(naming.keywords) };
            } else if (scope.name) {
                key = scope.name;
                info = { kind: 'named', name: scope.name, names: new UniqueNames(naming.keywords) };
            } else {
                key = '#iface';
                info = { kind: 'default', names: new UniqueNames(naming.keywords) };
            }
            info = this.scopes.get(key) ?? info;
            this.scopes.set(key, info);
            for (const declaration of scope.declarations) {
                this.declarationScopes.set(declaration, info);
                if (ast.isEventDeclaration(declaration)) {
                    this.eventNames.set(declaration, events.get(ast.isInterfaceScope(scope) && scope.name ? `${scope.name}_${declaration.name}` : declaration.name));
                } else if (ast.isVariableDeclaration(declaration)) {
                    this.variableMembers.set(declaration, info.names.get(declaration.name));
                    const type = typeOfVariable(declaration);
                    this.variableTypes.set(declaration, type === 'error' || type === 'void' ? 'integer' : type);
                }
            }
        }
        const addTimers = (owner: ast.State | ast.StateMachine) => {
            this.index.timeTriggers(owner).forEach((trigger, i) => {
                const ownerName = ast.isStateMachine(owner) ? 'statechart' : this.stateNames.get(owner)!;
                const info: TimerInfo = { trigger, owner, ownerName, index: i };
                this.timers.push(info);
                this.timerByTrigger.set(trigger, info);
            });
        };
        addTimers(this.machine);
        this.index.states.forEach(addTimers);
    }

    private addDeepHistoryRegions(region: RegionNode): void {
        for (const vertex of region.vertices) {
            if (ast.isState(vertex)) {
                for (const sub of this.index.regionsOf(vertex)) {
                    this.historyRegions.add(sub);
                    this.addDeepHistoryRegions(sub);
                }
            }
        }
    }

    /** Index of a region in the `active` and `history` arrays. */
    protected regionId(region: RegionNode): string {
        return `REGION_${this.regionNames.get(region)}`;
    }

    protected scopeOf(declaration: ast.Declaration): ScopeInfo {
        return this.declarationScopes.get(declaration)!;
    }

    /** The active vertex of a region. */
    protected activeOf(region: RegionNode): string {
        return `${this.field('active')}[${this.regionId(region)}]`;
    }

    protected historyOf(region: RegionNode): string {
        return `${this.field('history')}[${this.regionId(region)}]`;
    }

    protected enteredFlag(state: ast.State): string {
        return `${this.field('entered')}[${this.stateSlot(state)}]`;
    }

    protected exitedFlag(state: ast.State): string {
        return `${this.field('exited')}[${this.stateSlot(state)}]`;
    }

    protected comment(text: string): string {
        return `/* ${text} */`;
    }

    // -----------------------------------------------------------------------------------------
    // ExpressionContext (common part)

    variableType(variable: ast.VariableDeclaration): DevmType {
        return this.variableTypes.get(variable) ?? 'integer';
    }

    eventPresent(event: ast.EventDeclaration): string {
        return this.index.eventDirection(event) === 'out' ? 'false' : `${this.field('present')}[${this.eventConstant(event)}]`;
    }

    stateActive(vertex: ast.Vertex): string {
        if (!ast.isState(vertex)) {
            return 'false';
        }
        return `(${this.activeOf(this.index.regionOf(vertex))} == ${this.stateConstant(vertex)})`;
    }

    helper(name: Helper): string {
        this.helpers.add(name);
        if (name === 'int_div') {
            this.helpers.add('int_neg');
        }
        return name;
    }

    unsupported(message: string, node: AstNode): never {
        throw new GeneratorError(message, node);
    }

    /** No conversions to C++ storage types (only the C++ generator supports C++ types). */
    storageCast(_storage: CppResolvedType | undefined, value: Code): string {
        return value.text;
    }

    checkedIndex(_index: string, _length: number, node: AstNode): string {
        return this.unsupported('Arrays of C++ types are not supported by this generator', node);
    }

    // -----------------------------------------------------------------------------------------
    // Functions (generated on demand, so that there are no unused functions)

    protected use(name: string, params: string[], comment: string, build: (body: CBlock) => void, returnType: DevmType = 'void'): string {
        if (!this.functions.has(name)) {
            const fn: GeneratedFunction = { name, returnType, params, comment, body: new CBlock(), order: this.sortKey(name) };
            this.functions.set(name, fn);
            this.pending.push(() => {
                this.expressions.resetTemporaries();
                build(fn.body);
            });
        }
        return name;
    }

    /** Order of the functions in the source file: runtime, states, regions, pseudo states, transitions. */
    private sortKey(name: string): number {
        const runtime = this.runtimeFunctions.indexOf(name);
        if (runtime >= 0) {
            return runtime;
        }
        const position = (names: Iterable<string>, key: string) => [...names].indexOf(key);
        let match = /^(enter|enseq|exit|react)_(.*)$/.exec(name);
        if (match) {
            return 1e6 + position(this.stateNames.values(), match[2]) * 10 + ['enter', 'enseq', 'exit', 'react'].indexOf(match[1]);
        }
        match = /^(renter|rexit|rfinal|rrestore)_(.*)$/.exec(name);
        if (match) {
            return 2e6 + position(this.regionNames.values(), match[2]) * 10 + ['renter', 'rexit', 'rfinal', 'rrestore'].indexOf(match[1]);
        }
        match = /^(choice|history|entrypoint|exitnode|fork|joincheck|joinfire)_(.*)$/.exec(name);
        if (match) {
            return 3e6 + position(this.pseudoNames.values(), match[2]) * 10 + ['joincheck', 'joinfire'].indexOf(match[1]) + 1;
        }
        match = /^transition_(\d+)$/.exec(name);
        return 4e6 + (match ? Number(match[1]) : this.functionOrder++);
    }

    /** Builds all functions that have been used so far (and the functions they use). */
    protected flush(): void {
        while (this.pending.length > 0) {
            this.pending.shift()!();
        }
    }

    /** The generated functions in source order. */
    protected sortedFunctions(): GeneratedFunction[] {
        return [...this.functions.values()].sort((a, b) => a.order - b.order);
    }

    protected transitionText(transition: ast.Transition): string {
        const source = transition.initial ? '[*]' : this.index.vertexName(transition.source?.ref);
        const target = this.index.vertexName(this.index.targetOf(transition));
        const label = transitionLabel(transition);
        return commentText(`${source} -> ${target}${label ? ` : ${label}` : ''}`);
    }

    protected stateName(state: ast.State): string {
        return this.index.stateName(state);
    }

    /** `enter_S`: marks the state active, executes its entry reactions and starts its timers. */
    protected enterState(state: ast.State): string {
        return this.use(`enter_${this.stateNames.get(state)}`, [], `Enters state ${this.stateName(state)}: entry reactions and timers (not its regions).`, body => {
            body.add(`${this.activeOf(this.index.regionOf(state))} = ${this.stateConstant(state)};`);
            body.add(`${this.enteredFlag(state)} = true;`);
            this.builtinReactions(state, 'entry', body);
            for (const trigger of this.index.timeTriggers(state)) {
                this.startTimer(trigger, body);
            }
        });
    }

    /** `enseq_S`: enters a state and its regions by default. */
    protected enterStateDefault(state: ast.State): string {
        return this.use(`enseq_${this.stateNames.get(state)}`, [], `Enters state ${this.stateName(state)} and its regions by default.`, body => {
            body.add(`${this.call(this.enterState(state))};`);
            for (const region of this.index.regionsOf(state)) {
                body.add(`${this.call(this.regionEnter(region))};`);
            }
        });
    }

    /** `exit_S`: exits the sub states (recording history), executes the exit reactions, stops the timers. */
    protected exitState(state: ast.State): string {
        return this.use(`exit_${this.stateNames.get(state)}`, [], `Exits state ${this.stateName(state)}: sub states first (innermost first), exit reactions, timers.`, body => {
            for (const region of this.index.regionsOf(state)) {
                if (!this.regionCanBeActive(region)) {
                    continue;
                }
                if (this.historyRegions.has(region)) {
                    body.block('', [
                        `${this.stateType} last = ${this.activeOf(region)};`,
                        `${this.call(this.regionExit(region))};`,
                        `if (last != ${this.noState}) {`,
                        `    ${this.historyOf(region)} = last;`,
                        '}'
                    ]);
                } else {
                    body.add(`${this.call(this.regionExit(region))};`);
                }
            }
            this.builtinReactions(state, 'exit', body);
            for (const trigger of this.index.timeTriggers(state)) {
                this.stopTimer(trigger, body);
            }
            body.add(`${this.activeOf(this.index.regionOf(state))} = ${this.noState};`);
            body.add(`${this.exitedFlag(state)} = true;`);
        });
    }

    protected regionStates(region: RegionNode): ast.State[] {
        return region.vertices.filter(ast.isState);
    }

    protected regionCanBeActive(region: RegionNode): boolean {
        return this.regionStates(region).length > 0 || this.finalRegions.has(region);
    }

    protected regionLabel(region: RegionNode): string {
        if (ast.isStateMachine(region)) {
            return `the top-level region of ${region.name}`;
        }
        if (ast.isState(region)) {
            return `the region of ${this.stateName(region)}`;
        }
        return `region ${region.name ?? `#${region.$container.regions.indexOf(region) + 1}`} of ${this.stateName(region.$container)}`;
    }

    /** `rexit_R`: exits the active vertex of a region (without recording its history). */
    protected regionExit(region: RegionNode): string {
        return this.use(`rexit_${this.regionNames.get(region)}`, [], `Exits the active state of ${this.regionLabel(region)}.`, body => {
            const cases = new CBlock();
            for (const state of this.regionStates(region)) {
                cases.add(`case ${this.stateConstant(state)}:`, `    ${this.call(this.exitState(state))};`, '    break;');
            }
            if (this.finalRegions.has(region)) {
                cases.add(`case ${this.finalState}:`, `    ${this.activeOf(region)} = ${this.noState};`, '    break;');
            }
            cases.add('default:', '    break;');
            body.block(`switch (${this.activeOf(region)})`, cases);
        });
    }

    /** `renter_R`: enters a region by its initial transition (docs/semantics.md §8.3). */
    protected regionEnter(region: RegionNode): string {
        return this.use(`renter_${this.regionNames.get(region)}`, [], `Enters ${this.regionLabel(region)} by default.`, body => {
            const initial = region.transitions.find(t => t.initial);
            if (!initial) {
                if (region.vertices.some(ast.isState)) {
                    const name = ast.isStateMachine(region) ? `state machine '${region.name}'` : ast.isState(region)
                        ? `state '${this.stateName(region)}'`
                        : region.name ? `region '${region.name}' of '${this.stateName(region.$container)}'`
                            : `region #${region.$container.regions.indexOf(region) + 1} of '${this.stateName(region.$container)}'`;
                    body.add(this.errorCall('no_initial_transition', `${capitalize(name)} is entered by default but has no initial transition ('[*] -> ...')`, region));
                }
                return;
            }
            const target = this.index.targetOf(initial);
            body.add(this.comment(this.transitionText(initial)));
            body.add(`if (!${this.call(this.microstep())}) {`, '    return;', '}');
            this.expressions.effect(initial.spec?.effect, body);
            const inside = this.index.childIn(region, target) !== undefined;
            const scope = inside ? region : this.index.commonRegion([region, this.index.regionOf(target)]);
            this.enterInRegion(scope, [{ vertex: target, entryPoint: entryPointOf(initial) }], body, !inside);
        });
    }

    /** `rfinal_R`: enters the final state of a region. */
    protected regionFinal(region: RegionNode): string {
        return this.use(`rfinal_${this.regionNames.get(region)}`, [], `Enters the final state of ${this.regionLabel(region)}.`, body => {
            body.add(`${this.call(this.regionExit(region))};`);
            body.add(`${this.activeOf(region)} = ${this.finalState};`);
        });
    }

    /** `rrestore_R`: restores the recorded configuration of a region below a deep history. */
    protected regionRestore(region: RegionNode): string {
        return this.use(`rrestore_${this.regionNames.get(region)}`, [], `Restores the recorded configuration of ${this.regionLabel(region)} (deep history).`, body => {
            body.block(`switch (${this.historyOf(region)})`, this.historyCases(region, true, [`${this.call(this.regionEnter(region))};`]));
        });
    }

    private historyCases(region: RegionNode, deep: boolean, otherwise: string[]): CBlock {
        const cases = new CBlock();
        for (const state of this.regionStates(region)) {
            cases.add(`case ${this.stateConstant(state)}:`);
            if (deep) {
                cases.add(`    ${this.call(this.enterState(state))};`);
                for (const sub of this.index.regionsOf(state)) {
                    cases.add(`    ${this.call(this.regionRestore(sub))};`);
                }
            } else {
                cases.add(`    ${this.call(this.enterStateDefault(state))};`);
            }
            cases.add('    break;');
        }
        if (this.finalRegions.has(region)) {
            cases.add(`case ${this.finalState}:`, `    ${this.call(this.regionFinal(region))};`, '    break;');
        }
        cases.add('default:', ...indent(otherwise), '    break;');
        return cases;
    }

    /**
     * Enters the target vertices, which are all contained in `region` (docs/semantics.md §8): the
     * ancestors below the region are entered outermost first, their other regions by default.
     * `maybeActive`: the ancestor might already be active (only for initial transitions whose target is
     * outside of their region).
     */
    protected enterInRegion(region: RegionNode, targets: EnterTarget[], block: CBlock, maybeActive: boolean): void {
        const children = targets.map(t => this.index.childIn(region, t.vertex));
        const child = children[0];
        if (!child || children.some(c => c !== child)) {
            throw new GeneratorError(`Cannot enter ${targets.map(t => this.index.vertexName(t.vertex)).join(', ')} together`, targets[0].vertex as AstNode);
        }
        if (targets.length === 1 && targets[0].vertex === child) {
            this.enterTarget(targets[0], block);
            return;
        }
        if (!ast.isState(child) || targets.some(t => t.vertex === child)) {
            throw new GeneratorError(`Cannot enter ${this.index.vertexName(child)} and its sub vertices together`, child as AstNode);
        }
        const inner = new CBlock();
        const defaults = new CBlock();
        for (const sub of this.index.regionsOf(child)) {
            const inside = targets.filter(t => this.index.childIn(sub, t.vertex) !== undefined);
            if (inside.length > 0) {
                this.enterInRegion(sub, inside, inner, maybeActive);
            } else {
                (maybeActive ? defaults : inner).add(`${this.call(this.regionEnter(sub))};`);
            }
        }
        if (maybeActive) {
            const flag = `was_active_${this.stateNames.get(child)}`;
            block.add(`${this.typeName('boolean')} ${flag} = (${this.activeOf(region)} == ${this.stateConstant(child)});`);
            defaults.lines.unshift(`${this.call(this.enterState(child))};`);
            block.block(`if (!${flag})`, defaults);
            block.append(inner);
        } else {
            block.add(`${this.call(this.enterState(child))};`);
            block.append(inner);
        }
    }

    /** Enters the target of a transition itself (its ancestors are active). */
    private enterTarget(target: EnterTarget, block: CBlock): void {
        const vertex = target.vertex;
        if (isFinalState(vertex)) {
            block.add(`${this.call(this.regionFinal(vertex.region))};`);
        } else if (ast.isState(vertex)) {
            if (!target.entryPoint) {
                block.add(`${this.call(this.enterStateDefault(vertex))};`);
                return;
            }
            if (!this.index.findPseudo(vertex, 'entry', target.entryPoint)) {
                throw new GeneratorError(`State '${vertex.name}' has no entry point '${target.entryPoint}'`, vertex);
            }
            block.add(`${this.call(this.enterState(vertex))};`);
            // every region with an entry point of this name is entered through it, the others by default
            for (const region of this.index.regionsOf(vertex)) {
                const entry = this.index.entryPointIn(region, target.entryPoint);
                if (entry) {
                    block.add(`${this.call(this.entryPoint(entry))};`);
                } else {
                    block.add(`${this.call(this.regionEnter(region))};`);
                }
            }
        } else {
            block.add(`${this.call(this.pseudoState(vertex))};`);
        }
    }

    private pseudoState(pseudo: ast.PseudoState): string {
        switch (pseudo.kind) {
            case 'choice':
            case 'junction':
                return this.choice(pseudo);
            case 'history':
            case 'deephistory':
                return this.history(pseudo);
            case 'entry':
                return this.entryPoint(pseudo);
            case 'exit':
                return this.exitNode(pseudo);
            case 'sync':
                return this.fork(pseudo);
        }
    }

    /** Choice / junction: guarded branches first (priority order), then the default branches. */
    private choice(choice: ast.PseudoState): string {
        return this.use(`choice_${this.pseudoNames.get(choice)}`, [], `${capitalize(choice.kind)} ${qualifiedName(choice)}: takes the first enabled branch.`, body => {
            const outgoing = this.index.outgoing(choice);
            const isDefault = (t: ast.Transition) => !t.spec?.guard
                || t.spec.triggers.some(trigger => ast.isBuiltinTrigger(trigger) && (trigger.kind === 'else' || trigger.kind === 'default'));
            const ordered = [...outgoing.filter(t => !isDefault(t)), ...outgoing.filter(isDefault)];
            let unconditional = false;
            for (const transition of ordered) {
                unconditional = this.guarded(transition.spec?.guard, [`${this.call(this.transition(transition))};`, 'return;'], body, this.transitionText(transition));
                if (unconditional) {
                    break;
                }
            }
            if (!unconditional) {
                body.add(this.errorCall('no_enabled_transition', `${capitalize(choice.kind)} '${choice.name}' has no enabled outgoing transition`, choice));
            }
        });
    }

    /**
     * Emits `if (guard) { then }` (with the statements evaluating the guard before). Returns true if the
     * guard is missing, i.e. `then` is executed unconditionally.
     */
    protected guarded(guard: ast.Expression | undefined, then: string[], block: CBlock, comment?: string): boolean {
        if (comment) {
            block.add(this.comment(comment));
        }
        if (!guard) {
            block.add(...then);
            return true;
        }
        const inner = new CBlock();
        const condition = this.expressions.condition(guard, inner);
        if (inner.isEmpty) {
            block.block(`if (${condition})`, then);
        } else {
            inner.block(`if (${condition})`, then);
            block.block('', inner);
        }
        return false;
    }

    private entryPoint(entry: ast.PseudoState): string {
        return this.use(`entrypoint_${this.pseudoNames.get(entry)}`, [], `Entry point ${qualifiedName(entry)}.`, body => {
            let unconditional = false;
            for (const transition of this.index.outgoing(entry)) {
                unconditional = this.guarded(transition.spec?.guard, [`${this.call(this.transition(transition))};`, 'return;'], body, this.transitionText(transition));
                if (unconditional) {
                    break;
                }
            }
            if (!unconditional) {
                body.add(this.errorCall('no_enabled_transition', `Entry point '${entry.name}' has no enabled outgoing transition`, entry));
            }
        });
    }

    /** Exit node `X`: the owning composite state is left by its `# X>` transition. */
    private exitNode(exitNode: ast.PseudoState): string {
        return this.use(`exitnode_${this.pseudoNames.get(exitNode)}`, [], `Exit node ${qualifiedName(exitNode)}: leaves the state by its '# ${exitNode.name}>' transition.`, body => {
            const owner = this.index.ownerState(this.index.regionOf(exitNode));
            let unconditional = false;
            for (const transition of owner ? this.index.exitTransitions(owner, exitNode.name) : []) {
                unconditional = this.guarded(transition.spec?.guard, [`${this.call(this.transition(transition, owner))};`, 'return;'], body, this.transitionText(transition));
                if (unconditional) {
                    break;
                }
            }
            if (!unconditional) {
                body.add(this.errorCall('no_enabled_transition',
                    `Exit node '${exitNode.name}' was reached but ${owner ? `state '${owner.name}'` : 'its state'} has no enabled transition '# ${exitNode.name}>'`, exitNode));
            }
        });
    }

    /** History: restores the recorded state (deep: recursively), else takes the default transition. */
    private history(pseudo: ast.PseudoState): string {
        return this.use(`history_${this.pseudoNames.get(pseudo)}`, [], `${pseudo.kind === 'deephistory' ? 'Deep' : 'Shallow'} history ${qualifiedName(pseudo)}.`, body => {
            const region = this.index.regionOf(pseudo);
            const transition = this.index.outgoing(pseudo)[0];
            const otherwise = transition
                ? [this.comment(`no history: ${this.transitionText(transition)}`), `${this.call(this.transition(transition))};`]
                : [this.comment('no history: enter by default'), `${this.call(this.regionEnter(region))};`];
            body.block(`switch (${this.historyOf(region)})`, this.historyCases(region, pseudo.kind === 'deephistory', otherwise));
        });
    }

    /** Fork: executes the effects of all outgoing transitions, then enters all targets together. */
    private fork(sync: ast.PseudoState): string {
        return this.use(`fork_${this.pseudoNames.get(sync)}`, [], `Synchronization ${qualifiedName(sync)} (fork).`, body => {
            const outgoing = this.index.outgoing(sync);
            if (outgoing.length === 0) {
                throw new GeneratorError(`Synchronization '${sync.name}' has no outgoing transition`, sync);
            }
            if (outgoing.length === 1) {
                body.add(`${this.call(this.transition(outgoing[0]))};`);
                return;
            }
            body.add(`if (!${this.call(this.microstep())}) {`, '    return;', '}');
            const targets = outgoing.map(t => ({ vertex: this.index.targetOf(t), entryPoint: entryPointOf(t) }));
            const scope = this.index.scopeRegion([sync, ...targets.map(t => t.vertex)]);
            this.exitScope(scope, body);
            for (const transition of outgoing) {
                body.add(this.comment(this.transitionText(transition)));
                this.expressions.effect(transition.spec?.effect, body);
            }
            this.enterInRegion(scope, targets, body, false);
        });
    }

    protected exitScope(scope: RegionNode, body: CBlock): void {
        if (this.regionCanBeActive(scope)) {
            body.add(`${this.call(this.regionExit(scope))};`);
        }
    }

    /** Join: whether all incoming transitions are enabled in this step. */
    private joinCheck(join: ast.PseudoState): string {
        return this.use(`joincheck_${this.pseudoNames.get(join)}`, [], `Whether all incoming transitions of synchronization ${qualifiedName(join)} are enabled.`, body => {
            for (const transition of this.index.incoming(join)) {
                body.add(this.comment(this.transitionText(transition)));
                const source = transition.source?.ref;
                if (!source || !ast.isState(source)) {
                    body.add('return false;');
                    return;
                }
                body.block(`if (!${this.stateActive(source)} || ${this.enteredFlag(source)})`, ['return false;']);
                const trigger = this.transitionTrigger(transition);
                if (trigger === 'false') {
                    body.add('return false;');
                    return;
                }
                if (trigger !== 'true') {
                    body.block(`if (!(${trigger}))`, ['return false;']);
                }
                if (transition.spec?.guard) {
                    const condition = this.expressions.condition(transition.spec.guard, body);
                    body.block(`if (!(${condition}))`, ['return false;']);
                }
            }
            body.add('return true;');
        }, 'boolean');
    }

    /** Join: exits all sources, executes the incoming effects in priority order and enters the sync. */
    private joinFire(join: ast.PseudoState): string {
        return this.use(`joinfire_${this.pseudoNames.get(join)}`, [], `Takes the incoming transitions of synchronization ${qualifiedName(join)} (join).`, body => {
            const incoming = this.index.incoming(join);
            body.add(`if (!${this.call(this.microstep())}) {`, '    return;', '}');
            const scope = this.index.scopeRegion([join, ...incoming.map(t => t.source!.ref!)]);
            this.exitScope(scope, body);
            for (const transition of incoming) {
                body.add(this.comment(this.transitionText(transition)));
                this.expressions.effect(transition.spec?.effect, body);
            }
            this.enterInRegion(scope, [{ vertex: join }], body, false);
        });
    }

    /** `transition_N`: takes a transition (docs/semantics.md §5): exit, effect, enter. */
    private transition(transition: ast.Transition, sourceOverride?: ast.Vertex): string {
        const number = this.transitionNumbers.get(transition)!;
        return this.use(`transition_${number}`, [], `Takes the transition ${this.transitionText(transition)}.`, body => {
            const source = sourceOverride ?? transition.source?.ref;
            if (!source) {
                throw new GeneratorError('Transition without source', transition);
            }
            const target = this.index.targetOf(transition);
            const scope = this.index.scopeRegion([source, target]);
            body.add(`if (!${this.call(this.microstep())}) {`, '    return;', '}');
            this.exitScope(scope, body);
            this.expressions.effect(transition.spec?.effect, body);
            this.enterInRegion(scope, [{ vertex: target, entryPoint: entryPointOf(transition) }], body, false);
        });
    }

    /** `microstep`: counts a transition of the step. */
    protected microstep(): string {
        return this.use('microstep', [], 'Counts a transition; false (and an error) if there are too many in one step.', body => {
            body.block(`if (++${this.field('microsteps')} > ${this.maxMicrostepsConstant})`, [
                this.errorCall('loop', `More than ${this.maxMicrosteps} transitions in one step; the state machine seems to loop`),
                'return false;'
            ]);
            body.add('return true;');
        }, 'boolean');
    }

    // -----------------------------------------------------------------------------------------
    // Reactions

    /** Condition for the triggers of a reaction: `true` (no trigger / always), `false` (never in a step) or flags. */
    private triggerCondition(triggers: readonly ast.Trigger[]): string {
        if (triggers.length === 0) {
            return 'true';
        }
        const conditions: string[] = [];
        for (const trigger of triggers) {
            if (ast.isEventTrigger(trigger)) {
                const event = trigger.event.ref;
                if (!event) {
                    throw new GeneratorError(`Unresolved event '${trigger.event.$refText}'`, trigger);
                }
                const condition = this.eventPresent(event);
                if (condition !== 'false') {
                    conditions.push(condition);
                }
            } else if (ast.isTimeTrigger(trigger)) {
                const timer = this.timerByTrigger.get(trigger);
                if (timer) {
                    conditions.push(`${this.field('timer_present')}[${this.timerConstant(timer)}]`);
                }
            } else if (trigger.kind === 'always' || trigger.kind === 'oncycle') {
                return 'true';
            }
        }
        return conditions.length === 0 ? 'false' : conditions.join(' || ');
    }

    /** Trigger condition of a transition leaving a state; `false` if it is never taken in a step. */
    private transitionTrigger(transition: ast.Transition): string {
        const spec = transition.spec;
        if (!spec || (spec.triggers.length === 0 && !spec.guard)) {
            return 'false';
        }
        return this.triggerCondition(spec.triggers);
    }

    /** Emits `if (trigger && guard) { then }`. */
    private reaction(trigger: string, guard: ast.Expression | undefined, then: string[], block: CBlock, comment: string): void {
        block.add(this.comment(comment));
        if (trigger === 'true') {
            this.guarded(guard, then, block);
            return;
        }
        const inner = new CBlock();
        const condition = guard ? this.expressions.condition(guard, inner) : 'true';
        if (inner.isEmpty) {
            const triggerText = trigger.includes(' || ') ? `(${trigger})` : trigger;
            block.block(`if (${condition === 'true' ? trigger : `${triggerText} && ${wrap(condition)}`})`, then);
        } else {
            inner.block(`if (${condition})`, then);
            block.block(`if (${trigger})`, inner);
        }
    }

    /** Executes the `entry` or `exit` reactions of a state (or the state machine) whose guard holds. */
    protected builtinReactions(owner: ast.State | ast.StateMachine, kind: 'entry' | 'exit', block: CBlock): void {
        for (const reaction of owner.reactions) {
            if (reaction.triggers.some(t => ast.isBuiltinTrigger(t) && t.kind === kind)) {
                const effect = new CBlock();
                this.expressions.effect(reaction.effect, effect);
                this.guarded(reaction.guard, effect.lines, block, commentText(nodeText(reaction)));
            }
        }
    }

    /** The local reactions of a state (or the state machine) in a step. */
    protected localReactions(owner: ast.State | ast.StateMachine, block: CBlock): void {
        for (const reaction of owner.reactions) {
            if (reaction.triggers.length === 0 && !reaction.guard) {
                continue;
            }
            const trigger = this.triggerCondition(reaction.triggers);
            if (trigger === 'false') {
                continue;
            }
            const effect = new CBlock();
            this.expressions.effect(reaction.effect, effect);
            this.reaction(trigger, reaction.guard, effect.lines, block, commentText(nodeText(reaction)));
        }
    }

    /** The outgoing transitions of a state in priority order; the first enabled one is taken. */
    private transitions(state: ast.State, block: CBlock): void {
        for (const transition of this.index.outgoing(state)) {
            const target = transition.target?.ref;
            if (target && ast.isPseudoState(target) && target.kind === 'sync' && this.index.incoming(target).length > 1) {
                block.add(this.comment(`${this.transitionText(transition)} (join)`));
                block.block(`if (${this.call(this.joinCheck(target))})`, [`${this.call(this.joinFire(target))};`, 'return true;']);
                continue;
            }
            const trigger = this.transitionTrigger(transition);
            if (trigger === 'false') {
                block.add(this.comment(`${this.transitionText(transition)}: never taken in a step`));
                continue;
            }
            this.reaction(trigger, transition.spec?.guard, [`${this.call(this.transition(transition))};`, 'return true;'], block, this.transitionText(transition));
        }
    }

    /** Processing of the sub regions of an active state (docs/semantics.md §4). */
    private reactRegions(state: ast.State, block: CBlock): void {
        for (const region of this.index.regionsOf(state)) {
            const states = this.regionStates(region);
            if (states.length === 0) {
                continue;
            }
            const cases = new CBlock();
            for (const sub of states) {
                cases.add(`case ${this.stateConstant(sub)}:`);
                cases.add(`    if (!${this.enteredFlag(sub)} && ${this.call(this.react(sub))}) {`, '        taken = true;', '    }', '    break;');
            }
            cases.add('default:', '    break;');
            block.block(`switch (${this.activeOf(region)})`, cases);
            block.block(`if (${this.exitedFlag(state)})`, ['return true;']);
        }
    }

    /** `react_S`: processes the active state `S` in a step; returns whether a transition left it. */
    protected react(state: ast.State): string {
        return this.use(`react_${this.stateNames.get(state)}`, [], `Processes state ${this.stateName(state)} in a step (${this.order}); returns whether a transition was taken.`, body => {
            const hasRegions = this.index.regionsOf(state).some(r => this.regionStates(r).length > 0);
            const taken = `${this.typeName('boolean')} taken = false;`;
            if (this.order === 'parent-first') {
                this.transitions(state, body);
                this.localReactions(state, body);
                if (hasRegions) {
                    body.add(taken);
                    this.reactRegions(state, body);
                    body.add('return taken;');
                } else {
                    body.add('return false;');
                }
            } else {
                if (hasRegions) {
                    body.add(taken);
                    this.reactRegions(state, body);
                    body.block('if (taken)', ['return true;']);
                }
                this.transitions(state, body);
                this.localReactions(state, body);
                body.add('return false;');
            }
        }, 'boolean');
    }

    /** Statements processing the active state of the top-level region in a step. */
    protected reactTopLevel(body: CBlock): void {
        const states = this.regionStates(this.machine);
        if (states.length > 0) {
            const cases = new CBlock();
            for (const state of states) {
                cases.add(`case ${this.stateConstant(state)}:`, `    (void)${this.call(this.react(state))};`, '    break;');
            }
            cases.add('default:', '    break;');
            body.block(`switch (${this.activeOf(this.machine)})`, cases);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Timers

    protected startTimer(trigger: ast.TimeTrigger, block: CBlock): void {
        const timer = this.timerByTrigger.get(trigger)!;
        const factor = NS_PER_UNIT[trigger.unit];
        if (factor === undefined) {
            throw new GeneratorError(`Unknown time unit '${trigger.unit}' (use s, ms, us or ns)`, trigger);
        }
        const periodic = trigger.kind === 'every';
        const invalid = this.errorCall('invalid_time', `The period of 'every' must be positive`, trigger);
        block.add(this.comment(commentText(nodeText(trigger))));
        if (ast.isIntLiteral(trigger.value) || ast.isHexLiteral(trigger.value)) {
            const value = BigInt(trigger.value.$cstNode?.text ?? trigger.value.value) * factor;
            if (periodic && value <= 0n) {
                block.add(invalid);
            } else {
                block.add(this.setTimer(timer, cInteger(value < 0n ? 0n : BigInt.asIntN(64, value)), periodic));
            }
            return;
        }
        const inner = new CBlock();
        const amount = this.expressions.compile(trigger.value, inner);
        let duration: string;
        if (amount.type === 'integer') {
            duration = `${this.helper('int_mul')}(${stripParens(amount.text)}, ${cInteger(factor)})`;
        } else if (amount.type === 'real') {
            duration = `${this.helper('real_round')}(${amount.text} * ${factor}.0)`;
        } else {
            throw new GeneratorError('The duration of a time event must be a number', trigger);
        }
        inner.add(`${this.typeName('integer')} duration = ${duration};`);
        if (periodic) {
            inner.add('if (duration <= 0) {', `    ${invalid}`, '} else {', `    ${this.setTimer(timer, 'duration', true)}`, '}');
        } else {
            inner.block('if (duration < 0)', ['duration = 0;']);
            inner.add(this.setTimer(timer, 'duration', false));
        }
        block.block('', inner);
    }

    protected stopTimer(trigger: ast.TimeTrigger, block: CBlock): void {
        const timer = this.timerByTrigger.get(trigger)!;
        block.add(this.unsetTimer(timer));
        block.add(`${this.field('timer_present')}[${this.timerConstant(timer)}] = false;`);
        block.add(`${this.field('timer_pending')}[${this.timerConstant(timer)}] = false;`);
    }

    // -----------------------------------------------------------------------------------------
    // Model queries

    protected get events(): ast.EventDeclaration[] {
        return this.index.events();
    }

    protected get inEvents(): ast.EventDeclaration[] {
        return this.events.filter(e => this.index.eventDirection(e) === 'in');
    }

    protected get outEvents(): ast.EventDeclaration[] {
        return this.events.filter(e => this.index.eventDirection(e) === 'out');
    }

    protected get operations(): ast.OperationDeclaration[] {
        return this.machine.scopes.flatMap(s => s.declarations).filter(ast.isOperationDeclaration);
    }

    protected get hasEvents(): boolean {
        return this.events.length > 0;
    }

    protected get eventDriven(): boolean {
        return this.mode === 'event';
    }
}

export function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function wrap(condition: string): string {
    return /^[\w\->[\]().:]+$/.test(condition) && !condition.includes(' ') ? condition : `(${condition})`;
}

const ALIGN_MARK = '\u0000';

/** Marker for comments aligned in a column (see {@link alignComments}). */
export function spaces(): string {
    return ALIGN_MARK;
}

/** Aligns the trailing comments of consecutive lines containing the alignment mark. */
export function alignComments(lines: string[]): string[] {
    const result = [...lines];
    let start = 0;
    while (start < result.length) {
        if (!result[start].includes(ALIGN_MARK)) {
            start++;
            continue;
        }
        let end = start;
        while (end < result.length && result[end].includes(ALIGN_MARK)) {
            end++;
        }
        const width = Math.max(...result.slice(start, end).map(l => l.indexOf(ALIGN_MARK))) + 1;
        for (let i = start; i < end; i++) {
            const [code, comment] = result[i].split(ALIGN_MARK);
            result[i] = code.padEnd(width) + comment;
        }
        start = end;
    }
    return result;
}
