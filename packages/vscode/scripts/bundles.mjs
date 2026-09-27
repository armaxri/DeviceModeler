// esbuild options of the Node bundles (extension host and language server); shared by the build
// script and the integration test of the language server.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {'extension' | 'server'} name
 * @param {{ outdir?: string, minify?: boolean }} [options]
 * @returns {import('esbuild').BuildOptions}
 */
export function bundleOptions(name, options = {}) {
    const entry = name === 'extension' ? 'src/extension/extension.ts' : 'src/server/main.ts';
    return {
        entryPoints: { [name]: path.join(root, entry) },
        outdir: options.outdir ?? path.join(root, 'dist'),
        outExtension: { '.js': '.cjs' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        sourcemap: true,
        minify: options.minify ?? false,
        // the language package is bundled from its TypeScript sources (no pre-build needed)
        alias: { 'hsm-language': path.join(root, '../language/src/index.ts') },
        external: ['vscode'],
        logLevel: 'info',
        tsconfig: path.join(root, 'tsconfig.json')
    };
}
