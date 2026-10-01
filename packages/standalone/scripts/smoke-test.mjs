// Smoke test of a built `hsm` executable (used by the CI workflow on every platform):
// --version, CLI commands on the examples and the UI server in embedding mode.
// Usage: node scripts/smoke-test.mjs [executable]   (default: dist/bin/<host target>/hsm[.exe])
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-smoke-'));
console.log(`testing ${exe}`);

await check('--version', () => {
    const output = run('--version').trim();
    assert(output === expectedVersion, `expected ${expectedVersion}, got '${output}'`);
});
await check('--help', () => assert(run('--help').includes('validate'), 'help lists no CLI commands'));
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

await check('ui --no-open --port 0 --json --exit-on-stdin-close', async () => {
    const child = spawn(exe, ['ui', '--no-open', '--port', '0', '--json', '--exit-on-stdin-close'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    try {
        const line = await Promise.race([
            new Promise(resolve => createInterface({ input: child.stdout }).once('line', resolve)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('no output within 30 s')), 30000))
        ]);
        const event = JSON.parse(line);
        assert(event.event === 'listening' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(event.url), `unexpected event ${line}`);
        const index = await get(event.url);
        assert(index.status === 200 && index.body.includes('HSM Modeler'), `index.html: ${index.status}`);
        const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(index.body)?.[1];
        assert(script, 'no script in index.html');
        const asset = await get(event.url + script);
        assert(asset.status === 200 && asset.type.startsWith('text/javascript') && asset.body.length > 100000, `${script}: ${asset.status} ${asset.type}`);
        const info = JSON.parse((await get(`${event.url}api/info`)).body);
        assert(info.app === 'hsm-modeler' && info.version === expectedVersion, `api/info: ${JSON.stringify(info)}`);
        assert((await get(`${event.url}nothing-here.js`)).status === 404, 'missing file not 404');
        assert((await get(event.url, { host: 'evil.example:80' })).status === 403, 'foreign Host header not rejected');
        // closing stdin stops the server (the parent process of an IDE went away)
        child.stdin.end();
        const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))]);
        assert(code === 0, `exit code after closing stdin: ${code}`);
    } finally {
        child.kill();
    }
});

await fs.rm(tmp, { recursive: true, force: true });
if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('all checks passed');

function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf-8') }));
        }).on('error', reject);
    });
}
