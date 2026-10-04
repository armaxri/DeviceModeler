#!/usr/bin/env node
// Starts the desktop app (packages/desktop) from the sources with the examples folder.
// See `node scripts/ide/desktop.mjs --help` and docs/installation.md#trying-the-plugins-locally.
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
    ScriptError, cleanSandbox, commonHelp, ensureDependencies, info, isFile, isMain, launchDetached, npm,
    prepareExamples, repoRoot, run, runScript, sandboxDir, show, step
} from './lib.mjs';

const usage = `Usage: npm run ide:desktop -- [options]
       node scripts/ide/desktop.mjs [options]

Builds the desktop app (packages/desktop) and starts it with Electron from the sources, with its own user
data folder in .ide/desktop/ (recent files, page settings; an installed Device Modeler is not touched and not
reused as running instance), and opens the examples folder (the list of its models).

${commonHelp}

Sandbox: .ide/desktop/ (user-data/, workspace/).
`;

const sandbox = sandboxDir('desktop');
const appDir = path.join(repoRoot, 'packages', 'desktop');

/** The Electron executable of node_modules/electron. */
function electronExecutable() {
    try {
        const electron = createRequire(path.join(appDir, 'package.json'))('electron');
        if (typeof electron === 'string' && isFile(electron)) {
            return electron;
        }
    } catch {
        // reported below
    }
    throw new ScriptError('Electron is not installed (node_modules/electron/dist): run `npm install` or `node node_modules/electron/install.js`');
}

if (isMain(import.meta.url)) await runScript({
    usage,
    async main(options) {
        if (options.clean) {
            cleanSandbox('desktop', { dryRun: options.dryRun });
        }
        if (options.build) {
            ensureDependencies(options);
            step('Building the desktop app (packages/desktop: web app and main process)');
            run(npm(), ['run', 'build', '-w', 'packages/language'], options);
            run(npm(), ['run', 'bundle', '-w', 'packages/desktop'], options);
        }
        if (!options.dryRun && !isFile(path.join(appDir, 'dist', 'main.cjs'))) {
            throw new ScriptError('the desktop app is not built (packages/desktop/dist): run without --no-build');
        }
        const electron = options.dryRun ? 'electron' : electronExecutable();
        const folder = prepareExamples(options, 'desktop');
        const userData = path.join(sandbox, 'user-data');
        if (!options.dryRun) {
            fs.mkdirSync(userData, { recursive: true });
        }
        step('Starting Device Modeler (Electron, development mode)');
        const pid = launchDetached(electron, [appDir, `--user-data-dir=${userData}`, folder], {
            logFile: path.join(sandbox, 'electron.out'),
            dryRun: options.dryRun
        });
        info(`user data: ${show(userData)}${pid ? `, PID ${pid}` : ''}`);
    }
});
