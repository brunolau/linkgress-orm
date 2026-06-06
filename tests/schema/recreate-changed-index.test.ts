import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn,
  integer, varchar, boolean as boolColumn, timestamptz, ixNormalized,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { MigrationOperation } from '../../src/migration/db-schema-manager';

const TABLE = 'recreate_idx_users';

class IdxUser extends DbEntity {
  id!: DbColumn<number>;
  email!: DbColumn<string>;
  hash!: DbColumn<string>;
  username!: DbColumn<string>;
  active!: DbColumn<boolean>;
}

// Distinct entity classes are used per index signature so the global
// EntityMetadataStore (keyed by class) doesn't accumulate indexes across the two
// model versions — both still map to the SAME physical table.
function defineColumns(entity: any): void {
  entity.toTable(TABLE);
  entity.property((e: IdxUser) => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${TABLE}_id_seq` }));
  entity.property((e: IdxUser) => e.email).hasType(varchar('email', 255)).isRequired();
  entity.property((e: IdxUser) => e.hash).hasType(varchar('hash', 64)).isRequired();
  entity.property((e: IdxUser) => e.username).hasType(varchar('username', 200)).isRequired();
  entity.property((e: IdxUser) => e.active).hasType(boolColumn('active')).isRequired();
  // Extra columns used by the partial-predicate confirmation tests below.
  entity.property((e: any) => e.age).hasType(integer('age'));
  entity.property((e: any) => e.createdAt).hasType(timestamptz('created_at'));
}

// ---- Model versions, all sharing TABLE / columns, differing only by index ----

class PlainUsernameV1 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class GinUsernameV2 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class UniqueEmailV1 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class PlainEmailV2 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class NormEmailModel extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }

// v1: plain btree index on username
class PlainUsernameDb extends DbContext {
  get users(): DbEntityTable<PlainUsernameV1> { return this.table(PlainUsernameV1); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PlainUsernameV1, e => { defineColumns(e); e.hasIndex('ix_sig', (u: IdxUser) => [u.username]); });
  }
}
// v2: SAME index name, now a trigram-GIN normalized index
class GinUsernameDb extends DbContext {
  get users(): DbEntityTable<GinUsernameV2> { return this.table(GinUsernameV2); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(GinUsernameV2, e => { defineColumns(e); e.hasIndex('ix_sig', (u: IdxUser) => [ixNormalized(u.username, { gin: true })]); });
  }
}
// v1: UNIQUE index on email
class UniqueEmailDb extends DbContext {
  get users(): DbEntityTable<UniqueEmailV1> { return this.table(UniqueEmailV1); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(UniqueEmailV1, e => { defineColumns(e); e.hasIndex('ix_email', (u: IdxUser) => [u.email]).isUnique(); });
  }
}
// v2: SAME index name, no longer unique
class PlainEmailDb extends DbContext {
  get users(): DbEntityTable<PlainEmailV2> { return this.table(PlainEmailV2); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PlainEmailV2, e => { defineColumns(e); e.hasIndex('ix_email', (u: IdxUser) => [u.email]); });
  }
}
// The critical no-churn case: ixNormalized on a VARCHAR column (PG injects ::text)
class NormEmailDb extends DbContext {
  get users(): DbEntityTable<NormEmailModel> { return this.table(NormEmailModel); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(NormEmailModel, e => {
      defineColumns(e);
      e.hasIndex('ix_email_norm', (u: IdxUser) => [ixNormalized(u.email), u.hash]).isUnique();
    });
  }
}

// ---- Partial-index (WHERE) model versions, same TABLE / columns / index name --
class PartialV1 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class PartialV2 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class PartialV3 extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }

// partial index: WHERE active = true
class PartialActiveDb extends DbContext {
  get users(): DbEntityTable<PartialV1> { return this.table(PartialV1); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PartialV1, e => { defineColumns(e); e.hasIndex('ix_partial', (u: IdxUser) => [u.email]).where('active = true'); });
  }
}
// same index name, predicate flipped to WHERE active = false
class PartialInactiveDb extends DbContext {
  get users(): DbEntityTable<PartialV2> { return this.table(PartialV2); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PartialV2, e => { defineColumns(e); e.hasIndex('ix_partial', (u: IdxUser) => [u.email]).where('active = false'); });
  }
}
// same index name, no predicate at all (full index)
class PartialNoneDb extends DbContext {
  get users(): DbEntityTable<PartialV3> { return this.table(PartialV3); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PartialV3, e => { defineColumns(e); e.hasIndex('ix_partial', (u: IdxUser) => [u.email]); });
  }
}

// Predicates PostgreSQL rewrites in ways text normalization can't reverse, used
// to prove the authoritative (Tier-2) confirmation prevents churn end-to-end.
class TsPartialV extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }
class ParenPartialV extends DbEntity { id!: DbColumn<number>; email!: DbColumn<string>; hash!: DbColumn<string>; username!: DbColumn<string>; active!: DbColumn<boolean>; }

// bare date literal -> PG expands to a fully-qualified timestamptz
class TimestampPartialDb extends DbContext {
  get users(): DbEntityTable<TsPartialV> { return this.table(TsPartialV); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(TsPartialV, e => { defineColumns(e); e.hasIndex('ix_ts', (u: IdxUser) => [u.email]).where("created_at > '2020-01-01'"); });
  }
}
// arithmetic -> PG re-parenthesizes to (age + id) > 5
class ParenPartialDb extends DbContext {
  get users(): DbEntityTable<ParenPartialV> { return this.table(ParenPartialV); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(ParenPartialV, e => { defineColumns(e); e.hasIndex('ix_paren', (u: IdxUser) => [u.email]).where('age + id > 5'); });
  }
}

function indexOps(ops: MigrationOperation[]): MigrationOperation[] {
  return ops.filter(o => o.type === 'create_index' || o.type === 'recreate_index' || o.type === 'drop_index');
}

async function indexDef(client: any, indexName: string): Promise<string | null> {
  const res = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
    [TABLE, indexName]
  );
  return res.rows.length ? res.rows[0].indexdef : null;
}

async function indexOid(client: any, indexName: string): Promise<number | null> {
  const res = await client.query(`SELECT to_regclass($1)::oid::int AS oid`, [indexName]);
  return res.rows[0].oid;
}

describe('recreate changed indexes (auto-migration)', () => {
  beforeEach(() => { (EntityMetadataStore as any).metadata.clear(); });

  test('does NOT recreate an unchanged ixNormalized index on a varchar column', async () => {
    // This is the case the comparison must get exactly right: PostgreSQL stores
    // search_normalize(email::text) while the model emits search_normalize("email").
    const client = createFreshClient();
    const db = new NormEmailDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();

      // Re-analyzing the exact same model must produce no index work at all.
      const ops = await db.getSchemaManager().analyze();
      expect(indexOps(ops)).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('detects + applies an operator-class/method change (plain btree -> gin trgm), then converges', async () => {
    const clientV1 = createFreshClient();
    const v1 = new PlainUsernameDb(clientV1);
    let v2: GinUsernameDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();

      const beforeDef = await indexDef(clientV1, 'ix_sig');
      expect(beforeDef).toContain('USING btree');
      expect(beforeDef).not.toContain('gin');
      const beforeOid = await indexOid(clientV1, 'ix_sig');
      await v1.dispose();

      // Switch the model to the GIN-normalized signature under the same name.
      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new GinUsernameDb(clientV2);

      const plannedOps = await v2.getSchemaManager().analyze();
      const recreate = plannedOps.find(o => o.type === 'recreate_index');
      expect(recreate).toBeDefined();
      expect((recreate as any).indexName).toBe('ix_sig');
      expect((recreate as any).reason).toMatch(/method|columns/);

      await v2.getSchemaManager().migrate();

      const afterDef = await indexDef(clientV2, 'ix_sig');
      expect(afterDef).toContain('USING gin');
      expect(afterDef).toContain('gin_trgm_ops');
      expect(afterDef).toContain('search_normalize');
      const afterOid = await indexOid(clientV2, 'ix_sig');
      expect(afterOid).not.toBe(beforeOid); // genuinely dropped + recreated

      // Re-analyzing after the recreate must be a no-op (convergence, no churn).
      const settledOps = await v2.getSchemaManager().analyze();
      expect(indexOps(settledOps)).toHaveLength(0);
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  test('detects a uniqueness change', async () => {
    const clientV1 = createFreshClient();
    const v1 = new UniqueEmailDb(clientV1);
    let v2: PlainEmailDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      expect(await indexDef(clientV1, 'ix_email')).toContain('UNIQUE');
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new PlainEmailDb(clientV2);

      const ops = await v2.getSchemaManager().analyze();
      const recreate = ops.find(o => o.type === 'recreate_index');
      expect(recreate).toBeDefined();
      expect((recreate as any).reason).toMatch(/unique/);

      await v2.getSchemaManager().migrate();
      expect(await indexDef(clientV2, 'ix_email')).not.toContain('UNIQUE');
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  test('recreateChangedIndexes: false keeps the legacy name-only behavior', async () => {
    const clientV1 = createFreshClient();
    const v1 = new UniqueEmailDb(clientV1);
    let v2: PlainEmailDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new PlainEmailDb(clientV2);

      const ops = await v2.getSchemaManager({ recreateChangedIndexes: false }).analyze();
      expect(ops.find(o => o.type === 'recreate_index')).toBeUndefined();
      // The index is left exactly as it was — still UNIQUE.
      expect(await indexDef(clientV2, 'ix_email')).toContain('UNIQUE');
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  // ---- Partial-index WHERE predicate ----------------------------------------

  test('does NOT churn an unchanged partial index (WHERE active = true)', async () => {
    const client = createFreshClient();
    const db = new PartialActiveDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();
      expect(await indexDef(client, 'ix_partial')).toMatch(/WHERE .*active/i);

      const ops = await db.getSchemaManager().analyze();
      expect(indexOps(ops)).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('detects + applies a changed partial predicate (active=true -> active=false), then converges', async () => {
    const clientV1 = createFreshClient();
    const v1 = new PartialActiveDb(clientV1);
    let v2: PartialInactiveDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new PartialInactiveDb(clientV2);

      const ops = await v2.getSchemaManager().analyze();
      const recreate = ops.find(o => o.type === 'recreate_index');
      expect(recreate).toBeDefined();
      expect((recreate as any).reason).toMatch(/where/);

      await v2.getSchemaManager().migrate();
      const def = await indexDef(clientV2, 'ix_partial');
      expect(def).toMatch(/active = false/i);

      // Converges — re-analyzing the applied model is a no-op.
      expect(indexOps(await v2.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  test('detects adding a partial predicate to a previously-full index', async () => {
    const clientV1 = createFreshClient();
    const v1 = new PartialNoneDb(clientV1);
    let v2: PartialActiveDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      expect(await indexDef(clientV1, 'ix_partial')).not.toMatch(/WHERE/i);
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new PartialActiveDb(clientV2);

      const ops = await v2.getSchemaManager().analyze();
      expect(ops.find(o => o.type === 'recreate_index')).toBeDefined();

      await v2.getSchemaManager().migrate();
      expect(await indexDef(clientV2, 'ix_partial')).toMatch(/WHERE .*active/i);
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  test('detects removing a partial predicate', async () => {
    const clientV1 = createFreshClient();
    const v1 = new PartialActiveDb(clientV1);
    let v2: PartialNoneDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new PartialNoneDb(clientV2);

      const ops = await v2.getSchemaManager().analyze();
      expect(ops.find(o => o.type === 'recreate_index')).toBeDefined();

      await v2.getSchemaManager().migrate();
      expect(await indexDef(clientV2, 'ix_partial')).not.toMatch(/WHERE/i);
    } finally {
      if (v2) await v2.dispose();
      const c = createFreshClient();
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await c.end();
    }
  });

  // ---- Bulletproof: predicates PostgreSQL rewrites must NOT churn -------------
  // The model SQL differs textually from what PostgreSQL stores, so the fast
  // string compare flags a difference — but the Tier-2 canonical confirmation
  // recognizes the definitions as equivalent and suppresses the rebuild.

  test('does NOT churn a partial index with a bare timestamp literal (PG expands it)', async () => {
    const client = createFreshClient();
    const db = new TimestampPartialDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();
      // PostgreSQL stored a fully-qualified timestamptz, unlike the model string.
      expect(await indexDef(client, 'ix_ts')).toMatch(/00:00:00/);

      // Run twice — neither run may propose a rebuild.
      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
      await db.getSchemaManager().migrate();
      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('does NOT churn a partial index that PostgreSQL re-parenthesizes', async () => {
    const client = createFreshClient();
    const db = new ParenPartialDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();
      // PostgreSQL stored "(age + id) > 5" — parenthesized, unlike the model string.
      expect(await indexDef(client, 'ix_paren')).toMatch(/\(age \+ id\)/);

      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
      await db.getSchemaManager().migrate();
      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });
});
