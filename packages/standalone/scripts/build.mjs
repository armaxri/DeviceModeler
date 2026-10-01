// Bundles the self-contained `hsm` executable's JavaScript: the web app (Vite build of packages/web) and
// a single CommonJS file with the entry point, the command line tool and all dependencies (esbuild).
// Output in dist/: hsm.cjs, web/ (the web app), web-manifest.json and sea-config.json (input of sea.mjs).
// `node dist/hsm.cjs ...` runs the bundle with an installed Node.js (for development).
// Usage: node scripts/build.mjs [--skip-web]   (--skip-web: reuse packages/web/dist)
// The version is HSM_VERSION (set by the release workflow) or the version of package.json.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, '../web');
const dist = path.join(root, 'dist');
const skipWeb = process.argv.includes('--skip-web');

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
const version = process.env.HSM_VERSION || packageJson.version;

// the web app (static files, no server logic needed)
if (!skipWeb) {
    const { build } = await import('vite');
    await build({ root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), logLevel: 'warn' });
}
const webDist = path.join(webRoot, 'dist');
try {
    await fs.access(path.join(webDist, 'index.html'));
} catch {
    throw new Error(`${webDist}/index.html is missing: build the web app first (or omit --skip-web)`);
}

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
await fs.cp(webDist, path.join(dist, 'web'), { recursive: true });

// one CommonJS file: the main script of a single executable application must be CommonJS and can only
// require built-in modules
await esbuild.build({
    entryPoints: { hsm: path.join(root, 'src/main.ts') },
    outdir: dist,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    define: { __HSM_VERSION__: JSON.stringify(version) },
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning'
});

// the input of `node --experimental-sea-config` (see scripts/sea.mjs): the bundle and the web app as assets
const webFiles = await listFiles(path.join(dist, 'web'));
await fs.writeFile(path.join(dist, 'web-manifest.json'), JSON.stringify(webFiles));
const assets = { 'web-manifest.json': path.join(dist, 'web-manifest.json') };
for (const file of webFiles) {
    assets[`web/${file}`] = path.join(dist, 'web', ...file.split('/'));
}
await fs.writeFile(path.join(dist, 'sea-config.json'), JSON.stringify({
    main: path.join(dist, 'hsm.cjs'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    // keep the blob independent of the platform (it can be injected into Node.js binaries of other platforms)
    useSnapshot: false,
    useCodeCache: false,
    assets
}, undefined, 2));

const size = (await fs.stat(path.join(dist, 'hsm.cjs'))).size;
console.log(`built dist/hsm.cjs (${(size / 1024 / 1024).toFixed(1)} MB, version ${version}) and dist/web/ (${webFiles.length} files)`);

/** @returns {Promise<string[]>} the files below a directory, relative with `/` */
async function listFiles(dir, prefix = '') {
    const result = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            result.push(...await listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`));
        } else if (entry.isFile()) {
            result.push(`${prefix}${entry.name}`);
        }
    }
    return result.sort();
}
