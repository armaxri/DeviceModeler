// Smoke test of the desktop app (used by CI on every platform; on Linux under xvfb-run): starts the app with
// `--smoke-test <copy of examples/door-with-motor/gate.devm>`, which opens the model in a hidden window, waits
// until the diagram shows its states and the page validated it without errors (the import of motor.devm is
// resolved from the folder), edits the text, saves it through the page (api/save), goes to the definition of
// the import of motor.devm (a window of its own) and opens a header at a position (a read-only viewer window).
// Then the structure file examples/device/garage-door.devm (`--smoke-structure`): the structure diagram, go to
// definition on the type of an instance, a double-click on the subsystem part (its file opens with the
// breadcrumb of the part) and on an instance with a state machine there. Exits with 0.
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
        darwin: ['mac-arm64', 'mac', 'mac-x64'].map(dir => path.join(release, dir, 'Device Modeler.app', 'Contents', 'MacOS', 'Device Modeler')),
        win32: ['win-unpacked', 'win-arm64-unpacked'].map(dir => path.join(release, dir, 'Device Modeler.exe')),
        linux: ['linux-unpacked', 'linux-arm64-unpacked'].map(dir => path.join(release, dir, 'device-modeler'))
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devm-desktop-smoke-'));
const model = path.join(tmp, 'models', 'gate.devm');
const result = path.join(tmp, 'result.json');
await fs.cp(path.join(repo, 'examples', 'door-with-motor'), path.join(tmp, 'models'), { recursive: true });
// a header for the go to definition into a header viewer window
await fs.writeFile(path.join(tmp, 'models', 'smoke_types.h'), '#pragma once\nenum class Mode { Off, On };\n');
// structure files (a folder of their own: the root of their imports and of the "used by" links)
const structure = path.join(tmp, 'device', 'garage-door.devm');
await fs.cp(path.join(repo, 'examples', 'device'), path.join(tmp, 'device'), { recursive: true });

const args = [...prefix, '--smoke-test', model, '--smoke-result', result, '--smoke-structure', structure];
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
