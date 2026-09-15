import type * as A from '../ast';
import { COLL_DEFAULT, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { PgNumeric } from '../types/numeric';
import { PgBits } from '../types/values';
import type { Analyzer } from './analyzer';
import {
  colNameToVar,
  columnDoesNotExist,
  missingRteError,
  refnameNsItem,
  scanNsItemForColumn,
  varForColumn,
  wholeRowVar,
} from './colref';
import { transformFuncCall } from './func-call';
import { ArrayNode, CaseNode, SubLinkNode, TExpr } from './nodes';
import { ExprKind, ParseState } from './parse-state';
import { resolveBinaryOperator, resolvePrefixOperator } from './resolve';
import { analyzeSelectForSubquery } from './select';
import { containsVarsOfLevel } from './walk';

export function transformExpr(an: Analyzer, pstate: ParseState, node: A.Expr, kind: ExprKind): TExpr {
  const saved = pstate.exprKind;
  pstate.exprKind = kind;
  try {
    return transformExprRecurse(an, pstate, node);
  } finally {
    pstate.exprKind = saved;
  }
}

export function transformExprRecurse(an: Analyzer, pstate: ParseState, node: A.Expr): TExpr {
  switch (node.kind) {
    case 'ParenExpr':
      return transformExprRecurse(an, pstate, node.arg);
    case 'ColumnRef':
      return transformColumnRef(an, pstate, node);
    case 'ParamRef':
      return transformParamRef(an, pstate, node);
    case 'AConst':
      return transformConst(an, node);
    case 'TypeCast':
      return transformTypeCast(an, pstate, node);
    case 'AExpr':
      return transformAExpr(an, pstate, node);
    case 'BoolExpr': {
      const name = node.op;
      const args = node.args.map((a) => an.coerceToBoolean(pstate, transformExprRecurse(an, pstate, a), name));
      return { k: 'bool', op: name === 'AND' ? 'and' : name === 'OR' ? 'or' : 'not', args, type: TypeOid.bool, typmod: -1, collation: 0 };
    }
    case 'NullTest': {
      const arg = transformExprRecurse(an, pstate, node.arg);
      return { k: 'nulltest', arg, isNot: node.isNot, argIsRow: an.types.isComposite(arg.type) && arg.type !== TypeOid.record ? true : arg.k === 'row', type: TypeOid.bool, typmod: -1, collation: 0 };
    }
    case 'BooleanTest': {
      const clause = node.test.replace('IS_', 'IS ').replace('_', ' ');
      const arg = an.coerceToBoolean(pstate, transformExprRecurse(an, pstate, node.arg), clause);
      return { k: 'booltest', arg, test: node.test, type: TypeOid.bool, typmod: -1, collation: 0 };
    }
    case 'FuncCall':
      return transformFuncCall(an, pstate, node);
    case 'CaseExpr':
      return transformCaseExpr(an, pstate, node);
    case 'CoalesceExpr': {
      const args = node.args.map((a) => transformExprRecurse(an, pstate, a));
      const type = an.types.selectCommonType(
        args.map((a) => a.type),
        'COALESCE'
      );
      const typmod = an.selectCommonTypmod(args, type);
      const coerced = args.map((a) => an.coerceToCommonType(a, type, 'COALESCE'));
      return { k: 'coalesce', args: coerced, type, typmod, collation: an.typeCollation(type) ? resolveCollation(coerced, an.typeCollation(type)) : 0 };
    }
    case 'MinMaxExpr': {
      const ctx = node.op;
      const args = node.args.map((a) => transformExprRecurse(an, pstate, a));
      const type = an.types.selectCommonType(
        args.map((a) => a.type),
        ctx
      );
      const typmod = an.selectCommonTypmod(args, type);
      const coerced = args.map((a) => an.coerceToCommonType(a, type, ctx));
      requireOrdering(an, type);
      return { k: 'minmax', op: ctx === 'GREATEST' ? 'greatest' : 'least', args: coerced, type, typmod, collation: an.typeCollation(type) ? resolveCollation(coerced, an.typeCollation(type)) : 0 };
    }
    case 'SubLink':
      return transformSubLink(an, pstate, node);
    case 'ArrayExpr':
      return transformArrayExpr(an, pstate, node, 0, 0, -1);
    case 'RowExpr':
      return transformRowExpr(an, pstate, node);
    case 'Indirection':
      return transformIndirection(an, pstate, node);
    case 'CollateClause': {
      const arg = transformExprRecurse(an, pstate, node.arg);
      const collName = node.collname[node.collname.length - 1];
      const nsp = node.collname.length > 1 ? an.catalog.findNamespace(node.collname[0])?.oid ?? -1 : null;
      const coll = an.catalog.findCollation(nsp, collName);
      if (!coll) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `collation "${node.collname.join('.')}" for encoding "UTF8" does not exist`);
      }
      if (!an.typeCollation(arg.type) && arg.type !== TypeOid.unknown) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, `collations are not supported by type ${an.types.formatType(arg.type, -1, false)}`);
      }
      const base = arg.type === TypeOid.unknown ? an.resolveUnknownToText(arg) : arg;
      return { k: 'collate', arg: base, type: base.type, typmod: base.typmod, collation: coll.oid };
    }
    case 'SqlValueFunction':
      return transformSqlValue(node);
    case 'SetToDefault':
      if (!pstate.allowDefault) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'DEFAULT is not allowed in this context');
      }
      return { k: 'default', type: TypeOid.unknown, typmod: -1, collation: 0 };
    case 'GroupingFunc':
      return transformGroupingFunc(an, pstate, node);
    case 'AStar':
      throw new PgError(SqlState.SYNTAX_ERROR, 'row expansion via "*" is not supported here');
  }
}

function resolveCollation(args: TExpr[], dflt: number): number {
  for (const a of args) {
    if (a.k === 'collate') {
      return a.collation;
    }
  }
  for (const a of args) {
    if (a.collation) {
      return a.collation;
    }
  }
  return dflt;
}

export function requireOrdering(an: Analyzer, type: number): void {
  const base = an.types.baseType(type);
  if (base === TypeOid.json || base === TypeOid.xml || base === TypeOid.point) {
    throw new PgError(SqlState.UNDEFINED_FUNCTION, `could not identify a comparison function for type ${an.types.formatType(type, -1, false)}`);
  }
}

// ---------------------------------------------------------------------------
// Constants, params, casts
// ---------------------------------------------------------------------------

function transformConst(an: Analyzer, node: A.AConst): TExpr {
  const v = node.val;
  switch (v.type) {
    case 'integer':
      return an.makeIntegerLiteral(v.value);
    case 'numeric': {
      // decimal literal: numeric (PostgreSQL types 1.5 as numeric; huge exponent still numeric)
      return an.makeTypedConst(TypeOid.numeric, PgNumeric.parse(v.value));
    }
    case 'string':
      return { ...an.makeUnknownConst(v.value), location: node.loc };
    case 'bitstring': {
      const marker = v.value[0];
      let bits = v.value.slice(1);
      if (marker === 'x') {
        bits = bits
          .split('')
          .map((h) => {
            const n = parseInt(h, 16);
            if (Number.isNaN(n)) {
              throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `"${h}" is not a valid hexadecimal digit`);
            }
            return n.toString(2).padStart(4, '0');
          })
          .join('');
      } else if (!/^[01]*$/.test(bits)) {
        throw new PgError(SqlState.INVALID_TEXT_REPRESENTATION, `"${bits.replace(/[01]/g, '')[0]}" is not a valid binary digit`);
      }
      return an.makeTypedConst(TypeOid.bit, new PgBits(bits), bits.length);
    }
    case 'boolean':
      return an.makeBoolConst(v.value);
    case 'null':
      return an.makeUnknownConst(null);
  }
}

function transformParamRef(an: Analyzer, pstate: ParseState, node: A.ParamRef): TExpr {
  void pstate;
  if (node.number < 1) {
    throw new PgError(SqlState.UNDEFINED_PARAMETER, `there is no parameter $${node.number}`);
  }
  if (an.fixedParamTypes && node.number > an.paramTypes.length) {
    throw new PgError(SqlState.UNDEFINED_PARAMETER, `there is no parameter $${node.number}`);
  }
  while (an.paramTypes.length < node.number) {
    an.paramTypes.push(0);
  }
  const type = an.paramType(node.number);
  return { k: 'param', paramId: node.number, type, typmod: -1, collation: an.typeCollation(type) };
}

export function transformTypeCast(an: Analyzer, pstate: ParseState, node: A.TypeCast): TExpr {
  const { oid: targetType, typmod: targetTypmod } = an.types.lookupTypeName(node.typeName, an.env.relationSearchPath());
  let arg: TExpr;
  if (node.arg.kind === 'ArrayExpr' && an.types.isArray(targetType)) {
    const elemType = an.types.elemType(targetType);
    arg = transformArrayExpr(an, pstate, node.arg, targetType, elemType, targetTypmod);
  } else {
    arg = transformExprRecurse(an, pstate, node.arg);
  }
  const result = an.coerceToTargetType(arg, targetType, targetTypmod, 'explicit', 'explicit_cast');
  if (!result) {
    throw new PgError(SqlState.CANNOT_COERCE, `cannot cast type ${an.types.formatType(arg.type, -1, false)} to ${an.types.formatType(targetType, targetTypmod, false)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Column references
// ---------------------------------------------------------------------------

function transformColumnRef(an: Analyzer, pstate: ParseState, node: A.ColumnRef): TExpr {
  const f = node.fields;
  if (f[f.length - 1] === '*') {
    if (f.length === 1) {
      throw new PgError(SqlState.SYNTAX_ERROR, 'row expansion via "*" is not supported here');
    }
    // rel.* in expression context -> whole-row
    const schema = f.length === 3 ? f[0] : undefined;
    const relname = f[f.length - 2];
    const found = refnameNsItem(an, pstate, schema, relname);
    if (!found) {
      throw missingRteError(an, pstate, relname);
    }
    return wholeRowVar(an, found.item, found.levelsUp);
  }
  switch (f.length) {
    case 1: {
      const colname = f[0];
      const v = colNameToVar(an, pstate, colname, true);
      if (v) {
        return v;
      }
      // whole-row reference to a relation by name
      const found = refnameNsItem(an, pstate, undefined, colname);
      if (found) {
        return wholeRowVar(an, found.item, found.levelsUp);
      }
      const pidx = an.paramNames.indexOf(colname);
      if (pidx >= 0) {
        return transformParamRef(an, pstate, { kind: 'ParamRef', number: pidx + 1 });
      }
      throw columnDoesNotExist(colname);
    }
    case 2: {
      const [relname, colname] = f;
      const found = refnameNsItem(an, pstate, undefined, relname);
      if (found) {
        const idx = scanNsItemForColumn(found.item, colname);
        if (idx >= 0) {
          return varForColumn(found.item.rte, found.item.rtIndex, idx, found.levelsUp);
        }
        // composite column of whole-row? try function-style
        const wr = wholeRowVar(an, found.item, found.levelsUp);
        const fs = tryFieldSelect(an, wr, colname);
        if (fs) {
          return fs;
        }
        throw columnDoesNotExist(colname, relname);
      }
      if (relname === an.paramFunctionName && an.paramNames.includes(colname)) {
        return transformParamRef(an, pstate, { kind: 'ParamRef', number: an.paramNames.indexOf(colname) + 1 });
      }
      // A.B where A is a composite column
      const col = colNameToVar(an, pstate, relname, true);
      if (col) {
        const fs = tryFieldSelect(an, col, colname);
        if (fs) {
          return fs;
        }
        throw new PgError(SqlState.UNDEFINED_COLUMN, `column "${colname}" not found in data type ${an.types.formatType(col.type, -1, false)}`);
      }
      throw missingRteError(an, pstate, relname);
    }
    case 3: {
      const [a, b, c] = f;
      const found = refnameNsItem(an, pstate, a, b);
      if (found) {
        const idx = scanNsItemForColumn(found.item, c);
        if (idx >= 0) {
          return varForColumn(found.item.rte, found.item.rtIndex, idx, found.levelsUp);
        }
        throw columnDoesNotExist(c, `${a}.${b}`);
      }
      // rel.col.field
      const rel = refnameNsItem(an, pstate, undefined, a);
      if (rel) {
        const idx = scanNsItemForColumn(rel.item, b);
        if (idx >= 0) {
          const v = varForColumn(rel.item.rte, rel.item.rtIndex, idx, rel.levelsUp);
          const fs = tryFieldSelect(an, v, c);
          if (fs) {
            return fs;
          }
        }
      }
      throw missingRteError(an, pstate, b);
    }
    default: {
      const [cat, schema, relname, colname] = f;
      if (cat !== an.env.databaseName) {
        throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `cross-database references are not implemented: ${f.join('.')}`);
      }
      const found = refnameNsItem(an, pstate, schema, relname);
      if (!found) {
        throw missingRteError(an, pstate, relname);
      }
      const idx = scanNsItemForColumn(found.item, colname);
      if (idx < 0) {
        throw columnDoesNotExist(colname, `${schema}.${relname}`);
      }
      return varForColumn(found.item.rte, found.item.rtIndex, idx, found.levelsUp);
    }
  }
}

export function compositeFields(an: Analyzer, e: TExpr): { names: string[]; types: { type: number; typmod: number; collation: number }[] } | null {
  if (e.k === 'row') {
    return { names: e.fieldNames, types: e.args.map((a) => ({ type: a.type, typmod: a.typmod, collation: a.collation })) };
  }
  const t = an.catalog.getType(an.types.baseType(e.type));
  if (t && t.typtype === 'c' && t.relid) {
    const rel = an.catalog.getRelation(t.relid);
    if (rel) {
      const cols = rel.columns.filter((c) => !c.isDropped);
      return { names: cols.map((c) => c.name), types: cols.map((c) => ({ type: c.typeOid, typmod: c.typmod, collation: c.collation })) };
    }
  }
  return null;
}

function tryFieldSelect(an: Analyzer, arg: TExpr, field: string): TExpr | null {
  const fields = compositeFields(an, arg);
  if (!fields) {
    return null;
  }
  const idx = fields.names.indexOf(field);
  if (idx < 0) {
    return null;
  }
  const ti = fields.types[idx];
  return { k: 'fieldselect', arg, fieldIndex: idx, fieldName: field, type: ti.type, typmod: ti.typmod, collation: ti.collation };
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/** make_op */
export function makeOp(an: Analyzer, pstate: ParseState, names: string[], ltree: TExpr | null, rtree: TExpr): TExpr {
  void pstate;
  if (ltree === null) {
    const op = resolvePrefixOperator(an, names, rtree.type);
    const resolved = an.types.resolvePolymorphic([rtree.type], [op.right], op.result);
    const arg = coerceArg(an, rtree, resolved.argTypes[0]);
    const proc = an.catalog.getProc(op.codeOid);
    return {
      k: 'op',
      opOid: op.oid,
      opName: op.name,
      funcSrc: op.codeSrc,
      funcOid: op.codeOid,
      args: [arg],
      type: resolved.rettype,
      typmod: -1,
      collation: an.typeCollation(resolved.rettype) ? arg.collation || an.typeCollation(resolved.rettype) : 0,
      inputCollation: arg.collation,
      retset: proc ? proc.retset : false,
    };
  }
  const op = resolveBinaryOperator(an, names, ltree.type, rtree.type)!;
  const resolved = an.types.resolvePolymorphic([ltree.type, rtree.type], [op.left, op.right], op.result);
  const l = coerceArg(an, ltree, resolved.argTypes[0]);
  const r = coerceArg(an, rtree, resolved.argTypes[1]);
  const proc = an.catalog.getProc(op.codeOid);
  const inputCollation = mergeCollations(l, r);
  return {
    k: 'op',
    opOid: op.oid,
    opName: op.name,
    funcSrc: op.codeSrc,
    funcOid: op.codeOid,
    args: [l, r],
    type: resolved.rettype,
    typmod: -1,
    collation: an.typeCollation(resolved.rettype) ? inputCollation || an.typeCollation(resolved.rettype) : 0,
    inputCollation,
    retset: proc ? proc.retset : false,
  };
}

export function mergeCollations(l: TExpr, r: TExpr): number {
  if (l.k === 'collate') {
    return l.collation;
  }
  if (r.k === 'collate') {
    return r.collation;
  }
  return l.collation || r.collation;
}

export function coerceArg(an: Analyzer, e: TExpr, target: number): TExpr {
  if (e.type === target) {
    return e;
  }
  const c = an.coerceToTargetType(e, target, -1, 'implicit', 'implicit_cast');
  if (!c) {
    throw new PgError(SqlState.CANNOT_COERCE, `cannot cast type ${an.types.formatType(e.type, -1, false)} to ${an.types.formatType(target, -1, false)}`);
  }
  return c;
}

function transformAExpr(an: Analyzer, pstate: ParseState, node: A.AExpr): TExpr {
  switch (node.exprKind) {
    case 'OP': {
      const lexpr = node.lexpr;
      const rexpr = node.rexpr as A.Expr;
      // row comparison: (a,b) = (c,d)
      if (lexpr && isRowish(lexpr) && isRowish(rexpr)) {
        const l = transformExprRecurse(an, pstate, lexpr);
        const r = transformExprRecurse(an, pstate, rexpr);
        if (l.k === 'row' && r.k === 'row') {
          return makeRowComparisonOp(an, pstate, node.name, l.args, r.args);
        }
        return makeOp(an, pstate, node.name, l, r);
      }
      // "x = ANY" handled by parser; "NULL = x" transform_null_equals is off by default
      const l = lexpr ? transformExprRecurse(an, pstate, lexpr) : null;
      const r = transformExprRecurse(an, pstate, rexpr);
      if (l && l.k === 'row' && r.k === 'row') {
        return makeRowComparisonOp(an, pstate, node.name, l.args, r.args);
      }
      return makeOp(an, pstate, node.name, l, r);
    }
    case 'OP_ANY':
    case 'OP_ALL': {
      const l = transformExprRecurse(an, pstate, node.lexpr!);
      const r = transformExprRecurse(an, pstate, node.rexpr as A.Expr);
      return makeScalarArrayOp(an, pstate, node.name, node.exprKind === 'OP_ANY', l, r);
    }
    case 'DISTINCT':
    case 'NOT_DISTINCT': {
      const l = transformExprRecurse(an, pstate, node.lexpr!);
      const r = transformExprRecurse(an, pstate, node.rexpr as A.Expr);
      if (l.k === 'row' && r.k === 'row') {
        const cmp = makeRowComparisonOp(an, pstate, ['='], l.args, r.args, true);
        return node.exprKind === 'DISTINCT' ? { k: 'bool', op: 'not', args: [cmp], type: TypeOid.bool, typmod: -1, collation: 0 } : cmp;
      }
      const op = makeOp(an, pstate, ['='], l, r);
      if (op.k !== 'op' || op.type !== TypeOid.bool) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, 'IS DISTINCT FROM requires = operator to yield boolean');
      }
      return { k: 'distinct', isNot: node.exprKind === 'NOT_DISTINCT', opSrc: op.funcSrc, opOid: op.opOid, args: op.args, type: TypeOid.bool, typmod: -1, collation: 0, inputCollation: op.inputCollation };
    }
    case 'NULLIF': {
      const l = transformExprRecurse(an, pstate, node.lexpr!);
      const r = transformExprRecurse(an, pstate, node.rexpr as A.Expr);
      const op = makeOp(an, pstate, ['='], l, r);
      if (op.k !== 'op' || op.type !== TypeOid.bool) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, 'NULLIF requires = operator to yield boolean');
      }
      const type = op.args[0].type;
      return { k: 'nullif', args: op.args, opSrc: op.funcSrc, opOid: op.opOid, type, typmod: op.args[0].typmod, collation: op.args[0].collation };
    }
    case 'IN':
      return transformAExprIn(an, pstate, node);
    case 'LIKE':
    case 'ILIKE':
    case 'SIMILAR': {
      const l = transformExprRecurse(an, pstate, node.lexpr!);
      const r = transformExprRecurse(an, pstate, node.rexpr as A.Expr);
      return makeOp(an, pstate, node.name, l, r);
    }
    case 'BETWEEN':
    case 'NOT_BETWEEN':
    case 'BETWEEN_SYM':
    case 'NOT_BETWEEN_SYM': {
      const [lo, hi] = node.rexpr as A.Expr[];
      const a = node.lexpr!;
      const mk = (op: string, x: A.Expr, y: A.Expr): A.Expr => ({ kind: 'AExpr', exprKind: 'OP', name: [op], lexpr: x, rexpr: y, loc: node.loc });
      const and = (x: A.Expr, y: A.Expr): A.Expr => ({ kind: 'BoolExpr', op: 'AND', args: [x, y] });
      const or = (x: A.Expr, y: A.Expr): A.Expr => ({ kind: 'BoolExpr', op: 'OR', args: [x, y] });
      let rewritten: A.Expr;
      switch (node.exprKind) {
        case 'BETWEEN':
          rewritten = and(mk('>=', a, lo), mk('<=', a, hi));
          break;
        case 'NOT_BETWEEN':
          rewritten = or(mk('<', a, lo), mk('>', a, hi));
          break;
        case 'BETWEEN_SYM':
          rewritten = or(and(mk('>=', a, lo), mk('<=', a, hi)), and(mk('>=', a, hi), mk('<=', a, lo)));
          break;
        default:
          rewritten = and(or(mk('<', a, lo), mk('>', a, hi)), or(mk('<', a, hi), mk('>', a, lo)));
      }
      return transformExprRecurse(an, pstate, rewritten);
    }
  }
}

function isRowish(e: A.Expr): boolean {
  return e.kind === 'RowExpr';
}

/** make_scalar_array_op */
export function makeScalarArrayOp(an: Analyzer, pstate: ParseState, names: string[], useOr: boolean, l: TExpr, r: TExpr): TExpr {
  void pstate;
  const ltype = l.type;
  const atype = r.type;
  let rtype: number;
  if (atype === TypeOid.unknown) {
    rtype = TypeOid.unknown;
  } else {
    rtype = an.types.elemType(atype);
    if (!rtype) {
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, 'op ANY/ALL (array) requires array on right side');
    }
  }
  const op = resolveBinaryOperator(an, names, ltype, rtype)!;
  const resolved = an.types.resolvePolymorphic([ltype, rtype], [op.left, op.right], op.result);
  if (resolved.rettype !== TypeOid.bool) {
    throw new PgError(SqlState.WRONG_OBJECT_TYPE, 'op ANY/ALL (array) requires operator to yield boolean');
  }
  let resAtype: number;
  if (op.right === TypeOid.anyelement || op.right === TypeOid.anynonarray || op.right === TypeOid.anycompatible) {
    resAtype = atype !== TypeOid.unknown ? atype : an.types.arrayTypeOf(resolved.argTypes[1]);
  } else {
    resAtype = an.types.arrayTypeOf(resolved.argTypes[1]);
    if (!resAtype) {
      throw new PgError(SqlState.UNDEFINED_OBJECT, `could not find array type for data type ${an.types.formatType(resolved.argTypes[1], -1, false)}`);
    }
  }
  const la = coerceArg(an, l, resolved.argTypes[0]);
  const ra = coerceArg(an, r, resAtype);
  return {
    k: 'saop',
    opOid: op.oid,
    opName: op.name,
    opSrc: op.codeSrc,
    useOr,
    args: [la, ra],
    type: TypeOid.bool,
    typmod: -1,
    collation: 0,
    inputCollation: mergeCollations(la, ra),
  };
}

/** make_row_comparison_op */
export function makeRowComparisonOp(an: Analyzer, pstate: ParseState, names: string[], largs: TExpr[], rargs: TExpr[], forDistinct = false): TExpr {
  if (largs.length !== rargs.length) {
    throw new PgError(SqlState.SYNTAX_ERROR, 'unequal number of entries in row expressions');
  }
  if (largs.length === 0) {
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, 'cannot compare rows of zero length');
  }
  const opname = names[names.length - 1];
  const ops = largs.map((l, i) => makeOp(an, pstate, names, l, rargs[i]));
  for (const o of ops) {
    if (o.type !== TypeOid.bool) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, `row comparison operator must yield type boolean, not type ${an.types.formatType(o.type, -1, false)}`);
    }
  }
  if (forDistinct) {
    // IS NOT DISTINCT FROM per column, ANDed
    const parts: TExpr[] = ops.map((o) => {
      const op = o as TExpr & { k: 'op' };
      return { k: 'distinct', isNot: true, opSrc: op.funcSrc, opOid: op.opOid, args: op.args, type: TypeOid.bool, typmod: -1, collation: 0, inputCollation: op.inputCollation } as TExpr;
    });
    return parts.length === 1 ? parts[0] : { k: 'bool', op: 'and', args: parts, type: TypeOid.bool, typmod: -1, collation: 0 };
  }
  if (ops.length === 1) {
    return ops[0];
  }
  if (opname === '=') {
    return { k: 'bool', op: 'and', args: ops, type: TypeOid.bool, typmod: -1, collation: 0 };
  }
  if (opname === '<>') {
    return { k: 'bool', op: 'or', args: ops, type: TypeOid.bool, typmod: -1, collation: 0 };
  }
  if (opname === '<' || opname === '<=' || opname === '>' || opname === '>=') {
    return {
      k: 'rowcompare',
      op: opname,
      opSrcs: ops.map((o) => (o as TExpr & { k: 'op' }).funcSrc),
      opOids: ops.map((o) => (o as TExpr & { k: 'op' }).opOid),
      largs: ops.map((o) => (o as TExpr & { k: 'op' }).args[0]),
      rargs: ops.map((o) => (o as TExpr & { k: 'op' }).args[1]),
      collations: ops.map((o) => (o as TExpr & { k: 'op' }).inputCollation),
      type: TypeOid.bool,
      typmod: -1,
      collation: 0,
    };
  }
  throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `could not determine interpretation of row comparison operator ${opname}`, {
    hint: 'Row comparison operators must be associated with btree operator families.',
  });
}

function transformAExprIn(an: Analyzer, pstate: ParseState, node: A.AExpr): TExpr {
  const useOr = node.name[0] === '=';
  const lexpr = transformExprRecurse(an, pstate, node.lexpr!);
  const items = (node.rexpr as A.Expr[]).map((e) => transformExprRecurse(an, pstate, e));
  const rnonvars: TExpr[] = [];
  const rvars: TExpr[] = [];
  for (const it of items) {
    if (containsVarsOfLevel(it, 0)) {
      rvars.push(it);
    } else {
      rnonvars.push(it);
    }
  }
  let result: TExpr | null = null;
  let remaining = items;
  if (rnonvars.length > 1 && lexpr.k !== 'row') {
    const all = [lexpr, ...rnonvars];
    let scalarType = an.types.selectCommonType(
      all.map((e) => e.type),
      null
    );
    if (scalarType && !all.every((e) => an.types.canCoerceSingle(e.type, scalarType, 'implicit', e))) {
      scalarType = 0;
    }
    const arrayType = scalarType && scalarType !== TypeOid.record ? an.types.arrayTypeOf(scalarType) : 0;
    if (arrayType) {
      const elements = rnonvars.map((e) => an.coerceToCommonType(e, scalarType, 'IN'));
      const arr: ArrayNode = { k: 'array', elements, elemType: scalarType, multidims: false, type: arrayType, typmod: -1, collation: an.typeCollation(scalarType) };
      result = makeScalarArrayOp(an, pstate, node.name, useOr, lexpr, arr);
      remaining = rvars;
    }
  }
  for (const r of remaining) {
    let cmp: TExpr;
    if (lexpr.k === 'row' && r.k === 'row') {
      cmp = makeRowComparisonOp(an, pstate, node.name, lexpr.args, r.args);
    } else {
      cmp = makeOp(an, pstate, node.name, lexpr, r);
    }
    cmp = an.coerceToBoolean(pstate, cmp, 'IN');
    if (!result) {
      result = cmp;
    } else {
      result = { k: 'bool', op: useOr ? 'or' : 'and', args: [result, cmp], type: TypeOid.bool, typmod: -1, collation: 0 };
    }
  }
  return result!;
}

// ---------------------------------------------------------------------------
// CASE
// ---------------------------------------------------------------------------

function transformCaseExpr(an: Analyzer, pstate: ParseState, node: A.CaseExpr): TExpr {
  let arg: TExpr | null = null;
  let testSlot = -1;
  let placeholder: TExpr | null = null;
  if (node.arg) {
    arg = transformExprRecurse(an, pstate, node.arg);
    if (arg.type === TypeOid.unknown) {
      arg = an.resolveUnknownToText(arg);
    }
    testSlot = an.allocExecSlot();
    placeholder = { k: 'execparam', slot: testSlot, type: arg.type, typmod: arg.typmod, collation: arg.collation };
  }
  const whens: { cond: TExpr; result: TExpr }[] = [];
  const results: TExpr[] = [];
  for (const w of node.whens) {
    let cond: TExpr;
    if (placeholder) {
      const warg = transformExprRecurse(an, pstate, w.expr);
      cond = makeOp(an, pstate, ['='], placeholder, warg);
    } else {
      cond = transformExprRecurse(an, pstate, w.expr);
    }
    cond = an.coerceToBoolean(pstate, cond, 'CASE/WHEN');
    const result = transformExprRecurse(an, pstate, w.result);
    whens.push({ cond, result });
    results.push(result);
  }
  const def = node.defresult ? transformExprRecurse(an, pstate, node.defresult) : an.makeUnknownConst(null);
  const allResults = [def, ...results];
  const type = an.types.selectCommonType(
    allResults.map((r) => r.type),
    'CASE'
  );
  const typmod = an.selectCommonTypmod(allResults, type);
  const coercedDef = an.coerceToCommonType(def, type, 'CASE/ELSE');
  for (const w of whens) {
    w.result = an.coerceToCommonType(w.result, type, 'CASE/WHEN');
  }
  const node2: CaseNode = {
    k: 'case',
    arg,
    testSlot,
    whens,
    def: coercedDef,
    type,
    typmod,
    collation: an.typeCollation(type) ? resolveCollation([coercedDef, ...whens.map((w) => w.result)], an.typeCollation(type)) : 0,
  };
  return node2;
}

// ---------------------------------------------------------------------------
// Sublinks
// ---------------------------------------------------------------------------

function transformSubLink(an: Analyzer, pstate: ParseState, node: A.SubLink): TExpr {
  if (pstate.exprKind === 'check_constraint' || pstate.exprKind === 'column_default' || pstate.exprKind === 'index_expression' || pstate.exprKind === 'index_predicate') {
    const what: Record<string, string> = {
      check_constraint: 'check constraint',
      column_default: 'DEFAULT expression',
      index_expression: 'index expression',
      index_predicate: 'index predicate',
    };
    throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `cannot use subquery in ${what[pstate.exprKind]}`);
  }
  const { query, child } = analyzeSelectForSubquery(an, node.subselect, pstate);
  const correlated = child.maxOuterRef >= 1;
  const visibleTargets = query.targetList.filter((t) => !t.resjunk);
  const id = an.nextSublinkId++;
  const base: Omit<SubLinkNode, 'linkType' | 'type'> = {
    k: 'sublink',
    testLeft: [],
    operators: [],
    subquery: query,
    correlated,
    id,
    typmod: -1,
    collation: 0,
  };
  switch (node.linkType) {
    case 'EXISTS':
      return { ...base, linkType: 'EXISTS', type: TypeOid.bool };
    case 'EXPR': {
      if (visibleTargets.length !== 1) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'subquery must return only one column');
      }
      const te = visibleTargets[0];
      return { ...base, linkType: 'EXPR', type: te.expr.type, typmod: te.expr.typmod, collation: te.expr.collation };
    }
    case 'ARRAY': {
      if (visibleTargets.length !== 1) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'subquery must return only one column');
      }
      const te = visibleTargets[0];
      let arrType = an.types.isArray(te.expr.type) ? te.expr.type : an.types.arrayTypeOf(te.expr.type);
      if (!arrType) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `could not find array type for data type ${an.types.formatType(te.expr.type, -1, false)}`);
      }
      return { ...base, linkType: 'ARRAY', type: arrType, typmod: -1, collation: te.expr.collation };
    }
    case 'ANY':
    case 'ALL': {
      const left = transformExprRecurse(an, pstate, node.testexpr!);
      const lefts = left.k === 'row' ? left.args : [left];
      if (lefts.length < visibleTargets.length) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'subquery has too many columns');
      }
      if (lefts.length > visibleTargets.length) {
        throw new PgError(SqlState.SYNTAX_ERROR, 'subquery has too few columns');
      }
      const testLeft: TExpr[] = [];
      const operators: SubLinkNode['operators'] = [];
      for (let i = 0; i < lefts.length; i++) {
        const rt = visibleTargets[i].expr;
        const placeholder: TExpr = { k: 'execparam', slot: -1, type: rt.type, typmod: rt.typmod, collation: rt.collation };
        const op = makeOp(an, pstate, node.operName.length ? node.operName : ['='], lefts[i], placeholder);
        if (op.k !== 'op') {
          throw new PgError(SqlState.DATATYPE_MISMATCH, 'operator must yield boolean');
        }
        if (op.type !== TypeOid.bool) {
          throw new PgError(SqlState.DATATYPE_MISMATCH, `operator ${op.opName} must return type boolean, not type ${an.types.formatType(op.type, -1, false)}`);
        }
        testLeft.push(op.args[0]);
        // right side coercion of the subquery output is applied at runtime via rightType
        const rightArg = op.args[1];
        if (rightArg.k !== 'execparam') {
          // record the coercion by wrapping target entry expression
          const te = visibleTargets[i];
          te.expr = replacePlaceholder(rightArg, te.expr);
        }
        operators.push({ opName: op.opName, opSrc: op.funcSrc, opOid: op.opOid, leftType: op.args[0].type, rightType: op.args[1].type, collation: op.inputCollation });
      }
      return { ...base, linkType: node.linkType, testLeft, operators, type: TypeOid.bool };
    }
    default:
      throw new PgError(SqlState.FEATURE_NOT_SUPPORTED, `sublink type ${node.linkType} is not supported`);
  }
}

/** Replace the execparam placeholder (slot -1) inside a coercion expression with `replacement`. */
function replacePlaceholder(e: TExpr, replacement: TExpr): TExpr {
  if (e.k === 'execparam' && e.slot === -1) {
    return replacement;
  }
  if (e.k === 'relabel' || e.k === 'iocoerce' || e.k === 'domaincoerce') {
    return { ...e, arg: replacePlaceholder(e.arg, replacement) } as TExpr;
  }
  if (e.k === 'arraycoerce') {
    return { ...e, arg: replacePlaceholder(e.arg, replacement) };
  }
  if (e.k === 'func') {
    return { ...e, args: e.args.map((a, i) => (i === 0 ? replacePlaceholder(a, replacement) : a)) };
  }
  return e;
}

// ---------------------------------------------------------------------------
// Arrays / rows / indirection
// ---------------------------------------------------------------------------

export function transformArrayExpr(an: Analyzer, pstate: ParseState, node: A.ArrayExpr, arrayType: number, elementType: number, typmod: number): TExpr {
  const elements: TExpr[] = [];
  for (const e of node.elements) {
    if (e.kind === 'ArrayExpr') {
      elements.push(transformArrayExpr(an, pstate, e, arrayType, elementType, typmod));
    } else {
      elements.push(transformExprRecurse(an, pstate, e));
    }
  }
  let coerceType: number;
  let resultArrayType: number;
  let multidims = false;
  if (elements.length === 0 && !elementType) {
    throw new PgError(SqlState.INDETERMINATE_DATATYPE, 'cannot determine type of empty array', {
      hint: 'Explicitly cast to the desired type, for example ARRAY[]::integer[].',
    });
  }
  if (elementType) {
    coerceType = node.elements.length > 0 && node.elements[0].kind === 'ArrayExpr' ? arrayType : elementType;
    resultArrayType = arrayType;
  } else {
    const common = an.types.selectCommonType(
      elements.map((e) => e.type),
      'ARRAY'
    );
    if (an.types.isArray(common)) {
      coerceType = common;
      resultArrayType = common;
      if (!elements.every((e) => e.k === 'array' || an.types.isArray(e.type))) {
        throw new PgError(SqlState.DATATYPE_MISMATCH, 'ARRAY types cannot be matched');
      }
    } else {
      coerceType = common;
      resultArrayType = an.types.arrayTypeOf(common);
      if (!resultArrayType) {
        throw new PgError(SqlState.UNDEFINED_OBJECT, `could not find array type for data type ${an.types.formatType(common, -1, false)}`);
      }
    }
  }
  const coerced = elements.map((e) => {
    if (e.k === 'array') {
      multidims = true;
      return e;
    }
    if (elementType) {
      const c = an.coerceToTargetType(e, coerceType, typmod, 'explicit', 'explicit_cast');
      if (!c) {
        throw new PgError(SqlState.CANNOT_COERCE, `cannot cast type ${an.types.formatType(e.type, -1, false)} to ${an.types.formatType(coerceType, -1, false)}`);
      }
      return c;
    }
    return an.coerceToCommonType(e, coerceType, 'ARRAY');
  });
  if (coerced.some((e) => an.types.isArray(e.type) && e.k !== 'array')) {
    multidims = true;
  }
  const elemType = an.types.elemType(resultArrayType);
  return { k: 'array', elements: coerced, elemType, multidims, type: resultArrayType, typmod: -1, collation: an.typeCollation(elemType) };
}

function transformRowExpr(an: Analyzer, pstate: ParseState, node: A.RowExpr): TExpr {
  const args: TExpr[] = [];
  for (const a of node.args) {
    if (a.kind === 'ColumnRef' && a.fields[a.fields.length - 1] === '*') {
      // expand t.* inside ROW()
      const relname = a.fields[a.fields.length - 2];
      if (relname === undefined) {
        for (const item of pstate.namespace) {
          if (item.colsVisible) {
            item.rte.eref.colnames.forEach((_, i) => args.push(varForColumn(item.rte, item.rtIndex, i, 0)));
          }
        }
        continue;
      }
      const found = refnameNsItem(an, pstate, a.fields.length === 3 ? a.fields[0] : undefined, relname);
      if (!found) {
        throw missingRteError(an, pstate, relname);
      }
      found.item.rte.eref.colnames.forEach((_, i) => args.push(varForColumn(found.item.rte, found.item.rtIndex, i, found.levelsUp)));
      continue;
    }
    args.push(transformExprRecurse(an, pstate, a));
  }
  if (args.length > 1664) {
    throw new PgError(SqlState.PROGRAM_LIMIT_EXCEEDED, 'ROW expressions can have at most 1664 entries');
  }
  return {
    k: 'row',
    args,
    fieldNames: args.map((_, i) => `f${i + 1}`),
    explicitRow: node.explicitRow,
    type: TypeOid.record,
    typmod: -1,
    collation: 0,
  };
}

function transformIndirection(an: Analyzer, pstate: ParseState, node: A.Indirection): TExpr {
  let result = transformExprRecurse(an, pstate, node.arg);
  const subscripts: A.IndirectionEl[] = [];
  const flushSubscripts = () => {
    if (subscripts.length === 0) {
      return;
    }
    result = transformSubscripts(an, pstate, result, subscripts.splice(0));
  };
  for (const el of node.indirection) {
    if (el.type === 'index') {
      subscripts.push(el);
      continue;
    }
    flushSubscripts();
    if (el.type === 'star') {
      throw new PgError(SqlState.SYNTAX_ERROR, 'row expansion via "*" is not supported here');
    }
    let fs = tryFieldSelect(an, result, el.name);
    if (!fs && result.type === TypeOid.record && result.k === 'var') {
      fs = null;
    }
    if (!fs) {
      if (an.types.isComposite(result.type) || result.type === TypeOid.record) {
        throw new PgError(SqlState.UNDEFINED_COLUMN, `could not identify column "${el.name}" in record data type`);
      }
      throw new PgError(SqlState.WRONG_OBJECT_TYPE, `column notation .${el.name} applied to type ${an.types.formatType(result.type, -1, false)}, which is not a composite type`);
    }
    result = fs;
  }
  flushSubscripts();
  return result;
}

export function transformSubscripts(an: Analyzer, pstate: ParseState, container: TExpr, subs: A.IndirectionEl[]): TExpr {
  const base = an.types.baseType(container.type);
  const isSlice = subs.some((s) => s.type === 'index' && s.isSlice);
  if (base === TypeOid.jsonb) {
    if (isSlice) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, 'jsonb subscript does not support slices');
    }
    const upper = subs.map((s) => {
      const e = transformExprRecurse(an, pstate, (s as { uidx: A.Expr }).uidx);
      if (e.type === TypeOid.unknown) {
        return an.coerceType(e, e.type, TypeOid.text, -1, 'implicit', 'implicit_cast');
      }
      if (e.type !== TypeOid.int4 && e.type !== TypeOid.text) {
        const c = an.coerceToTargetType(e, TypeOid.int4, -1, 'implicit', 'implicit_cast') ?? an.coerceToTargetType(e, TypeOid.text, -1, 'implicit', 'implicit_cast');
        if (!c) {
          throw new PgError(SqlState.DATATYPE_MISMATCH, 'subscript type %s is not supported'.replace('%s', an.types.formatType(e.type, -1, false)), {
            hint: 'jsonb subscript must be coercible to either integer or text.',
          });
        }
        return c;
      }
      return e;
    });
    return { k: 'subscript', arg: container, upper, lower: null, isSlice: false, isJsonb: true, type: TypeOid.jsonb, typmod: -1, collation: 0 };
  }
  const t = an.catalog.getType(base);
  if (!t || !(t.isArray || base === TypeOid.int2vector || base === TypeOid.oidvector || base === TypeOid.name || base === TypeOid.point)) {
    throw new PgError(SqlState.DATATYPE_MISMATCH, `cannot subscript type ${an.types.formatType(container.type, -1, false)} because it does not support subscripting`);
  }
  const elemType = base === TypeOid.int2vector ? TypeOid.int2 : base === TypeOid.oidvector ? TypeOid.oid : t.elem;
  const toInt = (e: A.Expr | null): TExpr | null => {
    if (!e) {
      return null;
    }
    const x = transformExprRecurse(an, pstate, e);
    const c = an.coerceToTargetType(x, TypeOid.int4, -1, 'assignment', 'implicit_cast');
    if (!c) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, 'array subscript must have type integer');
    }
    return c;
  };
  const upper: (TExpr | null)[] = [];
  const lower: (TExpr | null)[] = [];
  for (const s of subs) {
    const ss = s as { lidx: A.Expr | null; uidx: A.Expr | null; isSlice: boolean };
    if (isSlice) {
      lower.push(ss.isSlice ? toInt(ss.lidx) : an.makeInt4Const(1));
    }
    upper.push(toInt(ss.uidx));
  }
  const type = isSlice ? base : elemType;
  return {
    k: 'subscript',
    arg: container,
    upper,
    lower: isSlice ? lower : null,
    isSlice,
    isJsonb: false,
    type,
    typmod: isSlice ? container.typmod : container.typmod,
    collation: an.typeCollation(elemType) ? container.collation || COLL_DEFAULT : 0,
  };
}

function transformSqlValue(node: A.SqlValueFunction): TExpr {
  const typmod = node.typmod ?? -1;
  const mk = (type: number) => ({ k: 'sqlvalue' as const, op: node.op, type, typmod, collation: type === TypeOid.name ? 950 : 0 });
  switch (node.op) {
    case 'CURRENT_DATE':
      return mk(TypeOid.date);
    case 'CURRENT_TIME':
    case 'CURRENT_TIME_N':
      return mk(TypeOid.timetz);
    case 'CURRENT_TIMESTAMP':
    case 'CURRENT_TIMESTAMP_N':
      return mk(TypeOid.timestamptz);
    case 'LOCALTIME':
    case 'LOCALTIME_N':
      return mk(TypeOid.time);
    case 'LOCALTIMESTAMP':
    case 'LOCALTIMESTAMP_N':
      return mk(TypeOid.timestamp);
    case 'SYSTEM_USER':
      return mk(TypeOid.text);
    default:
      return mk(TypeOid.name);
  }
}

function transformGroupingFunc(an: Analyzer, pstate: ParseState, node: A.GroupingFunc): TExpr {
  if (pstate.exprKind !== 'select' && pstate.exprKind !== 'having' && pstate.exprKind !== 'order_by') {
    throw new PgError(SqlState.GROUPING_ERROR, `grouping operations are not allowed in ${an.exprKindName(pstate.exprKind)}`);
  }
  const args = node.args.map((a) => transformExprRecurse(an, pstate, a));
  // refs resolved later by grouping analysis
  return { k: 'grouping', refs: [], levelsUp: 0, type: TypeOid.int4, typmod: -1, collation: 0, __args: args } as TExpr;
}
