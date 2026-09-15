/**
 * PostgreSQL 18 quirk of generation expressions: cookDefault checks mutability through
 * contain_mutable_functions_after_planning() BEFORE assign_expr_collations() runs, so constant folding
 * evaluates immutable functions whose arguments are all constants with no input collation. Collation-
 * sensitive text functions then fail ("could not determine which collation to use for ..."), even when
 * the literal carries an explicit COLLATE.
 */
import type { TExpr } from '../analyze/nodes';
import type { Catalog } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';

const COLLATION_USE: Record<string, string> = {
  upper: 'upper() function',
  lower: 'lower() function',
  initcap: 'initcap() function',
  textlike: 'LIKE',
  textnlike: 'LIKE',
  texticlike: 'ILIKE',
  texticnlike: 'ILIKE',
  textregexeq: 'regular expression',
  textregexne: 'regular expression',
  texticregexeq: 'regular expression',
  texticregexne: 'regular expression',
  textregexreplace_noopt: 'regular expression',
  textregexreplace: 'regular expression',
};

for (const src of [
  'texteq',
  'textne',
  'text_lt',
  'text_le',
  'text_gt',
  'text_ge',
  'bttextcmp',
  'text_larger',
  'text_smaller',
  'bpchareq',
  'bpcharne',
  'bpcharlt',
  'bpcharle',
  'bpchargt',
  'bpcharge',
  'bpcharcmp',
  'bpchar_larger',
  'bpchar_smaller',
  'textpos',
  'replace_text',
  'split_part',
  'text_starts_with',
]) {
  COLLATION_USE[src] = 'string comparison';
}

/** Types whose text I/O is not immutable (DateStyle / search_path dependent) — such casts are not folded. */
const STABLE_IO_TYPES = new Set([1082, 1114, 1184, 1186, 24, 2202, 2203, 2204, 2205, 2206, 3734, 3769, 4089, 4096, 4191]);

export function checkGeneratedExprFolding(cat: Catalog, expr: TExpr): void {
  foldable(cat, expr);
}

/** Whether the node folds to a constant; throws where folding would evaluate a collation-sensitive function. */
function foldable(cat: Catalog, e: TExpr): boolean {
  switch (e.k) {
    case 'const':
      return true;
    case 'relabel':
    case 'collate':
      return foldable(cat, e.arg);
    case 'iocoerce':
      return foldable(cat, e.arg) && !STABLE_IO_TYPES.has(e.type) && !STABLE_IO_TYPES.has(e.arg.type);
    case 'func':
    case 'op': {
      let allConst = true;
      for (const a of e.args) {
        if (!foldable(cat, a)) {
          allConst = false;
        }
      }
      if (!allConst || (e.k === 'func' && e.isUser)) {
        return false;
      }
      const proc = cat.getProc(e.funcOid);
      if (!proc || proc.volatile !== 'i' || e.retset) {
        return false;
      }
      if (proc.strict && e.args.some((a) => a.k === 'const' && a.isNull)) {
        return true;
      }
      const use = COLLATION_USE[e.funcSrc];
      if (use) {
        throw new PgError(SqlState.INDETERMINATE_COLLATION, `could not determine which collation to use for ${use}`, {
          hint: 'Use the COLLATE clause to set the collation explicitly.',
        });
      }
      return true;
    }
    default:
      return false;
  }
}
