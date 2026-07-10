/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
    env: { node: true, browser: true, es2020: true },
    plugins: ['@typescript-eslint'],
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
    ignorePatterns: [
        'node_modules/',
        '**/dist/',
        'build/',
        'coverage/',
        '**/*.map',
        '**/*.html',
        'server/src/qrcode.js', // vendored QR generator (third-party)
        'clients/tabby/assets/', // generated web-client asset
    ],
    rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-this-alias': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['error', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
        }],
    },
    overrides: [
        // Ambient type shims mirror the host API and legitimately carry unused type params.
        { files: ['**/*.d.ts'], rules: { '@typescript-eslint/no-unused-vars': 'off' } },
    ],
}
