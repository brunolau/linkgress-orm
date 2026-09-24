import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  asBoolean, eq, flagHas, gt, jsonbArraySome, jsonbSelect, jsonbSelectText, literal, quoteSqlLiteral,
  sql, SqlFragment, typedNull,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('literals, typed NULLs and conditions as values', () => {
  describe('quoteSqlLiteral()', () => {
    test('quotes a plain string', () => {
      expect(quoteSqlLiteral('abc')).toBe("'abc'");
      expect(quoteSqlLiteral('')).toBe("''");
    });

    test('doubles single quotes', () => {
      expect(quoteSqlLiteral("it's")).toBe("'it''s'");
      expect(quoteSqlLiteral("''")).toBe("''''''");
    });

    test('uses the escape-string form when a backslash is present', () => {
      expect(quoteSqlLiteral('a\\b')).toBe("E'a\\\\b'");
      expect(quoteSqlLiteral("x'\\y")).toBe("E'x''\\\\y'");
    });

    test('keeps unicode as is', () => {
      expect(quoteSqlLiteral('Žltý kôň 🐝')).toBe("'Žltý kôň 🐝'");
    });

    test('neutralises an injection attempt', () => {
      expect(quoteSqlLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'");
    });

    test('refuses NUL and non-strings', () => {
      expect(() => quoteSqlLiteral('a\u0000b')).toThrow(/NUL/);
      expect(() => quoteSqlLiteral(5 as any)).toThrow(/expects a string/);
    });
  });

  describe('literal()', () => {
    const cases: Array<[unknown, string]> = [
      ['product', "'product'"],
      ["O'Brien", "'O''Brien'"],
      [42, '42'],
      [0, '0'],
      [-5, '(-5)'],
      [-0, '(0)'],
      [1.25, '1.25'],
      [1e21, '1e+21'],
      [NaN, "'NaN'"],
      [Infinity, "'Infinity'"],
      [-Infinity, "'-Infinity'"],
      [12345678901234567890n, '12345678901234567890'],
      [-7n, '(-7)'],
      [true, 'TRUE'],
      [false, 'FALSE'],
      [null, 'NULL'],
    ];

    for (const [value, expected] of cases) {
      test(`inlines ${typeof value === 'bigint' ? `${value}n` : JSON.stringify(value) ?? String(value)} as ${expected}`, () => {
        expect(build(literal(value as any))).toEqual({ sql: expected, params: [] });
      });
    }

    test('an optional type wraps it in a cast', () => {
      expect(build(literal('x', 'varchar(8)'))).toEqual({ sql: "CAST('x' AS varchar(8))", params: [] });
      expect(build(literal(1.5, 'double precision'))).toEqual({ sql: 'CAST(1.5 AS double precision)', params: [] });
      expect(build(literal(null, 'integer'))).toEqual({ sql: 'CAST(NULL AS integer)', params: [] });
    });

    test('refuses values that cannot be written inline', () => {
      expect(() => literal(new Date() as any)).toThrow(/a Date/);
      expect(() => literal({ a: 1 } as any)).toThrow(/object/);
      expect(() => literal([1] as any)).toThrow(/object/);
      expect(() => literal(Symbol('x') as any)).toThrow(/symbol/);
      expect(() => literal('a\u0000' as any)).toThrow(/NUL/);
    });

    test('adds nothing to the parameter list', () => {
      const ctx: SqlBuildContext = { paramCounter: 3, params: ['already'] };
      expect(sql`${literal('a')} || ${'b'}`.buildSql(ctx)).toBe("'a' || $3");
      expect(ctx.params).toEqual(['already', 'b']);
    });
  });

  describe('typedNull()', () => {
    test('renders a typed NULL', () => {
      expect(build(typedNull('integer'))).toEqual({ sql: 'CAST(NULL AS integer)', params: [] });
      expect(build(typedNull('timestamp with time zone'))).toEqual({ sql: 'CAST(NULL AS timestamp with time zone)', params: [] });
      expect(build(typedNull('text[]'))).toEqual({ sql: 'CAST(NULL AS text[])', params: [] });
    });

    test('validates the type name', () => {
      expect(() => typedNull('int); DROP TABLE x; --')).toThrow(/Invalid PostgreSQL type name/);
    });
  });

  describe('asBoolean()', () => {
    const qty = fieldRef('qty', { sqlType: 'integer' });

    test('wraps a comparison', () => {
      expect(build(asBoolean(gt(qty, 3)))).toEqual({ sql: '("expr_shelves"."qty" > $1)', params: [3] });
    });

    test('wraps a boolean fragment in parentheses', () => {
      expect(build(asBoolean(flagHas(qty, 4)))).toEqual({ sql: '(("expr_shelves"."qty" & $1) != 0)', params: [4] });
    });

    test('keeps the condition refs visible', () => {
      const city = fieldRef('city', { alias: 'library' });
      expect(asBoolean(eq(city, 'Vienna')).getFieldRefs()).toEqual([city]);
    });

    test('refuses a non-condition', () => {
      expect(() => asBoolean(qty)).toThrow(/expects a condition/);
      expect(() => asBoolean(true as any)).toThrow(/expects a condition/);
    });
  });

  describe('JSON keys are quoted, not spliced', () => {
    const meta = fieldRef('meta', { sqlType: 'jsonb' });

    test('jsonbSelectText escapes a quote in the key', () => {
      expect(build(jsonbSelectText<any>(meta, "it's"))).toEqual({ sql: `"expr_shelves"."meta"->>'it''s'`, params: [] });
    });

    test('jsonbSelect escapes a quote in the key and keeps its re-parse', () => {
      expect(build(jsonbSelect<any>(meta, "x'y"))).toEqual({ sql: `("expr_shelves"."meta" #>> '{}')::jsonb->'x''y'`, params: [] });
    });

    test('a key that tries to break out stays a key', () => {
      const built = build(jsonbSelectText<any>(meta, "a' OR '1'='1"));
      expect(built.sql).toBe(`"expr_shelves"."meta"->>'a'' OR ''1''=''1'`);
    });

    test('jsonbArraySome element paths are quoted too', () => {
      const condition = jsonbArraySome<any>(meta, el => eq(el["it's"], 'x'));
      const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
      expect(condition.buildSql(ctx)).toContain(`__elem->>'it''s' = $1`);
    });

    test('ordinary keys render exactly as before', () => {
      expect(build(jsonbSelectText<any>(meta, 'genre')).sql).toBe(`"expr_shelves"."meta"->>'genre'`);
      expect(build(jsonbSelect<any>(meta, 'genre')).sql).toBe(`("expr_shelves"."meta" #>> '{}')::jsonb->'genre'`);
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

    test('literals read back exactly as written', async () => {
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(() => ({
          zip: literal('01234'),
          tricky: literal("it's \\ tricky"),
          int: literal(42),
          negative: literal(-5),
          decimal: literal(1.5),
          asDouble: literal(1.5, 'double precision'),
          yes: literal(true),
          nothing: literal(null),
          huge: literal(12345678901234567890n),
          unicode: literal('Žltý kôň'),
        }))
        .firstOrDefault();

      expect(row).toEqual({
        zip: '01234',
        tricky: "it's \\ tricky",
        int: 42,
        negative: -5,
        // an inline decimal is a numeric constant; number literals read back as JS numbers
        decimal: 1.5,
        asDouble: 1.5,
        yes: true,
        nothing: null,
        huge: '12345678901234567890',
        unicode: 'Žltý kôň',
      } as any);
    });

    test('a literal discriminator and typed NULL pads line up UNION ALL legs', async () => {
      const rows = await fixture.db.shelves
        .select(s => ({ kind: literal('shelf'), name: s.name, city: typedNull<string>('varchar(64)') }))
        .unionAll(fixture.db.libraries.select(l => ({ kind: literal('library'), name: l.name, city: l.city })))
        .toList();

      const sorted = [...rows].sort((a, b) => `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`));

      expect(sorted).toEqual([
        { kind: 'library', name: 'Central', city: 'Vienna' },
        { kind: 'library', name: 'Harbor', city: 'Lisbon' },
        { kind: 'shelf', name: 'History', city: null },
        { kind: 'shelf', name: 'Mystery', city: null },
        { kind: 'shelf', name: 'Poetry', city: null },
      ] as any);
    });

    test('asBoolean projects a condition, NULL input giving NULL', async () => {
      const rows = await fixture.db.shelves
        .select(s => ({ id: s.id, stocked: asBoolean(gt(s.qty, 0)) }))
        .toList();

      const byId = new Map(rows.map(r => [r.id, r.stocked]));
      expect(byId.get(1)).toBe(true);
      expect(byId.get(2)).toBe(false);
      expect(byId.get(3) == null).toBe(true);
    });

    test('asBoolean over a navigation joins it', async () => {
      const rows = await fixture.db.shelves
        .select(s => ({ id: s.id, inVienna: asBoolean(eq(s.library!.city, 'Vienna')) }))
        .toList();

      expect([...rows].sort((a, b) => a.id - b.id).map(r => r.inVienna)).toEqual([true, false, true]);
      expect(fixture.lastStatement()).toContain('JOIN "expr_libraries"');
    });

    test('a JSON key containing a quote reads its value', async () => {
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(s => ({ quoted: jsonbSelectText<any>(s.meta, "it's") }))
        .firstOrDefault();

      expect(row).toEqual({ quoted: 'quoted' } as any);
    });
  });
});
