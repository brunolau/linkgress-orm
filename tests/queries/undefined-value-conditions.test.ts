import { describe, test, expect } from '@jest/globals';
import { EqComparison, NeComparison, GtComparison, LtComparison, GteComparison, LteComparison, LikeComparison, IsNullComparison, IsNotNullComparison, SqlBuildContext, and, eq, ne } from '../../src/query/conditions';

/**
 * Tests for comparison operators with undefined values.
 * Bug: eq(field, undefined) generates invalid SQL like `"user_id" =` with no right side.
 * Expected: eq/ne treat undefined as null → IS NULL / IS NOT NULL.
 * Other binary operators throw an error for undefined values.
 */
describe('comparison operators with undefined values', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  const field = { __dbColumnName: 'user_id', __fieldName: 'userId' } as any;

  test('eq with undefined value should produce IS NULL', () => {
    const comparison = new EqComparison(field, undefined);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" IS NULL');
  });

  test('ne with undefined value should produce IS NOT NULL', () => {
    const comparison = new NeComparison(field, undefined);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" IS NOT NULL');
  });

  test('eq with null value should produce IS NULL', () => {
    const comparison = new EqComparison(field, null);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" IS NULL');
  });

  test('ne with null value should produce IS NOT NULL', () => {
    const comparison = new NeComparison(field, null);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" IS NOT NULL');
  });

  test('eq with actual value should still produce parameterized comparison', () => {
    const comparison = new EqComparison(field, 42);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" = $1');
    expect(ctx.params).toEqual([42]);
  });

  test('ne with actual value should still produce parameterized comparison', () => {
    const comparison = new NeComparison(field, 42);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" != $1');
    expect(ctx.params).toEqual([42]);
  });

  test('eq(field, undefined) inside and() should not generate broken SQL', () => {
    const field2 = { __dbColumnName: 'is_current', __fieldName: 'isCurrent' } as any;
    const condition = and(eq(field, undefined), eq(field2, true));
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    // Should be: ("user_id" IS NULL AND "is_current" = $1)
    expect(sql).toContain('IS NULL');
    expect(sql).not.toMatch(/"user_id" =\s+AND/);
  });

  test('gt with undefined value should throw', () => {
    const comparison = new GtComparison(field, undefined);
    const ctx = makeContext();
    expect(() => comparison.buildSql(ctx)).toThrow(/Cannot use > operator with undefined value/);
  });

  test('lt with undefined value should throw', () => {
    const comparison = new LtComparison(field, undefined);
    const ctx = makeContext();
    expect(() => comparison.buildSql(ctx)).toThrow(/Cannot use < operator with undefined value/);
  });

  test('gte with undefined value should throw', () => {
    const comparison = new GteComparison(field, undefined);
    const ctx = makeContext();
    expect(() => comparison.buildSql(ctx)).toThrow(/Cannot use >= operator with undefined value/);
  });

  test('lte with undefined value should throw', () => {
    const comparison = new LteComparison(field, undefined);
    const ctx = makeContext();
    expect(() => comparison.buildSql(ctx)).toThrow(/Cannot use <= operator with undefined value/);
  });

  test('like with undefined value should throw', () => {
    const comparison = new LikeComparison(field, undefined as any);
    const ctx = makeContext();
    expect(() => comparison.buildSql(ctx)).toThrow(/Cannot use LIKE operator with undefined value/);
  });

  test('isNull still works correctly (legitimate unary operator)', () => {
    const comparison = new IsNullComparison(field);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" IS NULL');
  });

  test('isNotNull still works correctly (legitimate unary operator)', () => {
    const comparison = new IsNotNullComparison(field);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"user_id" IS NOT NULL');
  });
});
