import { Database, InMemoryDatabaseOptions } from './engine/database';
import { restoreDatabase, snapshotDatabase } from './engine/snapshot';
import { MemorySocket } from './wire/memory-socket';
import { InMemoryDatabaseListener, InMemoryListenOptions, listenTcp } from './wire/tcp-server';

export type { InMemoryDatabaseOptions } from './engine/database';
export type { InMemoryDatabaseListener, InMemoryListenOptions } from './wire/tcp-server';
export { InMemoryDatabaseThread, ThreadSocket } from './thread';
export type { InMemoryDatabaseThreadOptions } from './thread';
export { MemorySocket } from './wire/memory-socket';

/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * An in-memory PostgreSQL-compatible database.
 *
 * Connections are made with the real `pg` / `postgres` drivers over an in-process socket that
 * speaks the PostgreSQL wire protocol, so results (types, parsing, errors, command tags) are
 * produced exactly as they would be by a PostgreSQL server.
 *
 * @example
 * const db = new InMemoryDatabase();
 * const client = new PgClient(db.pgPoolConfig());            // node-postgres
 * const client2 = new PostgresClient(db.createPostgresSql()); // postgres.js
 */
export class InMemoryDatabase {
  readonly engine: Database;

  constructor(options: InMemoryDatabaseOptions = {}, engine?: Database) {
    this.engine = engine ?? new Database(options);
  }

  /**
   * Serialize the committed state (schema, rows, sequences) — e.g. build and seed a database once,
   * then restore it per test worker with {@link InMemoryDatabase.fromSnapshot}.
   */
  snapshot(): Buffer {
    return snapshotDatabase(this.engine);
  }

  /** Restore a database from {@link InMemoryDatabase.snapshot} output. */
  static fromSnapshot(data: Buffer | Uint8Array, options: InMemoryDatabaseOptions = {}): InMemoryDatabase {
    return new InMemoryDatabase({}, restoreDatabase(data, options));
  }

  /** An independent copy of the committed state of this database. */
  fork(options: InMemoryDatabaseOptions = {}): InMemoryDatabase {
    return InMemoryDatabase.fromSnapshot(this.snapshot(), options);
  }

  /** A new connection socket to this database. */
  createSocket(): MemorySocket {
    return new MemorySocket(this.engine);
  }

  /** Merge into a `pg` Pool/Client config: connections go to this database. */
  pgPoolConfig<T extends Record<string, unknown>>(config: T = {} as T): T & { stream: () => MemorySocket } {
    return {
      host: 'linkgress-memory',
      port: 5432,
      user: this.engine.options.userName,
      database: this.engine.options.databaseName,
      password: '',
      ...config,
      stream: () => this.createSocket(),
    };
  }

  /** Merge into `postgres(options)`: connections go to this database. */
  postgresOptions<T extends Record<string, unknown>>(options: T = {} as T): T & { socket: () => MemorySocket } {
    return {
      host: 'linkgress-memory',
      port: 5432,
      user: this.engine.options.userName,
      database: this.engine.options.databaseName,
      pass: '',
      ...options,
      ssl: false,
      socket: () => this.createSocket(),
    };
  }

  /** A `pg.Pool` connected to this database. */
  createPgPool(config: Record<string, unknown> = {}): unknown {
    const pg = require('pg');
    const Pool = pg.Pool ?? pg.default?.Pool;
    return new Pool(this.pgPoolConfig(config));
  }

  /** A postgres.js `sql` instance connected to this database. */
  createPostgresSql(options: Record<string, unknown> = {}): unknown {
    const mod = require('postgres');
    const postgres = typeof mod === 'function' ? mod : mod.default;
    return postgres(this.postgresOptions(options));
  }

  /**
   * Serve this database over TCP (loopback by default), so other processes — `psql`, a child
   * server, another driver — can connect with an ordinary connection string. Any password is
   * accepted.
   */
  listen(options: InMemoryListenOptions = {}): Promise<InMemoryDatabaseListener> {
    return InMemoryDatabase.listenLazy(() => this, options);
  }

  /**
   * Like {@link InMemoryDatabase.listen}, for a database that is only created (e.g. restored from a
   * snapshot) when the first connection arrives.
   */
  static listenLazy(getDatabase: () => InMemoryDatabase, options: InMemoryListenOptions = {}): Promise<InMemoryDatabaseListener> {
    return listenTcp(
      () => getDatabase().engine,
      () => getDatabase().engine.options.userName,
      () => getDatabase().engine.options.databaseName,
      options
    );
  }

  /** Close all sessions. */
  close(): void {
    for (const s of [...this.engine.sessions]) {
      this.engine.closeSession(s);
    }
  }
}
