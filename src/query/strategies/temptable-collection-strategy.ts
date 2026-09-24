import { DatabaseClient } from '../../database/database-client.interface';
import {
  ICollectionStrategy,
  CollectionStrategyType,
  CollectionAggregationConfig,
  CollectionAggregationResult,
} from '../collection-strategy.interface';
import { QueryContext } from '../query-builder';
import { CteCollectionStrategy } from './cte-collection-strategy';

/**
 * Temp table-based collection strategy
 *
 * This strategy uses PostgreSQL temporary tables to store parent IDs,
 * then aggregates the related records of exactly those parents.
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
 * The aggregation itself is the CTE strategy's aggregation SELECT (see
 * CteCollectionStrategy.buildAggregationSelect) restricted to the parents in the temp table, so
 * both strategies render a collection's navigations, WHERE, ORDER BY, LIMIT / OFFSET, aggregates
 * and nested collections the same way. The temp-table strategy used to aggregate
 * `SELECT * FROM <target>` directly, which had no navigation joins at all.
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
 *   "__fk_user_id" as parent_id,
 *   json_agg(json_build_object('id', "id", 'title', "title") ORDER BY "__order_0" DESC) as data
 * FROM (
 *   SELECT "posts"."user_id" as "__fk_user_id", "id", "title", "posts"."views" as "__order_0"
 *   FROM "posts"
 *   WHERE "posts"."user_id" IN (SELECT id FROM tmp_parent_ids_0) AND "views" > $1
 * ) sub
 * GROUP BY "__fk_user_id";
 * ```
 */
export class TempTableCollectionStrategy implements ICollectionStrategy {
  private readonly aggregations = new CteCollectionStrategy();

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
    // Several rows can share one parent (a collection hanging off a navigation), and a row
    // without that navigation has none: the temp table's primary key takes each parent once
    const parentIds = [...new Set((config.parentIds ?? []).filter(id => id !== null && id !== undefined))];

    if (parentIds.length === 0) {
      // No parent IDs means we'll return empty results
      return this.buildEmptyAggregation(config);
    }

    const tempTableName = `tmp_parent_ids_${config.counter}`;
    const fkTable = config.foreignKeyTableAlias || config.targetTable;
    const multiStatement = client.supportsMultiStatementQueries();
    const aggregationSQL = this.aggregations.buildAggregationSelect(
      // The multi-statement path lists with json_agg: identical element values for the
      // toNumberList/toStringList use-cases, and it keeps native Postgres arrays off the wire —
      // Bun's SQL client cannot decode binary array results
      multiStatement && config.aggregationType === 'array' ? { ...config, useJsonArrayAggregation: true } : config,
      `"${fkTable}"."${config.foreignKey}" IN (SELECT id FROM ${tempTableName})`
    );
    // The statement's own parameters: the collection is built with its own numbering from $1
    const aggregationParams = context.allParams;

    // Check if client supports multi-statement queries for optimization
    if (multiStatement) {
      return this.buildAggregationMultiStatement(config, context, client, tempTableName, parentIds, aggregationSQL, aggregationParams);
    }

    return this.buildAggregationLegacy(config, context, client, tempTableName, parentIds, aggregationSQL, aggregationParams);
  }

  /** The SQL type of the temp table's parent id column: the parent key's own type. */
  private parentIdType(config: CollectionAggregationConfig): string {
    return config.parentKeyType ?? 'integer';
  }

  /**
   * Build aggregation using multi-statement query (single round trip)
   * Supported by postgres.js using .simple() mode — which takes no parameters, so every
   * parameter of the aggregation is written into the statement as a literal.
   */
  private async buildAggregationMultiStatement(
    config: CollectionAggregationConfig,
    context: QueryContext,
    client: DatabaseClient,
    tempTableName: string,
    parentIds: any[],
    aggregationSQL: string,
    aggregationParams: any[]
  ): Promise<CollectionAggregationResult> {
    const interpolatedSQL = TempTableCollectionStrategy.interpolateParams(aggregationSQL, aggregationParams);

    // The parent ids go in as literals too
    const valuePlaceholders = parentIds.map(id => `(${TempTableCollectionStrategy.escapeValue(id)})`).join(',');

    // Combine everything into a single multi-statement query
    const multiStatementSQL = `
-- Create temporary table for parent IDs
CREATE TEMP TABLE ${tempTableName} (
  id ${this.parentIdType(config)} PRIMARY KEY
) ON COMMIT DROP;

-- Insert parent IDs
INSERT INTO ${tempTableName} VALUES ${valuePlaceholders};

-- Query and return the data
${interpolatedSQL};

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

    // Group results by parent_id — every aggregation type returns
    // (parent_id, data) rows, aggregated server-side.
    const dataMap = new Map<any, any>();

    for (const row of result.rows) {
      dataMap.set(row.parent_id, row.data);
    }

    // Return result with fetched data
    return {
      sql: interpolatedSQL,
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
    client: DatabaseClient,
    tempTableName: string,
    parentIds: any[],
    aggregationSQL: string,
    aggregationParams: any[]
  ): Promise<CollectionAggregationResult> {
    // Create temp table (without ON COMMIT DROP to persist across queries in the same session)
    const createTableSQL = `
CREATE TEMP TABLE IF NOT EXISTS ${tempTableName} (
  id ${this.parentIdType(config)} PRIMARY KEY
)
    `.trim();

    // Use executor from context if available for query logging
    if (context.executor) {
      await context.executor.query(createTableSQL);
    } else {
      await client.query(createTableSQL);
    }

    // Insert parent IDs
    const valuePlaceholders = parentIds.map((_, idx) => `($${idx + 1})`).join(',');
    const insertSQL = `INSERT INTO ${tempTableName} VALUES ${valuePlaceholders}`;

    // Use executor from context if available for query logging
    if (context.executor) {
      await context.executor.query(insertSQL, parentIds);
    } else {
      await client.query(insertSQL, parentIds);
    }

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
   * Writes every `$n` placeholder of `sql` as the literal of `params[n - 1]`, for a statement run
   * without parameters (the simple protocol). What PostgreSQL itself would not read as a placeholder
   * is copied verbatim: quoted literals and identifiers, dollar-quoted strings (`$$…$$`,
   * `$tag$…$tag$`), `--` and `/* … *\/` comments, and a `$` inside an identifier (`col$1`). `$12` is
   * one placeholder, not `$1` followed by `2`.
   */
  static interpolateParams(sql: string, params: readonly any[]): string {
    if (params.length === 0) {
      return sql;
    }

    let out = '';
    let i = 0;

    while (i < sql.length) {
      const char = sql[i];

      if (char === '-' && sql[i + 1] === '-') {
        // A line comment: up to the end of the line
        const newline = sql.indexOf('\n', i);
        const end = newline === -1 ? sql.length : newline;
        out += sql.slice(i, end);
        i = end;
        continue;
      }

      if (char === '/' && sql[i + 1] === '*') {
        // A block comment — they nest in PostgreSQL
        let depth = 1;
        let end = i + 2;

        while (end < sql.length && depth > 0) {
          if (sql[end] === '/' && sql[end + 1] === '*') {
            depth++;
            end += 2;
          } else if (sql[end] === '*' && sql[end + 1] === '/') {
            depth--;
            end += 2;
          } else {
            end++;
          }
        }

        out += sql.slice(i, end);
        i = end;
        continue;
      }

      if (char === '$' && i > 0 && TempTableCollectionStrategy.isIdentifierChar(sql[i - 1])) {
        // Part of an identifier (`col$1`), not a placeholder or a dollar quote
        out += char;
        i++;
        continue;
      }

      if (char === '$' && !/[0-9]/.test(sql[i + 1] ?? '')) {
        // A dollar-quoted string: `$tag$` up to the next `$tag$`
        const opener = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));

        if (opener !== null) {
          const close = sql.indexOf(opener[0], i + opener[0].length);
          const end = close === -1 ? sql.length : close + opener[0].length;
          out += sql.slice(i, end);
          i = end;
          continue;
        }
      }

      if (char === "'" || char === '"') {
        // A quoted literal / identifier: up to its closing quote ('' / "" escape the quote; an
        // E'…' string also escapes it with a backslash)
        const escapeString = char === "'" && i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e');
        let end = i + 1;

        while (end < sql.length) {
          if (escapeString && sql[end] === '\\') {
            end += 2;
            continue;
          }

          if (sql[end] === char) {
            if (sql[end + 1] === char) {
              end += 2;
              continue;
            }

            break;
          }

          end++;
        }

        out += sql.slice(i, end + 1);
        i = end + 1;
        continue;
      }

      if (char === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
        let end = i + 1;

        while (end < sql.length && /[0-9]/.test(sql[end])) {
          end++;
        }

        const index = Number(sql.slice(i + 1, end)) - 1;

        if (index < 0 || index >= params.length) {
          throw new Error(`The temp-table aggregation refers to parameter $${index + 1}, but it has ${params.length}.`);
        }

        out += TempTableCollectionStrategy.escapeValue(params[index]);
        i = end;
        continue;
      }

      out += char;
      i++;
    }

    return out;
  }

  /** Whether `char` can continue an identifier (a `$` right after one is part of it). */
  private static isIdentifierChar(char: string): boolean {
    return /[A-Za-z0-9_$\u0080-￿]/.test(char);
  }

  /**
   * A string literal of `text`. Quotes are doubled; a text with a backslash is written as an
   * `E'…'` string with its backslashes doubled too — a plain `'…'` string reads a backslash as an
   * escape when `standard_conforming_strings` is off, and `E'…'` reads it the same way under both.
   */
  private static quoteString(text: string): string {
    const quoted = text.replace(/'/g, "''");

    return text.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
  }

  /**
   * Safely escape a value for SQL interpolation
   * Used only in multi-statement queries with .simple() mode
   */
  static escapeValue(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        // NaN / ±Infinity have no numeric literal: the quoted forms convert by context
        return `'${Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'}'`;
      }

      // Parenthesized when negative: `a-$1` must not become the comment `a--1`
      return value < 0 ? `(${String(value)})` : String(value);
    }

    if (typeof value === 'bigint') {
      return value < 0n ? `(${String(value)})` : String(value);
    }

    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }

    if (typeof value === 'string') {
      return TempTableCollectionStrategy.quoteString(value);
    }

    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }

    if (Array.isArray(value)) {
      // A PostgreSQL array literal ('{1,2}' / '{"a","b"}'), cast by the statement's own `::type[]`
      const elements = value.map(element => {
        if (element === null || element === undefined) {
          return 'NULL';
        }

        if (typeof element === 'number' || typeof element === 'bigint' || typeof element === 'boolean') {
          return String(element);
        }

        return `"${String(element instanceof Date ? element.toISOString() : element).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      });

      return TempTableCollectionStrategy.quoteString(`{${elements.join(',')}}`);
    }

    // For objects etc., convert to JSON string
    return TempTableCollectionStrategy.quoteString(JSON.stringify(value));
  }

  /**
   * Build aggregation for when there are no parent IDs
   */
  private buildEmptyAggregation(config: CollectionAggregationConfig): CollectionAggregationResult {
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
}
