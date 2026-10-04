import { describe, test, expect, jest } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { DbCteBuilder, QueryBatch, agg, coalesce, eq, gt, gte, literal, sql } from '../../src';
import type { SqlFragment } from '../../src';
import type { AppDatabase } from '../../debug/schema/appDatabase';
import type { HourMinute } from '../../debug/types/hour-minute';

/**
 * List / distinct aggregates over the grouped ROW (1.0.31): `g.arrayAgg(r => r.col, { orderBy })` and
 * `g.countDistinct(r => r.col)`, beside `g.count()` / `sum` / `min` / `max` / `avg`.
 *
 * `agg.arrayAgg(...)` in a grouped select could read the grouping KEY only (`g.key`). The members of a group
 * — "which price ids collapse into this definition, and how many distinct seasons are among them" — had no
 * fluent form: a column of the grouped row inside `agg.arrayAgg()` named a table the grouped statement does
 * not have once it groups by an expression (42P01 `missing FROM-clause entry`), so callers loaded the rows
 * and folded them in JS.
 *
 * The shape below groups product prices by TWO sorted id-list signatures — the capacity groups a price is
 * sold to, and the tags of its product — each a scalar `agg.arrayAgg(… ORDER BY …)` subquery, i.e. an
 * array-valued grouping key (the grouped statement then reads a subquery that computes the keys once).
 *
 *   price        product      season  capacity groups   product tags
 *   hardback1    Hardback     1       {adult, child}    {winter, family}
 *   hardback2    Hardback     2       {adult}           {winter, family}
 *   hardback3    Hardback     3       {adult}           {winter, family}     (added here)
 *   hardback4    Hardback     2       {}                {winter, family}     (added here)
 *   lift1        Lift Ticket  1       {senior}          {summer}
 *   lift2        Lift Ticket  1       {senior}          {summer}             (added here)
 */
describe('grouped list / distinct aggregates over the grouped row', () => {
  const seedPrices = async (db: AppDatabase) => {
    const seeded = await seedTestData(db);
    const { products, capacityGroups, productPrices } = seeded;
    const [hardback3, hardback4, lift2] = await db.productPrices.insertBulk([
      { productId: products.hardback.id, seasonId: 3, price: 60 },
      { productId: products.hardback.id, seasonId: 2, price: 55 },
      { productId: products.liftTicket.id, seasonId: 1, price: 80 },
    ]).returning();

    await db.productPriceCapacityGroups.insertBulk([
      { productPriceId: hardback3.id, capacityGroupId: capacityGroups.adultGroup.id },
      { productPriceId: lift2.id, capacityGroupId: capacityGroups.seniorGroup.id },
    ]);

    return {
      ...seeded,
      prices: {
        hardback1: productPrices.hardbackPrice1, hardback2: productPrices.hardbackPrice2, hardback3, hardback4,
        lift1: productPrices.liftTicketPrice1, lift2,
      },
    };
  };

  /** The sorted capacity-group ids of a price — an array-valued expression of the row. */
  const capacitySignature = (db: AppDatabase, p: any) => coalesce(
    db.productPriceCapacityGroups
      .where(l => eq(l.productPriceId, p.id))
      .select(l => agg.arrayAgg(l.capacityGroupId, { orderBy: [[l.capacityGroupId, 'ASC']] }))
      .asSubquery('scalar'),
    literal('{}', 'integer[]'),
  ) as unknown as SqlFragment<number[]>;

  /** The sorted tag ids of a price's product. */
  const tagSignature = (db: AppDatabase, p: any) => coalesce(
    db.productTags
      .where(t => eq(t.productId, p.productId))
      .select(t => agg.arrayAgg(t.tagId, { orderBy: [[t.tagId, 'ASC']] }))
      .asSubquery('scalar'),
    literal('{}', 'integer[]'),
  ) as unknown as SqlFragment<number[]>;

  /** Prices grouped by both signatures: the members of each definition, ordered, and their distinct seasons. */
  const definitions = (db: AppDatabase, minPrice = 0) => db.productPrices
    .where(p => gte(p.price, minPrice))
    .select(p => ({
      id: p.id,
      seasonId: p.seasonId,
      price: p.price,
      capacityIds: capacitySignature(db, p),
      tagIds: tagSignature(db, p),
    }))
    .groupBy(r => ({ capacityIds: r.capacityIds, tagIds: r.tagIds }))
    .select(g => ({
      ...g.key,
      priceIds: g.arrayAgg(r => r.id, { orderBy: [[r => r.id, 'ASC']] }),
      newestFirst: g.arrayAgg(r => r.id, { orderBy: [[r => r.seasonId, 'DESC'], [r => r.id, 'DESC']] }),
      // an expression of the row as the operand, and a key as the operand
      doubledSeasons: g.arrayAgg(r => sql<number>`${r.seasonId} * 2`, { orderBy: [[r => r.id, 'ASC']] }),
      signatures: g.countDistinct(r => r.capacityIds),
      seasons: g.countDistinct(r => r.seasonId),
      members: g.count(),
      firstId: g.min(r => r.id),
      cheapest: g.min(r => r.price),
      total: g.sum(r => r.price),
    }))
    .orderBy(r => r.firstId);

  test('prices grouped by two sorted id-list signatures: member ids (ordered) and a distinct count per group', async () => {
    await withDatabase(async (db) => {
      const { prices, capacityGroups, tags } = await seedPrices(db);
      const sorted = (...ids: number[]) => [...ids].sort((a, b) => a - b);
      const hardbackTags = sorted(tags.winterTag.id, tags.familyTag.id);

      const rows = await definitions(db).toList();

      expect(rows).toEqual([
        {
          capacityIds: sorted(capacityGroups.adultGroup.id, capacityGroups.childGroup.id),
          tagIds: hardbackTags,
          priceIds: [prices.hardback1.id],
          newestFirst: [prices.hardback1.id],
          doubledSeasons: [2],
          signatures: 1,
          seasons: 1,
          members: 1,
          firstId: prices.hardback1.id,
          cheapest: 100,
          total: 100,
        },
        {
          capacityIds: [capacityGroups.adultGroup.id],
          tagIds: hardbackTags,
          priceIds: [prices.hardback2.id, prices.hardback3.id],
          newestFirst: [prices.hardback3.id, prices.hardback2.id],
          doubledSeasons: [4, 6],
          signatures: 1,
          seasons: 2,
          members: 2,
          firstId: prices.hardback2.id,
          cheapest: 50,
          total: 110,
        },
        {
          capacityIds: [capacityGroups.seniorGroup.id],
          tagIds: [tags.summerTag.id],
          priceIds: [prices.lift1.id, prices.lift2.id],
          newestFirst: [prices.lift2.id, prices.lift1.id],
          doubledSeasons: [2, 2],
          signatures: 1,
          // two members, ONE season: a distinct count, not a count
          seasons: 1,
          members: 2,
          firstId: prices.lift1.id,
          cheapest: 75,
          total: 155,
        },
        {
          // an empty signature is a key like any other
          capacityIds: [],
          tagIds: hardbackTags,
          priceIds: [prices.hardback4.id],
          newestFirst: [prices.hardback4.id],
          doubledSeasons: [4],
          signatures: 1,
          seasons: 1,
          members: 1,
          firstId: prices.hardback4.id,
          cheapest: 55,
          total: 55,
        },
      ]);

      // number[] of numbers, as the driver reads an integer[]
      for (const row of rows) {
        expect(Array.isArray(row.priceIds)).toBe(true);
        expect(row.priceIds.every(id => typeof id === 'number')).toBe(true);
        expect(typeof row.seasons).toBe('number');
      }

      // the statement reads the grouped row from the subquery that computes the keys
      const statement = definitions(db).future().getSql().replace(/\s+/g, ' ');

      // (json_agg on a driver without native array results — the Bun client's binary protocol)
      expect(statement).toMatch(/(array_agg|json_agg)\("q1"\."__arg0" ORDER BY "q1"\."__arg0" ASC\) as "priceIds"/);
      expect(statement).toContain('count(DISTINCT "q1"."__arg1") as "seasons"');
      expect(statement).toContain('GROUP BY "capacityIds", "tagIds"');
    });
  });

  test('no rows: no groups; first row, count and a HAVING over the distinct count', async () => {
    await withDatabase(async (db) => {
      const { prices } = await seedPrices(db);

      expect(await definitions(db, 1000).toList()).toEqual([]);
      expect(await definitions(db, 1000).firstOrDefault()).toBeNull();
      expect(await definitions(db).futureCount().execute()).toBe(4);
      expect((await definitions(db).firstOrDefault())?.priceIds).toEqual([prices.hardback1.id]);

      // the groups whose members span more than one season
      const spanning = await db.productPrices
        .select(p => ({ id: p.id, seasonId: p.seasonId, capacityIds: capacitySignature(db, p), tagIds: tagSignature(db, p) }))
        .groupBy(r => ({ capacityIds: r.capacityIds, tagIds: r.tagIds }))
        .having(g => gt(g.countDistinct(r => r.seasonId), 1))
        .select(g => ({ priceIds: g.arrayAgg(r => r.id, { orderBy: [[r => r.id, 'DESC']] }), seasons: g.countDistinct(r => r.seasonId) }))
        .toList();

      expect(spanning).toEqual([{ priceIds: [prices.hardback3.id, prices.hardback2.id], seasons: 2 }]);
    });
  });

  test('as a QueryBatch member: the lists and the counts of the standalone read, in the batch\'s one statement', async () => {
    await withDatabase(async (db) => {
      await seedPrices(db);

      const expected = await definitions(db).toList();

      expect(expected).toHaveLength(4);

      const batch = new QueryBatch();
      const groups = batch.addList(definitions(db), 'definitions');
      const first = batch.addFirstOrDefault(definitions(db, 70), 'first');
      const groupCount = batch.addCount(definitions(db), 'groupCount');
      const products = batch.addCount(db.products, 'products');
      const querySpy = jest.spyOn((db as any).client, 'query');

      try {
        await batch.executeBatch();

        expect(querySpy).toHaveBeenCalledTimes(1);
      } finally {
        querySpy.mockRestore();
      }

      expect(batch.getList(groups)).toEqual(expected);
      expect(batch.getItem(first)).toEqual(await definitions(db, 70).firstOrDefault());
      expect(batch.getCount(groupCount)).toBe(4);
      expect(batch.getCount(products)).toBe(2);
      expect(await definitions(db).future().execute()).toEqual(expected);
    });
  });

  test('grouping by plain columns: a navigation\'s column, DISTINCT, an expression, a key as the operand', async () => {
    await withDatabase(async (db) => {
      const { prices, products } = await seedPrices(db);

      const perProduct = await db.productPrices
        .select(p => ({ id: p.id, productId: p.productId, seasonId: p.seasonId, price: p.price, productName: p.product!.name }))
        .groupBy(r => ({ productId: r.productId }))
        .select(g => ({
          productId: g.key.productId,
          names: g.arrayAgg(r => r.productName, { distinct: true }),
          seasonIds: g.arrayAgg(r => r.seasonId, { distinct: true, orderBy: [[r => r.seasonId, 'DESC']] }),
          priceIds: g.arrayAgg(r => r.id, { orderBy: [r => r.id] }),
          doubled: g.arrayAgg(r => sql<number>`${r.seasonId} * 2`, { orderBy: [[r => r.id, 'ASC']] }),
          seasons: g.countDistinct(r => r.seasonId),
          products: g.countDistinct(r => r.productId),
          spread: sql<number>`${g.countDistinct(r => r.seasonId)} + ${g.count()}`.mapWith(Number),
          members: g.count(),
        }))
        .orderBy(r => r.productId)
        .toList();

      expect(perProduct).toEqual([
        {
          productId: products.hardback.id,
          names: ['Hardback'],
          seasonIds: [3, 2, 1],
          priceIds: [prices.hardback1.id, prices.hardback2.id, prices.hardback3.id, prices.hardback4.id],
          doubled: [2, 4, 6, 4],
          seasons: 3,
          products: 1,
          spread: 7,
          members: 4,
        },
        {
          productId: products.liftTicket.id,
          names: ['Lift Ticket'],
          seasonIds: [1],
          priceIds: [prices.lift1.id, prices.lift2.id],
          doubled: [2, 2],
          seasons: 1,
          products: 1,
          spread: 3,
          members: 2,
        },
      ]);

      // the entity row itself: the operand reaches a navigation the grouped row does not project
      const byEntity = await db.productPrices
        .select(p => p)
        .groupBy(p => ({ productId: p.productId }))
        .select(g => ({
          productId: g.key.productId,
          names: g.arrayAgg(p => p.product!.name, { distinct: true }),
          ids: g.arrayAgg(p => p.id, { orderBy: [[p => p.price, 'DESC']] }),
        }))
        .orderBy(r => r.productId)
        .toList();

      expect(byEntity).toEqual([
        { productId: products.hardback.id, names: ['Hardback'], ids: [prices.hardback1.id, prices.hardback3.id, prices.hardback4.id, prices.hardback2.id] },
        { productId: products.liftTicket.id, names: ['Lift Ticket'], ids: [prices.lift2.id, prices.lift1.id] },
      ]);
    });
  });

  test('the elements of a mapped column read through its mapper, over plain and expression keys', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);
      const at = (hour: number, minute: number): HourMinute => ({ hour, minute });
      const jan15 = new Date('2024-01-15T10:00:00Z');
      const jan16 = new Date('2024-01-16T10:00:00Z');

      const perAuthor = await db.posts
        .select(p => ({ userId: p.userId, publishTime: p.publishTime, customDate: p.customDate }))
        .groupBy(r => ({ userId: r.userId }))
        .select(g => ({
          userId: g.key.userId,
          times: g.arrayAgg(r => r.publishTime, { orderBy: [[r => r.publishTime, 'DESC']] }),
          days: g.arrayAgg(r => r.customDate, { distinct: true, orderBy: [[r => r.customDate, 'ASC']] }),
          distinctDays: g.countDistinct(r => r.customDate),
        }))
        .orderBy(r => r.userId)
        .toList();

      expect<unknown>(perAuthor).toEqual([
        { userId: users.alice.id, times: [at(14, 0), at(9, 30)], days: [jan15, jan16], distinctDays: 2 },
        { userId: users.bob.id, times: [at(18, 45)], days: [jan15], distinctDays: 1 },
      ]);

      const byHundredViews = await db.posts
        .select(p => ({ bucket: sql<number>`${p.views} / 100`, publishTime: p.publishTime, userId: p.userId }))
        .groupBy(r => ({ bucket: r.bucket }))
        .select(g => ({
          bucket: g.key.bucket,
          times: g.arrayAgg(r => r.publishTime, { orderBy: [[r => r.publishTime, 'ASC']] }),
          authors: g.countDistinct(r => r.userId),
        }))
        .orderBy(r => r.bucket)
        .toList();

      expect<unknown>(byHundredViews).toEqual([
        { bucket: 1, times: [at(9, 30), at(14, 0)], authors: 1 },
        { bucket: 2, times: [at(18, 45)], authors: 1 },
      ]);
    });
  });

  // postgres.js hands an unquoted NULL element of a native array to the element's parser ('NULL', NaN) — for every
  // array it reads, `agg.arrayAgg()`'s too; the other drivers and the engines read it as null
  test.skipIf(process.env.LINKGRESS_TEST_DRIVER === 'postgres')('NULL values are elements of the list, and no distinct values', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);
      const at = (hour: number, minute: number): HourMinute => ({ hour, minute });

      await db.posts.insertBulk([{ title: 'Untimed', content: 'no publish time', userId: users.bob.id, views: 1 }]);

      const perAuthor = await db.posts
        .select(p => ({ userId: p.userId, publishTime: p.publishTime, customDate: p.customDate, subtitle: p.subtitle }))
        .groupBy(r => ({ userId: r.userId }))
        .select(g => ({
          userId: g.key.userId,
          times: g.arrayAgg(r => r.publishTime, { orderBy: [[r => r.publishTime, 'DESC']] }),
          days: g.countDistinct(r => r.customDate),
          subtitles: g.arrayAgg(r => r.subtitle),
          withSubtitle: g.countDistinct(r => r.subtitle),
        }))
        .orderBy(r => r.userId)
        .toList();

      expect<unknown>(perAuthor).toEqual([
        { userId: users.alice.id, times: [at(14, 0), at(9, 30)], days: 2, subtitles: [null, null], withSubtitle: 0 },
        // PostgreSQL sorts NULL first in a descending order
        { userId: users.bob.id, times: [null, at(18, 45)], days: 1, subtitles: [null, null], withSubtitle: 0 },
      ]);

      // the same over an expression key (the subquery form)
      const byDay = await db.posts
        .select(p => ({ day: sql<number>`${p.views} / 100`, publishTime: p.publishTime, userId: p.userId }))
        .groupBy(r => ({ day: r.day }))
        .select(g => ({
          day: g.key.day,
          times: g.arrayAgg(r => r.publishTime, { orderBy: [[r => r.publishTime, 'ASC']] }),
          authors: g.countDistinct(r => r.userId),
        }))
        .orderBy(r => r.day)
        .toList();

      expect<unknown>(byDay).toEqual([
        { day: 0, times: [null], authors: 1 },
        { day: 1, times: [at(9, 30), at(14, 0)], authors: 1 },
        { day: 2, times: [at(18, 45)], authors: 1 },
      ]);
    });
  });

  test('as a CTE body and as a joined table subquery: the lists keep their element mappers, the count its number', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);
      const at = (hour: number, minute: number): HourMinute => ({ hour, minute });
      const perAuthor = () => db.posts
        .select(p => ({ id: p.id, userId: p.userId, publishTime: p.publishTime, views: p.views }))
        .groupBy(r => ({ userId: r.userId }))
        .select(g => ({
          userId: g.key.userId,
          times: g.arrayAgg(r => r.publishTime, { orderBy: [[r => r.publishTime, 'ASC']] }),
          postIds: g.arrayAgg(r => r.id, { orderBy: [[r => r.id, 'DESC']] }),
          viewCounts: g.countDistinct(r => r.views),
        }));
      const alice = { times: [at(9, 30), at(14, 0)], viewCounts: 2 };
      const bob = { times: [at(18, 45)], viewCounts: 1 };

      const builder = new DbCteBuilder();
      const cte = builder.with('per_author', perAuthor());
      const fromCte = await db.selectFromCte(cte.cte)
        .select(r => ({ userId: r.userId, times: r.times, viewCounts: r.viewCounts, posts: r.postIds }))
        .orderBy(r => r.userId)
        .toList();

      expect<unknown>(fromCte.map(({ posts, ...row }) => ({ ...row, posts: posts.length }))).toEqual([
        { userId: users.alice.id, ...alice, posts: 2 },
        { userId: users.bob.id, ...bob, posts: 1 },
      ]);

      const joined = await db.users
        .leftJoin(perAuthor().asSubquery('table'), (u, g) => eq(u.id, g.userId), (u, g) => ({ id: u.id, times: g.times, viewCounts: g.viewCounts }), 'g')
        .orderBy(r => r.id)
        .toList();

      expect<unknown>(joined).toEqual([
        { id: users.alice.id, ...alice },
        { id: users.bob.id, ...bob },
        { id: users.charlie.id, times: null, viewCounts: null },
      ]);
    });
  });

  test('what a selector may return: a column or an expression of the grouped row', async () => {
    await withDatabase(async (db) => {
      const grouped = () => db.productPrices
        .select(p => ({ id: p.id, productId: p.productId }))
        .groupBy(r => ({ productId: r.productId }));

      expect(() => grouped().select(g => ({ ids: g.arrayAgg((() => 5) as any) })).future())
        .toThrow('g.arrayAgg(): the selector returned the constant 5 — it must return a column or an sql expression of the grouped row.');
      expect(() => grouped().select(g => ({ n: g.countDistinct((r: any) => r.missing) })).future())
        .toThrow(/g\.countDistinct\(\): the selector returned undefined/);
      expect(() => grouped().select(g => ({ ids: g.arrayAgg(r => r.id, { orderBy: [[(() => 'x') as any, 'ASC']] }) })).future())
        .toThrow(/g\.arrayAgg\(\): an ORDER BY key: the selector returned the constant "x"/);
      expect(() => grouped().select(g => ({ ids: g.arrayAgg(r => r.id, { orderBy: [[r => r.id, 'UP' as any]] }) })).future())
        .toThrow(/an ORDER BY direction is 'ASC' or 'DESC'/);
      expect(() => grouped().select(g => ({ ids: g.arrayAgg((() => g.count()) as any) })).future())
        .toThrow(/aggregate function calls cannot be nested/);
      expect(() => grouped().select(g => ({ ids: g.arrayAgg('id' as any) })).future())
        .toThrow(/g\.arrayAgg\(\): expected a selector of the grouped row/);
    });
  });
});
