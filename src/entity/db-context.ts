import { DatabaseClient, QueryResult } from '../database/database-client.interface';
import { TableBuilder, TableSchema, InferTableType } from '../schema/table-builder';
import { UnwrapDbColumns, InsertData, ExtractDbColumns } from './db-column';
import { DbEntity, EntityConstructor, EntityMetadataStore } from './entity-base';
import { DbModelConfig } from './model-config';
import { JoinQueryBuilder } from '../query/join-builder';
import { Condition, ConditionBuilder, SqlFragment } from '../query/conditions';
import { ResolveCollectionResults, CollectionQueryBuilder, ReferenceQueryBuilder, SelectQueryBuilder, QueryBuilder } from '../query/query-builder';
import { InferRowType } from '../schema/row-type';
import { DbSchemaManager } from '../migration/db-schema-manager';
import { DbSequence, SequenceConfig } from '../schema/sequence-builder';

/**
 * Collection aggregation strategy type
 */
export type CollectionStrategyType = 'jsonb' | 'temptable';

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
  /** Collection aggregation strategy (default: 'jsonb') */
  collectionStrategy?: CollectionStrategyType;
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
      const result = await this.client.query(sql, params);

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
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(): string {
    return this.schema.schema
      ? `"${this.schema.schema}"."${this.schema.name}"`
      : `"${this.schema.name}"`;
  }

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

    const columnNames = columns.map(key => {
      const column = this.schema.columns[key as string];
      const config = column.build();
      return `"${config.name}"`;
    });

    const returningColumns = Object.entries(this.schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = this.getQualifiedTableName();
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
   */
  select<TSelection>(
    selector: (row: InferRowType<TBuilder>) => TSelection
  ): SelectQueryBuilder<TSelection> {
    return new SelectQueryBuilder(this.schema, this.client, selector as any, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, undefined, this.schemaRegistry, undefined, this.collectionStrategy);
  }

  /**
   * Add WHERE condition before select
   */
  where(condition: (row: InferRowType<TBuilder>) => Condition): QueryBuilder<TableSchema, InferRowType<TBuilder>> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy);
    return qb.where(condition);
  }

  /**
   * Left join with another table and selector
   */
  leftJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: InferRowType<TBuilder>, right: TRight) => Condition,
    selector: (left: InferRowType<TBuilder>, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<TSelection> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy);
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
  ): SelectQueryBuilder<TSelection> {
    const qb = new QueryBuilder<TableSchema, InferRowType<TBuilder>>(this.schema, this.client, undefined, undefined, undefined, undefined, this.executor, undefined, undefined, this.collectionStrategy);
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
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(): string {
    return this.schema.schema
      ? `"${this.schema.schema}"."${this.schema.name}"`
      : `"${this.schema.name}"`;
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

    const returningColumns = Object.entries(this.schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = this.getQualifiedTableName();
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
    let chunkSize = insertConfig?.chunkSize;

    if (chunkSize == null && dataArray.length > 0) {
      const POSTGRES_MAX_PARAMS = 65535; // PostgreSQL parameter limit
      const columnCount = Object.keys(dataArray[0]).length;
      const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
      chunkSize = Math.floor(maxRowsPerBatch * 0.6); // Use 60% of max to be safe
    }

    // Check if we need to chunk
    if (chunkSize && dataArray.length > chunkSize) {
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
    const columnSet = new Set<string>();
    for (const data of dataArray) {
      for (const key of Object.keys(data)) {
        const column = this.schema.columns[key];
        if (column) {
          const config = column.build();
          if (!config.autoIncrement || insertConfig?.overridingSystemValue) {
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

    const qualifiedTableName = this.getQualifiedTableName();
    let sql = `INSERT INTO ${qualifiedTableName} (${columnNames.join(', ')})`;

    if (insertConfig?.overridingSystemValue) {
      sql += '\n      OVERRIDING SYSTEM VALUE';
    }

    sql += `\n      VALUES ${valuePlaceholders.join(', ')}
      RETURNING ${returningColumns}`;

    const result = this.executor
      ? await this.executor.query(sql, values)
      : await this.client.query(sql, values);
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
    let primaryKeys: string[] = [];
    if (config?.primaryKey) {
      primaryKeys = Array.isArray(config.primaryKey) ? config.primaryKey : [config.primaryKey];
    } else {
      // Auto-detect from schema
      for (const [key, colBuilder] of Object.entries(this.schema.columns)) {
        const colConfig = (colBuilder as any).build();
        if (colConfig.primaryKey) {
          primaryKeys.push(key);
        }
      }
    }

    // Auto-detect overridingSystemValue
    let overridingSystemValue = config?.overridingSystemValue;
    if (overridingSystemValue == null) {
      for (const key of Object.keys(referenceItem)) {
        const column = this.schema.columns[key];
        if (column) {
          const colConfig = (column as any).build();
          if (colConfig.primaryKey && colConfig.autoIncrement) {
            overridingSystemValue = true;
            break;
          }
        }
      }
    }

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
    let chunkSize = config?.chunkSize;
    if (chunkSize == null && values.length > 0) {
      const POSTGRES_MAX_PARAMS = 65535;
      const columnCount = Object.keys(values[0]).length;
      const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
      chunkSize = Math.floor(maxRowsPerBatch * 0.6); // Use 60% of max to be safe
    }

    // Check if we need to chunk
    if (chunkSize && values.length > chunkSize) {
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

    const qualifiedTableName = this.getQualifiedTableName();
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

    const qualifiedTableName = this.getQualifiedTableName();
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

    const qualifiedTableName = this.getQualifiedTableName();
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
   * Execute raw SQL
   */
  async query(sql: string, params?: any[]): Promise<any> {
    return this.client.query(sql, params);
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
 * Type helper to build entity query type with navigation support
 */
export type EntityQuery<TEntity extends DbEntity> = {
  [K in keyof TEntity]: TEntity[K] extends (infer U)[] | undefined
    ? U extends DbEntity
      ? EntityCollectionQuery<U>
      : TEntity[K]
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
  where(condition: (item: EntityQuery<TEntity>) => any): this;

  // Ordering and pagination
  orderBy(selector: (item: EntityQuery<TEntity>) => any): this;
  orderBy(selector: (item: EntityQuery<TEntity>) => any[]): this;
  orderBy(selector: (item: EntityQuery<TEntity>) => Array<[any, 'ASC' | 'DESC']>): this;
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
  where(condition: (item: EntityQuery<TEntity>) => any): this;

  // Ordering and pagination
  orderBy(selector: (item: TSelection) => any): this;
  orderBy(selector: (item: TSelection) => any[]): this;
  orderBy(selector: (item: TSelection) => Array<[any, 'ASC' | 'DESC']>): this;
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
 * Strongly-typed query builder for entities
 * Results automatically unwrap DbColumn<T> to T
 */
export interface EntitySelectQueryBuilder<TEntity extends DbEntity, TSelection> {
  select<TNewSelection>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, TNewSelection>;

  selectDistinct<TNewSelection>(
    selector: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => TNewSelection
  ): EntitySelectQueryBuilder<TEntity, TNewSelection>;

  where(
    condition: (entity: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection) => any
  ): EntitySelectQueryBuilder<TEntity, TSelection>;

  orderBy(selector: (row: TSelection) => any): EntitySelectQueryBuilder<TEntity, TSelection>;
  orderBy(selector: (row: TSelection) => any[]): EntitySelectQueryBuilder<TEntity, TSelection>;
  orderBy(selector: (row: TSelection) => Array<[any, 'ASC' | 'DESC']>): EntitySelectQueryBuilder<TEntity, TSelection>;

  limit(count: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  offset(count: number): EntitySelectQueryBuilder<TEntity, TSelection>;

  count(): Promise<number>;

  first(): Promise<ResolveCollectionResults<TSelection>>;

  firstOrDefault(): Promise<ResolveCollectionResults<TSelection> | null>;

  firstOrThrow(): Promise<ResolveCollectionResults<TSelection>>;

  leftJoin<TRight extends DbEntity | Record<string, any>, TNewSelection>(
    rightTable: DbEntityTable<TRight extends DbEntity ? TRight : never> | import('../query/subquery').Subquery<TRight, 'table'> | import('../query/cte-builder').DbCte<TRight>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight extends DbEntity ? (EntityQuery<TRight> | TRight) : TRight) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight extends DbEntity ? (EntityQuery<TRight> | TRight) : TRight) => TNewSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, TNewSelection>;

  innerJoin<TRight extends DbEntity | Record<string, any>, TNewSelection>(
    rightTable: DbEntityTable<TRight extends DbEntity ? TRight : never> | import('../query/subquery').Subquery<TRight, 'table'> | import('../query/cte-builder').DbCte<TRight>,
    condition: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight extends DbEntity ? (EntityQuery<TRight> | TRight) : TRight) => Condition,
    selector: (left: TSelection extends DbEntity ? EntityQuery<TSelection> : TSelection, right: TRight extends DbEntity ? (EntityQuery<TRight> | TRight) : TRight) => TNewSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, TNewSelection>;

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
  update(data: Partial<InsertData<TEntity>>): Promise<UnwrapDbColumns<TEntity>[]>;
  delete(): Promise<void>;

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
  orderBy(selector: (row: TEntity) => any): EntitySelectQueryBuilder<TEntity, TEntity>;
  orderBy(selector: (row: TEntity) => any[]): EntitySelectQueryBuilder<TEntity, TEntity>;
  orderBy(selector: (row: TEntity) => Array<[any, 'ASC' | 'DESC']>): EntitySelectQueryBuilder<TEntity, TEntity>;
  orderBy(selector: (row: TEntity) => any | any[] | Array<[any, 'ASC' | 'DESC']>): EntitySelectQueryBuilder<TEntity, TEntity> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.orderBy(selector) as EntitySelectQueryBuilder<TEntity, TEntity>;
  }

  /**
   * Limit results
   */
  limit(count: number): EntitySelectQueryBuilder<TEntity, TEntity> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.limit(count) as EntitySelectQueryBuilder<TEntity, TEntity>;
  }

  /**
   * Offset results
   */
  offset(count: number): EntitySelectQueryBuilder<TEntity, TEntity> {
    const schema = this._getSchema();
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      return result;
    };

    const qb = this.context.getTable(this.tableName).select(allColumnsSelector) as any;
    return qb.offset(count) as EntitySelectQueryBuilder<TEntity, TEntity>;
  }

  /**
   * Select query
   */
  select<TSelection>(
    selector: (entity: EntityQuery<TEntity>) => TSelection
  ): EntitySelectQueryBuilder<TEntity, TSelection> {
    const queryBuilder = this.context.getTable(this.tableName).select(selector as any);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, TSelection>;
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
    condition: (entity: EntityQuery<TEntity>) => any
  ): EntitySelectQueryBuilder<TEntity, TEntity> {
    const schema = this._getSchema();

    // Create a selector that selects all columns with navigation property access
    const allColumnsSelector = (e: any) => {
      const result: any = {};
      // Copy all column properties
      for (const colName of Object.keys(schema.columns)) {
        result[colName] = e[colName];
      }
      // Add navigation properties
      for (const relName of Object.keys(schema.relations)) {
        const relConfig = schema.relations[relName];
        if (relConfig.type === 'many') {
          // For collections, use empty array placeholder
          // (prevents CollectionQueryBuilder evaluation)
          result[relName] = [];
        } else {
          // For references, copy the ReferenceQueryBuilder mock
          // This allows accessing fields like o.user!.username in chained selectors
          result[relName] = e[relName];
        }
      }
      return result;
    };

    const queryBuilder = this.context.getTable(this.tableName)
      .where(condition as any)
      .select(allColumnsSelector);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, TEntity>;
  }

  /**
   * Left join with another table or subquery and selector
   */
  leftJoin<TRight extends DbEntity, TSelection>(
    rightTable: DbEntityTable<TRight> | import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: EntityQuery<TEntity>, right: EntityQuery<TRight> | TRight) => Condition,
    selector: (left: EntityQuery<TEntity>, right: EntityQuery<TRight> | TRight) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, TSelection> {
    const queryBuilder = this.context.getTable(this.tableName).leftJoin(rightTable as any, condition as any, selector as any, alias);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, TSelection>;
  }

  /**
   * Inner join with another table or subquery and selector
   */
  innerJoin<TRight extends DbEntity, TSelection>(
    rightTable: DbEntityTable<TRight> | import('../query/subquery').Subquery<TRight, 'table'>,
    condition: (left: EntityQuery<TEntity>, right: EntityQuery<TRight> | TRight) => Condition,
    selector: (left: EntityQuery<TEntity>, right: EntityQuery<TRight> | TRight) => TSelection,
    alias?: string
  ): EntitySelectQueryBuilder<TEntity, TSelection> {
    const queryBuilder = this.context.getTable(this.tableName).innerJoin(rightTable as any, condition as any, selector as any, alias);
    return queryBuilder as any as EntitySelectQueryBuilder<TEntity, TSelection>;
  }

  /**
   * Insert - accepts only DbColumn properties (excludes navigation properties)
   */
  async insert(data: InsertData<TEntity>): Promise<UnwrapDbColumns<TEntity>> {
    const result = await this.context.getTable(this.tableName).insert(data as any);
    return this.mapResultToEntity(result);
  }

  /**
   * Insert multiple records
   */
  async insertMany(data: InsertData<TEntity>[]): Promise<UnwrapDbColumns<TEntity>[]> {
    return this.insertBulk(data);
  }

  /**
   * Upsert (insert or update on conflict)
   */
  async upsert(
    data: InsertData<TEntity>[],
    config?: EntityUpsertConfig<TEntity>
  ): Promise<UnwrapDbColumns<TEntity>[]> {
    return this.upsertBulk(data, config);
  }

  /**
   * Bulk insert with advanced configuration
   * Supports automatic chunking for large datasets
   */
  async insertBulk(
    value: InsertData<TEntity> | InsertData<TEntity>[],
    insertConfig?: InsertConfig
  ): Promise<UnwrapDbColumns<TEntity>[]> {
    const results = await this.context.getTable(this.tableName).insertBulk(value as any, insertConfig);
    return this.mapResultsToEntities(results);
  }

  /**
   * Upsert with advanced configuration
   * Auto-detects primary keys and supports chunking
   */
  async upsertBulk(
    values: InsertData<TEntity>[],
    config?: EntityUpsertConfig<TEntity>
  ): Promise<UnwrapDbColumns<TEntity>[]> {
    // Convert typed config to base config
    const baseConfig: UpsertConfig = {
      chunkSize: config?.chunkSize,
      overridingSystemValue: config?.overridingSystemValue,
      targetWhere: config?.targetWhere,
      setWhere: config?.setWhere,
      referenceItem: config?.referenceItem,
      updateColumnFilter: config?.updateColumnFilter,
    };

    // Handle primaryKey (can be lambda, string, or array)
    if (config?.primaryKey) {
      if (typeof config.primaryKey === 'function') {
        // Lambda selector - extract property names
        const pkProps = this.extractPropertyNames(config.primaryKey);
        baseConfig.primaryKey = pkProps.length === 1 ? pkProps[0] : pkProps;
      } else {
        // Direct string or array
        baseConfig.primaryKey = config.primaryKey as string | string[];
      }
    }

    // Handle updateColumns (can be lambda or array)
    if (config?.updateColumns) {
      if (typeof config.updateColumns === 'function') {
        // Lambda selector - extract property names
        baseConfig.updateColumns = this.extractPropertyNames(config.updateColumns);
      } else {
        // Direct array
        baseConfig.updateColumns = config.updateColumns as string[];
      }
    }

    const results = await this.context.getTable(this.tableName).upsertBulk(values as any, baseConfig);
    return this.mapResultsToEntities(results);
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
        mapped[propName] = result[dbColumnName];
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
   * Usage: db.users.update({ age: 30 }, u => eq(u.id, 1))
   */
  async update(
    data: Partial<InsertData<TEntity>>,
    condition: (entity: EntityQuery<TEntity>) => Condition
  ): Promise<UnwrapDbColumns<TEntity>[]> {
    const schema = this._getSchema();
    const executor = this._getExecutor();
    const client = this._getClient();

    // Build SET clause
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(data)) {
      const column = schema.columns[key];
      if (column) {
        const config = column.build();
        setClauses.push(`"${config.name}" = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (setClauses.length === 0) {
      throw new Error('No valid columns to update');
    }

    // Build WHERE clause
    const mockEntity = this.createMockEntity();
    const whereCondition = condition(mockEntity as any);

    const condBuilder = new ConditionBuilder();
    const { sql: whereSql, params: whereParams } = condBuilder.build(whereCondition, paramIndex);

    values.push(...whereParams);

    // Build RETURNING clause
    const returningColumns = Object.entries(schema.columns)
      .map(([_, col]) => `"${(col as any).build().name}"`)
      .join(', ');

    const qualifiedTableName = this._getQualifiedTableName();
    const sql = `
      UPDATE ${qualifiedTableName}
      SET ${setClauses.join(', ')}
      WHERE ${whereSql}
      RETURNING ${returningColumns}
    `;

    const result = executor
      ? await executor.query(sql, values)
      : await client.query(sql, values);

    return this.mapResultsToEntities(result.rows);
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
