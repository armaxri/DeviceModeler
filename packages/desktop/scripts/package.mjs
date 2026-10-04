// Packages the desktop app (run scripts/build.mjs first) with electron-builder for the current platform:
//   macOS:   HSM Modeler-<version>-macos-<arch>.dmg and .zip (ad-hoc signed, not notarized)
//   Windows: an NSIS installer (per user, no admin rights) and a .zip (portable)
//   Linux:   AppImage, .deb and .tar.gz
// Output: release/ (and release/<platform>-unpacked/ etc., used by scripts/smoke-test.mjs).
// Usage: node scripts/package.mjs [--arch x64|arm64] [--dir]   (--dir: only the unpacked app, no installers)
// Nothing is signed with a certificate (see docs/installation.md); the version is HSM_VERSION or package.json.
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
const version = process.env.HSM_VERSION || packageJson.version;
const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[process.platform];
const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
await fs.access(path.join(root, 'dist', 'main.cjs')).catch(() => {
    throw new Error('dist/main.cjs is missing: run scripts/build.mjs first');
});

/** @type {import('electron-builder').Configuration} */
const config = {
    appId: 'io.github.armaxri.hsm-modeler',
    productName: 'HSM Modeler',
    executableName: process.platform === 'linux' ? 'hsm-modeler' : 'HSM Modeler',
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
    artifactName: `hsm-modeler-${version}-${os}-\${arch}.\${ext}`,
    fileAssociations: [{ ext: 'hsm', name: 'HSM state machine model', description: 'Hierarchical state machine model', role: 'Editor' }],
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
        artifactName: `hsm-modeler-${version}-${os}-\${arch}-setup.\${ext}`
    },
    linux: {
        target: values.dir ? ['dir'] : ['AppImage', 'deb', 'tar.gz'],
        category: 'Development',
        maintainer: 'HSM Modeler contributors <noreply@github.com>',
        synopsis: 'Editor for hierarchical state machines',
        mimeTypes: ['application/x-hsm-model']
    },
    deb: { packageName: 'hsm-modeler' }
};

const result = await build({
    projectDir: root,
    targets: platform.createTarget(config[platform.buildConfigurationKey].target, Arch[arch]),
    config
});
for (const file of result) {
    console.log(`packaged ${path.relative(root, file)}`);
}
