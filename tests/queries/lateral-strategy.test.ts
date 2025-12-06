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
});
