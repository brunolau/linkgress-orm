import { DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions } from './database-client.interface';
import type { BunSqlOptions } from './types';

// Resolved lazily so the module can be imported under Node
type BunSql = any;

/**
 * Resolve Bun's SQL constructor.
 *
 * Bun exposes SQL on the `Bun` global and via the virtual `bun` module —
 * there is no `bun:sql` builtin. Prefer the global (no module resolution
 * involved, works under every bundler), fall back to `require('bun')` for
 * environments that strip globals.
 */
function resolveBunSqlConstructor(): any {
  const bunGlobal = (globalThis as any).Bun;
  if (bunGlobal && typeof bunGlobal.SQL === 'function') {
    return bunGlobal.SQL;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SQL } = require('bun');
  return SQL;
}

/**
 * Check if a value is a Bun SQL instance
 */
function isBunSqlInstance(value: any): boolean {
  return value && typeof value === 'function' && typeof value.unsafe === 'function' && typeof value.close === 'function';
}

/**
 * In text-results mode (`prepare: false`), Bun serializes object/array params
 * with toString() — a jsonb param would reach the server as "[object Object]".
 * Pre-stringify them: in the text protocol PostgreSQL parses the JSON string
 * into the json/jsonb target correctly (matching binary-mode behavior).
 * Dates pass through — Bun formats those itself.
 */
/**
 * Convert Date values in result rows to PostgreSQL-text strings, in place.
 * 'YYYY-MM-DD HH:MM:SS.mmm' (UTC, no zone suffix); exactly-UTC-midnight
 * values become plain 'YYYY-MM-DD' (DATE columns arrive as midnight Dates).
 */
function convertDatesToPgText(rows: any[]): void {
  for (const row of rows) {
    for (const key in row) {
      const value = row[key];

      if (value instanceof Date) {
        const iso = value.toISOString();
        row[key] = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 23).replace('T', ' ');
      }
    }
  }
}

function normalizeTextModeParams(params: any[] | undefined, textMode: boolean): any[] {
  const list = params || [];

  if (!textMode) {
    return list;
  }

  let needsCopy = false;
  for (const param of list) {
    if (param !== null && typeof param === 'object' && !(param instanceof Date)) {
      needsCopy = true;
      break;
    }
  }

  if (!needsCopy) {
    return list;
  }

  return list.map(param =>
    param !== null && typeof param === 'object' && !(param instanceof Date) ? JSON.stringify(param) : param
  );
}

/**
 * Wrapper for the reserved connection from Bun SQL
 */
class BunPooledConnection implements PooledConnection {
  constructor(private reserved: any, private textMode: boolean, private datesAsStrings: boolean) {}

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // Bun result sets are real arrays — pass through without copying.
    const result = await this.reserved.unsafe(sql, normalizeTextModeParams(params, this.textMode));

    if (this.datesAsStrings) {
      convertDatesToPgText(result);
    }

    return {
      rows: result as T[],
      rowCount: result.count ?? result.length ?? null,
    };
  }

  release(): void {
    this.reserved.release();
  }
}

/**
 * DatabaseClient implementation for Bun's built-in SQL client
 * @see https://bun.sh/docs/api/sql
 *
 * NOTE: This requires Bun runtime. The SQL client is built into Bun.
 * Supports PostgreSQL, MySQL, and SQLite.
 */
export class BunClient extends DatabaseClient {
  private sql: BunSql;
  private ownsConnection: boolean;
  /**
   * True when the client was constructed with `prepare: false` — Bun then uses
   * unnamed statements with TEXT-format results, whose array decoding is
   * correct (the binary decoder panics / mis-shapes arrays, see
   * supportsBinaryArrayResults). Conservatively false for pre-built instances
   * and connection strings, where the prepare mode is unknown.
   */
  private usesTextResults: boolean;
  /** See BunSqlOptions.datesAsStrings — linkgress-level Date→PG-text conversion. */
  private datesAsStrings: boolean;

  /**
   * Create a BunClient
   * @param config - Either a connection string, BunSqlOptions config object, or an existing Bun SQL instance
   *
   * @example
   * ```typescript
   * // Connection string
   * const client = new BunClient("postgres://user:pass@localhost:5432/mydb");
   *
   * // Options object
   * const client = new BunClient({
   *   hostname: "localhost",
   *   port: 5432,
   *   database: "mydb",
   *   username: "user",
   *   password: "pass",
   * });
   *
   * // Existing SQL instance
   * import { SQL } from "bun";
   * const sql = new SQL("postgres://...");
   * const client = new BunClient(sql);
   * ```
   */
  constructor(config: string | BunSqlOptions | BunSql) {
    super();

    // Check if config is an existing Bun SQL instance
    if (isBunSqlInstance(config)) {
      this.sql = config;
      this.ownsConnection = false;
      this.usesTextResults = false;
      this.datesAsStrings = false;
    } else {
      const isOptionsObject = typeof config === 'object' && config !== null;
      this.usesTextResults = isOptionsObject && (config as BunSqlOptions).prepare === false;
      this.datesAsStrings = isOptionsObject && (config as BunSqlOptions).datesAsStrings === true;

      // Strip linkgress-level extensions before handing the options to Bun.
      const bunConfig = isOptionsObject ? { ...(config as any), datesAsStrings: undefined } : config;

      try {
        const SQL = resolveBunSqlConstructor();
        this.sql = new SQL(bunConfig as any);
        this.ownsConnection = true;
      } catch (error) {
        throw new Error(
          'BunClient requires Bun runtime with SQL support. ' +
          'This client only works when running under Bun. ' +
          'Make sure you are using Bun and have a compatible version.'
        );
      }
    }
  }

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    // Use unsafe() for parameterized queries (similar to postgres library).
    // Bun result sets are real arrays — pass through without copying.
    const result = await this.sql.unsafe(sql, normalizeTextModeParams(params, this.usesTextResults));

    if (this.datesAsStrings) {
      convertDatesToPgText(result);
    }

    return {
      rows: result as T[],
      rowCount: result.count ?? result.length ?? null,
    };
  }

  async connect(): Promise<PooledConnection> {
    // Bun SQL uses reserve() to get a dedicated connection from the pool
    const reserved = await this.sql.reserve();
    return new BunPooledConnection(reserved, this.usesTextResults, this.datesAsStrings);
  }

  async end(): Promise<void> {
    // Only close the connection if we created it
    if (this.ownsConnection) {
      await this.sql.close();
    }
  }

  getDriverName(): string {
    return 'bun';
  }

  /**
   * Execute a callback within a transaction.
   * Uses Bun SQL's built-in sql.begin() for proper transaction handling.
   */
  async transaction<T>(callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (tx: BunSql) => {
      const queryFn = async (sqlStr: string, params?: any[]): Promise<QueryResult> => {
        const result = await tx.unsafe(sqlStr, normalizeTextModeParams(params, this.usesTextResults));

        if (this.datesAsStrings) {
          convertDatesToPgText(result);
        }

        return {
          rows: result as any[],
          rowCount: result.count ?? result.length ?? null,
        };
      };

      return await callback(queryFn);
    });
  }

  /**
   * Bun SQL supports multiple SQL statements using .simple() mode
   * This allows true single round-trip optimization
   */
  supportsMultiStatementQueries(): boolean {
    return true;
  }

  /**
   * Normalize a Bun `.simple()` result into an array of result sets.
   *
   * For a SINGLE statement, `.simple()` returns the result set itself (an
   * array of row objects); for MULTIPLE statements it returns an array with
   * one result set per statement. Distinguish by element shape — a result
   * set's elements are row objects, never arrays.
   */
  private static normalizeSimpleResultSets(results: any): any[] {
    if (!Array.isArray(results)) {
      return [results];
    }

    if (results.length > 0) {
      return Array.isArray(results[0]) ? results : [results];
    }

    return typeof (results as any).command === 'string' ? [results] : results;
  }

  /**
   * Execute a multi-statement query using the simple protocol
   * This bypasses prepared statements and allows multiple statements
   * WARNING: Only use with safe, validated inputs!
   */
  async querySimple<T = any>(sql: string): Promise<QueryResult<T>> {
    const results = await this.sql.unsafe(sql).simple();
    const resultSets = BunClient.normalizeSimpleResultSets(results);

    // Return the last ROW-BEARING result set (the SELECT) — Bun emits an
    // entry per statement, so trailing row-less cleanup statements
    // (DROP TABLE) must not shadow the data-bearing one.
    let lastResult: any = [];

    for (let i = resultSets.length - 1; i >= 0; i--) {
      if ((resultSets[i]?.length ?? 0) > 0) {
        lastResult = resultSets[i];
        break;
      }
    }

    if (this.datesAsStrings) {
      convertDatesToPgText(lastResult);
    }

    return {
      rows: lastResult as T[],
      rowCount: lastResult.count ?? lastResult.length ?? null,
    };
  }

  /**
   * Execute a multi-statement query and return ALL result sets
   * Used for fully optimized single-query execution
   */
  async querySimpleMulti(sql: string): Promise<QueryResult[]> {
    const results = await this.sql.unsafe(sql).simple();

    // Convert each result set to QueryResult format
    return BunClient.normalizeSimpleResultSets(results).map((result: any) => {
      if (this.datesAsStrings) {
        convertDatesToPgText(result);
      }

      return {
        rows: result as any[],
        rowCount: result.count ?? result.length ?? null,
      };
    });
  }

  /**
   * Bun SQL automatically uses binary protocol where appropriate
   * No explicit toggle needed
   */
  supportsBinaryProtocol(): boolean {
    return false; // No explicit control, but uses binary internally
  }

  /**
   * Bun ≤ 1.3.14 cannot decode BINARY array result columns (alignment panic /
   * object-shaped arrays — see debug/bun-sql-binary-array-repro.ts), so by
   * default query builders aggregate via json_agg instead of array_agg.
   *
   * With `prepare: false`, Bun uses unnamed statements with TEXT-format
   * results whose array decoding is correct — native arrays work and the
   * panic surface disappears entirely (raw SQL included), at ~0.05ms/query
   * re-parse cost. In that mode this returns true and strategies keep
   * array_agg.
   */
  supportsBinaryArrayResults(): boolean {
    return this.usesTextResults;
  }

  /**
   * Get access to the underlying Bun SQL instance for advanced use cases
   */
  getSql(): BunSql {
    return this.sql;
  }
}
