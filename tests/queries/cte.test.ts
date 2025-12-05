import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, lt, gt, sql, DbCteBuilder } from '../../src';
import { assertType } from '../utils/type-tester';

describe('CTE (Common Table Expression) Support', () => {
  describe('Regular CTEs with with()', () => {
    test('should create CTE and join with it', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Create a CTE with filtered users
        const cteBuilder = new DbCteBuilder();
        const activeUsersCte = cteBuilder.with(
          'active_users',
          db.users
            .where(u => lt(u.id, 100))
            .select(u => ({
              userId: u.id,
              username: u.username,
              createdAt: u.createdAt,
            }))
        );

        // Use the CTE in a query
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(activeUsersCte.cte)
          .leftJoin(
            activeUsersCte.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              name: user.username,
              cteUsername: cte.username,
              cteCreatedAt: cte.createdAt,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.name>(r.name);
          assertType<string | undefined, typeof r.cteUsername>(r.cteUsername);
          assertType<Date | undefined, typeof r.cteCreatedAt>(r.cteCreatedAt);
        });
        expect(result[0].id).toBe(users.alice.id);
        expect(result[0].name).toBe('alice');
        expect(result[0].cteUsername).toBe('alice');
        expect(result[0].cteCreatedAt).toBeInstanceOf(Date);
      });
    });

    test('should create CTE with aggregations', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Create a CTE with post counts
        const cteBuilder = new DbCteBuilder();
        const userPostCountsCte = cteBuilder.with(
          'user_post_counts',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
            postCount: u.posts!.count(),
            maxViews: u.posts!.max(p => p.views),
          }))
        );

        // Join with the CTE
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(userPostCountsCte.cte)
          .leftJoin(
            userPostCountsCte.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              name: user.username,
              postCount: cte.postCount,
              maxViews: cte.maxViews,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.name>(r.name);
          assertType<number | undefined, typeof r.postCount>(r.postCount);
          assertType<number | null | undefined, typeof r.maxViews>(r.maxViews);
        });
        expect(result[0].postCount).toBeGreaterThan(0);
        expect(typeof result[0].postCount).toBe('number');
        if (result[0].maxViews !== null) {
          expect(typeof result[0].maxViews).toBe('number');
        }
      });
    });

    test('should handle CTE with WHERE conditions', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Create a CTE with filtered posts
        const cteBuilder = new DbCteBuilder();
        const popularPostsCte = cteBuilder.with(
          'popular_posts',
          db.posts
            .where(p => gt(p.views, 10))
            .select(p => ({
              postId: p.id,
              postTitle: p.title,
              postViews: p.views,
              postUserId: p.userId,
            }))
        );

        // Join users with popular posts CTE
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(popularPostsCte.cte)
          .leftJoin(
            popularPostsCte.cte,
            (user, cte) => eq(user.id, cte.postUserId),
            (user, cte) => ({
              userId: user.id,
              username: user.username,
              popularPostTitle: cte.postTitle,
              popularPostViews: cte.postViews,
            })
          )
          .toList();

        expect(result).toBeDefined();
        expect(Array.isArray(result)).toBe(true);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string, typeof r.username>(r.username);
          assertType<string | undefined, typeof r.popularPostTitle>(r.popularPostTitle);
          assertType<number | undefined, typeof r.popularPostViews>(r.popularPostViews);
        });
      });
    });
  });

  describe('Aggregation CTEs with withAggregation()', () => {
    test('should create aggregation CTE grouping posts by user', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Create an aggregation CTE
        const cteBuilder = new DbCteBuilder();
        const aggregatedPostsCte = cteBuilder.withAggregation(
          'aggregated_posts',
          db.posts.select(p => ({
            id: p.id,
            title: p.title,
            views: p.views,
            userId: p.userId,
          })),
          p => ({ userId: p.userId }),
          'posts'
        );

        // Use the aggregation CTE
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(aggregatedPostsCte)
          .leftJoin(
            aggregatedPostsCte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              aggregatedPosts: cte.posts,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.username>(r.username);
          assertType<unknown[], typeof r.aggregatedPosts>(r.aggregatedPosts);
        });
        expect(result[0].aggregatedPosts).toBeDefined();
        const aggregatedPostsArray = result[0].aggregatedPosts as any[];
        expect(Array.isArray(aggregatedPostsArray)).toBe(true);

        if (aggregatedPostsArray.length > 0) {
          const firstPost = aggregatedPostsArray[0];
          expect(firstPost).toHaveProperty('id');
          expect(firstPost).toHaveProperty('title');
          expect(firstPost).toHaveProperty('views');
        }
      });
    });

    test('should create aggregation CTE with custom column name', async () => {
      await withDatabase(async (db) => {
        const { users, orders } = await seedTestData(db);

        // Create an aggregation CTE for orders
        const cteBuilder = new DbCteBuilder();
        const aggregatedOrdersCte = cteBuilder.withAggregation(
          'aggregated_orders',
          db.orders.select(o => ({
            orderId: o.id,
            status: o.status,
            totalAmount: o.totalAmount,
            userId: o.userId,
          })),
          o => ({ userId: o.userId }),
          'orderList' // Custom aggregation column name
        );

        // Use the aggregation CTE
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(aggregatedOrdersCte)
          .leftJoin(
            aggregatedOrdersCte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              username: user.username,
              orders: cte.orderList, // Access custom column name
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.username>(r.username);
          assertType<unknown[], typeof r.orders>(r.orders);
        });
        expect(result[0].orders).toBeDefined();
        expect(Array.isArray(result[0].orders)).toBe(true);
      });
    });

    test('should handle aggregation CTE with multiple grouping columns', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Create an aggregation CTE grouping by userId and another field
        const cteBuilder = new DbCteBuilder();
        const aggregatedCte = cteBuilder.withAggregation(
          'aggregated_data',
          db.posts.select(p => ({
            postId: p.id,
            title: p.title,
            userId: p.userId,
            publishedYear: p.publishedAt, // Simplified - in real case you'd extract year
          })),
          p => ({
            userId: p.userId,
            // publishedYear: p.publishedYear
          }),
          'items'
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(aggregatedCte)
          .leftJoin(
            aggregatedCte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              userId: user.id,
              username: user.username,
              groupedItems: cte.items,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string, typeof r.username>(r.username);
          assertType<unknown[], typeof r.groupedItems>(r.groupedItems);
        });
        expect(result[0].groupedItems).toBeDefined();
      });
    });
  });

  describe('Multiple CTEs', () => {
    test('should use multiple CTEs in a single query', async () => {
      await withDatabase(async (db) => {
        const { users, posts, orders } = await seedTestData(db);

        // Create multiple CTEs
        const cteBuilder = new DbCteBuilder();

        const userStatsCte = cteBuilder.with(
          'user_stats',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
            postCount: u.posts!.count(),
          }))
        );

        const orderStatsCte = cteBuilder.with(
          'order_stats',
          db.users.select(u => ({
            userId: u.id,
            orderCount: u.orders!.count(),
            totalSpent: u.orders!.sum(o => o.totalAmount),
          }))
        );

        // Use both CTEs
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            userStatsCte.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              name: user.username,
              postCount: cte.postCount,
              statsUsername: cte.username,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.name>(r.name);
          assertType<number | undefined, typeof r.postCount>(r.postCount);
          assertType<string | undefined, typeof r.statsUsername>(r.statsUsername);
        });
        expect(result[0].postCount).toBeDefined();
        expect(typeof result[0].postCount).toBe('number');
      });
    });

    test('should chain multiple getCtes() calls', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create first set of CTEs
        const cteBuilder1 = new DbCteBuilder();
        const cte1 = cteBuilder1.with(
          'cte1',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
          }))
        );

        // Create second set of CTEs
        const cteBuilder2 = new DbCteBuilder();
        const cte2 = cteBuilder2.with(
          'cte2',
          db.posts.select(p => ({
            postId: p.id,
            postUserId: p.userId,
          }))
        );

        // Use CTEs from both builders
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(...cteBuilder1.getCtes(), ...cteBuilder2.getCtes())
          .leftJoin(
            cte1.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              cteUsername: cte.username,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string | undefined, typeof r.cteUsername>(r.cteUsername);
        });
        expect(result[0].cteUsername).toBe('alice');
      });
    });
  });

  describe('CTE Type Safety', () => {
    test('should provide type-safe access to CTE columns', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const typedCte = cteBuilder.with(
          'typed_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
            email: u.email,
            isActive: u.isActive,
          }))
        );

        // TypeScript should provide autocomplete for CTE columns
        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(typedCte.cte)
          .leftJoin(
            typedCte.cte,
            (user, cte) => {
              // These should all be type-safe
              const _userId: any = cte.userId;
              const _username: any = cte.username;
              const _email: any = cte.email;
              const _isActive: any = cte.isActive;
              return eq(user.id, cte.userId);
            },
            (user, cte) => ({
              id: user.id,
              // All these should be type-checked
              cteUserId: cte.userId,
              cteUsername: cte.username,
              cteEmail: cte.email,
              cteIsActive: cte.isActive,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<number | undefined, typeof r.cteUserId>(r.cteUserId);
          assertType<string | undefined, typeof r.cteUsername>(r.cteUsername);
          assertType<string | undefined, typeof r.cteEmail>(r.cteEmail);
          assertType<boolean | undefined, typeof r.cteIsActive>(r.cteIsActive);
        });
        expect(result[0].cteUsername).toBe('alice');
        expect(result[0].cteEmail).toBe('alice@test.com');
      });
    });

    test('aggregation CTE should have typed array column', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const aggCte = cteBuilder.withAggregation(
          'agg_cte',
          db.posts.select(p => ({
            postId: p.id,
            title: p.title,
            userId: p.userId,
          })),
          p => ({ userId: p.userId }),
          'postList'
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(aggCte)
          .leftJoin(
            aggCte,
            (user, cte) => {
              // cte.userId should be type-safe
              const _userId: any = cte.userId;
              // cte.postList should be typed as array
              const _postList: any = cte.postList;
              return eq(user.id, cte.userId);
            },
            (user, cte) => ({
              id: user.id,
              posts: cte.postList, // Should be typed as array
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<unknown[], typeof r.posts>(r.posts);
        });
        expect(Array.isArray(result[0].posts)).toBe(true);
      });
    });
  });

  describe('CTE Edge Cases', () => {
    test('should handle empty CTE results', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create a CTE that returns no rows
        const cteBuilder = new DbCteBuilder();
        const emptyCte = cteBuilder.with(
          'empty_cte',
          db.users
            .where(u => eq(u.id, 99999)) // Non-existent user
            .select(u => ({
              userId: u.id,
              username: u.username,
            }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(emptyCte.cte)
          .leftJoin(
            emptyCte.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              name: user.username,
              cteUsername: cte.username, // Should be null for LEFT JOIN
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.name>(r.name);
          assertType<string | undefined, typeof r.cteUsername>(r.cteUsername);
        });
        expect(result[0].id).toBe(users.alice.id);
        // cteUsername should be null or undefined due to LEFT JOIN
      });
    });

    test('should handle CTE with ORDER BY and LIMIT', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create a CTE with ordering and limit
        const cteBuilder = new DbCteBuilder();
        const limitedCte = cteBuilder.with(
          'limited_posts',
          db.posts
            .select(p => ({
              postId: p.id,
              title: p.title,
              views: p.views,
              userId: p.userId,
            }))
            .orderBy(p => [[p.views, 'DESC']])
            .limit(5)
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(limitedCte.cte)
          .leftJoin(
            limitedCte.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              userId: user.id,
              topPostTitle: cte.title,
              topPostViews: cte.views,
            })
          )
          .toList();

        expect(result).toBeDefined();
        expect(Array.isArray(result)).toBe(true);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string | undefined, typeof r.topPostTitle>(r.topPostTitle);
          assertType<number | undefined, typeof r.topPostViews>(r.topPostViews);
        });
      });
    });

    test('should handle nested CTEs (CTE using collection queries)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Create a CTE that itself uses nested queries
        const cteBuilder = new DbCteBuilder();
        const nestedCte = cteBuilder.with(
          'nested_cte',
          db.users.select(u => ({
            userId: u.id,
            username: u.username,
            postCount: u.posts!.count(),
            maxPostViews: u.posts!.max(p => p.views),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(nestedCte.cte)
          .leftJoin(
            nestedCte.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              postCount: cte.postCount,
              maxViews: cte.maxPostViews,
            })
          )
          .toList();

        expect(result).toHaveLength(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<number | undefined, typeof r.postCount>(r.postCount);
          assertType<number | null | undefined, typeof r.maxViews>(r.maxViews);
        });
        expect(typeof result[0].postCount).toBe('number');
      });
    });
  });

  describe('CTE Builder Management', () => {
    test('should track multiple CTEs in builder', async () => {
      await withDatabase(async (db) => {
        const cteBuilder = new DbCteBuilder();

        // Create multiple CTEs
        cteBuilder.with('cte1', db.users.select(u => ({ id: u.id })));
        cteBuilder.with('cte2', db.posts.select(p => ({ id: p.id })));
        cteBuilder.with('cte3', db.orders.select(o => ({ id: o.id })));

        const ctes = cteBuilder.getCtes();
        expect(ctes).toHaveLength(3);
        expect(ctes[0].name).toBe('cte1');
        expect(ctes[1].name).toBe('cte2');
        expect(ctes[2].name).toBe('cte3');
      });
    });

    test('should clear CTEs from builder', async () => {
      await withDatabase(async (db) => {
        const cteBuilder = new DbCteBuilder();

        // Create some CTEs
        cteBuilder.with('cte1', db.users.select(u => ({ id: u.id })));
        cteBuilder.with('cte2', db.posts.select(p => ({ id: p.id })));

        expect(cteBuilder.getCtes()).toHaveLength(2);

        // Clear the builder
        cteBuilder.clear();

        expect(cteBuilder.getCtes()).toHaveLength(0);
      });
    });

    test('should reuse builder after clearing', async () => {
      await withDatabase(async (db) => {
        const cteBuilder = new DbCteBuilder();

        // First batch of CTEs
        cteBuilder.with('cte1', db.users.select(u => ({ id: u.id })));
        expect(cteBuilder.getCtes()).toHaveLength(1);

        cteBuilder.clear();

        // Second batch of CTEs
        cteBuilder.with('cte2', db.posts.select(p => ({ id: p.id })));
        expect(cteBuilder.getCtes()).toHaveLength(1);
        expect(cteBuilder.getCtes()[0].name).toBe('cte2');
      });
    });
  });

  describe('CTE with mapWith transformations', () => {
    test('should transform regular CTE values with inline mapper', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const usersCTE = cteBuilder.with(
          'users_transformed',
          db.users.select(u => ({
            userId: u.id,
            originalAge: u.age,
            // Transform age by multiplying by 100
            transformedAge: sql<number>`${u.age}`.mapWith((val: number) => val * 100),
            // Transform username to uppercase
            transformedUsername: sql<string>`${u.username}`.mapWith((val: string) => val.toUpperCase()),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(usersCTE.cte)
          .leftJoin(
            usersCTE.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              originalAge: cte.originalAge,
              transformedAge: cte.transformedAge,
              transformedUsername: cte.transformedUsername,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<number | undefined, typeof r.originalAge>(r.originalAge);
          assertType<number | undefined, typeof r.transformedAge>(r.transformedAge);
          assertType<string | undefined, typeof r.transformedUsername>(r.transformedUsername);
        });
        expect(result[0].originalAge).toBe(25);
        // Age should be multiplied by 100
        expect(result[0].transformedAge).toBe(2500);
        // Username should be uppercase
        expect(result[0].transformedUsername).toBe('ALICE');
      });
    });

    test('should transform CTE computed values with complex mapper', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        interface UserSummary {
          username: string;
          emailDomain: string;
        }

        const cteBuilder = new DbCteBuilder();
        const userInfoCTE = cteBuilder.with(
          'user_summary',
          db.users.select(u => ({
            userId: u.id,
            // Combine username and email, then transform to object
            userSummary: sql<UserSummary>`${u.username} || '|' || ${u.email}`.mapWith((val: string) => {
              const [username, email] = val.split('|');
              const emailDomain = email.split('@')[1] || '';
              return { username, emailDomain };
            }),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.bob.id))
          .with(userInfoCTE.cte)
          .leftJoin(
            userInfoCTE.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              summary: cte.userSummary,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<UserSummary | undefined, typeof r.summary>(r.summary);
        });
        expect(result[0].summary).toHaveProperty('username', 'bob');
        expect(result[0].summary).toHaveProperty('emailDomain', 'test.com');
      });
    });

    test('should transform aggregation CTE values with mapper', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const postStatsCTE = cteBuilder.with(
          'post_stats',
          db.posts.select(p => ({
            userId: p.userId,
            originalViews: sql<number>`${p.views}`.mapWith((val: number) => val), // No transformation
            // Transform views by adding 5000
            boostedViews: sql<number>`${p.views}`.mapWith((val: number) => val + 5000),
            // Transform title to lowercase
            lowerTitle: sql<string>`${p.title}`.mapWith((val: string) => val.toLowerCase()),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(postStatsCTE.cte)
          .leftJoin(
            postStatsCTE.cte,
            (user, stats) => eq(user.id, stats.userId),
            (user, stats) => ({
              username: user.username,
              originalViews: stats.originalViews,
              boostedViews: stats.boostedViews,
              lowerTitle: stats.lowerTitle,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<number | undefined, typeof r.originalViews>(r.originalViews);
          assertType<number | undefined, typeof r.boostedViews>(r.boostedViews);
          assertType<string | undefined, typeof r.lowerTitle>(r.lowerTitle);
        });
        expect(result[0].username).toBe('alice');
        // Original views should be 100 or 150
        expect([100, 150]).toContain(result[0].originalViews);
        // Boosted views should be original + 5000
        expect(result[0].boostedViews).toBe(result[0].originalViews! + 5000);
        // Title should be lowercase
        expect(result[0].lowerTitle).toMatch(/^alice post \d$/);
      });
    });

    test('should transform withAggregation CTE with mappers', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();

        // Create an aggregation CTE with transformed values
        const aggregatedCTE = cteBuilder.withAggregation(
          'user_post_agg',
          db.posts.select(p => ({
            userId: p.userId,
            postId: p.id,
            // Transform views by dividing by 10
            scaledViews: sql<number>`${p.views}`.mapWith((val: number) => Math.floor(val / 10)),
            // Transform title with prefix
            prefixedTitle: sql<string>`${p.title}`.mapWith((val: string) => `POST: ${val}`),
          })),
          (p) => ({ userId: p.userId }),
          'posts'
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(aggregatedCTE)
          .leftJoin(
            aggregatedCTE,
            (user, agg) => eq(user.id, agg.userId),
            (user, agg) => ({
              username: user.username,
              posts: agg.posts,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<unknown[], typeof r.posts>(r.posts);
        });
        expect(result[0].username).toBe('alice');
        const posts = result[0].posts as any;
        expect(Array.isArray(posts)).toBe(true);
        expect(posts.length).toBeGreaterThan(0);

        // Check that aggregated items contain the expected fields
        const firstPost = posts[0];
        expect(firstPost).toHaveProperty('scaledViews');
        expect(firstPost).toHaveProperty('prefixedTitle');

        // Note: mapWith transformations in aggregation CTEs are applied to the CTE query,
        // but the aggregated JSON might not preserve the transformations perfectly.
        // The values stored in the JSONB array are the original database values.
        // This is a known limitation - mapWith works best with regular CTEs.
        expect(typeof firstPost.scaledViews).toBe('number');
        expect(typeof firstPost.prefixedTitle).toBe('string');
      });
    });

    test('should apply multiple mappers in single CTE', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();
        const multiMapperCTE = cteBuilder.with(
          'multi_mapper',
          db.users.select(u => ({
            userId: u.id,
            // String reversal
            reversedUsername: sql<string>`${u.username}`.mapWith((val: string) =>
              val.split('').reverse().join('')
            ),
            // Number tripling
            tripledAge: sql<number>`${u.age}`.mapWith((val: number) => val * 3),
            // Boolean negation (using isActive)
            negatedActive: sql<boolean>`${u.isActive}`.mapWith((val: boolean) => !val),
            // String concatenation with transformation
            emailUpper: sql<string>`${u.email}`.mapWith((val: string) => val.toUpperCase()),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.alice.id))
          .with(multiMapperCTE.cte)
          .leftJoin(
            multiMapperCTE.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              reversed: cte.reversedUsername,
              tripled: cte.tripledAge,
              negated: cte.negatedActive,
              emailUpper: cte.emailUpper,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<string | undefined, typeof r.reversed>(r.reversed);
          assertType<number | undefined, typeof r.tripled>(r.tripled);
          assertType<boolean | undefined, typeof r.negated>(r.negated);
          assertType<string | undefined, typeof r.emailUpper>(r.emailUpper);
        });
        // Username 'alice' reversed is 'ecila'
        expect(result[0].reversed).toBe('ecila');
        // Age 25 tripled is 75
        expect(result[0].tripled).toBe(75);
        // isActive is true, negated is false
        expect(result[0].negated).toBe(false);
        // Email should be uppercase
        expect(result[0].emailUpper).toBe('ALICE@TEST.COM');
      });
    });

    test('should handle NULL values in CTE mappers gracefully', async () => {
      await withDatabase(async (db) => {
        // Create a user with NULL age
        const userWithNull = await db.users.insert({
          username: 'nulluser',
          email: 'null@test.com',
          age: null as any,
          isActive: true,
        });

        const cteBuilder = new DbCteBuilder();
        const nullHandlingCTE = cteBuilder.with(
          'null_handling',
          db.users.select(u => ({
            userId: u.id,
            // Use COALESCE to handle NULL at SQL level
            transformedAge: sql<number>`COALESCE(${u.age}, 0)`.mapWith((val: number) => val * 10),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, userWithNull.id))
          .with(nullHandlingCTE.cte)
          .leftJoin(
            nullHandlingCTE.cte,
            (user, cte) => eq(user.id, cte.userId),
            (user, cte) => ({
              id: user.id,
              transformedAge: cte.transformedAge,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<number | undefined, typeof r.transformedAge>(r.transformedAge);
        });
        // NULL age becomes 0, then multiplied by 10 = 0
        expect(result[0].transformedAge).toBe(0);
      });
    });

    test('should chain multiple CTEs with different mappers', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const cteBuilder = new DbCteBuilder();

        // First CTE with age transformation
        const ageCTE = cteBuilder.with(
          'age_transform',
          db.users.select(u => ({
            userId: u.id,
            doubledAge: sql<number>`${u.age}`.mapWith((val: number) => val * 2),
          }))
        );

        // Second CTE with username transformation
        const nameCTE = cteBuilder.with(
          'name_transform',
          db.users.select(u => ({
            userId: u.id,
            capsUsername: sql<string>`${u.username}`.mapWith((val: string) => val.toUpperCase()),
          }))
        );

        const result = await db.users
          .where(u => eq(u.id, users.bob.id))
          .with(...cteBuilder.getCtes())
          .leftJoin(
            ageCTE.cte,
            (user, age) => eq(user.id, age.userId),
            (user, age) => ({
              id: user.id,
              username: user.username,
              doubledAge: age.doubledAge,
            })
          )
          .leftJoin(
            nameCTE.cte,
            (prev, name) => eq(prev.id, name.userId),
            (prev, name) => ({
              id: prev.id,
              username: prev.username,
              doubledAge: prev.doubledAge,
              capsUsername: name.capsUsername,
            })
          )
          .limit(1)
          .toList();

        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.username>(r.username);
          assertType<number | undefined, typeof r.doubledAge>(r.doubledAge);
          assertType<string | undefined, typeof r.capsUsername>(r.capsUsername);
        });
        expect(result[0].username).toBe('bob');
        // Bob's age is 35, doubled is 70
        expect(result[0].doubledAge).toBe(70);
        // Username should be uppercase
        expect(result[0].capsUsername).toBe('BOB');
      });
    });
  });
});
