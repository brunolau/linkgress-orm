import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  and, caseWhen, coalesce, concat, concatStrict, eq, gt, isNotNull, isNull, jsonbBuildObject, jsonBuildArray, jsonBuildObject,
  jsonbPathExists, jsonbPathText, jsonbValueText, literal, literalOf, mod, modulo, or, param, sql, SqlFragment, substring,
  typedNull,
} from '../../src';
import { DRIVER_VALUE_MAPPER } from '../../src/query/conditions';
import { pgIntDatetime } from '../../debug/types/int-datetime';
import { build, ClubFixture, createClubFixture, disposeClubFixture, ref } from '../utils/club-fixture';

describe('param() — an always-bound parameter', () => {
  test('renders $n, or CAST($n AS type) with a type', () => {
    expect(build(param(5))).toEqual({ sql: '$1', params: [5] });
    expect(build(param('de'))).toEqual({ sql: '$1', params: ['de'] });
    expect(build(param(5, 'integer'))).toEqual({ sql: 'CAST($1 AS integer)', params: [5] });
    expect(build(param('x', 'varchar(8)'))).toEqual({ sql: 'CAST($1 AS varchar(8))', params: ['x'] });
  });

  test('null and undefined bind as NULL — never inlined', () => {
    expect(build(param(null, 'integer'))).toEqual({ sql: 'CAST($1 AS integer)', params: [null] });
    expect(build(param(undefined, 'text'))).toEqual({ sql: 'CAST($1 AS text)', params: [null] });
    expect(build(param(null))).toEqual({ sql: '$1', params: [null] });
  });

  test('continues the parameter numbering of the enclosing statement', () => {
    expect(build(sql`${1} + ${param(2, 'integer')}`, { paramCounter: 4 })).toEqual({ sql: '$4 + CAST($5 AS integer)', params: [1, 2] });
  });

  test('inside eq() it is compared, never rewritten into IS NULL', () => {
    const points = ref('points', { sqlType: 'integer' });

    expect(build(eq(points, param(null, 'integer')))).toEqual({ sql: '"fx_members"."points" = CAST($1 AS integer)', params: [null] });
    // ONE statement text whatever the value
    expect(build(eq(points, param(null, 'integer'))).sql).toBe(build(eq(points, param(7, 'integer'))).sql);
    // …which is what eq() with a plain null does NOT give
    expect(build(eq(points, null)).sql).toBe('"fx_members"."points" IS NULL');
  });

  test('binds the value as given — no toDriver mapping of the compared column', () => {
    const joinedAt = ref('joined_at', { sqlType: 'integer', mapper: pgIntDatetime });

    expect(build(eq(joinedAt, param(5, 'integer')))).toEqual({ sql: '"fx_members"."joined_at" = CAST($1 AS integer)', params: [5] });
  });

  test('works as a JSON path key (no cast), a CASE arm and a function argument', () => {
    expect(build(jsonbPathText(ref('prefs'), param('lang')))).toEqual({ sql: '("fx_members"."prefs"->>$1)', params: ['lang'] });

    const arm = caseWhen(eq(ref('active'), literal(true)), param(1, 'integer')).else(param(2, 'integer'));
    expect(build(arm)).toEqual({ sql: 'CASE WHEN "fx_members"."active" = TRUE THEN CAST($1 AS integer) ELSE CAST($2 AS integer) END', params: [1, 2] });

    expect(build(coalesce(ref('points'), param(0, 'integer')))).toEqual({ sql: 'COALESCE("fx_members"."points", CAST($1 AS integer))', params: [0] });
  });

  test('works as a boolean operand of or()', () => {
    const scope = or(param(true, 'boolean'), isNull(ref('nickname')));
    expect(build(scope)).toEqual({ sql: '(CAST($1 AS boolean) OR "fx_members"."nickname" IS NULL)', params: [true] });
  });

  test('a JS array binds as ONE array literal for an array type', () => {
    expect(build(param([1, 2, 3], 'integer[]'))).toEqual({ sql: 'CAST($1 AS integer[])', params: ['{1,2,3}'] });
  });

  test('refuses what it cannot bind as one parameter', () => {
    expect(() => param(1, 'int); DROP TABLE t; --')).toThrow(/Invalid PostgreSQL type name/);
    expect(() => param(ref('points') as any)).toThrow(/param\(\)/);
    expect(() => param(sql`1` as any)).toThrow(/param\(\)/);
    expect(() => param({ a: 1 } as any, 'jsonb')).toThrow(/castAsJsonb/);
    expect(() => param([1, 2] as any)).toThrow(/array type/);
  });

  test('reads back through the driver-value mapper', () => {
    expect(param('007', 'text').getMapper()).toBe(DRIVER_VALUE_MAPPER);
  });
});

describe('literalOf() — a literal typed as the declared union', () => {
  test('renders exactly like literal()', () => {
    expect(build(literalOf('a'))).toEqual(build(literal('a')));
    expect(build(literalOf<'a' | 'b'>('b', 'text'))).toEqual({ sql: "CAST('b' AS text)", params: [] });
    expect(build(literalOf(42))).toEqual({ sql: '42', params: [] });
    expect(literalOf(42).getMapper()).toBe(literal(42).getMapper());
  });

  test('keeps the declared type (compile-time)', () => {
    const typed: SqlFragment<'club' | 'member'> = literalOf<'club' | 'member'>('club');
    expect(build(typed).sql).toBe("'club'");

    // @ts-expect-error — a value outside the declared union is a compile error
    const outside = literalOf<'club' | 'member'>('team');
    expect(build(outside).sql).toBe("'team'");
  });
});

describe('concatStrict() — NULL-propagating ||', () => {
  test('renders (a || b || …)', () => {
    expect(build(concatStrict(ref('name'), literal(' '), ref('nickname'))))
      .toEqual({ sql: `("fx_members"."name" || ' ' || "fx_members"."nickname")`, params: [] });
  });

  test('plain values bind typed as text; null / undefined are a typed NULL', () => {
    expect(build(concatStrict(ref('name'), '-', 5))).toEqual({
      sql: '("fx_members"."name" || CAST($1 AS text) || CAST($2 AS text))',
      params: ['-', 5],
    });
    expect(build(concatStrict(ref('name'), null, undefined))).toEqual({
      sql: '("fx_members"."name" || CAST(NULL AS text) || CAST(NULL AS text))',
      params: [],
    });
  });

  test('needs at least two operands', () => {
    expect(() => concatStrict()).toThrow(/at least two/);
    expect(() => concatStrict(ref('name'))).toThrow(/at least two/);
  });

  test('keeps the refs visible and reads through the driver-value mapper', () => {
    const city = ref('city', { alias: 'club' });
    expect(concatStrict(city, literal('/'), ref('name')).getFieldRefs()).toEqual([city, ref('name')]);
    expect(concatStrict(ref('name'), literal('!')).getMapper()).toBe(DRIVER_VALUE_MAPPER);
  });

  test('concat() is unchanged', () => {
    expect(build(concat(ref('name'), 'x'))).toEqual({ sql: 'concat("fx_members"."name", CAST($1 AS text))', params: ['x'] });
  });
});

describe('modulo() — the % operator', () => {
  test('renders (a % b), never mod()', () => {
    const fragment = modulo(ref('big', { sqlType: 'bigint' }), literal(10000000, 'bigint'));
    expect(build(fragment)).toEqual({ sql: '("fx_members"."big" % CAST(10000000 AS bigint))', params: [] });
    expect(build(fragment).sql).not.toMatch(/\bmod\(/i);
  });

  test('types plain operands like mod(): both plain → typed, else untyped', () => {
    expect(build(modulo(7, 3))).toEqual({ sql: '(CAST($1 AS integer) % CAST($2 AS integer))', params: [7, 3] });
    expect(build(modulo(ref('points'), 3))).toEqual({ sql: '("fx_members"."points" % $1)', params: [3] });
    expect(build(mod(ref('points'), 3))).toEqual({ sql: 'mod("fx_members"."points", $1)', params: [3] });
  });

  test('reads as a number and binds a compared value unchanged (no toDriver)', () => {
    const fragment = modulo(ref('points'), literal(3));
    expect(fragment.getMapper().fromDriver('4740993')).toBe(4740993);
    expect(fragment.getMapper().toDriver).toBeUndefined();
    expect(build(eq(fragment, 1))).toEqual({ sql: '("fx_members"."points" % 3) = $1', params: [1] });
  });

  test('refuses an undefined operand', () => {
    expect(() => modulo(undefined as any, 3)).toThrow(/modulo\(\)/);
    expect(() => modulo(ref('points'), undefined as any)).toThrow(/modulo\(\)/);
  });
});

describe('substring(value, pattern) — the regex form', () => {
  test('keeps the function-call syntax with an inline or a bound pattern', () => {
    expect(build(substring(ref('name'), literal('^.(.)')))).toEqual({ sql: `substring("fx_members"."name", '^.(.)')`, params: [] });
    expect(build(substring(ref('name'), '^.(.)'))).toEqual({ sql: 'substring("fx_members"."name", CAST($1 AS text))', params: ['^.(.)'] });

    const text = build(substring(ref('name'), literal('x'))).sql;
    expect(text).not.toMatch(/SUBSTRING\(.* FROM /i);
    expect(text).not.toMatch(/regexp_substr/i);
  });

  test('the positional form renders as before', () => {
    expect(build(substring(ref('name'), 2, 3))).toEqual({ sql: 'substring("fx_members"."name", CAST($1 AS integer), CAST($2 AS integer))', params: [2, 3] });
  });
});

describe('jsonbValueText() — the whole jsonb value as text', () => {
  test("renders (target #>> '{}')", () => {
    expect(build(jsonbValueText(ref('prefs')))).toEqual({ sql: `("fx_members"."prefs" #>> '{}')`, params: [] });
    expect(jsonbValueText(ref('prefs')).getMapper()).toBe(DRIVER_VALUE_MAPPER);
  });
});

describe('jsonBuildObject() / jsonBuildArray() — the json twins', () => {
  test('render like the jsonb helpers, with the json functions', () => {
    const entries = () => ({ id: ref('id'), nick: ref('nickname'), n: 5, flag: gt(ref('points'), 10), nested: { a: [1, ref('name')] } });

    const json = build(jsonBuildObject(entries()));
    const jsonb = build(jsonbBuildObject(entries()));

    expect(json.sql).toBe(jsonb.sql.replace(/jsonb_build_/g, 'json_build_'));
    expect(json.params).toEqual(jsonb.params);
    expect(json.sql).toBe(
      `json_build_object('id', "fx_members"."id", 'nick', "fx_members"."nickname", 'n', CAST($1 AS integer), 'flag', ("fx_members"."points" > $2), `
      + `'nested', json_build_object('a', json_build_array(CAST($3 AS integer), "fx_members"."name")))`
    );
  });

  test('quotes keys; empty object / array', () => {
    expect(build(jsonBuildObject({ "it's": literal(1) })).sql).toBe(`json_build_object('it''s', 1)`);
    expect(build(jsonBuildObject({})).sql).toBe('json_build_object()');
    expect(build(jsonBuildArray()).sql).toBe('json_build_array()');
    expect(build(jsonBuildArray(ref('id'), 'x'))).toEqual({ sql: 'json_build_array("fx_members"."id", CAST($1 AS text))', params: ['x'] });
  });

  test('refuses a non-object', () => {
    expect(() => jsonBuildObject([1] as any)).toThrow(/jsonBuildObject/);
    expect(() => jsonBuildObject(null as any)).toThrow(/jsonBuildObject/);
  });

  test('read through the driver-value mapper', () => {
    expect(jsonBuildObject({ a: 1 }).getMapper()).toBe(DRIVER_VALUE_MAPPER);
    expect(jsonBuildArray(1).getMapper()).toBe(DRIVER_VALUE_MAPPER);
  });
});

describe('jsonbPathExists() — fragment path and vars', () => {
  const PATH = '$.level ? (@ < $p)';

  test('a fragment path renders verbatim (inline jsonpath literal)', () => {
    expect(build(jsonbPathExists(ref('prefs'), literal(PATH, 'jsonpath'))))
      .toEqual({ sql: `jsonb_path_exists("fx_members"."prefs", CAST('${PATH}' AS jsonpath))`, params: [] });
  });

  test('fragment vars render verbatim; silent renders true / false', () => {
    expect(build(jsonbPathExists(ref('prefs'), literal(PATH, 'jsonpath'), { vars: jsonbBuildObject({ p: ref('points') }), silent: true })))
      .toEqual({ sql: `jsonb_path_exists("fx_members"."prefs", CAST('${PATH}' AS jsonpath), jsonb_build_object('p', "fx_members"."points"), true)`, params: [] });
    expect(build(jsonbPathExists(ref('prefs'), literal(PATH, 'jsonpath'), { vars: jsonbBuildObject({ p: 3 }) })))
      .toEqual({ sql: `jsonb_path_exists("fx_members"."prefs", CAST('${PATH}' AS jsonpath), jsonb_build_object('p', CAST($1 AS integer)), false)`, params: [3] });
  });

  test('a string path and plain vars keep their rendering', () => {
    expect(build(jsonbPathExists(ref('prefs'), PATH)))
      .toEqual({ sql: 'jsonb_path_exists("fx_members"."prefs", CAST($1 AS jsonpath))', params: [PATH] });
    expect(build(jsonbPathExists(ref('prefs'), PATH, { vars: { p: 3 }, silent: true })))
      .toEqual({ sql: 'jsonb_path_exists("fx_members"."prefs", CAST($1 AS jsonpath), CAST(CAST($2 AS text) AS jsonb), true)', params: [PATH, '{"p":3}'] });
  });

  test('non-plain vars — a jsonb column, a raw expression — are the operand, rendered as they stand (as before 1.0.9)', () => {
    expect(build(jsonbPathExists(ref('prefs'), PATH, { vars: ref('prefs') as any })))
      .toEqual({ sql: 'jsonb_path_exists("fx_members"."prefs", CAST($1 AS jsonpath), "fx_members"."prefs", false)', params: [PATH] });
    expect(build(jsonbPathExists(ref('prefs'), PATH, { vars: sql.raw(`'{"p": 5}'::jsonb`) as any })))
      .toEqual({ sql: `jsonb_path_exists("fx_members"."prefs", CAST($1 AS jsonpath), '{"p": 5}'::jsonb, false)`, params: [PATH] });
  });

  test('refuses plain vars holding SQL values, and an empty path', () => {
    expect(() => jsonbPathExists(ref('prefs'), PATH, { vars: { p: ref('points') } })).toThrow(/jsonbBuildObject/);
    expect(() => jsonbPathExists(ref('prefs'), PATH, { vars: { nested: [sql`1`] } })).toThrow(/jsonbBuildObject/);
    expect(() => jsonbPathExists(ref('prefs'), '  ')).toThrow(/path/);
  });
});

describe('against the database', () => {
  let fixture: ClubFixture;

  beforeAll(async () => {
    fixture = await createClubFixture();
  });

  afterAll(async () => {
    await disposeClubFixture(fixture);
  });

  const byId = <T extends { id: number }>(rows: T[]): Map<number, T> => new Map(rows.map(r => [r.id, r]));

  test('param(): a NULL parameter compares, a value matches', async () => {
    const db = fixture.db;
    const none = await db.members.where(m => eq(m.points, param(null, 'integer'))).select(m => ({ id: m.id })).toList();
    const tens = await db.members.where(m => eq(m.points, param(10, 'integer'))).select(m => ({ id: m.id })).toList();
    const nulls = await db.members.where(m => eq(m.points, null)).select(m => ({ id: m.id })).toList();

    expect(none).toEqual([]);
    expect(tens.map(r => r.id).sort()).toEqual([1, 3]);
    expect(nulls.map(r => r.id)).toEqual([4]);
  });

  test('param(): a bound JSON key, and the value read back as the driver delivers it', async () => {
    const rows = await fixture.db.members
      .select(m => ({ id: m.id, lang: jsonbPathText(m.prefs, param('lang')), bound: param('007', 'text'), nothing: param(null, 'integer') }))
      .toList();
    const read = byId(rows);

    expect(read.get(1)!.lang).toBe('en');
    expect(read.get(2)!.lang).toBe('de');
    expect(read.get(3)!.lang).toBeNull();
    expect(read.get(1)!.bound).toBe('007');
    expect(read.get(1)!.nothing).toBeNull();
    expect(fixture.lastStatement()).toContain('"fx_members"."prefs"->>$1');
  });

  test('literalOf(): UNION legs share the declared union type', async () => {
    const rows = await fixture.db.clubs
      .where(c => eq(c.id, 1))
      .select(c => ({ kind: literalOf<'club' | 'member'>('club'), name: c.name }))
      .unionAll(fixture.db.members.where(m => eq(m.id, 4)).select(m => ({ kind: literalOf<'club' | 'member'>('member'), name: m.name })))
      .toList();

    const kinds: Array<'club' | 'member'> = rows.map(r => r.kind);
    expect(kinds.sort()).toEqual(['club', 'member']);
  });

  test('concatStrict(): NULL when any operand is NULL; digits-only text stays text', async () => {
    const rows = await fixture.db.members
      .select(m => ({ id: m.id, label: concatStrict(m.name, literal(' '), m.nickname), nick: concatStrict(literal(''), m.nickname) }))
      .toList();
    const read = byId(rows);

    expect(read.get(1)!.label).toBe('ann A');
    expect(read.get(2)!.label).toBeNull();
    expect(read.get(4)!.nick).toBe('007');
  });

  test('concatStrict(): joins the navigation it reads; works in WHERE and inside a collection item', async () => {
    const db = fixture.db;
    const rows = await db.members
      .where(m => eq(concatStrict(m.club!.name, literal('/'), m.name), 'North/bob'))
      .select(m => ({ id: m.id, path: concatStrict(m.club!.city, literal(':'), m.name) }))
      .toList();

    expect(rows).toEqual([{ id: 2, path: 'Oslo:bob' }]);
    expect(fixture.lastStatement()).toMatch(/JOIN "fx_clubs" AS "club"/);

    const club = await db.clubs
      .where(c => eq(c.id, 1))
      .select(c => ({ tags: c.members!.orderBy(m => m.id).select(m => ({ tag: concatStrict(m.name, literal(':'), m.nickname) })).toList() }))
      .firstOrDefault();

    expect(club).toEqual({ tags: [{ tag: 'ann:A' }, { tag: null }, { tag: 'cyd:C' }] });
  });

  test('modulo(): seeks, reads a number', async () => {
    const db = fixture.db;
    const rows = await db.members
      .where(m => eq(modulo(m.points, literal(3)), 1))
      .select(m => ({ id: m.id, suffix: modulo(m.big, literal(10000000, 'bigint')) }))
      .toList();

    const read = byId(rows);
    expect([...read.keys()].sort()).toEqual([1, 3]);
    expect(read.get(1)!.suffix).toBe(4740993);
    expect(read.get(3)!.suffix).toBeNull();
  });

  test('substring(value, pattern): the first capture group, NULL without a match', async () => {
    const rows = await fixture.db.members
      .select(m => ({ id: m.id, second: substring(m.name, literal('^.(.)')), none: substring(m.name, '^z(.)') }))
      .toList();
    const read = byId(rows);

    expect(read.get(1)!.second).toBe('n');
    expect(read.get(2)!.second).toBe('o');
    expect(read.get(1)!.none).toBeNull();
  });

  test('jsonbValueText(): strings unquoted, scalars and documents as text, SQL / JSON null as null', async () => {
    const row = await fixture.db.members
      .where(m => eq(m.id, 3))
      .select(m => ({
        str: jsonbValueText(literal('"x"', 'jsonb')),
        num: jsonbValueText(literal('12', 'jsonb')),
        bool: jsonbValueText(literal('true', 'jsonb')),
        obj: jsonbValueText(literal('{"a":1}', 'jsonb')),
        arr: jsonbValueText(literal('[1,"b"]', 'jsonb')),
        jsonNull: jsonbValueText(literal('null', 'jsonb')),
        sqlNull: jsonbValueText(typedNull('jsonb')),
        column: jsonbValueText(m.prefs),
      }))
      .firstOrDefault();

    expect(row).toEqual({
      str: 'x',
      num: '12',
      bool: 'true',
      obj: '{"a": 1}',
      arr: '[1, "b"]',
      jsonNull: null,
      sqlNull: null,
      column: null,
    });
  });

  test('jsonBuildObject(): json keeps the written key order, jsonb sorts; values as delivered', async () => {
    const row = await fixture.db.members
      .where(m => eq(m.id, 4))
      .select(m => ({
        json: jsonBuildObject({ z: m.nickname, a: m.points, nested: { flag: isNotNull(m.score) }, list: jsonBuildArray(m.id, 'x') }),
        jsonb: jsonbBuildObject({ z: m.nickname, a: m.points }),
      }))
      .firstOrDefault();

    expect(row!.json).toEqual({ z: '007', a: null, nested: { flag: true }, list: [4, 'x'] });
    expect(Object.keys(row!.json as object)).toEqual(['z', 'a', 'nested', 'list']);
    expect(Object.keys(row!.jsonb as object)).toEqual(['a', 'z']);
  });

  test('jsonbPathExists(): an inline jsonpath with per-row vars', async () => {
    const rows = await fixture.db.members
      .where(m => jsonbPathExists(m.prefs, literal('$.level ? (@ < $p)', 'jsonpath'), { vars: jsonbBuildObject({ p: m.points }), silent: true }))
      .select(m => ({ id: m.id }))
      .toList();

    expect(rows).toEqual([{ id: 1 }]);
    expect(fixture.lastStatement()).toContain("CAST('$.level ? (@ < $p)' AS jsonpath)");

    const english = await fixture.db.members
      .where(m => and(isNotNull(m.prefs), jsonbPathExists(m.prefs, literal('$.lang ? (@ == $l)', 'jsonpath'), { vars: jsonbBuildObject({ l: literal('en') }) })))
      .select(m => ({ id: m.id }))
      .toList();

    expect(english.map(r => r.id).sort()).toEqual([1, 4]);
  });
});
