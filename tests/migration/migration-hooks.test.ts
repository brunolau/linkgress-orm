import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, integer, varchar, text, PgClient, DatabaseClient } from '../../src';

// Test entity
class CustomScriptUser extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
}

// Database context with custom post-migration script
class TestDatabaseWithHook extends DbContext {
  customScriptExecuted = false;
  customScriptError: Error | null = null;

  get users(): DbEntityTable<CustomScriptUser> {
    return this.table(CustomScriptUser);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(CustomScriptUser, entity => {
      entity.toTable('custom_script_users');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'custom_script_users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
      entity.property(e => e.email).hasType(text('email')).isRequired();
    });
  }

  protected override async onMigrationComplete(client: DatabaseClient): Promise<void> {
    try {
      // Create a custom function
      await client.query(`
        CREATE OR REPLACE FUNCTION get_user_count()
        RETURNS integer AS $$
        BEGIN
          RETURN (SELECT COUNT(*) FROM "custom_script_users");
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Create a custom view
      await client.query(`
        CREATE OR REPLACE VIEW active_users_view AS
        SELECT id, username, email
        FROM "custom_script_users"
        WHERE username IS NOT NULL;
      `);

      this.customScriptExecuted = true;
    } catch (error) {
      this.customScriptError = error as Error;
      throw error;
    }
  }
}

describe('Migration Hooks', () => {
  let client: PgClient;
  let db: TestDatabaseWithHook;

  beforeAll(async () => {
    client = new PgClient({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'linkgress_test',
    });

    db = new TestDatabaseWithHook(client);
  });

  afterAll(async () => {
    // Clean up
    try {
      await client.query('DROP VIEW IF EXISTS active_users_view');
      await client.query('DROP FUNCTION IF EXISTS get_user_count()');
      await db.getSchemaManager().ensureDeleted();
    } catch (error) {
      // Ignore cleanup errors
    }
    await db.dispose();
  });

  test('should execute onMigrationComplete hook after migrations', async () => {
    // This will create tables and execute the hook
    await db.getSchemaManager().ensureCreated();

    // Verify hook was executed
    expect(db.customScriptExecuted).toBe(true);
    expect(db.customScriptError).toBeNull();

    // Verify custom function was created
    const functionResult = await client.query(`
      SELECT proname
      FROM pg_proc
      WHERE proname = 'get_user_count'
    `);
    expect(functionResult.rows).toHaveLength(1);

    // Verify custom view was created
    const viewResult = await client.query(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_name = 'active_users_view'
    `);
    expect(viewResult.rows).toHaveLength(1);
  });

  test('should allow custom function to work correctly', async () => {
    // Insert some test users
    await db.users.insert({
      username: 'user1',
      email: 'user1@example.com',
    });

    await db.users.insert({
      username: 'user2',
      email: 'user2@example.com',
    });

    // Call custom function
    const result = await client.query('SELECT get_user_count() as count');
    expect(result.rows[0].count).toBe(2);
  });

  test('should allow custom view to work correctly', async () => {
    // Query the custom view
    const result = await client.query('SELECT * FROM active_users_view ORDER BY username');

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].username).toBe('user1');
    expect(result.rows[1].username).toBe('user2');
  });

  test('should work when no custom hook is implemented', async () => {
    // Create a context without override
    class SimpleDatabase extends DbContext {
      get users(): DbEntityTable<CustomScriptUser> {
        return this.table(CustomScriptUser);
      }

      protected override setupModel(model: DbModelConfig): void {
        model.entity(CustomScriptUser, entity => {
          entity.toTable('simple_users');

          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'simple_users_id_seq' }));
          entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
          entity.property(e => e.email).hasType(text('email')).isRequired();
        });
      }
      // No onMigrationComplete override - should use default (do nothing)
    }

    const simpleClient = new PgClient({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'linkgress_test',
    });

    const simpleDb = new SimpleDatabase(simpleClient);

    // Should not throw error
    await expect(simpleDb.getSchemaManager().ensureCreated()).resolves.not.toThrow();

    // Clean up
    await simpleDb.getSchemaManager().ensureDeleted();
    await simpleDb.dispose();
  });
});
