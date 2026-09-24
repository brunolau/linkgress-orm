import { Condition, ConditionBuilder, and as andCondition } from './conditions';
import { TableSchema } from '../schema/table-builder';
import type { DatabaseClient } from '../database/database-client.interface';
import type { OrderDirection } from '../entity/db-context';
import { QueryExecutor } from '../entity/db-context';
import { parseOrderBy, getTableAlias } from './query-utils';
import { createNestedFieldRefProxy, getColumnNameMapForSchema, holdsSqlValue, projectionLiteralSql } from './query-builder';
import { selectorProjectingConditions } from './sql-functions';

/**
 * Whether a projected value of a join is a value rather than a column or an expression: a literal,
 * a Date, or a list / plain object of values — each reads back as itself.
 */
function isJoinProjectionValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return true;
  }

  const proto = Object.getPrototypeOf(value);

  return (Array.isArray(value) || proto === Object.prototype || proto === null)
    && !('__dbColumnName' in value)
    && !holdsSqlValue(value);
}

/**
 * Join type
 */
export type JoinType = 'INNER' | 'LEFT';

/**
 * Join definition
 */
export interface JoinDefinition {
  type: JoinType;
  table: string;
  alias: string;
  schema: TableSchema;
  condition: Condition;
}

/**
 * Query context for join queries
 */
export interface JoinQueryContext {
  paramCounter: number;
  allParams: any[];
}

/**
 * Join query builder with strong typing for joined tables
 */
export class JoinQueryBuilder<TLeft, TRight> {
  private joins: JoinDefinition[] = [];
  private selection?: (left: TLeft, right: TRight) => any;
  private whereCond?: Condition;
  private limitValue?: number;
  private offsetValue?: number;
  private orderByFields: Array<{ table: string; field: string; direction: OrderDirection }> = [];
  private executor?: QueryExecutor;

  constructor(
    private leftSchema: TableSchema,
    private leftAlias: string,
    private rightSchema: TableSchema,
    private rightAlias: string,
    private joinType: JoinType,
    private joinCondition: Condition,
    private client: DatabaseClient,
    executor?: QueryExecutor
  ) {
    this.executor = executor;

    // Store the first join
    this.joins.push({
      type: joinType,
      table: rightSchema.name,
      alias: rightAlias,
      schema: rightSchema,
      condition: joinCondition,
    });
  }

  /**
   * Override the timeout for this join query (ms). Only this query is wrapped
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
   * Mark this join query as expected to finish within `expectedMs` (ms). If it
   * runs longer, the context's `onQueryTakingTooLong` callback fires (the query
   * is NOT cancelled). Overrides the context's `longRunningQueryThreshold`.
   */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return this;
  }

  /**
   * Run THIS join query as a named prepared statement (`true`) or unnamed (`false`),
   * overriding the context's `preparedStatements` default. See
   * `QueryBuilder.withPreparedStatements`.
   */
  withPreparedStatements(prepare: boolean): this {
    this.executor = this.executor
      ? this.executor.withPreparedStatements(prepare)
      : new QueryExecutor(this.client, undefined, undefined, undefined, prepare);
    return this;
  }

  /**
   * Add another left join
   */
  leftJoin<TThird>(
    rightTable: { _schema: TableSchema; _alias: string },
    condition: (left: TLeft, right: TRight, third: TThird) => Condition,
    selector: (left: TLeft, right: TRight, third: TThird) => any
  ): any {
    // This would require extending the type parameters dynamically
    // For now, we'll support chaining up to 2 joins
    throw new Error('Additional joins not yet implemented. Use the final selector after the first join.');
  }

  /**
   * Add another inner join
   */
  innerJoin<TThird>(
    rightTable: { _schema: TableSchema; _alias: string },
    condition: (left: TLeft, right: TRight, third: TThird) => Condition,
    selector: (left: TLeft, right: TRight, third: TThird) => any
  ): any {
    throw new Error('Additional joins not yet implemented. Use the final selector after the first join.');
  }

  /**
   * Add WHERE condition
   * Multiple where() calls are chained with AND logic
   */
  where(condition: (left: TLeft, right: TRight) => Condition): this {
    const mockLeft = this.createMockRow(this.leftSchema, this.leftAlias);
    const mockRight = this.createMockRow(this.rightSchema, this.rightAlias);
    const newCondition = condition(mockLeft, mockRight);
    if (this.whereCond) {
      this.whereCond = andCondition(this.whereCond, newCondition);
    } else {
      this.whereCond = newCondition;
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
   * Order by field(s) from joined tables
   * @example
   * .orderBy((l, r) => l.colName)
   * .orderBy((l, r) => [l.colName, r.otherCol])
   * .orderBy((l, r) => [[l.colName, 'ASC'], [r.otherCol, 'DESC']])
   */
  orderBy<T>(selector: (left: TLeft, right: TRight) => T): this;
  orderBy<T>(selector: (left: TLeft, right: TRight) => T[]): this;
  orderBy<T>(selector: (left: TLeft, right: TRight) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (left: TLeft, right: TRight) => T | T[] | Array<[T, OrderDirection]>): this {
    const mockLeft = this.createMockRow(this.leftSchema, this.leftAlias);
    const mockRight = this.createMockRow(this.rightSchema, this.rightAlias);
    const result = selector(mockLeft, mockRight);
    const defaultAlias = this.leftAlias;
    parseOrderBy(
      result,
      this.orderByFields,
      undefined,
      (fieldRef) => getTableAlias(fieldRef) || defaultAlias
    );
    return this;
  }

  /**
   * Execute query and return results
   */
  async toList(): Promise<any[]> {
    if (!this.selection) {
      throw new Error('Selection is required. Call the join method with a selector.');
    }

    const context: JoinQueryContext = {
      paramCounter: 1,
      allParams: [],
    };

    // Build the query
    const { sql, params } = this.buildQuery(context);

    // Execute using executor if available (for logging), otherwise use client directly
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return this.readRows(result.rows);
  }

  /**
   * The rows read back field by field: a column of either table through its column's mapper, a
   * literal as itself (it rides the statement as a parameter the database hands back as text). The
   * rows used to be returned as the driver delivered them.
   */
  private readRows(rows: any[]): any[] {
    const selection = this.selection!(
      this.createMockRow(this.leftSchema, this.leftAlias),
      this.createMockRow(this.rightSchema, this.rightAlias)
    );
    const readers: Array<[string, (row: any) => any]> = [];

    for (const [key, value] of Object.entries(selection)) {
      if (value === undefined) {
        continue;
      }

      if (isJoinProjectionValue(value)) {
        readers.push([key, () => value]);
        continue;
      }

      const ref = value as any;
      const schema = ref.__tableAlias === this.rightAlias ? this.rightSchema : ref.__tableAlias === this.leftAlias ? this.leftSchema : undefined;
      const column = schema && typeof ref.__fieldName === 'string' ? schema.columns[ref.__fieldName] : undefined;
      let mapper = column ? (column as any).build().mapper : undefined;

      if (!mapper && typeof ref.getMapper === 'function') {
        mapper = ref.getMapper();
      }

      readers.push([key, mapper && typeof mapper.fromDriver === 'function'
        ? row => mapper.fromDriver(row[key])
        : row => row[key]]);
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
  async first(): Promise<any | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return first result or throw
   */
  async firstOrThrow(): Promise<any> {
    const result = await this.first();
    if (!result) {
      throw new Error('No results found');
    }
    return result;
  }

  /**
   * Set the selection (called internally)
   */
  _setSelection(selector: (left: TLeft, right: TRight) => any): void {
    this.selection = selectorProjectingConditions(selector);
  }

  /**
   * Create mock row for a table
   */
  private createMockRow(schema: TableSchema, alias: string): any {
    const mock: any = {};

    // Add columns as FieldRef objects - use pre-computed column name map if available
    const columnNameMap = getColumnNameMapForSchema(schema);
    for (const [colName, dbColumnName] of columnNameMap) {
      Object.defineProperty(mock, colName, {
        get: () => ({
          __fieldName: colName,
          __dbColumnName: dbColumnName,
          __tableAlias: alias,
        }),
        enumerable: true,
        configurable: true,
      });
    }

    // Add navigation properties for nested joins
    for (const [relName, relConfig] of Object.entries(schema.relations)) {
      if (relConfig.type === 'one') {
        Object.defineProperty(mock, relName, {
          get: () => {
            const targetSchema = relConfig.targetTableBuilder?.build();
            const nestedAlias = `${alias}_${relName}`;
            if (!targetSchema) {
              // Fallback: use the shared nested proxy that supports deep property access
              return createNestedFieldRefProxy(nestedAlias);
            }

            const nestedMock: any = {};
            const nestedColumnNameMap = getColumnNameMapForSchema(targetSchema);
            for (const [nestedColName, nestedDbColumnName] of nestedColumnNameMap) {
              Object.defineProperty(nestedMock, nestedColName, {
                get: () => ({
                  __fieldName: nestedColName,
                  __dbColumnName: nestedDbColumnName,
                  __tableAlias: nestedAlias,
                  __navigationPath: [alias, relName],
                }),
                enumerable: true,
                configurable: true,
              });
            }
            return nestedMock;
          },
          enumerable: true,
          configurable: true,
        });
      }
    }

    return mock;
  }

  /**
   * Build SQL query for the join
   */
  private buildQuery(context: JoinQueryContext): { sql: string; params: any[] } {
    if (!this.selection) {
      throw new Error('Selection is required');
    }

    const selectParts: string[] = [];

    // Analyze the selection
    const mockLeft = this.createMockRow(this.leftSchema, this.leftAlias);
    const mockRight = this.createMockRow(this.rightSchema, this.rightAlias);
    const selectedFields = this.selection(mockLeft, mockRight);

    // Process selection
    for (const [key, value] of Object.entries(selectedFields)) {
      if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
        // FieldRef object
        const tableAlias = (value as any).__tableAlias || this.leftAlias;
        selectParts.push(`"${tableAlias}"."${value.__dbColumnName}" as "${key}"`);
      } else if (value === undefined) {
        // Left out, as a SELECT leaves it out
        continue;
      } else if (value !== null && typeof value === 'object' && typeof (value as any).buildSql === 'function') {
        // An `sql` expression (a condition arrives as one, see selectorProjectingConditions)
        const buildContext = { paramCounter: context.paramCounter, params: context.allParams };
        const expressionSql = (value as any).buildSql(buildContext);
        context.paramCounter = buildContext.paramCounter;
        selectParts.push(`${expressionSql} as "${key}"`);
      } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        // A list or an object of values reads back as itself (see readRows) and needs no column; one
        // holding columns has no one SQL value — it used to be bound as ONE parameter, the column
        // refs serialized into it, and read back as that text
        if (holdsSqlValue(value)) {
          throw new Error(
            `JoinQueryBuilder select(): "${key}" is ${Array.isArray(value) ? 'an array' : 'an object'} of columns or expressions, `
            + 'which a join cannot project — select each column as a field of its own'
          );
        }
      } else {
        // Literal value
        const literalContext = { paramCounter: context.paramCounter, allParams: context.allParams };
        const literalSql = projectionLiteralSql(value, literalContext);
        context.paramCounter = literalContext.paramCounter;
        selectParts.push(`${literalSql} as "${key}"`);
      }
    }

    // Build FROM clause
    let fromClause = `FROM "${this.leftSchema.name}" AS "${this.leftAlias}"`;

    // Add JOINs
    for (const join of this.joins) {
      const joinType = join.type === 'INNER' ? 'INNER JOIN' : 'LEFT JOIN';

      // Build ON condition
      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams } = condBuilder.build(join.condition, context.paramCounter);
      context.paramCounter += condParams.length;
      context.allParams.push(...condParams);

      fromClause += `\n${joinType} "${join.table}" AS "${join.alias}" ON ${condSql}`;
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

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      // Build column name maps for all tables involved
      const leftColNameMap = getColumnNameMapForSchema(this.leftSchema);
      const colNameMaps: Record<string, Map<string, string>> = {
        [this.leftAlias]: leftColNameMap,
      };
      for (const join of this.joins) {
        colNameMaps[join.alias] = getColumnNameMapForSchema(join.schema);
      }
      const orderParts = this.orderByFields.map(
        ({ table, field, direction }) => {
          const colMap = colNameMaps[table];
          const dbColumnName = colMap?.get(field) ?? field;
          return `"${table}"."${dbColumnName}" ${direction}`;
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

    const finalQuery = `SELECT ${selectParts.join(', ')}\n${fromClause}\n${whereClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
    };
  }
}
