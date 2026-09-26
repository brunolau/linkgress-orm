import { describe, test, expect, beforeAll, afterAll, jest } from 'bun:test';
import { and, eq, exists, gt, isNotNull, literal, lt, sql } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { getSharedDatabase, seedTestData, setupDatabase } from '../utils/test-database';
import { byId, createLibraryFixture, disposeLibraryFixture, LIBRARY_STRATEGIES, LibraryFixture } from '../utils/library-fixture';
import { NavigationAliasPlan } from '../../src/query/join-utils';

/**
 * A `Subquery` PROJECTED by a query (`select(r => ({ x: db.t.where(… r.nav.col …).asSubquery('scalar') }))`)
 * reads the enclosing row's navigation: the enclosing query must join it, exactly as it does for the same
 * subquery inside a WHERE `exists(…)`. It used to render `"user"."age"` with no JOIN — "missing FROM-clause
 * entry for table user".
 *
 * Seed (seedTestData): users alice(25), bob(35), charlie(45); posts alice x2, bob x1; task levels created
 * by alice ("High Priority") and bob ("Low Priority"); tasks "Important Task" (high) and "Regular Task" (low).
 */
describe('projected subquery: its outer navigation refs are joined by the enclosing query', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = getSharedDatabase();
    await setupDatabase(db);
    await seedTestData(db);
  });

  async function capture(run: () => Promise<unknown>): Promise<string[]> {
    const spy = jest.spyOn((db as any).client, 'query');

    try {
      await run();
      return spy.mock.calls.map(call => String(call[0]));
    } finally {
      spy.mockRestore();
    }
  }

  /** The next-older user than the row's author — a scalar subquery reading the author through `p.user`. */
  const nextOlderThanAuthor = (p: any) => db.users
    .where(u => gt(u.age, p.user!.age))
    .orderBy(u => u.age)
    .limit(1)
    .select(u => u.username)
    .asSubquery('scalar');

  test('a projected scalar subquery reading a navigation of the enclosing row', async () => {
    let rows: Array<{ title: string; nextOlder: string }> = [];
    const statements = await capture(async () => {
      rows = await db.posts.select(p => ({ title: p.title, nextOlder: nextOlderThanAuthor(p) })).toList();
    });

    expect(new Map(rows.map(row => [row.title, row.nextOlder]))).toEqual(new Map([
      ['Alice Post 1', 'bob'],
      ['Alice Post 2', 'bob'],
      ['Bob Post', 'charlie'],
    ]));
    // `post.user` is required: an INNER JOIN
    expect(statements[0]).toContain('INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"');
  });

  test('two navigation levels deep, and inside a nested object of the projection', async () => {
    const rows = await db.tasks
      .select(t => ({
        title: t.title,
        creator: {
          newestPost: db.posts
            .where(p => eq(p.userId, t.level!.createdBy!.id))
            .orderBy(p => [[p.views, 'DESC']])
            .limit(1)
            .select(p => p.title)
            .asSubquery('scalar'),
        },
      }))
      .toList();

    const byTitle = new Map(rows.map(row => [row.title, row.creator.newestPost]));
    expect(byTitle).toEqual(new Map([
      ['Important Task', 'Alice Post 2'],
      ['Regular Task', 'Bob Post'],
    ]));
  });

  /**
   * The users younger than the row's author, as a UNION subquery: BOTH legs read the author through
   * `p.user`, so the union's subquery carries the same correlation a single SELECT's does.
   */
  const youngerThanAuthor = (p: any) => db.users
    .where(u => lt(u.age, p.user!.age))
    .select(u => u.username)
    .unionAll(db.users
      .where(u => and(lt(u.age, p.user!.age), eq(u.username, 'nobody')))
      .select(u => u.username))
    .limit(1);

  test('a projected UNION subquery whose legs read a navigation of the enclosing row', async () => {
    let rows: Array<{ title: string; younger: string | null | undefined }> = [];
    const statements = await capture(async () => {
      rows = await db.posts.select(p => ({ title: p.title, younger: youngerThanAuthor(p).asSubquery('scalar') })).toList();
    });

    expect(new Map(rows.map(row => [row.title, row.younger ?? null]))).toEqual(new Map([
      ['Alice Post 1', null],
      ['Alice Post 2', null],
      ['Bob Post', 'alice'],
    ]));
    expect(statements[0]).toContain('INNER JOIN "users" AS "user" ON "posts"."user_id" = "user"."id"');
  });

  test('a UNION subquery in a WHERE exists(), its legs reading a navigation of the enclosing row', async () => {
    const titles = await db.posts
      .where(p => exists(youngerThanAuthor(p).asSubquery()))
      .select(p => p.title)
      .toList();

    expect(titles).toEqual(['Bob Post']);
  });

  test('in a UNION leg', async () => {
    const rows = await db.posts
      .where(p => eq(p.title, 'Bob Post'))
      .select(p => ({ kind: literal('post'), nextOlder: nextOlderThanAuthor(p) }))
      .unionAll(db.posts
        .where(p => eq(p.title, 'Alice Post 1'))
        .select(p => ({ kind: literal('other'), nextOlder: nextOlderThanAuthor(p) })))
      .toList();

    expect([...rows].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: 'other', nextOlder: 'bob' },
      { kind: 'post', nextOlder: 'charlie' },
    ]);
  });

  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`projected by a collection's item (${strategy}): rendered as a subquery, the item's navigation joined in the collection`, async () => {
      const collectionDb = getSharedDatabase({ collectionStrategy: strategy });

      // It used to be bound as a parameter: the item read back the serialized Subquery object
      const rows = await collectionDb.users
        .select(u => ({
          name: u.username,
          posts: u.posts!.select(p => ({
            title: p.title,
            author: collectionDb.users.where(v => eq(v.id, p.userId)).select(v => v.username).asSubquery('scalar'),
            nextOlder: nextOlderThanAuthor(p),
          })).toList(),
        }))
        .toList();

      const posts = rows.flatMap(row => row.posts).sort((a, b) => a.title.localeCompare(b.title));
      expect(posts).toEqual([
        { title: 'Alice Post 1', author: 'alice', nextOlder: 'bob' },
        { title: 'Alice Post 2', author: 'alice', nextOlder: 'bob' },
        { title: 'Bob Post', author: 'bob', nextOlder: 'charlie' },
      ]);
    });
  }

  test('CONTROL: the same subquery inside a WHERE exists() was already joined', async () => {
    const titles = await db.posts
      .where(p => exists(db.users.where(u => gt(u.age, p.user!.age)).select(u => u.id).asSubquery()))
      .select(p => p.title)
      .toList();

    expect([...titles].sort()).toEqual(['Alice Post 1', 'Alice Post 2', 'Bob Post']);
  });
});

/**
 * Two navigation paths of the enclosing row that end in one relation name — on the library fixture a
 * loan's own `book` and its `edition.book`; `book.category`, `edition.category` and `edition.book.category`
 * — one read by the query itself, the other only by a PROJECTED subquery. The subquery reads its own path
 * (under `<parent>__<relation>` when the plain name is taken), and the paths the query reads itself — its
 * projection, WHERE, ORDER BY, the path a collection hangs off — keep the aliases they had without the
 * subquery (as in 1.0.8, which did not plan the subquery's refs at all): a raw `sql` fragment naming
 * `"book"` / `"category"` reads the same join, at any depth and in any projection order. The subquery's
 * refs used to be planned like the query's own, so a shallower or earlier subquery path took the plain
 * alias and the raw fragment silently read another row.
 */
describe('projected subquery reading one of two paths to a relation: the query\'s own aliases keep their meaning', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture();
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  /** The name of the book / category the ref points at, as a scalar subquery reading the ref's path. */
  const bookNameAt = (ref: unknown) => fx.db.libBooks.where(b => eq(b.id, ref as number)).select(b => b.name).asSubquery('scalar');
  const categoryNameAt = (ref: unknown) => fx.db.libCategories.where(c => eq(c.id, ref as number)).select(c => c.name).asSubquery('scalar');
  const column = <T extends { id: number }, K extends keyof T>(rows: readonly T[], key: K): Array<T[K]> => byId(rows).map(row => row[key]);

  // Per loan L1, L2, L3
  const OWN_BOOK = ['Dune', 'Emma', 'Emma'];
  const EDITION_BOOK = ['Emma', 'Dune', 'Dune'];
  const OWN_CATEGORY = ['Sci-fi', 'Classics', 'Classics'];
  const EDITION_CATEGORY = ['Hardback line', 'Paperback line', 'Hardback line'];
  const EDITION_BOOK_CATEGORY = ['Classics', 'Sci-fi', 'Sci-fi'];
  const DUNE_EDITIONS = ['E-2', 'E-3', 'E-5'];
  const EMMA_EDITIONS = ['E-1', 'E-4'];

  for (const strategy of LIBRARY_STRATEGIES) {
    const loans = () => fx.db.libLoans.withQueryOptions({ collectionStrategy: strategy });
    const members = () => fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy });

    describe(strategy, () => {
      test('the query reads the shallower path, the subquery the deeper one', async () => {
        const rows = await loans().select(ln => ({
          id: ln.id,
          own: ln.book!.name,
          sub: bookNameAt(ln.edition!.book!.id),
          raw: sql<string>`"book"."name"`,
          editions: ln.book!.editions!.select(e => e.label).toStringList(),
        })).toList();

        expect(column(rows, 'own')).toEqual(OWN_BOOK);
        expect(column(rows, 'raw')).toEqual(OWN_BOOK);
        // 1.0.8 bound the subquery to the query's "book" join: the loan's own book
        expect(column(rows, 'sub')).toEqual(EDITION_BOOK);
        expect(byId(rows).map(row => [...row.editions].sort())).toEqual([DUNE_EDITIONS, EMMA_EDITIONS, EMMA_EDITIONS]);
      });

      test('the query reads the deeper path, the subquery the shallower one — in either projection order', async () => {
        const fieldFirst = await loans().select(ln => ({
          id: ln.id,
          ed: ln.edition!.book!.name,
          sub: bookNameAt(ln.book!.id),
          raw: sql<string>`"book"."name"`,
        })).toList();
        const subqueryFirst = await loans().select(ln => ({
          id: ln.id,
          sub: bookNameAt(ln.book!.id),
          ed: ln.edition!.book!.name,
          raw: sql<string>`"book"."name"`,
        })).toList();

        for (const rows of [fieldFirst, subqueryFirst]) {
          expect(column(rows, 'ed')).toEqual(EDITION_BOOK);
          // "book" is the edition's book, as without the subquery (it became the loan's own book)
          expect(column(rows, 'raw')).toEqual(EDITION_BOOK);
          expect(column(rows, 'sub')).toEqual(OWN_BOOK);
        }
      });

      test('two equally deep paths, the subquery first in the projection', async () => {
        const rows = await loans().select(ln => ({
          id: ln.id,
          sub: categoryNameAt(ln.book!.category!.id),
          edCategory: ln.edition!.category!.name,
          raw: sql<string>`"category"."name"`,
        })).toList();

        expect(column(rows, 'edCategory')).toEqual(EDITION_CATEGORY);
        expect(column(rows, 'raw')).toEqual(EDITION_CATEGORY);
        expect(column(rows, 'sub')).toEqual(OWN_CATEGORY);
      });

      test('the query reads a three-hop path, the subquery a two-hop one', async () => {
        const rows = await loans().select(ln => ({
          id: ln.id,
          sub: categoryNameAt(ln.book!.category!.id),
          deep: ln.edition!.book!.category!.name,
          raw: sql<string>`"category"."name"`,
        })).toList();

        expect(column(rows, 'deep')).toEqual(EDITION_BOOK_CATEGORY);
        expect(column(rows, 'raw')).toEqual(EDITION_BOOK_CATEGORY);
        expect(column(rows, 'sub')).toEqual(OWN_CATEGORY);
      });

      test('a path the WHERE reads, and a raw WHERE naming its alias', async () => {
        const rows = await loans()
          .where(ln => and(isNotNull(ln.edition!.category!.id), sql`"category"."name" = ${'Hardback line'}`))
          .select(ln => ({ id: ln.id, sub: categoryNameAt(ln.book!.category!.id) }))
          .toList();

        // The raw condition filters on the edition's category (it read the own book's category: no row)
        expect(byId(rows)).toEqual([{ id: fx.ids.l1, sub: 'Sci-fi' }, { id: fx.ids.l3, sub: 'Classics' }]);
      });

      test('a path the ORDER BY reads', async () => {
        const rows = await loans()
          .orderBy(ln => [[ln.edition!.category!.name, 'DESC'], [ln.id, 'ASC']])
          .select(ln => ({ id: ln.id, sub: categoryNameAt(ln.book!.category!.id), raw: sql<string>`"category"."name"` }))
          .toList();

        expect(rows.map(row => row.id)).toEqual([fx.ids.l2, fx.ids.l1, fx.ids.l3]);
        expect(rows.map(row => row.raw)).toEqual(['Paperback line', 'Hardback line', 'Hardback line']);
        expect(rows.map(row => row.sub)).toEqual(['Classics', 'Sci-fi', 'Classics']);
      });

      test('the path a projected collection hangs off', async () => {
        const rows = await loans().select(ln => ({
          id: ln.id,
          sub: bookNameAt(ln.book!.id),
          raw: sql<string>`"book"."name"`,
          editions: ln.edition!.book!.editions!.select(e => e.label).toStringList(),
        })).toList();

        expect(column(rows, 'raw')).toEqual(EDITION_BOOK);
        expect(column(rows, 'sub')).toEqual(OWN_BOOK);
        expect(byId(rows).map(row => [...row.editions].sort())).toEqual([EMMA_EDITIONS, DUNE_EDITIONS, DUNE_EDITIONS]);
      });

      test('in a collection\'s item: the subquery reads its own path, whichever path the item reads', async () => {
        const rows = await members().select(m => ({
          id: m.id,
          shallow: m.loans!.select(ln => ({
            id: ln.id,
            own: ln.book!.name,
            sub: bookNameAt(ln.edition!.book!.id),
          })).toList(),
          deep: m.loans!.select(ln => ({
            id: ln.id,
            ed: ln.edition!.book!.name,
            sub: bookNameAt(ln.book!.id),
            raw: sql<string>`"book"."name"`,
          })).toList(),
          // The subquery alone reads a two-hop path whose last relation the item's own table has too
          only: m.loans!.select(ln => ({ id: ln.id, sub: bookNameAt(ln.edition!.book!.id) })).toList(),
        })).toList();

        const ada = rows.find(row => row.id === fx.ids.ada)!;
        const bo = rows.find(row => row.id === fx.ids.bo)!;
        // The subquery read the item's join of the same name: the other path's book
        expect(byId(ada.shallow)).toEqual([{ id: fx.ids.l1, own: 'Dune', sub: 'Emma' }, { id: fx.ids.l2, own: 'Emma', sub: 'Dune' }]);
        expect(bo.shallow).toEqual([{ id: fx.ids.l3, own: 'Emma', sub: 'Dune' }]);
        expect(byId(ada.deep)).toEqual([
          { id: fx.ids.l1, ed: 'Emma', sub: 'Dune', raw: 'Emma' },
          { id: fx.ids.l2, ed: 'Dune', sub: 'Emma', raw: 'Dune' },
        ]);
        expect(bo.deep).toEqual([{ id: fx.ids.l3, ed: 'Dune', sub: 'Emma', raw: 'Dune' }]);
        // It was joined by relation name, which found the loan's OWN book
        expect(byId(ada.only)).toEqual([{ id: fx.ids.l1, sub: 'Emma' }, { id: fx.ids.l2, sub: 'Dune' }]);
        expect(bo.only).toEqual([{ id: fx.ids.l3, sub: 'Dune' }]);

        // Three collections deep
        const nested = await fx.db.libCategories.withQueryOptions({ collectionStrategy: strategy }).select(c => ({
          id: c.id,
          books: c.books!.select(b => ({
            id: b.id,
            editions: b.editions!.select(e => ({
              id: e.id,
              loans: e.loans!.select(ln => ({ own: ln.book!.name, sub: bookNameAt(ln.edition!.book!.id) })).toList(),
            })).toList(),
          })).toList(),
        })).toList();
        const loanRows = nested.flatMap(c => c.books.flatMap(b => b.editions.flatMap(e => e.loans)));
        expect(loanRows.map(l => `${l.own}/${l.sub}`).sort()).toEqual(['Dune/Emma', 'Emma/Dune', 'Emma/Dune']);
      });
    });
  }

  test('NavigationAliasPlan: a subquery\'s refs rank after every ref of the query, whatever the call order and depth', () => {
    const relation = (targetTable: string, foreignKey: string) => ({ type: 'one', targetTable, foreignKeys: [foreignKey], matches: ['id'] });
    const registry = new Map<string, any>([
      ['books', { name: 'books', relations: { category: relation('categories', 'category_id') } }],
      ['categories', { name: 'categories', relations: {} }],
      ['editions', { name: 'editions', relations: { book: relation('books', 'book_id') } }],
    ]);
    const anchor = (name: string) => ({ name, relations: { book: relation('books', 'book_id'), edition: relation('editions', 'edition_id') } });
    const ref = (relationName: string, ...via: string[]) => ({ __fieldName: 'id', __dbColumnName: 'id', __tableAlias: relationName, __navigationAliases: via });

    const plan = new NavigationAliasPlan(anchor('loans') as any, 'loans', registry, undefined);
    plan.addSecondaryRef(ref('book'));
    plan.addSecondaryRef(ref('category', 'book'));
    plan.addRef(ref('category', 'edition', 'book'));
    const sealed = plan.seal()!;
    // The query's own path keeps every plain name; the subquery's hops take path aliases on their parents
    expect(sealed.nodeForPath(['edition', 'book'])!.alias).toBe('book');
    expect(sealed.nodeForPath(['edition', 'book', 'category'])!.alias).toBe('category');
    expect(sealed.nodeForPath(['book'])!.alias).toBe('loans__book');
    expect(sealed.nodeForPath(['book', 'category'])!.alias).toBe('loans__book__category');

    // A subquery hop one step below an anchor whose name leaves no room for "<anchor>__<relation>" (63
    // bytes) takes "<relation>__<n>" rather than refusing the query
    const longName = `${'x'.repeat(58)}_loan`;
    const longPlan = new NavigationAliasPlan(anchor(longName) as any, longName, registry, undefined);
    longPlan.addRef(ref('book', 'edition'));
    longPlan.addSecondaryRef(ref('book'));
    const longSealed = longPlan.seal()!;
    expect(longSealed.nodeForPath(['edition', 'book'])!.alias).toBe('book');
    expect(longSealed.nodeForPath(['book'])!.alias).toBe('book__2');
  });

  test('CONTROL: a subquery reading the path the query reads shares its join and plain alias', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans.select(ln => ({
      id: ln.id,
      ed: ln.edition!.book!.name,
      sub: bookNameAt(ln.edition!.book!.id),
      raw: sql<string>`"book"."name"`,
    })).toList();

    expect(column(rows, 'sub')).toEqual(EDITION_BOOK);
    expect(column(rows, 'raw')).toEqual(EDITION_BOOK);
    expect(fx.lastStatement()).not.toContain('__book');
  });
});
