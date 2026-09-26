import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  cast, castAsInt, castAsSmallInt, castAsBigInt, castAsNumeric, castAsDouble, castAsString,
  castAsVarchar, castAsBoolean, castAsDate, castAsTimestamp, castAsTimestamptz, castAsJsonb,
  castAsJson, castAsUuid, coalesce, eq, gt, isNotNull, jsonbArraySome, jsonbPathText,
  jsonbSelectText, sql, SqlFragment,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('cast helpers', () => {
  const qty = fieldRef('qty', { sqlType: 'integer' });
  const label = fieldRef('label', { sqlType: 'text' });

  describe('cast() rendering', () => {
    test('a column is cast as an expression, with no parameters', () => {
      expect(build(cast(label, 'integer'))).toEqual({ sql: 'CAST("expr_shelves"."label" AS integer)', params: [] });
    });

    test('a plain value becomes ONE typed bind parameter', () => {
      expect(build(cast(42, 'bigint'))).toEqual({ sql: 'CAST($1 AS bigint)', params: [42] });
      expect(build(cast('2024-01-02', 'date'))).toEqual({ sql: 'CAST($1 AS date)', params: ['2024-01-02'] });
      expect(build(cast(true, 'boolean'))).toEqual({ sql: 'CAST($1 AS boolean)', params: [true] });
    });

    test('null and undefined render a typed NULL without a parameter', () => {
      expect(build(cast(null, 'text'))).toEqual({ sql: 'CAST(NULL AS text)', params: [] });
      expect(build(cast(undefined, 'integer'))).toEqual({ sql: 'CAST(NULL AS integer)', params: [] });
    });

    test('a compound fragment needs no extra parentheses inside CAST(... AS ...)', () => {
      expect(build(cast(sql`${qty} + ${1}`, 'numeric'))).toEqual({
        sql: 'CAST("expr_shelves"."qty" + $1 AS numeric)',
        params: [1],
      });
    });

    test('casts nest', () => {
      expect(build(castAsInt(castAsString(qty)))).toEqual({
        sql: 'CAST(CAST("expr_shelves"."qty" AS text) AS integer)',
        params: [],
      });
    });

    test('parameter numbering continues across casts in one statement', () => {
      const fragment = sql`${cast(1, 'integer')} + ${cast(2, 'integer')} + ${cast(null, 'integer')} + ${cast(3, 'integer')}`;

      expect(build(fragment)).toEqual({
        sql: 'CAST($1 AS integer) + CAST($2 AS integer) + CAST(NULL AS integer) + CAST($3 AS integer)',
        params: [1, 2, 3],
      });
    });

    test('keeps the column refs visible for JOIN detection', () => {
      const city = fieldRef('city', { alias: 'library', navigationAliases: ['library'] });

      expect(cast(city, 'text').getFieldRefs()).toEqual([city]);
      expect(castAsInt(sql`${city} || ${qty}`).getFieldRefs()).toEqual([city, qty]);
    });
  });

  describe('type names', () => {
    const accepted = [
      'integer', 'int', 'int4', 'bigint', 'smallint', 'text', 'boolean', 'uuid', 'jsonb', 'date',
      'double precision', 'timestamp with time zone', 'timestamp without time zone', 'character varying',
      'numeric(12, 2)', 'numeric(12,2)', 'numeric(5)', 'varchar(64)', 'character varying(10)',
      'integer[]', 'text[]', 'varchar(64)[]', 'integer[][]', 'integer[3]',
      'public.my_enum', '"MyEnum"', 'public."Status Kind"', 'my_schema.money_amount',
    ];

    for (const type of accepted) {
      test(`accepts ${JSON.stringify(type)}`, () => {
        expect(build(cast(label, type)).sql).toBe(`CAST("expr_shelves"."label" AS ${type})`);
      });
    }

    test('trims surrounding whitespace', () => {
      expect(build(cast(label, '  integer ')).sql).toBe('CAST("expr_shelves"."label" AS integer)');
    });

    const rejected = [
      '', '   ', 'int; DROP TABLE users', "text) OR ('1' = '1", 'int)--', 'int--', 'integer/*x*/',
      'integer)', '1integer', 'a.b.c', 'numeric(12, 2', 'numeric(a)', 'text[', 'text]',
      "text'", 'text\nAS', 'my enum"', '""', 'integer  []x',
    ];

    for (const type of rejected) {
      test(`refuses ${JSON.stringify(type)}`, () => {
        expect(() => cast(label, type)).toThrow(/Invalid PostgreSQL type name/);
      });
    }

    test('refuses a non-string type', () => {
      expect(() => cast(label, 42 as any)).toThrow(/Invalid PostgreSQL type name/);
    });
  });

  describe('castAs* shorthands', () => {
    const cases: Array<[string, SqlFragment<any>, string]> = [
      ['castAsInt', castAsInt(qty), 'integer'],
      ['castAsSmallInt', castAsSmallInt(qty), 'smallint'],
      ['castAsBigInt', castAsBigInt(qty), 'bigint'],
      ['castAsNumeric()', castAsNumeric(qty), 'numeric'],
      ['castAsNumeric(10)', castAsNumeric(qty, 10), 'numeric(10)'],
      ['castAsNumeric(10, 2)', castAsNumeric(qty, 10, 2), 'numeric(10, 2)'],
      ['castAsNumeric(10, 0)', castAsNumeric(qty, 10, 0), 'numeric(10, 0)'],
      ['castAsDouble', castAsDouble(qty), 'double precision'],
      ['castAsString', castAsString(qty), 'text'],
      ['castAsVarchar()', castAsVarchar(qty), 'varchar'],
      ['castAsVarchar(20)', castAsVarchar(qty, 20), 'varchar(20)'],
      ['castAsBoolean', castAsBoolean(qty), 'boolean'],
      ['castAsDate', castAsDate(qty), 'date'],
      ['castAsTimestamp', castAsTimestamp(qty), 'timestamp'],
      ['castAsTimestamptz', castAsTimestamptz(qty), 'timestamptz'],
      ['castAsJsonb', castAsJsonb(qty), 'jsonb'],
      ['castAsJson', castAsJson(qty), 'json'],
      ['castAsUuid', castAsUuid(qty), 'uuid'],
    ];

    for (const [name, fragment, type] of cases) {
      test(`${name} casts to ${type}`, () => {
        expect(build(fragment)).toEqual({ sql: `CAST("expr_shelves"."qty" AS ${type})`, params: [] });
      });
    }

    test('numeric/varchar modifiers are validated', () => {
      expect(() => castAsNumeric(qty, 0)).toThrow(/numeric precision/);
      expect(() => castAsNumeric(qty, 1.5)).toThrow(/numeric precision/);
      expect(() => castAsNumeric(qty, 10, -1)).toThrow(/numeric scale/);
      expect(() => castAsNumeric(qty, undefined, 2)).toThrow(/needs a precision/);
      expect(() => castAsVarchar(qty, 0)).toThrow(/varchar length/);
      expect(() => castAsVarchar(qty, NaN)).toThrow(/varchar length/);
    });
  });

  describe('JSON values', () => {
    // JSON text is bound as TEXT and parsed by the outer cast: a parameter typed json / jsonb is
    // serialized once more by drivers that serialize by type (postgres.js), storing a JSON string
    test('a plain object or array cast to jsonb/json is serialized with JSON.stringify, bound as text', () => {
      expect(build(castAsJsonb({ a: [1, 2], b: null }))).toEqual({ sql: 'CAST(CAST($1 AS text) AS jsonb)', params: ['{"a":[1,2],"b":null}'] });
      expect(build(castAsJson([1, 'two']))).toEqual({ sql: 'CAST(CAST($1 AS text) AS json)', params: ['[1,"two"]'] });
      expect(build(cast({ x: 1 }, 'jsonb'))).toEqual({ sql: 'CAST(CAST($1 AS text) AS jsonb)', params: ['{"x":1}'] });
    });

    test('a string is taken as JSON text as it is', () => {
      expect(build(castAsJsonb('{"a":1}'))).toEqual({ sql: 'CAST(CAST($1 AS text) AS jsonb)', params: ['{"a":1}'] });
    });

    test('a number or boolean binds as itself; a column or expression is cast directly', () => {
      expect(build(castAsJsonb(5))).toEqual({ sql: 'CAST($1 AS jsonb)', params: [5] });
      expect(build(castAsJsonb(true))).toEqual({ sql: 'CAST($1 AS jsonb)', params: [true] });
      expect(build(castAsJsonb(null))).toEqual({ sql: 'CAST(NULL AS jsonb)', params: [] });
    });

    test('a JS array cast to a SQL array type binds as its array literal (every driver accepts it; not JSON)', () => {
      expect(build(cast([1, 2, 3], 'integer[]'))).toEqual({ sql: 'CAST($1 AS integer[])', params: ['{1,2,3}'] });
      expect(build(cast(['a', 'b,c'], 'text[]'))).toEqual({ sql: 'CAST($1 AS text[])', params: ['{"a","b,c"}'] });
      expect(build(cast([[1], [2]], 'int[]'))).toEqual({ sql: 'CAST($1 AS int[])', params: ['{{1},{2}}'] });
    });
  });

  describe('fluent methods on fragments', () => {
    const fragment = sql<string>`${label}`;

    test('mirror the standalone helpers', () => {
      expect(build(fragment.cast('integer'))).toEqual(build(cast(fragment, 'integer')));
      expect(build(fragment.castAsInt())).toEqual(build(castAsInt(fragment)));
      expect(build(fragment.castAsSmallInt())).toEqual(build(castAsSmallInt(fragment)));
      expect(build(fragment.castAsBigInt())).toEqual(build(castAsBigInt(fragment)));
      expect(build(fragment.castAsNumeric(8, 3))).toEqual(build(castAsNumeric(fragment, 8, 3)));
      expect(build(fragment.castAsDouble())).toEqual(build(castAsDouble(fragment)));
      expect(build(fragment.castAsString())).toEqual(build(castAsString(fragment)));
      expect(build(fragment.castAsVarchar(12))).toEqual(build(castAsVarchar(fragment, 12)));
      expect(build(fragment.castAsBoolean())).toEqual(build(castAsBoolean(fragment)));
      expect(build(fragment.castAsDate())).toEqual(build(castAsDate(fragment)));
      expect(build(fragment.castAsTimestamp())).toEqual(build(castAsTimestamp(fragment)));
      expect(build(fragment.castAsTimestamptz())).toEqual(build(castAsTimestamptz(fragment)));
      expect(build(fragment.castAsJsonb())).toEqual(build(castAsJsonb(fragment)));
      expect(build(fragment.castAsJson())).toEqual(build(castAsJson(fragment)));
      expect(build(fragment.castAsUuid())).toEqual(build(castAsUuid(fragment)));
    });

    test('chain', () => {
      expect(build(jsonbPathText(fieldRef('meta'), 'dims', 'w').castAsInt().castAsString())).toEqual({
        sql: `CAST(CAST(("expr_shelves"."meta"->'dims'->>'w') AS integer) AS text)`,
        params: [],
      });
    });

    test('keep the fragment alias', () => {
      expect(jsonbSelectText<any>(fieldRef('meta'), 'genre').castAsString().getAlias()).toBe('genre');
      expect(sql`1`.as('one').castAsInt().getAlias()).toBe('one');
    });

    test('replace the mapper — the old one described the value before the cast', () => {
      const mapper = { fromDriver: (value: number) => value * 100, toDriver: (value: number) => value / 100 };
      const mapped = fieldRef('qty', { mapper });
      const recast = coalesce(mapped, 0).castAsString();

      expect(coalesce(mapped, 0).getMapper()).toBe(mapper);
      expect(recast.getMapper()).not.toBe(mapper);
      // the cast result is read back exactly as the driver returns it
      expect(recast.getMapper().fromDriver('7')).toBe('7');
      expect(recast.getMapper().fromDriver(null)).toBeNull();
    });

    test('castAsNumeric reads a JS number; the exact text stays available through cast()', () => {
      expect(castAsNumeric(qty).getMapper().fromDriver('12.50')).toBe(12.5);
      expect(castAsNumeric(qty).getMapper().fromDriver(null)).toBeNull();
      expect(sql`${qty}`.castAsNumeric(6, 2).getMapper().fromDriver('3.10')).toBe(3.1);
      expect(cast(qty, 'numeric').getMapper().fromDriver('12.50')).toBe('12.50');
    });

    test('work on jsonbArraySome element paths', () => {
      const condition = jsonbArraySome<{ qty: string }>(fieldRef('meta'), el => gt(el.qty.castAsInt(), 5));
      const ctx: SqlBuildContext = { paramCounter: 1, params: [] };

      expect(condition.buildSql(ctx)).toContain(`WHERE CAST((__elem->>'qty') AS integer) > $1`);
      expect(ctx.params).toEqual([5]);
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

    test('integer → text and back', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, asText: castAsString(s.qty), roundTrip: castAsInt(castAsString(s.qty)) }))
        .toList());

      expect(rows).toEqual([
        { id: 1, asText: '12', roundTrip: 12 },
        { id: 2, asText: '0', roundTrip: 0 },
        { id: 3, asText: null, roundTrip: null },
      ] as any);
    });

    test('a JSON text leaf read as an integer, in select and where', async () => {
      const widths = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, width: castAsInt(jsonbPathText(s.meta, 'dims', 'w')) }))
        .toList());

      expect(widths).toEqual([
        { id: 1, width: 120 },
        { id: 2, width: 80 },
        { id: 3, width: null },
      ] as any);

      const tall = await fixture.db.shelves
        .where(s => gt(jsonbPathText(s.meta, 'dims', 'h').castAsInt(), 160))
        .select(s => ({ name: s.name }))
        .toList();

      expect(tall).toEqual([{ name: 'Poetry' }]);
    });

    test('numeric ↔ double: castAsNumeric reads a number, cast<string>(…, numeric) the exact text', async () => {
      const rows = byId(await fixture.db.shelves
        .where(s => isNotNull(s.ratio))
        .select(s => ({
          id: s.id,
          priceAsDouble: castAsDouble(s.price),
          ratioAsNumeric: castAsNumeric(s.ratio),
          ratioRounded: castAsNumeric(s.ratio, 10, 1),
          ratioText: cast<string>(s.ratio, 'numeric(10, 3)'),
          priceText: cast<string>(s.price, 'numeric'),
        }))
        .toList());

      expect(rows).toEqual([
        { id: 1, priceAsDouble: 19.99, ratioAsNumeric: 0.25, ratioRounded: 0.3, ratioText: '0.250', priceText: '19.99' },
        { id: 2, priceAsDouble: 5, ratioAsNumeric: 1.5, ratioRounded: 1.5, ratioText: '1.500', priceText: '5.00' },
      ] as any);
    });

    test('a numeric-looking TEXT result is not turned into a number', async () => {
      // An untyped fragment goes through the generic result conversion ('01234' → 1234); a
      // cast result is read back exactly as the driver returns it.
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(s => ({ zip: castAsString('01234'), padded: cast<string>('007', 'varchar(8)') }))
        .firstOrDefault();

      expect(row).toEqual({ zip: '01234', padded: '007' } as any);
    });

    test('bigint comes back as a string unless mapped', async () => {
      const rows = byId(await fixture.db.shelves
        .where(s => isNotNull(s.counter))
        .select(s => ({ id: s.id, asBig: castAsBigInt(s.qty), counterNumber: castAsBigInt(s.counter).mapWith(Number) }))
        .toList());

      expect(rows[0].asBig).toBe('12');
      expect(rows[1]).toEqual({ id: 2, asBig: '0', counterNumber: 42 } as any);
    });

    test('integer → boolean', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, hasStock: castAsBoolean(s.qty) }))
        .toList());

      expect(rows.map(r => r.hasStock)).toEqual([true, false, null] as any);
    });

    test('timestamp → date (read as text to stay time-zone independent)', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, day: castAsString(castAsDate(s.placedAt)) }))
        .toList());

      expect(rows.map(r => r.day)).toEqual(['2024-03-10', '2024-07-01', null] as any);
    });

    test('typed parameters survive a round trip', async () => {
      const row = await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .select(s => ({
          stamp: castAsString(castAsTimestamp('2024-01-02 03:04:05')),
          doc: castAsJsonb({ ok: true, list: [1, 2], nested: { deep: 'x' } }),
          docFromText: castAsJsonb('{"a": 1}'),
          ids: cast<number[]>([4, 5, 6], 'integer[]'),
          uid: castAsUuid('11111111-1111-4111-8111-111111111111'),
          big: castAsBigInt(9007199254740993n as any),
          nothing: cast<number>(null, 'integer'),
        }))
        .firstOrDefault();

      expect(row).toEqual({
        stamp: '2024-01-02 03:04:05',
        doc: { ok: true, list: [1, 2], nested: { deep: 'x' } },
        docFromText: { a: 1 },
        ids: [4, 5, 6],
        uid: '11111111-1111-4111-8111-111111111111',
        big: '9007199254740993',
        nothing: null,
      } as any);
    });

    test('varchar(n) truncates on an explicit cast', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, short: castAsVarchar(s.name, 3), full: castAsVarchar(s.name) }))
        .toList());

      expect(rows.map(r => r.short)).toEqual(['Poe', 'His', 'Mys']);
      expect(rows.map(r => r.full)).toEqual(['Poetry', 'History', 'Mystery']);
    });

    test('a cast over a navigation column joins the navigation', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({ id: s.id, cityCode: castAsVarchar(s.library!.city, 3) }))
        .toList());

      expect(rows.map(r => r.cityCode)).toEqual(['Vie', 'Lis', 'Vie']);
      expect(fixture.lastStatement()).toContain('JOIN "expr_libraries"');
    });

    test('a cast as an UPDATE value', async () => {
      await fixture.db.shelves
        .where(s => eq(s.id, 2))
        .update(s => ({ label: castAsString(s.qty) }));

      const row = await fixture.db.shelves.where(s => eq(s.id, 2)).select(s => ({ label: s.label })).firstOrDefault();

      expect(row).toEqual({ label: '0' } as any);
      expect(fixture.lastStatement('UPDATE')).toContain('CAST("expr_shelves"."qty" AS text)');

      await fixture.db.shelves.where(s => eq(s.id, 2)).update({ label: null });
    });

    test('an invalid cast raises the database error instead of guessing', async () => {
      let error: any;
      try {
        await fixture.db.shelves.select(s => ({ n: castAsInt(s.name) })).toList();
      } catch (caught) {
        error = caught;
      }

      expect(String(error?.message)).toMatch(/invalid input syntax for type integer/);
    });
  });
});
