import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import 'dotenv/config';

import { PostgresClient, QueryTimeoutError, sql } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { withDatabase, seedTestData } from '../utils/test-database';

/**
 * Native query-timeout tests for the `postgres` (porsager) driver.
 *
 * Design under test:
 *  - A connection-level default `statement_timeout` set at client creation,
 *    enforced by the server for every query with NO per-query wrapping.
 *  - A per-query override via `.withTimeout(ms)` that wraps ONLY that query in a
 *    short transaction (`SET LOCAL statement_timeout`), so it cannot leak to
 *    other queries on the pooled connection. `.withTimeout(0)` disables it.
 *
 * Both surface a typed `QueryTimeoutError` (PostgreSQL code 57014).
 *
 * The shared harness uses `PgClient`; these tests spin up a `PostgresClient`.
 */

const connectionBase = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'linkgress_test',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 3,
};

/** Run a promise and return the rejection (or `undefined` if it resolved). */
async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('Query timeouts (PostgresClient)', () => {
  describe('connection-level default (statement_timeout at creation)', () => {
    let client: PostgresClient;

    beforeAll(() => {
      client = new PostgresClient({ ...connectionBase, statement_timeout: 400 });
    });

    afterAll(async () => {
      await client.end();
    });

    it('cancels a slow query with QueryTimeoutError (no wrapping)', async () => {
      const start = Date.now();
      const err = await captureError(client.query('SELECT pg_sleep(5)'));
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(err.timeoutMs).toBe(400);
      expect(err.cause?.code).toBe('57014');
      expect(Date.now() - start).toBeLessThan(3000); // cancelled, not waited out
    });

    it('lets a fast query complete', async () => {
      const result = await client.query('SELECT 1 AS x');
      expect(result.rows[0].x).toBe(1);
    });

    it('a tighter per-query .withTimeout overrides the default', async () => {
      const start = Date.now();
      const err = await captureError(client.query('SELECT pg_sleep(5)', [], { timeoutMs: 200 }));
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(err.timeoutMs).toBe(200);
      expect(Date.now() - start).toBeLessThan(2000);
    });

    it('.withTimeout(0) disables the default for a single query', async () => {
      // pg_sleep(0.3) would be cancelled by the 400ms default... it is under it,
      // so instead prove disable lets a query run *past* the default unharmed.
      const result = await client.query('SELECT pg_sleep(0.6) AS slept', [], { timeoutMs: 0 });
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('per-query override only (no default)', () => {
    let client: PostgresClient;

    beforeAll(() => {
      client = new PostgresClient({ ...connectionBase });
    });

    afterAll(async () => {
      await client.end();
    });

    it('wraps only the timed query and throws QueryTimeoutError', async () => {
      const err = await captureError(client.query('SELECT pg_sleep(5)', [], { timeoutMs: 400 }));
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(err.timeoutMs).toBe(400);
    });

    it('does not leak the SET LOCAL to the next query on the pool', async () => {
      // Time out a query (wrapped with SET LOCAL statement_timeout)...
      const err = await captureError(client.query('SELECT pg_sleep(5)', [], { timeoutMs: 300 }));
      expect(err).toBeInstanceOf(QueryTimeoutError);

      // ...then a plain query must run to completion past that 300ms with NO
      // timeout — proving the override was transaction-scoped, not leaked.
      const start = Date.now();
      const result = await client.query('SELECT pg_sleep(0.6) AS slept');
      expect(result.rows).toHaveLength(1);
      expect(Date.now() - start).toBeGreaterThanOrEqual(550);
    });
  });

  describe('query-builder / context level (end-to-end)', () => {
    beforeAll(async () => {
      // Seed at least one row so the per-row pg_sleep in the projection executes.
      await withDatabase(async (sharedDb) => {
        await seedTestData(sharedDb);
      });
    });

    it('enforces a connection-level default through the builder', async () => {
      const client = new PostgresClient({ ...connectionBase, statement_timeout: 400 });
      const db = new AppDatabase(client, { collectionStrategy: 'cte' });
      try {
        const err = await captureError(
          db.users.select(u => ({ id: u.id, slept: sql<unknown>`pg_sleep(5)` })).toList()
        );
        expect(err).toBeInstanceOf(QueryTimeoutError);
      } finally {
        await client.end();
      }
    });

    it('enforces a per-query .withTimeout(ms) override through the builder', async () => {
      const client = new PostgresClient({ ...connectionBase });
      const db = new AppDatabase(client, { collectionStrategy: 'cte' });
      try {
        const err = await captureError(
          db.users
            .select(u => ({ id: u.id, slept: sql<unknown>`pg_sleep(5)` }))
            .withTimeout(400)
            .toList()
        );
        expect(err).toBeInstanceOf(QueryTimeoutError);
      } finally {
        await client.end();
      }
    });

    it('.withTimeout(0) disables the default for a single builder query', async () => {
      const client = new PostgresClient({ ...connectionBase, statement_timeout: 300 });
      const db = new AppDatabase(client, { collectionStrategy: 'cte' });
      try {
        const rows = await db.users
          .select(u => ({ id: u.id, slept: sql<unknown>`pg_sleep(0.5)` }))
          .withTimeout(0)
          .toList();
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        await client.end();
      }
    });
  });
});
