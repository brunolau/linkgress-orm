import { PgError } from '../errors';
import type { TExpr } from './nodes';

/**
 * Query-text positions of analysis errors (parser_errposition / exprLocation).
 *
 * Raw parse nodes carry `loc` (0-based character offset into the query string). Analyzed expressions
 * remember the raw node they came from, so an error about an analyzed expression can point at it the
 * way PostgreSQL's exprLocation() does: the leftmost token of the expression.
 */

const rawOf = new WeakMap<object, object>();

/** Remember the raw node an analyzed expression was built from (first registration wins). */
export function noteExprSource(e: TExpr, raw: object | undefined): void {
  if (raw && typeof e === 'object' && e !== null && !rawOf.has(e)) {
    rawOf.set(e, raw);
  }
}

/** exprLocation(): leftmost location of the expression's source text, or undefined. */
export function exprLocation(e: TExpr | null | undefined): number | undefined {
  if (!e) {
    return undefined;
  }
  const raw = rawOf.get(e);
  return raw ? rawLocation(raw) : undefined;
}

/** Leftmost `loc` within a raw parse subtree (not descending into nested statements). */
export function rawLocation(node: unknown): number | undefined {
  let best: number | undefined;
  const visit = (x: unknown, depth: number): void => {
    if (x === null || typeof x !== 'object' || depth > 64) {
      return;
    }
    if (Array.isArray(x)) {
      for (const el of x) {
        visit(el, depth + 1);
      }
      return;
    }
    const o = x as Record<string, unknown>;
    if (typeof o.loc === 'number' && o.loc >= 0 && (best === undefined || o.loc < best)) {
      best = o.loc;
    }
    // a subquery's own tokens come after its opening parenthesis, which the SubLink location covers
    if (depth > 0 && typeof o.kind === 'string' && o.kind.endsWith('Stmt')) {
      return;
    }
    for (const key in o) {
      if (key !== 'loc') {
        const v = o[key];
        if (v !== null && typeof v === 'object') {
          visit(v, depth + 1);
        }
      }
    }
  };
  visit(node, 0);
  return best;
}

/** Attach a position to an error without one raised by `fn` (parser_errposition for that location). */
export function atPosition<T>(loc: number | undefined, fn: () => T): T {
  if (loc === undefined || loc < 0) {
    return fn();
  }
  try {
    return fn();
  } catch (e) {
    if (e instanceof PgError && e.position === undefined && !e.noPosition) {
      e.position = loc + 1;
    }
    throw e;
  }
}

/** Set the position of an error being constructed. */
export function positioned(err: PgError, loc: number | undefined): PgError {
  if (loc !== undefined && loc >= 0 && err.position === undefined && !err.noPosition) {
    err.position = loc + 1;
  }
  return err;
}
