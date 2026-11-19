import { describe, test, expect, beforeAll, jest } from 'bun:test';
import { and, DbCteBuilder, eq, eqAnySubquery, exists, gt, inSubquery, QueryBatch, sql } from '../../src';
import type { DbCte } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { getSharedDatabase, seedTestData, setupDatabase } from '../utils/test-database';

/**
 * `DbCteBuilder.with(name, query, { reads })` — the coverage matrix.
 *
 * `tests/queries/cte-statement-hoisting.test.ts` pins the shapes the option was built for. This file generates the
 * cases from the dimensions it has and runs every one against two oracles:
 *
 *   1. the rows — the same body built WITHOUT `reads` (it declares the CTEs it reads inside itself; the statement
 *      declares them too, where it can) returns the same rows, on every engine the suite runs on. A statement that
 *      cannot declare anything (a CTE-rooted one) is compared with the users the body yields, read by a statement
 *      that can;
 *   2. the SQL — with `reads`, each CTE the body reads is declared ONCE in the statement, is not declared again
 *      inside the body's own text, and its parameter is bound once.
 *
 * Dimensions. BODY — the kind of query `with()` takes, each reading the CTE its own way: an entity query reading it in
 * an EXISTS, an `IN (…)`, an `= ANY (…)`, a projected scalar subquery, an ORDER BY expression, a `joinFilter()`; a
 * grouped query (alone, and joined to a second CTE); a CTE-rooted query (the CTE as its root, as its join, in a nested
 * subquery); a union whose legs read it; a body two EXISTS deep; a body that reads a body that reads it. SITE — where
 * the body is declared: a statement's `.with()`, a projected scalar subquery, a WHERE `IN (…)`, a table-subquery join,
 * the root of a CTE-rooted statement, joined to a CTE-rooted root, a UNION leg, an aggregate terminal (`max()`), a
 * collection's filter under the three collection strategies, a future, a QueryBatch leg, a prepared query (rows only:
 * it runs unlogged). DECLARED — the statement declares what the body reads (`.with()`), or it does not and the
 * declaration that carries the body declares it first (a CTE-rooted statement cannot declare anything: the second
 * form only).
 *
 * Seed (seedTestData): users alice(1, age 25), bob(2, 35), charlie(3, 45); posts alice x2, bob x1. The CTE the bodies
 * read is `older_users` (age > 31): { bob, charlie }.
 */

const OLDER_THAN = 31;

type Cte = { cte: DbCte<any> };

let db: AppDatabase;

const olderUsers = (): Cte => new DbCteBuilder().with('older_users', db.users.where(u => gt(u.age, OLDER_THAN)).select(u => ({ id: u.id, age: u.age })));
const userNames = (): Cte => new DbCteBuilder().with('user_names', db.users.select(u => ({ id: u.id, name: u.username })));

/** `older_users` rows of one user, as the subquery an EXISTS takes */
const olderRowsOf = (x: Cte, userId: any): any => db.selectFromCte(x.cte).where(r => eq(r.id, userId)).select(r => ({ id: r.id })).asSubquery();
const olderIds = (x: Cte): any => db.selectFromCte(x.cte).select(r => r.id).asSubquery('array');

const body = (name: string, query: any, reads: Cte[] | undefined): Cte => new DbCteBuilder().with(name, query, reads === undefined ? undefined : { reads: reads.map(c => c.cte) });
const posts = (): any => db.posts;

interface Parts {
  x: Cte;
  y: Cte;
  /** the first body of the chain: reads `x` */
  first: Cte;
}

interface BodyDef {
  name: string;
  /** the CTEs the body reads, and lists in `reads` */
  reads: Array<keyof Parts>;
  /** it joins or roots on a CTE: read by name even without `reads`, so the statement must declare it */
  joins: boolean;
  build: (parts: Parts, reads: Cte[] | undefined) => Cte;
}

const BODIES: BodyDef[] = [
  {
    name: 'entity: EXISTS', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts().where((p: any) => exists(olderRowsOf(x, p.userId))).select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'entity: EXISTS and a parameter of its own', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts().where((p: any) => exists(olderRowsOf(x, p.userId))).where((p: any) => gt(p.views, 0)).select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'entity: IN (subquery)', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts().where((p: any) => inSubquery(p.userId, olderIds(x))).select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'entity: = ANY (subquery)', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts().where((p: any) => eqAnySubquery(p.userId, olderIds(x))).select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'entity: projected scalar subquery', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts().select((p: any) => ({
      userId: p.userId,
      title: p.title,
      olderAge: db.selectFromCte(x.cte).where(r => eq(r.id, p.userId)).select(r => r.age).asSubquery('scalar'),
    })), reads),
  },
  {
    name: 'entity: ORDER BY a scalar subquery', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts()
      .orderBy((p: any) => [[sql<number>`${db.selectFromCte(x.cte).where(r => eq(r.id, p.userId)).select(r => r.age).asSubquery('scalar')}`, 'DESC']])
      .select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'entity: joinFilter()', reads: ['x'], joins: true,
    build: ({ x }, reads) => body('mx_body', posts().joinFilter(x.cte, (p: any, r: any) => eq(p.userId, r.id)).select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'entity: EXISTS two levels deep', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts()
      .where((p: any) => exists(db.users.where(u => and(eq(u.id, p.userId), exists(olderRowsOf(x, u.id)))).select(u => ({ id: u.id })).asSubquery()))
      .select((p: any) => ({ userId: p.userId, title: p.title })), reads),
  },
  {
    name: 'grouped: EXISTS', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts()
      .where((p: any) => exists(olderRowsOf(x, p.userId)))
      .select((p: any) => ({ userId: p.userId, views: p.views }))
      .groupBy((p: any) => ({ userId: p.userId }))
      .select((g: any) => ({ userId: g.key.userId, views: g.sum((p: any) => p.views) })), reads),
  },
  {
    name: 'grouped: EXISTS, joined to a second CTE', reads: ['x', 'y'], joins: true,
    build: ({ x, y }, reads) => body('mx_body', posts()
      .where((p: any) => exists(olderRowsOf(x, p.userId)))
      .select((p: any) => ({ userId: p.userId, views: p.views }))
      .groupBy((p: any) => ({ userId: p.userId }))
      .select((g: any) => ({ userId: g.key.userId, views: g.sum((p: any) => p.views) }))
      .leftJoin(y.cte, (g: any, n: any) => eq(g.userId, n.id), (g: any, n: any) => ({ userId: g.userId, views: g.views, name: n.name })), reads),
  },
  {
    name: 'CTE-rooted: the CTE is the root', reads: ['x'], joins: true,
    build: ({ x }, reads) => body('mx_body', db.selectFromCte(x.cte).select((r: any) => ({ userId: r.id, age: r.age })), reads),
  },
  {
    name: 'CTE-rooted: the CTE is joined', reads: ['x', 'y'], joins: true,
    build: ({ x, y }, reads) => body('mx_body', db.selectFromCte(y.cte).innerJoin(x.cte, eq(y.cte.as().id, x.cte.as().id)).select((n: any, o: any) => ({ userId: n.id, age: o.age })), reads),
  },
  {
    name: 'CTE-rooted: the CTE in a nested subquery', reads: ['x', 'y'], joins: true,
    build: ({ x, y }, reads) => body('mx_body', db.selectFromCte(y.cte).where((r: any) => inSubquery(r.id, olderIds(x))).select((r: any) => ({ userId: r.id, name: r.name })), reads),
  },
  {
    name: 'union: both legs read the CTE', reads: ['x'], joins: false,
    build: ({ x }, reads) => body('mx_body', posts()
      .where((p: any) => exists(olderRowsOf(x, p.userId))).select((p: any) => ({ userId: p.userId, title: p.title }))
      .unionAll(posts().where((p: any) => inSubquery(p.userId, olderIds(x))).select((p: any) => ({ userId: p.userId, title: p.title }))), reads),
  },
  {
    name: 'chain: a body that reads a body that reads the CTE', reads: ['first'], joins: false,
    build: ({ first }, reads) => body('mx_body', db.users
      .where(u => inSubquery(u.id, db.selectFromCte(first.cte).select(r => r.userId).asSubquery('array')))
      .select(u => ({ userId: u.id, title: u.username })), reads),
  },
];

/** A site declares `body` somewhere and reads its `userId`s. `declare`: what the statement declares itself, where it can. */
interface Site {
  name: string;
  /** a CTE-rooted statement cannot `.with()` anything */
  canDeclare: boolean;
  /** rows are `{ userId }`: compared as the set of ids, not row by row */
  ids?: boolean;
  /** false: the statement is not the one `client.query` saw (a prepared query runs unlogged, `temptable` runs several) — rows only */
  sql?: boolean;
  /**
   * The users a result stands for, by name — set where a body that joins a CTE BY NAME cannot run without `reads`: the
   * statements `temptable` runs for a collection are not the one carrying the statement's WITH, so the plain twin has no
   * CTE to join there. Its result is then compared with the users the body yields, read by a statement that can declare.
   */
  names?: (rows: any[]) => string[];
  run: (b: Cte, declare: Cte[]) => Promise<any[]>;
}

const withAll = (query: any, declare: Cte[]): any => (declare.length > 0 ? query.with(...declare.map(c => c.cte)) : query);
const bodyIds = (b: Cte): any => db.selectFromCte(b.cte).select(r => r.userId).asSubquery('array');

const SITES: Site[] = [
  {
    // What the statement declares goes BEFORE the body: a CTE reads only the CTEs declared before it, and a body built
    // without `reads` has no dependencies to order itself after
    name: 'statement .with() + IN (…)', canDeclare: true,
    run: (b, declare) => db.users.with(...declare.map(c => c.cte), b.cte).where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ name: u.username })).toList(),
  },
  {
    name: 'projected scalar subquery', canDeclare: true,
    run: (b, declare) => withAll(db.users.select(u => ({
      name: u.username,
      n: db.selectFromCte(b.cte).where(r => eq(r.userId, u.id)).select(() => sql<number>`count(*)`.mapWith(Number)).asSubquery('scalar'),
    })), declare).toList(),
  },
  {
    name: 'WHERE IN (subquery)', canDeclare: true,
    run: (b, declare) => withAll(db.users.where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ name: u.username })), declare).toList(),
  },
  {
    name: 'table-subquery join', canDeclare: true,
    run: (b, declare) => withAll(db.users.innerJoin(
      db.selectFromCte(b.cte).select(r => ({ userId: r.userId })).asSubquery('table'),
      (u, s) => eq(u.id, s.userId),
      (u) => ({ name: u.username }),
      'mx_sub',
    ), declare).toList(),
  },
  {
    name: 'root of a CTE-rooted statement', canDeclare: false, ids: true,
    run: (b) => db.selectFromCte(b.cte).select(r => ({ userId: r.userId })).toList(),
  },
  {
    name: 'joined to a CTE-rooted root', canDeclare: false, ids: true,
    run: (b) => {
      const names = userNames();

      return db.selectFromCte(names.cte).innerJoin(b.cte, eq(names.cte.as().id, b.cte.as().userId)).select((n: any, r: any) => ({ userId: r.userId, name: n.name })).toList();
    },
  },
  {
    name: 'UNION leg', canDeclare: true,
    run: (b, declare) => withAll(db.users.where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ id: u.id })), declare)
      .unionAll(db.users.where(u => eq(u.username, 'nobody')).select(u => ({ id: u.id }))).toList(),
  },
  {
    name: 'max() terminal', canDeclare: true,
    run: async (b, declare) => [await withAll(db.users.where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ age: u.age })), declare).max((r: any) => r.age)],
  },
  {
    name: 'a collection\'s filter', canDeclare: true,
    run: (b, declare) => withAll(db.users.select(u => ({
      name: u.username,
      posts: u.posts!.where(p => inSubquery(p.userId, bodyIds(b))).select(p => ({ title: p.title })).toList(),
    })), declare).toList(),
  },
  {
    name: 'a collection\'s filter, strategy \'cte\'', canDeclare: true,
    run: (b, declare) => withAll(db.users.withQueryOptions({ collectionStrategy: 'cte' }).select(u => ({
      name: u.username,
      posts: u.posts!.where(p => inSubquery(p.userId, bodyIds(b))).select(p => ({ title: p.title })).toList(),
    })), declare).toList(),
  },
  {
    name: 'a collection\'s filter, strategy \'temptable\'', canDeclare: true, sql: false,
    names: rows => rows.filter(row => row.posts.length > 0).map(row => row.name),
    run: (b, declare) => withAll(db.users.withQueryOptions({ collectionStrategy: 'temptable' }).select(u => ({
      name: u.username,
      posts: u.posts!.where(p => inSubquery(p.userId, bodyIds(b))).select(p => ({ title: p.title })).toList(),
    })), declare).toList(),
  },
  {
    name: 'future()', canDeclare: true,
    run: (b, declare) => withAll(db.users.where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ name: u.username })), declare).future().execute(),
  },
  {
    name: 'a QueryBatch leg', canDeclare: true,
    run: async (b, declare) => {
      const batch = new QueryBatch();
      const leg = batch.addList(withAll(db.users.where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ name: u.username })), declare), 'mx_leg');

      await batch.executeBatch();

      return batch.getList(leg);
    },
  },
  {
    name: 'prepare()', canDeclare: true, sql: false,
    run: (b, declare) => withAll(db.users.where(u => inSubquery(u.id, bodyIds(b))).select(u => ({ name: u.username })), declare).prepare(`mx_prepared_${++preparedNames}`).execute({}),
  },
];

let preparedNames = 0;

/** The text of the CTE declaration `"name" AS [MATERIALIZED ](…)`: its balanced parentheses, string literals skipped */
function declarationOf(statement: string, name: string): string | null {
  const head = `"${name}" AS `;
  const at = statement.indexOf(head);

  if (at < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  const start = statement.indexOf('(', at + head.length);

  for (let i = start; i < statement.length; i++) {
    const c = statement[i];

    if (inString) {
      if (c === '\'') {
        if (statement[i + 1] === '\'') {
          i++;
        } else {
          inString = false;
        }
      }

      continue;
    }

    if (c === '\'') {
      inString = true;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return statement.slice(start, i + 1);
    }
  }

  return null;
}

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; statements: Array<{ sql: string; params: any[] }> }> {
  const spy = jest.spyOn((db as any).client, 'query');

  try {
    const result = await run();

    return { result, statements: spy.mock.calls.map(call => ({ sql: String(call[0]), params: (call[1] as any[]) ?? [] })) };
  } finally {
    spy.mockRestore();
  }
}

const normalise = (rows: unknown[]): string => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
const idSet = (rows: any[]): string => JSON.stringify([...new Set(rows.map(row => Number(row.userId ?? row.id)))].sort());
const declarations = (text: string, name: string): number => text.split(`"${name}" AS `).length - 1;
const cteNameOf = (read: keyof Parts): string | null => (read === 'x' ? 'older_users' : read === 'y' ? 'user_names' : null);

describe('with(name, query, { reads }) — body × site × declared, against the same body without `reads`', () => {
  beforeAll(async () => {
    db = getSharedDatabase();
    await setupDatabase(db);
    await seedTestData(db);
  });

  let cases = 0;

  for (const bodyDef of BODIES) {
    for (const site of SITES) {
      for (const declared of site.canDeclare ? [true, false] : [false]) {
        test(`${bodyDef.name} | ${site.name} | ${declared ? 'the statement declares what it reads' : 'the carrying declaration declares it'}`, async () => {
          const x = olderUsers();
          const y = userNames();
          const first = body('mx_first', posts().where((p: any) => exists(olderRowsOf(x, p.userId))).select((p: any) => ({ userId: p.userId, title: p.title })), [x]);
          const parts: Parts = { x, y, first };
          const listed = bodyDef.reads.map(read => parts[read]);
          const withReads = bodyDef.build(parts, listed);
          const plain = bodyDef.build(parts, undefined);

          const reads = await capture(() => site.run(withReads, declared ? listed : []));
          cases++;

          // 1. the SQL: each CTE the body reads is declared once, not inside the body, its parameter bound once
          if (site.sql !== false) {
            const carrier = reads.statements.find(s => declarations(s.sql, 'mx_body') > 0);
            expect(carrier).toBeDefined();

            for (const read of bodyDef.reads) {
              const name = cteNameOf(read);

              if (name !== null) {
                expect(declarations(carrier!.sql, name)).toBe(1);
                expect(declarationOf(carrier!.sql, 'mx_body')!.includes(`"${name}" AS `)).toBe(false);
              }
            }

            expect(carrier!.params.filter(param => param === OLDER_THAN)).toHaveLength(1);
          }

          // 2. the rows. The plain twin runs with the statement declaring everything the body reads — the one form every
          //    body supports; a statement that cannot declare anything is compared with the users the body yields
          let plainRows: any[] | null = null;

          if (site.canDeclare) {
            try {
              plainRows = (await capture(() => site.run(plain, listed))).result;
            } catch (error) {
              // Only where a plain body that JOINS a CTE by name has none to join: the statement carrying it is not the one
              // carrying the statement's WITH. The same body with `reads` ran above, so it is compared with the canonical users
              expect(site.names).toBeDefined();
              expect(bodyDef.joins).toBe(true);
              expect(String((error as Error).message)).toMatch(/relation "\w+" does not exist/);
            }
          }

          const oracleRows = plainRows ?? (await capture(() => SITES[0].run(plain, listed))).result;

          if (plainRows !== null) {
            expect(normalise(reads.result)).toBe(normalise(plainRows));
            expect(plainRows.length).toBeGreaterThan(0);
          } else if (site.canDeclare) {
            const canonical = [...new Set((oracleRows as any[]).map(row => row.name))].sort();

            expect(canonical.length).toBeGreaterThan(0);
            expect([...new Set(site.names!(reads.result))].sort()).toEqual(canonical);
          } else {
            const names = new Set((oracleRows as any[]).map(row => row.name));
            const users = await db.users.select(u => ({ id: u.id, name: u.username })).toList();
            const expectedIds = JSON.stringify(users.filter(u => names.has(u.name)).map(u => Number(u.id)).sort());

            expect(idSet(reads.result)).toBe(expectedIds);
            expect(names.size).toBeGreaterThan(0);
          }
        });
      }
    }
  }

  test('the matrix ran every case', () => {
    expect(cases).toBe(BODIES.length * (SITES.filter(s => s.canDeclare).length * 2 + SITES.filter(s => !s.canDeclare).length));
  });
});
