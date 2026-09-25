import { defineConfig } from 'vite';
import * as path from 'node:path';

export default defineConfig({
    base: './',
    resolve: {
        alias: {
            // use the TypeScript sources of the language package directly (no pre-build needed)
            'hsm-language': path.resolve(__dirname, '../language/src/index.ts')
        }
    },
    esbuild: {
        jsx: 'transform',
        jsxFactory: 'svg',
        // sprotty and inversify use legacy decorators (property injection only, no decorator metadata)
        tsconfigRaw: {
            compilerOptions: {
                experimentalDecorators: true
            }
        }
    },
    build: {
        outDir: 'dist',
        chunkSizeWarningLimit: 6000,
        target: 'es2022'
    },
    optimizeDeps: {
        esbuildOptions: { target: 'es2022' }
    },
    server: {
        port: 5173
    }
});
