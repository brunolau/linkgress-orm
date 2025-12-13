import { DatabaseClient, QueryResult } from '../database/database-client.interface';
import { TableBuilder, TableSchema, InferTableType } from '../schema/table-builder';
import { UnwrapDbColumns, InsertData, ExtractDbColumns } from './db-column';
import { DbEntity, EntityConstructor, EntityMetadataStore } from './entity-base';
import { DbModelConfig } from './model-config';
import { JoinQueryBuilder } from '../query/join-builder';
import { Condition, ConditionBuilder, SqlFragment, UnwrapSelection, FieldRef } from '../query/conditions';
import { ResolveCollectionResults, CollectionQueryBuilder, ReferenceQueryBuilder, SelectQueryBuilder, QueryBuilder } from '../query/query-builder';
import { InferRowType } from '../schema/row-type';
import { DbSchemaManager } from '../migration/db-schema-manager';
import { DbSequence, SequenceConfig } from '../schema/sequence-builder';
import type { DbCte } from '../query/cte-builder';
import type { Subquery } from '../query/subquery';
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
 * Collection aggregation strategy type
 */
export type CollectionStrategyType = 'cte' | 'temptable' | 'lateral';

/**
 * Order direction for orderBy clauses
 */
export type OrderDirection = 'ASC' | 'DESC';

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
 * Query execution options
 */
export interface QueryOptions {
  /** Enable SQL query logging */
  logQueries?: boolean;
  /** Custom logger function (defaults to console.log) */
  logger?: (message: string) => void;
  /** Log query execution time */
  logExecutionTime?: boolean;
  /** Log query parameters */
  logParameters?: boolean;
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

  constructor(private enabled: boolean, private logger?: (message: string) => void) {
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
    const log = this.logger || console.log;

    log('\n[Time Trace Summary]');
    log(`  Total: ${trace.totalMs.toFixed(2)}ms`);
    if (trace.phases.queryBuild !== undefined) {
      log(`  Query Build: ${trace.phases.queryBuild.toFixed(2)}ms`);
    }
    if (trace.phases.queryExecution !== undefined) {
      log(`  Query Execution: ${trace.phases.queryExecution.toFixed(2)}ms`);
    }
    if (trace.phases.resultProcessing !== undefined) {
      log(`  Result Processing: ${trace.phases.resultProcessing.toFixed(2)}ms`);
    }
    if (rowCount !== undefined) {
      log(`  Rows: ${rowCount}`);
    }

    // Log detailed entries if there are any significant operations
    const significantEntries = this.entries.filter(e => e.durationMs > 0.1);
    if (significantEntries.length > 0) {
      log('\n[Detailed Trace]');
      for (const entry of significantEntries) {
        const details = entry.details ? ` (${JSON.stringify(entry.details)})` : '';
        log(`  [${entry.phase}] ${entry.operation}: ${entry.durationMs.toFixed(2)}ms${details}`);
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
    private options: QueryOptions = {}
  ) {}

  async query(sql: string, params?: any[]): Promise<QueryResult> {
    const logger = this.options.logger || console.log;
    const startTime = this.options.logExecutionTime ? performance.now() : 0;

    if (this.options.logQueries) {
      logger(`\n[SQL Query]`);
      logger(sql.trim());

      if (this.options.logParameters && params && params.length > 0) {
        logger(`[Parameters] ${JSON.stringify(params)}`);
      }
    }

    try {
      // Pass binary protocol option if enabled
      const queryOptions = this.options.useBinaryProtocol
        ? { useBinaryProtocol: true }
        : undefined;

      const result = await this.client.query(sql, params, queryOptions);

      if (this.options.logExecutionTime) {
        const duration = (performance.now() - startTime).toFixed(2);
        logger(`[Execution Time] ${duration}ms`);
      }

      return result;
    } catch (error) {
      if (this.options.logQueries) {
        logger(`[SQL Error] ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  /**
   * Execute a multi-statement query using the simple protocol (no parameters)
   * Only available for clients that support it (e.g., PostgresClient)
   */
  async querySimple(sql: string): Promise<QueryResult> {
    const logger = this.options.logger || console.log;
    const startTime = this.options.logExecutionTime ? performance.now() : 0;

    if (this.options.logQueries) {
      logger(`\n[SQL Query - Multi-Statement]`);
      logger(sql.trim());
    }

    try {
      // Check if client has querySimple method
      if ('querySimple' in this.client && typeof (this.client as any).querySimple === 'function') {
        const result = await (this.client as any).querySimple(sql);

        if (this.options.logExecutionTime) {
          const duration = (performance.now() - startTime).toFixed(2);
          logger(`[Execution Time] ${duration}ms`);
        }

        return result;
      } else {
        // Fallback to regular query
        const result = await this.client.query(sql, []);

        if (this.options.logExecutionTime) {
          const duration = (performance.now() - startTime).toFixed(2);
          logger(`[Execution Time] ${duration}ms`);
        }

        return result;
      }
    } catch (error) {
      if (this.options.logQueries) {
        logger(`[SQL Error] ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  /**
   * Execute a multi-statement query and return ALL result sets
   * Only available for PostgresClient
   */
  async querySimpleMulti(sql: string): Promise<QueryResult[]> {
    const logger = this.options.logger || console.log;
    const startTime = this.options.logExecutionTime ? performance.now() : 0;

    if (this.options.logQueries) {
      logger(`\n[SQL Query - Fully Optimized Multi-Statement]`);
      logger(sql.trim());
    }

    try {
      // Check if client has querySimpleMulti method
      if ('querySimpleMulti' in this.client && typeof (this.client as any).querySimpleMulti === 'function') {
        const results = await (this.client as any).querySimpleMulti(sql);

        if (this.options.logExecutionTime) {
          const duration = (performance.now() - startTime).toFixed(2);
          logger(`[Execution Time] ${duration}ms`);
        }

        return results;
      } else {
        throw new Error('querySimpleMulti not supported by this client');
      }
    } catch (error) {
      if (this.options.logQueries) {
        logger(`[SQL Error] ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
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
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<UnwrapDbColumns<TResult>>;
}

/**
 * Fluent insert many operation
 */
export interface FluentInsertMany<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the inserted rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the inserted rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<UnwrapDbColumns<TResult>[]>;
}

/**
 * Fluent update operation
 */
export interface FluentUpdate<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the updated rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the updated rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<UnwrapDbColumns<TResult>[]>;
}

/**
 * Fluent bulk update operation
 */
export interface FluentBulkUpdate<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the updated rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the updated rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<UnwrapDbColumns<TResult>[]>;
}

/**
 * Fluent upsert operation
 */
export interface FluentUpsert<TEntity extends DbEntity> extends PromiseLike<void> {
  /** Return all columns from the upserted rows */
  returning(): PromiseLike<UnwrapDbColumns<TEntity>[]>;
  /** Return selected columns from the upserted rows */
  returning<TResult>(selector: (entity: EntityQuery<TEntity>) => TResult): PromiseLike<UnwrapDbColumns<TResult>[]>;
}

/**
 * Fluent delete operation for SelectQueryBuilder
 * Used with db.table.where(...).delete()
 */
export interface FluentDelete<TSelection> extends PromiseLike<void> {
  /** Return all columns from the deleted rows */
  returning(): PromiseLike<TSelection[]>;
  /** Return selected columns from the deleted rows */
  returning<TResult>(selector: (row: TSelection) => TResult): PromiseLike<TResult[]>;
}

/**
 * Fluent update operation for SelectQueryBuilder
 * Used with db.table.where(...).update(data)
 */
export interface FluentQueryUpdate<TSelection> extends PromiseLike<void> {
  /** Return all columns from the updated rows */
  returning(): PromiseLike<TSelection[]>;
  /** Return selected columns from the updated rows */
  returning<TResult>(selector: (row: TSelection) => TResult): PromiseLike<TResult[]>;
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
   * Update on conflict (upsert)
   */
  doUpdate(options?: {
    set?: Partial<InferTableType<TSchema>>;
    where?: string;
    updateColumns?: string[];
    updateColumnFilter?: (columnName: string) => boolean;
  }): this {
    this.conflictAction = 'update';
    if (options?.set) {
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
    let paramIndex = 1;

    // Build placeholders for each row
    for (const data of this.dataArray) {
      const rowPlaceholders: string[] = [];
      for (const key of columns) {
        const value = (data as any)[key];
        const column = this.schema.columns[key as string];
        const config = column.build();
        // Apply toDriver mapper if present
        const mappedValue = config.mapper
          ? config.mapper.toDriver(value !== undefined ? value : null)
          : (value !== undefined ? value : null);
        values.push(mappedValue);
        rowPlaceholders.push(`$${paramIndex++}`);
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
          const config = column.build();
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
    if (options.logQueries || options.logExecutionTime) {
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
    rightTable: { _getSchema: () => TableSchema } | import('../query/subquery').Subquery<TRight, 'table'>,
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
    rightTable: { _getSchema: () => TableSchema } | import('../query/subquery').Subquery<TRight, 'table'>,
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
    let paramIndex = 1;

    for (const [key, value] of Object.entries(data)) {
      const column = this.schema.columns[key];
      if (column) {
        const config = column.build();
        if (!config.autoIncrement) {
          columns.push(`"${config.name}"`);
          // Apply toDriver mapper if present
          const mappedValue = config.mapper
            ? config.mapper.toDriver(value)
            : value;
          values.push(mappedValue);
          placeholders.push(`$${paramIndex++}`);
        }
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
      VALUES ${valueClauses.join(', ')}
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
   * Bulk insert multiple rows (simple version, kept for compatibility)
   */
  async insertMany(dataArray: Partial<InferTableType<TableSchema>>[]): Promise<InferTableType<TableSchema>[]> {
    if (dataArray.length === 0) {
      return [];
    }

    // Extract all unique column names from all data objects
    const columnSet = new Set<string>();
    for (const data of dataArray) {
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
    let paramIndex = 1;

    // Build placeholders for each row
    for (const data of dataArray) {
      const rowPlaceholders: string[] = [];
      for (const key of columns) {
        const value = (data as any)[key];
        const column = this.schema.columns[key as string];
        const config = column.build();
        // Apply toDriver mapper if present
        const mappedValue = config.mapper
          ? config.mapper.toDriver(value !== undefined ? value : null)
          : (value !== undefined ? value : null);
        values.push(mappedValue);
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const columnNames = columns.map(key => {
      const column = this.schema.columns[key as string];
      const config = column.build();
      return `"${config.name}"`;
    });

    const returningColumns = Object.entries(this.schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = getQualifiedTableName(this.schema);
    const sql = `
      INSERT INTO ${qualifiedTableName} (${columnNames.join(', ')})
      VALUES ${valuePlaceholders.join(', ')}
      RETURNING ${returningColumns}
    `;

    const result = this.executor
      ? await this.executor.query(sql, values)
      : await this.client.query(sql, values);
    return result.rows as InferTableType<TableSchema>[];
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
    let paramIndex = 1;

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
          setClauses.push(`"${config.name}" = $${paramIndex++}`);
          // Apply toDriver mapper if present
          const mappedValue = config.mapper
            ? config.mapper.toDriver(value)
            : value;
          values.push(mappedValue);
        }
      }
    }

    if (setClauses.length === 0) {
      return null;
    }

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
 * DataContext - main entry point for database operations
 */
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
    if (queryOptions?.logQueries || queryOptions?.logExecutionTime) {
      this.executor = new QueryExecutor(client, queryOptions);
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
   */
  getTable<K extends keyof TSchema>(name: K): InferContextSchema<TSchema>[K] {
    const accessor = this.tableAccessors.get(name as string);
    if (!accessor) {
      throw new Error(`Table ${String(name)} not found in schema`);
    }
    return accessor as any;
  }

  /**
   * Execute raw SQL query with optional type parameter for results
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
   * ```
   */
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Execute in transaction
   */
  async transaction<TResult>(
    fn: (ctx: this) => Promise<TResult>
  ): Promise<TResult> {
    const connection = await this.client.connect();

    try {
      await connection.query('BEGIN');
      const result = await fn(this);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Get schema manager for create/drop operations and automatic migrations
   */
  getSchemaManager(): DbSchemaManager {
    return new DbSchemaManager(this.client, this.schemaRegistry, { logQueries: this.queryOptions?.logQueries });
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

  // Flattened list results (for single-column selections)
  toNumberList(asName?: string): number[];
  toStringList(asName?: string): string[];

  // Standard list result
  toList(asName: string): TEntity[];
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

  // Flattened list results (for single-column selections)
  toNumberList(asName?: string): number[];
  toStringList(asName?: string): string[];

  // Standard list result
  toList(asName: string): TSelection[];
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
   * Add a WHERE condition. Multiple where() calls are chained with AND logic.
   */
  where(condition: (entity: EntityQuery<TEntity>) => Condition): IEntityQueryable<TEntity>;

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
   * Delete records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   */
  delete(): FluentDelete<UnwrapDbColumns<TEntity>>;

  /**
   * Update records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   */
  update(data: Partial<InsertData<TEntity>>): FluentQueryUpdate<UnwrapDbColumns<TEntity>>;
}

/**
 * Strongly-typed query builder for entities
 * Results automatically unwrap DbColumn<T> to T and SqlFragment<T> to T
 */
export interface EntitySelectQueryBuilder<TEntity extends DbEntity, TSelection> {
  select<TNewSelection>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;

  selectDistinct<TNewSelection>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, UnwrapSelection<TNewSelection>>;

  where(
    condition: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : ToFieldRefs<TSelection>) => Condition
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  orderBy<T>(selector: (row: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => T): EntitySelectQueryBuilder<TEntity, TSelection>;
  orderBy<T>(selector: (row: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => T[]): EntitySelectQueryBuilder<TEntity, TSelection>;
  orderBy<T>(selector: (row: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => Array<[T, OrderDirection]>): EntitySelectQueryBuilder<TEntity, TSelection>;

  limit(count: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  offset(count: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  count(): Promise<number>;

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

  // Subquery conversion
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(mode?: TMode): import('../query/subquery').Subquery<
    TMode extends 'scalar' ? UnwrapDbColumns<TSelection> : TMode extends 'array' ? UnwrapDbColumns<TSelection>[] : UnwrapDbColumns<TSelection>,
    TMode
  >;

  // CTE support
  with(...ctes: import('../query/cte-builder').DbCte<any>[]): this;

  // Mutation methods (available after where())
  update(data: Partial<InsertData<TEntity>>): FluentQueryUpdate<TSelection>;
  delete(): FluentDelete<TSelection>;

  toList(): Promise<ResolveCollectionResults<TSelection>[]>;

  first(): Promise<ResolveCollectionResults<TSelection>>;

  firstOrDefault(): Promise<ResolveCollectionResults<TSelection> | null>;
}

/**
 * DbEntity insert builder for upsert operations with proper typing
 */
export class EntityInsertBuilder<TEntity extends DbEntity> {
  constructor(private builder: InsertBuilder<TableSchema>) {}

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
   * Update on conflict (upsert)
   */
  doUpdate(options?: { set?: InsertData<TEntity>; where?: string }): this {
    this.builder.doUpdate(options as any);
    return this;
  }

  /**
   * Execute the insert/upsert
   */
  async execute(): Promise<UnwrapDbColumns<TEntity>[]> {
    return this.builder.execute() as Promise<UnwrapDbColumns<TEntity>[]>;
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
    if (mergedOptions.logQueries || mergedOptions.logExecutionTime) {
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
   * Order by field(s)
   */
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => T): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => T[]): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => Array<[T, OrderDirection]>): IEntityQueryable<TEntity>;
  orderBy<T>(selector: (row: EntityQuery<TEntity>) => OrderByResult<T>): IEntityQueryable<TEntity> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.orderBy(selector) as IEntityQueryable<TEntity>;
  }

  /**
   * Limit results
   */
  limit(count: number): IEntityQueryable<TEntity> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.limit(count) as IEntityQueryable<TEntity>;
  }

  /**
   * Offset results
   */
  offset(count: number): IEntityQueryable<TEntity> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.offset(count) as IEntityQueryable<TEntity>;
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
   */
  selectDistinct<TSelection>(
    selector: (entity: EntityQuery<TEntity>) => TSelection
  ): EntitySelectQueryBuilder<TEntity, TSelection> {
    const queryBuilder = this.context.getTable(this.tableName);
    // First select, then call selectDistinct to get a new builder with isDistinct=true
    const selectBuilder = queryBuilder.select(selector as any);
    const distinctBuilder = selectBuilder.selectDistinct((x: any) => x);
    return distinctBuilder as any as EntitySelectQueryBuilder<TEntity, TSelection>;
  }

  /**
   * Where query - returns all columns by default
   */
  where(
    condition: (entity: EntityQuery<TEntity>) => Condition
  ): IEntityQueryable<TEntity> {
    const schema = this._getSchema();

    // Create a selector that selects all columns with navigation property access
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      // Copy all column properties
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      // Add navigation properties as enumerable getters
      // The getter returns the actual navigation builder (CollectionQueryBuilder/ReferenceQueryBuilder)
      // which allows chained selectors like .select(u => ({ posts: u.posts!.where(...) }))
      // When the selection is analyzed, the builder is detected and handled appropriately
      for (const relName of Object.keys(schema.relations)) {
        Object.defineProperty(result, relName, {
          get: () => e[relName],
          enumerable: true,  // Enumerable so it's included in Object.entries
          configurable: true,
        });
      }
      return result;
    };

    const queryBuilder = this.context.getTable(this.tableName)
      .where(condition as any)
      .select(allColumnsSelector);
    return queryBuilder as any as IEntityQueryable<TEntity>;
  }

  /**
   * Add CTEs (Common Table Expressions) to the query
   */
  with(...ctes: DbCte<any>[]): IEntityQueryable<TEntity> {
    const schema = this._getSchema();

    // Create a selector that selects all columns with navigation property access
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      // Copy all column properties
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      // Add navigation properties as enumerable getters
      // The getter returns the actual navigation builder (CollectionQueryBuilder/ReferenceQueryBuilder)
      // which allows chained selectors like .select(u => ({ posts: u.posts!.where(...) }))
      // When the selection is analyzed, the builder is detected and handled appropriately
      for (const relName of Object.keys(schema.relations)) {
        Object.defineProperty(result, relName, {
          get: () => e[relName],
          enumerable: true,  // Enumerable so it's included in Object.entries
          configurable: true,
        });
      }
      return result;
    };

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
    const table = this;
    const executeInsert = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      const schema = table._getSchema();
      const executor = table._getExecutor();
      const client = table._getClient();

      // Build INSERT columns and values
      const columns: string[] = [];
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(data)) {
        const column = schema.columns[key];
        if (column) {
          const config = (column as any).build();
          if (!config.autoIncrement) {
            columns.push(`"${config.name}"`);
            const mappedValue = config.mapper ? config.mapper.toDriver(value) : value;
            values.push(mappedValue);
            placeholders.push(`$${paramIndex++}`);
          }
        }
      }

      // Build RETURNING clause
      const returningClause = table.buildReturningClause(returning);
      const qualifiedTableName = table._getQualifiedTableName();

      let sql = `INSERT INTO ${qualifiedTableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      const result = executor
        ? await executor.query(sql, values)
        : await client.query(sql, values);

      if (!returningClause) {
        return undefined;
      }

      const mappedResults = table.mapReturningResults(result.rows, returning);
      return mappedResults[0];
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeInsert(undefined).then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeInsert(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Insert multiple records
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.insertMany([{ username: 'alice' }, { username: 'bob' }]);
   *
   * // With returning() - returns full entities
   * const users = await db.users.insertMany([{ username: 'alice' }]).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.insertMany([{ username: 'alice' }]).returning(u => ({ id: u.id }));
   * ```
   */
  insertMany(data: InsertData<TEntity>[]): FluentInsertMany<TEntity> {
    return this.insertBulk(data);
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
   * // With options
   * await db.users.insertBulk([{ username: 'alice' }], { chunkSize: 100 });
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
          const chunkResults = await table.insertBulkSingle(chunk, returning, options?.overridingSystemValue);
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.insertBulkSingle(dataArray, returning, options?.overridingSystemValue);
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
   * Execute a single bulk insert batch
   * @internal
   */
  private async insertBulkSingle<TReturning>(
    data: InsertData<TEntity>[],
    returning: TReturning,
    overridingSystemValue?: boolean
  ): Promise<any[] | void> {
    const schema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();
    const qualifiedTableName = this._getQualifiedTableName();

    // Get columns from first row
    const referenceItem = data[0];
    const columnConfigs: Array<{ propName: string; dbName: string; mapper?: any }> = [];

    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      if (propName in referenceItem) {
        const config = (colBuilder as any).build();
        if (!config.autoIncrement || overridingSystemValue) {
          columnConfigs.push({
            propName,
            dbName: config.name,
            mapper: config.mapper,
          });
        }
      }
    }

    // Build VALUES clauses
    const valuesClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (const record of data) {
      const rowValues: string[] = [];
      for (const col of columnConfigs) {
        const value = (record as any)[col.propName];
        // Convert undefined to null - undefined values are not allowed by postgres drivers
        const normalizedValue = value === undefined ? null : value;
        const mappedValue = col.mapper ? col.mapper.toDriver(normalizedValue) : normalizedValue;
        rowValues.push(`$${paramIndex++}`);
        params.push(mappedValue);
      }
      valuesClauses.push(`(${rowValues.join(', ')})`);
    }

    const columnList = columnConfigs.map(c => `"${c.dbName}"`).join(', ');
    const returningClause = this.buildReturningClause(returning as any);

    let sql = `INSERT INTO ${qualifiedTableName} (${columnList})`;
    if (overridingSystemValue) {
      sql += ' OVERRIDING SYSTEM VALUE';
    }
    sql += ` VALUES ${valuesClauses.join(', ')}`;
    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, params)
      : await client.query(sql, params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returning as any);
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
   * ```
   */
  upsertBulk(
    values: InsertData<TEntity>[],
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
            overridingSystemValue || false, config?.targetWhere, config?.setWhere, returning
          );
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.upsertBulkSingle(
        values, primaryKeys, updateColumns, config?.updateColumnFilter,
        overridingSystemValue || false, config?.targetWhere, config?.setWhere, returning
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
   * Execute a single upsert batch
   * @internal
   */
  private async upsertBulkSingle<TReturning>(
    values: InsertData<TEntity>[],
    primaryKeys: string[],
    updateColumns: string[] | undefined,
    updateColumnFilter: ((colId: string) => boolean) | undefined,
    overridingSystemValue: boolean,
    targetWhere: string | undefined,
    setWhere: string | undefined,
    returning: TReturning
  ): Promise<any[] | void> {
    const schema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();
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

    // Determine columns to update
    let columnsToUpdate: string[];
    if (updateColumns) {
      columnsToUpdate = updateColumns;
    } else if (updateColumnFilter) {
      columnsToUpdate = Array.from(columnSet).filter(updateColumnFilter);
    } else {
      columnsToUpdate = Array.from(columnSet).filter(key => !primaryKeys.includes(key));
    }

    if (columnsToUpdate.length === 0) {
      sql += ' DO NOTHING';
    } else {
      const updateSetClauses = columnsToUpdate.map(propName => {
        const col = columnConfigs.find(c => c.propName === propName);
        const dbName = col ? col.dbName : propName;
        return `"${dbName}" = EXCLUDED."${dbName}"`;
      });

      sql += ` DO UPDATE SET ${updateSetClauses.join(', ')}`;

      if (setWhere) {
        sql += ` WHERE ${setWhere}`;
      }
    }

    // Add RETURNING clause
    const returningClause = this.buildReturningClause(returning as any);
    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, params)
      : await client.query(sql, params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returning as any);
  }

  /**
   * Map database column names back to property names
   */
  private mapResultToEntity(result: any): UnwrapDbColumns<TEntity> {
    const schema = this._getSchema();
    const mapped: any = {};
    for (const [propName, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build();
      const dbColumnName = config.name;
      if (dbColumnName in result) {
        const rawValue = result[dbColumnName];
        // Apply fromDriver mapper if present
        mapped[propName] = config.mapper ? config.mapper.fromDriver(rawValue) : rawValue;
      }
    }
    return mapped as UnwrapDbColumns<TEntity>;
  }

  /**
   * Map array of database results to entities
   */
  private mapResultsToEntities(results: any[]): UnwrapDbColumns<TEntity>[] {
    return results.map(r => this.mapResultToEntity(r));
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
    return new EntityInsertBuilder<TEntity>(builder);
  }

  /**
   * Update records matching condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.update({ age: 30 }, u => eq(u.id, 1));
   *
   * // With returning() - returns full entities
   * const users = await db.users.update({ age: 30 }, u => eq(u.id, 1)).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.update({ age: 30 }, u => eq(u.id, 1))
   *   .returning(u => ({ id: u.id, age: u.age }));
   * ```
   */
  update(
    data: Partial<InsertData<TEntity>>,
    condition: (entity: EntityQuery<TEntity>) => Condition
  ): FluentUpdate<TEntity> {
    const table = this;

    const executeUpdate = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      const schema = table._getSchema();
      const executor = table._getExecutor();
      const client = table._getClient();

      // Build SET clause
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(data)) {
        const column = schema.columns[key];
        if (column) {
          const config = (column as any).build();
          setClauses.push(`"${config.name}" = $${paramIndex++}`);
          values.push(value);
        }
      }

      if (setClauses.length === 0) {
        throw new Error('No valid columns to update');
      }

      // Build WHERE clause
      const mockEntity = table.createMockEntity();
      const whereCondition = condition(mockEntity as any);

      const condBuilder = new ConditionBuilder();
      const { sql: whereSql, params: whereParams } = condBuilder.build(whereCondition, paramIndex);

      values.push(...whereParams);

      // Build RETURNING clause
      const returningClause = table.buildReturningClause(returning);

      const qualifiedTableName = table._getQualifiedTableName();
      let sql = `UPDATE ${qualifiedTableName} SET ${setClauses.join(', ')} WHERE ${whereSql}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      const result = executor
        ? await executor.query(sql, values)
        : await client.query(sql, values);

      if (!returningClause) {
        return undefined;
      }

      return table.mapReturningResults(result.rows, returning);
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeUpdate(undefined).then(onfulfilled, onrejected);
      },
      returning<TResult>(selector?: (entity: EntityQuery<TEntity>) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeUpdate(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
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
    }
  ): FluentBulkUpdate<TEntity> {
    const table = this;

    const executeBulkUpdate = async <TResult>(
      returning?: undefined | true | ((entity: EntityQuery<TEntity>) => TResult)
    ): Promise<any> => {
      if (data.length === 0) {
        return returning === undefined ? undefined : [];
      }

      const schema = table._getSchema();

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
          const chunkResults = await table.bulkUpdateSingle(chunk, primaryKeys, returning);
          if (chunkResults) allResults.push(...chunkResults);
        }
        return returning === undefined ? undefined : allResults;
      }

      return table.bulkUpdateSingle(data, primaryKeys, returning);
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
    returning: TReturning
  ): Promise<any[] | void> {
    const schema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();
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

    if (updateColumnsSet.size === 0) {
      throw new Error('No columns to update (only primary keys provided)');
    }

    // Build column info - access config once per column
    const columnInfoList: Array<{ propName: string; dbName: string; pgType: string; isPK: boolean }> = [];
    const valueColumnParts: string[] = [];
    const setClauses: string[] = [];
    const whereClauseParts: string[] = [];

    for (const propName of allColumnsSet) {
      const colConfig = (schema.columns[propName] as any).build();
      const dbName = colConfig.name;
      const pgType = DbEntityTable.PG_TYPE_MAP[colConfig.type] || colConfig.type;
      const isPK = primaryKeySet.has(propName);

      const info = { propName, dbName, pgType, isPK };
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
    let paramIndex = 1;

    for (const record of data) {
      const rowValues: string[] = [];
      for (const col of columnInfoList) {
        const hasKey = col.propName in record;
        const value = record[col.propName];

        // Add the value (always cast to correct type for NULL to work in CASE expressions)
        if (value === undefined || value === null) {
          rowValues.push(`NULL::${col.pgType}`);
        } else {
          rowValues.push(`$${paramIndex++}::${col.pgType}`);
          params.push(value);
        }

        // Add the "was provided" flag for non-PK columns
        if (!col.isPK) {
          rowValues.push(hasKey ? 'true' : 'false');
        }
      }
      valuesClauses.push(`(${rowValues.join(', ')})`);
    }

    // Build RETURNING clause
    const returningClause = this.buildReturningClause(returning as any, 't');

    let sql = `
UPDATE ${qualifiedTableName} AS t
SET ${setClauses.join(', ')}
FROM (VALUES ${valuesClauses.join(', ')}) AS v(${valueColumnList})
WHERE ${whereClause}`.trim();

    if (returningClause) {
      sql += ` RETURNING ${returningClause.sql}`;
    }

    const result = executor
      ? await executor.query(sql, params)
      : await client.query(sql, params);

    if (!returningClause) {
      return undefined;
    }

    return this.mapReturningResults(result.rows, returning as any);
  }

  /**
   * Delete records matching condition
   * Usage: db.users.delete(u => eq(u.id, 1))
   */
  async delete(condition: (entity: EntityQuery<TEntity>) => Condition): Promise<void> {
    const schema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();

    // Build WHERE clause
    const mockEntity = this.createMockEntity();
    const whereCondition = condition(mockEntity as any);

    const condBuilder = new ConditionBuilder();
    const { sql: whereSql, params: whereParams } = condBuilder.build(whereCondition, 1);

    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `DELETE FROM ${qualifiedTableName} WHERE ${whereSql}`;

    const result = executor
      ? await executor.query(sql, whereParams)
      : await client.query(sql, whereParams);
  }

  /**
   * Create a mock entity for type inference in lambdas
   */
  private createMockEntity(): EntityQuery<TEntity> {
    const schema = this._getSchema();
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
              schema.name,
              targetSchema
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
              targetSchema
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
    tableAlias?: string
  ): { sql: string; columns: string[] } | null {
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

    // Selector function - extract selected columns
    const mockEntity = this.createMockEntity();
    const selection = returning(mockEntity as any);

    if (typeof selection === 'object' && selection !== null) {
      const columns: string[] = [];
      const sqlParts: string[] = [];

      for (const [alias, field] of Object.entries(selection)) {
        if (field && typeof field === 'object' && '__dbColumnName' in field) {
          const dbName = (field as any).__dbColumnName;
          columns.push(alias);
          sqlParts.push(`${prefix}"${dbName}" AS "${alias}"`);
        }
      }

      return { sql: sqlParts.join(', '), columns };
    }

    // Single field selection
    if (selection && typeof selection === 'object' && '__dbColumnName' in selection) {
      const dbName = (selection as any).__dbColumnName;
      return { sql: `${prefix}"${dbName}"`, columns: [dbName] };
    }

    return null;
  }

  /**
   * Map row results based on returning config
   * @internal
   */
  private mapReturningResults<TResult>(
    rows: any[],
    returning: ReturningConfig<EntityQuery<TEntity>, TResult>
  ): any[] {
    if (returning === true) {
      // Full entity mapping
      return this.mapResultsToEntities(rows);
    }

    // For selector functions, rows are already in the correct shape
    // Just apply any type mappers needed
    const schema = this._getSchema();
    return rows.map(row => {
      const mapped: any = {};
      for (const [key, value] of Object.entries(row)) {
        // Try to find column by alias or name
        const colEntry = Object.entries(schema.columns).find(([propName, col]) => {
          const config = (col as any).build();
          return propName === key || config.name === key;
        });

        if (colEntry) {
          const [propName, col] = colEntry;
          const config = (col as any).build();
          // Apply fromDriver mapper if present
          mapped[key] = config.mapper ? config.mapper.fromDriver(value) : value;
        } else {
          mapped[key] = value;
        }
      }
      return mapped;
    });
  }

  // Note: findById not yet implemented on TableAccessor
}

/**
 * Base database context with entity-first approach
 */
export abstract class DatabaseContext extends DataContext {
  private modelConfig!: DbModelConfig;
  private entityTables = new Map<EntityConstructor<any>, DbEntityTable<any>>();
  private sequenceRegistry = new Map<string, SequenceConfig>();
  private sequenceInstances = new Map<string, DbSequence>();

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
  override getSchemaManager(): DbSchemaManager {
    return new DbSchemaManager(
      this.client,
      (this as any).schemaRegistry,
      {
        logQueries: (this as any).queryOptions?.logQueries,
        postMigrationHook: async (client: DatabaseClient) => {
          await this.onMigrationComplete(client);
        },
        sequenceRegistry: this.sequenceRegistry
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
}
