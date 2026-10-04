import { describe, test, expect, jest } from 'bun:test';
import { withDatabase, seedTestData } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import {
  DbCteBuilder, FutureCountQuery, FutureQueryRunner, FutureSingleQuery, QueryBatch, and, eq, gt, gte, inSubquery, literal, sql,
} from '../../src';

/**
 * Two CTE-visibility gaps, both surfaced by a discount-badge read
 * where the security-critical visibility gate had to be
 * evaluated ONCE behind a MATERIALIZED fence and then read by both legs of a
 * `unionAll(...).count()`:
 *
 *   1. `UnionQueryBuilder` let each leg render its own `WITH` prefix and then
 *      wrapped every leg in parentheses, so a CTE attached to leg 1 landed
 *      INSIDE `(WITH x AS (...) SELECT ...)`. Leg 2 could not see it and the
 *      statement died with SQLSTATE 42P01, `relation "x" does not exist`.
 *      The CTEs are now hoisted to statement level (deduplicated by name).
 *
 *   2. `count()` / `exists()` / `futureCount()` build through
 *      `buildAggregateQuery`, which emitted no `WITH` clause at all — so
 *      `.with(cte).where(<references cte>).count()` failed the same way even
 *      without a union.
 *
 * The CTE below is deliberately parameterized (`age > 30`) and the second leg
 * carries a parameter of its own (`views > 150`), because hoisting is only
 * correct if the CTE's params occupy the OPENING slots of the statement:
 * `DbCte` bodies carry placeholders numbered from $1.
 */
describe('CTE visibility across UNION legs and aggregate wrappers', () => {
  // alice(25, active), bob(35, active), charlie(45, inactive);
  // posts: alice x2 (views 100, 150), bob x1 (views 200).
  const olderUsersCte = (db: any, cteBuilder: DbCteBuilder) => cteBuilder.with(
    'older_users',
    db.users.where((u: any) => gt(u.age, 30)).select((u: any) => ({ id: u.id })),
    { materialized: true }
  );

  test('a CTE attached to one UNION leg is readable by every leg', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsersCte(db, cteBuilder);
      const ou = older.cte.as('ou');

      const rows = await db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .where(p => and(sql`${p.userId} IN (SELECT ${ou.id} FROM ${ou})`, gt(p.views, 150)))
          .select(p => ({ id: p.id })))
        .toList();

      // bob + charlie from leg 1, bob's 200-view post from leg 2.
      expect(rows).toHaveLength(3);
    });
  });

  test('the hoisted WITH is emitted once, at statement level, keeping MATERIALIZED', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsersCte(db, cteBuilder);
      const ou = older.cte.as('ou');

      const { sql: builtSql, params } = db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .where(p => and(sql`${p.userId} IN (SELECT ${ou.id} FROM ${ou})`, gt(p.views, 150)))
          .select(p => ({ id: p.id })))
        .buildSql();

      // Statement level, not inside a leg's parentheses.
      expect(builtSql.startsWith('WITH "older_users" AS MATERIALIZED (')).toBe(true);
      expect(builtSql).not.toContain('(WITH ');
      // Declared once. (`"older_users" AS` on its own also matches the `FROM
      // "older_users" AS "ou"` reference each leg makes, so match the declaration.)
      expect(builtSql.split('"older_users" AS MATERIALIZED (').length - 1).toBe(1);
      expect(builtSql).toContain('UNION ALL');

      // The CTE's parameter takes $1; the second leg's own parameter follows.
      expect(params).toEqual([30, 150]);
    });
  });

  test('unionAll(...).count() counts through the hoisted CTE', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsersCte(db, cteBuilder);
      const ou = older.cte.as('ou');

      const total = await db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .where(p => and(sql`${p.userId} IN (SELECT ${ou.id} FROM ${ou})`, gt(p.views, 150)))
          .select(p => ({ id: p.id })))
        .count();

      expect(total).toBe(3);
    });
  });

  test('the same CTE attached to SEVERAL legs is declared exactly once', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsersCte(db, cteBuilder);
      const ou = older.cte.as('ou');

      const union = db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .with(older.cte)
          .where(p => and(sql`${p.userId} IN (SELECT ${ou.id} FROM ${ou})`, gt(p.views, 150)))
          .select(p => ({ id: p.id })));

      const { sql: builtSql, params } = union.buildSql();

      expect(builtSql.split('"older_users" AS MATERIALIZED (').length - 1).toBe(1);
      // Deduplicated: the CTE contributes its parameter ONCE, not once per leg.
      expect(params).toEqual([30, 150]);
      expect(await union.count()).toBe(3);
    });
  });

  test('a union with no attached CTE is unchanged (no stray WITH)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const { sql: builtSql } = db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({ id: u.id }))
        .unionAll(db.posts.select(p => ({ id: p.id })))
        .buildSql();

      expect(builtSql).not.toContain('WITH ');
      expect(builtSql.startsWith('(SELECT')).toBe(true);
    });
  });

  test('.with(cte).count() carries the WITH clause', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsersCte(db, cteBuilder);
      const ou = older.cte.as('ou');

      const built = db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .futureCount() as unknown as { _sql: string; _params: unknown[] };

      expect(built._sql.startsWith('WITH "older_users" AS MATERIALIZED (')).toBe(true);

      const total = await db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .count();

      // bob + charlie
      expect(total).toBe(2);
    });
  });

  test('.with(cte).exists() carries the WITH clause', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsersCte(db, cteBuilder);
      const ou = older.cte.as('ou');

      const anyOlder = await db.users
        .with(older.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .exists();

      expect(anyOlder).toBe(true);

      const noneCteBuilder = new DbCteBuilder();
      const none = noneCteBuilder.with(
        'impossible_users',
        db.users.where(u => gt(u.age, 500)).select(u => ({ id: u.id })),
        { materialized: true }
      );
      const nu = none.cte.as('nu');

      const anyImpossible = await db.users
        .with(none.cte)
        .where(u => sql`${u.id} IN (SELECT ${nu.id} FROM ${nu})`)
        .exists();

      expect(anyImpossible).toBe(false);
    });
  });

  test('two DIFFERENT CTEs sharing one name are refused, not silently deduplicated', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Same name, different body: leg 1 fences `age > 30`, leg 2 `age > 40`. A
      // dedupe keyed on the NAME alone would drop leg 2's declaration AND its
      // parameter, so leg 2 would read leg 1's rows and every later placeholder
      // would shift by one — wrong results, no error. The hoist refuses it instead.
      const firstBuilder = new DbCteBuilder();
      const first = olderUsersCte(db, firstBuilder);
      const ou = first.cte.as('ou');

      const secondBuilder = new DbCteBuilder();
      const second = secondBuilder.with(
        'older_users',
        db.users.where(u => gt(u.age, 40)).select(u => ({ id: u.id })),
        { materialized: true }
      );

      const collided = db.users
        .with(first.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .with(second.cte)
          .where(p => sql`${p.userId} IN (SELECT ${ou.id} FROM ${ou})`)
          .select(p => ({ id: p.id })));

      expect(() => collided.buildSql()).toThrow(/two different CTEs named "older_users"/);
      await expectToReject(() => collided.count(), 'two different CTEs named "older_users"');

      // ... while two DISTINCT objects carrying an indistinguishable definition still
      // collapse to one declaration: the identity check is a fast path, not the rule.
      const twinBuilder = new DbCteBuilder();
      const twin = olderUsersCte(db, twinBuilder);

      const { sql: twinSql, params: twinParams } = db.users
        .with(first.cte)
        .where(u => sql`${u.id} IN (SELECT ${ou.id} FROM ${ou})`)
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .with(twin.cte)
          .where(p => sql`${p.userId} IN (SELECT ${ou.id} FROM ${ou})`)
          .select(p => ({ id: p.id })))
        .buildSql();

      expect(twinSql.split('"older_users" AS MATERIALIZED (').length - 1).toBe(1);
      expect(twinParams).toEqual([30]);
    });
  });
});

/**
 * `UnionQueryBuilder.futureCount()` / `futureFirstOrDefault()` (1.0.31): a union offered `future()` only, so
 * `batch.addCount(union)` threw `query.futureCount is not a function` and the count of a union cost a round
 * trip of its own beside the batch — or the batch shipped the union's ROWS for a `.length` in JS.
 *
 * The shape below is the one that asked for it: a MATERIALIZED scope CTE read by both legs, a card leg tagged
 * with a literal, a DISTINCT leg, UNION ALL, counted — as a member of a QueryBatch beside another read.
 */
describe('a union as a QueryBatch count / first-row member', () => {
  // alice(25), bob(35), charlie(45, inactive); posts: alice x2 (views 100, 150), bob x1 (views 200).
  // Leg 1: the active users in scope (alice, bob) — 2 rows. Leg 2: DISTINCT (author, author) of the posts in
  // scope with at least `minViews` views — alice and bob for 100 (3 posts, 2 distinct), bob alone for 200.
  const cardUnion = (db: any, minViews: number) => {
    const cteBuilder = new DbCteBuilder();
    const scope = cteBuilder.with(
      'card_scope',
      db.users.where((u: any) => gt(u.age, 20)).select((u: any) => ({ id: u.id })),
      { materialized: true }
    );
    const scopeIds = () => db.selectFromCte(scope.cte).select((s: any) => ({ id: s.id })).asSubquery('array');

    return db.users
      .where((u: any) => and(eq(u.isActive, true), inSubquery(u.id, scopeIds())))
      .select((u: any) => ({ id: u.id, holderId: literal(0) }))
      .with(scope.cte)
      .unionAll(db.posts
        .where((p: any) => and(inSubquery(p.userId, scopeIds()), gte(p.views, minViews)))
        .select((p: any) => ({ id: p.userId, holderId: p.userId }))
        .selectDistinct((row: any) => ({ id: row.id, holderId: row.holderId })));
  };

  const oneRoundTrip = async (db: any, run: () => Promise<void>) => {
    const querySpy = jest.spyOn(db.client, 'query');

    try {
      await run();

      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }
  };

  test('addCount(union) rides the batch\'s ONE statement beside another member, with count()\'s number', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      expect(await cardUnion(db, 100).count()).toBe(4);
      expect(await cardUnion(db, 200).count()).toBe(3);

      const batch = new QueryBatch();
      const bob = batch.addFirstOrDefault(
        db.users.where(u => eq(u.username, 'bob')).select(u => ({ id: u.id, name: u.username })),
        'bob'
      );
      const cards = batch.addCount(cardUnion(db, 100), 'cards');
      const fewerCards = batch.addCount(cardUnion(db, 200), 'fewerCards');

      await oneRoundTrip(db, () => batch.executeBatch());

      expect(batch.getItem(bob)).toEqual({ id: users.bob.id, name: 'bob' });
      // 5 rows without the DISTINCT of leg 2, 4 with it
      expect(batch.getCount(cards)).toBe(4);
      expect(batch.getCount(fewerCards)).toBe(3);
    });
  });

  test('futureCount() is count()\'s statement: the WITH inside the count\'s subquery, the parameters in its order', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const future = cardUnion(db, 150).futureCount();

      expect(future).toBeInstanceOf(FutureCountQuery);
      expect(future.getSql().startsWith('SELECT COUNT(*) as count FROM (WITH "card_scope" AS MATERIALIZED (')).toBe(true);
      expect(future.getSql().endsWith(') as union_count')).toBe(true);
      // the CTE's parameter first, then the legs' in their order
      expect(future.getParams()).toEqual([20, true, 150]);
      // alice + bob, and the authors of the posts with 150+ views: alice, bob
      expect(await future.execute()).toBe(4);
      expect(await future.execute()).toBe(await cardUnion(db, 150).count());

      // A union's own LIMIT is counted, as count() counts it
      const limited = cardUnion(db, 100).orderBy((r: any) => [[r.id, 'ASC'], [r.holderId, 'ASC']]).limit(3);

      expect(await limited.futureCount().execute()).toBe(3);
      expect(await limited.count()).toBe(3);

      const [counted, total] = await FutureQueryRunner.runAsync([cardUnion(db, 100).futureCount(), db.users.futureCount()]);

      expect(counted).toBe(4);
      expect(total).toBe(3);
    });
  });

  test('addFirstOrDefault(union) reads firstOrDefault()\'s row in the batch, and leaves the builder\'s paging alone', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const ordered = () => cardUnion(db, 100).orderBy((r: any) => [[r.holderId, 'DESC'], [r.id, 'ASC']]);
      const expected = await ordered().firstOrDefault();

      expect(expected).toEqual({ id: users.bob.id, holderId: users.bob.id });

      const union = ordered().limit(3);
      const batch = new QueryBatch();
      const first = batch.addFirstOrDefault(union, 'first');
      const none = batch.addFirstOrDefault(cardUnion(db, 100).offset(10), 'none');
      const cards = batch.addCount(cardUnion(db, 100), 'cards');

      await oneRoundTrip(db, () => batch.executeBatch());

      expect(batch.getItem(first)).toEqual(expected);
      expect(batch.getItem(none)).toBeNull();
      expect(batch.getCount(cards)).toBe(4);

      // LIMIT 1 was the future's: the builder still reads its three rows
      expect(await union.toList()).toHaveLength(3);

      const future = ordered().futureFirstOrDefault();

      expect(future).toBeInstanceOf(FutureSingleQuery);
      expect(future.getSql().endsWith('LIMIT 1')).toBe(true);
      expect(await future.execute()).toEqual(expected);
    });
  });

  test('a union whose legs declare a data-modifying CTE is refused as a future — count() runs it', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const touchedUnion = () => {
        const cteBuilder = new DbCteBuilder();
        const touched = cteBuilder.withMutation('touched', db.users
          .where(u => eq(u.username, 'alice'))
          .update({ age: 26 })
          .toStatement(u => ({ id: u.id })));

        return db.selectFromCte(touched.cte).select(r => ({ id: r.id }))
          .unionAll(db.selectFromCte(touched.cte).select(r => ({ id: r.id })));
      };
      const aliceAge = () => db.users.where(u => eq(u.username, 'alice')).select(u => ({ age: u.age })).firstOrDefault();

      expect(() => touchedUnion().futureCount()).toThrow(/futureCount\(\): the union's legs declare the data-modifying CTE "touched"/);
      expect(() => touchedUnion().futureFirstOrDefault()).toThrow(/futureFirstOrDefault\(\): the union's legs declare the data-modifying CTE "touched"/);
      expect(() => new QueryBatch().addCount(touchedUnion(), 'touched')).toThrow(/Run count\(\) for it/);
      // refused before anything ran
      expect(await aliceAge()).toEqual({ age: 25 });

      // ... and a refused future leaves the builder usable
      const union = touchedUnion();

      expect(() => union.futureFirstOrDefault()).toThrow(/data-modifying CTE "touched"/);
      expect(await union.count()).toBe(2);
      expect(await aliceAge()).toEqual({ age: 26 });
    });
  });
});
