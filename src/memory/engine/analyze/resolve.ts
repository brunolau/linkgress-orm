import { NS_PG_CATALOG, OperatorDef, ProcDef, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Analyzer } from './analyzer';

/**
 * Function and operator overload resolution (parse_func.c / parse_oper.c).
 */

export interface FuncCandidate {
  proc: ProcDef;
  /** argument types after variadic expansion */
  args: number[];
  nvargs: number;
  ndargs: number;
  /** named notation: position of each supplied argument in the function's parameter list */
  argnumbers?: number[];
}

export interface OpCandidate {
  op: OperatorDef;
  args: number[];
}

type Candidate = { args: number[] };

function inputArgNames(proc: ProcDef): string[] {
  if (!proc.argnames) {
    return [];
  }
  if (!proc.argmodes) {
    return proc.argnames;
  }
  const out: string[] = [];
  for (let i = 0; i < proc.argmodes.length; i++) {
    const m = proc.argmodes[i];
    if (m === 'i' || m === 'b' || m === 'v') {
      out.push(proc.argnames[i] ?? '');
    }
  }
  return out;
}

export function funcnameGetCandidates(
  an: Analyzer,
  names: string[],
  nargs: number,
  argNames: (string | undefined)[] | undefined,
  expandVariadic: boolean,
  expandDefaults: boolean
): FuncCandidate[] {
  const funcName = names[names.length - 1];
  let namespaces: number[];
  if (names.length > 1) {
    // LookupExplicitNamespace: pg_temp is the session's temp schema when it exists
    const nspName = names[names.length - 2];
    const ns = nspName === 'pg_temp' && an.env.tempNamespace(false) ? { oid: an.env.tempNamespace(false) } : an.catalog.findNamespace(nspName);
    if (!ns) {
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${names[names.length - 2]}" does not exist`);
    }
    namespaces = [ns.oid];
  } else {
    namespaces = an.env.functionSearchPath();
  }
  const namedCount = argNames ? argNames.filter((n) => n !== undefined).length : 0;
  const result: FuncCandidate[] = [];
  const procs = an.catalog.findProcsByName(funcName);
  for (const proc of procs) {
    if (!namespaces.includes(proc.nspOid)) {
      continue;
    }
    const pronargs = proc.argtypes.length;
    let variadic = false;
    let vaElemType = 0;
    if (proc.variadic && expandVariadic && namedCount === 0) {
      variadic = true;
      vaElemType = proc.variadic;
    }
    let argnumbers: number[] | undefined;
    let useDefaults = false;
    if (namedCount > 0) {
      // named or mixed notation
      const pnames = inputArgNames(proc);
      if (nargs > pronargs) {
        continue;
      }
      const positional = nargs - namedCount;
      argnumbers = [];
      const used = new Array(pronargs).fill(false);
      let ok = true;
      for (let i = 0; i < positional; i++) {
        argnumbers.push(i);
        used[i] = true;
      }
      for (let i = positional; i < nargs; i++) {
        const idx = pnames.indexOf(argNames![i]!);
        if (idx < 0 || used[idx]) {
          ok = false;
          break;
        }
        used[idx] = true;
        argnumbers.push(idx);
      }
      if (!ok) {
        continue;
      }
      // remaining params must have defaults
      const firstDefault = pronargs - proc.nargdefaults;
      for (let i = 0; i < pronargs; i++) {
        if (!used[i] && i < firstDefault) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        continue;
      }
      useDefaults = nargs < pronargs;
      const args = argnumbers.map((n) => proc.argtypes[n]);
      result.push({ proc, args, nvargs: 0, ndargs: useDefaults ? pronargs - nargs : 0, argnumbers });
      continue;
    }
    if (pronargs > nargs && expandDefaults) {
      if (nargs + proc.nargdefaults < pronargs) {
        continue;
      }
      useDefaults = true;
    }
    if (variadic) {
      if (nargs < pronargs && !useDefaults) {
        continue;
      }
    } else if (pronargs !== nargs && !useDefaults) {
      continue;
    }
    const effective = Math.max(pronargs, nargs);
    const args = new Array(effective);
    let nvargs = 0;
    if (variadic && !useDefaults) {
      nvargs = effective - pronargs + 1;
      for (let i = 0; i < pronargs - 1; i++) {
        args[i] = proc.argtypes[i];
      }
      for (let i = pronargs - 1; i < effective; i++) {
        args[i] = vaElemType;
      }
    } else {
      for (let i = 0; i < effective; i++) {
        args[i] = proc.argtypes[i];
      }
      if (useDefaults) {
        args.length = nargs;
      }
    }
    const cand: FuncCandidate = { proc, args, nvargs, ndargs: useDefaults ? pronargs - nargs : 0 };
    // a candidate with identical signature from an earlier namespace in the path wins
    const dup = result.findIndex((r) => r.args.length === args.length && r.args.every((t, i) => t === args[i]));
    if (dup >= 0) {
      const existing = result[dup];
      const ePos = namespaces.indexOf(existing.proc.nspOid);
      const nPos = namespaces.indexOf(proc.nspOid);
      if (nPos < ePos) {
        result[dup] = cand;
      } else if (nPos === ePos) {
        // prefer non-variadic / fewer defaults
        if ((existing.nvargs > 0 && cand.nvargs === 0) || existing.ndargs > cand.ndargs) {
          result[dup] = cand;
        }
      }
      continue;
    }
    result.push(cand);
  }
  return result;
}

/** func_match_argtypes: candidates whose args accept the inputs via implicit coercion. */
export function funcMatchArgtypes<T extends Candidate>(an: Analyzer, inputs: number[], candidates: T[]): T[] {
  return candidates.filter((c) => an.types.canCoerceTypes(inputs, c.args, 'implicit'));
}

/** func_select_candidate */
export function funcSelectCandidate<T extends Candidate>(an: Analyzer, inputTypeids: number[], candidates: T[]): T | null {
  const nargs = inputTypeids.length;
  const t = an.types;
  const inputBase = inputTypeids.map((x) => (x === TypeOid.unknown ? x : t.baseType(x)));
  let nunknowns = 0;
  for (const x of inputBase) {
    if (x === TypeOid.unknown) {
      nunknowns++;
    }
  }

  // most exact matches
  let best = -1;
  let current: T[] = [];
  for (const c of candidates) {
    let nmatch = 0;
    for (let i = 0; i < nargs; i++) {
      if (inputBase[i] !== TypeOid.unknown && c.args[i] === inputBase[i]) {
        nmatch++;
      }
    }
    if (nmatch > best || current.length === 0) {
      best = nmatch;
      current = [c];
    } else if (nmatch === best) {
      current.push(c);
    }
  }
  if (current.length === 1) {
    return current[0];
  }

  // exact or preferred-type matches (same category as input)
  const slotCategory = inputBase.map((x) => t.category(x));
  best = -1;
  let next: T[] = [];
  for (const c of current) {
    let nmatch = 0;
    for (let i = 0; i < nargs; i++) {
      if (inputBase[i] !== TypeOid.unknown) {
        if (c.args[i] === inputBase[i] || (t.isPreferred(c.args[i]) && t.category(c.args[i]) === slotCategory[i])) {
          nmatch++;
        }
      }
    }
    if (nmatch > best || next.length === 0) {
      best = nmatch;
      next = [c];
    } else if (nmatch === best) {
      next.push(c);
    }
  }
  current = next;
  if (current.length === 1) {
    return current[0];
  }

  // resolve unknown inputs by category
  let resolvedUnknowns = false;
  const catSlot: string[] = new Array(nargs).fill('');
  const hasPreferred: boolean[] = new Array(nargs).fill(false);
  if (nunknowns > 0) {
    resolvedUnknowns = true;
    for (let i = 0; i < nargs; i++) {
      if (inputBase[i] !== TypeOid.unknown) {
        continue;
      }
      let conflict = false;
      for (const c of current) {
        const cat = t.category(c.args[i]);
        const pref = t.isPreferred(c.args[i]);
        if (catSlot[i] === '') {
          catSlot[i] = cat;
          hasPreferred[i] = pref;
        } else if (cat === catSlot[i]) {
          hasPreferred[i] = hasPreferred[i] || pref;
        } else if (cat === 'S') {
          catSlot[i] = cat;
          hasPreferred[i] = pref;
        } else {
          conflict = true;
        }
      }
      if (conflict && catSlot[i] !== 'S') {
        resolvedUnknowns = false;
        break;
      }
    }
    if (resolvedUnknowns) {
      next = current.filter((c) => {
        for (let i = 0; i < nargs; i++) {
          if (inputBase[i] !== TypeOid.unknown) {
            continue;
          }
          if (t.category(c.args[i]) !== catSlot[i]) {
            return false;
          }
          if (hasPreferred[i] && !t.isPreferred(c.args[i])) {
            return false;
          }
        }
        return true;
      });
      if (next.length === 1) {
        return next[0];
      }
      if (next.length > 0) {
        current = next;
      }
    }
  }

  // last gasp: unknowns assumed to be the (single) known type
  if (nunknowns < nargs) {
    let known = TypeOid.unknown as number;
    for (let i = 0; i < nargs; i++) {
      if (inputBase[i] === TypeOid.unknown) {
        continue;
      }
      if (known === TypeOid.unknown) {
        known = inputBase[i];
      } else if (known !== inputBase[i]) {
        known = TypeOid.unknown;
        break;
      }
    }
    if (known !== TypeOid.unknown) {
      const assumed = inputBase.map(() => known);
      const matches = candidates.filter((c) => t.canCoerceTypes(assumed, c.args, 'implicit'));
      if (matches.length === 1) {
        return matches[0];
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function operatorCandidates(an: Analyzer, names: string[], kind: 'b' | 'l'): OperatorDef[] {
  const opName = names[names.length - 1];
  let namespaces: number[] | null = null;
  if (names.length > 1) {
    const ns = an.catalog.findNamespace(names[names.length - 2]);
    if (!ns) {
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${names[names.length - 2]}" does not exist`);
    }
    namespaces = [ns.oid];
  } else {
    namespaces = an.env.functionSearchPath();
  }
  const out: OperatorDef[] = [];
  for (const op of an.catalog.builtin.operatorsByName.get(opName) ?? []) {
    if (op.kind === kind && namespaces.includes(op.nspOid)) {
      out.push(op);
    }
  }
  for (const op of an.catalog.userOperatorsByName(opName)) {
    if (op.kind === kind && namespaces.includes(op.nspOid)) {
      out.push(op);
    }
  }
  return out;
}

export function operatorDisplayName(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join('.')}.${names[names.length - 1]}` : names[0];
}

/** oper(): resolve a binary operator. */
export function resolveBinaryOperator(an: Analyzer, names: string[], ltype: number, rtype: number, noError = false): OperatorDef | null {
  const cands = operatorCandidates(an, names, 'b');
  // binary_oper_exact
  let l = ltype;
  let r = rtype;
  let wasUnknown = false;
  if (l === TypeOid.unknown) {
    l = r;
    wasUnknown = true;
  } else if (r === TypeOid.unknown) {
    r = l;
    wasUnknown = true;
  }
  const exact = cands.find((o) => o.left === l && o.right === r);
  if (exact) {
    return exact;
  }
  if (wasUnknown) {
    const base = an.types.baseType(l);
    if (base !== l) {
      const e2 = cands.find((o) => o.left === base && o.right === base);
      if (e2) {
        return e2;
      }
    }
  }
  // oper_select_candidate
  const inputs = [ltype, rtype];
  const wrapped: OpCandidate[] = cands.map((op) => ({ op, args: [op.left, op.right] }));
  const matching = funcMatchArgtypes(an, inputs, wrapped);
  let chosen: OpCandidate | null = null;
  if (matching.length === 1) {
    chosen = matching[0];
  } else if (matching.length > 1) {
    chosen = funcSelectCandidate(an, inputs, matching);
    if (!chosen) {
      if (noError) {
        return null;
      }
      throw new PgError(SqlState.AMBIGUOUS_FUNCTION, `operator is not unique: ${an.types.formatType(ltype, -1, false)} ${operatorDisplayName(names)} ${an.types.formatType(rtype, -1, false)}`, {
        hint: 'Could not choose a best candidate operator. You might need to add explicit type casts.',
      });
    }
  }
  if (!chosen) {
    if (noError) {
      return null;
    }
    throw new PgError(SqlState.UNDEFINED_FUNCTION, `operator does not exist: ${an.types.formatType(ltype, -1, false)} ${operatorDisplayName(names)} ${an.types.formatType(rtype, -1, false)}`, {
      hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.',
    });
  }
  return chosen.op;
}

/** left_oper(): resolve a prefix operator. */
export function resolvePrefixOperator(an: Analyzer, names: string[], argType: number): OperatorDef {
  const cands = operatorCandidates(an, names, 'l');
  const exact = cands.find((o) => o.right === argType);
  if (exact) {
    return exact;
  }
  const wrapped: OpCandidate[] = cands.map((op) => ({ op, args: [op.right] }));
  const matching = funcMatchArgtypes(an, [argType], wrapped);
  let chosen: OpCandidate | null = null;
  if (matching.length === 1) {
    chosen = matching[0];
  } else if (matching.length > 1) {
    chosen = funcSelectCandidate(an, [argType], matching);
    if (!chosen) {
      throw new PgError(SqlState.AMBIGUOUS_FUNCTION, `operator is not unique: ${operatorDisplayName(names)} ${an.types.formatType(argType, -1, false)}`, {
        hint: 'Could not choose a best candidate operator. You might need to add explicit type casts.',
      });
    }
  }
  if (!chosen) {
    throw new PgError(SqlState.UNDEFINED_FUNCTION, `operator does not exist: ${operatorDisplayName(names)} ${an.types.formatType(argType, -1, false)}`, {
      hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.',
    });
  }
  return chosen.op;
}

/** Resolve a function call; returns the chosen candidate or throws PostgreSQL's errors. */
export function resolveFunction(
  an: Analyzer,
  names: string[],
  argTypes: number[],
  argNames: (string | undefined)[] | undefined,
  funcVariadic: boolean,
  displayArgs: () => string,
  allowCoercion = true
): FuncCandidate | { coercionTo: number } {
  const raw = funcnameGetCandidates(an, names, argTypes.length, argNames, !funcVariadic, true);
  const exact = raw.find((c) => c.args.length === argTypes.length && c.args.every((t, i) => t === argTypes[i]));
  if (exact) {
    return exact;
  }
  // type coercion request: typename(arg)
  if (allowCoercion && argTypes.length === 1 && (!argNames || argNames.every((n) => n === undefined))) {
    const target = funcNameAsType(an, names);
    if (target) {
      return { coercionTo: target };
    }
  }
  if (raw.length > 0) {
    const matching = funcMatchArgtypes(an, argTypes, raw);
    if (matching.length === 1) {
      return matching[0];
    }
    if (matching.length > 1) {
      const best = funcSelectCandidate(an, argTypes, matching);
      if (best) {
        return best;
      }
      throw new PgError(SqlState.AMBIGUOUS_FUNCTION, `function ${funcDisplayName(names)}(${displayArgs()}) is not unique`, {
        hint: 'Could not choose a best candidate function. You might need to add explicit type casts.',
      });
    }
  }
  throw new PgError(SqlState.UNDEFINED_FUNCTION, `function ${funcDisplayName(names)}(${displayArgs()}) does not exist`, {
    hint: 'No function matches the given name and argument types. You might need to add explicit type casts.',
  });
}

export function funcDisplayName(names: string[]): string {
  return names.join('.');
}

/** FuncNameAsType: is the function name the name of a (non-pseudo) type? */
function funcNameAsType(an: Analyzer, names: string[]): number {
  // resolved without raising "type does not exist" (the common outcome) — a composite row type never qualifies
  const cat = an.catalog;
  let t: { oid: number; typtype: string } | undefined;
  if (names.length === 1) {
    const path = an.env.relationSearchPath();
    for (const ns of [NS_PG_CATALOG, ...path.filter((n) => n !== NS_PG_CATALOG)]) {
      t = cat.findTypeInNamespace(ns, names[0]);
      if (t) {
        break;
      }
    }
  } else {
    const ns = cat.findNamespace(names[names.length - 2]);
    t = ns ? cat.findTypeInNamespace(ns.oid, names[names.length - 1]) : undefined;
  }
  if (!t || t.typtype === 'p' || t.typtype === 'c') {
    return 0;
  }
  return t.oid;
}

export function isPgCatalogProc(p: ProcDef): boolean {
  return p.nspOid === NS_PG_CATALOG;
}
