import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { DbCteBuilder, and, eq, gt, inSubquery, notInSubquery, onTrue } from '../../src';

/**
 * `CteRootQueryBuilder.asSubquery()` — turning a CTE-rooted select into a real
 * `Subquery`, so a CTE can be read through `inSubquery` / `notInSubquery`
 * instead of a hand-written `sql` fragment.
 *
 * The whole difficulty is parameter carriage. A `DbCte` body is compiled once,
 * by `DbCteBuilder`, with placeholders numbered from `$1` — it is built to
 * occupy the OPENING slots of a statement. Nesting it inside a host statement
 * that already bound parameters therefore has to shift the entire block, and
 * the two possible destinations for its `WITH` behave very differently:
 *
 *   - nothing declared upstream -> the subquery is self-contained (its own
 *     `WITH`, its own params, renumbered by the host's offset). Correct, but a
 *     CTE read from N subqueries is written and executed N times.
 *   - the enclosing builder already hoisted it (`.with(cte)` on a union leg,
 *     linkgress >= 0.4.61) -> the subquery emits NEITHER the `WITH` nor the
 *     params and just reads the statement-level relation. One materialization,
 *     shared by every reader.
 *
 * Seed data: alice(25, active), bob(35, active), charlie(45, inactive);
 * posts alice x2 (views 100, 150), bob x1 (views 200).
 * `older_users` (age > 30) is therefore { bob, charlie }.
 */
describe('CteRootQueryBuilder.asSubquery()', () => {
  const olderUsers = (db: any, cteBuilder: DbCteBuilder) => cteBuilder.with(
    'older_users',
    db.users.where((u: any) => gt(u.age, 30)).select((u: any) => ({ id: u.id })),
    { materialized: true }
  );

  test('inSubquery reads a CTE-rooted subquery', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      const rows = await db.users
        .where(u => inSubquery(u.id, scopeIds))
        .select(u => ({ name: u.username }))
        .toList();

      expect(rows.map(r => r.name).sort()).toEqual(['bob', 'charlie']);
    });
  });

  test('notInSubquery reads the same CTE-rooted subquery', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      const rows = await db.users
        .where(u => notInSubquery(u.id, scopeIds))
        .select(u => ({ name: u.username }))
        .toList();

      expect(rows.map(r => r.name)).toEqual(['alice']);
    });
  });

  test('BOTH legs of a unionAll share ONE hoisted declaration of the CTE', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      const union = db.users
        .where(u => inSubquery(u.id, scopeIds))
        .select(u => ({ id: u.id }))
        // Attached to the first leg; UnionQueryBuilder hoists it to statement level.
        .with(older.cte)
        .unionAll(db.posts
          .where(p => inSubquery(p.userId, scopeIds))
          .select(p => ({ id: p.id })));

      const { sql: builtSql, params } = union.buildSql();

      // ONE statement-level declaration, keeping the MATERIALIZED fence...
      expect(builtSql.startsWith('WITH "older_users" AS MATERIALIZED (')).toBe(true);
      expect(builtSql.split('"older_users" AS MATERIALIZED (').length - 1).toBe(1);
      // ...and NOT re-declared inside either leg's IN (...) parentheses.
      expect(builtSql).not.toContain('IN (WITH ');
      // Both legs read the hoisted relation by name.
      expect(builtSql.split('FROM "older_users"').length - 1).toBe(2);

      // The CTE contributes its parameter ONCE, not once per leg.
      expect(params).toEqual([30]);

      // bob + charlie from leg 1, bob's single post from leg 2.
      expect(await union.count()).toBe(3);
    });
  });

  test('without .with(), each leg inlines its own WITH — same answer, two materializations', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      const union = db.users
        .where(u => inSubquery(u.id, scopeIds))
        .select(u => ({ id: u.id }))
        .unionAll(db.posts
          .where(p => inSubquery(p.userId, scopeIds))
          .select(p => ({ id: p.id })));

      const { sql: builtSql, params } = union.buildSql();

      // No statement-level WITH — each leg carries its own, scoped to its IN (...).
      expect(builtSql.startsWith('WITH ')).toBe(false);
      expect(builtSql.split('IN (WITH "older_users" AS MATERIALIZED (').length - 1).toBe(2);

      // Two copies means two parameter bindings, and the SECOND copy must have
      // been renumbered off its baked-in $1 — this is the assertion that fails
      // if a nested CTE body is emitted verbatim.
      expect(params).toEqual([30, 30]);
      expect(builtSql).toContain('"users"."age" > $1');
      expect(builtSql).toContain('"users"."age" > $2');

      // Same answer as the hoisted shape — correctness is not what differs.
      expect(await union.count()).toBe(3);
    });
  });

  test('param ordering: host params bind before the nested CTE body renumbers onto them', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      // The host binds `20` (and `true`) BEFORE the IN (...) is reached, so the
      // CTE body's own `age > 30` — compiled as `$1` by DbCteBuilder — has to
      // land on `$3`.
      // Drive the Subquery through a synthetic context to pin the contract
      // exactly: two host parameters are already bound, so the next free slot is
      // $3 and the CTE body's baked-in $1 must be rewritten to it.
      const context = { paramCounter: 3, params: ['host-a', 'host-b'] as any[] };
      const subquerySql = (scopeIds as any).buildSql(context);

      expect(subquerySql).toContain('"users"."age" > $3');
      expect(subquerySql).not.toContain('"users"."age" > $1');
      // The CTE's parameter is appended AFTER the host's, in WITH order.
      expect(context.params).toEqual(['host-a', 'host-b', 30]);
      expect(context.paramCounter).toBe(4);

      // ...and end-to-end through a real statement whose WHERE binds first:
      // bob(35) and charlie(45) are older than 30, but charlie is inactive, so
      // the host's own `isActive` gate leaves bob. A misbound CTE parameter
      // (e.g. `age > true`) fails loudly here rather than returning wrong rows.
      const rows = await db.users
        .where(u => and(gt(u.age, 20), eq(u.isActive, true), inSubquery(u.id, scopeIds)))
        .select(u => ({ name: u.username }))
        .toList();

      expect(rows).toEqual([{ name: 'bob' }]);
    });
  });

  test('structural: the WITH lands INSIDE the subquery parentheses, scoped to it', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      const context = { paramCounter: 1, params: [] as any[] };
      const subquerySql = (scopeIds as any).buildSql(context);

      // The subquery carries its OWN WITH — it does not ask the host to declare
      // anything, so it is safe to drop into any expression position.
      expect(subquerySql.startsWith('WITH "older_users" AS MATERIALIZED (')).toBe(true);
      expect(subquerySql).toContain('FROM "older_users"');
      // MATERIALIZED survives nesting (the fence is the reason the CTE exists).
      expect(subquerySql).toContain('AS MATERIALIZED (');

      // Rendered into a host statement, that WITH sits inside the IN (...)
      // parentheses — scoped to the subquery, invisible to the host.
      const union = db.users
        .where(u => inSubquery(u.id, scopeIds))
        .select(u => ({ id: u.id }))
        .unionAll(db.posts.where(p => gt(p.views, 0)).select(p => ({ id: p.id })));
      const { sql: builtSql } = union.buildSql();

      expect(builtSql.startsWith('WITH ')).toBe(false);
      expect(builtSql).toContain('IN (WITH "older_users" AS MATERIALIZED (');
      expect(builtSql.indexOf('WITH "older_users"')).toBeGreaterThan(builtSql.indexOf('FROM "users"'));
    });
  });

  test('structural: a PARTIALLY hoisted CTE list is refused rather than mis-numbered', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Two CTEs from ONE builder: `older_users` numbers from $1, `busy_posts`
      // continues at $2. Only the first is attached to the statement, so the
      // second could not be shifted onto a correct slot — the subquery must
      // refuse instead of silently binding `busy_posts` to the wrong parameter.
      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const busy = cteBuilder.with(
        'busy_posts',
        db.posts.where(p => gt(p.views, 120)).select(p => ({ id: p.userId })),
        { materialized: true }
      );

      const joined = db.selectFromCte(older.cte)
        .innerJoin(busy.cte, onTrue())
        .select((o, _b) => ({ id: o.id }))
        .asSubquery('array');

      const union = db.users
        .where(u => inSubquery(u.id, joined))
        .select(u => ({ id: u.id }))
        // Only `older_users` is hoisted; `busy_posts` is not.
        .with(older.cte)
        .unionAll(db.posts.where(p => gt(p.views, 0)).select(p => ({ id: p.id })));

      await expectToReject(
        async () => union.count(),
        /already\s+declared at statement level while "busy_posts" is not/
      );
    });
  });

  test('the hoist survives NESTING: a CTE-rooted subquery inside another subquery still shares it', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // The real consumer shape: the union leg's WHERE holds a
      // subquery over a junction table, and THAT subquery's WHERE holds the
      // CTE-rooted membership test. The statement-level CTE set has to survive
      // BOTH boundaries — `SelectQueryBuilder.asSubquery` builds a fresh
      // QueryContext, and dropping the set there makes the inner CTE-rooted
      // subquery re-declare (and re-materialize) a CTE it was already handed.
      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);
      const scopeIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');

      const authoredPostIds = db.posts
        .where(p => inSubquery(p.userId, scopeIds))
        .select(p => p.id)
        .asSubquery('array');

      const union = db.posts
        .where(p => inSubquery(p.id, authoredPostIds))
        .select(p => ({ id: p.id }))
        .with(older.cte)
        .unionAll(db.users
          .where(u => inSubquery(u.id, scopeIds))
          .select(u => ({ id: u.id })));

      const { sql: builtSql, params } = union.buildSql();

      // ONE declaration despite being reached through two subquery boundaries.
      expect(builtSql.split('"older_users" AS MATERIALIZED (').length - 1).toBe(1);
      expect(builtSql).not.toContain('IN (WITH ');
      expect(params).toEqual([30]);

      // bob's post from leg 1; bob + charlie from leg 2.
      expect(await union.count()).toBe(3);
    });
  });

  test('CONTROL (passes with and without this change): the CTE-rooted query still executes standalone', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const cteBuilder = new DbCteBuilder();
      const older = olderUsers(db, cteBuilder);

      const rows = await db.selectFromCte(older.cte).select(r => ({ id: r.id })).toList();

      expect(rows.map(r => r.id).sort()).toEqual([2, 3]);
    });
  });
});
