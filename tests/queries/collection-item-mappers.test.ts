import { describe, test, expect, jest } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import {
  QueryBatch, and, between, eq, exists, gt, gte, inArray, isNull, lte, ne, not, notExists, or,
} from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import type { HourMinute } from '../../debug/types/hour-minute';

/**
 * The columns of a collection's ITEM carry their type mapper (1.0.31).
 *
 * `CollectionQueryBuilder` minted its item's column refs without `__mapper` — the root's columns and a
 * reference navigation's have always carried it. Two symptoms, one cause:
 *
 *   - WHERE side: a value compared with a mapped column inside a collection's `.where()` was bound as it was
 *     written, never through `toDriver`: `u.posts.where(p => eq(p.publishTime, { hour: 9, minute: 30 }))` bound
 *     the OBJECT to a smallint parameter (22P02 — or, for a Temporal value against a timestamp column on
 *     postgres.js, ERR_INVALID_ARG_TYPE before the statement was sent).
 *   - READ side: `u.posts.max(p => p.publishTime)` read the stored smallint back (1125), not the mapped value.
 *
 * Post.publishTime is { hour, minute } stored as smallint minutes; Post.customDate and User.lastActiveAt are
 * Dates stored as integer seconds since 2025-01-01. Both mappers fail visibly when applied twice (NaN, an
 * Invalid Date), so every list below also proves its items are read through their mapper exactly once.
 *
 * Seed: alice — posts at 09:30 (customDate 2024-01-15) and 14:00 (2024-01-16); bob — one at 18:45
 * (2024-01-15); charlie — none.
 */
const STRATEGIES = ['cte', 'lateral', 'temptable'] as const;

const at = (hour: number, minute: number): HourMinute => ({ hour, minute });
const jan15 = new Date('2024-01-15T10:00:00Z');
const jan16 = new Date('2024-01-16T10:00:00Z');

describe('type mappers on the columns of a collection item', () => {
  for (const collectionStrategy of STRATEGIES) {
    describe(`${collectionStrategy} strategy`, () => {
      test('WHERE: a mapped value compared with an item column inside collection.where(...).exists()', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);
          const usersWhere = async (condition: (u: any) => any) => (await db.users
            .where(condition)
            .select(u => ({ id: u.id }))
            .orderBy(u => u.id)
            .toList()).map(u => u.id);

          // eq / ne
          expect(await usersWhere(u => u.posts.where((p: any) => eq(p.publishTime, at(9, 30))).exists())).toEqual([users.alice.id]);
          expect(await usersWhere(u => exists(u.posts.where((p: any) => ne(p.publishTime, at(18, 45)))))).toEqual([users.alice.id]);
          // lte / gte / gt — and a Date through the integer mapper
          expect(await usersWhere(u => u.posts.where((p: any) => lte(p.publishTime, at(9, 30))).exists())).toEqual([users.alice.id]);
          expect(await usersWhere(u => u.posts.where((p: any) => gte(p.publishTime, at(14, 0))).exists())).toEqual([users.alice.id, users.bob.id]);
          expect(await usersWhere(u => u.posts.where((p: any) => gt(p.customDate, jan15)).exists())).toEqual([users.alice.id]);
          // not(exists(...)) / notExists(...)
          expect(await usersWhere(u => not(exists(u.posts.where((p: any) => lte(p.publishTime, at(14, 0))))))).toEqual([users.bob.id, users.charlie.id]);
          expect(await usersWhere(u => notExists(u.posts.where((p: any) => eq(p.customDate, jan15))))).toEqual([users.charlie.id]);
          // a list and a range of mapped values
          expect(await usersWhere(u => u.posts.where((p: any) => inArray(p.publishTime, [at(14, 0), at(18, 45)])).exists())).toEqual([users.alice.id, users.bob.id]);
          expect(await usersWhere(u => u.posts.where((p: any) => between(p.publishTime, at(15, 0), at(23, 0))).exists())).toEqual([users.bob.id]);
          // beside a root condition, as the consumer writes it
          expect(await usersWhere(u => and(
            u.posts.where((p: any) => and(eq(p.publishTime, at(9, 30)), eq(p.customDate, jan15))).exists(),
            or(isNull(u.lastActiveAt), lte(u.lastActiveAt, new Date('2025-12-31T00:00:00Z'))),
          ))).toEqual([users.alice.id]);
        }, { collectionStrategy });
      });

      test('WHERE: a collection reached through a reference, and an item column compared with an outer column', async () => {
        await withDatabase(async (db) => {
          const { orders, postComments } = await seedTestData(db);

          // order -> user -> posts
          const ordersOfMorningAuthors = await db.orders
            .where(o => o.user!.posts!.where(p => eq(p.publishTime, at(9, 30))).exists())
            .select(o => ({ id: o.id }))
            .toList();

          expect(ordersOfMorningAuthors).toEqual([{ id: orders.aliceOrder.id }]);

          // comment -> post -> user -> posts: an item column against a mapped value AND against the outer row's
          // mapped column (column to column: nothing to convert)
          const comments = await db.postComments
            .where(pc => not(exists(pc.post!.user!.posts!.where(p => and(
              gt(p.publishTime, pc.post!.publishTime),
              lte(p.publishTime, at(23, 59)),
            )))))
            .select(pc => ({ id: pc.id }))
            .orderBy(pc => pc.id)
            .toList();

          // alice's 09:30 post has a later sibling (14:00); her 14:00 post and bob's only post have none
          expect(comments).toEqual([{ id: postComments.alicePostComment2.id }, { id: postComments.bobPostComment.id }]);
        }, { collectionStrategy });
      });

      test('projection: a root collection filtered by a mapped value — its items read through their mappers once', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);
          const query = () => db.users
            .select(u => ({
              id: u.id,
              afternoon: u.posts!
                .where(p => gte(p.publishTime, at(12, 0)))
                .orderBy(p => p.publishTime)
                .select(p => ({ title: p.title, at: p.publishTime, on: p.customDate }))
                .toList('afternoon'),
              onJan15: u.posts!.where(p => eq(p.customDate, jan15)).count(),
              times: u.posts!.orderBy(p => [[p.publishTime, 'DESC']]).select(p => p.publishTime).toList('times'),
              first: u.posts!.where(p => lte(p.publishTime, at(18, 45))).orderBy(p => p.publishTime).select(p => ({ at: p.publishTime })).firstOrDefault(),
              nested: u.posts!.where(p => eq(p.publishTime, at(14, 0))).select(p => ({ when: { at: p.publishTime, on: p.customDate } })).toList('nested'),
            }))
            .orderBy(u => u.id);
          const expected = [
            {
              id: users.alice.id,
              afternoon: [{ title: 'Alice Post 2', at: at(14, 0), on: jan16 }],
              onJan15: 1,
              times: [at(14, 0), at(9, 30)],
              first: { at: at(9, 30) },
              nested: [{ when: { at: at(14, 0), on: jan16 } }],
            },
            {
              id: users.bob.id,
              afternoon: [{ title: 'Bob Post', at: at(18, 45), on: jan15 }],
              onJan15: 1,
              times: [at(18, 45)],
              first: { at: at(18, 45) },
              nested: [],
            },
            { id: users.charlie.id, afternoon: [], onJan15: 0, times: [], first: null, nested: [] },
          ];

          expect(await query().toList()).toEqual(expected);
          expect(await query().where(u => eq(u.id, users.alice.id)).firstOrDefault()).toEqual(expected[0]);
        }, { collectionStrategy });
      });

      test('projection: a collection through a reference, and a collection nested in a collection', async () => {
        await withDatabase(async (db) => {
          const { orders, users } = await seedTestData(db);

          const perOrder = await db.orders
            .select(o => ({
              id: o.id,
              late: o.user!.posts!.where(p => gt(p.publishTime, at(10, 0))).count(),
            }))
            .orderBy(o => o.id)
            .toList();

          expect(perOrder).toEqual([{ id: orders.aliceOrder.id, late: 1 }, { id: orders.bobOrder.id, late: 1 }]);

          // user -> orders -> user -> posts: the inner collection's item columns are compared with mapped values too
          const nested = await db.users
            .where(u => eq(u.id, users.alice.id))
            .select(u => ({
              id: u.id,
              orders: u.orders!.select(o => ({
                id: o.id,
                morning: o.user!.posts!.where(p => lte(p.publishTime, at(12, 0))).select(p => ({ at: p.publishTime })).toList('morning'),
              })).toList('orders'),
            }))
            .toList();

          expect(nested).toEqual([{ id: users.alice.id, orders: [{ id: orders.aliceOrder.id, morning: [{ at: at(9, 30) }] }] }]);
        }, { collectionStrategy });
      });

      test('READ: max() / min() of a mapped item column read through its mapper; sum() and count() stay numbers', async () => {
        await withDatabase(async (db) => {
          const { users } = await seedTestData(db);
          const query = () => db.users
            .select(u => ({
              id: u.id,
              last: u.posts!.max(p => p.publishTime),
              first: u.posts!.min(p => p.publishTime),
              lastDay: u.posts!.max(p => p.customDate),
              firstAfternoon: u.posts!.where(p => gte(p.publishTime, at(12, 0))).min(p => p.publishTime),
              // not values of the column: the stored numbers, as before
              minutes: u.posts!.sum(p => p.publishTime),
              mostViews: u.posts!.max(p => p.views),
              posts: u.posts!.count(),
            }))
            .orderBy(u => u.id);
          const expected = [
            { id: users.alice.id, last: at(14, 0), first: at(9, 30), lastDay: jan16, firstAfternoon: at(14, 0), minutes: 570 + 840, mostViews: 150, posts: 2 },
            { id: users.bob.id, last: at(18, 45), first: at(18, 45), lastDay: jan15, firstAfternoon: at(18, 45), minutes: 1125, mostViews: 200, posts: 1 },
            { id: users.charlie.id, last: null, first: null, lastDay: null, firstAfternoon: null, minutes: null, mostViews: null, posts: 0 },
          ];

          expect<unknown>(await query().toList()).toEqual(expected);
          expect<unknown>(await query().where(u => eq(u.id, users.bob.id)).firstOrDefault()).toEqual(expected[1]);

          // through a reference, and of a column reached through the item's own navigation
          const perOrder = await db.orders
            .select(o => ({
              id: o.id,
              last: o.user!.posts!.max(p => p.publishTime),
              authorSeen: o.user!.posts!.max(p => p.user!.lastActiveAt),
            }))
            .orderBy(o => o.id)
            .toList();

          expect<unknown>(perOrder.map(o => o.last)).toEqual([at(14, 0), at(18, 45)]);
          expect<unknown>(perOrder.map(o => o.authorSeen)).toEqual([new Date('2025-03-15T08:00:00Z'), new Date('2025-06-20T14:30:00Z')]);

          // nested in a collection's projection
          const nested = await db.users
            .where(u => eq(u.id, users.alice.id))
            .select(u => ({
              orders: u.orders!.select(o => ({ last: o.user!.posts!.max(p => p.publishTime), n: o.user!.posts!.count() })).toList('orders'),
            }))
            .toList();

          expect<unknown>(nested).toEqual([{ orders: [{ last: at(14, 0), n: 2 }] }]);
        }, { collectionStrategy });
      });

      test('QueryBatch: the filtered collections and the mapped aggregates ride a batch with the standalone results', async () => {
        await withDatabase(async (db) => {
          await seedTestData(db);

          const filtered = () => db.users
            .where(u => u.posts!.where(p => gte(p.publishTime, at(14, 0))).exists())
            .select(u => ({
              id: u.id,
              last: u.posts!.max(p => p.publishTime),
              firstDay: u.posts!.min(p => p.customDate),
              late: u.posts!.where(p => gt(p.publishTime, at(10, 0))).select(p => ({ at: p.publishTime, on: p.customDate })).toList('late'),
            }))
            .orderBy(u => u.id);
          const expected = await filtered().toList();

          expect<unknown>(expected.map(u => u.last)).toEqual([at(14, 0), at(18, 45)]);
          expect<unknown>(expected.map(u => u.firstDay)).toEqual([jan15, jan15]);

          const batch = new QueryBatch();
          const list = batch.addList(filtered(), 'filtered');
          const first = batch.addFirstOrDefault(filtered(), 'first');
          const count = batch.addCount(db.users.where(u => u.posts!.where(p => eq(p.publishTime, at(18, 45))).exists()), 'count');
          const querySpy = jest.spyOn((db as any).client, 'query');

          try {
            await batch.executeBatch();

            expect(querySpy).toHaveBeenCalledTimes(1);
          } finally {
            querySpy.mockRestore();
          }

          expect(batch.getList(list)).toEqual(expected);
          expect(batch.getItem(first)).toEqual(expected[0]);
          expect(batch.getCount(count)).toBe(1);
        }, { collectionStrategy });
      });
    });
  }

  test('the item\'s column refs carry the column\'s mapper — and only a mapped column\'s', async () => {
    await withDatabase(async (db) => {
      const seen: Record<string, unknown> = {};

      await db.users.where(u => u.posts!.where((p: any) => {
        seen.mapped = p.publishTime.__mapper;
        seen.unmappedHasKey = '__mapper' in p.title;

        return eq(p.views, 1);
      }).exists()).select(u => ({ id: u.id })).toList();

      expect(typeof (seen.mapped as any)?.toDriver).toBe('function');
      expect((seen.mapped as any).toDriver(at(9, 30))).toBe(570);
      expect(seen.unmappedHasKey).toBe(false);
    });
  });

  test('a mutation\'s RETURNING: the filtered collection and the mapped aggregate of the mutated row', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const rows = await db.users
        .where(u => u.posts!.where(p => eq(p.publishTime, at(9, 30))).exists())
        .update({ isActive: true })
        .returning(u => ({
          username: u.username,
          last: u.posts!.max(p => p.publishTime),
          firstDay: u.posts!.min(p => p.customDate),
          afternoon: u.posts!.where(p => gte(p.publishTime, at(12, 0))).select(p => ({ at: p.publishTime })).toList('afternoon'),
          views: u.posts!.sum(p => p.views),
        }));

      expect<unknown>(rows).toEqual([{ username: 'alice', last: at(14, 0), firstDay: jan15, afternoon: [{ at: at(14, 0) }], views: 250 }]);
    });
  });

  test('disableMappers reads the stored values, the aggregate\'s too', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      // The option is read from the context's executor, which a context makes when it logs (see QueryExecutor.isNeeded)
      const rawDb = new AppDatabase((db as any).client, { disableMappers: true, logQueries: true, logger: () => {}, collectionStrategy: 'lateral' });
      const rows = await rawDb.users
        .where(u => eq(u.id, users.bob.id))
        .select(u => ({ last: u.posts!.max(p => p.publishTime) }))
        .toList();

      expect<unknown>(rows).toEqual([{ last: 1125 }]);
    });
  });
});
