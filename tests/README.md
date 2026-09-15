# Linkgress ORM Test Suite

The Linkgress test suite runs on [Bun](https://bun.sh)'s test runner (`bun:test`). It runs against a real
PostgreSQL database and, unchanged, against the Linkgress in-memory database — and it can check that both
give identical results.

## Test Structure

```
tests/
├── run.ts                      # Test runner: one `bun test` process per file, PostgreSQL / memory / parity
├── setup.ts                    # Preload (bunfig.toml): global hooks, custom matchers, memory-mode driver swap
├── global-schema.ts            # Creates / drops the test schema of a PostgreSQL run
├── tsconfig.json               # Type-checking of the tests (`npm run type-check:tests`)
├── utils/
│   ├── test-database.ts        # Database utilities and helpers
│   └── expect-rejects.ts       # expectToReject() — rejection assertions
├── memory/
│   ├── in-memory-database.test.ts  # In-memory database API
│   ├── sql-parity.test.ts          # Same SQL on PostgreSQL and in memory, results compared
│   ├── sql-parity-corpus.ts        # The statements it compares
│   ├── create-schema-snapshot.ts   # Schema snapshot every memory-mode file starts from
│   └── shared-memory-db.ts, pg-memory.ts, postgres-memory.ts  # memory-mode plumbing
├── queries/  mutations/  entities/  schema/  migration/  database/
```

## Running Tests

```bash
npm test                 # all files against PostgreSQL
npm run test:memory      # all files against the in-memory database (no PostgreSQL needed*)
npm run test:parity      # both, then fail unless every file and test has the same outcome
npm run test:pglite      # all files on PGlite (PostgreSQL in WASM, in-process) through PGliteClient
```

\* `tests/memory/sql-parity.test.ts` compares with PostgreSQL and is skipped when none is reachable.

Every test file runs in its own `bun test` process, so each file has a fresh module registry (entity
metadata, caches, shared clients) and, in memory mode, its own database. A PostgreSQL run creates the
test schema once before the files run and drops it afterwards; the files run one after another because
they share the database. A memory run builds the schema once into a snapshot every file's database is
restored from, and runs files in parallel. A PGlite run (`--driver pglite`) does the same with a PGlite
data-directory dump (every file boots its own PGlite); the server is then only needed by the files that
construct `PgClient` / `PostgresClient` themselves, and the run only warns when it is unreachable.

### Runner options (`bun tests/run.ts [paths] [options]`)

```bash
bun tests/run.ts tests/queries                  # a directory (or files, or path substrings)
bun tests/run.ts grouping --memory              # files whose path contains "grouping", in memory
bun run test:single "should group by single field"   # --test-name-pattern
bun tests/run.ts --memory --thread              # memory databases hosted in worker threads
bun tests/run.ts --driver postgres              # the suite on PostgresClient (also: bun, pglite, pg — default)
bun tests/run.ts --memory --jobs 4              # parallel files in memory / PGlite runs (default: half the cores)
bun tests/run.ts --json results.json            # per-test outcomes of the run(s)
npm run test:coverage                           # lcov for all files, merged into coverage/lcov.info
npm run test:verbose                            # print every file's output, not only failing ones
```

### A single file directly

```bash
bun test tests/queries/grouping.test.ts --timeout 30000
LINKGRESS_TEST_DB=memory bun test tests/queries/grouping.test.ts --timeout 30000
bun run test:watch tests/queries/grouping.test.ts
```

The preload (`tests/setup.ts`) makes a file runnable on its own: against PostgreSQL the helpers create the
schema when it is missing; in memory mode the preload builds the schema snapshot itself. Run files through
`tests/run.ts` rather than `bun test tests/`: a single `bun test` process shares one module graph between
all files, which the schema-mutating files do not tolerate.

### Parity

`npm run test:parity` runs the suite against PostgreSQL and in memory at the same time — the PostgreSQL
files one after another, the in-memory files in parallel beside them — and, once both are complete,
compares the outcome of every test and of every file's process (a failure outside any test — an
`afterAll` hook, a crash — counts too). Any difference is listed and fails the run. Files that use the
real server even in memory mode (`tests/memory/sql-parity.test.ts`) start only after the PostgreSQL run
has finished, and the SQL parity test may not skip itself there. `npm publish` runs it (`prepublishOnly`).

`tests/memory/sql-parity.test.ts` checks the database itself statement by statement: each case of the
corpus runs on PostgreSQL and on a fresh in-memory database, and the command tags, row counts, column
names and types, rows (as the text PostgreSQL sends) or errors (code, message, detail, hint, position)
must be identical.

## VS Code Debugging

With the Bun extension (`oven.bun-vscode`), `.vscode/launch.json` provides:

1. **Bun: Run All Tests** / **Bun: Run All Tests In Memory** — the runner
2. **Bun: Debug Current Test File** — the open file under the debugger
3. **Bun: Debug Selected Test** — the test whose name is selected
4. **Bun: Watch Current Test File**

## Database Setup

PostgreSQL runs use the database configured via environment variables in `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=linkgress_test  # Must include 'test' in name
DB_USER=postgres
DB_PASSWORD=postgres
```

Test files truncate the tables they use; the schema is created per run.

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

### `expectToReject`
Assert that a promise (or a query builder) rejects. Use it instead of `expect(...).rejects`: Bun's
`.rejects` / `.resolves` only await real promises, and driver queries are lazy thenables that never start.

```typescript
const error = await expectToReject(db.users.where(u => eq(u.id, 'x' as any)).toList(), /invalid input syntax/);
expect(error.code).toBe('22P02');
```

## Writing New Tests

### Test Template

```typescript
import { describe, test, expect } from 'bun:test';
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

Mocks come from `bun:test` too: `jest.fn()`, `jest.spyOn()` / `spyOn()`, and `mock.module()` for modules.

### Best Practices

1. **Use descriptive test names** - Clearly state what is being tested
2. **Isolate tests** - Each test should be independent; do not rely on objects another file left behind
   (memory-mode files start from a fresh database)
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
Run `pnpm install` (or `npm install`) to ensure all dependencies are installed.

### Database connection errors
Check your `.env` file has correct database credentials.

### Tests hang or timeout
The runner's per-test timeout is 30 s (`--timeout <ms>`). A single test can set its own:
```typescript
test('long running test', async () => {
  // ...
}, 60000); // 60 second timeout
```

### "Database name must include 'test'"
Ensure `DB_NAME` in `.env` contains the word "test" for safety.

## CI/CD Integration

Example GitHub Actions:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run test:parity
        env:
          DB_NAME: linkgress_test
          DB_USER: postgres
          DB_PASSWORD: postgres
          DB_HOST: localhost
```
