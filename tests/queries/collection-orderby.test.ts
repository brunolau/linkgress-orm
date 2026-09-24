/**
 * ORDER BY inside collections, under EVERY collection strategy (lateral, cte, temptable).
 *
 * On the library fixture (tests/utils/library-fixture.ts):
 *
 *   book  edition  category         id order
 *   Dune  E-2      Paperback line   e2
 *   Dune  E-3      Hardback line    e3
 *   Dune  E-5      Paperback line   e5
 *   Emma  E-1      Hardback line    e1
 *   Emma  E-4      Paperback line   e4
 *
 * Collection ORDER BY keys used to render as bare column NAMES:
 * - LATERAL bound a name its inner table lacks to the ENCLOSING row (ordering a member's loans by
 *   `ln.edition.book.name` ordered by the member's own `name` — i.e. not at all), and a name the
 *   projection reuses as an alias to that alias (ordering by `label` while projecting
 *   `label: ed.category.name` ordered by the category);
 * - the CTE and temp-table aggregates ordered by names their subquery output does not carry
 *   (`column "name" does not exist`), and the temp-table strategy joined no navigation at all;
 * - a DISTINCT list could not order by what it lists, a LIMITed scalar ignored its ORDER BY and
 *   LIMIT, and the correlated toStringList form dropped every key read through a navigation.
 *
 * Every key now renders as its qualified expression — or, where an aggregate reads an inner
 * SELECT's output, as the projected field selecting that expression or a hidden column carrying it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, gt, sql } from '../../src';
import { createLibraryFixture, disposeLibraryFixture, LIBRARY_STRATEGIES, LibraryFixture } from '../utils/library-fixture';
import { expectToReject } from '../utils/expect-rejects';

let fx: LibraryFixture;

beforeAll(async () => {
  fx = await createLibraryFixture();
});

afterAll(async () => {
  await disposeLibraryFixture(fx);
});

for (const strategy of LIBRARY_STRATEGIES) {
  const books = () => fx.db.libBooks.withQueryOptions({ collectionStrategy: strategy });
  const members = () => fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy });

  /** Dune's and Emma's value of a per-book collection field. */
  const perBook = <T extends { id: number }>(rows: readonly T[]): [T, T] => [
    rows.find(row => row.id === fx.ids.dune)!,
    rows.find(row => row.id === fx.ids.emma)!,
  ];

  const perMember = <T extends { id: number }>(rows: readonly T[]): [T, T, T] => [
    rows.find(row => row.id === fx.ids.ada)!,
    rows.find(row => row.id === fx.ids.bo)!,
    rows.find(row => row.id === fx.ids.cy)!,
  ];

  describe(`collection ORDER BY by the item's own columns — ${strategy}`, () => {
    test('a projected column', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [[ed.label, 'DESC']]).select(ed => ({ label: ed.label })).toList() }))
        .toList());

      expect(dune.editions).toEqual([{ label: 'E-5' }, { label: 'E-3' }, { label: 'E-2' }]);
      expect(emma.editions).toEqual([{ label: 'E-4' }, { label: 'E-1' }]);
    });

    test('a column the projection does not select', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [[ed.label, 'DESC']]).select(ed => ({ id: ed.id })).toList() }))
        .toList());

      expect(dune.editions).toEqual([{ id: fx.ids.e5 }, { id: fx.ids.e3 }, { id: fx.ids.e2 }]);
      expect(emma.editions).toEqual([{ id: fx.ids.e4 }, { id: fx.ids.e1 }]);
    });

    test('a column the projection selects under another name', async () => {
      const [dune] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [[ed.label, 'DESC']]).select(ed => ({ tag: ed.label })).toList() }))
        .toList());

      expect(dune.editions).toEqual([{ tag: 'E-5' }, { tag: 'E-3' }, { tag: 'E-2' }]);
    });

    test('a column whose name the projection gives to another value', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => ed.label).select(ed => ({ id: ed.id, label: ed.category!.name })).toList() }))
        .toList());

      // By the edition's label, not by the category name projected as `label`
      expect((dune.editions as any[]).map(ed => ed.id)).toEqual([fx.ids.e2, fx.ids.e3, fx.ids.e5]);
      expect((emma.editions as any[]).map(ed => ed.id)).toEqual([fx.ids.e1, fx.ids.e4]);
    });

    test('several keys, directions mixed', async () => {
      const [dune] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [[ed.categoryId, 'DESC'], [ed.label, 'ASC']]).select(ed => ed.label).toStringList() }))
        .toList());

      // Paperback line was seeded after Hardback line, so it has the higher id
      expect(dune.editions).toEqual(['E-2', 'E-5', 'E-3']);
    });
  });

  describe(`collection ORDER BY through navigations — ${strategy}`, () => {
    test('a one-hop navigation the projection does not read', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [[ed.category!.name, 'ASC'], [ed.label, 'DESC']]).select(ed => ({ label: ed.label })).toList() }))
        .toList());

      expect(dune.editions).toEqual([{ label: 'E-3' }, { label: 'E-5' }, { label: 'E-2' }]);
      expect(emma.editions).toEqual([{ label: 'E-1' }, { label: 'E-4' }]);
    });

    test('a one-hop navigation the projection reads too', async () => {
      const [dune] = perBook(await books()
        .select(b => ({
          id: b.id,
          editions: b.editions!.orderBy(ed => [[ed.category!.name, 'DESC'], [ed.label, 'ASC']]).select(ed => ({ label: ed.label, category: ed.category!.name })).toList(),
        }))
        .toList());

      expect(dune.editions).toEqual([
        { label: 'E-2', category: 'Paperback line' },
        { label: 'E-5', category: 'Paperback line' },
        { label: 'E-3', category: 'Hardback line' },
      ]);
    });

    test('a two-hop navigation (used to order by the enclosing member\'s own name under LATERAL)', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          byPrinted: m.loans!.orderBy(ln => ln.edition!.book!.name).select(ln => ({ id: ln.id })).toList(),
          byOwn: m.loans!.orderBy(ln => ln.book!.name).select(ln => ({ id: ln.id })).toList(),
        }))
        .toList());

      expect(ada.byPrinted).toEqual([{ id: fx.ids.l2 }, { id: fx.ids.l1 }]);
      expect(ada.byOwn).toEqual([{ id: fx.ids.l1 }, { id: fx.ids.l2 }]);
    });

    test('both book paths as keys', async () => {
      const [ada] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[ln.book!.name, 'DESC'], [ln.edition!.book!.name, 'ASC']]).select(ln => ln.id).toNumberList() }))
        .toList());

      expect(ada.loans).toEqual([fx.ids.l2, fx.ids.l1]);
    });

    test('a three-hop navigation, both directions', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          ascending: m.loans!.orderBy(ln => [[ln.edition!.book!.category!.name, 'ASC']]).select(ln => ln.id).toNumberList(),
          descending: m.loans!.orderBy(ln => [[ln.edition!.book!.category!.name, 'DESC']]).select(ln => ln.id).toNumberList(),
        }))
        .toList());

      expect(ada.ascending).toEqual([fx.ids.l1, fx.ids.l2]);
      expect(ada.descending).toEqual([fx.ids.l2, fx.ids.l1]);
    });

    test('a navigation keyed on a non-id principal key', async () => {
      const [ada] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[ln.book!.categoryByCode!.name, 'ASC']]).select(ln => ln.id).toNumberList() }))
        .toList());

      // L1 owns Dune (coded Classics), L2 owns Emma (coded Sci-fi)
      expect(ada.loans).toEqual([fx.ids.l1, fx.ids.l2]);
    });
  });

  describe(`collection ORDER BY with the list shapes — ${strategy}`, () => {
    test('with limit', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [ed.category!.name, ed.label]).select(ed => ({ label: ed.label })).limit(2).toList() }))
        .toList());

      expect(dune.editions).toEqual([{ label: 'E-3' }, { label: 'E-2' }]);
      expect(emma.editions).toEqual([{ label: 'E-1' }, { label: 'E-4' }]);
    });

    test('with offset, and with offset + limit', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({
          id: b.id,
          rest: b.editions!.orderBy(ed => [ed.category!.name, ed.label]).select(ed => ({ label: ed.label })).offset(1).toList(),
          second: b.editions!.orderBy(ed => [ed.category!.name, ed.label]).select(ed => ({ label: ed.label })).offset(1).limit(1).toList(),
        }))
        .toList());

      expect([dune.rest, dune.second]).toEqual([[{ label: 'E-2' }, { label: 'E-5' }], [{ label: 'E-2' }]]);
      expect([emma.rest, emma.second]).toEqual([[{ label: 'E-4' }], [{ label: 'E-4' }]]);
    });

    test('firstOrDefault by a navigation, and by a column it does not select', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({
          id: b.id,
          lastPaperback: b.editions!.orderBy(ed => [[ed.category!.name, 'DESC'], [ed.label, 'DESC']]).select(ed => ({ label: ed.label })).firstOrDefault(),
          firstById: b.editions!.orderBy(ed => ed.id).select(ed => ({ label: ed.label })).firstOrDefault(),
        }))
        .toList());

      expect([dune.lastPaperback, dune.firstById]).toEqual([{ label: 'E-5' }, { label: 'E-2' }]);
      expect([emma.lastPaperback, emma.firstById]).toEqual([{ label: 'E-4' }, { label: 'E-1' }]);
    });

    test('toStringList by a navigation, with and without limit', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({
          id: b.id,
          all: b.editions!.orderBy(ed => [ed.category!.name, ed.label]).select(ed => ed.label).toStringList(),
          firstTwo: b.editions!.orderBy(ed => [ed.category!.name, ed.label]).select(ed => ed.label).limit(2).toStringList(),
        }))
        .toList());

      expect([dune.all, dune.firstTwo]).toEqual([['E-3', 'E-2', 'E-5'], ['E-3', 'E-2']]);
      expect([emma.all, emma.firstTwo]).toEqual([['E-1', 'E-4'], ['E-1', 'E-4']]);
    });

    test('toNumberList by a column it does not list', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, ids: b.editions!.orderBy(ed => [[ed.label, 'DESC']]).select(ed => ed.id).toNumberList() }))
        .toList());

      expect(dune.ids).toEqual([fx.ids.e5, fx.ids.e3, fx.ids.e2]);
      expect(emma.ids).toEqual([fx.ids.e4, fx.ids.e1]);
    });

    test('a nested list ordered through a navigation of its own item', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.orderBy(ln => ln.id).select(ln => ({
            id: ln.id,
            printedEditions: ln.edition!.book!.editions!.orderBy(ed => [[ed.category!.name, 'DESC'], [ed.label, 'ASC']]).select(ed => ed.label).toStringList(),
          })).toList(),
        }))
        .toList());

      expect(ada.loans).toEqual([
        { id: fx.ids.l1, printedEditions: ['E-4', 'E-1'] },
        { id: fx.ids.l2, printedEditions: ['E-2', 'E-5', 'E-3'] },
      ]);
    });
  });

  describe(`DISTINCT collections and ORDER BY — ${strategy}`, () => {
    test('a distinct list ordered by the value it lists', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, categories: b.editions!.orderBy(ed => [[ed.category!.name, 'DESC']]).selectDistinct(ed => ed.category!.name).toStringList() }))
        .toList());

      expect(dune.categories).toEqual(['Paperback line', 'Hardback line']);
      expect(emma.categories).toEqual(['Paperback line', 'Hardback line']);
    });

    test('distinct objects ordered by a value they select', async () => {
      const [dune] = perBook(await books()
        .select(b => ({ id: b.id, categories: b.editions!.orderBy(ed => ed.category!.name).selectDistinct(ed => ({ category: ed.category!.name })).toList() }))
        .toList());

      expect(dune.categories).toEqual([{ category: 'Hardback line' }, { category: 'Paperback line' }]);
    });

    test('a distinct list ordered by a value it does not list is refused', async () => {
      const error = await expectToReject(books()
        .select(b => ({ id: b.id, categories: b.editions!.orderBy(ed => ed.label).selectDistinct(ed => ed.category!.name).toStringList() }))
        .toList());

      expect(error.message).toMatch(/distinct|DISTINCT/);
    });
  });

  describe(`scalars over an ordered, limited collection — ${strategy}`, () => {
    test('count / sum / max take exactly the rows the ORDER BY + LIMIT / OFFSET yield', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({
          id: m.id,
          firstCount: m.loans!.orderBy(ln => ln.edition!.book!.name).limit(1).count(),
          restCount: m.loans!.orderBy(ln => ln.id).offset(1).count(),
          firstIdSum: m.loans!.orderBy(ln => [[ln.edition!.book!.name, 'ASC']]).limit(1).sum(ln => ln.id),
          lastNote: m.loans!.orderBy(ln => ln.id).offset(1).max(ln => ln.note),
        }))
        .toList());

      // Ada's loans by the book their edition prints: L2 (Dune), L1 (Emma)
      expect([ada.firstCount, ada.restCount, ada.firstIdSum, ada.lastNote]).toEqual([1, 1, fx.ids.l2, 'second'] as any);
      expect([bo.firstCount, bo.restCount, bo.firstIdSum, bo.lastNote]).toEqual([1, 0, fx.ids.l3, null] as any);
      expect([cy.firstCount, cy.restCount, cy.firstIdSum, cy.lastNote]).toEqual([0, 0, null, null] as any);
    });

    test('exists past an offset', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, hasSecond: m.loans!.offset(1).exists(), hasFirstEmma: m.loans!.where(ln => eq(ln.book!.name, 'Emma')).limit(1).exists() }))
        .toList());

      expect([ada.hasSecond, ada.hasFirstEmma]).toEqual([true, true]);
      expect([bo.hasSecond, bo.hasFirstEmma]).toEqual([false, true]);
      expect([cy.hasSecond, cy.hasFirstEmma]).toEqual([false, false]);
    });
  });

  // An ORDER BY key that is an expression used to be dropped from the ORDER BY without a word.
  // Notes reversed: first → "tsrif", second → "dnoces", third → "driht".
  describe(`collection ORDER BY by an SQL expression — ${strategy}`, () => {
    test('a sql fragment over the item\'s column', async () => {
      const [ada] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'ASC']]).select(ln => ({ note: ln.note })).toList() }))
        .toList());

      expect(ada.loans).toEqual([{ note: 'second' }, { note: 'first' }]);
    });

    test('a sql fragment over a navigation of the item, joined for it', async () => {
      const [ada] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[sql<string>`lower(${ln.edition!.book!.name})`, 'DESC']]).select(ln => ({ note: ln.note })).toList() }))
        .toList());

      // L1's edition prints Emma, L2's Dune
      expect(ada.loans).toEqual([{ note: 'first' }, { note: 'second' }]);
    });

    test('a parameter inside the fragment, next to a WHERE parameter of the collection and one of the root', async () => {
      const [ada, bo] = perMember(await members()
        .where(m => gt(m.id, 0))
        .select(m => ({
          id: m.id,
          loans: m.loans!.where(ln => gt(ln.id, 0)).orderBy(ln => [[sql<number>`position(${'c'} in ${ln.note})`, 'DESC']]).select(ln => ({ note: ln.note })).toList(),
        }))
        .toList());

      expect(ada.loans).toEqual([{ note: 'second' }, { note: 'first' }]);
      expect(bo.loans).toEqual([{ note: 'third' }]);
    });

    test('a condition as a key', async () => {
      const [ada] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[eq(ln.note, 'second'), 'DESC'], [ln.id, 'ASC']]).select(ln => ({ note: ln.note })).toList() }))
        .toList());

      expect(ada.loans).toEqual([{ note: 'second' }, { note: 'first' }]);
    });

    test('a limited list, a limited count and a flat list', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({
          id: m.id,
          firstReversed: m.loans!.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'ASC']]).limit(1).select(ln => ({ note: ln.note })).toList(),
          firstCount: m.loans!.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'ASC']]).limit(1).count(),
          notes: m.loans!.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'DESC']]).select(ln => ln.note).toStringList(),
        }))
        .toList());

      expect([ada.firstReversed, ada.firstCount, ada.notes]).toEqual([[{ note: 'second' }], 1, ['first', 'second']] as any);
      expect([bo.firstReversed, bo.firstCount, bo.notes]).toEqual([[{ note: 'third' }], 1, ['third']] as any);
      expect([cy.firstReversed, cy.firstCount, cy.notes]).toEqual([[], 0, []] as any);
    });

    test('a nested collection\'s count as a key', async () => {
      const [dune, emma] = perBook(await books()
        .select(b => ({ id: b.id, editions: b.editions!.orderBy(ed => [[ed.loans!.count(), 'DESC'], [ed.label, 'DESC']]).select(ed => ({ label: ed.label })).toList() }))
        .toList());

      // Held editions first (E-2, E-3 / E-1), then the rest; ties by label, descending
      expect(dune.editions).toEqual([{ label: 'E-3' }, { label: 'E-2' }, { label: 'E-5' }]);
      expect(emma.editions).toEqual([{ label: 'E-1' }, { label: 'E-4' }]);
    });

    test('a distinct collection ordered by an expression it does not select is refused', async () => {
      const error = await expectToReject(members()
        .select(m => ({ id: m.id, notes: m.loans!.orderBy(ln => [[sql<string>`reverse(${ln.note})`, 'ASC']]).selectDistinct(ln => ({ note: ln.note })).toList() }))
        .toList());

      expect(error.message).toMatch(/distinct|DISTINCT/);
    });
  });
}

describe('the ORDER BY each strategy renders', () => {
  test('lateral: qualified expressions inside the subquery', async () => {
    fx.resetCapture();
    await fx.db.libMembers.withQueryOptions({ collectionStrategy: 'lateral' })
      .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.note, 'DESC']]).select(ln => ({ id: ln.id })).toList() }))
      .toList();

    const statement = fx.lastStatement();
    expect(statement).toContain('ORDER BY "book"."name" ASC, "lateral_0_loans"."note" DESC');
    expect(statement).toContain('LEFT JOIN "lib_books" "book" ON "edition"."book_id" = "book"."id"');
  });

  test('cte: json_agg orders by hidden columns carrying keys the projection does not select', async () => {
    fx.resetCapture();
    await fx.db.libMembers.withQueryOptions({ collectionStrategy: 'cte' })
      .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[ln.edition!.book!.name, 'ASC'], [ln.id, 'DESC']]).select(ln => ({ id: ln.id })).toList() }))
      .toList();

    const statement = fx.lastStatement();
    expect(statement).toContain('"book"."name" as "__order_0"');
    expect(statement).toContain('ORDER BY "__order_0" ASC, "id" DESC');
  });

  test('temptable: the same aggregation, restricted to the temp table\'s parents', async () => {
    fx.resetCapture();
    await fx.db.libMembers.withQueryOptions({ collectionStrategy: 'temptable' })
      .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[ln.edition!.book!.name, 'ASC']]).select(ln => ({ id: ln.id })).toList() }))
      .toList();

    // A separate statement (pg), or part of one multi-statement script (postgres.js, Bun)
    const aggregation = fx.statements().find(statement => statement.includes('IN (SELECT id FROM tmp_parent_ids_0)')) ?? '';
    expect(aggregation).toContain('"book"."name" as "__order_0"');
    expect(aggregation).toContain('ORDER BY "__order_0" ASC');
    expect(aggregation).toContain('IN (SELECT id FROM tmp_parent_ids_0)');
  });

  test('an expression key: lateral orders by it over its inner alias, cte by a hidden column carrying it', async () => {
    const query = (collectionStrategy: 'lateral' | 'cte') => fx.db.libMembers.withQueryOptions({ collectionStrategy })
      .select(m => ({ id: m.id, loans: m.loans!.orderBy(ln => [[sql<number>`position(${'c'} in ${ln.note})`, 'DESC']]).select(ln => ({ id: ln.id })).toList() }))
      .toList();

    fx.resetCapture();
    await query('lateral');
    expect(fx.lastStatement()).toContain('ORDER BY (position($1 in "lateral_0_loans"."note")) DESC');

    fx.resetCapture();
    await query('cte');
    expect(fx.lastStatement()).toContain('(position($1 in "lib_loans"."note")) as "__order_0"');
    expect(fx.lastStatement()).toContain('ORDER BY "__order_0" DESC');
  });
});
