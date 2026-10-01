import { describe, test, expect, beforeEach } from 'bun:test';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
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
    const client = createFreshClient();
    const db = new UniqueIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
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
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create regular (non-unique) index on table', async () => {
    const client = createFreshClient();
    const db = new UniqueIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
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
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
      await db.dispose();
    }
  });

  test('should enforce unique constraint and reject duplicate values', async () => {
    const client = createFreshClient();
    const db = new UniqueIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      // Insert first record
      await db.products.insert({
        productSource: 'source1',
        productSubtype: 'subtype1',
        entityId: 'entity1',
        name: 'Product 1',
      });

      // Try to insert duplicate - should fail due to unique constraint
      await expectToReject(
        db.products.insert({
          productSource: 'source1',
          productSubtype: 'subtype1',
          entityId: 'entity1',
          name: 'Product 2 with same unique key',
        })
      , /duplicate key|unique constraint|violates unique/i);

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
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
      await db.dispose();
    }
  });

  test('should allow duplicate values in non-unique index', async () => {
    const client = createFreshClient();
    const db = new UniqueIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
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
      await client.query(`DROP TABLE IF EXISTS products_unique_test CASCADE`);
      await db.dispose();
    }
  });

  describe('a composite foreign key referencing a composite unique index', () => {
    // The referenced key `(id, kind)` is unique only through the index `ux_fkuix_group_id_kind`:
    // PostgreSQL refuses the FOREIGN KEY (42830 "there is no unique constraint matching given keys")
    // unless the unique index exists first. The child is declared FIRST, so neither the registry
    // order nor a per-table pass happens to build the parent's index in time.
    const GROUP_TABLE = 'fkuix_group';
    const MEMBER_TABLE = 'fkuix_member';

    class FkGroup extends DbEntity {
      id!: DbColumn<number>;
      kind!: DbColumn<number>;
    }

    class FkMember extends DbEntity {
      id!: DbColumn<number>;
      groupId!: DbColumn<number>;
      groupKind!: DbColumn<number>;
      group?: FkGroup;
      plainGroup?: FkGroup;
    }

    // 'composite': the unique index and the FK onto it; 'reordered': the same with the index over (kind, id);
    // 'nonUnique': the index NON-unique and no FK; 'baseline': neither.
    type Shape = 'composite' | 'reordered' | 'nonUnique' | 'baseline';

    const configureTables = (model: DbModelConfig, shape: Shape): void => {
      const withCompositeKey = shape === 'composite' || shape === 'reordered';
      model.entity(FkMember, entity => {
        entity.toTable(MEMBER_TABLE);
        entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'fkuix_member_id_seq' }));
        entity.property(e => e.groupId).hasType(integer('group_id')).isRequired();
        entity.property(e => e.groupKind).hasType(integer('group_kind')).isRequired();
        // An ordinary foreign key onto the primary key, in every shape.
        entity.hasOne(e => e.plainGroup, () => FkGroup)
          .withForeignKey(e => e.groupId)
          .withPrincipalKey(e => e.id)
          .hasDbName('FK_fkuix_member_group');
        if (withCompositeKey) {
          entity.hasOne(e => e.group, () => FkGroup)
            .withForeignKey(e => [e.groupId, e.groupKind])
            .withPrincipalKey(e => [e.id, e.kind])
            .onDelete('cascade')
            .onUpdate('cascade')
            .hasDbName('FK_fkuix_member_group_kind');
        }
      });

      model.entity(FkGroup, entity => {
        entity.toTable(GROUP_TABLE);
        entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'fkuix_group_id_seq' }));
        entity.property(e => e.kind).hasType(integer('kind')).isRequired();
        if (shape === 'composite') {
          entity.hasIndex('ux_fkuix_group_id_kind', e => [e.id, e.kind]).isUnique();
        } else if (shape === 'reordered') {
          entity.hasIndex('ux_fkuix_group_id_kind', e => [e.kind, e.id]).isUnique();
        } else if (shape === 'nonUnique') {
          entity.hasIndex('ux_fkuix_group_id_kind', e => [e.id, e.kind]);
        }
      });
    };

    class CompositeKeyDatabase extends DbContext {
      get groups(): DbEntityTable<FkGroup> {
        return this.table(FkGroup);
      }

      get members(): DbEntityTable<FkMember> {
        return this.table(FkMember);
      }

      protected override setupModel(model: DbModelConfig): void {
        configureTables(model, 'composite');
      }
    }

    // The same two tables before the composite key: no unique index, no composite FK.
    class BaselineDatabase extends DbContext {
      get groups(): DbEntityTable<FkGroup> {
        return this.table(FkGroup);
      }

      get members(): DbEntityTable<FkMember> {
        return this.table(FkMember);
      }

      protected override setupModel(model: DbModelConfig): void {
        configureTables(model, 'baseline');
      }
    }

    class NonUniqueIndexDatabase extends BaselineDatabase {
      protected override setupModel(model: DbModelConfig): void {
        configureTables(model, 'nonUnique');
      }
    }

    class ReorderedKeyDatabase extends BaselineDatabase {
      protected override setupModel(model: DbModelConfig): void {
        configureTables(model, 'reordered');
      }
    }

    // migrate() from the database `from` built to the model `to` builds, then checks the composite key.
    const migrateBetween = async (
      from: new (client: any) => DbContext,
      to: new (client: any) => DbContext,
      check: (client: any, plannedOps: any[]) => Promise<void>
    ): Promise<void> => {
      const clientV1 = createFreshClient();
      const v1 = new from(clientV1);
      try {
        await dropTables(clientV1);
        await v1.getSchemaManager().ensureCreated();

        (EntityMetadataStore as any).metadata.clear();
        const clientV2 = createFreshClient();
        const v2 = new to(clientV2);
        try {
          const plannedOps = await v2.getSchemaManager().analyze();
          await v2.getSchemaManager().migrate();
          await check(clientV2, plannedOps);
          const opsAfter = await v2.getSchemaManager().analyze();
          expect(opsAfter.filter(op => op.type !== 'create_view' && op.type !== 'drop_view')).toHaveLength(0);
        } finally {
          await v2.dispose();
        }
      } finally {
        await dropTables(clientV1);
        await v1.dispose();
      }
    };

    const dropTables = async (client: any): Promise<void> => {
      await client.query(`DROP TABLE IF EXISTS ${MEMBER_TABLE} CASCADE`);
      await client.query(`DROP TABLE IF EXISTS ${GROUP_TABLE} CASCADE`);
    };

    // The FK exists and PostgreSQL enforces it over BOTH columns, cascading a parent key change.
    const expectCompositeKeyEnforced = async (client: any): Promise<void> => {
      const fk = await client.query(`
        SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        WHERE c.relname = $1 AND con.conname = 'FK_fkuix_member_group_kind'
      `, [MEMBER_TABLE]);
      expect(fk.rows).toHaveLength(1);
      expect(fk.rows[0].def).toContain('FOREIGN KEY (group_id, group_kind) REFERENCES fkuix_group(id, kind)');

      const group = await client.query(`INSERT INTO ${GROUP_TABLE} (kind) VALUES (1) RETURNING id`);
      const groupId = group.rows[0].id;
      await client.query(`INSERT INTO ${MEMBER_TABLE} (group_id, group_kind) VALUES ($1, 1)`, [groupId]);
      await expectToReject(
        client.query(`INSERT INTO ${MEMBER_TABLE} (group_id, group_kind) VALUES ($1, 2)`, [groupId]),
        /FK_fkuix_member_group_kind/
      );

      await client.query(`UPDATE ${GROUP_TABLE} SET kind = 3 WHERE id = $1`, [groupId]);
      const member = await client.query(`SELECT group_kind FROM ${MEMBER_TABLE} WHERE group_id = $1`, [groupId]);
      expect(member.rows[0].group_kind).toBe(3);
    };

    test('ensureCreated builds the unique index before the foreign key that references it', async () => {
      const client = createFreshClient();
      const db = new CompositeKeyDatabase(client);

      try {
        await dropTables(client);
        await db.getSchemaManager().ensureCreated();
        await expectCompositeKeyEnforced(client);

        // Idempotent: a second run leaves the index and the FK as they are.
        await db.getSchemaManager().ensureCreated();
      } finally {
        await dropTables(client);
        await db.dispose();
      }
    });

    test('migrate() on an empty database builds the unique index before the foreign key', async () => {
      const client = createFreshClient();
      const db = new CompositeKeyDatabase(client);

      try {
        await dropTables(client);
        await db.getSchemaManager().migrate();
        await expectCompositeKeyEnforced(client);
      } finally {
        await dropTables(client);
        await db.dispose();
      }
    });

    test('migrate() adding both the unique index and the foreign key to existing tables orders them', async () => {
      const clientV1 = createFreshClient();
      const v1 = new BaselineDatabase(clientV1);

      try {
        await dropTables(clientV1);
        await v1.getSchemaManager().ensureCreated();

        (EntityMetadataStore as any).metadata.clear();
        const clientV2 = createFreshClient();
        const v2 = new CompositeKeyDatabase(clientV2);

        try {
          // The planned order — what a scaffolded migration file runs — has the index first.
          const plannedOps = await v2.getSchemaManager().analyze();
          const indexAt = plannedOps.findIndex(op => op.type === 'create_index' && op.indexName === 'ux_fkuix_group_id_kind');
          const fkAt = plannedOps.findIndex(op => op.type === 'create_foreign_key' && op.constraint.name === 'FK_fkuix_member_group_kind');
          expect(indexAt).toBeGreaterThanOrEqual(0);
          expect(fkAt).toBeGreaterThan(indexAt);

          await v2.getSchemaManager().migrate();
          await expectCompositeKeyEnforced(clientV2);

          const opsAfter = await v2.getSchemaManager().analyze();
          expect(opsAfter.filter(op => op.type === 'create_index' || op.type === 'create_foreign_key')).toHaveLength(0);
        } finally {
          await v2.dispose();
        }
      } finally {
        await dropTables(clientV1);
        await v1.dispose();
      }
    });

    test('migrate() recreating an index as unique and adding a foreign key onto it orders them', async () => {
      await migrateBetween(NonUniqueIndexDatabase, CompositeKeyDatabase, async (client, plannedOps) => {
        const recreateAt = plannedOps.findIndex(op => op.type === 'recreate_index' && op.indexName === 'ux_fkuix_group_id_kind');
        const fkAt = plannedOps.findIndex(op => op.type === 'create_foreign_key' && op.constraint.name === 'FK_fkuix_member_group_kind');
        expect(recreateAt).toBeGreaterThanOrEqual(0);
        expect(fkAt).toBeGreaterThan(recreateAt);
        await expectCompositeKeyEnforced(client);
      });
    });

    test('PostgreSQL refuses to drop a unique index a foreign key rests on', async () => {
      const client = createFreshClient();
      const db = new CompositeKeyDatabase(client);
      try {
        await dropTables(client);
        await db.getSchemaManager().ensureCreated();
        const error = await expectToReject(client.query(`DROP INDEX ux_fkuix_group_id_kind`), /because other objects depend on it/);
        expect(error.code).toBe('2BP01');
        await client.query(`DROP INDEX ux_fkuix_group_id_kind CASCADE`);
        const fk = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'FK_fkuix_member_group_kind'`);
        expect(fk.rows).toHaveLength(0);
      } finally {
        await dropTables(client);
        await db.dispose();
      }
    });

    test('migrate() recreating a unique index an existing foreign key rests on keeps the foreign key on it', async () => {
      await migrateBetween(CompositeKeyDatabase, ReorderedKeyDatabase, async client => {
        const index = await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_fkuix_group_id_kind'`);
        expect(index.rows[0].indexdef).toContain('(kind, id)');
        await expectCompositeKeyEnforced(client);
      });
    });

    test('ensureCreated emits a foreign key onto an earlier table\'s primary key or unique index inline', async () => {
      const client: any = createFreshClient();
      const db = new CompositeKeyDatabase(client);
      const statements: string[] = [];
      const query = client.query.bind(client);
      client.query = (text: string, params?: any[]) => {
        statements.push(text);
        return query(text, params);
      };

      try {
        await dropTables(client);
        await db.getSchemaManager().ensureCreated();
        const createMember = statements.find(text => text.includes(`CREATE TABLE IF NOT EXISTS "${MEMBER_TABLE}"`));
        expect(createMember).toContain('CONSTRAINT "FK_fkuix_member_group" FOREIGN KEY ("group_id") REFERENCES "fkuix_group"("id")');
        expect(createMember).toContain(
          'CONSTRAINT "FK_fkuix_member_group_kind" FOREIGN KEY ("group_id", "group_kind") REFERENCES "fkuix_group"("id", "kind") ON DELETE CASCADE ON UPDATE CASCADE'
        );
        expect(statements.filter(text => /ADD CONSTRAINT/i.test(text))).toHaveLength(0);
      } finally {
        client.query = query;
        await dropTables(client);
        await db.dispose();
      }
    });
  });

  describe('a foreign key whose referenced key does not exist yet when its table is created', () => {
    const NODE_TABLE = 'fkuix_node';
    const OWNER_TABLE = 'fkuix_owner';
    const PET_TABLE = 'fkuix_pet';

    // A tree whose parent key is the composite (id, kind), unique only through the table's OWN unique index.
    class FkNode extends DbEntity {
      id!: DbColumn<number>;
      kind!: DbColumn<number>;
      parentId!: DbColumn<number | null>;
      parentKind!: DbColumn<number | null>;
      parent?: FkNode;
    }

    // A cycle: an owner's favourite pet (onto the pet's primary key), and a pet's owner (onto the owner's
    // composite unique index).
    class FkOwner extends DbEntity {
      id!: DbColumn<number>;
      kind!: DbColumn<number>;
      favouritePetId!: DbColumn<number | null>;
      favouritePet?: FkPet;
    }

    class FkPet extends DbEntity {
      id!: DbColumn<number>;
      ownerId!: DbColumn<number>;
      ownerKind!: DbColumn<number>;
      owner?: FkOwner;
    }

    class SelfReferenceDatabase extends DbContext {
      get nodes(): DbEntityTable<FkNode> {
        return this.table(FkNode);
      }

      protected override setupModel(model: DbModelConfig): void {
        model.entity(FkNode, entity => {
          entity.toTable(NODE_TABLE);
          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'fkuix_node_id_seq' }));
          entity.property(e => e.kind).hasType(integer('kind')).isRequired();
          entity.property(e => e.parentId).hasType(integer('parent_id'));
          entity.property(e => e.parentKind).hasType(integer('parent_kind'));
          entity.hasOne(e => e.parent, () => FkNode)
            .withForeignKey(e => [e.parentId, e.parentKind])
            .withPrincipalKey(e => [e.id, e.kind])
            .onUpdate('cascade')
            .hasDbName('FK_fkuix_node_parent');
          entity.hasIndex('ux_fkuix_node_id_kind', e => [e.id, e.kind]).isUnique();
        });
      }
    }

    class CycleDatabase extends DbContext {
      get owners(): DbEntityTable<FkOwner> {
        return this.table(FkOwner);
      }

      get pets(): DbEntityTable<FkPet> {
        return this.table(FkPet);
      }

      protected override setupModel(model: DbModelConfig): void {
        model.entity(FkOwner, entity => {
          entity.toTable(OWNER_TABLE);
          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'fkuix_owner_id_seq' }));
          entity.property(e => e.kind).hasType(integer('kind')).isRequired();
          entity.property(e => e.favouritePetId).hasType(integer('favourite_pet_id'));
          entity.hasOne(e => e.favouritePet, () => FkPet)
            .withForeignKey(e => e.favouritePetId)
            .withPrincipalKey(e => e.id)
            .hasDbName('FK_fkuix_owner_favourite_pet');
          entity.hasIndex('ux_fkuix_owner_id_kind', e => [e.id, e.kind]).isUnique();
        });

        model.entity(FkPet, entity => {
          entity.toTable(PET_TABLE);
          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'fkuix_pet_id_seq' }));
          entity.property(e => e.ownerId).hasType(integer('owner_id')).isRequired();
          entity.property(e => e.ownerKind).hasType(integer('owner_kind')).isRequired();
          entity.hasOne(e => e.owner, () => FkOwner)
            .withForeignKey(e => [e.ownerId, e.ownerKind])
            .withPrincipalKey(e => [e.id, e.kind])
            .onUpdate('cascade')
            .hasDbName('FK_fkuix_pet_owner');
        });
      }
    }

    const dropTables = async (client: any): Promise<void> => {
      await client.query(`DROP TABLE IF EXISTS ${NODE_TABLE}, ${PET_TABLE}, ${OWNER_TABLE} CASCADE`);
    };

    const foreignKeyDefinition = async (client: any, name: string): Promise<string | undefined> => {
      const result = await client.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name]);
      return result.rows[0]?.def;
    };

    const expectSelfReferenceEnforced = async (client: any): Promise<void> => {
      expect(await foreignKeyDefinition(client, 'FK_fkuix_node_parent')).toContain('FOREIGN KEY (parent_id, parent_kind) REFERENCES fkuix_node(id, kind)');
      const root = await client.query(`INSERT INTO ${NODE_TABLE} (kind) VALUES (1) RETURNING id`);
      const rootId = root.rows[0].id;
      await client.query(`INSERT INTO ${NODE_TABLE} (kind, parent_id, parent_kind) VALUES (1, $1, 1)`, [rootId]);
      await expectToReject(
        client.query(`INSERT INTO ${NODE_TABLE} (kind, parent_id, parent_kind) VALUES (1, $1, 2)`, [rootId]),
        /FK_fkuix_node_parent/
      );
    };

    for (const build of ['ensureCreated', 'migrate'] as const) {
      test(`${build}() adds a self-referencing composite foreign key onto the table's own unique index`, async () => {
        const client = createFreshClient();
        const db = new SelfReferenceDatabase(client);
        try {
          await dropTables(client);
          await db.getSchemaManager()[build]();
          await expectSelfReferenceEnforced(client);
          // Idempotent: the second run neither fails nor changes anything.
          await db.getSchemaManager()[build]();
          expect((await db.getSchemaManager().analyze()).filter(op => op.type === 'create_foreign_key')).toHaveLength(0);
        } finally {
          await dropTables(client);
          await db.dispose();
        }
      });

      test(`${build}() builds two tables whose foreign keys form a cycle, one onto a unique index`, async () => {
        const client = createFreshClient();
        const db = new CycleDatabase(client);
        try {
          await dropTables(client);
          await db.getSchemaManager()[build]();
          await db.getSchemaManager()[build]();

          expect(await foreignKeyDefinition(client, 'FK_fkuix_owner_favourite_pet')).toContain('FOREIGN KEY (favourite_pet_id) REFERENCES fkuix_pet(id)');
          expect(await foreignKeyDefinition(client, 'FK_fkuix_pet_owner')).toContain('FOREIGN KEY (owner_id, owner_kind) REFERENCES fkuix_owner(id, kind)');

          const owner = await client.query(`INSERT INTO ${OWNER_TABLE} (kind) VALUES (1) RETURNING id`);
          const ownerId = owner.rows[0].id;
          const pet = await client.query(`INSERT INTO ${PET_TABLE} (owner_id, owner_kind) VALUES ($1, 1) RETURNING id`, [ownerId]);
          await client.query(`UPDATE ${OWNER_TABLE} SET favourite_pet_id = $1, kind = 2 WHERE id = $2`, [pet.rows[0].id, ownerId]);
          const moved = await client.query(`SELECT owner_kind FROM ${PET_TABLE} WHERE id = $1`, [pet.rows[0].id]);
          expect(moved.rows[0].owner_kind).toBe(2);
          await expectToReject(client.query(`UPDATE ${OWNER_TABLE} SET favourite_pet_id = -1 WHERE id = $1`, [ownerId]), /FK_fkuix_owner_favourite_pet/);
        } finally {
          await dropTables(client);
          await db.dispose();
        }
      });
    }
  });
});
