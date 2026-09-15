/**
 * Per-operation latency of the linkgress stack on a local PostgreSQL server and on the in-memory
 * database — the same `PgClient`, the same statements — plus what starting an in-memory database costs.
 *
 *   bun bench/in-memory/latency.ts
 *
 * Three targets: the server (DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD, `.env` supported), an
 * in-process in-memory database (the default of `createInMemoryDatabase()`), and one hosted in a worker
 * thread (`startInMemoryDatabaseThread()`). The server database gets the AppDatabase schema and a scratch
 * table, both dropped again at the end; its name must contain "test".
 */
import 'dotenv/config';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createInMemoryDatabase, DatabaseClient, eq, PgClient, restoreInMemoryDatabase, startInMemoryDatabaseThread } from '../../src';
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
    name: 'ORM read with a filter and ordering (users by age)',
    iterations: 500,
    run: (_client, db) => db.users
      .where(u => eq(u.isActive, true))
      .orderBy(u => u.age)
      .select(u => ({ id: u.id, name: u.username, age: u.age }))
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
  const dbName = process.env.DB_NAME || 'linkgress_test';

  if (!dbName.includes('test')) {
    throw new Error(`DB_NAME "${dbName}" must contain "test": the benchmark drops the AppDatabase schema there`);
  }

  // what a test file pays before its first statement on an in-memory database
  let start = performance.now();
  const empty = createInMemoryDatabase();
  const createMs = performance.now() - start;

  const built = new PgClient(empty.pgPoolConfig());
  start = performance.now();
  await quietly(() => new AppDatabase(built, { logQueries: false }).getSchemaManager().ensureCreated());
  const schemaMs = performance.now() - start;
  await built.end();

  start = performance.now();
  const snapshot = empty.snapshot();
  const snapshotMs = performance.now() - start;

  start = performance.now();
  const restored = restoreInMemoryDatabase(snapshot);
  const restoredClient = new PgClient(restored.pgPoolConfig());
  await restoredClient.query('SELECT 1');
  const restoreMs = performance.now() - start;
  await restoredClient.end();

  const inProcess = new PgClient(createInMemoryDatabase().pgPoolConfig());
  const inProcessMs = await measure(inProcess);
  await inProcess.end();

  const thread = startInMemoryDatabaseThread();
  const threadClient = new PgClient(thread.pgPoolConfig());
  const threadMs = await measure(threadClient);
  await threadClient.end();
  await thread.terminate();

  const server = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: dbName,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const serverMs = await measure(server);
  await server.end();

  const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms.toFixed(2));

  console.log(`\n| operation | PostgreSQL (ms) | in memory (ms) | memory / pg | in memory, thread (ms) | thread / pg |`);
  console.log(`| --- | --- | --- | --- | --- | --- |`);
  scenarios.forEach((scenario, i) => {
    console.log(`| ${scenario.name} | ${fmt(serverMs[i])} | ${fmt(inProcessMs[i])} | ${(inProcessMs[i] / serverMs[i]).toFixed(2)}× | ${fmt(threadMs[i])} | ${(threadMs[i] / serverMs[i]).toFixed(2)}× |`);
  });

  console.log(`\nIn-memory database: create ${createMs.toFixed(1)} ms, AppDatabase schema ${schemaMs.toFixed(0)} ms, ` +
    `snapshot ${snapshotMs.toFixed(1)} ms (${(snapshot.length / 1024).toFixed(0)} KB), restore to a first result ${restoreMs.toFixed(1)} ms`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
