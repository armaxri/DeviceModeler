import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            // the TypeScript sources of the language package (as in the bundles)
            'hsm-language': path.resolve(__dirname, '../language/src/index.ts'),
            // modules of the web app shared with the webview (DOM-free ones only)
            '@hsm-web': path.resolve(__dirname, '../web/src'),
            // a minimal stand-in for the VS Code API (unit tests of extension host code)
            'vscode': path.resolve(__dirname, 'test/mocks/vscode.ts')
        }
    },
    test: {
        include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
        testTimeout: 60000
    }
});
