import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, ne } from '../../src';
import { assertType } from '../utils/type-tester';
import { expectToReject } from '../utils/expect-rejects';

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
          // Type assertions
          assertType<string, typeof r.postTitle>(r.postTitle);
          assertType<string, typeof r.userName>(r.userName);
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
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.user1>(r.user1);
          assertType<string, typeof r.user2Email>(r.user2Email);
        });
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
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.postTitle>(r.postTitle);
          assertType<number, typeof r.views>(r.views);
          expect(r.views).toBeGreaterThan(100);
        });
      });
    });

    describe('navigations and collections of a joined table', () => {
      // A joined table's row lives under the join's alias (`posts_0`), not under its table name.
      // Its navigations have to hang off that alias — also when the ROOT has a navigation of the
      // same name (`orders.user` vs `posts.user`), which used to resolve against the root and
      // answer every post's author with the ORDER's owner, without an error.
      test('a reference navigation joins through the join alias, not the root navigation of the same name', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const rows = await db.orders
            .innerJoin(
              db.posts,
              (order, post) => ne(post.userId, order.userId),
              (order, post) => ({
                orderOwner: order.user!.username,
                postTitle: post.title,
                postAuthor: post.user!.username,
              })
            )
            .toList();

          rows.forEach(r => {
            assertType<string, typeof r.postAuthor>(r.postAuthor);
          });
          expect(rows.map(r => `${r.orderOwner} / ${r.postTitle} / ${r.postAuthor}`).sort()).toEqual([
            'alice / Bob Post / bob',
            'bob / Alice Post 1 / alice',
            'bob / Alice Post 2 / alice',
          ]);
        });
      });

      test('a root navigation chain is not resolved through a joined table\'s navigation', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          // `comment.order.user` resolves by NAME: `order` off the root, then `user` off whichever joined
          // schema has one. The joined comment's `post` (posts HAS a `user`) must not answer it: the second
          // comment's order belongs to bob while its post was written by alice.
          const rows = await db.postComments
            .innerJoin(
              db.postComments,
              (comment, same) => eq(same.id, comment.id),
              (comment, same) => ({
                comment: comment.comment,
                orderOwner: comment.order!.user!.username,
                postTitle: same.post!.title,
              })
            )
            .toList();

          expect(rows.map(r => `${r.comment} / ${r.orderOwner} / ${r.postTitle}`).sort()).toEqual([
            'Mentions another order / bob / Alice Post 2',
            'My order update / bob / Bob Post',
            'Related to order / alice / Alice Post 1',
          ]);
        });
      });

      test('a whole navigation row of a joined table is selected, not dropped', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const rows = await db.orders
            .innerJoin(
              db.posts,
              (order, post) => ne(post.userId, order.userId),
              (order, post) => ({
                postTitle: post.title,
                author: post.user!,
              })
            )
            .toList();

          expect(rows.map(r => `${r.postTitle} / ${r.author?.username} / ${r.author?.email}`).sort()).toEqual([
            'Alice Post 1 / alice / alice@test.com',
            'Alice Post 2 / alice / alice@test.com',
            'Bob Post / bob / bob@test.com',
          ]);
        });
      });

      test('a required navigation below a LEFT-joined table does not drop the rows the join kept', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          // `post.user` is required, so on its own it renders as INNER JOIN — below a LEFT join
          // whose row is missing (charlie has no posts) that would drop charlie's row
          const rows = await db.users
            .leftJoin(
              db.posts,
              (user, post) => eq(post.userId, user.id),
              (user, post) => ({
                username: user.username,
                postTitle: post.title,
                postAuthor: post.user!.username,
              })
            )
            .toList();

          expect(rows.map(r => `${r.username} / ${r.postTitle ?? '-'} / ${r.postAuthor ?? '-'}`).sort()).toEqual([
            'alice / Alice Post 1 / alice',
            'alice / Alice Post 2 / alice',
            'bob / Bob Post / bob',
            'charlie / - / -',
          ]);
        });
      });

      test('a navigation chain joins hop by hop and can be filtered on after the join', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const rows = await db.orders
            .innerJoin(
              db.orderTasks,
              (order, orderTask) => eq(orderTask.orderId, order.id),
              (order, orderTask) => ({
                status: order.status,
                taskTitle: orderTask.task!.title,
                levelName: orderTask.task!.level!.name,
                levelCreator: orderTask.task!.level!.createdBy!.username,
              })
            )
            .where(r => eq(r.levelCreator, 'bob'))
            .toList();

          expect(rows).toEqual([{ status: 'pending', taskTitle: 'Regular Task', levelName: 'Low Priority', levelCreator: 'bob' }]);
        });
      });

      test('collections of a joined table and of its navigations correlate to the join', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const owners = await db.orders
            .innerJoin(
              db.users,
              (order, user) => eq(user.id, order.userId),
              (order, user) => ({
                status: order.status,
                postCount: user.posts!.count(),
                postTitles: user.posts!.orderBy(p => p.id).select(p => ({ title: p.title })).toStringList('postTitles'),
                posts: user.posts!.orderBy(p => p.id).select(p => ({ title: p.title, views: p.views })).toList('posts'),
              })
            )
            .toList();

          expect(owners.sort((a, b) => a.status.localeCompare(b.status))).toEqual([
            {
              status: 'completed',
              postCount: 2,
              postTitles: ['Alice Post 1', 'Alice Post 2'],
              posts: [{ title: 'Alice Post 1', views: 100 }, { title: 'Alice Post 2', views: 150 }],
            },
            { status: 'pending', postCount: 1, postTitles: ['Bob Post'], posts: [{ title: 'Bob Post', views: 200 }] },
          ]);

          const authors = await db.orders
            .innerJoin(
              db.posts,
              (order, post) => ne(post.userId, order.userId),
              (order, post) => ({
                postTitle: post.title,
                authorPostCount: post.user!.posts!.count(),
              })
            )
            .toList();

          expect(authors.map(r => `${r.postTitle} / ${r.authorPostCount}`).sort()).toEqual([
            'Alice Post 1 / 2',
            'Alice Post 2 / 2',
            'Bob Post / 1',
          ]);
        }, { collectionStrategy: 'lateral' });
      });

      test('the cte and temptable strategies refuse a collection of a joined table instead of attaching it to the root row', async () => {
        for (const collectionStrategy of ['cte', 'temptable'] as const) {
          await withDatabase(async (db) => {
            await seedTestData(db);

            const counts = db.orders.innerJoin(
              db.users,
              (order, user) => eq(user.id, order.userId),
              (order, user) => ({ status: order.status, postCount: user.posts!.count() })
            );
            const lists = db.orders.innerJoin(
              db.users,
              (order, user) => eq(user.id, order.userId),
              (order, user) => ({ status: order.status, posts: user.posts!.select(p => ({ title: p.title })).toList('posts') })
            );

            await expectToReject(() => counts.toList(), /collection "posts" of the joined table "users_0" needs the 'lateral' collection strategy/);
            await expectToReject(() => lists.toList(), /collection "posts" of the joined table "users_0" needs the 'lateral' collection strategy/);
          }, { collectionStrategy });
        }
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
        result.forEach(r => {
          // Type assertions
          assertType<string, typeof r.username>(r.username);
          assertType<string, typeof r.postTitle>(r.postTitle);
          assertType<number, typeof r.views>(r.views);
        });
        expect(result[0].views).toBeGreaterThanOrEqual(result[1].views);
      });
    });
  });
});
