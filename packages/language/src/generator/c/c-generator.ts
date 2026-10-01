import { AstUtils, type AstNode } from 'langium';
import * as ast from '../../generated/ast.js';
import { typeOfEvent, typeOfParameter, returnTypeOf, type HsmType } from '../../hsm-typesystem.js';
import { nodeText } from '../../model-utils.js';
import { SimulationError } from '../../simulation/errors.js';
import type { ExecutionMode, ExecutionOrder } from '../../simulation/interpreter.js';
import type { ModelIndex } from '../../simulation/model-index.js';
import { countConcatenations, type Code, type Helper } from '../common/expressions.js';
import {
    alignComments, CLASS_SECTIONS_NOT_SUPPORTED, CPP_TYPES_NOT_SUPPORTED, cppTypeUsage, GeneratorError, spaces, StatechartGenerator, type ErrorKind, type GeneratedFunction, type ScopeInfo,
    type TimerInfo
} from '../common/statechart-generator.js';
import { C_KEYWORDS, CBlock, commentText, cString, indent, snakeCase, stripParens } from './c-code.js';
import { cDefault, cType } from './c-expressions.js';

/** Options of the C code generator. */
export interface CGeneratorOptions {
    /** Prefix of all functions and file names (default: the state machine name in snake case, `cd_player`). */
    prefix?: string;
    /** Name of the handle type and prefix of enum constants (default: the state machine name, `CdPlayer`). */
    typeName?: string;
    /** Directory prepended to the paths of the generated files (default: none). */
    outDir?: string;
    /** Size of the buffers of string variables, event values and concatenation results including the terminating 0 (default 64). */
    stringCapacity?: number;
    /** Capacity of the internal event queue and of the queue of in events raised during a step (event driven, default 16). */
    queueCapacity?: number;
    /** Maximum number of transitions per step and of queued event steps per call (default 1000, like the interpreter). */
    maxMicrosteps?: number;
}

export interface CGeneratedFile {
    /** Path of the file (relative, including `outDir`). */
    path: string;
    content: string;
}

export interface CGeneratorDiagnostic {
    severity: 'error' | 'warning';
    message: string;
    node?: AstNode;
}

/** Names of the generated API, e.g. for test harnesses. */
export interface CApi {
    readonly prefix: string;
    readonly typeName: string;
    readonly macroPrefix: string;
    /** File name of the header (`cd_player.h`). */
    readonly header: string;
    readonly source: string;
    readonly executionMode: ExecutionMode;
    readonly executionOrder: ExecutionOrder;
    /** Cycle period in ms (`@CycleBased(period)`, default 200). */
    readonly cyclePeriod: number;
    readonly index: ModelIndex;
    /** Enum constant of a state (`CdPlayer_Closed_Active_Playing`). */
    state(state: ast.State): string;
    /** Enum constant of an event (`CdPlayer_event_play`). */
    event(event: ast.EventDeclaration): string;
    /** Function raising an in event (`cd_player_raise_play`). */
    raise(event: ast.EventDeclaration): string;
    /** Function returning the value of an event (`cd_player_get_finished_value`). */
    eventValue(event: ast.EventDeclaration): string;
    /** Function returning whether an out event was raised in the last call (`cd_player_is_raised_finished`). */
    isRaised(event: ast.EventDeclaration): string;
    getter(variable: ast.VariableDeclaration): string;
    /** Setter of a variable (`undefined` for constants and read-only variables). */
    setter(variable: ast.VariableDeclaration): string | undefined;
    /** Name of the function the host implements for an operation (`cd_player_discInserted`). */
    operation(operation: ast.OperationDeclaration): string;
    /** Type of a variable as seen by the generated code. */
    variableType(variable: ast.VariableDeclaration): HsmType;
    /** Number of time events (0: no timer service needed). */
    readonly timerCount: number;
    readonly functions: {
        readonly init: string;
        readonly enter: string;
        readonly exit: string;
        readonly runCycle: string;
        readonly isActive: string;
        readonly isFinal: string;
        readonly isStateActive: string;
        readonly raiseTimeEvent: string;
        readonly setTimer: string;
        readonly unsetTimer: string;
        readonly onError: string;
    };
    /** Type names: handle, state enum, event enum, timer enum, error enum. */
    readonly types: { readonly handle: string; readonly state: string; readonly event: string; readonly timer: string; readonly error: string };
}

export interface CGeneratorResult {
    /** `sc_types.h`, `<prefix>.h` and `<prefix>.c`; empty if there are errors. */
    files: CGeneratedFile[];
    diagnostics: CGeneratorDiagnostic[];
    api?: CApi;
}

/**
 * Generates C99 code for a state machine in the spirit of the itemis CREATE C generator: `sc_types.h`,
 * a header with the handle type and the API and a source file implementing docs/semantics.md.
 * The generated code uses no dynamic memory and no global state; operations, the timer service and the
 * error hook are functions implemented by the host.
 */
export function generateC(machine: ast.StateMachine, options: CGeneratorOptions = {}): CGeneratorResult {
    try {
        return new CGenerator(machine, options).generate();
    } catch (error) {
        if (error instanceof GeneratorError) {
            return { files: [], diagnostics: [{ severity: 'error', message: error.message, node: error.node }] };
        }
        if (error instanceof SimulationError) {
            return { files: [], diagnostics: [{ severity: 'error', message: error.message, node: error.node }] };
        }
        throw error;
    }
}

const ERROR_KINDS: Array<[ErrorKind, string]> = [
    ['division_by_zero', 'integer division or modulo by zero'],
    ['shift_out_of_range', 'shift amount outside of 0..63'],
    ['invalid_conversion', 'conversion of a non-finite real to integer'],
    ['no_enabled_transition', 'choice, entry point or exit node without enabled transition'],
    ['no_initial_transition', 'composite state entered by default without initial transition'],
    ['invalid_time', 'period of an every time event is not positive'],
    ['loop', 'too many transitions in one step or too many queued event steps'],
    ['queue_overflow', 'event queue is full, the event is dropped'],
    ['string_overflow', 'string does not fit into its buffer and is truncated']
];

/**
 * The C dialect of the {@link StatechartGenerator}: all data is in the handle struct `h`, the
 * functions of the state machine are static functions taking the handle.
 */
class CGenerator extends StatechartGenerator {

    private readonly prefix: string;
    private readonly cTypeName: string;
    private readonly macro: string;
    private readonly stringCapacity: number;
    private readonly queueCapacity: number;
    private readonly outDir?: string;
    private scratchCount = 0;
    private usesStrings = false;

    constructor(machine: ast.StateMachine, options: CGeneratorOptions) {
        const cppUsage = cppTypeUsage(machine);
        if (cppUsage) {
            throw new GeneratorError(`${CPP_TYPES_NOT_SUPPORTED}; use the C++ generator or simulate the model.`, cppUsage);
        }
        const classScope = machine.scopes.find(ast.isClassScope);
        if (classScope) {
            throw new GeneratorError(`${CLASS_SECTIONS_NOT_SUPPORTED}; use the C++ generator or simulate the model.`, classScope);
        }
        super(machine, options.maxMicrosteps, { keywords: C_KEYWORDS, reservedStateNames: C_RESERVED_STATE_NAMES });
        this.cTypeName = options.typeName ?? machine.name;
        this.prefix = options.prefix ?? snakeCase(machine.name);
        this.macro = this.prefix.toUpperCase();
        this.stringCapacity = options.stringCapacity ?? 64;
        this.queueCapacity = options.queueCapacity ?? 16;
        this.outDir = options.outDir;
        this.collectStringUsage();
    }

    /** Whether strings are used and how many scratch buffers the concatenations need. */
    private collectStringUsage(): void {
        this.usesStrings = [...this.variableTypes.values()].includes('string') || this.index.events().some(e => typeOfEvent(e) === 'string');
        for (const node of AstUtils.streamAllContents(this.machine)) {
            if (ast.isExpressionStatement(node) || ast.isRaiseStatement(node) || (ast.isReactionSpec(node))
                || ast.isLocalReaction(node) || ast.isVariableDeclaration(node) || ast.isTimeTrigger(node)) {
                const count = ast.isReactionSpec(node) || ast.isLocalReaction(node) ? countConcatenations(node.guard)
                    : ast.isVariableDeclaration(node) ? countConcatenations(node.initialValue)
                        : ast.isTimeTrigger(node) ? countConcatenations(node.value)
                            : countConcatenations(node);
                this.scratchCount = Math.max(this.scratchCount, count);
            }
        }
        if (this.scratchCount > 0) {
            this.usesStrings = true;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Names and hooks of the StatechartGenerator

    /** Member of the handle holding the variables of a scope (`iface`, `internal`, `iface_Panel`). */
    private scopeMember(scope: ScopeInfo): string {
        return scope.kind === 'internal' ? 'internal' : scope.kind === 'named' ? `iface_${scope.name}` : 'iface';
    }

    /** Prefix of the API functions of the scope of a declaration (`cd_player`, `cd_player_Panel`, `cd_player_internal`). */
    private scopeApi(declaration: ast.Declaration): string {
        const scope = this.scopeOf(declaration);
        return scope.kind === 'internal' ? `${this.prefix}_internal` : scope.kind === 'named' ? `${this.prefix}_${scope.name}` : this.prefix;
    }

    protected stateConstant(state: ast.State): string {
        return `${this.cTypeName}_${this.stateNames.get(state)}`;
    }

    protected get noState(): string {
        return `${this.cTypeName}_NO_STATE`;
    }

    protected get finalState(): string {
        return `${this.cTypeName}_FINAL_STATE`;
    }

    protected stateSlot(state: ast.State): string {
        return this.stateConstant(state);
    }

    protected get stateType(): string {
        return `${this.cTypeName}State`;
    }

    protected get maxMicrostepsConstant(): string {
        return `${this.macro}_MAX_MICROSTEPS`;
    }

    protected get runtimeFunctions(): readonly string[] {
        return RUNTIME_FUNCTIONS;
    }

    protected timerConstant(timer: TimerInfo): string {
        return `${this.cTypeName}_timer_${timer.ownerName}_${timer.index}`;
    }

    protected eventConstant(event: ast.EventDeclaration): string {
        return `${this.cTypeName}_event_${this.eventNames.get(event)}`;
    }

    private errorConstant(kind: ErrorKind): string {
        return `${this.cTypeName}_error_${kind}`;
    }

    private get onError(): string {
        return `${this.prefix}_on_error`;
    }

    protected errorCall(kind: ErrorKind, message: string): string {
        return `${this.onError}(h, ${this.errorConstant(kind)}, ${cString(message)});`;
    }

    protected call(fn: string, args?: string): string {
        return args ? `${fn}(h, ${args})` : `${fn}(h)`;
    }

    protected field(name: string): string {
        return `h->${name}`;
    }

    protected setTimer(timer: TimerInfo, duration: string, periodic: boolean): string {
        return `${this.prefix}_set_timer(h, ${this.timerConstant(timer)}, ${duration}, ${periodic});`;
    }

    protected unsetTimer(timer: TimerInfo): string {
        return `${this.prefix}_unset_timer(h, ${this.timerConstant(timer)});`;
    }

    // -----------------------------------------------------------------------------------------
    // ExpressionContext

    variable(variable: ast.VariableDeclaration): string {
        return `h->${this.scopeMember(this.scopeOf(variable))}.${this.variableMembers.get(variable)}`;
    }

    eventValue(event: ast.EventDeclaration): string {
        return `h->event_value.${this.eventNames.get(event)}`;
    }

    /** Name of the host function implementing an operation (`cd_player_discInserted`). */
    operation(operation: ast.OperationDeclaration): string {
        return `${this.scopeApi(operation)}_${operation.name}`;
    }

    operationCall(operation: ast.OperationDeclaration, args: Code[][]): string {
        const texts = ['h'];
        operation.parameters.forEach((parameter, index) => {
            const slot = args[index];
            if (parameter.varArgs) {
                texts.push(String(slot.length));
                texts.push(slot.length === 0 ? 'NULL' : `(const ${cType(typeOfParameter(parameter))}[]){${slot.map(s => stripParens(s.text)).join(', ')}}`);
            } else {
                texts.push(stripParens(slot[0].text));
            }
        });
        return `${this.operation(operation)}(${texts.join(', ')})`;
    }

    operationResult(type: HsmType, call: string): string {
        return type === 'string' ? `${this.helper('str_nonnull')}(${call})` : call;
    }

    raise(event: ast.EventDeclaration, block: CBlock): void {
        if (this.index.eventDirection(event) === 'out') {
            block.add(`${this.helper('raise_out')}(h, ${this.eventConstant(event)});`);
        } else {
            block.add(`${this.helper('raise_internal')}(h, ${this.eventConstant(event)});`);
        }
    }

    override helper(name: Helper): string {
        super.helper(name);
        if (name === 'raise_internal' && this.eventDriven) {
            this.enqueue();
        }
        return name;
    }

    withHandle(args: string): string {
        return `h, ${args}`;
    }

    typeName(type: HsmType): string {
        return cType(type);
    }

    toReal(text: string): string {
        return `((sc_real)${text})`;
    }

    store(target: string, type: HsmType, value: string): string {
        return type === 'string' ? `${this.helper('str_assign')}(h, ${target}, ${value});` : `${target} = ${value};`;
    }

    compareStrings(left: Code, right: Code, operator: '==' | '!='): string {
        return `(strcmp(${stripParens(left.text)}, ${stripParens(right.text)}) ${operator} 0)`;
    }

    concatStrings(left: Code, right: Code): string {
        return `${this.helper('str_concat')}(h, ${stripParens(left.text)}, ${stripParens(right.text)})`;
    }

    // -----------------------------------------------------------------------------------------
    // Generation

    generate(): CGeneratorResult {
        this.checkDuplicates();
        const api = this.createApi();
        const publicFunctions = this.publicFunctions();
        this.flush();
        const header = this.header();
        const source = this.source(publicFunctions);
        const dir = this.outDir ? this.outDir.replace(/\/+$/, '') + '/' : '';
        return {
            files: [
                { path: `${dir}sc_types.h`, content: SC_TYPES },
                { path: `${dir}${this.prefix}.h`, content: header },
                { path: `${dir}${this.prefix}.c`, content: source }
            ],
            diagnostics: [],
            api
        };
    }




    private get valueEvents(): ast.EventDeclaration[] {
        return this.events.filter(e => {
            const type = typeOfEvent(e);
            return type !== 'void' && type !== 'error';
        });
    }


    private raiseName(event: ast.EventDeclaration): string {
        return `${this.scopeApi(event)}_raise_${event.name}`;
    }

    private isRaisedName(event: ast.EventDeclaration): string {
        return `${this.scopeApi(event)}_is_raised_${event.name}`;
    }

    private eventValueName(event: ast.EventDeclaration): string {
        return `${this.scopeApi(event)}_get_${event.name}_value`;
    }

    private getterName(variable: ast.VariableDeclaration): string {
        return `${this.scopeApi(variable)}_get_${variable.name}`;
    }

    private setterName(variable: ast.VariableDeclaration): string | undefined {
        return variable.const || variable.readonly ? undefined : `${this.scopeApi(variable)}_set_${variable.name}`;
    }

    private createApi(): CApi {
        const t = this.cTypeName;
        return {
            prefix: this.prefix,
            typeName: t,
            macroPrefix: this.macro,
            header: `${this.prefix}.h`,
            source: `${this.prefix}.c`,
            executionMode: this.mode,
            executionOrder: this.order,
            cyclePeriod: this.cyclePeriod,
            index: this.index,
            state: state => this.stateConstant(state),
            event: event => this.eventConstant(event),
            raise: event => this.raiseName(event),
            eventValue: event => this.eventValueName(event),
            isRaised: event => this.isRaisedName(event),
            getter: variable => this.getterName(variable),
            setter: variable => this.setterName(variable),
            operation: operation => this.operation(operation),
            variableType: variable => this.variableType(variable),
            timerCount: this.timers.length,
            functions: {
                init: `${this.prefix}_init`,
                enter: `${this.prefix}_enter`,
                exit: `${this.prefix}_exit`,
                runCycle: `${this.prefix}_run_cycle`,
                isActive: `${this.prefix}_is_active`,
                isFinal: `${this.prefix}_is_final`,
                isStateActive: `${this.prefix}_is_state_active`,
                raiseTimeEvent: `${this.prefix}_raise_time_event`,
                setTimer: `${this.prefix}_set_timer`,
                unsetTimer: `${this.prefix}_unset_timer`,
                onError: this.onError
            },
            types: { handle: t, state: `${t}State`, event: `${t}Event`, timer: `${t}TimerId`, error: `${t}Error` }
        };
    }



    // ----- header

    private header(): string {
        const t = this.cTypeName;
        const m = this.macro;
        const lines: string[] = [];
        const guard = `${m}_H_`;
        lines.push(
            `/* Generated by hsm from state machine '${this.machine.name}' - do not edit. */`,
            `#ifndef ${guard}`,
            `#define ${guard}`,
            '',
            '#include "sc_types.h"',
            '',
            '#ifdef __cplusplus',
            'extern "C" {',
            '#endif',
            '',
            '/*',
            ` * State machine ${this.machine.name}${this.machine.description ? ` - ${commentText(this.machine.description)}` : ''}`,
            ` * Execution: ${this.eventDriven ? 'event driven (@EventDriven)' : `cycle based (@CycleBased(${this.cyclePeriod}))`}, ${this.order}.`,
            ' *',
            ` * Usage: ${this.prefix}_init(&handle); ${this.prefix}_enter(&handle); then raise in events and`,
            this.eventDriven ? ' * (event driven) each event is processed immediately.' : ` * call ${this.prefix}_run_cycle(&handle) periodically (every ${this.cyclePeriod} ms).`,
            ' * The host implements the required functions declared at the end of this file.',
            ' */',
            ''
        );
        if (!this.eventDriven) {
            lines.push(`/** Cycle period in ms (@CycleBased). */`, `#define ${m}_CYCLE_PERIOD_MS ${this.cyclePeriod}`, '');
        }
        if (this.usesStrings) {
            lines.push(
                '/** Size of the buffers of string variables, string event values and concatenation results (including the terminating 0). */',
                `#ifndef ${m}_STRING_CAPACITY`,
                `#define ${m}_STRING_CAPACITY ${this.stringCapacity}`,
                '#endif',
                ''
            );
            if (this.scratchCount > 0) {
                lines.push('/** Number of buffers for the results of string concatenations within one expression. */', `#define ${m}_SCRATCH_COUNT ${this.scratchCount}`, '');
            }
        }
        if (this.needsQueues) {
            lines.push(
                '/** Capacity of the internal event queue and of the queue of in events raised during a step. */',
                `#ifndef ${m}_QUEUE_CAPACITY`,
                `#define ${m}_QUEUE_CAPACITY ${this.queueCapacity}`,
                '#endif',
                ''
            );
        }
        lines.push(
            '/** Maximum number of transitions per step (and of queued event steps per call); protects against endless loops. */',
            `#ifndef ${m}_MAX_MICROSTEPS`,
            `#define ${m}_MAX_MICROSTEPS ${this.maxMicrosteps}`,
            '#endif',
            ''
        );
        // states
        lines.push('/** States (the final state of a region is FINAL_STATE). */', 'typedef enum {', `    ${t}_NO_STATE = 0,`);
        for (const state of this.index.states) {
            lines.push(`    ${this.stateConstant(state)},${spaces()}/* ${commentText(this.stateName(state))} */`);
        }
        lines.push(`    ${this.finalState}`, `} ${t}State;`, '');
        lines.push(`#define ${m}_STATE_COUNT ${this.index.states.length + 2}`, `#define ${m}_REGION_COUNT ${this.regions.length}`, '');
        if (this.hasEvents) {
            lines.push('/** Events. */', 'typedef enum {');
            this.events.forEach((event, i) => {
                const direction = this.index.eventDirection(event);
                lines.push(`    ${this.eventConstant(event)}${i < this.events.length - 1 ? ',' : ''}${spaces()}/* ${direction} event ${this.index.declarationName(event)} */`);
            });
            lines.push(`} ${t}Event;`, '', `#define ${m}_EVENT_COUNT ${this.events.length}`, '');
        }
        if (this.timers.length > 0) {
            lines.push('/** Time events (identify the timers of the timer service). */', 'typedef enum {');
            this.timers.forEach((timer, i) => {
                const owner = ast.isStateMachine(timer.owner) ? 'state machine' : this.stateName(timer.owner);
                lines.push(`    ${this.timerConstant(timer)}${i < this.timers.length - 1 ? ',' : ''}${spaces()}/* ${commentText(nodeText(timer.trigger))} (${owner}) */`);
            });
            lines.push(`} ${t}TimerId;`, '', `#define ${m}_TIMER_COUNT ${this.timers.length}`, '');
        }
        lines.push('/** Runtime errors reported to ' + this.onError + '(). */', 'typedef enum {');
        ERROR_KINDS.forEach(([kind, description], i) => {
            lines.push(`    ${this.errorConstant(kind)}${i < ERROR_KINDS.length - 1 ? ',' : ''}${spaces()}/* ${description} */`);
        });
        lines.push(`} ${t}Error;`, '');
        // handle
        lines.push(`typedef struct ${t} ${t};`, '');
        if (this.outEvents.length > 0) {
            lines.push('/** Observer of out events, called when the state machine raises an out event. */', `typedef void (*${t}OutEventObserver)(${t} *handle, ${t}Event event);`, '');
        }
        lines.push(`/** Handle of the state machine: its complete state. Initialize it with ${this.prefix}_init(). */`, `struct ${t} {`);
        lines.push('    /** Free for use by the host (e.g. in operation implementations); not used by the state machine. */', '    void *user_data;');
        if (this.outEvents.length > 0) {
            lines.push(`    /** Optional observer of out events (NULL: none). */`, `    ${t}OutEventObserver out_event_observer;`);
        }
        lines.push('    /* Internal state - use the functions below. */');
        lines.push('    sc_boolean running;', '    sc_boolean busy;', '    sc_boolean in_step;', '    sc_integer microsteps;');
        lines.push(`    ${t}State active[${m}_REGION_COUNT];`);
        if (this.historyRegions.size > 0) {
            lines.push(`    ${t}State history[${m}_REGION_COUNT];`);
        }
        lines.push(`    sc_boolean entered[${m}_STATE_COUNT];`, `    sc_boolean exited[${m}_STATE_COUNT];`);
        if (this.hasEvents) {
            lines.push(`    sc_boolean present[${m}_EVENT_COUNT];`);
            if (!this.eventDriven) {
                lines.push(`    sc_boolean collected[${m}_EVENT_COUNT];`);
            }
            if (this.outEvents.length > 0) {
                lines.push(`    sc_boolean out_raised[${m}_EVENT_COUNT];`);
            }
        }
        if (this.timers.length > 0) {
            lines.push(`    sc_boolean timer_pending[${m}_TIMER_COUNT];`, `    sc_boolean timer_present[${m}_TIMER_COUNT];`);
        }
        if (this.eventDriven && (this.hasEvents || this.timers.length > 0)) {
            lines.push(
                `    int internal_queue[${m}_QUEUE_CAPACITY];`, '    int internal_queue_head;', '    int internal_queue_count;',
                `    int host_queue[${m}_QUEUE_CAPACITY];`, '    int host_queue_head;', '    int host_queue_count;'
            );
        }
        for (const scope of this.scopes.values()) {
            const variables = [...this.variableMembers].filter(([v]) => this.scopeOf(v) === scope);
            if (variables.length === 0) {
                continue;
            }
            lines.push('    struct {');
            for (const [variable, member] of variables) {
                lines.push(`        ${this.memberDeclaration(this.variableType(variable), member)}`);
            }
            lines.push(`    } ${this.scopeMember(scope)};`);
        }
        if (this.valueEvents.length > 0) {
            lines.push('    struct {');
            for (const event of this.valueEvents) {
                lines.push(`        ${this.memberDeclaration(typeOfEvent(event), this.eventNames.get(event)!)}`);
            }
            lines.push('    } event_value;');
        }
        if (this.scratchCount > 0) {
            lines.push(`    char scratch[${m}_SCRATCH_COUNT][${m}_STRING_CAPACITY];`, '    int scratch_next;');
        }
        lines.push('};', '');
        // API
        lines.push('/* ---- API ---- */', '');
        lines.push(`/** Initializes the handle (all variables get their default values). Call it before any other function. */`, `void ${this.prefix}_init(${t} *handle);`);
        lines.push(`/** Enters the state machine: initializes the variables, enters the initial states. */`, `void ${this.prefix}_enter(${t} *handle);`);
        lines.push(`/** Exits the state machine (exit reactions of all active states). */`, `void ${this.prefix}_exit(${t} *handle);`);
        lines.push(this.eventDriven
            ? `/** Performs a step without events (event driven: events are processed when they are raised). */`
            : `/** Performs a run cycle: one step with all events raised since the previous cycle. */`, `void ${this.prefix}_run_cycle(${t} *handle);`);
        lines.push(`/** Whether the state machine has been entered and not exited. */`, `sc_boolean ${this.prefix}_is_active(const ${t} *handle);`);
        lines.push(`/** Whether the state machine is final (the final state of its top-level region is active). */`, `sc_boolean ${this.prefix}_is_final(const ${t} *handle);`);
        lines.push(`/** Whether a state is active. */`, `sc_boolean ${this.prefix}_is_state_active(const ${t} *handle, ${t}State state);`);
        if (this.timers.length > 0) {
            lines.push(`/** Called by the timer service when the timer of a time event expires. */`, `void ${this.prefix}_raise_time_event(${t} *handle, ${t}TimerId timer);`);
        }
        if (this.outEvents.length > 0) {
            lines.push(`/** Sets the observer of out events (NULL: none). */`, `void ${this.prefix}_set_out_event_observer(${t} *handle, ${t}OutEventObserver observer);`);
        }
        lines.push('');
        for (const event of this.inEvents) {
            const type = typeOfEvent(event);
            const param = type === 'void' || type === 'error' ? '' : `, ${cType(type)} value`;
            lines.push(`/** Raises the in event ${this.index.declarationName(event)}. */`, `void ${this.raiseName(event)}(${t} *handle${param});`);
        }
        for (const event of this.outEvents) {
            lines.push(`/** Whether the out event ${this.index.declarationName(event)} was raised during the last call of enter, exit, run_cycle or (event driven) raise. */`,
                `sc_boolean ${this.isRaisedName(event)}(const ${t} *handle);`);
        }
        for (const event of this.valueEvents) {
            lines.push(`/** Value of the last occurrence of the event ${this.index.declarationName(event)}. */`, `${cType(typeOfEvent(event))} ${this.eventValueName(event)}(const ${t} *handle);`);
        }
        for (const variable of this.index.variables()) {
            const type = this.variableType(variable);
            const kind = variable.const ? 'constant' : variable.readonly ? 'read-only variable' : 'variable';
            lines.push(`/** Value of the ${kind} ${this.index.declarationName(variable)}. */`, `${cType(type)} ${this.getterName(variable)}(const ${t} *handle);`);
            const setter = this.setterName(variable);
            if (setter) {
                lines.push(`void ${setter}(${t} *handle, ${cType(type)} value);`);
            }
        }
        lines.push('', '/* ---- Required functions, implemented by the host ---- */', '');
        for (const operation of this.operations) {
            lines.push(`/** Operation ${this.index.declarationName(operation)}. */`, `extern ${this.operationSignature(operation)};`);
        }
        if (this.timers.length > 0) {
            lines.push(
                `/**`,
                ` * Timer service: starts the timer of a time event. When it expires after duration_ns nanoseconds,`,
                ` * call ${this.prefix}_raise_time_event(handle, timer); periodic timers expire every duration_ns.`,
                ` * Starting a running timer again restarts it.`,
                ` */`,
                `extern void ${this.prefix}_set_timer(${t} *handle, ${t}TimerId timer, sc_integer duration_ns, sc_boolean periodic);`,
                `/** Timer service: stops the timer of a time event. */`,
                `extern void ${this.prefix}_unset_timer(${t} *handle, ${t}TimerId timer);`
            );
        }
        lines.push(
            `/**`,
            ` * Runtime error (docs/semantics.md), e.g. a choice without enabled branch or a division by zero.`,
            ` * After it returns, the state machine continues: the failed division yields 0, the choice is not left, ...`,
            ` */`,
            `extern void ${this.onError}(${t} *handle, ${t}Error error, const char *message);`,
            '',
            '#ifdef __cplusplus',
            '}',
            '#endif',
            '',
            `#endif /* ${guard} */`,
            ''
        );
        return alignComments(lines).join('\n');
    }

    private memberDeclaration(type: HsmType, member: string): string {
        return type === 'string' ? `char ${member}[${this.macro}_STRING_CAPACITY];` : `${cType(type)} ${member};`;
    }

    private operationSignature(operation: ast.OperationDeclaration): string {
        const params = [`${this.cTypeName} *handle`];
        for (const parameter of operation.parameters) {
            const type = cType(typeOfParameter(parameter));
            if (parameter.varArgs) {
                params.push(`sc_integer ${parameter.name}_count`, `const ${type} *${parameter.name}`);
            } else {
                params.push(`${type} ${parameter.name}`);
            }
        }
        return `${cType(returnTypeOf(operation))} ${this.operation(operation)}(${params.join(', ')})`;
    }

    /** Checks that the identifiers of the header are unique (e.g. a state `event_x` and an event `x`). */
    private checkDuplicates(): void {
        const t = this.cTypeName;
        const identifiers = [
            t, `${t}State`, `${t}Event`, `${t}TimerId`, `${t}Error`, `${t}OutEventObserver`, this.noState, this.finalState,
            ...this.index.states.map(s => this.stateConstant(s)),
            ...this.events.map(e => this.eventConstant(e)),
            ...this.timers.map(timer => this.timerConstant(timer)),
            ...ERROR_KINDS.map(([kind]) => this.errorConstant(kind)),
            ...['init', 'enter', 'exit', 'run_cycle', 'is_active', 'is_final', 'is_state_active', 'raise_time_event',
                'set_out_event_observer', 'set_timer', 'unset_timer', 'on_error'].map(name => `${this.prefix}_${name}`),
            ...this.inEvents.map(e => this.raiseName(e)),
            ...this.outEvents.map(e => this.isRaisedName(e)),
            ...this.valueEvents.map(e => this.eventValueName(e)),
            ...this.index.variables().flatMap(v => [this.getterName(v), this.setterName(v) ?? '']).filter(name => name),
            ...this.operations.map(o => this.operation(o))
        ];
        const seen = new Set<string>();
        for (const identifier of identifiers) {
            if (seen.has(identifier)) {
                throw new GeneratorError(`The generated identifier '${identifier}' is not unique; rename a state, event, variable or operation`, this.machine);
            }
            seen.add(identifier);
        }
    }

    // ----- source

    private publicFunctions(): CBlock[] {
        const t = this.cTypeName;
        const result: CBlock[] = [];
        const fn = (comment: string, signature: string, build: (body: CBlock) => void) => {
            this.expressions.resetTemporaries();
            const body = new CBlock();
            build(body);
            result.push(new CBlock().add(`/* ${comment} */`).block(signature, body));
        };
        fn('Initializes the handle.', `void ${this.prefix}_init(${t} *h)`, body => {
            body.add('int i;');
            if (this.outEvents.length > 0) {
                body.add('h->out_event_observer = NULL;');
            }
            body.add('h->running = false;', 'h->busy = false;', 'h->in_step = false;', 'h->microsteps = 0;');
            const regions = [`h->active[i] = ${this.noState};`];
            if (this.historyRegions.size > 0) {
                regions.push(`h->history[i] = ${this.noState};`);
            }
            body.block(`for (i = 0; i < ${this.macro}_REGION_COUNT; i++)`, regions);
            body.block(`for (i = 0; i < ${this.macro}_STATE_COUNT; i++)`, ['h->entered[i] = false;', 'h->exited[i] = false;']);
            this.clearEventFlags(body, true);
            if (this.scratchCount > 0) {
                body.add('h->scratch_next = 0;');
                body.block(`for (i = 0; i < ${this.macro}_SCRATCH_COUNT; i++)`, ['h->scratch[i][0] = \'\\0\';']);
            }
            body.add(`${this.resetData()}(h);`);
        });
        fn('Enters the state machine (docs/semantics.md §8).', `void ${this.prefix}_enter(${t} *h)`, body => {
            body.add('int i;');
            body.block('if (h->running || h->busy)', ['return;']);
            body.add(`${this.beginHostCall()}(h);`);
            body.add(`${this.resetData()}(h);`);
            const regions = [`h->active[i] = ${this.noState};`];
            if (this.historyRegions.size > 0) {
                regions.push(`h->history[i] = ${this.noState};`);
            }
            body.block(`for (i = 0; i < ${this.macro}_REGION_COUNT; i++)`, regions);
            this.clearEventFlags(body, false);
            body.add('h->running = true;');
            const variables = this.index.variables().filter(v => v.initialValue);
            if (variables.length > 0) {
                body.add('/* variables and constants in declaration order */');
                for (const variable of variables) {
                    const type = this.variableType(variable);
                    const value = this.expressions.value(variable.initialValue!, type, body);
                    this.expressions.store(this.variable(variable), type, value.text, body);
                }
            }
            body.add(`${this.beginStep()}(h);`);
            this.builtinReactions(this.machine, 'entry', body);
            for (const trigger of this.index.timeTriggers(this.machine)) {
                this.startTimer(trigger, body);
            }
            body.add(`${this.regionEnter(this.machine)}(h);`);
            if (this.eventDriven) {
                body.add('/* event driven: a step without events */', `${this.step()}(h);`);
                if (this.needsQueues) {
                    body.add(`${this.drainQueues()}(h);`);
                }
            }
            body.add('h->busy = false;');
        });
        fn('Exits the state machine.', `void ${this.prefix}_exit(${t} *h)`, body => {
            body.block('if (!h->running || h->busy)', ['return;']);
            body.add(`${this.beginHostCall()}(h);`, `${this.beginStep()}(h);`);
            this.exitScope(this.machine, body);
            this.builtinReactions(this.machine, 'exit', body);
            body.add('h->running = false;');
            for (const trigger of this.index.timeTriggers(this.machine)) {
                this.stopTimer(trigger, body);
            }
            body.add('h->busy = false;');
        });
        fn(this.eventDriven ? 'Performs a step without events.' : 'Performs a run cycle (docs/semantics.md §3).', `void ${this.prefix}_run_cycle(${t} *h)`, body => {
            body.block('if (!h->running || h->busy)', ['return;']);
            body.add(`${this.beginHostCall()}(h);`);
            if (this.eventDriven) {
                body.block(`if (h->active[${this.regionId(this.machine)}] != ${this.finalState})`, [`${this.step()}(h);`]);
                if (this.needsQueues) {
                    body.add(`${this.drainQueues()}(h);`);
                }
            } else {
                const final = this.hasEvents ? ['/* final: events are discarded */', `for (i = 0; i < ${this.macro}_EVENT_COUNT; i++) {`, '    h->collected[i] = false;', '}'] : ['/* final */'];
                if (this.hasEvents || this.timers.length > 0) {
                    body.lines.unshift('int i;');
                }
                body.block(`if (h->active[${this.regionId(this.machine)}] == ${this.finalState})`, final, '} else {');
                const inner = new CBlock();
                if (this.hasEvents) {
                    inner.block(`for (i = 0; i < ${this.macro}_EVENT_COUNT; i++)`, ['h->present[i] = h->collected[i];', 'h->collected[i] = false;']);
                }
                if (this.timers.length > 0) {
                    inner.block(`for (i = 0; i < ${this.macro}_TIMER_COUNT; i++)`, ['h->timer_present[i] = h->timer_pending[i];', 'h->timer_pending[i] = false;']);
                }
                inner.add(`${this.step()}(h);`);
                body.lines.push(...indent(inner.lines), '}');
            }
            body.add('h->busy = false;');
        });
        fn('Whether the state machine is running.', `sc_boolean ${this.prefix}_is_active(const ${t} *h)`, body => {
            body.add('return h->running;');
        });
        fn('Whether the state machine is final.', `sc_boolean ${this.prefix}_is_final(const ${t} *h)`, body => {
            body.add(`return h->active[${this.regionId(this.machine)}] == ${this.finalState};`);
        });
        fn('Whether a state is active.', `sc_boolean ${this.prefix}_is_state_active(const ${t} *h, ${t}State state)`, body => {
            const cases = new CBlock();
            for (const state of this.index.states) {
                cases.add(`case ${this.stateConstant(state)}:`, `    return h->active[${this.regionId(this.index.regionOf(state))}] == ${this.stateConstant(state)};`);
            }
            cases.add('default:', '    return false;');
            body.block('switch (state)', cases);
        });
        if (this.timers.length > 0) {
            fn('Raises a time event (called by the timer service).', `void ${this.prefix}_raise_time_event(${t} *h, ${t}TimerId timer)`, body => {
                if (this.eventDriven) {
                    body.block('if (!h->running)', ['return;']);
                    body.block('if (h->busy)', [`${this.enqueue()}(h, 1, ${this.hasEvents ? `${this.macro}_EVENT_COUNT` : '0'} + (int)timer);`, 'return;']);
                    body.add(`${this.beginHostCall()}(h);`);
                    body.add(`${this.processQueued()}(h, ${this.hasEvents ? `${this.macro}_EVENT_COUNT` : '0'} + (int)timer);`);
                    body.add(`${this.drainQueues()}(h);`);
                    body.add('h->busy = false;');
                } else {
                    body.add('h->timer_pending[timer] = true;');
                }
            });
        }
        if (this.outEvents.length > 0) {
            fn('Sets the observer of out events.', `void ${this.prefix}_set_out_event_observer(${t} *h, ${t}OutEventObserver observer)`, body => {
                body.add('h->out_event_observer = observer;');
            });
        }
        for (const event of this.inEvents) {
            const type = typeOfEvent(event);
            const hasValue = type !== 'void' && type !== 'error';
            fn(`Raises the in event ${this.index.declarationName(event)}.`, `void ${this.raiseName(event)}(${t} *h${hasValue ? `, ${cType(type)} value` : ''})`, body => {
                if (this.eventDriven) {
                    body.block('if (!h->running)', ['return;']);
                }
                if (hasValue) {
                    this.expressions.store(this.eventValue(event), type, 'value', body);
                }
                if (this.eventDriven) {
                    body.block('if (h->busy)', [`${this.enqueue()}(h, 1, ${this.eventConstant(event)});`, 'return;']);
                    body.add(`${this.beginHostCall()}(h);`, `${this.processQueued()}(h, ${this.eventConstant(event)});`, `${this.drainQueues()}(h);`, 'h->busy = false;');
                } else {
                    body.add(`h->collected[${this.eventConstant(event)}] = true;`);
                }
            });
        }
        for (const event of this.outEvents) {
            fn(`Whether the out event ${this.index.declarationName(event)} was raised.`, `sc_boolean ${this.isRaisedName(event)}(const ${t} *h)`, body => {
                body.add(`return h->out_raised[${this.eventConstant(event)}];`);
            });
        }
        for (const event of this.valueEvents) {
            fn(`Value of the event ${this.index.declarationName(event)}.`, `${cType(typeOfEvent(event))} ${this.eventValueName(event)}(const ${t} *h)`, body => {
                body.add(`return ${this.eventValue(event)};`);
            });
        }
        for (const variable of this.index.variables()) {
            const type = this.variableType(variable);
            fn(`Value of ${this.index.declarationName(variable)}.`, `${cType(type)} ${this.getterName(variable)}(const ${t} *h)`, body => {
                body.add(`return ${this.variable(variable)};`);
            });
            const setter = this.setterName(variable);
            if (setter) {
                fn(`Sets ${this.index.declarationName(variable)}.`, `void ${setter}(${t} *h, ${cType(type)} value)`, body => {
                    this.expressions.store(this.variable(variable), type, 'value', body);
                });
            }
        }
        return result;
    }

    private get needsQueues(): boolean {
        return this.eventDriven && (this.hasEvents || this.timers.length > 0);
    }

    private clearEventFlags(body: CBlock, all: boolean): void {
        const m = this.macro;
        if (this.hasEvents) {
            const flags = ['h->present[i] = false;'];
            if (!this.eventDriven) {
                flags.push('h->collected[i] = false;');
            }
            if (this.outEvents.length > 0 && all) {
                flags.push('h->out_raised[i] = false;');
            }
            body.block(`for (i = 0; i < ${m}_EVENT_COUNT; i++)`, flags);
        }
        if (this.timers.length > 0) {
            body.block(`for (i = 0; i < ${m}_TIMER_COUNT; i++)`, ['h->timer_pending[i] = false;', 'h->timer_present[i] = false;']);
        }
        if (this.needsQueues) {
            body.add('h->internal_queue_head = 0;', 'h->internal_queue_count = 0;', 'h->host_queue_head = 0;', 'h->host_queue_count = 0;');
        }
    }

    private resetData(): string {
        return this.use('reset_data', [], 'Sets all variables and event values to the default values of their types.', body => {
            for (const variable of this.index.variables()) {
                const type = this.variableType(variable);
                body.add(type === 'string' ? `${this.variable(variable)}[0] = '\\0';` : `${this.variable(variable)} = ${cDefault(type)};`);
            }
            for (const event of this.valueEvents) {
                const type = typeOfEvent(event);
                body.add(type === 'string' ? `${this.eventValue(event)}[0] = '\\0';` : `${this.eventValue(event)} = ${cDefault(type)};`);
            }
            if (body.isEmpty) {
                body.add('(void)h;');
            }
        });
    }

    private beginHostCall(): string {
        return this.use('begin_host_call', [], 'Start of a call of the host that executes the state machine.', body => {
            if (this.outEvents.length > 0) {
                body.add('int i;');
                body.block(`for (i = 0; i < ${this.macro}_EVENT_COUNT; i++)`, ['h->out_raised[i] = false;']);
            }
            body.add('h->busy = true;');
        });
    }

    private beginStep(): string {
        return this.use('begin_step', [], 'Start of a step: no state has been entered or exited yet.', body => {
            body.add('int i;');
            body.block(`for (i = 0; i < ${this.macro}_STATE_COUNT; i++)`, ['h->entered[i] = false;', 'h->exited[i] = false;']);
            body.add('h->microsteps = 0;');
        });
    }

    private step(): string {
        return this.use('step', [], 'A step (docs/semantics.md §4): the reactions of the state machine, then the active states top down.', body => {
            body.add(`${this.beginStep()}(h);`, 'h->in_step = true;');
            this.localReactions(this.machine, body);
            const states = this.regionStates(this.machine);
            if (states.length > 0) {
                const cases = new CBlock();
                for (const state of states) {
                    cases.add(`case ${this.stateConstant(state)}:`, `    (void)${this.react(state)}(h);`, '    break;');
                }
                cases.add('default:', '    break;');
                body.block(`switch (h->active[${this.regionId(this.machine)}])`, cases);
            }
            body.add('h->in_step = false;');
            if (this.hasEvents || this.timers.length > 0) {
                body.add(`${this.clearPresent()}(h);`);
            }
        });
    }

    private clearPresent(): string {
        return this.use('clear_present', [], 'Clears the events of a step.', body => {
            body.add('int i;');
            if (this.hasEvents) {
                body.block(`for (i = 0; i < ${this.macro}_EVENT_COUNT; i++)`, ['h->present[i] = false;']);
            }
            if (this.timers.length > 0) {
                body.block(`for (i = 0; i < ${this.macro}_TIMER_COUNT; i++)`, ['h->timer_present[i] = false;']);
            }
        });
    }


    /** Event driven: a queued item is an event (`< EVENT_COUNT`) or a time event (`EVENT_COUNT + timer`). */
    private enqueue(): string {
        return this.use('enqueue', ['int host', 'int item'], 'Appends an event to the internal queue (host = 0) or the queue of in events raised during a step (host = 1).', body => {
            body.add('int *queue = host ? h->host_queue : h->internal_queue;');
            body.add('int head = host ? h->host_queue_head : h->internal_queue_head;');
            body.add('int *count = host ? &h->host_queue_count : &h->internal_queue_count;');
            body.block(`if (*count >= ${this.macro}_QUEUE_CAPACITY)`, [this.errorCall('queue_overflow', 'The event queue is full'), 'return;']);
            body.add(`queue[(head + *count) % ${this.macro}_QUEUE_CAPACITY] = item;`, '(*count)++;');
        });
    }

    private processQueued(): string {
        return this.use('process', ['int item'], 'Event driven: a step in which only the given event (or time event) is present.', body => {
            body.block(`if (!h->running || h->active[${this.regionId(this.machine)}] == ${this.finalState})`, ['return;']);
            const flags: string[] = [];
            if (this.hasEvents) {
                flags.push(`if (item < ${this.macro}_EVENT_COUNT) {`, '    h->present[item] = true;', '}');
            }
            if (this.timers.length > 0) {
                const offset = this.hasEvents ? `${this.macro}_EVENT_COUNT` : '0';
                if (flags.length > 0) {
                    flags[flags.length - 1] = '} else {';
                    flags.push(`    h->timer_present[item - ${offset}] = true;`, '}');
                } else {
                    flags.push(`h->timer_present[item - ${offset}] = true;`);
                }
            }
            body.add(...flags, `${this.step()}(h);`);
        });
    }

    private drainQueues(): string {
        return this.use('drain_queues', [], 'Event driven: processes the queued internal events, then the in events raised meanwhile by the host.', body => {
            body.add('int steps = 0;');
            const loop = new CBlock();
            loop.add('int item;');
            loop.block('if (h->internal_queue_count > 0)', [
                'item = h->internal_queue[h->internal_queue_head];',
                `h->internal_queue_head = (h->internal_queue_head + 1) % ${this.macro}_QUEUE_CAPACITY;`,
                'h->internal_queue_count--;'
            ], '} else if (h->host_queue_count > 0) {');
            loop.lines.push(
                '    item = h->host_queue[h->host_queue_head];',
                `    h->host_queue_head = (h->host_queue_head + 1) % ${this.macro}_QUEUE_CAPACITY;`,
                '    h->host_queue_count--;',
                '} else {',
                '    return;',
                '}'
            );
            loop.block(`if (++steps > ${this.macro}_MAX_MICROSTEPS)`, [
                this.errorCall('loop', `More than ${this.maxMicrosteps} queued event steps; the state machine seems to loop`),
                'h->internal_queue_count = 0;',
                'h->host_queue_count = 0;',
                'return;'
            ]);
            loop.add(`${this.processQueued()}(h, item);`);
            body.block('for (;;)', loop);
        });
    }

    private source(publicFunctions: CBlock[]): string {
        const lines: string[] = [
            `/* Generated by hsm from state machine '${this.machine.name}' - do not edit. */`,
            `#include "${this.prefix}.h"`,
            '',
            '#include <stddef.h>',
            '#include <string.h>'
        ];
        if (this.helpers.has('real_to_int')) {
            lines.push('#include <float.h>');
        }
        lines.push('', '/* Regions: index into active[] and history[]. */', 'enum {');
        this.regions.forEach((region, i) => {
            lines.push(`    ${this.regionId(region)}${i < this.regions.length - 1 ? ',' : ''}${spaces()}/* ${commentText(this.regionLabel(region))} */`);
        });
        lines.push('};', '');
        // helpers
        const functions = this.sortedFunctions();
        const signature = (fn: GeneratedFunction) =>
            `static ${cType(fn.returnType)} ${fn.name}(${this.cTypeName} *h${fn.params.map(p => `, ${p}`).join('')})`;
        lines.push('/* ---- Prototypes ---- */', '');
        for (const fn of functions) {
            lines.push(`${signature(fn)};`);
        }
        lines.push('');
        const helpers = HELPER_ORDER.filter(h => this.helpers.has(h));
        if (helpers.length > 0) {
            lines.push('/* ---- Runtime helpers ---- */', '');
            for (const helper of helpers) {
                lines.push(...this.helperSource(helper), '');
            }
        }
        lines.push('/* ---- State machine ---- */', '');
        for (const fn of functions) {
            const body = fn.body.lines.some(line => /\bh\b/.test(line)) ? fn.body.lines : ['(void)h;', ...fn.body.lines];
            lines.push(`/* ${fn.comment} */`, `${signature(fn)} {`, ...indent(body), '}', '');
        }
        lines.push('/* ---- API ---- */', '');
        for (const block of publicFunctions) {
            lines.push(...block.lines, '');
        }
        return alignComments(lines).join('\n');
    }

    private helperSource(helper: Helper): string[] {
        const t = this.cTypeName;
        const m = this.macro;
        switch (helper) {
            case 'int_add':
                return ['/* Integer arithmetic wraps around (two\'s complement) like in the interpreter. */',
                    'static sc_integer int_add(sc_integer a, sc_integer b) {', '    return (sc_integer)((uint64_t)a + (uint64_t)b);', '}'];
            case 'int_sub':
                return ['static sc_integer int_sub(sc_integer a, sc_integer b) {', '    return (sc_integer)((uint64_t)a - (uint64_t)b);', '}'];
            case 'int_mul':
                return ['static sc_integer int_mul(sc_integer a, sc_integer b) {', '    return (sc_integer)((uint64_t)a * (uint64_t)b);', '}'];
            case 'int_neg':
                return ['static sc_integer int_neg(sc_integer a) {', '    return (sc_integer)((uint64_t)0 - (uint64_t)a);', '}'];
            case 'int_div':
                return ['/* Integer division truncates toward zero; division by zero is a runtime error (result 0). */',
                    `static sc_integer int_div(${t} *h, sc_integer a, sc_integer b) {`,
                    '    if (b == 0) {',
                    `        ${this.errorCall('division_by_zero', 'Division by zero')}`,
                    '        return 0;',
                    '    }',
                    '    return b == -1 ? int_neg(a) : a / b;',
                    '}'];
            case 'int_mod':
                return [`static sc_integer int_mod(${t} *h, sc_integer a, sc_integer b) {`,
                    '    if (b == 0) {',
                    `        ${this.errorCall('division_by_zero', 'Division by zero')}`,
                    '        return 0;',
                    '    }',
                    '    return b == -1 ? 0 : a % b;',
                    '}'];
            case 'int_shl':
                return [`static sc_integer int_shl(${t} *h, sc_integer a, sc_integer b) {`,
                    '    if (b < 0 || b > 63) {',
                    `        ${this.errorCall('shift_out_of_range', 'Shift amount is out of range 0..63')}`,
                    '        return 0;',
                    '    }',
                    '    return (sc_integer)((uint64_t)a << b);',
                    '}'];
            case 'int_shr':
                return ['/* Arithmetic shift right. */',
                    `static sc_integer int_shr(${t} *h, sc_integer a, sc_integer b) {`,
                    '    if (b < 0 || b > 63) {',
                    `        ${this.errorCall('shift_out_of_range', 'Shift amount is out of range 0..63')}`,
                    '        return 0;',
                    '    }',
                    '    return a >= 0 ? a >> b : ~(~a >> b);',
                    '}'];
            case 'real_to_int':
                return ['/* Conversion real -> integer: truncates toward zero, wraps around outside of the 64-bit range. */',
                    `static sc_integer real_to_int(${t} *h, sc_real x) {`,
                    '    const sc_real two64 = 18446744073709551616.0;',
                    '    sc_real q;',
                    '    sc_real r;',
                    '    if (x != x || x > DBL_MAX || x < -DBL_MAX) {',
                    `        ${this.errorCall('invalid_conversion', 'Cannot convert a non-finite real to integer')}`,
                    '        return 0;',
                    '    }',
                    '    if (x >= -9223372036854775808.0 && x < 9223372036854775808.0) {',
                    '        return (sc_integer)x;',
                    '    }',
                    '    q = x / two64;',
                    '    if (q <= -9223372036854775808.0 || q >= 9223372036854775808.0) {',
                    '        return 0;',
                    '    }',
                    '    r = x - (sc_real)(sc_integer)q * two64;',
                    '    if (r < 0) {',
                    '        r += two64;',
                    '    }',
                    '    return (sc_integer)(uint64_t)r;',
                    '}'];
            case 'real_round':
                return ['/* Rounds to the nearest integer, halves up (like Math.round). */',
                    'static sc_integer real_round(sc_real x) {',
                    '    sc_real y = x + 0.5;',
                    '    sc_integer n;',
                    '    if (!(y > -9223372036854775808.0 && y < 9223372036854775808.0)) {',
                    '        return y > 0 ? INT64_MAX : 0;',
                    '    }',
                    '    n = (sc_integer)y;',
                    '    return (sc_real)n > y ? n - 1 : n;',
                    '}'];
            case 'str_nonnull':
                return ['static sc_string str_nonnull(sc_string s) {', '    return s != NULL ? s : "";', '}'];
            case 'str_assign':
                return ['/* Copies a string into a buffer of the handle (truncated to the capacity). */',
                    `static void str_assign(${t} *h, char *target, sc_string value) {`,
                    '    size_t i = 0;',
                    '    if (value == NULL) {',
                    '        value = "";',
                    '    }',
                    '    if (target == value) {',
                    '        return;',
                    '    }',
                    `    while (value[i] != '\\0' && i < ${m}_STRING_CAPACITY - 1) {`,
                    '        target[i] = value[i];',
                    '        i++;',
                    '    }',
                    "    target[i] = '\\0';",
                    "    if (value[i] != '\\0') {",
                    `        ${this.errorCall('string_overflow', 'String too long')}`,
                    '    }',
                    '}'];
            case 'str_concat':
                return ['/* Concatenates two strings into the next scratch buffer (valid while the expression is evaluated). */',
                    `static sc_string str_concat(${t} *h, sc_string a, sc_string b) {`,
                    '    char *buffer = h->scratch[h->scratch_next];',
                    '    size_t n = 0;',
                    `    h->scratch_next = (h->scratch_next + 1) % ${m}_SCRATCH_COUNT;`,
                    `    while (*a != '\\0' && n < ${m}_STRING_CAPACITY - 1) {`,
                    '        buffer[n++] = *a++;',
                    '    }',
                    `    while (*b != '\\0' && n < ${m}_STRING_CAPACITY - 1) {`,
                    '        buffer[n++] = *b++;',
                    '    }',
                    "    buffer[n] = '\\0';",
                    "    if (*a != '\\0' || *b != '\\0') {",
                    `        ${this.errorCall('string_overflow', 'String too long')}`,
                    '    }',
                    '    return buffer;',
                    '}'];
            case 'raise_internal':
                return this.eventDriven
                    ? ['/* Raises an internal event (or an in event raised by the state machine): queued for its own step. */',
                        `static void raise_internal(${t} *h, ${t}Event event) {`,
                        `    ${this.enqueue()}(h, 0, (int)event);`,
                        '}']
                    : ['/* Raises an internal event (or an in event raised by the state machine): present immediately in a step, else in the next cycle. */',
                        `static void raise_internal(${t} *h, ${t}Event event) {`,
                        '    if (h->in_step) {',
                        '        h->present[event] = true;',
                        '    } else {',
                        '        h->collected[event] = true;',
                        '    }',
                        '}'];
            case 'raise_out':
                return ['/* Raises an out event: sets its flag and notifies the observer. */',
                    `static void raise_out(${t} *h, ${t}Event event) {`,
                    '    h->out_raised[event] = true;',
                    '    if (h->out_event_observer != NULL) {',
                    '        h->out_event_observer(h, event);',
                    '    }',
                    '}'];
        }
    }
}

const HELPER_ORDER: Helper[] = ['int_add', 'int_sub', 'int_mul', 'int_neg', 'int_div', 'int_mod', 'int_shl', 'int_shr',
    'real_to_int', 'real_round', 'str_nonnull', 'str_assign', 'str_concat', 'raise_internal', 'raise_out'];

const C_RESERVED_STATE_NAMES = ['NO_STATE', 'FINAL_STATE'];

const RUNTIME_FUNCTIONS = ['reset_data', 'begin_host_call', 'begin_step', 'microstep', 'clear_present', 'enqueue', 'process', 'drain_queues', 'step'];

const SC_TYPES = `/* Basic types of generated state machines (hsm). */
#ifndef SC_TYPES_H_
#define SC_TYPES_H_

#include <stdint.h>
#include <stdbool.h>

typedef int64_t sc_integer;
typedef double sc_real;
typedef bool sc_boolean;
typedef const char *sc_string;

#endif /* SC_TYPES_H_ */
`;
