import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DbCteBuilder, JoinQueryBuilder, LinkgressConfig, coalesce, eq, gt, sql } from '../../src';
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

describe('coalesce over columns', () => {
  // COALESCE's result has the type of its operands: over text columns a digits-only value is a name (a
  // document number), not a number. It used to read through the untyped conversion — '90003526000000034'
  // came back as the number 90003526000000030 (rounded past 2^53), '01234' as 1234.
  test('over text columns a digits-only value stays text — root, navigation, nested, literal fallback', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const zip = await db.users.insert({ username: '90003526000000034', email: '01234', age: 7 }).returning();
      await db.posts.insert({ title: 'coalesce post', userId: zip.id, views: 1 });

      const root = await db.users
        .where(u => eq(u.id, zip.id))
        .select(u => ({
          number: coalesce(u.username, u.email),
          fallback: coalesce(u.email, ''),
          nested: { number: coalesce(u.username, u.email) },
        }))
        .first();
      const navigated = await db.posts
        .where(p => eq(p.title, 'coalesce post'))
        .select(p => ({ number: coalesce(p.user!.username, p.title) }))
        .first();

      expect(root).toEqual({ number: '90003526000000034', fallback: '01234', nested: { number: '90003526000000034' } });
      expect(navigated).toEqual({ number: '90003526000000034' });
    });
  });

  test('over a numeric column it keeps reading as a number', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const zip = await db.users.insert({ username: 'coalesce-age', email: 'a@x', age: 7 }).returning();

      const row = await db.users.where(u => eq(u.id, zip.id)).select(u => ({ age: coalesce(u.age, 0) })).first();

      expect(row).toEqual({ age: 7 });
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

/**
 * A result set's rows are rebuilt into their nested objects by ONE fold compiled from the first row's keys
 * (every row of a statement carries the same) — exactly what rebuilding each row key by key gives, key
 * order included. A row with other keys, and a set of keys a fold could rebuild otherwise (a path segment
 * every object has, a value written where a path goes through), is rebuilt key by key.
 */
describe('a result set\'s nested objects, rebuilt by one fold', () => {
  /** The rows rebuilt as a result set, next to each row rebuilt on its own — compared with their key order. */
  const rebuildBoth = (builder: any, rows: any[]): { folded: string; oneByOne: string } => {
    const paths = new Set(rows.flatMap(row => Object.keys(row).filter(key => key.startsWith('__nested__'))));

    return {
      folded: JSON.stringify(builder.reconstructNestedRows(rows.map(row => ({ ...row })), paths)),
      oneByOne: JSON.stringify(rows.map(row => builder.reconstructNestedObjects({ ...row }, paths))),
    };
  };

  const builderOf = (db: any): any => db.posts.select((p: any) => ({ id: p.id, author: p.user }));

  test('a navigation row, nested objects several levels deep, interleaved paths: the same objects, the same key order', async () => {
    await withDatabase(async db => {
      const builder = builderOf(db);
      const shapes: any[][] = [
        [1, 2, 3].map(n => ({ id: n, __nested__author__id: n * 10, __nested__author__username: `u${n}`, __nested__author__createdAt: new Date(n) })),
        [1, 2].map(n => ({ __nested__a__b__c: n, x: 'top', __nested__d__e: [n], __nested__a__f: null, __nested__a__b__g: n + 1, __nested__h: true })),
        [{ id: 1, title: 'no nested value at all' }],
        [{ __nested__a____b: 1, __nested__a__: 2, __nested__: 3 }],
      ];

      for (const rows of shapes) {
        const { folded, oneByOne } = rebuildBoth(builder, rows);
        expect(folded).toBe(oneByOne);
      }

      expect(JSON.parse(rebuildBoth(builder, shapes[1]).folded)[0]).toEqual({ a: { b: { c: 1, g: 2 }, f: null }, x: 'top', d: { e: [1] }, h: true });
      expect(builder.reconstructNestedRows([], new Set(['__nested__a__b']))).toEqual([]);
    });
  });

  test('rows whose keys differ from the first row\'s, keys a fold could rebuild otherwise: each such row rebuilt key by key, alike', async () => {
    await withDatabase(async db => {
      const builder = builderOf(db);
      const mixed = [
        { id: 1, __nested__author__id: 10, __nested__author__name: 'a' },
        { __nested__author__id: 20, id: 2, __nested__author__name: 'b' },
        { id: 3, __nested__author__id: 30 },
        { id: 4, __nested__author__id: 40, __nested__author__name: 'd', extra: true },
        { id: 5, __nested__author__id: 50, __nested__author__name: 'e' },
      ];
      const inherited = [{ __nested__meta__constructor: 1, __nested__meta__toString: 'x', valueOf: 2 }];
      const pathThenValue = [{ __nested__a__b: 1, __nested__a: 2 }, { __nested__a__b: 3, __nested__a: 4 }];

      for (const rows of [mixed, inherited, pathThenValue]) {
        const { folded, oneByOne } = rebuildBoth(builder, rows);
        expect(folded).toBe(oneByOne);
      }

      expect(JSON.parse(rebuildBoth(builder, pathThenValue).folded)).toEqual([{ a: 2 }, { a: 4 }]);
      expect(Object.getOwnPropertyNames(builder.reconstructNestedRows(inherited, new Set(['__nested__meta__constructor']))[0].meta))
        .toEqual(['constructor', 'toString']);

      // A value written where a path goes through fails as it always did, and so does a row that is not one
      const valueThenPath = [{ __nested__a: 1, __nested__a__b: 2 }];
      expect(() => builder.reconstructNestedRows(valueThenPath, new Set(['__nested__a']))).toThrow(TypeError);
      expect(() => builder.reconstructNestedRows([{ __nested__a: 1 }, null], new Set(['__nested__a']))).toThrow(TypeError);
    });
  });
});

/**
 * PostgreSQL passes at most 100 arguments to a function call (FUNC_MAX_ARGS; past it 54023 "cannot pass more than 100
 * arguments to a function", on every execution), so ONE json_build_object takes at most 50 keys. Every object a query
 * builds in SQL — a collection's item under every strategy (toList, firstOrDefault), a nested object inside one, a
 * withAggregation item — is built past 50 keys as ONE `JSON_OBJECT('k' VALUE v, … RETURNING json)` under
 * `LinkgressConfig.serverVersion` 16+, else (the default) as `(SELECT row_to_json(r.*) FROM (SELECT v AS "k", …) r)`,
 * or, for keys that cannot name a column, from the json texts of 50-key calls spliced. Every case runs under both
 * settings and reads the same rows. A projection of 51 keys used to fail on PostgreSQL and pass on the in-memory
 * database, which did not enforce the limit.
 */
for (const serverVersion of [undefined, 16] as const) describe(`an object wider than one function call takes (more than 50 keys; serverVersion ${serverVersion ?? 'unset'})`, () => {
  beforeAll(() => {
    LinkgressConfig.serverVersion = serverVersion;
  });

  afterAll(() => {
    LinkgressConfig.resetToDefaults();
  });

  /** The statements build their wide objects in the form the setting selects: JSON_OBJECT on 16+, row_to_json below. */
  const expectWideForm = (statements: string) => {
    expect({ JSON_OBJECT: statements.includes('JSON_OBJECT('), row_to_json: statements.includes('row_to_json(r.*)') })
      .toEqual(serverVersion === 16 ? { JSON_OBJECT: true, row_to_json: false } : { JSON_OBJECT: false, row_to_json: true });
  };

  /** The key names of `n` keys, in written order. */
  const keyNames = (n: number, keyOf: (i: number) => string = i => `k${i}`): string[] => Array.from({ length: n }, (_, i) => keyOf(i));

  /** keys `from` … `to - 1`, round robin over an integer, a numeric, a timestamp, a boolean, a NULL, an enum and a mapped column. */
  const wideOrder = (o: any, from: number, to: number, keyOf: (i: number) => string = i => `k${i}`): Record<string, unknown> => {
    const values = [o.id, o.totalAmount, o.createdAt, o.user!.isActive, o.items, o.status, o.user!.lastActiveAt];
    const row: Record<string, unknown> = {};

    for (let i = from; i < to; i++) {
      row[keyOf(i)] = values[i % values.length];
    }

    return row;
  };

  /** The rows `query` reads for keys 0 … n - 1, and the same rows read as projections of at most 40 keys each, merged. */
  const wideAndNarrow = async <T>(n: number, query: (keys: (o: any) => Record<string, unknown>) => Promise<T[]>, merge: (a: T, b: T) => T) => {
    const wide = await query(o => wideOrder(o, 0, n));
    let narrow: T[] | undefined;

    for (let from = 0; from < n; from += 40) {
      const part = await query(o => wideOrder(o, from, Math.min(n, from + 40)));
      narrow = narrow === undefined ? part : narrow.map((row, i) => merge(row, part[i]));
    }

    return { wide, narrow: narrow! };
  };

  /**
   * Every key of an object built in SQL, in written order, each value as its column reads there: the mapped column a
   * Date, the timestamp the JSON text of one.
   */
  const expectTyped = (item: Record<string, unknown>, n: number) => {
    expect(Object.keys(item)).toEqual(keyNames(n));
    expect(typeof item.k0).toBe('number');
    expect(Number(item.k1)).toBeGreaterThan(99);
    expect(item.k2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(item.k3).toBe(true);
    expect(item.k4).toBeNull();
    expect(['completed', 'pending']).toContain(item.k5 as string);
    expect(item.k6).toBeInstanceOf(Date);
    expect(item[`k${n - 1}`]).toEqual(item[`k${(n - 1) % 7}`]);
  };

  for (const strategy of ['cte', 'lateral', 'temptable'] as const) {
    test(`${strategy}: a collection's items, its first item and a nested object in an item read every key, in order (51 and 120 keys)`, async () => {
      await withDatabase(async db => {
        await seedTestData(db);
        const { statements, options } = capturing();

        for (const n of [51, 120]) {
          statements.length = 0;
          const { wide, narrow } = await wideAndNarrow(
            n,
            keys => db.users
              .withQueryOptions({ ...options, collectionStrategy: strategy })
              .where(u => gt(u.id, 0))
              .orderBy(u => u.id)
              .select(u => ({
                id: u.id,
                orders: u.orders!.where(o => gt(o.totalAmount, 1)).orderBy(o => o.id).select(keys).toList('orders'),
                latest: u.orders!.orderBy(o => [[o.id, 'DESC']]).select(keys).firstOrDefault('latest'),
                nested: u.orders!.orderBy(o => o.id).select(o => ({ id: o.id, wide: keys(o) })).toList('nested'),
              }))
              .toList() as Promise<any[]>,
            (a, b) => ({
              ...a,
              orders: a.orders.map((item: any, i: number) => ({ ...item, ...b.orders[i] })),
              latest: a.latest === null ? null : { ...a.latest, ...b.latest },
              nested: a.nested.map((item: any, i: number) => ({ ...item, wide: { ...item.wide, ...b.nested[i].wide } })),
            })
          );

          expect(wide).toEqual(narrow);
          expectWideForm(statements.join('\n'));
          expect(wide.map(u => u.orders.length)).toEqual([1, 1, 0]);
          expectTyped(wide[0].orders[0], n);
          expectTyped(wide[1].latest, n);
          expectTyped(wide[0].nested[0].wide, n);
          expect(wide[2].latest).toBeNull();
        }
      }, { collectionStrategy: strategy });
    });

    test(`${strategy}: keys that cannot name a column (64 bytes, 32 × é) take the spliced form below 16, JSON_OBJECT on 16+; every form reads every key whole, in order`, async () => {
      await withDatabase(async db => {
        await seedTestData(db);
        const { statements, options } = capturing();
        const read = async (keyOf: (i: number) => string) => {
          statements.length = 0;
          const rows = await db.users
            .withQueryOptions({ ...options, collectionStrategy: strategy })
            .orderBy(u => u.id)
            .select(u => ({ id: u.id, orders: u.orders!.orderBy(o => o.id).select(o => wideOrder(o, 0, 51, keyOf)).toList('orders') }))
            .toList() as any[];

          return { item: rows[0].orders[0], sql: statements.join('\n') };
        };

        // r (the derived table's alias), mixed case, 63 bytes, non-ASCII: still identifiers — row_to_json(r.*)
        const named = (i: number) => (i === 0 ? 'r' : i === 1 ? 'Upper_Case' : i === 2 ? 'x'.repeat(63) : i === 3 ? 'Ünï' : `k${i}`);
        const asColumns = await read(named);
        expectWideForm(asColumns.sql);
        expect(asColumns.sql).toContain(serverVersion === 16 ? `JSON_OBJECT('r' VALUE ` : '(SELECT row_to_json(r.*) FROM (SELECT ');
        expect(Object.keys(asColumns.item)).toEqual(keyNames(51, named));
        expect(typeof asColumns.item.r).toBe('number');
        expect(asColumns.item[named(2)]).toBe(asColumns.item.k9);

        // 64 bytes (PostgreSQL would truncate the column name) and 32 × é (64 bytes in UTF-8): the spliced texts below
        // 16; a JSON_OBJECT key is a literal, so on 16+ they take the one form as any other key
        const long = (i: number) => (i === 0 ? 'x'.repeat(64) : i === 1 ? 'é'.repeat(32) : `k${i}`);
        const spliced = await read(long);
        expect(spliced.sql).not.toContain('row_to_json');
        if (serverVersion === 16) {
          expect(spliced.sql).toContain(`JSON_OBJECT('${long(0)}' VALUE `);
          expect(spliced.sql).not.toContain('(left(json_build_object(');
        } else {
          expect(spliced.sql).toContain(`(left(json_build_object('${long(0)}', `);
          expect(spliced.sql).toContain(`::text, -1) || ', ' || right(json_build_object('k50', `);
        }
        expect(Object.keys(spliced.item)).toEqual(keyNames(51, long));
        expect(spliced.item[long(0)]).toBe(asColumns.item.r);
        expect(spliced.item[long(1)]).toBe(asColumns.item.Upper_Case);
      });
    });

    test(`${strategy}: a nested collection and aggregates in a wide item stay exact (every value is a column of the item's row source)`, async () => {
      // The row_to_json sub-select evaluates its values one query level down: an aggregate there would count the
      // sub-select's one row. The builders hand it columns of the item's row source only — a nested collection, a
      // count() and a sum() included — so a wide item reads what a narrow one does.
      await withDatabase(async db => {
        const { orders, tasks } = await seedTestData(db);
        await db.orderTasks.insert({ orderId: orders.aliceOrder.id, taskId: tasks.task2.id, sortOrder: 5 });
        const { statements, options } = capturing();
        const read = async (n: number) => {
          statements.length = 0;
          const rows = await db.users
            .withQueryOptions({ ...options, collectionStrategy: strategy })
            .orderBy(u => u.id)
            .select(u => ({
              id: u.id,
              orders: u.orders!.orderBy(o => o.id).select(o => ({
                ...wideOrder(o, 0, n),
                tasks: o.orderTasks!.orderBy(t => t.sortOrder).select(t => ({ taskId: t.taskId, sortOrder: t.sortOrder })).toList('tasks'),
                taskCount: o.orderTasks!.count(),
                sortSum: o.orderTasks!.sum(t => t.sortOrder),
              })).toList('orders'),
            }))
            .toList() as any[];

          return { rows, sql: statements.join('\n') };
        };

        const narrow = await read(10);
        const wide = await read(60);
        expectWideForm(wide.sql);
        expect(narrow.sql).not.toContain('row_to_json');
        expect(narrow.sql).not.toContain('JSON_OBJECT(');

        const [aliceItem, bobItem] = [wide.rows[0].orders[0], wide.rows[1].orders[0]];
        expect(aliceItem.tasks).toEqual([{ taskId: tasks.task1.id, sortOrder: 1 }, { taskId: tasks.task2.id, sortOrder: 5 }]);
        expect([Number(aliceItem.taskCount), Number(aliceItem.sortSum)]).toEqual([2, 6]);
        expect([Number(bobItem.taskCount), Number(bobItem.sortSum), bobItem.tasks.length]).toEqual([1, 1, 1]);
        for (const [u, user] of wide.rows.entries()) {
          for (const [i, item] of user.orders.entries()) {
            const { tasks: t, taskCount, sortSum } = narrow.rows[u].orders[i];
            expect({ tasks: item.tasks, taskCount: item.taskCount, sortSum: item.sortSum }).toEqual({ tasks: t, taskCount, sortSum });
          }
        }
      });
    });
  }

  test('a withAggregation item reads every key, in order (51 and 120 keys)', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const { statements, options } = capturing();

      for (const n of [51, 120]) {
        statements.length = 0;
        const { wide, narrow } = await wideAndNarrow(
          n,
          keys => {
            const cte = new DbCteBuilder().withAggregation('wide_orders', db.orders.select(o => ({ userId: o.userId, ...keys(o) })), o => ({ userId: o.userId }), 'items');

            return db.users
              .withQueryOptions(options)
              .orderBy(u => u.id)
              .with(cte)
              .leftJoin(cte, (u, c) => eq(u.id, c.userId), (u, c) => ({ id: u.id, items: c.items }))
              .toList() as Promise<any[]>;
          },
          (a, b) => ({ ...a, items: a.items === null ? null : a.items.map((item: any, i: number) => ({ ...item, ...b.items[i] })) })
        );

        expect(wide).toEqual(narrow);
        expectWideForm(statements.join('\n'));
        expect(Object.keys(wide[0].items[0])).toEqual(keyNames(n));
      }
    });
  });

  test('up to 50 keys the object is ONE json_build_object, byte for byte as before; past 50, JSON_OBJECT on 16+, else row_to_json over a sub-select', async () => {
    await withDatabase(async db => {
      await seedTestData(db);
      const pairs = (from: number, to: number, prefix = '') => Array.from({ length: to - from }, (_, i) => `'k${from + i}', "${prefix}k${from + i}"`).join(', ');
      const columns = (from: number, to: number, prefix = '') => Array.from({ length: to - from }, (_, i) => `"${prefix}k${from + i}" AS "k${from + i}"`).join(', ');
      const values = (from: number, to: number, prefix = '') => Array.from({ length: to - from }, (_, i) => `'k${from + i}' VALUE "${prefix}k${from + i}"`).join(', ');

      for (const strategy of ['cte', 'lateral'] as const) {
        const { statements, options } = capturing();
        const sqlOf = async (keys: number) => {
          statements.length = 0;
          await db.users
            .withQueryOptions({ ...options, collectionStrategy: strategy })
            .select(u => ({ id: u.id, orders: u.orders!.select(o => ({ ...wideOrder(o, 0, keys), w: wideOrder(o, 0, keys) })).toList('orders') }))
            .toList();

          return statements.join('\n');
        };

        // 49 keys + the nested object: 50 pairs at the item's level, 49 in the nested one — one call each, any setting
        const at49 = await sqlOf(49);
        expect(at49).toContain(`json_build_object(${pairs(0, 49)}, 'w', json_build_object(${pairs(0, 49, 'w__')}))`);
        expect(at49).not.toContain('row_to_json');
        expect(at49).not.toContain('JSON_OBJECT(');

        // 50 keys + the nested object: the item's 51 keys one JSON_OBJECT (16+) or a row_to_json, the nested object's 50 one call
        expect(await sqlOf(50)).toContain(serverVersion === 16
          ? `JSON_OBJECT(${values(0, 50)}, 'w' VALUE json_build_object(${pairs(0, 50, 'w__')}) RETURNING json)`
          : `(SELECT row_to_json(r.*) FROM (SELECT ${columns(0, 50)}, json_build_object(${pairs(0, 50, 'w__')}) AS "w") r)`);

        // 60 and 60: both levels JSON_OBJECT, the nested one a value of the item's; below 16 both row_to_json, the
        // nested one a column of the item's sub-select
        expect(await sqlOf(60)).toContain(serverVersion === 16
          ? `JSON_OBJECT(${values(0, 60)}, 'w' VALUE JSON_OBJECT(${values(0, 60, 'w__')} RETURNING json) RETURNING json)`
          : `(SELECT row_to_json(r.*) FROM (SELECT ${columns(0, 60)}, (SELECT row_to_json(r.*) FROM (SELECT ${columns(0, 60, 'w__')}) r) AS "w") r)`);
      }
    });
  });
});
