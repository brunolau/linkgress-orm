import { CteEntry, Query, RTE, TypeInfo } from './nodes';

export type ExprKind =
  | 'none'
  | 'select'
  | 'where'
  | 'join_on'
  | 'join_using'
  | 'from_subselect'
  | 'from_function'
  | 'having'
  | 'filter'
  | 'window_partition'
  | 'window_order'
  | 'window_frame'
  | 'group_by'
  | 'order_by'
  | 'distinct_on'
  | 'limit'
  | 'offset'
  | 'returning'
  | 'values'
  | 'values_single'
  | 'insert_target'
  | 'update_source'
  | 'update_target'
  | 'merge_when'
  | 'check_constraint'
  | 'domain_check'
  | 'column_default'
  | 'function_default'
  | 'index_expression'
  | 'index_predicate'
  | 'statistics_expression'
  | 'alter_col_transform'
  | 'execute_parameter'
  | 'trigger_when'
  | 'policy'
  | 'partition_bound'
  | 'partition_expression'
  | 'call_argument'
  | 'copy_where'
  | 'generated_column'
  | 'cycle_mark';

export const EXPR_KIND_NAMES: Record<ExprKind, string> = {
  none: '',
  select: 'SELECT',
  where: 'WHERE',
  join_on: 'JOIN/ON',
  join_using: 'JOIN/USING',
  from_subselect: 'sub-SELECT in FROM',
  from_function: 'function in FROM',
  having: 'HAVING',
  filter: 'FILTER',
  window_partition: 'window PARTITION BY',
  window_order: 'window ORDER BY',
  window_frame: 'window RANGE',
  group_by: 'GROUP BY',
  order_by: 'ORDER BY',
  distinct_on: 'DISTINCT ON',
  limit: 'LIMIT',
  offset: 'OFFSET',
  returning: 'RETURNING',
  values: 'VALUES',
  values_single: 'VALUES',
  insert_target: 'INSERT',
  update_source: 'UPDATE',
  update_target: 'UPDATE',
  merge_when: 'MERGE WHEN',
  check_constraint: 'CHECK',
  domain_check: 'CHECK',
  column_default: 'DEFAULT',
  function_default: 'DEFAULT',
  index_expression: 'index expression',
  index_predicate: 'index predicate',
  statistics_expression: 'statistics expression',
  alter_col_transform: 'USING',
  execute_parameter: 'EXECUTE',
  trigger_when: 'WHEN',
  policy: 'POLICY',
  partition_bound: 'partition bound',
  partition_expression: 'PARTITION BY',
  call_argument: 'CALL',
  copy_where: 'WHERE',
  generated_column: 'GENERATED AS',
  cycle_mark: 'CYCLE',
};

export interface NsItem {
  rtIndex: number;
  rte: RTE;
  relVisible: boolean;
  colsVisible: boolean;
  lateralOnly: boolean;
  lateralOk: boolean;
}

/** Per-query-level analysis state (PostgreSQL's ParseState). */
export class ParseState {
  parent: ParseState | null;
  query: Query;
  namespace: NsItem[] = [];
  /** CTEs visible at this level */
  ctes: CteEntry[] = [];
  /** CTE currently being defined (for recursive self reference detection) */
  pendingCteName: string | null = null;
  pendingRecursiveCte: CteEntry | null = null;
  exprKind: ExprKind = 'none';
  /** true while transforming a LATERAL FROM item: lateralOnly items become visible */
  lateralActive = false;
  /** set when an expression at this level references an outer level (for correlation detection) */
  maxOuterRef = 0;
  /** unknown-typed output columns should be resolved to text */
  resolveUnknowns = true;
  /** window definitions by name (WINDOW clause) */
  windowDefs = new Map<string, unknown>();
  /**
   * window definitions referenced by window functions, resolved into Query.windowClause after the
   * target list, WHERE, GROUP BY etc. are complete (PG transformWindowDefinitions); index = winRef
   */
  pendingWindows: { def: unknown; name?: string; refname?: string; key: string }[] = [];
  /** set-returning functions seen in target list */
  hasTargetSRFs = false;
  /** DML target relation index */
  resultRelation = -1;
  /** targets are being transformed for INSERT/UPDATE (DEFAULT allowed) */
  allowDefault = false;
  /** for INSERT ... ON CONFLICT: excluded pseudo relation */
  exclRtIndex = -1;
  /** subquery depth marker */
  isSubquery = false;
  locking = false;

  constructor(parent: ParseState | null, query: Query) {
    this.parent = parent;
    this.query = query;
  }

  depth(): number {
    let d = 0;
    let p = this.parent;
    while (p) {
      d++;
      p = p.parent;
    }
    return d;
  }
}

export function eref(aliasname: string, colnames: string[]): { aliasname: string; colnames: string[] } {
  return { aliasname, colnames };
}

export function typeInfo(type: number, typmod = -1, collation = 0): TypeInfo {
  return { type, typmod, collation };
}
