/**
 * Test preload (bunfig.toml `[test] preload`): runs in every `bun test` process before the test file.
 *
 * LINKGRESS_TEST_DB=memory runs the file against the in-memory database: the `pg` and `postgres`
 * modules are replaced by the real drivers wrapped so that every connection uses an in-process socket
 * to this process's database (see tests/memory). The untouched drivers stay reachable as
 * `globalThis.__linkgressRealDrivers` for tests that talk to both (tests/memory/sql-parity.test.ts).
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock } from 'bun:test';
import { disposeSharedDatabase } from './utils/test-database';

const memoryMode = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory';

if (memoryMode) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realPg = require('pg');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postgresModule = require('postgres');
  // Bun resolves `require('postgres')` to the package's ES module namespace
  const realPostgres = postgresModule.default ?? postgresModule;
  (globalThis as any).__linkgressRealDrivers = { pg: realPg, postgres: realPostgres };

  if (!process.env.LINKGRESS_MEMORY_SNAPSHOT || !existsSync(process.env.LINKGRESS_MEMORY_SNAPSHOT)) {
    // run without tests/run.ts: build the schema snapshot the runner would have provided
    const snapshot = path.join(mkdtempSync(path.join(tmpdir(), 'linkgress-memory-')), 'schema.snapshot');
    const built = spawnSync(process.execPath, [path.join(__dirname, 'memory', 'create-schema-snapshot.ts'), snapshot], { stdio: 'inherit', env: process.env });

    if (built.status !== 0) {
      throw new Error('could not build the in-memory schema snapshot (tests/memory/create-schema-snapshot.ts)');
    }
    process.env.LINKGRESS_MEMORY_SNAPSHOT = snapshot;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createMemoryPg } = require('./memory/pg-memory');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createMemoryPostgres } = require('./memory/postgres-memory');
  const memoryPg = createMemoryPg(realPg);
  const memoryPostgres = createMemoryPostgres(realPostgres);
  // mocked by resolved path: a bare specifier would not replace a module that is already loaded
  mock.module(require.resolve('pg'), () => memoryPg);
  mock.module(require.resolve('postgres'), () => ({ ...memoryPostgres, default: memoryPostgres }));
}

if (process.env.LINKGRESS_TEST_RECORD_DIR) {
  // the statement recorder (tests/utils/query-recorder.ts) keys statements by test; Bun has no
  // expect.getState(), so tests are identified by their position in the file
  let ordinal = 0;
  beforeEach(() => {
    (globalThis as any).__linkgressRecordedTest = `test #${++ordinal}`;
  });
  afterEach(() => {
    (globalThis as any).__linkgressRecordedTest = undefined;
  });
}

beforeAll(() => {
  // Ensure we're using test database
  const dbName = process.env.DB_NAME || 'linkgress_test';

  if (!dbName.includes('test')) {
    throw new Error('Tests must use a test database! Set DB_NAME to include "test" in the name.');
  }
});

/**
 * Cleanup after all tests - close the shared database connection
 */
afterAll(async () => {
  await disposeSharedDatabase();

  if (memoryMode) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { disposeMemoryDatabase } = require('./memory/shared-memory-db');
    await disposeMemoryDatabase();
  }
});

/**
 * Custom matchers
 */
expect.extend({
  toBeWithinRange(received: unknown, floor: number, ceiling: number) {
    const pass = typeof received === 'number' && received >= floor && received <= ceiling;

    return {
      message: () => (pass ? `expected ${received} not to be within range ${floor} - ${ceiling}` : `expected ${received} to be within range ${floor} - ${ceiling}`),
      pass,
    };
  },
});

declare module 'bun:test' {
  interface Matchers<T> {
    toBeWithinRange(floor: number, ceiling: number): T;
  }
}
