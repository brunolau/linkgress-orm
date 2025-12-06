import { DatabaseClient } from '../../database/database-client.interface';
import {
  ICollectionStrategy,
  CollectionStrategyType,
  CollectionAggregationConfig,
  CollectionAggregationResult,
  SelectedField,
} from '../collection-strategy.interface';
import { QueryContext } from '../query-builder';

/**
 * LATERAL JOIN-based collection strategy
 *
 * This strategy uses PostgreSQL LATERAL joins to efficiently fetch related records
 * for each parent row. LATERAL allows the subquery to reference columns from
 * preceding FROM items, enabling per-row subqueries.
 *
 * Benefits:
 * - Single query execution (like CTE)
 * - Can be more efficient for queries with LIMIT/OFFSET per parent
 * - Better query plan for certain data distributions
 * - Natural support for correlated subqueries
 *
 * Trade-offs:
 * - May be slower than CTE for large result sets without LIMIT
 * - Query plan depends heavily on indexes
 *
 * SQL Pattern:
 * ```sql
 * SELECT
 *   "users"."id", "users"."username",
 *   COALESCE("lateral_0".data, '[]'::jsonb) as "posts"
 * FROM "users"
 * LEFT JOIN LATERAL (
 *   SELECT jsonb_agg(
 *     jsonb_build_object('id', "id", 'title', "title")
 *     ORDER BY "views" DESC
 *   ) as data
 *   FROM (
 *     SELECT "id", "title", "views"
 *     FROM "posts"
 *     WHERE "posts"."user_id" = "users"."id"
 *       AND "views" > $1
 *     ORDER BY "views" DESC
 *     LIMIT 10
 *   ) sub
 * ) "lateral_0" ON true
 * ```
 */
export class LateralCollectionStrategy implements ICollectionStrategy {
  getType(): CollectionStrategyType {
    return 'lateral';
  }

  requiresParentIds(): boolean {
    // LATERAL doesn't need parent IDs upfront - it correlates with each parent row
    return false;
  }

  buildAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext
  ): CollectionAggregationResult {
    const lateralAlias = `lateral_${config.counter}`;

    let lateralSQL: string;
    let selectExpression: string;

    switch (config.aggregationType) {
      case 'jsonb':
        lateralSQL = this.buildJsonbAggregation(config, lateralAlias, context);
        selectExpression = `COALESCE("${lateralAlias}".data, ${config.defaultValue})`;
        break;

      case 'array':
        lateralSQL = this.buildArrayAggregation(config, lateralAlias, context);
        selectExpression = `COALESCE("${lateralAlias}".data, ${config.defaultValue})`;
        break;

      case 'count':
      case 'min':
      case 'max':
      case 'sum':
        lateralSQL = this.buildScalarAggregation(config, lateralAlias, context);
        selectExpression = `COALESCE("${lateralAlias}".data, ${config.defaultValue})`;
        break;

      default:
        throw new Error(`Unknown aggregation type: ${config.aggregationType}`);
    }

    // For LATERAL, we don't use CTEs - instead we inline the subquery in the JOIN
    // The join clause includes the entire LATERAL subquery
    const joinClause = `LEFT JOIN LATERAL (${lateralSQL}) "${lateralAlias}" ON true`;

    return {
      sql: lateralSQL,
      params: context.allParams,
      tableName: lateralAlias,
      joinClause,
      selectExpression,
      isCTE: false, // LATERAL is not a CTE - it's an inline subquery
    };
  }

  /**
   * Build JSONB aggregation using LATERAL
   */
  private buildJsonbAggregation(
    config: CollectionAggregationConfig,
    lateralAlias: string,
    context: QueryContext
  ): string {
    const { selectedFields, targetTable, foreignKey, sourceTable, whereClause, orderByClause, limitValue, offsetValue, isDistinct } = config;

    // Helper to collect all leaf fields from a potentially nested structure
    const collectLeafFields = (fields: SelectedField[], prefix: string = ''): Array<{ alias: string; expression: string }> => {
      const result: Array<{ alias: string; expression: string }> = [];
      for (const field of fields) {
        const fullAlias = prefix ? `${prefix}__${field.alias}` : field.alias;
        if (field.nested) {
          result.push(...collectLeafFields(field.nested, fullAlias));
        } else if (field.expression) {
          result.push({ alias: fullAlias, expression: field.expression });
        }
      }
      return result;
    };

    // Helper to build jsonb_build_object expression (handles nested structures)
    const buildJsonbObject = (fields: SelectedField[], prefix: string = ''): string => {
      const parts: string[] = [];
      for (const field of fields) {
        if (field.nested) {
          const nestedJsonb = buildJsonbObject(field.nested, prefix ? `${prefix}__${field.alias}` : field.alias);
          parts.push(`'${field.alias}', ${nestedJsonb}`);
        } else {
          const fullAlias = prefix ? `${prefix}__${field.alias}` : field.alias;
          parts.push(`'${field.alias}', "${fullAlias}"`);
        }
      }
      return `jsonb_build_object(${parts.join(', ')})`;
    };

    // Collect all leaf fields for the SELECT clause
    const leafFields = collectLeafFields(selectedFields);

    // Build the subquery SELECT fields (no foreign key needed since we correlate with parent)
    const allSelectFields = leafFields.map(f => {
      if (f.expression !== `"${f.alias}"`) {
        return `${f.expression} as "${f.alias}"`;
      }
      return f.expression;
    });

    // Build the JSONB fields for jsonb_build_object
    const jsonbObjectExpr = buildJsonbObject(selectedFields);

    // Build WHERE clause - LATERAL correlates with parent via foreign key
    // The correlation is: target.foreignKey = source.id
    let whereSQL = `WHERE "${targetTable}"."${foreignKey}" = "${sourceTable}"."id"`;
    if (whereClause) {
      whereSQL += ` AND ${whereClause}`;
    }

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

    // Note: We don't add ORDER BY inside jsonb_agg because:
    // 1. The inner subquery already applies ORDER BY before LIMIT/OFFSET
    // 2. Column aliases in the subquery may differ from original column names
    // The order is preserved from the inner query's ORDER BY

    const lateralSQL = `
SELECT jsonb_agg(
  ${jsonbObjectExpr}
) as data
FROM (
  SELECT ${distinctClause}${allSelectFields.join(', ')}
  FROM "${targetTable}"
  ${whereSQL}
  ${orderBySQL}
  ${limitOffsetClause}
) sub
    `.trim();

    return lateralSQL;
  }

  /**
   * Build array aggregation using LATERAL (for toNumberList/toStringList)
   */
  private buildArrayAggregation(
    config: CollectionAggregationConfig,
    lateralAlias: string,
    context: QueryContext
  ): string {
    const { arrayField, targetTable, foreignKey, sourceTable, whereClause, orderByClause, limitValue, offsetValue, isDistinct } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    // Build WHERE clause with LATERAL correlation
    let whereSQL = `WHERE "${targetTable}"."${foreignKey}" = "${sourceTable}"."id"`;
    if (whereClause) {
      whereSQL += ` AND ${whereClause}`;
    }

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

    // Note: We don't add ORDER BY inside array_agg because the inner subquery already sorts

    const lateralSQL = `
SELECT array_agg(
  "${arrayField}"
) as data
FROM (
  SELECT ${distinctClause}"${arrayField}"
  FROM "${targetTable}"
  ${whereSQL}
  ${orderBySQL}
  ${limitOffsetClause}
) sub
    `.trim();

    return lateralSQL;
  }

  /**
   * Build scalar aggregation using LATERAL (COUNT, MIN, MAX, SUM)
   */
  private buildScalarAggregation(
    config: CollectionAggregationConfig,
    lateralAlias: string,
    context: QueryContext
  ): string {
    const { aggregationType, aggregateField, targetTable, foreignKey, sourceTable, whereClause } = config;

    // Build WHERE clause with LATERAL correlation
    let whereSQL = `WHERE "${targetTable}"."${foreignKey}" = "${sourceTable}"."id"`;
    if (whereClause) {
      whereSQL += ` AND ${whereClause}`;
    }

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

    const lateralSQL = `
SELECT ${aggregateExpression} as data
FROM "${targetTable}"
${whereSQL}
    `.trim();

    return lateralSQL;
  }
}
