import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src';

describe('countOver()', () => {
  test('should return data and totalCount in a single query', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users.countOver();

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('totalCount');
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBe(result.totalCount);
      expect(result.totalCount).toBe(3); // alice, bob, charlie
    });
  });

  test('should work with where clause', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .where(u => eq(u.isActive, true))
        .countOver();

      expect(result.totalCount).toBe(2); // alice and bob are active
      expect(result.data.length).toBe(2);
    });
  });

  test('should return correct totalCount with limit and offset (pagination)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .orderBy(u => u.id)
        .limit(2)
        .offset(0)
        .countOver();

      // totalCount should reflect all matching rows, not just the page
      expect(result.totalCount).toBe(3);
      expect(result.data.length).toBe(2);
    });
  });

  test('should return correct totalCount for second page', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .orderBy(u => u.id)
        .limit(2)
        .offset(2)
        .countOver();

      expect(result.totalCount).toBe(3);
      expect(result.data.length).toBe(1); // only 1 user on second page
    });
  });

  test('should return totalCount 0 and empty data when no rows match', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .where(u => eq(u.username, 'nonexistent'))
        .countOver();

      expect(result.totalCount).toBe(0);
      expect(result.data).toEqual([]);
    });
  });

  test('should work with select()', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .select(u => ({
          name: u.username,
          email: u.email,
        }))
        .limit(2)
        .countOver();

      expect(result.totalCount).toBe(3);
      expect(result.data.length).toBe(2);
      expect(result.data[0]).toHaveProperty('name');
      expect(result.data[0]).toHaveProperty('email');
    });
  });

  test('should work with where and pagination combined', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .where(u => eq(u.isActive, true))
        .orderBy(u => u.username)
        .limit(1)
        .offset(0)
        .countOver();

      // 2 active users total, but only 1 returned due to limit
      expect(result.totalCount).toBe(2);
      expect(result.data.length).toBe(1);
    });
  });
});
