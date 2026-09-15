import { Catalog, NS_PG_CATALOG, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { IoContext, applyCharTypmod, inputValue, roundTime, roundTimestamp } from '../types/io';
import { PgNumeric } from '../types/numeric';
import {
  ArrayCoerceNode,
  ConstNode,
  ExecParamNode,
  FuncNode,
  TExpr,
  TypeInfo,
} from './nodes';
import { ExprKind, EXPR_KIND_NAMES, ParseState } from './parse-state';
import { CoercionContext, CoercionPath, TypeUtil, isPolymorphic } from './typeutil';
import { atPosition, exprLocation, positioned } from './location';

/** What the analyzer needs from the session. */
export interface AnalyzerEnv {
  catalog(): Catalog;
  /** namespaces searched for relations/types (temp schema first when present) */
  relationSearchPath(): number[];
  /** namespaces searched for functions/operators (pg_catalog implicit first) */
  functionSearchPath(): number[];
  /** namespace where unqualified CREATE puts objects */
  creationNamespace(): number;
  tempNamespace(create: boolean): number;
  io: IoContext;
  databaseName: string;
  userName: string;
}

/**
 * Statement-level analysis driver. Holds state shared by all query levels of one statement:
 * parameter types (inferred like PostgreSQL's variable parameter hooks), exec-param slots, ids.
 */
export class Analyzer {
  readonly types: TypeUtil;
  readonly catalog: Catalog;
  /** inferred parameter types, index = paramId - 1 (0 = unknown yet) */
  paramTypes: number[];
  /** parameter types fixed by the client (prepared statement types) */
  readonly fixedParamTypes: boolean;
  nextExecSlot = 0;
  nextSublinkId = 0;
  nextCteId = 0;
  /** SQL-function parameter names (resolve unqualified column references to $n) */
  paramNames: string[] = [];
  /** function name for qualified parameter references (fname.param) */
  paramFunctionName = '';
  /** a domain CHECK constraint being analyzed: `VALUE` is this executor parameter (CoerceToDomainValue) */
  domainValue: { slot: number; type: number; typmod: number; collation: number } | null = null;
  /** ephemeral named relations of a trigger function's statement: its transition tables */
  transitionTables: { name: string; rel: import('../catalog/catalog').Relation; rows: unknown[][] }[] | null = null;

  constructor(
    readonly env: AnalyzerEnv,
    paramTypes: number[] = [],
    fixed = false
  ) {
    this.catalog = env.catalog();
    this.types = new TypeUtil(this.catalog);
    this.paramTypes = paramTypes.slice();
    this.fixedParamTypes = fixed;
  }

  allocExecSlot(): number {
    return this.nextExecSlot++;
  }

  error(code: string, message: string, fields?: Record<string, unknown>): PgError {
    return new PgError(code, message, fields as never);
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  paramType(id: number): number {
    const t = this.paramTypes[id - 1];
    return t === undefined || t === 0 ? TypeOid.unknown : t;
  }

  setParamType(id: number, type: number): void {
    while (this.paramTypes.length < id) {
      this.paramTypes.push(0);
    }
    const cur = this.paramTypes[id - 1];
    if (cur && cur !== TypeOid.unknown && cur !== type) {
      throw new PgError(SqlState.AMBIGUOUS_PARAMETER, `inconsistent types deduced for parameter $${id}`, {
        detail: `${this.types.formatType(cur, -1, false)} versus ${this.types.formatType(type, -1, false)}`,
      });
    }
    this.paramTypes[id - 1] = type;
  }

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  makeUnknownConst(text: string | null): ConstNode {
    return { k: 'const', type: TypeOid.unknown, typmod: -1, collation: 0, value: text, isNull: text === null };
  }

  makeTypedConst(type: number, value: unknown, typmod = -1): ConstNode {
    const t = this.catalog.getType(type);
    const collation = t ? t.collation : 0;
    return { k: 'const', type, typmod, collation, value, isNull: value === null || value === undefined };
  }

  makeBoolConst(v: boolean | null): ConstNode {
    return { k: 'const', type: TypeOid.bool, typmod: -1, collation: 0, value: v, isNull: v === null };
  }

  makeInt4Const(v: number): ConstNode {
    return { k: 'const', type: TypeOid.int4, typmod: -1, collation: 0, value: v, isNull: false };
  }

  /** Integer literal typing: int4, else int8, else numeric. */
  makeIntegerLiteral(text: string): ConstNode {
    const big = BigInt(text);
    if (big >= -2147483648n && big <= 2147483647n) {
      return this.makeTypedConst(TypeOid.int4, Number(big));
    }
    if (big >= -9223372036854775808n && big <= 9223372036854775807n) {
      return this.makeTypedConst(TypeOid.int8, big);
    }
    return this.makeTypedConst(TypeOid.numeric, PgNumeric.parse(text));
  }

  typeCollation(type: number): number {
    const t = this.catalog.getType(this.types.baseType(type));
    return t ? t.collation : 0;
  }

  // -------------------------------------------------------------------------
  // Coercion (parse_coerce.c)
  // -------------------------------------------------------------------------

  /**
   * coerce_type + coerce_type_typmod. Throws a PgError if no coercion exists.
   */
  coerceToTargetType(
    expr: TExpr,
    targetType: number,
    targetTypmod: number,
    ccontext: CoercionContext,
    format: 'explicit_cast' | 'implicit_cast'
  ): TExpr | null {
    const inputType = expr.type;
    if (!this.types.canCoerceSingle(inputType, targetType, ccontext, expr)) {
      return null;
    }
    let result = this.coerceType(expr, inputType, targetType, targetTypmod, ccontext, format);
    result = this.coerceTypeTypmod(result, targetType, targetTypmod, format === 'explicit_cast', format);
    return result;
  }

  coerceType(expr: TExpr, inputType: number, targetType: number, targetTypmod: number, ccontext: CoercionContext, format: 'explicit_cast' | 'implicit_cast'): TExpr {
    if (targetType === inputType) {
      return expr;
    }
    if (targetType === TypeOid.any || isPolymorphic(targetType)) {
      // polymorphic targets must have been resolved by the caller; leave unknown literals as text
      if (inputType === TypeOid.unknown && (expr.k === 'const' || expr.k === 'param')) {
        if (targetType === TypeOid.any) {
          return expr;
        }
      }
      return expr;
    }
    if (inputType === TypeOid.unknown && expr.k === 'const') {
      return this.coerceUnknownConst(expr, targetType, targetTypmod, format);
    }
    if (inputType === TypeOid.unknown && expr.k === 'param') {
      this.setParamType(expr.paramId, targetType);
      return { ...expr, type: targetType, typmod: -1, collation: this.typeCollation(targetType) };
    }
    if (inputType === TypeOid.unknown) {
      // unknown-typed non-constant (e.g. CASE over unknowns resolved late): via I/O
      return { k: 'iocoerce', arg: expr, type: targetType, typmod: -1, collation: this.typeCollation(targetType), format };
    }
    if (targetType === TypeOid.record && this.types.isComposite(inputType)) {
      return expr;
    }
    if (targetType === TypeOid._record && this.types.isArray(inputType)) {
      return expr;
    }
    if (inputType === TypeOid.record && expr.k === 'row' && this.types.isComposite(targetType)) {
      return this.coerceRecordToComplex(expr, targetType, ccontext, format);
    }
    const targetBase = this.types.baseType(targetType);
    const isDomain = targetBase !== targetType;
    const path = this.types.findCoercionPathway(targetBase, inputType, ccontext);
    let result = this.buildCoercion(expr, path, inputType, targetBase, targetTypmod, ccontext, format);
    if (isDomain) {
      result = this.coerceToDomain(result, targetBase, targetType, targetTypmod, format);
    }
    return result;
  }

  /** The typmod a domain (chain) declares for its base type (getBaseTypeAndTypmod), or -1. */
  domainBaseTypmod(domainType: number): number {
    let t = this.catalog.getType(domainType);
    for (let guard = 0; t && t.typtype === 'd' && guard < 32; guard++) {
      if (t.typmod >= 0) {
        return t.typmod;
      }
      t = this.catalog.getType(t.baseType);
    }
    return -1;
  }

  /** coerce_to_domain: apply the base type's typmod the domain declares, then check the domain's constraints. */
  private coerceToDomain(arg: TExpr, baseType: number, domainType: number, typmod: number, format: 'explicit_cast' | 'implicit_cast'): TExpr {
    const baseTypmod = this.domainBaseTypmod(domainType);
    const coerced = baseTypmod >= 0 ? this.coerceTypeTypmod(arg, baseType, baseTypmod, format === 'explicit_cast', format) : arg;
    return { k: 'domaincoerce', arg: coerced, type: domainType, typmod, collation: coerced.collation, domainOid: domainType, format };
  }

  private buildCoercion(expr: TExpr, path: CoercionPath, inputType: number, target: number, targetTypmod: number, ccontext: CoercionContext, format: 'explicit_cast' | 'implicit_cast'): TExpr {
    const collation = this.typeCollation(target);
    switch (path.kind) {
      case 'relabel':
        return { k: 'relabel', arg: expr, type: target, typmod: -1, collation: collation ? expr.collation || collation : 0, format };
      case 'io':
        return { k: 'iocoerce', arg: expr, type: target, typmod: -1, collation, format };
      case 'func': {
        const proc = this.catalog.getProc(path.funcOid);
        const args: TExpr[] = [expr];
        if (proc && proc.argtypes.length >= 2) {
          args.push(this.makeInt4Const(-1));
        }
        if (proc && proc.argtypes.length >= 3) {
          args.push(this.makeBoolConst(format === 'explicit_cast'));
        }
        const node: FuncNode = {
          k: 'func',
          funcOid: path.funcOid,
          funcName: path.funcName,
          funcSrc: path.funcSrc,
          args,
          type: target,
          typmod: -1,
          collation,
          inputCollation: expr.collation,
          retset: false,
          format,
          variadic: false,
          strict: proc ? proc.strict : true,
        };
        if (proc && proc.rettype !== target) {
          return { k: 'relabel', arg: node, type: target, typmod: -1, collation, format };
        }
        return node;
      }
      case 'array': {
        const srcElem = this.types.elemType(inputType);
        const tgtElem = this.types.elemType(target);
        const slot = this.allocExecSlot();
        const placeholder: ExecParamNode = { k: 'execparam', slot, type: srcElem, typmod: -1, collation: this.typeCollation(srcElem) };
        let elemExpr = this.buildCoercion(placeholder, path.elemPath, srcElem, tgtElem, -1, ccontext, format);
        elemExpr = this.coerceTypeTypmod(elemExpr, tgtElem, targetTypmod, format === 'explicit_cast', format);
        const node: ArrayCoerceNode = { k: 'arraycoerce', arg: expr, elemExpr, elemSlot: slot, type: target, typmod: targetTypmod, collation, format };
        return node;
      }
      default:
        throw new PgError(SqlState.CANNOT_COERCE, `cannot cast type ${this.types.formatType(inputType, -1, false)} to ${this.types.formatType(target, -1, false)}`);
    }
  }

  private coerceRecordToComplex(expr: TExpr & { k: 'row' }, targetType: number, ccontext: CoercionContext, format: 'explicit_cast' | 'implicit_cast'): TExpr {
    const t = this.catalog.getType(targetType)!;
    const rel = this.catalog.getRelation(t.relid);
    if (!rel) {
      return expr;
    }
    const cols = rel.columns.filter((c) => !c.isDropped);
    if (cols.length !== expr.args.length) {
      throw new PgError(SqlState.CANNOT_COERCE, `cannot cast type record to ${this.types.formatType(targetType, -1, false)}`, {
        detail: expr.args.length > cols.length ? 'Input has too many columns.' : 'Input has too few columns.',
      });
    }
    const args = expr.args.map((a, i) => {
      const c = this.coerceToTargetType(a, cols[i].typeOid, cols[i].typmod, ccontext, format);
      if (!c) {
        throw new PgError(SqlState.CANNOT_COERCE, `cannot cast type record to ${this.types.formatType(targetType, -1, false)}`, {
          detail: `Cannot cast type ${this.types.formatType(a.type, -1, false)} to ${this.types.formatType(cols[i].typeOid, -1, false)} in column ${i + 1}.`,
        });
      }
      return c;
    });
    return { ...expr, args, type: targetType, fieldNames: cols.map((c) => c.name) };
  }

  private coerceUnknownConst(expr: ConstNode, targetType: number, targetTypmod: number, format: 'explicit_cast' | 'implicit_cast'): TExpr {
    const baseType = this.types.baseType(targetType);
    const collation = this.typeCollation(baseType);
    if (expr.isNull) {
      if (baseType !== targetType) {
        // a NULL coerced to a domain is still checked against its NOT NULL constraint (CoerceToDomain)
        const nullConst: TExpr = { k: 'const', type: baseType, typmod: -1, collation, value: null, isNull: true };
        return { k: 'domaincoerce', arg: nullConst, type: targetType, typmod: targetTypmod, collation, domainOid: targetType, format };
      }
      return { k: 'const', type: targetType, typmod: targetTypmod, collation, value: null, isNull: true };
    }
    const t = this.catalog.getType(baseType);
    if (t && t.typtype === 'p' && baseType !== TypeOid.record) {
      return expr;
    }
    // Input function receives the typmod (so e.g. 'abc'::varchar(2) is checked by the caller's typmod coercion)
    // PostgreSQL passes typmod -1 to the input function (length checks are applied by the caller),
    // except for interval whose input routine needs it.
    const inputTypmod = baseType === TypeOid.interval ? targetTypmod : -1;
    // errors of the input function point at the literal (coerce_type's parser error position callback)
    const value = atPosition(expr.location, () => inputValue(baseType, expr.value as string, inputTypmod, this.env.io));
    const node: TExpr = { k: 'const', type: baseType, typmod: inputTypmod, collation, value, isNull: false };
    if (baseType !== targetType) {
      return this.coerceToDomain(node, baseType, targetType, targetTypmod, format);
    }
    return node;
  }

  /** coerce_type_typmod: apply length coercion (varchar(n), numeric(p,s), timestamp(p), ...). */
  coerceTypeTypmod(expr: TExpr, targetType: number, targetTypmod: number, isExplicit: boolean, format: 'explicit_cast' | 'implicit_cast'): TExpr {
    if (targetTypmod < 0 || targetTypmod === expr.typmod) {
      return expr;
    }
    const base = this.types.baseType(targetType);
    if (this.types.isArray(base)) {
      // length coercion on arrays applies per element
      const elem = this.types.elemType(base);
      const slot = this.allocExecSlot();
      const placeholder: ExecParamNode = { k: 'execparam', slot, type: elem, typmod: -1, collation: this.typeCollation(elem) };
      const elemExpr = this.coerceTypeTypmod(placeholder, elem, targetTypmod, isExplicit, format);
      if (elemExpr === placeholder) {
        return expr;
      }
      return { k: 'arraycoerce', arg: expr, elemExpr, elemSlot: slot, type: targetType, typmod: targetTypmod, collation: expr.collation, format };
    }
    // constant folding of length coercion for simple literals
    if (expr.k === 'const' && !expr.isNull) {
      let folded: unknown;
      try {
        folded = this.applyTypmodToValue(base, expr.value, targetTypmod, isExplicit);
      } catch (e) {
        // PostgreSQL applies the length coercion function when the plan runs: no query position
        if (e instanceof PgError) {
          e.noPosition = true;
        }
        throw e;
      }
      if (folded !== undefined) {
        return { ...expr, value: folded, typmod: targetTypmod };
      }
    }
    if (expr.k === 'const' && expr.isNull) {
      return { ...expr, typmod: targetTypmod };
    }
    const cast = this.catalog.builtin.casts.get(base + ':' + base);
    if (!cast || !cast.funcOid) {
      return expr;
    }
    const node: FuncNode = {
      k: 'func',
      funcOid: cast.funcOid,
      funcName: cast.funcName,
      funcSrc: cast.funcSrc,
      args: [expr, this.makeInt4Const(targetTypmod), this.makeBoolConst(isExplicit)],
      type: targetType,
      typmod: targetTypmod,
      collation: expr.collation,
      inputCollation: expr.collation,
      retset: false,
      format,
      variadic: false,
      strict: true,
    };
    const proc = this.catalog.getProc(cast.funcOid);
    if (proc && proc.argtypes.length === 2) {
      node.args.pop();
    }
    return node;
  }

  applyTypmodToValue(base: number, value: unknown, typmod: number, isExplicit: boolean): unknown {
    switch (base) {
      case TypeOid.varchar:
      case TypeOid.bpchar:
        return applyCharTypmod(value as string, base, typmod, isExplicit);
      case TypeOid.numeric:
        return (value as PgNumeric).applyTypmod(typmod);
      case TypeOid.timestamp:
      case TypeOid.timestamptz:
        return roundTimestamp(value as number, typmod);
      case TypeOid.time:
        return roundTime(value as number, typmod);
      default:
        return undefined;
    }
  }

  /** coerce_to_boolean */
  coerceToBoolean(pstate: ParseState, expr: TExpr, constructName: string): TExpr {
    if (expr.type !== TypeOid.bool) {
      const c = this.coerceToTargetType(expr, TypeOid.bool, -1, 'assignment', 'implicit_cast');
      if (!c) {
        throw positioned(new PgError(SqlState.DATATYPE_MISMATCH, `argument of ${constructName} must be type boolean, not type ${this.types.formatType(expr.type, -1, false)}`), exprLocation(expr));
      }
      expr = c;
    }
    if (expr.k === 'func' && expr.retset) {
      throw positioned(new PgError(SqlState.DATATYPE_MISMATCH, `argument of ${constructName} must not return a set`), exprLocation(expr));
    }
    void pstate;
    return expr;
  }

  /** coerce_to_specific_type (used for LIMIT etc.) */
  coerceToSpecificType(expr: TExpr, targetType: number, constructName: string): TExpr {
    if (expr.type === targetType) {
      return expr;
    }
    const c = this.coerceToTargetType(expr, targetType, -1, 'assignment', 'implicit_cast');
    if (!c) {
      throw positioned(new PgError(SqlState.DATATYPE_MISMATCH, `argument of ${constructName} must be type ${this.types.formatType(targetType, -1, false)}, not type ${this.types.formatType(expr.type, -1, false)}`), exprLocation(expr));
    }
    return c;
  }

  /** coerce_to_common_type */
  coerceToCommonType(expr: TExpr, targetType: number, context: string): TExpr {
    if (expr.type === targetType) {
      return expr;
    }
    const c = this.coerceToTargetType(expr, targetType, -1, 'implicit', 'implicit_cast');
    if (!c) {
      throw positioned(new PgError(SqlState.CANNOT_COERCE, `${context} could not convert type ${this.types.formatType(expr.type, -1, false)} to ${this.types.formatType(targetType, -1, false)}`), exprLocation(expr));
    }
    return c;
  }

  /** select_common_typmod */
  selectCommonTypmod(exprs: TExpr[], commonType: number): number {
    let typmod = -1;
    let first = true;
    for (const e of exprs) {
      if (e.type === TypeOid.unknown) {
        continue;
      }
      if (e.type !== commonType) {
        return -1;
      }
      if (first) {
        typmod = e.typmod;
        first = false;
      } else if (typmod !== e.typmod) {
        return -1;
      }
    }
    return typmod;
  }

  /** assignment coercion with PostgreSQL's error message for target columns */
  coerceForAssignment(expr: TExpr, targetType: number, targetTypmod: number, colName: string): TExpr {
    const c = this.coerceToTargetType(expr, targetType, targetTypmod, 'assignment', 'implicit_cast');
    if (!c) {
      throw new PgError(SqlState.DATATYPE_MISMATCH, `column "${colName}" is of type ${this.types.formatType(targetType, -1, false)} but expression is of type ${this.types.formatType(expr.type, -1, false)}`, {
        hint: 'You will need to rewrite or cast the expression.',
      });
    }
    return c;
  }

  exprKindName(kind: ExprKind): string {
    return EXPR_KIND_NAMES[kind];
  }

  /** resolve unknown-typed expression to text (for SELECT output columns) */
  resolveUnknownToText(expr: TExpr): TExpr {
    if (expr.type !== TypeOid.unknown) {
      return expr;
    }
    return this.coerceType(expr, TypeOid.unknown, TypeOid.text, -1, 'implicit', 'implicit_cast');
  }

  typeInfoOf(e: TExpr): TypeInfo {
    return { type: e.type, typmod: e.typmod, collation: e.collation };
  }

  isPgCatalog(nsp: number): boolean {
    return nsp === NS_PG_CATALOG;
  }
}
