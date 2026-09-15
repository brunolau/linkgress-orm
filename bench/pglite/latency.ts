/**
 * Per-operation latency of the linkgress stack on pg (a local server) and on PGlite (in-process),
 * outside jest, plus what booting a PGlite costs — the parts the suite's per-file times are made of.
 *
 *   DB_NAME=<a database the script may own> node -r ts-node/register/transpile-only bench/pglite/latency.ts
 *
 * The server database gets the AppDatabase schema and a scratch table, both dropped again at the end.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { PgClient, PGliteClient, DatabaseClient } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { seedTestData, setupDatabase } from '../../tests/utils/test-database';

interface Scenario {
  name: string;
  iterations: number;
  /** Statements per iteration, when the figure should be per statement */
  per?: number;
  run: (client: DatabaseClient, db: AppDatabase, i: number) => Promise<unknown>;
}

const scenarios: Scenario[] = [
  {
    name: 'SELECT $1 (a trivial statement)',
    iterations: 2000,
    run: client => client.query('SELECT $1::int AS x', [1]),
  },
  {
    name: 'INSERT one row, autocommit',
    iterations: 1000,
    run: (client, _db, i) => client.query('INSERT INTO bench_rows (n) VALUES ($1)', [i]),
  },
  {
    name: 'INSERT inside a 100-row transaction (per row)',
    iterations: 20,
    per: 100,
    run: client => client.transaction(async query => {
      for (let k = 0; k < 100; k++) {
        await query('INSERT INTO bench_rows (n) VALUES ($1)', [k]);
      }
    }),
  },
  {
    name: 'per-test reset: TRUNCATE 22 tables + seedTestData',
    iterations: 30,
    run: async (_client, db) => {
      await setupDatabase(db);
      await seedTestData(db);
    },
  },
  {
    name: 'ORM read: users with their posts (CTE json_agg)',
    iterations: 500,
    run: (_client, db) => db.users
      .select(u => ({
        id: u.id,
        name: u.username,
        posts: u.posts!.select(p => ({ title: p.title, views: p.views })).toList('posts'),
      }))
      .toList(),
  },
  {
    name: 'DDL: CREATE TABLE + CREATE INDEX + DROP TABLE',
    iterations: 50,
    run: async client => {
      await client.query('CREATE TABLE bench_ddl (id serial PRIMARY KEY, a text, b int)');
      await client.query('CREATE INDEX bench_ddl_b ON bench_ddl (b)');
      await client.query('DROP TABLE bench_ddl');
    },
  },
];

/** The schema manager logs every index it creates; keep the report readable. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;

  try {
    return await work();
  } finally {
    console.log = log;
  }
}

async function measure(client: DatabaseClient): Promise<number[]> {
  const db = new AppDatabase(client, { logQueries: false, collectionStrategy: 'cte' });
  const schema = db.getSchemaManager();

  await quietly(async () => {
    await schema.ensureDeleted();
    await schema.ensureCreated();
  });
  await client.query('DROP TABLE IF EXISTS bench_rows');
  await client.query('CREATE TABLE bench_rows (id serial PRIMARY KEY, n int)');
  await seedTestData(db);

  const msPerOperation: number[] = [];

  for (const scenario of scenarios) {
    for (let i = 0; i < Math.min(10, scenario.iterations); i++) {
      await scenario.run(client, db, i);
    }

    const start = performance.now();

    for (let i = 0; i < scenario.iterations; i++) {
      await scenario.run(client, db, i);
    }

    msPerOperation.push((performance.now() - start) / scenario.iterations / (scenario.per ?? 1));
  }

  await client.query('DROP TABLE bench_rows');
  await quietly(() => schema.ensureDeleted());

  return msPerOperation;
}

async function main(): Promise<void> {
  // What a jest test file pays before its first statement: PGlite's module, its WASM, a boot.
  let start = performance.now();
  const pgliteModule = require('@electric-sql/pglite');
  const requireMs = performance.now() - start;

  const wasm = readFileSync(join(dirname(require.resolve('@electric-sql/pglite')), 'pglite.wasm'));
  start = performance.now();
  await WebAssembly.compile(wasm);
  const compileMs = performance.now() - start;

  const pglite = new PGliteClient();
  const pgliteMs = await measure(pglite);

  const snapshot = await quietly(async () => {
    const source = new PGliteClient();
    await new AppDatabase(source, { logQueries: false }).getSchemaManager().ensureCreated();
    const tarball = await source.getPGlite().dumpDataDir('none');
    await source.end();
    return tarball;
  });

  start = performance.now();
  const booted = new PGliteClient({ loadDataDir: snapshot });
  await booted.query('SELECT 1');
  const snapshotBootMs = performance.now() - start;
  await booted.end();
  await pglite.end();

  const server = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const pgMs = await measure(server);
  await server.end();

  const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms.toFixed(2));

  console.log(`\n| operation | pg (ms) | PGlite (ms) | PGlite / pg |`);
  console.log(`| --- | --- | --- | --- |`);
  scenarios.forEach((scenario, i) => {
    console.log(`| ${scenario.name} | ${fmt(pgMs[i])} | ${fmt(pgliteMs[i])} | ${(pgliteMs[i] / pgMs[i]).toFixed(2)}× |`);
  });

  console.log(`\nPGlite ${pgliteModule.PGlite ? 'module' : '(unexpected module shape)'} load: ${requireMs.toFixed(0)} ms, ` +
    `WASM compile (${(wasm.length / 1024 / 1024).toFixed(1)} MB): ${compileMs.toFixed(0)} ms, ` +
    `boot from the schema snapshot (${(snapshot.size / 1024 / 1024).toFixed(0)} MB) to a first result: ${snapshotBootMs.toFixed(0)} ms`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
