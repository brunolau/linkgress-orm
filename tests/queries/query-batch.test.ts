import { describe, test, expect, jest } from '@jest/globals';
import postgres from 'postgres';
import { withDatabase, seedTestData, testConnectionConfig } from '../utils/test-database';
import { eq, gt, PostgresClient } from '../../src';
import { QueryBatch } from '../../src/query/query-batch';
import { AppDatabase } from '../../debug/schema/appDatabase';

describe('QueryBatch', () => {
  describe('single round trip execution', () => {
    test('executes lists, firstOrDefault and counts in ONE round trip with results identical to standalone execution', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Standalone reference results via the canonical execution paths
        const expectedOrders = await db.orders
          .where(o => eq(o.status, 'completed'))
          .select(o => ({ id: o.id, status: o.status, totalAmount: o.totalAmount, createdAt: o.createdAt }))
          .orderBy(o => o.id)
          .toList();
        const expectedUsers = await db.users
          .where(u => eq(u.isActive, true))
          .select(u => u)
          .orderBy(u => u.id)
          .toList();
        const expectedBob = await db.users
          .where(u => eq(u.username, 'bob'))
          .select(u => ({ id: u.id, name: u.username }))
          .firstOrDefault();
        const expectedActiveCount = await db.users.where(u => eq(u.isActive, true)).count();

        const batch = new QueryBatch();
        const ordersKey = batch.addList(
          db.orders
            .where(o => eq(o.status, 'completed'))
            .select(o => ({ id: o.id, status: o.status, totalAmount: o.totalAmount, createdAt: o.createdAt }))
            .orderBy(o => o.id),
          'orders'
        );
        const usersKey = batch.addList(
          db.users.where(u => eq(u.isActive, true)).select(u => u).orderBy(u => u.id),
          'activeUsers'
        );
        const bobKey = batch.addFirstOrDefault(
          db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username })),
          'bob'
        );
        const countKey = batch.addCount(db.users.where(u => eq(u.isActive, true)), 'activeCount');

        const client = (db as any).client;
        const querySpy = jest.spyOn(client, 'query');

        try {
          await batch.executeBatch();

          expect(querySpy).toHaveBeenCalledTimes(1);
        } finally {
          querySpy.mockRestore();
        }

        expect(batch.getList(ordersKey)).toEqual(expectedOrders);
        expect(batch.getList(usersKey)).toEqual(expectedUsers);
        expect(batch.getItem(bobKey)).toEqual(expectedBob);
        expect(batch.getCount(countKey)).toBe(expectedActiveCount);

        // string identifiers work as an escape hatch
        expect(batch.getList('orders')).toEqual(expectedOrders);
        expect(batch.getItem('bob')).toEqual(expectedBob);
        expect(batch.getCount('activeCount')).toBe(expectedActiveCount);
      });
    });

    test('preserves Date and decimal fidelity through the batch', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const expected = await db.orders
          .select(o => ({ id: o.id, totalAmount: o.totalAmount, createdAt: o.createdAt }))
          .orderBy(o => o.id)
          .toList();

        const batch = new QueryBatch();
        batch.addList(
          db.orders.select(o => ({ id: o.id, totalAmount: o.totalAmount, createdAt: o.createdAt })).orderBy(o => o.id),
          'orders'
        );
        await batch.executeBatch();

        const batched = batch.getList<{ id: number; totalAmount: any; createdAt: any }>('orders');

        expect(batched).toEqual(expected);
        expect(batched.length).toBeGreaterThan(0);
        // value TYPES must match standalone execution exactly, not just JSON-ish equality
        expect(batched[0].createdAt?.constructor).toBe(expected[0].createdAt?.constructor);
        expect(typeof batched[0].totalAmount).toBe(typeof expected[0].totalAmount);
      });
    });

    test('applies custom type mappers identically through the batch', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const expected = await db.posts
          .select(p => ({ id: p.id, customDate: p.customDate, publishTime: p.publishTime }))
          .orderBy(p => p.id)
          .toList();

        const batch = new QueryBatch();
        batch.addList(
          db.posts.select(p => ({ id: p.id, customDate: p.customDate, publishTime: p.publishTime })).orderBy(p => p.id),
          'posts'
        );
        await batch.executeBatch();

        expect(batch.getList('posts')).toEqual(expected);
      });
    });

    test('supports flat navigation-property fields in selections', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const expected = await db.posts
          .select(p => ({ title: p.title, author: p.user!.username }))
          .orderBy(p => p.title)
          .toList();

        const batch = new QueryBatch();
        batch.addList(db.posts.select(p => ({ title: p.title, author: p.user!.username })).orderBy(p => p.title), 'posts');
        await batch.executeBatch();

        expect(batch.getList('posts')).toEqual(expected);
      });
    });

    test('returns [] for empty lists and null for absent firstOrDefault', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        const emptyKey = batch.addList(
          db.users.where(u => eq(u.username, 'nobody')).select(u => ({ id: u.id })),
          'empty'
        );
        const missingKey = batch.addFirstOrDefault(
          db.users.where(u => eq(u.username, 'nobody')).select(u => ({ id: u.id })),
          'missing'
        );
        await batch.executeBatch();

        expect(batch.getList(emptyKey)).toEqual([]);
        expect(batch.getItem(missingKey)).toBeNull();
      });
    });

    test('preserves per-branch ORDER BY', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        batch.addList(db.users.select(u => ({ name: u.username })).orderBy(u => [[u.name, 'DESC']]), 'desc');
        batch.addList(db.users.select(u => ({ name: u.username })).orderBy(u => u.name), 'asc');
        await batch.executeBatch();

        expect(batch.getList<{ name: string }>('desc').map(u => u.name)).toEqual(['charlie', 'bob', 'alice']);
        expect(batch.getList<{ name: string }>('asc').map(u => u.name)).toEqual(['alice', 'bob', 'charlie']);
      });
    });

    test('routes parameters to the correct branches', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        batch.addList(db.users.where(u => gt(u.age, 30)).select(u => ({ name: u.username })).orderBy(u => u.name), 'older');
        batch.addFirstOrDefault(db.posts.where(p => eq(p.title, 'Alice Post 1')).select(p => ({ title: p.title, views: p.views })), 'post');
        batch.addCount(db.users.where(u => eq(u.isActive, false)), 'inactive');
        await batch.executeBatch();

        expect(batch.getList<{ name: string }>('older').map(u => u.name)).toEqual(['bob', 'charlie']);
        expect(batch.getItem<{ title: string; views: number }>('post')).toEqual({ title: 'Alice Post 1', views: 100 });
        expect(batch.getCount('inactive')).toBe(1);
      });
    });
  });

  describe('error semantics', () => {
    test('rejects duplicate identifiers at add time', async () => {
      await withDatabase(async (db) => {
        const batch = new QueryBatch();
        batch.addList(db.users.select(u => ({ id: u.id })), 'dup');

        expect(() => batch.addList(db.users.select(u => ({ id: u.id })), 'dup')).toThrow(/dup/);
      });
    });

    test('rejects get* before executeBatch()', async () => {
      await withDatabase(async (db) => {
        const batch = new QueryBatch();
        batch.addList(db.users.select(u => ({ id: u.id })), 'users');

        expect(() => batch.getList('users')).toThrow(/execute/i);
      });
    });

    test('rejects unknown identifiers', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        batch.addList(db.users.select(u => ({ id: u.id })), 'users');
        await batch.executeBatch();

        expect(() => batch.getList('nope')).toThrow(/nope/);
      });
    });

    test('rejects kind-mismatched lookups', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        batch.addList(db.users.select(u => ({ id: u.id })), 'users');
        batch.addCount(db.users, 'cnt');
        await batch.executeBatch();

        expect(() => batch.getItem('users')).toThrow(/list/);
        expect(() => batch.getList('cnt')).toThrow(/count/);
      });
    });

    test('is one-shot: add and executeBatch after execution throw', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        batch.addList(db.users.select(u => ({ id: u.id })), 'users');
        await batch.executeBatch();

        expect(() => batch.addList(db.users.select(u => ({ id: u.id })), 'more')).toThrow(/execute/i);
        await expect(batch.executeBatch()).rejects.toThrow(/execute/i);
      });
    });

    test('rejects executing an empty batch', async () => {
      await withDatabase(async () => {
        const batch = new QueryBatch();

        await expect(batch.executeBatch()).rejects.toThrow(/empty/i);
      });
    });

  });

  describe('nested, collection and union selections', () => {
    test('reconstructs nested-object selections identically to standalone execution (incl. Date/decimal leaves)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const buildQuery = () => db.orders
          .select(o => ({
            id: o.id,
            meta: {
              status: o.status,
              createdAt: o.createdAt,
              amount: o.totalAmount,
            },
          }))
          .orderBy(o => o.id);

        const expected = await buildQuery().toList();

        const batch = new QueryBatch();
        const key = batch.addList(buildQuery(), 'nestedOrders');
        await batch.executeBatch();
        const batched = batch.getList(key);

        expect(batched).toEqual(expected);
        expect(batched.length).toBeGreaterThan(0);
        // nested LEAVES must be revived to driver-equivalent types, not left as JSON strings
        expect(batched[0].meta.createdAt?.constructor).toBe(expected[0].meta.createdAt?.constructor);
        expect(typeof batched[0].meta.amount).toBe(typeof expected[0].meta.amount);
      });
    });

    test('nested selections through a navigation property batch identically', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const buildQuery = () => db.posts
          .select(p => ({ title: p.title, author: { name: p.user!.username } }))
          .orderBy(p => p.title);

        const expected = await buildQuery().toList();

        const batch = new QueryBatch();
        const key = batch.addList(buildQuery(), 'postsWithAuthor');
        await batch.executeBatch();

        expect(batch.getList(key)).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
      });
    });

    test('collection (json_agg lateral) selections batch identically to standalone execution', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const buildQuery = () => db.users
          .select(u => ({
            userId: u.id,
            username: u.username,
            posts: u.posts!
              .select(p => ({
                postId: p.id,
                title: p.title,
                views: p.views,
              }))
              .orderBy(p => [[p.views, 'DESC']])
              .toList('posts'),
          }))
          .orderBy(u => u.userId);

        const expected = await buildQuery().toList();

        const batch = new QueryBatch();
        const key = batch.addList(buildQuery(), 'usersWithPosts');
        await batch.executeBatch();
        const batched = batch.getList(key);

        expect(batched).toEqual(expected);
        expect(batched.length).toBeGreaterThan(0);
        expect(Array.isArray(batched[0].posts)).toBe(true);
      });
    });

    test('unionAll queries batch identically to standalone execution (order + nested projection preserved)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const buildUnion = () => db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, info: { name: u.username } }))
          .unionAll(db.users
            .where(u => eq(u.isActive, false))
            .select(u => ({ id: u.id, info: { name: u.username } })))
          .orderBy(r => r.id);

        const expected = await buildUnion().toList();

        const batch = new QueryBatch();
        const key = batch.addList(buildUnion(), 'allUsersUnion');
        const bobKey = batch.addFirstOrDefault(
          db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username })),
          'bob'
        );

        const client = (db as any).client;
        const querySpy = jest.spyOn(client, 'query');

        try {
          await batch.executeBatch();

          // the union rides the SAME single round trip as the other branch
          expect(querySpy).toHaveBeenCalledTimes(1);
        } finally {
          querySpy.mockRestore();
        }

        expect(batch.getList(key)).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
        expect(batch.getItem(bobKey)).not.toBeNull();
      });
    });

    test('timestamp column with a custom fromDriver mapper receives the driver text form, never a Date', async () => {
      // gopass-eshop regression: the app configures postgres.js with timestamp
      // parser PASSTHROUGH — the driver delivers 'YYYY-MM-DD HH:MM:SS' strings —
      // and a custom mapper turns that string into the app's date abstraction.
      // For mapper columns the batch reviver must reconstruct that text form;
      // Date-ifying ahead of the mapper breaks its string surgery (`.replace`).
      await withDatabase(async (db) => {
        await seedTestData(db);
        const bob = await db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id })).firstOrDefault();

        const instance = postgres({
          ...testConnectionConfig(),
          max: 1,
          types: {
            timestamp: { to: 1114, from: [1114], serialize: (x: string) => x, parse: (x: string) => x },
          },
        });
        const textDb = new AppDatabase(new PostgresClient(instance), { logQueries: false });

        try {
          const [inserted] = await textDb.posts.insertBulk([{
            title: 'mapper-batch-fidelity',
            userId: bob!.id,
            views: 0,
            publishTime: { hour: 9, minute: 30 },
            stringStampedAt: '2026-08-12T09:30:00',
          }]).returning();

          const buildQuery = () => textDb.posts
            .where(p => eq(p.id, inserted.id))
            .select(p => ({ id: p.id, stamp: p.stringStampedAt }));

          const expected = await buildQuery().toList();
          // standalone under the passthrough driver: the mapper's output is the ISO string
          expect(expected[0].stamp).toBe('2026-08-12T09:30:00');

          const batch = new QueryBatch();
          const key = batch.addList(buildQuery(), 'mapperStamps');
          await batch.executeBatch();

          expect(batch.getList(key)).toEqual(expected);
        } finally {
          await textDb.posts.where(p => eq(p.title, 'mapper-batch-fidelity')).delete();
          await instance.end();
        }
      });
    });
  });

  describe('type safety', () => {
    test('typed tokens flow element types to the getters', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const batch = new QueryBatch();
        const usersKey = batch.addList(db.users.select(u => ({ id: u.id, name: u.username })), 'users');
        const aliceKey = batch.addFirstOrDefault(db.users.where(u => eq(u.username, 'alice')).select(u => ({ name: u.username })), 'alice');
        const countKey = batch.addCount(db.posts, 'posts');
        await batch.executeBatch();

        // compile-time checks: these assignments fail tsc if inference breaks
        const names: string[] = batch.getList(usersKey).map(u => u.name);
        const ids: number[] = batch.getList(usersKey).map(u => u.id);
        const aliceName: string | undefined = batch.getItem(aliceKey)?.name;
        const postCount: number = batch.getCount(countKey);

        expect(names).toContain('alice');
        expect(ids.length).toBe(3);
        expect(aliceName).toBe('alice');
        expect(typeof postCount).toBe('number');
      });
    });
  });
});
