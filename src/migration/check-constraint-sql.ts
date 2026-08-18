/**
 * Shared CHECK-constraint SQL generation.
 *
 * Mirrors `statistics-sql.ts`: centralizing the ADD/DROP builders guarantees
 * the live auto-migrate path (`DbSchemaManager`) and the file scaffold
 * (`MigrationScaffold`) emit identical statements for table CHECK constraints
 * (`ALTER TABLE … ADD CONSTRAINT … CHECK (…)`).
 *
 * Reconciliation is by NAME only (create when missing): PostgreSQL normalizes
 * a stored check expression (`pg_get_constraintdef`) far away from the
 * author's spelling — casts, parenthesization, casing — so definition diffing
 * would either thrash or need a mirror-table confirmation pass like indexes
 * have. Constraints are cheap metadata; renaming the constraint is the
 * supported way to change one.
 *
 * PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, so the manager guards the
 * ADD with a `pg_constraint` existence lookup instead.
 */

/** Minimal check-constraint shape needed to render SQL. */
export interface CheckConstraintSqlSpec {
  name: string;
  /**
   * Raw SQL boolean expression of the constraint body — the contents of the
   * `CHECK (…)` parentheses, e.g. `"cashback_id" IS NULL OR
   * "cashback_product_id" IS NOT NULL`. Column references must use quoted
   * DATABASE column names (same convention as partial-index `where` clauses).
   */
  expression: string;
}

/**
 * Build an `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` statement.
 * `qualifiedTable` must already be quoted / schema-qualified by the caller
 * (e.g. `"public"."t"`). Existing rows are validated by PostgreSQL as part of
 * the ALTER — a table holding violating rows fails the statement loudly, so
 * data backfills must run before the constraint is introduced.
 */
export function buildAddCheckConstraintStatement(
  spec: CheckConstraintSqlSpec,
  qualifiedTable: string
): string {
  return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT "${spec.name}" CHECK (${spec.expression})`;
}

/**
 * Build an `ALTER TABLE … DROP CONSTRAINT` statement. `qualifiedTable` must
 * already be quoted / schema-qualified by the caller.
 */
export function buildDropCheckConstraintStatement(
  qualifiedTable: string,
  constraintName: string,
  opts?: { ifExists?: boolean }
): string {
  const ifExistsStr = opts?.ifExists ? 'IF EXISTS ' : '';
  return `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT ${ifExistsStr}"${constraintName}"`;
}
