import * as A from '../ast';
import { Catalog, Column, Constraint, IndexElemDef, NS_PG_CATALOG, PgType, Relation, SequenceInfo, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Session } from '../session';

export const NAMEDATALEN = 64;

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function clipBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) {
    return s;
  }
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const l = byteLen(ch);
    if (bytes + l > maxBytes) {
      break;
    }
    out += ch;
    bytes += l;
  }
  return out;
}

/** makeObjectName (src/backend/commands/indexcmds.c) */
export function makeObjectName(name1: string, name2: string | null, label: string | null): string {
  let overhead = 0;
  let name1chars = byteLen(name1);
  let name2chars = 0;
  if (name2 !== null) {
    name2chars = byteLen(name2);
    overhead++;
  }
  if (label !== null) {
    overhead += byteLen(label) + 1;
  }
  const avail = NAMEDATALEN - 1 - overhead;
  while (name1chars + name2chars > avail) {
    if (name1chars > name2chars) {
      name1chars--;
    } else {
      name2chars--;
    }
  }
  let name = clipBytes(name1, name1chars);
  if (name2 !== null) {
    name += '_' + clipBytes(name2, name2chars);
  }
  if (label !== null) {
    name += '_' + label;
  }
  return name;
}

export function constraintNameExists(cat: Catalog, name: string, nspOid: number): boolean {
  for (const c of cat.constraints.values()) {
    if (c.name === name && c.nspOid === nspOid) {
      return true;
    }
  }
  return false;
}

export function chooseRelationName(cat: Catalog, name1: string, name2: string | null, label: string, nspOid: number, isConstraint: boolean, others: string[] = []): string {
  let pass = 0;
  let modlabel = label;
  for (;;) {
    const name = makeObjectName(name1, name2, modlabel);
    if (!cat.findRelationInNamespace(nspOid, name) && !others.includes(name)) {
      if (!isConstraint || !constraintNameExists(cat, name, nspOid)) {
        return name;
      }
    }
    modlabel = label + ++pass;
  }
}

export function chooseConstraintName(cat: Catalog, name1: string, name2: string | null, label: string, nspOid: number, others: string[]): string {
  let pass = 0;
  let modlabel = label;
  for (;;) {
    const name = makeObjectName(name1, name2, modlabel);
    if (!constraintNameExists(cat, name, nspOid) && !others.includes(name)) {
      return name;
    }
    modlabel = label + ++pass;
  }
}

/** ChooseIndexNameAddition: column names joined by '_' (bounded by NAMEDATALEN). */
export function indexNameAddition(colnames: string[]): string {
  let buf = '';
  for (const name of colnames) {
    if (buf.length > 0) {
      buf += '_';
    }
    buf += name;
    if (byteLen(buf) >= NAMEDATALEN) {
      break;
    }
  }
  return clipBytes(buf, NAMEDATALEN - 1);
}

/** FigureIndexColname-like: column name, or function name for expressions, or "expr". */
export function indexColumnName(elem: A.IndexElem): string {
  if (elem.name) {
    return elem.name;
  }
  const e = elem.expr;
  if (e) {
    let x: A.Expr = e;
    while (x.kind === 'ParenExpr') {
      x = x.arg;
    }
    if (x.kind === 'FuncCall') {
      return x.name[x.name.length - 1];
    }
    if (x.kind === 'TypeCast') {
      let inner: A.Expr = x.arg;
      while (inner.kind === 'ParenExpr') {
        inner = inner.arg;
      }
      if (inner.kind === 'FuncCall') {
        return inner.name[inner.name.length - 1];
      }
      if (inner.kind === 'ColumnRef') {
        return inner.fields[inner.fields.length - 1];
      }
      return x.typeName.names[x.typeName.names.length - 1];
    }
    if (x.kind === 'ColumnRef') {
      return x.fields[x.fields.length - 1];
    }
  }
  return 'expr';
}

export function newColumn(attnum: number, name: string, typeOid: number, typmod: number, collation: number): Column {
  return {
    attnum,
    name,
    typeOid,
    typmod,
    notNull: false,
    collation,
    identity: '',
    generated: '',
    isDropped: false,
    hasMissing: false,
    missingValue: null,
    statsTarget: -1,
    inhCount: 0,
    isLocal: true,
    ndims: 0,
  };
}

export function sequenceBounds(typeOid: number): { min: bigint; max: bigint } {
  switch (typeOid) {
    case TypeOid.int2:
      return { min: -32768n, max: 32767n };
    case TypeOid.int4:
      return { min: -2147483648n, max: 2147483647n };
    default:
      return { min: -9223372036854775808n, max: 9223372036854775807n };
  }
}

export function buildSequenceInfo(session: Session, options: A.SequenceOption[], existing?: SequenceInfo, forIdentityType?: number): SequenceInfo {
  let typeOid = existing?.typeOid ?? forIdentityType ?? TypeOid.int8;
  let increment = existing?.increment ?? 1n;
  let min: bigint | null | undefined = existing ? existing.min : undefined;
  let max: bigint | null | undefined = existing ? existing.max : undefined;
  let start: bigint | undefined = existing?.start;
  let restart: bigint | null | undefined;
  let cache = existing?.cache ?? 1n;
  let cycle = existing?.cycle ?? false;
  let typeChanged = false;
  for (const o of options) {
    switch (o.name) {
      case 'as': {
        const t = session.makeAnalyzer().types.lookupTypeName(o.typeName, session.relationSearchPath());
        if (t.oid !== TypeOid.int2 && t.oid !== TypeOid.int4 && t.oid !== TypeOid.int8) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'sequence type must be smallint, integer, or bigint');
        }
        typeOid = t.oid;
        typeChanged = true;
        break;
      }
      case 'increment':
        increment = BigInt(o.value);
        if (increment === 0n) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'INCREMENT must not be zero');
        }
        break;
      case 'minvalue':
        min = o.value === null ? null : BigInt(o.value);
        break;
      case 'maxvalue':
        max = o.value === null ? null : BigInt(o.value);
        break;
      case 'start':
        start = BigInt(o.value);
        break;
      case 'restart':
        restart = o.value === null ? null : BigInt(o.value);
        break;
      case 'cache':
        cache = BigInt(o.value);
        break;
      case 'cycle':
        cycle = o.value;
        break;
    }
  }
  const bounds = sequenceBounds(typeOid);
  if (min === undefined || min === null || (typeChanged && existing && existing.min === sequenceBounds(existing.typeOid).min)) {
    if (min === undefined || min === null || typeChanged) {
      min = increment > 0n ? 1n : bounds.min;
    }
  }
  if (max === undefined || max === null || (typeChanged && existing && existing.max === sequenceBounds(existing.typeOid).max)) {
    if (max === undefined || max === null || typeChanged) {
      max = increment > 0n ? bounds.max : -1n;
    }
  }
  if (start === undefined) {
    start = increment > 0n ? min! : max!;
  }
  if (min! >= max!) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `MINVALUE (${min}) must be less than MAXVALUE (${max})`);
  }
  if (start < min!) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `START value (${start}) cannot be less than MINVALUE (${min})`);
  }
  if (start > max!) {
    throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `START value (${start}) cannot be greater than MAXVALUE (${max})`);
  }
  const state = existing?.state ?? { lastValue: start, isCalled: false };
  if (restart !== undefined) {
    state.lastValue = restart === null ? start : restart;
    state.isCalled = false;
  }
  if (!existing) {
    state.lastValue = start;
  }
  return { typeOid, start, increment, min: min!, max: max!, cache, cycle, ownedBy: existing?.ownedBy, state };
}

export function createSequenceRelation(session: Session, cat: Catalog, name: string, nspOid: number, info: SequenceInfo, persistence: 'p' | 't' | 'u'): Relation {
  const oid = session.db.oids.allocate();
  const cols: [string, number][] = [
    ['last_value', TypeOid.int8],
    ['log_cnt', TypeOid.int8],
    ['is_called', TypeOid.bool],
  ];
  const rel: Relation = {
    oid,
    name,
    nspOid,
    kind: 'S',
    persistence,
    columns: cols.map(([n, t], i) => ({ ...newColumn(i + 1, n, t, -1, 0), notNull: true })),
    rowTypeOid: 0,
    storageId: 0,
    options: [],
    sequence: info,
    inheritsFrom: [],
    hasTriggers: false,
    populated: true,
  };
  cat.putRelation(rel);
  return rel;
}

export function createRowType(session: Session, cat: Catalog, rel: Relation): void {
  const typeOid = session.db.oids.allocate();
  const arrayOid = session.db.oids.allocate();
  const t: PgType = {
    oid: typeOid,
    name: rel.name,
    nspOid: rel.nspOid,
    len: -1,
    byval: false,
    typtype: 'c',
    category: 'C',
    preferred: false,
    delim: ',',
    elem: 0,
    array: arrayOid,
    baseType: 0,
    typmod: -1,
    collation: 0,
    align: 'd',
    storage: 'x',
    relid: rel.oid,
    isArray: false,
  };
  const arr: PgType = {
    ...t,
    oid: arrayOid,
    name: arrayTypeName(cat, '_' + rel.name, rel.nspOid),
    typtype: 'b',
    category: 'A',
    elem: typeOid,
    array: 0,
    relid: 0,
    isArray: true,
  };
  cat.putType(t);
  cat.putType(arr);
  rel.rowTypeOid = typeOid;
}

/** makeArrayTypeName: prefix '_' and truncate; add more underscores on collision. */
export function arrayTypeName(cat: Catalog, name: string, nspOid: number): string {
  let n = clipBytes(name, NAMEDATALEN - 1);
  while (cat.findTypeInNamespace(nspOid, n)) {
    n = clipBytes('_' + n, NAMEDATALEN - 1);
  }
  return n;
}

export function typeNameInUse(cat: Catalog, name: string, nspOid: number): boolean {
  return !!cat.findTypeInNamespace(nspOid, name);
}

export function defaultOpclass(session: Session, method: string, typeOid: number): number {
  const b = session.db.builtin;
  const types = session.makeAnalyzer().types;
  const base = types.baseType(typeOid);
  let best = 0;
  for (const oc of b.opclasses.values()) {
    if (oc.am !== method || !oc.isDefault) {
      continue;
    }
    if (oc.inputType === base) {
      return oc.oid;
    }
    if (!best) {
      if (oc.inputType === TypeOid.anyarray && types.isArray(base)) {
        best = oc.oid;
      } else if (oc.inputType === TypeOid.anyenum && types.isEnum(base)) {
        best = oc.oid;
      } else if (oc.inputType === TypeOid.text && (base === TypeOid.varchar || base === TypeOid.bpchar)) {
        best = base === TypeOid.bpchar ? best : oc.oid;
      } else if (oc.inputType === TypeOid.record && types.isComposite(base)) {
        best = oc.oid;
      }
    }
  }
  return best;
}

export function findOpclass(session: Session, method: string, names: string[]): number {
  const name = names[names.length - 1];
  for (const oc of session.db.builtin.opclasses.values()) {
    if (oc.am === method && oc.name === name) {
      return oc.oid;
    }
  }
  const ext = session.catalog().comments.get('opclass:' + method + ':' + name);
  if (ext) {
    return Number(ext);
  }
  throw new PgError(SqlState.UNDEFINED_OBJECT, `operator class "${names.join('.')}" does not exist for access method "${method}"`);
}

export function relationKindName(kind: string): string {
  switch (kind) {
    case 'r':
    case 'p':
      return 'table';
    case 'i':
    case 'I':
      return 'index';
    case 'S':
      return 'sequence';
    case 'v':
      return 'view';
    case 'm':
      return 'materialized view';
    case 'c':
      return 'composite type';
    case 'f':
      return 'foreign table';
  }
  return 'relation';
}

export function isSystemNamespace(oid: number, session: Session): boolean {
  return oid === NS_PG_CATALOG || oid === session.db.builtin.informationSchemaOid;
}

export function newConstraint(session: Session, fields: Partial<Constraint> & Pick<Constraint, 'name' | 'nspOid' | 'type' | 'relOid'>): Constraint {
  return {
    oid: session.db.oids.allocate(),
    typeOid: 0,
    columns: [],
    indexOid: 0,
    deferrable: false,
    initiallyDeferred: false,
    validated: true,
    noInherit: false,
    isLocal: true,
    inhCount: 0,
    ...fields,
  };
}

export function elemToDef(): IndexElemDef | null {
  return null;
}
