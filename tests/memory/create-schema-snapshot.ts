/**
 * Builds the in-memory test database the suite starts from — the test schema of
 * `debug/schema/appDatabase` created with `ensureCreated()`, exactly what the PostgreSQL run's global
 * setup creates — and writes its snapshot to the given file.
 *
 *   bun tests/memory/create-schema-snapshot.ts <out-file>
 *
 * Runs as its own process (the test runner calls it once per run, `tests/setup.ts` when a test file
 * is run on its own), so the AppDatabase model never shares a module registry with a test file.
 */
import { writeFileSync } from 'node:fs';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createInMemoryDatabase, PgClient } from '../../src';

export async function createSchemaSnapshot(outFile: string): Promise<void> {
  const memory = createInMemoryDatabase({
    databaseName: process.env.DB_NAME || 'linkgress_test',
    userName: process.env.DB_USER || 'postgres',
  });
  const client = new PgClient(memory.pgPoolConfig());
  const db = new AppDatabase(client, { logQueries: false, logParameters: false, collectionStrategy: 'cte' });

  await db.getSchemaManager().ensureDeleted();
  await db.getSchemaManager().ensureCreated();
  await client.end();
  writeFileSync(outFile, memory.snapshot());
}

if (import.meta.main) {
  const outFile = process.argv[2];

  if (!outFile) {
    console.error('usage: bun tests/memory/create-schema-snapshot.ts <out-file>');
    process.exit(2);
  }

  await createSchemaSnapshot(outFile);
}
