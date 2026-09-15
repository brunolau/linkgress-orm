/**
 * The global setup / teardown of a test run (tests/run.ts), each action in its own process:
 *
 *   bun tests/global-schema.ts create|drop               the test schema in the PostgreSQL test database
 *                                                        (test files only truncate the tables); `create`
 *                                                        first installs LINKGRESS_TEST_EXTENSIONS (comma list)
 *   bun tests/global-schema.ts pglite-snapshot <file>     the schema built on a PGlite, its data directory
 *                                                        dumped to <file> for every file's PGlite to boot from
 */
import 'dotenv/config';
import { renameSync } from 'fs';
import { AppDatabase } from '../debug/schema/appDatabase';
import { PgClient } from '../src';
import { buildPgliteSnapshot } from './utils/pglite-server';

const action = process.argv[2];

if (action === 'pglite-snapshot') {
  const target = process.argv[3];

  if (!target) {
    console.error('usage: bun tests/global-schema.ts pglite-snapshot <file>');
    process.exit(2);
  }

  renameSync(await buildPgliteSnapshot(), target);
  process.exit(0);
}

if (action !== 'create' && action !== 'drop') {
  console.error('usage: bun tests/global-schema.ts create|drop|pglite-snapshot <file>');
  process.exit(2);
}

const client = new PgClient({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'linkgress_test',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

try {
  const db = new AppDatabase(client, { logQueries: false, logParameters: false, collectionStrategy: 'cte' });

  // LINKGRESS_TEST_EXTENSIONS=pg_trgm,unaccent: extensions a fresh (worker template) database needs up front
  if (action === 'create') {
    for (const extension of (process.env.LINKGRESS_TEST_EXTENSIONS ?? '').split(',').filter(Boolean)) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${extension.replace(/"/g, '')}"`);
    }
  }

  await db.getSchemaManager().ensureDeleted();

  if (action === 'create') {
    await db.getSchemaManager().ensureCreated();
  }
} finally {
  await client.end();
}
