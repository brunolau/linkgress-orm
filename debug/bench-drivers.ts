/**
 * Driver micro-benchmark: BunClient vs PostgresClient (postgres.js) vs PgClient (pg),
 * all through the linkgress DatabaseClient wrappers, serial round-trips.
 *
 * Usage:
 *   bun debug/bench-drivers.ts bun|postgres|pg        (Bun runtime)
 *   npx ts-node debug/bench-drivers.ts postgres|pg    (Node runtime)
 *
 * Uses its own database (linkgress_bench) so it never interferes with the test DB.
 */
import 'dotenv/config';
import { BunClient, PgClient, PostgresClient, DatabaseClient } from '../src';

const HOST = process.env.DB_HOST || 'localhost';
const PORT = parseInt(process.env.DB_PORT || '5432');
const USER = process.env.DB_USER || 'postgres';
const PASSWORD = process.env.DB_PASSWORD || 'postgres';
const BENCH_DB = 'linkgress_bench';

const driverArg = process.argv[2];

if (driverArg !== 'bun' && driverArg !== 'bun-text' && driverArg !== 'postgres' && driverArg !== 'pg') {
  console.error('Usage: bench-drivers.ts <bun|bun-text|postgres|pg>');
  process.exit(1);
}

function createClient(database: string): DatabaseClient {
  if (driverArg === 'bun' || driverArg === 'bun-text') {
    return new BunClient({
      hostname: HOST,
      port: PORT,
      database,
      username: USER,
      password: PASSWORD,
      prepare: driverArg !== 'bun-text',
    });
  }

  if (driverArg === 'postgres') {
    return new PostgresClient({ host: HOST, port: PORT, database, username: USER, password: PASSWORD });
  }

  return new PgClient({ host: HOST, port: PORT, database, user: USER, password: PASSWORD });
}

async function ensureBenchDatabase(): Promise<void> {
  const admin = createClient('postgres');

  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [BENCH_DB]);

    if (exists.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${BENCH_DB}`);
    }
  } finally {
    await admin.end();
  }
}

async function ensureSeed(client: DatabaseClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bench_rows (
      id serial PRIMARY KEY,
      name text NOT NULL,
      price numeric(12, 2) NOT NULL,
      meta jsonb NOT NULL,
      created timestamptz NOT NULL DEFAULT now()
    )
  `);

  const count = await client.query(`SELECT count(*)::int AS n FROM bench_rows`);

  if (count.rows[0].n < 1000) {
    await client.query(`TRUNCATE bench_rows RESTART IDENTITY`);
    await client.query(`
      INSERT INTO bench_rows (name, price, meta)
      SELECT
        'row-' || i,
        (i % 500) + 0.99,
        jsonb_build_object('idx', i, 'tags', jsonb_build_array('a', 'b', 'c'), 'nested', jsonb_build_object('deep', i * 2))
      FROM generate_series(1, 1000) AS i
    `);
  }
}

interface BenchResult {
  name: string;
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

async function bench(
  name: string,
  iterations: number,
  warmup: number,
  fn: () => Promise<void>
): Promise<BenchResult> {
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];

  return { name, iterations, meanMs: mean, p50Ms: p50, p95Ms: p95 };
}

async function main(): Promise<void> {
  await ensureBenchDatabase();

  const client = createClient(BENCH_DB);
  const results: BenchResult[] = [];

  try {
    await ensureSeed(client);

    results.push(await bench('ping (SELECT 1)', 300, 30, async () => {
      await client.query('SELECT 1');
    }));

    results.push(await bench('point select by id', 300, 30, async () => {
      await client.query('SELECT * FROM bench_rows WHERE id = $1', [Math.floor(Math.random() * 1000) + 1]);
    }));

    results.push(await bench('100 rows', 200, 20, async () => {
      await client.query('SELECT * FROM bench_rows ORDER BY id LIMIT 100');
    }));

    results.push(await bench('1000 rows (all cols)', 100, 10, async () => {
      await client.query('SELECT * FROM bench_rows ORDER BY id');
    }));

    results.push(await bench('1000 jsonb values', 100, 10, async () => {
      await client.query('SELECT meta FROM bench_rows ORDER BY id');
    }));

    results.push(await bench('single insert', 200, 20, async () => {
      await client.query(
        `INSERT INTO bench_rows (name, price, meta) VALUES ($1, $2, $3)`,
        ['bench-insert', '9.99', { probe: true }]
      );
    }));

    results.push(await bench('transaction (2 stmts)', 100, 10, async () => {
      await client.transaction(async (query) => {
        await query(`INSERT INTO bench_rows (name, price, meta) VALUES ($1, $2, $3)`, ['tx-insert', '1.00', { tx: true }]);
        await query(`SELECT count(*) FROM bench_rows WHERE name = $1`, ['tx-insert']);
      });
    }));

    await client.query(`DELETE FROM bench_rows WHERE name IN ('bench-insert', 'tx-insert')`);
  } finally {
    await client.end();
  }

  const runtime = typeof (globalThis as any).Bun !== 'undefined' ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`;
  console.log(`\ndriver=${driverArg} runtime=${runtime}`);
  console.log('benchmark              | iters |  mean ms |   p50 ms |   p95 ms');
  console.log('-----------------------|-------|----------|----------|---------');

  for (const r of results) {
    console.log(
      `${r.name.padEnd(22)} | ${String(r.iterations).padStart(5)} | ${r.meanMs.toFixed(3).padStart(8)} | ${r.p50Ms.toFixed(3).padStart(8)} | ${r.p95Ms.toFixed(3).padStart(8)}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
