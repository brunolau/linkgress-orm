import { describe, test, expect } from '@jest/globals';
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
