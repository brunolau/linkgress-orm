import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  arrayContainedBy, arrayContains, arrayContainsAll, arrayIsEmpty, arrayIsNotEmpty, arrayLength, arrayOverlaps,
  caseWhen, cast, eq, SqlFragment,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { createExpressionFixture, disposeExpressionFixture, ExpressionFixture, fieldRef } from '../utils/expression-fixture';

function build(fragment: SqlFragment<any>): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [] };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

describe('array-column helpers', () => {
  const tags = fieldRef('tags', { sqlType: 'text[]' });
  const slots = fieldRef('slots', { sqlType: 'integer[]' });
  const untyped = fieldRef('raw', {});

  describe('rendering', () => {
    test('arrayContains casts the value to the element type', () => {
      expect(build(arrayContains(tags, 'poetry'))).toEqual({ sql: '(CAST($1 AS text) = ANY("expr_shelves"."tags"))', params: ['poetry'] });
      expect(build(arrayContains(slots, 2))).toEqual({ sql: '(CAST($1 AS integer) = ANY("expr_shelves"."slots"))', params: [2] });
    });

    test('an untyped array column leaves the value for PostgreSQL to resolve', () => {
      expect(build(arrayContains(untyped, 2))).toEqual({ sql: '($1 = ANY("expr_shelves"."raw"))', params: [2] });
    });

    test('a column value is compared as is; NULL is NULL', () => {
      expect(build(arrayContains(slots, fieldRef('qty'))).sql).toBe('("expr_shelves"."qty" = ANY("expr_shelves"."slots"))');
      expect(build(arrayContains(slots, null as any)).sql).toBe('(NULL = ANY("expr_shelves"."slots"))');
    });

    test('list operators bind ONE array literal cast to the column type', () => {
      expect(build(arrayContainsAll(tags, ['a', 'b']))).toEqual({ sql: '("expr_shelves"."tags" @> CAST($1 AS text[]))', params: ['{"a","b"}'] });
      expect(build(arrayOverlaps(slots, [1, 2]))).toEqual({ sql: '("expr_shelves"."slots" && CAST($1 AS integer[]))', params: ['{1,2}'] });
      expect(build(arrayContainedBy(slots, [1]))).toEqual({ sql: '("expr_shelves"."slots" <@ CAST($1 AS integer[]))', params: ['{1}'] });
      expect(build(arrayOverlaps(untyped, [1]))).toEqual({ sql: '("expr_shelves"."raw" && $1)', params: ['{1}'] });
    });

    test('the literal escapes quotes, backslashes and NULL elements', () => {
      expect(build(arrayContainsAll(tags, ['say "hi"', 'back\\slash', null as any])).params)
        .toEqual(['{"say \\"hi\\"","back\\\\slash",NULL}']);
    });

    test('another array expression is compared as is', () => {
      expect(build(arrayOverlaps(tags, fieldRef('other_tags') as any)).sql).toBe('("expr_shelves"."tags" && "expr_shelves"."other_tags")');
    });

    test('length and emptiness', () => {
      expect(build(arrayLength(tags)).sql).toBe('cardinality("expr_shelves"."tags")');
      expect(build(arrayIsEmpty(tags)).sql).toBe('(cardinality("expr_shelves"."tags") = 0)');
      expect(build(arrayIsNotEmpty(tags)).sql).toBe('(cardinality("expr_shelves"."tags") > 0)');
    });

    test('argument checks', () => {
      expect(() => arrayContainsAll(tags, 'x' as any)).toThrow(/JS array/);
      expect(() => arrayLength(undefined as any)).toThrow(/operand is undefined/);
    });

    test('refs stay visible', () => {
      const navTags = fieldRef('tags', { alias: 'library', sqlType: 'text[]' });
      expect(arrayContains(navTags, 'x').getFieldRefs()).toEqual([navTags]);
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

    const names = async (condition: (s: any) => any) =>
      (await fixture.db.shelves.where(condition).select(s => ({ name: s.name })).toList()).map(r => r.name).sort();

    test('arrayContains on text[] and integer[]', async () => {
      expect(await names(s => arrayContains(s.tags, 'poetry'))).toEqual(['Poetry']);
      expect(await names(s => arrayContains(s.slots, 2))).toEqual(['Poetry']);
      expect(await names(s => arrayContains(s.slots, 99))).toEqual([]);
    });

    test('contains all / overlaps / contained by', async () => {
      expect(await names(s => arrayContainsAll(s.tags, ['poetry', 'classic']))).toEqual(['Poetry']);
      expect(await names(s => arrayContainsAll(s.tags, ['poetry', 'missing']))).toEqual([]);
      expect(await names(s => arrayContainsAll(s.tags, []))).toEqual(['History', 'Poetry']);
      expect(await names(s => arrayOverlaps(s.tags, ['history', 'x']))).toEqual(['History']);
      expect(await names(s => arrayOverlaps(s.slots, []))).toEqual([]);
      // an empty array is contained by anything; a NULL array matches nothing
      expect(await names(s => arrayContainedBy(s.slots, [1, 2, 3, 4]))).toEqual(['History', 'Poetry']);
      expect(await names(s => arrayContainedBy(s.slots, [1]))).toEqual(['History']);
    });

    test('length and emptiness', async () => {
      const rows = [...await fixture.db.shelves
        .select(s => ({ id: s.id, tagCount: arrayLength(s.tags), slotCount: arrayLength(s.slots) }))
        .toList()].sort((a, b) => a.id - b.id);

      expect(rows).toEqual([
        { id: 1, tagCount: 2, slotCount: 3 },
        { id: 2, tagCount: 1, slotCount: 0 },
        { id: 3, tagCount: null, slotCount: null },
      ] as any);

      expect(await names(s => arrayIsEmpty(s.slots))).toEqual(['History']);
      expect(await names(s => arrayIsNotEmpty(s.slots))).toEqual(['Poetry']);
    });

    test('an empty array as "unrestricted": CASE over emptiness', async () => {
      // e.g. "no slot restriction configured, or slot 2 allowed"
      const rows = await fixture.db.shelves
        .where(s => eq(caseWhen(arrayIsEmpty(s.slots), true).else(arrayContains(s.slots, 2)), true))
        .select(s => ({ name: s.name }))
        .toList();

      expect(rows.map(r => r.name).sort()).toEqual(['History', 'Poetry']);
    });

    test('a value from a typed cast works as the element', async () => {
      expect(await names(s => arrayContains(s.slots, cast<number>('3', 'integer')))).toEqual(['Poetry']);
    });
  });
});
