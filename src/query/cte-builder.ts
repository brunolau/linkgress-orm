import { DatabaseClient } from '../database/database-client.interface';
import { QueryBuilder, SelectQueryBuilder, ResolveCollectionResults } from './query-builder';
import { SqlBuildContext, FieldRef, UnwrapSelection } from './conditions';

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
    const mockRow = (query as any).createMockRow();
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
    const innerSql = this.buildInnerQuerySql(query, context);

    // Get group by columns
    const mockItem = this.createMockItem();
    const groupByResult = keySelector(mockItem);
    const groupByColumns = Object.keys(groupByResult);

    // Build the aggregation query
    const selectColumns = groupByColumns.map(col => `"${col}"`).join(', ');
    const groupByClause = groupByColumns.map(col => `"${col}"`).join(', ');

    // Use provided alias or default to 'items'
    const finalAggregationAlias = (aggregationAlias || 'items') as TAlias;

    // For aggregation CTEs, we need to exclude the grouping columns from the aggregated items
    // This implements AggregatedItemType<TSelection, TKey> at the SQL level
    // However, getting all column names requires introspection we don't have access to here
    // So we'll use jsonb_agg with to_jsonb which includes all columns
    // The type system will indicate which fields should be excluded

    const aggregationSql = `
      SELECT ${selectColumns},
             jsonb_agg(to_jsonb(t.*)) as "${finalAggregationAlias}"
      FROM (${innerSql}) t
      GROUP BY ${groupByClause}
    `.trim();

    // Update parameter offset
    this.paramOffset = context.paramCounter;

    // Create column definitions
    const columnDefs: any = {};
    groupByColumns.forEach(col => {
      columnDefs[col] = col;
    });
    columnDefs[finalAggregationAlias] = finalAggregationAlias;

    // Pass the aggregation alias as an aggregation column so it can be COALESCE'd in LEFT JOINs
    const cte = new DbCte(cteName, aggregationSql, context.params, columnDefs, undefined, [finalAggregationAlias]);
    this.ctes.push(cte);

    return cte;
  }

  /**
   * Build inner query SQL - handles different query builder types
   * - SelectQueryBuilder: uses createMockRow() and selector()
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

    // Standard SelectQueryBuilder - uses createMockRow and selector
    if (typeof query.createMockRow === 'function' && typeof query.selector === 'function') {
      const mockRow = query.createMockRow();
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
