import { describe, test, expect, jest } from '@jest/globals';
import { withDatabase, seedTestData, createTestDatabase } from '../utils/test-database';
import { eq, gt, inArray, sql } from '../../src';
import { QueryBatch } from '../../src/query/query-batch';

/**
 * QueryBatch fidelity sweep — the batch transport differs from standalone
 * execution in exactly one place (rows travel as json_agg(row_to_json(...))
 * + declared-type revival instead of the driver's native protocol), so this
 * suite proves value-AND-type equality across:
 *   1. every declarable column type, with hostile values (precision-heavy
 *      numerics, padded chars, escaped text, binary, nulls),
 *   2. every query shape the SQL folding must survive (params in all clause
 *      positions, fragments, nested projections, multi-level collections,
 *      scalar array subqueries, unions, transactions, collection strategies),
 *   3. everything at once in ONE many-branch batch (cross-branch parameter
 *      renumbering under maximum offset pressure).
 */

/** Deep equality that also asserts JS-type equality on every leaf (Date stays Date, Buffer stays Buffer, string stays string). */
const expectSameShape = (batched: any, standalone: any, path = '$'): void => {
  if (standalone === null || standalone === undefined) {
    expect(batched).toBe(standalone === undefined ? undefined : null);

    return;
  }

  expect(typeof batched).toBe(typeof standalone);

  if (typeof standalone === 'object') {
    expect((batched as object).constructor).toBe((standalone as object).constructor);

    if (standalone instanceof Date) {
      expect((batched as Date).getTime()).toBe(standalone.getTime());

      return;
    }

    if (ArrayBuffer.isView(standalone)) {
      expect(Array.from(batched as Uint8Array)).toEqual(Array.from(standalone as unknown as Uint8Array));

      return;
    }

    if (Array.isArray(standalone)) {
      expect((batched as any[]).length).toBe(standalone.length);
      standalone.forEach((item, ix) => expectSameShape(batched[ix], item, `${path}[${ix}]`));

      return;
    }

    const standaloneKeys = Object.keys(standalone).sort();
    expect(Object.keys(batched).sort()).toEqual(standaloneKeys);
    for (const key of standaloneKeys) {
      expectSameShape(batched[key], (standalone as any)[key], `${path}.${key}`);
    }

    return;
  }

  expect(batched).toBe(standalone);
};

/** Runs the query standalone AND through a batch; asserts identical results including JS types. */
const expectBatchFidelity = async (buildQuery: () => any, kind: 'list' | 'first' = 'list') => {
  const standalone = kind === 'list' ? await buildQuery().toList() : await buildQuery().firstOrDefault();

  const batch = new QueryBatch();
  if (kind === 'list') {
    const key = batch.addList(buildQuery(), 'probe');
    await batch.executeBatch();
    const batched = batch.getList(key);
    expect(batched).toEqual(standalone);
    expectSameShape(batched, standalone);

    return { batched, standalone };
  }

  const key = batch.addFirstOrDefault(buildQuery(), 'probe');
  await batch.executeBatch();
  const batched = batch.getItem(key);
  expect(batched).toEqual(standalone);
  expectSameShape(batched, standalone);

  return { batched, standalone };
};

const ZOO_LABELS = ['zoo-nasty', 'zoo-edge', 'zoo-nulls'];

const seedZoo = async (db: any) => {
  await db.typeZoo.where((z: any) => inArray(z.label, ZOO_LABELS)).delete();
  await db.typeZoo.insertBulk([
    {
      label: 'zoo-nasty',
      vInteger: -2147483648,
      vSmallint: 32767,
      // beyond Number.MAX_SAFE_INTEGER — dies in JSON.parse unless textualized server-side
      vBigint: '9007199254740993',
      vDecimal: '1234567890123456.7891',
      // 19 significant digits — beyond float53, dies in JSON.parse unless textualized
      vNumeric: '0.1234567890123456789',
      vReal: 0.5,
      vDouble: 1 / 3,
      vBool: true,
      vTimestamp: new Date('2026-08-12T09:30:00.123'),
      vTimestamptz: new Date('2026-08-12T07:30:00.456Z'),
      vDate: new Date(2026, 7, 12),
      vTime: '13:45:59',
      vUuid: '3f2f2aeb-6f74-4b7d-a5b9-0c9d5a6a2f11',
      vText: 'quote " backslash \\ newline \n tab \t diacritics ěščřžý emoji 🎿 dollars $1 $99 end',
      vVarchar: 'plain-varchar',
      vChar: 'ab',
      vJson: { a: [1, 'x'], q: 'he"llo', n: null },
      vJsonb: { deep: { arr: [1, 2, { y: 'z' }] }, s: 'back\\slash' },
      vBytea: Uint8Array.from([0, 1, 2, 255, 72, 101, 108]),
    },
    {
      label: 'zoo-edge',
      vInteger: 0,
      vSmallint: -32768,
      vBigint: '0',
      vDecimal: '0.0000',
      vNumeric: '42',
      vReal: 0,
      vDouble: 6.02e23,
      vBool: false,
      vTimestamp: new Date('2000-01-01T00:00:00'),
      vTimestamptz: new Date('2000-01-01T00:00:00Z'),
      vDate: new Date(2000, 0, 1),
      vTime: '00:00:00',
      vUuid: '00000000-0000-0000-0000-000000000000',
      vText: '',
      vVarchar: '',
      vChar: '',
      vJson: [],
      vJsonb: {},
      vBytea: new Uint8Array(0),
    },
    {
      label: 'zoo-nulls',
    },
  ]);
};

describe('QueryBatch fidelity sweep', () => {
  describe('type matrix', () => {
    test('every declarable column type survives the batch with identical values AND JS types', async () => {
      await withDatabase(async (db) => {
        await seedZoo(db);

        // whole-entity selection — every column at once
        await expectBatchFidelity(() => db.typeZoo
          .where(z => inArray(z.label, ZOO_LABELS))
          .select(z => z)
          .orderBy(z => z.label));

        // explicit projection of the hazard columns
        await expectBatchFidelity(() => db.typeZoo
          .where(z => inArray(z.label, ZOO_LABELS))
          .select(z => ({
            label: z.label,
            big: z.vBigint,
            dec: z.vDecimal,
            num: z.vNumeric,
            real: z.vReal,
            dbl: z.vDouble,
            ts: z.vTimestamp,
            tstz: z.vTimestamptz,
            d: z.vDate,
            t: z.vTime,
            ch: z.vChar,
            j: z.vJson,
            jb: z.vJsonb,
            bin: z.vBytea,
          }))
          .orderBy(z => z.label));
      });
    });

    test('hazard types survive inside NESTED projections (revival targets flat path aliases)', async () => {
      await withDatabase(async (db) => {
        await seedZoo(db);

        await expectBatchFidelity(() => db.typeZoo
          .where(z => inArray(z.label, ZOO_LABELS))
          .select(z => ({
            label: z.label,
            numbers: { big: z.vBigint, dec: z.vDecimal, num: z.vNumeric },
            moments: { ts: z.vTimestamp, tstz: z.vTimestamptz, d: z.vDate },
            payload: { bin: z.vBytea, j: z.vJsonb },
          }))
          .orderBy(z => z.label));
      });
    });
  });

  describe('query-shape matrix', () => {
    test('parameters in every clause position (where + inArray + orderBy + limit + offset)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expectBatchFidelity(() => db.posts
          .where(p => gt(p.views, 50))
          .select(p => ({ id: p.id, title: p.title, views: p.views }))
          .orderBy(p => [[p.views, 'DESC']])
          .limit(2)
          .offset(1));
      });
    });

    test('two-level nested projection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expectBatchFidelity(() => db.orders
          .select(o => ({
            id: o.id,
            outer: {
              status: o.status,
              inner: { amount: o.totalAmount, createdAt: o.createdAt },
            },
          }))
          .orderBy(o => o.id));
      });
    });

    test('two-level nested collections (users → posts → comments)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expectBatchFidelity(() => db.users
          .select(u => ({
            userId: u.id,
            posts: u.posts!
              .select(p => ({
                postId: p.id,
                comments: p.postComments!
                  .select(c => ({ commentId: c.id, body: c.comment }))
                  .orderBy(c => c.commentId)
                  .toList('comments'),
              }))
              .orderBy(p => p.postId)
              .toList('posts'),
          }))
          .orderBy(u => u.userId));
      });
    });

    test('scalar array subquery (toNumberList)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expectBatchFidelity(() => db.users
          .select(u => ({
            userId: u.id,
            postIds: u.posts!.select(p => ({ id: p.id })).toNumberList(),
          }))
          .orderBy(u => u.userId));
      });
    });

    test('SqlFragment in selection and where', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expectBatchFidelity(() => db.posts
          .where(p => sql`${p.views} > ${10}`)
          .select(p => ({ id: p.id, bumped: sql`${p.views} + ${5}` }))
          .orderBy(p => p.id));
      });
    });

    test('dollar-digit sequences inside SQL string literals survive cross-branch renumbering', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // The literal '$1' lives INSIDE a quoted SQL string. Branch offsets must
        // renumber only real placeholders, never quoted text — otherwise the
        // second branch would silently return \"price: $<1+offset>\".
        const buildTagged = () => db.posts
          .where(p => gt(p.views, 10))
          .select(p => ({ id: p.id, tag: sql`'price: $1 fixed'` }))
          .orderBy(p => p.id);
        const buildPadding = () => db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({ id: u.id, name: u.username }))
          .orderBy(u => u.id);

        const expectedTagged = await buildTagged().toList();
        const expectedPadding = await buildPadding().toList();

        const batch = new QueryBatch();
        // padding branch FIRST so the literal-carrying branch gets a nonzero offset
        const paddingKey = batch.addList(buildPadding(), 'padding');
        const taggedKey = batch.addList(buildTagged(), 'tagged');
        await batch.executeBatch();

        expect(batch.getList(paddingKey)).toEqual(expectedPadding);
        expect(batch.getList(taggedKey)).toEqual(expectedTagged);
      });
    });

    test('same table registered twice with different filters', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const buildActive = () => db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id })).orderBy(u => u.id);
        const buildInactive = () => db.users.where(u => eq(u.isActive, false)).select(u => ({ id: u.id })).orderBy(u => u.id);

        const expectedActive = await buildActive().toList();
        const expectedInactive = await buildInactive().toList();

        const batch = new QueryBatch();
        const activeKey = batch.addList(buildActive(), 'active');
        const inactiveKey = batch.addList(buildInactive(), 'inactive');
        await batch.executeBatch();

        expect(batch.getList(activeKey)).toEqual(expectedActive);
        expect(batch.getList(inactiveKey)).toEqual(expectedInactive);
      });
    });

    test('union with nested projection AND collection laterals (dashboard tickets shape)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expectBatchFidelity(() => db.users
          .where(u => eq(u.isActive, true))
          .select(u => ({
            id: u.id,
            info: { name: u.username },
            posts: u.posts!.select(p => ({ pid: p.id, views: p.views })).orderBy(p => p.pid).toList('posts'),
          }))
          .unionAll(db.users
            .where(u => eq(u.isActive, false))
            .select(u => ({
              id: u.id,
              info: { name: u.username },
              posts: u.posts!.select(p => ({ pid: p.id, views: p.views })).orderBy(p => p.pid).toList('posts'),
            })))
          .orderBy((r: any) => r.id));
      });
    });

    test('batch inside a transaction (shared executor)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await db.transaction(async (trx: any) => {
          const buildQuery = () => trx.users.where((u: any) => eq(u.isActive, true)).select((u: any) => ({ id: u.id, name: u.username })).orderBy((u: any) => u.id);
          const expected = await buildQuery().toList();

          const batch = new QueryBatch();
          const key = batch.addList(buildQuery(), 'txUsers');
          const countKey = batch.addCount(trx.posts.where((p: any) => gt(p.views, 0)), 'txCount');
          await batch.executeBatch();

          expect(batch.getList(key)).toEqual(expected);
          expect(batch.getCount(countKey)).toBeGreaterThan(0);
        });
      });
    });

    test('collection strategies: cte and lateral produce identical batched results', async () => {
      await withDatabase(async (db) => {
        // seed ONCE via the managed context; the strategy variants share the database
        await seedTestData(db);

        for (const strategy of ['cte', 'lateral'] as const) {
          const strategyDb = createTestDatabase({ collectionStrategy: strategy });

          await expectBatchFidelity(() => strategyDb.users
            .select(u => ({
              userId: u.id,
              posts: u.posts!.select(p => ({ pid: p.id })).orderBy(p => p.pid).toList('posts'),
            }))
            .orderBy(u => u.userId));
        }
      });
    });

    test('empty-result branches revive cleanly next to non-empty ones', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);
        await seedZoo(db);

        const buildEmpty = () => db.typeZoo.where(z => eq(z.label, 'zoo-does-not-exist')).select(z => z);
        const buildFull = () => db.typeZoo.where(z => eq(z.label, 'zoo-nasty')).select(z => z);

        const expectedFull = await buildFull().toList();

        const batch = new QueryBatch();
        const emptyKey = batch.addList(buildEmpty(), 'empty');
        const fullKey = batch.addFirstOrDefault(buildFull(), 'full');
        const missingKey = batch.addFirstOrDefault(buildEmpty(), 'missing');
        await batch.executeBatch();

        expect(batch.getList(emptyKey)).toEqual([]);
        expect(batch.getItem(missingKey)).toBeNull();
        expect(batch.getItem(fullKey)).toEqual(expectedFull[0]);
        expectSameShape(batch.getItem(fullKey), expectedFull[0]);
      });
    });
  });

  describe('kitchen sink', () => {
    test('a dozen heterogeneous branches in ONE round trip, every result identical to standalone', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);
        await seedZoo(db);

        const builders: Record<string, () => any> = {
          zooWhole: () => db.typeZoo.where(z => inArray(z.label, ZOO_LABELS)).select(z => z).orderBy(z => z.label),
          zooNested: () => db.typeZoo.where(z => eq(z.label, 'zoo-nasty')).select(z => ({ nums: { big: z.vBigint, num: z.vNumeric }, bin: z.vBytea })),
          postsParams: () => db.posts.where(p => gt(p.views, 50)).select(p => ({ id: p.id, views: p.views })).orderBy(p => [[p.views, 'DESC']]).limit(2),
          ordersNested: () => db.orders.select(o => ({ id: o.id, meta: { amount: o.totalAmount, at: o.createdAt } })).orderBy(o => o.id),
          usersCollections: () => db.users.select(u => ({ uid: u.id, posts: u.posts!.select(p => ({ pid: p.id })).orderBy(p => p.pid).toList('posts') })).orderBy(u => u.uid),
          usersNumberList: () => db.users.select(u => ({ uid: u.id, postIds: u.posts!.select(p => ({ id: p.id })).toNumberList() })).orderBy(u => u.uid),
          fragments: () => db.posts.where(p => sql`${p.views} > ${20}`).select(p => ({ id: p.id, bumped: sql`${p.views} + ${100}` })).orderBy(p => p.id),
          wholeUsers: () => db.users.where(u => eq(u.isActive, true)).select(u => u).orderBy(u => u.id),
          unionMixed: () => db.users.where(u => eq(u.isActive, true)).select(u => ({ id: u.id, info: { name: u.username } }))
            .unionAll(db.users.where(u => eq(u.isActive, false)).select(u => ({ id: u.id, info: { name: u.username } })))
            .orderBy((r: any) => r.id),
          emptyBranch: () => db.typeZoo.where(z => eq(z.label, 'zoo-does-not-exist')).select(z => ({ id: z.id })),
        };

        const expected: Record<string, any> = {};
        for (const [name, build] of Object.entries(builders)) {
          expected[name] = await build().toList();
        }
        const expectedBob = await db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username })).firstOrDefault();
        const expectedCount = await db.posts.where(p => gt(p.views, 0)).count();

        const batch = new QueryBatch();
        const keys: Record<string, any> = {};
        for (const [name, build] of Object.entries(builders)) {
          keys[name] = batch.addList(build(), name);
        }
        const bobKey = batch.addFirstOrDefault(db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username })), 'bob');
        const countKey = batch.addCount(db.posts.where(p => gt(p.views, 0)), 'postCount');

        const client = (db as any).client;
        const querySpy = jest.spyOn(client, 'query');

        try {
          await batch.executeBatch();

          expect(querySpy).toHaveBeenCalledTimes(1);
        } finally {
          querySpy.mockRestore();
        }

        for (const [name] of Object.entries(builders)) {
          expect(batch.getList(keys[name])).toEqual(expected[name]);
          expectSameShape(batch.getList(keys[name]), expected[name]);
        }
        expect(batch.getItem(bobKey)).toEqual(expectedBob);
        expect(batch.getCount(countKey)).toBe(expectedCount);
      });
    });
  });
});
