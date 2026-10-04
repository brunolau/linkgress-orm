import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  arrayAppendUnique, arrayContainedBy, arrayContains, arrayContainsAll, arrayIsEmpty, arrayIsNotEmpty, arrayLength, arrayOverlaps,
  arrayRemove, caseWhen, cast, eq, inArray, SqlFragment,
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

    test('arrayAppendUnique appends unless the array holds the value; a NULL array is empty', () => {
      expect(build(arrayAppendUnique(slots, 4))).toEqual({
        sql: '(CASE WHEN CAST($1 AS integer) = ANY("expr_shelves"."slots") THEN "expr_shelves"."slots" '
          + 'ELSE array_append(COALESCE("expr_shelves"."slots", CAST(\'{}\' AS integer[])), CAST($2 AS integer)) END)',
        params: [4, 4],
      });
      expect(build(arrayAppendUnique(untyped, 4))).toEqual({
        sql: '(CASE WHEN $1 = ANY("expr_shelves"."raw") THEN "expr_shelves"."raw" ELSE array_append(COALESCE("expr_shelves"."raw", \'{}\'), $2) END)',
        params: [4, 4],
      });
      expect(build(arrayAppendUnique(slots, fieldRef('qty'))).sql).toBe(
        '(CASE WHEN "expr_shelves"."qty" = ANY("expr_shelves"."slots") THEN "expr_shelves"."slots" '
        + 'ELSE array_append(COALESCE("expr_shelves"."slots", CAST(\'{}\' AS integer[])), "expr_shelves"."qty") END)'
      );
    });

    test('arrayRemove removes every occurrence; null removes the NULL elements', () => {
      expect(build(arrayRemove(tags, 'poetry'))).toEqual({ sql: 'array_remove("expr_shelves"."tags", CAST($1 AS text))', params: ['poetry'] });
      expect(build(arrayRemove(untyped, 2))).toEqual({ sql: 'array_remove("expr_shelves"."raw", $1)', params: [2] });
      expect(build(arrayRemove(slots, null)).sql).toBe('array_remove("expr_shelves"."slots", CAST(NULL AS integer))');
      expect(build(arrayRemove(untyped, null)).sql).toBe('array_remove("expr_shelves"."raw", NULL)');
    });

    test('arrayAppendUnique / arrayRemove argument checks', () => {
      expect(() => arrayAppendUnique(slots, null as any)).toThrow('arrayAppendUnique(): the value is null');
      expect(() => arrayAppendUnique(slots, undefined as any)).toThrow(/operand is undefined/);
      expect(() => arrayAppendUnique(undefined as any, 1)).toThrow(/operand is undefined/);
      expect(() => arrayRemove(slots, undefined as any)).toThrow(/operand is undefined/);
      expect(arrayAppendUnique(slots, 1).getFieldRefs()).toContain(slots);
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

  /**
   * `arrayAppendUnique(column, value)` / `arrayRemove(column, value)` (1.0.31) in the SET of a criteria
   * `update()`: the change is made by the statement on each row's current array — {1,2,3}, {} and NULL here.
   */
  describe('arrayAppendUnique / arrayRemove in an UPDATE', () => {
    let fixture: ExpressionFixture;

    beforeAll(async () => {
      fixture = await createExpressionFixture();
    });

    afterAll(async () => {
      await disposeExpressionFixture(fixture);
    });

    const state = async () => (await fixture.db.shelves.select(s => ({ id: s.id, slots: s.slots, tags: s.tags })).orderBy(s => s.id).toList());

    test('append: once per row, whatever the row holds — and again changes nothing', async () => {
      const append = () => fixture.db.shelves
        .where(s => inArray(s.id, [1, 2, 3]))
        .update(s => ({ slots: arrayAppendUnique(s.slots, 9), tags: arrayAppendUnique(s.tags, 'classic') }));

      await append();

      const appended = [
        { id: 1, slots: [1, 2, 3, 9], tags: ['poetry', 'classic'] },
        { id: 2, slots: [9], tags: ['history', 'classic'] },
        // a NULL array is treated as empty
        { id: 3, slots: [9], tags: ['classic'] },
      ];

      expect(await state()).toEqual(appended as any);

      await append();

      expect(await state()).toEqual(appended as any);
    });

    test('remove: every occurrence, RETURNING the new arrays; a NULL array stays NULL', async () => {
      await fixture.db.shelves.where(s => eq(s.id, 3)).update({ slots: null, tags: null });
      await fixture.db.shelves.where(s => eq(s.id, 2)).update({ slots: [9, 4, 9] });

      const removed = await fixture.db.shelves
        .where(s => inArray(s.id, [1, 2, 3]))
        .update(s => ({ slots: arrayRemove(s.slots, 9), tags: arrayRemove(s.tags, 'classic') }))
        .returning(s => ({ id: s.id, slots: s.slots, tags: s.tags }));

      expect([...removed].sort((a, b) => a.id - b.id)).toEqual([
        { id: 1, slots: [1, 2, 3], tags: ['poetry'] },
        { id: 2, slots: [4], tags: ['history'] },
        { id: 3, slots: null, tags: null },
      ] as any);
    });

    test('both directions in ONE statement: appended to some rows, removed from the others', async () => {
      const addTo = [2, 3];

      await fixture.db.shelves
        .where(s => inArray(s.id, [1, 2, 3]))
        .update(s => ({ slots: caseWhen(inArray(s.id, addTo), arrayAppendUnique(s.slots, 2)).else(arrayRemove(s.slots, 2)) }));

      expect((await state()).map(row => row.slots)).toEqual([[1, 3], [4, 2], [2]]);
    });
  });
});
