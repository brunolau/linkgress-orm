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
 * CTE-based collection strategy
 *
 * This is the current/default strategy that uses PostgreSQL CTEs with json_agg
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
 *     json_agg(
 *       json_build_object('id', "id", 'title', "title")
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
export class CteCollectionStrategy implements ICollectionStrategy {
  getType(): CollectionStrategyType {
    return 'cte';
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
        if (config.isSingleResult) {
          // firstOrDefault() - return single object or null, not an array
          cteSQL = this.buildSingleJsonAggregation(config, cteName, context);
          selectExpression = `"${cteName}".data`;  // Can be null if no match
        } else {
          cteSQL = this.buildJsonbAggregation(config, cteName, context);
          selectExpression = `COALESCE("${cteName}".data, ${config.defaultValue})`;
        }
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
   * Helper to collect all leaf fields from a potentially nested structure
   * Returns array of { alias, expression } for SELECT clause (flattened with unique aliases)
   */
  private collectLeafFields(fields: SelectedField[], prefix: string = ''): Array<{ alias: string; expression: string }> {
    const result: Array<{ alias: string; expression: string }> = [];
    for (const field of fields) {
      const fullAlias = prefix ? `${prefix}__${field.alias}` : field.alias;
      if (field.nested) {
        // Recurse into nested fields
        result.push(...this.collectLeafFields(field.nested, fullAlias));
      } else if (field.expression) {
        // Leaf field
        result.push({ alias: fullAlias, expression: field.expression });
      }
    }
    return result;
  }

  /**
   * Helper to collect nested CTE joins from selected fields
   * These are joins to CTEs created for nested collections (collections within collections)
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
   * Helper to build json_build_object expression (handles nested structures)
   * Uses JSON instead of JSONB for better aggregation performance
   */
  private buildJsonbObject(fields: SelectedField[], prefix: string = ''): string {
    const parts: string[] = [];
    for (const field of fields) {
      if (field.nested) {
        // Nested object - recurse
        const nestedJsonb = this.buildJsonbObject(field.nested, prefix ? `${prefix}__${field.alias}` : field.alias);
        parts.push(`'${field.alias}', ${nestedJsonb}`);
      } else {
        // Leaf field - reference the aliased column from subquery
        const fullAlias = prefix ? `${prefix}__${field.alias}` : field.alias;
        parts.push(`'${field.alias}', "${fullAlias}"`);
      }
    }
    return `json_build_object(${parts.join(', ')})`;
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
   * Build JSONB aggregation CTE
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildJsonbAggregation(
    config: CollectionAggregationConfig,
    cteName: string,
    context: QueryContext
  ): string {
    // Note: CTE strategy does NOT use navigationJoins for intermediate correlation.
    // Unlike LATERAL, CTEs are computed independently and join to the main query via parent_id.
    // The main query handles intermediate reference joins (posts -> user),
    // and the CTE just selects from the collection table (orders) and groups by foreign key.
    // However, we DO need navigation joins that are WITHIN the collection's selector (e.g., orderTask.task.level).
    const { selectedFields, targetTable, foreignKey, whereClause, orderByClause, orderByClauseAlias, limitValue, offsetValue, isDistinct } = config;
    // For CTE, we only need navigation joins that are within the collection's selector (e.g., orderTask.task.level)
    // NOT the navigation path from outer query to this collection (e.g., post -> user -> orders)
    // Use selectorNavigationJoins which contains only the joins detected from the selector.
    const navigationJoins = config.selectorNavigationJoins;

    // Collect all leaf fields for the SELECT clause
    const leafFields = this.collectLeafFields(selectedFields);

    // Build the JSONB fields for json_build_object (handles nested structures)
    const jsonbObjectExpr = this.buildJsonbObject(selectedFields);

    // Build WHERE clause
    const whereSQL = whereClause ? `WHERE ${whereClause}` : '';

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);

    // Collect nested CTE joins (for collections within collections)
    const nestedCteJoins = this.collectNestedCteJoins(selectedFields);
    const nestedCteJoinsSQL = nestedCteJoins.length > 0 ? nestedCteJoins.join('\n  ') : '';

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      return this.buildJsonbAggregationWithRowNumber(
        config, leafFields, jsonbObjectExpr, whereSQL, distinctClause, navJoinsSQL, nestedCteJoinsSQL
      );
    }

    // No LIMIT/OFFSET - use simple aggregation
    // Build the subquery SELECT fields
    // When there are navigation joins, we need to qualify unqualified field expressions
    // with the target table name to avoid ambiguous column references
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;
    const allSelectFields = [
      `"${targetTable}"."${foreignKey}" as "__fk_${foreignKey}"`,
      ...leafFields.map(f => {
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
      }),
    ];

    // Build ORDER BY clause for subquery (uses database column names)
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : '';

    // Build the json_agg ORDER BY clause (uses aliases since it operates on subquery output)
    const jsonAggOrderBy = orderByClauseAlias ? ` ORDER BY ${orderByClauseAlias}` : '';

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  json_agg(
    ${jsonbObjectExpr}${jsonAggOrderBy}
  ) as data
FROM (
  SELECT ${distinctClause}${allSelectFields.join(', ')}
  FROM "${targetTable}"
  ${navJoinsSQL}
  ${nestedCteJoinsSQL}
  ${whereSQL}
  ${orderBySQL}
) sub
GROUP BY "__fk_${foreignKey}"
    `.trim();

    return cteSQL;
  }

  /**
   * Build single JSON object CTE (for firstOrDefault)
   * Returns a single JSON object per parent, or null if no match.
   * Uses ROW_NUMBER() to pick the first row per parent.
   *
   * SQL Pattern:
   * ```sql
   * SELECT
   *   "__fk_user_id" as parent_id,
   *   json_build_object('id', "id", 'title', "title") as data
   * FROM (
   *   SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_user_id" ORDER BY ...) as __rn
   *   FROM (SELECT ... FROM table) inner_sub
   * ) sub
   * WHERE __rn = 1
   * ```
   */
  private buildSingleJsonAggregation(
    config: CollectionAggregationConfig,
    cteName: string,
    context: QueryContext
  ): string {
    const { selectedFields, targetTable, foreignKey, whereClause, orderByClauseAlias, isDistinct } = config;
    // Use selectorNavigationJoins for CTE (not the full navigation path)
    const navigationJoins = config.selectorNavigationJoins;

    // Collect all leaf fields for the SELECT clause
    const leafFields = this.collectLeafFields(selectedFields);

    // Build the JSONB fields for json_build_object (handles nested structures)
    const jsonbObjectExpr = this.buildJsonbObject(selectedFields);

    // Build WHERE clause
    const whereSQL = whereClause ? `WHERE ${whereClause}` : '';

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);

    // Collect nested CTE joins (for collections within collections)
    const nestedCteJoins = this.collectNestedCteJoins(selectedFields);
    const nestedCteJoinsSQL = nestedCteJoins.length > 0 ? nestedCteJoins.join('\n  ') : '';

    // When there are navigation joins, we need to qualify unqualified field expressions
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // Build the innermost SELECT fields
    const innerSelectFields = [
      `"${targetTable}"."${foreignKey}" as "__fk_${foreignKey}"`,
      ...leafFields.map(f => {
        const isSimpleColumn = /^"[^".]+"$/.test(f.expression);
        if (isSimpleColumn && hasNavigationJoins) {
          const columnName = f.expression.slice(1, -1);
          return `"${targetTable}"."${columnName}" as "${f.alias}"`;
        }
        if (f.expression !== `"${f.alias}"`) {
          return `${f.expression} as "${f.alias}"`;
        }
        return f.expression;
      }),
    ];

    // Build ORDER BY for ROW_NUMBER() - use the alias clause (property names) since we're referencing aliased columns from inner_sub
    const rowNumberOrderBy = orderByClauseAlias || `"__fk_${foreignKey}"`;

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  ${jsonbObjectExpr} as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM (
    SELECT ${distinctClause}${innerSelectFields.join(', ')}
    FROM "${targetTable}"
    ${navJoinsSQL}
    ${nestedCteJoinsSQL}
    ${whereSQL}
  ) inner_sub
) sub
WHERE "__rn" = 1
    `.trim();

    return cteSQL;
  }

  /**
   * Build JSONB aggregation with ROW_NUMBER() for per-parent LIMIT/OFFSET
   *
   * SQL Pattern:
   * ```sql
   * SELECT parent_id, json_agg(json_build_object(...)) as data
   * FROM (
   *   SELECT *, ROW_NUMBER() OVER (PARTITION BY foreign_key ORDER BY ...) as __rn
   *   FROM (SELECT ... FROM table WHERE ...) inner_sub
   * ) sub
   * WHERE __rn > offset AND __rn <= offset + limit
   * GROUP BY parent_id
   * ```
   */
  private buildJsonbAggregationWithRowNumber(
    config: CollectionAggregationConfig,
    leafFields: Array<{ alias: string; expression: string }>,
    jsonbObjectExpr: string,
    whereSQL: string,
    distinctClause: string,
    navJoinsSQL: string,
    nestedCteJoinsSQL: string = ''
  ): string {
    const { targetTable, foreignKey, orderByClause, limitValue, offsetValue } = config;

    // CTE strategy uses selectorNavigationJoins for joins within the collection's selector.
    // Unlike LATERAL, CTEs don't need navigation path joins for outer query correlation.
    const navigationJoins = config.selectorNavigationJoins;
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // Build the innermost SELECT fields
    const innerSelectFields = [
      `"${targetTable}"."${foreignKey}" as "__fk_${foreignKey}"`,
      ...leafFields.map(f => {
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
      }),
    ];

    // Build ORDER BY for ROW_NUMBER() - use the order clause or default to foreign key
    const rowNumberOrderBy = orderByClause || `"__fk_${foreignKey}"`;

    // Build the row number filter condition
    const offset = offsetValue || 0;
    let rowNumberFilter: string;
    if (limitValue !== undefined) {
      // Both LIMIT and potentially OFFSET
      rowNumberFilter = `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limitValue}`;
    } else {
      // Only OFFSET (no LIMIT)
      rowNumberFilter = `WHERE "__rn" > ${offset}`;
    }

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  json_agg(
    ${jsonbObjectExpr}
  ) as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM (
    SELECT ${distinctClause}${innerSelectFields.join(', ')}
    FROM "${targetTable}"
    ${navJoinsSQL}
    ${nestedCteJoinsSQL}
    ${whereSQL}
  ) inner_sub
) sub
${rowNumberFilter}
GROUP BY "__fk_${foreignKey}"
    `.trim();

    return cteSQL;
  }

  /**
   * Build array aggregation CTE (for toNumberList/toStringList)
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildArrayAggregation(
    config: CollectionAggregationConfig,
    cteName: string,
    context: QueryContext
  ): string {
    const { arrayField, targetTable, foreignKey, whereClause, orderByClause, limitValue, offsetValue, isDistinct, selectedFields } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    // Build WHERE clause
    const whereSQL = whereClause ? `WHERE ${whereClause}` : '';

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // CTE strategy uses selectorNavigationJoins for joins within the collection's selector.
    // Unlike LATERAL, CTEs don't need navigation path joins for outer query correlation.
    const navigationJoins = config.selectorNavigationJoins;
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins, targetTable);
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      return this.buildArrayAggregationWithRowNumber(config, whereSQL, distinctClause, navJoinsSQL);
    }

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

    // No LIMIT/OFFSET - use simple aggregation
    // Build ORDER BY clause
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : '';

    // Build the array_agg ORDER BY clause
    const arrayAggOrderBy = orderByClause ? ` ORDER BY ${orderByClause}` : '';

    // Qualify the foreign key with target table when there are navigation joins
    const fkExpression = hasNavigationJoins
      ? `"${targetTable}"."${foreignKey}"`
      : `"${foreignKey}"`;

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  array_agg(
    "${arrayField}"${arrayAggOrderBy}
  ) as data
FROM (
  SELECT ${distinctClause}"__fk_${foreignKey}", "${arrayField}"
  FROM (
    SELECT ${fkExpression} as "__fk_${foreignKey}", ${fieldExpression} as "${arrayField}"
    FROM "${targetTable}"
    ${navJoinsSQL}
    ${whereSQL}
    ${orderBySQL}
  ) inner_sub
) sub
GROUP BY "__fk_${foreignKey}"
    `.trim();

    return cteSQL;
  }

  /**
   * Build array aggregation with ROW_NUMBER() for per-parent LIMIT/OFFSET
   */
  private buildArrayAggregationWithRowNumber(
    config: CollectionAggregationConfig,
    whereSQL: string,
    distinctClause: string,
    navJoinsSQL: string
  ): string {
    const { arrayField, targetTable, foreignKey, orderByClause, limitValue, offsetValue, selectedFields } = config;

    // CTE strategy uses selectorNavigationJoins for joins within the collection's selector.
    // Unlike LATERAL, CTEs don't need navigation path joins for outer query correlation.
    const navigationJoins = config.selectorNavigationJoins;
    const hasNavigationJoins = navigationJoins && navigationJoins.length > 0;

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

    // Qualify the foreign key with target table when there are navigation joins
    const fkExpression = hasNavigationJoins
      ? `"${targetTable}"."${foreignKey}"`
      : `"${foreignKey}"`;

    // Build ORDER BY for ROW_NUMBER() - use the order clause or default to foreign key
    const rowNumberOrderBy = orderByClause || `"__fk_${foreignKey}"`;

    // Build the row number filter condition
    const offset = offsetValue || 0;
    let rowNumberFilter: string;
    if (limitValue !== undefined) {
      rowNumberFilter = `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limitValue}`;
    } else {
      rowNumberFilter = `WHERE "__rn" > ${offset}`;
    }

    const cteSQL = `
SELECT
  "__fk_${foreignKey}" as parent_id,
  array_agg(
    "${arrayField}"
  ) as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM (
    SELECT ${distinctClause}${fkExpression} as "__fk_${foreignKey}", ${fieldExpression} as "${arrayField}"
    FROM "${targetTable}"
    ${navJoinsSQL}
    ${whereSQL}
  ) inner_sub
) sub
${rowNumberFilter}
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
