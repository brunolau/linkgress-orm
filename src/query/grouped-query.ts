import { Condition, ConditionBuilder, SqlFragment, SqlBuildContext, FieldRef, WhereConditionBase } from './conditions';
import { TableSchema } from '../schema/table-builder';
import type { DatabaseClient } from '../database/database-client.interface';
import type { QueryExecutor, OrderDirection } from '../entity/db-context';
import { parseOrderBy, getQualifiedFieldName } from './query-utils';
import { Subquery } from './subquery';
import type { ManualJoinDefinition, JoinType } from './query-builder';
import { CollectionQueryBuilder, ReferenceQueryBuilder, getColumnNameMapForSchema, getRelationEntriesForSchema, getTargetSchemaForRelation } from './query-builder';
import { DbCte, isCte } from './cte-builder';

/**
 * Query context for tracking CTEs and parameters
 */
interface QueryContext {
  ctes: Map<string, { sql: string; params: any[] }>;
  cteCounter: number;
  paramCounter: number;
  allParams: any[];
}

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
 * Type helper to resolve FieldRef types to their value types
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends Array<infer U>
  ? Array<ResolveFieldRefs<U>>
  : T extends object
  ? IsValueType<T> extends true
    ? T  // Preserve class instances as-is
    : { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Type helper to convert resolved value types back to FieldRef for join conditions
 * This allows join conditions to accept either the value or FieldRef
 * If a field is already a FieldRef, it preserves it without double-wrapping
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
type ToFieldRefs<T> = T extends object
  ? IsValueType<T> extends true
    ? FieldRef<string, T>  // Preserve class instances, wrap in FieldRef
    : { [K in keyof T]: T[K] extends FieldRef<any, infer V> ? FieldRef<string, V> : FieldRef<string, T[K]> }
  : T extends FieldRef<any, infer V> ? FieldRef<string, V> : FieldRef<string, T>;

/**
 * Represents a grouped item with access to the grouping key and aggregate functions
 * TGroupingKey: The shape of the grouping key (e.g., { street: string })
 * TOriginalRow: The original row type before grouping
 */
export interface GroupedItem<TGroupingKey, TOriginalRow> {
  /**
   * The grouping key - contains all fields specified in groupBy
   */
  readonly key: ResolveFieldRefs<TGroupingKey>;

  /**
   * Count the number of items in this group
   */
  count(): number;

  /**
   * Sum a numeric field across all items in this group
   * Returns the inferred type from the selector, or number if the type cannot be inferred
   */
  sum<TField>(selector: (item: TOriginalRow) => TField): TField extends FieldRef<any, infer V> ? V : TField extends number ? number : number;

  /**
   * Get the minimum value of a field across all items in this group
   * Returns the inferred type from the selector
   */
  min<TField>(selector: (item: TOriginalRow) => TField): TField extends FieldRef<any, infer V> ? V : TField;

  /**
   * Get the maximum value of a field across all items in this group
   * Returns the inferred type from the selector
   */
  max<TField>(selector: (item: TOriginalRow) => TField): TField extends FieldRef<any, infer V> ? V : TField;

  /**
   * Get the average value of a numeric field across all items in this group
   * Always returns number since average is always numeric
   * Accepts undefined since SQL AVG ignores NULL values
   */
  avg(selector: (item: TOriginalRow) => FieldRef<any, number | undefined> | number | undefined): number;
}

/**
 * Marker for aggregate function calls in the selection
 */
interface AggregateMarker {
  __aggregateType: 'COUNT' | 'SUM' | 'MIN' | 'MAX' | 'AVG';
  __selector?: (item: any) => any;
}

/**
 * Aggregate field reference - used in HAVING clauses
 * Represents a field that is an aggregate function result (e.g., COUNT(*), SUM(column))
 */
export interface AggregateFieldRef<TValueType = any> extends FieldRef<string, TValueType> {
  readonly __isAggregate: true;
  readonly __aggregateType: 'COUNT' | 'SUM' | 'MIN' | 'MAX' | 'AVG';
  readonly __aggregateSelector?: (item: any) => any;
}

/**
 * Create an aggregate field reference that can be used in conditions
 */
function createAggregateFieldRef<T>(
  aggregateType: 'COUNT' | 'SUM' | 'MIN' | 'MAX' | 'AVG',
  selector?: (item: any) => any
): AggregateFieldRef<T> {
  return {
    __fieldName: aggregateType.toLowerCase(),
    __dbColumnName: aggregateType.toLowerCase(),
    __isAggregate: true,
    __aggregateType: aggregateType,
    __aggregateSelector: selector,
  };
}

/**
 * Grouped query builder - result of calling groupBy()
 * Provides type-safe access to grouping keys and aggregate functions
 */
export class GroupedQueryBuilder<TOriginalRow, TGroupingKey> {
  private schema: TableSchema;
  private client: DatabaseClient;
  private originalSelector: (row: any) => any;
  private groupingKeySelector: (row: TOriginalRow) => TGroupingKey;
  private whereCond?: Condition;
  private havingCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    originalSelector: (row: any) => any,
    groupingKeySelector: (row: TOriginalRow) => TGroupingKey,
    whereCond?: Condition,
    executor?: QueryExecutor,
    manualJoins?: ManualJoinDefinition[],
    joinCounter?: number
  ) {
    this.schema = schema;
    this.client = client;
    this.originalSelector = originalSelector;
    this.groupingKeySelector = groupingKeySelector;
    this.whereCond = whereCond;
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
  }

  /**
   * Select from grouped results
   * The selector receives a GroupedItem with key and aggregate functions
   */
  select<TSelection>(
    selector: (group: GroupedItem<TGroupingKey, TOriginalRow>) => TSelection
  ): GroupedSelectQueryBuilder<TSelection, TOriginalRow, TGroupingKey> {
    return new GroupedSelectQueryBuilder(
      this.schema,
      this.client,
      this.originalSelector,
      this.groupingKeySelector,
      selector,
      this.whereCond,
      this.havingCond,
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter
    );
  }

  /**
   * Add HAVING condition (filter groups after aggregation)
   */
  having(
    condition: (group: GroupedItem<TGroupingKey, TOriginalRow>) => Condition
  ): this {
    const mockGroup = this.createMockGroupedItem();
    this.havingCond = condition(mockGroup);
    return this;
  }

  /**
   * Create a mock GroupedItem for type inference and condition building
   */
  private createMockGroupedItem(): GroupedItem<TGroupingKey, TOriginalRow> {
    // Create mock for the original row
    const mockOriginalRow = this.createMockRow();

    // Evaluate the grouping key selector to get the key structure
    const mockKey = this.groupingKeySelector(mockOriginalRow as TOriginalRow);

    return {
      key: mockKey as any,
      count: () => {
        return createAggregateFieldRef<number>('COUNT') as any;
      },
      sum: (selector: any) => {
        return createAggregateFieldRef<number>('SUM', selector) as any;
      },
      min: (selector: any) => {
        return createAggregateFieldRef('MIN', selector) as any;
      },
      max: (selector: any) => {
        return createAggregateFieldRef('MAX', selector) as any;
      },
      avg: (selector: any) => {
        return createAggregateFieldRef<number>('AVG', selector) as any;
      },
    };
  }

  /**
   * Create mock row for the original table
   */
  private createMockRow(): any {
    const mock: any = {};
    const tableAlias = this.schema.name;

    // Add columns as FieldRef objects - use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.schema);

    // Performance: Lazy-cache FieldRef objects
    const fieldRefCache: Record<string, any> = {};

    for (const [colName, dbColumnName] of columnNameMap) {
      Object.defineProperty(mock, colName, {
        get() {
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Add navigation properties (collections and single references)
    // Performance: Use pre-computed relation entries and cached schemas
    const relationEntries = getRelationEntriesForSchema(this.schema);

    for (const [relName, relConfig] of relationEntries) {
      const targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);

      if (relConfig.type === 'many') {
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              this.schema.name,
              targetSchema
            );
          },
          enumerable: true,
          configurable: true,
        });
      } else {
        Object.defineProperty(mock, relName, {
          get: () => {
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
          configurable: true,
        });
      }
    }

    // Add columns from manually joined tables
    for (const join of this.manualJoins) {
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

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

    return mock;
  }
}

/**
 * Grouped select query builder - result of calling select() on a GroupedQueryBuilder
 */
export class GroupedSelectQueryBuilder<TSelection, TOriginalRow, TGroupingKey> {
  private schema: TableSchema;
  private client: DatabaseClient;
  private originalSelector: (row: any) => any;
  private groupingKeySelector: (row: TOriginalRow) => TGroupingKey;
  private resultSelector: (group: GroupedItem<TGroupingKey, TOriginalRow>) => TSelection;
  private whereCond?: Condition;
  private havingCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    originalSelector: (row: any) => any,
    groupingKeySelector: (row: TOriginalRow) => TGroupingKey,
    resultSelector: (group: GroupedItem<TGroupingKey, TOriginalRow>) => TSelection,
    whereCond?: Condition,
    havingCond?: Condition,
    limit?: number,
    offset?: number,
    orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC' }>,
    executor?: QueryExecutor,
    manualJoins?: ManualJoinDefinition[],
    joinCounter?: number
  ) {
    this.schema = schema;
    this.client = client;
    this.originalSelector = originalSelector;
    this.groupingKeySelector = groupingKeySelector;
    this.resultSelector = resultSelector;
    this.whereCond = whereCond;
    this.havingCond = havingCond;
    this.limitValue = limit;
    this.offsetValue = offset;
    this.orderByFields = orderBy || [];
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
  }

  /**
   * Add HAVING condition (filter groups after aggregation)
   */
  having(
    condition: (group: GroupedItem<TGroupingKey, TOriginalRow>) => Condition
  ): this {
    const mockGroup = this.createMockGroupedItem();
    this.havingCond = condition(mockGroup);
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
   * Order by field(s) from the selected result
   * @example
   * .orderBy(p => p.colName)
   * .orderBy(p => [p.colName, p.otherCol])
   * .orderBy(p => [[p.colName, 'ASC'], [p.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);
    const result = selector(mockResult);
    parseOrderBy(result, this.orderByFields);
    return this;
  }

  /**
   * Execute query and return results
   */
  async toList(): Promise<ResolveFieldRefs<TSelection>[]> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
    };

    const { sql, params } = this.buildQuery(context);

    // Execute using executor if available, otherwise use client directly
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    // Transform results: convert aggregate string values to numbers
    return this.transformResults(result.rows);
  }

  /**
   * Transform database results - convert aggregate values and apply mappers
   */
  private transformResults(rows: any[]): any[] {
    // Get the mock result to identify which fields are aggregates and have mappers
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);

    // Also get the original selection to track field origins for mapper lookup
    const mockRow = this.createMockRow();
    const mockOriginalSelection = this.originalSelector(mockRow);

    // Build column metadata cache from schema for mapper lookup
    const columnMetadataCache: Record<string, { hasMapper: boolean; mapper?: any }> = {};
    for (const [key, mockValue] of Object.entries(mockResult as object)) {
      // Check if mockValue has getMapper (SqlFragment or aliased field with mapper)
      if (typeof mockValue === 'object' && mockValue !== null && typeof (mockValue as any).getMapper === 'function') {
        const mapper = (mockValue as any).getMapper();
        if (mapper) {
          columnMetadataCache[key] = { hasMapper: true, mapper };
        }
      }
      // Check if this is a FieldRef from schema column
      else if (typeof mockValue === 'object' && mockValue !== null && '__fieldName' in mockValue) {
        const fieldName = (mockValue as any).__fieldName as string;
        // Look up in schema
        const column = this.schema.columns[fieldName];
        if (column) {
          const config = column.build();
          if (config.mapper) {
            columnMetadataCache[key] = { hasMapper: true, mapper: config.mapper };
          }
        }
        // Also check original selection for mapper (for aliased fields like p.key.distinctDay)
        else if (mockOriginalSelection && fieldName in mockOriginalSelection) {
          const origValue = mockOriginalSelection[fieldName];
          if (typeof origValue === 'object' && origValue !== null && '__fieldName' in origValue) {
            const origFieldName = (origValue as any).__fieldName as string;
            const origColumn = this.schema.columns[origFieldName];
            if (origColumn) {
              const config = origColumn.build();
              if (config.mapper) {
                columnMetadataCache[key] = { hasMapper: true, mapper: config.mapper };
              }
            }
          }
        }
      }
    }

    return rows.map(row => {
      const transformed: any = {};

      for (const [key, value] of Object.entries(row)) {
        const mockValue = (mockResult as any)[key];

        // Check if this field is an aggregate
        if (mockValue && typeof mockValue === 'object' && '__isAggregate' in mockValue && mockValue.__isAggregate) {
          const aggType = (mockValue as AggregateFieldRef).__aggregateType;

          // Convert string to number for numeric aggregates
          if (aggType === 'COUNT' || aggType === 'SUM' || aggType === 'AVG' || aggType === 'MIN' || aggType === 'MAX') {
            transformed[key] = value === null ? null : Number(value);
          } else {
            transformed[key] = value;
          }
        }
        // Check if this field has a mapper
        else if (columnMetadataCache[key]?.hasMapper) {
          const mapper = columnMetadataCache[key].mapper;
          if (value === null || value === undefined) {
            transformed[key] = null;
          } else if (typeof mapper.fromDriver === 'function') {
            transformed[key] = mapper.fromDriver(value);
          } else {
            transformed[key] = value;
          }
        } else {
          // Non-aggregate field without mapper - keep as is
          transformed[key] = value;
        }
      }

      return transformed;
    });
  }

  /**
   * Get selection metadata for mapper preservation in CTEs
   * Enhances the selection result with mapper info from original schema columns
   * @internal
   */
  getSelectionMetadata(): Record<string, any> {
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);

    // Get original selection to map field names back to schema columns
    const mockRow = this.createMockRow();
    const mockOriginalSelection = this.originalSelector(mockRow);

    // Build enhanced metadata with mappers
    const enhancedMetadata: Record<string, any> = {};

    for (const [key, value] of Object.entries(mockResult as object)) {
      // Check if it's a FieldRef
      if (typeof value === 'object' && value !== null && '__fieldName' in value) {
        const fieldName = (value as any).__fieldName as string;

        // First check if schema has mapper for this field
        const column = this.schema.columns[fieldName];
        if (column) {
          const config = column.build();
          if (config.mapper) {
            // Add mapper info to the metadata
            enhancedMetadata[key] = {
              ...value,
              getMapper: () => config.mapper,
            };
            continue;
          }
        }

        // Check original selection for mapper (for aliased fields like p.key.distinctDay)
        if (mockOriginalSelection && fieldName in mockOriginalSelection) {
          const origValue = mockOriginalSelection[fieldName];
          if (typeof origValue === 'object' && origValue !== null && '__fieldName' in origValue) {
            const origFieldName = (origValue as any).__fieldName as string;
            const origColumn = this.schema.columns[origFieldName];
            if (origColumn) {
              const config = origColumn.build();
              if (config.mapper) {
                enhancedMetadata[key] = {
                  ...value,
                  getMapper: () => config.mapper,
                };
                continue;
              }
            }
          }
        }
      }

      // No mapper found, use original value
      enhancedMetadata[key] = value;
    }

    return enhancedMetadata;
  }

  /**
   * Execute query and return first result or null
   */
  async first(): Promise<ResolveFieldRefs<TSelection> | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return first result or throw
   */
  async firstOrThrow(): Promise<ResolveFieldRefs<TSelection>> {
    const result = await this.first();
    if (!result) {
      throw new Error('No results found');
    }
    return result;
  }

  /**
   * Convert to subquery for use in other queries
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<TMode extends 'scalar' ? ResolveFieldRefs<TSelection> : TMode extends 'array' ? ResolveFieldRefs<TSelection>[] : ResolveFieldRefs<TSelection>, TMode> {
    const sqlBuilder = (outerContext: SqlBuildContext & { tableAlias?: string }): string => {
      const context: QueryContext = {
        ctes: new Map(),
        cteCounter: 0,
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
      };

      const { sql } = this.buildQuery(context);
      outerContext.paramCounter = context.paramCounter;

      return sql;
    };

    // Get selection metadata with mappers for table subqueries
    const selectionMetadata = mode === 'table' ? this.getSelectionMetadata() : undefined;

    return new Subquery(sqlBuilder, mode, selectionMetadata) as any;
  }

  /**
   * Build SQL for use in CTEs - public interface for CTE builder
   * @internal
   */
  buildCteQuery(queryContext: QueryContext): { sql: string; params: any[] } {
    return this.buildQuery(queryContext);
  }

  /**
   * Add a LEFT JOIN to the grouped query result
   * This wraps the grouped query as a subquery and joins to it
   *
   * @example
   * const result = await db.orders
   *   .select(o => ({ customerId: o.customerId, total: o.total }))
   *   .groupBy(o => ({ customerId: o.customerId }))
   *   .select(g => ({ customerId: g.key.customerId, totalSum: g.sum(o => o.total) }))
   *   .leftJoin(
   *     customerDetailsCte,
   *     (grouped, details) => eq(grouped.customerId, details.customerId),
   *     (grouped, details) => ({ ...grouped, details: details.items })
   *   )
   *   .toList();
   */
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightSource: Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => TNewSelection,
    alias?: string
  ): GroupedJoinedQueryBuilder<TNewSelection, ToFieldRefs<TSelection>, ToFieldRefs<TRight>> {
    return this.joinInternal('LEFT', rightSource, condition, selector, alias);
  }

  /**
   * Add an INNER JOIN to the grouped query result
   * This wraps the grouped query as a subquery and joins to it
   */
  innerJoin<TRight extends Record<string, any>, TNewSelection>(
    rightSource: Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => TNewSelection,
    alias?: string
  ): GroupedJoinedQueryBuilder<TNewSelection, ToFieldRefs<TSelection>, ToFieldRefs<TRight>> {
    return this.joinInternal('INNER', rightSource, condition, selector, alias);
  }

  /**
   * Internal join implementation
   */
  private joinInternal<TRight extends Record<string, any>, TNewSelection>(
    joinType: JoinType,
    rightSource: Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => Condition,
    selector: (left: ToFieldRefs<TSelection>, right: ToFieldRefs<TRight>) => TNewSelection,
    alias?: string
  ): GroupedJoinedQueryBuilder<TNewSelection, ToFieldRefs<TSelection>, ToFieldRefs<TRight>> {
    // Wrap this grouped query as a subquery
    const leftSubquery = this.asSubquery('table');
    const leftAlias = 'grouped_0';

    // Determine the right alias and source info
    let rightAlias: string;
    let isCteJoin = false;
    let cte: DbCte<TRight> | undefined;

    if (isCte(rightSource)) {
      rightAlias = rightSource.name;
      isCteJoin = true;
      cte = rightSource;
    } else {
      if (!alias) {
        throw new Error('Alias is required when joining a subquery');
      }
      rightAlias = alias;
    }

    // Create mock for left (the grouped query result)
    const mockLeft = this.createMockForSelection(leftAlias) as unknown as ToFieldRefs<TSelection>;

    // Create mock for right - at runtime these are already FieldRef-like objects
    const mockRight = (isCteJoin
      ? this.createMockForCte(cte!)
      : this.createMockForSubquery<TRight>(rightAlias, rightSource as Subquery<TRight, 'table'>)) as unknown as ToFieldRefs<TRight>;

    // Evaluate the join condition
    const joinCondition = condition(mockLeft, mockRight);

    // Create the result selector
    const createLeftMock = () => this.createMockForSelection(leftAlias) as unknown as ToFieldRefs<TSelection>;
    const createRightMock = () => (isCteJoin
      ? this.createMockForCte(cte!)
      : this.createMockForSubquery<TRight>(rightAlias, rightSource as Subquery<TRight, 'table'>)) as unknown as ToFieldRefs<TRight>;

    return new GroupedJoinedQueryBuilder<TNewSelection, ToFieldRefs<TSelection>, ToFieldRefs<TRight>>(
      this.schema,
      this.client,
      leftSubquery,
      leftAlias,
      rightSource as any,
      rightAlias,
      joinType,
      joinCondition,
      selector,
      createLeftMock,
      createRightMock,
      this.executor,
      isCteJoin ? cte as any : undefined
    );
  }

  /**
   * Create a mock object for the current selection (for join conditions)
   * The key is the alias used in the SELECT clause, so we use it as __dbColumnName
   */
  private createMockForSelection(alias: string): TSelection {
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);

    // Wrap with alias - always use the key as the column name since
    // that's what the subquery SELECT clause uses as the alias
    const wrapped: any = {};
    for (const [key, value] of Object.entries(mockResult as object)) {
      // Preserve mapper if present
      const mapper = (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function')
        ? { getMapper: () => (value as any).getMapper() }
        : {};

      wrapped[key] = {
        __fieldName: key,
        __dbColumnName: key,  // Use key as column name (the subquery alias)
        __tableAlias: alias,
        ...mapper,
      };
    }
    return wrapped as TSelection;
  }

  /**
   * Create a mock for a subquery result
   */
  private createMockForSubquery<T>(alias: string, subquery: Subquery<T, 'table'>): T {
    const selectionMetadata = subquery.getSelectionMetadata();

    return new Proxy({} as any, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        if (selectionMetadata && prop in selectionMetadata) {
          const value = selectionMetadata[prop];
          if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
            return {
              __fieldName: prop,
              __dbColumnName: prop,
              __tableAlias: alias,
              getMapper: () => (value as any).getMapper(),
            };
          }
        }

        return {
          __fieldName: prop,
          __dbColumnName: prop,
          __tableAlias: alias,
        };
      },
      has() { return true; },
      ownKeys() { return []; },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true };
      }
    }) as T;
  }

  /**
   * Create a mock for a CTE
   */
  private createMockForCte<T>(cte: DbCte<T>): T {
    const alias = cte.name;
    const selectionMetadata = cte.selectionMetadata;

    return new Proxy({} as any, {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        if (selectionMetadata && prop in selectionMetadata) {
          const value = selectionMetadata[prop];
          if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
            return {
              __fieldName: prop,
              __dbColumnName: prop,
              __tableAlias: alias,
              getMapper: () => (value as any).getMapper(),
            };
          }
        }

        return {
          __fieldName: prop,
          __dbColumnName: prop,
          __tableAlias: alias,
        };
      },
      has() { return true; },
      ownKeys() { return []; },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true };
      }
    }) as T;
  }

  /**
   * Build the SQL query for grouped results
   *
   * Optimization: When grouping by SqlFragment expressions, we wrap the base query
   * in a subquery to avoid repeating complex expressions in both SELECT and GROUP BY.
   * This matches the pattern used by Drizzle and improves query performance.
   *
   * Without optimization:
   *   SELECT complex_expr as "alias" FROM table GROUP BY complex_expr
   *
   * With optimization:
   *   SELECT "alias" FROM (SELECT complex_expr as "alias" FROM table) q1 GROUP BY "alias"
   */
  private buildQuery(context: QueryContext): { sql: string; params: any[] } {
    // Create mocks for evaluation
    const mockRow = this.createMockRow();
    const mockOriginalSelection = this.originalSelector(mockRow);
    const mockGroupingKey = this.groupingKeySelector(mockOriginalSelection as TOriginalRow);

    // Create mock grouped item using the SAME grouping key (not a fresh one)
    // This ensures SqlFragment instances are shared between GROUP BY and SELECT
    const mockGroup: GroupedItem<TGroupingKey, TOriginalRow> = {
      key: mockGroupingKey as any,
      count: () => createAggregateFieldRef<number>('COUNT') as any,
      sum: (selector: any) => createAggregateFieldRef<number>('SUM', selector) as any,
      min: (selector: any) => createAggregateFieldRef('MIN', selector) as any,
      max: (selector: any) => createAggregateFieldRef('MAX', selector) as any,
      avg: (selector: any) => createAggregateFieldRef<number>('AVG', selector) as any,
    };
    const mockResult = this.resultSelector(mockGroup);

    // Check if we have SqlFragment expressions in the grouping key
    // If so, we'll use the subquery wrapping optimization
    const hasSqlFragmentInGroupBy = Object.values(mockGroupingKey as object).some(
      value => value instanceof SqlFragment
    );

    // Detect navigation property references in WHERE and add JOINs
    const navigationJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean }> = [];

    // Detect joins from the original selection (navigation properties used in select)
    this.detectAndAddJoinsFromSelection(mockOriginalSelection, navigationJoins);

    // Detect joins from WHERE condition
    this.detectAndAddJoinsFromCondition(this.whereCond, navigationJoins);

    // Build base FROM clause with JOINs
    let baseFromClause = `"${this.schema.name}"`;

    // Add navigation property JOINs first
    for (const navJoin of navigationJoins) {
      const joinType = navJoin.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      const targetTableName = navJoin.targetSchema
        ? `"${navJoin.targetSchema}"."${navJoin.targetTable}"`
        : `"${navJoin.targetTable}"`;

      // Build join condition: source.foreignKey = target.match
      const joinConditions = navJoin.foreignKeys.map((fk, i) => {
        const targetCol = navJoin.matches[i] || 'id';
        return `"${this.schema.name}"."${fk}" = "${navJoin.alias}"."${targetCol}"`;
      });

      baseFromClause += `\n${joinType} ${targetTableName} AS "${navJoin.alias}" ON ${joinConditions.join(' AND ')}`;
    }

    // Add manual JOINs
    for (const manualJoin of this.manualJoins) {
      const joinTypeStr = manualJoin.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams } = condBuilder.build(manualJoin.condition, context.paramCounter);
      context.paramCounter += condParams.length;
      context.allParams.push(...condParams);

      // Check if this is a subquery join
      if ((manualJoin as any).isSubquery && (manualJoin as any).subquery) {
        const subqueryBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const subquerySql = (manualJoin as any).subquery.buildSql(subqueryBuildContext);
        context.paramCounter = subqueryBuildContext.paramCounter;
        baseFromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        baseFromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
      }
    }

    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params } = condBuilder.build(this.whereCond, context.paramCounter);
      whereClause = `WHERE ${sql}`;
      context.paramCounter += params.length;
      context.allParams.push(...params);
    }

    if (hasSqlFragmentInGroupBy) {
      // Use subquery wrapping optimization for complex GROUP BY expressions
      return this.buildQueryWithSubqueryWrapping(context, mockOriginalSelection, mockGroupingKey, mockResult, baseFromClause, whereClause);
    } else {
      // Use simple query for basic GROUP BY (column references only)
      return this.buildSimpleGroupedQuery(context, mockOriginalSelection, mockGroupingKey, mockResult, baseFromClause, whereClause);
    }
  }

  /**
   * Build a simple grouped query when GROUP BY only contains column references
   */
  private buildSimpleGroupedQuery(
    context: QueryContext,
    mockOriginalSelection: any,
    mockGroupingKey: any,
    mockResult: any,
    baseFromClause: string,
    whereClause: string
  ): { sql: string; params: any[] } {
    // Extract GROUP BY fields from the grouping key
    const groupByFields: string[] = [];
    for (const [key, value] of Object.entries(mockGroupingKey as object)) {
      if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
        const field = value as any;
        const tableAlias = field.__tableAlias || this.schema.name;
        groupByFields.push(`"${tableAlias}"."${field.__dbColumnName}"`);
      }
    }

    // Build SELECT clause from result selector
    const selectParts: string[] = [];
    for (const [alias, value] of Object.entries(mockResult as object)) {
      const selectPart = this.buildSelectPart(alias, value, mockOriginalSelection, context, this.schema.name);
      if (selectPart) {
        selectParts.push(selectPart);
      }
    }

    // Build GROUP BY clause
    const groupByClause = `GROUP BY ${groupByFields.join(', ')}`;

    // Build HAVING clause
    let havingClause = '';
    if (this.havingCond) {
      const havingSql = this.buildHavingCondition(this.havingCond, context);
      havingClause = `HAVING ${havingSql}`;
    }

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(
        ({ field, direction }) => `"${field}" ${direction}`
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

    const finalQuery = `SELECT ${selectParts.join(', ')}\nFROM ${baseFromClause}\n${whereClause}\n${groupByClause}\n${havingClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
    };
  }

  /**
   * Build a grouped query with subquery wrapping for complex GROUP BY expressions
   * This avoids repeating SqlFragment expressions in both SELECT and GROUP BY
   */
  private buildQueryWithSubqueryWrapping(
    context: QueryContext,
    mockOriginalSelection: any,
    mockGroupingKey: any,
    mockResult: any,
    baseFromClause: string,
    whereClause: string
  ): { sql: string; params: any[] } {
    // Step 1: Build the inner subquery that computes all expressions
    // This includes: grouping key fields, fields needed for aggregates
    const innerSelectParts: string[] = [];
    const groupByAliases: string[] = []; // Aliases to use in outer GROUP BY
    const sqlFragmentAliasMap = new Map<SqlFragment, string>(); // Map SqlFragment to its alias

    // Add grouping key fields to inner select
    for (const [key, value] of Object.entries(mockGroupingKey as object)) {
      if (value instanceof SqlFragment) {
        // Build the SqlFragment expression
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const fragmentSql = value.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        innerSelectParts.push(`${fragmentSql} as "${key}"`);
        groupByAliases.push(`"${key}"`);
        sqlFragmentAliasMap.set(value, key);
      } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
        const field = value as any;
        const tableAlias = field.__tableAlias || this.schema.name;
        innerSelectParts.push(`"${tableAlias}"."${field.__dbColumnName}" as "${key}"`);
        groupByAliases.push(`"${key}"`);
      }
    }

    // Add fields needed for aggregates to inner select
    const aggregateFields = new Set<string>(); // Track fields we've already added
    for (const [, value] of Object.entries(mockResult as object)) {
      if (typeof value === 'object' && value !== null && '__isAggregate' in value && (value as any).__isAggregate) {
        const aggField = value as AggregateFieldRef;
        if (aggField.__aggregateSelector) {
          const field = aggField.__aggregateSelector(mockOriginalSelection);
          if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            const fieldRef = field as any;
            const tableAlias = fieldRef.__tableAlias || this.schema.name;
            const dbColName = fieldRef.__dbColumnName;
            const fieldKey = `${tableAlias}.${dbColName}`;
            if (!aggregateFields.has(fieldKey)) {
              aggregateFields.add(fieldKey);
              innerSelectParts.push(`"${tableAlias}"."${dbColName}" as "${dbColName}"`);
            }
          }
        }
      } else if (typeof value === 'object' && value !== null && '__aggregateType' in value) {
        // Backward compatibility
        const agg = value as AggregateMarker;
        if (agg.__selector) {
          const field = agg.__selector(mockOriginalSelection);
          if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            const fieldRef = field as any;
            const tableAlias = fieldRef.__tableAlias || this.schema.name;
            const dbColName = fieldRef.__dbColumnName;
            const fieldKey = `${tableAlias}.${dbColName}`;
            if (!aggregateFields.has(fieldKey)) {
              aggregateFields.add(fieldKey);
              innerSelectParts.push(`"${tableAlias}"."${dbColName}" as "${dbColName}"`);
            }
          }
        }
      }
    }

    // Build the inner subquery
    const innerQuery = `SELECT ${innerSelectParts.join(', ')}\nFROM ${baseFromClause}\n${whereClause}`.trim();

    // Step 2: Build the outer query that groups by aliases
    const outerSelectParts: string[] = [];
    for (const [alias, value] of Object.entries(mockResult as object)) {
      if (typeof value === 'object' && value !== null && '__isAggregate' in value && (value as any).__isAggregate) {
        // Aggregate function
        const aggField = value as AggregateFieldRef;
        const aggType = aggField.__aggregateType;

        if (aggType === 'COUNT') {
          outerSelectParts.push(`CAST(COUNT(*) AS INTEGER) as "${alias}"`);
        } else if (aggField.__aggregateSelector) {
          const field = aggField.__aggregateSelector(mockOriginalSelection);
          if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            const fieldRef = field as any;
            const dbColName = fieldRef.__dbColumnName;
            // Reference the alias from inner query
            if (aggType === 'SUM' || aggType === 'AVG') {
              outerSelectParts.push(`CAST(${aggType}("${dbColName}") AS DOUBLE PRECISION) as "${alias}"`);
            } else {
              outerSelectParts.push(`${aggType}("${dbColName}") as "${alias}"`);
            }
          }
        } else {
          outerSelectParts.push(`${aggType}(*) as "${alias}"`);
        }
      } else if (typeof value === 'object' && value !== null && '__aggregateType' in value) {
        // Backward compatibility
        const agg = value as AggregateMarker;
        if (agg.__aggregateType === 'COUNT') {
          outerSelectParts.push(`CAST(COUNT(*) AS INTEGER) as "${alias}"`);
        } else if (agg.__selector) {
          const field = agg.__selector(mockOriginalSelection);
          if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            const fieldRef = field as any;
            const dbColName = fieldRef.__dbColumnName;
            if (agg.__aggregateType === 'SUM' || agg.__aggregateType === 'AVG') {
              outerSelectParts.push(`CAST(${agg.__aggregateType}("${dbColName}") AS DOUBLE PRECISION) as "${alias}"`);
            } else {
              outerSelectParts.push(`${agg.__aggregateType}("${dbColName}") as "${alias}"`);
            }
          }
        }
      } else if (value instanceof SqlFragment) {
        // SqlFragment - reference the alias from inner query
        const innerAlias = sqlFragmentAliasMap.get(value);
        if (innerAlias) {
          outerSelectParts.push(`"${innerAlias}" as "${alias}"`);
        }
      } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
        // Direct field reference - find the matching key in grouping key
        const field = value as any;
        // Look for matching alias in groupByAliases
        for (const [key, gkValue] of Object.entries(mockGroupingKey as object)) {
          if (gkValue === value ||
              (typeof gkValue === 'object' && gkValue !== null && '__dbColumnName' in gkValue &&
               (gkValue as any).__dbColumnName === field.__dbColumnName)) {
            outerSelectParts.push(`"${key}" as "${alias}"`);
            break;
          }
        }
      }
    }

    // Build GROUP BY clause using aliases
    const groupByClause = `GROUP BY ${groupByAliases.join(', ')}`;

    // Build HAVING clause
    let havingClause = '';
    if (this.havingCond) {
      const havingSql = this.buildHavingCondition(this.havingCond, context);
      havingClause = `HAVING ${havingSql}`;
    }

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(
        ({ field, direction }) => `"${field}" ${direction}`
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

    const finalQuery = `SELECT ${outerSelectParts.join(', ')}\nFROM (${innerQuery}) "q1"\n${groupByClause}\n${havingClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
    };
  }

  /**
   * Build a single SELECT part for a result field
   */
  private buildSelectPart(
    alias: string,
    value: any,
    mockOriginalSelection: any,
    context: QueryContext,
    defaultTableAlias: string
  ): string | null {
    if (typeof value === 'object' && value !== null && '__isAggregate' in value && (value as any).__isAggregate) {
      // This is an AggregateFieldRef (from our mock GroupedItem)
      const aggField = value as AggregateFieldRef;
      const aggType = aggField.__aggregateType;

      if (aggType === 'COUNT') {
        return `CAST(COUNT(*) AS INTEGER) as "${alias}"`;
      } else if (aggField.__aggregateSelector) {
        const field = aggField.__aggregateSelector(mockOriginalSelection);
        if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
          const fieldRef = field as any;
          const tableAlias = fieldRef.__tableAlias || defaultTableAlias;
          if (aggType === 'SUM' || aggType === 'AVG') {
            return `CAST(${aggType}("${tableAlias}"."${fieldRef.__dbColumnName}") AS DOUBLE PRECISION) as "${alias}"`;
          } else {
            return `${aggType}("${tableAlias}"."${fieldRef.__dbColumnName}") as "${alias}"`;
          }
        }
      } else {
        return `${aggType}(*) as "${alias}"`;
      }
    } else if (typeof value === 'object' && value !== null && '__aggregateType' in value) {
      // Backward compatibility: Old AggregateMarker style
      const agg = value as AggregateMarker;
      if (agg.__aggregateType === 'COUNT') {
        return `CAST(COUNT(*) AS INTEGER) as "${alias}"`;
      } else if (agg.__selector) {
        const field = agg.__selector(mockOriginalSelection);
        if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
          const fieldRef = field as any;
          const tableAlias = fieldRef.__tableAlias || defaultTableAlias;
          if (agg.__aggregateType === 'SUM' || agg.__aggregateType === 'AVG') {
            return `CAST(${agg.__aggregateType}("${tableAlias}"."${fieldRef.__dbColumnName}") AS DOUBLE PRECISION) as "${alias}"`;
          } else {
            return `${agg.__aggregateType}("${tableAlias}"."${fieldRef.__dbColumnName}") as "${alias}"`;
          }
        }
      }
    } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
      // Direct field reference from the grouping key
      const field = value as any;
      const tableAlias = field.__tableAlias || defaultTableAlias;
      return `"${tableAlias}"."${field.__dbColumnName}" as "${alias}"`;
    } else if (value instanceof SqlFragment) {
      // SQL fragment - build the expression
      const sqlBuildContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const fragmentSql = value.buildSql(sqlBuildContext);
      context.paramCounter = sqlBuildContext.paramCounter;
      return `${fragmentSql} as "${alias}"`;
    }
    return null;
  }

  /**
   * Create mock row for the original table
   */
  private createMockRow(): any {
    const mock: any = {};
    const tableAlias = this.schema.name;

    // Add columns as FieldRef objects - use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(this.schema);

    // Performance: Lazy-cache FieldRef objects
    const fieldRefCache: Record<string, any> = {};

    for (const [colName, dbColumnName] of columnNameMap) {
      Object.defineProperty(mock, colName, {
        get() {
          let cached = fieldRefCache[colName];
          if (!cached) {
            cached = fieldRefCache[colName] = {
              __fieldName: colName,
              __dbColumnName: dbColumnName,
              __tableAlias: tableAlias,
            };
          }
          return cached;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Add navigation properties (collections and single references)
    // Performance: Use pre-computed relation entries and cached schemas
    const relationEntries = getRelationEntriesForSchema(this.schema);

    for (const [relName, relConfig] of relationEntries) {
      const targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);

      if (relConfig.type === 'many') {
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              this.schema.name,
              targetSchema
            );
          },
          enumerable: true,
          configurable: true,
        });
      } else {
        Object.defineProperty(mock, relName, {
          get: () => {
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
          configurable: true,
        });
      }
    }

    // Add columns from manually joined tables
    for (const join of this.manualJoins) {
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

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

    return mock;
  }

  /**
   * Create a mock GroupedItem for type inference
   */
  private createMockGroupedItem(): GroupedItem<TGroupingKey, TOriginalRow> {
    const mockRow = this.createMockRow();
    const mockOriginalSelection = this.originalSelector(mockRow);
    const mockKey = this.groupingKeySelector(mockOriginalSelection as TOriginalRow);

    return {
      key: mockKey as any,
      count: () => {
        return createAggregateFieldRef<number>('COUNT') as any;
      },
      sum: (selector: any) => {
        return createAggregateFieldRef<number>('SUM', selector) as any;
      },
      min: (selector: any) => {
        return createAggregateFieldRef('MIN', selector) as any;
      },
      max: (selector: any) => {
        return createAggregateFieldRef('MAX', selector) as any;
      },
      avg: (selector: any) => {
        return createAggregateFieldRef<number>('AVG', selector) as any;
      },
    };
  }

  /**
   * Detect navigation property references in a WHERE condition and add necessary JOINs
   */
  private detectAndAddJoinsFromCondition(
    condition: Condition | undefined,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean }>
  ): void {
    if (!condition) {
      return;
    }

    // Get all field references from the condition
    const fieldRefs = condition.getFieldRefs();

    for (const fieldRef of fieldRefs) {
      if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
        const tableAlias = fieldRef.__tableAlias as string;
        // Check if this references a related table that isn't already joined
        if (tableAlias !== this.schema.name && !joins.some(j => j.alias === tableAlias)) {
          // Find the relation config for this navigation
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
    }
  }

  /**
   * Detect navigation properties in a selection and add JOINs for them
   */
  private detectAndAddJoinsFromSelection(
    selection: any,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean }>
  ): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    for (const [, value] of Object.entries(selection)) {
      if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
        // This is a FieldRef with a table alias - check if it's from a related table
        this.addJoinForFieldRef(value, joins);
      } else if (value instanceof SqlFragment) {
        // SqlFragment may contain navigation property references - extract them
        const fieldRefs = value.getFieldRefs();
        for (const fieldRef of fieldRefs) {
          this.addJoinForFieldRef(fieldRef, joins);
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Recursively check nested objects
        this.detectAndAddJoinsFromSelection(value, joins);
      }
    }
  }

  /**
   * Add a JOIN for a FieldRef if it references a related table
   */
  private addJoinForFieldRef(
    fieldRef: any,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean }>
  ): void {
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
   * Build HAVING condition SQL - handles aggregate field refs specially
   */
  private buildHavingCondition(condition: Condition, context: QueryContext): string {
    // Replace aggregate field refs with SQL fragments in the condition
    const transformedCondition = this.transformHavingCondition(condition);

    // Now build the condition normally
    const condBuilder = new ConditionBuilder();
    const { sql, params } = condBuilder.build(transformedCondition, context.paramCounter);
    context.paramCounter += params.length;
    context.allParams.push(...params);
    return sql;
  }

  /**
   * Transform a HAVING condition by replacing aggregate field refs with SQL fragments
   */
  private transformHavingCondition(condition: Condition): Condition {
    // If the condition has field references, check if they're aggregate refs
    const cond = condition as any;

    // Handle different condition types
    if (cond.field && typeof cond.field === 'object' && '__isAggregate' in cond.field) {
      // This is an aggregate comparison (e.g., COUNT(*) > 5)
      const aggField = cond.field as AggregateFieldRef;
      const aggSql = this.buildAggregateFieldSql(aggField);

      // Create a new SQL fragment condition
      // Since we can't easily replace the field, we'll create a SqlFragment
      // that represents the whole expression
      const operator = this.getOperatorForCondition(cond);
      const value = cond.value;

      // Build the full comparison SQL using SqlFragment's template literal style
      // SqlFragment expects an array of strings (the template parts) and an array of values
      return new SqlFragment([`${aggSql} ${operator} `, ''], [value]) as any;
    }

    return condition;
  }

  /**
   * Build SQL for an aggregate field reference
   */
  private buildAggregateFieldSql(aggField: AggregateFieldRef): string {
    const aggType = aggField.__aggregateType;

    if (aggType === 'COUNT') {
      return 'COUNT(*)';
    } else if (aggField.__aggregateSelector) {
      // Evaluate the selector to get the actual field
      const mockRow = this.createMockRow();
      const selectedField = aggField.__aggregateSelector(mockRow);

      if (typeof selectedField === 'object' && selectedField !== null && '__dbColumnName' in selectedField) {
        const field = selectedField as any;
        const tableAlias = field.__tableAlias || this.schema.name;
        return `${aggType}("${tableAlias}"."${field.__dbColumnName}")`;
      } else {
        return `${aggType}(*)`;
      }
    } else {
      return `${aggType}(*)`;
    }
  }

  /**
   * Get the operator string from a condition object
   */
  private getOperatorForCondition(cond: any): string {
    // Try to get the operator - this is a bit of a hack
    // Different condition types have different ways to get the operator
    if (cond.getOperator && typeof cond.getOperator === 'function') {
      return cond.getOperator();
    }

    // Map common condition types to operators
    const condName = cond.constructor?.name || '';
    if (condName.includes('Eq')) return '=';
    if (condName.includes('Ne')) return '!=';
    if (condName.includes('Gt') && !condName.includes('Gte')) return '>';
    if (condName.includes('Gte')) return '>=';
    if (condName.includes('Lt') && !condName.includes('Lte')) return '<';
    if (condName.includes('Lte')) return '<=';

    return '='; // Default fallback
  }
}

/**
 * Query builder for grouped queries that have been joined
 * This handles the case where a GroupedSelectQueryBuilder is joined with a CTE or subquery
 */
export class GroupedJoinedQueryBuilder<TSelection, TLeft, TRight> {
  private schema: TableSchema;
  private client: DatabaseClient;
  private leftSubquery: Subquery<any, 'table'>;
  private leftAlias: string;
  private rightSource: Subquery<TRight, 'table'> | DbCte<TRight>;
  private rightAlias: string;
  private joinType: JoinType;
  private joinCondition: Condition;
  private resultSelector: (left: TLeft, right: TRight) => TSelection;
  private createLeftMock: () => TLeft;
  private createRightMock: () => TRight;
  private executor?: QueryExecutor;
  private cte?: DbCte<TRight>;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private additionalJoins: Array<{
    type: JoinType;
    source: Subquery<any, 'table'> | DbCte<any>;
    alias: string;
    condition: Condition;
    isCte: boolean;
    cte?: DbCte<any>;
  }> = [];

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    leftSubquery: Subquery<any, 'table'>,
    leftAlias: string,
    rightSource: Subquery<TRight, 'table'> | DbCte<TRight>,
    rightAlias: string,
    joinType: JoinType,
    joinCondition: Condition,
    resultSelector: (left: TLeft, right: TRight) => TSelection,
    createLeftMock: () => TLeft,
    createRightMock: () => TRight,
    executor?: QueryExecutor,
    cte?: DbCte<TRight>
  ) {
    this.schema = schema;
    this.client = client;
    this.leftSubquery = leftSubquery;
    this.leftAlias = leftAlias;
    this.rightSource = rightSource;
    this.rightAlias = rightAlias;
    this.joinType = joinType;
    this.joinCondition = joinCondition;
    this.resultSelector = resultSelector;
    this.createLeftMock = createLeftMock;
    this.createRightMock = createRightMock;
    this.executor = executor;
    this.cte = cte;
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
   * Order by field(s) from the selected result
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockLeft = this.createLeftMock();
    const mockRight = this.createRightMock();
    const mockResult = this.resultSelector(mockLeft, mockRight);
    const result = selector(mockResult);
    parseOrderBy(result, this.orderByFields, getQualifiedFieldName);
    return this;
  }

  /**
   * Execute query and return results
   */
  async toList(): Promise<ResolveFieldRefs<TSelection>[]> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
    };

    const { sql, params } = this.buildQuery(context);

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return result.rows;
  }

  /**
   * Execute query and return first result or null
   */
  async first(): Promise<ResolveFieldRefs<TSelection> | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return first result or throw
   */
  async firstOrThrow(): Promise<ResolveFieldRefs<TSelection>> {
    const result = await this.first();
    if (!result) {
      throw new Error('No results found');
    }
    return result;
  }

  /**
   * Convert to subquery for use in other queries
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<TMode extends 'scalar' ? ResolveFieldRefs<TSelection> : TMode extends 'array' ? ResolveFieldRefs<TSelection>[] : ResolveFieldRefs<TSelection>, TMode> {
    const sqlBuilder = (outerContext: SqlBuildContext & { tableAlias?: string }): string => {
      const context: QueryContext = {
        ctes: new Map(),
        cteCounter: 0,
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
      };

      const { sql } = this.buildQuery(context);
      outerContext.paramCounter = context.paramCounter;

      return sql;
    };

    // Preserve selection metadata for mappers
    const mockLeft = this.createLeftMock();
    const mockRight = this.createRightMock();
    const selectionMetadata = this.resultSelector(mockLeft, mockRight);

    return new Subquery(sqlBuilder, mode, selectionMetadata as any) as any;
  }

  /**
   * Get CTEs used by this query builder
   * @internal
   */
  getReferencedCtes(): DbCte<any>[] {
    return this.cte ? [this.cte] : [];
  }

  /**
   * Get selection metadata for mapper preservation in CTEs
   * Enhances the selection result with mapper info from the left subquery
   * @internal
   */
  getSelectionMetadata(): Record<string, any> {
    const mockLeft = this.createLeftMock();
    const mockRight = this.createRightMock();
    const mockResult = this.resultSelector(mockLeft, mockRight);

    // Get mapper metadata from the left subquery
    const leftMetadata = this.leftSubquery.getSelectionMetadata();

    // Build enhanced metadata with mappers
    const enhancedMetadata: Record<string, any> = {};

    for (const [key, value] of Object.entries(mockResult as object)) {
      // Check if it's a FieldRef from the left side
      if (typeof value === 'object' && value !== null && '__fieldName' in value) {
        const fieldName = (value as any).__fieldName as string;

        // Check if left metadata has mapper for this field
        if (leftMetadata && fieldName in leftMetadata) {
          const leftValue = leftMetadata[fieldName];
          if (typeof leftValue === 'object' && leftValue !== null && typeof (leftValue as any).getMapper === 'function') {
            enhancedMetadata[key] = {
              ...value,
              getMapper: () => (leftValue as any).getMapper(),
            };
            continue;
          }
        }
      }

      // No mapper found, use original value
      enhancedMetadata[key] = value;
    }

    return enhancedMetadata;
  }

  /**
   * Build SQL for use in CTEs - public interface for CTE builder
   * This returns SQL WITHOUT the WITH clause - CTEs should be extracted separately via getReferencedCtes()
   * @internal
   */
  buildCteQuery(queryContext: QueryContext): { sql: string; params: any[] } {
    return this.buildQuery(queryContext, true);
  }

  /**
   * Build the SQL query
   * @param skipCteClause If true, don't include WITH clause (for embedding in outer CTEs)
   */
  private buildQuery(context: QueryContext, skipCteClause: boolean = false): { sql: string; params: any[] } {
    // Build CTE clause if needed (unless we're being embedded in another CTE)
    let cteClause = '';
    if (this.cte && !skipCteClause) {
      cteClause = `WITH "${this.cte.name}" AS (${this.cte.query})\n`;
      context.allParams.push(...this.cte.params);
      context.paramCounter += this.cte.params.length;
    }

    // Build SELECT clause from result selector
    const mockLeft = this.createLeftMock();
    const mockRight = this.createRightMock();
    const mockResult = this.resultSelector(mockLeft, mockRight);

    const selectParts: string[] = [];
    for (const [alias, value] of Object.entries(mockResult as object)) {
      if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
        const field = value as any;
        const tableAlias = field.__tableAlias;
        if (tableAlias) {
          selectParts.push(`"${tableAlias}"."${field.__dbColumnName}" as "${alias}"`);
        } else {
          selectParts.push(`"${field.__dbColumnName}" as "${alias}"`);
        }
      } else if (value instanceof SqlFragment) {
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const fragmentSql = value.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        selectParts.push(`${fragmentSql} as "${alias}"`);
      } else {
        selectParts.push(`"${alias}"`);
      }
    }

    // Build FROM clause with the left subquery
    const leftSqlContext = {
      paramCounter: context.paramCounter,
      params: context.allParams,
    };
    const leftSql = this.leftSubquery.buildSql(leftSqlContext);
    context.paramCounter = leftSqlContext.paramCounter;

    let fromClause = `FROM (${leftSql}) AS "${this.leftAlias}"`;

    // Build JOIN clause
    const joinTypeStr = this.joinType === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';
    const condBuilder = new ConditionBuilder();
    const { sql: condSql, params: condParams } = condBuilder.build(this.joinCondition, context.paramCounter);
    context.paramCounter += condParams.length;
    context.allParams.push(...condParams);

    if (this.cte) {
      // Join to CTE
      fromClause += `\n${joinTypeStr} "${this.rightAlias}" ON ${condSql}`;
    } else {
      // Join to subquery
      const rightSqlContext = {
        paramCounter: context.paramCounter,
        params: context.allParams,
      };
      const rightSql = (this.rightSource as Subquery<TRight, 'table'>).buildSql(rightSqlContext);
      context.paramCounter = rightSqlContext.paramCounter;
      fromClause += `\n${joinTypeStr} (${rightSql}) AS "${this.rightAlias}" ON ${condSql}`;
    }

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(
        ({ field, direction }) => `${field} ${direction}`
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

    const finalQuery = `${cteClause}SELECT ${selectParts.join(', ')}\n${fromClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
    };
  }
}
