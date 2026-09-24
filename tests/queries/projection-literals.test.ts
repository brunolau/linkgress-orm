import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DbCteBuilder, eq, JoinQueryBuilder, sql } from '../../src';
import { createLibraryFixture, disposeLibraryFixture, LibraryFixture, LIBRARY_STRATEGIES } from '../utils/library-fixture';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * A literal in a projection is a VALUE, as its TypeScript type says, and reads back as exactly that
 * value — in a root SELECT, in a nested object, in a collection's items, in a grouped query and in a
 * join of one.
 *
 * What used to happen instead:
 *  - a STRING rendered as a column of that name: `kind: 'loan'` failed ("column lib_loans.loan
 *    does not exist"), and `kind: 'name'` silently read the name column — in a root SELECT, in a
 *    collection's items, and in JoinQueryBuilder;
 *  - the other literals rode the statement as parameters and were read back from the database, which
 *    hands an untyped parameter back as text: `true` came back "true", a Date as a string, `null` as
 *    undefined, and `42` inside a collection item as "42";
 *  - a join of a grouped query rendered a literal as a column named like its key.
 *
 * A UNION still reads each leg's literal from its rows: every row goes through the FIRST leg's
 * selection there, and each leg projects its own discriminator.
 */
describe('projection literals', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture('lateral');
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  describe('root SELECT', () => {
    test('a string is a value — even one that names a column', async () => {
      fx.resetCapture();
      const rows = await fx.db.libMembers.where(m => eq(m.id, fx.ids.ada)).select(m => ({ id: m.id, kind: 'member', named: 'name' })).toList();

      expect(rows).toEqual([{ id: fx.ids.ada, kind: 'member', named: 'name' }]);
      // Bound as parameters, never rendered as `"lib_members"."member"` / `"lib_members"."name"`
      expect(fx.lastStatement('SELECT')).not.toContain('"lib_members"."member"');
      expect(fx.lastStatement('SELECT')).not.toContain('"lib_members"."name"');
    });

    test('every kind of literal reads back as itself', async () => {
      const at = new Date('2022-05-06T07:08:09.000Z');
      const [row] = await fx.db.libMembers.where(m => eq(m.id, fx.ids.bo)).select(m => ({
        id: m.id,
        n: 42,
        ratio: 0.25,
        big: 9007199254740993n,
        yes: true,
        no: false,
        nothing: null,
        at,
        list: ['x', 'y'],
      })).toList();

      expect(row).toEqual({ id: fx.ids.bo, n: 42, ratio: 0.25, big: 9007199254740993n, yes: true, no: false, nothing: null, at, list: ['x', 'y'] });
      expect(typeof row.yes).toBe('boolean');
      expect(row.at).toBeInstanceOf(Date);
    });

    test('literals next to columns, expressions and navigations; first() reads them too', async () => {
      const row = await fx.db.libLoans.where(ln => eq(ln.id, fx.ids.l1)).select(ln => ({
        note: ln.note,
        loud: sql<string>`upper(${ln.note})`,
        book: ln.book!.name,
        source: 'loan',
        flag: true,
      })).first();

      expect(row).toEqual({ note: 'first', loud: 'FIRST', book: 'Dune', source: 'loan', flag: true });
    });

    test('a nested object\'s literals read back as themselves, at any depth', async () => {
      const [row] = await fx.db.libMembers.where(m => eq(m.id, fx.ids.cy)).select(m => ({
        id: m.id,
        meta: { kind: 'member', on: true, off: false, none: null, n: 1.5, deeper: { tag: 'deep', at: new Date('2020-01-01T00:00:00.000Z') }, name: m.name },
      })).toList();

      expect(row).toEqual({
        id: fx.ids.cy,
        meta: { kind: 'member', on: true, off: false, none: null, n: 1.5, deeper: { tag: 'deep', at: new Date('2020-01-01T00:00:00.000Z') }, name: 'Cy' },
      });
    });

    test('a UNION reads each leg\'s literal from its own rows', async () => {
      const rows = await fx.db.libBooks.select(b => ({ id: b.id, kind: 'book', rank: 1 }))
        .unionAll(fx.db.libMembers.select(m => ({ id: m.id, kind: 'member', rank: 2 })))
        .toList();

      const kinds = rows.map(r => `${r.kind}:${r.rank}`).sort();
      expect(kinds).toEqual(['book:1', 'book:1', 'member:2', 'member:2', 'member:2']);
    });

    test('a UNION reads each leg\'s NESTED literal discriminator from its own rows', async () => {
      const rows = await fx.db.libBooks.select(b => ({ tag: { kind: 'book' }, id: b.id, name: b.name }))
        .unionAll(fx.db.libMembers.select(m => ({ tag: { kind: 'member' }, id: m.id, name: m.name })))
        .toList();

      const byName = Object.fromEntries(rows.map(r => [r.name, r.tag.kind]));
      expect(byName).toEqual({ Dune: 'book', Emma: 'book', Ada: 'member', Bo: 'member', Cy: 'member' });
    });
  });

  describe('collection items', () => {
    for (const strategy of LIBRARY_STRATEGIES) {
      test(`${strategy}: a string is a value, and every literal reads back as itself`, async () => {
        const [row] = await fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy })
          .where(m => eq(m.id, fx.ids.ada))
          .select(m => ({
            loans: m.loans!.orderBy(l => l.note).select(l => ({
              note: l.note,
              kind: 'loan',
              named: 'note',
              n: 42,
              yes: true,
              nothing: null,
              at: new Date('2021-01-01T00:00:00.000Z'),
              meta: { tag: 'tagged', on: false, bookName: l.book!.name },
            })).toList(),
          }))
          .toList();

        expect(row.loans).toEqual([
          { note: 'first', kind: 'loan', named: 'note', n: 42, yes: true, nothing: null, at: new Date('2021-01-01T00:00:00.000Z'), meta: { tag: 'tagged', on: false, bookName: 'Dune' } },
          { note: 'second', kind: 'loan', named: 'note', n: 42, yes: true, nothing: null, at: new Date('2021-01-01T00:00:00.000Z'), meta: { tag: 'tagged', on: false, bookName: 'Emma' } },
        ]);
      });

      test(`${strategy}: literals of a firstOrDefault() and of a nested collection`, async () => {
        const [row] = await fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy })
          .where(m => eq(m.id, fx.ids.bo))
          .select(m => ({
            firstLoan: m.loans!.select(l => ({ note: l.note, n: 7, yes: true })).firstOrDefault(),
            books: m.loans!.select(l => ({
              editions: l.book!.editions!.orderBy(e => e.label).select(e => ({ label: e.label, kind: 'edition', n: 3 })).toList(),
            })).toList(),
          }))
          .toList();

        expect(row.firstLoan).toEqual({ note: 'third', n: 7, yes: true });
        expect(row.books).toEqual([{ editions: [{ label: 'E-1', kind: 'edition', n: 3 }, { label: 'E-4', kind: 'edition', n: 3 }] }]);
      });
    }

    test('an expression\'s mapWith reads a collection item\'s value, and a literal named like a column stays a literal', async () => {
      await withDatabase(async db => {
        const { users } = await seedTestData(db);

        const [row] = await db.users.where(u => eq(u.id, users.alice.id)).select(u => ({
          posts: u.posts!.orderBy(p => p.id).select(p => ({
            // Under the name of a MAPPED column of posts: a literal and an expression stay what they are
            publishTime: 7,
            customDate: sql<number>`${p.views} + 1`,
            doubled: sql<number>`${p.views} * 2`.mapWith((value: unknown) => `x${value}`),
          })).toList(),
        })).toList();

        expect(row.posts).toEqual([
          { publishTime: 7, customDate: 101, doubled: 'x200' },
          { publishTime: 7, customDate: 151, doubled: 'x300' },
        ]);
      });
    });

    test('a nested object of a collection item reads its columns through their mappers', async () => {
      await withDatabase(async db => {
        const { users } = await seedTestData(db);

        const [row] = await db.users.where(u => eq(u.id, users.alice.id)).select(u => ({
          posts: u.posts!.orderBy(p => p.id).select(p => ({ info: { at: p.publishTime, title: p.title } })).toList(),
        })).toList();

        expect(row.posts).toEqual([
          { info: { at: { hour: 9, minute: 30 }, title: 'Alice Post 1' } },
          { info: { at: { hour: 14, minute: 0 }, title: 'Alice Post 2' } },
        ]);
      });
    });
  });

  describe('grouped queries', () => {
    test('a grouped query\'s constants read back as themselves', async () => {
      const rows = await fx.db.libLoans
        .select(ln => ({ memberId: ln.memberId }))
        .groupBy(r => ({ memberId: r.memberId }))
        .select(g => ({ memberId: g.key.memberId, n: g.count(), kind: 'group', weight: 2, flag: true, at: new Date('2020-02-02T00:00:00.000Z') }))
        .orderBy(r => r.memberId)
        .toList();

      expect(rows).toEqual([
        { memberId: fx.ids.ada, n: 2, kind: 'group', weight: 2, flag: true, at: new Date('2020-02-02T00:00:00.000Z') },
        { memberId: fx.ids.bo, n: 1, kind: 'group', weight: 2, flag: true, at: new Date('2020-02-02T00:00:00.000Z') },
      ]);
    });

    test('a join of a grouped query: literals, aggregates as numbers, mapped extremes', async () => {
      await withDatabase(async db => {
        await seedTestData(db);
        const cteBuilder = new DbCteBuilder();
        const names = cteBuilder.with('user_names', db.users.select(u => ({ uid: u.id, name: u.username })));

        const rows = await db.posts
          .select(p => ({ userId: p.userId, publishTime: p.publishTime, views: p.views }))
          .groupBy(r => ({ userId: r.userId }))
          .select(g => ({ userId: g.key.userId, earliest: g.min(r => r.publishTime), n: g.count(), total: g.sum(r => r.views) }))
          .leftJoin(names.cte, (grp, u) => eq(grp.userId, u.uid), (grp, u) => ({
            userId: grp.userId,
            earliest: grp.earliest,
            n: grp.n,
            total: grp.total,
            name: u.name,
            kind: 'author',
            rank: 1,
            nothing: null,
            loud: sql<string>`upper(${u.name})`.mapWith((value: unknown) => `<${value}>`),
          }))
          .toList();

        const byUser = [...rows].sort((a, b) => a.userId - b.userId);
        expect(byUser).toEqual([
          { userId: 1, earliest: { hour: 9, minute: 30 }, n: 2, total: 250, name: 'alice', kind: 'author', rank: 1, nothing: null, loud: '<ALICE>' },
          { userId: 2, earliest: { hour: 18, minute: 45 }, n: 1, total: 200, name: 'bob', kind: 'author', rank: 1, nothing: null, loud: '<BOB>' },
        ]);
      });
    });

    test('a join of a grouped query refuses a nested object or a collection with a clear error', async () => {
      await withDatabase(async db => {
        await seedTestData(db);
        const cteBuilder = new DbCteBuilder();
        const names = cteBuilder.with('user_names', db.users.select(u => ({ uid: u.id, name: u.username })));
        const grouped = () => db.posts
          .select(p => ({ userId: p.userId }))
          .groupBy(r => ({ userId: r.userId }))
          .select(g => ({ userId: g.key.userId, n: g.count() }));

        await expect(async () => {
          await grouped().leftJoin(names.cte, (grp, u) => eq(grp.userId, u.uid), (grp, u) => ({ nested: { id: grp.userId, name: u.name } })).toList();
        }).toThrow(/"nested" is a nested object/);
      });
    });
  });

  describe('JoinQueryBuilder', () => {
    test('a string is a value, columns read through their mappers, expressions render', async () => {
      await withDatabase(async db => {
        await seedTestData(db);
        const posts = (db.posts as any)._getSchema();
        const users = (db.users as any)._getSchema();
        const join = new JoinQueryBuilder<any, any>(posts, 'p', users, 'u', 'INNER', eq({ __dbColumnName: 'user_id', __tableAlias: 'p' } as any, { __dbColumnName: 'id', __tableAlias: 'u' } as any), (db as any).getClient ? (db as any).getClient() : (db.posts as any)._getClient());
        join._setSelection((p: any, u: any) => ({
          title: p.title,
          at: p.publishTime,
          author: u.username,
          kind: 'post',
          named: 'title',
          loud: sql<string>`upper(${u.username})`,
          n: 5,
        }));

        const rows = (await join.orderBy((p: any) => p.id).toList()).slice(0, 1);
        expect(rows).toEqual([{ title: 'Alice Post 1', at: { hour: 9, minute: 30 }, author: 'alice', kind: 'post', named: 'title', loud: 'ALICE', n: 5 }]);
      });
    });
  });
});
