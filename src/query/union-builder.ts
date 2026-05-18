import { ConditionBuilder, SqlBuildContext, FieldRef, UnwrapSelection } from './conditions';
import type { QueryExecutor, OrderDirection } from '../entity/db-context';
import { parseOrderBy } from './query-utils';
import type { DatabaseClient } from '../database/database-client.interface';
import type { SelectQueryBuilder } from './query-builder';
import { Subquery } from './subquery';

/**
 * Union type: UNION removes duplicates, UNION ALL keeps all rows
 */
export type UnionType = 'UNION' | 'UNION ALL';

/**
 * Minimal contract a union component must satisfy. SelectQueryBuilder provides
 * the optional `_consumeUnionMetadata` and `_applyUnionPostProcessing` hooks
 * so the union can reconstruct nested-object projections and apply collection
 * mappers; non-SelectQueryBuilder components (rare; e.g. ad-hoc objects used
 * in tests) skip those steps.
 */
export interface UnionLegBuilder {
  buildUnionSql: (context: SqlBuildContext) => string;
  /** @internal */
  _consumeUnionMetadata?(): { nestedPaths: Set<string>; selectionResult: any } | undefined;
  /** @internal */
  _applyUnionPostProcessing?(rows: any[], meta: { nestedPaths: Set<string>; selectionResult: any }): any[];
}

/**
 * Represents a query component in a union chain
 */
interface UnionComponent {
  /** Function that builds the SQL for this query component */
  buildSql: (context: SqlBuildContext) => string;
  /** The union type to use before this query (not used for the first query) */
  unionType?: UnionType;
  /** Owner reference so post-fetch processing can call back into the builder. */
  ownerBuilder?: UnionLegBuilder;
}

/**
 * Builder for UNION and UNION ALL queries.
 * Combines multiple SELECT queries into a single result set.
 *
 * @example
 * ```typescript
 * // Basic UNION (removes duplicates)
 * const result = await db.users
 *   .select(u => ({ id: u.id, name: u.name }))
 *   .union(
 *     db.customers.select(c => ({ id: c.id, name: c.name }))
 *   )
 *   .toList();
 *
 * // UNION ALL (keeps duplicates)
 * const allRows = await db.activeUsers
 *   .select(u => ({ id: u.id }))
 *   .unionAll(
 *     db.inactiveUsers.select(u => ({ id: u.id }))
 *   )
 *   .toList();
 *
 * // Multiple unions with ordering
 * const sorted = await db.users
 *   .select(u => ({ id: u.id, name: u.name }))
 *   .union(db.customers.select(c => ({ id: c.id, name: c.name })))
 *   .unionAll(db.vendors.select(v => ({ id: v.id, name: v.name })))
 *   .orderBy(r => r.name)
 *   .limit(100)
 *   .toList();
 * ```
 */
export class UnionQueryBuilder<TSelection> {
  private components: UnionComponent[] = [];
  private orderByFields: Array<{ field: string; direction: 'ASC' | 'DESC' }> = [];
  private limitValue?: number;
  private offsetValue?: number;
  private client: DatabaseClient;
  private executor?: QueryExecutor;

  /**
   * Internal constructor - use SelectQueryBuilder.union() or unionAll() to create instances
   */
  constructor(
    firstQuery: UnionLegBuilder,
    client: DatabaseClient,
    executor?: QueryExecutor
  ) {
    this.client = client;
    this.executor = executor;
    this.components.push({
      buildSql: (ctx) => firstQuery.buildUnionSql(ctx),
      ownerBuilder: firstQuery,
    });
  }

  /**
   * Add a query with UNION (removes duplicate rows)
   *
   * @param query The query to union with the current result
   * @returns A new UnionQueryBuilder with the added query
   *
   * @example
   * ```typescript
   * const users = await db.activeUsers
   *   .select(u => ({ id: u.id, email: u.email }))
   *   .union(db.pendingUsers.select(u => ({ id: u.id, email: u.email })))
   *   .toList();
   * ```
   */
  union(query: UnionLegBuilder): UnionQueryBuilder<TSelection> {
    const newBuilder = this.clone();
    newBuilder.components.push({
      buildSql: (ctx) => query.buildUnionSql(ctx),
      unionType: 'UNION',
      ownerBuilder: query,
    });
    return newBuilder;
  }

  /**
   * Add a query with UNION ALL (keeps all rows including duplicates)
   *
   * @param query The query to union with the current result
   * @returns A new UnionQueryBuilder with the added query
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
  unionAll(query: UnionLegBuilder): UnionQueryBuilder<TSelection> {
    const newBuilder = this.clone();
    newBuilder.components.push({
      buildSql: (ctx) => query.buildUnionSql(ctx),
      unionType: 'UNION ALL',
      ownerBuilder: query,
    });
    return newBuilder;
  }

  /**
   * Order the combined result set
   *
   * @param selector Function that selects the field(s) to order by
   * @returns This builder for chaining
   *
   * @example
   * ```typescript
   * // Single field
   * .orderBy(r => r.name)
   *
   * // Multiple fields
   * .orderBy(r => [r.lastName, r.firstName])
   *
   * // With direction
   * .orderBy(r => [[r.createdAt, 'DESC'], [r.name, 'ASC']])
   * ```
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    // Create a mock row with field refs for the selection
    const mockRow = this.createMockRow();
    const result = selector(mockRow as TSelection);

    // Clear previous orderBy
    this.orderByFields = [];
    parseOrderBy(result, this.orderByFields);

    return this;
  }

  /**
   * Limit the number of results
   *
   * @param count Maximum number of rows to return
   * @returns This builder for chaining
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Skip a number of results
   *
   * @param count Number of rows to skip
   * @returns This builder for chaining
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Execute the union query and return results
   *
   * @returns Promise resolving to array of results
   */
  async toList(): Promise<TSelection[]> {
    // buildSql() walks every component which, for SelectQueryBuilder legs,
    // stashes nestedPaths + selectionResult on the builder via
    // _consumeUnionMetadata. We read it back AFTER buildSql finishes (and
    // before query execution — order doesn't actually matter, just consume
    // before another buildSql wipes it).
    const { sql, params } = this.buildSql();

    // First-leg metadata is canonical for post-processing because UNION
    // requires every leg to project the same column shape. If the first leg
    // has nestedPaths or a transformable selection (collections / mappers /
    // FieldRefs), apply the same reconstruction that SelectQueryBuilder.toList
    // would normally apply.
    let firstLegMeta: { nestedPaths: Set<string>; selectionResult: any } | undefined;
    let firstLegOwner: UnionLegBuilder | undefined;
    for (let i = 0; i < this.components.length; i++) {
      const c = this.components[i];
      if (c.ownerBuilder?._consumeUnionMetadata) {
        const meta = c.ownerBuilder._consumeUnionMetadata();
        if (i === 0) {
          firstLegMeta = meta;
          firstLegOwner = c.ownerBuilder;
        }
        // Non-first legs: just drain to avoid stale state on the builder.
      }
    }

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    // Apply post-processing through the FIRST leg's builder. This is correct
    // because:
    //   - Postgres's UNION semantics enforce column-shape equality across all
    //     legs (otherwise we'd get a SQL error before reaching here),
    //   - the result mapper only cares about the column SHAPE (names, types,
    //     nested-path encoding), which is identical across legs,
    //   - first-leg ownership is the natural pick (the union is initiated
    //     from `firstLeg.unionAll(...)`).
    if (firstLegOwner?._applyUnionPostProcessing && firstLegMeta) {
      return firstLegOwner._applyUnionPostProcessing(result.rows, firstLegMeta) as TSelection[];
    }

    return result.rows as TSelection[];
  }

  /**
   * Get the first result or null if no results
   *
   * @returns Promise resolving to first result or null
   */
  async firstOrDefault(): Promise<TSelection | null> {
    const originalLimit = this.limitValue;
    this.limitValue = 1;

    const results = await this.toList();

    this.limitValue = originalLimit;
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Count the total number of results
   *
   * @returns Promise resolving to the count
   */
  async count(): Promise<number> {
    const { sql: innerSql, params } = this.buildSql();

    const sql = `SELECT COUNT(*) as count FROM (${innerSql}) as union_count`;

    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return parseInt(result.rows[0]?.count || '0', 10);
  }

  /**
   * Build the SQL for this union query
   * @internal
   */
  buildSql(): { sql: string; params: any[] };
  /**
   * Build the SQL for this union query inside an outer context (e.g. when
   * this union is used as a subquery via {@link asSubquery}). Reuses the
   * outer context's `paramCounter` and `params` array so parameter indices
   * chain correctly across the whole composite statement.
   *
   * @internal
   */
  buildSql(outerContext: SqlBuildContext): string;
  buildSql(outerContext?: SqlBuildContext): { sql: string; params: any[] } | string {
    const isNested = outerContext !== undefined;
    const context: SqlBuildContext = isNested
      ? outerContext
      : {
          paramCounter: 1,
          params: [],
        };

    const sqlParts: string[] = [];

    for (let i = 0; i < this.components.length; i++) {
      const component = this.components[i];

      if (i > 0 && component.unionType) {
        sqlParts.push(component.unionType);
      }

      // Each component query should be wrapped in parentheses
      const componentSql = component.buildSql(context);
      sqlParts.push(`(${componentSql})`);
    }

    let sql = sqlParts.join('\n');

    // Add ORDER BY (applies to the entire union result)
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(({ field, direction }) => `"${field}" ${direction}`);
      sql += `\nORDER BY ${orderParts.join(', ')}`;
    }

    // Add LIMIT
    if (this.limitValue !== undefined) {
      sql += `\nLIMIT ${this.limitValue}`;
    }

    // Add OFFSET
    if (this.offsetValue !== undefined) {
      sql += `\nOFFSET ${this.offsetValue}`;
    }

    if (isNested) {
      return sql;
    }

    return { sql, params: context.params };
  }

  /**
   * Convert this union query to a subquery usable in WHERE, SELECT, JOIN, or
   * FROM clauses of an outer query. Mirrors {@link SelectQueryBuilder.asSubquery}
   * but composes a UNION ALL / UNION across multiple SELECT legs into a single
   * subquery expression.
   *
   * @template TMode - 'scalar' for a single value, 'array' for column list (use
   *   with `inSubquery(...)`), 'table' for full rows
   * @returns Subquery that can be passed to `inSubquery`, `exists`, etc.
   *
   * @example
   * ```typescript
   * // Filter outer query by the union of two id selections
   * const friendIds = db.userRelations
   *   .where(r => eq(r.parentId, userId))
   *   .select(r => r.slaveId)
   *   .unionAll(
   *     db.userRelations
   *       .where(r => eq(r.slaveId, userId))
   *       .select(r => r.parentId)
   *   )
   *   .asSubquery('array');
   *
   * const rows = await db.usersEshop
   *   .where(u => inSubquery(u.id, friendIds))
   *   .select(u => ({ id: u.id, name: u.name }))
   *   .toList();
   * ```
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<
    TMode extends 'scalar' ? TSelection : TMode extends 'array' ? TSelection[] : TSelection[],
    TMode
  > {
    const sqlBuilder = (outerContext: SqlBuildContext & { tableAlias?: string }): string => {
      // Reuse the outer context so $1, $2, ... numbering and the params array
      // chain across the whole composite statement.
      return this.buildSql(outerContext);
    };

    return new Subquery(sqlBuilder, mode) as any;
  }

  /**
   * Get the SQL string for debugging
   *
   * @returns The SQL that would be executed
   */
  toSql(): string {
    return this.buildSql().sql;
  }

  /**
   * Create a mock row for orderBy selector
   */
  private createMockRow(): any {
    // Create a proxy that returns FieldRef objects for any property access
    return new Proxy({}, {
      get: (_target, prop: string | symbol) => {
        if (typeof prop === 'symbol') return undefined;
        return {
          __fieldName: prop,
          __dbColumnName: prop,
        } as FieldRef;
      },
      has: () => true,
    });
  }

  /**
   * Clone this builder
   */
  private clone(): UnionQueryBuilder<TSelection> {
    const cloned = Object.create(UnionQueryBuilder.prototype) as UnionQueryBuilder<TSelection>;
    cloned.components = [...this.components];
    cloned.orderByFields = [...this.orderByFields];
    cloned.limitValue = this.limitValue;
    cloned.offsetValue = this.offsetValue;
    cloned.client = this.client;
    cloned.executor = this.executor;
    return cloned;
  }
}

/**
 * Check if a value is a UnionQueryBuilder
 */
export function isUnionQueryBuilder(value: any): value is UnionQueryBuilder<any> {
  return value instanceof UnionQueryBuilder;
}
