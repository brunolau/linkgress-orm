import { DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions } from './database-client.interface';
import type { PGliteClientOptions } from './types';

// Resolved lazily so '@electric-sql/pglite' stays an optional dependency
type PGliteInstance = any;

/**
 * Result parsers for the instances this client creates, where pg, postgres.js and Bun.SQL all
 * agree and PGlite does not:
 * - int8 (OID 20) as a decimal string, the only lossless JS form past 2^53 (PGlite: a number,
 *   a BigInt once unsafe). PGlite derives array parsers from the element parser, so int8[]
 *   follows.
 * - bytea (OID 17) as a Node Buffer (PGlite: a plain Uint8Array, which Buffer extends).
 *   Runtimes without Buffer keep PGlite's default.
 */
const DEFAULT_PARSERS: Record<number, (value: string) => any> = {
  20: (value: string) => value,
};

if (typeof Buffer === 'function') {
  DEFAULT_PARSERS[17] = (value: string) => Buffer.from(value.slice(2), 'hex');
}

const pad = (value: number, digits: number): string => String(value).padStart(digits, '0');

/**
 * A Date as `YYYY-MM-DDTHH:MM:SS.mmm+HH:MM` in LOCAL time — pg's formatting, BC years included.
 */
function toLocalTimestampText(date: Date): string {
  let year = date.getFullYear();
  const isBC = year < 1;

  if (isBC) {
    // JS year 0 is 1 BC
    year = Math.abs(year) + 1;
  }

  const offset = -date.getTimezoneOffset();
  const text =
    `${pad(year, 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60), 2)}:${pad(Math.abs(offset) % 60, 2)}`;

  return isBC ? `${text} BC` : text;
}

function serializeDateParam(value: any): string {
  if (value instanceof Date) {
    return toLocalTimestampText(value);
  }

  return typeof value === 'number' ? toLocalTimestampText(new Date(value)) : String(value);
}

/**
 * Parameter serializers for the instances this client creates. A Date bound to date (1082),
 * timestamp (1114) or timestamptz (1184) is sent as its local time with the UTC offset, as pg
 * sends it — and what postgres.js ends up storing too (it binds Dates as timestamptz and the
 * server converts). PGlite's own default sends UTC text, which lands a local-midnight Date on
 * the previous day in a date column east of UTC and shifts every Date round-tripped through
 * timestamp by the host's offset.
 */
const DEFAULT_SERIALIZERS: Record<number, (value: any) => string> = {
  1082: serializeDateParam,
  1114: serializeDateParam,
  1184: serializeDateParam,
};

/**
 * Check if a value is a PGlite instance
 */
function isPGliteInstance(value: any): boolean {
  return value !== null && typeof value === 'object' &&
    typeof value.query === 'function' && typeof value.exec === 'function' &&
    typeof value.transaction === 'function' && typeof value.close === 'function';
}

/**
 * Create a PGlite instance from a data directory or options, with the default parsers and
 * serializers under any the caller passed.
 */
function createPGlite(config?: string | PGliteClientOptions): PGliteInstance {
  let PGlite: any;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pgliteModule = require('@electric-sql/pglite');
    // Under ESM-interop loaders require() can return a module-namespace
    // object ({ default: ... }) — unwrap it (same fix as the other clients).
    PGlite = pgliteModule?.PGlite ?? pgliteModule?.default?.PGlite;
  } catch (error) {
    throw new Error(
      'PGliteClient requires the "@electric-sql/pglite" package to be installed. ' +
      'Install it with: npm install @electric-sql/pglite'
    );
  }

  if (typeof PGlite !== 'function') {
    throw new Error('The "@electric-sql/pglite" package did not expose a PGlite constructor (unexpected module shape).');
  }

  const options: PGliteClientOptions = typeof config === 'string' ? { dataDir: config } : { ...config };

  // Outside the try/catch: a construction error (e.g. invalid options)
  // must propagate as-is, not masquerade as a missing package.
  return new PGlite({
    ...options,
    parsers: { ...DEFAULT_PARSERS, ...options.parsers },
    serializers: { ...DEFAULT_SERIALIZERS, ...options.serializers },
  });
}

/**
 * Map a PGlite `Results` to a QueryResult. PGlite takes `rowCount` from the statement's
 * command tag, so it means what pg's does: rows returned by a SELECT, rows affected by DML,
 * and nothing (null) for commands that report no count, such as DDL.
 */
function toQueryResult<T = any>(result: any): QueryResult<T> {
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount ?? null,
  };
}

/**
 * FIFO lock over PGlite's single session. Root-level operations hold it while they run and
 * `connect()` holds it until `release()`, so no other caller's statement can land in the
 * middle of what a leaseholder is doing on the session (an open BEGIN, SET, temp tables) —
 * the guarantee a pool of one connection gives.
 */
class SessionLock {
  private tail: Promise<void> = Promise.resolve();

  /** Resolves, in call order, with the function that hands the session to the next waiter. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const acquired = this.tail.then(() => release);
    this.tail = acquired.then(() => released);
    return acquired;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** The session belongs to the instance, so every client over one instance shares its lock. */
const sessionLocks = new WeakMap<object, SessionLock>();

function sessionLockFor(pglite: PGliteInstance): SessionLock {
  let lock = sessionLocks.get(pglite);

  if (!lock) {
    lock = new SessionLock();
    sessionLocks.set(pglite, lock);
  }

  return lock;
}

/** A transaction() callback's claim on an instance's session; inactive once the transaction ends. */
interface HeldSession {
  readonly pglite: object;
  active: boolean;
}

interface HeldSessionTracker {
  getStore(): ReadonlyArray<HeldSession> | undefined;
  run<R>(store: ReadonlyArray<HeldSession>, callback: () => R): R;
}

/**
 * The sessions the current async context holds, via AsyncLocalStorage (Node, Bun, Deno; where it
 * is missing the check is skipped). The module id is assembled at runtime so browser bundlers do
 * not try to resolve a Node builtin — the same reason as BunClient's `bun` specifier.
 */
const heldSessions: HeldSessionTracker | undefined = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AsyncLocalStorage } = require(['async', 'hooks'].join('_'));
    return new AsyncLocalStorage();
  } catch {
    return undefined;
  }
})();

/**
 * A lease on PGlite's single session, handed out by `PGliteClient.connect()`. Its queries
 * run directly on the session; every other caller waits until `release()`.
 */
class PGlitePooledConnection implements PooledConnection {
  private released = false;

  constructor(private pglite: PGliteInstance, private handBack: () => void) {}

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    return toQueryResult<T>(await this.pglite.query(sql, params));
  }

  release(): void {
    if (!this.released) {
      this.released = true;
      this.handBack();
    }
  }
}

/**
 * DatabaseClient implementation for PGlite — PostgreSQL compiled to WASM, running in-process
 * (Node, Bun, Deno, browsers) with no server
 * @see https://pglite.dev
 *
 * PGlite is a single-connection database: one session, one statement at a time.
 * - `connect()` leases that session until `release()` — a pool of one, shared by every
 *   PGliteClient over the same instance. Every other query waits for the release, so never
 *   await a root-level query while holding a connection. Inside `transaction()` use the
 *   transactional context: a root-level call from the callback (another query, a nested
 *   transaction) could never run, and throws at once instead of hanging.
 * - PGlite cannot cancel a running statement: `timeoutMs` (`.withTimeout()`) and
 *   `statement_timeout` are not enforced, as with PgClient and BunClient.
 * - Multi-statement SQL runs through `exec()` (simple protocol), so `querySimple` /
 *   `querySimpleMulti` and the single-round-trip strategies are available.
 * - An instance the client creates returns int8 as strings and bytea as Buffers, and sends
 *   Date parameters in local time — like pg (see DEFAULT_PARSERS / DEFAULT_SERIALIZERS).
 *   A passed-in instance is used exactly as configured.
 *
 * NOTE: This requires the '@electric-sql/pglite' package to be installed:
 * npm install @electric-sql/pglite
 * Under jest, PGlite also needs node's `--experimental-vm-modules` flag: it loads its WASM
 * and data bundles through dynamic import().
 */
export class PGliteClient extends DatabaseClient {
  private pglite: PGliteInstance;
  private ownsInstance: boolean;
  private readonly session: SessionLock;

  /**
   * Create a PGliteClient
   * @param config - Nothing (an in-memory database), a data directory, a PGliteClientOptions
   *   object, or an existing PGlite instance. The client closes an instance it created on
   *   `end()`; a passed-in instance is left open and used exactly as configured, parsers
   *   included.
   *
   * @example
   * ```typescript
   * // In-memory, gone with the process
   * const client = new PGliteClient();
   *
   * // Persisted to disk, with an extension
   * import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
   * const client = new PGliteClient({ dataDir: './pgdata', extensions: { pg_trgm } });
   *
   * // An instance you already have (ESM and browser builds: construct PGlite yourself)
   * import { PGlite } from '@electric-sql/pglite';
   * const client = new PGliteClient(await PGlite.create());
   * ```
   */
  constructor(config?: string | PGliteClientOptions | PGliteInstance) {
    super();

    if (isPGliteInstance(config)) {
      this.pglite = config;
      this.ownsInstance = false;
    } else {
      this.pglite = createPGlite(config);
      this.ownsInstance = true;
    }

    this.session = sessionLockFor(this.pglite);
  }

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    this.assertSessionAvailable();

    return await this.session.run(async () => toQueryResult<T>(await this.pglite.query(sql, params)));
  }

  async connect(): Promise<PooledConnection> {
    this.assertSessionAvailable();

    const release = await this.session.acquire();
    return new PGlitePooledConnection(this.pglite, release);
  }

  async end(): Promise<void> {
    // Only close the instance if we created it
    if (this.ownsInstance) {
      await this.pglite.close();
    }
  }

  getDriverName(): string {
    return 'pglite';
  }

  /**
   * Execute a callback within a transaction.
   * Uses PGlite's transaction(): BEGIN, then COMMIT — or ROLLBACK when the callback throws.
   */
  async transaction<T>(callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    this.assertSessionAvailable();

    return await this.session.run(() =>
      this.pglite.transaction(async (tx: any) => {
        const queryFn = async (sql: string, params?: any[]): Promise<QueryResult> => toQueryResult(await tx.query(sql, params));

        return await this.holdingSession(() => callback(queryFn));
      })
    );
  }

  /**
   * PGlite runs multi-statement SQL through exec() (simple protocol), one result set per
   * statement, so the single-round-trip paths apply
   */
  supportsMultiStatementQueries(): boolean {
    return true;
  }

  /**
   * Execute a multi-statement query using the simple protocol
   * This bypasses prepared statements and allows multiple statements
   * WARNING: Only use with safe, validated inputs!
   */
  async querySimple<T = any>(sql: string): Promise<QueryResult<T>> {
    this.assertSessionAvailable();

    const resultSets = await this.session.run<any[]>(() => this.pglite.exec(sql));

    // Return the last ROW-BEARING result set (the SELECT) — trailing
    // row-less statements (DROP TABLE cleanup etc.) must not shadow it.
    for (let i = resultSets.length - 1; i >= 0; i--) {
      if (resultSets[i].rows.length > 0) {
        return toQueryResult<T>(resultSets[i]);
      }
    }

    return { rows: [], rowCount: 0 };
  }

  /**
   * Execute a multi-statement query and return ALL result sets — one per statement,
   * row-less ones included, since callers index them positionally
   */
  async querySimpleMulti(sql: string): Promise<QueryResult[]> {
    this.assertSessionAvailable();

    const resultSets = await this.session.run<any[]>(() => this.pglite.exec(sql));

    return resultSets.map((resultSet: any) => toQueryResult(resultSet));
  }

  /**
   * From inside a transaction() callback on this instance, a root-level call could only start once
   * that transaction ends — which it never does while the callback waits for the call. PGlite has
   * one session, so fail at once instead of hanging.
   */
  private assertSessionAvailable(): void {
    if (heldSessions?.getStore()?.some(held => held.active && held.pglite === this.pglite)) {
      throw new Error(
        'PGliteClient: PGlite has a single session, and the transaction running this callback holds it — ' +
        'this call would wait for that transaction to end, which never happens. Run statements inside a ' +
        "transaction through the transaction's own client (the transactional context)."
      );
    }
  }

  /** Run a transaction callback marked as holding this instance's session, until it settles. */
  private async holdingSession<R>(work: () => Promise<R>): Promise<R> {
    if (!heldSessions) {
      return await work();
    }

    const held: HeldSession = { pglite: this.pglite, active: true };

    try {
      return await heldSessions.run([...(heldSessions.getStore() ?? []), held], work);
    } finally {
      held.active = false;
    }
  }

  /**
   * Get access to the underlying PGlite instance for advanced use cases
   * (extension namespaces, live queries, dumpDataDir(), ...)
   */
  getPGlite(): PGliteInstance {
    return this.pglite;
  }
}
