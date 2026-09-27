import { AstUtils, type AstNode } from 'langium';
import {
    StatechartInterpreter, declaredType, formatTraceEntry, instanceMachine, instanceVariables, isInstance, isInterfaceScope, isOperationDeclaration, isState, isTransition,
    referableName,
    type EventDeclaration, type HostValue, type OperationDeclaration, type RuntimeType, type State, type StateMachine, type TraceEntry, type Transition,
    type VariableDeclaration
} from 'hsm-language';
import { defaultHostValue } from '../ui/value-editor.js';

export { defaultHostValue };

/** One line of the simulation log (trace entries of the interpreter). */
export interface LogEntry {
    readonly id: number;
    /** Virtual time in ms. */
    readonly time: number;
    readonly kind: TraceEntry['kind'] | 'info';
    readonly text: string;
    /** Model element to reveal when the entry is clicked. */
    readonly node?: AstNode;
}

/** An out event raised by the state machine. */
export interface OutEventRecord {
    readonly id: number;
    readonly time: number;
    readonly text: string;
}

/** An operation call of the state machine. */
export interface CallRecord {
    readonly id: number;
    readonly time: number;
    readonly text: string;
}

/** Mocked implementation of an operation: returns a fixed value set in the simulation panel. */
export interface OperationMock {
    readonly name: string;
    readonly declaration: OperationDeclaration;
    readonly returnType: RuntimeType;
    value: HostValue | undefined;
    calls: number;
}

export interface EventInfo {
    readonly name: string;
    readonly declaration: EventDeclaration;
    readonly type: RuntimeType;
    /** Interface name (`''` for the unnamed interface). */
    readonly group: string;
}

export interface VariableInfo {
    readonly name: string;
    readonly declaration: VariableDeclaration;
    /** `interface`, `interface Name` or `internal`. */
    readonly group: string;
    readonly editable: boolean;
}

/** What changed in a simulation update (used to re-render only the affected parts). */
export interface SimulationChange {
    /** The machine was executed: states, variables, logs may have changed. */
    executed: boolean;
}

export interface SessionListener {
    changed(change: SimulationChange): void;
}

const MAX_LOG = 400;
const MAX_RECORDS = 200;
/** Wall-clock time a real-time frame may cover at most (e.g. after the tab was in the background). */
const MAX_FRAME_MS = 250;

/**
 * A running simulation of a state machine in the web editor: wraps the {@link StatechartInterpreter}
 * and adds what the simulation panel needs – logs, operation mocks, pending events, a real-time
 * clock driven by `requestAnimationFrame`, breakpoints and error handling.
 */
export class SimulationSession {

    sim!: StatechartInterpreter;
    readonly machine: StateMachine;
    readonly events: EventInfo[];
    readonly variables: VariableInfo[];
    readonly operations: OperationMock[];

    log: LogEntry[] = [];
    outEvents: OutEventRecord[] = [];
    calls: CallRecord[] = [];
    /** Cycle based: in events raised since the last run cycle. */
    readonly pending: string[] = [];
    /** Transitions taken, with the wall-clock time (ms, `performance.now()`) they were last taken. */
    readonly recentTransitions = new Map<Transition, number>();
    /** States and transitions with a breakpoint (kept across restarts). */
    readonly breakpoints = new Set<AstNode>();
    /** Wall-clock time (ms) at which the value of a variable last changed. */
    readonly changedVariables = new Map<string, number>();
    /** The last error of the interpreter; the simulation must be restarted. */
    error?: { message: string, node?: AstNode };
    /** Message of the last breakpoint that paused real-time mode. */
    breakpointHit?: { message: string, node: AstNode };

    /** Raise cycle based events and run a cycle immediately (when not in real-time mode). */
    autoCycle = true;
    /** Factor between wall-clock time and virtual time in real-time mode. */
    speed = 1;

    private playing = false;
    private frame?: number;
    private lastFrame = 0;
    private counter = 0;
    /** Values after the last host action; `undefined` while entering (initial values do not flash). */
    private lastValues?: Record<string, HostValue>;
    private hitDuringCall?: { message: string, node: AstNode };

    constructor(machine: StateMachine, private readonly listener: SessionListener) {
        this.machine = machine;
        const declarations = machine.scopes.flatMap(scope => scope.declarations.map(declaration => ({ scope, declaration })));
        const qualified = (d: { scope: StateMachine['scopes'][number], declaration: { name: string } }) =>
            isInterfaceScope(d.scope) && d.scope.name ? `${d.scope.name}.${d.declaration.name}` : d.declaration.name;
        const groupOf = (scope: StateMachine['scopes'][number]) =>
            isInterfaceScope(scope) ? (scope.name ? `interface ${scope.name}` : 'interface') : 'internal';
        this.events = declarations
            .filter(d => d.declaration.$type === 'EventDeclaration' && isInterfaceScope(d.scope) && (d.declaration as EventDeclaration).direction !== 'out')
            .map(d => ({
                name: qualified(d),
                declaration: d.declaration as EventDeclaration,
                type: declaredType((d.declaration as EventDeclaration).type) ?? 'void',
                group: isInterfaceScope(d.scope) && d.scope.name ? d.scope.name : ''
            }));
        this.variables = declarations
            .filter(d => d.declaration.$type === 'VariableDeclaration' && !isInstance(d.declaration))
            .map(d => {
                const variable = d.declaration as VariableDeclaration;
                return { name: qualified(d), declaration: variable, group: groupOf(d.scope), editable: !variable.const && !variable.readonly };
            });
        this.operations = declarations
            .filter(d => isOperationDeclaration(d.declaration))
            .map(d => {
                const operation = d.declaration as OperationDeclaration;
                const returnType = declaredType(operation.returnType) ?? 'void';
                return { name: qualified(d), declaration: operation, returnType, value: defaultHostValue(returnType), calls: 0 };
            });
        // variables and operations of the submachine instances (`motor.speed`, `motor.setPwm`), also nested ones
        const addInstances = (owner: StateMachine, prefix: string, depth: number) => {
            for (const instance of depth < 8 ? instanceVariables(owner) : []) {
                const submachine = instanceMachine(instance)!;
                const name = `${prefix}${referableName(instance)}`;
                for (const scope of submachine.scopes) {
                    for (const declaration of scope.declarations) {
                        const member = `${name}.${qualified({ scope, declaration })}`;
                        if (declaration.$type === 'VariableDeclaration' && !isInstance(declaration)) {
                            const variable = declaration as VariableDeclaration;
                            this.variables.push({ name: member, declaration: variable, group: `instance ${name} : ${submachine.name}`, editable: !variable.const && !variable.readonly });
                        } else if (isOperationDeclaration(declaration)) {
                            const returnType = declaredType(declaration.returnType) ?? 'void';
                            this.operations.push({ name: member, declaration, returnType, value: defaultHostValue(returnType), calls: 0 });
                        }
                    }
                }
                addInstances(submachine, `${name}.`, depth + 1);
            }
        };
        addInstances(machine, '', 0);
        this.restart();
    }

    get executionMode(): 'cycle' | 'event' {
        return this.sim.executionMode;
    }

    get isPlaying(): boolean {
        return this.playing;
    }

    /** Creates a fresh interpreter and enters the state machine. Breakpoints and operation results are kept. */
    restart(): void {
        this.pause();
        this.log = [];
        this.outEvents = [];
        this.calls = [];
        this.pending.length = 0;
        this.recentTransitions.clear();
        this.changedVariables.clear();
        this.error = undefined;
        this.breakpointHit = undefined;
        this.operations.forEach(op => op.calls = 0);
        try {
            this.sim = new StatechartInterpreter(this.machine, {
                onTrace: entry => this.traced(entry),
                onOutEvent: event => this.outEvents.push({ id: this.counter++, time: this.sim.time, text: event.text })
            });
        } catch (error) {
            this.fail(error);
            this.listener.changed({ executed: true });
            return;
        }
        for (const operation of this.operations) {
            this.sim.setOperation(operation.name, () => {
                operation.calls++;
                return operation.value;
            });
        }
        this.lastValues = undefined;
        this.execute(() => this.sim.enter());
    }

    // -----------------------------------------------------------------------------------------
    // Host actions

    /** Cycle based: runs one cycle; event driven: performs a step without events. */
    runCycle(): void {
        this.execute(() => {
            this.sim.runCycle();
            this.pending.length = 0;
        });
    }

    /** Advances the virtual clock, running the cycles resp. firing the timers that are due. */
    advanceTime(ms: number): void {
        this.execute(() => this.runChunked(ms));
    }

    raise(name: string, value?: HostValue): void {
        const cycleBased = this.sim.executionMode === 'cycle';
        this.execute(() => {
            this.sim.raise(name, value);
            if (cycleBased) {
                if (this.autoCycle && !this.playing) {
                    this.sim.runCycle();
                } else if (!this.pending.includes(name)) {
                    this.pending.push(name);
                }
            }
        });
    }

    setVariable(name: string, value: HostValue): void {
        this.execute(() => this.sim.setVariable(name, value));
    }

    setOperationResult(operation: OperationMock, value: HostValue): void {
        operation.value = value;
    }

    // -----------------------------------------------------------------------------------------
    // Real-time mode

    play(): void {
        if (this.playing || this.error || !this.sim?.isRunning) {
            return;
        }
        this.playing = true;
        this.breakpointHit = undefined;
        this.lastFrame = performance.now();
        this.frame = requestAnimationFrame(now => this.tick(now));
        this.listener.changed({ executed: false });
    }

    pause(): void {
        if (!this.playing) {
            return;
        }
        this.playing = false;
        if (this.frame !== undefined) {
            cancelAnimationFrame(this.frame);
            this.frame = undefined;
        }
        this.listener.changed({ executed: false });
    }

    dispose(): void {
        this.pause();
    }

    private tick(now: number): void {
        if (!this.playing) {
            return;
        }
        const elapsed = Math.min(Math.max(now - this.lastFrame, 0), MAX_FRAME_MS);
        this.lastFrame = now;
        const virtual = elapsed * this.speed;
        if (virtual > 0) {
            this.execute(() => this.runChunked(virtual));
        }
        if (this.playing) {
            this.frame = requestAnimationFrame(t => this.tick(t));
        }
    }

    /**
     * Advances the clock in chunks of at most one cycle period, so that real-time mode stops right
     * after the cycle (or timer) that hit a breakpoint.
     */
    private runChunked(ms: number): void {
        let remaining = ms;
        const chunk = this.sim.cyclePeriod;
        while (remaining > 1e-9) {
            const span = Math.min(remaining, chunk);
            this.sim.runFor(span);
            remaining -= span;
            if (this.hitDuringCall) {
                return;
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Breakpoints

    toggleBreakpoint(node: AstNode): boolean {
        if (this.breakpoints.has(node)) {
            this.breakpoints.delete(node);
            return false;
        }
        this.breakpoints.add(node);
        return true;
    }

    // -----------------------------------------------------------------------------------------
    // Internals

    /** Runs a host action, records errors and breakpoint hits and notifies the listener. */
    private execute(action: () => void): void {
        if (this.error || !this.sim) {
            return;
        }
        this.hitDuringCall = undefined;
        try {
            action();
        } catch (error) {
            this.fail(error);
        }
        const values = this.sim.variables;
        const now = performance.now();
        for (const [name, value] of Object.entries(values)) {
            // (values of C++ structs and arrays are objects: compared by their JSON text)
            if (this.lastValues && this.lastValues[name] !== value && JSON.stringify(this.lastValues[name]) !== JSON.stringify(value)) {
                this.changedVariables.set(name, now);
            }
        }
        this.lastValues = values;
        if (this.hitDuringCall) {
            this.breakpointHit = this.hitDuringCall;
            this.hitDuringCall = undefined;
            if (this.playing) {
                this.pause();
            }
        }
        this.listener.changed({ executed: true });
    }

    private fail(error: unknown): void {
        const errorNode = error instanceof Error && 'node' in error ? (error as { node?: AstNode }).node : undefined;
        // (elements of submachine instances are defined in other files)
        const node = errorNode && AstUtils.findRootNode(errorNode) === this.machine ? errorNode : undefined;
        this.error = { message: error instanceof Error ? error.message : String(error), node };
        this.addLog({ kind: 'info', text: `error: ${this.error.message}`, node });
        if (this.playing) {
            this.pause();
        }
    }

    private traced(entry: TraceEntry): void {
        // elements of submachine instances are defined in other files: they cannot be shown in the text
        const traced = traceNode(entry);
        const node = traced && AstUtils.findRootNode(traced) === this.machine ? traced : undefined;
        const last = this.log[this.log.length - 1];
        if (entry.kind === 'step' && last?.kind === 'step' && !last.text.includes('[')) {
            // idle cycles without events and without effect are collapsed into the latest one
            this.log.pop();
        }
        this.addLog({ kind: entry.kind, text: formatTraceEntry(entry).trim(), node });
        if (entry.kind === 'step') {
            // the collected events are consumed by this cycle
            this.pending.length = 0;
        } else if (entry.kind === 'transition') {
            this.recentTransitions.set(entry.node, performance.now());
        } else if (entry.kind === 'call') {
            this.calls.push({ id: this.counter++, time: this.sim.time, text: entry.result !== undefined ? `${entry.text} = ${JSON.stringify(entry.result)}` : entry.text });
            trim(this.calls, MAX_RECORDS);
        }
        if (node && this.breakpoints.has(node) && (entry.kind === 'enter' || entry.kind === 'transition') && !this.hitDuringCall) {
            this.hitDuringCall = {
                message: entry.kind === 'enter' ? `Breakpoint: state ${entry.state} entered` : `Breakpoint: transition ${entry.source} -> ${entry.target} taken`,
                node
            };
        }
        trim(this.outEvents, MAX_RECORDS);
    }

    private addLog(entry: Omit<LogEntry, 'id' | 'time'>): void {
        this.log.push({ id: this.counter++, time: this.sim?.time ?? 0, ...entry });
        trim(this.log, MAX_LOG);
    }

    /** The active states (for the diagram animation). */
    activeStates(): State[] {
        return this.sim?.isRunning ? this.sim.activeStateNodes() : [];
    }
}

function trim<T>(list: T[], max: number): void {
    if (list.length > max) {
        list.splice(0, list.length - max);
    }
}

/** The model element a trace entry refers to. */
function traceNode(entry: TraceEntry): AstNode | undefined {
    switch (entry.kind) {
        case 'enter':
        case 'exit':
        case 'transition':
        case 'reaction':
            return entry.node;
        default:
            return undefined;
    }
}

/** Whether the node can get a breakpoint. */
export function canHaveBreakpoint(node: AstNode | undefined): node is State | Transition {
    return isState(node) || isTransition(node);
}
