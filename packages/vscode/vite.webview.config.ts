import { defineConfig } from 'vite';
import * as path from 'node:path';

/**
 * The diagram webview: the diagram controller, views and styles of the web app (packages/web)
 * bundled into one script (IIFE) and one style sheet, loaded by the webview panel of the extension.
 */
export default defineConfig({
    resolve: {
        alias: {
            // use the TypeScript sources of the language package and the web app directly
            'devm-language': path.resolve(__dirname, '../language/src/index.ts'),
            '@devm-web': path.resolve(__dirname, '../web/src')
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
    define: {
        'process.env.NODE_ENV': JSON.stringify('production')
    },
    build: {
        outDir: 'dist/webview',
        emptyOutDir: true,
        target: 'es2022',
        chunkSizeWarningLimit: 8000,
        sourcemap: false,
        lib: {
            entry: path.resolve(__dirname, 'src/webview/main.ts'),
            formats: ['iife'],
            name: 'hsmDiagramWebview',
            fileName: () => 'webview.js',
            cssFileName: 'webview'
        }
    }
});
