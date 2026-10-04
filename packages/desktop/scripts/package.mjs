// Packages the desktop app (run scripts/build.mjs first) with electron-builder for the current platform:
//   macOS:   Device Modeler-<version>-macos-<arch>.dmg and .zip (ad-hoc signed, not notarized)
//   Windows: an NSIS installer (per user, no admin rights) and a .zip (portable)
//   Linux:   AppImage, .deb and .tar.gz
// Output: release/ (and release/<platform>-unpacked/ etc., used by scripts/smoke-test.mjs).
// Usage: node scripts/package.mjs [--arch x64|arm64] [--dir]   (--dir: only the unpacked app, no installers)
// Nothing is signed with a certificate (see docs/installation.md); the version is DEVM_VERSION or package.json.
import { Arch, build, Platform } from 'electron-builder';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { arch: { type: 'string' }, dir: { type: 'boolean' } } });
const arch = values.arch ?? process.arch;
if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`unsupported architecture '${arch}'`);
}
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
const version = process.env.DEVM_VERSION || packageJson.version;
const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[process.platform];
const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
await fs.access(path.join(root, 'dist', 'main.cjs')).catch(() => {
    throw new Error('dist/main.cjs is missing: run scripts/build.mjs first');
});

/** @type {import('electron-builder').Configuration} */
const config = {
    appId: 'io.github.armaxri.device-modeler',
    productName: 'Device Modeler',
    executableName: process.platform === 'linux' ? 'device-modeler' : 'Device Modeler',
    copyright: 'MIT License',
    // the installed Electron (the workspace's node_modules)
    electronVersion: createRequire(import.meta.url)('electron/package.json').version,
    directories: { output: 'release', buildResources: 'build' },
    // everything is bundled: no node_modules in the app
    files: ['dist/**/*', 'package.json'],
    extraMetadata: { version, dependencies: {} },
    extraResources: [{ from: '../../LICENSE', to: 'LICENSE' }],
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    asar: true,
    // the user interface is English: other Chromium locales are not needed
    electronLanguages: ['en', 'en-US', 'en-GB'],
    publish: null,
    artifactName: `device-modeler-${version}-${os}-\${arch}.\${ext}`,
    fileAssociations: [{ ext: 'devm', name: 'Device Modeler model', description: 'Device structure or hierarchical state machine', role: 'Editor' }],
    mac: {
        category: 'public.app-category.developer-tools',
        target: values.dir ? ['dir'] : ['dmg', 'zip'],
        // ad-hoc signature (required on Apple silicon), no Developer ID certificate, not notarized
        identity: '-',
        hardenedRuntime: false,
        gatekeeperAssess: false,
        notarize: false
    },
    dmg: { writeUpdateInfo: false },
    win: {
        target: values.dir ? ['dir'] : ['nsis', 'zip'],
        signAndEditExecutable: true
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        differentialPackage: false,
        artifactName: `device-modeler-${version}-${os}-\${arch}-setup.\${ext}`
    },
    linux: {
        target: values.dir ? ['dir'] : ['AppImage', 'deb', 'tar.gz'],
        category: 'Development',
        maintainer: 'Device Modeler contributors <noreply@github.com>',
        synopsis: 'Editor for device structures and hierarchical state machines',
        mimeTypes: ['application/x-devm-model']
    },
    deb: { packageName: 'device-modeler' }
};

const result = await build({
    projectDir: root,
    targets: platform.createTarget(config[platform.buildConfigurationKey].target, Arch[arch]),
    config
});
for (const file of result) {
    console.log(`packaged ${path.relative(root, file)}`);
}
