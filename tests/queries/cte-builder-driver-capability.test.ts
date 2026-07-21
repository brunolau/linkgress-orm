import { describe, test, expect } from '@jest/globals';
import { DbCteBuilder } from '../../src';
import type { DatabaseClient } from '../../src';
import { createTestDatabase } from '../utils/test-database';

/**
 * DbCteBuilder builds CTE SQL eagerly at definition time, so it cannot see
 * the executing client unless one is passed to its constructor. With a
 * client that cannot decode native array results (BunClient in binary
 * mode), array-producing aggregations inside CTE bodies must emit json_agg
 * instead of array_agg — otherwise the query panics Bun at execution time.
 */
describe('DbCteBuilder driver capability awareness', () => {
  const buildCteSql = (client?: DatabaseClient): string => {
    const db = createTestDatabase();
    const cteBuilder = client ? new DbCteBuilder(client) : new DbCteBuilder();

    const { cte } = cteBuilder.with('user_post_ids', db.users.select(u => ({
      userId: u.id,
      postIds: u.posts!.select(p => ({ id: p.id })).toNumberList(),
    })));

    return cte.query;
  };

  test('without a client, array aggregations keep array_agg (previous behavior)', () => {
    const sql = buildCteSql();

    expect(sql).toContain('array_agg');
    expect(sql).not.toContain('json_agg');
  });

  test('with a no-native-arrays client, array aggregations emit json_agg', () => {
    const noBinaryArraysClient = {
      supportsBinaryArrayResults: () => false,
    } as unknown as DatabaseClient;

    const sql = buildCteSql(noBinaryArraysClient);

    expect(sql).toContain('json_agg');
    expect(sql).not.toContain('array_agg');
  });
});
