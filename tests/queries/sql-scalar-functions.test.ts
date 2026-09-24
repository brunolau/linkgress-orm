import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  abs, ceil, concat, concatWs, eq, floor, greatest, isDistinctFrom, isNotDistinctFrom, least, length,
  literal, lower, mod, nullIf, regexpReplace, replace, round, sql, SqlFragment, sub, substring, trim,
  trimEnd, trimStart, upper, gt,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('scalar, string and math helpers', () => {
  const qty = fieldRef('qty', { sqlType: 'integer' });
  const label = fieldRef('label', { sqlType: 'text' });
  const name = fieldRef('name', { sqlType: 'varchar' });

  describe('GREATEST / LEAST / NULLIF / IS DISTINCT FROM rendering', () => {
    test('a column operand fixes the type; literals stay untyped', () => {
      expect(build(greatest(qty, 5))).toEqual({ sql: 'GREATEST("expr_shelves"."qty", $1)', params: [5] });
      expect(build(least(qty, 5, 10))).toEqual({ sql: 'LEAST("expr_shelves"."qty", $1, $2)', params: [5, 10] });
    });

    test('all-literal operands are typed from their JS type', () => {
      expect(build(greatest(1, 2))).toEqual({ sql: 'GREATEST(CAST($1 AS integer), CAST($2 AS integer))', params: [1, 2] });
      expect(build(least('a', 'b')).sql).toBe('LEAST(CAST($1 AS text), CAST($2 AS text))');
    });

    test('need at least two operands', () => {
      expect(() => (greatest as any)(qty)).toThrow(/at least two operands/);
      expect(() => (least as any)(qty)).toThrow(/at least two operands/);
    });

    test('NULLIF', () => {
      expect(build(nullIf(label, ''))).toEqual({ sql: 'NULLIF("expr_shelves"."label", $1)', params: [''] });
    });

    test('IS DISTINCT FROM with a value, a column and NULL', () => {
      expect(build(isDistinctFrom(label, 'x'))).toEqual({ sql: '("expr_shelves"."label" IS DISTINCT FROM $1)', params: ['x'] });
      expect(build(isDistinctFrom(label, name)).sql).toBe('("expr_shelves"."label" IS DISTINCT FROM "expr_shelves"."name")');
      expect(build(isDistinctFrom(label, null))).toEqual({ sql: '("expr_shelves"."label" IS DISTINCT FROM NULL)', params: [] });
      expect(build(isNotDistinctFrom(label, undefined as any))).toEqual({ sql: '("expr_shelves"."label" IS NOT DISTINCT FROM NULL)', params: [] });
    });

    test('a column mapper applies to the plain operand', () => {
      const mapper = { toDriver: (value: number) => value * 60, fromDriver: (value: number) => value / 60 };
      const minutes = fieldRef('minutes', { mapper });

      expect(build(isDistinctFrom(minutes, 2)).params).toEqual([120]);
      expect(build(greatest(minutes, 3)).params).toEqual([180]);
      expect(greatest(minutes, 3).getMapper()).toBe(mapper);
    });
  });

  describe('string function rendering', () => {
    test('single-argument functions', () => {
      expect(build(lower(name)).sql).toBe('lower("expr_shelves"."name")');
      expect(build(upper(name)).sql).toBe('upper("expr_shelves"."name")');
      expect(build(trim(label)).sql).toBe('btrim("expr_shelves"."label")');
      expect(build(trimStart(label)).sql).toBe('ltrim("expr_shelves"."label")');
      expect(build(trimEnd(label)).sql).toBe('rtrim("expr_shelves"."label")');
      expect(build(length(name)).sql).toBe('char_length("expr_shelves"."name")');
    });

    test('plain arguments are typed', () => {
      expect(build(lower('ABC'))).toEqual({ sql: 'lower(CAST($1 AS text))', params: ['ABC'] });
      expect(build(trim(label, 'x'))).toEqual({ sql: 'btrim("expr_shelves"."label", CAST($1 AS text))', params: ['x'] });
      expect(build(substring(name, 2, 3))).toEqual({
        sql: 'substring("expr_shelves"."name", CAST($1 AS integer), CAST($2 AS integer))',
        params: [2, 3],
      });
      expect(build(replace(name, 'a', 'b'))).toEqual({
        sql: 'replace("expr_shelves"."name", CAST($1 AS text), CAST($2 AS text))',
        params: ['a', 'b'],
      });
    });

    test('concat / concat_ws type every plain argument (they are VARIADIC "any")', () => {
      expect(build(concat(name, '-', qty, 7))).toEqual({
        sql: 'concat("expr_shelves"."name", CAST($1 AS text), "expr_shelves"."qty", CAST($2 AS integer))',
        params: ['-', 7],
      });
      expect(build(concatWs(' ', name, label))).toEqual({
        sql: 'concat_ws(CAST($1 AS text), "expr_shelves"."name", "expr_shelves"."label")',
        params: [' '],
      });
    });

    test('a literal() pattern is inlined — for expression index matches', () => {
      expect(build(regexpReplace(name, literal('[^0-9]'), literal(''), literal('g')))).toEqual({
        sql: `regexp_replace("expr_shelves"."name", '[^0-9]', '', 'g')`,
        params: [],
      });
    });

    test('argument checks', () => {
      expect(() => concat()).toThrow(/at least one operand/);
      expect(() => concatWs(' ')).toThrow(/at least one operand/);
      expect(() => lower(undefined as any)).toThrow(/operand is undefined/);
    });
  });

  describe('math function rendering', () => {
    test('round / floor / ceil / abs / mod', () => {
      expect(build(round(qty)).sql).toBe('round("expr_shelves"."qty")');
      expect(build(round(qty, 2))).toEqual({ sql: 'round(CAST("expr_shelves"."qty" AS numeric), CAST($1 AS integer))', params: [2] });
      expect(build(floor(qty)).sql).toBe('floor("expr_shelves"."qty")');
      expect(build(ceil(qty)).sql).toBe('ceil("expr_shelves"."qty")');
      expect(build(abs(sub(0, qty))).sql).toBe('abs(($1 - "expr_shelves"."qty"))');
      expect(build(mod(qty, 5))).toEqual({ sql: 'mod("expr_shelves"."qty", $1)', params: [5] });
      expect(build(mod(7, 5))).toEqual({ sql: 'mod(CAST($1 AS integer), CAST($2 AS integer))', params: [7, 5] });
    });

    test('mod does not push the dividend mapper onto the divisor', () => {
      const mapper = { toDriver: () => { throw new Error('must not be called'); }, fromDriver: (value: unknown) => value };
      expect(build(mod(fieldRef('minutes', { mapper }), 60)).params).toEqual([60]);
    });

    test('results read back as JS numbers', () => {
      expect(round(qty).getMapper().fromDriver('2.50')).toBe(2.5);
      expect(abs(qty).getMapper().fromDriver(null)).toBeNull();
    });
  });

  describe('against the database', () => {
    let fixture: ExpressionFixture;

    beforeAll(async () => {
      fixture = await createExpressionFixture();
    });

    afterAll(async () => {
      await disposeExpressionFixture(fixture);
    });

    const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);

    test('GREATEST / LEAST ignore NULL operands', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, atLeastFive: greatest(s.qty, 5), atMostFive: least(s.qty, 5), constant: greatest(3, 9, 4) }))
        .toList());

      expect(rows).toEqual([
        { id: 1, atLeastFive: 12, atMostFive: 5, constant: 9 },
        { id: 2, atLeastFive: 5, atMostFive: 0, constant: 9 },
        { id: 3, atLeastFive: 5, atMostFive: 5, constant: 9 },
      ] as any);
    });

    test('NULLIF turns the empty string into NULL', async () => {
      const rows = byId(await fixture.db.shelves.select(s => ({ id: s.id, label: nullIf(s.label, '') })).toList());
      expect(rows.map(r => r.label)).toEqual(['  Verse  ', null, null] as any);
    });

    test('IS DISTINCT FROM treats NULL as a comparable value', async () => {
      const distinct = await fixture.db.shelves
        .where(s => isDistinctFrom(s.label, ''))
        .select(s => ({ name: s.name }))
        .toList();
      expect(distinct.map(r => r.name).sort()).toEqual(['History', 'Poetry']);

      const nullLabel = await fixture.db.shelves
        .where(s => isNotDistinctFrom(s.label, null))
        .select(s => ({ name: s.name }))
        .toList();
      expect(nullLabel).toEqual([{ name: 'History' }]);
    });

    test('IS DISTINCT FROM as a projected value', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, changed: isDistinctFrom(s.qty, 0) }))
        .toList());
      expect(rows.map(r => r.changed)).toEqual([true, false, true]);
    });

    test('string functions', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          lower: lower(s.name),
          upper: upper(s.name),
          trimmed: trim(s.label),
          left: trimStart(s.label),
          right: trimEnd(s.label),
          stars: trim(literal('**x**'), '*'),
          len: length(s.name),
          tag: concat(s.name, '#', s.qty),
          full: concatWs(' / ', s.name, s.label),
          part: substring(s.name, 2, 3),
          tail: substring(s.name, 4),
          swapped: replace(s.name, 'y', 'Y'),
          consonants: regexpReplace(s.name, '[aeiouy]', '', 'g'),
        }))
        .toList());

      expect(rows).toEqual([
        {
          id: 1, lower: 'poetry', upper: 'POETRY', trimmed: 'Verse', left: 'Verse  ', right: '  Verse', stars: 'x',
          len: 6, tag: 'Poetry#12', full: 'Poetry /   Verse  ', part: 'oet', tail: 'try', swapped: 'PoetrY', consonants: 'Ptr',
        },
        {
          id: 2, lower: 'history', upper: 'HISTORY', trimmed: null, left: null, right: null, stars: 'x',
          len: 7, tag: 'History#0', full: 'History', part: 'ist', tail: 'tory', swapped: 'HistorY', consonants: 'Hstr',
        },
        {
          id: 3, lower: 'mystery', upper: 'MYSTERY', trimmed: '', left: '', right: '', stars: 'x',
          len: 7, tag: 'Mystery#', full: 'Mystery / ', part: 'yst', tail: 'tery', swapped: 'MYsterY', consonants: 'Mstr',
        },
      ] as any);
    });

    test('numeric-looking text from a string function stays text', async () => {
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(() => ({ zip: trim(literal(' 01234 ')), joined: concat('00', 7) }))
        .firstOrDefault();

      expect(row).toEqual({ zip: '01234', joined: '007' } as any);
    });

    test('lower() in WHERE', async () => {
      const rows = await fixture.db.shelves
        .where(s => eq(lower(s.name), 'history'))
        .select(s => ({ id: s.id }))
        .toList();
      expect(rows).toEqual([{ id: 2 }]);
    });

    test('a string function over a navigation joins it', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, where: concatWs(', ', s.name, upper(s.library!.city)) }))
        .toList());

      expect(rows.map(r => r.where)).toEqual(['Poetry, VIENNA', 'History, LISBON', 'Mystery, VIENNA']);
    });

    test('math functions read back as numbers', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          rounded: round(s.ratio),
          oneDigit: round(s.ratio, 1),
          priceRounded: round(s.price, 0),
          down: floor(s.ratio),
          up: ceil(s.ratio),
          magnitude: abs(sub(0, s.qty)),
          remainder: mod(s.qty, 5),
        }))
        .toList());

      expect(rows).toEqual([
        { id: 1, rounded: 0, oneDigit: 0.3, priceRounded: 20, down: 0, up: 1, magnitude: 12, remainder: 2 },
        { id: 2, rounded: 2, oneDigit: 1.5, priceRounded: 5, down: 1, up: 2, magnitude: 0, remainder: 0 },
        { id: 3, rounded: null, oneDigit: null, priceRounded: null, down: null, up: null, magnitude: null, remainder: null },
      ] as any);
    });

    test('math in WHERE', async () => {
      const rows = await fixture.db.shelves
        .where(s => gt(round(s.price, 0), 10))
        .select(s => ({ name: s.name }))
        .toList();
      expect(rows).toEqual([{ name: 'Poetry' }]);
    });

    test('helpers compose inside a sql template', async () => {
      const rows = await fixture.db.shelves
        .where(s => sql<boolean>`${length(trim(s.label))} > ${0}`)
        .select(s => ({ name: s.name }))
        .toList();
      expect(rows).toEqual([{ name: 'Poetry' }]);
    });
  });
});
