import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from '../../src';
import { expectToReject } from '../utils/expect-rejects';
import { createLibraryFixture, disposeLibraryFixture, LibraryFixture, LIBRARY_STRATEGIES } from '../utils/library-fixture';

/**
 * Every form an `orderBy` selector may return, on every builder that takes one: a single key, an
 * array of keys, [key, direction] pairs, ONE flat pair (`[row.name, 'DESC']` — its direction used to
 * be read as a second key and dropped), pairs and keys mixed, the NULLS FIRST / NULLS LAST
 * directions in any case and spacing, and keys left out by a condition (`flag && row.name`).
 *
 * And what it refuses, with a message that says why, where the key used to be dropped from the
 * ORDER BY without a word: a string (a column NAME, or a direction on its own), a number (an ORDER BY
 * position), `true`, a function, a whole navigation row, a direction that is none, a pair of the
 * wrong length.
 *
 * Members: Ada (favorite Emma), Bo (favorite Dune), Cy (no favorite); Dune's id is below Emma's.
 */

describe('orderBy forms', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture('lateral');
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  const names = (rows: ReadonlyArray<{ name: string }>): string[] => rows.map(row => row.name);
  const orderByOf = (statement: string): string => statement.replace(/\s+/g, ' ').replace(/.*ORDER BY /, '');

  describe('on a table query', () => {
    test('a single key, ascending', async () => {
      expect(names(await fx.db.libMembers.orderBy(m => m.name).toList())).toEqual(['Ada', 'Bo', 'Cy']);
    });

    test('an array of keys, each ascending', async () => {
      const rows = await fx.db.libEditions.orderBy(e => [e.bookId, e.label]).toList();

      expect(rows.map(row => row.label)).toEqual(['E-2', 'E-3', 'E-5', 'E-1', 'E-4']);
    });

    test('[key, direction] pairs', async () => {
      const rows = await fx.db.libEditions.orderBy(e => [[e.bookId, 'DESC'], [e.label, 'ASC']]).toList();

      expect(rows.map(row => row.label)).toEqual(['E-1', 'E-4', 'E-2', 'E-3', 'E-5']);
    });

    test('ONE flat [key, direction] pair keeps its direction', async () => {
      fx.resetCapture();
      const rows = await fx.db.libMembers.orderBy(m => [m.name, 'DESC'] as any).toList();

      expect(names(rows)).toEqual(['Cy', 'Bo', 'Ada']);
      expect(orderByOf(fx.lastStatement())).toBe('"name" DESC');
    });

    test('pairs and bare keys mixed in one array', async () => {
      const rows = await fx.db.libEditions.orderBy(e => [[e.bookId, 'DESC'], e.label] as any).toList();

      expect(rows.map(row => row.label)).toEqual(['E-1', 'E-4', 'E-2', 'E-3', 'E-5']);
    });

    test('a pair without a direction is ascending', async () => {
      const rows = await fx.db.libMembers.orderBy(m => [[m.name] as any]).toList();

      expect(names(rows)).toEqual(['Ada', 'Bo', 'Cy']);
    });

    test.each([
      ['ASC', ['Bo', 'Ada', 'Cy']],
      ['ASC NULLS FIRST', ['Cy', 'Bo', 'Ada']],
      ['ASC NULLS LAST', ['Bo', 'Ada', 'Cy']],
      ['DESC', ['Cy', 'Ada', 'Bo']],
      ['DESC NULLS FIRST', ['Cy', 'Ada', 'Bo']],
      ['DESC NULLS LAST', ['Ada', 'Bo', 'Cy']],
    ] as const)('%s orders the NULLs where PostgreSQL does', async (direction, expected) => {
      fx.resetCapture();
      const rows = await fx.db.libMembers.orderBy(m => [[m.favoriteBookId!, direction]]).toList();

      expect(names(rows)).toEqual([...expected]);
      expect(orderByOf(fx.lastStatement())).toBe(`"favoriteBookId" ${direction}`);
    });

    test('a direction in any case and spacing is normalized', async () => {
      fx.resetCapture();
      const rows = await fx.db.libMembers.orderBy(m => [[m.favoriteBookId!, ' desc   nulls  last ' as any]]).toList();

      expect(names(rows)).toEqual(['Ada', 'Bo', 'Cy']);
      expect(orderByOf(fx.lastStatement())).toBe('"favoriteBookId" DESC NULLS LAST');
    });

    test('a NULLS direction on a navigation column', async () => {
      const rows = await fx.db.libMembers.orderBy(m => [[m.favoriteBook!.name, 'ASC NULLS FIRST']]).toList();

      expect(names(rows)).toEqual(['Cy', 'Bo', 'Ada']);
    });

    test('keys left out by a condition (false / null / undefined) are skipped', async () => {
      const byNothing = false;
      fx.resetCapture();
      const rows = await fx.db.libMembers
        .orderBy(m => [byNothing && m.favoriteBookId, null, undefined, [m.name, 'DESC']] as any)
        .toList();

      expect(names(rows)).toEqual(['Cy', 'Bo', 'Ada']);
      expect(orderByOf(fx.lastStatement())).toBe('"name" DESC');
    });

    test('a key left out by a condition inside a pair is skipped', async () => {
      const rows = await fx.db.libMembers.orderBy(m => [[undefined, 'DESC'], [m.name, 'DESC']] as any).toList();

      expect(names(rows)).toEqual(['Cy', 'Bo', 'Ada']);
    });

    test('an sql expression key, with a direction', async () => {
      const rows = await fx.db.libEditions.orderBy(e => [[sql`right(${e.label}, 1)`, 'DESC']] as any).toList();

      expect(rows.map(row => row.label)).toEqual(['E-5', 'E-4', 'E-3', 'E-2', 'E-1']);
    });
  });

  describe('refusals', () => {
    const refuse = (selector: (m: any) => unknown): (() => unknown) => () => fx.db.libMembers.orderBy(selector as any);

    test('a column NAME (a string) is not a key', () => {
      expect(refuse(() => 'name')).toThrow(/"name" is a string, not a key/);
    });

    test('a direction on its own is not a key', () => {
      expect(refuse(() => 'DESC')).toThrow(/"DESC" is a sort direction, not a key/);
    });

    test('a string among the keys is refused, not dropped', () => {
      expect(refuse(m => [m.name, 'favorite_book_id'])).toThrow(/is a string, not a key/);
    });

    test('a number (an ORDER BY position) is not a key', () => {
      expect(refuse(() => 1)).toThrow(/ORDER BY position is not supported/);
    });

    test('true is not a key', () => {
      expect(refuse(() => true)).toThrow(/true is not a key/);
    });

    test('a function is not a key', () => {
      expect(refuse(m => () => m.name)).toThrow(/a function is not a key/);
    });

    test('a whole navigation row is not a key', () => {
      expect(refuse(m => m.favoriteBook)).toThrow(/whole navigation row/);
    });

    test('a direction that is none is refused', () => {
      expect(refuse(m => [[m.name, 'DOWN']])).toThrow(/"DOWN" is not a sort direction/);
    });

    test('a pair of three values is refused', () => {
      expect(refuse(m => [[m.name, 'ASC', 'NULLS LAST']])).toThrow(/a pair is \[key, direction\] — got an array of 3 values/);
    });

    test('an empty pair is refused', () => {
      expect(refuse(() => [[]])).toThrow(/got an array of 0 values/);
    });
  });

  describe('on a projection', () => {
    test('a flat pair and a NULLS direction over projected navigation values', async () => {
      const rows = await fx.db.libMembers
        .select(m => ({ name: m.name, favorite: m.favoriteBook!.name }))
        .orderBy(r => [r.favorite, 'DESC NULLS LAST'] as any)
        .toList();

      expect(names(rows)).toEqual(['Ada', 'Bo', 'Cy']);
    });

    test('mixed pairs and keys', async () => {
      const rows = await fx.db.libEditions
        .select(e => ({ label: e.label, book: e.book!.name }))
        .orderBy(r => [[r.book, 'DESC'], r.label] as any)
        .toList();

      expect(rows.map(row => row.label)).toEqual(['E-1', 'E-4', 'E-2', 'E-3', 'E-5']);
    });

    test('a refused key on a projection says why', () => {
      expect(() => fx.db.libMembers.select(m => ({ name: m.name })).orderBy(() => 'name' as any)).toThrow(/is a string, not a key/);
    });
  });

  describe('on a union', () => {
    test('a flat pair keeps its direction', async () => {
      const rows = await fx.db.libBooks
        .select(b => ({ name: b.name }))
        .unionAll(fx.db.libCategories.select(c => ({ name: c.name })))
        .orderBy(r => [r.name, 'DESC'] as any)
        .toList();

      expect(names(rows)).toEqual(['Sci-fi', 'Paperback line', 'Hardback line', 'Emma', 'Dune', 'Classics']);
    });

    test('a NULLS direction', async () => {
      fx.resetCapture();
      const rows = await fx.db.libMembers
        .select(m => ({ name: m.name, favorite: m.favoriteBookId }))
        .unionAll(fx.db.libMembers.where(m => eq(m.name, 'Cy')).select(m => ({ name: m.name, favorite: m.favoriteBookId })))
        .orderBy(r => [[r.favorite, 'ASC NULLS FIRST'], [r.name, 'ASC']] as any)
        .toList();

      expect(names(rows)).toEqual(['Cy', 'Cy', 'Bo', 'Ada']);
      expect(fx.lastStatement()).toContain('ASC NULLS FIRST');
    });
  });

  describe.each([...LIBRARY_STRATEGIES])('in a collection (%s)', (strategy) => {
    let sfx: LibraryFixture;

    beforeAll(async () => {
      sfx = await createLibraryFixture(strategy);
    });

    afterAll(async () => {
      await disposeLibraryFixture(sfx);
    });

    test('a flat pair keeps its direction', async () => {
      const rows = await sfx.db.libBooks
        .orderBy(b => b.name)
        .select(b => ({ name: b.name, labels: b.editions!.orderBy(e => [e.label, 'DESC'] as any).select(e => e.label).toList() }))
        .toList();

      expect(rows).toEqual([
        { name: 'Dune', labels: ['E-5', 'E-3', 'E-2'] },
        { name: 'Emma', labels: ['E-4', 'E-1'] },
      ]);
    });

    test('mixed pairs and keys, one through a navigation', async () => {
      const rows = await sfx.db.libBooks
        .orderBy(b => b.name)
        .select(b => ({
          name: b.name,
          labels: b.editions!.orderBy(e => [[e.category!.name, 'DESC'], e.label] as any).select(e => e.label).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Dune', labels: ['E-2', 'E-5', 'E-3'] },
        { name: 'Emma', labels: ['E-4', 'E-1'] },
      ]);
    });

    test('a NULLS direction renders in the collection', async () => {
      sfx.resetCapture();
      await sfx.db.libBooks
        .select(b => ({ labels: b.editions!.orderBy(e => [[e.label, 'DESC NULLS LAST']]).select(e => e.label).toList() }))
        .toList();

      expect(sfx.statements().join('\n')).toContain('DESC NULLS LAST');
    });

    test('a key left out by a condition is skipped in a collection', async () => {
      const skip = false;
      const rows = await sfx.db.libBooks
        .orderBy(b => b.name)
        .select(b => ({ labels: b.editions!.orderBy(e => [skip && e.categoryId, [e.label, 'DESC']] as any).select(e => e.label).toList() }))
        .toList();

      expect(rows.map(row => row.labels)).toEqual([['E-5', 'E-3', 'E-2'], ['E-4', 'E-1']]);
    });

    test('a refused key in a collection says why', async () => {
      await expectToReject(
        () => sfx.db.libBooks.select(b => ({ labels: b.editions!.orderBy(() => 'label' as any).toList() })).toList(),
        /is a string, not a key/
      );
    });
  });
});
