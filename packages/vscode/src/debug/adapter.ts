import * as path from 'node:path';
import type { CppHeaderSettings, WorkspaceFile } from 'devm-language';
import type { EngineConnection, EngineFactory } from './connection.js';
import { breakpointLinesOfText, fileKind, verifyBreakpointLine } from './lines.js';
import type {
    BreakpointSettings, EngineMessage, ExceptionFilter, FunctionBreakpoint, ScopeSnapshot, SourceBreakpoint, StopSnapshot, TestSelector, VariableNode
} from './protocol.js';

/*
 * The debug adapter of `.devmtest` tests (Debug Adapter Protocol), used as inline implementation in the
 * extension host (`vscode.DebugAdapterInlineImplementation`). It does not depend on the VS Code API: the
 * files of a launch are provided by an {@link AdapterEnvironment}, the tests run in a {@link DebugEngine}
 * (worker thread). Test results and the state for the diagram are sent as custom events.
 */

/** The attributes of a launch configuration of type `devm-test`. */
export interface LaunchArguments {
    /** The `.devmtest` file (absolute path). */
    program?: string;
    /** Only this test class or test: `TestClass`, `TestClass.test` or `test`. */
    test?: string;
    /** The tests to run (set by the Test Explorer; overrides `program` / `test`). */
    tests?: TestSelector[];
    stopOnEntry?: boolean;
    /** Run without debugging (Ctrl+F5): no stops. */
    noDebug?: boolean;
    /** Identifies the test run of the Test Explorer that started the session. */
    devmTestRun?: string;
}

/** The files of a launch: the test files to run and the models of the workspace. */
export interface LaunchFiles {
    models: WorkspaceFile[];
    testFiles: WorkspaceFile[];
    headers?: CppHeaderSettings;
    tests?: TestSelector[];
}

export interface AdapterEnvironment {
    /** Collects the files of a launch (throws with a message for the user if it cannot be started). */
    prepare(args: LaunchArguments): Promise<LaunchFiles>;
    /** The text of a file (open document or file on disk). */
    readText(uri: string): Promise<string | undefined>;
    pathToUri(fsPath: string): string;
    uriToPath(uri: string): string;
    engine: EngineFactory;
}

/** Names of the custom events (`vscode.debug.onDidReceiveDebugSessionCustomEvent`). */
export const CustomEvents = {
    testStarted: 'devmTestStarted',
    testResult: 'devmTestResult',
    testsDone: 'devmTestsDone',
    diagram: 'devmDiagram'
} as const;

export const EXCEPTION_FILTERS: Array<{ filter: ExceptionFilter, label: string, description: string, default: boolean }> = [
    { filter: 'assertion', label: 'Assertion failures', description: 'Pause when an assertion of a test fails', default: true },
    { filter: 'error', label: 'Errors', description: 'Pause on runtime errors of the model or the test (e.g. an event raised before enter)', default: true }
];

// minimal Debug Adapter Protocol types
export interface DapMessage {
    seq: number;
    type: string;
}

export interface DapRequest extends DapMessage {
    type: 'request';
    command: string;
    arguments?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface DapResponse extends DapMessage {
    type: 'response';
    request_seq: number;
    success: boolean;
    command: string;
    message?: string;
    body?: unknown;
}

export interface DapEvent extends DapMessage {
    type: 'event';
    event: string;
    body?: unknown;
}

interface Disposable {
    dispose(): void;
}

const THREAD_ID = 1;

/** Error of a request with a message for the user. */
class RequestError extends Error { }

export class DevmDebugAdapter implements Disposable {

    private readonly listeners = new Set<(message: DapMessage) => void>();
    private seq = 1;
    private args: LaunchArguments = {};
    private files?: LaunchFiles;
    private engine?: EngineConnection;
    private stop?: StopSnapshot;
    private readonly sourceBreakpoints = new Map<string, SourceBreakpoint[]>();
    private functionBreakpoints: FunctionBreakpoint[] = [];
    private exceptionFilters: ExceptionFilter[] = EXCEPTION_FILTERS.filter(f => f.default).map(f => f.filter);
    private breakpointId = 1;
    private configurationDone!: () => void;
    private readonly configured = new Promise<void>(resolve => this.configurationDone = resolve);
    private variables = new Map<number, VariableNode[]>();
    private evaluateId = 0;
    private readonly evaluations = new Map<number, (message: Extract<EngineMessage, { type: 'evaluateResult' }>) => void>();
    private terminatedSent = false;
    private generation = 0;

    constructor(private readonly environment: AdapterEnvironment) { }

    /** `vscode.DebugAdapter.onDidSendMessage` (an `Event`). */
    readonly onDidSendMessage = (listener: (message: DapMessage) => void): Disposable => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    dispose(): void {
        this.engine?.terminate();
        this.engine = undefined;
        this.listeners.clear();
    }

    handleMessage(message: DapMessage): void {
        if (message.type !== 'request') {
            return;
        }
        const request = message as DapRequest;
        this.dispatch(request).then(
            body => this.respond(request, true, body),
            error => this.respond(request, false, undefined, error instanceof Error ? error.message : String(error)));
    }

    // -----------------------------------------------------------------------------------------
    // Requests

    private async dispatch(request: DapRequest): Promise<unknown> {
        const args = request.arguments ?? {};
        switch (request.command) {
            case 'initialize':
                setTimeout(() => this.sendEvent('initialized'), 0);
                return {
                    supportsConfigurationDoneRequest: true,
                    supportsFunctionBreakpoints: true,
                    supportsEvaluateForHovers: true,
                    supportsExceptionInfoRequest: true,
                    supportsRestartRequest: true,
                    supportsTerminateRequest: true,
                    supportTerminateDebuggee: true,
                    supportsSteppingGranularity: false,
                    exceptionBreakpointFilters: EXCEPTION_FILTERS.map(f => ({ filter: f.filter, label: f.label, description: f.description, default: f.default }))
                };
            case 'launch':
                this.args = args as LaunchArguments;
                await this.configured;
                await this.startEngine();
                return undefined;
            case 'attach':
                throw new RequestError('Attaching is not supported; use a launch configuration.');
            case 'configurationDone':
                this.configurationDone();
                return undefined;
            case 'setBreakpoints':
                return { breakpoints: await this.setBreakpoints(args) };
            case 'setFunctionBreakpoints':
                this.functionBreakpoints = (args.breakpoints ?? []).map((b: { name: string }) => ({ id: this.breakpointId++, name: b.name }));
                this.sendBreakpoints();
                return { breakpoints: this.functionBreakpoints.map(b => ({ id: b.id, verified: true, message: `Pauses when the state ${b.name} is entered` })) };
            case 'setExceptionBreakpoints':
                this.exceptionFilters = (args.filters ?? []).filter((f: string): f is ExceptionFilter => f === 'assertion' || f === 'error');
                this.sendBreakpoints();
                return undefined;
            case 'threads':
                return { threads: [{ id: THREAD_ID, name: 'Device Modeler tests' }] };
            case 'stackTrace':
                return this.stackTrace(args.startFrame ?? 0, args.levels);
            case 'scopes':
                return { scopes: this.scopes(args.frameId) };
            case 'variables':
                return { variables: this.variablesOf(args.variablesReference) };
            case 'continue':
                this.resume({ type: 'continue' });
                return { allThreadsContinued: true };
            case 'next':
                this.resume({ type: 'next' });
                return undefined;
            case 'stepIn':
                this.resume({ type: 'stepIn' });
                return undefined;
            case 'stepOut':
                this.resume({ type: 'stepOut' });
                return undefined;
            case 'pause':
                if (!this.stop) {
                    this.engine?.send({ type: 'pause' });
                }
                return undefined;
            case 'evaluate':
                return this.evaluate(args.expression, args.frameId);
            case 'exceptionInfo':
                if (this.stop?.reason !== 'exception') {
                    throw new RequestError('Not paused on an exception.');
                }
                return {
                    exceptionId: this.stop.description.includes('assertion') ? 'Assertion failure' : 'Error',
                    description: this.stop.text,
                    breakMode: 'always'
                };
            case 'restart':
                await this.restart();
                return undefined;
            case 'terminate':
                await this.terminateEngine();
                this.sendTerminated();
                return undefined;
            case 'disconnect':
                await this.terminateEngine();
                return undefined;
            case 'source':
                throw new RequestError('No source available.');
            default:
                throw new RequestError(`Unsupported request '${request.command}'`);
        }
    }

    private async setBreakpoints(args: { source?: { path?: string }, breakpoints?: Array<{ line: number }>, lines?: number[] }): Promise<unknown[]> {
        const fsPath = args.source?.path;
        const requested = args.breakpoints?.map(b => b.line) ?? args.lines ?? [];
        if (!fsPath) {
            return requested.map(line => ({ verified: false, line, message: 'Unknown source' }));
        }
        const uri = this.environment.pathToUri(fsPath);
        const kind = fileKind(fsPath);
        const text = kind ? await this.environment.readText(uri) : undefined;
        const lines = kind && text !== undefined ? breakpointLinesOfText(text, kind) : [];
        const verified: SourceBreakpoint[] = [];
        const result = requested.map(line => {
            const id = this.breakpointId++;
            const actual = verifyBreakpointLine(lines, line);
            if (actual === undefined) {
                return {
                    id, verified: false, line,
                    message: kind === 'devm' ? 'Breakpoints in models are set on states, transitions and reactions (entry / exit / …).'
                        : kind === 'devmtest' ? 'Breakpoints in tests are set on statements.' : 'Not a .devm or .devmtest file.'
                };
            }
            verified.push({ id, uri, line: actual });
            return { id, verified: true, line: actual };
        });
        this.sourceBreakpoints.set(uri, verified);
        this.sendBreakpoints();
        return result;
    }

    private breakpointSettings(): BreakpointSettings {
        return { source: [...this.sourceBreakpoints.values()].flat(), functions: this.functionBreakpoints, exceptions: this.exceptionFilters };
    }

    private sendBreakpoints(): void {
        this.engine?.send({ type: 'breakpoints', breakpoints: this.breakpointSettings() });
    }

    private stackTrace(startFrame: number, levels: number | undefined): unknown {
        const frames = this.stop?.frames ?? [];
        const end = levels ? Math.min(frames.length, startFrame + levels) : frames.length;
        return {
            stackFrames: frames.slice(startFrame, end).map((frame, index) => {
                const fsPath = frame.uri ? this.environment.uriToPath(frame.uri) : undefined;
                return {
                    id: startFrame + index + 1,
                    name: frame.name,
                    source: fsPath ? { name: path.basename(fsPath), path: fsPath } : undefined,
                    line: frame.line,
                    column: frame.column,
                    endLine: frame.endLine,
                    endColumn: frame.endColumn,
                    presentationHint: frame.kind === 'microstep' ? 'subtle' : 'normal'
                };
            }),
            totalFrames: frames.length
        };
    }

    private scopes(frameId: number): unknown[] {
        const stop = this.stop;
        const frame = stop?.frames[frameId - 1];
        if (!stop || !frame) {
            return [];
        }
        const scope = (snapshot: ScopeSnapshot) => ({
            name: snapshot.name,
            presentationHint: snapshot.hint,
            variablesReference: this.register(snapshot.variables),
            namedVariables: snapshot.variables.length,
            expensive: false
        });
        return [...frame.scopes, ...stop.scopes].map(scope);
    }

    private register(nodes: VariableNode[]): number {
        const reference = this.variables.size + 1;
        this.variables.set(reference, nodes);
        return reference;
    }

    private variablesOf(reference: number): unknown[] {
        return (this.variables.get(reference) ?? []).map(node => ({
            name: node.name,
            value: node.value,
            type: node.type,
            variablesReference: node.children && node.children.length > 0 ? this.register(node.children) : 0
        }));
    }

    private resume(command: { type: 'continue' | 'next' | 'stepIn' | 'stepOut' }): void {
        if (!this.stop) {
            return;
        }
        this.stop = undefined;
        this.variables = new Map();
        this.engine?.send(command);
    }

    private evaluate(expression: string, frameId: number | undefined): Promise<unknown> {
        if (!this.stop || !this.engine) {
            return Promise.reject(new RequestError('Expressions can be evaluated while the tests are paused.'));
        }
        const id = ++this.evaluateId;
        const frame = frameId !== undefined ? frameId - 1 : undefined;
        const engine = this.engine;
        return new Promise((resolve, reject) => {
            this.evaluations.set(id, message => message.error !== undefined
                ? reject(new RequestError(message.error))
                : resolve({ result: message.result ?? '', type: message.type_, variablesReference: 0 }));
            engine.send({ type: 'evaluate', id, expression, frame });
        });
    }

    // -----------------------------------------------------------------------------------------
    // Engine

    private async startEngine(): Promise<void> {
        this.files = await this.environment.prepare(this.args);
        this.launchEngine();
    }

    private launchEngine(): void {
        const files = this.files!;
        const generation = ++this.generation;
        this.terminatedSent = false;
        this.engine = this.environment.engine({
            models: files.models,
            testFiles: files.testFiles,
            headers: files.headers,
            tests: files.tests,
            stopOnEntry: this.args.stopOnEntry === true,
            noDebug: this.args.noDebug === true,
            breakpoints: this.breakpointSettings()
        }, message => {
            if (generation === this.generation) {
                this.engineMessage(message);
            }
        }, error => {
            if (generation !== this.generation) {
                return;
            }
            if (error) {
                this.output('stderr', `The test engine failed: ${error.message}\n`);
            }
            this.engine = undefined;
            this.sendTerminated();
        });
    }

    private engineMessage(message: EngineMessage): void {
        switch (message.type) {
            case 'stopped':
                this.stop = message.stop;
                this.variables = new Map();
                this.sendEvent('stopped', {
                    reason: message.stop.reason,
                    description: message.stop.description,
                    text: message.stop.text,
                    threadId: THREAD_ID,
                    allThreadsStopped: true,
                    hitBreakpointIds: message.stop.hitBreakpointIds
                });
                if (message.stop.diagram) {
                    this.sendEvent(CustomEvents.diagram, message.stop.diagram);
                }
                break;
            case 'output':
                this.output(message.category, message.text, message.uri, message.line);
                break;
            case 'testStarted':
                this.sendEvent(CustomEvents.testStarted, { uri: message.uri, testClass: message.testClass, test: message.test, run: this.args.devmTestRun });
                break;
            case 'result': {
                const result = message.result;
                this.output(result.status === 'passed' ? 'console' : 'stderr',
                    `${result.status === 'passed' ? '✔' : '✘'} ${result.testClass}.${result.name}: ${result.status}${result.message ? ` – ${result.message}` : ''} (${result.durationMs} ms)\n`,
                    result.status === 'passed' ? undefined : result.uri, result.status === 'passed' ? undefined : result.line);
                this.sendEvent(CustomEvents.testResult, { ...result, run: this.args.devmTestRun });
                break;
            }
            case 'diagram':
                this.sendEvent(CustomEvents.diagram, message.diagram);
                break;
            case 'evaluateResult': {
                const resolve = this.evaluations.get(message.id);
                this.evaluations.delete(message.id);
                resolve?.(message);
                break;
            }
            case 'done':
                for (const problem of message.problems) {
                    const fsPath = this.environment.uriToPath(problem.uri);
                    for (const diagnostic of problem.diagnostics) {
                        this.output('stderr', `${path.basename(fsPath)}:${diagnostic.range.start.line + 1}: ${diagnostic.message}\n`, problem.uri, diagnostic.range.start.line + 1);
                    }
                }
                this.output('console', `Tests: ${message.passed} passed, ${message.failed} failed, ${message.errors} errors`
                    + `${message.problems.length > 0 ? `, ${message.problems.length} file${message.problems.length === 1 ? '' : 's'} with errors (not executed)` : ''}\n`);
                this.sendEvent(CustomEvents.testsDone, { ...message, run: this.args.devmTestRun });
                this.engine?.terminate();
                this.engine = undefined;
                this.sendTerminated();
                break;
            case 'fatal':
                this.output('stderr', `${message.message}\n`);
                this.engine?.terminate();
                this.engine = undefined;
                this.sendTerminated();
                break;
        }
    }

    private async restart(): Promise<void> {
        this.generation++;
        await this.terminateEngine();
        this.stop = undefined;
        this.variables = new Map();
        this.output('console', 'Restarting the tests…\n');
        this.files = await this.environment.prepare(this.args);
        this.launchEngine();
    }

    private async terminateEngine(): Promise<void> {
        const engine = this.engine;
        this.engine = undefined;
        this.stop = undefined;
        for (const resolve of this.evaluations.values()) {
            resolve({ type: 'evaluateResult', id: 0, error: 'The session was terminated.' });
        }
        this.evaluations.clear();
        await engine?.terminate();
    }

    // -----------------------------------------------------------------------------------------
    // Messages to the client

    private output(category: 'console' | 'stdout' | 'stderr', text: string, uri?: string, line?: number): void {
        const fsPath = uri ? this.environment.uriToPath(uri) : undefined;
        this.sendEvent('output', {
            category,
            output: text,
            source: fsPath ? { name: path.basename(fsPath), path: fsPath } : undefined,
            line
        });
    }

    private sendTerminated(): void {
        if (!this.terminatedSent) {
            this.terminatedSent = true;
            this.sendEvent('terminated');
        }
    }

    private respond(request: DapRequest, success: boolean, body?: unknown, message?: string): void {
        const response: DapResponse = { seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command, success };
        if (body !== undefined) {
            response.body = body;
        }
        if (message !== undefined) {
            response.message = message;
            response.body = { error: { id: 1, format: message, showUser: request.command === 'launch' || request.command === 'restart' } };
        }
        this.send(response);
    }

    private sendEvent(event: string, body?: unknown): void {
        const message: DapEvent = { seq: this.seq++, type: 'event', event };
        if (body !== undefined) {
            message.body = body;
        }
        this.send(message);
    }

    private send(message: DapMessage): void {
        for (const listener of [...this.listeners]) {
            listener(message);
        }
    }
}
