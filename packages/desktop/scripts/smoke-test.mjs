// Smoke test of the desktop app (used by CI on every platform; on Linux under xvfb-run): starts the app with
// `--smoke-test <copy of examples/door-with-motor/gate.hsm>`, which opens the model in a hidden window, waits
// until the diagram shows its states and the page validated it without errors (the import of motor.hsm is
// resolved from the folder), edits the text, saves it through the page (api/save), goes to the definition of
// the import of motor.hsm (a window of its own) and opens a header at a position (a read-only viewer window),
// and exits with 0.
// Usage: node scripts/smoke-test.mjs [app executable]
//   default: the unpacked app of scripts/package.mjs in release/, else Electron with dist/ (development)
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '../..');

async function exists(file) {
    return fs.access(file).then(() => true, () => false);
}

/** The executable of the unpacked app in release/ (scripts/package.mjs), if there is one. */
async function packagedApp() {
    const release = path.join(root, 'release');
    const candidates = {
        darwin: ['mac-arm64', 'mac', 'mac-x64'].map(dir => path.join(release, dir, 'HSM Modeler.app', 'Contents', 'MacOS', 'HSM Modeler')),
        win32: ['win-unpacked', 'win-arm64-unpacked'].map(dir => path.join(release, dir, 'HSM Modeler.exe')),
        linux: ['linux-unpacked', 'linux-arm64-unpacked'].map(dir => path.join(release, dir, 'hsm-modeler'))
    }[process.platform] ?? [];
    for (const candidate of candidates) {
        if (await exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

const explicit = process.argv[2];
const app = explicit ? path.resolve(explicit) : await packagedApp();
const command = app ?? createRequire(import.meta.url)('electron');
const prefix = app ? [] : [root];
console.log(`testing ${app ?? `Electron (development) with ${root}`}`);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-desktop-smoke-'));
const model = path.join(tmp, 'models', 'gate.hsm');
const result = path.join(tmp, 'result.json');
await fs.cp(path.join(repo, 'examples', 'door-with-motor'), path.join(tmp, 'models'), { recursive: true });
// a header for the go to definition into a header viewer window
await fs.writeFile(path.join(tmp, 'models', 'smoke_types.h'), '#pragma once\nenum class Mode { Off, On };\n');

const args = [...prefix, '--smoke-test', model, '--smoke-result', result];
if (process.platform === 'linux') {
    // CI containers: no setuid sandbox helper; GPU not available under xvfb
    args.push('--no-sandbox', '--disable-gpu');
}
const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    const timer = setTimeout(() => {
        child.kill();
        resolve('timeout');
    }, 120_000);
    child.once('error', reject);
    child.once('exit', exitCode => {
        clearTimeout(timer);
        resolve(exitCode);
    });
});

let report;
try {
    report = JSON.parse(await fs.readFile(result, 'utf-8'));
} catch {
    report = { ok: false, error: 'no result file' };
}
await fs.rm(tmp, { recursive: true, force: true });
if (code !== 0 || !report.ok) {
    console.log(`FAIL: exit code ${code}, ${JSON.stringify(report)}`);
    process.exit(1);
}
console.log(`ok: the model was shown (${report.states} states in the diagram), saved and navigated (${(report.navigation ?? []).join(', ')}) (version ${report.version})`);
