import type { AstNode } from 'langium';
import {
    ArrayValue, AssertionFailure, formatValue, StructValue, isState, isTransition, type HostValue, type TestDebugHooks, type TestExecutionState, type TestResult,
    type TestStatement, type TraceEntry, type Transition, type Value
} from 'hsm-language';
import { runHsmTests } from '../extension/logic/tests.js';
import { breakpointLine } from './lines.js';
import type {
    BreakpointSettings, DiagramSnapshot, EngineCommand, EngineMessage, EngineStart, FrameSnapshot, ScopeSnapshot, StopReason, StopSnapshot, VariableNode
} from './protocol.js';

/** The connection of the engine to the debug adapter (a worker thread, or a fake in tests). */
export interface EngineHost {
    post(message: EngineMessage): void;
    /** Blocks until the next command of the adapter arrives (the engine is paused meanwhile). */
    waitForCommand(): EngineCommand;
    /** The commands that arrived since the last call, without blocking (called at every pause point). */
    pollCommands(): EngineCommand[];
}

/** Thrown by a hook to abort the execution when the session is terminated. */
export class TerminatedError extends Error {
    constructor() {
        super('The debug session was terminated');
    }
}

type StepMode =
    | { kind: 'continue' }
    | { kind: 'stepIn' }
    /** Stop at the next statement of a frame at most this deep (the call stack of the test). */
    | { kind: 'next', depth: number }
    /** Stop at the next statement of a frame less deep (`orEqual`: a statement of the same frame, after a microstep). */
    | { kind: 'stepOut', depth: number, orEqual: boolean };

/** Trace entries at which `step into` stops (they have a model element to show). */
const MICROSTEP_KINDS: ReadonlySet<TraceEntry['kind']> = new Set(['enter', 'exit', 'final', 'transition', 'reaction']);

const TRACE_SCOPE_LINES = 20;
/** Trace lines per test written to the debug console (the rest is counted). */
const MAX_OUTPUT_LINES = 5000;
/** Trace lines collected before they are sent (fewer messages in loops). */
const OUTPUT_BATCH = 200;

/**
 * Executes the tests of a debug session and decides where to pause: before statements of the tests
 * (stepping, breakpoints in `.hsmtest` files), at microsteps of the interpreter (step into, breakpoints
 * on states, transitions and reactions in `.hsm` files, function breakpoints on state names) and on
 * failed assertions and errors (exception breakpoints). Pausing means blocking in a hook of the test
 * runner until the adapter sends a command that resumes; meanwhile it answers `evaluate` requests.
 */
export class DebugEngine implements TestDebugHooks {

    private mode: StepMode = { kind: 'continue' };
    private pauseRequested = false;
    private terminated = false;
    private stoppedOnEntry = false;
    private breakpoints!: BreakpointSettings;
    /** Source breakpoints by `uri:line`. */
    private sourceBreakpoints = new Map<string, number[]>();
    /** Transitions taken since the previous stop (highlighted in the diagram). */
    private transitions: Transition[] = [];
    /** Events raised during the current statement. */
    private events: Array<{ direction: string, text: string }> = [];
    private trace: string[] = [];
    private counts = { passed: 0, failed: 0, errors: 0 };
    private output: string[] = [];
    private outputLines = 0;
    /** The frames of the current stop (for `evaluate`). */
    private stopFrames: Array<{ locals?: TestExecutionState['stack'][number]['locals'] }> = [];

    constructor(private readonly start: EngineStart, private readonly host: EngineHost) {
        this.setBreakpoints(start.breakpoints);
    }

    async run(): Promise<void> {
        const selectors = this.start.tests;
        const { problems } = await runHsmTests(this.start.models, this.start.testFiles, {
            headers: this.start.headers,
            filter: (uri, testClass, test) => !this.terminated
                && (!selectors || selectors.some(s => s.uri === uri && s.testClass === testClass && (s.test === undefined || s.test === test))),
            onTrace: line => this.onTrace(line),
            onResult: result => this.onResult(result),
            debug: this
        });
        if (!this.terminated) {
            this.flush();
            this.host.post({ type: 'done', ...this.counts, problems });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Hooks of the test runner

    testStarted(execution: TestExecutionState): void {
        this.transitions = [];
        this.events = [];
        this.trace = [];
        this.outputLines = 0;
        this.host.post({ type: 'testStarted', uri: documentUri(execution.test), testClass: execution.testClass.name, test: execution.test.name });
        this.host.post({ type: 'output', category: 'console', text: `▶ ${execution.testClass.name}.${execution.test.name}\n` });
    }

    beforeStatement(statement: TestStatement, execution: TestExecutionState): void {
        this.poll();
        this.events = [];
        if (this.start.noDebug) {
            return;
        }
        const depth = execution.stack.length;
        let reason: StopReason | undefined;
        let hit: number[] | undefined;
        const uri = documentUri(statement);
        const line = breakpointLine(statement);
        const ids = uri && line !== undefined ? this.sourceBreakpoints.get(`${uri}:${line}`) : undefined;
        if (ids) {
            reason = 'breakpoint';
            hit = ids;
        } else if (this.start.stopOnEntry && !this.stoppedOnEntry) {
            reason = 'entry';
        } else if (this.pauseRequested) {
            reason = 'pause';
        } else if (this.mode.kind === 'stepIn'
            || (this.mode.kind === 'next' && depth <= this.mode.depth)
            || (this.mode.kind === 'stepOut' && (depth < this.mode.depth || (this.mode.orEqual && depth === this.mode.depth)))) {
            reason = 'step';
        }
        this.stoppedOnEntry = true;
        if (reason) {
            this.stop(reason, execution, { hit });
        }
    }

    traceEntry(entry: TraceEntry, execution: TestExecutionState): void {
        if (entry.kind === 'transition') {
            this.transitions.push(entry.node);
        } else if (entry.kind === 'raise') {
            this.events.push({ direction: entry.direction, text: entry.text });
        }
        this.poll();
        if (this.start.noDebug || !MICROSTEP_KINDS.has(entry.kind)) {
            return;
        }
        const node = entryNode(entry);
        let reason: StopReason | undefined;
        let hit: number[] | undefined;
        const uri = node && documentUri(node);
        const line = node && (entry.kind !== 'exit') ? breakpointLine(node) : undefined;
        const ids = uri && line !== undefined ? this.sourceBreakpoints.get(`${uri}:${line}`) : undefined;
        const functions = entry.kind === 'enter' ? this.breakpoints.functions.filter(f => sameState(entry.state, f.name)).map(f => f.id) : [];
        if (ids) {
            reason = 'breakpoint';
            hit = ids;
        } else if (functions.length > 0) {
            reason = 'function breakpoint';
            hit = functions;
        } else if (this.pauseRequested || this.mode.kind === 'stepIn') {
            reason = this.pauseRequested ? 'pause' : 'step';
        }
        if (reason) {
            this.stop(reason, execution, { hit, entry });
        }
    }

    failure(error: unknown, _node: AstNode | undefined, execution: TestExecutionState): void {
        if (this.start.noDebug || error instanceof TerminatedError) {
            return;
        }
        const assertion = error instanceof AssertionFailure;
        if (!this.breakpoints.exceptions.includes(assertion ? 'assertion' : 'error')) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.stop('exception', execution, { text: message, assertion });
    }

    testFinished(_result: TestResult, execution: TestExecutionState): void {
        if (!this.terminated && execution.sim) {
            this.host.post({ type: 'diagram', diagram: this.diagram(execution, `${execution.testClass.name}.${execution.test.name}: ${_result.status}`) });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Stops and commands

    private stop(reason: StopReason, execution: TestExecutionState, details: { hit?: number[], entry?: TraceEntry, text?: string, assertion?: boolean }): void {
        this.pauseRequested = false;
        this.flush();
        const snapshot = this.snapshot(reason, execution, details);
        this.transitions = [];
        this.host.post({ type: 'stopped', stop: snapshot });
        for (;;) {
            const command = this.host.waitForCommand();
            switch (command.type) {
                case 'continue':
                    this.mode = { kind: 'continue' };
                    return;
                case 'stepIn':
                    this.mode = { kind: 'stepIn' };
                    return;
                case 'next':
                    this.mode = { kind: 'next', depth: execution.stack.length };
                    return;
                case 'stepOut':
                    // out of a microstep: to the next statement; out of a statement: to the caller
                    this.mode = { kind: 'stepOut', depth: execution.stack.length, orEqual: details.entry !== undefined };
                    return;
                case 'pause':
                    break;
                case 'breakpoints':
                    this.setBreakpoints(command.breakpoints);
                    break;
                case 'evaluate':
                    this.evaluate(command.id, command.expression, command.frame, execution);
                    break;
                case 'terminate':
                    this.terminated = true;
                    throw new TerminatedError();
            }
        }
    }

    /** Commands that arrive while the tests run. */
    private poll(): void {
        for (const command of this.host.pollCommands()) {
            switch (command.type) {
                case 'pause':
                    this.pauseRequested = true;
                    break;
                case 'breakpoints':
                    this.setBreakpoints(command.breakpoints);
                    break;
                case 'evaluate':
                    this.host.post({ type: 'evaluateResult', id: command.id, error: 'The tests are running.' });
                    break;
                case 'terminate':
                    this.terminated = true;
                    throw new TerminatedError();
                default:
                    break;
            }
        }
    }

    private setBreakpoints(breakpoints: BreakpointSettings): void {
        this.breakpoints = breakpoints;
        this.sourceBreakpoints = new Map();
        for (const breakpoint of breakpoints.source) {
            const key = `${breakpoint.uri}:${breakpoint.line}`;
            this.sourceBreakpoints.set(key, [...this.sourceBreakpoints.get(key) ?? [], breakpoint.id]);
        }
    }

    private onTrace(line: string): void {
        if (this.terminated) {
            return;
        }
        this.trace.push(line);
        if (this.trace.length > TRACE_SCOPE_LINES) {
            this.trace.splice(0, this.trace.length - TRACE_SCOPE_LINES);
        }
        if (++this.outputLines <= MAX_OUTPUT_LINES) {
            this.output.push(line);
            if (this.output.length >= OUTPUT_BATCH) {
                this.flush();
            }
        }
    }

    /** Sends the collected trace lines to the debug console. */
    private flush(): void {
        if (this.output.length > 0) {
            this.host.post({ type: 'output', category: 'console', text: this.output.map(line => `${line}\n`).join('') });
            this.output = [];
        }
    }

    private onResult(result: TestResult): void {
        if (this.terminated) {
            return;
        }
        this.counts[result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'errors']++;
        this.flush();
        if (this.outputLines > MAX_OUTPUT_LINES) {
            this.host.post({ type: 'output', category: 'console', text: `… ${this.outputLines - MAX_OUTPUT_LINES} more trace lines not shown\n` });
        }
        this.host.post({ type: 'result', result });
    }

    /**
     * Evaluates a name in a frame (debug console, watch, hover): local variables and parameters, variables
     * of the state machine (`x`, `Iface.x`, `motor.speed`), `active(State)` or a state name, `time` and `is_final`.
     */
    private evaluate(id: number, expression: string, frame: number | undefined, execution: TestExecutionState): void {
        const text = expression.trim();
        const answer = (result: string, type_?: string) => this.host.post({ type: 'evaluateResult', id, result, type_ });
        try {
            const locals = (frame !== undefined ? this.stopFrames[frame]?.locals : undefined) ?? execution.stack[execution.stack.length - 1]?.locals;
            for (const [declaration, value] of locals ?? []) {
                if (declaration.name === text) {
                    answer(formatValue(value));
                    return;
                }
            }
            const sim = execution.sim;
            if (!sim) {
                throw new Error('The state machine has not been created yet.');
            }
            if (text === 'time') {
                answer(`${sim.time} ms`);
                return;
            }
            if (text === 'is_final') {
                answer(String(sim.isRunning && sim.isFinal()), 'boolean');
                return;
            }
            const active = /^active\s*\(\s*(.+?)\s*\)$/.exec(text);
            if (active) {
                answer(String(sim.isActive(active[1])), 'boolean');
                return;
            }
            try {
                const value = sim.getValue(text);
                if (value !== undefined) {
                    answer(formatValue(value));
                    return;
                }
            } catch {
                // not a variable: maybe a state
            }
            try {
                answer(String(sim.isActive(text)), 'boolean');
                return;
            } catch {
                // neither
            }
            throw new Error(`'${text}' is not a variable, parameter or state (supported: names, active(State), time, is_final).`);
        } catch (error) {
            this.host.post({ type: 'evaluateResult', id, error: error instanceof Error ? error.message : String(error) });
        }
    }

    // -----------------------------------------------------------------------------------------
    // Snapshots

    private snapshot(reason: StopReason, execution: TestExecutionState, details: { hit?: number[], entry?: TraceEntry, text?: string, assertion?: boolean }): StopSnapshot {
        const frames: FrameSnapshot[] = [];
        this.stopFrames = [];
        const entry = details.entry;
        const entryElement = entry && entryNode(entry);
        if (entry && entryElement) {
            frames.push({
                name: describeEntry(entry),
                ...location(entryElement),
                kind: 'microstep',
                scopes: [{ name: 'Microstep', variables: entryVariables(entry) }]
            });
            this.stopFrames.push({});
        }
        for (const frame of [...execution.stack].reverse()) {
            const node: AstNode = frame.statement ?? frame.operation;
            const locals: VariableNode[] = [...frame.locals].map(([declaration, value]) => valueNode(declaration.name, value));
            frames.push({
                name: `${execution.testClass.name}.${frame.operation.name}`,
                ...location(node),
                kind: 'statement',
                scopes: [{ name: 'Locals', hint: 'locals', variables: locals }]
            });
            this.stopFrames.push({ locals: frame.locals });
        }
        const description = {
            entry: 'Paused on entry',
            step: 'Paused on step',
            breakpoint: 'Paused on breakpoint',
            'function breakpoint': 'Paused on state breakpoint',
            exception: details.assertion ? 'Paused on assertion failure' : 'Paused on error',
            pause: 'Paused'
        }[reason];
        const where = frames[0] ? `${frames[0].name}${frames[0].uri ? ` (line ${frames[0].line})` : ''}` : '';
        return {
            reason,
            description,
            text: details.text,
            hitBreakpointIds: details.hit,
            frames,
            scopes: this.scopes(execution),
            diagram: execution.sim ? this.diagram(execution, `${description}: ${where}`) : undefined
        };
    }

    private scopes(execution: TestExecutionState): ScopeSnapshot[] {
        const sim = execution.sim;
        const scopes: ScopeSnapshot[] = [];
        if (sim) {
            const leaves = new Set(sim.isRunning ? sim.activeLeafStates : []);
            scopes.push({
                name: 'Active states',
                variables: (sim.isRunning ? sim.activeStates : []).map(name => ({ name, value: leaves.has(name) ? 'active (leaf)' : 'active' }))
            });
            const variables: VariableNode[] = [];
            for (const name of Object.keys(sim.variables)) {
                try {
                    const type = sim.getVariableType(name);
                    variables.push({ ...valueNode(name, sim.getValue(name)), type: typeof type === 'string' ? type : undefined });
                } catch {
                    variables.push({ name, value: '?' });
                }
            }
            scopes.push({ name: 'State machine', hint: 'registers', variables });
            const events: VariableNode[] = [
                ...sim.outEvents.map(e => ({ name: e.name, value: e.value === undefined ? 'raised' : formatHost(e.value), type: 'out event' })),
                ...this.events.filter(e => e.direction !== 'out').map(e => ({ name: e.text, value: `raised (${e.direction})`, type: `${e.direction} event` }))
            ];
            scopes.push({ name: 'Events', variables: events });
        }
        const calls: VariableNode[] = execution.calls.map((call, index) => ({
            name: `[${index + 1}]`, value: `${call.operation}(${call.args.map(formatHost).join(', ')})`
        }));
        const mocks: VariableNode[] = [...execution.mocks].map(([operation, entries]) => ({
            name: operation,
            value: entries.map(m => `${m.args ? `(${m.args.map(a => formatValue(a)).join(', ')}) ` : ''}→ ${formatValue(m.value)}`).join('; ')
        }));
        scopes.push({ name: 'Operation calls', variables: [...calls, ...(mocks.length > 0 ? [{ name: 'mocks', value: `${mocks.length} mocked`, children: mocks }] : [])] });
        scopes.push({
            name: 'Execution',
            variables: [
                { name: 'test', value: `${execution.testClass.name}.${execution.test.name}` },
                { name: 'state machine', value: execution.machine.name },
                ...(sim ? [
                    { name: 'time', value: `${sim.time} ms`, type: 'ms' },
                    { name: 'running', value: String(sim.isRunning), type: 'boolean' },
                    { name: 'is_final', value: String(sim.isRunning && sim.isFinal()), type: 'boolean' },
                    { name: 'execution', value: sim.executionMode === 'cycle' ? `cycle based (${sim.cyclePeriod} ms)` : 'event driven' }
                ] : []),
                { name: 'trace', value: `last ${this.trace.length} lines`, children: this.trace.map((line, index) => ({ name: `[${index + 1}]`, value: line })) }
            ]
        });
        return scopes;
    }

    private diagram(execution: TestExecutionState, title: string): DiagramSnapshot {
        const sim = execution.sim!;
        const modelUri = documentUri(execution.machine) ?? '';
        const inModel = (node: AstNode) => documentUri(node) === modelUri && node.$cstNode !== undefined;
        const running = sim.isRunning;
        return {
            modelUri,
            machine: execution.machine.name,
            activeOffsets: running ? sim.activeStateNodes().filter(inModel).map(state => state.$cstNode!.offset) : [],
            transitionOffsets: this.transitions.filter(inModel).map(transition => transition.$cstNode!.offset),
            instances: running ? sim.activeInstances().filter(i => inModel(i.state)).map(({ state, name, interpreter }) => {
                const prefix = `${name}.`;
                const leaves = sim.activeLeafStates.filter(s => s.startsWith(prefix)).map(s => s.slice(prefix.length));
                return { offset: state.$cstNode!.offset, text: `${name}: ${leaves.length > 0 ? leaves.join(', ') : interpreter.isFinal() ? '[*]' : '–'}` };
            }) : [],
            activeStates: running ? sim.activeStates : [],
            running,
            title
        };
    }
}

/** The model element of a trace entry (states, transitions, reactions, the region of a final state). */
function entryNode(entry: TraceEntry): AstNode | undefined {
    switch (entry.kind) {
        case 'enter':
        case 'exit':
        case 'transition':
        case 'reaction':
            return entry.node;
        case 'final':
            return entry.region as AstNode;
        default:
            return undefined;
    }
}

function describeEntry(entry: TraceEntry): string {
    switch (entry.kind) {
        case 'enter':
            return `enter ${entry.state}`;
        case 'exit':
            return `exit ${entry.state}`;
        case 'final':
            return `enter ${entry.state}`;
        case 'transition':
            return `transition ${entry.source} → ${entry.target}`;
        case 'reaction':
            return `reaction ${entry.state ? `${entry.state}: ` : ''}${entry.label}`;
        default:
            return entry.kind;
    }
}

function entryVariables(entry: TraceEntry): VariableNode[] {
    switch (entry.kind) {
        case 'enter':
        case 'exit':
        case 'final':
            return [{ name: 'kind', value: entry.kind }, { name: 'state', value: entry.state }];
        case 'transition':
            return [{ name: 'kind', value: 'transition' }, { name: 'source', value: entry.source }, { name: 'target', value: entry.target },
                { name: 'label', value: entry.label || '(none)' }];
        case 'reaction':
            return [{ name: 'kind', value: 'reaction' }, { name: 'state', value: entry.state }, { name: 'label', value: entry.label }];
        default:
            return [{ name: 'kind', value: entry.kind }];
    }
}

/** Whether the qualified name of an entered state (`Door.Moving.Up`, `motor.Running`) matches a state breakpoint name. */
export function sameState(state: string, name: string): boolean {
    const wanted = name.trim();
    return wanted.length > 0 && (state === wanted || state.endsWith(`.${wanted}`));
}

function location(node: AstNode): Pick<FrameSnapshot, 'uri' | 'line' | 'column' | 'endLine' | 'endColumn'> {
    const cst = node.$cstNode;
    if (!cst) {
        return { uri: documentUri(node), line: 1, column: 1 };
    }
    // a state: its first line (the end is the end of the line); else the whole element
    const line = breakpointLine(node) ?? cst.range.start.line + 1;
    const start = line === cst.range.start.line + 1 ? cst.range.start.character + 1 : 1;
    const single = isState(node) || isTransition(node) ? undefined : cst.range;
    return {
        uri: documentUri(node),
        line,
        column: start,
        endLine: single ? single.end.line + 1 : undefined,
        endColumn: single ? single.end.character + 1 : undefined
    };
}

/** URI of the document of a node. */
export function documentUri(node: AstNode): string | undefined {
    let root: AstNode = node;
    while (root.$container) {
        root = root.$container;
    }
    return root.$document?.uri.toString();
}

function formatHost(value: HostValue): string {
    return typeof value === 'string' ? JSON.stringify(value) : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** A variable with the members of structured values as children. */
function valueNode(name: string, value: Value | undefined): VariableNode {
    return { name, value: value === undefined ? 'undefined' : formatValue(value), children: childrenOf(value) };
}

function childrenOf(value: Value | undefined): VariableNode[] | undefined {
    if (value instanceof ArrayValue) {
        return value.elements.map((element, index) => valueNode(`[${index}]`, element));
    }
    if (value instanceof StructValue) {
        return [...value.fields].map(([member, element]) => valueNode(member, element));
    }
    return undefined;
}
