#!/usr/bin/env node
// Starts VS Code with the HSM extension (packages/vscode) in an isolated profile and opens the examples.
// See `node scripts/ide/vscode.mjs --help` and docs/installation.md#trying-the-plugins-locally.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ScriptError, cleanSandbox, commonHelp, ensureDependencies, firstExisting, homeDir, info, isFile, isMain,
    launchDetached, npm, prepareExamples, repoRoot, run, runScript, sandboxDir, show, step, which
} from './lib.mjs';

const usage = `Usage: npm run ide:vscode -- [options]
       node scripts/ide/vscode.mjs [options]

Builds the VS Code extension (packages/vscode) and starts VS Code with an isolated profile (own user data and
extensions folders in .ide/vscode/, so your VS Code settings and extensions are not touched) and the examples.

By default the extension is loaded from packages/vscode in development mode (an "Extension Development
Host" window, as with F5 in VS Code; best for debugging). With --vsix the .vsix is packaged and installed
into the isolated extensions folder instead (what users get).

Options:
  --code <path>      the VS Code command line (code, code.cmd) or app to use (env HSM_VSCODE); default: code,
                     code-insiders or codium in the PATH, else the standard installation folders
  --vsix             package the .vsix and install it into the sandbox instead of the development mode

${commonHelp}

Sandbox: .ide/vscode/ (user-data/, extensions/). Only the HSM extension is installed; install others (e.g.
the C/C++ extension for the generated code) in that window as usual – they stay in the sandbox.
`;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests)

/** Standard locations of the VS Code command line (after the PATH). */
export function vscodeCandidates({ platform = process.platform, env = process.env } = {}) {
    const home = homeDir(env);
    if (platform === 'darwin') {
        const apps = [
            ['Visual Studio Code.app', 'code'],
            ['Visual Studio Code - Insiders.app', 'code-insiders'],
            ['VSCodium.app', 'codium']
        ];
        return ['/Applications', path.join(home, 'Applications')].flatMap((dir) =>
            apps.map(([app, cli]) => path.join(dir, app, 'Contents', 'Resources', 'app', 'bin', cli)));
    }
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
        const programFiles = [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)']].filter(Boolean);
        const installs = [
            ['Microsoft VS Code', 'code.cmd'],
            ['Microsoft VS Code Insiders', 'code-insiders.cmd'],
            ['VSCodium', 'codium.cmd']
        ];
        return [path.win32.join(local, 'Programs'), ...programFiles].flatMap((dir) =>
            installs.map(([folder, cli]) => path.win32.join(dir, folder, 'bin', cli)));
    }
    return [
        '/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code', '/usr/local/bin/code',
        '/usr/bin/code-insiders', '/usr/bin/codium', '/snap/bin/codium',
        path.join(home, '.local', 'bin', 'code')
    ];
}

/** The command line of a given VS Code: the CLI itself, or the one inside an app / installation folder. */
export function vscodeCliOf(given, { platform = process.platform, exists = isFile } = {}) {
    const candidates = [given];
    for (const cli of ['code', 'code-insiders', 'codium']) {
        if (platform === 'darwin') {
            candidates.push(path.join(given, 'Contents', 'Resources', 'app', 'bin', cli));
        }
        candidates.push(path.join(given, 'bin', platform === 'win32' ? `${cli}.cmd` : cli));
    }
    return candidates.find((candidate) => exists(candidate));
}

/** The arguments of the launch (pure). */
export function vscodeArguments({ userDataDir, extensionsDir, developmentPath, folder, file }) {
    const args = [
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust'
    ];
    if (developmentPath) {
        args.push(`--extensionDevelopmentPath=${developmentPath}`);
    }
    args.push(folder);
    if (file) {
        args.push(file);
    }
    return args;
}

/** settings.json of a new sandbox profile. */
export const sandboxSettings = {
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    // the sandbox lies inside the HSM repository
    'git.openRepositoryInParentFolders': 'never',
    'hsm.diagram.autoOpen': true
};

// ---------------------------------------------------------------------------------------------------------

const sandbox = sandboxDir('vscode');
const extensionDir = path.join(repoRoot, 'packages', 'vscode');

function findVsCode(options) {
    const given = options.code ?? process.env.HSM_VSCODE;
    if (given) {
        const cli = vscodeCliOf(path.resolve(given)) ?? which(given);
        if (!cli) {
            throw new ScriptError(`no VS Code command line found at ${given}`);
        }
        return cli;
    }
    const cli = which('code') ?? which('code-insiders') ?? which('codium') ?? firstExisting(vscodeCandidates(), isFile);
    if (!cli) {
        throw new ScriptError('VS Code not found: install it (https://code.visualstudio.com) or pass --code <path to code>');
    }
    return cli;
}

function vsixPath() {
    const { name, version } = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf-8'));
    return path.join(extensionDir, `${name}-${version}.vsix`);
}

if (isMain(import.meta.url)) await runScript({
    usage,
    options: {
        code: { type: 'string' },
        vsix: { type: 'boolean' }
    },
    async main(options) {
        const cli = findVsCode(options);
        step(`VS Code: ${cli}`);
        if (options.clean) {
            cleanSandbox('vscode', { dryRun: options.dryRun });
        }
        if (options.build) {
            ensureDependencies(options);
            step('Building the extension (packages/language, packages/vscode)');
            run(npm(), ['run', 'build', '-w', 'packages/language'], options);
            run(npm(), options.vsix ? ['run', 'package:vscode'] : ['run', 'build', '-w', 'packages/vscode'], options);
        }
        if (!options.dryRun && !isFile(path.join(extensionDir, 'dist', 'extension.cjs'))) {
            throw new ScriptError('the extension is not built (packages/vscode/dist): run without --no-build');
        }

        const userDataDir = path.join(sandbox, 'user-data');
        const extensionsDir = path.join(sandbox, 'extensions');
        const settingsFile = path.join(userDataDir, 'User', 'settings.json');
        if (!isFile(settingsFile)) {
            step(`Creating the sandbox profile ${show(userDataDir)}`);
            if (!options.dryRun) {
                fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
                fs.mkdirSync(extensionsDir, { recursive: true });
                fs.writeFileSync(settingsFile, `${JSON.stringify(sandboxSettings, null, 4)}\n`);
            }
        }

        if (options.vsix) {
            const vsix = vsixPath();
            if (!options.dryRun && !isFile(vsix)) {
                throw new ScriptError(`${show(vsix)} is missing: run without --no-build`);
            }
            step(`Installing ${show(vsix)} into the sandbox`);
            run(cli, ['--user-data-dir', userDataDir, '--extensions-dir', extensionsDir, '--install-extension', vsix, '--force'], options);
        }

        const folder = prepareExamples(options, 'vscode');
        const file = path.join(folder, 'traffic-light.hsm');
        step(options.vsix ? 'Starting VS Code with the installed .vsix' : 'Starting VS Code with the extension in development mode');
        launchDetached(cli, vscodeArguments({
            userDataDir,
            extensionsDir,
            developmentPath: options.vsix ? undefined : extensionDir,
            folder,
            file: options.dryRun || isFile(file) ? file : undefined
        }), { logFile: path.join(sandbox, 'code.out'), dryRun: options.dryRun });
        info(`logs: ${show(path.join(userDataDir, 'logs'))} (extension host: …/window1/exthost/exthost.log)`);
    }
});
