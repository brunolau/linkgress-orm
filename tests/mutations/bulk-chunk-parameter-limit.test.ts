import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, integer, text } from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * A standalone bulk mutation sends its rows in chunks of ⌊⌊65 535 / columns⌋ · 0.6⌋ rows (the columns of its first
 * row) — and a chunk never binds more parameters than its client takes (`DatabaseClient.maxParameters()`:
 * PostgreSQL's 65 535, PGlite's 32 767): on a client that takes fewer than such a chunk binds, the chunk is the most
 * rows of that many columns it takes. PGlite refused every chunk over its 32 767 before — among them what a caller
 * writes standalone when a `MutationBatch` leg registered `ifFits` is declined.
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

class ChunkDatabase extends DbContext {
  get rows(): DbEntityTable<ChkRow> {
    return this.table(ChkRow);
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
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS chk_rows CASCADE');
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

  test('PGlite\'s own limit: a chunk the size PostgreSQL takes (7 864 rows of 5 columns, 39 320 parameters) is split to what the client takes', async () => {
    await reset(false);
    await withLimit(client.maxParameters() === 32767 ? null : 32767, async () => {
      await db.rows.insertBulk(input(7864, 'big'));
    });

    expect(sent()).toEqual([32765, 6555]);
    expect((await stored()).length).toBe(7864);
  }, 60000);
});
