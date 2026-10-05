import { defineConfig } from 'vite-plus'
export default defineConfig({
    fmt: {
        ignorePatterns: [
            '**/.nuxt/**',
            '**/.nitro/**',
            '**/.output/**',
            '**/.contract-*/**',
            '**/coverage/**',
            '**/dist/**',
            '**/node_modules/**',
        ],
        printWidth: 120,
        semi: false,
        singleQuote: true,
        sortImports: true,
        sortPackageJson: true,
        sortTailwindcss: {},
        tabWidth: 4,
        trailingComma: 'all',
    },
    lint: {
        categories: {
            correctness: 'error',
            perf: 'warn',
            suspicious: 'error',
        },
        env: { browser: true, node: true },
        ignorePatterns: [
            '**/.nuxt/**',
            '**/.nitro/**',
            '**/.output/**',
            '**/coverage/**',
            '**/dist/**',
            'test/fixtures/**',
        ],
        options: { typeAware: true, typeCheck: true },
        plugins: ['import', 'typescript', 'unicorn', 'vitest'],
        rules: {
            'import/no-cycle': 'error',
            'no-console': 'warn',
            'typescript/no-floating-promises': 'error',
        },
        overrides: [
            {
                files: ['test/**/*.ts'],
                rules: {
                    'typescript/no-explicit-any': 'off',
                    // Negative inputs and minimal framework doubles deliberately narrow types.
                    'typescript/no-unsafe-type-assertion': 'off',
                    'vitest/valid-expect': ['error', { maxArgs: 2 }],
                    // Fixture prepare/typecheck/build and dependent lifecycle operations are ordered.
                    'no-await-in-loop': 'off',
                },
            },
        ],
    },
    tsconfig: 'test/tsconfig.json',
    test: {
        fileParallelism: false,
        maxWorkers: 1,
        projects: ['unit', 'integration', 'client', 'consumer'].map((name) => ({
            test: {
                name,
                include: [`test/${name}/**/*.test.ts`],
                environment: 'node',
                fileParallelism: false,
                hookTimeout: 300_000,
                testTimeout: 300_000,
            },
        })),
    },
})
