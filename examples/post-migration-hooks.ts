/**
 * Example: Using post-migration hooks to execute custom SQL scripts
 *
 * This example demonstrates how to use the onMigrationComplete hook to execute
 * custom database scripts (functions, views, triggers, etc.) after the ORM
 * creates/migrates the schema.
 */

import { DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, integer, varchar, text, PgClient, DatabaseClient } from '../src';

// Define your entities
class User extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
}

// Extend DbContext and override onMigrationComplete
class AppDatabase extends DbContext {
  get users(): DbEntityTable<User> {
    return this.table(User);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(User, entity => {
      entity.toTable('users');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
      entity.property(e => e.email).hasType(text('email')).isRequired();
    });
  }

  /**
   * This hook is called automatically after ensureCreated() completes
   */
  protected override async onMigrationComplete(client: DatabaseClient): Promise<void> {
    // Example 1: Create a custom PostgreSQL function
    await client.query(`
      CREATE OR REPLACE FUNCTION get_user_by_username(p_username VARCHAR)
      RETURNS TABLE (
        id INTEGER,
        username VARCHAR,
        email TEXT
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT u.id, u.username, u.email
        FROM users u
        WHERE u.username = p_username;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Example 2: Create a view
    await client.query(`
      CREATE OR REPLACE VIEW active_users AS
      SELECT id, username, email
      FROM users
      WHERE username IS NOT NULL;
    `);

    // Example 3: Create a trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION update_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Example 4: Add custom indexes not managed by the ORM
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_gin
      ON users USING gin(to_tsvector('english', email));
    `);

    console.log('✓ Custom post-migration scripts executed successfully');
  }
}

// Usage
async function main() {
  const client = new PgClient({
    host: 'localhost',
    port: 5432,
    database: 'myapp',
    user: 'postgres',
    password: 'postgres',
  });

  const db = new AppDatabase(client);

  // When you call getSchemaManager().ensureCreated(), it will:
  // 1. Create all tables defined in setupModel
  // 2. Automatically call onMigrationComplete() to run your custom scripts
  await db.getSchemaManager().ensureCreated();

  // Now you can use your custom function
  const result = await client.query('SELECT * FROM get_user_by_username($1)', ['john']);
  console.log('User found:', result.rows[0]);

  // Query the custom view
  const activeUsers = await client.query('SELECT * FROM active_users');
  console.log('Active users:', activeUsers.rows);

  await db.dispose();
}

// Uncomment to run
// main().catch(console.error);
