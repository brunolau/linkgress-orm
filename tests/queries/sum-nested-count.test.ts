import { describe, test, expect } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';

const STRATEGIES = ['lateral', 'cte'] as const;

describe('sum() with nested scalar subquery summand', () => {
  for (const strategy of STRATEGIES) {
    describe(`collectionStrategy: ${strategy}`, () => {
      test('sum(row => otherCollection.where(...).count()) with sibling toNumberList projections', async () => {
        await withDatabase(async (db) => {
          const seeded = await seedTestData(db);
          const alice = seeded.users.alice;

          const result = await db.users
            .where(u => eq(u.id, alice.id))
            .select(u => ({
              id: u.id,
              username: u.username,
              postIds: u.posts!
                .select(p => ({ id: p.id }))
                .toNumberList(),
              orderIds: u.orders!
                .select(o => ({ id: o.id }))
                .toNumberList(),
              totalComments: u.posts!.sum(p =>
                p.postComments!
                  .where(pc => gt(pc.id, 0))
                  .count()
              ),
            }))
            .firstOrDefault();

          expect(result).not.toBeNull();
          expect(result!.username).toBe('alice');
          expect(result!.postIds.length).toBe(2);
          expect(result!.orderIds.length).toBe(1);
          expect(result!.totalComments).toBe(2);
        }, { collectionStrategy: strategy });
      });

      test('sum(row => otherCollection.where(...).count()) WITHOUT sibling collections', async () => {
        await withDatabase(async (db) => {
          const seeded = await seedTestData(db);
          const alice = seeded.users.alice;

          const result = await db.users
            .where(u => eq(u.id, alice.id))
            .select(u => ({
              id: u.id,
              username: u.username,
              totalComments: u.posts!.sum(p =>
                p.postComments!
                  .where(pc => gt(pc.id, 0))
                  .count()
              ),
            }))
            .firstOrDefault();

          expect(result).not.toBeNull();
          expect(result!.username).toBe('alice');
          expect(result!.totalComments).toBe(2);
        }, { collectionStrategy: strategy });
      });

      test('sum(row => otherCollection.count()) returns 0 when outer collection is empty', async () => {
        await withDatabase(async (db) => {
          const seeded = await seedTestData(db);
          const charlie = seeded.users.charlie;

          const result = await db.users
            .where(u => eq(u.id, charlie.id))
            .select(u => ({
              username: u.username,
              totalComments: u.posts!.sum(p => p.postComments!.count()),
            }))
            .firstOrDefault();

          expect(result).not.toBeNull();
          expect(result!.username).toBe('charlie');
          expect(result!.totalComments ?? 0).toBe(0);
        }, { collectionStrategy: strategy });
      });
    });
  }
});

/**
 * The summand goes through a REFERENCE hop (1.0.31): `links.sum(l => l.discount.codes.where(…).count())`.
 *
 * The count's correlated subquery reads the hop it hangs off (`"discount"."id"`) and leaves the join to the
 * collection being summed — which did not join it: a collection summand was skipped when the navigations of
 * the selector were collected. Depending on what the enclosing statement had in scope under that name:
 *
 *   - nothing: 42P01 `missing FROM-clause entry for table "discount"`;
 *   - a join of an ENCLOSING query (the root reached the summed collection through a hop of the same name):
 *     the count read THAT row. To PostgreSQL the SUM then reads only an outer query's columns, which makes it
 *     an aggregate of that outer query — 42803 `column … must appear in the GROUP BY clause`. The in-memory
 *     database evaluated it in place and answered with another number (it refuses such an aggregate now, see
 *     tests/memory/in-memory-database.test.ts).
 *
 * Seed: alice — 2 posts, 1 order; bob — 1 post, 1 order; charlie — neither. Comments: one per post (a second
 * one on alice's first post is added below). Cart A holds the codes of discount A (2 products) and discount B
 * (1 product), cart B the code of discount B.
 */
describe('sum() over a nested count whose summand goes through a reference hop', () => {
  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    describe(`collectionStrategy: ${strategy}`, () => {
      test('at the top level: one hop, two hops, a filtered summand, beside sibling collections', async () => {
        await withDatabase(async (db) => {
          const { users, carts } = await seedTestData(db);

          // one hop: post -> user -> orders
          const perUser = await db.users
            .select(u => ({
              id: u.id,
              postIds: u.posts!.orderBy(p => p.id).select(p => ({ id: p.id })).toNumberList(),
              authorOrders: u.posts!.sum(p => p.user!.orders!.where(o => gt(o.id, 0)).count()),
              // the summed collection filtered, and the summand's filter reading the hop
              completed: u.posts!.where(p => gt(p.views, 100)).sum(p => p.user!.orders!.where(o => eq(o.status, 'completed')).count()),
              posts: u.posts!.count(),
            }))
            .orderBy(u => u.id)
            .toList();

          expect(perUser.map(u => [u.id, u.postIds.length, u.authorOrders, u.completed, u.posts])).toEqual([
            // 2 posts x 1 order; the 150-view post x alice's 1 completed order
            [users.alice.id, 2, 2, 1, 2],
            // 1 post x 1 order; bob's order is pending
            [users.bob.id, 1, 1, 0, 1],
            [users.charlie.id, 0, null, null, 0],
          ]);

          // two hops: cart code -> discount code -> discount -> discount products
          const perCart = await db.carts
            .select(c => ({ id: c.id, discounted: c.cartDiscountCodes!.sum(x => x.discountCode!.discount!.discountProducts!.count()) }))
            .orderBy(c => c.id)
            .toList();

          expect(perCart).toEqual([{ id: carts.cartA.id, discounted: 3 }, { id: carts.cartB.id, discounted: 1 }]);
        }, { collectionStrategy: strategy });
      });

      test('inside a list reached through a hop of the SAME name: the count reads its own hop, not the enclosing row\'s', async () => {
        await withDatabase(async (db) => {
          const { posts, orders, postComments } = await seedTestData(db);

          const [second] = await db.postComments
            .insertBulk([{ postId: posts.alicePost1.id, orderId: orders.bobOrder.id, comment: 'A second comment on the first post' }])
            .returning();

          // comment -> post -> user -> posts (the list); per listed post, over ITS comments: the comments of each
          // comment's post — the square of the post's comment count. The enclosing list is reached through `post`
          // too: bound to that row, every listed post would count the comments of the ROOT comment's post
          const rows = await db.postComments
            .select(pc => ({
              id: pc.id,
              authored: pc.post!.user!.posts!
                .orderBy(p => p.id)
                .select(p => ({ id: p.id, n: p.postComments!.sum(c => c.post!.postComments!.where(x => gt(x.id, 0)).count()) }))
                .toList('authored'),
            }))
            .orderBy(pc => pc.id)
            .toList();
          const alicePosts = [{ id: posts.alicePost1.id, n: 4 }, { id: posts.alicePost2.id, n: 1 }];

          expect(rows).toEqual([
            { id: postComments.alicePostComment1.id, authored: alicePosts },
            { id: postComments.alicePostComment2.id, authored: alicePosts },
            { id: postComments.bobPostComment.id, authored: [{ id: posts.bobPost.id, n: 1 }] },
            { id: second.id, authored: alicePosts },
          ]);
        }, { collectionStrategy: strategy });
      });
    });
  }
});
