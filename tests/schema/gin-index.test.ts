import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

// Test entity for GIN index
class UserSearch extends DbEntity {
  id!: DbColumn<number>;
  email!: DbColumn<string>;
  name!: DbColumn<string>;
  surname!: DbColumn<string>;
}

// Test database with GIN trigram indexes
class GinIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserSearch> {
    return this.table(UserSearch);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserSearch, entity => {
      entity.toTable('users_gin_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_gin_test_id_seq' }));
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.surname).hasType(varchar('surname', 200)).isRequired();

      entity.hasIndex('idx_users_gin_email', e => [e.email])
        .using('gin')
        .withOperatorClass('gin_trgm_ops');

      entity.hasIndex('idx_users_gin_name', e => [e.name])
        .using('gin')
        .withOperatorClass('gin_trgm_ops');

      entity.hasIndex('idx_users_gin_surname', e => [e.surname])
        .using('gin')
        .withOperatorClass('gin_trgm_ops');
    });
  }
}

// Test database with GiST index for comparison
class GistIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserSearch> {
    return this.table(UserSearch);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserSearch, entity => {
      entity.toTable('users_gist_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_gist_test_id_seq' }));
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.surname).hasType(varchar('surname', 200)).isRequired();

      entity.hasIndex('idx_users_gist_email', e => [e.email])
        .using('gist')
        .withOperatorClass('gist_trgm_ops');
    });
  }
}

// Test database with BRIN index
class BrinIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserSearch> {
    return this.table(UserSearch);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserSearch, entity => {
      entity.toTable('users_brin_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_brin_test_id_seq' }));
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.surname).hasType(varchar('surname', 200)).isRequired();

      entity.hasIndex('idx_users_brin_id', e => [e.id])
        .using('brin');
    });
  }
}

describe('GIN/GiST/BRIN Index Support', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('should create GIN index with operator class', async () => {
    const client = createFreshClient();
    const db = new GinIndexTestDatabase(client);

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await client.query(`DROP TABLE IF EXISTS users_gin_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_gin_test'
        AND indexname = 'idx_users_gin_email'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('USING gin');
      expect(indexResult.rows[0].indexdef).toContain('gin_trgm_ops');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_gin_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create multiple GIN indexes on same table', async () => {
    const client = createFreshClient();
    const db = new GinIndexTestDatabase(client);

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await client.query(`DROP TABLE IF EXISTS users_gin_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_gin_test'
        AND indexname LIKE 'idx_users_gin_%'
        ORDER BY indexname
      `);

      expect(indexResult.rows).toHaveLength(3);
      expect(indexResult.rows[0].indexname).toBe('idx_users_gin_email');
      expect(indexResult.rows[1].indexname).toBe('idx_users_gin_name');
      expect(indexResult.rows[2].indexname).toBe('idx_users_gin_surname');

      for (const row of indexResult.rows) {
        expect(row.indexdef).toContain('USING gin');
        expect(row.indexdef).toContain('gin_trgm_ops');
      }
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_gin_test CASCADE`);
      await db.dispose();
    }
  });

  test('GIN trigram index should support ILIKE substring search', async () => {
    const client = createFreshClient();
    const db = new GinIndexTestDatabase(client);

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await client.query(`DROP TABLE IF EXISTS users_gin_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      await db.users.insert({ email: 'alice@gmail.com', name: 'Alice', surname: 'Smith' });
      await db.users.insert({ email: 'bob@company.cz', name: 'Bob', surname: 'Johnson' });
      await db.users.insert({ email: 'carol@gmail.com', name: 'Carol', surname: 'Williams' });

      // Substring search should work (index-assisted)
      const result = await client.query(`
        SELECT email FROM users_gin_test WHERE email ILIKE '%gmail%' ORDER BY email
      `);

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].email).toBe('alice@gmail.com');
      expect(result.rows[1].email).toBe('carol@gmail.com');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_gin_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create GiST index with operator class', async () => {
    const client = createFreshClient();
    const db = new GistIndexTestDatabase(client);

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await client.query(`DROP TABLE IF EXISTS users_gist_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_gist_test'
        AND indexname = 'idx_users_gist_email'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('USING gist');
      expect(indexResult.rows[0].indexdef).toContain('gist_trgm_ops');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_gist_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create BRIN index without operator class', async () => {
    const client = createFreshClient();
    const db = new BrinIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_brin_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_brin_test'
        AND indexname = 'idx_users_brin_id'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('USING brin');
      expect(indexResult.rows[0].indexdef).not.toContain('_ops');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_brin_test CASCADE`);
      await db.dispose();
    }
  });

  test('should reject invalid operator class names', () => {
    (EntityMetadataStore as any).metadata.clear();

    expect(() => {
      const model = new DbModelConfig();
      model.entity(UserSearch, entity => {
        entity.toTable('users_invalid_test');
        entity.property(e => e.id).hasType(integer('id').primaryKey());
        entity.property(e => e.email).hasType(varchar('email', 255));
        entity.property(e => e.name).hasType(varchar('name', 200));
        entity.property(e => e.surname).hasType(varchar('surname', 200));

        entity.hasIndex('idx_test', e => [e.email])
          .using('gin')
          .withOperatorClass('DROP TABLE users; --');
      });
    }).toThrow(/Invalid operator class/);
  });
});
