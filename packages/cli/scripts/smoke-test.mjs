// Smoke test of a built `devm` command line executable (used by the CI workflow on every platform):
// --version, --help, the CLI commands on the examples (state machines and the structure files of examples/device)
// and sessions with the language server (`devm lsp --stdio`) for a state machine and for structure files.
// Usage: node scripts/smoke-test.mjs [executable]   (default: dist/bin/<host target>/devm[.exe])
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const host = `${{ linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform]}-${process.arch}`;
const exe = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'bin', host, process.platform === 'win32' ? 'devm.exe' : 'devm'));
const expectedVersion = process.env.DEVM_VERSION || JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8')).version;

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failures++;
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
    }
}
function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}
function run(...args) {
    return runIn(repo, ...args);
}
function runIn(cwd, ...args) {
    try {
        return execFileSync(exe, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        // the output of the failed command (execFileSync's message only has the start of stderr)
        throw Object.assign(new Error(`devm ${args.join(' ')} failed (exit code ${error.status ?? error.signal})`
            + `\n--- stdout:\n${error.stdout ?? ''}\n--- stderr:\n${error.stderr ?? ''}`), { status: error.status });
    }
}
/** File URIs compared as paths: the server may encode a Windows drive differently (file:///c%3A/… vs file:///C:/…). */
function sameFile(a, b) {
    const normalize = uri => {
        const file = path.resolve(fileURLToPath(uri));
        return process.platform === 'win32' ? file.toLowerCase() : file;
    };
    try {
        return normalize(a) === normalize(b);
    } catch {
        return false;
    }
}

/** A minimal LSP client (Content-Length framing over stdio) talking to `devm lsp --stdio` in the workspace folder `dir`. */
async function startLsp(dir) {
    const server = spawn(exe, ['lsp', '--stdio'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise(resolve => server.on('exit', code => resolve(code)));
    const pending = new Map();
    const notifications = [];
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    server.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            const length = headerEnd < 0 ? undefined : Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
            if (length === undefined || buffer.length < headerEnd + 4 + length) {
                return;
            }
            const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf-8'));
            buffer = buffer.subarray(headerEnd + 4 + length);
            if (message.id !== undefined && message.method === undefined) {
                pending.get(message.id)?.(message);
                pending.delete(message.id);
            } else if (message.id !== undefined) {
                send({ jsonrpc: '2.0', id: message.id, result: null }); // requests of the server (registrations, configuration)
            } else {
                notifications.push(message);
            }
        }
    });
    function send(message) {
        const json = Buffer.from(JSON.stringify(message), 'utf-8');
        server.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);
        server.stdin.write(json);
    }
    function request(method, params) {
        const id = nextId++;
        send({ jsonrpc: '2.0', id, method, params });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 30000);
            pending.set(id, message => {
                clearTimeout(timer);
                message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
            });
        });
    }
    /** The last diagnostics published for a document. */
    async function diagnostics(uri) {
        for (let i = 0; i < 300; i++) {
            const published = notifications.filter(n => n.method === 'textDocument/publishDiagnostics' && sameFile(n.params.uri, uri)).pop();
            if (published) {
                return published.params.diagnostics;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const uris = notifications.filter(n => n.method === 'textDocument/publishDiagnostics').map(n => n.params.uri);
        throw new Error(`no diagnostics for ${uri} (diagnostics published for: ${uris.join(', ') || 'none'})`);
    }
    function open(uri, text) {
        send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'devm', version: 1, text } } });
    }
    async function stop() {
        await request('shutdown', null);
        send({ jsonrpc: '2.0', method: 'exit' });
        const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))]);
        assert(code === 0, `exit code ${code}`);
    }
    const folder = pathToFileURL(dir).toString();
    const init = await request('initialize', { processId: process.pid, rootUri: folder, workspaceFolders: [{ uri: folder, name: 'lsp' }], capabilities: {} });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    return { capabilities: init.capabilities, request, diagnostics, open, stop, kill: () => server.kill() };
}

/** The position of the first occurrence of `search` in `text` (plus `delta` characters). */
function positionOf(text, search, delta = 0) {
    const offset = text.indexOf(search);
    assert(offset >= 0, `'${search}' not found`);
    const before = text.slice(0, offset + delta).split('\n');
    return { line: before.length - 1, character: before[before.length - 1].length };
}

/** The target file of the first location link (or location). */
function targetOf(definition) {
    return definition?.[0]?.targetUri ?? definition?.[0]?.uri;
}

/** State machine file: diagnostics with a header of the include paths, hover and definition into the header. */
async function lspSession(dir) {
    await fs.mkdir(path.join(dir, 'include'), { recursive: true });
    await fs.writeFile(path.join(dir, 'include', 'types.h'), 'namespace io {\n/** Number of steps. */\nconstexpr int kSteps = 4;\n}\n');
    await fs.writeFile(path.join(dir, 'devm.gen.json'), JSON.stringify({ headers: { includePaths: ['include'] } }));
    const model = 'statemachine Gate {\n    import "types.h"\n    interface:\n        var steps : integer = io::kSteps\n        var bad : integer = unknown\n    [*] -> A\n    state A\n}\n';
    const uri = pathToFileURL(path.join(dir, 'gate.devm')).toString();
    await fs.writeFile(path.join(dir, 'gate.devm'), model);

    const lsp = await startLsp(dir);
    try {
        assert(lsp.capabilities.hoverProvider && lsp.capabilities.definitionProvider, 'missing capabilities');
        lsp.open(uri, model);
        const errors = (await lsp.diagnostics(uri)).filter(d => d.severity === 1);
        assert(errors.length === 1 && errors[0].range.start.line === 4, `diagnostics: ${JSON.stringify(errors)}`);
        const position = positionOf(model, 'kSteps', 1);
        const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position });
        assert(JSON.stringify(hover).includes('Number of steps.'), `hover: ${JSON.stringify(hover)}`);
        const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position });
        const target = targetOf(definition);
        assert(target && sameFile(target, pathToFileURL(path.join(dir, 'include', 'types.h')).toString()), `definition: ${JSON.stringify(definition)}`);
        await lsp.stop();
    } finally {
        lsp.kill();
    }
}

/**
 * Structure files (the garage door of examples/device): diagnostics across imported structure files, completion,
 * hover, go to definition into another structure file and into a C/C++ header, document links, symbols and
 * semantic tokens; a broken connection is reported.
 */
async function structureLspSession(dir) {
    await fs.cp(path.join(repo, 'examples', 'device'), dir, { recursive: true });
    const file = path.join(dir, 'garage-door.devm');
    const uri = pathToFileURL(file).toString();
    const components = pathToFileURL(path.join(dir, 'components.devm')).toString();
    const model = await fs.readFile(file, 'utf-8');
    const componentsText = await fs.readFile(path.join(dir, 'components.devm'), 'utf-8');

    const lsp = await startLsp(dir);
    try {
        lsp.open(uri, model);
        const errors = (await lsp.diagnostics(uri)).filter(d => d.severity === 1);
        assert(errors.length === 0, `diagnostics: ${JSON.stringify(errors)}`);

        const typePosition = positionOf(model, 'door : DoorController', 8);
        const hover = await lsp.request('textDocument/hover', { textDocument: { uri }, position: typePosition });
        assert(JSON.stringify(hover).includes('Opens and closes the door'), `hover: ${JSON.stringify(hover)}`);
        const definition = await lsp.request('textDocument/definition', { textDocument: { uri }, position: typePosition });
        assert(sameFile(targetOf(definition) ?? '', components), `definition: ${JSON.stringify(definition)}`);

        const links = await lsp.request('textDocument/documentLink', { textDocument: { uri } });
        assert(links?.some(link => sameFile(link.target, components)), `document links: ${JSON.stringify(links)}`);
        const symbols = await lsp.request('textDocument/documentSymbol', { textDocument: { uri } });
        assert(JSON.stringify(symbols).includes('GarageDoor'), `symbols: ${JSON.stringify(symbols)}`);
        const tokens = await lsp.request('textDocument/semanticTokens/full', { textDocument: { uri } });
        assert(tokens?.data?.length > 0, `semantic tokens: ${JSON.stringify(tokens)}`);

        // completion of part types (no prefix) from the imported structure files: components in threads, subsystems outside of them
        const complete = async position => {
            const completion = await lsp.request('textDocument/completion', { textDocument: { uri }, position });
            return (Array.isArray(completion) ? completion : completion?.items ?? []).map(item => item.label);
        };
        const inThread = await complete(positionOf(model, 'door : DoorController', 7));
        assert(['DoorController', 'PositionSensor'].every(label => inThread.includes(label)) && !inThread.includes('DriveUnit'), `completion in a thread: ${inThread.join(', ')}`);
        const outside = await complete(positionOf(model, 'drive : DriveUnit', 8));
        assert(outside.includes('DriveUnit') && !outside.includes('DoorController'), `completion outside of threads: ${outside.join(', ')}`);

        // a C++ type of an imported header: definition into the header
        lsp.open(components, componentsText);
        const cppPosition = positionOf(componentsText, 'door::Position', 7);
        const cppDefinition = await lsp.request('textDocument/definition', { textDocument: { uri: components }, position: cppPosition });
        assert(sameFile(targetOf(cppDefinition) ?? '', pathToFileURL(path.join(dir, 'door_types.h')).toString()),
            `definition of a C++ type: ${JSON.stringify(cppDefinition)}`);

        // a broken file: a connection to a port that does not exist
        const broken = model.replace('connect door.up -> drive.up', 'connect door.up -> drive.missing');
        const brokenUri = pathToFileURL(path.join(dir, 'broken-door.devm')).toString();
        lsp.open(brokenUri, broken.replace('subsystem GarageDoor', 'subsystem BrokenDoor'));
        const brokenErrors = (await lsp.diagnostics(brokenUri)).filter(d => d.severity === 1);
        assert(brokenErrors.some(d => d.range.start.line === positionOf(broken, 'drive.missing').line), `diagnostics of the broken file: ${JSON.stringify(brokenErrors)}`);
        await lsp.stop();
    } finally {
        lsp.kill();
    }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devm-smoke-'));
console.log(`testing ${exe}`);

await check('--version', () => {
    const output = run('--version').trim();
    assert(output === expectedVersion, `expected ${expectedVersion}, got '${output}'`);
});
await check('--help', () => assert(run('--help').includes('validate'), 'help lists no CLI commands'));
await check('no arguments: help', () => assert(run().includes('generate'), 'no help without arguments'));
await check('validate', () => assert(run('validate', 'examples/cd-player.devm').includes('OK'), 'not OK'));
await check('validate (error exit code)', () => {
    let status = 0;
    try {
        run('validate', 'does-not-exist.devm');
    } catch (error) {
        status = error.status;
    }
    assert(status === 1, `exit code ${status}`);
});
await check('validate --json (several files)', () => {
    const result = JSON.parse(run('validate', '--json', 'examples/cd-player.devm', 'examples/door-with-motor/gate.devm'));
    assert(result.files.length === 2 && result.files.every(file => file.problems.length === 0), JSON.stringify(result));
});
await check('simulate', () => assert(run('simulate', 'examples/cd-player.devm', '-e', 'play').includes('active:'), 'no trace'));
await check('generate cpp', async () => {
    run('generate', 'cpp', 'examples/traffic-light.devm', '-o', path.join(tmp, 'gen'));
    assert((await fs.readFile(path.join(tmp, 'gen', 'TrafficLight.cpp'), 'utf-8')).length > 1000, 'no code');
});
await check('render (ELK layout)', async () => {
    run('render', 'examples/keyboard.devm', '-o', path.join(tmp, 'svg'));
    assert((await fs.readFile(path.join(tmp, 'svg', 'keyboard.svg'), 'utf-8')).includes('<svg'), 'no SVG');
});
await check('test', () => assert(/\d+ passed, 0 failed/.test(run('test', 'examples/tests/traffic-light.devmtest', '--machine', 'examples')), 'tests failed'));
// structure files (examples/device)
await check('validate (structure files)', () => {
    const output = run('validate', 'examples/device/system.devm', 'examples/device/garage-door.devm', 'examples/device/types.devm');
    assert(output.split('\n').filter(line => line.endsWith(': OK')).length === 3, output);
});
await check('validate (structure file with an error)', async () => {
    const dir = path.join(tmp, 'broken-structure');
    await fs.cp(path.join(repo, 'examples', 'device'), dir, { recursive: true });
    const file = path.join(dir, 'garage-door.devm');
    await fs.writeFile(file, (await fs.readFile(file, 'utf-8')).replace('connect door.up -> drive.up', 'connect door.up -> drive.missing'));
    let status = 0;
    try {
        runIn(dir, 'validate', 'garage-door.devm');
    } catch (error) {
        status = error.status;
        assert(/garage-door\.devm:\d+:\d+: error: /.test(error.message), error.message);
    }
    assert(status === 1, `exit code ${status}`);
});
await check('render (structure diagram)', async () => {
    run('render', 'examples/device/garage-door.devm', '-o', path.join(tmp, 'ibd'));
    const svg = await fs.readFile(path.join(tmp, 'ibd', 'garage-door.svg'), 'utf-8');
    assert(svg.includes('<svg') && svg.includes('DoorController'), 'no structure diagram');
});
await check('layout (structure diagram)', () => {
    const graph = JSON.parse(run('layout', 'examples/device/system.devm', '--element', 'GarageInstallation'));
    assert(graph.kind === 'system' && graph.name === 'GarageInstallation' && graph.children.length > 0, JSON.stringify(graph).slice(0, 200));
});
await check('generate (project with structure files)', async () => {
    const dir = path.join(tmp, 'project');
    await fs.cp(path.join(repo, 'examples', 'device'), path.join(dir, 'device'), { recursive: true });
    await fs.writeFile(path.join(dir, 'devm.gen.json'), JSON.stringify({ models: ['device/*.devm'], cpp: { outDir: 'gen' } }));
    runIn(dir, 'generate');
    const generated = (await fs.readdir(path.join(dir, 'gen'))).sort();
    assert(JSON.stringify(generated) === JSON.stringify(['DoorController.cpp', 'DoorController.h', 'Drive.cpp', 'Drive.h', 'sc_statemachine.h']),
        `generated: ${generated.join(', ')}`);
    assert(runIn(dir, 'generate', '--check').includes('up to date'), 'generated files out of date');
});
await check('test (structure files next to the state machines)', () => {
    assert(/\d+ passed, 0 failed/.test(run('test', 'examples/tests/door.devmtest', '--machine', 'examples', 'examples/device')), 'tests failed');
});
await check('lsp --stdio (diagnostics, hover, definition into a header, shutdown)', () => lspSession(path.join(tmp, 'lsp')));
await check('lsp --stdio (structure files: diagnostics, hover, definition, completion, links, symbols, semantic tokens)',
    () => structureLspSession(path.join(tmp, 'lsp-structure')));

await fs.rm(tmp, { recursive: true, force: true });
if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('all checks passed');
