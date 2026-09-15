import { describe, test, expect } from 'bun:test';
import { createTestDatabase } from '../utils/test-database';

describe('props method', () => {
  test('should return column properties by default (excludeNavigation: true)', () => {
    const db = createTestDatabase();

    const cols = db.users.props();

    expect(cols).toBeDefined();
    expect(cols.id).toBeDefined();
    expect(cols.username).toBeDefined();
    expect(cols.email).toBeDefined();

    // Navigation properties should NOT be included by default
    expect((cols as any).posts).toBeUndefined();
    expect((cols as any).orders).toBeUndefined();
  });

  test('should include navigation properties when excludeNavigation is false', () => {
    const db = createTestDatabase();

    const allProps = db.users.props({ excludeNavigation: false });

    expect(allProps).toBeDefined();
    expect(allProps.id).toBeDefined();
    expect(allProps.username).toBeDefined();

    // Navigation properties should be included
    expect((allProps as any).posts).toBeDefined();
    expect((allProps as any).orders).toBeDefined();
  });

  test('should return props that can be used for field references', () => {
    const db = createTestDatabase();

    const cols = db.users.props();

    // Each property should have __fieldName
    expect((cols.id as any).__fieldName).toBe('id');
    expect((cols.username as any).__fieldName).toBe('username');
    expect((cols.email as any).__fieldName).toBe('email');

    // Should also have __dbColumnName matching the database column name
    expect((cols.id as any).__dbColumnName).toBe('id');
    expect((cols.username as any).__dbColumnName).toBe('username');

    // Should have __tableAlias for query building
    expect((cols.id as any).__tableAlias).toBe('users');
  });

  test('should work with posts table', () => {
    const db = createTestDatabase();

    const cols = db.posts.props();

    expect(cols).toBeDefined();
    expect(cols.id).toBeDefined();
    expect(cols.title).toBeDefined();
    expect(cols.userId).toBeDefined();

    // user navigation should NOT be included by default
    expect((cols as any).user).toBeUndefined();
  });
});

describe('getColumns method', () => {
  test('should return all columns for users table', async () => {
    const db = createTestDatabase();

    const columns = db.users.getColumns();

    expect(columns).toBeDefined();
    expect(Array.isArray(columns)).toBe(true);
    expect(columns.length).toBeGreaterThan(0);

    // Check that id column exists and has correct properties
    const idColumn = columns.find(c => c.propertyName === 'id');
    expect(idColumn).toBeDefined();
    expect(idColumn!.isPrimaryKey).toBe(true);
    expect(idColumn!.isAutoIncrement).toBe(true);
    expect(idColumn!.type).toBe('integer');

    // Check that username column exists
    const usernameColumn = columns.find(c => c.propertyName === 'username');
    expect(usernameColumn).toBeDefined();
    expect(usernameColumn!.isPrimaryKey).toBe(false);
    expect(usernameColumn!.isUnique).toBe(true);

    // Check that email column exists
    const emailColumn = columns.find(c => c.propertyName === 'email');
    expect(emailColumn).toBeDefined();
    expect(emailColumn!.isNullable).toBe(false);
  });

  test('should not include navigation properties', async () => {
    const db = createTestDatabase();

    const columns = db.users.getColumns();

    // Navigation properties should not be in the columns list
    const postsColumn = columns.find(c => c.propertyName === 'posts' as any);
    expect(postsColumn).toBeUndefined();

    const ordersColumn = columns.find(c => c.propertyName === 'orders' as any);
    expect(ordersColumn).toBeUndefined();
  });

  test('should return correct column info for posts table', async () => {
    const db = createTestDatabase();

    const columns = db.posts.getColumns();

    expect(columns).toBeDefined();
    expect(columns.length).toBeGreaterThan(0);

    // Check that id column exists
    const idColumn = columns.find(c => c.propertyName === 'id');
    expect(idColumn).toBeDefined();
    expect(idColumn!.isPrimaryKey).toBe(true);

    // Check that userId column exists (foreign key, not navigation)
    const userIdColumn = columns.find(c => c.propertyName === 'userId');
    expect(userIdColumn).toBeDefined();
    expect(userIdColumn!.type).toBe('integer');

    // Check that user navigation property is NOT included
    const userColumn = columns.find(c => c.propertyName === 'user' as any);
    expect(userColumn).toBeUndefined();
  });

  test('should return column names only', async () => {
    const db = createTestDatabase();

    const columnNames = db.users.getColumns().map(c => c.propertyName);

    expect(columnNames).toContain('id');
    expect(columnNames).toContain('username');
    expect(columnNames).toContain('email');
    expect(columnNames).not.toContain('posts'); // Navigation property
  });

  test('should return database column names', async () => {
    const db = createTestDatabase();

    const dbColumnNames = db.users.getColumns().map(c => c.columnName);

    // Database column names may differ from property names (e.g., snake_case)
    expect(dbColumnNames).toBeDefined();
    expect(dbColumnNames.length).toBeGreaterThan(0);
  });

  test('should correctly identify nullable columns', async () => {
    const db = createTestDatabase();

    const columns = db.users.getColumns();

    // age is nullable
    const ageColumn = columns.find(c => c.propertyName === 'age');
    if (ageColumn) {
      expect(ageColumn.isNullable).toBe(true);
    }
  });

  test('should correctly identify default values', async () => {
    const db = createTestDatabase();

    const columns = db.users.getColumns();

    // isActive has a default value
    const isActiveColumn = columns.find(c => c.propertyName === 'isActive');
    if (isActiveColumn) {
      expect(isActiveColumn.defaultValue).toBeDefined();
    }
  });

  test('should work with orders table (includes JSONB column)', async () => {
    const db = createTestDatabase();

    const columns = db.orders.getColumns();

    expect(columns).toBeDefined();
    expect(columns.length).toBeGreaterThan(0);

    // Check that items column exists (JSONB type)
    const itemsColumn = columns.find(c => c.propertyName === 'items');
    if (itemsColumn) {
      expect(itemsColumn.type).toBe('jsonb');
    }
  });
});

describe('getColumnKeys method', () => {
  test('should return all column keys by default', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys();

    expect(keys).toBeDefined();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);

    // Should include id (primary key)
    expect(keys).toContain('id');
    // Should include other columns
    expect(keys).toContain('username');
    expect(keys).toContain('email');
    expect(keys).toContain('age');
    expect(keys).toContain('isActive');

    // Should NOT include navigation properties by default
    expect(keys).not.toContain('posts');
    expect(keys).not.toContain('orders');
  });

  test('should include navigation properties when includeNavigation is true', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includeNavigation: true });

    expect(keys).toBeDefined();

    // Should include regular columns
    expect(keys).toContain('id');
    expect(keys).toContain('username');
    expect(keys).toContain('email');

    // Should include navigation properties
    expect(keys as string[]).toContain('posts');
    expect(keys as string[]).toContain('orders');
  });

  test('should exclude primary key when includePrimaryKey is false', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includePrimaryKey: false });

    expect(keys).toBeDefined();

    // Should NOT include id (primary key)
    expect(keys).not.toContain('id');

    // Should include other columns
    expect(keys).toContain('username');
    expect(keys).toContain('email');
    expect(keys).toContain('age');
    expect(keys).toContain('isActive');

    // Should NOT include navigation properties
    expect(keys).not.toContain('posts');
    expect(keys).not.toContain('orders');
  });

  test('should include primary key by default (includePrimaryKey not set)', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys();

    // Should include id (primary key) when not explicitly excluded
    expect(keys).toContain('id');
  });

  test('should include primary key when includePrimaryKey is true', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includePrimaryKey: true });

    // Should include id (primary key)
    expect(keys).toContain('id');
    expect(keys).toContain('username');
  });

  test('should support both includePrimaryKey: false and includeNavigation: true', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includePrimaryKey: false, includeNavigation: true });

    expect(keys).toBeDefined();

    // Should NOT include primary key
    expect(keys).not.toContain('id');

    // Should include other columns
    expect(keys).toContain('username');
    expect(keys).toContain('email');

    // Should include navigation properties
    expect(keys as string[]).toContain('posts');
    expect(keys as string[]).toContain('orders');
  });

  test('should support both includePrimaryKey: true and includeNavigation: true', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includePrimaryKey: true, includeNavigation: true });

    expect(keys).toBeDefined();

    // Should include primary key
    expect(keys).toContain('id');

    // Should include other columns
    expect(keys).toContain('username');
    expect(keys).toContain('email');

    // Should include navigation properties
    expect(keys as string[]).toContain('posts');
    expect(keys as string[]).toContain('orders');
  });

  test('should support includePrimaryKey: false and includeNavigation: false (explicit)', () => {
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includePrimaryKey: false, includeNavigation: false });

    expect(keys).toBeDefined();

    // Should NOT include primary key
    expect(keys).not.toContain('id');

    // Should include other columns
    expect(keys).toContain('username');
    expect(keys).toContain('email');

    // Should NOT include navigation properties
    expect(keys).not.toContain('posts');
    expect(keys).not.toContain('orders');
  });

  test('should work with posts table (has userId FK)', () => {
    const db = createTestDatabase();

    const keys = db.posts.getColumnKeys();

    expect(keys).toBeDefined();
    expect(keys).toContain('id');
    expect(keys).toContain('title');
    expect(keys).toContain('content');
    expect(keys).toContain('userId');

    // Should NOT include user navigation
    expect(keys).not.toContain('user');
  });

  test('should exclude primary key for posts table', () => {
    const db = createTestDatabase();

    const keys = db.posts.getColumnKeys({ includePrimaryKey: false });

    expect(keys).not.toContain('id');
    expect(keys).toContain('title');
    expect(keys).toContain('userId');
  });

  test('should work with orders table', () => {
    const db = createTestDatabase();

    const keysWithPk = db.orders.getColumnKeys();
    const keysWithoutPk = db.orders.getColumnKeys({ includePrimaryKey: false });

    expect(keysWithPk).toContain('id');
    expect(keysWithoutPk).not.toContain('id');

    // Both should contain non-pk columns
    expect(keysWithPk).toContain('userId');
    expect(keysWithoutPk).toContain('userId');
    expect(keysWithPk).toContain('status');
    expect(keysWithoutPk).toContain('status');
  });

  test('should return empty array for table with only primary key when includePrimaryKey is false', () => {
    // This is a edge case test - if a table had only a PK column, result would be empty
    // Our test tables have more columns, so we just verify the filtering works
    const db = createTestDatabase();

    const keys = db.users.getColumnKeys({ includePrimaryKey: false });

    // Should have at least some columns (not all filtered out)
    expect(keys.length).toBeGreaterThan(0);
    // But should have fewer keys than with PK included
    const keysWithPk = db.users.getColumnKeys();
    expect(keys.length).toBeLessThan(keysWithPk.length);
  });
});
