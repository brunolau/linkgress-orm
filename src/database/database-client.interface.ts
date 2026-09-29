import { parseBuiltInTypedText } from './typed-text';

/**
 * Database-agnostic query result interface
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

/**
 * How a statement would have read a value standalone — what a driver may decode a result column by
 * (see DatabaseClient.parseTypedText).
 */
export interface TypedTextRead {
  /**
   * Whether the statement binds parameters. A driver may decode the results of a parameterised
   * statement otherwise than those of a statement without any: Bun's SQL client decodes them through
   * the binary protocol (unless `prepare: false`), which drops a numeric zero's scale and reads a
   * timestamp before Christ that its text decoding cannot.
   */
  readonly parameterized?: boolean;
}

/**
 * Query execution options
 */
export interface QueryExecutionOptions {
  /**
   * Use binary protocol for data transfer (when supported by driver).
   * Binary protocol can improve performance by avoiding string conversions.
   * Default: false (uses text protocol)
   */
  useBinaryProtocol?: boolean;

  /**
   * Per-query timeout override, in milliseconds. Set by `.withTimeout(ms)`.
   *
   * When present, the driver runs *this query only* inside a short transaction
   * that issues `SET LOCAL statement_timeout` first — so the override is scoped
   * to the query (auto-resets at COMMIT) and cannot affect other queries on the
   * pooled connection. A value of `0` disables the timeout for this query
   * (overriding any connection-level default). When absent, no wrapping happens
   * and the connection-level default (if any) applies.
   *
   * On timeout the driver throws a {@link QueryTimeoutError}.
   *
   * NOTE: Currently only honored by `PostgresClient` (the `postgres`/porsager
   * driver). `PgClient`, `BunClient` and `PGliteClient` ignore it (PGlite cannot
   * cancel a running statement at all).
   */
  timeoutMs?: number;

  /**
   * Run this parameterised statement as a NAMED server-side prepared statement: the
   * server parses and plans it once per connection, and every later execution of the
   * same text skips parsing, planning and the describe round trip an unnamed statement
   * pays. Set from the context's `preparedStatements` option or per query via
   * `.withPreparedStatements()`; absent/`false` keeps the unnamed statement (the default).
   *
   * Only honored by `PostgresClient`; `PgClient`, `BunClient` and `PGliteClient` ignore it
   * (Bun.SQL has its own instance-level `prepare`). The postgres.js instance must allow prepared
   * statements (its default) — an instance created with `prepare: false` ignores this.
   */
  prepare?: boolean;
}

/**
 * Error thrown when a query is cancelled because it exceeded its timeout — the
 * per-query `.withTimeout(ms)` override or the connection-level
 * `statement_timeout` default.
 *
 * The underlying database error (PostgreSQL code `57014`, "canceling statement
 * due to statement timeout") is preserved on the `cause` property.
 */
export class QueryTimeoutError extends Error {
  /** The timeout that was exceeded, in milliseconds (`0` if not known). */
  readonly timeoutMs: number;
  /** The SQL text of the query that timed out. */
  readonly sql: string;
  /** The original driver error that surfaced the cancellation, if any. */
  readonly cause?: unknown;

  constructor(timeoutMs: number, sql: string, cause?: unknown) {
    super(`Query exceeded its timeout of ${timeoutMs}ms and was cancelled`);
    this.name = 'QueryTimeoutError';
    this.timeoutMs = timeoutMs;
    this.sql = sql;
    this.cause = cause;
    // Restore prototype chain so `instanceof` works when targeting ES5
    Object.setPrototypeOf(this, QueryTimeoutError.prototype);
  }
}

/**
 * A statement sent through a transaction after that transaction ended — committed, rolled back or failed.
 *
 * Everything obtained from the context `db.transaction()` hands its callback — table accessors, model
 * sequences, query builders, futures, `QueryBatch` / `MutationBatch` legs, prepared queries, its schema
 * manager, its client — and the query function a driver's `transaction()` hands its callback, run their
 * statements on the transaction's connection. Once the transaction has ended that connection is back in the
 * pool and may belong to ANOTHER transaction, so such a statement is refused before it reaches the database.
 * Use the root context (or a new transaction) instead.
 */
export class TransactionEndedError extends Error {
  /** The SQL text of the refused statement (never sent). */
  readonly sql: string;

  constructor(sql: string) {
    super(
      'this transaction has already ended — objects obtained from its context (tables, sequences, queries, ' +
      'batches, its schema manager, its client) are only valid inside transaction(); use the root context ' +
      'or a new transaction instead. The statement was not run.'
    );
    this.name = 'TransactionEndedError';
    this.sql = sql;
    // Restore prototype chain so `instanceof` works when targeting ES5
    Object.setPrototypeOf(this, TransactionEndedError.prototype);
  }
}

/**
 * A statement sent through a {@link PooledConnection} after its `release()`.
 *
 * Released, the connection's session is back in the pool, which may already have handed it to another caller —
 * in the middle of that caller's transaction, say (PGlite: its one session, outside the session lock). So such a
 * statement is refused before it reaches the database. Acquire a new connection with `connect()`.
 */
export class ConnectionReleasedError extends Error {
  /** The SQL text of the refused statement (never sent). */
  readonly sql: string;

  constructor(sql: string) {
    super(
      'this connection has already been released — a statement on it would run on a pooled connection that may ' +
      'belong to another caller by now; acquire a new one with connect(). The statement was not run.'
    );
    this.name = 'ConnectionReleasedError';
    this.sql = sql;
    // Restore prototype chain so `instanceof` works when targeting ES5
    Object.setPrototypeOf(this, ConnectionReleasedError.prototype);
  }
}

/**
 * Database-agnostic pooled client/connection interface
 * Represents a single connection from the pool for transactions
 *
 * Valid until `release()`: a statement issued after it is refused with a {@link ConnectionReleasedError} (one
 * issued before completes). A second `release()` never reaches the driver's pool — which may have handed the
 * session to another caller by then: `PgClient`'s throws node-postgres's own error, `PostgresClient`'s,
 * `BunClient`'s and `PGliteClient`'s do nothing.
 */
export interface PooledConnection {
  query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>>;
  release(): void;
}

/**
 * Base database client interface that all drivers must implement
 */
export abstract class DatabaseClient {
  /**
   * Whether this client is currently in a transaction
   */
  isInTransaction(): boolean {
    return false;
  }
  /**
   * Execute a query with optional parameters and execution options
   */
  abstract query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>>;

  /**
   * Get a connection from the pool for transactions
   */
  abstract connect(): Promise<PooledConnection>;

  /**
   * Close the connection pool
   */
  abstract end(): Promise<void>;

  /**
   * Get the driver name (postgres, pg, mysql, etc.)
   */
  abstract getDriverName(): string;

  /**
   * Execute a callback within a transaction.
   * The transaction is automatically committed on success or rolled back on error.
   *
   * @param callback - Function to execute within the transaction. Receives a query function.
   * @returns The result of the callback
   */
  abstract transaction<T>(callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>) => Promise<T>): Promise<T>;

  /**
   * Check if the driver supports executing multiple SQL statements in a single query
   * and returning multiple result sets.
   *
   * PostgreSQL drivers (pg, postgres) support this feature.
   * Default: false for safety
   */
  supportsMultiStatementQueries(): boolean {
    return false;
  }

  /**
   * Check if the driver supports binary protocol for improved performance.
   * Default: false
   */
  supportsBinaryProtocol(): boolean {
    return false;
  }

  /**
   * Whether the driver can decode native PostgreSQL ARRAY result columns
   * (int[], text[], ...) in parameterized queries.
   *
   * Bun's SQL client (≤ 1.3.14) cannot: binary array results either panic the
   * runtime ("incorrect alignment") or decode as numeric-keyed objects. When
   * this returns false, query builders emit json_agg-based aggregations
   * instead of array_agg so no native array ever reaches the wire.
   * Default: true.
   */
  supportsBinaryArrayResults(): boolean {
    return true;
  }

  /**
   * Whether a numeric ZERO read through this client loses its scale — `0.0000` arriving as `"0"`
   * (Bun's binary numeric decoder; every other value keeps its scale). The query builders then
   * restore it for a column declared with one (`decimal('price', 10, 4)`).
   * Default: false.
   */
  losesNumericZeroScale(): boolean {
    return false;
  }

  /**
   * The value this client delivers, standalone, for a result column of the type `oid` whose PostgreSQL
   * TEXT form is `text` — through the parser its driver is configured with (the driver's defaults, or
   * the application's own). A QueryBatch sends a value its JSON envelope cannot carry as the driver
   * delivers it (a timestamp, an int8, a value of a type with a parser of the application's) as its
   * text and turns it back with this, so a batched value is exactly the one the same query reads on
   * its own through this client.
   *
   * `read` says how the statement would have read it (whether it binds parameters), for a driver that
   * decodes a result column by that.
   *
   * Default: node-postgres's default parsing — a date and a timestamp without a zone as a local Date,
   * a timestamptz as its instant, ±infinity as ±Infinity, bytea as a Buffer, an array of them element by
   * element; every other type as its text. A client of another driver overrides it.
   */
  parseTypedText(oid: number, text: string, _read?: TypedTextRead): unknown {
    return parseBuiltInTypedText(oid, text, NODE_POSTGRES_PARSING);
  }

  /**
   * {@link parseTypedText} for every text of one type `oid`, read as `read` says — what a QueryBatch parses
   * a column's texts with, one call per value: `parse(text)` is exactly `parseTypedText(oid, text, read)`.
   * The built-in clients resolve their driver's parser for the type once, where `parseTypedText` looks it up
   * per value; a client whose `parseTypedText` is its own (a subclass's, an instance's) gets it called.
   * @internal
   */
  typedTextParser(oid: number, read?: TypedTextRead): (text: string) => unknown {
    return (text) => this.parseTypedText(oid, text, read);
  }

  /**
   * The types (OIDs) this client's driver parses with a parser the application configured, beyond the
   * driver's defaults: a QueryBatch sends every value of these types as its text, so that parser gets
   * it (see parseTypedText). Default: none.
   */
  customParsedTypeOids(): readonly number[] {
    return [];
  }
}

/** node-postgres's defaults: a date at local midnight, a timestamp without a zone as a local time. */
const NODE_POSTGRES_PARSING = { dateAsUtc: false, timestampAsUtc: false } as const;

/**
 * A wrapper client that routes queries through a transactional connection.
 * Used internally to ensure all operations within a transaction use the same connection.
 *
 * Once the transaction has ended ({@link markEnded}) every statement is refused with a
 * {@link TransactionEndedError}: the connection behind the query function is back in the pool.
 */
export class TransactionalClient extends DatabaseClient {
  private ended = false;

  constructor(
    private queryFn: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>,
    private parentClient: DatabaseClient
  ) {
    super();
  }

  /**
   * The client of a transaction — also after it ended, when its statements are refused (a context kept past its
   * transaction keeps reporting where it came from, and its statements fail with {@link TransactionEndedError}).
   */
  isInTransaction(): boolean {
    return true;
  }

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    if (this.ended) {
      throw new TransactionEndedError(sql);
    }

    // Forward the per-query options (notably `.withTimeout()`'s `timeoutMs`) to the
    // transaction's query fn. Earlier versions dropped these, so a per-query timeout
    // silently no-op'd inside `db.transaction()`; the driver now honors it via a
    // statement-scoped `SET LOCAL statement_timeout`.
    return await this.queryFn(sql, params, options) as QueryResult<T>;
  }

  /**
   * The transaction ended — its callback settled; COMMIT or ROLLBACK follows. From now on every statement is
   * refused with a {@link TransactionEndedError} instead of running on the released pooled connection.
   * @internal
   */
  markEnded(): void {
    this.ended = true;
  }

  async connect(): Promise<PooledConnection> {
    // In a transaction, we shouldn't allow getting a new connection
    throw new Error('Cannot get a new connection while in a transaction');
  }

  async end(): Promise<void> {
    // No-op - the parent client manages the connection lifecycle
  }

  getDriverName(): string {
    return this.parentClient.getDriverName();
  }

  async transaction<T>(_callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    // an ENDED transaction's context: the real cause — the statement it would begin with is refused
    if (this.ended) {
      throw new TransactionEndedError('BEGIN');
    }

    // Nested transactions not supported - could implement savepoints in the future
    throw new Error('Nested transactions are not supported');
  }

  supportsMultiStatementQueries(): boolean {
    return this.parentClient.supportsMultiStatementQueries();
  }

  supportsBinaryProtocol(): boolean {
    return this.parentClient.supportsBinaryProtocol();
  }

  supportsBinaryArrayResults(): boolean {
    return this.parentClient.supportsBinaryArrayResults();
  }

  losesNumericZeroScale(): boolean {
    return this.parentClient.losesNumericZeroScale();
  }

  parseTypedText(oid: number, text: string, read?: TypedTextRead): unknown {
    return this.parentClient.parseTypedText(oid, text, read);
  }

  typedTextParser(oid: number, read?: TypedTextRead): (text: string) => unknown {
    // This client's own parseTypedText is the parent's: the parent resolves its parser
    return this.parseTypedText === TransactionalClient.prototype.parseTypedText
      ? this.parentClient.typedTextParser(oid, read)
      : super.typedTextParser(oid, read);
  }

  customParsedTypeOids(): readonly number[] {
    return this.parentClient.customParsedTypeOids();
  }
}
