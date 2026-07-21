import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { array } from '../../src';
import { createFreshClient } from '../utils/test-database';
import type { DatabaseClient } from '../../src';

/**
 * The `array()` custom type serializes JS arrays into PostgreSQL array
 * LITERALS ('{1,2,3}') instead of passing raw JS arrays to the driver.
 * Raw arrays only worked on pg/postgres.js (which serialize them natively);
 * Bun's SQL client sends them as JSON — a protocol error (08P01) in binary
 * mode and a brace-less "1,2,3" in text mode. A literal string binds
 * correctly on every driver (the server casts text -> array).
 */
describe('array() custom type — PG literal serialization', () => {
  const toDriver = (value: any[]) => array('integer').getType().toDriver(value) as unknown as string;

  test('serializes numbers, booleans, nulls and nested arrays', () => {
    expect(toDriver([1, 2, 3])).toBe('{1,2,3}');
    expect(toDriver([])).toBe('{}');
    expect(toDriver([1, null, 3])).toBe('{1,NULL,3}');
    expect(toDriver([true, false] as any)).toBe('{t,f}');
    expect(toDriver([[1, 2], [3, 4]] as any)).toBe('{{1,2},{3,4}}');
  });

  test('quotes and escapes string elements', () => {
    const stringToDriver = (value: any[]) => array('text').getType().toDriver(value) as unknown as string;

    expect(stringToDriver(['a', 'b'])).toBe('{"a","b"}');
    expect(stringToDriver(['with "quotes"'])).toBe('{"with \\"quotes\\""}');
    expect(stringToDriver(['back\\slash'])).toBe('{"back\\\\slash"}');
    expect(stringToDriver(['NULL literal text'])).toBe('{"NULL literal text"}');
  });

  describe('binds on the active driver', () => {
    let client: DatabaseClient;
    const table = `array_literal_probe_${process.pid}`;

    beforeAll(async () => {
      client = createFreshClient();
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (id serial PRIMARY KEY, nums int[], labels text[])`);
    });

    afterAll(async () => {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
      await client.end();
    });

    test('literal strings insert into native array columns and round-trip', async () => {
      const nums = array('integer').getType().toDriver([1, 2, 3]);
      const labels = array('text').getType().toDriver(['x', 'with "q"']);

      await client.query(`INSERT INTO ${table} (nums, labels) VALUES ($1, $2)`, [nums, labels]);

      // Read back via to_jsonb so the assertion works on EVERY driver —
      // BunClient in binary mode cannot decode native array result columns.
      const viaJson = await client.query(
        `SELECT to_jsonb(nums) AS nums, to_jsonb(labels) AS labels FROM ${table} ORDER BY id DESC LIMIT 1`
      );
      expect(viaJson.rows[0].nums).toEqual([1, 2, 3]);
      expect(viaJson.rows[0].labels).toEqual(['x', 'with "q"']);

      // Native array reads only where the driver supports them.
      if (client.supportsBinaryArrayResults()) {
        const native = await client.query(`SELECT nums, labels FROM ${table} ORDER BY id DESC LIMIT 1`);
        expect(native.rows[0].nums).toEqual([1, 2, 3]);
        expect(native.rows[0].labels).toEqual(['x', 'with "q"']);
      }
    });
  });
});
