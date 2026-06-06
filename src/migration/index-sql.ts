import { IndexMethod } from '../schema/table-builder';

/**
 * Shared index SQL generation + definition comparison.
 *
 * Centralizing the CREATE/DROP statement builders here guarantees that the live
 * auto-migrate path (`DbSchemaManager`) and the file scaffold (`MigrationScaffold`)
 * emit byte-for-byte identical SQL — which in turn keeps the signature comparison
 * below stable: an index this module creates always normalizes back to the same
 * signature this module derives from the model, so it is never recreated twice.
 */

/** Minimal index shape needed to render SQL — a subset of `IndexDefinition`. */
export interface IndexSqlSpec {
  name: string;
  columns: string[];
  isUnique?: boolean;
  using?: IndexMethod;
  operatorClass?: string;
  expressions?: string[];
  where?: string;
}

/**
 * Build the parenthesized column/expression list, applying the per-column
 * operator-class suffix. Mirrors the logic the ORM has always used so the
 * generated SQL — and therefore PostgreSQL's stored definition — is unchanged.
 */
export function buildIndexColumnList(spec: IndexSqlSpec): string {
  const opClassSuffix = spec.operatorClass ? ` ${spec.operatorClass}` : '';
  if (spec.expressions && spec.expressions.length > 0) {
    // Expression-based index: raw SQL expressions, no identifier quoting.
    return spec.expressions.map(expr => `${expr}${opClassSuffix}`).join(', ');
  }
  return spec.columns.map(col => `"${col}"${opClassSuffix}`).join(', ');
}

/**
 * Build a `CREATE INDEX` statement. `qualifiedTable` must already be quoted /
 * schema-qualified by the caller (e.g. `"public"."t"`).
 */
export function buildCreateIndexStatement(
  spec: IndexSqlSpec,
  qualifiedTable: string,
  opts?: { concurrent?: boolean; ifNotExists?: boolean }
): string {
  const uniqueStr = spec.isUnique ? 'UNIQUE ' : '';
  const concurrentStr = opts?.concurrent ? 'CONCURRENTLY ' : '';
  const ifNotExistsStr = opts?.ifNotExists ? 'IF NOT EXISTS ' : '';
  const usingStr = spec.using ? ` USING ${spec.using}` : '';
  const whereStr = spec.where ? ` WHERE ${spec.where}` : '';
  const columnList = buildIndexColumnList(spec);
  return `CREATE ${uniqueStr}INDEX ${concurrentStr}${ifNotExistsStr}"${spec.name}" ON ${qualifiedTable}${usingStr} (${columnList})${whereStr}`;
}

/**
 * Build a `DROP INDEX` statement. `qualifiedIndex` must already be quoted /
 * schema-qualified by the caller.
 */
export function buildDropIndexStatement(
  qualifiedIndex: string,
  opts?: { concurrent?: boolean; ifExists?: boolean }
): string {
  const concurrentStr = opts?.concurrent ? 'CONCURRENTLY ' : '';
  const ifExistsStr = opts?.ifExists ? 'IF EXISTS ' : '';
  return `DROP INDEX ${concurrentStr}${ifExistsStr}${qualifiedIndex}`;
}

// ---------------------------------------------------------------------------
// Index definition comparison
// ---------------------------------------------------------------------------

/** The comparable signature of an index, normalized for equality testing. */
export interface IndexSignature {
  isUnique: boolean;
  /** Access method, lower-cased. `undefined` model `using` is treated as btree. */
  method: string;
  /** Normalized column / expression list. */
  columns: string;
  /** Normalized partial-index predicate (empty string when none). */
  where: string;
}

/**
 * Known multi-word PostgreSQL type names, matched before the generic
 * single-identifier rule so a cast like `::timestamp with time zone` is removed
 * whole rather than leaving ` with time zone` behind to corrupt the comparison.
 */
const MULTIWORD_CAST_TYPES = [
  'character varying',
  'double precision',
  'bit varying',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
];

/**
 * Normalize an index column-list or predicate fragment so the model's intended
 * SQL and PostgreSQL's canonical `pg_get_indexdef()` form compare equal.
 *
 * The transforms, derived from observed `pg_get_indexdef(oid, 0, true)` output:
 *  - lower-case (folds keyword/identifier case: `USING`/`using`, `DESC`, ...);
 *  - strip double quotes (`"email"` -> `email`);
 *  - strip the `public.` schema prefix the ORM emits for `search_normalize`,
 *    which PostgreSQL drops because `public` is on the search_path;
 *  - strip `::type` casts that PostgreSQL injects for argument coercion
 *    (`search_normalize(email::text)` -> `search_normalize(email)`), the key to
 *    leaving `ixNormalized` indexes on varchar columns untouched;
 *  - collapse whitespace and tighten spacing around commas/parens.
 *
 * Known limitations (documented): lower-casing also folds string literals inside
 * a partial-index `WHERE`; an explicitly-specified *default* operator class is
 * hidden by PostgreSQL and would read as a difference. Both are rare and noted
 * in the migration guide.
 */
export function normalizeIndexFragment(fragment: string | undefined): string {
  if (!fragment) return '';
  let s = fragment.toLowerCase();
  s = s.replace(/"/g, '');
  s = s.replace(/public\./g, '');

  // Remove casts: `::` + (multi-word type | quoted type | identifier) + optional
  // typmod (`(255)`, `(10,2)`) + optional array suffix (`[]`, as in `::text[]`).
  const multiword = MULTIWORD_CAST_TYPES.join('|');
  const castRe = new RegExp(
    `::\\s*(?:${multiword}|[a-z_][a-z0-9_]*)(?:\\s*\\(\\s*[0-9,\\s]*\\))?(?:\\s*\\[\\s*\\])?`,
    'g'
  );
  s = s.replace(castRe, '');

  // Tighten whitespace and spacing around structural punctuation.
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/\s*,\s*/g, ', ');
  s = s.replace(/\(\s+/g, '(');
  s = s.replace(/\s+\)/g, ')');
  return s.trim();
}

/**
 * Normalize a partial-index `WHERE` predicate. Builds on
 * {@link normalizeIndexFragment} and additionally folds the rewrites PostgreSQL
 * applies to a predicate at parse-analysis time, so the model's raw predicate
 * string compares equal to the form `pg_get_indexdef` reports:
 *
 *  - `!=` → `<>`;
 *  - `LIKE`/`ILIKE`/`NOT LIKE`/`NOT ILIKE` → the `~~` / `~~*` / `!~~` / `!~~*`
 *    operators PostgreSQL stores;
 *  - `col = ANY (ARRAY[...])` ↔ `col IN (...)` (PostgreSQL rewrites `IN` lists to
 *    the `= ANY (ARRAY[...])` form — normalize both directions to `IN`);
 *  - `col BETWEEN a AND b` → `col >= a AND col <= b` (PostgreSQL's stored form).
 *
 * Not recoverable by text normalization, and therefore documented as
 * limitations (the index may be recreated once per migration): PostgreSQL
 * expands bare date/time literals to a fully-qualified `timestamptz` with the
 * server's offset, and re-parenthesizes sub-expressions by operator precedence.
 * Write such predicates in PostgreSQL's canonical form, or disable
 * `recreateChangedIndexes`, to avoid churn.
 */
export function normalizeIndexPredicate(where: string | undefined): string {
  let s = normalizeIndexFragment(where);
  if (!s) return '';

  // Operator spellings PostgreSQL canonicalizes (input already lower-cased).
  s = s.replace(/!=/g, '<>');
  s = s.replace(/\bnot\s+ilike\b/g, '!~~*');
  s = s.replace(/\bnot\s+like\b/g, '!~~');
  s = s.replace(/\bilike\b/g, '~~*');
  s = s.replace(/\blike\b/g, '~~');

  // `col = ANY (ARRAY[a, b, c])`  ->  `col in (a, b, c)`  (PG's IN-list rewrite).
  s = s.replace(/([a-z0-9_."]+)\s*=\s*any\s*\(\s*array\[([^\]]*)\]\s*\)/g, '$1 in ($2)');

  // `col BETWEEN a AND b`  ->  `col >= a AND col <= b`  (PG's stored form).
  s = s.replace(/([a-z0-9_."]+)\s+between\s+(\S+)\s+and\s+(\S+)/g, '$1 >= $2 and $1 <= $3');

  return s.replace(/\s+/g, ' ').trim();
}

/** Build the normalized signature of a model `IndexDefinition`-like object. */
export function modelIndexSignature(spec: IndexSqlSpec): IndexSignature {
  return {
    isUnique: !!spec.isUnique,
    method: (spec.using || 'btree').toLowerCase(),
    columns: normalizeIndexFragment(buildIndexColumnList(spec)),
    where: normalizeIndexPredicate(spec.where),
  };
}

/**
 * Parse PostgreSQL's canonical index definition
 * (`pg_get_indexdef(oid, 0, true)`) into a normalized signature.
 *
 * Returns `null` when the definition cannot be parsed or carries a clause the
 * model cannot express (e.g. `INCLUDE`), in which case the caller treats the
 * index as unchanged to avoid pointless rebuilds.
 */
export function parseDbIndexSignature(canonicalDef: string): IndexSignature | null {
  const head = /^CREATE (UNIQUE )?INDEX .+? ON .+? USING (\w+) \(/i.exec(canonicalDef);
  if (!head) return null;

  const isUnique = !!head[1];
  const method = head[2].toLowerCase();

  // The column list is the balanced-paren group that opens at the end of the
  // header match. Walk it so nested function-call parens don't end it early.
  const openParenIdx = head.index + head[0].length - 1;
  let depth = 0;
  let closeParenIdx = -1;
  for (let i = openParenIdx; i < canonicalDef.length; i++) {
    const ch = canonicalDef[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { closeParenIdx = i; break; }
    }
  }
  if (closeParenIdx === -1) return null;

  const columns = canonicalDef.slice(openParenIdx + 1, closeParenIdx);
  const rest = canonicalDef.slice(closeParenIdx + 1).trim();

  let where = '';
  if (rest) {
    const whereMatch = /^WHERE\s+(.*)$/is.exec(rest);
    if (whereMatch) {
      where = whereMatch[1];
    } else {
      // Trailing clause the model can't represent (INCLUDE, WITH, TABLESPACE...).
      // Be conservative: signal "unknown" so we don't rebuild on every run.
      return null;
    }
  }

  return {
    isUnique,
    method,
    columns: normalizeIndexFragment(columns),
    where: normalizeIndexPredicate(where),
  };
}

export interface IndexComparison {
  changed: boolean;
  /** Human-readable summary of what differs (for logs / scaffold comments). */
  reason?: string;
  modelSignature: IndexSignature;
  dbSignature: IndexSignature | null;
}

/**
 * Decide whether the model's index definition differs from what PostgreSQL
 * currently stores. Conservative by design: if the database definition can't be
 * parsed/compared, it reports `changed: false` so a same-named index is never
 * needlessly rebuilt.
 */
export function compareIndexDefinition(
  canonicalDbDef: string,
  spec: IndexSqlSpec
): IndexComparison {
  const modelSignature = modelIndexSignature(spec);
  const dbSignature = parseDbIndexSignature(canonicalDbDef);

  if (!dbSignature) {
    return { changed: false, modelSignature, dbSignature: null };
  }

  const diffs: string[] = [];
  if (modelSignature.isUnique !== dbSignature.isUnique) {
    diffs.push(`unique ${dbSignature.isUnique} -> ${modelSignature.isUnique}`);
  }
  if (modelSignature.method !== dbSignature.method) {
    diffs.push(`method ${dbSignature.method} -> ${modelSignature.method}`);
  }
  if (modelSignature.columns !== dbSignature.columns) {
    diffs.push(`columns (${dbSignature.columns}) -> (${modelSignature.columns})`);
  }
  if (modelSignature.where !== dbSignature.where) {
    diffs.push(`where (${dbSignature.where || 'none'}) -> (${modelSignature.where || 'none'})`);
  }

  return {
    changed: diffs.length > 0,
    reason: diffs.length > 0 ? diffs.join('; ') : undefined,
    modelSignature,
    dbSignature,
  };
}

// ---------------------------------------------------------------------------
// Authoritative comparison via PostgreSQL's own canonical form
// ---------------------------------------------------------------------------
//
// The string comparison above is a fast first pass. To be certain two index
// definitions are equivalent — without any normalization guesswork — the schema
// manager rebuilds the model index on an empty mirror table and compares
// PostgreSQL's `pg_get_indexdef()` of both sides. These helpers compare two such
// canonical defs while ignoring the parts that legitimately differ (the index
// name and the table it is on).

/**
 * Reduce a canonical `pg_get_indexdef()` string to the parts that define the
 * index's shape: its uniqueness and everything from `USING <method>` onward
 * (access method, column/expression list with operator classes, and the partial
 * predicate). The index name and table reference — which differ between the real
 * index and its temp-table rebuild — are deliberately excluded.
 */
export function indexCanonicalSignature(canonicalDef: string): { isUnique: boolean; body: string } {
  const trimmed = canonicalDef.trim();
  const isUnique = /^CREATE\s+UNIQUE\s+INDEX\b/i.test(trimmed);
  const usingIdx = trimmed.indexOf(' USING ');
  const body = (usingIdx >= 0 ? trimmed.slice(usingIdx) : trimmed)
    .replace(/\s+/g, ' ')
    .trim();
  return { isUnique, body };
}

/**
 * Whether two canonical `pg_get_indexdef()` strings describe the same index
 * shape (ignoring index name and table). Because both strings come from
 * PostgreSQL's own deparser in the same session, equivalent definitions are
 * byte-identical here — making this an exact, false-positive-free check.
 */
export function canonicalDefsEquivalent(defA: string, defB: string): boolean {
  const a = indexCanonicalSignature(defA);
  const b = indexCanonicalSignature(defB);
  return a.isUnique === b.isUnique && a.body === b.body;
}
