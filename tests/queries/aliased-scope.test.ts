import { describe, test, expect, beforeAll, jest } from 'bun:test';
import {
  add, and, castAsInt, DbCteBuilder, eq, exists, gt, isNull, literal, lt, ne, or, sql, SqlFragment,
} from '../../src';
import { DRIVER_VALUE_MAPPER, SqlBuildContext } from '../../src/query/conditions';
import { pgIntDatetime } from '../../debug/types/int-datetime';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { getSharedDatabase, seedTestData, setupDatabase, withDatabase } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * `db.<table>.as(alias)` — correlated subqueries over tables under EXPLICIT aliases, turned into ONE
 * expression: a scalar `(SELECT …)`, `EXISTS (…)` or `(NOT EXISTS (…))`.
 *
 * Seed (seedTestData): users alice(1, age 25), bob(2, 35), charlie(3, 45, inactive);
 * posts alice x2 (views 100, 150), bob x1 (views 200); task levels created by alice / bob.
 */

function build(fragment: SqlFragment<any>, start: number = 1, params: any[] = []): { sql: string; params: any[] } {
  const context: SqlBuildContext = { paramCounter: start, params: [...params] };
  const text = fragment.buildSql(context);
  return { sql: text, params: context.params };
}

/** A column ref of an ENCLOSING query, the way its mock row hands it to a callback. */
function enclosingRef(alias: string, column: string, field: string = column): any {
  return { __fieldName: field, __dbColumnName: column, __tableAlias: alias };
}

/** Runs `run` and returns every statement the shared client was handed. */
async function captureStatements(db: AppDatabase, run: () => Promise<unknown>): Promise<string[]> {
  const client = (db as any).client;
  const spy = jest.spyOn(client, 'query');

  try {
    await run();
    return spy.mock.calls.map(call => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

describe('db.<table>.as(alias) — aliased subquery scopes', () => {
  describe('rendering', () => {
    const db = getSharedDatabase();

    test('exists() and notExists(): FROM the table under its alias, WHERE the predicate', () => {
      expect(build(db.users.as('u2').exists())).toEqual({ sql: 'EXISTS (SELECT 1 FROM "users" AS "u2")', params: [] });
      expect(build(db.posts.as('p2').where(p => gt(p.views, 120)).notExists())).toEqual({
        sql: '(NOT EXISTS (SELECT 1 FROM "posts" AS "p2" WHERE "p2"."views" > $1))',
        params: [120],
      });
    });

    test('scalar(): joins, AND-combined where() calls, ORDER BY (a condition key parenthesised) and LIMIT — params in textual order', () => {
      const fragment = db.posts.as('p2')
        .innerJoin(db.users.as('au'), (p, a) => eq(a.id, p.userId))
        .where((_p, a) => eq(a.isActive, literal(true)))
        .where(p => gt(p.views, 50))
        .orderBy((p, a) => [[eq(a.username, 'bob'), 'DESC'], [p.views, 'ASC'], [p.id, 'ASC']])
        .limit(1)
        .scalar(p => add(p.views, 7));

      // Two parameters are already bound by the enclosing statement: the scope continues its numbering
      expect(build(fragment, 3, ['x', 'y'])).toEqual({
        sql: '(SELECT ("p2"."views" + $3) FROM "posts" AS "p2" INNER JOIN "users" AS "au" ON "au"."id" = "p2"."user_id" '
          + 'WHERE ("au"."is_active" = TRUE AND "p2"."views" > $4) ORDER BY ("au"."username" = $5) DESC, "p2"."views" ASC, "p2"."id" ASC LIMIT 1)',
        params: ['x', 'y', 7, 50, 'bob'],
      });
    });

    test('leftJoin() renders LEFT JOIN; the joined row reads NULL without a match', () => {
      const fragment = db.users.as('u2')
        .leftJoin(db.posts.as('p2'), (u, p) => eq(p.userId, u.id))
        .where((_u, p) => isNull(p.id))
        .scalar(u => u.username);

      expect(build(fragment).sql).toBe(
        '(SELECT "u2"."username" FROM "users" AS "u2" LEFT JOIN "posts" AS "p2" ON "p2"."user_id" = "u2"."id" WHERE "p2"."id" IS NULL)'
      );
    });

    test('a table outside the default schema is schema-qualified', () => {
      expect(build(db.schemaUsers.as('su').exists()).sql).toBe('EXISTS (SELECT 1 FROM "auth"."schema_users" AS "su")');
    });

    test('outer refs render as given (a lateral alias stays) and are the ONLY refs the fragment reports', () => {
      const outer = enclosingRef('lateral_0_posts', 'user_id', 'userId');
      const fragment = db.users.as('u2').where(u => eq(u.id, outer)).exists();

      expect(build(fragment).sql).toBe('EXISTS (SELECT 1 FROM "users" AS "u2" WHERE "u2"."id" = "lateral_0_posts"."user_id")');

      const refs = fragment.getFieldRefs();
      expect(refs).toHaveLength(1);
      expect(refs[0]).toBe(outer);
    });

    test('a nested scope renders inside the outer one; only refs to the ENCLOSING statement leave the outer scope', () => {
      const outer = enclosingRef('users', 'id');
      const fragment = db.users.as('u2')
        .where(u => eq(u.id, outer))
        .scalar(u => db.posts.as('p2')
          .where(p => and(eq(p.userId, u.id), gt(p.views, 0)))
          .orderBy(p => [[p.views, 'DESC']])
          .limit(1)
          .scalar(p => p.title));

      expect(build(fragment)).toEqual({
        sql: '(SELECT (SELECT "p2"."title" FROM "posts" AS "p2" WHERE ("p2"."user_id" = "u2"."id" AND "p2"."views" > $1) '
          + 'ORDER BY "p2"."views" DESC LIMIT 1) FROM "users" AS "u2" WHERE "u2"."id" = "users"."id")',
        params: [0],
      });
      expect(fragment.getFieldRefs()).toEqual([outer]);
    });

    test('immutable: every method returns a new scope, the one it was called on is unchanged', () => {
      const base = db.posts.as('p2');
      const hot = base.where(p => gt(p.views, 120));
      const cold = base.where(p => lt(p.views, 120));
      hot.orderBy(p => [[p.id, 'ASC']]);
      hot.limit(1);

      expect(build(base.exists()).sql).toBe('EXISTS (SELECT 1 FROM "posts" AS "p2")');
      expect(build(hot.exists()).sql).toBe('EXISTS (SELECT 1 FROM "posts" AS "p2" WHERE "p2"."views" > $1)');
      expect(build(cold.exists()).sql).toBe('EXISTS (SELECT 1 FROM "posts" AS "p2" WHERE "p2"."views" < $1)');
      expect(base.row).toBe(hot.row);
    });

    test('a correlation to a row under one of the scope\'s own aliases is refused at build (it would compare the row with itself)', () => {
      const fragment = db.users.as('users').where(u => eq(u.id, enclosingRef('users', 'id'))).exists();

      expect(() => build(fragment)).toThrow(/the alias "users" is both one of the scope's own aliases/);
    });

    test('invalid aliases are refused', () => {
      expect(() => db.users.as('bad alias')).toThrow(/not a plain identifier/);
      expect(() => db.users.as('')).toThrow(/not a plain identifier/);
      expect(() => db.users.as('a'.repeat(64))).toThrow(/63-byte/);
      expect(() => db.users.as('a'.repeat(63))).not.toThrow();
      expect(() => db.users.as('u').innerJoin(db.posts.as('u'), (u, p) => eq(p.userId, u.id))).toThrow(/alias "u" is already used/);
    });

    test('the joined scope must be a bare table scope', () => {
      expect(() => db.users.as('u').innerJoin(db.posts.as('p').where(p => gt(p.views, 1)), (u, p) => eq(p.userId, u.id)))
        .toThrow(/must be a bare table scope/);
    });

    test('rows are column-only: a navigation throws', () => {
      expect(() => db.posts.as('p2').where(p => eq((p as any).user.id, 1))).toThrow(/navigation "user" is not available/);
    });

    test('orderBy() / limit() / where() refuse what they cannot render', () => {
      const scope = db.posts.as('p2');

      expect(() => scope.orderBy(() => [[5 as any, 'ASC']])).toThrow(/is the constant 5/);
      expect(() => scope.orderBy(p => [[p.id, 'UP' as any]])).toThrow(/direction "UP"/);
      expect(() => scope.limit(-1)).toThrow(/non-negative integer/);
      expect(() => scope.limit(1.5)).toThrow(/non-negative integer/);
      expect(() => scope.where(() => 1 as any)).toThrow(/expected a condition/);
    });

    test('scalar() carries the selection\'s mapper; exists() / notExists() carry none', () => {
      const scope = db.users.as('u2');

      expect(scope.scalar(u => u.lastActiveAt).getMapper()).toBe(pgIntDatetime);
      expect(scope.scalar(u => castAsInt(u.age)).getMapper()).toBe(DRIVER_VALUE_MAPPER);
      expect(scope.scalar(u => u.username).getMapper()).toBeUndefined();
      expect(scope.exists().getMapper()).toBeUndefined();
      expect(scope.notExists().getMapper()).toBeUndefined();
    });

    test('scalar() of a column without a mapper reads as a column of its SQL type (text stays text)', () => {
      const scope = db.users.as('u2');

      expect(scope.scalar(u => u.username).getReadType()).toBe('varchar');
      expect(scope.scalar(u => u.age).getReadType()).toBe('integer');
      // A correlation selected as the value reads the same way
      expect(scope.scalar(() => enclosingRef('users', 'email')).getReadType()).toBeUndefined();
      expect(scope.scalar(() => ({ ...enclosingRef('users', 'email'), __sqlType: 'text' })).getReadType()).toBe('text');
      // A column with a mapper reads through it, an expression as it did
      expect(scope.scalar(u => u.lastActiveAt).getReadType()).toBeUndefined();
      expect(scope.scalar(u => add(u.age, 1)).getReadType()).toBeUndefined();
    });

    test('scalar() refuses a row or an object of columns (it has no one SQL value)', () => {
      const scope = db.users.as('u2');

      expect(() => scope.scalar(u => u as any)).toThrow(/an object holding column refs/);
      expect(() => scope.scalar(u => ({ id: u.id, name: u.username }) as any)).toThrow(/an object holding column refs/);
    });

    test('types: rows are typed per table, scalar() is typed by its selection', () => {
      const count: SqlFragment<number> = db.users.as('u').scalar(u => u.id);
      const name: SqlFragment<string> = db.posts.as('p')
        .innerJoin(db.users.as('a'), (p, a) => eq(a.id, p.userId))
        .scalar((_p, a) => a.username);
      const flag: SqlFragment<boolean> = db.users.as('u').exists();

      expect([count, name, flag].every(fragment => fragment instanceof SqlFragment)).toBe(true);
    });
  });

  describe('against the database', () => {
    let db: AppDatabase;

    beforeAll(async () => {
      db = getSharedDatabase();
      await setupDatabase(db);
      await seedTestData(db);
    });

    test('correlated probes in a projection: scalar with ORDER BY / LIMIT, exists, notExists, a count — and how each reads back', async () => {
      const rows = await db.users
        .select(u => ({
          name: u.username,
          topPost: db.posts.as('p2').where(p => eq(p.userId, u.id)).orderBy(p => [[p.views, 'DESC']]).limit(1).scalar(p => p.title),
          hasPosts: db.posts.as('p2').where(p => eq(p.userId, u.id)).exists(),
          noPosts: db.posts.as('p2').where(p => eq(p.userId, u.id)).notExists(),
          postCount: db.posts.as('p2').where(p => eq(p.userId, u.id)).scalar(() => sql<number>`count(*)`),
          lastActive: db.users.as('u2').where(v => eq(v.id, u.id)).scalar(v => v.lastActiveAt),
        }))
        .toList();

      const byName = new Map(rows.map(row => [row.name, row]));

      expect(byName.get('alice')).toEqual({
        name: 'alice',
        topPost: 'Alice Post 2',
        hasPosts: true,
        noPosts: false,
        // count(*) is an int8 the drivers hand back as text: a mapper-less scalar reads it as a number
        postCount: 2,
        // the selected column's mapper applies
        lastActive: new Date('2025-03-15T08:00:00Z'),
      });
      expect(byName.get('bob')!.topPost).toBe('Bob Post');
      expect(byName.get('bob')!.postCount).toBe(1);

      const charlie = byName.get('charlie')!;
      // no row qualifies: NULL, which a mapper-less top-level value reads as undefined
      expect(charlie.topPost).toBeUndefined();
      expect(charlie.hasPosts).toBe(false);
      expect(charlie.noPosts).toBe(true);
      expect(charlie.postCount).toBe(0);
    });

    test('a navigation the scope reads from the enclosing row is joined there (R4) — two levels deep too', async () => {
      const statements = await captureStatements(db, async () => {
        const rows = await db.tasks
          .select(t => ({
            title: t.title,
            creatorAge: db.users.as('u2').where(u => eq(u.id, t.level!.createdBy!.id)).scalar(u => castAsInt(u.age)),
            creatorHasPosts: db.posts.as('p2').where(p => eq(p.userId, t.level!.createdBy!.id)).exists(),
          }))
          .toList();

        const byTitle = new Map(rows.map(row => [row.title, row]));
        expect(byTitle.get('Important Task')).toEqual({ title: 'Important Task', creatorAge: 25, creatorHasPosts: true });
        expect(byTitle.get('Regular Task')).toEqual({ title: 'Regular Task', creatorAge: 35, creatorHasPosts: true });
      });

      const select = statements.find(statement => statement.includes('"u2"'))!;
      expect(select).toContain('JOIN "task_levels" AS "level"');
      expect(select).toContain('JOIN "users" AS "createdBy"');
      expect(select).toContain('"u2"."id" = "createdBy"."id"');
    });

    test('in a WHERE: the navigation it reads is joined too', async () => {
      const titles = await db.posts
        .where(p => db.users.as('u2').where(u => and(eq(u.id, p.user!.id), gt(u.age, 30))).exists())
        .select(p => p.title)
        .toList();

      expect(titles).toEqual(['Bob Post']);
    });

    test('a same-table correlation works under a private alias, and is refused under the enclosing alias', async () => {
      const rows = await db.posts
        .select(p => ({
          title: p.title,
          outranked: db.posts.as('rival').where(r => and(eq(r.userId, p.userId), gt(r.views, p.views))).exists(),
        }))
        .toList();

      expect(new Map(rows.map(row => [row.title, row.outranked]))).toEqual(new Map([
        ['Alice Post 1', true],
        ['Alice Post 2', false],
        ['Bob Post', false],
      ]));

      await expectToReject(
        db.posts.select(p => ({ x: db.posts.as('posts').where(r => eq(r.userId, p.userId)).exists() })).toList(),
        /the alias "posts" is both one of the scope's own aliases/
      );
    });

    test('an entity subquery nested in the scope reads the scope\'s row as a correlation, also under an alias it has a navigation of', async () => {
      // `user` is also the name of the posts' navigation: the nested query used to join a "user" of its
      // own and bind the correlation to it — every user came back `hot`
      let rows: Array<{ name: string; hot: boolean }> = [];

      const statements = await captureStatements(db, async () => {
        rows = await db.users
          .select(u => ({
            name: u.username,
            hot: db.users.as('user')
              .where(s => and(
                eq(s.id, u.id),
                exists(db.posts.where(p => and(eq(p.userId, s.id), gt(p.views, 180))).select(p => ({ id: p.id })).asSubquery()),
              ))
              .exists(),
          }))
          .toList();
      });

      expect(new Map(rows.map(row => [row.name, row.hot]))).toEqual(new Map([
        ['alice', false],
        ['bob', true],
        ['charlie', false],
      ]));
      expect(statements[0]).not.toContain('JOIN "users" AS "user"');
      expect(statements[0]).toContain('"posts"."user_id" = "user"."id"');
    });

    test('grouped by an expression: a scope in the SELECT and in the HAVING reads the grouping key of the grouped rows', async () => {
      const olderThan30 = (key: any) => db.users.as('u2').where(u => and(eq(u.id, key), gt(u.age, 30))).exists();
      const grouped = () => db.posts.select(p => ({ userId: p.userId })).groupBy(p => ({ id: add(p.userId, 0) }));

      // The grouping key renders qualified by the grouped subquery: inside the scope a bare "id" was
      // the scope's own "u2"."id", and the correlation compared the row with itself
      let selected: Array<{ uid: number; olderThan30: boolean }> = [];
      const [selectSql] = await captureStatements(db, async () => {
        selected = await grouped().select(g => ({ uid: g.key.id, olderThan30: olderThan30(g.key.id) })).toList();
      });
      expect(new Map(selected.map(row => [Number(row.uid), row.olderThan30]))).toEqual(new Map([
        [1, false],
        [2, true],
      ]));
      expect(selectSql).toContain('WHERE ("u2"."id" = "q1"."id" AND "u2"."age" > $');

      const having = await grouped().having(g => olderThan30(g.key.id)).select(g => ({ uid: g.key.id })).toList();
      expect(having.map(row => Number(row.uid))).toEqual([2]);
    });

    test('one scope feeds both legs of an or(): the legs stay independent', async () => {
      const authored = db.posts.as('p2');

      const names = await db.users
        .where(u => or(
          authored.where(p => and(eq(p.userId, u.id), gt(p.views, 180))).exists(),
          authored.where(p => and(eq(p.userId, u.id), lt(p.views, 120))).exists(),
        ))
        .select(u => u.username)
        .toList();

      expect([...names].sort()).toEqual(['alice', 'bob']);
    });

    test('a scope inside another scope', async () => {
      const rows = await db.users
        .select(u => ({
          name: u.username,
          best: db.users.as('u2')
            .where(v => eq(v.id, u.id))
            .scalar(v => db.posts.as('p2').where(p => eq(p.userId, v.id)).orderBy(p => [[p.views, 'DESC']]).limit(1).scalar(p => p.title)),
        }))
        .toList();

      expect(new Map<string, string | undefined>(rows.map(row => [row.name, row.best]))).toEqual(new Map<string, string | undefined>([
        ['alice', 'Alice Post 2'],
        ['bob', 'Bob Post'],
        ['charlie', undefined],
      ]));
    });

    for (const strategy of ['lateral', 'cte'] as const) {
      test(`inside a collection's projection (${strategy}): correlated to the collection's item, read as JSON values`, async () => {
        const collectionDb = getSharedDatabase({ collectionStrategy: strategy });

        const rows = await collectionDb.users
          .select(u => ({
            name: u.username,
            posts: u.posts!.select(p => ({
              title: p.title,
              rival: db.posts.as('p2').where(q => and(eq(q.userId, p.userId), ne(q.id, p.id))).scalar(q => q.title),
              hasRival: db.posts.as('p2').where(q => and(eq(q.userId, p.userId), ne(q.id, p.id))).exists(),
            })).toList(),
          }))
          .toList();

        const posts: Array<{ title: string; rival: string | null; hasRival: boolean }> = rows.flatMap(row => row.posts)
          .sort((a, b) => a.title.localeCompare(b.title));
        expect(posts).toEqual([
          { title: 'Alice Post 1', rival: 'Alice Post 2', hasRival: true },
          { title: 'Alice Post 2', rival: 'Alice Post 1', hasRival: true },
          // NULL inside a collection item stays null
          { title: 'Bob Post', rival: null, hasRival: false },
        ]);
      });
    }

    test('in a CTE body', async () => {
      const cteBuilder = new DbCteBuilder();
      const stats = cteBuilder.with('user_post_stats', db.users.select(u => ({
        id: u.id,
        posts: db.posts.as('p2').where(p => eq(p.userId, u.id)).scalar(p => castAsInt(sql<number>`count(*)`)),
      })));

      const rows = await db.selectFromCte(stats.cte).select(r => ({ id: r.id, posts: r.posts })).toList();

      expect([...rows].sort((a, b) => a.id - b.id)).toEqual([
        { id: 1, posts: 2 },
        { id: 2, posts: 1 },
        { id: 3, posts: 0 },
      ]);
    });
  });

  test('scalar() of a text column holding digits reads the text, as the column itself does', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      await db.users.where(u => eq(u.id, users.alice.id)).update({ username: '0042' });

      const rows = await db.users
        .where(u => eq(u.id, users.alice.id))
        .select(u => ({
          direct: u.username,
          viaScope: db.users.as('u2').where(x => eq(x.id, u.id)).scalar(x => x.username),
          // An outer ref selected as the scope's value reads as its column too
          outerViaScope: db.posts.as('p2').where(p => eq(p.userId, u.id)).limit(1).scalar(() => u.username),
        }))
        .toList();

      expect(rows).toEqual([{ direct: '0042', viaScope: '0042', outerViaScope: '0042' }]);
    });
  });

  test('in an UPDATE WHERE: correlated to the updated row, its params numbered with the statement\'s', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const update = () => db.users
        .where(u => and(gt(u.age, 20), db.posts.as('p2').where(p => and(eq(p.userId, u.id), gt(p.views, 120))).exists()))
        .update({ age: 99 });

      const compiled = update().toStatement();
      expect(compiled.sql).toBe(
        'UPDATE "users" SET "age" = $1 WHERE ("users"."age" > $2 AND EXISTS (SELECT 1 FROM "posts" AS "p2" '
        + 'WHERE ("p2"."user_id" = "users"."id" AND "p2"."views" > $3)))'
      );
      expect(compiled.params).toEqual([99, 20, 120]);

      expect(await update().affectedCount()).toBe(2);

      const ages = await db.users.select(u => ({ name: u.username, age: u.age })).toList();
      expect(new Map(ages.map(row => [row.name, row.age]))).toEqual(new Map([
        ['alice', 99],
        ['bob', 99],
        ['charlie', 45],
      ]));
    });
  });
});
