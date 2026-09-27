import { AstUtils, type AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { instanceMachine, referableName } from '../imports.js';
import { entryPointOf, transitionLabel, nodeText } from '../model-utils.js';
import type { EventDirection } from '../hsm-typesystem.js';
import { SimulationError } from './errors.js';
import { ExpressionEvaluator, type EvaluationContext } from './expressions.js';
import {
    isFinalState, ModelIndex, type ActiveVertex, type FinalState, type RegionNode, type TargetVertex
} from './model-index.js';
import {
    convert, defaultValueOf, formatCall, formatValue, fromHost, toHost, declaredType, runtimeTypeOfValue, type HostValue, type RuntimeType, type Value
} from './values.js';

/** Implementation of an operation provided by the host. Arguments are given in parameter order (varargs flattened). */
export type OperationImplementation = (...args: HostValue[]) => unknown;

/** An out event raised by the state machine. */
export interface OutEvent {
    /** Declared name (`alarm`, `Iface.alarm`). */
    readonly name: string;
    /** Value of the event, if it was raised with a value. */
    readonly value?: HostValue;
    /** Canonical text: `alarm` or `led(1)` (see {@link formatCall}). */
    readonly text: string;
}

/** One entry of the execution trace. Entries reference AST nodes so that a UI can highlight them. */
export type TraceEntry =
    /** Start of a step (cycle based: of a run cycle) with the present events and time events. */
    | { readonly kind: 'step'; readonly time: number; readonly events: readonly string[] }
    | { readonly kind: 'enter'; readonly state: string; readonly node: ast.State }
    | { readonly kind: 'exit'; readonly state: string; readonly node: ast.State }
    /** The final state of a region was entered; `state` is the display name (`Owner.[*]`). */
    | { readonly kind: 'final'; readonly state: string; readonly region: RegionNode }
    /** A transition was taken (also initial transitions and the parts of compound transitions). */
    | { readonly kind: 'transition'; readonly node: ast.Transition; readonly source: string; readonly target: string; readonly label: string }
    /** A local reaction (including entry / exit reactions) was executed; `state` is the state machine name for its own reactions. */
    | { readonly kind: 'reaction'; readonly node: ast.LocalReaction; readonly state: string; readonly label: string }
    /** An event was raised by the host (`in`) or by the machine (`out`, `internal`). */
    | { readonly kind: 'raise'; readonly event: string; readonly direction: EventDirection; readonly value?: HostValue; readonly text: string }
    /** An operation was called. */
    | { readonly kind: 'call'; readonly operation: string; readonly args: readonly HostValue[]; readonly result?: HostValue; readonly text: string };

/** Options of the {@link StatechartInterpreter}. */
export interface SimulationOptions {
    /**
     * Implementations of operations, by declared name (`op` or `Iface.op`). Unregistered operations
     * return the default value of their return type.
     */
    operations?: Record<string, OperationImplementation>;
    /** Called for every out event raised by the state machine. */
    onOutEvent?: (event: OutEvent) => void;
    /** Called for every trace entry. */
    onTrace?: (entry: TraceEntry) => void;
    /**
     * Called whenever the guard of a transition or local reaction was evaluated (only if its trigger
     * matched), with the result. Used for guard (decision) coverage.
     */
    onGuard?: (guard: ast.Expression, value: boolean) => void;
    /**
     * Maximum number of transitions per step and of steps per host call (event driven internal
     * queue); protects against endless loops. Default: 1000.
     */
    maxMicrosteps?: number;
}

/** `'cycle'` for `@CycleBased` (default), `'event'` for `@EventDriven`. */
export type ExecutionMode = 'cycle' | 'event';

/** `@ParentFirstExecution` (default) or `@ChildFirstExecution`. */
export type ExecutionOrder = 'parent-first' | 'child-first';

interface Timer {
    readonly trigger: ast.TimeTrigger;
    readonly state: ast.State | ast.StateMachine;
    due: number;
    readonly period?: number;
    readonly sequence: number;
}

interface EnterTarget {
    vertex: TargetVertex;
    entryPoint?: string;
}

/** Event driven: an event waiting for its step in the internal queue (`event` undefined: a step without event). */
interface QueueEntry {
    readonly target: StatechartInterpreter;
    readonly event?: ast.EventDeclaration;
}

/** State shared by a state machine and all its submachine instances. */
interface SharedRuntime {
    /** Virtual clock in ns. */
    now: number;
    timerSequence: number;
    /** Number of the current (or last) step, counted from construction. */
    stepNumber: number;
    /** Event driven: internal events (also of instances) waiting for their step. */
    readonly internalQueue: QueueEntry[];
}

/**
 * The parent of a submachine instance (internal: instances are created by the interpreter of the
 * parent state machine, see docs/semantics.md §9).
 */
export interface InstanceContext {
    readonly parent: StatechartInterpreter;
    /** The instance variable (`var motor : Motor`). */
    readonly instance: ast.VariableDeclaration;
    /** The state the instance is bound to (`state Moving : motor`), if any. */
    readonly state?: ast.State;
    /** @internal */
    readonly shared: unknown;
}

const MAX_INSTANCE_DEPTH = 16;

const NS_PER_UNIT: Record<string, number> = { s: 1e9, ms: 1e6, us: 1e3, ns: 1 };
const NS_PER_MS = 1e6;

/**
 * Interpreter (simulation engine) for HSM state machines, implementing the execution semantics of
 * `docs/semantics.md`. It has no DOM or Node dependencies and uses a virtual clock.
 *
 * ```ts
 * const sim = new StatechartInterpreter(machine, { operations: { discInserted: () => true } });
 * sim.enter();
 * sim.raise('play');
 * sim.runCycle();              // cycle based machines only
 * sim.isActive('Playing');
 * ```
 */
export class StatechartInterpreter {

    /** The executed state machine. */
    readonly machine: ast.StateMachine;
    /** Structural information about the machine. */
    readonly index: ModelIndex;
    /** Execution mode selected by `@CycleBased` / `@EventDriven`. */
    readonly executionMode: ExecutionMode;
    /** Cycle period in ms (`@CycleBased(period)`, default 200). Also set for event driven machines. */
    readonly cyclePeriod: number;
    /** Execution order selected by `@ParentFirstExecution` / `@ChildFirstExecution`. */
    readonly executionOrder: ExecutionOrder;

    private readonly operations: Record<string, OperationImplementation>;
    private readonly options: SimulationOptions;
    private readonly shared: SharedRuntime;
    /** Set for submachine instances: the parent interpreter, the instance variable and the bound state. */
    private readonly context?: InstanceContext;
    /** Prefix of names in traces and host API calls: `''` for the state machine, `motor.` for an instance. */
    private readonly prefix: string;
    /** The submachine instances of this machine by their variable. */
    private readonly instances = new Map<ast.VariableDeclaration, StatechartInterpreter>();
    /** The instance bound to a state. */
    private readonly bindings = new Map<ast.State, StatechartInterpreter>();
    /** Instance: whether it has been entered (its bound state is active). */
    private instanceActive = false;
    /**
     * Instance: out events raised by the instance and still visible to the parent, with the number of
     * the step they were raised in and the parent's triggers / expressions that tested them in that step.
     */
    private readonly outOccurrences = new Map<ast.EventDeclaration, { step: number, seen: Set<AstNode> }>();
    private readonly maxMicrosteps: number;
    private readonly evaluator: ExpressionEvaluator;

    private readonly active = new Map<RegionNode, ActiveVertex>();
    private readonly history = new Map<RegionNode, ActiveVertex>();
    private readonly values = new Map<ast.VariableDeclaration, Value>();
    private readonly variableTypes = new Map<ast.VariableDeclaration, RuntimeType | undefined>();
    private readonly eventValues = new Map<ast.EventDeclaration, Value | undefined>();
    private readonly timers = new Map<ast.TimeTrigger, Timer>();

    /** Events present in the current step. */
    private readonly present = new Set<ast.EventDeclaration>();
    private readonly presentTimers = new Set<ast.TimeTrigger>();
    /** Cycle based: events collected for the next cycle (instances: for the next step of the instance). */
    private readonly collected = new Set<ast.EventDeclaration>();
    /** Event driven: in events raised by the host while a step is running. */
    private readonly hostQueue: ast.EventDeclaration[] = [];

    private readonly enteredInStep = new Set<ast.State>();
    private readonly exitedInStep = new Set<ast.State>();
    private microsteps = 0;
    private inStep = false;
    private busy = false;
    private running = false;

    private enterTime = 0;
    private nextCycle = 0;

    private lastTrace: TraceEntry[] = [];
    private lastOutEvents: OutEvent[] = [];

    /**
     * Creates an interpreter for the state machine. `context` is internal: it is used by the interpreter
     * to create its submachine instances.
     */
    constructor(machine: ast.StateMachine, options: SimulationOptions = {}, context?: InstanceContext) {
        this.machine = machine;
        this.options = options;
        this.context = context;
        this.operations = context ? {} : { ...options.operations };
        this.maxMicrosteps = options.maxMicrosteps ?? 1000;
        this.index = new ModelIndex(machine);
        this.evaluator = new ExpressionEvaluator(this.createContext());
        if (context) {
            // an instance is executed with the execution mode and order of its parent (docs/semantics.md §9)
            const parent = context.parent;
            this.shared = context.shared as SharedRuntime;
            this.prefix = `${parent.prefix}${referableName(context.instance)}.`;
            this.executionMode = parent.executionMode;
            this.executionOrder = parent.executionOrder;
            this.cyclePeriod = parent.cyclePeriod;
            if (this.prefix.split('.').length > MAX_INSTANCE_DEPTH) {
                throw new SimulationError(`Submachine instances are nested too deeply ('${this.prefix}...'); do the state machines import each other?`, context.instance);
            }
        } else {
            this.shared = { now: 0, timerSequence: 0, stepNumber: 0, internalQueue: [] };
            this.prefix = '';
            const annotation = (name: string) => machine.annotations.find(a => a.name === name);
            this.executionMode = annotation('EventDriven') && !annotation('CycleBased') ? 'event' : 'cycle';
            this.executionOrder = annotation('ChildFirstExecution') ? 'child-first' : 'parent-first';
            const period = annotation('CycleBased')?.arguments[0];
            this.cyclePeriod = period ? Number(this.evaluator.evaluate(period)) : 200;
            if (!(this.cyclePeriod > 0)) {
                throw new SimulationError(`Invalid cycle period ${this.cyclePeriod}`, period);
            }
        }
        for (const instance of this.index.instances()) {
            const submachine = instanceMachine(instance);
            if (!submachine) {
                continue;
            }
            const state = this.index.states.find(s => s.submachine?.ref === instance);
            const child = new StatechartInterpreter(submachine, options, { parent: this, instance, state, shared: this.shared });
            this.instances.set(instance, child);
            if (state && !this.bindings.has(state)) {
                this.bindings.set(state, child);
            }
        }
        this.resetData();
    }

    private get now(): number {
        return this.shared.now;
    }

    private set now(value: number) {
        this.shared.now = value;
    }

    /** The interpreter of the top-level state machine (itself if this is not an instance). */
    private get root(): StatechartInterpreter {
        return this.context ? this.context.parent.root : this;
    }

    // -----------------------------------------------------------------------------------------
    // Public API

    /** Current time of the virtual clock in ms (0 at construction). */
    get time(): number {
        return this.now / NS_PER_MS;
    }

    /** Whether the state machine has been entered and not exited. */
    get isRunning(): boolean {
        return this.running;
    }

    /** Registers (or replaces) the implementation of an operation (`op` or `Iface.op`). */
    setOperation(name: string, implementation: OperationImplementation): void {
        this.operations[name] = implementation;
    }

    /**
     * Enters the state machine: initializes variables, executes the entry reactions of the state
     * machine and enters the top-level region by default. Event driven machines then perform a step
     * without events (docs/semantics.md §3, §8).
     */
    enter(): void {
        if (this.running) {
            throw new SimulationError(`State machine '${this.machine.name}' is already entered`);
        }
        this.assertRoot('enter');
        this.hostCall(() => {
            this.resetRuntime();
            this.shared.internalQueue.length = 0;
            this.running = true;
            this.enterTime = this.now;
            this.nextCycle = this.now + this.cyclePeriod * NS_PER_MS;
            this.initializeVariables();
            this.beginStep();
            this.runBuiltinReactions(this.machine, 'entry');
            for (const trigger of this.index.timeTriggers(this.machine)) {
                this.startTimer(trigger, this.machine);
            }
            this.enterRegionDefault(this.machine);
            if (this.executionMode === 'event') {
                this.step();
                this.drainQueues();
            }
        });
    }

    /** Exits all active states (innermost first) and stops the state machine. */
    exit(): void {
        this.assertRoot('exit');
        this.assertRunning();
        this.hostCall(() => {
            this.beginStep();
            this.exitRegion(this.machine);
            this.runBuiltinReactions(this.machine, 'exit');
            this.running = false;
            this.timers.clear();
        });
    }

    /** Whether the state machine is final: the final state of the top-level region is active. */
    isFinal(): boolean {
        return isFinalState(this.active.get(this.machine));
    }

    /**
     * Whether a state is active. The state is given by its node or by its fully qualified name
     * (`Closed.Active.Playing`) or a unique suffix of it (`Playing`).
     */
    isActive(state: string | ast.State): boolean {
        if (typeof state !== 'string') {
            return this.isStateActive(state);
        }
        const instance = this.instanceOfName(state);
        if (instance && !this.index.findState(state)) {
            return instance.interpreter.instanceActive && instance.interpreter.isActive(instance.rest);
        }
        return this.isStateActive(this.resolveState(state));
    }

    /**
     * The display name of a state given by its (partially) qualified name, as used in
     * {@link activeStates}: `Closed.Active.Playing`, `motor.Running` for states of submachine instances.
     */
    stateDisplayName(name: string): string {
        const state = this.index.findState(name);
        if (state) {
            return this.prefix + this.index.stateName(state);
        }
        const instance = this.instanceOfName(name);
        if (instance) {
            return instance.interpreter.stateDisplayName(instance.rest);
        }
        throw new SimulationError(`Unknown or ambiguous state '${name}' in state machine '${this.machine.name}'`);
    }

    /**
     * Raises an in event (`open` or `Iface.open`) with an optional value. Cycle based: the event is
     * collected for the next {@link runCycle}. Event driven: a step (plus the steps for queued
     * internal events) is performed immediately.
     */
    raise(eventName: string, value?: unknown): void {
        this.assertRoot('raise');
        const event = this.index.findEvent(eventName);
        if (!event && this.instanceOfName(eventName)) {
            throw new SimulationError(`Event '${eventName}' belongs to a submachine instance; its in events are raised by the state machine, not by the host`);
        }
        if (!event) {
            throw new SimulationError(`Unknown event '${eventName}' in state machine '${this.machine.name}'`);
        }
        const direction = this.index.eventDirection(event);
        if (direction !== 'in') {
            throw new SimulationError(`Event '${eventName}' is an ${direction} event; only in events can be raised by the host`, event);
        }
        this.assertRunning();
        const converted = value === undefined ? undefined
            : fromHost(value, declaredType(event.type), `Value of event '${eventName}'`, event);
        const raise = () => {
            if (converted !== undefined) {
                this.eventValues.set(event, converted);
            }
            const emit = this.busy ? (entry: TraceEntry) => this.emit(entry) : (entry: TraceEntry) => this.options.onTrace?.(entry);
            const name = this.index.declarationName(event);
            const text = formatCall(name, converted === undefined ? [] : [converted]);
            emit({ kind: 'raise', event: name, direction, value: toHost(converted), text });
        };
        if (this.executionMode === 'cycle') {
            raise();
            this.collected.add(event);
        } else if (this.busy) {
            raise();
            this.hostQueue.push(event);
        } else {
            this.hostCall(() => {
                raise();
                this.processEvent(event);
                this.drainQueues();
            });
        }
    }

    /**
     * Cycle based: performs one run cycle (a step in which all collected events and all expired time
     * events are present). Event driven: performs a step without events.
     */
    runCycle(): void {
        this.assertRoot('runCycle');
        this.assertRunning();
        this.hostCall(() => {
            if (this.executionMode === 'cycle') {
                this.cycle();
            } else {
                this.processEvent(undefined);
                this.drainQueues();
            }
        });
    }

    /**
     * Advances the virtual clock by `ms` milliseconds. Cycle based: expired timers become present in
     * the next run cycle; no cycle is performed (see {@link runFor}). Event driven: every expiring timer
     * triggers a step at its expiry time, in expiry order.
     */
    advanceTime(ms: number): void {
        const end = this.now + toNanos(ms);
        if (this.executionMode === 'cycle' || !this.running) {
            this.now = end;
            return;
        }
        this.hostCall(() => {
            for (;;) {
                const next = this.nextTimer(end);
                if (!next) {
                    break;
                }
                this.now = next.timer.due;
                next.interpreter.expire(next.timer);
                this.processEvent(undefined, next.timer.trigger, next.interpreter);
                this.drainQueues();
            }
            this.now = end;
        });
    }

    /**
     * Advances the virtual clock by `ms` milliseconds like a host would: cycle based machines run a
     * cycle whenever the clock reaches a multiple of the cycle period (counted from `enter()`);
     * for event driven machines this is {@link advanceTime}.
     */
    runFor(ms: number): void {
        if (this.executionMode === 'event' || !this.running) {
            this.advanceTime(ms);
            return;
        }
        const end = this.now + toNanos(ms);
        const period = this.cyclePeriod * NS_PER_MS;
        if (this.nextCycle < this.now) {
            this.nextCycle = this.enterTime + Math.ceil((this.now - this.enterTime) / period) * period;
        }
        this.hostCall(() => {
            while (this.nextCycle <= end) {
                this.now = this.nextCycle;
                this.nextCycle += period;
                this.cycle();
            }
            this.now = end;
        });
    }

    /** Current value of a variable or constant (`x`, `Iface.x`, `motor.speed` for a variable of an instance). */
    getVariable(name: string): HostValue | undefined {
        const instance = this.index.findVariable(name) ? undefined : this.instanceOfName(name);
        if (instance) {
            return instance.interpreter.getVariable(instance.rest);
        }
        return toHost(this.values.get(this.resolveVariable(name)));
    }

    /**
     * Sets a variable (`x`, `Iface.x`, `motor.speed` for a variable of an instance). Constants and
     * `readonly` variables cannot be set by the host.
     */
    setVariable(name: string, value: unknown): void {
        const instance = this.index.findVariable(name) ? undefined : this.instanceOfName(name);
        if (instance) {
            instance.interpreter.setVariable(instance.rest, value);
            return;
        }
        const variable = this.resolveVariable(name);
        if (variable.const || variable.readonly) {
            throw new SimulationError(`'${name}' is ${variable.const ? 'a constant' : 'read-only'} and cannot be set by the host`, variable);
        }
        this.values.set(variable, fromHost(value, this.variableTypes.get(variable), `Value of '${name}'`, variable)!);
    }

    /**
     * The runtime value of a variable or constant (`x`, `Iface.x`, `motor.speed`), e.g. to show enum
     * values by name or the members of a struct value ({@link formatValue}).
     */
    getValue(name: string): Value | undefined {
        const instance = this.index.findVariable(name) ? undefined : this.instanceOfName(name);
        if (instance) {
            return instance.interpreter.getValue(instance.rest);
        }
        return this.values.get(this.resolveVariable(name));
    }

    /** The runtime type of a variable or constant (`undefined` if it is not known). */
    getVariableType(name: string): RuntimeType | undefined {
        const instance = this.index.findVariable(name) ? undefined : this.instanceOfName(name);
        if (instance) {
            return instance.interpreter.getVariableType(instance.rest);
        }
        return this.variableTypes.get(this.resolveVariable(name));
    }

    /** Snapshot of all variables and constants by declared name (`x`, `Iface.x`). */
    get variables(): Record<string, HostValue> {
        const result: Record<string, HostValue> = {};
        for (const variable of this.index.variables()) {
            result[this.index.declarationName(variable)] = toHost(this.values.get(variable))!;
        }
        // variables of the submachine instances: `motor.speed`
        for (const [instance, interpreter] of this.instances) {
            for (const [name, value] of Object.entries(interpreter.variables)) {
                result[`${this.index.declarationName(instance)}.${name}`] = value;
            }
        }
        return result;
    }

    /** Value of the last occurrence of an event (as `valueof(e)` in the model; `motor.failed` for an event of an instance). */
    getEventValue(name: string): HostValue | undefined {
        const event = this.index.findEvent(name);
        const instance = event ? undefined : this.instanceOfName(name);
        if (instance) {
            return instance.interpreter.getEventValue(instance.rest);
        }
        if (!event) {
            throw new SimulationError(`Unknown event '${name}' in state machine '${this.machine.name}'`);
        }
        return toHost(this.eventValues.get(event));
    }

    /**
     * Fully qualified names of all active states in document order (parents before children). The
     * active states of a submachine instance follow the state it is bound to, prefixed with the name of
     * the instance: `Moving`, `motor.Running` (docs/semantics.md §9).
     */
    get activeStates(): string[] {
        return this.activeStateNodes().flatMap(s => [this.prefix + this.index.stateName(s), ...this.instanceOf(s)?.activeStates ?? []]);
    }

    /**
     * Fully qualified names of the active states without active sub states. A state bound to an active
     * submachine instance is not a leaf; the leaves of the instance are listed instead (`motor.Running`).
     */
    get activeLeafStates(): string[] {
        return this.activeStateNodes().flatMap(s => {
            const instance = this.instanceOf(s);
            const instanceLeaves = instance?.activeLeafStates ?? [];
            if (instanceLeaves.length > 0) {
                return instanceLeaves;
            }
            return this.index.regionsOf(s).some(r => ast.isState(this.active.get(r))) ? [] : [this.prefix + this.index.stateName(s)];
        });
    }

    /**
     * The active submachine instances: the state they are bound to, the instance variable and the
     * interpreter of the instance (for its states, variables and nested instances).
     */
    activeInstances(): Array<{ state: ast.State, instance: ast.VariableDeclaration, name: string, interpreter: StatechartInterpreter }> {
        const result: Array<{ state: ast.State, instance: ast.VariableDeclaration, name: string, interpreter: StatechartInterpreter }> = [];
        for (const [instance, interpreter] of this.instances) {
            const state = interpreter.context?.state;
            if (state && interpreter.instanceActive) {
                result.push({ state, instance, name: this.index.declarationName(instance), interpreter });
            }
        }
        return result;
    }

    /** The interpreters of the submachine instances by instance name (`motor`), also inactive ones. */
    get instanceInterpreters(): ReadonlyMap<string, StatechartInterpreter> {
        return new Map([...this.instances].map(([instance, interpreter]) => [this.index.declarationName(instance), interpreter]));
    }

    /** Whether this interpreter executes a submachine instance that is currently entered. */
    get isInstanceActive(): boolean {
        return this.instanceActive;
    }

    /** All active states in document order. */
    activeStateNodes(): ast.State[] {
        const result: ast.State[] = [];
        const visit = (region: RegionNode) => {
            const vertex = this.active.get(region);
            if (vertex && ast.isState(vertex)) {
                result.push(vertex);
                this.index.regionsOf(vertex).forEach(visit);
            }
        };
        visit(this.machine);
        return result;
    }

    /** Out events raised during the last call of `enter`, `exit`, `raise`, `runCycle`, `advanceTime` or `runFor` that executed the machine. */
    get outEvents(): readonly OutEvent[] {
        return this.lastOutEvents;
    }

    /** Trace of the last call of `enter`, `exit`, `raise`, `runCycle`, `advanceTime` or `runFor` that executed the machine. */
    get trace(): readonly TraceEntry[] {
        return this.lastTrace;
    }

    // -----------------------------------------------------------------------------------------
    // Host calls, cycles and steps

    private hostCall(action: () => void): void {
        if (this.busy) {
            throw new SimulationError('The state machine is busy; re-entrant calls are not supported');
        }
        this.lastTrace = [];
        this.lastOutEvents = [];
        this.busy = true;
        try {
            action();
        } finally {
            this.busy = false;
            this.inStep = false;
        }
    }

    private assertRoot(operation: string): void {
        if (this.context) {
            throw new SimulationError(`'${operation}' cannot be called for the submachine instance '${this.prefix.slice(0, -1)}'; it is executed by its parent`);
        }
    }

    private assertRunning(): void {
        if (!this.running) {
            throw new SimulationError(`State machine '${this.machine.name}' is not entered; call enter() first`);
        }
    }

    private cycle(): void {
        if (this.isFinal()) {
            this.collected.clear();
            return;
        }
        for (const event of this.collected) {
            this.present.add(event);
        }
        this.collected.clear();
        // expired timers of the machine and of all instances are present in this cycle
        for (const interpreter of this.allInterpreters()) {
            for (const timer of interpreter.expiredTimers()) {
                interpreter.presentTimers.add(timer.trigger);
                interpreter.expire(timer);
            }
        }
        this.step();
    }

    /**
     * Event driven: a step with the given event or time event (or none) present in `target` (the
     * machine or one of its instances; an event for an instance that is not active is discarded).
     */
    private processEvent(event: ast.EventDeclaration | undefined, timer?: ast.TimeTrigger, target: StatechartInterpreter = this): void {
        if (this.isFinal() || !this.running || (target !== this && !target.instanceActive)) {
            return;
        }
        if (event) {
            target.present.add(event);
        }
        if (timer) {
            target.presentTimers.add(timer);
        }
        this.step();
    }

    /** Event driven: processes queued internal events, then in events raised meanwhile by the host. */
    private drainQueues(): void {
        let steps = 0;
        for (;;) {
            const internal = this.shared.internalQueue.shift();
            const host = internal ? undefined : this.hostQueue.shift();
            if (!internal && !host) {
                return;
            }
            const event = internal ? internal.event : host;
            if (++steps > this.maxMicrosteps) {
                throw new SimulationError(`More than ${this.maxMicrosteps} queued event steps; the state machine seems to loop (last event '${event?.name ?? 'out event of an instance'}')`, event);
            }
            this.processEvent(event, undefined, internal?.target ?? this);
        }
    }

    private step(): void {
        this.shared.stepNumber++;
        this.beginStep();
        this.inStep = true;
        const events = this.presentEventNames();
        this.emit({ kind: 'step', time: this.time, events });
        try {
            this.runLocalReactions(this.machine);
            const top = this.active.get(this.machine);
            if (top && ast.isState(top)) {
                this.react(top);
            }
        } finally {
            this.inStep = false;
            this.endStep();
        }
    }

    /** Names of the events and time events present in this step (instances: the events of their next step). */
    private presentEventNames(): string[] {
        const events: string[] = [];
        for (const interpreter of this.allInterpreters()) {
            const pending = interpreter === this || this.executionMode === 'event' ? interpreter.present : new Set([...interpreter.present, ...interpreter.collected]);
            events.push(...[...pending].map(e => interpreter.prefix + interpreter.index.declarationName(e)));
            for (const trigger of interpreter.presentTimers) {
                events.push(`${nodeText(trigger)}@${interpreter.prefix}${interpreter.ownerOfTrigger(trigger)}`);
            }
        }
        return events;
    }

    /**
     * End of a step of the top-level machine: events are cleared, events raised on instances that are
     * not active are discarded, out events of instances raised before this step are no longer visible.
     */
    private endStep(): void {
        const step = this.shared.stepNumber;
        for (const interpreter of this.allInterpreters()) {
            interpreter.present.clear();
            interpreter.presentTimers.clear();
            if (interpreter !== this && !interpreter.instanceActive) {
                interpreter.collected.clear();
            }
            interpreter.consumeOccurrences(step);
        }
    }

    private beginStep(): void {
        for (const interpreter of this.allInterpreters()) {
            interpreter.enteredInStep.clear();
            interpreter.exitedInStep.clear();
            interpreter.microsteps = 0;
        }
    }

    /** This interpreter and the interpreters of all (nested) instances. */
    private allInterpreters(): StatechartInterpreter[] {
        const result: StatechartInterpreter[] = [this];
        for (const instance of this.instances.values()) {
            result.push(...instance.allInterpreters());
        }
        return result;
    }

    /** Out events of this instance raised before step `step` are no longer visible to the parent. */
    private consumeOccurrences(step: number): void {
        for (const [event, occurrence] of this.outOccurrences) {
            if (occurrence.step < step) {
                this.outOccurrences.delete(event);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Submachine instances (docs/semantics.md §9)

    /** The instance bound to a state, if any. */
    private instanceOf(state: ast.State): StatechartInterpreter | undefined {
        return this.bindings.get(state);
    }

    /** Splits `motor.On` into the interpreter of the instance `motor` and the rest of the name. */
    private instanceOfName(name: string): { interpreter: StatechartInterpreter, rest: string } | undefined {
        let result: { interpreter: StatechartInterpreter, rest: string, length: number } | undefined;
        for (const [instance, interpreter] of this.instances) {
            const prefix = this.index.declarationName(instance);
            if (name.startsWith(`${prefix}.`) && (!result || prefix.length > result.length)) {
                result = { interpreter, rest: name.slice(prefix.length + 1), length: prefix.length };
            }
        }
        return result && { interpreter: result.interpreter, rest: result.rest };
    }

    /**
     * The interpreter that owns a declaration or state referenced by `node`: this one for own
     * declarations, the interpreter of the instance for members of instances (`motor.speed`).
     */
    private owner(target: AstNode, node: AstNode | undefined): StatechartInterpreter {
        if (AstUtils.findRootNode(target) === this.machine) {
            return this;
        }
        const instance = node ? this.index.instanceOf(node) : undefined;
        const interpreter = instance ? this.instances.get(instance) : undefined;
        if (!interpreter) {
            throw new SimulationError(`Cannot determine the submachine instance of '${nodeText(node) || (target as { name?: string }).name}'`, node);
        }
        return interpreter;
    }

    /**
     * Enters the instance (after the entry reactions of its state): the entry reactions of its state
     * machine, its timers, then its top-level region through the entry point or by default.
     */
    private enterInstance(entryPoint: string | undefined): void {
        this.instanceActive = true;
        this.running = true;
        this.runBuiltinReactions(this.machine, 'entry');
        for (const trigger of this.index.timeTriggers(this.machine)) {
            this.startTimer(trigger, this.machine);
        }
        const entry = entryPoint ? this.index.entryPointIn(this.machine, entryPoint) : undefined;
        if (entryPoint && !entry) {
            throw new SimulationError(`State machine '${this.machine.name}' has no entry point '${entryPoint}'`, this.context?.state);
        }
        if (entry) {
            this.takeEntryPoint(entry);
        } else {
            this.enterRegionDefault(this.machine);
        }
    }

    /** Exits the instance (before the exit reactions of its state): its active states, then the exit reactions of its machine. */
    private exitInstance(): void {
        if (!this.instanceActive) {
            return;
        }
        this.exitRegion(this.machine);
        this.runBuiltinReactions(this.machine, 'exit');
        this.timers.clear();
        this.instanceActive = false;
        this.running = false;
        this.collected.clear();
        this.present.clear();
        this.presentTimers.clear();
    }

    /**
     * Processes the instance as the sub region of its state (docs/semantics.md §9): the events raised
     * on it become present, then its own reactions and its active states are processed. Returns
     * whether a transition was taken in the instance.
     */
    private instanceStep(): boolean {
        if (!this.instanceActive) {
            return false;
        }
        if (this.executionMode === 'cycle') {
            for (const event of this.collected) {
                this.present.add(event);
            }
            this.collected.clear();
        }
        if (this.isFinal()) {
            this.present.clear();
            this.presentTimers.clear();
            return false;
        }
        this.inStep = true;
        try {
            this.runLocalReactions(this.machine);
            const top = this.active.get(this.machine);
            if (top && ast.isState(top) && !this.enteredInStep.has(top)) {
                return this.react(top);
            }
            return false;
        } finally {
            this.inStep = false;
            this.present.clear();
            this.presentTimers.clear();
        }
    }

    /** An event raised on the instance by its parent (`raise motor.start`). */
    private receive(event: ast.EventDeclaration, value: Value | undefined): void {
        if (value !== undefined) {
            this.eventValues.set(event, value);
        }
        const name = this.prefix + this.index.declarationName(event);
        this.emit({ kind: 'raise', event: name, direction: 'in', value: toHost(value), text: formatCall(name, value === undefined ? [] : [value]) }, false);
        if (this.executionMode === 'cycle') {
            this.collected.add(event);
        } else {
            this.shared.internalQueue.push({ target: this, event });
        }
    }

    /** The instance reached the exit node `name` of its state machine: its state is left by its `# name>` transition. */
    private instanceExitReached(state: ast.State, name: string, node: AstNode): void {
        const transition = this.index.exitTransitions(state, name).find(t => this.guard(t.spec?.guard));
        if (!transition) {
            throw new SimulationError(`Exit node '${name}' was reached but state '${state.name}' has no enabled transition '# ${name}>'`, node);
        }
        this.takeTransition(transition, state);
    }

    /** Processes an active state (docs/semantics.md §4); returns whether a transition was taken in its subtree. */
    private react(state: ast.State): boolean {
        if (this.executionOrder === 'parent-first') {
            if (this.tryTransitions(state)) {
                return true;
            }
            this.runLocalReactions(state);
            return this.reactRegions(state);
        }
        const taken = this.reactRegions(state);
        if (taken || this.exitedInStep.has(state)) {
            return true;
        }
        if (this.tryTransitions(state)) {
            return true;
        }
        this.runLocalReactions(state);
        return false;
    }

    private reactRegions(state: ast.State): boolean {
        const instance = this.instanceOf(state);
        if (instance) {
            // the instance is processed like the (only) sub region of its state
            return instance.instanceStep() || this.exitedInStep.has(state);
        }
        let taken = false;
        for (const region of this.index.regionsOf(state)) {
            const vertex = this.active.get(region);
            if (vertex && ast.isState(vertex) && !this.enteredInStep.has(vertex)) {
                taken = this.react(vertex) || taken;
            }
            if (this.exitedInStep.has(state)) {
                return true;
            }
        }
        return taken;
    }

    private tryTransitions(state: ast.State): boolean {
        for (const transition of this.index.outgoing(state)) {
            const target = transition.target?.ref;
            if (target && isJoin(target, this.index)) {
                if (this.joinEnabled(target)) {
                    this.fireJoin(target);
                    return true;
                }
            } else if (this.transitionEnabled(transition)) {
                this.takeTransition(transition, state);
                return true;
            }
        }
        return false;
    }

    private runLocalReactions(state: ast.State | ast.StateMachine): void {
        for (const reaction of state.reactions) {
            // like transitions: a reaction without trigger and guard is never executed (itemis CREATE)
            if ((reaction.triggers.length > 0 || reaction.guard) && this.enabled(reaction.triggers, reaction.guard)) {
                this.executeReaction(reaction, state);
            }
        }
    }

    /**
     * Whether a transition leaving a state is enabled. Transitions without trigger and guard are never
     * taken (like in itemis CREATE); guard-only transitions are checked in every step.
     */
    private transitionEnabled(transition: ast.Transition): boolean {
        const spec = transition.spec;
        if (!spec || (spec.triggers.length === 0 && !spec.guard)) {
            return false;
        }
        return this.enabled(spec.triggers, spec.guard);
    }

    /** A reaction is enabled if one of its triggers matches (no trigger: always) and its guard holds. */
    private enabled(triggers: readonly ast.Trigger[], guard: ast.Expression | undefined): boolean {
        const matches = triggers.length === 0 || triggers.some(trigger => {
            if (ast.isEventTrigger(trigger)) {
                const event = trigger.event.ref;
                return event !== undefined && this.isEventPresent(event, trigger);
            }
            if (ast.isTimeTrigger(trigger)) {
                return this.presentTimers.has(trigger);
            }
            return trigger.kind === 'always' || trigger.kind === 'oncycle';
        });
        return matches && this.guard(guard);
    }

    private executeReaction(reaction: ast.LocalReaction, state: ast.State | ast.StateMachine): void {
        const name = ast.isState(state) ? this.index.stateName(state) : this.context ? '' : state.name;
        this.emit({ kind: 'reaction', node: reaction, state: name, label: nodeText(reaction) });
        this.evaluator.execute(reaction.effect);
    }

    /** Executes the `entry` or `exit` reactions of a state (or of the state machine) whose guard holds. */
    private runBuiltinReactions(state: ast.State | ast.StateMachine, kind: 'entry' | 'exit'): void {
        for (const reaction of state.reactions) {
            if (hasBuiltinTrigger(reaction, kind) && this.guard(reaction.guard)) {
                this.executeReaction(reaction, state);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Transitions

    private countMicrostep(node: AstNode): void {
        if (++this.microsteps > this.maxMicrosteps) {
            throw new SimulationError(`More than ${this.maxMicrosteps} transitions in one step; the state machine seems to loop`, node);
        }
    }

    /** Takes a transition from `source` (docs/semantics.md §5): exit, effect, enter. */
    private takeTransition(transition: ast.Transition, source: ast.Vertex): void {
        this.countMicrostep(transition);
        const target = this.index.targetOf(transition);
        const scope = this.index.scopeRegion([source, target]);
        this.exitRegion(scope);
        this.traceTransition(transition);
        this.evaluator.execute(transition.spec?.effect);
        this.enterInRegion(scope, [{ vertex: target, entryPoint: entryPointOf(transition) }]);
    }

    private traceTransition(transition: ast.Transition): void {
        this.emit({
            kind: 'transition',
            node: transition,
            source: transition.initial ? '[*]' : this.index.vertexName(transition.source?.ref),
            target: this.index.vertexName(this.index.targetOf(transition)),
            label: transitionLabel(transition)
        });
    }

    private joinEnabled(join: ast.PseudoState): boolean {
        return this.index.incoming(join).every(transition => {
            const source = transition.source?.ref;
            return source !== undefined && ast.isState(source) && this.isStateActive(source) && !this.enteredInStep.has(source)
                && this.transitionEnabled(transition);
        });
    }

    /** Join: exits all sources, executes the incoming effects in priority order and enters the sync. */
    private fireJoin(join: ast.PseudoState): void {
        this.countMicrostep(join);
        const incoming = this.index.incoming(join);
        const scope = this.index.scopeRegion([join, ...incoming.map(t => t.source!.ref!)]);
        this.exitRegion(scope);
        for (const transition of incoming) {
            this.traceTransition(transition);
            this.evaluator.execute(transition.spec?.effect);
        }
        this.enterInRegion(scope, [{ vertex: join }]);
    }

    // -----------------------------------------------------------------------------------------
    // Entering

    /**
     * Enters the target vertices, which are all contained in `region` (docs/semantics.md §8): the
     * ancestors below the region are entered outermost first, their other regions by default.
     */
    private enterInRegion(region: RegionNode, targets: EnterTarget[]): void {
        const children = targets.map(t => this.index.childIn(region, t.vertex));
        const child = children[0];
        if (!child || children.some(c => c !== child)) {
            const names = targets.map(t => this.index.vertexName(t.vertex)).join(', ');
            throw new SimulationError(`Cannot enter ${names} together in ${this.regionName(region)}`, targets[0].vertex as AstNode);
        }
        if (targets.length === 1 && targets[0].vertex === child) {
            this.enterTarget(targets[0]);
            return;
        }
        if (!ast.isState(child) || targets.some(t => t.vertex === child)) {
            throw new SimulationError(`Cannot enter ${this.index.vertexName(child)} and its sub vertices together`, child as AstNode);
        }
        const alreadyActive = this.active.get(region) === child;
        if (!alreadyActive) {
            this.enterStateCore(child);
        }
        for (const sub of this.index.regionsOf(child)) {
            const inside = targets.filter(t => this.index.childIn(sub, t.vertex) !== undefined);
            if (inside.length > 0) {
                this.enterInRegion(sub, inside);
            } else if (!alreadyActive) {
                this.enterRegionDefault(sub);
            }
        }
    }

    /** Enters the target of a transition itself (its ancestors are active). */
    private enterTarget(target: EnterTarget): void {
        const vertex = target.vertex;
        if (isFinalState(vertex)) {
            this.enterFinal(vertex);
        } else if (ast.isState(vertex)) {
            const entryPoint = target.entryPoint;
            if (this.instanceOf(vertex)) {
                // the entry point is an entry point of the instance's state machine
                this.enterStateCore(vertex, entryPoint);
                return;
            }
            this.enterStateCore(vertex);
            if (entryPoint && !this.index.findPseudo(vertex, 'entry', entryPoint)) {
                throw new SimulationError(`State '${vertex.name}' has no entry point '${entryPoint}'`, vertex);
            }
            // every region with an entry point of this name is entered through it, the others by default
            for (const region of this.index.regionsOf(vertex)) {
                const entry = entryPoint ? this.index.entryPointIn(region, entryPoint) : undefined;
                if (entry) {
                    this.takeEntryPoint(entry);
                } else {
                    this.enterRegionDefault(region);
                }
            }
        } else {
            this.enterPseudoState(vertex);
        }
    }

    private enterFinal(final: FinalState): void {
        const current = this.active.get(final.region);
        if (current) {
            this.exitVertex(current);
        }
        this.active.set(final.region, final);
        this.emit({ kind: 'final', state: this.index.vertexName(final), region: final.region });
    }

    /**
     * Marks a state active, executes its entry reactions and starts its timers; then enters the
     * submachine instance bound to the state (through `entryPoint`, if given).
     */
    private enterStateCore(state: ast.State, entryPoint?: string): void {
        this.active.set(this.index.regionOf(state), state);
        this.enteredInStep.add(state);
        this.emit({ kind: 'enter', state: this.index.stateName(state), node: state });
        this.runBuiltinReactions(state, 'entry');
        for (const trigger of this.index.timeTriggers(state)) {
            this.startTimer(trigger, state);
        }
        this.instanceOf(state)?.enterInstance(entryPoint);
    }

    /** Enters a region by its initial transition (docs/semantics.md §8.3). */
    private enterRegionDefault(region: RegionNode): void {
        const initial = region.transitions.find(t => t.initial);
        if (!initial) {
            if (region.vertices.some(ast.isState)) {
                throw new SimulationError(`${capitalize(this.regionName(region))} is entered by default but has no initial transition ('[*] -> ...')`, region);
            }
            return;
        }
        this.countMicrostep(initial);
        const target = this.index.targetOf(initial);
        this.traceTransition(initial);
        this.evaluator.execute(initial.spec?.effect);
        const scope = this.index.childIn(region, target) ? region : this.index.commonRegion([region, this.index.regionOf(target)]);
        this.enterInRegion(scope, [{ vertex: target, entryPoint: entryPointOf(initial) }]);
    }

    private enterPseudoState(pseudo: ast.PseudoState): void {
        switch (pseudo.kind) {
            case 'choice':
            case 'junction':
                this.takeChoice(pseudo);
                break;
            case 'history':
            case 'deephistory':
                this.enterHistory(pseudo);
                break;
            case 'entry':
                this.takeEntryPoint(pseudo);
                break;
            case 'exit':
                this.takeExitNode(pseudo);
                break;
            case 'sync':
                this.fork(pseudo);
                break;
            default:
                throw new SimulationError(`Unsupported pseudo state '${pseudo.kind}'`, pseudo);
        }
    }

    /** Choice / junction: guarded branches first (priority order), then the default branch. */
    private takeChoice(choice: ast.PseudoState): void {
        const outgoing = this.index.outgoing(choice);
        const isDefault = (t: ast.Transition) => !t.spec?.guard
            || (t.spec.triggers.some(trigger => ast.isBuiltinTrigger(trigger) && (trigger.kind === 'else' || trigger.kind === 'default')));
        const chosen = outgoing.find(t => !isDefault(t) && this.guard(t.spec?.guard))
            ?? outgoing.find(t => isDefault(t) && this.guard(t.spec?.guard));
        if (!chosen) {
            throw new SimulationError(`${capitalize(choice.kind)} '${choice.name}' has no enabled outgoing transition`, choice);
        }
        this.takeTransition(chosen, choice);
    }

    private takeEntryPoint(entry: ast.PseudoState): void {
        const transition = this.index.outgoing(entry).find(t => this.guard(t.spec?.guard));
        if (!transition) {
            throw new SimulationError(`Entry point '${entry.name}' has no enabled outgoing transition`, entry);
        }
        this.takeTransition(transition, entry);
    }

    /** Exit node `X`: the owning composite state is left by its `# X>` transition. */
    private takeExitNode(exitNode: ast.PseudoState): void {
        const region = this.index.regionOf(exitNode);
        if (region === this.machine) {
            // exit node of the state machine itself: an instance leaves its state, a state machine becomes final
            if (this.context?.state) {
                this.context.parent.instanceExitReached(this.context.state, exitNode.name, exitNode);
            } else {
                this.enterFinal(this.index.finalState(this.machine));
            }
            return;
        }
        const owner = this.index.ownerState(region);
        const transition = owner
            ? this.index.exitTransitions(owner, exitNode.name).find(t => this.guard(t.spec?.guard))
            : undefined;
        if (!owner || !transition) {
            throw new SimulationError(`Exit node '${exitNode.name}' was reached but ${owner ? `state '${owner.name}'` : 'its state'} has no enabled transition '# ${exitNode.name}>'`, exitNode);
        }
        this.takeTransition(transition, owner);
    }

    /** Fork: executes the effects of all outgoing transitions, then enters all targets together. */
    private fork(sync: ast.PseudoState): void {
        const outgoing = this.index.outgoing(sync);
        if (outgoing.length === 0) {
            throw new SimulationError(`Synchronization '${sync.name}' has no outgoing transition`, sync);
        }
        if (outgoing.length === 1) {
            this.takeTransition(outgoing[0], sync);
            return;
        }
        this.countMicrostep(sync);
        const targets = outgoing.map(t => ({ vertex: this.index.targetOf(t), entryPoint: entryPointOf(t) }));
        const scope = this.index.scopeRegion([sync, ...targets.map(t => t.vertex)]);
        this.exitRegion(scope);
        for (const transition of outgoing) {
            this.traceTransition(transition);
            this.evaluator.execute(transition.spec?.effect);
        }
        this.enterInRegion(scope, targets);
    }

    /** History: restores the recorded state (deep: recursively), else takes the default transition. */
    private enterHistory(pseudo: ast.PseudoState): void {
        const region = this.index.regionOf(pseudo);
        const recorded = this.history.get(region);
        if (recorded) {
            if (pseudo.kind === 'deephistory' && ast.isState(recorded)) {
                this.enterDeep(recorded);
            } else {
                this.enterTarget({ vertex: recorded });
            }
            return;
        }
        const transition = this.index.outgoing(pseudo)[0];
        if (transition) {
            this.takeTransition(transition, pseudo);
        } else {
            this.enterRegionDefault(region);
        }
    }

    private enterDeep(state: ast.State): void {
        this.enterStateCore(state);
        for (const region of this.index.regionsOf(state)) {
            const recorded = this.history.get(region);
            if (!recorded) {
                this.enterRegionDefault(region);
            } else if (ast.isState(recorded)) {
                this.enterDeep(recorded);
            } else {
                this.enterFinal(recorded);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Exiting

    /** Exits the active vertex of a region (if any) without recording the history of the region itself. */
    private exitRegion(region: RegionNode): void {
        const vertex = this.active.get(region);
        if (vertex) {
            this.exitVertex(vertex);
        }
    }

    /** Exits a vertex: sub regions first (recording their history), then exit reactions and timers. */
    private exitVertex(vertex: ActiveVertex): void {
        if (isFinalState(vertex)) {
            this.active.delete(vertex.region);
            return;
        }
        for (const region of this.index.regionsOf(vertex)) {
            const sub = this.active.get(region);
            if (sub) {
                this.exitVertex(sub);
                this.history.set(region, sub);
            }
        }
        this.instanceOf(vertex)?.exitInstance();
        this.runBuiltinReactions(vertex, 'exit');
        for (const trigger of this.index.timeTriggers(vertex)) {
            this.timers.delete(trigger);
            this.presentTimers.delete(trigger);
        }
        this.active.delete(this.index.regionOf(vertex));
        this.exitedInStep.add(vertex);
        this.emit({ kind: 'exit', state: this.index.stateName(vertex), node: vertex });
    }

    // -----------------------------------------------------------------------------------------
    // Time events

    private startTimer(trigger: ast.TimeTrigger, state: ast.State | ast.StateMachine): void {
        const factor = NS_PER_UNIT[trigger.unit];
        if (factor === undefined) {
            throw new SimulationError(`Unknown time unit '${trigger.unit}' (use s, ms, us or ns)`, trigger);
        }
        const amount = this.evaluator.evaluate(trigger.value);
        if (typeof amount !== 'bigint' && typeof amount !== 'number') {
            throw new SimulationError('The duration of a time event must be a number', trigger);
        }
        const duration = Math.round(Number(amount) * factor);
        if (trigger.kind === 'every' && duration <= 0) {
            throw new SimulationError(`The period of 'every' must be positive but is ${duration} ns`, trigger);
        }
        this.timers.set(trigger, {
            trigger,
            state,
            due: this.now + Math.max(0, duration),
            period: trigger.kind === 'every' ? duration : undefined,
            sequence: this.shared.timerSequence++
        });
    }

    /** Timers expired at the current time, in expiry order. */
    private expiredTimers(): Timer[] {
        return [...this.timers.values()].filter(t => t.due <= this.now).sort(compareTimers);
    }

    /** The next timer (of the machine or one of its instances) expiring until `until`, and its interpreter. */
    private nextTimer(until: number): { timer: Timer, interpreter: StatechartInterpreter } | undefined {
        const candidates = this.allInterpreters().flatMap(interpreter => [...interpreter.timers.values()]
            .filter(t => t.due <= until).map(timer => ({ timer, interpreter })));
        return candidates.sort((a, b) => compareTimers(a.timer, b.timer))[0];
    }

    /** Removes a fired `after` timer, reschedules an `every` timer after the current time. */
    private expire(timer: Timer): void {
        if (timer.period === undefined) {
            this.timers.delete(timer.trigger);
        } else {
            while (timer.due <= this.now) {
                timer.due += timer.period;
            }
        }
    }

    private ownerOfTrigger(trigger: ast.TimeTrigger): string {
        let node: AstNode | undefined = trigger;
        while (node && !ast.isState(node) && !ast.isTransition(node) && !ast.isStateMachine(node)) {
            node = node.$container;
        }
        if (node && ast.isStateMachine(node)) {
            return node.name;
        }
        if (node && ast.isTransition(node)) {
            return node.source?.ref?.name ?? '?';
        }
        return node && ast.isState(node) ? node.name : '?';
    }

    // -----------------------------------------------------------------------------------------
    // Data

    private resetData(): void {
        this.values.clear();
        this.variableTypes.clear();
        for (const variable of this.index.variables()) {
            const type = declaredType(variable.type);
            this.variableTypes.set(variable, type);
            this.values.set(variable, defaultValueOf(type) ?? 0n);
        }
        this.eventValues.clear();
        for (const event of this.index.events()) {
            this.eventValues.set(event, defaultValueOf(declaredType(event.type) ?? 'void'));
        }
    }

    /** Resets the configuration, history, timers, events and data (also of all instances) before `enter()`. */
    private resetRuntime(): void {
        for (const interpreter of this.allInterpreters()) {
            interpreter.resetData();
            interpreter.active.clear();
            interpreter.history.clear();
            interpreter.timers.clear();
            interpreter.collected.clear();
            interpreter.present.clear();
            interpreter.presentTimers.clear();
            interpreter.outOccurrences.clear();
            if (interpreter !== this) {
                interpreter.instanceActive = false;
                interpreter.running = false;
            }
        }
    }

    /**
     * Initializes the variables with initial values in declaration order; the variables of an instance
     * are initialized where the instance is declared. Instances keep their data when they are exited
     * and entered again (docs/semantics.md §9).
     */
    private initializeVariables(): void {
        for (const declaration of this.index.declarationsInOrder()) {
            const instance = ast.isVariableDeclaration(declaration) ? this.instances.get(declaration) : undefined;
            if (instance) {
                instance.initializeVariables();
                continue;
            }
            if (!ast.isVariableDeclaration(declaration) || !declaration.initialValue || this.index.isInstance(declaration)) {
                continue;
            }
            const value = this.evaluator.evaluate(declaration.initialValue);
            const type = declaredType(declaration.type) ?? runtimeTypeOfValue(value);
            this.variableTypes.set(declaration, type);
            this.values.set(declaration, convert(value, type, `Initial value of '${declaration.name}'`, declaration)!);
        }
    }

    /**
     * Whether an event is present. An out event of an instance is visible to the parent from the moment
     * it is raised until the end of the next step, but every trigger (or expression) of the parent sees
     * it only once: in the next step, it is not visible to those that tested it in the step it was
     * raised in (docs/semantics.md §9).
     */
    private isEventPresent(event: ast.EventDeclaration, node: AstNode | undefined): boolean {
        const owner = this.owner(event, node);
        if (owner === this) {
            return this.present.has(event);
        }
        const occurrence = owner.outOccurrences.get(event);
        if (!occurrence || !node) {
            return false;
        }
        if (occurrence.step === this.shared.stepNumber) {
            occurrence.seen.add(node);
            return true;
        }
        return !occurrence.seen.has(node);
    }

    private createContext(): EvaluationContext {
        return {
            getVariable: (variable, node) => this.owner(variable, node).values.get(variable) ?? 0n,
            assignVariable: (variable, value, node, reference) => {
                if (variable.const) {
                    throw new SimulationError(`Cannot assign to constant '${variable.name}'`, node);
                }
                const owner = this.owner(variable, reference ?? node);
                const converted = convert(value, owner.variableTypes.get(variable), `Assignment to '${variable.name}'`, node)!;
                owner.values.set(variable, converted);
                return converted;
            },
            isEventPresent: (event, node) => this.isEventPresent(event, node),
            eventValue: (event, node) => this.owner(event, node).eventValues.get(event),
            isActive: (vertex, node) => {
                const owner = this.owner(vertex, node);
                return ast.isState(vertex) && (owner === this || owner.instanceActive) && owner.isStateActive(vertex);
            },
            callOperation: (operation, args, node) => this.callOperation(operation, args, node),
            raiseEvent: (event, value, node) => {
                const owner = this.owner(event, node);
                if (owner === this) {
                    this.raiseFromMachine(event, value);
                } else {
                    owner.receive(event, value);
                }
            }
        };
    }

    private callOperation(operation: ast.OperationDeclaration, args: Value[], node: AstNode): Value | undefined {
        const name = this.prefix + this.index.declarationName(operation);
        // operations of instances are implemented by the host under their full name (`motor.setPwm`)
        const operations = this.root.operations;
        const implementation = operations[name] ?? (this.context ? undefined : operations[operation.name]);
        const returnType = declaredType(operation.returnType) ?? (operation.returnType ? undefined : 'void');
        const hostArgs = args.map(a => toHost(a)!);
        let result: Value | undefined;
        if (implementation) {
            let raw: unknown;
            try {
                raw = implementation(...hostArgs);
            } catch (error) {
                throw new SimulationError(`Operation '${name}' failed: ${error instanceof Error ? error.message : String(error)}`, node);
            }
            result = fromHost(raw, returnType, `Result of operation '${name}'`, node);
        } else {
            result = defaultValueOf(returnType);
        }
        this.emit({ kind: 'call', operation: name, args: hostArgs, result: toHost(result), text: `${name}(${args.map(formatValue).join(', ')})` });
        return result;
    }

    private raiseFromMachine(event: ast.EventDeclaration, value: Value | undefined): void {
        const name = this.prefix + this.index.declarationName(event);
        const direction = this.index.eventDirection(event);
        if (value !== undefined) {
            this.eventValues.set(event, value);
        }
        const text = formatCall(name, value === undefined ? [] : [value]);
        this.emit({ kind: 'raise', event: name, direction, value: toHost(value), text }, false);
        if (direction === 'out' && this.context) {
            // an out event of an instance is observed by its parent (docs/semantics.md §9)
            this.outOccurrences.set(event, { step: this.shared.stepNumber, seen: new Set() });
            if (this.executionMode === 'event' && !this.shared.internalQueue.some(e => e.event === undefined)) {
                this.shared.internalQueue.push({ target: this.root });
            }
        } else if (direction === 'out') {
            const outEvent: OutEvent = value === undefined ? { name, text } : { name, value: toHost(value), text };
            this.lastOutEvents.push(outEvent);
            this.options.onOutEvent?.(outEvent);
        } else if (this.executionMode === 'cycle') {
            (this.inStep ? this.present : this.collected).add(event);
        } else {
            this.shared.internalQueue.push({ target: this, event });
        }
    }

    private isStateActive(state: ast.State): boolean {
        return this.active.get(this.index.regionOf(state)) === state;
    }

    private resolveState(name: string): ast.State {
        const state = this.index.findState(name);
        if (!state) {
            throw new SimulationError(`Unknown or ambiguous state '${name}' in state machine '${this.machine.name}'`);
        }
        return state;
    }

    private resolveVariable(name: string): ast.VariableDeclaration {
        const variable = this.index.findVariable(name);
        if (variable && this.index.isInstance(variable)) {
            throw new SimulationError(`'${name}' is a submachine instance, not a variable`, variable);
        }
        if (!variable) {
            throw new SimulationError(`Unknown variable '${name}' in state machine '${this.machine.name}'`);
        }
        return variable;
    }

    private regionName(region: RegionNode): string {
        if (ast.isStateMachine(region)) {
            return `state machine '${region.name}'`;
        }
        if (ast.isState(region)) {
            return `state '${this.index.stateName(region)}'`;
        }
        const owner = region.$container;
        return region.name ? `region '${region.name}' of '${this.index.stateName(owner)}'`
            : `region #${owner.regions.indexOf(region) + 1} of '${this.index.stateName(owner)}'`;
    }

    /** Evaluates a guard (`undefined` is `true`) and reports the result to `onGuard`. */
    private guard(expression: ast.Expression | undefined): boolean {
        const value = this.evaluator.guard(expression);
        if (expression) {
            this.options.onGuard?.(expression, value);
        }
        return value;
    }

    /** Adds an entry to the trace (of the top-level machine); names of instances are prefixed (`motor.On`) unless `prefix` is false. */
    private emit(entry: TraceEntry, prefix = true): void {
        if (this.context) {
            this.root.emit(prefix ? prefixEntry(entry, this.prefix) : entry);
            return;
        }
        this.lastTrace.push(entry);
        this.options.onTrace?.(entry);
    }
}

/** A trace entry of a submachine instance with its names prefixed by the instance name (`motor.On`). */
function prefixEntry(entry: TraceEntry, prefix: string): TraceEntry {
    switch (entry.kind) {
        case 'enter':
        case 'exit':
        case 'final':
        case 'reaction':
            // '' denotes the state machine of the instance itself (its own reactions)
            return { ...entry, state: entry.state === '' ? prefix.slice(0, -1) : prefix + entry.state };
        case 'transition':
            return { ...entry, source: prefix + entry.source, target: prefix + entry.target };
        case 'call':
            return entry;
        default:
            return entry;
    }
}

function isJoin(vertex: ast.Vertex, index: ModelIndex): vertex is ast.PseudoState {
    return ast.isPseudoState(vertex) && vertex.kind === 'sync' && index.incoming(vertex).length > 1;
}

function hasBuiltinTrigger(reaction: ast.LocalReaction, kind: 'entry' | 'exit'): boolean {
    return reaction.triggers.some(t => ast.isBuiltinTrigger(t) && t.kind === kind);
}

function compareTimers(a: Timer, b: Timer): number {
    return a.due - b.due || a.sequence - b.sequence;
}

function toNanos(ms: number): number {
    if (!(ms >= 0) || !Number.isFinite(ms)) {
        throw new SimulationError(`Invalid time span ${ms} ms`);
    }
    return Math.round(ms * NS_PER_MS);
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
