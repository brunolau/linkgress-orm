import { DatabaseClient } from '../../database/database-client.interface';
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
import { formatJoinValue, buildCollectionCorrelationWhere } from '../join-utils';
import { LateralSqlCache } from '../lateral-sql-cache';

/** Key-part separator: a control character no alias, column name or SQL text contains. */
const KEY_SEP = String.fromCharCode(1);

/** A column list as one key part; the one-column case (nearly every FK) needs no join allocation. */
const listKey = (list: string[] | undefined): string => (list === undefined ? '' : list.length === 1 ? list[0] : list.join(','));

/** Appends what `buildNavigationJoinsWithAlias` reads from each join, including the alias-map resolution of its source. */
const appendNavigationJoinsKey = (key: string, joins: NavigationJoin[] | undefined, aliasMap: Map<string, string> | undefined): string => {
  if (!joins) {
    return key + '-' + KEY_SEP;
  }

  key += joins.length + KEY_SEP;

  for (const join of joins) {
    key += join.alias + KEY_SEP + join.targetTable + KEY_SEP + (join.targetSchema ?? '') + KEY_SEP
      + listKey(join.foreignKeys) + KEY_SEP + listKey(join.matches) + KEY_SEP + (join.isMandatory ? 'I' : 'L') + KEY_SEP
      + join.sourceAlias + KEY_SEP + (aliasMap?.get(join.sourceAlias) ?? '') + KEY_SEP;
  }

  return key;
};

/** Appends the projection: aliases, expressions, nesting, and nested laterals by memo id (or by text when not memoised). */
const appendFieldsKey = (key: string, fields: SelectedField[]): string => {
  key += '[' + fields.length + KEY_SEP;

  for (const field of fields) {
    key += field.alias + KEY_SEP + (field.expression ?? '') + KEY_SEP + (field.isColumn === true ? 'c' : 'e') + KEY_SEP;

    if (field.nestedCteJoin) {
      key += field.nestedCteJoin.cteName + KEY_SEP + (field.nestedCteJoin.memoId ? '#' + field.nestedCteJoin.memoId : field.nestedCteJoin.joinClause) + KEY_SEP;
    }

    key = field.nested ? appendFieldsKey(key, field.nested) : key + '-' + KEY_SEP;
  }

  return key + ']' + KEY_SEP;
};

/**
 * The LateralSqlCache key of an aggregation: every input `LateralCollectionStrategy.render` and
 * its helpers read, in order — the alias inputs (counter, relation, tables), the correlation
 * columns, the clause TEXT (which already carries the `$n` placeholder numbering), the scalar
 * flags and limits, both navigation-join lists with their alias-map resolution, and the
 * projection. Parameter VALUES never enter the strategy and never enter the key. Built by plain
 * concatenation (a rope V8 flattens once, on the lookup) — cheaper than an array join.
 */
export const lateralShapeKey = (config: CollectionAggregationConfig, context: QueryContext): string => {
  const aliasMap = context.lateralTableAliasMap;
  let key = config.counter + KEY_SEP + config.relationName + KEY_SEP + config.targetTable + KEY_SEP + config.foreignKey + KEY_SEP
    + listKey(config.foreignKeys) + KEY_SEP + listKey(config.matches) + KEY_SEP + (config.foreignKeyTableAlias ?? '') + KEY_SEP
    + config.sourceTable + KEY_SEP + (aliasMap?.get(config.sourceTable) ?? '') + KEY_SEP
    + (config.whereClause ?? '') + KEY_SEP + (config.orderByClause ?? '') + KEY_SEP + (config.orderByClauseAlias ?? '') + KEY_SEP
    + (config.limitValue ?? '') + KEY_SEP + (config.offsetValue ?? '') + KEY_SEP
    + (config.isDistinct === true ? 'D' : '') + (config.isSingleResult === true ? 'S' : '') + (config.useJsonArrayAggregation === true ? 'J' : '') + KEY_SEP
    + config.aggregationType + KEY_SEP + (config.aggregateField ?? '') + KEY_SEP + (config.aggregateExpression ?? '') + KEY_SEP
    + (config.arrayField ?? '') + KEY_SEP + config.defaultValue + KEY_SEP;
  key = appendNavigationJoinsKey(key, config.navigationJoins, aliasMap);
  key = appendNavigationJoinsKey(key, config.selectorNavigationJoins, aliasMap);

  return appendFieldsKey(key, config.selectedFields);
};

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

  /**
   * Build the parent-correlation WHERE predicate for a collection LATERAL/correlated
   * subquery. Supports composite keys and constant FK predicates (literal markers
   * like `__LIT:true`). Falls back to the legacy single-column form when the
   * navigation metadata doesn't carry the array form.
   *
   * This is the load-bearing helper for the constant-FK projection fix: navigation
   * properties may declare additional literal predicates beyond the column
   * equality (e.g. `withForeignKey: [col, isCurrent], withPrincipalKey: [id, true]`)
   * that must fire on every projection. Without this helper, the strategy
   * emitted a single hard-coded `fk = sourceTable.id` clause and silently
   * dropped the literal predicate, leaking SCD2-closed rows.
   */
  private buildParentCorrelation(
    config: CollectionAggregationConfig,
    fkTableAlias: string,
    sourceAlias: string,
    foreignKey: string,
  ): string {
    if (config.foreignKeys && config.foreignKeys.length > 0) {
      const matches = config.matches && config.matches.length > 0 ? config.matches : ['id'];
      return buildCollectionCorrelationWhere(fkTableAlias, sourceAlias, config.foreignKeys, matches);
    }
    return `"${fkTableAlias}"."${foreignKey}" = "${sourceAlias}"."id"`;
  }

  buildAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext
  ): CollectionAggregationResult {
    // Memoised per shape (see LateralSqlCache): the rendering below reads nothing but the
    // config and the enclosing alias map, and mutates neither, so a hit is a pure lookup.
    if (!LateralSqlCache.isEnabled()) {
      return this.render(config, context);
    }

    const key = lateralShapeKey(config, context);
    const hit = LateralSqlCache.get(key);

    if (hit) {
      return {
        sql: hit.sql,
        params: context.allParams,
        tableName: hit.tableName,
        joinClause: hit.joinClause,
        selectExpression: hit.selectExpression,
        isCTE: false,
        memoId: hit.id,
      };
    }

    const rendered = this.render(config, context);
    const entry = LateralSqlCache.store(key, {
      sql: rendered.sql,
      joinClause: rendered.joinClause,
      selectExpression: rendered.selectExpression,
      tableName: rendered.tableName,
    });

    if (entry.id > 0) {
      rendered.memoId = entry.id;
    }

    return rendered;
  }

  /** The uncached rendering behind {@link buildAggregation}. */
  private render(
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

      case 'exists':
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
                                 config.aggregationType === 'sum' ||
                                 config.aggregationType === 'exists';

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
    const { arrayField, targetTable, foreignKey, sourceTable, whereClause, isDistinct, selectedFields, aggregationType, aggregateField, aggregateExpression, defaultValue, relationName, selectorNavigationJoins, useJsonArrayAggregation } = config;
    // json_agg keeps native arrays off the wire for drivers that cannot
    // decode binary ARRAY results (BunClient) — element values are identical
    // for the toNumberList/toStringList use-cases.
    const arrayAggFn = useJsonArrayAggregation ? 'json_agg' : 'array_agg';

    // Use a unique table alias to avoid conflicts with outer query tables
    const innerTableAlias = `${lateralAlias}_${relationName}`;

    // For correlated subqueries, we only need selector navigation joins (joins within the selector),
    // NOT the path navigation joins. Path navigation joins are part of the outer query's joins.
    const hasNavigationJoins = selectorNavigationJoins && selectorNavigationJoins.length > 0;

    // Helper to rewrite expressions that reference the collection's table to use inner alias
    const rewriteTableReference = (expression: string): string => {
      // Replace the special marker alias `"__collection_tableName__".` with `"innerTableAlias".`
      if (!expression.includes('"__collection_')) {
        return expression;  // nothing to rewrite — skip the regex pass entirely
      }
      const markerPattern = collectionMarkerPattern(targetTable, true);
      return expression.replace(markerPattern, `"${innerTableAlias}".`);
    };

    // Build navigation JOINs for multi-level navigation (selector joins only)
    const navJoinsSQL = this.buildNavigationJoinsWithAlias(selectorNavigationJoins, innerTableAlias, targetTable, context);

    // Check if the source table has been aliased by a parent LATERAL (for nested collections)
    // If so, use that alias instead of the raw table name
    const sourceTableAlias = context.lateralTableAliasMap?.get(sourceTable) || sourceTable;

    // Build WHERE clause with correlation to parent
    // For selectMany, the FK is on the intermediate table (joined via navJoins), not the target table
    const fkTableAlias = config.foreignKeyTableAlias || innerTableAlias;
    let whereSQL = this.buildParentCorrelation(config, fkTableAlias, sourceTableAlias, foreignKey);
    if (whereClause) {
      const rewrittenWhereClause = rewriteTableReference(whereClause);
      whereSQL += ` AND ${rewrittenWhereClause}`;
    }

    let subquerySQL: string;

    if (aggregationType === 'array') {
      if (!arrayField) {
        throw new Error('arrayField is required for array aggregation');
      }

      // Get the actual field expression from selectedFields (if available)
      let fieldExpression = `"${innerTableAlias}"."${arrayField}"`;
      if (selectedFields && selectedFields.length > 0) {
        const firstField = selectedFields[0];
        if (firstField.expression && firstField.expression !== `"${arrayField}"`) {
          fieldExpression = rewriteTableReference(firstField.expression);
        }
      }

      // Build correlated subquery for array aggregation
      // For DISTINCT, wrap in a subquery to allow HashAggregate instead of Sort
      // Pattern: (SELECT array_agg(x) FROM (SELECT DISTINCT x FROM ...) sub)
      // This is more efficient than array_agg(DISTINCT x) which forces a sort
      if (isDistinct) {
        subquerySQL = `(SELECT COALESCE(${arrayAggFn}("${arrayField}"), ${defaultValue})
FROM (SELECT DISTINCT ${fieldExpression} as "${arrayField}"
FROM "${targetTable}" "${innerTableAlias}"
${navJoinsSQL}
WHERE ${whereSQL}) "sq")`;
      } else {
        subquerySQL = `(SELECT COALESCE(${arrayAggFn}(${fieldExpression}), ${defaultValue})
FROM "${targetTable}" "${innerTableAlias}"
${navJoinsSQL}
WHERE ${whereSQL})`;
      }
    } else if (aggregationType === 'exists') {
      // EXISTS as correlated subquery: (SELECT EXISTS(SELECT 1 FROM ... WHERE ...))
      subquerySQL = `(SELECT EXISTS(SELECT 1
FROM "${targetTable}" "${innerTableAlias}"
${navJoinsSQL}
WHERE ${whereSQL}))`;
    } else {
      // Scalar aggregation (count, min, max, sum)
      let aggregateSql: string;
      switch (aggregationType) {
        case 'count':
          aggregateSql = 'COUNT(*)';
          break;
        case 'min':
        case 'max':
        case 'sum':
          if (aggregateExpression) {
            // Nested scalar-subquery summand (e.g. sum(row => other.count()))
            aggregateSql = `${aggregationType.toUpperCase()}(${aggregateExpression})`;
          } else if (aggregateField) {
            aggregateSql = `${aggregationType.toUpperCase()}("${innerTableAlias}"."${aggregateField}")`;
          } else {
            throw new Error(`${aggregationType.toUpperCase()} requires an aggregate field`);
          }
          break;
        default:
          throw new Error(`Unknown aggregation type: ${aggregationType}`);
      }

      // Build correlated subquery for scalar aggregation
      subquerySQL = `(SELECT COALESCE(${aggregateSql}, ${defaultValue})
FROM "${targetTable}" "${innerTableAlias}"
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
   * Rewrites the collection marker alias (`"__collection_<table>__".`) to the lateral's inner
   * alias. The regex pass runs only when the marker is present at all.
   */
  private rewriteMarker(expression: string, targetTable: string, innerTableAlias: string): string {
    if (!expression.includes('"__collection_')) {
      return expression;
    }
    return expression.replace(collectionMarkerPattern(targetTable, true), '"' + innerTableAlias + '".');
  }

  /**
   * One select-list entry for a leaf field. A bare quoted column (`"col"`, no dot, no inner
   * quote) is qualified with the inner alias; anything else has the marker rewritten and is
   * aliased unless it already renders as exactly `"<alias>"`.
   */
  private renderLeafSelect(expression: string, fullAlias: string, targetTable: string, innerTableAlias: string): string {
    const length = expression.length;
    const isSimpleColumn = length > 2
      && expression.charCodeAt(0) === 34
      && expression.charCodeAt(length - 1) === 34
      && expression.indexOf('"', 1) === length - 1
      && expression.indexOf('.') === -1;
    if (isSimpleColumn) {
      return '"' + innerTableAlias + '".' + expression + ' as "' + fullAlias + '"';
    }
    const rewritten = this.rewriteMarker(expression, targetTable, innerTableAlias);
    return rewritten === '"' + fullAlias + '"' ? rewritten : rewritten + ' as "' + fullAlias + '"';
  }

  /**
   * Renders the selected fields in ONE recursive pass: returns the `json_build_object(...)` text
   * of this level and appends the flattened inner select list and the nested lateral joins to
   * `out` (same order as the three separate walks this replaces — depth first, own join before
   * the nested ones). No intermediate arrays: the select list of a wide collection projection was
   * three allocations per field and three joins per statement.
   */
  private renderFields(fields: SelectedField[], prefix: string, targetTable: string, innerTableAlias: string, out: { select: string; joins: string }): string {
    let json = '';
    for (const field of fields) {
      const alias = field.alias;
      const fullAlias = prefix ? prefix + '__' + alias : alias;
      if (field.nestedCteJoin) {
        out.joins += (out.joins ? '\n  ' : '') + field.nestedCteJoin.joinClause;
      }
      if (field.nested) {
        const nestedJson = this.renderFields(field.nested, fullAlias, targetTable, innerTableAlias, out);
        json += (json ? ', ' : '') + "'" + alias + "', " + nestedJson;
      } else {
        json += (json ? ', ' : '') + "'" + alias + "', \"" + fullAlias + '"';
        if (field.expression) {
          out.select += (out.select ? ', ' : '') + this.renderLeafSelect(field.expression, fullAlias, targetTable, innerTableAlias);
        }
      }
    }
    return 'json_build_object(' + json + ')';
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
        onConditions.push(`${formatJoinValue(join.sourceAlias, fk)} = ${formatJoinValue(join.alias, pk)}`);
      }

      joinClauses.push(`${joinType} ${qualifiedTable} "${join.alias}" ON ${onConditions.join(' AND ')}`);
    }

    return joinClauses.join('\n  ');
  }

  /**
   * Build navigation JOINs SQL with inner table alias mapping
   * Similar to buildNavigationJoins but uses innerTableAlias for the collection's own table
   * @param navigationJoins - The navigation joins to build
   * @param innerTableAlias - The alias used for the collection's target table (e.g., "lateral_0_posts")
   * @param targetTable - Optional: the original target table name (e.g., "posts") to map to innerTableAlias
   * @param context - Optional: QueryContext containing lateralTableAliasMap for nested lateral references
   */
  private buildNavigationJoinsWithAlias(
    navigationJoins: NavigationJoin[] | undefined,
    innerTableAlias: string,
    targetTable?: string,
    context?: QueryContext,
    relationName?: string
  ): string {
    if (!navigationJoins || navigationJoins.length === 0) {
      return '';
    }

    if (relationName === undefined) {
      // `lateral_<n>_<relation>` — the relation name is everything after the second `_`
      const parts = innerTableAlias.split('_');
      relationName = parts.length >= 3 ? parts.slice(2).join('_') : innerTableAlias;
    }

    // Get the lateral table alias map from context (for nested lateral references)
    // This is used when a nested collection's selector navigation references a parent collection's table
    const lateralAliasMap = context?.lateralTableAliasMap;

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
        // Use innerTableAlias if the source alias matches the collection's target table or relation name
        // This handles the case where we've aliased the main FROM table
        let sourceAlias = join.sourceAlias;
        if (targetTable && sourceAlias === targetTable) {
          // This join's source is the current collection's table - use inner alias
          sourceAlias = innerTableAlias;
        } else if (sourceAlias === relationName) {
          sourceAlias = innerTableAlias;
        } else if (lateralAliasMap && lateralAliasMap.has(sourceAlias)) {
          // For nested collections, if the source references a parent collection's table,
          // use the parent's aliased name from the map
          sourceAlias = lateralAliasMap.get(sourceAlias)!;
        }
        onConditions.push(`${formatJoinValue(sourceAlias, fk)} = ${formatJoinValue(join.alias, pk)}`);
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
    const { selectedFields, targetTable, foreignKey, sourceTable, whereClause, orderByClause, limitValue, offsetValue, isDistinct, navigationJoins, relationName } = config;

    const innerTableAlias = `${lateralAlias}_${relationName}`;

    // Inner select list + json_build_object + nested lateral joins in one pass
    const rendered = { select: '', joins: '' };
    const jsonbObjectExpr = this.renderFields(selectedFields, '', targetTable, innerTableAlias, rendered);

    const navJoinsSQL = this.buildNavigationJoinsWithAlias(navigationJoins, innerTableAlias, targetTable, context, relationName);

    // Check if the source table has been aliased by a parent LATERAL (for nested collections)
    const effectiveSourceTable = context.lateralTableAliasMap?.get(sourceTable) || sourceTable;

    // Build WHERE clause with correlation to parent
    // For selectMany, the FK is on the intermediate table (joined via navJoins), not the target table
    const fkTableAlias = config.foreignKeyTableAlias || innerTableAlias;
    let whereSQL = `WHERE ${this.buildParentCorrelation(config, fkTableAlias, effectiveSourceTable, foreignKey)}`;
    if (whereClause) {
      whereSQL += ` AND ${this.rewriteMarker(whereClause, targetTable, innerTableAlias)}`;
    }

    let orderBySQL = '';
    if (orderByClause) {
      orderBySQL = `ORDER BY ${this.rewriteMarker(orderByClause, targetTable, innerTableAlias)}`;
    }

    let limitOffsetClause = '';
    if (limitValue !== undefined) {
      limitOffsetClause = `LIMIT ${limitValue}`;
    }
    if (offsetValue !== undefined) {
      limitOffsetClause += ` OFFSET ${offsetValue}`;
    }

    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Build LATERAL subquery
    // Structure: SELECT json_agg(json_build_object(...)) FROM (SELECT ... LIMIT/OFFSET) sub
    const lateralSQL = `
SELECT json_agg(
  ${jsonbObjectExpr}
) as data
FROM (
  SELECT ${distinctClause}${rendered.select}
  FROM "${targetTable}" "${innerTableAlias}"
  ${navJoinsSQL}
  ${rendered.joins}
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
    const { selectedFields, targetTable, foreignKey, sourceTable, whereClause, orderByClause, isDistinct, navigationJoins, relationName } = config;

    const innerTableAlias = `${lateralAlias}_${relationName}`;

    const rendered = { select: '', joins: '' };
    const jsonbObjectExpr = this.renderFields(selectedFields, '', targetTable, innerTableAlias, rendered);

    const navJoinsSQL = this.buildNavigationJoinsWithAlias(navigationJoins, innerTableAlias, targetTable, context, relationName);

    const effectiveSourceTable = context.lateralTableAliasMap?.get(sourceTable) || sourceTable;

    const fkTableAlias2 = config.foreignKeyTableAlias || innerTableAlias;
    let whereSQL = `WHERE ${this.buildParentCorrelation(config, fkTableAlias2, effectiveSourceTable, foreignKey)}`;
    if (whereClause) {
      whereSQL += ` AND ${this.rewriteMarker(whereClause, targetTable, innerTableAlias)}`;
    }

    let orderBySQL = '';
    if (orderByClause) {
      orderBySQL = `ORDER BY ${this.rewriteMarker(orderByClause, targetTable, innerTableAlias)}`;
    }

    const distinctClause = isDistinct ? 'DISTINCT ' : '';

    // Structure: SELECT json_build_object(...) FROM (SELECT ... LIMIT 1) sub
    // Returns null if no rows (LEFT JOIN LATERAL handles this)
    const lateralSQL = `
SELECT ${jsonbObjectExpr} as data
FROM (
  SELECT ${distinctClause}${rendered.select}
  FROM "${targetTable}" "${innerTableAlias}"
  ${navJoinsSQL}
  ${rendered.joins}
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
    const { arrayField, targetTable, foreignKey, sourceTable, whereClause, orderByClause, limitValue, offsetValue, isDistinct, navigationJoins, selectedFields, relationName } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    // Use a unique table alias to avoid conflicts with outer query tables
    const innerTableAlias = `${lateralAlias}_${relationName}`;

    // Helper to rewrite expressions that reference the collection's table to use inner alias
    const rewriteTableReference = (expression: string): string => {
      // Replace the special marker alias `"__collection_tableName__".` with `"innerTableAlias".`
      if (!expression.includes('"__collection_')) {
        return expression;  // nothing to rewrite — skip the regex pass entirely
      }
      const markerPattern = collectionMarkerPattern(targetTable, true);
      return expression.replace(markerPattern, `"${innerTableAlias}".`);
    };

    // Get the actual field expression from selectedFields (if available)
    // This handles navigation properties like p.user!.id which need to be "user"."id"
    let fieldExpression = `"${innerTableAlias}"."${arrayField}"`;
    if (selectedFields && selectedFields.length > 0) {
      const firstField = selectedFields[0];
      if (firstField.expression && firstField.expression !== `"${arrayField}"`) {
        // Use the actual expression, rewriting target table references
        fieldExpression = rewriteTableReference(firstField.expression);
      }
    }

    // Build navigation JOINs for multi-level navigation
    const navJoinsSQL = this.buildNavigationJoinsWithAlias(navigationJoins, innerTableAlias, targetTable, context);

    // For nested collections, the source table may be aliased in a parent LATERAL
    const effectiveSourceTable = context.lateralTableAliasMap?.get(sourceTable) || sourceTable;

    // Build WHERE clause with LATERAL correlation
    // For selectMany, the FK is on the intermediate table (joined via navJoins)
    const fkTableAlias3 = config.foreignKeyTableAlias || innerTableAlias;
    let whereSQL = `WHERE ${this.buildParentCorrelation(config, fkTableAlias3, effectiveSourceTable, foreignKey)}`;
    if (whereClause) {
      const rewrittenWhereClause = rewriteTableReference(whereClause);
      whereSQL += ` AND ${rewrittenWhereClause}`;
    }

    // Build ORDER BY clause
    let orderBySQL = '';
    if (orderByClause) {
      const rewrittenOrderBy = rewriteTableReference(orderByClause);
      orderBySQL = `ORDER BY ${rewrittenOrderBy}`;
    }

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
SELECT ${config.useJsonArrayAggregation ? 'json_agg' : 'array_agg'}(
  "${arrayField}"
) as data
FROM (
  SELECT ${distinctClause}${fieldExpression} as "${arrayField}"
  FROM "${targetTable}" "${innerTableAlias}"
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
    const { aggregationType, aggregateField, aggregateExpression: aggregateExprFromConfig, targetTable, foreignKey, sourceTable, whereClause, relationName } = config;

    // Use a unique table alias to avoid conflicts with outer query tables
    const innerTableAlias = `${lateralAlias}_${relationName}`;

    // Helper to rewrite expressions that reference the collection's table to use inner alias
    const rewriteTableReference = (expression: string): string => {
      // Replace the special marker alias `"__collection_tableName__".` with `"innerTableAlias".`
      if (!expression.includes('"__collection_')) {
        return expression;  // nothing to rewrite — skip the regex pass entirely
      }
      const markerPattern = collectionMarkerPattern(targetTable, true);
      return expression.replace(markerPattern, `"${innerTableAlias}".`);
    };

    // For nested collections, the source table may be aliased in a parent LATERAL
    const effectiveSourceTable = context.lateralTableAliasMap?.get(sourceTable) || sourceTable;

    // Build WHERE clause with LATERAL correlation
    // For selectMany, the FK is on the intermediate table (joined via navJoins)
    const fkTableAlias = config.foreignKeyTableAlias || innerTableAlias;
    let whereSQL = `WHERE ${this.buildParentCorrelation(config, fkTableAlias, effectiveSourceTable, foreignKey)}`;
    if (whereClause) {
      const rewrittenWhereClause = rewriteTableReference(whereClause);
      whereSQL += ` AND ${rewrittenWhereClause}`;
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
        if (aggregateExprFromConfig) {
          // Nested scalar-subquery summand (e.g. sum(row => other.count()))
          aggregateExpression = `${aggregationType.toUpperCase()}(${aggregateExprFromConfig})`;
        } else if (aggregateField) {
          aggregateExpression = `${aggregationType.toUpperCase()}("${innerTableAlias}"."${aggregateField}")`;
        } else {
          throw new Error(`${aggregationType.toUpperCase()} requires an aggregate field`);
        }
        break;
      case 'exists': {
        // EXISTS as LATERAL: SELECT EXISTS(SELECT 1 FROM ... WHERE ...)
        const lateralSQL = `
SELECT EXISTS(SELECT 1
FROM "${targetTable}" "${innerTableAlias}"
${whereSQL}) as data
        `.trim();
        return lateralSQL;
      }
      default:
        throw new Error(`Unknown aggregation type: ${aggregationType}`);
    }

    const lateralSQL = `
SELECT ${aggregateExpression} as data
FROM "${targetTable}" "${innerTableAlias}"
${whereSQL}
    `.trim();

    return lateralSQL;
  }
}
