import { DatabaseClient } from '../database/database-client.interface';
import { QueryContext } from './query-builder';

/**
 * Collection aggregation strategy type
 */
export type CollectionStrategyType = 'jsonb' | 'temptable';

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
   * Fields to select
   */
  selectedFields: Array<{ alias: string; expression: string }>;

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
