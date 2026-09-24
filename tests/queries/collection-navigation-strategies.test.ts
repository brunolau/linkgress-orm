/**
 * Navigations inside collections, under EVERY collection strategy (lateral, cte, temptable).
 *
 * Runs on the library fixture (tests/utils/library-fixture.ts), where every navigation path yields a
 * different value, so a collapsed, re-parented, mis-keyed or unjoined navigation can never produce
 * an expected value by accident. What each section pins:
 *
 * - navigations read by a collection's projection, WHERE, `sql` fragments, single-column lists and
 *   aggregates — the temp-table strategy used to render none of them (`t."book"."name"`);
 * - collections nested in collections, lists and scalars alike — a nested count / min / exists
 *   used to come back as `{}` (or as a string exploded into an object) under the CTE strategy, and
 *   the temp-table strategy refused nesting;
 * - collections hanging off a navigation path at the ROOT — the CTE and temp-table strategies
 *   correlated them to the root row's id, and a LATERAL count never joined the path;
 * - relations keyed on a non-id principal key (`withPrincipalKey(c => c.code)`) — the CTE and
 *   temp-table strategies joined their aggregate back on `id`;
 * - a collection whose own navigation reuses a relation name of the path it hangs off
 *   (`ln.edition.book.editions` + `ed.book`) — a duplicate alias, or an inner join shadowing the
 *   correlation;
 * - collections reading their PARENT row (its columns and navigations) — rendered as LATERAL under
 *   every strategy, with the parent's navigations joined where the parent lives.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, exists, gt, sql } from '../../src';
import { byId, createLibraryFixture, disposeLibraryFixture, LIBRARY_STRATEGIES, LibraryFixture } from '../utils/library-fixture';

let fx: LibraryFixture;

beforeAll(async () => {
  fx = await createLibraryFixture();
});

afterAll(async () => {
  await disposeLibraryFixture(fx);
});

/** The rows of Ada, Bo and Cy, in that order. */
const perMember = <T extends { id: number }>(rows: readonly T[]): [T, T, T] => [
  rows.find(row => row.id === fx.ids.ada)!,
  rows.find(row => row.id === fx.ids.bo)!,
  rows.find(row => row.id === fx.ids.cy)!,
];

const sorted = <T>(values: readonly T[]): T[] => [...values].sort();

for (const strategy of LIBRARY_STRATEGIES) {
  const members = () => fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy });
  const loans = () => fx.db.libLoans.withQueryOptions({ collectionStrategy: strategy });
  const books = () => fx.db.libBooks.withQueryOptions({ collectionStrategy: strategy });
  const categories = () => fx.db.libCategories.withQueryOptions({ collectionStrategy: strategy });

  describe(`navigations inside a collection — ${strategy}`, () => {
    test('a one-hop navigation in the projection', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.select(ln => ({ id: ln.id, book: ln.book!.name })).toList() }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, book: 'Dune' }, { id: fx.ids.l2, book: 'Emma' }]);
      expect(bo.loans).toEqual([{ id: fx.ids.l3, book: 'Emma' }]);
      expect(cy.loans).toEqual([]);
    });

    test('a three-hop navigation whose leaf name the item itself also has', async () => {
      const [ada, bo] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.select(ln => ({ id: ln.id, category: ln.edition!.book!.category!.name })).toList() }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, category: 'Classics' }, { id: fx.ids.l2, category: 'Sci-fi' }]);
      expect(bo.loans).toEqual([{ id: fx.ids.l3, category: 'Sci-fi' }]);
    });

    test('five paths at once, two pairs of them ending in one relation name', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            direct: ln.book!.name,
            directCategory: ln.book!.category!.name,
            printed: ln.edition!.book!.name,
            printedCategory: ln.edition!.book!.category!.name,
            editionCategory: ln.edition!.category!.name,
          })).toList(),
        }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([
        { id: fx.ids.l1, direct: 'Dune', directCategory: 'Sci-fi', printed: 'Emma', printedCategory: 'Classics', editionCategory: 'Hardback line' },
        { id: fx.ids.l2, direct: 'Emma', directCategory: 'Classics', printed: 'Dune', printedCategory: 'Sci-fi', editionCategory: 'Paperback line' },
      ]);
    });

    test('a navigation keyed on a non-id principal key', async () => {
      const [ada, bo] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            directByCode: ln.book!.categoryByCode!.name,
            printedByCode: ln.edition!.book!.categoryByCode!.name,
          })).toList(),
        }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([
        { id: fx.ids.l1, directByCode: 'Classics', printedByCode: 'Sci-fi' },
        { id: fx.ids.l2, directByCode: 'Sci-fi', printedByCode: 'Classics' },
      ]);
      expect(bo.loans).toEqual([{ id: fx.ids.l3, directByCode: 'Sci-fi', printedByCode: 'Classics' }]);
    });

    test('a WHERE through a navigation', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.where(ln => eq(ln.book!.name, 'Emma')).select(ln => ({ id: ln.id })).toList() }))
        .toList());

      expect(ada.loans).toEqual([{ id: fx.ids.l2 }]);
      expect(bo.loans).toEqual([{ id: fx.ids.l3 }]);
      expect(cy.loans).toEqual([]);
    });

    test('a WHERE on one book path while the projection reads the other', async () => {
      const [ada, bo] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!
            .where(ln => eq(ln.edition!.book!.name, 'Dune'))
            .select(ln => ({ id: ln.id, direct: ln.book!.name }))
            .toList(),
        }))
        .toList());

      expect(ada.loans).toEqual([{ id: fx.ids.l2, direct: 'Emma' }]);
      expect(bo.loans).toEqual([{ id: fx.ids.l3, direct: 'Emma' }]);
    });

    test('navigations inside a projected sql fragment', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({ id: ln.id, pair: sql<string>`${ln.book!.name} || '/' || ${ln.edition!.book!.name}` })).toList(),
        }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, pair: 'Dune/Emma' }, { id: fx.ids.l2, pair: 'Emma/Dune' }]);
    });

    test('toStringList / toNumberList of a navigation column', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({
          id: m.id,
          printed: m.loans!.select(ln => ln.edition!.book!.name).toStringList(),
          printedIds: m.loans!.select(ln => ln.edition!.book!.id).toNumberList(),
        }))
        .toList());

      expect(sorted(ada.printed as string[])).toEqual(['Dune', 'Emma']);
      expect(sorted(ada.printedIds as number[])).toEqual(sorted([fx.ids.dune, fx.ids.emma]));
      expect(bo.printed).toEqual(['Dune']);
      expect(cy.printed).toEqual([]);
      expect(cy.printedIds).toEqual([]);
    });

    test('firstOrDefault of a navigation projection', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, first: m.loans!.orderBy(ln => ln.id).select(ln => ({ printed: ln.edition!.book!.name })).firstOrDefault() }))
        .toList());

      expect(ada.first).toEqual({ printed: 'Emma' });
      expect(bo.first).toEqual({ printed: 'Dune' });
      expect(cy.first).toBeNull();
    });

    test('min / max / sum over navigation columns', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({
          id: m.id,
          maxPrinted: m.loans!.max(ln => ln.edition!.book!.name),
          minDirect: m.loans!.min(ln => ln.book!.name),
          printedIdSum: m.loans!.sum(ln => ln.edition!.book!.id),
        }))
        .toList());

      expect([ada.maxPrinted, ada.minDirect, ada.printedIdSum]).toEqual(['Emma', 'Dune', fx.ids.dune + fx.ids.emma] as any);
      expect([bo.maxPrinted, bo.minDirect, bo.printedIdSum]).toEqual(['Dune', 'Emma', fx.ids.dune] as any);
      expect([cy.maxPrinted, cy.minDirect, cy.printedIdSum]).toEqual([null, null, null]);
    });

    test('count and exists over a navigation WHERE', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({
          id: m.id,
          printsDune: m.loans!.where(ln => eq(ln.edition!.book!.name, 'Dune')).count(),
          ownsDune: m.loans!.where(ln => eq(ln.book!.name, 'Dune')).exists(),
        }))
        .toList());

      expect([ada.printsDune, ada.ownsDune]).toEqual([1, true]);
      expect([bo.printsDune, bo.ownsDune]).toEqual([1, false]);
      expect([cy.printsDune, cy.ownsDune]).toEqual([0, false]);
    });

    test('a nested list whose items read a navigation of their own', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            printedEditions: ln.edition!.book!.editions!.orderBy(ed => ed.label).select(ed => ({ label: ed.label, category: ed.category!.name })).toList(),
          })).toList(),
        }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([
        { id: fx.ids.l1, printedEditions: [{ label: 'E-1', category: 'Hardback line' }, { label: 'E-4', category: 'Paperback line' }] },
        {
          id: fx.ids.l2,
          printedEditions: [
            { label: 'E-2', category: 'Paperback line' },
            { label: 'E-3', category: 'Hardback line' },
            { label: 'E-5', category: 'Paperback line' },
          ],
        },
      ]);
    });

    test('nested scalars come back as plain values (count, min, max, exists)', async () => {
      const rows = await categories()
        .select(c => ({
          id: c.id,
          books: c.books!.select(b => ({
            name: b.name,
            editions: b.editions!.count(),
            first: b.editions!.min(ed => ed.label),
            last: b.editions!.max(ed => ed.label),
            hardback: b.editions!.where(ed => eq(ed.category!.name, 'Hardback line')).exists(),
          })).toList(),
        }))
        .toList();

      expect(rows.find(row => row.id === fx.ids.sciFi)!.books as any[]).toEqual([{ name: 'Dune', editions: 3, first: 'E-2', last: 'E-5', hardback: true }]);
      expect(rows.find(row => row.id === fx.ids.classics)!.books as any[]).toEqual([{ name: 'Emma', editions: 2, first: 'E-1', last: 'E-4', hardback: true }]);
      expect(rows.find(row => row.id === fx.ids.hardback)!.books).toEqual([]);
    });

    test('nested counts over both book paths of every loan', async () => {
      const [ada, bo] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            ownEditions: ln.book!.editions!.count(),
            printedEditions: ln.edition!.book!.editions!.count(),
          })).toList(),
        }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([
        { id: fx.ids.l1, ownEditions: 3, printedEditions: 2 },
        { id: fx.ids.l2, ownEditions: 2, printedEditions: 3 },
      ]);
      expect(bo.loans).toEqual([{ id: fx.ids.l3, ownEditions: 2, printedEditions: 3 }]);
    });

    test('a nested ordered toStringList', async () => {
      const rows = await books()
        .select(b => ({ id: b.id, labels: b.editions!.orderBy(ed => [[ed.label, 'DESC']]).select(ed => ed.label).toStringList() }))
        .toList();

      expect(byId(rows).map(row => row.labels)).toEqual([['E-5', 'E-3', 'E-2'], ['E-4', 'E-1']]);
    });

    test('three levels of collections', async () => {
      const rows = await categories()
        .select(c => ({
          id: c.id,
          books: c.books!.select(b => ({
            name: b.name,
            editions: b.editions!.orderBy(ed => ed.label).select(ed => ({
              label: ed.label,
              notes: ed.loans!.select(ln => ln.note).toStringList(),
            })).toList(),
          })).toList(),
        }))
        .toList();

      expect(rows.find(row => row.id === fx.ids.classics)!.books).toEqual([
        { name: 'Emma', editions: [{ label: 'E-1', notes: ['first'] }, { label: 'E-4', notes: [] }] },
      ]);
      expect(rows.find(row => row.id === fx.ids.sciFi)!.books).toEqual([
        { name: 'Dune', editions: [{ label: 'E-2', notes: ['second'] }, { label: 'E-3', notes: ['third'] }, { label: 'E-5', notes: [] }] },
      ]);
    });

    test('two collections of one parent, each with its own parameters, beside a parameterised root WHERE', async () => {
      const [ada, bo] = perMember(await members()
        .where(m => gt(m.id, 0))
        .select(m => ({
          id: m.id,
          dune: m.loans!.where(ln => eq(ln.book!.name, 'Dune')).select(ln => ({ id: ln.id })).toList(),
          emma: m.loans!.where(ln => and(eq(ln.book!.name, 'Emma'), gt(ln.id, 0))).select(ln => ({ id: ln.id })).toList(),
        }))
        .toList());

      expect([ada.dune, ada.emma]).toEqual([[{ id: fx.ids.l1 }], [{ id: fx.ids.l2 }]]);
      expect([bo.dune, bo.emma]).toEqual([[], [{ id: fx.ids.l3 }]]);
    });

    test('an exists() over a collection of the item, in the collection\'s WHERE', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          // Editions of the book the loan's edition prints that some loan noted 'first' holds
          held: ln.edition!.book!.editions!.where(ed => exists(ed.loans!.where(held => eq(held.note, 'first')))).select(ed => ed.label).toStringList(),
        }))
        .toList());

      // Under LATERAL the exists() used to name the editions table by its own name, which the
      // lateral renders only under its alias ("invalid reference to FROM-clause entry")
      expect(rows.map(row => row.held)).toEqual([['E-1'], [], []]);
    });

    test('a parameter inside a projected fragment of a collection', async () => {
      const [ada] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.select(ln => ({ id: ln.id, shout: sql<string>`${ln.note} || ${'!'}` })).toList() }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, shout: 'first!' }, { id: fx.ids.l2, shout: 'second!' }]);
    });
  });

  describe(`collections hanging off a navigation path at the root — ${strategy}`, () => {
    test('a list', async () => {
      const rows = byId(await loans()
        .select(ln => ({ id: ln.id, printedEditions: ln.edition!.book!.editions!.orderBy(ed => ed.label).select(ed => ed.label).toStringList() }))
        .toList());

      expect(rows.map(row => row.printedEditions)).toEqual([['E-1', 'E-4'], ['E-2', 'E-3', 'E-5'], ['E-2', 'E-3', 'E-5']]);
    });

    test('count, exists, min and max', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          count: ln.edition!.book!.editions!.count(),
          hasHardback: ln.edition!.book!.editions!.where(ed => eq(ed.category!.name, 'Hardback line')).exists(),
          first: ln.edition!.book!.editions!.min(ed => ed.label),
          last: ln.edition!.book!.editions!.max(ed => ed.label),
        }))
        .toList());

      expect(rows.map(row => [row.count, row.hasHardback, row.first, row.last] as any[])).toEqual([
        [2, true, 'E-1', 'E-4'],
        [3, true, 'E-2', 'E-5'],
        [3, true, 'E-2', 'E-5'],
      ]);
    });

    test('both book paths of every loan side by side', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          direct: ln.book!.name,
          ownEditions: ln.book!.editions!.count(),
          printedEditions: ln.edition!.book!.editions!.select(ed => ({ label: ed.label })).toList(),
        }))
        .toList());

      expect(rows.map(row => [row.direct, row.ownEditions, sorted((row.printedEditions as any[]).map(ed => ed.label))])).toEqual([
        ['Dune', 3, ['E-1', 'E-4']],
        ['Emma', 2, ['E-2', 'E-3', 'E-5']],
        ['Emma', 2, ['E-2', 'E-3', 'E-5']],
      ]);
    });

    test('firstOrDefault ordered by a navigation of the item', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          first: ln.edition!.book!.editions!.orderBy(ed => [[ed.category!.name, 'DESC'], [ed.label, 'ASC']]).select(ed => ({ label: ed.label })).firstOrDefault(),
        }))
        .toList());

      expect(rows.map(row => (row.first as any)?.label)).toEqual(['E-4', 'E-2', 'E-2']);
    });

    test('a path whose navigation is missing on some rows (a member without a favorite book)', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({
          id: m.id,
          count: m.favoriteBook!.editions!.count(),
          labels: m.favoriteBook!.editions!.orderBy(ed => ed.label).select(ed => ed.label).toStringList(),
        }))
        .toList());

      expect([ada.count, ada.labels]).toEqual([2, ['E-1', 'E-4']] as any);
      expect([bo.count, bo.labels]).toEqual([3, ['E-2', 'E-3', 'E-5']] as any);
      expect([cy.count, cy.labels]).toEqual([0, []] as any);
    });

    test('a relation keyed on a non-id principal key, at the root and down a path', async () => {
      const categoryRows = await categories()
        .select(c => ({
          id: c.id,
          byId: c.books!.select(b => b.name).toStringList(),
          byCode: c.booksByCode!.select(b => ({ name: b.name })).toList(),
          byCodeCount: c.booksByCode!.count(),
        }))
        .toList();

      const sciFi = categoryRows.find(row => row.id === fx.ids.sciFi)!;
      const classics = categoryRows.find(row => row.id === fx.ids.classics)!;
      const hardback = categoryRows.find(row => row.id === fx.ids.hardback)!;

      expect([sciFi.byId, sciFi.byCode, sciFi.byCodeCount]).toEqual([['Dune'], [{ name: 'Emma' }], 1] as any);
      expect([classics.byId, classics.byCode, classics.byCodeCount]).toEqual([['Emma'], [{ name: 'Dune' }], 1] as any);
      expect([hardback.byId, hardback.byCode, hardback.byCodeCount]).toEqual([[], [], 0] as any);

      const loanRows = byId(await loans()
        .select(ln => ({ id: ln.id, sameCode: ln.book!.categoryByCode!.booksByCode!.select(b => b.name).toStringList() }))
        .toList());

      // L1 owns Dune (coded CL: Classics, whose coded books are [Dune]); L2 / L3 own Emma (SF → [Emma])
      expect(loanRows.map(row => row.sameCode)).toEqual([['Dune'], ['Emma'], ['Emma']]);
    });

    test('selectMany through a relation keyed on a non-id principal key', async () => {
      // The flattened collection correlated `category_code = category.id` — an error for a text code,
      // silently the wrong category for an integer one
      const rows = await categories()
        .select(c => ({
          id: c.id,
          byId: c.books!.selectMany(b => b.editions!).orderBy(ed => ed.label).select(ed => ed.label).toStringList(),
          byCode: c.booksByCode!.selectMany(b => b.editions!).orderBy(ed => ed.label).select(ed => ({ label: ed.label })).toList(),
          byCodeCount: c.booksByCode!.selectMany(b => b.editions!).count(),
          byCodeAny: c.booksByCode!.selectMany(b => b.editions!).exists(),
        }))
        .toList();

      const sciFi = rows.find(row => row.id === fx.ids.sciFi)!;
      const classics = rows.find(row => row.id === fx.ids.classics)!;
      const hardback = rows.find(row => row.id === fx.ids.hardback)!;

      // Sci-fi holds Dune by id and Emma by code; Classics the other way round
      expect(sciFi.byId).toEqual(['E-2', 'E-3', 'E-5']);
      expect([sciFi.byCode, sciFi.byCodeCount, sciFi.byCodeAny]).toEqual([[{ label: 'E-1' }, { label: 'E-4' }], 2, true] as any);
      expect(classics.byId).toEqual(['E-1', 'E-4']);
      expect([classics.byCode, classics.byCodeCount, classics.byCodeAny]).toEqual([[{ label: 'E-2' }, { label: 'E-3' }, { label: 'E-5' }], 3, true] as any);
      expect([hardback.byId, hardback.byCode, hardback.byCodeCount, hardback.byCodeAny]).toEqual([[], [], 0, false] as any);
    });

    test('exists() over a selectMany through a non-id principal key, in a WHERE', async () => {
      const rows = await categories()
        .where(c => exists(c.booksByCode!.selectMany(b => b.editions!).where(ed => eq(ed.label, 'E-5'))))
        .select(c => ({ id: c.id }))
        .toList();

      // E-5 is Dune's, and Dune is coded CL
      expect(rows).toEqual([{ id: fx.ids.classics }]);
    });

    test('the CTE join of a collection off a path pairs it with the path, on the principal key', async () => {
      fx.resetCapture();
      await loans()
        .select(ln => ({ id: ln.id, codes: ln.book!.categoryByCode!.booksByCode!.select(b => b.name).toStringList() }))
        .toList();

      const statement = fx.statements().join('\n');

      if (strategy === 'cte') {
        expect(statement).toMatch(/LEFT JOIN "cte_\d+" ON "cte_\d+"\.parent_id = "categoryByCode"\."code"/);
      } else if (strategy === 'temptable') {
        expect(statement).toContain('"categoryByCode"."code" as "__pk_');
        // The parent-id column takes the principal key's type (a statement of its own on pg, part of
        // one multi-statement script on postgres.js / Bun)
        expect(statement).toMatch(/CREATE TEMP TABLE (IF NOT EXISTS )?tmp_parent_ids_\d+ \(\s*id varchar/);
      } else {
        expect(statement).toContain('"lateral_0_booksByCode"."category_code" = "categoryByCode"."code"');
      }
    });
  });

  describe(`a collection reusing a relation name of the path it hangs off — ${strategy}`, () => {
    test('the item\'s own navigation reads the item\'s row', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          editions: ln.edition!.book!.editions!.orderBy(ed => ed.label).select(ed => ({ label: ed.label, book: ed.book!.name, category: ed.category!.name })).toList(),
        }))
        .toList());

      expect(rows[0].editions).toEqual([
        { label: 'E-1', book: 'Emma', category: 'Hardback line' },
        { label: 'E-4', book: 'Emma', category: 'Paperback line' },
      ]);
      expect(rows[1].editions).toEqual([
        { label: 'E-2', book: 'Dune', category: 'Paperback line' },
        { label: 'E-3', book: 'Dune', category: 'Hardback line' },
        { label: 'E-5', book: 'Dune', category: 'Paperback line' },
      ]);
    });

    test('a WHERE and a count through the reused name keep the correlation', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          duneEditions: ln.edition!.book!.editions!.where(ed => eq(ed.book!.name, 'Dune')).select(ed => ed.label).toStringList(),
          duneCount: ln.edition!.book!.editions!.where(ed => eq(ed.book!.name, 'Dune')).count(),
        }))
        .toList());

      // L1's edition prints Emma: none of Emma's editions is Dune's. A join named like the path's
      // `book` would have bound the correlation to the edition's own book and counted everything.
      expect(rows.map(row => [sorted(row.duneEditions as string[]), row.duneCount])).toEqual([
        [[], 0],
        [['E-2', 'E-3', 'E-5'], 3],
        [['E-2', 'E-3', 'E-5'], 3],
      ]);
    });

    test('an ORDER BY through the reused name', async () => {
      const rows = byId(await loans()
        .select(ln => ({
          id: ln.id,
          labels: ln.edition!.book!.editions!.orderBy(ed => [[ed.book!.name, 'ASC'], [ed.label, 'DESC']]).select(ed => ed.label).toStringList(),
        }))
        .toList());

      expect(rows.map(row => row.labels)).toEqual([['E-4', 'E-1'], ['E-5', 'E-3', 'E-2'], ['E-5', 'E-3', 'E-2']]);
    });

    test('the reused name renders under a path alias', async () => {
      fx.resetCapture();
      await loans()
        .select(ln => ({ id: ln.id, editions: ln.edition!.book!.editions!.select(ed => ({ book: ed.book!.name })).toList() }))
        .toList();

      expect(fx.statements().join('\n')).toContain('"lib_editions__book"');
    });
  });

  describe(`a collection reading its parent row — ${strategy}`, () => {
    test('a WHERE on a column of the parent', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, favorites: m.loans!.where(ln => eq(ln.bookId, m.favoriteBookId!)).select(ln => ({ id: ln.id })).toList() }))
        .toList());

      expect(ada.favorites).toEqual([{ id: fx.ids.l2 }]);
      expect(bo.favorites).toEqual([]);
      expect(cy.favorites).toEqual([]);
    });

    test('a WHERE through a navigation of the parent', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, favorites: m.loans!.where(ln => eq(ln.edition!.book!.name, m.favoriteBook!.name)).select(ln => ({ id: ln.id })).toList() }))
        .toList());

      expect(ada.favorites).toEqual([{ id: fx.ids.l1 }]);
      expect(bo.favorites).toEqual([{ id: fx.ids.l3 }]);
      expect(cy.favorites).toEqual([]);
    });

    test('a WHERE through a two-hop navigation of the parent', async () => {
      const [ada, bo] = perMember(await members()
        .select(m => ({
          id: m.id,
          sameCategory: m.loans!.where(ln => eq(ln.edition!.book!.category!.name, m.favoriteBook!.category!.name)).select(ln => ({ id: ln.id })).toList(),
        }))
        .toList());

      expect(ada.sameCategory).toEqual([{ id: fx.ids.l1 }]);
      expect(bo.sameCategory).toEqual([{ id: fx.ids.l3 }]);
    });

    test('a navigation of the item named like the parent\'s navigation it is compared with', async () => {
      const editions = () => fx.db.libEditions.withQueryOptions({ collectionStrategy: strategy });
      const rows = byId(await editions()
        .select(ed => ({
          id: ed.id,
          // The loan's OWN book against the edition's book: never the same book in this library
          ownBookMatches: ed.loans!.where(ln => eq(ln.book!.name, ed.book!.name)).count(),
          // The book the loan's edition prints — the edition itself — always matches
          printedBookMatches: ed.loans!.where(ln => eq(ln.edition!.book!.name, ed.book!.name)).count(),
        }))
        .toList());

      // One alias "book" for both rows would compare the inner book with itself: 1, 1, 1, 0, 0
      expect(rows.map(row => row.ownBookMatches)).toEqual([0, 0, 0, 0, 0]);
      expect(rows.map(row => row.printedBookMatches)).toEqual([1, 1, 1, 0, 0]);
    });

    test('a two-hop navigation of the item keeps its own join apart from the parent\'s same-named one', async () => {
      fx.resetCapture();
      await members()
        .select(m => ({
          id: m.id,
          sameCategory: m.loans!.where(ln => eq(ln.edition!.book!.category!.name, m.favoriteBook!.category!.name)).select(ln => ({ id: ln.id })).toList(),
        }))
        .toList();

      const statement = fx.lastStatement();
      expect(statement).toContain('"book__category"."name" = "category"."name"');
      expect(statement).toContain('LEFT JOIN "lib_categories" AS "category" ON "favoriteBook"."category_id" = "category"."id"');
    });

    test('a projection of a navigation of the parent', async () => {
      const [ada, , cy] = perMember(await members()
        .select(m => ({ id: m.id, loans: m.loans!.select(ln => ({ id: ln.id, favorite: m.favoriteBook!.name })).toList() }))
        .toList());

      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, favorite: 'Emma' }, { id: fx.ids.l2, favorite: 'Emma' }]);
      expect(cy.loans).toEqual([]);
    });

    test('a count reading the parent', async () => {
      const [ada, bo, cy] = perMember(await members()
        .select(m => ({ id: m.id, favorites: m.loans!.where(ln => eq(ln.bookId, m.favoriteBookId!)).count() }))
        .toList());

      expect([ada.favorites, bo.favorites, cy.favorites]).toEqual([1, 0, 0]);
    });

    test('a nested collection reading a navigation of the loan it is nested in', async () => {
      const [ada] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            sameCategory: ln.edition!.book!.editions!.where(ed => eq(ed.categoryId, ln.edition!.categoryId)).count(),
          })).toList(),
        }))
        .toList());

      // L1: E-1 is Hardback — of Emma's editions only E-1 is; L2: E-2 is Paperback — Dune has E-2 and E-5
      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, sameCategory: 1 }, { id: fx.ids.l2, sameCategory: 2 }]);
    });

    test('a nested collection reading the ROOT row two levels up', async () => {
      const [ada, bo] = perMember(await members()
        .select(m => ({
          id: m.id,
          loans: m.loans!.select(ln => ({
            id: ln.id,
            favoriteEditions: ln.edition!.book!.editions!.where(ed => eq(ed.book!.name, m.favoriteBook!.name)).count(),
          })).toList(),
        }))
        .toList());

      // Ada's favorite is Emma: L1's edition prints Emma (2 editions), L2's prints Dune (0 are Emma's)
      expect(byId(ada.loans as any[])).toEqual([{ id: fx.ids.l1, favoriteEditions: 2 }, { id: fx.ids.l2, favoriteEditions: 0 }]);
      // Bo's favorite is Dune: L3's edition prints Dune (3 editions)
      expect(bo.loans).toEqual([{ id: fx.ids.l3, favoriteEditions: 3 }]);
    });

    test('the correlated collection renders as LATERAL, with the parent navigation joined beside it', async () => {
      fx.resetCapture();
      await members()
        .select(m => ({ id: m.id, favorites: m.loans!.where(ln => eq(ln.edition!.book!.name, m.favoriteBook!.name)).select(ln => ({ id: ln.id })).toList() }))
        .toList();

      const statement = fx.lastStatement();
      expect(statement).toContain('LEFT JOIN LATERAL');
      expect(statement).toContain('LEFT JOIN "lib_books" AS "favoriteBook" ON "lib_members"."favorite_book_id" = "favoriteBook"."id"');
    });
  });
}

describe('collections in UPDATE / DELETE … RETURNING', () => {
  test('a count off a path that lost its plain alias reads that path', async () => {
    // Rewrites L1's note to what it is: the rows stay as seeded
    const [row] = await fx.db.libLoans
      .where(ln => eq(ln.id, fx.ids.l1))
      .update({ note: 'first' })
      .returning((ln: any) => ({ id: ln.id, direct: ln.book!.name, printedEditions: ln.edition!.book!.editions!.count(), ownEditions: ln.book!.editions!.count() }));

    // L1 owns Dune (3 editions); its edition prints Emma (2) — bound by name, the count read Dune's
    expect(row).toEqual({ id: fx.ids.l1, direct: 'Dune', printedEditions: 2, ownEditions: 3 });
  });

  test('an exists() nested in a returned collection keeps its own table', async () => {
    const [row] = await fx.db.libLoans
      .where(ln => eq(ln.id, fx.ids.l1))
      .update({ note: 'first' })
      .returning((ln: any) => ({
        id: ln.id,
        held: ln.edition!.book!.editions!.where((ed: any) => exists(ed.loans!.where((held: any) => eq(held.note, 'first')))).select((ed: any) => ed.label).toStringList(),
      }));

    // Of Emma's editions (E-1, E-4) only E-1 is held; the table-name rewrite made the exists() true for both
    expect(row).toEqual({ id: fx.ids.l1, held: ['E-1'] });
  });

  test('DELETE … RETURNING reads both book paths and a collection off the renamed one', async () => {
    const inserted = await fx.db.libLoans.insert({ memberId: fx.ids.cy, editionId: fx.ids.e1, bookId: fx.ids.dune, note: 'to delete' }).returning(ln => ({ id: ln.id }));

    const rows = await fx.db.libLoans
      .where(ln => eq(ln.id, (inserted as any).id))
      .delete()
      .returning((ln: any) => ({ direct: ln.book!.name, printed: ln.edition!.book!.name, printedEditions: ln.edition!.book!.editions!.select((ed: any) => ed.label).toStringList() }));

    expect(rows).toEqual([{ direct: 'Dune', printed: 'Emma', printedEditions: ['E-1', 'E-4'] }]);
    expect(await fx.db.libLoans.where(ln => eq(ln.note, 'to delete')).count()).toBe(0);
  });
});

describe('the temp-table aggregation statement', () => {
  test('joins the collection\'s navigations and restricts it to the parents in the temp table', async () => {
    fx.resetCapture();
    await fx.db.libMembers.withQueryOptions({ collectionStrategy: 'temptable' })
      .select(m => ({ id: m.id, loans: m.loans!.where(ln => eq(ln.book!.name, 'Emma')).select(ln => ({ id: ln.id, printed: ln.edition!.book!.name })).toList() }))
      .toList();

    // A separate statement (pg), or part of one multi-statement script with the parameters written in
    // as literals (postgres.js, Bun)
    const aggregation = fx.statements().find(statement => statement.includes('IN (SELECT id FROM tmp_parent_ids_0)')) ?? '';
    expect(aggregation).toContain('LEFT JOIN "lib_books" "book" ON "lib_loans"."book_id" = "book"."id"');
    expect(aggregation).toContain('LEFT JOIN "lib_editions" "edition" ON "lib_loans"."edition_id" = "edition"."id"');
    expect(aggregation).toContain('"lib_loans"."member_id" IN (SELECT id FROM tmp_parent_ids_0)');
    expect(aggregation).toMatch(/"book"\."name" = (\$1|'Emma')/);
  });

  test('takes each parent once when several rows share it through a navigation', async () => {
    fx.resetCapture();
    const rows = byId(await fx.db.libLoans.withQueryOptions({ collectionStrategy: 'temptable' })
      .select(ln => ({ id: ln.id, printedEditions: ln.edition!.book!.editions!.count() }))
      .toList());

    // L2 and L3 print the same book: the temp table's primary key takes Dune once
    expect(rows.map(row => row.printedEditions)).toEqual([2, 3, 3]);

    const insert = fx.statements().find(statement => statement.includes('INSERT INTO tmp_parent_ids_')) ?? '';
    const values = /INSERT INTO tmp_parent_ids_\d+ VALUES ([^;\n]*)/.exec(insert)?.[1] ?? '';
    expect(values.split('),(')).toHaveLength(2);
  });
});
