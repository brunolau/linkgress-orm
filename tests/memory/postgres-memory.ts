import { memoryDatabase } from './shared-memory-db';

/**
 * Stand-in for the `postgres` module when LINKGRESS_TEST_DB=memory (installed by tests/setup.ts with
 * `mock.module`): the real postgres.js, with every connection going to the in-memory database.
 */
export function createMemoryPostgres(realPostgres: any): any {
  function postgres(a?: unknown, b?: unknown) {
    if (typeof a === 'string') {
      return realPostgres(a, memoryDatabase().postgresOptions((b as Record<string, unknown>) ?? {}));
    }

    return realPostgres(memoryDatabase().postgresOptions((a as Record<string, unknown>) ?? {}));
  }

  Object.assign(postgres, realPostgres);
  (postgres as any).default = postgres;

  return postgres;
}
