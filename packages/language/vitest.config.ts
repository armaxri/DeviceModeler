import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // layout (ELK) and compiler based tests are slow on loaded CI machines
        testTimeout: 30000
    }
});
