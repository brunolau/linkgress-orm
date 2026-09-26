import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  caseWhen, coalesce, eq, gt, isNotNull, jsonbArrayLength, jsonbBuildArray, jsonbBuildObject, jsonbContainedBy,
  jsonbContains, jsonbHasAllKeys, jsonbHasAnyKey, jsonbHasKey, jsonbPath, jsonbPathExists, jsonbPathText,
  jsonbRemoveKey, jsonbRemovePath, jsonbSet, jsonbTypeOf, literal, sql, SqlFragment, toJsonb,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('JSONB helpers', () => {
  const meta = fieldRef('meta', { sqlType: 'jsonb' });
  const qty = fieldRef('qty', { sqlType: 'integer' });

  describe('paths', () => {
    test('a plain -> path, no text round trip — parenthesized as one operand', () => {
      expect(build(jsonbPath(meta, 'dims'))).toEqual({ sql: `("expr_shelves"."meta"->'dims')`, params: [] });
      expect(build(jsonbPath(meta, 'dims', 'w'))).toEqual({ sql: `("expr_shelves"."meta"->'dims'->'w')`, params: [] });
    });

    test('the text form ends in ->>', () => {
      expect(build(jsonbPathText(meta, 'genre')).sql).toBe(`("expr_shelves"."meta"->>'genre')`);
      expect(build(jsonbPathText(meta, 'dims', 'w')).sql).toBe(`("expr_shelves"."meta"->'dims'->>'w')`);
    });

    test('integers are array indexes; negative ones count from the end', () => {
      expect(build(jsonbPath(meta, 'tags', 0)).sql).toBe(`("expr_shelves"."meta"->'tags'->0)`);
      expect(build(jsonbPathText(meta, 'tags', -1)).sql).toBe(`("expr_shelves"."meta"->'tags'->>(-1))`);
    });

    test('keys are quoted literals', () => {
      expect(build(jsonbPathText(meta, "it's")).sql).toBe(`("expr_shelves"."meta"->>'it''s')`);
      expect(build(jsonbPathText(meta, 'a\\b')).sql).toBe(`("expr_shelves"."meta"->>E'a\\\\b')`);
    });

    test('a fragment key binds as a parameter — one statement text for every key', () => {
      expect(build(jsonbPathText(meta, sql`${'sk'}`))).toEqual({ sql: `("expr_shelves"."meta"->>$1)`, params: ['sk'] });
      expect(build(jsonbPathText(meta, 'names', sql`${'en'}`))).toEqual({ sql: `("expr_shelves"."meta"->'names'->>$1)`, params: ['en'] });
      expect(build(jsonbPath(meta, sql`${'a'}`, 'b', sql`${'c'}`))).toEqual({
        sql: `("expr_shelves"."meta"->$1->'b'->$2)`,
        params: ['a', 'c'],
      });
    });

    test('a named placeholder is a key too', () => {
      const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
      expect(jsonbPathText(meta, sql.placeholder('lang')).buildSql(ctx)).toBe(`("expr_shelves"."meta"->>$1)`);
      expect(ctx.placeholders?.get('lang')).toBe(1);
    });

    test('argument checks', () => {
      expect(() => jsonbPath(meta)).toThrow(/at least one key/);
      expect(() => jsonbPath(meta, 1.5)).toThrow(/must be an integer/);
      expect(() => jsonbPath(meta, {} as any)).toThrow(/path key must be/);
      expect(() => jsonbPathText(undefined as any, 'a')).toThrow(/operand is undefined/);
    });

    test('paths read back exactly, even numeric-looking text', () => {
      expect(jsonbPathText(meta, 'zip').getMapper().fromDriver('01234')).toBe('01234');
    });
  });

  describe('mutation and predicate rendering', () => {
    test('jsonb_set with a JSON-serialized value', () => {
      expect(build(jsonbSet(meta, ['dims', 'w'], 99))).toEqual({
        sql: 'jsonb_set("expr_shelves"."meta", CAST($1 AS text[]), CAST(CAST($2 AS text) AS jsonb), true)',
        params: ['{"dims","w"}', '99'],
      });
      expect(build(jsonbSet(meta, ['genre'], 'x', { createMissing: false })).sql).toContain(', false)');
      expect(build(jsonbSet(meta, ['genre'], 'x')).params).toEqual(['{"genre"}', '"x"']);
      expect(build(jsonbSet(meta, ['list', 0], { a: [1] })).params).toEqual(['{"list","0"}', '{"a":[1]}']);
      expect(build(jsonbSet(meta, ['n'], null)).params).toEqual(['{"n"}', 'null']);
    });

    test('jsonb_set with an expression value', () => {
      expect(build(jsonbSet(meta, ['qty'], toJsonb(qty))).sql)
        .toBe('jsonb_set("expr_shelves"."meta", CAST($1 AS text[]), to_jsonb("expr_shelves"."qty"), true)');
    });

    test('removing keys and paths', () => {
      expect(build(jsonbRemoveKey(meta, 'genre'))).toEqual({ sql: '("expr_shelves"."meta" - CAST($1 AS text))', params: ['genre'] });
      expect(build(jsonbRemoveKey(meta, 'a', 'b'))).toEqual({ sql: '("expr_shelves"."meta" - CAST($1 AS text[]))', params: ['{"a","b"}'] });
      expect(build(jsonbRemovePath(meta, ['dims', 'h']))).toEqual({ sql: '("expr_shelves"."meta" #- CAST($1 AS text[]))', params: ['{"dims","h"}'] });
    });

    test('containment and key existence', () => {
      expect(build(jsonbContains(meta, { genre: 'poetry' }))).toEqual({
        sql: '("expr_shelves"."meta" @> CAST(CAST($1 AS text) AS jsonb))',
        params: ['{"genre":"poetry"}'],
      });
      expect(build(jsonbContainedBy(meta, { a: 1 })).sql).toBe('("expr_shelves"."meta" <@ CAST(CAST($1 AS text) AS jsonb))');
      expect(build(jsonbHasKey(meta, 'rating'))).toEqual({ sql: '("expr_shelves"."meta" ? CAST($1 AS text))', params: ['rating'] });
      expect(build(jsonbHasAnyKey(meta, ['a', 'b']))).toEqual({ sql: '("expr_shelves"."meta" ?| CAST($1 AS text[]))', params: ['{"a","b"}'] });
      expect(build(jsonbHasAllKeys(meta, ['a']))).toEqual({ sql: '("expr_shelves"."meta" ?& CAST($1 AS text[]))', params: ['{"a"}'] });
    });

    test('array length and type', () => {
      expect(build(jsonbArrayLength(jsonbPath(meta, 'tags'))).sql).toBe(`jsonb_array_length(("expr_shelves"."meta"->'tags'))`);
      expect(build(jsonbTypeOf(meta)).sql).toBe('jsonb_typeof("expr_shelves"."meta")');
    });

    test('building objects and arrays keeps columns live and types literals', () => {
      const built = build(jsonbBuildObject({ id: qty, label: 'x', n: 1, ok: true, nested: { deep: [qty, null] }, bigger: gt(qty, 3) }));

      expect(built.sql).toBe(
        `jsonb_build_object('id', "expr_shelves"."qty", 'label', CAST($1 AS text), 'n', CAST($2 AS integer), 'ok', CAST($3 AS boolean), `
        + `'nested', jsonb_build_object('deep', jsonb_build_array("expr_shelves"."qty", NULL)), 'bigger', ("expr_shelves"."qty" > $4))`
      );
      expect(built.params).toEqual(['x', 1, true, 3]);
      expect(build(jsonbBuildObject({ "it's": 1 })).sql).toBe(`jsonb_build_object('it''s', CAST($1 AS integer))`);
      expect(build(jsonbBuildObject({})).sql).toBe('jsonb_build_object()');
      expect(build(jsonbBuildArray()).sql).toBe('jsonb_build_array()');
    });

    test('jsonb_path_exists with and without vars / silent', () => {
      expect(build(jsonbPathExists(meta, '$.dims ? (@.w > 100)'))).toEqual({
        sql: 'jsonb_path_exists("expr_shelves"."meta", CAST($1 AS jsonpath))',
        params: ['$.dims ? (@.w > 100)'],
      });
      expect(build(jsonbPathExists(meta, '$.dims ? (@.w > $min)', { vars: { min: 100 } }))).toEqual({
        sql: 'jsonb_path_exists("expr_shelves"."meta", CAST($1 AS jsonpath), CAST(CAST($2 AS text) AS jsonb), false)',
        params: ['$.dims ? (@.w > $min)', '{"min":100}'],
      });
      expect(build(jsonbPathExists(meta, 'strict $.x', { silent: true })).sql).toContain(', CAST(CAST($2 AS text) AS jsonb), true)');
      expect(() => jsonbPathExists(meta, ' ')).toThrow(/non-empty/);
    });

    test('path arguments are validated', () => {
      expect(() => jsonbSet(meta, [], 1)).toThrow(/non-empty array/);
      expect(() => jsonbRemoveKey(meta)).toThrow(/at least one key/);
      expect(() => jsonbSet(meta, ['a'], undefined)).toThrow(/pass null for JSON null/);
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

    test('reading paths', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          dims: jsonbPath(s.meta, 'dims'),
          width: jsonbPathText(s.meta, 'dims', 'w'),
          firstTag: jsonbPathText(s.meta, 'tags', 0),
          lastTag: jsonbPath(s.meta, 'tags', -1),
          quoted: jsonbPathText(s.meta, "it's"),
          boundKey: jsonbPathText(s.meta, sql`${'genre'}`),
        }))
        .toList());

      expect(rows).toEqual([
        { id: 1, dims: { w: 120, h: 200 }, width: '120', firstTag: 'a', lastTag: 'b', quoted: 'quoted', boundKey: 'poetry' },
        { id: 2, dims: { w: 80, h: 150 }, width: '80', firstTag: null, lastTag: null, quoted: null, boundKey: 'history' },
        { id: 3, dims: null, width: null, firstTag: null, lastTag: null, quoted: null, boundKey: null },
      ] as any);
    });

    test('containment and key existence filter rows', async () => {
      const names = async (condition: (s: any) => any) =>
        (await fixture.db.shelves.where(condition).select(s => ({ name: s.name })).toList()).map(r => r.name).sort();

      expect(await names(s => jsonbContains(s.meta, { genre: 'history' }))).toEqual(['History']);
      expect(await names(s => jsonbContains(s.meta, { dims: { w: 120 } }))).toEqual(['Poetry']);
      expect(await names(s => jsonbContainedBy(jsonbPath(s.meta, 'dims'), { w: 80, h: 150, d: 1 }))).toEqual(['History']);
      expect(await names(s => jsonbHasKey(s.meta, 'rating'))).toEqual(['History']);
      expect(await names(s => jsonbHasAnyKey(s.meta, ['rating', "it's"]))).toEqual(['History', 'Poetry']);
      expect(await names(s => jsonbHasAllKeys(s.meta, ['genre', 'dims']))).toEqual(['History', 'Poetry']);
      expect(await names(s => jsonbHasAllKeys(s.meta, ['genre', 'rating']))).toEqual(['History']);
    });

    test('array length and type of', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          tagCount: jsonbArrayLength(jsonbPath(s.meta, 'tags')),
          dimsType: jsonbTypeOf(jsonbPath(s.meta, 'dims')),
          safeCount: caseWhen(eq(jsonbTypeOf(s.meta), 'array'), jsonbArrayLength(s.meta)).else(-1),
        }))
        .toList());

      expect(rows).toEqual([
        { id: 1, tagCount: 2, dimsType: 'object', safeCount: -1 },
        { id: 2, tagCount: 0, dimsType: 'object', safeCount: -1 },
        { id: 3, tagCount: null, dimsType: null, safeCount: -1 },
      ] as any);
    });

    test('building JSON from columns, navigations and conditions', async () => {
      const rows = byId(await fixture.db.shelves
        .select(s => ({
          id: s.id,
          doc: jsonbBuildObject({ name: s.name, qty: s.qty, stocked: gt(s.qty, 0), library: { city: s.library!.city }, fixed: 'v1' }),
          list: jsonbBuildArray(s.name, 1, true, null),
          asJson: toJsonb(s.qty),
        }))
        .toList());

      expect(rows[0]).toEqual({
        id: 1,
        doc: { name: 'Poetry', qty: 12, stocked: true, library: { city: 'Vienna' }, fixed: 'v1' },
        list: ['Poetry', 1, true, null],
        asJson: 12,
      } as any);
      expect(rows[2].doc).toEqual({ name: 'Mystery', qty: null, stocked: null, library: { city: 'Vienna' }, fixed: 'v1' });
      expect(fixture.lastStatement()).toContain('JOIN "expr_libraries"');
    });

    test('SQL/JSON path predicates', async () => {
      const wide = await fixture.db.shelves
        .where(s => jsonbPathExists(s.meta, '$.dims ? (@.w > $min)', { vars: { min: 100 } }))
        .select(s => ({ name: s.name }))
        .toList();
      expect(wide).toEqual([{ name: 'Poetry' }]);

      // strict + a missing key is an error: silent suppresses it (the result is NULL) instead
      // of aborting the statement; lax mode simply finds nothing
      const probed = await fixture.db.shelves
        .where(s => isNotNull(s.meta))
        .select(s => ({
          id: s.id,
          strictSilent: jsonbPathExists(s.meta, 'strict $.missing', { silent: true }),
          lax: jsonbPathExists(s.meta, 'lax $.missing.deeper'),
        }))
        .toList();
      expect(probed.every(r => r.strictSilent == null)).toBe(true);
      expect(probed.map(r => r.lax)).toEqual([false, false]);

      let error: any;
      try {
        await fixture.db.shelves
          .where(s => isNotNull(s.meta))
          .select(s => ({ hit: jsonbPathExists(s.meta, 'strict $.missing') }))
          .toList();
      } catch (caught) {
        error = caught;
      }
      expect(String(error?.message)).toMatch(/JSON object does not contain key/);
    });

    test('mutating a document in one UPDATE: set, remove key, remove path', async () => {
      await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .update(s => ({ meta: jsonbRemovePath(jsonbRemoveKey(jsonbSet(s.meta, ['dims', 'w'], 99), "it's"), ['dims', 'h']) }));

      const row = await fixture.db.shelves.where(s => eq(s.id, 1)).select(s => ({ meta: s.meta })).firstOrDefault();
      expect(row!.meta as unknown).toEqual({ genre: 'poetry', dims: { w: 99 }, tags: ['a', 'b'] });

      await fixture.db.shelves
        .where(s => eq(s.id, 1))
        .update({ meta: { genre: 'poetry', dims: { w: 120, h: 200 }, tags: ['a', 'b'], "it's": 'quoted' } });
    });

    test('jsonb_set creates a missing key; a NULL document stays NULL unless coalesced', async () => {
      await fixture.db.shelves
        .where(s => eq(s.id, 3))
        .update(s => ({ meta: jsonbSet(s.meta, ['genre'], 'mystery') }));
      const untouched = await fixture.db.shelves.where(s => eq(s.id, 3)).select(s => ({ meta: s.meta })).firstOrDefault();
      expect(untouched!.meta).toBeNull();

      await fixture.db.shelves
        .where(s => eq(s.id, 3))
        .update(s => ({ meta: jsonbSet(coalesce(s.meta, literal('{}', 'jsonb')), ['genre'], 'mystery') }));
      const created = await fixture.db.shelves.where(s => eq(s.id, 3)).select(s => ({ meta: s.meta })).firstOrDefault();
      expect(created!.meta).toEqual({ genre: 'mystery' });

      await fixture.db.shelves.where(s => eq(s.id, 3)).update({ meta: null });
    });
  });
});
