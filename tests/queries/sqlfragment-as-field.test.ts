import { describe, test, expect } from '@jest/globals';
import { coalesce, gte, SqlFragment, SqlBuildContext, LikeComparison, ILikeComparison, EqComparison, GtComparison, LtComparison, InComparison } from '../../src/query/conditions';

/**
 * Tests for using SqlFragment as the field (left-hand side) in comparison operators.
 * Bug: like(sql`${field}::varchar(255)`, '%value%') generates incorrect SQL
 * with double-quoted fragment: ""table"."column"::varchar(255)" LIKE $1
 * Expected: "table"."column"::varchar(255) LIKE $1
 */
describe('SqlFragment as field in comparison operators', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  // Simulate a FieldRef (what p.internalId would be at runtime)
  const fieldRef = {
    __dbColumnName: 'internal_id',
    __fieldName: 'internalId',
    __tableAlias: 'product',
  } as any;

  test('like with sql`${field}::varchar(255)` should not double-quote the fragment', () => {
    // This simulates: like(sql`${filterProp}::varchar(255)`, '%value%')
    const fragment = new SqlFragment(['', '::varchar(255)'], [fieldRef]);
    const comparison = new LikeComparison(fragment as any, '%test%');
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    // Should be: "product"."internal_id"::varchar(255) LIKE $1
    // NOT: ""product"."internal_id"::varchar(255)" LIKE $1
    expect(sql).toBe('"product"."internal_id"::varchar(255) LIKE $1');
    expect(ctx.params).toEqual(['%test%']);
  });

  test('ilike with sql`${field}::varchar(255)` should not double-quote the fragment', () => {
    const fragment = new SqlFragment(['', '::varchar(255)'], [fieldRef]);
    const comparison = new ILikeComparison(fragment as any, '%test%');
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"product"."internal_id"::varchar(255) ILIKE $1');
    expect(ctx.params).toEqual(['%test%']);
  });

  test('eq with sql`${field}::text` should produce correct SQL', () => {
    const fragment = new SqlFragment(['', '::text'], [fieldRef]);
    const comparison = new EqComparison(fragment as any, 'hello');
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"product"."internal_id"::text = $1');
    expect(ctx.params).toEqual(['hello']);
  });

  test('gt with sql`${field}::integer` should produce correct SQL', () => {
    const fragment = new SqlFragment(['', '::integer'], [fieldRef]);
    const comparison = new GtComparison(fragment as any, 5);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"product"."internal_id"::integer > $1');
    expect(ctx.params).toEqual([5]);
  });

  test('like with plain sql fragment (no field ref) should work', () => {
    // sql`LOWER(some_col)` — no interpolated field ref
    const fragment = new SqlFragment(['LOWER(some_col)'], []);
    const comparison = new LikeComparison(fragment as any, '%test%');
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('LOWER(some_col) LIKE $1');
    expect(ctx.params).toEqual(['%test%']);
  });

  test('in with sql`${field}::text` should produce correct SQL', () => {
    const fragment = new SqlFragment(['', '::text'], [fieldRef]);
    const comparison = new InComparison(fragment as any, ['a', 'b']);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"product"."internal_id"::text IN ($1, $2)');
    expect(ctx.params).toEqual(['a', 'b']);
  });

  test('coalesce with mapped fields should apply toDriver to comparison values', () => {
    const mapper = {
      toDriver: (value: Date) => value.getTime(),
      fromDriver: (value: number) => new Date(value),
    };
    const mappedStart = {
      __dbColumnName: 'start_at',
      __fieldName: 'startAt',
      __tableAlias: 'product',
      __mapper: mapper,
    } as any;
    const mappedEnd = {
      __dbColumnName: 'end_at',
      __fieldName: 'endAt',
      __tableAlias: 'product',
      __mapper: mapper,
    } as any;
    const value = new Date('2026-07-07T00:00:00.000Z');
    const comparison = gte(coalesce(mappedEnd, mappedStart), value);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);

    expect(sql).toBe('COALESCE("product"."end_at", "product"."start_at") >= $1');
    expect(ctx.params).toEqual([value.getTime()]);
  });

  test('coalesce with mapped field should apply toDriver to literal fallback values', () => {
    const mapper = {
      toDriver: (value: Date) => value.getTime(),
      fromDriver: (value: number) => new Date(value),
    };
    const mappedEnd = {
      __dbColumnName: 'end_at',
      __fieldName: 'endAt',
      __tableAlias: 'product',
      __mapper: mapper,
    } as any;
    const fallback = new Date('2026-07-07T00:00:00.000Z');
    const fragment = coalesce(mappedEnd, fallback);
    const ctx = makeContext();
    const sql = fragment.buildSql(ctx);

    expect(sql).toBe('COALESCE("product"."end_at", $1)');
    expect(ctx.params).toEqual([fallback.getTime()]);
  });
});
