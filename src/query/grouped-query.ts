import { and, Condition, ConditionBuilder, SqlFragment, SqlBuildContext, FieldRef, WhereConditionBase } from './conditions';
import { TableSchema } from '../schema/table-builder';
import type { DatabaseClient } from '../database/database-client.interface';
import type { OrderDirection } from '../entity/db-context';
import { QueryExecutor } from '../entity/db-context';
import { assertNoCorrelatedAliasShadowing, isForeignChainRef, parseOrderBy, getQualifiedFieldName, projectedAliasOf } from './query-utils';
import { Subquery } from './subquery';
import type { ManualJoinDefinition, JoinType } from './query-builder';
import {
  CollectionQueryBuilder,
  ReferenceQueryBuilder,
  aggregatedItemReads,
  assertProjectionArrayOfValues,
  getColumnNameMapForSchema,
  getRelationEntriesForSchema,
  getTargetSchemaForRelation,
  mapAggregatedItems,
  projectionLiteralSql,
} from './query-builder';
import { DbCte, isCte, projectedValueRef } from './cte-builder';
import { formatJoinValue, NavigationAliasPlan } from './join-utils';
import { selectorProjectingConditions } from './sql-functions';

/**
 * Query context for tracking CTEs and parameters
 */
interface QueryContext {
  ctes: Map<string, { sql: string; params: any[] }>;
  cteCounter: number;
  paramCounter: number;
  allParams: any[];
  /** True when the driver cannot decode native ARRAY result columns (BunClient). */
  useJsonArrayAggregation?: boolean;
  /**
   * Names of CTEs an enclosing builder has already declared at statement level
   * (see {@link SqlBuildContext.hoistedCteNames}). Carried so anything nested in
   * this query — notably a CTE-rooted subquery in the WHERE — reads the
   * statement-level relation instead of re-declaring it.
   */
  hoistedCteNames?: Set<string>;
  /**
   * Render the projection's constants typed from their JS type — set for a projection other queries
   * read as columns (a CTE body, a table subquery). See {@link SqlBuildContext.typedLiterals}.
   */
  typedLiterals?: boolean;
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
type ResolveFieldRefs<T> = T extends SqlFragment<infer V>
  ? V  // an expression (coalesce, caseWhen, casts, …) resolves to its value type
  : T extends WhereConditionBase
  ? boolean  // a condition projects as a boolean column
  : T extends FieldRef<any, infer V>
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

/** Column types whose values a MIN / MAX reads back as a JS number (as COUNT / SUM / AVG do). */
const NUMERIC_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision',
  'smallserial', 'serial', 'bigserial', 'int2', 'int4', 'int8', 'float4', 'float8',
]);

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
 * The group a `having()` callback reads: the key and aggregates of {@link GroupedItem}, typed as the
 * columns they are in the HAVING clause, so they go into conditions as they are —
 * `gt(g.count(), 2)`, `eq(g.key.status, 'open')`, `lt(g.max(r => r.label), 'M')` — without a cast.
 */
export interface HavingGroupedItem<TGroupingKey, TOriginalRow> {
  /** The grouping key's fields. */
  readonly key: { readonly [K in keyof ResolveFieldRefs<TGroupingKey>]: FieldRef<string, ResolveFieldRefs<TGroupingKey>[K]> };

  /** `COUNT(*)` of the group. */
  count(): FieldRef<string, number>;

  /** `SUM(...)` of a column or expression of the grouped row. */
  sum<TField>(selector: (item: TOriginalRow) => TField): FieldRef<string, number>;

  /** `MIN(...)` of a column or expression of the grouped row — a value of its type. */
  min<TField>(selector: (item: TOriginalRow) => TField): FieldRef<string, TField extends FieldRef<any, infer V> ? V : TField>;

  /** `MAX(...)` of a column or expression of the grouped row — a value of its type. */
  max<TField>(selector: (item: TOriginalRow) => TField): FieldRef<string, TField extends FieldRef<any, infer V> ? V : TField>;

  /** `AVG(...)` of a column or expression of the grouped row. */
  avg(selector: (item: TOriginalRow) => FieldRef<any, number | undefined> | number | undefined): FieldRef<string, number>;
}

/** A `having()` callback: the condition a group must meet, over its key and aggregates. */
type HavingSelector<TGroupingKey, TOriginalRow> = (group: HavingGroupedItem<TGroupingKey, TOriginalRow>) => Condition;

/** Whether `value` is an aggregate ref minted by a mock group (`g.count()`, `g.sum(...)`, …). */
function isAggregateRef(value: unknown): value is AggregateFieldRef {
  return typeof value === 'object' && value !== null && (value as any).__isAggregate === true;
}

/** Whether `value` is a column ref (a FieldRef of the grouped row, of a navigation or of a join). */
function isFieldRefValue(value: unknown): value is FieldRef & { __tableAlias?: string } {
  return typeof value === 'object' && value !== null && '__dbColumnName' in value && !(value instanceof WhereConditionBase);
}

/** What `value` is, for an error that refuses it in a grouped query. */
function describeGroupedValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined (a property the row does not have?)';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (value instanceof CollectionQueryBuilder) {
    return 'a collection (a navigation to many rows)';
  }
  if (typeof value === 'function') {
    return 'a function';
  }
  if (typeof value === 'object') {
    return 'a nested object (a whole navigation row, or an object of fields?)';
  }
  return `the constant ${JSON.stringify(value)}`;
}

/**
 * What one build of a grouped select evaluates once and every clause reads: the grouped row, its key,
 * the projection, the HAVING condition over the same group, and each aggregate's argument.
 */
interface GroupedBuildState {
  /** The grouped row: the projection the grouping reads (its keys and the aggregates' arguments). */
  mockOriginalSelection: any;
  mockGroupingKey: any;
  mockResult: any;
  havingCond?: Condition;
  /** Each aggregate's argument — a column or an expression of the grouped row. */
  aggregateArguments: Map<AggregateFieldRef, unknown>;
}

/**
 * How a grouped build reads the grouped row: straight off the joined tables, or — when it groups by an
 * expression — as the columns of the subquery that computes it.
 */
interface GroupedRenderer {
  /** The SQL of an aggregate's argument (or of a column the projection reads outside the key). */
  argument(argument: unknown, aggregate: AggregateFieldRef | undefined): string;
  /** The SQL of a grouping key, or `undefined` when `value` is none (or needs no substitution). */
  key(value: object): string | undefined;
}

/**
 * Grouped query builder - result of calling groupBy()
 * Provides type-safe access to grouping keys and aggregate functions
 */
export class GroupedQueryBuilder<TOriginalRow, TGroupingKey> {
  /** @internal Chain identity of the query this grouping came from — see isForeignChainRef. */
  public chainId?: number;
  private schema: TableSchema;
  private client: DatabaseClient;
  private originalSelector: (row: any) => any;
  private groupingKeySelector: (row: TOriginalRow) => TGroupingKey;
  private whereCond?: Condition;
  private havingSelectors: Array<HavingSelector<TGroupingKey, TOriginalRow>> = [];
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: OrderDirection; aliased?: boolean }> = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;
  private schemaRegistry?: Map<string, TableSchema>;

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    originalSelector: (row: any) => any,
    groupingKeySelector: (row: TOriginalRow) => TGroupingKey,
    whereCond?: Condition,
    executor?: QueryExecutor,
    manualJoins?: ManualJoinDefinition[],
    joinCounter?: number,
    schemaRegistry?: Map<string, TableSchema>,
    chainId?: number
  ) {
    this.schema = schema;
    this.client = client;
    this.originalSelector = originalSelector;
    this.groupingKeySelector = groupingKeySelector;
    this.whereCond = whereCond;
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
    this.schemaRegistry = schemaRegistry;
    this.chainId = chainId;
  }

  /**
   * Override the timeout for this single query (ms). Only this query is wrapped
   * (`SET LOCAL statement_timeout`). Overrides the connection-level default; pass
   * `0` to disable. On timeout a `QueryTimeoutError` is thrown.
   */
  withTimeout(timeoutMs: number): this {
    this.executor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return this;
  }

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires (the query is
   * NOT cancelled). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return this;
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
      [...this.havingSelectors],
      this.limitValue,
      this.offsetValue,
      this.orderByFields,
      this.executor,
      this.manualJoins,
      this.joinCounter,
      this.schemaRegistry,
      this.chainId
    );
  }

  /**
   * Add a HAVING condition (filters groups after aggregation). Chained calls are combined with AND.
   * The callback runs when the query is built, over the same group the projection reads: its key
   * and aggregates render exactly as they do in the SELECT.
   */
  having(
    condition: (group: HavingGroupedItem<TGroupingKey, TOriginalRow>) => Condition
  ): this {
    this.havingSelectors.push(condition);
    return this;
  }
}

/**
 * Grouped select query builder - result of calling select() on a GroupedQueryBuilder
 */
export class GroupedSelectQueryBuilder<TSelection, TOriginalRow, TGroupingKey> {
  /** @internal Chain identity inherited from the query this grouping came from. */
  public chainId?: number;
  /**
   * @internal The navigation plan of the build in progress (see {@link withNavigationPlan});
   * `undefined` between builds and for builds it cannot change.
   */
  private navigationPlan?: NavigationAliasPlan;
  private schema: TableSchema;
  private client: DatabaseClient;
  private originalSelector: (row: any) => any;
  private groupingKeySelector: (row: TOriginalRow) => TGroupingKey;
  private resultSelector: (group: GroupedItem<TGroupingKey, TOriginalRow>) => TSelection;
  private whereCond?: Condition;
  private havingSelectors: Array<HavingSelector<TGroupingKey, TOriginalRow>>;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: OrderDirection; aliased?: boolean }> = [];
  private executor?: QueryExecutor;
  private manualJoins: ManualJoinDefinition[] = [];
  private joinCounter: number = 0;
  private schemaRegistry?: Map<string, TableSchema>;

  constructor(
    schema: TableSchema,
    client: DatabaseClient,
    originalSelector: (row: any) => any,
    groupingKeySelector: (row: TOriginalRow) => TGroupingKey,
    resultSelector: (group: GroupedItem<TGroupingKey, TOriginalRow>) => TSelection,
    whereCond?: Condition,
    havingSelectors?: Array<HavingSelector<TGroupingKey, TOriginalRow>>,
    limit?: number,
    offset?: number,
    orderBy?: Array<{ field: string; direction: OrderDirection; aliased?: boolean }>,
    executor?: QueryExecutor,
    manualJoins?: ManualJoinDefinition[],
    joinCounter?: number,
    schemaRegistry?: Map<string, TableSchema>,
    chainId?: number
  ) {
    this.chainId = chainId;
    this.schema = schema;
    this.client = client;
    this.originalSelector = originalSelector;
    this.groupingKeySelector = groupingKeySelector;
    this.resultSelector = selectorProjectingConditions(resultSelector);
    this.whereCond = whereCond;
    this.havingSelectors = havingSelectors ?? [];
    this.limitValue = limit;
    this.offsetValue = offset;
    this.orderByFields = orderBy || [];
    this.executor = executor;
    this.manualJoins = manualJoins || [];
    this.joinCounter = joinCounter || 0;
    this.schemaRegistry = schemaRegistry;
  }

  /**
   * Override the timeout for this single query (ms). Only this query is wrapped
   * (`SET LOCAL statement_timeout`). Overrides the connection-level default; pass
   * `0` to disable. On timeout a `QueryTimeoutError` is thrown.
   */
  withTimeout(timeoutMs: number): this {
    this.executor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return this;
  }

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires (the query is
   * NOT cancelled). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return this;
  }

  /**
   * Add a HAVING condition (filters groups after aggregation). Chained calls — and one made before
   * select() — are combined with AND. The callback runs when the query is built, over the same group
   * the projection reads: its key and aggregates render exactly as they do in the SELECT.
   */
  having(
    condition: (group: HavingGroupedItem<TGroupingKey, TOriginalRow>) => Condition
  ): this {
    this.havingSelectors.push(condition);
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
    // An aggregate or `sql` fragment of the projection orders by its output alias
    parseOrderBy(result, this.orderByFields, undefined, undefined, projectedAliasOf(mockResult, { columns: true }));
    return this;
  }

  /**
   * Execute query and return results
   */
  async toList(): Promise<ResolveFieldRefs<TSelection>[]> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
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
    const readers = this.buildFieldReaders();

    return rows.map(row => {
      const transformed: any = {};

      for (const [key, value] of Object.entries(row)) {
        const read = readers.get(key);
        transformed[key] = read ? read(value) : value;
      }

      return transformed;
    });
  }

  /**
   * How each field of this grouped projection reads back from its driver value, keyed by the
   * projection's keys: an aggregate as a number (a MIN / MAX as a value of its type), a mapped
   * column through its mapper; a field without a reader reads as the driver delivers it. Shared by
   * toList() and by a join of this grouped query, whose rows carry the grouped fields as they are —
   * they used to come back raw there (a count as the driver's string, a mapped MIN unmapped).
   * @internal
   */
  buildFieldReaders(): Map<string, (value: any) => any> {
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

    const readers = new Map<string, (value: any) => any>();

    for (const [key, mockValue] of Object.entries(mockResult as object)) {
      // A constant reads back as itself: its parameter comes back as text (`true` as "true", `42`
      // as "42", a Date as a string)
      if (mockValue === null || mockValue === undefined || typeof mockValue !== 'object' || mockValue instanceof Date) {
        readers.set(key, () => mockValue);
        continue;
      }

      // Check if this field is an aggregate
      if (mockValue && typeof mockValue === 'object' && '__isAggregate' in mockValue && mockValue.__isAggregate) {
        const aggType = (mockValue as AggregateFieldRef).__aggregateType;

        readers.set(key, aggType === 'MIN' || aggType === 'MAX'
          // An extreme of a value is a value of its type
          ? value => this.readExtremeValue(value, mockValue as AggregateFieldRef, mockOriginalSelection)
          // COUNT, SUM and AVG are numbers (SUM / AVG are cast to double precision)
          : value => (value === null ? null : Number(value)));
      }
      // Check if this field has a mapper
      else if (columnMetadataCache[key]?.hasMapper) {
        const mapper = columnMetadataCache[key].mapper;

        readers.set(key, value => {
          if (value === null || value === undefined) {
            return null;
          }

          return typeof mapper.fromDriver === 'function' ? mapper.fromDriver(value) : value;
        });
      }
      // Non-aggregate field without mapper - keep as is
    }

    return readers;
  }

  /**
   * The MIN / MAX of a value, read the way the value itself reads: through its column's mapper, as a
   * number for a numeric column, as the driver delivers it for any other column (text, dates,
   * timestamps, uuid, …). Every MIN / MAX used to go through Number(): a text extreme came back NaN
   * (null in JSON) and a timestamp one as epoch milliseconds, and mapped columns skipped their mapper.
   */
  private readExtremeValue(value: any, aggregate: AggregateFieldRef, originalSelection: any): any {
    if (value === null || value === undefined) {
      return null;
    }

    const { mapper, sqlType } = this.extremeTypeOf(aggregate, originalSelection);

    if (mapper && typeof mapper.fromDriver === 'function') {
      return mapper.fromDriver(value);
    }

    if (sqlType !== undefined) {
      return NUMERIC_COLUMN_TYPES.has(sqlType) ? Number(value) : value;
    }

    // An expression of unknown type: a numeric-looking string reads as a number, as for any fragment
    return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }

  /**
   * What the MIN / MAX `aggregate` is an extreme of: the mapper and SQL type of its column (or the
   * mapper of its `sql` expression), as far as they are known.
   */
  private extremeTypeOf(aggregate: AggregateFieldRef, originalSelection: any): { mapper?: any; sqlType?: string } {
    let source: any;
    try {
      source = aggregate.__aggregateSelector?.(originalSelection);
    } catch {
      source = undefined;
    }

    let mapper: any;
    let sqlType: string | undefined;

    if (source && typeof source === 'object') {
      if (typeof source.getMapper === 'function') {
        mapper = source.getMapper();
      } else if ('__fieldName' in source) {
        // A navigation's column carries its mapper and type; one of the grouped table or of a
        // manual join is looked up in that table's schema
        mapper = source.__mapper;
        sqlType = source.__sqlType;

        const alias: string | undefined = source.__tableAlias;
        const tableSchema = (source.__sourceTable ? this.schemaRegistry?.get(source.__sourceTable) : undefined)
          ?? (alias === undefined || alias === this.schema.name ? this.schema : undefined)
          ?? this.manualJoins.find(join => join.alias === alias)?.schema
          ?? this.schemaRegistry?.get(alias!);
        const column = tableSchema?.columns[source.__fieldName];

        if (column) {
          const config = column.build();
          mapper = mapper ?? config.mapper;
          sqlType = sqlType ?? config.type;
        }
      }
    }

    return { mapper, sqlType };
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
      // The MIN / MAX of a mapped column reads through the column's mapper
      if (isAggregateRef(value)) {
        const mapper = value.__aggregateType === 'MIN' || value.__aggregateType === 'MAX'
          ? this.extremeTypeOf(value, mockOriginalSelection).mapper
          : undefined;

        enhancedMetadata[key] = mapper ? { ...value, getMapper: () => mapper } : value;
        continue;
      }

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
   * Execute query and return first result or null (alias for first)
   */
  async firstOrDefault(): Promise<ResolveFieldRefs<TSelection> | null> {
    return this.first();
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
        useJsonArrayAggregation: outerContext.useJsonArrayAggregation ?? !this.client.supportsBinaryArrayResults(),
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
        // See SelectQueryBuilder.asSubquery — the statement-level CTE set must
        // survive the subquery boundary or anything nested re-declares it.
        hoistedCteNames: outerContext.hoistedCteNames,
        // The enclosing query reads the subquery's columns: its constants render typed
        typedLiterals: true,
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
      isCteJoin ? cte as any : undefined,
      // The grouped fields read back as this grouped query reads them
      this.buildFieldReaders()
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

    // Each column's ref carries how it reads — its own mapper, a literal's type, a json_agg
    // column's items (see projectedColumnRef); they used to carry a `mapWith` mapper only
    return new Proxy({} as any, {
      get(_target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        return projectedValueRef(prop, alias, selectionMetadata ? selectionMetadata[prop] : undefined);
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
    // The refs every CTE mock row mints (see DbCte.columnRef)
    return new Proxy({} as any, {
      get(_target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;

        return cte.columnRef(prop);
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
   * This improves query performance by computing expressions only once.
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

    // HAVING over the SAME group: its key and aggregates are the objects the projection reads
    // (at runtime the group's keys and aggregates ARE the column refs the HAVING group types them as)
    const havingCond = this.buildHavingConditionOf(mockGroup as unknown as HavingGroupedItem<TGroupingKey, TOriginalRow>);

    // Every aggregate's argument, evaluated once over the grouped row: the navigation plan, the
    // joins and the rendering all see the same refs
    const aggregateArguments = new Map<AggregateFieldRef, unknown>();
    const collectAggregate = (value: unknown): void => {
      if (isAggregateRef(value) && value.__aggregateSelector && !aggregateArguments.has(value)) {
        aggregateArguments.set(value, value.__aggregateSelector(mockOriginalSelection));
      }
    };
    for (const value of Object.values(mockResult as object)) {
      collectAggregate(value);
    }
    for (const ref of havingCond?.getFieldRefs() ?? []) {
      collectAggregate(ref);
    }

    // Check if we have SqlFragment expressions in the grouping key
    // If so, we'll use the subquery wrapping optimization
    const hasSqlFragmentInGroupBy = Object.values(mockGroupingKey as object).some(
      value => value instanceof WhereConditionBase
    );

    const state: GroupedBuildState = { mockOriginalSelection, mockGroupingKey, mockResult, havingCond, aggregateArguments };

    return this.withNavigationPlan(
      [mockOriginalSelection, mockGroupingKey, ...aggregateArguments.values()],
      havingCond,
      () => this.buildQueryBody(context, state, hasSqlFragmentInGroupBy)
    );
  }

  /** The HAVING condition of `group`: every having() callback's, combined with AND. */
  private buildHavingConditionOf(group: HavingGroupedItem<TGroupingKey, TOriginalRow>): Condition | undefined {
    const conditions = this.havingSelectors.map(selector => selector(group));

    return conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /**
   * Runs one build under the navigation plan of the grouped selection, its grouping key, its WHERE
   * and its HAVING: every reference-navigation path they traverse is joined on its own parent, and the
   * refs of a path that lost its plain alias to another path ending in the same relation name render
   * under a path alias until `build` returns. See NavigationAliasPlan.
   */
  private withNavigationPlan<T>(values: readonly unknown[], havingCond: Condition | undefined, build: () => T): T {
    const plan = new NavigationAliasPlan(this.schema, this.schema.name, this.schemaRegistry, this.chainId);

    for (const value of values) {
      this.addSelectionToNavigationPlan(value, plan);
    }

    for (const condition of [this.whereCond, havingCond]) {
      if (condition) {
        for (const ref of condition.getFieldRefs()) {
          // An aggregate ref is no column: its argument was added with the values
          if (!isAggregateRef(ref)) {
            plan.addRef(ref);
          }
        }
      }
    }

    const sealed = plan.seal();
    const previous = this.navigationPlan;
    this.navigationPlan = sealed;
    const restore = sealed?.apply();

    try {
      return build();
    } finally {
      restore?.();
      this.navigationPlan = previous;
    }
  }

  /** Records the navigation paths a selection traverses: its field refs and those inside `sql` fragments and nested objects. */
  private addSelectionToNavigationPlan(value: unknown, plan: NavigationAliasPlan): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof CollectionQueryBuilder) {
      return;
    }

    if ('__dbColumnName' in value) {
      plan.addRef(value);
      return;
    }

    if (value instanceof SqlFragment) {
      for (const ref of value.getFieldRefs()) {
        plan.addRef(ref);
      }
      return;
    }

    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        this.addSelectionToNavigationPlan((value as any)[key], plan);
      }
    }
  }

  /** The body of {@link buildQuery}, run under its navigation plan. */
  private buildQueryBody(
    context: QueryContext,
    state: GroupedBuildState,
    hasSqlFragmentInGroupBy: boolean
  ): { sql: string; params: any[] } {
    // Detect navigation property references in WHERE and add JOINs
    const navigationJoins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }> = [];

    // Detect joins from the original selection (navigation properties used in select)
    this.detectAndAddJoinsFromSelection(state.mockOriginalSelection, navigationJoins);

    // ... and from the aggregates' arguments, which can reach a navigation the grouped row does not
    // project (an expression written inside g.sum(...), a column of an entity row)
    this.detectAndAddJoinsFromSelection([...state.aggregateArguments.values()], navigationJoins);

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
      const sourceAlias = navJoin.sourceAlias || this.schema.name;
      const joinConditions = navJoin.foreignKeys.map((fk, i) => {
        const targetCol = navJoin.matches[i] || 'id';
        return `${formatJoinValue(sourceAlias, fk)} = ${formatJoinValue(navJoin.alias, targetCol)}`;
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
      const { sql, params } = condBuilder.build(
        this.whereCond,
        context.paramCounter,
        undefined,
        context.hoistedCteNames
      );
      whereClause = `WHERE ${sql}`;
      context.paramCounter += params.length;
      context.allParams.push(...params);
    }

    // One build context for the rest of the statement: every part shares its parameter counter
    const buildContext: SqlBuildContext = {
      paramCounter: context.paramCounter,
      params: context.allParams,
      hoistedCteNames: context.hoistedCteNames,
      typedLiterals: context.typedLiterals,
    };

    try {
      return hasSqlFragmentInGroupBy
        // Grouping by an expression: group the rows of a subquery that computes it once
        ? this.buildQueryWithSubqueryWrapping(buildContext, state, baseFromClause, whereClause)
        // Grouping by columns only
        : this.buildSimpleGroupedQuery(buildContext, state, baseFromClause, whereClause);
    } finally {
      context.paramCounter = buildContext.paramCounter;
    }
  }

  /**
   * Build a simple grouped query when GROUP BY only contains column references
   */
  private buildSimpleGroupedQuery(
    buildContext: SqlBuildContext,
    state: GroupedBuildState,
    baseFromClause: string,
    whereClause: string
  ): { sql: string; params: any[] } {
    // Extract GROUP BY fields from the grouping key
    const groupByFields: string[] = [];
    for (const [key, value] of Object.entries(state.mockGroupingKey as object)) {
      groupByFields.push(this.directColumnSql(value, () => `groupBy(): the grouping key "${key}"`));
    }

    // Columns and expressions read straight off the joined rows
    const renderer: GroupedRenderer = {
      argument: (argument, aggregate) => this.directArgumentSql(argument, aggregate, buildContext),
      key: () => undefined,
    };

    // Build SELECT clause from result selector
    const selectParts = this.buildSelectParts(state, renderer, buildContext);

    // Build GROUP BY clause
    const groupByClause = groupByFields.length > 0 ? `GROUP BY ${groupByFields.join(', ')}` : '';

    // Build HAVING clause
    const havingClause = this.buildHavingClause(state, renderer, buildContext);

    // Build ORDER BY clause
    const orderByClause = this.buildGroupedOrderByClause();

    // Build LIMIT/OFFSET
    const limitClause = this.buildLimitClause();

    const finalQuery = `SELECT ${selectParts.join(', ')}\nFROM ${baseFromClause}\n${whereClause}\n${groupByClause}\n${havingClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: buildContext.params,
    };
  }

  /**
   * Build a grouped query with subquery wrapping for complex GROUP BY expressions
   * This avoids repeating SqlFragment expressions in both SELECT and GROUP BY
   *
   * The subquery projects each grouping key under its own name and each aggregate's argument under
   * a column of its own (`__arg<n>`); the outer query reads nothing else. Its HAVING and ORDER BY
   * read the same columns: a key by its name, an aggregate over its argument's column.
   */
  private buildQueryWithSubqueryWrapping(
    buildContext: SqlBuildContext,
    state: GroupedBuildState,
    baseFromClause: string,
    whereClause: string
  ): { sql: string; params: any[] } {
    // Step 1: the subquery's columns — grouping keys, then (as the outer query asks for them) the
    // aggregates' arguments
    const innerSelectParts: string[] = [];
    const groupByAliases: string[] = [];
    const keyAliases = new Map<object, string>();
    const argumentAliases = new Map<unknown, string>();

    // Renders an expression of the joined rows, never through the outer query's substitutions
    const renderInner = (expression: WhereConditionBase): string => {
      const substitute = buildContext.substitute;
      buildContext.substitute = undefined;

      try {
        return expression.buildSql(buildContext);
      } finally {
        buildContext.substitute = substitute;
      }
    };

    for (const [key, value] of Object.entries(state.mockGroupingKey as object)) {
      if (value instanceof WhereConditionBase && !isFieldRefValue(value)) {
        innerSelectParts.push(`${renderInner(value)} as "${key}"`);
      } else {
        innerSelectParts.push(`${this.directColumnSql(value, () => `groupBy(): the grouping key "${key}"`)} as "${key}"`);
      }
      groupByAliases.push(`"${key}"`);
      keyAliases.set(value, key);
    }

    // A grouping key, also when the condition reads it through another ref to the same column
    const keyAliasOf = (value: object): string | undefined => {
      const alias = keyAliases.get(value);

      if (alias !== undefined || !isFieldRefValue(value)) {
        return alias;
      }

      for (const [key, alias] of keyAliases) {
        if (isFieldRefValue(key)
          && key.__dbColumnName === value.__dbColumnName
          && ((key as any).__tableAlias || this.schema.name) === ((value as any).__tableAlias || this.schema.name)) {
          return alias;
        }
      }

      return undefined;
    };

    const renderer: GroupedRenderer = {
      argument: (argument, aggregate) => {
        const keyAlias = typeof argument === 'object' && argument !== null ? keyAliasOf(argument) : undefined;
        if (keyAlias !== undefined) {
          return `"${keyAlias}"`;
        }

        // The same column or expression is projected once
        const identity = isFieldRefValue(argument)
          ? `${(argument as any).__tableAlias || this.schema.name}.${argument.__dbColumnName}`
          : argument;
        let alias = argumentAliases.get(identity);

        if (alias === undefined) {
          alias = `__arg${argumentAliases.size}`;
          const argumentSql = argument instanceof WhereConditionBase && !isFieldRefValue(argument)
            ? renderInner(argument)
            : this.directArgumentSql(argument, aggregate, buildContext);
          innerSelectParts.push(`${argumentSql} as "${alias}"`);
          argumentAliases.set(identity, alias);
        }

        return `"${alias}"`;
      },
      key: value => {
        const alias = keyAliasOf(value);
        return alias === undefined ? undefined : `"${alias}"`;
      },
    };

    // Step 2: the outer query over the subquery's columns (its SELECT and HAVING add the aggregate
    // arguments to the subquery as they go, so the subquery is assembled last)
    const outerSelectParts = this.buildSelectParts(state, renderer, buildContext);
    const havingClause = this.buildHavingClause(state, renderer, buildContext);
    const orderByClause = this.buildGroupedOrderByClause();
    const limitClause = this.buildLimitClause();

    const innerQuery = `SELECT ${innerSelectParts.join(', ')}\nFROM ${baseFromClause}\n${whereClause}`.trim();
    const groupByClause = `GROUP BY ${groupByAliases.join(', ')}`;

    const finalQuery = `SELECT ${outerSelectParts.join(', ')}\nFROM (${innerQuery}) "q1"\n${groupByClause}\n${havingClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: buildContext.params,
    };
  }

  /**
   * The SELECT list of a grouped query: each field of the projection under its name. An aggregate
   * renders as the aggregate over its argument, a grouping key as the key, an `sql` expression with
   * its aggregates and keys rendered the same way (`sql\`${g.sum(r => r.x)} / ${g.count()}\``), a
   * constant as a parameter. A field that is none of these — a nested object, a collection — is
   * refused; it used to be left out of the SELECT (and the result) without a word.
   */
  private buildSelectParts(state: GroupedBuildState, renderer: GroupedRenderer, buildContext: SqlBuildContext): string[] {
    const selectParts: string[] = [];

    this.withSubstitutions(state, renderer, buildContext, () => {
      for (const [alias, value] of Object.entries(state.mockResult as object)) {
        selectParts.push(`${this.projectionSql(alias, value, state, renderer, buildContext)} as "${alias}"`);
      }
    });

    return selectParts;
  }

  /** The SQL of one field of a grouped projection (see {@link buildSelectParts}). */
  private projectionSql(
    alias: string,
    value: unknown,
    state: GroupedBuildState,
    renderer: GroupedRenderer,
    buildContext: SqlBuildContext
  ): string {
    if (isAggregateRef(value)) {
      return this.aggregateSql(value, state, renderer, true);
    }

    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'object' && (isFieldRefValue(value) || value instanceof WhereConditionBase)) {
      const keySql = renderer.key(value);
      if (keySql !== undefined) {
        return keySql;
      }

      if (isFieldRefValue(value)) {
        return renderer.argument(value, undefined);
      }

      // An expression of keys and aggregates (rendered through the substitutions)
      return (value as WhereConditionBase).buildSql(buildContext);
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || value instanceof Date) {
      // Typed from its JS type when another query reads the columns (a CTE body, a subquery)
      const literalContext = { paramCounter: buildContext.paramCounter, allParams: buildContext.params, typedLiterals: buildContext.typedLiterals };
      const literalSql = projectionLiteralSql(value, literalContext);
      buildContext.paramCounter = literalContext.paramCounter;

      return literalSql;
    }

    throw new Error(
      `Grouped select(): "${alias}" is ${describeGroupedValue(value)} — a grouped query projects its keys, `
      + 'aggregates (g.count(), g.sum(...), …), sql expressions over them and constants, each as a top-level field.'
    );
  }

  /**
   * The SQL of an aggregate: `COUNT(*)`, or the function over its argument as `renderer` reads it.
   * In the SELECT list, COUNT is an integer and SUM / AVG a double precision, as the result reads them.
   */
  private aggregateSql(aggregate: AggregateFieldRef, state: GroupedBuildState, renderer: GroupedRenderer, inSelectList: boolean): string {
    const type = aggregate.__aggregateType;

    if (type === 'COUNT') {
      return inSelectList ? 'CAST(COUNT(*) AS INTEGER)' : 'COUNT(*)';
    }

    const call = `${type}(${renderer.argument(this.aggregateArgumentOf(aggregate, state), aggregate)})`;

    return inSelectList && (type === 'SUM' || type === 'AVG') ? `CAST(${call} AS DOUBLE PRECISION)` : call;
  }

  /** The argument `aggregate`'s selector returns over the grouped row, evaluated once per build. */
  private aggregateArgumentOf(aggregate: AggregateFieldRef, state: GroupedBuildState): unknown {
    if (!state.aggregateArguments.has(aggregate)) {
      state.aggregateArguments.set(aggregate, aggregate.__aggregateSelector?.(state.mockOriginalSelection));
    }

    return state.aggregateArguments.get(aggregate);
  }

  /**
   * An aggregate's argument read straight off the joined rows: a column (under its navigation's
   * planned alias), or an `sql` expression / condition over the row. Anything else is refused —
   * it used to leave the aggregate out of the SELECT, or render `SUM(*)`.
   */
  private directArgumentSql(argument: unknown, aggregate: AggregateFieldRef | undefined, buildContext: SqlBuildContext): string {
    if (isFieldRefValue(argument)) {
      const tableAlias = this.navigationPlan?.nodeOf(argument)?.alias || (argument as any).__tableAlias || this.schema.name;
      return `"${tableAlias}"."${argument.__dbColumnName}"`;
    }

    if (argument instanceof WhereConditionBase) {
      return argument.buildSql(buildContext);
    }

    const name = aggregate ? `g.${aggregate.__aggregateType.toLowerCase()}()` : 'Grouped select()';
    throw new Error(
      `${name}: the selector returned ${describeGroupedValue(argument)} — it must return a column or an sql expression of the grouped row.`
    );
  }

  /** A grouping key that is a column: `"<alias>"."<column>"`. */
  private directColumnSql(value: unknown, subject: () => string): string {
    if (isFieldRefValue(value)) {
      const tableAlias = (value as any).__tableAlias || this.schema.name;
      return `"${tableAlias}"."${value.__dbColumnName}"`;
    }

    throw new Error(`${subject()} is ${describeGroupedValue(value)} — a grouping key is a column or an sql expression of the row.`);
  }

  /**
   * The HAVING clause: the having() conditions over the SAME group the projection reads, every
   * aggregate in them — at any depth: inside and / or / not, between, in, an `sql` fragment, the
   * right-hand side of a comparison — rendered as in the SELECT, every grouping key as in the GROUP BY.
   * Only a top-level comparison with an aggregate on its left used to render; everything else
   * named the aggregate's function as a column (`"count"`) or rendered `SUM(*)`.
   */
  private buildHavingClause(state: GroupedBuildState, renderer: GroupedRenderer, buildContext: SqlBuildContext): string {
    if (!state.havingCond) {
      return '';
    }

    const havingCond = state.havingCond;
    let sql = '';

    this.withSubstitutions(state, renderer, buildContext, () => {
      sql = havingCond.buildSql(buildContext);
    });

    return `HAVING ${sql}`;
  }

  /** Runs `render` with the grouped substitutions on: aggregate refs render as aggregates, keys as keys. */
  private withSubstitutions(state: GroupedBuildState, renderer: GroupedRenderer, buildContext: SqlBuildContext, render: () => void): void {
    const previous = buildContext.substitute;
    buildContext.substitute = value => isAggregateRef(value)
      ? this.aggregateSql(value, state, renderer, false)
      : renderer.key(value);

    try {
      render();
    } finally {
      buildContext.substitute = previous;
    }
  }

  /** ORDER BY: an output alias as itself, a property of the grouped row as its column. */
  private buildGroupedOrderByClause(): string {
    if (this.orderByFields.length === 0) {
      return '';
    }

    const colNameMap = getColumnNameMapForSchema(this.schema);
    const orderParts = this.orderByFields.map(({ field, direction, aliased }) => {
      const dbColumnName = aliased ? field : colNameMap.get(field) ?? field;
      return `"${dbColumnName}" ${direction}`;
    });

    return `ORDER BY ${orderParts.join(', ')}`;
  }

  /** LIMIT / OFFSET. */
  private buildLimitClause(): string {
    let limitClause = '';
    if (this.limitValue !== undefined) {
      limitClause = `LIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== undefined) {
      limitClause += ` OFFSET ${this.offsetValue}`;
    }
    return limitClause;
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
      let targetSchema: TableSchema | undefined;
      if (this.schemaRegistry) {
        targetSchema = this.schemaRegistry.get(relConfig.targetTable);
      }
      if (!targetSchema) {
        targetSchema = getTargetSchemaForRelation(this.schema, relName, relConfig);
      }

      if (relConfig.type === 'many') {
        Object.defineProperty(mock, relName, {
          get: () => {
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              this.schema.name,
              targetSchema,
              this.schemaRegistry,
              undefined,
              relConfig.foreignKeys,  // Propagate composite FK / literal predicates
              relConfig.matches
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
              targetSchema,
              this.schemaRegistry,
              [],
              this.schema.name
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
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
    if (!condition) {
      return;
    }

    // Get all field references from the condition and collect table aliases
    const allTableAliases = new Set<string>();
    const fieldRefs = condition.getFieldRefs();

    const correlatedAliases = new Set<string>();

    for (const fieldRef of fieldRefs) {
      // A ref from another chain is a correlation to an enclosing query, which already has
      // that table in scope; resolving its alias against OUR relations would join a second
      // copy of it into this grouping. See isForeignChainRef.
      if (isForeignChainRef(fieldRef, this.chainId)) {
        if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
          correlatedAliases.add(fieldRef.__tableAlias as string);
        }
        continue;
      }

      // A navigation of the build's plan collects the aliases of its whole path
      if (this.collectPlannedAliases(fieldRef, allTableAliases)) {
        continue;
      }

      if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
        const tableAlias = fieldRef.__tableAlias as string;
        if (tableAlias && tableAlias !== this.schema.name) {
          allTableAliases.add(tableAlias);
        }
      }
    }

    // `.groupBy()` must not become a quiet bypass of the refusal the standalone path enforces.
    assertNoCorrelatedAliasShadowing(this.schema.name, correlatedAliases, allTableAliases);

    // Resolve all joins through the schema graph (handles multi-level)
    this.resolveJoinsForTableAliases(allTableAliases, joins);
  }

  /**
   * Detect navigation properties in a selection and add JOINs for them
   */
  private detectAndAddJoinsFromSelection(
    selection: any,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
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

    for (const [, value] of Object.entries(selection)) {
      // Correlations to an enclosing query are not ours to join — see isForeignChainRef.
      if (isForeignChainRef(value, this.chainId)) {
        continue;
      }

      if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
        // A navigation of the build's plan collects the aliases of its own path, in the same order
        if (this.collectPlannedAliases(value, allTableAliases)) {
          continue;
        }

        const tableAlias = value.__tableAlias as string;
        if (tableAlias && tableAlias !== this.schema.name) {
          allTableAliases.add(tableAlias);
        }
        // Also collect intermediate navigation aliases for multi-level navigation
        if ('__navigationAliases' in value && Array.isArray((value as any).__navigationAliases)) {
          for (const navAlias of (value as any).__navigationAliases) {
            if (navAlias && navAlias !== this.schema.name) {
              allTableAliases.add(navAlias);
            }
          }
        }
      } else if (value instanceof SqlFragment) {
        const fieldRefs = value.getFieldRefs();
        for (const fieldRef of fieldRefs) {
          // The top-level check above sees the FRAGMENT, which carries no chain id of its own,
          // so the refs INSIDE it have to be screened here or a correlation written as
          // sql`upper(${l.name})` slips through unguarded. Mirrors the same branch in
          // `SelectQueryBuilder.collectTableAliasesFromSelection`.
          if (isForeignChainRef(fieldRef, this.chainId)) {
            continue;
          }

          if (this.collectPlannedAliases(fieldRef, allTableAliases)) {
            continue;
          }

          if ('__tableAlias' in fieldRef && fieldRef.__tableAlias) {
            const tableAlias = fieldRef.__tableAlias as string;
            if (tableAlias && tableAlias !== this.schema.name) {
              allTableAliases.add(tableAlias);
            }
          }
          if ('__navigationAliases' in fieldRef && Array.isArray((fieldRef as any).__navigationAliases)) {
            for (const navAlias of (fieldRef as any).__navigationAliases) {
              if (navAlias && navAlias !== this.schema.name) {
                allTableAliases.add(navAlias);
              }
            }
          }
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof CollectionQueryBuilder)) {
        this.collectTableAliasesFromSelection(value, allTableAliases);
      }
    }
  }

  /**
   * Adds the aliases of the path `ref` navigates — its own first, then its ancestors' from the root
   * down, the order `__tableAlias` + `__navigationAliases` have always been collected in — when the
   * build's navigation plan knows the path. False for any other ref.
   */
  private collectPlannedAliases(ref: unknown, allTableAliases: Set<string>): boolean {
    const planned = this.navigationPlan?.nodeOf(ref);

    if (planned === undefined) {
      return false;
    }

    for (const alias of planned.collectOrder) {
      allTableAliases.add(alias);
    }

    return true;
  }

  /**
   * Resolve all navigation joins by finding the correct path through the schema graph.
   * Handles multi-level navigation like task.level.createdBy.
   */
  private resolveJoinsForTableAliases(
    allTableAliases: Set<string>,
    joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean; sourceAlias?: string }>
  ): void {
    if (allTableAliases.size === 0) {
      return;
    }

    const resolved = new Set<string>();
    let maxIterations = allTableAliases.size * 3;

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

        // A path of the build's navigation plan hangs off its OWN parent, once that is joined —
        // never off whichever joined table happens to have a relation of the same name
        const planned = this.navigationPlan?.nodeForAlias(alias);
        if (planned !== undefined) {
          if (planned.parent === undefined || joinedSchemas.has(planned.parent.alias)) {
            joins.push(this.navigationPlan!.joinOf(planned));
            resolved.add(alias);
          }
          continue;
        }

        // Look for this alias in any of the already joined schemas
        for (const [sourceAlias, schema] of joinedSchemas) {
          if (schema.relations && schema.relations[alias]) {
            const relation = schema.relations[alias];
            if (relation.type === 'one') {
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
}

/**
 * Query builder for grouped queries that have been joined
 * This handles the case where a GroupedSelectQueryBuilder is joined with a CTE or subquery
 */
/**
 * What one field of a grouped join's projection is: a column (of the grouped query or of the joined
 * side), an `sql` expression (a condition arrives as one, see selectorProjectingConditions; a
 * subquery renders as one), a literal, or `undefined` — left out, as a SELECT leaves it out. A
 * nested object or a collection has no column of the join to be read from.
 */
function joinedProjectionKind(value: unknown, key: string): 'column' | 'expression' | 'literal' | 'skip' {
  if (value === undefined) {
    return 'skip';
  }

  if (value === null || typeof value !== 'object') {
    return 'literal';
  }

  if ('__dbColumnName' in value) {
    return 'column';
  }

  if (value instanceof SqlFragment || value instanceof Subquery) {
    return 'expression';
  }

  const isCollection = value instanceof CollectionQueryBuilder || '__collectionResult' in value;

  if (isCollection || Object.getPrototypeOf(value) === Object.prototype) {
    throw new Error(
      `Grouped join projection field "${key}" is a ${isCollection ? 'collection' : 'nested object'}, which a grouped join `
      + 'cannot project — select columns, sql expressions or literals'
    );
  }

  // A value — a Date, an array of values, any class instance. A list of columns has no one value
  assertProjectionArrayOfValues(value, key, 'Grouped join select()');

  return 'literal';
}

/** The read mapper of a projected column or expression (its `mapWith` / column mapper), if any. */
function readMapperOf(value: any): { fromDriver(value: any): any } | undefined {
  let mapper = typeof value?.getMapper === 'function' ? value.getMapper() : value?.__mapper;

  if (mapper && typeof mapper.getType === 'function') {
    mapper = mapper.getType();
  }

  return mapper && typeof mapper.fromDriver === 'function' ? mapper : undefined;
}

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
  /** How the grouped query's own fields read back (see GroupedSelectQueryBuilder.buildFieldReaders), by field name. */
  private leftReaders: Map<string, (value: any) => any>;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ field: string; direction: OrderDirection; aliased?: boolean }> = [];
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
    cte?: DbCte<TRight>,
    leftReaders?: Map<string, (value: any) => any>
  ) {
    this.schema = schema;
    this.client = client;
    this.leftSubquery = leftSubquery;
    this.leftAlias = leftAlias;
    this.rightSource = rightSource;
    this.rightAlias = rightAlias;
    this.joinType = joinType;
    this.joinCondition = joinCondition;
    this.resultSelector = selectorProjectingConditions(resultSelector);
    this.createLeftMock = createLeftMock;
    this.createRightMock = createRightMock;
    this.executor = executor;
    this.cte = cte;
    this.leftReaders = leftReaders ?? new Map();
  }

  /**
   * Override the timeout for this single query (ms). Only this query is wrapped
   * (`SET LOCAL statement_timeout`). Overrides the connection-level default; pass
   * `0` to disable. On timeout a `QueryTimeoutError` is thrown.
   */
  withTimeout(timeoutMs: number): this {
    this.executor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return this;
  }

  /**
   * Mark this query as expected to finish within `expectedMs` (ms). If it runs
   * longer, the context's `onQueryTakingTooLong` callback fires (the query is
   * NOT cancelled). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
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
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockLeft = this.createLeftMock();
    const mockRight = this.createRightMock();
    const mockResult = this.resultSelector(mockLeft, mockRight);
    const result = selector(mockResult);
    // An aggregate or `sql` fragment of the projection orders by its output alias
    parseOrderBy(result, this.orderByFields, getQualifiedFieldName, undefined, projectedAliasOf(mockResult));
    return this;
  }

  /**
   * Execute query and return results
   */
  async toList(): Promise<ResolveFieldRefs<TSelection>[]> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      useJsonArrayAggregation: !this.client.supportsBinaryArrayResults(),
      paramCounter: 1,
      allParams: [],
    };

    const { sql, params } = this.buildQuery(context);

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return this.transformRows(result.rows);
  }

  /**
   * The joined rows read back field by field: a grouped field as the grouped query reads it (an
   * aggregate as a number, a MIN / MAX of a mapped column through the column's mapper), a joined
   * column or an `sql` expression through its mapper, a literal as itself. The rows used to be
   * returned as the driver delivered them — a count as a string, a mapped MIN as its storage value.
   */
  private transformRows(rows: any[]): any[] {
    const mockResult = this.resultSelector(this.createLeftMock(), this.createRightMock()) as Record<string, unknown>;
    const readers: Array<[string, (row: any) => any]> = [];

    for (const [key, value] of Object.entries(mockResult)) {
      const kind = joinedProjectionKind(value, key);

      if (kind === 'skip') {
        continue;
      }

      if (kind === 'literal') {
        // Read back as itself — it rides the statement as a parameter only for SQL reading the query
        readers.push([key, () => value]);
        continue;
      }

      if (kind === 'expression') {
        const mapper = readMapperOf(value);
        readers.push([key, row => (mapper ? mapper.fromDriver(row[key]) : row[key])]);
        continue;
      }

      // A column: one of the grouped query's fields, or of the joined side
      const ref = value as any;

      if (ref.__isAggregationArray) {
        // A withAggregation CTE's items, through the aggregated query's own mappers
        const itemReads = aggregatedItemReads(ref.__innerSelectionMetadata);
        readers.push([key, row => (itemReads && Array.isArray(row[key]) ? mapAggregatedItems(row[key], itemReads) : row[key])]);
        continue;
      }

      const readGrouped = ref.__tableAlias === this.leftAlias ? this.leftReaders.get(ref.__fieldName) : undefined;
      const mapper = readGrouped === undefined ? readMapperOf(ref) : undefined;

      readers.push([key, row => {
        const raw = row[key];

        if (readGrouped) {
          return readGrouped(raw);
        }

        return mapper && raw !== null && raw !== undefined ? mapper.fromDriver(raw) : raw;
      }]);
    }

    return rows.map(row => {
      const out: any = {};

      for (const [key, read] of readers) {
        out[key] = read(row);
      }

      return out;
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
   * Execute query and return first result or null (alias for first)
   */
  async firstOrDefault(): Promise<ResolveFieldRefs<TSelection> | null> {
    return this.first();
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
        useJsonArrayAggregation: outerContext.useJsonArrayAggregation ?? !this.client.supportsBinaryArrayResults(),
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
        // See SelectQueryBuilder.asSubquery — the statement-level CTE set must
        // survive the subquery boundary or anything nested re-declares it.
        hoistedCteNames: outerContext.hoistedCteNames,
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
      const kind = joinedProjectionKind(value, alias);

      if (kind === 'column') {
        const field = value as any;
        const tableAlias = field.__tableAlias;
        if (tableAlias) {
          selectParts.push(`"${tableAlias}"."${field.__dbColumnName}" as "${alias}"`);
        } else {
          selectParts.push(`"${field.__dbColumnName}" as "${alias}"`);
        }
      } else if (kind === 'expression') {
        const sqlBuildContext = {
          paramCounter: context.paramCounter,
          params: context.allParams,
        };
        // A subquery renders parenthesized, as the fragment interpolating it renders it
        const fragment = value instanceof SqlFragment ? value : new SqlFragment(['', ''], [value]);
        const fragmentSql = fragment.buildSql(sqlBuildContext);
        context.paramCounter = sqlBuildContext.paramCounter;
        selectParts.push(`${fragmentSql} as "${alias}"`);
      } else if (kind === 'literal') {
        // A literal is a parameter (NULL for null); it rendered as a column named like its key
        // ("column "kind" does not exist")
        if (value === null) {
          selectParts.push(`NULL as "${alias}"`);
        } else {
          selectParts.push(`$${context.paramCounter++} as "${alias}"`);
          context.allParams.push(value);
        }
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
        ({ field, direction, aliased }) => `${aliased ? `"${field}"` : field} ${direction}`
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
