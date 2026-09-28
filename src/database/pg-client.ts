import { ConnectionReleasedError, DatabaseClient, PooledConnection, QueryResult, QueryExecutionOptions, TransactionEndedError } from './database-client.interface';
import type { PoolConfig } from './types';

// Use dynamic import to make pg optional
type Pool = any;
type PoolClient = any;

/**
 * Check if a value is a pg.Pool instance
 */
function isPgPoolInstance(value: any): boolean {
  return value && typeof value === 'object' && typeof value.query === 'function' && typeof value.connect === 'function' && typeof value.end === 'function';
}

/** A registry of node-postgres text parsers: pg-types, or a pool's own `types`. */
interface PgTypeParsers {
  getTypeParser(oid: number, format?: string): (text: string) => unknown;
}

let pgTypesRegistry: PgTypeParsers | null | undefined;

/** node-postgres's global type-parser registry (pg-types, as the `pg` module exposes it). */
function pgTypes(): PgTypeParsers | null {
  if (pgTypesRegistry === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pgModule = require('pg');
      pgTypesRegistry = pgModule?.types ?? pgModule?.default?.types ?? null;
    } catch {
      pgTypesRegistry = null;
    }
  }

  return pgTypesRegistry ?? null;
}

let pristineParsers: Record<number, unknown> | null | undefined;

/**
 * pg-types's own default text parsers, as its `init` registers them before any application's
 * `setTypeParser` — null where the module cannot be resolved from `pg`.
 */
function pristineTextParsers(): Record<number, unknown> | null {
  if (pristineParsers === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      const pgDir = path.dirname(require.resolve('pg'));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const textParsers = require(require.resolve('pg-types/lib/textParsers', { paths: [pgDir] }));
      const parsers: Record<number, unknown> = {};
      textParsers.init((oid: number, parser: unknown) => {
        parsers[oid] = parser;
      });
      pristineParsers = parsers;
    } catch {
      pristineParsers = null;
    }
  }

  return pristineParsers;
}

/**
 * The builtin types outside a QueryBatch's text transport an application may parse with a parser of its
 * own: booleans, integers, floats, json, text-like types, uuid, network types, and their arrays.
 */
const CUSTOMIZABLE_TYPE_OIDS = [
  16, 21, 23, 26, 700, 701, 114, 3802, 25, 1043, 1042, 18, 19, 142, 2950, 650, 869, 829,
  1000, 1005, 1007, 1028, 1021, 1022, 199, 3807, 1009, 1015, 1014, 1008, 2951, 1040, 1041, 651,
];

/** Whether a parser is pg-types's default json one — `JSON.parse` bound anew on every registration. */
const isNativeJsonParser = (parser: unknown): boolean =>
  typeof parser === 'function' && Function.prototype.toString.call(parser).includes('[native code]');

/**
 * Wrapper for the pooled connection from pg library
 *
 * Released, its `PoolClient` is back in the pool — possibly already checked out by another caller — so a later
 * statement is refused with a {@link ConnectionReleasedError}, and a second `release()` throws pg-pool's own error
 * WITHOUT reaching the pool: pg-pool gives every checkout its own `client.release`, so a stale call on a client that
 * was handed on released the NEW holder's lease.
 */
class PgPooledConnection implements PooledConnection {
  private released = false;

  constructor(private client: PoolClient) {}

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    if (this.released) {
      throw new ConnectionReleasedError(sql);
    }

    const result = await this.client.query(sql, params);

    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  }

  release(): void {
    if (this.released) {
      // pg-pool's own message — thrown here, before the pool: the client may belong to another checkout by now
      throw new Error('Release called on client which has already been released to the pool.');
    }

    this.released = true;
    this.client.release();
  }
}

/**
 * DatabaseClient implementation for the 'pg' library
 * @see https://node-postgres.com/
 *
 * NOTE: This requires the 'pg' package to be installed:
 * npm install pg
 */
export class PgClient extends DatabaseClient {
  private pool: Pool;
  private ownsConnection: boolean;

  /**
   * Create a PgClient
   * @param config - Either a PoolConfig object or an existing pg.Pool instance
   */
  constructor(config: PoolConfig | Pool) {
    super();

    // Check if config is an existing pg.Pool instance
    if (isPgPoolInstance(config)) {
      this.pool = config;
      this.ownsConnection = false;
    } else {
      let Pool: any;

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pgModule = require('pg');
        // Under ESM-interop loaders require() can return a module-namespace
        // object ({ default: ... }) — unwrap it (same fix as PostgresClient).
        Pool = pgModule?.Pool ?? pgModule?.default?.Pool;
      } catch (error) {
        throw new Error(
          'PgClient requires the "pg" package to be installed. ' +
          'Install it with: npm install pg'
        );
      }

      if (typeof Pool !== 'function') {
        throw new Error('The "pg" package did not expose a Pool constructor (unexpected module shape).');
      }

      // Outside the try/catch: a pool-construction error (e.g. invalid options)
      // must propagate as-is, not masquerade as a missing package.
      this.pool = new Pool(config);
      this.ownsConnection = true;
    }
  }

  async query<T = any>(sql: string, params?: any[], _options?: QueryExecutionOptions): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);

    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  }

  async connect(): Promise<PooledConnection> {
    const client = await this.pool.connect();
    return new PgPooledConnection(client);
  }

  async end(): Promise<void> {
    // Only close the pool if we created it
    if (this.ownsConnection) {
      await this.pool.end();
    }
  }

  getDriverName(): string {
    return 'pg';
  }

  /**
   * Execute a callback within a transaction.
   * Uses pg's connection-based transaction with BEGIN/COMMIT/ROLLBACK.
   *
   * The query function is valid until the callback settles; a statement sent through it later is refused with
   * a {@link TransactionEndedError} — its connection is back in the pool by then.
   */
  async transaction<T>(callback: (query: (sql: string, params?: any[]) => Promise<QueryResult>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = true;

    try {
      await client.query('BEGIN');

      const queryFn = async (sql: string, params?: any[]): Promise<QueryResult> => {
        if (!open) {
          throw new TransactionEndedError(sql);
        }

        const result = await client.query(sql, params);
        return {
          rows: result.rows,
          rowCount: result.rowCount,
        };
      };

      let result: T;

      try {
        result = await callback(queryFn);
      } finally {
        open = false;
      }

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * pg library does NOT support retrieving ALL result sets from multi-statement queries
   * It only returns the last result, making it unsuitable for the fully optimized approach
   * Use PostgresClient (postgres library) for true single-roundtrip multi-statement support
   */
  supportsMultiStatementQueries(): boolean {
    return false;
  }

  /**
   * pg has no binary result protocol toggle. The previous implementation
   * mapped `useBinaryProtocol` to pg's `rowMode: 'array'`, which is NOT the
   * binary protocol — it changes the row SHAPE to positional arrays and would
   * corrupt every column-name-based result mapping downstream.
   */
  supportsBinaryProtocol(): boolean {
    return false;
  }

  /**
   * The parsers a result column reads through: the pool's own `types` when it was given some, else
   * node-postgres's global registry (pg-types, with any `pg.types.setTypeParser` of the application).
   */
  private typeParsers(): PgTypeParsers | null {
    const own = this.pool?.options?.types;

    return own && typeof own.getTypeParser === 'function' ? own : pgTypes();
  }

  /** The value node-postgres delivers for a column of the type `oid` holding `text`, through this pool's parsers. */
  parseTypedText(oid: number, text: string): unknown {
    const parsers = this.typeParsers();

    return parsers ? parsers.getTypeParser(oid, 'text')(text) : super.parseTypedText(oid, text);
  }

  /**
   * The builtin types this pool parses with a parser of the application's: the pool's own `types`
   * where they differ from node-postgres's registry, and that registry where `pg.types.setTypeParser`
   * changed pg-types's defaults.
   */
  customParsedTypeOids(): readonly number[] {
    const global = pgTypes();

    if (!global) {
      return [];
    }

    const own = this.typeParsers();
    const pristine = pristineTextParsers();

    return CUSTOMIZABLE_TYPE_OIDS.filter((oid) => {
      const live = global.getTypeParser(oid, 'text');

      if (own && own !== global && own.getTypeParser(oid, 'text') !== live) {
        return true;
      }

      if (!pristine) {
        return false;
      }

      const original = pristine[oid];

      return original === undefined
        ? !Function.prototype.toString.call(live).startsWith('function noParse')
        : live !== original && !(isNativeJsonParser(live) && isNativeJsonParser(original));
    });
  }

  /**
   * Get access to the underlying pg Pool for advanced use cases
   */
  getPool(): Pool {
    return this.pool;
  }
}
