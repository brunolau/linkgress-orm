import type * as A from '../ast';
import { PgError, SqlState } from '../errors';
import {
  BUILTIN_AGGREGATES,
  BUILTIN_AMS,
  BUILTIN_CASTS,
  BUILTIN_COLLATIONS,
  BUILTIN_NAMESPACES,
  BUILTIN_OPCLASSES,
  BUILTIN_OPERATORS,
  BUILTIN_PROCS,
  BUILTIN_RELATIONS,
  BUILTIN_TYPES,
} from './builtin-data';

/**
 * The system catalog of the in-memory database.
 *
 * Builtin objects (types, functions, operators, casts, ...) are loaded once from data generated off a
 * real PostgreSQL 18 catalog and shared by every database. User objects live in a {@link Catalog}
 * instance that is versioned copy-on-write: a transaction performing DDL works on a private clone that
 * replaces the committed catalog at COMMIT, so DDL is transactional just like in PostgreSQL.
 */

export const NS_PG_CATALOG = 11;
export const NS_PG_TOAST = 99;
export const NS_PUBLIC = 2200;
export const FIRST_NORMAL_OID = 16384;

export const TypeOid = {
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int2vector: 22,
  int4: 23,
  regproc: 24,
  text: 25,
  oid: 26,
  tid: 27,
  xid: 28,
  cid: 29,
  oidvector: 30,
  json: 114,
  xml: 142,
  pg_node_tree: 194,
  point: 600,
  float4: 700,
  float8: 701,
  unknown: 705,
  money: 790,
  inet: 869,
  cidr: 650,
  macaddr: 829,
  aclitem: 1033,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  bit: 1560,
  varbit: 1562,
  numeric: 1700,
  refcursor: 1790,
  regprocedure: 2202,
  regoper: 2203,
  regoperator: 2204,
  regclass: 2205,
  regtype: 2206,
  record: 2249,
  cstring: 2275,
  any: 2276,
  anyarray: 2277,
  void: 2278,
  trigger: 2279,
  anyelement: 2283,
  anynonarray: 2776,
  uuid: 2950,
  anyenum: 3500,
  tsvector: 3614,
  tsquery: 3615,
  regconfig: 3734,
  jsonb: 3802,
  jsonpath: 4072,
  regnamespace: 4089,
  regrole: 4096,
  regcollation: 4191,
  anyrange: 3831,
  anymultirange: 4537,
  anycompatible: 5077,
  anycompatiblearray: 5078,
  anycompatiblenonarray: 5079,
  anycompatiblerange: 5080,
  anycompatiblemultirange: 4538,
  internal: 2281,
  pg_lsn: 3220,
  _text: 1009,
  _int4: 1007,
  _int2: 1005,
  _int8: 1016,
  _bool: 1000,
  _float8: 1022,
  _numeric: 1231,
  _varchar: 1015,
  _uuid: 2951,
  _json: 199,
  _jsonb: 3807,
  _record: 2287,
  _name: 1003,
  _char: 1002,
  _oid: 1028,
  _timestamptz: 1185,
  _timestamp: 1115,
  _date: 1182,
} as const;

export const COLL_DEFAULT = 100;
export const COLL_C = 950;
export const COLL_POSIX = 951;

// ---------------------------------------------------------------------------
// Object definitions
// ---------------------------------------------------------------------------

export interface PgType {
  oid: number;
  name: string;
  nspOid: number;
  len: number;
  byval: boolean;
  /** b base, c composite, d domain, e enum, p pseudo, r range, m multirange */
  typtype: string;
  category: string;
  preferred: boolean;
  delim: string;
  /** element type for array types (0 otherwise) */
  elem: number;
  /** array type of this type (0 if none) */
  array: number;
  baseType: number;
  typmod: number;
  collation: number;
  align: string;
  storage: string;
  /** composite: relation oid */
  relid: number;
  /** true for true array types (typsubscript = array_subscript_handler & typelem set) */
  isArray: boolean;
  enumLabels?: EnumLabel[];
  domainNotNull?: boolean;
  domainDefault?: StoredExpr;
  domainChecks?: { name: string; expr: StoredExpr }[];
  ownerSessionId?: number;
}

export interface EnumLabel {
  oid: number;
  label: string;
  sortOrder: number;
}

/** An expression kept in the catalog: raw parse tree plus its source text. */
export interface StoredExpr {
  raw: A.Expr;
  text: string;
  /** cached analyzed/deparsed forms (filled lazily by the analyzer) */
  cache?: Record<string, unknown>;
}

export interface Column {
  attnum: number;
  name: string;
  typeOid: number;
  typmod: number;
  notNull: boolean;
  collation: number;
  defaultExpr?: StoredExpr;
  /** '' | 'a' (ALWAYS) | 'd' (BY DEFAULT) */
  identity: '' | 'a' | 'd';
  /** '' | 's' stored | 'v' virtual */
  generated: '' | 's' | 'v';
  isDropped: boolean;
  /** value for tuples created before this column existed (attmissingval) */
  hasMissing: boolean;
  missingValue: unknown;
  statsTarget: number;
  storage?: string;
  compression?: string;
  options?: string[];
  inhCount: number;
  isLocal: boolean;
  /** dimensions declared ([]) — informational */
  ndims: number;
  /** identity sequence oid */
  identitySeqOid?: number;
}

export type RelKind = 'r' | 'i' | 'S' | 'v' | 'm' | 'c' | 'p' | 'I' | 'f';

export interface IndexElemDef {
  /** attnum (>0) or 0 for expression */
  attnum: number;
  expr?: StoredExpr;
  collation: number;
  opclassOid: number;
  desc: boolean;
  nullsFirst: boolean;
  /** explicit opclass given */
  opclassExplicit: boolean;
  opclassOptions?: A.DefElem[];
}

export interface IndexInfo {
  tableOid: number;
  unique: boolean;
  primary: boolean;
  exclusion: boolean;
  immediate: boolean;
  keys: IndexElemDef[];
  include: number[];
  predicate?: StoredExpr;
  method: string;
  nullsNotDistinct: boolean;
  valid: boolean;
  constraintOid: number;
}

export interface SequenceInfo {
  typeOid: number;
  start: bigint;
  increment: bigint;
  min: bigint;
  max: bigint;
  cache: bigint;
  cycle: boolean;
  ownedBy?: { relOid: number; attnum: number; identity: boolean };
  /** shared, non-transactional sequence state */
  state: SequenceState;
}

export interface SequenceState {
  lastValue: bigint;
  isCalled: boolean;
  /** values left before the next (simulated) WAL record, as pg_sequence reports log_cnt */
  logCnt?: number;
}

export interface PartitionKeyDef {
  strategy: 'r' | 'l' | 'h';
  keys: IndexElemDef[];
}

export interface Relation {
  oid: number;
  name: string;
  nspOid: number;
  kind: RelKind;
  /** p permanent, t temporary, u unlogged */
  persistence: 'p' | 't' | 'u';
  columns: Column[];
  rowTypeOid: number;
  /** storage identifier (relfilenode); changes on TRUNCATE / rewrites */
  storageId: number;
  options: string[];
  comment?: string;
  index?: IndexInfo;
  sequence?: SequenceInfo;
  view?: { query: A.SelectStmt; text: string; checkOption?: string };
  partitionKey?: PartitionKeyDef;
  partitionBound?: A.PartitionBound;
  partitionBoundText?: string;
  parentOid?: number;
  inheritsFrom: number[];
  ownerSessionId?: number;
  onCommit?: 'DROP' | 'DELETE_ROWS' | 'PRESERVE_ROWS';
  hasTriggers: boolean;
  /** matview populated */
  populated: boolean;
  isBuiltinCatalog?: boolean;
  columnComments?: Map<number, string>;
}

export type ConstraintType = 'p' | 'u' | 'f' | 'c' | 'x' | 'n' | 't';

export interface Constraint {
  oid: number;
  name: string;
  nspOid: number;
  type: ConstraintType;
  relOid: number;
  /** domain constraints */
  typeOid: number;
  columns: number[];
  indexOid: number;
  fk?: {
    refRelOid: number;
    refColumns: number[];
    onDelete: A.FkAction;
    onUpdate: A.FkAction;
    matchType: 'SIMPLE' | 'FULL' | 'PARTIAL';
    deleteSetColumns?: number[];
  };
  check?: StoredExpr;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
  noInherit: boolean;
  isLocal: boolean;
  inhCount: number;
  comment?: string;
}

export interface ProcDef {
  oid: number;
  name: string;
  nspOid: number;
  /** f function, a aggregate, w window, p procedure */
  kind: 'f' | 'a' | 'w' | 'p';
  strict: boolean;
  retset: boolean;
  volatile: 'i' | 's' | 'v';
  nargdefaults: number;
  rettype: number;
  argtypes: number[];
  allargtypes?: number[];
  argmodes?: string[];
  argnames?: string[];
  variadic: number;
  src: string;
  lang: string;
  /** builtin: deparsed default expressions ("a, b"); user: raw exprs */
  argdefaultsText?: string;
  argdefaults?: A.Expr[];
  /** user-defined function body */
  body?: string;
  sqlBody?: A.Statement[];
  returnsTable?: { name: string; typeOid: number; typmod: number }[];
  outParams?: { name?: string; typeOid: number }[];
  isBuiltin: boolean;
  parallel?: string;
  setOptions?: A.DefElem[];
  securityDefiner?: boolean;
  comment?: string;
}

export interface OperatorDef {
  oid: number;
  name: string;
  nspOid: number;
  kind: 'b' | 'l';
  left: number;
  right: number;
  result: number;
  commutator: number;
  negator: number;
  codeSrc: string;
  codeOid: number;
}

export interface CastDef {
  source: number;
  target: number;
  funcOid: number;
  funcSrc: string;
  funcName: string;
  /** e explicit, a assignment, i implicit */
  context: 'e' | 'a' | 'i';
  /** f function, b binary coercible, i I/O */
  method: 'f' | 'b' | 'i';
}

export interface AggregateDef {
  fnoid: number;
  kind: 'n' | 'o' | 'h';
  ndirect: number;
  transSrc: string;
  finalSrc: string;
  transtype: number;
  initval: string | null;
  sortop: number;
}

export interface OpClassDef {
  oid: number;
  am: string;
  name: string;
  nspOid: number;
  inputType: number;
  isDefault: boolean;
  family: number;
  keyType: number;
}

export interface CollationDef {
  oid: number;
  name: string;
  nspOid: number;
  provider: string;
  deterministic: boolean;
  encoding: number;
  locale?: string;
  options?: A.DefElem[];
}

export interface ExtensionDef {
  oid: number;
  name: string;
  nspOid: number;
  version: string;
}

export interface StatisticsDef {
  oid: number;
  name: string;
  nspOid: number;
  relOid: number;
  kinds: string[];
  columns: number[];
  exprs: StoredExpr[];
  statsTarget: number;
}

export interface TriggerDef {
  oid: number;
  name: string;
  relOid: number;
  funcOid: number;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: string[];
  updateColumns?: string[];
  forEachRow: boolean;
  /** transition table names (REFERENCING NEW TABLE AS … / OLD TABLE AS …) */
  newTable?: string;
  oldTable?: string;
  when: A.Expr | null;
  whenText?: string;
  args: string[];
  enabled: boolean;
}

export interface NamespaceDef {
  oid: number;
  name: string;
  ownerSessionId?: number;
  comment?: string;
}

// ---------------------------------------------------------------------------
// Builtin catalog (immutable, shared)
// ---------------------------------------------------------------------------

export class BuiltinCatalog {
  readonly types = new Map<number, PgType>();
  readonly typesByName = new Map<string, PgType>();
  readonly procs = new Map<number, ProcDef>();
  readonly procsByName = new Map<string, ProcDef[]>();
  readonly operators = new Map<number, OperatorDef>();
  readonly operatorsByName = new Map<string, OperatorDef[]>();
  readonly casts = new Map<string, CastDef>();
  readonly castsBySource = new Map<number, CastDef[]>();
  readonly aggregates = new Map<number, AggregateDef>();
  readonly opclasses = new Map<number, OpClassDef>();
  readonly ams = new Map<number, { oid: number; name: string; type: string }>();
  readonly collations = new Map<number, CollationDef>();
  readonly namespaces = new Map<number, NamespaceDef>();
  readonly relations = new Map<number, Relation>();
  informationSchemaOid = 0;

  private static instance: BuiltinCatalog | null = null;

  static get(): BuiltinCatalog {
    if (!BuiltinCatalog.instance) {
      BuiltinCatalog.instance = new BuiltinCatalog();
    }
    return BuiltinCatalog.instance;
  }

  private constructor() {
    for (const [oid, name] of BUILTIN_NAMESPACES) {
      this.namespaces.set(oid, { oid, name });
      if (name === 'information_schema') {
        this.informationSchemaOid = oid;
      }
    }
    for (const t of BUILTIN_TYPES) {
      const [oid, name, ns, len, byval, typtype, category, preferred, delim, elem, array, basetype, typmod, collation, align, storage] = t;
      const type: PgType = {
        oid,
        name,
        nspOid: ns === 0 ? NS_PG_CATALOG : this.informationSchemaOid,
        len,
        byval: byval === 1,
        typtype,
        category,
        preferred: preferred === 1,
        delim,
        elem,
        array,
        baseType: basetype,
        typmod,
        collation,
        align,
        storage,
        relid: 0,
        // record[] is a pseudo-type but a true array type (typsubscript = array_subscript_handler)
        isArray: (category === 'A' || oid === TypeOid._record) && elem !== 0 && name.startsWith('_'),
      };
      this.types.set(oid, type);
      this.typesByName.set(type.nspOid + '.' + name, type);
    }
    for (const p of BUILTIN_PROCS) {
      const [oid, name, kind, strict, retset, volatile, nargdefaults, rettype, argtypes, allargtypes, argmodes, argnames, variadic, src, lang, argdefaults] = p;
      const proc: ProcDef = {
        oid,
        name,
        nspOid: NS_PG_CATALOG,
        kind,
        strict: strict === 1,
        retset: retset === 1,
        volatile,
        nargdefaults,
        rettype,
        argtypes,
        allargtypes: allargtypes || undefined,
        argmodes: argmodes || undefined,
        argnames: argnames || undefined,
        variadic,
        src: src || name,
        lang,
        argdefaultsText: argdefaults || undefined,
        isBuiltin: true,
      };
      this.procs.set(oid, proc);
      let list = this.procsByName.get(name);
      if (!list) {
        list = [];
        this.procsByName.set(name, list);
      }
      list.push(proc);
    }
    for (const o of BUILTIN_OPERATORS) {
      const [oid, name, kind, left, right, result, com, neg, codeSrc, codeOid] = o;
      const op: OperatorDef = { oid, name, nspOid: NS_PG_CATALOG, kind, left, right, result, commutator: com, negator: neg, codeSrc, codeOid };
      this.operators.set(oid, op);
      let list = this.operatorsByName.get(name);
      if (!list) {
        list = [];
        this.operatorsByName.set(name, list);
      }
      list.push(op);
    }
    for (const c of BUILTIN_CASTS) {
      const [source, target, funcOid, funcSrc, funcName, context, method] = c;
      const cast: CastDef = { source, target, funcOid, funcSrc, funcName, context, method };
      this.casts.set(source + ':' + target, cast);
      let list = this.castsBySource.get(source);
      if (!list) {
        list = [];
        this.castsBySource.set(source, list);
      }
      list.push(cast);
    }
    for (const a of BUILTIN_AGGREGATES) {
      const [fnoid, kind, ndirect, transSrc, finalSrc, transtype, initval, sortop] = a;
      this.aggregates.set(fnoid, { fnoid, kind, ndirect, transSrc, finalSrc, transtype, initval, sortop });
    }
    for (const o of BUILTIN_OPCLASSES) {
      const [oid, am, name, ns, inputType, isDefault, family, keyType] = o;
      this.opclasses.set(oid, { oid, am, name, nspOid: ns === 0 ? NS_PG_CATALOG : this.informationSchemaOid, inputType, isDefault: isDefault === 1, family, keyType });
    }
    for (const [oid, name, type] of BUILTIN_AMS) {
      this.ams.set(oid, { oid, name, type });
    }
    for (const c of BUILTIN_COLLATIONS) {
      const [oid, name, provider, deterministic, encoding] = c;
      this.collations.set(oid, { oid, name, nspOid: NS_PG_CATALOG, provider, deterministic: deterministic === 1, encoding });
    }
    for (const r of BUILTIN_RELATIONS) {
      const [ns, relname, relkind, oid, cols] = r;
      const rel: Relation = {
        oid,
        name: relname,
        nspOid: ns === 0 ? NS_PG_CATALOG : this.informationSchemaOid,
        kind: relkind,
        persistence: 'p',
        columns: (cols as any[]).map(([attname, atttypid, atttypmod, notnull], i) => ({
          attnum: i + 1,
          name: attname,
          typeOid: atttypid,
          typmod: atttypmod,
          notNull: notnull === 1,
          collation: 0,
          identity: '' as const,
          generated: '' as const,
          isDropped: false,
          hasMissing: false,
          missingValue: null,
          statsTarget: -1,
          inhCount: 0,
          isLocal: true,
          ndims: 0,
        })),
        rowTypeOid: 0,
        storageId: 0,
        options: [],
        inheritsFrom: [],
        hasTriggers: false,
        populated: true,
        isBuiltinCatalog: true,
      };
      this.relations.set(oid, rel);
    }
  }
}

// ---------------------------------------------------------------------------
// User catalog (versioned)
// ---------------------------------------------------------------------------

export class Catalog {
  readonly builtin: BuiltinCatalog;
  namespaces: Map<number, NamespaceDef>;
  types: Map<number, PgType>;
  relations: Map<number, Relation>;
  constraints: Map<number, Constraint>;
  procs: Map<number, ProcDef>;
  collations: Map<number, CollationDef>;
  extensions: Map<number, ExtensionDef>;
  statistics: Map<number, StatisticsDef>;
  triggers: Map<number, TriggerDef>;
  operators: Map<number, OperatorDef>;
  /** pg_db_role_setting for the current database: name -> value */
  dbSettings: Map<string, string>;
  /** COMMENT ON for objects without a dedicated slot: "classoid:objoid:subid" -> text */
  comments: Map<string, string>;
  /** derived indexes, rebuilt lazily */
  private nameIndex: Map<string, number> | null = null;
  private procNameIndex: Map<string, ProcDef[]> | null = null;
  private typeNameIndex: Map<string, PgType> | null = null;
  version = 0;

  constructor(builtin: BuiltinCatalog, from?: Catalog) {
    this.builtin = builtin;
    if (from) {
      this.namespaces = new Map(from.namespaces);
      this.types = new Map(from.types);
      this.relations = new Map(from.relations);
      this.constraints = new Map(from.constraints);
      this.procs = new Map(from.procs);
      this.collations = new Map(from.collations);
      this.extensions = new Map(from.extensions);
      this.statistics = new Map(from.statistics);
      this.triggers = new Map(from.triggers);
      this.operators = new Map(from.operators);
      this.dbSettings = new Map(from.dbSettings);
      this.comments = new Map(from.comments);
      this.version = from.version;
    } else {
      this.namespaces = new Map();
      this.types = new Map();
      this.relations = new Map();
      this.constraints = new Map();
      this.procs = new Map();
      this.collations = new Map();
      this.extensions = new Map();
      this.statistics = new Map();
      this.triggers = new Map();
      this.operators = new Map();
      this.dbSettings = new Map();
      this.comments = new Map();
      this.namespaces.set(NS_PUBLIC, { oid: NS_PUBLIC, name: 'public' });
      // plpgsql is always installed
      this.extensions.set(13600, { oid: 13600, name: 'plpgsql', nspOid: NS_PG_CATALOG, version: '1.0' });
    }
  }

  clone(): Catalog {
    return new Catalog(this.builtin, this);
  }

  invalidate(): void {
    this.nameIndex = null;
    this.procNameIndex = null;
    this.typeNameIndex = null;
    this.version++;
  }

  // ----- namespaces -----

  getNamespace(oid: number): NamespaceDef | undefined {
    return this.namespaces.get(oid) ?? this.builtin.namespaces.get(oid);
  }

  findNamespace(name: string): NamespaceDef | undefined {
    for (const ns of this.builtin.namespaces.values()) {
      if (ns.name === name) {
        return ns;
      }
    }
    for (const ns of this.namespaces.values()) {
      if (ns.name === name) {
        return ns;
      }
    }
    return undefined;
  }

  namespaceName(oid: number): string {
    return this.getNamespace(oid)?.name ?? String(oid);
  }

  // ----- relations -----

  getRelation(oid: number): Relation | undefined {
    return this.relations.get(oid) ?? this.builtin.relations.get(oid);
  }

  private buildNameIndex(): Map<string, number> {
    if (!this.nameIndex) {
      const idx = new Map<string, number>();
      for (const r of this.builtin.relations.values()) {
        idx.set(r.nspOid + '.' + r.name, r.oid);
      }
      for (const r of this.relations.values()) {
        idx.set(r.nspOid + '.' + r.name, r.oid);
      }
      this.nameIndex = idx;
    }
    return this.nameIndex;
  }

  findRelationInNamespace(nspOid: number, name: string): Relation | undefined {
    const oid = this.buildNameIndex().get(nspOid + '.' + name);
    return oid !== undefined ? this.getRelation(oid) : undefined;
  }

  /** Any relation-class object name clash (tables, indexes, sequences, views, composite types' relations). */
  relationNameTaken(nspOid: number, name: string): Relation | undefined {
    return this.findRelationInNamespace(nspOid, name);
  }

  // ----- types -----

  getType(oid: number): PgType | undefined {
    return this.builtin.types.get(oid) ?? this.types.get(oid);
  }

  requireType(oid: number): PgType {
    const t = this.getType(oid);
    if (!t) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `cache lookup failed for type ${oid}`);
    }
    return t;
  }

  findTypeInNamespace(nspOid: number, name: string): PgType | undefined {
    const b = this.builtin.typesByName.get(nspOid + '.' + name);
    if (b) {
      return b;
    }
    if (!this.typeNameIndex) {
      const idx = new Map<string, PgType>();
      for (const t of this.types.values()) {
        idx.set(t.nspOid + '.' + t.name, t);
      }
      this.typeNameIndex = idx;
    }
    return this.typeNameIndex.get(nspOid + '.' + name);
  }

  // ----- procs -----

  getProc(oid: number): ProcDef | undefined {
    return this.builtin.procs.get(oid) ?? this.procs.get(oid);
  }

  findProcsByName(name: string): ProcDef[] {
    if (!this.procNameIndex) {
      const idx = new Map<string, ProcDef[]>();
      for (const p of this.procs.values()) {
        let l = idx.get(p.name);
        if (!l) {
          l = [];
          idx.set(p.name, l);
        }
        l.push(p);
      }
      this.procNameIndex = idx;
    }
    const b = this.builtin.procsByName.get(name) ?? [];
    const u = this.procNameIndex.get(name) ?? [];
    return u.length ? [...b, ...u] : b;
  }

  userOperatorsByName(name: string): OperatorDef[] {
    if (this.operators.size === 0) {
      return [];
    }
    const out: OperatorDef[] = [];
    for (const op of this.operators.values()) {
      if (op.name === name) {
        out.push(op);
      }
    }
    return out;
  }

  getOperator(oid: number): OperatorDef | undefined {
    return this.builtin.operators.get(oid) ?? this.operators.get(oid);
  }

  getConstraint(oid: number): Constraint | undefined {
    return this.constraints.get(oid);
  }

  /** Per-relation lookups derived from the maps, rebuilt whenever the catalog changes. */
  private derived: {
    version: number;
    relations: number;
    constraints: number;
    constraintsByRel: Map<number, Constraint[]>;
    indexesByTable: Map<number, Relation[]>;
    childrenByParent: Map<number, Relation[]>;
    foreignKeysByReferenced: Map<number, Constraint[]>;
  } | null = null;

  private derivedIndex() {
    const d = this.derived;
    if (d && d.version === this.version && d.relations === this.relations.size && d.constraints === this.constraints.size) {
      return d;
    }
    const push = <T>(m: Map<number, T[]>, k: number, v: T) => {
      const list = m.get(k);
      if (list) {
        list.push(v);
      } else {
        m.set(k, [v]);
      }
    };
    const constraintsByRel = new Map<number, Constraint[]>();
    const foreignKeysByReferenced = new Map<number, Constraint[]>();
    for (const c of this.constraints.values()) {
      push(constraintsByRel, c.relOid, c);
      if (c.type === 'f' && c.fk) {
        push(foreignKeysByReferenced, c.fk.refRelOid, c);
      }
    }
    const indexesByTable = new Map<number, Relation[]>();
    const childrenByParent = new Map<number, Relation[]>();
    for (const r of this.relations.values()) {
      if ((r.kind === 'i' || r.kind === 'I') && r.index) {
        push(indexesByTable, r.index.tableOid, r);
      }
      const parents = new Set<number>();
      if (r.parentOid) {
        parents.add(r.parentOid);
      }
      for (const p of r.inheritsFrom ?? []) {
        parents.add(p);
      }
      for (const p of parents) {
        push(childrenByParent, p, r);
      }
    }
    const byOid = (a: { oid: number }, b: { oid: number }) => a.oid - b.oid;
    for (const list of constraintsByRel.values()) {
      list.sort(byOid);
    }
    for (const list of indexesByTable.values()) {
      list.sort(byOid);
    }
    for (const list of foreignKeysByReferenced.values()) {
      list.sort(byOid);
    }
    this.derived = { version: this.version, relations: this.relations.size, constraints: this.constraints.size, constraintsByRel, indexesByTable, childrenByParent, foreignKeysByReferenced };
    return this.derived;
  }

  constraintsOf(relOid: number): Constraint[] {
    return (this.derivedIndex().constraintsByRel.get(relOid) ?? []).slice();
  }

  indexesOf(relOid: number): Relation[] {
    return (this.derivedIndex().indexesByTable.get(relOid) ?? []).slice();
  }

  /** Partitions and inheritance children, in catalog order. */
  childrenOf(relOid: number): Relation[] {
    return this.derivedIndex().childrenByParent.get(relOid) ?? [];
  }

  /** Foreign keys referencing a relation, by constraint oid. */
  foreignKeysReferencing(relOid: number): Constraint[] {
    return (this.derivedIndex().foreignKeysByReferenced.get(relOid) ?? []).slice();
  }

  getCollation(oid: number): CollationDef | undefined {
    return this.builtin.collations.get(oid) ?? this.collations.get(oid);
  }

  findCollation(nspOid: number | null, name: string): CollationDef | undefined {
    for (const c of this.builtin.collations.values()) {
      if (c.name === name && (nspOid === null || c.nspOid === nspOid)) {
        return c;
      }
    }
    for (const c of this.collations.values()) {
      if (c.name === name && (nspOid === null || c.nspOid === nspOid)) {
        return c;
      }
    }
    return undefined;
  }

  // ----- mutation helpers (callers must operate on a cloned catalog inside a transaction) -----

  putRelation(rel: Relation): void {
    this.relations.set(rel.oid, rel);
    this.invalidate();
  }

  removeRelation(oid: number): void {
    this.relations.delete(oid);
    this.invalidate();
  }

  putType(t: PgType): void {
    this.types.set(t.oid, t);
    this.invalidate();
  }

  removeType(oid: number): void {
    this.types.delete(oid);
    this.invalidate();
  }

  putConstraint(c: Constraint): void {
    this.constraints.set(c.oid, c);
    this.invalidate();
  }

  removeConstraint(oid: number): void {
    this.constraints.delete(oid);
    this.invalidate();
  }

  putProc(p: ProcDef): void {
    this.procs.set(p.oid, p);
    this.invalidate();
  }

  removeProc(oid: number): void {
    this.procs.delete(oid);
    this.invalidate();
  }
}

/** Shared OID allocator (OIDs are never rolled back, like PostgreSQL). */
export class OidAllocator {
  private next = FIRST_NORMAL_OID;

  allocate(): number {
    return this.next++;
  }

  /** next oid to be handed out (snapshots) */
  get nextOid(): number {
    return this.next;
  }

  set nextOid(value: number) {
    this.next = value;
  }
}

export function cloneRelation(rel: Relation, patch: Partial<Relation> = {}): Relation {
  return { ...rel, columns: rel.columns.map((c) => ({ ...c })), ...patch };
}

export function liveColumns(rel: Relation): Column[] {
  return rel.columns.filter((c) => !c.isDropped);
}
