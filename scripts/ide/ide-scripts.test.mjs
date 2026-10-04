// Tests of the pure helpers of the IDE launch scripts: node --test scripts/ide/ide-scripts.test.mjs
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
    clionCandidates, envVarBaseNameOf, expandCandidate, gradleArgs, ideaProperties, jetbrainsIde, lsp4ijDownload, lsp4ijVersionOf
} from './clion.mjs';
import {
    directorRepositories, eclipseDownload, eclipseLayout, installedVersion, macApp, projectDescription, releaseOfPom
} from './eclipse.mjs';
import {
    UsageError, cliTarget, commandFileNames, examplesTarget, parseChecksumFile, parseOptions, pathDirs, repoRoot, which
} from './lib.mjs';
import { vscodeArguments, vscodeCandidates, vscodeCliOf } from './vscode.mjs';

const posix = path.posix;
/** An `exists` stub for a set of files (and their parent folders). */
function fileSystem(files) {
    const all = new Set();
    for (const file of files) {
        let current = file;
        while (!all.has(current)) {
            all.add(current);
            current = path.dirname(current);
        }
    }
    return (file) => all.has(file);
}

describe('options', () => {
    it('parses the common options', () => {
        const options = parseOptions(['--no-build', '--examples', 'x', '--clean']);
        assert.equal(options.build, false);
        assert.equal(options.examples, 'x');
        assert.equal(options.clean, true);
        assert.equal(options.inPlace, false);
        assert.equal(options.dryRun, false);
    });

    it('builds by default and accepts script options', () => {
        const options = parseOptions(['--vsix'], { vsix: { type: 'boolean' } });
        assert.equal(options.build, true);
        assert.equal(options.vsix, true);
    });

    it('rejects unknown options, missing values and --examples with --in-place', () => {
        assert.throws(() => parseOptions(['--vsix']), UsageError);
        assert.throws(() => parseOptions(['--examples']), UsageError);
        assert.throws(() => parseOptions(['positional']), UsageError);
        assert.throws(() => parseOptions(['--examples', 'x', '--in-place']), /exclude each other/);
    });

    it('chooses the examples folder', () => {
        assert.deepEqual(examplesTarget({}, 'vscode'), {
            dir: path.join(repoRoot, '.ide', 'vscode', 'workspace', 'devm-examples'),
            copy: true
        });
        assert.deepEqual(examplesTarget({ inPlace: true }, 'vscode'), { dir: path.join(repoRoot, 'examples'), copy: false });
        assert.deepEqual(examplesTarget({ examples: 'models' }, 'eclipse', { cwd: '/work' }), {
            dir: path.resolve('/work', 'models'),
            copy: false
        });
    });
});

describe('executables', () => {
    it('splits the PATH per platform', () => {
        assert.deepEqual(pathDirs({ PATH: '/a:/b::/c' }, 'linux'), ['/a', '/b', '/c']);
        assert.deepEqual(pathDirs({ Path: 'C:\\a;C:\\b' }, 'win32'), ['C:\\a', 'C:\\b']);
    });

    it('knows the Windows extensions of commands', () => {
        assert.deepEqual(commandFileNames('code', 'linux'), ['code']);
        assert.deepEqual(commandFileNames('code', 'win32', { PATHEXT: '.EXE;.CMD' }), ['code', 'code.exe', 'code.cmd']);
    });

    it('finds a command in the PATH', () => {
        const exists = fileSystem(['/usr/bin/code']);
        assert.equal(which('code', { env: { PATH: '/bin:/usr/bin' }, platform: 'linux', exists }), '/usr/bin/code');
        assert.equal(which('codium', { env: { PATH: '/bin:/usr/bin' }, platform: 'linux', exists }), undefined);
    });
});

describe('VS Code', () => {
    it('knows the standard installations', () => {
        const mac = vscodeCandidates({ platform: 'darwin', env: { HOME: '/Users/me' } });
        assert.ok(mac.includes('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'));
        assert.ok(mac.includes('/Users/me/Applications/VSCodium.app/Contents/Resources/app/bin/codium'));
        const windows = vscodeCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } });
        assert.equal(windows[0], 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd');
        assert.ok(windows.includes('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'));
        assert.ok(vscodeCandidates({ platform: 'linux', env: { HOME: '/home/me' } }).includes('/usr/share/code/bin/code'));
    });

    it('finds the command line of an app', () => {
        const cli = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
        const exists = (file) => file === cli;
        assert.equal(vscodeCliOf('/Applications/Visual Studio Code.app', { platform: 'darwin', exists }), cli);
        assert.equal(vscodeCliOf(cli, { platform: 'darwin', exists }), cli);
        assert.equal(vscodeCliOf('/nowhere', { platform: 'darwin', exists }), undefined);
    });

    it('starts an isolated profile', () => {
        const args = vscodeArguments({ userDataDir: '/s/u', extensionsDir: '/s/e', developmentPath: '/r/vscode', folder: '/w', file: '/w/a.devm' });
        assert.deepEqual(args.slice(0, 4), ['--user-data-dir', '/s/u', '--extensions-dir', '/s/e']);
        assert.ok(args.includes('--extensionDevelopmentPath=/r/vscode'));
        assert.deepEqual(args.slice(-2), ['/w', '/w/a.devm']);
        assert.ok(!vscodeArguments({ userDataDir: 'u', extensionsDir: 'e', folder: 'w' }).some((a) => a.startsWith('--extensionDevelopmentPath')));
    });
});

describe('Eclipse', () => {
    it('reads the release of the pom', () => {
        assert.equal(releaseOfPom('<eclipse.repository>https://download.eclipse.org/releases/2025-06/</eclipse.repository>'), '2025-06');
        assert.equal(releaseOfPom('<eclipse.repository>https://mirror/x</eclipse.repository>'), undefined);
        assert.equal(directorRepositories('file:///site', '2025-06'), 'file:///site,https://download.eclipse.org/releases/2025-06/');
    });

    it('names the downloads of all platforms', () => {
        const base = 'https://archive.eclipse.org/technology/epp/downloads/release/2025-06/R/';
        assert.deepEqual(eclipseDownload({ release: '2025-06', platform: 'darwin', arch: 'arm64' }), {
            fileName: 'eclipse-cpp-2025-06-R-macosx-cocoa-aarch64.tar.gz',
            url: `${base}eclipse-cpp-2025-06-R-macosx-cocoa-aarch64.tar.gz`
        });
        assert.equal(eclipseDownload({ release: '2025-06', platform: 'linux', arch: 'x64' }).fileName, 'eclipse-cpp-2025-06-R-linux-gtk-x86_64.tar.gz');
        assert.equal(eclipseDownload({ release: '2025-06', pkg: 'java', platform: 'win32', arch: 'x64' }).fileName, 'eclipse-java-2025-06-R-win32-x86_64.zip');
        assert.throws(() => eclipseDownload({ release: '2025-06', platform: 'aix', arch: 'ppc64' }));
    });

    it('finds launcher and plugins of an installation', () => {
        const app = '/x/Eclipse.app';
        const exists = fileSystem([`${app}/Contents/MacOS/eclipse`, `${app}/Contents/Eclipse/plugins`]);
        const expected = { launcher: `${app}/Contents/MacOS/eclipse`, home: `${app}/Contents/Eclipse`, console: `${app}/Contents/MacOS/eclipse` };
        assert.deepEqual(eclipseLayout(app, { platform: 'darwin', exists }), expected);
        assert.deepEqual(eclipseLayout('/x', { platform: 'darwin', exists }), expected);
        assert.deepEqual(eclipseLayout(`${app}/Contents/MacOS/eclipse`, { platform: 'darwin', exists }), expected);
        assert.equal(eclipseLayout('/y', { platform: 'darwin', exists }), undefined);

        const linux = fileSystem(['/opt/e/eclipse/eclipse', '/opt/e/eclipse/plugins']);
        assert.equal(eclipseLayout('/opt/e', { platform: 'linux', exists: linux })?.home, '/opt/e/eclipse');
        assert.equal(eclipseLayout('/opt/e/eclipse/eclipse', { platform: 'linux', exists: linux })?.launcher, '/opt/e/eclipse/eclipse');
    });

    it('reads the installed feature version', () => {
        const output = 'org.eclipse.epp.package.cpp.feature.feature.group/4.36.0\ndevm.eclipse.feature.feature.group/0.1.0.2026\nOperation completed';
        assert.equal(installedVersion(output), '0.1.0.2026');
        assert.equal(installedVersion('Operation completed'), undefined);
    });

    it('writes a project description', () => {
        const plain = projectDescription('devm-examples');
        assert.match(plain, /<name>devm-examples<\/name>/);
        assert.doesNotMatch(plain, /devm\.eclipse\.nature/);
        const validated = projectDescription('p', { devmNature: true });
        assert.match(validated, /<nature>devm\.eclipse\.nature<\/nature>/);
        assert.match(validated, /<name>devm\.eclipse\.builder<\/name>/);
    });

    it('knows the macOS app and the executable target', () => {
        assert.equal(macApp('/x/Eclipse.app/Contents/MacOS/eclipse', 'darwin'), '/x/Eclipse.app');
        assert.equal(macApp('/x/eclipse/eclipse', 'darwin'), undefined);
        assert.equal(macApp('/x/Eclipse.app/Contents/MacOS/eclipse', 'linux'), undefined);
        assert.equal(cliTarget('darwin', 'arm64'), 'macos-arm64');
        assert.equal(cliTarget('win32', 'x64'), 'windows-x64');
    });

    it('parses checksum files', () => {
        const hash = 'a'.repeat(128);
        assert.equal(parseChecksumFile(`${hash}  eclipse.tar.gz\n`), hash);
        assert.throws(() => parseChecksumFile('<html>'));
    });
});

describe('CLion', () => {
    it('installs the LSP4IJ version of the plugin build', () => {
        assert.equal(lsp4ijVersionOf('platformVersion = 2025.2\nlsp4ijVersion = 0.21.0\n'), '0.21.0');
        assert.equal(lsp4ijVersionOf('platformVersion = 2025.2\n'), undefined);
        assert.deepEqual(lsp4ijDownload('0.21.0'), {
            fileName: 'lsp4ij-0.21.0.zip',
            url: 'https://plugins.jetbrains.com/plugin/download?pluginId=com.redhat.devtools.lsp4ij&version=0.21.0'
        });
    });

    it('knows the standard installations', () => {
        const mac = clionCandidates({ platform: 'darwin', env: { HOME: '/Users/me' } });
        assert.equal(mac[0], '/Applications/CLion.app');
        assert.ok(mac.includes('/Users/me/Library/Application Support/JetBrains/Toolbox/apps/CLion/ch-0/*/CLion.app'));
        const linux = clionCandidates({ platform: 'linux', env: { HOME: '/home/me' } });
        assert.ok(linux.includes('/home/me/.local/share/JetBrains/Toolbox/apps/clion'));
        const windows = clionCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\P' } });
        assert.ok(windows.includes('C:\\P\\JetBrains\\CLion *'));
    });

    it('expands version folders, newest first', () => {
        const tree = {
            '/t/ch-0': ['241.1', '252.10', '252.9', '.lock'],
            '/opt': ['clion-2025.2', 'clion-2025.10', 'other']
        };
        const readdir = (dir) => {
            if (!tree[dir]) throw new Error('ENOENT');
            return tree[dir];
        };
        assert.deepEqual(expandCandidate('/t/ch-0/*/CLion.app', readdir), ['/t/ch-0/252.10/CLion.app', '/t/ch-0/252.9/CLion.app', '/t/ch-0/241.1/CLion.app']);
        assert.deepEqual(expandCandidate('/opt/clion-*', readdir), ['/opt/clion-2025.10', '/opt/clion-2025.2']);
        assert.deepEqual(expandCandidate('/missing/*', readdir), []);
        assert.deepEqual(expandCandidate('/Applications/CLion.app', readdir), ['/Applications/CLion.app']);
        assert.deepEqual(expandCandidate('C:\\P\\JetBrains\\CLion *', (dir) => (dir === 'C:\\P\\JetBrains' ? ['CLion 2025.2'] : [])), ['C:\\P\\JetBrains\\CLion 2025.2']);
    });

    it('reads the product info of an installation', () => {
        const info = {
            name: 'CLion', version: '2026.2.3', productCode: 'CL', envVarBaseName: 'CLION', dataDirectoryName: 'CLion2026.2',
            launch: [
                { os: 'macOS', arch: 'amd64', launcherPath: '../MacOS/clion-x64' },
                { os: 'macOS', arch: 'aarch64', launcherPath: '../MacOS/clion' }
            ]
        };
        const file = '/Applications/CLion.app/Contents/Resources/product-info.json';
        const options = { platform: 'darwin', arch: 'arm64', exists: (f) => f === file, readJson: () => info };
        const expected = {
            installation: '/Applications/CLion.app',
            launcher: '/Applications/CLion.app/Contents/MacOS/clion',
            name: 'CLion', version: '2026.2.3', productCode: 'CL', dataDirectoryName: 'CLion2026.2', envVarBaseName: 'CLION'
        };
        assert.deepEqual(jetbrainsIde('/Applications/CLion.app', options), expected);
        assert.deepEqual(jetbrainsIde('/Applications/CLion.app/Contents/MacOS/clion', options), expected);

        const linuxInfo = { name: 'CLion', version: '2025.2', launch: [{ os: 'Linux', arch: 'amd64', launcherPath: 'bin/clion' }] };
        const linux = jetbrainsIde('/opt/clion', { platform: 'linux', arch: 'x64', exists: (f) => f === '/opt/clion/product-info.json', readJson: () => linuxInfo });
        assert.equal(linux.installation, '/opt/clion');
        assert.equal(linux.launcher, posix.normalize('/opt/clion/bin/clion'));
        assert.equal(linux.envVarBaseName, 'CLION');
        assert.equal(jetbrainsIde('/nowhere', { exists: () => false }), undefined);
    });

    it('derives the environment variable of older IDEs', () => {
        assert.equal(envVarBaseNameOf('C:\\CLion\\bin\\clion64.exe'), 'CLION');
        assert.equal(envVarBaseNameOf('/opt/idea/bin/idea.sh'), 'IDEA');
    });

    it('writes an isolated idea.properties', () => {
        const text = ideaProperties('/s/zip/CLion2026.2');
        assert.match(text, /^idea\.config\.path=\/s\/zip\/CLion2026\.2\/config$/m);
        assert.match(text, /^idea\.plugins\.path=\/s\/zip\/CLion2026\.2\/plugins$/m);
        assert.match(text, /^idea\.system\.path=/m);
        assert.match(text, /^idea\.log\.path=/m);
    });

    it('quotes Gradle --args with spaces', () => {
        assert.equal(gradleArgs('/a/b'), '--args=/a/b');
        assert.equal(gradleArgs('/a b/c'), '--args="/a b/c"');
    });
});
