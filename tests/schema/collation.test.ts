import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, pgCollation } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { CollationRegistry } from '../../src/types/collation-builder';

const ndCiAi = pgCollation({
  name: 'nd_ci_ai',
  provider: 'icu',
  locale: 'und-u-ks-level1',
  deterministic: false,
});

class UserEshop extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  email!: DbColumn<string>;
}

// Database with collation on a column
class CollationTestDatabase extends DbContext {
  get users(): DbEntityTable<UserEshop> {
    return this.table(UserEshop);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(UserEshop, entity => {
      entity.toTable('users_collation_test');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_collation_test_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired().hasCollation(ndCiAi);
      entity.property(e => e.email).hasType(varchar('email', 255)).isRequired();
    });
  }
}

describe('Collation Support', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
    CollationRegistry.clear();
  });

  test('pgCollation registers in the CollationRegistry', () => {
    const collation = pgCollation({
      name: 'test_collation',
      provider: 'icu',
      locale: 'und-u-ks-level1',
      deterministic: false,
    });

    expect(collation.name).toBe('test_collation');
    expect(CollationRegistry.has('test_collation')).toBe(true);
    expect(CollationRegistry.get('test_collation')).toEqual(collation);
  });

  test('hasCollation sets collation on column config', () => {
    const collation = pgCollation({
      name: 'my_collation',
      provider: 'icu',
      locale: 'und-u-ks-level1',
      deterministic: false,
    });

    const model = new DbModelConfig();
    model.entity(UserEshop, entity => {
      entity.toTable('test_col_config');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 200)).hasCollation(collation);
      entity.property(e => e.email).hasType(varchar('email', 255));
    });

    const metadata = EntityMetadataStore.getMetadata(UserEshop)!;
    const nameProp = metadata.properties.get('name' as any)!;
    expect(nameProp.columnBuilder.build().collation).toBe('my_collation');

    const emailProp = metadata.properties.get('email' as any)!;
    expect(emailProp.columnBuilder.build().collation).toBeUndefined();
  });

  test('should create collation and table with COLLATE column', async () => {
    // Re-register since beforeEach clears
    pgCollation({
      name: 'nd_ci_ai',
      provider: 'icu',
      locale: 'und-u-ks-level1',
      deterministic: false,
    });

    const client = createFreshClient();
    const db = new CollationTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await client.query(`DROP COLLATION IF EXISTS "nd_ci_ai"`);
      await db.getSchemaManager().ensureCreated();

      // Verify collation was created
      const collResult = await client.query(`
        SELECT collname FROM pg_collation WHERE collname = 'nd_ci_ai'
      `);
      expect(collResult.rows).toHaveLength(1);

      // Verify column uses the collation
      const colResult = await client.query(`
        SELECT column_name, collation_name
        FROM information_schema.columns
        WHERE table_name = 'users_collation_test'
        AND column_name = 'name'
      `);
      expect(colResult.rows).toHaveLength(1);
      expect(colResult.rows[0].collation_name).toBe('nd_ci_ai');

      // Verify email column has no custom collation
      const emailResult = await client.query(`
        SELECT column_name, collation_name
        FROM information_schema.columns
        WHERE table_name = 'users_collation_test'
        AND column_name = 'email'
      `);
      expect(emailResult.rows).toHaveLength(1);
      expect(emailResult.rows[0].collation_name).not.toBe('nd_ci_ai');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await db.dispose();
    }
  });

  test('collation should enable case-insensitive and accent-insensitive matching', async () => {
    pgCollation({
      name: 'nd_ci_ai',
      provider: 'icu',
      locale: 'und-u-ks-level1',
      deterministic: false,
    });

    const client = createFreshClient();
    const db = new CollationTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await client.query(`DROP COLLATION IF EXISTS "nd_ci_ai"`);
      await db.getSchemaManager().ensureCreated();

      await db.users.insert({ name: 'Ján', email: 'jan@test.com' });
      await db.users.insert({ name: 'Peter', email: 'peter@test.com' });

      // Case-insensitive: 'jan' should match 'Ján'
      const ciResult = await client.query(`
        SELECT name FROM users_collation_test WHERE name = 'ján'
      `);
      expect(ciResult.rows).toHaveLength(1);
      expect(ciResult.rows[0].name).toBe('Ján');

      // Accent-insensitive: 'Jan' should match 'Ján'
      const aiResult = await client.query(`
        SELECT name FROM users_collation_test WHERE name = 'Jan'
      `);
      expect(aiResult.rows).toHaveLength(1);
      expect(aiResult.rows[0].name).toBe('Ján');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await db.dispose();
    }
  });

  test('schema analysis should detect missing collation', async () => {
    pgCollation({
      name: 'nd_ci_ai',
      provider: 'icu',
      locale: 'und-u-ks-level1',
      deterministic: false,
    });

    const client = createFreshClient();
    const db = new CollationTestDatabase(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await client.query(`DROP COLLATION IF EXISTS "nd_ci_ai"`);

      const operations = await db.getSchemaManager().analyze();
      const collationOps = operations.filter(op => op.type === 'create_collation');

      expect(collationOps.length).toBe(1);
      expect((collationOps[0] as any).collation.name).toBe('nd_ci_ai');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await db.dispose();
    }
  });

  test('schema analysis should detect collation mismatch on column', async () => {
    pgCollation({
      name: 'nd_ci_ai',
      provider: 'icu',
      locale: 'und-u-ks-level1',
      deterministic: false,
    });

    const client = createFreshClient();
    const db = new CollationTestDatabase(client);

    try {
      // Create collation but table WITHOUT collation on the column
      await client.query(`DROP COLLATION IF EXISTS "nd_ci_ai"`);
      await client.query(`CREATE COLLATION "nd_ci_ai" (provider = 'icu', locale = 'und-u-ks-level1', deterministic = false)`);
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await client.query(`
        CREATE TABLE users_collation_test (
          id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
          name varchar(200) NOT NULL,
          email varchar(255) NOT NULL
        )
      `);

      const operations = await db.getSchemaManager().analyze();
      const alterOps = operations.filter(op => op.type === 'alter_column');

      // Should detect that 'name' column needs collation change
      const nameAlter = alterOps.find((op: any) => op.columnName === 'name');
      expect(nameAlter).toBeDefined();
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_collation_test CASCADE`);
      await db.dispose();
    }
  });
});
