import { describe, test, expect } from '@jest/globals';
import { expectToReject } from '../utils/expect-rejects';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt, gte, lte, and, or, like, sql, PreparedQuery, inSubquery } from '../../src';

describe('Prepared Statements', () => {
  describe('Basic prepared queries', () => {
    test('should prepare a query with a single placeholder', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create a prepared query
        const getUserById = db.users
          .where(u => eq(u.id, sql.placeholder('userId')))
          .prepare('getUserById');

        // Verify it's a PreparedQuery instance
        expect(getUserById).toBeInstanceOf(PreparedQuery);
        expect(getUserById.name).toBe('getUserById');

        // Execute with alice's ID
        const result1 = await getUserById.execute({ userId: users.alice.id });
        expect(result1).toHaveLength(1);
        expect(result1[0].username).toBe('alice');

        // Execute with bob's ID
        const result2 = await getUserById.execute({ userId: users.bob.id });
        expect(result2).toHaveLength(1);
        expect(result2[0].username).toBe('bob');
      });
    });

    test('should prepare a query with multiple placeholders', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create a prepared query with multiple placeholders
        // Seed data has ages: alice=25, bob=35, charlie=45
        const searchUsers = db.users
          .where(u => and(
            gt(u.age, sql.placeholder('minAge')),
            lt(u.age, sql.placeholder('maxAge'))
          ))
          .prepare('searchUsers');

        // Execute with age range 20-40 (should match alice=25 and bob=35)
        const result1 = await searchUsers.execute({ minAge: 20, maxAge: 40 });
        expect(result1.length).toBe(2);
        result1.forEach(u => {
          expect(u.age).toBeGreaterThan(20);
          expect(u.age).toBeLessThan(40);
        });

        // Execute with different age range 30-50 (should match bob=35 and charlie=45)
        const result2 = await searchUsers.execute({ minAge: 30, maxAge: 50 });
        expect(result2.length).toBe(2);
        result2.forEach(u => {
          expect(u.age).toBeGreaterThan(30);
          expect(u.age).toBeLessThan(50);
        });
      });
    });

    test('should throw error for missing parameter', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const getUserById = db.users
          .where(u => eq(u.id, sql.placeholder('userId')))
          .prepare('getUserById');

        // Should throw when parameter is missing
        await expectToReject(
          getUserById.execute({} as any)
        , 'Missing parameter: userId');
      });
    });

    test('should prepare a query with select projection', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create prepared query with selection
        const getUserEmail = db.users
          .select(u => ({ id: u.id, email: u.email }))
          .where(u => eq(u.id, sql.placeholder('userId')))
          .prepare('getUserEmail');

        const result = await getUserEmail.execute({ userId: users.alice.id });
        expect(result).toHaveLength(1);
        expect(result[0]).toHaveProperty('id');
        expect(result[0]).toHaveProperty('email');
        expect(result[0]).not.toHaveProperty('username');
      });
    });

    test('should reuse prepared query multiple times', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const getUserById = db.users
          .where(u => eq(u.id, sql.placeholder('id')))
          .prepare('getUserById');

        // Execute multiple times with different IDs
        const userIds = [users.alice.id, users.bob.id, users.charlie.id];
        const usernames: string[] = [];

        for (const id of userIds) {
          const result = await getUserById.execute({ id });
          usernames.push(result[0].username);
        }

        expect(usernames).toHaveLength(3);
        expect(usernames).toContain('alice');
        expect(usernames).toContain('bob');
        expect(usernames).toContain('charlie');
      });
    });
  });

  describe('Placeholder in sql template', () => {
    test('should support placeholder in sql template expressions', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Using placeholder within sql template
        const searchByPattern = db.users
          .where(u => like(u.username, sql.placeholder('pattern')))
          .prepare('searchByPattern');

        const result = await searchByPattern.execute({ pattern: 'a%' });
        expect(result.length).toBeGreaterThan(0);
        result.forEach(u => {
          expect(u.username.toLowerCase().startsWith('a')).toBe(true);
        });
      });
    });
  });

  describe('Prepared query utilities', () => {
    test('should return SQL string via getSql()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => eq(u.id, sql.placeholder('userId')))
          .prepare('test');

        const sqlString = prepared.getSql();
        expect(typeof sqlString).toBe('string');
        expect(sqlString).toContain('SELECT');
        expect(sqlString).toContain('$1');
      });
    });

    test('should return placeholder names', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => and(
            eq(u.id, sql.placeholder('userId')),
            gt(u.age, sql.placeholder('minAge'))
          ))
          .prepare('test');

        const names = prepared.getPlaceholderNames();
        expect(names).toContain('userId');
        expect(names).toContain('minAge');
        expect(names).toHaveLength(2);
      });
    });
  });

  describe('Prepared queries with different data types', () => {
    test('should handle string placeholders', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const getUserByUsername = db.users
          .where(u => eq(u.username, sql.placeholder('username')))
          .prepare('getUserByUsername');

        const result = await getUserByUsername.execute({ username: 'alice' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(users.alice.id);
      });
    });

    test('should handle boolean placeholders', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const getUsersByStatus = db.users
          .where(u => eq(u.isActive, sql.placeholder('isActive')))
          .prepare('getUsersByStatus');

        const activeUsers = await getUsersByStatus.execute({ isActive: true });
        expect(activeUsers.length).toBeGreaterThan(0);
        activeUsers.forEach(u => expect(u.isActive).toBe(true));

        const inactiveUsers = await getUsersByStatus.execute({ isActive: false });
        inactiveUsers.forEach(u => expect(u.isActive).toBe(false));
      });
    });

    test('should handle null placeholders for optional fields', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Insert a user without age
        await db.users.insert({
          username: 'noage',
          email: 'noage@test.com',
          isActive: true,
        });

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .prepare('getUsersWithMinAge');

        // Should only return users where age > 30
        const result = await prepared.execute({ minAge: 30 });
        result.forEach(u => {
          expect(u.age).toBeDefined();
          expect(u.age!).toBeGreaterThan(30);
        });
      });
    });
  });

  describe('Integration with limit/offset', () => {
    test('should work with limit()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .limit(2)
          .prepare('limitedUsers');

        const result = await prepared.execute({ minAge: 0 });
        expect(result.length).toBeLessThanOrEqual(2);
      });
    });

    test('should work with orderBy()', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .orderBy(u => u.username)
          .prepare('orderedUsers');

        const result = await prepared.execute({ minAge: 0 });
        expect(result.length).toBeGreaterThan(0);

        // Verify ordering
        for (let i = 1; i < result.length; i++) {
          expect(result[i].username >= result[i - 1].username).toBe(true);
        }
      });
    });
  });

  describe('Complex queries with placeholders', () => {
    test('should work with joins and placeholders', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Prepare query with join
        const getUserWithPosts = db.users
          .leftJoin(
            db.posts,
            (u, p) => eq(u.id, p.userId),
            (u, p) => ({
              userId: u.id,
              username: u.username,
              postTitle: p.title,
            })
          )
          .where(u => eq(u.userId, sql.placeholder('userId')))
          .prepare('getUserWithPosts');

        // Execute for alice (has posts)
        const aliceResults = await getUserWithPosts.execute({ userId: users.alice.id });
        expect(aliceResults.length).toBeGreaterThan(0);
        aliceResults.forEach(r => {
          expect(r.username).toBe('alice');
          expect(r.userId).toBe(users.alice.id);
        });

        // Execute for bob (has posts)
        const bobResults = await getUserWithPosts.execute({ userId: users.bob.id });
        expect(bobResults.length).toBeGreaterThan(0);
        bobResults.forEach(r => {
          expect(r.username).toBe('bob');
        });
      });
    });

    test('should work with nested object selection and placeholders', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const prepared = db.users
          .select(u => ({
            id: u.id,
            profile: {
              name: u.username,
              contact: {
                email: u.email,
                active: u.isActive,
              },
            },
          }))
          .where(u => eq(u.id, sql.placeholder('userId')))
          .prepare('getUserProfile');

        const result = await prepared.execute({ userId: users.alice.id });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(users.alice.id);
        expect(result[0].profile.name).toBe('alice');
        expect(result[0].profile.contact.email).toBe('alice@test.com');
        expect(result[0].profile.contact.active).toBe(true);
      });
    });

    test('should work with multiple conditions using OR', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const prepared = db.users
          .where(u => or(
            eq(u.id, sql.placeholder('id1')),
            eq(u.id, sql.placeholder('id2'))
          ))
          .orderBy(u => u.id)
          .prepare('getUsersByIds');

        // Get alice and bob
        const result = await prepared.execute({
          id1: users.alice.id,
          id2: users.bob.id
        });
        expect(result).toHaveLength(2);
        expect(result.map(u => u.username)).toContain('alice');
        expect(result.map(u => u.username)).toContain('bob');
      });
    });

    test('should work with complex AND/OR combinations', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Complex condition: (age > minAge AND age < maxAge) OR username LIKE pattern
        const prepared = db.users
          .where(u => or(
            and(
              gt(u.age, sql.placeholder('minAge')),
              lt(u.age, sql.placeholder('maxAge'))
            ),
            like(u.username, sql.placeholder('pattern'))
          ))
          .orderBy(u => u.username)
          .prepare('complexSearch');

        // Should find users with age 30-40 OR username starting with 'c'
        const result = await prepared.execute({
          minAge: 30,
          maxAge: 40,
          pattern: 'c%'
        });

        // bob (age 35) and charlie (username starts with 'c')
        expect(result.length).toBeGreaterThanOrEqual(2);
        const usernames = result.map(u => u.username);
        expect(usernames).toContain('bob'); // age 35
        expect(usernames).toContain('charlie'); // username matches
      });
    });
  });

  describe('Placeholders with collections (navigation properties)', () => {
    test('should work with collection where clause using placeholder', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Query users with their posts filtered by minimum views
        const prepared = db.users
          .select(u => ({
            id: u.id,
            username: u.username,
            highViewPosts: u.posts!
              .where(p => gt(p.views!, sql.placeholder('minViews')))
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList(),
          }))
          .where(u => eq(u.id, sql.placeholder('userId')))
          .prepare('getUserHighViewPosts');

        // Alice has posts with views 100 and 150
        // Using minViews: 140 should only return the post with 150 views
        const result = await prepared.execute({ userId: users.alice.id, minViews: 140 });
        expect(result).toHaveLength(1);
        expect(result[0].username).toBe('alice');
        // Only the post with 150 views should be returned (views > 140)
        expect(result[0].highViewPosts.length).toBe(1);
        expect(result[0].highViewPosts[0].views).toBe(150);
      });
    });

    test('should work with collection count and placeholder filter', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .select(u => ({
            id: u.id,
            username: u.username,
            postCount: u.posts!.count(),
            highViewPostCount: u.posts!
              .where(p => gte(p.views!, sql.placeholder('minViews')))
              .count(),
          }))
          .orderBy(u => u.id)
          .prepare('getUserPostCounts');

        // Users with age > 20 (alice=25, bob=35, charlie=45)
        const result = await prepared.execute({ minAge: 20, minViews: 100 });
        expect(result.length).toBe(3);

        // Alice has 2 posts total, both with views >= 100
        const alice = result.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.postCount).toBe(2);
        expect(alice!.highViewPostCount).toBe(2);
      });
    });

    test('should work with firstOrDefault in collection with placeholder', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const prepared = db.users
          .where(u => eq(u.id, sql.placeholder('userId')))
          .select(u => ({
            id: u.id,
            username: u.username,
            latestHighViewPost: u.posts!
              .where(p => gte(p.views!, sql.placeholder('minViews')))
              .orderBy(p => [[p.views, 'DESC']])
              .firstOrDefault(),
          }))
          .prepare('getLatestHighViewPost');

        // Get alice's latest post with >= 100 views
        const result = await prepared.execute({ userId: users.alice.id, minViews: 100 });
        expect(result).toHaveLength(1);
        expect(result[0].latestHighViewPost).not.toBeNull();
        expect(result[0].latestHighViewPost!.views).toBeGreaterThanOrEqual(100);
      });
    });

    test('should work with aggregations in collections with placeholder', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .select(u => ({
            id: u.id,
            username: u.username,
            maxViews: u.posts!
              .where(p => gt(p.views!, sql.placeholder('minViews')))
              .max(p => p.views!),
            totalViews: u.posts!
              .where(p => gt(p.views!, sql.placeholder('minViews')))
              .sum(p => p.views!),
          }))
          .orderBy(u => u.id)
          .prepare('getUserPostStats');

        const result = await prepared.execute({ minAge: 20, minViews: 50 });
        expect(result.length).toBe(3);

        const alice = result.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.maxViews).toBe(150); // Alice's max view post has 150 views
      });
    });
  });

  describe('Placeholders with subqueries', () => {
    test('should work with inSubquery and placeholder', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Find users who have posts with views >= minViews
        // For inSubquery to work, we need to select just the column as scalar
        const postsSubquery = db.posts
          .where(p => gte(p.views!, sql.placeholder('minViews')))
          .select(p => p.userId)
          .asSubquery('array');

        const prepared = db.users
          .where(u => inSubquery(u.id, postsSubquery))
          .orderBy(u => u.username)
          .prepare('usersWithHighViewPosts');

        // With minViews >= 100, alice and bob have qualifying posts
        const result = await prepared.execute({ minViews: 100 });
        expect(result.length).toBeGreaterThan(0);

        const usernames = result.map(u => u.username);
        expect(usernames).toContain('alice');
        expect(usernames).toContain('bob');
      });
    });

    test('should work with scalar subquery and placeholder', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Get users with total post views > threshold
        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .select(u => ({
            id: u.id,
            username: u.username,
            totalViews: u.posts!.sum(p => p.views!),
          }))
          .orderBy(u => u.username)
          .prepare('usersWithPostViews');

        const result = await prepared.execute({ minAge: 20 });
        expect(result.length).toBe(3);

        // Verify we get totalViews for each user
        result.forEach(u => {
          expect(u.totalViews).toBeDefined();
        });
      });
    });
  });

  describe('Edge cases and stress tests', () => {
    test('should handle many placeholders', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => and(
            gte(u.age, sql.placeholder('minAge')),
            lte(u.age, sql.placeholder('maxAge')),
            eq(u.isActive, sql.placeholder('isActive')),
            like(u.username, sql.placeholder('usernamePattern')),
            like(u.email, sql.placeholder('emailPattern'))
          ))
          .prepare('manyPlaceholders');

        const names = prepared.getPlaceholderNames();
        expect(names).toContain('minAge');
        expect(names).toContain('maxAge');
        expect(names).toContain('isActive');
        expect(names).toContain('usernamePattern');
        expect(names).toContain('emailPattern');
        expect(names).toHaveLength(5);

        // Execute with all params
        const result = await prepared.execute({
          minAge: 20,
          maxAge: 50,
          isActive: true,
          usernamePattern: '%',
          emailPattern: '%@test.com',
        });
        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should handle same placeholder name used multiple times', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Using the same placeholder in different parts of the query
        // Note: This should work - the same parameter index is used
        const prepared = db.users
          .where(u => or(
            eq(u.age, sql.placeholder('targetAge')),
            gt(u.age, sql.placeholder('targetAge'))
          ))
          .prepare('sameNamePlaceholder');

        // This should match users with age >= 35 (bob=35, charlie=45)
        const result = await prepared.execute({ targetAge: 35 });
        expect(result.length).toBeGreaterThanOrEqual(1);
      });
    });

    test('should work with deeply nested selections', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const prepared = db.users
          .where(u => eq(u.id, sql.placeholder('userId')))
          .select(u => ({
            user: {
              info: {
                id: u.id,
                details: {
                  name: u.username,
                  email: u.email,
                },
              },
            },
            stats: {
              postCount: u.posts!.count(),
              recentPosts: u.posts!
                .where(p => gt(p.views!, sql.placeholder('minViews')))
                .select(p => ({
                  post: {
                    title: p.title,
                    metrics: {
                      views: p.views,
                    },
                  },
                }))
                .toList(),
            },
          }))
          .prepare('deeplyNested');

        // minViews > 100, so views must be > 100 (e.g., 150)
        const result = await prepared.execute({ userId: users.alice.id, minViews: 100 });
        expect(result).toHaveLength(1);
        expect(result[0].user.info.details.name).toBe('alice');
        expect(result[0].stats.postCount).toBe(2);
        expect(result[0].stats.recentPosts.length).toBeGreaterThan(0);
        result[0].stats.recentPosts.forEach(p => {
          // Using gt() so views > 100 means 101 or more
          expect(p.post.metrics.views).toBeGreaterThanOrEqual(100);
        });
      });
    });

    test('should handle empty result set gracefully', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .prepare('noResults');

        // No users with age > 1000
        const result = await prepared.execute({ minAge: 1000 });
        expect(result).toHaveLength(0);
      });
    });

    test('should work with offset and limit', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const prepared = db.users
          .where(u => gt(u.age, sql.placeholder('minAge')))
          .orderBy(u => u.age)
          .offset(1)
          .limit(1)
          .prepare('paginated');

        // Users with age > 20: alice(25), bob(35), charlie(45)
        // Skip 1 (alice), take 1 (bob)
        const result = await prepared.execute({ minAge: 20 });
        expect(result).toHaveLength(1);
        expect(result[0].username).toBe('bob');
      });
    });
  });
});
