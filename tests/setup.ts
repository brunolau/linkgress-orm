import 'dotenv/config';
import { disposeSharedDatabase } from './utils/test-database';

const memoryMode = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory';

/**
 * Global test setup - runs before all tests
 */
beforeAll(async () => {
  // Ensure we're using test database
  const dbName = process.env.DB_NAME || 'linkgress_test';
  if (!dbName.includes('test')) {
    throw new Error('Tests must use a test database! Set DB_NAME to include "test" in the name.');
  }

  if (memoryMode) {
    // Each test file has its own in-memory database: create the schema globalSetup would have.
    // Loaded in an isolated module registry so the AppDatabase model (entity/enum registries)
    // does not leak into this test file, exactly like globalSetup running in its own process.
    let createSchema!: () => Promise<void>;
    jest.isolateModules(() => {
      const { AppDatabase } = require('../debug/schema/appDatabase');
      const { createFreshClient: isolatedClient } = require('./utils/test-database');
      createSchema = async () => {
        const client = isolatedClient();
        const db = new AppDatabase(client, { logQueries: false, logParameters: false, collectionStrategy: 'cte' });
        await db.getSchemaManager().ensureDeleted();
        await db.getSchemaManager().ensureCreated();
        await client.end();
      };
    });
    await createSchema();
  }
});

/**
 * Cleanup after all tests - close the shared database connection
 */
afterAll(async () => {
  await disposeSharedDatabase();
  if (memoryMode) {
    const { disposeMemoryDatabase } = require('./memory/shared-memory-db');
    await disposeMemoryDatabase();
  }
});

/**
 * Extend Jest matchers with custom assertions
 */
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () => `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
});

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
    }
  }
}
