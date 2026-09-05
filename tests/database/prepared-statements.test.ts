import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import 'dotenv/config';
import { DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, integer, PostgresClient, QueryTimeoutError, varchar } from '../../src';
import type { QueryOptions } from '../../src';
import { MutationBatch } from '../../src/query/mutation-batch';
import { AppDatabase } from '../../debug/schema/appDatabase';

/**
 * Server-side prepared statements for the `postgres` (porsager) driver.
 *
 * postgres.js hard-codes `prepare: false` on `unsafe()`, so every linkgress statement
 * used to be an UNNAMED statement: parsed, described (an extra round trip) and planned
 * again on every execution. `preparedStatements: true` names them — one server-side
 * statement per distinct text per connection, planned once and reused. It is opt-in and
 * overridable per query, because a generic plan is not always the right plan (the July
 * 2026 bench: a 19 KB analytical query got slower) and because statements whose text
 * changes per call (VALUES lists) would be cached without ever being reused.
 *
 * `pg_prepared_statements` lists the CURRENT session's named statements, so every
 * assertion runs on one pinned session: inside `db.transaction()` (postgres.js reserves
 * a connection for it) or on a reserved `client.connect()` connection. Each test builds
 * a fresh client so a previous test's statement cache cannot leak into its count.
 */

const connection = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'linkgress_test',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 2,
};

const withFreshDb = async (options: QueryOptions, fn: (db: AppDatabase, client: PostgresClient) => Promise<void>): Promise<void> => {
  const client = new PostgresClient(connection);
  const db = new AppDatabase(client, { collectionStrategy: 'cte', ...options });

  try {
    await fn(db, client);
  } finally {
    await client.end();
  }
};

/**
 * Named statements the CURRENT session holds for OUR statements. Unnamed statements never
 * appear in `pg_prepared_statements`. postgres.js keeps two kinds of its OWN named
 * statements on every connection whatever the option says — the type-catalogue bootstrap
 * (`select b.oid, b.typarray from pg_catalog.pg_type …`) and tagged transaction control
 * (`rollback` after a failed `begin()` block) — so those are filtered out.
 */
const NAMED_STATEMENTS_SQL = `SELECT count(*)::int AS n FROM pg_prepared_statements
  WHERE statement !~* 'pg_catalog\\.pg_type'
    AND statement !~* '^\\s*(begin|commit|rollback|savepoint|release)'`;

const namedStatementCount = async (ctx: DbContext): Promise<number> => {
  const result = await (ctx as unknown as { client: { query: (sql: string) => Promise<{ rows: Array<{ n: number }> }> } }).client
    .query(NAMED_STATEMENTS_SQL);

  return result.rows[0].n;
};

describe('preparedStatements (PostgresClient)', () => {
  test('preparedStatements: true names ONE server-side statement per distinct text on the session', async () => {
    await withFreshDb({ preparedStatements: true }, async (db) => {
      await db.transaction(async (ctx) => {
        await ctx.users.where(u => eq(u.id, 1)).toList();
        await ctx.users.where(u => eq(u.id, 2)).toList(); // same text, different parameter

        expect(await namedStatementCount(ctx)).toBe(1);
      });
    });
  });

  test('the default keeps every statement unnamed (today\'s behaviour)', async () => {
    await withFreshDb({}, async (db) => {
      await db.transaction(async (ctx) => {
        await ctx.users.where(u => eq(u.id, 1)).toList();
        await ctx.users.where(u => eq(u.id, 2)).toList();

        expect(await namedStatementCount(ctx)).toBe(0);
      });
    });
  });

  test('withPreparedStatements(false) opts one query out of a prepared context', async () => {
    await withFreshDb({ preparedStatements: true }, async (db) => {
      await db.transaction(async (ctx) => {
        await ctx.users.withPreparedStatements(false).where(u => eq(u.id, 1)).toList();

        expect(await namedStatementCount(ctx)).toBe(0);
      });
    });
  });

  test('withPreparedStatements(true) opts one hot query IN on an unprepared context', async () => {
    await withFreshDb({}, async (db) => {
      await db.transaction(async (ctx) => {
        await ctx.users.withPreparedStatements(true).where(u => eq(u.id, 1)).toList();
        await ctx.users.where(u => eq(u.username, 'nobody')).toList(); // context default: unnamed

        expect(await namedStatementCount(ctx)).toBe(1);
      });
    });
  });

  test('a prepared read survives a result-shape change: the driver re-prepares once', async () => {
    const client = new PostgresClient(connection);

    try {
      const conn = await client.connect(); // pinned session

      try {
        await conn.query('CREATE TEMP TABLE prep_probe (id int, name text)');
        await conn.query(`INSERT INTO prep_probe VALUES (1, 'one')`);

        const first = await conn.query('SELECT * FROM prep_probe WHERE id = $1', [1], { prepare: true });
        const second = await conn.query('SELECT * FROM prep_probe WHERE id = $1', [1], { prepare: true });
        expect(first.rows).toEqual([{ id: 1, name: 'one' }]);
        expect(second.rows).toEqual([{ id: 1, name: 'one' }]);

        const named = await conn.query(NAMED_STATEMENTS_SQL);
        expect(named.rows[0].n).toBe(1);

        // `SELECT *` over a table that just gained a column: PostgreSQL rejects the cached
        // plan ("cached plan must not change result type"); postgres.js drops it and retries.
        await conn.query('ALTER TABLE prep_probe ADD COLUMN extra int');
        const third = await conn.query('SELECT * FROM prep_probe WHERE id = $1', [1], { prepare: true });
        expect(third.rows).toEqual([{ id: 1, name: 'one', extra: null }]);
      } finally {
        conn.release();
      }
    } finally {
      await client.end();
    }
  });

  test('a per-query timeout still cancels a prepared statement', async () => {
    const client = new PostgresClient(connection);

    try {
      let caught: unknown;

      try {
        await client.query('SELECT pg_sleep(2) WHERE $1::int = 1', [1], { prepare: true, timeoutMs: 100 });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(QueryTimeoutError);
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Statements whose text embeds per-call VALUES lists would be cached once per
// variant and never reused — they stay unnamed whatever the context says.
// ---------------------------------------------------------------------------

class PrepBulkParent extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  weight!: DbColumn<number>;
}

class PrepBulkChild extends DbEntity {
  id!: DbColumn<number>;
  parentId!: DbColumn<number>;
  note!: DbColumn<string>;
}

class PrepBulkDatabase extends DbContext {
  get bulkParents(): DbEntityTable<PrepBulkParent> {
    return this.table(PrepBulkParent);
  }

  get bulkChildren(): DbEntityTable<PrepBulkChild> {
    return this.table(PrepBulkChild);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(PrepBulkParent, entity => {
      entity.toTable('prep_bulk_parent_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'prep_bulk_parent_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 60)).isRequired();
      entity.property(e => e.weight).hasType(integer('weight')).isRequired();
    });

    model.entity(PrepBulkChild, entity => {
      entity.toTable('prep_bulk_child_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'prep_bulk_child_test_id_seq' }));
      entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
      entity.property(e => e.note).hasType(varchar('note', 60)).isRequired();
    });
  }
}

describe('preparedStatements: per-call VALUES statements stay unnamed', () => {
  let client: PostgresClient;
  let bulkDb: PrepBulkDatabase;

  beforeAll(async () => {
    client = new PostgresClient(connection);
    bulkDb = new PrepBulkDatabase(client, { collectionStrategy: 'cte', preparedStatements: true });
    await client.query('DROP TABLE IF EXISTS prep_bulk_child_test CASCADE');
    await client.query('DROP TABLE IF EXISTS prep_bulk_parent_test CASCADE');
    await bulkDb.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS prep_bulk_child_test CASCADE');
    await client.query('DROP TABLE IF EXISTS prep_bulk_parent_test CASCADE');
    await client.end();
  });

  const rolledBack = async (fn: (ctx: PrepBulkDatabase) => Promise<void>): Promise<void> => {
    await bulkDb.transaction(async (ctx) => {
      await fn(ctx);
      throw new Error('rollback'); // leave no rows behind
    }).catch((error: Error) => {
      if (error.message !== 'rollback') {
        throw error;
      }
    });
  };

  test('insertBulkWithChildren', async () => {
    await rolledBack(async (ctx) => {
      await ctx.bulkParents.insertBulkWithChildren({
        rows: [
          { label: 'prep-p0', weight: 1 },
          { label: 'prep-p1', weight: 2 },
        ],
        children: {
          table: ctx.bulkChildren,
          foreignKey: 'parentId',
          rows: [
            { parentIndex: 0, row: { note: 'prep-c0' } },
            { parentIndex: 1, row: { note: 'prep-c1' } },
          ],
        },
        returning: {
          parents: p => ({ id: p.id }),
          children: c => ({ id: c.id }),
        },
      });

      expect(await namedStatementCount(ctx)).toBe(0);
    });
  });

  test('MutationBatch', async () => {
    await rolledBack(async (ctx) => {
      const batch = new MutationBatch();
      batch.addInsertBulk(ctx.bulkParents, [
        { label: 'mb-p0', weight: 1 },
        { label: 'mb-p1', weight: 2 },
      ], 'parents');
      await batch.executeBatch();

      expect(await namedStatementCount(ctx)).toBe(0);
    });
  });

  test('the same context still names an ordinary parameterised read', async () => {
    await rolledBack(async (ctx) => {
      await ctx.bulkParents.where(p => eq(p.id, 1)).toList();

      expect(await namedStatementCount(ctx)).toBe(1);
    });
  });
});
