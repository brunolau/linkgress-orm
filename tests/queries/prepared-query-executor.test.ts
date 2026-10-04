import { describe, test, expect } from 'bun:test';
import { eq, sql } from '../../src';
import type { LogSection, SlowQueryInfo } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { withDatabase, seedTestData } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * A prepared query's executions run through its context's executor (1.0.33), like every other statement of the
 * context: statement and failure logging, slow-query detection, `.expectedExecutionTime()`, `.withTimeout()`,
 * `.withPreparedStatements()` and `preparedStatements` apply to `execute()`. `PreparedQuery.execute()` sent its
 * statement to the client directly, so none of them did. (Timeouts and named statements: query-timeout.test.ts and
 * prepared-statements.test.ts, which run on PostgresClient.)
 */
describe('prepare(): executions run through the context executor', () => {
  test('logQueries logs every execution with its parameters', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      const logged: string[] = [];
      const ctx = new AppDatabase(db.getClient(), {
        logQueries: true,
        logParameters: true,
        logger: (message: string, section?: LogSection) => { logged.push(`${section}: ${message}`); },
      });

      const byName = ctx.users.where(u => eq(u.username, sql.placeholder('name'))).select(u => ({ id: u.id })).prepare('byName');
      logged.length = 0;
      await byName.execute({ name: 'alice' });
      await byName.execute({ name: 'bob' });

      expect(logged.filter(line => line.startsWith('sql: SELECT'))).toHaveLength(2);
      expect(logged).toContain('params: [Parameters] ["alice"]');
      expect(logged).toContain('params: [Parameters] ["bob"]');
    });
  });

  test('a failed execution is reported through logFailedQueries', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      const errors: string[] = [];
      const ctx = new AppDatabase(db.getClient(), {
        logFailedQueries: true,
        logger: (message: string, section?: LogSection) => { if (section === 'error') errors.push(message); },
      });

      // an integer column, a text value: the server refuses it (22P02) when the execution binds it
      const byAge = ctx.users.where(u => eq(u.age, sql.placeholder('age'))).select(u => ({ id: u.id })).prepare('byAge');
      await expectToReject(byAge.execute({ age: 'not a number' as unknown as number }));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toStartWith('[SQL Error] ');
      expect(errors[0]).toContain('"users"."age" = $1');
    });
  });

  test('onQueryTakingTooLong fires for an execution over the threshold', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      const calls: SlowQueryInfo[] = [];
      const ctx = new AppDatabase(db.getClient(), { onQueryTakingTooLong: info => { calls.push(info); }, longRunningQueryThreshold: 0 });

      const byName = ctx.users.where(u => eq(u.username, sql.placeholder('name'))).select(u => ({ id: u.id })).prepare('byName');
      calls.length = 0;
      await byName.execute({ name: 'alice' });

      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('FROM "users"');
      expect(calls[0].params).toEqual(['alice']);
    });
  });

  test('the builder\'s own executor (expectedExecutionTime) carries into the prepared query', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      const calls: SlowQueryInfo[] = [];
      const ctx = new AppDatabase(db.getClient(), { onQueryTakingTooLong: info => { calls.push(info); }, longRunningQueryThreshold: 60_000 });

      const byName = ctx.users
        .where(u => eq(u.username, sql.placeholder('name')))
        .select(u => ({ id: u.id }))
        .expectedExecutionTime(0)
        .prepare('byName');
      calls.length = 0;
      await byName.execute({ name: 'alice' });

      expect(calls).toHaveLength(1);
      expect(calls[0].thresholdMs).toBe(0);
    });
  });

  test('results are unchanged', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      const ctx = new AppDatabase(db.getClient(), { logQueries: true, logger: () => {} });

      const byName = ctx.users.where(u => eq(u.username, sql.placeholder('name'))).select(u => ({ name: u.username, age: u.age })).prepare('byName');

      expect(await byName.execute({ name: 'alice' })).toEqual([{ name: 'alice', age: 25 }]);
      expect(await byName.execute({ name: 'nobody' })).toEqual([]);
    });
  });
});
