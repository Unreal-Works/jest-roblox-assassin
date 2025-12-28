import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'demo/',
                'actualjest/',
                '**/*.config.js',
                '**/luau_output.log'
            ]
        },
        include: ['src/**/*.test.js', 'tests/**/*.test.js'],
        mockReset: true,
        restoreMocks: true,
    },
});
