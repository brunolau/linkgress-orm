import { describe, test, expect } from 'bun:test';
import { withDatabase } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { sql } from '../../src';

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

  test('passes arrays and JSON text as ordinary parameters', async () => {
    await withDatabase(async (db) => {
      const rows = await db.query<{ size: number; featured: boolean }>(
        sql`SELECT cardinality(${[1, 2, 3]}::int[])::int AS size, (${JSON.stringify({ featured: true })}::jsonb ->> 'featured')::boolean AS featured`
      );

      expect(rows).toEqual([{ size: 3, featured: true }]);
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
