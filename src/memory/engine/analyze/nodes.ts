/**
 * Analyzed (typed) query trees — a compact analogue of PostgreSQL's Query / RangeTblEntry / Expr nodes.
 */

export interface TypeInfo {
  type: number;
  typmod: number;
  collation: number;
}

interface ExprBase {
  type: number;
  typmod: number;
  collation: number;
}

export interface ConstNode extends ExprBase {
  k: 'const';
  value: unknown;
  isNull: boolean;
  /** literal was an untyped string / NULL (still unknown type) */
  location?: number;
}

export interface ParamNode extends ExprBase {
  k: 'param';
  /** 1-based parameter number */
  paramId: number;
}

/** Internal parameter used for executor-provided values (CASE test value, subquery outputs, etc.) */
export interface ExecParamNode extends ExprBase {
  k: 'execparam';
  slot: number;
}

export interface VarNode extends ExprBase {
  k: 'var';
  levelsUp: number;
  rtIndex: number;
  /** 0-based column index within the RTE's output; -1 = whole row */
  attno: number;
}

export interface OpNode extends ExprBase {
  k: 'op';
  opOid: number;
  opName: string;
  /** implementing function (pg_proc.prosrc) */
  funcSrc: string;
  funcOid: number;
  args: TExpr[];
  inputCollation: number;
  retset: boolean;
}

export interface FuncNode extends ExprBase {
  k: 'func';
  funcOid: number;
  funcName: string;
  funcSrc: string;
  args: TExpr[];
  inputCollation: number;
  retset: boolean;
  /** how the call was written (affects deparse) */
  format: 'call' | 'explicit_cast' | 'implicit_cast' | 'sql_syntax';
  variadic: boolean;
  strict: boolean;
  /** user-defined function (executed via SQL/plpgsql interpreter) */
  isUser?: boolean;
  /** argument names for named notation display */
  argNames?: (string | undefined)[];
}

export interface SortClauseItem {
  expr: TExpr;
  desc: boolean;
  nullsFirst: boolean;
  /** comparison is done using the type's default btree ordering, or explicit operator */
  useOpName?: string;
}

export interface AggNode extends ExprBase {
  k: 'agg';
  aggOid: number;
  aggName: string;
  /** aggregate kind: n normal, o ordered-set, h hypothetical */
  aggKind: 'n' | 'o' | 'h';
  transSrc: string;
  args: TExpr[];
  argTypes: number[];
  directArgs: TExpr[];
  distinct: boolean;
  star: boolean;
  order: SortClauseItem[];
  filter: TExpr | null;
  levelsUp: number;
  /** index into the per-group aggregate value array (assigned by the analyzer) */
  aggIndex: number;
  variadic: boolean;
  isUser?: boolean;
  inputCollation: number;
}

export interface WindowFuncNode extends ExprBase {
  k: 'window';
  funcOid: number;
  funcName: string;
  funcSrc: string;
  args: TExpr[];
  argTypes: number[];
  filter: TExpr | null;
  star: boolean;
  distinct: boolean;
  /** index into Query.windowClause */
  winRef: number;
  /** plain aggregate used as a window function */
  isAgg: boolean;
  aggKind?: 'n' | 'o' | 'h';
  /** index into the window value array */
  winIndex: number;
  inputCollation: number;
}

export interface BoolNode extends ExprBase {
  k: 'bool';
  op: 'and' | 'or' | 'not';
  args: TExpr[];
}

export interface NullTestNode extends ExprBase {
  k: 'nulltest';
  arg: TExpr;
  isNot: boolean;
  argIsRow: boolean;
}

export interface BoolTestNode extends ExprBase {
  k: 'booltest';
  arg: TExpr;
  test: 'IS_TRUE' | 'IS_NOT_TRUE' | 'IS_FALSE' | 'IS_NOT_FALSE' | 'IS_UNKNOWN' | 'IS_NOT_UNKNOWN';
}

export interface CaseNode extends ExprBase {
  k: 'case';
  arg: TExpr | null;
  /** slot number for the CASE test value (when arg is present) */
  testSlot: number;
  whens: { cond: TExpr; result: TExpr }[];
  def: TExpr;
}

export interface CoalesceNode extends ExprBase {
  k: 'coalesce';
  args: TExpr[];
}

export interface MinMaxNode extends ExprBase {
  k: 'minmax';
  op: 'greatest' | 'least';
  args: TExpr[];
}

export interface NullIfNode extends ExprBase {
  k: 'nullif';
  args: TExpr[];
  opSrc: string;
  opOid: number;
}

export interface ScalarArrayOpNode extends ExprBase {
  k: 'saop';
  opOid: number;
  opName: string;
  opSrc: string;
  useOr: boolean;
  args: [TExpr, TExpr];
  inputCollation: number;
}

export interface SubLinkNode extends ExprBase {
  k: 'sublink';
  linkType: 'EXISTS' | 'ALL' | 'ANY' | 'EXPR' | 'ARRAY' | 'ROWCOMPARE' | 'MULTIEXPR';
  /** left-hand expressions for ANY/ALL/ROWCOMPARE */
  testLeft: TExpr[];
  /** comparison operators per column (ANY/ALL/ROWCOMPARE) */
  operators: { opName: string; opSrc: string; opOid: number; leftType: number; rightType: number; collation: number }[];
  subquery: Query;
  /** subquery references no outer query level variables -> can be evaluated once */
  correlated: boolean;
  /** unique id within the statement (for initplan caching) */
  id: number;
}

export interface RowNode extends ExprBase {
  k: 'row';
  args: TExpr[];
  fieldNames: string[];
  /** ROW(...) written explicitly */
  explicitRow: boolean;
}

export interface ArrayNode extends ExprBase {
  k: 'array';
  elements: TExpr[];
  elemType: number;
  multidims: boolean;
}

export interface RelabelNode extends ExprBase {
  k: 'relabel';
  arg: TExpr;
  format: 'explicit_cast' | 'implicit_cast';
}

export interface CoerceViaIONode extends ExprBase {
  k: 'iocoerce';
  arg: TExpr;
  format: 'explicit_cast' | 'implicit_cast';
}

export interface ArrayCoerceNode extends ExprBase {
  k: 'arraycoerce';
  arg: TExpr;
  /** per-element conversion; reads the element through execparam `elemSlot` */
  elemExpr: TExpr;
  elemSlot: number;
  format: 'explicit_cast' | 'implicit_cast';
}

export interface DomainCoerceNode extends ExprBase {
  k: 'domaincoerce';
  arg: TExpr;
  domainOid: number;
  format: 'explicit_cast' | 'implicit_cast';
}

export interface FieldSelectNode extends ExprBase {
  k: 'fieldselect';
  arg: TExpr;
  fieldIndex: number;
  fieldName: string;
}

export interface SubscriptNode extends ExprBase {
  k: 'subscript';
  arg: TExpr;
  upper: (TExpr | null)[];
  lower: (TExpr | null)[] | null;
  isSlice: boolean;
  /** jsonb subscripting instead of array */
  isJsonb: boolean;
}

export interface SqlValueNode extends ExprBase {
  k: 'sqlvalue';
  op: string;
}

export interface DistinctNode extends ExprBase {
  k: 'distinct';
  isNot: boolean;
  opSrc: string;
  opOid: number;
  args: TExpr[];
  inputCollation: number;
}

export interface RowCompareNode extends ExprBase {
  k: 'rowcompare';
  op: '<' | '<=' | '>' | '>=' | '=' | '<>';
  opSrcs: string[];
  opOids: number[];
  largs: TExpr[];
  rargs: TExpr[];
  collations: number[];
}

export interface SetToDefaultNode extends ExprBase {
  k: 'default';
}

export interface GroupingNode extends ExprBase {
  k: 'grouping';
  /** indexes into groupClause */
  refs: number[];
  levelsUp: number;
}

export interface CollateNode extends ExprBase {
  k: 'collate';
  arg: TExpr;
}

/** A reference to a grouping key value, produced after aggregation (resolved at compile time). */
export interface GroupKeyNode extends ExprBase {
  k: 'groupkey';
  index: number;
}

export type TExpr =
  | ConstNode
  | ParamNode
  | ExecParamNode
  | VarNode
  | OpNode
  | FuncNode
  | AggNode
  | WindowFuncNode
  | BoolNode
  | NullTestNode
  | BoolTestNode
  | CaseNode
  | CoalesceNode
  | MinMaxNode
  | NullIfNode
  | ScalarArrayOpNode
  | SubLinkNode
  | RowNode
  | ArrayNode
  | RelabelNode
  | CoerceViaIONode
  | ArrayCoerceNode
  | DomainCoerceNode
  | FieldSelectNode
  | SubscriptNode
  | SqlValueNode
  | DistinctNode
  | RowCompareNode
  | SetToDefaultNode
  | GroupingNode
  | CollateNode
  | GroupKeyNode;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface TargetEntry {
  expr: TExpr;
  /** 1-based position */
  resno: number;
  name: string;
  resjunk: boolean;
  /** >0 if referenced by ORDER BY / GROUP BY / DISTINCT */
  sortGroupRef: number;
  /** source table oid / column number (RowDescription) */
  origTable: number;
  origColumn: number;
}

export interface SortGroupClause {
  tleSortGroupRef: number;
  desc: boolean;
  nullsFirst: boolean;
  /** explicit USING operator name */
  useOpName?: string;
}

export interface Eref {
  aliasname: string;
  colnames: string[];
}

export interface RelationRTE {
  kind: 'relation';
  relOid: number;
  relkind: string;
  /** relation name as written (for error messages) */
  relname: string;
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  /** attnum per output column */
  attnums: number[];
  inh: boolean;
  lateral: false;
}

export interface SubqueryRTE {
  kind: 'subquery';
  subquery: Query;
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  lateral: boolean;
  /** the view this subquery expands (a view referenced in FROM) */
  viewOid?: number;
  /** column aliases were written (FROM (...) s(a, b)); deparsing prints them */
  userColnames?: boolean;
}

export interface JoinRTE {
  kind: 'join';
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  aliasVars: TExpr[];
  lateral: false;
  /** number of merged USING columns at the start of the column list */
  usingCount: number;
}

export interface RangeFunctionItem {
  expr: TExpr;
  /** number of output columns contributed */
  colCount: number;
  /** function returns a composite that is expanded into columns */
  expandComposite: boolean;
  colTypes: TypeInfo[];
  colNames: string[];
}

export interface FunctionRTE {
  kind: 'function';
  functions: RangeFunctionItem[];
  ordinality: boolean;
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  lateral: boolean;
}

export interface ValuesRTE {
  kind: 'values';
  lists: TExpr[][];
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  lateral: boolean;
}

export interface CteRTE {
  kind: 'cte';
  ctename: string;
  levelsUp: number;
  selfReference: boolean;
  cte: CteEntry;
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  lateral: false;
  /** column aliases were written (FROM cte c(a, b)) */
  userColnames?: boolean;
}

/** Catalog virtual table (pg_catalog / information_schema) — materialized from the catalog at scan time. */
export interface CatalogRTE {
  kind: 'catalog';
  relOid: number;
  relname: string;
  nspname: string;
  alias?: string;
  eref: Eref;
  colTypes: TypeInfo[];
  lateral: false;
  /**
   * A trigger's transition table (an ephemeral named relation) of that name, over the table `relOid`
   * (whose row type the whole-row reference has). The rows are the running trigger's, looked up when the
   * statement executes: the analyzed statement does not hold them, so it can be reused.
   */
  transitionName?: string;
  rowTypeOid?: number;
}

export type RTE = RelationRTE | SubqueryRTE | JoinRTE | FunctionRTE | ValuesRTE | CteRTE | CatalogRTE;

export type JoinTreeNode = { k: 'ref'; rtIndex: number } | JoinNode;

export interface JoinNode {
  k: 'join';
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
  larg: JoinTreeNode;
  rarg: JoinTreeNode;
  quals: TExpr | null;
  rtIndex: number;
}

export interface CteEntry {
  name: string;
  query: Query;
  recursive: boolean;
  /** for recursive CTEs: the non-recursive term and recursive term */
  recursiveParts?: { nonRecursive: Query; recursive: Query; unionAll: boolean };
  colNames: string[];
  colTypes: TypeInfo[];
  materialized: 'DEFAULT' | 'ALWAYS' | 'NEVER';
  refCount: number;
  isModifying: boolean;
  /** unique id within the statement */
  id: number;
  search?: { breadthFirst: boolean; columns: number[]; seqColumn: string };
  cycle?: { columns: number[]; markColumn: string; markValue: TExpr; markDefault: TExpr; pathColumn: string };
}

export type SetOpTree =
  | { k: 'leaf'; rtIndex: number }
  | { k: 'setop'; op: 'UNION' | 'INTERSECT' | 'EXCEPT'; all: boolean; larg: SetOpTree; rarg: SetOpTree; colTypes: TypeInfo[] };

export interface WindowClause {
  name?: string;
  partitionClause: SortGroupClause[];
  orderClause: SortGroupClause[];
  frame: {
    mode: 'ROWS' | 'RANGE' | 'GROUPS';
    start: { type: string; offset: TExpr | null };
    end: { type: string; offset: TExpr | null };
    exclusion: string;
    defaultFrame: boolean;
  };
  /** named window this one copied its definition from */
  refname?: string;
}

export interface RowMark {
  rtIndex: number;
  strength: 'UPDATE' | 'NO KEY UPDATE' | 'SHARE' | 'KEY SHARE';
  waitPolicy: 'BLOCK' | 'SKIP' | 'NOWAIT';
}

export interface OnConflictSpec {
  action: 'NOTHING' | 'UPDATE';
  /** unique index oid used for arbitration (0 = any) */
  arbiterIndexes: number[];
  /** SET assignments: column index -> expr (EXCLUDED is rtIndex exclRtIndex) */
  setList: { attIndex: number; expr: TExpr }[];
  where: TExpr | null;
  exclRtIndex: number;
}

export interface MergeAction {
  matchKind: 'MATCHED' | 'NOT_MATCHED_BY_SOURCE' | 'NOT_MATCHED_BY_TARGET';
  command: 'UPDATE' | 'INSERT' | 'DELETE' | 'NOTHING';
  condition: TExpr | null;
  /** UPDATE: attIndex->expr; INSERT: column values for every target column (null = default) */
  targetList: { attIndex: number; expr: TExpr }[];
  override?: 'SYSTEM' | 'USER';
}

export interface Query {
  commandType: 'select' | 'insert' | 'update' | 'delete' | 'merge';
  cteList: CteEntry[];
  rtable: RTE[];
  fromlist: JoinTreeNode[];
  where: TExpr | null;
  targetList: TargetEntry[];
  groupClause: SortGroupClause[];
  groupingSets: number[][] | null;
  havingQual: TExpr | null;
  windowClause: WindowClause[];
  distinctClause: SortGroupClause[] | null;
  hasDistinctOn: boolean;
  sortClause: SortGroupClause[];
  limitOffset: TExpr | null;
  limitCount: TExpr | null;
  limitWithTies: boolean;
  rowMarks: RowMark[];
  setOperations: SetOpTree | null;
  hasAggs: boolean;
  hasWindowFuncs: boolean;
  hasTargetSRFs: boolean;
  /** number of aggregate slots */
  aggs: AggNode[];
  windowFuncs: WindowFuncNode[];
  /** number of execparam slots used by this query tree */
  // DML
  resultRelation: number;
  /** INSERT: rows source (subquery RTE index or values) */
  insertSource?: { kind: 'values'; rows: (TExpr | null)[][] } | { kind: 'select'; rtIndex: number } | { kind: 'default' };
  /** INSERT: target attribute indexes (into live columns) in the column list order */
  insertColumns?: number[];
  override?: 'SYSTEM' | 'USER';
  onConflict?: OnConflictSpec;
  /** UPDATE: assignments */
  updateSet?: { attIndex: number; expr: TExpr }[];
  returningList: TargetEntry[];
  mergeActions?: MergeAction[];
  mergeSourceRtIndex?: number;
  mergeJoinCondition?: TExpr | null;
  /** RETURNING OLD/NEW support: range table indexes for old/new aliases */
  returningOldRt?: number;
  returningNewRt?: number;
  /** statement-level: true when the query (or a CTE) modifies data */
  hasModifyingCte: boolean;
  /**
   * INSERT / UPDATE through a view WITH CHECK OPTION: quals every new row must satisfy, innermost view
   * first (over the result relation, level 0)
   */
  withCheckOptions?: { viewName: string; qual: TExpr | null; cascaded: boolean }[];
}

export function makeConst(type: number, value: unknown, typmod = -1, collation = 0): ConstNode {
  return { k: 'const', type, typmod, collation, value, isNull: value === null || value === undefined };
}

export function makeNullConst(type: number, typmod = -1, collation = 0): ConstNode {
  return { k: 'const', type, typmod, collation, value: null, isNull: true };
}

export function exprType(e: TExpr): number {
  return e.type;
}

export function emptyQuery(commandType: Query['commandType'] = 'select'): Query {
  return {
    commandType,
    cteList: [],
    rtable: [],
    fromlist: [],
    where: null,
    targetList: [],
    groupClause: [],
    groupingSets: null,
    havingQual: null,
    windowClause: [],
    distinctClause: null,
    hasDistinctOn: false,
    sortClause: [],
    limitOffset: null,
    limitCount: null,
    limitWithTies: false,
    rowMarks: [],
    setOperations: null,
    hasAggs: false,
    hasWindowFuncs: false,
    hasTargetSRFs: false,
    aggs: [],
    windowFuncs: [],
    resultRelation: -1,
    returningList: [],
    hasModifyingCte: false,
  };
}
