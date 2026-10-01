// Smoke test of a built `hsm` command line executable (used by the CI workflow on every platform):
// --version, --help and the CLI commands on the examples.
// Usage: node scripts/smoke-test.mjs [executable]   (default: dist/bin/<host target>/hsm[.exe])
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

await fs.rm(tmp, { recursive: true, force: true });
if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('all checks passed');
