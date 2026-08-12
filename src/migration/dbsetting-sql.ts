/**
 * Shared database-level settings SQL generation.
 *
 * Mirrors `statistics-sql.ts` / `index-sql.ts`: centralizing the builders
 * guarantees the live auto-migrate path (`DbSchemaManager`) and the file
 * scaffold (`MigrationScaffold`) emit identical statements for
 * `model.hasDbSetting(...)` declarations.
 *
 * A database-level setting is applied with `ALTER DATABASE ... SET`, which
 * PERSISTS it in `pg_db_role_setting`: it survives restarts and every NEW
 * session on the database inherits it at connect time. It does NOT travel with
 * a plain `pg_dump`, which is exactly why the model declaration + migrator
 * reconciliation exists — a freshly created environment converges to the same
 * settings automatically.
 *
 * The statements are emitted as `DO` blocks that resolve
 * `current_database()` at RUN time, so the same SQL works in the live
 * migrator and inside a scaffolded migration file, where the target database
 * name cannot be known when the file is written. `ALTER DATABASE ... SET` is
 * transactional (unlike e.g. `... SET TABLESPACE`), so running it inside the
 * migration transaction is safe. The executing role must OWN the database (or
 * be superuser) — the same privilege `ALTER DATABASE` requires anywhere.
 *
 * Reconciliation contract (converge-only, mirroring statistics objects):
 * declared settings are applied when missing or drifted; settings the model
 * does not declare are NEVER touched, and removing a declaration leaves the
 * database value in place — `RESET` it via a hand migration when that is
 * intended.
 */

/**
 * GUC names: a core parameter (`jit`) or a two-part custom parameter
 * (`app.some_setting`). Anything else is rejected before SQL is ever built.
 */
const SETTING_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

/**
 * Dollar-quote tag of the emitted DO blocks. Values containing this exact tag
 * are rejected: PostgreSQL's dollar quoting does not respect inner single
 * quotes, so the tag inside a value would terminate the block body early.
 */
export const DB_SETTING_DOLLAR_TAG = '$lnk_dbset$';

/** Throw when `name` is not a valid core or two-part custom GUC name. */
export function assertValidDatabaseSettingName(name: string): void {
  if (!SETTING_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid database setting name "${name}" — expected a PostgreSQL configuration parameter ` +
      `("jit") or a two-part custom parameter ("app.some_setting")`
    );
  }
}

/**
 * Normalize a declared value to the string PostgreSQL stores: booleans become
 * the canonical `on`/`off`, numbers their decimal text. Strings pass through
 * verbatim (write `'32MB'`, `'off'`, `'UTC'` exactly as you would in SQL).
 */
export function normalizeDatabaseSettingValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  return String(value);
}

/** Throw when a normalized value cannot be embedded in the DO-block body. */
export function assertValidDatabaseSettingValue(value: string): void {
  if (value.includes(DB_SETTING_DOLLAR_TAG)) {
    throw new Error(
      `Invalid database setting value ${JSON.stringify(value)} — it contains the ` +
      `${DB_SETTING_DOLLAR_TAG} dollar-quote tag the migrator's DO blocks are delimited with`
    );
  }
}

/** Single-quote a literal for use INSIDE the dollar-quoted DO body. */
function quoteBodyLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the idempotent `ALTER DATABASE <current> SET name = value` DO block.
 * `name` must already be validated; `value` must already be normalized and
 * validated. `format('%L', ...)` re-quotes the value for the final statement,
 * so the body literal and the executed literal are each escaped exactly once.
 */
export function buildSetDatabaseSettingStatement(name: string, value: string): string {
  return `DO ${DB_SETTING_DOLLAR_TAG} BEGIN EXECUTE format('ALTER DATABASE %I SET %s = %L', current_database(), ${quoteBodyLiteral(name)}, ${quoteBodyLiteral(value)}); END ${DB_SETTING_DOLLAR_TAG}`;
}

/**
 * Build the reverse `ALTER DATABASE <current> RESET name` DO block (used as
 * the scaffolded down-migration; RESET of an unset parameter is a no-op).
 */
export function buildResetDatabaseSettingStatement(name: string): string {
  return `DO ${DB_SETTING_DOLLAR_TAG} BEGIN EXECUTE format('ALTER DATABASE %I RESET %s', current_database(), ${quoteBodyLiteral(name)}); END ${DB_SETTING_DOLLAR_TAG}`;
}

/**
 * Parse one `pg_db_role_setting.setconfig` entry (`'key=value'`) — the value
 * may itself contain `=`, so only the FIRST separator splits.
 */
export function parseDbRoleSettingEntry(entry: string): { name: string; value: string } | null {
  const separator = entry.indexOf('=');
  if (separator <= 0) {
    return null;
  }
  return {
    name: entry.slice(0, separator),
    value: entry.slice(separator + 1),
  };
}
