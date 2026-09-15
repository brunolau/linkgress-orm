/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createInMemoryDatabase } from '../../src';
import { sqlParityCorpus, type ParityStatement } from './sql-parity-corpus';

/**
 * Differential test: every corpus case runs on real PostgreSQL and on a fresh in-memory database, and
 * each statement must produce the same outcome on both — command tag, row count, column names and
 * type OIDs, rows as the exact text PostgreSQL sends, or the same error (SQLSTATE, message, detail,
 * hint, position).
 *
 * Both sides run the same protocol: one transaction per case (always rolled back, so PostgreSQL keeps
 * no residue), deterministic session settings, a private `sql_parity` schema first on the search
 * path, and a savepoint around every statement so a failing statement does not abort the rest.
 *
 * Without a reachable PostgreSQL the tests are skipped (LINKGRESS_SQL_PARITY_REQUIRE_PG=1 fails
 * instead). In memory mode the suite's preload replaces the `pg` module; the untouched driver is
 * published as `globalThis.__linkgressRealDrivers`.
 */

const pg = (globalThis as any).__linkgressRealDrivers?.pg ?? require('pg');

/** every value as the text PostgreSQL sent */
const rawTypes = { getTypeParser: () => (value: unknown) => value };

const pgConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'linkgress_test',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  types: rawTypes,
};

const requirePg = process.env.LINKGRESS_SQL_PARITY_REQUIRE_PG === '1';

const probe = async (): Promise<string | null> => {
  const client = new pg.Client({ ...pgConfig, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('select 1');
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  } finally {
    await client.end().catch(() => undefined);
  }
};

const unreachable = await probe();

const SESSION_SETUP = [
  "SET LOCAL TIME ZONE 'UTC'",
  "SET LOCAL DateStyle = 'ISO, MDY'",
  "SET LOCAL IntervalStyle = 'postgres'",
  'SET LOCAL extra_float_digits = 1',
  'CREATE SCHEMA sql_parity',
  'SET LOCAL search_path TO sql_parity, public',
];

/** FirstNormalObjectId: OIDs from here on are assigned at run time */
const FIRST_NORMAL_OBJECT_ID = 16384;

type Outcome =
  | { command: string; rowCount: number | null; fields: [string, number | string][]; rows: unknown[][] }
  | { error: { code?: string; message: string; detail?: string; hint?: string; position?: string } };

const run = async (client: any, statement: ParityStatement): Promise<Outcome> => {
  const { sql, params } = typeof statement === 'string' ? { sql: statement, params: undefined } : statement;
  try {
    const r = await client.query({ text: sql, values: params, rowMode: 'array' });
    return {
      command: r.command,
      rowCount: r.rowCount,
      // types created by the case get OIDs from each server's counter: compared as "user-defined"
      fields: (r.fields ?? []).map((f: any) => [f.name, f.dataTypeID >= FIRST_NORMAL_OBJECT_ID ? 'user-defined' : f.dataTypeID]),
      rows: r.rows ?? [],
    };
  } catch (e: any) {
    return { error: { code: e.code, message: e.message, detail: e.detail, hint: e.hint, position: e.position } };
  }
};

const control = async (client: any, sql: string): Promise<void> => {
  await client.query(sql);
};

/** Run a case; returns one outcome per corpus statement. */
const runCase = async (client: any, statements: ParityStatement[]): Promise<Outcome[]> => {
  const outcomes: Outcome[] = [];
  await control(client, 'BEGIN');
  try {
    for (const s of SESSION_SETUP) {
      await control(client, s);
    }
    for (const statement of statements) {
      await control(client, 'SAVEPOINT parity_statement');
      const outcome = await run(client, statement);
      outcomes.push(outcome);
      await control(client, 'error' in outcome ? 'ROLLBACK TO SAVEPOINT parity_statement' : 'RELEASE SAVEPOINT parity_statement');
    }
  } finally {
    await control(client, 'ROLLBACK');
  }
  return outcomes;
};

const show = (o: Outcome | undefined): string => JSON.stringify(o, null, 1);

describe.skipIf(unreachable !== null && !requirePg)('SQL parity: PostgreSQL vs in-memory database', () => {
  let pgClient: any;

  beforeAll(async () => {
    if (unreachable !== null) {
      throw new Error(`LINKGRESS_SQL_PARITY_REQUIRE_PG=1 but PostgreSQL is unreachable: ${unreachable}`);
    }
    pgClient = new pg.Client(pgConfig);
    await pgClient.connect();
  });

  afterAll(async () => {
    await pgClient?.end();
  });

  for (const parityCase of sqlParityCorpus) {
    test(parityCase.name, async () => {
      const expected = await runCase(pgClient, parityCase.statements);

      const memory = createInMemoryDatabase({ databaseName: pgConfig.database, userName: pgConfig.user });
      const memoryClient = new pg.Client({ ...memory.pgPoolConfig(), types: rawTypes });
      await memoryClient.connect();
      let actual: Outcome[];
      try {
        actual = await runCase(memoryClient, parityCase.statements);
      } finally {
        await memoryClient.end();
      }

      const mismatches: string[] = [];
      parityCase.statements.forEach((statement, i) => {
        if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
          const text = typeof statement === 'string' ? statement : `${statement.sql}  -- params ${JSON.stringify(statement.params)}`;
          mismatches.push(`[${parityCase.name}] statement ${i + 1}: ${text}\n  postgres:  ${show(expected[i])}\n  in-memory: ${show(actual[i])}`);
        }
      });
      if (mismatches.length > 0) {
        throw new Error(`${mismatches.length} statement(s) differ from PostgreSQL\n\n${mismatches.join('\n\n')}`);
      }
      expect(actual.length).toBe(parityCase.statements.length);
    });
  }
});
