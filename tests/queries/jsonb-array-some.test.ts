import { describe, test, expect } from '@jest/globals';
import {
  SqlBuildContext,
  SqlFragment,
  eq,
  ne,
  like,
  isNotNull,
  isNull,
  and,
  or,
  jsonbArraySome,
  JsonbElement,
} from '../../src/query/conditions';

/**
 * Tests for jsonbArraySome — querying JSONB arrays with typed element access.
 */
describe('jsonbArraySome', () => {
  function makeContext(): SqlBuildContext {
    return { paramCounter: 1, params: [] };
  }

  // Simulate a FieldRef for integrationConfig column
  const fieldRef = {
    __dbColumnName: 'integration_config',
    __fieldName: 'integrationConfig',
    __tableAlias: 'product',
  } as any;

  type IntegrationConfig = {
    type: string;
    config: {
      villaproSystToken: string;
      apiKey: string;
    };
  };

  test('single eq condition on top-level property', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      eq(c.type, 'VILLAPRO')
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE __elem->>'type' = $1)`
    );
    expect(ctx.params).toEqual(['VILLAPRO']);
  });

  test('isNotNull on nested property', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      isNotNull(c.config.villaproSystToken)
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE __elem->'config'->>'villaproSystToken' IS NOT NULL)`
    );
    expect(ctx.params).toEqual([]);
  });

  test('combined and() with eq + isNotNull on nested', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      and(
        eq(c.type, 'VILLAPRO'),
        isNotNull(c.config.villaproSystToken)
      )
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE (__elem->>'type' = $1 AND __elem->'config'->>'villaproSystToken' IS NOT NULL))`
    );
    expect(ctx.params).toEqual(['VILLAPRO']);
  });

  test('or() condition', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      or(
        eq(c.type, 'VILLAPRO'),
        eq(c.type, 'OTHER')
      )
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE (__elem->>'type' = $1 OR __elem->>'type' = $2))`
    );
    expect(ctx.params).toEqual(['VILLAPRO', 'OTHER']);
  });

  test('like on nested property', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      like(c.config.apiKey, 'sk_%')
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE __elem->'config'->>'apiKey' LIKE $1)`
    );
    expect(ctx.params).toEqual(['sk_%']);
  });

  test('ne condition', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      ne(c.type, 'DISABLED')
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE __elem->>'type' != $1)`
    );
    expect(ctx.params).toEqual(['DISABLED']);
  });

  test('isNull on property', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      isNull(c.config.apiKey)
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("product"."integration_config") AS __elem WHERE __elem->'config'->>'apiKey' IS NULL)`
    );
  });

  test('works with field without table alias', () => {
    const noAliasField = {
      __dbColumnName: 'config_data',
      __fieldName: 'configData',
    } as any;
    const condition = jsonbArraySome<{ active: boolean }>(noAliasField, c =>
      eq(c.active, true)
    );
    const ctx = makeContext();
    const sql = condition.buildSql(ctx);
    expect(sql).toBe(
      `EXISTS (SELECT 1 FROM jsonb_array_elements("config_data") AS __elem WHERE __elem->>'active' = $1)`
    );
  });

  test('getFieldRefs returns the JSONB column ref', () => {
    const condition = jsonbArraySome<IntegrationConfig>(fieldRef, c =>
      eq(c.type, 'VILLAPRO')
    );
    const refs = condition.getFieldRefs();
    expect(refs).toHaveLength(1);
    expect(refs[0].__dbColumnName).toBe('integration_config');
  });
});
