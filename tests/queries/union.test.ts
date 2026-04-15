import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt } from '../../src';

describe('UNION Queries', () => {
  describe('Basic UNION operations', () => {
    test('should combine two queries with UNION (removes duplicates)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Get active users and users with age > 30 - there might be overlap
        const activeUsersQuery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, name: u.username }));

        const olderUsersQuery = db.users
          .where(u => gt(u.age, 30))
          .select(u => ({ id: u.id, name: u.username }));

        const result = await activeUsersQuery
          .union(olderUsersQuery)
          .toList();

        // Should have unique users (alice, bob, charlie - no duplicates)
        expect(result.length).toBeGreaterThan(0);
        const names = result.map(r => r.name);
        const uniqueNames = [...new Set(names)];
        expect(names.length).toBe(uniqueNames.length);
      });
    });

    test('should combine two queries with UNION ALL (keeps duplicates)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Get active users and users with age > 30 - bob matches both
        const activeUsersQuery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, name: u.username }));

        const olderUsersQuery = db.users
          .where(u => gt(u.age, 30))
          .select(u => ({ id: u.id, name: u.username }));

        const result = await activeUsersQuery
          .unionAll(olderUsersQuery)
          .toList();

        // UNION ALL keeps duplicates, so bob should appear twice
        // Active: alice, bob. Older: bob, charlie = 4 total
        expect(result.length).toBe(4);
      });
    });
  });

  describe('UNION with ordering and pagination', () => {
    test('should order combined results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const activeUsersQuery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, name: u.username }));

        const inactiveUsersQuery = db.users
          .where(u => eq(u.isActive, false))
          .select(u => ({ id: u.id, name: u.username }));

        const result = await activeUsersQuery
          .union(inactiveUsersQuery)
          .orderBy(r => r.name)
          .toList();

        expect(result.length).toBe(3);
        // Names should be in alphabetical order
        for (let i = 1; i < result.length; i++) {
          expect(result[i - 1].name.localeCompare(result[i].name)).toBeLessThanOrEqual(0);
        }
      });
    });

    test('should limit combined results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const activeUsersQuery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, name: u.username }));

        const inactiveUsersQuery = db.users
          .where(u => eq(u.isActive, false))
          .select(u => ({ id: u.id, name: u.username }));

        const result = await activeUsersQuery
          .union(inactiveUsersQuery)
          .orderBy(r => r.name)
          .limit(2)
          .toList();

        expect(result.length).toBe(2);
      });
    });

    test('should handle offset in combined results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const activeUsersQuery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, name: u.username }));

        const inactiveUsersQuery = db.users
          .where(u => eq(u.isActive, false))
          .select(u => ({ id: u.id, name: u.username }));

        const allResults = await activeUsersQuery
          .union(inactiveUsersQuery)
          .orderBy(r => r.name)
          .toList();

        const offsetResults = await activeUsersQuery
          .union(inactiveUsersQuery)
          .orderBy(r => r.name)
          .offset(1)
          .limit(2)
          .toList();

        expect(offsetResults.length).toBe(2);
        expect(offsetResults[0].name).toBe(allResults[1].name);
      });
    });
  });

  describe('Multiple UNION operations', () => {
    test('should chain multiple union operations', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({ name: u.username }));

        const query2 = db.users
          .where(u => eq(u.username, 'bob'))
          .select(u => ({ name: u.username }));

        const query3 = db.users
          .where(u => eq(u.username, 'charlie'))
          .select(u => ({ name: u.username }));

        const result = await query1
          .union(query2)
          .union(query3)
          .orderBy(r => r.name)
          .toList();

        expect(result.length).toBe(3);
        expect(result.map(r => r.name)).toEqual(['alice', 'bob', 'charlie']);
      });
    });

    test('should mix UNION and UNION ALL', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({ name: u.username }));

        const query2 = db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({ name: u.username }));

        const query3 = db.users
          .where(u => eq(u.username, 'bob'))
          .select(u => ({ name: u.username }));

        // UNION removes alice duplicate, UNION ALL keeps bob
        const result = await query1
          .union(query2)  // alice appears once after this
          .unionAll(query3)
          .toList();

        expect(result.length).toBe(2);
      });
    });
  });

  describe('UNION with different tables', () => {
    test('should union queries from different tables with compatible columns', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Select names from users and titles from posts as a unified "name" column
        const usersQuery = db.users
          .select(u => ({ name: u.username }));

        const postsQuery = db.posts
          .select(p => ({ name: p.title }));

        const result = await usersQuery
          .union(postsQuery)
          .orderBy(r => r.name)
          .toList();

        // Should contain both usernames and post titles
        expect(result.length).toBeGreaterThan(3);
        const names = result.map(r => r.name);
        expect(names).toContain('alice');
        expect(names).toContain('bob');
        // Should contain post titles too
        expect(names.some(n => n?.includes('Post'))).toBe(true);
      });
    });
  });

  describe('UNION helper methods', () => {
    test('should get first result with firstOrDefault()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .select(u => ({ name: u.username }));

        const query2 = db.posts
          .select(p => ({ name: p.title }));

        const result = await query1
          .union(query2)
          .orderBy(r => r.name)
          .firstOrDefault();

        expect(result).not.toBeNull();
        expect(['alice', 'Alice Post 1']).toContain(result?.name);
      });
    });

    test('should return null when no results with firstOrDefault()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .where(u => eq(u.username, 'nonexistent'))
          .select(u => ({ name: u.username }));

        const query2 = db.posts
          .where(p => eq(p.title, 'nonexistent'))
          .select(p => ({ name: p.title }));

        const result = await query1
          .union(query2)
          .firstOrDefault();

        expect(result).toBeNull();
      });
    });

    test('should count combined results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id }));

        const query2 = db.users
          .where(u => eq(u.isActive, false))
          .select(u => ({ id: u.id }));

        const count = await query1
          .union(query2)
          .count();

        expect(count).toBe(3);
      });
    });

    test('should generate correct SQL with toSql()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .select(u => ({ name: u.username }));

        const query2 = db.posts
          .select(p => ({ name: p.title }));

        const sql = query1
          .union(query2)
          .orderBy(r => r.name)
          .limit(10)
          .toSql();

        expect(sql).toContain('UNION');
        expect(sql).toContain('ORDER BY');
        expect(sql).toContain('LIMIT 10');
      });
    });
  });

  describe('UNION with WHERE conditions and parameters', () => {
    test('should handle parameterized queries in union', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const query1 = db.users
          .where(u => gt(u.age, 20))
          .select(u => ({ id: u.id, name: u.username }));

        const query2 = db.users
          .where(u => lt(u.age, 40))
          .select(u => ({ id: u.id, name: u.username }));

        const result = await query1
          .union(query2)
          .orderBy(r => r.name)
          .toList();

        // All users should match at least one condition
        expect(result.length).toBe(3);
      });
    });
  });
});
