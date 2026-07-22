/**
 * Shared extended-statistics SQL generation.
 *
 * Mirrors `index-sql.ts`: centralizing the CREATE/DROP builders guarantees the
 * live auto-migrate path (`DbSchemaManager`) and the file scaffold
 * (`MigrationScaffold`) emit identical statements for
 * `CREATE STATISTICS` objects (PostgreSQL extended statistics — expression
 * statistics and multivariate ndistinct/dependencies/mcv).
 *
 * Reconciliation is by NAME only (create when missing): unlike indexes,
 * PostgreSQL has no `pg_get_statisticsobjdef`-style canonical single-string
 * deparser stable enough to diff against the model, and statistics objects are
 * cheap metadata — renaming the object is the supported way to change one.
 */

/** PostgreSQL multivariate statistics kinds. */
export type StatisticsKind = 'ndistinct' | 'dependencies' | 'mcv';

/** Minimal statistics shape needed to render SQL. */
export interface StatisticsSqlSpec {
  name: string;
  /**
   * Raw SQL entries of the `ON` list, in declaration order — quoted column
   * references (`"flags"`) and/or expressions (`("flags" & 1::smallint)`).
   * PostgreSQL requires expressions to be parenthesized; the model layer is
   * responsible for providing them in that form.
   */
  expressions: string[];
  /**
   * Optional multivariate kinds. Omit for PostgreSQL's default (all kinds for
   * multi-entry lists; a SINGLE expression entry must omit kinds — PostgreSQL
   * builds univariate expression statistics for it and rejects a kinds list).
   */
  kinds?: StatisticsKind[];
}

/**
 * Build a `CREATE STATISTICS` statement. `qualifiedTable` must already be
 * quoted / schema-qualified by the caller (e.g. `"public"."t"`). The
 * statistics object itself is created with an unqualified name — PostgreSQL
 * places it in the schema of the current search_path, and the schema manager
 * resolves existence through `pg_statistic_ext` joined to the TABLE's
 * namespace, so lookups stay consistent either way.
 */
export function buildCreateStatisticsStatement(
  spec: StatisticsSqlSpec,
  qualifiedTable: string,
  opts?: { ifNotExists?: boolean }
): string {
  const ifNotExistsStr = opts?.ifNotExists ? 'IF NOT EXISTS ' : '';
  const kindsStr = spec.kinds && spec.kinds.length > 0 ? ` (${spec.kinds.join(', ')})` : '';
  return `CREATE STATISTICS ${ifNotExistsStr}"${spec.name}"${kindsStr} ON ${spec.expressions.join(', ')} FROM ${qualifiedTable}`;
}

/**
 * Build a `DROP STATISTICS` statement. `qualifiedName` must already be quoted
 * (and schema-qualified when the object lives outside the search_path).
 */
export function buildDropStatisticsStatement(
  qualifiedName: string,
  opts?: { ifExists?: boolean }
): string {
  const ifExistsStr = opts?.ifExists ? 'IF EXISTS ' : '';
  return `DROP STATISTICS ${ifExistsStr}${qualifiedName}`;
}
