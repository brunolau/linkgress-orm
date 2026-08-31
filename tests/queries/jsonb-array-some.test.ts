import { describe, test, expect } from '@jest/globals';
import {
  SqlBuildContext,
  eq,
  ne,
  like,
  isNotNull,
  isNull,
  and,
  or,
  jsonbArraySome,
} from '../../src/query/conditions';

/**
 * Tests for jsonbArraySome — querying JSONB arrays with typed element access.
 *
 * The emitted subquery feeds `jsonb_array_elements` through a
 * `CASE WHEN jsonb_typeof(col) = 'array'` guard so a row whose JSONB column
 * holds an object or a scalar answers "no match" instead of aborting the whole
 * statement. Behaviour against real data is covered by
 * `jsonb-array-some-non-array.test.ts`; the assertions here pin the SQL shape.
 */
describe('jsonbArraySome', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  // Simulate a FieldRef for a JSONB "tags" column on a shelf table
  const fieldRef = {
    __dbColumnName: 'tags',
    __fieldName: 'tags',
    __tableAlias: 'shelf',
  } as any;

  type ShelfTag = {
    kind: string;
    meta: {
      ref: string;
      code: string;
    };
  };

  /** The guarded element source the condition builds around a column. */
  const elements = (col: string) =>
    `CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END`;

  const shelfTags = `"shelf"."tags"`;

  test('single eq condition on top-level property', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      eq(t.kind, 'fiction')
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE __elem->>'kind' = $1)`
    );
    expect(ctx.params).toEqual(['fiction']);
  });

  test('isNotNull on nested property', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      isNotNull(t.meta.ref)
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE __elem->'meta'->>'ref' IS NOT NULL)`
    );
    expect(ctx.params).toEqual([]);
  });

  test('combined and() with eq + isNotNull on nested', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      and(
        eq(t.kind, 'fiction'),
        isNotNull(t.meta.ref)
      )
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE (__elem->>'kind' = $1 AND __elem->'meta'->>'ref' IS NOT NULL))`
    );
    expect(ctx.params).toEqual(['fiction']);
  });

  test('or() condition', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      or(
        eq(t.kind, 'fiction'),
        eq(t.kind, 'poetry')
      )
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE (__elem->>'kind' = $1 OR __elem->>'kind' = $2))`
    );
    expect(ctx.params).toEqual(['fiction', 'poetry']);
  });

  test('like on nested property', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      like(t.meta.code, 'ref_%')
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE __elem->'meta'->>'code' LIKE $1)`
    );
    expect(ctx.params).toEqual(['ref_%']);
  });

  test('ne condition', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      ne(t.kind, 'archived')
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE __elem->>'kind' != $1)`
    );
    expect(ctx.params).toEqual(['archived']);
  });

  test('isNull on property', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      isNull(t.meta.code)
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(shelfTags)}) AS __elem WHERE __elem->'meta'->>'code' IS NULL)`
    );
  });

  test('works with field without table alias', () => {
    const noAliasField = {
      __dbColumnName: 'tag_data',
      __fieldName: 'tagData',
    } as any;
    const condition = jsonbArraySome<{ active: boolean }>(noAliasField, t =>
      eq(t.active, true)
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${elements(`"tag_data"`)}) AS __elem WHERE __elem->>'active' = $1)`
    );
  });

  test('guards the element source so non-array rows cannot raise', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      eq(t.kind, 'fiction')
    );
    const sql = condition.buildSql(makeContext());

    // jsonb_array_elements must never see the raw column: an object or scalar
    // row would abort the statement rather than simply not matching.
    expect(sql).toContain(`jsonb_array_elements(CASE WHEN jsonb_typeof(${shelfTags}) = 'array'`);
    expect(sql).not.toContain(`jsonb_array_elements(${shelfTags})`);
  });

  test('getFieldRefs returns the JSONB column ref', () => {
    const condition = jsonbArraySome<ShelfTag>(fieldRef, t =>
      eq(t.kind, 'fiction')
    );
    const refs = condition.getFieldRefs();
    expect(refs).toHaveLength(1);
    expect(refs[0].__dbColumnName).toBe('tags');
  });
});
