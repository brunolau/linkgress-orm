import { DatabaseClient } from '../../database/database-client.interface';
import {
  ICollectionStrategy,
  CollectionStrategyType,
  CollectionAggregationConfig,
  CollectionAggregationResult,
} from '../collection-strategy.interface';
import { QueryContext } from '../query-builder';

/**
 * JSONB-based collection strategy using CTEs
 *
 * This is the current/default strategy that uses PostgreSQL CTEs with jsonb_agg
 * to aggregate related records into JSONB arrays.
 *
 * Benefits:
 * - Single query execution
 * - No temp table management
 * - Works well for moderate data sizes
 *
 * SQL Pattern:
 * ```sql
 * WITH "cte_0" AS (
 *   SELECT
 *     "user_id" as parent_id,
 *     jsonb_agg(
 *       jsonb_build_object('id', "id", 'title', "title")
 *       ORDER BY "views" DESC
 *     ) as data
 *   FROM (
 *     SELECT "user_id", "id", "title", "views"
 *     FROM "posts"
 *     WHERE "views" > $1
 *     ORDER BY "views" DESC
 *   ) sub
 *   GROUP BY "user_id"
 * )
 * SELECT ... COALESCE("cte_0".data, '[]'::jsonb) as "posts" ...
 * ```
 */
export class JsonbCollectionStrategy implements ICollectionStrategy {
  getType(): CollectionStrategyType {
    return 'jsonb';
  }

  requiresParentIds(): boolean {
    // JSONB strategy doesn't need parent IDs upfront - it aggregates for all parents
    return false;
  }

  buildAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext
  ): CollectionAggregationResult {
    const cteName = `cte_${config.counter}`;

    let cteSQL: string;
    let selectExpression: string;

    switch (config.aggregationType) {
      case 'jsonb':
        cteSQL = this.buildJsonbAggregation(config, cteName, context);
        selectExpression = `COALESCE("${cteName}".data, ${config.defaultValue})`;
        break;

      case 'array':
        cteSQL = this.buildArrayAggregation(config, cteName, context);
        selectExpression = `COALESCE("${cteName}".data, ${config.defaultValue})`;
        break;

      case 'count':
      case 'min':
      case 'max':
      case 'sum':
        cteSQL = this.buildScalarAggregation(config, cteName, context);
        selectExpression = `COALESCE("${cteName}".data, ${config.defaultValue})`;
        break;

      default:
        throw new Error(`Unknown aggregation type: ${config.aggregationType}`);
    }

    // Store CTE in context
    context.ctes.set(cteName, { sql: cteSQL, params: [] });

    return {
      sql: cteSQL,
      params: context.allParams,
      tableName: cteName,
      joinClause: `LEFT JOIN "${cteName}" ON "${config.sourceTable}"."id" = "${cteName}".parent_id`,
      selectExpression,
      isCTE: true,
    };
  }

  /**
   * Build JSONB aggregation CTE
   */
  private buildJsonbAggregation(
    config: CollectionAggregationConfig,
    cteName: string,
    context: QueryContext
  ): string {
    const { selectedFields, targetTable, foreignKey, whereClause, orderByClause, limitValue, offsetValue, isDistinct } = config;

    // Build the subquery SELECT fields
    const allSelectFields = [
      `"${foreignKey}" as "__fk_${foreignKey}"`,
      ...selectedFields.map(f => {
        // Always add alias if expression doesn't already match the quoted alias
        if (f.expression !== `"${f.alias}"`) {
          return `${f.expression} as "${f.alias}"`;
        }
        return f.expression;
      }),
    ];

    // Build the JSONB fields for jsonb_build_object using the aliases from the subquery
    const jsonbFields = selectedFields
      .map(f => `'${f.alias}', "${f.alias}"`)
      .join(', ');

    // Build WHERE clause
    const whereSQL = whereClause ? `WHERE ${whereClause}` : '';

    // Build ORDER BY clause
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : '';

    // Build LIMIT/OFFSET
    let limitOffsetClause = '';
    if (limitValue !== undefined) {
      limitOffsetClause = `LIMIT ${limitValue}`;
    }
    if (offsetValue !== undefined) {
      limitOffsetClause += ` OFFSET ${offsetValue}`;
    }

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build the jsonb_agg ORDER BY clause
    const jsonbAggOrderBy = orderByClause ? ` ORDER BY ${orderByClause}` : '';

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  jsonb_agg(
    jsonb_build_object(${jsonbFields})${jsonbAggOrderBy}
  ) as data
FROM (
  SELECT ${distinctClause}${allSelectFields.join(', ')}
  FROM "${targetTable}"
  ${whereSQL}
  ${orderBySQL}
  ${limitOffsetClause}
) sub
GROUP BY "__fk_${foreignKey}"
    `.trim();

    return cteSQL;
  }

  /**
   * Build array aggregation CTE (for toNumberList/toStringList)
   */
  private buildArrayAggregation(
    config: CollectionAggregationConfig,
    cteName: string,
    context: QueryContext
  ): string {
    const { arrayField, targetTable, foreignKey, whereClause, orderByClause, limitValue, offsetValue, isDistinct } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    // Build WHERE clause
    const whereSQL = whereClause ? `WHERE ${whereClause}` : '';

    // Build ORDER BY clause
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : '';

    // Build LIMIT/OFFSET
    let limitOffsetClause = '';
    if (limitValue !== undefined) {
      limitOffsetClause = `LIMIT ${limitValue}`;
    }
    if (offsetValue !== undefined) {
      limitOffsetClause += ` OFFSET ${offsetValue}`;
    }

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build the array_agg ORDER BY clause
    const arrayAggOrderBy = orderByClause ? ` ORDER BY ${orderByClause}` : '';

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  array_agg(
    "${arrayField}"${arrayAggOrderBy}
  ) as data
FROM (
  SELECT ${distinctClause}"__fk_${foreignKey}", "${arrayField}"
  FROM (
    SELECT "${foreignKey}" as "__fk_${foreignKey}", "${arrayField}"
    FROM "${targetTable}"
    ${whereSQL}
    ${orderBySQL}
    ${limitOffsetClause}
  ) inner_sub
) sub
GROUP BY "__fk_${foreignKey}"
    `.trim();

    return cteSQL;
  }

  /**
   * Build scalar aggregation CTE (COUNT, MIN, MAX, SUM)
   */
  private buildScalarAggregation(
    config: CollectionAggregationConfig,
    cteName: string,
    context: QueryContext
  ): string {
    const { aggregationType, aggregateField, targetTable, foreignKey, whereClause } = config;

    // Build WHERE clause
    const whereSQL = whereClause ? `WHERE ${whereClause}` : '';

    // Build aggregation expression
    let aggregateExpression: string;
    switch (aggregationType) {
      case 'count':
        aggregateExpression = 'COUNT(*)';
        break;
      case 'min':
      case 'max':
      case 'sum':
        if (!aggregateField) {
          throw new Error(`${aggregationType.toUpperCase()} requires an aggregate field`);
        }
        aggregateExpression = `${aggregationType.toUpperCase()}("${aggregateField}")`;
        break;
      default:
        throw new Error(`Unknown aggregation type: ${aggregationType}`);
    }

    const cteSQL = `
SELECT
  "${foreignKey}" as parent_id,
  ${aggregateExpression} as data
FROM "${targetTable}"
${whereSQL}
GROUP BY "${foreignKey}"
    `.trim();

    return cteSQL;
  }
}
