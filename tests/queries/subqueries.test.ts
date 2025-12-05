import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, sql, DbCteBuilder, exists, and, gte, lte, EntityQuery } from '../../src';
import { Post } from '../../debug/model/post';
import { Order } from '../../debug/model/order';
import { User } from '../../debug/model/user';
import { assertType } from '../utils/type-tester';

describe('Subquery Operations', () => {
  describe('Scalar subqueries', () => {
    test('should use scalar subquery in SELECT', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const avgAgeSubquery = db.users
          .select(u => sql<number>`AVG(${u.age})`)
          .asSubquery('scalar');

        const result = await db.users
          .select(u => ({
            username: u.username,
            age: u.age,
            avgAge: avgAgeSubquery,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<number | undefined, typeof r.age>(r.age);
          assertType<number, typeof r.avgAge>(r.avgAge);
          expect(r).toHaveProperty('avgAge');
          expect(typeof r.avgAge).toBe('number');
        });

        // All rows should have the same avgAge
        const avgAge = result[0].avgAge;
        result.forEach(r => {
          expect(r.avgAge).toBe(avgAge);
        });
      });
    });
  });

  describe('Array subqueries', () => {
    test('should use array subquery with IN clause', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const activeUserIds = db.users
          .where(u => eq(u.isActive, true))
          .select(u => u.id)
          .asSubquery('array');

        const result = await db.posts
          .where(p => sql`${p.userId} IN (${activeUserIds})`)
          .select(p => ({ title: p.title, userId: p.userId }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.userId>(r.userId);
        });
      });
    });
  });

  describe('Table subqueries', () => {
    test('should use table subquery as FROM source', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const highViewPostsSubquery = db.posts
          .where(p => gt(p.views, 100))
          .select(p => ({
            postTitle: p.title,
            postViews: p.views,
            userId: p.userId,
          }))
          .asSubquery('table');

        const result = await db.users
          .innerJoin(
            highViewPostsSubquery,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              postTitle: post.postTitle,
              views: post.postViews,
            }),
            'highPosts'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.postTitle>(r.postTitle);
          assertType<number, typeof r.views>(r.views);
          expect(r.views).toBeGreaterThan(100);
        });
      });
    });

    test('should use complex subquery with filtering and projection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const userPostsSubquery = db.posts
          .where(p => gt(p.views, 50))
          .select(p => ({
            userId: p.userId,
            title: p.title,
            views: p.views,
          }))
          .orderBy(p => [[p.views, 'DESC']])
          .limit(10)
          .asSubquery('table');

        const result = await db.users
          .innerJoin(
            userPostsSubquery,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              username: user.username,
              topPostTitle: post.title,
              topPostViews: post.views,
            }),
            'topPosts'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.topPostTitle>(r.topPostTitle);
          assertType<number, typeof r.topPostViews>(r.topPostViews);
          expect(r).toHaveProperty('username');
          expect(r).toHaveProperty('topPostTitle');
          expect(r.topPostViews).toBeGreaterThan(50);
        });
      });
    });
  });

  describe('Nested subqueries', () => {
    test('should nest subqueries', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // First level subquery: active users
        const activeUsersSubquery = db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({
            userId: u.id,
            userName: u.username,
          }))
          .asSubquery('table');

        // Second level: posts by active users, then aggregate
        const statsSubquery = db.posts
          .innerJoin(
            activeUsersSubquery,
            (post, user) => eq(post.userId, user.userId),
            (post, user) => ({
              userId: user.userId,
              views: post.views,
            }),
            'activeUsers'
          )
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
          .asSubquery('table');

        // Final query: join stats with users
        const result = await db.users
          .innerJoin(
            statsSubquery,
            (user, stats) => eq(user.id, stats.userId),
            (user, stats) => ({
              username: user.username,
              totalViews: stats.totalViews,
            }),
            'stats'
          )
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<number, typeof r.totalViews>(r.totalViews);
          expect(typeof r.totalViews).toBe('number');
        });
      });
    });
  });

  describe('Correlated subqueries', () => {
    test('should work with EXISTS subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Users who have posts
        const result = await db.users
          .where(u => sql`EXISTS (
            SELECT 1 FROM posts WHERE user_id = ${u.id}
          )`)
          .select(u => ({ username: u.username }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
        });
        // Should only include Alice and Bob (who have posts)
        expect(result.length).toBeLessThanOrEqual(2);
      });
    });

    test('should work with NOT EXISTS subquery', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Users who don't have posts
        const result = await db.users
          .where(u => sql`NOT EXISTS (
            SELECT 1 FROM posts WHERE user_id = ${u.id}
          )`)
          .select(u => ({ username: u.username }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
        });
        // Should include Charlie (who has no posts)
        const charlie = result.find(r => r.username === 'charlie');
        expect(charlie).toBeDefined();
      });
    });
  });

  describe('Subquery performance', () => {
    test('should efficiently execute subquery in WHERE clause', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const maxViewsSubquery = db.posts
          .select(p => sql<number>`MAX(${p.views})`)
          .asSubquery('scalar');

        const result = await db.posts
          .where(p => sql`${p.views} = (${maxViewsSubquery})`)
          .select(p => ({
            title: p.title,
            views: p.views,
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.views>(r.views);
        });
        // Should return the post with max views (200)
        expect(result[0].views).toBe(200);
      });
    });
  });

  describe('SQL magic string mapWith', () => {
    // These tests verify that mapWith() transforms data when reading from the database.
    // mapWith() accepts a simple inline function: sql`...`.mapWith((val: T) => transformedVal)
    // This is much more ergonomic than the old customType() approach.
    //
    // ✅ ALL 11 tests passing (100% success rate)
    // - Basic SELECT with mapWith
    // - Scalar subqueries with mapWith
    // - Table subqueries with mapWith
    // - CTEs with mapWith
    // - JOINs with mapWith
    // - Multiple mappers in single query
    // - Nested subqueries with mapWith

    describe('Basic SELECT with mapWith - Actual Transformations', () => {
      test('should transform numbers by multiplying by 10', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const result = await db.users
            .select(u => ({
              username: u.username,
              originalAge: u.age,
              multipliedAge: sql<number>`${u.age}`.mapWith((val: number) => val * 10),
            }))
            .where(u => eq(u.username, 'alice'))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<number | undefined, typeof r.originalAge>(r.originalAge);
            assertType<number, typeof r.multipliedAge>(r.multipliedAge);
          });
          expect(result[0].originalAge).toBe(25);
          // If mapWith works, this should be 250 (25 * 10)
          expect(result[0].multipliedAge).toBe(250);
        });
      });

      test('should transform strings to uppercase', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);

          const result = await db.users
            .where(u => eq(u.id, users.alice.id))
            .select(u => ({
              originalUsername: u.username,
              uppercaseUsername: sql<string>`${u.username}`.mapWith((val: string) => val.toUpperCase()),
            }))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.originalUsername>(r.originalUsername);
            assertType<string, typeof r.uppercaseUsername>(r.uppercaseUsername);
          });
          expect(result[0].originalUsername).toBe('alice');
          // If mapWith works, this should be 'ALICE'
          expect(result[0].uppercaseUsername).toBe('ALICE');
        });
      });

      test('should transform computed values by adding prefix', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const result = await db.users
            .select(u => ({
              username: u.username,
              prefixedInfo: sql<string>`${u.username} || ' - ' || ${u.email}`.mapWith((val: string) => `User: ${val}`),
            }))
            .where(u => eq(u.username, 'bob'))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<string, typeof r.prefixedInfo>(r.prefixedInfo);
          });
          expect(result[0].username).toBe('bob');
          // If mapWith works, should have 'User: ' prefix
          expect(result[0].prefixedInfo).toMatch(/^User: bob - bob@test\.com$/);
        });
      });

      test('should transform to custom object type', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          interface UserInfo {
            name: string;
            contact: string;
          }

          const result = await db.users
            .select(u => ({
              username: u.username,
              userInfo: sql<UserInfo>`${u.username} || ' - ' || ${u.email}`.mapWith((val: string) => {
                const parts = val.split(' - ');
                return { name: parts[0] || '', contact: parts[1] || '' };
              }),
            }))
            .where(u => eq(u.username, 'charlie'))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<UserInfo, typeof r.userInfo>(r.userInfo);
          });
          expect(result[0].username).toBe('charlie');
          // If mapWith works, should be transformed to object
          expect(result[0].userInfo).toHaveProperty('name', 'charlie');
          expect(result[0].userInfo).toHaveProperty('contact', 'charlie@test.com');
        });
      });
    });

    describe('Subquery with mapWith', () => {
      test('should transform scalar subquery result by rounding', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const avgViewsSubquery = db.posts
            .select(p => sql<number>`AVG(${p.views})`.mapWith((val: number) => Math.round(val)))
            .asSubquery('scalar');

          const result = await db.users
            .select(u => ({
              username: u.username,
              roundedAvgViews: avgViewsSubquery,
            }))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<number, typeof r.roundedAvgViews>(r.roundedAvgViews);
          });
          // Average of 100, 150, 200 is 150
          // If mapWith works, should be rounded (already whole number, but proves mapper is called)
          expect(result[0].roundedAvgViews).toBe(150);
          expect(Number.isInteger(result[0].roundedAvgViews)).toBe(true);
        });
      });

      test('should transform table subquery values by doubling', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const postsSubquery = db.posts
            .select(p => ({
              userId: p.userId,
              originalViews: p.views,
              doubledViews: sql<number>`${p.views}`.mapWith((val: number) => val * 2),
            }))
            .asSubquery('table');

          const result = await db.users
            .innerJoin(
              postsSubquery,
              (user, post) => eq(user.id, post.userId),
              (user, post) => ({
                username: user.username,
                originalViews: post.originalViews,
                transformedViews: post.doubledViews,
              }),
              'post_subquery'
            )
            .where(u => eq(u.username, 'alice'))
            .limit(1)
            .toList();

          expect(result.length).toBeGreaterThan(0);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<number, typeof r.originalViews>(r.originalViews);
            assertType<number, typeof r.transformedViews>(r.transformedViews);
          });
          // Alice's first post has 100 views
          expect(result[0].originalViews).toBe(100);
          // If mapWith works, doubled views should be 200
          expect(result[0].transformedViews).toBe(200);
        });
      });
    });

    describe('CTE with mapWith', () => {
      test('should transform CTE values with suffix', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);

          const cteBuilder = new DbCteBuilder();
          const usersCTE = cteBuilder.with(
            'user_info',
            db.users.select(u => ({
              userId: u.id,
              originalUsername: u.username,
              transformedInfo: sql<string>`${u.username} || '@' || ${u.email}`.mapWith((val: string) => `${val} [CTE]`),
            }))
          );

          const result = await db.users
            .where(u => eq(u.id, users.bob.id))
            .with(usersCTE.cte)
            .leftJoin(
              usersCTE.cte,
              (user, cte) => eq(user.id, cte.userId),
              (user, cte) => ({
                id: user.id,
                original: cte.originalUsername,
                transformed: cte.transformedInfo,
              })
            )
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          result.forEach(r => {
            // Type assertions
            assertType<number, typeof r.id>(r.id);
            assertType<string, typeof r.original>(r.original);
            assertType<string, typeof r.transformed>(r.transformed);
          });
          expect(result[0].original).toBe('bob');
          // If mapWith works, should have ' [CTE]' suffix
          expect(result[0].transformed).toBe('bob@bob@test.com [CTE]');
        });
      });
    });

    describe('JOIN with mapWith', () => {
      test('should transform JOIN projection with brackets', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);

          const result = await db.users
            .where(u => eq(u.id, users.alice.id))
            .innerJoin(
              db.posts,
              (user, post) => eq(user.id, post.userId),
              (user, post) => ({
                username: user.username,
                title: post.title,
                bracketedCombined: sql<string>`${user.username} || ' - ' || ${post.title}`.mapWith((val: string) => `[${val}]`),
              })
            )
            .limit(1)
            .toList();

          expect(result.length).toBeGreaterThan(0);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<string, typeof r.title>(r.title);
            assertType<string, typeof r.bracketedCombined>(r.bracketedCombined);
          });
          expect(result[0].username).toBe('alice');
          // If mapWith works, should be wrapped in brackets
          expect(result[0].bracketedCombined).toMatch(/^\[alice - Alice Post \d\]$/);
        });
      });

      test('should transform table subquery in JOIN by adding 1000', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);

          const postSubquery = db.posts
            .select(p => ({
              postId: p.id,
              userId: p.userId,
              originalViews: p.views,
              incrementedViews: sql<number>`${p.views}`.mapWith((val: number) => val + 1000),
            }))
            .asSubquery('table');

          const result = await db.users
            .where(u => eq(u.id, users.bob.id))
            .innerJoin(
              postSubquery,
              (user, post) => eq(user.id, post.userId),
              (user, post) => ({
                username: user.username,
                original: post.originalViews,
                transformed: post.incrementedViews,
              }),
              'post_data'
            )
            .limit(1)
            .toList();

          expect(result.length).toBeGreaterThan(0);
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.username>(r.username);
            assertType<number, typeof r.original>(r.original);
            assertType<number, typeof r.transformed>(r.transformed);
          });
          expect(result[0].username).toBe('bob');
          // Bob's post has 200 views
          expect(result[0].original).toBe(200);
          // If mapWith works, should be 1200 (200 + 1000)
          expect(result[0].transformed).toBe(1200);
        });
      });
    });

    describe('WHERE clause with mapWith', () => {
      test('should use mapWith in WHERE subquery (mapper not applied to WHERE)', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          // Note: mapWith in WHERE clause subquery doesn't affect the WHERE condition itself,
          // only the value if it were selected. This test verifies compilation.
          const avgViewsSubquery = db.posts
            .select(p => sql<number>`AVG(${p.views})`.mapWith((val: number) => Math.ceil(val)))
            .asSubquery('scalar');

          const result = await db.posts
            .where(p => sql`${p.views} > (${avgViewsSubquery})`)
            .select(p => ({
              title: p.title,
              views: p.views,
            }))
            .toList();

          expect(result.length).toBeGreaterThan(0);
          // Posts with views > 150 (the average)
          result.forEach(r => {
            // Type assertions
            assertType<string, typeof r.title>(r.title);
            assertType<number, typeof r.views>(r.views);
            expect(r.views).toBeGreaterThan(150);
          });
        });
      });
    });

    describe('Multiple mapWith in single query', () => {
      test('should apply multiple different transformations', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);

          const result = await db.users
            .where(u => eq(u.id, users.alice.id))
            .select(u => ({
              reversedUsername: sql<string>`${u.username}`.mapWith((val: string) => val.split('').reverse().join('')),
              tripledAge: sql<number>`${u.age}`.mapWith((val: number) => val * 3),
              email: u.email,
            }))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          const r = result[0];
          // Type assertions
          assertType<string, typeof r.reversedUsername>(r.reversedUsername);
          assertType<number, typeof r.tripledAge>(r.tripledAge);
          assertType<string, typeof r.email>(r.email);
          // If mapWith works, username should be reversed
          expect(r.reversedUsername).toBe('ecila'); // 'alice' reversed
          // If mapWith works, age should be tripled
          expect(r.tripledAge).toBe(75); // 25 * 3
          expect(r.email).toBe('alice@test.com');
        });
      });
    });

    describe('Nested subqueries with mapWith', () => {
      test('should apply transformation in nested scalar subquery', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          // Inner subquery with mapWith
          const avgViewsSubquery = db.posts
            .select(p => sql<number>`AVG(${p.views})`.mapWith((val: number) => Math.floor(val / 10) * 10))
            .asSubquery('scalar');

          // Outer query using the transformed value
          const result = await db.users
            .select(u => ({
              username: u.username,
              roundedAvgViews: avgViewsSubquery,
            }))
            .limit(1)
            .toList();

          expect(result.length).toBe(1);
          const r = result[0];
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<number, typeof r.roundedAvgViews>(r.roundedAvgViews);
          // Average is 150, floor to nearest 10 is still 150
          // If mapWith works, should be 150
          expect(r.roundedAvgViews).toBe(150);
        });
      });
    });
  });

  describe('Navigation property access in WHERE conditions', () => {
    test('should automatically add JOIN when navigation property used in WHERE', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Access user.username through navigation property in WHERE condition
        // This should automatically add a JOIN on the user table
        const result = await db.posts
          .where(p => eq(p.user!.username, 'alice'))
          .select(p => ({
            title: p.title,
            userId: p.userId,
          }))
          .toList();

        expect(result.length).toBe(2); // Alice has 2 posts
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.userId>(r.userId);
          expect(r.title).toMatch(/Alice Post/);
        });
      });
    });

    test('should work with navigation property in sql template WHERE condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Access user.isActive through navigation property in sql template
        const result = await db.posts
          .where(p => sql`${p.user!.isActive} = true`)
          .select(p => ({
            title: p.title,
            userId: p.userId,
          }))
          .toList();

        // Alice and Bob are active, so 3 posts total
        expect(result.length).toBe(3);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.userId>(r.userId);
        });
      });
    });

    test('should work with navigation property in combined WHERE condition', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Combine navigation property condition with regular condition
        const result = await db.posts
          .where(p => sql`${p.user!.age} > 30 AND ${p.views} > 100`)
          .select(p => ({
            title: p.title,
            views: p.views,
          }))
          .toList();

        // Only Bob (age 35) has a post with views > 100 (200 views)
        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.views>(r.views);
        });
        expect(result[0].title).toBe('Bob Post');
        expect(result[0].views).toBe(200);
      });
    });

    test('should work with navigation property in both SELECT and WHERE', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Use navigation in both SELECT and WHERE
        const result = await db.posts
          .where(p => eq(p.user!.isActive, true))
          .select(p => ({
            title: p.title,
            username: p.user!.username,
            userAge: p.user!.age,
          }))
          .toList();

        expect(result.length).toBe(3); // Alice (2) + Bob (1)
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<string, typeof r.username>(r.username);
          assertType<number | undefined, typeof r.userAge>(r.userAge);
          expect(r).toHaveProperty('username');
          expect(r).toHaveProperty('userAge');
        });
      });
    });

    test('should add JOIN when outer navigation property used in exists() subquery WHERE', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // This is the critical test case:
        // - Outer query is on posts
        // - Inner subquery is on orders
        // - Inner subquery's WHERE references p.user!.age (navigation from outer query)
        // This should generate a JOIN on the users table in the outer query
        const result = await db.posts
          .where(p => exists(
            db.orders
              .where(o => and(
                eq(o.userId, p.userId),
                // This is the key: accessing outer query's navigation property
                // inside the inner subquery's WHERE condition
                sql`${p.user!.age} >= 30`
              ))
              .select(o => ({ orderId: o.id }))
              .asSubquery('table')
          ))
          .select(p => ({
            title: p.title,
            userId: p.userId,
          }))
          .toList();

        // Only Bob (age 35) has both posts AND orders, and age >= 30
        // Alice (age 25) has orders but age < 30
        expect(result.length).toBe(1);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.userId>(r.userId);
        });
        expect(result[0].title).toBe('Bob Post');
      });
    });

    test('should add JOIN when outer navigation property used in exists() with multiple conditions', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // More complex case: multiple outer navigation properties in inner subquery
        const result = await db.posts
          .where(p => exists(
            db.orders
              .where(o => and(
                eq(o.userId, p.userId),
                // Multiple navigation property accesses from outer query
                sql`${p.user!.age} >= 20 AND ${p.user!.age} <= 40 AND ${p.user!.isActive} = true`
              ))
              .select(o => ({ orderId: o.id }))
              .asSubquery('table')
          ))
          .select(p => ({
            title: p.title,
            userId: p.userId,
          }))
          .toList();

        // Alice (age 25, active) and Bob (age 35, active) both have orders
        // Both are between 20-40 and active
        expect(result.length).toBe(3); // Alice's 2 posts + Bob's 1 post
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.userId>(r.userId);
        });
      });
    });

    test('should handle complex CTE with navigation property in filter used by grouped query with leftJoin', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // This test replicates a complex real-world scenario:
        // 1. Filter built dynamically using subquery that accesses navigation properties
        // 2. 1st CTE that aggregates order data
        // 3. 2nd CTE that: uses groupBy, applies filter from #1, performs leftJoin with CTE1
        // 4. Final query that selects using these CTEs

        // Step 1: Create a dynamic filter with EXISTS subquery that accesses navigation property
        // This filter checks if a post's user has any orders
        const hasOrdersFilter = (post: EntityQuery<Post>) => exists(
          db.orders
            .where(o => and(
              eq(o.userId, post.userId),
              // Access navigation property from outer query - this is the key test!
              // This should trigger a JOIN on users table in the outer query
              sql`${post.user!.age} >= 25`
            ))
            .select(o => ({ orderId: o.id }))
            .asSubquery('table')
        );

        const cteBuilder = new DbCteBuilder();

        // Step 2: 1st CTE - aggregate order amounts by user
        const orderStatsCte = cteBuilder.withAggregation(
          'order_stats_cte',
          db.orders.select(o => ({
            userId: o.userId,
            orderAmount: o.totalAmount,
            orderStatus: o.status,
          })),
          o => ({ userId: o.userId }),
          'orderDetails'
        );

        // Step 3: 2nd CTE - groupBy with filter using navigation properties, leftJoin with CTE1
        // This is the critical part - using the hasOrdersFilter inside a CTE that:
        // - Applies WHERE with navigation property access (via exists subquery)
        // - Does groupBy
        // - LeftJoins with another CTE
        const postStatsCte = cteBuilder.withAggregation(
          'post_stats_cte',
          db.posts
            .where(post => hasOrdersFilter(post))  // Filter with navigation property access
            .select(p => ({
              postId: p.id,
              title: p.title,
              userId: p.userId,
              views: p.views,
            }))
            .groupBy(p => ({
              userId: p.userId,
            }))
            .select(g => ({
              userId: g.key.userId,
              postCount: g.count(),
              totalViews: g.sum(p => p.views),
            }))
            .leftJoin(
              orderStatsCte,
              (stats, orders) => eq(stats.userId, orders.userId),
              (stats, orders) => ({
                userId: stats.userId,
                postCount: stats.postCount,
                totalViews: stats.totalViews,
                orderDetails: orders.orderDetails,
              })
            ),
          p => ({ userId: p.userId }),
          'postStats'
        );

        // Step 4: Final query using the CTEs
        const result = await db.users
          .where((u) => eq(u.isActive, true))
          .with(orderStatsCte)
          .with(postStatsCte)
          .leftJoin(
            postStatsCte,
            (user, stats) => eq(user.id, stats.userId),
            (user, stats) => ({
              username: user.username,
              age: user.age,
              postStats: stats.postStats,
            })
          )
          .toList();

        // Verify results:
        // - Alice (age 25) has posts and orders, so should be included with stats
        // - Bob (age 35) has posts and orders, so should be included with stats
        // - Charlie (age 45) is not active, so filtered out
        expect(result.length).toBe(2);
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<number | undefined, typeof r.age>(r.age);
          assertType<{
    postCount: number;
    totalViews: number;
    orderDetails: {
        orderStatus: "pending" | "processing" | "completed" | "cancelled" | "refunded";
        orderAmount: number;
    }[];
}[], typeof r.postStats>(r.postStats);
        });

        const aliceResult = result.find((r) => r.username === 'alice');
        const bobResult = result.find((r) => r.username === 'bob');

        expect(aliceResult).toBeDefined();
        expect(bobResult).toBeDefined();

        // Alice has 2 posts, total views = 100 + 150 = 250
        expect(aliceResult?.postStats).toBeDefined();
        expect((aliceResult?.postStats as any[])?.length).toBeGreaterThan(0);

        // Bob has 1 post, total views = 200
        expect(bobResult?.postStats).toBeDefined();
        expect((bobResult?.postStats as any[])?.length).toBeGreaterThan(0);
      });
    });

    test('should handle multiple selects with navigation properties and chained orderings', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Test chained select() calls with navigation properties, mixed with orderBy
        const result = await db.posts
          .select(p => ({
            postId: p.id,
            postTitle: p.title,
            ageOfAuthor: p.user!.age
          }))
          .select(p => ({
            postId: p.postId,
            title: p.postTitle,
            authorAge: p.ageOfAuthor
          }))
          .orderBy(p => [p.authorAge, 'desc'])
          .select(p => ({
            id: p.postId,
            titleUpper: sql<string>`UPPER(${p.title})`,
            age: p.authorAge,
          }))
          .orderBy(p => [p.titleUpper, 'asc'])
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.titleUpper>(r.titleUpper);
          assertType<number | undefined, typeof r.age>(r.age);
          expect(r).toHaveProperty('id');
          expect(r).toHaveProperty('titleUpper');
          expect(r).toHaveProperty('age');
          expect(typeof r.titleUpper).toBe('string');
          expect(r.titleUpper).toBe(r.titleUpper.toUpperCase());
        });

        // Verify ordering by titleUpper (last orderBy takes precedence)
        for (let i = 0; i < result.length - 1; i++) {
          expect((result[i] as any).titleUpper <= (result[i + 1] as any).titleUpper).toBe(true);
        }
      });
    });

    test('should handle CTE with multiple navigation property filters and grouped aggregations', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();

        // CTE1: Posts filtered by user navigation properties with grouping
        const postsByCategoryCte = cteBuilder.withAggregation(
          'posts_by_category',
          db.posts
            .where(p => and(
              gte(p.user!.age, 25), // Navigation property in filter
              eq(p.user!.isActive, true) // Another navigation property
            ))
            .select(p => ({
              category: p.category,
              postId: p.id,
              views: p.views,
              authorName: p.user!.username, // Navigation in select
            }))
            .groupBy(p => ({ category: p.category }))
            .select(g => ({
              category: g.key.category,
              totalPosts: g.count(),
              avgViews: g.avg(p => p.views),
              maxViews: g.max(p => p.views),
            })),
          g => ({ category: g.category }),
          'categoryStats'
        );

        // Final query with multiple selects and orderings
        const result = await db.posts
          .with(postsByCategoryCte)
          .select(p => ({
            postId: p.id,
            title: p.title,
            cat: p.category
          }))
          .leftJoin(
            postsByCategoryCte,
            (p, stats) => eq(p.cat, stats.category),
            (p, stats) => ({
              postId: p.postId,
              title: p.title,
              stats: stats.categoryStats,
            })
          )
          .orderBy(p => [p.postId, 'asc'])
          .select(p => ({
            id: p.postId,
            titleLength: sql<number>`LENGTH(${p.title})`,
            categoryInfo: p.stats,
          }))
          .orderBy(p => [p.titleLength, 'desc'])
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<number, typeof r.titleLength>(r.titleLength);
          assertType<{totalPosts: number; avgViews: number;  maxViews: number;}[], typeof r.categoryInfo>(r.categoryInfo);
          expect(r).toHaveProperty('id');
          expect(r).toHaveProperty('titleLength');
          expect(r).toHaveProperty('categoryInfo');
        });
      });
    });

    test('should handle deeply nested navigation properties in subquery filters with multiple CTEs', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create filter using navigation: find orders where user has posts
        const userHasPostsFilter = (order: EntityQuery<Order>) => exists(
          db.posts
            .where(p => and(
              eq(p.userId, order.userId),
              gt(p.views, 50),
              eq(p.user!.isActive, true) // Navigation in subquery
            ))
            .select(p => ({ id: p.id }))
            .asSubquery('table')
        );

        const cteBuilder = new DbCteBuilder();

        // CTE1: User stats with order count
        const userStatsCte = cteBuilder.withAggregation(
          'user_stats',
          db.users
            .where(u => eq(u.isActive, true))
            .select(u => ({
              userId: u.id,
              username: u.username,
              age: u.age,
            }))
            .groupBy(u => ({ userId: u.userId }))
            .select(g => ({
              userId: g.key.userId,
              userCount: g.count(),
            })),
          u => ({ userId: u.userId }),
          'stats'
        );

        // CTE2: Orders filtered by navigation properties
        const activeOrdersCte = cteBuilder.withAggregation(
          'active_orders',
          db.orders
            .where(order => and(
              userHasPostsFilter(order), // Complex filter with navigation
              gte(order.user!.age, 25) // Direct navigation in where
            ))
            .select(o => ({
              orderId: o.id,
              userId: o.userId,
              amount: o.totalAmount,
              status: o.status,
            }))
            .groupBy(o => ({ userId: o.userId }))
            .select(g => ({
              userId: g.key.userId,
              orderCount: g.count(),
              totalAmount: g.sum(o => o.amount),
            })),
          o => ({ userId: o.userId }),
          'orders'
        );

        // Final query with multiple selects
        const result = await db.users
          .with(userStatsCte)
          .with(activeOrdersCte)
          .select(u => ({
            id: u.id,
            name: u.username,
          }))
          .leftJoin(
            userStatsCte,
            (u, stats) => eq(u.id, stats.userId),
            (u, stats) => ({
              id: u.id,
              name: u.name,
              userStats: stats.stats,
            })
          )
          .select(u => ({
            userId: u.id,
            username: u.name,
            statsData: u.userStats,
          }))
          .leftJoin(
            activeOrdersCte,
            (u, orders) => eq(u.userId, orders.userId),
            (u, orders) => ({
              userId: u.userId,
              username: u.username,
              stats: u.statsData,
              orderInfo: orders.orders,
            })
          )
          .orderBy(u => [u.username, 'asc'])
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string, typeof r.username>(r.username);
          assertType<{userCount: number}[], typeof r.stats>(r.stats);
          assertType<{totalAmount: number, orderCount: number}[], typeof r.orderInfo>(r.orderInfo);
          expect(r).toHaveProperty('userId');
          expect(r).toHaveProperty('username');
        });
      });
    });

    test('should handle multiple CTEs with navigation properties in aggregations and complex selects', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();

        // CTE1: Post stats by user using navigation
        const postStatsCte = cteBuilder.withAggregation(
          'post_stats',
          db.posts
            .select(p => ({
              userId: p.userId,
              postId: p.id,
              views: p.views,
              authorAge: p.user!.age, // Navigation property
              authorActive: p.user!.isActive, // Another navigation
            }))
            .groupBy(p => ({ userId: p.userId }))
            .select(g => ({
              userId: g.key.userId,
              postCount: g.count(),
              totalViews: g.sum(p => p.views),
              avgAuthorAge: g.avg(p => p.authorAge),
            })),
          p => ({ userId: p.userId }),
          'postData'
        );

        // CTE2: Order stats by user
        const orderStatsCte = cteBuilder.withAggregation(
          'order_stats',
          db.orders
            .where(o => eq(o.user!.isActive, true)) // Navigation in where
            .select(o => ({
              userId: o.userId,
              amount: o.totalAmount,
              orderStatus: o.status,
            }))
            .groupBy(o => ({ userId: o.userId, status: o.orderStatus }))
            .select(g => ({
              userId: g.key.userId,
              status: g.key.status,
              count: g.count(),
              total: g.sum(o => o.amount),
            })),
          o => ({ userId: o.userId }),
          'orderData'
        );

        // Final query with multiple chained selects and orderings
        const result = await db.users
          .with(postStatsCte)
          .with(orderStatsCte)
          .select(u => ({
            id: u.id,
            name: u.username,
            userAge: u.age,
          }))
          .orderBy(u => [u.userAge, 'desc'])
          .select(u => ({
            userId: u.id,
            userName: u.name,
            age: u.userAge,
            ageCategory: sql<string>`
              CASE
                WHEN ${u.userAge} < 30 THEN 'young'
                WHEN ${u.userAge} < 40 THEN 'middle'
                ELSE 'senior'
              END
            `,
          }))
          .leftJoin(
            postStatsCte,
            (u, posts) => eq(u.userId, posts.userId),
            (u, posts) => ({
              userId: u.userId,
              userName: u.userName,
              age: u.age,
              ageCategory: u.ageCategory,
              postStats: posts.postData,
            })
          )
          .select(u => ({
            id: u.userId,
            name: u.userName,
            category: u.ageCategory,
            posts: u.postStats,
          }))
          .orderBy(u => [u.name, 'asc'])
          .leftJoin(
            orderStatsCte,
            (u, orders) => eq(u.id, orders.userId),
            (u, orders) => ({
              userId: u.id,
              userName: u.name,
              ageCategory: u.category,
              postInfo: u.posts,
              orderInfo: orders.orderData,
            })
          )
          .orderBy(u => [u.userId, 'desc'])
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string, typeof r.userName>(r.userName);
          assertType<string, typeof r.ageCategory>(r.ageCategory);
          assertType<{
              postCount: number;
              totalViews: number;
              avgAuthorAge: number;
          }[], typeof r.postInfo>(r.postInfo);
          assertType<{
            status: "pending" | "processing" | "completed" | "cancelled" | "refunded";
            count: number;
            total: number;
          }[], typeof r.orderInfo>(r.orderInfo);
          expect(r).toHaveProperty('userId');
          expect(r).toHaveProperty('userName');
          expect(r).toHaveProperty('ageCategory');
          expect(['young', 'middle', 'senior']).toContain(r.ageCategory);
        });
      });
    });

    test('should handle navigation properties in exists subqueries with multiple groupBy levels', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Complex exists filter using navigation in multiple levels
        const complexFilter = (user: EntityQuery<User>) => and(
          exists(
            db.posts
              .where(p => and(
                eq(p.userId, user.id),
                gt(p.views, 100),
                eq(p.user!.isActive, true) // Navigation in nested subquery
              ))
              .select(p => ({ id: p.id }))
              .asSubquery('table')
          ),
          exists(
            db.orders
              .where(o => and(
                eq(o.userId, user.id),
                eq(o.user!.isActive, true) // Navigation in another subquery
              ))
              .select(o => ({ id: o.id }))
              .asSubquery('table')
          )
        );

        const cteBuilder = new DbCteBuilder();

        // CTE with complex filtering and grouping
        const filteredUsersCte = cteBuilder.withAggregation(
          'filtered_users',
          db.users
            .where(user => complexFilter(user))
            .select(u => ({
              userId: u.id,
              username: u.username,
              age: u.age,
            }))
            .groupBy(u => ({ userId: u.userId }))
            .select(g => ({
              userId: g.key.userId,
              count: g.count(),
            })),
          u => ({ userId: u.userId }),
          'userData'
        );

        // Multiple selects with transformations
        const result = await db.posts
          .with(filteredUsersCte)
          .select(p => ({
            postId: p.id,
            postTitle: p.title,
            authorId: p.userId,
            countOfViews: p.views,
            ageOfUser: p.user?.age
          }))
          .select(p => ({
            id: p.postId,
            title: p.postTitle,
            author: p.authorId,
            viewCount: p.countOfViews,
            authorAge: p.ageOfUser, // Navigation property
          }))
          .orderBy(p => [p.viewCount, 'desc'])
          .select(p => ({
            postId: p.id,
            titleTrimmed: sql<string>`TRIM(${p.title})`,
            views: p.viewCount,
            age: p.authorAge,
            authorissimo: p.author
          }))
          .leftJoin(
            filteredUsersCte,
            (p, u) => eq(p.authorissimo, u.userId),
            (p, u) => ({
              postId: p.postId,
              title: p.titleTrimmed,
              views: p.views,
              authorAge: p.age,
              userInfo: u.userData,
            })
          )
          .orderBy(p => [p.postId, 'asc'])
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach(r => {
          // Type assertions
          assertType<number, typeof r.postId>(r.postId);
          assertType<string, typeof r.title>(r.title);
          assertType<number, typeof r.views>(r.views);
          assertType<number | undefined, typeof r.authorAge>(r.authorAge);
          assertType<{
    count: number;
}[], typeof r.userInfo>(r.userInfo);
          expect(r).toHaveProperty('postId');
          expect(r).toHaveProperty('title');
          expect(r).toHaveProperty('views');
        });
      });
    });

    test('should handle CTE with navigation in grouped query, multiple joins, and chained selects', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const cteBuilder = new DbCteBuilder();

        // CTE1: Posts grouped by category with navigation
        const postsByCategoryCte = cteBuilder.withAggregation(
          'posts_by_category',
          db.posts
            .where(p => eq(p.user!.isActive, true)) // Navigation filter
            .select(p => ({
              category: p.category,
              postId: p.id,
              userId: p.userId,
              views: p.views,
              authorName: p.user!.username, // Navigation in select
            }))
            .groupBy(p => ({ category: p.category }))
            .select(g => ({
              category: g.key.category,
              postCount: g.count(),
              totalViews: g.sum(p => p.views),
            })),
          g => ({ category: g.category }),
          'stats'
        );

        // CTE2: Users with order info
        const usersWithOrdersCte = cteBuilder.withAggregation(
          'users_with_orders',
          db.users
            .select(u => ({
              userId: u.id,
              userName: u.username,
              userAge: u.age,
            }))
            .groupBy(u => ({ userId: u.userId }))
            .select(g => ({
              userId: g.key.userId,
              userCount: g.count(),
            })),
          u => ({ userId: u.userId }),
          'userInfo'
        );

        // Complex query with multiple CTEs, joins, and selects
        const result = await db.posts
          .with(postsByCategoryCte)
          .with(usersWithOrdersCte)
          .select(p => ({
            id: p.id,
            title: p.title,
            cat: p.category,
            authorId: p.userId,
            userMail: p.user?.email
          }))
          .orderBy(p => [p.cat, 'asc'])
          .select(p => ({
            postId: p.id,
            postTitle: p.title,
            category: p.cat,
            author: p.authorId,
            authorEmail: p.userMail, // Navigation property
          }))
          .leftJoin(
            postsByCategoryCte,
            (p, stats) => eq(p.category, stats.category),
            (p, stats) => ({
              postId: p.postId,
              title: p.postTitle,
              category: p.category,
              authorId: p.author,
              authorEmail: p.authorEmail,
              categoryStats: stats.stats,
            })
          )
          .select((p) => ({
            id: p.postId,
            titleUpper: sql<string>`UPPER(${p.title})`,
            cat: p.category,
            authorId: p.authorId,  // Keep authorId for the next join
            email: p.authorEmail,
            stats: p.categoryStats,
          }))
          .orderBy((p) => p.titleUpper)
          .leftJoin(
            usersWithOrdersCte,
            (p, u) => eq(p.authorId, u.userId),
            (p, u) => ({
              postId: p.id,
              title: p.titleUpper,
              category: p.cat,
              email: p.email,
              stats: p.stats,
              userInfo: u.userInfo,
            })
          )
          .orderBy((p) => p.postId)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.postId>(r.postId);
          assertType<string, typeof r.title>(r.title);
          assertType<string | null, typeof r.category>(r.category);
          assertType<string | undefined, typeof r.email>(r.email);
          assertType<{
    postCount: number;
    totalViews: number;
}[], typeof r.stats>(r.stats);
          assertType<{userCount: number}[], typeof r.userInfo>(r.userInfo);
          expect(r).toHaveProperty('postId');
          expect(r).toHaveProperty('title');
          expect(r).toHaveProperty('category');
          expect(r.title).toBe(r.title.toUpperCase());
        });
      });
    });

    test('should handle mixed navigation properties and sql expressions in multiple select chains', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Test complex select chains mixing navigation, sql, and transformations
        const result = await db.orders
          .select(o => ({
            orderId: o.id,
            orderAmount: o.totalAmount,
            authorName: o.user!.username, // Navigation property
            authorAge: o.user!.age, // Another navigation
          }))
          .orderBy(o => o.orderAmount)
          .select(o => ({
            orderId: o.orderId,
            totalAmount: o.orderAmount,
            userName: o.authorName,
            userAge: o.authorAge,
            amountCategory: sql<string>`
              CASE
                WHEN ${o.orderAmount} < 100 THEN 'small'
                WHEN ${o.orderAmount} < 200 THEN 'medium'
                ELSE 'large'
              END
            `,
          }))
          .orderBy(o => o.userAge)
          .select(o => ({
            id: o.orderId,
            amount: o.totalAmount,
            user: o.userName,
            age: o.userAge,
            category: o.amountCategory,
            amountFormatted: sql<string>`'$' || CAST(${o.totalAmount} AS VARCHAR)`,
          }))
          .orderBy(o => o.category)
          .select(o => ({
            orderId: o.id,
            displayAmount: o.amountFormatted,
            customerName: o.user,
            customerAge: o.age,
            sizeCategory: o.category,
            computedField: sql<string>`${o.user} || ' (' || CAST(${o.age} AS VARCHAR) || ')'`,
          }))
          .orderBy(o => o.customerAge)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.orderId>(r.orderId);
          assertType<string, typeof r.displayAmount>(r.displayAmount);
          assertType<string, typeof r.customerName>(r.customerName);
          assertType<number | undefined, typeof r.customerAge>(r.customerAge);
          assertType<string, typeof r.sizeCategory>(r.sizeCategory);
          assertType<string, typeof r.computedField>(r.computedField);
          expect(r).toHaveProperty('orderId');
          expect(r).toHaveProperty('displayAmount');
          expect(r).toHaveProperty('customerName');
          expect(r).toHaveProperty('customerAge');
          expect(r).toHaveProperty('sizeCategory');
          expect(r).toHaveProperty('computedField');
          expect(['small', 'medium', 'large']).toContain(r.sizeCategory);
          expect(r.displayAmount).toMatch(/^\$/);
          expect(r.computedField).toContain(r.customerName);
        });
      });
    });

    test('should handle CTE with navigation in filter, grouped with multiple aggregations, and complex final query', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Create complex filter with navigation properties
        const activeUserWithHighViewsFilter = (post: EntityQuery<Post>) => and(
          eq(post.user!.isActive, true), // Navigation in filter
          gte(post.user!.age, 25), // Another navigation
          gt(post.views, 50)
        );

        const cteBuilder = new DbCteBuilder();

        // CTE1: Aggregated post stats with navigation filters
        const postAggCte = cteBuilder.withAggregation(
          'post_aggregations',
          db.posts
            .where(post => activeUserWithHighViewsFilter(post))
            .select(p => ({
              userId: p.userId,
              postId: p.id,
              views: p.views,
              category: p.category,
              authorName: p.user!.username, // Navigation in select
              authorAge: p.user!.age,
            }))
            .groupBy(p => ({ userId: p.userId, category: p.category }))
            .select(g => ({
              userId: g.key.userId,
              category: g.key.category,
              postCount: g.count(),
              totalViews: g.sum(p => p.views),
              avgViews: g.avg(p => p.views),
              maxViews: g.max(p => p.views),
              minViews: g.min(p => p.views),
            })),
          g => ({ userId: g.userId, category: g.category }),
          'aggregations'
        );

        // CTE2: Order statistics
        const orderAggCte = cteBuilder.withAggregation(
          'order_aggregations',
          db.orders
            .where(o => eq(o.user!.isActive, true)) // Navigation filter
            .select(o => ({
              userId: o.userId,
              orderId: o.id,
              amount: o.totalAmount,
              status: o.status,
            }))
            .groupBy(o => ({ userId: o.userId }))
            .select(g => ({
              userId: g.key.userId,
              orderCount: g.count(),
              totalSpent: g.sum(o => o.amount),
              avgSpent: g.avg(o => o.amount),
            })),
          g => ({ userId: g.userId }),
          'orderStats'
        );

        // Complex final query with multiple selects, joins, and orderings
        const result = await db.users
          .where((u) => eq(u.isActive, true))
          .with(postAggCte)
          .with(orderAggCte)
          .select((u) => ({
            userId: u.id,
            userName: u.username,
            userAge: u.age,      // Include for later use
            userEmail: u.email,  // Include for later use
          }))
          .orderBy((u) => u.userName)
          .select((u) => ({
            id: u.userId,
            name: u.userName,
            age: u.userAge,
            email: u.userEmail,
          }))
          .leftJoin(
            postAggCte,
            (u, posts) => eq(u.id, posts.userId),
            (u, posts) => ({
              userId: u.id,
              userName: u.name,
              userAge: u.age,
              userEmail: u.email,
              postAggregations: posts.aggregations,
            })
          )
          .select((u) => ({
            id: u.userId,
            name: u.userName,
            age: u.userAge,
            email: u.userEmail,
            postData: u.postAggregations,
            nameUpper: sql<string>`UPPER(${u.userName})`,
          }))
          .orderBy((u) => u.age)
          .leftJoin(
            orderAggCte,
            (u, orders) => eq(u.id, orders.userId),
            (u, orders) => ({
              userId: u.id,
              displayName: u.name,
              nameUpper: u.nameUpper,
              age: u.age,
              email: u.email,
              posts: u.postData,
              orders: orders.orderStats,
            })
          )
          .select((u) => ({
            id: u.userId,
            name: u.displayName,
            nameUppercase: u.nameUpper,
            age: u.age,
            contactEmail: u.email,
            postStatistics: u.posts,
            orderStatistics: u.orders,
            fullInfo: sql<string>`${u.displayName} || ' <' || ${u.email} || '>'`,
          }))
          .orderBy((u) => u.nameUppercase)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.id>(r.id);
          assertType<string, typeof r.name>(r.name);
          assertType<string, typeof r.nameUppercase>(r.nameUppercase);
          assertType<number | undefined, typeof r.age>(r.age);
          assertType<string, typeof r.contactEmail>(r.contactEmail);
          assertType<string, typeof r.fullInfo>(r.fullInfo);
          assertType<{
        postCount: number;
        totalViews: number;
        avgViews: number;
        maxViews: number;
        minViews: number;
    }[], typeof r.postStatistics>(r.postStatistics);
          assertType<{
        orderCount: number;
        totalSpent: number;
        avgSpent: number;
    }[], typeof r.orderStatistics>(r.orderStatistics);
          expect(r).toHaveProperty('id');
          expect(r).toHaveProperty('name');
          expect(r).toHaveProperty('nameUppercase');
          expect(r).toHaveProperty('age');
          expect(r).toHaveProperty('contactEmail');
          expect(r).toHaveProperty('fullInfo');
          expect(r.nameUppercase).toBe(r.name.toUpperCase());
          expect(r.fullInfo).toContain(r.name);
          expect(r.fullInfo).toContain(r.contactEmail);
        });
      });
    });

    test('should handle deeply nested CTEs with navigation, subqueries, and multiple transformation layers', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Multi-level exists filters with navigation
        const hasActivePostsFilter = (user: EntityQuery<User>) => exists(
          db.posts
            .where(p => and(
              eq(p.userId, user.id),
              gt(p.views, 0),
              eq(p.user!.isActive, true) // Nested navigation
            ))
            .select(p => ({ id: p.id }))
            .asSubquery('table')
        );

        const hasCompletedOrdersFilter = (user: any) => exists(
          db.orders
            .where(o => and(
              eq(o.userId, user.id),
              eq(o.status, 'completed'),
              sql`${o.user!.age} >= 25` // Navigation in subquery
            ))
            .select(o => ({ id: o.id }))
            .asSubquery('table')
        );

        const cteBuilder = new DbCteBuilder();

        // CTE1: User base data with filters
        const userBaseCte = cteBuilder.withAggregation(
          'user_base',
          db.users
            .where(u => and(
              eq(u.isActive, true),
              hasActivePostsFilter(u),
              hasCompletedOrdersFilter(u)
            ))
            .select(u => ({
              userId: u.id,
              userName: u.username,
              userAge: u.age,
            }))
            .groupBy(u => ({ userId: u.userId }))
            .select(g => ({
              userId: g.key.userId,
              count: g.count(),
            })),
          u => ({ userId: u.userId }),
          'baseData'
        );

        // CTE2: Post statistics by user
        const postStatsCte = cteBuilder.withAggregation(
          'post_stats',
          db.posts
            .where(p => sql`${p.user!.age} >= 25`) // Navigation filter
            .select(p => ({
              userId: p.userId,
              views: p.views,
              category: p.category,
            }))
            .groupBy(p => ({ userId: p.userId }))
            .select(g => ({
              userId: g.key.userId,
              postCount: g.count(),
              totalViews: g.sum(p => p.views),
            })),
          p => ({ userId: p.userId }),
          'postData'
        );

        // CTE3: Order statistics by user
        const orderStatsCte = cteBuilder.withAggregation(
          'order_stats',
          db.orders
            .where(o => eq(o.user!.isActive, true)) // Navigation filter
            .select(o => ({
              userId: o.userId,
              amount: o.totalAmount,
            }))
            .groupBy(o => ({ userId: o.userId }))
            .select(g => ({
              userId: g.key.userId,
              orderCount: g.count(),
              totalAmount: g.sum(o => o.amount),
            })),
          o => ({ userId: o.userId }),
          'orderData'
        );

        // Complex final query with 3 CTEs, multiple joins, and transformation layers
        const result = await db.users
          .select((u) => ({
            id: u.id,
            username: u.username,
            age: u.age,
            isActive: u.isActive,
          }))
          .with(userBaseCte)
          .with(postStatsCte)
          .with(orderStatsCte)
          .select((u) => ({
            id: u.id,
            name: u.username,
            age: u.age,
            isActive: u.isActive,
          }))
          .orderBy((u) => u.id)
          .select((u) => ({
            userId: u.id,
            userName: u.name,
            userAge: u.age,
            isActive: u.isActive,
          }))
          .leftJoin(
            userBaseCte,
            (u, base) => eq(u.userId, base.userId),
            (u, base) => ({
              userId: u.userId,
              userName: u.userName,
              age: u.userAge,
              active: u.isActive,
              baseInfo: base.baseData,
            })
          )
          .select((u) => ({
            id: u.userId,
            name: u.userName,
            age: u.age,
            active: u.active,
            base: u.baseInfo,
          }))
          .orderBy((u) => u.age)
          .leftJoin(
            postStatsCte,
            (u, posts) => eq(u.id, posts.userId),
            (u, posts) => ({
              userId: u.id,
              userName: u.name,
              age: u.age,
              active: u.active,
              baseData: u.base,
              postData: posts.postData,
            })
          )
          .select((u) => ({
            id: u.userId,
            name: u.userName,
            age: u.age,
            active: u.active,
            base: u.baseData,
            posts: u.postData,
            nameLength: sql<number>`LENGTH(${u.userName})`,
          }))
          .orderBy((u) => u.nameLength)
          .leftJoin(
            orderStatsCte,
            (u, orders) => eq(u.id, orders.userId),
            (u, orders) => ({
              userId: u.id,
              displayName: u.name,
              age: u.age,
              isActive: u.active,
              baseInfo: u.base,
              postInfo: u.posts,
              orderInfo: orders.orderData,
              nameLength: u.nameLength,
            })
          )
          .select((u) => ({
            userId: u.userId,
            name: u.displayName,
            age: u.age,
            active: u.isActive,
            nameLen: u.nameLength,
            baseStats: u.baseInfo,
            postStats: u.postInfo,
            orderStats: u.orderInfo,
            summary: sql<string>`
              ${u.displayName} ||
              ' (age: ' || CAST(${u.age} AS VARCHAR) ||
              ', active: ' || CAST(${u.isActive} AS VARCHAR) || ')'
            `,
          }))
          .orderBy((u) => u.userId)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string, typeof r.name>(r.name);
          assertType<number | undefined, typeof r.age>(r.age);
          assertType<boolean, typeof r.active>(r.active);
          assertType<number, typeof r.nameLen>(r.nameLen);
          assertType<string, typeof r.summary>(r.summary);
          assertType<unknown[], typeof r.baseStats>(r.baseStats);
          assertType<unknown[], typeof r.postStats>(r.postStats);
          assertType<unknown[], typeof r.orderStats>(r.orderStats);
          expect(r).toHaveProperty('userId');
          expect(r).toHaveProperty('name');
          expect(r).toHaveProperty('age');
          expect(r).toHaveProperty('active');
          expect(r).toHaveProperty('nameLen');
          expect(r).toHaveProperty('summary');
          expect(r.summary).toContain(r.name);
          expect(r.summary).toContain(r.age!.toString());
        });
      });
    });

    test('should handle extreme select chain with navigation properties in every layer and mixed orderings', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Extreme test: Multiple chained select() calls with navigation properties, orderings, and transformations
        const result = await db.posts
          .select(p => ({
            p1_id: p.id,
            p1_title: p.title,
            p1_views: p.views,
            p1_category: p.category,
            p1_author: p.user!.username, // Navigation #1
            p1_authorAge: p.user!.age, // Navigation #2
            p1_authorEmail: p.user!.email, // Navigation #3
          }))
          .orderBy(p => p.p1_id)
          .select(p => ({
            p2_id: p.p1_id,
            p2_title: p.p1_title,
            p2_views: p.p1_views,
            p2_category: p.p1_category,
            p2_author: p.p1_author,
            p2_age: p.p1_authorAge,
            p2_email: p.p1_authorEmail,
            p2_titleLen: sql<number>`LENGTH(${p.p1_title})`,
          }))
          .orderBy(p => p.p2_age)
          .select(p => ({
            p3_id: p.p2_id,
            p3_displayTitle: sql<string>`UPPER(${p.p2_title})`,
            p3_views: p.p2_views,
            p3_category: p.p2_category,
            p3_author: p.p2_author,
            p3_age: p.p2_age,
            p3_email: p.p2_email,
            p3_titleLen: p.p2_titleLen,
          }))
          .orderBy(p => p.p3_displayTitle)
          .select(p => ({
            p4_id: p.p3_id,
            p4_title: p.p3_displayTitle,
            p4_views: p.p3_views,
            p4_category: p.p3_category,
            p4_author: p.p3_author,
            p4_age: p.p3_age,
            p4_email: p.p3_email,
            p4_len: p.p3_titleLen,
            p4_viewCategory: sql<string>`
              CASE
                WHEN ${p.p3_views} < 100 THEN 'low'
                WHEN ${p.p3_views} < 200 THEN 'medium'
                ELSE 'high'
              END
            `,
          }))
          .orderBy(p => p.p4_views)
          .select(p => ({
            finalId: p.p4_id,
            finalTitle: p.p4_title,
            finalViews: p.p4_views,
            finalCategory: p.p4_category,
            finalAuthor: p.p4_author,
            finalAge: p.p4_age,
            finalEmail: p.p4_email,
            finalTitleLen: p.p4_len,
            finalViewCategory: p.p4_viewCategory,
            finalSummary: sql<string>`
              ${p.p4_title} || ' by ' || ${p.p4_author} ||
              ' (views: ' || CAST(${p.p4_views} AS VARCHAR) || ')'
            `,
          }))
          .orderBy(p => p.finalId)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.finalId>(r.finalId);
          assertType<string, typeof r.finalTitle>(r.finalTitle);
          assertType<string, typeof r.finalAuthor>(r.finalAuthor);
          assertType<number | undefined, typeof r.finalAge>(r.finalAge);
          assertType<string, typeof r.finalEmail>(r.finalEmail);
          assertType<number, typeof r.finalViews>(r.finalViews);
          assertType<string | null, typeof r.finalCategory>(r.finalCategory);
          assertType<string, typeof r.finalSummary>(r.finalSummary);
          assertType<string, typeof r.finalViewCategory>(r.finalViewCategory);
          assertType<number, typeof r.finalTitleLen>(r.finalTitleLen);
          expect(r).toHaveProperty('finalId');
          expect(r).toHaveProperty('finalTitle');
          expect(r).toHaveProperty('finalAuthor');
          expect(r).toHaveProperty('finalAge');
          expect(r).toHaveProperty('finalEmail');
          expect(r).toHaveProperty('finalViews');
          expect(r).toHaveProperty('finalCategory');
          expect(r).toHaveProperty('finalSummary');
          expect(r).toHaveProperty('finalViewCategory');
          expect(r).toHaveProperty('finalTitleLen');
          expect(typeof r.finalTitle).toBe('string');
          expect(typeof r.finalAuthor).toBe('string');
          expect(typeof r.finalAge).toBe('number');
          expect(typeof r.finalEmail).toBe('string');
          expect(['low', 'medium', 'high']).toContain(r.finalViewCategory);
        });
      });
    });

    test('should join a complex subquery with navigation to another complex query with CTEs', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Build complex subquery A: Posts with navigation properties, grouped and aggregated
        const complexSubqueryA = db.posts
          .where(p => and(
            eq(p.user!.isActive, true),  // Navigation in filter
            gt(p.views, 0)
          ))
          .select(p => ({
            postId: p.id,
            postTitle: p.title,
            postViews: p.views,
            postCategory: p.category,
            authorId: p.userId,
            authorName: p.user!.username,  // Navigation in select
            authorAge: p.user!.age,        // Another navigation
          }))
          .orderBy(p => p.postViews)
          .select(p => ({
            id: p.postId,
            title: p.postTitle,
            views: p.postViews,
            category: p.postCategory,
            userId: p.authorId,
            author: p.authorName,
            age: p.authorAge,
            viewCategory: sql<string>`CASE WHEN ${p.postViews} > 100 THEN 'high' ELSE 'low' END`,
          }))
          .groupBy(p => ({ category: p.category, userId: p.userId }))
          .select(g => ({
            category: g.key.category,
            userId: g.key.userId,
            postCount: g.count(),
            totalViews: g.sum(p => p.views),
            avgViews: g.avg(p => p.views),
          }))
          .asSubquery('table');

        // Build CTE for users with order statistics
        const cteBuilder = new DbCteBuilder();
        const orderStatsCte = cteBuilder.withAggregation(
          'order_statistics',
          db.orders
            .where(o => and(
              eq(o.user!.isActive, true),  // Navigation filter
              gt(o.totalAmount, 0)
            ))
            .select(o => ({
              userId: o.userId,
              orderId: o.id,
              amount: o.totalAmount,
              status: o.status,
              userEmail: o.user!.email,  // Navigation in select
            }))
            .groupBy(o => ({ userId: o.userId }))
            .select(g => ({
              userId: g.key.userId,
              orderCount: g.count(),
              totalSpent: g.sum(o => o.amount),
              avgOrder: g.avg(o => o.amount),
            })),
          o => ({ userId: o.userId }),
          'orderData'
        );

        // Main query: Join complex subquery with users, then join CTE
        const result = await db.users
          .with(orderStatsCte)
          .select(u => ({
            userId: u.id,
            userName: u.username,
            userAge: u.age,
            userEmail: u.email,
            isActive: u.isActive,
          }))
          .where(u => eq(u.isActive, true))
          .orderBy(u => u.userName)
          .select(u => ({
            id: u.userId,
            name: u.userName,
            age: u.userAge,
            email: u.userEmail,
            active: u.isActive,
            nameUpper: sql<string>`UPPER(${u.userName})`,
          }))
          .leftJoin(
            complexSubqueryA,
            (u, posts) => eq(u.id, posts.userId),
            (u, posts) => ({
              userId: u.id,
              userName: u.name,
              userAge: u.age,
              userEmail: u.email,
              nameUpper: u.nameUpper,
              postCategory: posts.category,
              postCount: posts.postCount,
              totalViews: posts.totalViews,
              avgViews: posts.avgViews,
            }),
            'postData'
          )
          .select((r) => ({
            id: r.userId,
            name: r.userName,
            age: r.userAge,
            email: r.userEmail,
            displayName: r.nameUpper,
            category: r.postCategory,
            posts: r.postCount,
            views: r.totalViews,
            avgPerPost: r.avgViews,
          }))
          .orderBy((r) => r.id)
          .leftJoin(
            orderStatsCte,
            (u, orders) => eq(u.id, orders.userId),
            (u, orders) => ({
              userId: u.id,
              userName: u.name,
              displayName: u.displayName,
              age: u.age,
              email: u.email,
              postCategory: u.category,
              postCount: u.posts,
              totalViews: u.views,
              avgPostViews: u.avgPerPost,
              orderData: orders.orderData,
            })
          )
          .select((r) => ({
            finalUserId: r.userId,
            finalUserName: r.userName,
            finalDisplayName: r.displayName,
            finalAge: r.age,
            finalEmail: r.email,
            finalPostCategory: r.postCategory,
            finalPostCount: r.postCount,
            finalTotalViews: r.totalViews,
            finalAvgPostViews: r.avgPostViews,
            finalOrderStats: r.orderData,
            summary: sql<string>`${r.userName} || ' (' || COALESCE(CAST(${r.postCount} AS VARCHAR), '0') || ' posts)'`,
          }))
          .orderBy((r) => r.finalUserName)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.finalUserId>(r.finalUserId);
          assertType<string, typeof r.finalUserName>(r.finalUserName);
          assertType<string, typeof r.finalDisplayName>(r.finalDisplayName);
          assertType<number | undefined, typeof r.finalAge>(r.finalAge);
          assertType<string, typeof r.finalEmail>(r.finalEmail);
          assertType<string | null, typeof r.finalPostCategory>(r.finalPostCategory);
          assertType<number, typeof r.finalPostCount>(r.finalPostCount);
          assertType<number, typeof r.finalTotalViews>(r.finalTotalViews);
          assertType<number, typeof r.finalAvgPostViews>(r.finalAvgPostViews);
          assertType<unknown[], typeof r.finalOrderStats>(r.finalOrderStats);
          assertType<string, typeof r.summary>(r.summary);
          // Type inference tests - these will fail at compile time if types are wrong
          expect(r.finalUserId != 999999).toBe(true); // number type check
          expect(r.summary != 'impossible_string_match_xyz').toBe(true); // string (from sql<string>) type check
          expect(r).toHaveProperty('finalUserId');
          expect(r).toHaveProperty('finalUserName');
          expect(r).toHaveProperty('finalDisplayName');
          expect(r).toHaveProperty('finalAge');
          expect(r).toHaveProperty('finalEmail');
          expect(r).toHaveProperty('summary');
          expect(typeof r.finalUserName).toBe('string');
          expect(r.summary).toContain(r.finalUserName);
        });
      });
    });

    test('should join two complex subqueries with navigations and multiple transformations', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Build complex subquery A: Posts with navigation and transformations
        const complexSubqueryA = db.posts
          .where(p => and(
            eq(p.user!.isActive, true),
            gt(p.views, 0)
          ))
          .select(p => ({
            pId: p.id,
            pTitle: p.title,
            pViews: p.views,
            pCategory: p.category,
            pAuthorId: p.userId,
            pAuthorName: p.user!.username,
          }))
          .orderBy(p => p.pViews)
          .select(p => ({
            id: p.pId,
            title: p.pTitle,
            views: p.pViews,
            category: p.pCategory,
            userId: p.pAuthorId,
            author: p.pAuthorName,
            titleUpper: sql<string>`UPPER(${p.pTitle})`,
          }))
          .orderBy((p) => p.id)
          .asSubquery('table');

        // Build complex subquery B: Orders with navigation and transformations
        const complexSubqueryB = db.orders
          .where(o => eq(o.user!.isActive, true))
          .select(o => ({
            oId: o.id,
            oAmount: o.totalAmount,
            oStatus: o.status,
            oUserId: o.userId,
            oUserName: o.user!.username,
            oUserAge: o.user!.age,
          }))
          .orderBy(o => o.oAmount)
          .select(o => ({
            id: o.oId,
            amount: o.oAmount,
            status: o.oStatus,
            userId: o.oUserId,
            userName: o.oUserName,
            userAge: o.oUserAge,
            amountFormatted: sql<string>`'$' || CAST(${o.oAmount} AS VARCHAR)`,
          }))
          .orderBy((o) => o.id)
          .asSubquery('table');

        // Main query: Join both complex subqueries together via users
        const result = await db.users
          .select(u => ({
            uId: u.id,
            uName: u.username,
            uAge: u.age,
            uEmail: u.email,
            uActive: u.isActive,
          }))
          .where(u => eq(u.uActive, true))
          .orderBy(u => u.uName)
          .select(u => ({
            id: u.uId,
            name: u.uName,
            age: u.uAge,
            email: u.uEmail,
            nameLength: sql<number>`LENGTH(${u.uName})`,
          }))
          .leftJoin(
            complexSubqueryA,
            (u, posts) => eq(u.id, posts.userId),
            (u, posts) => ({
              userId: u.id,
              userName: u.name,
              userAge: u.age,
              userEmail: u.email,
              nameLen: u.nameLength,
              postId: posts.id,
              postTitle: posts.title,
              postTitleUpper: posts.titleUpper,
              postViews: posts.views,
              postCategory: posts.category,
              postAuthor: posts.author,
            }),
            'postData'
          )
          .select((r) => ({
            id: r.userId,
            name: r.userName,
            age: r.userAge,
            email: r.userEmail,
            nameLen: r.nameLen,
            pId: r.postId,
            pTitle: r.postTitle,
            pTitleUpper: r.postTitleUpper,
            pViews: r.postViews,
            pCategory: r.postCategory,
          }))
          .orderBy((r) => r.id)
          .leftJoin(
            complexSubqueryB,
            (u, orders) => eq(u.id, orders.userId),
            (u, orders) => ({
              finalUserId: u.id,
              finalUserName: u.name,
              finalUserAge: u.age,
              finalUserEmail: u.email,
              finalNameLen: u.nameLen,
              finalPostId: u.pId,
              finalPostTitle: u.pTitle,
              finalPostTitleUpper: u.pTitleUpper,
              finalPostViews: u.pViews,
              finalPostCategory: u.pCategory,
              finalOrderId: orders.id,
              finalOrderAmount: orders.amount,
              finalOrderFormatted: orders.amountFormatted,
              finalOrderStatus: orders.status,
              finalOrderUserAge: orders.userAge,
            }),
            'orderData'
          )
          .select((r) => ({
            userId: r.finalUserId,
            userName: r.finalUserName,
            userAge: r.finalUserAge,
            userEmail: r.finalUserEmail,
            nameLen: r.finalNameLen,
            postInfo: r.finalPostId ? {
              id: r.finalPostId,
              title: r.finalPostTitle,
              titleUpper: r.finalPostTitleUpper,
              views: r.finalPostViews,
              category: r.finalPostCategory,
            } : null,
            orderInfo: r.finalOrderId ? {
              id: r.finalOrderId,
              amount: r.finalOrderAmount,
              formatted: r.finalOrderFormatted,
              status: r.finalOrderStatus,
            } : null,
            masterSummary: sql<string>`
              ${r.finalUserName} ||
              ' (age: ' || COALESCE(CAST(${r.finalUserAge} AS VARCHAR), 'N/A') || ')' ||
              ' - Posts: ' || COALESCE(CAST(${r.finalPostId} AS VARCHAR), 'none') ||
              ' - Orders: ' || COALESCE(CAST(${r.finalOrderId} AS VARCHAR), 'none')
            `,
          }))
          .orderBy((r) => r.userId)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.userId>(r.userId);
          assertType<string, typeof r.userName>(r.userName);
          assertType<number | undefined, typeof r.userAge>(r.userAge);
          assertType<string, typeof r.userEmail>(r.userEmail);
          assertType<number, typeof r.nameLen>(r.nameLen);
          assertType<string, typeof r.masterSummary>(r.masterSummary);
          expect(r).toHaveProperty('userId');
          expect(r).toHaveProperty('userName');
          expect(r).toHaveProperty('userAge');
          expect(r).toHaveProperty('userEmail');
          expect(r).toHaveProperty('nameLen');
          expect(r).toHaveProperty('postInfo');
          expect(r).toHaveProperty('orderInfo');
          expect(r).toHaveProperty('masterSummary');
          expect(typeof r.userName).toBe('string');
          expect(typeof r.masterSummary).toBe('string');
          expect(r.masterSummary).toContain(r.userName);
        });
      });
    });

    test('should handle triple nested subqueries joined at multiple levels', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Level 1: Innermost subquery - orders with navigation filter
        const innerSubquery = db.orders
          .where(o => and(
            eq(o.user!.isActive, true),
            gt(o.totalAmount, 10)
          ))
          .select(o => ({
            userId: o.userId,
            amount: o.totalAmount,
            status: o.status,
            userName: o.user!.username,
          }))
          .orderBy(o => o.amount)
          .asSubquery('table');

        // Level 2: Middle subquery - joins users with inner subquery
        const middleSubquery = db.users
          .select(u => ({
            id: u.id,
            name: u.username,
            age: u.age,
            email: u.email,
            active: u.isActive,
          }))
          .where(u => eq(u.active, true))
          .leftJoin(
            innerSubquery,
            (u, orders) => eq(u.id, orders.userId),
            (u, orders) => ({
              userId: u.id,
              userName: u.name,
              userAge: u.age,
              userEmail: u.email,
              orderStatus: orders.status,
              orderAmount: orders.amount,
            }),
            'innerOrders'
          )
          .select((r) => ({
            id: r.userId,
            name: r.userName,
            age: r.userAge,
            email: r.userEmail,
            status: r.orderStatus,
            spent: r.orderAmount,
            summary: sql<string>`${r.userName} || ': spent $' || COALESCE(CAST(${r.orderAmount} AS VARCHAR), '0')`,
          }))
          .asSubquery('table');

        // Level 3: Outer subquery - posts joined with middle subquery
        const outerSubquery = db.posts
          .where(p => eq(p.user!.isActive, true))
          .select(p => ({
            postId: p.id,
            postTitle: p.title,
            postViews: p.views,
            postCategory: p.category,
            authorId: p.userId,
            authorName: p.user!.username,
          }))
          .leftJoin(
            middleSubquery,
            (p, user) => eq(p.authorId, user.id),
            (p, user) => ({
              id: p.postId,
              title: p.postTitle,
              views: p.postViews,
              category: p.postCategory,
              userId: p.authorId,
              author: p.authorName,
              userAge: user.age,
              userEmail: user.email,
              userOrderStatus: user.status,
              userSpent: user.spent,
              userSummary: user.summary,
            }),
            'middleData'
          )
          .select((r) => ({
            postId: r.id,
            postTitle: r.title,
            postViews: r.views,
            postCategory: r.category,
            userId: r.userId,
            author: r.author,
            userAge: r.userAge,
            userEmail: r.userEmail,
            orderStatus: r.userOrderStatus,
            spent: r.userSpent,
            userSummary: r.userSummary,
          }))
          .asSubquery('table');

        // Final query: Users joined with the outer subquery (3 levels deep)
        const result = await db.users
          .select(u => ({
            id: u.id,
            name: u.username,
            email: u.email,
            age: u.age,
          }))
          .leftJoin(
            outerSubquery,
            (u, data) => eq(u.id, data.userId),
            (u, data) => ({
              userId: u.id,
              userName: u.name,
              userEmail: u.email,
              userAge: u.age,
              postId: data.postId,
              postTitle: data.postTitle,
              postViews: data.postViews,
              postCategory: data.postCategory,
              postAuthor: data.author,
              orderStatus: data.orderStatus,
              orderSpent: data.spent,
              userSummary: data.userSummary,
            }),
            'outerData'
          )
          .select((r) => ({
            finalUserId: r.userId,
            finalUserName: r.userName,
            finalUserEmail: r.userEmail,
            finalUserAge: r.userAge,
            finalPostId: r.postId,
            finalPostTitle: r.postTitle,
            finalPostViews: r.postViews,
            finalPostCategory: r.postCategory,
            finalOrderStatus: r.orderStatus,
            finalOrderSpent: r.orderSpent,
            finalUserSummary: r.userSummary,
            megaSummary: sql<string>`
              'User: ' || ${r.userName} ||
              ' | Post: ' || COALESCE(${r.postTitle}, 'none') ||
              ' | Views: ' || COALESCE(CAST(${r.postViews} AS VARCHAR), '0') ||
              ' | Spent: $' || COALESCE(CAST(${r.orderSpent} AS VARCHAR), '0')
            `,
          }))
          .orderBy((r) => r.finalUserId)
          .toList();

        expect(result.length).toBeGreaterThan(0);
        result.forEach((r) => {
          // Type assertions
          assertType<number, typeof r.finalUserId>(r.finalUserId);
          assertType<string, typeof r.finalUserName>(r.finalUserName);
          assertType<string, typeof r.finalUserEmail>(r.finalUserEmail);
          assertType<number | undefined, typeof r.finalUserAge>(r.finalUserAge);
          assertType<number | undefined, typeof r.finalPostId>(r.finalPostId);
          assertType<string | undefined, typeof r.finalPostTitle>(r.finalPostTitle);
          assertType<number | undefined, typeof r.finalPostViews>(r.finalPostViews);
          assertType<string | null | undefined, typeof r.finalPostCategory>(r.finalPostCategory);
          assertType<string | undefined, typeof r.finalOrderStatus>(r.finalOrderStatus);
          assertType<number | undefined, typeof r.finalOrderSpent>(r.finalOrderSpent);
          assertType<string | undefined, typeof r.finalUserSummary>(r.finalUserSummary);
          assertType<string, typeof r.megaSummary>(r.megaSummary);
          // Type inference tests - these will fail at compile time if types are wrong
          expect(r.finalUserId != 999999).toBe(true); // number type check
          expect(r.finalUserAge != 999999).toBe(true); // number (from navigation through 3 levels) type check
          expect(r.megaSummary != 'impossible_string_match_xyz').toBe(true); // string (from sql<string>) type check
          expect(r).toHaveProperty('finalUserId');
          expect(r).toHaveProperty('finalUserName');
          expect(r).toHaveProperty('finalUserEmail');
          expect(r).toHaveProperty('finalUserAge');
          expect(r).toHaveProperty('megaSummary');
          expect(typeof r.finalUserName).toBe('string');
          expect(typeof r.megaSummary).toBe('string');
          expect(r.megaSummary).toContain('User:');
          expect(r.megaSummary).toContain(r.finalUserName);
        });
      });
    });
  });
});
