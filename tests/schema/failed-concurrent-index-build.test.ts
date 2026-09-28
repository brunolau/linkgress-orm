import { describe, test, expect } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { DatabaseClient } from '../../src';
import { sqlStateOf } from '../../src/database/sql-state';

/**
 * What a failed `CREATE INDEX CONCURRENTLY` leaves behind — the state the schema manager's repair of
 * INVALID indexes (tests/schema/invalid-index-repair.test.ts) starts from. PostgreSQL commits the new
 * index's catalog entry before it builds the index, so a build that fails — a unique index over duplicate
 * keys, an index expression or predicate that raises for a row — leaves an INVALID index behind
 * (`indisvalid` and `indisready` false): never used for reads, not maintained on writes, and skipped by
 * every later `CREATE INDEX … IF NOT EXISTS`. The same build without CONCURRENTLY leaves nothing.
 *
 * Also pinned here, as the repair and its tests rely on them: `UPDATE pg_index` writing the index state flags
 * (PostgreSQL lets a superuser; the in-memory engine maps the write onto the same index state and refuses every
 * other catalog write — tests/memory/catalog-writes.test.ts), where `DROP INDEX CONCURRENTLY` is refused, the
 * partitioned index PostgreSQL's online procedure leaves INVALID until every partition has an attached index
 * (`CREATE INDEX … ON ONLY`, `ALTER INDEX … ATTACH PARTITION`), and what an index build evaluates: the table's own
 * rows — not an INHERITS child's — and expressions the in-memory engine cannot evaluate, which it skips.
 *
 * Runs unchanged on PostgreSQL, PGlite and the in-memory engine, which must leave the same state.
 */

const TABLE = 'cib_plant';
const PARTITIONED = 'cib_bed';
/** a table with an INHERITS child, `cib_crop_kid` */
const CROP = 'cib_crop';
const NOTE = 'cib_note';

interface IndexState {
  valid: boolean;
  ready: boolean;
  def: string;
}

async function freshTable(client: DatabaseClient, rows = ''): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await client.query(`CREATE TABLE ${TABLE} (id integer PRIMARY KEY, tag text, bed integer, height integer)`);
  if (rows) {
    await client.query(`INSERT INTO ${TABLE} (id, tag, bed, height) VALUES ${rows}`);
  }
}

/**
 * 150 more plants (ids 100…249, distinct tags): a plan has a real choice only on a table that is not tiny — the
 * in-memory engine, like PostgreSQL by cost, reads a table under 100 rows sequentially.
 */
async function seedBulk(client: DatabaseClient): Promise<void> {
  await client.query(`INSERT INTO ${TABLE} (id, tag, bed, height) SELECT g, 'plant-' || g, g % 7, g FROM generate_series(100, 249) g`);
}

async function dropTables(client: DatabaseClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS ${PARTITIONED} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS ${CROP} CASCADE`);
  await client.query(`DROP TABLE IF EXISTS ${NOTE} CASCADE`);
  await client.query('DROP TABLE IF EXISTS cib_loose CASCADE');
}

async function indexState(client: DatabaseClient, name: string): Promise<IndexState | null> {
  const { rows } = await client.query<IndexState>(
    `SELECT x.indisvalid AS valid, x.indisready AS ready, pg_get_indexdef(x.indexrelid, 0, true) AS def
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [name]
  );

  return rows[0] ?? null;
}

/** The plan of `sql` with sequential scans disabled — it names every index the planner can use. */
async function planWithoutSeqScan(client: DatabaseClient, sql: string): Promise<string> {
  return client.transaction(async query => {
    await query('SET LOCAL enable_seqscan = off');
    const { rows } = await query(`EXPLAIN (COSTS OFF) ${sql}`);

    return rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
  });
}

/** Run a multi-statement string over the simple query protocol (pg's query() without parameters is simple). */
async function simpleQuery(client: DatabaseClient, sql: string): Promise<unknown> {
  const simple = (client as unknown as { querySimple?: (text: string) => Promise<unknown> }).querySimple;

  return simple ? simple.call(client, sql) : client.query(sql);
}

/** `cib_plant_tag_uq` left INVALID by a unique concurrent build over the duplicated tag "rose". */
async function leaveTagIndexInvalid(client: DatabaseClient): Promise<void> {
  await expectToReject(client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_uq ON ${TABLE} (tag)`));
  expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
    valid: false,
    ready: false,
    def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
  });
}

async function withClient(body: (client: DatabaseClient) => Promise<void>): Promise<void> {
  const client = createFreshClient();
  try {
    await dropTables(client);
    await body(client);
  } finally {
    await dropTables(client);
    await client.end();
  }
}

describe('a failed CREATE INDEX CONCURRENTLY', () => {
  describe('unique builds over duplicate keys', () => {
    test('fails with 23505 naming the index and the duplicated key, and leaves an INVALID, not-ready index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20), (3, 'fern', 3, 30)`);

        const error = await expectToReject(client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_uq ON ${TABLE} (tag)`));

        expect(sqlStateOf(error)).toBe('23505');
        expect(error.message).toBe('could not create unique index "cib_plant_tag_uq"');
        expect(error.detail).toBe('Key (tag)=(rose) is duplicated.');
        expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
        });
      });
    });

    test('the same build without CONCURRENTLY fails with 23505 and leaves nothing', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);

        const error = await expectToReject(client.query(`CREATE UNIQUE INDEX cib_plant_tag_uq ON ${TABLE} (tag)`));

        expect(sqlStateOf(error)).toBe('23505');
        expect(error.message).toBe('could not create unique index "cib_plant_tag_uq"');
        expect(await indexState(client, 'cib_plant_tag_uq')).toBeNull();
      });
    });

    test('a multi-column unique build names the whole duplicated key', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 1, 20), (3, 'rose', 2, 30)`);

        const error = await expectToReject(client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_bed_uq ON ${TABLE} (tag, bed)`));

        expect(sqlStateOf(error)).toBe('23505');
        expect(error.detail).toBe('Key (tag, bed)=(rose, 1) is duplicated.');
        expect(await indexState(client, 'cib_plant_tag_bed_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_bed_uq ON cib_plant USING btree (tag, bed)',
        });
      });
    });

    test('a unique expression build over values equal after the expression leaves an INVALID index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'Rose', 1, 10), (2, 'rose', 2, 20)`);

        const error = await expectToReject(client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_lower_uq ON ${TABLE} (lower(tag))`));

        expect(sqlStateOf(error)).toBe('23505');
        expect(await indexState(client, 'cib_plant_tag_lower_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_lower_uq ON cib_plant USING btree (lower(tag))',
        });
      });
    });

    test('a partial unique build fails only on duplicates inside its predicate', async () => {
      await withClient(async client => {
        // the two "rose" rows outside the predicate (bed 0) would not collide; the two inside do
        await freshTable(client, `(1, 'rose', 0, 10), (2, 'rose', 0, 20), (3, 'fern', 5, 30), (4, 'fern', 6, 40)`);

        const error = await expectToReject(client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_bedded_uq ON ${TABLE} (tag) WHERE bed > 0`));

        expect(sqlStateOf(error)).toBe('23505');
        expect(error.detail).toBe('Key (tag)=(fern) is duplicated.');
        expect(await indexState(client, 'cib_plant_tag_bedded_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_bedded_uq ON cib_plant USING btree (tag) WHERE bed > 0',
        });
      });
    });

    test('NULLS NOT DISTINCT: two NULL keys fail the build', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, NULL, 1, 10), (2, NULL, 2, 20)`);

        const error = await expectToReject(client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_nnd_uq ON ${TABLE} (tag) NULLS NOT DISTINCT`));

        expect(sqlStateOf(error)).toBe('23505');
        expect(await indexState(client, 'cib_plant_tag_nnd_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_nnd_uq ON cib_plant USING btree (tag) NULLS NOT DISTINCT',
        });
      });
    });

    test('NULL keys never collide in a plain unique build: it succeeds and the index is valid', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, NULL, 1, 10), (2, NULL, 2, 20), (3, 'fern', 3, 30)`);

        await client.query(`CREATE UNIQUE INDEX CONCURRENTLY cib_plant_tag_uq ON ${TABLE} (tag)`);

        expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
          valid: true,
          ready: true,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
        });
      });
    });
  });

  describe('builds whose expression or predicate raises for a row', () => {
    test('an index expression dividing by zero fails the build with 22012 and leaves an INVALID index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'fern', 2, 0)`);

        const error = await expectToReject(client.query(`CREATE INDEX CONCURRENTLY cib_plant_ratio_ix ON ${TABLE} ((100 / height))`));

        expect(sqlStateOf(error)).toBe('22012');
        expect(error.message).toBe('division by zero');
        expect(await indexState(client, 'cib_plant_ratio_ix')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE INDEX cib_plant_ratio_ix ON cib_plant USING btree ((100 / height))',
        });
      });
    });

    test('the same expression build without CONCURRENTLY fails with 22012 and leaves nothing', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'fern', 2, 0)`);

        const error = await expectToReject(client.query(`CREATE INDEX cib_plant_ratio_ix ON ${TABLE} ((100 / height))`));

        expect(sqlStateOf(error)).toBe('22012');
        expect(await indexState(client, 'cib_plant_ratio_ix')).toBeNull();
      });
    });

    test('a partial-index predicate dividing by zero fails the build and leaves an INVALID index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'fern', 2, 0)`);

        const error = await expectToReject(client.query(`CREATE INDEX CONCURRENTLY cib_plant_tall_ix ON ${TABLE} (tag) WHERE (100 / height) > 1`));

        expect(sqlStateOf(error)).toBe('22012');
        expect(await indexState(client, 'cib_plant_tall_ix')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE INDEX cib_plant_tall_ix ON cib_plant USING btree (tag) WHERE (100 / height) > 1',
        });
      });
    });

    test('a row outside the predicate never evaluates the index expression: the build succeeds', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'fern', 2, 0)`);

        await client.query(`CREATE INDEX CONCURRENTLY cib_plant_ratio_ix ON ${TABLE} ((100 / height)) WHERE height <> 0`);

        expect(await indexState(client, 'cib_plant_ratio_ix')).toEqual({
          valid: true,
          ready: true,
          def: 'CREATE INDEX cib_plant_ratio_ix ON cib_plant USING btree ((100 / height)) WHERE height <> 0',
        });
      });
    });

    test('an expression over an empty table builds a valid index (nothing to evaluate)', async () => {
      await withClient(async client => {
        await freshTable(client);

        await client.query(`CREATE INDEX CONCURRENTLY cib_plant_ratio_ix ON ${TABLE} ((100 / height))`);

        expect(await indexState(client, 'cib_plant_ratio_ix')).toEqual({
          valid: true,
          ready: true,
          def: 'CREATE INDEX cib_plant_ratio_ix ON cib_plant USING btree ((100 / height))',
        });
      });
    });
  });

  describe('the INVALID index left behind', () => {
    test('does not enforce uniqueness: a duplicate insert is accepted', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);

        await client.query(`INSERT INTO ${TABLE} (id, tag, bed, height) VALUES (3, 'rose', 3, 30)`);

        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE tag = 'rose'`);
        expect(rows).toEqual([{ n: 3 }]);
      });
    });

    test('is never used for reads', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20), (3, 'fern', 3, 30)`);
        await seedBulk(client);
        await leaveTagIndexInvalid(client);

        const plan = await planWithoutSeqScan(client, `SELECT id FROM ${TABLE} WHERE tag = 'fern'`);

        expect(plan).toContain(`Seq Scan on ${TABLE}`);
        expect(plan).not.toContain('cib_plant_tag_uq');
      });
    });

    test('CREATE INDEX CONCURRENTLY IF NOT EXISTS skips it: it stays INVALID', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);
        await client.query(`DELETE FROM ${TABLE} WHERE id = 2`);

        await client.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cib_plant_tag_uq ON ${TABLE} (tag)`);

        expect((await indexState(client, 'cib_plant_tag_uq'))?.valid).toBe(false);
      });
    });

    test('a plain CREATE INDEX IF NOT EXISTS skips it too: it stays INVALID', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);
        await client.query(`DELETE FROM ${TABLE} WHERE id = 2`);

        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS cib_plant_tag_uq ON ${TABLE} (tag)`);

        expect((await indexState(client, 'cib_plant_tag_uq'))?.valid).toBe(false);
      });
    });

    test('holds its name: a CREATE INDEX of that name without IF NOT EXISTS fails with 42P07', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);

        const error = await expectToReject(client.query(`CREATE INDEX cib_plant_tag_uq ON ${TABLE} (bed)`));

        expect(sqlStateOf(error)).toBe('42P07');
        expect(error.message).toBe('relation "cib_plant_tag_uq" already exists');
        expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
        });
      });
    });

    test('is seen by every other session (the catalog entry was committed before the build)', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);

        const other = createFreshClient();
        try {
          expect(await indexState(other, 'cib_plant_tag_uq')).toEqual({
            valid: false,
            ready: false,
            def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
          });
        } finally {
          await other.end();
        }
      });
    });

    test('has no row in pg_stat_progress_create_index: no build is running', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);

        const { rows } = await client.query(
          `SELECT p.pid, p.datid, p.datname, p.relid, p.index_relid, p.command, p.phase, p.lockers_total, p.lockers_done,
                  p.current_locker_pid, p.blocks_total, p.blocks_done, p.tuples_total, p.tuples_done,
                  p.partitions_total, p.partitions_done
             FROM pg_stat_progress_create_index p
            WHERE p.index_relid = to_regclass('cib_plant_tag_uq')`
        );
        expect(rows).toEqual([]);
      });
    });

    test('TRUNCATE rebuilds a non-unique one over no rows: it is valid again', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'fern', 2, 0)`);
        await expectToReject(client.query(`CREATE INDEX CONCURRENTLY cib_plant_ratio_ix ON ${TABLE} ((100 / height))`));
        expect((await indexState(client, 'cib_plant_ratio_ix'))?.valid).toBe(false);

        await client.query(`TRUNCATE ${TABLE}`);

        expect(await indexState(client, 'cib_plant_ratio_ix')).toEqual({
          valid: true,
          ready: true,
          def: 'CREATE INDEX cib_plant_ratio_ix ON cib_plant USING btree ((100 / height))',
        });
      });
    });

    test('TRUNCATE leaves a unique one INVALID: it rebuilds indexes without re-checking uniqueness', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20)`);
        await leaveTagIndexInvalid(client);

        await client.query(`TRUNCATE ${TABLE}`);

        expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
          valid: false,
          ready: false,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
        });
      });
    });

    test('DROP INDEX CONCURRENTLY + CREATE INDEX CONCURRENTLY rebuild it into a valid, enforcing, used index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10), (2, 'rose', 2, 20), (3, 'fern', 3, 30)`);
        await seedBulk(client);
        await leaveTagIndexInvalid(client);
        await client.query(`DELETE FROM ${TABLE} WHERE id = 2`);

        await client.query('DROP INDEX CONCURRENTLY IF EXISTS cib_plant_tag_uq');
        await client.query(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cib_plant_tag_uq ON ${TABLE} (tag)`);

        expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
          valid: true,
          ready: true,
          def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
        });
        const duplicate = await expectToReject(client.query(`INSERT INTO ${TABLE} (id, tag, bed, height) VALUES (4, 'fern', 4, 40)`));
        expect(sqlStateOf(duplicate)).toBe('23505');
        expect(duplicate.message).toBe('duplicate key value violates unique constraint "cib_plant_tag_uq"');
        expect(await planWithoutSeqScan(client, `SELECT id FROM ${TABLE} WHERE tag = 'fern'`)).toContain('cib_plant_tag_uq');
      });
    });
  });

  describe('where it cannot run, nothing is left behind', () => {
    test('an unknown column fails before the build: no index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10)`);

        const error = await expectToReject(client.query(`CREATE INDEX CONCURRENTLY cib_plant_bad_ix ON ${TABLE} (nope)`));

        expect(sqlStateOf(error)).toBe('42703');
        expect(error.message).toBe('column "nope" does not exist');
        expect(await indexState(client, 'cib_plant_bad_ix')).toBeNull();
      });
    });

    test('inside a transaction block: 25001, no index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10)`);

        const error = await expectToReject(client.transaction(async query => {
          await query(`CREATE INDEX CONCURRENTLY cib_plant_tag_ix ON ${TABLE} (tag)`);
        }));

        expect(sqlStateOf(error)).toBe('25001');
        expect(error.message).toBe('CREATE INDEX CONCURRENTLY cannot run inside a transaction block');
        expect(await indexState(client, 'cib_plant_tag_ix')).toBeNull();
      });
    });

    test('in a multi-statement query string (an implicit transaction block): 25001, no index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10)`);

        const error = await expectToReject(simpleQuery(client, `SELECT 1; CREATE INDEX CONCURRENTLY cib_plant_tag_ix ON ${TABLE} (tag)`));

        expect(sqlStateOf(error)).toBe('25001');
        expect(error.message).toBe('CREATE INDEX CONCURRENTLY cannot run inside a transaction block');
        expect(await indexState(client, 'cib_plant_tag_ix')).toBeNull();
      });
    });

    test('from a DO block: 25001 "cannot be executed from a function", no index', async () => {
      await withClient(async client => {
        await freshTable(client, `(1, 'rose', 1, 10)`);

        const error = await expectToReject(client.query(`DO $$ BEGIN CREATE INDEX CONCURRENTLY cib_plant_tag_ix ON ${TABLE} (tag); END $$`));

        expect(sqlStateOf(error)).toBe('25001');
        expect(error.message).toBe('CREATE INDEX CONCURRENTLY cannot be executed from a function');
        expect(await indexState(client, 'cib_plant_tag_ix')).toBeNull();
      });
    });

    test('on a partitioned table: 0A000, no index', async () => {
      await withClient(async client => {
        await client.query(`CREATE TABLE ${PARTITIONED} (id integer, row_no integer) PARTITION BY RANGE (row_no)`);

        const error = await expectToReject(client.query(`CREATE INDEX CONCURRENTLY cib_bed_id_ix ON ${PARTITIONED} (id)`));

        expect(sqlStateOf(error)).toBe('0A000');
        expect(error.message).toBe(`cannot create index on partitioned table "${PARTITIONED}" concurrently`);
        expect(await indexState(client, 'cib_bed_id_ix')).toBeNull();
      });
    });
  });
});

/** How many relations of this name exist (an index that a refused DROP must leave in place). */
async function relationCount(client: DatabaseClient, name: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_class WHERE relname = $1', [name]);

  return rows[0].n;
}

/** `cib_plant` with 150 bulk rows and two indexes built normally: the unique `cib_plant_tag_uq`, the plain `cib_plant_bed_ix`. */
async function plantWithIndexes(client: DatabaseClient): Promise<void> {
  await freshTable(client, `(1, 'rose', 1, 10), (2, 'fern', 2, 20)`);
  await seedBulk(client);
  await client.query(`CREATE UNIQUE INDEX cib_plant_tag_uq ON ${TABLE} (tag)`);
  await client.query(`CREATE INDEX cib_plant_bed_ix ON ${TABLE} (bed)`);
}

const flagIndex = (client: DatabaseClient, set: string, name = 'cib_plant_tag_uq') =>
  client.query(`UPDATE pg_index SET ${set} WHERE indexrelid = to_regclass($1)`, [name]);

describe('UPDATE pg_index writes the index state flags, as PostgreSQL lets a superuser', () => {
  test('SET indisvalid = false: UPDATE 1 — reads stop using the index, yet (still ready) it rejects a duplicate', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);
      const lookup = `SELECT id FROM ${TABLE} WHERE tag = 'fern'`;
      expect(await planWithoutSeqScan(client, lookup)).toContain('cib_plant_tag_uq');

      const result = await flagIndex(client, 'indisvalid = false');

      expect(result.rowCount).toBe(1);
      expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({
        valid: false,
        ready: true,
        def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)',
      });
      expect(await planWithoutSeqScan(client, lookup)).not.toContain('cib_plant_tag_uq');
      const duplicate = await expectToReject(client.query(`INSERT INTO ${TABLE} (id, tag, bed, height) VALUES (3, 'fern', 3, 30)`));
      expect(sqlStateOf(duplicate)).toBe('23505');
      expect(duplicate.message).toBe('duplicate key value violates unique constraint "cib_plant_tag_uq"');
    });
  });

  test('SET indisready = false as well: the index is no longer maintained, so a duplicate is accepted', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      await flagIndex(client, 'indisvalid = false, indisready = false');
      await client.query(`INSERT INTO ${TABLE} (id, tag, bed, height) VALUES (3, 'fern', 3, 30)`);

      expect((await indexState(client, 'cib_plant_tag_uq'))).toMatchObject({ valid: false, ready: false });
      expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE tag = 'fern'`)).rows).toEqual([{ n: 2 }]);
    });
  });

  test('SET indisvalid = true on an index that was only flagged: it is used and enforcing again', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);
      await flagIndex(client, 'indisvalid = false');

      const result = await flagIndex(client, 'indisvalid = true, indisready = true');

      expect(result.rowCount).toBe(1);
      expect(await indexState(client, 'cib_plant_tag_uq')).toMatchObject({ valid: true, ready: true });
      expect(await planWithoutSeqScan(client, `SELECT id FROM ${TABLE} WHERE tag = 'fern'`)).toContain('cib_plant_tag_uq');
    });
  });

  test('a WHERE matching no index updates nothing; one over a table\'s indexes updates each once', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const none = await client.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('cib_plant_missing_ix')`);
      const all = await client.query(`UPDATE pg_index SET indisready = true WHERE indrelid = to_regclass('${TABLE}')`);

      expect([none.rowCount, all.rowCount]).toEqual([0, 3]);
      const { rows } = await client.query(
        `SELECT c.relname AS name, x.indisvalid AS valid, x.indisready AS ready FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
          WHERE x.indrelid = to_regclass('${TABLE}') ORDER BY c.relname`
      );
      expect(rows).toEqual([
        { name: 'cib_plant_bed_ix', valid: true, ready: true },
        { name: 'cib_plant_pkey', valid: true, ready: true },
        { name: 'cib_plant_tag_uq', valid: true, ready: true },
      ]);
    });
  });

  test('RETURNING reads the row as written', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const { rows } = await client.query(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('cib_plant_bed_ix') RETURNING indexrelid::regclass::text AS name, indisvalid AS valid, indisready AS ready`
      );

      expect(rows).toEqual([{ name: 'cib_plant_bed_ix', valid: false, ready: true }]);
    });
  });

  test('FROM another catalog selects the index by name; each index row is written once', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const result = await client.query(
        `UPDATE pg_index x SET indisvalid = false FROM pg_class c, pg_class t
          WHERE c.oid = x.indexrelid AND c.relname = 'cib_plant_bed_ix' AND t.relname IN ('${TABLE}', 'cib_plant_tag_uq')`
      );

      expect(result.rowCount).toBe(1);
      expect((await indexState(client, 'cib_plant_bed_ix'))?.valid).toBe(false);
      expect((await indexState(client, 'cib_plant_tag_uq'))?.valid).toBe(true);
    });
  });

  test('a data-modifying CTE can write the flags', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const { rows } = await client.query(
        `WITH flagged AS (UPDATE pg_index SET indisvalid = false WHERE indrelid = to_regclass('${TABLE}') AND NOT indisprimary RETURNING indexrelid)
         SELECT count(*)::int AS n FROM flagged`
      );

      expect(rows).toEqual([{ n: 2 }]);
      expect([(await indexState(client, 'cib_plant_bed_ix'))?.valid, (await indexState(client, 'cib_plant_tag_uq'))?.valid]).toEqual([false, false]);
    });
  });

  test('the write is transactional: ROLLBACK restores the flags', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(client.transaction(async query => {
        await query(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = to_regclass('cib_plant_tag_uq')`);
        const { rows } = await query(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('cib_plant_tag_uq')`);
        expect(rows).toEqual([{ valid: false }]);
        throw new Error('roll it back');
      }), 'roll it back');

      expect(error.message).toBe('roll it back');
      expect(await indexState(client, 'cib_plant_tag_uq')).toMatchObject({ valid: true, ready: true });
    });
  });

  test('a NULL flag is refused: 23502, the flags stay', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(flagIndex(client, 'indisvalid = NULL'));

      expect(sqlStateOf(error)).toBe('23502');
      expect(error.message).toBe('null value in column "indisvalid" of relation "pg_index" violates not-null constraint');
      expect(await indexState(client, 'cib_plant_tag_uq')).toMatchObject({ valid: true, ready: true });
    });
  });

  test('SET … = DEFAULT is a NULL too (a catalog column has no default): 23502, the flags stay', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(flagIndex(client, 'indisready = DEFAULT'));

      expect(sqlStateOf(error)).toBe('23502');
      expect(error.message).toBe('null value in column "indisready" of relation "pg_index" violates not-null constraint');
      expect(await indexState(client, 'cib_plant_tag_uq')).toMatchObject({ valid: true, ready: true });
    });
  });

  test('a row assignment writes both flags at once', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const { rows } = await client.query(
        `UPDATE pg_index SET (indisvalid, indisready) = (false, false) WHERE indexrelid = to_regclass('cib_plant_tag_uq') RETURNING indisvalid AS valid, indisready AS ready`
      );

      expect(rows).toEqual([{ valid: false, ready: false }]);
      expect(await indexState(client, 'cib_plant_tag_uq')).toMatchObject({ valid: false, ready: false });
    });
  });

  test('TRUNCATE makes a non-unique index flagged not ready ready again; a unique one keeps its flags', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);
      await client.query(`UPDATE pg_index SET indisready = false WHERE indexrelid IN (to_regclass('cib_plant_bed_ix'), to_regclass('cib_plant_tag_uq'))`);

      await client.query(`TRUNCATE ${TABLE}`);

      expect(await indexState(client, 'cib_plant_bed_ix')).toEqual({ valid: true, ready: true, def: 'CREATE INDEX cib_plant_bed_ix ON cib_plant USING btree (bed)' });
      expect(await indexState(client, 'cib_plant_tag_uq')).toEqual({ valid: true, ready: false, def: 'CREATE UNIQUE INDEX cib_plant_tag_uq ON cib_plant USING btree (tag)' });
    });
  });

  test('in a read-only transaction: 25006, the flags stay', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(client.transaction(async query => {
        await query('SET TRANSACTION READ ONLY');
        await query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('cib_plant_tag_uq')`);
      }));

      expect(sqlStateOf(error)).toBe('25006');
      expect(error.message).toBe('cannot execute UPDATE in a read-only transaction');
      expect(await indexState(client, 'cib_plant_tag_uq')).toMatchObject({ valid: true, ready: true });
    });
  });
});

describe('DROP INDEX CONCURRENTLY is refused where PostgreSQL refuses it', () => {
  const partitionedIndex = async (client: DatabaseClient): Promise<void> => {
    await client.query(`CREATE TABLE ${PARTITIONED} (id integer, row_no integer) PARTITION BY RANGE (row_no)`);
    await client.query(`CREATE TABLE ${PARTITIONED}_1 PARTITION OF ${PARTITIONED} FOR VALUES FROM (0) TO (10)`);
    await client.query(`CREATE INDEX cib_bed_id_ix ON ${PARTITIONED} (id)`);
  };

  test('at top level it drops the index', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      await client.query('DROP INDEX CONCURRENTLY cib_plant_bed_ix');

      expect(await relationCount(client, 'cib_plant_bed_ix')).toBe(0);
    });
  });

  test('inside a transaction block: 25001, the index stays', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(client.transaction(async query => {
        await query('DROP INDEX CONCURRENTLY cib_plant_bed_ix');
      }));

      expect(sqlStateOf(error)).toBe('25001');
      expect(error.message).toBe('DROP INDEX CONCURRENTLY cannot run inside a transaction block');
      expect(await relationCount(client, 'cib_plant_bed_ix')).toBe(1);
    });
  });

  test('in a multi-statement query string: 25001, the index stays', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(simpleQuery(client, 'SELECT 1; DROP INDEX CONCURRENTLY cib_plant_bed_ix'));

      expect(sqlStateOf(error)).toBe('25001');
      expect(error.message).toBe('DROP INDEX CONCURRENTLY cannot run inside a transaction block');
      expect(await relationCount(client, 'cib_plant_bed_ix')).toBe(1);
    });
  });

  test('from a DO block: 25001 "cannot be executed from a function", the index stays', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(client.query('DO $$ BEGIN DROP INDEX CONCURRENTLY cib_plant_bed_ix; END $$'));

      expect(sqlStateOf(error)).toBe('25001');
      expect(error.message).toBe('DROP INDEX CONCURRENTLY cannot be executed from a function');
      expect(await relationCount(client, 'cib_plant_bed_ix')).toBe(1);
    });
  });

  test('from a DO block even IF EXISTS on a missing index: 25001 before the name is looked up', async () => {
    await withClient(async client => {
      const error = await expectToReject(client.query('DO $$ BEGIN DROP INDEX CONCURRENTLY IF EXISTS cib_plant_missing_ix; END $$'));

      expect(sqlStateOf(error)).toBe('25001');
      expect(error.message).toBe('DROP INDEX CONCURRENTLY cannot be executed from a function');
    });
  });

  test('on a partitioned index: 0A000, the index stays', async () => {
    await withClient(async client => {
      await partitionedIndex(client);

      const error = await expectToReject(client.query('DROP INDEX CONCURRENTLY cib_bed_id_ix'));

      expect(sqlStateOf(error)).toBe('0A000');
      expect(error.message).toBe('cannot drop partitioned index "cib_bed_id_ix" concurrently');
      expect(await relationCount(client, 'cib_bed_id_ix')).toBe(1);
    });
  });

  test('naming two indexes: 0A000, both stay', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(client.query('DROP INDEX CONCURRENTLY cib_plant_bed_ix, cib_plant_tag_uq'));

      expect(sqlStateOf(error)).toBe('0A000');
      expect(error.message).toBe('DROP INDEX CONCURRENTLY does not support dropping multiple objects');
      expect([await relationCount(client, 'cib_plant_bed_ix'), await relationCount(client, 'cib_plant_tag_uq')]).toEqual([1, 1]);
    });
  });

  test('with CASCADE: 0A000, the index stays', async () => {
    await withClient(async client => {
      await plantWithIndexes(client);

      const error = await expectToReject(client.query('DROP INDEX CONCURRENTLY cib_plant_bed_ix CASCADE'));

      expect(sqlStateOf(error)).toBe('0A000');
      expect(error.message).toBe('DROP INDEX CONCURRENTLY does not support CASCADE');
      expect(await relationCount(client, 'cib_plant_bed_ix')).toBe(1);
    });
  });
});

/** `cib_bed` partitioned by `row_no` into `cib_bed_1` (0–9) and `cib_bed_2` (10–19). */
async function bedWithTwoPartitions(client: DatabaseClient): Promise<void> {
  await client.query(`CREATE TABLE ${PARTITIONED} (id integer, row_no integer, label text) PARTITION BY RANGE (row_no)`);
  await client.query(`CREATE TABLE ${PARTITIONED}_1 PARTITION OF ${PARTITIONED} FOR VALUES FROM (0) TO (10)`);
  await client.query(`CREATE TABLE ${PARTITIONED}_2 PARTITION OF ${PARTITIONED} FOR VALUES FROM (10) TO (20)`);
}

interface IndexFlags {
  kind: string;
  valid: boolean;
  ready: boolean;
}

/** The kind of an index (`i`, or `I` for a partitioned one) and its state flags; null when it does not exist. */
async function flagsOf(client: DatabaseClient, name: string): Promise<IndexFlags | null> {
  const { rows } = await client.query<IndexFlags>(
    'SELECT c.relkind AS kind, x.indisvalid AS valid, x.indisready AS ready FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid WHERE c.relname = $1',
    [name]
  );

  return rows[0] ?? null;
}

/** The indexes attached to a partitioned index (its pg_inherits children), by name. */
async function attachedTo(client: DatabaseClient, name: string): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    'SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = to_regclass($1) ORDER BY 1',
    [name]
  );

  return rows.map(r => r.name);
}

describe('a partitioned index built ON ONLY, then attached partition by partition (PostgreSQL\'s online procedure)', () => {
  test('ON ONLY leaves it INVALID but ready; it turns valid once every partition has an attached valid index', async () => {
    await withClient(async client => {
      await bedWithTwoPartitions(client);

      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);
      const afterOnly = await flagsOf(client, 'cib_bed_id_ix');
      await client.query(`CREATE INDEX CONCURRENTLY cib_bed_1_id_ix ON ${PARTITIONED}_1 (id)`);
      await client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_1_id_ix');
      const afterFirst = await flagsOf(client, 'cib_bed_id_ix');
      const attachedFirst = await attachedTo(client, 'cib_bed_id_ix');
      await client.query(`CREATE INDEX cib_bed_2_id_ix ON ${PARTITIONED}_2 (id)`);
      await client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_2_id_ix');

      expect(afterOnly).toEqual({ kind: 'I', valid: false, ready: true });
      expect(afterFirst).toEqual({ kind: 'I', valid: false, ready: true });
      expect(attachedFirst).toEqual(['cib_bed_1_id_ix']);
      expect(await flagsOf(client, 'cib_bed_id_ix')).toEqual({ kind: 'I', valid: true, ready: true });
      expect(await attachedTo(client, 'cib_bed_id_ix')).toEqual(['cib_bed_1_id_ix', 'cib_bed_2_id_ix']);
    });
  });

  test('attaching an index that is already attached succeeds and changes nothing', async () => {
    await withClient(async client => {
      await bedWithTwoPartitions(client);
      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);
      await client.query(`CREATE INDEX cib_bed_1_id_ix ON ${PARTITIONED}_1 (id)`);
      await client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_1_id_ix');

      await client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_1_id_ix');

      expect(await attachedTo(client, 'cib_bed_id_ix')).toEqual(['cib_bed_1_id_ix']);
      expect(await flagsOf(client, 'cib_bed_id_ix')).toEqual({ kind: 'I', valid: false, ready: true });
    });
  });

  test('ON ONLY over a partitioned table without partitions: valid at once', async () => {
    await withClient(async client => {
      await client.query(`CREATE TABLE ${PARTITIONED} (id integer, row_no integer) PARTITION BY RANGE (row_no)`);

      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);

      expect(await flagsOf(client, 'cib_bed_id_ix')).toEqual({ kind: 'I', valid: true, ready: true });
    });
  });

  test('an index of a table that is not one of the partitions cannot be attached: 55000', async () => {
    await withClient(async client => {
      await bedWithTwoPartitions(client);
      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);
      await client.query('CREATE TABLE cib_loose (id integer)');
      await client.query('CREATE INDEX cib_loose_id_ix ON cib_loose (id)');

      const error = await expectToReject(client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_loose_id_ix'));

      expect([sqlStateOf(error), error.message, error.detail]).toEqual([
        '55000',
        'cannot attach index "cib_loose_id_ix" as a partition of index "cib_bed_id_ix"',
        'Index "cib_loose_id_ix" is not an index on any partition of table "cib_bed".',
      ]);
      expect(await attachedTo(client, 'cib_bed_id_ix')).toEqual([]);
    });
  });

  test('an index whose definition differs cannot be attached: 42P17', async () => {
    await withClient(async client => {
      await bedWithTwoPartitions(client);
      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);
      await client.query(`CREATE INDEX cib_bed_2_label_ix ON ${PARTITIONED}_2 (label)`);

      const error = await expectToReject(client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_2_label_ix'));

      expect([sqlStateOf(error), error.message, error.detail]).toEqual([
        '42P17',
        'cannot attach index "cib_bed_2_label_ix" as a partition of index "cib_bed_id_ix"',
        'The index definitions do not match.',
      ]);
      expect(await attachedTo(client, 'cib_bed_id_ix')).toEqual([]);
    });
  });

  test('an attached index cannot be dropped on its own: 2BP01, with the hint to drop the partitioned one', async () => {
    await withClient(async client => {
      await bedWithTwoPartitions(client);
      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);
      await client.query(`CREATE INDEX cib_bed_1_id_ix ON ${PARTITIONED}_1 (id)`);
      await client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_1_id_ix');

      const error = await expectToReject(client.query('DROP INDEX cib_bed_1_id_ix'));

      expect([sqlStateOf(error), error.message, error.hint]).toEqual([
        '2BP01',
        'cannot drop index cib_bed_1_id_ix because index cib_bed_id_ix requires it',
        'You can drop index cib_bed_id_ix instead.',
      ]);
      expect(await attachedTo(client, 'cib_bed_id_ix')).toEqual(['cib_bed_1_id_ix']);
    });
  });

  test('dropping the partitioned index drops the indexes attached to it', async () => {
    await withClient(async client => {
      await bedWithTwoPartitions(client);
      await client.query(`CREATE INDEX cib_bed_id_ix ON ONLY ${PARTITIONED} (id)`);
      await client.query(`CREATE INDEX cib_bed_1_id_ix ON ${PARTITIONED}_1 (id)`);
      await client.query('ALTER INDEX cib_bed_id_ix ATTACH PARTITION cib_bed_1_id_ix');

      await client.query('DROP INDEX cib_bed_id_ix');

      expect([await relationCount(client, 'cib_bed_id_ix'), await relationCount(client, 'cib_bed_1_id_ix')]).toEqual([0, 0]);
    });
  });
});

describe('an index build evaluates what PostgreSQL evaluates, and no more', () => {
  test('an index on an INHERITS parent reads the parent\'s own rows: a child\'s row the expression fails on is not evaluated', async () => {
    await withClient(async client => {
      await client.query(`CREATE TABLE ${CROP} (id integer, n integer)`);
      await client.query(`CREATE TABLE ${CROP}_kid () INHERITS (${CROP})`);
      await client.query(`INSERT INTO ${CROP} VALUES (1, 2)`);
      await client.query(`INSERT INTO ${CROP}_kid VALUES (2, 0)`);

      await client.query(`CREATE INDEX cib_crop_ratio_ix ON ${CROP} ((100 / n))`);

      expect(await flagsOf(client, 'cib_crop_ratio_ix')).toEqual({ kind: 'i', valid: true, ready: true });
    });
  });

  test('a unique index on an INHERITS parent ignores a child\'s row with the same key, and enforces its own rows', async () => {
    await withClient(async client => {
      await client.query(`CREATE TABLE ${CROP} (id integer, n integer)`);
      await client.query(`CREATE TABLE ${CROP}_kid () INHERITS (${CROP})`);
      await client.query(`INSERT INTO ${CROP} VALUES (5, 7)`);
      await client.query(`INSERT INTO ${CROP}_kid VALUES (5, 7)`);

      await client.query(`CREATE UNIQUE INDEX cib_crop_id_uq ON ${CROP} (id)`);
      const duplicate = await expectToReject(client.query(`INSERT INTO ${CROP} VALUES (5, 1)`));

      expect(await flagsOf(client, 'cib_crop_id_uq')).toEqual({ kind: 'i', valid: true, ready: true });
      expect([sqlStateOf(duplicate), duplicate.message]).toEqual(['23505', 'duplicate key value violates unique constraint "cib_crop_id_uq"']);
    });
  });

  test('indexes over to_tsvector build over existing rows, btree and GIN', async () => {
    await withClient(async client => {
      await client.query(`CREATE TABLE ${NOTE} (id integer, body text)`);
      await client.query(`INSERT INTO ${NOTE} VALUES (1, 'the quick brown fox'), (2, 'lazy dogs')`);

      await client.query(`CREATE INDEX cib_note_tsv_ix ON ${NOTE} ((to_tsvector('simple', body)))`);
      await client.query(`CREATE INDEX cib_note_tsv_gin ON ${NOTE} USING gin (to_tsvector('english', body))`);

      expect([await flagsOf(client, 'cib_note_tsv_ix'), await flagsOf(client, 'cib_note_tsv_gin')]).toEqual([
        { kind: 'i', valid: true, ready: true },
        { kind: 'i', valid: true, ready: true },
      ]);
    });
  });

  test('a GIN over to_tsvector built CONCURRENTLY over existing rows ends valid', async () => {
    await withClient(async client => {
      await client.query(`CREATE TABLE ${NOTE} (id integer, body text)`);
      await client.query(`INSERT INTO ${NOTE} VALUES (1, 'the quick brown fox'), (2, 'lazy dogs')`);

      await client.query(`CREATE INDEX CONCURRENTLY cib_note_tsv_gin ON ${NOTE} USING gin (to_tsvector('english', body))`);

      expect(await flagsOf(client, 'cib_note_tsv_gin')).toEqual({ kind: 'i', valid: true, ready: true });
    });
  });
});
