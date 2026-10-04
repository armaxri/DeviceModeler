// Smoke test of a built `hsm` command line executable (used by the CI workflow on every platform):
// --version, --help, the CLI commands on the examples and a session with the language server (`hsm lsp --stdio`).
// Usage: node scripts/smoke-test.mjs [executable]   (default: dist/bin/<host target>/hsm[.exe])
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');
const host = `${{ linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform]}-${process.arch}`;
const exe = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'bin', host, process.platform === 'win32' ? 'hsm.exe' : 'hsm'));
const expectedVersion = process.env.HSM_VERSION || JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8')).version;

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
    return execFileSync(exe, args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A minimal LSP client (Content-Length framing over stdio) talking to `hsm lsp --stdio` in a workspace with a header. */
async function lspSession(dir) {
    await fs.mkdir(path.join(dir, 'include'), { recursive: true });
    await fs.writeFile(path.join(dir, 'include', 'types.h'), 'namespace io {\n/** Number of steps. */\nconstexpr int kSteps = 4;\n}\n');
    await fs.writeFile(path.join(dir, 'hsm.gen.json'), JSON.stringify({ headers: { includePaths: ['include'] } }));
    const model = 'statemachine Gate {\n    import "types.h"\n    interface:\n        var steps : integer = io::kSteps\n        var bad : integer = unknown\n    [*] -> A\n    state A\n}\n';
    const uri = pathToFileURL(path.join(dir, 'gate.hsm')).toString();
    await fs.writeFile(path.join(dir, 'gate.hsm'), model);

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
    async function diagnostics() {
        for (let i = 0; i < 300; i++) {
            const published = notifications.filter(n => n.method === 'textDocument/publishDiagnostics' && n.params.uri === uri).pop();
            if (published) {
                return published.params.diagnostics;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('no diagnostics');
    }
    try {
        const folder = pathToFileURL(dir).toString();
        const init = await request('initialize', { processId: process.pid, rootUri: folder, workspaceFolders: [{ uri: folder, name: 'lsp' }], capabilities: {} });
        assert(init.capabilities.hoverProvider && init.capabilities.definitionProvider, 'missing capabilities');
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'hsm', version: 1, text: model } } });
        const errors = (await diagnostics()).filter(d => d.severity === 1);
        assert(errors.length === 1 && errors[0].range.start.line === 4, `diagnostics: ${JSON.stringify(errors)}`);
        const position = { line: 3, character: model.split('\n')[3].indexOf('kSteps') + 1 };
        const hover = await request('textDocument/hover', { textDocument: { uri }, position });
        assert(JSON.stringify(hover).includes('Number of steps.'), `hover: ${JSON.stringify(hover)}`);
        const definition = await request('textDocument/definition', { textDocument: { uri }, position });
        const target = definition?.[0]?.targetUri ?? definition?.[0]?.uri;
        // compared as paths: the server's URIs may encode a Windows drive differently (file:///c%3A/…)
        const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
        assert(target && samePath(path.resolve(fileURLToPath(target)), path.resolve(dir, 'include', 'types.h')), `definition: ${JSON.stringify(definition)}`);
        await request('shutdown', null);
        send({ jsonrpc: '2.0', method: 'exit' });
        const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))]);
        assert(code === 0, `exit code ${code}`);
    } finally {
        server.kill();
    }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-smoke-'));
console.log(`testing ${exe}`);

await check('--version', () => {
    const output = run('--version').trim();
    assert(output === expectedVersion, `expected ${expectedVersion}, got '${output}'`);
});
await check('--help', () => assert(run('--help').includes('validate'), 'help lists no CLI commands'));
await check('no arguments: help', () => assert(run().includes('generate'), 'no help without arguments'));
await check('validate', () => assert(run('validate', 'examples/cd-player.hsm').includes('OK'), 'not OK'));
await check('validate (error exit code)', () => {
    let status = 0;
    try {
        run('validate', 'does-not-exist.hsm');
    } catch (error) {
        status = error.status;
    }
    assert(status === 1, `exit code ${status}`);
});
await check('validate --json (several files)', () => {
    const result = JSON.parse(run('validate', '--json', 'examples/cd-player.hsm', 'examples/door-with-motor/gate.hsm'));
    assert(result.files.length === 2 && result.files.every(file => file.problems.length === 0), JSON.stringify(result));
});
await check('simulate', () => assert(run('simulate', 'examples/cd-player.hsm', '-e', 'play').includes('active:'), 'no trace'));
await check('generate cpp', async () => {
    run('generate', 'cpp', 'examples/traffic-light.hsm', '-o', path.join(tmp, 'gen'));
    assert((await fs.readFile(path.join(tmp, 'gen', 'TrafficLight.cpp'), 'utf-8')).length > 1000, 'no code');
});
await check('render (ELK layout)', async () => {
    run('render', 'examples/keyboard.hsm', '-o', path.join(tmp, 'svg'));
    assert((await fs.readFile(path.join(tmp, 'svg', 'keyboard.svg'), 'utf-8')).includes('<svg'), 'no SVG');
});
await check('test', () => assert(/\d+ passed, 0 failed/.test(run('test', 'examples/tests/traffic-light.hsmtest', '--machine', 'examples')), 'tests failed'));
await check('lsp --stdio (diagnostics, hover, definition into a header, shutdown)', () => lspSession(path.join(tmp, 'lsp')));

await fs.rm(tmp, { recursive: true, force: true });
if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('all checks passed');
