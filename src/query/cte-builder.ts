import { DatabaseClient } from '../database/database-client.interface';
import { QueryBuilder, SelectQueryBuilder } from './query-builder';
import { SqlBuildContext, FieldRef } from './conditions';

/**
 * Interface for queries that can be used in CTEs
 * Supports both SelectQueryBuilder and GroupedJoinedQueryBuilder
 */
interface CteCompatibleQuery<TSelection> {
  toList: () => Promise<TSelection[]>;
}

/**
 * Type helper to convert value types to FieldRefs for CTE column access
 */
type ToFieldRefs<T> = T extends object
  ? { [K in keyof T]: FieldRef<string, T[K]> }
  : FieldRef<string, T>;

/**
 * Type helper to extract the underlying value type from a FieldRef or keep as-is
 */
type ExtractValueType<T> = T extends FieldRef<any, infer V> ? V : T;

/**
 * Type helper to resolve FieldRefs in an object to their value types
 */
type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends object
  ? { [K in keyof T]: ResolveFieldRefs<T[K]> }
  : T;

/**
 * Represents a Common Table Expression (CTE) with strong typing
 */
export class DbCte<TColumns> {
  constructor(
    public readonly name: string,
    public readonly query: string,
    public readonly params: unknown[],
    public readonly columnDefs: TColumns,
    public readonly selectionMetadata?: Record<string, any>
  ) {}

  /**
   * Get a typed reference to a CTE column
   */
  getColumn<K extends keyof TColumns>(columnName: K): TColumns[K] {
    return columnName as TColumns[K];
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
  ): DbCte<TKey & { [K in TAlias]: Array<AggregatedItemType<TSelection, TKey>> }> {
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

    const cte = new DbCte(cteName, aggregationSql, context.params, columnDefs);
    this.ctes.push(cte);

    return cte;
  }

  /**
   * Build inner query SQL - handles different query builder types
   * - SelectQueryBuilder: uses createMockRow() and selector()
   * - GroupedSelectQueryBuilder: uses buildCteQuery()
   * - GroupedJoinedQueryBuilder: uses buildCteQuery()
   */
  private buildInnerQuerySql(query: any, context: SqlBuildContext): string {
    const queryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: context.paramCounter,
      allParams: context.params,
    };

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
 */
export type AggregatedItemType<
  TSelection extends Record<string, unknown>,
  TKey extends Record<string, unknown>
> = {
  [K in Exclude<keyof TSelection, keyof TKey>]: TSelection[K];
};

/**
 * Check if a value is a CTE
 */
export function isCte(value: any): value is DbCte<any> {
  return value instanceof DbCte;
}
