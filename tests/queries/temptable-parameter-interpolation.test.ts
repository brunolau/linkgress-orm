/**
 * The temp-table strategy's multi-statement path (postgres.js, Bun) runs its aggregation through the
 * simple protocol, which takes no parameters: every `$n` is written into the statement as a literal.
 * It used to replace only the collection WHERE's own parameters, with a text `replace('$1', …)` that
 * also hit the `$1` of `$10` and assumed the WHERE numbered its parameters from `$1`.
 */

import { describe, test, expect } from 'bun:test';
import { TempTableCollectionStrategy } from '../../src/query/strategies/temptable-collection-strategy';

const interpolate = TempTableCollectionStrategy.interpolateParams;

describe('temp-table parameter interpolation', () => {
  test('every placeholder, by its own number', () => {
    expect(interpolate('SELECT $2, $1', ['a', 'b'])).toBe(`SELECT 'b', 'a'`);
  });

  test('$10 is one placeholder, not $1 followed by 0', () => {
    const params = Array.from({ length: 11 }, (_, i) => i + 1);

    expect(interpolate('WHERE a = $1 AND b = $10 AND c = $11', params)).toBe('WHERE a = 1 AND b = 10 AND c = 11');
  });

  test('quoted literals and identifiers are copied verbatim', () => {
    expect(interpolate(`SELECT '$1', "$1", $1`, [7])).toBe(`SELECT '$1', "$1", 7`);
    expect(interpolate(`SELECT 'it''s $1', $1`, [7])).toBe(`SELECT 'it''s $1', 7`);
    expect(interpolate(`SELECT E'\\'$1', $1`, [7])).toBe(`SELECT E'\\'$1', 7`);
  });

  test('values are written as SQL literals', () => {
    expect(interpolate('$1, $2, $3, $4, $5, $6', [null, true, 1.5, `O'Neil`, 12n, { k: `it's` }])).toBe(`NULL, TRUE, 1.5, 'O''Neil', 12, '{"k":"it''s"}'`);
    // The array literal escapes its `"` with a backslash, so it is written as an E'' string
    expect(interpolate('$1::integer[], $2::text[]', [[1, 2], ['a', 'b"c']])).toBe(`'{1,2}'::integer[], E'{"a","b\\\\"c"}'::text[]`);
  });

  test('dollar-quoted strings are copied verbatim', () => {
    expect(interpolate('SELECT $$ $1 $$, $1', [7])).toBe('SELECT $$ $1 $$, 7');
    expect(interpolate('SELECT $body$ it\'s $1 $$ $body$, $1', [7])).toBe('SELECT $body$ it\'s $1 $$ $body$, 7');
  });

  test('comments are copied verbatim — a literal never lands inside one', () => {
    expect(interpolate('SELECT $1 -- the $1 here\n, $2', [1, 2])).toBe('SELECT 1 -- the $1 here\n, 2');
    expect(interpolate('SELECT /* $1 /* nested $1 */ still $1 */ $1', [7])).toBe('SELECT /* $1 /* nested $1 */ still $1 */ 7');
  });

  test('a `$` inside an identifier is not a placeholder', () => {
    expect(interpolate('SELECT col$1, $1', [7])).toBe('SELECT col$1, 7');
  });

  test('a string with a backslash is an E\'\' string, read the same whatever standard_conforming_strings says', () => {
    expect(interpolate('SELECT $1', [`a\\b`])).toBe(`SELECT E'a\\\\b'`);
    // The quote a backslash would escape under standard_conforming_strings = off stays doubled
    expect(interpolate('SELECT $1', [`\\'; DROP TABLE x; --`])).toBe(`SELECT E'\\\\''; DROP TABLE x; --'`);
    expect(interpolate('SELECT $1', [{ k: 'a"b' }])).toBe(`SELECT E'{"k":"a\\\\"b"}'`);
  });

  test('negative numbers are parenthesized: `a-$1` must not become the comment `a--1`', () => {
    expect(interpolate('SELECT a-$1, $2', [-1, -2n])).toBe('SELECT a-(-1), (-2)');
  });

  test('NaN and the infinities are quoted', () => {
    expect(interpolate('$1, $2, $3', [NaN, Infinity, -Infinity])).toBe(`'NaN', 'Infinity', '-Infinity'`);
  });

  test('a placeholder without a parameter is refused', () => {
    expect(() => interpolate('SELECT $2', [1])).toThrow('parameter $2');
  });

  test('a statement without parameters is left alone', () => {
    const sql = `SELECT '$1' || $$x$$`;

    expect(interpolate(sql, [])).toBe(sql);
  });
});
