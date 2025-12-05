import { Condition, ConditionBuilder, SqlFragment, SqlBuildContext, FieldRef, WhereConditionBase } from './conditions';
import { TableSchema } from '../schema/table-builder';
import type { DatabaseClient } from '../database/database-client.interface';
import type { QueryExecutor } from '../entity/db-context';
import { Subquery } from './subquery';
import type { ManualJoinDefinition, JoinType } from './query-builder';
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
 * Type helper to resolve FieldRef types to their value types
 */
type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends Array<infer U>
  ? Array<ResolveFieldRefs<U>>
  : T extends object
  ? { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Type helper to convert resolved value types back to FieldRef for join conditions
 * This allows join conditions to accept either the value or FieldRef
 * If a field is already a FieldRef, it preserves it without double-wrapping
 */
type ToFieldRefs<T> = T extends object
  ? { [K in keyof T]: T[K] extends FieldRef<any, infer V> ? FieldRef<string, V> : FieldRef<string, T[K]> }
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
   */
  avg(selector: (item: TOriginalRow) => FieldRef<any, number> | number): number;
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

    // Add columns as FieldRef objects
    for (const [colName, colBuilder] of Object.entries(this.schema.columns)) {
      const dbColumnName = (colBuilder as any).build().name;
      Object.defineProperty(mock, colName, {
        get: () => ({
          __fieldName: colName,
          __dbColumnName: dbColumnName,
          __tableAlias: this.schema.name,
        }),
        enumerable: true,
        configurable: true,
      });
    }

    // Add columns from manually joined tables
    for (const join of this.manualJoins) {
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

      for (const [colName, colBuilder] of Object.entries(join.schema.columns)) {
        const dbColumnName = (colBuilder as any).build().name;
        if (!mock[join.alias]) {
          mock[join.alias] = {};
        }
        Object.defineProperty(mock[join.alias], colName, {
          get: () => ({
            __fieldName: colName,
            __dbColumnName: dbColumnName,
            __tableAlias: join.alias,
          }),
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
  orderBy(selector: (row: TSelection) => any): this;
  orderBy(selector: (row: TSelection) => any[]): this;
  orderBy(selector: (row: TSelection) => Array<[any, 'ASC' | 'DESC']>): this;
  orderBy(selector: (row: TSelection) => any | any[] | Array<[any, 'ASC' | 'DESC']>): this {
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);
    const result = selector(mockResult);

    // Handle array of [field, direction] tuples
    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      for (const [fieldRef, direction] of result as Array<[any, 'ASC' | 'DESC']>) {
        if (fieldRef && typeof fieldRef === 'object' && '__fieldName' in fieldRef) {
          this.orderByFields.push({
            field: (fieldRef as any).__dbColumnName || (fieldRef as any).__fieldName,
            direction: direction || 'ASC'
          });
        }
      }
    }
    // Handle array of fields (all ASC)
    else if (Array.isArray(result)) {
      for (const fieldRef of result) {
        if (fieldRef && typeof fieldRef === 'object' && '__fieldName' in fieldRef) {
          this.orderByFields.push({
            field: (fieldRef as any).__dbColumnName || (fieldRef as any).__fieldName,
            direction: 'ASC'
          });
        }
      }
    }
    // Handle single field
    else if (result && typeof result === 'object' && '__fieldName' in result) {
      this.orderByFields.push({
        field: (result as any).__dbColumnName || (result as any).__fieldName,
        direction: 'ASC'
      });
    }

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
   * Transform database results - convert aggregate values from strings to numbers
   */
  private transformResults(rows: any[]): any[] {
    // Get the mock result to identify which fields are aggregates
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);

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
        } else {
          // Non-aggregate field - keep as is
          transformed[key] = value;
        }
      }

      return transformed;
    });
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

    return new Subquery(sqlBuilder, mode) as any;
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
   */
  private buildQuery(context: QueryContext): { sql: string; params: any[] } {
    // Create mocks for evaluation
    const mockRow = this.createMockRow();
    const mockOriginalSelection = this.originalSelector(mockRow);
    const mockGroupingKey = this.groupingKeySelector(mockOriginalSelection as TOriginalRow);
    const mockGroup = this.createMockGroupedItem();
    const mockResult = this.resultSelector(mockGroup);

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
      if (typeof value === 'object' && value !== null && '__isAggregate' in value && (value as any).__isAggregate) {
        // This is an AggregateFieldRef (from our mock GroupedItem)
        const aggField = value as AggregateFieldRef;
        const aggType = aggField.__aggregateType;

        if (aggType === 'COUNT') {
          // COUNT always returns bigint, cast to integer for cleaner results
          selectParts.push(`CAST(COUNT(*) AS INTEGER) as "${alias}"`);
        } else if (aggField.__aggregateSelector) {
          // SUM, MIN, MAX, AVG with selector
          const mockOriginalRow = this.createMockRow();
          const field = aggField.__aggregateSelector(mockOriginalRow);
          if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            const fieldRef = field as any;
            const tableAlias = fieldRef.__tableAlias || this.schema.name;

            // Cast numeric aggregates to appropriate types
            if (aggType === 'SUM' || aggType === 'AVG') {
              // SUM and AVG return numeric - cast to double precision for JavaScript number
              selectParts.push(`CAST(${aggType}("${tableAlias}"."${fieldRef.__dbColumnName}") AS DOUBLE PRECISION) as "${alias}"`);
            } else {
              // MIN/MAX preserve the field's type - no cast needed usually, but could be added if needed
              selectParts.push(`${aggType}("${tableAlias}"."${fieldRef.__dbColumnName}") as "${alias}"`);
            }
          }
        } else {
          // Aggregate without selector (shouldn't happen for SUM/MIN/MAX/AVG, but handle it)
          selectParts.push(`${aggType}(*) as "${alias}"`);
        }
      } else if (typeof value === 'object' && value !== null && '__aggregateType' in value) {
        // Backward compatibility: Old AggregateMarker style (if any still exist)
        const agg = value as AggregateMarker;
        if (agg.__aggregateType === 'COUNT') {
          selectParts.push(`CAST(COUNT(*) AS INTEGER) as "${alias}"`);
        } else if (agg.__selector) {
          const mockOriginalRow = this.createMockRow();
          const field = agg.__selector(mockOriginalRow);
          if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            const fieldRef = field as any;
            const tableAlias = fieldRef.__tableAlias || this.schema.name;

            if (agg.__aggregateType === 'SUM' || agg.__aggregateType === 'AVG') {
              selectParts.push(`CAST(${agg.__aggregateType}("${tableAlias}"."${fieldRef.__dbColumnName}") AS DOUBLE PRECISION) as "${alias}"`);
            } else {
              selectParts.push(`${agg.__aggregateType}("${tableAlias}"."${fieldRef.__dbColumnName}") as "${alias}"`);
            }
          }
        }
      } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
        // Direct field reference from the grouping key
        const field = value as any;
        const tableAlias = field.__tableAlias || this.schema.name;
        selectParts.push(`"${tableAlias}"."${field.__dbColumnName}" as "${alias}"`);
      } else if (value instanceof SqlFragment) {
        // SQL fragment
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        const fragmentSql = value.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        selectParts.push(`${fragmentSql} as "${alias}"`);
      }
    }

    // Build FROM clause with JOINs
    let fromClause = `FROM "${this.schema.name}"`;

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
        fromClause += `\n${joinTypeStr} (${subquerySql}) AS "${manualJoin.alias}" ON ${condSql}`;
      } else {
        fromClause += `\n${joinTypeStr} "${manualJoin.table}" AS "${manualJoin.alias}" ON ${condSql}`;
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

    // Build GROUP BY clause
    const groupByClause = `GROUP BY ${groupByFields.join(', ')}`;

    // Build HAVING clause
    let havingClause = '';
    if (this.havingCond) {
      // Build the HAVING condition, but we need to substitute aggregate markers with actual SQL
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

    const finalQuery = `SELECT ${selectParts.join(', ')}\n${fromClause}\n${whereClause}\n${groupByClause}\n${havingClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
    };
  }

  /**
   * Create mock row for the original table
   */
  private createMockRow(): any {
    const mock: any = {};

    // Add columns as FieldRef objects
    for (const [colName, colBuilder] of Object.entries(this.schema.columns)) {
      const dbColumnName = (colBuilder as any).build().name;
      Object.defineProperty(mock, colName, {
        get: () => ({
          __fieldName: colName,
          __dbColumnName: dbColumnName,
          __tableAlias: this.schema.name,
        }),
        enumerable: true,
        configurable: true,
      });
    }

    // Add columns from manually joined tables
    for (const join of this.manualJoins) {
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

      for (const [colName, colBuilder] of Object.entries(join.schema.columns)) {
        const dbColumnName = (colBuilder as any).build().name;
        if (!mock[join.alias]) {
          mock[join.alias] = {};
        }
        Object.defineProperty(mock[join.alias], colName, {
          get: () => ({
            __fieldName: colName,
            __dbColumnName: dbColumnName,
            __tableAlias: join.alias,
          }),
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
  orderBy(selector: (row: TSelection) => any): this;
  orderBy(selector: (row: TSelection) => any[]): this;
  orderBy(selector: (row: TSelection) => Array<[any, 'ASC' | 'DESC']>): this;
  orderBy(selector: (row: TSelection) => any | any[] | Array<[any, 'ASC' | 'DESC']>): this {
    const mockLeft = this.createLeftMock();
    const mockRight = this.createRightMock();
    const mockResult = this.resultSelector(mockLeft, mockRight);
    const result = selector(mockResult);

    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      for (const [fieldRef, direction] of result as Array<[any, 'ASC' | 'DESC']>) {
        if (fieldRef && typeof fieldRef === 'object' && '__fieldName' in fieldRef) {
          const alias = (fieldRef as any).__tableAlias || '';
          const colName = (fieldRef as any).__dbColumnName || (fieldRef as any).__fieldName;
          this.orderByFields.push({
            field: alias ? `"${alias}"."${colName}"` : `"${colName}"`,
            direction: direction || 'ASC'
          });
        }
      }
    } else if (Array.isArray(result)) {
      for (const fieldRef of result) {
        if (fieldRef && typeof fieldRef === 'object' && '__fieldName' in fieldRef) {
          const alias = (fieldRef as any).__tableAlias || '';
          const colName = (fieldRef as any).__dbColumnName || (fieldRef as any).__fieldName;
          this.orderByFields.push({
            field: alias ? `"${alias}"."${colName}"` : `"${colName}"`,
            direction: 'ASC'
          });
        }
      }
    } else if (result && typeof result === 'object' && '__fieldName' in result) {
      const alias = (result as any).__tableAlias || '';
      const colName = (result as any).__dbColumnName || (result as any).__fieldName;
      this.orderByFields.push({
        field: alias ? `"${alias}"."${colName}"` : `"${colName}"`,
        direction: 'ASC'
      });
    }

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
   * Build the SQL query
   */
  private buildQuery(context: QueryContext): { sql: string; params: any[] } {
    // Build CTE clause if needed
    let cteClause = '';
    if (this.cte) {
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
