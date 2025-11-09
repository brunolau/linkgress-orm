# Linkgress ORM Test Suite

Comprehensive test suite for the Linkgress ORM library using Jest and TypeScript.

## Test Structure

```
tests/
├── setup.ts                    # Global test setup and custom matchers
├── utils/
│   └── test-database.ts       # Database utilities and helpers
├── queries/
│   ├── basic-queries.test.ts  # SELECT, WHERE, ORDER BY, pagination
│   ├── grouping.test.ts       # GROUP BY, aggregations, HAVING
│   ├── joins.test.ts          # INNER/LEFT JOINs, subqueries in joins
│   └── subqueries.test.ts     # Scalar, array, table subqueries
├── mutations/
│   └── insert-update-delete.test.ts  # INSERT, UPDATE, DELETE, UPSERT
└── entities/
    └── navigation.test.ts     # Navigation properties, relationships
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run with coverage report
```bash
npm run test:coverage
```

### Run specific test file
```bash
npm test basic-queries
```

### Run specific test by pattern
```bash
npm run test:single "should group by single field"
```

## VS Code Debugging

The project includes VS Code launch configurations for debugging tests:

1. **Jest: Run All Tests** - Run all tests with debugging
2. **Jest: Run Current File** - Debug the currently open test file
3. **Jest: Watch All Tests** - Run tests in watch mode
4. **Jest: Debug Current Test** - Debug a specific test (select test name first)

To debug:
1. Open a test file
2. Press `F5` or use the Debug panel
3. Select the appropriate launch configuration
4. Set breakpoints as needed

## Database Setup

Tests use a PostgreSQL test database. Configure via environment variables in `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=linkgress_test  # Must include 'test' in name
DB_USER=postgres
DB_PASSWORD=postgres
```

**Important**: The test database is dropped and recreated for each test to ensure isolation.

## Test Utilities

### `withDatabase`
Execute a test with automatic database setup and cleanup:

```typescript
await withDatabase(async (db) => {
  // Your test code here
  const users = await db.users.toList();
  expect(users).toHaveLength(0);
});
```

### `seedTestData`
Populate database with standard test data:

```typescript
await withDatabase(async (db) => {
  const { users, posts, orders } = await seedTestData(db);

  // Use seeded data
  expect(users.alice.username).toBe('alice');
});
```

### `createTestDatabase`
Create a database instance for manual control:

```typescript
const db = createTestDatabase({ logQueries: true });
await setupDatabase(db);
// ... tests ...
await cleanupDatabase(db);
```

## Test Coverage

Current test coverage includes:

- ✅ **Basic Queries**: SELECT, WHERE, ORDER BY, LIMIT, OFFSET
- ✅ **Filtering**: eq, ne, gt, gte, lt, lte, like, and, or, not
- ✅ **Aggregations**: COUNT, SUM, MIN, MAX, AVG
- ✅ **Grouping**: GROUP BY with single/multiple keys, HAVING
- ✅ **Joins**: INNER JOIN, LEFT JOIN, with subqueries
- ✅ **Subqueries**: Scalar, array, table modes
- ✅ **Mutations**: INSERT, UPDATE, DELETE, UPSERT
- ✅ **Navigation Properties**: One-to-many, many-to-one
- ✅ **Type Safety**: Verify proper TypeScript types
- ✅ **Edge Cases**: NULL handling, empty results, cascades

## Writing New Tests

### Test Template

```typescript
import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src';

describe('Feature Name', () => {
  describe('Sub-feature', () => {
    test('should do something specific', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users
          .where(u => eq(u.isActive, true))
          .toList();

        expect(result.length).toBeGreaterThan(0);
      });
    });
  });
});
```

### Best Practices

1. **Use descriptive test names** - Clearly state what is being tested
2. **Isolate tests** - Each test should be independent
3. **Test edge cases** - NULL values, empty results, errors
4. **Verify types** - Ensure aggregates return numbers, not strings
5. **Clean up** - Use `withDatabase` for automatic cleanup
6. **Seed consistently** - Use `seedTestData` for standard data

## Custom Matchers

### `toBeWithinRange`
Check if a number is within a range:

```typescript
expect(result.avgAge).toBeWithinRange(30, 40);
```

## Troubleshooting

### Tests fail with "Cannot find module"
Run `npm install` to ensure all dependencies are installed.

### Database connection errors
Check your `.env` file has correct database credentials.

### Tests hang or timeout
Increase timeout in `jest.config.js` or individual tests:
```typescript
test('long running test', async () => {
  // ...
}, 60000); // 60 second timeout
```

### "Database name must include 'test'"
Ensure `DB_NAME` in `.env` contains the word "test" for safety.

## Contributing

When adding new features:
1. Write tests first (TDD approach)
2. Ensure tests pass: `npm test`
3. Check coverage: `npm run test:coverage`
4. Aim for >80% code coverage
5. Document complex test scenarios

## CI/CD Integration

Tests are designed to run in CI/CD environments. Example GitHub Actions:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm test
        env:
          DB_NAME: linkgress_test
          DB_USER: postgres
          DB_PASSWORD: postgres
          DB_HOST: localhost
```
