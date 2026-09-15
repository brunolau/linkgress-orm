import type * as A from '../ast';
import { Catalog, NS_PG_CATALOG, PgType, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { COL_NAME_KEYWORDS, RESERVED_KEYWORDS, TYPE_FUNC_NAME_KEYWORDS } from '../parser';
import { TExpr } from './nodes';
import { multirangeTypeInfo, rangeTypeInfo } from '../types/range';

export type CoercionContext = 'implicit' | 'assignment' | 'explicit';

export type CoercionPath =
  | { kind: 'none' }
  | { kind: 'relabel' }
  | { kind: 'func'; funcOid: number; funcSrc: string; funcName: string }
  | { kind: 'io' }
  | { kind: 'array'; elemPath: CoercionPath };

const CONTEXT_RANK: Record<CoercionContext, number> = { implicit: 0, assignment: 1, explicit: 2 };
const CAST_CONTEXT_RANK: Record<string, number> = { i: 0, a: 1, e: 2 };

export const POLYMORPHIC_TYPES = new Set<number>([
  TypeOid.anyelement,
  TypeOid.anyarray,
  TypeOid.anynonarray,
  TypeOid.anyenum,
  TypeOid.anyrange,
  TypeOid.anymultirange,
  TypeOid.anycompatible,
  TypeOid.anycompatiblearray,
  TypeOid.anycompatiblenonarray,
  TypeOid.anycompatiblerange,
  TypeOid.anycompatiblemultirange,
]);

/** thrown (instead of an error) by resolvePolymorphic in check-only mode */
const INCONSISTENT = Symbol('inconsistent polymorphic types');

export function isPolymorphic(oid: number): boolean {
  return POLYMORPHIC_TYPES.has(oid);
}

export class TypeUtil {
  constructor(readonly catalog: Catalog) {}

  get(oid: number): PgType | undefined {
    return this.catalog.getType(oid);
  }

  /** getBaseType: strip domains */
  baseType(oid: number): number {
    let t = this.catalog.getType(oid);
    let guard = 0;
    while (t && t.typtype === 'd' && guard++ < 32) {
      const b = this.catalog.getType(t.baseType);
      if (!b) {
        break;
      }
      t = b;
    }
    return t ? t.oid : oid;
  }

  category(oid: number): string {
    return this.catalog.getType(this.baseType(oid))?.category ?? 'U';
  }

  isPreferred(oid: number): boolean {
    return this.catalog.getType(this.baseType(oid))?.preferred ?? false;
  }

  isArray(oid: number): boolean {
    const t = this.catalog.getType(this.baseType(oid));
    return !!t && (t.isArray || t.oid === TypeOid.int2vector || t.oid === TypeOid.oidvector);
  }

  /** get_element_type: int2vector / oidvector are true arrays (array_subscript_handler) too */
  elemType(oid: number): number {
    const t = this.catalog.getType(this.baseType(oid));
    return t && (t.isArray || t.oid === TypeOid.int2vector || t.oid === TypeOid.oidvector) ? t.elem : 0;
  }

  arrayTypeOf(oid: number): number {
    const t = this.catalog.getType(oid);
    return t ? t.array : 0;
  }

  isComposite(oid: number): boolean {
    if (oid === TypeOid.record) {
      return true;
    }
    const t = this.catalog.getType(this.baseType(oid));
    return !!t && t.typtype === 'c';
  }

  isEnum(oid: number): boolean {
    return this.catalog.getType(oid)?.typtype === 'e';
  }

  isStringCategory(oid: number): boolean {
    return this.category(oid) === 'S';
  }

  typeName(oid: number): string {
    return this.formatType(oid, -1, false);
  }

  // -------------------------------------------------------------------------
  // Coercion pathways
  // -------------------------------------------------------------------------

  findCoercionPathway(target: number, source: number, ccontext: CoercionContext): CoercionPath {
    if (source === target) {
      return { kind: 'relabel' };
    }
    const baseTarget = this.baseType(target);
    const baseSource = this.baseType(source);
    if (baseSource === baseTarget) {
      return { kind: 'relabel' };
    }
    const cast = this.catalog.builtin.casts.get(baseSource + ':' + baseTarget);
    if (cast) {
      if (CAST_CONTEXT_RANK[cast.context] <= CONTEXT_RANK[ccontext]) {
        switch (cast.method) {
          case 'f':
            return { kind: 'func', funcOid: cast.funcOid, funcSrc: cast.funcSrc, funcName: cast.funcName };
          case 'b':
            return { kind: 'relabel' };
          case 'i':
            return { kind: 'io' };
        }
      }
      return { kind: 'none' };
    }
    // array -> array (int2vector / oidvector count as arrays on the source side only)
    const st = this.catalog.getType(baseSource);
    const tt = this.catalog.getType(baseTarget);
    if (st && tt && this.isArray(baseSource) && tt.isArray) {
      const elemPath = this.findCoercionPathway(tt.elem, st.elem, ccontext);
      if (elemPath.kind !== 'none') {
        return { kind: 'array', elemPath };
      }
      return { kind: 'none' };
    }
    // enum / composite casts to and from text via I/O
    if (tt && tt.category === 'S' && CONTEXT_RANK[ccontext] >= CONTEXT_RANK.assignment) {
      return { kind: 'io' };
    }
    if (st && st.category === 'S' && ccontext === 'explicit') {
      return { kind: 'io' };
    }
    return { kind: 'none' };
  }

  /** can_coerce_type for a single pair (no polymorphic consistency check). */
  canCoerceSingle(input: number, target: number, ccontext: CoercionContext, inputExpr?: TExpr): boolean {
    if (input === target) {
      return true;
    }
    if (target === TypeOid.any) {
      return true;
    }
    if (isPolymorphic(target)) {
      return true;
    }
    if (input === TypeOid.unknown) {
      return true;
    }
    if (target === TypeOid.record && this.isComposite(input)) {
      return true;
    }
    if (target === TypeOid._record && this.isArray(input) && this.isComposite(this.elemType(input))) {
      return true;
    }
    if (input === TypeOid.record && this.isComposite(target) && inputExpr && inputExpr.k === 'row') {
      return true;
    }
    if (this.findCoercionPathway(target, input, ccontext).kind !== 'none') {
      return true;
    }
    // domain input to base type target
    const baseIn = this.baseType(input);
    if (baseIn !== input && this.canCoerceSingle(baseIn, target, ccontext)) {
      return true;
    }
    return false;
  }

  canCoerceTypes(inputs: number[], targets: number[], ccontext: CoercionContext): boolean {
    let hasPoly = false;
    for (let i = 0; i < inputs.length; i++) {
      if (isPolymorphic(targets[i])) {
        hasPoly = true;
      }
      if (!this.canCoerceSingle(inputs[i], targets[i], ccontext)) {
        return false;
      }
    }
    if (hasPoly) {
      return this.checkGenericTypeConsistency(inputs, targets);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Polymorphic types
  // -------------------------------------------------------------------------

  checkGenericTypeConsistency(actual: number[], declared: number[]): boolean {
    try {
      this.resolvePolymorphic(actual, declared, TypeOid.void, true);
      return true;
    } catch (e) {
      if (e === INCONSISTENT || e instanceof PgError) {
        return false;
      }
      throw e;
    }
  }

  /**
   * enforce_generic_type_consistency: returns resolved declared types (per argument) and the resolved return type.
   */
  resolvePolymorphic(actual: number[], declared: number[], rettype: number, checkOnly = false): { argTypes: number[]; rettype: number } {
    let elemType = 0;
    let arrayType = 0;
    let haveAnyElement = false;
    let haveAnyNonArray = false;
    let haveAnyEnum = false;
    const compatTypes: number[] = [];
    let haveCompat = false;
    let haveCompatNonArray = false;
    const fail = (msg: string) => {
      // candidate filtering only needs a verdict: skip building an error (and its stack)
      if (checkOnly) {
        throw INCONSISTENT;
      }
      throw new PgError(SqlState.DATATYPE_MISMATCH, msg);
    };
    let rangeType = 0;
    let multirangeType = 0;
    for (let i = 0; i < declared.length; i++) {
      const d = declared[i];
      const a = actual[i];
      if (d === TypeOid.anyrange || d === TypeOid.anymultirange || d === TypeOid.anycompatiblerange || d === TypeOid.anycompatiblemultirange) {
        if (a === TypeOid.unknown) {
          continue;
        }
        const base = this.baseType(a);
        const isMulti = d === TypeOid.anymultirange || d === TypeOid.anycompatiblemultirange;
        const tt = this.catalog.getType(base)?.typtype;
        if (tt !== (isMulti ? 'm' : 'r')) {
          fail(`argument declared ${isMulti ? 'anymultirange' : 'anyrange'} is not a ${isMulti ? 'multirange' : 'range'} type but type ${this.typeName(base)}`);
        }
        if (isMulti) {
          if (multirangeType && multirangeType !== base) {
            fail(`arguments declared "anymultirange" are not all alike`);
          }
          multirangeType = base;
        } else {
          if (rangeType && rangeType !== base) {
            fail(`arguments declared "anyrange" are not all alike`);
          }
          rangeType = base;
        }
        continue;
      }
      if (d === TypeOid.anyelement || d === TypeOid.anynonarray || d === TypeOid.anyenum) {
        haveAnyElement = true;
        if (d === TypeOid.anynonarray) {
          haveAnyNonArray = true;
        }
        if (d === TypeOid.anyenum) {
          haveAnyEnum = true;
        }
        if (a === TypeOid.unknown) {
          continue;
        }
        const base = this.baseType(a);
        if (elemType !== 0 && base !== elemType) {
          fail(`arguments declared "anyelement" are not all alike`);
        }
        elemType = base;
      } else if (d === TypeOid.anyarray) {
        if (a === TypeOid.unknown) {
          continue;
        }
        const base = this.baseType(a);
        if (arrayType !== 0 && base !== arrayType) {
          fail(`arguments declared "anyarray" are not all alike`);
        }
        arrayType = base;
      } else if (d === TypeOid.anycompatible || d === TypeOid.anycompatiblenonarray) {
        haveCompat = true;
        if (d === TypeOid.anycompatiblenonarray) {
          haveCompatNonArray = true;
        }
        if (a !== TypeOid.unknown) {
          compatTypes.push(this.baseType(a));
        }
      } else if (d === TypeOid.anycompatiblearray) {
        haveCompat = true;
        if (a !== TypeOid.unknown) {
          const e = this.elemType(a);
          if (!e) {
            fail(`argument declared anycompatiblearray is not an array but type ${this.typeName(a)}`);
          }
          compatTypes.push(e);
        }
      }
    }
    // a multirange determines its range type, a range type its element (subtype)
    if (multirangeType !== 0) {
      const r = multirangeTypeInfo(multirangeType)?.rangeOid ?? 0;
      if (rangeType !== 0 && r !== rangeType) {
        fail('argument declared anymultirange is not consistent with argument declared anyrange');
      }
      rangeType = r || rangeType;
    }
    if (rangeType !== 0) {
      const subtype = rangeTypeInfo(rangeType)?.subtype ?? 0;
      if (subtype !== 0) {
        if (elemType !== 0 && elemType !== subtype) {
          fail('argument declared anyrange is not consistent with argument declared anyelement');
        }
        elemType = subtype;
      }
      if (multirangeType === 0) {
        multirangeType = rangeTypeInfo(rangeType)?.multirangeOid ?? 0;
      }
    }
    if (arrayType !== 0) {
      const e = this.elemType(arrayType);
      if (!e) {
        if (arrayType === TypeOid.anyarray) {
          // anyarray actual (e.g. pg_statistic) — element unknown
        } else {
          fail(`argument declared anyarray is not an array but type ${this.typeName(arrayType)}`);
        }
      }
      if (elemType === 0) {
        elemType = e;
      } else if (e !== elemType) {
        fail(`argument declared anyarray is not consistent with argument declared anyelement`);
      }
    } else if (elemType !== 0) {
      // derive array type
    } else if (haveAnyElement || declared.includes(TypeOid.anyarray)) {
      // all unknown
      if (!checkOnly && (isPolymorphic(rettype) || declared.some((d) => d === TypeOid.anyelement || d === TypeOid.anyarray))) {
        // allowed to be unresolved for arguments only when return type isn't polymorphic
        if (isPolymorphic(rettype) && rettype !== TypeOid.anycompatible && rettype !== TypeOid.anycompatiblearray) {
          throw new PgError(SqlState.DATATYPE_MISMATCH, 'could not determine polymorphic type because input has type unknown');
        }
      }
      elemType = TypeOid.text;
    }
    if (haveAnyNonArray && elemType && this.isArray(elemType)) {
      fail(`type matched to anynonarray is an array type: ${this.typeName(elemType)}`);
    }
    if (haveAnyEnum && elemType && !this.isEnum(elemType)) {
      fail(`type matched to anyenum is not an enum type: ${this.typeName(elemType)}`);
    }
    let compatType = 0;
    if (haveCompat || declared.includes(TypeOid.anycompatiblearray)) {
      if (compatTypes.length === 0) {
        compatType = TypeOid.text;
      } else {
        compatType = this.selectCommonTypeFromTypes(compatTypes, 'anycompatible');
      }
      if (haveCompatNonArray && this.isArray(compatType)) {
        fail(`type matched to anycompatiblenonarray is an array type: ${this.typeName(compatType)}`);
      }
    }
    const resolve = (d: number): number => {
      switch (d) {
        case TypeOid.anyelement:
        case TypeOid.anynonarray:
        case TypeOid.anyenum:
          return elemType || TypeOid.text;
        case TypeOid.anyarray: {
          if (arrayType) {
            return arrayType;
          }
          const arr = this.arrayTypeOf(elemType || TypeOid.text);
          if (!arr) {
            fail(`could not find array type for data type ${this.typeName(elemType)}`);
          }
          return arr;
        }
        case TypeOid.anycompatible:
        case TypeOid.anycompatiblenonarray:
          return compatType || TypeOid.text;
        case TypeOid.anycompatiblearray: {
          const arr = this.arrayTypeOf(compatType || TypeOid.text);
          if (!arr) {
            fail(`could not find array type for data type ${this.typeName(compatType)}`);
          }
          return arr;
        }
        case TypeOid.anyrange:
        case TypeOid.anycompatiblerange:
          if (!rangeType) {
            fail('could not determine polymorphic type anyrange because input has type unknown');
          }
          return rangeType;
        case TypeOid.anymultirange:
        case TypeOid.anycompatiblemultirange:
          if (!multirangeType) {
            fail('could not determine polymorphic type anymultirange because input has type unknown');
          }
          return multirangeType;
        default:
          return d;
      }
    };
    return { argTypes: declared.map(resolve), rettype: resolve(rettype) };
  }

  // -------------------------------------------------------------------------
  // Common types
  // -------------------------------------------------------------------------

  /** select_common_type over expressions */
  /** `locations`: exprLocation of each input, for the position of a mismatch error */
  selectCommonType(types: number[], context: string | null, locations?: (number | undefined)[]): number {
    if (types.length === 0) {
      return TypeOid.text;
    }
    let ptype = types[0];
    if (ptype !== TypeOid.unknown && types.every((t) => t === ptype)) {
      return ptype;
    }
    ptype = this.baseType(ptype);
    let pcategory = this.category(ptype);
    let ppreferred = this.isPreferred(ptype);
    for (let i = 1; i < types.length; i++) {
      const ntype = this.baseType(types[i]);
      if (ntype !== TypeOid.unknown && ntype !== ptype) {
        const ncategory = this.category(ntype);
        const npreferred = this.isPreferred(ntype);
        if (ptype === TypeOid.unknown) {
          ptype = ntype;
          pcategory = ncategory;
          ppreferred = npreferred;
        } else if (ncategory !== pcategory) {
          if (context === null) {
            return 0;
          }
          const err = new PgError(SqlState.DATATYPE_MISMATCH, `${context} types ${this.typeName(ptype)} and ${this.typeName(ntype)} cannot be matched`);
          if (locations && locations[i] !== undefined) {
            err.position = locations[i]! + 1;
          }
          throw err;
        } else if (!ppreferred && this.canCoerceSingle(ptype, ntype, 'implicit') && !this.canCoerceSingle(ntype, ptype, 'implicit')) {
          ptype = ntype;
          pcategory = ncategory;
          ppreferred = npreferred;
        }
      }
    }
    if (ptype === TypeOid.unknown) {
      ptype = TypeOid.text;
    }
    return ptype;
  }

  private selectCommonTypeFromTypes(types: number[], context: string): number {
    const t = this.selectCommonType(types, null);
    if (t === 0) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, `function arguments of type ${context} cannot be matched`);
    }
    return t;
  }

  // -------------------------------------------------------------------------
  // Type names
  // -------------------------------------------------------------------------

  /** Resolve a raw TypeName to a type oid, using the given search path for unqualified names. */
  lookupTypeName(tn: A.TypeName, searchPath: number[], resolvePctType?: (names: string[]) => { oid: number; typmod: number }): { oid: number; typmod: number } {
    if (tn.pctType && resolvePctType) {
      const r = resolvePctType(tn.names);
      return r;
    }
    const names = tn.names;
    let t: PgType | undefined;
    const typeNameText = names.join('.');
    if (names.length === 1) {
      for (const ns of [NS_PG_CATALOG, ...searchPath.filter((n) => n !== NS_PG_CATALOG)]) {
        t = this.catalog.findTypeInNamespace(ns, names[0]);
        if (t) {
          break;
        }
      }
      if (!t) {
        // relation row types (table names)
        for (const ns of searchPath) {
          const rel = this.catalog.findRelationInNamespace(ns, names[0]);
          if (rel && rel.rowTypeOid) {
            t = this.catalog.getType(rel.rowTypeOid);
            break;
          }
        }
      }
    } else {
      const nspName = names[names.length - 2];
      const ns = this.catalog.findNamespace(nspName);
      if (!ns) {
        throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${nspName}" does not exist`);
      }
      t = this.catalog.findTypeInNamespace(ns.oid, names[names.length - 1]);
      if (!t) {
        const rel = this.catalog.findRelationInNamespace(ns.oid, names[names.length - 1]);
        if (rel && rel.rowTypeOid) {
          t = this.catalog.getType(rel.rowTypeOid);
        }
      }
    }
    if (!t) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `type "${typeNameText}" does not exist`);
    }
    let oid = t.oid;
    let typmod = this.computeTypmod(t, tn);
    if (tn.arrayBounds.length > 0) {
      const arr = t.isArray ? t.oid : t.array;
      if (!arr) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `could not find array type for data type ${this.formatType(t.oid, -1, false)}`);
      }
      oid = arr;
    }
    return { oid, typmod };
  }

  private computeTypmod(t: PgType, tn: A.TypeName): number {
    const mods = tn.typmods;
    const consts = (): number[] =>
      mods.map((m) => {
        if (m.kind === 'AConst' && m.val.type === 'integer') {
          return parseInt(m.val.value, 10);
        }
        if (m.kind === 'ColumnRef' && m.fields.length === 1) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'type modifiers must be simple constants or identifiers');
        }
        throw new PgError(SqlState.SYNTAX_ERROR, 'type modifiers must be simple constants or identifiers');
      });
    const typeName = this.formatType(t.oid, -1, false);
    if (tn.intervalFields && t.oid === TypeOid.interval) {
      const range = intervalRangeMask(tn.intervalFields);
      const prec = mods.length ? consts()[0] : 0xffff;
      return ((range << 16) | prec) >>> 0;
    }
    if (mods.length === 0) {
      return -1;
    }
    const vals = consts();
    switch (t.oid) {
      case TypeOid.varchar:
      case TypeOid.bpchar: {
        if (vals.length !== 1) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'invalid type modifier');
        }
        const n = vals[0];
        const nm = t.oid === TypeOid.varchar ? 'varchar' : 'char';
        if (n < 1) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `length for type ${nm} must be at least 1`);
        }
        if (n > 10485760) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `length for type ${nm} cannot exceed 10485760`);
        }
        return n + 4;
      }
      case TypeOid.numeric: {
        const p = vals[0];
        const s = vals.length > 1 ? vals[1] : 0;
        if (vals.length > 2) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, 'invalid NUMERIC type modifier');
        }
        if (p < 1 || p > 1000) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `NUMERIC precision ${p} must be between 1 and 1000`);
        }
        if (s < -1000 || s > 1000) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `NUMERIC scale ${s} must be between -1000 and 1000`);
        }
        return ((p << 16) | (s & 0x7ff)) + 4;
      }
      case TypeOid.timestamp:
      case TypeOid.timestamptz:
      case TypeOid.time:
      case TypeOid.timetz: {
        let p = vals[0];
        if (p < 0) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `${typeName.toUpperCase()}(${p}) precision must not be negative`);
        }
        if (p > 6) {
          p = 6;
        }
        return p;
      }
      case TypeOid.interval:
        return ((0x7fff << 16) | Math.min(6, vals[0])) >>> 0;
      case TypeOid.bit:
      case TypeOid.varbit:
        if (vals[0] < 1) {
          throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `length for type ${t.oid === TypeOid.bit ? 'bit' : 'varbit'} must be at least 1`);
        }
        return vals[0];
      case TypeOid.float4:
      case TypeOid.float8:
        return -1;
    }
    throw new PgError(SqlState.SYNTAX_ERROR, `type modifier is not allowed for type "${t.name}"`);
  }

  // -------------------------------------------------------------------------
  // format_type
  // -------------------------------------------------------------------------

  /**
   * format_type_extended. `typmodGiven` mirrors FORMAT_TYPE_TYPEMOD_GIVEN.
   */
  formatType(oid: number, typmod: number, typmodGiven = true, forceQualify = false, visibleNamespaces?: number[]): string {
    const t = this.catalog.getType(oid);
    if (!t) {
      return '???';
    }
    if (t.isArray && t.len === -1) {
      return this.formatType(t.elem, typmod, typmodGiven, forceQualify, visibleNamespaces) + '[]';
    }
    const withTypmod = typmodGiven && typmod >= 0;
    switch (oid) {
      case TypeOid.bit:
        return withTypmod ? `bit(${typmod})` : 'bit';
      case TypeOid.bool:
        return 'boolean';
      case TypeOid.bpchar:
        if (withTypmod) {
          return `character(${typmod - 4})`;
        }
        return typmodGiven ? 'bpchar' : 'character';
      case TypeOid.float4:
        return 'real';
      case TypeOid.float8:
        return 'double precision';
      case TypeOid.int2:
        return 'smallint';
      case TypeOid.int4:
        return 'integer';
      case TypeOid.int8:
        return 'bigint';
      case TypeOid.numeric:
        if (withTypmod && typmod >= 4) {
          const tm = typmod - 4;
          let scale = tm & 0x7ff;
          if (scale & 0x400) {
            scale -= 0x800;
          }
          return `numeric(${(tm >> 16) & 0xffff},${scale})`;
        }
        return 'numeric';
      case TypeOid.interval:
        return withTypmod ? 'interval' + intervalTypmodOut(typmod) : 'interval';
      case TypeOid.time:
        return withTypmod ? `time(${typmod}) without time zone` : 'time without time zone';
      case TypeOid.timetz:
        return withTypmod ? `time(${typmod}) with time zone` : 'time with time zone';
      case TypeOid.timestamp:
        return withTypmod ? `timestamp(${typmod}) without time zone` : 'timestamp without time zone';
      case TypeOid.timestamptz:
        return withTypmod ? `timestamp(${typmod}) with time zone` : 'timestamp with time zone';
      case TypeOid.varbit:
        return withTypmod ? `bit varying(${typmod})` : 'bit varying';
      case TypeOid.varchar:
        return withTypmod ? `character varying(${typmod - 4})` : 'character varying';
      case TypeOid.json:
        return 'json';
    }
    const visible = visibleNamespaces ?? [NS_PG_CATALOG, 2200];
    let name = quoteIdentifier(t.name);
    if (forceQualify || !visible.includes(t.nspOid)) {
      name = quoteIdentifier(this.catalog.namespaceName(t.nspOid)) + '.' + name;
    }
    return name;
  }
}

function intervalRangeMask(fields: string): number {
  const bit = (name: string): number => {
    switch (name) {
      case 'YEAR':
        return 1 << 2;
      case 'MONTH':
        return 1 << 1;
      case 'DAY':
        return 1 << 3;
      case 'HOUR':
        return 1 << 10;
      case 'MINUTE':
        return 1 << 11;
      case 'SECOND':
        return 1 << 12;
    }
    return 0;
  };
  const parts = fields.split(' TO ');
  if (parts.length === 1) {
    return bit(parts[0]);
  }
  const order = ['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND'];
  let mask = 0;
  for (let i = order.indexOf(parts[0]); i <= order.indexOf(parts[1]); i++) {
    mask |= bit(order[i]);
  }
  return mask;
}

function intervalTypmodOut(typmod: number): string {
  const range = (typmod >> 16) & 0x7fff;
  const precision = typmod & 0xffff;
  const names: Record<number, string> = {
    [1 << 2]: ' year',
    [1 << 1]: ' month',
    [1 << 3]: ' day',
    [1 << 10]: ' hour',
    [1 << 11]: ' minute',
    [1 << 12]: ' second',
    [(1 << 2) | (1 << 1)]: ' year to month',
    [(1 << 3) | (1 << 10)]: ' day to hour',
    [(1 << 3) | (1 << 10) | (1 << 11)]: ' day to minute',
    [(1 << 3) | (1 << 10) | (1 << 11) | (1 << 12)]: ' day to second',
    [(1 << 10) | (1 << 11)]: ' hour to minute',
    [(1 << 10) | (1 << 11) | (1 << 12)]: ' hour to second',
    [(1 << 11) | (1 << 12)]: ' minute to second',
  };
  let out = range === 0x7fff ? '' : names[range] ?? '';
  if (precision !== 0xffff) {
    out += `(${precision})`;
  }
  return out;
}

/** quote_identifier: quote when not a plain lower-case identifier or when it is a (non-unreserved) keyword. */
export function quoteIdentifier(ident: string): string {
  let safe = /^[a-z_][a-z0-9_]*$/.test(ident);
  if (safe) {
    const up = ident.toUpperCase();
    if (RESERVED_KEYWORDS.has(up) || TYPE_FUNC_NAME_KEYWORDS.has(up) || COL_NAME_KEYWORDS.has(up)) {
      safe = false;
    }
  }
  if (safe) {
    return ident;
  }
  return '"' + ident.replace(/"/g, '""') + '"';
}

export function quoteLiteral(s: string): string {
  if (s.includes('\\')) {
    return "E'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  }
  return "'" + s.replace(/'/g, "''") + "'";
}
