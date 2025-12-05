import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, DbCteBuilder } from '../../src';
import { assertType } from '../utils/type-tester';

describe('Grouping and Aggregation', () => {
  describe('Basic GROUP BY', () => {
    test('should group by single field with count', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            title: p.title,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify types are numbers
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.postCount>(r.postCount);
          expect(typeof r.postCount).toBe('number');
          expect(r.postCount).toBeGreaterThan(0);
        });

        // Alice should have 2 posts
        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.postCount).toBe(2);
      });
    });

    test('should group with sum aggregate', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify result types
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.totalViews>(r.totalViews);
          expect(typeof r.totalViews).toBe('number');
          expect(r.totalViews).toBeGreaterThan(0);
        });

        // Alice should have 250 total views (100 + 150)
        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.totalViews).toBe(250);
      });
    });

    test('should group with min and max aggregates', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            minViews: g.min(p => p.views),
            maxViews: g.max(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.minViews>(r.minViews);
          assertType<number, typeof r.maxViews>(r.maxViews);
        });

        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.minViews).toBe(100);
        expect(aliceStats?.maxViews).toBe(150);
      });
    });

    test('should group with avg aggregate', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            avgViews: g.avg(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify result type is number
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.avgViews>(r.avgViews);
          expect(typeof r.avgViews).toBe('number');
        });

        // Alice's avg should be 125 (100 + 150) / 2
        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats?.avgViews).toBe(125);
      });
    });

    test('should group with multiple aggregates', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            count: g.count(),
            totalViews: g.sum(p => p.views),
            avgViews: g.avg(p => p.views),
            minViews: g.min(p => p.views),
            maxViews: g.max(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.count>(r.count);
          assertType<number, typeof r.totalViews>(r.totalViews);
          assertType<number, typeof r.avgViews>(r.avgViews);
          assertType<number, typeof r.minViews>(r.minViews);
          assertType<number, typeof r.maxViews>(r.maxViews);
        });

        const aliceStats = result.find(r => r.userId === 1);
        expect(aliceStats).toBeDefined();
        expect(aliceStats?.count).toBe(2);
        expect(aliceStats?.totalViews).toBe(250);
        expect(aliceStats?.avgViews).toBe(125);
        expect(aliceStats?.minViews).toBe(100);
        expect(aliceStats?.maxViews).toBe(150);
      });
    });
  });

  describe('GROUP BY with multiple keys', () => {
    test('should group by multiple fields', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create more posts with varying data
        await db.posts.insert({ title: 'Tech', content: 'Content', userId: users.alice.id, views: 50 });
        await db.posts.insert({ title: 'Tech', content: 'Content', userId: users.bob.id, views: 75 });

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            title: p.title,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
            title: p.title,
          }))
          .select(g => ({
            userId: g.key.userId,
            title: g.key.title,
            totalViews: g.sum(p => p.views),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(3);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string | undefined, typeof r.title>(r.title);
          assertType<number, typeof r.totalViews>(r.totalViews);
        });

        // Each combination of userId + title should be unique
        const uniqueKeys = new Set(result.map(r => `${r.userId}-${r.title}`));
        expect(uniqueKeys.size).toBe(result.length);
      });
    });
  });

  describe('HAVING clause', () => {
    test('should filter groups with HAVING', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .having(g => gt(g.count() as any, 1))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .toList();

        // Only users with more than 1 post
        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.postCount>(r.postCount);
          expect(r.postCount).toBeGreaterThan(1);
        });
      });
    });

    test('should combine WHERE and HAVING', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .where(p => gt(p.views, 50))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .having(g => gt(g.count() as any, 1))
          .select(g => ({
            userId: g.key.userId,
            postCount: g.count(),
          }))
          .toList();

        // WHERE filters before grouping, HAVING filters after
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.postCount>(r.postCount);
          expect(r.postCount).toBeGreaterThan(1);
        });
      });
    });
  });

  describe('Grouped queries as subqueries', () => {
    test('should use grouped query as table subquery in JOIN', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const statsSubquery = db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
            postCount: g.count(),
          }))
          .asSubquery('table');

        const result = await db.users
          .innerJoin(
            statsSubquery,
            (user, stats) => eq(user.id, stats.userId),
            (user, stats) => ({
              username: user.username,
              totalViews: stats.totalViews,
              postCount: stats.postCount,
            }),
            'stats'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Verify aggregates are numbers
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<number, typeof r.totalViews>(r.totalViews);
          assertType<number, typeof r.postCount>(r.postCount);
          expect(typeof r.totalViews).toBe('number');
          expect(typeof r.postCount).toBe('number');
        });

        const aliceStats = result.find(r => r.username === 'alice');
        expect(aliceStats?.totalViews).toBe(250);
        expect(aliceStats?.postCount).toBe(2);
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle empty groups', async () => {
      await withDatabase(async (db) => {
        // Create DB but no data

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            count: g.count(),
          }))
          .toList();

        expect(result).toHaveLength(0);
      });
    });

    test('should handle NULL values in grouping', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create posts with no subtitle (NULL)
        await db.posts.insert({ title: 'Post 1', content: 'C', userId: users.alice.id, views: 10 });
        await db.posts.insert({ title: 'Post 2', content: 'C', userId: users.alice.id, views: 20 });

        const result = await db.posts
          .select(p => ({
            subtitle: p.subtitle,
            views: p.views,
          }))
          .groupBy(p => ({
            subtitle: p.subtitle,
          }))
          .select(g => ({
            subtitle: g.key.subtitle,
            count: g.count(),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string | undefined, typeof r.subtitle>(r.subtitle);
          assertType<number, typeof r.count>(r.count);
        });
        // Should have a group for NULL subtitles
        const nullGroup = result.find(r => r.subtitle === null || r.subtitle === undefined);
        expect(nullGroup).toBeDefined();
      });
    });
  });

  describe('Grouped query with JOIN', () => {
    test('should LEFT JOIN grouped query with CTE', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create a CTE with user details
        const cteBuilder = new DbCteBuilder();
        const userDetailsCte = cteBuilder.with(
          'user_details',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
            email: u.email,
          }))
        );

        // Group posts by userId and LEFT JOIN with user details CTE
        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
            postCount: g.count(),
          }))
          .leftJoin(
            userDetailsCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              postCount: stats.postCount,
              username: user.username,
              email: user.email,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.totalViews>(r.totalViews);
          assertType<number, typeof r.postCount>(r.postCount);
          assertType<string | undefined, typeof r.username>(r.username);
          assertType<string | undefined, typeof r.email>(r.email);
        });

        // Verify we got user details joined
        const aliceStats = result.find(r => r.username === 'alice');
        expect(aliceStats).toBeDefined();
        expect(aliceStats?.totalViews).toBe(250); // 100 + 150
        expect(aliceStats?.postCount).toBe(2);
        expect(aliceStats?.email).toBe('alice@test.com');
      });
    });

    test('should INNER JOIN grouped query with CTE', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create a CTE with only active users
        const cteBuilder = new DbCteBuilder();
        const activeUsersCte = cteBuilder.with(
          'active_users',
          db.users
            .where(u => eq(u.isActive, true))
            .select(u => ({
              userId: u.id,
              username: u.username,
            }))
        );

        // Group posts and INNER JOIN - should only get posts from active users
        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .innerJoin(
            activeUsersCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              username: user.username,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // All results should be from active users
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.totalViews>(r.totalViews);
          assertType<string, typeof r.username>(r.username);
          expect(r.username).toBeDefined();
        });
      });
    });

    test('should LEFT JOIN grouped query with subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create a subquery with user info
        const userSubquery = db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            age: u.age,
          }))
          .asSubquery('table');

        // Group posts and LEFT JOIN with user subquery
        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            maxViews: g.max(p => p.views),
            minViews: g.min(p => p.views),
          }))
          .leftJoin(
            userSubquery,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              maxViews: stats.maxViews,
              minViews: stats.minViews,
              username: user.username,
              age: user.age,
            }),
            'user_info'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.maxViews>(r.maxViews);
          assertType<number, typeof r.minViews>(r.minViews);
          assertType<string | undefined, typeof r.username>(r.username);
          assertType<number | undefined, typeof r.age>(r.age);
        });

        // Verify we got user details joined
        const aliceStats = result.find(r => r.username === 'alice');
        expect(aliceStats).toBeDefined();
        expect(aliceStats?.maxViews).toBe(150);
        expect(aliceStats?.minViews).toBe(100);
        expect(aliceStats?.age).toBe(25);
      });
    });

    test('should support orderBy on grouped joined query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const usersCte = cteBuilder.with(
          'users_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
          }))
        );

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .leftJoin(
            usersCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              username: user.username,
            })
          )
          .orderBy(r => [[r.totalViews, 'DESC']])
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.totalViews>(r.totalViews);
          assertType<string | undefined, typeof r.username>(r.username);
        });

        // Verify ordering - totalViews should be descending
        for (let i = 1; i < result.length; i++) {
          expect(result[i - 1].totalViews).toBeGreaterThanOrEqual(result[i].totalViews);
        }
      });
    });

    test('should support limit and offset on grouped joined query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const usersCte = cteBuilder.with(
          'users_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
          }))
        );

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .leftJoin(
            usersCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              username: user.username,
            })
          )
          .limit(1)
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<number, typeof r.totalViews>(r.totalViews);
          assertType<string | undefined, typeof r.username>(r.username);
        });
      });
    });

    test('should convert grouped joined query to subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const usersCte = cteBuilder.with(
          'users_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
          }))
        );

        // Create a subquery from the grouped+joined result
        const statsSubquery = db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .leftJoin(
            usersCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              username: user.username,
            })
          )
          .asSubquery('table');

        // Use the subquery in another query
        const result = await db.users
          .innerJoin(
            statsSubquery,
            (user, stats) => eq(user.id, stats.userId),
            (user, stats) => ({
              id: user.id,
              email: user.email,
              totalViews: stats.totalViews,
              username: stats.username,
            }),
            'stats'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.email>(r.email);
          assertType<number | undefined, typeof r.totalViews>(r.totalViews);
          assertType<string | undefined, typeof r.username>(r.username);
        });

        const alice = result.find(r => r.email === 'alice@test.com');
        expect(alice).toBeDefined();
        expect(alice?.totalViews).toBe(250);
      });
    });

    test('should support first() on grouped joined query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const usersCte = cteBuilder.with(
          'users_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
          }))
        );

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .leftJoin(
            usersCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              username: user.username,
            })
          )
          .first();

        expect(result).not.toBeNull();
        if (result) {
          // Type assertions
          assertType<number, typeof result.userId>(result.userId);
          assertType<number, typeof result.totalViews>(result.totalViews);
          assertType<string | undefined, typeof result.username>(result.username);
        }
        expect(result?.userId).toBeDefined();
        expect(result?.totalViews).toBeDefined();
        expect(result?.username).toBeDefined();
      });
    });

    test('should return null from first() when no results', async () => {
      await withDatabase(async (db) => {
        // No data seeded

        const cteBuilder = new DbCteBuilder();
        const usersCte = cteBuilder.with(
          'users_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
          }))
        );

        const result = await db.posts
          .select(p => ({
            userId: p.userId,
            views: p.views,
          }))
          .groupBy(p => ({
            userId: p.userId,
          }))
          .select(g => ({
            userId: g.key.userId,
            totalViews: g.sum(p => p.views),
          }))
          .leftJoin(
            usersCte.cte,
            (stats, user) => eq(stats.userId, user.userId),
            (stats, user) => ({
              userId: stats.userId,
              totalViews: stats.totalViews,
              username: user.username,
            })
          )
          .first();

        expect(result).toBeNull();
      });
    });
  });
});
