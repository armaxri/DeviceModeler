import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            // the TypeScript sources of the language package (as in the bundles)
            'hsm-language': path.resolve(__dirname, '../language/src/index.ts')
        }
    },
    test: {
        include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
        testTimeout: 60000
    }
});
