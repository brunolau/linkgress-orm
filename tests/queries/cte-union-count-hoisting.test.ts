import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { DbCteBuilder, and, eq, gt, sql } from '../../src';

/**
 * Two CTE-visibility gaps, both surfaced by the gopass-eshop Discount Centre
 * badge (QA_AT-533), where the security-critical visibility gate had to be
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
