// Bundles the desktop app: the web app (Vite build of packages/web, copied to dist/web) and the Electron main
// process (esbuild, dist/main.cjs). `npx electron packages/desktop` (or `npm start -w packages/desktop`)
// runs it; scripts/package.mjs makes the installable packages.
// Usage: node scripts/build.mjs [--skip-web]   (--skip-web: reuse packages/web/dist)
// The version is DEVM_VERSION (set by the release workflow) or the version of package.json.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, '../web');
const dist = path.join(root, 'dist');

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
const version = process.env.DEVM_VERSION || packageJson.version;

if (!process.argv.includes('--skip-web')) {
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

await esbuild.build({
    entryPoints: { main: path.join(root, 'src/main.ts') },
    outdir: dist,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    minify: true,
    legalComments: 'none',
    define: { __DEVM_VERSION__: JSON.stringify(version) },
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning'
});
console.log(`built dist/main.cjs and dist/web/ (version ${version})`);
