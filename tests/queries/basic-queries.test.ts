import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt, gte, lte, like, and, or, not } from '../../src';

describe('Basic Query Operations', () => {
  describe('SELECT queries', () => {
    test('should select all users', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users.toList();

        expect(users).toHaveLength(3);
        expect(users[0]).toHaveProperty('username');
        expect(users[0]).toHaveProperty('email');
      });
    });

    test('should select with projection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .select(u => ({
            name: u.username,
            userEmail: u.email,
          }))
          .toList();

        expect(users).toHaveLength(3);
        expect(users[0]).toHaveProperty('name');
        expect(users[0]).toHaveProperty('userEmail');
        expect(users[0]).not.toHaveProperty('username');
      });
    });

    test('should select distinct values', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create duplicate posts with same title
        await db.posts.insert({ title: 'Duplicate', content: 'C1', userId: users.alice.id, views: 10 });
        await db.posts.insert({ title: 'Duplicate', content: 'C2', userId: users.bob.id, views: 20 });
        await db.posts.insert({ title: 'Duplicate', content: 'C3', userId: users.charlie.id, views: 30 });

        const titles = await db.posts
          .selectDistinct(p => ({ title: p.title }))
          .toList();

        const duplicates = titles.filter(t => t.title === 'Duplicate');
        expect(duplicates).toHaveLength(1);
      });
    });
  });

  describe('WHERE conditions', () => {
    test('should filter with eq condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => eq(u.username, 'alice'))
          .toList();

        expect(users).toHaveLength(1);
        expect(users[0].username).toBe('alice');
      });
    });

    test('should filter with gt condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => gt(u.age!, 30))
          .toList();

        expect(users.length).toBeGreaterThanOrEqual(2);
        users.forEach(u => {
          expect(u.age).toBeGreaterThan(30);
        });
      });
    });

    test('should filter with multiple conditions using and', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => and(
            gt(u.age!, 20),
            eq(u.isActive, true)
          ))
          .toList();

        expect(users.length).toBeGreaterThan(0);
        users.forEach(u => {
          expect(u.age).toBeGreaterThan(20);
          expect(u.isActive).toBe(true);
        });
      });
    });

    test('should filter with or condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => or(
            eq(u.username, 'alice'),
            eq(u.username, 'bob')
          ))
          .toList();

        expect(users).toHaveLength(2);
      });
    });

    test('should filter with not condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => not(eq(u.isActive, true)))
          .toList();

        expect(users.length).toBeGreaterThan(0);
        users.forEach(u => {
          expect(u.isActive).toBe(false);
        });
      });
    });

    test('should filter with like condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .where(u => like(u.email, '%test.com'))
          .toList();

        expect(users.length).toBeGreaterThan(0);
        users.forEach(u => {
          expect(u.email).toContain('test.com');
        });
      });
    });
  });

  describe('Ordering and Pagination', () => {
    test('should order by field ascending', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users.select(p => ({
          id: p.id,
          age: p.age
        })).orderBy(p => p.age)
          .toList();

        expect(users).toHaveLength(3);
        expect(users[0].age).toBeLessThanOrEqual(users[1].age!);
        expect(users[1].age).toBeLessThanOrEqual(users[2].age!);
      });
    });

    test('should order by field descending', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .orderBy(u => [[u.age, 'DESC']])
          .toList();

        expect(users).toHaveLength(3);
        expect(users[0].age).toBeGreaterThanOrEqual(users[1].age!);
        expect(users[1].age).toBeGreaterThanOrEqual(users[2].age!);
      });
    });

    test('should limit results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const users = await db.users
          .limit(2)
          .toList();

        expect(users).toHaveLength(2);
      });
    });

    test('should offset results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const allUsers = await db.users.orderBy(u => u.id).toList();
        const offsetUsers = await db.users
          .orderBy(u => u.id)
          .offset(1)
          .toList();

        expect(offsetUsers).toHaveLength(2);
        expect(offsetUsers[0].id).toBe(allUsers[1].id);
      });
    });

    test('should combine limit and offset for pagination', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const page1 = await db.users
          .orderBy(u => u.id)
          .limit(2)
          .offset(0)
          .toList();

        const page2 = await db.users
          .orderBy(u => u.id)
          .limit(2)
          .offset(2)
          .toList();

        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(1);
        expect(page1[0].id).not.toBe(page2[0].id);
      });
    });
  });

  describe('First operations', () => {
    test('should get first record', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .orderBy(u => u.username)
          .first();

        expect(user).toBeDefined();
        expect(user.username).toBe('alice');
      });
    });

    test('should get firstOrDefault when record exists', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .where(u => eq(u.username, 'alice'))
          .firstOrDefault();

        expect(user).not.toBeNull();
        expect(user?.username).toBe('alice');
      });
    });

    test('should return null for firstOrDefault when no record exists', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const user = await db.users
          .where(u => eq(u.username, 'nonexistent'))
          .firstOrDefault();

        expect(user).toBeNull();
      });
    });
  });

  describe('Count operations', () => {
    test('should count all records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const count = await db.users.count();

        expect(count).toBe(3);
      });
    });

    test('should count filtered records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const count = await db.users
          .where(u => eq(u.isActive, true))
          .count();

        expect(count).toBe(2);
      });
    });
  });
});
