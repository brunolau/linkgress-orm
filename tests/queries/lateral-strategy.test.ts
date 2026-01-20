import { withDatabase, seedTestData, createTestDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { gt, lt, gte, lte, eq, and, or, like, not } from '../../src/query/conditions';
import { assertType } from '../utils/type-tester';

describe('LATERAL Collection Strategy', () => {
  describe('Basic collection queries', () => {
    test('should fetch users with posts using lateral join', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            posts: u.posts!.select(p => ({
              postId: p.id,
              title: p.title,
              views: p.views,
            })).toList('posts'),
          }))
          .toList();

        expect(results.length).toBe(3);

        // Type assertions
        results.forEach(u => {
          assertType<number, typeof u.userId>(u.userId);
          assertType<string, typeof u.username>(u.username);
          assertType<{ postId: number; title: string | undefined; views: number }[], typeof u.posts>(u.posts);
        });

        // Verify Alice has 2 posts
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.posts.length).toBe(2);

        // Verify Bob has 1 post
        const bob = results.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.posts.length).toBe(1);

        // Verify Charlie has no posts
        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.posts.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should fetch users with ordered posts', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            posts: u.posts!
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .orderBy(p => [[p.views, 'DESC']])
              .toList('posts'),
          }))
          .toList();

        // Verify Alice's posts are ordered by views DESC
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.posts.length).toBe(2);
        expect(alice!.posts[0].views).toBe(150); // Post 2
        expect(alice!.posts[1].views).toBe(100); // Post 1
      }, { collectionStrategy: 'lateral' });
    });

    test('should handle empty collections', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .where(u => eq(u.username, 'charlie'))
          .select(u => ({
            username: u.username,
            posts: u.posts!.select(p => ({
              title: p.title,
            })).toList('posts'),
          }))
          .toList();

        expect(results.length).toBe(1);
        expect(results[0].username).toBe('charlie');
        expect(results[0].posts).toEqual([]);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Filtered collections', () => {
    test('should filter posts with WHERE clause', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            highViewPosts: u.posts!
              .where(p => gt(p.views!, 100))
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList('highViewPosts'),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<{ title: string | undefined; views: number }[], typeof u.highViewPosts>(u.highViewPosts);
        });

        // Alice has 1 post with views > 100 (Post 2 with 150 views)
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.highViewPosts.length).toBe(1);
        expect(alice!.highViewPosts[0].views).toBe(150);

        // Bob has 1 post with views > 100 (Bob Post with 200 views)
        const bob = results.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.highViewPosts.length).toBe(1);
        expect(bob!.highViewPosts[0].views).toBe(200);
      }, { collectionStrategy: 'lateral' });
    });

    test('should filter posts with chained WHERE clauses', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({
            username: u.username,
            filteredPosts: u.posts!
              .where(p => gte(p.views!, 100))
              .where(p => like(p.title!, '%Post%'))
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList('filteredPosts'),
          }))
          .toList();

        expect(results.length).toBe(1);
        expect(results[0].username).toBe('alice');
        // Both Alice Post 1 (100) and Alice Post 2 (150) match
        expect(results[0].filteredPosts.length).toBe(2);
      }, { collectionStrategy: 'lateral' });
    });

    test('should filter posts with complex WHERE conditions', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            posts: u.posts!
              .where(p => and(
                gte(p.views!, 100),
                like(p.title!, 'Alice%')
              ))
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList('posts'),
          }))
          .toList();

        // Only Alice's posts match the filter
        const alice = results.find(u => u.username === 'alice');
        expect(alice!.posts.length).toBe(2);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.posts.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Aggregations', () => {
    test('should count posts per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            postCount: u.posts!.count(),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<number, typeof u.postCount>(u.postCount);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.postCount).toBe(2);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.postCount).toBe(1);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.postCount).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should count filtered posts per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            highViewCount: u.posts!.where(p => gt(p.views!, 100)).count(),
          }))
          .toList();

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.highViewCount).toBe(1); // Only Post 2 (150)

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.highViewCount).toBe(1); // Bob Post (200)

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.highViewCount).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should get max views per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            maxViews: u.posts!.max(p => p.views!),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<number | null, typeof u.maxViews>(u.maxViews);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.maxViews).toBe(150);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.maxViews).toBe(200);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.maxViews).toBeNull();
      }, { collectionStrategy: 'lateral' });
    });

    test('should get min views per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            minViews: u.posts!.min(p => p.views!),
          }))
          .toList();

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.minViews).toBe(100);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.minViews).toBe(200);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.minViews).toBeNull();
      }, { collectionStrategy: 'lateral' });
    });

    test('should get sum of views per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            totalViews: u.posts!.sum(p => p.views!),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<number | null, typeof u.totalViews>(u.totalViews);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.totalViews).toBe(250); // 100 + 150

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.totalViews).toBe(200);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.totalViews).toBeNull();
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Limit and Offset', () => {
    test('should limit posts per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            topPost: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .limit(1)
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList('topPost'),
          }))
          .toList();

        // Alice's top post by views
        const alice = results.find(u => u.username === 'alice');
        expect(alice!.topPost.length).toBe(1);
        expect(alice!.topPost[0].views).toBe(150);

        // Bob's only post
        const bob = results.find(u => u.username === 'bob');
        expect(bob!.topPost.length).toBe(1);
        expect(bob!.topPost[0].views).toBe(200);

        // Charlie has no posts
        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.topPost.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should offset and limit posts per user', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            secondPost: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .offset(1)
              .limit(1)
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList('secondPost'),
          }))
          .toList();

        // Alice's second best post by views
        const alice = results.find(u => u.username === 'alice');
        expect(alice!.secondPost.length).toBe(1);
        expect(alice!.secondPost[0].views).toBe(100);

        // Bob only has 1 post, offset(1) returns nothing
        const bob = results.find(u => u.username === 'bob');
        expect(bob!.secondPost.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Array aggregations', () => {
    test('should collect string array with toStringList', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            postTitles: u.posts!.select(p => p.title!).toStringList('postTitles'),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<string[], typeof u.postTitles>(u.postTitles);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.postTitles.length).toBe(2);
        expect(alice!.postTitles.sort()).toEqual(['Alice Post 1', 'Alice Post 2'].sort());

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.postTitles).toEqual(['Bob Post']);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.postTitles).toEqual([]);
      }, { collectionStrategy: 'lateral' });
    });

    test('should collect number array with toNumberList', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            viewCounts: u.posts!.select(p => p.views!).toNumberList('viewCounts'),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<number[], typeof u.viewCounts>(u.viewCounts);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.viewCounts.sort((a, b) => a - b)).toEqual([100, 150]);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.viewCounts).toEqual([200]);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.viewCounts).toEqual([]);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Multiple collections', () => {
    test('should fetch multiple collections in same query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            posts: u.posts!.select(p => ({
              title: p.title,
            })).toList('posts'),
            orders: u.orders!.select(o => ({
              status: o.status,
              totalAmount: o.totalAmount,
            })).toList('orders'),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<{ title: string | undefined }[], typeof u.posts>(u.posts);
          assertType<{ status: string; totalAmount: number }[], typeof u.orders>(u.orders);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.posts.length).toBe(2);
        expect(alice!.orders.length).toBe(1);
        expect(alice!.orders[0].status).toBe('completed');

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.posts.length).toBe(1);
        expect(bob!.orders.length).toBe(1);
        expect(bob!.orders[0].status).toBe('pending');

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.posts.length).toBe(0);
        expect(charlie!.orders.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should fetch collection with aggregation in same query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            postCount: u.posts!.count(),
            posts: u.posts!.select(p => ({
              title: p.title,
            })).toList('posts'),
          }))
          .toList();

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.postCount).toBe(2);
        expect(alice!.posts.length).toBe(2);

        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie!.postCount).toBe(0);
        expect(charlie!.posts.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('DISTINCT collections', () => {
    test('should return distinct results with selectDistinct', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .select(u => ({
            username: u.username,
            distinctTitles: u.posts!.selectDistinct(p => ({
              title: p.title,
            })).orderBy(p => [[p.title, 'ASC']]).toList('distinctTitles'),
          }))
          .toList();

        // Type assertions
        results.forEach(u => {
          assertType<string, typeof u.username>(u.username);
          assertType<{ title: string | undefined }[], typeof u.distinctTitles>(u.distinctTitles);
        });

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.distinctTitles.length).toBe(2);
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Integration with main query filters', () => {
    test('should work with where clause on main table', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({
            username: u.username,
            posts: u.posts!.select(p => ({
              title: p.title,
            })).toList('posts'),
          }))
          .toList();

        // Only active users (alice and bob)
        expect(results.length).toBe(2);
        expect(results.map(u => u.username).sort()).toEqual(['alice', 'bob']);
      }, { collectionStrategy: 'lateral' });
    });

    test('should work with orderBy on main table', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Note: orderBy must be after select when using collection navigation
        const results = await db.users
          .select(u => ({
            username: u.username,
            postCount: u.posts!.count(),
          }))
          .orderBy(u => [[u.username, 'ASC']])
          .toList();

        expect(results.length).toBe(3);
        expect(results[0].username).toBe('alice');
        expect(results[1].username).toBe('bob');
        expect(results[2].username).toBe('charlie');
      }, { collectionStrategy: 'lateral' });
    });

    test('should work with limit on main table', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Note: orderBy and limit must be after select when using collection navigation
        const results = await db.users
          .select(u => ({
            username: u.username,
            age: u.age,
            postCount: u.posts!.count(),
          }))
          .orderBy(u => [[u.age, 'DESC']])
          .limit(2)
          .toList();

        // Oldest 2 users: charlie (45), bob (35)
        expect(results.length).toBe(2);
        expect(results[0].username).toBe('charlie');
        expect(results[1].username).toBe('bob');
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Nested object selection', () => {
    test('should support nested object structure in selection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .where(u => eq(u.username, 'alice'))
          .select(u => ({
            username: u.username,
            posts: u.posts!.select(p => ({
              info: {
                title: p.title,
                views: p.views,
              },
            })).toList('posts'),
          }))
          .toList();

        expect(results.length).toBe(1);
        expect(results[0].posts.length).toBe(2);
        expect(results[0].posts[0].info).toBeDefined();
        expect(results[0].posts[0].info.title).toBeDefined();
        expect(results[0].posts[0].info.views).toBeDefined();
      }, { collectionStrategy: 'lateral' });
    });
  });

  describe('Performance scenarios', () => {
    test('should efficiently handle limit per parent (lateral strength)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // This is where LATERAL shines - getting top N per parent
        const results = await db.users
          .select(u => ({
            username: u.username,
            top2Posts: u.posts!
              .orderBy(p => [[p.views, 'DESC']])
              .limit(2)
              .select(p => ({
                title: p.title,
                views: p.views,
              }))
              .toList('top2Posts'),
          }))
          .toList();

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.top2Posts.length).toBe(2);
        // Both posts ordered by views DESC
        expect(alice!.top2Posts[0].views).toBeGreaterThanOrEqual(alice!.top2Posts[1].views);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.top2Posts.length).toBe(1); // Bob only has 1 post
      }, { collectionStrategy: 'lateral' });
    });
  });
});

describe('LATERAL strategy with navigation to collection', () => {
  test('should correctly correlate collection through reference navigation', async () => {
    // This tests the fix for: nested collections use alias (relationName)
    // instead of table name for correlation in lateral joins
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Pattern: post -> user (reference) -> orders (collection)
      // The orders collection should correlate with "user"."id" (the alias)
      // not with "users"."id" (the table name)
      const postsWithUserOrders = await db.posts
        .select(p => ({
          postTitle: p.title,
          authorName: p.user!.username,
          authorOrders: p.user!.orders!
            .select(o => ({
              status: o.status,
              amount: o.totalAmount,
            }))
            .toList('authorOrders'),
        }))
        .toList();

      expect(postsWithUserOrders.length).toBeGreaterThan(0);
      postsWithUserOrders.forEach(post => {
        expect(post.authorName).toBeDefined();
        expect(Array.isArray(post.authorOrders)).toBe(true);
      });
    }, { collectionStrategy: 'lateral' });
  });

  test('should count collections through reference navigation', async () => {
    // Pattern: post -> user (reference) -> posts (collection) -> count()
    await withDatabase(async (db) => {
      await seedTestData(db);

      const postsWithAuthorStats = await db.posts
        .select(p => ({
          postTitle: p.title,
          authorName: p.user!.username,
          authorPostCount: p.user!.posts!.count(),
          authorOrderCount: p.user!.orders!.count(),
        }))
        .toList();

      expect(postsWithAuthorStats.length).toBeGreaterThan(0);
      postsWithAuthorStats.forEach(post => {
        expect(typeof post.authorPostCount).toBe('number');
        expect(typeof post.authorOrderCount).toBe('number');
      });
    }, { collectionStrategy: 'lateral' });
  });

  test('should join intermediate navigation tables for nested collection through chain', async () => {
    // This tests the fix for: missing FROM-clause entry for intermediate navigation tables
    // Pattern: users.posts (collection) -> user (reference) -> orders (collection)
    // The intermediate 'user' navigation needs to be joined in the lateral subquery
    await withDatabase(async (db) => {
      await seedTestData(db);

      // This query accesses a collection (orders) through a navigation chain (p.user)
      // inside another collection (posts)
      const usersWithNestedData = await db.users
        .withQueryOptions({ collectionStrategy: 'lateral' })
        .select(u => ({
          username: u.username,
          posts: u.posts!
            .select(p => ({
              title: p.title,
              // This should work: accessing user.orders from inside posts collection
              // The 'user' navigation must be joined in the lateral subquery for 'authorOrders'
              authorOrders: p.user!.orders!
                .select(o => ({
                  status: o.status,
                  amount: o.totalAmount,
                }))
                .toList('authorOrders'),
            }))
            .toList('posts'),
        }))
        .toList();

      expect(usersWithNestedData.length).toBeGreaterThan(0);
      const userWithPosts = usersWithNestedData.find(u => u.posts.length > 0);
      expect(userWithPosts).toBeDefined();

      // Each post should have authorOrders array (may be empty if user has no orders)
      userWithPosts!.posts.forEach(post => {
        expect(Array.isArray(post.authorOrders)).toBe(true);
      });
    }, { collectionStrategy: 'lateral' });
  });
});

describe('LATERAL strategy custom mapper transformation', () => {
  test('should apply custom mapper in collection with direct property name', async () => {
    // Tests that custom mapper (pgHourMinute) is applied when property name matches alias
    await withDatabase(async (db) => {
      await seedTestData(db);

      const results = await db.users
        .select(u => ({
          username: u.username,
          posts: u.posts!
            .select(p => ({
              title: p.title,
              publishTime: p.publishTime,  // Custom mapper: pgHourMinute
            }))
            .toList('posts'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      const userWithPosts = results.find(u => u.posts.length > 0);
      expect(userWithPosts).toBeDefined();

      // Verify mapper was applied - publishTime should be {hour, minute} object, not raw number
      const post = userWithPosts!.posts[0];
      expect(post.publishTime).toBeDefined();
      expect(typeof post.publishTime).toBe('object');
      expect(post.publishTime).toHaveProperty('hour');
      expect(post.publishTime).toHaveProperty('minute');
      expect(typeof post.publishTime.hour).toBe('number');
      expect(typeof post.publishTime.minute).toBe('number');
    }, { collectionStrategy: 'lateral' });
  });

  test('should apply custom mapper in collection with aliased property name', async () => {
    // Tests that custom mapper is applied when alias differs from property name
    // e.g., { postTime: p.publishTime } should still apply pgHourMinute mapper
    await withDatabase(async (db) => {
      await seedTestData(db);

      const results = await db.users
        .select(u => ({
          username: u.username,
          posts: u.posts!
            .select(p => ({
              title: p.title,
              postTime: p.publishTime,  // Alias differs from property name
            }))
            .toList('posts'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      const userWithPosts = results.find(u => u.posts.length > 0);
      expect(userWithPosts).toBeDefined();

      // Verify mapper was applied to aliased field
      const post = userWithPosts!.posts[0];
      expect(post.postTime).toBeDefined();
      expect(typeof post.postTime).toBe('object');
      expect(post.postTime).toHaveProperty('hour');
      expect(post.postTime).toHaveProperty('minute');
    }, { collectionStrategy: 'lateral' });
  });

  test('should apply custom mapper from navigation property in collection', async () => {
    // Tests that mapper is applied when field comes from navigation
    // e.g., o.user.createdAt should apply Date transformation from users schema
    await withDatabase(async (db) => {
      await seedTestData(db);

      const results = await db.users
        .select(u => ({
          username: u.username,
          orders: u.orders!
            .select(o => ({
              status: o.status,
              userCreatedAt: o.user!.createdAt,  // Field from navigation with Date type
            }))
            .toList('orders'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      const userWithOrders = results.find(u => u.orders.length > 0);
      expect(userWithOrders).toBeDefined();

      // Verify the field from navigation is present (createdAt is Date type)
      const order = userWithOrders!.orders[0];
      expect(order.userCreatedAt).toBeDefined();
      // Date fields should be transformed properly
      expect(order.userCreatedAt instanceof Date || typeof order.userCreatedAt === 'string').toBe(true);
    }, { collectionStrategy: 'lateral' });
  });

  test('should apply pgIntDatetime custom mapper in collection', async () => {
    // Tests pgIntDatetime custom mapper within a collection
    await withDatabase(async (db) => {
      await seedTestData(db);

      const results = await db.users
        .select(u => ({
          username: u.username,
          posts: u.posts!
            .select(p => ({
              title: p.title,
              customDate: p.customDate,  // Custom mapper: pgIntDatetime
            }))
            .toList('posts'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      const userWithPosts = results.find(u => u.posts.length > 0);
      expect(userWithPosts).toBeDefined();

      const post = userWithPosts!.posts[0];
      // customDate should be transformed to Date by pgIntDatetime mapper
      expect(post.customDate).toBeDefined();
      expect(post.customDate instanceof Date).toBe(true);
    }, { collectionStrategy: 'lateral' });
  });

  test('should apply pgIntDatetime mapper with aliased property', async () => {
    // Tests: customDate with alias -> dateValue
    await withDatabase(async (db) => {
      await seedTestData(db);

      const results = await db.users
        .select(u => ({
          username: u.username,
          posts: u.posts!
            .select(p => ({
              postTitle: p.title,
              dateValue: p.customDate,  // Aliased custom mapper field
            }))
            .toList('posts'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      const userWithPosts = results.find(u => u.posts.length > 0);
      expect(userWithPosts).toBeDefined();

      const post = userWithPosts!.posts[0];
      expect(post.dateValue).toBeDefined();
      expect(post.dateValue instanceof Date).toBe(true);
    }, { collectionStrategy: 'lateral' });
  });
});

describe('LATERAL with outer reference in collection WHERE', () => {
  test('should correctly reference outer scope in collection where clause', async () => {
    // This tests the fix for: collection navigation through intermediate tables
    // When accessing post.user.posts.where(p => eq(post.userId, p.userId))
    // The inner 'p' (from user.posts) should have a different alias than outer 'post'
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Pattern: posts -> user (reference) -> posts (collection back to same table)
      // The WHERE clause references both outer 'post' and inner 'p'
      const postsWithSiblings = await db.posts
        .withQueryOptions({ collectionStrategy: 'lateral' })
        .select(post => ({
          postId: post.id,
          title: post.title,
          // Navigate through user to get sibling posts (by same user)
          siblingPosts: post.user!.posts!
            .where(p => eq(post.userId, p.userId))  // This should work: outer post.userId vs inner p.userId
            .select(p => ({
              siblingId: p.id,
              siblingTitle: p.title,
            }))
            .toList(),
        }))
        .toList();

      expect(postsWithSiblings.length).toBeGreaterThan(0);
      // Each post should have sibling posts (posts by same user)
      const alicePost = postsWithSiblings.find(p => p.title?.includes('Alice'));
      expect(alicePost).toBeDefined();
      // Alice has 2 posts, so her sibling list should have 2 entries (including self)
      expect(alicePost!.siblingPosts.length).toBe(2);
    }, { collectionStrategy: 'lateral' });
  });

  test('should handle different table aliases for same table in nested navigation', async () => {
    // More complex case: The outer query table and collection target table are the same
    // This should NOT produce "column.x = column.x" but proper cross-reference
    // If the SQL were malformed with self-comparison, the query would fail with an error
    await withDatabase(async (db) => {
      await seedTestData(db);

      const results = await db.posts
        .withQueryOptions({ collectionStrategy: 'lateral' })
        .where(post => eq(post.userId, 1))  // Filter to user 1's posts (Alice)
        .select(post => ({
          postId: post.id,
          title: post.title,
          // Navigate to user and back to posts, filtering by outer post's userId
          sameAuthorPosts: post.user!.posts!
            .where(p => eq(post.userId, p.userId))
            .select(p => ({
              id: p.id,
              title: p.title,
            }))
            .toList(),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
    }, { collectionStrategy: 'lateral' });
  });
});

describe('LATERAL Strategy SQL Generation', () => {
  test('should use LEFT JOIN LATERAL ON true pattern', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Capture the SQL
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);

      try {
        await db.users
          .withQueryOptions({ logQueries: true, collectionStrategy: 'lateral' })
          .select(u => ({
            username: u.username,
            posts: u.posts!.select(p => ({
              title: p.title,
            })).toList('posts'),
          }))
          .toList();

        // Check SQL contains LATERAL JOIN
        const sqlLog = logs.find(log => log.includes('LEFT JOIN LATERAL'));
        expect(sqlLog).toBeDefined();
        expect(sqlLog).toContain('ON true');
      } finally {
        console.log = originalLog;
      }
    }, { collectionStrategy: 'lateral' });
  });

  describe('Nested collections', () => {
    test('should handle nested collection with toNumberList inside toList', async () => {
      // This tests the bug where nested collections with correlated subqueries (toNumberList)
      // inside a LATERAL join (toList) would generate invalid SQL with non-existent relations
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query: users -> orders -> orderTasks (as number list of task IDs)
        const results = await db.users
          .select(u => ({
            username: u.username,
            orders: u.orders!.select(o => ({
              orderId: o.id,
              status: o.status,
              taskIds: o.orderTasks!.select(ot => ({
                id: ot.taskId,
              })).toNumberList('taskIds'),
            })).toList('orders'),
          }))
          .toList();

        expect(results.length).toBe(3);

        // Alice has 1 order with 1 task
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.orders.length).toBe(1);
        expect(alice!.orders[0].taskIds).toBeInstanceOf(Array);
        expect(alice!.orders[0].taskIds.length).toBe(1);

        // Bob has 1 order with 1 task
        const bob = results.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.orders.length).toBe(1);
        expect(bob!.orders[0].taskIds.length).toBe(1);

        // Charlie has no orders
        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.orders.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should handle nested collection with count inside toList', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query: users -> orders -> count of orderTasks
        const results = await db.users
          .select(u => ({
            username: u.username,
            orders: u.orders!.select(o => ({
              orderId: o.id,
              taskCount: o.orderTasks!.count(),
            })).toList('orders'),
          }))
          .toList();

        expect(results.length).toBe(3);

        const alice = results.find(u => u.username === 'alice');
        expect(alice!.orders[0].taskCount).toBe(1);

        const bob = results.find(u => u.username === 'bob');
        expect(bob!.orders[0].taskCount).toBe(1);
      }, { collectionStrategy: 'lateral' });
    });

    test('should isolate sibling collections with nested correlated subqueries', async () => {
      // This test verifies that sibling collections at the same level don't interfere with each other.
      // The bug was that when one LATERAL collection (e.g., orders with orderTasks.toNumberList)
      // registers its table alias, it would leak into sibling collections (e.g., posts),
      // causing SQL errors like "missing FROM-clause entry for table lateral_X_tableName"
      //
      // The fix involves saving and restoring the lateralTableAliasMap state after each
      // sibling collection is built, so that each sibling starts with a clean map.
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query with TWO sibling collections, BOTH containing nested correlated subqueries
        // This pattern would fail before the fix because:
        // 1. First collection (orders) registers "orders" -> "lateral_0_orders" in the map
        // 2. After first collection completes, the map is NOT cleaned up (the bug)
        // 3. Second collection (posts) builds and the stale "orders" entry could interfere
        //    with any nested queries that might reference overlapping tables
        const results = await db.users
          .select(u => ({
            username: u.username,
            // First sibling collection with nested correlated subquery (toNumberList)
            orders: u.orders!.select(o => ({
              orderId: o.id,
              taskIds: o.orderTasks!.select(ot => ({ id: ot.taskId })).toNumberList('taskIds'),
            })).toList('orders'),
            // Second sibling collection - even without nested correlated subquery,
            // this tests that the first sibling's alias map doesn't leak
            posts: u.posts!.select(p => ({
              postId: p.id,
              title: p.title,
              views: p.views,
            })).toList('posts'),
          }))
          .toList();

        expect(results.length).toBe(3);

        // Verify Alice has both orders and posts
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.orders.length).toBe(1);
        expect(alice!.orders[0].taskIds).toBeInstanceOf(Array);
        expect(alice!.orders[0].taskIds.length).toBe(1); // Alice's order has 1 task
        expect(alice!.posts.length).toBe(2);
        expect(alice!.posts[0].title).toBeDefined();

        // Verify Bob has both orders and posts
        const bob = results.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.orders.length).toBe(1);
        expect(bob!.orders[0].taskIds.length).toBe(1); // Bob's order has 1 task
        expect(bob!.posts.length).toBe(1);

        // Verify Charlie has no orders and no posts
        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.orders.length).toBe(0);
        expect(charlie!.posts.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('should isolate sibling collections when same table appears in multiple siblings with nested queries', async () => {
      // This test verifies that multiple sibling collections targeting the SAME table
      // with nested correlated subqueries work correctly.
      //
      // The fix (save/restore lateralTableAliasMap) ensures that each sibling collection
      // operates with a clean map state, preventing stale aliases from a previous sibling
      // from affecting the current one. This is a defensive measure that prevents a class
      // of bugs like "missing FROM-clause entry for table lateral_X_tableName".
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query with TWO sibling collections targeting the SAME table (orders)
        // Each sibling has a nested correlated subquery that needs to reference its parent
        const results = await db.users
          .select(u => ({
            username: u.username,
            // First sibling: completed orders with nested orderTasks
            // This registers "orders" -> "lateral_0_orders" in the map
            completedOrders: u.orders!
              .where(o => eq(o.status, 'completed'))
              .select(o => ({
                orderId: o.id,
                taskIds: o.orderTasks!.select(ot => ({ id: ot.taskId })).toNumberList('taskIds'),
              })).toList('completedOrders'),
            // Second sibling: pending orders with nested orderTasks (SAME table!)
            // WITHOUT THE FIX: the nested orderTasks lookup finds stale "lateral_0_orders"
            // which is out of scope for this second LATERAL join
            pendingOrders: u.orders!
              .where(o => eq(o.status, 'pending'))
              .select(o => ({
                orderId: o.id,
                taskIds: o.orderTasks!.select(ot => ({ id: ot.taskId })).toNumberList('taskIds'),
              })).toList('pendingOrders'),
          }))
          .toList();

        expect(results.length).toBe(3);

        // Verify Alice has completed order but no pending orders
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.completedOrders.length).toBe(1);
        expect(alice!.completedOrders[0].taskIds).toBeInstanceOf(Array);
        expect(alice!.pendingOrders.length).toBe(0);

        // Verify Bob has pending order but no completed orders
        const bob = results.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.completedOrders.length).toBe(0);
        expect(bob!.pendingOrders.length).toBe(1);
        expect(bob!.pendingOrders[0].taskIds).toBeInstanceOf(Array);

        // Verify Charlie has no orders
        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.completedOrders.length).toBe(0);
        expect(charlie!.pendingOrders.length).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });

    test('complex ecommerce pattern: sibling collections with nested toNumberList and navigation', async () => {
      // This test replicates the EXACT pattern from complex ecommerce that triggered the bug:
      // "missing FROM-clause entry for table lateral_X_products"
      //
      // The query pattern is:
      // db.products.select(product => ({
      //   tagIds: product.productTags.select(pt => ({ id: pt.tag.id })).toNumberList(),  // sibling 1
      //   seasonIds: product.productPrices.selectDistinct(p => ({ seasonId: p.seasonId })).toNumberList(), // sibling 2
      // }))
      //
      // The bug pattern:
      // 1. First sibling (productTags) builds as LATERAL, registers "product_tags" in lateralTableAliasMap
      // 2. productTags has navigation to tag (pt.tag.id) which adds a JOIN
      // 3. Second sibling (productPrices) builds as LATERAL
      // 4. productPrices.toNumberList() builds a correlated subquery
      // 5. WITHOUT THE FIX: The buildNavigationJoinsWithAlias looks up sourceAlias in the map
      //    and may incorrectly find stale aliases from the first sibling
      // 6. This causes: "missing FROM-clause entry for table lateral_X_tableName"
      //
      // WITH THE FIX: Each sibling's map entries are cleaned up after building,
      // preventing stale aliases from leaking to sibling collections.
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query that mirrors the complex ecommerce pattern exactly:
        // - productTags with navigation (pt.tag!.id)
        // - productPrices with toNumberList (sibling)
        const results = await db.products
          .select(product => ({
            productId: product.id,
            productName: product.name,
            // Sibling 1: productTags with navigation to tag table
            tagIds: product.productTags!.select(pt => ({
              id: pt.tag!.id,  // Navigation: productTag -> tag
            })).toNumberList('tagIds'),
            // Sibling 2: productPrices with toNumberList
            seasonIds: product.productPrices!.selectDistinct(pp => ({
              seasonId: pp.seasonId,
            })).toNumberList('seasonIds'),
          }))
          .toList();

        expect(results.length).toBe(2); // skiPass and liftTicket

        // Verify skiPass has 2 tags and 2 seasons
        const skiPass = results.find(p => p.productName === 'Ski Pass');
        expect(skiPass).toBeDefined();
        expect(skiPass!.tagIds).toBeInstanceOf(Array);
        expect(skiPass!.tagIds.length).toBe(2); // winterTag, familyTag
        expect(skiPass!.seasonIds).toBeInstanceOf(Array);
        expect(skiPass!.seasonIds.length).toBe(2); // season 1 and 2

        // Verify liftTicket has 1 tag and 1 season
        const liftTicket = results.find(p => p.productName === 'Lift Ticket');
        expect(liftTicket).toBeDefined();
        expect(liftTicket!.tagIds).toBeInstanceOf(Array);
        expect(liftTicket!.tagIds.length).toBe(1); // summerTag
        expect(liftTicket!.seasonIds).toBeInstanceOf(Array);
        expect(liftTicket!.seasonIds.length).toBe(1); // season 1
      }, { collectionStrategy: 'lateral' });
    });

    test('complex ecommerce pattern: deeply nested capacityGroupIds inside prices', async () => {
      // This tests the original bug pattern that was fixed in v0.2.14:
      // Nested collections inside LATERAL joins with correlated subqueries.
      //
      // The query pattern is:
      // db.products.select(product => ({
      //   prices: product.productPrices.select(price => ({
      //     capacityGroupIds: price.productPriceCapacityGroups.select(cg => ({
      //       id: cg.capacityGroupId,
      //     })).toNumberList('capacityGroupIds'),
      //   })).toList('prices'),
      // }))
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Query with nested collection inside collection
        const results = await db.products
          .select(product => ({
            productId: product.id,
            productName: product.name,
            prices: product.productPrices!.select(price => ({
              priceId: price.id,
              seasonId: price.seasonId,
              priceAmount: price.price,
              // Nested: capacityGroupIds inside prices
              capacityGroupIds: price.productPriceCapacityGroups!.select(cg => ({
                id: cg.capacityGroupId,
              })).toNumberList('capacityGroupIds'),
            })).toList('prices'),
          }))
          .toList();

        expect(results.length).toBe(2);

        // Verify skiPass has 2 prices with capacity groups
        const skiPass = results.find(p => p.productName === 'Ski Pass');
        expect(skiPass).toBeDefined();
        expect(skiPass!.prices.length).toBe(2);
        // First price (winter) has 2 capacity groups
        const winterPrice = skiPass!.prices.find(p => p.seasonId === 1);
        expect(winterPrice!.capacityGroupIds.length).toBe(2);
        // Second price (summer) has 1 capacity group
        const summerPrice = skiPass!.prices.find(p => p.seasonId === 2);
        expect(summerPrice!.capacityGroupIds.length).toBe(1);

        // Verify liftTicket
        const liftTicket = results.find(p => p.productName === 'Lift Ticket');
        expect(liftTicket).toBeDefined();
        expect(liftTicket!.prices.length).toBe(1);
        expect(liftTicket!.prices[0].capacityGroupIds.length).toBe(1);
      }, { collectionStrategy: 'lateral' });
    });

    test('complex ecommerce pattern: combined sibling collections with deeply nested queries', async () => {
      // This is the COMPLETE pattern that triggered the regression:
      // Multiple sibling collections at the same level, where one sibling has
      // deeply nested collections, and another sibling has navigation.
      //
      // This is the pattern that would fail with:
      // "missing FROM-clause entry for table lateral_X_products"
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.products
          .select(product => ({
            productId: product.id,
            productName: product.name,
            // Sibling 1: tagIds with navigation (pt.tag!.id)
            tagIds: product.productTags!.select(pt => ({
              id: pt.tag!.id,
            })).toNumberList('tagIds'),
            // Sibling 2: prices with nested capacityGroupIds
            prices: product.productPrices!.select(price => ({
              priceId: price.id,
              capacityGroupIds: price.productPriceCapacityGroups!.select(cg => ({
                id: cg.capacityGroupId,
              })).toNumberList('capacityGroupIds'),
            })).toList('prices'),
            // Sibling 3: seasonIds (simple toNumberList)
            seasonIds: product.productPrices!.selectDistinct(pp => ({
              seasonId: pp.seasonId,
            })).toNumberList('seasonIds'),
          }))
          .toList();

        expect(results.length).toBe(2);

        // Verify skiPass
        const skiPass = results.find(p => p.productName === 'Ski Pass');
        expect(skiPass).toBeDefined();
        expect(skiPass!.tagIds.length).toBe(2);
        expect(skiPass!.prices.length).toBe(2);
        expect(skiPass!.seasonIds.length).toBe(2);

        // Verify liftTicket
        const liftTicket = results.find(p => p.productName === 'Lift Ticket');
        expect(liftTicket).toBeDefined();
        expect(liftTicket!.tagIds.length).toBe(1);
        expect(liftTicket!.prices.length).toBe(1);
        expect(liftTicket!.seasonIds.length).toBe(1);
      }, { collectionStrategy: 'lateral' });
    });

    test('complex ecommerce pattern: sibling collections where one navigates back to parent table', async () => {
      // This test triggers the exact bug by having a sibling collection that navigates
      // BACK to the parent table (products) within a nested collection.
      //
      // The bug pattern:
      // 1. products.productPrices.select(price => price.product.name) - NAVIGATES back to products!
      // 2. This adds "products" to the lateralTableAliasMap
      // 3. Sibling collection products.productTags tries to build
      // 4. WITHOUT THE FIX: It finds stale "products" alias in the map
      // 5. This causes: "missing FROM-clause entry for table lateral_X_products"
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.products
          .select(product => ({
            productId: product.id,
            productName: product.name,
            // Sibling 1: productPrices with navigation BACK to product table (price.product.name)
            // This creates a JOIN to products table inside the LATERAL, adding it to the map
            pricesWithProductName: product.productPrices!.select(price => ({
              priceId: price.id,
              seasonId: price.seasonId,
              // CRITICAL: This navigates back to the products table!
              productNameFromPrice: price.product!.name,
            })).toList('pricesWithProductName'),
            // Sibling 2: tagIds - if the first sibling pollutes the map with "products" alias,
            // this sibling's correlation might incorrectly reference it
            tagIds: product.productTags!.select(pt => ({
              id: pt.tag!.id,
            })).toNumberList('tagIds'),
          }))
          .toList();

        expect(results.length).toBe(2);

        // Verify skiPass
        const skiPass = results.find(p => p.productName === 'Ski Pass');
        expect(skiPass).toBeDefined();
        expect(skiPass!.pricesWithProductName.length).toBe(2);
        expect(skiPass!.pricesWithProductName[0].productNameFromPrice).toBe('Ski Pass');
        expect(skiPass!.tagIds.length).toBe(2);

        // Verify liftTicket
        const liftTicket = results.find(p => p.productName === 'Lift Ticket');
        expect(liftTicket).toBeDefined();
        expect(liftTicket!.pricesWithProductName.length).toBe(1);
        expect(liftTicket!.tagIds.length).toBe(1);
      }, { collectionStrategy: 'lateral' });
    });

    test('regression: sibling collections with nested navigation and shared table references', async () => {
      // This test ensures sibling collection isolation works correctly.
      //
      // The fix (lateralTableAliasMap cleanup) prevents a class of bugs where:
      // - One sibling collection's internal table alias could leak to another sibling
      // - This could cause "missing FROM-clause entry for table lateral_X_tableName" errors
      //
      // Pattern tested:
      // - Sibling 1: posts collection with nested navigation to orders (post.user.orders)
      // - Sibling 2: orders collection at the same level
      // - The fix ensures sibling 2 doesn't see stale aliases from sibling 1
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users
          .withQueryOptions({ collectionStrategy: 'lateral' })
          .select(user => ({
            userId: user.id,
            username: user.username,
            // Sibling 1: posts with nested orders through navigation chain
            postsWithNestedOrders: user.posts!.select(post => ({
              postId: post.id,
              title: post.title,
              // Nested collection through navigation: post -> user -> orders
              authorOrders: post.user!.orders!.select(o => ({ id: o.id })).toList('authorOrders'),
            })).toList('postsWithNestedOrders'),
            // Sibling 2: direct orders collection
            totalOrders: user.orders!.count(),
          }))
          .toList();

        expect(results.length).toBe(3); // alice, bob, charlie

        // Verify alice
        const alice = results.find(u => u.username === 'alice');
        expect(alice).toBeDefined();
        expect(alice!.postsWithNestedOrders.length).toBe(2); // Alice has 2 posts
        expect(alice!.postsWithNestedOrders[0].authorOrders.length).toBe(1); // Alice has 1 order
        expect(alice!.totalOrders).toBe(1);

        // Verify bob
        const bob = results.find(u => u.username === 'bob');
        expect(bob).toBeDefined();
        expect(bob!.postsWithNestedOrders.length).toBe(1); // Bob has 1 post
        expect(bob!.postsWithNestedOrders[0].authorOrders.length).toBe(1); // Bob has 1 order
        expect(bob!.totalOrders).toBe(1);

        // Verify charlie (no posts, no orders)
        const charlie = results.find(u => u.username === 'charlie');
        expect(charlie).toBeDefined();
        expect(charlie!.postsWithNestedOrders.length).toBe(0);
        expect(charlie!.totalOrders).toBe(0);
      }, { collectionStrategy: 'lateral' });
    });
  });
});
