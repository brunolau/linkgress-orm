import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { InMemoryDatabase } from '../../src/memory';
import { InMemoryDatabaseThread } from '../../src/memory/thread';

/**
 * The in-memory database a test file runs against when LINKGRESS_TEST_DB=memory.
 *
 * Every test file runs in its own `bun test` process (see tests/run.ts), so each file gets a fresh
 * database restored from the schema snapshot in LINKGRESS_MEMORY_SNAPSHOT — the equivalent of the
 * freshly created schema a PostgreSQL run's global setup provides (tests/setup.ts builds the snapshot
 * when a file is run without the runner).
 *
 * LINKGRESS_MEMORY_THREAD=true hosts it in a worker thread instead (`InMemoryDatabaseThread`),
 * exercising the thread transport.
 */
type MemoryTarget = InMemoryDatabase | InMemoryDatabaseThread;

const holder = globalThis as unknown as {
  __linkgressMemoryDatabase?: MemoryTarget;
  __linkgressMemoryListener?: Promise<{ host: string; port: number; close?: () => Promise<void> }>;
};

const create = (): MemoryTarget => {
  const options = { databaseName: process.env.DB_NAME || 'linkgress_test', userName: process.env.DB_USER || 'postgres' };
  const snapshotPath = process.env.LINKGRESS_MEMORY_SNAPSHOT ? path.resolve(process.env.LINKGRESS_MEMORY_SNAPSHOT) : undefined;

  if ((process.env.LINKGRESS_MEMORY_THREAD || '').toLowerCase() === 'true') {
    // with a TCP endpoint, for clients that cannot use a custom socket (Bun's SQL)
    return InMemoryDatabaseThread.start({ database: options, snapshotPath, listen: true });
  }

  return snapshotPath ? InMemoryDatabase.fromSnapshot(readFileSync(snapshotPath), options) : new InMemoryDatabase(options);
};

/** The test file's database, created on first use. */
export function memoryDatabase(): MemoryTarget {
  return (holder.__linkgressMemoryDatabase ??= create());
}

/** A TCP endpoint of the test file's database (opened on first use). */
export function memoryTcpEndpoint(): Promise<{ host: string; port: number }> {
  if (!holder.__linkgressMemoryListener) {
    const db = memoryDatabase();
    holder.__linkgressMemoryListener = db instanceof InMemoryDatabase ? db.listen() : Promise.resolve(db.listener!);
  }

  return holder.__linkgressMemoryListener;
}

/** Stop the test file's database (its TCP endpoint and, when thread-hosted, the thread). */
export async function disposeMemoryDatabase(): Promise<void> {
  const listener = await holder.__linkgressMemoryListener;
  await listener?.close?.();
  const db = holder.__linkgressMemoryDatabase;

  if (db instanceof InMemoryDatabaseThread) {
    await db.terminate();
  }
  holder.__linkgressMemoryDatabase = undefined;
  holder.__linkgressMemoryListener = undefined;
}

export function isMemoryTestDatabase(): boolean {
  return (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory';
}
