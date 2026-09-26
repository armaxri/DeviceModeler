import type { AstNode } from 'langium';
import * as ast from '../generated/ast.js';
import { transitionLabel, nodeText } from '../model-utils.js';
import type { EventDirection } from '../hsm-typesystem.js';
import { SimulationError } from './errors.js';
import { ExpressionEvaluator, type EvaluationContext } from './expressions.js';
import {
    isFinalState, ModelIndex, type ActiveVertex, type FinalState, type RegionNode, type TargetVertex
} from './model-index.js';
import {
    convert, defaultValueOf, formatCall, formatValue, fromHost, toHost, declaredType, typeOfValue, type HostValue, type TypeName, type Value
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
    | { readonly kind: 'final'; readonly state: string }
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
    private readonly maxMicrosteps: number;
    private readonly evaluator: ExpressionEvaluator;

    private readonly active = new Map<RegionNode, ActiveVertex>();
    private readonly history = new Map<RegionNode, ActiveVertex>();
    private readonly values = new Map<ast.VariableDeclaration, Value>();
    private readonly variableTypes = new Map<ast.VariableDeclaration, TypeName | undefined>();
    private readonly eventValues = new Map<ast.EventDeclaration, Value | undefined>();
    private readonly timers = new Map<ast.TimeTrigger, Timer>();
    private timerSequence = 0;

    /** Events present in the current step. */
    private readonly present = new Set<ast.EventDeclaration>();
    private readonly presentTimers = new Set<ast.TimeTrigger>();
    /** Cycle based: events collected for the next cycle. */
    private readonly collected = new Set<ast.EventDeclaration>();
    /** Event driven: internal events waiting for their step. */
    private readonly internalQueue: ast.EventDeclaration[] = [];
    /** Event driven: in events raised by the host while a step is running. */
    private readonly hostQueue: ast.EventDeclaration[] = [];

    private readonly enteredInStep = new Set<ast.State>();
    private readonly exitedInStep = new Set<ast.State>();
    private microsteps = 0;
    private inStep = false;
    private busy = false;
    private running = false;

    private now = 0;
    private enterTime = 0;
    private nextCycle = 0;

    private lastTrace: TraceEntry[] = [];
    private lastOutEvents: OutEvent[] = [];

    constructor(machine: ast.StateMachine, options: SimulationOptions = {}) {
        this.machine = machine;
        this.options = options;
        this.operations = { ...options.operations };
        this.maxMicrosteps = options.maxMicrosteps ?? 1000;
        this.index = new ModelIndex(machine);
        this.evaluator = new ExpressionEvaluator(this.createContext());
        const annotation = (name: string) => machine.annotations.find(a => a.name === name);
        this.executionMode = annotation('EventDriven') && !annotation('CycleBased') ? 'event' : 'cycle';
        this.executionOrder = annotation('ChildFirstExecution') ? 'child-first' : 'parent-first';
        const period = annotation('CycleBased')?.arguments[0];
        this.cyclePeriod = period ? Number(this.evaluator.evaluate(period)) : 200;
        if (!(this.cyclePeriod > 0)) {
            throw new SimulationError(`Invalid cycle period ${this.cyclePeriod}`, period);
        }
        this.resetData();
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
        this.hostCall(() => {
            this.resetData();
            this.active.clear();
            this.history.clear();
            this.timers.clear();
            this.collected.clear();
            this.internalQueue.length = 0;
            this.running = true;
            this.enterTime = this.now;
            this.nextCycle = this.now + this.cyclePeriod * NS_PER_MS;
            for (const variable of this.index.variables()) {
                if (variable.initialValue) {
                    const value = this.evaluator.evaluate(variable.initialValue);
                    const type = declaredType(variable.type) ?? typeOfValue(value);
                    this.variableTypes.set(variable, type);
                    this.values.set(variable, convert(value, type, `Initial value of '${variable.name}'`, variable)!);
                }
            }
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
        return this.isStateActive(typeof state === 'string' ? this.resolveState(state) : state);
    }

    /**
     * Raises an in event (`open` or `Iface.open`) with an optional value. Cycle based: the event is
     * collected for the next {@link runCycle}. Event driven: a step (plus the steps for queued
     * internal events) is performed immediately.
     */
    raise(eventName: string, value?: unknown): void {
        const event = this.index.findEvent(eventName);
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
                const timer = this.nextTimer(end);
                if (!timer) {
                    break;
                }
                this.now = timer.due;
                this.expire(timer);
                this.processEvent(undefined, timer.trigger);
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

    /** Current value of a variable or constant (`x` or `Iface.x`). */
    getVariable(name: string): HostValue | undefined {
        return toHost(this.values.get(this.resolveVariable(name)));
    }

    /** Sets a variable (`x` or `Iface.x`). Constants and `readonly` variables cannot be set by the host. */
    setVariable(name: string, value: unknown): void {
        const variable = this.resolveVariable(name);
        if (variable.const || variable.readonly) {
            throw new SimulationError(`'${name}' is ${variable.const ? 'a constant' : 'read-only'} and cannot be set by the host`, variable);
        }
        this.values.set(variable, fromHost(value, this.variableTypes.get(variable), `Value of '${name}'`, variable)!);
    }

    /** Snapshot of all variables and constants by declared name (`x`, `Iface.x`). */
    get variables(): Record<string, HostValue> {
        const result: Record<string, HostValue> = {};
        for (const variable of this.index.variables()) {
            result[this.index.declarationName(variable)] = toHost(this.values.get(variable))!;
        }
        return result;
    }

    /** Value of the last occurrence of an event (as `valueof(e)` in the model). */
    getEventValue(name: string): HostValue | undefined {
        const event = this.index.findEvent(name);
        if (!event) {
            throw new SimulationError(`Unknown event '${name}' in state machine '${this.machine.name}'`);
        }
        return toHost(this.eventValues.get(event));
    }

    /** Fully qualified names of all active states in document order (parents before children). */
    get activeStates(): string[] {
        return this.activeStateNodes().map(s => this.index.stateName(s));
    }

    /** Fully qualified names of the active states without active sub states. */
    get activeLeafStates(): string[] {
        return this.activeStateNodes()
            .filter(s => !this.index.regionsOf(s).some(r => ast.isState(this.active.get(r))))
            .map(s => this.index.stateName(s));
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
        for (const timer of this.expiredTimers()) {
            this.presentTimers.add(timer.trigger);
            this.expire(timer);
        }
        this.step();
    }

    /** Event driven: a step with the given event or time event (or none) present. */
    private processEvent(event: ast.EventDeclaration | undefined, timer?: ast.TimeTrigger): void {
        if (this.isFinal() || !this.running) {
            return;
        }
        if (event) {
            this.present.add(event);
        }
        if (timer) {
            this.presentTimers.add(timer);
        }
        this.step();
    }

    /** Event driven: processes queued internal events, then in events raised meanwhile by the host. */
    private drainQueues(): void {
        let steps = 0;
        for (;;) {
            const event = this.internalQueue.shift() ?? this.hostQueue.shift();
            if (!event) {
                return;
            }
            if (++steps > this.maxMicrosteps) {
                throw new SimulationError(`More than ${this.maxMicrosteps} queued event steps; the state machine seems to loop (last event '${event.name}')`, event);
            }
            this.processEvent(event);
        }
    }

    private step(): void {
        this.beginStep();
        this.inStep = true;
        const events = [...this.present].map(e => this.index.declarationName(e));
        for (const trigger of this.presentTimers) {
            events.push(`${nodeText(trigger)}@${this.ownerOfTrigger(trigger)}`);
        }
        this.emit({ kind: 'step', time: this.time, events });
        try {
            this.runLocalReactions(this.machine);
            const top = this.active.get(this.machine);
            if (top && ast.isState(top)) {
                this.react(top);
            }
        } finally {
            this.inStep = false;
            this.present.clear();
            this.presentTimers.clear();
        }
    }

    private beginStep(): void {
        this.enteredInStep.clear();
        this.exitedInStep.clear();
        this.microsteps = 0;
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
            if (this.enabled(reaction.triggers, reaction.guard)) {
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
                return event !== undefined && this.present.has(event);
            }
            if (ast.isTimeTrigger(trigger)) {
                return this.presentTimers.has(trigger);
            }
            return trigger.kind === 'always' || trigger.kind === 'oncycle';
        });
        return matches && this.evaluator.guard(guard);
    }

    private executeReaction(reaction: ast.LocalReaction, state: ast.State | ast.StateMachine): void {
        const name = ast.isState(state) ? this.index.stateName(state) : state.name;
        this.emit({ kind: 'reaction', node: reaction, state: name, label: nodeText(reaction) });
        this.evaluator.execute(reaction.effect);
    }

    /** Executes the `entry` or `exit` reactions of a state (or of the state machine) whose guard holds. */
    private runBuiltinReactions(state: ast.State | ast.StateMachine, kind: 'entry' | 'exit'): void {
        for (const reaction of state.reactions) {
            if (hasBuiltinTrigger(reaction, kind) && this.evaluator.guard(reaction.guard)) {
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
        this.enterInRegion(scope, [{ vertex: target, entryPoint: transition.entryPoint }]);
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
            this.enterStateCore(vertex);
            const entry = target.entryPoint ? this.index.findPseudo(vertex, 'entry', target.entryPoint) : undefined;
            if (target.entryPoint && !entry) {
                throw new SimulationError(`State '${vertex.name}' has no entry point '${target.entryPoint}'`, vertex);
            }
            for (const region of this.index.regionsOf(vertex)) {
                if (entry && this.index.regionOf(entry) === region) {
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
        this.emit({ kind: 'final', state: this.index.vertexName(final) });
    }

    /** Marks a state active, executes its entry reactions and starts its timers. */
    private enterStateCore(state: ast.State): void {
        this.active.set(this.index.regionOf(state), state);
        this.enteredInStep.add(state);
        this.emit({ kind: 'enter', state: this.index.stateName(state), node: state });
        this.runBuiltinReactions(state, 'entry');
        for (const trigger of this.index.timeTriggers(state)) {
            this.startTimer(trigger, state);
        }
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
        this.enterInRegion(scope, [{ vertex: target, entryPoint: initial.entryPoint }]);
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
        const chosen = outgoing.find(t => !isDefault(t) && this.evaluator.guard(t.spec?.guard))
            ?? outgoing.find(t => isDefault(t) && this.evaluator.guard(t.spec?.guard));
        if (!chosen) {
            throw new SimulationError(`${capitalize(choice.kind)} '${choice.name}' has no enabled outgoing transition`, choice);
        }
        this.takeTransition(chosen, choice);
    }

    private takeEntryPoint(entry: ast.PseudoState): void {
        const transition = this.index.outgoing(entry).find(t => this.evaluator.guard(t.spec?.guard));
        if (!transition) {
            throw new SimulationError(`Entry point '${entry.name}' has no enabled outgoing transition`, entry);
        }
        this.takeTransition(transition, entry);
    }

    /** Exit node `X`: the owning composite state is left by its `# X>` transition. */
    private takeExitNode(exitNode: ast.PseudoState): void {
        const owner = this.index.ownerState(this.index.regionOf(exitNode));
        const transition = owner
            ? this.index.exitTransitions(owner, exitNode.name).find(t => this.evaluator.guard(t.spec?.guard))
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
        const targets = outgoing.map(t => ({ vertex: this.index.targetOf(t), entryPoint: t.entryPoint }));
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
            sequence: this.timerSequence++
        });
    }

    /** Timers expired at the current time, in expiry order. */
    private expiredTimers(): Timer[] {
        return [...this.timers.values()].filter(t => t.due <= this.now).sort(compareTimers);
    }

    private nextTimer(until: number): Timer | undefined {
        return [...this.timers.values()].filter(t => t.due <= until).sort(compareTimers)[0];
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

    private createContext(): EvaluationContext {
        return {
            getVariable: variable => this.values.get(variable) ?? 0n,
            assignVariable: (variable, value, node) => {
                if (variable.const) {
                    throw new SimulationError(`Cannot assign to constant '${variable.name}'`, node);
                }
                const converted = convert(value, this.variableTypes.get(variable), `Assignment to '${variable.name}'`, node)!;
                this.values.set(variable, converted);
                return converted;
            },
            isEventPresent: event => this.present.has(event),
            eventValue: event => this.eventValues.get(event),
            isActive: vertex => ast.isState(vertex) && this.isStateActive(vertex),
            callOperation: (operation, args, node) => this.callOperation(operation, args, node),
            raiseEvent: (event, value) => this.raiseFromMachine(event, value)
        };
    }

    private callOperation(operation: ast.OperationDeclaration, args: Value[], node: AstNode): Value | undefined {
        const name = this.index.declarationName(operation);
        const implementation = this.operations[name] ?? this.operations[operation.name];
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
        const name = this.index.declarationName(event);
        const direction = this.index.eventDirection(event);
        if (value !== undefined) {
            this.eventValues.set(event, value);
        }
        const text = formatCall(name, value === undefined ? [] : [value]);
        this.emit({ kind: 'raise', event: name, direction, value: toHost(value), text });
        if (direction === 'out') {
            const outEvent: OutEvent = value === undefined ? { name, text } : { name, value: toHost(value), text };
            this.lastOutEvents.push(outEvent);
            this.options.onOutEvent?.(outEvent);
        } else if (this.executionMode === 'cycle') {
            (this.inStep ? this.present : this.collected).add(event);
        } else {
            this.internalQueue.push(event);
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

    private emit(entry: TraceEntry): void {
        this.lastTrace.push(entry);
        this.options.onTrace?.(entry);
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
