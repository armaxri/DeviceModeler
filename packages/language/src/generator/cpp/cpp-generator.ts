import type { AstNode } from 'langium';
import * as ast from '../../generated/ast.js';
import { returnTypeOf, typeOfEvent, typeOfParameter, type HsmType } from '../../hsm-typesystem.js';
import { nodeText } from '../../model-utils.js';
import { describeLocation, SimulationError } from '../../simulation/errors.js';
import type { ExecutionMode, ExecutionOrder } from '../../simulation/interpreter.js';
import type { ModelIndex } from '../../simulation/model-index.js';
import { CBlock, cIdentifier, commentText, cString, indent, stripParens } from '../common/code.js';
import type { Code, Helper } from '../common/expressions.js';
import {
    alignComments, GeneratorError, spaces, StatechartGenerator, type ErrorKind, type GeneratedFunction, type ScopeInfo, type TimerInfo
} from '../common/statechart-generator.js';
import {
    CPP_KEYWORDS, CPP_RESERVED_NAMES, cppDeclaredType, cppDefault, cppParameterType, cppSpelling, cppType, lineComment, RUNTIME_HEADER, RUNTIME_HEADER_CONTENT
} from './cpp-code.js';
import { storageOfTypeReference } from '../../cpp-storage.js';
import { resolvedImports } from '../../imports.js';
import type { CppResolvedType } from '../../cpp-header/model.js';

/** Options of the C++ code generator. */
export interface CppGeneratorOptions {
    /**
     * Namespace of the generated class (`a::b` or `a.b`; empty: the global namespace). Default: the
     * `namespace` of the model.
     */
    namespace?: string;
    /** Name of the generated class and its files (default: the state machine name). */
    className?: string;
    /** Directory prepended to the paths of the generated files (default: none). */
    outDir?: string;
    /** Maximum number of transitions per step and of queued event steps per call (default 1000, like the interpreter). */
    maxMicrosteps?: number;
    /**
     * C++ standard the generated code is written for: 17 (default) or 11. The only difference are
     * nested namespace definitions (`namespace a::b {` in C++17).
     */
    standard?: 11 | 17;
    /**
     * The path in the `#include "..."` of an imported C/C++ header (`import "motor_types.h"`), given
     * the import path and the URI of the header. Default: the import path as written in the model
     * (relative to the model or to an include directory, which the build has to provide).
     */
    headerInclude?: (header: { path: string, uri?: string }) => string | undefined;
}

export interface CppGeneratedFile {
    /** Path of the file (relative, including `outDir`). */
    path: string;
    content: string;
}

export interface CppGeneratorDiagnostic {
    severity: 'error' | 'warning';
    message: string;
    node?: AstNode;
}

/** An interface (or the internal scope) with operations: the callback class the host implements. */
export interface CppOperationScope {
    /** The callback class, relative to the state machine class (`OperationCallback`, `Pedestrian::OperationCallback`, `InternalOperationCallback`). */
    readonly callbackClass: string;
    /** Expression setting the callback on a state machine object `m`, given the callback pointer `cb`. */
    setCallback(machine: string, callback: string): string;
    readonly operations: readonly ast.OperationDeclaration[];
}

/** Names of the generated API, e.g. for test harnesses. */
export interface CppApi {
    /** The class name (`TrafficLight`). */
    readonly className: string;
    /** The namespace (`a::b`, empty: global). */
    readonly namespace: string;
    /** The fully qualified class name (`a::b::TrafficLight`). */
    readonly qualifiedClassName: string;
    /** File name of the header (`TrafficLight.h`). */
    readonly header: string;
    readonly source: string;
    readonly executionMode: ExecutionMode;
    readonly executionOrder: ExecutionOrder;
    /** Cycle period in ms (`@CycleBased(period)`, default 200). */
    readonly cyclePeriod: number;
    readonly index: ModelIndex;
    /** Number of time events (0: the class does not implement `sc::TimedInterface`). */
    readonly timerCount: number;
    /** Name of a struct that tests may define in the namespace of the class to access the internal scope (friend). */
    readonly internalsStruct: string;
    /** Enumerator of a state, relative to the class (`State::Closed_Active_Playing`). */
    state(state: ast.State): string;
    /**
     * Path from the state machine object to the object declaring the API of a declaration of an
     * interface: empty for the unnamed interface, `getPedestrian().` for a named interface.
     */
    interfaceAccess(declaration: ast.Declaration): string;
    /** Method raising an in event (`raise_request`). */
    raise(event: ast.EventDeclaration): string;
    /** Method returning whether an out event was raised in the last call (`isRaised_lightsChanged`). */
    isRaised(event: ast.EventDeclaration): string;
    /** Method returning the value of an out event (`get_lightsChanged_value`). */
    eventValue(event: ast.EventDeclaration): string;
    /** Method returning the observable of an out event (`getLightsChanged`). */
    observable(event: ast.EventDeclaration): string;
    /** Getter of a variable of an interface (`get_waiting`). */
    getter(variable: ast.VariableDeclaration): string;
    /** Setter of a variable of an interface (`undefined` for constants and read-only variables). */
    setter(variable: ast.VariableDeclaration): string | undefined;
    /** Whether a declaration belongs to the internal scope (only accessible through {@link internalsStruct}). */
    isInternal(declaration: ast.Declaration): boolean;
    /** Member expression of a variable of the internal scope, relative to the state machine object (`internal.lights`). */
    internalMember(variable: ast.VariableDeclaration): string;
    /** Type of a variable as seen by the generated code. */
    variableType(variable: ast.VariableDeclaration): HsmType;
    /** The C++ type of a variable, event value, parameter or return value in the generated API (`sc::integer`, `motor::Mode`, `std::uint8_t`). */
    declaredType(declaration: ast.VariableDeclaration | ast.EventDeclaration | ast.Parameter | ast.OperationDeclaration): string;
    /** The scopes with operations. */
    readonly operationScopes: readonly CppOperationScope[];
    /** Parameter list of the callback method of an operation (`sc::integer mask`). */
    operationParameters(operation: ast.OperationDeclaration): string;
    /** Names of the parameters of the callback method of an operation. */
    operationParameterNames(operation: ast.OperationDeclaration): string[];
}

export interface CppGeneratorResult {
    /** `sc_statemachine.h`, `<Class>.h` and `<Class>.cpp`; empty if there are errors. */
    files: CppGeneratedFile[];
    diagnostics: CppGeneratorDiagnostic[];
    api?: CppApi;
}

/**
 * Generates C++ code for a state machine in the spirit of the itemis CREATE C++ generator: a class
 * per state machine (`<Class>.h` / `<Class>.cpp`) implementing docs/semantics.md, plus the shared
 * runtime header `sc_statemachine.h`. Named interfaces are nested classes, operations are called
 * through operation callback interfaces implemented by the host, runtime errors are exceptions
 * (`sc::StatemachineError`) or are passed to an error handler.
 */
export function generateCpp(machine: ast.StateMachine, options: CppGeneratorOptions = {}): CppGeneratorResult {
    try {
        return new CppGenerator(machine, options).generate();
    } catch (error) {
        if (error instanceof GeneratorError || error instanceof SimulationError) {
            return { files: [], diagnostics: [{ severity: 'error', message: error.message, node: error.node }] };
        }
        throw error;
    }
}

/** `sc::ErrorKind` of the error kinds (queues and strings are unbounded in C++: no overflow errors). */
const ERROR_KINDS: Record<ErrorKind, string> = {
    division_by_zero: 'DivisionByZero',
    shift_out_of_range: 'ShiftOutOfRange',
    invalid_conversion: 'InvalidConversion',
    no_enabled_transition: 'NoEnabledTransition',
    no_initial_transition: 'NoInitialTransition',
    invalid_time: 'InvalidTime',
    index_out_of_bounds: 'IndexOutOfBounds',
    loop: 'Loop',
    queue_overflow: 'Loop',
    string_overflow: 'Loop'
};

/** A member function of the class: declaration in the class, definition in the source file. */
interface Member {
    /** Declaration inside the class (`void enter() override;`). */
    declaration: string;
    /** Signature of the definition (`void TrafficLight::enter()`). */
    signature: string;
    comment: string;
    body: CBlock;
    /** A private member of the state machine class (the in events of named interfaces). */
    isPrivate?: boolean;
}

/**
 * The C++ dialect of the {@link StatechartGenerator}: the functions of the state machine are private
 * member functions, the runtime data are private members.
 */
class CppGenerator extends StatechartGenerator {

    private readonly className: string;
    private readonly namespace: string;
    private readonly standard: 11 | 17;
    private readonly outDir?: string;
    /** Named interfaces with the name of their member (`iface_Pedestrian`). */
    private readonly namedScopes: ScopeInfo[] = [];
    private readonly operationParamNames = new Map<ast.Parameter, string>();
    private readonly headerInclude?: CppGeneratorOptions['headerInclude'];

    constructor(machine: ast.StateMachine, options: CppGeneratorOptions) {
        super(machine, options.maxMicrosteps, { keywords: CPP_RESERVED_NAMES, reservedStateNames: [...CPP_KEYWORDS, 'NO_STATE', 'FINAL_STATE'] });
        this.className = options.className ?? machine.name;
        const namespace = options.namespace ?? machine.namespace ?? '';
        this.namespace = namespace.split(/::|\./).filter(part => part).join('::');
        this.standard = options.standard ?? 17;
        this.outDir = options.outDir;
        this.headerInclude = options.headerInclude;
        for (const scope of this.scopes.values()) {
            if (scope.kind === 'named') {
                this.namedScopes.push(scope);
            }
        }
        this.checkNames();
    }

    /** Checks the names that are used as C++ identifiers without prefix. */
    private checkNames(): void {
        const invalid = (name: string) => CPP_KEYWORDS.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
        if (invalid(this.className)) {
            throw new GeneratorError(`'${this.className}' cannot be used as C++ class name`, this.machine);
        }
        for (const part of this.namespace ? this.namespace.split('::') : []) {
            if (invalid(part)) {
                throw new GeneratorError(`'${part}' cannot be used as C++ namespace name`, this.machine);
            }
        }
        for (const scope of this.namedScopes) {
            if (invalid(scope.name!)) {
                throw new GeneratorError(`The interface name '${scope.name}' is a C++ keyword; rename the interface`, this.machine);
            }
        }
        for (const operation of this.operations) {
            if (invalid(operation.name)) {
                throw new GeneratorError(`The operation name '${operation.name}' is a C++ keyword; rename the operation`, operation);
            }
            for (const parameter of operation.parameters) {
                this.operationParamNames.set(parameter, invalid(parameter.name) ? `${cIdentifier(parameter.name)}_` : parameter.name);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Names and hooks of the StatechartGenerator

    protected stateConstant(state: ast.State): string {
        return `State::${this.stateNames.get(state)}`;
    }

    protected get noState(): string {
        return 'State::NO_STATE';
    }

    protected get finalState(): string {
        return 'State::FINAL_STATE';
    }

    protected stateSlot(state: ast.State): string {
        return `slot(${this.stateConstant(state)})`;
    }

    protected get stateType(): string {
        return 'State';
    }

    protected get maxMicrostepsConstant(): string {
        return 'maxMicrosteps';
    }

    protected get runtimeFunctions(): readonly string[] {
        return [...RUNTIME_FUNCTIONS, ...this.operations.map(o => this.operationWrapperName(o))];
    }

    protected timerConstant(timer: TimerInfo): string {
        return `timer_${timer.ownerName}_${timer.index}`;
    }

    protected eventConstant(event: ast.EventDeclaration): string {
        return `event_${this.eventNames.get(event)}`;
    }

    protected errorCall(kind: ErrorKind, message: string, node?: AstNode): string {
        const text = node ? `${message} (${describeLocation(node)})` : message;
        return `${this.reportError()}(sc::ErrorKind::${ERROR_KINDS[kind]}, ${cString(text)});`;
    }

    protected call(fn: string, args?: string): string {
        return `${fn}(${args ?? ''})`;
    }

    protected field(name: string): string {
        return name;
    }

    protected override comment(text: string): string {
        return lineComment(text);
    }

    protected setTimer(timer: TimerInfo, duration: string, periodic: boolean): string {
        return `${this.startTimerFunction()}(${this.timerConstant(timer)}, ${duration}, ${periodic});`;
    }

    protected unsetTimer(timer: TimerInfo): string {
        return `${this.stopTimerFunction()}(${this.timerConstant(timer)});`;
    }

    /** Member holding the variables of a scope (`iface`, `internal`, `iface_Pedestrian`). */
    private scopeMember(scope: ScopeInfo): string {
        return scope.kind === 'internal' ? 'internal' : scope.kind === 'named' ? `iface_${scope.name}` : 'iface';
    }

    /** Suffix of the private functions of a scope: `` (unnamed interface), `Pedestrian_`, `internal_`. */
    private scopeInfix(scope: ScopeInfo): string {
        return scope.kind === 'internal' ? 'internal_' : scope.kind === 'named' ? `${scope.name}_` : '';
    }

    /** Pointer to the operation callback of a scope, as seen from the state machine class. */
    private callbackMember(scope: ScopeInfo): string {
        return scope.kind === 'internal' ? 'internalOperationCallback'
            : scope.kind === 'named' ? `${this.scopeMember(scope)}.operationCallback` : 'operationCallback';
    }

    private observableMember(event: ast.EventDeclaration): string {
        return `${this.eventNames.get(event)}_observable`;
    }

    private hasValue(event: ast.EventDeclaration): boolean {
        const type = typeOfEvent(event);
        return type !== 'void' && type !== 'error';
    }

    // -----------------------------------------------------------------------------------------
    // ExpressionContext

    variable(variable: ast.VariableDeclaration): string {
        return `${this.scopeMember(this.scopeOf(variable))}.${this.variableMembers.get(variable)}`;
    }

    eventValue(event: ast.EventDeclaration): string {
        return `event_value.${this.eventNames.get(event)}`;
    }

    operationCall(operation: ast.OperationDeclaration, args: Code[][]): string {
        const texts = operation.parameters.map((parameter, index) => parameter.varArgs
            ? `{${args[index].map(arg => stripParens(arg.text)).join(', ')}}`
            : stripParens(args[index][0].text));
        return `${this.operationWrapper(operation)}(${texts.join(', ')})`;
    }

    operationResult(_type: HsmType, call: string): string {
        return call;
    }

    override helper(name: Helper): string {
        super.helper(name);
        if (name === 'int_div' || name === 'int_mod' || name === 'int_shl' || name === 'int_shr' || name === 'real_to_int') {
            this.reportError();
        }
        return name;
    }

    raise(event: ast.EventDeclaration, block: CBlock): void {
        if (this.index.eventDirection(event) === 'out') {
            block.add(`out_raised[${this.eventConstant(event)}] = true;`);
            block.add(`${this.observableMember(event)}.next(${this.hasValue(event) ? this.eventValue(event) : ''});`);
        } else {
            block.add(`${this.raiseInternal()}(${this.eventConstant(event)});`);
        }
    }

    withHandle(args: string): string {
        return args;
    }

    typeName(type: HsmType): string {
        return cppType(type);
    }

    toReal(text: string): string {
        return `static_cast<sc::real>(${stripParens(text)})`;
    }

    store(target: string, _type: HsmType, value: string): string {
        return `${target} = ${value};`;
    }

    override storageCast(storage: CppResolvedType | undefined, value: Code): string {
        if (storage?.kind === 'integer' && !(storage.bits === 64 && storage.signed) && !(value.constant && /^\d+$/.test(value.text))) {
            return `static_cast<${cppSpelling(storage)}>(${stripParens(value.text)})`;
        }
        if (storage?.kind === 'real' && storage.bits === 32 && !value.constant) {
            return `static_cast<float>(${stripParens(value.text)})`;
        }
        return value.text;
    }

    override checkedIndex(index: string, length: number, node: AstNode): string {
        const check = this.use('check_index', ['sc::integer index', 'std::size_t size'], 'The index of an element access, checked against the size of the array (0 and an error if it is out of bounds).', body => {
            body.block('if (index < 0 || static_cast<std::size_t>(index) >= size)', [
                `${this.reportError()}(sc::ErrorKind::IndexOutOfBounds, "Index " + std::to_string(index) + " is out of bounds 0.." + std::to_string(static_cast<sc::integer>(size) - 1));`,
                'return 0;'
            ]);
            body.add('return static_cast<std::size_t>(index);');
        }, 'integer');
        void node;
        return `${check}(${index}, ${length})`;
    }

    /** The C++ type of a declaration in the generated code (see {@link CppApi.declaredType}). */
    declaredType(declaration: ast.VariableDeclaration | ast.EventDeclaration | ast.Parameter | ast.OperationDeclaration): string {
        if (ast.isVariableDeclaration(declaration)) {
            return cppDeclaredType(declaration.type, this.variableType(declaration));
        }
        if (ast.isEventDeclaration(declaration)) {
            return cppDeclaredType(declaration.type, typeOfEvent(declaration));
        }
        if (ast.isParameter(declaration)) {
            return cppDeclaredType(declaration.type, typeOfParameter(declaration));
        }
        return declaration.returnType ? cppDeclaredType(declaration.returnType, returnTypeOf(declaration)) : 'void';
    }

    compareStrings(left: Code, right: Code, operator: '==' | '!='): string {
        const leftText = left.constant && right.constant ? `sc::string(${left.text})` : left.text;
        return `(${leftText} ${operator} ${right.text})`;
    }

    concatStrings(left: Code, right: Code): string {
        const leftText = left.constant && right.constant ? `sc::string(${left.text})` : left.text;
        return `(${leftText} + ${right.text})`;
    }

    // -----------------------------------------------------------------------------------------
    // Runtime functions (generated on demand)

    private reportError(): string {
        return this.use('report_error', ['sc::ErrorKind kind', 'const sc::string& message'],
            'Reports a runtime error to the error handler or throws sc::StatemachineError.', body => {
                body.block('if (errorHandler != nullptr)', ['errorHandler->onError(kind, message);', 'return;']);
                body.add('sc::detail::throwError(kind, message);');
            });
    }

    private startTimerFunction(): string {
        return this.use('start_timer', ['sc::eventid event', 'sc::integer durationNs', 'bool periodic'], 'Starts the timer of a time event (timer service).', body => {
            body.block('if (timerService != nullptr)', ['timerService->setTimer(this, event, durationNs, periodic);']);
        });
    }

    private stopTimerFunction(): string {
        return this.use('stop_timer', ['sc::eventid event'], 'Stops the timer of a time event (timer service).', body => {
            body.block('if (timerService != nullptr)', ['timerService->unsetTimer(this, event);']);
        });
    }

    private raiseInternal(): string {
        return this.use('raise_internal', ['EventId event'], this.eventDriven
            ? 'Raises an internal event (or an in event raised by the state machine): queued for its own step.'
            : 'Raises an internal event (or an in event raised by the state machine): present immediately in a step, else in the next cycle.', body => {
            if (this.eventDriven) {
                body.add('internal_queue.push_back(event);');
            } else {
                body.block('if (in_step)', ['present[event] = true;'], '} else {');
                body.lines.push('    collected[event] = true;', '}');
            }
        });
    }

    private resetData(): string {
        return this.use('reset_data', [], 'Sets all variables and event values to the default values of their types.', body => {
            for (const variable of this.index.variables()) {
                body.add(`${this.variable(variable)} = ${this.defaultOf(variable.type, this.variableType(variable))};`);
            }
            for (const event of this.valueEvents) {
                body.add(`${this.eventValue(event)} = ${this.defaultOf(event.type, typeOfEvent(event))};`);
            }
        });
    }

    private beginStep(): string {
        return this.use('begin_step', [], 'Start of a step: no state has been entered or exited yet.', body => {
            body.add('entered.fill(false);', 'exited.fill(false);', 'microsteps = 0;');
        });
    }

    private clearPresent(): string {
        return this.use('clear_present', [], 'Clears the events of a step.', body => {
            if (this.hasEvents) {
                body.add('present.fill(false);');
            }
            if (this.timers.length > 0) {
                body.add('timer_present.fill(false);');
            }
        });
    }

    private step(): string {
        return this.use('step', [], 'A step (docs/semantics.md §4): the reactions of the state machine, then the active states top down.', body => {
            body.add(`${this.call(this.beginStep())};`, 'in_step = true;');
            this.localReactions(this.machine, body);
            this.reactTopLevel(body);
            body.add('in_step = false;');
            if (this.hasEvents || this.timers.length > 0) {
                body.add(`${this.call(this.clearPresent())};`);
            }
        });
    }

    /** Event driven: a queued item is an event (`< EVENT_COUNT`) or a time event (`EVENT_COUNT + timer`). */
    private processQueued(): string {
        return this.use('process', ['int item'], 'Event driven: a step in which only the given event (or time event) is present.', body => {
            body.block(`if (!running || ${this.activeOf(this.machine)} == ${this.finalState})`, ['return;']);
            const index = (text: string) => `static_cast<std::size_t>(${text})`;
            if (this.hasEvents && this.timers.length > 0) {
                body.block('if (item < EVENT_COUNT)', [`present[${index('item')}] = true;`], '} else {');
                body.lines.push(`    timer_present[${index('item - EVENT_COUNT')}] = true;`, '}');
            } else if (this.hasEvents) {
                body.add(`present[${index('item')}] = true;`);
            } else {
                body.add(`timer_present[${index('item')}] = true;`);
            }
            body.add(`${this.call(this.step())};`);
        });
    }

    private drainQueues(): string {
        return this.use('drain_queues', [], 'Event driven: processes the queued internal events, then the in events raised meanwhile by the host.', body => {
            body.add('sc::integer steps = 0;');
            const loop = new CBlock();
            loop.add('int item;');
            loop.block('if (!internal_queue.empty())', ['item = internal_queue.front();', 'internal_queue.pop_front();'], '} else if (!host_queue.empty()) {');
            loop.lines.push('    item = host_queue.front();', '    host_queue.pop_front();', '} else {', '    return;', '}');
            loop.block('if (++steps > maxMicrosteps)', [
                'internal_queue.clear();',
                'host_queue.clear();',
                this.errorCall('loop', `More than ${this.maxMicrosteps} queued event steps; the state machine seems to loop`),
                'return;'
            ]);
            loop.add(`${this.call(this.processQueued(), 'item')};`);
            body.block('for (;;)', loop);
        });
    }

    /** Wrapper calling the operation callback (the default value of the return type if no callback is set). */
    private operationWrapper(operation: ast.OperationDeclaration): string {
        const scope = this.scopeOf(operation);
        const name = this.operationWrapperName(operation);
        const params = operation.parameters.map(p => `${this.parameterType(p)} arg_${this.operationParamNames.get(p)}`);
        const returnType = returnTypeOf(operation);
        return this.use(name, params, `Operation ${this.index.declarationName(operation)}: calls the operation callback.`, body => {
            const callback = this.callbackMember(scope);
            const call = `${callback}->${operation.name}(${operation.parameters.map(p => `arg_${this.operationParamNames.get(p)}`).join(', ')})`;
            if (returnType === 'void') {
                body.block(`if (${callback} != nullptr)`, [`${call};`]);
            } else {
                body.block(`if (${callback} == nullptr)`, [`return ${this.defaultOf(operation.returnType, returnType)};`]);
                body.add(`return ${call};`);
            }
        }, returnType);
    }

    private operationWrapperName(operation: ast.OperationDeclaration): string {
        return `call_${this.scopeInfix(this.scopeOf(operation))}${operation.name}`;
    }

    private parameterType(parameter: ast.Parameter): string {
        const type = typeOfParameter(parameter);
        const spelling = this.declaredType(parameter);
        return parameter.varArgs ? `std::initializer_list<${spelling}>` : cppParameterType(type, spelling);
    }

    /** The default value of a type in the generated code (`motor::Mode{}`, `0`, ...). */
    private defaultOf(reference: ast.TypeReference | undefined, type: HsmType): string {
        const storage = storageOfTypeReference(reference);
        return storage && storage.kind !== 'integer' && storage.kind !== 'real' && storage.kind !== 'boolean' && storage.kind !== 'string'
            ? `${cppDeclaredType(reference, type)}{}` : cppDefault(type);
    }

    private get usesVarArgs(): boolean {
        return this.operations.some(o => o.parameters.some(p => p.varArgs));
    }

    // -----------------------------------------------------------------------------------------
    // Generation

    private get valueEvents(): ast.EventDeclaration[] {
        return this.events.filter(e => this.hasValue(e));
    }

    private get needsQueues(): boolean {
        return this.eventDriven && (this.hasEvents || this.timers.length > 0);
    }

    private get fileBase(): string {
        return this.className;
    }

    generate(): CppGeneratorResult {
        const api = this.createApi();
        const members = this.publicMembers();
        this.flush();
        this.checkDuplicates(members);
        const dir = this.outDir ? this.outDir.replace(/\/+$/, '') + '/' : '';
        return {
            files: [
                { path: `${dir}${RUNTIME_HEADER}`, content: RUNTIME_HEADER_CONTENT },
                { path: `${dir}${this.fileBase}.h`, content: this.header(members) },
                { path: `${dir}${this.fileBase}.cpp`, content: this.source(members) }
            ],
            diagnostics: [],
            api
        };
    }

    private namedScopeOf(declaration: ast.Declaration): ScopeInfo | undefined {
        const scope = this.scopeOf(declaration);
        return scope.kind === 'named' ? scope : undefined;
    }

    private raiseName(event: ast.EventDeclaration): string {
        return `raise_${event.name}`;
    }

    private isRaisedName(event: ast.EventDeclaration): string {
        return `isRaised_${event.name}`;
    }

    private eventValueName(event: ast.EventDeclaration): string {
        return `get_${event.name}_value`;
    }

    private observableName(event: ast.EventDeclaration): string {
        return `get${event.name.charAt(0).toUpperCase()}${event.name.slice(1)}`;
    }

    private getterName(variable: ast.VariableDeclaration): string {
        return `get_${variable.name}`;
    }

    private setterName(variable: ast.VariableDeclaration): string | undefined {
        return variable.const || variable.readonly ? undefined : `set_${variable.name}`;
    }

    private get qualifiedClassName(): string {
        return this.namespace ? `${this.namespace}::${this.className}` : this.className;
    }

    private get internalsStruct(): string {
        return `${this.className}Internals`;
    }

    private operationScopes(): Array<{ scope: ScopeInfo; callbackClass: string; operations: ast.OperationDeclaration[] }> {
        const result: Array<{ scope: ScopeInfo; callbackClass: string; operations: ast.OperationDeclaration[] }> = [];
        for (const scope of this.scopes.values()) {
            const operations = this.operations.filter(o => this.scopeOf(o) === scope);
            if (operations.length > 0) {
                const callbackClass = scope.kind === 'internal' ? 'InternalOperationCallback'
                    : scope.kind === 'named' ? `${scope.name}::OperationCallback` : 'OperationCallback';
                result.push({ scope, callbackClass, operations });
            }
        }
        return result;
    }

    private createApi(): CppApi {
        return {
            className: this.className,
            namespace: this.namespace,
            qualifiedClassName: this.qualifiedClassName,
            header: `${this.fileBase}.h`,
            source: `${this.fileBase}.cpp`,
            executionMode: this.mode,
            executionOrder: this.order,
            cyclePeriod: this.cyclePeriod,
            index: this.index,
            timerCount: this.timers.length,
            internalsStruct: this.internalsStruct,
            state: state => this.stateConstant(state),
            interfaceAccess: declaration => {
                const scope = this.namedScopeOf(declaration);
                return scope ? `get${scope.name}().` : '';
            },
            raise: event => this.raiseName(event),
            isRaised: event => this.isRaisedName(event),
            eventValue: event => this.eventValueName(event),
            observable: event => this.observableName(event),
            getter: variable => this.getterName(variable),
            setter: variable => this.setterName(variable),
            isInternal: declaration => this.scopeOf(declaration).kind === 'internal',
            internalMember: variable => this.variable(variable),
            variableType: variable => this.variableType(variable),
            declaredType: declaration => this.declaredType(declaration),
            operationScopes: this.operationScopes().map(({ scope, callbackClass, operations }) => ({
                callbackClass,
                operations,
                setCallback: (machine: string, callback: string) => scope.kind === 'internal' ? `${machine}.setInternalOperationCallback(${callback})`
                    : scope.kind === 'named' ? `${machine}.get${scope.name}().setOperationCallback(${callback})`
                        : `${machine}.setOperationCallback(${callback})`
            })),
            operationParameters: operation => this.callbackParameters(operation),
            operationParameterNames: operation => operation.parameters.map(p => this.operationParamNames.get(p)!)
        };
    }

    private callbackParameters(operation: ast.OperationDeclaration): string {
        return operation.parameters.map(p => `${this.parameterType(p)} ${this.operationParamNames.get(p)}`).join(', ');
    }

    // ----- public members

    /**
     * The public member functions (and the constructors of the nested interface classes); the key is
     * the class they belong to (`` for the state machine class, the interface name otherwise).
     */
    private publicMembers(): Map<string, Member[]> {
        const c = this.className;
        const result = new Map<string, Member[]>([['', []]]);
        for (const scope of this.namedScopes) {
            result.set(scope.name!, []);
        }
        const add = (owner: string, comment: string, declaration: string, build: (body: CBlock) => void, options: { isPrivate?: boolean; signature?: string } = {}) => {
            this.expressions.resetTemporaries();
            const body = new CBlock();
            build(body);
            const qualified = owner ? `${c}::${owner}::` : `${c}::`;
            const signature = options.signature ?? qualifySignature(declaration, qualified);
            result.get(owner)!.push({ declaration, signature, comment, body, isPrivate: options.isPrivate });
        };
        const hostCall = 'const HostCall call(*this);';
        add('', 'Creates the state machine (not entered yet).', `${c}()`, () => { });
        add('', 'Enters the state machine (docs/semantics.md §8).', 'void enter() override', body => {
            body.block('if (running || busy)', ['return;']);
            body.add(hostCall, `${this.call(this.resetData())};`, 'active.fill(State::NO_STATE);');
            if (this.historyRegions.size > 0) {
                body.add('history.fill(State::NO_STATE);');
            }
            this.clearEventFlags(body);
            body.add('running = true;');
            const variables = this.index.variables().filter(v => v.initialValue);
            if (variables.length > 0) {
                body.add(this.comment('variables and constants in declaration order'));
                for (const variable of variables) {
                    const type = this.variableType(variable);
                    const value = this.expressions.value(variable.initialValue!, type, body);
                    this.expressions.store(this.variable(variable), type, this.storageCast(storageOfTypeReference(variable.type), value), body);
                }
            }
            body.add(`${this.call(this.beginStep())};`);
            this.builtinReactions(this.machine, 'entry', body);
            for (const trigger of this.index.timeTriggers(this.machine)) {
                this.startTimer(trigger, body);
            }
            body.add(`${this.call(this.regionEnter(this.machine))};`);
            if (this.eventDriven) {
                body.add(this.comment('event driven: a step without events'), `${this.call(this.step())};`);
                if (this.needsQueues) {
                    body.add(`${this.call(this.drainQueues())};`);
                }
            }
        });
        add('', 'Exits the state machine.', 'void exit() override', body => {
            body.block('if (!running || busy)', ['return;']);
            body.add(hostCall, `${this.call(this.beginStep())};`);
            this.exitScope(this.machine, body);
            this.builtinReactions(this.machine, 'exit', body);
            body.add('running = false;');
            for (const trigger of this.index.timeTriggers(this.machine)) {
                this.stopTimer(trigger, body);
            }
        });
        add('', this.eventDriven ? 'Performs a step without events.' : 'Performs a run cycle (docs/semantics.md §3).', 'void runCycle() override', body => {
            body.block('if (!running || busy)', ['return;']);
            body.add(hostCall);
            if (this.eventDriven) {
                body.block(`if (${this.activeOf(this.machine)} != ${this.finalState})`, [`${this.call(this.step())};`]);
                if (this.needsQueues) {
                    body.add(`${this.call(this.drainQueues())};`);
                }
            } else {
                const final = this.hasEvents ? [this.comment('final: events are discarded'), 'collected.fill(false);'] : [this.comment('final')];
                body.block(`if (${this.activeOf(this.machine)} == ${this.finalState})`, [...final, 'return;']);
                if (this.hasEvents) {
                    body.add('present = collected;', 'collected.fill(false);');
                }
                if (this.timers.length > 0) {
                    body.add('timer_present = timer_pending;', 'timer_pending.fill(false);');
                }
                body.add(`${this.call(this.step())};`);
            }
        });
        add('', 'Whether the state machine is running.', 'bool isActive() const override', body => {
            body.add('return running;');
        });
        add('', 'Whether the state machine is final.', 'bool isFinal() const override', body => {
            body.add(`return ${this.activeOf(this.machine)} == ${this.finalState};`);
        });
        add('', 'Whether a state is active.', 'bool isStateActive(State state) const', body => {
            const cases = new CBlock();
            for (const state of this.index.states) {
                cases.add(`case ${this.stateConstant(state)}:`, `    return ${this.activeOf(this.index.regionOf(state))} == ${this.stateConstant(state)};`);
            }
            cases.add('default:', '    return false;');
            body.block('switch (state)', cases);
        });
        add('', 'Sets the handler of runtime errors (nullptr: errors are thrown as sc::StatemachineError).', 'void setErrorHandler(sc::ErrorHandler* handler)', body => {
            body.add('errorHandler = handler;');
        });
        if (this.timers.length > 0) {
            add('', 'Sets the timer service (required for time events).', 'void setTimerService(sc::TimerServiceInterface* service) override', body => {
                body.add('timerService = service;');
            });
            add('', 'The timer service.', 'sc::TimerServiceInterface* getTimerService() override', body => {
                body.add('return timerService;');
            });
            add('', 'Number of time events.', 'sc::integer getNumberOfParallelTimeEvents() const override', body => {
                body.add('return TIMER_COUNT;');
            });
            add('', 'Raises a time event (called by the timer service).', 'void raiseTimeEvent(sc::eventid event) override', body => {
                body.block('if (event < 0 || event >= TIMER_COUNT)', ['return;']);
                if (this.eventDriven) {
                    const item = this.hasEvents ? 'EVENT_COUNT + event' : 'event';
                    body.block('if (!running)', ['return;']);
                    body.block('if (busy)', [`host_queue.push_back(${item});`, 'return;']);
                    body.add(hostCall, `${this.call(this.processQueued(), item)};`, `${this.call(this.drainQueues())};`);
                } else {
                    body.add('timer_pending[static_cast<std::size_t>(event)] = true;');
                }
            });
        }
        // interfaces
        for (const event of this.inEvents) {
            const scope = this.namedScopeOf(event);
            const type = typeOfEvent(event);
            const param = this.hasValue(event) ? `${cppParameterType(type, this.declaredType(event))} value` : '';
            const raise = (body: CBlock) => {
                if (this.eventDriven) {
                    body.block('if (!running)', ['return;']);
                }
                if (this.hasValue(event)) {
                    body.add(`${this.eventValue(event)} = value;`);
                }
                if (this.eventDriven) {
                    body.block('if (busy)', [`host_queue.push_back(${this.eventConstant(event)});`, 'return;']);
                    body.add(hostCall, `${this.call(this.processQueued(), this.eventConstant(event))};`, `${this.call(this.drainQueues())};`);
                } else {
                    body.add(`collected[${this.eventConstant(event)}] = true;`);
                }
            };
            const comment = `Raises the in event ${this.index.declarationName(event)}.`;
            if (scope) {
                const inner = `in_${this.eventNames.get(event)}`;
                add('', comment, `void ${inner}(${param})`, raise, { isPrivate: true });
                add(scope.name!, comment, `void ${this.raiseName(event)}(${param})`, body => {
                    body.add(`machine.${inner}(${param ? 'value' : ''});`);
                });
            } else {
                add('', comment, `void ${this.raiseName(event)}(${param})`, raise);
            }
        }
        for (const event of this.outEvents) {
            const scope = this.namedScopeOf(event);
            const owner = scope ? scope.name! : '';
            const machine = scope ? 'machine.' : '';
            const name = this.index.declarationName(event);
            add(owner, `Whether the out event ${name} was raised during the last call of enter, exit, runCycle, raiseTimeEvent or (event driven) raise.`,
                `bool ${this.isRaisedName(event)}() const`, body => {
                    body.add(`return ${machine}out_raised[${this.eventConstant(event)}];`);
                });
            if (this.hasValue(event)) {
                add(owner, `Value of the last occurrence of the out event ${name}.`, `${this.declaredType(event)} ${this.eventValueName(event)}() const`, body => {
                    body.add(`return ${machine}${this.eventValue(event)};`);
                });
            }
            add(owner, `Observable of the out event ${name}: observers are notified when the event is raised.`,
                `sc::rx::Observable<${this.hasValue(event) ? this.declaredType(event) : 'void'}>& ${this.observableName(event)}()`, body => {
                    body.add(`return ${machine}${this.observableMember(event)};`);
                });
        }
        for (const variable of this.index.variables()) {
            const scope = this.scopeOf(variable);
            if (scope.kind === 'internal') {
                continue;
            }
            const owner = scope.kind === 'named' ? scope.name! : '';
            const member = owner ? this.variableMembers.get(variable)! : this.variable(variable);
            const type = this.variableType(variable);
            const kind = variable.const ? 'constant' : variable.readonly ? 'read-only variable' : 'variable';
            const name = this.index.declarationName(variable);
            add(owner, `Value of the ${kind} ${name}.`, `${this.declaredType(variable)} ${this.getterName(variable)}() const`, body => {
                body.add(`return ${member};`);
            });
            const setter = this.setterName(variable);
            if (setter) {
                add(owner, `Sets the variable ${name}.`, `void ${setter}(${cppParameterType(type, this.declaredType(variable))} value)`, body => {
                    body.add(`${member} = value;`);
                });
            }
        }
        for (const { scope, callbackClass } of this.operationScopes()) {
            if (scope.kind === 'named') {
                add(scope.name!, `Sets the implementation of the operations of interface ${scope.name}.`, 'void setOperationCallback(OperationCallback* callback)', body => {
                    body.add('operationCallback = callback;');
                });
            } else {
                const setter = scope.kind === 'internal' ? 'setInternalOperationCallback' : 'setOperationCallback';
                add('', `Sets the implementation of the operations of the ${scope.kind === 'internal' ? 'internal scope' : 'interface'}.`,
                    `void ${setter}(${callbackClass}* callback)`, body => {
                        body.add(`${this.callbackMember(scope)} = callback;`);
                    });
            }
        }
        for (const scope of this.namedScopes) {
            add('', `The interface ${scope.name}.`, `${scope.name}& get${scope.name}()`, body => {
                body.add(`return ${this.scopeMember(scope)};`);
            }, { signature: `${c}::${scope.name}& ${c}::get${scope.name}()` });
        }
        return result;
    }

    private clearEventFlags(body: CBlock): void {
        if (this.hasEvents) {
            body.add('present.fill(false);');
            if (!this.eventDriven) {
                body.add('collected.fill(false);');
            }
        }
        if (this.timers.length > 0) {
            body.add('timer_pending.fill(false);', 'timer_present.fill(false);');
        }
        if (this.needsQueues) {
            body.add('internal_queue.clear();', 'host_queue.clear();');
        }
    }

    /** Named interfaces that need access to the state machine (events). */
    private needsMachine(scope: ScopeInfo): boolean {
        return this.events.some(e => this.scopeOf(e) === scope);
    }

    /** Checks that the member names of the class are unique (e.g. an interface `State`). */
    private checkDuplicates(members: Map<string, Member[]>): void {
        const names = [
            this.className, 'State', 'OperationCallback', 'InternalOperationCallback', 'HostCall', 'Region', 'EventId', 'TimerId',
            ...this.namedScopes.map(s => s.name!),
            ...[...this.functions.keys()],
            ...members.get('')!.map(m => /\b(\w+)\(/.exec(m.declaration)?.[1] ?? '').filter(name => name && name !== this.className),
            ...this.outEvents.map(e => this.observableMember(e)),
            ...this.namedScopes.map(s => this.scopeMember(s)),
            ...HELPER_ORDER
        ];
        const seen = new Set<string>();
        for (const name of names) {
            if (seen.has(name) || RESERVED_MEMBERS.includes(name)) {
                throw new GeneratorError(`The generated C++ identifier '${name}' is not unique; rename a state, event, variable, operation or interface`, this.machine);
            }
            seen.add(name);
        }
        for (const [owner, list] of members) {
            if (!owner) {
                continue;
            }
            const local = new Set<string>(['OperationCallback', 'machine', 'operationCallback']);
            for (const member of list) {
                const name = /\b(\w+)\(/.exec(member.declaration)?.[1] ?? '';
                if (local.has(name)) {
                    throw new GeneratorError(`The generated C++ identifier '${owner}::${name}' is not unique; rename an event or variable of interface ${owner}`, this.machine);
                }
                local.add(name);
            }
        }
    }

    // ----- header

    /** The `#include` paths of the imported C/C++ headers (see {@link CppGeneratorOptions.headerInclude}). */
    private importedHeaders(): string[] {
        const result: string[] = [];
        for (const imported of resolvedImports(this.machine)) {
            if (imported.kind === 'header') {
                const path = this.headerInclude?.({ path: imported.path, uri: imported.uri?.toString() }) ?? imported.path;
                if (!result.includes(path)) {
                    result.push(path);
                }
            }
        }
        return result;
    }

    private header(members: Map<string, Member[]>): string {
        const c = this.className;
        const guard = `${[...this.namespace.split('::').filter(p => p), c].join('_').toUpperCase()}_H_`;
        const lines: string[] = [
            `// Generated by hsm from state machine '${this.machine.name}' - do not edit.`,
            `#ifndef ${guard}`,
            `#define ${guard}`,
            '',
            '#include <array>',
            '#include <cstddef>'
        ];
        if (this.needsQueues) {
            lines.push('#include <deque>');
        }
        if (this.usesVarArgs) {
            lines.push('#include <initializer_list>');
        }
        lines.push('', `#include "${RUNTIME_HEADER}"`, '');
        const headers = this.importedHeaders();
        if (headers.length > 0) {
            lines.push(this.comment('imported C/C++ headers (types and constants used by the state machine)'), ...headers.map(h => `#include "${h}"`), '');
        }
        lines.push(...this.namespaceOpen());
        const bases = ['public sc::StatemachineInterface'];
        if (this.timers.length > 0) {
            bases.push('public sc::TimedInterface');
        }
        const usage = this.eventDriven
            ? ' * then raise in events: each event is processed immediately (run-to-completion step).'
            : ` * then raise in events and call runCycle() periodically (every ${this.cyclePeriod} ms).`;
        lines.push(
            '/**',
            ` * State machine ${this.machine.name}${this.machine.description ? ` - ${commentText(this.machine.description)}` : ''}`,
            ` * Execution: ${this.eventDriven ? 'event driven (@EventDriven)' : `cycle based (@CycleBased(${this.cyclePeriod}))`}, ${this.order}.`,
            ' *',
            ` * Usage: create an instance, ${this.timers.length > 0 ? 'set the timer service (setTimerService), ' : ''}set the operation callbacks, call enter(),`,
            usage,
            ' * Runtime errors are thrown as sc::StatemachineError unless an error handler is set (setErrorHandler).',
            ` * Not thread-safe: call the member functions from one thread (or synchronize the calls).`,
            ' */',
            `class ${c} : ${bases.join(', ')} {`,
            'public:'
        );
        const pub: string[] = [];
        if (!this.eventDriven) {
            pub.push('/** Cycle period in ms (@CycleBased): call runCycle() at this period. */', `static constexpr sc::integer cyclePeriodMs = ${this.cyclePeriod};`, '');
        }
        pub.push('/** States (FINAL_STATE: the final state of a region is active). */', 'enum class State {', `    NO_STATE,`);
        for (const state of this.index.states) {
            pub.push(`    ${this.stateNames.get(state)},${spaces()}${lineComment(commentText(this.stateName(state)))}`);
        }
        pub.push('    FINAL_STATE', '};', '');
        for (const { scope, operations } of this.operationScopes()) {
            if (scope.kind !== 'named') {
                pub.push(...this.callbackClass(scope.kind === 'internal' ? 'InternalOperationCallback' : 'OperationCallback',
                    scope.kind === 'internal' ? 'the internal scope' : 'the interface', operations), '');
            }
        }
        for (const scope of this.namedScopes) {
            pub.push(...this.interfaceClass(scope, members.get(scope.name!)!), '');
        }
        const [constructor, ...others] = members.get('')!;
        pub.push(`/** ${constructor.comment} */`, `${constructor.declaration};`, `${c}(const ${c}&) = delete;`, `${c}& operator=(const ${c}&) = delete;`, '');
        for (const member of others.filter(m => !m.isPrivate)) {
            pub.push(`/** ${member.comment} */`, `${member.declaration};`);
        }
        lines.push(...indent(pub), '', 'private:');
        lines.push(...indent(this.privateSection(members)));
        lines.push('};', '');
        if (this.namespace) {
            lines.push(...this.namespaceClose(), '');
        }
        lines.push(`#endif // ${guard}`, '');
        return alignComments(lines).join('\n');
    }

    private callbackClass(name: string, what: string, operations: ast.OperationDeclaration[]): string[] {
        const lines = [`/** Operations of ${what}, implemented by the host (setOperationCallback). */`, `class ${name} {`, 'public:', `    virtual ~${name}() = default;`];
        for (const operation of operations) {
            lines.push(`    ${lineComment(commentText(nodeText(operation)))}`);
            lines.push(`    virtual ${this.declaredType(operation)} ${operation.name}(${this.callbackParameters(operation)}) = 0;`);
        }
        lines.push('};');
        if (name === 'InternalOperationCallback') {
            lines[0] = `/** Operations of ${what}, implemented by the host (setInternalOperationCallback). */`;
        }
        return lines;
    }

    private interfaceClass(scope: ScopeInfo, members: Member[]): string[] {
        const name = scope.name!;
        const lines = [`/** Interface ${name} (get${name}()). */`, `class ${name} {`, 'public:'];
        const inner: string[] = [];
        const operations = this.operations.filter(o => this.scopeOf(o) === scope);
        if (operations.length > 0) {
            inner.push(...this.callbackClass('OperationCallback', `interface ${name}`, operations), '');
        }
        inner.push(`${name}(const ${name}&) = delete;`, `${name}& operator=(const ${name}&) = delete;`, '');
        for (const member of members) {
            inner.push(`/** ${member.comment} */`, `${member.declaration};`);
        }
        lines.push(...indent(inner), '', 'private:');
        const priv: string[] = [`friend class ${this.className};`, `friend struct ${this.internalsStruct};`, ''];
        if (this.needsMachine(scope)) {
            priv.push(`explicit ${name}(${this.className}& owner);`, '', `${this.className}& machine;`);
        } else {
            priv.push(`${name}() = default;`);
        }
        for (const [variable, member] of this.variableMembers) {
            if (this.scopeOf(variable) === scope) {
                const type = this.variableType(variable);
                priv.push(`${this.declaredType(variable)} ${member}${type === 'string' ? '' : ` = ${this.defaultOf(variable.type, type)}`};`);
            }
        }
        if (operations.length > 0) {
            priv.push('OperationCallback* operationCallback = nullptr;');
        }
        lines.push(...indent(priv), '};');
        return lines;
    }

    private privateSection(members: Map<string, Member[]>): string[] {
        const lines: string[] = [];
        lines.push(`/** Tests may define this struct to access the internal scope. */`, `friend struct ${this.internalsStruct};`, '');
        lines.push(`static constexpr sc::integer maxMicrosteps = ${this.maxMicrosteps};`, `static constexpr std::size_t STATE_COUNT = ${this.index.states.length + 2};`, '');
        lines.push('/** Regions: index into active and history. */', 'enum Region {');
        for (const region of this.regions) {
            lines.push(`    ${this.regionId(region)},${spaces()}${lineComment(commentText(this.regionLabel(region)))}`);
        }
        lines.push('    REGION_COUNT', '};', '');
        if (this.hasEvents) {
            lines.push('/** Events: index into present, collected and out_raised. */', 'enum EventId {');
            for (const event of this.events) {
                lines.push(`    ${this.eventConstant(event)},${spaces()}${lineComment(`${this.index.eventDirection(event)} event ${this.index.declarationName(event)}`)}`);
            }
            lines.push('    EVENT_COUNT', '};', '');
        }
        if (this.timers.length > 0) {
            lines.push('/** Time events (ids for the timer service). */', 'enum TimerId : sc::eventid {');
            for (const timer of this.timers) {
                const owner = ast.isStateMachine(timer.owner) ? 'state machine' : this.stateName(timer.owner);
                lines.push(`    ${this.timerConstant(timer)},${spaces()}${lineComment(`${commentText(nodeText(timer.trigger))} (${owner})`)}`);
            }
            lines.push('    TIMER_COUNT', '};', '');
        }
        lines.push(
            '/** Marks a call of the host that executes the state machine; resets the flags if a step is aborted by an exception. */',
            'class HostCall {',
            'public:',
            `    explicit HostCall(${this.className}& owner);`,
            '    ~HostCall();',
            '    HostCall(const HostCall&) = delete;',
            '    HostCall& operator=(const HostCall&) = delete;',
            '',
            'private:',
            `    ${this.className}& machine;`,
            '};',
            '',
            'static constexpr std::size_t slot(State state) {',
            '    return static_cast<std::size_t>(state);',
            '}',
            ''
        );
        // data
        lines.push('bool running = false;', 'bool busy = false;', 'bool in_step = false;', 'sc::integer microsteps = 0;');
        lines.push('std::array<State, REGION_COUNT> active{};');
        if (this.historyRegions.size > 0) {
            lines.push('std::array<State, REGION_COUNT> history{};');
        }
        lines.push('std::array<bool, STATE_COUNT> entered{};', 'std::array<bool, STATE_COUNT> exited{};');
        if (this.hasEvents) {
            lines.push('std::array<bool, EVENT_COUNT> present{};');
            if (!this.eventDriven) {
                lines.push('std::array<bool, EVENT_COUNT> collected{};');
            }
            if (this.outEvents.length > 0) {
                lines.push('std::array<bool, EVENT_COUNT> out_raised{};');
            }
        }
        if (this.timers.length > 0) {
            lines.push('std::array<bool, TIMER_COUNT> timer_pending{};', 'std::array<bool, TIMER_COUNT> timer_present{};');
            lines.push('sc::TimerServiceInterface* timerService = nullptr;');
        }
        if (this.needsQueues) {
            lines.push('std::deque<int> internal_queue;', 'std::deque<int> host_queue;');
        }
        lines.push('sc::ErrorHandler* errorHandler = nullptr;');
        for (const { scope } of this.operationScopes()) {
            if (scope.kind === 'default') {
                lines.push('OperationCallback* operationCallback = nullptr;');
            } else if (scope.kind === 'internal') {
                lines.push('InternalOperationCallback* internalOperationCallback = nullptr;');
            }
        }
        for (const scope of this.scopes.values()) {
            if (scope.kind === 'named') {
                lines.push(`${scope.name} ${this.scopeMember(scope)}${this.needsMachine(scope) ? '{*this}' : ''};`);
                continue;
            }
            const variables = [...this.variableMembers].filter(([v]) => this.scopeOf(v) === scope);
            if (variables.length === 0) {
                continue;
            }
            lines.push('struct {');
            for (const [variable, member] of variables) {
                const type = this.variableType(variable);
                lines.push(`    ${this.declaredType(variable)} ${member}${type === 'string' ? '' : ` = ${this.defaultOf(variable.type, type)}`};`);
            }
            lines.push(`} ${this.scopeMember(scope)};`);
        }
        if (this.valueEvents.length > 0) {
            lines.push('struct {');
            for (const event of this.valueEvents) {
                const type = typeOfEvent(event);
                lines.push(`    ${this.declaredType(event)} ${this.eventNames.get(event)}${type === 'string' ? '' : ` = ${this.defaultOf(event.type, type)}`};`);
            }
            lines.push('} event_value;');
        }
        for (const event of this.outEvents) {
            lines.push(`sc::rx::Observable<${this.hasValue(event) ? this.declaredType(event) : 'void'}> ${this.observableMember(event)};`);
        }
        lines.push('');
        const internals = members.get('')!.filter(m => m.isPrivate);
        if (internals.length > 0) {
            lines.push('// in events of named interfaces');
            for (const member of internals) {
                lines.push(`${member.declaration};`);
            }
        }
        const helpers = HELPER_ORDER.filter(h => this.helpers.has(h));
        if (helpers.length > 0) {
            lines.push('// runtime helpers');
            for (const helper of helpers) {
                lines.push(`${helperDeclaration(helper)};`);
            }
        }
        lines.push('// runtime and state machine');
        for (const fn of this.sortedFunctions()) {
            lines.push(`${this.functionDeclaration(fn)};`);
        }
        return lines;
    }

    private functionDeclaration(fn: GeneratedFunction): string {
        return `${this.functionReturnType(fn)} ${fn.name}(${fn.params.join(', ')})`;
    }

    private functionReturnType(fn: GeneratedFunction): string {
        if (fn.name === 'check_index') {
            return 'std::size_t';
        }
        return fn.returnType === 'void' ? 'void' : fn.returnType === 'boolean' ? 'bool' : cppType(fn.returnType as HsmType);
    }

    private namespaceOpen(): string[] {
        if (!this.namespace) {
            return [];
        }
        if (this.standard === 11) {
            return [this.namespace.split('::').map(part => `namespace ${part} {`).join(' '), ''];
        }
        return [`namespace ${this.namespace} {`, ''];
    }

    private namespaceClose(): string[] {
        if (!this.namespace) {
            return [];
        }
        if (this.standard === 11) {
            return [`${this.namespace.split('::').map(() => '}').join(' ')} // namespace ${this.namespace}`];
        }
        return [`} // namespace ${this.namespace}`];
    }

    // ----- source

    private source(members: Map<string, Member[]>): string {
        const c = this.className;
        const lines: string[] = [`// Generated by hsm from state machine '${this.machine.name}' - do not edit.`, `#include "${this.fileBase}.h"`];
        const includes = new Set<string>();
        if (this.helpers.has('real_to_int')) {
            includes.add('<cmath>');
        }
        if (this.helpers.has('real_round')) {
            includes.add('<limits>');
        }
        if (this.helpers.has('int_shl') || this.helpers.has('int_shr') || this.helpers.has('real_to_int')) {
            includes.add('<string>');
        }
        if (includes.size > 0) {
            lines.push('', ...[...includes].sort().map(i => `#include ${i}`));
        }
        lines.push('', ...this.namespaceOpen());
        const define = (comment: string, signature: string, body: string[], init = '') => {
            lines.push(lineComment(comment), `${signature}${init} {`, ...indent(body), '}', '');
        };
        // construction
        const initializers = this.namedScopes.filter(s => this.needsMachine(s));
        for (const member of members.get('')!) {
            if (member.declaration === `${c}()`) {
                define(member.comment, member.signature, member.body.lines);
            }
        }
        for (const scope of initializers) {
            define(`Creates the interface ${scope.name}.`, `${c}::${scope.name}::${scope.name}(${c}& owner)`, [], ' : machine(owner)');
        }
        define('Start of a call of the host: clears the out events, marks the state machine busy.', `${c}::HostCall::HostCall(${c}& owner)`,
            [...(this.outEvents.length > 0 ? ['machine.out_raised.fill(false);'] : []), 'machine.busy = true;'], ' : machine(owner)');
        define('End of a call of the host (also if a step was aborted by an exception).', `${c}::HostCall::~HostCall()`, [
            'machine.busy = false;',
            'machine.in_step = false;',
            ...(this.hasEvents ? ['machine.present.fill(false);'] : []),
            ...(this.timers.length > 0 ? ['machine.timer_present.fill(false);'] : [])
        ]);
        lines.push(lineComment('---- API ----'), '');
        for (const [owner, list] of members) {
            for (const member of list) {
                if (!owner && member.declaration === `${c}()`) {
                    continue;
                }
                define(member.comment, member.signature, member.body.lines);
            }
        }
        const helpers = HELPER_ORDER.filter(h => this.helpers.has(h));
        if (helpers.length > 0) {
            lines.push(lineComment('---- Runtime helpers ----'), '');
            for (const helper of helpers) {
                lines.push(...this.helperSource(helper), '');
            }
        }
        lines.push(lineComment('---- State machine ----'), '');
        for (const fn of this.sortedFunctions()) {
            define(fn.comment, `${this.functionReturnType(fn)} ${c}::${fn.name}(${fn.params.join(', ')})`, fn.body.lines);
        }
        lines.push(...this.namespaceClose(), '');
        while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') {
            lines.pop();
        }
        return lines.join('\n');
    }

    private helperSource(helper: Helper): string[] {
        const c = this.className;
        const signature = `${helperDeclaration(helper).replace(/^static /, '').replace(/^(\S+) /, `$1 ${c}::`)}`;
        const fn = (comment: string | undefined, body: string[]) => [...(comment ? [lineComment(comment)] : []), `${signature} {`, ...indent(body), '}'];
        const u64 = (text: string) => `static_cast<std::uint64_t>(${text})`;
        switch (helper) {
            case 'int_add':
                return fn('Integer arithmetic wraps around (two\'s complement) like in the interpreter.', [`return static_cast<sc::integer>(${u64('a')} + ${u64('b')});`]);
            case 'int_sub':
                return fn(undefined, [`return static_cast<sc::integer>(${u64('a')} - ${u64('b')});`]);
            case 'int_mul':
                return fn(undefined, [`return static_cast<sc::integer>(${u64('a')} * ${u64('b')});`]);
            case 'int_neg':
                return fn(undefined, [`return static_cast<sc::integer>(${u64('0')} - ${u64('a')});`]);
            case 'int_div':
                return fn('Integer division truncates toward zero; division by zero is a runtime error.', [
                    'if (b == 0) {',
                    `    ${this.errorCall('division_by_zero', 'Division by zero')}`,
                    '    return 0;',
                    '}',
                    'return b == -1 ? int_neg(a) : a / b;'
                ]);
            case 'int_mod':
                return fn(undefined, [
                    'if (b == 0) {',
                    `    ${this.errorCall('division_by_zero', 'Division by zero')}`,
                    '    return 0;',
                    '}',
                    'return b == -1 ? 0 : a % b;'
                ]);
            case 'int_shl':
                return fn(undefined, [
                    'if (b < 0 || b > 63) {',
                    `    ${this.reportError()}(sc::ErrorKind::ShiftOutOfRange, "Shift amount " + std::to_string(b) + " is out of range 0..63");`,
                    '    return 0;',
                    '}',
                    `return static_cast<sc::integer>(${u64('a')} << b);`
                ]);
            case 'int_shr':
                return fn('Arithmetic shift right.', [
                    'if (b < 0 || b > 63) {',
                    `    ${this.reportError()}(sc::ErrorKind::ShiftOutOfRange, "Shift amount " + std::to_string(b) + " is out of range 0..63");`,
                    '    return 0;',
                    '}',
                    'return a >= 0 ? a >> b : ~(~a >> b);'
                ]);
            case 'real_to_int':
                return fn('Conversion real -> integer: truncates toward zero, wraps around outside of the 64-bit range.', [
                    'const sc::real two64 = 18446744073709551616.0;',
                    'if (!std::isfinite(x)) {',
                    `    ${this.reportError()}(sc::ErrorKind::InvalidConversion, std::string("Cannot convert ") + (std::isnan(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity") + " to integer");`,
                    '    return 0;',
                    '}',
                    'if (x >= -9223372036854775808.0 && x < 9223372036854775808.0) {',
                    '    return static_cast<sc::integer>(x);',
                    '}',
                    'const sc::real q = x / two64;',
                    'if (q <= -9223372036854775808.0 || q >= 9223372036854775808.0) {',
                    '    return 0;',
                    '}',
                    'sc::real r = x - static_cast<sc::real>(static_cast<sc::integer>(q)) * two64;',
                    'if (r < 0) {',
                    '    r += two64;',
                    '}',
                    `return static_cast<sc::integer>(static_cast<std::uint64_t>(r));`
                ]);
            case 'real_round':
                return fn('Rounds to the nearest integer, halves up (like Math.round).', [
                    'const sc::real y = x + 0.5;',
                    'if (!(y > -9223372036854775808.0 && y < 9223372036854775808.0)) {',
                    '    return y > 0 ? std::numeric_limits<sc::integer>::max() : 0;',
                    '}',
                    'const sc::integer n = static_cast<sc::integer>(y);',
                    'return static_cast<sc::real>(n) > y ? n - 1 : n;'
                ]);
            default:
                throw new GeneratorError(`Unexpected helper ${helper}`);
        }
    }
}

const HELPER_ORDER: Helper[] = ['int_add', 'int_sub', 'int_mul', 'int_neg', 'int_div', 'int_mod', 'int_shl', 'int_shr', 'real_to_int', 'real_round'];

/** Declarations of the helpers in the class (static if they do not report errors). */
function helperDeclaration(helper: Helper): string {
    switch (helper) {
        case 'int_neg': return 'static sc::integer int_neg(sc::integer a)';
        case 'int_add': case 'int_sub': case 'int_mul': return `static sc::integer ${helper}(sc::integer a, sc::integer b)`;
        case 'int_div': case 'int_mod': case 'int_shl': case 'int_shr': return `sc::integer ${helper}(sc::integer a, sc::integer b)`;
        case 'real_to_int': return 'sc::integer real_to_int(sc::real x)';
        case 'real_round': return 'static sc::integer real_round(sc::real x)';
        default: return helper;
    }
}

/** Names of the data members of the class (generated names must not clash with them). */
const RESERVED_MEMBERS = ['running', 'busy', 'in_step', 'microsteps', 'active', 'history', 'entered', 'exited', 'present', 'collected',
    'out_raised', 'timer_pending', 'timer_present', 'timerService', 'internal_queue', 'host_queue', 'errorHandler', 'operationCallback',
    'internalOperationCallback', 'iface', 'internal', 'event_value', 'maxMicrosteps', 'STATE_COUNT', 'slot', 'cyclePeriodMs'];

const RUNTIME_FUNCTIONS = ['report_error', 'reset_data', 'begin_step', 'microstep', 'clear_present', 'raise_internal', 'start_timer', 'stop_timer',
    'process', 'drain_queues', 'step'];

/** `void enter() override` -> `void TrafficLight::enter()` (qualified name, without `override` / `const` kept). */
function qualifySignature(declaration: string, qualifier: string): string {
    const withoutOverride = declaration.replace(/ override$/, '');
    const match = /^(.*?)(\b\w+\(.*)$/.exec(withoutOverride);
    if (!match) {
        return qualifier + withoutOverride;
    }
    return `${match[1]}${qualifier}${match[2]}`;
}
