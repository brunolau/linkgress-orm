import { describe, test, expect, beforeAll, jest } from 'bun:test';
import {
  add, and, coalesce, DbCte, DbCteBuilder, eq, exists, gt, inSubquery, literal, lt, onTrue, sql,
} from '../../src';
import type { CompiledStatement } from '../../src';
import { sameCteDefinition } from '../../src/query/cte-builder';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { getSharedDatabase, seedTestData, setupDatabase, withDatabase } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * A CTE attached to a statement with `.with(cte)` is declared ONCE, at statement level, and every nested
 * build of that statement — its WHERE, its projected subqueries, its ORDER BY expressions, its
 * collections — reads it by name: no nested `WITH`, no re-bound parameters. A data-modifying CTE is
 * refused anywhere but at statement level (nested, PostgreSQL rejects it — and run naively it would
 * execute once per occurrence). Typed mutation CTEs and `CteRootQueryBuilder.where()`.
 *
 * Seed (seedTestData): users alice(1, age 25), bob(2, 35), charlie(3, 45); posts alice x2, bob x1.
 * The `older_users` CTE (age > 31) is therefore { bob, charlie }; 31 is bound nowhere else.
 */

const OLDER_THAN = 31;

function olderUsers(db: AppDatabase, cteBuilder: DbCteBuilder = new DbCteBuilder()) {
  return cteBuilder.with('older_users', db.users.where(u => gt(u.age, OLDER_THAN)).select(u => ({ id: u.id, age: u.age })));
}

/** Runs `run` and returns every statement (with its params) the shared client was handed. */
async function capture(db: AppDatabase, run: () => Promise<unknown>): Promise<Array<{ sql: string; params: any[] }>> {
  const spy = jest.spyOn((db as any).client, 'query');

  try {
    await run();
    return spy.mock.calls.map(call => ({ sql: String(call[0]), params: (call[1] as any[]) ?? [] }));
  } finally {
    spy.mockRestore();
  }
}

const declarations = (text: string, name: string): number => text.split(`"${name}" AS (`).length - 1;

describe('statement-level CTE hoisting', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = getSharedDatabase();
    await setupDatabase(db);
    await seedTestData(db);
  });

  test('a CTE read from the WHERE, from a projected scalar subquery and from an ORDER BY expression is declared once, its params bound once', async () => {
    const older = olderUsers(db);
    const olderIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');
    let rows: Array<{ name: string; olderAge: number | undefined }> = [];

    const [statement] = await capture(db, async () => {
      rows = await db.users
        .where(u => inSubquery(u.id, olderIds))
        .with(older.cte)
        .orderBy(u => [[sql<number>`${db.selectFromCte(older.cte).where(r => eq(r.id, u.id)).select(r => r.age).asSubquery('scalar')}`, 'DESC']])
        .select(u => ({
          name: u.username,
          olderAge: db.selectFromCte(older.cte).where(r => eq(r.id, u.id)).select(r => r.age).asSubquery('scalar'),
        }))
        .toList();
    });

    expect(rows).toEqual([
      { name: 'charlie', olderAge: 45 },
      { name: 'bob', olderAge: 35 },
    ]);
    expect(statement.sql.startsWith('WITH "older_users" AS (')).toBe(true);
    expect(declarations(statement.sql, 'older_users')).toBe(1);
    expect(statement.sql).not.toContain('(WITH ');
    expect(statement.params.filter(param => param === OLDER_THAN)).toHaveLength(1);
    expect(statement.sql).toContain('"users"."id" IN (SELECT "older_users"."id" as "id"\nFROM "older_users")');
  });

  test('the hoist reaches a subquery nested inside a projected subquery, and a nested query attaching the same CTE', async () => {
    const older = olderUsers(db);
    const olderIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');
    let rows: Array<{ name: string; olderPosts: number | undefined }> = [];

    const [statement] = await capture(db, async () => {
      rows = await db.users
        .with(older.cte)
        .select(u => ({
          name: u.username,
          olderPosts: db.posts
            .with(older.cte)
            .where(p => and(eq(p.userId, u.id), inSubquery(p.userId, olderIds)))
            .select(() => sql<number>`count(*)`)
            .asSubquery('scalar'),
        }))
        .toList();
    });

    expect(new Map(rows.map(row => [row.name, row.olderPosts]))).toEqual(new Map([
      ['alice', 0],
      ['bob', 1],
      ['charlie', 0],
    ]));
    expect(declarations(statement.sql, 'older_users')).toBe(1);
    expect(statement.params.filter(param => param === OLDER_THAN)).toHaveLength(1);
  });

  test('a collection of the statement reads the hoisted CTE by name too', async () => {
    const older = olderUsers(db);
    const olderIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');
    let rows: Array<{ name: string; posts: Array<{ title: string }> }> = [];

    const [statement] = await capture(db, async () => {
      rows = await db.users
        .select(u => ({
          name: u.username,
          posts: u.posts!.where(p => inSubquery(p.userId, olderIds)).select(p => ({ title: p.title })).toList(),
        }))
        .with(older.cte)
        .toList();
    });

    expect(new Map(rows.map(row => [row.name, row.posts.map(p => p.title)]))).toEqual(new Map([
      ['alice', []],
      ['bob', ['Bob Post']],
      ['charlie', []],
    ]));
    expect(declarations(statement.sql, 'older_users')).toBe(1);
  });

  test('a UNION leg that projects a subquery over the hoisted CTE reads it by name', async () => {
    const older = olderUsers(db);

    const union = db.users
      .where(u => eq(u.username, 'bob'))
      .with(older.cte)
      .select(u => ({ age: db.selectFromCte(older.cte).where(r => eq(r.id, u.id)).select(r => r.age).asSubquery('scalar') }))
      .unionAll(db.users
        .where(u => eq(u.username, 'charlie'))
        .select(u => ({ age: db.selectFromCte(older.cte).where(r => eq(r.id, u.id)).select(r => r.age).asSubquery('scalar') })));

    const { sql: text, params } = union.buildSql();
    expect(declarations(text, 'older_users')).toBe(1);
    expect(params.filter(param => param === OLDER_THAN)).toHaveLength(1);
    expect((await union.toList()).map(row => row.age).sort()).toEqual([35, 45]);
  });

  test('a subquery carrying a CTE the statement does not declare: the body\'s parameters are numbered after the statement\'s', async () => {
    const older = olderUsers(db);
    const olderIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');
    const carrying = db.users.where(v => inSubquery(v.id, olderIds)).select(v => v.id).with(older.cte).asSubquery('array');
    let names: string[] = [];

    const [statement] = await capture(db, async () => {
      // `20` is bound before the subquery: the CTE body's own `$1` must move to `$2`
      names = await db.users.where(u => and(gt(u.age, 20), inSubquery(u.id, carrying))).select(u => u.username).toList();
    });

    expect([...names].sort()).toEqual(['bob', 'charlie']);
    expect(statement.sql).toContain('IN (WITH "older_users" AS (');
    expect(statement.sql).toContain('"users"."age" > $2');
    expect(statement.params).toEqual([20, OLDER_THAN]);
  });

  test('a UNION nested in a statement: renumbered when it declares the CTE, not declared again when the statement does', async () => {
    const older = olderUsers(db);
    const olderIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');
    const union = db.users
      .where(v => inSubquery(v.id, olderIds))
      .select(v => ({ id: v.id }))
      .with(older.cte)
      .unionAll(db.users.where(v => eq(v.username, 'nobody')).select(v => ({ id: v.id })))
      .asSubquery('array') as any;

    let names: string[] = [];
    const [nested] = await capture(db, async () => {
      names = await db.users.where(u => and(gt(u.age, 20), inSubquery(u.id, union))).select(u => u.username).toList();
    });
    expect([...names].sort()).toEqual(['bob', 'charlie']);
    expect(nested.params).toEqual([20, OLDER_THAN, 'nobody']);
    expect(nested.sql).toContain('"users"."age" > $2');

    const [hoisted] = await capture(db, async () => {
      names = await db.users.where(u => and(gt(u.age, 20), inSubquery(u.id, union))).select(u => u.username).with(older.cte).toList();
    });
    expect([...names].sort()).toEqual(['bob', 'charlie']);
    expect(declarations(hoisted.sql, 'older_users')).toBe(1);
    expect(hoisted.params).toEqual([OLDER_THAN, 20, 'nobody']);
  });

  test('each CTE body is numbered from its own parameters: part of a builder\'s CTEs inherited, its second CTE alone', async () => {
    const builder = new DbCteBuilder();
    const a = builder.with('cte_a', db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id, age: u.age })));
    const b = builder.with('cte_b', db.users.where(u => lt(u.age, 40)).select(u => ({ id: u.id, age: u.age })));
    const bIds = () => db.selectFromCte(b.cte).select(r => r.id).asSubquery('array');

    // The statement declares cte_a; the nested query attaches cte_a and cte_b: cte_b's body binds its own 40
    // (it used to be renumbered as if it started the builder's block — `$3`: an error, or on Bun the 20)
    const nested = db.users
      .where(v => and(inSubquery(v.id, bIds()), gt(v.age, 20)))
      .select(v => v.id)
      .with(a.cte, b.cte)
      .asSubquery('array');
    const [statement] = await capture(db, async () => {
      expect([...await db.users.where(u => inSubquery(u.id, nested)).select(u => u.username).with(a.cte).toList()].sort())
        .toEqual(['alice', 'bob']);
    });
    expect(statement.params).toEqual([30, 40, 20]);
    expect(statement.sql).toContain('"users"."age" < $2');
    expect(statement.sql).toContain('"users"."age" > $3');

    // The same nested query as the first leg of a UNION
    const nestedUnion = db.users
      .where(v => and(inSubquery(v.id, bIds()), gt(v.age, 20)))
      .select(v => ({ id: v.id }))
      .with(a.cte, b.cte)
      .unionAll(db.users.where(v => eq(v.username, 'nobody')).select(v => ({ id: v.id })))
      .asSubquery('array') as any;
    expect([...await db.users.where(u => inSubquery(u.id, nestedUnion)).select(u => u.username).with(a.cte).toList()].sort())
      .toEqual(['alice', 'bob']);

    // The builder's second CTE on its own: in an entity statement, and as a CTE-rooted statement's root
    expect([...await db.users.where(u => inSubquery(u.id, bIds())).select(u => u.username).with(b.cte).toList()].sort())
      .toEqual(['alice', 'bob']);
    expect([...await db.selectFromCte(b.cte).select(r => r.age).toList()].sort()).toEqual([25, 35]);
    // ... and as the root of a CTE-rooted statement joined to the builder's FIRST CTE (declared after it)
    expect(await db.selectFromCte(b.cte).innerJoin(a.cte, eq(b.cte.as().id, a.cte.as().id)).select((r, s) => ({ age: r.age, same: s.age })).toList())
      .toEqual([{ age: 35, same: 35 }]);
    // ... and nested in a statement that declares only cte_a: cte_b is declared inside the subquery (it
    // used to be refused — "Cannot nest this CTE-rooted subquery")
    const both = db.selectFromCte(b.cte).innerJoin(a.cte, eq(b.cte.as().id, a.cte.as().id)).select(r => r.id).asSubquery('array');
    expect(await db.users.where(u => inSubquery(u.id, both)).select(u => u.username).with(a.cte).toList()).toEqual(['bob']);
  });

  test('a nested query attaching a DIFFERENT CTE under a name the statement declares is refused; an identical definition is the same CTE', async () => {
    const older = new DbCteBuilder().with('filtered', db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id })));
    const young = new DbCteBuilder().with('filtered', db.users.where(u => lt(u.age, 30)).select(u => ({ id: u.id })));
    const youngIds = db.users
      .where(v => inSubquery(v.id, db.selectFromCte(young.cte).select(r => r.id).asSubquery('array')))
      .select(v => v.id)
      .with(young.cte)
      .asSubquery('array');

    // The nested query used to read the statement's "filtered" (age > 30) instead of its own (age < 30)
    await expectToReject(
      () => db.users
        .select(u => ({
          name: u.username,
          isYoung: db.posts.where(p => inSubquery(p.userId, youngIds)).where(p => eq(p.userId, u.id))
            .select(() => sql<number>`count(*)`.mapWith(Number)).asSubquery('scalar'),
        }))
        .with(older.cte)
        .toList(),
      /The CTE "filtered" a nested query attaches is not the CTE "filtered" its statement declares/
    );

    // The same definition built again (another DbCte instance) is the statement's CTE
    const olderAgain = new DbCteBuilder().with('filtered', db.users.where(u => gt(u.age, 30)).select(u => ({ id: u.id })));
    const olderIds = db.users
      .where(v => inSubquery(v.id, db.selectFromCte(olderAgain.cte).select(r => r.id).asSubquery('array')))
      .select(v => v.id)
      .with(olderAgain.cte)
      .asSubquery('array');
    const [statement] = await capture(db, async () => {
      expect([...await db.users.where(u => inSubquery(u.id, olderIds)).select(u => u.username).with(older.cte).toList()].sort())
        .toEqual(['bob', 'charlie']);
    });
    expect(declarations(statement.sql, 'filtered')).toBe(1);
  });

  test('"the same CTE" is the same by CONTENT: a definition built twice with Date, array or no parameters, from builders at other offsets', async () => {
    // A CTE factory called twice — the statement declares one instance, a nested query attaches the other.
    // 1.0.8 declared the nested one inside its subquery and ran; comparing parameters by identity (and the
    // builders' offsets) refused these as "different" CTEs
    const since = () => new DbCteBuilder().with('since', db.users.where(u => sql`${u.createdAt} > ${new Date('2000-01-01T00:00:00Z')}`).select(u => ({ id: u.id })));
    const d1 = since();
    const d2 = since();
    let names: string[] = [];

    const [statement] = await capture(db, async () => {
      names = await db.users
        .with(d1.cte)
        .where(u => inSubquery(u.id, db.selectFromCte(d2.cte).select(r => ({ id: r.id })).asSubquery('array')))
        .select(u => u.username)
        .toList();
    });
    expect([...names].sort()).toEqual(['alice', 'bob', 'charlie']);
    expect(declarations(statement.sql, 'since')).toBe(1);
    expect(statement.params).toEqual([new Date('2000-01-01T00:00:00Z')]);

    // ... also read through a nested query that attaches it itself
    const nested = db.posts
      .where(p => inSubquery(p.userId, db.selectFromCte(d2.cte).select(r => ({ id: r.id })).asSubquery('array')))
      .select(p => p.userId)
      .with(d2.cte)
      .asSubquery('array');
    expect([...await db.users
      .with(d1.cte)
      .where(u => and(inSubquery(u.id, db.selectFromCte(d1.cte).select(r => ({ id: r.id })).asSubquery('array')), inSubquery(u.id, nested)))
      .select(u => u.username)
      .toList()].sort()).toEqual(['alice', 'bob']);

    // A JS array parameter (built only: Bun's driver cannot bind a raw JS array parameter, with or without the
    // CTE — `insufficient data left in message`)
    const picked = () => new DbCteBuilder().with('picked', db.users.where(u => sql`${u.id} = ANY(${[1, 2]})`).select(u => ({ id: u.id })));
    const x1 = picked();
    const x2 = picked();
    const rooted = db.selectFromCte(x1.cte)
      .where(r => inSubquery(r.id, db.selectFromCte(x2.cte).select(s => ({ id: s.id })).asSubquery('array')))
      .select(r => ({ id: r.id }))
      .buildQuery();
    expect(declarations(rooted.sql, 'picked')).toBe(1);
    expect(rooted.params).toEqual([[1, 2]]);

    // No parameters at all, but built after another CTE of its builder (its body starts at $2, not $1)
    const first = new DbCteBuilder();
    first.with('prefilter', db.users.where(u => gt(u.age, 1)).select(u => ({ id: u.id })));
    const z1 = first.with('everyone', db.users.select(u => ({ id: u.id })));
    const z2 = new DbCteBuilder().with('everyone', db.users.select(u => ({ id: u.id })));
    const nestedZero = db.posts
      .where(p => inSubquery(p.userId, db.selectFromCte(z2.cte).select(r => ({ id: r.id })).asSubquery('array')))
      .select(p => p.userId)
      .with(z2.cte)
      .asSubquery('array');
    expect([...await db.users
      .with(z1.cte)
      .where(u => and(inSubquery(u.id, db.selectFromCte(z1.cte).select(r => ({ id: r.id })).asSubquery('array')), inSubquery(u.id, nestedZero)))
      .select(u => u.username)
      .toList()].sort()).toEqual(['alice', 'bob']);

    // The same by content on two UNION legs: one statement-level WITH
    const leg1 = db.users.where(u => inSubquery(u.id, db.selectFromCte(z1.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(u => ({ id: u.id })).with(z1.cte);
    const leg2 = db.posts.where(p => inSubquery(p.userId, db.selectFromCte(z2.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(p => ({ id: p.userId })).with(z2.cte);
    const union = leg1.unionAll(leg2);
    expect(declarations(union.buildSql().sql, 'everyone')).toBe(1);
    expect((await union.toList()).map(row => row.id).sort()).toEqual([1, 1, 1, 2, 2, 3]);

    const dateLegs = db.users.where(u => inSubquery(u.id, db.selectFromCte(d1.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(u => ({ id: u.id })).with(d1.cte)
      .unionAll(db.posts.where(p => inSubquery(p.userId, db.selectFromCte(d2.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(p => ({ id: p.userId })).with(d2.cte));
    expect(dateLegs.buildSql().params).toEqual([new Date('2000-01-01T00:00:00Z')]);
    expect((await dateLegs.toList()).map(row => row.id).sort()).toEqual([1, 1, 1, 2, 2, 3]);

    const arrayLegs = db.users.where(u => inSubquery(u.id, db.selectFromCte(x1.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(u => ({ id: u.id })).with(x1.cte)
      .unionAll(db.posts.where(p => inSubquery(p.userId, db.selectFromCte(x2.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(p => ({ id: p.userId })).with(x2.cte));
    expect(declarations(arrayLegs.buildSql().sql, 'picked')).toBe(1);
    expect(arrayLegs.buildSql().params).toEqual([[1, 2]]);
  });

  test('a CTE of the same name that differs by content is still refused — nested and on UNION legs', async () => {
    const ids = (values: number[]) => new DbCteBuilder().with('picked', db.users.where(u => sql`${u.id} = ANY(${values})`).select(u => ({ id: u.id })));
    const statementCte = ids([1, 2]);
    const otherCte = ids([1, 3]);
    const refusal = /The CTE "picked" a nested query attaches is not the CTE "picked" its statement declares/;

    await expectToReject(
      () => db.users
        .with(statementCte.cte)
        .where(u => inSubquery(u.id, db.selectFromCte(otherCte.cte).select(r => ({ id: r.id })).asSubquery('array')))
        .select(u => u.username)
        .toList(),
      refusal
    );

    const legs = db.users.where(u => inSubquery(u.id, db.selectFromCte(statementCte.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(u => ({ id: u.id })).with(statementCte.cte)
      .unionAll(db.posts.where(p => inSubquery(p.userId, db.selectFromCte(otherCte.cte).select(r => ({ id: r.id })).asSubquery('array'))).select(p => ({ id: p.userId })).with(otherCte.cte));
    expect(() => legs.buildSql()).toThrow(/Union legs attach two different CTEs named "picked"/);

    // The same text and parameters, MATERIALIZED on one side only
    const fenced = new DbCteBuilder().with('picked', db.users.where(u => sql`${u.id} = ANY(${[1, 2]})`).select(u => ({ id: u.id })), { materialized: true });
    await expectToReject(
      () => db.users
        .with(ids([1, 2]).cte)
        .where(u => inSubquery(u.id, db.selectFromCte(fenced.cte).select(r => ({ id: r.id })).asSubquery('array')))
        .select(u => u.username)
        .toList(),
      refusal
    );
  });

  test('min() / max() / sum() declare the CTEs the query carries', async () => {
    const older = olderUsers(db);
    const joined = () => db.users.joinFilter(older.cte, (u, o) => eq(u.id, o.id)).select(u => ({ age: u.age }));

    expect(await joined().max(r => r.age)).toBe(45);
    expect(await joined().min(r => r.age)).toBe(35);
    expect(Number(await joined().sum(r => r.age))).toBe(80);
    // a nested read of the CTE reads the statement's declaration
    const olderIds = db.selectFromCte(older.cte).select(r => ({ id: r.id })).asSubquery('array');
    const [statement] = await capture(db, async () => {
      expect(await db.users.where(u => inSubquery(u.id, olderIds)).select(u => ({ age: u.age })).with(older.cte).max(r => r.age)).toBe(45);
    });
    expect(declarations(statement.sql, 'older_users')).toBe(1);
    expect(statement.params).toEqual([OLDER_THAN]);
  });

  test('a grouped query joined to a CTE declares it once for everything nested in it', async () => {
    const older = olderUsers(db);
    let rows: Array<{ userId: number; views: number; age: number | null; olderCount: number }> = [];

    const [statement] = await capture(db, async () => {
      rows = await db.posts
        .select(p => ({ userId: p.userId, views: p.views }))
        .groupBy(p => ({ userId: p.userId }))
        .select(g => ({ userId: g.key.userId, views: g.sum(p => p.views) }))
        .leftJoin(older.cte, (g, o) => eq(g.userId, o.id), (g, o) => ({
          userId: g.userId,
          views: g.views,
          age: o.age,
          olderCount: db.selectFromCte(older.cte).select(() => sql<number>`count(*)`.mapWith(Number)).asSubquery('scalar'),
        }))
        .toList() as any;
    });

    expect([...rows].sort((x, y) => x.userId - y.userId).map(row => [row.userId, Number(row.views), row.age ?? null, Number(row.olderCount)])).toEqual([
      [1, 250, null, 2],
      [2, 200, 35, 2],
    ]);
    expect(declarations(statement.sql, 'older_users')).toBe(1);
    expect(statement.params.filter(param => param === OLDER_THAN)).toHaveLength(1);
  });

  test('a CTE-rooted statement: its own CTEs are hoisted for the subqueries nested in it', async () => {
    const cteBuilder = new DbCteBuilder();
    const older = olderUsers(db, cteBuilder);

    const query = db.selectFromCte(older.cte)
      .select(r => ({
        id: r.id,
        total: db.selectFromCte(older.cte).select(() => sql<number>`count(*)`).asSubquery('scalar'),
      }));

    const { sql: text, params } = query.buildQuery();
    expect(declarations(text, 'older_users')).toBe(1);
    expect(params).toEqual([OLDER_THAN]);
    expect([...await query.toList()].sort((a, b) => a.id - b.id)).toEqual([
      { id: 2, total: 2 },
      { id: 3, total: 2 },
    ]);
  });
});

describe('data-modifying CTEs: typed rows, declared once, refused when nested', () => {
  test('a mutation CTE read from the WHERE and from two projected scalars runs its UPDATE exactly once', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.bob.id)).update(u => ({ age: add(u.age, 1) })).toStatement(u => ({ id: u.id, age: u.age }))
      );

      // Typed from the RETURNING selector: `g.id` is a number column (it used to be typed as the string 'id')
      const gateIds = db.selectFromCte(gate.cte).select(g => ({ id: g.id })).asSubquery('array');
      let rows: Array<{ id: number; loadedAge: number | undefined; newAge: number | undefined; gateRows: number }> = [];

      const [statement] = await capture(db, async () => {
        rows = await db.users
          .where(u => inSubquery(u.id, gateIds))
          .with(gate.cte)
          .select(u => ({
            id: u.id,
            // the table read keeps the PRE-update snapshot
            loadedAge: u.age,
            // the CTE's RETURNING exposes the POST-update value
            newAge: db.selectFromCte(gate.cte).select(g => ({ age: g.age })).asSubquery('scalar'),
            gateRows: db.selectFromCte(gate.cte).select(() => sql<number>`count(*)`).asSubquery('scalar'),
          }))
          .toList();
      });

      expect(rows).toEqual([{ id: users.bob.id, loadedAge: 35, newAge: 36, gateRows: 1 }]);
      expect(declarations(statement.sql, 'gate')).toBe(1);
      expect(statement.sql).toContain('"users"."id" IN (SELECT "gate"."id" as "id"\nFROM "gate")');
      expect(statement.sql).toContain('(SELECT "gate"."age" as "age"\nFROM "gate") as "newAge"');

      // The UPDATE ran once: 35 + 1, not 35 + 3
      const bob = await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault();
      expect(bob).toBe(36);
    });
  });

  test('a mutation CTE that loses its CAS gates the load to 0 rows and changes nothing', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => and(eq(u.id, users.bob.id), lt(u.age, 30))).update({ age: 77 }).toStatement(u => ({ id: u.id }))
      );

      const rows = await db.users
        .where(u => inSubquery(u.id, db.selectFromCte(gate.cte).select(g => ({ id: g.id })).asSubquery('array')))
        .with(gate.cte)
        .select(u => ({ id: u.id }))
        .toList();

      expect(rows).toEqual([]);
      expect(await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault()).toBe(35);
    });
  });

  test('toStatement() is a CompiledStatement typed by its RETURNING; withMutation(name, statement) types the CTE from it', () => {
    const db = getSharedDatabase();
    const statement: CompiledStatement<{ id: number; username: string }> = db.users
      .where(u => eq(u.id, 1))
      .update({ age: 1 })
      .toStatement(u => ({ id: u.id, username: u.username }));
    const cte: DbCte<{ id: number; username: string }> = new DbCteBuilder().withMutation('typed', statement).cte;

    // The selector's keys are the CTE's columns (DbCte.as() hands out refs to them)
    const ref = cte.as('t');
    expect(ref.id).toMatchObject({ __dbColumnName: 'id', __tableAlias: 't' });
    expect(ref.username).toMatchObject({ __dbColumnName: 'username', __tableAlias: 't' });
    expect(cte.name).toBe('typed');

    // The columns-map overload keeps working
    const legacy = new DbCteBuilder().withMutation('legacy', statement, { id: 'id' }).cte;
    expect(legacy.columnDefs).toEqual({ id: 'id' });
  });

  test('a typed mutation CTE reads its RETURNING columns with their types and mappers', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      await db.users.where(u => eq(u.id, users.bob.id)).update({ username: '0042' });

      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.bob.id)).update(u => ({ age: add(u.age, 1) }))
          .toStatement(u => ({ id: u.id, username: u.username, last: u.lastActiveAt, next: add(u.age, 1) }))
      );

      // `username` is text ('0042' used to read 42), `last` goes through its column's mapper (it read the
      // stored integer), `next` is an expression (a number)
      const rows = await db.selectFromCte(gate.cte).select(g => ({ id: g.id, username: g.username, last: g.last, next: g.next })).toList();
      expect(rows).toEqual([{ id: users.bob.id, username: '0042', last: new Date('2025-06-20T14:30:00Z'), next: 37 }]);
    });
  });

  test('the columns-map overload reads as before 1.0.9 — untyped, even when the statement carries a RETURNING selection', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      await db.users.where(u => eq(u.id, users.bob.id)).update({ username: '0042' });

      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.bob.id)).update(u => ({ age: add(u.age, 1) }))
          .toStatement(u => ({ id: u.id, username: u.username })),
        { id: 'id', username: 'username' },
      );

      // A program written for the (name, statement, columns) overload keeps the reads it was written
      // against — the digits-only text reads as a number there. The typed reads come with
      // withMutation(name, statement) (the test above).
      const rows = await db.selectFromCte(gate.cte).select(g => ({ id: g.id, username: g.username })).toList();
      // (the columns map types every column as its name — a string — so the read is compared untyped)
      expect(rows as unknown).toEqual([{ id: users.bob.id, username: 42 }]);
    });
  });

  test('a data-modifying CTE is the statement\'s only when it is the same DbCte: an identical second one is refused', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const gate = () => new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.bob.id)).update({ age: 70 }).toStatement(u => ({ id: u.id }))
      );
      const declared = gate();
      const again = gate();

      // Each DbCte of withMutation is one execution of its statement: two of them are two UPDATEs
      await expectToReject(
        () => db.users
          .with(declared.cte)
          .where(u => inSubquery(u.id, db.users.with(again.cte).select(v => v.id).asSubquery('array')))
          .select(u => u.id)
          .toList(),
        /The CTE "gate" a nested query attaches is not the CTE "gate" its statement declares/
      );
      expect(await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault()).toBe(35);

      // Two UNION legs: the same DbCte is declared once (one UPDATE); two identical ones are two UPDATEs the
      // statement cannot declare under one name (1.0.8 merged them into one)
      const legs = (first: DbCte<any>, second: DbCte<any>) => db.users
        .where(u => inSubquery(u.id, db.selectFromCte(first).select((g: any) => ({ id: g.id })).asSubquery('array')))
        .select(u => ({ id: u.id }))
        .with(first)
        .unionAll(db.users
          .where(u => inSubquery(u.id, db.selectFromCte(second).select((g: any) => ({ id: g.id })).asSubquery('array')))
          .select(u => ({ id: u.id }))
          .with(second));
      expect(() => legs(declared.cte, again.cte).buildSql()).toThrow(/Union legs attach two different CTEs named "gate"/);
      expect((await legs(declared.cte, declared.cte).toList()).map(row => row.id)).toEqual([users.bob.id, users.bob.id]);
      expect(await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault()).toBe(70);
    });
  });

  test('temptable collections with a data-modifying CTE are refused before the statement runs', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.bob.id)).update(u => ({ age: add(u.age, 1) })).toStatement(u => ({ id: u.id }))
      );
      const gateIds = db.selectFromCte(gate.cte).select(g => ({ id: g.id })).asSubquery('array');

      // Its collections would run as statements of their own AFTER the one executing the UPDATE: the
      // collection reading the gate used to be refused only once the UPDATE had committed
      await expectToReject(
        () => db.users
          .select(u => ({ id: u.id, posts: u.posts!.where(p => inSubquery(p.userId, gateIds)).select(p => ({ title: p.title })).toList() }))
          .with(gate.cte)
          .toList(),
        /temptable collection strategy/
      );

      // Nothing ran
      expect(await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault()).toBe(35);

      // ... also when the collection reading it is nested in another one, or reads it in its item
      await expectToReject(
        () => db.users
          .select(u => ({
            id: u.id,
            posts: u.posts!.select(p => ({
              id: p.id,
              comments: p.postComments!
                .where(c => and(gt(c.id, 0), exists(db.selectFromCte(gate.cte).select(g => ({ id: g.id })).asSubquery())))
                .select(c => c.id)
                .toNumberList(),
            })).toList(),
          }))
          .with(gate.cte)
          .toList(),
        /temptable collection strategy/
      );
      await expectToReject(
        () => db.users
          .select(u => ({
            id: u.id,
            posts: u.posts!.select(p => ({ id: p.id, gated: db.selectFromCte(gate.cte).select(() => sql<number>`count(*)`).asSubquery('scalar') })).toList(),
          }))
          .with(gate.cte)
          .toList(),
        /temptable collection strategy/
      );
      expect(await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault()).toBe(35);
    }, { collectionStrategy: 'temptable' });
  });

  test('temptable collections that never read a data-modifying CTE run as in 1.0.8: its UPDATE runs once, in the base statement', async () => {
    await withDatabase(async db => {
      const { users, posts } = await seedTestData(db);

      // The pre-1.0.9 (name, statement, columns) form, joined to the query that executes it
      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.charlie.id)).update({ age: 46 }).toStatement(u => ({ id: u.id, age: u.age })),
        { id: 'id', age: 'age' }
      );

      const rows = await db.users
        .where(u => gt(u.id, 0))
        .with(gate.cte)
        .leftJoin(gate.cte, (u, g: any) => eq(u.id, g.id), (u, g: any) => ({
          id: u.id,
          newAge: g.age,
          posts: u.posts!.select(p => p.id).toNumberList(),
        }))
        .orderBy(r => r.id)
        .toList();

      expect(rows.map(row => ({ ...row, posts: [...row.posts].sort((a, b) => a - b) })) as unknown).toEqual([
        { id: users.alice.id, newAge: undefined, posts: [posts.alicePost1.id, posts.alicePost2.id].sort((a, b) => a - b) },
        { id: users.bob.id, newAge: undefined, posts: [posts.bobPost.id] },
        { id: users.charlie.id, newAge: 46, posts: [] },
      ]);
      // Once: 45 → 46
      expect(await db.users.where(u => eq(u.id, users.charlie.id)).select(u => u.age).firstOrDefault()).toBe(46);
    }, { collectionStrategy: 'temptable' });
  });

  test('a data-modifying CTE declared inside a nested subquery is refused', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const gate = new DbCteBuilder().withMutation(
        'gate',
        db.users.where(u => eq(u.id, users.bob.id)).update({ age: 70 }).toStatement(u => ({ id: u.id }))
      );
      const refusal = /CTE "gate" is data-modifying: a data-modifying CTE must be declared at statement level — attach it with \.with\(\) on the executing query/;

      // A CTE-rooted subquery over it, the executing query NOT carrying it
      await expectToReject(
        db.users.where(u => inSubquery(u.id, db.selectFromCte(gate.cte).select(g => ({ id: g.id })).asSubquery('array'))).toList(),
        refusal
      );

      // A subquery that carries it itself
      await expectToReject(
        db.posts.where(p => inSubquery(p.userId, db.users.with(gate.cte).select(u => u.id).asSubquery('array'))).toList(),
        refusal
      );

      // A CTE body that carries it
      expect(() => new DbCteBuilder().with('wrapped', db.users.with(gate.cte).select(u => ({ id: u.id })))).toThrow(refusal);

      // Nothing ran
      expect(await db.users.where(u => eq(u.id, users.bob.id)).select(u => u.age).firstOrDefault()).toBe(35);
    });
  });
});

describe('sameCteDefinition: two CTEs are the same by content', () => {
  const cte = (query: string, params: unknown[], options: { paramBase?: number; materialized?: boolean; dataModifying?: boolean } = {}) =>
    new DbCte('c', query, params, {}, undefined, undefined, options.materialized, options.dataModifying, options.paramBase);

  test('the body is compared renumbered from $1, the parameters by value', () => {
    // A body built at another offset of its builder: "$2" from paramBase 2 is "$1" from paramBase 1
    expect(sameCteDefinition(cte('SELECT 1 WHERE x = $2', [5], { paramBase: 2 }), cte('SELECT 1 WHERE x = $1', [5]))).toBe(true);
    expect(sameCteDefinition(cte('SELECT 1', [], { paramBase: 3 }), cte('SELECT 1', []))).toBe(true);
    expect(sameCteDefinition(cte('SELECT 1 WHERE x = $1', [5]), cte('SELECT 1 WHERE y = $1', [5]))).toBe(false);
    // a "$2" inside a literal is text, not a placeholder
    expect(sameCteDefinition(cte("SELECT '$2' WHERE x = $2", [5], { paramBase: 2 }), cte("SELECT '$1' WHERE x = $1", [5]))).toBe(false);

    expect(sameCteDefinition(cte('q $1', [Number.NaN]), cte('q $1', [Number.NaN]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [1]), cte('q $1', ['1']))).toBe(false);
    expect(sameCteDefinition(cte('q $1', [10n]), cte('q $1', [10n]))).toBe(true);
    expect(sameCteDefinition(cte('q $1, $2', [1, 2]), cte('q $1, $2', [1]))).toBe(false);

    const at = (iso: string) => new Date(iso);
    expect(sameCteDefinition(cte('q $1', [at('2024-01-02T03:04:05.006Z')]), cte('q $1', [at('2024-01-02T03:04:05.006Z')]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [at('2024-01-02T03:04:05.006Z')]), cte('q $1', [at('2024-01-02T03:04:05.007Z')]))).toBe(false);
    expect(sameCteDefinition(cte('q $1', [new Date(Number.NaN)]), cte('q $1', [new Date(Number.NaN)]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [at('2024-01-02T00:00:00Z')]), cte('q $1', ['2024-01-02T00:00:00.000Z']))).toBe(false);

    expect(sameCteDefinition(cte('q $1', [Buffer.from('ab')]), cte('q $1', [new Uint8Array([97, 98])]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [Buffer.from('ab')]), cte('q $1', [Buffer.from('ac')]))).toBe(false);
    expect(sameCteDefinition(cte('q $1', [Buffer.from('ab')]), cte('q $1', [Buffer.from('abc')]))).toBe(false);

    expect(sameCteDefinition(cte('q $1', [[1, 2]]), cte('q $1', [[1, 2]]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [[1, 2]]), cte('q $1', [[2, 1]]))).toBe(false);
    expect(sameCteDefinition(cte('q $1', [[1n, 2n]]), cte('q $1', [[1n, 2n]]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [[at('2024-01-01T00:00:00Z')]]), cte('q $1', [[at('2024-01-01T00:00:00Z')]]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [{ a: 1, b: [2] }]), cte('q $1', [{ a: 1, b: [2] }]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [{ a: 1, b: [2] }]), cte('q $1', [{ a: 1, b: [3] }]))).toBe(false);
    // key order is part of the JSON text the driver sends
    expect(sameCteDefinition(cte('q $1', [{ a: 1, b: 2 }]), cte('q $1', [{ b: 2, a: 1 }]))).toBe(false);
    expect(sameCteDefinition(cte('q $1', [[1]]), cte('q $1', [{ 0: 1 }]))).toBe(false);

    // Any other object is the same only as the same instance
    class Point { constructor(readonly x: number) {} }
    const point = new Point(1);
    expect(sameCteDefinition(cte('q $1', [point]), cte('q $1', [point]))).toBe(true);
    expect(sameCteDefinition(cte('q $1', [new Point(1)]), cte('q $1', [new Point(1)]))).toBe(false);
  });

  test('MATERIALIZED on one side only, or a data-modifying CTE that is not the same instance, is another CTE', () => {
    expect(sameCteDefinition(cte('SELECT 1', [], { materialized: true }), cte('SELECT 1', []))).toBe(false);
    expect(sameCteDefinition(cte('SELECT 1', [], { materialized: true }), cte('SELECT 1', [], { materialized: true }))).toBe(true);

    const update = cte('UPDATE t SET a = $1 RETURNING a', [1], { dataModifying: true });
    expect(sameCteDefinition(update, update)).toBe(true);
    expect(sameCteDefinition(update, cte('UPDATE t SET a = $1 RETURNING a', [1], { dataModifying: true }))).toBe(false);
    expect(sameCteDefinition(update, cte('UPDATE t SET a = $1 RETURNING a', [1]))).toBe(false);
  });
});

describe('CteRootQueryBuilder.where()', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = getSharedDatabase();
    await setupDatabase(db);
    await seedTestData(db);
  });

  test('WHERE after FROM, before ORDER BY; repeated calls AND; params after the CTE bodies', async () => {
    const older = olderUsers(db);

    const query = db.selectFromCte(older.cte)
      .where(r => gt(r.age, 32))
      .where(r => lt(r.age, 100))
      .select(r => ({ id: r.id }))
      .orderBy(r => [[r.id, 'DESC']]);

    const { sql: text, params } = query.buildQuery();
    expect(text).toBe(
      'WITH "older_users" AS (SELECT "users"."id" as "id", "users"."age" as "age"\nFROM "users"\nWHERE "users"."age" > $1)\n'
      + 'SELECT "older_users"."id" as "id"\nFROM "older_users"\nWHERE ("older_users"."age" > $2 AND "older_users"."age" < $3)\nORDER BY "id" DESC'
    );
    expect(params).toEqual([OLDER_THAN, 32, 100]);
    expect(await query.toList()).toEqual([{ id: 3 }, { id: 2 }]);
  });

  test('on a joined CTE-rooted query: both rows; the WHERE params follow the ON predicate\'s', async () => {
    const cteBuilder = new DbCteBuilder();
    const older = olderUsers(db, cteBuilder);
    const posts = cteBuilder.with('post_views', db.posts.select(p => ({ userId: p.userId, views: p.views })));

    const query = db.selectFromCte(older.cte)
      .innerJoin(posts.cte, and(eq(older.cte.as().id, posts.cte.as().userId), gt(posts.cte.as().views, 1)))
      .where((o, p) => and(gt(o.age, 0), gt(p.views, 150)))
      .select((o, p) => ({ id: o.id, views: p.views }));

    const { sql: text, params } = query.buildQuery();
    expect(text).toContain('INNER JOIN "post_views" ON ("older_users"."id" = "post_views"."userId" AND "post_views"."views" > $2)');
    expect(text).toContain('WHERE ("older_users"."age" > $3 AND "post_views"."views" > $4)');
    expect(params).toEqual([OLDER_THAN, 1, 0, 150]);
    expect(await query.toList()).toEqual([{ id: 2, views: 200 }]);
  });

  test('where() survives select(), and select() survives where()', async () => {
    const older = olderUsers(db);

    const whereFirst = await db.selectFromCte(older.cte).where(r => eq(r.id, 3)).select(r => ({ age: r.age })).toList();
    const selectFirst = await db.selectFromCte(older.cte).select(r => ({ age: r.age })).where(r => eq(r.id, 3)).toList();

    expect(whereFirst).toEqual([{ age: 45 }]);
    expect(selectFirst).toEqual([{ age: 45 }]);
  });

  test('nested: correlated to the enclosing row, a navigation of it joined there', async () => {
    const older = olderUsers(db);

    const rows = await db.posts
      .select(p => ({
        title: p.title,
        authorOlderAge: coalesce(
          db.selectFromCte(older.cte).where(r => eq(r.id, p.user!.id)).select(r => r.age).asSubquery('scalar'),
          literal(0)
        ),
      }))
      .with(older.cte)
      .toList();

    expect(new Map(rows.map(row => [row.title, Number(row.authorOlderAge)]))).toEqual(new Map([
      ['Alice Post 1', 0],
      ['Alice Post 2', 0],
      ['Bob Post', 35],
    ]));
  });

  test('nested, rendered in the enclosing context: correlation as written, params in its sequence', () => {
    const older = olderUsers(db);
    const subquery = db.selectFromCte(older.cte)
      .where(r => and(eq(r.id, { __fieldName: 'userId', __dbColumnName: 'user_id', __tableAlias: 'posts' } as any), gt(r.age, 40)))
      .select(r => ({ age: r.age }))
      .asSubquery('scalar');

    const context = { paramCounter: 3, params: ['a', 'b'] as any[], hoistedCteNames: new Set(['older_users']) };
    expect(subquery.buildSql(context)).toBe(
      'SELECT "older_users"."age" as "age"\nFROM "older_users"\nWHERE ("older_users"."id" = "posts"."user_id" AND "older_users"."age" > $3)'
    );
    expect(context.params).toEqual(['a', 'b', 40]);
    // The correlation is reported to the enclosing query (join detection)
    expect(subquery.getOuterFieldRefs().map(ref => (ref as any).__tableAlias)).toEqual(['posts']);
  });

  test('correlated to an enclosing query over the SAME CTE: refused without a distinct alias, read right with one', async () => {
    const older = olderUsers(db);
    const olderThanRow = (o: { age: any }, alias?: string) => db.selectFromCte(older.cte, alias)
      .where(r => gt(r.age, o.age))
      .select(() => sql<number>`count(*)`.mapWith(Number))
      .asSubquery('scalar');

    // Both rows were "older_users": the WHERE compared the row with itself ("older_users"."age" > "older_users"."age")
    await expectToReject(
      () => db.selectFromCte(older.cte).select(o => ({ id: o.id, olderCount: olderThanRow(o) })).toList(),
      /correlates to the enclosing row "older_users"\."age" under the alias "older_users", which names its own CTE row too/
    );
    // ... also when the enclosing query is an entity query that joined the CTE
    await expectToReject(
      () => db.users.innerJoin(older.cte, (u, o) => eq(u.id, o.id), (u, o) => ({ id: u.id, n: olderThanRow(o) })).toList(),
      /Give one of them a distinct alias/
    );

    const rows = await db.selectFromCte(older.cte).select(o => ({ id: o.id, olderCount: olderThanRow(o, 'other') })).toList();
    expect([...rows].sort((a, b) => a.id - b.id).map(row => [row.id, Number(row.olderCount)])).toEqual([
      [2, 1],
      [3, 0],
    ]);

    const { sql: text } = db.selectFromCte(older.cte, 'o').where(o => gt(o.age, 40)).select(o => ({ id: o.id })).buildQuery();
    expect(text).toContain('FROM "older_users" AS "o"\nWHERE "o"."age" > $2');
  });

  test('an entity subquery nested in where() reads the CTE row as a correlation, also when the CTE is named like one of its navigations', async () => {
    // `user` is also the name of the posts' navigation: the nested query used to join a "user" of its own
    // and bind the correlation to it — every CTE row passed
    const named = new DbCteBuilder().with('user', db.users.select(u => ({ id: u.id, name: u.username })));

    const names = await db.selectFromCte(named.cte)
      .where(r => exists(db.posts.where(p => and(eq(p.userId, r.id), gt(p.views, 180))).select(p => ({ id: p.id })).asSubquery()))
      .select(r => r.name)
      .toList();

    expect(names).toEqual(['bob']);
  });

  test('CROSS JOIN via onTrue() keeps working with a WHERE', async () => {
    const cteBuilder = new DbCteBuilder();
    const older = olderUsers(db, cteBuilder);
    const posts = cteBuilder.with('post_views', db.posts.select(p => ({ userId: p.userId, views: p.views })));

    const rows = await db.selectFromCte(older.cte)
      .fullOuterJoin(posts.cte, onTrue())
      .where((o, p) => eq(o.id, p.userId))
      .select((o, p) => ({ id: o.id, views: p.views }))
      .toList();

    expect(rows).toEqual([{ id: 2, views: 200 }]);
  });
});
