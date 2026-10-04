// esbuild options of the `devm` executable's JavaScript bundle; shared by the build script and the
// integration test of `devm lsp` (packages/vscode/test/integration/cli-lsp.test.ts).
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One CommonJS file: the main script of a single executable application must be CommonJS and can only
 * require built-in modules.
 * @param {{ outdir?: string, version?: string }} [options]
 * @returns {import('esbuild').BuildOptions}
 */
export function bundleOptions(options = {}) {
    return {
        entryPoints: { devm: path.join(root, 'src/main.ts') },
        outdir: options.outdir ?? path.join(root, 'dist'),
        outExtension: { '.js': '.cjs' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        minify: true,
        legalComments: 'none',
        define: { __DEVM_VERSION__: JSON.stringify(options.version ?? '0.0.0-dev') },
        tsconfig: path.join(root, 'tsconfig.json'),
        logLevel: 'warning'
    };
}
