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
 * Temp table-based collection strategy
 *
 * This strategy uses PostgreSQL temporary tables to store parent IDs,
 * then JOINs against them to aggregate related records.
 *
 * Benefits:
 * - Better performance for large datasets
 * - Indexed temp table JOIN can be faster than CTE
 * - More control over query plan
 *
 * Trade-offs:
 * - Requires two round trips (get parent IDs, then aggregate)
 * - Needs temp table management
 * - Transaction-scoped temp tables
 *
 * SQL Pattern:
 * ```sql
 * CREATE TEMP TABLE tmp_parent_ids_0 (
 *   id integer PRIMARY KEY
 * ) ON COMMIT DROP;
 *
 * INSERT INTO tmp_parent_ids_0 VALUES (1),(2),(3);
 *
 * SELECT
 *   t.id as parent_id,
 *   json_agg(
 *     json_build_object('id', p.id, 'title', p.title)
 *     ORDER BY p.views DESC
 *   ) as data
 * FROM tmp_parent_ids_0 t
 * LEFT JOIN posts p ON p.user_id = t.id AND p.views > $1
 * GROUP BY t.id;
 * ```
 */
export class TempTableCollectionStrategy implements ICollectionStrategy {
  getType(): CollectionStrategyType {
    return 'temptable';
  }

  requiresParentIds(): boolean {
    // Temp table strategy requires parent IDs to be fetched first
    return true;
  }

  async buildAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext,
    client: DatabaseClient
  ): Promise<CollectionAggregationResult> {
    if (!config.parentIds || config.parentIds.length === 0) {
      // No parent IDs means we'll return empty results
      // We can still create an empty temp table for consistency
      return this.buildEmptyAggregation(config, context);
    }

    // Check if client supports multi-statement queries for optimization
    if (client.supportsMultiStatementQueries()) {
      return this.buildAggregationMultiStatement(config, context, client);
    } else {
      return this.buildAggregationLegacy(config, context, client);
    }
  }

  /**
   * Build aggregation using multi-statement query (single round trip)
   * Supported by postgres.js using .simple() mode
   *
   * For JSONB/array collections: fetches raw rows and groups in JavaScript (fast!)
   * For scalar aggregations: uses database aggregation (necessary)
   */
  private async buildAggregationMultiStatement(
    config: CollectionAggregationConfig,
    context: QueryContext,
    client: DatabaseClient
  ): Promise<CollectionAggregationResult> {
    const tempTableName = `tmp_parent_ids_${config.counter}`;

    // Build aggregation SQL with WHERE parameters interpolated
    const aggregationSQL = this.buildAggregationSQLWithInterpolatedParams(config, tempTableName);

    // Build the value placeholders for INSERT (interpolate integer parent IDs - safe)
    const valuePlaceholders = config.parentIds!.map(id => `(${id})`).join(',');

    // Determine if we're doing client-side grouping (JSONB/array) or server-side (scalar)
    const isClientSideGrouping = config.aggregationType === 'jsonb' || config.aggregationType === 'array';

    // Combine everything into a single multi-statement query
    const multiStatementSQL = `
-- Create temporary table for parent IDs
CREATE TEMP TABLE ${tempTableName} (
  id integer PRIMARY KEY
) ON COMMIT DROP;

-- Insert parent IDs
INSERT INTO ${tempTableName} VALUES ${valuePlaceholders};

-- Query and return the data
${aggregationSQL};

-- Cleanup
DROP TABLE IF EXISTS ${tempTableName};
    `.trim();

    // Execute multi-statement query using querySimple (no parameters)
    const executor = context.executor || client;

    // Use querySimple if available (for proper logging)
    let result;
    if ('querySimple' in executor && typeof (executor as any).querySimple === 'function') {
      // Use querySimple for true single round-trip execution with logging
      result = await (executor as any).querySimple(multiStatementSQL);
    } else if ('querySimple' in client && typeof (client as any).querySimple === 'function') {
      // Fallback: call client directly (no logging)
      result = await (client as any).querySimple(multiStatementSQL);
    } else {
      // Final fallback: regular query
      result = await executor.query(multiStatementSQL, []);
    }

    // Group results by parent_id
    const dataMap = new Map<number, any>();

    if (isClientSideGrouping) {
      // Client-side grouping for JSONB/array - much faster than json_agg!
      if (config.aggregationType === 'jsonb') {
        // Group rows by parent_id and build objects
        for (const row of result.rows) {
          const parentId = row.parent_id;
          if (!dataMap.has(parentId)) {
            dataMap.set(parentId, []);
          }

          // Extract the actual data (everything except parent_id)
          const { parent_id, ...rowData } = row;
          dataMap.get(parentId)!.push(rowData);
        }
      } else if (config.aggregationType === 'array') {
        // Group rows by parent_id and extract array field
        const arrayField = config.arrayField!;
        for (const row of result.rows) {
          const parentId = row.parent_id;
          if (!dataMap.has(parentId)) {
            dataMap.set(parentId, []);
          }
          dataMap.get(parentId)!.push(row[arrayField]);
        }
      }
    } else {
      // Server-side aggregation (scalar) - data already aggregated
      for (const row of result.rows) {
        dataMap.set(row.parent_id, row.data);
      }
    }

    // Return result with fetched data
    return {
      sql: aggregationSQL,
      params: [], // Params already used in execution
      tableName: `${tempTableName}_result`,
      joinClause: '', // Not needed - data already fetched
      selectExpression: '', // Not needed - data already fetched
      isCTE: false,
      dataFetched: true,
      data: dataMap,
    };
  }

  /**
   * Build aggregation using legacy approach (multiple queries)
   * Used for clients that don't support multi-statement queries
   */
  private async buildAggregationLegacy(
    config: CollectionAggregationConfig,
    context: QueryContext,
    client: DatabaseClient
  ): Promise<CollectionAggregationResult> {
    const tempTableName = `tmp_parent_ids_${config.counter}`;

    // Create temp table (without ON COMMIT DROP to persist across queries in the same session)
    const createTableSQL = `
CREATE TEMP TABLE IF NOT EXISTS ${tempTableName} (
  id integer PRIMARY KEY
)
    `.trim();

    // Use executor from context if available for query logging
    if (context.executor) {
      await context.executor.query(createTableSQL);
    } else {
      await client.query(createTableSQL);
    }

    // Insert parent IDs
    const valuePlaceholders = config.parentIds!.map((_, idx) => `($${idx + 1})`).join(',');
    const insertSQL = `INSERT INTO ${tempTableName} VALUES ${valuePlaceholders}`;

    // Use executor from context if available for query logging
    if (context.executor) {
      await context.executor.query(insertSQL, config.parentIds);
    } else {
      await client.query(insertSQL, config.parentIds);
    }

    // Renumber parameters in whereClause to start from $1 for this standalone query
    // The config.whereClause may have placeholders like $5, $6 from the global context,
    // but since we're executing as a separate query, we need $1, $2, etc.
    const renumberedConfig = this.renumberWhereParams(config);

    // Build aggregation query based on type
    const aggregationSQL = this.buildAggregationSQLByType(renumberedConfig, tempTableName);
    const aggregationParams: any[] = renumberedConfig.whereParams || [];
    const selectExpression = `"${tempTableName}_agg".data`;

    // Execute aggregation query and store results in another temp table
    const aggTempTableName = `${tempTableName}_agg`;
    const createAggTableSQL = `
CREATE TEMP TABLE ${aggTempTableName} AS
${aggregationSQL}
    `.trim();

    // Use executor from context if available for query logging
    if (context.executor) {
      await context.executor.query(createAggTableSQL, aggregationParams);
    } else {
      await client.query(createAggTableSQL, aggregationParams);
    }

    // Cleanup SQL
    const cleanupSQL = `DROP TABLE IF EXISTS ${tempTableName}, ${aggTempTableName}`;

    return {
      sql: aggregationSQL,
      params: [], // Params already used in execution
      tableName: aggTempTableName,
      joinClause: `LEFT JOIN "${aggTempTableName}" ON "${config.sourceTable}"."id" = "${aggTempTableName}".parent_id`,
      selectExpression: `COALESCE(${selectExpression}, ${config.defaultValue})`,
      isCTE: false, // Not a CTE - already executed
      cleanupSql: cleanupSQL,
    };
  }

  /**
   * Renumber parameter placeholders in whereClause to start from $1
   * This is needed because the whereClause is built with global param numbering,
   * but the legacy strategy executes it as a standalone query.
   */
  private renumberWhereParams(config: CollectionAggregationConfig): CollectionAggregationConfig {
    if (!config.whereClause || !config.whereParams || config.whereParams.length === 0) {
      return config;
    }

    // Find all $N placeholders and renumber them starting from $1
    let newWhereClause = config.whereClause;
    const paramRegex = /\$(\d+)/g;
    const matches = [...config.whereClause.matchAll(paramRegex)];

    if (matches.length === 0) {
      return config;
    }

    // Get the original parameter numbers in order of appearance
    const originalNumbers = matches.map(m => parseInt(m[1], 10));

    // Create a mapping from original number to new number (1-based)
    const numberMap = new Map<number, number>();
    let newIndex = 1;
    for (const origNum of originalNumbers) {
      if (!numberMap.has(origNum)) {
        numberMap.set(origNum, newIndex++);
      }
    }

    // Replace all placeholders with their new numbers
    newWhereClause = config.whereClause.replace(paramRegex, (_, num) => {
      const newNum = numberMap.get(parseInt(num, 10));
      return `$${newNum}`;
    });

    return {
      ...config,
      whereClause: newWhereClause,
    };
  }

  /**
   * Build aggregation SQL based on aggregation type
   */
  private buildAggregationSQLByType(
    config: CollectionAggregationConfig,
    tempTableName: string
  ): string {
    switch (config.aggregationType) {
      case 'jsonb':
        return this.buildJsonbAggregationSQL(config, tempTableName);

      case 'array':
        return this.buildArrayAggregationSQL(config, tempTableName);

      case 'count':
      case 'min':
      case 'max':
      case 'sum':
        return this.buildScalarAggregationSQL(config, tempTableName);

      default:
        throw new Error(`Unknown aggregation type: ${config.aggregationType}`);
    }
  }

  /**
   * Build aggregation SQL with WHERE parameters interpolated
   * Used for multi-statement queries with .simple() mode
   *
   * For JSONB/array aggregations, this returns a simple SELECT without aggregation
   * so we can group in JavaScript (much faster than json_agg)
   */
  private buildAggregationSQLWithInterpolatedParams(
    config: CollectionAggregationConfig,
    tempTableName: string
  ): string {
    // Clone config and interpolate WHERE parameters
    const configWithInterpolatedParams = { ...config };

    if (config.whereClause && config.whereParams && config.whereParams.length > 0) {
      // Replace $1, $2, etc. with actual values
      let interpolatedWhere = config.whereClause;
      config.whereParams.forEach((param, idx) => {
        const placeholder = `$${idx + 1}`;
        const value = this.escapeValue(param);
        interpolatedWhere = interpolatedWhere.replace(placeholder, value);
      });
      configWithInterpolatedParams.whereClause = interpolatedWhere;
      configWithInterpolatedParams.whereParams = []; // Clear params since they're now interpolated
    }

    // For multi-statement optimization: use simple SELECT instead of aggregation
    // This allows us to group in JavaScript which is much faster than json_agg
    switch (config.aggregationType) {
      case 'jsonb':
      case 'array':
        return this.buildSimpleSelectSQL(configWithInterpolatedParams, tempTableName);

      case 'count':
      case 'min':
      case 'max':
      case 'sum':
        // Scalar aggregations still need database aggregation
        return this.buildScalarAggregationSQL(configWithInterpolatedParams, tempTableName);

      default:
        throw new Error(`Unknown aggregation type: ${config.aggregationType}`);
    }
  }

  /**
   * Build a simple SELECT query without aggregation
   * Results will be grouped in JavaScript for better performance
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildSimpleSelectSQL(
    config: CollectionAggregationConfig,
    tempTableName: string
  ): string {
    const { selectedFields, targetTable, foreignKey, whereClause, orderByClause, limitValue, offsetValue } = config;

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

    const leafFields = collectLeafFields(selectedFields);

    // Build SELECT fields
    const selectFields = leafFields
      .map(f => `${f.expression} as "${f.alias}"`)
      .join(', ');

    // Build WHERE clause
    const additionalWhere = whereClause ? ` AND ${whereClause}` : '';

    // Build ORDER BY clause
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : `ORDER BY "id" DESC`;

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      return this.buildSimpleSelectSQLWithRowNumber(
        config, tempTableName, selectFields, additionalWhere, orderBySQL
      );
    }

    // No LIMIT/OFFSET - use simple SELECT
    const sql = `
SELECT
  "${foreignKey}" as parent_id,
  ${selectFields}
FROM "${targetTable}"
WHERE "${foreignKey}" IN (SELECT id FROM ${tempTableName})${additionalWhere}
${orderBySQL}
    `.trim();

    return sql;
  }

  /**
   * Build simple SELECT with ROW_NUMBER() for per-parent LIMIT/OFFSET
   */
  private buildSimpleSelectSQLWithRowNumber(
    config: CollectionAggregationConfig,
    tempTableName: string,
    selectFields: string,
    additionalWhere: string,
    orderBySQL: string
  ): string {
    const { targetTable, foreignKey, orderByClause, limitValue, offsetValue } = config;

    // Build ORDER BY for ROW_NUMBER() - use the order clause or default to id DESC
    const rowNumberOrderBy = orderByClause || `"id" DESC`;

    // Build the row number filter condition
    const offset = offsetValue || 0;
    let rowNumberFilter: string;
    if (limitValue !== undefined) {
      rowNumberFilter = `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limitValue}`;
    } else {
      rowNumberFilter = `WHERE "__rn" > ${offset}`;
    }

    const sql = `
SELECT
  parent_id,
  ${selectFields.split(', ').map(f => {
    // Extract just the alias part for outer select
    const match = f.match(/as "([^"]+)"$/);
    return match ? `"${match[1]}"` : f;
  }).join(', ')}
FROM (
  SELECT
    "${foreignKey}" as parent_id,
    ${selectFields},
    ROW_NUMBER() OVER (PARTITION BY "${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM "${targetTable}"
  WHERE "${foreignKey}" IN (SELECT id FROM ${tempTableName})${additionalWhere}
) sub
${rowNumberFilter}
${orderBySQL.replace(/ORDER BY/i, 'ORDER BY')}
    `.trim();

    return sql;
  }

  /**
   * Safely escape a value for SQL interpolation
   * Used only in multi-statement queries with .simple() mode
   */
  private escapeValue(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'number') {
      return String(value);
    }

    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }

    if (typeof value === 'string') {
      // Escape single quotes by doubling them (PostgreSQL standard)
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }

    // For arrays, objects, etc., convert to JSON string
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }

  /**
   * Build aggregation for when there are no parent IDs
   */
  private buildEmptyAggregation(
    config: CollectionAggregationConfig,
    context: QueryContext
  ): CollectionAggregationResult {
    // Return a result that will always give empty/default values
    const dummyTableName = `empty_agg_${config.counter}`;

    return {
      sql: '',
      params: [],
      tableName: dummyTableName,
      joinClause: '', // No join needed
      selectExpression: config.defaultValue, // Just use default value
      isCTE: false,
    };
  }

  /**
   * Build JSONB aggregation using temp table
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildJsonbAggregationSQL(
    config: CollectionAggregationConfig,
    tempTableName: string
  ): string {
    const { selectedFields, targetTable, foreignKey, whereClause, orderByClause, limitValue, offsetValue, isDistinct } = config;

    // Helper to build json_build_object expression (handles nested structures)
    const buildJsonbObject = (fields: SelectedField[], prefix: string = '', tableAlias: string = 't'): string => {
      const parts: string[] = [];
      for (const field of fields) {
        if (field.nested) {
          // Nested object - recurse
          const nestedJsonb = buildJsonbObject(field.nested, prefix ? `${prefix}__${field.alias}` : field.alias, tableAlias);
          parts.push(`'${field.alias}', ${nestedJsonb}`);
        } else if (field.expression) {
          // Leaf field - reference the column via table alias
          parts.push(`'${field.alias}', ${tableAlias}.${field.expression}`);
        }
      }
      return `json_build_object(${parts.join(', ')})`;
    };

    // Build the JSONB fields for json_build_object (handles nested structures)
    const jsonbObjectExpr = buildJsonbObject(selectedFields);

    // Build WHERE clause (combine temp table join with additional filters)
    const additionalWhere = whereClause ? ` AND ${whereClause}` : '';

    // Build ORDER BY clause (use primary key DESC as default for consistent ordering matching JSONB)
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : `ORDER BY "id" DESC`;

    // Build json_agg ORDER BY clause
    const jsonbAggOrderBy = orderByClause ? ` ORDER BY ${orderByClause}` : '';

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      return this.buildJsonbAggregationSQLWithRowNumber(
        config, tempTableName, jsonbObjectExpr, additionalWhere
      );
    }

    // No LIMIT/OFFSET - use simple aggregation
    const sql = `
SELECT
  t."${foreignKey}" as parent_id,
  json_agg(
    ${jsonbObjectExpr}${jsonbAggOrderBy}
  ) as data
FROM (
  SELECT *
  FROM "${targetTable}"
  WHERE "${foreignKey}" IN (SELECT id FROM ${tempTableName})${additionalWhere}
  ${orderBySQL}
) t
GROUP BY t."${foreignKey}"
    `.trim();

    return sql;
  }

  /**
   * Build JSONB aggregation with ROW_NUMBER() for per-parent LIMIT/OFFSET
   */
  private buildJsonbAggregationSQLWithRowNumber(
    config: CollectionAggregationConfig,
    tempTableName: string,
    jsonbObjectExpr: string,
    additionalWhere: string
  ): string {
    const { targetTable, foreignKey, orderByClause, limitValue, offsetValue } = config;

    // Build ORDER BY for ROW_NUMBER() - use the order clause or default to id DESC
    const rowNumberOrderBy = orderByClause || `"id" DESC`;

    // Build the row number filter condition
    const offset = offsetValue || 0;
    let rowNumberFilter: string;
    if (limitValue !== undefined) {
      rowNumberFilter = `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limitValue}`;
    } else {
      rowNumberFilter = `WHERE "__rn" > ${offset}`;
    }

    const sql = `
SELECT
  t."${foreignKey}" as parent_id,
  json_agg(
    ${jsonbObjectExpr}
  ) as data
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY "${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM "${targetTable}"
  WHERE "${foreignKey}" IN (SELECT id FROM ${tempTableName})${additionalWhere}
) t
${rowNumberFilter}
GROUP BY t."${foreignKey}"
    `.trim();

    return sql;
  }

  /**
   * Build array aggregation using temp table
   *
   * When LIMIT/OFFSET is specified, uses ROW_NUMBER() window function to correctly
   * apply pagination per parent row (not globally).
   */
  private buildArrayAggregationSQL(
    config: CollectionAggregationConfig,
    tempTableName: string
  ): string {
    const { arrayField, targetTable, foreignKey, whereClause, orderByClause, limitValue, offsetValue } = config;

    if (!arrayField) {
      throw new Error('arrayField is required for array aggregation');
    }

    // Build WHERE clause
    const additionalWhere = whereClause ? ` AND ${whereClause}` : '';

    // Build ORDER BY clause (use primary key DESC as default for consistent ordering matching JSONB)
    const orderBySQL = orderByClause ? `ORDER BY ${orderByClause}` : `ORDER BY "id" DESC`;

    // Build array_agg ORDER BY clause
    const arrayAggOrderBy = orderByClause ? ` ORDER BY ${orderByClause}` : '';

    // If LIMIT or OFFSET is specified, use ROW_NUMBER() for per-parent pagination
    if (limitValue !== undefined || offsetValue !== undefined) {
      return this.buildArrayAggregationSQLWithRowNumber(
        config, tempTableName, additionalWhere
      );
    }

    // No LIMIT/OFFSET - use simple aggregation
    const sql = `
SELECT
  t."${foreignKey}" as parent_id,
  array_agg(t."${arrayField}"${arrayAggOrderBy}) as data
FROM (
  SELECT "${foreignKey}", "${arrayField}"
  FROM "${targetTable}"
  WHERE "${foreignKey}" IN (SELECT id FROM ${tempTableName})${additionalWhere}
  ${orderBySQL}
) t
GROUP BY t."${foreignKey}"
    `.trim();

    return sql;
  }

  /**
   * Build array aggregation with ROW_NUMBER() for per-parent LIMIT/OFFSET
   */
  private buildArrayAggregationSQLWithRowNumber(
    config: CollectionAggregationConfig,
    tempTableName: string,
    additionalWhere: string
  ): string {
    const { arrayField, targetTable, foreignKey, orderByClause, limitValue, offsetValue } = config;

    // Build ORDER BY for ROW_NUMBER() - use the order clause or default to id DESC
    const rowNumberOrderBy = orderByClause || `"id" DESC`;

    // Build the row number filter condition
    const offset = offsetValue || 0;
    let rowNumberFilter: string;
    if (limitValue !== undefined) {
      rowNumberFilter = `WHERE "__rn" > ${offset} AND "__rn" <= ${offset + limitValue}`;
    } else {
      rowNumberFilter = `WHERE "__rn" > ${offset}`;
    }

    const sql = `
SELECT
  t."${foreignKey}" as parent_id,
  array_agg(t."${arrayField}") as data
FROM (
  SELECT "${foreignKey}", "${arrayField}", ROW_NUMBER() OVER (PARTITION BY "${foreignKey}" ORDER BY ${rowNumberOrderBy}) as "__rn"
  FROM "${targetTable}"
  WHERE "${foreignKey}" IN (SELECT id FROM ${tempTableName})${additionalWhere}
) t
${rowNumberFilter}
GROUP BY t."${foreignKey}"
    `.trim();

    return sql;
  }

  /**
   * Build scalar aggregation using temp table
   */
  private buildScalarAggregationSQL(
    config: CollectionAggregationConfig,
    tempTableName: string
  ): string {
    const { aggregationType, aggregateField, targetTable, foreignKey, whereClause } = config;

    // Build WHERE clause
    const additionalWhere = whereClause ? ` AND ${whereClause}` : '';

    // Build aggregation expression
    // Use targetTable as alias to match field references in whereClause
    let aggregateExpression: string;
    switch (aggregationType) {
      case 'count':
        // Count only rows where there's an actual join match (not the temp table row)
        aggregateExpression = `COUNT("${targetTable}"."${foreignKey}")`;
        break;
      case 'min':
      case 'max':
      case 'sum':
        if (!aggregateField) {
          throw new Error(`${aggregationType.toUpperCase()} requires an aggregate field`);
        }
        aggregateExpression = `${aggregationType.toUpperCase()}("${targetTable}"."${aggregateField}")`;
        break;
      default:
        throw new Error(`Unknown aggregation type: ${aggregationType}`);
    }

    const sql = `
SELECT
  tmp.id as parent_id,
  COALESCE(${aggregateExpression}, ${config.defaultValue}) as data
FROM ${tempTableName} tmp
LEFT JOIN "${targetTable}" ON "${targetTable}"."${foreignKey}" = tmp.id${additionalWhere}
GROUP BY tmp.id
    `.trim();

    return sql;
  }
}
