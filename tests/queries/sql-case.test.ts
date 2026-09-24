import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  and, caseOf, caseWhen, div, eq, gt, isNotNull, isNull, jsonbPathText, lt, or, sql, SqlFragment, sub,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('caseWhen / caseOf', () => {
  const qty = fieldRef('qty', { sqlType: 'integer' });
  const name = fieldRef('name', { sqlType: 'varchar' });

  describe('searched CASE rendering', () => {
    test('one branch, implicit ELSE NULL', () => {
      expect(build(caseWhen(gt(qty, 10), 'plenty'))).toEqual({
        sql: 'CASE WHEN "expr_shelves"."qty" > $1 THEN CAST($2 AS text) END',
        params: [10, 'plenty'],
      });
    });

    test('several branches and an ELSE, in order', () => {
      const expression = caseWhen(gt(qty, 10), 'plenty').when(gt(qty, 0), 'some').else('none');

      expect(build(expression)).toEqual({
        sql: 'CASE WHEN "expr_shelves"."qty" > $1 THEN CAST($2 AS text) WHEN "expr_shelves"."qty" > $3 THEN CAST($4 AS text) ELSE CAST($5 AS text) END',
        params: [10, 'plenty', 0, 'some', 'none'],
      });
    });

    test('a logical condition renders in parentheses', () => {
      expect(build(caseWhen(and(gt(qty, 1), lt(qty, 5)), 1).else(0)).sql)
        .toBe('CASE WHEN ("expr_shelves"."qty" > $1 AND "expr_shelves"."qty" < $2) THEN CAST($3 AS integer) ELSE CAST($4 AS integer) END');
    });

    test('a column branch fixes the type; plain values stay untyped for PostgreSQL to unify', () => {
      expect(build(caseWhen(isNotNull(qty), qty).else(-1))).toEqual({
        sql: 'CASE WHEN "expr_shelves"."qty" IS NOT NULL THEN "expr_shelves"."qty" ELSE $1 END',
        params: [-1],
      });
    });

    test('all-plain results are typed from their JS type', () => {
      const typeOf = (value: unknown) => build(caseWhen(gt(qty, 0), value as any).else(value as any)).sql;

      expect(typeOf(1)).toContain('THEN CAST($2 AS integer) ELSE CAST($3 AS integer)');
      expect(typeOf(3000000000)).toContain('CAST($2 AS bigint)');
      expect(typeOf(1.5)).toContain('CAST($2 AS double precision)');
      expect(typeOf(5n)).toContain('CAST($2 AS bigint)');
      expect(typeOf(true)).toContain('CAST($2 AS boolean)');
      expect(typeOf('x')).toContain('CAST($2 AS text)');
      expect(typeOf(new Date('2024-01-01T00:00:00Z'))).toContain('CAST($2 AS timestamptz)');
      expect(typeOf({ a: 1 })).toContain('CAST(CAST($2 AS text) AS jsonb)');
    });

    test('a JS object result is serialized for jsonb', () => {
      expect(build(caseWhen(gt(qty, 0), { a: [1] }).else([])).params).toEqual([0, '{"a":[1]}', '[]']);
    });

    test('NULL results render as NULL without parameters', () => {
      expect(build(caseWhen(gt(qty, 0), null).else(5))).toEqual({
        sql: 'CASE WHEN "expr_shelves"."qty" > $1 THEN NULL ELSE CAST($2 AS integer) END',
        params: [0, 5],
      });
    });

    test('a condition as a result renders as a boolean value', () => {
      expect(build(caseWhen(isNull(qty), false).else(gt(qty, 3))).sql)
        .toBe('CASE WHEN "expr_shelves"."qty" IS NULL THEN $1 ELSE ("expr_shelves"."qty" > $2) END');
    });

    test('CASE expressions nest', () => {
      const inner = caseWhen(gt(qty, 100), 'huge').else('big');
      expect(build(caseWhen(gt(qty, 10), inner).else('small')).sql)
        .toBe('CASE WHEN "expr_shelves"."qty" > $1 THEN CASE WHEN "expr_shelves"."qty" > $2 THEN CAST($3 AS text) ELSE CAST($4 AS text) END ELSE $5 END');
    });

    test('builders are immutable', () => {
      const base = caseWhen(gt(qty, 1), 'a');
      const extended = base.when(gt(qty, 2), 'b');
      const closed = base.else('z');

      expect(build(base).sql).toBe('CASE WHEN "expr_shelves"."qty" > $1 THEN CAST($2 AS text) END');
      expect(build(extended).sql).toContain('WHEN "expr_shelves"."qty" > $3 THEN');
      expect(build(closed).sql).toContain('ELSE CAST($3 AS text) END');
      expect(build(base).sql).not.toContain('ELSE');
    });

    test('reports refs from WHEN and THEN, through navigations', () => {
      const city = fieldRef('city', { alias: 'library', navigationAliases: [] });
      const zone = fieldRef('time_zone', { alias: 'library' });
      const expression = caseWhen(eq(city, 'Vienna'), zone).when(gt(qty, 0), name).else(sql`${qty}::text`);

      expect(expression.getFieldRefs()).toEqual([city, zone, qty, name, qty]);
    });

    test('a column mapper applies to the result and to plain values', () => {
      const mapper = { toDriver: (value: { hours: number }) => value.hours * 60, fromDriver: (value: number) => ({ hours: value / 60 }) };
      const minutes = fieldRef('minutes', { mapper });
      const expression = caseWhen(gt(qty, 0), minutes).else({ hours: 2 } as any);

      expect(build(expression)).toEqual({
        sql: 'CASE WHEN "expr_shelves"."qty" > $1 THEN "expr_shelves"."minutes" ELSE $2 END',
        params: [0, 120],
      });
      expect(expression.getMapper()).toBe(mapper);
    });

    test('refuses a non-condition WHEN', () => {
      expect(() => caseWhen(qty as any, 1)).toThrow(/WHEN expects a condition/);
      expect(() => caseWhen(gt(qty, 0), 1).when('x' as any, 2)).toThrow(/WHEN expects a condition/);
    });
  });

  describe('simple CASE rendering', () => {
    test('compares the subject with each match value', () => {
      const expression = caseOf(qty).when(1, 'one').when(2, 'two').else('many');

      expect(build(expression)).toEqual({
        sql: 'CASE "expr_shelves"."qty" WHEN $1 THEN CAST($2 AS text) WHEN $3 THEN CAST($4 AS text) ELSE CAST($5 AS text) END',
        params: [1, 'one', 2, 'two', 'many'],
      });
    });

    test('match values go through the subject mapper', () => {
      const mapper = { toDriver: (value: string) => value.length, fromDriver: (value: number) => 'x'.repeat(value) };
      const coded = fieldRef('code', { mapper });

      expect(build(caseOf(coded).when('abc', 'three').else('other')).params).toEqual([3, 'three', 'other']);
    });

    test('a column may be a match value', () => {
      expect(build(caseOf(qty).when(fieldRef('slot'), 'same')).sql)
        .toBe('CASE "expr_shelves"."qty" WHEN "expr_shelves"."slot" THEN CAST($1 AS text) END');
    });

    test('refuses an undefined subject', () => {
      expect(() => caseOf(undefined as any)).toThrow(/operand is undefined/);
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

    test('labels rows in branch order', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          stock: caseWhen(gt(s.qty, 10), 'plenty').when(gt(s.qty, 0), 'some').else('none'),
        }))
        .toList());

      expect(rows.map(r => r.stock)).toEqual(['plenty', 'none', 'none']);
    });

    test('plain number and boolean results come back typed, not as text', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          known: caseWhen(isNull(s.qty), 0).else(1),
          flag: caseWhen(eq(s.active, true), true).else(false),
          scale: caseWhen(gt(s.ratio, 1), 2.5).else(0.5),
          unmatched: caseWhen(eq(s.name, 'nobody'), 1),
        }))
        .toList());

      expect(rows).toEqual([
        { id: 1, known: 1, flag: true, scale: 0.5, unmatched: null },
        { id: 2, known: 1, flag: false, scale: 2.5, unmatched: null },
        { id: 3, known: 0, flag: false, scale: 0.5, unmatched: null },
      ] as any);
    });

    test('a column branch keeps the column type', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, qtyOrMinusOne: caseWhen(isNotNull(s.qty), s.qty).else(-1) }))
        .toList());

      expect(rows.map(r => r.qtyOrMinusOne)).toEqual([12, 0, -1]);
    });

    test('a navigation in WHEN joins the navigation', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, country: caseWhen(eq(s.library!.city, 'Vienna'), 'AT').else('PT') }))
        .toList());

      expect(rows.map(r => r.country)).toEqual(['AT', 'PT', 'AT']);
      expect(fixture.lastStatement()).toContain('JOIN "expr_libraries"');
    });

    test('a navigation only in THEN joins the navigation', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, place: caseWhen(gt(s.qty, 5), s.library!.city).else(s.name) }))
        .toList());

      expect(rows.map(r => r.place)).toEqual(['Vienna', 'History', 'Mystery']);
    });

    test('CASE evaluates lazily, so a branch can guard a division', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, perItem: caseWhen(gt(s.qty, 0), div(120, s.qty)).else(null) }))
        .toList());

      expect(rows.map(r => r.perItem)).toEqual([10, null, null]);
    });

    test('in WHERE', async () => {
      const rows = await fixture.db.shelves
        .where(s => eq(caseWhen(gt(s.qty, 5), 'big').else('small'), 'big'))
        .select(s => ({ name: s.name }))
        .toList();

      expect(rows).toEqual([{ name: 'Poetry' }]);
    });

    test('in WHERE, combined with other conditions', async () => {
      const rows = await fixture.db.shelves
        .where(s => or(eq(caseWhen(isNull(s.qty), 'missing').else('present'), 'missing'), eq(s.name, 'History')))
        .select(s => ({ name: s.name }))
        .toList();

      expect(rows.map(r => r.name).sort()).toEqual(['History', 'Mystery']);
    });

    test('caseOf maps codes to labels', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, libraryName: caseOf(s.libraryId).when(1, 'Central').when(2, 'Harbor').else('?') }))
        .toList());

      expect(rows.map(r => r.libraryName)).toEqual(['Central', 'Harbor', 'Central']);
    });

    test('over a JSON leaf', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, genre: caseOf(jsonbPathText(s.meta, 'genre')).when('poetry', 'P').when('history', 'H').else('-') }))
        .toList());

      expect(rows.map(r => r.genre)).toEqual(['P', 'H', '-']);
    });

    test('as an UPDATE value — one statement, no read', async () => {
      await fixture.db.shelves
        .where(s => isNotNull(s.qty))
        .update(s => ({ qty: caseWhen(gt(s.qty, 0), sub(s.qty, 1)).else(0) }));

      const rows = byId(await fixture.db.shelves.select(s => ({ id: s.id, qty: s.qty })).toList());
      expect(rows.map(r => r.qty)).toEqual([11, 0, null] as any);
      expect(fixture.lastStatement('UPDATE')).toMatch(/CASE WHEN "expr_shelves"\."qty" > \$\d+ THEN \("expr_shelves"\."qty" - \$\d+\) ELSE \$\d+ END/);

      await fixture.db.shelves.where(s => eq(s.id, 1)).update({ qty: 12 });
    });

    test('in ORDER BY', async () => {
      const rows = await fixture.db.shelves
        .select(s => ({ name: s.name, rank: caseWhen(eq(s.name, 'History'), 0).else(1) }))
        .orderBy(s => [[s.rank, 'ASC'], [s.name, 'ASC']])
        .toList();

      expect(rows.map(r => r.name)).toEqual(['History', 'Mystery', 'Poetry']);
    });
  });
});
