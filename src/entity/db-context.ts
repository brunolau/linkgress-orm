import { DatabaseClient, QueryResult, TransactionalClient, QueryExecutionOptions } from '../database/database-client.interface';
import { TableBuilder, TableSchema, InferTableType } from '../schema/table-builder';
import { DbColumn, UnwrapDbColumns, InsertData, UpdateData, UpsertData, ExtractDbColumns, ExtractDbColumnKeys } from './db-column';
import { DbEntity, EntityConstructor, EntityMetadataStore } from './entity-base';
import { DbModelConfig } from './model-config';
import { JoinQueryBuilder } from '../query/join-builder';
import { Condition, ConditionBuilder, SqlFragment, SqlBuildContext, UnwrapSelection, FieldRef, WhereConditionBase, inArray } from '../query/conditions';
import { LinkgressConfig } from '../config/linkgress-config';
import {
  ResolveCollectionResults,
  CollectionQueryBuilder,
  ReferenceQueryBuilder,
  SelectQueryBuilder,
  QueryBuilder,
  QueryContext,
  RETURNING_PLACEHOLDER_COLUMN,
  classifyReturningValue,
  fragmentReadMapper,
  readReturningRows,
  renderPlainReturning,
  renderReturningExpression,
  returningSelection,
  type ReturningReadPlan,
  type ReturningShape,
} from '../query/query-builder';
import { NavigationAliasPlan, type NavigationPathNode } from '../query/join-utils';
import { renumberPlaceholders } from '../query/sql-utils';
import { numericZeroScaleMapper, toPgArrayLiteral } from '../types/custom-types';
import { PreparedQuery } from '../query/prepared-query';
import { InferRowType } from '../schema/row-type';
import { DbSchemaManager } from '../migration/db-schema-manager';
import { splitViewsFromRegistry } from '../migration/view-sql';
import { renderViewDefinition } from '../migration/view-query-sql';
import { DbSequence, SequenceConfig } from '../schema/sequence-builder';
import type { DbCte } from '../query/cte-builder';
import { CteRootQueryBuilder } from '../query/cte-root-query';
import type { Subquery } from '../query/subquery';
import type { UnionQueryBuilder } from '../query/union-builder';
import type { FutureQuery, FutureSingleQuery, FutureCountQuery } from '../query/future-query';
import {
  getQualifiedTableName,
  buildReturningColumnList,
  buildColumnNamesList,
  detectPrimaryKeys,
  calculateOptimalChunkSize,
  extractUniqueColumnKeys,
  buildValuesClause,
  buildColumnConfigs,
  applyToDriverMapper,
  hasAutoIncrementPrimaryKey,
  type ColumnConfig,
} from '../query/sql-utils';

/**
 * Per-schema cache of the entity column mapping plan used by
 * DbEntityTable.mapResultToEntity. Schema objects come from the shared
 * registry and are stable for the lifetime of a DataContext, so the plan is
 * computed once per schema instead of per row (WeakMap: dropped together
 * with the schema when a context is released).
 */
const entityMappingPlanCache = new WeakMap<object, Array<{ propName: string; dbColumnName: string; mapper?: any; zeroScale?: any }>>();

/**
 * The alias the mutated rows render under in a RETURNING that reads navigations: `insert`,
 * `upsert` and `insertWithChildren` wrap their statement in a data-modifying CTE of this name and
 * join the navigations onto it.
 */
const MUTATION_ROW_ALIAS = '__mutation__';

/** A join a navigation RETURNING adds onto the mutation CTE — the shape every navigation resolver builds. */
type ReturningNavigationJoin = {
  alias: string;
  targetTable: string;
  targetSchema?: string;
  foreignKeys: string[];
  matches: string[];
  isMandatory: boolean;
  sourceAlias?: string;
};

/** A navigation column a RETURNING selector reads, keyed by its result alias (`a.b` inside nested objects). */
interface ReturningNavigationField {
  /** The alias the column renders under — its path alias when another path owns the relation name. */
  tableAlias: string;
  dbColumnName: string;
  schemaTable?: string;
  /** The column's own mapper: the one of the table it belongs to, whichever path reached it. */
  mapper?: { fromDriver(value: any): any };
}

/** What a navigation RETURNING's rendering reads from its detection. */
interface ReturningNavigationRenderInfo {
  selection: any;
  joins: ReturningNavigationJoin[];
  navigationFields: Map<string, ReturningNavigationField>;
  nestedObjects?: Map<string, any>;
  collectionFields?: Map<string, any>;
}

/** Composition hooks of a navigation RETURNING, used by `insertWithChildren` and `mergeBulk`. */
interface ReturningNavigationRenderOptions {
  /**
   * Alias the mutation's RETURNING qualifies its columns with. MERGE needs its target's: both the
   * target and the source alias are in scope there, so a bare column name is ambiguous.
   */
  returningQualifier?: string;
  prefixCtes?: string;
  extraJoins?: string[];
  extraSelects?: string[];
  extraCteReturningCols?: string[];
  orderByCteColumn?: string;
  /**
   * Navigation joins whose target TABLE appears here read from the mapped FROM item (SQL) instead —
   * how `insertWithChildren` / `insertBulkWithChildren` make a child→parent reference nav see the
   * parent row inserted in the SAME statement (the real table is snapshot-stale for data-modifying
   * CTE siblings) as well as the table's existing rows.
   */
  joinTableOverrides?: Map<string, string>;
}

/**
 * Per-schema prototype carrying a select-all row's NAVIGATION getters.
 *
 * A select-all row (`table.where(...)`, `table.with(...)`, a filter-join taken straight off the
 * table) exposes every COLUMN as an own enumerable property — the selection walkers downstream
 * read those with `Object.keys` / `Object.entries` — plus every NAVIGATION as a non-enumerable
 * getter, so a chained `.select(u => ({ posts: u.posts!.where(...) }))` still resolves while the
 * default projection stays columns-only.
 *
 * The navigation getters are a pure function of the schema, so they are built ONCE per schema
 * onto a shared prototype instead of being redefined on every row: an entity with 47 navigation
 * properties paid 47 `Object.defineProperty` calls on EVERY query build — ~5 µs, more than half
 * the cost of the whole select-all wrapper on a wide table. Rows keep their own enumerable
 * columns; only the non-enumerable getters move, and non-enumerable properties never appear in
 * `Object.keys` / `Object.entries` / spread / `for...in`, so every enumeration downstream sees
 * exactly what it saw before. `row.constructor` still resolves to `Object` through the chain,
 * which is what `isPlainObject` in the query builder tests.
 *
 * WeakMap-keyed on the schema object, so a prototype is dropped with its schema.
 */
const selectAllRelationPrototypes = new WeakMap<object, object>();

/** Non-enumerable slot holding the mock row a select-all row's navigation getters read through. */
const SELECT_ALL_SOURCE = Symbol('linkgress.selectAllSource');

function getSelectAllRelationPrototype(schema: any): object {
  let prototype = selectAllRelationPrototypes.get(schema);

  if (prototype === undefined) {
    const descriptors: PropertyDescriptorMap = {};

    for (const relName of Object.keys(schema.relations)) {
      descriptors[relName] = {
        get(this: any) {
          return this[SELECT_ALL_SOURCE][relName];
        },
        enumerable: false,
        configurable: true,
      };
    }

    prototype = Object.defineProperties({}, descriptors);
    selectAllRelationPrototypes.set(schema, prototype);
  }

  return prototype;
}

/**
 * A select-all row over `schema` reading through the mock row `source` — see
 * {@link getSelectAllRelationPrototype} for the shape and why navigations are inherited.
 */
/** Column property names per schema — `Object.keys(schema.columns)` allocated a fresh array per row. */
const selectAllColumnNames = new WeakMap<object, string[]>();

function createSelectAllRow(schema: any, source: any): any {
  const result: any = Object.create(getSelectAllRelationPrototype(schema));

  Object.defineProperty(result, SELECT_ALL_SOURCE, {
    value: source,
    enumerable: false,
    configurable: true,
  });

  let columnNames = selectAllColumnNames.get(schema);
  if (columnNames === undefined) {
    columnNames = Object.keys(schema.columns);
    selectAllColumnNames.set(schema, columnNames);
  }
  for (let i = 0; i < columnNames.length; i++) {
    const colName = columnNames[i];
    result[colName] = source[colName];
  }

  return result;
}

/**
 * Collection aggregation strategy type
 */
export type CollectionStrategyType = 'cte' | 'temptable' | 'lateral';

/**
 * Column information returned by getColumns()
 *
 * @typeParam TEntity - The entity type, used to strongly type propertyName as one of the entity's column keys
 *
 * @example
 * ```typescript
 * // With typed entity
 * const columns: ColumnInfo<User>[] = db.users.getColumns();
 * columns[0].propertyName; // Type: 'id' | 'username' | 'email' | ... (only column keys)
 *
 * // Get just the property names as a typed array
 * const keys = db.users.getColumnKeys();
 * // Type: Array<'id' | 'username' | 'email' | ...>
 * ```
 */
export interface ColumnInfo<TEntity = any> {
  /** Property name in the entity class (TypeScript name) - typed as keyof entity columns */
  propertyName: ExtractDbColumnKeys<TEntity>;
  /** Column name in the database */
  columnName: string;
  /** SQL type (e.g., 'integer', 'varchar', 'timestamp') */
  type: string;
  /** Whether the column is a primary key */
  isPrimaryKey: boolean;
  /** Whether the column is auto-incremented (identity) */
  isAutoIncrement: boolean;
  /** Whether the column is nullable */
  isNullable: boolean;
  /** Whether the column has a unique constraint */
  isUnique: boolean;
  /** Default value if any */
  defaultValue?: any;
  /** Whether this is a navigation property (only present when includeNavigation is true) */
  isNavigation?: boolean;
  /** Navigation type: 'one' for reference, 'many' for collection (only for navigation properties) */
  navigationType?: 'one' | 'many';
  /** Target table name (only for navigation properties) */
  targetTable?: string;
}

/**
 * Order direction for orderBy clauses
 */
/**
 * A sort direction: `ASC` / `DESC`, optionally with where NULLs sort (PostgreSQL's default is NULLS
 * LAST for ASC and NULLS FIRST for DESC). Any case is accepted and normalized.
 */
export type OrderDirection = 'ASC' | 'DESC' | 'ASC NULLS FIRST' | 'ASC NULLS LAST' | 'DESC NULLS FIRST' | 'DESC NULLS LAST';

/**
 * A single field that can be used in orderBy.
 * At runtime, this is analyzed to extract the column reference.
 * The type is intentionally broad to support various usage patterns.
 */
export type OrderableField<T = unknown> = T;

/**
 * Order by specification with direction - a tuple of [field, direction]
 */
export type OrderByTuple<T = unknown> = [T, OrderDirection];

/**
 * Order by selector result - can be a single field, array of fields, or array of [field, direction] tuples
 */
export type OrderByResult<T = unknown> = T | T[] | Array<OrderByTuple<T>>;

/**
 * The section a log message belongs to — *what* is being logged — so a custom
 * logger can route or filter by category (e.g. drop `'sql'`, keep `'error'`).
 *
 * - `'sql'`     — the SQL query text
 * - `'params'`  — query parameters
 * - `'timing'`  — execution time / time-trace output
 * - `'slow'`    — a slow-query notice (see `onQueryTakingTooLong`)
 * - `'info'`    — general informational messages (migrations, etc.)
 * - `'warn'`    — warnings
 * - `'error'`   — errors
 */
export type LogSection = 'sql' | 'params' | 'timing' | 'slow' | 'info' | 'warn' | 'error';

/**
 * @deprecated Renamed to {@link LogSection}. The logger's second argument is now
 * the log *section* (what is being logged), not a severity level. Kept as an alias.
 */
export type LogLevel = LogSection;

/**
 * Default logger used when no custom `logger` is provided. Routes by section to
 * the appropriate console method.
 */
export function defaultLogger(message: string, section?: LogSection): void {
  if (section === 'error') {
    console.error(message);
  } else if (section === 'warn') {
    console.warn(message);
  } else {
    console.log(message);
  }
}

/**
 * Query execution options
 */
export interface QueryOptions {
  /** Enable SQL query logging */
  logQueries?: boolean;
  /**
   * Custom logger function (defaults to {@link defaultLogger}). The second
   * argument is the {@link LogSection} — what is being logged ('sql', 'params',
   * 'timing', 'error', ...) — so the logger can filter or route by category.
   */
  logger?: (message: string, section?: LogSection) => void;
  /** Log query execution time */
  logExecutionTime?: boolean;
  /** Log query parameters */
  logParameters?: boolean;
  /**
   * Report FAILED statements through the logger's `'error'` section — the driver's
   * message followed by the statement text (plus the parameters when {@link logParameters}
   * is on) — independently of {@link logQueries}. Lets a production context keep the
   * per-statement `'sql'`/`'params'` output off while every statement that fails is still
   * recorded. Default: the value of `logQueries`, so existing configurations are unchanged.
   */
  logFailedQueries?: boolean;
  /**
   * Run parameterised statements as NAMED server-side prepared statements (postgres.js
   * driver only): one statement per distinct SQL text per connection, parsed and planned
   * once, then reused — later executions skip planning and the describe round trip every
   * unnamed statement pays. Default: `false` (unnamed statements, today's behaviour).
   *
   * Opt in deliberately and measure: after five executions PostgreSQL may switch to a
   * GENERIC plan (`plan_cache_mode = auto`), which is right for OLTP statements whose
   * parameters have uniform selectivity and wrong for some wide analytical queries — a
   * 19 KB catalogue query measured slower prepared than unprepared. Override per query
   * with `.withPreparedStatements(false)` (or opt single hot queries IN on an unprepared
   * context with `.withPreparedStatements(true)`). Statements whose text changes per call
   * (`IN ($1, $2, …)` lists of varying length, VALUES lists) are cached per variant and
   * rarely reused; the bulk-insert legs (`insertWithChildren`, `insertBulkWithChildren`,
   * `MutationBatch`) therefore stay unnamed regardless of this option. Pair it with a
   * connection `max_lifetime` so per-connection statement caches are recycled.
   */
  preparedStatements?: boolean;
  /**
   * List length up to which `inArrayOpt` / `notInArrayOpt` render an `IN (…)` placeholder
   * list; longer lists bind as ONE array parameter (`= ANY($1::type[])`). Default 8 — see
   * `DEFAULT_IN_ARRAY_OPT_THRESHOLD` for the measurement behind it. PROCESS-WIDE: the
   * operators are plain functions used inside `where(...)` lambdas with no context in
   * reach, so constructing a context with this option writes
   * `LinkgressConfig.inArrayOptThreshold` for the whole process; the last context
   * constructed with the option wins. Setting `LinkgressConfig.inArrayOptThreshold`
   * directly is the same thing without a context.
   */
  inArrayOptThreshold?: number;
  /**
   * OPT-IN widths `inArrayOpt` / `notInArrayOpt` may render below the threshold: each list is
   * rounded up to the next rung and the gap filled by repeating its last element, so a band of
   * lengths shares one statement text instead of one each. Same rows either way. Omitted or
   * `null` keeps one placeholder per element. PROCESS-WIDE for the same reason as
   * `inArrayOptThreshold` — see `LinkgressConfig.inArrayPadBuckets` for the rung trade-off.
   */
  inArrayPadBuckets?: readonly number[] | null;
  /**
   * Whether the plain `inArray` / `notInArray` render what `inArrayOpt` / `notInArrayOpt`
   * render (the `IN (…)` list up to the threshold, `= ANY($1::type[])` above it). Default
   * `false` — `inArray` stays the exact-length operator. Turn it on to get the
   * statement-text economy across a codebase that already calls `inArray` everywhere; the
   * rows are identical either way. PROCESS-WIDE for the same reason as
   * `inArrayOptThreshold` — see `LinkgressConfig.inArrayUsesOpt`.
   */
  inArrayUsesOpt?: boolean;
  /** Collection aggregation strategy (default: 'lateral') */
  collectionStrategy?: CollectionStrategyType;
  /**
   * Disable automatic mapper transformations (fromDriver/toDriver).
   * When enabled, raw database values are returned without transformation.
   * Use this for performance-critical queries where you'll handle mapping manually.
   * Default: false
   */
  disableMappers?: boolean;
  /**
   * Enable binary protocol for query execution (when supported by driver).
   * Binary protocol can improve performance by avoiding string conversions.
   * Currently supported by: pg library with rowMode='array' or binary format.
   * Default: false (uses text protocol)
   */
  useBinaryProtocol?: boolean;
  /**
   * Return raw database result without any ORM processing.
   * When enabled, the raw rows from the database driver are returned as-is,
   * skipping all ORM transformations (mapping, result shaping, etc.).
   * Useful for debugging or when you need direct access to the database result.
   * Default: false
   */
  rawResult?: boolean;
  /**
   * Enable detailed time tracing for query phases.
   * When enabled, logs timing information for:
   * - Query building (SQL generation, context setup)
   * - Query execution (database round-trip)
   * - Result processing (transformation, mapping, merging)
   * Useful for performance debugging and optimization.
   * Default: false
   */
  traceTime?: boolean;
  /**
   * Callback invoked when a query's execution time exceeds its expected
   * threshold (the default {@link longRunningQueryThreshold}, or a per-query
   * `.expectedExecutionTime(ms)` override). Providing this callback enables
   * slow-query detection — which captures a call stack per query, so leave it
   * unset when you don't need it.
   *
   * The query still runs to completion (this is a diagnostic notice, not a
   * cancellation — use `.withTimeout()` to actually cancel). The callback
   * receives the SQL, params, duration, threshold, and the **user** call stack
   * that initiated the query (internal linkgress frames removed), so the top
   * frame is the code that called `.toList()` / `.firstOrDefault()` / etc.
   *
   * Errors thrown by the callback are swallowed so they cannot affect the query.
   */
  onQueryTakingTooLong?: (info: SlowQueryInfo) => void;
  /**
   * Threshold in milliseconds above which a query is considered "too long" and
   * {@link onQueryTakingTooLong} fires. Overridable per query with
   * `.expectedExecutionTime(ms)`. Default: 10000 (10s).
   */
  longRunningQueryThreshold?: number;
  /**
   * How many stack frames to capture per query for the slow-query report
   * (`SlowQueryInfo.stack`). The capture happens on EVERY query while slow-query
   * detection is active — it is the price of knowing the caller when one turns out
   * slow — and its cost grows with the depth captured (~1 ms per 50 queries at the
   * default depth on a deep async call chain). Lower it on hot paths, or set `0` to
   * skip the capture entirely (the callback still fires, with an empty stack).
   * Default: 50.
   */
  slowQueryStackTraceLimit?: number;
}

/**
 * Details passed to the {@link QueryOptions.onQueryTakingTooLong} callback when a
 * query runs longer than its expected execution time.
 */
export interface SlowQueryInfo {
  /** The SQL text that was executed. */
  sql: string;
  /** The query parameters, if any. */
  params?: any[];
  /** Actual execution time in milliseconds. */
  durationMs: number;
  /** The threshold that was exceeded, in milliseconds. */
  thresholdMs: number;
  /**
   * Call stack of the user code that initiated the query, with linkgress
   * internal frames removed — the top frame is the call site of the terminal
   * method (`.toList()`, `.firstOrDefault()`, `.count()`, ...). Empty string if
   * no user frames could be resolved.
   */
  stack: string;
}

/**
 * Options for {@link DataContext.transaction}.
 */
export interface TransactionOptions {
  /**
   * Statement timeout (ms) applied to EVERY statement in the transaction via
   * `SET LOCAL statement_timeout`, overriding the connection-level default for the
   * duration of the transaction (it auto-resets at COMMIT/ROLLBACK). Use this for
   * long-running units of work (batch jobs, exports) that would otherwise hit a
   * tight global default — it also covers bulk inserts/upserts that don't expose a
   * per-query `.withTimeout()`. `0` disables the timeout for the transaction. On
   * timeout a {@link QueryTimeoutError} is thrown.
   */
  timeoutMs?: number;
  /**
   * Slow-query "expected execution time" (ms) for statements in this transaction;
   * a statement running longer fires `onQueryTakingTooLong` (diagnostic only, no
   * cancellation). Defaults to `timeoutMs` when omitted, so a transaction with a
   * deliberately raised timeout doesn't also trip the global slow-query threshold.
   */
  expectedExecutionMs?: number;
}

/**
 * Basenames (without extension) of the linkgress source files that can appear in
 * a query's call stack between the public terminal method (`.toList()` etc.) and
 * the user's code. Internal frames are stripped from {@link SlowQueryInfo.stack}
 * by matching these file IDENTITIES — not an install path — so it works wherever
 * the package lives (node_modules, a monorepo, ts-node/ts-jest, a global link).
 */
const LINKGRESS_INTERNAL_FILES = new Set([
  'db-context',
  'query-builder',
  'grouped-query',
  'union-builder',
  'join-builder',
  'future-query',
  'prepared-query',
]);

/** Extract the source-file basename (without extension) from a V8 stack frame line. */
function stackFrameFile(line: string): string | undefined {
  // Matches the "<file>:<line>:<col>" tail, e.g.
  //   "    at SelectQueryBuilder.toList (C:\repo\src\query\query-builder.ts:2019:17)"
  //   "    at /repo/dist/entity/db-context.js:574:22"
  const match = line.match(/([^()\s]+):\d+:\d+\)?\s*$/);
  if (!match) return undefined;
  const base = match[1].split(/[\\/]/).pop();
  return base ? base.replace(/\.[cm]?[jt]s$/, '') : undefined;
}

/**
 * Capture a stack-trace holder cheaply — the `.stack` string is only formatted
 * on access, so this is paid for fully only when the query turns out slow. Call
 * it from within the user's synchronous call chain (before awaiting), so the
 * user's frames are present. Temporarily raises the capture depth so deep user
 * frames survive the internal frames sitting above them.
 */
function captureStackHolder(stackTraceLimit: number): { stack?: string } {
  const holder: { stack?: string } = {};
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = stackTraceLimit;
  if (typeof Error.captureStackTrace === 'function') {
    Error.captureStackTrace(holder, captureStackHolder);
  } else {
    holder.stack = new Error().stack;
  }
  Error.stackTraceLimit = previousLimit;
  return holder;
}

/**
 * Turn a captured stack into the user-facing call stack: drop the leading run of
 * linkgress-internal frames (identified by source-file basename, so it is robust
 * to wherever the package is installed and catches anonymous internal closures
 * too), leaving the user's terminal-method call site as the first frame. Falls
 * back to all frames if filtering would leave nothing.
 */
function extractUserStack(holder?: { stack?: string }): string {
  const raw = holder?.stack;
  if (!raw) return '';
  const frames = raw.split('\n').filter(line => line.trim().startsWith('at '));
  let i = 0;
  while (i < frames.length) {
    const file = stackFrameFile(frames[i]);
    if (file && LINKGRESS_INTERNAL_FILES.has(file)) {
      i++;
    } else {
      break;
    }
  }
  const userFrames = frames.slice(i);
  return (userFrames.length > 0 ? userFrames : frames).join('\n');
}

/**
 * Invoke the slow-query callback defensively: resolve the user stack lazily and
 * swallow any error from the callback so a diagnostic notice can never break the
 * query that triggered it.
 */
function fireSlowQueryCallback(
  callback: (info: SlowQueryInfo) => void,
  sql: string,
  params: any[] | undefined,
  durationMs: number,
  thresholdMs: number,
  stackHolder?: { stack?: string }
): void {
  let stack = '';
  try {
    stack = extractUserStack(stackHolder);
  } catch {
    /* ignore stack-extraction failures */
  }
  try {
    callback({ sql, params, durationMs, thresholdMs, stack });
  } catch {
    /* swallow — the slow-query notice must never affect the query */
  }
}

/**
 * Time trace entry for a single operation
 */
export interface TimeTraceEntry {
  phase: string;
  operation: string;
  durationMs: number;
  startTime: number;
  endTime: number;
  details?: Record<string, any>;
}

/**
 * Complete time trace for a query execution
 */
export interface QueryTimeTrace {
  totalMs: number;
  phases: {
    queryBuild?: number;
    queryExecution?: number;
    resultProcessing?: number;
  };
  entries: TimeTraceEntry[];
  rowCount?: number;
}

/**
 * Time tracer utility for measuring query phases
 */
export class TimeTracer {
  private entries: TimeTraceEntry[] = [];
  private startTime: number = 0;
  private currentPhase: string = '';
  private phaseStartTime: number = 0;
  private phases: Record<string, number> = {};

  constructor(private enabled: boolean, private logger?: (message: string, section?: LogSection) => void) {
    if (enabled) {
      this.startTime = performance.now();
    }
  }

  /**
   * Start timing a phase
   */
  startPhase(phase: string): void {
    if (!this.enabled) return;
    this.currentPhase = phase;
    this.phaseStartTime = performance.now();
  }

  /**
   * End timing a phase
   */
  endPhase(): number {
    if (!this.enabled) return 0;
    const duration = performance.now() - this.phaseStartTime;
    this.phases[this.currentPhase] = (this.phases[this.currentPhase] || 0) + duration;
    return duration;
  }

  /**
   * Time a specific operation within a phase
   */
  trace<T>(operation: string, fn: () => T, details?: Record<string, any>): T {
    if (!this.enabled) return fn();

    const opStart = performance.now();
    const result = fn();
    const opEnd = performance.now();
    const duration = opEnd - opStart;

    this.entries.push({
      phase: this.currentPhase,
      operation,
      durationMs: duration,
      startTime: opStart - this.startTime,
      endTime: opEnd - this.startTime,
      details,
    });

    return result;
  }

  /**
   * Time an async operation within a phase
   */
  async traceAsync<T>(operation: string, fn: () => Promise<T>, details?: Record<string, any>): Promise<T> {
    if (!this.enabled) return fn();

    const opStart = performance.now();
    const result = await fn();
    const opEnd = performance.now();
    const duration = opEnd - opStart;

    this.entries.push({
      phase: this.currentPhase,
      operation,
      durationMs: duration,
      startTime: opStart - this.startTime,
      endTime: opEnd - this.startTime,
      details,
    });

    return result;
  }

  /**
   * Get the complete trace
   */
  getTrace(rowCount?: number): QueryTimeTrace {
    const totalMs = performance.now() - this.startTime;
    return {
      totalMs,
      phases: {
        queryBuild: this.phases['queryBuild'],
        queryExecution: this.phases['queryExecution'],
        resultProcessing: this.phases['resultProcessing'],
      },
      entries: this.entries,
      rowCount,
    };
  }

  /**
   * Log the trace summary
   */
  logSummary(rowCount?: number): void {
    if (!this.enabled) return;

    const trace = this.getTrace(rowCount);
    const log = this.logger || defaultLogger;

    log('\n[Time Trace Summary]', 'timing');
    log(`  Total: ${trace.totalMs.toFixed(2)}ms`, 'timing');
    if (trace.phases.queryBuild !== undefined) {
      log(`  Query Build: ${trace.phases.queryBuild.toFixed(2)}ms`, 'timing');
    }
    if (trace.phases.queryExecution !== undefined) {
      log(`  Query Execution: ${trace.phases.queryExecution.toFixed(2)}ms`, 'timing');
    }
    if (trace.phases.resultProcessing !== undefined) {
      log(`  Result Processing: ${trace.phases.resultProcessing.toFixed(2)}ms`, 'timing');
    }
    if (rowCount !== undefined) {
      log(`  Rows: ${rowCount}`, 'timing');
    }

    // Log detailed entries if there are any significant operations
    const significantEntries = this.entries.filter(e => e.durationMs > 0.1);
    if (significantEntries.length > 0) {
      log('\n[Detailed Trace]', 'timing');
      for (const entry of significantEntries) {
        const details = entry.details ? ` (${JSON.stringify(entry.details)})` : '';
        log(`  [${entry.phase}] ${entry.operation}: ${entry.durationMs.toFixed(2)}ms${details}`, 'timing');
      }
    }
  }
}

/**
 * @deprecated Use QueryOptions instead
 */
export type LoggingOptions = QueryOptions;

/**
 * Query executor with optional logging
 */
export class QueryExecutor {
  constructor(
    private client: DatabaseClient,
    private options: QueryOptions = {},
    /**
     * Per-query timeout override (ms) set via `.withTimeout()`. Threaded down to
     * the driver as `QueryExecutionOptions.timeoutMs`. `undefined` means no
     * override (the connection-level default, if any, applies).
     */
    private overrideTimeoutMs?: number,
    /**
     * Per-query "expected execution time" override (ms) set via
     * `.expectedExecutionTime()`. If the query runs longer than this,
     * `onQueryTakingTooLong` fires. `undefined` means use the context default.
     */
    private overrideExpectedMs?: number,
    /**
     * Per-query prepared-statement override set via `.withPreparedStatements()`.
     * `undefined` means use the context's `preparedStatements` default.
     */
    private overridePrepare?: boolean
  ) {}

  /**
   * Build the per-query execution options (binary protocol, timeout override, prepared
   * statement), or `undefined` when none is set so the driver takes its fast path.
   * `execution` is a per-call override a caller passes when it knows the statement's
   * text is unique to this call (see {@link QueryOptions.preparedStatements}).
   */
  private buildExecutionOptions(execution?: Pick<QueryExecutionOptions, 'prepare'>): QueryExecutionOptions | undefined {
    const prepare = execution?.prepare ?? this.overridePrepare ?? this.options.preparedStatements;
    if (!this.options.useBinaryProtocol && this.overrideTimeoutMs === undefined && prepare !== true) {
      return undefined;
    }
    return {
      useBinaryProtocol: this.options.useBinaryProtocol,
      timeoutMs: this.overrideTimeoutMs,
      ...(prepare === true ? { prepare: true } : {}),
    };
  }

  /**
   * Return a new executor sharing this one's client and options but applying the
   * given per-query timeout override (ms). Pass `0` to disable the timeout for
   * the derived executor. Used by `.withTimeout()` on the query builders.
   */
  withTimeout(timeoutMs: number): QueryExecutor {
    return new QueryExecutor(this.client, this.options, timeoutMs, this.overrideExpectedMs, this.overridePrepare);
  }

  /**
   * Return a new executor that flags this query as expected to finish within
   * `expectedMs` — if it runs longer, `onQueryTakingTooLong` fires. Used by
   * `.expectedExecutionTime()` on the query builders.
   */
  withExpectedExecutionTime(expectedMs: number): QueryExecutor {
    return new QueryExecutor(this.client, this.options, this.overrideTimeoutMs, expectedMs, this.overridePrepare);
  }

  /**
   * Return a new executor that runs its statements as named server-side prepared
   * statements (`true`) or as unnamed statements (`false`), overriding the context's
   * `preparedStatements` default. Used by `.withPreparedStatements()` on tables and
   * accessors.
   */
  withPreparedStatements(prepare: boolean): QueryExecutor {
    return new QueryExecutor(this.client, this.options, this.overrideTimeoutMs, this.overrideExpectedMs, prepare);
  }

  /** Whether slow-query detection is active (a callback is configured). */
  private get slowQueryEnabled(): boolean {
    return typeof this.options.onQueryTakingTooLong === 'function';
  }

  /** Effective "too long" threshold for the current query (ms). */
  private get expectedExecutionMs(): number {
    return this.overrideExpectedMs ?? this.options.longRunningQueryThreshold ?? 10000;
  }

  /**
   * Begin timing/stack capture for a query. Returns `undefined` when neither
   * execution-time logging nor slow-query detection is active (zero overhead).
   * The stack is captured here — synchronously, inside the caller's call chain —
   * so the slow-query callback can report the user's code, not an async frame.
   */
  private beginTiming(): { startTime: number; stackHolder?: { stack?: string } } | undefined {
    if (!this.options.logExecutionTime && !this.slowQueryEnabled) {
      return undefined;
    }
    const stackTraceLimit = this.options.slowQueryStackTraceLimit ?? 50;
    const stackHolder = this.slowQueryEnabled && stackTraceLimit > 0 ? captureStackHolder(stackTraceLimit) : undefined;
    return { startTime: performance.now(), stackHolder };
  }

  /**
   * Finish timing: log execution time (if enabled) and fire the slow-query
   * callback (if enabled and the expected threshold was exceeded).
   */
  private finishTiming(
    timing: { startTime: number; stackHolder?: { stack?: string } } | undefined,
    logger: (message: string, section?: LogSection) => void,
    sql: string,
    params?: any[]
  ): void {
    if (!timing) return;
    const duration = performance.now() - timing.startTime;
    if (this.options.logExecutionTime) {
      logger(`[Execution Time] ${duration.toFixed(2)}ms`, 'timing');
    }
    const callback = this.options.onQueryTakingTooLong;
    if (callback && duration > this.expectedExecutionMs) {
      fireSlowQueryCallback(callback, sql, params, duration, this.expectedExecutionMs, timing.stackHolder);
    }
  }

  async query(sql: string, params?: any[], execution?: Pick<QueryExecutionOptions, 'prepare'>): Promise<QueryResult> {
    const logger = this.options.logger || defaultLogger;
    const timing = this.beginTiming();

    if (this.options.logQueries) {
      logger(`\n[SQL Query]`, 'sql');
      logger(sql.trim(), 'sql');

      if (this.options.logParameters && params && params.length > 0) {
        logger(`[Parameters] ${JSON.stringify(params)}`, 'params');
      }
    }

    try {
      const result = await this.client.query(sql, params, this.buildExecutionOptions(execution));
      this.finishTiming(timing, logger, sql, params);
      return result;
    } catch (error) {
      this.logFailure(logger, error, sql, params);
      throw error;
    }
  }

  /**
   * Execute a multi-statement query using the simple protocol (no parameters)
   * Only available for clients that support it (e.g., PostgresClient)
   */
  async querySimple(sql: string): Promise<QueryResult> {
    const logger = this.options.logger || defaultLogger;
    const timing = this.beginTiming();

    if (this.options.logQueries) {
      logger(`\n[SQL Query - Multi-Statement]`, 'sql');
      logger(sql.trim(), 'sql');
    }

    try {
      let result: QueryResult;
      if ('querySimple' in this.client && typeof (this.client as any).querySimple === 'function') {
        result = await (this.client as any).querySimple(sql);
      } else {
        // Fallback to regular query
        result = await this.client.query(sql, []);
      }
      this.finishTiming(timing, logger, sql);
      return result;
    } catch (error) {
      this.logFailure(logger, error, sql);
      throw error;
    }
  }

  /**
   * Execute a multi-statement query and return ALL result sets
   * Only available for PostgresClient
   */
  async querySimpleMulti(sql: string): Promise<QueryResult[]> {
    const logger = this.options.logger || defaultLogger;
    const timing = this.beginTiming();

    if (this.options.logQueries) {
      logger(`\n[SQL Query - Fully Optimized Multi-Statement]`, 'sql');
      logger(sql.trim(), 'sql');
    }

    try {
      // Check if client has querySimpleMulti method
      if ('querySimpleMulti' in this.client && typeof (this.client as any).querySimpleMulti === 'function') {
        const results = await (this.client as any).querySimpleMulti(sql);
        this.finishTiming(timing, logger, sql);
        return results;
      } else {
        throw new Error('querySimpleMulti not supported by this client');
      }
    } catch (error) {
      this.logFailure(logger, error, sql);
      throw error;
    }
  }

  /**
   * Whether these options call for an executor at all — any logging, failure reporting,
   * timing or slow-query duty. A context without any of them talks to the client directly.
   */
  static isNeeded(options?: QueryOptions): boolean {
    return !!options && !!(
      options.logQueries
      || options.logFailedQueries
      || options.logExecutionTime
      || options.onQueryTakingTooLong
      || options.preparedStatements
    );
  }

  /**
   * The `[SQL Error]` line for a failed statement: the driver's message, the statement text
   * and — only while `logParameters` is on — the parameters. Gated on `logFailedQueries`,
   * which defaults to `logQueries` (see {@link QueryOptions.logFailedQueries}).
   */
  private logFailure(
    logger: (message: string, section?: LogSection) => void,
    error: unknown,
    sql: string,
    params?: any[]
  ): void {
    if (!(this.options.logFailedQueries ?? this.options.logQueries)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const parameters = this.options.logParameters && params && params.length > 0
      ? `\n[Parameters] ${JSON.stringify(params)}`
      : '';
    logger(`[SQL Error] ${message}\n${sql.trim()}${parameters}`, 'error');
  }

  /**
   * Get the query options for this executor
   */
  getOptions(): QueryOptions {
    return this.options;
  }
}

/**
 * Conflict target for upsert operations
 */
export interface ConflictTarget {
  columns?: string[];
  constraint?: string;
}

/**
 * Insert configuration for bulk operations
 */
export interface InsertConfig {
  /**
   * Size of insert chunk. If not provided, auto-detected based on max PG query parameters limit
   */
  chunkSize?: number;

  /**
   * Use OVERRIDING SYSTEM VALUE to allow inserting into identity/serial columns
   */
  overridingSystemValue?: boolean;

  /**
   * Skip rows that would violate unique constraints (ON CONFLICT DO NOTHING)
   */
  onConflictDoNothing?: boolean;
}

/**
 * Upsert configuration
 */
export interface UpsertConfig {
  /**
   * Size of insert chunk for bulk upserts
   */
  chunkSize?: number;

  /**
   * Primary key columns for conflict detection. If not specified, table's primary keys are used
   */
  primaryKey?: string | string[];

  /**
   * Use OVERRIDING SYSTEM VALUE (auto-detected if not specified)
   */
  overridingSystemValue?: boolean;

  /**
   * WHERE clause for the conflict target
   */
  targetWhere?: string;

  /**
   * WHERE clause for the UPDATE SET
   */
  setWhere?: string;

  /**
   * Reference item to detect columns. If not specified, first value from array is used
   */
  referenceItem?: any;

  /**
   * List of column names that should be updated on conflict. If not specified, all non-PK columns are updated
   */
  updateColumns?: string[];

  /**
   * Filter function to determine if column should be updated on conflict
   */
  updateColumnFilter?: (columnName: string) => boolean;
}

/**
 * Returning clause configuration
 * - undefined: no RETURNING clause (returns void)
 * - true: return all columns
 * - selector function: return selected columns
 */
export type ReturningConfig<TEntity, TResult = unknown> =
  | undefined
  | true
  | ((entity: TEntity) => TResult);

/**
 * Helper type to infer the result type based on ReturningConfig
 * Note: Uses conditional types to properly infer return types
 */
export type ReturningResult<TEntity, TReturning> =
  TReturning extends undefined ? void :
  TReturning extends true ? TEntity :
  TReturning extends (entity: TEntity) => infer R ? R :
  TReturning extends (...args: any[]) => infer R ? R :
  never;

/**
 * Base type for returning option - used in method signatures
 */
export type ReturningOption<TEntity> = undefined | true | ((entity: TEntity) => any);

/**
 * Fluent insert operation that can be awaited directly or chained with .returning()
 *
 * @example
 * ```typescript
 * // No returning (default) - returns void
 * await db.users.insert({ username: 'alice' });
 *
 * // With returning() - returns full entity
 * const user = await db.users.insert({ username: 'alice' }).returning();
 *
 * // With returning(selector) - returns selected columns
 * const { id } = await db.users.insert({ username: 'alice' }).returning(u => ({ id: u.id }));
 * ```
 */
export interface FluentInsert<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the inserted row */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>>;
  /** Return selected columns from the inserted row */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<ReturningRow<TResult>>;
}

/**
 * The row a mutation's `.returning(selector)` resolves to. Columns unwrap exactly as
 * {@link UnwrapDbColumns} unwraps them; what a RETURNING projects besides them resolves the way a
 * SELECT row does — an `sql` expression or a collection aggregate (`b.editions.count()`) to its
 * value, a condition to a boolean, a collection (`.toList()`) to its items, a nested object field by
 * field. A selector returning ONE value (`ln => ln.note`, `ln => sql\`…\``) resolves to that value.
 */
export type ReturningRow<T> = T extends SqlFragment<infer V>
  ? V
  : T extends WhereConditionBase
    ? boolean
    : T extends DbColumn<any>
      ? UnwrapDbColumns<T>
      : T extends object
        ? IsValueType<T> extends true
          ? T
          : true extends HoldsReturningWrapper<T>
            ? UnwrapDbColumns<{ [K in keyof T]: ReturningField<T[K]> }>
            // Nothing to resolve in it: exactly as 1.0.x typed every RETURNING row
            : UnwrapDbColumns<T>
        : T;

/**
 * Whether a value a RETURNING projects holds something the read resolves — an `sql` expression, a
 * condition, a column — at any depth (up to 4 levels). Only such an object is resolved field by
 * field: any other object — a value type no type test recognizes as one (a Temporal type declared
 * only through augmentations: its methods were mapped to `{}`), a mapped column's object value —
 * stays as it is.
 */
type HoldsReturningWrapper<F, Depth extends unknown[] = []> = Depth['length'] extends 4
  ? false
  : F extends SqlFragment<any> | WhereConditionBase | DbColumn<any>
    ? true
    : F extends (...args: any[]) => any
      ? false
      : F extends readonly (infer U)[]
        ? HoldsReturningWrapper<U, [...Depth, unknown]>
        : F extends object
          ? true extends { [K in keyof F]-?: HoldsReturningWrapper<F[K], [...Depth, unknown]> }[keyof F] ? true : false
          : false;

/**
 * One field of a {@link ReturningRow}: what {@link UnwrapDbColumns} does not resolve by itself.
 * Distributes over a union — a nullable column (`DbColumn<Date> | null`, a `firstOrDefault()`'s
 * value) resolves to `Date | null`, where it used to keep the `DbColumn` wrapper.
 */
type ReturningField<F> = F extends SqlFragment<infer V>
  ? V
  : F extends WhereConditionBase
    ? boolean
    : F extends DbColumn<infer V>
      ? V
      : F extends DbEntity | null | undefined
        ? F
        : F extends readonly (infer U)[]
          ? ReturningRow<U>[]
          : F extends object
            ? IsValueType<F> extends true
              ? F
              : true extends HoldsReturningWrapper<F>
                ? ReturningRow<F>
                : F
            : F;

/**
 * Fluent insert many operation
 */
export interface FluentInsertMany<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the inserted rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the inserted rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<ReturningRow<TResult>[]>;
}

/**
 * Fluent update operation
 */
export interface FluentUpdate<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the updated rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the updated rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<ReturningRow<TResult>[]>;
}

/**
 * Fluent bulk update operation
 */
export interface FluentBulkUpdate<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the updated rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the updated rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<ReturningRow<TResult>[]>;
}

/**
 * Fluent upsert operation
 */
export interface FluentUpsert<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the upserted rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the upserted rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<ReturningRow<TResult>[]>;
}

/**
 * Fluent MERGE operation — same thenable/returning shape as {@link FluentUpsert}.
 * `returning()` on MERGE requires PostgreSQL 17+.
 */
export type FluentMerge<TEntity extends DbEntity> = FluentUpsert<TEntity>;

/**
 * Fluent delete operation for SelectQueryBuilder
 * Used with db.table.where(...).delete()
 *
 * `TRow` is what a `.returning(selector)` reads the deleted row as: over an entity table its
 * columns, navigations and collections (`EntityQuery`), so conditions, `sql` expressions and
 * collection aggregates over them type-check — it was typed as the row's plain values.
 */
export interface FluentDelete<TSelection, TRow = TSelection> extends PromiseLike<void> {
  /** Return the number of deleted rows */
  affectedCount(): PromiseLike<number>;
  /** Return all columns from the deleted rows */
  returning(): PromiseLike<TSelection[]>;
  /** Return selected columns from the deleted rows (SqlFragment fields unwrap to their value type) */
  returning<TResult>(selector: (row: TRow) => TResult): PromiseLike<UnwrapSelection<TResult>[]>;
  /**
   * Compile this DELETE into `{ sql, params }` WITHOUT executing it — same
   * WHERE/USING semantics as execution (navigation joins in the WHERE become
   * `DELETE … USING`, fragment-capable RETURNING included; navigation RETURNING
   * is not supported here). Attach the result as a data-modifying CTE via
   * {@link DbCteBuilder.withMutation}.
   */
  toStatement<TResult>(selector?: (row: TRow) => TResult): {
    sql: string;
    params: any[];
  };
}

/**
 * Fluent update operation for SelectQueryBuilder
 * Used with db.table.where(...).update(data)
 *
 * `TRow` is what a `.returning(selector)` reads the updated row as (see {@link FluentDelete}).
 */
export interface FluentQueryUpdate<TSelection, TRow = TSelection> extends PromiseLike<void> {
  /** Return the number of updated rows */
  affectedCount(): PromiseLike<number>;
  /** Return all columns from the updated rows */
  returning(): PromiseLike<TSelection[]>;
  /** Return selected columns from the updated rows (SqlFragment fields unwrap to their value type) */
  returning<TResult>(selector: (row: TRow) => TResult): PromiseLike<UnwrapSelection<TResult>[]>;
  /**
   * Compile this UPDATE into `{ sql, params }` WITHOUT executing it — same
   * SET/WHERE semantics as execution (SqlFragment values, fragment-capable
   * RETURNING; navigation RETURNING unsupported). Attach the result as a
   * data-modifying CTE via {@link DbCteBuilder.withMutation}.
   */
  toStatement<TResult>(selector?: (row: TRow) => TResult): { sql: string; params: any[] };
}

/**
 * Insert builder for upsert operations
 */
export class InsertBuilder<TSchema extends TableSchema> {
  private dataArray: Partial<InferTableType<TSchema>>[] = [];
  private conflictTarget?: ConflictTarget;
  private conflictAction: 'nothing' | 'update' = 'nothing';
  private updateColumns?: string[];
  private updateColumnFilter?: (columnName: string) => boolean;
  /** `doUpdate({ set })`: the values a conflicting row is updated TO, by property name */
  private setValues?: Record<string, unknown>;
  private targetWhereClause?: string;
  private setWhereClause?: string;
  private overridingSystemValue: boolean = false;

  constructor(
    private schema: TSchema,
    private client: DatabaseClient,
    private executor?: QueryExecutor
  ) {}

  /**
   * Set the values to insert (single row or multiple rows)
   */
  values(data: Partial<InferTableType<TSchema>> | Partial<InferTableType<TSchema>>[]): this {
    this.dataArray = Array.isArray(data) ? data : [data];
    return this;
  }

  /**
   * Specify conflict target (columns or constraint name)
   */
  onConflict(target?: ConflictTarget | string[]): this {
    if (Array.isArray(target)) {
      this.conflictTarget = { columns: target };
    } else {
      this.conflictTarget = target;
    }
    return this;
  }

  /**
   * Do nothing on conflict
   */
  doNothing(): this {
    this.conflictAction = 'nothing';
    return this;
  }

  /**
   * Update on conflict (upsert). Without options every inserted non-key column takes the proposed
   * row's value (`EXCLUDED`). `set` updates exactly its columns to its values — a value (through
   * the column's mapper), or an `sql` expression, which can read the proposed row as
   * `EXCLUDED."column"`. `set` used to name the columns only: they took the INSERTED values, and the
   * values given were dropped.
   */
  doUpdate(options?: {
    set?: Partial<InferTableType<TSchema>>;
    where?: string;
    updateColumns?: string[];
    updateColumnFilter?: (columnName: string) => boolean;
  }): this {
    this.conflictAction = 'update';
    if (options?.set) {
      this.setValues = options.set as Record<string, unknown>;
      this.updateColumns = Object.keys(options.set);
    }
    if (options?.updateColumns) {
      this.updateColumns = options.updateColumns;
    }
    if (options?.updateColumnFilter) {
      this.updateColumnFilter = options.updateColumnFilter;
    }
    if (options?.where) {
      this.setWhereClause = options.where;
    }
    return this;
  }

  /**
   * Set target WHERE clause for ON CONFLICT
   */
  targetWhere(where: string): this {
    this.targetWhereClause = where;
    return this;
  }

  /**
   * Enable OVERRIDING SYSTEM VALUE
   */
  setOverridingSystemValue(value: boolean = true): this {
    this.overridingSystemValue = value;
    return this;
  }

  /**
   * Execute the insert/upsert
   */
  async execute(): Promise<InferTableType<TSchema>[]> {
    if (this.dataArray.length === 0) {
      return [];
    }

    // Extract all unique column names from all data objects
    const columnSet = new Set<string>();
    for (const data of this.dataArray) {
      for (const key of Object.keys(data)) {
        const column = this.schema.columns[key];
        if (column) {
          const config = column.build();
          if (!config.autoIncrement) {
            columnSet.add(key);
          }
        }
      }
    }

    const columns = Array.from(columnSet);
    const values: any[] = [];
    const valuePlaceholders: string[] = [];
    const cellContext: SqlBuildContext = { paramCounter: 1, params: values };

    // Build placeholders for each row
    for (const data of this.dataArray) {
      const rowPlaceholders: string[] = [];
      for (const key of columns) {
        const column = this.schema.columns[key as string];
        rowPlaceholders.push(renderValuesCell((data as any)[key], column.build().mapper, cellContext));
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const columnNames = buildColumnNamesList(this.schema, columns);
    const returningColumns = buildReturningColumnList(this.schema);
    const qualifiedTableName = getQualifiedTableName(this.schema);

    let sql = `INSERT INTO ${qualifiedTableName} (${columnNames.join(', ')})`;

    // Add OVERRIDING SYSTEM VALUE if specified
    if (this.overridingSystemValue) {
      sql += '\n      OVERRIDING SYSTEM VALUE';
    }

    sql += `\n      VALUES ${valuePlaceholders.join(', ')}`;

    // Add conflict handling
    if (this.conflictTarget || this.conflictAction) {
      sql += '\n      ON CONFLICT';

      if (this.conflictTarget) {
        if (this.conflictTarget.columns) {
          const conflictCols = this.conflictTarget.columns.map(c => `"${c}"`).join(', ');
          sql += ` (${conflictCols})`;
        } else if (this.conflictTarget.constraint) {
          sql += ` ON CONSTRAINT ${this.conflictTarget.constraint}`;
        }
      }

      // Add target WHERE clause
      if (this.targetWhereClause) {
        sql += ` WHERE ${this.targetWhereClause}`;
      }

      if (this.conflictAction === 'nothing') {
        sql += ' DO NOTHING';
      } else if (this.conflictAction === 'update') {
        sql += ' DO UPDATE SET ';

        // Determine which columns to update
        let columnsToUpdate: string[];

        if (this.updateColumns) {
          // Use explicitly specified columns
          columnsToUpdate = this.updateColumns;
        } else if (this.updateColumnFilter) {
          // Use filter function
          columnsToUpdate = columns.filter(this.updateColumnFilter);
        } else {
          // Update all non-primary key columns
          columnsToUpdate = columns.filter(key => {
            const column = this.schema.columns[key];
            const config = column.build();
            return !config.primaryKey;
          });
        }

        const updateParts = columnsToUpdate.map(col => {
          const column = this.schema.columns[col];

          if (!column) {
            throw new Error(`doUpdate(): "${col}" is not a column of "${this.schema.name}"`);
          }

          const config = column.build();

          // A value `set` gives — numbered after the VALUES rows' parameters, as it follows them
          if (this.setValues && Object.prototype.hasOwnProperty.call(this.setValues, col)) {
            return `"${config.name}" = ${renderValuesCell(this.setValues[col], config.mapper, cellContext)}`;
          }

          return `"${config.name}" = EXCLUDED."${config.name}"`;
        });
        sql += updateParts.join(', ');

        if (this.setWhereClause) {
          sql += ` WHERE ${this.setWhereClause}`;
        }
      }
    }

    sql += `\n      RETURNING ${returningColumns}`;

    const result = this.executor
      ? await this.executor.query(sql, values)
      : await this.client.query(sql, values);
    return result.rows as InferTableType<TSchema>[];
  }
}

/**
 * Table accessor with query methods
 */
export class TableAccessor<TBuilder extends TableBuilder<any>> {
  private schema: TableSchema;

  constructor(
    private tableBuilder: TBuilder,
    private client: DatabaseClient,
    private schemaRegistry: Map<string, TableSchema>,
    private executor?: QueryExecutor,
    private collectionStrategy?: CollectionStrategyType
  ) {
    this.schema = tableBuilder.build();
  }

  /**
   * Configure query options for the current query chain
   * Returns a new TableAccessor instance with the specified options
   *
   * @example
   * ```typescript
   * const results = await db.users
   *   .withQueryOptions({ logQueries: true, collectionStrategy: 'temptable' })
   *   .select(u => ({ id: u.id, name: u.username }))
   *   .toList();
   * ```
   */
  withQueryOptions(options: QueryOptions): TableAccessor<TBuilder> {
    // Merge options with existing collectionStrategy
    const mergedStrategy = options.collectionStrategy ?? this.collectionStrategy;

    // Create new executor if logging options are provided
    let newExecutor = this.executor;
    if (QueryExecutor.isNeeded(options)) {
      newExecutor = new QueryExecutor(this.client, {
        ...options,
        collectionStrategy: mergedStrategy,
      });
    }

    // Return new instance with updated options
    return new TableAccessor(
      this.tableBuilder,
      this.client,
      this.schemaRegistry,
      newExecutor,
      mergedStrategy
    );
  }

  /**
   * Set a per-query timeout (ms) applied to every query and CRUD operation
   * started from the returned accessor. Each such query is wrapped individually
   * (`SET LOCAL statement_timeout`); pass `0` to disable. Overrides the
   * connection-level default. On timeout a `QueryTimeoutError` is thrown.
   *
   * @example
   * await db.users.withTimeout(5000).where(u => gt(u.id, 0)).toList();
   */
  withTimeout(timeoutMs: number): TableAccessor<TBuilder> {
    const newExecutor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return new TableAccessor(
      this.tableBuilder,
      this.client,
      this.schemaRegistry,
      newExecutor,
      this.collectionStrategy
    );
  }

  /**
   * Run every query started from the returned accessor as a named server-side prepared
   * statement (`true`) or as an unnamed statement (`false`), overriding the context's
   * `preparedStatements` default. See {@link QueryOptions.preparedStatements}.
   *
   * @example
   * await db.users.withPreparedStatements(false).where(u => gt(u.id, 0)).toList();
   */
  withPreparedStatements(prepare: boolean): TableAccessor<TBuilder> {
    const newExecutor = this.executor
      ? this.executor.withPreparedStatements(prepare)
      : new QueryExecutor(this.client, undefined, undefined, undefined, prepare);
    return new TableAccessor(
      this.tableBuilder,
      this.client,
      this.schemaRegistry,
      newExecutor,
      this.collectionStrategy
    );
  }

  /**
   * Mark queries started from the returned accessor as expected to finish within
   * `expectedMs` (ms). If a query runs longer, the context's
   * `onQueryTakingTooLong` callback fires — the query is NOT cancelled (use
   * `.withTimeout()` for that). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): TableAccessor<TBuilder> {
    const newExecutor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return new TableAccessor(
      this.tableBuilder,
      this.client,
      this.schemaRegistry,
      newExecutor,
      this.collectionStrategy
    );
  }

  /**
   * Start a select query with automatic type inference
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  select<TSelection>(
    selector: (row: InferRowType<TBuilder>) => TSelection
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    return new SelectQueryBuilder(this.schema, this.client, selector as any, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, undefined, this.schemaRegistry, undefined, this.collectionStrategy) as SelectQueryBuilder<UnwrapSelection<TSelection>>;
  }

  /**
   * Add WHERE condition before select
   */
  where(condition: (row: InferRowType<TBuilder>) => Condition): QueryBuilder<TableSchema, InferRowType<TBuilder>> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy, this.schemaRegistry);
    return qb.where(condition);
  }

  /**
   * Add CTEs (Common Table Expressions) to the query
   */
  with(...ctes: DbCte<any>[]): SelectQueryBuilder<InferRowType<TBuilder>> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy, this.schemaRegistry);
    return qb.with(...ctes);
  }

  /**
   * Left join with another table and selector
   */
  leftJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | import('../query/subquery').Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: InferRowType<TBuilder>, right: TRight) => Condition,
    selector: (left: InferRowType<TBuilder>, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy, this.schemaRegistry);
    return qb.leftJoin(rightTable, condition, selector, alias);
  }

  /**
   * Inner join with another table or subquery and selector
   */
  innerJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | import('../query/subquery').Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: InferRowType<TBuilder>, right: TRight) => Condition,
    selector: (left: InferRowType<TBuilder>, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy, this.schemaRegistry);
    return qb.innerJoin(rightTable, condition, selector, alias);
  }

  /**
   * Get table schema (internal use for joins)
   */
  _getSchema(): TableSchema {
    return this.schema;
  }

  /**
   * Get table schema
   */
  getSchema(): TableSchema {
    return this.schema;
  }

  /**
   * Get table name
   */
  getTableName(): string {
    return this.schema.name;
  }

  /**
   * Insert a row
   */
  async insert(data: Partial<InferTableType<TableSchema>>): Promise<InferTableType<TableSchema>> {
    const columns: string[] = [];
    const values: any[] = [];
    const placeholders: string[] = [];
    const cellContext: SqlBuildContext = { paramCounter: 1, params: values };

    for (const [key, value] of Object.entries(data)) {
      const column = this.schema.columns[key];
      if (column) {
        const config = column.build();
        // Skip auto-increment columns
        if (config.autoIncrement) {
          continue;
        }
        // Skip columns with undefined values if they have a default - let the DB use the default
        if (value === undefined && (config.default !== undefined || config.identity)) {
          continue;
        }
        columns.push(`"${config.name}"`);
        // An sql fragment inline, anything else through the column's toDriver mapper
        placeholders.push(renderValuesCell(value, config.mapper, cellContext));
      }
    }

    const returningColumns = buildReturningColumnList(this.schema);
    const qualifiedTableName = getQualifiedTableName(this.schema);
    const sql = `
      INSERT INTO ${qualifiedTableName} (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING ${returningColumns}
    `;

    const result = this.executor
      ? await this.executor.query(sql, values)
      : await this.client.query(sql, values);
    return result.rows[0] as InferTableType<TableSchema>;
  }

  /**
   * Bulk insert with advanced configuration
   */
  async insertBulk(
    value: Partial<InferTableType<TableSchema>> | Partial<InferTableType<TableSchema>>[],
    insertConfig?: InsertConfig
  ): Promise<InferTableType<TableSchema>[]> {
    const dataArray = Array.isArray(value) ? value : [value];

    if (dataArray.length === 0) {
      return [];
    }

    // Calculate chunk size based on max rows per batch
    const columnCount = Object.keys(dataArray[0]).length;
    const chunkSize = calculateOptimalChunkSize(columnCount, insertConfig?.chunkSize);

    // Check if we need to chunk
    if (dataArray.length > chunkSize) {
      const results: InferTableType<TableSchema>[] = [];

      for (let i = 0; i < dataArray.length; i += chunkSize) {
        const chunk = dataArray.slice(i, i + chunkSize);
        const chunkResults = await this.insertBulkSingle(chunk, insertConfig);
        results.push(...chunkResults);
      }

      return results;
    } else {
      return this.insertBulkSingle(dataArray, insertConfig);
    }
  }

  /**
   * Insert a single chunk (internal method)
   */
  private async insertBulkSingle(
    dataArray: Partial<InferTableType<TableSchema>>[],
    insertConfig?: InsertConfig
  ): Promise<InferTableType<TableSchema>[]> {
    if (dataArray.length === 0) {
      return [];
    }

    // Extract all unique column names from all data objects
    const columns = extractUniqueColumnKeys(
      dataArray as Record<string, any>[],
      this.schema,
      insertConfig?.overridingSystemValue
    );

    if (columns.length === 0) {
      return [];
    }

    const columnConfigs = buildColumnConfigs(this.schema, columns, insertConfig?.overridingSystemValue);
    const { valueClauses, params } = buildValuesClause(dataArray as Record<string, any>[], columnConfigs);
    const columnNames = columnConfigs.map(c => `"${c.dbName}"`);
    const returningColumns = buildReturningColumnList(this.schema);
    const qualifiedTableName = getQualifiedTableName(this.schema);

    let sql = `
      INSERT INTO ${qualifiedTableName} (${columnNames.join(', ')})`;

    // Add OVERRIDING SYSTEM VALUE if specified
    if (insertConfig?.overridingSystemValue) {
      sql += '\n      OVERRIDING SYSTEM VALUE';
    }

    sql += `
      VALUES ${valueClauses.join(', ')}`;

    // Add ON CONFLICT DO NOTHING if specified
    if (insertConfig?.onConflictDoNothing) {
      sql += '\n      ON CONFLICT DO NOTHING';
    }

    sql += `
      RETURNING ${returningColumns}
    `;

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);
    return result.rows as InferTableType<TableSchema>[];
  }

  /**
   * Upsert with advanced configuration
   */
  async upsertBulk(
    values: Partial<InferTableType<TableSchema>>[],
    config?: UpsertConfig
  ): Promise<InferTableType<TableSchema>[]> {
    if (values.length === 0) {
      return [];
    }

    const referenceItem = config?.referenceItem || values[0];

    // Determine primary keys
    const primaryKeys = config?.primaryKey
      ? (Array.isArray(config.primaryKey) ? config.primaryKey : [config.primaryKey])
      : detectPrimaryKeys(this.schema);

    // Auto-detect overridingSystemValue
    const overridingSystemValue = config?.overridingSystemValue ??
      hasAutoIncrementPrimaryKey(this.schema, Object.keys(referenceItem));

    // Determine which columns to update
    let updateColumnFilter = config?.updateColumnFilter;
    if (updateColumnFilter == null && config?.updateColumns) {
      const updateColSet = new Set(config.updateColumns);
      updateColumnFilter = (colId: string) => updateColSet.has(colId);
    }
    if (updateColumnFilter == null) {
      updateColumnFilter = (colId: string) => !primaryKeys.includes(colId);
    }

    // Calculate chunk size based on max rows per batch
    const columnCount = Object.keys(values[0]).length;
    const chunkSize = calculateOptimalChunkSize(columnCount, config?.chunkSize);

    // Check if we need to chunk
    if (values.length > chunkSize) {
      const results: InferTableType<TableSchema>[] = [];

      for (let i = 0; i < values.length; i += chunkSize) {
        const chunk = values.slice(i, i + chunkSize);
        const chunkResults = await this.upsertBulkSingle(
          chunk,
          primaryKeys,
          updateColumnFilter,
          overridingSystemValue || false,
          config?.targetWhere,
          config?.setWhere
        );
        results.push(...chunkResults);
      }

      return results;
    } else {
      return this.upsertBulkSingle(
        values,
        primaryKeys,
        updateColumnFilter,
        overridingSystemValue || false,
        config?.targetWhere,
        config?.setWhere
      );
    }
  }

  /**
   * Upsert a single chunk (internal method)
   */
  private async upsertBulkSingle(
    values: Partial<InferTableType<TableSchema>>[],
    primaryKeys: string[],
    updateColumnFilter: (colId: string) => boolean,
    overridingSystemValue: boolean,
    targetWhere?: string,
    setWhere?: string
  ): Promise<InferTableType<TableSchema>[]> {
    const builder = new InsertBuilder(this.schema, this.client, this.executor);
    builder.values(values);
    builder.setOverridingSystemValue(overridingSystemValue);
    builder.onConflict({ columns: primaryKeys });
    builder.doUpdate({ updateColumnFilter, where: setWhere });

    if (targetWhere) {
      builder.targetWhere(targetWhere);
    }

    return builder.execute();
  }

  /**
   * Insert with conflict resolution (upsert)
   */
  onConflictDoNothing(): InsertBuilder<TableSchema> {
    return new InsertBuilder(this.schema, this.client, this.executor);
  }

  /**
   * Insert with conflict resolution (upsert) - start building the upsert query
   */
  values(data: Partial<InferTableType<TableSchema>> | Partial<InferTableType<TableSchema>>[]): InsertBuilder<TableSchema> {
    const builder = new InsertBuilder(this.schema, this.client, this.executor);
    return builder.values(data);
  }

  /**
   * Update rows
   */
  async update(id: any, data: Partial<InferTableType<TableSchema>>): Promise<InferTableType<TableSchema> | null> {
    const setClauses: string[] = [];
    const values: any[] = [];
    const setContext: SqlBuildContext = { paramCounter: 1, params: values };

    // Find primary key
    let pkColumnName: string | undefined;
    for (const [key, col] of Object.entries(this.schema.columns)) {
      const config = (col as any).build();
      if (config.primaryKey) {
        pkColumnName = config.name;
        break;
      }
    }

    if (!pkColumnName) {
      throw new Error(`Table ${this.schema.name} has no primary key`);
    }

    for (const [key, value] of Object.entries(data)) {
      const column = this.schema.columns[key];
      if (column) {
        const config = column.build();
        if (!config.primaryKey) {
          // An sql fragment / condition / column inline, a value through the column's toDriver mapper
          setClauses.push(`"${config.name}" = ${renderAssignedValue(value, config.mapper, setContext)}`);
        }
      }
    }

    if (setClauses.length === 0) {
      return null;
    }

    const paramIndex = setContext.paramCounter;
    values.push(id);

    const returningColumns = Object.entries(this.schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = getQualifiedTableName(this.schema);
    const sql = `
      UPDATE ${qualifiedTableName}
      SET ${setClauses.join(', ')}
      WHERE "${pkColumnName}" = $${paramIndex}
      RETURNING ${returningColumns}
    `;

    const result = this.executor
      ? await this.executor.query(sql, values)
      : await this.client.query(sql, values);
    return result.rows.length > 0 ? result.rows[0] as InferTableType<TableSchema> : null;
  }

  /**
   * Delete a row by id
   */
  async delete(id: any): Promise<boolean> {
    // Find primary key
    let pkColumnName: string | undefined;
    for (const [key, col] of Object.entries(this.schema.columns)) {
      const config = (col as any).build();
      if (config.primaryKey) {
        pkColumnName = config.name;
        break;
      }
    }

    if (!pkColumnName) {
      throw new Error(`Table ${this.schema.name} has no primary key`);
    }

    const qualifiedTableName = getQualifiedTableName(this.schema);
    const sql = `DELETE FROM ${qualifiedTableName} WHERE "${pkColumnName}" = $1`;
    const result = this.executor
      ? await this.executor.query(sql, [id])
      : await this.client.query(sql, [id]);

    return result.rowCount !== null && result.rowCount > 0;
  }
}

/**
 * Schema definition for DataContext
 */
export type ContextSchema = {
  [tableName: string]: TableBuilder<any>;
};

/**
 * Infer table accessor types from schema with proper relation types
 */
export type InferContextSchema<T extends ContextSchema> = {
  [K in keyof T]: T[K] extends TableBuilder<any>
    ? TableAccessor<T[K]>
    : never;
};

/**
 * Render a fragment handed straight to `db.query()`: interpolated values become `$n` parameters, nested
 * fragments and `sql.join()` continue one numbering, `sql.raw()` text is inlined. A named
 * `sql.placeholder()` has no value outside a prepared query, so it is refused here rather than sent as a
 * dangling `$n`.
 */
function renderRawFragment(fragment: SqlFragment): { sql: string; params: any[] } {
  const context: SqlBuildContext = { paramCounter: 1, params: [] };
  const sql = fragment.buildSql(context);

  if (context.placeholders && context.placeholders.size > 0) {
    const names = Array.from(context.placeholders.keys()).join(', ');
    throw new Error(
      `db.query(sql\`...\`) cannot bind sql.placeholder() (${names}): placeholders only bind inside a prepared query (.prepare()). Interpolate the value instead.`
    );
  }

  return { sql, params: context.params };
}

/**
 * DataContext - main entry point for database operations
 */
/**
 * Render the value of a SET assignment written as an expression (upsert `updateSet`, bulk
 * update `set`): a fragment inline, a column ref qualified by its alias, a condition as a
 * boolean value, a plain value as a parameter through the column's mapper.
 */
function renderAssignedValue(value: unknown, mapper: any, context: SqlBuildContext): string {
  if (value instanceof SqlFragment) {
    return value.buildSql(context);
  }

  if (value instanceof WhereConditionBase) {
    return `(${value.buildSql(context)})`;
  }

  if (value && typeof value === 'object' && '__dbColumnName' in (value as object)) {
    const ref = value as { __tableAlias?: string; __dbColumnName: string };
    return ref.__tableAlias ? `"${ref.__tableAlias}"."${ref.__dbColumnName}"` : `"${ref.__dbColumnName}"`;
  }

  const bound = value === undefined ? null : value;
  context.params.push(mapper && typeof mapper.toDriver === 'function' ? mapper.toDriver(bound) : bound);
  return `$${context.paramCounter++}`;
}

/**
 * One cell of a VALUES row: an `sql` fragment inline, its parameters numbered in the statement's
 * sequence (`insert({ createdAt: sql\`now()\` })` — no table is in scope, so it must be
 * self-contained); anything else a parameter through the column's mapper. `cast` types the cell
 * (`::integer`). A fragment used to be bound AS a parameter: its JSON serialization was stored in
 * the column.
 */
function renderValuesCell(value: unknown, mapper: any, context: SqlBuildContext, cast: string = ''): string {
  if (value instanceof SqlFragment) {
    return `(${value.buildSql(context)})${cast}`;
  }

  const bound = value === undefined ? null : value;
  context.params.push(mapper && typeof mapper.toDriver === 'function' ? mapper.toDriver(bound) : bound);
  return `$${context.paramCounter++}${cast}`;
}

/** The column refs an assigned value reads (a bare ref, or the refs of a fragment / condition). */
function collectRefsOf(value: unknown): FieldRef[] {
  if (value instanceof WhereConditionBase) {
    return value.getFieldRefs();
  }

  if (value && typeof value === 'object' && '__dbColumnName' in (value as object)) {
    return [value as FieldRef];
  }

  return [];
}

/**
 * An advisory lock key: an integer, or a string hashed with PostgreSQL's `hashtext()`.
 * Single keys span the int8 range; each half of a (classId, key) pair the int4 range.
 */
export type AdvisoryLockKey = number | bigint | string;

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

function assertInt4(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < INT4_MIN || value > INT4_MAX) {
    throw new RangeError(`${name} must be an integer in the int4 range, got ${String(value)}`);
  }
}

/** A single advisory key as its exact decimal text (bound, then cast to bigint). */
function int8Param(name: string, value: unknown): string {
  if (typeof value === 'bigint') {
    if (value < INT8_MIN || value > INT8_MAX) {
      throw new RangeError(`${name} is outside the int8 range: ${value}`);
    }
    return value.toString();
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, a bigint or a string, got ${String(value)}`);
  }

  return String(value);
}

export class DataContext<TSchema extends ContextSchema = any> {
  protected client: DatabaseClient;
  private schemaRegistry = new Map<string, TableSchema>();
  private tableAccessors = new Map<string, TableAccessor<any>>();
  private executor?: QueryExecutor;
  private queryOptions?: QueryOptions;

  constructor(client: DatabaseClient, schema: TSchema, queryOptions?: QueryOptions) {
    this.client = client;
    this.queryOptions = queryOptions;

    // Create executor if logging is enabled
    if (QueryExecutor.isNeeded(queryOptions)) {
      this.executor = new QueryExecutor(client, queryOptions);
    }

    // inArrayOpt/notInArrayOpt are context-free functions; the options configure them process-wide.
    if (queryOptions?.inArrayOptThreshold !== undefined) {
      LinkgressConfig.inArrayOptThreshold = queryOptions.inArrayOptThreshold;
    }

    if (queryOptions?.inArrayPadBuckets !== undefined) {
      LinkgressConfig.inArrayPadBuckets = queryOptions.inArrayPadBuckets;
    }

    if (queryOptions?.inArrayUsesOpt !== undefined) {
      LinkgressConfig.inArrayUsesOpt = queryOptions.inArrayUsesOpt;
    }

    this.initializeSchema(schema);
  }

  /**
   * Initialize schema and create table accessors
   */
  private initializeSchema(schema: TSchema): void {
    for (const [key, tableBuilder] of Object.entries(schema)) {
      const tableSchema = tableBuilder.build();
      this.schemaRegistry.set(tableSchema.name, tableSchema);

      const accessor = new TableAccessor(tableBuilder, this.client, this.schemaRegistry, this.executor, this.queryOptions?.collectionStrategy);
      this.tableAccessors.set(key, accessor);

      // Attach to context (skip if property already has a getter on prototype chain)
      const descriptor = Object.getOwnPropertyDescriptor(this, key) ||
                        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), key);
      if (!descriptor || !descriptor.get) {
        (this as any)[key] = accessor;
      }
    }
  }

  /**
   * Get table accessor by name
   * When in a transaction, creates a fresh accessor with the transactional client
   */
  getTable<K extends keyof TSchema>(name: K): InferContextSchema<TSchema>[K] {
    const cachedAccessor = this.tableAccessors.get(name as string);
    if (!cachedAccessor) {
      throw new Error(`Table ${String(name)} not found in schema`);
    }

    // If in a transaction, create a new accessor with the current (transactional) client
    if (this.client.isInTransaction()) {
      return new TableAccessor(
        (cachedAccessor as any).tableBuilder,
        this.client,
        this.schemaRegistry,
        this.executor,
        this.queryOptions?.collectionStrategy
      ) as any;
    }

    return cachedAccessor as any;
  }

  /**
   * Execute a raw SQL statement and return its rows.
   *
   * Pass either SQL text with `$n` parameters, or a `sql` fragment: its interpolated values are bound as
   * parameters, nested fragments and `sql.join()` share one numbering, and `sql.raw()` text is inlined
   * as written.
   *
   * @example
   * ```typescript
   * // Untyped query
   * const result = await db.query('SELECT * FROM users');
   *
   * // Typed query - returns T[]
   * const users = await db.query<{ id: number; name: string }>('SELECT id, name FROM users');
   *
   * // With parameters
   * const user = await db.query<{ id: number }>('SELECT id FROM users WHERE name = $1', ['alice']);
   *
   * // As a fragment - the interpolated values become parameters
   * const adults = await db.query<{ id: number }>(sql`SELECT id FROM users WHERE age >= ${18}`);
   * ```
   */
  query<T = any>(fragment: SqlFragment): Promise<T[]>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  async query<T = any>(sqlOrFragment: string | SqlFragment, params?: any[]): Promise<T[]> {
    const statement = sqlOrFragment instanceof SqlFragment
      ? renderRawFragment(sqlOrFragment)
      : { sql: sqlOrFragment, params };
    const result = await this.client.query(statement.sql, statement.params);
    return result.rows as T[];
  }

  // --------------------------------------------------------------------------
  // Transaction-scoped advisory locks
  // --------------------------------------------------------------------------

  /**
   * `pg_advisory_xact_lock(key)` / `pg_advisory_xact_lock(classId, key)` — wait for and take an
   * exclusive advisory lock that is released automatically at COMMIT / ROLLBACK.
   *
   * Serializes concurrent units of work on a key that is not a row (an order being settled, an
   * import per partner) without a lock table. Must be called on the context
   * `db.transaction()` hands you: outside a transaction the lock would be released the moment
   * the statement ends, so it throws instead of silently locking nothing.
   *
   * Keys: one integer in the int8 range, or a pair of a class id and a key in the int4 range.
   * A string key is hashed with `hashtext()` — use it for natural keys (`'invoice-42'`), and
   * the pair form to keep unrelated lock families apart.
   *
   * @example
   * await db.transaction(async tx => {
   *   await tx.advisoryXactLock(LockClass.Invoice, invoiceId);
   *   // … check-then-write safely against every other holder of this lock
   * });
   */
  advisoryXactLock(key: AdvisoryLockKey): Promise<void>;
  advisoryXactLock(classId: number, key: AdvisoryLockKey): Promise<void>;
  async advisoryXactLock(first: AdvisoryLockKey, second?: AdvisoryLockKey): Promise<void> {
    const call = this.advisoryLockCall('advisoryXactLock', 'pg_advisory_xact_lock', first, second);
    await this.runLockStatement(`SELECT ${call.sql}`, call.params);
  }

  /**
   * `pg_try_advisory_xact_lock(…)` — take the lock if it is free, without waiting; `true` when
   * this transaction now holds it (or already did — advisory locks are re-entrant), `false`
   * when another session holds it. Same keys and transaction requirement as
   * {@link advisoryXactLock}.
   */
  tryAdvisoryXactLock(key: AdvisoryLockKey): Promise<boolean>;
  tryAdvisoryXactLock(classId: number, key: AdvisoryLockKey): Promise<boolean>;
  async tryAdvisoryXactLock(first: AdvisoryLockKey, second?: AdvisoryLockKey): Promise<boolean> {
    const call = this.advisoryLockCall('tryAdvisoryXactLock', 'pg_try_advisory_xact_lock', first, second);
    const result = await this.runLockStatement(`SELECT ${call.sql} AS "acquired"`, call.params);
    return result.rows[0]?.acquired === true;
  }

  /**
   * Take the transaction-scoped advisory lock of every key in ONE statement, in a fixed order
   * (duplicates removed, numbers ascending / strings in code-unit order), so two transactions
   * locking overlapping key sets can never deadlock on each other. All keys of one call must
   * be of one kind: integers (int4) or strings (hashed with `hashtext()`).
   *
   * @example
   * await db.transaction(async tx => {
   *   await tx.advisoryXactLockAll(LockClass.Order, orderIds);
   * });
   */
  async advisoryXactLockAll(classId: number, keys: readonly AdvisoryLockKey[]): Promise<void> {
    this.assertAdvisoryTransaction('advisoryXactLockAll');
    assertInt4('advisoryXactLockAll: classId', classId);

    if (!Array.isArray(keys)) {
      throw new TypeError('advisoryXactLockAll: keys must be an array');
    }

    if (keys.length === 0) {
      return;
    }

    const allStrings = keys.every(key => typeof key === 'string');
    const allNumbers = keys.every(key => typeof key === 'number' || typeof key === 'bigint');

    if (!allStrings && !allNumbers) {
      throw new TypeError('advisoryXactLockAll: keys must be all integers or all strings');
    }

    if (allStrings) {
      const unique = Array.from(new Set(keys as string[])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      await this.runLockStatement(
        'SELECT pg_advisory_xact_lock($1, hashtext(k)) FROM unnest(CAST($2 AS text[])) AS t(k)',
        [classId, toPgArrayLiteral(unique)]
      );
      return;
    }

    const numbers = (keys as Array<number | bigint>).map((key) => {
      const value = Number(key);
      assertInt4('advisoryXactLockAll: key', value);
      return value;
    });
    const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);

    await this.runLockStatement(
      'SELECT pg_advisory_xact_lock($1, k) FROM unnest(CAST($2 AS integer[])) AS t(k)',
      [classId, toPgArrayLiteral(unique)]
    );
  }

  /** Run a lock statement through the context's executor (logging, slow-query hooks) when it has one. */
  private runLockStatement(sql: string, params: any[]): Promise<QueryResult> {
    return this.executor ? this.executor.query(sql, params) : this.client.query(sql, params);
  }

  private assertAdvisoryTransaction(method: string): void {
    if (!this.client.isInTransaction()) {
      throw new Error(
        `${method}() takes a TRANSACTION-scoped lock — call it on the context db.transaction() hands you. `
        + 'Outside a transaction the lock would be released as soon as the statement ends.'
      );
    }
  }

  /** The `fn(…)` call text and params of an advisory lock over one key or a (classId, key) pair. */
  private advisoryLockCall(
    method: string,
    fn: string,
    first: AdvisoryLockKey,
    second: AdvisoryLockKey | undefined
  ): { sql: string; params: any[] } {
    this.assertAdvisoryTransaction(method);

    if (second === undefined) {
      if (typeof first === 'string') {
        return { sql: `${fn}(hashtext($1))`, params: [first] };
      }
      return { sql: `${fn}(CAST($1 AS bigint))`, params: [int8Param(`${method}: key`, first)] };
    }

    if (typeof first !== 'number') {
      throw new TypeError(`${method}: the class id of a key pair must be an integer`);
    }
    assertInt4(`${method}: classId`, first);

    if (typeof second === 'string') {
      return { sql: `${fn}($1, hashtext($2))`, params: [first, second] };
    }

    const key = Number(second);
    assertInt4(`${method}: key`, key);
    return { sql: `${fn}($1, $2)`, params: [first, key] };
  }

  /**
   * Start a query whose FROM root is a {@link DbCte} (rather than an entity
   * table), enabling join shapes the entity-anchored
   * `db.<table>.with(...).leftJoin(cte, …)` path cannot express — notably
   * `FULL OUTER` / `RIGHT` / `CROSS` joins and `ON TRUE` predicates between two
   * CTEs.
   *
   * @example
   * ```typescript
   * const cteBuilder = new DbCteBuilder();
   * const spend = cteBuilder.with('spend',
   *   db.orders
   *     .where(o => and(eq(o.userId, userId), eq(o.status, OrderState.PAID)))
   *     .select(o => ({ currency: o.currency, totalPrice: o.totalPrice }))
   *     .groupBy(o => ({ currency: o.currency }))
   *     .select(g => ({ currency: g.key.currency, totalPrice: g.sum(o => o.totalPrice) }))
   * );
   * const tier = cteBuilder.with('current_tier',
   *   db.tierAssignments
   *     .where(t => and(eq(t.userId, userId), eq(t.isCurrent, true)))
   *     .select(t => ({ currentTierId: t.tierId }))
   *     .limit(1)
   * );
   *
   * const rows = await db
   *   .selectFromCte(spend.cte)
   *   .fullOuterJoin(tier.cte, onTrue())
   *   .select((s, t) => ({
   *     currency: s.currency,
   *     totalPrice: s.totalPrice,
   *     currentTierId: t.currentTierId,
   *   }))
   *   .toList();
   * ```
   */
  selectFromCte<TRootColumns extends Record<string, any>>(
    rootCte: DbCte<TRootColumns>
  ): CteRootQueryBuilder<TRootColumns> {
    return new CteRootQueryBuilder(rootCte, this.client, this.executor);
  }

  /**
   * Get the underlying database client.
   * Useful for advanced operations like multi-statement queries in migrations.
   *
   * @example
   * ```typescript
   * // Execute multi-statement SQL
   * await db.getClient().querySimple(`
   *   ALTER TABLE users ADD COLUMN new_field TEXT;
   *   CREATE INDEX idx_users_new_field ON users(new_field);
   * `);
   * ```
   */
  getClient(): DatabaseClient {
    return this.client;
  }

  /**
   * Execute in transaction
   * Creates a scoped transactional context to avoid race conditions with concurrent transactions.
   * Each transaction gets its own isolated context instance with fresh table accessors.
   */
  async transaction<TResult>(
    fn: (ctx: this) => Promise<TResult>,
    options?: TransactionOptions
  ): Promise<TResult> {
    return await this.client.transaction(async (queryFn) => {
      // Create a transactional client that routes all queries through the transaction
      const txClient = new TransactionalClient(queryFn, this.client);

      // Raise the per-statement timeout for the WHOLE transaction up-front. `SET LOCAL`
      // is transaction-scoped (auto-resets at COMMIT/ROLLBACK) and applies to every
      // subsequent statement — including bulk inserts/upserts that don't expose a
      // per-query `.withTimeout()`. Clamp to a safe non-negative integer (it is
      // inlined into the SQL); `0` disables the timeout for the transaction.
      if (options?.timeoutMs !== undefined) {
        const ms = Math.max(0, Math.floor(Number(options.timeoutMs) || 0));
        await txClient.query(`SET LOCAL statement_timeout = ${ms}`);
      }

      // Within the transaction, raise the slow-query "expected" threshold so a
      // deliberately long unit of work doesn't trip the global threshold. Defaults
      // to the transaction timeout when not given explicitly.
      const expectedMs = options?.expectedExecutionMs ?? options?.timeoutMs;
      const optionsOverride = expectedMs !== undefined ? { longRunningQueryThreshold: expectedMs } : undefined;

      // Create an isolated transactional context instead of mutating this.client
      const txContext = this.createTransactionalContext(txClient, optionsOverride);

      return await fn(txContext);
    });
  }

  /**
   * Creates a scoped copy of this context with a different client.
   * Used internally for transaction isolation to prevent race conditions
   * when multiple transactions run concurrently.
   */
  protected createTransactionalContext(txClient: DatabaseClient, queryOptionsOverride?: Partial<QueryOptions>): this {
    // Create new instance preserving the prototype chain (including subclass methods/getters)
    const txContext = Object.create(Object.getPrototypeOf(this)) as this;

    // Set up the transactional client
    txContext.client = txClient;

    // Share read-only schema registry
    (txContext as any).schemaRegistry = this.schemaRegistry;

    // Merge any per-transaction option override (e.g. a raised slow-query threshold)
    // over the context's base options so the transaction's executor + accessors use it.
    const effectiveOptions: QueryOptions | undefined = queryOptionsOverride
      ? { ...(this.queryOptions ?? {}), ...queryOptionsOverride }
      : this.queryOptions;
    (txContext as any).queryOptions = effectiveOptions;

    // Create executor for the transactional client if logging is enabled
    if (QueryExecutor.isNeeded(effectiveOptions)) {
      (txContext as any).executor = new QueryExecutor(txClient, effectiveOptions);
    }

    // Create fresh table accessors bound to the transactional client
    (txContext as any).tableAccessors = new Map();
    for (const [key, accessor] of this.tableAccessors) {
      const newAccessor = new TableAccessor(
        (accessor as any).tableBuilder,
        txClient,
        this.schemaRegistry,
        (txContext as any).executor,
        effectiveOptions?.collectionStrategy
      );
      (txContext as any).tableAccessors.set(key, newAccessor);

      // Only attach as direct property if not a getter on the prototype
      // (DatabaseContext subclasses use getters like `get users()` that call this.table())
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), key);
      if (!descriptor?.get) {
        (txContext as any)[key] = newAccessor;
      }
    }

    // Copy subclass-specific fields (for DatabaseContext)
    if ('modelConfig' in this) {
      (txContext as any).modelConfig = (this as any).modelConfig;
    }
    // Fresh entityTables so DbEntityTable instances are created with txContext reference
    if ('entityTables' in this) {
      (txContext as any).entityTables = new Map();
    }
    if ('sequenceRegistry' in this) {
      (txContext as any).sequenceRegistry = (this as any).sequenceRegistry;
    }
    if ('sequenceInstances' in this) {
      (txContext as any).sequenceInstances = (this as any).sequenceInstances;
    }

    return txContext;
  }

  /**
   * Get schema manager for create/drop operations and automatic migrations.
   *
   * Pass `{ concurrentIndexes: true }` to force every index created during
   * `ensureCreated()` / `migrate()` to use `CREATE INDEX CONCURRENTLY` without
   * having to mark each index with `.concurrent()`. This must run outside a
   * transaction — PostgreSQL disallows `CONCURRENTLY` inside a transaction.
   *
   * `recreateChangedIndexes` (default `true`) makes `migrate()` drop + recreate
   * a same-named index whose definition no longer matches the model (operator
   * class, expressions, method, uniqueness, columns, partial predicate). Set it
   * to `false` for the legacy name-only behavior.
   */
  getSchemaManager(options?: { concurrentIndexes?: boolean; recreateChangedIndexes?: boolean }): DbSchemaManager {
    const { tables, views } = splitViewsFromRegistry(this.schemaRegistry, schema => renderViewDefinition(schema, this));
    return new DbSchemaManager(this.client, tables, {
      logQueries: this.queryOptions?.logQueries,
      logger: this.queryOptions?.logger,
      concurrentIndexes: options?.concurrentIndexes,
      recreateChangedIndexes: options?.recreateChangedIndexes,
      views,
    });
  }

  /**
   * Close database connection
   */
  async dispose(): Promise<void> {
    await this.client.end();
  }
}

/**
 * Typed upsert configuration for entities
 */
export type EntityUpsertConfig<TEntity extends DbEntity> = {
  /**
   * Size of insert chunk for bulk upserts
   */
  chunkSize?: number;

  /**
   * Primary key columns for conflict detection. If not specified, table's primary keys are used
   * Can be specified as property names (strings) or using lambda selectors
   */
  primaryKey?: keyof ExtractDbColumns<TEntity> | (keyof ExtractDbColumns<TEntity>)[] | ((entity: TEntity) => any);

  /**
   * Use OVERRIDING SYSTEM VALUE (auto-detected if not specified)
   */
  overridingSystemValue?: boolean;

  /**
   * WHERE clause for the conflict target
   */
  targetWhere?: string;

  /**
   * WHERE clause for the UPDATE SET
   */
  setWhere?: string;

  /**
   * Reference item to detect columns. If not specified, first value from array is used
   */
  referenceItem?: any;

  /**
   * List of columns that should be updated on conflict. Can be property names or lambda selectors
   */
  updateColumns?: (keyof ExtractDbColumns<TEntity>)[] | ((entity: TEntity) => Partial<ExtractDbColumns<TEntity>>);

  /**
   * Filter function to determine if column should be updated on conflict
   */
  updateColumnFilter?: (columnName: string) => boolean;

  /**
   * SET expressions for the conflict arm, computed from the row that is already there
   * (`existing`) and the row proposed for insertion (`excluded`):
   *
   * ```typescript
   * db.counters.upsertBulk(rows, {
   *   primaryKey: 'key',
   *   updateSet: (existing, excluded) => ({
   *     hits: add(existing.hits, excluded.hits),               // accumulate
   *     firstSeen: coalesce(existing.firstSeen, excluded.firstSeen), // keep the first non-null
   *   }),
   * });
   * // → ON CONFLICT ("key") DO UPDATE SET "hits" = ("counters"."hits" + "excluded"."hits"), …
   * ```
   *
   * Without `updateColumns` / `updateColumnFilter`, ONLY the columns named here are updated.
   * With them, the listed columns keep their `= EXCLUDED."col"` assignment and the ones named
   * here take their expression (an expression wins over a list entry for the same column).
   * Plain values bind through the column's mapper. Navigations are not available here.
   */
  updateSet?: (existing: EntityQuery<TEntity>, excluded: EntityQuery<TEntity>) => { [K in keyof ExtractDbColumns<TEntity>]?: unknown };

  /**
   * A typed `DO UPDATE … WHERE` condition over (`existing`, `excluded`): the conflicting row is
   * only updated when it holds — e.g. keep the newer version:
   * `(existing, excluded) => lt(existing.version, excluded.version)`. ANDed with `setWhere`.
   */
  updateWhere?: (existing: EntityQuery<TEntity>, excluded: EntityQuery<TEntity>) => Condition;
};

/**
 * Typed SET / WHERE expressions of an upsert's conflict arm (see
 * {@link EntityUpsertConfig.updateSet}). @internal
 */
interface UpsertExpressionConfig {
  updateSet?: (existing: any, excluded: any) => Record<string, unknown>;
  updateWhere?: (existing: any, excluded: any) => Condition;
}

/**
 * Typed SET / WHERE expressions of a bulk update (see {@link DbEntityTable.bulkUpdate}):
 * `target` is the row being updated (alias `t`), `values` the incoming VALUES row (alias `v`).
 */
export interface BulkUpdateExpressionConfig<TEntity extends DbEntity> {
  set?: (target: EntityQuery<TEntity>, values: EntityQuery<TEntity>) => { [K in keyof ExtractDbColumns<TEntity>]?: unknown };
  where?: (target: EntityQuery<TEntity>, values: EntityQuery<TEntity>) => Condition;
}

/**
 * Merge configuration for entity-level {@link DbEntityTable.mergeBulk}
 * (PostgreSQL `MERGE`, 15+).
 */
export type EntityMergeConfig<TEntity extends DbEntity> = {
  /**
   * Identity column(s) of THIS statement's match — rendered as
   * `ON t."col" = s."col" [AND …]`. Unlike `upsertBulk`'s `primaryKey`, no
   * unique index or constraint is consulted: MERGE matches on the join
   * condition alone. Required — the identity is always stated explicitly at
   * the call site.
   */
  on: keyof ExtractDbColumns<TEntity> | (keyof ExtractDbColumns<TEntity>)[] | ((entity: TEntity) => any);
  /**
   * Extra raw SQL ANDed into the match condition. The target row is aliased
   * `t`, the incoming source row `s` — qualify columns to avoid ambiguity,
   * e.g. `t."active" = TRUE`.
   */
  matchWhere?: string;
  /**
   * Size of insert chunk for bulk merges
   */
  chunkSize?: number;
  /**
   * Reference item to detect columns. If not specified, first value from array is used
   */
  referenceItem?: any;
  /**
   * Columns updated by the WHEN MATCHED arm. Can be property names or lambda
   * selectors. Defaults to every inserted column that is not part of `on`;
   * an explicitly empty selection renders `WHEN MATCHED THEN DO NOTHING`.
   */
  updateColumns?: (keyof ExtractDbColumns<TEntity>)[] | ((entity: TEntity) => Partial<ExtractDbColumns<TEntity>>);
  /**
   * Filter function to determine if column should be updated by WHEN MATCHED
   */
  updateColumnFilter?: (columnName: string) => boolean;
};

/**
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object. Used to prevent Date, Map, Set, etc. from being
 * treated as DbEntity.
 * Excludes DbColumn and SqlFragment which have valueOf but are not value types.
 */
type IsClassInstance<T> = T extends { __isDbColumn: true }
  ? false  // Exclude DbColumn
  : T extends SqlFragment<any>
  ? false  // Exclude SqlFragment
  : T extends { valueOf(): infer V }
  ? V extends T
    ? true
    : V extends number | string | boolean | bigint | symbol
    ? true
    : false
  : false;


/**
 * Check for types with known class method signatures
 */
type HasClassMethods<T> = T extends { getTime(): number }  // Date-like
  ? true
  : T extends { size: number; has(value: any): boolean }  // Set/Map-like
  ? true
  : T extends { byteLength: number }  // ArrayBuffer/TypedArray-like
  ? true
  : T extends { then(onfulfilled?: any): any }  // Promise-like
  ? true
  : T extends { message: string; name: string }  // Error-like
  ? true
  : T extends { exec(string: string): any }  // RegExp-like
  ? true
  : false;

/**
 * Combined check for value types that should not be treated as DbEntity
 */
type IsValueType<T> = IsClassInstance<T> extends true
  ? true
  : HasClassMethods<T> extends true
  ? true
  : false;

/**
 * Type helper to convert plain object values to FieldRefs for use in conditions
 * This is used when TSelection is not a DbEntity but needs to be used in where/join conditions
 */
type ToFieldRefs<T> = T extends object
  ? IsValueType<T> extends true
    ? FieldRef<string, T>  // Wrap value types directly in FieldRef
    : { [K in keyof T]: FieldRef<string, T[K]> }  // Wrap each property in FieldRef
  : FieldRef<string, T>;

/**
 * Type helper to build entity query type with navigation support
 * Preserves class instances (Date, Map, Set, etc.) as-is without recursively mapping them
 */
export type EntityQuery<TEntity extends DbEntity> = {
  [K in keyof TEntity]: TEntity[K] extends (infer U)[] | undefined
    ? U extends DbEntity
      ? EntityCollectionQuery<U>
      : TEntity[K]
    : IsValueType<NonNullable<TEntity[K]>> extends true
    ? TEntity[K]  // Preserve class instances (Date, Map, Set, Temporal, etc.) as-is
    : TEntity[K] extends DbEntity | undefined
    ? EntityQuery<NonNullable<TEntity[K]>>
    : TEntity[K];
};

/**
 * Collection query builder type for navigation collections
 */
export interface EntityCollectionQuery<TEntity extends DbEntity> {
  // Selection methods
  select<TSelection>(
    selector: (item: EntityQuery<TEntity>) => TSelection
  ): EntityCollectionQueryWithSelect<TEntity, TSelection>;

  selectDistinct<TSelection>(
    selector: (item: EntityQuery<TEntity>) => TSelection
  ): EntityCollectionQueryWithSelect<TEntity, TSelection>;

  // Filtering
  where(condition: (item: EntityQuery<TEntity>) => Condition): this;

  // Ordering and pagination
  orderBy<T>(selector: (item: EntityQuery<TEntity>) => T): this;
  orderBy<T>(selector: (item: EntityQuery<TEntity>) => T[]): this;
  orderBy<T>(selector: (item: EntityQuery<TEntity>) => Array<[T, OrderDirection]>): this;
  limit(count: number): this;
  offset(count: number): this;

  // Aggregations (return SqlFragment for automatic type resolution in selectors)
  min<TSelection>(selector: (item: EntityQuery<TEntity>) => TSelection): SqlFragment<number | null>;
  max<TSelection>(selector: (item: EntityQuery<TEntity>) => TSelection): SqlFragment<number | null>;
  sum<TSelection>(selector: (item: EntityQuery<TEntity>) => TSelection): SqlFragment<number | null>;
  count(): SqlFragment<number>;
  exists(): SqlFragment<boolean>;

  // Flattening
  selectMany<TInner extends DbEntity>(selector: (item: EntityQuery<TEntity>) => EntityCollectionQuery<TInner>): EntityCollectionQuery<TInner>;

  // Flattened list results (for single-column selections)
  toNumberList(asName?: string): number[];
  toStringList(asName?: string): string[];

  // Standard list result
  toList(asName?: string): TEntity[];

  // Single item result
  firstOrDefault(asName?: string): TEntity | null;
}

export interface EntityCollectionQueryWithSelect<TEntity extends DbEntity, TSelection> {
  // Filtering
  where(condition: (item: EntityQuery<TEntity>) => Condition): this;

  // Ordering and pagination
  orderBy<T>(selector: (item: TSelection) => T): this;
  orderBy<T>(selector: (item: TSelection) => T[]): this;
  orderBy<T>(selector: (item: TSelection) => Array<[T, OrderDirection]>): this;
  limit(count: number): this;
  offset(count: number): this;

  // Aggregations (work on already-selected columns)
  min(): Promise<TSelection | null>;
  max(): Promise<TSelection | null>;
  sum(): Promise<TSelection | null>;
  count(): Promise<number>;
  exists(): Promise<boolean>;

  // Flattened list results (for single-column selections)
  toNumberList(asName?: string): number[];
  toStringList(asName?: string): string[];

  // Standard list result
  toList(asName?: string): TSelection[];

  // Single item result
  firstOrDefault(asName?: string): TSelection | null;
}

/**
 * Interface for queryable entity collections that can be filtered with .where()
 * Use this type when you need to store a query in a variable and add more .where() conditions.
 *
 * @example
 * ```typescript
 * let query: IEntityQueryable<User> = db.users;
 * if (onlyActive) {
 *   query = query.where(u => eq(u.isActive, true));
 * }
 * if (minAge) {
 *   query = query.where(u => gte(u.age, minAge));
 * }
 * const results = await query.toList();
 * ```
 */
export interface IEntityQueryable<TEntity extends DbEntity> {
  /**
   * Set a per-query timeout (ms) for this query, overriding the connection-level
   * default. Only this query is wrapped (`SET LOCAL statement_timeout`); pass `0`
   * to disable. On timeout a `QueryTimeoutError` is thrown.
   */
  withTimeout(timeoutMs: number): IEntityQueryable<TEntity>;

  /**
   * Run this query as a named prepared statement (`true`) or unnamed (`false`), overriding
   * the context's `preparedStatements` default — available at any point of the chain, so
   * code that receives a built query (a paginated-grid helper) can opt it out. See
   * `QueryOptions.preparedStatements`.
   */
  withPreparedStatements(prepare: boolean): IEntityQueryable<TEntity>;

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires (the query is
   * NOT cancelled). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): IEntityQueryable<TEntity>;

  /**
   * Add a WHERE condition. Multiple where() calls are chained with AND logic.
   */
  where(condition: (entity: EntityQuery<TEntity>) => Condition): IEntityQueryable<TEntity>;

  /**
   * INNER JOIN used purely as a row FILTER — keeps the entity shape (no
   * selector), so scope-style predicates can hop across an N:1 FK in ONE
   * query level (e.g. loan ⋈ borrower_data). The optional
   * third callback contributes an extra WHERE predicate with the same
   * (left, right) arguments. Only the right table's COLUMNS are addressable
   * (no navigations). Joining a 1:N side duplicates left rows — use
   * exists()/inSubquery for semi-join semantics there.
   */
  joinFilter<TRight extends DbEntity>(
    rightTable: DbEntityTable<TRight>,
    on: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition
  ): IEntityQueryable<TEntity>;

  /**
   * {@link joinFilter} against a CTE — the right side addresses the CTE's
   * columns, and the CTE is auto-attached to the statement's WITH list.
   */
  joinFilter<TRightCols extends Record<string, any>>(
    rightTable: import('../query/cte-builder').DbCte<TRightCols>,
    on: (left: EntityQuery<TEntity>, right: TRightCols) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: TRightCols) => Condition
  ): IEntityQueryable<TEntity>;

  /**
   * LEFT JOIN used purely as a row FILTER — see joinFilter. Combine with an
   * IS NULL predicate in `filter` for anti-join shapes ("no matching right
   * row").
   */
  leftJoinFilter<TRight extends DbEntity>(
    rightTable: DbEntityTable<TRight>,
    on: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition
  ): IEntityQueryable<TEntity>;

  /** {@link leftJoinFilter} against a CTE — see the joinFilter CTE overload. */
  leftJoinFilter<TRightCols extends Record<string, any>>(
    rightTable: import('../query/cte-builder').DbCte<TRightCols>,
    on: (left: EntityQuery<TEntity>, right: TRightCols) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: TRightCols) => Condition
  ): IEntityQueryable<TEntity>;

  /**
   * Select specific fields from the entity
   */
  select<TSelection>(
    selector: (entity: EntityQuery<TEntity>) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;

  /**
   * Order by field(s)
   */
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => T): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => T[]): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => Array<[T, OrderDirection]>): IEntityQueryable<TEntity>;

  /**
   * Limit results
   */
  limit(count: number): IEntityQueryable<TEntity>;

  /**
   * Offset results
   */
  offset(count: number): IEntityQueryable<TEntity>;

  /**
   * Add CTEs (Common Table Expressions) to the query
   */
  with(...ctes: import('../query/cte-builder').DbCte<any>[]): IEntityQueryable<TEntity>;

  /**
   * Left join with another table, CTE, or subquery
   */
  leftJoin<TRight extends DbEntity, TSelection>(
    rightTable: DbEntityTable<TRight>,
    condition: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  leftJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: EntityQuery<TEntity>, right: TRight) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection,
    alias: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  leftJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/cte-builder').DbCte<TRight>,
    condition: (left: EntityQuery<TEntity>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;

  /**
   * Inner join with another table, CTE, or subquery
   */
  innerJoin<TRight extends DbEntity, TSelection>(
    rightTable: DbEntityTable<TRight>,
    condition: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  innerJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: EntityQuery<TEntity>, right: TRight) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection,
    alias: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  innerJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/cte-builder').DbCte<TRight>,
    condition: (left: EntityQuery<TEntity>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;

  /**
   * Execute query and return all results
   */
  toList(): Promise<UnwrapDbColumns<TEntity>[]>;

  /**
   * Execute query and return first result
   */
  first(): Promise<UnwrapDbColumns<TEntity>>;

  /**
   * Execute query and return first result or null if not found
   */
  firstOrDefault(): Promise<UnwrapDbColumns<TEntity> | null>;

  /**
   * Count matching records
   */
  count(): Promise<number>;

  /**
   * Execute query and return results with total count using COUNT(*) OVER().
   * Useful for pagination - gets data and total count in a single query.
   */
  countOver(): Promise<{ data: UnwrapDbColumns<TEntity>[]; totalCount: number }>;

  /**
   * Check if any rows match the query
   */
  exists(): Promise<boolean>;

  /**
   * Delete records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   */
  delete(): FluentDelete<UnwrapDbColumns<TEntity>, EntityQuery<TEntity>>;

  /**
   * Update records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * Accepts either a partial data object, or a function that receives the entity's
   * column proxy (so SqlFragment values can reference table columns). For example:
   * ```ts
   * .update(p => ({ integrationInfo: jsonbMerge(p.integrationInfo, patch) }))
   * ```
   */
  update(
    data: UpdateData<TEntity>
      | ((row: EntityQuery<TEntity>) => UpdateData<TEntity>)
  ): FluentQueryUpdate<UnwrapDbColumns<TEntity>, EntityQuery<TEntity>>;

  /**
   * Create a prepared query for efficient reusable parameterized execution
   */
  prepare<TParams extends Record<string, any> = Record<string, any>>(
    name: string
  ): PreparedQuery<UnwrapDbColumns<TEntity>, TParams>;

  // Future query methods for batch execution
  /**
   * Create a future query that will be executed later.
   * Use with FutureQueryRunner.runAsync() for batch execution in a single roundtrip.
   */
  future(): FutureQuery<UnwrapDbColumns<TEntity>>;

  /**
   * Create a future query that returns a single result or null.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   */
  futureFirstOrDefault(): FutureSingleQuery<UnwrapDbColumns<TEntity>>;

  /**
   * Create a future query that returns a count.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   */
  futureCount(): FutureCountQuery;
}

/**
 * Strongly-typed query builder for entities
 * Results automatically unwrap DbColumn<T> to T and SqlFragment<T> to T
 */
export interface EntitySelectQueryBuilder<TEntity extends DbEntity, TSelection> {
  /**
   * Set a per-query timeout (ms) for this query, overriding the connection-level
   * default. Only this query is wrapped (`SET LOCAL statement_timeout`); pass `0`
   * to disable. On timeout a `QueryTimeoutError` is thrown.
   */
  withTimeout(timeoutMs: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  /**
   * Run this query as a named prepared statement (`true`) or unnamed (`false`), overriding
   * the context's `preparedStatements` default. See `QueryOptions.preparedStatements`.
   */
  withPreparedStatements(prepare: boolean): EntitySelectQueryBuilder<TEntity, TSelection>;

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires (the query is
   * NOT cancelled). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  select<TNewSelection>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;

  selectDistinct<TNewSelection>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;

  where(
    condition: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>) => Condition
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  /** INNER JOIN as a pure row filter — selection shape preserved; see {@link IEntityQueryable.joinFilter}. */
  joinFilter<TRight extends DbEntity>(
    rightTable: DbEntityTable<TRight>,
    on: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: EntityQuery<TRight>) => Condition,
    filter?: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: EntityQuery<TRight>) => Condition
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  /** INNER JOIN as a pure row filter against a CTE — see the {@link IEntityQueryable.joinFilter} CTE overload. */
  joinFilter<TRightCols extends Record<string, any>>(
    rightTable: import('../query/cte-builder').DbCte<TRightCols>,
    on: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: TRightCols) => Condition,
    filter?: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: TRightCols) => Condition
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  /** LEFT JOIN as a pure row filter — selection shape preserved; see {@link IEntityQueryable.leftJoinFilter}. */
  leftJoinFilter<TRight extends DbEntity>(
    rightTable: DbEntityTable<TRight>,
    on: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: EntityQuery<TRight>) => Condition,
    filter?: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: EntityQuery<TRight>) => Condition
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  /** LEFT JOIN as a pure row filter against a CTE — see the {@link IEntityQueryable.leftJoinFilter} CTE overload. */
  leftJoinFilter<TRightCols extends Record<string, any>>(
    rightTable: import('../query/cte-builder').DbCte<TRightCols>,
    on: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: TRightCols) => Condition,
    filter?: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: TRightCols) => Condition
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  orderBy<T>(selector: (row: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => T): EntitySelectQueryBuilder<TEntity, TSelection>;
  orderBy<T>(selector: (row: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => T[]): EntitySelectQueryBuilder<TEntity, TSelection>;
  orderBy<T>(selector: (row: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => Array<[T, OrderDirection]>): EntitySelectQueryBuilder<TEntity, TSelection>;

  limit(count: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  offset(count: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  /**
   * Append `FOR UPDATE` (optionally `SKIP LOCKED` / `NOWAIT`) to the built
   * SELECT — a row-level lock making a following check+write in the SAME
   * transaction atomic against every other `forUpdate` reader of those rows
   * (DB-side TOCTOU guard; see SelectQueryBuilder.forUpdate for the full
   * contract). Pair with `.orderBy(...)` on a stable key when locking
   * multiple rows, to avoid deadlocks between concurrent lockers.
   */
  forUpdate(options?: { skipLocked?: boolean; noWait?: boolean }): EntitySelectQueryBuilder<TEntity, TSelection>;

  count(): Promise<number>;

  countOver(): Promise<{ data: ResolveCollectionResults<TSelection>[]; totalCount: number }>;

  exists(): Promise<boolean>;

  first(): Promise<ResolveCollectionResults<TSelection>>;

  firstOrDefault(): Promise<ResolveCollectionResults<TSelection> | null>;

  firstOrThrow(): Promise<ResolveCollectionResults<TSelection>>;

  // Overload for CTE - TRight is NOT a DbEntity, so we don't wrap it in EntityQuery
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: import('../query/cte-builder').DbCte<TRight>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;
  // Overload for Subquery
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight) => TNewSelection,
    alias: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;
  // Overload for DbEntity table
  leftJoin<TRight extends DbEntity, TNewSelection>(
    rightTable: DbEntityTable<TRight>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: EntityQuery<TRight>) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: EntityQuery<TRight>) => TNewSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;

  // Overload for CTE - TRight is NOT a DbEntity, so we don't wrap it in EntityQuery
  innerJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: import('../query/cte-builder').DbCte<TRight>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;
  // Overload for Subquery
  innerJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight) => TNewSelection,
    alias: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;
  // Overload for DbEntity table
  innerJoin<TRight extends DbEntity, TNewSelection>(
    rightTable: DbEntityTable<TRight>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>, right: EntityQuery<TRight>) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: EntityQuery<TRight>) => TNewSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;

  // Grouping
  groupBy<TGroupingKey>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TGroupingKey
  ): import('../query/grouped-query').GroupedQueryBuilder<TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, TGroupingKey>;

  // Aggregations
  min<TResult = TSelection>(selector?: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TResult): Promise<TResult | null>;
  max<TResult = TSelection>(selector?: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TResult): Promise<TResult | null>;
  sum<TResult = TSelection>(selector?: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TResult): Promise<TResult | null>;
  count(): Promise<number>;
  countOver(): Promise<{ data: ResolveCollectionResults<TSelection>[]; totalCount: number }>;
  exists(): Promise<boolean>;

  // Subquery conversion
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(mode?: TMode): import('../query/subquery').Subquery<
    TMode extends 'scalar' ? UnwrapDbColumns<TSelection> : TMode extends 'array' ? UnwrapDbColumns<TSelection>[] : UnwrapDbColumns<TSelection>,
    TMode
  >;

  // CTE support
  with(...ctes: import('../query/cte-builder').DbCte<any>[]): this;

  // Union operations
  /**
   * Combine this query with another using UNION (removes duplicates)
   *
   * @param query Another query with compatible selection type
   * @returns A UnionQueryBuilder for further chaining
   *
   * @example
   * ```typescript
   * const result = await db.users
   *   .select(u => ({ id: u.id, name: u.username }))
   *   .union(db.customers.select(c => ({ id: c.id, name: c.name })))
   *   .orderBy(r => r.name)
   *   .toList();
   * ```
   */
  union(query: EntitySelectQueryBuilder<any, TSelection> | SelectQueryBuilder<TSelection>): UnionQueryBuilder<TSelection>;

  /**
   * Combine this query with another using UNION ALL (keeps all rows including duplicates)
   *
   * @param query Another query with compatible selection type
   * @returns A UnionQueryBuilder for further chaining
   *
   * @example
   * ```typescript
   * // UNION ALL is faster than UNION as it doesn't need to remove duplicates
   * const allLogs = await db.errorLogs
   *   .select(l => ({ timestamp: l.createdAt, message: l.message }))
   *   .unionAll(db.infoLogs.select(l => ({ timestamp: l.createdAt, message: l.message })))
   *   .orderBy(r => r.timestamp)
   *   .toList();
   * ```
   */
  unionAll(query: EntitySelectQueryBuilder<any, TSelection> | SelectQueryBuilder<TSelection>): UnionQueryBuilder<TSelection>;

  /**
   * Build SQL for use in UNION queries (without ORDER BY, LIMIT, OFFSET)
   * @internal Used by UnionQueryBuilder
   */
  buildUnionSql(context: import('../query/conditions').SqlBuildContext): string;

  // Mutation methods (available after where())
  /**
   * Update records matching the current WHERE condition.
   *
   * Accepts either a partial data object, or a function that receives the entity's
   * column proxy (so SqlFragment values can reference table columns).
   */
  update(
    data: UpdateData<TEntity>
      | ((row: EntityQuery<TEntity>) => UpdateData<TEntity>)
  ): FluentQueryUpdate<TSelection>;
  delete(): FluentDelete<TSelection>;

  toList(): Promise<ResolveCollectionResults<TSelection>[]>;

  first(): Promise<ResolveCollectionResults<TSelection>>;

  firstOrDefault(): Promise<ResolveCollectionResults<TSelection> | null>;

  /**
   * Create a prepared query for efficient reusable parameterized execution
   */
  prepare<TParams extends Record<string, any> = Record<string, any>>(
    name: string
  ): PreparedQuery<ResolveCollectionResults<TSelection>, TParams>;

  // Future query methods for batch execution
  /**
   * Create a future query that will be executed later.
   * Use with FutureQueryRunner.runAsync() for batch execution in a single roundtrip.
   *
   * @returns A FutureQuery that can be executed individually or in a batch
   *
   * @example
   * ```typescript
   * const q1 = db.users.select(u => ({ id: u.id, name: u.username })).future();
   * const q2 = db.posts.select(p => ({ title: p.title })).future();
   *
   * // Execute in a single roundtrip
   * const [users, posts] = await FutureQueryRunner.runAsync([q1, q2]);
   * ```
   */
  future(): FutureQuery<ResolveCollectionResults<TSelection>>;

  /**
   * Create a future query that returns a single result or null.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   *
   * @returns A FutureSingleQuery that resolves to a single result or null
   *
   * @example
   * ```typescript
   * const q1 = db.users.where(u => eq(u.id, 1)).futureFirstOrDefault();
   * const q2 = db.posts.where(p => eq(p.id, 5)).futureFirstOrDefault();
   *
   * const [user, post] = await FutureQueryRunner.runAsync([q1, q2]);
   * // user: User | null, post: Post | null
   * ```
   */
  futureFirstOrDefault(): FutureSingleQuery<ResolveCollectionResults<TSelection>>;

  /**
   * Create a future query that returns a count.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   *
   * @returns A FutureCountQuery that resolves to a number
   *
   * @example
   * ```typescript
   * const q1 = db.users.futureCount();
   * const q2 = db.posts.futureCount();
   *
   * const [userCount, postCount] = await FutureQueryRunner.runAsync([q1, q2]);
   * ```
   */
  futureCount(): FutureCountQuery;
}

/**
 * DbEntity insert builder for upsert operations with proper typing
 */
export class EntityInsertBuilder<TEntity extends DbEntity> {
  /**
   * @param mapRows Reads the inserted rows as entities: property names, column mappers. The rows
   *   used to come back as the statement returned them — keyed by the COLUMN names, unmapped.
   */
  constructor(
    private builder: InsertBuilder<TableSchema>,
    private mapRows: (rows: any[]) => UnwrapDbColumns<TEntity>[] = rows => rows
  ) {}

  /**
   * Specify conflict target (columns or constraint name)
   */
  onConflict(target?: ConflictTarget | string[]): this {
    this.builder.onConflict(target);
    return this;
  }

  /**
   * Do nothing on conflict
   */
  doNothing(): this {
    this.builder.doNothing();
    return this;
  }

  /**
   * Update on conflict (upsert): every inserted non-key column to the proposed row's value, or —
   * with `set` — exactly the given columns to the given values (an `sql` expression can read the
   * proposed row as `EXCLUDED."column"`), or — with `updateColumns` — exactly those columns to the
   * proposed row's values. `where` is the DO UPDATE's condition, as SQL.
   */
  doUpdate(options?: { set?: UpdateData<TEntity>; updateColumns?: Array<keyof InsertData<TEntity> & string>; where?: string }): this {
    this.builder.doUpdate(options as any);
    return this;
  }

  /**
   * Execute the insert/upsert
   */
  async execute(): Promise<UnwrapDbColumns<TEntity>[]> {
    return this.mapRows(await this.builder.execute());
  }
}

/**
 * Table accessor with entity typing
 */
export class DbEntityTable<TEntity extends DbEntity> {
  constructor(
    private context: DataContext,
    private tableName: string,
    private tableBuilder: TableBuilder<any>
  ) {}

  /**
   * Get the table schema for this entity
   * @internal
   */
  _getSchema(): TableSchema {
    const schemaRegistry = (this.context as any).schemaRegistry as Map<string, TableSchema>;
    const schema = schemaRegistry.get(this.tableName);
    if (!schema) {
      throw new Error(`Schema not found for table ${this.tableName}`);
    }
    return schema;
  }

  /**
   * Get the database client
   * @internal
   */
  _getClient(): DatabaseClient {
    return (this.context as any).client;
  }

  /**
   * Get the query executor for logging
   * @internal
   */
  _getExecutor(): any {
    return (this.context as any).executor;
  }

  /**
   * Get the collection strategy
   * @internal
   */
  _getCollectionStrategy(): CollectionStrategyType | undefined {
    return (this.context as any).queryOptions?.collectionStrategy;
  }

  /**
   * Get the schema registry
   * @internal
   */
  _getSchemaRegistry(): Map<string, TableSchema> {
    return (this.context as any).schemaRegistry;
  }

  /**
   * Get information about all columns in this table.
   * By default returns metadata about database columns only, excluding navigation properties.
   *
   * @param options - Optional configuration
   * @param options.includeNavigation - If true, includes navigation properties in the result.
   *                                    Defaults to false (only database columns).
   *
   * @returns Array of column information objects
   *
   * @example
   * ```typescript
   * // Get only database columns (default)
   * const columns = db.users.getColumns();
   * // Returns: [
   * //   { propertyName: 'id', columnName: 'id', type: 'integer', isPrimaryKey: true, ... },
   * //   { propertyName: 'username', columnName: 'username', type: 'varchar', ... },
   * //   { propertyName: 'email', columnName: 'email', type: 'text', ... },
   * // ]
   *
   * // Include navigation properties
   * const allColumns = db.users.getColumns({ includeNavigation: true });
   * // Returns: [
   * //   { propertyName: 'id', columnName: 'id', type: 'integer', ... },
   * //   { propertyName: 'posts', isNavigation: true, navigationType: 'many', targetTable: 'posts' },
   * // ]
   *
   * // Get column names only
   * const columnNames = db.users.getColumns().map(c => c.propertyName);
   * // Returns: ['id', 'username', 'email', ...]
   *
   * // Get database column names
   * const dbColumnNames = db.users.getColumns().map(c => c.columnName);
   * // Returns: ['id', 'username', 'email', ...]
   * ```
   */
  getColumns(options?: { includeNavigation?: boolean }): ColumnInfo<TEntity>[] {
    const schema = this._getSchema();
    const columns: ColumnInfo<TEntity>[] = [];

    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build();
      columns.push({
        propertyName: propName as ExtractDbColumnKeys<TEntity>,
        columnName: config.name,
        type: config.type,
        isPrimaryKey: config.primaryKey || false,
        isAutoIncrement: config.autoIncrement || !!config.identity,
        isNullable: config.nullable !== false,
        isUnique: config.unique || false,
        defaultValue: config.default,
      });
    }

    // Add navigation properties if requested
    if (options?.includeNavigation && schema.relations) {
      for (const [relName, relConfig] of Object.entries(schema.relations)) {
        columns.push({
          propertyName: relName as ExtractDbColumnKeys<TEntity>,
          columnName: relName,  // Navigation properties don't have a real DB column name
          type: relConfig.type === 'many' ? 'collection' : 'reference',
          isPrimaryKey: false,
          isAutoIncrement: false,
          isNullable: !(relConfig as any).isMandatory,
          isUnique: false,
          isNavigation: true,
          navigationType: relConfig.type as 'one' | 'many',
          targetTable: relConfig.targetTable,
        });
      }
    }

    return columns;
  }

  /**
   * Get an array of all column property names (keys) for this entity.
   * Returns a strongly typed array where each element is a valid column key of TEntity.
   *
   * This is a convenience method equivalent to `getColumns().map(c => c.propertyName)`
   * but with better type inference.
   *
   * @param options - Optional configuration
   * @param options.includeNavigation - If true, includes navigation property names.
   *                                    Defaults to false (only database columns).
   *
   * @returns Array of column property names typed as ExtractDbColumnKeys<TEntity>
   *
   * @example
   * ```typescript
   * // Get only database column keys (default)
   * const keys = db.users.getColumnKeys();
   * // Type: ExtractDbColumnKeys<User>[] which is ('id' | 'username' | 'email' | ...)[]
   *
   * // Include navigation property names
   * const allKeys = db.users.getColumnKeys({ includeNavigation: true });
   * // Returns: ['id', 'username', 'email', 'posts', 'orders', ...]
   *
   * // Exclude primary key columns (useful for updates)
   * const updateableKeys = db.users.getColumnKeys({ includePrimaryKey: false });
   * // Returns: ['username', 'email', ...] (without 'id')
   *
   * // Use for dynamic property access
   * const user = await db.users.findOne(u => eq(u.id, 1));
   * for (const key of db.users.getColumnKeys()) {
   *   console.log(`${key}: ${user[key]}`); // TypeScript knows key is valid
   * }
   *
   * // Use for building dynamic queries
   * const columnKeys = db.users.getColumnKeys();
   * // columnKeys[0] is typed as 'id' | 'username' | 'email' | ...
   * ```
   */
  getColumnKeys(options?: { includeNavigation?: boolean; includePrimaryKey?: boolean }): ExtractDbColumnKeys<TEntity>[] {
    const schema = this._getSchema();
    let columnKeys: string[];

    // Filter out primary keys if includePrimaryKey is explicitly false
    if (options?.includePrimaryKey === false) {
      columnKeys = [];
      for (const [propName, colBuilder] of Object.entries(schema.columns)) {
        const config = (colBuilder as any).build();
        if (!config.primaryKey) {
          columnKeys.push(propName);
        }
      }
    } else {
      columnKeys = Object.keys(schema.columns);
    }

    if (options?.includeNavigation && schema.relations) {
      const relationKeys = Object.keys(schema.relations);
      return [...columnKeys, ...relationKeys] as ExtractDbColumnKeys<TEntity>[];
    }

    return columnKeys as ExtractDbColumnKeys<TEntity>[];
  }

  /**
   * Get an object containing all entity properties as DbColumn references.
   * Useful for building dynamic queries or accessing column metadata.
   *
   * @param options - Optional configuration
   * @param options.excludeNavigation - If true (default), excludes navigation properties.
   *                                    Set to false to include navigation properties.
   *
   * @returns Object with property names as keys and their DbColumn/navigation references as values
   *
   * @example
   * ```typescript
   * // Get all column properties (excludes navigation by default)
   * const cols = db.users.props();
   * // Use in select: db.users.select(u => ({ id: cols.id, name: cols.username }))
   *
   * // Include navigation properties
   * const allProps = db.users.props({ excludeNavigation: false });
   * ```
   */
  props(options?: { excludeNavigation?: boolean }): EntityQuery<TEntity> {
    const schema = this._getSchema();
    const excludeNav = options?.excludeNavigation !== false; // Default true

    // Create a temporary QueryBuilder to reuse the createMockRow logic
    const qb = new QueryBuilder(schema, this._getClient(), undefined, undefined, undefined, undefined, this._getExecutor(), undefined, undefined, this._getCollectionStrategy(), (this.context as any).schemaRegistry);
    const mockRow = qb._createMockRow();

    if (excludeNav) {
      // Filter out navigation properties, keep only columns
      const result: any = {};
      for (const propName of Object.keys(schema.columns)) {
        result[propName] = mockRow[propName];
      }
      return result as EntityQuery<TEntity>;
    }

    return mockRow as EntityQuery<TEntity>;
  }

  /**
   * Get qualified table name with schema prefix if specified
   * @internal
   */
  private _getQualifiedTableName(): string {
    const schema = this._getSchema();
    return schema.schema
      ? `"${schema.schema}"."${schema.name}"`
      : `"${schema.name}"`;
  }

  /**
   * Configure query options for the current query chain
   * Returns a new DbEntityTable instance with a modified context that has the specified options
   *
   * @example
   * ```typescript
   * const results = await db.users
   *   .withQueryOptions({ logQueries: true, collectionStrategy: 'temptable' })
   *   .select(u => ({ id: u.id, name: u.username }))
   *   .toList();
   * ```
   */
  withQueryOptions(options: QueryOptions): DbEntityTable<TEntity> {
    // Create a proxy context with modified options
    const originalContext = this.context;
    const originalOptions = (originalContext as any).queryOptions || {};
    const tableName = this.tableName;

    // Merge options
    const mergedOptions = { ...originalOptions, ...options };

    // Create new executor if logging options are provided
    let newExecutor = (originalContext as any).executor;
    if (QueryExecutor.isNeeded(mergedOptions)) {
      newExecutor = new QueryExecutor(
        (originalContext as any).client,
        mergedOptions
      );
    }

    // Create a proxy context that overrides queryOptions, executor, and getTable
    const proxyContext = new Proxy(originalContext, {
      get(target, prop) {
        if (prop === 'queryOptions') {
          return mergedOptions;
        }
        if (prop === 'executor') {
          return newExecutor;
        }
        if (prop === 'getTable') {
          return (name: string) => {
            // Get the original TableAccessor
            const originalAccessor = (target as any).tableAccessors.get(name);
            if (!originalAccessor) {
              return (target as any).getTable(name);
            }

            // If requesting this table, return a TableAccessor with updated options
            if (name === tableName) {
              const schemaRegistry = (target as any).schemaRegistry;
              const client = (target as any).client;
              const originalTableBuilder = (originalAccessor as any).tableBuilder;

              return new TableAccessor(
                originalTableBuilder,
                client,
                schemaRegistry,
                newExecutor,
                mergedOptions.collectionStrategy
              );
            }
            // Otherwise return the original table
            return originalAccessor;
          };
        }
        return (target as any)[prop];
      }
    });

    // Return new instance with proxy context
    return new DbEntityTable(proxyContext as any, this.tableName, this.tableBuilder);
  }

  /**
   * Set a per-query timeout (ms) applied to every query and CRUD operation
   * started from the returned table. Each such query is wrapped individually
   * (`SET LOCAL statement_timeout`); pass `0` to disable. Overrides the
   * connection-level default. On timeout a `QueryTimeoutError` is thrown.
   *
   * @example
   * await db.users.withTimeout(5000).where(u => gt(u.id, 0)).toList();
   */
  withTimeout(timeoutMs: number): DbEntityTable<TEntity> {
    return this._deriveWithExecutor((current, client) =>
      current ? current.withTimeout(timeoutMs) : new QueryExecutor(client, undefined, timeoutMs)
    );
  }

  /**
   * Run every query and CRUD operation started from the returned table as a named
   * server-side prepared statement (`true`) or as an unnamed statement (`false`),
   * overriding the context's `preparedStatements` default. Use `false` to keep a wide
   * analytical query on custom plans inside a prepared context, `true` to prepare a
   * single hot lookup on an unprepared one. See {@link QueryOptions.preparedStatements}.
   *
   * @example
   * await db.products.withPreparedStatements(false).where(p => eq(p.active, true)).toList();
   */
  withPreparedStatements(prepare: boolean): DbEntityTable<TEntity> {
    return this._deriveWithExecutor((current, client) =>
      current ? current.withPreparedStatements(prepare) : new QueryExecutor(client, undefined, undefined, undefined, prepare)
    );
  }

  /**
   * Mark queries started from the returned table as expected to finish within
   * `expectedMs` (ms). If a query runs longer, the context's
   * `onQueryTakingTooLong` callback fires — the query is NOT cancelled (use
   * `.withTimeout()` for that). Overrides the context's `longRunningQueryThreshold`.
   *
   * @example
   * await db.users.expectedExecutionTime(2000).where(u => gt(u.id, 0)).toList();
   */
  expectedExecutionTime(expectedMs: number): DbEntityTable<TEntity> {
    return this._deriveWithExecutor((current, client) =>
      current ? current.withExpectedExecutionTime(expectedMs) : new QueryExecutor(client, undefined, undefined, expectedMs)
    );
  }

  /**
   * Build a derived table whose context surfaces a transformed executor (via a
   * proxy context, threaded into this table's accessor). Shared by
   * `.withTimeout()` and `.expectedExecutionTime()`.
   * @internal
   */
  private _deriveWithExecutor(
    makeExecutor: (current: QueryExecutor | undefined, client: DatabaseClient) => QueryExecutor
  ): DbEntityTable<TEntity> {
    const originalContext = this.context;
    const tableName = this.tableName;
    const client = (originalContext as any).client as DatabaseClient;
    const newExecutor = makeExecutor((originalContext as any).executor as QueryExecutor | undefined, client);
    const collectionStrategy = (originalContext as any).queryOptions?.collectionStrategy;

    const proxyContext = new Proxy(originalContext, {
      get(target, prop) {
        if (prop === 'executor') {
          return newExecutor;
        }
        if (prop === 'getTable') {
          return (name: string) => {
            const originalAccessor = (target as any).tableAccessors.get(name);
            if (!originalAccessor) {
              return (target as any).getTable(name);
            }
            if (name === tableName) {
              const schemaRegistry = (target as any).schemaRegistry;
              const originalTableBuilder = (originalAccessor as any).tableBuilder;
              return new TableAccessor(
                originalTableBuilder,
                client,
                schemaRegistry,
                newExecutor,
                collectionStrategy
              );
            }
            return originalAccessor;
          };
        }
        return (target as any)[prop];
      }
    });

    return new DbEntityTable(proxyContext as any, this.tableName, this.tableBuilder);
  }

  /**
   * Select all records - returns full entities with unwrapped DbColumns
   */
  async toList(): Promise<UnwrapDbColumns<TEntity>[]> {
    const queryBuilder = this.context.getTable(this.tableName);
    const schema = this._getSchema();

    // Build SELECT with all columns
    const columns = Object.entries(schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `SELECT ${columns} FROM ${qualifiedTableName}`;

    const executor = this._getExecutor();
    const client = this._getClient();

    const result = executor
      ? await executor.query(sql, [])
      : await client.query(sql, []);

    return this.mapResultsToEntities(result.rows);
  }

  /**
   * Get first record
   * @throws Error if no records exist
   */
  async first(): Promise<UnwrapDbColumns<TEntity>> {
    const queryBuilder = this.context.getTable(this.tableName);
    const schema = this._getSchema();

    // Build SELECT with all columns and LIMIT 1
    const columns = Object.entries(schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `SELECT ${columns} FROM ${qualifiedTableName} LIMIT 1`;

    const executor = this._getExecutor();
    const client = this._getClient();

    const result = executor
      ? await executor.query(sql, [])
      : await client.query(sql, []);

    if (result.rows.length === 0) {
      throw new Error('Sequence contains no elements');
    }

    const mapped = this.mapResultsToEntities(result.rows);
    return mapped[0];
  }

  /**
   * Get first record or null if none exist
   */
  async firstOrDefault(): Promise<UnwrapDbColumns<TEntity> | null> {
    const queryBuilder = this.context.getTable(this.tableName);
    const schema = this._getSchema();

    // Build SELECT with all columns and LIMIT 1
    const columns = Object.entries(schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `SELECT ${columns} FROM ${qualifiedTableName} LIMIT 1`;

    const executor = this._getExecutor();
    const client = this._getClient();

    const result = executor
      ? await executor.query(sql, [])
      : await client.query(sql, []);

    if (result.rows.length === 0) {
      return null;
    }

    const mapped = this.mapResultsToEntities(result.rows);
    return mapped[0];
  }

  /**
   * Count all records
   */
  async count(): Promise<number> {
    const schema = this._getSchema();
    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `SELECT COUNT(*) as count FROM ${qualifiedTableName}`;

    const executor = this._getExecutor();
    const client = this._getClient();

    const result = executor
      ? await executor.query(sql, [])
      : await client.query(sql, []);

    return parseInt(result.rows[0].count);
  }

  /**
   * Execute query and return results with total count using COUNT(*) OVER().
   * Useful for pagination - gets data and total count in a single query.
   */
  async countOver(): Promise<{ data: UnwrapDbColumns<TEntity>[]; totalCount: number }> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.countOver();
  }

  /**
   * Check if any records exist
   */
  async exists(): Promise<boolean> {
    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `SELECT EXISTS(SELECT 1 FROM ${qualifiedTableName})`;

    const executor = this._getExecutor();
    const client = this._getClient();

    const result = executor
      ? await executor.query(sql, [])
      : await client.query(sql, []);

    return result.rows[0].exists === true;
  }

  /**
   * Order by field(s)
   */
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => T): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => T[]): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => Array<[T, OrderDirection]>): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => OrderByResult<T>): IEntityQueryable<TEntity> {
    return (this.selectAllQuery() as any).orderBy(selector) as IEntityQueryable<TEntity>;
  }

  /**
   * Limit results
   */
  limit(count: number): IEntityQueryable<TEntity> {
    return (this.selectAllQuery() as any).limit(count) as IEntityQueryable<TEntity>;
  }

  /**
   * Offset results
   */
  offset(count: number): IEntityQueryable<TEntity> {
    return (this.selectAllQuery() as any).offset(count) as IEntityQueryable<TEntity>;
  }

  /**
   * The select-all query `orderBy` / `limit` / `offset` continue from — the same row `where` starts
   * with (see createSelectAllRow): the columns as the default projection, and every navigation still
   * reachable from the next `orderBy` / `where` / `select`. The columns-only object these used to
   * start from dropped the navigations: an ORDER BY through one silently vanished (`ln.book.name`
   * read `undefined`) or threw (`ln.edition.book`), and so did a chained `.select(m => m.loans…)`.
   */
  private selectAllQuery(): unknown {
    const schema = this._getSchema();

    return this.context.getTable(this.tableName).select((e: any) => createSelectAllRow(schema, e));
  }

  /**
   * Select query
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  select<TSelection>(
    selector: (entity: EntityQuery<TEntity>) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>> {
    const queryBuilder = this.context.getTable(this.tableName).select(selector as any);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  }

  /**
   * Select distinct
   * UnwrapSelection extracts the value types, as for select() — a distinct column (`e => e.bookId`)
   * reads as its values
   */
  selectDistinct<TSelection>(
    selector: (entity: EntityQuery<TEntity>) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>> {
    const queryBuilder = this.context.getTable(this.tableName);
    // First select, then call selectDistinct to get a new builder with isDistinct=true
    const selectBuilder = queryBuilder.select(selector as any);
    const distinctBuilder = selectBuilder.selectDistinct((x: any) => x);
    return distinctBuilder as any as EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  }

  /**
   * Where query - returns all columns by default
   */
  where(
    condition: (entity: EntityQuery<TEntity>) => Condition
  ): IEntityQueryable<TEntity> {
    const schema = this._getSchema();

    // Own enumerable columns + navigation getters inherited from the per-schema prototype
    // (see createSelectAllRow): the chained-selector surface is unchanged, the default
    // projection stays columns-only.
    const allColumnsSelector = (e: any) => createSelectAllRow(schema, e);

    const queryBuilder = this.context.getTable(this.tableName)
      .where(condition as any)
      .select(allColumnsSelector);
    return queryBuilder as any as IEntityQueryable<TEntity>;
  }

  /**
   * INNER JOIN as a pure row filter directly off the table — see
   * {@link IEntityQueryable.joinFilter}.
   */
  joinFilter<TRight extends DbEntity>(
    rightTable: DbEntityTable<TRight>,
    on: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition
  ): IEntityQueryable<TEntity>;
  /** {@link joinFilter} against a CTE — see the {@link IEntityQueryable.joinFilter} CTE overload. */
  joinFilter<TRightCols extends Record<string, any>>(
    rightTable: import('../query/cte-builder').DbCte<TRightCols>,
    on: (left: EntityQuery<TEntity>, right: TRightCols) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: TRightCols) => Condition
  ): IEntityQueryable<TEntity>;
  joinFilter(
    rightTable: any,
    on: (left: any, right: any) => Condition,
    filter?: (left: any, right: any) => Condition
  ): IEntityQueryable<TEntity> {
    return (this.asEntityQueryable() as any).joinFilter(
      rightTable,
      on,
      filter,
    );
  }

  /**
   * LEFT JOIN as a pure row filter directly off the table — see
   * {@link IEntityQueryable.leftJoinFilter}.
   */
  leftJoinFilter<TRight extends DbEntity>(
    rightTable: DbEntityTable<TRight>,
    on: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition
  ): IEntityQueryable<TEntity>;
  /** {@link leftJoinFilter} against a CTE — see the {@link IEntityQueryable.leftJoinFilter} CTE overload. */
  leftJoinFilter<TRightCols extends Record<string, any>>(
    rightTable: import('../query/cte-builder').DbCte<TRightCols>,
    on: (left: EntityQuery<TEntity>, right: TRightCols) => Condition,
    filter?: (left: EntityQuery<TEntity>, right: TRightCols) => Condition
  ): IEntityQueryable<TEntity>;
  leftJoinFilter(
    rightTable: any,
    on: (left: any, right: any) => Condition,
    filter?: (left: any, right: any) => Condition
  ): IEntityQueryable<TEntity> {
    return (this.asEntityQueryable() as any).leftJoinFilter(
      rightTable,
      on,
      filter,
    );
  }

  /**
   * Entity queryable over all rows (select-all shape) — shared bootstrap for
   * filter-joins invoked directly on the table.
   */
  private asEntityQueryable(): IEntityQueryable<TEntity> {
    const schema = this._getSchema();
    // See createSelectAllRow for the shape (own enumerable columns, inherited navigations).
    const allColumnsSelector = (e: any) => createSelectAllRow(schema, e);

    const queryBuilder = this.context.getTable(this.tableName).select(allColumnsSelector);
    return queryBuilder as any as IEntityQueryable<TEntity>;
  }

  /**
   * Create a prepared query for efficient reusable parameterized execution.
   * Since DbEntityTable represents all records (no WHERE clause), this returns
   * a prepared query that selects all records. Use where() first for filtering.
   */
  prepare<TParams extends Record<string, any> = Record<string, any>>(
    name: string
  ): PreparedQuery<UnwrapDbColumns<TEntity>, TParams> {
    const schema = this._getSchema();

    // Create a selector that selects all columns
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const queryBuilder = this.context.getTable(this.tableName).select(allColumnsSelector);
    return (queryBuilder as any).prepare(name);
  }

  /**
   * Create a future query that will be executed later.
   * Use with FutureQueryRunner.runAsync() for batch execution in a single roundtrip.
   */
  future(): FutureQuery<UnwrapDbColumns<TEntity>> {
    const schema = this._getSchema();

    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const queryBuilder = this.context.getTable(this.tableName).select(allColumnsSelector);
    return (queryBuilder as any).future();
  }

  /**
   * Create a future query that returns a single result or null.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   */
  futureFirstOrDefault(): FutureSingleQuery<UnwrapDbColumns<TEntity>> {
    const schema = this._getSchema();

    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const queryBuilder = this.context.getTable(this.tableName).select(allColumnsSelector);
    return (queryBuilder as any).futureFirstOrDefault();
  }

  /**
   * Create a future query that returns a count.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   */
  futureCount(): FutureCountQuery {
    const schema = this._getSchema();

    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const queryBuilder = this.context.getTable(this.tableName).select(allColumnsSelector);
    return (queryBuilder as any).futureCount();
  }

  /**
   * Add CTEs (Common Table Expressions) to the query
   */
  with(...ctes: DbCte<any>[]): IEntityQueryable<TEntity> {
    const schema = this._getSchema();

    // See createSelectAllRow for the shape (own enumerable columns, inherited navigations).
    const allColumnsSelector = (e: any) => createSelectAllRow(schema, e);

    const queryBuilder = this.context.getTable(this.tableName)
      .with(...ctes)
      .select(allColumnsSelector);
    return queryBuilder as any as IEntityQueryable<TEntity>;
  }

  /**
   * Left join with another table (DbEntity)
   */
  leftJoin<TRight extends DbEntity, TSelection>(
    rightTable: DbEntityTable<TRight>,
    condition: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  /**
   * Left join with a subquery (plain object result, not DbEntity)
   */
  leftJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: EntityQuery<TEntity>, right: TRight) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection,
    alias: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  /**
   * Left join with a CTE
   */
  leftJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/cte-builder').DbCte<TRight>,
    condition: (left: EntityQuery<TEntity>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  leftJoin<TRight, TSelection>(
    rightTable: DbEntityTable<any> | import('../query/subquery').Subquery<TRight, 'table'> | import('../query/cte-builder').DbCte<TRight>,
    condition: (left: EntityQuery<TEntity>, right: any) => Condition,
    selector: (left: EntityQuery<TEntity>, right: any) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>> {
    const queryBuilder = this.context.getTable(this.tableName).leftJoin(rightTable as any, condition as any, selector as any, alias);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  }

  /**
   * Inner join with another table (DbEntity)
   */
  innerJoin<TRight extends DbEntity, TSelection>(
    rightTable: DbEntityTable<TRight>,
    condition: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: EntityQuery<TRight>) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  /**
   * Inner join with a subquery (plain object result, not DbEntity)
   */
  innerJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: EntityQuery<TEntity>, right: TRight) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection,
    alias: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  /**
   * Inner join with a CTE
   */
  innerJoin<TRight extends Record<string, any>, TSelection>(
    rightTable: import('../query/cte-builder').DbCte<TRight>,
    condition: (left: EntityQuery<TEntity>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: EntityQuery<TEntity>, right: TRight) => TSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  innerJoin<TRight, TSelection>(
    rightTable: DbEntityTable<any> | import('../query/subquery').Subquery<TRight, 'table'> | import('../query/cte-builder').DbCte<TRight>,
    condition: (left: EntityQuery<TEntity>, right: any) => Condition,
    selector: (left: EntityQuery<TEntity>, right: any) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>> {
    const queryBuilder = this.context.getTable(this.tableName).innerJoin(rightTable as any, condition as any, selector as any, alias);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, UnwrapSelection<TSelection>>;
  }

  /**
   * Insert - accepts only DbColumn properties (excludes navigation properties)
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.insert({ username: 'alice', email: 'alice@test.com' });
   *
   * // With returning() - returns full entity
   * const user = await db.users.insert({ username: 'alice' }).returning();
   *
   * // With returning(selector) - returns selected columns
   * const { id } = await db.users.insert({ username: 'alice' }).returning(u => ({ id: u.id }));
   * ```
   */
  insert(data: InsertData<TEntity>): FluentInsert<TEntity> {
    const bulkBuilder = this.insertBulk([data]);

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return bulkBuilder.then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const bulkReturning = selector ? bulkBuilder.returning(selector) : bulkBuilder.returning();
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            // Unwrap array to single item
            return bulkReturning.then(
              (results: any[]) => results?.[0],
              undefined
            ).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Upsert (insert or update on conflict)
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.upsert([{ username: 'alice' }], { primaryKey: 'username' });
   *
   * // With returning() - returns full entities
   * const users = await db.users.upsert([{ username: 'alice' }], { primaryKey: 'username' }).returning();
   * ```
   */
  upsert(
    data: InsertData<TEntity>[],
    config?: EntityUpsertConfig<TEntity>
  ): FluentUpsert<TEntity> {
    return this.upsertBulk(data, config);
  }

  /**
   * Bulk insert with advanced configuration
   * Supports automatic chunking for large datasets
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.insertBulk([{ username: 'alice' }]);
   *
   * // With returning() - returns full entities
   * const users = await db.users.insertBulk([{ username: 'alice' }]).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.insertBulk([{ username: 'alice' }]).returning(u => ({ id: u.id }));
   *
   * // With chunk size
   * await db.users.insertBulk([{ username: 'alice' }], { chunkSize: 100 });
   *
   * // Skip duplicates (ON CONFLICT DO NOTHING)
   * await db.users.insertBulk([{ username: 'alice' }], { onConflictDoNothing: true });
   * ```
   */
  insertBulk(
    value: InsertData<TEntity> | InsertData<TEntity>[],
    options?: InsertConfig
  ): FluentInsertMany<TEntity> {
    const table = this;
    const dataArray = Array.isArray(value) ? value : [value];

    const executeInsertBulk = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      if (dataArray.length === 0) {
        return returning === undefined ? undefined : [];
      }

      // Calculate chunk size
      let chunkSize = options?.chunkSize;
      if (chunkSize == null) {
        const POSTGRES_MAX_PARAMS = 65535;
        const columnCount = Object.keys(dataArray[0]).length;
        const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
        chunkSize = Math.floor(maxRowsPerBatch * 0.6);
      }

      // Process in chunks if needed
      if (dataArray.length > chunkSize) {
        const allResults: any[] = [];
        for (let i = 0; i < dataArray.length; i += chunkSize) {
          const chunk = dataArray.slice(i, i + chunkSize);
          const chunkResults = await table.insertBulkSingle(chunk, returning, options?.overridingSystemValue, options?.onConflictDoNothing);
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.insertBulkSingle(dataArray, returning, options?.overridingSystemValue, options?.onConflictDoNothing);
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeInsertBulk(undefined).then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeInsertBulk(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Insert ONE parent row and its dependent CHILD rows as a SINGLE statement,
   * optionally guarded by a NOT-EXISTS probe:
   *
   *   WITH "__iwc_parent__" AS (
   *     INSERT INTO parent (cols) SELECT ... FROM (VALUES (...)) v
   *     [WHERE NOT EXISTS (SELECT 1 FROM (<unlessExists>) "__iwc_guard__")]
   *     RETURNING <parent cols>
   *   ),
   *   "__mutation__" AS (
   *     INSERT INTO child (fk, cols)
   *     SELECT p.pk, v.cols FROM "__iwc_parent__" p CROSS JOIN (VALUES (0, ...), (1, ...)) v("__iwc_ord", cols)
   *     ORDER BY v."__iwc_ord"
   *     RETURNING <child cols>
   *   )
   *   SELECT <child projection>, <parent cols> FROM "__mutation__" CROSS JOIN "__iwc_parent__" ...
   *
   * Guarantees:
   *  - the child rows receive the freshly inserted parent's primary key via
   *    `children.foreignKey`;
   *  - the ordinal ORDER BY fixes the child sequence-allocation order, so
   *    serial child ids ascend in INPUT-ROW order, and the returned `children`
   *    array is sorted back into that order (deterministic even when the
   *    outer navigation joins would otherwise shuffle rows);
   *  - a matching `unlessExists` guard suppresses the WHOLE insert in the same
   *    snapshot and resolves `{ parent: null, children: [] }` (callers race-
   *    guarding concurrent creates still need their own serialization — two
   *    concurrent statements cannot see each other's uncommitted rows);
   *  - single-statement atomicity: any failing leg rolls back both inserts.
   *
   * Restrictions: single-column auto/serial parent primary key; child rows must
   * NOT carry the foreign-key property; `children.rows` must be non-empty and
   * fit one statement (no chunking).
   *
   * RETURNING: the child selector supports the full navigation/collection
   * projection surface of `.returning()` — a child → parent navigation reads the
   * parent inserted in the SAME statement, as well as the parent table's other
   * rows. A parent selector of the parent's own columns rides the statement; one
   * reading anything else (a navigation, a collection — which then counts the new
   * children —, a nested object, an expression) is read back by the parent's key
   * with a SELECT after the statement.
   */
  insertWithChildren<TChildEntity extends DbEntity, TParentResult, TChildResult>(config: {
    row: InsertData<TEntity>;
    /** Suppress the whole insert when this query yields a row (same-snapshot NOT EXISTS). */
    unlessExists?: { future: () => { _sql: string; _params: any[]; _client: any; _executor?: any } };
    children: {
      table: DbEntityTable<TChildEntity>;
      /** Child property that receives the parent's primary key. */
      foreignKey: string;
      rows: Array<Record<string, any>>;
    };
    returning: {
      parent: (entity: EntityQuery<TEntity>) => TParentResult;
      children: (entity: EntityQuery<TChildEntity>) => TChildResult;
    };
  }): Promise<{ parent: ReturningRow<TParentResult> | null; children: ReturningRow<TChildResult>[] }> {
    const { rows, foreignKey } = config.children;

    if (rows.length === 0) {
      throw new Error('insertWithChildren: children.rows must be non-empty — use a plain insert for a childless parent');
    }

    for (let i = 0; i < rows.length; i++) {
      if (rows[i][foreignKey] !== undefined) {
        throw new Error(`insertWithChildren: child row at index ${i} carries the foreign-key property "${foreignKey}" — it is sourced from the inserted parent`);
      }
    }

    const columnCount = Math.max(1, Object.keys(rows[0]).length + 1);
    const singleStatementLimit = Math.floor(Math.floor(65535 / columnCount) * 0.6);

    if (rows.length > singleStatementLimit) {
      throw new Error(`insertWithChildren: ${rows.length} child rows exceed the ~${singleStatementLimit}-row single-statement budget — insert them standalone (they need chunking)`);
    }

    return this.executeInsertWithChildren(config);
  }

  /** @internal Async body of {@link insertWithChildren} (validation stays synchronous). */
  private async executeInsertWithChildren<TChildEntity extends DbEntity, TParentResult, TChildResult>(config: {
    row: InsertData<TEntity>;
    unlessExists?: { future: () => { _sql: string; _params: any[]; _client: any; _executor?: any } };
    children: { table: DbEntityTable<TChildEntity>; foreignKey: string; rows: Array<Record<string, any>> };
    returning: {
      parent: (entity: EntityQuery<TEntity>) => TParentResult;
      children: (entity: EntityQuery<TChildEntity>) => TChildResult;
    };
  }): Promise<{ parent: any; children: any[] }> {
    const parentSchema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();
    const childTable = config.children.table;

    if (childTable._getClient() !== client || childTable._getExecutor() !== executor) {
      throw new Error('insertWithChildren: the child table uses a different database client or transaction than the parent — both must share one connection context');
    }

    if (config.unlessExists) {
      const guardFuture = config.unlessExists.future();

      if (guardFuture._client !== client || guardFuture._executor !== executor) {
        throw new Error('insertWithChildren: the unlessExists guard uses a different database client or transaction than the insert');
      }
    }

    // Single-column parent primary key — the value the child FK column selects.
    const pkEntries = Object.entries(parentSchema.columns).filter(([, colBuilder]) => (colBuilder as any).build().primaryKey);

    if (pkEntries.length !== 1) {
      throw new Error('insertWithChildren requires a single-column parent primary key');
    }

    const parentPkDbName = (pkEntries[0][1] as any).build().name;

    // ---- parent leg: INSERT ... SELECT FROM (VALUES ...) [WHERE NOT EXISTS] ----
    const parentCompiled = this.compileValuesWithCasts(parentSchema, [config.row as Record<string, any>], null);
    const parentColNames = parentCompiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const parentSelectCols = parentCompiled.columns.map(c => `v."${c.dbName}"`).join(', ');
    const params: any[] = [...parentCompiled.params];

    // Parent RETURNING: a selector of the parent's own columns rides the statement; one that reads
    // anything else — a navigation, a collection, a nested object, an expression — reads the
    // inserted parent back by its key once the statement ran (and so sees its children too)
    const parentPkProp = pkEntries[0][0];
    const parentSelCols = this.flatReturningColumns(config.returning.parent);

    let parentSql = `INSERT INTO ${this._getQualifiedTableName()} (${parentColNames})
SELECT ${parentSelectCols} FROM (VALUES (${parentCompiled.valueRows[0]})) AS v(${parentColNames})`;

    if (config.unlessExists) {
      const guardFuture = config.unlessExists.future();
      const guardSql = params.length === 0 ? guardFuture._sql : renumberPlaceholders(guardFuture._sql, params.length);
      parentSql += `\nWHERE NOT EXISTS (SELECT 1 FROM (\n${guardSql}\n) "__iwc_guard__")`;
      params.push(...guardFuture._params);
    }

    // RETURNING * so the CTE can stand in for the parent TABLE in child→parent
    // navigation joins (the real table is snapshot-stale within this statement).
    parentSql += '\nRETURNING *';

    // ---- child leg: INSERT ... SELECT parent-pk + ordered VALUES ----
    const childSchema = childTable._getSchema();
    const fkColBuilder = childSchema.columns[config.children.foreignKey];

    if (!fkColBuilder) {
      throw new Error(`insertWithChildren: unknown child foreign-key property "${config.children.foreignKey}"`);
    }

    const fkDbName = (fkColBuilder as any).build().name;
    const childCompiled = childTable.compileValuesWithCasts(childSchema, config.children.rows, config.children.foreignKey);
    const childColNames = childCompiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const childSelectCols = childCompiled.columns.map(c => `v."${c.dbName}"`).join(', ');
    const childValuesRows = childCompiled.valueRows.map((row, ix) => `(${ix}, ${row})`);
    const childOffset = params.length;
    const childValueList = childValuesRows.join(', ');
    let childSql = `INSERT INTO ${(childTable as any)._getQualifiedTableName()} ("${fkDbName}", ${childColNames})
SELECT p."${parentPkDbName}", ${childSelectCols} FROM "__iwc_parent__" p CROSS JOIN (VALUES ${childValueList}) AS v("__iwc_ord", ${childColNames})
ORDER BY v."__iwc_ord"`;
    childSql = childOffset === 0 ? childSql : renumberPlaceholders(childSql, childOffset);
    params.push(...childCompiled.params);

    // ---- returning assembly ----
    const childPkEntries = Object.entries(childSchema.columns).filter(([, colBuilder]) => (colBuilder as any).build().primaryKey);
    const childPkDbName = childPkEntries.length === 1 ? (childPkEntries[0][1] as any).build().name : null;
    const prefixCtes = `"__iwc_parent__" AS (
${parentSql}
)`;
    const extraJoins = ['CROSS JOIN "__iwc_parent__" AS "__iwc_parent_j__"'];
    // The parent's key rides along when the parent is read back by it — and when the selector
    // projects nothing, so the select list is never left with a dangling comma
    const extraSelects = [
      ...(parentSelCols === undefined || parentSelCols.length === 0 ? [`"__iwc_parent_j__"."${parentPkDbName}" AS "__iwc_parent__.__pk"`] : []),
      ...(parentSelCols ?? []).map(c => `"__iwc_parent_j__"."${c.dbName}" AS "__iwc_parent__.${c.prop}"`),
    ];

    const navigationInfo = (childTable as any).detectNavigationInReturning(config.returning.children);
    let rawRows: any[];
    let mapChildren: (stripped: any[]) => any[];

    if (navigationInfo) {
      const built = (childTable as any).buildReturningWithNavigation(
        childSql,
        params,
        config.returning.children,
        navigationInfo,
        {
          prefixCtes,
          extraJoins,
          extraSelects,
          extraCteReturningCols: childPkDbName ? [childPkDbName] : [],
          orderByCteColumn: childPkDbName ?? undefined,
          joinTableOverrides: new Map([[
            parentSchema.name,
            this.insertedRowsUnionTable('__iwc_parent__'),
          ]]),
        }
      );
      // Per-call VALUES list ⇒ unique text ⇒ never a prepared statement (see QueryOptions.preparedStatements).
      const result = executor ? await executor.query(built.sql, built.params, { prepare: false }) : await client.query(built.sql, built.params);
      rawRows = result.rows;
      mapChildren = stripped => (childTable as any).readReturning(stripped, built.read);
    } else {
      const returningClause = (childTable as any).buildReturningClause(config.returning.children, undefined, { paramCounter: params.length + 1, params });
      const pkExtra = childPkDbName ? `, "${childPkDbName}" AS "__iwc_child_pk__"` : '';
      const orderBy = childPkDbName ? '\nORDER BY "__mutation__"."__iwc_child_pk__"' : '';
      const sql = `WITH ${prefixCtes},
"__mutation__" AS (
${childSql}
RETURNING ${returningClause.sql}${pkExtra}
)
SELECT "__mutation__".*, ${extraSelects.join(', ')}
FROM "__mutation__"
${extraJoins.join('\n')}${orderBy}`;
      // Per-call VALUES list ⇒ unique text ⇒ never a prepared statement (see QueryOptions.preparedStatements).
      const result = executor ? await executor.query(sql, params, { prepare: false }) : await client.query(sql, params);
      rawRows = result.rows;
      mapChildren = stripped => (childTable as any).mapReturningResults(stripped, returningClause);
    }

    if (rawRows.length === 0) {
      // Guard suppressed the insert (children.rows is non-empty, so an inserted
      // parent always yields at least one row here).
      return { parent: null, children: [] };
    }

    let parentRow: any;

    if (parentSelCols) {
      parentRow = {};

      for (const col of parentSelCols) {
        const raw = rawRows[0][`__iwc_parent__.${col.prop}`];
        parentRow[col.prop] = col.mapper ? col.mapper.fromDriver(raw) : raw;
      }
    } else {
      const [readBack] = await this.readRowsByPrimaryKey(parentPkProp, [rawRows[0]['__iwc_parent__.__pk']], config.returning.parent);
      parentRow = readBack ?? null;
    }

    const strippedRows = rawRows.map((row) => {
      const clean: Record<string, any> = {};

      for (const [key, value] of Object.entries(row)) {
        if (!key.startsWith('__iwc_parent__.')) {
          clean[key] = value;
        }
      }

      return clean;
    });

    return { parent: parentRow, children: mapChildren(strippedRows) };
  }

  /**
   * Bulk sibling of {@link insertWithChildren}: N parent rows plus their child rows in
   * ONE statement (a task-DAG persist — N task rows + one audit row each — used to
   * cost two). Parent identity mapping rides the SAME serial-ascend guarantee the
   * single-parent variant documents: the parent leg inserts `ORDER BY` an input
   * ordinal, so generated serial ids ascend in input-row order, and a
   * `row_number() OVER (ORDER BY pk)` CTE recovers each parent's input index for the
   * child join:
   *
   *   WITH "__ibwc_parent__" AS (
   *     INSERT INTO parent (cols)
   *     SELECT cols FROM (VALUES (0, ...), (1, ...)) v("__ibwc_ord", cols)
   *     ORDER BY v."__ibwc_ord" RETURNING *
   *   ), "__ibwc_pord__" AS (
   *     SELECT p.*, row_number() OVER (ORDER BY p."pk") - 1 AS "__ibwc_ord"
   *     FROM "__ibwc_parent__" p
   *   ), "__mutation__" AS (
   *     INSERT INTO child ("fk", cols)
   *     SELECT p."pk", v.cols
   *     FROM (VALUES (0, pix, ...), ...) v("__ibwc_cord", "__ibwc_pix", cols)
   *     JOIN "__ibwc_pord__" p ON p."__ibwc_ord" = v."__ibwc_pix"
   *     ORDER BY v."__ibwc_cord" RETURNING <child cols>, "childPk"
   *   )
   *   SELECT "__mutation__".*, <parent cols + ordinal via the fk join>
   *   FROM "__mutation__" JOIN "__ibwc_pord__" ON fk = pk ORDER BY child pk
   *
   * Single-statement atomicity: a failing leg rolls back both inserts. Parents come
   * back in input order; children in child-input order.
   *
   * Restrictions: single-column auto/serial primary keys on both tables; no
   * `unlessExists` guard; child rows must NOT carry the foreign-key property; EVERY
   * parent must be referenced by at least one child (parents are returned through
   * the child join — a childless parent would insert but vanish from the result, so
   * it is rejected up front; use plain `insertBulk` for childless rows); the whole
   * shape must fit one statement (no chunking).
   *
   * RETURNING: as {@link insertWithChildren} — the children's navigations and
   * collections in the same statement (a child → parent navigation reads the new
   * parents and the table's other rows), the parents' own columns in the same
   * statement and anything else read back by their keys, in input order.
   */
  insertBulkWithChildren<TChildEntity extends DbEntity, TParentResult, TChildResult>(config: {
    rows: InsertData<TEntity>[];
    children: {
      table: DbEntityTable<TChildEntity>;
      /** Child property that receives its parent's primary key. */
      foreignKey: string;
      rows: Array<{ parentIndex: number; row: Record<string, any> }>;
    };
    returning: {
      parents: (entity: EntityQuery<TEntity>) => TParentResult;
      children: (entity: EntityQuery<TChildEntity>) => TChildResult;
    };
  }): Promise<{ parents: ReturningRow<TParentResult>[]; children: ReturningRow<TChildResult>[] }> {
    const { rows: childRows, foreignKey } = config.children;

    if (config.rows.length === 0) {
      throw new Error('insertBulkWithChildren: rows must be non-empty');
    }

    if (childRows.length === 0) {
      throw new Error('insertBulkWithChildren: children.rows must be non-empty — use insertBulk for childless parents');
    }

    const referenced = new Set<number>();

    for (let i = 0; i < childRows.length; i++) {
      const { parentIndex, row } = childRows[i];

      if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= config.rows.length) {
        throw new Error(`insertBulkWithChildren: child row at index ${i} has parentIndex ${parentIndex} outside 0..${config.rows.length - 1}`);
      }

      if (row[foreignKey] !== undefined) {
        throw new Error(`insertBulkWithChildren: child row at index ${i} carries the foreign-key property "${foreignKey}" — it is sourced from its inserted parent`);
      }

      referenced.add(parentIndex);
    }

    for (let i = 0; i < config.rows.length; i++) {
      if (!referenced.has(i)) {
        throw new Error(`insertBulkWithChildren: parent at index ${i} has no child row — parents return through the child join (v1); insert childless rows via insertBulk`);
      }
    }

    const columnCount = Math.max(1, Object.keys(childRows[0].row).length + 2);
    const singleStatementLimit = Math.floor(Math.floor(65535 / columnCount) * 0.6);

    if (childRows.length + config.rows.length > singleStatementLimit) {
      throw new Error(`insertBulkWithChildren: ${config.rows.length} parents + ${childRows.length} children exceed the ~${singleStatementLimit}-row single-statement budget`);
    }

    return this.executeInsertBulkWithChildren(config);
  }

  /** @internal Async body of {@link insertBulkWithChildren} (validation stays synchronous). */
  private async executeInsertBulkWithChildren<TChildEntity extends DbEntity, TParentResult, TChildResult>(config: {
    rows: InsertData<TEntity>[];
    children: { table: DbEntityTable<TChildEntity>; foreignKey: string; rows: Array<{ parentIndex: number; row: Record<string, any> }> };
    returning: {
      parents: (entity: EntityQuery<TEntity>) => TParentResult;
      children: (entity: EntityQuery<TChildEntity>) => TChildResult;
    };
  }): Promise<{ parents: any[]; children: any[] }> {
    const parentSchema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();
    const childTable = config.children.table;

    if (childTable._getClient() !== client || childTable._getExecutor() !== executor) {
      throw new Error('insertBulkWithChildren: the child table uses a different database client or transaction than the parent — both must share one connection context');
    }

    const pkEntries = Object.entries(parentSchema.columns).filter(([, colBuilder]) => (colBuilder as any).build().primaryKey);

    if (pkEntries.length !== 1) {
      throw new Error('insertBulkWithChildren requires a single-column parent primary key');
    }

    const parentPkDbName = (pkEntries[0][1] as any).build().name;

    // ---- parent leg: ordinal-ordered VALUES so serial ids ascend in input order ----
    const parentCompiled = this.compileValuesWithCasts(parentSchema, config.rows as Array<Record<string, any>>, null);
    const parentColNames = parentCompiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const parentSelectCols = parentCompiled.columns.map(c => `v."${c.dbName}"`).join(', ');
    const parentValueRows = parentCompiled.valueRows.map((row, ix) => `(${ix}, ${row})`).join(', ');
    const params: any[] = [...parentCompiled.params];

    // Parents RETURNING: own columns ride the statement; a selector reading anything else is read
    // back by key once the statement ran (see insertWithChildren)
    const parentPkProp = pkEntries[0][0];
    const parentSelCols = this.flatReturningColumns(config.returning.parents);

    const parentSql = `INSERT INTO ${this._getQualifiedTableName()} (${parentColNames})
SELECT ${parentSelectCols} FROM (VALUES ${parentValueRows}) AS v("__ibwc_ord", ${parentColNames})
ORDER BY v."__ibwc_ord"
RETURNING *`;

    // ---- child leg: (childOrd, parentIx, cells) VALUES joined to the ordinal CTE ----
    const childSchema = childTable._getSchema();
    const fkColBuilder = childSchema.columns[config.children.foreignKey];

    if (!fkColBuilder) {
      throw new Error(`insertBulkWithChildren: unknown child foreign-key property "${config.children.foreignKey}"`);
    }

    const fkDbName = (fkColBuilder as any).build().name;
    const childCompiled = childTable.compileValuesWithCasts(childSchema, config.children.rows.map(r => r.row), config.children.foreignKey);
    const childColNames = childCompiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const childSelectCols = childCompiled.columns.map(c => `v."${c.dbName}"`).join(', ');
    const childValueRows = childCompiled.valueRows.map((row, ix) => `(${ix}, ${config.children.rows[ix].parentIndex}, ${row})`).join(', ');
    const childOffset = params.length;
    let childSql = `INSERT INTO ${(childTable as any)._getQualifiedTableName()} ("${fkDbName}", ${childColNames})
SELECT p."${parentPkDbName}", ${childSelectCols}
FROM (VALUES ${childValueRows}) AS v("__ibwc_cord", "__ibwc_pix", ${childColNames})
JOIN "__ibwc_pord__" p ON p."__ibwc_ord" = v."__ibwc_pix"
ORDER BY v."__ibwc_cord"`;
    childSql = childOffset === 0 ? childSql : renumberPlaceholders(childSql, childOffset);
    params.push(...childCompiled.params);

    // ---- assembly: child returning + parent cols through the fk join ----
    const childPkEntries = Object.entries(childSchema.columns).filter(([, colBuilder]) => (colBuilder as any).build().primaryKey);

    if (childPkEntries.length !== 1) {
      throw new Error('insertBulkWithChildren requires a single-column child primary key');
    }

    const childPkDbName = (childPkEntries[0][1] as any).build().name;
    const parentJoinSelects = [
      `"__ibwc_pj__"."__ibwc_ord" AS "__ibwc_parent__.__ord"`,
      // The parents' keys ride along when they are read back by them
      ...(parentSelCols === undefined ? [`"__ibwc_pj__"."${parentPkDbName}" AS "__ibwc_parent__.__pk"`] : []),
      ...(parentSelCols ?? []).map(c => `"__ibwc_pj__"."${c.dbName}" AS "__ibwc_parent__.${c.prop}"`),
    ];
    const prefixCtes = `"__ibwc_parent__" AS (
${parentSql}
),
"__ibwc_pord__" AS (
  SELECT p.*, row_number() OVER (ORDER BY p."${parentPkDbName}") - 1 AS "__ibwc_ord"
  FROM "__ibwc_parent__" p
)`;

    const navigationInfo = (childTable as any).detectNavigationInReturning(config.returning.children);
    let rawRows: any[];
    let mapChildren: (stripped: any[]) => any[];

    if (navigationInfo) {
      // Navigations and collections of the children, in the same statement: the child insert runs
      // as the navigation RETURNING's "__mutation__" CTE, after the parent legs; a child → parent
      // navigation reads the parents just inserted as well as the table's other rows
      const built = (childTable as any).buildReturningWithNavigation(
        childSql,
        params,
        config.returning.children,
        navigationInfo,
        {
          prefixCtes,
          extraJoins: [`JOIN "__ibwc_pord__" "__ibwc_pj__" ON "__ibwc_pj__"."${parentPkDbName}" = "__mutation__"."${fkDbName}"`],
          extraSelects: parentJoinSelects,
          extraCteReturningCols: [fkDbName, childPkDbName],
          orderByCteColumn: childPkDbName,
          joinTableOverrides: new Map([[
            parentSchema.name,
            this.insertedRowsUnionTable('__ibwc_parent__'),
          ]]),
        }
      );
      // Per-call VALUES lists ⇒ unique text ⇒ never a prepared statement (see QueryOptions.preparedStatements).
      const result = executor ? await executor.query(built.sql, built.params, { prepare: false }) : await client.query(built.sql, built.params);
      rawRows = result.rows;
      mapChildren = stripped => (childTable as any).readReturning(stripped, built.read);
    } else {
      const returningClause = (childTable as any).buildReturningClause(config.returning.children, undefined, { paramCounter: params.length + 1, params });
      const sql = `WITH ${prefixCtes},
"__mutation__" AS (
${childSql}
RETURNING ${returningClause.sql}, "${fkDbName}" AS "__ibwc_child_fk__", "${childPkDbName}" AS "__ibwc_child_pk__"
)
SELECT "__mutation__".*, ${parentJoinSelects.join(', ')}
FROM "__mutation__"
JOIN "__ibwc_pord__" "__ibwc_pj__" ON "__ibwc_pj__"."${parentPkDbName}" = "__mutation__"."__ibwc_child_fk__"
ORDER BY "__mutation__"."__ibwc_child_pk__"`;

      // Per-call VALUES lists ⇒ unique text ⇒ never a prepared statement (see QueryOptions.preparedStatements).
      const result = executor ? await executor.query(sql, params, { prepare: false }) : await client.query(sql, params);
      rawRows = result.rows;
      mapChildren = stripped => (childTable as any).mapReturningResults(stripped, returningClause);
    }

    const parentsByOrd = new Map<number, any>();
    const parentPks = new Map<number, unknown>();
    const strippedRows: Array<Record<string, any>> = [];

    for (const row of rawRows) {
      const ord = Number(row['__ibwc_parent__.__ord']);

      if (!parentsByOrd.has(ord)) {
        const parentRow: Record<string, any> = {};

        for (const col of parentSelCols ?? []) {
          const raw = row[`__ibwc_parent__.${col.prop}`];
          parentRow[col.prop] = col.mapper ? col.mapper.fromDriver(raw) : raw;
        }

        parentsByOrd.set(ord, parentRow);
        parentPks.set(ord, row['__ibwc_parent__.__pk']);
      }

      const clean: Record<string, any> = {};

      for (const [key, value] of Object.entries(row)) {
        if (!key.startsWith('__ibwc_parent__.') && key !== '__ibwc_child_fk__' && key !== '__ibwc_child_pk__') {
          clean[key] = value;
        }
      }

      strippedRows.push(clean);
    }

    const ords = [...parentsByOrd.keys()].sort((a, b) => a - b);
    const parents = parentSelCols
      ? ords.map(ord => parentsByOrd.get(ord))
      // Read back in key order — the input order, since the parent keys ascend in it
      : await this.readRowsByPrimaryKey(parentPkProp, ords.map(ord => parentPks.get(ord)), config.returning.parents);
    const children = mapChildren(strippedRows);

    return { parents, children };
  }

  /**
   * The columns of a RETURNING selector when it reads nothing but this table's own columns (one
   * top-level field per column): what a composed insert can return from its own statement.
   * `undefined` when it reads anything else — a navigation, a collection, a nested object, an
   * expression.
   * @internal
   */
  private flatReturningColumns(selector: (entity: EntityQuery<TEntity>) => any): Array<{ prop: string; dbName: string; mapper?: any }> | undefined {
    const schema = this._getSchema();
    const selection = selector(this.createMockEntity() as EntityQuery<TEntity>);
    const columns: Array<{ prop: string; dbName: string; mapper?: any }> = [];

    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
      return undefined;
    }

    for (const [prop, field] of Object.entries(selection)) {
      if (field === null || typeof field !== 'object' || !('__dbColumnName' in field) || field instanceof WhereConditionBase) {
        return undefined;
      }

      const tableAlias = (field as any).__tableAlias as string | undefined;
      const dbColumnName = (field as any).__dbColumnName as string;

      if (tableAlias && tableAlias !== schema.name) {
        return undefined;
      }

      const colEntry = Object.entries(schema.columns).find(([, colBuilder]) => (colBuilder as any).build().name === dbColumnName);
      columns.push({ prop, dbName: dbColumnName, mapper: colEntry ? (colEntry[1] as any).build().mapper : undefined });
    }

    return columns;
  }

  /**
   * This table's rows with the given primary-key values, projected by `selector` (navigations and
   * collections included), in key order. How a composed insert reads back a parent it inserted when
   * its RETURNING selector reaches beyond the parent's own columns.
   * @internal
   */
  private async readRowsByPrimaryKey(pkProp: string, pkValues: unknown[], selector: (entity: EntityQuery<TEntity>) => any): Promise<any[]> {
    return await (this as any)
      .where((row: any) => inArray(row[pkProp], pkValues))
      .orderBy((row: any) => row[pkProp])
      .select(selector)
      .toList();
  }

  /**
   * The FROM item a composed insert's navigation RETURNING reads this table through: the rows its
   * CTE `cteName` just inserted (RETURNING *) together with the table's other rows. The table
   * alone is snapshot-stale inside the statement — it does not show the new rows — and the CTE
   * alone does not show the old ones, which a navigation to an existing row of this table needs.
   * @internal
   */
  private insertedRowsUnionTable(cteName: string): string {
    return `(SELECT * FROM "${cteName}" UNION ALL SELECT * FROM ${this._getQualifiedTableName()})`;
  }

  /**
   * Compile rows into a cast-annotated VALUES fragment (`$n::type` / `NULL::type`
   * per cell — the bulkUpdate technique, so a bare `VALUES` source keeps correct
   * column types) with the same column-selection rules as {@link insertBulkSingle}.
   * @internal
   */
  private compileValuesWithCasts(
    schema: TableSchema,
    data: Array<Record<string, any>>,
    excludeProp: string | null
  ): { columns: Array<{ propName: string; dbName: string }>; valueRows: string[]; params: any[] } {
    const columns: Array<{ propName: string; dbName: string; pgType: string; mapper?: any }> = [];

    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      if (propName === excludeProp) {
        continue;
      }

      const colConfig = (colBuilder as any).build();

      if (colConfig.autoIncrement) {
        continue;
      }

      const hasDefinedValue = data.some(record => record[propName] !== undefined);

      if (!hasDefinedValue) {
        if (colConfig.default !== undefined || colConfig.identity) {
          continue;
        }

        const isPresentInAnyRow = data.some(record => propName in record);

        if (!isPresentInAnyRow) {
          continue;
        }
      }

      columns.push({
        propName,
        dbName: colConfig.name,
        pgType: DbEntityTable.PG_TYPE_MAP[colConfig.type] || colConfig.type,
        mapper: colConfig.mapper,
      });
    }

    if (columns.length === 0) {
      throw new Error('insertWithChildren: rows resolve to zero insertable columns');
    }

    const valueRows: string[] = [];
    const params: any[] = [];
    const cellContext: SqlBuildContext = { paramCounter: 1, params };

    for (const record of data) {
      const cells: string[] = [];

      for (const col of columns) {
        const rawValue = record[col.propName];

        // An sql fragment inline (typed like the column), as a plain insert renders it
        if (rawValue instanceof SqlFragment) {
          cells.push(renderValuesCell(rawValue, col.mapper, cellContext, `::${col.pgType}`));
          continue;
        }

        const normalized = rawValue === undefined ? null : rawValue;
        const mapped = col.mapper ? col.mapper.toDriver(normalized) : normalized;

        if (mapped === undefined || mapped === null) {
          cells.push(`NULL::${col.pgType}`);
        } else {
          cells.push(`$${cellContext.paramCounter++}::${col.pgType}`);
          params.push(mapped);
        }
      }

      valueRows.push(cells.join(', '));
    }

    return { columns, valueRows, params };
  }

  /**
   * Execute a single bulk insert batch
   * @internal
   */
  private async insertBulkSingle<TReturning>(
    data: InsertData<TEntity>[],
    returning: TReturning,
    overridingSystemValue?: boolean,
    onConflictDoNothing?: boolean
  ): Promise<any[] | void> {
    const executor = this._getExecutor();
    const client = this._getClient();

    const built = this._buildInsertBulkStatement(data, overridingSystemValue, onConflictDoNothing);

    if (!built) {
      return returning === undefined ? undefined : [];
    }

    // Check if RETURNING uses navigation properties
    const navigationInfo = returning && returning !== true && typeof returning === 'function'
      ? this.detectNavigationInReturning(returning as any)
      : null;

    if (navigationInfo) {
      // Use CTE-based approach for navigation properties
      const { sql, params: queryParams, read } = this.buildReturningWithNavigation(
        built.sql,
        built.params,
        returning as any,
        navigationInfo
      );

      const result = executor
        ? await executor.query(sql, queryParams)
        : await client.query(sql, queryParams);

      return this.readReturning(result.rows, read);
    }

    // Standard RETURNING (no navigation properties)
    const returningClause = this.buildReturningClause(returning as any, undefined, { paramCounter: built.params.length + 1, params: built.params });

    let sql = built.sql;
    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, built.params)
      : await client.query(sql, built.params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returningClause);
  }

  /**
   * Builds the bare `INSERT ... VALUES` statement (no RETURNING clause) for ONE
   * chunk of rows — exactly the SQL {@link insertBulkSingle} executes, exposed
   * separately so `MutationBatch` can compose it as a data-modifying CTE leg.
   * Returns null when the rows resolve to zero insertable columns (or no rows).
   * @internal
   */
  _buildInsertBulkStatement(
    data: InsertData<TEntity>[],
    overridingSystemValue?: boolean,
    onConflictDoNothing?: boolean
  ): { sql: string; params: any[] } | null {
    if (data.length === 0) {
      return null;
    }

    const schema = this._getSchema();
    const qualifiedTableName = this._getQualifiedTableName();

    // Get columns from all rows - a column is included if ANY row has a non-undefined value for it
    const columnConfigs: Array<{ propName: string; dbName: string; mapper?: any }> = [];

    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build();
      // Skip auto-increment columns (unless overriding)
      if (config.autoIncrement && !overridingSystemValue) {
        continue;
      }

      // Check if any row has a defined (non-undefined) value for this column
      const hasDefinedValue = data.some(record => {
        const value = (record as any)[propName];
        return value !== undefined;
      });

      // If column has a default and ALL rows have undefined, skip it (let DB use default)
      // Otherwise, include it if at least one row has a defined value
      if (!hasDefinedValue) {
        // All rows have undefined - if there's a default, skip the column
        if (config.default !== undefined || config.identity) {
          continue;
        }
        // No default, but column is present with undefined in data - include it (will become NULL)
        const isPresentInAnyRow = data.some(record => propName in record);
        if (!isPresentInAnyRow) {
          continue;
        }
      }

      columnConfigs.push({
        propName,
        dbName: config.name,
        mapper: config.mapper,
      });
    }

    if (columnConfigs.length === 0) {
      return null;
    }

    // Build VALUES clauses
    const valuesClauses: string[] = [];
    const params: any[] = [];
    const cellContext: SqlBuildContext = { paramCounter: 1, params };

    for (const record of data) {
      // An sql fragment inline, anything else through the column's mapper (undefined → NULL:
      // undefined values are not allowed by postgres drivers)
      const rowValues = columnConfigs.map(col => renderValuesCell((record as any)[col.propName], col.mapper, cellContext));
      valuesClauses.push(`(${rowValues.join(', ')})`);
    }

    const columnList = columnConfigs.map(c => `"${c.dbName}"`).join(', ');

    let sql = `INSERT INTO ${qualifiedTableName} (${columnList})`;
    if (overridingSystemValue) {
      sql += ' OVERRIDING SYSTEM VALUE';
    }
    sql += ` VALUES ${valuesClauses.join(', ')}`;
    if (onConflictDoNothing) {
      sql += ' ON CONFLICT DO NOTHING';
    }

    return { sql, params };
  }

  /**
   * Builds a ROW-GUARDED bulk insert — `INSERT INTO t (cols) SELECT v.cols FROM
   * (VALUES …) AS v(cols) WHERE <guard>` — so each candidate row is inserted
   * only when the guard predicate holds for it. The guard is evaluated by
   * PostgreSQL as part of the insert: rows that fail it are silently skipped
   * and the caller detects them through the affected count (via
   * `MutationBatch.getAffectedCount`).
   *
   * The predicate is raw SQL (the same contract as `hasIndex().where(…)`),
   * evaluated per candidate row with the row exposed under the `v` alias — refer
   * to a cell as `v."<db_column_name>"`. It takes no parameters of its own;
   * anything else it needs must be reachable by joining from the row's columns.
   *
   * Cells reuse the insertWithChildren `$n::type` cast technique so a bare
   * `VALUES` source keeps correct column types. Returns null for an empty row
   * array, mirroring {@link _buildInsertBulkStatement}.
   *
   * NOTE (self-visibility): under PostgreSQL's snapshot rules a statement never
   * sees its OWN inserted rows, so a guard that counts rows of the table being
   * inserted into judges every candidate row against the PRE-statement state.
   * Two rows of one batch that would collide with each other therefore both
   * pass — guard batches whose rows are mutually independent.
   *
   * NOTE (concurrency): the guard is NOT a cross-transaction race arbiter. It
   * judges only rows committed before the statement takes its snapshot (READ
   * COMMITTED), so two CONCURRENT transactions can both pass a count-based
   * guard and jointly overshoot the cap. Callers must serialize concurrent
   * writers first (e.g. an exclusive row or advisory lock taken earlier in the
   * same transaction) — the blocked transaction's later statement then
   * re-snapshots and the guard is effective.
   * @internal
   */
  _buildGuardedInsertBulkStatement(
    data: InsertData<TEntity>[],
    guardPredicate: string
  ): { sql: string; params: any[] } | null {
    if (data.length === 0) {
      return null;
    }

    const compiled = this.compileValuesWithCasts(this._getSchema(), data as Array<Record<string, any>>, null);
    const columnList = compiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const selectList = compiled.columns.map(c => `v."${c.dbName}"`).join(', ');
    const valueRows = compiled.valueRows.map(row => `(${row})`).join(', ');

    return {
      sql: `INSERT INTO ${this._getQualifiedTableName()} (${columnList})
SELECT ${selectList} FROM (VALUES ${valueRows}) AS v(${columnList})
WHERE ${guardPredicate}`,
      params: compiled.params,
    };
  }

  /**
   * Builds a bare `DELETE FROM t WHERE "col" IN ($1, …)` statement (no
   * RETURNING clause) so `MutationBatch` can compose it as a data-modifying
   * CTE leg. Each value runs through the column's toDriver mapper — the same
   * fidelity rule the insert/update legs follow. Returns null for an empty
   * values array (mirroring the other leg builders' empty-input semantics);
   * an unknown column property throws at build time.
   * @internal
   */
  _buildDeleteWhereInStatement(field: string, values: any[]): { sql: string; params: any[] } | null {
    if (values.length === 0) {
      return null;
    }

    const schema = this._getSchema();
    const colBuilder = schema.columns[field];

    if (!colBuilder) {
      throw new Error(`deleteWhereIn: unknown column property "${field}" on entity "${schema.name}"`);
    }

    const config = (colBuilder as any).build();
    const params = values.map(value => (config.mapper ? config.mapper.toDriver(value) : value));
    const placeholders = params.map((_, ix) => `$${ix + 1}`).join(', ');

    return {
      sql: `DELETE FROM ${this._getQualifiedTableName()} WHERE "${config.name}" IN (${placeholders})`,
      params,
    };
  }

  /**
   * Upsert with advanced configuration
   * Auto-detects primary keys and supports chunking
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.upsertBulk([{ id: 1, username: 'alice' }], { primaryKey: 'id' });
   *
   * // With returning() - returns full entities
   * const users = await db.users.upsertBulk([{ id: 1, username: 'alice' }]).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.upsertBulk([{ id: 1, username: 'alice' }])
   *   .returning(u => ({ id: u.id }));
   *
   * // Values may be SqlFragments (self-contained SQL expressions, e.g. a scalar
   * // subquery) — computed in the same statement and flowing into the DO UPDATE
   * // arm via EXCLUDED, so a fold + upsert stays ONE round trip:
   * const rows = await db.users.upsertBulk(
   *   [{ username: 'alice', loginCount: sql<number>`(SELECT COUNT(*) FROM "login" WHERE "username" = ${'alice'})` }],
   *   { primaryKey: 'username', updateColumns: ['loginCount'] }
   * ).returning(u => ({ loginCount: u.loginCount }));
   * ```
   */
  upsertBulk(
    values: UpsertData<TEntity>[],
    config?: EntityUpsertConfig<TEntity>
  ): FluentUpsert<TEntity> {
    const table = this;

    const executeUpsertBulk = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      if (values.length === 0) {
        return returning === undefined ? undefined : [];
      }

      const schema = table._getSchema();

      // Handle primaryKey (can be lambda, string, or array)
      let primaryKeys: string[] = [];
      if (config?.primaryKey) {
        if (typeof config.primaryKey === 'function') {
          const pkProps = table.extractPropertyNames(config.primaryKey);
          primaryKeys = pkProps;
        } else if (Array.isArray(config.primaryKey)) {
          primaryKeys = config.primaryKey as string[];
        } else {
          primaryKeys = [config.primaryKey as string];
        }
      } else {
        // Auto-detect from schema
        for (const [key, colBuilder] of Object.entries(schema.columns)) {
          const colConfig = (colBuilder as any).build();
          if (colConfig.primaryKey) {
            primaryKeys.push(key);
          }
        }
      }

      // Handle updateColumns (can be lambda or array)
      let updateColumns: string[] | undefined;
      if (config?.updateColumns) {
        if (typeof config.updateColumns === 'function') {
          updateColumns = table.extractPropertyNames(config.updateColumns);
        } else {
          updateColumns = config.updateColumns as string[];
        }
      }

      // Auto-detect overridingSystemValue
      let overridingSystemValue = config?.overridingSystemValue;
      if (overridingSystemValue == null) {
        const referenceItem = config?.referenceItem || values[0];
        for (const key of Object.keys(referenceItem as object)) {
          const column = schema.columns[key];
          if (column) {
            const colConfig = (column as any).build();
            if (colConfig.primaryKey && colConfig.autoIncrement) {
              overridingSystemValue = true;
              break;
            }
          }
        }
      }

      // Typed conflict-arm expressions (updateSet / updateWhere)
      const upsertExpressions: UpsertExpressionConfig | undefined = config?.updateSet || config?.updateWhere
        ? { updateSet: config.updateSet as any, updateWhere: config.updateWhere as any }
        : undefined;

      // Calculate chunk size
      let chunkSize = config?.chunkSize;
      if (chunkSize == null) {
        const POSTGRES_MAX_PARAMS = 65535;
        const columnCount = Object.keys(values[0]).length;
        const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
        chunkSize = Math.floor(maxRowsPerBatch * 0.6);
      }

      // Process in chunks if needed
      if (values.length > chunkSize) {
        const allResults: any[] = [];
        for (let i = 0; i < values.length; i += chunkSize) {
          const chunk = values.slice(i, i + chunkSize);
          const chunkResults = await table.upsertBulkSingle(
            chunk, primaryKeys, updateColumns, config?.updateColumnFilter,
            overridingSystemValue || false, config?.targetWhere, config?.setWhere, returning, upsertExpressions
          );
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.upsertBulkSingle(
        values, primaryKeys, updateColumns, config?.updateColumnFilter,
        overridingSystemValue || false, config?.targetWhere, config?.setWhere, returning, upsertExpressions
      );
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeUpsertBulk(undefined).then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeUpsertBulk(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * The bare `INSERT .. ON CONFLICT` assembly (no RETURNING) shared by
   * {@link upsertBulkSingle} and the MutationBatch upsert-leg compile —
   * one definition so the two can never drift.
   * @internal
   */
  private buildUpsertStatementCore(
    values: Array<Record<string, any>>,
    primaryKeys: string[],
    updateColumns: string[] | undefined,
    updateColumnFilter: ((colId: string) => boolean) | undefined,
    overridingSystemValue: boolean,
    targetWhere: string | undefined,
    setWhere: string | undefined,
    expressions?: UpsertExpressionConfig
  ): { sql: string; params: any[] } {
    const schema = this._getSchema();
    const qualifiedTableName = this._getQualifiedTableName();

    // Extract all unique column names from all data objects
    const columnConfigs: Array<{ propName: string; dbName: string; mapper?: any }> = [];
    const columnSet = new Set<string>();

    for (const data of values) {
      for (const key of Object.keys(data)) {
        if (!columnSet.has(key)) {
          const column = schema.columns[key];
          if (column) {
            const config = (column as any).build();
            if (!config.autoIncrement || overridingSystemValue) {
              columnSet.add(key);
              columnConfigs.push({
                propName: key,
                dbName: config.name,
                mapper: config.mapper,
              });
            }
          }
        }
      }
    }

    // Build VALUES clauses
    const valuesClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const record of values) {
      const rowValues: string[] = [];
      for (const col of columnConfigs) {
        const value = (record as any)[col.propName];

        // If the value is a SqlFragment, inline it as a SQL expression (with its own
        // params merged into our params array) — mirrors update()'s UpdateData handling.
        // This allows e.g. a scalar subquery to be computed inside the INSERT itself
        // (and to flow into the DO UPDATE arm via EXCLUDED). The fragment must be
        // self-contained (no table alias is in scope inside a VALUES tuple) and its
        // interpolated values bypass the column's type mapper.
        if (value instanceof SqlFragment) {
          const sqlBuildContext: SqlBuildContext = {
            paramCounter: paramIndex,
            params,
          };
          const fragmentSql = value.buildSql(sqlBuildContext);
          paramIndex = sqlBuildContext.paramCounter;
          rowValues.push(fragmentSql);
          continue;
        }

        const mappedValue = col.mapper
          ? col.mapper.toDriver(value !== undefined ? value : null)
          : (value !== undefined ? value : null);
        rowValues.push(`$${paramIndex++}`);
        params.push(mappedValue);
      }
      valuesClauses.push(`(${rowValues.join(', ')})`);
    }

    const columnList = columnConfigs.map(c => `"${c.dbName}"`).join(', ');

    // Build SQL
    let sql = `INSERT INTO ${qualifiedTableName} (${columnList})`;

    if (overridingSystemValue) {
      sql += ' OVERRIDING SYSTEM VALUE';
    }

    sql += ` VALUES ${valuesClauses.join(', ')}`;

    // Add ON CONFLICT clause
    const conflictCols = primaryKeys.map(pk => {
      const col = columnConfigs.find(c => c.propName === pk);
      return col ? `"${col.dbName}"` : `"${pk}"`;
    }).join(', ');

    sql += ` ON CONFLICT (${conflictCols})`;

    if (targetWhere) {
      sql += ` WHERE ${targetWhere}`;
    }

    // Typed conflict-arm expressions: `existing` reads the target row by its table name,
    // `excluded` the row proposed for insertion.
    const expressionSet = expressions?.updateSet
      ? expressions.updateSet(
          this.createColumnRowProxy(schema.name, 'upsertBulk updateSet'),
          this.createColumnRowProxy('excluded', 'upsertBulk updateSet')
        )
      : undefined;
    const expressionWhere = expressions?.updateWhere
      ? expressions.updateWhere(
          this.createColumnRowProxy(schema.name, 'upsertBulk updateWhere'),
          this.createColumnRowProxy('excluded', 'upsertBulk updateWhere')
        )
      : undefined;

    // Determine columns to update
    let columnsToUpdate: string[];
    if (updateColumns) {
      columnsToUpdate = updateColumns;
    } else if (updateColumnFilter) {
      columnsToUpdate = Array.from(columnSet).filter(updateColumnFilter);
    } else if (expressionSet) {
      // updateSet alone names exactly the columns to update
      columnsToUpdate = [];
    } else {
      columnsToUpdate = Array.from(columnSet).filter(key => !primaryKeys.includes(key));
    }

    const expressionEntries = expressionSet ? Object.entries(expressionSet).filter(([, value]) => value !== undefined) : [];
    const expressionProps = new Set(expressionEntries.map(([propName]) => propName));

    if (columnsToUpdate.length === 0 && expressionEntries.length === 0) {
      sql += ' DO NOTHING';
    } else {
      const updateSetClauses = columnsToUpdate
        .filter(propName => !expressionProps.has(propName))
        .map(propName => {
          const col = columnConfigs.find(c => c.propName === propName);
          let dbName: string;
          if (col) {
            dbName = col.dbName;
          } else {
            // Column not in insert values, look up from schema
            const schemaCol = schema.columns[propName];
            const config = schemaCol ? (schemaCol as any).build() : null;
            dbName = config ? config.name : propName;
          }
          return `"${dbName}" = EXCLUDED."${dbName}"`;
        });

      const context: SqlBuildContext = { paramCounter: paramIndex, params };
      for (const [propName, value] of expressionEntries) {
        const column = schema.columns[propName];
        if (!column) {
          throw new Error(`upsertBulk updateSet: unknown column property "${propName}" on entity "${schema.name}"`);
        }
        const config = (column as any).build();
        updateSetClauses.push(`"${config.name}" = ${renderAssignedValue(value, config.mapper, context)}`);
      }
      paramIndex = context.paramCounter;

      sql += ` DO UPDATE SET ${updateSetClauses.join(', ')}`;

      const whereParts: string[] = [];
      if (setWhere) {
        whereParts.push(setWhere);
      }
      if (expressionWhere) {
        whereParts.push(expressionWhere.buildSql(context));
        paramIndex = context.paramCounter;
      }

      if (whereParts.length === 1) {
        sql += ` WHERE ${whereParts[0]}`;
      } else if (whereParts.length > 1) {
        sql += ` WHERE ${whereParts.map(part => `(${part})`).join(' AND ')}`;
      }
    }

    return { sql, params };
  }

  /**
   * A column-only row proxy whose FieldRefs render qualified by `alias` — the `existing` /
   * `excluded` rows of an upsert's conflict arm and the `t` / `v` rows of a bulk update.
   * Navigations are not in scope in those statements, so they throw on access.
   * @internal
   */
  private createColumnRowProxy(alias: string, usage: string): any {
    const schema = this._getSchema();
    const row: any = {};

    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build();
      const ref = {
        __fieldName: propName,
        __dbColumnName: config.name,
        __tableAlias: alias,
        __mapper: config.mapper,
        __sqlType: config.type,
      };
      Object.defineProperty(row, propName, { get: () => ref, enumerable: true });
    }

    for (const relName of Object.keys(schema.relations)) {
      Object.defineProperty(row, relName, {
        get: () => {
          throw new Error(`${usage}: navigation "${relName}" is not available — only the row's own columns are in scope`);
        },
        enumerable: false,
      });
    }

    return row;
  }

  /**
   * Builds a bare `UPDATE t SET .. WHERE "col" IN ($1, …)` statement (no
   * RETURNING) so `MutationBatch.addUpdateWhereIn` can compose it as a
   * data-modifying-CTE leg. SET semantics mirror the fluent `update()`:
   * plain values run through column mappers, `SqlFragment` values inline
   * with their params merged, and the lambda form resolves column refs
   * against this table's mock row. Returns null for an empty values array.
   * @internal
   */
  _buildUpdateWhereInStatement(
    field: string,
    values: any[],
    set: Record<string, any> | ((row: any) => Record<string, any>)
  ): { sql: string; params: any[] } | null {
    if (values.length === 0) {
      return null;
    }

    const schema = this._getSchema();
    const whereColBuilder = schema.columns[field];

    if (!whereColBuilder) {
      throw new Error(`updateWhereIn: unknown column property "${field}" on entity "${schema.name}"`);
    }

    const whereConfig = (whereColBuilder as any).build();
    const resolvedSet = typeof set === 'function' ? set(this.createMockEntity()) : set;

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(resolvedSet)) {
      const column = schema.columns[key];
      if (!column) {
        continue;
      }
      const config = (column as any).build();

      if (value instanceof SqlFragment) {
        const sqlBuildContext: SqlBuildContext = {
          paramCounter: paramIndex,
          params,
        };
        const fragmentSql = value.buildSql(sqlBuildContext);
        paramIndex = sqlBuildContext.paramCounter;
        setClauses.push(`"${config.name}" = ${fragmentSql}`);
        continue;
      }

      setClauses.push(`"${config.name}" = $${paramIndex++}`);
      params.push(config.mapper ? config.mapper.toDriver(value) : value);
    }

    if (setClauses.length === 0) {
      throw new Error(`updateWhereIn: no valid columns to update on entity "${schema.name}"`);
    }

    const whereParams = values.map(value => (whereConfig.mapper ? whereConfig.mapper.toDriver(value) : value));
    const placeholders = whereParams.map(() => `$${paramIndex++}`).join(', ');
    params.push(...whereParams);

    return {
      sql: `UPDATE ${this._getQualifiedTableName()} SET ${setClauses.join(', ')} WHERE "${whereConfig.name}" IN (${placeholders})`,
      params,
    };
  }

  /**
   * Bare `INSERT .. ON CONFLICT` compile (no RETURNING) for the MutationBatch
   * upsert leg — the {@link buildUpsertStatementCore} assembly with a narrow
   * plain config (prop-name primaryKey + updateColumns; no chunking, no
   * targetWhere/setWhere/system-value overrides in v1).
   * @internal
   */
  _buildUpsertBulkStatement(
    values: Array<Record<string, any>>,
    config: {
      primaryKey: string | string[];
      updateColumns?: string[];
      updateSet?: (existing: any, excluded: any) => Record<string, unknown>;
      updateWhere?: (existing: any, excluded: any) => Condition;
    }
  ): { sql: string; params: any[] } | null {
    if (values.length === 0) {
      return null;
    }

    const primaryKeys = Array.isArray(config.primaryKey) ? config.primaryKey : [config.primaryKey];

    return this.buildUpsertStatementCore(
      values,
      primaryKeys,
      config.updateColumns,
      undefined,
      false,
      undefined,
      undefined,
      config.updateSet || config.updateWhere
        ? { updateSet: config.updateSet, updateWhere: config.updateWhere }
        : undefined
    );
  }

  /**
   * Bare `INSERT INTO t (..) SELECT <cells> FROM "__MB_PARENT__" WHERE
   * "__MB_PARENT__"."<col>" <> $n` compile for the MutationBatch dependent
   * leg — a single row inserted iff the parent leg's exposed column differs
   * from the sentinel (the conditional-audit-log shape). Cells reuse the
   * insertWithChildren `$n::type` cast technique so types survive without a
   * VALUES-derived table; the `__MB_PARENT__` token is rewritten to the
   * parent's actual CTE name at batch assembly.
   * @internal
   */
  _buildDependentInsertSelectStatement(
    row: Record<string, any>,
    whereColumnAlias: string,
    whereNotEquals: any
  ): { sql: string; params: any[] } {
    const schema = this._getSchema();
    const compiled = this.compileValuesWithCasts(schema, [row], null);
    const columnList = compiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const params = [...compiled.params];
    const sentinelIndex = params.length + 1;
    params.push(whereNotEquals);

    return {
      sql: `INSERT INTO ${this._getQualifiedTableName()} (${columnList}) SELECT ${compiled.valueRows[0]} FROM "__MB_PARENT__" WHERE "__MB_PARENT__"."${whereColumnAlias}" <> $${sentinelIndex}`,
      params,
    };
  }

  /**
   * Compiles an insertBulkWithChildren persist into the CTE TRIPLE a
   * MutationBatch leg emits as siblings of the batch statement:
   *
   *   `_p` — parent INSERT, input-ordinal ORDER BY (serial ids ascend in input
   *          order), RETURNING *;
   *   `_o` — the ordinal recovery (`row_number() OVER (ORDER BY pk) - 1`);
   *   `_c` — child INSERT joining `_o` on the input index for the FK.
   *
   * Sibling CTE names are referenced through the `__MB_SELF__` token — the
   * batch rewrites it to the leg's actual prefix at assembly. Params are ONE
   * $1-based space across the triple (child placeholders pre-shifted here).
   * Unlike the standalone form, childless parents are allowed — the leg reads
   * parents from `_o` directly, not through the child join.
   * @internal
   */
  _buildInsertBulkWithChildrenCtes(config: {
    rows: Record<string, any>[];
    children: { table: any; foreignKey: string; rows: Array<{ parentIndex: number; row: Record<string, any> }> };
  }): { ctes: Array<{ suffix: string; sql: string }>; params: any[] } {
    const parentSchema = this._getSchema();
    const childTable = config.children.table;

    if (childTable._getClient() !== this._getClient() || childTable._getExecutor() !== this._getExecutor()) {
      throw new Error('insertBulkWithChildren leg: the child table uses a different database client or transaction than the parent — both must share one connection context');
    }

    const pkEntries = Object.entries(parentSchema.columns).filter(([, colBuilder]) => (colBuilder as any).build().primaryKey);

    if (pkEntries.length !== 1) {
      throw new Error('insertBulkWithChildren leg requires a single-column parent primary key');
    }

    for (const child of config.children.rows) {
      if (child.parentIndex < 0 || child.parentIndex >= config.rows.length) {
        throw new Error(`insertBulkWithChildren leg: child parentIndex ${child.parentIndex} is out of range for ${config.rows.length} parent row(s)`);
      }
    }

    const parentPkDbName = (pkEntries[0][1] as any).build().name;
    const parentCompiled = this.compileValuesWithCasts(parentSchema, config.rows, null);
    const parentColNames = parentCompiled.columns.map(c => `"${c.dbName}"`).join(', ');
    const parentSelectCols = parentCompiled.columns.map(c => `v."${c.dbName}"`).join(', ');
    const parentValueRows = parentCompiled.valueRows.map((row, ix) => `(${ix}, ${row})`).join(', ');

    const parentSql = `INSERT INTO ${this._getQualifiedTableName()} (${parentColNames})
SELECT ${parentSelectCols} FROM (VALUES ${parentValueRows}) AS v("__mbw_ord", ${parentColNames})
ORDER BY v."__mbw_ord"
RETURNING *`;

    const ordinalSql = `SELECT p.*, row_number() OVER (ORDER BY p."${parentPkDbName}") - 1 AS "__mbw_ord"
FROM "__MB_SELF___p" p`;

    const childSchema = childTable._getSchema();
    const fkColBuilder = childSchema.columns[config.children.foreignKey];

    if (!fkColBuilder) {
      throw new Error(`insertBulkWithChildren leg: unknown child foreign-key property "${config.children.foreignKey}"`);
    }

    const fkDbName = (fkColBuilder as any).build().name;
    const childCompiled = childTable.compileValuesWithCasts(childSchema, config.children.rows.map((r: { row: Record<string, any> }) => r.row), config.children.foreignKey);
    const childColNames = childCompiled.columns.map((c: { dbName: string }) => `"${c.dbName}"`).join(', ');
    const childSelectCols = childCompiled.columns.map((c: { dbName: string }) => `v."${c.dbName}"`).join(', ');
    const childValueRows = childCompiled.valueRows.map((row: string, ix: number) => `(${ix}, ${config.children.rows[ix].parentIndex}, ${row})`).join(', ');

    let childSql = `INSERT INTO ${childTable._getQualifiedTableName()} ("${fkDbName}", ${childColNames})
SELECT o."${parentPkDbName}", ${childSelectCols}
FROM (VALUES ${childValueRows}) AS v("__mbw_cord", "__mbw_pix", ${childColNames})
JOIN "__MB_SELF___o" o ON o."__mbw_ord" = v."__mbw_pix"
ORDER BY v."__mbw_cord"
RETURNING 1`;
    childSql = parentCompiled.params.length === 0 ? childSql : renumberPlaceholders(childSql, parentCompiled.params.length);

    return {
      ctes: [
        { suffix: 'p', sql: parentSql },
        { suffix: 'o', sql: ordinalSql },
        { suffix: 'c', sql: childSql },
      ],
      params: [...parentCompiled.params, ...childCompiled.params],
    };
  }

  /**
   * Resolves entity property names to their DB column names (throws on an
   * unknown property) — the MutationBatch expose/returning lists come in as
   * prop names and compile to quoted DB identifiers.
   * @internal
   */
  _resolveColumnDbNames(props: string[]): Array<{ prop: string; dbName: string }> {
    const schema = this._getSchema();

    return props.map((prop) => {
      const colBuilder = schema.columns[prop];

      if (!colBuilder) {
        throw new Error(`Unknown column property "${prop}" on entity "${schema.name}"`);
      }

      return { prop, dbName: (colBuilder as any).build().name };
    });
  }

  /**
   * Execute a single upsert batch
   * @internal
   */
  private async upsertBulkSingle<TReturning>(
    values: UpsertData<TEntity>[],
    primaryKeys: string[],
    updateColumns: string[] | undefined,
    updateColumnFilter: ((colId: string) => boolean) | undefined,
    overridingSystemValue: boolean,
    targetWhere: string | undefined,
    setWhere: string | undefined,
    returning: TReturning,
    expressions?: UpsertExpressionConfig
  ): Promise<any[] | void> {
    const executor = this._getExecutor();
    const client = this._getClient();

    const built = this.buildUpsertStatementCore(
      values as Array<Record<string, any>>,
      primaryKeys,
      updateColumns,
      updateColumnFilter,
      overridingSystemValue,
      targetWhere,
      setWhere,
      expressions
    );
    let sql = built.sql;
    const params = built.params;

    // Check if RETURNING uses navigation properties
    const navigationInfo = returning && returning !== true && typeof returning === 'function'
      ? this.detectNavigationInReturning(returning as any)
      : null;

    if (navigationInfo) {
      // Use CTE-based approach for navigation properties
      const { sql: cteSql, params: queryParams, read } = this.buildReturningWithNavigation(
        sql,
        params,
        returning as any,
        navigationInfo
      );

      const result = executor
        ? await executor.query(cteSql, queryParams)
        : await client.query(cteSql, queryParams);

      return this.readReturning(result.rows, read);
    }

    // Standard RETURNING (no navigation properties)
    const returningClause = this.buildReturningClause(returning as any, undefined, { paramCounter: params.length + 1, params });
    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, params)
      : await client.query(sql, params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returningClause);
  }

  /**
   * Bulk MERGE (PostgreSQL 15+) — upsert-like semantics with a PER-QUERY match
   * condition instead of a unique-index arbiter.
   *
   * `ON CONFLICT` requires a unique/exclusion constraint matching the conflict
   * target; `MERGE` does not — the identity is whatever the statement's `ON`
   * condition says. `config.on` names the identity column(s) explicitly and
   * `config.matchWhere` scopes the match with raw SQL (target alias `t`,
   * source alias `s`), e.g. soft-deletable masterdata matching only ACTIVE
   * rows:
   *
   * ```typescript
   * await db.registryItems.mergeBulk(items, {
   *   on: 'crmId',
   *   matchWhere: 't."active" = TRUE',
   *   updateColumns: ['name', 'active'],
   * });
   * ```
   *
   * Renders:
   * `MERGE INTO … AS t USING (VALUES …) AS s (…) ON t."crm_id" = s."crm_id"
   *  AND (t."active" = TRUE) WHEN MATCHED THEN UPDATE SET … WHEN NOT MATCHED
   *  THEN INSERT …`.
   *
   * Caveats (PostgreSQL semantics, not ORM choices):
   *  - each TARGET row may be matched by at most ONE source row — Postgres
   *    raises `MERGE command cannot affect row a second time` otherwise, so
   *    dedupe the input by the `on` key(s);
   *  - MERGE has no `ON CONFLICT`-style speculative insertion: two concurrent
   *    merges can both take the NOT MATCHED arm (duplicate rows, or a unique
   *    violation if an index exists). Prefer `upsertBulk` for hot concurrent
   *    paths; MERGE suits single-writer sync/batch flows;
   *  - `.returning()` requires PostgreSQL 17+. A selector reading navigations or
   *    collections runs the MERGE in a CTE the navigations are joined onto, as
   *    insertBulk / upsertBulk do; a row's navigation reads its values AFTER the
   *    merge (an updated foreign key reaches the new row).
   */
  mergeBulk(
    values: UpsertData<TEntity>[],
    config: EntityMergeConfig<TEntity>
  ): FluentMerge<TEntity> {
    const table = this;

    const executeMergeBulk = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      if (values.length === 0) {
        return returning === undefined ? undefined : [];
      }

      // Resolve the match columns (lambda, string, or array). Always explicit —
      // there is no constraint to fall back to, so `on` is required.
      let onKeys: string[] = [];
      if (typeof config.on === 'function') {
        onKeys = table.extractPropertyNames(config.on as (entity: TEntity) => any);
      } else if (Array.isArray(config.on)) {
        onKeys = config.on as string[];
      } else if (config.on != null) {
        onKeys = [config.on as string];
      }
      if (onKeys.length === 0) {
        throw new Error('mergeBulk requires config.on — the explicit identity column(s) for the match condition');
      }

      // Handle updateColumns (can be lambda or array)
      let updateColumns: string[] | undefined;
      if (config.updateColumns) {
        updateColumns = typeof config.updateColumns === 'function'
          ? table.extractPropertyNames(config.updateColumns)
          : (config.updateColumns as string[]);
      }

      // Calculate chunk size (same bound as upsertBulk)
      let chunkSize = config.chunkSize;
      if (chunkSize == null) {
        const POSTGRES_MAX_PARAMS = 65535;
        const columnCount = Object.keys(values[0]).length;
        const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
        chunkSize = Math.floor(maxRowsPerBatch * 0.6);
      }

      if (values.length > chunkSize) {
        const allResults: any[] = [];
        for (let i = 0; i < values.length; i += chunkSize) {
          const chunk = values.slice(i, i + chunkSize);
          const chunkResults = await table.mergeBulkSingle(
            chunk, onKeys, config.matchWhere, updateColumns, config.updateColumnFilter, returning
          );
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.mergeBulkSingle(
        values, onKeys, config.matchWhere, updateColumns, config.updateColumnFilter, returning
      );
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeMergeBulk(undefined).then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeMergeBulk(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Execute a single MERGE batch
   * @internal
   */
  private async mergeBulkSingle<TReturning>(
    values: UpsertData<TEntity>[],
    onKeys: string[],
    matchWhere: string | undefined,
    updateColumns: string[] | undefined,
    updateColumnFilter: ((colId: string) => boolean) | undefined,
    returning: TReturning
  ): Promise<any[] | void> {
    const schema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();
    const qualifiedTableName = this._getQualifiedTableName();

    // Extract all unique column names from all data objects (mirrors upsertBulkSingle,
    // minus the identity-column skip — MERGE source rows carry every provided value).
    const columnConfigs: Array<{ propName: string; dbName: string; sqlType?: string; mapper?: any }> = [];
    const columnSet = new Set<string>();

    for (const data of values) {
      for (const key of Object.keys(data)) {
        if (!columnSet.has(key)) {
          const column = schema.columns[key];
          if (column) {
            const cfg = (column as any).build();
            columnSet.add(key);
            columnConfigs.push({
              propName: key,
              dbName: cfg.name,
              sqlType: cfg.type,
              mapper: cfg.mapper,
            });
          }
        }
      }
    }

    for (const onKey of onKeys) {
      if (!columnConfigs.some(c => c.propName === onKey)) {
        throw new Error(`mergeBulk: identity column "${onKey}" is not present in the provided values`);
      }
    }

    // VALUES column types resolve from the FIRST row: cast it to the declared
    // column types so `s.*` compares and assigns with proper types instead of
    // `unknown`/text (serial pseudo-types cast to their integer base).
    const castForType = (sqlType?: string): string => {
      if (!sqlType || sqlType === 'array') return '';
      const baseType = sqlType === 'serial' ? 'integer'
        : sqlType === 'smallserial' ? 'smallint'
        : sqlType === 'bigserial' ? 'bigint'
        : sqlType;
      return `::${baseType}`;
    };

    const valuesClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (let rowIndex = 0; rowIndex < values.length; rowIndex++) {
      const record = values[rowIndex];
      const rowValues: string[] = [];
      for (const col of columnConfigs) {
        const value = (record as any)[col.propName];
        const cast = rowIndex === 0 ? castForType(col.sqlType) : '';

        // SqlFragment values inline as SQL expressions, matching upsertBulkSingle.
        if (value instanceof SqlFragment) {
          const sqlBuildContext: SqlBuildContext = {
            paramCounter: paramIndex,
            params,
          };
          const fragmentSql = value.buildSql(sqlBuildContext);
          paramIndex = sqlBuildContext.paramCounter;
          rowValues.push(`(${fragmentSql})${cast}`);
          continue;
        }

        const mappedValue = col.mapper
          ? col.mapper.toDriver(value !== undefined ? value : null)
          : (value !== undefined ? value : null);
        rowValues.push(`$${paramIndex++}${cast}`);
        params.push(mappedValue);
      }
      valuesClauses.push(`(${rowValues.join(', ')})`);
    }

    const sourceColumnList = columnConfigs.map(c => `"${c.dbName}"`).join(', ');

    const onConditions = onKeys.map(onKey => {
      const col = columnConfigs.find(c => c.propName === onKey)!;
      return `t."${col.dbName}" = s."${col.dbName}"`;
    });
    if (matchWhere) {
      onConditions.push(`(${matchWhere})`);
    }

    let sql = `MERGE INTO ${qualifiedTableName} AS t`
      + ` USING (VALUES ${valuesClauses.join(', ')}) AS s (${sourceColumnList})`
      + ` ON ${onConditions.join(' AND ')}`;

    // WHEN MATCHED arm: update the requested columns (default: everything that
    // is not part of the match identity); empty selection → DO NOTHING.
    let columnsToUpdate: string[];
    if (updateColumns) {
      columnsToUpdate = updateColumns;
    } else if (updateColumnFilter) {
      columnsToUpdate = Array.from(columnSet).filter(updateColumnFilter);
    } else {
      columnsToUpdate = Array.from(columnSet).filter(key => !onKeys.includes(key));
    }

    if (columnsToUpdate.length === 0) {
      sql += ` WHEN MATCHED THEN DO NOTHING`;
    } else {
      const updateSetClauses = columnsToUpdate.map(propName => {
        const col = columnConfigs.find(c => c.propName === propName);
        let dbName: string;
        if (col) {
          dbName = col.dbName;
        } else {
          const schemaCol = schema.columns[propName];
          const cfg = schemaCol ? (schemaCol as any).build() : null;
          dbName = cfg ? cfg.name : propName;
        }
        return `"${dbName}" = s."${dbName}"`;
      });
      sql += ` WHEN MATCHED THEN UPDATE SET ${updateSetClauses.join(', ')}`;
    }

    sql += ` WHEN NOT MATCHED THEN INSERT (${sourceColumnList})`
      + ` VALUES (${columnConfigs.map(c => `s."${c.dbName}"`).join(', ')})`;

    // RETURNING (PostgreSQL 17+). Columns are target-qualified (`t.`): in MERGE … RETURNING both
    // the target and source aliases are in scope, so unqualified names are ambiguous.
    const navigationInfo = returning && returning !== true && typeof returning === 'function'
      ? this.detectNavigationInReturning(returning as any)
      : null;

    if (navigationInfo) {
      // Navigations and collections: the MERGE runs in a CTE the outer SELECT joins them to, as
      // insertBulk / upsertBulk do (MERGE … RETURNING is a valid WITH query)
      const { sql: cteSql, params: queryParams, read } = this.buildReturningWithNavigation(
        sql,
        params,
        returning as any,
        navigationInfo,
        { returningQualifier: 't' }
      );

      const result = executor
        ? await executor.query(cteSql, queryParams)
        : await client.query(cteSql, queryParams);

      return this.readReturning(result.rows, read);
    }

    const returningClause = this.buildReturningClause(returning as any, 't', { paramCounter: params.length + 1, params });
    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, params)
      : await client.query(sql, params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returningClause);
  }

  /**
   * Map database column names back to property names.
   *
   * The property/column/mapper plan is derived from the schema ONCE and cached
   * per schema object (the registry returns stable instances): the previous
   * implementation ran Object.entries + ColumnBuilder.build() PER COLUMN PER
   * ROW — ~30k config constructions for a 3000-row × 10-column read, the
   * single largest ORM-side cost in the CPU profile (~4% of total samples).
   */
  private mapResultToEntity(result: any): UnwrapDbColumns<TEntity> {
    const plan = this.getEntityMappingPlan();
    const mapped: any = {};

    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      if (entry.dbColumnName in result) {
        const rawValue = result[entry.dbColumnName];
        // Apply fromDriver mapper if present
        mapped[entry.propName] = entry.mapper ? entry.mapper.fromDriver(rawValue) : rawValue;
      }
    }
    return mapped as UnwrapDbColumns<TEntity>;
  }

  /** Lazily built + schema-cached column plan for {@link mapResultToEntity}. */
  private getEntityMappingPlan(): Array<{ propName: string; dbColumnName: string; mapper?: any; zeroScale?: any }> {
    const schema = this._getSchema();
    let plan = entityMappingPlanCache.get(schema);

    if (!plan) {
      plan = Object.entries(schema.columns).map(([propName, colBuilder]) => {
        const config = (colBuilder as any).build();
        return { propName, dbColumnName: config.name, mapper: config.mapper, zeroScale: numericZeroScaleMapper(config) };
      });
      entityMappingPlanCache.set(schema, plan);
    }

    return plan;
  }

  /**
   * Map array of database results to entities.
   *
   * All rows of one result set share the same column shape, so the
   * present-column subset of the mapping plan is derived from the first row
   * once, and the per-row loop runs without `in` checks.
   */
  private mapResultsToEntities(results: any[]): UnwrapDbColumns<TEntity>[] {
    if (results.length === 0) {
      return [];
    }

    // A numeric(p, s) zero read through a client that drops its scale gets it back
    const restoreZeroScale = this._getClient().losesNumericZeroScale();
    const presentPlan = this.getEntityMappingPlan()
      .filter(entry => entry.dbColumnName in results[0])
      .map(entry => ({ ...entry, mapper: entry.mapper ?? (restoreZeroScale ? entry.zeroScale : undefined) }));
    const mapped: UnwrapDbColumns<TEntity>[] = new Array(results.length);

    for (let rowIndex = 0; rowIndex < results.length; rowIndex++) {
      const row = results[rowIndex];
      const entity: any = {};

      for (let i = 0; i < presentPlan.length; i++) {
        const entry = presentPlan[i];
        const rawValue = row[entry.dbColumnName];
        entity[entry.propName] = entry.mapper ? entry.mapper.fromDriver(rawValue) : rawValue;
      }

      mapped[rowIndex] = entity;
    }

    return mapped;
  }

  /**
   * Extract property names from lambda selector
   */
  private extractPropertyNames(selector: Function): string[] {
    const selectorStr = selector.toString();
    // Match patterns like: e => e.username or e => ({ username: e.username, email: e.email })
    const propertyNames: string[] = [];

    // Simple property access: e => e.username
    const simpleMatch = selectorStr.match(/=>\s*\w+\.(\w+)/);
    if (simpleMatch) {
      propertyNames.push(simpleMatch[1]);
      return propertyNames;
    }

    // Object literal: e => ({ username: e.username, email: e.email })
    const objectMatches = selectorStr.matchAll(/(\w+):\s*\w+\.\1/g);
    for (const match of objectMatches) {
      propertyNames.push(match[1]);
    }

    return propertyNames;
  }

  /**
   * Start building an upsert query with values
   */
  values(data: InsertData<TEntity> | InsertData<TEntity>[]): EntityInsertBuilder<TEntity> {
    const builder = this.context.getTable(this.tableName).values(data as any);
    return new EntityInsertBuilder<TEntity>(builder, rows => this.mapResultsToEntities(rows));
  }

  /**
   * Update all records in the table
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * Usage:
   *   await db.users.update({ age: 30 }) // Update all
   *   await db.users.where(u => eq(u.id, 1)).update({ age: 30 }) // Update with condition
   *   const updated = await db.users.where(u => eq(u.id, 1)).update({ age: 30 }).returning()
   */
  update(
    data: UpdateData<TEntity>
      | ((row: EntityQuery<TEntity>) => UpdateData<TEntity>)
  ): FluentQueryUpdate<UnwrapDbColumns<TEntity>, EntityQuery<TEntity>> {
    // Every row: the query update over a condition every row meets — the same SET rendering
    // (column mappers, sql fragments), RETURNING (navigations, collections, sql expressions),
    // affected count and toStatement() as `where(...).update()`. This path used to bind values
    // without their column mappers, render a navigation column in RETURNING as the root's column
    // of that name, and drop the RETURNING's sql expressions.
    return (this.where(() => new SqlFragment<boolean>(['TRUE'], [])) as any).update(data);
  }

  /**
   * Bulk update multiple records efficiently using PostgreSQL VALUES clause
   * Updates records matching primary key(s) with provided data
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @param data Array of objects with primary key(s) and columns to update
   * @param config Optional configuration for the bulk update
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.bulkUpdate([
   *   { id: 1, age: 30 },
   *   { id: 2, age: 25 },
   * ]);
   *
   * // With returning() - returns full entities
   * const updated = await db.users.bulkUpdate([{ id: 1, age: 30 }]).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.bulkUpdate([{ id: 1, age: 30 }])
   *   .returning(u => ({ id: u.id, age: u.age }));
   *
   * // With custom primary key
   * await db.users.bulkUpdate(
   *   [{ username: 'alice', age: 31 }],
   *   { primaryKey: 'username' }
   * );
   * ```
   */
  bulkUpdate(
    data: Array<Partial<InsertData<TEntity>> & Record<string, any>>,
    config?: {
      /** Primary key column(s) to match records. Auto-detected if not specified */
      primaryKey?: string | string[];
      /** Chunk size for large batches. Auto-calculated if not specified */
      chunkSize?: number;
    } & BulkUpdateExpressionConfig<TEntity>
  ): FluentBulkUpdate<TEntity> {
    const table = this;
    const expressions: BulkUpdateExpressionConfig<TEntity> | undefined = config?.set || config?.where
      ? { set: config.set, where: config.where }
      : undefined;

    const executeBulkUpdate = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      if (data.length === 0) {
        return returning === undefined ? undefined : [];
      }

      const primaryKeys = table._resolveBulkUpdatePrimaryKeys(data, config);

      // Calculate chunk size
      let chunkSize = config?.chunkSize;
      if (chunkSize == null) {
        const POSTGRES_MAX_PARAMS = 65535;
        const referenceItem = data[0];
        const columnCount = Object.keys(referenceItem).length;
        const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
        chunkSize = Math.floor(maxRowsPerBatch * 0.6);
      }

      // Process in chunks if needed
      if (data.length > chunkSize) {
        const allResults: any[] = [];
        for (let i = 0; i < data.length; i += chunkSize) {
          const chunk = data.slice(i, i + chunkSize);
          const chunkResults = await table.bulkUpdateSingle(chunk, primaryKeys, returning, expressions);
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.bulkUpdateSingle(data, primaryKeys, returning, expressions);
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeBulkUpdate(undefined).then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeBulkUpdate(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /** Static type map for PostgreSQL type casting - computed once */
  private static readonly PG_TYPE_MAP: Record<string, string> = {
    'smallint': 'smallint',
    'integer': 'integer',
    'bigint': 'bigint',
    'serial': 'integer',
    'smallserial': 'smallint',
    'bigserial': 'bigint',
    'decimal': 'decimal',
    'numeric': 'numeric',
    'real': 'real',
    'double precision': 'double precision',
    'money': 'money',
    'varchar': 'varchar',
    'char': 'char',
    'text': 'text',
    'bytea': 'bytea',
    'timestamp': 'timestamp',
    'timestamptz': 'timestamptz',
    'date': 'date',
    'time': 'time',
    'timetz': 'timetz',
    'interval': 'interval',
    'boolean': 'boolean',
    'uuid': 'uuid',
    'json': 'json',
    'jsonb': 'jsonb',
    'inet': 'inet',
    'cidr': 'cidr',
    'macaddr': 'macaddr',
    'macaddr8': 'macaddr8',
  };

  /**
   * Execute a single bulk update batch
   * @internal
   */
  private async bulkUpdateSingle<TReturning>(
    data: Array<Partial<InsertData<TEntity>> & Record<string, any>>,
    primaryKeys: string[],
    returning: TReturning,
    expressions?: BulkUpdateExpressionConfig<TEntity>
  ): Promise<any[] | void> {
    const executor = this._getExecutor();
    const client = this._getClient();

    const built = this._buildBulkUpdateStatement(data, primaryKeys, expressions);

    // Navigations and collections: the UPDATE runs in a CTE the outer SELECT joins them to, as the
    // other mutations do — they rendered as the target row's column of the same name (`t."name"`)
    const navigationInfo = returning && returning !== true && typeof returning === 'function'
      ? this.detectNavigationInReturning(returning as any)
      : null;

    if (navigationInfo) {
      const { sql: cteSql, params: queryParams, read } = this.buildReturningWithNavigation(
        built.sql,
        built.params,
        returning as any,
        navigationInfo,
        { returningQualifier: 't' }
      );

      const result = executor
        ? await executor.query(cteSql, queryParams)
        : await client.query(cteSql, queryParams);

      return this.readReturning(result.rows, read);
    }

    // Build RETURNING clause
    const returningClause = this.buildReturningClause(returning as any, 't', { paramCounter: built.params.length + 1, params: built.params });

    let sql = built.sql;
    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, built.params)
      : await client.query(sql, built.params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returningClause);
  }

  /**
   * Resolves + validates the primary key columns a bulkUpdate matches rows on —
   * shared by {@link bulkUpdate} and `MutationBatch`.
   * @internal
   */
  _resolveBulkUpdatePrimaryKeys(
    data: Array<Partial<InsertData<TEntity>> & Record<string, any>>,
    config?: { primaryKey?: string | string[] }
  ): string[] {
    const schema = this._getSchema();

    // Determine primary keys
    let primaryKeys: string[] = [];
    if (config?.primaryKey) {
      primaryKeys = Array.isArray(config.primaryKey) ? config.primaryKey : [config.primaryKey];
    } else {
      // Auto-detect from schema
      for (const [key, colBuilder] of Object.entries(schema.columns)) {
        const colConfig = (colBuilder as any).build();
        if (colConfig.primaryKey) {
          primaryKeys.push(key);
        }
      }
    }

    if (primaryKeys.length === 0) {
      throw new Error('bulkUpdate requires at least one primary key column');
    }

    // Validate all records have primary keys
    for (let i = 0; i < data.length; i++) {
      for (const pk of primaryKeys) {
        if (data[i][pk] === undefined) {
          throw new Error(`Record at index ${i} is missing primary key "${pk}"`);
        }
      }
    }

    return primaryKeys;
  }

  /**
   * Builds the bare `UPDATE ... FROM (VALUES ...)` statement (no RETURNING
   * clause) for ONE chunk of rows — exactly the SQL {@link bulkUpdateSingle}
   * executes (per-row `"col__provided"` CASE flags included), exposed
   * separately so `MutationBatch` can compose it as a data-modifying CTE leg.
   * @internal
   */
  _buildBulkUpdateStatement(
    data: Array<Partial<InsertData<TEntity>> & Record<string, any>>,
    primaryKeys: string[],
    expressions?: BulkUpdateExpressionConfig<TEntity>
  ): { sql: string; params: any[] } {
    const schema = this._getSchema();
    const qualifiedTableName = this._getQualifiedTableName();
    const primaryKeySet = new Set(primaryKeys);

    // Single pass: collect columns and build column info simultaneously
    const updateColumnsSet = new Set<string>();
    const allColumnsSet = new Set<string>(primaryKeys);

    for (const record of data) {
      for (const key of Object.keys(record)) {
        if (schema.columns[key]) {
          allColumnsSet.add(key);
          if (!primaryKeySet.has(key)) {
            updateColumnsSet.add(key);
          }
        }
      }
    }

    // Typed SET / WHERE over the target row (`t`) and the incoming VALUES row (`v`)
    const expressionSet = expressions?.set
      ? expressions.set(this.createColumnRowProxy('t', 'bulkUpdate set'), this.createColumnRowProxy('v', 'bulkUpdate set'))
      : undefined;
    const expressionWhere = expressions?.where
      ? expressions.where(this.createColumnRowProxy('t', 'bulkUpdate where'), this.createColumnRowProxy('v', 'bulkUpdate where'))
      : undefined;
    const expressionEntries = expressionSet
      ? Object.entries(expressionSet as Record<string, unknown>).filter(([, value]) => value !== undefined)
      : [];

    for (const [propName] of expressionEntries) {
      if (!schema.columns[propName]) {
        throw new Error(`bulkUpdate set: unknown column property "${propName}" on entity "${schema.name}"`);
      }
      if (primaryKeySet.has(propName)) {
        throw new Error(`bulkUpdate set: "${propName}" is a match key and cannot be assigned`);
      }
    }

    // A `v` column is only in scope when some row provides it
    const providedDbNames = new Set(Array.from(allColumnsSet).map(prop => (schema.columns[prop] as any).build().name));
    const valueRefs = [
      ...expressionEntries.flatMap(([, value]) => collectRefsOf(value)),
      ...(expressionWhere ? expressionWhere.getFieldRefs() : []),
    ];
    for (const ref of valueRefs) {
      if ((ref as any).__tableAlias === 'v' && !providedDbNames.has(ref.__dbColumnName)) {
        throw new Error(
          `bulkUpdate set/where reads values.${(ref as any).__fieldName}, but no row provides "${(ref as any).__fieldName}"`
        );
      }
    }

    if (updateColumnsSet.size === 0 && expressionEntries.length === 0) {
      throw new Error('No columns to update (only primary keys provided)');
    }

    // Build column info - access config once per column
    const columnInfoList: Array<{ propName: string; dbName: string; pgType: string; isPK: boolean; mapper?: any }> = [];
    const valueColumnParts: string[] = [];
    const setClauses: string[] = [];
    const whereClauseParts: string[] = [];

    for (const propName of allColumnsSet) {
      const colConfig = (schema.columns[propName] as any).build();
      const dbName = colConfig.name;
      const pgType = DbEntityTable.PG_TYPE_MAP[colConfig.type] || colConfig.type;
      const isPK = primaryKeySet.has(propName);

      const info = { propName, dbName, pgType, isPK, mapper: colConfig.mapper };
      columnInfoList.push(info);

      // Build VALUES column list
      valueColumnParts.push(`"${dbName}"`);
      if (!isPK) {
        valueColumnParts.push(`"${dbName}__provided"`);
        // Build SET clause
        setClauses.push(`"${dbName}" = CASE WHEN v."${dbName}__provided" THEN v."${dbName}" ELSE t."${dbName}" END`);
      } else {
        // Build WHERE clause for PK
        whereClauseParts.push(`t."${dbName}" = v."${dbName}"`);
      }
    }

    const valueColumnList = valueColumnParts.join(', ');
    const whereClause = whereClauseParts.join(' AND ');

    // Build VALUES clause with parameters - single pass over data
    const valuesClauses: string[] = [];
    const params: any[] = [];
    const cellContext: SqlBuildContext = { paramCounter: 1, params };

    for (const record of data) {
      const rowValues: string[] = [];
      for (const col of columnInfoList) {
        const hasKey = col.propName in record;
        const rawValue = record[col.propName];

        // An sql fragment inline, typed like the column (it used to be bound AS a parameter)
        if (rawValue instanceof SqlFragment) {
          rowValues.push(renderValuesCell(rawValue, col.mapper, cellContext, `::${col.pgType}`));
          if (!col.isPK) {
            rowValues.push(hasKey ? 'true' : 'false');
          }
          continue;
        }

        // Apply the column's toDriver mapper (e.g. Temporal -> driver string) so bulk
        // updates serialize values the same way insert and `where().update()` do.
        // Without this, class instances such as Temporal.PlainDateTime reach the pg
        // driver raw and throw "argument must be of type string ... Received an
        // instance of PlainDateTime".
        const value = col.mapper ? col.mapper.toDriver(rawValue) : rawValue;

        // Add the value (always cast to correct type for NULL to work in CASE expressions)
        if (value === undefined || value === null) {
          rowValues.push(`NULL::${col.pgType}`);
        } else {
          rowValues.push(`$${cellContext.paramCounter++}::${col.pgType}`);
          params.push(value);
        }

        // Add the "was provided" flag for non-PK columns
        if (!col.isPK) {
          rowValues.push(hasKey ? 'true' : 'false');
        }
      }
      valuesClauses.push(`(${rowValues.join(', ')})`);
    }

    let effectiveSetClauses = setClauses;
    let effectiveWhereClause = whereClause;

    if (expressionEntries.length > 0 || expressionWhere) {
      // The expressions continue the VALUES cells' parameter numbering
      const context = cellContext;
      const assigned = new Map<string, string>();

      for (const [propName, value] of expressionEntries) {
        const colConfig = (schema.columns[propName] as any).build();
        assigned.set(colConfig.name, `"${colConfig.name}" = ${renderAssignedValue(value, colConfig.mapper, context)}`);
      }

      // An expression replaces the provided-flag CASE of its column; other columns keep theirs
      effectiveSetClauses = columnInfoList
        .filter(col => !col.isPK && !assigned.has(col.dbName))
        .map(col => `"${col.dbName}" = CASE WHEN v."${col.dbName}__provided" THEN v."${col.dbName}" ELSE t."${col.dbName}" END`)
        .concat(Array.from(assigned.values()));

      if (expressionWhere) {
        effectiveWhereClause = `${whereClause} AND (${expressionWhere.buildSql(context)})`;
      }
    }

    const sql = `
UPDATE ${qualifiedTableName} AS t
SET ${effectiveSetClauses.join(', ')}
FROM (VALUES ${valuesClauses.join(', ')}) AS v(${valueColumnList})
WHERE ${effectiveWhereClause}`.trim();

    return { sql, params };
  }

  /**
   * Delete all records from the table
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * Usage:
   *   await db.users.delete() // Delete all
   *   await db.users.where(u => eq(u.id, 1)).delete() // Delete with condition
   *   const deleted = await db.users.where(u => eq(u.id, 1)).delete().returning()
   */
  delete(): FluentDelete<UnwrapDbColumns<TEntity>, EntityQuery<TEntity>> {
    // Every row: the query delete over a condition every row meets — the same RETURNING
    // (navigations, collections, sql expressions), affected count and toStatement() as
    // `where(...).delete()`
    return (this.where(() => new SqlFragment<boolean>(['TRUE'], [])) as any).delete();
  }

  /**
   * Create a mock entity for type inference in lambdas
   *
   * @param pathAnchor The alias the row renders under, for a build that reads navigations off it —
   *   a navigation RETURNING passes MUTATION_ROW_ALIAS. With it, a reference navigation records the
   *   path it is reached by (a field ref carries the relation names of the hops above its own in
   *   `__navigationAliases`; without them `ln.book` and `ln.edition.book` mint identical refs), a
   *   collection hanging off a navigation carries that path with its first hop anchored on this
   *   alias, and a collection of the row itself correlates to this alias.
   */
  private createMockEntity(pathAnchor?: string): EntityQuery<TEntity> {
    const schema = this._getSchema();
    const schemaRegistry = this._getSchemaRegistry();
    const mock: any = {};

    // Add all columns as DbColumn-like objects
    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build();
      Object.defineProperty(mock, propName, {
        get: () => ({
          __fieldName: propName,
          __dbColumnName: config.name,
          __isDbColumn: true,
          // Include mapper for toDriver transformation in conditions
          __mapper: config.mapper,
          // Column SQL type — lets flag* emit width-exact mask casts
          __sqlType: config.type,
        }),
        enumerable: true,
      });
    }

    // Add navigation properties (both collections and references)
    for (const [relName, relConfig] of Object.entries(schema.relations)) {
      if (relConfig.type === 'many') {
        Object.defineProperty(mock, relName, {
          get: () => {
            const targetSchema = relConfig.targetTableBuilder?.build();
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              pathAnchor ?? schema.name,
              targetSchema,
              schemaRegistry,  // Pass schema registry for nested navigation
              undefined,
              relConfig.foreignKeys,  // Propagate composite FK / literal predicates
              relConfig.matches
            );
          },
          enumerable: true,
        });
      } else {
        // Single reference navigation (many-to-one, one-to-one)
        Object.defineProperty(mock, relName, {
          get: () => {
            const targetSchema = relConfig.targetTableBuilder?.build();
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,
              schemaRegistry,  // Pass schema registry for nested navigation
              pathAnchor === undefined ? undefined : [],
              pathAnchor  // A source alias makes every hop below record its path
            );
            return refBuilder.createMockTargetRow();
          },
          enumerable: true,
        });
      }
    }

    return mock;
  }

  /**
   * Build RETURNING clause SQL based on config
   * @internal
   */
  private buildReturningClause<TResult>(
    returning: ReturningConfig<EntityQuery<TEntity>, TResult>,
    tableAlias: string | undefined,
    /**
     * The statement's parameters: an `sql` expression's append here (RETURNING ends the statement
     * text). Without it an expression's parameters had nowhere to go.
     */
    paramContext: SqlBuildContext
  ): { sql: string; columns: string[]; read?: ReturningReadPlan } | null {
    if (returning === undefined) {
      return null; // No RETURNING
    }

    const schema = this._getSchema();
    const prefix = tableAlias ? `${tableAlias}.` : '';

    if (returning === true) {
      // Return all columns
      const columns = Object.values(schema.columns).map(col => (col as any).build().name);
      const sql = columns.map(name => `${prefix}"${name}"`).join(', ');
      return { sql, columns };
    }

    // Selector function: the row's own columns, `sql` expressions over them (a column they read
    // renders qualified like a selected one — under MERGE's / bulkUpdate's alias, a bare or
    // table-qualified name is ambiguous or out of scope), literals, or ONE of those
    const { selection, scalar } = returningSelection(returning(this.createMockEntity() as any));
    const rendered = renderPlainReturning(selection, {
      isOwnColumn: ref => this.isMutatedRowColumn(ref),
      columnSql: ref => `${prefix}"${ref.__dbColumnName}"`,
      columnMapper: ref => this.returningColumnMapper(ref),
      context: paramContext,
    });

    return { sql: rendered.sql, columns: rendered.columns, read: { shape: rendered.shape, scalar } };
  }

  /** Whether a RETURNING ref reads the mutated row itself — not a navigation's table. */
  private isMutatedRowColumn(ref: FieldRef): boolean {
    const tableAlias = (ref as any).__tableAlias as string | undefined;

    return !tableAlias || tableAlias === this._getSchema().name || tableAlias === MUTATION_ROW_ALIAS;
  }

  /**
   * The mapper a RETURNING column reads back through: a column of the mutated row its own — or,
   * through a client that drops a numeric(p, s) zero's scale, the one restoring it — and a
   * navigation's column the mapper of the table it belongs to, whichever path reached it.
   */
  private returningColumnMapper(ref: FieldRef): { fromDriver(value: any): any } | undefined {
    const fieldRef = ref as any;

    if (!this.isMutatedRowColumn(ref)) {
      return fieldRef.__mapper;
    }

    const colBuilder = this._getSchema().columns[fieldRef.__fieldName];

    if (!colBuilder) {
      return fieldRef.__mapper;
    }

    const config = (colBuilder as any).build();

    return config.mapper ?? (this._getClient().losesNumericZeroScale() ? numericZeroScaleMapper(config) : undefined);
  }

  /**
   * Map row results applying custom mappers
   * @internal
   * @param rows - Raw database rows
   * @param clause - The RETURNING clause the rows came from: a selector's rows are read through the
   *                 plan its rendering built (never by matching their keys against the table's
   *                 columns); `returning()` rows map as whole entities.
   */
  private mapReturningResults(
    rows: any[],
    clause: { read?: ReturningReadPlan }
  ): any[] {
    return clause.read === undefined
      ? this.mapResultsToEntities(rows)
      : readReturningRows(rows, clause.read, this._getSchemaRegistry());
  }

  /**
   * Detect if a RETURNING selector uses navigation properties
   * Returns navigation info if found, null otherwise
   * @internal
   */
  private detectNavigationInReturning<TResult>(
    returning: true | ((entity: EntityQuery<TEntity>) => TResult)
  ): {
    hasNavigation: boolean;
    selection: any;
    joins: ReturningNavigationJoin[];
    navigationFields: Map<string, ReturningNavigationField>;
    nestedObjects: Map<string, any>;
    collectionFields: Map<string, any>;
  } | null {
    if (returning === true) {
      return null;
    }

    const { selection } = returningSelection(returning(this.createMockEntity(MUTATION_ROW_ALIAS)));

    // Joined under the navigation plan of the selection; buildReturningWithNavigation renders a
    // second evaluation of the same selector under the same (deterministic) plan
    return this.withReturningNavigationPlan(selection, plan => this.resolveReturningNavigation(selection, plan));
  }

  /** The body of {@link detectNavigationInReturning}, run under the selection's navigation plan. */
  private resolveReturningNavigation(
    selection: any,
    plan: NavigationAliasPlan | undefined
  ): {
    hasNavigation: boolean;
    selection: any;
    joins: ReturningNavigationJoin[];
    navigationFields: Map<string, ReturningNavigationField>;
    nestedObjects: Map<string, any>;
    collectionFields: Map<string, any>;
  } | null {
    const schema = this._getSchema();
    const navigationFields = new Map<string, ReturningNavigationField>();
    const allTableAliases = new Set<string>();
    const nestedObjects = new Map<string, any>();
    const collectionFields = new Map<string, any>();
    let expressionReadsNavigation = false;

    // Recursively collect field refs and table aliases from selection
    const collectFieldRefs = (obj: any, path: string = '') => {
      for (const [key, field] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;
        const classified = classifyReturningValue(field, fieldPath);

        if (classified.kind === 'column') {
          // Direct field reference (either main table or navigation)
          const fieldRef = classified.ref as any;
          const tableAlias = fieldRef.__tableAlias as string | undefined;
          // A navigation of the plan collects the aliases of its whole path
          const planned = this.collectPlannedAliases(plan?.nodeOf(fieldRef), allTableAliases);

          if (tableAlias && tableAlias !== schema.name) {
            // Navigation field
            if (!planned) {
              allTableAliases.add(tableAlias);
            }
            navigationFields.set(fieldPath, {
              tableAlias,
              dbColumnName: fieldRef.__dbColumnName,
              schemaTable: fieldRef.__sourceTable,
              mapper: fieldRef.__mapper,
            });
          }
          // Main table field - don't add to navigationFields
          if (!planned && Array.isArray(fieldRef.__navigationAliases)) {
            for (const navAlias of fieldRef.__navigationAliases) {
              if (navAlias && navAlias !== schema.name) {
                allTableAliases.add(navAlias);
              }
            }
          }
        } else if (classified.kind === 'collection' && field instanceof CollectionQueryBuilder) {
          // CollectionQueryBuilder (.toList(), .firstOrDefault())
          collectionFields.set(fieldPath, field);
          // The path the collection hangs off is joined as well: its first hop's foreign key must
          // reach the CTE's RETURNING list, and the correlated form binds to the path's last hop
          if (!this.collectPlannedAliases(this.plannedCollectionNode(plan, field), allTableAliases)) {
            for (const navJoin of field.getNavigationPath()) {
              if (navJoin.alias && navJoin.alias !== schema.name) {
                allTableAliases.add(navJoin.alias);
              }
            }
            // Also add the source table alias (a collection of the row itself correlates to the CTE)
            const sourceAlias = field.getSourceAlias();
            if (sourceAlias && sourceAlias !== schema.name && sourceAlias !== MUTATION_ROW_ALIAS) {
              allTableAliases.add(sourceAlias);
            }
          }
        } else if (classified.kind === 'collection') {
          collectionFields.set(fieldPath, field);
        } else if (classified.kind === 'expression') {
          // An `sql` expression (or condition) reading a navigation renders from the navigation
          // RETURNING's CTE, which joins the navigation like a projected one — the plain RETURNING
          // has no join for it
          for (const ref of classified.fragment.getFieldRefs()) {
            if (this.isMutatedRowColumn(ref)) {
              continue;
            }

            expressionReadsNavigation = true;

            if (!this.collectPlannedAliases(plan?.nodeOf(ref), allTableAliases)) {
              allTableAliases.add((ref as any).__tableAlias);
              for (const navAlias of (ref as any).__navigationAliases ?? []) {
                if (navAlias && navAlias !== schema.name) {
                  allTableAliases.add(navAlias);
                }
              }
            }
          }
        } else if (classified.kind === 'nested') {
          // Nested plain object - recurse into it
          nestedObjects.set(fieldPath, field);
          collectFieldRefs(field, fieldPath);
        }
      }
    };

    collectFieldRefs(selection);

    if (navigationFields.size === 0 && nestedObjects.size === 0 && collectionFields.size === 0 && !expressionReadsNavigation) {
      return null;
    }

    // Resolve navigation joins
    const joins: ReturningNavigationJoin[] = [];
    this.resolveJoinsForTableAliases(allTableAliases, joins, schema, plan);

    return { hasNavigation: true, selection, joins, navigationFields, nestedObjects, collectionFields };
  }

  /**
   * Runs one step of a navigation RETURNING — the detection or the rendering — under the navigation
   * plan of `selection` (see NavigationAliasPlan): every reference-navigation path the selection
   * traverses is joined on its own parent, and the refs of a path that lost its plain alias to
   * another path ending in the same relation name render under a path alias until `build` returns.
   * `build` gets `undefined` when the plan could not change the SQL (every path one hop deep); the
   * step then resolves the joins by name, exactly as before.
   *
   * The plan is a function of the selection's shape, so the detection and the rendering — two
   * evaluations of one selector — get the same aliases.
   */
  private withReturningNavigationPlan<T>(selection: unknown, build: (plan: NavigationAliasPlan | undefined) => T): T {
    const schema = this._getSchema();
    // The mock mints refs without a chain id: every ref of the selection belongs to this build
    const plan = new NavigationAliasPlan(schema, schema.name, this._getSchemaRegistry(), undefined);
    const collectionPaths: string[][] = [];
    this.addSelectionToNavigationPlan(selection, plan, collectionPaths);

    // After every ref: at equal depth, a path a field reads keeps the plain alias
    for (const path of collectionPaths) {
      plan.addPath(path);
    }

    const sealed = plan.seal();
    const restore = sealed?.apply();

    try {
      return build(sealed);
    } finally {
      restore?.();
    }
  }

  /**
   * Records the navigation paths a RETURNING selection traverses — the values the detection and the
   * rendering walk: field refs, nested objects, and the path a collection hangs off (collected into
   * `collectionPaths`). A collection's own selector plans its own paths when it is built.
   */
  private addSelectionToNavigationPlan(value: unknown, plan: NavigationAliasPlan, collectionPaths: string[][]): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }

    if ('__dbColumnName' in value) {
      plan.addRef(value);

      return;
    }

    // An `sql` expression's navigations are joined — and aliased — like projected ones
    if (value instanceof SqlFragment) {
      for (const ref of value.getFieldRefs()) {
        plan.addRef(ref);
      }

      return;
    }

    if (value instanceof CollectionQueryBuilder) {
      const path = value.getNavigationPath();

      if (path.length > 0 && path[0].sourceAlias === MUTATION_ROW_ALIAS) {
        collectionPaths.push(path.map(step => step.alias));
      }

      return;
    }

    for (const field of Object.values(value)) {
      this.addSelectionToNavigationPlan(field, plan, collectionPaths);
    }
  }

  /** The planned hop a collection hangs off, or `undefined` (no plan, or a collection of the row itself). */
  private plannedCollectionNode(plan: NavigationAliasPlan | undefined, collection: CollectionQueryBuilder<any>): NavigationPathNode | undefined {
    const path = collection.getNavigationPath();

    if (plan === undefined || path.length === 0 || path[0].sourceAlias !== MUTATION_ROW_ALIAS) {
      return undefined;
    }

    return plan.nodeForPath(path.map(step => step.alias));
  }

  /**
   * Adds the aliases of a planned hop's path — its own first, then its ancestors' from the root
   * down, the order `__tableAlias` + `__navigationAliases` have always been collected in. False
   * when there is no planned hop, and the caller collects the aliases by name.
   */
  private collectPlannedAliases(node: NavigationPathNode | undefined, allTableAliases: Set<string>): boolean {
    if (node === undefined) {
      return false;
    }

    for (const alias of node.collectOrder) {
      allTableAliases.add(alias);
    }

    return true;
  }

  /**
   * Resolve all navigation joins by finding the correct path through the schema graph
   * @internal
   */
  private resolveJoinsForTableAliases(
    allTableAliases: Set<string>,
    joins: ReturningNavigationJoin[],
    schema: TableSchema,
    plan?: NavigationAliasPlan
  ): void {
    if (allTableAliases.size === 0) {
      return;
    }

    const schemaRegistry = this._getSchemaRegistry();
    const resolved = new Set<string>();
    let maxIterations = allTableAliases.size * 3;

    while (resolved.size < allTableAliases.size && maxIterations-- > 0) {
      const joinedSchemas = new Map<string, TableSchema>();
      joinedSchemas.set(schema.name, schema);

      // Build map of all joined schemas - use schema registry for proper relation resolution
      for (const join of joins) {
        // First try to get from schema registry (has complete relations)
        let joinedSchema = schemaRegistry.get(join.targetTable);
        // Fallback to direct relations lookup
        if (!joinedSchema) {
          const relation = schema.relations[join.alias];
          if (relation?.targetTableBuilder) {
            joinedSchema = relation.targetTableBuilder.build();
          }
        }
        if (joinedSchema) {
          joinedSchemas.set(join.alias, joinedSchema);
        }
      }

      for (const alias of allTableAliases) {
        if (resolved.has(alias) || joins.some(j => j.alias === alias)) {
          resolved.add(alias);
          continue;
        }

        // A path of the navigation plan hangs off its OWN parent, once that is joined — never off
        // whichever joined table happens to have a relation of the same name
        const planned = plan?.nodeForAlias(alias);

        if (planned !== undefined) {
          if (planned.parent === undefined || joinedSchemas.has(planned.parent.alias)) {
            joins.push(plan!.joinOf(planned));
            resolved.add(alias);
          }

          continue;
        }

        for (const [sourceAlias, sourceSchema] of joinedSchemas) {
          if (sourceSchema.relations && sourceSchema.relations[alias]) {
            const relation = sourceSchema.relations[alias];
            if (relation.type === 'one') {
              let targetSchema: TableSchema | undefined;
              let targetSchemaName: string | undefined;

              // Use schema registry for complete schema info
              targetSchema = schemaRegistry.get(relation.targetTable);
              if (!targetSchema && relation.targetTableBuilder) {
                targetSchema = relation.targetTableBuilder.build();
              }
              targetSchemaName = targetSchema?.schema;

              joins.push({
                alias,
                targetTable: relation.targetTable,
                targetSchema: targetSchemaName,
                foreignKeys: relation.foreignKeys || [relation.foreignKey || ''],
                matches: relation.matches || ['id'],
                isMandatory: relation.isMandatory ?? false,
                sourceAlias,
              });
              resolved.add(alias);
              break;
            }
          }
        }
      }
    }
  }

  /**
   * Build RETURNING clause with navigation property support using CTE
   * @internal
   */
  private buildReturningWithNavigation<TResult>(
    mutationSql: string,
    mutationParams: any[],
    returning: true | ((entity: EntityQuery<TEntity>) => TResult),
    navigationInfo: ReturningNavigationRenderInfo,
    /**
     * Composition hooks for `insertWithChildren`: CTEs prepended before
     * "__mutation__" (whose SQL may reference them), extra joins/select parts
     * on the outer statement, extra columns forced into the CTE's RETURNING
     * list, and a deterministic outer ORDER BY on a CTE column.
     */
    options?: ReturningNavigationRenderOptions
  ): { sql: string; params: any[]; nestedPaths?: Set<string>; read: ReturningReadPlan } {
    const { selection, scalar } = returningSelection((returning as Function)(this.createMockEntity(MUTATION_ROW_ALIAS)));

    // The navigation plan detectNavigationInReturning resolved navigationInfo.joins under — the
    // plan is a function of the selection's shape, so this evaluation gets the same aliases
    return this.withReturningNavigationPlan(selection, plan => this.renderReturningWithNavigation(mutationSql, mutationParams, selection, scalar, plan, navigationInfo, options));
  }

  /** The body of {@link buildReturningWithNavigation}, run under the selection's navigation plan. */
  private renderReturningWithNavigation(
    mutationSql: string,
    mutationParams: any[],
    selection: any,
    scalar: boolean,
    plan: NavigationAliasPlan | undefined,
    navigationInfo: ReturningNavigationRenderInfo,
    options: ReturningNavigationRenderOptions | undefined
  ): { sql: string; params: any[]; nestedPaths?: Set<string>; read: ReturningReadPlan } {
    const schema = this._getSchema();
    const schemaRegistry = this._getSchemaRegistry();
    const mainTableColumns = new Set<string>();
    const selectParts: string[] = [];
    const nestedPaths = new Set<string>();

    // Helper to get FK db column name from a schema
    const getFkDbColumnName = (sourceSchema: TableSchema, fkPropName: string): string => {
      const colEntry = Object.entries(sourceSchema.columns).find(([propName, _]) => propName === fkPropName);
      if (colEntry) {
        const config = (colEntry[1] as any).build();
        return config.name;
      }
      return fkPropName; // Fallback to property name
    };

    // Build a map of alias -> source table name for FK lookups
    const aliasToSourceTable = new Map<string, string>();
    aliasToSourceTable.set(schema.name, schema.name);
    for (const join of navigationInfo.joins) {
      aliasToSourceTable.set(join.alias, join.targetTable);
    }

    // Track collection subqueries for LATERAL JOINs
    const collectionSubqueries: Array<{
      fieldPath: string;
      lateralAlias: string;
      joinClause: string;
      selectExpression: string;
    }> = [];
    let lateralCounter = 0;
    // Track all params including those from collection subqueries
    const allParams = [...mutationParams];
    let currentParamCounter = mutationParams.length + 1;

    // Build a QueryContext for collection subquery building
    const buildCollectionContext = (): QueryContext => ({
      ctes: new Map(),
      cteCounter: lateralCounter,
      paramCounter: currentParamCounter,
      allParams: allParams,
      collectionStrategy: 'lateral',
    });

    // A column of the mutated row reads off the CTE, which returns it
    const mutationColumnSql = (ref: FieldRef): string => {
      mainTableColumns.add(ref.__dbColumnName);

      return `"__mutation__"."${ref.__dbColumnName}"`;
    };

    // Recursively process selection to build SELECT parts — and the shape the rows are read by
    const processSelection = (obj: any, path: string = ''): ReturningShape => {
      const shape: ReturningShape = [];

      for (const [key, field] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;
        const classified = classifyReturningValue(field, fieldPath);

        if (classified.kind === 'constant') {
          // A literal reads back as it is — it used to be dropped from the row
          shape.push({ key, read: { kind: 'constant', value: classified.value } });
        } else if (classified.kind === 'expression') {
          // Columns of the mutated row read off the CTE; a navigation's, off its join
          const context: SqlBuildContext = { paramCounter: currentParamCounter, params: allParams };
          const expressionSql = renderReturningExpression(classified.fragment, context, ref => this.isMutatedRowColumn(ref), mutationColumnSql);
          currentParamCounter = context.paramCounter;
          selectParts.push(`${expressionSql} AS "${fieldPath}"`);
          shape.push({ key, read: { kind: 'value', column: fieldPath, mapper: fragmentReadMapper(classified.fragment) } });
        } else if (classified.kind === 'column') {
          // Direct field reference
          const tableAlias = (field as any).__tableAlias as string;
          const dbColumnName = (field as any).__dbColumnName as string;

          if (this.isMutatedRowColumn(classified.ref)) {
            selectParts.push(`${mutationColumnSql(classified.ref)} AS "${fieldPath}"`);
          } else {
            selectParts.push(`"${tableAlias}"."${dbColumnName}" AS "${fieldPath}"`);
          }

          shape.push({ key, read: { kind: 'value', column: fieldPath, mapper: this.returningColumnMapper(classified.ref) } });
        } else if (classified.kind === 'collection') {
          // CollectionQueryBuilder (.toList(), .firstOrDefault())
          // Build a correlated subquery that references joined tables from the main query. The
          // mock anchors it on the CTE: a collection of the row correlates to "__mutation__", and
          // one hanging off a navigation carries its path from "__mutation__" — so its SQL is used
          // as built (table names in it are its own subqueries' tables, never the outer joins)
          const collectionBuilder = field as CollectionQueryBuilder<any>;
          const context = buildCollectionContext();
          // When the plan renders the last hop of the path the collection hangs off under a path
          // alias (another path owns the relation name), the correlated form must join that path
          // itself instead of binding to the join of that name — the other path's row
          const joinOwnPath = field instanceof CollectionQueryBuilder
            && CollectionQueryBuilder.pathRenamedIn(field, plan, MUTATION_ROW_ALIAS);

          // Build the CTE/subquery using lateral strategy
          const cteResult = collectionBuilder.buildCTE(context, undefined, undefined, joinOwnPath);
          lateralCounter = context.cteCounter;
          currentParamCounter = context.paramCounter; // Track new param index after collection subquery

          // The mapping reads what the build learned about the collection (a collection selecting
          // ONE value unwraps its items) off the builder that was built
          if (collectionBuilder instanceof CollectionQueryBuilder) {
            navigationInfo.collectionFields?.set(fieldPath, collectionBuilder);
          }

          // The lateral strategy returns either:
          // 1. A correlated subquery in selectExpression (no join needed)
          // 2. A LATERAL JOIN with joinClause and selectExpression
          if (cteResult.joinClause && cteResult.joinClause.trim()) {
            collectionSubqueries.push({
              fieldPath,
              lateralAlias: cteResult.tableName || `lateral_${lateralCounter - 1}`,
              joinClause: cteResult.joinClause,
              selectExpression: cteResult.selectExpression || `"${cteResult.tableName}".data`,
            });
            selectParts.push(`${cteResult.selectExpression || `"${cteResult.tableName}".data`} AS "${fieldPath}"`);
          } else if (cteResult.selectExpression) {
            // Correlated subquery in SELECT
            selectParts.push(`${cteResult.selectExpression} AS "${fieldPath}"`);
          }

          // Its items read through their columns' mappers, as a SELECT reads them
          shape.push({ key, read: { kind: 'collection', column: fieldPath, collection: collectionBuilder } });
        } else if (classified.kind === 'nested') {
          // Nested plain object - recurse into it and mark as nested path
          nestedPaths.add(fieldPath);
          shape.push({ key, read: { kind: 'nested', shape: processSelection(field, fieldPath) } });
        }
      }

      return shape;
    };

    const shape = processSelection(selection);

    if (selectParts.length === 0 && !options?.extraSelects?.length) {
      // Only literals: the statement still yields one row per mutated row
      selectParts.push(`NULL AS "${RETURNING_PLACEHOLDER_COLUMN}"`);
    }

    // Include foreign keys needed for joins - only for joins from main table
    for (const join of navigationInfo.joins) {
      // Only add FK to mainTableColumns if the join source is the main table
      if (join.sourceAlias === schema.name || !join.sourceAlias) {
        for (const fk of join.foreignKeys) {
          const fkDbCol = getFkDbColumnName(schema, fk);
          mainTableColumns.add(fkDbCol);
        }
      }
    }

    // Include 'id' column if there are collection subqueries (needed for correlation)
    if (collectionSubqueries.length > 0 || (navigationInfo.collectionFields && navigationInfo.collectionFields.size > 0)) {
      // Find the 'id' column db name
      const idColEntry = Object.entries(schema.columns).find(([propName, _]) => propName === 'id');
      if (idColEntry) {
        const idDbCol = (idColEntry[1] as any).build().name;
        mainTableColumns.add(idDbCol);
      } else {
        // Fallback to 'id' if not found in schema
        mainTableColumns.add('id');
      }
    }

    // Columns the caller reads off the CTE itself (insertWithChildren orders by the child key,
    // which the selector need not project)
    for (const col of options?.extraCteReturningCols ?? []) {
      mainTableColumns.add(col);
    }

    const qualifier = options?.returningQualifier ? `${options.returningQualifier}.` : '';
    // A data-modifying CTE the outer SELECT reads needs a RETURNING list even when the selection
    // reads no column of the row (only literals)
    const cteReturningCols = mainTableColumns.size > 0
      ? Array.from(mainTableColumns).map(col => `${qualifier}"${col}"`).join(', ')
      : `NULL AS "${RETURNING_PLACEHOLDER_COLUMN}"`;
    const mutationWithReturning = `${mutationSql} RETURNING ${cteReturningCols}`;

    // Build JOINs
    const joinClauses: string[] = [];
    for (const join of navigationInfo.joins) {
      let qualifiedJoinTable = `"${join.targetTable}"`;
      if (join.targetSchema) {
        qualifiedJoinTable = `"${join.targetSchema}"."${join.targetTable}"`;
      }
      // A FROM item standing in for the table (see insertedRowsUnionTable)
      const tableOverride = options?.joinTableOverrides?.get(join.targetTable);
      if (tableOverride) {
        qualifiedJoinTable = tableOverride;
      }

      const joinConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i] || 'id';

        if (join.sourceAlias === schema.name || !join.sourceAlias) {
          // FK is on main table - look up db column name from main schema
          const fkDbCol = getFkDbColumnName(schema, fk);
          joinConditions.push(`"__mutation__"."${fkDbCol}" = "${join.alias}"."${match}"`);
        } else {
          // FK is on an intermediate joined table - look up from its schema
          const sourceTableName = aliasToSourceTable.get(join.sourceAlias);
          const sourceSchema = sourceTableName ? schemaRegistry.get(sourceTableName) : undefined;
          const fkDbCol = sourceSchema ? getFkDbColumnName(sourceSchema, fk) : fk;
          joinConditions.push(`"${join.sourceAlias}"."${fkDbCol}" = "${join.alias}"."${match}"`);
        }
      }

      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      joinClauses.push(`${joinType} ${qualifiedJoinTable} AS "${join.alias}" ON ${joinConditions.join(' AND ')}`);
    }

    // Add LATERAL JOINs for collections
    for (const collection of collectionSubqueries) {
      joinClauses.push(collection.joinClause);
    }

    const prefixCtes = options?.prefixCtes ? `${options.prefixCtes},\n` : '';
    const extraJoins = options?.extraJoins?.length ? `${options.extraJoins.join('\n')}\n` : '';
    const extraSelects = options?.extraSelects?.length ? `, ${options.extraSelects.join(', ')}` : '';
    const orderBy = options?.orderByCteColumn ? `\nORDER BY "__mutation__"."${options.orderByCteColumn}"` : '';

    const sql = `WITH ${prefixCtes}"__mutation__" AS (
  ${mutationWithReturning}
)
SELECT ${selectParts.join(', ')}${extraSelects}
FROM "__mutation__"
${extraJoins}${joinClauses.join('\n')}${orderBy}`;

    return { sql, params: allParams, nestedPaths, read: { shape, scalar } };
  }

  /**
   * Map RETURNING results with navigation properties, through the read plan the rendering built:
   * a column through the mapper of the table it belongs to (whichever path reached it), an `sql`
   * expression through its own, a collection's items as a SELECT reads them, nested objects field
   * by field. Rows used to be mapped by their KEYS — an aliased column of the row lost its mapper,
   * and a value under a column's name got that column's.
   * @internal
   */
  private readReturning(rows: any[], read: ReturningReadPlan): any[] {
    return readReturningRows(rows, read, this._getSchemaRegistry());
  }

  // Note: findById not yet implemented on TableAccessor
}

/**
 * Read-only access to a model-managed VIEW (`model.view()`, exposed with the
 * context's `view()`): the query surface of {@link DbEntityTable} without its
 * writes. `update()` / `delete()` on a query over a view also throw at run
 * time — a single-table view is auto-updatable in PostgreSQL.
 */
export type DbViewTable<TEntity extends DbEntity> = Pick<
  DbEntityTable<TEntity>,
  | 'toList' | 'first' | 'firstOrDefault' | 'count' | 'exists'
  | 'orderBy' | 'limit' | 'offset' | 'select' | 'selectDistinct' | 'where'
  | 'with' | 'leftJoin' | 'innerJoin' | 'getColumns' | 'getColumnKeys' | 'props'
>;

/**
 * Base database context with entity-first approach
 */
export abstract class DatabaseContext extends DataContext {
  private modelConfig!: DbModelConfig;
  private entityTables = new Map<EntityConstructor<any>, DbEntityTable<any>>();
  private sequenceRegistry = new Map<string, SequenceConfig>();
  private sequenceInstances = new Map<string, DbSequence>();
  private searchNormalizeRequired = false;

  constructor(client: DatabaseClient, queryOptions?: QueryOptions) {
    // Initialize model config
    const modelConfig = new DbModelConfig();

    // Get the actual derived class's setupModel
    const derivedPrototype = new.target.prototype;
    if (derivedPrototype.setupModel) {
      derivedPrototype.setupModel.call({ setupModel: derivedPrototype.setupModel }, modelConfig);
    }

    // Build schema from model
    const schema: any = {};
    const tables = modelConfig.buildTables();
    for (const [tableName, tableBuilder] of tables) {
      schema[tableName] = tableBuilder;
    }

    // Call parent with built schema
    super(client, schema, queryOptions);

    this.modelConfig = modelConfig;
    this.searchNormalizeRequired = modelConfig.isSearchNormalizeRequired();

    // Setup sequences after construction (call setupSequences if it exists)
    if (derivedPrototype.setupSequences) {
      derivedPrototype.setupSequences.call(this);
    }
  }

  /**
   * Override this method to configure your entities
   */
  protected abstract setupModel(modelConfig: DbModelConfig): void;

  /**
   * Optional: Override this method to register sequences.
   * This is called during construction to ensure sequences are registered before schema creation.
   *
   * @example
   * ```typescript
   * protected setupSequences(): void {
   *   // Access sequence getters to register them
   *   this.mySeq;
   *   this.anotherSeq;
   * }
   * ```
   */
  protected setupSequences?(): void;

  /**
   * Hook called before any database migrations/schema changes are applied.
   * Override this method to execute custom SQL scripts that must run first —
   * before the ORM analyzes or modifies the schema, and before any file-based
   * migrations run.
   *
   * Fires at the start of `getSchemaManager().migrate()` / `ensureCreated()`,
   * and (via `MigrationRunner.up()`) before file migrations on an existing
   * database. On a fresh database, the runner triggers auto-migration, so this
   * still runs first there too.
   *
   * @example
   * ```typescript
   * protected async onMigrationStart(client: DatabaseClient): Promise<void> {
   *   // Ensure a required extension exists before any tables are created
   *   await client.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
   * }
   * ```
   *
   * @param client - Database client for executing custom SQL
   */
  protected async onMigrationStart(client: DatabaseClient): Promise<void> {
    // Default implementation does nothing
    // Override in derived class to execute custom scripts before migrations run
  }

  /**
   * Hook called after database migrations/schema creation are complete.
   * Override this method to execute custom SQL scripts that are outside the scope of the ORM.
   *
   * @example
   * ```typescript
   * protected async onMigrationComplete(client: DatabaseClient): Promise<void> {
   *   // Create custom functions, views, triggers, etc.
   *   await client.query(`
   *     CREATE OR REPLACE FUNCTION custom_function()
   *     RETURNS void AS $$
   *     BEGIN
   *       -- Custom logic here
   *     END;
   *     $$ LANGUAGE plpgsql;
   *   `);
   * }
   * ```
   *
   * @param client - Database client for executing custom SQL
   */
  protected async onMigrationComplete(client: DatabaseClient): Promise<void> {
    // Default implementation does nothing
    // Override in derived class to execute custom scripts
  }

  /**
   * Register a sequence in the schema
   * @param config - Sequence configuration
   */
  protected registerSequence(config: SequenceConfig): void {
    const key = config.schema ? `${config.schema}.${config.name}` : config.name;
    this.sequenceRegistry.set(key, config);
  }

  /**
   * Get a sequence instance for interacting with the database
   * @param config - Sequence configuration
   * @returns DbSequence instance with nextValue() and resync() methods
   */
  protected sequence(config: SequenceConfig): DbSequence {
    const key = config.schema ? `${config.schema}.${config.name}` : config.name;

    // Register if not already registered
    if (!this.sequenceRegistry.has(key)) {
      this.sequenceRegistry.set(key, config);
    }

    // Return cached instance or create new one
    let instance = this.sequenceInstances.get(key);
    if (!instance) {
      instance = new DbSequence(this.client, config);
      this.sequenceInstances.set(key, instance);
    }
    return instance;
  }

  /**
   * Get all registered sequences
   * @internal
   */
  getSequenceRegistry(): Map<string, SequenceConfig> {
    return this.sequenceRegistry;
  }

  /**
   * Get schema manager for create/drop operations with post-migration hook support
   */
  override getSchemaManager(options?: { concurrentIndexes?: boolean; recreateChangedIndexes?: boolean }): DbSchemaManager {
    const { tables, views } = splitViewsFromRegistry((this as any).schemaRegistry, schema => renderViewDefinition(schema, this));
    return new DbSchemaManager(
      this.client,
      tables,
      {
        logQueries: (this as any).queryOptions?.logQueries,
        logger: (this as any).queryOptions?.logger,
        preMigrationHook: async (client: DatabaseClient) => {
          await this.onMigrationStart(client);
        },
        postMigrationHook: async (client: DatabaseClient) => {
          await this.onMigrationComplete(client);
        },
        sequenceRegistry: this.sequenceRegistry,
        searchNormalizeRequired: this.searchNormalizeRequired,
        databaseSettings: this.modelConfig.getDatabaseSettings(),
        concurrentIndexes: options?.concurrentIndexes,
        recreateChangedIndexes: options?.recreateChangedIndexes,
        views,
      }
    );
  }

  /**
   * Get strongly-typed table accessor for an entity
   * @internal - Use property accessors on derived class instead
   */
  protected table<TEntity extends DbEntity>(
    entityClass: EntityConstructor<TEntity>
  ): DbEntityTable<TEntity> {
    let table = this.entityTables.get(entityClass);
    if (!table) {
      const metadata = EntityMetadataStore.getMetadata(entityClass);
      if (!metadata) {
        throw new Error(`No metadata found for entity ${entityClass.name}`);
      }
      // EntityTable doesn't need the tableBuilder, it just uses getTable() internally
      table = new DbEntityTable<TEntity>(this, metadata.tableName, null as any);
      this.entityTables.set(entityClass, table);
    }
    return table as DbEntityTable<TEntity>;
  }

  /**
   * Read-only accessor for a model-managed VIEW declared with `model.view()`.
   * @internal - Use property accessors on derived class instead
   */
  protected view<TView extends DbEntity>(viewClass: EntityConstructor<TView>): DbViewTable<TView> {
    if (EntityMetadataStore.getMetadata(viewClass)?.view == null) {
      throw new Error(`${viewClass.name} is not a view — declare it with model.view(), or expose a table with table()`);
    }
    return this.table(viewClass);
  }
}
