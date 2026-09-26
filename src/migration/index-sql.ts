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
  /**
   * Opt-in `NULLS NOT DISTINCT` for a UNIQUE index (PostgreSQL 15+): treat NULLs
   * as equal so at most one row may have NULL in the indexed column(s). Only
   * meaningful on unique indexes — PostgreSQL rejects it on non-unique ones, so
   * the SQL builder emits the clause only when `isUnique` is also set.
   */
  nullsNotDistinct?: boolean;
  /**
   * Non-key (covering) columns, rendered as `INCLUDE (...)` after the key list.
   * They are stored in the index but are not part of its key: not searchable or
   * sortable through it and not part of a UNIQUE check. Plain column names only.
   */
  include?: string[];
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
 * Build the `INCLUDE` column list (quoted, comma-separated), or an empty string
 * when the index has no covering columns. Shared by the SQL builder and the
 * model signature so the two can never disagree about it.
 */
export function buildIndexIncludeList(spec: IndexSqlSpec): string {
  return (spec.include ?? []).map(col => `"${col}"`).join(', ');
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
  // PostgreSQL grammar: `(cols) [INCLUDE ...] [NULLS NOT DISTINCT] [WITH ...] [WHERE ...]`.
  const includeList = buildIndexIncludeList(spec);
  const includeStr = includeList ? ` INCLUDE (${includeList})` : '';
  // Emit only on UNIQUE indexes — PostgreSQL rejects `NULLS NOT DISTINCT` on a
  // non-unique index, so the `isUnique` guard keeps the statement valid even if a
  // model sets the flag without `.isUnique()`.
  const nullsNotDistinctStr = spec.isUnique && spec.nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';
  const whereStr = spec.where ? ` WHERE ${spec.where}` : '';
  const columnList = buildIndexColumnList(spec);
  return `CREATE ${uniqueStr}INDEX ${concurrentStr}${ifNotExistsStr}"${spec.name}" ON ${qualifiedTable}${usingStr} (${columnList})${includeStr}${nullsNotDistinctStr}${whereStr}`;
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
  /** Normalized `INCLUDE` (covering) column list (empty string when none). */
  include: string;
  /** Normalized partial-index predicate (empty string when none). */
  where: string;
  /**
   * Whether the (unique) index treats NULLs as equal (`NULLS NOT DISTINCT`).
   * Always `false` for a non-unique index, mirroring what PostgreSQL can store.
   */
  nullsNotDistinct: boolean;
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

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * The index just past the quoted literal or identifier that starts at `start`: `'…'` (a doubled `''`
 * inside), `E'…'` (backslash escapes too — `start` is the quote, the `E` precedes it), `"…"` (a doubled
 * `""` inside). An unterminated one runs to the end of the text.
 */
function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  const escapes = quote === "'" && start > 0 && (text[start - 1] === 'E' || text[start - 1] === 'e')
    && (start < 2 || !IDENTIFIER_CHAR.test(text[start - 2]));

  for (let i = start + 1; i < text.length; i++) {
    if (escapes && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i++;
        continue;
      }
      return i + 1;
    }
  }

  return text.length;
}

/**
 * Index of the `)` that closes the `(` at `openParenIdx`, or -1 when the group is unbalanced — nested
 * groups and the parentheses inside quoted literals and identifiers skipped.
 * @internal
 */
export function closingParenOutsideQuotes(text: string, openParenIdx: number): number {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(text, i) - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Keywords that may precede a parenthesis without making a function call (`NOT (…)`, `ARRAY(…)`, `ROW(…)`).
 * `CAST(…)` is one too: PostgreSQL's `looks_like_function` is false for an explicit cast, so `pg_get_indexdef`
 * prints a cast element parenthesised (`((code)::text)`). (`TREAT(x AS t)` is not: it is parsed as the call
 * `t(x)` and printed bare.)
 */
const NON_CALL_KEYWORDS = new Set(['not', 'exists', 'array', 'row', 'any', 'all', 'some', 'distinct', 'case', 'interval', 'and', 'or', 'cast']);

/**
 * Whether an expression's text is ONE function call spanning all of it (`lower("name")`,
 * `"substring"(…)`, `public.f(…)`) or ONE balanced parenthesised group — an index element PostgreSQL
 * accepts without parentheses of its own, and the spelling `pg_get_indexdef` prints for such an element.
 * Anything else (an operator, a cast, a keyword expression) is an index element only inside `( … )`.
 * @internal
 */
export function isBareIndexElement(text: string): boolean {
  const s = text.trim();

  if (s.startsWith('(')) {
    return closingParenOutsideQuotes(s, 0) === s.length - 1;
  }

  const name = /^((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))*)\s*\(/.exec(s);

  if (!name || NON_CALL_KEYWORDS.has(name[1].toLowerCase())) {
    return false;
  }

  return closingParenOutsideQuotes(s, name[0].length - 1) === s.length - 1;
}

/**
 * Whether a CAST argument is one PostgreSQL deparses WITHOUT parentheses of its own (`get_coercion_expr` +
 * `isSimpleNode`): an identifier, a constant, a quoted literal, one function call or one balanced group.
 * Anything else — an operator expression above all — keeps its grouping: `(a + b)::bigint`. Conservative: an
 * argument not recognised here keeps its parentheses (at worst a needless mirror comparison, never a missed change).
 */
function isAtomicCastArgument(text: string): boolean {
  if (/^(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*))*$/i.test(text)) {
    return true;
  }

  if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    return true;
  }

  const quote = text.startsWith("'") ? 0 : /^e'/i.test(text) ? 1 : -1;

  if (quote >= 0 && skipQuoted(text, quote) === text.length) {
    return true;
  }

  return isBareIndexElement(text);
}

/**
 * `CAST(<expr> AS <type>)` → `<expr>` wherever it occurs (nested casts too, quoted text left alone) —
 * the counterpart of stripping `::type`, so a builder-rendered `CAST(10000000 AS bigint)` compares equal to
 * the `10000000::bigint` PostgreSQL deparses. A compound `<expr>` folds to `(<expr>)`: the CAST groups it, and
 * PostgreSQL prints that grouping (`(a + b)::bigint * 2` is not `a + b * 2`).
 */
function foldCastExpressions(s: string): string {
  let out = '';

  for (let i = 0; i < s.length;) {
    const ch = s[i];

    if (ch === "'" || ch === '"') {
      const end = skipQuoted(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }

    const cast = (ch === 'c' || ch === 'C') && (i === 0 || !IDENTIFIER_CHAR.test(s[i - 1])) ? /^cast\s*\(/i.exec(s.slice(i, i + 16)) : null;

    if (cast) {
      const open = i + cast[0].length - 1;
      const close = closingParenOutsideQuotes(s, open);
      const inner = close > 0 ? s.slice(open + 1, close) : '';
      const as = close > 0 ? lastTopLevelAs(inner) : -1;

      if (as >= 0) {
        const arg = foldCastExpressions(inner.slice(0, as).trim());
        out += isAtomicCastArgument(arg) ? arg : `(${arg})`;
        i = close + 1;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/** Index of the last ` AS ` at the top level of a CAST's parentheses (the one before the type), or -1. */
function lastTopLevelAs(inner: string): number {
  let depth = 0;
  let found = -1;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(inner, i) - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (depth === 0 && /\s/.test(ch) && /^\sas\s/i.test(inner.slice(i, i + 4))) {
      found = i;
    }
  }

  return found;
}

/**
 * Normalize an index column-list or predicate fragment so the model's intended
 * SQL and PostgreSQL's canonical `pg_get_indexdef()` form compare equal.
 *
 * The transforms, derived from observed `pg_get_indexdef(oid, 0, true)` output:
 *  - lower-case (folds keyword/identifier case: `USING`/`using`, `DESC`, ...);
 *  - fold `CAST(<expr> AS <type>)` to `<expr>` — `(<expr>)` when `<expr>` is
 *    compound, keeping the grouping PostgreSQL prints (balanced-paren and quote
 *    aware) — as `::type` is stripped below: a builder-rendered `CAST(… AS bigint)`
 *    then matches the `…::bigint` PostgreSQL deparses. The fold also hides a cast
 *    the model ADDS, so an equality it produces is never trusted on its own:
 *    `compareIndexDefinition` flags it `needsConfirmation`;
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
  s = foldCastExpressions(s);
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
    include: normalizeIndexFragment(buildIndexIncludeList(spec)),
    where: normalizeIndexPredicate(spec.where),
    // Mirror the SQL builder's `isUnique` guard: the clause is only emitted (and
    // only valid) on a unique index, so a non-unique spec normalizes to `false`.
    nullsNotDistinct: !!(spec.isUnique && spec.nullsNotDistinct),
  };
}

/**
 * Index of the `)` that closes the `(` at `openParenIdx`, or -1 when the group is
 * unbalanced. Nested parens (function calls, casts) are skipped over.
 */
function findClosingParen(text: string, openParenIdx: number): number {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse PostgreSQL's canonical index definition
 * (`pg_get_indexdef(oid, 0, true)`) into a normalized signature.
 *
 * Returns `null` when the definition cannot be parsed or carries a clause the
 * model cannot express (`WITH (...)` storage parameters, `TABLESPACE`), in which
 * case the caller treats the index as unchanged to avoid pointless rebuilds.
 */
export function parseDbIndexSignature(canonicalDef: string): IndexSignature | null {
  const head = /^CREATE (UNIQUE )?INDEX .+? ON .+? USING (\w+) \(/i.exec(canonicalDef);
  if (!head) return null;

  const isUnique = !!head[1];
  const method = head[2].toLowerCase();

  // The column list is the balanced-paren group that opens at the end of the
  // header match. Walk it so nested function-call parens don't end it early.
  const openParenIdx = head.index + head[0].length - 1;
  const closeParenIdx = findClosingParen(canonicalDef, openParenIdx);
  if (closeParenIdx === -1) return null;

  const columns = canonicalDef.slice(openParenIdx + 1, closeParenIdx);
  let rest = canonicalDef.slice(closeParenIdx + 1).trim();

  // PostgreSQL deparses `(cols) [INCLUDE ...] [NULLS NOT DISTINCT] [WITH ...] [WHERE ...]`.
  // Take the clauses the model expresses off the front in that order; what
  // remains is then either empty or a `WHERE …` predicate.
  let include = '';
  const includeMatch = /^INCLUDE\s*\(/i.exec(rest);
  if (includeMatch) {
    const includeOpenIdx = includeMatch[0].length - 1;
    const includeCloseIdx = findClosingParen(rest, includeOpenIdx);
    if (includeCloseIdx === -1) return null;
    include = rest.slice(includeOpenIdx + 1, includeCloseIdx);
    rest = rest.slice(includeCloseIdx + 1).trim();
  }

  let nullsNotDistinct = false;
  const nndMatch = /^NULLS\s+NOT\s+DISTINCT\b/i.exec(rest);
  if (nndMatch) {
    nullsNotDistinct = true;
    rest = rest.slice(nndMatch[0].length).trim();
  }

  let where = '';
  if (rest) {
    const whereMatch = /^WHERE\s+(.*)$/is.exec(rest);
    if (whereMatch) {
      where = whereMatch[1];
    } else {
      // Trailing clause the model can't represent (WITH, TABLESPACE...).
      // Be conservative: signal "unknown" so we don't rebuild on every run.
      return null;
    }
  }

  return {
    isUnique,
    method,
    columns: normalizeIndexFragment(columns),
    include: normalizeIndexFragment(include),
    where: normalizeIndexPredicate(where),
    nullsNotDistinct,
  };
}

export interface IndexComparison {
  changed: boolean;
  /** Human-readable summary of what differs (for logs / scaffold comments). */
  reason?: string;
  /**
   * No difference was found, but only because the normalization folds the model's `CAST(… AS …)`: a cast the
   * model ADDS (or moves) is invisible to this comparison — `(age % CAST(10 AS bigint))` reads like the stored
   * `(age % 10)`. Such an index must be confirmed against PostgreSQL's own canonical form (the schema
   * manager's mirror comparison) before it is called unchanged.
   */
  needsConfirmation?: boolean;
  modelSignature: IndexSignature;
  dbSignature: IndexSignature | null;
}

/** Does the model spell a `CAST(… AS …)` that the normalization folds away? See {@link IndexComparison.needsConfirmation}. */
function spellsFoldedCast(spec: IndexSqlSpec): boolean {
  return [buildIndexColumnList(spec), buildIndexIncludeList(spec), spec.where]
    .some(fragment => !!fragment && foldCastExpressions(fragment.toLowerCase()) !== fragment.toLowerCase());
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
  if (modelSignature.include !== dbSignature.include) {
    diffs.push(`include (${dbSignature.include || 'none'}) -> (${modelSignature.include || 'none'})`);
  }
  if (modelSignature.where !== dbSignature.where) {
    diffs.push(`where (${dbSignature.where || 'none'}) -> (${modelSignature.where || 'none'})`);
  }
  if (modelSignature.nullsNotDistinct !== dbSignature.nullsNotDistinct) {
    diffs.push(`nulls not distinct ${dbSignature.nullsNotDistinct} -> ${modelSignature.nullsNotDistinct}`);
  }

  const changed = diffs.length > 0;

  return {
    changed,
    reason: changed ? diffs.join('; ') : undefined,
    needsConfirmation: !changed && spellsFoldedCast(spec),
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
 * (access method, column/expression list with operator classes, the INCLUDE
 * list, and the partial predicate). The index name and table reference — which
 * differ between the real index and its temp-table rebuild — are deliberately
 * excluded.
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
