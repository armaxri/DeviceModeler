#!/usr/bin/env node
// Starts CLion (or another IntelliJ Platform IDE) with the HSM plugin (jetbrains-plugin/) and the examples.
// See `node scripts/ide/clion.mjs --help` and docs/installation.md#trying-the-plugins-locally.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ScriptError, cleanSandbox, cliExecutable, commonHelp, download, ensureCliExecutable, ensureDependencies, homeDir, info, isDirectory, isFile, isMain,
    launchDetached, npm, prepareExamples, repoRoot, run, runScript, sandboxDir, show, step
} from './lib.mjs';

const usage = `Usage: npm run ide:clion -- [options]
       node scripts/ide/clion.mjs [options]

Starts CLion with the JetBrains plugin (jetbrains-plugin/) and opens the examples as a project, with its
own config, system and plugins folders (your CLion settings and plugins are not touched).

Default: Gradle (./gradlew runLocalIde of the plugin build, with scripts/ide/jetbrains-local-ide.init.gradle)
builds the plugin and starts the CLion installation with it, in the sandbox .ide/clion/gradle-sandbox/. The
script waits until the IDE is closed (Ctrl+C stops it). Without a CLion installation it starts IntelliJ IDEA
Community of the plugin's target platform instead (downloaded by Gradle) and says so.

--zip: builds the plugin zip (./gradlew buildPlugin), unpacks it into an isolated plugins folder and starts
the IDE directly with an idea.properties of its own (<PRODUCT>_PROPERTIES) – what users get with
"Install Plugin from Disk…". The IDE runs detached.

Both modes install the plugin LSP4IJ (version of jetbrains-plugin/gradle.properties; --zip downloads it from
the JetBrains Marketplace into .ide/clion/downloads/ once): the HSM language server in the text editor.

Options:
  --clion <path>     the IDE to use (env HSM_CLION): CLion.app or the installation folder; any IntelliJ
                     Platform IDE ≥ 2025.2 works (IntelliJ IDEA, PyCharm, …). Default: CLion in /Applications,
                     ~/Applications, JetBrains Toolbox, /opt, %LOCALAPPDATA%\\Programs, %ProgramFiles%\\JetBrains
  --zip              install the built plugin zip into an isolated profile instead of Gradle's runIde
  --download-clion   without a CLion installation: let Gradle download CLion (./gradlew runClion, large)
                     instead of starting IntelliJ IDEA Community
  --rebuild-cli      rebuild the hsm executable of this platform (npm run build:exe); by default it is only
                     built if missing. It is put into the plugin (-PhsmExecutable) for the validation of
                     closed models.

${commonHelp}

Sandbox: .ide/clion/ (gradle-sandbox/: Gradle mode, zip/<IDE>/: --zip mode, workspace/: examples copy).
Needs a JDK ≥ 17 to run Gradle (the build downloads its JDK 21, the platform and Gradle itself).
`;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests)

/** The LSP4IJ version of jetbrains-plugin/gradle.properties (`lsp4ijVersion = 0.21.0`). */
export function lsp4ijVersionOf(propertiesText) {
    return /^lsp4ijVersion\s*=\s*(\S+)\s*$/m.exec(propertiesText)?.[1];
}

/** The download of an LSP4IJ version from the JetBrains Marketplace. */
export function lsp4ijDownload(version) {
    return {
        fileName: `lsp4ij-${version}.zip`,
        url: `https://plugins.jetbrains.com/plugin/download?pluginId=com.redhat.devtools.lsp4ij&version=${encodeURIComponent(version)}`
    };
}

/**
 * Standard locations of CLion. A `*` segment stands for the entries of that folder (newest last), e.g. the
 * version folders of the JetBrains Toolbox.
 */
export function clionCandidates({ platform = process.platform, env = process.env } = {}) {
    const home = homeDir(env);
    if (platform === 'darwin') {
        const toolbox = path.join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps');
        return [
            '/Applications/CLion.app',
            path.join(home, 'Applications', 'CLion.app'),
            path.join(toolbox, 'CLion', 'ch-0', '*', 'CLion.app'),
            path.join(toolbox, 'clion', 'ch-0', '*', 'CLion.app')
        ];
    }
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
        const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
        return [
            path.win32.join(local, 'Programs', 'CLion'),
            path.win32.join(local, 'Programs', 'CLion *'),
            path.win32.join(local, 'JetBrains', 'Toolbox', 'apps', 'CLion', 'ch-0', '*'),
            path.win32.join(programFiles, 'JetBrains', 'CLion *')
        ];
    }
    const toolbox = path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'JetBrains', 'Toolbox', 'apps');
    return [
        path.join(toolbox, 'clion'),
        path.join(toolbox, 'CLion', 'ch-0', '*'),
        path.join(toolbox, 'clion', 'ch-0', '*'),
        '/opt/clion',
        '/opt/clion-*',
        '/opt/CLion',
        '/usr/local/clion',
        '/snap/clion/current'
    ];
}

/**
 * Expands the `*` segments of a candidate (a segment `prefix*` matches the entries starting with `prefix`);
 * the newest (last in version order) entry first.
 */
export function expandCandidate(candidate, readdir = (dir) => fs.readdirSync(dir)) {
    const separator = candidate.includes('\\') && !candidate.includes('/') ? '\\' : '/';
    const parts = candidate.split(separator);
    const star = parts.findIndex((part) => part.includes('*'));
    if (star < 0) {
        return [candidate];
    }
    const dir = parts.slice(0, star).join(separator) || separator;
    const prefix = parts[star].slice(0, parts[star].indexOf('*'));
    let entries;
    try {
        entries = readdir(dir);
    } catch {
        return [];
    }
    const collator = new Intl.Collator('en', { numeric: true });
    return entries
        .filter((entry) => entry.startsWith(prefix) && !entry.startsWith('.'))
        .sort((a, b) => collator.compare(b, a))
        .flatMap((entry) => expandCandidate([dir === separator ? '' : dir, entry, ...parts.slice(star + 1)].join(separator), readdir));
}

/**
 * The IDE of an installation path (CLion.app, its Contents folder, the installation folder or the launcher
 * in it): the folder with product-info.json, the product info and the launcher of this platform.
 */
export function jetbrainsIde(given, {
    platform = process.platform,
    arch = process.arch,
    exists = isFile,
    readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'))
} = {}) {
    const bases = [given, path.dirname(given), path.dirname(path.dirname(given)), path.dirname(path.dirname(path.dirname(given)))];
    for (const base of bases) {
        for (const infoDir of [path.join(base, 'Contents', 'Resources'), path.join(base, 'Resources'), base]) {
            const infoFile = path.join(infoDir, 'product-info.json');
            if (!exists(infoFile)) {
                continue;
            }
            const product = readJson(infoFile);
            const os = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[platform];
            const cpu = { arm64: 'aarch64', x64: 'amd64' }[arch];
            const launches = (product.launch ?? []).filter((launch) => !launch.os || launch.os === os);
            const launch = launches.find((l) => l.arch === cpu) ?? launches.find((l) => cpu === 'amd64' && l.arch === 'x86_64') ?? launches[0];
            if (!launch?.launcherPath) {
                continue;
            }
            const launcher = path.normalize(path.join(infoDir, launch.launcherPath));
            // the installation for Gradle (`localPath`): CLion.app on macOS, the folder with bin/ elsewhere
            const contents = path.basename(infoDir) === 'Resources' ? path.dirname(infoDir) : infoDir;
            const installation = platform === 'darwin' && path.basename(contents) === 'Contents' && path.dirname(contents).endsWith('.app')
                ? path.dirname(contents)
                : contents;
            return {
                installation,
                launcher,
                name: product.name ?? 'IDE',
                version: product.version ?? '',
                productCode: product.productCode ?? '',
                dataDirectoryName: product.dataDirectoryName ?? `${product.productCode ?? 'IDE'}${product.version ?? ''}`,
                envVarBaseName: product.envVarBaseName ?? envVarBaseNameOf(launcher)
            };
        }
    }
    return undefined;
}

/** `clion64.exe` / `clion.sh` / `clion` → `CLION` (older IDEs without envVarBaseName) (pure). */
export function envVarBaseNameOf(launcher) {
    return launcher.split(/[\\/]/).pop().replace(/(64)?(\.exe|\.sh)?$/i, '').toUpperCase();
}

/** The content of the idea.properties of the --zip sandbox (forward slashes: backslashes are escapes). */
export function ideaProperties(dir) {
    const slash = (file) => file.replace(/\\/g, '/');
    return [
        '# created by scripts/ide/clion.mjs: an isolated profile with the HSM plugin',
        `idea.config.path=${slash(path.join(dir, 'config'))}`,
        `idea.system.path=${slash(path.join(dir, 'system'))}`,
        `idea.plugins.path=${slash(path.join(dir, 'plugins'))}`,
        `idea.log.path=${slash(path.join(dir, 'log'))}`,
        'idea.trust.all.projects=true',
        'ide.show.tips.on.startup.default.value=false',
        ''
    ].join('\n');
}

/** The `--args` value for Gradle (its parser understands double quotes) (pure). */
export function gradleArgs(folder) {
    return /\s/.test(folder) ? `--args="${folder}"` : `--args=${folder}`;
}

// ---------------------------------------------------------------------------------------------------------

const sandbox = sandboxDir('clion');
const pluginProject = path.join(repoRoot, 'jetbrains-plugin');
const initScript = path.join(repoRoot, 'scripts', 'ide', 'jetbrains-local-ide.init.gradle');

function findIde(options) {
    const given = options.clion ?? process.env.HSM_CLION;
    if (given) {
        const ide = jetbrainsIde(path.resolve(given));
        if (!ide) {
            throw new ScriptError(`no IntelliJ Platform IDE found at ${given} (expected CLion.app or the installation folder with product-info.json)`);
        }
        return ide;
    }
    for (const candidate of clionCandidates().flatMap((c) => expandCandidate(c))) {
        if (isDirectory(candidate)) {
            const ide = jetbrainsIde(candidate);
            if (ide) {
                return ide;
            }
        }
    }
    return undefined;
}

function gradlew() {
    return path.join(pluginProject, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

function buildWebApp(options) {
    ensureDependencies(options);
    step('Building the web app (packages/web/dist, part of the plugin)');
    run(npm(), ['run', 'build', '-w', 'packages/language'], options);
    run(npm(), ['run', 'build', '-w', 'packages/web'], options);
}

function extractZip(zip, dir, options) {
    if (process.platform === 'linux') {
        run('unzip', ['-q', '-o', zip, '-d', dir], options);
    } else {
        // bsdtar (macOS, Windows 10+) unpacks zip archives
        run('tar', ['-xf', zip, '-C', dir], options);
    }
}

/** --zip: LSP4IJ (downloaded once) in the plugins folder of the profile. */
async function installLsp4ij(plugins, options) {
    const version = lsp4ijVersionOf(fs.readFileSync(path.join(pluginProject, 'gradle.properties'), 'utf-8'));
    if (!version) {
        throw new ScriptError('no lsp4ijVersion in jetbrains-plugin/gradle.properties');
    }
    const { fileName, url } = lsp4ijDownload(version);
    const zip = path.join(sandbox, 'downloads', fileName);
    if (!isFile(zip)) {
        step(`Downloading LSP4IJ ${version} (${url})`);
        if (!options.dryRun) {
            await download(url, zip);
        }
    }
    step(`Installing LSP4IJ ${version} into ${show(plugins)}`);
    if (!options.dryRun) {
        fs.rmSync(path.join(plugins, 'lsp4ij'), { recursive: true, force: true });
        extractZip(zip, plugins, options);
    }
}

/** --zip: the plugin zip in an isolated profile, IDE started directly. */
async function launchWithZip(ide, folder, options, gradleProperties) {
    if (options.build) {
        step('Building the plugin zip (./gradlew buildPlugin)');
        run(gradlew(), [...gradleProperties, 'buildPlugin'], { cwd: pluginProject, dryRun: options.dryRun });
    }
    const distributions = path.join(pluginProject, 'build', 'distributions');
    const zip = isDirectory(distributions) &&
        fs.readdirSync(distributions).filter((name) => name.endsWith('.zip')).map((name) => path.join(distributions, name))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!zip && !options.dryRun) {
        throw new ScriptError(`no plugin zip in ${show(distributions)}: run without --no-build`);
    }
    const profile = path.join(sandbox, 'zip', ide.dataDirectoryName);
    const plugins = path.join(profile, 'plugins');
    step(`Installing ${zip ? show(zip) : 'the plugin zip'} into ${show(plugins)}`);
    if (!options.dryRun) {
        for (const entry of isDirectory(plugins) ? fs.readdirSync(plugins) : []) {
            if (entry.startsWith('hsm')) {
                fs.rmSync(path.join(plugins, entry), { recursive: true, force: true });
            }
        }
        fs.mkdirSync(plugins, { recursive: true });
        extractZip(zip, plugins, options);
    }
    await installLsp4ij(plugins, options);
    const propertiesFile = path.join(profile, 'idea.properties');
    if (!options.dryRun) {
        fs.writeFileSync(propertiesFile, ideaProperties(profile));
    }
    const variable = `${ide.envVarBaseName}_PROPERTIES`;
    step(`Starting ${ide.name} ${ide.version} (${variable}=${show(propertiesFile)})`);
    const pid = launchDetached(ide.launcher, [folder], {
        env: { [variable]: propertiesFile },
        logFile: path.join(profile, 'ide.out'),
        dryRun: options.dryRun
    });
    info(`profile: ${show(profile)}${pid ? `, PID ${pid}` : ''}`);
    info(`log: ${show(path.join(profile, 'log', 'idea.log'))}`);
}

/** Default: Gradle's runIde with the local IDE (or the default platform). */
function launchWithGradle(ide, folder, options, gradleProperties) {
    const gradleSandbox = path.join(sandbox, 'gradle-sandbox');
    let args;
    if (ide) {
        step(`Starting ${ide.name} ${ide.version} with the plugin (./gradlew runLocalIde; closes with the IDE)`);
        args = ['-I', initScript, `-PhsmLocalIde=${ide.installation}`, `-PhsmSandbox=${gradleSandbox}`, ...gradleProperties, 'runLocalIde', gradleArgs(folder)];
        info(`sandbox: ${show(gradleSandbox)} (log: …/log_runLocalIde/idea.log)`);
    } else if (options['download-clion']) {
        step('No CLion installation found: starting CLion downloaded by Gradle (./gradlew runClion)');
        args = [...gradleProperties, 'runClion', gradleArgs(folder)];
        info(`sandbox: ${show(path.join(pluginProject, '.intellijPlatform', 'sandbox'))}`);
    } else {
        step('No CLion installation found (--clion <path> or HSM_CLION): starting IntelliJ IDEA Community of the ' +
            "plugin's target platform instead (./gradlew runIde, downloaded by Gradle; --download-clion for CLion)");
        args = [...gradleProperties, 'runIde', gradleArgs(folder)];
        info(`sandbox: ${show(path.join(pluginProject, '.intellijPlatform', 'sandbox'))}`);
    }
    run(gradlew(), args, { cwd: pluginProject, dryRun: options.dryRun });
}

if (isMain(import.meta.url)) await runScript({
    usage,
    options: {
        clion: { type: 'string' },
        zip: { type: 'boolean' },
        'download-clion': { type: 'boolean' },
        'rebuild-cli': { type: 'boolean' }
    },
    async main(options) {
        if (!isFile(path.join(pluginProject, 'build.gradle.kts'))) {
            throw new ScriptError('the JetBrains plugin (jetbrains-plugin/) is not part of this branch yet: it is developed ' +
                'on the branch claude/clion-plugin; this script starts CLion with it once it is merged');
        }
        const ide = findIde(options);
        if (ide) {
            step(`IDE: ${ide.name} ${ide.version} (${ide.installation})`);
        } else if (options.zip) {
            throw new ScriptError('--zip needs an installed IDE: no CLion found (pass --clion <path> or set HSM_CLION)');
        }
        if (options.clean) {
            cleanSandbox('clion', { dryRun: options.dryRun });
        }
        if (options.build) {
            buildWebApp(options);
        } else if (!options.dryRun && !isFile(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'))) {
            throw new ScriptError('the web app is not built (packages/web/dist): run without --no-build');
        }
        // the hsm executable of this platform in the plugin (bin/hsm): validation of closed models
        const exe = options.build ? ensureCliExecutable(options, { rebuild: options['rebuild-cli'] }) : cliExecutable();
        const gradleProperties = options.dryRun || isFile(exe) ? [`-PhsmExecutable=${exe}`] : [];
        const folder = prepareExamples(options, 'clion');
        if (options.zip) {
            await launchWithZip(ide, folder, options, gradleProperties);
        } else {
            launchWithGradle(ide, folder, options, gradleProperties);
        }
    }
});
