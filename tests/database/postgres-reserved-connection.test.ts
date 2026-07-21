import { describe, test, expect } from '@jest/globals';
import { PostgresClient } from '../../src';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'linkgress_test',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

/**
 * PostgresClient.connect() must return a connection pinned to ONE session
 * (postgres >= 3.4 `sql.reserve()`). Before the fix it handed back the shared
 * pool, so session state (temp tables, SET, advisory locks) silently landed
 * on arbitrary connections.
 */
describe('PostgresClient pooled connections', () => {
  test('connect() returns a connection pinned to one session', async () => {
    const client = new PostgresClient(DB_CONFIG);

    try {
      const conn = await client.connect();

      // TEMP tables are session-scoped: visible on the later queries only if
      // they really run on the same reserved connection.
      await conn.query(`CREATE TEMP TABLE pgjs_reserved_probe (id int)`);
      await conn.query(`INSERT INTO pgjs_reserved_probe VALUES (42)`);
      const result = await conn.query(`SELECT id FROM pgjs_reserved_probe`);
      expect(result.rows).toEqual([{ id: 42 }]);

      await conn.query(`DROP TABLE pgjs_reserved_probe`);
      conn.release();

      // The pool must stay fully usable after releasing the reservation.
      const after = await client.query(`SELECT 1 AS one`);
      expect(after.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  });
});
