/**
 * Raw parse tree produced by the parser (roughly PostgreSQL's raw parse nodes).
 * Semantic analysis turns it into typed query trees (see analyze/).
 */

export interface Loc {
  loc?: number;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | ColumnRef
  | ParamRef
  | AConst
  | TypeCast
  | AExpr
  | BoolExpr
  | NullTest
  | BooleanTest
  | FuncCall
  | CaseExpr
  | CoalesceExpr
  | MinMaxExpr
  | SubLink
  | ArrayExpr
  | RowExpr
  | Indirection
  | CollateClause
  | SqlValueFunction
  | SetToDefault
  | GroupingFunc
  | AStar
  | ParenExpr;

export interface ColumnRef extends Loc {
  kind: 'ColumnRef';
  /** name parts; '*' for a trailing star */
  fields: string[];
}

export interface ParamRef extends Loc {
  kind: 'ParamRef';
  number: number;
}

export type ConstValue =
  | { type: 'integer'; value: string }
  | { type: 'numeric'; value: string }
  | { type: 'string'; value: string }
  | { type: 'bitstring'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' };

export interface AConst extends Loc {
  kind: 'AConst';
  val: ConstValue;
}

export interface TypeName extends Loc {
  kind: 'TypeName';
  /** qualified name parts, lower-cased; built-in SQL types are mapped to pg_catalog names */
  names: string[];
  typmods: Expr[];
  /** number of array dimensions ([] or ARRAY) */
  arrayBounds: number[];
  setof?: boolean;
  /** %TYPE reference */
  pctType?: boolean;
  /** interval field restriction bitmask text, e.g. 'day to second' (kept for typmod) */
  intervalFields?: string;
}

export interface TypeCast extends Loc {
  kind: 'TypeCast';
  arg: Expr;
  typeName: TypeName;
}

export type AExprKind =
  | 'OP'
  | 'OP_ANY'
  | 'OP_ALL'
  | 'DISTINCT'
  | 'NOT_DISTINCT'
  | 'NULLIF'
  | 'IN'
  | 'LIKE'
  | 'ILIKE'
  | 'SIMILAR'
  | 'BETWEEN'
  | 'NOT_BETWEEN'
  | 'BETWEEN_SYM'
  | 'NOT_BETWEEN_SYM';

export interface AExpr extends Loc {
  kind: 'AExpr';
  exprKind: AExprKind;
  /** operator name parts (last part is the symbol); for LIKE etc: '~~', '!~~', ... */
  name: string[];
  lexpr: Expr | null;
  /** for IN: Expr[]; for BETWEEN: [low, high] */
  rexpr: Expr | Expr[] | null;
}

export interface BoolExpr extends Loc {
  kind: 'BoolExpr';
  op: 'AND' | 'OR' | 'NOT';
  args: Expr[];
}

export interface NullTest extends Loc {
  kind: 'NullTest';
  arg: Expr;
  isNot: boolean;
}

export interface BooleanTest extends Loc {
  kind: 'BooleanTest';
  arg: Expr;
  test: 'IS_TRUE' | 'IS_NOT_TRUE' | 'IS_FALSE' | 'IS_NOT_FALSE' | 'IS_UNKNOWN' | 'IS_NOT_UNKNOWN';
}

export interface SortBy extends Loc {
  kind: 'SortBy';
  node: Expr;
  dir: 'DEFAULT' | 'ASC' | 'DESC' | 'USING';
  nulls: 'DEFAULT' | 'FIRST' | 'LAST';
  useOp?: string[];
}

export interface WindowDef extends Loc {
  kind: 'WindowDef';
  name?: string;
  refname?: string;
  partitionClause: Expr[];
  orderClause: SortBy[];
  frame?: WindowFrame;
}

export interface WindowFrame {
  mode: 'ROWS' | 'RANGE' | 'GROUPS';
  start: FrameBound;
  end: FrameBound;
  exclusion: 'NO_OTHERS' | 'CURRENT_ROW' | 'GROUP' | 'TIES';
}

export interface FrameBound {
  type: 'UNBOUNDED_PRECEDING' | 'PRECEDING' | 'CURRENT_ROW' | 'FOLLOWING' | 'UNBOUNDED_FOLLOWING';
  offset?: Expr;
}

export interface FuncCall extends Loc {
  kind: 'FuncCall';
  name: string[];
  args: Expr[];
  /** named argument names parallel to args (undefined for positional) */
  argNames?: (string | undefined)[];
  aggOrder: SortBy[];
  aggFilter: Expr | null;
  aggWithinGroup: boolean;
  aggStar: boolean;
  aggDistinct: boolean;
  funcVariadic: boolean;
  over: WindowDef | null;
  /** marks special SQL syntax forms whose output column name differs (e.g. EXTRACT) */
  special?: string;
}

export interface CaseWhen {
  expr: Expr;
  result: Expr;
}

export interface CaseExpr extends Loc {
  kind: 'CaseExpr';
  arg: Expr | null;
  whens: CaseWhen[];
  defresult: Expr | null;
}

export interface CoalesceExpr extends Loc {
  kind: 'CoalesceExpr';
  args: Expr[];
}

export interface MinMaxExpr extends Loc {
  kind: 'MinMaxExpr';
  op: 'GREATEST' | 'LEAST';
  args: Expr[];
}

export interface SubLink extends Loc {
  kind: 'SubLink';
  linkType: 'EXISTS' | 'ALL' | 'ANY' | 'EXPR' | 'ARRAY' | 'ROWCOMPARE';
  testexpr: Expr | null;
  operName: string[];
  subselect: SelectStmt;
}

export interface ArrayExpr extends Loc {
  kind: 'ArrayExpr';
  elements: Expr[];
}

export interface RowExpr extends Loc {
  kind: 'RowExpr';
  args: Expr[];
  explicitRow: boolean;
}

export type IndirectionEl = { type: 'index'; lidx: Expr | null; uidx: Expr | null; isSlice: boolean } | { type: 'field'; name: string } | { type: 'star' };

export interface Indirection extends Loc {
  kind: 'Indirection';
  arg: Expr;
  indirection: IndirectionEl[];
}

export interface CollateClause extends Loc {
  kind: 'CollateClause';
  arg: Expr;
  collname: string[];
}

export interface SqlValueFunction extends Loc {
  kind: 'SqlValueFunction';
  op:
    | 'CURRENT_DATE'
    | 'CURRENT_TIME'
    | 'CURRENT_TIME_N'
    | 'CURRENT_TIMESTAMP'
    | 'CURRENT_TIMESTAMP_N'
    | 'LOCALTIME'
    | 'LOCALTIME_N'
    | 'LOCALTIMESTAMP'
    | 'LOCALTIMESTAMP_N'
    | 'CURRENT_ROLE'
    | 'CURRENT_USER'
    | 'USER'
    | 'SESSION_USER'
    | 'CURRENT_CATALOG'
    | 'CURRENT_SCHEMA'
    | 'SYSTEM_USER';
  typmod?: number;
}

export interface SetToDefault extends Loc {
  kind: 'SetToDefault';
}

export interface GroupingFunc extends Loc {
  kind: 'GroupingFunc';
  args: Expr[];
}

export interface AStar extends Loc {
  kind: 'AStar';
}

/** Parenthesized expression marker (kept so `(a).b` and row constructors parse correctly). */
export interface ParenExpr extends Loc {
  kind: 'ParenExpr';
  arg: Expr;
}

// ---------------------------------------------------------------------------
// FROM clause
// ---------------------------------------------------------------------------

export interface Alias {
  name: string;
  colnames?: string[];
}

export interface RangeVar extends Loc {
  kind: 'RangeVar';
  schema?: string;
  catalog?: string;
  name: string;
  alias?: Alias;
  inh: boolean;
}

export interface RangeSubselect extends Loc {
  kind: 'RangeSubselect';
  lateral: boolean;
  subquery: SelectStmt;
  alias?: Alias;
}

export interface ColumnDefShort {
  name: string;
  typeName: TypeName;
}

export interface RangeFunctionItem {
  func: Expr;
  coldeflist?: ColumnDefShort[];
}

export interface RangeFunction extends Loc {
  kind: 'RangeFunction';
  lateral: boolean;
  ordinality: boolean;
  isRowsFrom: boolean;
  functions: RangeFunctionItem[];
  alias?: Alias;
  coldeflist?: ColumnDefShort[];
}

export interface JoinExpr extends Loc {
  kind: 'JoinExpr';
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
  isNatural: boolean;
  larg: FromItem;
  rarg: FromItem;
  usingClause?: string[];
  joinUsingAlias?: string;
  quals: Expr | null;
  alias?: Alias;
}

export type FromItem = RangeVar | RangeSubselect | RangeFunction | JoinExpr;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface ResTarget extends Loc {
  name?: string;
  val: Expr;
  /** for INSERT column lists / UPDATE SET targets */
  indirection?: IndirectionEl[];
}

export interface CommonTableExpr extends Loc {
  name: string;
  aliasColnames?: string[];
  materialized: 'DEFAULT' | 'ALWAYS' | 'NEVER';
  query: Statement;
  search?: { breadthFirst: boolean; columns: string[]; seqColumn: string };
  cycle?: { columns: string[]; markColumn: string; markValue?: Expr; markDefault?: Expr; pathColumn: string };
}

export interface WithClause {
  recursive: boolean;
  ctes: CommonTableExpr[];
}

export interface LockingClause {
  strength: 'UPDATE' | 'NO KEY UPDATE' | 'SHARE' | 'KEY SHARE';
  lockedRels: RangeVar[];
  waitPolicy: 'BLOCK' | 'SKIP' | 'NOWAIT';
}

export type GroupItem =
  | { kind: 'expr'; expr: Expr }
  | { kind: 'empty' }
  | { kind: 'rollup'; items: Expr[][] }
  | { kind: 'cube'; items: Expr[][] }
  | { kind: 'sets'; sets: GroupItem[] };

export interface SelectStmt extends Loc {
  kind: 'SelectStmt';
  with?: WithClause;
  op: 'NONE' | 'UNION' | 'INTERSECT' | 'EXCEPT';
  all: boolean;
  larg?: SelectStmt;
  rarg?: SelectStmt;
  /** null: no DISTINCT; []: DISTINCT; [exprs]: DISTINCT ON */
  distinct: Expr[] | null;
  targetList: ResTarget[];
  into?: { rel: RangeVar; temp: boolean };
  from: FromItem[];
  where: Expr | null;
  groupBy: GroupItem[];
  groupDistinct: boolean;
  having: Expr | null;
  windows: WindowDef[];
  values?: Expr[][];
  sortClause: SortBy[];
  limitCount: Expr | null;
  limitOffset: Expr | null;
  limitWithTies: boolean;
  locking: LockingClause[];
}

export interface OnConflictClause {
  action: 'NOTHING' | 'UPDATE';
  inferElems?: IndexElem[];
  inferWhere?: Expr | null;
  constraintName?: string;
  targetList: ResTarget[];
  where: Expr | null;
}

export interface ReturningClause {
  oldAlias?: string;
  newAlias?: string;
  targets: ResTarget[];
}

export interface InsertStmt extends Loc {
  kind: 'InsertStmt';
  with?: WithClause;
  relation: RangeVar;
  cols?: ResTarget[];
  /** null for DEFAULT VALUES */
  select: SelectStmt | null;
  onConflict?: OnConflictClause;
  returning?: ReturningClause;
  override?: 'SYSTEM' | 'USER';
}

export interface UpdateStmt extends Loc {
  kind: 'UpdateStmt';
  with?: WithClause;
  relation: RangeVar;
  targetList: SetClauseItem[];
  from: FromItem[];
  where: Expr | null;
  returning?: ReturningClause;
}

/** SET col = expr | SET (a, b) = (expr, expr) | SET (a, b) = (SELECT ...) */
export type SetClauseItem =
  | { kind: 'single'; target: ResTarget }
  | { kind: 'multi'; targets: ResTarget[]; source: Expr | SelectStmt; isSubselect: boolean; loc?: number };

export interface DeleteStmt extends Loc {
  kind: 'DeleteStmt';
  with?: WithClause;
  relation: RangeVar;
  using: FromItem[];
  where: Expr | null;
  returning?: ReturningClause;
}

export interface MergeWhenClause {
  matchKind: 'MATCHED' | 'NOT_MATCHED_BY_SOURCE' | 'NOT_MATCHED_BY_TARGET';
  condition: Expr | null;
  command: 'UPDATE' | 'INSERT' | 'DELETE' | 'NOTHING';
  targetList: SetClauseItem[];
  insertCols?: ResTarget[];
  values?: Expr[] | null; // null => DEFAULT VALUES
  override?: 'SYSTEM' | 'USER';
}

export interface MergeStmt extends Loc {
  kind: 'MergeStmt';
  with?: WithClause;
  relation: RangeVar;
  source: FromItem;
  joinCondition: Expr;
  whenClauses: MergeWhenClause[];
  returning?: ReturningClause;
}

// ---- DDL ----

export interface ColumnDef extends Loc {
  name: string;
  typeName: TypeName;
  constraints: ColumnConstraint[];
  collate?: string[];
}

export type ColumnConstraint =
  | { kind: 'NOT_NULL'; name?: string }
  | { kind: 'NULL'; name?: string }
  | { kind: 'DEFAULT'; expr: Expr; name?: string }
  | { kind: 'PRIMARY_KEY'; name?: string; options?: IndexOptions }
  | { kind: 'UNIQUE'; name?: string; nullsNotDistinct?: boolean; options?: IndexOptions }
  | { kind: 'CHECK'; name?: string; expr: Expr; noInherit?: boolean; exprText: string }
  | { kind: 'REFERENCES'; name?: string; fk: ForeignKeySpec }
  | { kind: 'IDENTITY'; name?: string; always: boolean; seqOptions: SequenceOption[] }
  | { kind: 'GENERATED'; name?: string; expr: Expr; stored: boolean; exprText: string };

export interface IndexOptions {
  include?: string[];
  withOptions?: DefElem[];
  tablespace?: string;
}

export interface ForeignKeySpec {
  refTable: RangeVar;
  refColumns: string[];
  matchType: 'SIMPLE' | 'FULL' | 'PARTIAL';
  onDelete: FkAction;
  onUpdate: FkAction;
  deleteSetColumns?: string[];
  deferrable?: boolean;
  initiallyDeferred?: boolean;
}

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export type TableConstraint =
  | { kind: 'PRIMARY_KEY'; name?: string; columns: string[]; options?: IndexOptions; loc?: number }
  | { kind: 'UNIQUE'; name?: string; columns: string[]; nullsNotDistinct?: boolean; options?: IndexOptions; loc?: number }
  | { kind: 'CHECK'; name?: string; expr: Expr; noInherit?: boolean; exprText: string; notValid?: boolean; loc?: number }
  | { kind: 'FOREIGN_KEY'; name?: string; columns: string[]; fk: ForeignKeySpec; notValid?: boolean; loc?: number }
  | { kind: 'EXCLUDE'; name?: string; loc?: number };

export interface DefElem {
  name: string;
  value?: string | number | boolean | string[];
  namespace?: string;
}

export interface PartitionSpec {
  strategy: 'RANGE' | 'LIST' | 'HASH';
  params: IndexElem[];
}

export type PartitionBound =
  | { kind: 'DEFAULT' }
  | { kind: 'RANGE'; from: Expr[]; to: Expr[] }
  | { kind: 'LIST'; values: Expr[] }
  | { kind: 'HASH'; modulus: number; remainder: number };

export interface CreateTableStmt extends Loc {
  kind: 'CreateTableStmt';
  relation: RangeVar;
  temp: boolean;
  unlogged: boolean;
  ifNotExists: boolean;
  columns: ColumnDef[];
  constraints: TableConstraint[];
  inherits: RangeVar[];
  partitionSpec?: PartitionSpec;
  partitionOf?: RangeVar;
  partitionBound?: PartitionBound;
  onCommit?: 'DROP' | 'DELETE_ROWS' | 'PRESERVE_ROWS';
  withOptions?: DefElem[];
  like?: RangeVar[];
}

export interface CreateTableAsStmt extends Loc {
  kind: 'CreateTableAsStmt';
  relation: RangeVar;
  temp: boolean;
  ifNotExists: boolean;
  columnNames?: string[];
  query: Statement;
  withData: boolean;
  isMaterializedView: boolean;
  onCommit?: 'DROP' | 'DELETE_ROWS' | 'PRESERVE_ROWS';
}

export interface IndexElem {
  name?: string;
  expr?: Expr;
  exprText?: string;
  collation?: string[];
  opclass?: string[];
  opclassOptions?: DefElem[];
  ordering: 'DEFAULT' | 'ASC' | 'DESC';
  nullsOrdering: 'DEFAULT' | 'FIRST' | 'LAST';
}

export interface CreateIndexStmt extends Loc {
  kind: 'CreateIndexStmt';
  name?: string;
  relation: RangeVar;
  unique: boolean;
  concurrently: boolean;
  ifNotExists: boolean;
  method: string;
  params: IndexElem[];
  include: string[];
  withOptions: DefElem[];
  where: Expr | null;
  whereText?: string;
  nullsNotDistinct: boolean;
  only: boolean;
  tablespace?: string;
}

export type SequenceOption =
  | { name: 'as'; typeName: TypeName }
  | { name: 'increment'; value: string }
  | { name: 'minvalue'; value: string | null }
  | { name: 'maxvalue'; value: string | null }
  | { name: 'start'; value: string }
  | { name: 'restart'; value: string | null }
  | { name: 'cache'; value: string }
  | { name: 'cycle'; value: boolean }
  | { name: 'owned_by'; value: string[] | null }
  | { name: 'sequence_name'; value: string[] };

export interface CreateSequenceStmt extends Loc {
  kind: 'CreateSequenceStmt';
  sequence: RangeVar;
  temp: boolean;
  ifNotExists: boolean;
  options: SequenceOption[];
}

export interface AlterSequenceStmt extends Loc {
  kind: 'AlterSequenceStmt';
  sequence: RangeVar;
  ifExists: boolean;
  options: SequenceOption[];
}

export type AlterTableCmd =
  | { kind: 'ADD_COLUMN'; def: ColumnDef; ifNotExists: boolean }
  | { kind: 'DROP_COLUMN'; name: string; ifExists: boolean; cascade: boolean }
  | { kind: 'ALTER_COLUMN_TYPE'; name: string; typeName: TypeName; collate?: string[]; using?: Expr; usingText?: string }
  | { kind: 'SET_DEFAULT'; name: string; expr: Expr }
  | { kind: 'DROP_DEFAULT'; name: string }
  | { kind: 'SET_NOT_NULL'; name: string }
  | { kind: 'DROP_NOT_NULL'; name: string }
  | { kind: 'ADD_IDENTITY'; name: string; always: boolean; seqOptions: SequenceOption[] }
  | { kind: 'DROP_IDENTITY'; name: string; ifExists: boolean }
  | { kind: 'SET_IDENTITY'; name: string; always?: boolean; seqOptions: SequenceOption[] }
  | { kind: 'DROP_EXPRESSION'; name: string; ifExists: boolean }
  | { kind: 'SET_STATISTICS'; name: string; value: number }
  | { kind: 'SET_STORAGE'; name: string; value: string }
  | { kind: 'SET_COMPRESSION'; name: string; value: string }
  | { kind: 'SET_COLUMN_OPTIONS'; name: string; options: DefElem[]; reset: boolean }
  | { kind: 'ADD_CONSTRAINT'; constraint: TableConstraint; ifNotExists?: boolean }
  | { kind: 'DROP_CONSTRAINT'; name: string; ifExists: boolean; cascade: boolean }
  | { kind: 'VALIDATE_CONSTRAINT'; name: string }
  | { kind: 'RENAME_COLUMN'; oldName: string; newName: string }
  | { kind: 'RENAME_CONSTRAINT'; oldName: string; newName: string }
  | { kind: 'RENAME_TABLE'; newName: string }
  | { kind: 'SET_SCHEMA'; schema: string }
  | { kind: 'SET_OPTIONS'; options: DefElem[] }
  | { kind: 'RESET_OPTIONS'; options: DefElem[] }
  | { kind: 'ATTACH_PARTITION'; partition: RangeVar; bound: PartitionBound }
  | { kind: 'DETACH_PARTITION'; partition: RangeVar; concurrently: boolean; finalize: boolean }
  | { kind: 'OWNER_TO'; owner: string }
  | { kind: 'SET_LOGGED'; logged: boolean }
  | { kind: 'ENABLE_TRIGGER'; name: string; enable: boolean }
  | { kind: 'REPLICA_IDENTITY'; value: string }
  | { kind: 'CLUSTER_ON'; name: string }
  | { kind: 'ROW_LEVEL_SECURITY'; enable: boolean; force?: boolean }
  | { kind: 'NOOP'; description: string };

export interface AlterTableStmt extends Loc {
  kind: 'AlterTableStmt';
  relation: RangeVar;
  objectType: 'TABLE' | 'INDEX' | 'VIEW' | 'MATERIALIZED VIEW' | 'SEQUENCE' | 'FOREIGN TABLE';
  ifExists: boolean;
  only: boolean;
  cmds: AlterTableCmd[];
}

export type DropObjectType =
  | 'TABLE'
  | 'INDEX'
  | 'SEQUENCE'
  | 'VIEW'
  | 'MATERIALIZED VIEW'
  | 'TYPE'
  | 'DOMAIN'
  | 'SCHEMA'
  | 'FUNCTION'
  | 'PROCEDURE'
  | 'ROUTINE'
  | 'AGGREGATE'
  | 'EXTENSION'
  | 'COLLATION'
  | 'STATISTICS'
  | 'TRIGGER'
  | 'POLICY'
  | 'RULE'
  | 'OPERATOR'
  | 'CAST'
  | 'FOREIGN TABLE'
  | 'SERVER'
  | 'PUBLICATION'
  | 'ROLE'
  | 'DATABASE';

export interface DropStmt extends Loc {
  kind: 'DropStmt';
  objectType: DropObjectType;
  objects: { names: string[]; args?: TypeName[]; onTable?: RangeVar }[];
  ifExists: boolean;
  cascade: boolean;
  concurrently: boolean;
}

export interface TruncateStmt extends Loc {
  kind: 'TruncateStmt';
  relations: RangeVar[];
  restartIdentity: boolean;
  cascade: boolean;
}

export interface CreateSchemaStmt extends Loc {
  kind: 'CreateSchemaStmt';
  name: string;
  ifNotExists: boolean;
  authorization?: string;
}

export interface CreateEnumStmt extends Loc {
  kind: 'CreateEnumStmt';
  typeName: string[];
  labels: string[];
}

export interface CreateDomainStmt extends Loc {
  kind: 'CreateDomainStmt';
  domainName: string[];
  typeName: TypeName;
  constraints: ColumnConstraint[];
  collate?: string[];
}

export interface CreateCompositeTypeStmt extends Loc {
  kind: 'CreateCompositeTypeStmt';
  typeName: string[];
  columns: ColumnDefShort[];
}

export interface AlterEnumStmt extends Loc {
  kind: 'AlterEnumStmt';
  typeName: string[];
  newVal?: string;
  oldVal?: string;
  newValNeighbor?: string;
  newValIsAfter?: boolean;
  skipIfNewValExists: boolean;
  rename?: boolean;
}

export interface FunctionParameter {
  name?: string;
  typeName: TypeName;
  mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC' | 'TABLE';
  defexpr?: Expr;
}

export interface CreateFunctionStmt extends Loc {
  kind: 'CreateFunctionStmt';
  isProcedure: boolean;
  replace: boolean;
  funcname: string[];
  parameters: FunctionParameter[];
  returnType?: TypeName;
  returnsTable?: ColumnDefShort[];
  language: string;
  body: string;
  /** SQL-standard body (BEGIN ATOMIC / RETURN expr) */
  sqlBody?: Statement[];
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE';
  strict: boolean;
  securityDefiner: boolean;
  parallel?: string;
  setOptions?: DefElem[];
}

export interface CreateTriggerStmt extends Loc {
  kind: 'CreateTriggerStmt';
  replace: boolean;
  name: string;
  relation: RangeVar;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
  updateColumns?: string[];
  forEachRow: boolean;
  when: Expr | null;
  funcname: string[];
  args: string[];
}

export interface ViewStmt extends Loc {
  kind: 'ViewStmt';
  view: RangeVar;
  replace: boolean;
  temp: boolean;
  aliases?: string[];
  query: SelectStmt;
  queryText: string;
  withCheckOption?: string;
  options?: DefElem[];
}

export interface CreateExtensionStmt extends Loc {
  kind: 'CreateExtensionStmt';
  name: string;
  ifNotExists: boolean;
  schema?: string;
  version?: string;
  cascade: boolean;
}

export interface CreateCollationStmt extends Loc {
  kind: 'CreateCollationStmt';
  name: string[];
  ifNotExists: boolean;
  options: DefElem[];
  from?: string[];
}

export interface CreateStatsStmt extends Loc {
  kind: 'CreateStatsStmt';
  name?: string[];
  ifNotExists: boolean;
  kinds: string[];
  exprs: { name?: string; expr?: Expr; exprText?: string }[];
  relation: RangeVar;
}

export interface CommentStmt extends Loc {
  kind: 'CommentStmt';
  objectType: string;
  object: string[];
  columnTable?: string[];
  comment: string | null;
}

export interface TransactionStmt extends Loc {
  kind: 'TransactionStmt';
  op: 'BEGIN' | 'START' | 'COMMIT' | 'ROLLBACK' | 'SAVEPOINT' | 'RELEASE' | 'ROLLBACK_TO' | 'PREPARE' | 'COMMIT_PREPARED' | 'ROLLBACK_PREPARED';
  savepointName?: string;
  gid?: string;
  chain?: boolean;
  options: { isolation?: string; readOnly?: boolean; deferrable?: boolean };
}

export interface VariableSetStmt extends Loc {
  kind: 'VariableSetStmt';
  mode: 'VALUE' | 'DEFAULT' | 'CURRENT' | 'RESET' | 'RESET_ALL' | 'MULTI';
  name: string;
  values: (string | number)[];
  isLocal: boolean;
  /** SET TRANSACTION / SET SESSION CHARACTERISTICS */
  transactionOptions?: { isolation?: string; readOnly?: boolean; deferrable?: boolean };
}

export interface VariableShowStmt extends Loc {
  kind: 'VariableShowStmt';
  name: string;
}

export interface DoStmt extends Loc {
  kind: 'DoStmt';
  body: string;
  language: string;
}

export interface ExplainStmt extends Loc {
  kind: 'ExplainStmt';
  query: Statement;
  options: DefElem[];
}

export interface GenericNoopStmt extends Loc {
  kind: 'NoopStmt';
  /** command tag reported to the client */
  tag: string;
  description: string;
}

export interface LockStmt extends Loc {
  kind: 'LockStmt';
  relations: RangeVar[];
  mode: string;
  nowait: boolean;
}

export interface AlterDatabaseSetStmt extends Loc {
  kind: 'AlterDatabaseSetStmt';
  dbname: string;
  set: VariableSetStmt;
}

export interface CallStmt extends Loc {
  kind: 'CallStmt';
  func: FuncCall;
}

export interface PrepareStmt extends Loc {
  kind: 'PrepareStmt';
  name: string;
  argTypes: TypeName[];
  query: Statement;
}

export interface ExecuteStmt extends Loc {
  kind: 'ExecuteStmt';
  name: string;
  params: Expr[];
}

export interface DeallocateStmt extends Loc {
  kind: 'DeallocateStmt';
  name?: string;
}

export interface RenameStmt extends Loc {
  kind: 'RenameStmt';
  objectType: 'TABLE' | 'INDEX' | 'SEQUENCE' | 'VIEW' | 'COLUMN' | 'CONSTRAINT' | 'SCHEMA' | 'TYPE' | 'FUNCTION';
  relation?: RangeVar;
  object?: string[];
  subname?: string;
  newname: string;
  ifExists: boolean;
}

export interface AlterTypeStmt extends Loc {
  kind: 'AlterTypeStmt';
  typeName: string[];
  action: 'RENAME' | 'OWNER' | 'SET_SCHEMA' | 'NOOP';
  newName?: string;
}

export interface NotifyStmt extends Loc {
  kind: 'NotifyStmt';
  channel: string;
  payload?: string;
}

export interface ListenStmt extends Loc {
  kind: 'ListenStmt';
  channel: string;
  unlisten: boolean;
}

export interface RefreshMatViewStmt extends Loc {
  kind: 'RefreshMatViewStmt';
  relation: RangeVar;
  concurrently: boolean;
  withData: boolean;
}

export interface CopyStmt extends Loc {
  kind: 'CopyStmt';
}

export type Statement =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | MergeStmt
  | CreateTableStmt
  | CreateTableAsStmt
  | CreateIndexStmt
  | CreateSequenceStmt
  | AlterSequenceStmt
  | AlterTableStmt
  | DropStmt
  | TruncateStmt
  | CreateSchemaStmt
  | CreateEnumStmt
  | CreateDomainStmt
  | CreateCompositeTypeStmt
  | AlterEnumStmt
  | CreateFunctionStmt
  | CreateTriggerStmt
  | ViewStmt
  | CreateExtensionStmt
  | CreateCollationStmt
  | CreateStatsStmt
  | CommentStmt
  | TransactionStmt
  | VariableSetStmt
  | VariableShowStmt
  | DoStmt
  | ExplainStmt
  | GenericNoopStmt
  | LockStmt
  | AlterDatabaseSetStmt
  | CallStmt
  | PrepareStmt
  | ExecuteStmt
  | DeallocateStmt
  | RenameStmt
  | AlterTypeStmt
  | NotifyStmt
  | ListenStmt
  | RefreshMatViewStmt
  | CopyStmt;

export interface ParsedStatement {
  stmt: Statement;
  /** source text of this statement (for pg_stat / error context / DDL body capture) */
  text: string;
  start: number;
  end: number;
}
