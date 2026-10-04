import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
// @ts-expect-error untyped build helper (ES module script)
import { bundleOptions } from '../../scripts/bundles.mjs';

/*
 * Starts the bundled language server (built into a temporary directory with the options of the
 * extension build) with `--stdio` and talks LSP to it: diagnostics, cross-file linking of test files
 * via the workspace index, hover with documentation, definition, references, rename, formatting,
 * symbols, folding, completion and semantic tokens; structure files (.devm) with links to the component
 * types, ports and state machines of other files of the workspace.
 */

interface Diagnostic {
    severity?: number;
    message: string;
    range: { start: { line: number, character: number } };
}

const LAMP = `/** A lamp. */
statemachine Lamp {
    interface:
        /** Switches the lamp on or off. */
        in event toggle
        var count : integer = 0

    [*] -> Off
    state Off
    state On {
        entry / count += 1
    }
    Off -> On : toggle
    On -> Off : toggle
}
`;

const LAMP_TEST = `testclass LampTest for statemachine Lamp {
    @Test
    operation switchesOn() {
        enter
        raise toggle
        assert active(On)
        assert count == 1
    }
}
`;

const MOTOR = `statemachine Motor {
    interface:
        in event start
        out event stopped
    [*] -> Off
    state Off
    state On
    Off -> On : start
    On -> Off : start / raise stopped
}
`;

const GATE = `statemachine Gate {
    import "parts/motor.devm"
    interface:
        in event open
    internal:
        var motor : Motor
    [*] -> Closed
    state Closed
    state Moving : motor
    Closed -> Moving : open / raise motor.start
    Moving -> Closed : motor.stopped
}
`;

const TYPES_H = `#pragma once
namespace app {
/// Operating mode of the valve.
enum class Mode { Closed, Open };
struct Limits {
    int low = 1;   ///< lower limit
    int high = 9;
};
constexpr int kMax = 42;
}
`;

const VALVE = `statemachine Valve {
    import "types.h"
    import "shared.h"
    interface:
        var mode : app::Mode = app::Mode::Open
        var limits : app::Limits
        var level : integer = app::kMax + shared::kOffset
    [*] -> A
    state A
    A -> A : always [limits.low < level] / mode = app::Mode::Closed
}
`;

const PUMP = `statemachine Pump {
    interface:
        in event start : integer
        in event stop
        out event done
    [*] -> Idle
    state Idle
    state Running
    Idle -> Running : start
    Running -> Idle : stop / raise done
}
`;

const PARTS = `struct PumpSettings {
    speed : integer
}

/** The pump control. */
component PumpControl {
    behavior "pump.devm"
    in async start : integer
    in async stop
    out async done
}

component Panel {
    out async start : integer
    out async stop
    in async done
}
`;

const PLANT = `import "parts.devm"

system Plant {
    thread Main {
        panel : Panel
        pump : PumpControl
    }
    connect panel.start -> pump.start
    connect panel.stop -> pump.stop
    connect pump.done -> panel.done
}
`;

let dir: string;
let tokenTypes: string[] = [];
let server: ChildProcess;
let connection: MessageConnection;
const diagnostics = new Map<string, Diagnostic[]>();
const waiters: Array<() => void> = [];

function uriOf(relative: string): string {
    return pathToFileURL(path.join(dir, relative)).toString();
}

/** Waits until diagnostics for the URI arrive that satisfy the predicate. */
async function diagnosticsFor(uri: string, predicate: (d: Diagnostic[]) => boolean = () => true, timeoutMs = 20000): Promise<Diagnostic[]> {
    const start = Date.now();
    for (;;) {
        const current = diagnostics.get(uri);
        if (current && predicate(current)) {
            return current;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`no matching diagnostics for ${uri}: ${JSON.stringify(current)}`);
        }
        await new Promise<void>(resolve => {
            waiters.push(resolve);
            setTimeout(resolve, 200);
        });
    }
}

function position(text: string, search: string, occurrence = 0, delta = 0) {
    let offset = -1;
    for (let i = 0; i <= occurrence; i++) {
        offset = text.indexOf(search, offset + 1);
    }
    const before = text.slice(0, offset + delta).split('\n');
    return { line: before.length - 1, character: before[before.length - 1].length };
}

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devm-lsp-'));
    await fs.mkdir(path.join(dir, 'models'));
    await fs.mkdir(path.join(dir, 'tests'));
    await fs.writeFile(path.join(dir, 'models/lamp.devm'), LAMP);
    await fs.writeFile(path.join(dir, 'tests/lamp.devmtest'), LAMP_TEST);
    await fs.mkdir(path.join(dir, 'models/parts'));
    await fs.writeFile(path.join(dir, 'models/parts/motor.devm'), MOTOR);
    await fs.writeFile(path.join(dir, 'models/gate.devm'), GATE);
    await fs.writeFile(path.join(dir, 'models/types.h'), TYPES_H);
    // a header found through the include paths of the headers block of devm.gen.json
    await fs.mkdir(path.join(dir, 'include'));
    await fs.writeFile(path.join(dir, 'include/shared.h'), 'namespace shared { constexpr int kOffset = 1; }\n');
    // structure files: the system links the component types of another file (not opened by the tests first)
    await fs.mkdir(path.join(dir, 'device'));
    await fs.writeFile(path.join(dir, 'device/pump.devm'), PUMP);
    await fs.writeFile(path.join(dir, 'device/parts.devm'), PARTS);
    await fs.writeFile(path.join(dir, 'device/plant.devm'), PLANT);
    // a header that is not imported by the controller: found by the quick fix of the unknown type
    await fs.mkdir(path.join(dir, 'include/hal'));
    await fs.writeFile(path.join(dir, 'include/hal/driver.h'), 'namespace hal { class Driver { public: void on(); }; }\n');
    // a header that only forward declares the driver
    await fs.writeFile(path.join(dir, 'include/hal/fwd.h'), 'namespace hal {\n/// The hardware driver.\nclass Driver;\n}\n');
    await fs.writeFile(path.join(dir, 'devm.gen.json'), JSON.stringify({ models: ['models/*.devm'], cpp: {}, headers: { includePaths: ['include'] } }));
    await esbuild.build({ ...bundleOptions('server', { outdir: path.join(dir, 'out') }), logLevel: 'warning', sourcemap: false });

    server = spawn(process.execPath, [path.join(dir, 'out/server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    connection = createMessageConnection(new StreamMessageReader(server.stdout!), new StreamMessageWriter(server.stdin!));
    connection.onNotification('textDocument/publishDiagnostics', (params: { uri: string, diagnostics: Diagnostic[] }) => {
        diagnostics.set(params.uri, params.diagnostics);
        waiters.splice(0).forEach(resolve => resolve());
    });
    connection.onRequest('client/registerCapability', () => null);
    connection.onRequest('workspace/configuration', (params: { items: unknown[] }) => params.items.map(() => null));
    connection.listen();
    const result = await connection.sendRequest<{ capabilities: Record<string, unknown> }>('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(dir).toString(),
        workspaceFolders: [{ uri: pathToFileURL(dir).toString(), name: 'workspace' }],
        capabilities: {
            workspace: { workspaceFolders: true, configuration: true },
            textDocument: { publishDiagnostics: {}, hover: { contentFormat: ['markdown', 'plaintext'] }, synchronization: {} }
        }
    });
    for (const capability of ['hoverProvider', 'completionProvider', 'definitionProvider', 'referencesProvider', 'renameProvider',
        'documentFormattingProvider', 'documentSymbolProvider', 'foldingRangeProvider', 'semanticTokensProvider', 'codeActionProvider']) {
        expect(result.capabilities[capability], capability).toBeTruthy();
    }
    tokenTypes = (result.capabilities.semanticTokensProvider as { legend: { tokenTypes: string[] } }).legend.tokenTypes;
    await connection.sendNotification('initialized', {});
}, 120000);

afterAll(async () => {
    try {
        await connection?.sendRequest('shutdown');
        await connection?.sendNotification('exit');
    } catch {
        // already gone
    }
    connection?.dispose();
    server?.kill();
    await fs.rm(dir, { recursive: true, force: true });
});

function open(relative: string, languageId: string, text: string, version = 1): void {
    connection.sendNotification('textDocument/didOpen', { textDocument: { uri: uriOf(relative), languageId, version, text } });
}

describe('Device Modeler language server', () => {
    it('links a test file to the state machine of another file of the workspace', async () => {
        open('tests/lamp.devmtest', 'devmtest', LAMP_TEST);
        const result = await diagnosticsFor(uriOf('tests/lamp.devmtest'));
        expect(result.filter(d => d.severity === 1)).toEqual([]);
    });

    it('reports errors of models and test files and updates them on changes', async () => {
        open('models/broken.devm', 'devm', 'statemachine Broken {\n    [*] -> Missing\n    state A\n}\n');
        const errors = await diagnosticsFor(uriOf('models/broken.devm'), d => d.length > 0);
        expect(errors.some(d => d.severity === 1 && /Missing/.test(d.message))).toBe(true);

        const uri = uriOf('tests/lamp.devmtest');
        connection.sendNotification('textDocument/didChange', {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: LAMP_TEST.replace('active(On)', 'active(Dimmed)') }]
        });
        const testErrors = await diagnosticsFor(uri, d => d.some(e => e.severity === 1));
        expect(testErrors.some(d => /Dimmed/.test(d.message))).toBe(true);
        connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: LAMP_TEST }] });
        await diagnosticsFor(uri, d => !d.some(e => e.severity === 1));
    });

    it('shows the signature and documentation comment on hover', async () => {
        open('models/lamp.devm', 'devm', LAMP);
        await diagnosticsFor(uriOf('models/lamp.devm'));
        const hover = await connection.sendRequest<{ contents: { value: string } }>('textDocument/hover', {
            textDocument: { uri: uriOf('models/lamp.devm') }, position: position(LAMP, 'toggle', 1, 2)
        });
        expect(hover.contents.value).toContain('in event toggle');
        expect(hover.contents.value).toContain('Switches the lamp on or off.');
        // one signature (the documentation provider's own one is replaced)
        expect(hover.contents.value.match(/```devm/g)).toHaveLength(1);
    });

    it('navigates from a test file to the model (definition) and finds references across files', async () => {
        const definition = await connection.sendRequest<Array<{ targetUri?: string, uri?: string }>>('textDocument/definition', {
            textDocument: { uri: uriOf('tests/lamp.devmtest') }, position: position(LAMP_TEST, 'toggle', 0, 2)
        });
        const target = Array.isArray(definition) ? definition[0] : definition;
        expect(target.targetUri ?? target.uri).toBe(uriOf('models/lamp.devm'));

        const references = await connection.sendRequest<Array<{ uri: string }>>('textDocument/references', {
            textDocument: { uri: uriOf('models/lamp.devm') }, position: position(LAMP, 'toggle', 0, 2), context: { includeDeclaration: false }
        });
        expect(new Set(references.map(r => r.uri))).toEqual(new Set([uriOf('models/lamp.devm'), uriOf('tests/lamp.devmtest')]));
    });

    it('renames an event in the model and in the tests', async () => {
        const edit = await connection.sendRequest<{ changes: Record<string, unknown[]> }>('textDocument/rename', {
            textDocument: { uri: uriOf('models/lamp.devm') }, position: position(LAMP, 'toggle', 0, 2), newName: 'press'
        });
        expect(edit.changes[uriOf('models/lamp.devm')]).toHaveLength(3);
        expect(edit.changes[uriOf('tests/lamp.devmtest')]).toHaveLength(1);
    });

    it('formats, lists symbols, folds, completes and highlights', async () => {
        const uri = uriOf('models/lamp.devm');
        const unformatted = 'statemachine Fmt {\n[*] -> A\n        state A\n}\n';
        open('models/fmt.devm', 'devm', unformatted);
        await diagnosticsFor(uriOf('models/fmt.devm'));
        const edits = await connection.sendRequest<unknown[]>('textDocument/formatting', {
            textDocument: { uri: uriOf('models/fmt.devm') }, options: { tabSize: 4, insertSpaces: true }
        });
        expect(edits.length).toBeGreaterThan(0);

        const symbols = await connection.sendRequest<Array<{ name: string, children?: Array<{ name: string }> }>>('textDocument/documentSymbol', { textDocument: { uri } });
        expect(symbols[0].name).toBe('Lamp');
        const names = JSON.stringify(symbols);
        expect(names).toContain('"On"');
        expect(names).toContain('"toggle"');

        const folding = await connection.sendRequest<unknown[]>('textDocument/foldingRange', { textDocument: { uri } });
        expect(folding.length).toBeGreaterThan(0);

        const completion = await connection.sendRequest<{ items: Array<{ label: string }> } | Array<{ label: string }>>('textDocument/completion', {
            textDocument: { uri: uriOf('tests/lamp.devmtest') }, position: position(LAMP_TEST, 'active(On)', 0, 7)
        });
        const labels = (Array.isArray(completion) ? completion : completion.items).map(item => item.label);
        expect(labels).toEqual(expect.arrayContaining(['On', 'Off']));

        const tokens = await connection.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri } });
        expect(tokens.data.length).toBeGreaterThan(0);
    });

    it('resolves imports of other state machines of the workspace and relinks on changes', async () => {
        open('models/gate.devm', 'devm', GATE);
        const gateUri = uriOf('models/gate.devm');
        expect((await diagnosticsFor(gateUri)).filter(d => d.severity === 1)).toEqual([]);

        // go to definition from the type name of the instance to the imported state machine
        const definition = await connection.sendRequest<Array<{ targetUri?: string, uri?: string }>>('textDocument/definition', {
            textDocument: { uri: gateUri }, position: position(GATE, 'Motor', 0, 2)
        });
        const target = Array.isArray(definition) ? definition[0] : definition;
        expect(target.targetUri ?? target.uri).toBe(uriOf('models/parts/motor.devm'));

        // the motor loses its in event: the gate is relinked and reports the unresolved reference
        const motorUri = uriOf('models/parts/motor.devm');
        open('models/parts/motor.devm', 'devm', MOTOR);
        connection.sendNotification('textDocument/didChange', {
            textDocument: { uri: motorUri, version: 2 }, contentChanges: [{ text: MOTOR.replace(/start/g, 'go') }]
        });
        const errors = await diagnosticsFor(gateUri, d => d.some(e => e.severity === 1));
        expect(errors.some(d => /motor\.start/.test(d.message))).toBe(true);
        connection.sendNotification('textDocument/didChange', { textDocument: { uri: motorUri, version: 3 }, contentChanges: [{ text: MOTOR }] });
        await diagnosticsFor(gateUri, d => !d.some(e => e.severity === 1));

        // an import of a file that does not exist
        open('models/lost.devm', 'devm', 'statemachine Lost {\n    import "nowhere.devm"\n    [*] -> A\n    state A\n}\n');
        const lost = await diagnosticsFor(uriOf('models/lost.devm'), d => d.length > 0);
        expect(lost.some(d => d.severity === 1 && /nowhere\.devm/.test(d.message))).toBe(true);
    });

    it('resolves C++ header imports (include paths of devm.gen.json), hovers and navigates into headers and revalidates when a header changes', async () => {
        open('models/valve.devm', 'devm', VALVE);
        const valveUri = uriOf('models/valve.devm');
        expect((await diagnosticsFor(valveUri)).filter(d => d.severity === 1)).toEqual([]);

        const hover = await connection.sendRequest<{ contents: { value: string } }>('textDocument/hover', {
            textDocument: { uri: valveUri }, position: position(VALVE, 'app::Mode', 0, 6)
        });
        expect(hover.contents.value).toContain('enum class app::Mode');
        expect(hover.contents.value).toContain('Operating mode of the valve.');
        const member = await connection.sendRequest<{ contents: { value: string } }>('textDocument/hover', {
            textDocument: { uri: valveUri }, position: position(VALVE, 'limits.low', 0, 8)
        });
        expect(member.contents.value).toContain('lower limit');

        const definition = await connection.sendRequest<Array<{ targetUri: string, targetSelectionRange: { start: { line: number } } }>>('textDocument/definition', {
            textDocument: { uri: valveUri }, position: position(VALVE, 'app::Limits', 0, 6)
        });
        expect(definition[0].targetUri).toBe(uriOf('models/types.h'));
        expect(definition[0].targetSelectionRange.start.line).toBe(4);

        const completion = await connection.sendRequest<{ items: Array<{ label: string }> } | Array<{ label: string }>>('textDocument/completion', {
            textDocument: { uri: valveUri }, position: position(VALVE, 'app::Mode::Open', 0, 11)
        });
        const items = Array.isArray(completion) ? completion : completion.items;
        expect(items.map(item => item.label)).toEqual(expect.arrayContaining(['Closed', 'Open']));

        // the header loses the enumerator Open: the model is validated again
        await fs.writeFile(path.join(dir, 'models/types.h'), TYPES_H.replace('Closed, Open', 'Closed, Opened'));
        connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uriOf('models/types.h'), type: 2 }] });
        const errors = await diagnosticsFor(valveUri, d => d.some(e => e.severity === 1));
        expect(errors.some(d => /'app::Mode' has no enumerator 'Open'/.test(d.message))).toBe(true);
        await fs.writeFile(path.join(dir, 'models/types.h'), TYPES_H);
        connection.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uriOf('models/types.h'), type: 2 }] });
        await diagnosticsFor(valveUri, d => !d.some(e => e.severity === 1));
    });

    it('warns about unknown C++ types of class sections, offers the import of the declaring header and highlights them as types', async () => {
        const controller = 'statemachine Controller {\n    import "types.h"\n    private:\n        var driver : hal::Driver&\n    [*] -> A\n    state A\n}\n';
        open('models/controller.devm', 'devm', controller);
        const uri = uriOf('models/controller.devm');
        const found = await diagnosticsFor(uri, d => d.length > 0);
        const unknown = found.filter(d => /Unknown type 'hal::Driver'/.test(d.message)) as Array<Diagnostic & { range: { end: { line: number, character: number } } }>;
        expect(unknown).toHaveLength(1);
        expect(unknown[0].severity).toBe(2);
        expect(unknown[0].message).toContain('import "hal/driver.h"');
        expect(unknown[0].range.start).toEqual(position(controller, 'hal::Driver'));

        const actions = await connection.sendRequest<Array<{ title: string, edit: { changes: Record<string, Array<{ newText: string }>> } }>>('textDocument/codeAction', {
            textDocument: { uri }, range: unknown[0].range, context: { diagnostics: unknown }
        });
        expect(actions.map(a => a.title)).toEqual(['Import "hal/driver.h"']);
        expect(actions[0].edit.changes[uri][0].newText).toBe('\n    import "hal/driver.h"');

        // the unknown name is still highlighted as a type
        const tokens = await connection.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri } });
        const decoded: Array<{ line: number, character: number, length: number, type: string }> = [];
        let line = 0;
        let character = 0;
        for (let i = 0; i < tokens.data.length; i += 5) {
            const [deltaLine, deltaStart, length, type] = tokens.data.slice(i, i + 4);
            line += deltaLine;
            character = deltaLine === 0 ? character + deltaStart : deltaStart;
            decoded.push({ line, character, length, type: tokenTypes[type] });
        }
        const start = position(controller, 'hal::Driver');
        expect(decoded).toContainEqual({ ...start, length: 'hal::Driver'.length, type: 'type' });
    });

    it('warns about C++ types that are only forward-declared, offers the import of the defining header, hovers and navigates to the forward declaration', async () => {
        const board = 'statemachine Board {\n    import "hal/fwd.h"\n    private:\n        var driver : hal::Driver&\n    [*] -> A\n    state A\n}\n';
        open('models/board.devm', 'devm', board);
        const uri = uriOf('models/board.devm');
        const found = await diagnosticsFor(uri, d => d.length > 0);
        const incomplete = found.filter(d => (d as { code?: string }).code === 'incomplete-cpp-type');
        expect(incomplete).toHaveLength(1);
        expect(incomplete[0].severity).toBe(2);
        expect(incomplete[0].message).toBe('\'hal::Driver\' is only forward-declared (fwd.h:3). Import the header that defines it (import "hal/driver.h") '
            + 'for hover, completion and navigation.');
        expect(incomplete[0].range.start).toEqual(position(board, 'Driver'));
        expect(found.filter(d => d.severity === 1)).toEqual([]);

        const actions = await connection.sendRequest<Array<{ title: string, edit: { changes: Record<string, Array<{ newText: string }>> } }>>('textDocument/codeAction', {
            textDocument: { uri }, range: incomplete[0].range, context: { diagnostics: incomplete }
        });
        expect(actions.map(a => a.title)).toEqual(['Import "hal/driver.h"']);
        expect(actions[0].edit.changes[uri][0].newText).toBe('\n    import "hal/driver.h"');

        const hover = await connection.sendRequest<{ contents: { value: string } }>('textDocument/hover', {
            textDocument: { uri }, position: position(board, 'Driver', 0, 2)
        });
        expect(hover.contents.value).toContain('class hal::Driver');
        expect(hover.contents.value).toContain('forward declaration in fwd.h:3 — the definition is not imported');
        expect(hover.contents.value).toContain('The hardware driver.');

        for (const method of ['textDocument/definition', 'textDocument/declaration']) {
            const targets = await connection.sendRequest<Array<{ targetUri: string, targetSelectionRange: { start: { line: number } } }>>(method, {
                textDocument: { uri }, position: position(board, 'Driver', 0, 2)
            });
            expect(targets.map(t => [t.targetUri, t.targetSelectionRange.start.line])).toEqual([[pathToFileURL(path.join(dir, 'include/hal/fwd.h')).toString(), 2]]);
        }

        const tokens = await connection.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri } });
        let line = 0;
        let character = 0;
        const decoded: Array<{ line: number, character: number, length: number, type: string }> = [];
        for (let i = 0; i < tokens.data.length; i += 5) {
            const [deltaLine, deltaStart, length, type] = tokens.data.slice(i, i + 4);
            line += deltaLine;
            character = deltaLine === 0 ? character + deltaStart : deltaStart;
            decoded.push({ line, character, length, type: tokenTypes[type] });
        }
        expect(decoded).toContainEqual({ ...position(board, 'hal::Driver'), length: 'hal::Driver'.length, type: 'type' });

        // with the header defining the driver: no warning, the definition first, then the forward declaration
        connection.sendNotification('textDocument/didChange', {
            textDocument: { uri, version: 2 }, contentChanges: [{ text: board.replace('import "hal/fwd.h"', 'import "hal/fwd.h"\n    import "hal/driver.h"') }]
        });
        await diagnosticsFor(uri, d => !d.some(e => (e as { code?: string }).code === 'incomplete-cpp-type'));
        const fixed = board.replace('import "hal/fwd.h"', 'import "hal/fwd.h"\n    import "hal/driver.h"');
        const declarations = await connection.sendRequest<Array<{ targetUri: string }>>('textDocument/declaration', {
            textDocument: { uri }, position: position(fixed, 'Driver&', 0, 2)
        });
        expect(declarations.map(t => t.targetUri.replace(/^.*\//, ''))).toEqual(['driver.h', 'fwd.h']);
    });
});

describe('structure files (.devm) in the language server', () => {
    const plantUri = () => uriOf('device/plant.devm');
    const partsUri = () => uriOf('device/parts.devm');

    it('links component types of other files of the workspace and reports problems', async () => {
        open('device/plant.devm', 'devm', PLANT);
        expect((await diagnosticsFor(plantUri())).filter(d => d.severity === 1)).toEqual([]);
        // a port that does not exist in the component type of the other file
        connection.sendNotification('textDocument/didChange', {
            textDocument: { uri: plantUri(), version: 2 }, contentChanges: [{ text: PLANT.replace('panel.start ->', 'panel.starts ->') }]
        });
        const errors = await diagnosticsFor(plantUri(), d => d.some(e => e.severity === 1));
        expect(errors.some(d => /starts/.test(d.message))).toBe(true);
        connection.sendNotification('textDocument/didChange', { textDocument: { uri: plantUri(), version: 3 }, contentChanges: [{ text: PLANT }] });
        await diagnosticsFor(plantUri(), d => !d.some(e => e.severity === 1));
    });

    it('checks the ports of a component against its state machine', async () => {
        open('device/parts.devm', 'devm', PARTS);
        expect((await diagnosticsFor(partsUri())).filter(d => d.severity === 1)).toEqual([]);
        connection.sendNotification('textDocument/didChange', {
            textDocument: { uri: partsUri(), version: 2 }, contentChanges: [{ text: PARTS.replace('    out async done', '    out async finished') }]
        });
        const problems = await diagnosticsFor(partsUri(), d => d.some(e => /finished/.test(e.message)));
        expect(problems.some(d => /finished/.test(d.message))).toBe(true);
        connection.sendNotification('textDocument/didChange', { textDocument: { uri: partsUri(), version: 3 }, contentChanges: [{ text: PARTS }] });
        await diagnosticsFor(partsUri(), d => !d.some(e => /finished/.test(e.message)));
    });

    it('navigates to component types, state machines and sources (implementation)', async () => {
        // the type of an instance: the component type in the other file
        const definition = await connection.sendRequest<Array<{ targetUri?: string, uri?: string }>>('textDocument/definition', {
            textDocument: { uri: plantUri() }, position: position(PLANT, 'PumpControl', 0, 2)
        });
        const target = Array.isArray(definition) ? definition[0] : definition;
        expect(target.targetUri ?? target.uri).toBe(partsUri());

        // the behavior of a component: its state machine
        const behavior = await connection.sendRequest<Array<{ targetUri?: string, uri?: string }>>('textDocument/definition', {
            textDocument: { uri: partsUri() }, position: position(PARTS, 'pump.devm', 0, 2)
        });
        const machine = Array.isArray(behavior) ? behavior[0] : behavior;
        expect(machine.targetUri ?? machine.uri).toBe(uriOf('device/pump.devm'));

        // go to source (implementation) of an in port: the instance sending the data (through the connection)
        const sources = await connection.sendRequest<Array<{ targetUri: string, targetSelectionRange: { start: { line: number } } }> | null>('textDocument/implementation', {
            textDocument: { uri: plantUri() }, position: position(PLANT, 'pump.start', 0, 6)
        });
        expect(sources).toHaveLength(1);
        expect(sources![0].targetUri).toBe(plantUri());
        expect(sources![0].targetSelectionRange.start.line).toBe(position(PLANT, 'panel : Panel').line);
    });

    it('finds references and renames a component type across files', async () => {
        const references = await connection.sendRequest<Array<{ uri: string }>>('textDocument/references', {
            textDocument: { uri: partsUri() }, position: position(PARTS, 'PumpControl', 0, 2), context: { includeDeclaration: true }
        });
        expect(new Set(references.map(r => r.uri))).toEqual(new Set([partsUri(), plantUri()]));

        const edit = await connection.sendRequest<{ changes: Record<string, Array<{ newText: string }>> }>('textDocument/rename', {
            textDocument: { uri: partsUri() }, position: position(PARTS, 'PumpControl', 0, 2), newName: 'PumpUnit'
        });
        expect(edit.changes[partsUri()].map(e => e.newText)).toEqual(['PumpUnit']);
        expect(edit.changes[plantUri()].map(e => e.newText)).toEqual(['PumpUnit']);
    });

    it('hovers, completes, formats and lists the symbols of structure files', async () => {
        const hover = await connection.sendRequest<{ contents: { value: string } } | null>('textDocument/hover', {
            textDocument: { uri: plantUri() }, position: position(PLANT, 'PumpControl', 0, 2)
        });
        expect(hover?.contents.value).toContain('The pump control.');

        const completion = await connection.sendRequest<{ items: Array<{ label: string }> } | Array<{ label: string }>>('textDocument/completion', {
            textDocument: { uri: plantUri() }, position: position(PLANT, 'panel.start ->', 0, 6)
        });
        const labels = (Array.isArray(completion) ? completion : completion.items).map(item => item.label);
        expect(labels).toContain('start');

        const unformatted = 'system Fmt {\nthread T {\n        }\n}\n';
        open('device/fmt.devm', 'devm', unformatted);
        await diagnosticsFor(uriOf('device/fmt.devm'));
        const edits = await connection.sendRequest<unknown[]>('textDocument/formatting', {
            textDocument: { uri: uriOf('device/fmt.devm') }, options: { tabSize: 4, insertSpaces: true }
        });
        expect(edits.length).toBeGreaterThan(0);

        const symbols = await connection.sendRequest<Array<{ name: string }>>('textDocument/documentSymbol', { textDocument: { uri: partsUri() } });
        expect(symbols.map(s => s.name)).toEqual(expect.arrayContaining(['PumpSettings', 'PumpControl', 'Panel']));
    });
});
