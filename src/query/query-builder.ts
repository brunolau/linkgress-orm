import { Condition, ConditionBuilder, SqlFragment, SqlBuildContext, FieldRef } from './conditions';
import { TableSchema } from '../schema/table-builder';
import type { QueryExecutor, CollectionStrategyType } from '../entity/db-context';
import type { DatabaseClient, QueryResult } from '../database/database-client.interface';
import { Subquery } from './subquery';
import { GroupedQueryBuilder } from './grouped-query';
import { DbCte, isCte } from './cte-builder';
import { CollectionStrategyFactory } from './collection-strategy.factory';
import type { CollectionAggregationConfig } from './collection-strategy.interface';

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

  // Performance: Cache the mock row to avoid recreating it
  private _cachedMockRow?: any;

  constructor(schema: TSchema, client: DatabaseClient, whereCond?: Condition, limit?: number, offset?: number, orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC' }>, executor?: QueryExecutor, manualJoins?: ManualJoinDefinition[], joinCounter?: number, collectionStrategy?: CollectionStrategyType) {
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
  }

  /**
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(tableName: string, schema?: string): string {
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  /**
   * Define the selection with support for nested queries
   */
  select<TSelection>(selector: (row: TRow) => TSelection): SelectQueryBuilder<TSelection> {
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
      undefined,  // schemaRegistry
      [],  // ctes - start with empty array
      this.collectionStrategy
    );
  }

  /**
   * Add WHERE condition
   */
  where(condition: (row: TRow) => Condition): this {
    const mockRow = this.createMockRow();
    this.whereCond = condition(mockRow);
    return this;
  }

  /**
   * Create mock row for analysis
   */
  private createMockRow(): any {
    // Performance: Return cached mock if available
    if (this._cachedMockRow) {
      return this._cachedMockRow;
    }

    const mock: any = {};

    // Performance: Build column configs once and cache them
    const columnEntries = Object.entries(this.schema.columns);
    const columnConfigs = new Map<string, string>();

    for (const [colName, colBuilder] of columnEntries) {
      columnConfigs.set(colName, (colBuilder as any).build().name);
    }

    // Add columns as FieldRef objects - type-safe with property name and database column name
    for (const [colName, dbColumnName] of columnConfigs) {
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

    // Performance: Cache target schemas for relations to avoid repeated .build() calls
    const relationSchemas = new Map<string, TableSchema | undefined>();
    for (const [relName, relConfig] of Object.entries(this.schema.relations)) {
      if (relConfig.targetTableBuilder) {
        relationSchemas.set(relName, relConfig.targetTableBuilder.build());
      }
    }

    // Add relations (both collections and single references)
    for (const [relName, relConfig] of Object.entries(this.schema.relations)) {
      if (relConfig.type === 'many') {
        const targetSchema = relationSchemas.get(relName);
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
        // Single reference navigation (many-to-one, one-to-one)
        const targetSchema = relationSchemas.get(relName);
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

    // Cache the mock for reuse
    this._cachedMockRow = mock;
    return mock;
  }

  /**
   * Add a LEFT JOIN to the query with a selector (supports both tables and subqueries)
   */
  leftJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<TSelection> {
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
    const mockLeft = this.createMockRow();
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
    const createLeftMock = () => this.createMockRow();
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
    );
  }

  /**
   * Add an INNER JOIN to the query with a selector (supports both tables and subqueries)
   */
  innerJoin<TRight, TSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'>,
    condition: (left: TRow, right: TRight) => Condition,
    selector: (left: TRow, right: TRight) => TSelection,
    alias?: string
  ): SelectQueryBuilder<TSelection> {
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
    const mockLeft = this.createMockRow();
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
    const createLeftMock = () => this.createMockRow();
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
    );
  }

  /**
   * Create mock row for a specific table/alias (for joins)
   */
  private createMockRowForTable(schema: TableSchema, alias: string): any {
    const mock: any = {};

    // Performance: Build column configs once and cache them
    const columnEntries = Object.entries(schema.columns);
    const columnConfigs = new Map<string, string>();

    for (const [colName, colBuilder] of columnEntries) {
      columnConfigs.set(colName, (colBuilder as any).build().name);
    }

    // Add columns as FieldRef objects with table alias
    for (const [colName, dbColumnName] of columnConfigs) {
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

    // Performance: Cache target schemas for relations
    const relationSchemas = new Map<string, TableSchema | undefined>();
    for (const [relName, relConfig] of Object.entries(schema.relations)) {
      if (relConfig.targetTableBuilder) {
        relationSchemas.set(relName, relConfig.targetTableBuilder.build());
      }
    }

    // Add navigation properties (single references and collections)
    for (const [relName, relConfig] of Object.entries(schema.relations)) {
      if (relConfig.type === 'many') {
        // Collection navigation
        const targetSchema = relationSchemas.get(relName);
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
          enumerable: true,
          configurable: true,
        });
      } else {
        // Single reference navigation
        const targetSchema = relationSchemas.get(relName);
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
  orderBy(selector: (row: TRow) => any): this;
  orderBy(selector: (row: TRow) => any[]): this;
  orderBy(selector: (row: TRow) => Array<[any, 'ASC' | 'DESC']>): this;
  orderBy(selector: (row: TRow) => any | any[] | Array<[any, 'ASC' | 'DESC']>): this {
    const mockRow = this.createMockRow();
    const result = selector(mockRow);

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
   */
  select<TNewSelection>(selector: (row: TSelection) => TNewSelection): SelectQueryBuilder<TNewSelection> {
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
    );
  }

  /**
   * Add WHERE condition
   * Note: The row parameter represents the selected shape (after select())
   */
  where(condition: (row: any) => Condition): this {
    const mockRow = this.createMockRow();
    // Apply the selector to get the selected shape that the user sees in the WHERE condition
    const selectedMock = this.selector(mockRow);
    this.whereCond = condition(selectedMock);
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
    this.ctes.push(...ctes);
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
  orderBy(selector: (row: TSelection) => any): this;
  orderBy(selector: (row: TSelection) => any[]): this;
  orderBy(selector: (row: TSelection) => Array<[any, 'ASC' | 'DESC']>): this;
  orderBy(selector: (row: TSelection) => any | any[] | Array<[any, 'ASC' | 'DESC']>): this {
    const mockRow = this.createMockRow();
    const selectedMock = this.selector(mockRow);
    const result = selector(selectedMock);

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
  ): SelectQueryBuilder<TNewSelection> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this.createMockRow();
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
    );
  }

  /**
   * Add a LEFT JOIN to the query with a selector
   * Note: After select(), the left parameter in the join will be the selected shape (TSelection)
   */
  leftJoin<TRight extends Record<string, any>, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'> | DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<TNewSelection> {
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
    const mockRow = this.createMockRow();
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
    );
  }

  /**
   * Add a LEFT JOIN with a CTE
   */
  private leftJoinCte<TRight extends Record<string, any>, TNewSelection>(
    cte: DbCte<TRight>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection
  ): SelectQueryBuilder<TNewSelection> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this.createMockRow();
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
    );
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
  ): SelectQueryBuilder<TNewSelection> {
    const newJoinCounter = this.joinCounter + 1;

    // Create mock for the current selection (left side)
    const mockRow = this.createMockRow();
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
    );
  }

  /**
   * Add an INNER JOIN to the query with a selector
   * Note: After select(), the left parameter in the join will be the selected shape (TSelection)
   */
  innerJoin<TRight, TNewSelection>(
    rightTable: { _getSchema: () => TableSchema } | Subquery<TRight, 'table'>,
    condition: (left: TSelection, right: TRight) => Condition,
    selector: (left: TSelection, right: TRight) => TNewSelection,
    alias?: string
  ): SelectQueryBuilder<TNewSelection> {
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
    const mockRow = this.createMockRow();
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
    );
  }

  /**
   * Create mock row for a specific table/alias (for joins)
   */
  private createMockRowForTable(schema: TableSchema, alias: string): any {
    const mock: any = {};

    // Performance: Build column configs once and cache them
    const columnEntries = Object.entries(schema.columns);
    const columnConfigs = new Map<string, string>();

    for (const [colName, colBuilder] of columnEntries) {
      columnConfigs.set(colName, (colBuilder as any).build().name);
    }

    // Add columns as FieldRef objects with table alias
    for (const [colName, dbColumnName] of columnConfigs) {
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

    // Performance: Cache target schemas for relations
    const relationSchemas = new Map<string, TableSchema | undefined>();
    for (const [relName, relConfig] of Object.entries(schema.relations)) {
      if (relConfig.targetTableBuilder) {
        relationSchemas.set(relName, relConfig.targetTableBuilder.build());
      }
    }

    // Add navigation properties (single references and collections)
    for (const [relName, relConfig] of Object.entries(schema.relations)) {
      if (relConfig.type === 'many') {
        // Collection navigation
        const targetSchema = relationSchemas.get(relName);
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
          enumerable: true,
          configurable: true,
        });
      } else {
        // Single reference navigation
        const targetSchema = relationSchemas.get(relName);
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

        // If we have selection metadata, check if this property has a mapper
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
      const mockRow = this.createMockRow();
      const mockSelection = this.selector(mockRow);
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this.createMockRow();
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
      const mockRow = this.createMockRow();
      const mockSelection = this.selector(mockRow);
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this.createMockRow();
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
      const mockRow = this.createMockRow();
      const mockSelection = this.selector(mockRow);
      fieldToAggregate = selector(mockSelection as TSelection);
    } else {
      // No selector - use the current selection
      const mockRow = this.createMockRow();
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

    // Build count query
    const { sql, params } = this.buildCountQuery(context);

    // Execute
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Execute query and return results as array
   * Collection results are automatically resolved to arrays
   */
  async toList(): Promise<ResolveCollectionResults<TSelection>[]> {
    const context: QueryContext = {
      ctes: new Map(),
      cteCounter: 0,
      paramCounter: 1,
      allParams: [],
      collectionStrategy: this.collectionStrategy,
      executor: this.executor,
    };

    // Analyze the selector to extract nested queries
    const mockRow = this.createMockRow();
    const selectionResult = this.selector(mockRow);

    // Check if we're using temp table strategy and have collections
    const collections = this.detectCollections(selectionResult);
    const useTempTableStrategy = this.collectionStrategy === 'temptable' && collections.length > 0;

    if (useTempTableStrategy) {
      // Two-phase execution for temp table strategy
      return this.executeWithTempTables(selectionResult, context, collections);
    } else {
      // Single-phase execution for JSONB strategy (current behavior)
      return this.executeSinglePhase(selectionResult, context);
    }
  }

  /**
   * Execute query using single-phase approach (JSONB/CTE strategy)
   */
  private async executeSinglePhase(selectionResult: any, context: QueryContext): Promise<any[]> {
    // Build the query
    const { sql, params } = this.buildQuery(selectionResult, context);

    // Execute using executor if available, otherwise use client directly
    const result = this.executor
      ? await this.executor.query(sql, params)
      : await this.client.query(sql, params);

    // Transform results
    return this.transformResults(result.rows, selectionResult) as any;
  }

  /**
   * Execute query using two-phase approach (temp table strategy)
   */
  private async executeWithTempTables(
    selectionResult: any,
    context: QueryContext,
    collections: Array<{ name: string; builder: CollectionQueryBuilder<any> }>
  ): Promise<any[]> {
    // Build base selection (excludes collections, includes foreign keys)
    const baseSelection = this.buildBaseSelection(selectionResult, collections);
    const { sql: baseSql, params: baseParams } = this.buildQuery(baseSelection, {
      ...context,
      ctes: new Map(), // Clear CTEs since we're not using them for collections
    });

    // Check if we can use fully optimized single-query approach
    // Requirements: PostgresClient with querySimpleMulti support AND no parameters in base query
    const canUseFullOptimization =
      this.client.supportsMultiStatementQueries() &&
      baseParams.length === 0 &&
      collections.length > 0;

    if (canUseFullOptimization) {
      return this.executeFullyOptimized(baseSql, baseSelection, selectionResult, context, collections);
    }

    // Legacy two-phase approach: execute base query first
    const baseResult = this.executor
      ? await this.executor.query(baseSql, baseParams)
      : await this.client.query(baseSql, baseParams);

    if (baseResult.rows.length === 0) {
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
      const aggResult = await builder.buildCTE(context, this.client, parentIds);

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
          const aggQueryResult = this.executor
            ? await this.executor.query(aggQuery, [])
            : await this.client.query(aggQuery, []);

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

    // Phase 3: Merge base results with collection results
    const mergedRows = baseResult.rows.map(baseRow => {
      const merged = { ...baseRow };
      for (const collection of collections) {
        const resultMap = collectionResults.get(collection.name);
        const parentId = baseRow.__pk_id;
        merged[collection.name] = resultMap?.get(parentId) || this.getDefaultValueForCollection(collection.builder);
      }
      // Remove the internal __pk_id field before returning
      delete merged.__pk_id;
      return merged;
    });

    // Transform results using the original selection
    return this.transformResults(mergedRows, selectionResult) as any;
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
    collections: Array<{ name: string; builder: CollectionQueryBuilder<any> }>
  ): Promise<any[]> {
    const baseTempTable = `tmp_base_${context.cteCounter++}`;

    // Build SQL for each collection
    const collectionSQLs: string[] = [];

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
      let orderBySQL = orderByFields.length > 0
        ? ` ORDER BY ${orderByFields.map(({ field, direction }: any) => `"${field}" ${direction}`).join(', ')}`
        : ` ORDER BY "id" DESC`;

      const collectionSQL = `SELECT "${foreignKey}" as parent_id, ${selectedFieldsSQL} FROM "${targetTable}" WHERE "${foreignKey}" IN (SELECT "__pk_id" FROM ${baseTempTable})${orderBySQL}`;
      collectionSQLs.push(collectionSQL);
    }

    // Build mega multi-statement SQL
    const statements = [
      `CREATE TEMP TABLE ${baseTempTable} AS ${baseSql}`,
      `SELECT * FROM ${baseTempTable}`,
      ...collectionSQLs,
      `DROP TABLE IF EXISTS ${baseTempTable}`
    ];

    const multiStatementSQL = statements.join(';\n');

    // Execute via querySimpleMulti
    const executor = this.executor || this.client;
    let resultSets: QueryResult[];

    if ('querySimpleMulti' in executor && typeof (executor as any).querySimpleMulti === 'function') {
      resultSets = await (executor as any).querySimpleMulti(multiStatementSQL);
    } else {
      throw new Error('Fully optimized mode requires querySimpleMulti support');
    }

    // Parse result sets: [0]=CREATE, [1]=base, [2..N]=collections, [N+1]=DROP
    const baseResult = resultSets[1];
    if (!baseResult || baseResult.rows.length === 0) {
      return [];
    }

    // Group collection results by parent_id
    const collectionResults = new Map<string, Map<number, any>>();
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

      collectionResults.set(collection.name, dataMap);
    });

    // Merge base results with collection results
    const mergedRows = baseResult.rows.map((baseRow: any) => {
      const merged = { ...baseRow };
      for (const collection of collections) {
        const resultMap = collectionResults.get(collection.name);
        const parentId = baseRow.__pk_id;
        merged[collection.name] = resultMap?.get(parentId) || [];
      }
      delete merged.__pk_id;
      return merged;
    });

    return this.transformResults(mergedRows, selectionResult) as any;
  }

  /**
   * Detect collections in the selection result
   */
  private detectCollections(selection: any): Array<{ name: string; builder: CollectionQueryBuilder<any> }> {
    const collections: Array<{ name: string; builder: CollectionQueryBuilder<any> }> = [];

    if (typeof selection === 'object' && selection !== null && !(selection instanceof SqlFragment)) {
      for (const [key, value] of Object.entries(selection)) {
        if (value instanceof CollectionQueryBuilder) {
          collections.push({ name: key, builder: value });
        } else if (value && typeof value === 'object' && '__collectionResult' in value && 'buildCTE' in value) {
          // This is a CollectionResult which wraps a CollectionQueryBuilder
          collections.push({ name: key, builder: value as any as CollectionQueryBuilder<any> });
        }
      }
    }

    return collections;
  }

  /**
   * Build base selection excluding collections but including necessary foreign keys
   */
  private buildBaseSelection(selection: any, collections: Array<{ name: string; builder: CollectionQueryBuilder<any> }>): any {
    const baseSelection: any = {};
    const collectionNames = new Set(collections.map(c => c.name));

    // Always ensure we have the primary key in the base selection with a known alias
    const mockRow = this.createMockRow();
    baseSelection['__pk_id'] = mockRow.id; // Add primary key with a known alias

    for (const [key, value] of Object.entries(selection)) {
      if (!collectionNames.has(key)) {
        baseSelection[key] = value;
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
      case 'array':
        return "'[]'::jsonb";
      case 'count':
        return '0';
      case 'min':
      case 'max':
      case 'sum':
        return 'null';
      default:
        return "'[]'::jsonb";
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
   * Create mock row for analysis
   */
  private createMockRow(): any {
    const mock: any = {};

    // Add columns as FieldRef objects - type-safe with property name and database column name
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
      // Skip subquery joins (they don't have a schema)
      if ((join as any).isSubquery || !join.schema) {
        continue;
      }

      for (const [colName, colBuilder] of Object.entries(join.schema.columns)) {
        const dbColumnName = (colBuilder as any).build().name;
        // Create a unique property name by prefixing with table alias or using the column name directly
        // For now, we'll create nested objects for each joined table
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

    // Add relations as CollectionQueryBuilder or ReferenceQueryBuilder
    for (const [relName, relConfig] of Object.entries(this.schema.relations)) {
      if (relConfig.type === 'many') {
        Object.defineProperty(mock, relName, {
          get: () => {
            // Don't call build() - force registry lookup to get schema with relations
            return new CollectionQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKey || relConfig.foreignKeys?.[0] || '',
              this.schema.name,
              undefined,  // Don't pass schema, force registry lookup
              this.schemaRegistry  // Pass schema registry for nested resolution
            );
          },
          enumerable: true,
          configurable: true,
        });
      } else {
        // For single reference (many-to-one), create a ReferenceQueryBuilder
        Object.defineProperty(mock, relName, {
          get: () => {
            // Don't call build() - force registry lookup to get schema with relations
            const refBuilder = new ReferenceQueryBuilder(
              relName,
              relConfig.targetTable,
              relConfig.foreignKeys || [relConfig.foreignKey || ''],
              relConfig.matches || [],
              relConfig.isMandatory ?? false,
              undefined,  // Don't pass schema, force registry lookup
              this.schemaRegistry  // Pass schema registry for nested resolution
            );
            // Return a mock object that exposes the target table's columns
            return refBuilder.createMockTargetRow();
          },
          enumerable: true,
          configurable: true,
        });
      }
    }

    return mock;
  }

  /**
   * Detect navigation property references in selection and add necessary JOINs
   */
  private detectAndAddJoinsFromSelection(selection: any, joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean }>): void {
    if (!selection || typeof selection !== 'object') {
      return;
    }

    for (const [key, value] of Object.entries(selection)) {
      if (value && typeof value === 'object' && '__tableAlias' in value && '__dbColumnName' in value) {
        // This is a FieldRef with a table alias - check if it's from a related table
        const tableAlias = value.__tableAlias as string;
        if (tableAlias !== this.schema.name && !joins.some(j => j.alias === tableAlias)) {
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
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Recursively check nested objects
        this.detectAndAddJoinsFromSelection(value, joins);
      }
    }
  }

  /**
   * Build SQL query
   */
  private buildQuery(selection: any, context: QueryContext): { sql: string; params: any[] } {
    // Handle user-defined CTEs first - their params need to come before main query params
    for (const cte of this.ctes) {
      context.allParams.push(...cte.params);
      context.paramCounter += cte.params.length;
    }

    const selectParts: string[] = [];
    const collectionFields: Array<{ name: string; cteName: string }> = [];
    const joins: Array<{ alias: string; targetTable: string; targetSchema?: string; foreignKeys: string[]; matches: string[]; isMandatory: boolean }> = [];

    // Scan selection for navigation property references and add JOINs
    this.detectAndAddJoinsFromSelection(selection, joins);

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
        // Handle collection - create CTE (works for both CollectionQueryBuilder and CollectionResult)
        const cteName = `cte_${context.cteCounter++}`;
        const cteData = (value as any).buildCTE ? (value as any).buildCTE(context) : (value as CollectionQueryBuilder<any>).buildCTE(context);
        context.ctes.set(cteName, cteData);
        collectionFields.push({ name: key, cteName });
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

          selectParts.push(`"${tableAlias}"."${value.__dbColumnName}" as "${key}"`);
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
              for (const [colKey, col] of Object.entries(targetSchema.columns)) {
                const config = (col as any).build();
                fieldParts.push(`'${colKey}', "${alias}"."${config.name}"`);
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
                      // Find the target table schema
                      let targetSchema: TableSchema | undefined;
                      if (relConfig.targetTableBuilder) {
                        targetSchema = relConfig.targetTableBuilder.build();
                      }

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
                        for (const [colKey, col] of Object.entries(targetSchema.columns)) {
                          const config = (col as any).build();
                          fieldParts.push(`'${colKey}', "${alias}"."${config.name}"`);
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

    // Add collection fields as JSON/array aggregations joined from CTEs
    for (const { name, cteName } of collectionFields) {
      // Check if this is an array aggregation (from toNumberList/toStringList)
      const collectionValue = selection[name];
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
        // For JSON aggregation, use jsonb type
        selectParts.push(`COALESCE("${cteName}".data, '[]'::jsonb) as "${name}"`);
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

    // Build ORDER BY clause
    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(
        ({ field, direction }) => {
          // Check if the field is in the selection (after a select() call)
          // If so, reference it as an alias, otherwise use table.column notation
          if (selection && typeof selection === 'object' && !Array.isArray(selection) && field in selection) {
            // Field is in the selected output, use it as an alias
            return `"${field}" ${direction}`;
          } else {
            // Field is not in the selection, use table.column notation
            return `"${this.schema.name}"."${field}" ${direction}`;
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
      const { sql: condSql, params: condParams } = condBuilder.build(manualJoin.condition, context.paramCounter);
      context.paramCounter += condParams.length;
      context.allParams.push(...condParams);

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
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const match = join.matches[i];
        onConditions.push(`"${this.schema.name}"."${fk}" = "${join.alias}"."${match}"`);
      }
      // Use schema-qualified table name if schema is specified
      const joinTableName = this.getQualifiedTableName(join.targetTable, join.targetSchema);
      fromClause += `\n${joinType} ${joinTableName} AS "${join.alias}" ON ${onConditions.join(' AND ')}`;
    }

    // Join CTEs for collections
    for (const { cteName } of collectionFields) {
      fromClause += `\nLEFT JOIN "${cteName}" ON "${cteName}".parent_id = ${qualifiedTableName}.id`;
    }

    // Add DISTINCT if needed
    const distinctClause = this.isDistinct ? 'DISTINCT ' : '';
    finalQuery += `SELECT ${distinctClause}${selectParts.join(', ')}\n${fromClause}\n${whereClause}\n${orderByClause}\n${limitClause}`.trim();

    return {
      sql: finalQuery,
      params: context.allParams,
    };
  }

  /**
   * Transform database results
   */
  private transformResults(rows: any[], selection: any): TSelection[] {
    // Check if mappers are disabled for performance
    const disableMappers = this.executor?.getOptions().disableMappers ?? false;

    // Pre-analyze selection structure once instead of per-row
    // This avoids repeated Object.entries() calls and type checks
    const selectionKeys = Object.keys(selection);
    const selectionEntries = Object.entries(selection);

    // Pre-cache navigation placeholders to avoid repeated checks
    // Only cache actual navigation properties (arrays and getter-based navigation)
    const navigationPlaceholders: Record<string, any> = {};
    for (const [key, value] of selectionEntries) {
      if (Array.isArray(value) && value.length === 0) {
        navigationPlaceholders[key] = [];
      } else if (value === undefined) {
        navigationPlaceholders[key] = undefined;
      } else if (value && typeof value === 'object' && !('__dbColumnName' in value) && !('__fieldName' in value)) {
        // Check if it's a navigation property mock (object with getters)
        // Exclude FieldRef objects by checking for __fieldName
        const props = Object.getOwnPropertyNames(value);
        if (props.length > 0) {
          const firstProp = props[0];
          const descriptor = Object.getOwnPropertyDescriptor(value, firstProp);
          if (descriptor && descriptor.get) {
            navigationPlaceholders[key] = undefined;
          }
        }
      }
    }

    // Pre-build column metadata cache to avoid repeated schema lookups
    const columnMetadataCache: Record<string, { hasMapper: boolean; mapper?: any; config?: any }> = {};
    if (!disableMappers) {
      for (const [key, value] of selectionEntries) {
        if (typeof value === 'object' && value !== null && '__fieldName' in value) {
          const fieldName = value.__fieldName as string;
          const column = this.schema.columns[fieldName];
          if (column) {
            const config = column.build();
            columnMetadataCache[key] = {
              hasMapper: !!config.mapper,
              mapper: config.mapper,
              config: config,
            };
          }
        }
      }
    }

    return rows.map(row => {
      const result: any = {};

      // Copy navigation placeholders without iteration
      Object.assign(result, navigationPlaceholders);

      // Then process actual data fields
      for (const [key, value] of selectionEntries) {
        // Skip if we already set this key as a navigation placeholder
        // UNLESS there's actual data for this key in the row (e.g., from json_build_object)
        if (key in result && (result[key] === undefined || Array.isArray(result[key])) && !(key in row && row[key] !== undefined && row[key] !== null)) {
          continue;
        }

        if (value instanceof CollectionQueryBuilder || (value && typeof value === 'object' && '__collectionResult' in value)) {
          // Check if this is a scalar aggregation (count, sum, max, min)
          const isScalarAgg = value instanceof CollectionQueryBuilder && value.isScalarAggregation();

          if (isScalarAgg) {
            // For scalar aggregations, return the value directly
            // For COUNT, convertValue will handle numeric conversion (NULL is already COALESCE'd to 0 in SQL)
            // For MAX/MIN/SUM, we want to keep NULL as null (not undefined)
            const aggregationType = value.getAggregationType();
            if (aggregationType === 'COUNT') {
              result[key] = this.convertValue(row[key]);
            } else {
              // For MAX/MIN/SUM, preserve NULL and convert numeric strings to numbers
              const rawValue = row[key];
              if (rawValue === null) {
                result[key] = null;
              } else if (typeof rawValue === 'string' && NUMERIC_REGEX.test(rawValue)) {
                result[key] = Number(rawValue);
              } else {
                result[key] = rawValue;
              }
            }
          } else {
            // Check if this is a flattened array result (toNumberList/toStringList)
            const isArrayAgg = value && typeof value === 'object' && 'isArrayAggregation' in value && value.isArrayAggregation();

            if (isArrayAgg) {
              // For flattened arrays, PostgreSQL returns a native array - use it directly
              result[key] = row[key] || [];
            } else {
              // Parse JSON array from CTE (both CollectionQueryBuilder and CollectionResult are treated the same at runtime)
              const collectionItems = row[key] || [];
              // Apply fromDriver mappers to collection items if needed
              if (value instanceof CollectionQueryBuilder) {
                result[key] = this.transformCollectionItems(collectionItems, value);
              } else {
                result[key] = collectionItems;
              }
            }
          }
        } else if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
          // SqlFragment with custom mapper (check this BEFORE FieldRef to handle subquery/CTE fields with mappers)
          const rawValue = row[key];

          if (disableMappers) {
            // Skip mapper transformation for performance
            result[key] = this.convertValue(rawValue);
          } else {
            let mapper = (value as any).getMapper();

            if (mapper && rawValue !== null && rawValue !== undefined) {
              // If mapper is a CustomTypeBuilder, get the actual type
              if (typeof mapper.getType === 'function') {
                mapper = mapper.getType();
              }

              // Apply the fromDriver transformation
              if (typeof mapper.fromDriver === 'function') {
                result[key] = mapper.fromDriver(rawValue);
              } else {
                // Fallback if fromDriver doesn't exist
                result[key] = this.convertValue(rawValue);
              }
            } else {
              // No mapper or null value - convert normally
              result[key] = this.convertValue(rawValue);
            }
          }
        } else if (typeof value === 'object' && value !== null && '__fieldName' in value) {
          // FieldRef object - check if it has a custom mapper
          const rawValue = row[key];

          if (disableMappers) {
            // Skip mapper transformation for performance
            result[key] = rawValue === null ? undefined : rawValue;
          } else {
            // Use pre-cached column metadata instead of repeated lookups
            const cached = columnMetadataCache[key];
            if (cached) {
              // Field is in our schema - use cached mapper info
              result[key] = rawValue === null
                ? undefined
                : (cached.hasMapper ? cached.mapper.fromDriver(rawValue) : rawValue);
            } else {
              // Field not in schema (e.g., CTE field, joined table field)
              // Always call convertValue to handle numeric string conversion
              result[key] = this.convertValue(row[key]);
            }
          }
        } else {
          // Convert null to undefined for all other values
          // Also convert numeric strings to numbers for scalar subqueries (PostgreSQL returns NUMERIC as string)
          const converted = this.convertValue(row[key]);
          result[key] = converted;
        }
      }

      return result as TSelection;
    });
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
    if (typeof value === 'string' && NUMERIC_REGEX.test(value)) {
      const num = Number(value);
      if (!isNaN(num)) {
        return num;
      }
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

    return items.map(item => {
      const transformedItem: any = {};
      for (const [key, value] of Object.entries(item)) {
        // Find the column in target schema
        const column = targetSchema.columns[key];
        if (column) {
          const config = column.build();
          // Apply fromDriver mapper if present
          transformedItem[key] = config.mapper
            ? config.mapper.fromDriver(value)
            : value;
        } else {
          transformedItem[key] = value;
        }
      }
      return transformedItem;
    });
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
      const { sql, params } = condBuilder.build(this.whereCond, context.paramCounter);
      whereClause = `WHERE ${sql}`;
      context.paramCounter += params.length;
      context.allParams.push(...params);
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

    const sql = `SELECT ${aggregation}("${tableAlias}"."${fieldName}") as result\n${fromClause}\n${whereClause}`.trim();

    return {
      sql,
      params: context.allParams,
    };
  }

  /**
   * Build count query
   */
  private buildCountQuery(context: QueryContext): { sql: string; params: any[] } {
    // Build WHERE clause
    let whereClause = '';
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params } = condBuilder.build(this.whereCond, context.paramCounter);
      whereClause = `WHERE ${sql}`;
      context.paramCounter += params.length;
      context.allParams.push(...params);
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

    const sql = `SELECT COUNT(*) as count\n${fromClause}\n${whereClause}`.trim();

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
      // Create a fresh context for this subquery
      const context: QueryContext = {
        ctes: new Map(),
        cteCounter: 0,
        paramCounter: outerContext.paramCounter,
        allParams: outerContext.params,
        executor: this.executor,
      };

      // Analyze the selector to extract nested queries
      const mockRow = this.createMockRow();
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
      const mockRow = this.createMockRow();
      selectionMetadata = this.selector(mockRow) as any;
    }

    return new Subquery(sqlBuilder, mode, selectionMetadata) as any;
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
 * Type helper to resolve all FieldRef and SqlFragment types to their value types
 * Recursively processes nested objects and arrays
 */
export type ResolveFieldRefs<T> = T extends FieldRef<any, infer V>
  ? V
  : T extends SqlFragment<infer V>
  ? V
  : T extends CollectionResult<any>
  ? T  // Preserve CollectionResult for ResolveCollectionResults to handle
  : T extends Array<infer U>
  ? Array<ResolveFieldRefs<U>>
  : T extends object
  ? { [K in keyof T]: ResolveFieldRefs<T[K]> }
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

  constructor(
    relationName: string,
    targetTable: string,
    foreignKeys: string[],
    matches: string[],
    isMandatory: boolean,
    targetTableSchema?: TableSchema,
    schemaRegistry?: Map<string, TableSchema>
  ) {
    this.relationName = relationName;
    this.targetTable = targetTable;
    this.foreignKeys = foreignKeys;
    this.matches = matches;
    this.isMandatory = isMandatory;
    this.targetTableSchema = targetTableSchema;
    this.schemaRegistry = schemaRegistry;

    // If targetTableSchema is not provided but we have a registry, look it up
    if (!this.targetTableSchema && this.schemaRegistry) {
      this.targetTableSchema = this.schemaRegistry.get(targetTable);
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
      // Add columns
      for (const [colName, colBuilder] of Object.entries(this.targetTableSchema.columns)) {
        const dbColumnName = (colBuilder as any).build().name;
        Object.defineProperty(mock, colName, {
          get: () => ({
            __fieldName: colName,
            __dbColumnName: dbColumnName,
            __tableAlias: this.relationName,  // Mark which table this belongs to
          }),
          enumerable: true,
          configurable: true,
        });
      }

      // Add navigation properties (both collections and references)
      if (this.targetTableSchema.relations) {
        for (const [relName, relConfig] of Object.entries(this.targetTableSchema.relations)) {
          if (relConfig.type === 'many') {
            // Collection navigation
            Object.defineProperty(mock, relName, {
              get: () => {
                // Don't call build() - it returns schema without relations
                // Instead, pass undefined and let CollectionQueryBuilder look it up from registry
                const fk = relConfig.foreignKey || relConfig.foreignKeys?.[0] || '';
                return new CollectionQueryBuilder(
                  relName,
                  relConfig.targetTable,
                  fk,
                  this.targetTable,
                  undefined,  // Don't pass schema, force registry lookup
                  this.schemaRegistry  // Pass schema registry for nested resolution
                );
              },
              enumerable: true,
              configurable: true,
            });
          } else {
            // Reference navigation
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
                  this.schemaRegistry  // Pass schema registry for nested resolution
                );
                return refBuilder.createMockTargetRow();
              },
              enumerable: true,
              configurable: true,
            });
          }
        }
      }

      return mock;
    } else {
      // Fallback: generic proxy
      const handler = {
        get: (target: any, prop: string) => ({
          __fieldName: prop,
          __dbColumnName: prop,
          __tableAlias: this.relationName,
        }),
      };
      return new Proxy({}, handler);
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

  // Performance: Cache the mock item to avoid recreating it
  private _cachedMockItem?: any;

  constructor(
    relationName: string,
    targetTable: string,
    foreignKey: string,
    sourceTable: string,
    targetTableSchema?: TableSchema,
    schemaRegistry?: Map<string, TableSchema>
  ) {
    this.relationName = relationName;
    this.targetTable = targetTable;
    this.targetTableSchema = targetTableSchema;
    this.foreignKey = foreignKey;
    this.sourceTable = sourceTable;
    this.schemaRegistry = schemaRegistry;

    // If targetTableSchema is not provided but we have a registry, look it up
    if (!this.targetTableSchema && this.schemaRegistry) {
      this.targetTableSchema = this.schemaRegistry.get(targetTable);
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
      this.targetTableSchema
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
   */
  where(condition: (item: TItem) => Condition): this {
    // Create mock item with proper schema if available
    const mockItem = this.createMockItem();
    this.whereCond = condition(mockItem);
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

      // Performance: Build column configs once and cache them
      const columnEntries = Object.entries(this.targetTableSchema.columns);
      const columnConfigs = new Map<string, string>();

      for (const [colName, colBuilder] of columnEntries) {
        columnConfigs.set(colName, (colBuilder as any).build().name);
      }

      // Add columns
      for (const [colName, dbColumnName] of columnConfigs) {
        Object.defineProperty(mock, colName, {
          get: () => ({
            __fieldName: colName,
            __dbColumnName: dbColumnName,
          }),
          enumerable: true,
          configurable: true,
        });
      }

      // Add navigation properties (both collections and references)
      if (this.targetTableSchema.relations) {
        for (const [relName, relConfig] of Object.entries(this.targetTableSchema.relations)) {
          if (relConfig.type === 'many') {
            // Collection navigation
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
                );
              },
              enumerable: true,
              configurable: true,
            });
          } else {
            // Reference navigation
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
                  this.schemaRegistry  // Pass schema registry for nested resolution
                );
                return refBuilder.createMockTargetRow();
              },
              enumerable: true,
              configurable: true,
            });
          }
        }
      }

      // Cache the mock for reuse
      this._cachedMockItem = mock;
      return mock;
    } else {
      // Fallback: generic proxy (don't cache as it's dynamic)
      const handler = {
        get: (target: any, prop: string) => ({
          __fieldName: prop,
          __dbColumnName: prop,
        }),
      };
      return new Proxy({}, handler);
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
  orderBy(selector: (item: TItem) => any): this;
  orderBy(selector: (item: TItem) => any[]): this;
  orderBy(selector: (item: TItem) => Array<[any, 'ASC' | 'DESC']>): this;
  orderBy(selector: (item: TItem) => any | any[] | Array<[any, 'ASC' | 'DESC']>): this {
    const mockItem = this.createMockItem();
    const result = selector(mockItem);

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
   * Get target table schema
   */
  getTargetTableSchema(): TableSchema | undefined {
    return this.targetTableSchema;
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
   * Build CTE for this collection query
   * Now delegates to collection strategy pattern
   */
  buildCTE(context: QueryContext, client?: DatabaseClient, parentIds?: any[]): { sql: string; params: any[] } {
    // Determine strategy type - default to 'jsonb' if not specified
    const strategyType: CollectionStrategyType = context.collectionStrategy || 'jsonb';
    const strategy = CollectionStrategyFactory.getStrategy(strategyType);

    // Build selected fields configuration
    const selectedFieldConfigs: Array<{ alias: string; expression: string }> = [];
    const localParams: any[] = [];

    // Step 1: Build field selection configuration
    if (this.selector) {
      const mockItem = this.createMockItem();
      const selectedFields = this.selector(mockItem);

      // Check if the selector returns a FieldRef directly (single field selection like p => p.title)
      if (typeof selectedFields === 'object' && selectedFields !== null && '__dbColumnName' in selectedFields) {
        // Single field selection - use the field name as both alias and expression
        const field = selectedFields as any;
        const dbColumnName = field.__dbColumnName;
        selectedFieldConfigs.push({
          alias: dbColumnName,
          expression: `"${dbColumnName}"`,
        });
      } else {
        // Object selection - extract each field
        for (const [alias, field] of Object.entries(selectedFields)) {
          if (field instanceof SqlFragment) {
            // SQL Fragment - build the SQL expression
            const sqlBuildContext = {
              paramCounter: context.paramCounter,
              params: context.allParams,
            };
            const fragmentSql = field.buildSql(sqlBuildContext);
            context.paramCounter = sqlBuildContext.paramCounter;
            selectedFieldConfigs.push({
              alias,
              expression: fragmentSql,
            });
          } else if (typeof field === 'object' && field !== null && '__dbColumnName' in field) {
            // FieldRef object - use database column name
            const dbColumnName = (field as any).__dbColumnName;
            selectedFieldConfigs.push({
              alias,
              expression: `"${dbColumnName}"`,
            });
          } else if (typeof field === 'string') {
            // Simple string reference (for backward compatibility)
            selectedFieldConfigs.push({
              alias,
              expression: `"${field}"`,
            });
          } else {
            // Literal value or expression
            selectedFieldConfigs.push({
              alias,
              expression: `$${context.paramCounter++}`,
            });
            context.allParams.push(field);
            localParams.push(field);
          }
        }
      }
    } else {
      // No selector - select all fields (use * for now, strategy will handle it)
      selectedFieldConfigs.push({
        alias: '*',
        expression: '*',
      });
    }

    // Step 2: Build WHERE clause SQL (without WHERE keyword)
    let whereClause: string | undefined;
    let whereParams: any[] | undefined;
    if (this.whereCond) {
      const condBuilder = new ConditionBuilder();
      const { sql, params } = condBuilder.build(this.whereCond, context.paramCounter);
      whereClause = sql;
      whereParams = params;
      context.paramCounter += params.length;
      localParams.push(...params);
      context.allParams.push(...params);
    }

    // Step 3: Build ORDER BY clause SQL (without ORDER BY keyword)
    let orderByClause: string | undefined;
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(({ field, direction }) => {
        // Look up the database column name from the schema if available
        let dbColumnName = field;
        if (this.targetTableSchema && this.targetTableSchema.columns[field]) {
          const colBuilder = this.targetTableSchema.columns[field];
          dbColumnName = (colBuilder as any).build().name;
        }
        return `"${dbColumnName}" ${direction}`;
      });
      orderByClause = orderParts.join(', ');
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
      // JSONB aggregation (default)
      aggregationType = 'jsonb';
      defaultValue = "'[]'::jsonb";
    }

    // Step 5: Build CollectionAggregationConfig object
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
      limitValue: this.limitValue,
      offsetValue: this.offsetValue,
      isDistinct: this.isDistinct,
      aggregationType,
      aggregateField,
      arrayField,
      defaultValue,
      counter: context.cteCounter++,
    };

    // Step 6: Call the strategy
    const result = strategy.buildAggregation(config, context, client!);

    // Step 7: Return the result
    // For synchronous strategies (like JSONB), result is returned directly
    // For async strategies (like temp table), return the Promise
    // Callers need to handle both cases
    if (result instanceof Promise) {
      // Async strategy - return special marker with the promise
      return result as any;
    }

    // Synchronous strategy (JSONB/CTE)
    return {
      sql: result.sql,
      params: localParams,
    };
  }
}
