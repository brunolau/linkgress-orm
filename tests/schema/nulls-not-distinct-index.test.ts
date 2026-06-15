import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { MigrationOperation } from '../../src/migration/db-schema-manager';

/**
 * End-to-end coverage for the opt-in `.nullsNotDistinct()` index API against a
 * real PostgreSQL (15+): the builder must produce a genuine `NULLS NOT DISTINCT`
 * unique index, PostgreSQL must enforce NULLs-as-equal, and the auto-migration
 * reconciler must treat declared-NND vs live-NND as unchanged (no churn) while a
 * DISTINCT <-> NND mismatch is detected and recreated.
 */

const TABLE = 'nnd_idx_test';
const INDEX = 'uq_nnd_ref';

// `external_ref` is intentionally left nullable (no .isRequired()) so the
// NULL-as-equal semantics of NULLS NOT DISTINCT can be exercised directly.
function defineColumns(entity: any): void {
  entity.toTable(TABLE);
  entity.property((e: any) => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${TABLE}_id_seq` }));
  entity.property((e: any) => e.externalRef).hasType(varchar('external_ref', 100));
}

// Distinct entity classes per index signature — the global EntityMetadataStore
// is keyed by class, so reusing one class across model versions would accumulate
// indexes. Both classes map to the SAME physical table / column.
class NndRow extends DbEntity { id!: DbColumn<number>; externalRef!: DbColumn<string>; }
class DistinctRow extends DbEntity { id!: DbColumn<number>; externalRef!: DbColumn<string>; }

// Unique index WITH the opt-in NULLS NOT DISTINCT clause.
class NndDb extends DbContext {
  get rows(): DbEntityTable<NndRow> { return this.table(NndRow); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(NndRow, e => {
      defineColumns(e);
      e.hasIndex(INDEX, (r: NndRow) => [r.externalRef]).isUnique().nullsNotDistinct();
    });
  }
}

// SAME index name, plain UNIQUE (DISTINCT — PostgreSQL's default NULL handling).
class DistinctDb extends DbContext {
  get rows(): DbEntityTable<DistinctRow> { return this.table(DistinctRow); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(DistinctRow, e => {
      defineColumns(e);
      e.hasIndex(INDEX, (r: DistinctRow) => [r.externalRef]).isUnique();
    });
  }
}

function indexOps(ops: MigrationOperation[]): MigrationOperation[] {
  return ops.filter(o => o.type === 'create_index' || o.type === 'recreate_index' || o.type === 'drop_index');
}

// PostgreSQL 15+ records the flag on pg_index.indnullsnotdistinct.
async function nullsNotDistinctStored(client: any): Promise<boolean> {
  const res = await client.query(
    `SELECT ix.indnullsnotdistinct AS nnd
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     WHERE i.relname = $1`,
    [INDEX]
  );
  return res.rows[0]?.nnd === true;
}

async function indexDef(client: any): Promise<string | null> {
  const res = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
    [TABLE, INDEX]
  );
  return res.rows.length ? res.rows[0].indexdef : null;
}

describe('NULLS NOT DISTINCT unique index (end-to-end)', () => {
  beforeEach(() => { (EntityMetadataStore as any).metadata.clear(); });

  test('.isUnique().nullsNotDistinct() creates a real NULLS NOT DISTINCT unique index', async () => {
    const client = createFreshClient();
    const db = new NndDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const def = await indexDef(client);
      expect(def).toContain('UNIQUE');
      expect(def).toContain('NULLS NOT DISTINCT');
      expect(await nullsNotDistinctStored(client)).toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('enforces NULLs-as-equal: a second NULL row is rejected', async () => {
    const client = createFreshClient();
    const db = new NndDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();

      // First NULL row is fine; the second collides because NULLs compare equal
      // under NULLS NOT DISTINCT (a plain UNIQUE index would allow both).
      await client.query(`INSERT INTO ${TABLE} (external_ref) VALUES (NULL)`);
      await expect(
        client.query(`INSERT INTO ${TABLE} (external_ref) VALUES (NULL)`)
      ).rejects.toThrow(/duplicate key|unique constraint|violates unique/i);

      // A distinct non-null value still inserts fine.
      await client.query(`INSERT INTO ${TABLE} (external_ref) VALUES ('abc')`);
      const count = await client.query(`SELECT count(*)::int AS c FROM ${TABLE}`);
      expect(count.rows[0].c).toBe(2);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('does NOT churn an unchanged NULLS NOT DISTINCT index (declared NND vs live NND)', async () => {
    const client = createFreshClient();
    const db = new NndDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();
      expect(await nullsNotDistinctStored(client)).toBe(true);

      // Re-analyzing the identical model proposes no index work...
      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
      // ...and it stays converged across an explicit migrate().
      await db.getSchemaManager().migrate();
      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('detects DISTINCT -> NULLS NOT DISTINCT, recreates, and converges', async () => {
    const clientV1 = createFreshClient();
    const v1 = new DistinctDb(clientV1);
    let v2: NndDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      expect(await indexDef(clientV1)).not.toContain('NULLS NOT DISTINCT');
      expect(await nullsNotDistinctStored(clientV1)).toBe(false);
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new NndDb(clientV2);

      const ops = await v2.getSchemaManager().analyze();
      const recreate = ops.find(o => o.type === 'recreate_index');
      expect(recreate).toBeDefined();
      expect((recreate as any).indexName).toBe(INDEX);
      expect((recreate as any).reason).toMatch(/nulls not distinct/i);

      await v2.getSchemaManager().migrate();
      expect(await nullsNotDistinctStored(clientV2)).toBe(true);
      // Re-analyzing after the recreate is a no-op (convergence, no churn).
      expect(indexOps(await v2.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  test('detects NULLS NOT DISTINCT -> DISTINCT (live NND is parsed, not silently ignored)', async () => {
    // Without the parse fix the live NND definition collapsed to null and this
    // real difference was invisible (changed=false => no recreate planned).
    const clientV1 = createFreshClient();
    const v1 = new NndDb(clientV1);
    let v2: DistinctDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      expect(await nullsNotDistinctStored(clientV1)).toBe(true);
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new DistinctDb(clientV2);

      const ops = await v2.getSchemaManager().analyze();
      const recreate = ops.find(o => o.type === 'recreate_index');
      expect(recreate).toBeDefined();
      expect((recreate as any).reason).toMatch(/nulls not distinct/i);

      await v2.getSchemaManager().migrate();
      expect(await nullsNotDistinctStored(clientV2)).toBe(false);
      expect(await indexDef(clientV2)).not.toContain('NULLS NOT DISTINCT');
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });
});
