/** Jest config for the monorepo (ts-jest, node env). Runs *.test.ts under shared/ and clients/. */
module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/jest.setup.cjs'],
    roots: ['<rootDir>/shared', '<rootDir>/clients'],
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    moduleNameMapper: {
        '^@peershell/protocol$': '<rootDir>/shared/src/index.ts',
    },
}
