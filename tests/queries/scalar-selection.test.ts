import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inSubquery, QueryBatch, sql } from '../../src';
import { createLibraryFixture, disposeLibraryFixture, LibraryFixture, LIBRARY_STRATEGIES } from '../utils/library-fixture';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture } from '../utils/expression-fixture';
import { seedTestData, withDatabase } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { assertType } from '../utils/type-tester';

/**
 * A selector that returns ONE column or expression — `b => b.name`, `e => e.book.name`,
 * `b => sql\`upper(${b.name})\`` — reads as the list of that value, as its type says (`string[]`),
 * at the root of a query and in a collection.
 *
 * A root query returned EMPTY objects (`[{}, {}]`: the value's own ref keys were read as the
 * projection's fields), a navigation column there did not even join its navigation ("missing
 * FROM-clause entry"), and a collection returned `[{ label: 'E-1' }, …]` — or `[{}, …]` for an
 * expression, which it did not project at all. The SQL of such a query is unchanged: a CTE body or
 * subquery built from it still names its column by the column's name.
 *
 *   edition  book  category          held by
 *   E-1      Emma  Hardback line     L1 ("first")
 *   E-2      Dune  Paperback line    L2 ("second")
 *   E-3      Dune  Hardback line     L3 ("third")
 *   E-4      Emma  Paperback line    -
 *   E-5      Dune  Paperback line    -
 */

describe('scalar selections', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture('lateral');
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  describe('at the root of a query', () => {
    test('a column reads as its values', async () => {
      const names = await fx.db.libBooks.orderBy(b => b.name).select(b => b.name).toList();

      assertType<string[], typeof names>(names);
      expect(names).toEqual(['Dune', 'Emma']);
    });

    test('a navigation column is joined and reads as its values', async () => {
      fx.resetCapture();
      const books = await fx.db.libEditions.orderBy(e => e.label).select(e => e.book!.name).toList();

      expect(books).toEqual(['Emma', 'Dune', 'Dune', 'Emma', 'Dune']);
      expect(fx.lastStatement()).toContain('LEFT JOIN "lib_books" AS "book"');
    });

    test('a two-hop navigation column', async () => {
      const categories = await fx.db.libLoans.orderBy(ln => ln.note).select(ln => ln.edition!.book!.category!.name).toList();

      // first → E-1 → Emma → Classics; second → E-2 → Dune → Sci-fi; third → E-3 → Dune → Sci-fi
      expect(categories).toEqual(['Classics', 'Sci-fi', 'Sci-fi']);
    });

    test('an sql expression reads as its values', async () => {
      const loud = await fx.db.libBooks.orderBy(b => b.name).select(b => sql<string>`upper(${b.name})`).toList();

      expect(loud).toEqual(['DUNE', 'EMMA']);
    });

    test('a distinct column', async () => {
      const bookIds = await fx.db.libEditions.selectDistinct(e => e.bookId).toList();

      expect([...bookIds].sort((a, b) => a - b)).toEqual([fx.ids.dune, fx.ids.emma].sort((a, b) => a - b));
    });

    test('first / firstOrDefault / firstOrThrow read the value', async () => {
      expect(await fx.db.libBooks.where(b => eq(b.name, 'Dune')).select(b => b.id).first()).toBe(fx.ids.dune);
      expect(await fx.db.libBooks.orderBy(b => b.name).select(b => b.name).firstOrDefault()).toBe('Dune');
      expect(await fx.db.libBooks.where(b => eq(b.name, 'Emma')).select(b => b.name).firstOrThrow()).toBe('Emma');
    });

    test('firstOrDefault of nothing is null', async () => {
      expect(await fx.db.libBooks.where(b => eq(b.name, 'nope')).select(b => b.name).firstOrDefault()).toBeNull();
    });

    test('limit / offset, ordered by a column it does not select', async () => {
      const labels = await fx.db.libEditions.orderBy(e => [[e.id, 'DESC']]).select(e => e.label).limit(2).offset(1).toList();

      expect(labels).toEqual(['E-4', 'E-3']);
    });

    test('a NULL value stays NULL', async () => {
      const favorites = await fx.db.libMembers.orderBy(m => m.name).select(m => m.favoriteBookId).toList();

      expect(favorites).toEqual([fx.ids.emma, fx.ids.dune, null]);
    });

    test('countOver() pages the values', async () => {
      const { data, totalCount } = await fx.db.libEditions.orderBy(e => e.label).select(e => e.label).limit(2).countOver();

      expect(data).toEqual(['E-1', 'E-2']);
      expect(totalCount).toBe(5);
    });

    test('a union of columns reads as their values', async () => {
      const names = await fx.db.libBooks
        .select(b => b.name)
        .unionAll(fx.db.libCategories.select(c => c.name))
        .toList();

      expect([...names].sort()).toEqual(['Classics', 'Dune', 'Emma', 'Hardback line', 'Paperback line', 'Sci-fi']);
    });

    test('a batched query reads as its values too', async () => {
      const batch = new QueryBatch();
      const key = batch.addList(fx.db.libBooks.orderBy(b => b.name).select(b => b.name), 'names');
      const first = batch.addFirstOrDefault(fx.db.libEditions.orderBy(e => e.label).select(e => e.book!.name), 'first');
      await batch.executeBatch();

      expect(batch.getList(key)).toEqual(['Dune', 'Emma']);
      expect(batch.getItem(first)).toBe('Emma');
    });

    test('its SQL is unchanged: a subquery of it still names its column', async () => {
      fx.resetCapture();
      const booksWithEditions = await fx.db.libBooks
        .where(b => inSubquery(b.id, fx.db.libEditions.where(e => eq(e.categoryId, fx.ids.hardback)).select(e => e.bookId).asSubquery('array')))
        .orderBy(b => b.name)
        .select(b => b.name)
        .toList();

      expect(booksWithEditions).toEqual(['Dune', 'Emma']);
      expect(fx.lastStatement()).not.toContain('__value');
    });

    test('a collection as the whole selection is refused with the way to project it', async () => {
      await expectToReject(
        () => fx.db.libBooks.select(b => b.editions!.count() as any).toList(),
        /a collection cannot be the whole selection — project it as a field/
      );
    });
  });

  describe('of mapped and typed columns', () => {
    test('a mapped column reads through its mapper, at the root and in a collection', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const times = await db.posts.orderBy(p => p.id).select(p => p.publishTime).toList();
        const dates = await db.posts.orderBy(p => p.id).select(p => p.customDate).toList();
        const nested = await db.users
          .orderBy(u => u.id)
          .select(u => ({ id: u.id, times: u.posts!.orderBy(p => p.id).select(p => p.publishTime).toList() }))
          .toList();

        expect(times).toEqual([{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }, { hour: 18, minute: 45 }]);
        expect(dates.every(date => date instanceof Date)).toBe(true);
        expect(nested.map(u => u.times)).toEqual([
          [{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }],
          [{ hour: 18, minute: 45 }],
          [],
        ]);
      });
    });

    describe('timestamps, standalone and batched', () => {
      let ex: ExpressionFixture;

      beforeAll(async () => {
        ex = await createExpressionFixture();
      });

      afterAll(async () => {
        await disposeExpressionFixture(ex);
      });

      test('a timestamptz column reads as Dates, also through a batch', async () => {
        const query = () => ex.db.shelves.where(s => eq(s.name, 'Poetry')).select(s => s.placedTz);
        const standalone = await query().toList();

        const batch = new QueryBatch();
        const key = batch.addList(query(), 'tz');
        await batch.executeBatch();
        const batched = batch.getList(key);

        expect(standalone[0]).toBeInstanceOf(Date);
        expect(batched[0]).toBeInstanceOf(Date);
        expect((batched[0] as unknown as Date).toISOString()).toBe((standalone[0] as unknown as Date).toISOString());
      });
    });
  });

  describe('in a mutation RETURNING', () => {
    const NOTE = 'scalar-returning';

    test('insert: a collection of one value', async () => {
      const [book] = await fx.db.libBooks.insertBulk([{ name: 'Scalar book', categoryId: fx.ids.sciFi }]).returning(b => ({
        id: b.id,
        labels: b.editions!.select(e => e.label).toList(),
        first: b.editions!.select(e => e.label).firstOrDefault(),
      }));

      try {
        expect(book.labels).toEqual([]);
        expect(book.first).toBeNull();
      } finally {
        await fx.db.libBooks.where(b => eq(b.id, book.id)).delete();
      }
    });

    test('update: a collection of one value', async () => {
      const rows = await fx.db.libBooks
        .where(b => eq(b.name, 'Dune'))
        .update({ name: 'Dune' })
        .returning((b: any) => ({ labels: b.editions.orderBy((e: any) => e.label).select((e: any) => e.label).toList() }));

      expect(rows).toEqual([{ labels: ['E-2', 'E-3', 'E-5'] }]);
    });

    test('mergeBulk: a collection of one value, and one of a navigation column', async () => {
      const rows = await fx.db.libMembers.mergeBulk(
        [{ name: 'Ada', favoriteBookId: fx.ids.emma }],
        { on: 'name', updateColumns: ['favoriteBookId'] }
      ).returning(m => ({
        name: m.name,
        notes: m.loans!.orderBy(ln => ln.note).select(ln => ln.note).toList(),
        books: m.loans!.orderBy(ln => ln.note).select(ln => ln.book!.name).toList(),
      }));

      expect(rows).toEqual([{ name: 'Ada', notes: ['first', 'second'], books: ['Dune', 'Emma'] }]);
    });

    test('insertBulk reads a collection of one value through a navigation of the new row', async () => {
      const [loan] = await fx.db.libLoans.insertBulk([{ memberId: fx.ids.ada, editionId: fx.ids.e4, bookId: fx.ids.emma, note: NOTE }]).returning(ln => ({
        id: ln.id,
        memberLoanNotes: ln.member!.loans!.orderBy(other => other.note).select(other => other.note).toList(),
      }));

      try {
        // The statement's own snapshot: the member's existing loans, not the one it inserts
        expect(loan.memberLoanNotes).toEqual(['first', 'second']);
      } finally {
        await fx.db.libLoans.where(ln => eq(ln.note, NOTE)).delete();
      }
    });
  });

  // Last: each strategy fixture recreates (and on dispose drops) the library tables
  describe.each([...LIBRARY_STRATEGIES])('in a collection (%s)', (strategy) => {
    let sfx: LibraryFixture;

    beforeAll(async () => {
      sfx = await createLibraryFixture(strategy);
    });

    afterAll(async () => {
      await disposeLibraryFixture(sfx);
    });

    const perBook = <T>(select: (b: any) => T) => sfx.db.libBooks.orderBy(b => b.name).select(b => ({ v: select(b) })).toList();

    test('a column reads as its values', async () => {
      const rows = await perBook(b => b.editions.orderBy((e: any) => e.label).select((e: any) => e.label).toList());

      expect(rows.map(r => r.v)).toEqual([['E-2', 'E-3', 'E-5'], ['E-1', 'E-4']]);
    });

    test('a navigation column', async () => {
      const rows = await perBook(b => b.editions.orderBy((e: any) => e.label).select((e: any) => e.category.name).toList());

      expect(rows.map(r => r.v)).toEqual([
        ['Paperback line', 'Hardback line', 'Paperback line'],
        ['Hardback line', 'Paperback line'],
      ]);
    });

    test('an sql expression', async () => {
      const rows = await perBook(b => b.editions.orderBy((e: any) => e.label).select((e: any) => sql<string>`lower(${e.label})`).toList());

      expect(rows.map(r => r.v)).toEqual([['e-2', 'e-3', 'e-5'], ['e-1', 'e-4']]);
    });

    test('firstOrDefault reads the value, or null', async () => {
      const first = await perBook(b => b.editions.orderBy((e: any) => e.label).select((e: any) => e.label).firstOrDefault());
      const none = await perBook(b => b.editions.where((e: any) => eq(e.label, 'nope')).select((e: any) => e.label).firstOrDefault());

      expect(first.map(r => r.v)).toEqual(['E-2', 'E-1']);
      expect(none.map(r => r.v)).toEqual([null, null]);
    });

    test('a collection nested in a collection', async () => {
      const rows = await perBook(b => b.editions
        .orderBy((e: any) => e.label)
        .select((e: any) => ({ label: e.label, notes: e.loans.select((ln: any) => ln.note).toList() }))
        .toList());

      expect(rows.map(r => r.v)).toEqual([
        [{ label: 'E-2', notes: ['second'] }, { label: 'E-3', notes: ['third'] }, { label: 'E-5', notes: [] }],
        [{ label: 'E-1', notes: ['first'] }, { label: 'E-4', notes: [] }],
      ]);
    });

    test('a single value nested in a collection', async () => {
      const rows = await perBook(b => b.editions
        .orderBy((e: any) => e.label)
        .select((e: any) => ({ label: e.label, firstNote: e.loans.select((ln: any) => ln.note).firstOrDefault() }))
        .toList());

      expect(rows.map(r => r.v)).toEqual([
        [{ label: 'E-2', firstNote: 'second' }, { label: 'E-3', firstNote: 'third' }, { label: 'E-5', firstNote: null }],
        [{ label: 'E-1', firstNote: 'first' }, { label: 'E-4', firstNote: null }],
      ]);
    });

    test('toStringList of an expression is a flat list too', async () => {
      const rows = await perBook(b => b.editions.orderBy((e: any) => e.label).select((e: any) => sql<string>`lower(${e.label})`).toStringList());

      expect(rows.map(r => r.v)).toEqual([['e-2', 'e-3', 'e-5'], ['e-1', 'e-4']]);
    });

    test('an object selection is unchanged', async () => {
      const rows = await perBook(b => b.editions.orderBy((e: any) => e.label).select((e: any) => ({ label: e.label })).toList());

      expect(rows.map(r => r.v)).toEqual([[{ label: 'E-2' }, { label: 'E-3' }, { label: 'E-5' }], [{ label: 'E-1' }, { label: 'E-4' }]]);
    });
  });

});
