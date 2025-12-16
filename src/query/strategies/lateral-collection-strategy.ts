import { DatabaseClient } from '../../database/database-client.interface';
import {
  ICollectionStrategy,
  CollectionStrategyType,
  CollectionAggregationConfig,
  CollectionAggregationResult,
  SelectedField,
  NavigationJoin,
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
 *   SELECT json_agg(
 *     json_build_object('id', "id", 'title', "title")
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

    // Optimization: For simple aggregations without LIMIT/OFFSET/ORDER BY,
    // use a correlated subquery in SELECT instead of LATERAL JOIN.
    // This can be more efficient because the query planner can short-circuit
    // when rows don't need the aggregated value.
    const useCorrelatedSubquery = this.canUseCorrelatedSubquery(config);

    if (useCorrelatedSubquery) {
      return this.buildCorrelatedSubqueryAggregation(config, lateralAlias, context);
    }

    let lateralSQL: string;
    let selectExpression: string;

    switch (config.aggregationType) {
      case 'jsonb':
        if (config.isSingleResult) {
          // firstOrDefault() - return single object or null, not an array
          lateralSQL = this.buildSingleJsonAggregation(config, lateralAlias, context);
          selectExpression = `"${lateralAlias}".data`;  // Already handles null via subquery
        } else {
          lateralSQL = this.buildJsonbAggregation(config, lateralAlias, context);
          selectExpression = `COALESCE("${lateralAlias}".data, ${config.defaultValue})`;
        }
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
   * Check if we can use a correlated subquery instead of LATERAL
   * This is more efficient for simple cases without LIMIT/OFFSET/ORDER BY
   */
  private canUseCorrelatedSubquery(config: CollectionAggregationConfig): boolean {
    // Use correlated subquery for simple aggregations:
    // - array aggregation (toNumberList, toStringList)
    // - scalar aggregations (count, min, max, sum)
    // - no LIMIT/OFFSET (LATERAL is required for per-row LIMIT)
    // - no complex ORDER BY (simple cases don't need ordering preserved)
    const isSimpleAggregation = config.aggregationType === 'array' ||
                                 config.aggregationType === 'count' ||
                                 config.aggregationType === 'min' ||
                                 config.aggregationType === 'max' ||
                                 config.aggregationType === 'sum';

    const hasNoLimitOffset = config.limitValue === undefined && config.offsetValue === undefined;

    // For array aggregations, ORDER BY doesn't matter for the result
    // For scalar aggregations, ORDER BY is irrelevant
    const orderByIrrelevant = config.aggregationType !== 'jsonb';

    return isSimpleAggregation && hasNoLimitOffset && orderByIrrelevant;
  }

  /**
   * Build a correlated subquery in SELECT instead of LATERAL JOIN
   * This pattern: (SELECT COALESCE(agg(...), default) FROM ...)
   * is often more efficient than: LEFT JOIN LATERAL (...) ON true
   */
  private buildCorrelatedSubqueryAggregation(
    config: CollectionAggregationConfig,
    lateralAlias: string,
    context: QueryContext
  ): CollectionAggregationResult {
    const { arrayField, targetTable, foreignKey, sourceTable, whereClause, isDistinct, navigationJoins, selectedFields, aggregationType, aggregateField, defaultValue } = config;

    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);

    // Build WHERE clause with correlation to parent
    let whereSQL = `"${targetTable}"."${foreignKey}" = "${sourceTable}"."id"`;
    if (whereClause) {
      whereSQL += ` AND ${whereClause}`;
    }

    let subquerySQL: string;

    if (aggregationType === 'array') {
      if (!arrayField) {
        throw new Error('arrayField is required for array aggregation');
      }

      // Get the actual field expression from selectedFields (if available)
      let fieldExpression = `"${arrayField}"`;
      if (selectedFields && selectedFields.length > 0) {
        const firstField = selectedFields[0];
        if (firstField.expression && firstField.expression !== `"${arrayField}"`) {
          fieldExpression = firstField.expression;
        } else if (hasNavigationJoins) {
          fieldExpression = `"${targetTable}"."${arrayField}"`;
        }
      }

      // Build correlated subquery for array aggregation
      // For DISTINCT, wrap in a subquery to allow HashAggregate instead of Sort
      // Pattern: (SELECT array_agg(x) FROM (SELECT DISTINCT x FROM ...) sub)
      // This is more efficient than array_agg(DISTINCT x) which forces a sort
      if (isDistinct) {
        subquerySQL = `(SELECT COALESCE(array_agg("${arrayField}"), ${defaultValue})
FROM (SELECT DISTINCT ${fieldExpression} as "${arrayField}"
FROM "${targetTable}"
${navJoinsSQL}
WHERE ${whereSQL}) "sq")`;
      } else {
        subquerySQL = `(SELECT COALESCE(array_agg(${fieldExpression}), ${defaultValue})
FROM "${targetTable}"
${navJoinsSQL}
WHERE ${whereSQL})`;
      }
    } else {
      // Scalar aggregation (count, min, max, sum)
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

      // Build correlated subquery for scalar aggregation
      subquerySQL = `(SELECT COALESCE(${aggregateExpression}, ${defaultValue})
FROM "${targetTable}"
${navJoinsSQL}
WHERE ${whereSQL})`;
    }

    // For correlated subquery, the select expression IS the subquery
    // No JOIN clause needed - it's embedded in SELECT
    return {
      sql: '', // No separate SQL - it's inline
      params: context.allParams,
      tableName: lateralAlias,
      joinClause: '', // No join needed
      selectExpression: subquerySQL,
      isCTE: false,
    };
  }

  /**
   * Helper to collect nested CTE/LATERAL joins from selected fields
   * These are joins to CTEs or LATERAL subqueries created for nested collections
   */
  private collectNestedCteJoins(fields: SelectedField[]): string[] {
    const joins: string[] = [];
    for (const field of fields) {
      if (field.nestedCteJoin) {
        joins.push(field.nestedCteJoin.joinClause);
      }
      if (field.nested) {
        joins.push(...this.collectNestedCteJoins(field.nested));
      }
    }
    return joins;
  }

  /**
   * Build navigation JOINs SQL for multi-level navigation in collection queries
   */
  private buildNavigationJoins(navigationJoins: NavigationJoin[] | undefined, targetTable: string): string {
    if (!navigationJoins || navigationJoins.length === 0) {
      return '';
    }

    const joinClauses: string[] = [];

    for (const join of navigationJoins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      const qualifiedTable = join.targetSchema
        ? `"${join.targetSchema}"."${join.targetTable}"`
        : `"${join.targetTable}"`;

      // Build the ON clause
      // foreignKeys are the columns in the source table
      // matches are the columns in the target table (usually primary keys)
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const pk = join.matches[i] || 'id';
        onConditions.push(`"${join.sourceAlias}"."${fk}" = "${join.alias}"."${pk}"`);
      }

      joinClauses.push(`${joinType} ${qualifiedTable} "${join.alias}" ON ${onConditions.join(' AND ')}`);
    }

    return joinClauses.join('\n  ');
  }

  /**
   * Build JSONB aggregation using LATERAL
   */
  private buildJsonbAggregation(
    config: CollectionAggregationConfig,
    lateralAlias: string,
    context: QueryContext
  ): string {
    const { selectedFields, targetTable, foreignKey, sourceTable, whereClause, orderByClause, limitValue, offsetValue, isDistinct, navigationJoins } = config;

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

    // Helper to build json_build_object expression (handles nested structures)
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
      return `json_build_object(${parts.join(', ')})`;
    };

    // Collect all leaf fields for the SELECT clause
    const leafFields = collectLeafFields(selectedFields);

    // When there are navigation joins, we need to qualify unqualified field expressions
    // with the target table name to avoid ambiguous column references
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // Build the subquery SELECT fields (no foreign key needed since we correlate with parent)
    const allSelectFields = leafFields.map(f => {
      // If expression is just a quoted column name (e.g., `"id"`), qualify it with target table
      // But if it's already qualified (e.g., `"user"."username"`), leave it as is
      const isSimpleColumn = /^"[^".]+"$/.test(f.expression);
      if (isSimpleColumn && hasNavigationJoins) {
        // Extract column name and qualify with target table
        const columnName = f.expression.slice(1, -1); // Remove quotes
        return `"${targetTable}"."${columnName}" as "${f.alias}"`;
      }
      if (f.expression !== `"${f.alias}"`) {
        return `${f.expression} as "${f.alias}"`;
      }
      return f.expression;
    });

    // Build the JSONB fields for json_build_object
    const jsonbObjectExpr = buildJsonbObject(selectedFields);

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);

    // Collect nested CTE/LATERAL joins (for collections within collections)
    const nestedCteJoins = this.collectNestedCteJoins(selectedFields);
    const nestedCteJoinsSQL = nestedCteJoins.length > 0 ? nestedCteJoins.join('\n  ') : '';

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

    // Note: We don't add ORDER BY inside json_agg because:
    // 1. The inner subquery already applies ORDER BY before LIMIT/OFFSET
    // 2. Column aliases in the subquery may differ from original column names
    // The order is preserved from the inner query's ORDER BY

    const lateralSQL = `
SELECT json_agg(
  ${jsonbObjectExpr}
) as data
FROM (
  SELECT ${distinctClause}${allSelectFields.join(', ')}
  FROM "${targetTable}"
  ${navJoinsSQL}
  ${nestedCteJoinsSQL}
  ${whereSQL}
  ${orderBySQL}
  ${limitOffsetClause}
) sub
    `.trim();

    return lateralSQL;
  }

  /**
   * Build single JSON object aggregation using LATERAL (for firstOrDefault)
   * Returns a single JSON object or null, not an array.
   */
  private buildSingleJsonAggregation(
    config: CollectionAggregationConfig,
    lateralAlias: string,
    context: QueryContext
  ): string {
    const { selectedFields, targetTable, foreignKey, sourceTable, whereClause, orderByClause, isDistinct, navigationJoins } = config;

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

    // Helper to build json_build_object expression (handles nested structures)
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
      return `json_build_object(${parts.join(', ')})`;
    };

    // Collect all leaf fields for the SELECT clause
    const leafFields = collectLeafFields(selectedFields);

    // When there are navigation joins, we need to qualify unqualified field expressions
    // with the target table name to avoid ambiguous column references
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // Build the subquery SELECT fields (no foreign key needed since we correlate with parent)
    const allSelectFields = leafFields.map(f => {
      // If expression is just a quoted column name (e.g., `"id"`), qualify it with target table
      // But if it's already qualified (e.g., `"user"."username"`), leave it as is
      const isSimpleColumn = /^"[^".]+"$/.test(f.expression);
      if (isSimpleColumn && hasNavigationJoins) {
        // Extract column name and qualify with target table
        const columnName = f.expression.slice(1, -1); // Remove quotes
        return `"${targetTable}"."${columnName}" as "${f.alias}"`;
      }
      if (f.expression !== `"${f.alias}"`) {
        return `${f.expression} as "${f.alias}"`;
      }
      return f.expression;
    });

    // Build the JSONB fields for json_build_object
    const jsonbObjectExpr = buildJsonbObject(selectedFields);

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);

    // Collect nested CTE/LATERAL joins (for collections within collections)
    const nestedCteJoins = this.collectNestedCteJoins(selectedFields);
    const nestedCteJoinsSQL = nestedCteJoins.length > 0 ? nestedCteJoins.join('\n  ') : '';

    // Build WHERE clause - LATERAL correlates with parent via foreign key
    let whereSQL = `WHERE "${targetTable}"."${foreignKey}" = "${sourceTable}"."id"`;
    if (whereClause) {
      whereSQL += ` AND ${whereClause}`;
    }

    // Build ORDER BY clause
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : '';

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // For single result, use row_to_json on the first row
    // LIMIT 1 is applied inside the subquery
    const lateralSQL = `
SELECT ${jsonbObjectExpr} as data
FROM (
  SELECT ${distinctClause}${allSelectFields.join(', ')}
  FROM "${targetTable}"
  ${navJoinsSQL}
  ${nestedCteJoinsSQL}
  ${whereSQL}
  ${orderBySQL}
  LIMIT 1
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
    const { arrayField, targetTable, foreignKey, sourceTable, whereClause, orderByClause, limitValue, offsetValue, isDistinct, navigationJoins, selectedFields } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // Get the actual field expression from selectedFields (if available)
    // This handles navigation properties like p.user!.id which need to be "user"."id"
    let fieldExpression = `"${arrayField}"`;
    if (selectedFields && selectedFields.length > 0) {
      const firstField = selectedFields[0];
      if (firstField.expression && firstField.expression !== `"${arrayField}"`) {
        // Use the actual expression (e.g., "user"."id") instead of just the alias
        fieldExpression = firstField.expression;
      } else if (hasNavigationJoins) {
        // If we have navigation joins but no explicit expression, qualify with target table
        fieldExpression = `"${targetTable}"."${arrayField}"`;
      }
    }

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);

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
  SELECT ${distinctClause}${fieldExpression} as "${arrayField}"
  FROM "${targetTable}"
  ${navJoinsSQL}
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
