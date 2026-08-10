import { describe, test, expect } from '@jest/globals';
import { BetweenComparison, EqComparison, GtComparison, SqlBuildContext, SqlFragment, eq } from '../../src/query/conditions';

/**
 * Tests for using SqlFragment as the VALUE (right-hand side) in comparison operators.
 * Bug: eq(installation.id, sql`(${config}->>'installationId')::int`) fell through
 * getRightSide's literal branch — the fragment OBJECT was pushed as a bound
 * parameter, so the driver serialized the fragment's SQL text as a string value:
 *   PostgresError: invalid input syntax for type integer: "case "product"..."
 * Expected: the fragment is inlined, mirroring getDbColumnName's field-side handling
 * (see sqlfragment-as-field.test.ts).
 */
describe('SqlFragment as value in comparison operators', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  // Simulate FieldRefs (what installation.id / definition.integrationConfig would be at runtime)
  const idRef = {
    __dbColumnName: 'id',
    __fieldName: 'id',
    __tableAlias: 'installation',
  } as any;

  const configRef = {
    __dbColumnName: 'config',
    __fieldName: 'integrationConfig',
    __tableAlias: 'definition',
  } as any;

  test('eq with a jsonb-extract fragment as value inlines the fragment SQL', () => {
    // Simulates: eq(installation.id, sql`(${p.integrationConfig}->>'installationId')::int`)
    const fragment = new SqlFragment(['(', "->>'installationId')::int"], [configRef]);
    const comparison = new EqComparison(idRef, fragment as any);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"installation"."id" = ("definition"."config"->>\'installationId\')::int');
    expect(ctx.params).toEqual([]);
  });

  test('eq via the factory keeps fragment params in emission order', () => {
    // Simulates: eq(installation.id, sql`CASE ${type} WHEN ${literal} THEN 1 END`)
    const fragment = new SqlFragment(['CASE ', ' WHEN ', ' THEN 1 END'], [configRef, 7]);
    const condition = eq(idRef, fragment as any);
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe('"installation"."id" = CASE "definition"."config" WHEN $1 THEN 1 END');
    expect(ctx.params).toEqual([7]);
  });

  test('gt with fragment as value inlines the fragment SQL', () => {
    const fragment = new SqlFragment(['(', ' + ', ')'], [configRef, 5]);
    const comparison = new GtComparison(idRef, fragment as any);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"installation"."id" > ("definition"."config" + $1)');
    expect(ctx.params).toEqual([5]);
  });

  test('between with fragment bounds inlines both fragments', () => {
    const minFragment = new SqlFragment(['(', ' - 1)'], [configRef]);
    const maxFragment = new SqlFragment(['(', ' + 1)'], [configRef]);
    const comparison = new BetweenComparison(idRef, minFragment as any, maxFragment as any);
    const ctx = makeContext();
    const sql = comparison.buildSql(ctx);
    expect(sql).toBe('"installation"."id" BETWEEN ("definition"."config" - 1) AND ("definition"."config" + 1)');
    expect(ctx.params).toEqual([]);
  });

  test('getFieldRefs surfaces refs embedded in a value-side fragment', () => {
    const fragment = new SqlFragment(['(', "->>'installationId')::int"], [configRef]);
    const comparison = new EqComparison(idRef, fragment as any);
    const refs = comparison.getFieldRefs();
    expect(refs).toContain(idRef);
    expect(refs).toContain(configRef);
  });

  test('getFieldRefs surfaces refs embedded in between fragment bounds', () => {
    const minFragment = new SqlFragment(['(', ' - 1)'], [configRef]);
    const comparison = new BetweenComparison(idRef, minFragment as any, 10);
    const refs = comparison.getFieldRefs();
    expect(refs).toContain(idRef);
    expect(refs).toContain(configRef);
  });
});
