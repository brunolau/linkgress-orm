/**
 * ORDER BY keys read through navigations, on the ROOT query.
 *
 * On the library fixture (tests/utils/library-fixture.ts) a loan's own book and the book its edition
 * prints are different rows, and ordering by either one gives a different row order:
 *
 *   loan  note    own book  its category  edition  edition's book  its category  edition's category
 *   L1    first   Dune      Sci-fi        E-1      Emma            Classics      Hardback line
 *   L2    second  Emma      Classics      E-2      Dune            Sci-fi        Paperback line
 *   L3    third   Emma      Classics      E-3      Dune            Sci-fi        Hardback line
 *
 * What used to go wrong:
 * - `db.table.orderBy(...)` read a columns-only row: a key through a navigation read `undefined`
 *   and silently vanished from the ORDER BY (`ln.book.name`), or threw (`ln.edition.book.name`), and
 *   a chained `.select(m => m.loans…)` threw as well;
 * - after `select()`, every key rendered as a bare name: a nested object's leaf or a column of a
 *   navigation row projected whole named a column the root table does not have;
 * - a key a later `select()` renamed ordered by whatever the new projection selects under that name.
 *
 * Every key that is a column now keeps its ref: it renders as the projection's output alias while
 * the projection still selects that very column under it, and otherwise as the qualified column,
 * joined (and aliased by path) like a projected navigation.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, gt, sql } from '../../src';
import { createLibraryFixture, disposeLibraryFixture, LIBRARY_STRATEGIES, LibraryFixture } from '../utils/library-fixture';

let fx: LibraryFixture;

beforeAll(async () => {
  fx = await createLibraryFixture();
});

afterAll(async () => {
  await disposeLibraryFixture(fx);
});

const ids = (rows: ReadonlyArray<{ id: number }>): number[] => rows.map(row => row.id);

/** The ORDER BY clause of the last statement. */
const orderByClause = (): string => {
  const statement = fx.lastStatement();
  const at = statement.lastIndexOf('ORDER BY');

  return at === -1 ? '' : statement.slice(at).split('\n')[0];
};

describe('orderBy before select(), through navigations', () => {
  test('an own column keeps its previous SQL', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans.orderBy(ln => [[ln.note, 'DESC']]).select(ln => ({ id: ln.id })).toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY "lib_loans"."note" DESC');
  });

  test('a one-hop navigation (used to vanish from the ORDER BY)', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans.orderBy(ln => [[ln.book!.name, 'ASC'], [ln.id, 'DESC']]).select(ln => ({ id: ln.id })).toList();

    expect(ids(rows)).toEqual([fx.ids.l1, fx.ids.l3, fx.ids.l2]);
    expect(orderByClause()).toBe('ORDER BY "book"."name" ASC, "id" DESC');
    expect(fx.lastStatement()).toContain('LEFT JOIN "lib_books" AS "book" ON "lib_loans"."book_id" = "book"."id"');
  });

  test('a two-hop navigation (used to throw)', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans.orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'ASC']]).select(ln => ({ id: ln.id })).toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
    expect(fx.lastStatement()).toContain('LEFT JOIN "lib_books" AS "book" ON "edition"."book_id" = "book"."id"');
    expect(fx.lastStatement()).not.toContain('"lib_loans"."book_id"');
  });

  test('a three-hop navigation', async () => {
    const rows = await fx.db.libLoans
      .orderBy(ln => [[ln.edition!.book!.category!.name, 'DESC'], [ln.id, 'ASC']])
      .select(ln => ({ id: ln.id }))
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
  });

  test('both book paths in one ORDER BY: each on its own join', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.book!.name, 'ASC'], [ln.id, 'DESC']])
      .select(ln => ({ id: ln.id }))
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY "edition__book"."name" ASC, "book"."name" ASC, "id" DESC');
    expect(fx.lastStatement()).toContain('LEFT JOIN "lib_books" AS "edition__book" ON "edition"."book_id" = "edition__book"."id"');
  });

  test('a navigation the projection also reads, and one it does not', async () => {
    const rows = await fx.db.libLoans
      .orderBy(ln => [[ln.edition!.category!.name, 'ASC'], [ln.edition!.label, 'DESC']])
      .select(ln => ({ id: ln.id, printed: ln.edition!.book!.name }))
      .toList();

    // Hardback line: E-3 (L3), E-1 (L1); Paperback line: E-2 (L2)
    expect(rows).toEqual([
      { id: fx.ids.l3, printed: 'Dune' },
      { id: fx.ids.l1, printed: 'Emma' },
      { id: fx.ids.l2, printed: 'Dune' },
    ]);
  });

  test('a navigation keyed on a non-id principal key', async () => {
    const rows = await fx.db.libLoans
      .orderBy(ln => [[ln.edition!.book!.categoryByCode!.name, 'ASC'], [ln.id, 'ASC']])
      .select(ln => ({ id: ln.id }))
      .toList();

    // The edition's book is coded: Emma → SF (Sci-fi) for L1, Dune → CL (Classics) for L2 / L3
    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
  });

  test('a nullable navigation: missing values sort like NULL', async () => {
    const ascending = await fx.db.libMembers.orderBy(m => [[m.favoriteBook!.name, 'ASC']]).select(m => ({ id: m.id })).toList();
    const descending = await fx.db.libMembers.orderBy(m => [[m.favoriteBook!.name, 'DESC']]).select(m => ({ id: m.id })).toList();

    expect(ids(ascending)).toEqual([fx.ids.bo, fx.ids.ada, fx.ids.cy]);
    expect(ids(descending)).toEqual([fx.ids.cy, fx.ids.ada, fx.ids.bo]);
  });

  test('without a select(): the whole row, ordered', async () => {
    const rows = await fx.db.libLoans.orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'DESC']]).toList();

    expect(rows.map(row => [row.id, row.note])).toEqual([[fx.ids.l3, 'third'], [fx.ids.l2, 'second'], [fx.ids.l1, 'first']]);
  });

  test('after a where()', async () => {
    const rows = await fx.db.libLoans
      .where(ln => eq(ln.member!.name, 'Ada'))
      .orderBy(ln => ln.edition!.book!.name)
      .select(ln => ({ id: ln.id }))
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l1]);
  });

  test('followed by a where()', async () => {
    const rows = await fx.db.libLoans
      .orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'DESC']])
      .where(ln => gt(ln.id, fx.ids.l1))
      .select(ln => ({ id: ln.id }))
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2]);
  });

  test('with limit / offset, and limit() called on the table first', async () => {
    const firstTwo = await fx.db.libLoans.orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'ASC']]).select(ln => ({ id: ln.id })).limit(2).toList();
    const second = await fx.db.libLoans.orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'ASC']]).select(ln => ({ id: ln.id })).offset(1).limit(1).toList();
    const limitFirst = await fx.db.libLoans.limit(2).orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'ASC']]).select(ln => ({ id: ln.id })).toList();

    expect(ids(firstTwo)).toEqual([fx.ids.l2, fx.ids.l3]);
    expect(ids(second)).toEqual([fx.ids.l3]);
    expect(ids(limitFirst)).toEqual([fx.ids.l2, fx.ids.l3]);
  });

  test('first()', async () => {
    const row = await fx.db.libLoans.orderBy(ln => [[ln.edition!.book!.name, 'DESC']]).select(ln => ({ id: ln.id })).first();

    expect(row!.id).toBe(fx.ids.l1);
  });

  test('count() is not affected', async () => {
    expect(await fx.db.libLoans.orderBy(ln => ln.edition!.book!.name).count()).toBe(3);
  });

  test('countOver()', async () => {
    const { data, totalCount } = await fx.db.libLoans
      .orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'DESC']])
      .select(ln => ({ id: ln.id }))
      .limit(2)
      .countOver();

    expect(totalCount).toBe(3);
    expect(ids(data as any[])).toEqual([fx.ids.l3, fx.ids.l2]);
  });

  test('a prepared query', async () => {
    const prepared = fx.db.libLoans
      .orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'DESC']])
      .where(ln => gt(ln.id, sql.placeholder('minId')))
      .select(ln => ({ id: ln.id }))
      .prepare<{ minId: number }>('orderby_navigation_prepared');

    expect(ids(await prepared.execute({ minId: 0 }))).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect(ids(await prepared.execute({ minId: fx.ids.l1 }))).toEqual([fx.ids.l3, fx.ids.l2]);
  });

  test('the last orderBy() wins, its navigations and nothing else joined', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .orderBy(ln => ln.book!.name)
      .orderBy(ln => [[ln.edition!.label, 'DESC']])
      .select(ln => ({ id: ln.id }))
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect(fx.lastStatement()).not.toContain('"lib_books"');
  });

  for (const strategy of LIBRARY_STRATEGIES) {
    test(`followed by a select() with a collection (${strategy}; the chained select used to throw)`, async () => {
      const rows = await fx.db.libMembers
        .withQueryOptions({ collectionStrategy: strategy })
        .orderBy(m => [[m.favoriteBook!.name, 'ASC'], [m.id, 'ASC']])
        .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => ln.id).select(ln => ({ id: ln.id })).toList() }))
        .toList();

      expect(rows).toEqual([
        { id: fx.ids.bo, loans: [{ id: fx.ids.l3 }] },
        { id: fx.ids.ada, loans: [{ id: fx.ids.l1 }, { id: fx.ids.l2 }] },
        { id: fx.ids.cy, loans: [] },
      ]);
    });
  }
});

describe('orderBy after select()', () => {
  test('a projected navigation column: its output alias, as before', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, printed: ln.edition!.book!.name }))
      .orderBy(r => [[r.printed, 'ASC'], [r.id, 'DESC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY "printed" ASC, "id" DESC');
  });

  test('a nested object\'s leaf (named a column the root table does not have)', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, books: { direct: ln.book!.name, printed: ln.edition!.book!.name } }))
      .orderBy(r => [[r.books.printed, 'ASC'], [r.id, 'DESC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect(rows[0].books).toEqual({ direct: 'Emma', printed: 'Dune' });
    // The edition's book renders under its path alias: the loan's own book owns "book"
    expect(orderByClause()).toBe('ORDER BY "edition__book"."name" ASC, "id" DESC');
  });

  test('a column of a navigation row projected whole', async () => {
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, printed: ln.edition!.book! }))
      .orderBy(r => [[r.printed.name, 'ASC'], [r.id, 'DESC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
    expect((rows[2].printed as any).name).toBe('Emma');
  });

  test('a projected sql fragment: its output alias', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, shout: sql<string>`upper(${ln.edition!.book!.name})` }))
      .orderBy(r => [[r.shout, 'ASC'], [r.id, 'ASC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY "shout" ASC, "id" ASC');
  });

  test('a sql fragment inside a nested object: its flattened output alias', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, n: { shout: sql<string>`upper(${ln.edition!.book!.name})` } }))
      .orderBy(r => [[r.n.shout, 'ASC'], [r.id, 'ASC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY "__nested__n__shout" ASC, "id" ASC');
  });

  test('a key a later select() renames still orders by the column it named', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, x: ln.note }))
      .orderBy(r => [[r.x, 'DESC']])
      .select(r => ({ id: r.id, x: r.id }))
      .toList();

    expect(rows).toEqual([
      { id: fx.ids.l3, x: fx.ids.l3 },
      { id: fx.ids.l2, x: fx.ids.l2 },
      { id: fx.ids.l1, x: fx.ids.l1 },
    ]);
    expect(orderByClause()).toBe('ORDER BY "lib_loans"."note" DESC');
  });

  test('a key a later select() drops still orders by its navigation', async () => {
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, printed: ln.edition!.book!.name }))
      .orderBy(r => [[r.printed, 'ASC'], [r.id, 'DESC']])
      .select(r => ({ id: r.id }))
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
  });
});

// A key that is an SQL expression used to be dropped from the ORDER BY without a word — the rows came
// back in whatever order the plan produced. Notes reversed: first → "tsrif", second → "dnoces",
// third → "driht".
describe('orderBy by an SQL expression', () => {
  test('a sql fragment over a column, before select()', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'ASC']]).select(ln => ({ id: ln.id })).toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY (reverse("lib_loans"."note")) ASC');
  });

  test('without a select(): the whole row, ordered', async () => {
    const rows = await fx.db.libLoans.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'DESC']]).toList();

    expect(rows.map(row => row.note)).toEqual(['first', 'third', 'second']);
  });

  test('a sql fragment over a navigation joins it', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .orderBy(ln => [[sql<string>`lower(${ln.edition!.book!.name})`, 'DESC'], [ln.id, 'ASC']])
      .select(ln => ({ id: ln.id }))
      .toList();

    // L1's edition prints Emma, L2's and L3's Dune
    expect(ids(rows)).toEqual([fx.ids.l1, fx.ids.l2, fx.ids.l3]);
    expect(fx.lastStatement()).toContain('LEFT JOIN "lib_books" AS "book" ON "edition"."book_id" = "book"."id"');
  });

  test('a parameter inside the fragment is numbered after the WHERE\'s', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .where(ln => gt(ln.id, 0))
      .orderBy(ln => [[sql<number>`position(${'i'} in ${ln.note})`, 'DESC'], [ln.id, 'ASC']])
      .select(ln => ({ note: ln.note }))
      .toList();

    // position of "i": third → 3, first → 2, second → 0
    expect(rows.map(row => row.note)).toEqual(['third', 'first', 'second']);
    expect(fx.lastStatement()).toContain('WHERE "lib_loans"."id" > $1');
    expect(orderByClause()).toBe('ORDER BY (position($2 in "lib_loans"."note")) DESC, "lib_loans"."id" ASC');
  });

  test('a condition as a key', async () => {
    const rows = await fx.db.libLoans
      .orderBy(ln => [[eq(ln.note, 'second'), 'DESC'], [ln.id, 'ASC']])
      .select(ln => ({ note: ln.note }))
      .toList();

    expect(rows.map(row => row.note)).toEqual(['second', 'first', 'third']);
  });

  test('a collection\'s count as a key', async () => {
    fx.resetCapture();
    const rows = await fx.db.libMembers
      .orderBy(m => [[m.loans!.count(), 'ASC'], [m.name, 'DESC']])
      .select(m => ({ name: m.name }))
      .toList();

    expect(rows.map(row => row.name)).toEqual(['Cy', 'Bo', 'Ada']);
    expect(fx.lastStatement().replace(/\s+/g, ' '))
      .toContain('ORDER BY (SELECT COUNT(*) FROM "lib_loans" "loans__count" WHERE "loans__count"."member_id" = "lib_members"."id") ASC');
  });

  test('after select(): a fragment over projected columns reads those columns, under their path aliases', async () => {
    fx.resetCapture();
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, x: ln.note, printed: ln.edition!.book!.name, own: ln.book!.name }))
      .orderBy(r => [[sql<string>`lower(${r.printed})`, 'ASC'], [sql<string>`reverse(${r.x})`, 'ASC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l2, fx.ids.l3, fx.ids.l1]);
    expect(orderByClause()).toBe('ORDER BY (lower("edition__book"."name")) ASC, (reverse("lib_loans"."note")) ASC');
  });

  test('after select(): a fragment over a column of a navigation row projected whole', async () => {
    const rows = await fx.db.libLoans
      .select(ln => ({ id: ln.id, edition: ln.edition! }))
      .orderBy(r => [[sql<string>`reverse(${r.edition.label})`, 'DESC']])
      .toList();

    expect(ids(rows)).toEqual([fx.ids.l3, fx.ids.l2, fx.ids.l1]);
  });

  test('after select(): a fragment over a projected fragment is refused — it has no column to read', () => {
    expect(() => fx.db.libLoans
      .select(ln => ({ id: ln.id, shout: sql<string>`upper(${ln.note})` }))
      .orderBy(r => [[sql<string>`reverse(${r.shout})`, 'DESC']]))
      .toThrow('an expression cannot read the projected value "shout"');
  });

  test('countOver() and limit() order by it too', async () => {
    const rows = await fx.db.libLoans
      .orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'DESC']])
      .select(ln => ({ note: ln.note }))
      .limit(2)
      .toList();

    expect(rows.map(row => row.note)).toEqual(['first', 'third']);
  });
});
