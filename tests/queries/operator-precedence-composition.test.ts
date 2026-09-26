import { describe, test, expect, beforeAll } from 'bun:test';
import {
  add, addInterval, agg, and, arrayContains, asBoolean, atTimeZone, between, caseOf, caseWhen, castAsInt, castAsJsonb,
  castAsString, coalesce, concatStrict, DbSchemaManager, eq, eqAny, eqAnySubquery, exists, flagHas, flagHasAll,
  flagHasAny, flagHasNone, flagSet, flagUnset, fromSet, gt, gte, ilike, inArray, inArrayOpt, isDistinctFrom, isNotDistinctFrom, isNotNull,
  isNull, jsonBuildArray, jsonBuildObject, jsonbArraySome, jsonbBuildObject, jsonbContainedBy, jsonbContains,
  jsonbHasAllKeys, jsonbHasAnyKey, jsonbHasKey, jsonbMerge, jsonbPath, jsonbPathExists, jsonbPathText, jsonbRemoveKey,
  jsonbRemovePath, jsonbSelect, jsonbSelectText, jsonbSet, jsonbTypeOf, jsonbValueText, like, LinkgressConfig, literal,
  literalOf, lower, lt, lte, modulo, MutationBatch, ne, neAll, neAllSubquery, normalizedEq, normalizedLike,
  normalizedStartsWith, not, notExists, notInArray, notInArrayOpt, or, param, regexMatches, regexMatchesCaseInsensitive,
  regexNoMatch, regexNoMatchCaseInsensitive, sql, SqlFragment, startsWith, substring, unnest, unnestZip,
  jsonbArrayElements, jsonbEachText,
} from '../../src';
import * as Surface from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { getSharedDatabase, seedTestData, setupDatabase } from '../utils/test-database';

/**
 * OPERATOR PRECEDENCE OF COMPOSED EXPRESSION HELPERS
 *
 * A helper splices its operands into its own template as they render: `add(a, b)` is `(<a> + <b>)`,
 * `eq(a, b)` is `<a> = <b>`, `concatStrict(a, b)` is `(<a> || <b>)`. A helper whose own SQL is an
 * operator expression WITHOUT parentheses of its own (`<x>->>'k'`, `<a> || <b>`, `<c> = ANY(…)`,
 * `NOT EXISTS (…)`) therefore re-associates as soon as it is the operand of a tighter operator, or the
 * right operand of one of the same level: `jsonbRemoveKey(jsonbMerge(a, b), 'k')` rendered
 * `(COALESCE(a, '{}'::jsonb) || (b)::jsonb - 'k')`, which PostgreSQL reads as `a || (b - 'k')` — the key
 * survives, silently.
 *
 * The rule this file proves: EVERY helper renders ONE self-delimited expression — a column, `$n`, a
 * literal, a function call (optionally with FILTER / OVER), `CAST(… AS …)`, `CASE … END`, `(SELECT …)`,
 * `EXISTS (…)` or a parenthesized group — so no operator a caller composes it with can split it.
 * Conditions built by the comparison helpers (`eq`, `like`, `isNull`, `and` …) are no fragments: a
 * fragment they are interpolated into parenthesizes them, and they are never a comparison operand.
 *
 * 1. structural: every builder of the public surface renders self-delimited (the 1.0.9 additions by name);
 * 2–6. the EVALUATED matrix — every helper that used to render a bare operator form × every operator
 *    context it can reach with a meaningful type, each value checked against a JS computation of the
 *    SQL semantics (three-valued logic, NULL propagation, jsonb text format);
 * 7. the statement positions: WHERE, ORDER BY, GROUP BY, UPDATE SET, FILTER, a row guard.
 *
 * Data: `type_zoo` rows `prec-1` … `prec-4` (below) and the seeded users / posts (post views 100, 150,
 * 200: a correlated EXISTS over `views = vInteger` holds for prec-1 and prec-4 only).
 */

// ============================================================================
// JS model of the SQL semantics the expectations are computed with
// ============================================================================

type B3 = boolean | null;

const not3 = (a: B3): B3 => (a === null ? null : !a);
const and3 = (a: B3, b: B3): B3 => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a: B3, b: B3): B3 => (a === true || b === true ? true : a === null || b === null ? null : false);
/** A strict comparison: NULL when either side is NULL. */
const cmp3 = <T>(a: T | null, b: T | null, compare: (x: T, y: T) => boolean): B3 => (a === null || b === null ? null : compare(a, b));
/** Booleans order false < true. */
const ord = (b: boolean): number => (b ? 1 : 0);
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = (v: unknown): unknown => (Array.isArray(v)
  ? v.map(canonical)
  : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
    : v);
/** `a IS DISTINCT FROM b` */
const distinct = (a: unknown, b: unknown): boolean => (a === null && b === null ? false : a === null || b === null ? true : !deepEqual(a, b));
/** `x IN (list)` */
const in3 = (x: unknown, list: readonly unknown[]): B3 => (x === null
  ? null
  : list.some(v => v !== null && deepEqual(v, x)) ? true : list.includes(null) ? null : false);
/** `a || b || …` on text: NULL when any operand is NULL. */
const cat = (...parts: Array<string | null>): string | null => (parts.some(p => p === null) ? null : parts.join(''));
/** `x LIKE pattern` / ILIKE */
const likeMatch = (x: string, pattern: string, insensitive = false): boolean => new RegExp(
  `^${pattern.split('').map(c => (c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`,
  insensitive ? 'is' : 's'
).test(x);

/** jsonb's text form: keys by length, then bytes; `", "` and `": "` separators. */
function jsonbText(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(jsonbText).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map(k => `${JSON.stringify(k)}: ${jsonbText((value as Record<string, unknown>)[k])}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** jsonb `@>`: objects key by key (recursively), arrays element-wise, scalars by value. */
function contains(big: unknown, small: unknown): boolean {
  if (Array.isArray(small)) {
    return Array.isArray(big) && small.every(s => big.some(b => contains(b, s)));
  }
  if (small !== null && typeof small === 'object') {
    return big !== null && typeof big === 'object' && !Array.isArray(big)
      && Object.entries(small as object).every(([k, v]) => k in (big as object) && contains((big as Record<string, unknown>)[k], v));
  }
  return big === small;
}

/** `doc->'key'` (and `->>`, as the value's text): NULL for a NULL document or a missing key. */
const at = (doc: unknown, key: string): any => (doc === null || doc === undefined || typeof doc !== 'object'
  ? null
  : (doc as Record<string, unknown>)[key] ?? null);
const omit = (doc: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
  if (doc === null) {
    return null;
  }
  const { [key]: _removed, ...rest } = doc;
  return rest;
};
const asText = (v: unknown): string | null => (v === null ? null : typeof v === 'string' ? v : jsonbText(v));

// ============================================================================
// Seed
// ============================================================================

interface ZooSeed {
  label: string;
  vInteger: number | null;
  vSmallint: number;
  vBool: boolean | null;
  vText: string | null;
  vJsonb: Record<string, any> | null;
}

const PATCH = { k: 9, y: 3 };

/**
 * The rows every matrix case projects over, in label order. Top-level `k` in two documents: the patch
 * overrides it, and `jsonbRemoveKey(jsonbMerge(doc, patch), 'k')` must drop it — the bare form removed
 * it from the patch only and kept the document's.
 */
const ZOO: ZooSeed[] = [
  {
    label: 'prec-1', vInteger: 100, vSmallint: 5, vBool: true, vText: 'Ann',
    vJsonb: {
      f: 'Ann', l: 'Lee', p: 'A', re: '^A', lp: 'A%', key: 'f', n: '5', k: 1, b: { k: 1, s: 'p1', x: 2 },
      items: [{ f: 'Ann', l: 'Lee', re: '^A', n: '5' }, { f: 'Zed', l: 'Q', re: 'x', n: '1' }],
    },
  },
  {
    label: 'prec-2', vInteger: 7, vSmallint: 2, vBool: false, vText: 'bob',
    vJsonb: {
      f: 'Bob', l: 'Ray', p: 'x', re: '^b', lp: 'B%', key: 'l', n: '12', k: 2, b: { k: 3, s: 'p2', y: 4 },
      items: [{ f: 'Bob', l: 'Ray', re: '^b', n: '12' }],
    },
  },
  { label: 'prec-3', vInteger: null, vSmallint: 0, vBool: null, vText: null, vJsonb: null },
  {
    label: 'prec-4', vInteger: 150, vSmallint: 7, vBool: null, vText: 'Cyd',
    vJsonb: { f: 'Cyd', p: 'C', re: 'q', lp: 'C%', key: 'p', n: '-3', b: { x: 9 } },
  },
];

/** The seeded posts' views (seedTestData): 100, 150 (alice), 200 (bob). */
const POST_VIEWS = [100, 150, 200];

/** users after beforeAll: alice active, bob's flag NULL, charlie inactive; posts > 160 views: bob only. */
const USERS = [
  { username: 'alice', isActive: true as B3, hasPostOver160: false },
  { username: 'bob', isActive: null as B3, hasPostOver160: true },
  { username: 'charlie', isActive: false as B3, hasPostOver160: false },
];

// ============================================================================
// Self-delimited classifier
// ============================================================================

/** Index of the `)` closing each depth-0 `(`, quote-aware (`'…'`, `E'…'`, `"…"`). */
function depthZeroGroups(s: string): { closeOf: Map<number, number>; flat: string } {
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  let flat = '';

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const escapeString = (ch === 'E' || ch === 'e') && s[i + 1] === "'" && !/[\w$]/.test(s[i - 1] ?? '');

    if (ch === "'" || escapeString || ch === '"') {
      const quote = ch === '"' ? '"' : "'";
      let j = escapeString ? i + 2 : i + 1;
      while (j < s.length) {
        if (escapeString && s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === quote) {
          if (s[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (stack.length === 0) {
        flat += quote === '"' ? ' IDENT ' : ' LIT ';
      }
      i = j;
      continue;
    }

    if (ch === '(') {
      stack.push(i);
      if (stack.length === 1) {
        flat += ' GROUP ';
      }
    } else if (ch === ')') {
      const open = stack.pop();
      if (open === undefined) {
        throw new Error(`unbalanced ) in ${s}`);
      }
      if (stack.length === 0) {
        closeOf.set(open, i);
      }
    } else if (stack.length === 0) {
      flat += ch;
    }
  }

  if (stack.length > 0) {
    throw new Error(`unbalanced ( in ${s}`);
  }

  return { closeOf, flat: flat.replace(/\s+/g, ' ').trim() };
}

/**
 * Whether `text` is ONE primary expression — a c_expr in PostgreSQL's grammar — so no operator around
 * it can take one of its parts as its own operand.
 */
function isSelfDelimited(text: string): boolean {
  const s = text.trim();
  const { closeOf, flat } = depthZeroGroups(s);

  if (s.startsWith('(') && closeOf.get(0) === s.length - 1) {
    return true;
  }
  if (/^\$\d+$/.test(s) || /^\d+(\.\d+)?$/.test(s) || flat === 'LIT') {
    return true;
  }
  if (/^(TRUE|FALSE|NULL|CURRENT_TIMESTAMP|CURRENT_DATE|LOCALTIMESTAMP)$/i.test(s)) {
    return true;
  }
  // a column / an identifier chain: "t"."c", old."c", __elem
  if (/^(IDENT|[A-Za-z_][\w$]*)(\s*\.\s*(IDENT|[A-Za-z_][\w$]*))*$/.test(flat)) {
    return true;
  }
  // name(…), CAST(…), EXISTS (…), EXTRACT(…) — optionally followed by FILTER (…) / OVER (…)
  const call = /^((?:[A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*)\s*\(/.exec(s);
  if (call && !/^(NOT|AND|OR)$/i.test(call[1])) {
    let close = closeOf.get(s.indexOf('(', call[1].length));
    while (close !== undefined) {
      const rest = s.slice(close + 1);
      if (rest.trim() === '') {
        return true;
      }
      const suffix = /^\s*(FILTER|OVER)\s*\(/i.exec(rest);
      if (!suffix) {
        break;
      }
      close = closeOf.get(close + suffix[0].length);
    }
  }
  // CASE … END, the first CASE closed by the last END
  if (/^CASE\b/i.test(flat) && /\bEND$/i.test(flat)) {
    let depth = 0;
    const words = flat.split(' ');
    for (let i = 0; i < words.length; i++) {
      depth += /^CASE$/i.test(words[i]) ? 1 : /^END$/i.test(words[i]) ? -1 : 0;
      if (depth === 0 && i < words.length - 1) {
        return false;
      }
    }
    return depth === 0;
  }
  return false;
}

function build(fragment: { buildSql(context: SqlBuildContext): string }, context: Partial<SqlBuildContext> = {}): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [], ...context };
  const text = fragment.buildSql(ctx);
  return { sql: text.replace(/\s*\n\s*/g, ' '), params: ctx.params };
}

/** A column ref as a schema-aware mock row hands it out. */
const ref = (column: string, sqlType: string): any => ({
  __dbColumnName: column, __fieldName: column, __tableAlias: 't', __sqlType: sqlType,
});

// ============================================================================
// Fixture
// ============================================================================

let db: AppDatabase;

/** Project `expression(z)` over prec-1 … prec-4, in label order; NULL (undefined at the top level) as null. */
async function zooValues(expression: (z: any) => unknown): Promise<unknown[]> {
  const rows = await db.typeZoo
    .where(z => like(z.label, 'prec-%'))
    .orderBy(z => z.label)
    .select(z => ({ label: z.label, v: expression(z) as any }))
    .toList();

  expect(rows.map(r => r.label)).toEqual(ZOO.map(r => r.label));
  return rows.map(r => (r.v === undefined ? null : r.v));
}

/** Project `expression(u)` over alice, bob, charlie. */
async function userValues(expression: (u: any) => unknown): Promise<unknown[]> {
  const rows = await db.users
    .orderBy(u => u.id)
    .select(u => ({ username: u.username, v: expression(u) as any }))
    .toList();

  expect(rows.map(r => r.username)).toEqual(USERS.map(u => u.username));
  return rows.map(r => (r.v === undefined ? null : r.v));
}

const postsViewsSubquery = () => db.posts.select(p => p.views).asSubquery('array');
const usersActiveSubquery = () => db.users.select(u => u.isActive).asSubquery('array');

beforeAll(async () => {
  db = getSharedDatabase();
  await setupDatabase(db);
  await seedTestData(db);
  await db.users.where(u => eq(u.username, 'bob')).update({ isActive: null as any });
  // normalizedEq / normalizedLike / normalizedStartsWith read public.search_normalize()
  await new DbSchemaManager(db.getClient(), new Map(), { searchNormalizeRequired: true }).ensureSearchNormalizeSupport();
  await db.typeZoo.where(z => or(like(z.label, 'prec-%'), like(z.label, 'upd-%'), like(z.label, 'guard-%'))).delete();
  await db.typeZoo.insertBulk(ZOO.map(row => ({ ...row, vJsonb: row.vJsonb as any })));
});

// ============================================================================
// 1. Structural: every builder renders ONE self-delimited expression
// ============================================================================

describe('1. every expression builder renders a self-delimited expression', () => {
  const N = ref('qty', 'integer');
  const T = ref('name', 'text');
  const J = ref('doc', 'jsonb');
  const S = ref('state', 'smallint');
  const B = ref('flag', 'boolean');
  const A = ref('tags', 'text[]');
  const TS = ref('at', 'timestamptz');

  test('the classifier itself: primaries are self-delimited, operator forms are not', () => {
    for (const primary of ['"t"."c"', '$1', '42', "'it''s'", "E'a\\\\b'", 'TRUE', 'CURRENT_DATE', 'lower("t"."c")',
      'CAST($1 AS integer)', 'count(*) FILTER (WHERE "t"."c" > $1)', 'CASE WHEN a THEN 1 ELSE 2 END', '(a || b)',
      'EXISTS (SELECT 1)', 'EXTRACT(YEAR FROM "t"."c")', '(SELECT 1)']) {
      expect({ primary, self: isSelfDelimited(primary) }).toEqual({ primary, self: true });
    }
    for (const bare of ['a || b', '"t"."c"->>\'k\'', 'a = ANY($1)', 'NOT EXISTS (SELECT 1)', '(a & 1) != 0', 'NOT (a)',
      'a IS NULL', 'lower(a) = lower(b)', 'CASE WHEN a THEN 1 END || b', '(a) || (b)', 'count(*) + 1']) {
      expect({ bare, self: isSelfDelimited(bare) }).toEqual({ bare, self: false });
    }
  });

  // --------------------------------------------------------------------------
  // Every runtime export of src/index.ts, classified — a new export must be added here
  // --------------------------------------------------------------------------

  type Renderable = { buildSql(context: SqlBuildContext): string };
  type Entry =
    /** renders ONE self-delimited expression, whatever its operands */
    | { kind: 'fragment'; render: () => Renderable[] }
    /** a condition that is no fragment: every fragment interpolating it parenthesizes it */
    | { kind: 'condition'; render: () => Renderable[] }
    /** a set-returning function: refused as an operand, a call where it may render */
    | { kind: 'refused'; render: () => Renderable[] }
    /** not an expression helper */
    | { kind: 'other'; why: string };

  const ABOVE_THRESHOLD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const U = { ...ref('id', 'integer'), __tableAlias: 'users' };
  const frag = (...make: Array<() => Renderable>): Entry => ({ kind: 'fragment', render: () => make.map(m => m()) });
  const cond = (...make: Array<() => Renderable>): Entry => ({ kind: 'condition', render: () => make.map(m => m()) });
  const refused = (...make: Array<() => Renderable>): Entry => ({ kind: 'refused', render: () => make.map(m => m()) });
  const other = (why: string): Entry => ({ kind: 'other', why });
  // query-bound operands are built inside the tests (db exists by then)
  const sub = () => db.posts.where(p => gt(p.views, 1)).select(p => ({ id: p.id })).asSubquery();
  const ids = () => db.posts.select(p => p.userId).asSubquery('array') as any;
  const scalar = () => db.posts.select(p => p.views).limit(1).asSubquery('scalar') as any;

  const SURFACE: Record<string, Entry> = {
    // comparison / logical conditions (conditions.ts, subquery.ts)
    eq: cond(() => eq(N, 1), () => eq(N, null)),
    ne: cond(() => ne(N, 1), () => ne(N, null)),
    gt: cond(() => gt(N, 1)),
    gte: cond(() => gte(N, 1)),
    lt: cond(() => lt(N, 1)),
    lte: cond(() => lte(N, 1)),
    like: cond(() => like(T, 'a%')),
    ilike: cond(() => ilike(T, 'a%')),
    startsWith: cond(() => startsWith(T, 'a')),
    regexMatches: cond(() => regexMatches(T, '^a')),
    regexMatchesCaseInsensitive: cond(() => regexMatchesCaseInsensitive(T, '^a')),
    regexNoMatch: cond(() => regexNoMatch(T, '^a')),
    regexNoMatchCaseInsensitive: cond(() => regexNoMatchCaseInsensitive(T, '^a')),
    inArray: cond(() => inArray(N, [1, 2]), () => inArray(N, [])),
    notInArray: cond(() => notInArray(N, [1, 2]), () => notInArray(N, [])),
    isNull: cond(() => isNull(N)),
    isNotNull: cond(() => isNotNull(N)),
    between: cond(() => between(N, 1, 2)),
    and: cond(() => and(eq(N, 1), gt(N, 0)), () => and(eq(N, 1)), () => and()),
    or: cond(() => or(eq(N, 1), gt(N, 0)), () => or(eq(N, 1))),
    not: cond(() => not(eq(N, 1))),
    inSubquery: cond(() => Surface.inSubquery(U, ids())),
    notInSubquery: cond(() => Surface.notInSubquery(U, ids())),
    eqSubquery: cond(() => Surface.eqSubquery(U, scalar())),
    neSubquery: cond(() => Surface.neSubquery(U, scalar())),
    gtSubquery: cond(() => Surface.gtSubquery(U, scalar())),
    gteSubquery: cond(() => Surface.gteSubquery(U, scalar())),
    ltSubquery: cond(() => Surface.ltSubquery(U, scalar())),
    lteSubquery: cond(() => Surface.lteSubquery(U, scalar())),
    jsonbArraySome: cond(() => jsonbArraySome<any>(J, e => eq(e.k, 'x'))),
    Placeholder: cond(() => eq(N, sql.placeholder('p'))),
    // fragments of conditions.ts
    coalesce: frag(() => coalesce(N, 0)),
    jsonbMerge: frag(() => jsonbMerge(J, castAsJsonb(PATCH))),
    jsonbSelect: frag(() => jsonbSelect<any>(J, 'a')),
    jsonbSelectText: frag(() => jsonbSelectText<any>(J, 'a')),
    add: frag(() => add(N, 1, 2)),
    sub: frag(() => Surface.sub(N, 1)),
    mul: frag(() => Surface.mul(N, 2)),
    div: frag(() => Surface.div(N, 2)),
    flagHas: frag(() => flagHas(S, 1)),
    flagHasAll: frag(() => flagHasAll(S, 3)),
    flagHasAny: frag(() => flagHasAny(S, 3)),
    flagHasNone: frag(() => flagHasNone(S, 4)),
    flagSet: frag(() => flagSet(S, 4)),
    flagUnset: frag(() => flagUnset(S, 4)),
    searchNormalize: frag(() => Surface.searchNormalize(T)),
    normalizedEq: frag(() => normalizedEq(T, 'x')),
    normalizedLike: frag(() => normalizedLike(T, '%x%')),
    normalizedStartsWith: frag(() => normalizedStartsWith(T, 'x')),
    eqAny: frag(() => eqAny(N, [1, 2]), () => eqAny(ref('c', 'char'), ['a'])),
    neAll: frag(() => neAll(N, [1, 2])),
    inArrayOpt: frag(() => inArrayOpt(N, ABOVE_THRESHOLD)),
    notInArrayOpt: frag(() => notInArrayOpt(N, ABOVE_THRESHOLD)),
    // fragments of sql-functions.ts
    cast: frag(() => Surface.cast(N, 'text'), () => Surface.cast(5, 'bigint'), () => Surface.cast(null, 'text')),
    castAsInt: frag(() => castAsInt(T)),
    castAsSmallInt: frag(() => Surface.castAsSmallInt(T)),
    castAsBigInt: frag(() => Surface.castAsBigInt(T)),
    castAsNumeric: frag(() => Surface.castAsNumeric(T, 10, 2)),
    castAsDouble: frag(() => Surface.castAsDouble(T)),
    castAsString: frag(() => castAsString(N)),
    castAsVarchar: frag(() => Surface.castAsVarchar(T, 8)),
    castAsBoolean: frag(() => Surface.castAsBoolean(T)),
    castAsDate: frag(() => Surface.castAsDate(T)),
    castAsTimestamp: frag(() => Surface.castAsTimestamp(T)),
    castAsTimestamptz: frag(() => Surface.castAsTimestamptz(T)),
    castAsJsonb: frag(() => castAsJsonb(T), () => castAsJsonb({ a: 1 })),
    castAsJson: frag(() => Surface.castAsJson(T)),
    castAsUuid: frag(() => Surface.castAsUuid(T)),
    literal: frag(() => literal('x'), () => literal(5), () => literal(-5), () => literal(5n), () => literal(true), () => literal(null), () => literal('a\\b'), () => literal('x', 'text')),
    literalOf: frag(() => literalOf<'a' | 'b'>('a')),
    param: frag(() => param(5), () => param(null, 'integer'), () => param([1, 2], 'integer[]')),
    typedNull: frag(() => Surface.typedNull('text')),
    asBoolean: frag(() => asBoolean(eq(N, 1)), () => asBoolean(normalizedEq(T, 'x')), () => asBoolean(sql`${B} OR ${B}`)),
    caseWhen: frag(() => caseWhen(eq(N, 1), 1).else(2), () => caseWhen(eq(N, 1), 1)),
    caseOf: frag(() => caseOf(N).when(1, 'a').else('b')),
    greatest: frag(() => Surface.greatest(N, 1)),
    least: frag(() => Surface.least(N, 1)),
    nullIf: frag(() => Surface.nullIf(N, 0)),
    isDistinctFrom: frag(() => isDistinctFrom(N, 1)),
    isNotDistinctFrom: frag(() => isNotDistinctFrom(N, 1)),
    lower: frag(() => lower(T)),
    upper: frag(() => Surface.upper(T)),
    trim: frag(() => Surface.trim(T), () => Surface.trim(T, 'x')),
    trimStart: frag(() => Surface.trimStart(T)),
    trimEnd: frag(() => Surface.trimEnd(T)),
    length: frag(() => Surface.length(T)),
    concat: frag(() => Surface.concat(T, 1)),
    concatWs: frag(() => Surface.concatWs(' ', T, T)),
    concatStrict: frag(() => concatStrict(T, literal(' '), T)),
    substring: frag(() => substring(T, 1, 2), () => substring(T, literal('^a'))),
    replace: frag(() => Surface.replace(T, 'a', 'b')),
    regexpReplace: frag(() => Surface.regexpReplace(T, 'a', 'b', 'g')),
    round: frag(() => Surface.round(N), () => Surface.round(N, 2)),
    floor: frag(() => Surface.floor(N)),
    ceil: frag(() => Surface.ceil(N)),
    abs: frag(() => Surface.abs(N)),
    mod: frag(() => Surface.mod(N, 3)),
    modulo: frag(() => modulo(N, 3)),
    currentTimestamp: frag(() => Surface.currentTimestamp()),
    localTimestamp: frag(() => Surface.localTimestamp()),
    currentDate: frag(() => Surface.currentDate()),
    utcTimestamp: frag(() => Surface.utcTimestamp()),
    atTimeZone: frag(() => atTimeZone(TS, 'UTC')),
    dateTrunc: frag(() => Surface.dateTrunc('day', TS), () => Surface.dateTrunc('day', TS, 'UTC')),
    datePart: frag(() => Surface.datePart('year', TS)),
    toChar: frag(() => Surface.toChar(TS, 'YYYY')),
    toInterval: frag(() => Surface.toInterval('1 day'), () => Surface.toInterval({ days: 1 })),
    addInterval: frag(() => addInterval(TS, '1 day')),
    subInterval: frag(() => Surface.subInterval(TS, '1 day')),
    jsonbPath: frag(() => jsonbPath(J, 'a', 0), () => jsonbPath(J, param('a'))),
    jsonbPathText: frag(() => jsonbPathText(J, 'a', 'b'), () => jsonbPathText(J, param('a')), () => jsonbPathText(J, 'tags', -1)),
    jsonbSet: frag(() => jsonbSet(J, ['a'], 1)),
    jsonbRemoveKey: frag(() => jsonbRemoveKey(J, 'k'), () => jsonbRemoveKey(J, 'k', 'j')),
    jsonbRemovePath: frag(() => jsonbRemovePath(J, ['a', 'b'])),
    jsonbContains: frag(() => jsonbContains(J, { a: 1 })),
    jsonbContainedBy: frag(() => jsonbContainedBy(J, { a: 1 })),
    jsonbHasKey: frag(() => jsonbHasKey(J, 'a')),
    jsonbHasAnyKey: frag(() => jsonbHasAnyKey(J, ['a'])),
    jsonbHasAllKeys: frag(() => jsonbHasAllKeys(J, ['a'])),
    jsonbArrayLength: frag(() => Surface.jsonbArrayLength(J)),
    jsonbTypeOf: frag(() => jsonbTypeOf(J)),
    jsonbBuildObject: frag(() => jsonbBuildObject({ a: N, b: { c: 1 }, ok: eq(N, 1) }), () => jsonbBuildObject({})),
    jsonbBuildArray: frag(() => Surface.jsonbBuildArray(N, 1)),
    jsonBuildObject: frag(() => jsonBuildObject({ a: N })),
    jsonBuildArray: frag(() => jsonBuildArray(N, 1)),
    toJsonb: frag(() => Surface.toJsonb(N)),
    jsonbValueText: frag(() => jsonbValueText(J)),
    jsonbPathExists: frag(() => jsonbPathExists(J, '$.a'), () => jsonbPathExists(J, literal('$.a ? (@ > $x)', 'jsonpath'), { vars: jsonbBuildObject({ x: N }), silent: true })),
    arrayContains: frag(() => arrayContains(A, 'a')),
    arrayContainsAll: frag(() => Surface.arrayContainsAll(A, ['a'])),
    arrayOverlaps: frag(() => Surface.arrayOverlaps(A, ['a'])),
    arrayContainedBy: frag(() => Surface.arrayContainedBy(A, ['a'])),
    arrayLength: frag(() => Surface.arrayLength(A)),
    arrayIsEmpty: frag(() => Surface.arrayIsEmpty(A)),
    arrayIsNotEmpty: frag(() => Surface.arrayIsNotEmpty(A)),
    agg: frag(() => agg.count(), () => agg.count(N), () => agg.countDistinct(N), () => agg.sum(N), () => agg.avg(N), () => agg.min(N), () => agg.max(N),
      () => agg.bitOr(S), () => agg.bitAnd(S), () => agg.arrayAgg(N, { orderBy: [[N, 'DESC']] }), () => agg.jsonAgg(N), () => agg.jsonbAgg(N)),
    // subqueries, scopes, sets
    exists: frag(() => exists(sub()), () => exists({ exists: () => sql<boolean>`EXISTS (SELECT 1)` } as any)),
    notExists: frag(() => notExists(sub()), () => notExists({ exists: () => sql<boolean>`EXISTS (SELECT 1)` } as any)),
    eqAnySubquery: frag(() => eqAnySubquery(U, ids())),
    neAllSubquery: frag(() => neAllSubquery(U, ids())),
    onTrue: frag(() => Surface.onTrue()),
    fromSet: frag(() => fromSet(unnest(A)).select((r: any) => r.value).limit(1).asSubquery('scalar').asExpression()),
    // classes whose members build fragments
    SqlFragment: frag(() => coalesce(N, 0).as('x'), () => coalesce(N, 0).mapWith(Number), () => jsonbPathText(J, 'a').withReadType('text'), () => jsonbPathText(J, 'a').castAsInt()),
    AggregateFragment: frag(() => agg.count().filter(gt(N, 1)).filter(sql`${B} OR ${B}`)),
    CaseWhenExpression: frag(() => caseWhen(eq(N, 1), 1).when(gt(N, 5), 2)),
    CaseOfBuilder: frag(() => caseOf(N).when(1, 'a')),
    CaseOfExpression: frag(() => caseOf(N).when(1, 'a').when(2, 'b').else('c')),
    Subquery: frag(() => scalar().asExpression()),
    AliasedScope: frag(() => db.posts.as('p2').where(p => gt(p.views, 5)).scalar(p => add(p.views, 7)), () => db.posts.as('p2').exists(), () => db.posts.as('p2').notExists()),
    // sets: refused as operands
    unnest: refused(() => unnest(A)),
    unnestZip: refused(() => unnestZip({ a: { values: [1], type: 'integer' } })),
    jsonbArrayElements: refused(() => jsonbArrayElements(J)),
    jsonbEachText: refused(() => jsonbEachText(J)),
    SetReturningFunction: refused(() => unnest(A).withReadType('text')),
    // the caller's text
    sql: other("a raw template (sql``, sql.join) is the caller's text: composed as written; and() / or() parenthesize it"),
    RawSql: other('sql.raw(): verbatim caller text'),
    ConditionBuilder: other('renders a condition as a WHERE clause — a whole a_expr position'),
    // JS values
    containsSearch: other('returns a JS LIKE pattern'),
    startsWithSearch: other('returns a JS LIKE pattern'),
    endsWithSearch: other('returns a JS LIKE pattern'),
    jsonbConditionUnwrap: other('returns String(value)'),
    pgTypeOfValue: other('returns a type name'),
    quoteSqlLiteral: other("returns a quoted literal's text: ONE token"),
    ixLower: other('index column wrapper: lower(col) inside an index definition'),
    ixUnaccent: other('index column wrapper: unaccent(col) inside an index definition'),
    ixNormalized: other('index column wrapper: public.search_normalize(col) inside an index definition'),
  };

  const NOT_EXPRESSIONS: Array<[string, string]> = [
    ['integer serial bigint bigserial smallint decimal numeric real doublePrecision varchar char text boolean timestamp timestamptz date time uuid json jsonb bytea enumColumn ColumnBuilder pgEnum EnumTypeRegistry pgCollation CollationRegistry', 'column / type DDL'],
    ['QueryBuilder SelectQueryBuilder CollectionQueryBuilder GroupedQueryBuilder GroupedSelectQueryBuilder GroupedJoinedQueryBuilder JoinQueryBuilder UnionQueryBuilder isUnionQueryBuilder CteRootQueryBuilder CteJoinedQueryBuilder SetQueryBuilder', 'query builder: a statement (its asSubquery() is a Subquery)'],
    ['MockRowCache NavigationPathCache LateralSqlCache LinkgressConfig defaultLogger TimeTracer CollectionStrategyFactory', 'configuration / cache / logging'],
    ['FutureQuery FutureSingleQuery FutureCountQuery FutureQueryRunner isFutureQuery isFutureSingleQuery isFutureCountQuery QueryBatch MutationBatch PreparedQuery', 'statement execution / batching'],
    ['isSubquery DbCte DbCteBuilder isCte', 'subquery / CTE plumbing'],
    ['DbEntity EntityMetadataStore DbColumn isDbColumn EntityConfigBuilder EntityPropertyBuilder EntityNavigationBuilder HasManyNavigationBuilder HasOneNavigationBuilder DbModelConfig ViewConfigBuilder DbContext DbEntityTable EntityInsertBuilder TypeAliases', 'model / context'],
    ['CustomTypeBuilder customType jsonType array enumType point vector interval createCustomType identityMapper applyToDriver applyFromDriver applyFromDriverArray', 'custom type / mapper'],
    ['DbSequence SequenceBuilder sequence DbSchemaManager EnumMigrator MigrationRunner MigrationJournal MigrationLoader MigrationScaffold', 'sequences / migrations'],
    ['DatabaseClient QueryTimeoutError PostgresClient PgClient BunClient PGliteClient createInMemoryDatabase restoreInMemoryDatabase startInMemoryDatabaseThread', 'database client'],
  ];
  for (const [names, why] of NOT_EXPRESSIONS) {
    for (const name of names.split(' ')) {
      SURFACE[name] = other(why);
    }
  }

  test('every runtime export of src/index.ts is classified', () => {
    const exported = Object.keys(Surface).sort();
    expect(exported.filter(name => !(name in SURFACE))).toEqual([]);
    expect(Object.keys(SURFACE).filter(name => !exported.includes(name)).sort()).toEqual([]);
  });

  for (const [name, entry] of Object.entries(SURFACE)) {
    if (entry.kind === 'fragment') {
      test(`${name} renders ONE self-delimited expression`, () => {
        for (const rendered of entry.render()) {
          const { sql: text } = build(rendered);
          expect({ name, sql: text, self: isSelfDelimited(text) }).toEqual({ name, sql: text, self: true });
        }
      });
    } else if (entry.kind === 'condition') {
      test(`${name} (a condition) is parenthesized wherever a fragment interpolates it`, () => {
        for (const condition of entry.render()) {
          const inner = build(condition).sql;
          expect(build(sql`${condition}`).sql).toBe(`(${inner})`);
          expect(build(asBoolean(condition as any)).sql).toBe(`(${inner})`);
        }
      });
    } else if (entry.kind === 'refused') {
      test(`${name} is refused as an operand and renders a call where it may`, () => {
        for (const set of entry.render()) {
          expect(() => build(concatStrict(set as any, literal('x')))).toThrow(/returns a set of rows/);
          expect(isSelfDelimited((set as any).renderCall({ paramCounter: 1, params: [] }))).toBe(true);
        }
      });
    }
  }

  test('a jsonbArraySome element path renders self-delimited', () => {
    let element: any;
    jsonbArraySome<any>(J, e => {
      element = e.meta.ref;
      return eq(e.kind, 'x');
    });
    const { sql: text } = build(element);
    expect({ sql: text, self: isSelfDelimited(text) }).toEqual({ sql: text, self: true });
  });

  test('inArray / notInArray with LinkgressConfig.inArrayUsesOpt render self-delimited above the threshold', () => {
    const previous = LinkgressConfig.inArrayUsesOpt;
    LinkgressConfig.inArrayUsesOpt = true;
    try {
      for (const condition of [inArray(N, [1, 2, 3, 4, 5, 6, 7, 8, 9]), notInArray(N, [1, 2, 3, 4, 5, 6, 7, 8, 9])]) {
        const { sql: text } = build(condition);
        expect({ sql: text, self: isSelfDelimited(text) }).toEqual({ sql: text, self: true });
      }
    } finally {
      LinkgressConfig.inArrayUsesOpt = previous;
    }
  });

  test("a collection navigation's notExists() renders self-delimited in its statement", async () => {
    // rendered by the statement: take it from the WHERE
    const captured: string[] = [];
    const logging = new AppDatabase(db.getClient(), { logQueries: true, logParameters: false, logger: (m: string) => captured.push(m) } as any);
    await logging.users.where(u => notExists(u.posts!.where(p => gt(p.views, 160)))).select(u => ({ id: u.id })).toList();
    const statement = captured.find(s => s.includes('EXISTS'))!.replace(/\s*\n\s*/g, ' ');
    const where = statement.slice(statement.indexOf(' WHERE ') + 7).trim();
    expect({ where, self: isSelfDelimited(where) }).toEqual({ where, self: true });
  });

  // --------------------------------------------------------------------------
  // The 1.0.9 additions (changelog v1.0.9), one by one
  // --------------------------------------------------------------------------

  const additions: Array<[string, () => { buildSql(context: SqlBuildContext): string }]> = [
    ['param', () => param(5)],
    ['param (typed)', () => param(5, 'integer')],
    ['literalOf', () => literalOf<'a' | 'b'>('a')],
    ['concatStrict', () => concatStrict(T, literal(' '), T)],
    ['modulo', () => modulo(N, 3)],
    ['substring (regex overload)', () => substring(T, literal('^a'))],
    ['jsonbValueText', () => jsonbValueText(J)],
    ['jsonBuildObject', () => jsonBuildObject({ a: N, ok: eq(N, 1) })],
    ['jsonBuildArray', () => jsonBuildArray(N, 1)],
    ['agg.count()', () => agg.count()],
    ['agg.count(x)', () => agg.count(N)],
    ['agg.countDistinct', () => agg.countDistinct(N)],
    ['agg.sum', () => agg.sum(N, { distinct: true })],
    ['agg.avg', () => agg.avg(N)],
    ['agg.min', () => agg.min(N)],
    ['agg.max', () => agg.max(N)],
    ['agg.bitOr', () => agg.bitOr(S)],
    ['agg.bitAnd', () => agg.bitAnd(S)],
    ['agg.arrayAgg', () => agg.arrayAgg(N, { distinct: true, orderBy: [[N, 'DESC']] })],
    ['agg.jsonAgg', () => agg.jsonAgg(N)],
    ['agg.jsonbAgg', () => agg.jsonbAgg(N)],
    ['AggregateFragment.filter', () => agg.count().filter(gt(N, 1)).filter(sql`${B} OR ${B}`)],
    ['jsonbPathExists (fragment path / vars)', () => jsonbPathExists(J, literal('$.a ? (@ > $x)', 'jsonpath'), { vars: jsonbBuildObject({ x: N }), silent: true })],
    ['fromSet(…).asSubquery(\'scalar\').asExpression()', () => fromSet(unnest(A)).select((r: any) => r.value).limit(1).asSubquery('scalar').asExpression()],
  ];

  for (const [name, make] of additions) {
    test(`1.0.9 addition ${name} renders self-delimited`, () => {
      const { sql: text } = build(make());
      expect({ name, sql: text, self: isSelfDelimited(text) }).toEqual({ name, sql: text, self: true });
    });
  }

  test('1.0.9 addition agg.arrayAgg as the projected root on a driver without native arrays renders self-delimited', () => {
    const root = agg.arrayAgg(ref('big', 'bigint'), { orderBy: [[N, 'ASC']] });
    const { sql: text } = build(root, { jsonArrayRoot: root });
    expect(text).toStartWith('to_json(');
    expect(isSelfDelimited(text)).toBe(true);
  });

  test('1.0.9 additions eqAnySubquery / neAllSubquery / AliasedScope.scalar / exists / notExists render self-delimited', () => {
    const ids = db.posts.select(p => p.userId).asSubquery('array');
    const scope = db.posts.as('p2').where(p => gt(p.views, 5));
    const U = { ...ref('id', 'integer'), __tableAlias: 'users' };
    const rendered: Record<string, string> = {
      eqAnySubquery: build(eqAnySubquery(U, ids)).sql,
      neAllSubquery: build(neAllSubquery(U, ids)).sql,
      'AliasedScope.scalar': build(scope.scalar(p => add(p.views, 7))).sql,
      'AliasedScope.exists': build(scope.exists()).sql,
      'AliasedScope.notExists': build(scope.notExists()).sql,
    };

    for (const [name, text] of Object.entries(rendered)) {
      expect({ name, sql: text, self: isSelfDelimited(text) }).toEqual({ name, sql: text, self: true });
    }
  });

  test('1.0.9 addition SqlFragment.withReadType (and .as / .mapWith) render exactly the fragment they copy', () => {
    for (const fragment of [jsonbPathText(J, 'a'), jsonbMerge(J, castAsJsonb(PATCH)), eqAny(N, [1]), concatStrict(T, T)]) {
      const text = build(fragment).sql;
      expect(build(fragment.withReadType('text')).sql).toBe(text);
      expect(build(fragment.as('x')).sql).toBe(text);
      expect(build(fragment.mapWith(String)).sql).toBe(text);
    }
  });

  test('1.0.9 additions unnest / unnestZip / jsonbArrayElements / jsonbEachText are refused as operands', () => {
    for (const set of [unnest(A), unnestZip({ a: { values: [1], type: 'integer' } }), jsonbArrayElements(J), jsonbEachText(J)]) {
      expect(() => build(concatStrict(set as any, literal('x')))).toThrow(/returns a set of rows/);
    }
  });
});

// ============================================================================
// 2. Text-valued JSON path helpers × operator contexts
// ============================================================================

type TextOf = (key: string) => any;

const TEXT_HELPERS: Array<{ name: string; of: (z: any) => TextOf }> = [
  { name: 'jsonbSelectText(vJsonb, key)', of: z => key => jsonbSelectText<any>(z.vJsonb, key) },
  { name: 'jsonbPathText(vJsonb, key)', of: z => key => jsonbPathText(z.vJsonb, key) },
  { name: 'jsonbPathText(vJsonb, param(key))', of: z => key => jsonbPathText(z.vJsonb, param(key)) },
];

/** What the helpers deliver for a key: `vJsonb->>key`. */
const textOf = (r: ZooSeed) => (key: string): string | null => asText(at(r.vJsonb, key));

const TEXT_CONTEXTS: Array<{ name: string; build: (T: TextOf, z: any) => unknown; expect: (t: (key: string) => string | null, r: ZooSeed) => unknown }> = [
  { name: "concatStrict('<', ·) — the right operand of ||", build: T => concatStrict(literal('<'), T('f')), expect: t => cat('<', t('f')) },
  { name: "concatStrict(·, '>') — the left operand of ||", build: T => concatStrict(T('f'), literal('>')), expect: t => cat(t('f'), '>') },
  { name: "concatStrict(·, ' ', ·) — both operands of ||", build: T => concatStrict(T('f'), literal(' '), T('l')), expect: t => cat(t('f'), ' ', t('l')) },
  { name: 'startsWith(vText, ·) — the right operand of ^@', build: (T, z) => startsWith(z.vText, T('p')), expect: (t, r) => cmp3(r.vText, t('p'), (a, b) => a.startsWith(b)) },
  { name: "startsWith(·, 'A') — the left operand of ^@", build: T => startsWith(T('f'), 'A'), expect: t => cmp3(t('f'), 'A', (a, b) => a.startsWith(b)) },
  { name: 'regexMatches(vText, ·) — the right operand of ~', build: (T, z) => regexMatches(z.vText, T('re')), expect: (t, r) => cmp3(r.vText, t('re'), (a, b) => new RegExp(b).test(a)) },
  { name: 'regexMatchesCaseInsensitive(vText, ·) — the right operand of ~*', build: (T, z) => regexMatchesCaseInsensitive(z.vText, T('re')), expect: (t, r) => cmp3(r.vText, t('re'), (a, b) => new RegExp(b, 'i').test(a)) },
  { name: 'regexNoMatch(vText, ·) — the right operand of !~', build: (T, z) => regexNoMatch(z.vText, T('re')), expect: (t, r) => cmp3(r.vText, t('re'), (a, b) => !new RegExp(b).test(a)) },
  { name: 'regexNoMatchCaseInsensitive(vText, ·) — the right operand of !~*', build: (T, z) => regexNoMatchCaseInsensitive(z.vText, T('re')), expect: (t, r) => cmp3(r.vText, t('re'), (a, b) => !new RegExp(b, 'i').test(a)) },
  { name: "regexMatches(·, '^[AB]') — the left operand of ~", build: T => regexMatches(T('f'), '^[AB]'), expect: t => cmp3(t('f'), '^[AB]', (a, b) => new RegExp(b).test(a)) },
  { name: 'eq(vText, ·) — the right side of =', build: (T, z) => eq(z.vText, T('f')), expect: (t, r) => cmp3(r.vText, t('f'), (a, b) => a === b) },
  { name: 'eq(·, vText) — the left side of =', build: (T, z) => eq(T('f'), z.vText), expect: (t, r) => cmp3(t('f'), r.vText, (a, b) => a === b) },
  { name: 'ne(vText, ·) — the right side of !=', build: (T, z) => ne(z.vText, T('f')), expect: (t, r) => cmp3(r.vText, t('f'), (a, b) => a !== b) },
  { name: 'like(vText, ·) — the LIKE pattern', build: (T, z) => like(z.vText, T('lp')), expect: (t, r) => cmp3(r.vText, t('lp'), (a, b) => likeMatch(a, b)) },
  { name: 'ilike(vText, ·) — the ILIKE pattern', build: (T, z) => ilike(z.vText, T('lp')), expect: (t, r) => cmp3(r.vText, t('lp'), (a, b) => likeMatch(a, b, true)) },
  { name: "like(·, 'A%') — the LIKE subject", build: T => like(T('f'), 'A%'), expect: t => cmp3(t('f'), 'A%', (a, b) => likeMatch(a, b)) },
  { name: "inArray(·, ['Ann', 'Cyd']) — the IN subject", build: T => inArray(T('f'), ['Ann', 'Cyd']), expect: t => in3(t('f'), ['Ann', 'Cyd']) },
  { name: "notInArray(·, ['Ann']) — the NOT IN subject", build: T => notInArray(T('f'), ['Ann']), expect: t => not3(in3(t('f'), ['Ann'])) },
  { name: "between(·, 'B', 'D') — the BETWEEN subject", build: T => between(T('f'), literal('B'), literal('D')), expect: t => cmp3(t('f'), 'B', (a, b) => a >= b && a <= 'D') },
  { name: "between('C', ·, 'Z') — the BETWEEN lower bound (a b_expr)", build: T => between(literal('C'), T('p'), literal('Z')), expect: t => cmp3('C', t('p'), (a, b) => a >= b && a <= 'Z') },
  { name: "between('C', 'A', ·) — the BETWEEN upper bound", build: T => between(literal('C'), literal('A'), T('p')), expect: t => cmp3('C', t('p'), (a, b) => a >= 'A' && a <= b) },
  { name: 'isNull(·) — IS NULL', build: T => isNull(T('l')), expect: t => t('l') === null },
  { name: 'isNotNull(·) — IS NOT NULL', build: T => isNotNull(T('l')), expect: t => t('l') !== null },
  { name: 'isDistinctFrom(vText, ·) — the right side of IS DISTINCT FROM', build: (T, z) => isDistinctFrom(z.vText, T('f')), expect: (t, r) => distinct(r.vText, t('f')) },
  { name: 'isNotDistinctFrom(·, vText) — the left side of IS NOT DISTINCT FROM', build: (T, z) => isNotDistinctFrom(T('f'), z.vText), expect: (t, r) => !distinct(t('f'), r.vText) },
  { name: "eqAny(·, ['Ann', 'Cyd']) — the left side of = ANY", build: T => eqAny(T('f'), ['Ann', 'Cyd']), expect: t => in3(t('f'), ['Ann', 'Cyd']) },
  { name: "neAll(·, ['Ann']) — the left side of <> ALL", build: T => neAll(T('f'), ['Ann']), expect: t => not3(in3(t('f'), ['Ann'])) },
  { name: "arrayContains(param(['Ann', 'Cyd'], 'text[]'), ·) — the left side of = ANY", build: T => arrayContains(param(['Ann', 'Cyd'], 'text[]') as any, T('f')), expect: t => in3(t('f'), ['Ann', 'Cyd']) },
  { name: 'jsonbPathText(vJsonb, ·) — a JSON path key (the right operand of ->>)', build: (T, z) => jsonbPathText(z.vJsonb, T('key')), expect: (t, r) => (t('key') === null ? null : asText(at(r.vJsonb, t('key')!))) },
  { name: 'jsonbPath(vJsonb, ·) — a JSON path key (the right operand of ->)', build: (T, z) => jsonbPath(z.vJsonb, T('key')), expect: (t, r) => (t('key') === null ? null : at(r.vJsonb, t('key')!)) },
  { name: 'sql`${·}::integer` — a raw template casting the helper (::)', build: T => sql<number>`${T('n')}::integer`, expect: t => (t('n') === null ? null : Number(t('n'))) },
  { name: 'castAsInt(·) — CAST', build: T => castAsInt(T('n')), expect: t => (t('n') === null ? null : Number(t('n'))) },
  { name: "coalesce(·, '-') — a function argument", build: T => coalesce(T('l'), '-'), expect: t => t('l') ?? '-' },
  { name: 'lower(·) — a function argument', build: T => lower(T('f')), expect: t => t('f')?.toLowerCase() ?? null },
  { name: "caseWhen(isNull(·), 'none').else(·) — a CASE condition and result", build: T => caseWhen(isNull(T('l')), literal('none')).else(T('l')), expect: t => t('l') ?? 'none' },
  { name: "caseOf(·).when('Ann', 1).else(0) — the simple CASE subject", build: T => caseOf(T('f')).when('Ann', literal(1)).else(literal(0)), expect: t => (t('f') === 'Ann' ? 1 : 0) },
  { name: 'jsonbBuildObject({ t: · }) — a json builder argument', build: T => jsonbBuildObject({ t: T('f') }), expect: t => ({ t: t('f') }) },
  { name: "normalizedEq(·, 'ann') — the search_normalize() argument", build: T => normalizedEq(T('f'), 'ann'), expect: t => (t('f') === null ? null : t('f')!.toLowerCase() === 'ann') },
];

describe('2. text-valued JSON path helpers × operator contexts (evaluated)', () => {
  for (const helper of TEXT_HELPERS) {
    for (const context of TEXT_CONTEXTS) {
      test(`${helper.name} × ${context.name}`, async () => {
        const values = await zooValues(z => context.build(helper.of(z), z));
        expect(values).toEqual(ZOO.map(r => context.expect(textOf(r), r)));
      });
    }
  }
});

// ============================================================================
// 3. jsonb-valued helpers × operator contexts
// ============================================================================

interface JsonHelper {
  name: string;
  of: (z: any) => any;
  value: (r: ZooSeed) => Record<string, any> | null;
  /** a key holding a string / a key present in some rows only */
  textKey: string;
  someKey: string;
  /** contained in some rows' values / containing some rows' values / equal to one row's value */
  probe: Record<string, unknown>;
  big: Record<string, unknown>;
  equal: Record<string, unknown>;
}

const merged = (r: ZooSeed): Record<string, any> => ({ ...(r.vJsonb ?? {}), ...PATCH });

const JSON_HELPERS: JsonHelper[] = [
  {
    name: 'jsonbMerge(vJsonb, patch)', of: z => jsonbMerge(z.vJsonb, castAsJsonb(PATCH)), value: merged,
    textKey: 'f', someKey: 'l', probe: { f: 'Ann' }, big: merged(ZOO[1]), equal: merged(ZOO[0]),
  },
  {
    name: "jsonbSelect(vJsonb, 'b')", of: z => jsonbSelect<any>(z.vJsonb, 'b'), value: r => at(r.vJsonb, 'b'),
    textKey: 's', someKey: 'x', probe: { k: 1 }, big: { k: 1, s: 'p1', x: 2, y: 4 }, equal: { k: 3, s: 'p2', y: 4 },
  },
  {
    name: "jsonbPath(vJsonb, 'b')", of: z => jsonbPath(z.vJsonb, 'b'), value: r => at(r.vJsonb, 'b'),
    textKey: 's', someKey: 'x', probe: { k: 1 }, big: { k: 1, s: 'p1', x: 2, y: 4 }, equal: { k: 3, s: 'p2', y: 4 },
  },
];

const JSON_CONTEXTS: Array<{ name: string; build: (J: any, h: JsonHelper) => unknown; expect: (j: Record<string, any> | null, h: JsonHelper) => unknown }> = [
  // text-typed separators: an untyped '<' next to a jsonb operand resolves as jsonb || jsonb
  { name: "concatStrict('<', ·) — the right operand of ||", build: J => concatStrict(literal('<', 'text'), J), expect: j => cat('<', j === null ? null : jsonbText(j)) },
  { name: "concatStrict(·, '>') — the left operand of ||", build: J => concatStrict(J, literal('>', 'text')), expect: j => cat(j === null ? null : jsonbText(j), '>') },
  { name: "jsonbRemoveKey(·, 'k') — the left operand of - (additive, tighter than ||)", build: J => jsonbRemoveKey(J, 'k'), expect: j => omit(j, 'k') },
  { name: "jsonbRemovePath(·, ['k']) — the left operand of #-", build: J => jsonbRemovePath(J, ['k']), expect: j => omit(j, 'k') },
  { name: 'jsonbContains(·, probe) — the left operand of @>', build: (J, h) => jsonbContains(J, h.probe), expect: (j, h) => (j === null ? null : contains(j, h.probe)) },
  { name: 'jsonbContains(big, ·) — the right operand of @>', build: (J, h) => jsonbContains(castAsJsonb(h.big), J), expect: (j, h) => (j === null ? null : contains(h.big, j)) },
  { name: 'jsonbContainedBy(·, big) — the left operand of <@', build: (J, h) => jsonbContainedBy(J, h.big), expect: (j, h) => (j === null ? null : contains(h.big, j)) },
  { name: 'jsonbContainedBy(probe, ·) — the right operand of <@', build: (J, h) => jsonbContainedBy(castAsJsonb(h.probe), J), expect: (j, h) => (j === null ? null : contains(j, h.probe)) },
  { name: 'jsonbHasKey(·, key) — the left operand of ?', build: (J, h) => jsonbHasKey(J, h.someKey), expect: (j, h) => (j === null ? null : h.someKey in j) },
  { name: 'jsonbHasAnyKey(·, [q, key]) — the left operand of ?|', build: (J, h) => jsonbHasAnyKey(J, ['q', h.someKey]), expect: (j, h) => (j === null ? null : h.someKey in j) },
  { name: 'jsonbHasAllKeys(·, [k, key]) — the left operand of ?&', build: (J, h) => jsonbHasAllKeys(J, ['k', h.someKey]), expect: (j, h) => (j === null ? null : 'k' in j && h.someKey in j) },
  { name: 'jsonbValueText(·) — the left operand of #>>', build: J => jsonbValueText(J), expect: j => (j === null ? null : jsonbText(j)) },
  { name: 'jsonbPathText(·, key) — the left operand of ->>', build: (J, h) => jsonbPathText(J, h.textKey), expect: (j, h) => asText(at(j, h.textKey)) },
  { name: 'jsonbSelectText(·, key) — the left operand of ->>', build: (J, h) => jsonbSelectText<any>(J, h.textKey), expect: (j, h) => asText(at(j, h.textKey)) },
  { name: "jsonbPath(·, 'k') — the left operand of ->", build: J => jsonbPath(J, 'k'), expect: j => at(j, 'k') },
  { name: "jsonbSelect(·, 'k') — the operand of #>> inside jsonbSelect", build: J => jsonbSelect<any>(J, 'k'), expect: j => at(j, 'k') },
  { name: 'jsonbMerge(·, { m: 1 }) — the COALESCE argument of jsonbMerge', build: J => jsonbMerge(J, castAsJsonb({ m: 1 })), expect: j => ({ ...(j ?? {}), m: 1 }) },
  { name: 'jsonbMerge({ m: 1 }, ·) — the patch of jsonbMerge', build: J => jsonbMerge(castAsJsonb({ m: 1 }), J), expect: j => (j === null ? null : { m: 1, ...j }) },
  { name: 'eq(·, value) — the left side of =', build: (J, h) => eq(J, castAsJsonb(h.equal)), expect: (j, h) => (j === null ? null : deepEqual(j, h.equal)) },
  { name: 'eq(value, ·) — the right side of =', build: (J, h) => eq(castAsJsonb(h.equal), J), expect: (j, h) => (j === null ? null : deepEqual(j, h.equal)) },
  { name: 'isNull(·) — IS NULL', build: J => isNull(J), expect: j => j === null },
  { name: 'isDistinctFrom(·, value) — IS DISTINCT FROM', build: (J, h) => isDistinctFrom(J, castAsJsonb(h.equal)), expect: (j, h) => distinct(j, h.equal) },
  { name: 'coalesce(·, {}) — a function argument', build: J => coalesce(J, castAsJsonb({})), expect: j => j ?? {} },
  { name: 'jsonbTypeOf(·) — a function argument', build: J => jsonbTypeOf(J), expect: j => (j === null ? null : 'object') },
  { name: "jsonbSet(·, ['q'], 1) — a function argument", build: J => jsonbSet(J, ['q'], 1), expect: j => (j === null ? null : { ...j, q: 1 }) },
  { name: 'jsonbBuildObject({ j: · }) — a json builder argument', build: J => jsonbBuildObject({ j: J }), expect: j => ({ j }) },
  { name: 'castAsString(·) — CAST', build: J => castAsString(J), expect: j => (j === null ? null : jsonbText(j)) },
  { name: 'sql`${·}::text` — a raw template casting the helper (::)', build: J => sql<string>`${J}::text`, expect: j => (j === null ? null : jsonbText(j)) },
  { name: 'caseWhen(isNull(·), {}).else(·) — a CASE condition and result', build: J => caseWhen(isNull(J), castAsJsonb({ none: true })).else(J), expect: j => j ?? { none: true } },
];

describe('3. jsonb-valued helpers × operator contexts (evaluated)', () => {
  for (const helper of JSON_HELPERS) {
    for (const context of JSON_CONTEXTS) {
      test(`${helper.name} × ${context.name}`, async () => {
        const values = await zooValues(z => context.build(helper.of(z), helper));
        expect(values).toEqual(ZOO.map(r => context.expect(helper.value(r), helper)));
      });
    }
  }
});

// ============================================================================
// 4. Boolean condition fragments × operator contexts
// ============================================================================

const TEN = [100, 7, 1, 2, 3, 4, 5, 6, 8, 9];

const CONDITION_HELPERS: Array<{ name: string; of: (z: any) => any; value: (r: ZooSeed) => B3 }> = [
  { name: 'eqAny(vInteger, [100, 7])', of: z => eqAny(z.vInteger, [100, 7]), value: r => in3(r.vInteger, [100, 7]) },
  { name: 'neAll(vInteger, [7])', of: z => neAll(z.vInteger, [7]), value: r => not3(in3(r.vInteger, [7])) },
  { name: 'inArrayOpt(vInteger, 10 values) — its = ANY form', of: z => inArrayOpt(z.vInteger, TEN), value: r => in3(r.vInteger, TEN) },
  { name: 'notInArrayOpt(vInteger, 10 values) — its <> ALL form', of: z => notInArrayOpt(z.vInteger, TEN), value: r => not3(in3(r.vInteger, TEN)) },
  { name: 'flagHas(vSmallint, 1)', of: z => flagHas(z.vSmallint, 1), value: r => (r.vSmallint & 1) !== 0 },
  { name: 'flagHasAll(vSmallint, 5)', of: z => flagHasAll(z.vSmallint, 5), value: r => (r.vSmallint & 5) === 5 },
  { name: 'flagHasAny(vSmallint, 2)', of: z => flagHasAny(z.vSmallint, 2), value: r => (r.vSmallint & 2) !== 0 },
  { name: 'flagHasNone(vSmallint, 4)', of: z => flagHasNone(z.vSmallint, 4), value: r => (r.vSmallint & 4) === 0 },
  { name: "normalizedEq(vText, 'BOB')", of: z => normalizedEq(z.vText, 'BOB'), value: r => (r.vText === null ? null : r.vText.toLowerCase() === 'bob') },
  { name: "normalizedLike(vText, '%N%')", of: z => normalizedLike(z.vText, '%N%'), value: r => (r.vText === null ? null : r.vText.toLowerCase().includes('n')) },
  { name: "normalizedStartsWith(vText, 'C')", of: z => normalizedStartsWith(z.vText, 'C'), value: r => (r.vText === null ? null : r.vText.toLowerCase().startsWith('c')) },
  { name: 'eqAnySubquery(vInteger, posts.views)', of: z => eqAnySubquery(z.vInteger, postsViewsSubquery()), value: r => in3(r.vInteger, POST_VIEWS) },
  { name: 'neAllSubquery(vInteger, posts.views)', of: z => neAllSubquery(z.vInteger, postsViewsSubquery()), value: r => not3(in3(r.vInteger, POST_VIEWS)) },
];

const CONDITION_CONTEXTS: Array<{ name: string; build: (B: any, z: any) => unknown; expect: (b: B3, r: ZooSeed) => unknown }> = [
  { name: 'eq(vBool, ·) — the right side of =', build: (B, z) => eq(z.vBool, B), expect: (b, r) => cmp3(r.vBool, b, (x, y) => x === y) },
  { name: 'ne(vBool, ·) — the right side of !=', build: (B, z) => ne(z.vBool, B), expect: (b, r) => cmp3(r.vBool, b, (x, y) => x !== y) },
  { name: 'gt(vBool, ·) — the right side of >', build: (B, z) => gt(z.vBool, B), expect: (b, r) => cmp3(r.vBool, b, (x, y) => ord(x) > ord(y)) },
  { name: 'eq(·, vBool) — the left side of =', build: (B, z) => eq(B, z.vBool), expect: (b, r) => cmp3(b, r.vBool, (x, y) => x === y) },
  { name: 'ne(·, vBool) — the left side of !=', build: (B, z) => ne(B, z.vBool), expect: (b, r) => cmp3(b, r.vBool, (x, y) => x !== y) },
  { name: 'lte(·, vBool) — the left side of <=', build: (B, z) => lte(B, z.vBool), expect: (b, r) => cmp3(b, r.vBool, (x, y) => ord(x) <= ord(y)) },
  { name: 'isNull(·) — IS NULL', build: B => isNull(B), expect: b => b === null },
  { name: 'isNotNull(·) — IS NOT NULL', build: B => isNotNull(B), expect: b => b !== null },
  { name: 'isDistinctFrom(·, vBool) — the left side of IS DISTINCT FROM', build: (B, z) => isDistinctFrom(B, z.vBool), expect: (b, r) => distinct(b, r.vBool) },
  { name: 'isNotDistinctFrom(vBool, ·) — the right side of IS NOT DISTINCT FROM', build: (B, z) => isNotDistinctFrom(z.vBool, B), expect: (b, r) => !distinct(r.vBool, b) },
  { name: 'not(·) — NOT', build: B => not(B), expect: b => not3(b) },
  { name: 'and(·, isNotNull(vText)) — an AND operand', build: (B, z) => and(B, isNotNull(z.vText)), expect: (b, r) => and3(b, r.vText !== null) },
  { name: "or(·, eq(vText, 'Cyd')) — an OR operand", build: (B, z) => or(B, eq(z.vText, 'Cyd')), expect: (b, r) => or3(b, cmp3(r.vText, 'Cyd', (x, y) => x === y)) },
  { name: "caseWhen(·, 'y').else('n') — the CASE WHEN condition", build: B => caseWhen(B, literal('y')).else(literal('n')), expect: b => (b === true ? 'y' : 'n') },
  { name: 'caseWhen(isNotNull(label), ·).else(false) — a CASE result', build: (B, z) => caseWhen(isNotNull(z.label), B).else(literal(false)), expect: b => b },
  { name: "caseOf(·).when(true, 't').else('f') — the simple CASE subject", build: B => caseOf(B).when(literal(true), literal('t')).else(literal('f')), expect: b => (b === true ? 't' : 'f') },
  { name: 'coalesce(·, false) — a function argument', build: B => coalesce(B, literal(false)), expect: b => b ?? false },
  { name: 'asBoolean(·) — a boolean value', build: B => asBoolean(B), expect: b => b },
  { name: 'jsonbBuildObject({ b: · }) — a json builder argument', build: B => jsonbBuildObject({ b: B }), expect: b => ({ b }) },
  { name: "concatStrict('<', ·) — the right operand of ||", build: B => concatStrict(literal('<'), B), expect: b => cat('<', b === null ? null : String(b)) },
  { name: "concatStrict(·, '>') — the left operand of ||", build: B => concatStrict(B, literal('>')), expect: b => cat(b === null ? null : String(b), '>') },
  { name: 'between(·, false, true) — the BETWEEN subject', build: B => between(B, literal(false), literal(true)), expect: b => (b === null ? null : true) },
  { name: 'inArray(·, [true]) — the IN subject', build: B => inArray(B, [true]), expect: b => in3(b, [true]) },
  { name: 'notInArray(·, [true]) — the NOT IN subject', build: B => notInArray(B, [true]), expect: b => not3(in3(b, [true])) },
  { name: "arrayContains(param([true], 'boolean[]'), ·) — the left side of = ANY", build: B => arrayContains(param([true], 'boolean[]') as any, B), expect: b => in3(b, [true]) },
];

describe('4. boolean condition fragments × operator contexts (evaluated)', () => {
  for (const helper of CONDITION_HELPERS) {
    for (const context of CONDITION_CONTEXTS) {
      test(`${helper.name} × ${context.name}`, async () => {
        const values = await zooValues(z => context.build(helper.of(z), z));
        expect(values).toEqual(ZOO.map(r => context.expect(helper.value(r), r)));
      });
    }
  }
});

// ============================================================================
// 5. NOT EXISTS × operator contexts
// ============================================================================

const NOT_EXISTS_CONTEXTS: Array<{ name: string; build: (N: any, flag: any, text: any) => unknown; expect: (n: boolean, flag: B3, text: B3) => unknown }> = [
  { name: 'isNull(·) — IS NULL', build: N => isNull(N), expect: () => false },
  { name: 'isNotNull(·) — IS NOT NULL', build: N => isNotNull(N), expect: () => true },
  { name: 'isDistinctFrom(·, flag) — the left side of IS DISTINCT FROM', build: (N, f) => isDistinctFrom(N, f), expect: (n, f) => distinct(n, f) },
  { name: 'isNotDistinctFrom(·, flag) — the left side of IS NOT DISTINCT FROM', build: (N, f) => isNotDistinctFrom(N, f), expect: (n, f) => !distinct(n, f) },
  { name: 'isDistinctFrom(flag, ·) — the right side of IS DISTINCT FROM', build: (N, f) => isDistinctFrom(f, N), expect: (n, f) => distinct(f, n) },
  { name: 'eq(·, flag) — the left side of =', build: (N, f) => eq(N, f), expect: (n, f) => cmp3(n, f, (x, y) => x === y) },
  { name: 'ne(·, flag) — the left side of !=', build: (N, f) => ne(N, f), expect: (n, f) => cmp3(n, f, (x, y) => x !== y) },
  { name: 'gt(·, flag) — the left side of >', build: (N, f) => gt(N, f), expect: (n, f) => cmp3(n, f, (x, y) => ord(x) > ord(y)) },
  { name: 'gte(·, flag) — the left side of >=', build: (N, f) => gte(N, f), expect: (n, f) => cmp3(n, f, (x, y) => ord(x) >= ord(y)) },
  { name: 'lt(·, flag) — the left side of <', build: (N, f) => lt(N, f), expect: (n, f) => cmp3(n, f, (x, y) => ord(x) < ord(y)) },
  { name: 'lte(·, flag) — the left side of <=', build: (N, f) => lte(N, f), expect: (n, f) => cmp3(n, f, (x, y) => ord(x) <= ord(y)) },
  { name: 'eq(flag, ·) — the right side of =', build: (N, f) => eq(f, N), expect: (n, f) => cmp3(f, n, (x, y) => x === y) },
  { name: 'between(·, false, true) — the BETWEEN subject', build: N => between(N, literal(false), literal(true)), expect: () => true },
  { name: 'inArray(·, [true, false]) — the IN subject', build: N => inArray(N, [true, false]), expect: () => true },
  { name: 'notInArray(·, [true]) — the NOT IN subject', build: N => notInArray(N, [true]), expect: n => !n },
  { name: "arrayContains(param([true, false], 'boolean[]'), ·) — the left side of = ANY", build: N => arrayContains(param([true, false], 'boolean[]') as any, N), expect: () => true },
  { name: 'eqAnySubquery(·, users.isActive) — the left side of = ANY (ARRAY(…))', build: N => eqAnySubquery(N, usersActiveSubquery()), expect: () => true },
  { name: "concatStrict(·, '!') — the left operand of ||", build: N => concatStrict(N, literal('!')), expect: n => `${n}!` },
  { name: "concatStrict('<', ·) — the right operand of ||", build: N => concatStrict(literal('<'), N), expect: n => `<${n}` },
  { name: 'not(·) — NOT', build: N => not(N), expect: n => !n },
  { name: 'and(·, isNotNull(text)) — an AND operand', build: (N, _f, t) => and(N, isNotNull(t)), expect: (n, _f, t) => and3(n, t) },
  { name: "caseWhen(·, 'y').else('n') — the CASE WHEN condition", build: N => caseWhen(N, literal('y')).else(literal('n')), expect: n => (n ? 'y' : 'n') },
  { name: 'coalesce(·, false) — a function argument', build: N => coalesce(N, literal(false)), expect: n => n },
  { name: 'asBoolean(·) — a boolean value', build: N => asBoolean(N), expect: n => n },
  { name: 'jsonbBuildObject({ n: · }) — a json builder argument', build: N => jsonbBuildObject({ n: N }), expect: n => ({ n }) },
];

/** NOT EXISTS over type_zoo rows: posts whose views equal vInteger (prec-1, prec-4 have one). */
const ZOO_NOT_EXISTS: Array<{ name: string; of: (z: any) => any }> = [
  { name: 'notExists(posts.where(views = vInteger).asSubquery())', of: z => notExists(db.posts.where(p => eq(p.views, z.vInteger)).select(p => ({ id: p.id })).asSubquery()) },
  { name: "db.posts.as('p2').where(views = vInteger).notExists()", of: z => db.posts.as('p2').where(p => eq(p.views, z.vInteger)).notExists() },
];

describe('5. NOT EXISTS × operator contexts (evaluated)', () => {
  for (const helper of ZOO_NOT_EXISTS) {
    for (const context of NOT_EXISTS_CONTEXTS) {
      test(`${helper.name} × ${context.name}`, async () => {
        const values = await zooValues(z => context.build(helper.of(z), z.vBool, z.vText));
        expect(values).toEqual(ZOO.map(r => context.expect(!POST_VIEWS.includes(r.vInteger as number), r.vBool, r.vText !== null)));
      });
    }
  }

  // A collection navigation's notExists(): users, whose flag is NULL for bob
  for (const context of NOT_EXISTS_CONTEXTS) {
    test(`notExists(u.posts.where(views over 160)) × ${context.name}`, async () => {
      const values = await userValues(u => context.build(notExists(u.posts!.where((p: any) => gt(p.views, 160))), u.isActive, u.email));
      expect(values).toEqual(USERS.map(u => context.expect(!u.hasPostOver160, u.isActive, true)));
    });
  }
});

// ============================================================================
// 6. jsonbArraySome element paths × operator contexts
// ============================================================================

describe('6. jsonbArraySome element paths × operator contexts (evaluated)', () => {
  const items = (r: ZooSeed): Array<Record<string, string>> => (Array.isArray(r.vJsonb?.items) ? r.vJsonb!.items : []);
  const cases: Array<{ name: string; predicate: (e: any, z: any) => any; expect: (item: Record<string, string>, r: ZooSeed) => boolean }> = [
    { name: "concatStrict(e.f, ' ', e.l) — both operands of ||", predicate: e => eq(concatStrict(e.f, literal(' '), e.l), 'Ann Lee'), expect: i => `${i.f} ${i.l}` === 'Ann Lee' },
    { name: 'startsWith(vText, e.f) — the right operand of ^@', predicate: (e, z) => startsWith(z.vText, e.f), expect: (i, r) => r.vText !== null && r.vText.startsWith(i.f) },
    { name: 'regexMatches(vText, e.re) — the right operand of ~', predicate: (e, z) => regexMatches(z.vText, e.re), expect: (i, r) => r.vText !== null && new RegExp(i.re).test(r.vText) },
    { name: 'sql`${e.n}::integer` > 4 — a raw template casting the element path (::)', predicate: e => gt(sql<number>`${e.n}::integer`, 4), expect: i => Number(i.n) > 4 },
    { name: "eq(e.f, 'Bob') — the left side of =", predicate: e => eq(e.f, 'Bob'), expect: i => i.f === 'Bob' },
    { name: "like(e.f, 'A%') — the LIKE subject", predicate: e => like(e.f, 'A%'), expect: i => i.f.startsWith('A') },
  ];

  for (const { name, predicate, expect: expected } of cases) {
    test(`jsonbArraySome(jsonbPath(vJsonb, 'items'), e => …) × ${name}`, async () => {
      const values = await zooValues(z => jsonbArraySome<any>(jsonbPath(z.vJsonb, 'items'), e => predicate(e, z)));
      expect(values).toEqual(ZOO.map(r => items(r).some(item => expected(item, r))));
    });
  }
});

// ============================================================================
// 7. Statement positions
// ============================================================================

describe('7. statement positions: WHERE, ORDER BY, GROUP BY, UPDATE SET, FILTER, a row guard (evaluated)', () => {
  const labelsWhere = async (condition: (z: any) => any): Promise<string[]> => (await db.typeZoo
    .where(z => and(like(z.label, 'prec-%'), condition(z)))
    .orderBy(z => z.label)
    .select(z => ({ label: z.label }))
    .toList()).map(r => r.label);

  test('WHERE: a composed condition over bare-form helpers filters by its meaning', async () => {
    const notExistsN = (z: any) => notExists(db.posts.where(p => eq(p.views, z.vInteger)).select(p => ({ id: p.id })).asSubquery());
    expect(await labelsWhere(z => isDistinctFrom(notExistsN(z), z.vBool)))
      .toEqual(ZOO.filter(r => distinct(!POST_VIEWS.includes(r.vInteger as number), r.vBool)).map(r => r.label));
    expect(await labelsWhere(z => eq(z.vBool, flagHas(z.vSmallint, 1))))
      .toEqual(ZOO.filter(r => cmp3(r.vBool, (r.vSmallint & 1) !== 0, (x, y) => x === y) === true).map(r => r.label));
    expect(await labelsWhere(z => startsWith(z.vText, jsonbPathText(z.vJsonb, 'p'))))
      .toEqual(ZOO.filter(r => r.vText !== null && at(r.vJsonb, 'p') !== null && r.vText.startsWith(at(r.vJsonb, 'p'))).map(r => r.label));
  });

  test('ORDER BY: a composed text key orders by its value', async () => {
    const rows = await db.typeZoo
      .where(z => and(like(z.label, 'prec-%'), isNotNull(z.vJsonb)))
      .orderBy(z => [[concatStrict(literal('<'), jsonbPathText(z.vJsonb, 'l')), 'ASC'], [z.label, 'ASC']])
      .select(z => ({ label: z.label }))
      .toList();
    const key = (r: ZooSeed) => cat('<', asText(at(r.vJsonb, 'l')));
    const expected = ZOO.filter(r => r.vJsonb !== null)
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        // PostgreSQL sorts NULL last in ascending order
        return ka === kb ? a.label.localeCompare(b.label) : ka === null ? 1 : kb === null ? -1 : ka < kb ? -1 : 1;
      })
      .map(r => r.label);
    expect(rows.map(r => r.label)).toEqual(expected);
  });

  test('GROUP BY: a composed boolean key groups by its value', async () => {
    const rows: Array<{ odd: boolean; n: number }> = await (db.typeZoo
      .where(z => like(z.label, 'prec-%'))
      .select(z => ({ flags: z.vSmallint, label: z.label })) as any)
      .groupBy((r: any) => ({ odd: asBoolean(eq(literal(true), flagHas(r.flags, 1))) }))
      .select((g: any) => ({ odd: g.key.odd, n: g.count() }))
      .toList();
    const counts = new Map<boolean, number>();
    for (const r of ZOO) {
      const odd = (r.vSmallint & 1) !== 0;
      counts.set(odd, (counts.get(odd) ?? 0) + 1);
    }
    const byFlag = (a: { odd: boolean }, b: { odd: boolean }) => ord(a.odd) - ord(b.odd);
    expect(rows.map(r => ({ odd: r.odd, n: Number(r.n) })).sort(byFlag))
      .toEqual([...counts.entries()].map(([odd, n]) => ({ odd, n })).sort(byFlag));
  });

  test('UPDATE SET: jsonbRemoveKey(jsonbMerge(col, patch), key) removes the key from the MERGED document', async () => {
    await db.typeZoo.where(z => like(z.label, 'upd-%')).delete();
    const seeds = ZOO.map(r => ({ ...r, label: r.label.replace('prec-', 'upd-') }));
    await db.typeZoo.insertBulk(seeds.map(r => ({ ...r, vJsonb: r.vJsonb as any })));

    await db.typeZoo
      .where(z => like(z.label, 'upd-%'))
      .update(z => ({ vJsonb: jsonbRemoveKey(jsonbMerge(z.vJsonb, castAsJsonb(PATCH)), 'k') as any }));

    const rows = await db.typeZoo.where(z => like(z.label, 'upd-%')).orderBy(z => z.label).select(z => ({ doc: z.vJsonb })).toList();
    expect(rows.map(r => r.doc)).toEqual(seeds.map(r => omit(merged(r), 'k')));
  });

  test('UPDATE SET: a boolean column set from a comparison-level fragment and from a NOT EXISTS comparison', async () => {
    await db.typeZoo.where(z => like(z.label, 'upd-%')).delete();
    const seeds = ZOO.map(r => ({ ...r, label: r.label.replace('prec-', 'upd-') }));
    await db.typeZoo.insertBulk(seeds.map(r => ({ ...r, vJsonb: r.vJsonb as any })));

    await db.typeZoo
      .where(z => like(z.label, 'upd-%'))
      .update(z => ({
        vBool: isDistinctFrom(notExists(db.posts.where(p => eq(p.views, z.vInteger)).select(p => ({ id: p.id })).asSubquery()), z.vBool) as any,
      }));

    const rows = await db.typeZoo.where(z => like(z.label, 'upd-%')).orderBy(z => z.label).select(z => ({ flag: z.vBool })).toList();
    expect(rows.map(r => r.flag)).toEqual(seeds.map(r => distinct(!POST_VIEWS.includes(r.vInteger as number), r.vBool)));
  });

  test('FILTER: an aggregate filtered by bare-form conditions counts by their meaning', async () => {
    const row = await db.typeZoo
      .where(z => like(z.label, 'prec-%'))
      .select(z => ({
        notExistsVsFlag: agg.count().filter(isDistinctFrom(db.posts.as('p2').where(p => eq(p.views, z.vInteger)).notExists(), z.vBool)),
        flagVsBool: agg.count().filter(eq(z.vBool, flagHasAny(z.vSmallint!, 2))),
        prefix: agg.count().filter(startsWith(z.vText, jsonbSelectText<any>(z.vJsonb, 'p'))),
      }))
      .firstOrDefault();

    expect(row).toEqual({
      notExistsVsFlag: ZOO.filter(r => distinct(!POST_VIEWS.includes(r.vInteger as number), r.vBool)).length,
      flagVsBool: ZOO.filter(r => cmp3(r.vBool, (r.vSmallint & 2) !== 0, (x, y) => x === y) === true).length,
      prefix: ZOO.filter(r => r.vText !== null && at(r.vJsonb, 'p') !== null && r.vText.startsWith(at(r.vJsonb, 'p'))).length,
    });
  });

  test('row guard: a MutationBatch insert guarded by isDistinctFrom(notExists(…), v.vBool) admits by its meaning', async () => {
    await db.typeZoo.where(z => like(z.label, 'guard-%')).delete();
    const candidates = [
      { label: 'guard-1', vInteger: 100, vBool: null },
      { label: 'guard-2', vInteger: 7, vBool: true },
      { label: 'guard-3', vInteger: 150, vBool: false },
    ];

    const batch = new MutationBatch();
    batch.addInsertBulk(db.typeZoo, candidates as any[], 'guarded', {
      rowGuard: v => isDistinctFrom(notExists(db.posts.where(p => eq(p.views, v.vInteger)).select(p => ({ id: p.id })).asSubquery()), v.vBool),
    });
    await batch.executeBatch();

    const inserted = (await db.typeZoo.where(z => like(z.label, 'guard-%')).orderBy(z => z.label).select(z => ({ label: z.label })).toList()).map(r => r.label);
    expect(inserted).toEqual(candidates.filter(c => distinct(!POST_VIEWS.includes(c.vInteger), c.vBool)).map(c => c.label));
  });
});
