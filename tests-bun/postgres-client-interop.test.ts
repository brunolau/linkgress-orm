/**
 * PostgresClient under Bun — ESM/CJS require interop.
 *
 * Under Bun, `require('postgres')` can resolve to an ESM module-namespace
 * object (`{ default: postgres }`) instead of the callable itself. The
 * constructor must unwrap `.default`; before the fix it caught the resulting
 * TypeError and misreported "the postgres package is not installed".
 */
import { describe, test, expect } from 'bun:test';
import { PostgresClient } from '../src';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'linkgress_test',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

describe('PostgresClient under Bun', () => {
  test('constructs from a config object and executes a query', async () => {
    const client = new PostgresClient(DB_CONFIG);

    try {
      const result = await client.query('SELECT 1 AS one');
      expect(result.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  });

  test('transaction commits and rolls back', async () => {
    const client = new PostgresClient(DB_CONFIG);

    try {
      await client.query('CREATE TABLE IF NOT EXISTS pgjs_interop_probe (label text)');

      await client.transaction(async (query) => {
        await query('INSERT INTO pgjs_interop_probe (label) VALUES ($1)', ['keep']);
      });

      let thrown = false;

      try {
        await client.transaction(async (query) => {
          await query('INSERT INTO pgjs_interop_probe (label) VALUES ($1)', ['discard']);
          throw new Error('rollback');
        });
      } catch {
        thrown = true;
      }

      expect(thrown).toBe(true);

      const rows = await client.query('SELECT label FROM pgjs_interop_probe ORDER BY label');
      expect(rows.rows).toEqual([{ label: 'keep' }]);
    } finally {
      await client.query('DROP TABLE IF EXISTS pgjs_interop_probe');
      await client.end();
    }
  });
});
