import { describe, test, expect, beforeEach } from '@jest/globals';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, timestamp } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { buildPartitionByClause } from '../../src/migration/partition-sql';

/**
 * End-to-end coverage for the `.hasPartitioning()` model API against real
 * PostgreSQL: the builder must produce a genuine partitioned (parent) table with
 * the right `PARTITION BY <strategy> (<key>)`, for RANGE / LIST / HASH, column-
 * and expression-based keys, and must reject a PK that omits a partition column.
 */

/** `pg_get_partkeydef` returns e.g. `RANGE (bucket)` for a partitioned table, NULL otherwise. */
async function partKeyDef(client: any, table: string): Promise<string | null> {
  const res = await client.query(`SELECT pg_get_partkeydef(to_regclass($1)) AS def`, [table]);
  return res.rows[0]?.def ?? null;
}

/** `relkind` is 'p' for a partitioned table, 'r' for a plain table. */
async function relkind(client: any, table: string): Promise<string | null> {
  const res = await client.query(`SELECT relkind FROM pg_class WHERE relname = $1`, [table]);
  return res.rows[0]?.relkind ?? null;
}

async function drop(client: any, table: string): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
}

describe('hasPartitioning() — buildPartitionByClause unit', () => {
  test('column-based clause quotes columns and upper-cases the strategy', () => {
    expect(buildPartitionByClause({ strategy: 'range', columns: ['created_at'] }))
      .toBe('PARTITION BY RANGE ("created_at")');
    expect(buildPartitionByClause({ strategy: 'list', columns: ['region'] }))
      .toBe('PARTITION BY LIST ("region")');
    expect(buildPartitionByClause({ strategy: 'hash', columns: ['tenant_id', 'id'] }))
      .toBe('PARTITION BY HASH ("tenant_id", "id")');
  });

  test('expression-based clause emits the raw expression unquoted', () => {
    expect(buildPartitionByClause({ strategy: 'range', expression: "date_trunc('month', created_at)" }))
      .toBe("PARTITION BY RANGE (date_trunc('month', created_at))");
  });
});

describe('hasPartitioning() — end-to-end against PostgreSQL', () => {
  beforeEach(() => { (EntityMetadataStore as any).metadata.clear(); });

  test('RANGE column-based creates a partitioned table that accepts rows via a child partition', async () => {
    const TABLE = 'part_range_test';
    class RangeRow extends DbEntity { id!: DbColumn<number>; bucket!: DbColumn<number>; payload!: DbColumn<string>; }
    class RangeDb extends DbContext {
      get rows(): DbEntityTable<RangeRow> { return this.table(RangeRow); }
      protected override setupModel(model: DbModelConfig): void {
        model.entity(RangeRow, e => {
          e.toTable(TABLE);
          e.property(r => r.id).hasType(integer('id').primaryKey());
          e.property(r => r.bucket).hasType(integer('bucket').primaryKey()); // in PK (required)
          e.property(r => r.payload).hasType(varchar('payload', 200));
          e.hasPartitioning({ strategy: 'range', columns: r => r.bucket });
        });
      }
    }

    const client = createFreshClient();
    const db = new RangeDb(client);
    try {
      await drop(client, TABLE);
      await db.getSchemaManager().ensureCreated();

      expect(await relkind(client, TABLE)).toBe('p');             // partitioned table
      expect(await partKeyDef(client, TABLE)).toBe('RANGE (bucket)');

      // A child partition + insert proves the partitioning is functional.
      await client.query(`CREATE TABLE ${TABLE}_p0 PARTITION OF ${TABLE} FOR VALUES FROM (0) TO (100)`);
      await client.query(`INSERT INTO ${TABLE} (id, bucket, payload) VALUES (1, 50, 'hello')`);
      const got = await client.query(`SELECT payload FROM ${TABLE} WHERE bucket = 50`);
      expect(got.rows[0].payload).toBe('hello');
    } finally {
      await drop(client, TABLE);
      await db.dispose();
    }
  });

  test('LIST column-based and HASH column-based produce the right PARTITION BY', async () => {
    const LIST_TABLE = 'part_list_test';
    const HASH_TABLE = 'part_hash_test';
    class ListRow extends DbEntity { id!: DbColumn<number>; regionId!: DbColumn<number>; }
    class HashRow extends DbEntity { id!: DbColumn<number>; tenantId!: DbColumn<number>; }
    class MultiDb extends DbContext {
      get lists(): DbEntityTable<ListRow> { return this.table(ListRow); }
      get hashes(): DbEntityTable<HashRow> { return this.table(HashRow); }
      protected override setupModel(model: DbModelConfig): void {
        model.entity(ListRow, e => {
          e.toTable(LIST_TABLE);
          e.property(r => r.id).hasType(integer('id').primaryKey());
          e.property(r => r.regionId).hasType(integer('region_id').primaryKey());
          e.hasPartitioning({ strategy: 'list', columns: r => [r.regionId] });
        });
        model.entity(HashRow, e => {
          e.toTable(HASH_TABLE);
          e.property(r => r.id).hasType(integer('id').primaryKey());
          e.property(r => r.tenantId).hasType(integer('tenant_id').primaryKey());
          e.hasPartitioning({ strategy: 'hash', columns: r => r.tenantId });
        });
      }
    }

    const client = createFreshClient();
    const db = new MultiDb(client);
    try {
      await drop(client, LIST_TABLE);
      await drop(client, HASH_TABLE);
      await db.getSchemaManager().ensureCreated();

      expect(await partKeyDef(client, LIST_TABLE)).toBe('LIST (region_id)');
      expect(await partKeyDef(client, HASH_TABLE)).toBe('HASH (tenant_id)');
    } finally {
      await drop(client, LIST_TABLE);
      await drop(client, HASH_TABLE);
      await db.dispose();
    }
  });

  test('custom expression overload partitions by a function of a column (no PK)', async () => {
    const TABLE = 'part_expr_test';
    // Expression partitioning cannot carry a PRIMARY KEY, so this entity has none.
    class ExprRow extends DbEntity { id!: DbColumn<number>; createdAt!: DbColumn<Date>; }
    class ExprDb extends DbContext {
      get rows(): DbEntityTable<ExprRow> { return this.table(ExprRow); }
      protected override setupModel(model: DbModelConfig): void {
        model.entity(ExprRow, e => {
          e.toTable(TABLE);
          e.property(r => r.id).hasType(integer('id'));
          e.property(r => r.createdAt).hasType(timestamp('created_at'));
          e.hasPartitioning({ strategy: 'range', expression: "date_trunc('month', created_at)" });
        });
      }
    }

    const client = createFreshClient();
    const db = new ExprDb(client);
    try {
      await drop(client, TABLE);
      await db.getSchemaManager().ensureCreated();

      expect(await relkind(client, TABLE)).toBe('p');
      const def = await partKeyDef(client, TABLE);
      expect(def).toMatch(/^RANGE \(date_trunc\(/);
      expect(def).toContain('created_at');
    } finally {
      await drop(client, TABLE);
      await db.dispose();
    }
  });

  test('throws a descriptive error when the PRIMARY KEY omits a partition column', async () => {
    const TABLE = 'part_badpk_test';
    class BadRow extends DbEntity { id!: DbColumn<number>; bucket!: DbColumn<number>; }
    class BadDb extends DbContext {
      get rows(): DbEntityTable<BadRow> { return this.table(BadRow); }
      protected override setupModel(model: DbModelConfig): void {
        model.entity(BadRow, e => {
          e.toTable(TABLE);
          e.property(r => r.id).hasType(integer('id').primaryKey());     // PK is id only...
          e.property(r => r.bucket).hasType(integer('bucket'));          // ...but bucket is the partition key
          e.hasPartitioning({ strategy: 'range', columns: r => r.bucket });
        });
      }
    }

    const client = createFreshClient();
    const db = new BadDb(client);
    try {
      await drop(client, TABLE);
      await expectToReject(db.getSchemaManager().ensureCreated(),
        /partition-key column.*"bucket"|"bucket".*PRIMARY KEY/i);
    } finally {
      await drop(client, TABLE);
      await db.dispose();
    }
  });
});
