import { PgClient } from '../src';
import { AppDatabase } from '../debug/schema/appDatabase';
import { buildPgliteSnapshot, PGLITE_SNAPSHOT_ENV } from './utils/pglite-server';

/**
 * Global setup - runs once before all test files
 * Creates the database schema so individual tests just need to truncate.
 * With LINKGRESS_TEST_DRIVER=pglite it also builds the schema snapshot that every test
 * file's in-process PGlite boots from.
 */
export default async function globalSetup() {
  // Load environment variables
  require('dotenv/config');

  // In-memory runs create the schema per test file instead (tests/setup.ts)
  if ((process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory') {
    return;
  }

  const onPglite = (process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase() === 'pglite';

  if (onPglite) {
    const vmModules =
      process.execArgv.includes('--experimental-vm-modules') ||
      (process.env.NODE_OPTIONS ?? '').includes('--experimental-vm-modules');

    if (!vmModules) {
      throw new Error(
        'LINKGRESS_TEST_DRIVER=pglite needs node --experimental-vm-modules (PGlite loads its WASM ' +
        'through dynamic import(), which jest only allows under that flag). Run `pnpm test:pglite`.'
      );
    }

    process.env[PGLITE_SNAPSHOT_ENV] = await buildPgliteSnapshot();
  }

  try {
    await createServerSchema();
  } catch (error: any) {
    // On PGlite only the files that construct PgClient / PostgresClient themselves need a
    // server: let the rest of the suite run without one.
    if (!onPglite) {
      throw error;
    }

    console.warn(`\n[globalSetup] PostgreSQL unreachable (${error.message}): files that construct PgClient/PostgresClient directly will fail.`);
  }

  // Mark schema as created for test-database.ts to know
  (global as any).__SCHEMA_CREATED__ = true;
}

async function createServerSchema(): Promise<void> {
  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'linkgress_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client, {
    logQueries: false,
    logParameters: false,
    collectionStrategy: 'cte',
  });

  try {
    // Create schema once
    await db.getSchemaManager().ensureDeleted();
    await db.getSchemaManager().ensureCreated();
  } finally {
    await client.end();
  }
}
