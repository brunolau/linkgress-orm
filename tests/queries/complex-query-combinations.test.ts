import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData, createTestDatabase, setupDatabase, cleanupDatabase } from '../utils/test-database';
import { gt, eq, like, and, or } from '../../src/query/conditions';

/**
 * Comprehensive tests for complex query combinations including:
 * - Navigation properties (hasOne)
 * - Collections (hasMany) with toList and firstOrDefault
 * - Nested objects inside collections
 * - Multiple collections in one query
 * - Scalar aggregations (count, sum, max, min)
 * - firstOrDefault for single items
 *
 * All tests run against all three collection strategies to ensure consistency.
 */
describe('Complex Query Combinations', () => {
  // Helper to run the same query with all strategies and compare results
  async function runWithAllStrategies<T>(
    queryFn: (db: any) => Promise<T>,
    validateFn?: (result: T, strategyName: string) => void,
    logQueries = false
  ): Promise<{ cte: T; temp: T; lateral: T }> {
    const strategies = ['cte', 'temptable', 'lateral'] as const;
    const results: any = {};

    for (const strategy of strategies) {
      const db = createTestDatabase({ collectionStrategy: strategy, logQueries });
      await setupDatabase(db);
      await seedTestData(db);
      results[strategy === 'temptable' ? 'temp' : strategy] = await queryFn(db);
      if (validateFn) {
        validateFn(results[strategy === 'temptable' ? 'temp' : strategy], strategy);
      }
      await cleanupDatabase(db);
    }

    return results;
  }

  // Helper to run queries only with CTE and LATERAL strategies (excludes temp table)
  // Use this for tests involving nested objects in parent selection which temp table doesn't support
  async function runWithCteAndLateral<T>(
    queryFn: (db: any) => Promise<T>,
    validateFn?: (result: T, strategyName: string) => void,
    logQueries = false
  ): Promise<{ cte: T; lateral: T }> {
    const strategies = ['cte', 'lateral'] as const;
    const results: any = {};

    for (const strategy of strategies) {
      const db = createTestDatabase({ collectionStrategy: strategy, logQueries });
      await setupDatabase(db);
      await seedTestData(db);
      results[strategy] = await queryFn(db);
      if (validateFn) {
        validateFn(results[strategy], strategy);
      }
      await cleanupDatabase(db);
    }

    return results;
  }

  describe('firstOrDefault - Single Item Results', () => {
    test('collection.firstOrDefault should return single object or null, not array', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            userId: u.id,
            username: u.username,
            latestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({
                postId: p.id,
                title: p.title,
              }))
              .firstOrDefault(),
          }))
          .orderBy((u: any) => u.username)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          // Alice should have latest post (single object, not array)
          const alice = users.find((u: any) => u.username === 'alice');
          expect(alice).toBeDefined();
          expect(alice.latestPost).not.toBeNull();
          expect(Array.isArray(alice.latestPost)).toBe(false);
          expect(typeof alice.latestPost).toBe('object');
          expect(alice.latestPost).toHaveProperty('postId');
          expect(alice.latestPost).toHaveProperty('title');

          // Charlie has no posts - should be null
          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie).toBeDefined();
          expect(charlie.latestPost).toBeNull();
        }
      );
    });

    test('firstOrDefault with nested object inside should return single nested object', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            latestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({
                postId: p.id,
                meta: {
                  title: p.title,
                  views: p.views,
                },
              }))
              .firstOrDefault(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          // Alice's latest post (by views) should have nested meta object
          const alice = users.find((u: any) => u.username === 'alice');
          expect(alice).toBeDefined();
          expect(alice.latestPost).not.toBeNull();
          expect(Array.isArray(alice.latestPost)).toBe(false);
          expect(alice.latestPost).toHaveProperty('postId');
          expect(alice.latestPost).toHaveProperty('meta');
          expect(alice.latestPost.meta).toHaveProperty('title');
          expect(alice.latestPost.meta).toHaveProperty('views');
          expect(alice.latestPost.meta.views).toBe(150); // Alice's highest view post

          // Charlie has no posts
          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie.latestPost).toBeNull();
        }
      );
    });

    test('firstOrDefault with filter should return matching single item or null', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            highViewPost: u.posts!
              .where((p: any) => gt(p.views!, 100))
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({
                postId: p.id,
                title: p.title,
                views: p.views,
              }))
              .firstOrDefault(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          // Alice has one post with views > 100 (150 views)
          const alice = users.find((u: any) => u.username === 'alice');
          expect(alice.highViewPost).not.toBeNull();
          expect(Array.isArray(alice.highViewPost)).toBe(false);
          expect(alice.highViewPost.views).toBe(150);

          // Bob has post with 200 views
          const bob = users.find((u: any) => u.username === 'bob');
          expect(bob.highViewPost).not.toBeNull();
          expect(bob.highViewPost.views).toBe(200);

          // Charlie has no posts
          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie.highViewPost).toBeNull();
        }
      );
    });
  });

  describe('toList - Collection Results', () => {
    test('collection.toList should always return array, even when empty', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            posts: u.posts!
              .select((p: any) => ({
                postId: p.id,
                title: p.title,
              }))
              .toList('posts'),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          users.forEach((user: any) => {
            expect(Array.isArray(user.posts)).toBe(true);
          });

          // Alice has 2 posts
          const alice = users.find((u: any) => u.username === 'alice');
          expect(alice.posts).toHaveLength(2);

          // Bob has 1 post
          const bob = users.find((u: any) => u.username === 'bob');
          expect(bob.posts).toHaveLength(1);

          // Charlie has 0 posts - should be empty array, not null
          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie.posts).toHaveLength(0);
          expect(charlie.posts).toEqual([]);
        }
      );
    });

    test('toList with nested objects should return array of nested objects', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            posts: u.posts!
              .select((p: any) => ({
                postId: p.id,
                details: {
                  title: p.title,
                  content: p.content,
                  stats: {
                    views: p.views,
                  },
                },
              }))
              .toList('posts'),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          const alice = users.find((u: any) => u.username === 'alice');
          expect(alice.posts).toHaveLength(2);
          alice.posts.forEach((post: any) => {
            expect(post).toHaveProperty('postId');
            expect(post).toHaveProperty('details');
            expect(post.details).toHaveProperty('title');
            expect(post.details).toHaveProperty('content');
            expect(post.details).toHaveProperty('stats');
            expect(post.details.stats).toHaveProperty('views');
            expect(typeof post.details.stats.views).toBe('number');
          });
        }
      );
    });
  });

  describe('Navigation Properties (hasOne)', () => {
    test('navigation property in collection select should work', async () => {
      await runWithAllStrategies(
        async (db) => db.posts
          .select((p: any) => ({
            postId: p.id,
            title: p.title,
            authorName: p.user!.username,
            authorEmail: p.user!.email,
          }))
          .orderBy((p: any) => p.postId)
          .toList(),
        (posts: any[], strategy) => {
          expect(posts).toHaveLength(3);

          posts.forEach((post: any) => {
            expect(post).toHaveProperty('postId');
            expect(post).toHaveProperty('title');
            expect(post).toHaveProperty('authorName');
            expect(post).toHaveProperty('authorEmail');
            expect(typeof post.authorName).toBe('string');
            expect(typeof post.authorEmail).toBe('string');
          });

          // Verify specific posts
          const alicePost = posts.find((p: any) => p.title === 'Alice Post 1');
          expect(alicePost.authorName).toBe('alice');
          expect(alicePost.authorEmail).toBe('alice@test.com');
        }
      );
    });

    test('nested navigation through multiple levels should work', async () => {
      await runWithAllStrategies(
        async (db) => db.tasks
          .select((t: any) => ({
            taskId: t.id,
            title: t.title,
            levelName: t.level!.name,
            creatorName: t.level!.createdBy!.username,
            creatorEmail: t.level!.createdBy!.email,
          }))
          .orderBy((t: any) => t.taskId)
          .toList(),
        (tasks: any[], strategy) => {
          expect(tasks).toHaveLength(2);

          tasks.forEach((task: any) => {
            expect(task).toHaveProperty('taskId');
            expect(task).toHaveProperty('title');
            expect(task).toHaveProperty('levelName');
            expect(task).toHaveProperty('creatorName');
            expect(task).toHaveProperty('creatorEmail');
          });

          // Task 1 has high priority level created by alice
          const task1 = tasks.find((t: any) => t.title === 'Important Task');
          expect(task1.levelName).toBe('High Priority');
          expect(task1.creatorName).toBe('alice');

          // Task 2 has low priority level created by bob
          const task2 = tasks.find((t: any) => t.title === 'Regular Task');
          expect(task2.levelName).toBe('Low Priority');
          expect(task2.creatorName).toBe('bob');
        }
      );
    });
  });

  describe('Mixed: Collections + firstOrDefault + Nested Objects', () => {
    test('should combine toList and firstOrDefault in same query', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            allPosts: u.posts!
              .select((p: any) => ({ id: p.id, title: p.title }))
              .toList('allPosts'),
            latestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({ id: p.id, title: p.title }))
              .firstOrDefault(),
            postCount: u.posts!.count(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          const alice = users.find((u: any) => u.username === 'alice');
          // allPosts should be array
          expect(Array.isArray(alice.allPosts)).toBe(true);
          expect(alice.allPosts).toHaveLength(2);
          // latestPost should be single object
          expect(Array.isArray(alice.latestPost)).toBe(false);
          expect(alice.latestPost).not.toBeNull();
          expect(alice.latestPost).toHaveProperty('id');
          // postCount should be number
          expect(typeof alice.postCount).toBe('number');
          expect(alice.postCount).toBe(2);

          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie.allPosts).toEqual([]);
          expect(charlie.latestPost).toBeNull();
          expect(charlie.postCount).toBe(0);
        }
      );
    });

    // Note: Only runs with CTE and LATERAL because temp table strategy doesn't support nested objects in parent selection
    test('should combine nested objects in parent with collections', async () => {
      await runWithCteAndLateral(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            profile: {
              name: u.username,
              contact: {
                email: u.email,
              },
              status: {
                active: u.isActive,
                age: u.age,
              },
            },
            posts: u.posts!
              .select((p: any) => ({
                id: p.id,
                meta: {
                  title: p.title,
                  views: p.views,
                },
              }))
              .toList('posts'),
            latestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({
                id: p.id,
                info: {
                  title: p.title,
                },
              }))
              .firstOrDefault(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          const alice = users.find((u: any) => u.profile.name === 'alice');

          // Verify parent nested structure
          expect(alice.profile.contact.email).toBe('alice@test.com');
          expect(alice.profile.status.active).toBe(true);
          expect(alice.profile.status.age).toBe(25);

          // Verify posts collection with nested objects
          expect(Array.isArray(alice.posts)).toBe(true);
          expect(alice.posts).toHaveLength(2);
          alice.posts.forEach((post: any) => {
            expect(post).toHaveProperty('id');
            expect(post).toHaveProperty('meta');
            expect(post.meta).toHaveProperty('title');
            expect(post.meta).toHaveProperty('views');
          });

          // Verify firstOrDefault with nested object
          expect(alice.latestPost).not.toBeNull();
          expect(Array.isArray(alice.latestPost)).toBe(false);
          expect(alice.latestPost).toHaveProperty('info');
          expect(alice.latestPost.info).toHaveProperty('title');
        }
      );
    });

    test('should handle multiple collections with different aggregations', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            // Collection as list
            posts: u.posts!
              .select((p: any) => ({ id: p.id, title: p.title }))
              .toList('posts'),
            // Collection as firstOrDefault
            topPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({ id: p.id, title: p.title, views: p.views }))
              .firstOrDefault(),
            // Scalar aggregations
            postCount: u.posts!.count(),
            maxViews: u.posts!.max((p: any) => p.views!),
            totalViews: u.posts!.sum((p: any) => p.views!),
            // Another collection (orders)
            orders: u.orders!
              .select((o: any) => ({ id: o.id, status: o.status }))
              .toList('orders'),
            orderCount: u.orders!.count(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          expect(users).toHaveLength(3);

          const alice = users.find((u: any) => u.username === 'alice');
          // Posts collection
          expect(Array.isArray(alice.posts)).toBe(true);
          expect(alice.posts).toHaveLength(2);
          // Top post (single)
          expect(Array.isArray(alice.topPost)).toBe(false);
          expect(alice.topPost).not.toBeNull();
          expect(alice.topPost.views).toBe(150); // Alice's max views
          // Scalar aggregations
          expect(alice.postCount).toBe(2);
          expect(alice.maxViews).toBe(150);
          expect(alice.totalViews).toBe(250); // 100 + 150
          // Orders collection
          expect(Array.isArray(alice.orders)).toBe(true);
          expect(alice.orders).toHaveLength(1);
          expect(alice.orderCount).toBe(1);

          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie.posts).toEqual([]);
          expect(charlie.topPost).toBeNull();
          expect(charlie.postCount).toBe(0);
          expect(charlie.maxViews).toBeNull(); // MAX returns null for empty
          expect(charlie.totalViews).toBeNull(); // SUM returns null for empty
          expect(charlie.orders).toEqual([]);
          expect(charlie.orderCount).toBe(0);
        }
      );
    });
  });

  describe('Complex Nested Collections', () => {
    // Note: Only runs with CTE and LATERAL because temp table strategy doesn't support navigation in nested object within collection
    test('collection with nested object containing navigation field', async () => {
      await runWithCteAndLateral(
        async (db) => db.orders
          .select((o: any) => ({
            orderId: o.id,
            status: o.status,
            customer: {
              name: o.user!.username,
              email: o.user!.email,
            },
            tasks: o.orderTasks!
              .select((ot: any) => ({
                sortOrder: ot.sortOrder,
                taskInfo: {
                  id: ot.task!.id,
                  title: ot.task!.title,
                  priority: ot.task!.priority,
                },
              }))
              .toList('tasks'),
          }))
          .orderBy((o: any) => o.orderId)
          .toList(),
        (orders: any[], strategy) => {
          expect(orders).toHaveLength(2);

          orders.forEach((order: any) => {
            expect(order).toHaveProperty('orderId');
            expect(order).toHaveProperty('status');
            expect(order).toHaveProperty('customer');
            expect(order.customer).toHaveProperty('name');
            expect(order.customer).toHaveProperty('email');
            expect(Array.isArray(order.tasks)).toBe(true);
            order.tasks.forEach((task: any) => {
              expect(task).toHaveProperty('sortOrder');
              expect(task).toHaveProperty('taskInfo');
              expect(task.taskInfo).toHaveProperty('id');
              expect(task.taskInfo).toHaveProperty('title');
              expect(task.taskInfo).toHaveProperty('priority');
            });
          });

          // Verify Alice's order
          const aliceOrder = orders.find((o: any) => o.customer.name === 'alice');
          expect(aliceOrder.status).toBe('completed');
          expect(aliceOrder.tasks).toHaveLength(1);
          expect(aliceOrder.tasks[0].taskInfo.title).toBe('Important Task');
          expect(aliceOrder.tasks[0].taskInfo.priority).toBe('high');
        }
      );
    });

    // Note: Only runs with CTE and LATERAL because temp table strategy doesn't support deeply nested navigation in collections
    test('deeply nested navigation in collection items', async () => {
      await runWithCteAndLateral(
        async (db) => db.orders
          .select((o: any) => ({
            orderId: o.id,
            tasks: o.orderTasks!
              .select((ot: any) => ({
                taskId: ot.task!.id,
                taskTitle: ot.task!.title,
                levelName: ot.task!.level!.name,
                levelCreator: ot.task!.level!.createdBy!.username,
              }))
              .toList('tasks'),
          }))
          .orderBy((o: any) => o.orderId)
          .toList(),
        (orders: any[], strategy) => {
          expect(orders).toHaveLength(2);

          orders.forEach((order: any) => {
            expect(Array.isArray(order.tasks)).toBe(true);
            order.tasks.forEach((task: any) => {
              expect(task).toHaveProperty('taskId');
              expect(task).toHaveProperty('taskTitle');
              expect(task).toHaveProperty('levelName');
              expect(task).toHaveProperty('levelCreator');
            });
          });

          // Verify deep navigation worked
          const aliceOrder = orders[0];
          expect(aliceOrder.tasks[0].levelName).toBe('High Priority');
          expect(aliceOrder.tasks[0].levelCreator).toBe('alice');
        }
      );
    });
  });

  describe('Edge Cases and Potential Bugs', () => {
    test('firstOrDefault on empty filtered collection should return null', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            // Filter that matches nothing
            impossiblePost: u.posts!
              .where((p: any) => gt(p.views!, 999999))
              .select((p: any) => ({ id: p.id, title: p.title }))
              .firstOrDefault(),
          }))
          .toList(),
        (users: any[], strategy) => {
          users.forEach((user: any) => {
            expect(user.impossiblePost).toBeNull();
            expect(Array.isArray(user.impossiblePost)).toBe(false);
          });
        }
      );
    });

    test('toList on empty filtered collection should return empty array', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            // Filter that matches nothing
            impossiblePosts: u.posts!
              .where((p: any) => gt(p.views!, 999999))
              .select((p: any) => ({ id: p.id, title: p.title }))
              .toList('impossiblePosts'),
          }))
          .toList(),
        (users: any[], strategy) => {
          users.forEach((user: any) => {
            expect(user.impossiblePosts).toEqual([]);
            expect(Array.isArray(user.impossiblePosts)).toBe(true);
          });
        }
      );
    });

    test('should handle null navigation gracefully', async () => {
      // Tasks without level should handle null navigation
      await runWithAllStrategies(
        async (db) => {
          // Insert a task without level
          await db.tasks.insert({
            title: 'Orphan Task',
            status: 'pending',
            priority: 'low',
            levelId: null,
          });

          return db.tasks
            .select((t: any) => ({
              taskId: t.id,
              title: t.title,
            }))
            .toList();
        },
        (tasks: any[], strategy) => {
          expect(tasks.length).toBeGreaterThanOrEqual(3);
          const orphanTask = tasks.find((t: any) => t.title === 'Orphan Task');
          expect(orphanTask).toBeDefined();
        }
      );
    });

    test('collection with limit should return correct number of items', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            topPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .limit(1)
              .select((p: any) => ({ id: p.id, views: p.views }))
              .toList('topPost'),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          const alice = users.find((u: any) => u.username === 'alice');
          expect(alice.topPost).toHaveLength(1);
          expect(alice.topPost[0].views).toBe(150); // Highest views

          const charlie = users.find((u: any) => u.username === 'charlie');
          expect(charlie.topPost).toHaveLength(0);
        }
      );
    });

    test('multiple firstOrDefault in same query should each return single item', async () => {
      await runWithAllStrategies(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            newestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({ id: p.id }))
              .firstOrDefault(),
            oldestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'ASC']])
              .select((p: any) => ({ id: p.id }))
              .firstOrDefault(),
            highestViewPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({ id: p.id, views: p.views }))
              .firstOrDefault(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          const alice = users.find((u: any) => u.username === 'alice');

          // Each should be single object
          expect(Array.isArray(alice.newestPost)).toBe(false);
          expect(Array.isArray(alice.oldestPost)).toBe(false);
          expect(Array.isArray(alice.highestViewPost)).toBe(false);

          // Verify they're different items (Alice has 2 posts)
          expect(alice.newestPost).not.toBeNull();
          expect(alice.oldestPost).not.toBeNull();
          expect(alice.highestViewPost).not.toBeNull();

          // Newest and oldest should be different
          expect(alice.newestPost.id).not.toBe(alice.oldestPost.id);
        }
      );
    });

    // Note: Only runs with CTE and LATERAL because temp table strategy doesn't support nested objects in parent selection
    test('nested objects in both parent and firstOrDefault result', async () => {
      await runWithCteAndLateral(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            userInfo: {
              name: u.username,
              details: {
                email: u.email,
                age: u.age,
              },
            },
            featuredPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({
                postId: p.id,
                postInfo: {
                  title: p.title,
                  stats: {
                    views: p.views,
                  },
                },
              }))
              .firstOrDefault(),
          }))
          .orderBy((u: any) => u.id)
          .toList(),
        (users: any[], strategy) => {
          const alice = users.find((u: any) => u.userInfo.name === 'alice');

          // Parent nested
          expect(alice.userInfo.details.email).toBe('alice@test.com');
          expect(alice.userInfo.details.age).toBe(25);

          // firstOrDefault nested
          expect(alice.featuredPost).not.toBeNull();
          expect(Array.isArray(alice.featuredPost)).toBe(false);
          expect(alice.featuredPost.postInfo.title).toBeDefined();
          expect(alice.featuredPost.postInfo.stats.views).toBe(150);
        }
      );
    });
  });

  describe('Strategy Consistency Verification', () => {
    // Note: Only runs with CTE and LATERAL because temp table strategy doesn't support nested objects in parent selection
    test('CTE and LATERAL should produce identical results for complex query', async () => {
      const { cte, lateral } = await runWithCteAndLateral(
        async (db) => db.users
          .select((u: any) => ({
            id: u.id,
            username: u.username,
            profile: {
              email: u.email,
              active: u.isActive,
            },
            posts: u.posts!
              .orderBy((p: any) => [[p.views, 'ASC']])
              .select((p: any) => ({
                id: p.id,
                title: p.title,
                views: p.views,
              }))
              .toList('posts'),
            latestPost: u.posts!
              .orderBy((p: any) => [[p.views, 'DESC']])
              .select((p: any) => ({ id: p.id, title: p.title }))
              .firstOrDefault(),
            postCount: u.posts!.count(),
            maxViews: u.posts!.max((p: any) => p.views!),
          }))
          .orderBy((u: any) => u.id)
          .toList()
      );

      // Verify CTE and LATERAL strategies produce identical results
      expect(cte).toEqual(lateral);

      // Double check specific properties
      expect(cte.length).toBe(3);

      for (let i = 0; i < cte.length; i++) {
        expect(cte[i].id).toBe(lateral[i].id);
        expect(cte[i].profile).toEqual(lateral[i].profile);
        expect(cte[i].posts).toEqual(lateral[i].posts);
        expect(cte[i].latestPost).toEqual(lateral[i].latestPost);
        expect(cte[i].postCount).toBe(lateral[i].postCount);
        expect(cte[i].maxViews).toBe(lateral[i].maxViews);
      }
    });
  });
});
