import { PgClient } from '../src';
import { AppDatabase } from '../debug/schema/appDatabase';

/**
 * Global teardown - runs once after all test files
 * Cleans up the database schema
 */
export default async function globalTeardown() {
  if ((process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory') {
    return;
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

  await db.getSchemaManager().ensureDeleted();
  await client.end();
}
