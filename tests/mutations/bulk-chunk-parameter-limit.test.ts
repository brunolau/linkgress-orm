import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, integer, sql, text } from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * A standalone bulk mutation sends its rows in chunks of ⌊⌊65 535 / columns⌋ · 0.6⌋ rows — the columns its rows bind,
 * over EVERY row — and a chunk never binds more parameters than its client takes (`DatabaseClient.maxParameters()`:
 * pg's and Bun's 65 535, postgres.js's 65 533, PGlite's 32 767): on a client that takes fewer than such a chunk
 * binds, the chunk is the most rows of that many columns it takes. PGlite refused every chunk over its 32 767 before
 * — among them what a caller writes standalone when a `MutationBatch` leg registered `ifFits` is declined.
 *
 * The chunks used to be sized by the keys of the FIRST row: a first row carrying one column, before rows of five,
 * sent five parameters a row in chunks sized for one. And a cell holding an `sql` fragment binds the fragment's own
 * parameters, not one: such rows close their statement before the parameter budget of a chunk, not only at its rows.
 *
 * Every chunker — the entity table's insertBulk, upsertBulk, bulkUpdate, mergeBulk and insertBulk().toStatement(),
 * the untyped table's (`getTable()`) insertBulk and upsertBulk — on the client's own limit and on a lower one (1 000,
 * simulated on every engine). ORACLE: the same input on the client's own limit — the statements it sent before (one),
 * the rows it writes.
 */

class ChkRow extends DbEntity {
  id!: DbColumn<number>;
  a!: DbColumn<number>;
  b!: DbColumn<string>;
  c!: DbColumn<number>;
  d!: DbColumn<string>;
}

/** Four nullable columns: a row may carry any of them */
class ChkSparse extends DbEntity {
  id!: DbColumn<number>;
  e1?: DbColumn<number>;
  e2?: DbColumn<string>;
  e3?: DbColumn<number>;
  e4?: DbColumn<string>;
}

class ChunkDatabase extends DbContext {
  get rows(): DbEntityTable<ChkRow> {
    return this.table(ChkRow);
  }

  get sparse(): DbEntityTable<ChkSparse> {
    return this.table(ChkSparse);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(ChkRow, entity => {
      entity.toTable('chk_rows');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.a).hasType(integer('a')).isRequired();
      entity.property(e => e.b).hasType(text('b')).isRequired();
      entity.property(e => e.c).hasType(integer('c')).isRequired();
      entity.property(e => e.d).hasType(text('d')).isRequired();
    });

    model.entity(ChkSparse, entity => {
      entity.toTable('chk_sparse');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.e1).hasType(integer('e1'));
      entity.property(e => e.e2).hasType(text('e2'));
      entity.property(e => e.e3).hasType(integer('e3'));
      entity.property(e => e.e4).hasType(text('e4'));
    });
  }
}

type Chunker = 'insertBulk' | 'upsertBulk' | 'bulkUpdate' | 'mergeBulk' | 'getTable().insertBulk' | 'getTable().upsertBulk';

const CHUNKERS: Chunker[] = ['insertBulk', 'upsertBulk', 'bulkUpdate', 'mergeBulk', 'getTable().insertBulk', 'getTable().upsertBulk'];

/** The lower limit: a 5-column chunk of it is 200 rows, so 300 rows are two statements (1 000 + 500 parameters) */
const LOW_LIMIT = 1000;

const input = (count: number, tag: string) => Array.from({ length: count }, (_, i) => ({ id: i + 1, a: i, b: `b-${tag}-${i}`, c: i * 2, d: `d-${tag}` }));

describe('standalone bulk mutations chunk within the client\'s parameter limit', () => {
  let client: DatabaseClient;
  let db: ChunkDatabase;
  const captured: string[] = [];

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new ChunkDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS chk_rows CASCADE');
    await client.query('DROP TABLE IF EXISTS chk_sparse CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS chk_rows CASCADE');
    await client.query('DROP TABLE IF EXISTS chk_sparse CASCADE');
    await db.dispose();
  });

  /** What each chunker does with the input — the update forms over the rows `reset` seeds */
  const RUN: Record<Chunker, { seeded: boolean; run: (rows: ReturnType<typeof input>) => PromiseLike<unknown> }> = {
    'insertBulk': { seeded: false, run: rows => db.rows.insertBulk(rows) },
    'upsertBulk': { seeded: true, run: rows => db.rows.upsertBulk(rows, { primaryKey: 'id' }) },
    'bulkUpdate': { seeded: true, run: rows => db.rows.bulkUpdate(rows) },
    'mergeBulk': { seeded: true, run: rows => db.rows.mergeBulk(rows, { on: ['id'] }) },
    'getTable().insertBulk': { seeded: false, run: rows => (db as any).getTable('chk_rows').insertBulk(rows) },
    'getTable().upsertBulk': { seeded: true, run: rows => (db as any).getTable('chk_rows').upsertBulk(rows, { primaryKey: 'id' }) },
  };

  const reset = async (seeded: boolean) => {
    await client.query('DELETE FROM chk_rows');

    if (seeded) {
      await db.rows.insertBulk(input(300, 'seed'));
    }

    captured.length = 0;
  };

  const stored = async () => {
    const raw = (await client.query('SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r."id"), \'[]\'::json) AS rows FROM chk_rows r')).rows[0].rows;

    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };

  /** The mutations sent, as the parameters each binds (its highest placeholder) */
  const sent = () => captured
    .filter(entry => /^\s*(INSERT|UPDATE|MERGE|WITH)\b/.test(entry))
    .map(statement => Math.max(0, ...Array.from(statement.matchAll(/\$(\d+)/g), match => Number(match[1]))));

  /** Run with the client reporting `limit` (or its own) */
  const withLimit = async <T>(limit: number | null, run: () => Promise<T>): Promise<T> => {
    if (limit != null) {
      (client as any).maxParameters = () => limit;
    }

    try {
      return await run();
    } finally {
      if (limit != null) {
        delete (client as any).maxParameters;
      }
    }
  };

  for (const chunker of CHUNKERS) {
    test(`${chunker}: 300 rows of 5 columns are one statement on the client's limit, two within a limit of 1 000 — the same rows`, async () => {
      const write = async (limit: number | null) => {
        await reset(RUN[chunker].seeded);
        await withLimit(limit, async () => {
          await RUN[chunker].run(input(300, 'new'));
        });

        return { statements: sent(), rows: await stored() };
      };

      const own = await write(null);

      // Neutral on the client's own limit: what it sent before
      expect(own.statements).toEqual([1500]);
      expect(own.rows).toEqual(input(300, 'new'));
      expect(await write(LOW_LIMIT)).toEqual({ statements: [1000, 500], rows: own.rows });
    });
  }

  test('insertBulk().toStatement(): compiles one chunk — the chunk the client takes', async () => {
    await withLimit(LOW_LIMIT, async () => {
      expect(db.rows.insertBulk(input(200, 'x')).toStatement().params).toHaveLength(1000);
      expect(() => db.rows.insertBulk(input(201, 'x')).toStatement()).toThrow(
        'toStatement(): 201 rows exceed the 200-row chunk of one insert into "chk_rows" — insertBulk() would execute them as 2 statements, a compiled statement is one.'
      );
    });
    expect(db.rows.insertBulk(input(300, 'x')).toStatement().params).toHaveLength(1500);
  });

  test('an explicit chunkSize is the caller\'s: honoured as given, whatever the client takes', async () => {
    await reset(false);
    await withLimit(LOW_LIMIT, async () => {
      await db.rows.insertBulk(input(300, 'new'), { chunkSize: 250 });
    });

    expect(sent()).toEqual([1250, 250]);
  });

  /** 300 rows of chk_sparse: the first carries its key alone, the others all four columns */
  const sparseInput = (count: number, tag: string) => Array.from({ length: count }, (_, i) => (i === 0
    ? { id: 1 }
    : { id: i + 1, e1: i, e2: `e-${tag}-${i}`, e3: i * 2, e4: `f-${tag}` }));

  const SPARSE_RUN: Record<Chunker, { seeded: boolean; run: (rows: ReturnType<typeof sparseInput>) => PromiseLike<unknown> }> = {
    'insertBulk': { seeded: false, run: rows => db.sparse.insertBulk(rows) },
    'upsertBulk': { seeded: true, run: rows => db.sparse.upsertBulk(rows, { primaryKey: 'id' }) },
    'bulkUpdate': { seeded: true, run: rows => db.sparse.bulkUpdate(rows) },
    'mergeBulk': { seeded: true, run: rows => db.sparse.mergeBulk(rows, { on: ['id'] }) },
    'getTable().insertBulk': { seeded: false, run: rows => (db as any).getTable('chk_sparse').insertBulk(rows) },
    'getTable().upsertBulk': { seeded: true, run: rows => (db as any).getTable('chk_sparse').upsertBulk(rows, { primaryKey: 'id' }) },
  };

  const storedSparse = async () => {
    const raw = (await client.query('SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r."id"), \'[]\'::json) AS rows FROM chk_sparse r')).rows[0].rows;

    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };

  for (const chunker of CHUNKERS) {
    test(`${chunker}: a first row carrying one column before rows of five — the chunks are sized by the columns the rows bind`, async () => {
      const write = async (limit: number | null) => {
        await client.query('DELETE FROM chk_sparse');

        if (SPARSE_RUN[chunker].seeded) {
          await db.sparse.insertBulk(Array.from({ length: 300 }, (_, i) => ({ id: i + 1, e1: -i, e2: 'seed', e3: -i, e4: 'seed' })));
        }

        captured.length = 0;
        await withLimit(limit, async () => {
          await SPARSE_RUN[chunker].run(sparseInput(300, 'new'));
        });

        return { statements: sent(), rows: await storedSparse() };
      };

      const own = await write(null);
      const low = await write(LOW_LIMIT);

      expect(own.statements).toHaveLength(1);
      // Sized by the first row's ONE key, the 300 rows were one statement of 1 500 parameters — over the 1 000
      expect(low.statements).toHaveLength(2);
      expect(Math.max(...low.statements)).toBeLessThanOrEqual(LOW_LIMIT);
      expect(low.rows).toEqual(own.rows);
    });

    test(`${chunker}: a cell holding an sql fragment binds the fragment's parameters — the statement closes within the limit`, async () => {
      // `b` binds 3 parameters, not 1: 7 a row. A 200-row chunk of 5 columns bound 1 400 of a limit of 1 000
      const rows = input(300, 'frag').map(row => ({ ...row, b: sql`${'x'} || ${row.d} || ${String(row.id)}` }));
      const write = async (limit: number | null) => {
        await reset(RUN[chunker].seeded);
        await withLimit(limit, async () => {
          await RUN[chunker].run(rows as any);
        });

        return { statements: sent(), rows: await stored() };
      };

      const own = await write(null);

      expect(own.statements).toEqual([2100]);
      expect(own.rows.map((row: { b: string }) => row.b)).toEqual(input(300, 'frag').map(row => `x${row.d}${row.id}`));
      expect(await write(LOW_LIMIT)).toEqual({ statements: [994, 994, 112], rows: own.rows });
    });
  }

  test('insertBulk().toStatement(): rows within a chunk\'s rows but over its parameters are refused as rows over a chunk', async () => {
    // `b` an sql fragment of 3 parameters: 7 a row
    const rows = input(150, 'frag').map(row => ({ ...row, b: sql`${'x'} || ${row.d} || ${String(row.id)}` })) as any[];

    await withLimit(LOW_LIMIT, async () => {
      expect(() => db.rows.insertBulk(rows).toStatement()).toThrow(
        'toStatement(): 150 rows exceed the 142-row chunk of one insert into "chk_rows" — insertBulk() would execute them as 2 statements, a compiled statement is one.'
      );
      expect(db.rows.insertBulk(rows.slice(0, 142)).toStatement().params).toHaveLength(994);
    });
  });

  test('insertBulk().toStatement(): a statement over the client\'s limit is refused at the client\'s limit, not PostgreSQL\'s', async () => {
    await withLimit(LOW_LIMIT, async () => {
      // 200 rows of 5 columns are the chunk — 1 000 parameters — and the RETURNING binds one more
      expect(() => db.rows.insertBulk(input(200, 'x')).toStatement(r => ({ id: r.id, tag: sql<string>`${'t'}` }))).toThrow(
        'toStatement(): the compiled INSERT into "chk_rows" binds 1001 parameters — over the 1 000 this client takes'
      );
    });
  });

  test('PGlite\'s own limit: a chunk the size PostgreSQL takes (7 864 rows of 5 columns, 39 320 parameters) is split to what the client takes', async () => {
    await reset(false);
    await withLimit(client.maxParameters() === 32767 ? null : 32767, async () => {
      await db.rows.insertBulk(input(7864, 'big'));
    });

    expect(sent()).toEqual([32765, 6555]);
    expect((await stored()).length).toBe(7864);
  }, 60000);
});
