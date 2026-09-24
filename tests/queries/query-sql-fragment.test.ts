import { describe, test, expect } from 'bun:test';
import { withDatabase } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { cast, sql } from '../../src';

/**
 * `db.query(sql`…`)`: raw statements as fragments. Every interpolated value is a bound parameter,
 * nested fragments and `sql.join()` continue one `$n` numbering, `sql.raw()` text is inlined, and a
 * named `sql.placeholder()` is refused (only a prepared query can bind it).
 */
describe('db.query(SqlFragment)', () => {
  test('binds every interpolated value as a parameter', async () => {
    await withDatabase(async (db) => {
      const label = `it's "quoted" and $1`;

      const rows = await db.query<{ answer: number; label: string }>(
        sql`SELECT ${41}::int + 1 AS answer, ${label}::text AS label`
      );

      expect(rows).toEqual([{ answer: 42, label }]);
    });
  });

  test('keeps one parameter numbering across nested fragments and sql.join()', async () => {
    await withDatabase(async (db) => {
      const values = sql.join([3, 5, 8].map(v => sql`(${v}::int)`));

      const rows = await db.query<{ total: number }>(
        sql`SELECT sum(v)::int AS total FROM (VALUES ${values}) AS t(v) WHERE v > ${sql`${2}::int`}`
      );

      expect(rows).toEqual([{ total: 16 }]);
    });
  });

  test('inlines sql.raw() text instead of binding it', async () => {
    await withDatabase(async (db) => {
      const rows = await db.query<{ kind: string; other: string }>(
        sql`SELECT ${sql.raw(`'raw'`)}::text AS kind, ${'bound'}::text AS other`
      );

      // Bound as a parameter, the value would arrive with its quotes: "'raw'".
      expect(rows).toEqual([{ kind: 'raw', other: 'bound' }]);
    });
  });

  test('passes arrays and JSON text as ordinary parameters (the pg driver\'s serialization)', async () => {
    // A raw JS array and raw JSON text are bound as the DRIVER serializes them: pg sends an array
    // literal and the text as is; postgres.js and Bun (prepared) serialize by the described type,
    // storing JSON text as a JSON string, and Bun cannot bind a JS array to an array parameter
    // (see bun-sql-contract.test.ts). The cast helpers below bind both the same way on every driver.
    if ((process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase() !== 'pg') {
      return;
    }

    await withDatabase(async (db) => {
      const rows = await db.query<{ size: number; featured: boolean }>(
        sql`SELECT cardinality(${[1, 2, 3]}::int[])::int AS size, (${JSON.stringify({ featured: true })}::jsonb ->> 'featured')::boolean AS featured`
      );

      expect(rows).toEqual([{ size: 3, featured: true }]);
    });
  });

  test('passes arrays and JSON through the cast helpers the same way on every driver', async () => {
    await withDatabase(async (db) => {
      const rows = await db.query<{ size: number; third: string; featured: boolean; fromObject: boolean }>(
        sql`SELECT cardinality(${cast([1, 2, 3], 'int[]')})::int AS size,
          (${cast(['a', 'b,c', 'd"e'], 'text[]')})[3] AS third,
          (${cast(JSON.stringify({ featured: true }), 'jsonb')} ->> 'featured')::boolean AS featured,
          (${cast({ featured: true }, 'jsonb')} ->> 'featured')::boolean AS "fromObject"`
      );

      expect(rows).toEqual([{ size: 3, third: 'd"e', featured: true, fromObject: true }]);
    });
  });

  test('runs on the transactional context', async () => {
    await withDatabase(async (db) => {
      const rows = await db.transaction(async (tx) => {
        await tx.query(sql`CREATE TEMP TABLE fragment_probe (id int)`);
        await tx.query(sql`INSERT INTO fragment_probe (id) VALUES (${7}), (${9})`);
        const found = await tx.query<{ id: number }>(sql`SELECT id FROM fragment_probe WHERE id > ${8} ORDER BY id`);
        await tx.query(sql`DROP TABLE fragment_probe`);

        return found;
      });

      expect(rows).toEqual([{ id: 9 }]);
    });
  });

  test('refuses sql.placeholder(), which only a prepared query can bind', async () => {
    await withDatabase(async (db) => {
      await expectToReject(db.query(sql`SELECT ${sql.placeholder('id')}::int AS id`), /placeholder/);
    });
  });

  test('keeps the text + params form', async () => {
    await withDatabase(async (db) => {
      const rows = await db.query<{ v: number }>('SELECT $1::int AS v', [5]);

      expect(rows).toEqual([{ v: 5 }]);
    });
  });
});
