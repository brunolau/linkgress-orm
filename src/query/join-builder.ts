import { Condition, ConditionBuilder, and as andCondition } from './conditions';
import { TableSchema } from '../schema/table-builder';
import type { DatabaseClient } from '../database/database-client.interface';
import type { QueryExecutor, OrderDirection } from '../entity/db-context';
import { parseOrderBy, getTableAlias } from './query-utils';

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
  private orderByFields: Array<{ table: string; field: string; direction: 'ASC' | 'DESC' }> = [];
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

    return result.rows;
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
    this.selection = selector;
  }

  /**
   * Create mock row for a table
   */
  private createMockRow(schema: TableSchema, alias: string): any {
    const mock: any = {};

    // Add columns as FieldRef objects
    for (const [colName, colBuilder] of Object.entries(schema.columns)) {
      const dbColumnName = (colBuilder as any).build().name;
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
            if (!targetSchema) {
              // Fallback proxy
              return new Proxy({}, {
                get: (target, prop) => ({
                  __fieldName: prop as string,
                  __dbColumnName: prop as string,
                  __tableAlias: `${alias}_${relName}`,
                })
              });
            }

            const nestedMock: any = {};
            for (const [nestedColName, nestedColBuilder] of Object.entries(targetSchema.columns)) {
              const nestedDbColumnName = (nestedColBuilder as any).build().name;
              Object.defineProperty(nestedMock, nestedColName, {
                get: () => ({
                  __fieldName: nestedColName,
                  __dbColumnName: nestedDbColumnName,
                  __tableAlias: `${alias}_${relName}`,
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
      } else if (typeof value === 'string') {
        // Simple column reference
        selectParts.push(`"${this.leftAlias}"."${value}" as "${key}"`);
      } else {
        // Literal value
        selectParts.push(`$${context.paramCounter++} as "${key}"`);
        context.allParams.push(value);
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
      const orderParts = this.orderByFields.map(
        ({ table, field, direction }) => `"${table}"."${field}" ${direction}`
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
