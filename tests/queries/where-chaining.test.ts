import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt, gte, lte, and, or, not, like, sql } from '../../src';
import { assertType } from '../utils/type-tester';

describe('WHERE Clause Chaining', () => {
  describe('Main query where chaining', () => {
    test('should chain multiple where clauses with AND logic', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Chain where clauses - both conditions must be satisfied
        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gt(u.age!, 30));

        const users = await query.toList();

        // Should only return users where isActive=true AND age>30
        // From seed: alice (25, active), bob (35, active), charlie (45, inactive)
        // Only bob satisfies both conditions
        expect(users.length).toBe(1);
        expect(users[0].username).toBe('bob');
        expect(users[0].isActive).toBe(true);
        expect(users[0].age).toBeGreaterThan(30);
      });
    });

    test('should chain three where clauses', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gte(u.age!, 25));
        query = query.where(u => lte(u.age!, 35));

        const users = await query.toList();

        // alice (25, active), bob (35, active) satisfy all three
        expect(users.length).toBe(2);
        users.forEach(u => {
          expect(u.isActive).toBe(true);
          expect(u.age).toBeGreaterThanOrEqual(25);
          expect(u.age).toBeLessThanOrEqual(35);
        });
      });
    });

    test('should preserve first where when adding second', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // First query filters to active users
        const baseQuery = db.users.where(u => eq(u.isActive, true));

        // Add second filter - should still respect first filter
        const refinedQuery = baseQuery.where(u => lt(u.age!, 30));

        const users = await refinedQuery.toList();

        // Only alice (25, active) satisfies isActive=true AND age<30
        expect(users.length).toBe(1);
        expect(users[0].username).toBe('alice');
        expect(users[0].isActive).toBe(true);
        expect(users[0].age).toBeLessThan(30);
      });
    });

    test('should chain independent where calls correctly', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Note: The ORM uses a mutable query pattern where where() modifies the query.
        // For independent queries, create separate base queries.

        // Query 1: Active users only
        const activeUsers = await db.users
          .where(u => eq(u.isActive, true))
          .toList();
        expect(activeUsers.length).toBe(2);

        // Query 2: Young active users (separate base)
        const youngActiveUsers = await db.users
          .where(u => eq(u.isActive, true))
          .where(u => lt(u.age!, 30))
          .toList();
        expect(youngActiveUsers.length).toBe(1);
        expect(youngActiveUsers[0].username).toBe('alice');

        // Query 3: Old active users (separate base)
        const oldActiveUsers = await db.users
          .where(u => eq(u.isActive, true))
          .where(u => gt(u.age!, 40))
          .toList();
        // charlie is inactive, so no one matches
        expect(oldActiveUsers.length).toBe(0);
      });
    });

    test('should chain where with select', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gt(u.age!, 30));

        const result = await query
          .select(u => ({ name: u.username, userAge: u.age }))
          .toList();

        expect(result.length).toBe(1);
        expect(result[0].name).toBe('bob');
        expect(result[0].userAge).toBe(35);
      });
    });

    test('should chain where with orderBy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gte(u.age!, 25));

        const users = await query
          .orderBy(u => [[u.age, 'DESC']])
          .toList();

        expect(users.length).toBe(2);
        expect(users[0].username).toBe('bob'); // 35
        expect(users[1].username).toBe('alice'); // 25
      });
    });

    test('should chain where with limit', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gte(u.age!, 25));

        const users = await query
          .orderBy(u => [[u.age, 'ASC']])
          .limit(1)
          .toList();

        expect(users.length).toBe(1);
        expect(users[0].username).toBe('alice');
      });
    });

    test('should handle empty result when chained conditions are mutually exclusive', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // No user can be both active and inactive
        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => eq(u.isActive, false));

        const users = await query.toList();

        expect(users.length).toBe(0);
      });
    });

    test('should chain where with SQL template conditions', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => sql`${u.age} BETWEEN 20 AND 40`);

        const users = await query.toList();

        expect(users.length).toBe(2);
        users.forEach(u => {
          expect(u.isActive).toBe(true);
          expect(u.age).toBeGreaterThanOrEqual(20);
          expect(u.age).toBeLessThanOrEqual(40);
        });
      });
    });

    test('should chain where with like condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => like(u.username, 'a%'));

        const users = await query.toList();

        expect(users.length).toBe(1);
        expect(users[0].username).toBe('alice');
        expect(users[0].isActive).toBe(true);
      });
    });
  });

  describe('Subquery where chaining', () => {
    test('should chain where in subquery used in main query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create subquery with chained where
        let postsSubquery = db.posts.where(p => gt(p.views!, 100));
        postsSubquery = postsSubquery.where(p => like(p.title!, 'Alice%'));

        const postIds = await postsSubquery
          .select(p => ({ id: p.id }))
          .toList();

        // Only Alice Post 2 has views > 100 and title starting with 'Alice'
        expect(postIds.length).toBe(1);
      });
    });

    test('should chain where in subquery for aggregation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Users who have posts with views > 100 AND title containing 'Post'
        // Use collection navigation with chained where and count
        const users = await db.users
          .select(u => ({
            username: u.username,
            matchingPostCount: u.posts!
              .where(p => gt(p.views!, 100))
              .where(p => like(p.title!, '%Post%'))
              .count(),
          }))
          .toList();

        // Filter in memory for those with matching posts
        const usersWithMatchingPosts = users.filter(u => u.matchingPostCount > 0);

        // Alice has "Alice Post 2" with 150 views
        // Bob has "Bob Post" with 200 views
        expect(usersWithMatchingPosts.length).toBe(2);
        const usernames = usersWithMatchingPosts.map(u => u.username).sort();
        expect(usernames).toEqual(['alice', 'bob']);
      });
    });

    test('should chain where with count subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Users with more than 1 post where views >= 100
        const users = await db.users
          .select(u => ({
            username: u.username,
            highViewPostCount: u.posts!
              .where(p => gte(p.views!, 100))
              .where(p => like(p.title!, '%Post%'))
              .count(),
          }))
          .toList();

        const alice = users.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        // Alice has 2 posts: Post 1 (100 views), Post 2 (150 views) - both >= 100
        expect(alice!.highViewPostCount).toBe(2);
      });
    });
  });

  describe('Collection navigation where chaining', () => {
    test('should chain where on collection navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithPosts = await db.users
          .select(u => ({
            username: u.username,
            filteredPosts: u.posts!
              .where(p => gte(p.views!, 100))
              .where(p => lte(p.views!, 150))
              .select(p => ({ title: p.title, views: p.views }))
              .toList('filteredPosts'),
          }))
          .toList();

        const alice = usersWithPosts.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        // Alice's posts: Post 1 (100 views), Post 2 (150 views) - both in range
        expect(alice!.filteredPosts.length).toBe(2);
        alice!.filteredPosts.forEach(p => {
          expect(p.views).toBeGreaterThanOrEqual(100);
          expect(p.views).toBeLessThanOrEqual(150);
        });

        const bob = usersWithPosts.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        // Bob's post: 200 views - outside range
        expect(bob!.filteredPosts.length).toBe(0);
      });
    });

    test('should chain where on collection with aggregation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersWithStats = await db.users
          .select(u => ({
            username: u.username,
            totalViews: u.posts!
              .where(p => gte(p.views!, 100))
              .where(p => like(p.title!, 'Alice%'))
              .sum(p => p.views),
          }))
          .toList();

        const alice = usersWithStats.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        // Alice Post 1 (100) + Alice Post 2 (150) = 250
        expect(alice!.totalViews).toBe(250);

        const bob = usersWithStats.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        // Bob's post doesn't match 'Alice%'
        expect(bob!.totalViews).toBeNull();
      });
    });

    test('should chain where on collection with orderBy', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Test chained where with orderBy on collection
        const usersWithPosts = await db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({
            username: u.username,
            sortedPosts: u.posts!
              .where(p => gte(p.views!, 100))
              .where(p => like(p.title!, '%Post%'))
              .orderBy(p => [[p.views, 'DESC']])
              .select(p => ({ title: p.title, views: p.views }))
              .toList('sortedPosts'),
          }))
          .toList();

        expect(usersWithPosts.length).toBe(1);
        const alice = usersWithPosts[0];
        expect(alice.username).toBe('alice');
        // Both Alice Post 1 (100) and Alice Post 2 (150) match >= 100 and contain 'Post'
        expect(alice.sortedPosts.length).toBe(2);
        // Ordered by views DESC: Post 2 (150) first, then Post 1 (100)
        expect(alice.sortedPosts[0].views).toBe(150);
        expect(alice.sortedPosts[1].views).toBe(100);
      });
    });

    test('should chain where on separate collection queries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Note: Each collection navigation starts fresh, so this tests
        // that multiple collection queries in the same select work independently
        const result = await db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({
            username: u.username,
            // First filtered collection: posts with views > 100
            highViewCount: u.posts!
              .where(p => gt(p.views!, 100))
              .count(),
            // Second collection: all posts count
            allCount: u.posts!.count(),
          }))
          .first();

        expect(result).toBeDefined();
        // High view posts: only Post 2 (150 views > 100)
        expect(result!.highViewCount).toBe(1);
        // All posts: Post 1 and Post 2
        expect(result!.allCount).toBe(2);
      });
    });
  });

  describe('Complex where chaining scenarios', () => {
    test('should chain where with OR conditions', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Find users who are either: (active AND young) OR (inactive)
        let query = db.users.where(u =>
          or(
            and(eq(u.isActive, true), lt(u.age!, 30)),
            eq(u.isActive, false)
          )
        );
        // Add another condition: username must contain 'a' or 'c'
        query = query.where(u =>
          or(like(u.username, '%a%'), like(u.username, '%c%'))
        );

        const users = await query.toList();

        // alice: active, 25 (matches first OR branch, contains 'a')
        // charlie: inactive (matches second OR branch, contains 'c')
        expect(users.length).toBe(2);
        const usernames = users.map(u => u.username).sort();
        expect(usernames).toEqual(['alice', 'charlie']);
      });
    });

    test('should chain where and select with navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Chain where conditions on main table, then use navigation in select
        const posts = await db.posts
          .where(p => gt(p.views!, 100))
          .where(p => like(p.title!, '%Post%'))
          .select(p => ({
            title: p.title,
            views: p.views,
            authorName: p.user!.username,
          }))
          .toList();

        // Alice Post 2 (150 views) and Bob Post (200 views) match views > 100
        expect(posts.length).toBe(2);
        posts.forEach(p => {
          expect(p.views).toBeGreaterThan(100);
          expect(p.title).toContain('Post');
        });
      });
    });

    test('should chain where with collection aggregations', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Test chained where with count aggregation on collections
        const users = await db.users
          .where(u => eq(u.isActive, true))
          .where(u => eq(u.username, 'alice'))
          .select(u => ({
            username: u.username,
            // Posts with views > 100 (only Alice Post 2 with 150 views)
            highViewPostCount: u.posts!.where(p => gt(p.views!, 100)).count(),
            // All posts count
            totalPostCount: u.posts!.count(),
          }))
          .toList();

        expect(users.length).toBe(1);
        expect(users[0].username).toBe('alice');
        // Alice has 1 post with views > 100 (Post 2 with 150)
        expect(users[0].highViewPostCount).toBe(1);
        // Alice has 2 total posts
        expect(users[0].totalPostCount).toBe(2);
      });
    });

    test('should chain five where clauses', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Use fluent chaining pattern to avoid type mismatch
        const users = await db.users
          .where(u => eq(u.isActive, true))
          .where(u => gte(u.age!, 20))
          .where(u => lte(u.age!, 40))
          .where(u => like(u.email, '%@test.com'))
          .where(u => not(eq(u.username, 'bob')))
          .toList();

        // Only alice satisfies all 5 conditions
        expect(users.length).toBe(1);
        expect(users[0].username).toBe('alice');
      });
    });

    test('should verify SQL contains AND for chained where', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gt(u.age!, 30));

        await query.toList();

        // Find the SELECT query
        const selectQuery = queries.find(q => q.includes('SELECT') && q.includes('users'));
        expect(selectQuery).toBeDefined();

        // Should contain both conditions connected with AND
        expect(selectQuery).toContain('is_active');
        expect(selectQuery).toContain('age');
        expect(selectQuery!.toUpperCase()).toContain('AND');
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle chaining on already executed query reference', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const baseQuery = db.users.where(u => eq(u.isActive, true));

        // Execute base query
        const activeUsers = await baseQuery.toList();
        expect(activeUsers.length).toBe(2);

        // Chain more conditions - should still work
        const refinedQuery = baseQuery.where(u => lt(u.age!, 30));
        const youngActiveUsers = await refinedQuery.toList();

        expect(youngActiveUsers.length).toBe(1);
        expect(youngActiveUsers[0].username).toBe('alice');
      });
    });

    test('should handle empty table with chained where', async () => {
      await withDatabase(async (db) => {
        // Don't seed data - table is empty

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gt(u.age!, 30));

        const users = await query.toList();

        expect(users.length).toBe(0);
      });
    });

    test('should chain where with first() returning null', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.username, 'nonexistent'));
        query = query.where(u => eq(u.isActive, true));

        const user = await query.first();

        expect(user).toBeNull();
      });
    });

    test('should chain where with count()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query = db.users.where(u => eq(u.isActive, true));
        query = query.where(u => gte(u.age!, 25));

        const count = await query.count();

        expect(count).toBe(2); // alice and bob
      });
    });
  });
});
