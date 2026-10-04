import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
// @ts-expect-error untyped build helper (ES module script)
import { bundleOptions } from '../../scripts/bundles.mjs';
import { CustomEvents, HsmDebugAdapter, type AdapterEnvironment, type DapEvent, type DapMessage, type DapResponse, type LaunchArguments } from '../../src/debug/adapter.js';
import { workerEngineFactory } from '../../src/debug/connection.js';
import { breakpointLinesOfText, verifyBreakpointLine } from '../../src/debug/lines.js';

/*
 * The debug adapter of .hsmtest tests over the Debug Adapter Protocol, with a fake client and the real
 * debug engine in a worker thread (the worker bundle is built into a temporary directory with the options of
 * the extension build).
 */

const LAMP = `statemachine Lamp {
    @EventDriven
    interface:
        in event toggle
        out event switched
        var count : integer = 0
    [*] -> Off
    state Off
    state On {
        entry / count += 1; raise switched
    }
    Off -> On : toggle
    On -> Off : toggle
}
`;

// line numbers are referenced by the tests (1-based)
const TESTS = `testclass LampTest for statemachine Lamp {
    @SetUp
    operation init() {
        enter
    }

    @Test
    operation togglesTwice() {
        raise toggle
        press(1)
        assert active(Off)
    }

    @Test
    operation fails() {
        raise toggle
        assert count == 2 message "count is wrong"
    }

    @Test
    operation errors() {
        exit
        raise toggle
    }

    operation press(n : integer) {
        var i : integer = 0
        while (i < n) { raise toggle; i += 1 }
    }

    @Test
    operation loops() {
        var i : integer = 0
        while (true) { raise toggle; i += 1 }
    }
}
`;

let dir: string;
let worker: string;
let testFile: string;
let modelFile: string;

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-debug-'));
    testFile = path.join(dir, 'lamp.hsmtest');
    modelFile = path.join(dir, 'lamp.hsm');
    await fs.writeFile(testFile, TESTS);
    await fs.writeFile(modelFile, LAMP);
    await esbuild.build({ ...bundleOptions('debug-worker', { outdir: path.join(dir, 'out') }), logLevel: 'warning', sourcemap: false });
    worker = path.join(dir, 'out/debug-worker.cjs');
}, 120000);

afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const uriOf = (fsPath: string) => pathToFileURL(fsPath).toString();
/** The tests without the endless loop. */
const finiteTests = () => ['togglesTwice', 'fails', 'errors'].map(test => ({ uri: uriOf(testFile), testClass: 'LampTest', test }));

function environment(): AdapterEnvironment {
    return {
        prepare: async (args: LaunchArguments) => {
            const read = async (fsPath: string) => ({ uri: uriOf(fsPath), text: await fs.readFile(fsPath, 'utf-8') });
            return {
                models: [await read(modelFile)],
                testFiles: [await read(args.program ?? testFile)],
                tests: args.tests ?? (args.test ? [{ uri: uriOf(testFile), testClass: 'LampTest', test: args.test }] : undefined)
            };
        },
        readText: async uri => fs.readFile(fileURLToPath(uri), 'utf-8').catch(() => undefined),
        pathToUri: uriOf,
        uriToPath: uri => fileURLToPath(uri),
        engine: workerEngineFactory(worker)
    };
}

/** A fake DAP client: sends requests, collects responses and events. */
class Client {
    readonly adapter = new HsmDebugAdapter(environment());
    readonly events: DapEvent[] = [];
    private seq = 1;
    private readonly responses = new Map<number, (response: DapResponse) => void>();
    private readonly waiters: Array<() => void> = [];

    constructor() {
        this.adapter.onDidSendMessage((message: DapMessage) => {
            if (message.type === 'response') {
                const response = message as DapResponse;
                this.responses.get(response.request_seq)?.(response);
            } else if (message.type === 'event') {
                this.events.push(message as DapEvent);
                this.waiters.splice(0).forEach(resolve => resolve());
            }
        });
    }

    request(command: string, args?: unknown): Promise<DapResponse> {
        const seq = this.seq++;
        return new Promise(resolve => {
            this.responses.set(seq, resolve);
            this.adapter.handleMessage({ seq, type: 'request', command, arguments: args } as DapMessage);
        });
    }

    async body<T = any>(command: string, args?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
        const response = await this.request(command, args);
        if (!response.success) {
            throw new Error(`${command} failed: ${response.message}`);
        }
        return response.body as T;
    }

    /** Waits for the next event (after `from`, an index into `events`) with the name that satisfies the predicate. */
    async event(name: string, from = 0, predicate: (event: DapEvent) => boolean = () => true, timeoutMs = 20000): Promise<DapEvent> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = this.events.slice(from).find(e => e.event === name && predicate(e));
            if (found) {
                return found;
            }
            if (Date.now() > deadline) {
                throw new Error(`timeout waiting for event ${name}; events: ${this.events.map(e => e.event).join(', ')}`);
            }
            await new Promise<void>(resolve => {
                this.waiters.push(resolve);
                setTimeout(resolve, 200);
            });
        }
    }

    /** Waits for the next `stopped` event after the current events and returns it with the top frame. */
    async stopped(action: () => Promise<unknown>): Promise<{ reason: string, text?: string, hit?: number[], top: any, frames: any[] }> { // eslint-disable-line @typescript-eslint/no-explicit-any
        const from = this.events.length;
        await action();
        const event = await this.event('stopped', from);
        const body = event.body as { reason: string, text?: string, hitBreakpointIds?: number[] };
        const trace = await this.body('stackTrace', { threadId: 1 });
        return { reason: body.reason, text: body.text, hit: body.hitBreakpointIds, top: trace.stackFrames[0], frames: trace.stackFrames };
    }

    /** initialize, breakpoints, configurationDone and launch (not awaited: it completes when the engine started). */
    async start(args: LaunchArguments, breakpoints: Record<string, number[]> = {}, functionBreakpoints: string[] = []): Promise<Record<string, any[]>> { // eslint-disable-line @typescript-eslint/no-explicit-any
        const capabilities = await this.body('initialize', { adapterID: 'hsm-test', linesStartAt1: true, columnsStartAt1: true });
        expect(capabilities.supportsConfigurationDoneRequest).toBe(true);
        await this.event('initialized');
        const launched = this.request('launch', args);
        const verified: Record<string, any[]> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const [file, lines] of Object.entries(breakpoints)) {
            verified[file] = (await this.body('setBreakpoints', { source: { path: file }, breakpoints: lines.map(line => ({ line })) })).breakpoints;
        }
        await this.body('setFunctionBreakpoints', { breakpoints: functionBreakpoints.map(name => ({ name })) });
        await this.body('setExceptionBreakpoints', { filters: ['assertion', 'error'] });
        await this.body('configurationDone');
        const response = await launched;
        expect(response.success).toBe(true);
        return verified;
    }

    async variables(frameId: number): Promise<Record<string, Record<string, string>>> {
        const { scopes } = await this.body('scopes', { frameId });
        const result: Record<string, Record<string, string>> = {};
        for (const scope of scopes) {
            const { variables } = await this.body('variables', { variablesReference: scope.variablesReference });
            result[scope.name] = Object.fromEntries(variables.map((v: { name: string, value: string }) => [v.name, v.value]));
        }
        return result;
    }

    dispose(): void {
        this.adapter.dispose();
    }
}

let client: Client | undefined;

afterEach(async () => {
    if (client) {
        await client.request('disconnect', {});
        client.dispose();
        client = undefined;
    }
});

describe('breakpoint lines', () => {
    it('statements of tests and states, transitions and reactions of models', () => {
        const testLines = breakpointLinesOfText(TESTS, 'hsmtest');
        expect(testLines).toEqual(expect.arrayContaining([4, 9, 10, 11, 16, 17, 22, 23, 27, 28]));
        expect(testLines).not.toContain(8);
        // a breakpoint on the operation header moves to its first statement
        expect(verifyBreakpointLine(testLines, 8)).toBe(9);
        expect(breakpointLinesOfText(LAMP, 'hsm')).toEqual([7, 8, 9, 10, 12, 13]);
    });
});

describe('debug adapter', () => {

    it('stops at breakpoints, steps over, into microsteps and out, shows scopes, evaluates and reports results', async () => {
        client = new Client();
        const verified = await client.start({ program: testFile, tests: finiteTests() }, { [testFile]: [9, 8] });
        expect(verified[testFile].map(b => [b.verified, b.line])).toEqual([[true, 9], [true, 9]]);

        // breakpoint on `raise toggle` of togglesTwice
        let stop = await client.stopped(async () => undefined);
        expect(stop.reason).toBe('breakpoint');
        expect(stop.top).toMatchObject({ name: 'LampTest.togglesTwice', line: 9 });
        expect(stop.top.source.path).toBe(testFile);
        const diagram = await client.event(CustomEvents.diagram);
        expect(diagram.body).toMatchObject({ modelUri: uriOf(modelFile), activeStates: ['Off'], running: true });
        expect((diagram.body as { activeOffsets: number[] }).activeOffsets).toEqual([LAMP.indexOf('state Off')]);

        let scopes = await client.variables(stop.top.id);
        expect(Object.keys(scopes)).toEqual(['Locals', 'Active states', 'State machine', 'Events', 'Operation calls', 'Execution']);
        expect(scopes['Active states']).toEqual({ Off: 'active (leaf)' });
        expect(scopes['State machine']).toMatchObject({ count: '0' });
        expect(scopes.Execution).toMatchObject({ test: 'LampTest.togglesTwice', running: 'true' });

        // step into the microsteps of `raise toggle`: exit Off, transition, enter On, entry reaction
        stop = await client.stopped(() => client!.body('stepIn', { threadId: 1 }));
        expect(stop.top).toMatchObject({ name: 'exit Off', line: 8 });
        expect(stop.top.source.path).toBe(modelFile);
        expect(stop.frames[1]).toMatchObject({ name: 'LampTest.togglesTwice', line: 9 });
        stop = await client.stopped(() => client!.body('stepIn', { threadId: 1 }));
        expect(stop.top).toMatchObject({ name: 'transition Off → On', line: 12 });
        stop = await client.stopped(() => client!.body('stepIn', { threadId: 1 }));
        expect(stop.top).toMatchObject({ name: 'enter On', line: 9 });
        scopes = await client.variables(stop.top.id);
        expect(scopes.Microstep).toMatchObject({ kind: 'enter', state: 'On' });
        expect(scopes['Active states']).toEqual({ On: 'active (leaf)' });
        stop = await client.stopped(() => client!.body('stepIn', { threadId: 1 }));
        expect(stop.top.name).toContain('reaction On: entry');
        expect(stop.top.line).toBe(10);
        const highlighted = client.events.filter(e => e.event === CustomEvents.diagram).at(-1)!.body as { activeStates: string[], transitionOffsets: number[] };
        expect(highlighted.activeStates).toEqual(['On']);

        // step over: the rest of the statement, to `press(1)`
        stop = await client.stopped(() => client!.body('next', { threadId: 1 }));
        expect(stop.top).toMatchObject({ name: 'LampTest.togglesTwice', line: 10 });
        scopes = await client.variables(stop.top.id);
        expect(scopes['State machine']).toMatchObject({ count: '1' });
        expect(scopes.Events).toMatchObject({ switched: 'raised' });

        // step into the helper operation (a frame with parameters and locals), then out of it
        stop = await client.stopped(() => client!.body('stepIn', { threadId: 1 }));
        expect(stop.top).toMatchObject({ name: 'LampTest.press', line: 27 });
        expect(stop.frames.map(f => f.name)).toEqual(['LampTest.press', 'LampTest.togglesTwice']);
        stop = await client.stopped(() => client!.body('next', { threadId: 1 }));
        expect(stop.top.line).toBe(28);
        scopes = await client.variables(stop.top.id);
        expect(scopes.Locals).toEqual({ n: '1', i: '0' });
        const evaluated = await client.body('evaluate', { expression: 'n', frameId: stop.top.id, context: 'hover' });
        expect(evaluated.result).toBe('1');
        stop = await client.stopped(() => client!.body('stepOut', { threadId: 1 }));
        expect(stop.top).toMatchObject({ name: 'LampTest.togglesTwice', line: 11 });
        expect((await client.body('evaluate', { expression: 'count', frameId: stop.top.id, context: 'watch' })).result).toBe('1');
        expect((await client.body('evaluate', { expression: 'active(Off)', frameId: stop.top.id, context: 'repl' })).result).toBe('true');
        expect((await client.body('evaluate', { expression: 'On', frameId: stop.top.id, context: 'repl' })).result).toBe('false');
        expect((await client.request('evaluate', { expression: 'nonsense', frameId: stop.top.id, context: 'repl' })).success).toBe(false);

        // continue: the next test fails – paused on the assertion failure
        stop = await client.stopped(() => client!.body('continue', { threadId: 1 }));
        expect(stop.reason).toBe('exception');
        expect(stop.text).toContain('count is wrong');
        expect(stop.top).toMatchObject({ name: 'LampTest.fails', line: 17 });
        const info = await client.body('exceptionInfo', { threadId: 1 });
        expect(info).toMatchObject({ exceptionId: 'Assertion failure', breakMode: 'always' });

        // the next test has a runtime error (raise after exit)
        stop = await client.stopped(() => client!.body('continue', { threadId: 1 }));
        expect(stop.reason).toBe('exception');
        expect(stop.top).toMatchObject({ name: 'LampTest.errors', line: 23 });
        expect((await client.body('exceptionInfo', { threadId: 1 })).exceptionId).toBe('Error');
        const from = client.events.length;
        await client.body('continue', { threadId: 1 });
        await client.event('terminated', from);
        const results = client.events.filter(e => e.event === CustomEvents.testResult).map(e => e.body as { name: string, status: string, line?: number });
        expect(results.map(r => [r.name, r.status])).toEqual([['togglesTwice', 'passed'], ['fails', 'failed'], ['errors', 'error']]);
        expect(results[1].line).toBe(17);
        const done = client.events.find(e => e.event === CustomEvents.testsDone)!.body as { passed: number, failed: number, errors: number };
        expect(done).toMatchObject({ passed: 1, failed: 1, errors: 1 });
        const output = client.events.filter(e => e.event === 'output').map(e => (e.body as { output: string }).output).join('');
        expect(output).toContain('> raise toggle');
        expect(output).toContain('Tests: 1 passed, 1 failed, 1 errors');
    });

    it('breakpoints in models stop when a state is entered or a transition is taken; function breakpoints on state names', async () => {
        client = new Client();
        const verified = await client.start({ program: testFile, test: 'togglesTwice' }, { [modelFile]: [13, 14] }, ['On']);
        expect(verified[modelFile].map(b => [b.verified, b.line])).toEqual([[true, 13], [false, 14]]);
        // `raise toggle` enters On first (state breakpoint), then press(1) takes On -> Off
        let stop = await client.stopped(async () => undefined);
        expect(stop.reason).toBe('function breakpoint');
        expect(stop.top).toMatchObject({ name: 'enter On', line: 9 });
        stop = await client.stopped(() => client!.body('continue', { threadId: 1 }));
        expect(stop.reason).toBe('breakpoint');
        expect(stop.top).toMatchObject({ name: 'transition On → Off', line: 13 });
        expect(stop.frames.map(f => f.name)).toEqual(['transition On → Off', 'LampTest.press', 'LampTest.togglesTwice']);
        const diagram = client.events.filter(e => e.event === CustomEvents.diagram).at(-1)!.body as { transitionOffsets: number[] };
        expect(diagram.transitionOffsets).toEqual([LAMP.indexOf('On -> Off')]);
        const from = client.events.length;
        await client.body('continue', { threadId: 1 });
        await client.event('terminated', from);
    });

    it('stops on entry, pauses a running test, restarts and terminates', async () => {
        client = new Client();
        await client.start({ program: testFile, test: 'loops', stopOnEntry: true });
        let stop = await client.stopped(async () => undefined);
        expect(stop.reason).toBe('entry');
        expect(stop.top).toMatchObject({ name: 'LampTest.init', line: 4 });
        // the endless loop runs until the iteration limit: pause it
        await client.body('setExceptionBreakpoints', { filters: [] });
        await client.body('continue', { threadId: 1 });
        await new Promise(resolve => setTimeout(resolve, 300));
        stop = await client.stopped(() => client!.body('pause', { threadId: 1 }));
        expect(stop.reason).toBe('pause');
        expect(stop.frames.map(f => f.name)).toContain('LampTest.loops');
        const scopes = await client.variables(stop.frames.find(f => f.name === 'LampTest.loops').id);
        expect(Number(scopes.Locals.i)).toBeGreaterThan(0);
        // restart: on entry again
        stop = await client.stopped(() => client!.body('restart', {}));
        expect(stop.reason).toBe('entry');
        const from = client.events.length;
        await client.body('terminate', {});
        await client.event('terminated', from);
        expect(client.events.filter(e => e.event === CustomEvents.testResult)).toHaveLength(0);
    });

    it('runs without stopping when launched without debugging', async () => {
        client = new Client();
        await client.start({ program: testFile, tests: finiteTests(), noDebug: true }, { [testFile]: [9] });
        await client.event('terminated');
        expect(client.events.some(e => e.event === 'stopped')).toBe(false);
        const results = client.events.filter(e => e.event === CustomEvents.testResult).map(e => (e.body as { status: string }).status);
        expect(results).toEqual(['passed', 'failed', 'error']);
    });
});
