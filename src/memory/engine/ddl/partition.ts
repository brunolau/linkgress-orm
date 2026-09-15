import * as A from '../ast';
import { transformExpr } from '../analyze/expr';
import { emptyQuery } from '../analyze/nodes';
import { ParseState } from '../analyze/parse-state';
import { Relation } from '../catalog/catalog';
import { Executor } from '../exec/executor';
import { EvalCtx, StatementState } from '../exec/runtime';
import type { Session } from '../session';
import { SessionHost } from '../session';

type BoundValue = unknown | 'MINVALUE' | 'MAXVALUE';

function keyTypes(parent: Relation): number[] {
  return (parent.partitionKey?.keys ?? []).map((k) => (k.attnum > 0 ? parent.columns[k.attnum - 1].typeOid : 25));
}

function evalBound(session: Session, st: StatementState, e: A.Expr, type: number): BoundValue {
  if (e.kind === 'ColumnRef' && e.fields.length === 1) {
    if (e.fields[0] === 'minvalue') {
      return 'MINVALUE';
    }
    if (e.fields[0] === 'maxvalue') {
      return 'MAXVALUE';
    }
  }
  const an = session.makeAnalyzer();
  const pstate = new ParseState(null, emptyQuery());
  let expr = transformExpr(an, pstate, e, 'partition_bound');
  expr = an.coerceForAssignment(expr, type, -1, 'partition key');
  const host = new SessionHost(session, st);
  const executor = new Executor(st, host);
  host.executor = executor;
  const plan = executor.planFor(pstate.query, null);
  return plan.ev(expr)(new EvalCtx([], null, st));
}

export function partitionAccepts(session: Session, parent: Relation, part: Relation, keyValues: unknown[], st: StatementState): boolean {
  const bound = part.partitionBound;
  if (!bound) {
    return false;
  }
  const types = keyTypes(parent);
  const typeOps = session.typeOps;
  const cmpAt = (i: number, a: unknown, b: BoundValue): number => {
    if (b === 'MINVALUE') {
      return 1;
    }
    if (b === 'MAXVALUE') {
      return -1;
    }
    if (a === null) {
      return 1;
    }
    return typeOps.comparator(types[i], 100)(a, b);
  };
  switch (bound.kind) {
    case 'DEFAULT':
      return false;
    case 'LIST': {
      const values = bound.values.map((v) => evalBound(session, st, v, types[0]));
      const k = keyValues[0];
      return values.some((v) => (v === null ? k === null : k !== null && typeOps.comparator(types[0], 100)(k, v) === 0));
    }
    case 'RANGE': {
      if (keyValues.some((k) => k === null)) {
        return false;
      }
      const from = bound.from.map((v, i) => evalBound(session, st, v, types[i]));
      const to = bound.to.map((v, i) => evalBound(session, st, v, types[i]));
      // lexicographic comparisons
      const cmpRow = (vals: BoundValue[]): number => {
        for (let i = 0; i < keyValues.length; i++) {
          const r = cmpAt(i, keyValues[i], vals[i]);
          if (r !== 0) {
            return r;
          }
        }
        return 0;
      };
      return cmpRow(from) >= 0 && cmpRow(to) < 0;
    }
    case 'HASH': {
      let h = 0;
      for (let i = 0; i < keyValues.length; i++) {
        const s = String(typeOps.hashKey(types[i], keyValues[i]));
        for (let j = 0; j < s.length; j++) {
          h = (h * 31 + s.charCodeAt(j)) | 0;
        }
      }
      return Math.abs(h) % bound.modulus === bound.remainder;
    }
  }
}
