import { describe, expect, test } from 'bun:test';
import { DbCteBuilder, JoinQueryBuilder, eq, sql } from '../../src';
import type { QueryOptions } from '../../src';
import { expectToReject } from '../utils/expect-rejects';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * Every value of a projection reads back the way it would at the top level of its own table's
 * query — through its column's mapper, typed as the driver types its column — wherever it sits: in
 * a nested object, in a navigation row projected whole, next to a collection under any strategy.
 *
 * What used to happen instead:
 *  - every numeric-looking string of a nested object became a number (a username '01234' read back
 *    as 1234), and a navigation's text column did the same at the top level;
 *  - a nested value's mapper never ran (a smallint time came back as 570, a `mapWith` was skipped);
 *  - a navigation row projected whole (`author: p.user`) rendered as ONE json_build_object: its
 *    timestamps came back as strings, its mapped columns unmapped, a DISTINCT over it failed (json
 *    has no equality operator) and a UNION leg read back "{}";
 *  - `where(...).select(u => ({ me: u }))` read the row unmapped;
 *  - the temp-table strategy dropped the columns of a nested object next to a collection;
 *  - `select(() => 'x')` read back `[{ "0": "x" }]`, a number projected nothing at all;
 *  - an array of columns (`[u.id, u.username]`) vanished from the result, or — nested — was bound
 *    as a parameter with the column refs serialized into it.
 *
 * `publishTime` (smallint) and `customDate` / `lastActiveAt` (integer) carry custom mappers.
 */

/** Query options capturing every statement the query runs. */
const capturing = (): { statements: string[]; options: QueryOptions } => {
  const statements: string[] = [];

  return { statements, options: { logQueries: true, logger: (message: string) => { statements.push(message); } } };
};

const bobPostTime = { hour: 18, minute: 45 };

describe('nested objects', () => {
  test('each value reads through its own mapper: a column, a navigation column, an sql mapWith', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const row = await db.posts
        .where(p => eq(p.title, 'Bob Post'))
        .select(p => ({
          meta: {
            time: p.publishTime,
            day: p.customDate,
            seen: p.user!.lastActiveAt,
            loud: sql<string>`upper(${p.title})`.mapWith((value: string) => `<${value}>`),
          },
        }))
        .first();

      expect(row!.meta).toEqual({
        time: bobPostTime,
        day: new Date('2024-01-15T10:00:00Z'),
        seen: users.bob.lastActiveAt!,
        loud: '<BOB POST>',
      });
      expect(row!.meta.day).toBeInstanceOf(Date);
    });
  });

  test('a text value holding digits stays text; a count and an sql number become numbers', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const zip = await db.users.insert({ username: '01234', email: '56789', age: 7 }).returning();
      await db.posts.insert({ title: '000', userId: zip.id, views: 3 });

      const rows = await db.users
        .where(u => eq(u.id, zip.id))
        .select(u => ({
          info: {
            name: u.username,
            email: u.email,
            count: u.posts!.count(),
            doubled: sql<number>`${u.age} * 2`,
            views: sql<number>`(select sum(views) from posts where user_id = ${u.id})`,
          },
        }))
        .toList();

      expect(rows).toEqual([{ info: { name: '01234', email: '56789', count: 1, doubled: 14, views: 3 } }]);
      expect(typeof rows[0].info.name).toBe('string');
    });
  });

  test('NULL stays null in a nested object — a column, a navigation column, an undefined value', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      await db.tasks.insert({ title: 'no level', status: 'pending', priority: 'low', levelId: null as any });

      const rows = await db.tasks
        .where(t => eq(t.title, 'no level'))
        .select(t => ({ x: { level: t.levelId, name: t.level!.name, gone: undefined } }))
        .toList();

      expect(rows as unknown[]).toEqual([{ x: { level: null, name: null, gone: null } }]);
    });
  });

  test('literals of a nested object read back as themselves, next to columns', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const at = new Date('2020-02-02T02:02:02Z');

      const row = await db.posts
        .where(p => eq(p.title, 'Alice Post 1'))
        .select(p => ({ meta: { kind: 'post', named: 'title', flag: true, n: 42, at, none: null, tags: ['a', 'b'], title: p.title } }))
        .first();

      expect(row!.meta).toEqual({ kind: 'post', named: 'title', flag: true, n: 42, at, none: null, tags: ['a', 'b'], title: 'Alice Post 1' });
    });
  });

  test('three levels deep, each value read its own way', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const row = await db.posts
        .where(p => eq(p.title, 'Alice Post 2'))
        .select(p => ({ a: { b: { c: { time: p.publishTime, name: p.user!.username, kind: 'deep' }, views: p.views }, id: p.id } }))
        .first();

      expect(row!.a.b).toEqual({ c: { time: { hour: 14, minute: 0 }, name: 'alice', kind: 'deep' }, views: 150 });
    });
  });

  test('the row a where() hands on, projected whole, reads through its mappers', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const rows = await db.users.where(u => eq(u.username, 'bob')).select(u => ({ me: u })).toList();

      expect(rows).toHaveLength(1);
      expect(rows[0].me.username).toBe('bob');
      expect(rows[0].me.lastActiveAt).toEqual(users.bob.lastActiveAt!);
      expect(rows[0].me.createdAt).toBeInstanceOf(Date);

      // Nested one level deeper too (it used to be bound as a parameter there)
      const nested = await db.users.where(u => eq(u.username, 'bob')).select(u => ({ wrap: { me: u } })).first();
      expect(nested!.wrap.me.lastActiveAt).toEqual(users.bob.lastActiveAt!);
    });
  });
});

describe('navigation rows projected whole', () => {
  test('a navigation row reads its columns typed and through their mappers', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const row = await db.posts.where(p => eq(p.title, 'Bob Post')).select(p => ({ id: p.id, author: p.user })).first();

      expect(row!.author!.username).toBe('bob');
      expect(row!.author!.createdAt).toBeInstanceOf(Date);
      expect(row!.author!.lastActiveAt).toEqual(users.bob.lastActiveAt!);
      expect(row!.author!.isActive).toBe(true);
    });
  });

  test('a navigation row renders as its columns, not as one json_build_object', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const { statements, options } = capturing();

      await db.posts.withQueryOptions(options).where(p => eq(p.title, 'Bob Post')).select(p => ({ author: p.user })).toList();

      const statement = statements.join('\n');
      expect(statement).toContain('"__nested__author__createdAt"');
      expect(statement).not.toContain('json_build_object');
    });
  });

  test('a missing navigation row reads as an object of nulls', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      await db.tasks.insert({ title: 'no level', status: 'pending', priority: 'low', levelId: null as any });

      const row = await db.tasks.where(t => eq(t.title, 'no level')).select(t => ({ level: t.level })).first();

      expect(row!.level as unknown).toEqual({ id: null, name: null, createdById: null });
    });
  });

  test('a navigation row two hops deep', async () => {
    await withDatabase(async db => {
      const { users, tasks } = await seedTestData(db);

      const rows = await db.tasks.orderBy(t => t.id).select(t => ({ id: t.id, creator: t.level!.createdBy })).toList();

      expect(rows.map(r => [r.id, r.creator!.username])).toEqual([
        [tasks.task1.id, 'alice'],
        [tasks.task2.id, 'bob'],
      ]);
      expect(rows[0].creator!.lastActiveAt).toEqual(users.alice.lastActiveAt!);
    });
  });

  test('the root row itself, projected under a key', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const row = await db.users.select(u => ({ me: u })).orderBy(r => r.me.id).first();

      expect(row!.me.id).toBe(users.alice.id);
      expect(row!.me.lastActiveAt).toEqual(users.alice.lastActiveAt!);
    });
  });

  test('DISTINCT over a navigation row', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.posts.selectDistinct(p => ({ author: p.user })).toList();

      expect(rows.map(r => r.author!.username).sort()).toEqual(['alice', 'bob']);
    });
  });

  test('UNION legs projecting navigation rows', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const rows = await db.posts
        .where(p => eq(p.title, 'Bob Post'))
        .select(p => ({ title: p.title, author: p.user }))
        .unionAll(db.posts.where(p => eq(p.title, 'Alice Post 1')).select(p => ({ title: p.title, author: p.user })))
        .toList();

      const byTitle = Object.fromEntries(rows.map(r => [r.title, r.author!]));
      expect(byTitle['Bob Post'].username).toBe('bob');
      expect(byTitle['Alice Post 1'].lastActiveAt).toEqual(users.alice.lastActiveAt!);
      expect(byTitle['Bob Post'].createdAt).toBeInstanceOf(Date);
    });
  });

  test('first, future, countOver and a prepared statement read it alike', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const query = () => db.posts.where(p => eq(p.title, 'Bob Post')).select(p => ({ id: p.id, author: p.user }));

      const first = await query().first();
      const counted = await (query() as any).countOver();
      const prepared = await (db.posts.where(p => eq(p.title, sql.placeholder('title'))).select(p => ({ author: p.user })) as any)
        .prepare('projection_reads_nav_row')
        .execute({ title: 'Bob Post' });

      for (const author of [first!.author!, counted.data[0].author, prepared[0].author]) {
        expect(author.username).toBe('bob');
        expect(author.lastActiveAt).toEqual(users.bob.lastActiveAt!);
        expect(author.createdAt).toBeInstanceOf(Date);
      }

      expect(counted.totalCount).toBe(1);
    });
  });

  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`next to a collection (${strategy} strategy)`, async () => {
      await withDatabase(async db => {
        const { users } = await seedTestData(db);

        const rows = await db.posts
          .withQueryOptions({ collectionStrategy: strategy })
          .where(p => eq(p.title, 'Bob Post'))
          .select(p => ({
            author: p.user,
            meta: { time: p.publishTime, kind: 'post' },
            comments: p.postComments!.select(c => ({ comment: c.comment })).toList(),
          }))
          .toList();

        expect(rows).toHaveLength(1);
        expect(rows[0].author!.lastActiveAt).toEqual(users.bob.lastActiveAt!);
        expect(rows[0].meta).toEqual({ time: bobPostTime, kind: 'post' });
        expect(rows[0].comments).toEqual([{ comment: 'My order update' }]);
      });
    });
  }
});

describe('the temp-table strategy', () => {
  test('a nested object next to a collection keeps its columns (the base query carried them flattened)', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      // No parameter in the base query and a plain list: the single round trip where the client
      // runs several statements at once, the two-phase path elsewhere
      const rows = await db.users
        .withQueryOptions({ collectionStrategy: 'temptable' })
        .orderBy(u => u.id)
        .select(u => ({ id: u.id, meta: { name: u.username, seen: u.lastActiveAt }, posts: u.posts!.select(p => ({ title: p.title })).toList() }))
        .toList();

      expect(rows.map(r => r.meta)).toEqual([
        { name: 'alice', seen: users.alice.lastActiveAt! },
        { name: 'bob', seen: users.bob.lastActiveAt! },
        { name: 'charlie', seen: users.charlie.lastActiveAt! },
      ]);
      expect(rows[0].posts.map(p => p.title).sort()).toEqual(['Alice Post 1', 'Alice Post 2']);
    });
  });

  test('a collection inside the nested object lands next to its columns', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .withQueryOptions({ collectionStrategy: 'temptable' })
        .where(u => eq(u.username, 'alice'))
        .select(u => ({ id: u.id, meta: { name: u.username, count: u.posts!.count(), titles: u.posts!.select(p => ({ t: p.title })).toList() } }))
        .toList();

      expect(rows[0].meta.name).toBe('alice');
      expect(rows[0].meta.count).toBe(2);
      expect(rows[0].meta.titles.map(t => t.t).sort()).toEqual(['Alice Post 1', 'Alice Post 2']);
    });
  });
});

describe('navigation columns', () => {
  test('a text column holding digits stays text', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const zip = await db.users.insert({ username: '01234', email: '56789', age: 1 }).returning();
      await db.posts.insert({ title: 'zip post', userId: zip.id, views: 1 });

      const rows = await db.posts.where(p => eq(p.title, 'zip post')).select(p => ({ name: p.user!.username, email: p.user!.email })).toList();

      expect(rows).toEqual([{ name: '01234', email: '56789' }]);
    });
  });

  test('a jsonb column holding a JSON string stays a string', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const zip = await db.users.insert({ username: 'json-string', email: 'j@x', age: 1, metadata: sql`'"123"'::jsonb` as any }).returning();
      await db.posts.insert({ title: 'json post', userId: zip.id, views: 1 });

      const root = await db.users.where(u => eq(u.id, zip.id)).select(u => ({ m: u.metadata })).first();
      const navigated = await db.posts.where(p => eq(p.title, 'json post')).select(p => ({ m: p.user!.metadata })).first();

      expect(root).toEqual({ m: '123' });
      expect(navigated).toEqual({ m: '123' });
    });
  });

  test('a numeric column read through a navigation keeps reading as a number', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      // Unchanged: at the top level a decimal column reads as the driver's string, through a
      // navigation as a number
      const rows = await db.postComments.orderBy(c => c.id).select(c => ({ total: c.order!.totalAmount })).toList();

      expect(rows).toEqual([{ total: 99.99 }, { total: 149.99 }, { total: 149.99 }]);
    });
  });
});

describe('a selector returning one literal', () => {
  test('reads as that literal on every row — a string that names a column included', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const at = new Date('2021-03-04T05:06:07Z');

      expect(await db.users.select(() => 'x').toList()).toEqual(['x', 'x', 'x']);
      expect(await db.users.select(() => 'username').toList()).toEqual(['username', 'username', 'username']);
      expect(await db.users.select(() => 7).toList()).toEqual([7, 7, 7]);
      expect(await db.users.select(() => false).toList()).toEqual([false, false, false]);
      expect(await db.users.select(() => null).toList()).toEqual([null, null, null]);
      expect(await db.users.where(u => eq(u.username, 'bob')).select(() => at).toList()).toEqual([at]);
      expect(await db.users.where(u => eq(u.username, 'bob')).select(() => 'only').first()).toBe('only');
    });
  });

  test('in a collection: toList, firstOrDefault, toNumberList and toStringList', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const rows = await db.users
        .orderBy(u => u.id)
        .select(u => ({
          id: u.id,
          strings: u.posts!.select(() => 'x').toList(),
          first: u.posts!.select(() => 'first').firstOrDefault(),
          numbers: u.posts!.select(() => 7).toNumberList(),
          texts: u.posts!.select(() => 'y').toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { id: users.alice.id, strings: ['x', 'x'], first: 'first', numbers: [7, 7], texts: ['y', 'y'] },
        { id: users.bob.id, strings: ['x'], first: 'first', numbers: [7], texts: ['y'] },
        { id: users.charlie.id, strings: [], first: null, numbers: [], texts: [] },
      ]);
    });
  });

  test('UNION legs of one literal each', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users.where(u => eq(u.username, 'alice')).select(() => 'a')
        .unionAll(db.users.where(u => eq(u.username, 'bob')).select(() => 'b'))
        .toList();

      expect([...rows].sort()).toEqual(['a', 'b']);
    });
  });
});

describe('an array in a projection', () => {
  test('an array of columns is refused wherever it is projected', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const cte = new DbCteBuilder().with('array_refusal', db.users.select(u => ({ uid: u.id, name: u.username })));

      await expectToReject(() => db.users.select(u => ({ pair: [u.id, u.username] })).toList(), /"pair" is an array of columns/);
      await expectToReject(() => db.users.select(u => ({ meta: { pair: [u.id, 1] } })).toList(), /"meta\.pair" is an array of columns/);
      await expectToReject(() => db.users.select(u => ({ rows: [u] })).toList(), /array of columns/);
      await expectToReject(() => db.posts.select(p => ({ authors: [p.user] })).toList(), /array of columns/);
      await expectToReject(
        () => db.users.select(u => ({ posts: u.posts!.select(p => ({ pair: [p.id, p.title] })).toList() })).toList(),
        /"pair" is an array of columns/
      );
      await expectToReject(
        () => db.users.select(u => ({ pair: [u.id] })).unionAll(db.users.select(u => ({ pair: [u.id] }))).toList(),
        /array of columns/
      );
      expect(() => db.selectFromCte(cte.cte).select(x => ({ pair: [x.uid, x.name] })).toSql()).toThrow(/"pair" is an array of columns/);

      const grouped = db.posts
        .select(p => ({ uid: p.userId, views: p.views }))
        .groupBy(p => ({ uid: p.uid }))
        .select(g => ({ uid: g.key.uid, total: g.sum(p => p.views) }));
      await expectToReject(
        () => grouped.leftJoin(cte.cte, (g, x) => eq(g.uid, x.uid), (g, x) => ({ pair: [g.uid, x.name] })).toList(),
        /"pair" is an array of columns/
      );
    });
  });

  test('an array of values reads back as itself, at the top level, nested and in a collection', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const row = await db.users
        .where(u => eq(u.username, 'bob'))
        .select(u => ({ tags: ['a', 'b'], empty: [], meta: { ids: [1, 2], rows: [{ k: 1 }] }, posts: u.posts!.select(() => ({ list: [3, 4] })).toList() }))
        .first();

      expect(row).toEqual({ tags: ['a', 'b'], empty: [], meta: { ids: [1, 2], rows: [{ k: 1 }] }, posts: [{ list: [3, 4] }] });
    });
  });

  test('JoinQueryBuilder: a list or object of values reads as itself, one of columns is refused', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const posts = (db.posts as any)._getSchema();
      const users = (db.users as any)._getSchema();
      const client = (db.posts as any)._getClient();
      const on = eq({ __dbColumnName: 'user_id', __tableAlias: 'p' } as any, { __dbColumnName: 'id', __tableAlias: 'u' } as any);

      const join = new JoinQueryBuilder<any, any>(posts, 'p', users, 'u', 'INNER', on, client);
      join._setSelection((p: any, u: any) => ({ title: p.title, tags: ['a'], meta: { n: 1 }, at: new Date('2020-01-01T00:00:00Z'), who: u.username }));
      const rows = await join.orderBy((p: any) => p.id).toList();
      expect(rows[0]).toEqual({ title: 'Alice Post 1', tags: ['a'], meta: { n: 1 }, at: new Date('2020-01-01T00:00:00Z'), who: 'alice' });

      const refused = new JoinQueryBuilder<any, any>(posts, 'p', users, 'u', 'INNER', on, client);
      refused._setSelection((p: any, u: any) => ({ pair: [p.id, u.id] }));
      await expectToReject(() => refused.toList(), /"pair" is an array of columns/);

      const refusedObject = new JoinQueryBuilder<any, any>(posts, 'p', users, 'u', 'INNER', on, client);
      refusedObject._setSelection((p: any) => ({ meta: { id: p.id } }));
      await expectToReject(() => refusedObject.toList(), /"meta" is an object of columns/);
    });
  });
});
