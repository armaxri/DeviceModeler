#!/usr/bin/env node
// Starts Eclipse with the Device Modeler plugin (eclipse-plugin/) and the examples imported as a project.
// See `node scripts/ide/eclipse.mjs --help` and docs/installation.md#trying-the-plugins-locally.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    ScriptError, cleanSandbox, commonHelp, download, ensureCliExecutable, ensureDependencies, fetchText, info,
    isDirectory, isFile, isMain, launchDetached, npm, parseChecksumFile, prepareExamples, repoRoot, run, runScript,
    sandboxDir, sha512, show, step, which
} from './lib.mjs';

const FEATURE_IU = 'devm.eclipse.feature.feature.group';
const PROJECT_NAME = 'devm-examples';
const PACKAGES = ['cpp', 'java'];

const usage = `Usage: npm run ide:eclipse -- [options]
       node scripts/ide/eclipse.mjs [options]

Builds the Eclipse plugin (update site of eclipse-plugin/, needs Java 21 and Maven), installs it into a
sandbox Eclipse and starts it with a workspace that contains the examples as the project '${PROJECT_NAME}'.

Without --eclipse the script downloads "Eclipse IDE for C/C++ Developers" of the release the plugin is
built against (from archive.eclipse.org, checked against its SHA-512) into .ide/eclipse/install/ once.
The C/C++ package is used because CDT is what C++ users of the Device Modeler work with (the generated code, CMake) and
because it brings a headless project import, so the examples appear in the workspace without a wizard.

Options:
  --eclipse <path>   use this Eclipse installation instead (Eclipse.app, its folder or the executable;
                     env DEVM_ECLIPSE). The plugin is installed INTO this installation – use a separate one.
  --package <name>   package to download: cpp (default) or java (without CDT the import is a wizard)
  --release <name>   release to download (default: the one of eclipse-plugin/pom.xml, e.g. 2025-06)
  --rebuild-cli      rebuild the devm executable of this platform (packages/cli, npm run build:exe) for the
                     plugin's fragment; by default it is only built if it is missing

${commonHelp}

Sandbox: .ide/eclipse/ (install/: Eclipse with the plugin, workspace/: the workspace, downloads/: archives).
`;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the tests)

/** The Eclipse release of eclipse-plugin/pom.xml (`…/releases/2025-06/`). */
export function releaseOfPom(pomText) {
    const match = /<eclipse\.repository>[^<]*\/releases\/([0-9]{4}-[0-9]{2})\/?<\/eclipse\.repository>/.exec(pomText);
    return match?.[1];
}

/**
 * The repositories of the p2 director: the built update site and the Eclipse release repository, from which p2
 * installs the dependencies of the language support (LSP4E, TM4E, LSP4J) if the installation has none.
 */
export function directorRepositories(siteUrl, release) {
    return `${siteUrl},https://download.eclipse.org/releases/${release}/`;
}

/** The EPP download for a platform: archive name and URL on archive.eclipse.org. */
export function eclipseDownload({ release, pkg = 'cpp', platform = process.platform, arch = process.arch }) {
    const os = { darwin: 'macosx-cocoa', linux: 'linux-gtk', win32: 'win32' }[platform];
    const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
    if (!os || !cpu) {
        throw new ScriptError(`no Eclipse download for ${platform}/${arch}`);
    }
    const extension = platform === 'win32' ? 'zip' : 'tar.gz';
    const fileName = `eclipse-${pkg}-${release}-R-${os}-${cpu}.${extension}`;
    // download.eclipse.org only keeps the latest releases; archive.eclipse.org has all of them
    const url = `https://archive.eclipse.org/technology/epp/downloads/release/${release}/R/${fileName}`;
    return { fileName, url };
}

/**
 * The launcher, the console launcher (Windows: eclipsec.exe) and the folder with `plugins/` of an Eclipse
 * installation given as Eclipse.app, installation folder, a folder containing Eclipse.app / eclipse/ or the
 * executable. Undefined if it is none.
 */
export function eclipseLayout(given, { platform = process.platform, exists = fs.existsSync } = {}) {
    const candidates = [];
    const add = (base) => {
        if (platform === 'darwin') {
            const app = base.endsWith('.app') ? base : path.join(base, 'Eclipse.app');
            candidates.push({
                launcher: path.join(app, 'Contents', 'MacOS', 'eclipse'),
                home: path.join(app, 'Contents', 'Eclipse')
            });
        }
        const exe = platform === 'win32' ? 'eclipse.exe' : 'eclipse';
        candidates.push({ launcher: path.join(base, exe), home: base });
        candidates.push({ launcher: path.join(base, 'eclipse', exe), home: path.join(base, 'eclipse') });
    };
    // an executable: …/Eclipse.app/Contents/MacOS/eclipse or …/eclipse/eclipse(.exe)
    if (/(^|[\\/])eclipse(c)?(\.exe)?$/i.test(given) && !given.endsWith(path.sep)) {
        const dir = path.dirname(given);
        if (platform === 'darwin' && path.basename(dir) === 'MacOS') {
            add(path.dirname(path.dirname(dir)));
        } else {
            add(dir);
        }
    }
    add(given);
    const found = candidates.find((c) => exists(c.launcher) && exists(path.join(c.home, 'plugins')));
    if (!found) {
        return undefined;
    }
    const console = platform === 'win32' ? path.join(path.dirname(found.launcher), 'eclipsec.exe') : found.launcher;
    return { ...found, console: exists(console) ? console : found.launcher };
}

/** The version of an installed root IU in the output of `-listInstalledRoots` (pure). */
export function installedVersion(listOutput, iu = FEATURE_IU) {
    for (const line of listOutput.split(/\r?\n/)) {
        const [id, version] = line.trim().split('/');
        if (id === iu && version) {
            return version;
        }
    }
    return undefined;
}

/** The `.project` of the examples project. */
export function projectDescription(name, { devmNature = false } = {}) {
    const builder = devmNature
        ? `
		<buildCommand>
			<name>devm.eclipse.builder</name>
			<arguments>
			</arguments>
		</buildCommand>
	`
        : '\n\t';
    const nature = devmNature ? '\n\t\t<nature>devm.eclipse.nature</nature>\n\t' : '\n\t';
    return `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
	<name>${name}</name>
	<comment>Device Modeler examples (created by scripts/ide/eclipse.mjs)</comment>
	<projects>
	</projects>
	<buildSpec>${builder}</buildSpec>
	<natures>${nature}</natures>
</projectDescription>
`;
}

// ---------------------------------------------------------------------------------------------------------

const sandbox = sandboxDir('eclipse');
const pluginDir = path.join(repoRoot, 'eclipse-plugin');
const siteRepository = path.join(pluginDir, 'devm.eclipse.site', 'target', 'repository');

function defaultRelease() {
    const pom = fs.readFileSync(path.join(pluginDir, 'pom.xml'), 'utf-8');
    return releaseOfPom(pom) ?? '2025-06';
}

/** Downloads and unpacks the EPP package into .ide/eclipse/install/ (once). */
async function sandboxEclipse({ release, pkg, dryRun }) {
    const { fileName, url } = eclipseDownload({ release, pkg });
    const installDir = path.join(sandbox, 'install', fileName.replace(/\.(zip|tar\.gz)$/, ''));
    const layout = eclipseLayout(installDir);
    if (layout) {
        step(`Eclipse: ${show(installDir)}`);
        return layout;
    }
    const archive = path.join(sandbox, 'downloads', fileName);
    if (!isFile(archive)) {
        step(`Downloading ${url}`);
        if (dryRun) {
            return eclipseLayout(installDir, { exists: () => true });
        }
        const expected = parseChecksumFile(await fetchText(`${url}.sha512`));
        const actual = await download(url, archive);
        if (actual !== expected) {
            fs.rmSync(archive, { force: true });
            throw new ScriptError(`SHA-512 of ${fileName} does not match the published checksum`);
        }
        info('SHA-512 verified');
    } else {
        step(`Verifying ${show(archive)}`);
        const expected = parseChecksumFile(await fetchText(`${url}.sha512`).catch(() => '0'.repeat(128)));
        if (expected !== '0'.repeat(128) && (await sha512(archive)) !== expected) {
            fs.rmSync(archive, { force: true });
            throw new ScriptError(`SHA-512 of ${show(archive)} does not match (removed it, run again)`);
        }
    }
    step(`Unpacking into ${show(installDir)}`);
    if (!dryRun) {
        fs.rmSync(installDir, { recursive: true, force: true });
        fs.mkdirSync(installDir, { recursive: true });
        // bsdtar (macOS, Windows 10+) also unpacks zip archives
        run('tar', ['-xf', archive, '-C', installDir]);
        if (process.platform === 'darwin') {
            // a downloaded app may be quarantined by Gatekeeper
            run('xattr', ['-dr', 'com.apple.quarantine', installDir], { allowFailure: true, quiet: true });
        }
    }
    const unpacked = eclipseLayout(installDir);
    if (!unpacked) {
        throw new ScriptError(`no Eclipse found in ${installDir} after unpacking`);
    }
    return unpacked;
}

function configuredEclipse(options) {
    const given = options.eclipse ?? process.env.DEVM_ECLIPSE;
    if (!given) {
        return undefined;
    }
    const layout = eclipseLayout(path.resolve(given));
    if (!layout) {
        throw new ScriptError(`no Eclipse installation found at ${given} (expected Eclipse.app, the folder with the eclipse executable and plugins/, or the executable)`);
    }
    step(`Eclipse: ${layout.launcher} (the plugin is installed into this installation)`);
    return layout;
}

/** Fails if an Eclipse of this installation is running (p2 must not change a running installation). */
function assertNotRunning(layout) {
    if (process.platform === 'win32') {
        return;
    }
    const result = run('ps', ['-ax', '-o', 'pid=,command='], { quiet: true, allowFailure: true });
    const running = (result.stdout ?? '')
        .split('\n')
        .filter((line) => line.includes(layout.launcher) && !line.includes('org.eclipse.equinox.p2.director'));
    if (running.length > 0) {
        const pid = running[0].trim().split(/\s+/)[0];
        throw new ScriptError(`this Eclipse is running (PID ${pid}): close it first (the plugin is updated in its installation)`);
    }
}

function buildPlugin(options) {
    ensureDependencies(options);
    // the executable for the fragment of this platform (validation of closed models with the bundled devm);
    // without it the fragment is empty and the plugin uses devm of the PATH, so it is built if missing
    ensureCliExecutable(options, { rebuild: options['rebuild-cli'] });
    step('Building the web app (packages/web/dist)');
    run(npm(), ['run', 'build', '-w', 'packages/language'], options);
    run(npm(), ['run', 'build', '-w', 'packages/web'], options);
    step('Building the update site (eclipse-plugin, mvn verify)');
    const mvn = which('mvn');
    if (!mvn && !options.dryRun) {
        throw new ScriptError('Maven (mvn) is not in the PATH; it is needed to build the plugin (or use --no-build)');
    }
    run(mvn ?? 'mvn', ['-B', '-ntp', 'verify'], { cwd: pluginDir, dryRun: options.dryRun });
}

/** The Eclipse.app of a macOS launcher (…/Eclipse.app/Contents/MacOS/eclipse), else undefined (pure). */
export function macApp(launcher, platform = process.platform) {
    const match = /^(.*\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(launcher);
    return platform === 'darwin' && match ? match[1] : undefined;
}

/** The feature version of the built update site. */
function siteFeatureVersion() {
    const features = path.join(siteRepository, 'features');
    const jar = isDirectory(features) && fs.readdirSync(features).find((name) => name.startsWith('devm.eclipse.feature_'));
    return jar ? jar.slice('devm.eclipse.feature_'.length, -'.jar'.length) : undefined;
}

function director(layout, args, options) {
    return run(layout.console, ['-nosplash', '-consoleLog', '-application', 'org.eclipse.equinox.p2.director', ...args], options);
}

function installFeature(layout, release, options) {
    const siteVersion = siteFeatureVersion();
    if (!siteVersion && !options.dryRun) {
        throw new ScriptError(`the update site is not built (${show(siteRepository)}): run without --no-build`);
    }
    step(`Installing the Device Modeler feature ${siteVersion ?? ''} (p2 director)`);
    const roots = director(layout, ['-listInstalledRoots'], { ...options, quiet: true });
    const installed = installedVersion(roots.stdout ?? '');
    if (installed === siteVersion && !options.dryRun) {
        info(`already installed: ${installed}`);
        return;
    }
    const args = ['-repository', directorRepositories(pathToFileURL(siteRepository).href, release), '-installIU', FEATURE_IU];
    if (installed) {
        info(`replacing ${installed}`);
        args.push('-uninstallIU', FEATURE_IU);
    }
    director(layout, args, options);
}

/** Workspace preferences of a new workspace: no welcome page. */
function seedWorkspace(workspace, options) {
    const settings = path.join(workspace, '.metadata', '.plugins', 'org.eclipse.core.runtime', '.settings');
    const uiPrefs = path.join(settings, 'org.eclipse.ui.prefs');
    if (options.dryRun || isFile(uiPrefs)) {
        return;
    }
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(uiPrefs, 'eclipse.preferences.version=1\nshowIntro=false\n');
}

/** Writes the `.project` of the examples folder (if it has none) and returns the project name. */
function ensureProjectFile(dir, options) {
    const file = path.join(dir, '.project');
    if (isFile(file)) {
        const name = /<name>([^<]+)<\/name>/.exec(fs.readFileSync(file, 'utf-8'))?.[1];
        if (name) {
            return name;
        }
    }
    const name = dir === path.join(sandbox, 'workspace', PROJECT_NAME) ? PROJECT_NAME : path.basename(dir);
    info(`writing ${show(file)} (project '${name}')`);
    if (!options.dryRun) {
        fs.writeFileSync(file, projectDescription(name, { devmNature: true }));
    }
    return name;
}

/**
 * Imports the project into the workspace without UI: CDT's headless build application (`-import`) creates
 * and opens the project in the workspace metadata. Without CDT the folder is passed to Eclipse at the start,
 * which opens the Smart Import wizard (one click on Finish).
 * @returns {boolean} whether the project is in the workspace now
 */
function importProject(layout, workspace, projectDir, projectName, options) {
    const projects = path.join(workspace, '.metadata', '.plugins', 'org.eclipse.core.resources', '.projects');
    if (isDirectory(path.join(projects, projectName))) {
        step(`Project '${projectName}' is already in the workspace`);
        return true;
    }
    const cdt = isDirectory(path.join(layout.home, 'plugins')) &&
        fs.readdirSync(path.join(layout.home, 'plugins')).some((name) => name.startsWith('org.eclipse.cdt.managedbuilder.core_'));
    if (!cdt) {
        step(`No CDT in this Eclipse: the Smart Import wizard will open for ${show(projectDir)} (click Finish)`);
        return false;
    }
    step(`Importing the project '${projectName}' into the workspace (CDT headless import)`);
    run(layout.console, [
        '-nosplash', '-consoleLog', '-application', 'org.eclipse.cdt.managedbuilder.core.headlessbuild',
        '-data', workspace, '-import', projectDir
    ], options);
    return true;
}

if (isMain(import.meta.url)) await runScript({
    usage,
    options: {
        eclipse: { type: 'string' },
        package: { type: 'string' },
        release: { type: 'string' },
        'rebuild-cli': { type: 'boolean' }
    },
    async main(options) {
        const pkg = options.package ?? 'cpp';
        if (!PACKAGES.includes(pkg)) {
            throw new ScriptError(`--package must be one of ${PACKAGES.join(', ')}`);
        }
        if (options.clean) {
            cleanSandbox('eclipse', { keep: ['downloads'], dryRun: options.dryRun });
        }
        if (options.build) {
            buildPlugin(options);
        }
        const release = options.release ?? defaultRelease();
        const layout = configuredEclipse(options) ?? (await sandboxEclipse({ release, pkg, dryRun: options.dryRun }));
        if (!options.dryRun) {
            assertNotRunning(layout);
        }
        installFeature(layout, release, options);

        const workspace = path.join(sandbox, 'workspace');
        const projectDir = prepareExamples(options, 'eclipse');
        if (!options.dryRun) {
            fs.mkdirSync(workspace, { recursive: true });
        }
        seedWorkspace(workspace, options);
        const projectName = ensureProjectFile(projectDir, options);
        const imported = importProject(layout, workspace, projectDir, projectName, options);

        step('Starting Eclipse');
        const args = ['-data', workspace];
        const model = path.join(projectDir, 'traffic-light.devm');
        const openModel = imported && (options.dryRun || isFile(model));
        const logFile = path.join(sandbox, 'eclipse.out');
        let pid;
        const app = macApp(layout.launcher);
        if (openModel && app) {
            // macOS: files are opened through an Apple event (the launcher ignores --launcher.openFile at the
            // first start); `open -n` starts a new instance of this Eclipse.app with the model and the arguments
            if (!options.dryRun) {
                fs.mkdirSync(path.dirname(logFile), { recursive: true });
                fs.writeFileSync(logFile, '');
            }
            run('open', ['-n', '-a', app, '--stdout', logFile, '--stderr', logFile, model, '--args', ...args], options);
        } else {
            if (!imported) {
                args.push(projectDir);
            } else if (openModel) {
                // opened in the Device Modeler editor once the workbench is up
                args.push('--launcher.openFile', model);
            }
            pid = launchDetached(layout.launcher, args, { logFile, dryRun: options.dryRun });
        }
        info(`workspace: ${show(workspace)}${pid ? `, PID ${pid}` : ''}`);
        info(`log: ${show(path.join(workspace, '.metadata', '.log'))}`);
        info('double-click a .devm file in the Project Explorer to open the Device Modeler editor');
    }
});
