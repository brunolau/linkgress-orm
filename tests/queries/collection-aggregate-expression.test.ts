import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from '../../src';
import { byId, createLibraryFixture, disposeLibraryFixture, LibraryFixture, LIBRARY_STRATEGIES } from '../utils/library-fixture';

/**
 * A collection's min / max / sum aggregate an `sql` expression of the item the way they aggregate a
 * column — under every collection strategy, with the collection's WHERE, ORDER BY / LIMIT and the
 * expression's own parameters, nested in another collection, and in a mutation's RETURNING.
 *
 * It used to throw "MAX requires an aggregate field": the selector's expression reached neither the
 * aggregate field nor the aggregate expression the strategies render.
 *
 * Loans: Ada — "first" (Dune), "second" (Emma); Bo — "third" (Emma); Cy — none.
 */
describe('collection aggregates over sql expressions', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture('lateral');
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  for (const strategy of LIBRARY_STRATEGIES) {
    describe(strategy, () => {
      const members = () => fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy });

      test('min / max / sum of an expression of the item', async () => {
        const rows = await members().select(m => ({
          id: m.id,
          longest: m.loans!.max(l => sql<number>`length(${l.note})`),
          shortest: m.loans!.min(l => sql<number>`length(${l.note})`),
          total: m.loans!.sum(l => sql<number>`length(${l.note})`),
        })).toList();

        expect(byId(rows)).toEqual([
          { id: fx.ids.ada, longest: 6, shortest: 5, total: 11 },
          { id: fx.ids.bo, longest: 5, shortest: 5, total: 5 },
          { id: fx.ids.cy, longest: null, shortest: null, total: null },
        ]);
      });

      test('an expression binding parameters, next to the collection\'s own WHERE parameter', async () => {
        const rows = await members().select(m => ({
          id: m.id,
          weighted: m.loans!.where(l => eq(l.note, 'second')).sum(l => sql<number>`length(${l.note}) * ${10} + ${1}`),
        })).toList();

        expect(byId(rows).map(r => r.weighted)).toEqual([61, null, null]);
      });

      test('an expression reading the item\'s navigation', async () => {
        // first: 5 * 10 + length('Dune'), second: 6 * 10 + length('Emma')
        const rows = await members().where(m => eq(m.id, fx.ids.ada)).select(m => ({
          best: m.loans!.max(l => sql<number>`length(${l.note}) * 10 + length(${l.book!.name})`),
        })).toList();

        expect(rows).toEqual([{ best: 64 }]);
      });

      test('a list of ONE expression reading the item\'s navigation joins it too', async () => {
        const [row] = await members().where(m => eq(m.id, fx.ids.ada)).select(m => ({
          books: m.loans!.orderBy(l => l.note).select(l => sql<string>`upper(${l.book!.name})`).toList(),
        })).toList();

        expect(row.books).toEqual(['DUNE', 'EMMA']);
      });

      test('ORDER BY + LIMIT bound the aggregated items', async () => {
        const rows = await members().where(m => eq(m.id, fx.ids.ada)).select(m => ({
          firstByNote: m.loans!.orderBy(l => l.note).limit(1).sum(l => sql<number>`length(${l.note})`),
        })).toList();

        // "first" sorts before "second"
        expect(rows).toEqual([{ firstByNote: 5 }]);
      });

      test('nested in another collection\'s items', async () => {
        const [dune] = await fx.db.libBooks.withQueryOptions({ collectionStrategy: strategy })
          .where(b => eq(b.id, fx.ids.dune))
          .select(b => ({
            editions: b.editions!.orderBy(e => e.label).select(e => ({
              label: e.label,
              longestLoanNote: e.loans!.max(l => sql<number>`length(${l.note})`),
            })).toList(),
          }))
          .toList();

        // E-2 held by "second", E-3 by "third", E-5 by nobody
        expect(dune.editions).toEqual([
          { label: 'E-2', longestLoanNote: 6 },
          { label: 'E-3', longestLoanNote: 5 },
          { label: 'E-5', longestLoanNote: null },
        ]);
      });
    });
  }

  test('in a mutation\'s RETURNING', async () => {
    const rows = await fx.db.libMembers
      .where(m => eq(m.id, fx.ids.ada))
      .update({ name: 'Ada' })
      .returning(m => ({ id: m.id, longest: m.loans!.max(l => sql<number>`length(${l.note})`), total: m.loans!.sum(l => sql<number>`length(${l.note})`) }));

    expect(rows).toEqual([{ id: fx.ids.ada, longest: 6, total: 11 }]);
  });
});
