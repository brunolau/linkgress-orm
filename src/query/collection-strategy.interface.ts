import { DatabaseClient } from '../database/database-client.interface';
import { QueryContext } from './query-builder';

/**
 * Represents a field in a collection selection that can be either a simple expression
 * or a nested object structure
 */
export interface SelectedField {
  alias: string;
  expression?: string;  // SQL expression (for leaf fields)
  nested?: SelectedField[];  // Nested fields (for object structures)
  /**
   * When this field is a nested CTE (collection within collection),
   * this specifies how to join that CTE.
   */
  nestedCteJoin?: {
    cteName: string;
    joinClause: string;  // e.g., 'LEFT JOIN "cte_0" ON "orders"."id" = "cte_0".parent_id'
  };
}

/**
 * Collection aggregation strategy type
 */
export type CollectionStrategyType = 'cte' | 'temptable' | 'lateral';

/**
 * Result of building a collection aggregation
 */
export interface CollectionAggregationResult {
  /**
   * SQL for the CTE or temp table creation
   */
  sql: string;

  /**
   * Parameters for the SQL query
   */
  params: any[];

  /**
   * The CTE name or temp table name to join against
   */
  tableName: string;

  /**
   * Join clause to connect the aggregation to the main query
   * Example: 'LEFT JOIN "cte_0" ON "users"."id" = "cte_0".parent_id'
   */
  joinClause: string;

  /**
   * Column expression to select from the joined aggregation
   * Example: 'COALESCE("cte_0".data, \'[]\'::jsonb)'
   */
  selectExpression: string;

  /**
   * Whether this is a CTE (goes in WITH clause) or requires separate execution
   */
  isCTE: boolean;

  /**
   * Optional cleanup SQL (for temp tables)
   */
  cleanupSql?: string;

  /**
   * If true, the data has been fetched and is available in `data` field
   * (multi-statement query optimization)
   */
  dataFetched?: boolean;

  /**
   * The fetched data (when dataFetched is true)
   * Map of parent_id -> aggregated data
   */
  data?: Map<number, any>;
}

/**
 * Navigation join information for multi-level navigation in collections
 */
export interface NavigationJoin {
  /**
   * Alias for the joined table (usually the relation name)
   */
  alias: string;

  /**
   * The actual table name to join
   */
  targetTable: string;

  /**
   * Schema name if different from public
   */
  targetSchema?: string;

  /**
   * Foreign key columns in the source table
   */
  foreignKeys: string[];

  /**
   * Primary key columns in the target table to match
   */
  matches: string[];

  /**
   * Whether this is an INNER JOIN (true) or LEFT JOIN (false)
   */
  isMandatory: boolean;

  /**
   * The source table alias for this join (the table that has the FK)
   */
  sourceAlias: string;
}

/**
 * Configuration for building a collection aggregation
 */
export interface CollectionAggregationConfig {
  /**
   * Name of the relation (for naming CTEs/temp tables)
   */
  relationName: string;

  /**
   * Target table to query
   */
  targetTable: string;

  /**
   * Foreign key column in target table
   */
  foreignKey: string;

  /**
   * Source table (parent)
   */
  sourceTable: string;

  /**
   * Parent IDs to filter by (for temp table strategy)
   */
  parentIds?: any[];

  /**
   * Fields to select (supports nested object structures)
   */
  selectedFields: SelectedField[];

  /**
   * WHERE clause SQL (without WHERE keyword)
   */
  whereClause?: string;

  /**
   * Parameters for WHERE clause
   */
  whereParams?: any[];

  /**
   * ORDER BY clause SQL (without ORDER BY keyword)
   */
  orderByClause?: string;

  /**
   * LIMIT value
   */
  limitValue?: number;

  /**
   * OFFSET value
   */
  offsetValue?: number;

  /**
   * Whether to use DISTINCT
   */
  isDistinct?: boolean;

  /**
   * Aggregation type
   */
  aggregationType: 'jsonb' | 'array' | 'count' | 'min' | 'max' | 'sum';

  /**
   * For scalar aggregations, the field to aggregate
   */
  aggregateField?: string;

  /**
   * For array aggregations, the field to collect
   */
  arrayField?: string;

  /**
   * Default value for empty aggregations
   */
  defaultValue: string;

  /**
   * Counter for naming CTEs/temp tables
   */
  counter: number;

  /**
   * Navigation joins needed for multi-level navigation in collection selectors
   * These represent JOINs to related tables (e.g., task.level.createdBy)
   */
  navigationJoins?: NavigationJoin[];
}

/**
 * Strategy interface for collection aggregation
 */
export interface ICollectionStrategy {
  /**
   * Build the aggregation query (CTE or temp table)
   */
  buildAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext,
    client: DatabaseClient
  ): Promise<CollectionAggregationResult> | CollectionAggregationResult;

  /**
   * Get the strategy type
   */
  getType(): CollectionStrategyType;

  /**
   * Whether this strategy requires pre-execution of parent query
   * (temp table needs parent IDs first)
   */
  requiresParentIds(): boolean;
}
