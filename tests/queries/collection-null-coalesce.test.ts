import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { gt } from '../../src';

/**
 * Test that collection results are always coalesced to empty arrays, never null.
 *
 * This is important for consistent API behavior - consumers should always get
 * an array (possibly empty) rather than null for collections.
 */
describe('Collection Null Coalesce', () => {
  describe('toList collections', () => {
    test('should return empty array instead of null for users with no posts', async () => {
      await withDatabase(async (db) => {
        // Create a user with no posts
        await db.users.insert({
          username: 'noposts_user',
          email: 'noposts@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            posts: u.posts?.select(p => ({
              id: p.id,
              title: p.title,
            })).toList('posts'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Find the user with no posts
        const noPostsUser = result.find(r => r.username === 'noposts_user');
        expect(noPostsUser).toBeDefined();

        // CRITICAL: posts should be an empty array, NOT null
        expect(noPostsUser!.posts).not.toBeNull();
        expect(Array.isArray(noPostsUser!.posts)).toBe(true);
        expect(noPostsUser!.posts).toEqual([]);
      });
    });

    test('should return empty array instead of null for users with no orders', async () => {
      await withDatabase(async (db) => {
        // Create a user with no orders
        await db.users.insert({
          username: 'noorders_user',
          email: 'noorders@test.com',
          age: 25,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orders: u.orders?.select(o => ({
              id: o.id,
              status: o.status,
            })).toList('orders'),
          }))
          .toList();

        const noOrdersUser = result.find(r => r.username === 'noorders_user');
        expect(noOrdersUser).toBeDefined();

        // CRITICAL: orders should be an empty array, NOT null
        expect(noOrdersUser!.orders).not.toBeNull();
        expect(Array.isArray(noOrdersUser!.orders)).toBe(true);
        expect(noOrdersUser!.orders).toEqual([]);
      });
    });
  });

  describe('toNumberList collections', () => {
    test('should return empty array instead of null for toNumberList with no matching items', async () => {
      await withDatabase(async (db) => {
        // Create a user with no posts
        await db.users.insert({
          username: 'noposts_numlist',
          email: 'noposts_numlist@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            postIds: u.posts?.select(p => ({
              id: p.id,
            })).toNumberList(),
          }))
          .toList();

        const noPostsUser = result.find(r => r.username === 'noposts_numlist');
        expect(noPostsUser).toBeDefined();

        // CRITICAL: postIds should be an empty array, NOT null
        expect(noPostsUser!.postIds).not.toBeNull();
        expect(Array.isArray(noPostsUser!.postIds)).toBe(true);
        expect(noPostsUser!.postIds).toEqual([]);
      });
    });
  });

  describe('toStringList collections', () => {
    test('should return empty array instead of null for toStringList with no matching items', async () => {
      await withDatabase(async (db) => {
        // Create a user with no posts
        await db.users.insert({
          username: 'noposts_strlist',
          email: 'noposts_strlist@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            postTitles: u.posts?.select(p => ({
              title: p.title,
            })).toStringList(),
          }))
          .toList();

        const noPostsUser = result.find(r => r.username === 'noposts_strlist');
        expect(noPostsUser).toBeDefined();

        // CRITICAL: postTitles should be an empty array, NOT null
        expect(noPostsUser!.postTitles).not.toBeNull();
        expect(Array.isArray(noPostsUser!.postTitles)).toBe(true);
        expect(noPostsUser!.postTitles).toEqual([]);
      });
    });
  });

  describe('Nested collections', () => {
    test('should return empty arrays for nested collections when parent has no children', async () => {
      await withDatabase(async (db) => {
        // Create a user with no orders (so orderTasks will also be empty)
        await db.users.insert({
          username: 'nested_empty',
          email: 'nested_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            orders: u.orders?.select(o => ({
              id: o.id,
              tasks: o.orderTasks?.select(ot => ({
                taskId: ot.taskId,
              })).toList('tasks'),
            })).toList('orders'),
          }))
          .toList();

        const nestedEmptyUser = result.find(r => r.username === 'nested_empty');
        expect(nestedEmptyUser).toBeDefined();

        // CRITICAL: orders should be an empty array, NOT null
        expect(nestedEmptyUser!.orders).not.toBeNull();
        expect(Array.isArray(nestedEmptyUser!.orders)).toBe(true);
        expect(nestedEmptyUser!.orders).toEqual([]);
      });
    });
  });

  describe('CTE withAggregation in leftJoin', () => {
    test('should return empty array instead of null for CTE aggregation with groupBy when no match', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const { DbCteBuilder } = await import('../../src/query/cte-builder');
        const { eq, gt, sql } = await import('../../src');

        const cteBuilder = new DbCteBuilder();

        // This is the exact gopass pattern:
        // CTE with groupBy then aggregation, then leftJoin with main query
        const postPriceCte = cteBuilder.withAggregation(
          'post_price_cte',
          db.posts.select(p => ({
            id: sql<number>`CASE WHEN ${p.user!.isActive} = true THEN ${p.id} ELSE -1 END`.as('id'),
            views: p.views,
            postUserId: p.userId,
          })).groupBy(p => ({
            postId: p.id,
            userId: p.postUserId,
          })).select(p => ({
            postId: p.key.postId,
            userId: p.key.userId,
            minViews: p.min(pr => pr.views),
          })),
          p => ({ userId: p.userId }),
          'prices',
        );

        // Create a user with no posts
        await db.users.insert({
          username: 'groupby_empty',
          email: 'groupby_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            postPriceCte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              prices: cte.prices, // Should be [] not null
            }),
          )
          .toList();

        const emptyUser = result.find(r => r.username === 'groupby_empty');
        expect(emptyUser).toBeDefined();

        // CRITICAL: prices should be an empty array, NOT null
        expect(emptyUser!.prices).not.toBeNull();
        expect(Array.isArray(emptyUser!.prices)).toBe(true);
        expect(emptyUser!.prices).toEqual([]);
      });
    });

    test('should return empty array for CTE with groupBy and nested CTE join when no match', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const { DbCteBuilder } = await import('../../src/query/cte-builder');
        const { eq, gt, sql } = await import('../../src');

        const cteBuilder = new DbCteBuilder();

        // First CTE: aggregate orders (like productPriceAdvanceDiscounts)
        const orderAdvanceCte = cteBuilder.withAggregation(
          'order_advance_cte',
          db.orders.select(o => ({
            advanceUserId: o.userId,
            advanceAmount: o.totalAmount,
          })),
          o => ({ advanceUserId: o.advanceUserId }),
          'advancePrices',
        );

        // Second CTE: posts with navigation, groupBy, then leftJoin with first CTE
        // This is the exact gopass productPriceCte pattern
        const postPriceCte = cteBuilder.withAggregation(
          'post_price_cte',
          db.posts.select(p => ({
            id: sql<number>`CASE WHEN ${p.user!.isActive} = true THEN ${p.id} ELSE -1 END`.as('id'),
            views: p.views,
            postUserId: p.userId,
          })).groupBy(p => ({
            postId: p.id,
            userId: p.postUserId,
          })).select(p => ({
            postId: p.key.postId,
            userId: p.key.userId,
            minViews: p.min(pr => pr.views),
          })).leftJoin(
            orderAdvanceCte,
            (post, advance) => eq(post.userId, advance.advanceUserId),
            (post, advance) => ({
              postIdOfPost: post.postId,
              userId: post.userId,
              minViews: post.minViews,
              advancePrices: advance.advancePrices, // Nested CTE aggregation
            }),
          ),
          p => ({ postIdOfPost: p.postIdOfPost }),
          'prices',
        );

        // Create a user with no posts and no orders
        await db.users.insert({
          username: 'nested_groupby_empty',
          email: 'nested_groupby_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            postPriceCte,
            (user, cte) => eq(user.id, cte.postIdOfPost),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              prices: cte.prices,
            }),
          )
          .toList();

        const emptyUser = result.find(r => r.username === 'nested_groupby_empty');
        expect(emptyUser).toBeDefined();

        // CRITICAL: prices should be an empty array, NOT null
        expect(emptyUser!.prices).not.toBeNull();
        expect(Array.isArray(emptyUser!.prices)).toBe(true);
        expect(emptyUser!.prices).toEqual([]);
      });
    });

    test('should return empty array instead of null for CTE aggregation field when no match in leftJoin', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Import CTE builder
        const { DbCteBuilder } = await import('../../src/query/cte-builder');
        const { eq, gt } = await import('../../src');

        const cteBuilder = new DbCteBuilder();

        // Create a CTE that aggregates posts by userId
        const postsCte = cteBuilder.withAggregation(
          'posts_cte',
          db.posts.select(p => ({
            postUserId: p.userId,
            postTitle: p.title,
            postViews: p.views,
          })),
          p => ({ postUserId: p.postUserId }),
          'posts',
        );

        // Create a user with no posts
        await db.users.insert({
          username: 'cte_no_posts',
          email: 'cte_no_posts@test.com',
          age: 30,
          isActive: true,
        }).returning();

        // Query users with the CTE joined
        const result = await db.users
          .where(u => gt(u.id, 0))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            postsCte,
            (user, cte) => eq(user.id, cte.postUserId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              posts: cte.posts, // This should be [] not null when no match
            }),
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);

        // Find the user with no posts
        const noPostsUser = result.find(r => r.username === 'cte_no_posts');
        expect(noPostsUser).toBeDefined();

        // CRITICAL: posts should be an empty array, NOT null
        expect(noPostsUser!.posts).not.toBeNull();
        expect(Array.isArray(noPostsUser!.posts)).toBe(true);
        expect(noPostsUser!.posts).toEqual([]);
      });
    });

    test('should return empty array for nested CTE aggregation fields', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const { DbCteBuilder } = await import('../../src/query/cte-builder');
        const { eq, gt } = await import('../../src');

        const cteBuilder = new DbCteBuilder();

        // First CTE: aggregate order stats
        const orderStatsCte = cteBuilder.withAggregation(
          'order_stats_cte',
          db.orders.select(o => ({
            orderUserId: o.userId,
            orderStatus: o.status,
            orderAmount: o.totalAmount,
          })),
          o => ({ orderUserId: o.orderUserId }),
          'orderStats',
        );

        // Second CTE: posts with join to first CTE
        const postsCte = cteBuilder.withAggregation(
          'posts_cte',
          db.posts.select(p => ({
            postUserId: p.userId,
            postTitle: p.title,
          })).leftJoin(
            orderStatsCte,
            (post, stats) => eq(post.postUserId, stats.orderUserId),
            (post, stats) => ({
              postUserId: post.postUserId,
              postTitle: post.postTitle,
              orderStats: stats.orderStats, // Nested aggregation
            }),
          ),
          p => ({ postUserId: p.postUserId }),
          'posts',
        );

        // Create a user with no posts and no orders
        await db.users.insert({
          username: 'nested_cte_empty',
          email: 'nested_cte_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            postsCte,
            (user, cte) => eq(user.id, cte.postUserId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              posts: cte.posts,
            }),
          )
          .toList();

        const emptyUser = result.find(r => r.username === 'nested_cte_empty');
        expect(emptyUser).toBeDefined();

        // CRITICAL: posts should be an empty array, NOT null
        expect(emptyUser!.posts).not.toBeNull();
        expect(Array.isArray(emptyUser!.posts)).toBe(true);
        expect(emptyUser!.posts).toEqual([]);
      });
    });
  });

  describe('CTE withAggregation works with all collection strategies', () => {
    test('CTE aggregation leftJoin should coalesce to empty array with CTE collection strategy', async () => {
      await withDatabase(async (db) => {
        const { DbCteBuilder } = await import('../../src/query/cte-builder');
        const { eq, gt } = await import('../../src');

        const cteBuilder = new DbCteBuilder();

        const postsCte = cteBuilder.withAggregation(
          'posts_cte',
          db.posts.select(p => ({
            postUserId: p.userId,
            postTitle: p.title,
          })),
          p => ({ postUserId: p.postUserId }),
          'posts',
        );

        await db.users.insert({
          username: 'cte_strat_empty',
          email: 'cte_strat_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            postsCte,
            (user, cte) => eq(user.id, cte.postUserId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              posts: cte.posts,
            }),
          )
          .toList();

        const user = result.find(r => r.username === 'cte_strat_empty');
        expect(user!.posts).not.toBeNull();
        expect(user!.posts).toEqual([]);
      }, { collectionStrategy: 'cte' });
    });

    test('CTE aggregation leftJoin should coalesce to empty array with LATERAL collection strategy', async () => {
      await withDatabase(async (db) => {
        const { DbCteBuilder } = await import('../../src/query/cte-builder');
        const { eq, gt } = await import('../../src');

        const cteBuilder = new DbCteBuilder();

        const postsCte = cteBuilder.withAggregation(
          'posts_cte',
          db.posts.select(p => ({
            postUserId: p.userId,
            postTitle: p.title,
          })),
          p => ({ postUserId: p.postUserId }),
          'posts',
        );

        await db.users.insert({
          username: 'lateral_strat_empty',
          email: 'lateral_strat_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            postsCte,
            (user, cte) => eq(user.id, cte.postUserId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              posts: cte.posts,
            }),
          )
          .toList();

        const user = result.find(r => r.username === 'lateral_strat_empty');
        expect(user!.posts).not.toBeNull();
        expect(user!.posts).toEqual([]);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('All collection strategies', () => {
    test('CTE strategy should coalesce collections to empty array', async () => {
      await withDatabase(async (db) => {
        await db.users.insert({
          username: 'cte_empty',
          email: 'cte_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            posts: u.posts?.select(p => ({ id: p.id })).toList('posts'),
          }))
          .toList();

        const user = result.find(r => r.username === 'cte_empty');
        expect(user!.posts).not.toBeNull();
        expect(user!.posts).toEqual([]);
      }, { collectionStrategy: 'cte' });
    });

    test('LATERAL strategy should coalesce collections to empty array', async () => {
      await withDatabase(async (db) => {
        await db.users.insert({
          username: 'lateral_empty',
          email: 'lateral_empty@test.com',
          age: 30,
          isActive: true,
        }).returning();

        const result = await db.users
          .where(u => gt(u.id, 0))
          .select(u => ({
            id: u.id,
            username: u.username,
            posts: u.posts?.select(p => ({ id: p.id })).toList('posts'),
          }))
          .toList();

        const user = result.find(r => r.username === 'lateral_empty');
        expect(user!.posts).not.toBeNull();
        expect(user!.posts).toEqual([]);
      }, { collectionStrategy: 'lateral' });
    });
  });
});
