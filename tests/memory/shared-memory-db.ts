/* eslint-disable @typescript-eslint/no-var-requires */
import { InMemoryDatabase } from '../../src/memory';

/**
 * The in-memory database a test file runs against when LINKGRESS_TEST_DB=memory.
 *
 * Jest gives every test file its own module registry, so each file gets a fresh database —
 * the equivalent of globalSetup's freshly created schema (see tests/setup.ts).
 *
 * LINKGRESS_MEMORY_THREAD=true hosts it in a worker thread instead (`InMemoryDatabaseThread`, from
 * the compiled `dist` build — run `npm run build` first), exercising the thread transport.
 */
interface MemoryTarget {
  pgPoolConfig<T extends Record<string, unknown>>(config?: T): T;
  postgresOptions<T extends Record<string, unknown>>(options?: T): T;
  terminate?(): Promise<void>;
}

const holder = globalThis as unknown as { __linkgressMemoryDatabase?: MemoryTarget };

const create = (): MemoryTarget => {
  const options = { databaseName: process.env.DB_NAME || 'linkgress_test', userName: process.env.DB_USER || 'postgres' };
  if ((process.env.LINKGRESS_MEMORY_THREAD || '').toLowerCase() === 'true') {
    const { InMemoryDatabaseThread } = require('../../dist/memory');
    return InMemoryDatabaseThread.start({ database: options });
  }
  return new InMemoryDatabase(options);
};

// Kept on the test file's global so isolated module registries (see tests/setup.ts) share it
export const memoryDatabase: MemoryTarget = (holder.__linkgressMemoryDatabase ??= create());

/** Stop a thread-hosted database at the end of the test file. */
export async function disposeMemoryDatabase(): Promise<void> {
  await holder.__linkgressMemoryDatabase?.terminate?.();
}

export function isMemoryTestDatabase(): boolean {
  return (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory';
}
