import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

class ConcurrentItem extends DbEntity {
  id!: DbColumn<number>;
  email!: DbColumn<string>;
  name!: DbColumn<string>;
}

class ConcurrentIndexDatabase extends DbContext {
  get items(): DbEntityTable<ConcurrentItem> {
    return this.table(ConcurrentItem);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(ConcurrentItem, entity => {
      entity.toTable('items_concurrent_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'items_concurrent_test_id_seq' }));
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();

      entity.hasIndex('idx_items_concurrent_email', e => [e.email]).concurrent();

      entity.hasIndex('uq_items_concurrent_name', e => [e.name]).isUnique().concurrent();

      entity.hasIndex('idx_items_concurrent_plain', e => [e.name]);
    });
  }
}

describe('Concurrent Index Support', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('creates non-unique index with CONCURRENTLY', async () => {
    const client = createFreshClient();
    const db = new ConcurrentIndexDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef, indisvalid
        FROM pg_indexes
        JOIN pg_class c ON c.relname = indexname
        JOIN pg_index i ON i.indexrelid = c.oid
        WHERE tablename = 'items_concurrent_test'
        AND indexname = 'idx_items_concurrent_email'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indisvalid).toBe(true);
      expect(indexResult.rows[0].indexdef).toContain('email');
    } finally {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.dispose();
    }
  });

  test('creates unique index with CONCURRENTLY', async () => {
    const client = createFreshClient();
    const db = new ConcurrentIndexDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'items_concurrent_test'
        AND indexname = 'uq_items_concurrent_name'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('UNIQUE');
      expect(indexResult.rows[0].indexdef).toContain('name');
    } finally {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.dispose();
    }
  });

  test('non-concurrent index still created alongside concurrent ones', async () => {
    const client = createFreshClient();
    const db = new ConcurrentIndexDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'items_concurrent_test'
        AND indexname IN ('idx_items_concurrent_email', 'uq_items_concurrent_name', 'idx_items_concurrent_plain')
        ORDER BY indexname
      `);

      expect(indexResult.rows).toHaveLength(3);
      expect(indexResult.rows.map((r: any) => r.indexname)).toEqual([
        'idx_items_concurrent_email',
        'idx_items_concurrent_plain',
        'uq_items_concurrent_name',
      ]);
    } finally {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.dispose();
    }
  });

  test('global concurrentIndexes option forces CONCURRENTLY on every index', async () => {
    class PlainEntity extends DbEntity {
      id!: DbColumn<number>;
      email!: DbColumn<string>;
      name!: DbColumn<string>;
    }

    class PlainDatabase extends DbContext {
      get items(): DbEntityTable<PlainEntity> { return this.table(PlainEntity); }

      protected override setupModel(model: DbModelConfig): void {
        model.entity(PlainEntity, entity => {
          entity.toTable('items_global_concurrent_test');
          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'items_global_concurrent_test_id_seq' }));
          entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
          entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();

          // Note: no .concurrent() on any index
          entity.hasIndex('idx_global_email', e => [e.email]);
          entity.hasIndex('uq_global_name', e => [e.name]).isUnique();
        });
      }
    }

    const client = createFreshClient();
    const db = new PlainDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS items_global_concurrent_test CASCADE`);

      // Global override — every index below is created CONCURRENTLY
      await db.getSchemaManager({ concurrentIndexes: true }).ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'items_global_concurrent_test'
        AND indexname IN ('idx_global_email', 'uq_global_name')
        ORDER BY indexname
      `);

      expect(indexResult.rows).toHaveLength(2);
    } finally {
      await client.query(`DROP TABLE IF EXISTS items_global_concurrent_test CASCADE`);
      await db.dispose();
    }
  });

  test('re-running migrate() is idempotent when concurrent flag is set', async () => {
    const client = createFreshClient();
    const db = new ConcurrentIndexDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      // Second migrate() should be a no-op because indexes already exist.
      await db.getSchemaManager().migrate();

      const indexResult = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'items_concurrent_test'
        AND indexname = 'idx_items_concurrent_email'
      `);

      expect(indexResult.rows).toHaveLength(1);
    } finally {
      await client.query(`DROP TABLE IF EXISTS items_concurrent_test CASCADE`);
      await db.dispose();
    }
  });
});
