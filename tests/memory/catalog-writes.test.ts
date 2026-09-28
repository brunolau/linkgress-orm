/* eslint-disable @typescript-eslint/no-var-requires */
import { describe, expect, test } from 'bun:test';
import { createInMemoryDatabase } from '../../src';
import { expectToReject } from '../utils/expect-rejects';

/**
 * Catalog writes in the in-memory engine. PostgreSQL lets a superuser change any catalog row; the engine's
 * catalogs are generated from its own catalog structures, so it accepts exactly one catalog write — `UPDATE
 * pg_index` of the index state flags `indisvalid` / `indisready`, mapped onto the index the row describes (the
 * state a failed CREATE INDEX CONCURRENTLY leaves, which the schema manager repairs) — and refuses every other one
 * with 42501, as it always did.
 *
 * These tests run the engine directly, on a database of their own, so they behave the same in every mode; the
 * flag write itself is compared with PostgreSQL's in tests/schema/failed-concurrent-index-build.test.ts.
 */

// the real driver (LINKGRESS_TEST_DB=memory replaces the `pg` module with an in-memory wrapper)
const realDrivers = (globalThis as any).__linkgressRealDrivers;
const { Client } = realDrivers?.pg ?? require('pg');

async function withEngine(body: (client: any) => Promise<void>): Promise<void> {
  const db = createInMemoryDatabase({ databaseName: 'catalog_writes' });
  const client = new Client(db.pgPoolConfig());
  await client.connect();
  try {
    await client.query('CREATE TABLE shelf (id integer PRIMARY KEY, code text, n integer)');
    await client.query('CREATE UNIQUE INDEX shelf_code_uq ON shelf (code)');
    await body(client);
  } finally {
    await client.end();
  }
}

const flags = async (client: any): Promise<{ valid: boolean; ready: boolean; unique: boolean }> =>
  (await client.query(`SELECT indisvalid AS valid, indisready AS ready, indisunique AS unique FROM pg_index WHERE indexrelid = 'shelf_code_uq'::regclass`)).rows[0];

describe('in-memory engine: catalog writes', () => {
  describe('UPDATE pg_index of the index state flags is accepted', () => {
    test('indisvalid and indisready, alone or together, each write their own flag', async () => {
      await withEngine(async client => {
        const invalid = await client.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'shelf_code_uq'::regclass`);
        const afterInvalid = await flags(client);
        const unready = await client.query(`UPDATE pg_index SET indisready = false WHERE indexrelid = 'shelf_code_uq'::regclass`);
        const afterUnready = await flags(client);
        const restored = await client.query(`UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'shelf_code_uq'::regclass`);

        expect([invalid.command, invalid.rowCount, unready.rowCount, restored.rowCount]).toEqual(['UPDATE', 1, 1, 1]);
        expect(afterInvalid).toEqual({ valid: false, ready: true, unique: true });
        expect(afterUnready).toEqual({ valid: false, ready: false, unique: true });
        expect(await flags(client)).toEqual({ valid: true, ready: true, unique: true });
      });
    });

    test('the flags drive the engine: a ready unique index rejects a duplicate even while INVALID; a not-ready one accepts it', async () => {
      await withEngine(async client => {
        await client.query(`INSERT INTO shelf VALUES (1, 'a', 1)`);
        await client.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'shelf_code_uq'::regclass`);
        const whileReady = await expectToReject(client.query(`INSERT INTO shelf VALUES (2, 'a', 2)`));

        await client.query(`UPDATE pg_index SET indisready = false WHERE indexrelid = 'shelf_code_uq'::regclass`);
        await client.query(`INSERT INTO shelf VALUES (2, 'a', 2)`);

        expect([whileReady.code, whileReady.message]).toEqual(['23505', 'duplicate key value violates unique constraint "shelf_code_uq"']);
        expect((await client.query(`SELECT count(*)::int AS n FROM shelf WHERE code = 'a'`)).rows).toEqual([{ n: 2 }]);
      });
    });
  });

  describe('every other catalog write is refused with 42501, as before', () => {
    const REFUSED: Array<[name: string, sql: string, table: string]> = [
      ['UPDATE of another pg_index column', `UPDATE pg_index SET indisunique = false WHERE indexrelid = 'shelf_code_uq'::regclass`, 'pg_index'],
      ['UPDATE that also sets another pg_index column', `UPDATE pg_index SET indisvalid = false, indisunique = false WHERE indexrelid = 'shelf_code_uq'::regclass`, 'pg_index'],
      // PostgreSQL: 42703 column "nosuch" of relation "pg_index" does not exist — the engine refuses the write first
      ['UPDATE of a column pg_index does not have', 'UPDATE pg_index SET nosuch = true', 'pg_index'],
      ['DELETE FROM pg_index', `DELETE FROM pg_index WHERE indexrelid = 'shelf_code_uq'::regclass`, 'pg_index'],
      ['INSERT INTO pg_index', 'INSERT INTO pg_index (indexrelid) VALUES (1)', 'pg_index'],
      ['MERGE INTO pg_index', 'MERGE INTO pg_index x USING (SELECT 1 AS id) s ON false WHEN NOT MATCHED THEN DO NOTHING', 'pg_index'],
      ['UPDATE of another catalog', `UPDATE pg_class SET relname = 'renamed' WHERE relname = 'shelf'`, 'pg_class'],
      ['DELETE FROM another catalog', 'DELETE FROM pg_attribute WHERE false', 'pg_attribute'],
      ['INSERT INTO another catalog', `INSERT INTO pg_namespace (nspname) VALUES ('elsewhere')`, 'pg_namespace'],
      ['UPDATE of a catalog view', `UPDATE pg_indexes SET indexname = 'renamed'`, 'pg_indexes'],
    ];

    for (const [name, sql, table] of REFUSED) {
      test(name, async () => {
        await withEngine(async client => {
          const error = await expectToReject(client.query(sql));

          expect([error.code, error.message]).toEqual(['42501', `permission denied for table ${table}`]);
          expect(await flags(client)).toEqual({ valid: true, ready: true, unique: true });
          expect((await client.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'shelf'`)).rows).toEqual([{ n: 1 }]);
        });
      });
    }
  });
});
