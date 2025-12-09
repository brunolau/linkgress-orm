import { describe, test, expect, beforeEach } from '@jest/globals';
import { createTestDatabase } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

// Test entity with unique index
class Product extends DbEntity {
  id!: DbColumn<number>;
  productSource!: DbColumn<string>;
  productSubtype!: DbColumn<string>;
  entityId!: DbColumn<string>;
  name!: DbColumn<string>;
}

// Test database with unique index configuration
class UniqueIndexTestDatabase extends DbContext {
  get products(): DbEntityTable<Product> {
    return this.table(Product);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Product, entity => {
      entity.toTable('products_unique_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'products_unique_test_id_seq' }));
      entity.property(e => e.productSource).hasType(varchar('product_source', 100)).isRequired();
      entity.property(e => e.productSubtype).hasType(varchar('product_subtype', 100)).isRequired();
      entity.property(e => e.entityId).hasType(varchar('entity_id', 100)).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();

      // Create unique index on multiple columns (similar to drizzle's unique constraint)
      entity.hasIndex('uq_product_external_source_subtype_entity', e => [
        e.productSource,
        e.productSubtype,
        e.entityId,
      ]).isUnique();

      // Create a regular (non-unique) index for comparison
      entity.hasIndex('ix_product_name', e => [
        e.name,
      ]);
    });
  }
}

describe('Unique Index Support', () => {
  beforeEach(() => {
    // Clear metadata store between tests to avoid conflicts
    (EntityMetadataStore as any).metadata.clear();
  });

  test('should create unique index on table', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new UniqueIndexTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Query pg_indexes to verify the unique index was created
      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'products_unique_test'
        AND indexname = 'uq_product_external_source_subtype_entity'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexname).toBe('uq_product_external_source_subtype_entity');
      // Verify it's a UNIQUE index
      expect(indexResult.rows[0].indexdef).toContain('UNIQUE');
      expect(indexResult.rows[0].indexdef).toContain('product_source');
      expect(indexResult.rows[0].indexdef).toContain('product_subtype');
      expect(indexResult.rows[0].indexdef).toContain('entity_id');
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });

  test('should create regular (non-unique) index on table', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new UniqueIndexTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Query pg_indexes to verify the regular index was created
      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'products_unique_test'
        AND indexname = 'ix_product_name'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexname).toBe('ix_product_name');
      // Verify it's NOT a UNIQUE index
      expect(indexResult.rows[0].indexdef).not.toContain('UNIQUE');
      expect(indexResult.rows[0].indexdef).toContain('name');
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });

  test('should enforce unique constraint and reject duplicate values', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new UniqueIndexTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Insert first record
      await db.products.insert({
        productSource: 'source1',
        productSubtype: 'subtype1',
        entityId: 'entity1',
        name: 'Product 1',
      });

      // Try to insert duplicate - should fail due to unique constraint
      await expect(
        db.products.insert({
          productSource: 'source1',
          productSubtype: 'subtype1',
          entityId: 'entity1',
          name: 'Product 2 with same unique key',
        })
      ).rejects.toThrow(/duplicate key|unique constraint|violates unique/i);

      // Insert with different entityId - should succeed
      await db.products.insert({
        productSource: 'source1',
        productSubtype: 'subtype1',
        entityId: 'entity2', // Different entityId
        name: 'Product 3',
      });

      // Verify we have exactly 2 records
      const count = await db.products.count();
      expect(count).toBe(2);
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });

  test('should allow duplicate values in non-unique index', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new UniqueIndexTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Insert multiple records with the same name (covered by non-unique index)
      await db.products.insert({
        productSource: 'source1',
        productSubtype: 'subtype1',
        entityId: 'entity1',
        name: 'Same Name',
      });

      await db.products.insert({
        productSource: 'source2',
        productSubtype: 'subtype2',
        entityId: 'entity2',
        name: 'Same Name', // Same name, should be allowed
      });

      // Verify we have 2 records with the same name
      const count = await db.products.count();
      expect(count).toBe(2);
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });
});
