import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, between, eq, FieldRef, gt, gte, inArray, isNotNull, lt, lte, ne, not, or, sql } from '../../src';
import { createLibraryFixture, disposeLibraryFixture, LibraryFixture } from '../utils/library-fixture';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture } from '../utils/expression-fixture';
import { seedTestData, withDatabase } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * Grouped queries: their ORDER BY, HAVING, the values MIN / MAX read back as, aggregates over
 * expressions, and what a grouped projection may hold.
 *
 *   edition  book  category          id order
 *   E-1      Emma  Hardback line     1st
 *   E-2      Dune  Paperback line    2nd
 *   E-3      Dune  Hardback line     3rd
 *   E-4      Emma  Paperback line    4th
 *   E-5      Dune  Paperback line    5th
 *
 * so grouped by book, Dune has 3 editions (E-2 … E-5) and Emma 2 (E-1, E-4); grouped by category,
 * Hardback line has 2 and Paperback line 3.
 *
 * Every HAVING shape here used to fail but `gt(g.count(), n)`: an aggregate inside and / or / not /
 * between, on a comparison's right-hand side or in an `sql` fragment rendered as the column
 * "count" / "max"; `g.sum(r => r.x)` over a renamed projection rendered `SUM(*)`; a grouping key
 * rendered "[object Object]"; `between` lost its upper bound. An aggregate over an `sql` expression
 * was left out of the SELECT; ORDER BY an aggregate named its function; MIN / MAX of a text or
 * timestamp came back NaN / epoch milliseconds, and skipped a mapped column's mapper.
 */

describe('grouped queries', () => {
  let fx: LibraryFixture;

  beforeAll(async () => {
    fx = await createLibraryFixture('lateral');
  });

  afterAll(async () => {
    await disposeLibraryFixture(fx);
  });

  /** Editions grouped by book (the projection renames every column it groups or aggregates). */
  const byBook = () => fx.db.libEditions
    .select(ed => ({ book: ed.bookId, lbl: ed.label, num: ed.id, bookName: ed.book!.name }))
    .groupBy(r => ({ book: r.book }));

  /** Editions grouped by an expression: the grouped subquery form. */
  const byInitial = () => fx.db.libEditions
    .select(ed => ({ initial: sql<string>`substr(${ed.label}, 1, 1)`, lbl: ed.label, num: ed.id, cat: ed.categoryId }))
    .groupBy(r => ({ initial: r.initial, cat: r.cat }));

  const statement = (): string => fx.lastStatement().replace(/\s+/g, ' ');

  describe('ORDER BY', () => {
    test('an aggregate orders by its output alias, both directions', async () => {
      fx.resetCapture();
      const desc = await byBook().select(g => ({ book: g.key.book, n: g.count() })).orderBy(r => [[r.n, 'DESC']]).toList();

      expect(desc.map(r => r.book)).toEqual([fx.ids.dune, fx.ids.emma]);
      expect(statement()).toContain('ORDER BY "n" DESC');

      const asc = await byBook().select(g => ({ book: g.key.book, n: g.count() })).orderBy(r => r.n).toList();

      expect(asc.map(r => r.book)).toEqual([fx.ids.emma, fx.ids.dune]);
    });

    test.each([
      ['max', ['E-5', 'E-4']],
      ['min', ['E-2', 'E-1']],
    ] as const)('an aggregate of text (%s) orders by its value', async (fn, expected) => {
      const rows = await byBook()
        .select(g => ({ book: g.key.book, v: fn === 'max' ? g.max(r => r.lbl) : g.min(r => r.lbl) }))
        .orderBy(r => [[r.v, 'DESC']])
        .toList();

      expect(rows.map(r => r.v)).toEqual([...expected]);
    });

    test('sum and avg order by their output alias', async () => {
      const bySum = await byBook().select(g => ({ book: g.key.book, total: g.sum(r => r.num) })).orderBy(r => [[r.total, 'ASC']]).toList();
      const byAvg = await byBook().select(g => ({ book: g.key.book, mean: g.avg(r => r.num) })).orderBy(r => [[r.mean, 'DESC']]).toList();

      const duneIds = [fx.ids.e2, fx.ids.e3, fx.ids.e5];
      const emmaIds = [fx.ids.e1, fx.ids.e4];
      const sum = (ids: number[]) => ids.reduce((a, b) => a + b, 0);
      const expectedBySum = sum(duneIds) < sum(emmaIds) ? [fx.ids.dune, fx.ids.emma] : [fx.ids.emma, fx.ids.dune];
      const expectedByAvg = sum(duneIds) / 3 > sum(emmaIds) / 2 ? [fx.ids.dune, fx.ids.emma] : [fx.ids.emma, fx.ids.dune];

      expect(bySum.map(r => r.book)).toEqual(expectedBySum);
      expect(byAvg.map(r => r.book)).toEqual(expectedByAvg);
    });

    test('a grouping key orders by its OUTPUT alias, also when renamed', async () => {
      fx.resetCapture();
      const rows = await byBook().select(g => ({ theBook: g.key.book, n: g.count() })).orderBy(r => [[r.theBook, 'DESC']]).toList();

      expect(rows.map(r => r.theBook)).toEqual([fx.ids.emma, fx.ids.dune]);
      expect(statement()).toContain('ORDER BY "theBook" DESC');
    });

    test('a grouping key read through a navigation orders by its alias', async () => {
      const rows = await fx.db.libEditions
        .select(ed => ({ bookName: ed.book!.name, cat: ed.category!.name }))
        .groupBy(r => ({ bookName: r.bookName }))
        .select(g => ({ name: g.key.bookName, n: g.count() }))
        .orderBy(r => [[r.name, 'DESC']])
        .toList();

      expect(rows).toEqual([{ name: 'Emma', n: 2 }, { name: 'Dune', n: 3 }]);
    });

    test('an sql expression of the projection orders by its alias', async () => {
      fx.resetCapture();
      const rows = await byBook()
        .select(g => ({ book: g.key.book, shout: sql<string>`lower(${g.max(r => r.lbl)})` }))
        .orderBy(r => [[r.shout, 'DESC']])
        .toList();

      expect(rows.map(r => r.shout)).toEqual(['e-5', 'e-4']);
      expect(statement()).toContain('ORDER BY "shout" DESC');
    });

    test('ONE flat pair keeps its direction', async () => {
      const rows = await byBook().select(g => ({ book: g.key.book, n: g.count() })).orderBy(r => [r.n, 'DESC'] as any).toList();

      expect(rows.map(r => r.book)).toEqual([fx.ids.dune, fx.ids.emma]);
    });

    test('a NULLS direction on a key with a NULL group', async () => {
      const rows = await fx.db.libMembers
        .select(m => ({ fav: m.favoriteBookId, name: m.name }))
        .groupBy(r => ({ fav: r.fav }))
        .select(g => ({ fav: g.key.fav, n: g.count() }))
        .orderBy(r => [[r.fav, 'ASC NULLS FIRST']])
        .toList();

      expect(rows.map(r => r.fav)).toEqual([null, fx.ids.dune, fx.ids.emma]);
    });

    test('over the grouped subquery (an expression key): by an aggregate, then by a key', async () => {
      fx.resetCapture();
      const rows = await byInitial()
        .select(g => ({ initial: g.key.initial, cat: g.key.cat, n: g.count(), last: g.max(r => r.lbl) }))
        .orderBy(r => [[r.n, 'DESC'], [r.cat, 'ASC']])
        .toList();

      expect(rows).toEqual([
        { initial: 'E', cat: fx.ids.paperback, n: 3, last: 'E-5' },
        { initial: 'E', cat: fx.ids.hardback, n: 2, last: 'E-3' },
      ]);
      expect(statement()).toContain('ORDER BY "n" DESC, "cat" ASC');
    });

    test('a string key is refused', () => {
      expect(() => byBook().select(g => ({ book: g.key.book, n: g.count() })).orderBy(() => 'n' as any)).toThrow(/is a string, not a key/);
    });

    test('an expression written inside orderBy is refused', () => {
      expect(() => byBook().select(g => ({ book: g.key.book, n: g.count() })).orderBy(r => sql`${r.n} * 2` as any))
        .toThrow(/project it in select\(\) and order by that field/);
    });
  });

  describe('HAVING', () => {
    const run = (having: Parameters<ReturnType<typeof byBook>['having']>[0]) =>
      byBook().having(having).select(g => ({ book: g.key.book, n: g.count() })).orderBy(r => r.book).toList();
    const books = (rows: ReadonlyArray<{ book: number }>) => rows.map(r => r.book);

    test('an aggregate compared to a value — no cast needed', async () => {
      expect(books(await run(g => gt(g.count(), 2)))).toEqual([fx.ids.dune]);
    });

    test('SUM over a renamed projection field', async () => {
      const duneSum = fx.ids.e2 + fx.ids.e3 + fx.ids.e5;
      const emmaSum = fx.ids.e1 + fx.ids.e4;
      const threshold = Math.min(duneSum, emmaSum);

      fx.resetCapture();
      const rows = await run(g => gt(g.sum(r => r.num), threshold));

      expect(books(rows)).toEqual([duneSum > emmaSum ? fx.ids.dune : fx.ids.emma]);
      expect(statement()).toContain('HAVING SUM("lib_editions"."id") > $1');
    });

    test('MIN / MAX of text compared to a string', async () => {
      expect(books(await run(g => lt(g.max(r => r.lbl), 'E-5')))).toEqual([fx.ids.emma]);
      expect(books(await run(g => eq(g.min(r => r.lbl), 'E-2')))).toEqual([fx.ids.dune]);
    });

    test('AVG', async () => {
      const duneAvg = (fx.ids.e2 + fx.ids.e3 + fx.ids.e5) / 3;
      const emmaAvg = (fx.ids.e1 + fx.ids.e4) / 2;

      expect(books(await run(g => gt(g.avg(r => r.num), Math.min(duneAvg, emmaAvg))))).toEqual([duneAvg > emmaAvg ? fx.ids.dune : fx.ids.emma]);
    });

    test('and / or / not over aggregates', async () => {
      expect(books(await run(g => and(gt(g.count(), 1), lt(g.max(r => r.lbl), 'E-5'))))).toEqual([fx.ids.emma]);
      expect(books(await run(g => or(gt(g.count(), 2), eq(g.min(r => r.lbl), 'E-1'))))).toEqual([fx.ids.dune, fx.ids.emma]);
      expect(books(await run(g => not(gt(g.count(), 2))))).toEqual([fx.ids.emma]);
    });

    test('between keeps both bounds', async () => {
      fx.resetCapture();
      const rows = await run(g => between(g.count(), 3, 5));

      expect(books(rows)).toEqual([fx.ids.dune]);
      expect(statement()).toContain('HAVING COUNT(*) BETWEEN $1 AND $2');
    });

    test('gte / lte / ne / inArray over an aggregate', async () => {
      expect(books(await run(g => and(gte(g.count(), 2), lte(g.count(), 3), ne(g.count(), 3))))).toEqual([fx.ids.emma]);
      expect(books(await run(g => inArray(g.count(), [3, 4])))).toEqual([fx.ids.dune]);
    });

    test('a condition on a grouping key', async () => {
      fx.resetCapture();
      const rows = await run(g => eq(g.key.book, fx.ids.dune));

      expect(books(rows)).toEqual([fx.ids.dune]);
      expect(statement()).toContain('HAVING "lib_editions"."book_id" = $1');
    });

    test('an aggregate compared to another aggregate', async () => {
      fx.resetCapture();
      const rows = await run(g => gt(g.max(r => r.num), g.min(r => r.num)));

      expect(books(rows)).toEqual([fx.ids.dune, fx.ids.emma]);
      expect(statement()).toContain('HAVING MAX("lib_editions"."id") > MIN("lib_editions"."id")');
    });

    test('an aggregate inside an sql fragment', async () => {
      expect(books(await run(g => sql`${g.count()} > ${2}` as any))).toEqual([fx.ids.dune]);
    });

    test('an aggregate of a navigation column', async () => {
      expect(books(await run(g => eq(g.max(r => r.bookName), 'Emma')))).toEqual([fx.ids.emma]);
    });

    test('isNotNull over an aggregate', async () => {
      expect(books(await run(g => isNotNull(g.max(r => r.lbl))))).toEqual([fx.ids.dune, fx.ids.emma]);
    });

    test('chained having() calls are combined with AND', async () => {
      const rows = await byBook()
        .having(g => gt(g.count(), 1))
        .having(g => lt(g.max(r => r.lbl), 'E-5'))
        .select(g => ({ book: g.key.book }))
        .toList();

      expect(books(rows)).toEqual([fx.ids.emma]);
    });

    test('having() before and after select() are combined with AND', async () => {
      const rows = await byBook()
        .having(g => gt(g.count(), 1))
        .select(g => ({ book: g.key.book, n: g.count() }))
        .having(g => gt(g.max(r => r.lbl), 'E-4'))
        .toList();

      expect(books(rows)).toEqual([fx.ids.dune]);
    });

    test('having() after select() over an aggregate the projection does not select', async () => {
      const rows = await byBook()
        .select(g => ({ book: g.key.book }))
        .having(g => lt(g.sum(r => r.num), 0))
        .toList();

      expect(rows).toEqual([]);
    });

    describe('over the grouped subquery (an expression key)', () => {
      test('an aggregate over a column', async () => {
        fx.resetCapture();
        const rows = await byInitial()
          .having(g => gt(g.count(), 2))
          .select(g => ({ cat: g.key.cat, n: g.count() }))
          .toList();

        expect(rows).toEqual([{ cat: fx.ids.paperback, n: 3 }]);
        expect(statement()).toContain('HAVING COUNT(*) > $');
      });

      test('SUM / MAX over subquery columns', async () => {
        fx.resetCapture();
        const rows = await byInitial()
          .having(g => and(gt(g.sum(r => r.num), 0), lt(g.max(r => r.lbl), 'E-4')))
          .select(g => ({ cat: g.key.cat }))
          .toList();

        expect(rows).toEqual([{ cat: fx.ids.hardback }]);
        expect(statement()).toMatch(/HAVING \(SUM\("q1"\."__arg\d+"\) > \$\d+ AND MAX\("q1"\."__arg\d+"\) < \$\d+\)/);
      });

      test('a condition on the expression key reads the subquery column', async () => {
        fx.resetCapture();
        const rows = await byInitial()
          .having(g => eq(g.key.initial, 'E'))
          .select(g => ({ initial: g.key.initial, cat: g.key.cat }))
          .orderBy(r => r.cat)
          .toList();

        expect(rows.map(r => r.cat)).toEqual([fx.ids.hardback, fx.ids.paperback].sort((a, b) => a - b));
        expect(statement()).toContain('HAVING "q1"."initial" = $');
      });
    });

    test('the HAVING group types its keys and aggregates as the columns they are there', () => {
      byBook().having(g => {
        const count: FieldRef<string, number> = g.count();
        const last: FieldRef<string, string> = g.max(r => r.lbl);
        const total: FieldRef<string, number> = g.sum(r => r.num);
        const book: FieldRef<string, number> = g.key.book;

        return and(gt(count, 0), gt(last, ''), gt(total, 0), gt(book, 0));
      });
    });
  });

  describe('aggregates over expressions', () => {
    test('of a projected sql expression', async () => {
      const rows = await fx.db.libEditions
        .select(ed => ({ book: ed.bookId, len: sql<number>`length(${ed.label})` }))
        .groupBy(r => ({ book: r.book }))
        .select(g => ({ book: g.key.book, longest: g.max(r => r.len), total: g.sum(r => r.len) }))
        .orderBy(r => r.book)
        .toList();

      expect(rows).toEqual([
        { book: fx.ids.dune, longest: 3, total: 9 },
        { book: fx.ids.emma, longest: 3, total: 6 },
      ]);
    });

    test('of an sql expression written in the aggregate', async () => {
      const rows = await byBook()
        .select(g => ({ book: g.key.book, loudest: g.max(r => sql<string>`upper(${r.lbl})`), doubled: g.sum(r => sql<number>`${r.num} * 2`) }))
        .orderBy(r => r.book)
        .toList();

      expect(rows).toEqual([
        { book: fx.ids.dune, loudest: 'E-5', doubled: 2 * (fx.ids.e2 + fx.ids.e3 + fx.ids.e5) },
        { book: fx.ids.emma, loudest: 'E-4', doubled: 2 * (fx.ids.e1 + fx.ids.e4) },
      ]);
    });

    test('over the grouped subquery: each argument projected once, under a column of its own', async () => {
      fx.resetCapture();
      const rows = await byInitial()
        .select(g => ({ cat: g.key.cat, longest: g.max(r => sql<number>`length(${r.lbl})`), last: g.max(r => r.lbl), first: g.min(r => r.lbl) }))
        .orderBy(r => r.cat)
        .toList();

      expect(rows.map(r => [r.longest, r.last, r.first])).toEqual(
        fx.ids.hardback < fx.ids.paperback ? [[3, 'E-3', 'E-1'], [3, 'E-5', 'E-2']] : [[3, 'E-5', 'E-2'], [3, 'E-3', 'E-1']]
      );
      // the label column feeds both MIN and MAX from one subquery column
      expect(statement().match(/"lib_editions"\."label" as "__arg\d+"/g)).toHaveLength(1);
    });

    test('an aggregate whose selector returns nothing is refused with the reason', async () => {
      await expectToReject(
        () => byBook().select(g => ({ book: g.key.book, x: g.sum(r => (r as any).nope) })).toList(),
        /g\.sum\(\): the selector returned undefined/
      );
    });
  });

  describe('MIN / MAX read back as their column reads', () => {
    let ex: ExpressionFixture;

    beforeAll(async () => {
      ex = await createExpressionFixture();
    });

    afterAll(async () => {
      await disposeExpressionFixture(ex);
    });

    test('text, timestamps, numeric, bigint, double precision', async () => {
      const rows = await ex.db.shelves
        .select(s => ({ lib: s.libraryId, at: s.placedAt, tz: s.placedTz, price: s.price, counter: s.counter, ratio: s.ratio, name: s.name }))
        .groupBy(r => ({ lib: r.lib }))
        .select(g => ({
          lib: g.key.lib,
          firstAt: g.min(r => r.at),
          lastTz: g.max(r => r.tz),
          maxPrice: g.max(r => r.price),
          maxCounter: g.max(r => r.counter),
          minRatio: g.min(r => r.ratio),
          lastName: g.max(r => r.name),
        }))
        .orderBy(r => r.lib)
        .toList();

      const [vienna, lisbon] = rows;

      expect(vienna.lastName).toBe('Poetry');
      expect(lisbon.lastName).toBe('History');
      expect(vienna.firstAt).toBeInstanceOf(Date);
      expect(vienna.lastTz).toBeInstanceOf(Date);
      expect((vienna.lastTz as unknown as Date).toISOString()).toBe('2024-03-10T23:30:00.000Z');
      expect(vienna.maxPrice).toBe(19.99);
      expect(lisbon.maxPrice).toBe(5);
      // A numeric column's extreme stays a JS number, as it always was (and as COUNT / SUM / AVG are)
      expect(typeof vienna.maxCounter).toBe('number');
      expect(lisbon.maxCounter as unknown).toBe(42);
      expect(vienna.minRatio).toBe(0.25);
    });

    test('of an sql expression: a number-like value as a number, text as text', async () => {
      const rows = await ex.db.shelves
        .select(s => ({ lib: s.libraryId, name: s.name }))
        .groupBy(r => ({ lib: r.lib }))
        .select(g => ({ lib: g.key.lib, longest: g.max(r => sql<number>`length(${r.name})`), loudest: g.max(r => sql<string>`upper(${r.name})`) }))
        .orderBy(r => r.lib)
        .toList();

      expect(rows.map(r => [r.longest, r.loudest])).toEqual([[7, 'POETRY'], [7, 'HISTORY']]);
    });

    test('of a mapped column: through the column mapper', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const rows = await db.posts
          .select(p => ({ userId: p.userId, publishTime: p.publishTime, customDate: p.customDate, username: p.user!.username }))
          .groupBy(r => ({ userId: r.userId }))
          .select(g => ({ userId: g.key.userId, earliest: g.min(r => r.publishTime), latest: g.max(r => r.customDate), who: g.max(r => r.username) }))
          .orderBy(r => r.userId)
          .toList();

        expect(rows[0].earliest).toEqual({ hour: 9, minute: 30 });
        expect(rows[1].earliest).toEqual({ hour: 18, minute: 45 });
        expect(rows[0].latest).toBeInstanceOf(Date);
        expect((rows[0].latest as unknown as Date).toISOString()).toBe('2024-01-16T10:00:00.000Z');
        expect(rows.map(r => r.who)).toEqual(['alice', 'bob']);
      });
    });

    test('of a mapped column, read through a grouped CTE: through the column mapper', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const grouped = db.posts
          .select(p => ({ userId: p.userId, publishTime: p.publishTime }))
          .groupBy(r => ({ userId: r.userId }))
          .select(g => ({ userId: g.key.userId, earliest: g.min(r => r.publishTime) }));

        expect(typeof grouped.getSelectionMetadata().earliest.getMapper).toBe('function');
      });
    });
  });

  describe('projection shapes', () => {
    test('constants and NULL', async () => {
      const rows = await byBook()
        .select(g => ({ book: g.key.book, kind: 'edition-count', none: null, n: g.count() }))
        .orderBy(r => r.book)
        .toList();

      expect(rows.map(r => [r.kind, r.none, r.n])).toEqual([['edition-count', null, 3], ['edition-count', null, 2]]);
    });

    test('an sql expression over aggregates', async () => {
      const rows = await byBook()
        .select(g => ({ book: g.key.book, perEdition: sql<number>`${g.sum(r => r.num)} / ${g.count()}` }))
        .orderBy(r => r.book)
        .toList();

      expect(rows.map(r => Number(r.perEdition))).toEqual([
        Math.floor((fx.ids.e2 + fx.ids.e3 + fx.ids.e5) / 3),
        Math.floor((fx.ids.e1 + fx.ids.e4) / 2),
      ]);
    });

    test('an expression over the expression key, over the grouped subquery', async () => {
      const rows = await byInitial()
        .select(g => ({ cat: g.key.cat, tag: sql<string>`${g.key.initial} || '-' || ${g.count()}` }))
        .orderBy(r => r.cat)
        .toList();

      expect(rows.map(r => r.tag).sort()).toEqual(['E-2', 'E-3']);
    });

    test('a nested object is refused, not dropped', async () => {
      await expectToReject(
        () => byBook().select(g => ({ book: g.key.book, stats: { n: g.count() } } as any)).toList(),
        /"stats" is a nested object/
      );
    });

    test('any other object is refused, not dropped', async () => {
      await expectToReject(
        () => byBook().select(g => ({ book: g.key.book, all: fx.db.libBooks as any })).toList(),
        /Grouped select\(\): "all"/
      );
    });
  });
});
