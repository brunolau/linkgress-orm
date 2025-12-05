import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';
import { assertType } from '../utils/type-tester';

describe('JOIN Operations', () => {
  describe('INNER JOIN', () => {
    test('should perform inner join between tables', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .innerJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post.title,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.postTitle>(r.postTitle);
          expect(r).toHaveProperty('username');
          expect(r).toHaveProperty('postTitle');
        });
      });
    });

    test('should inner join with filtering', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => eq(u.isActive, true))
          .innerJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post.title,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.postTitle>(r.postTitle);
        });
        // Should only include posts from active users
      });
    });

    test('should chain multiple inner joins', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .innerJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post.title,
              userId: user.id,
            })
          )
          .innerJoin(
            db.orders,
            (prev, order) => eq(prev.userId, order.userId),
            (prev, order) => ({
              username: prev.username,
              postTitle: prev.postTitle,
              orderAmount: order.totalAmount,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.postTitle>(r.postTitle);
          assertType<number, typeof r.orderAmount>(r.orderAmount);
          expect(r).toHaveProperty('username');
          expect(r).toHaveProperty('postTitle');
          expect(r).toHaveProperty('orderAmount');
        });
      });
    });
  });

  describe('LEFT JOIN', () => {
    test('should perform left join', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Charlie has no posts, but should still appear in left join
        const result = await db.users
          .leftJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post?.title,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThanOrEqual(3);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string | undefined, typeof r.postTitle>(r.postTitle);
        });

        // Check that user without posts is included
        const charlieResults = result.filter(r => r.username === 'charlie');
        expect(charlieResults.length).toBeGreaterThan(0);
      });
    });

    test('should handle NULL values in left join', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users
          .where(u => eq(u.username, 'charlie'))
          .leftJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post?.title,
            })
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        // Charlie has no posts, so postTitle should be null/undefined
        result.forEach(r => {
          expect(r.username).toBe('charlie');
          expect(r.postTitle).toBeUndefined();
        });
      });
    });
  });

  describe('JOIN with subqueries', () => {
    test('should join with table subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const activeUsersSubquery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({
            userId: u.id,
            userName: u.username,
          }))
          .asSubquery('table');

        const result = await db.posts
          .innerJoin(
            activeUsersSubquery,
            (post, user) => eq(post.userId, user.userId),
            (post, user) => ({
              postTitle: post.title,
              userName: user.userName,
            }),
            'activeUsers'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r).toHaveProperty('postTitle');
          expect(r).toHaveProperty('userName');
        });
      });
    });

    test('should join with aggregated subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const postStatsSubquery = db.posts
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
            postStatsSubquery,
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

        result.forEach(r => {
          expect(typeof r.totalViews).toBe('number');
          expect(typeof r.postCount).toBe('number');
        });

        const aliceStats = result.find(r => r.username === 'alice');
        expect(aliceStats?.totalViews).toBe(250);
        expect(aliceStats?.postCount).toBe(2);
      });
    });
  });

  describe('Complex JOIN scenarios', () => {
    test('should perform self join', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const usersSubquery = db.users
          .select(u => ({
            userId: u.id,
            userEmail: u.email,
          }))
          .asSubquery('table');

        const result = await db.users
          .innerJoin(
            usersSubquery,
            (u1, u2) => gt(u1.id, u2.userId),
            (u1, u2) => ({
              user1: u1.username,
              user2Email: u2.userEmail,
            }),
            'otherUsers'
          )
          .limit(5)
          .toList();

        // Self join should produce results
        expect(result.length).toBeGreaterThan(0);
      });
    });

    test('should filter after join', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .innerJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post.title,
              views: post.views,
            })
          )
          .where(r => gt(r.views, 100))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          expect(r.views).toBeGreaterThan(100);
        });
      });
    });

    test('should order and limit joined results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .innerJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post.title,
              views: post.views,
            })
          )
          .orderBy(r => [[r.views, 'DESC']])
          .limit(2)
          .toList();

        expect(result).toHaveLength(2);
        expect(result[0].views).toBeGreaterThanOrEqual(result[1].views);
      });
    });
  });
});
