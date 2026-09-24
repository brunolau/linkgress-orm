/**
 * Navigations in the RETURNING of `insert`, `insertBulk`, `upsert`, `upsertBulk` and
 * `insertWithChildren` — the statements that wrap the mutation in a `"__mutation__"` CTE and join
 * the navigations onto it.
 *
 * THE BUG (1.0.6 and earlier): the RETURNING's mock row did not record the path a navigation was
 * reached by, and its joins were resolved by relation NAME. `ln.book` and `ln.edition.book` joined
 * ONE `book` (the loan's own), a deep path was anchored on the first joined table that had a
 * relation of its name, and a path whose middle hop was not projected failed with "missing
 * FROM-clause entry". A collection hanging off a deep path correlated to the wrong book too, and a
 * mapper two hops away was lost:
 *
 *   SELECT "book"."name" AS "direct", "book"."name" AS "printed", "category"."name" AS "printedCat"
 *   FROM "__mutation__"
 *   LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"
 *   LEFT JOIN "lib_categories" AS "category" ON "book"."category_id" = "category"."id"
 *
 * THE FIX: the RETURNING runs under the same NavigationAliasPlan the SELECT, UPDATE and DELETE
 * builds use — every path its own join on its own parent, the shallowest path to a relation name
 * keeps the plain alias, every other one renders as `<parentAlias>__<relation>`. A RETURNING whose
 * paths are all one hop deep renders exactly the SQL it rendered before (pinned at the bottom).
 *
 * The library fixture gives every path of every loan a different value (see library-fixture.ts),
 * so a collapsed or re-parented join cannot produce an expected value by accident.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import {
  createCustomType,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  integer,
  MockRowCache,
  varchar,
} from '../../src';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';
import { byId, createLibraryFixture, disposeLibraryFixture, LibraryFixture } from '../utils/library-fixture';

let fx: LibraryFixture;

beforeAll(async () => {
  fx = await createLibraryFixture('lateral');
});

afterAll(async () => {
  await disposeLibraryFixture(fx);
});

/** Every loan a test writes carries this note; `afterEach` removes them and leaves the seed intact. */
const NOTE = 'irn';

beforeEach(() => {
  fx.resetCapture();
});

afterEach(async () => {
  await fx.db.libLoans.where(ln => eq(ln.note, NOTE)).delete();
});

interface LoanRow {
  memberId: number;
  editionId: number;
  bookId: number;
  note: string;
}

/** Cy's loan of E-1 (Emma, Hardback line) whose own book is Dune. Cy has no favorite book. */
const loanOfE1 = (): LoanRow => ({ memberId: fx.ids.cy, editionId: fx.ids.e1, bookId: fx.ids.dune, note: NOTE });

/** Ada's loan of E-2 (Dune, Paperback line) whose own book is Emma. Ada's favorite is Emma. */
const loanOfE2 = (): LoanRow => ({ memberId: fx.ids.ada, editionId: fx.ids.e2, bookId: fx.ids.emma, note: NOTE });

/**
 * What every path of a loan reads. `...ByCode` is the category a book's `categoryCode` names —
 * deliberately the other one than its `categoryId` (Dune is coded CL, Emma SF).
 */
interface LoanPaths {
  member: string;
  label: string;
  direct: string;
  directCategory: string;
  directByCode: string;
  printed: string;
  printedCategory: string;
  printedByCode: string;
  editionCategory: string;
  favorite: string | null;
  favoriteCategory: string | null;
  printedEditions: string[];
  directEditions: string[];
}

const E1: LoanPaths = {
  member: 'Cy',
  label: 'E-1',
  direct: 'Dune',
  directCategory: 'Sci-fi',
  directByCode: 'Classics',
  printed: 'Emma',
  printedCategory: 'Classics',
  printedByCode: 'Sci-fi',
  editionCategory: 'Hardback line',
  favorite: null,
  favoriteCategory: null,
  printedEditions: ['E-1', 'E-4'],
  directEditions: ['E-2', 'E-3', 'E-5'],
};

const E2: LoanPaths = {
  member: 'Ada',
  label: 'E-2',
  direct: 'Emma',
  directCategory: 'Classics',
  directByCode: 'Sci-fi',
  printed: 'Dune',
  printedCategory: 'Sci-fi',
  printedByCode: 'Classics',
  editionCategory: 'Paperback line',
  favorite: 'Emma',
  favoriteCategory: 'Classics',
  printedEditions: ['E-2', 'E-3', 'E-5'],
  directEditions: ['E-1', 'E-4'],
};

/** The rows without their generated ids. */
const withoutIds = (rows: readonly Record<string, any>[]): Record<string, any>[] => rows.map(({ id: _id, ...rest }) => rest);

/** The last statement that wrapped a mutation in the RETURNING CTE. */
const lastReturning = (): string => fx.lastStatement('"__mutation__"');

/** A RETURNING row: its generated id and whatever else the selector projected. */
type ReturnedRow = Record<string, any> & { id: number };

type LoanSelector = (ln: any) => ReturnedRow;

/** The five paths the fixture tells apart: two ending in `book`, three ending in `category`. */
const FIVE_PATHS: LoanSelector = ln => ({
  id: ln.id,
  direct: ln.book!.name,
  printed: ln.edition!.book!.name,
  directCategory: ln.book!.category!.name,
  printedCategory: ln.edition!.book!.category!.name,
  editionCategory: ln.edition!.category!.name,
});

const fivePathsOf = (paths: LoanPaths): Record<string, any> => ({
  direct: paths.direct,
  printed: paths.printed,
  directCategory: paths.directCategory,
  printedCategory: paths.printedCategory,
  editionCategory: paths.editionCategory,
});

/**
 * Inserts `rows` with their edition and own book swapped for the other loan's, and returns their
 * ids in input order: an upsert over them that read the keys from BEFORE its update would report
 * the other loan's paths.
 */
const insertDecoys = async (rows: LoanRow[]): Promise<number[]> => {
  const decoys = rows.map(row => ({
    ...row,
    editionId: row.editionId === fx.ids.e1 ? fx.ids.e2 : fx.ids.e1,
    bookId: row.bookId === fx.ids.dune ? fx.ids.emma : fx.ids.dune,
  }));
  const inserted = await fx.db.libLoans.insertBulk(decoys).returning(ln => ({ id: ln.id }));

  return byId(inserted).map(row => row.id);
};

interface Runner {
  name: string;
  /** Whether the operation writes every row it is given (single-row operations take the first). */
  multiRow: boolean;
  /** One statement writing `rows`, returning `selector` for each written row. */
  run(rows: LoanRow[], selector: LoanSelector): Promise<ReturnedRow[]>;
}

const RUNNERS: Runner[] = [
  {
    name: 'insert',
    multiRow: false,
    run: async (rows, selector) => [await fx.db.libLoans.insert(rows[0]).returning(selector)],
  },
  {
    name: 'insertBulk',
    multiRow: true,
    run: async (rows, selector) => fx.db.libLoans.insertBulk(rows).returning(selector),
  },
  {
    name: 'upsert (insert branch)',
    multiRow: true,
    run: async (rows, selector) => fx.db.libLoans.upsert(rows as any, { primaryKey: 'id' }).returning(selector),
  },
  {
    name: 'upsertBulk (insert branch)',
    multiRow: true,
    run: async (rows, selector) => fx.db.libLoans.upsertBulk(rows as any, { primaryKey: 'id' }).returning(selector),
  },
  {
    name: 'upsert (conflict branch)',
    multiRow: true,
    run: async (rows, selector) => {
      const ids = await insertDecoys(rows);

      return fx.db.libLoans.upsert(rows.map((row, i) => ({ id: ids[i], ...row })) as any, { primaryKey: 'id' }).returning(selector);
    },
  },
  {
    name: 'upsertBulk (conflict branch)',
    multiRow: true,
    run: async (rows, selector) => {
      const ids = await insertDecoys(rows);

      return fx.db.libLoans.upsertBulk(rows.map((row, i) => ({ id: ids[i], ...row })) as any, { primaryKey: 'id' }).returning(selector);
    },
  },
  {
    // MERGE … RETURNING inside the CTE, its columns qualified by the target alias
    name: 'mergeBulk (insert branch)',
    multiRow: true,
    run: async (rows, selector) => fx.db.libLoans.mergeBulk(rows, { on: ['memberId', 'editionId', 'note'] }).returning(selector),
  },
  {
    // Every row matches its decoy (same member and note) and moves it onto its own edition and book
    name: 'mergeBulk (update branch)',
    multiRow: true,
    run: async (rows, selector) => {
      await insertDecoys(rows);

      return fx.db.libLoans.mergeBulk(rows, { on: ['memberId', 'note'], updateColumns: ['editionId', 'bookId'] }).returning(selector);
    },
  },
];

// ---------------------------------------------------------------------------
// Every operation, every path shape
// ---------------------------------------------------------------------------

for (const runner of RUNNERS) {
  describe(`${runner.name} — RETURNING navigations`, () => {
    const rows = (): LoanRow[] => (runner.multiRow ? [loanOfE1(), loanOfE2()] : [loanOfE1()]);
    const expected = (): LoanPaths[] => (runner.multiRow ? [E1, E2] : [E1]);

    test('one-hop navigations', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        member: ln.member!.name,
        direct: ln.book!.name,
        label: ln.edition!.label,
      })));

      expect(withoutIds(returned)).toEqual(expected().map(paths => ({ member: paths.member, direct: paths.direct, label: paths.label })));
      expect(lastReturning()).not.toContain('__book');
    });

    test('a deep path whose relation names exist nearer the root reads its own rows', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        printed: ln.edition!.book!.name,
        printedCategory: ln.edition!.book!.category!.name,
      })));

      expect(withoutIds(returned)).toEqual(expected().map(paths => ({ printed: paths.printed, printedCategory: paths.printedCategory })));

      const statement = lastReturning();
      expect(statement).toContain('LEFT JOIN "lib_editions" AS "edition" ON "__mutation__"."edition_id" = "edition"."id"');
      expect(statement).toContain('LEFT JOIN "lib_books" AS "book" ON "edition"."book_id" = "book"."id"');
      expect(statement).toContain('LEFT JOIN "lib_categories" AS "category" ON "book"."category_id" = "category"."id"');
      expect(statement).not.toContain('"__mutation__"."book_id"');
    });

    test('all five paths at once — each on a join of its own', async () => {
      const returned = byId(await runner.run(rows(), FIVE_PATHS));

      expect(withoutIds(returned)).toEqual(expected().map(fivePathsOf));

      const statement = lastReturning();
      expect(statement).toContain('LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"');
      expect(statement).toContain('LEFT JOIN "lib_editions" AS "edition" ON "__mutation__"."edition_id" = "edition"."id"');
      expect(statement).toContain('LEFT JOIN "lib_books" AS "edition__book" ON "edition"."book_id" = "edition__book"."id"');
      expect(statement).toContain('LEFT JOIN "lib_categories" AS "category" ON "book"."category_id" = "category"."id"');
      expect(statement).toContain('LEFT JOIN "lib_categories" AS "edition__book__category" ON "edition__book"."category_id" = "edition__book__category"."id"');
      expect(statement).toContain('LEFT JOIN "lib_categories" AS "edition__category" ON "edition"."category_id" = "edition__category"."id"');
      expect(statement).toContain('"book"."name" AS "direct", "edition__book"."name" AS "printed"');
    });

    test('the deep paths projected first — the shallowest path still owns the plain alias', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        editionCategory: ln.edition!.category!.name,
        printedCategory: ln.edition!.book!.category!.name,
        printed: ln.edition!.book!.name,
        directCategory: ln.book!.category!.name,
        direct: ln.book!.name,
      })));

      expect(withoutIds(returned)).toEqual(expected().map(fivePathsOf));

      const statement = lastReturning();
      expect(statement).toContain('"edition__book"."name" AS "printed"');
      expect(statement).toContain('"book"."name" AS "direct"');
      expect(statement).toContain('LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"');
    });

    test('nested object literals', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        books: { direct: ln.book!.name, printed: ln.edition!.book!.name },
        categories: {
          direct: ln.book!.category!.name,
          printed: ln.edition!.book!.category!.name,
          edition: ln.edition!.category!.name,
        },
      })));

      expect(withoutIds(returned)).toEqual(expected().map(paths => ({
        books: { direct: paths.direct, printed: paths.printed },
        categories: { direct: paths.directCategory, printed: paths.printedCategory, edition: paths.editionCategory },
      })));
      expect(lastReturning()).toContain('"edition__book"."name" AS "books.printed"');
    });

    test('whole navigation rows — each read through its own path', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        directBook: ln.book!,
        printedBook: ln.edition!.book!,
      })));

      const book = (name: string) => (name === 'Dune'
        ? { id: fx.ids.dune, name: 'Dune', categoryId: fx.ids.sciFi, categoryCode: 'CL' }
        : { id: fx.ids.emma, name: 'Emma', categoryId: fx.ids.classics, categoryCode: 'SF' });

      expect(withoutIds(returned)).toEqual(expected().map(paths => ({ directBook: book(paths.direct), printedBook: book(paths.printed) })));
    });

    test('two paths ending in a relation keyed on a non-id column', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        directByCode: ln.book!.categoryByCode!.name,
        printedByCode: ln.edition!.book!.categoryByCode!.name,
      })));

      expect(withoutIds(returned)).toEqual(expected().map(paths => ({ directByCode: paths.directByCode, printedByCode: paths.printedByCode })));

      const statement = lastReturning();
      expect(statement).toContain('LEFT JOIN "lib_categories" AS "categoryByCode" ON "book"."category_code" = "categoryByCode"."code"');
      expect(statement).toContain(
        'LEFT JOIN "lib_categories" AS "edition__book__categoryByCode" ON "edition__book"."category_code" = "edition__book__categoryByCode"."code"'
      );
    });

    test('a nullable navigation that is NULL, reached through a hop that is not projected', async () => {
      const returned = byId(await runner.run(rows(), ln => ({
        id: ln.id,
        favorite: ln.member!.favoriteBook!.name,
        favoriteCategory: ln.member!.favoriteBook!.category!.name,
      })));

      expect(withoutIds(returned)).toEqual(expected().map(paths => ({ favorite: paths.favorite, favoriteCategory: paths.favoriteCategory })));
    });

    test('collections hanging off the deep path and off the colliding shallow path', async () => {
      const returned = byId(await runner.run(rows(), (ln: any) => ({
        id: ln.id,
        direct: ln.book.name,
        printedEditions: ln.edition.book.editions.select((ed: any) => ({ label: ed.label })).toList(),
        printedCount: ln.edition.book.editions.count(),
        directEditions: ln.book.editions.select((ed: any) => ({ label: ed.label })).toList(),
        directCount: ln.book.editions.count(),
      })));

      const labels = (list: Array<{ label: string }>): string[] => list.map(ed => ed.label).sort();

      expect(returned.map(row => ({
        direct: row.direct,
        printedEditions: labels(row.printedEditions),
        printedCount: Number(row.printedCount),
        directEditions: labels(row.directEditions),
        directCount: Number(row.directCount),
      }))).toEqual(expected().map(paths => ({
        direct: paths.direct,
        printedEditions: paths.printedEditions,
        printedCount: paths.printedEditions.length,
        directEditions: paths.directEditions,
        directCount: paths.directEditions.length,
      })));
    });
  });
}

// ---------------------------------------------------------------------------
// Multi-row inserts, NULL navigations
// ---------------------------------------------------------------------------

describe('insertBulk — every row reads the paths of its own keys', () => {
  test('four loans, every path different per row', async () => {
    const { ids } = fx;
    const returned = byId(await fx.db.libLoans
      .insertBulk([
        loanOfE1(),
        loanOfE2(),
        { memberId: ids.bo, editionId: ids.e3, bookId: ids.emma, note: NOTE },
        { memberId: ids.bo, editionId: ids.e4, bookId: ids.dune, note: NOTE },
      ])
      .returning((ln: any): ReturnedRow => ({ ...FIVE_PATHS(ln), printedCount: ln.edition.book.editions.count() })));

    expect(withoutIds(returned).map((row): Record<string, any> => ({ ...row, printedCount: Number(row.printedCount) }))).toEqual([
      { ...fivePathsOf(E1), printedCount: 2 },
      { ...fivePathsOf(E2), printedCount: 3 },
      { direct: 'Emma', printed: 'Dune', directCategory: 'Classics', printedCategory: 'Sci-fi', editionCategory: 'Hardback line', printedCount: 3 },
      { direct: 'Dune', printed: 'Emma', directCategory: 'Sci-fi', printedCategory: 'Classics', editionCategory: 'Paperback line', printedCount: 2 },
    ]);
  });
});

describe('insert — a NULL navigation of the inserted row itself', () => {
  test('a member without a favorite book returns NULL through one and two hops; one with a favorite returns it', async () => {
    const returned = byId(await fx.db.libMembers
      .insertBulk([
        { name: 'irn-nobody', favoriteBookId: null },
        { name: 'irn-reader', favoriteBookId: fx.ids.emma },
      ])
      .returning(m => ({ id: m.id, name: m.name, favorite: m.favoriteBook!.name, favoriteCategory: m.favoriteBook!.category!.name })));

    try {
      expect(withoutIds(returned)).toEqual([
        { name: 'irn-nobody', favorite: null, favoriteCategory: null },
        { name: 'irn-reader', favorite: 'Emma', favoriteCategory: 'Classics' },
      ]);
    } finally {
      for (const member of returned) {
        await fx.db.libMembers.where(m => eq(m.id, member.id)).delete();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Collections in RETURNING
// ---------------------------------------------------------------------------

describe('RETURNING collections off a renamed path', () => {
  test('every aggregate off ln.edition.book reads the edition\'s book while ln.book is projected', async () => {
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({
      id: ln.id,
      direct: ln.book.name,
      labels: ln.edition.book.editions.select((ed: any) => ed.label).toStringList(),
      last: ln.edition.book.editions.orderBy((ed: any) => [[ed.label, 'DESC']]).select((ed: any) => ({ label: ed.label })).firstOrDefault(),
      highest: ln.edition.book.editions.max((ed: any) => ed.label),
      hasPaperback: ln.edition.book.editions.where((ed: any) => eq(ed.label, 'E-4')).exists(),
      hasDuneEdition: ln.edition.book.editions.where((ed: any) => eq(ed.label, 'E-5')).exists(),
    }));

    // Off the loan's own book (Dune) every one of these would differ: E-2/E-3/E-5, E-5, false, true
    expect({
      direct: row.direct,
      labels: [...row.labels].sort(),
      last: row.last,
      highest: row.highest,
      hasPaperback: row.hasPaperback,
      hasDuneEdition: row.hasDuneEdition,
    }).toEqual({
      direct: 'Dune',
      labels: ['E-1', 'E-4'],
      last: { label: 'E-4' },
      highest: 'E-4',
      hasPaperback: true,
      hasDuneEdition: false,
    });
  });

  test('limit()ed / offset()ed aggregates off a renamed path read that path — they join it themselves', async () => {
    // Used to be refused: the LATERAL form of a limited aggregate joined none of the path and bound
    // to the relation name `book` — here the loan's OWN book (Dune, three editions)
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({
      id: ln.id,
      direct: ln.book.name,
      printedCount: ln.edition.book.editions.limit(5).count(),
      printedAfterFirst: ln.edition.book.editions.orderBy((ed: any) => ed.label).offset(1).count(),
      printedFirstId: ln.edition.book.editions.orderBy((ed: any) => ed.label).limit(1).max((ed: any) => ed.id),
      printedHasSecond: ln.edition.book.editions.orderBy((ed: any) => ed.label).offset(1).exists(),
    }));

    // Emma's editions: E-1, E-4
    expect(row.direct).toBe('Dune');
    expect(Number(row.printedCount)).toBe(2);
    expect(Number(row.printedAfterFirst)).toBe(1);
    expect(Number(row.printedFirstId)).toBe(fx.ids.e1);
    expect(row.printedHasSecond).toBe(true);
  });

  test('the same limit()ed count off a path that keeps its name is rendered', async () => {
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({
      id: ln.id,
      printedCount: ln.edition.book.editions.limit(5).count(),
    }));

    expect(Number(row.printedCount)).toBe(2);
  });

  test('a nested exists() inside a collection reads that collection\'s item, not another path\'s row', async () => {
    // It used to be rewritten onto the outer joins, where it compared the inserted loan's edition with
    // the outer `edition` join — true for every row — and returned editions no loan holds; then the
    // database refused the reference to the collection's table
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({
      id: ln.id,
      direct: ln.book.name,
      label: ln.edition.label,
      printed: ln.edition.book.name,
      held: ln.edition.book.editions.where((ed: any) => ed.loans.exists()).orderBy((ed: any) => ed.label).select((ed: any) => ({ label: ed.label })).toList(),
    }));

    // Emma's editions: E-1 is held (L1 and the new loan), E-4 is not
    expect(row.held.map((ed: { label: string }) => ed.label)).toEqual(['E-1']);
  });

  test('a collection of the mutated table reached through a navigation (ln.edition.loans)', async () => {
    // Guards the anchor of the path a collection re-joins: the mutated row renders as the CTE, so
    // a path hop named after the table itself would bind to the collection's own row
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({
      id: ln.id,
      direct: ln.book.name,
      printed: ln.edition.book.name,
      sameEdition: ln.edition.loans.select((other: any) => ({ note: other.note })).toList(),
      sameEditionCount: ln.edition.loans.count(),
    }));

    // The CTE's own row is not visible to the statement that inserts it: L1 is E-1's only other loan
    expect(row.sameEdition).toEqual([{ note: 'first' }]);
    expect(Number(row.sameEditionCount)).toBe(1);
  });
});

describe('RETURNING collections off a one-hop navigation', () => {
  test('the LATERAL form joins the path inside its subquery, from the mutated row', async () => {
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({
      id: ln.id,
      editions: ln.book.editions.select((ed: any) => ({ label: ed.label })).toList(),
    }));

    expect(row.editions.map((ed: { label: string }) => ed.label).sort()).toEqual(['E-2', 'E-3', 'E-5']);

    // The outer join renders `AS "book"`; the one inside the subquery does not
    const statement = lastReturning();
    expect(statement).toContain('LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"');
    expect(statement).toContain('LEFT JOIN "lib_books" "book" ON "__mutation__"."book_id" = "book"."id"');
  });
});

// ---------------------------------------------------------------------------
// insertWithChildren
// ---------------------------------------------------------------------------

describe('insertWithChildren — child RETURNING navigations', () => {
  test('colliding paths of the children, and the child → parent navigation reading the new parent', async () => {
    const result = await fx.db.libMembers.insertWithChildren({
      row: { name: 'irn-parent', favoriteBookId: null },
      children: {
        table: fx.db.libLoans,
        foreignKey: 'memberId',
        rows: [
          { editionId: fx.ids.e1, bookId: fx.ids.dune, note: NOTE },
          { editionId: fx.ids.e2, bookId: fx.ids.emma, note: NOTE },
        ],
      },
      returning: {
        parent: m => ({ id: m.id }),
        children: (ln: any) => ({ ...FIVE_PATHS(ln), member: ln.member.name }),
      },
    });

    try {
      expect(withoutIds(result.children)).toEqual([
        { ...fivePathsOf(E1), member: 'irn-parent' },
        { ...fivePathsOf(E2), member: 'irn-parent' },
      ]);

      const statement = lastReturning();
      // The parent table reads the new parent (the CTE) together with its existing rows
      expect(statement).toContain('LEFT JOIN (SELECT * FROM "__iwc_parent__" UNION ALL SELECT * FROM "lib_members") AS "member" ON "__mutation__"."member_id" = "member"."id"');
      expect(statement).toContain('LEFT JOIN "lib_books" AS "edition__book" ON "edition"."book_id" = "edition__book"."id"');
    } finally {
      await fx.db.libLoans.where(ln => eq(ln.note, NOTE)).delete();
      await fx.db.libMembers.where(m => eq(m.id, result.parent!.id)).delete();
    }
  });

  test('a child RETURNING that does not project the child key still orders by it', async () => {
    const result = await fx.db.libBooks.insertWithChildren({
      row: { name: 'irn-book', categoryId: fx.ids.classics },
      children: {
        table: fx.db.libEditions,
        foreignKey: 'bookId',
        rows: [
          { label: 'irn-1', categoryId: fx.ids.hardback },
          { label: 'irn-2', categoryId: fx.ids.paperback },
        ],
      },
      returning: {
        parent: b => ({ id: b.id }),
        children: ed => ({ label: ed.label, book: ed.book!.name, bookCategory: ed.book!.category!.name, category: ed.category!.name }),
      },
    });

    try {
      expect(result.children).toEqual([
        { label: 'irn-1', book: 'irn-book', bookCategory: 'Classics', category: 'Hardback line' },
        { label: 'irn-2', book: 'irn-book', bookCategory: 'Classics', category: 'Paperback line' },
      ]);
    } finally {
      await fx.db.libEditions.where(ed => eq(ed.bookId, result.parent!.id)).delete();
      await fx.db.libBooks.where(b => eq(b.id, result.parent!.id)).delete();
    }
  });

  test('a child → parent-TABLE navigation to an EXISTING row reads it — the parent table is the CTE together with the table', async () => {
    // Books under a new category, each coded (categoryByCode) to a category: an existing one, or the new one
    const result = await fx.db.libCategories.insertWithChildren({
      row: { name: 'irn-category', code: 'IR' },
      children: {
        table: fx.db.libBooks,
        foreignKey: 'categoryId',
        rows: [
          { name: 'irn-coded-sf', categoryCode: 'SF' },
          { name: 'irn-coded-own', categoryCode: 'IR' },
        ],
      },
      returning: {
        parent: c => ({ id: c.id }),
        children: b => ({ name: b.name, category: b.category!.name, byCode: b.categoryByCode!.name }),
      },
    });

    try {
      expect(result.children).toEqual([
        { name: 'irn-coded-sf', category: 'irn-category', byCode: 'Sci-fi' },
        { name: 'irn-coded-own', category: 'irn-category', byCode: 'irn-category' },
      ]);
    } finally {
      await fx.db.libBooks.where(b => eq(b.categoryId, result.parent!.id)).delete();
      await fx.db.libCategories.where(c => eq(c.id, result.parent!.id)).delete();
    }
  });
});

describe('insertWithChildren — parent RETURNING navigations', () => {
  test('navigations, collections and nested objects of the parent — read back, children included', async () => {
    const result = await fx.db.libBooks.insertWithChildren({
      row: { name: 'irn-read-back', categoryId: fx.ids.sciFi },
      children: {
        table: fx.db.libEditions,
        foreignKey: 'bookId',
        rows: [
          { label: 'irn-b', categoryId: fx.ids.paperback },
          { label: 'irn-a', categoryId: fx.ids.hardback },
        ],
      },
      returning: {
        parent: b => ({
          id: b.id,
          category: b.category!.name,
          editionCount: b.editions!.count(),
          labels: b.editions!.orderBy(ed => ed.label).select(ed => ed.label).toList(),
          info: { name: b.name, categoryName: b.category!.name },
        }),
        children: ed => ({ label: ed.label }),
      },
    });

    try {
      expect(withoutIds([result.parent!])).toEqual([{
        category: 'Sci-fi',
        editionCount: 2,
        labels: ['irn-a', 'irn-b'],
        info: { name: 'irn-read-back', categoryName: 'Sci-fi' },
      }]);
      expect(result.children).toEqual([{ label: 'irn-b' }, { label: 'irn-a' }]);
    } finally {
      await fx.db.libEditions.where(ed => eq(ed.bookId, result.parent!.id)).delete();
      await fx.db.libBooks.where(b => eq(b.id, result.parent!.id)).delete();
    }
  });

  test('a parent selector projecting nothing still returns the children', async () => {
    const result = await fx.db.libBooks.insertWithChildren({
      row: { name: 'irn-empty-parent', categoryId: fx.ids.sciFi },
      children: { table: fx.db.libEditions, foreignKey: 'bookId', rows: [{ label: 'irn-e', categoryId: fx.ids.hardback }] },
      returning: { parent: () => ({}), children: ed => ({ label: ed.label, book: ed.book!.name }) },
    });
    const inserted = await fx.db.libBooks.where(b => eq(b.name, 'irn-empty-parent')).select(b => b.id).toList();

    try {
      expect(result.parent).toEqual({});
      expect(result.children).toEqual([{ label: 'irn-e', book: 'irn-empty-parent' }]);
    } finally {
      await fx.db.libEditions.where(ed => eq(ed.label, 'irn-e')).delete();
      await fx.db.libBooks.where(b => eq(b.id, inserted[0])).delete();
    }
  });

  test('a guard that suppresses the insert returns no parent, and reads nothing back', async () => {
    fx.resetCapture();
    const result = await fx.db.libBooks.insertWithChildren({
      row: { name: 'Dune', categoryId: fx.ids.sciFi },
      unlessExists: fx.db.libBooks.where(b => eq(b.name, 'Dune')).select(b => ({ id: b.id })),
      children: { table: fx.db.libEditions, foreignKey: 'bookId', rows: [{ label: 'irn-guarded', categoryId: fx.ids.hardback }] },
      returning: { parent: b => ({ id: b.id, labels: b.editions!.select(ed => ed.label).toList() }), children: ed => ({ label: ed.label }) },
    });

    expect(result).toEqual({ parent: null, children: [] });
    expect(fx.statements().filter(s => s.includes('SELECT') && !s.includes('INSERT'))).toEqual([]);
  });
});

describe('insertBulkWithChildren — RETURNING navigations', () => {
  const cleanUp = async (categoryIds: number[]) => {
    for (const id of categoryIds) {
      await fx.db.libBooks.where(b => eq(b.categoryId, id)).delete();
      await fx.db.libCategories.where(c => eq(c.id, id)).delete();
    }
  };

  test('child navigations: to the new parent, to an existing parent-table row, to another table; parents in input order', async () => {
    const result = await fx.db.libCategories.insertBulkWithChildren({
      rows: [{ name: 'irn-drama', code: 'DR' }, { name: 'irn-essays', code: 'ES' }],
      children: {
        table: fx.db.libBooks,
        foreignKey: 'categoryId',
        rows: [
          { parentIndex: 1, row: { name: 'irn-essais', categoryCode: 'CL' } },
          { parentIndex: 0, row: { name: 'irn-hamlet', categoryCode: 'DR' } },
          { parentIndex: 0, row: { name: 'irn-faust', categoryCode: 'ES' } },
        ],
      },
      returning: {
        parents: c => ({ id: c.id, name: c.name }),
        children: b => ({ name: b.name, category: b.category!.name, byCode: b.categoryByCode!.name, editions: b.editions!.count() }),
      },
    });

    try {
      expect(result.parents.map(p => p.name)).toEqual(['irn-drama', 'irn-essays']);
      expect(result.children).toEqual([
        { name: 'irn-essais', category: 'irn-essays', byCode: 'Classics', editions: 0 },
        { name: 'irn-hamlet', category: 'irn-drama', byCode: 'irn-drama', editions: 0 },
        { name: 'irn-faust', category: 'irn-drama', byCode: 'irn-essays', editions: 0 },
      ]);
      expect(lastReturning()).toContain('LEFT JOIN (SELECT * FROM "__ibwc_parent__" UNION ALL SELECT * FROM "lib_categories") AS "category"');
    } finally {
      await cleanUp(result.parents.map(p => p.id));
    }
  });

  test('parent navigations and collections — read back in input order, their new children included', async () => {
    const result = await fx.db.libCategories.insertBulkWithChildren({
      rows: [{ name: 'irn-poetry', code: 'PO' }, { name: 'irn-prose', code: 'PR' }],
      children: {
        table: fx.db.libBooks,
        foreignKey: 'categoryId',
        rows: [
          { parentIndex: 1, row: { name: 'irn-novel' } },
          { parentIndex: 0, row: { name: 'irn-sonnets' } },
          { parentIndex: 0, row: { name: 'irn-odes' } },
        ],
      },
      returning: {
        parents: c => ({
          id: c.id,
          name: c.name,
          bookCount: c.books!.count(),
          titles: c.books!.orderBy(b => b.name).select(b => b.name).toList(),
          coded: c.booksByCode!.select(b => b.name).toList(),
        }),
        children: b => ({ name: b.name }),
      },
    });

    try {
      expect(withoutIds(result.parents)).toEqual([
        { name: 'irn-poetry', bookCount: 2, titles: ['irn-odes', 'irn-sonnets'], coded: [] },
        { name: 'irn-prose', bookCount: 1, titles: ['irn-novel'], coded: [] },
      ]);
      expect(result.children.map(c => c.name)).toEqual(['irn-novel', 'irn-sonnets', 'irn-odes']);
    } finally {
      await cleanUp(result.parents.map(p => p.id));
    }
  });

  test('both sides navigating at once', async () => {
    const result = await fx.db.libCategories.insertBulkWithChildren({
      rows: [{ name: 'irn-both', code: 'BO' }],
      children: { table: fx.db.libBooks, foreignKey: 'categoryId', rows: [{ parentIndex: 0, row: { name: 'irn-both-book', categoryCode: 'SF' } }] },
      returning: {
        parents: c => ({ id: c.id, books: c.books!.select(b => ({ name: b.name, byCode: b.categoryByCode!.name })).toList() }),
        children: b => ({ name: b.name, category: b.category!.name }),
      },
    });

    try {
      expect(withoutIds(result.parents)).toEqual([{ books: [{ name: 'irn-both-book', byCode: 'Sci-fi' }] }]);
      expect(result.children).toEqual([{ name: 'irn-both-book', category: 'irn-both' }]);
    } finally {
      await cleanUp(result.parents.map(p => p.id));
    }
  });

  test('flat selectors on both sides keep the single statement, without the parent key column', async () => {
    fx.resetCapture();
    const result = await fx.db.libCategories.insertBulkWithChildren({
      rows: [{ name: 'irn-flat', code: 'FL' }],
      children: { table: fx.db.libBooks, foreignKey: 'categoryId', rows: [{ parentIndex: 0, row: { name: 'irn-flat-book' } }] },
      returning: { parents: c => ({ id: c.id, name: c.name }), children: b => ({ name: b.name }) },
    });

    try {
      expect(result.parents.map(p => p.name)).toEqual(['irn-flat']);
      expect(result.children).toEqual([{ name: 'irn-flat-book' }]);
      expect(fx.statements().filter(s => s.includes('lib_categories'))).toHaveLength(1);
      expect(fx.lastStatement('__ibwc_parent__')).not.toContain('__ibwc_parent__.__pk');
    } finally {
      await cleanUp(result.parents.map(p => p.id));
    }
  });
});

describe('RETURNING navigations with MockRowCache enabled', () => {
  afterAll(() => {
    MockRowCache.reset();
  });

  test('rows built from cached prototypes still get the path aliases of their own evaluation', async () => {
    MockRowCache.setEnabled(true);

    // A SELECT between the RETURNINGs mints rows of the same relations from another anchor
    for (let run = 0; run < 3; run++) {
      const returned = byId(await fx.db.libLoans.insertBulk([loanOfE1(), loanOfE2()]).returning(FIVE_PATHS));
      const selected = await fx.db.libLoans.where(ln => eq(ln.id, fx.ids.l1)).select(FIVE_PATHS).toList();

      expect(withoutIds(returned)).toEqual([fivePathsOf(E1), fivePathsOf(E2)]);
      expect(withoutIds(selected)).toEqual([{ direct: 'Dune', printed: 'Emma', directCategory: 'Sci-fi', printedCategory: 'Classics', editionCategory: 'Hardback line' }]);

      await fx.db.libLoans.where(ln => eq(ln.note, NOTE)).delete();
    }

    expect(MockRowCache.diagnostics().entries).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// returning() without a selector
// ---------------------------------------------------------------------------

describe('returning() without a selector is unchanged', () => {
  test('insert, insertBulk and upsertBulk return whole entities without the CTE', async () => {
    const inserted = await fx.db.libLoans.insert(loanOfE1()).returning();
    const bulk = await fx.db.libLoans.insertBulk([loanOfE2()]).returning();
    const upserted = await fx.db.libLoans.upsertBulk([{ id: inserted.id, ...loanOfE2() }] as any, { primaryKey: 'id' }).returning();

    expect(withoutIds([inserted, ...bulk, ...upserted])).toEqual([
      { ...loanOfE1() },
      { ...loanOfE2() },
      { ...loanOfE2() },
    ]);
    expect(fx.statements().some(statement => statement.includes('"__mutation__"'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A schema of our own for what the library fixture has no column for: a mapped column two hops
// deep, and relation names long enough that a path alias exceeds PostgreSQL's identifier limit.
// ---------------------------------------------------------------------------

/** Stored upper-case and read back decorated, so a value that skipped `fromDriver` is recognisable. */
const genreCode = createCustomType<{ data: string; driverData: string }>({
  dataType: () => 'varchar',
  toDriver: value => (value == null ? null : value.toUpperCase()),
  fromDriver: value => (value == null ? null : `<${value.toLowerCase()}>`),
});

class IrnGenre extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
}

class IrnBook extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  genreId!: DbColumn<number>;

  genre?: IrnGenre;
}

class IrnEdition extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;
  genreId!: DbColumn<number>;

  book?: IrnBook;
  genre?: IrnGenre;
}

class IrnLoan extends DbEntity {
  id!: DbColumn<number>;
  editionId!: DbColumn<number>;
  bookId!: DbColumn<number>;

  edition?: IrnEdition;
  book?: IrnBook;
}

class IrnLongBook extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class IrnLongEdition extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;

  bookThatThisRelationNameMakesDeliberatelyLong?: IrnLongBook;
}

class IrnLongLoan extends DbEntity {
  id!: DbColumn<number>;
  editionId!: DbColumn<number>;
  bookId!: DbColumn<number>;

  editionThatThisRelationNameMakesLongToo?: IrnLongEdition;
  bookThatThisRelationNameMakesDeliberatelyLong?: IrnLongBook;
}

class IrnDatabase extends DbContext {
  get irnGenres(): DbEntityTable<IrnGenre> {
    return this.table(IrnGenre);
  }

  get irnBooks(): DbEntityTable<IrnBook> {
    return this.table(IrnBook);
  }

  get irnEditions(): DbEntityTable<IrnEdition> {
    return this.table(IrnEdition);
  }

  get irnLoans(): DbEntityTable<IrnLoan> {
    return this.table(IrnLoan);
  }

  get irnLongBooks(): DbEntityTable<IrnLongBook> {
    return this.table(IrnLongBook);
  }

  get irnLongEditions(): DbEntityTable<IrnLongEdition> {
    return this.table(IrnLongEdition);
  }

  get irnLongLoans(): DbEntityTable<IrnLongLoan> {
    return this.table(IrnLongLoan);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(IrnGenre, entity => {
      entity.toTable('irn_genres');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_genres_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 20)).isRequired().hasCustomMapper(genreCode);
    });

    model.entity(IrnBook, entity => {
      entity.toTable('irn_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_books_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.genreId).hasType(integer('genre_id')).isRequired();

      entity.hasOne(e => e.genre, () => IrnGenre)
        .withForeignKey(b => b.genreId)
        .withPrincipalKey(g => g.id);
    });

    model.entity(IrnEdition, entity => {
      entity.toTable('irn_editions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_editions_id_seq' }));
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.genreId).hasType(integer('genre_id')).isRequired();

      entity.hasOne(e => e.book, () => IrnBook)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);

      entity.hasOne(e => e.genre, () => IrnGenre)
        .withForeignKey(ed => ed.genreId)
        .withPrincipalKey(g => g.id);
    });

    model.entity(IrnLoan, entity => {
      entity.toTable('irn_loans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_loans_id_seq' }));
      entity.property(e => e.editionId).hasType(integer('edition_id')).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();

      entity.hasOne(e => e.edition, () => IrnEdition)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(ed => ed.id);

      entity.hasOne(e => e.book, () => IrnBook)
        .withForeignKey(ln => ln.bookId)
        .withPrincipalKey(b => b.id);
    });

    model.entity(IrnLongBook, entity => {
      entity.toTable('irn_long_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_long_books_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(IrnLongEdition, entity => {
      entity.toTable('irn_long_editions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_long_editions_id_seq' }));
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();

      entity.hasOne(e => e.bookThatThisRelationNameMakesDeliberatelyLong, () => IrnLongBook)
        .withForeignKey(ed => ed.bookId)
        .withPrincipalKey(b => b.id);
    });

    model.entity(IrnLongLoan, entity => {
      entity.toTable('irn_long_loans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'irn_long_loans_id_seq' }));
      entity.property(e => e.editionId).hasType(integer('edition_id')).isRequired();
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();

      entity.hasOne(e => e.editionThatThisRelationNameMakesLongToo, () => IrnLongEdition)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(ed => ed.id);

      entity.hasOne(e => e.bookThatThisRelationNameMakesDeliberatelyLong, () => IrnLongBook)
        .withForeignKey(ln => ln.bookId)
        .withPrincipalKey(b => b.id);
    });
  }
}

const IRN_TABLES = ['irn_loans', 'irn_editions', 'irn_books', 'irn_genres', 'irn_long_loans', 'irn_long_editions', 'irn_long_books'];

const dropIrnTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of IRN_TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

describe('mapped columns and refusals (a schema of their own)', () => {
  let client: DatabaseClient;
  let db: IrnDatabase;
  let dune: number;
  let emma: number;
  let classicsGenre: number;
  let editionOfEmma: number;
  let longEdition: number;
  let longBook: number;

  beforeAll(async () => {
    client = createFreshClient();
    db = new IrnDatabase(client, { logQueries: false });
    await dropIrnTables(client);
    await db.getSchemaManager().ensureCreated();

    const [sciFi, classics, hardback] = await db.irnGenres.insertBulk([
      { code: 'scifi' },
      { code: 'classics' },
      { code: 'hardback' },
    ]).returning();
    const [duneRow, emmaRow] = await db.irnBooks.insertBulk([
      { name: 'Dune', genreId: sciFi.id },
      { name: 'Emma', genreId: classics.id },
    ]).returning();
    const [edition] = await db.irnEditions.insertBulk([{ bookId: emmaRow.id, genreId: hardback.id }]).returning();
    const [book] = await db.irnLongBooks.insertBulk([{ name: 'Long' }]).returning();
    const [longEditionRow] = await db.irnLongEditions.insertBulk([{ bookId: book.id }]).returning();

    dune = duneRow.id;
    emma = emmaRow.id;
    classicsGenre = classics.id;
    editionOfEmma = edition.id;
    longBook = book.id;
    longEdition = longEditionRow.id;
  });

  afterAll(async () => {
    await dropIrnTables(client);
    await db.dispose();
  });

  /**
   * A mapped column through two paths ending in `genre` (the loan's own book's, the edition's
   * book's) and a third ending in the same name (the edition's own), in a nested object and in a
   * whole navigation row. A loan of Emma's edition whose own book is Dune tells them all apart.
   */
  const MAPPED_PATHS = (ln: any) => ({
    id: ln.id,
    directCode: ln.book.genre.code,
    printedCode: ln.edition.book.genre.code,
    editionCode: ln.edition.genre.code,
    nested: { printedCode: ln.edition.book.genre.code },
    printedGenre: ln.edition.book.genre,
  });

  const mappedValues = (id: number) => ({
    id,
    directCode: '<scifi>',
    printedCode: '<classics>',
    editionCode: '<hardback>',
    nested: { printedCode: '<classics>' },
    printedGenre: { id: classicsGenre, code: '<classics>' },
  });

  test('insert: a mapped column two hops deep goes through fromDriver, on its own path', async () => {
    const row = await db.irnLoans.insert({ editionId: editionOfEmma, bookId: dune }).returning(MAPPED_PATHS);

    expect(row).toEqual(mappedValues(row.id));
  });

  test('upsertBulk (conflict branch): the mapped columns of the UPDATED keys', async () => {
    const decoy = await db.irnLoans.insert({ editionId: editionOfEmma, bookId: emma }).returning(ln => ({ id: ln.id }));
    const rows = await db.irnLoans
      .upsertBulk([{ id: decoy.id, editionId: editionOfEmma, bookId: dune }] as any, { primaryKey: 'id' })
      .returning(MAPPED_PATHS);

    expect(rows).toEqual([mappedValues(decoy.id)]);
  });

  test('a path alias past PostgreSQL\'s 63-byte identifier limit is refused, naming both paths', async () => {
    const error = await expectToReject(db.irnLongLoans
      .insert({ editionId: longEdition, bookId: longBook })
      .returning(ln => ({
        id: ln.id,
        direct: ln.bookThatThisRelationNameMakesDeliberatelyLong!.name,
        throughEdition: ln.editionThatThisRelationNameMakesLongToo!.bookThatThisRelationNameMakesDeliberatelyLong!.name,
      })));

    expect(error.message).toContain('"editionThatThisRelationNameMakesLongToo.bookThatThisRelationNameMakesDeliberatelyLong"');
    expect(error.message).toContain('the path "bookThatThisRelationNameMakesDeliberatelyLong"');
    expect(error.message).toContain('63-byte');
    expect(await db.irnLongLoans.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Counter-tests: a RETURNING whose navigations are all one hop deep — or deep without a
// collision — renders exactly the SQL it rendered before. Every statement below was captured
// from 1.0.6, before the fix, and must never change.
// ---------------------------------------------------------------------------

const PIN_ONE_HOP = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_loans" ("member_id", "edition_id", "book_id", "note") VALUES ($1, $2, $3, $4) RETURNING "id", "member_id", "book_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "member"."name" AS "member", "book"."name" AS "book"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_members" AS "member" ON "__mutation__"."member_id" = "member"."id"',
  'LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"',
].join('\n');

const PIN_ONE_HOP_NESTED = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_loans" ("member_id", "edition_id", "book_id", "note") VALUES ($1, $2, $3, $4) RETURNING "id", "member_id", "edition_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "member"."name" AS "info.member", "edition"."label" AS "info.label"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_members" AS "member" ON "__mutation__"."member_id" = "member"."id"',
  'LEFT JOIN "lib_editions" AS "edition" ON "__mutation__"."edition_id" = "edition"."id"',
].join('\n');

const PIN_EDITION_AND_CATEGORY = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_loans" ("member_id", "edition_id", "book_id", "note") VALUES ($1, $2, $3, $4) RETURNING "id", "edition_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "edition"."label" AS "label", "category"."name" AS "editionCat"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_editions" AS "edition" ON "__mutation__"."edition_id" = "edition"."id"',
  'LEFT JOIN "lib_categories" AS "category" ON "edition"."category_id" = "category"."id"',
].join('\n');

const PIN_BOOK_AND_CATEGORY = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_loans" ("member_id", "edition_id", "book_id", "note") VALUES ($1, $2, $3, $4) RETURNING "id", "book_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "book"."name" AS "book", "category"."name" AS "bookCat"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"',
  'LEFT JOIN "lib_categories" AS "category" ON "book"."category_id" = "category"."id"',
].join('\n');

const PIN_MEMBER_COLLECTIONS = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_members" ("name", "favorite_book_id") VALUES ($1, $2) RETURNING "id", "favorite_book_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "favoriteBook"."name" AS "fav", COALESCE("lateral_0".data, \'[]\'::json) AS "loans", (SELECT COALESCE(COUNT(*), 0)',
  'FROM "lib_loans" "lateral_1_loans"',
  '',
  'WHERE "lateral_1_loans"."member_id" = "__mutation__"."id") AS "n"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_books" AS "favoriteBook" ON "__mutation__"."favorite_book_id" = "favoriteBook"."id"',
  'LEFT JOIN LATERAL (SELECT json_agg(',
  '  json_build_object(\'id\', "id")',
  ') as data',
  'FROM (',
  '  SELECT "lateral_0_loans"."id" as "id"',
  '  FROM "lib_loans" "lateral_0_loans"',
  '  ',
  '  ',
  '  WHERE "lateral_0_loans"."member_id" = "__mutation__"."id"',
  '  ',
  '  ',
  ') sub) "lateral_0" ON true',
].join('\n');

const PIN_MEMBER_FAVORITE = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_members" ("name", "favorite_book_id") VALUES ($1, $2) RETURNING "id", "favorite_book_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "favoriteBook"."name" AS "fav"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_books" AS "favoriteBook" ON "__mutation__"."favorite_book_id" = "favoriteBook"."id"',
].join('\n');

const PIN_ONE_HOP_COUNT = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_loans" ("member_id", "edition_id", "book_id", "note") VALUES ($1, $2, $3, $4) RETURNING "id", "book_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", (SELECT COALESCE(COUNT(*), 0)',
  'FROM "lib_editions" "lateral_0_editions"',
  '',
  'WHERE "lateral_0_editions"."book_id" = "book"."id") AS "n"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"',
].join('\n');

const PIN_UPSERT_ONE_HOP = [
  'WITH "__mutation__" AS (',
  '  INSERT INTO "lib_loans" ("id", "member_id", "edition_id", "book_id", "note") OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("id") DO UPDATE SET "note" = EXCLUDED."note" RETURNING "id", "member_id", "book_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "member"."name" AS "member", "book"."name" AS "book"',
  'FROM "__mutation__"',
  'LEFT JOIN "lib_members" AS "member" ON "__mutation__"."member_id" = "member"."id"',
  'LEFT JOIN "lib_books" AS "book" ON "__mutation__"."book_id" = "book"."id"',
].join('\n');

const PIN_RETURNING_ALL = 'INSERT INTO "lib_loans" ("member_id", "edition_id", "book_id", "note") VALUES ($1, $2, $3, $4) RETURNING "id", "member_id", "edition_id", "book_id", "note"';

const PIN_INSERT_WITH_CHILDREN = [
  'WITH "__iwc_parent__" AS (',
  'INSERT INTO "lib_books" ("name", "category_id")',
  'SELECT v."name", v."category_id" FROM (VALUES ($1::varchar, $2::integer)) AS v("name", "category_id")',
  'RETURNING *',
  '),',
  '"__mutation__" AS (',
  '  INSERT INTO "lib_editions" ("book_id", "label", "category_id")',
  'SELECT p."id", v."label", v."category_id" FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, $3::varchar, $4::integer)) AS v("__iwc_ord", "label", "category_id")',
  'ORDER BY v."__iwc_ord" RETURNING "id", "label", "book_id", "category_id"',
  ')',
  'SELECT "__mutation__"."id" AS "id", "__mutation__"."label" AS "label", "book"."name" AS "bookName", "category"."name" AS "cat", "__iwc_parent_j__"."id" AS "__iwc_parent__.id"',
  'FROM "__mutation__"',
  'CROSS JOIN "__iwc_parent__" AS "__iwc_parent_j__"',
  'LEFT JOIN (SELECT * FROM "__iwc_parent__" UNION ALL SELECT * FROM "lib_books") AS "book" ON "__mutation__"."book_id" = "book"."id"',
  'LEFT JOIN "lib_categories" AS "category" ON "__mutation__"."category_id" = "category"."id"',
  'ORDER BY "__mutation__"."id"',
].join('\n');

describe('non-colliding RETURNING SQL is unchanged', () => {
  test('insert: one-hop navigations', async () => {
    await fx.db.libLoans.insert(loanOfE1()).returning(ln => ({ id: ln.id, member: ln.member!.name, book: ln.book!.name }));

    expect(lastReturning()).toBe(PIN_ONE_HOP);
  });

  test('insert: one-hop navigations in a nested object', async () => {
    await fx.db.libLoans.insert(loanOfE1()).returning(ln => ({ id: ln.id, info: { member: ln.member!.name, label: ln.edition!.label } }));

    expect(lastReturning()).toBe(PIN_ONE_HOP_NESTED);
  });

  test('insert: ln.edition + ln.edition.category', async () => {
    const row = await fx.db.libLoans.insert(loanOfE1()).returning(ln => ({
      id: ln.id,
      label: ln.edition!.label,
      editionCat: ln.edition!.category!.name,
    }));

    expect(row.editionCat).toBe('Hardback line');
    expect(lastReturning()).toBe(PIN_EDITION_AND_CATEGORY);
  });

  test('insert: ln.book + ln.book.category', async () => {
    const row = await fx.db.libLoans.insert(loanOfE1()).returning(ln => ({
      id: ln.id,
      book: ln.book!.name,
      bookCat: ln.book!.category!.name,
    }));

    expect(row.bookCat).toBe('Sci-fi');
    expect(lastReturning()).toBe(PIN_BOOK_AND_CATEGORY);
  });

  test('insert: a one-hop count', async () => {
    const row = await fx.db.libLoans.insert(loanOfE1()).returning((ln: any) => ({ id: ln.id, n: ln.book.editions.count() }));

    expect(Number(row.n)).toBe(3);
    expect(lastReturning()).toBe(PIN_ONE_HOP_COUNT);
  });

  test('insert: collections of the inserted row and a NULL navigation', async () => {
    const members: number[] = [];

    try {
      const withCollections = await fx.db.libMembers.insert({ name: 'irn-pin', favoriteBookId: fx.ids.emma }).returning((m: any) => ({
        id: m.id,
        fav: m.favoriteBook.name,
        loans: m.loans.select((l: any) => ({ id: l.id })).toList(),
        n: m.loans.count(),
      }));
      members.push(withCollections.id);

      expect({ fav: withCollections.fav, loans: withCollections.loans, n: Number(withCollections.n) }).toEqual({ fav: 'Emma', loans: [], n: 0 });
      expect(lastReturning()).toBe(PIN_MEMBER_COLLECTIONS);

      const withoutFavorite = await fx.db.libMembers.insert({ name: 'irn-pin', favoriteBookId: null }).returning(m => ({ id: m.id, fav: m.favoriteBook!.name }));
      members.push(withoutFavorite.id);

      expect(withoutFavorite.fav).toBeNull();
      expect(lastReturning()).toBe(PIN_MEMBER_FAVORITE);
    } finally {
      for (const id of members) {
        await fx.db.libMembers.where(m => eq(m.id, id)).delete();
      }
    }
  });

  test('upsertBulk: one-hop navigations', async () => {
    const inserted = await fx.db.libLoans.insert(loanOfE1()).returning(ln => ({ id: ln.id }));
    const [row] = await fx.db.libLoans
      .upsertBulk([{ id: inserted.id, ...loanOfE1() }] as any, { primaryKey: 'id', updateColumns: ['note'] } as any)
      .returning(ln => ({ id: ln.id, member: ln.member!.name, book: ln.book!.name }));

    expect(row).toEqual({ id: inserted.id, member: 'Cy', book: 'Dune' });
    expect(lastReturning()).toBe(PIN_UPSERT_ONE_HOP);
  });

  test('insert: returning() without a selector', async () => {
    await fx.db.libLoans.insert(loanOfE1()).returning();

    expect(fx.lastStatement('INSERT INTO "lib_loans"')).toBe(PIN_RETURNING_ALL);
  });

  test('insertWithChildren: one-hop child navigations, one of them to the new parent', async () => {
    const result = await fx.db.libBooks.insertWithChildren({
      row: { name: 'irn-pin', categoryId: fx.ids.sciFi },
      children: { table: fx.db.libEditions, foreignKey: 'bookId', rows: [{ label: 'irn-pin', categoryId: fx.ids.hardback }] },
      returning: {
        parent: b => ({ id: b.id }),
        children: ed => ({ id: ed.id, label: ed.label, bookName: ed.book!.name, cat: ed.category!.name }),
      },
    });

    try {
      expect(withoutIds(result.children)).toEqual([{ label: 'irn-pin', bookName: 'irn-pin', cat: 'Hardback line' }]);
      expect(lastReturning()).toBe(PIN_INSERT_WITH_CHILDREN);
    } finally {
      await fx.db.libEditions.where(ed => eq(ed.bookId, result.parent!.id)).delete();
      await fx.db.libBooks.where(b => eq(b.id, result.parent!.id)).delete();
    }
  });
});
