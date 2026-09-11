import { describe, test, expect, beforeEach } from '@jest/globals';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, boolean, timestamp, varchar, ixLower } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { MigrationOperation } from '../../src/migration/db-schema-manager';

/**
 * End-to-end coverage for `.include()` — covering (`INCLUDE`) columns — against a
 * real PostgreSQL. The builder must produce a genuine covering index (the columns
 * ride in the leaf entries but are not part of the key), the reconciler must see a
 * declared INCLUDE list that matches the live one as unchanged (no churn), and
 * adding, removing or changing the list must be detected, recreated and converge.
 */

const TABLE = 'incl_idx_loan';
const INDEX = 'ix_incl_loan_book';
const UNIQUE_INDEX = 'uq_incl_loan_active_book';

function defineColumns(entity: any): void {
  entity.toTable(TABLE);
  entity.property((e: any) => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${TABLE}_id_seq` }));
  entity.property((e: any) => e.bookId).hasType(integer('book_id')).isRequired();
  entity.property((e: any) => e.readerId).hasType(integer('reader_id')).isRequired();
  entity.property((e: any) => e.isActive).hasType(boolean('is_active')).isRequired();
  entity.property((e: any) => e.loanedAt).hasType(timestamp('loaned_at')).isRequired();
  entity.property((e: any) => e.returnedAt).hasType(timestamp('returned_at'));
  entity.property((e: any) => e.note).hasType(varchar('note', 200));
}

// Distinct entity classes per model version — the global EntityMetadataStore is
// keyed by class, so reusing one class across versions would accumulate indexes.
// Every class maps to the SAME physical table.
class CoveringLoan extends DbEntity { id!: DbColumn<number>; bookId!: DbColumn<number>; readerId!: DbColumn<number>; isActive!: DbColumn<boolean>; loanedAt!: DbColumn<Date>; returnedAt!: DbColumn<Date>; note!: DbColumn<string>; }
class PlainLoan extends DbEntity { id!: DbColumn<number>; bookId!: DbColumn<number>; readerId!: DbColumn<number>; isActive!: DbColumn<boolean>; loanedAt!: DbColumn<Date>; returnedAt!: DbColumn<Date>; note!: DbColumn<string>; }
class NarrowLoan extends DbEntity { id!: DbColumn<number>; bookId!: DbColumn<number>; readerId!: DbColumn<number>; isActive!: DbColumn<boolean>; loanedAt!: DbColumn<Date>; returnedAt!: DbColumn<Date>; note!: DbColumn<string>; }
class UniqueLoan extends DbEntity { id!: DbColumn<number>; bookId!: DbColumn<number>; readerId!: DbColumn<number>; isActive!: DbColumn<boolean>; loanedAt!: DbColumn<Date>; returnedAt!: DbColumn<Date>; note!: DbColumn<string>; }
class GinLoan extends DbEntity { id!: DbColumn<number>; bookId!: DbColumn<number>; readerId!: DbColumn<number>; isActive!: DbColumn<boolean>; loanedAt!: DbColumn<Date>; returnedAt!: DbColumn<Date>; note!: DbColumn<string>; }
class ExpressionLoan extends DbEntity { id!: DbColumn<number>; bookId!: DbColumn<number>; readerId!: DbColumn<number>; isActive!: DbColumn<boolean>; loanedAt!: DbColumn<Date>; returnedAt!: DbColumn<Date>; note!: DbColumn<string>; }

// Key (book_id, is_active), covering the loan's dates and reader.
class CoveringDb extends DbContext {
  get loans(): DbEntityTable<CoveringLoan> { return this.table(CoveringLoan); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(CoveringLoan, e => {
      defineColumns(e);
      e.hasIndex(INDEX, (r: CoveringLoan) => [r.bookId, r.isActive])
        .include((r: CoveringLoan) => [r.loanedAt, r.returnedAt, r.readerId]);
    });
  }
}

// SAME index name and key, no INCLUDE.
class PlainDb extends DbContext {
  get loans(): DbEntityTable<PlainLoan> { return this.table(PlainLoan); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PlainLoan, e => {
      defineColumns(e);
      e.hasIndex(INDEX, (r: PlainLoan) => [r.bookId, r.isActive]);
    });
  }
}

// SAME index name and key, a shorter INCLUDE list, built concurrently.
class NarrowDb extends DbContext {
  get loans(): DbEntityTable<NarrowLoan> { return this.table(NarrowLoan); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(NarrowLoan, e => {
      defineColumns(e);
      e.hasIndex(INDEX, (r: NarrowLoan) => [r.bookId, r.isActive])
        .include((r: NarrowLoan) => [r.loanedAt])
        .concurrent();
    });
  }
}

// One ACTIVE loan per book; the reader rides along without joining the key.
class UniqueCoveringDb extends DbContext {
  get loans(): DbEntityTable<UniqueLoan> { return this.table(UniqueLoan); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(UniqueLoan, e => {
      defineColumns(e);
      e.hasIndex(UNIQUE_INDEX, (r: UniqueLoan) => [r.bookId])
        .isUnique()
        .include((r: UniqueLoan) => [r.readerId])
        .nullsNotDistinct()
        .where('is_active');
    });
  }
}

// GIN cannot store INCLUDE columns.
class GinCoveringDb extends DbContext {
  get loans(): DbEntityTable<GinLoan> { return this.table(GinLoan); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(GinLoan, e => {
      defineColumns(e);
      e.hasIndex('ix_incl_loan_note_gin', (r: GinLoan) => [r.note])
        .using('gin')
        .include((r: GinLoan) => [r.readerId]);
    });
  }
}

// INCLUDE columns cannot be expressions.
class ExpressionIncludeDb extends DbContext {
  get loans(): DbEntityTable<ExpressionLoan> { return this.table(ExpressionLoan); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(ExpressionLoan, e => {
      defineColumns(e);
      e.hasIndex('ix_incl_loan_expr', (r: ExpressionLoan) => [r.bookId])
        .include((r: ExpressionLoan) => [ixLower(r.note)]);
    });
  }
}

function indexOps(ops: MigrationOperation[]): MigrationOperation[] {
  return ops.filter(o => o.type === 'create_index' || o.type === 'recreate_index' || o.type === 'drop_index');
}

async function indexDef(client: any, name: string = INDEX): Promise<string | null> {
  const res = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
    [TABLE, name]
  );
  return res.rows.length ? res.rows[0].indexdef : null;
}

// pg_index counts every stored attribute in `indnatts` and only the KEY ones in
// `indnkeyatts`; the difference is the INCLUDE list.
async function attributeCounts(client: any, name: string = INDEX): Promise<{ all: number; keys: number } | null> {
  const res = await client.query(
    `SELECT ix.indnatts AS all_atts, ix.indnkeyatts AS key_atts
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     WHERE i.relname = $1`,
    [name]
  );
  return res.rows.length ? { all: Number(res.rows[0].all_atts), keys: Number(res.rows[0].key_atts) } : null;
}

async function dropTable(): Promise<void> {
  const c = createFreshClient();
  await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await c.end();
}

describe('INCLUDE (covering) index — end-to-end', () => {
  beforeEach(() => { (EntityMetadataStore as any).metadata.clear(); });

  test('.include() creates a real covering index whose INCLUDE columns are not key columns', async () => {
    const client = createFreshClient();
    const db = new CoveringDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();

      expect(await indexDef(client)).toContain('(book_id, is_active) INCLUDE (loaned_at, returned_at, reader_id)');
      expect(await attributeCounts(client)).toEqual({ all: 5, keys: 2 });
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('does NOT churn an unchanged covering index (declared INCLUDE vs live INCLUDE)', async () => {
    const client = createFreshClient();
    const db = new CoveringDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();

      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
      await db.getSchemaManager().migrate();
      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('detects INCLUDE added to a plain index, recreates it, and converges', async () => {
    const clientV1 = createFreshClient();
    const v1 = new PlainDb(clientV1);
    let v2: CoveringDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      expect(await indexDef(clientV1)).not.toContain('INCLUDE');
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new CoveringDb(clientV2);

      const recreate = (await v2.getSchemaManager().analyze()).find(o => o.type === 'recreate_index') as any;
      expect(recreate).toBeDefined();
      expect(recreate.indexName).toBe(INDEX);
      expect(recreate.reason).toBe('include (none) -> (loaned_at, returned_at, reader_id)');

      await v2.getSchemaManager().migrate();
      expect(await indexDef(clientV2)).toContain('INCLUDE (loaned_at, returned_at, reader_id)');
      expect(await attributeCounts(clientV2)).toEqual({ all: 5, keys: 2 });
      expect(indexOps(await v2.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      if (v2) await v2.dispose();
      await dropTable();
    }
  });

  test('detects INCLUDE removed (the live INCLUDE clause is parsed, not ignored)', async () => {
    const clientV1 = createFreshClient();
    const v1 = new CoveringDb(clientV1);
    let v2: PlainDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      expect(await indexDef(clientV1)).toContain('INCLUDE');
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new PlainDb(clientV2);

      const recreate = (await v2.getSchemaManager().analyze()).find(o => o.type === 'recreate_index') as any;
      expect(recreate).toBeDefined();
      expect(recreate.reason).toBe('include (loaned_at, returned_at, reader_id) -> (none)');

      await v2.getSchemaManager().migrate();
      expect(await indexDef(clientV2)).not.toContain('INCLUDE');
      expect(await attributeCounts(clientV2)).toEqual({ all: 2, keys: 2 });
      expect(indexOps(await v2.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      if (v2) await v2.dispose();
      await dropTable();
    }
  });

  test('detects a changed INCLUDE list and recreates it concurrently', async () => {
    const clientV1 = createFreshClient();
    const v1 = new CoveringDb(clientV1);
    let v2: NarrowDb | null = null;
    try {
      await clientV1.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await v1.getSchemaManager().ensureCreated();
      await v1.dispose();

      (EntityMetadataStore as any).metadata.clear();
      const clientV2 = createFreshClient();
      v2 = new NarrowDb(clientV2);

      const recreate = (await v2.getSchemaManager().analyze()).find(o => o.type === 'recreate_index') as any;
      expect(recreate).toBeDefined();
      expect(recreate.reason).toBe('include (loaned_at, returned_at, reader_id) -> (loaned_at)');
      expect(recreate.concurrent).toBe(true);

      await v2.getSchemaManager().migrate();
      const def = await indexDef(clientV2);
      expect(def).toContain('(book_id, is_active) INCLUDE (loaned_at)');
      expect(def).not.toContain('returned_at');
      expect(indexOps(await v2.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      if (v2) await v2.dispose();
      await dropTable();
    }
  });

  test('unique covering index: uniqueness is on the key only, clause order is INCLUDE / NULLS NOT DISTINCT / WHERE', async () => {
    const client = createFreshClient();
    const db = new UniqueCoveringDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const def = await indexDef(client, UNIQUE_INDEX);
      expect(def).toContain('CREATE UNIQUE INDEX');
      expect(def).toContain('(book_id) INCLUDE (reader_id) NULLS NOT DISTINCT WHERE is_active');

      await client.query(`INSERT INTO ${TABLE} (book_id, reader_id, is_active, loaned_at) VALUES (7, 1, true, now())`);
      // A different reader does not make a second active loan of the same book
      // unique: INCLUDE columns take no part in the uniqueness check.
      await expectToReject(
        client.query(`INSERT INTO ${TABLE} (book_id, reader_id, is_active, loaned_at) VALUES (7, 2, true, now())`),
        /duplicate key|unique constraint|violates unique/i
      );
      // Outside the partial predicate the key may repeat.
      await client.query(`INSERT INTO ${TABLE} (book_id, reader_id, is_active, loaned_at) VALUES (7, 3, false, now())`);

      expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('refuses INCLUDE on an access method that cannot store it (GIN)', async () => {
    const client = createFreshClient();
    const db = new GinCoveringDb(client);
    try {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await expectToReject(db.getSchemaManager().ensureCreated(), /INCLUDE.*gin/i);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await db.dispose();
    }
  });

  test('refuses an expression in .include(): INCLUDE takes plain columns only', async () => {
    const client = createFreshClient();
    const holder: { db?: ExpressionIncludeDb } = {};
    try {
      await expectToReject(async () => {
        holder.db = new ExpressionIncludeDb(client);
        await holder.db.getSchemaManager().analyze();
      }, /include\(\) accepts plain column references only/i);
    } finally {
      if (holder.db) {
        await holder.db.dispose();
      } else {
        await client.end();
      }
    }
  });
});
