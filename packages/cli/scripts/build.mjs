// Bundles the self-contained `hsm` command line executable's JavaScript: a single CommonJS file with the
// entry point, the command line tool and all dependencies (esbuild).
// Output in dist/: hsm.cjs and sea-config.json (input of sea.mjs).
// `node dist/hsm.cjs ...` runs the bundle with an installed Node.js (for development).
// The version is HSM_VERSION (set by the release workflow) or the version of package.json.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
const version = process.env.HSM_VERSION || packageJson.version;

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
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

// the input of `node --experimental-sea-config` (see scripts/sea.mjs)
await fs.writeFile(path.join(dist, 'sea-config.json'), JSON.stringify({
    main: path.join(dist, 'hsm.cjs'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    // keep the blob independent of the platform (it can be injected into Node.js binaries of other platforms)
    useSnapshot: false,
    useCodeCache: false
}, undefined, 2));

const size = (await fs.stat(path.join(dist, 'hsm.cjs'))).size;
console.log(`built dist/hsm.cjs (${(size / 1024 / 1024).toFixed(1)} MB, version ${version})`);
