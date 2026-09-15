import { PgClient } from '../src';
import { AppDatabase } from '../debug/schema/appDatabase';

/**
 * Global setup - runs once before all test files
 * Creates the database schema so individual tests just need to truncate
 */
export default async function globalSetup() {
  // Load environment variables
  require('dotenv/config');

  // In-memory runs create the schema per test file instead (tests/setup.ts)
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

  // Create schema once
  await db.getSchemaManager().ensureDeleted();
  await db.getSchemaManager().ensureCreated();

  // Mark schema as created for test-database.ts to know
  (global as any).__SCHEMA_CREATED__ = true;

  await client.end();
}
