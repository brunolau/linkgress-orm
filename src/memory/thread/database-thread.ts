import * as fs from 'fs';
import { MessagePort, parentPort, workerData } from 'worker_threads';
import type { Database } from '../engine/database';
import { PgError } from '../engine/errors';
import { InMemoryDatabase, InMemoryDatabaseOptions } from '../index';
import { listenTcp } from '../wire/tcp-server';
import { DatabaseResolver, ServerConnection } from '../wire/server-connection';
import type { InMemoryListenOptions } from '../wire/tcp-server';

/**
 * Worker-thread entry of {@link InMemoryDatabaseThread}: owns the database(s) and serves connections
 * that arrive as MessagePorts (in-process sockets of the parent) or over TCP.
 */

interface ThreadData {
  snapshotPath?: string;
  snapshot?: Uint8Array;
  options?: InMemoryDatabaseOptions;
  databasePerName?: { aliases?: { pattern: string; flags?: string; name: string }[] };
  listen?: InMemoryListenOptions;
  /** Int32Array over a SharedArrayBuffer: [port, status] — status 1 listening, 2 failed */
  listenState?: SharedArrayBuffer;
}

const data = workerData as ThreadData;
const databases = new Map<string, InMemoryDatabase>();
let snapshotBytes: Uint8Array | null | undefined;

const createDatabase = (name: string | undefined): InMemoryDatabase => {
  if (snapshotBytes === undefined) {
    snapshotBytes = data.snapshot ?? (data.snapshotPath && fs.existsSync(data.snapshotPath) ? fs.readFileSync(data.snapshotPath) : null);
  }
  const options = name === undefined ? data.options : { ...data.options, databaseName: name };
  return snapshotBytes ? InMemoryDatabase.fromSnapshot(snapshotBytes, options) : new InMemoryDatabase(options);
};

/** the single database (no per-name routing) */
const getDatabase = (): InMemoryDatabase => {
  let db = databases.get('');
  if (!db) {
    db = createDatabase(undefined);
    databases.set('', db);
  }
  return db;
};

/** per-name routing: each distinct (aliased) database name is its own database, created from the snapshot */
const aliases = (data.databasePerName?.aliases ?? []).map((a) => ({ re: new RegExp(a.pattern, a.flags), name: a.name }));
const resolveDatabase: DatabaseResolver = (name): Database => {
  if (!name) {
    throw new PgError('3D000', 'no database name given');
  }
  const canonical = aliases.find((a) => a.re.test(name))?.name ?? name;
  let db = databases.get(canonical);
  if (!db) {
    db = createDatabase(canonical);
    databases.set(canonical, db);
  }
  return db.engine;
};

const connectionTarget = (): Database | DatabaseResolver => (data.databasePerName ? resolveDatabase : getDatabase().engine);

const serve = (port: MessagePort): void => {
  let connection: ServerConnection;
  try {
    connection = new ServerConnection(connectionTarget(), {
      send: (bytes) => {
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        port.postMessage(copy, [copy.buffer]);
      },
      close: () => {
        port.postMessage(null);
        port.close();
      },
    });
  } catch {
    port.postMessage(null);
    port.close();
    return;
  }
  port.on('message', (chunk: Uint8Array | null) => {
    if (chunk === null) {
      connection.disconnect();
      port.close();
      return;
    }
    connection.receive(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  port.on('close', () => connection.disconnect());
};

parentPort!.on('message', (msg: { type: string; port?: MessagePort; reply?: MessagePort; database?: string }) => {
  switch (msg.type) {
    case 'connect':
      serve(msg.port!);
      break;
    case 'snapshot': {
      const db = data.databasePerName && msg.database ? (resolveDatabase(msg.database), databases.get(msg.database)!) : getDatabase();
      msg.reply!.postMessage(db.snapshot());
      msg.reply!.close();
      break;
    }
    case 'stats': {
      const stats: Record<string, unknown> = { heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576) };
      for (const [name, db] of databases) {
        stats[name || 'database'] = db.engine.stats();
      }
      msg.reply!.postMessage(stats);
      msg.reply!.close();
      break;
    }
  }
});

// diagnostics: LINKGRESS_THREAD_STATS=<file> appends the thread's heap and database statistics every 5s
if (process.env.LINKGRESS_THREAD_STATS) {
  const file = process.env.LINKGRESS_THREAD_STATS;
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const entry: Record<string, unknown> = {
      at: new Date().toISOString(),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      // process-wide (the jest worker and this thread together)
      rssMB: Math.round(mem.rss / 1048576),
      arrayBuffersMB: Math.round(mem.arrayBuffers / 1048576),
    };
    for (const [name, db] of databases) {
      entry[name || 'database'] = db.engine.stats();
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }, 5000);
  timer.unref();
}

if (data.listen && data.listenState) {
  const state = new Int32Array(data.listenState);
  listenTcp(
    connectionTarget,
    () => data.options?.userName ?? 'postgres',
    () => data.options?.databaseName ?? 'postgres',
    data.listen
  ).then(
    (listener) => {
      Atomics.store(state, 0, listener.port);
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1);
    },
    () => {
      Atomics.store(state, 1, 2);
      Atomics.notify(state, 1);
    }
  );
}
