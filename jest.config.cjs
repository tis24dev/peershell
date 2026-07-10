/**
 * Copyright (C) 2026 tis24dev
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/** Jest config for the monorepo (ts-jest, node env). Runs *.test.ts under shared/ and clients/. */
module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/jest.setup.cjs'],
    // integration tests use real sockets; close them per-test but force-exit to avoid handle races
    forceExit: true,
    roots: ['<rootDir>/shared', '<rootDir>/clients'],
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    moduleNameMapper: {
        '^@peershell/protocol$': '<rootDir>/shared/src/index.ts',
    },
}
