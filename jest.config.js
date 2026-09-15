// LINKGRESS_TEST_DB=memory runs the whole suite against the in-memory database: the real
// `pg` / `postgres` drivers are swapped for wrappers whose connections use an in-process
// socket (see tests/memory). Unset, nothing below changes.
const memoryMode = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory';

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...(memoryMode
    ? {
        moduleNameMapper: {
          '^pg$': '<rootDir>/tests/memory/pg-memory.ts',
          '^postgres$': '<rootDir>/tests/memory/postgres-memory.ts',
        },
      }
    : {}),
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Override tsconfig for tests
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      }
    }]
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000,
  verbose: true,
  maxWorkers: 1, // Run tests serially to avoid database conflicts
};
