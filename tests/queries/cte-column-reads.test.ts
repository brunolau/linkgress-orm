import { describe, expect, test } from 'bun:test';
import { DbCteBuilder, and, eq, gt, isNull, lt, sql } from '../../src';
import type { QueryOptions } from '../../src';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * A column of a CTE body (or a table subquery) reads back — through a join, at a CTE root, in a
 * comparison — the way the body's own projection reads it: through the body column's OWN mapper,
 * typed as the body typed it.
 *
 * What used to happen instead:
 *  - the refs of a CTE's columns carried a `mapWith` mapper only: a mapped column read through a CTE
 *    came back as its storage value, and a comparison with it bound the JS value unconverted;
 *  - a CTE column named like a mapped column of the READING table went through THAT column's mapper
 *    (a count named `lastActiveAt` read back as a Date);
 *  - every numeric-looking text read back as a number ('01234' as 1234);
 *  - the body's literals rode it as untyped parameters, so the reader got text: `true` as 'true',
 *    and `gt(x.n, 5)` over a literal 42 compared strings ('42' > '5' is false);
 *  - a nested object or a navigation row of the body could not be selected at all (the reader named
 *    a column the body does not have);
 *  - `withAggregation` items went through the READING table's mappers, found by name, and a nested
 *    object in them was aggregated from a column that does not exist;
 *  - `innerJoin` of a CTE threw "rightTable._getSchema is not a function" (so did
 *    `db.<table>.leftJoin(cte, ...)`), though the typings offer both;
 *  - in `selectFromCte(...).select(...)` a string rendered as a column of that NAME, a nested object
 *    was bound as one parameter, and a selector returning one column projected that ref's own keys.
 *
 * `publishTime` (smallint) and `customDate` / `lastActiveAt` (integer) carry custom mappers.
 */

const capturing = (): { statements: string[]; options: QueryOptions } => {
  const statements: string[] = [];

  return { statements, options: { logQueries: true, logger: (message: string) => { statements.push(message); } } };
};

const times = {
  alicePost1: { hour: 9, minute: 30 },
  alicePost2: { hour: 14, minute: 0 },
  bobPost: { hour: 18, minute: 45 },
};
const day15 = new Date('2024-01-15T10:00:00Z');
const day16 = new Date('2024-01-16T10:00:00Z');

describe('a column read through a CTE', () => {
  test('a mapped column reads through its own mapper — joined and at a CTE root', async () => {
    await withDatabase(async db => {
      const { users, posts } = await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_post_times', db.posts.select(p => ({ pid: p.id, uid: p.userId, t: p.publishTime, day: p.customDate })));

      const joined = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, pid: x.pid, t: x.t, day: x.day }))
        .orderBy(r => r.pid)
        .toList();

      expect(joined).toEqual([
        { name: 'alice', pid: posts.alicePost1.id, t: times.alicePost1, day: day15 },
        { name: 'alice', pid: posts.alicePost2.id, t: times.alicePost2, day: day16 },
        { name: 'bob', pid: posts.bobPost.id, t: times.bobPost, day: day15 },
      ]);

      const root = await db.selectFromCte(cte.cte).select(x => ({ pid: x.pid, t: x.t, day: x.day })).orderBy(r => r.pid).toList();

      expect(root).toEqual([
        { pid: posts.alicePost1.id, t: times.alicePost1, day: day15 },
        { pid: posts.alicePost2.id, t: times.alicePost2, day: day16 },
        { pid: posts.bobPost.id, t: times.bobPost, day: day15 },
      ]);
      expect(users.alice.id).toBe(joined[0].pid === posts.alicePost1.id ? users.alice.id : -1);
    });
  });

  test('a CTE column named like a mapped column of the reading table keeps its own reading', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_post_views', db.posts.select(p => ({ uid: p.userId, lastActiveAt: p.views })));

      const rows = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, lastActiveAt: x.lastActiveAt }))
        .toList();

      expect(rows.map(r => r.lastActiveAt as unknown).sort()).toEqual([100, 150, 200]);
    });
  });

  test('a text column holding digits stays text — joined and at a CTE root', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const zip = await db.users.insert({ username: '01234', email: '56789', age: 1 }).returning();
      const cte = new DbCteBuilder().with('cr_names', db.users.select(u => ({ uid: u.id, name: u.username, email: u.email })));

      const root = await db.selectFromCte(cte.cte).select(x => ({ uid: x.uid, name: x.name, email: x.email })).orderBy(r => r.uid).toList();
      expect(root[root.length - 1]).toEqual({ uid: zip.id, name: '01234', email: '56789' });

      const joined = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ id: u.id, name: x.name, email: x.email }))
        .where(r => eq(r.id, zip.id))
        .toList();
      expect(joined).toEqual([{ id: zip.id, name: '01234', email: '56789' }]);
    });
  });

  test('a comparison with a mapped CTE column converts its value through the column mapper', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_mapped_compare', db.posts.select(p => ({ pid: p.id, t: p.publishTime })));

      const rows = await db.posts
        .with(cte.cte)
        .innerJoin(cte.cte, (p, x) => and(eq(p.id, x.pid), eq(x.t, times.alicePost1 as any)), (p, x) => ({ title: p.title, t: x.t }))
        .toList();

      expect(rows).toEqual([{ title: 'Alice Post 1', t: times.alicePost1 }]);
    });
  });

  test('a decimal and an aggregate column keep reading as numbers', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_order_totals', db.orders.select(o => ({ uid: o.userId, total: o.totalAmount, doubled: sql<number>`${o.totalAmount} * 2` })));

      const rows = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, total: x.total, doubled: x.doubled }))
        .orderBy(r => r.name)
        .toList();

      expect(rows).toEqual([
        { name: 'alice', total: 99.99, doubled: 199.98 },
        { name: 'bob', total: 149.99, doubled: 299.98 },
      ]);
    });
  });
});

describe('literal columns of a CTE body', () => {
  const at = new Date('2020-01-01T00:00:00Z');

  test('each literal is typed from its JS type and reads back as its value — joined and at a CTE root', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_literals', db.users.select(u => ({
        uid: u.id, flag: true, off: false, n: 42, f: 1.5, kind: 'k', named: 'uid', at, nothing: null,
      })));

      const root = await db.selectFromCte(cte.cte)
        .select(x => ({ uid: x.uid, flag: x.flag, off: x.off, n: x.n, f: x.f, kind: x.kind, named: x.named, at: x.at, nothing: x.nothing }))
        .orderBy(r => r.uid)
        .first();

      expect(root).toEqual({ uid: users.alice.id, flag: true, off: false, n: 42, f: 1.5, kind: 'k', named: 'uid', at, nothing: null });
      expect(root!.at).toBeInstanceOf(Date);

      const joined = await db.posts
        .with(cte.cte)
        .innerJoin(cte.cte, (p, x) => eq(p.userId, x.uid), (p, x) => ({ title: p.title, flag: x.flag, n: x.n, at: x.at, nothing: x.nothing }))
        .where(r => eq(r.title, 'Bob Post'))
        .toList();

      expect(joined).toEqual([{ title: 'Bob Post', flag: true, n: 42, at, nothing: null }]);
    });
  });

  test('a comparison with a literal column compares its type', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_literal_compare', db.users.select(u => ({ uid: u.id, n: 42, flag: true, nothing: null })));

      // '42' > '5' is false as text: the comparison used to drop every row
      const greater = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => and(eq(u.id, x.uid), gt(x.n, 5), lt(x.n, 100), eq(x.flag, true), isNull(x.nothing)), (u, x) => ({ name: u.username, next: sql<number>`${x.n} + 1` }))
        .orderBy(r => r.name)
        .toList();

      expect(greater).toEqual([
        { name: 'alice', next: 43 },
        { name: 'bob', next: 43 },
        { name: 'charlie', next: 43 },
      ]);
    });
  });

  test('the CTE body renders its literals typed; a plain select does not', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_literal_sql', db.users.select(u => ({ uid: u.id, flag: true, n: 42, f: 1.5, kind: 'k', at, tags: ['a'] })));

      expect(cte.cte.query).toContain('CAST($1 AS boolean) as "flag"');
      expect(cte.cte.query).toContain('CAST($2 AS integer) as "n"');
      expect(cte.cte.query).toContain('CAST($3 AS double precision) as "f"');
      expect(cte.cte.query).toContain('CAST($4 AS text) as "kind"');
      expect(cte.cte.query).toContain('CAST($5 AS timestamptz) as "at"');
      expect(cte.cte.query).toContain('CAST(CAST($6 AS text) AS jsonb) as "tags"');
      expect(cte.cte.params).toEqual([true, 42, 1.5, 'k', at, '["a"]']);

      const { statements, options } = capturing();
      await db.users.withQueryOptions(options).select(u => ({ uid: u.id, flag: true })).toList();
      expect(statements.join('\n')).toContain('$1 as "flag"');
      expect(statements.join('\n')).not.toContain('CAST(');
    });
  });

  test('bigint and list literals keep their values', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_big_literals', db.users.select(u => ({ uid: u.id, big: 9007199254740993n, small: 7n, tags: ['a', 'b'], rows: [{ k: 1 }] })));

      const root = await db.selectFromCte(cte.cte).select(x => ({ big: x.big, small: x.small, tags: x.tags, rows: x.rows })).first();
      expect(root).toEqual({ big: 9007199254740993n, small: 7n, tags: ['a', 'b'], rows: [{ k: 1 }] });

      const joined = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, big: x.big, tags: x.tags }))
        .orderBy(r => r.name)
        .first();
      expect(joined).toEqual({ name: 'alice', big: 9007199254740993n, tags: ['a', 'b'] });
    });
  });

  test("a collection's literals in a CTE body arrive typed in its JSON", async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_collection_literals', db.users.select(u => ({
        uid: u.id,
        name: u.username,
        posts: u.posts!.orderBy(p => p.id).select(p => ({ title: p.title, flag: true, n: 42 })).toList(),
      })));

      const rows = await db.selectFromCte(cte.cte).select(x => ({ name: x.name, posts: x.posts })).orderBy(r => r.name).toList();

      expect(rows[1]).toEqual({ name: 'bob', posts: [{ title: 'Bob Post', flag: true, n: 42 }] });
      expect(rows[2]).toEqual({ name: 'charlie', posts: [] });
    });
  });

  test('a grouped CTE body renders its constants typed', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_grouped_literals', db.posts
        .select(p => ({ uid: p.userId, views: p.views }))
        .groupBy(p => ({ uid: p.uid }))
        .select(g => ({ uid: g.key.uid, flag: true, n: 7, total: g.sum(p => p.views) })));

      const rows = await db.selectFromCte(cte.cte).select(x => ({ uid: x.uid, flag: x.flag, n: x.n, total: x.total, big: sql<boolean>`${x.n} > 5` })).orderBy(r => r.uid).toList();

      expect(rows.map(r => [r.flag, r.n, r.total, r.big])).toEqual([
        [true, 7, 250, true],
        [true, 7, 200, true],
      ]);
      expect(cte.cte.query).toContain('CAST(');
    });
  });
});

describe('nested objects and navigation rows of a CTE body', () => {
  test('a nested object is selected as an object, its values through their own mappers', async () => {
    await withDatabase(async db => {
      const { posts } = await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_nested', db.posts.select(p => ({ pid: p.id, uid: p.userId, meta: { t: p.publishTime, title: p.title, kind: 'post' } })));

      const root = await db.selectFromCte(cte.cte).select(x => ({ pid: x.pid, meta: x.meta, t: x.meta.t })).orderBy(r => r.pid).toList();
      expect(root[2]).toEqual({ pid: posts.bobPost.id, meta: { t: times.bobPost, title: 'Bob Post', kind: 'post' }, t: times.bobPost });

      // A nested value is a column ref of its own at runtime (its type reads the object as ONE value:
      // at the type level it cannot be told from a column whose mapped value is an object)
      const joined = await db.users
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => and(eq(u.id, x.uid), eq((x.meta as any).title, 'Bob Post')), (u, x) => ({ name: u.username, meta: x.meta }))
        .toList();
      expect(joined).toEqual([{ name: 'bob', meta: { t: times.bobPost, title: 'Bob Post', kind: 'post' } }]);
    });
  });

  test('a navigation row of the body is selected as the row', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_nav_row', db.posts.select(p => ({ pid: p.id, author: p.user })));

      const rows = await db.selectFromCte(cte.cte)
        .select(x => ({ pid: x.pid, name: x.author!.username, seen: x.author!.lastActiveAt, author: x.author }))
        .orderBy(r => r.pid)
        .toList();

      expect(rows.map(r => r.name)).toEqual(['alice', 'alice', 'bob']);
      expect(rows[2].seen).toEqual(users.bob.lastActiveAt!);
      expect(rows[2].author!.createdAt).toBeInstanceOf(Date);
    });
  });

  test('a nested object of a table subquery', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const sub = db.posts.select(p => ({ pid: p.id, uid: p.userId, meta: { t: p.publishTime, flag: true } })).asSubquery('table');

      const rows = await (db.users as any)
        .innerJoin(sub, (u: any, s: any) => eq(u.id, s.uid), (u: any, s: any) => ({ name: u.username, meta: s.meta, t: s.meta.t }), 'sub')
        .orderBy((r: any) => r.t)
        .toList();

      expect(rows).toEqual([
        { name: 'alice', meta: { t: times.alicePost1, flag: true }, t: times.alicePost1 },
        { name: 'alice', meta: { t: times.alicePost2, flag: true }, t: times.alicePost2 },
        { name: 'bob', meta: { t: times.bobPost, flag: true }, t: times.bobPost },
      ]);
    });
  });
});

describe('withAggregation items', () => {
  test("items read through the aggregated query's own mappers, never the reading table's", async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      // `lastActiveAt` names a mapped column of users (the reading table): the items' column is a count
      const agg = new DbCteBuilder().withAggregation(
        'cr_agg_mappers',
        db.posts.select(p => ({ uid: p.userId, t: p.publishTime, day: p.customDate, lastActiveAt: p.views })),
        r => ({ uid: r.uid }),
        'items'
      );

      const rows = await db.users
        .with(agg)
        .leftJoin(agg, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, items: x.items }))
        .orderBy(r => r.name)
        .toList();

      const sortedItems = (items: any[]) => [...items].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      expect(sortedItems(rows[0].items)).toEqual([
        { t: times.alicePost1, day: day15, lastActiveAt: 100 },
        { t: times.alicePost2, day: day16, lastActiveAt: 150 },
      ]);
      expect(rows[1].items).toEqual([{ t: times.bobPost, day: day15, lastActiveAt: 200 }]);
      expect(rows[2].items).toEqual([]);
    });
  });

  test('nested objects and literals in items', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const at = new Date('2021-01-01T00:00:00Z');
      const agg = new DbCteBuilder().withAggregation(
        'cr_agg_nested',
        db.posts.select(p => ({ uid: p.userId, meta: { t: p.publishTime, title: p.title }, kind: 'post', at, author: p.user })),
        r => ({ uid: r.uid }),
        'items'
      );

      const rows = await db.selectFromCte(agg).select(x => ({ uid: x.uid, items: x.items })).toList();
      const bob = rows.find(r => r.items.length === 1)!;

      expect(bob.items[0].meta).toEqual({ t: times.bobPost, title: 'Bob Post' });
      expect(bob.items[0].kind).toBe('post');
      expect(bob.items[0].at).toEqual(at);
      expect(bob.items[0].at).toBeInstanceOf(Date);
      expect((bob.items[0] as any).author.username).toBe('bob');
    });
  });

  test("a grouping key reads through its column's mapper", async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const agg = new DbCteBuilder().withAggregation(
        'cr_agg_key',
        db.posts.select(p => ({ day: p.customDate, title: p.title })),
        r => ({ day: r.day }),
        'items'
      );

      const rows = await db.selectFromCte(agg).select(x => ({ day: x.day, items: x.items })).orderBy(r => r.day).toList();

      expect(rows.map(r => r.day)).toEqual([day15, day16]);
      expect(rows[0].items.map((i: any) => i.title).sort()).toEqual(['Alice Post 1', 'Bob Post']);
    });
  });

  test('in a join of a grouped query', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const agg = new DbCteBuilder().withAggregation(
        'cr_agg_grouped_join',
        db.posts.select(p => ({ uid: p.userId, t: p.publishTime })),
        r => ({ uid: r.uid }),
        'items'
      );

      const rows = await db.posts
        .select(p => ({ uid: p.userId, views: p.views }))
        .groupBy(p => ({ uid: p.uid }))
        .select(g => ({ uid: g.key.uid, total: g.sum(p => p.views) }))
        .leftJoin(agg, (g, x) => eq(g.uid, x.uid), (g, x) => ({ uid: g.uid, total: g.total, items: x.items }))
        .toList();

      const bob = rows.find(r => r.total === 200)!;
      expect(bob.items).toEqual([{ t: times.bobPost }]);
    });
  });
});

describe('joins of a CTE', () => {
  test('innerJoin accepts a CTE — straight off the table, after a select, and attaches it', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_inner_join', db.posts.where(p => gt(p.views, 120)).select(p => ({ uid: p.userId, views: p.views })));

      const straight = await db.users
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, views: x.views }))
        .orderBy(r => r.views)
        .toList();
      expect(straight).toEqual([{ name: 'alice', views: 150 }, { name: 'bob', views: 200 }]);

      const afterSelect = await db.users
        .select(u => ({ id: u.id, name: u.username }))
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.name, views: x.views }))
        .orderBy(r => r.views)
        .toList();
      expect(afterSelect).toEqual(straight);
    });
  });

  test('leftJoin straight off the table attaches the CTE; one attached already is declared once', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_left_join', db.posts.where(p => gt(p.views, 120)).select(p => ({ uid: p.userId, views: p.views })));
      const { statements, options } = capturing();

      const rows = await db.users
        .leftJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, views: x.views }))
        .orderBy(r => r.name)
        .toList();
      expect(rows as unknown[]).toEqual([{ name: 'alice', views: 150 }, { name: 'bob', views: 200 }, { name: 'charlie', views: undefined }]);

      await db.users
        .withQueryOptions(options)
        .with(cte.cte)
        .innerJoin(cte.cte, (u, x) => eq(u.id, x.uid), (u, x) => ({ name: u.username, views: x.views }))
        .toList();
      expect(statements.join('\n').split('"cr_left_join" AS (').length - 1).toBe(1);
    });
  });
});

describe('selectFromCte projections', () => {
  test('a string is a value — even one that names a column — and literals read as themselves', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_root_literals', db.users.select(u => ({ uid: u.id, name: u.username })));
      const at = new Date('2022-02-02T00:00:00Z');

      const rows = await db.selectFromCte(cte.cte)
        .select(x => ({ uid: x.uid, kind: 'row', named: 'name', n: 5, flag: false, none: null, at, tags: ['t'] }))
        .orderBy(r => r.uid)
        .toList();

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({ uid: rows[0].uid, kind: 'row', named: 'name', n: 5, flag: false, none: null, at, tags: ['t'] });
    });
  });

  test('a nested object of columns is flattened and rebuilt', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_root_nested', db.users.select(u => ({ uid: u.id, name: u.username, seen: u.lastActiveAt })));

      const rows = await db.selectFromCte(cte.cte)
        .select(x => ({ uid: x.uid, who: { name: x.name, seen: x.seen, kind: 'user', deeper: { upper: sql<string>`upper(${x.name})` } } }))
        .orderBy(r => r.uid)
        .toList();

      expect(rows[1]).toEqual({ uid: users.bob.id, who: { name: 'bob', seen: users.bob.lastActiveAt!, kind: 'user', deeper: { upper: 'BOB' } } });
    });
  });

  test('a selector returning one value reads as its values', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_root_scalar', db.posts.select(p => ({ pid: p.id, uid: p.userId, t: p.publishTime })));

      const uids = await db.selectFromCte(cte.cte).select(x => x.uid).orderBy(r => r).toList();
      expect([...uids].sort()).toEqual([users.alice.id, users.alice.id, users.bob.id].sort());

      const mapped = await db.selectFromCte(cte.cte).select(x => x.t).toList();
      expect(mapped).toContainEqual(times.bobPost);

      expect(await db.selectFromCte(cte.cte).select(() => 'x').toList()).toEqual(['x', 'x', 'x']);
      expect(await db.selectFromCte(cte.cte).select(x => sql<number>`${x.pid} * 0`).toList()).toEqual([0, 0, 0]);
    });
  });

  test('a subquery in the projection renders (it used to be bound as a parameter)', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_root_subquery', db.users.select(u => ({ uid: u.id, name: u.username })));

      const rows = await db.selectFromCte(cte.cte)
        .select(x => ({
          name: x.name,
          posts: db.posts.where(p => eq(p.userId, x.uid)).select(() => ({ c: sql<number>`count(*)` })).asSubquery('scalar'),
        }))
        .orderBy(r => r.name)
        .toList();

      expect(rows as unknown[]).toEqual([{ name: 'alice', posts: 2 }, { name: 'bob', posts: 1 }, { name: 'charlie', posts: 0 }]);
    });
  });

  test('as a table subquery its literals are typed for the reading query', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('cr_root_as_subquery', db.users.select(u => ({ uid: u.id })));
      const sub = db.selectFromCte(cte.cte).select(x => ({ uid: x.uid, flag: true, n: 42 })).asSubquery('table');

      const rows = await (db.users as any)
        .innerJoin(sub, (u: any, s: any) => and(eq(u.id, s.uid), gt(s.n, 5)), (u: any, s: any) => ({ name: u.username, flag: s.flag, n: s.n }), 's')
        .orderBy((r: any) => r.name)
        .toList();

      expect(rows).toEqual([
        { name: 'alice', flag: true, n: 42 },
        { name: 'bob', flag: true, n: 42 },
        { name: 'charlie', flag: true, n: 42 },
      ]);
    });
  });
});

describe('table subqueries', () => {
  test('literal columns are typed; a comparison with one compares its type', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const sub = db.users.select(u => ({ uid: u.id, flag: true, n: 42, kind: 'u' })).asSubquery('table');

      const rows = await (db.posts as any)
        .innerJoin(sub, (p: any, s: any) => and(eq(p.userId, s.uid), gt(s.n, 5), eq(s.flag, true)), (p: any, s: any) => ({ title: p.title, flag: s.flag, n: s.n, kind: s.kind }), 'sub')
        .orderBy((r: any) => r.title)
        .toList();

      expect(rows).toEqual([
        { title: 'Alice Post 1', flag: true, n: 42, kind: 'u' },
        { title: 'Alice Post 2', flag: true, n: 42, kind: 'u' },
        { title: 'Bob Post', flag: true, n: 42, kind: 'u' },
      ]);
    });
  });

  test('a mapped column of a table subquery reads through its mapper', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const sub = db.posts.select(p => ({ pid: p.id, t: p.publishTime, day: p.customDate })).asSubquery('table');

      const rows = await (db.posts as any)
        .innerJoin(sub, (p: any, s: any) => eq(p.id, s.pid), (p: any, s: any) => ({ title: p.title, t: s.t, day: s.day }), 'sub')
        .orderBy((r: any) => r.title)
        .toList();

      expect(rows).toEqual([
        { title: 'Alice Post 1', t: times.alicePost1, day: day15 },
        { title: 'Alice Post 2', t: times.alicePost2, day: day16 },
        { title: 'Bob Post', t: times.bobPost, day: day15 },
      ]);
    });
  });

  test("a grouped table subquery's constants are typed", async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const sub = db.posts
        .select(p => ({ uid: p.userId, views: p.views }))
        .groupBy(p => ({ uid: p.uid }))
        .select(g => ({ uid: g.key.uid, flag: true, n: 3, total: g.sum(p => p.views) }))
        .asSubquery('table');

      const rows = await (db.users as any)
        .innerJoin(sub, (u: any, s: any) => and(eq(u.id, s.uid), gt(s.n, 2)), (u: any, s: any) => ({ name: u.username, flag: s.flag, n: s.n, total: s.total }), 'g')
        .orderBy((r: any) => r.name)
        .toList();

      expect(rows).toEqual([
        { name: 'alice', flag: true, n: 3, total: 250 },
        { name: 'bob', flag: true, n: 3, total: 200 },
      ]);
    });
  });
});
