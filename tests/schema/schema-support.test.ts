import { describe, test, expect } from '@jest/globals';
import { createTestDatabase } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, text, boolean, timestamp } from '../../src';

// Test entities for schema support
class SchemaUser extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  email!: DbColumn<string>;
  isActive!: DbColumn<boolean>;
  posts?: SchemaPost[];
}

class SchemaPost extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  userId!: DbColumn<number>;
  user?: SchemaUser;
}

// Test database with schema configuration
class SchemaTestDatabase extends DbContext {
  get users(): DbEntityTable<SchemaUser> {
    return this.table(SchemaUser);
  }

  get posts(): DbEntityTable<SchemaPost> {
    return this.table(SchemaPost);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SchemaUser, entity => {
      entity.toTable('schema_users');
      entity.toSchema('auth');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'schema_users_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
      entity.property(e => e.email).hasType(text('email')).isRequired();
      entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);

      entity.hasMany(e => e.posts as any, () => SchemaPost)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id);
    });

    model.entity(SchemaPost, entity => {
      entity.toTable('schema_posts');
      // Posts in public schema (default)

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'schema_posts_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.userId).hasType(integer('user_id')).isRequired();

      entity.hasOne(e => e.user, () => SchemaUser)
        .withForeignKey(p => p.userId)
        .withPrincipalKey(u => u.id)
        .onDelete('cascade')
        .isRequired();
    });
  }
}

describe('PostgreSQL Schema Support', () => {
  test('should create schemas before creating tables', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new SchemaTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Verify auth schema was created
      const schemaResult = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'auth'
      `);

      expect(schemaResult.rows).toHaveLength(1);
      expect(schemaResult.rows[0].schema_name).toBe('auth');

      // Verify schema_users table is in auth schema
      const tableResult = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_name = 'schema_users'
        AND table_schema = 'auth'
      `);

      expect(tableResult.rows).toHaveLength(1);
      expect(tableResult.rows[0].table_schema).toBe('auth');
      expect(tableResult.rows[0].table_name).toBe('schema_users');
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });

  test('should query tables with schema prefix', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new SchemaTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Insert a user into auth.schema_users
      const user = await db.users.insert({
        username: 'testuser',
        email: 'test@example.com',
        isActive: true,
      }).returning();

      expect(user.username).toBe('testuser');
      expect(user.email).toBe('test@example.com');

      // Query users
      const users = await db.users.toList();
      expect(users).toHaveLength(1);
      expect(users[0].username).toBe('testuser');
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });

  test('should handle foreign keys across schemas', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new SchemaTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Create user in auth schema
      const user = await db.users.insert({
        username: 'author',
        email: 'author@example.com',
        isActive: true,
      }).returning();

      // Create post in public schema (default) referencing auth.schema_users
      const post = await db.posts.insert({
        title: 'Test Post',
        userId: user.id,
      }).returning();

      expect(post.userId).toBe(user.id);

      // Query with navigation
      const posts = await db.posts
        .select(p => ({
          id: p.id,
          title: p.title,
          user: p.user,
        }))
        .toList();

      expect(posts).toHaveLength(1);
      expect(posts[0].user?.username).toBe('author');
    } finally {
      await db.getSchemaManager().ensureDeleted();
      await db.dispose();
    }
  });

  test('should drop schemas when calling ensureDeleted', async () => {
    const client = (createTestDatabase() as any).client;
    const db = new SchemaTestDatabase(client);

    try {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();

      // Verify schema exists
      let schemaResult = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'auth'
      `);
      expect(schemaResult.rows).toHaveLength(1);

      // Drop schema
      await db.getSchemaManager().ensureDeleted();

      // Verify schema is dropped
      schemaResult = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'auth'
      `);
      expect(schemaResult.rows).toHaveLength(0);
    } finally {
      await db.dispose();
    }
  });
});
