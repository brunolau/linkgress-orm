import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';
import { FutureQueryRunner } from '../../src/query/future-query';

describe('Future Queries', () => {
  describe('Basic future() operations', () => {
    test('should create and execute a future query individually', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .select(u => ({ id: u.id, name: u.username }))
          .future();

        // Execute individually
        const users = await futureQuery.execute();

        expect(users).toHaveLength(3);
        expect(users[0]).toHaveProperty('id');
        expect(users[0]).toHaveProperty('name');
      });
    });

    test('should get SQL from future query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .select(u => ({ id: u.id, name: u.username }))
          .future();

        const sql = futureQuery.getSql();

        expect(sql).toContain('SELECT');
        expect(sql).toContain('users');
      });
    });
  });

  describe('futureFirstOrDefault() operations', () => {
    test('should return first result or null', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({ id: u.id, name: u.username }))
          .futureFirstOrDefault();

        const user = await futureQuery.execute();

        expect(user).not.toBeNull();
        expect(user?.name).toBe('alice');
      });
    });

    test('should return null when no results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .where(u => eq(u.username, 'nonexistent'))
          .select(u => ({ id: u.id, name: u.username }))
          .futureFirstOrDefault();

        const user = await futureQuery.execute();

        expect(user).toBeNull();
      });
    });
  });

  describe('futureCount() operations', () => {
    test('should return count of results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users.futureCount();

        const count = await futureQuery.execute();

        expect(count).toBe(3);
      });
    });

    test('should return count with where clause', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .where(u => eq(u.isActive, true))
          .futureCount();

        const count = await futureQuery.execute();

        expect(count).toBe(2); // alice and bob are active
      });
    });
  });

  describe('FutureQueryRunner.runAsync() - Sequential execution', () => {
    test('should execute multiple future queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q1 = db.users.select(u => ({ id: u.id, name: u.username })).future();
        const q2 = db.posts.select(p => ({ id: p.id, title: p.title })).future();

        const [users, posts] = await FutureQueryRunner.runAsync([q1, q2]);

        expect(users).toHaveLength(3);
        expect(posts.length).toBeGreaterThan(0);
      });
    });

    test('should handle mixed future query types', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q1 = db.users.select(u => ({ id: u.id, name: u.username })).future();
        const q2 = db.posts.where(p => eq(p.title, 'Alice Post 1')).select(p => p).futureFirstOrDefault();
        const q3 = db.users.futureCount();

        const [users, post, count] = await FutureQueryRunner.runAsync([q1, q2, q3]);

        expect(users).toHaveLength(3);
        expect(post).not.toBeNull();
        expect(count).toBe(3);
      });
    });

    test('should return correctly typed results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q1 = db.users.select(u => ({ name: u.username })).future();
        const q2 = db.users.where(u => eq(u.username, 'alice')).select(u => u).futureFirstOrDefault();
        const q3 = db.posts.futureCount();

        const [users, user, postCount] = await FutureQueryRunner.runAsync([q1, q2, q3] as const);

        // Type assertions - these should compile without errors
        const names: string[] = users.map(u => u.name);
        const userName: string | undefined = user?.username;
        const count: number = postCount;

        expect(names).toContain('alice');
        expect(userName).toBe('alice');
        expect(typeof count).toBe('number');
      });
    });

    test('should handle empty array of futures', async () => {
      await withDatabase(async (db) => {
        const results = await FutureQueryRunner.runAsync([]);
        expect(results).toEqual([]);
      });
    });

    test('should handle single future query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q1 = db.users.futureCount();
        const [count] = await FutureQueryRunner.runAsync([q1]);

        expect(count).toBe(3);
      });
    });
  });

  describe('Future queries with WHERE conditions', () => {
    test('should handle parameterized queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const q1 = db.users
          .where(u => gt(u.age, 30))
          .select(u => ({ name: u.username }))
          .future();

        const q2 = db.users
          .where(u => eq(u.isActive, true))
          .futureCount();

        const [olderUsers, activeCount] = await FutureQueryRunner.runAsync([q1, q2] as const);

        expect(olderUsers.length).toBe(2); // bob (35) and charlie (45)
        expect(activeCount).toBe(2);
      });
    });
  });

  describe('Future queries with ordering and limits', () => {
    test('should respect orderBy in future queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .select(u => ({ name: u.username }))
          .orderBy(u => u.name)
          .future();

        const users = await futureQuery.execute();

        expect(users[0].name).toBe('alice');
        expect(users[1].name).toBe('bob');
        expect(users[2].name).toBe('charlie');
      });
    });

    test('should respect limit in future queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .select(u => ({ name: u.username }))
          .orderBy(u => u.name)
          .limit(2)
          .future();

        const users = await futureQuery.execute();

        expect(users).toHaveLength(2);
      });
    });
  });

  describe('Future queries from different tables', () => {
    test('should execute queries from multiple tables', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersQuery = db.users.select(u => ({ name: u.username })).future();
        const postsQuery = db.posts.select(p => ({ title: p.title })).future();
        const userCountQuery = db.users.futureCount();
        const postCountQuery = db.posts.futureCount();

        const [users, posts, userCount, postCount] = await FutureQueryRunner.runAsync([
          usersQuery,
          postsQuery,
          userCountQuery,
          postCountQuery,
        ] as const);

        expect(users).toHaveLength(3);
        expect(posts.length).toBeGreaterThan(0);
        expect(userCount).toBe(3);
        expect(postCount).toBeGreaterThan(0);
      });
    });
  });

  describe('Type safety', () => {
    test('should preserve selection types through future()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const futureQuery = db.users
          .select(u => ({
            id: u.id,
            name: u.username,
            active: u.isActive,
          }))
          .future();

        const users = await futureQuery.execute();

        // Type checks - these would fail at compile time if types were wrong
        users.forEach(user => {
          expect(typeof user.id).toBe('number');
          expect(typeof user.name).toBe('string');
          expect(typeof user.active).toBe('boolean');
        });
      });
    });
  });
});
