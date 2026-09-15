import { rmSync } from 'fs';
import { PgClient } from '../src';
import { AppDatabase } from '../debug/schema/appDatabase';
import { PGLITE_SNAPSHOT_ENV } from './utils/pglite-server';

/**
 * Global teardown - runs once after all test files
 * Cleans up the database schema, and the PGlite schema snapshot when one was built
 */
export default async function globalTeardown() {
  if ((process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory') {
    return;
  }

  const onPglite = (process.env.LINKGRESS_TEST_DRIVER || 'pg').toLowerCase() === 'pglite';
  const snapshot = process.env[PGLITE_SNAPSHOT_ENV];

  if (snapshot) {
    rmSync(snapshot, { force: true });
  }

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
    await db.getSchemaManager().ensureDeleted();
  } catch (error) {
    // PGlite runs may have no server at all (see globalSetup)
    if (!onPglite) {
      throw error;
    }
  } finally {
    await client.end();
  }
}
