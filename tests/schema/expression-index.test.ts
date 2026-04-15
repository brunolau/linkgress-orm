import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, boolean as pgBoolean, ixLower, ixUnaccent } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

// Test entity
class UserEshop extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  email!: DbColumn<string>;
  active!: DbColumn<boolean>;
}

// Expression index using selector helpers: lower("name")
class ExpressionIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_expr_idx_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_expr_idx_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasIndex('idx_user_eshop_name_lower', e => [ixLower(e.name)]);
    });
  }
}

// Multiple expression columns in single index
class MultiExpressionIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_multi_expr_idx_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_multi_expr_idx_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasIndex('idx_multi_lower', e => [ixLower(e.name), ixLower(e.email)]);
    });
  }
}

// Mixed: plain column + expression in same index
class MixedIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_mixed_idx_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_mixed_idx_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      // Mix plain and expression columns: (id, lower("name"))
      entity.hasIndex('idx_mixed', e => [e.id, ixLower(e.name)]);
    });
  }
}

// Partial index with WHERE
class PartialIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_partial_idx_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_partial_idx_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasIndex('idx_active_users_email', e => [e.email])
        .isUnique()
        .where('active = true');
    });
  }
}

// Combined: expression + WHERE
class CombinedIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_combined_idx_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_combined_idx_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasIndex('idx_combined_name', e => [ixLower(e.name)])
        .where('active = true');
    });
  }
}

// Raw expression via withExpression (escape hatch)
class RawExpressionIndexTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_rawexpr_idx_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_rawexpr_idx_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
      entity.property(e => e.active).hasType(pgBoolean('active').default(true));

      entity.hasIndex('idx_rawexpr')
        .withExpression('lower("email")')
        .where('active = true');
    });
  }
}

describe('Expression & Partial Index Support', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('should create expression index via selector: ixLower(e.name)', async () => {
    const client = createFreshClient();
    const db = new ExpressionIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_expr_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_expr_idx_test'
        AND indexname = 'idx_user_eshop_name_lower'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('lower(');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_expr_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create multi-expression index', async () => {
    const client = createFreshClient();
    const db = new MultiExpressionIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_multi_expr_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_multi_expr_idx_test'
        AND indexname = 'idx_multi_lower'
      `);

      expect(indexResult.rows).toHaveLength(1);
      const def = indexResult.rows[0].indexdef;
      // Should contain two lower() calls
      expect((def.match(/lower\(/g) || []).length).toBe(2);
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_multi_expr_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create mixed index: plain column + expression', async () => {
    const client = createFreshClient();
    const db = new MixedIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_mixed_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_mixed_idx_test'
        AND indexname = 'idx_mixed'
      `);

      expect(indexResult.rows).toHaveLength(1);
      const def = indexResult.rows[0].indexdef;
      // Should contain "id" and lower("name")
      expect(def).toContain('id');
      expect(def).toContain('lower(');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_mixed_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create partial index with WHERE clause', async () => {
    const client = createFreshClient();
    const db = new PartialIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_partial_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_partial_idx_test'
        AND indexname = 'idx_active_users_email'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('UNIQUE INDEX');
      expect(indexResult.rows[0].indexdef).toContain('WHERE');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_partial_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('partial index should enforce uniqueness only for matching rows', async () => {
    const client = createFreshClient();
    const db = new PartialIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_partial_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      // Two active users with same email should fail
      await db.users.insert({ name: 'Alice', email: 'alice@test.com', active: true });

      await expect(
        db.users.insert({ name: 'Alice2', email: 'alice@test.com', active: true })
      ).rejects.toThrow();

      // Inactive user with same email should be allowed
      await db.users.insert({ name: 'Alice3', email: 'alice@test.com', active: false });

      const result = await client.query(`SELECT count(*) as cnt FROM users_partial_idx_test`);
      expect(Number(result.rows[0].cnt)).toBe(2);
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_partial_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create combined expression + WHERE index', async () => {
    const client = createFreshClient();
    const db = new CombinedIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_combined_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_combined_idx_test'
        AND indexname = 'idx_combined_name'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('lower(');
      expect(indexResult.rows[0].indexdef).toContain('WHERE');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_combined_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('should create index via raw withExpression escape hatch', async () => {
    const client = createFreshClient();
    const db = new RawExpressionIndexTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_rawexpr_idx_test CASCADE`);
      await db.getSchemaManager().ensureCreated();

      const indexResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'users_rawexpr_idx_test'
        AND indexname = 'idx_rawexpr'
      `);

      expect(indexResult.rows).toHaveLength(1);
      expect(indexResult.rows[0].indexdef).toContain('lower(');
      expect(indexResult.rows[0].indexdef).toContain('WHERE');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_rawexpr_idx_test CASCADE`);
      await db.dispose();
    }
  });

  test('ixLower and ixUnaccent compose correctly in metadata', () => {
    const model = new DbModelConfig();
    model.entity(UserEshop, entity => {
      entity.toTable('test_compose');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 200));
      entity.property(e => e.email).hasType(varchar('email', 255));
      entity.property(e => e.active).hasType(pgBoolean('active'));

      entity.hasIndex('idx_compose', e => [ixLower(ixUnaccent(e.name))]);
    });

    const metadata = EntityMetadataStore.getMetadata(UserEshop)!;
    const idx = metadata.indexes.find(i => i.name === 'idx_compose')!;

    expect(idx.columns).toEqual(['name']);
    expect(idx.expressions).toEqual(['lower(unaccent("name"))']);
  });

  test('plain columns produce no expressions in metadata', () => {
    const model = new DbModelConfig();
    model.entity(UserEshop, entity => {
      entity.toTable('test_plain');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 200));
      entity.property(e => e.email).hasType(varchar('email', 255));
      entity.property(e => e.active).hasType(pgBoolean('active'));

      entity.hasIndex('idx_plain', e => [e.name, e.email]);
    });

    const metadata = EntityMetadataStore.getMetadata(UserEshop)!;
    const idx = metadata.indexes.find(i => i.name === 'idx_plain')!;

    expect(idx.columns).toEqual(['name', 'email']);
    expect(idx.expressions).toBeUndefined();
  });
});
