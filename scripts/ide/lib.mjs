// Shared helpers of the IDE launch scripts (scripts/ide/*.mjs): argument parsing, sandbox folders, the
// examples workspace, finding executables, running commands, downloads.
//
// Everything an IDE writes (profiles, settings, workspaces, downloaded IDEs) lives below `.ide/<ide>/` of
// the repository (git-ignored), so the normal installations and profiles of the user are not touched.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The repository root. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The sandbox root `.ide/` (git-ignored). */
export const sandboxRoot = path.join(repoRoot, '.ide');

/** The options every script understands. */
export const commonOptions = {
    help: { type: 'boolean', short: 'h' },
    'no-build': { type: 'boolean' },
    examples: { type: 'string' },
    'in-place': { type: 'boolean' },
    clean: { type: 'boolean' },
    'dry-run': { type: 'boolean' }
};

/** Help text of the common options. */
export const commonHelp = `Common options:
  --no-build         use the existing build (do not build the plugin / extension first)
  --examples <dir>   open this folder instead of the examples
  --in-place         open the repository's examples/ directly (edits change the repository)
                     default: a copy of examples/ in the sandbox (.ide/<ide>/workspace/devm-examples),
                     created on the first start and kept afterwards (--clean for a fresh copy)
  --clean            reset the sandbox of this IDE first (profile, settings, workspace, examples copy;
                     downloaded IDEs are kept)
  --dry-run          only print what would be done
  -h, --help         this help`;

/**
 * Parses the command line: the common options plus `extra` (options of node:util parseArgs).
 * Throws a UsageError for unknown options, missing values or contradicting options.
 */
export function parseOptions(argv, extra = {}) {
    let values;
    try {
        ({ values } = parseArgs({ args: argv, options: { ...commonOptions, ...extra }, allowPositionals: false, strict: true }));
    } catch (error) {
        throw new UsageError(error.message);
    }
    if (values.examples !== undefined && values['in-place']) {
        throw new UsageError('--examples and --in-place exclude each other');
    }
    return {
        ...values,
        build: !values['no-build'],
        inPlace: Boolean(values['in-place']),
        clean: Boolean(values.clean),
        dryRun: Boolean(values['dry-run']),
        help: Boolean(values.help)
    };
}

export class UsageError extends Error {}

/**
 * Runs `main(options)` of a script: parses the options, prints the help, reports errors without stack traces.
 * @param {{ name: string, usage: string, options?: object, main: (options: object) => Promise<void> | void }} script
 */
export async function runScript({ usage, options = {}, main }) {
    let parsed;
    try {
        parsed = parseOptions(process.argv.slice(2), options);
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`error: ${error.message}\n`);
            console.error(usage);
            process.exit(2);
        }
        throw error;
    }
    if (parsed.help) {
        console.log(usage);
        return;
    }
    try {
        await main(parsed);
    } catch (error) {
        if (error instanceof ScriptError) {
            console.error(`\nerror: ${error.message}`);
            process.exit(1);
        }
        throw error;
    }
}

/** An expected failure (message without stack trace). */
export class ScriptError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Output

export function step(message) {
    console.log(`\n==> ${message}`);
}

export function info(message) {
    console.log(`    ${message}`);
}

/** A path for messages: relative to the repository if inside of it. */
export function show(file) {
    const relative = path.relative(repoRoot, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

// ---------------------------------------------------------------------------------------------------------
// Sandbox and examples

/** The sandbox folder of an IDE: `.ide/<ide>`. */
export function sandboxDir(ide) {
    return path.join(sandboxRoot, ide);
}

/**
 * Removes the sandbox of an IDE except the entries listed in `keep` (e.g. the downloads).
 */
export function cleanSandbox(ide, { keep = [], dryRun = false } = {}) {
    const dir = sandboxDir(ide);
    if (!fs.existsSync(dir)) {
        return;
    }
    step(`Resetting the sandbox ${show(dir)}${keep.length ? ` (keeping ${keep.join(', ')})` : ''}`);
    for (const entry of fs.readdirSync(dir)) {
        if (!keep.includes(entry)) {
            info(`remove ${show(path.join(dir, entry))}`);
            if (!dryRun) {
                fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
            }
        }
    }
}

/** Folders of examples/ that are not copied (build output of the CMake examples). */
const skippedExampleDirs = new Set(['build', 'node_modules', '.cache', 'out']);

/**
 * Decides which folder the IDE opens (pure): `--examples <dir>`, the repository's examples (`--in-place`) or
 * the copy in the sandbox.
 * @returns {{ dir: string, copy: boolean }}
 */
export function examplesTarget(options, ide, { cwd = process.cwd() } = {}) {
    if (options.examples !== undefined) {
        return { dir: path.resolve(cwd, options.examples), copy: false };
    }
    if (options.inPlace) {
        return { dir: path.join(repoRoot, 'examples'), copy: false };
    }
    return { dir: path.join(sandboxDir(ide), 'workspace', 'devm-examples'), copy: true };
}

/**
 * The folder the IDE opens: the copy of examples/ in the sandbox (created if missing), the repository's
 * examples (`--in-place`) or `--examples <dir>`.
 */
export function prepareExamples(options, ide) {
    const { dir, copy } = examplesTarget(options, ide);
    if (!copy) {
        if (!fs.existsSync(dir)) {
            throw new ScriptError(`the folder ${dir} does not exist`);
        }
        step(`Opening ${show(dir)}${options.inPlace ? ' (in place: edits change the repository)' : ''}`);
        return dir;
    }
    if (fs.existsSync(dir)) {
        step(`Using the examples copy ${show(dir)} (kept from an earlier start; --clean for a fresh copy)`);
        return dir;
    }
    step(`Copying examples/ to ${show(dir)}`);
    if (!options.dryRun) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'examples'), dir, {
            recursive: true,
            filter: (source) => !skippedExampleDirs.has(path.basename(source))
        });
    }
    return dir;
}

// ---------------------------------------------------------------------------------------------------------
// Finding executables

/** The directories of the PATH (pure). */
export function pathDirs(env = process.env, platform = process.platform) {
    const value = env.PATH ?? env.Path ?? '';
    return value.split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** The file names a command may have (`code` → `code.cmd`, `code.exe`, … on Windows) (pure). */
export function commandFileNames(command, platform = process.platform, env = process.env) {
    if (platform !== 'win32') {
        return [command];
    }
    const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
    return [command, ...extensions.map((extension) => command + extension)];
}

/** Searches a command in the PATH; undefined if not found. */
export function which(command, { env = process.env, platform = process.platform, exists = isFile } = {}) {
    for (const dir of pathDirs(env, platform)) {
        for (const name of commandFileNames(command, platform, env)) {
            const candidate = path.join(dir, name);
            if (exists(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

/** The first existing path of `candidates`. */
export function firstExisting(candidates, exists = fs.existsSync) {
    return candidates.find((candidate) => candidate && exists(candidate));
}

export function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

export function isDirectory(file) {
    try {
        return fs.statSync(file).isDirectory();
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Running commands

/** Windows batch files (`npm.cmd`, `code.cmd`, `mvn.cmd`, `gradlew.bat`) must be started through the shell. */
function needsShell(command) {
    return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function quoteForCmd(arg) {
    return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function spawnArgs(command, args) {
    if (needsShell(command)) {
        return { command: [command, ...args].map(quoteForCmd).join(' '), args: [], shell: true };
    }
    return { command, args, shell: false };
}

/** A command line for messages. */
export function commandLine(command, args) {
    return [command, ...args].map((arg) => (/[\s"'$]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

/**
 * Runs a command in the foreground (output to the console); throws a ScriptError if it fails.
 */
export function run(command, args, { cwd = repoRoot, env, dryRun = false, allowFailure = false, quiet = false } = {}) {
    if (!quiet) {
        info(`$ ${cwd !== repoRoot ? `(cd ${show(cwd)}) ` : ''}${commandLine(command, args)}`);
    }
    if (dryRun) {
        return { status: 0, stdout: '' };
    }
    const spec = spawnArgs(command, args);
    const result = spawnSync(spec.command, spec.args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: spec.shell,
        encoding: 'utf-8'
    });
    if (result.error) {
        throw new ScriptError(`${command} could not be started: ${result.error.message}`);
    }
    if (result.status !== 0 && !allowFailure) {
        const output = quiet ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
        throw new ScriptError(`${commandLine(command, args)} failed (exit code ${result.status})${output}`);
    }
    return result;
}

/**
 * Starts a program detached from this script (it keeps running after the script ends); its output goes to
 * `logFile`. Returns the PID.
 */
export function launchDetached(command, args, { cwd = repoRoot, env, logFile, dryRun = false } = {}) {
    info(`$ ${commandLine(command, args)}`);
    if (logFile) {
        info(`output: ${show(logFile)}`);
    }
    if (dryRun) {
        return undefined;
    }
    let out = 'ignore';
    if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        out = fs.openSync(logFile, 'w');
    }
    const spec = spawnArgs(command, args);
    const child = spawn(spec.command, spec.args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        detached: true,
        stdio: ['ignore', out, out],
        shell: spec.shell,
        windowsHide: false
    });
    child.on('error', (error) => {
        console.error(`error: ${command} could not be started: ${error.message}`);
        process.exitCode = 1;
    });
    child.unref();
    return child.pid;
}

/** `npm` of this platform. */
export function npm() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** Installs the dependencies of the repository if node_modules is missing. */
export function ensureDependencies({ dryRun = false } = {}) {
    if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
        step('Installing the npm dependencies (node_modules is missing)');
        run(npm(), ['install'], { dryRun });
    }
}

/** The target name of packages/cli for a platform (`macos-arm64`, `windows-x64`, …) (pure). */
export function cliTarget(platform = process.platform, arch = process.arch) {
    const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform] ?? platform;
    return `${os}-${arch}`;
}

/** The devm executable of this platform built by packages/cli (`npm run build:exe`). */
export function cliExecutable() {
    return path.join(repoRoot, 'packages', 'cli', 'dist', 'bin', cliTarget(), process.platform === 'win32' ? 'devm.exe' : 'devm');
}

/** Builds the devm executable of this platform if it is missing (or `rebuild`); returns its path. */
export function ensureCliExecutable(options, { rebuild = false } = {}) {
    const exe = cliExecutable();
    if (rebuild || !isFile(exe)) {
        step(`Building the devm executable of this platform (${show(exe)}, npm run build:exe)`);
        run(npm(), ['run', 'build:exe'], options);
    }
    return exe;
}

// ---------------------------------------------------------------------------------------------------------
// Downloads

/** Downloads `url` to `file` (via a temporary file) and returns the SHA-512 of the content (hex). */
export async function download(url, file) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new ScriptError(`download of ${url} failed: HTTP ${response.status}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.part`;
    const hash = createHash('sha512');
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastReport = 0;
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        if (process.stdout.isTTY && Date.now() - lastReport > 500) {
            lastReport = Date.now();
            const percent = total ? ` (${Math.round((received / total) * 100)} %)` : '';
            process.stdout.write(`\r    ${(received / 1048576).toFixed(0)} MB${percent}   `);
        }
    });
    await pipeline(body, fs.createWriteStream(partial));
    if (process.stdout.isTTY) {
        process.stdout.write('\n');
    }
    fs.renameSync(partial, file);
    return hash.digest('hex');
}

/** SHA-512 of a file (hex). */
export async function sha512(file) {
    const hash = createHash('sha512');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
}

/** Fetches a small text file. */
export async function fetchText(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new ScriptError(`download of ${url} failed: HTTP ${response.status}`);
    }
    return response.text();
}

/** The checksum of a `.sha512` file (`<hex>  <file name>` or just `<hex>`) (pure). */
export function parseChecksumFile(text) {
    const match = /^\s*([0-9a-fA-F]{128})\b/.exec(text);
    if (!match) {
        throw new ScriptError('the checksum file has an unexpected format');
    }
    return match[1].toLowerCase();
}

/** The home directory (for tests: `HOME` of `env`). */
export function homeDir(env = process.env) {
    return env.HOME || env.USERPROFILE || os.homedir();
}

/** Whether the module `moduleUrl` is the script node was started with (not imported by a test). */
export function isMain(moduleUrl) {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}
