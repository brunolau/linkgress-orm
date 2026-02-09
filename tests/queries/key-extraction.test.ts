import { describe, test, expect } from '@jest/globals';
import { SqlFragment } from '../../src/query/conditions';

/**
 * Tests for the key part extraction logic in entity-builder.
 * Verifies that constant values, composite keys, and single keys are correctly extracted.
 */
describe('Key extraction from selectors', () => {

  // We test the extraction by creating a proxy and calling the selector on it,
  // matching the logic in BaseNavigationBuilder.extractKeyPartsFromSelector
  function extractKeyParts(selector: Function): string[] {
    const propertyNames: string[] = [];
    const captureProxy = new Proxy({} as any, {
      get: (_, prop) => {
        if (typeof prop === 'string' && prop !== 'constructor') {
          propertyNames.push(prop);
        }
        return captureProxy;
      }
    });

    const result = selector(captureProxy);

    if (Array.isArray(result)) {
      const parts: string[] = [];
      let propIndex = 0;
      for (const element of result) {
        if (element === captureProxy) {
          parts.push(propertyNames[propIndex++]);
        } else if (typeof element === 'number' || typeof element === 'boolean') {
          parts.push(`__LIT:${element}`);
        } else if (typeof element === 'string') {
          parts.push(`__LIT:'${element}'`);
        } else if (element instanceof SqlFragment) {
          const ctx = { paramCounter: 1, params: [] };
          parts.push(`__LIT:${element.buildSql(ctx)}`);
        } else {
          parts.push(`__LIT:${element}`);
        }
      }
      return parts;
    }

    // Single SqlFragment case
    if (result instanceof SqlFragment) {
      const ctx = { paramCounter: 1, params: [] };
      return [`__LIT:${result.buildSql(ctx)}`];
    }

    return propertyNames;
  }

  test('single property', () => {
    const result = extractKeyParts((e: any) => e.userId);
    expect(result).toEqual(['userId']);
  });

  test('two properties (composite key)', () => {
    const result = extractKeyParts((e: any) => [e.taskId, e.sortOrder]);
    expect(result).toEqual(['taskId', 'sortOrder']);
  });

  test('property + number constant', () => {
    const result = extractKeyParts((e: any) => [e.id, 5]);
    expect(result).toEqual(['id', '__LIT:5']);
  });

  test('property + boolean constant', () => {
    const result = extractKeyParts((e: any) => [e.id, true]);
    expect(result).toEqual(['id', '__LIT:true']);
  });

  test('property + string constant', () => {
    const result = extractKeyParts((e: any) => [e.id, 'active']);
    expect(result).toEqual(['id', `__LIT:'active'`]);
  });

  test('two properties + constant in middle', () => {
    const result = extractKeyParts((e: any) => [e.id, 42, e.name]);
    expect(result).toEqual(['id', '__LIT:42', 'name']);
  });

  test('only constants', () => {
    const result = extractKeyParts((_e: any) => [1, 'test']);
    expect(result).toEqual(['__LIT:1', `__LIT:'test'`]);
  });

  test('single SqlFragment (e.g. sql`FALSE`)', () => {
    const fragment = new SqlFragment(['FALSE'], []);
    const result = extractKeyParts((_e: any) => fragment);
    expect(result).toEqual(['__LIT:FALSE']);
  });

  test('single SqlFragment with number literal', () => {
    const fragment = new SqlFragment(['5'], []);
    const result = extractKeyParts((_e: any) => fragment);
    expect(result).toEqual(['__LIT:5']);
  });

  test('property + SqlFragment in array', () => {
    const fragment = new SqlFragment(['TRUE'], []);
    const result = extractKeyParts((e: any) => [e.id, fragment]);
    expect(result).toEqual(['id', '__LIT:TRUE']);
  });

  test('SqlFragment + property in array', () => {
    const fragment = new SqlFragment(['42'], []);
    const result = extractKeyParts((e: any) => [fragment, e.name]);
    expect(result).toEqual(['__LIT:42', 'name']);
  });
});

describe('formatJoinValue helper', () => {
  // Import the helper
  const { formatJoinValue, isLiteralKeyPart } = require('../../src/query/join-utils');

  test('formats column reference', () => {
    expect(formatJoinValue('users', 'id')).toBe('"users"."id"');
  });

  test('formats literal number', () => {
    expect(formatJoinValue('users', '__LIT:5')).toBe('5');
  });

  test('formats literal boolean', () => {
    expect(formatJoinValue('users', '__LIT:true')).toBe('true');
  });

  test('formats literal string', () => {
    expect(formatJoinValue('users', `__LIT:'active'`)).toBe(`'active'`);
  });

  test('isLiteralKeyPart detects literals', () => {
    expect(isLiteralKeyPart('__LIT:5')).toBe(true);
    expect(isLiteralKeyPart('id')).toBe(false);
    expect(isLiteralKeyPart('__LIT:true')).toBe(true);
  });
});
