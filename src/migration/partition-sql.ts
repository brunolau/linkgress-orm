import type { PartitioningConfig } from '../schema/table-builder';

/**
 * Build the `PARTITION BY <STRATEGY> (<key>)` clause appended after a CREATE
 * TABLE's column list to declare a partitioned (parent) table.
 *
 * - Column-based: `PARTITION BY RANGE ("created_at")`
 * - Expression-based: `PARTITION BY RANGE (date_trunc('month', created_at))`
 */
export function buildPartitionByClause(config: PartitioningConfig): string {
  const strategy = config.strategy.toUpperCase(); // RANGE | LIST | HASH
  const expr = config.expression?.trim();
  const key = expr && expr.length > 0
    ? expr
    : (config.columns || []).map(c => `"${c}"`).join(', ');

  if (!key) {
    throw new Error(`Partitioning for strategy ${strategy} has no key — provide columns or an expression.`);
  }
  return `PARTITION BY ${strategy} (${key})`;
}

/**
 * Validate the PostgreSQL rule that a partitioned table's PRIMARY KEY (and any
 * UNIQUE constraint) must include every partition-key column. Throws a
 * descriptive error before the (otherwise cryptic) database error.
 *
 * Only checked for column-based partitioning when a primary key exists;
 * expression-based keys cannot be validated here.
 *
 * @param pkColumnNames Unquoted database column names that form the primary key.
 */
export function validatePartitioningPrimaryKey(
  config: PartitioningConfig,
  pkColumnNames: string[],
  tableName: string
): void {
  // No PK → no constraint to satisfy. Expression keys → can't introspect columns.
  if (config.expression || !config.columns || config.columns.length === 0 || pkColumnNames.length === 0) {
    return;
  }

  const pkSet = new Set(pkColumnNames);
  const missing = config.columns.filter(col => !pkSet.has(col));
  if (missing.length > 0) {
    throw new Error(
      `Partitioned table "${tableName}" cannot be created: its PRIMARY KEY does not include partition-key column(s) ` +
      `${missing.map(c => `"${c}"`).join(', ')}. PostgreSQL requires every partition-key column to be part of the ` +
      `PRIMARY KEY / UNIQUE constraints — add ${missing.map(c => `"${c}"`).join(', ')} to the primary key.`
    );
  }
}
