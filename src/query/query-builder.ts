import { Condition, ConditionBuilder, SqlFragment, SqlBuildContext, FieldRef, UnwrapSelection, and as andCondition, Placeholder } from './conditions';
import { PreparedQuery } from './prepared-query';
import { TableSchema } from '../schema/table-builder';
import type { QueryExecutor, CollectionStrategyType, OrderDirection, OrderByResult, FluentDelete, FluentQueryUpdate } from '../entity/db-context';
import { TimeTracer } from '../entity/db-context';
import { parseOrderBy } from './query-utils';
import type { DatabaseClient, QueryResult } from '../database/database-client.interface';
import { Subquery } from './subquery';
import { GroupedQueryBuilder } from './grouped-query';
import { DbCte, isCte } from './cte-builder';
import { CollectionStrategyFactory } from './collection-strategy.factory';
import type { CollectionAggregationConfig, SelectedField, NavigationJoin } from './collection-strategy.interface';
import { UnionQueryBuilder } from './union-builder';
import { FutureQuery, FutureSingleQuery, FutureCountQuery } from './future-query';
import { formatJoinValue, isLiteralKeyPart } from './join-utils';

/**
 * Field type categories for optimized result transformation
 * const enum is inlined at compile time for zero runtime overhead
 */
const enum FieldType {
  NAVIGATION = 0,
  COLLECTION_SCALAR = 1,
  COLLECTION_ARRAY = 2,
  COLLECTION_JSON = 3,
  CTE_AGGREGATION = 4,
  SQL_FRAGMENT_MAPPER = 5,
  FIELD_REF_MAPPER = 6,
  FIELD_REF_NO_MAPPER = 7,
  SIMPLE = 8,
  COLLECTION_SINGLE = 9,  // firstOrDefault() - single item or null
}

/**
 * Performance utility: Get column name map from schema, using cached version if available
 */
export function getColumnNameMapForSchema(schema: TableSchema): Map<string, string> {
  if (schema.columnNameMap) {
    return schema.columnNameMap;
  }
  // Fallback: build the map (for schemas that weren't built with the new TableBuilder)
  const map = new Map<string, string>();
  for (const [colName, colBuilder] of Object.entries(schema.columns)) {
    map.set(colName, (colBuilder as any).build().name);
  }
  return map;
}

/**
 * Performance utility: Get relation entries array from schema, using cached version if available
 */
export function getRelationEntriesForSchema(schema: TableSchema): Array<[string, any]> {
  if (schema.relationEntries) {
    return schema.relationEntries;
  }
  // Fallback: build the array (for schemas that weren't built with the new TableBuilder)
  return Object.entries(schema.relations);
}

/**
 * Performance utility: Get target schema for a relation, using cached version if available
 */
export function getTargetSchemaForRelation(schema: TableSchema, relName: string, relConfig: { targetTableBuilder?: { build(): TableSchema } }): TableSchema | undefined {
  // Try cached version first
  if (schema.relationSchemaCache) {
    const cached = schema.relationSchemaCache.get(relName);
    if (cached) return cached;
  }
  // Fallback: build the schema
  if (relConfig.targetTableBuilder) {
    return relConfig.targetTableBuilder.build();
  }
  return undefined;
}

// Performance: Cache nested field ref proxies per table alias
const nestedFieldRefProxyCache = new Map<string, any>();

/**
 * Creates a nested proxy that supports accessing properties at any depth.
 * This allows patterns like `p.product.priceMode` to work even without full schema information.
 * Each property access returns an object that is both a FieldRef and can be further accessed.
 *
 * @param tableAlias The table alias to use for the FieldRef
 * @returns A proxy that creates FieldRefs for any property access
 */
export function createNestedFieldRefProxy(tableAlias: string): any {
  // Return cached proxy if available
  const cached = nestedFieldRefProxyCache.get(tableAlias);
  if (cached) return cached;

  const handler: ProxyHandler<any> = {
    get: (_target: any, prop: string | symbol) => {
      // Handle Symbol.toPrimitive for string conversion (used in template literals)
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => `[NestedFieldRefProxy:${tableAlias}]`;
      }
      if (typeof prop === 'symbol') return undefined;
      // Return an object that is both a FieldRef AND a proxy for further nesting
      const fieldRef = {
        __fieldName: prop,
        __dbColumnName: prop,
        __tableAlias: tableAlias,
      };
      // Return a proxy that acts as both the FieldRef and allows further property access
      return new Proxy(fieldRef, {
        get: (fieldTarget: any, nestedProp: string | symbol) => {
          // Handle Symbol.toPrimitive for string conversion (used in template literals)
          if (nestedProp === Symbol.toPrimitive || nestedProp === 'toString' || nestedProp === 'valueOf') {
            return () => fieldTarget.__dbColumnName;
          }
          if (typeof nestedProp === 'symbol') return undefined;
          // If accessing FieldRef properties, return them
          if (nestedProp === '__fieldName' || nestedProp === '__dbColumnName' || nestedProp === '__tableAlias') {
            return fieldTarget[nestedProp];
          }
          // Otherwise, treat as nested navigation and create a new nested proxy
          // The nested table alias is the property name (e.g., 'product' for p.product)
          return createNestedFieldRefProxy(prop as string)[nestedProp];
        },
        has: (_fieldTarget, _nestedProp) => true,
      });
    },
    has: (_target, prop) => {
      // The outer proxy doesn't have FieldRef properties - only field names
      if (prop === '__fieldName' || prop === '__dbColumnName' || prop === '__tableAlias') {
        return false;
      }
      return true;
    },
  };
  const proxy = new Proxy({}, handler);
  nestedFieldRefProxyCache.set(tableAlias, proxy);
  return proxy;
}

/**
 * Join type
 */
export type JoinType = 'INNER' | 'LEFT';

/**
 * Manual join definition
 */
export interface ManualJoinDefinition {
  type: JoinType;
  table: string;
  alias: string;
  schema: TableSchema;
  condition: Condition;
  cte?: DbCte<any>;  // Optional CTE reference if joining with a CTE
}

/**
 * Query context for tracking CTEs and aliases
 */
export interface QueryContext {
  ctes: Map<string, { sql: string; params: any[] }>;
  cteCounter: number;
  paramCounter: number;
  allParams: any[];
  collectionStrategy?: CollectionStrategyType;
  executor?: QueryExecutor;
  /** Map of placeholder names to their parameter indices (for prepared statements) */
  placeholders?: Map<string, number>;
  /**
   * Map of original table names to their LATERAL aliases.
   * Used by nested LATERALs to reference parent collection tables correctly.
   * Example: { "posts": "lateral_0_posts" }
   */
  lateralTableAliasMap?: Map<string, string>;
}

/**
 * Selection definition
 */
type SelectionDef = {
  [key: string]: any;
};

/**
 * Cached regex for numeric string detection
 * Used to convert PostgreSQL NUMERIC/BIGINT strings to numbers
 */
const NUMERIC_REGEX = /^-?\d+(\.\d+)?$/;

/**
 * Query builder for a table
 */
export class QueryBuilder<TSchema extends TableSchema, TRow = any> {
  private schema: TSchema;
  private client: DatabaseClient;
  private whereCond?: Condition;
  private selection?: (row: any) => SelectionDef;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;
  private collectionStrategy?: CollectionStrategyType;
  private schemaRegistry?: Map<string, TableSchema>;

  // Performance: Cache the mock row to avoid recreating it
  private _cachedMockRow?: any;

  constructor(schema: TSchema, client: DatabaseClient, whereCond?: Condition, limit?: number, offset?: number, orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC' }>, executor?: QueryExecutor, manualJoins?: ManualJoinDefinition[], joinCounter?: number, collectionStrategy?: CollectionStrategyType, schemaRegistry?: Map<string, TableSchema>) {
    this.schema = schema;
    this.client = client;
    this.whereCond = whereCond;
    this.limitValue = limit;
    this.offsetValue = offset;
    this.orderByFields = orderBy || [];
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
    this.collectionStrategy = collectionStrategy;
    this.schemaRegistry = schemaRegistry;
  }

  /**
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(tableName: string, schema?: string): string {
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  /**
   * Define the selection with support for nested queries
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  select<TSelection>(selector: (row: TRow) => TSelection): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    return new SelectQueryBuilder(
      this.schema,
      this.client,
      selector as any,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      false,  // isDistinct defaults to false
      this.schemaRegistry,  // Pass schema registry for nested navigation resolution
      [],  // ctes - start with empty array
      this.collectionStrategy
    );
  }

  /**
   * Add WHERE condition
   * Multiple where() calls are chained with AND logic
   */
  where(condition: (row: TRow) => Condition): this {
    const mockRow = this._createMockRow();
    const newCondition = condition(mockRow);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
    }
    return this;
  }

  /**
   * Add CTEs (Common Table Expressions) to the query
   */
  with(...ctes: DbCte<any>[]): SelectQueryBuilder<TRow> {
    return new SelectQueryBuilder(
      this.schema,
      this.client,
      (row: any) => row,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      false,
      this.schemaRegistry,  // Pass schema registry for nested navigation resolution
      ctes,
      this.collectionStrategy
    );
  }

  /**
   * Create mock row for analysis
   * @internal - Also used by DbEntityTable.props() to avoid code duplication
   */
  _createMockRow(): any {
    // Performance: Return cached mock if available
    if (this._cachedMockRow) {
      return this._cachedMockRow;
    }

    const mock: any = {};
    const tableAlias = this.schema.name;

    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.schema);

    // Performance: Lazy-cache FieldRef objects - only create when first accessed
    const fieldRefCache: Record<string, any> = {};

    // Build a mapper lookup for columns (only when needed)
    const columnMappers: Record<string, any> = {};
    for (const [colName, colBuilder] of Object.entries(this.schema.columns)) {
      const config = (colBuilder as any).build();
      if (config.mapper) {
        columnMappers[colName] = config.mapper;
      }
    }

    // Add columns as FieldRef objects - type-safe with property name and database column name
    for (const [colName, dbColumnName] of columnNameMap) {
      const mapper = columnMappers[colName];
      Object.defineProperty(mock, colName, {
        get() {
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,
              // Include mapper for toDriver transformation in conditions
              __mapper: mapper,
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Performance: Use pre-computed relation entries and cached schemas
    const relationEntries = getRelationEntriesForSchema(this.schema);

    // Add relations (both collections and single references)
    for (const [relName, relConfig] of relationEntries) {
      // Performance: Use cached target schema, but prefer registry lookup for full relations
      let targetSchema = this.schemaRegistry?.get(relConfig.targetTable);
      if (!targetSchema) {
        targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);
      }

      if (relConfig.type === 'many') {
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              this.schema.name,
              targetSchema,
              this.schemaRegistry  // Pass schema registry for nested navigation resolution
            );
          },
          enumerable: false,
          configurable: true,
        });
      } else {
        // Single reference navigation (many-to-one, one-to-one)
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow
        // with circular relations like User->Posts->User)
        Object.defineProperty(mock, relName, {
          get: () => {
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,
              this.schemaRegistry,  // Pass schema registry for nested navigation resolution
              [],  // Empty navigation path for first level navigation
              this.schema.name  // Pass source table name for lateral join correlation
            );
            return refBuilder.createMockTargetRow();
          },
          enumerable: false,
          configurable: true,
        });
      }
    }

    // Cache the mock for reuse
    this._cachedMockRow = mock;
    return mock;
  }

  /**
   * Add a LEFT JOIN to the query with a selector (supports both tables and subqueries)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  leftJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      // Delegate to SelectQueryBuilder which handles subquery joins
      const qb = new SelectQueryBuilder(
        this.schema,
        this.client,
        (row: any) => row as TRow,
        this.whereCond,
        this.limitValue,
        this.offsetValue,
        this.orderByFields,
        this.executor,
        this.manualJoins,
        this.joinCounter,
        false,  // isDistinct defaults to false
        undefined,  // schemaRegistry
        [],  // ctes
        this.collectionStrategy
      );
      return qb.leftJoinSubquery(rightTable, alias, condition as any, selector as any);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock rows for condition evaluation
    const mockLeft = this._createMockRow();
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);
    const joinCondition = condition(mockLeft, mockRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Store schemas for creating fresh mocks in the selector
    const leftSchema = this.schema;
    const createLeftMock = () => this._createMockRow();
    const createRightMock = () => this.createMockRowForTable(rightSchema, rightAlias);

    // Create a selector wrapper that generates fresh mocks and calls the user's selector
    const wrappedSelector = (row: any) => {
      // Create fresh mocks for the selector invocation
      const freshMockLeft = createLeftMock();
      const freshMockRight = createRightMock();
      return selector(freshMockLeft as TRow, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      wrappedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      false,  // isDistinct defaults to false
      undefined,  // schemaRegistry
      [],  // ctes
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TSelection>>;
  }

  /**
   * Add an INNER JOIN to the query with a selector (supports both tables and subqueries)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  innerJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TSelection>> {
    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      // Delegate to SelectQueryBuilder which handles subquery joins
      const qb = new SelectQueryBuilder(
        this.schema,
        this.client,
        (row: any) => row as TRow,
        this.whereCond,
        this.limitValue,
        this.offsetValue,
        this.orderByFields,
        this.executor,
        this.manualJoins,
        this.joinCounter,
        false,  // isDistinct defaults to false
        undefined,  // schemaRegistry
        [],  // ctes
        this.collectionStrategy
      );
      return qb.innerJoinSubquery(rightTable, alias, condition as any, selector as any);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock rows for condition evaluation
    const mockLeft = this._createMockRow();
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);
    const joinCondition = condition(mockLeft, mockRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'INNER' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Store schemas for creating fresh mocks in the selector
    const leftSchema = this.schema;
    const createLeftMock = () => this._createMockRow();
    const createRightMock = () => this.createMockRowForTable(rightSchema, rightAlias);

    // Create a selector wrapper that generates fresh mocks and calls the user's selector
    const wrappedSelector = (row: any) => {
      // Create fresh mocks for the selector invocation
      const freshMockLeft = createLeftMock();
      const freshMockRight = createRightMock();
      return selector(freshMockLeft as TRow, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      wrappedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      false,  // isDistinct defaults to false
      undefined,  // schemaRegistry
      [],  // ctes
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TSelection>>;
  }

  /**
   * Create mock row for a specific table/alias (for joins)
   */
  private createMockRowForTable(schema: TableSchema, alias: string): any {
    const mock: any = {};

    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(schema);

    // Performance: Lazy-cache FieldRef objects
    const fieldRefCache: Record<string, any> = {};

    // Add columns as FieldRef objects with table alias
    for (const [colName, dbColumnName] of columnNameMap) {
      Object.defineProperty(mock, colName, {
        get() {
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: alias,
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Performance: Use pre-computed relation entries and cached schemas
    const relationEntries = getRelationEntriesForSchema(schema);

    // Add navigation properties (single references and collections)
    for (const [relName, relConfig] of relationEntries) {
      // Performance: Use cached target schema
      const targetSchema = getTargetSchemaForRelation(schema, relName, relConfig);

      if (relConfig.type === 'many') {
        // Collection navigation
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              schema.name,
              targetSchema
            );
          },
          enumerable: false,
          configurable: true,
        });
      } else {
        // Single reference navigation
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,
              this.schemaRegistry,  // Pass schema registry for nested navigation resolution
              [],  // Empty navigation path for first level navigation
              schema.name  // Pass source table name for lateral join correlation
            );
            return refBuilder.createMockTargetRow();
          },
          enumerable: false,
          configurable: true,
        });
      }
    }

    return mock;
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Offset results
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Order by field(s)
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (row: TRow) => T): this;
  orderBy<T>(selector: (row: TRow) => T[]): this;
  orderBy<T>(selector: (row: TRow) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TRow) => OrderByResult<T>): this {
    const mockRow = this._createMockRow();
    const result = selector(mockRow);
    parseOrderBy(result, this.orderByFields);
    return this;
  }
}

/**
 * Select query builder with nested collection support
 */
export class SelectQueryBuilder<TSelection> {
  private schema: TableSchema;
  private client: DatabaseClient;
  private selector: (row: any) => TSelection;
  private whereCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;
  private isDistinct: boolean = false;
  private schemaRegistry?: Map<string, TableSchema>;
  private ctes: DbCte<any>[] = [];  // Track CTEs attached to this query
  private collectionStrategy?: CollectionStrategyType;

  /**
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(tableName: string, schema?: string): string {
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    selector: (row: any) => TSelection,
    whereCond?: Condition,
    limit?: number,
    offset?: number,
    orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC' }>,
    executor?: QueryExecutor,
    manualJoins?: ManualJoinDefinition[],
    joinCounter?: number,
    isDistinct?: boolean,
    schemaRegistry?: Map<string, TableSchema>,
    ctes?: DbCte<any>[],
    collectionStrategy?: CollectionStrategyType
  ) {
    this.schema = schema;
    this.client = client;
    this.selector = selector;
    this.whereCond = whereCond;
    this.limitValue = limit;
    this.offsetValue = offset;
    this.orderByFields = orderBy || [];
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
    this.isDistinct = isDistinct || false;
    this.schemaRegistry = schemaRegistry;
    this.ctes = ctes || [];
    this.collectionStrategy = collectionStrategy;
  }

  /**
   * Transform the selection with a new selector
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  select<TNewSelection>(selector: (row: TSelection) => TNewSelection): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    // Create a composed selector that applies both transformations
    const composedSelector = (row: any) => {
      const firstResult = this.selector(row);
      return selector(firstResult);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add WHERE condition
   * Multiple where() calls are chained with AND logic
   * Note: The row parameter represents the selected shape (after select())
   */
  where(condition: (row: any) => Condition): this {
    const mockRow = this._createMockRow();
    // Apply the selector to get the selected shape that the user sees in the WHERE condition
    const selectedMock = this.selector(mockRow);
    // Wrap in proxy - for WHERE, we preserve original column names
    const fieldRefProxy = this.createFieldRefProxy(selectedMock, true);
    const newCondition = condition(fieldRefProxy);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
    }
    return this;
  }

  /**
   * Attach one or more CTEs to this query
   *
   * @example
   * const result = await db.users
   *   .where(u => eq(u.id, 1))
   *   .with(activeUsersCte.cte)
   *   .leftJoin(activeUsersCte.cte, ...)
   *   .toList();
   */
  with(...ctes: DbCte<any>[]): this {
    // Add CTEs, avoiding duplicates by name
    for (const cte of ctes) {
      if (!this.ctes.some(existing => existing.name === cte.name)) {
        this.ctes.push(cte);
      }
    }
    return this;
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Offset results
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Order by field(s)
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockRow = this._createMockRow();
    const selectedMock = this.selector(mockRow);
    // Wrap selectedMock in a proxy that returns FieldRefs for property access
    const fieldRefProxy = this.createFieldRefProxy(selectedMock);
    const result = selector(fieldRefProxy);

    // Clear previous orderBy - last one takes precedence
    this.orderByFields = [];
    parseOrderBy(result, this.orderByFields);

    return this;
  }

  /**
   * Group by fields - returns a GroupedQueryBuilder for type-safe aggregations
   * @param selector Function that selects the grouping key from the current selection
   * @example
   * db.users
   *   .select(u => ({ id: u.id, street: u.address.street, name: u.name }))
   *   .groupBy(p => ({ street: p.street }))
   *   .select(g => ({ street: g.key.street, count: g.count() }))
   */
  groupBy<TGroupingKey>(
    selector: (row: TSelection) => TGroupingKey
  ): GroupedQueryBuilder<TSelection, TGroupingKey> {
    return new GroupedQueryBuilder(
      this.schema,
      this.client,
      this.selector,
      selector,
      this.whereCond,
      this.executor,
      this.manualJoins,
      this.joinCounter
    );
  }

  /**
   * Add a LEFT JOIN with a subquery
   * @param subquery The subquery to join (must be 'table' mode)
   * @param alias Alias for the subquery in the FROM clause
   * @param condition Join condition
   * @param selector Result selector
   */
  leftJoinSubquery<TSubqueryResult, TNewSelection>(
    subquery: Subquery<TSubqueryResult, 'table'>,
    alias: string,
    condition: (left: TSelection, right: TSubqueryResult) => Condition,
    selector: (left: TSelection, right: TSubqueryResult) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = this.selector(mockRow);

    // Create mock for the subquery result (right side)
    // For subqueries, we create a mock based on the result type
    const mockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight);

    // Store the subquery join info
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: `(${subquery.buildSql({ paramCounter: 0, params: [] })})`, // This will be rebuilt properly
      alias: alias,
      schema: null as any, // Subqueries don't have schema
      condition: joinCondition,
      isSubquery: true,
      subquery: subquery,
    } as any];

    // Create a new selector
    const composedSelector = (row: any) => {
      const leftResult = this.selector(row);
      const freshMockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);
      return selector(leftResult as TSelection, freshMockRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add a LEFT JOIN to the query with a selector
   * Note: After select(), the left parameter in the join will be the selected shape (TSelection)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  // Overload for CTE
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  // Overload for Subquery
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: Subquery<TRight, 'table'>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  // Overload for Table
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema },
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  // Implementation
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    // Check if rightTable is a CTE
    if (isCte(rightTable)) {
      return this.leftJoinCte(rightTable, condition, selector);
    }

    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      return this.leftJoinSubquery(rightTable, alias, condition, selector);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    // IMPORTANT: We call the selector with the mock row to get a result that contains FieldRef objects
    const mockRow = this._createMockRow();
    const mockLeftSelection = this.selector(mockRow);

    // The mockLeftSelection now contains FieldRef objects (with __fieldName, __dbColumnName, __tableAlias)
    // These FieldRef objects preserve the table context

    // Create mock for the right table
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);

    // Evaluate the join condition - the mockLeftSelection has FieldRef objects,
    // so the condition can properly reference table aliases
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight as TRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Create a new selector that first applies the current selector, then the new selector
    const composedSelector = (row: any) => {
      const leftResult = this.selector(row);
      const freshMockRight = this.createMockRowForTable(rightSchema, rightAlias);
      return selector(leftResult as TSelection, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add a LEFT JOIN with a CTE
   */
  private leftJoinCte<TRight extends Record<string, any>, TNewSelection>(
    cte: DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = this.selector(mockRow);

    // Create mock for the CTE columns (right side)
    const mockRight = this.createMockRowForCte(cte);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight as TRight);

    // Add the CTE join
    const updatedJoins = [...this.manualJoins, {
      type: 'LEFT' as JoinType,
      table: cte.name,
      alias: cte.name,
      schema: null as any,
      condition: joinCondition,
      cte: cte,
    }];

    // Create a new selector
    const composedSelector = (row: any) => {
      const leftResult = this.selector(row);
      const freshMockRight = this.createMockRowForCte(cte);
      return selector(leftResult as TSelection, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add an INNER JOIN with a subquery
   * @param subquery The subquery to join (must be 'table' mode)
   * @param alias Alias for the subquery in the FROM clause
   * @param condition Join condition
   * @param selector Result selector
   */
  innerJoinSubquery<TSubqueryResult, TNewSelection>(
    subquery: Subquery<TSubqueryResult, 'table'>,
    alias: string,
    condition: (left: TSelection, right: TSubqueryResult) => Condition,
    selector: (left: TSelection, right: TSubqueryResult) => TNewSelection
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = this.selector(mockRow);

    // Create mock for the subquery result (right side)
    const mockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight);

    // Store the subquery join info
    const updatedJoins = [...this.manualJoins, {
      type: 'INNER' as JoinType,
      table: `(${subquery.buildSql({ paramCounter: 0, params: [] })})`,
      alias: alias,
      schema: null as any,
      condition: joinCondition,
      isSubquery: true,
      subquery: subquery,
    } as any];

    // Create a new selector
    const composedSelector = (row: any) => {
      const leftResult = this.selector(row);
      const freshMockRight = this.createMockRowForSubquery<TSubqueryResult>(alias, subquery);
      return selector(leftResult as TSelection, freshMockRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Add an INNER JOIN to the query with a selector
   * Note: After select(), the left parameter in the join will be the selected shape (TSelection)
   * UnwrapSelection extracts the value types from SqlFragment<T> expressions
   */
  innerJoin<TRight, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<UnwrapSelection<TNewSelection>> {
    // Check if rightTable is a Subquery
    if (rightTable instanceof Subquery) {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      return this.innerJoinSubquery(rightTable, alias, condition, selector);
    }

    const rightSchema = rightTable._getSchema();
    // Generate unique alias using join counter
    const rightAlias = `${rightSchema.name}_${this.joinCounter}`;
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this._createMockRow();
    const mockLeftSelection = this.selector(mockRow);

    // Create mock for the right table
    const mockRight = this.createMockRowForTable(rightSchema, rightAlias);

    // Evaluate the join condition
    const joinCondition = condition(mockLeftSelection as TSelection, mockRight as TRight);

    // Add the join to the list
    const updatedJoins = [...this.manualJoins, {
      type: 'INNER' as JoinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    }];

    // Create a new selector that first applies the current selector, then the new selector
    const composedSelector = (row: any) => {
      const leftResult = this.selector(row);
      const freshMockRight = this.createMockRowForTable(rightSchema, rightAlias);
      return selector(leftResult as TSelection, freshMockRight as TRight);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      updatedJoins,
      newJoinCounter,
      this.isDistinct,
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    ) as SelectQueryBuilder<UnwrapSelection<TNewSelection>>;
  }

  /**
   * Create mock row for a specific table/alias (for joins)
   */
  private createMockRowForTable(schema: TableSchema, alias: string): any {
    const mock: any = {};

    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(schema);

    // Performance: Lazy-cache FieldRef objects
    const fieldRefCache: Record<string, any> = {};

    // Add columns as FieldRef objects with table alias
    for (const [colName, dbColumnName] of columnNameMap) {
      Object.defineProperty(mock, colName, {
        get() {
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: alias,
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Performance: Use pre-computed relation entries and cached schemas
    const relationEntries = getRelationEntriesForSchema(schema);

    // Add navigation properties (single references and collections)
    for (const [relName, relConfig] of relationEntries) {
      // Performance: Use cached target schema
      const targetSchema = getTargetSchemaForRelation(schema, relName, relConfig);

      if (relConfig.type === 'many') {
        // Collection navigation
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              schema.name,
              targetSchema
            );
          },
          enumerable: false,
          configurable: true,
        });
      } else {
        // Single reference navigation
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,
              this.schemaRegistry,  // Pass schema registry for nested navigation resolution
              [],  // Empty navigation path for first level navigation
              schema.name  // Pass source table name for lateral join correlation
            );
            return refBuilder.createMockTargetRow();
          },
          enumerable: false,
          configurable: true,
        });
      }
    }

    return mock;
  }

  /**
   * Create mock row for a subquery result (for subquery joins)
   * The subquery result type defines the shape - we create FieldRefs for each property
   */
  private createMockRowForSubquery<TSubqueryResult>(alias: string, subquery?: Subquery<TSubqueryResult, 'table'>): TSubqueryResult {
    const mock: any = {};

    // Get selection metadata from subquery if available
    const selectionMetadata = subquery?.getSelectionMetadata();

    // We need to infer the structure from TSubqueryResult
    // Since we can't iterate over a type at runtime, we create a proxy that
    // returns FieldRefs for any property access
    return new Proxy(mock, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        // If we have selection metadata, check if this property has a mapper
        if (selectionMetadata && prop in selectionMetadata) {
          const value = selectionMetadata[prop];

          // If it's a SqlFragment with a mapper, preserve it
          if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
            // Create a SqlFragment-like object that preserves the mapper
            return {
              __fieldName: prop,
              __dbColumnName: prop,
              __tableAlias: alias,
              getMapper: () => (value as any).getMapper(),
            };
          }
        }

        // Return a regular FieldRef for any property accessed
        return {
          __fieldName: prop,
          __dbColumnName: prop, // Assume property name matches column name
          __tableAlias: alias,
        };
      },
      has(target, prop) {
        return true; // All properties "exist"
      },
      ownKeys(target) {
        return []; // We don't know the keys ahead of time
      },
      getOwnPropertyDescriptor(target, prop) {
        return {
          enumerable: true,
          configurable: true,
        };
      }
    }) as TSubqueryResult;
  }

  /**
   * Create a mock row for CTE columns
   */
  private createMockRowForCte<TCteColumns extends Record<string, any>>(cte: DbCte<TCteColumns>): TCteColumns {
    const mock: any = {};

    // Create a proxy that returns FieldRefs for CTE columns
    return new Proxy(mock, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        // If we have selection metadata, check if this property has a mapper or is an aggregation array
        if (cte.selectionMetadata && prop in cte.selectionMetadata) {
          const value = cte.selectionMetadata[prop];

          // If it's a SqlFragment with a mapper, preserve it
          if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
            // Create a SqlFragment-like object that preserves the mapper
            return {
              __fieldName: prop,
              __dbColumnName: prop,
              __tableAlias: cte.name,
              getMapper: () => (value as any).getMapper(),
            };
          }

          // If it's a CTE aggregation array marker, preserve it with inner metadata
          if (typeof value === 'object' && value !== null && '__isAggregationArray' in value && (value as any).__isAggregationArray) {
            return {
              __fieldName: prop,
              __dbColumnName: prop,
              __tableAlias: cte.name,
              __isAggregationArray: true,
              __innerSelectionMetadata: (value as any).__innerSelectionMetadata,
            };
          }
        }

        // Return a regular FieldRef for any property accessed
        return {
          __fieldName: prop,
          __dbColumnName: prop,
          __tableAlias: cte.name,
        };
      },
      has(target, prop) {
        return true;
      },
      ownKeys(target) {
        return cte.columnDefs ? Object.keys(cte.columnDefs) : [];
      },
      getOwnPropertyDescriptor(target, prop) {
        return {
          enumerable: true,
          configurable: true,
        };
      }
    }) as TCteColumns;
  }

  /**
   * Select distinct rows
   */
  selectDistinct<TNewSelection>(selector: (row: TSelection) => TNewSelection): SelectQueryBuilder<TNewSelection> {
    const composedSelector = (row: any) => {
      const firstResult = this.selector(row);
      return selector(firstResult);
    };

    return new SelectQueryBuilder(
      this.schema,
      this.client,
      composedSelector,
      this.whereCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      true,  // Set isDistinct to true
      this.schemaRegistry,
      this.ctes,
      this.collectionStrategy
    );
  }

  /**
   * Get minimum value from the query
   */
  async min<TResult = TSelection>(selector?: (row: TSelection) => TResult): Promise<TResult | null> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    // If selector is provided, apply it to determine the field
    let fieldToAggregate: any;
    if (selector) {
      const mockRow = this._createMockRow();
      const mockSelection = this.selector(mockRow);
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this._createMockRow();
      fieldToAggregate = this.selector(mockRow);
    }

    // Build aggregation query
    const { sql, params } = this.buildAggregationQuery('MIN', fieldToAggregate, context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.result ?? null;
  }

  /**
   * Get maximum value from the query
   */
  async max<TResult = TSelection>(selector?: (row: TSelection) => TResult): Promise<TResult | null> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    // If selector is provided, apply it to determine the field
    let fieldToAggregate: any;
    if (selector) {
      const mockRow = this._createMockRow();
      const mockSelection = this.selector(mockRow);
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this._createMockRow();
      fieldToAggregate = this.selector(mockRow);
    }

    // Build aggregation query
    const { sql, params } = this.buildAggregationQuery('MAX', fieldToAggregate, context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.result ?? null;
  }

  /**
   * Get sum of values from the query
   */
  async sum<TResult = TSelection>(selector?: (row: TSelection) => TResult): Promise<TResult | null> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    // If selector is provided, apply it to determine the field
    let fieldToAggregate: any;
    if (selector) {
      const mockRow = this._createMockRow();
      const mockSelection = this.selector(mockRow);
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this._createMockRow();
      fieldToAggregate = this.selector(mockRow);
    }

    // Build aggregation query
    const { sql, params } = this.buildAggregationQuery('SUM', fieldToAggregate, context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.result ?? null;
  }

  /**
   * Get count of rows from the query
   */
  async count(): Promise<number> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    const { sql, params } = this.buildAggregateQuery(context, 'count');

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Check if any rows match the query
   * More efficient than count() > 0 as it can stop after finding one row
   */
  async exists(): Promise<boolean> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    const { sql, params } = this.buildAggregateQuery(context, 'exists');

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows[0]?.exists === true;
  }

  /**
   * Combine this query with another using UNION (removes duplicates)
   *
   * @param query Another SelectQueryBuilder with compatible selection type
   * @returns A UnionQueryBuilder for further chaining
   *
   * @example
   * ```typescript
   * const result = await db.users
   *   .select(u => ({ id: u.id, name: u.name }))
   *   .union(db.customers.select(c => ({ id: c.id, name: c.name })))
   *   .orderBy(r => r.name)
   *   .toList();
   * ```
   */
  union(query: SelectQueryBuilder<TSelection>): UnionQueryBuilder<TSelection> {
    const unionBuilder = new UnionQueryBuilder<TSelection>(this, this.client, this.executor);
    return unionBuilder.union(query);
  }

  /**
   * Combine this query with another using UNION ALL (keeps all rows including duplicates)
   *
   * @param query Another SelectQueryBuilder with compatible selection type
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
  unionAll(query: SelectQueryBuilder<TSelection>): UnionQueryBuilder<TSelection> {
    const unionBuilder = new UnionQueryBuilder<TSelection>(this, this.client, this.executor);
    return unionBuilder.unionAll(query);
  }

  /**
   * Build SQL for use in UNION queries (without ORDER BY, LIMIT, OFFSET)
   * @internal Used by UnionQueryBuilder
   */
  buildUnionSql(context: SqlBuildContext): string {
    const queryContext: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: context.paramCounter,
      allParams: context.params,
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    const mockRow = this._createMockRow();
    const selectionResult = this.selector(mockRow);

    // Build query without ORDER BY, LIMIT, OFFSET for union component
    const { sql } = this.buildQueryCore(selectionResult, queryContext, false);

    // Update context's param counter
    context.paramCounter = queryContext.paramCounter;

    return sql;
  }

  /**
   * Create a future query that will be executed later.
   * Use with FutureQueryRunner.runAsync() for batch execution.
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
  future(): FutureQuery<ResolveCollectionResults<TSelection>> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    const mockRow = this._createMockRow();
    const selectionResult = this.selector(mockRow);
    const { sql, params, nestedPaths } = this.buildQuery(selectionResult, context);

    // Create transform function that captures current state
    const transformFn = (rows: any[]): ResolveCollectionResults<TSelection>[] => {
      if (rows.length === 0) return [];

      // Reconstruct nested objects if needed
      let processedRows = rows;
      if (nestedPaths.size > 0) {
        processedRows = rows.map(row => this.reconstructNestedObjects(row, nestedPaths));
      }

      return this.transformResults(processedRows, selectionResult) as ResolveCollectionResults<TSelection>[];
    };

    return new FutureQuery<ResolveCollectionResults<TSelection>>(
      sql,
      params,
      transformFn,
      this.client,
      this.executor
    );
  }

  /**
   * Create a future query that returns a single result or null.
   * Use with FutureQueryRunner.runAsync() for batch execution.
   *
   * @returns A FutureSingleQuery that resolves to a single result or null
   *
   * @example
   * ```typescript
   * const q1 = db.users.where(u => eq(u.id, 1)).select(u => u).futureFirstOrDefault();
   * const q2 = db.posts.where(p => eq(p.id, 5)).select(p => p).futureFirstOrDefault();
   *
   * const [user, post] = await FutureQueryRunner.runAsync([q1, q2]);
   * // user: User | null
   * // post: Post | null
   * ```
   */
  futureFirstOrDefault(): FutureSingleQuery<ResolveCollectionResults<TSelection>> {
    // Apply LIMIT 1 for efficiency
    const originalLimit = this.limitValue;
    this.limitValue = 1;

    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    const mockRow = this._createMockRow();
    const selectionResult = this.selector(mockRow);
    const { sql, params, nestedPaths } = this.buildQuery(selectionResult, context);

    // Restore original limit
    this.limitValue = originalLimit;

    // Create transform function
    const transformFn = (rows: any[]): ResolveCollectionResults<TSelection>[] => {
      if (rows.length === 0) return [];

      let processedRows = rows;
      if (nestedPaths.size > 0) {
        processedRows = rows.map(row => this.reconstructNestedObjects(row, nestedPaths));
      }

      return this.transformResults(processedRows, selectionResult) as ResolveCollectionResults<TSelection>[];
    };

    return new FutureSingleQuery<ResolveCollectionResults<TSelection>>(
      sql,
      params,
      transformFn,
      this.client,
      this.executor
    );
  }

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
   * const q3 = db.comments.where(c => eq(c.isPublished, true)).futureCount();
   *
   * const [userCount, postCount, commentCount] = await FutureQueryRunner.runAsync([q1, q2, q3]);
   * ```
   */
  futureCount(): FutureCountQuery {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      executor: this.executor,
    };

    const { sql, params } = this.buildAggregateQuery(context, 'count');

    return new FutureCountQuery(sql, params, this.client, this.executor);
  }

  /**
   * Execute query and return results as array
   * Collection results are automatically resolved to arrays
   */
  async toList(): Promise<ResolveCollectionResults<TSelection>[]> {
    const options = this.executor?.getOptions();
    const tracer = new TimeTracer(options?.traceTime ?? false, options?.logger);

    // Query Build Phase
    tracer.startPhase('queryBuild');

    const context: QueryContext = tracer.trace('createContext', () => ({
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    }));

    // Analyze the selector to extract nested queries
    const mockRow = tracer.trace('createMockRow', () => this._createMockRow());
    const selectionResult = tracer.trace('evaluateSelector', () => this.selector(mockRow));

    // Check if we're using temp table strategy and have collections
    const collections = tracer.trace('detectCollections', () => this.detectCollections(selectionResult));
    const useTempTableStrategy = this.collectionStrategy === 'temptable' && collections.length > 0;

    tracer.endPhase();

    let results: any[];
    if (useTempTableStrategy) {
      // Two-phase execution for temp table strategy
      results = await this.executeWithTempTables(selectionResult, context, collections, tracer);
    } else {
      // Single-phase execution for JSONB strategy (current behavior)
      results = await this.executeSinglePhase(selectionResult, context, tracer);
    }

    // Log trace summary if tracing is enabled
    tracer.logSummary(results.length);

    return results;
  }

  /**
   * Execute query using single-phase approach (JSONB/CTE strategy)
   */
  private async executeSinglePhase(selectionResult: any, context: QueryContext, tracer: TimeTracer): Promise<any[]> {
    // Build the query
    tracer.startPhase('queryBuild');
    const { sql, params, nestedPaths } = tracer.trace('buildQuery', () => this.buildQuery(selectionResult, context));
    tracer.endPhase();

    // Execute using executor if available, otherwise use client directly
    tracer.startPhase('queryExecution');
    const result = await tracer.traceAsync('executeQuery', async () =>
      this.executor
        ? await this.executor.query(sql, params)
        : await this.client.query(sql, params),
      { rowCount: 'pending' }
    );
    tracer.endPhase();

    // If rawResult is enabled, return raw rows without any processing
    if (this.executor?.getOptions().rawResult) {
      return result.rows;
    }

    // Reconstruct nested objects from flat row data (if any)
    tracer.startPhase('resultProcessing');
    let rows = result.rows;
    if (nestedPaths.size > 0) {
      rows = tracer.trace('reconstructNestedObjects', () =>
        rows.map(row => this.reconstructNestedObjects(row, nestedPaths)),
        { rowCount: rows.length }
      );
    }

    // Transform results
    const transformed = tracer.trace('transformResults', () =>
      this.transformResults(rows, selectionResult),
      { rowCount: rows.length }
    );
    tracer.endPhase();

    return transformed as any;
  }

  /**
   * Execute query using two-phase approach (temp table strategy)
   */
  private async executeWithTempTables(
    selectionResult: any,
    context: QueryContext,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    tracer: TimeTracer
  ): Promise<any[]> {
    // Build base selection (excludes collections, includes foreign keys)
    tracer.startPhase('queryBuild');
    const baseSelection = tracer.trace('buildBaseSelection', () =>
      this.buildBaseSelection(selectionResult, collections)
    );
    const { sql: baseSql, params: baseParams } = tracer.trace('buildBaseQuery', () =>
      this.buildQuery(baseSelection, {
        ...context,
        ctes: new Map(), // Clear CTEs since we're not using them for collections
      })
    );
    tracer.endPhase();

    // Check if we can use fully optimized single-query approach
    // Requirements: PostgresClient with querySimpleMulti support AND no parameters in base query
    const canUseFullOptimization =
      this.client.supportsMultiStatementQueries() &&
      baseParams.length === 0 &&
      collections.length > 0;

    if (canUseFullOptimization) {
      return this.executeFullyOptimized(baseSql, baseSelection, selectionResult, context, collections, tracer);
    }

    // Legacy two-phase approach: execute base query first
    tracer.startPhase('queryExecution');
    const baseResult = await tracer.traceAsync('executeBaseQuery', async () =>
      this.executor
        ? await this.executor.query(baseSql, baseParams)
        : await this.client.query(baseSql, baseParams)
    );

    // If rawResult is enabled, return raw rows without any processing
    if (this.executor?.getOptions().rawResult) {
      tracer.endPhase();
      return baseResult.rows;
    }

    if (baseResult.rows.length === 0) {
      tracer.endPhase();
      return [];
    }

    // Extract parent IDs from base results (using the known alias we added in buildBaseSelection)
    const parentIds = baseResult.rows.map(row => row.__pk_id);

    // Phase 2: Execute collection aggregations using temp tables
    // For each collection, call buildCTE with parent IDs
    const collectionResults = new Map<string, Map<number, any>>();

    for (const collection of collections) {
      const builder = collection.builder;

      // Call buildCTE with parent IDs - this will use the temp table strategy
      const aggResult = await tracer.traceAsync(`buildCTE:${collection.name}`, async () =>
        builder.buildCTE(context, this.client, parentIds)
      );

      // aggResult is a Promise<CollectionAggregationResult> for temp table strategy
      const result = await (aggResult as any as Promise<any>);

      // If the result has a tableName, it means temp tables were created and we need to query them
      if (result.tableName && !result.isCTE) {
        // Check if data was already fetched (multi-statement optimization)
        if (result.dataFetched && result.data) {
          // Data already fetched - use it directly
          collectionResults.set(collection.name, result.data);
        } else {
          // Temp table strategy (legacy) - query the aggregation table
          const aggQuery = `SELECT parent_id, data FROM ${result.tableName}`;
          const aggQueryResult = await tracer.traceAsync(`queryCollection:${collection.name}`, async () =>
            this.executor
              ? await this.executor.query(aggQuery, [])
              : await this.client.query(aggQuery, [])
          );

          // Cleanup temp tables if needed
          if (result.cleanupSql) {
            await this.client.query(result.cleanupSql);
          }

          // Index results by parent_id for merging
          const resultMap = new Map<number, any>();
          for (const row of aggQueryResult.rows) {
            resultMap.set(row.parent_id, row.data);
          }
          collectionResults.set(collection.name, resultMap);
        }
      } else {
        // CTE strategy (shouldn't happen in temp table mode, but handle it)
        throw new Error('Expected temp table result but got CTE');
      }
    }
    tracer.endPhase();

    // Phase 3: Merge base results with collection results
    tracer.startPhase('resultProcessing');
    const mergedRows = tracer.trace('mergeResults', () =>
      baseResult.rows.map(baseRow => {
        const merged = { ...baseRow };
        for (const collection of collections) {
          const resultMap = collectionResults.get(collection.name);
          const parentId = baseRow.__pk_id;
          const rawData = resultMap?.get(parentId);

          // Check if this is a single result (firstOrDefault) - return first item or null
          const isSingleResult = collection.builder.isSingleResult();
          let collectionData: any;

          if (isSingleResult) {
            // For single results, rawData might already be an object (from temp table strategy)
            // or might be an array (from other strategies) that we need to extract the first item from
            if (rawData === undefined || rawData === null) {
              collectionData = null;
            } else if (Array.isArray(rawData)) {
              collectionData = rawData.length > 0 ? rawData[0] : null;
            } else {
              // Already a single object
              collectionData = rawData;
            }
          } else {
            // For list results, ensure we return an array
            collectionData = rawData || this.getDefaultValueForCollection(collection.builder);
          }

          // Handle nested paths
          if (collection.path.length > 0) {
            // Navigate to the nested object and set the collection there
            let current = merged;
            for (let i = 0; i < collection.path.length; i++) {
              const pathPart = collection.path[i];
              if (!(pathPart in current)) {
                current[pathPart] = {};
              }
              current = current[pathPart];
            }
            current[collection.name] = collectionData;
          } else {
            merged[collection.name] = collectionData;
          }
        }
        // Remove the internal __pk_id field before returning
        delete merged.__pk_id;
        return merged;
      }),
      { rowCount: baseResult.rows.length }
    );

    // Transform results using the original selection
    const transformed = tracer.trace('transformResults', () =>
      this.transformResults(mergedRows, selectionResult),
      { rowCount: mergedRows.length }
    );
    tracer.endPhase();

    return transformed as any;
  }

  /**
   * Execute using fully optimized single-query approach (PostgresClient only)
   * Combines base query + all collections into ONE multi-statement query
   */
  private async executeFullyOptimized(
    baseSql: string,
    baseSelection: any,
    selectionResult: any,
    context: QueryContext,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    tracer: TimeTracer
  ): Promise<any[]> {
    tracer.startPhase('queryBuild');
    const baseTempTable = `tmp_base_${context.cteCounter++}`;

    // Build SQL for each collection
    const collectionSQLs: string[] = tracer.trace('buildCollectionSQLs', () => {
      const sqls: string[] = [];
      for (const collection of collections) {
        const builderAny = collection.builder as any;
        const targetTable = builderAny.targetTable;
        const foreignKey = builderAny.foreignKey;
        const selector = builderAny.selector;
        const orderByFields = builderAny.orderByFields || [];

        // Build selected fields
        let selectedFieldsSQL = '';
        if (selector) {
          const mockItem = builderAny.createMockItem();
          const selectedFields = selector(mockItem);

          const fieldParts: string[] = [];
          for (const [alias, field] of Object.entries(selectedFields)) {
            if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
              const dbColumnName = (field as any).__dbColumnName;
              fieldParts.push(`"${dbColumnName}" as "${alias}"`);
            }
          }
          selectedFieldsSQL = fieldParts.join(', ');
        }

        // Build ORDER BY
        let orderBySQL: string;
        const targetSchema = builderAny.targetTableSchema;
        if (orderByFields.length > 0) {
          const colNameMap = targetSchema ? getColumnNameMapForSchema(targetSchema) : null;
          orderBySQL = ` ORDER BY ${orderByFields.map(({ field, direction }: any) => {
            const dbColumnName = colNameMap?.get(field) ?? field;
            return `"${dbColumnName}" ${direction}`;
          }).join(', ')}`;
        } else {
          // Find primary key column from schema, fallback to "id" if not found
          let pkColumn: string = null as any;
          if (targetSchema) {
            for (const colBuilder of Object.values(targetSchema.columns)) {
              const config = (colBuilder as any).build();
              if (config.primaryKey) {
                pkColumn = config.name;
                break;
              }
            }
          }

          if (pkColumn) {
            orderBySQL = ` ORDER BY "${pkColumn}" DESC`;
          } else {
            orderBySQL = ' ';
          }
        }

        const collectionSQL = `SELECT "${foreignKey}" as parent_id, ${selectedFieldsSQL} FROM "${targetTable}" WHERE "${foreignKey}" IN (SELECT "__pk_id" FROM ${baseTempTable})${orderBySQL}`;
        sqls.push(collectionSQL);
      }
      return sqls;
    });

    // Build mega multi-statement SQL
    const multiStatementSQL = tracer.trace('buildMultiStatement', () => {
      const statements = [
        `CREATE TEMP TABLE ${baseTempTable} AS ${baseSql}`,
        `SELECT * FROM ${baseTempTable}`,
        ...collectionSQLs,
        `DROP TABLE IF EXISTS ${baseTempTable}`
      ];
      return statements.join(';\n');
    });
    tracer.endPhase();

    // Execute via querySimpleMulti
    tracer.startPhase('queryExecution');
    const executor = this.executor || this.client;
    let resultSets: QueryResult[];

    if ('querySimpleMulti' in executor && typeof (executor as any).querySimpleMulti === 'function') {
      resultSets = await tracer.traceAsync('executeMultiStatement', async () =>
        (executor as any).querySimpleMulti(multiStatementSQL)
      );
    } else {
      throw new Error('Fully optimized mode requires querySimpleMulti support');
    }
    tracer.endPhase();

    // Parse result sets: [0]=CREATE, [1]=base, [2..N]=collections, [N+1]=DROP
    const baseResult = resultSets[1];

    // If rawResult is enabled, return raw rows without any processing
    if (this.executor?.getOptions().rawResult) {
      return baseResult?.rows || [];
    }

    if (!baseResult || baseResult.rows.length === 0) {
      return [];
    }

    // Result processing phase
    tracer.startPhase('resultProcessing');

    // Group collection results by parent_id
    const collectionResults = tracer.trace('groupCollectionResults', () => {
      const results = new Map<string, Map<number, any>>();
      collections.forEach((collection, idx) => {
        const collectionResultSet = resultSets[2 + idx];
        const dataMap = new Map<number, any>();

        for (const row of collectionResultSet.rows) {
          const parentId = row.parent_id;
          if (!dataMap.has(parentId)) {
            dataMap.set(parentId, []);
          }
          const { parent_id, ...rowData } = row;
          dataMap.get(parentId)!.push(rowData);
        }

        results.set(collection.name, dataMap);
      });
      return results;
    });

    // Merge base results with collection results
    const mergedRows = tracer.trace('mergeResults', () =>
      baseResult.rows.map((baseRow: any) => {
        const merged = { ...baseRow };
        for (const collection of collections) {
          const resultMap = collectionResults.get(collection.name);
          const parentId = baseRow.__pk_id;
          const rawData = resultMap?.get(parentId);

          // Check if this is a single result (firstOrDefault) - return first item or null
          const isSingleResult = collection.builder.isSingleResult();
          let collectionData: any;

          if (isSingleResult) {
            // For single results, rawData might already be an object (from temp table strategy)
            // or might be an array (from other strategies) that we need to extract the first item from
            if (rawData === undefined || rawData === null) {
              collectionData = null;
            } else if (Array.isArray(rawData)) {
              collectionData = rawData.length > 0 ? rawData[0] : null;
            } else {
              // Already a single object
              collectionData = rawData;
            }
          } else {
            // For list results, ensure we return an array
            collectionData = rawData || [];
          }

          // Handle nested paths
          if (collection.path.length > 0) {
            // Navigate to the nested object and set the collection there
            let current = merged;
            for (let i = 0; i < collection.path.length; i++) {
              const pathPart = collection.path[i];
              if (!(pathPart in current)) {
                current[pathPart] = {};
              }
              current = current[pathPart];
            }
            current[collection.name] = collectionData;
          } else {
            merged[collection.name] = collectionData;
          }
        }
        delete merged.__pk_id;
        return merged;
      }),
      { rowCount: baseResult.rows.length }
    );

    const transformed = tracer.trace('transformResults', () =>
      this.transformResults(mergedRows, selectionResult),
      { rowCount: mergedRows.length }
    );
    tracer.endPhase();

    return transformed as any;
  }

  /**
   * Detect collections in the selection result, including nested objects.
   * Returns collections with path information for proper result reconstruction.
   */
  private detectCollections(selection: any): Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }> {
    const collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }> = [];
    this.detectCollectionsRecursive(selection, [], collections);
    return collections;
  }

  /**
   * Recursively detect collections in nested objects
   */
  private detectCollectionsRecursive(
    selection: any,
    currentPath: string[],
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>
  ): void {
    if (typeof selection !== 'object' || selection === null || selection instanceof SqlFragment) {
      return;
    }

    for (const [key, value] of Object.entries(selection)) {
      if (value instanceof CollectionQueryBuilder) {
        collections.push({ name: key, path: [...currentPath], builder: value });
      } else if (value && typeof value === 'object' && '__collectionResult' in value && 'buildCTE' in value) {
        // This is a CollectionResult which wraps a CollectionQueryBuilder
        collections.push({ name: key, path: [...currentPath], builder: value as any as CollectionQueryBuilder<any> });
      } else if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value)) {
        // Recursively check nested objects (but not FieldRefs or arrays)
        this.detectCollectionsRecursive(value, [...currentPath, key], collections);
      }
    }
  }

  /**
   * Build base selection excluding collections but including necessary foreign keys.
   * Handles nested collections by removing them from nested structures.
   */
  private buildBaseSelection(selection: any, collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>): any {
    const baseSelection: any = {};

    // Build a set of top-level collection names (for backward compatibility)
    const topLevelCollectionNames = new Set(
      collections.filter(c => c.path.length === 0).map(c => c.name)
    );

    // Always ensure we have the primary key in the base selection with a known alias
    const mockRow = this._createMockRow();
    baseSelection['__pk_id'] = mockRow.id; // Add primary key with a known alias

    for (const [key, value] of Object.entries(selection)) {
      if (!topLevelCollectionNames.has(key)) {
        // For nested objects, recursively remove collections
        if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value) && !(value instanceof SqlFragment)) {
          const nestedCollections = collections.filter(c => c.path.length > 0 && c.path[0] === key);
          if (nestedCollections.length > 0) {
            // This nested object contains collections - build it recursively
            baseSelection[key] = this.buildBaseSelectionRecursive(value, nestedCollections, 1);
          } else {
            baseSelection[key] = value;
          }
        } else {
          baseSelection[key] = value;
        }
      }
    }

    return baseSelection;
  }

  /**
   * Recursively build base selection for nested objects, excluding collections
   */
  private buildBaseSelectionRecursive(
    selection: any,
    collections: Array<{ name: string; path: string[]; builder: CollectionQueryBuilder<any> }>,
    depth: number
  ): any {
    const baseSelection: any = {};

    // Build a set of collection names at this depth
    const collectionNamesAtDepth = new Set(
      collections.filter(c => c.path.length === depth).map(c => c.name)
    );

    for (const [key, value] of Object.entries(selection)) {
      if (!collectionNamesAtDepth.has(key)) {
        // For nested objects, continue recursively
        if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value) && !(value instanceof SqlFragment)) {
          const nestedCollections = collections.filter(c => c.path.length > depth && c.path[depth] === key);
          if (nestedCollections.length > 0) {
            baseSelection[key] = this.buildBaseSelectionRecursive(value, nestedCollections, depth + 1);
          } else {
            baseSelection[key] = value;
          }
        } else {
          baseSelection[key] = value;
        }
      }
    }

    return baseSelection;
  }

  /**
   * Build collection aggregation config from CollectionQueryBuilder
   */
  private buildCollectionConfig(
    builder: CollectionQueryBuilder<any>,
    context: QueryContext,
    parentIds: any[]
  ): CollectionAggregationConfig {
    // This is similar to the logic in CollectionQueryBuilder.buildCTE()
    // but extracts the config instead of building SQL directly

    // We need to access private members - use type assertion
    const builderAny = builder as any;

    const selectedFieldConfigs: Array<{ alias: string; expression: string }> = [];

    // Determine aggregation type
    let aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum' = 'jsonb';
    let aggregateField: string | undefined;
    let arrayField: string | undefined;

    if (builderAny.aggregationType) {
      aggregationType = builderAny.aggregationType.toLowerCase() as any;
    } else if (builderAny.flattenResultType) {
      aggregationType = 'array';
    }

    return {
      relationName: builderAny.relationName,
      targetTable: builderAny.targetTable,
      foreignKey: builderAny.foreignKey,
      sourceTable: builderAny.sourceTable,
      parentIds,
      selectedFields: selectedFieldConfigs,
      whereClause: '',  // Will be built from whereCond
      orderByClause: '',  // Will be built from orderByFields
      limitValue: builderAny.limitValue,
      offsetValue: builderAny.offsetValue,
      isDistinct: builderAny.isDistinct,
      aggregationType,
      aggregateField,
      arrayField: builderAny.flattenResultType ? this.extractArrayField(builderAny) : undefined,
      defaultValue: this.getDefaultValueString(aggregationType),
      counter: context.cteCounter++,
    };
  }

  /**
   * Extract array field from collection builder for array aggregations
   */
  private extractArrayField(builder: any): string | undefined {
    // For array aggregations, we need to determine which field to aggregate
    if (builder.selector) {
      const mockItem = builder.createMockItem?.() || {};
      const selectedField = builder.selector(mockItem);

      if (typeof selectedField === 'object' && selectedField !== null && '__dbColumnName' in selectedField) {
        return selectedField.__dbColumnName;
      }
    }

    return undefined;
  }

  /**
   * Get default value string for aggregation type
   */
  private getDefaultValueString(aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum'): string {
    switch (aggregationType) {
      case 'jsonb':
        // Use JSON instead of JSONB for better aggregation performance
        return "'[]'::json";
      case 'array':
        return "'{}'";
      case 'count':
        return '0';
      case 'min':
      case 'max':
      case 'sum':
        return 'null';
      default:
        return "'[]'::json";
    }
  }

  /**
   * Get default value for collection based on aggregation type
   */
  private getDefaultValueForCollection(builder: CollectionQueryBuilder<any>): any {
    const builderAny = builder as any;

    if (builderAny.aggregationType) {
      // Scalar aggregation
      return builderAny.aggregationType === 'COUNT' ? 0 : null;
    } else if (builderAny.flattenResultType) {
      // Array aggregation
      return [];
    } else if (builder.isSingleResult()) {
      // firstOrDefault() - single item
      return null;
    } else {
      // JSONB aggregation (object array)
      return [];
    }
  }

  /**
   * Execute query and return first result or null
   */
  async first(): Promise<ResolveCollectionResults<TSelection> | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return first result or null (alias for first)
   */
  async firstOrDefault(): Promise<ResolveCollectionResults<TSelection> | null> {
    return this.first();
  }

  /**
   * Execute query and return first result or throw
   */
  async firstOrThrow(): Promise<ResolveCollectionResults<TSelection>> {
    const result = await this.first();
    if (!result) {
      throw new Error('No results found');
    }
    return result;
  }

  /**
   * Create a prepared query for efficient reusable parameterized execution.
   *
   * Prepared queries build the SQL once and allow multiple executions
   * with different parameter values. This is useful for:
   * 1. Query building optimization - Build SQL once, execute many times
   * 2. Type-safe placeholders - Named parameters with validation
   * 3. Developer ergonomics - Cleaner API for reusable queries
   *
   * @param name - A name for the prepared query (for debugging)
   * @returns PreparedQuery that can be executed multiple times with different parameters
   *
   * @example
   * ```typescript
   * // Create a prepared query with a placeholder
   * const getUserById = db.users
   *   .where(u => eq(u.id, sql.placeholder('userId')))
   *   .prepare('getUserById');
   *
   * // Execute multiple times with different values
   * const user1 = await getUserById.execute({ userId: 10 });
   * const user2 = await getUserById.execute({ userId: 20 });
   * ```
   *
   * @example
   * ```typescript
   * // Multiple placeholders
   * const searchUsers = db.users
   *   .where(u => and(
   *     gt(u.age, sql.placeholder('minAge')),
   *     like(u.name, sql.placeholder('namePattern'))
   *   ))
   *   .prepare('searchUsers');
   *
   * await searchUsers.execute({ minAge: 18, namePattern: '%john%' });
   * ```
   */
  prepare<TParams extends Record<string, any> = Record<string, any>>(
    name: string
  ): PreparedQuery<ResolveCollectionResults<TSelection>, TParams> {
    // Build query with placeholder tracking
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      placeholders: new Map(),
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    // Analyze the selector to extract nested queries
    const mockRow = this._createMockRow();
    const selectionResult = this.selector(mockRow);

    // Build the query - this populates context.placeholders
    const { sql, nestedPaths } = this.buildQuery(selectionResult, context);

    // Create transform function (closure over schema, selection, nestedPaths)
    const transformFn = (rows: any[]): ResolveCollectionResults<TSelection>[] => {
      // If rawResult is enabled, return raw rows without any processing
      if (this.executor?.getOptions().rawResult) {
        return rows as any;
      }

      // Reconstruct nested objects from flat row data (if any)
      if (nestedPaths.size > 0) {
        rows = rows.map(row => this.reconstructNestedObjects(row, nestedPaths));
      }

      // Transform results
      return this.transformResults(rows, selectionResult) as any;
    };

    return new PreparedQuery(
      sql,
      context.placeholders || new Map(),
      context.paramCounter - 1,
      this.client,
      transformFn,
      name
    );
  }

  /**
   * Delete records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.where(u => eq(u.id, 1)).delete();
   *
   * // With returning() - returns full entities
   * const deleted = await db.users.where(u => eq(u.id, 1)).delete().returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.where(u => eq(u.isActive, false)).delete()
   *   .returning(u => ({ id: u.id, username: u.username }));
   * ```
   */
  delete(): FluentDelete<TSelection> {
    const queryBuilder = this;

    const executeDelete = async <TResult>(
      returning?: undefined | true | ((row: TSelection) => TResult) | 'count'
    ): Promise<any> => {
      // Build WHERE clause
      if (!queryBuilder.whereCond) {
        throw new Error('Delete requires a WHERE condition. Use where() before delete().');
      }

      // Detect navigation property joins from WHERE condition
      const whereJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
      queryBuilder.detectAndAddJoinsFromCondition(queryBuilder.whereCond, whereJoins);

      const condBuilder = new ConditionBuilder();
      const { sql: whereSql, params: whereParams } = condBuilder.build(queryBuilder.whereCond, 1);

      const qualifiedTableName = queryBuilder.getQualifiedTableName(queryBuilder.schema.name, queryBuilder.schema.schema);

      // Build USING clause for navigation properties (PostgreSQL syntax for DELETE with JOINs)
      let usingClause = '';
      let joinConditions: string[] = [];
      for (const join of whereJoins) {
        const sourceTable = join.sourceAlias || queryBuilder.schema.name;
        const joinTableName = queryBuilder.getQualifiedTableName(join.targetTable, join.targetSchema);

        if (usingClause) {
          usingClause += `, ${joinTableName} AS "${join.alias}"`;
        } else {
          usingClause = `USING ${joinTableName} AS "${join.alias}"`;
        }

        // Build ON conditions as part of WHERE clause
        for (let i = 0; i < join.foreignKeys.length; i++) {
          const fk = join.foreignKeys[i];
          const match = join.matches[i];
          joinConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
        }
      }

      // Combine join conditions with the original WHERE clause
      const fullWhereClause = joinConditions.length > 0
        ? `${joinConditions.join(' AND ')} AND ${whereSql}`
        : whereSql;

      // Check if RETURNING uses navigation properties
      const navigationInfo = returning && returning !== 'count' && returning !== true
        ? queryBuilder.detectNavigationInReturning(returning)
        : null;

      if (navigationInfo) {
        // Use CTE-based approach for navigation properties in RETURNING
        let deleteSql = `DELETE FROM ${qualifiedTableName}`;
        if (usingClause) {
          deleteSql += ` ${usingClause}`;
        }
        deleteSql += ` WHERE ${fullWhereClause}`;

        const { sql, params, nestedPaths } = queryBuilder.buildReturningWithNavigation(
          deleteSql,
          whereParams,
          returning as ((row: TSelection) => TResult),
          navigationInfo
        );

        const result = queryBuilder.executor
          ? await queryBuilder.executor.query(sql, params)
          : await queryBuilder.client.query(sql, params);

        return queryBuilder.mapReturningResultsWithNavigation(
          result.rows,
          returning as ((row: TSelection) => TResult),
          navigationInfo.navigationFields,
          nestedPaths
        );
      }

      // Standard RETURNING (no navigation properties)
      // Qualify columns with table name when using USING clause to avoid ambiguity
      const hasJoins = whereJoins.length > 0;
      const returningClause = returning !== 'count'
        ? queryBuilder.buildUpdateDeleteReturningClause(returning, hasJoins)
        : undefined;

      let sql = `DELETE FROM ${qualifiedTableName}`;
      if (usingClause) {
        sql += ` ${usingClause}`;
      }
      sql += ` WHERE ${fullWhereClause}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      const result = queryBuilder.executor
        ? await queryBuilder.executor.query(sql, whereParams)
        : await queryBuilder.client.query(sql, whereParams);

      // Return affected count
      if (returning === 'count') {
        return result.rowCount ?? 0;
      }

      if (!returningClause) {
        return undefined;
      }

      return queryBuilder.mapDeleteReturningResults(result.rows, returning);
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeDelete(undefined).then(onfulfilled, onrejected);
      },
      affectedCount() {
        return {
          then<T1 = number, T2 = never>(
            onfulfilled?: ((value: number) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeDelete('count').then(onfulfilled, onrejected);
          }
        };
      },
      returning<TResult>(selector?: (row: TSelection) => TResult) {
        const returningConfig = selector ?? true;
        return {
          then<T1 = any, T2 = never>(
            onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeDelete(returningConfig).then(onfulfilled, onrejected);
          }
        };
      }
    };
  }

  /**
   * Update records matching the current WHERE condition
   * Returns a fluent builder that can be awaited directly or chained with .returning()
   *
   * @param data Partial data to update
   *
   * @example
   * ```typescript
   * // No returning (default) - returns void
   * await db.users.where(u => eq(u.id, 1)).update({ age: 30 });
   *
   * // With returning() - returns full entities
   * const updated = await db.users.where(u => eq(u.id, 1)).update({ age: 30 }).returning();
   *
   * // With returning(selector) - returns selected columns
   * const results = await db.users.where(u => eq(u.isActive, true)).update({ lastLogin: new Date() })
   *   .returning(u => ({ id: u.id, lastLogin: u.lastLogin }));
   * ```
   */
  update(data: Partial<Record<string, any>>): FluentQueryUpdate<TSelection> {
    const queryBuilder = this;

    const executeUpdate = async <TResult>(
      returning?: undefined | true | ((row: TSelection) => TResult) | 'count'
    ): Promise<any> => {
      // Build WHERE clause
      if (!queryBuilder.whereCond) {
        throw new Error('Update requires a WHERE condition. Use where() before update().');
      }

      // Detect navigation property joins from WHERE condition
      const whereJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
      queryBuilder.detectAndAddJoinsFromCondition(queryBuilder.whereCond, whereJoins);

      // Build SET clause
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(data)) {
        const column = queryBuilder.schema.columns[key];
        if (column) {
          const config = (column as any).build();
          setClauses.push(`"${config.name}" = $${paramIndex++}`);
          // Apply toDriver mapper if present
          const mappedValue = config.mapper
            ? config.mapper.toDriver(value)
            : value;
          values.push(mappedValue);
        }
      }

      if (setClauses.length === 0) {
        throw new Error('No valid columns to update');
      }

      const condBuilder = new ConditionBuilder();
      const { sql: whereSql, params: whereParams } = condBuilder.build(queryBuilder.whereCond, paramIndex);
      values.push(...whereParams);

      const qualifiedTableName = queryBuilder.getQualifiedTableName(queryBuilder.schema.name, queryBuilder.schema.schema);

      // Build FROM clause for navigation properties (PostgreSQL syntax for UPDATE with JOINs)
      let fromClause = '';
      let joinConditions: string[] = [];
      for (const join of whereJoins) {
        const sourceTable = join.sourceAlias || queryBuilder.schema.name;
        const joinTableName = queryBuilder.getQualifiedTableName(join.targetTable, join.targetSchema);

        if (fromClause) {
          fromClause += `, ${joinTableName} AS "${join.alias}"`;
        } else {
          fromClause = `FROM ${joinTableName} AS "${join.alias}"`;
        }

        // Build ON conditions as part of WHERE clause
        for (let i = 0; i < join.foreignKeys.length; i++) {
          const fk = join.foreignKeys[i];
          const match = join.matches[i];
          joinConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
        }
      }

      // Combine join conditions with the original WHERE clause
      const fullWhereClause = joinConditions.length > 0
        ? `${joinConditions.join(' AND ')} AND ${whereSql}`
        : whereSql;

      // Check if RETURNING uses navigation properties
      const navigationInfo = returning && returning !== 'count' && returning !== true
        ? queryBuilder.detectNavigationInReturning(returning)
        : null;

      if (navigationInfo) {
        // Use CTE-based approach for navigation properties in RETURNING
        let updateSql = `UPDATE ${qualifiedTableName} SET ${setClauses.join(', ')}`;
        if (fromClause) {
          updateSql += ` ${fromClause}`;
        }
        updateSql += ` WHERE ${fullWhereClause}`;

        const { sql, params, nestedPaths } = queryBuilder.buildReturningWithNavigation(
          updateSql,
          values,
          returning as ((row: TSelection) => TResult),
          navigationInfo
        );

        const result = queryBuilder.executor
          ? await queryBuilder.executor.query(sql, params)
          : await queryBuilder.client.query(sql, params);

        return queryBuilder.mapReturningResultsWithNavigation(
          result.rows,
          returning as ((row: TSelection) => TResult),
          navigationInfo.navigationFields,
          nestedPaths
        );
      }

      // Standard RETURNING (no navigation properties)
      // Qualify columns with table name when using FROM clause to avoid ambiguity
      const hasJoins = whereJoins.length > 0;
      const returningClause = returning !== 'count'
        ? queryBuilder.buildUpdateDeleteReturningClause(returning, hasJoins)
        : undefined;

      let sql = `UPDATE ${qualifiedTableName} SET ${setClauses.join(', ')}`;
      if (fromClause) {
        sql += ` ${fromClause}`;
      }
      sql += ` WHERE ${fullWhereClause}`;
      if (returningClause) {
        sql += ` RETURNING ${returningClause.sql}`;
      }

      const result = queryBuilder.executor
        ? await queryBuilder.executor.query(sql, values)
        : await queryBuilder.client.query(sql, values);

      // Return affected count
      if (returning === 'count') {
        return result.rowCount ?? 0;
      }

      if (!returningClause) {
        return undefined;
      }

      return queryBuilder.mapDeleteReturningResults(result.rows, returning);
    };

    return {
      then<TResult1 = void, TResult2 = never>(
        onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        return executeUpdate(undefined).then(onfulfilled, onrejected);
      },
      affectedCount() {
        return {
          then<T1 = number, T2 = never>(
            onfulfilled?: ((value: number) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
          ): PromiseLike<T1 | T2> {
            return executeUpdate('count').then(onfulfilled, onrejected);
          }
        };
      },
      returning<TResult>(selector?: (row: TSelection) => TResult) {
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
   * Build RETURNING clause for delete/update operations
   * @param returning - The returning configuration
   * @param qualifyWithTable - If true, qualify column names with the main table name (needed for DELETE with USING)
   * @internal
   */
  private buildUpdateDeleteReturningClause<TResult>(
    returning: undefined | true | ((row: TSelection) => TResult),
    qualifyWithTable: boolean = false
  ): { sql: string; columns: string[] } | null {
    if (returning === undefined) {
      return null;
    }

    const tablePrefix = qualifyWithTable ? `"${this.schema.name}".` : '';

    if (returning === true) {
      // Return all columns
      const columns = Object.values(this.schema.columns).map(col => (col as any).build().name);
      const sql = columns.map(name => `${tablePrefix}"${name}"`).join(', ');
      return { sql, columns };
    }

    // Selector function - extract selected columns
    const mockRow = this._createMockRow();
    const selectedMock = this.selector(mockRow);
    const selection = returning(selectedMock as TSelection);

    if (typeof selection === 'object' && selection !== null) {
      const columns: string[] = [];
      const sqlParts: string[] = [];

      for (const [alias, field] of Object.entries(selection)) {
        if (field && typeof field === 'object' && '__dbColumnName' in field) {
          const dbName = (field as any).__dbColumnName;
          columns.push(alias);
          sqlParts.push(`${tablePrefix}"${dbName}" AS "${alias}"`);
        }
      }

      return { sql: sqlParts.join(', '), columns };
    }

    return null;
  }

  /**
   * Map row results for delete/update RETURNING clause
   * @internal
   */
  private mapDeleteReturningResults<TResult>(
    rows: any[],
    returning: undefined | true | ((row: TSelection) => TResult)
  ): any[] {
    if (returning === true) {
      // Full entity mapping - apply fromDriver mappers
      return rows.map(row => {
        const mapped: any = {};
        for (const [propName, colBuilder] of Object.entries(this.schema.columns)) {
          const config = (colBuilder as any).build();
          const dbValue = row[config.name];
          mapped[propName] = config.mapper ? config.mapper.fromDriver(dbValue) : dbValue;
        }
        return mapped;
      });
    }

    // For selector functions, rows are already in the correct shape
    // Just apply any type mappers needed
    return rows.map(row => {
      const mapped: any = {};
      for (const [key, value] of Object.entries(row)) {
        // Try to find column by alias or name
        const colEntry = Object.entries(this.schema.columns).find(([propName, col]) => {
          const config = (col as any).build();
          return propName === key || config.name === key;
        });

        if (colEntry) {
          const [, col] = colEntry;
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

  /**
   * Detect if a RETURNING selector uses navigation properties
   * Returns navigation info if found, null otherwise
   * @internal
   */
  private detectNavigationInReturning<TResult>(
    returning: true | ((row: TSelection) => TResult)
  ): {
    hasNavigation: boolean;
    selection: any;
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
    navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>;
    nestedObjects?: Map<string, any>;
    collectionFields?: Map<string, any>;
  } | null {
    if (returning === true) {
      // Full entity returning doesn't need navigation support
      return null;
    }

    // Analyze the returning selector
    const mockRow = this._createMockRow();
    const selectedMock = this.selector(mockRow);
    const selection = returning(selectedMock as TSelection);

    if (typeof selection !== 'object' || selection === null) {
      return null;
    }

    const navigationFields = new Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>();
    const allTableAliases = new Set<string>();
    const nestedObjects = new Map<string, any>();
    const collectionFields = new Map<string, any>();

    // Recursively collect field refs and table aliases from selection
    const collectFieldRefs = (obj: any, path: string = '') => {
      for (const [key, field] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;

        if (field && typeof field === 'object') {
          if ('__dbColumnName' in field) {
            // Direct field reference (either main table or navigation)
            const tableAlias = (field as any).__tableAlias as string | undefined;
            if (tableAlias && tableAlias !== this.schema.name) {
              // Navigation field
              allTableAliases.add(tableAlias);
              navigationFields.set(fieldPath, {
                tableAlias,
                dbColumnName: (field as any).__dbColumnName,
                schemaTable: (field as any).__sourceTable,
              });
            }
            // Also collect intermediate navigation aliases for multi-level navigation
            if ('__navigationAliases' in field && Array.isArray((field as any).__navigationAliases)) {
              for (const navAlias of (field as any).__navigationAliases) {
                if (navAlias && navAlias !== this.schema.name) {
                  allTableAliases.add(navAlias);
                }
              }
            }
          } else if (field instanceof CollectionQueryBuilder) {
            // CollectionQueryBuilder (.toList(), .firstOrDefault())
            collectionFields.set(fieldPath, field);
            // Also extract the navigation path from the collection builder
            // so we can add the necessary joins to reach the collection's source table
            const collectionBuilder = field as any;
            if (collectionBuilder.navigationPath && Array.isArray(collectionBuilder.navigationPath)) {
              for (const navJoin of collectionBuilder.navigationPath) {
                if (navJoin.alias && navJoin.alias !== this.schema.name) {
                  allTableAliases.add(navJoin.alias);
                }
              }
            }
            // Also add the source table alias
            if (collectionBuilder.sourceTable && collectionBuilder.sourceTable !== this.schema.name) {
              allTableAliases.add(collectionBuilder.sourceTable);
            }
          } else if (!Array.isArray(field)) {
            // Nested plain object - recurse into it
            nestedObjects.set(fieldPath, field);
            collectFieldRefs(field, fieldPath);
          }
        }
      }
    };

    collectFieldRefs(selection);

    if (navigationFields.size === 0 && nestedObjects.size === 0 && collectionFields.size === 0) {
      return null;
    }

    // Resolve navigation joins
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    this.resolveJoinsForTableAliases(allTableAliases, joins);

    return { hasNavigation: true, selection, joins, navigationFields, nestedObjects, collectionFields };
  }

  /**
   * Build RETURNING clause with navigation property support using CTE
   * @internal
   */
  private buildReturningWithNavigation<TResult>(
    mutationSql: string,
    mutationParams: any[],
    returning: true | ((row: TSelection) => TResult),
    navigationInfo: {
      selection: any;
      joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>;
      navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>;
      nestedObjects?: Map<string, any>;
      collectionFields?: Map<string, any>;
    }
  ): { sql: string; params: any[]; nestedPaths?: Set<string> } {
    // Build the CTE wrapping the mutation
    // First, collect all columns needed from the main table in the mutation's RETURNING
    const mainTableColumns = new Set<string>();
    const selectParts: string[] = [];
    const nestedPaths = new Set<string>();
    const mockRow = this._createMockRow();
    const selectedMock = this.selector(mockRow);
    const selection = (returning as Function)(selectedMock as TSelection);

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
    aliasToSourceTable.set(this.schema.name, this.schema.name);
    for (const join of navigationInfo.joins) {
      aliasToSourceTable.set(join.alias, join.targetTable);
    }

    // Build a map of table name -> alias for collection subquery rewriting
    // This allows us to rewrite collection subqueries to use the correct joined aliases
    const tableToAlias = new Map<string, string>();
    tableToAlias.set(this.schema.name, '__mutation__'); // Main table uses mutation CTE
    for (const join of navigationInfo.joins) {
      tableToAlias.set(join.targetTable, join.alias);
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

    // Recursively process selection to build SELECT parts
    const processSelection = (obj: any, path: string = '') => {
      for (const [key, field] of Object.entries(obj)) {
        const fieldPath = path ? `${path}.${key}` : key;

        if (field && typeof field === 'object') {
          if ('__dbColumnName' in field) {
            // Direct field reference
            const tableAlias = (field as any).__tableAlias as string;
            const dbColumnName = (field as any).__dbColumnName as string;

            if (!tableAlias || tableAlias === this.schema.name) {
              mainTableColumns.add(dbColumnName);
              selectParts.push(`"__mutation__"."${dbColumnName}" AS "${fieldPath}"`);
            } else {
              selectParts.push(`"${tableAlias}"."${dbColumnName}" AS "${fieldPath}"`);
            }
          } else if (field instanceof CollectionQueryBuilder) {
            // CollectionQueryBuilder (.toList(), .firstOrDefault())
            // Build a correlated subquery that references joined tables from the main query
            const collectionBuilder = field as CollectionQueryBuilder<any>;
            const context = buildCollectionContext();

            // Build the CTE/subquery using lateral strategy
            const cteResult = collectionBuilder.buildCTE(context);
            lateralCounter = context.cteCounter;
            currentParamCounter = context.paramCounter; // Track new param index after collection subquery

            // The lateral strategy returns either:
            // 1. A correlated subquery in selectExpression (no join needed)
            // 2. A LATERAL JOIN with joinClause and selectExpression
            if (cteResult.joinClause && cteResult.joinClause.trim()) {
              // LATERAL JOIN needed - rewrite all table references to use correct aliases
              const rewrittenJoinClause = this.rewriteCollectionTableReferences(
                cteResult.joinClause,
                tableToAlias
              );
              collectionSubqueries.push({
                fieldPath,
                lateralAlias: cteResult.tableName || `lateral_${lateralCounter - 1}`,
                joinClause: rewrittenJoinClause,
                selectExpression: cteResult.selectExpression || `"${cteResult.tableName}".data`,
              });
              selectParts.push(`${cteResult.selectExpression || `"${cteResult.tableName}".data`} AS "${fieldPath}"`);
            } else if (cteResult.selectExpression) {
              // Correlated subquery in SELECT - rewrite all table references
              const rewrittenExpr = this.rewriteCollectionTableReferences(
                cteResult.selectExpression,
                tableToAlias
              );
              selectParts.push(`${rewrittenExpr} AS "${fieldPath}"`);
            }
          } else if (!Array.isArray(field)) {
            // Nested plain object - recurse into it and mark as nested path
            nestedPaths.add(fieldPath);
            processSelection(field, fieldPath);
          }
        }
      }
    };

    processSelection(selection);

    // Include foreign keys needed for joins - only for joins from main table
    for (const join of navigationInfo.joins) {
      // Only add FK to mainTableColumns if the join source is the main table
      if (join.sourceAlias === this.schema.name || !join.sourceAlias) {
        for (const fk of join.foreignKeys) {
          if (isLiteralKeyPart(fk)) continue; // Skip literal values
          const fkDbCol = getFkDbColumnName(this.schema, fk);
          mainTableColumns.add(fkDbCol);
        }
      }
    }

    // Include 'id' column if there are collection subqueries (needed for correlation)
    if (collectionSubqueries.length > 0 || (navigationInfo.collectionFields && navigationInfo.collectionFields.size > 0)) {
      // Find the 'id' column db name
      const idColEntry = Object.entries(this.schema.columns).find(([propName, _]) => propName === 'id');
      if (idColEntry) {
        const idDbCol = (idColEntry[1] as any).build().name;
        mainTableColumns.add(idDbCol);
      } else {
        // Fallback to 'id' if not found in schema
        mainTableColumns.add('id');
      }
    }

    // Build RETURNING clause for CTE with all needed columns from main table
    const cteReturningCols = Array.from(mainTableColumns).map(col => `"${col}"`).join(', ');

    // Add RETURNING to the mutation SQL for CTE
    const mutationWithReturning = `${mutationSql} RETURNING ${cteReturningCols}`;

    // Build the JOINs for the outer SELECT
    const joinClauses: string[] = [];
    for (const join of navigationInfo.joins) {
      const qualifiedJoinTable = this.getQualifiedTableName(join.targetTable, join.targetSchema);

      // Find the db column names for the foreign keys
      const joinConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i] || 'id';

        if (isLiteralKeyPart(fk) || isLiteralKeyPart(match)) {
          // Literal key parts don't need column name resolution
          const fkSide = isLiteralKeyPart(fk)
            ? formatJoinValue('', fk)
            : `"${join.sourceAlias === this.schema.name || !join.sourceAlias ? '__mutation__' : join.sourceAlias}"."${getFkDbColumnName(this.schema, fk)}"`;
          const matchSide = formatJoinValue(join.alias, match);
          joinConditions.push(`${fkSide} = ${matchSide}`);
        } else if (join.sourceAlias === this.schema.name || !join.sourceAlias) {
          // FK is on main table - look up db column name from main schema
          const fkDbCol = getFkDbColumnName(this.schema, fk);
          joinConditions.push(`"__mutation__"."${fkDbCol}" = ${formatJoinValue(join.alias, match)}`);
        } else {
          // FK is on an intermediate joined table - look up from its schema
          const sourceTableName = aliasToSourceTable.get(join.sourceAlias);
          const sourceSchema = sourceTableName && this.schemaRegistry ? this.schemaRegistry.get(sourceTableName) : undefined;
          const fkDbCol = sourceSchema ? getFkDbColumnName(sourceSchema, fk) : fk;
          joinConditions.push(`"${join.sourceAlias}"."${fkDbCol}" = ${formatJoinValue(join.alias, match)}`);
        }
      }

      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      joinClauses.push(`${joinType} ${qualifiedJoinTable} AS "${join.alias}" ON ${joinConditions.join(' AND ')}`);
    }

    // Add LATERAL JOINs for collections
    for (const collection of collectionSubqueries) {
      joinClauses.push(collection.joinClause);
    }

    // Build the final CTE query
    const sql = `WITH "__mutation__" AS (
  ${mutationWithReturning}
)
SELECT ${selectParts.join(', ')}
FROM "__mutation__"
${joinClauses.join('\n')}`;

    return { sql, params: allParams, nestedPaths };
  }

  /**
   * Rewrite table references in a collection subquery to use the correct aliases
   * from the main query's JOINs. This handles multi-level navigation where the
   * collection is accessed through intermediate joined tables.
   *
   * @param expression - The SQL expression (join clause or select expression) to rewrite
   * @param tableToAlias - Map of table names to their aliases in the main query
   * @returns The rewritten expression with all table references updated
   * @internal
   */
  private rewriteCollectionTableReferences(
    expression: string,
    tableToAlias: Map<string, string>
  ): string {
    let result = expression;

    // Rewrite each table reference to use the correct alias
    // Pattern: "tableName"."columnName" -> "alias"."columnName"
    for (const [tableName, alias] of tableToAlias) {
      const pattern = new RegExp(`"${tableName}"\\."`, 'g');
      result = result.replace(pattern, `"${alias}"."`);
    }

    return result;
  }

  /**
   * Map RETURNING results with navigation properties
   * Applies type mappers based on source table schemas
   * Reconstructs nested objects from flat column paths
   * @internal
   */
  private mapReturningResultsWithNavigation<TResult>(
    rows: any[],
    returning: (row: TSelection) => TResult,
    navigationFields: Map<string, { tableAlias: string; dbColumnName: string; schemaTable?: string }>,
    nestedPaths?: Set<string>
  ): any[] {
    return rows.map(row => {
      const mapped: any = {};

      for (const [key, value] of Object.entries(row)) {
        // Handle nested paths (e.g., "invoicingPartner.id" -> { invoicingPartner: { id: value } })
        if (key.includes('.')) {
          const parts = key.split('.');
          let current = mapped;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!current[parts[i]]) {
              current[parts[i]] = {};
            }
            current = current[parts[i]];
          }
          const finalKey = parts[parts.length - 1];

          // Check if this is a navigation field
          const navInfo = navigationFields.get(key);
          if (navInfo && navInfo.schemaTable && this.schemaRegistry) {
            const targetSchema = this.schemaRegistry.get(navInfo.schemaTable);
            if (targetSchema) {
              const colEntry = Object.entries(targetSchema.columns).find(([_, col]) => {
                const config = (col as any).build();
                return config.name === navInfo.dbColumnName;
              });
              if (colEntry) {
                const config = (colEntry[1] as any).build();
                current[finalKey] = config.mapper ? config.mapper.fromDriver(value) : value;
                continue;
              }
            }
          }
          current[finalKey] = value;
        } else {
          // Check if this is a navigation field
          const navInfo = navigationFields.get(key);
          if (navInfo && navInfo.schemaTable && this.schemaRegistry) {
            // Try to get mapper from the navigation target's schema
            const targetSchema = this.schemaRegistry.get(navInfo.schemaTable);
            if (targetSchema) {
              // Find the column and its mapper
              const colEntry = Object.entries(targetSchema.columns).find(([_, col]) => {
                const config = (col as any).build();
                return config.name === navInfo.dbColumnName;
              });
              if (colEntry) {
                const config = (colEntry[1] as any).build();
                mapped[key] = config.mapper ? config.mapper.fromDriver(value) : value;
                continue;
              }
            }
          }

          // Try to find column by alias or name in main schema
          const colEntry = Object.entries(this.schema.columns).find(([propName, col]) => {
            const config = (col as any).build();
            return propName === key || config.name === key;
          });

          if (colEntry) {
            const [, col] = colEntry;
            const config = (col as any).build();
            mapped[key] = config.mapper ? config.mapper.fromDriver(value) : value;
          } else {
            mapped[key] = value;
          }
        }
      }
      return mapped;
    });
  }

  /**
   * Create mock row for analysis
   * @internal
   */
  _createMockRow(): any {
    const mock: any = {};
    const tableAlias = this.schema.name;

    // Performance: Use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.schema);

    // Performance: Lazy-cache FieldRef objects
    const fieldRefCache: Record<string, any> = {};

    // Build a mapper lookup for columns (only when needed)
    const columnMappers: Record<string, any> = {};
    for (const [colName, colBuilder] of Object.entries(this.schema.columns)) {
      const config = (colBuilder as any).build();
      if (config.mapper) {
        columnMappers[colName] = config.mapper;
      }
    }

    // Add columns as FieldRef objects - type-safe with property name and database column name
    for (const [colName, dbColumnName] of columnNameMap) {
      const mapper = columnMappers[colName];
      Object.defineProperty(mock, colName, {
        get() {
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,
              // Include mapper for toDriver transformation in conditions
              __mapper: mapper,
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Add columns from manually joined tables
    for (const join of this.manualJoins) {
      // Skip subquery joins (they don't have a schema)
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

      // Performance: Use pre-computed column name map for joined schema
      const joinColumnNameMap = getColumnNameMapForSchema(join.schema);
      if (!mock[join.alias]) {
        mock[join.alias] = {};
      }

      // Lazy-cache for joined table
      const joinFieldRefCache: Record<string, any> = {};
      const joinAlias = join.alias;
      for (const [colName, dbColumnName] of joinColumnNameMap) {
        Object.defineProperty(mock[join.alias], colName, {
          get() {
            let cached = joinFieldRefCache[colName];
            if (!cached) {
              cached = joinFieldRefCache[colName] = {
                __fieldName: colName,
                __dbColumnName: dbColumnName,
                __tableAlias: joinAlias,
              };
            }
            return cached;
          },
          enumerable: true,
          configurable: true,
        });
      }
    }

    // Performance: Use pre-computed relation entries
    const relationEntries = getRelationEntriesForSchema(this.schema);

    // Add relations as CollectionQueryBuilder or ReferenceQueryBuilder
    for (const [relName, relConfig] of relationEntries) {
      // Try to get target schema from registry (preferred, has full relations) or cached schema
      let targetSchema: TableSchema | undefined;
      if (this.schemaRegistry) {
        targetSchema = this.schemaRegistry.get(relConfig.targetTable);
      }
      if (!targetSchema) {
        // Performance: Use cached target schema
        targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);
      }

      if (relConfig.type === 'many') {
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              this.schema.name,
              targetSchema,  // Pass the target schema directly
              this.schemaRegistry  // Pass schema registry for nested resolution
            );
          },
          enumerable: false,
          configurable: true,
        });
      } else {
        // For single reference (many-to-one), create a ReferenceQueryBuilder
        // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
        Object.defineProperty(mock, relName, {
          get: () => {
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              targetSchema,  // Pass the target schema directly
              this.schemaRegistry,  // Pass schema registry for nested resolution
              [],  // Empty navigation path for first level navigation
              this.schema.name  // Pass source table name for lateral join correlation
            );
            // Return a mock object that exposes the target table's columns
            return refBuilder.createMockTargetRow();
          },
          enumerable: false,
          configurable: true,
        });
      }
    }

    return mock;
  }

  /**
   * Create a proxy that wraps selected values and returns FieldRefs for property access
   * This enables orderBy and other operations to work with chained selects
   * @param preserveOriginal - If true (for WHERE), preserve original column names; if false (for ORDER BY), use alias names
   */
  private createFieldRefProxy(selectedMock: any, preserveOriginal: boolean = false): any {
    if (!selectedMock || typeof selectedMock !== 'object') {
      return selectedMock;
    }

    // If it already has FieldRef properties, return as-is
    if ('__fieldName' in selectedMock && '__dbColumnName' in selectedMock) {
      return selectedMock;
    }

    // Create a proxy that returns FieldRefs for each property access
    return new Proxy(selectedMock, {
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then') {
          return target[prop];
        }

        const value = target[prop];

        // If the value is already a FieldRef
        if (value && typeof value === 'object' && '__fieldName' in value && '__dbColumnName' in value) {
          if (preserveOriginal) {
            // For WHERE: preserve original column name, table alias, and mapper
            // This ensures WHERE references the actual database column with proper type conversion
            return {
              __fieldName: prop as string,
              __dbColumnName: (value as any).__dbColumnName,
              __tableAlias: (value as any).__tableAlias,
              __mapper: (value as any).__mapper,  // Preserve mapper for toDriver in conditions
            };
          } else {
            // For ORDER BY: use the alias (property name) as the column name
            // In chained selects, the alias becomes the column name in the subquery
            return {
              __fieldName: prop as string,
              __dbColumnName: prop as string,
              // No table alias - column comes from the selection/subquery
            };
          }
        }

        // If the value is a SqlFragment, treat it as a FieldRef using the property name as the alias
        if (value && typeof value === 'object' && value instanceof SqlFragment) {
          return {
            __fieldName: prop as string,
            __dbColumnName: prop as string,
          };
        }

        // If the value is an object (nested selection), recursively wrap it
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return this.createFieldRefProxy(value, preserveOriginal);
        }

        // For primitive values or arrays, create a FieldRef
        // Use the property name as both fieldName and dbColumnName
        return {
          __fieldName: prop as string,
          __dbColumnName: prop as string,
        };
      }
    });
  }

  /**
   * Detect navigation property references in selection and add necessary JOINs
   * Supports multi-level navigation like task.level.createdBy
   */
  /**
   * Try to build flat SQL SELECT parts for a nested object containing FieldRefs.
   * Uses path-encoded aliases (e.g., __nested__address__street) for JS-side reconstruction.
   * This is more performant than json_build_object() as it avoids JSON serialization overhead.
   *
   * @param obj The nested object from the selector
   * @param context Query context for parameter tracking
   * @param joins Array to add necessary JOINs
   * @param selectParts Array to add SELECT parts to
   * @param pathPrefix Current path prefix for alias encoding (e.g., "__nested__address")
   * @param nestedPaths Set to track all nested paths for reconstruction
   * @returns true if handled as nested object, false if not a valid nested object
   */
  private tryBuildFlatNestedSelect(
    obj: any,
    context: QueryContext,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>,
    selectParts: string[],
    pathPrefix: string,
    nestedPaths: Set<string>
  ): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return false;
    }

    const entries = Object.entries(obj);
    if (entries.length === 0) {
      return false;
    }

    // First pass: check if this object contains any CollectionQueryBuilder instances
    // If so, this is NOT a plain nested object and needs special handling elsewhere
    for (const [, nestedValue] of entries) {
      if (nestedValue instanceof CollectionQueryBuilder) {
        return false; // Contains collections - let the main loop handle this
      }
      if (nestedValue && typeof nestedValue === 'object' && '__collectionResult' in nestedValue) {
        return false; // Contains collection result marker
      }
    }

    // Track this path as a nested object
    nestedPaths.add(pathPrefix);

    for (const [nestedKey, nestedValue] of entries) {
      const fieldPath = `${pathPrefix}__${nestedKey}`;

      if (nestedValue instanceof SqlFragment) {
        // SQL Fragment - build the SQL expression
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const fragmentSql = nestedValue.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        selectParts.push(`${fragmentSql} as "${fieldPath}"`);
      } else if (typeof nestedValue === 'object' && nestedValue !== null && '__dbColumnName' in nestedValue) {
        // FieldRef - extract table alias and column name
        const tableAlias = ('__tableAlias' in nestedValue && nestedValue.__tableAlias)
          ? nestedValue.__tableAlias as string
          : this.schema.name;
        const columnName = nestedValue.__dbColumnName as string;

        // Add JOIN if needed for navigation fields
        if (tableAlias !== this.schema.name) {
          const relConfig = this.schema.relations[tableAlias];
          if (relConfig && !joins.find(j => j.alias === tableAlias)) {
            let targetSchema: string | undefined;
            if (relConfig.targetTableBuilder) {
              const targetTableSchema = relConfig.targetTableBuilder.build();
              targetSchema = targetTableSchema.schema;
            }
            joins.push({
              alias: tableAlias,
              targetTable: relConfig.targetTable,
              targetSchema,
              foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
              matches: relConfig.matches || [],
              isMandatory: relConfig.isMandatory ?? false,
            });
          }
        }

        selectParts.push(`"${tableAlias}"."${columnName}" as "${fieldPath}"`);
      } else if (typeof nestedValue === 'object' && nestedValue !== null && !Array.isArray(nestedValue)) {
        // Recursively handle deeper nested objects
        const handled = this.tryBuildFlatNestedSelect(nestedValue, context, joins, selectParts, fieldPath, nestedPaths);
        if (!handled) {
          // Not a valid nested object structure - return false to let caller handle
          return false;
        }
      } else if (nestedValue === undefined || nestedValue === null) {
        selectParts.push(`NULL as "${fieldPath}"`);
      } else {
        // Literal value (string, number, boolean)
        selectParts.push(`$${context.paramCounter++} as "${fieldPath}"`);
        context.allParams.push(nestedValue);
      }
    }

    return true;
  }

  /**
   * Reconstruct nested objects from flat row data with path-encoded column names.
   * Transforms { "__nested__address__street": "Main St", "__nested__address__city": "NYC" }
   * into { address: { street: "Main St", city: "NYC" } }
   * Also handles nested collections with paths like "__nested__content__posts"
   * Converts numeric strings to numbers for scalar aggregation results.
   */
  private reconstructNestedObjects(row: any, nestedPaths: Set<string>): any {
    if (nestedPaths.size === 0) {
      return row;
    }

    const result: any = {};
    const nestedPrefix = '__nested__';

    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(nestedPrefix)) {
        // This is a nested field - parse the path and set the value
        const pathParts = key.substring(nestedPrefix.length).split('__');
        let current = result;
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!(part in current)) {
            current[part] = {};
          }
          current = current[part];
        }
        // Convert numeric strings to numbers (for scalar aggregations like COUNT)
        // This handles values like "2" -> 2, "3.14" -> 3.14
        let finalValue = value;
        if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
          finalValue = +value;
        }
        current[pathParts[pathParts.length - 1]] = finalValue;
      } else {
        // Regular field
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Check if an object contains any CollectionQueryBuilder instances (recursively)
   */
  private hasNestedCollections(obj: any): boolean {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return false;
    }

    for (const value of Object.values(obj)) {
      if (value instanceof CollectionQueryBuilder) {
        return true;
      }
      if (value && typeof value === 'object' && '__collectionResult' in value) {
        return true;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && !('__dbColumnName' in value)) {
        if (this.hasNestedCollections(value)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Build flat SQL SELECT parts for a nested object, excluding collections.
   * Collections are added to collectionFields for separate handling.
   */
  private tryBuildFlatNestedSelectExcludingCollections(
    obj: any,
    context: QueryContext,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>,
    selectParts: string[],
    pathPrefix: string,
    nestedPaths: Set<string>,
    collectionFields: Array<{ name: string; cteName: string; isCTE: boolean; joinClause?: string; selectExpression?: string }>
  ): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return;
    }

    // Track this path as a nested object
    nestedPaths.add(pathPrefix);

    for (const [nestedKey, nestedValue] of Object.entries(obj)) {
      const fieldPath = `${pathPrefix}__${nestedKey}`;

      // Check if this is a collection - handle it separately
      if (nestedValue instanceof CollectionQueryBuilder || (nestedValue && typeof nestedValue === 'object' && '__collectionResult' in nestedValue)) {
        // Build CTE for collection and add to collectionFields
        const cteData = (nestedValue as any).buildCTE ? (nestedValue as any).buildCTE(context) : (nestedValue as CollectionQueryBuilder<any>).buildCTE(context);
        const isCTE = cteData.isCTE !== false;

        collectionFields.push({
          name: fieldPath, // Use full path as the name
          cteName: cteData.tableName || `cte_${context.cteCounter - 1}`,
          isCTE,
          joinClause: cteData.joinClause,
          selectExpression: cteData.selectExpression,
        });
        continue;
      }

      if (nestedValue instanceof SqlFragment) {
        // SQL Fragment - build the SQL expression
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const fragmentSql = nestedValue.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        selectParts.push(`${fragmentSql} as "${fieldPath}"`);
      } else if (typeof nestedValue === 'object' && nestedValue !== null && '__dbColumnName' in nestedValue) {
        // FieldRef - extract table alias and column name
        const tableAlias = ('__tableAlias' in nestedValue && nestedValue.__tableAlias)
          ? nestedValue.__tableAlias as string
          : this.schema.name;
        const columnName = nestedValue.__dbColumnName as string;

        // Add JOIN if needed for navigation fields
        if (tableAlias !== this.schema.name) {
          const relConfig = this.schema.relations[tableAlias];
          if (relConfig && !joins.find(j => j.alias === tableAlias)) {
            let targetSchema: string | undefined;
            if (relConfig.targetTableBuilder) {
              const targetTableSchema = relConfig.targetTableBuilder.build();
              targetSchema = targetTableSchema.schema;
            }
            joins.push({
              alias: tableAlias,
              targetTable: relConfig.targetTable,
              targetSchema,
              foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
              matches: relConfig.matches || [],
              isMandatory: relConfig.isMandatory ?? false,
            });
          }
        }

        selectParts.push(`"${tableAlias}"."${columnName}" as "${fieldPath}"`);
      } else if (typeof nestedValue === 'object' && nestedValue !== null && !Array.isArray(nestedValue)) {
        // Recursively handle deeper nested objects
        this.tryBuildFlatNestedSelectExcludingCollections(nestedValue, context, joins, selectParts, fieldPath, nestedPaths, collectionFields);
      } else if (nestedValue === undefined || nestedValue === null) {
        selectParts.push(`NULL as "${fieldPath}"`);
      } else {
        // Literal value (string, number, boolean)
        selectParts.push(`$${context.paramCounter++} as "${fieldPath}"`);
        context.allParams.push(nestedValue);
      }
    }
  }

  private detectAndAddJoinsFromSelection(selection: any, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    // First pass: collect all table aliases
    const allTableAliases = new Set<string>();
    this.collectTableAliasesFromSelection(selection, allTableAliases);

    // Second pass: resolve all joins through the schema graph
    this.resolveJoinsForTableAliases(allTableAliases, joins);
  }

  /**
   * Collect all table aliases from a selection
   */
  private collectTableAliasesFromSelection(selection: any, allTableAliases: Set<string>): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    for (const [_key, value] of Object.entries(selection)) {
      if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
        // This is a FieldRef with a table alias
        const tableAlias = value.__tableAlias as string;
        if (tableAlias && tableAlias !== this.schema.name) {
          allTableAliases.add(tableAlias);
        }
      } else if (value instanceof SqlFragment) {
        // SqlFragment may contain navigation property references
        const fieldRefs = value.getFieldRefs();
        for (const fieldRef of fieldRefs) {
          if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
            const tableAlias = fieldRef.__tableAlias as string;
            if (tableAlias && tableAlias !== this.schema.name) {
              allTableAliases.add(tableAlias);
            }
          }
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof CollectionQueryBuilder)) {
        // Recursively check nested objects
        this.collectTableAliasesFromSelection(value, allTableAliases);
      }
    }
  }

  /**
   * Resolve all navigation joins by finding the correct path through the schema graph
   * This handles multi-level navigation like task.level.createdBy
   */
  private resolveJoinsForTableAliases(
    allTableAliases: Set<string>,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
    if (allTableAliases.size === 0) {
      return;
    }

    // Keep resolving until we've resolved all aliases or can't make progress
    const resolved = new Set<string>();
    let maxIterations = allTableAliases.size * 3; // Prevent infinite loops

    while (resolved.size < allTableAliases.size && maxIterations-- > 0) {
      // Build a map of already joined schemas for path resolution
      const joinedSchemas = new Map<string, TableSchema>();
      joinedSchemas.set(this.schema.name, this.schema);

      for (const join of joins) {
        let schema: TableSchema | undefined;
        if (this.schemaRegistry) {
          schema = this.schemaRegistry.get(join.targetTable);
        }
        if (schema) {
          joinedSchemas.set(join.alias, schema);
        }
      }

      // Try to resolve each unresolved alias
      for (const alias of allTableAliases) {
        if (resolved.has(alias) || joins.some(j => j.alias === alias)) {
          resolved.add(alias);
          continue;
        }

        // Look for this alias in any of the already joined schemas
        for (const [sourceAlias, schema] of joinedSchemas) {
          if (schema.relations && schema.relations[alias]) {
            const relation = schema.relations[alias];
            if (relation.type === 'one') {
              // Get target schema
              let targetSchema: TableSchema | undefined;
              let targetSchemaName: string | undefined;

              if (this.schemaRegistry) {
                targetSchema = this.schemaRegistry.get(relation.targetTable);
                targetSchemaName = targetSchema?.schema;
              }
              if (!targetSchema && relation.targetTableBuilder) {
                targetSchema = relation.targetTableBuilder.build();
                targetSchemaName = targetSchema?.schema;
              }

              joins.push({
                alias,
                targetTable: relation.targetTable,
                targetSchema: targetSchemaName,
                foreignKeys: relation.foreignKeys || [relation.foreignKey || ''],
                matches: relation.matches || ['id'],
                isMandatory: relation.isMandatory ?? false,
                sourceAlias,  // Track where this join comes from
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
   * Add a JOIN for a FieldRef if it references a related table
   * @deprecated Use detectAndAddJoinsFromSelection with multi-level resolution instead
   */
  private addJoinForFieldRef(fieldRef: any, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>): void {
    if (!fieldRef || typeof fieldRef !== 'object' || !('__tableAlias' in fieldRef) || !('__dbColumnName' in fieldRef)) {
      return;
    }

    const tableAlias = fieldRef.__tableAlias as string;
    if (tableAlias && tableAlias !== this.schema.name && !joins.some(j => j.alias === tableAlias)) {
      // This references a related table - find the relation and add a JOIN
      const relation = this.schema.relations[tableAlias];
      if (relation && relation.type === 'one') {
        // Get target schema from targetTableBuilder if available
        let targetSchema: string | undefined;
        if (relation.targetTableBuilder) {
          const targetTableSchema = relation.targetTableBuilder.build();
          targetSchema = targetTableSchema.schema;
        }

        // Add a JOIN for this reference
        joins.push({
          alias: tableAlias,
          targetTable: relation.targetTable,
          targetSchema,
          foreignKeys: relation.foreignKeys || [relation.foreignKey || ''],
          matches: relation.matches || [],
          isMandatory: relation.isMandatory ?? false,
        });
      }
    }
  }

  /**
   * Detect navigation property references in a WHERE condition and add necessary JOINs
   */
  private detectAndAddJoinsFromCondition(condition: Condition | undefined, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>): void {
    if (!condition) {
      return;
    }

    // Collect all table aliases from the condition
    const allTableAliases = new Set<string>();
    const fieldRefs = condition.getFieldRefs();

    for (const fieldRef of fieldRefs) {
      if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
        const tableAlias = fieldRef.__tableAlias as string;
        if (tableAlias !== this.schema.name) {
          allTableAliases.add(tableAlias);
        }
      }
      // Also collect intermediate navigation aliases for multi-level navigation (e.g., task.level.name)
      // The field ref may have __navigationAliases containing all aliases in the path
      if ('__navigationAliases' in fieldRef && Array.isArray((fieldRef as any).__navigationAliases)) {
        for (const navAlias of (fieldRef as any).__navigationAliases) {
          if (navAlias && navAlias !== this.schema.name) {
            allTableAliases.add(navAlias);
          }
        }
      }
    }

    // Resolve all joins through the schema graph
    this.resolveJoinsForTableAliases(allTableAliases, joins);
  }

  /**
   * Build SQL query
   */
  private buildQuery(selection: any, context: QueryContext): { sql: string; params: any[]; nestedPaths: Set<string> } {
    // Handle user-defined CTEs first - their params need to come before main query params
    for (const cte of this.ctes) {
      context.allParams.push(...cte.params);
      context.paramCounter += cte.params.length;
    }

    const selectParts: string[] = [];
    const collectionFields: Array<{ name: string; cteName: string; isCTE: boolean; joinClause?: string; selectExpression?: string }> = [];
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    const nestedPaths: Set<string> = new Set(); // Track nested object paths for JS-side reconstruction

    // Scan selection for navigation property references and add JOINs
    this.detectAndAddJoinsFromSelection(selection, joins);

    // Scan WHERE condition for navigation property references and add JOINs
    this.detectAndAddJoinsFromCondition(this.whereCond, joins);

    // Handle case where selection is a single value (not an object with properties)
    if (selection instanceof SqlFragment) {
      // Single SQL fragment - just build it directly
      const sqlBuildContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const fragmentSql = selection.buildSql(sqlBuildContext);
      context.paramCounter = sqlBuildContext.paramCounter;
      selectParts.push(fragmentSql);
    } else if (typeof selection === 'object' && selection !== null && '__dbColumnName' in selection) {
      // Single FieldRef
      const tableAlias = ('__tableAlias' in selection && selection.__tableAlias) ? selection.__tableAlias as string : this.schema.name;
      selectParts.push(`"${tableAlias}"."${selection.__dbColumnName}"`);
    } else if (selection instanceof CollectionQueryBuilder) {
      // This shouldn't happen in normal flow, but handle it
      throw new Error('Cannot use CollectionQueryBuilder directly as selection');
    } else {
      // Process selection object properties
      for (const [key, value] of Object.entries(selection)) {
        if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
          // Handle collection - delegate to strategy pattern via buildCTE
          // The strategy handles CTE/LATERAL specifics and returns necessary info
          const cteData = (value as any).buildCTE ? (value as any).buildCTE(context) : (value as CollectionQueryBuilder<any>).buildCTE(context);
          const isCTE = cteData.isCTE !== false; // Default to CTE if not specified

          // Note: For CTE strategy, context.ctes is already populated by the strategy
          // We don't need to add it again - the strategy has already done this

          collectionFields.push({
            name: key,
            cteName: cteData.tableName || `cte_${context.cteCounter - 1}`, // Use tableName from result or infer from counter
            isCTE,
            joinClause: cteData.joinClause,
            selectExpression: cteData.selectExpression,
          });
        } else if (value instanceof Subquery || (value && typeof value === 'object' && 'buildSql' in value && typeof (value as any).buildSql === 'function' && '__mode' in value)) {
          // Handle Subquery - build SQL and wrap in parentheses
          // Check both instanceof and duck typing for Subquery
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const subquerySql = (value as Subquery).buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`(${subquerySql}) as "${key}"`);
        } else if (value instanceof SqlFragment) {
          // SQL Fragment - build the SQL expression
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const fragmentSql = value.buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`${fragmentSql} as "${key}"`);
        } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
          // FieldRef object - check if it has a table alias (from navigation)
          if ('__tableAlias' in value && value.__tableAlias && typeof value.__tableAlias === 'string') {
            // This is a field from a joined table
            const tableAlias = value.__tableAlias as string;
            const columnName = value.__dbColumnName as string;

            // Find the relation config for this navigation
            const relConfig = this.schema.relations[tableAlias];
            if (relConfig) {
              // Add JOIN if not already added
              if (!joins.find(j => j.alias === tableAlias)) {
                // Get target schema from targetTableBuilder if available
                let targetSchema: string | undefined;
                if (relConfig.targetTableBuilder) {
                  const targetTableSchema = relConfig.targetTableBuilder.build();
                  targetSchema = targetTableSchema.schema;
                }

                joins.push({
                  alias: tableAlias,
                  targetTable: relConfig.targetTable,
                  targetSchema,
                  foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
                  matches: relConfig.matches || [],
                  isMandatory: relConfig.isMandatory ?? false,
                });
              }
            }

            // Check if this is a CTE aggregation column that needs COALESCE
            const cteJoin = this.manualJoins.find(j => j.cte && j.cte.name === tableAlias);
            if (cteJoin && cteJoin.cte && cteJoin.cte.isAggregationColumn(columnName)) {
              // CTE aggregation column - wrap with COALESCE to return empty array instead of null
              selectParts.push(`COALESCE("${tableAlias}"."${columnName}", '[]'::json) as "${key}"`);
            } else {
              selectParts.push(`"${tableAlias}"."${columnName}" as "${key}"`);
            }
          } else {
            // Regular field from the main table
            selectParts.push(`"${this.schema.name}"."${value.__dbColumnName}" as "${key}"`);
          }
        } else if (typeof value === 'string') {
          // Simple column reference (for backward compatibility or direct usage)
          selectParts.push(`"${this.schema.name}"."${value}" as "${key}"`);
        } else if (typeof value === 'object' && value !== null) {
          // Check if this is a navigation property mock or placeholder
          if (!('__dbColumnName' in value)) {
            // This is not a FieldRef - check if it's a navigation property mock or array
            if (Array.isArray(value)) {
              // Skip arrays (empty navigation placeholders)
              continue;
            }
            // Check if it's a CollectionQueryBuilder or ReferenceQueryBuilder instance
            if (value instanceof CollectionQueryBuilder) {
              // Skip collection query builders that haven't been resolved
              continue;
            } else if (value instanceof ReferenceQueryBuilder) {
              // Handle ReferenceQueryBuilder - select all fields from the target table
              const targetSchema = value.getTargetTableSchema();
              const alias = value.getAlias();

              if (targetSchema) {
                // Add JOIN if not already added
                if (!joins.find(j => j.alias === alias)) {
                  // Get target schema name from targetSchema
                  let targetTableSchema: string | undefined;
                  if (targetSchema.schema) {
                    targetTableSchema = targetSchema.schema;
                  }

                  joins.push({
                    alias,
                    targetTable: value.getTargetTable(),
                    targetSchema: targetTableSchema,
                    foreignKeys: value.getForeignKeys(),
                    matches: value.getMatches(),
                    isMandatory: value.getIsMandatory(),
                  });
                }

                // Select all columns from the target table and group them
                // We'll need to use JSON object building in SQL
                const fieldParts: string[] = [];
                // Performance: Use cached column name map
                const targetColMap = getColumnNameMapForSchema(targetSchema);
                for (const [colKey, dbColName] of targetColMap) {
                  fieldParts.push(`'${colKey}', "${alias}"."${dbColName}"`);
                }

                selectParts.push(`json_build_object(${fieldParts.join(', ')}) as "${key}"`);
              } else {
                // No target schema available, skip
                continue;
              }
            }
            // Check if it's a mock object with property descriptors (navigation property mock)
            const props = Object.getOwnPropertyNames(value);
            if (props.length > 0) {
              const firstProp = props[0];
              const descriptor = Object.getOwnPropertyDescriptor(value, firstProp);
              if (descriptor && descriptor.get) {
                // This object has getter properties - likely a navigation mock
                // Try to determine if this is a reference navigation by checking the schema relations
                const tableAlias = Object.keys(value).find(k => {
                  const desc = Object.getOwnPropertyDescriptor(value, k);
                  return desc && desc.get && typeof desc.get === 'function';
                });

                if (tableAlias) {
                  // Try to get the first property to check if it has __tableAlias
                  try {
                    const firstValue = (value as any)[tableAlias];
                    if (firstValue && typeof firstValue === 'object' && '__tableAlias' in firstValue) {
                      const alias = firstValue.__tableAlias as string;
                      const relConfig = this.schema.relations[alias];

                      if (relConfig && relConfig.type === 'one') {
                        // This is a reference navigation - select all fields from the target table
                        // Performance: Use cached target schema
                        const targetSchema = getTargetSchemaForRelation(this.schema, alias, relConfig);

                        if (targetSchema) {
                          // Add JOIN if not already added
                          if (!joins.find(j => j.alias === alias)) {
                            let targetTableSchema: string | undefined;
                            if (targetSchema.schema) {
                              targetTableSchema = targetSchema.schema;
                            }

                            joins.push({
                              alias,
                              targetTable: relConfig.targetTable,
                              targetSchema: targetTableSchema,
                              foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
                              matches: relConfig.matches || [],
                              isMandatory: relConfig.isMandatory ?? false,
                            });
                          }

                          // Select all columns from the target table and group them into a JSON object
                          const fieldParts: string[] = [];
                          // Performance: Use cached column name map
                          const targetColMap = getColumnNameMapForSchema(targetSchema);
                          for (const [colKey, dbColName] of targetColMap) {
                            fieldParts.push(`'${colKey}', "${alias}"."${dbColName}"`);
                          }

                          selectParts.push(`json_build_object(${fieldParts.join(', ')}) as "${key}"`);
                          continue;
                        }
                      }
                    }
                  } catch (e) {
                    // If accessing the property fails, just skip this navigation
                  }
                }

                // Default: skip this navigation mock
                continue;
              }
            }

            // Check if this is a plain nested object containing FieldRefs
            // e.g., address: { street: p.street, city: p.city }
            // Use flat select with path-encoded aliases for better performance
            const handled = this.tryBuildFlatNestedSelect(value, context, joins, selectParts, `__nested__${key}`, nestedPaths);
            if (handled) {
              continue;
            }

            // Check if this is a nested object with collections inside
            // e.g., content: { posts: u.posts!.toList() }
            // In this case, we need to handle it specially:
            // - Build the non-collection parts with flat select
            // - Let collections be handled by the collection handler
            if (this.hasNestedCollections(value)) {
              // Build flat select for non-collection parts of the nested object
              this.tryBuildFlatNestedSelectExcludingCollections(value, context, joins, selectParts, `__nested__${key}`, nestedPaths, collectionFields);
              continue;
            }
          }
          // Otherwise, treat as literal value
          selectParts.push(`$${context.paramCounter++} as "${key}"`);
          context.allParams.push(value);
        } else if (value === undefined) {
          // Skip undefined values (navigation property placeholders)
          continue;
        } else {
          // Literal value or expression
          selectParts.push(`$${context.paramCounter++} as "${key}"`);
          context.allParams.push(value);
        }
      } // End of for loop
    } // End of else block

    // Add collection fields as JSON/array aggregations joined from CTEs or LATERAL joins
    for (const { name, cteName, selectExpression } of collectionFields) {
      // If selectExpression is provided (from strategy), use it directly
      if (selectExpression) {
        selectParts.push(`${selectExpression} as "${name}"`);
        continue;
      }

      // Fallback to old logic for backward compatibility
      // Get the collection value - handle both top-level and nested paths
      // For nested paths like "__nested__activity__postCount", we need to navigate the selection object
      let collectionValue: any;
      if (name.startsWith('__nested__')) {
        // Parse the nested path and navigate to the collection
        const pathParts = name.substring('__nested__'.length).split('__');
        collectionValue = selection;
        for (const part of pathParts) {
          if (collectionValue && typeof collectionValue === 'object') {
            collectionValue = collectionValue[part];
          } else {
            collectionValue = undefined;
            break;
          }
        }
      } else {
        collectionValue = selection[name];
      }

      // Check if this is an array aggregation (from toNumberList/toStringList)
      const isArrayAgg = collectionValue && typeof collectionValue === 'object' && 'isArrayAggregation' in collectionValue && collectionValue.isArrayAggregation();

      // Check if this is a scalar aggregation (count, sum, max, min)
      const isScalarAgg = collectionValue instanceof CollectionQueryBuilder &&
        collectionValue.isScalarAggregation();

      if (isScalarAgg) {
        // For scalar aggregations, handle COUNT vs other aggregations differently
        // COUNT should default to 0, while MAX/MIN/SUM should remain NULL
        const aggregationType = collectionValue.getAggregationType();
        if (aggregationType === 'COUNT') {
          selectParts.push(`COALESCE("${cteName}".data, 0) as "${name}"`);
        } else {
          // For MAX/MIN/SUM, keep NULL as-is
          selectParts.push(`"${cteName}".data as "${name}"`);
        }
      } else if (isArrayAgg) {
        // For array aggregation, determine the array type from flattenResultType
        const flattenType = (collectionValue as any).getFlattenResultType?.() || 'string';
        const arrayType = flattenType === 'number' ? 'integer[]' : 'text[]';
        selectParts.push(`COALESCE("${cteName}".data, ARRAY[]::${arrayType}) as "${name}"`);
      } else {
        // For JSON aggregation, use json type for better performance
        selectParts.push(`COALESCE("${cteName}".data, '[]'::json) as "${name}"`);
      }
    }

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...params);
      // Update placeholders from the condition builder (for prepared statements)
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      // Performance: Pre-compute column name map for ORDER BY lookups
      const colNameMap = getColumnNameMapForSchema(this.schema);
      const orderParts = this.orderByFields.map(
        ({ field, direction }) => {
          // Check if the field is in the selection (after a select() call)
          // If so, reference it as an alias, otherwise use table.column notation
          if (selection && typeof selection === 'object' && !Array.isArray(selection) && field in selection) {
            // Field is in the selected output, use it as an alias
            return `"${field}" ${direction}`;
          } else {
            // Field is not in the selection, use table.column notation
            // Look up the database column name from the schema
            const dbColumnName = colNameMap.get(field) ?? field;
            return `"${this.schema.name}"."${dbColumnName}" ${direction}`;
          }
        }
      );
      orderByClause = `ORDER BY ${orderParts.join(', ')}`;
    }

    // Build LIMIT/OFFSET
    let limitClause = '';
    if (this.limitValue !== undefined) {
      limitClause = `LIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== undefined) {
      limitClause += ` OFFSET ${this.offsetValue}`;
    }

    // Build final query with CTEs
    let finalQuery = '';

    const allCtes: string[] = [];

    // Add user-defined CTEs (from .with() method)
    // Note: CTE params were already added to context.allParams at the start of buildQuery
    for (const cte of this.ctes) {
      allCtes.push(`"${cte.name}" AS (${cte.query})`);
    }

    // Add generated CTEs (from collection queries)
    if (context.ctes.size > 0) {
      for (const [cteName, { sql }] of context.ctes.entries()) {
        allCtes.push(`"${cteName}" AS (${sql})`);
      }
    }

    if (allCtes.length > 0) {
      finalQuery = `WITH ${allCtes.join(', ')}\n`;
    }

    // Build main query
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    let fromClause = `FROM ${qualifiedTableName}`;

    // Add manual JOINs (from leftJoin/innerJoin methods)
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';

      // Build ON condition
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      // Check if this is a CTE join
      if (manualJoin.cte) {
        // Join with CTE - use CTE name directly
        fromClause += `\n${joinTypeStr} "${manualJoin.cte.name}" ON ${condSql}`;
      } else if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        // Build the subquery SQL
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;

        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        // Regular table join
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for single navigation (references)
    for (const join of joins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      // Build ON clause for the join
      // For multi-level navigation, use the sourceAlias (the intermediate table)
      // For direct navigation, use the main table name
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      // Use schema-qualified table name if schema is specified
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Join CTEs and LATERAL subqueries for collections
    for (const { cteName, isCTE, joinClause } of collectionFields) {
      if (isCTE) {
        // CTE strategy - join by parent_id
        fromClause += `\nLEFT JOIN "${cteName}" ON "${cteName}".parent_id = ${qualifiedTableName}.id`;
      } else if (joinClause) {
        // LATERAL strategy - use the provided join clause (contains full LATERAL subquery)
        fromClause += `\n${joinClause}`;
      }
    }

    // Add DISTINCT if needed
    const distinctClause = this.isDistinct ? 'DISTINCT ' : '';
    finalQuery += `SELECT ${distinctClause}${selectParts.join(', ')}\n${fromClause}\n${whereClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
      nestedPaths,
    };
  }

  /**
   * Build the core SQL query, optionally excluding ORDER BY, LIMIT, and OFFSET
   * Used by buildUnionSql to build component queries for UNION
   * @internal
   */
  private buildQueryCore(selection: any, context: QueryContext, includeOrderLimitOffset: boolean = true): { sql: string; params: any[]; nestedPaths: Set<string> } {
    // Handle user-defined CTEs first - their params need to come before main query params
    for (const cte of this.ctes) {
      context.allParams.push(...cte.params);
      context.paramCounter += cte.params.length;
    }

    const selectParts: string[] = [];
    const collectionFields: Array<{ name: string; cteName: string; isCTE: boolean; joinClause?: string; selectExpression?: string }> = [];
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    const nestedPaths: Set<string> = new Set();

    // Scan selection for navigation property references and add JOINs
    this.detectAndAddJoinsFromSelection(selection, joins);

    // Scan WHERE condition for navigation property references and add JOINs
    this.detectAndAddJoinsFromCondition(this.whereCond, joins);

    // Handle case where selection is a single value (not an object with properties)
    if (selection instanceof SqlFragment) {
      const sqlBuildContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const fragmentSql = selection.buildSql(sqlBuildContext);
      context.paramCounter = sqlBuildContext.paramCounter;
      selectParts.push(fragmentSql);
    } else if (typeof selection === 'object' && selection !== null && '__dbColumnName' in selection) {
      const tableAlias = ('__tableAlias' in selection && selection.__tableAlias) ? selection.__tableAlias as string : this.schema.name;
      selectParts.push(`"${tableAlias}"."${selection.__dbColumnName}"`);
    } else if (selection instanceof CollectionQueryBuilder) {
      throw new Error('Cannot use CollectionQueryBuilder directly as selection');
    } else {
      // Process selection object properties
      for (const [key, value] of Object.entries(selection)) {
        if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
          // Collection fields are not supported in UNION queries for simplicity
          // Skip them - they would need complex handling
          continue;
        } else if (value instanceof Subquery || (value && typeof value === 'object' && 'buildSql' in value && typeof (value as any).buildSql === 'function' && '__mode' in value)) {
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const subquerySql = (value as Subquery).buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`(${subquerySql}) as "${key}"`);
        } else if (value instanceof SqlFragment) {
          const sqlBuildContext = {
            paramCounter: context.paramCounter,
            params: context.allParams,
          };
          const fragmentSql = value.buildSql(sqlBuildContext);
          context.paramCounter = sqlBuildContext.paramCounter;
          selectParts.push(`${fragmentSql} as "${key}"`);
        } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
          if ('__tableAlias' in value && value.__tableAlias && typeof value.__tableAlias === 'string') {
            const tableAlias = value.__tableAlias as string;
            const columnName = value.__dbColumnName as string;

            const relConfig = this.schema.relations[tableAlias];
            if (relConfig && !joins.find(j => j.alias === tableAlias)) {
              let targetSchema: string | undefined;
              if (relConfig.targetTableBuilder) {
                const targetTableSchema = relConfig.targetTableBuilder.build();
                targetSchema = targetTableSchema.schema;
              }
              joins.push({
                alias: tableAlias,
                targetTable: relConfig.targetTable,
                targetSchema,
                foreignKeys: relConfig.foreignKeys || [relConfig.foreignKey || ''],
                matches: relConfig.matches || [],
                isMandatory: relConfig.isMandatory ?? false,
              });
            }

            const cteJoin = this.manualJoins.find(j => j.cte && j.cte.name === tableAlias);
            if (cteJoin && cteJoin.cte && cteJoin.cte.isAggregationColumn(columnName)) {
              selectParts.push(`COALESCE("${tableAlias}"."${columnName}", '[]'::json) as "${key}"`);
            } else {
              selectParts.push(`"${tableAlias}"."${columnName}" as "${key}"`);
            }
          } else {
            selectParts.push(`"${this.schema.name}"."${value.__dbColumnName}" as "${key}"`);
          }
        } else if (typeof value === 'string') {
          selectParts.push(`"${this.schema.name}"."${value}" as "${key}"`);
        } else if (typeof value === 'object' && value !== null) {
          if (!('__dbColumnName' in value)) {
            if (Array.isArray(value)) {
              continue;
            }
            if (value instanceof CollectionQueryBuilder) {
              continue;
            } else if (value instanceof ReferenceQueryBuilder) {
              continue; // Skip ReferenceQueryBuilder in union queries
            }
          }
          selectParts.push(`$${context.paramCounter++} as "${key}"`);
          context.allParams.push(value);
        } else if (value === undefined) {
          continue;
        } else {
          selectParts.push(`$${context.paramCounter++} as "${key}"`);
          context.allParams.push(value);
        }
      }
    }

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build ORDER BY clause (only if includeOrderLimitOffset is true)
    let orderByClause = '';
    if (includeOrderLimitOffset && this.orderByFields.length > 0) {
      const colNameMap = getColumnNameMapForSchema(this.schema);
      const orderParts = this.orderByFields.map(
        ({ field, direction }) => {
          if (selection && typeof selection === 'object' && !Array.isArray(selection) && field in selection) {
            return `"${field}" ${direction}`;
          } else {
            const dbColumnName = colNameMap.get(field) ?? field;
            return `"${this.schema.name}"."${dbColumnName}" ${direction}`;
          }
        }
      );
      orderByClause = `ORDER BY ${orderParts.join(', ')}`;
    }

    // Build LIMIT/OFFSET (only if includeOrderLimitOffset is true)
    let limitClause = '';
    if (includeOrderLimitOffset) {
      if (this.limitValue !== undefined) {
        limitClause = `LIMIT ${this.limitValue}`;
      }
      if (this.offsetValue !== undefined) {
        limitClause += ` OFFSET ${this.offsetValue}`;
      }
    }

    // Build final query with CTEs
    let finalQuery = '';

    const allCtes: string[] = [];

    for (const cte of this.ctes) {
      allCtes.push(`"${cte.name}" AS (${cte.query})`);
    }

    if (context.ctes.size > 0) {
      for (const [cteName, { sql }] of context.ctes.entries()) {
        allCtes.push(`"${cteName}" AS (${sql})`);
      }
    }

    if (allCtes.length > 0) {
      finalQuery = `WITH ${allCtes.join(', ')}\n`;
    }

    // Build main query
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    let fromClause = `FROM ${qualifiedTableName}`;

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newParamCounter;
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      if (manualJoin.cte) {
        fromClause += `\n${joinTypeStr} "${manualJoin.cte.name}" ON ${condSql}`;
      } else if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for single navigation
    for (const join of joins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Add DISTINCT if needed
    const distinctClause = this.isDistinct ? 'DISTINCT ' : '';

    // Build final SQL
    const queryParts = [`SELECT ${distinctClause}${selectParts.join(', ')}`, fromClause];
    if (whereClause) queryParts.push(whereClause);
    if (orderByClause) queryParts.push(orderByClause);
    if (limitClause) queryParts.push(limitClause);

    finalQuery += queryParts.join('\n').trim();

    return {
      sql: finalQuery,
      params: context.allParams,
      nestedPaths,
    };
  }


  /**
   * Transform database results
   */
  private transformResults(rows: any[], selection: any): TSelection[] {
    if (rows.length === 0) {
      return [];
    }

    // Check if mappers are disabled for performance
    const disableMappers = this.executor?.getOptions().disableMappers ?? false;

    // Pre-analyze selection structure ONCE and categorize each field
    // This moves all type checks out of the per-row loop
    const schemaColumnCache = this.schema.columnMetadataCache;
    const fieldConfigs: Array<{
      key: string;
      type: number;
      value: any;
      mapper?: any;
      aggregationType?: string;
      innerMetadata?: any;
      collectionBuilder?: CollectionQueryBuilder<any>;
    }> = [];

    // Single pass to categorize all fields
    for (const key in selection) {
      const value = selection[key];

      // Check for navigation placeholders first (most common early exit)
      if (Array.isArray(value) && value.length === 0) {
        fieldConfigs.push({ key, type: FieldType.NAVIGATION, value: [] });
        continue;
      }
      if (value === undefined) {
        fieldConfigs.push({ key, type: FieldType.NAVIGATION, value: undefined });
        continue;
      }

      // Check for navigation property mocks (objects with getters)
      // These are treated as SIMPLE because the actual value comes from json_build_object in the row
      // The navigation mock is just a placeholder - actual data processing happens via FieldType.SIMPLE
      if (value && typeof value === 'object' && !('__dbColumnName' in value) && !('__fieldName' in value) && !('__collectionResult' in value) && !('__isAggregationArray' in value)) {
        const props = Object.getOwnPropertyNames(value);
        if (props.length > 0) {
          const descriptor = Object.getOwnPropertyDescriptor(value, props[0]);
          if (descriptor && descriptor.get) {
            // Navigation mock - treat as simple, data will come from row via json_build_object
            // If row has no data, convertValue will return undefined
            fieldConfigs.push({ key, type: FieldType.SIMPLE, value });
            continue;
          }
        }
      }

      // Collection types
      if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
        const isScalarAgg = value instanceof CollectionQueryBuilder && value.isScalarAggregation();
        if (isScalarAgg) {
          const aggregationType = value.getAggregationType();
          fieldConfigs.push({
            key,
            type: FieldType.COLLECTION_SCALAR,
            value,
            aggregationType
          });
        } else {
          const isArrayAgg = value && typeof value === 'object' && 'isArrayAggregation' in value && value.isArrayAggregation();
          const isSingleResult = value instanceof CollectionQueryBuilder && value.isSingleResult();
          if (isArrayAgg) {
            fieldConfigs.push({ key, type: FieldType.COLLECTION_ARRAY, value });
          } else if (isSingleResult) {
            fieldConfigs.push({
              key,
              type: FieldType.COLLECTION_SINGLE,
              value,
              collectionBuilder: value
            });
          } else {
            fieldConfigs.push({
              key,
              type: FieldType.COLLECTION_JSON,
              value,
              collectionBuilder: value instanceof CollectionQueryBuilder ? value : undefined
            });
          }
        }
        continue;
      }

      // CTE aggregation array
      if (typeof value === 'object' && value !== null && '__isAggregationArray' in value && (value as any).__isAggregationArray) {
        fieldConfigs.push({
          key,
          type: FieldType.CTE_AGGREGATION,
          value,
          innerMetadata: (value as any).__innerSelectionMetadata
        });
        continue;
      }

      // SqlFragment with mapper
      if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
        let mapper = disableMappers ? null : (value as any).getMapper();
        if (mapper && typeof mapper.getType === 'function') {
          mapper = mapper.getType();
        }
        if (mapper && typeof mapper.fromDriver === 'function') {
          fieldConfigs.push({ key, type: FieldType.SQL_FRAGMENT_MAPPER, value, mapper });
        } else {
          fieldConfigs.push({ key, type: FieldType.SIMPLE, value });
        }
        continue;
      }

      // FieldRef with potential mapper
      if (typeof value === 'object' && value !== null && '__fieldName' in value) {
        if (disableMappers) {
          fieldConfigs.push({ key, type: FieldType.FIELD_REF_NO_MAPPER, value });
        } else {
          const fieldName = value.__fieldName as string;
          const cached = schemaColumnCache?.get(fieldName);
          if (cached && cached.hasMapper) {
            fieldConfigs.push({ key, type: FieldType.FIELD_REF_MAPPER, value, mapper: cached.mapper });
          } else if (cached) {
            fieldConfigs.push({ key, type: FieldType.FIELD_REF_NO_MAPPER, value });
          } else {
            // Not in schema - treat as simple value
            fieldConfigs.push({ key, type: FieldType.SIMPLE, value });
          }
        }
        continue;
      }

      // Default: simple value
      fieldConfigs.push({ key, type: FieldType.SIMPLE, value });
    }

    // Transform each row using pre-analyzed field configs
    // Using while(i--) for maximum performance - decrement and compare to 0 is faster
    const results: TSelection[] = new Array(rows.length);
    const configCount = fieldConfigs.length;
    let rowIdx = rows.length;

    while (rowIdx--) {
      const row = rows[rowIdx];
      const result: any = {};
      let i = configCount;

      // Process all fields using pre-computed types
      while (i--) {
        const config = fieldConfigs[i];
        const key = config.key;

        // Handle navigation placeholders separately
        if (config.type === FieldType.NAVIGATION) {
          result[key] = config.value;
          continue;
        }

        const rawValue = row[key];

        switch (config.type) {
          case FieldType.COLLECTION_SCALAR: {
            if (config.aggregationType === 'COUNT') {
              result[key] = this.convertValue(rawValue);
            } else {
              // MAX/MIN/SUM: preserve NULL, convert numeric strings
              if (rawValue === null) {
                result[key] = null;
              } else if (typeof rawValue === 'string' && NUMERIC_REGEX.test(rawValue)) {
                result[key] = +rawValue;
              } else {
                result[key] = rawValue;
              }
            }
            break;
          }
          case FieldType.COLLECTION_ARRAY:
            result[key] = rawValue || [];
            break;
          case FieldType.COLLECTION_JSON: {
            const items = rawValue || [];
            if (config.collectionBuilder) {
              result[key] = this.transformCollectionItems(items, config.collectionBuilder);
            } else {
              result[key] = items;
            }
            break;
          }
          case FieldType.COLLECTION_SINGLE: {
            // firstOrDefault() - return single object or null
            // With CTE/LATERAL single result, rawValue is already a single object (not array)
            if (rawValue === null || rawValue === undefined) {
              result[key] = null;
            } else if (config.collectionBuilder) {
              // Transform the single item using collection mapper if available
              const transformedItems = this.transformCollectionItems([rawValue], config.collectionBuilder);
              result[key] = transformedItems[0] ?? null;
            } else {
              result[key] = rawValue;
            }
            break;
          }
          case FieldType.CTE_AGGREGATION: {
            const items = rawValue || [];
            if (config.innerMetadata && !disableMappers) {
              result[key] = this.transformCteAggregationItems(items, config.innerMetadata);
            } else {
              result[key] = items;
            }
            break;
          }
          case FieldType.SQL_FRAGMENT_MAPPER:
            // mapWith wraps user functions to handle null
            result[key] = config.mapper.fromDriver(rawValue);
            break;
          case FieldType.FIELD_REF_MAPPER:
            // Column mappers (customType) - null check done here
            result[key] = config.mapper.fromDriver(rawValue);
            break;
          case FieldType.FIELD_REF_NO_MAPPER:
            result[key] = rawValue;
            break;
          case FieldType.SIMPLE:
          default:
            result[key] = this.convertValue(rawValue);
            break;
        }
      }

      results[rowIdx] = result as TSelection;
    }

    return results;
  }

  /**
   * Convert database values: null to undefined, numeric strings to numbers
   */
  private convertValue(value: any): any {
    if (value === null) {
      return undefined;
    }
    // Check if it's a numeric string (PostgreSQL NUMERIC type)
    // This handles scalar subqueries with aggregates like AVG, SUM, etc.
    // The regex validates format, so Number() is guaranteed to produce a valid number
    if (typeof value === 'string' && NUMERIC_REGEX.test(value)) {
      return +value; // Faster than Number(value)
    }
    return value;
  }

  /**
   * Transform collection items applying fromDriver mappers
   */
  private transformCollectionItems(items: any[], collectionBuilder: CollectionQueryBuilder<any>): any[] {
    const targetSchema = collectionBuilder.getTargetTableSchema();
    if (!targetSchema) {
      return items;
    }

    // Check if mappers are disabled for performance
    const disableMappers = this.executor?.getOptions().disableMappers ?? false;

    if (disableMappers) {
      // Skip mapper transformation for performance - return items as-is
      return items;
    }

    // Use pre-cached column metadata from target schema
    // This avoids repeated column.build() calls for each item
    const columnCache = targetSchema.columnMetadataCache;

    // Build alias-to-field-info mapping from selected field configs
    // This allows us to find the correct mapper when:
    // 1. alias differs from property name (e.g., reservationExpiry: i.expiresAt)
    // 2. field comes from navigation (e.g., customerBirthdate: i.userEshop.birthdate)
    const selectedFieldConfigs = collectionBuilder.getSelectedFieldConfigs();
    interface FieldMapperInfo {
      propertyName: string;
      sourceTable?: string;  // If set, look up mapper from this table's schema
    }
    const aliasToFieldInfo = new Map<string, FieldMapperInfo>();
    if (selectedFieldConfigs) {
      for (const field of selectedFieldConfigs) {
        if (field.propertyName) {
          aliasToFieldInfo.set(field.alias, {
            propertyName: field.propertyName,
            sourceTable: field.sourceTable,
          });
        }
      }
    }

    // Pre-build mapper cache for all fields (including navigation fields)
    // This avoids repeated schema lookups per item
    const mapperCache = new Map<string, any>();  // alias -> mapper
    for (const [alias, fieldInfo] of aliasToFieldInfo) {
      let mapper: any = null;
      const schemaRegistry = collectionBuilder.getSchemaRegistry() || this.schemaRegistry;
      if (fieldInfo.sourceTable && schemaRegistry) {
        // Navigation field - look up mapper from the source table's schema
        const navSchema = schemaRegistry.get(fieldInfo.sourceTable);
        if (navSchema?.columnMetadataCache) {
          const cached = navSchema.columnMetadataCache.get(fieldInfo.propertyName);
          if (cached?.hasMapper) {
            mapper = cached.mapper;
          }
        }
      } else {
        // Regular field from target schema
        const cached = columnCache?.get(fieldInfo.propertyName);
        if (cached?.hasMapper) {
          mapper = cached.mapper;
        }
      }
      if (mapper) {
        mapperCache.set(alias, mapper);
      }
    }

    // Also add direct property matches from target schema (when no alias mapping)
    if (columnCache) {
      for (const [propertyName, cached] of columnCache) {
        if (!mapperCache.has(propertyName) && cached.hasMapper) {
          mapperCache.set(propertyName, cached.mapper);
        }
      }
    }

    // Build cache of nested collection info (fields that are themselves nested collections)
    // This is used for recursive transformation of nested collection results
    const nestedCollectionCache = new Map<string, { targetTable: string; selectedFieldConfigs?: SelectedField[]; isSingleResult?: boolean }>();
    if (selectedFieldConfigs) {
      for (const field of selectedFieldConfigs) {
        if (field.nestedCollectionInfo) {
          nestedCollectionCache.set(field.alias, field.nestedCollectionInfo);
        }
      }
    }

    // Get schema registry for nested collection transformation
    const schemaRegistry = collectionBuilder.getSchemaRegistry() || this.schemaRegistry;

    // Transform items using pre-built mapper cache
    const results: any[] = new Array(items.length);
    let i = items.length;
    while (i--) {
      const item = items[i];
      const transformedItem: any = {};
      for (const key in item) {
        const value = item[key];
        const mapper = mapperCache.get(key);
        if (mapper) {
          transformedItem[key] = mapper.fromDriver(value);
        } else {
          // Check if this field is a nested collection that needs recursive transformation
          const nestedInfo = nestedCollectionCache.get(key);
          if (nestedInfo && value !== null && value !== undefined && schemaRegistry) {
            transformedItem[key] = this.transformNestedCollectionValue(value, nestedInfo, schemaRegistry);
          } else {
            transformedItem[key] = value;
          }
        }
      }
      results[i] = transformedItem;
    }
    return results;
  }

  /**
   * Transform a nested collection value (from firstOrDefault or toList inside another collection)
   * Applies custom mappers to fields within the nested collection result.
   */
  private transformNestedCollectionValue(
    value: any,
    nestedInfo: { targetTable: string; selectedFieldConfigs?: SelectedField[]; isSingleResult?: boolean },
    schemaRegistry: Map<string, TableSchema>
  ): any {
    const nestedSchema = schemaRegistry.get(nestedInfo.targetTable);
    if (!nestedSchema?.columnMetadataCache) {
      return value;  // No schema info, return as-is
    }

    const columnCache = nestedSchema.columnMetadataCache;
    const selectedFieldConfigs = nestedInfo.selectedFieldConfigs;

    // Build mapper cache for nested collection fields
    const mapperCache = new Map<string, any>();

    // First, add mappers from selected field configs (for aliased/navigation fields)
    if (selectedFieldConfigs) {
      for (const field of selectedFieldConfigs) {
        if (field.propertyName) {
          let mapper: any = null;
          if (field.sourceTable) {
            // Navigation field - look up from source table's schema
            const navSchema = schemaRegistry.get(field.sourceTable);
            if (navSchema?.columnMetadataCache) {
              const cached = navSchema.columnMetadataCache.get(field.propertyName);
              if (cached?.hasMapper) {
                mapper = cached.mapper;
              }
            }
          } else {
            // Regular field from target schema
            const cached = columnCache.get(field.propertyName);
            if (cached?.hasMapper) {
              mapper = cached.mapper;
            }
          }
          if (mapper) {
            mapperCache.set(field.alias, mapper);
          }
        }
      }
    }

    // Also add direct property matches from target schema
    for (const [propertyName, cached] of columnCache) {
      if (!mapperCache.has(propertyName) && cached.hasMapper) {
        mapperCache.set(propertyName, cached.mapper);
      }
    }

    // Build cache for any deeply nested collections
    const deeplyNestedCache = new Map<string, { targetTable: string; selectedFieldConfigs?: SelectedField[]; isSingleResult?: boolean }>();
    if (selectedFieldConfigs) {
      for (const field of selectedFieldConfigs) {
        if (field.nestedCollectionInfo) {
          deeplyNestedCache.set(field.alias, field.nestedCollectionInfo);
        }
      }
    }

    // Transform the value(s)
    const transformItem = (item: any): any => {
      if (item === null || item === undefined) {
        return item;
      }
      const transformedItem: any = {};
      for (const key in item) {
        const fieldValue = item[key];
        const mapper = mapperCache.get(key);
        if (mapper) {
          transformedItem[key] = mapper.fromDriver(fieldValue);
        } else {
          // Check for deeply nested collections
          const deepNestedInfo = deeplyNestedCache.get(key);
          if (deepNestedInfo && fieldValue !== null && fieldValue !== undefined) {
            transformedItem[key] = this.transformNestedCollectionValue(fieldValue, deepNestedInfo, schemaRegistry);
          } else {
            transformedItem[key] = fieldValue;
          }
        }
      }
      return transformedItem;
    };

    if (nestedInfo.isSingleResult) {
      // Single item (firstOrDefault)
      return transformItem(value);
    } else if (Array.isArray(value)) {
      // Array of items (toList)
      return value.map(transformItem);
    } else {
      // Single object that should be treated as single result
      return transformItem(value);
    }
  }

  /**
   * Transform CTE aggregation items applying fromDriver mappers from selection metadata
   */
  private transformCteAggregationItems(items: any[], selectionMetadata: Record<string, any>): any[] {
    if (!items || items.length === 0) {
      return [];
    }

    // Use pre-cached column metadata from schema
    const schemaColumnCache = this.schema.columnMetadataCache;

    // Build mapper cache from selection metadata
    const mapperCache: Record<string, any> = {};
    for (const key in selectionMetadata) {
      const value = selectionMetadata[key];
      // Check if value has getMapper (SqlFragment or field with mapper)
      if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
        let mapper = (value as any).getMapper();
        // If mapper is a CustomTypeBuilder, get the actual type
        if (mapper && typeof mapper.getType === 'function') {
          mapper = mapper.getType();
        }
        if (mapper && typeof mapper.fromDriver === 'function') {
          mapperCache[key] = mapper;
        }
      }
      // Check if it's a FieldRef with schema column mapper
      else if (typeof value === 'object' && value !== null && '__fieldName' in value) {
        const fieldName = (value as any).__fieldName as string;
        // Use cached column metadata instead of column.build()
        if (schemaColumnCache) {
          const cached = schemaColumnCache.get(fieldName);
          if (cached && cached.hasMapper && typeof cached.mapper.fromDriver === 'function') {
            mapperCache[key] = cached.mapper;
          }
        } else {
          // Fallback for schemas without cache
          const column = this.schema.columns[fieldName];
          if (column) {
            const config = column.build();
            if (config.mapper && typeof config.mapper.fromDriver === 'function') {
              mapperCache[key] = config.mapper;
            }
          }
        }
      }
    }

    // Transform items using while(i--) loop - decrement and compare to 0 is fastest
    const results: any[] = new Array(items.length);
    let i = items.length;
    while (i--) {
      const item = items[i];
      const transformedItem: any = {};
      for (const key in item) {
        const value = item[key];
        const mapper = mapperCache[key];
        // Mappers handle null internally (mapWith wraps user functions)
        if (mapper) {
          transformedItem[key] = mapper.fromDriver(value);
        } else {
          transformedItem[key] = value;
        }
      }
      results[i] = transformedItem;
    }
    return results;
  }

  /**
   * Build aggregation query (MIN, MAX, SUM)
   */
  private buildAggregationQuery(aggregation: 'MIN' | 'MAX' | 'SUM', fieldToAggregate: any, context: QueryContext): { sql: string; params: any[] } {
    // Extract the field name from FieldRef object
    let fieldName: string;
    let tableAlias: string = this.schema.name;

    if (typeof fieldToAggregate === 'object' && fieldToAggregate !== null && '__dbColumnName' in fieldToAggregate) {
      fieldName = fieldToAggregate.__dbColumnName as string;
      if ('__tableAlias' in fieldToAggregate && fieldToAggregate.__tableAlias) {
        tableAlias = fieldToAggregate.__tableAlias as string;
      }
    } else if (typeof fieldToAggregate === 'string') {
      fieldName = fieldToAggregate;
    } else {
      throw new Error('Aggregation selector must return a field reference');
    }

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build FROM clause with JOINs
    let fromClause = `FROM "${this.schema.name}"`;

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newJoinParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newJoinParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      // Check if this is a subquery join
      if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    const sql = `SELECT ${aggregation}("${tableAlias}"."${fieldName}") as result\n${fromClause}\n${whereClause}`.trim();

    return {
      sql,
      params: context.allParams,
    };
  }

  /**
   * Build aggregate query (count or exists)
   */
  private buildAggregateQuery(context: QueryContext, type: 'count' | 'exists'): { sql: string; params: any[] } {
    // Detect navigation property joins from WHERE condition
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];
    this.detectAndAddJoinsFromCondition(this.whereCond, joins);

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders);
      whereClause = `WHERE ${sql}`;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Build FROM clause with JOINs
    const qualifiedTableName = this.getQualifiedTableName(this.schema.name, this.schema.schema);
    let fromClause = `FROM ${qualifiedTableName}`;

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, placeholders: joinPlaceholders, paramCounter: newJoinParamCounter } = condBuilder.build(manualJoin.condition, context.paramCounter, context.placeholders);
      context.paramCounter = newJoinParamCounter;  // Use returned counter (handles both params and placeholders)
      context.allParams.push(...condParams);
      if (joinPlaceholders) {
        context.placeholders = joinPlaceholders;
      }

      // Check if this is a subquery join
      if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Add JOINs for navigation properties referenced in WHERE clause
    for (const join of joins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      // Build ON clause for the join
      // For multi-level navigation, use the sourceAlias (the intermediate table)
      // For direct navigation, use the main table name
      const sourceTable = join.sourceAlias || this.schema.name;
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`${formatJoinValue(sourceTable, fk)} = ${formatJoinValue(join.alias, match)}`);
      }
      // Use schema-qualified table name if schema is specified
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Build SELECT clause based on type
    const selectClause = type === 'count'
      ? 'SELECT COUNT(*) as count'
      : 'SELECT EXISTS(SELECT 1';

    const sql = type === 'count'
      ? `${selectClause}\n${fromClause}\n${whereClause}`.trim()
      : `${selectClause}\n${fromClause}\n${whereClause})`.trim();

    return {
      sql,
      params: context.allParams,
    };
  }

  /**
   * Convert this query to a subquery that can be used in WHERE, SELECT, JOIN, or FROM clauses
   *
   * @template TMode - 'scalar' for single value, 'array' for column list, 'table' for full rows
   * @returns Subquery that maintains type safety
   *
   * @example
   * // Scalar subquery (returns single value)
   * const avgAge = db.users.select(u => u.age).asSubquery('scalar');
   *
   * // Array subquery (returns list of values for IN clause)
   * const activeUserIds = db.users
   *   .where(u => eq(u.isActive, true))
   *   .select(u => u.id)
   *   .asSubquery('array');
   *
   * // Table subquery (returns rows for FROM or JOIN)
   * const activeUsers = db.users
   *   .where(u => eq(u.isActive, true))
   *   .select(u => ({ id: u.id, name: u.username }))
   *   .asSubquery('table');
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<TMode extends 'scalar' ? ResolveFieldRefs<TSelection> : TMode extends 'array' ? ResolveFieldRefs<TSelection>[] : ResolveCollectionResults<TSelection>, TMode> {
    // Create a function that builds the subquery SQL when called
    const sqlBuilder = (outerContext: SqlBuildContext & { tableAlias?: string }): string => {
      // Create a fresh context for this subquery, inheriting placeholders from outer context
      const context: QueryContext = {
        ctes: new Map(),
        cteCounter: 0,
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
        placeholders: outerContext.placeholders,  // Pass placeholders through for prepared statements
        executor: this.executor,
      };

      // Analyze the selector to extract nested queries
      const mockRow = this._createMockRow();
      const selectionResult = this.selector(mockRow);

      // Build the query
      const { sql } = this.buildQuery(selectionResult, context);

      // Update the outer context's param counter
      outerContext.paramCounter = context.paramCounter;

      return sql;
    };

    // For table subqueries, preserve the selection metadata (includes SqlFragments with mappers)
    let selectionMetadata: Record<string, any> | undefined;
    if (mode === 'table') {
      const mockRow = this._createMockRow();
      selectionMetadata = this.selector(mockRow) as any;
    }

    // Extract outer field refs from the WHERE condition
    // These are field refs that reference tables other than this subquery's table
    // and need to be propagated to the outer query for JOIN detection
    const outerFieldRefs = this.extractOuterFieldRefs();

    return new Subquery(sqlBuilder, mode, selectionMetadata, outerFieldRefs) as any;
  }

  /**
   * Extract field refs from the WHERE condition that reference outer queries.
   * These are field refs with a __tableAlias that doesn't match this query's schema.
   */
  private extractOuterFieldRefs(): FieldRef[] {
    if (!this.whereCond) {
      return [];
    }

    const allRefs = this.whereCond.getFieldRefs();
    const outerRefs: FieldRef[] = [];
    const currentTableName = this.schema.name;

    for (const ref of allRefs) {
      // Check if this ref is from an outer query (different table alias)
      if ('__tableAlias' in ref && ref.__tableAlias) {
        const tableAlias = ref.__tableAlias as string;
        // If the table alias doesn't match our current schema, it's from an outer query
        // Also check if it's not a navigation property of this table (which would be in schema.relations)
        if (tableAlias !== currentTableName && !this.schema.relations[tableAlias]) {
          outerRefs.push(ref);
        }
      }
    }

    return outerRefs;
  }
}

/**
 * Marker interface for collection results - signals that this will be an array at runtime
 */
export interface CollectionResult<TItem> {
  readonly __collectionResult: true;
  readonly __itemType: TItem;
}

/**
 * Type helper to extract the value type from FieldRef
 * FieldRef<"id", number> becomes number
 */
type ExtractFieldValue<T> = T extends FieldRef<any, infer V>
  ? V
  : T;

/**
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object. See conditions.ts for detailed explanation.
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
 * Combined check for value types that should not be recursively processed
 */
type IsValueType<T> = IsClassInstance<T> extends true
  ? true
  : HasClassMethods<T> extends true
  ? true
  : false;

/**
 * Type helper to resolve all FieldRef and SqlFragment types to their value types
 * Recursively processes nested objects and arrays
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
export type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends SqlFragment<infer V>
  ? V
  : T extends CollectionResult<any>
  ? T  // Preserve CollectionResult for ResolveCollectionResults to handle
  : T extends Array<infer U>
  ? Array<ResolveFieldRefs<U>>
  : T extends (...args: any[]) => any
  ? T  // Preserve functions as-is
  : T extends object
  ? IsValueType<T> extends true
  ? T  // Preserve class instances (Date, Map, Set, Temporal, etc.) as-is
  : { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Type helper to resolve collection results to arrays
 * Transforms CollectionResult<T> to T[] and resolves FieldRef to their value types
 */
export type ResolveCollectionResults<T> = {
  [K in keyof T]: T[K] extends CollectionResult<infer TItem>
  ? ResolveFieldRefs<TItem>[]
  : ResolveFieldRefs<T[K]>;
};

/**
 * Reference query builder for single navigation (many-to-one, one-to-one)
 */
export class ReferenceQueryBuilder<TItem = any> {
  private relationName: string;
  private targetTable: string;
  private targetTableSchema?: TableSchema;
  private foreignKeys: string[];  // Column(s) in source table
  private matches: string[];      // Column(s) in target table
  private isMandatory: boolean;
  private schemaRegistry?: Map<string, TableSchema>;
  // Navigation path leading to this reference (for nested collections)
  private navigationPath: NavigationJoin[];
  // Source alias for this reference (the table containing the FK)
  private sourceAlias: string;

  constructor(
    relationName: string,
    targetTable: string,
    foreignKeys: string[],
    matches: string[],
    isMandatory: boolean,
    targetTableSchema?: TableSchema,
    schemaRegistry?: Map<string, TableSchema>,
    navigationPath?: NavigationJoin[],
    sourceAlias?: string
  ) {
    this.relationName = relationName;
    this.targetTable = targetTable;
    this.foreignKeys = foreignKeys;
    this.matches = matches;
    this.isMandatory = isMandatory;
    this.schemaRegistry = schemaRegistry;
    this.navigationPath = navigationPath || [];
    this.sourceAlias = sourceAlias || '';

    // Prefer registry lookup (has full relations) over passed schema
    if (this.schemaRegistry) {
      this.targetTableSchema = this.schemaRegistry.get(targetTable);
    }
    // Fallback to passed schema if registry lookup failed
    if (!this.targetTableSchema) {
      this.targetTableSchema = targetTableSchema;
    }
  }

  /**
   * Get the alias to use for this reference in the query
   */
  getAlias(): string {
    return this.relationName;
  }

  /**
   * Get target table name
   */
  getTargetTable(): string {
    return this.targetTable;
  }

  /**
   * Get foreign keys
   */
  getForeignKeys(): string[] {
    return this.foreignKeys;
  }

  /**
   * Get matches
   */
  getMatches(): string[] {
    return this.matches;
  }

  /**
   * Is this a mandatory relation (INNER JOIN vs LEFT JOIN)
   */
  getIsMandatory(): boolean {
    return this.isMandatory;
  }

  /**
   * Get target table schema
   */
  getTargetTableSchema(): TableSchema | undefined {
    return this.targetTableSchema;
  }

  /**
   * Create a mock object that exposes the target table's columns
   * This allows accessing related fields like: p.user.username
   */
  createMockTargetRow(): any {
    if (this.targetTableSchema) {
      const mock: any = {};
      // Add columns - use pre-computed column name map if available
      const columnNameMap = getColumnNameMapForSchema(this.targetTableSchema);

      // Performance: Lazy-cache FieldRef objects
      const fieldRefCache: Record<string, any> = {};
      const tableAlias = this.relationName;

      // Build a mapper lookup for columns (only when needed)
      const columnMappers: Record<string, any> = {};
      for (const [colName, colBuilder] of Object.entries(this.targetTableSchema.columns)) {
        const config = (colBuilder as any).build();
        if (config.mapper) {
          columnMappers[colName] = config.mapper;
        }
      }

      const sourceTable = this.targetTable;  // Actual table name for schema lookup
      // Collect all navigation aliases from the path leading to this reference
      // This is needed for WHERE conditions that use multi-level navigation (e.g., task.level.name)
      const navigationAliases = this.navigationPath.map(nav => nav.alias);

      for (const [colName, dbColumnName] of columnNameMap) {
        const mapper = columnMappers[colName];
        Object.defineProperty(mock, colName, {
          get() {
            let cached = fieldRefCache[colName];
            if (!cached) {
              cached = fieldRefCache[colName] = {
                __fieldName: colName,
                __dbColumnName: dbColumnName,
                __tableAlias: tableAlias,  // Alias for SQL generation
                __sourceTable: sourceTable,  // Actual table name for mapper lookup
                __mapper: mapper,  // Include mapper for toDriver transformation in conditions
                __navigationAliases: navigationAliases,  // All intermediate navigation aliases for JOIN resolution
              };
            }
            return cached;
          },
          enumerable: true,
          configurable: true,
        });
      }

      // Build extended navigation path for nested collections
      // Only build navigation path if we have a sourceAlias (meaning we're inside a collection's selector)
      // If sourceAlias is empty, we're in the main query and references are joined in the FROM clause
      let extendedNavPath: NavigationJoin[] = [];
      if (this.sourceAlias) {
        // Build the current navigation step to include in path for nested collections
        // This represents the join from sourceAlias to this.relationName (this.targetTable)
        const currentNavStep: NavigationJoin = {
          alias: this.relationName,
          targetTable: this.targetTable,
          foreignKeys: this.foreignKeys,
          matches: this.matches.length > 0 ? this.matches : ['id'],  // Default to 'id' if not specified
          isMandatory: this.isMandatory,
          sourceAlias: this.sourceAlias,
        };
        extendedNavPath = [...this.navigationPath, currentNavStep];
      }

      // Add navigation properties (both collections and references)
      if (this.targetTableSchema.relations) {
        for (const [relName, relConfig] of Object.entries(this.targetTableSchema.relations)) {
          // Try to get target schema from registry (preferred, has full relations) or targetTableBuilder
          let nestedTargetSchema: TableSchema | undefined;
          if (this.schemaRegistry) {
            nestedTargetSchema = this.schemaRegistry.get(relConfig.targetTable);
          }
          if (!nestedTargetSchema && relConfig.targetTableBuilder) {
            nestedTargetSchema = relConfig.targetTableBuilder.build();
          }

          if (relConfig.type === 'many') {
            // Collection navigation
            // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
            Object.defineProperty(mock, relName, {
              get: () => {
                const fk = relConfig.foreignKey || relConfig.foreignKeys?.[0] || '';
                return new CollectionQueryBuilder(
                  relName,
                  relConfig.targetTable,
                  fk,
                  this.relationName,  // Use alias (relationName) for correlation in lateral joins
                  nestedTargetSchema,  // Pass the target schema directly
                  this.schemaRegistry,  // Pass schema registry for nested resolution
                  extendedNavPath  // Pass navigation path for intermediate joins (empty if main query)
                );
              },
              enumerable: false,
              configurable: true,
            });
          } else {
            // Reference navigation
            // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow
            // with circular relations like User->Posts->User)
            Object.defineProperty(mock, relName, {
              get: () => {
                const refBuilder = new ReferenceQueryBuilder(
                  relName,
                  relConfig.targetTable,
                  relConfig.foreignKeys || [relConfig.foreignKey || ''],
                  relConfig.matches || [],
                  relConfig.isMandatory ?? false,
                  nestedTargetSchema,  // Pass the target schema directly
                  this.schemaRegistry,  // Pass schema registry for nested resolution
                  extendedNavPath,  // Pass navigation path for nested collections
                  this.sourceAlias ? this.relationName : ''  // Only set source if tracking path
                );
                return refBuilder.createMockTargetRow();
              },
              enumerable: false,
              configurable: true,
            });
          }
        }
      }

      return mock;
    } else {
      // Fallback: use the shared nested proxy that supports deep property access
      return createNestedFieldRefProxy(this.relationName);
    }
  }
}

/**
 * Collection query builder for nested queries
 */
export class CollectionQueryBuilder<TItem = any> {
  private relationName: string;
  private targetTable: string;
  private targetTableSchema?: TableSchema;  // Optional schema for type-safe operations
  private foreignKey: string;
  private sourceTable: string;
  private selector?: (item: any) => any;
  private whereCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private asName?: string;
  private isMarkedAsList: boolean = false;
  private isDistinct: boolean = false;
  private aggregationType?: 'MIN' | 'MAX' | 'SUM' | 'COUNT';
  private flattenResultType?: 'number' | 'string';
  private schemaRegistry?: Map<string, TableSchema>;
  // Navigation path leading to this collection (for intermediate joins in lateral subqueries)
  private navigationPath: NavigationJoin[];

  // Performance: Cache the mock item to avoid recreating it
  private _cachedMockItem?: any;
  // Cache selected field configs for mapper lookup during transformation
  private _selectedFieldConfigs?: SelectedField[];

  constructor(
    relationName: string,
    targetTable: string,
    foreignKey: string,
    sourceTable: string,
    targetTableSchema?: TableSchema,
    schemaRegistry?: Map<string, TableSchema>,
    navigationPath?: NavigationJoin[]
  ) {
    this.relationName = relationName;
    this.targetTable = targetTable;
    this.targetTableSchema = targetTableSchema;
    this.foreignKey = foreignKey;
    this.sourceTable = sourceTable;
    this.schemaRegistry = schemaRegistry;
    this.navigationPath = navigationPath || [];

    // Prefer registry lookup (has full relations) over passed schema
    if (this.schemaRegistry) {
      const registrySchema = this.schemaRegistry.get(targetTable);
      if (registrySchema) {
        this.targetTableSchema = registrySchema;
      }
    }
    // Fallback to passed schema if registry lookup failed
    if (!this.targetTableSchema) {
      this.targetTableSchema = targetTableSchema;
    }
  }

  /**
   * Select specific fields from collection items
   */
  select<TSelection>(selector: (item: TItem) => TSelection): CollectionQueryBuilder<TSelection> {
    const newBuilder = new CollectionQueryBuilder<TSelection>(
      this.relationName,
      this.targetTable,
      this.foreignKey,
      this.sourceTable,
      this.targetTableSchema,
      this.schemaRegistry,  // Pass schema registry for nested navigation resolution
      this.navigationPath  // Pass navigation path for intermediate joins
    );
    newBuilder.selector = selector as any;
    newBuilder.whereCond = this.whereCond;
    newBuilder.limitValue = this.limitValue;
    newBuilder.offsetValue = this.offsetValue;
    newBuilder.orderByFields = this.orderByFields;
    newBuilder.asName = this.asName;
    newBuilder.isDistinct = this.isDistinct;
    return newBuilder;
  }

  /**
   * Select distinct fields from collection items
   */
  selectDistinct<TSelection>(selector: (item: TItem) => TSelection): CollectionQueryBuilder<TSelection> {
    const newBuilder = this.select(selector);
    newBuilder.isDistinct = true;
    return newBuilder;
  }

  /**
   * Filter collection items
   * Multiple where() calls are chained with AND logic
   */
  where(condition: (item: TItem) => Condition): this {
    // Create mock item with proper schema if available
    const mockItem = this.createMockItem();
    const newCondition = condition(mockItem);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
    }
    return this;
  }

  /**
   * Create a mock item for the target table with proper typing
   */
  private createMockItem(): any {
    // Performance: Return cached mock if available
    if (this._cachedMockItem) {
      return this._cachedMockItem;
    }

    if (this.targetTableSchema) {
      // If we have schema information, create a properly typed mock
      const mock: any = {};

      // Performance: Use pre-computed column name map if available
      const columnNameMap = getColumnNameMapForSchema(this.targetTableSchema);

      // Performance: Lazy-cache FieldRef objects
      const fieldRefCache: Record<string, any> = {};

      // Add columns - include tableAlias for unambiguous column references in WHERE clauses
      // Use a special marker alias for the collection's own table that can be rewritten later
      // This allows distinguishing between outer table references and inner collection references
      // when both target the same table (e.g., post.user.posts where both are "posts" table)
      const tableAlias = `__collection_${this.targetTable}__`;
      for (const [colName, dbColumnName] of columnNameMap) {
        Object.defineProperty(mock, colName, {
          get() {
            let cached = fieldRefCache[colName];
            if (!cached) {
              cached = fieldRefCache[colName] = {
                __fieldName: colName,
                __dbColumnName: dbColumnName,
                __tableAlias: tableAlias,  // Include table alias for unambiguous references
              };
            }
            return cached;
          },
          enumerable: true,
          configurable: true,
        });
      }

      // Add navigation properties (both collections and references)
      if (this.targetTableSchema.relations) {
        for (const [relName, relConfig] of Object.entries(this.targetTableSchema.relations)) {
          if (relConfig.type === 'many') {
            // Collection navigation
            // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
            Object.defineProperty(mock, relName, {
              get: () => {
                // Don't call build() - it returns schema without relations
                const fk = relConfig.foreignKey || relConfig.foreignKeys?.[0] || '';
                return new CollectionQueryBuilder(
                  relName,
                  relConfig.targetTable,
                  fk,
                  this.targetTable,
                  undefined,  // Don't pass schema, force registry lookup
                  this.schemaRegistry  // Pass schema registry for nested resolution
                  // No navigation path needed here - direct collection access from parent
                );
              },
              enumerable: false,
              configurable: true,
            });
          } else {
            // Reference navigation
            // Non-enumerable to prevent Object.entries triggering getters (avoids stack overflow)
            Object.defineProperty(mock, relName, {
              get: () => {
                // Don't call build() - it returns schema without relations
                // Instead, pass undefined and let ReferenceQueryBuilder look it up from registry
                const refBuilder = new ReferenceQueryBuilder(
                  relName,
                  relConfig.targetTable,
                  relConfig.foreignKeys || [relConfig.foreignKey || ''],
                  relConfig.matches || [],
                  relConfig.isMandatory ?? false,
                  undefined,  // Don't pass schema, force registry lookup
                  this.schemaRegistry,  // Pass schema registry for nested resolution
                  [],  // Empty navigation path - this is the first reference in the chain
                  this.targetTable  // Source alias is this collection's target table
                );
                return refBuilder.createMockTargetRow();
              },
              enumerable: false,
              configurable: true,
            });
          }
        }
      }

      // Cache the mock for reuse
      this._cachedMockItem = mock;
      return mock;
    } else {
      // Fallback: use the shared nested proxy that supports deep property access
      return createNestedFieldRefProxy(this.targetTable);
    }
  }

  /**
   * Limit collection items
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Offset collection items
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Order collection items
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (item: TItem) => T): this;
  orderBy<T>(selector: (item: TItem) => T[]): this;
  orderBy<T>(selector: (item: TItem) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (item: TItem) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockItem = this.createMockItem();
    const result = selector(mockItem);
    parseOrderBy(result, this.orderByFields);
    return this;
  }

  /**
   * Get minimum value (supports magic SQL in selector)
   */
  /**
   * Get minimum value (supports magic SQL in selector)
   * Returns SqlFragment for automatic type resolution in selectors
   */
  min<TSelection>(selector?: (item: TItem) => TSelection): SqlFragment<number | null> {
    if (selector && !this.selector) {
      const mockItem = this.createMockItem();
      this.selector = selector as any;
    }
    this.aggregationType = 'MIN';
    return this as unknown as SqlFragment<number | null>;
  }

  /**
   * Get maximum value (supports magic SQL in selector)
   * Returns SqlFragment for automatic type resolution in selectors
   */
  max<TSelection>(selector?: (item: TItem) => TSelection): SqlFragment<number | null> {
    if (selector && !this.selector) {
      const mockItem = this.createMockItem();
      this.selector = selector as any;
    }
    this.aggregationType = 'MAX';
    return this as unknown as SqlFragment<number | null>;
  }

  /**
   * Get sum value (supports magic SQL in selector)
   * Returns SqlFragment for automatic type resolution in selectors
   */
  sum<TSelection>(selector?: (item: TItem) => TSelection): SqlFragment<number | null> {
    if (selector && !this.selector) {
      const mockItem = this.createMockItem();
      this.selector = selector as any;
    }
    this.aggregationType = 'SUM';
    return this as unknown as SqlFragment<number | null>;
  }

  /**
   * Get count of items
   * Returns SqlFragment for automatic type resolution in selectors
   */
  count(): SqlFragment<number> {
    this.aggregationType = 'COUNT';
    return this as unknown as SqlFragment<number>;
  }

  /**
   * Flatten result to number array (for single-column selections)
   */
  toNumberList(name?: string): CollectionResult<number> {
    if (name) {
      this.asName = name;
    }
    this.flattenResultType = 'number';
    this.isMarkedAsList = true;
    return this as any as CollectionResult<number>;
  }

  /**
   * Flatten result to string array (for single-column selections)
   */
  toStringList(name?: string): CollectionResult<string> {
    if (name) {
      this.asName = name;
    }
    this.flattenResultType = 'string';
    this.isMarkedAsList = true;
    return this as any as CollectionResult<string>;
  }

  /**
   * Specify the property name for the collection in the result
   * Marks this collection to be resolved as an array in the final result
   */
  toList(name?: string): CollectionResult<TItem> {
    if (name) {
      this.asName = name;
    }
    this.isMarkedAsList = true;
    // Cast to CollectionResult for type inference
    // At runtime, this is still a CollectionQueryBuilder, but TypeScript sees it as CollectionResult
    return this as any as CollectionResult<TItem>;
  }

  /**
   * Get first item from collection or null if empty
   * Automatically applies LIMIT 1 and returns a single item instead of array
   */
  firstOrDefault(name?: string): CollectionResult<TItem | null> {
    if (name) {
      this.asName = name;
    }
    this.limitValue = 1;
    this.isMarkedAsList = false;  // Single item, not a list
    return this as any as CollectionResult<TItem | null>;
  }

  /**
   * Get target table schema
   */
  getTargetTableSchema(): TableSchema | undefined {
    return this.targetTableSchema;
  }

  /**
   * Get target table name
   */
  getTargetTable(): string {
    return this.targetTable;
  }

  /**
   * Get selected field configs (for mapper lookup during transformation)
   */
  getSelectedFieldConfigs(): SelectedField[] | undefined {
    return this._selectedFieldConfigs;
  }

  /**
   * Get schema registry (for mapper lookup during transformation of navigation fields)
   */
  getSchemaRegistry(): Map<string, TableSchema> | undefined {
    return this.schemaRegistry;
  }

  /**
   * Check if this collection uses array aggregation (for flattened results)
   */
  isArrayAggregation(): boolean {
    return this.flattenResultType !== undefined;
  }

  /**
   * Check if this is a scalar aggregation (count, sum, max, min)
   */
  isScalarAggregation(): boolean {
    return this.aggregationType !== undefined;
  }

  /**
   * Check if this is a single item result (firstOrDefault)
   */
  isSingleResult(): boolean {
    return !this.isMarkedAsList && this.limitValue === 1;
  }

  /**
   * Get the aggregation type
   */
  getAggregationType(): 'MIN' | 'MAX' | 'SUM' | 'COUNT' | undefined {
    return this.aggregationType;
  }

  /**
   * Get the flatten result type (for determining PostgreSQL array type)
   */
  getFlattenResultType(): 'number' | 'string' | undefined {
    return this.flattenResultType;
  }

  /**
   * Detect navigation property references in the selected fields and add necessary JOINs
   * This supports multi-level navigation like p.task.level.createdBy.username
   */
  private detectNavigationJoins(
    selection: any,
    joins: NavigationJoin[],
    currentSourceAlias: string,
    currentSchema: TableSchema
  ): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    // Collect all table aliases referenced in the selection
    const allTableAliases = new Set<string>();

    // Helper to collect from a single selection
    const collectFromSelection = (sel: any): void => {
      if (!sel || typeof sel !== 'object') {
        return;
      }

      // Handle single FieldRef
      if ('__tableAlias' in sel && '__dbColumnName' in sel) {
        this.addNavigationJoinForFieldRef(sel, joins, currentSourceAlias, currentSchema, allTableAliases);
        return;
      }

      // Handle object with multiple fields
      for (const [_key, value] of Object.entries(sel)) {
        if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
          // This is a FieldRef with a table alias
          this.addNavigationJoinForFieldRef(value, joins, currentSourceAlias, currentSchema, allTableAliases);
        } else if (value instanceof SqlFragment) {
          // SqlFragment may contain navigation property references
          const fieldRefs = value.getFieldRefs();
          for (const fieldRef of fieldRefs) {
            this.addNavigationJoinForFieldRef(fieldRef, joins, currentSourceAlias, currentSchema, allTableAliases);
          }
        } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof CollectionQueryBuilder)) {
          // Recursively check nested objects
          collectFromSelection(value);
        }
      }
    };

    // First pass: collect all table aliases
    collectFromSelection(selection);

    // Second pass: resolve all navigation joins by finding the correct path through schemas
    if (allTableAliases.size > 0) {
      this.resolveNavigationJoins(allTableAliases, joins, currentSchema);
    }
  }

  /**
   * Add a navigation JOIN for a FieldRef if it references a related table
   * Handles multi-level navigation by recursively resolving the join chain
   */
  private addNavigationJoinForFieldRef(
    fieldRef: any,
    joins: NavigationJoin[],
    sourceAlias: string,
    sourceSchema: TableSchema,
    allTableAliases: Set<string>
  ): void {
    if (!fieldRef || typeof fieldRef !== 'object' || !('__tableAlias' in fieldRef)) {
      return;
    }

    const tableAlias = fieldRef.__tableAlias as string;

    // If this references the target table directly, no join needed
    if (!tableAlias || tableAlias === this.targetTable) {
      return;
    }

    // Collect this table alias for later resolution
    allTableAliases.add(tableAlias);

    // Check if we already have this join
    if (joins.some(j => j.alias === tableAlias)) {
      return;
    }

    // Find the relation in the current schema
    const relation = sourceSchema.relations?.[tableAlias];
    if (relation && relation.type === 'one') {
      this.addNavigationJoin(tableAlias, relation, joins, sourceAlias);
    }
  }

  /**
   * Add a navigation join and return the target schema
   */
  private addNavigationJoin(
    alias: string,
    relation: any,
    joins: NavigationJoin[],
    sourceAlias: string
  ): TableSchema | undefined {
    // Check if already added
    if (joins.some(j => j.alias === alias)) {
      return undefined;
    }

    // Get the target table schema
    let targetSchema: TableSchema | undefined;
    let targetSchemaName: string | undefined;

    if (this.schemaRegistry) {
      targetSchema = this.schemaRegistry.get(relation.targetTable);
      targetSchemaName = targetSchema?.schema;
    }
    if (!targetSchema && relation.targetTableBuilder) {
      targetSchema = relation.targetTableBuilder.build();
      targetSchemaName = targetSchema?.schema;
    }

    // Build the join info
    const foreignKeys = relation.foreignKeys || [relation.foreignKey || ''];
    const matches = relation.matches || ['id'];  // Default to 'id' as the PK

    joins.push({
      alias,
      targetTable: relation.targetTable,
      targetSchema: targetSchemaName,
      foreignKeys,
      matches,
      isMandatory: relation.isMandatory ?? false,
      sourceAlias,
    });

    return targetSchema;
  }

  /**
   * Resolve all navigation joins by finding the correct path through the schema graph
   * This handles multi-level navigation like task.level.createdBy
   */
  private resolveNavigationJoins(
    allTableAliases: Set<string>,
    joins: NavigationJoin[],
    startSchema: TableSchema
  ): void {
    // Keep resolving until we've resolved all aliases or can't make progress
    let resolved = new Set<string>();
    let lastResolvedCount = -1;
    let maxIterations = 100; // Prevent infinite loops

    while (resolved.size < allTableAliases.size && resolved.size !== lastResolvedCount && maxIterations-- > 0) {
      lastResolvedCount = resolved.size;

      // Build a map of already joined schemas for path resolution
      const joinedSchemas = new Map<string, TableSchema>();
      joinedSchemas.set(this.targetTable, startSchema);

      for (const join of joins) {
        let schema: TableSchema | undefined;
        if (this.schemaRegistry) {
          schema = this.schemaRegistry.get(join.targetTable);
        }
        if (schema) {
          joinedSchemas.set(join.alias, schema);
        }
      }

      // Try to resolve each unresolved alias
      for (const alias of allTableAliases) {
        if (resolved.has(alias) || joins.some(j => j.alias === alias)) {
          resolved.add(alias);
          continue;
        }

        // First, look for this alias in any of the already joined schemas (direct lookup)
        let found = false;
        for (const [schemaAlias, schema] of joinedSchemas) {
          if (schema.relations && schema.relations[alias]) {
            const relation = schema.relations[alias];
            if (relation.type === 'one') {
              this.addNavigationJoin(alias, relation, joins, schemaAlias);
              resolved.add(alias);
              found = true;
              break;
            }
          }
        }

        // If not found directly, search transitively through all schemas in registry
        // to find an intermediate path
        if (!found && this.schemaRegistry) {
          const path = this.findNavigationPath(alias, joinedSchemas, startSchema);
          if (path.length > 0) {
            // Add all intermediate joins
            for (const step of path) {
              if (!joins.some(j => j.alias === step.alias)) {
                this.addNavigationJoin(step.alias, step.relation, joins, step.sourceAlias);
              }
            }
            resolved.add(alias);
          }
        }
      }
    }
  }

  /**
   * Find a path from already-joined schemas to the target alias
   * Uses BFS to find the shortest path through the schema graph
   */
  private findNavigationPath(
    targetAlias: string,
    joinedSchemas: Map<string, TableSchema>,
    _startSchema: TableSchema
  ): Array<{ alias: string; relation: any; sourceAlias: string }> {
    if (!this.schemaRegistry) {
      return [];
    }

    // BFS to find path from any joined schema to the target alias
    const queue: Array<{
      schemaAlias: string;
      schema: TableSchema;
      path: Array<{ alias: string; relation: any; sourceAlias: string }>;
    }> = [];

    // Start from all currently joined schemas
    for (const [schemaAlias, schema] of joinedSchemas) {
      queue.push({ schemaAlias, schema, path: [] });
    }

    const visited = new Set<string>();
    for (const [alias] of joinedSchemas) {
      visited.add(alias);
    }

    while (queue.length > 0) {
      const { schemaAlias, schema, path } = queue.shift()!;

      if (!schema.relations) {
        continue;
      }

      for (const [relName, relConfig] of Object.entries(schema.relations)) {
        if (relConfig.type !== 'one') {
          continue; // Only follow reference (one-to-one/many-to-one) relations
        }

        if (visited.has(relName)) {
          continue;
        }

        const newPath = [...path, { alias: relName, relation: relConfig, sourceAlias: schemaAlias }];

        // Found the target!
        if (relName === targetAlias) {
          return newPath;
        }

        // Continue searching through this relation's schema
        visited.add(relName);
        const nextSchema = this.schemaRegistry.get(relConfig.targetTable);
        if (nextSchema) {
          queue.push({ schemaAlias: relName, schema: nextSchema, path: newPath });
        }
      }
    }

    return []; // No path found
  }

  /**
   * Build CTE for this collection query
   * Now delegates to collection strategy pattern
   * Returns full CollectionAggregationResult for strategies that need special handling (like LATERAL)
   */
  buildCTE(context: QueryContext, client?: DatabaseClient, parentIds?: any[]): { sql: string; params: any[]; isCTE?: boolean; joinClause?: string; selectExpression?: string; tableName?: string } {
    // Determine strategy type - default to 'lateral' if not specified
    const strategyType: CollectionStrategyType = context.collectionStrategy || 'lateral';
    const strategy = CollectionStrategyFactory.getStrategy(strategyType);

    // For LATERAL strategy, reserve the counter early and register the table alias
    // This allows nested collections to reference this collection's aliased table
    let reservedCounter: number | undefined;
    let previousTableAlias: string | undefined;  // For restoring after build
    let hadPreviousEntry = false;
    if (strategyType === 'lateral') {
      reservedCounter = context.cteCounter++;
      const lateralAlias = `lateral_${reservedCounter}`;
      const innerTableAlias = `${lateralAlias}_${this.relationName}`;

      // Initialize the map if needed
      if (!context.lateralTableAliasMap) {
        context.lateralTableAliasMap = new Map();
      }
      // Save previous value (if any) so we can restore it after building
      // This prevents sibling collections from seeing each other's aliases
      hadPreviousEntry = context.lateralTableAliasMap.has(this.targetTable);
      previousTableAlias = context.lateralTableAliasMap.get(this.targetTable);
      // Register this collection's table alias for nested collections to reference
      context.lateralTableAliasMap.set(this.targetTable, innerTableAlias);
    }

    // Build selected fields configuration (supports nested objects)
    const selectedFieldConfigs: SelectedField[] = [];
    const localParams: any[] = [];

    // Helper function to check if a value is a plain object (not FieldRef, SqlFragment, etc.)
    const isPlainObject = (val: any): boolean => {
      return typeof val === 'object' &&
        val !== null &&
        !('__dbColumnName' in val) &&
        !(val instanceof SqlFragment) &&
        !Array.isArray(val) &&
        val.constructor === Object;
    };

    // Helper function to recursively process fields and build SelectedField structures
    const processField = (alias: string, field: any): SelectedField => {
      if (field instanceof SqlFragment) {
        // SQL Fragment - build the SQL expression
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
          placeholders: context.placeholders,  // Pass placeholders for prepared statements
        };
        const fragmentSql = field.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        return { alias, expression: fragmentSql };
      } else if (field instanceof CollectionQueryBuilder) {
        // Nested collection query builder
        // For temptable strategy, nested collections are not supported - need lateral/CTE
        if (strategyType === 'temptable') {
          throw new Error(
            `Nested collections in temptable strategy are not supported. ` +
            `The field "${alias}" contains a nested collection query. ` +
            `Use collectionStrategy: 'lateral' or 'cte' for queries with nested collections.`
          );
        }
        // For lateral/CTE strategies, build the nested collection as a subquery
        const nestedCtx: QueryContext = {
          ...context,
          cteCounter: context.cteCounter,
        };
        const nestedResult = field.buildCTE(nestedCtx, client);
        // Sync both counters back - cteCounter for CTE naming, paramCounter for parameter numbering
        context.cteCounter = nestedCtx.cteCounter;
        context.paramCounter = nestedCtx.paramCounter;

        // For CTE/LATERAL strategy, we need to track the nested join
        // The nested aggregation needs to be joined in the outer collection's subquery
        // However, correlated subqueries (used for toNumberList, etc.) don't need joins -
        // they are embedded directly in the SELECT expression
        if (nestedResult.tableName && (nestedResult.isCTE || nestedResult.joinClause)) {
          let nestedJoinClause: string;

          if (nestedResult.isCTE) {
            // CTE strategy: join by parent_id
            // The join should be: this.targetTable.id = nestedCte.parent_id
            nestedJoinClause = `LEFT JOIN "${nestedResult.tableName}" ON "${this.targetTable}"."id" = "${nestedResult.tableName}".parent_id`;
          } else {
            // LATERAL strategy: use the provided join clause (contains full LATERAL subquery)
            nestedJoinClause = nestedResult.joinClause!;
          }

          return {
            alias,
            expression: nestedResult.selectExpression || nestedResult.sql,
            nestedCteJoin: {
              cteName: nestedResult.tableName,
              joinClause: nestedJoinClause,
            },
            // Store nested collection info for recursive mapper transformation
            nestedCollectionInfo: {
              targetTable: field.getTargetTable(),
              selectedFieldConfigs: field.getSelectedFieldConfigs(),
              isSingleResult: field.isSingleResult(),
            },
          };
        }

        // The nested collection becomes a correlated subquery in SELECT
        // For scalar aggregations (count, min, max, sum), don't include nestedCollectionInfo
        // because the result is a scalar value, not a structured object that needs transformation
        const aggregationType = field.getAggregationType();
        const isScalarAggregation = aggregationType && ['COUNT', 'MIN', 'MAX', 'SUM'].includes(aggregationType);

        if (isScalarAggregation) {
          // Scalar aggregation - just return the expression, no nested transformation needed
          return {
            alias,
            expression: nestedResult.selectExpression || nestedResult.sql,
          };
        }

        return {
          alias,
          expression: nestedResult.selectExpression || nestedResult.sql,
          // Store nested collection info for recursive mapper transformation
          nestedCollectionInfo: {
            targetTable: field.getTargetTable(),
            selectedFieldConfigs: field.getSelectedFieldConfigs(),
            isSingleResult: field.isSingleResult(),
          },
        };
      } else if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
        // FieldRef object - use database column name with optional table alias
        const dbColumnName = (field as any).__dbColumnName;
        const tableAlias = (field as any).__tableAlias;
        const fieldName = (field as any).__fieldName;  // Property name for mapper lookup
        const sourceTable = (field as any).__sourceTable;  // Actual table name for schema lookup
        // If tableAlias differs from the target table (or its collection marker), it's a navigation property reference
        // The collection marker is `__collection_tableName__` and should be treated as the target table
        const collectionMarker = `__collection_${this.targetTable}__`;
        if (tableAlias && tableAlias !== this.targetTable && tableAlias !== collectionMarker) {
          return { alias, expression: `"${tableAlias}"."${dbColumnName}"`, propertyName: fieldName, sourceTable };
        }
        return { alias, expression: `"${dbColumnName}"`, propertyName: fieldName };
      } else if (typeof field === 'string') {
        // Simple string reference (for backward compatibility)
        return { alias, expression: `"${field}"` };
      } else if (isPlainObject(field)) {
        // Nested object - recursively process its fields
        const nestedFields: SelectedField[] = [];
        for (const [nestedAlias, nestedField] of Object.entries(field)) {
          nestedFields.push(processField(nestedAlias, nestedField));
        }
        return { alias, nested: nestedFields };
      } else {
        // Literal value or expression
        const expression = `$${context.paramCounter++}`;
        context.allParams.push(field);
        localParams.push(field);
        return { alias, expression };
      }
    };

    // Step 1: Build field selection configuration
    if (this.selector) {
      const mockItem = this.createMockItem();
      const selectedFields = this.selector(mockItem);

      // Check if the selector returns a FieldRef directly (single field selection like p => p.title)
      if (typeof selectedFields === 'object' && selectedFields !== null && '__dbColumnName' in selectedFields) {
        // Single field selection - use the field name as both alias and expression
        const field = selectedFields as any;
        const dbColumnName = field.__dbColumnName;
        const fieldName = field.__fieldName;  // Property name for mapper lookup
        selectedFieldConfigs.push({
          alias: dbColumnName,
          expression: `"${dbColumnName}"`,
          propertyName: fieldName,
        });
      } else {
        // Object selection - extract each field (with support for nested objects)
        for (const [alias, field] of Object.entries(selectedFields)) {
          selectedFieldConfigs.push(processField(alias, field));
        }
      }
    } else {
      // No selector - select all fields from the target table schema
      if (this.targetTableSchema && this.targetTableSchema.columns) {
        // Performance: Use cached column name map
        const colNameMap = getColumnNameMapForSchema(this.targetTableSchema);
        for (const [colName, dbColumnName] of colNameMap) {
          selectedFieldConfigs.push({
            alias: colName,
            expression: `"${dbColumnName}"`,
            propertyName: colName,  // Same as alias when selecting all fields
          });
        }
      } else {
        // Fallback: use * (less ideal, may cause issues)
        selectedFieldConfigs.push({
          alias: '*',
          expression: '*',
        });
      }
    }

    // Cache selected field configs for mapper lookup during transformation
    this._selectedFieldConfigs = selectedFieldConfigs;

    // Step 2: Build WHERE clause SQL (without WHERE keyword)
    let whereClause: string | undefined;
    let whereParams: any[] | undefined;
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params, placeholders, paramCounter: newParamCounter } = condBuilder.build(this.whereCond, context.paramCounter, context.placeholders);
      whereClause = sql;
      whereParams = params;
      context.paramCounter = newParamCounter;  // Use returned counter (handles both params and placeholders)
      localParams.push(...params);
      context.allParams.push(...params);
      if (placeholders) {
        context.placeholders = placeholders;
      }
    }

    // Step 3: Build ORDER BY clauses SQL (without ORDER BY keyword)
    // We need two versions:
    // - orderByClause: uses database column names (for subquery ORDER BY on raw table)
    // - orderByClauseAlias: uses property names/aliases (for json_agg ORDER BY on aliased subquery output)
    // Note: orderByFields[].field already contains the database column name (from parseOrderBy using __dbColumnName)
    let orderByClause: string | undefined;
    let orderByClauseAlias: string | undefined;
    if (this.orderByFields.length > 0) {
      // Build reverse lookup: db column name -> property name
      let dbToPropertyMap: Map<string, string> | null = null;
      if (this.targetTableSchema) {
        dbToPropertyMap = new Map();
        for (const [propName, colBuilder] of Object.entries(this.targetTableSchema.columns)) {
          const config = (colBuilder as any).build();
          dbToPropertyMap.set(config.name, propName);
        }
      }

      const orderPartsDb = this.orderByFields.map(({ field, direction }) => {
        // field is already the database column name
        return `"${field}" ${direction}`;
      });
      const orderPartsAlias = this.orderByFields.map(({ field, direction }) => {
        // Look up the property name from the db column name
        const propertyName = dbToPropertyMap?.get(field) ?? field;
        return `"${propertyName}" ${direction}`;
      });
      orderByClause = orderPartsDb.join(', ');
      orderByClauseAlias = orderPartsAlias.join(', ');
    }

    // Step 4: Determine aggregation type and field
    let aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum';
    let aggregateField: string | undefined;
    let arrayField: string | undefined;
    let defaultValue: string;

    if (this.aggregationType) {
      // Scalar aggregations: count, min, max, sum
      aggregationType = this.aggregationType.toLowerCase() as 'count' | 'min' | 'max' | 'sum';

      // For aggregations other than COUNT, determine which field to aggregate
      if (this.aggregationType !== 'COUNT' && this.selector) {
        const mockItem = this.createMockItem();
        const selectedField = this.selector(mockItem);
        if (typeof selectedField === 'object' && selectedField !== null && '__dbColumnName' in selectedField) {
          aggregateField = (selectedField as any).__dbColumnName;
        }
      }

      // Set default value based on aggregation type
      defaultValue = aggregationType === 'count' ? '0' : 'null';
    } else if (this.flattenResultType) {
      // Array aggregation for toNumberList/toStringList
      aggregationType = 'array';

      // Determine the field to aggregate from the selected fields
      if (selectedFieldConfigs.length > 0) {
        const firstField = selectedFieldConfigs[0];
        arrayField = firstField.alias;
      }

      // Use typed empty array literal (PostgreSQL will infer type from array_agg)
      defaultValue = "'{}'";  // Empty array literal
    } else {
      // JSON aggregation (default) - use JSON instead of JSONB for better performance
      aggregationType = 'jsonb';
      defaultValue = "'[]'::json";
    }

    // Step 5: Detect navigation joins from the selected fields
    const navigationJoins: NavigationJoin[] = [];
    if (this.selector && this.targetTableSchema) {
      const mockItem = this.createMockItem();
      const selectedFields = this.selector(mockItem);
      this.detectNavigationJoins(selectedFields, navigationJoins, this.targetTable, this.targetTableSchema);
    }

    // Step 5b: Merge navigation path joins (for intermediate tables in navigation chains)
    // These joins are needed when accessing a collection through a chain like:
    // oi.productPrice.product.resort.productIntegrationDefinitions
    // The navigation path contains joins for productPrice, product, resort
    // which must be included in the lateral subquery for correlation
    const allNavigationJoins: NavigationJoin[] = [...this.navigationPath, ...navigationJoins];

    // Step 6: Build CollectionAggregationConfig object
    const config: CollectionAggregationConfig = {
      relationName: this.relationName,
      targetTable: this.targetTable,
      foreignKey: this.foreignKey,
      sourceTable: this.sourceTable,
      parentIds,  // Pass parent IDs for temp table strategy
      selectedFields: selectedFieldConfigs,
      whereClause,
      whereParams,  // Pass WHERE clause parameters
      orderByClause,
      orderByClauseAlias,  // For json_agg ORDER BY which uses aliases
      orderByFields: this.orderByFields.length > 0 ? this.orderByFields : undefined,  // For including ORDER BY columns in inner SELECT
      limitValue: this.limitValue,
      offsetValue: this.offsetValue,
      isDistinct: this.isDistinct,
      isSingleResult: this.isSingleResult(),  // For firstOrDefault() - returns single object instead of array
      aggregationType,
      aggregateField,
      arrayField,
      defaultValue,
      // Use the reserved counter for LATERAL strategy, otherwise increment as before
      counter: reservedCounter !== undefined ? reservedCounter : context.cteCounter++,
      navigationJoins: allNavigationJoins.length > 0 ? allNavigationJoins : undefined,
      selectorNavigationJoins: navigationJoins.length > 0 ? navigationJoins : undefined,
    };

    // Step 6: Call the strategy
    const result = strategy.buildAggregation(config, context, client!);

    // Step 7: Restore the lateralTableAliasMap to prevent sibling collections from seeing this alias
    // This is important because sibling collections at the same level should not affect each other
    if (strategyType === 'lateral' && context.lateralTableAliasMap) {
      if (hadPreviousEntry) {
        // Restore the previous value
        context.lateralTableAliasMap.set(this.targetTable, previousTableAlias!);
      } else {
        // Remove the entry we added
        context.lateralTableAliasMap.delete(this.targetTable);
      }
    }

    // Step 8: Return the result
    // For synchronous strategies (like JSONB), result is returned directly
    // For async strategies (like temp table), return the Promise
    // Callers need to handle both cases
    if (result instanceof Promise) {
      // Async strategy - return special marker with the promise
      return result as any;
    }

    // Synchronous strategy (JSONB/CTE/LATERAL)
    return {
      sql: result.sql,
      params: localParams,
      isCTE: result.isCTE,
      joinClause: result.joinClause,
      selectExpression: result.selectExpression,
      tableName: result.tableName,
    };
  }
}
