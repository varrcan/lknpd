import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'coverage/', 'node_modules/', 'openspec/'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ['*.js', '*.cjs'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        },
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            // Ядро обязано работать в bun и серверном рантайме Next.js.
            'no-restricted-imports': ['error', { patterns: ['node:*'] }],
        },
    },
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['**/*.cjs'],
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    prettier
);
