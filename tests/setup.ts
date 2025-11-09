import 'dotenv/config';
import { AppDatabase } from '../debug/schema/appDatabase';
import { PgClient } from '../src';

/**
 * Global test setup - runs before all tests
 */
beforeAll(async () => {
  // Ensure we're using test database
  const dbName = process.env.DB_NAME || 'linkgress_test';
  if (!dbName.includes('test')) {
    throw new Error('Tests must use a test database! Set DB_NAME to include "test" in the name.');
  }
});

/**
 * Cleanup after all tests
 */
afterAll(async () => {
  // Give time for connections to close
  await new Promise(resolve => setTimeout(resolve, 100));
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
