/**
 * Literal value prefix used in navigation key parts.
 * When a key part starts with this prefix, it's a raw SQL literal (e.g. "5", "TRUE")
 * rather than a column name.
 */
export const LITERAL_PREFIX = '__LIT:';

/**
 * Format a join value as either a quoted column reference or a raw literal.
 * @param alias Table alias for column references
 * @param value Column name or "__LIT:value" for literals
 */
export function formatJoinValue(alias: string, value: string): string {
  if (value.startsWith(LITERAL_PREFIX)) {
    return value.substring(LITERAL_PREFIX.length);
  }
  return `"${alias}"."${value}"`;
}

/**
 * Check if a key part is a literal value (not a column reference).
 */
export function isLiteralKeyPart(value: string): boolean {
  return value.startsWith(LITERAL_PREFIX);
}

/**
 * Build the literal-only filter predicates from a navigation's composite FK/match
 * arrays. Used by strategies that DO NOT carry a source-table reference inside
 * the collection subquery (e.g. CTE, temptable). In those strategies the
 * parent-child column equality is materialised via parent_id grouping / JOIN,
 * so we only need to emit the navigation's CONSTANT predicates (e.g.
 * `target.is_current = true`) as WHERE filters on the target rows.
 *
 * A pair `(fk[i], match[i])` is considered a literal predicate when:
 *  - `match[i]` is a literal (`__LIT:value`) AND `fk[i]` is a column.
 *    Emits: `"<targetAlias>"."<fk>" = <literal>`.
 *  - both sides are literals. Emits: `<lhs-literal> = <rhs-literal>` (degenerate).
 *  - `fk[i]` is a literal AND `match[i]` is a column. Skipped — the source
 *    table isn't available inside the subquery; this shape isn't expressible
 *    here and shouldn't be configured for a hasMany navigation.
 *
 * Column-on-both-sides pairs (i.e. real composite-column FKs) are NOT emitted
 * by this helper — they are handled upstream via the strategy's existing
 * `parent_id`-grouping / JOIN mechanism.
 *
 * @param targetAlias Alias of the target/child table inside the subquery.
 * @param foreignKeys Composite FK columns on the target side (may include `__LIT:`).
 * @param matches     Match-key columns on the source side (may include `__LIT:`).
 */
export function buildLiteralOnlyPredicates(
  targetAlias: string,
  foreignKeys: string[] | undefined,
  matches: string[] | undefined,
): string[] {
  if (!foreignKeys || foreignKeys.length === 0 || !matches) {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < foreignKeys.length; i++) {
    const fk = foreignKeys[i];
    const match = matches[i];
    const fkIsLit = isLiteralKeyPart(fk);
    const matchIsLit = match != null && isLiteralKeyPart(match);
    if (matchIsLit) {
      // target.fk = <literal>  (or  <literal> = <literal> when both sides literal)
      out.push(`${formatJoinValue(targetAlias, fk)} = ${formatJoinValue('', match)}`);
    } else if (fkIsLit) {
      // Source-side column without target column — not expressible inside a
      // strategy subquery that lacks a source-table reference. Skip silently.
      continue;
    }
    // column = column at i > 0: composite-column FK; the strategy's
    // parent_id/JOIN handles the i==0 column equality, and i > 0
    // composite-column equality isn't supported here. Skip.
  }
  return out;
}

/**
 * Build the parent-child correlation predicate for a collection projection,
 * supporting composite keys and literal-value (constant) FK predicates.
 *
 * Iterates `foreignKeys` × `matches` in lock-step. Each pair becomes a single
 * `<lhs> = <rhs>` clause via `formatJoinValue`, then all pairs are AND-ed.
 *
 * Examples
 * --------
 * Simple single column: `[fk] × [match]`
 *   `"<fkTable>"."<fk>" = "<sourceTable>"."<match>"`
 *
 * SCD2 constant FK (the bug case):
 *   foreignKeys: ['product_id', 'is_current']
 *   matches:     ['id', '__LIT:true']
 *
 *   pair 0 → `"<fkTable>"."product_id" = "<sourceTable>"."id"`
 *   pair 1 → `"<fkTable>"."is_current" = true`
 *   → final: `"<fkTable>"."product_id" = "<sourceTable>"."id" AND "<fkTable>"."is_current" = true`
 *
 * If `foreignKeys` is empty (legacy single-column form), the caller is expected
 * to fall back to the simple `fkAlias.fk = sourceAlias.match` form. This helper
 * itself returns an empty string in that case.
 *
 * @param fkAlias     Alias to qualify foreign-key columns on the child/target side.
 * @param sourceAlias Alias to qualify match columns on the parent/source side.
 * @param foreignKeys Composite FK columns on the child/target side; may include `__LIT:` markers.
 * @param matches     Composite match-key columns on the parent/source side; may include `__LIT:` markers.
 */
export function buildCollectionCorrelationWhere(
  fkAlias: string,
  sourceAlias: string,
  foreignKeys: string[],
  matches: string[],
): string {
  if (!foreignKeys || foreignKeys.length === 0) {
    return '';
  }
  const clauses: string[] = [];
  for (let i = 0; i < foreignKeys.length; i++) {
    const fk = foreignKeys[i];
    const match = matches[i] ?? 'id';
    clauses.push(`${formatJoinValue(fkAlias, fk)} = ${formatJoinValue(sourceAlias, match)}`);
  }
  return clauses.join(' AND ');
}
