// Creates the self-contained `hsm` command line executable from the bundle of scripts/build.mjs as a Node.js
// single executable application (https://nodejs.org/api/single-executable-applications.html): the bundle is
// injected into an official Node.js binary (downloaded from nodejs.org, checksum verified,
// cached in .cache/). Official binaries are needed: Node.js of package managers (e.g. Homebrew) links
// shared libraries that users do not have.
//
// Usage: node scripts/sea.mjs [--target <target>] [--archive]
//   --target   linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64 or windows-arm64
//              (default: the current platform). macOS executables must be signed on macOS (ad-hoc signature,
//              `codesign`), so build them on a Mac.
//   --archive  also writes dist/release/hsm-<version>-<target>.tar.gz (.zip for Windows) with the
//              executable and the license
// Environment: HSM_NODE_VERSION overrides the Node.js version (must support SEA assets, i.e. >= 20.12).
// Output: dist/bin/<target>/hsm (hsm.exe on Windows)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Node.js version of the executables (an LTS release). */
const NODE_VERSION = process.env.HSM_NODE_VERSION || 'v24.21.0';
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, '.cache', 'node', NODE_VERSION);
// on Windows the bsdtar of the system (it writes zip files), not a GNU tar of Git for Windows in the PATH
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Targets: name of the release file -> platform and architecture of the Node.js distribution. */
const targets = {
    'linux-x64': { os: 'linux', arch: 'x64' },
    'linux-arm64': { os: 'linux', arch: 'arm64' },
    'macos-x64': { os: 'darwin', arch: 'x64' },
    'macos-arm64': { os: 'darwin', arch: 'arm64' },
    'windows-x64': { os: 'win', arch: 'x64' },
    'windows-arm64': { os: 'win', arch: 'arm64' }
};

function hostTarget() {
    const name = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
    const target = `${name}-${process.arch}`;
    if (!(target in targets)) {
        throw new Error(`unsupported platform ${process.platform}-${process.arch}`);
    }
    return target;
}

async function main() {
    const { values } = parseArgs({ options: { target: { type: 'string' }, archive: { type: 'boolean' } } });
    const target = values.target ?? hostTarget();
    if (!(target in targets)) {
        throw new Error(`unknown target '${target}', expected one of ${Object.keys(targets).join(', ')}`);
    }
    const { os: targetOs } = targets[target];
    const seaConfig = path.join(dist, 'sea-config.json');
    try {
        await fs.access(seaConfig);
    } catch {
        throw new Error('dist/sea-config.json is missing: run scripts/build.mjs first');
    }

    // 1. the preparation blob (bundle + assets), created by Node.js of the same version as the executable
    const hostNode = process.version === NODE_VERSION ? process.execPath : await nodeBinary(hostTarget());
    execFileSync(hostNode, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

    // 2. a copy of the Node.js binary of the target with the blob injected
    const exe = path.join(dist, 'bin', target, targetOs === 'win' ? 'hsm.exe' : 'hsm');
    await fs.mkdir(path.dirname(exe), { recursive: true });
    await fs.rm(exe, { force: true });
    await fs.copyFile(await nodeBinary(target), exe);
    await fs.chmod(exe, 0o755);
    const signOnMac = targetOs === 'darwin' && process.platform === 'darwin';
    if (signOnMac) {
        execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
    }
    const postject = createRequire(import.meta.url)('postject');
    await postject.inject(exe, 'NODE_SEA_BLOB', await fs.readFile(path.join(dist, 'sea-prep.blob')), {
        sentinelFuse: SENTINEL_FUSE,
        machoSegmentName: targetOs === 'darwin' ? 'NODE_SEA' : undefined,
        overwrite: true
    });
    if (signOnMac) {
        // ad-hoc signature: required to run on Apple silicon (not a Developer ID signature, see docs/installation.md)
        execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });
    } else if (targetOs === 'darwin') {
        console.warn('warning: the macOS executable is not signed (codesign is only available on macOS); it will not start on Apple silicon');
    }
    const size = (await fs.stat(exe)).size;
    console.log(`built ${path.relative(root, exe)} (${(size / 1024 / 1024).toFixed(1)} MB, Node.js ${NODE_VERSION})`);

    if (values.archive) {
        console.log(`archived ${path.relative(root, await archive(exe, target))}`);
    }
}

/** The official Node.js binary of a target (downloaded once, verified with the published SHA-256 sums). */
async function nodeBinary(target) {
    const { os: nodeOs, arch } = targets[target];
    const binary = path.join(cache, `${nodeOs}-${arch}`, nodeOs === 'win' ? 'node.exe' : 'node');
    try {
        await fs.access(binary);
        return binary;
    } catch {
        // not cached yet
    }
    const base = `https://nodejs.org/dist/${NODE_VERSION}`;
    const file = nodeOs === 'win' ? `win-${arch}/node.exe` : `node-${NODE_VERSION}-${nodeOs}-${arch}.tar.gz`;
    console.log(`downloading ${base}/${file}`);
    const sums = await (await download(`${base}/SHASUMS256.txt`)).toString('utf-8');
    const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
    if (!expected) {
        throw new Error(`${file} is not listed in ${base}/SHASUMS256.txt`);
    }
    const data = await download(`${base}/${file}`);
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected) {
        throw new Error(`checksum mismatch of ${file}: expected ${expected}, got ${actual}`);
    }
    await fs.mkdir(path.dirname(binary), { recursive: true });
    if (nodeOs === 'win') {
        await fs.writeFile(binary, data);
    } else {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hsm-node-'));
        try {
            const archiveFile = path.join(tmp, path.basename(file));
            await fs.writeFile(archiveFile, data);
            const member = `node-${NODE_VERSION}-${nodeOs}-${arch}/bin/node`;
            execFileSync(tar, ['-xzf', archiveFile, '-C', tmp, member], { stdio: 'inherit' });
            await fs.copyFile(path.join(tmp, member), binary);
            await fs.chmod(binary, 0o755);
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    }
    return binary;
}

async function download(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/** dist/release/hsm-<version>-<target>.tar.gz (.zip for Windows): the executable and the license. */
async function archive(exe, target) {
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
    const name = `hsm-${process.env.HSM_VERSION || version}-${target}`;
    const staging = path.join(dist, 'release', name);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    await fs.copyFile(exe, path.join(staging, path.basename(exe)));
    await fs.chmod(path.join(staging, path.basename(exe)), 0o755);
    await fs.copyFile(path.join(root, '../../LICENSE'), path.join(staging, 'LICENSE'));
    const isZip = targets[target].os === 'win';
    const file = path.join(dist, 'release', `${name}${isZip ? '.zip' : '.tar.gz'}`);
    await fs.rm(file, { force: true });
    const entries = await fs.readdir(staging);
    if (isZip && process.platform === 'linux') {
        execFileSync('zip', ['-q', '-X', file, ...entries], { cwd: staging, stdio: 'inherit' });
    } else {
        // bsdtar (macOS, Windows) writes zip archives with -a
        execFileSync(tar, [isZip ? '-acf' : '-czf', file, ...entries], { cwd: staging, stdio: 'inherit' });
    }
    await fs.rm(staging, { recursive: true, force: true });
    return file;
}

await main();
