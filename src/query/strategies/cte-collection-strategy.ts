import { collectionMarkerPattern } from '../query-utils';
import {
  ICollectionStrategy,
  CollectionStrategyType,
  CollectionAggregationConfig,
  CollectionAggregationResult,
  SelectedField,
  NavigationJoin,
} from '../collection-strategy.interface';
import { QueryContext } from '../query-builder';
import { formatJoinValue, buildLiteralOnlyPredicates, quoteTableReference } from '../join-utils';

/** A column of an aggregation's inner SELECT output: its alias and the (qualified) expression it selects. */
interface OutputColumn {
  alias: string;
  expression: string;
}

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
 *     "__fk_user_id" as parent_id,
 *     json_agg(
 *       json_build_object('id', "id", 'title', "title")
 *       ORDER BY "__order_0" DESC
 *     ) as data
 *   FROM (
 *     SELECT "posts"."user_id" as "__fk_user_id", "id", "title", "posts"."views" as "__order_0"
 *     FROM "posts"
 *     WHERE "views" > $1
 *   ) sub
 *   GROUP BY "__fk_user_id"
 * )
 * SELECT ... COALESCE("cte_0".data, '[]'::jsonb) as "posts" ...
 * ```
 *
 * The aggregation SELECT itself — `(parent_id, data)` rows — is also what the temp-table strategy
 * runs, restricted to its parent ids (see {@link buildAggregationSelect}).
 */
export class CteCollectionStrategy implements ICollectionStrategy {
  getType(): CollectionStrategyType {
    return 'cte';
  }

  requiresParentIds(): boolean {
    // JSONB strategy doesn't need parent IDs upfront - it aggregates for all parents
    return false;
  }

  /**
   * Compose a final WHERE clause for a CTE inner SELECT by AND-ing the user's
   * existing where clause with any literal FK predicates declared on the
   * navigation (e.g. SCD2 `is_current = TRUE` from a
   * `withForeignKey: [col, isCurrent] / withPrincipalKey: [id, true]` shape),
   * and with `parentFilter` when the caller restricts the parents (temp table).
   *
   * Without this, the CTE strategy groups every target row by FK column with no
   * filtering, leaking historical / closed SCD2 rows into the projected
   * collection — the exact constant-FK projection symptom.
   *
   * @param config              The aggregation config (carries `foreignKeys`/`matches`).
   * @param targetTable         Alias of the target table inside the CTE's inner SELECT.
   * @param rewrittenWhereClause User's whereClause already rewritten for collection markers.
   * @param parentFilter        An extra predicate restricting the rows to some parents.
   */
  private composeInnerWhere(
    config: CollectionAggregationConfig,
    targetTable: string,
    rewrittenWhereClause: string | undefined,
    parentFilter?: string,
  ): string {
    const literalPreds = buildLiteralOnlyPredicates(targetTable, config.foreignKeys, config.matches);
    const parts: string[] = [];
    if (parentFilter) {
      parts.push(parentFilter);
    }
    if (literalPreds.length > 0) {
      parts.push(...literalPreds);
    }
    if (rewrittenWhereClause) {
      parts.push(rewrittenWhereClause);
    }
    return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
  }

  buildAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext
  ): CollectionAggregationResult {
    const cteName = `cte_${config.counter}`;
    const cteSQL = this.buildAggregationSelect(config);
    const selectExpression = config.aggregationType === 'jsonb' && config.isSingleResult
      ? `"${cteName}".data`  // firstOrDefault(): a single object, or null when nothing matches
      : `COALESCE("${cteName}".data, ${config.defaultValue})`;

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
   * The SELECT aggregating the collection per parent: `(parent_id, data)` rows, where `parent_id`
   * is the collection's foreign-key value and `data` the list / object / scalar of that parent.
   * `parentFilter` restricts the collection's rows (the temp-table strategy passes its
   * `fk IN (SELECT id FROM <temp table>)`).
   */
  buildAggregationSelect(config: CollectionAggregationConfig, parentFilter?: string): string {
    switch (config.aggregationType) {
      case 'jsonb':
        return config.isSingleResult
          ? this.buildSingleJsonAggregation(config, parentFilter)
          : this.buildJsonbAggregation(config, parentFilter);

      case 'array':
        return this.buildArrayAggregation(config, parentFilter);

      case 'count':
      case 'min':
      case 'max':
      case 'sum':
        return this.buildScalarAggregation(config, parentFilter);

      case 'exists':
        return this.buildExistsAggregation(config, parentFilter);

      default:
        throw new Error(`Unknown aggregation type: ${config.aggregationType}`);
    }
  }

  /**
   * The collection's table as the FROM item, schema-qualified when it lives outside the default
   * schema. It stays unaliased, so its columns are still referenced as `"<targetTable>"."<column>"`.
   */
  private fromTable(config: CollectionAggregationConfig): string {
    return quoteTableReference(config.targetTable, config.targetSchema);
  }

  /**
   * Rewrites the collection marker alias to the target table's name: the CTE selects FROM the
   * table itself, unaliased.
   */
  private rewriteCollectionMarker(expr: string, targetTable: string): string;
  private rewriteCollectionMarker(expr: string | undefined, targetTable: string): string | undefined;
  private rewriteCollectionMarker(expr: string | undefined, targetTable: string): string | undefined {
    if (!expr) return expr;
    const markerPattern = collectionMarkerPattern(targetTable, false);
    return expr.replace(markerPattern, `"${targetTable}"`);
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
  private buildNavigationJoins(navigationJoins: NavigationJoin[] | undefined): string {
    if (!navigationJoins || navigationJoins.length === 0) {
      return '';
    }

    const joinClauses: string[] = [];

    for (const join of navigationJoins) {
      const joinType = join.isMandatory ? 'INNER JOIN' : 'LEFT JOIN';
      const qualifiedTable = quoteTableReference(join.targetTable, join.targetSchema);

      // Build the ON clause
      // foreignKeys are the columns in the source table
      // matches are the columns in the target table (usually primary keys)
      const onConditions: string[] = [];
      for (let i = 0; i < join.foreignKeys.length; i++) {
        const fk = join.foreignKeys[i];
        const pk = join.matches[i] || 'id';
        onConditions.push(`${formatJoinValue(join.sourceAlias, fk)} = ${formatJoinValue(join.alias, pk)}`);
      }

      joinClauses.push(`${joinType} ${qualifiedTable} "${join.alias}" ON ${onConditions.join(' AND ')}`);
    }

    return joinClauses.join('\n  ');
  }

  /**
   * One inner-SELECT entry for a leaf field. When the collection joins navigations, a bare column
   * (`"id"`) is qualified with the target table — a joined table may have a column of that name.
   */
  private renderLeafSelect(expression: string, alias: string, targetTable: string, hasNavigationJoins: boolean): string {
    const rewrittenExpr = this.rewriteCollectionMarker(expression, targetTable);
    const isSimpleColumn = /^"[^".]+"$/.test(rewrittenExpr);
    if (isSimpleColumn && hasNavigationJoins) {
      return `"${targetTable}".${rewrittenExpr} as "${alias}"`;
    }
    if (rewrittenExpr !== `"${alias}"`) {
      return `${rewrittenExpr} as "${alias}"`;
    }
    return rewrittenExpr;
  }

  /** A leaf's expression, qualified the way an ORDER BY key's expression is (see orderOverOutput). */
  private qualifiedOutputExpression(expression: string, targetTable: string): string {
    const rewrittenExpr = this.rewriteCollectionMarker(expression, targetTable);

    return /^"[^".]+"$/.test(rewrittenExpr) ? `"${targetTable}".${rewrittenExpr}` : rewrittenExpr;
  }

  /**
   * The ORDER BY of an aggregate that reads an inner SELECT's OUTPUT (`json_agg(… ORDER BY …)`,
   * `ROW_NUMBER() OVER (… ORDER BY …)`): each key becomes the output column carrying it — a
   * projected field selecting the very same expression, or a hidden `"__order_<i>"` column, whose
   * select entry is appended to `hidden`. Keys that are not selected used to be named here by their
   * column name, which that output does not have.
   *
   * A DISTINCT inner SELECT cannot take a hidden column: it would join the de-duplication and
   * return rows the distinct list does not have. Ordering it by a value it does not select has no
   * single answer, which PostgreSQL refuses for a DISTINCT select as well.
   */
  private orderOverOutput(
    config: CollectionAggregationConfig,
    output: OutputColumn[],
  ): { keys: string[]; hidden: string[] } {
    const keys: string[] = [];
    const hidden: string[] = [];

    for (const [index, key] of (config.orderByFields ?? []).entries()) {
      const expression = this.rewriteCollectionMarker(key.expression, config.targetTable);
      const projected = output.find(column => this.qualifiedOutputExpression(column.expression, config.targetTable) === expression);

      if (projected !== undefined) {
        keys.push(`"${projected.alias}" ${key.direction}`);
        continue;
      }

      if (config.isDistinct) {
        throw new Error(
          `The distinct collection "${config.relationName}" is ordered by ${key.expression.replace(`"__collection_${config.targetTable}__".`, '')}, `
          + 'which it does not select: a distinct collection can only be ordered by values it selects.'
        );
      }

      hidden.push(`${expression} as "__order_${index}"`);
      keys.push(`"__order_${index}" ${key.direction}`);
    }

    return { keys, hidden };
  }

  /** The ORDER BY keys over the collection's FROM itself (a window in the same SELECT as the joins). */
  private orderOverFrom(config: CollectionAggregationConfig): string | undefined {
    const keys = config.orderByFields ?? [];

    return keys.length === 0
      ? undefined
      : keys.map(key => `${this.rewriteCollectionMarker(key.expression, config.targetTable)} ${key.direction}`).join(', ');
  }

  /** The foreign-key column, qualified when a joined table could carry a column of the same name. */
  private foreignKeyRef(config: CollectionAggregationConfig, hasNavigationJoins: boolean): string {
    const { foreignKeyTableAlias, targetTable, foreignKey } = config;

    if (foreignKeyTableAlias) {
      return `"${foreignKeyTableAlias}"."${foreignKey}"`;
    }

    return hasNavigationJoins ? `"${targetTable}"."${foreignKey}"` : `"${foreignKey}"`;
  }

  /** `WHERE "__rn" > <offset> [AND "__rn" <= <offset + limit>]`. */
  private rowNumberFilter(limitValue: number | undefined, offsetValue: number | undefined): string {
    const offset = offsetValue || 0;

    return limitValue !== undefined
      ? `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limitValue}`
      : `WHERE "__rn" > ${offset}`;
  }

  /**
   * Build JSONB aggregation CTE
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildJsonbAggregation(config: CollectionAggregationConfig, parentFilter?: string): string {
    // Note: CTE strategy does NOT use navigationJoins for intermediate correlation.
    // Unlike LATERAL, CTEs are computed independently and join to the main query via parent_id.
    // The main query handles intermediate reference joins (posts -> user),
    // and the CTE just selects from the collection table (orders) and groups by foreign key.
    // However, we DO need navigation joins that are WITHIN the collection's selector (e.g., orderTask.task.level).
    const { selectedFields, targetTable, foreignKey, whereClause, limitValue, offsetValue, isDistinct } = config;
    // For CTE, we only need navigation joins that are within the collection's selector (e.g., orderTask.task.level)
    // NOT the navigation path from outer query to this collection (e.g., post -> user -> orders)
    // Use selectorNavigationJoins which contains only the joins detected from the selector.
    const navigationJoins = config.selectorNavigationJoins;
    const hasNavigationJoins = !!navigationJoins && navigationJoins.length > 0;

    // Collect all leaf fields for the SELECT clause
    const leafFields = this.collectLeafFields(selectedFields);

    // Build the JSONB fields for json_build_object (handles nested structures)
    const jsonbObjectExpr = this.buildJsonbObject(selectedFields);

    // Build WHERE clause (rewrite collection markers; AND with any literal
    // FK predicates declared on the navigation — e.g. SCD2 `is_current = TRUE`).
    const whereSQL = this.composeInnerWhere(config, targetTable, this.rewriteCollectionMarker(whereClause, targetTable), parentFilter);

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins);

    // Collect nested CTE joins (for collections within collections)
    const nestedCteJoins = this.collectNestedCteJoins(selectedFields);
    const nestedCteJoinsSQL = nestedCteJoins.length > 0 ? nestedCteJoins.join('\n  ') : '';

    // The ORDER BY keys, as columns of the inner SELECT's output
    const order = this.orderOverOutput(config, leafFields);

    // Qualify FK with the appropriate table (foreignKeyTableAlias for selectMany, or targetTable)
    const fkTable = config.foreignKeyTableAlias || targetTable;
    const innerSelectFields = [
      `"${fkTable}"."${foreignKey}" as "__fk_${foreignKey}"`,
      ...leafFields.map(f => this.renderLeafSelect(f.expression, f.alias, targetTable, hasNavigationJoins)),
      ...order.hidden,
    ];

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      const rowNumberOrderBy = order.keys.length > 0 ? order.keys.join(', ') : `"__fk_${foreignKey}"`;

      return `
SELECT
  "__fk_${foreignKey}" as parent_id,
  json_agg(
    ${jsonbObjectExpr} ORDER BY "__rn"
  ) as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM (
    SELECT ${distinctClause}${innerSelectFields.join(', ')}
    FROM ${this.fromTable(config)}
    ${navJoinsSQL}
    ${nestedCteJoinsSQL}
    ${whereSQL}
  ) inner_sub
) sub
${this.rowNumberFilter(limitValue, offsetValue)}
GROUP BY "__fk_${foreignKey}"
      `.trim();
    }

    // The json_agg ORDER BY reads the subquery's output columns (the subquery itself no longer
    // sorts: without a LIMIT its order is not what json_agg aggregates in; the empty line keeps the
    // statement text of an unordered collection what it always was)
    const jsonAggOrderBy = order.keys.length > 0 ? ` ORDER BY ${order.keys.join(', ')}` : '';

    return `
SELECT
  "__fk_${foreignKey}" as parent_id,
  json_agg(
    ${jsonbObjectExpr}${jsonAggOrderBy}
  ) as data
FROM (
  SELECT ${distinctClause}${innerSelectFields.join(', ')}
  FROM ${this.fromTable(config)}
  ${navJoinsSQL}
  ${nestedCteJoinsSQL}
  ${whereSQL}
  ${''}
) sub
GROUP BY "__fk_${foreignKey}"
    `.trim();
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
  private buildSingleJsonAggregation(config: CollectionAggregationConfig, parentFilter?: string): string {
    const { selectedFields, targetTable, foreignKey, whereClause, isDistinct } = config;
    // Use selectorNavigationJoins for CTE (not the full navigation path)
    const navigationJoins = config.selectorNavigationJoins;
    const hasNavigationJoins = !!navigationJoins && navigationJoins.length > 0;

    // Collect all leaf fields for the SELECT clause
    const leafFields = this.collectLeafFields(selectedFields);

    // Build the JSONB fields for json_build_object (handles nested structures)
    const jsonbObjectExpr = this.buildJsonbObject(selectedFields);

    // Build WHERE clause (rewrite collection markers; AND with any literal
    // FK predicates declared on the navigation — e.g. SCD2 `is_current = TRUE`).
    const whereSQL = this.composeInnerWhere(config, targetTable, this.rewriteCollectionMarker(whereClause, targetTable), parentFilter);

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins);

    // Collect nested CTE joins (for collections within collections)
    const nestedCteJoins = this.collectNestedCteJoins(selectedFields);
    const nestedCteJoinsSQL = nestedCteJoins.length > 0 ? nestedCteJoins.join('\n  ') : '';

    // The ORDER BY keys picking the first row, as columns of the inner SELECT's output
    const order = this.orderOverOutput(config, leafFields);

    // Qualify FK with the appropriate table (foreignKeyTableAlias for selectMany, or targetTable)
    const fkTable = config.foreignKeyTableAlias || targetTable;

    // Build the innermost SELECT fields
    const innerSelectFields = [
      `"${fkTable}"."${foreignKey}" as "__fk_${foreignKey}"`,
      ...leafFields.map(f => this.renderLeafSelect(f.expression, f.alias, targetTable, hasNavigationJoins)),
      ...order.hidden,
    ];

    const rowNumberOrderBy = order.keys.length > 0 ? order.keys.join(', ') : `"__fk_${foreignKey}"`;

    return `
SELECT
  "__fk_${foreignKey}" as parent_id,
  ${jsonbObjectExpr} as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM (
    SELECT ${distinctClause}${innerSelectFields.join(', ')}
    FROM ${this.fromTable(config)}
    ${navJoinsSQL}
    ${nestedCteJoinsSQL}
    ${whereSQL}
  ) inner_sub
) sub
WHERE "__rn" = 1
    `.trim();
  }

  /**
   * Build array aggregation CTE (for toNumberList/toStringList)
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildArrayAggregation(config: CollectionAggregationConfig, parentFilter?: string): string {
    const { arrayField, targetTable, foreignKey, whereClause, limitValue, offsetValue, isDistinct, selectedFields, foreignKeyTableAlias } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    // Build WHERE clause (rewrite collection markers; AND with any literal
    // FK predicates declared on the navigation — e.g. SCD2 `is_current = TRUE`).
    const whereSQL = this.composeInnerWhere(config, targetTable, this.rewriteCollectionMarker(whereClause, targetTable), parentFilter);

    // Build DISTINCT clause
    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // CTE strategy uses selectorNavigationJoins for joins within the collection's selector.
    // Unlike LATERAL, CTEs don't need navigation path joins for outer query correlation.
    const navigationJoins = config.selectorNavigationJoins;
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins);
    const hasNavigationJoins = !!navigationJoins && navigationJoins.length > 0;

    // Get the actual field expression from selectedFields (if available)
    // This handles navigation properties like p.user!.id which need to be "user"."id"
    let fieldExpression = `"${arrayField}"`;
    if (selectedFields && selectedFields.length > 0) {
      const firstField = selectedFields[0];
      if (firstField.expression && firstField.expression !== `"${arrayField}"`) {
        // Use the actual expression (e.g., "user"."id") instead of just the alias
        fieldExpression = this.rewriteCollectionMarker(firstField.expression, targetTable);
      } else if (hasNavigationJoins) {
        // If we have navigation joins but no explicit expression, qualify with target table
        fieldExpression = `"${targetTable}"."${arrayField}"`;
      }
    }

    // Qualify FK with the appropriate table (foreignKeyTableAlias for selectMany, or targetTable for nav joins, or unqualified)
    const fkTable = foreignKeyTableAlias || targetTable;
    const fkExpression = (foreignKeyTableAlias || hasNavigationJoins)
      ? `"${fkTable}"."${foreignKey}"`
      : `"${foreignKey}"`;

    // The ORDER BY keys, as columns of the inner SELECT's output: the listed value itself, or hidden
    const order = this.orderOverOutput(config, [{ alias: arrayField, expression: fieldExpression }]);
    const hiddenAliases = order.hidden.map(entry => entry.slice(entry.lastIndexOf(' as ') + 4));
    const aggFn = config.useJsonArrayAggregation ? 'json_agg' : 'array_agg';
    const innerSelect = [
      `${fkExpression} as "__fk_${foreignKey}"`,
      `${fieldExpression} as "${arrayField}"`,
      ...order.hidden,
    ].join(', ');

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      const rowNumberOrderBy = order.keys.length > 0 ? order.keys.join(', ') : `"__fk_${foreignKey}"`;

      return `
SELECT
  "__fk_${foreignKey}" as parent_id,
  ${aggFn}(
    "${arrayField}" ORDER BY "__rn"
  ) as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "__fk_${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM (
    SELECT ${distinctClause}${innerSelect}
    FROM ${this.fromTable(config)}
    ${navJoinsSQL}
    ${whereSQL}
  ) inner_sub
) sub
${this.rowNumberFilter(limitValue, offsetValue)}
GROUP BY "__fk_${foreignKey}"
      `.trim();
    }

    // The aggregate's ORDER BY reads the subquery's output columns
    const aggOrderBy = order.keys.length > 0 ? ` ORDER BY ${order.keys.join(', ')}` : '';

    return `
SELECT
  "__fk_${foreignKey}" as parent_id,
  ${aggFn}(
    "${arrayField}"${aggOrderBy}
  ) as data
FROM (
  SELECT ${distinctClause}${[`"__fk_${foreignKey}"`, `"${arrayField}"`, ...hiddenAliases].join(', ')}
  FROM (
    SELECT ${innerSelect}
    FROM ${this.fromTable(config)}
    ${navJoinsSQL}
    ${whereSQL}
    ${''}
  ) inner_sub
) sub
GROUP BY "__fk_${foreignKey}"
    `.trim();
  }

  /**
   * Build scalar aggregation CTE (COUNT, MIN, MAX, SUM). With a LIMIT and/or OFFSET the aggregate
   * runs over the rows the ordered, limited collection yields per parent (`.limit(2).count()` counts
   * at most two rows) — ranked with ROW_NUMBER() like the list forms; both used to be ignored.
   */
  private buildScalarAggregation(config: CollectionAggregationConfig, parentFilter?: string): string {
    const { aggregationType, aggregateField, aggregateExpression: aggregateExprFromConfig, targetTable, whereClause, limitValue, offsetValue } = config;
    const navigationJoins = config.selectorNavigationJoins;
    const hasNavigationJoins = !!navigationJoins && navigationJoins.length > 0;

    // Build WHERE clause (rewrite collection markers; AND with any literal
    // FK predicates declared on the navigation — e.g. SCD2 `is_current = TRUE`).
    const whereSQL = this.composeInnerWhere(config, targetTable, this.rewriteCollectionMarker(whereClause, targetTable), parentFilter);

    // Build navigation JOINs (needed for selectMany which joins through intermediate table)
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins);

    // Qualify FK with the appropriate table (foreignKeyTableAlias for selectMany, the target table
    // next to joined navigations, else unqualified)
    const fkRef = this.foreignKeyRef(config, hasNavigationJoins);

    // The aggregated value
    let valueExpression: string | undefined;
    switch (aggregationType) {
      case 'count':
        break;
      case 'min':
      case 'max':
      case 'sum':
        if (aggregateExprFromConfig) {
          // Nested scalar-subquery summand (e.g. sum(row => other.count())), or a navigation column
          valueExpression = this.rewriteCollectionMarker(aggregateExprFromConfig, targetTable);
        } else if (aggregateField) {
          valueExpression = hasNavigationJoins ? `"${targetTable}"."${aggregateField}"` : `"${aggregateField}"`;
        } else {
          throw new Error(`${aggregationType.toUpperCase()} requires an aggregate field`);
        }
        break;
      default:
        throw new Error(`Unknown aggregation type: ${aggregationType}`);
    }

    if (limitValue !== undefined || offsetValue !== undefined) {
      const aggregate = valueExpression === undefined ? 'COUNT(*)' : `${aggregationType.toUpperCase()}("__value")`;
      const valueColumn = valueExpression === undefined ? '' : `, ${valueExpression} as "__value"`;

      return `
SELECT
  "__fk" as parent_id,
  ${aggregate} as data
FROM (
  SELECT ${fkRef} as "__fk"${valueColumn}, ROW_NUMBER() OVER (PARTITION BY ${fkRef} ORDER BY ${this.orderOverFrom(config) ?? fkRef}) as "__rn"
  FROM ${this.fromTable(config)}
  ${navJoinsSQL}
  ${whereSQL}
) sub
${this.rowNumberFilter(limitValue, offsetValue)}
GROUP BY "__fk"
      `.trim();
    }

    const aggregateExpression = valueExpression === undefined ? 'COUNT(*)' : `${aggregationType.toUpperCase()}(${valueExpression})`;

    return `
SELECT
  ${fkRef} as parent_id,
  ${aggregateExpression} as data
FROM ${this.fromTable(config)}
${navJoinsSQL}
${whereSQL}
GROUP BY ${fkRef}
    `.trim();
  }

  /**
   * Build EXISTS aggregation CTE
   * Returns true for each parent that has at least one child row (after its OFFSET, if any)
   */
  private buildExistsAggregation(config: CollectionAggregationConfig, parentFilter?: string): string {
    const { targetTable, whereClause, limitValue, offsetValue } = config;
    const navigationJoins = config.selectorNavigationJoins;
    const hasNavigationJoins = !!navigationJoins && navigationJoins.length > 0;

    // Build WHERE clause (rewrite collection markers; AND with any literal
    // FK predicates declared on the navigation — e.g. SCD2 `is_current = TRUE`).
    const whereSQL = this.composeInnerWhere(config, targetTable, this.rewriteCollectionMarker(whereClause, targetTable), parentFilter);

    // Build navigation JOINs (needed for selectMany which joins through intermediate table)
    const navJoinsSQL = this.buildNavigationJoins(navigationJoins);

    // Qualify FK with the appropriate table (foreignKeyTableAlias for selectMany, or targetTable)
    const fkRef = this.foreignKeyRef(config, hasNavigationJoins);

    if (offsetValue !== undefined && offsetValue > 0 || limitValue === 0) {
      // Only rows past the offset (and within a limit) count
      return `
SELECT
  "__fk" as parent_id,
  true as data
FROM (
  SELECT ${fkRef} as "__fk", ROW_NUMBER() OVER (PARTITION BY ${fkRef} ORDER BY ${this.orderOverFrom(config) ?? fkRef}) as "__rn"
  FROM ${this.fromTable(config)}
  ${navJoinsSQL}
  ${whereSQL}
) sub
${this.rowNumberFilter(limitValue, offsetValue)}
GROUP BY "__fk"
      `.trim();
    }

    return `
SELECT
  ${fkRef} as parent_id,
  true as data
FROM ${this.fromTable(config)}
${navJoinsSQL}
${whereSQL}
GROUP BY ${fkRef}
    `.trim();
  }
}
