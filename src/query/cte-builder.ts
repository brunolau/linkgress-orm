import { DatabaseClient } from '../database/database-client.interface';
import { QueryBuilder, SelectQueryBuilder, ResolveCollectionResults } from './query-builder';
import { SqlBuildContext, FieldRef, UnwrapSelection, SqlFragment } from './conditions';

/**
 * Interface for queries that can be used in CTEs
 * Supports SelectQueryBuilder, EntitySelectQueryBuilder, GroupedJoinedQueryBuilder
 * The TSelection type is inferred from the query's type parameter
 */
interface CteCompatibleQuery<TSelection> {
  toList: () => Promise<ResolveCollectionResults<TSelection>[] | TSelection[]>;
}

/**
 * Type helper to detect if a type is a class instance (has prototype methods)
 * vs a plain data object. See conditions.ts for detailed explanation.
 * Excludes DbColumn and SqlFragment which have valueOf but are not value types.
 */
type IsClassInstance<T> = T extends { __isDbColumn: true }
  ? false  // Exclude DbColumn
  : T extends { mapWith: any; as: any; buildSql: any }  // SqlFragment-like
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
 * Type helper to convert value types to FieldRefs for CTE column access
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
type ToFieldRefs<T> = T extends object
  ? IsValueType<T> extends true
    ? FieldRef<string, T>  // Preserve class instances, wrap in FieldRef
    : { [K in keyof T]: FieldRef<string, T[K]> }
  : FieldRef<string, T>;

/**
 * Type helper to extract the underlying value type from a FieldRef or keep as-is
 */
type ExtractValueType<T> = T extends FieldRef<any, infer V> ? V : T;

/**
 * Type helper to resolve FieldRefs in an object to their value types
 * Preserves class instances (Date, Map, Set, Temporal, etc.) as-is
 */
type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends object
  ? IsValueType<T> extends true
    ? T  // Preserve class instances as-is
    : { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Represents a Common Table Expression (CTE) with strong typing
 */
export class DbCte<TColumns> {
  /**
   * Set of column names that contain aggregated JSONB arrays.
   * These columns need COALESCE(..., '[]'::jsonb) when used in LEFT JOINs.
   */
  public readonly aggregationColumns: Set<string>;

  constructor(
    public readonly name: string,
    public readonly query: string,
    public readonly params: unknown[],
    public readonly columnDefs: TColumns,
    public readonly selectionMetadata?: Record<string, any>,
    aggregationColumns?: string[]
  ) {
    this.aggregationColumns = new Set(aggregationColumns || []);
  }

  /**
   * Get a typed reference to a CTE column
   */
  getColumn<K extends keyof TColumns>(columnName: K): TColumns[K] {
    return columnName as TColumns[K];
  }

  /**
   * Check if a column is an aggregation column (JSONB array)
   */
  isAggregationColumn(columnName: string): boolean {
    return this.aggregationColumns.has(columnName);
  }
}

/**
 * Builder for creating Common Table Expressions (CTEs)
 */
export class DbCteBuilder {
  private ctes: DbCte<any>[] = [];
  private paramOffset: number = 1;

  constructor() {}

  /**
   * Create a regular CTE from a query
   *
   * @example
   * const activeUsersCte = cteBuilder.with(
   *   'active_users',
   *   db.users
   *     .where(u => lt(u.id, 100))
   *     .select(u => ({
   *       userId: u.id,
   *       createdAt: u.createdAt,
   *       postCount: u.posts.count()
   *     }))
   * );
   */
  with<TSelection extends Record<string, unknown>>(
    cteName: string,
    query: SelectQueryBuilder<TSelection> | { toList: () => Promise<TSelection[]> }
  ): { cte: DbCte<TSelection> } {
    const context: SqlBuildContext = {
      paramCounter: this.paramOffset,
      params: [],
    };

    // Build the CTE query and get selection metadata
    const mockRow = (query as any)._createMockRow();
    const selectionResult = (query as any).selector(mockRow);

    const sql = (query as any).buildQuery(selectionResult, {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: context.paramCounter,
      allParams: context.params,
    }).sql;

    // Update parameter offset for next CTE
    this.paramOffset = context.paramCounter;

    // Create column definitions from the selection
    const columnDefs = {} as TSelection;

    const cte = new DbCte<TSelection>(cteName, sql, context.params, columnDefs, selectionResult);
    this.ctes.push(cte);

    return { cte };
  }

  /**
   * Create an aggregation CTE that groups results into a JSONB array
   *
   * @example
   * const aggregatedCte = cteBuilder.withAggregation(
   *   'aggregated_users',
   *   db.userAddress.select(ua => ({
   *     id: ua.id,
   *     userId: ua.userId,
   *     street: ua.address
   *   })),
   *   ua => ({ userId: ua.userId }),
   *   'items'
   * );
   */
  withAggregation<
    TSelection extends Record<string, unknown>,
    TKey extends Record<string, unknown>,
    TAlias extends string = 'items'
  >(
    cteName: string,
    query: SelectQueryBuilder<TSelection> | CteCompatibleQuery<TSelection>,
    keySelector: (value: TSelection) => TKey,
    aggregationAlias?: TAlias
  ): DbCte<UnwrapSelection<TKey> & { [K in TAlias]: Array<AggregatedItemType<TSelection, TKey>> }> {
    const context: SqlBuildContext = {
      paramCounter: this.paramOffset,
      params: [],
    };

    // Build the inner query - handle different query builder types
    // Also extract selection metadata for mapper preservation
    const { sql: innerSql, selectionMetadata: innerSelectionMetadata } = this.buildInnerQuerySqlWithMetadata(query, context);

    // Get group by columns - the keySelector maps output alias -> inner column name
    // e.g., p => ({ advancePriceId: p.userId }) means alias "advancePriceId" from inner column "userId"
    const mockItem = this.createMockItem();
    const groupByResult = keySelector(mockItem);
    const groupByEntries = Object.entries(groupByResult);

    // Build SELECT and GROUP BY with proper aliasing
    // SELECT "innerColumn" AS "outputAlias", ... GROUP BY "innerColumn"
    const selectColumns = groupByEntries
      .map(([outputAlias, innerColumn]) => {
        const innerCol = String(innerColumn);
        // If the alias differs from the inner column name, add AS clause
        if (outputAlias !== innerCol) {
          return `"${innerCol}" AS "${outputAlias}"`;
        }
        return `"${innerCol}"`;
      })
      .join(', ');
    const groupByClause = groupByEntries.map(([, innerColumn]) => `"${String(innerColumn)}"`).join(', ');

    // Use provided alias or default to 'items'
    const finalAggregationAlias = (aggregationAlias || 'items') as TAlias;

    // Build json_build_object with explicit columns for better performance
    // This is more efficient than to_jsonb(t.*) which includes all columns
    const groupByColumnSet = new Set(groupByEntries.map(([, innerColumn]) => String(innerColumn)));

    // Get all column names from inner selection metadata, excluding groupBy columns
    const aggregatedColumns: string[] = [];
    if (innerSelectionMetadata) {
      for (const key of Object.keys(innerSelectionMetadata)) {
        if (!groupByColumnSet.has(key)) {
          aggregatedColumns.push(key);
        }
      }
    }

    // Build the aggregation expression
    // Use JSON instead of JSONB for better aggregation performance
    // JSON is faster because it doesn't parse/validate the structure during aggregation
    // The result is functionally equivalent for read operations
    let aggregationExpression: string;
    if (aggregatedColumns.length > 0) {
      // Use json_build_object for better performance - only include non-groupBy columns
      const jsonParts = aggregatedColumns.map(col => `'${col}', "${col}"`).join(', ');
      aggregationExpression = `json_agg(json_build_object(${jsonParts}))`;
    } else {
      // Fallback to to_json(t.*) if we can't determine columns
      aggregationExpression = `json_agg(to_json(t.*))`;
    }

    const aggregationSql = `
      SELECT ${selectColumns},
             ${aggregationExpression} as "${finalAggregationAlias}"
      FROM (${innerSql}) t
      GROUP BY ${groupByClause}
    `.trim();

    // Update parameter offset
    this.paramOffset = context.paramCounter;

    // Create column definitions using output alias names
    const columnDefs: any = {};
    groupByEntries.forEach(([outputAlias]) => {
      columnDefs[outputAlias] = outputAlias;
    });
    columnDefs[finalAggregationAlias] = finalAggregationAlias;

    // Store inner selection metadata for mapper preservation during result transformation
    // The aggregation column contains items that need mappers applied
    const selectionMetadata: Record<string, any> = {};
    groupByEntries.forEach(([outputAlias, innerColumn]) => {
      const innerCol = String(innerColumn);
      // Check if inner selection metadata has mapper info for this column
      if (innerSelectionMetadata && innerCol in innerSelectionMetadata) {
        const innerValue = innerSelectionMetadata[innerCol];
        // If inner value has getMapper, preserve it
        if (typeof innerValue === 'object' && innerValue !== null && typeof innerValue.getMapper === 'function') {
          selectionMetadata[outputAlias] = {
            __fieldName: outputAlias,
            __dbColumnName: outputAlias,
            getMapper: innerValue.getMapper,
          };
        } else if (innerValue instanceof SqlFragment) {
          // SqlFragment with mapper
          const mapper = innerValue.getMapper();
          if (mapper) {
            selectionMetadata[outputAlias] = {
              __fieldName: outputAlias,
              __dbColumnName: outputAlias,
              getMapper: () => mapper,
            };
          } else {
            selectionMetadata[outputAlias] = outputAlias;
          }
        } else {
          selectionMetadata[outputAlias] = outputAlias;
        }
      } else {
        selectionMetadata[outputAlias] = outputAlias;
      }
    });
    // Store inner selection metadata under the aggregation alias so mappers can be applied to items
    selectionMetadata[finalAggregationAlias] = {
      __isAggregationArray: true,
      __innerSelectionMetadata: innerSelectionMetadata,
    };

    // Pass the aggregation alias as an aggregation column so it can be COALESCE'd in LEFT JOINs
    const cte = new DbCte(cteName, aggregationSql, context.params, columnDefs, selectionMetadata, [finalAggregationAlias]);
    this.ctes.push(cte);

    return cte;
  }

  /**
   * Build inner query SQL with metadata - handles different query builder types
   * Returns both the SQL and the selection metadata for mapper preservation
   */
  private buildInnerQuerySqlWithMetadata(query: any, context: SqlBuildContext): { sql: string; selectionMetadata: Record<string, any> | undefined } {
    const queryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: context.paramCounter,
      allParams: context.params,
    };

    // Extract referenced CTEs from the query and add them to this builder
    if (typeof query.getReferencedCtes === 'function') {
      const referencedCtes = query.getReferencedCtes() as DbCte<any>[];
      for (const cte of referencedCtes) {
        if (!this.ctes.some(existing => existing.name === cte.name)) {
          this.ctes.push(cte);
        }
      }
    }

    let sql: string;
    let selectionMetadata: Record<string, any> | undefined;

    // Check for grouped query builders that have buildCteQuery method
    if (typeof query.buildCteQuery === 'function') {
      const result = query.buildCteQuery(queryContext);
      context.paramCounter = queryContext.paramCounter;
      sql = result.sql;

      // Try to extract selection metadata from grouped query
      if (typeof query.getSelectionMetadata === 'function') {
        selectionMetadata = query.getSelectionMetadata();
      }
    }
    // Standard SelectQueryBuilder - uses _createMockRow and selector
    else if (typeof query._createMockRow === 'function' && typeof query.selector === 'function') {
      const mockRow = query._createMockRow();
      const selectionResult = query.selector(mockRow);
      const result = query.buildQuery(selectionResult, queryContext);
      context.paramCounter = queryContext.paramCounter;
      sql = result.sql;
      selectionMetadata = selectionResult;
    } else {
      throw new Error('Unsupported query type for CTE. Query must be a SelectQueryBuilder, GroupedSelectQueryBuilder, or GroupedJoinedQueryBuilder.');
    }

    return { sql, selectionMetadata };
  }

  /**
   * Build inner query SQL - handles different query builder types
   * - SelectQueryBuilder: uses _createMockRow() and selector()
   * - GroupedSelectQueryBuilder: uses buildCteQuery()
   * - GroupedJoinedQueryBuilder: uses buildCteQuery()
   *
   * This also extracts any CTEs referenced by the inner query and adds them to this builder
   * to avoid duplicate CTE definitions in nested queries.
   */
  private buildInnerQuerySql(query: any, context: SqlBuildContext): string {
    const queryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: context.paramCounter,
      allParams: context.params,
    };

    // Extract referenced CTEs from the query and add them to this builder
    // This ensures CTEs are defined at the outermost level, not nested
    if (typeof query.getReferencedCtes === 'function') {
      const referencedCtes = query.getReferencedCtes() as DbCte<any>[];
      for (const cte of referencedCtes) {
        // Only add if not already present (avoid duplicates)
        if (!this.ctes.some(existing => existing.name === cte.name)) {
          this.ctes.push(cte);
        }
      }
    }

    // Check for grouped query builders that have buildCteQuery method
    if (typeof query.buildCteQuery === 'function') {
      const result = query.buildCteQuery(queryContext);
      context.paramCounter = queryContext.paramCounter;
      return result.sql;
    }

    // Standard SelectQueryBuilder - uses _createMockRow and selector
    if (typeof query._createMockRow === 'function' && typeof query.selector === 'function') {
      const mockRow = query._createMockRow();
      const selectionResult = query.selector(mockRow);
      const result = query.buildQuery(selectionResult, queryContext);
      context.paramCounter = queryContext.paramCounter;
      return result.sql;
    }

    throw new Error('Unsupported query type for CTE. Query must be a SelectQueryBuilder, GroupedSelectQueryBuilder, or GroupedJoinedQueryBuilder.');
  }

  /**
   * Get all CTEs created by this builder
   */
  getCtes(): DbCte<any>[] {
    return this.ctes;
  }

  /**
   * Clear all CTEs from this builder
   */
  clear(): void {
    this.ctes = [];
    this.paramOffset = 1;
  }

  /**
   * Infer column types from query selection
   */
  private inferColumnTypes(query: any): Record<string, any> {
    // Try to extract selection from query
    if (query.selection) {
      return query.selection;
    }
    return {};
  }

  /**
   * Create a mock item for extracting group by columns
   */
  private createMockItem(): any {
    return new Proxy({}, {
      get: (target, prop) => {
        if (typeof prop === 'string') {
          return prop;
        }
        return undefined;
      }
    });
  }
}

/**
 * Type helper to extract CTE column types
 */
export type InferCteColumns<T> = T extends DbCte<infer TColumns> ? TColumns : never;

/**
 * Type helper for aggregated items - removes the grouping keys from the selection
 * and unwraps DbColumn/SqlFragment types to their underlying values
 */
export type AggregatedItemType<
  TSelection extends Record<string, unknown>,
  TKey extends Record<string, unknown>
> = {
  [K in Exclude<keyof TSelection, keyof TKey>]: UnwrapSelection<TSelection[K]>;
};

/**
 * Check if a value is a CTE
 */
export function isCte(value: any): value is DbCte<any> {
  return value instanceof DbCte;
}
