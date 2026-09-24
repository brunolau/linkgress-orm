import type { DbColumn } from '../entity/db-column';
import { toPgArrayLiteral } from '../types/custom-types';
import {
  applyToDriverMapper,
  castTo,
  Condition,
  DRIVER_VALUE_MAPPER,
  FieldLike,
  FieldRef,
  getValueMapper,
  isPlainSqlValue,
  numericTypeName,
  PgCastType,
  pickResultMapper,
  Placeholder,
  quoteSqlLiteral,
  SqlBuildContext,
  SqlFragment,
  varcharTypeName,
  WhereConditionBase,
} from './conditions';

/**
 * SQL expression helpers — the built-in spelling of the expressions that otherwise end up
 * hand-written in `sql` templates: casts, literals, CASE, GREATEST/LEAST/NULLIF,
 * IS DISTINCT FROM, string, math and date/time functions, JSONB paths and mutations, and
 * array-column operators.
 *
 * Every helper returns a `SqlFragment` (or, for predicates, a fragment usable as a
 * Condition), so helpers nest inside each other, inside `sql` templates, in `select`,
 * `where`, `orderBy`, UPDATE assignments and upsert values. Column refs inside them keep
 * their navigation information, so JOIN detection sees through any depth of nesting.
 *
 * ## Plain JS values
 * A plain JS value (string, number, boolean, bigint, Date, object) is always sent as a bind
 * parameter — never inlined — except through {@link literal}. Where PostgreSQL cannot infer
 * the parameter's type from context (every branch of a CASE is a literal, the VARIADIC
 * `concat` / `jsonb_build_object`, a function argument) the helper types it from its JS type:
 *
 * | JS value | PostgreSQL type |
 * |---|---|
 * | boolean | `boolean` |
 * | integer in int4 range | `integer` |
 * | other safe integer / bigint | `bigint` |
 * | other number | `double precision` |
 * | string | `text` |
 * | Date | `timestamptz` |
 * | plain object / array | `jsonb` (serialized with `JSON.stringify`) |
 *
 * Where a column or expression already fixes the type (a CASE with one column branch, the
 * right-hand side of IS DISTINCT FROM), literals stay untyped and PostgreSQL resolves them
 * against it — the same way `eq(col, value)` binds.
 */

// ============================================================================
// Shared types and value handling
// ============================================================================

/** Anything an expression helper accepts as an operand: a column, a fragment or a plain value. */
export type SqlOperand<V = any> = FieldLike<V> | DbColumn<V> | SqlFragment<V> | V;

/** The value type an operand carries: fragment and column types unwrap, conditions are boolean. */
export type OperandValue<T> = T extends SqlFragment<infer V>
  ? V
  : T extends DbColumn<infer V>
    ? V
    : T extends WhereConditionBase
      ? boolean
      : T extends FieldRef<any, infer V>
        ? V
        : T;

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

/** SQL NULL, untyped — PostgreSQL resolves it against the other operands. */
const NULL_SQL = new SqlFragment<null>(['NULL'], []);

/** Reads numeric and bigint results (which the drivers return as strings) back as JS numbers. */
const NUMBER_RESULT_MAPPER = {
  fromDriver: (value: unknown) => (value == null ? value : Number(value)),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The PostgreSQL type a plain JS value binds as when nothing else fixes it (see the table in
 * the module docs), or `undefined` for values that should stay untyped.
 */
export function pgTypeOfValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      if (Number.isInteger(value)) {
        if (value >= INT4_MIN && value <= INT4_MAX) {
          return 'integer';
        }
        return Number.isSafeInteger(value) ? 'bigint' : 'double precision';
      }
      return 'double precision';
    case 'bigint':
      return 'bigint';
    case 'string':
      return 'text';
    case 'object':
      if (value instanceof Date) {
        return 'timestamptz';
      }
      if (Array.isArray(value) || isPlainObject(value)) {
        return 'jsonb';
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * A plain value typed from its JS type (`CAST($1 AS integer)`), SQL NULL for null/undefined;
 * anything else (columns, fragments, conditions) passes through.
 */
function typedOperand(value: unknown): unknown {
  if (!isPlainSqlValue(value)) {
    return value;
  }

  if (value === null || value === undefined) {
    return NULL_SQL;
  }

  const pgType = pgTypeOfValue(value);
  return pgType ? castTo(value, pgType) : value;
}

/**
 * Prepare a set of operands that PostgreSQL unifies into ONE result type (CASE results,
 * GREATEST/LEAST, NULLIF, COALESCE-like lists):
 * - the first mapper found on a column/fragment operand becomes the result mapper, and its
 *   `toDriver` is applied to the plain values (as `coalesce` does);
 * - when every operand is a plain value, each is typed from its JS type — otherwise
 *   PostgreSQL would resolve the whole expression as text;
 * - when any operand is an expression, plain values stay untyped and PostgreSQL resolves
 *   them against it.
 */
function unifiedOperands(values: readonly unknown[]): { operands: unknown[]; mapper?: any } {
  const mapper = pickResultMapper(values) ?? DRIVER_VALUE_MAPPER;
  const allPlain = values.every(isPlainSqlValue);

  const operands = values.map((value) => {
    if (!isPlainSqlValue(value)) {
      return value;
    }

    if (value === null || value === undefined) {
      return NULL_SQL;
    }

    const driverValue = mapper ? applyToDriverMapper(value, mapper) : value;
    return allPlain ? typedOperand(driverValue) : driverValue;
  });

  return { operands, mapper };
}

/** `name(arg1, arg2, …)` with every plain argument typed from its JS type. */
function callFunction<T>(name: string, args: readonly unknown[], mapper: any = DRIVER_VALUE_MAPPER): SqlFragment<T> {
  const parts: string[] = [`${name}(`];
  for (let i = 1; i < args.length; i++) {
    parts.push(', ');
  }
  parts.push(')');

  return new SqlFragment<T>(parts, args.map(typedOperand), mapper);
}

/** `name()` with no arguments, or a bare keyword such as CURRENT_DATE. */
function sqlKeyword<T>(text: string): SqlFragment<T> {
  return new SqlFragment<T>([text], []);
}

/** A column's declared SQL type, when the ref carries it (schema-aware mock rows do). */
function declaredSqlType(column: unknown): string | undefined {
  const sqlType = (column as { __sqlType?: unknown } | null | undefined)?.__sqlType;
  return typeof sqlType === 'string' && sqlType !== 'array' ? sqlType : undefined;
}

function requireOperand(name: string, value: unknown): void {
  if (value === undefined) {
    throw new Error(`${name}: the operand is undefined — pass a column, a fragment or a value`);
  }
}

// ============================================================================
// Casts
// ============================================================================

/**
 * `CAST(value AS pgType)`.
 *
 * A column or fragment is cast as an expression; a plain value becomes ONE typed bind
 * parameter (`CAST($1 AS bigint)`); `null` becomes a typed NULL. The type name is validated
 * (it is inlined into the SQL). Fragments also offer the same as a method: `.cast('integer')`.
 *
 * @example
 * db.events.select(e => ({ day: cast<string>(e.startsAt, 'date') }))
 * db.orders.where(o => gt(cast(jsonbPathText(o.payload, 'qty'), 'integer'), 5))
 * cast(42, 'bigint')                    // CAST($1 AS bigint), params [42]
 */
export function cast<T = unknown>(value: SqlOperand, pgType: PgCastType): SqlFragment<T> {
  return castTo<T>(value, pgType);
}

/** `CAST(value AS integer)` — read back as a JS number. */
export function castAsInt(value: SqlOperand): SqlFragment<number> {
  return castTo<number>(value, 'integer');
}

/** `CAST(value AS smallint)` — read back as a JS number. */
export function castAsSmallInt(value: SqlOperand): SqlFragment<number> {
  return castTo<number>(value, 'smallint');
}

/**
 * `CAST(value AS bigint)`. The drivers return int8 as a STRING (a JS number cannot hold every
 * int8) — chain `.mapWith(Number)` or `.mapWith(BigInt)` to convert.
 */
export function castAsBigInt(value: SqlOperand): SqlFragment<string> {
  return castTo<string>(value, 'bigint');
}

/**
 * `CAST(value AS numeric)` / `numeric(p)` / `numeric(p, s)`, read back as a JS number. For
 * the exact decimal text, use `cast<string>(value, 'numeric')` (the drivers return numeric
 * as a string).
 */
export function castAsNumeric(value: SqlOperand, precision?: number, scale?: number): SqlFragment<number> {
  return castTo<string>(value, numericTypeName(precision, scale)).mapWith<number>(Number);
}

/** `CAST(value AS double precision)` — read back as a JS number. */
export function castAsDouble(value: SqlOperand): SqlFragment<number> {
  return castTo<number>(value, 'double precision');
}

/** `CAST(value AS text)`. */
export function castAsString(value: SqlOperand): SqlFragment<string> {
  return castTo<string>(value, 'text');
}

/** `CAST(value AS varchar)` / `varchar(n)`. */
export function castAsVarchar(value: SqlOperand, length?: number): SqlFragment<string> {
  return castTo<string>(value, varcharTypeName(length));
}

/** `CAST(value AS boolean)`. */
export function castAsBoolean(value: SqlOperand): SqlFragment<boolean> {
  return castTo<boolean>(value, 'boolean');
}

/** `CAST(value AS date)`. */
export function castAsDate(value: SqlOperand): SqlFragment<Date> {
  return castTo<Date>(value, 'date');
}

/** `CAST(value AS timestamp)` — without time zone. */
export function castAsTimestamp(value: SqlOperand): SqlFragment<Date> {
  return castTo<Date>(value, 'timestamp');
}

/** `CAST(value AS timestamptz)`. */
export function castAsTimestamptz(value: SqlOperand): SqlFragment<Date> {
  return castTo<Date>(value, 'timestamptz');
}

/**
 * `CAST(value AS jsonb)` — a plain JS object/array is serialized with JSON.stringify, a string is JSON
 * text; JSON text binds as `text` (`CAST(CAST($1 AS text) AS jsonb)`), the same on every driver.
 */
export function castAsJsonb<T = unknown>(value: SqlOperand): SqlFragment<T> {
  return castTo<T>(value, 'jsonb');
}

/**
 * `CAST(value AS json)` — a plain JS object/array is serialized with JSON.stringify, a string is JSON
 * text; JSON text binds as `text` (`CAST(CAST($1 AS text) AS json)`), the same on every driver.
 */
export function castAsJson<T = unknown>(value: SqlOperand): SqlFragment<T> {
  return castTo<T>(value, 'json');
}

/** `CAST(value AS uuid)`. */
export function castAsUuid(value: SqlOperand): SqlFragment<string> {
  return castTo<string>(value, 'uuid');
}

// ============================================================================
// Literals, typed NULLs and conditions as values
// ============================================================================

/** Render a JS primitive as inline SQL literal text. */
function renderInlineLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    case 'number': {
      if (!Number.isFinite(value)) {
        // NaN / ±Infinity are only representable as quoted float8 input
        return `'${String(value)}'`;
      }
      const text = String(value);
      return value < 0 || Object.is(value, -0) ? `(${text})` : text;
    }
    case 'bigint':
      return value < 0n ? `(${String(value)})` : String(value);
    case 'string':
      return quoteSqlLiteral(value);
    default:
      throw new TypeError(
        `literal() inlines strings, numbers, bigints, booleans and null only — got ${
          value instanceof Date ? 'a Date' : typeof value
        }. Bind other values as parameters (e.g. cast(value, 'timestamptz')).`
      );
  }
}

/**
 * An INLINE SQL literal: `'text'`, `42`, `(-5)`, `TRUE`, `NULL` — optionally cast
 * (`CAST('x' AS text)`).
 *
 * Unlike every other helper, the value becomes part of the statement TEXT instead of a bind
 * parameter. Use it where that matters: a constant a partial or expression index predicate
 * must match literally, a discriminator column in UNION legs (`'product'`), a value that
 * must not change the statement's parameter list. Strings are quoted safely
 * ({@link quoteSqlLiteral}); only primitives are accepted.
 *
 * @example
 * db.books.select(b => ({ kind: literal('book'), id: b.id }))
 *   .unionAll(db.films.select(f => ({ kind: literal('film'), id: f.id })))
 */
export function literal<T extends LiteralValue>(
  value: T,
  pgType?: PgCastType
): SqlFragment<WidenLiteral<T>> {
  const text = renderInlineLiteral(value);
  // A decimal constant is numeric in PostgreSQL (the driver returns its text): read numbers
  // back as JS numbers, as the TypeScript type says. bigint keeps its exact text.
  const mapper = typeof value === 'number' ? NUMBER_RESULT_MAPPER : DRIVER_VALUE_MAPPER;

  if (pgType === undefined) {
    return new SqlFragment<WidenLiteral<T>>([text], [], mapper);
  }

  return castTo<WidenLiteral<T>>(new SqlFragment([text], []), pgType).mapWith(mapper);
}

/** The values {@link literal} can inline. */
export type LiteralValue = string | number | bigint | boolean | null;

/** The widened type of a literal: `'shelf'` → string, `42` → number, bigint → its exact text. */
export type WidenLiteral<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends bigint
      ? string
      : T extends boolean
        ? boolean
        : null;

/**
 * A typed SQL NULL: `CAST(NULL AS pgType)`.
 *
 * The filler for a column one UNION ALL leg does not have: a bare JS `null` would bind as an
 * untyped parameter, and a bare `NULL` leaves PostgreSQL to guess the column type.
 *
 * @example
 * db.books.select(b => ({ id: b.id, isbn: b.isbn }))
 *   .unionAll(db.films.select(f => ({ id: f.id, isbn: typedNull<string>('text') })))
 */
export function typedNull<T = unknown>(pgType: PgCastType): SqlFragment<T> {
  // Typed as the column it stands in for (the value is always NULL), so UNION legs line up
  return castTo<T>(null, pgType);
}

/**
 * A condition as a boolean VALUE — for a `select` projection, a CASE result, a function
 * argument. The condition's column refs stay visible to JOIN detection.
 *
 * @example
 * db.members.select(m => ({ name: m.name, isAdult: asBoolean(gte(m.age, 18)) }))
 */
export function asBoolean(condition: Condition): SqlFragment<boolean> {
  if (!(condition instanceof WhereConditionBase)) {
    throw new TypeError('asBoolean() expects a condition (eq(), and(), exists(), a boolean sql fragment, …)');
  }

  return condition instanceof SqlFragment
    ? new SqlFragment<boolean>(['(', ')'], [condition])
    : new SqlFragment<boolean>(['', ''], [condition]);
}

/**
 * Selection normalizer behind the query builders: every condition value that is not already a
 * fragment becomes a boolean fragment ({@link asBoolean}), recursing into plain object literals —
 * so a condition projects directly: `select(m => ({ isAdult: gte(m.age, 18) }))`.
 *
 * Returns the SAME object when nothing needed replacing, so every other selection is untouched.
 * Objects built with accessors (mock rows, whole navigation rows), class instances (builders,
 * Dates, fragments), arrays and column refs pass through as they are.
 * @internal
 */
export function projectConditionValues<T>(selection: T): T {
  return projectConditionValue(selection, 0) as T;
}

function projectConditionValue(value: unknown, depth: number): unknown {
  if (value instanceof WhereConditionBase) {
    return value instanceof SqlFragment ? value : asBoolean(value);
  }

  if (!isPlainObject(value) || depth > 16 || '__dbColumnName' in value || '__collectionResult' in value) {
    return value;
  }

  let copy: Record<string, unknown> | undefined;

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;

    if (!('value' in descriptor)) {
      // Accessor-built (a mock row): never materialize or copy it
      return copy ?? value;
    }

    const projected = projectConditionValue(descriptor.value, depth + 1);

    if (projected !== descriptor.value) {
      copy ??= { ...value };
      copy[key] = projected;
    }
  }

  return copy ?? value;
}

/**
 * Wrap a selector so its result goes through {@link projectConditionValues}; idempotent.
 * @internal
 */
export function selectorProjectingConditions<F extends (...args: any[]) => any>(selector: F): F {
  if (typeof selector !== 'function' || (selector as any).__projectsConditions) {
    return selector;
  }

  const wrapped = ((...args: any[]) => projectConditionValues(selector(...args))) as F;
  (wrapped as any).__projectsConditions = true;
  return wrapped;
}

// ============================================================================
// CASE
// ============================================================================

interface CaseBranch {
  readonly when: unknown;
  readonly then: unknown;
}

/**
 * A condition rendered WITHOUT the parentheses a fragment puts around an interpolated
 * condition — for positions that delimit it anyway (`WHEN … THEN`). AND/OR groups keep their
 * own parentheses. Refs pass through for JOIN detection.
 */
class BareCondition extends SqlFragment<boolean> {
  constructor(private readonly condition: WhereConditionBase) {
    super([], []);
  }

  override buildSql(context: SqlBuildContext): string {
    return this.condition.buildSql(context);
  }

  override getFieldRefs(): FieldRef[] {
    return this.condition.getFieldRefs();
  }
}

function bareCondition(condition: unknown): unknown {
  return condition instanceof WhereConditionBase && !(condition instanceof SqlFragment)
    ? new BareCondition(condition)
    : condition;
}

function assertCondition(name: string, condition: unknown): void {
  if (!(condition instanceof WhereConditionBase)) {
    throw new TypeError(`${name}: WHEN expects a condition (eq(), and(), a boolean sql fragment, …)`);
  }
}

/** Compile `CASE [subject] WHEN … THEN … [ELSE …] END` into fragment parts. */
function compileCase(
  subject: { value: unknown } | undefined,
  branches: readonly CaseBranch[],
  elseValue: { value: unknown } | undefined
): { parts: string[]; values: unknown[]; mapper?: any } {
  if (branches.length === 0) {
    throw new Error('A CASE expression needs at least one WHEN branch');
  }

  const results = branches.map(branch => branch.then);
  if (elseValue) {
    results.push(elseValue.value);
  }

  const { operands, mapper } = unifiedOperands(results);
  const parts: string[] = [];
  const values: unknown[] = [];

  let head = 'CASE ';
  if (subject) {
    parts.push(head);
    values.push(subject.value);
    head = ' ';
  }

  // Simple CASE: plain match values bind with the subject's mapper, untyped (PostgreSQL
  // resolves them against the subject, like eq()).
  const subjectMapper = subject ? getValueMapper(subject.value) : undefined;

  branches.forEach((branch, index) => {
    parts.push(`${index === 0 ? head : ' '}WHEN `);
    const when = subject
      ? (isPlainSqlValue(branch.when)
        ? (branch.when === null || branch.when === undefined ? NULL_SQL : applyToDriverMapper(branch.when, subjectMapper))
        : branch.when)
      : bareCondition(branch.when);
    values.push(when);
    parts.push(' THEN ');
    values.push(operands[index]);
  });

  if (elseValue) {
    parts.push(' ELSE ');
    values.push(operands[operands.length - 1]);
  }

  // One part precedes every value, plus the tail — the shape SqlFragment expects
  parts.push(' END');

  return { parts, values, mapper };
}

/**
 * A searched CASE expression under construction: `CASE WHEN … THEN … END`. It already IS a
 * fragment (implicit `ELSE NULL`); `.when()` adds a branch, `.else()` closes it.
 */
export class CaseWhenExpression<T> extends SqlFragment<T> {
  private readonly caseBranches: readonly CaseBranch[];

  constructor(branches: readonly CaseBranch[]) {
    const compiled = compileCase(undefined, branches, undefined);
    super(compiled.parts, compiled.values, compiled.mapper);
    this.caseBranches = branches;
  }

  /** Add a `WHEN condition THEN value` branch (branches are tested in order). */
  when<U>(condition: Condition, then: U): CaseWhenExpression<T | OperandValue<U>> {
    assertCondition('caseWhen().when()', condition);
    return new CaseWhenExpression<T | OperandValue<U>>([...this.caseBranches, { when: condition, then }]);
  }

  /** Close the expression with `ELSE value`. */
  else<U>(value: U): SqlFragment<T | OperandValue<U>> {
    const compiled = compileCase(undefined, this.caseBranches, { value });
    return new SqlFragment<T | OperandValue<U>>(compiled.parts, compiled.values, compiled.mapper);
  }
}

/**
 * Searched CASE: `CASE WHEN condition THEN value [WHEN …] [ELSE …] END`.
 *
 * Branches are tested in order and PostgreSQL evaluates CASE lazily, so a branch can guard a
 * later one (division by zero, a cast that would fail). Without `.else()` the result is
 * NULL when no branch matches.
 *
 * Results unify into one type: a column or expression branch fixes it (plain values are
 * then resolved against it, and a column's type mapper applies to the result); when every
 * result is a plain value, each is typed from its JS type so `1` / `0` come back as numbers,
 * not text.
 *
 * @example
 * db.loans.select(l => ({
 *   state: caseWhen(isNotNull(l.returnedAt), 'returned')
 *     .when(lt(l.dueAt, today), 'overdue')
 *     .else('open'),
 * }))
 *
 * @example
 * // Conditional counter in an UPDATE — one statement, no read
 * db.books.where(b => eq(b.id, id)).update(b => ({
 *   copies: caseWhen(gt(b.copies, 0), sub(b.copies, 1)).else(0),
 * }))
 */
export function caseWhen<T>(condition: Condition, then: T): CaseWhenExpression<OperandValue<T>> {
  assertCondition('caseWhen()', condition);
  return new CaseWhenExpression<OperandValue<T>>([{ when: condition, then }]);
}

/**
 * A simple CASE expression under construction: `CASE subject WHEN match THEN value … END`.
 */
export class CaseOfExpression<V, T> extends SqlFragment<T> {
  private readonly caseSubject: unknown;
  private readonly caseBranches: readonly CaseBranch[];

  constructor(subject: unknown, branches: readonly CaseBranch[]) {
    const compiled = compileCase({ value: subject }, branches, undefined);
    super(compiled.parts, compiled.values, compiled.mapper);
    this.caseSubject = subject;
    this.caseBranches = branches;
  }

  /** Add a `WHEN match THEN value` branch. */
  when<U>(match: SqlOperand<V>, then: U): CaseOfExpression<V, T | OperandValue<U>> {
    return new CaseOfExpression<V, T | OperandValue<U>>(this.caseSubject, [...this.caseBranches, { when: match, then }]);
  }

  /** Close the expression with `ELSE value`. */
  else<U>(value: U): SqlFragment<T | OperandValue<U>> {
    const compiled = compileCase({ value: this.caseSubject }, this.caseBranches, { value });
    return new SqlFragment<T | OperandValue<U>>(compiled.parts, compiled.values, compiled.mapper);
  }
}

/** The subject of a simple CASE, waiting for its first `.when()`. */
export class CaseOfBuilder<V> {
  constructor(private readonly subject: unknown) {}

  /** Add the first `WHEN match THEN value` branch. */
  when<U>(match: SqlOperand<V>, then: U): CaseOfExpression<V, OperandValue<U>> {
    return new CaseOfExpression<V, OperandValue<U>>(this.subject, [{ when: match, then }]);
  }
}

/**
 * Simple CASE: `CASE subject WHEN match THEN value [WHEN …] [ELSE …] END` — the subject is
 * compared with `=`, so a NULL subject matches no branch.
 *
 * Match values bind like `eq()` (the subject's mapper applies); results unify like
 * {@link caseWhen}.
 *
 * @example
 * db.books.select(b => ({
 *   format: caseOf(b.formatCode).when(1, 'hardcover').when(2, 'paperback').else('other'),
 * }))
 */
export function caseOf<V>(subject: SqlOperand<V>): CaseOfBuilder<OperandValue<V>> {
  requireOperand('caseOf()', subject);
  return new CaseOfBuilder<OperandValue<V>>(subject);
}

// ============================================================================
// GREATEST / LEAST / NULLIF / IS DISTINCT FROM
// ============================================================================

function variadicFunction<T>(name: string, values: readonly unknown[]): SqlFragment<T> {
  // greatest(a) arrives as [a, undefined]
  if (values.length < 2 || (values.length === 2 && values[1] === undefined)) {
    throw new Error(`${name} needs at least two operands`);
  }

  const { operands, mapper } = unifiedOperands(values);
  const parts: string[] = [`${name}(`];
  for (let i = 1; i < operands.length; i++) {
    parts.push(', ');
  }
  parts.push(')');

  return new SqlFragment<T>(parts, operands, mapper);
}

/**
 * `GREATEST(a, b, …)` — the largest operand; NULL operands are ignored (the result is NULL
 * only when every operand is NULL).
 *
 * @example
 * // A closing stamp that can never fall before the opening one
 * db.periods.where(p => eq(p.id, id)).update(p => ({ closedAt: greatest(p.openedAt, now) }))
 */
export function greatest<T1, T2, TRest extends any[]>(
  value1: T1,
  value2: T2,
  ...rest: TRest
): SqlFragment<OperandValue<T1> | OperandValue<T2>> {
  return variadicFunction('GREATEST', [value1, value2, ...rest]);
}

/**
 * `LEAST(a, b, …)` — the smallest operand; NULL operands are ignored.
 *
 * @example
 * // Clamp a balance to its limit
 * db.cards.select(c => ({ usable: least(c.balance, c.limit) }))
 */
export function least<T1, T2, TRest extends any[]>(
  value1: T1,
  value2: T2,
  ...rest: TRest
): SqlFragment<OperandValue<T1> | OperandValue<T2>> {
  return variadicFunction('LEAST', [value1, value2, ...rest]);
}

/**
 * `NULLIF(value, other)` — NULL when the two are equal, else `value`.
 *
 * @example
 * db.members.select(m => ({ nickname: nullIf(m.nickname, '') }))
 */
export function nullIf<T>(value: T, other: SqlOperand): SqlFragment<OperandValue<T> | null> {
  requireOperand('nullIf()', value);
  const { operands, mapper } = unifiedOperands([value, other]);
  return new SqlFragment<OperandValue<T> | null>(['NULLIF(', ', ', ')'], operands, mapper);
}

function distinctFrom(operator: string, left: unknown, right: unknown): SqlFragment<boolean> {
  requireOperand(operator, left);
  const { operands } = unifiedOperands([left, right === undefined ? null : right]);
  return new SqlFragment<boolean>(['(', ` ${operator} `, ')'], operands);
}

/**
 * `a IS DISTINCT FROM b` — NULL-safe "not equal": two NULLs are NOT distinct, NULL and a
 * value are. Usable as a condition and as a boolean value.
 *
 * @example
 * // Rows whose value actually changes (NULL → value counts, NULL → NULL does not)
 * db.books.where(b => isDistinctFrom(b.subtitle, newSubtitle))
 */
export function isDistinctFrom<V>(left: SqlOperand<V>, right: SqlOperand<V> | null): SqlFragment<boolean> {
  return distinctFrom('IS DISTINCT FROM', left, right);
}

/** `a IS NOT DISTINCT FROM b` — NULL-safe equality: two NULLs are equal. */
export function isNotDistinctFrom<V>(left: SqlOperand<V>, right: SqlOperand<V> | null): SqlFragment<boolean> {
  return distinctFrom('IS NOT DISTINCT FROM', left, right);
}

// ============================================================================
// String functions
// ============================================================================

/** `lower(value)`. */
export function lower(value: SqlOperand<string | null | undefined>): SqlFragment<string> {
  requireOperand('lower()', value);
  return callFunction('lower', [value]);
}

/** `upper(value)`. */
export function upper(value: SqlOperand<string | null | undefined>): SqlFragment<string> {
  requireOperand('upper()', value);
  return callFunction('upper', [value]);
}

/** `btrim(value)` — or `btrim(value, characters)` to strip a set of characters instead of spaces. */
export function trim(value: SqlOperand<string | null | undefined>, characters?: SqlOperand<string>): SqlFragment<string> {
  requireOperand('trim()', value);
  return callFunction('btrim', characters === undefined ? [value] : [value, characters]);
}

/** `ltrim(value[, characters])`. */
export function trimStart(value: SqlOperand<string | null | undefined>, characters?: SqlOperand<string>): SqlFragment<string> {
  requireOperand('trimStart()', value);
  return callFunction('ltrim', characters === undefined ? [value] : [value, characters]);
}

/** `rtrim(value[, characters])`. */
export function trimEnd(value: SqlOperand<string | null | undefined>, characters?: SqlOperand<string>): SqlFragment<string> {
  requireOperand('trimEnd()', value);
  return callFunction('rtrim', characters === undefined ? [value] : [value, characters]);
}

/** `char_length(value)` — the number of characters (not bytes). */
export function length(value: SqlOperand<string | null | undefined>): SqlFragment<number> {
  requireOperand('length()', value);
  return callFunction('char_length', [value]);
}

/**
 * `concat(a, b, …)` — text concatenation that treats NULL as the empty string (unlike `||`,
 * which turns the whole result NULL).
 */
export function concat(...values: SqlOperand[]): SqlFragment<string> {
  if (values.length === 0) {
    throw new Error('concat() needs at least one operand');
  }
  return callFunction('concat', values);
}

/**
 * `concat_ws(separator, a, b, …)` — joins the non-NULL operands with the separator.
 *
 * @example
 * db.members.select(m => ({ fullName: concatWs(' ', m.firstName, m.lastName) }))
 */
export function concatWs(separator: SqlOperand<string>, ...values: SqlOperand[]): SqlFragment<string> {
  if (values.length === 0) {
    throw new Error('concatWs() needs at least one operand after the separator');
  }
  return callFunction('concat_ws', [separator, ...values]);
}

/** `substring(value, start[, count])` — 1-based start, like PostgreSQL. */
export function substring(
  value: SqlOperand<string | null | undefined>,
  start: SqlOperand<number>,
  count?: SqlOperand<number>
): SqlFragment<string> {
  requireOperand('substring()', value);
  return callFunction('substring', count === undefined ? [value, start] : [value, start, count]);
}

/** `replace(value, from, to)` — replaces every occurrence of `from`. */
export function replace(
  value: SqlOperand<string | null | undefined>,
  from: SqlOperand<string>,
  to: SqlOperand<string>
): SqlFragment<string> {
  requireOperand('replace()', value);
  return callFunction('replace', [value, from, to]);
}

/**
 * `regexp_replace(value, pattern, replacement[, flags])` — POSIX regex replacement; pass
 * `'g'` in flags to replace every match.
 *
 * To match an expression index written with a literal pattern, pass the pattern through
 * {@link literal} so it is inlined instead of bound.
 */
export function regexpReplace(
  value: SqlOperand<string | null | undefined>,
  pattern: SqlOperand<string>,
  replacement: SqlOperand<string>,
  flags?: SqlOperand<string>
): SqlFragment<string> {
  requireOperand('regexpReplace()', value);
  return callFunction('regexp_replace', flags === undefined ? [value, pattern, replacement] : [value, pattern, replacement, flags]);
}

// ============================================================================
// Math functions
// ============================================================================

/**
 * `round(value)` — or `round(value, digits)`, which works on numeric (the value is cast to
 * numeric first, since PostgreSQL has no `round(double precision, integer)`).
 * The result is read back as a JS number.
 */
export function round(value: SqlOperand<number | null | undefined>, digits?: SqlOperand<number>): SqlFragment<number> {
  requireOperand('round()', value);

  if (digits === undefined) {
    return callFunction('round', [value], NUMBER_RESULT_MAPPER);
  }

  return callFunction('round', [castTo(value, 'numeric'), digits], NUMBER_RESULT_MAPPER);
}

/** `floor(value)` — read back as a JS number. */
export function floor(value: SqlOperand<number | null | undefined>): SqlFragment<number> {
  requireOperand('floor()', value);
  return callFunction('floor', [value], NUMBER_RESULT_MAPPER);
}

/** `ceil(value)` — read back as a JS number. */
export function ceil(value: SqlOperand<number | null | undefined>): SqlFragment<number> {
  requireOperand('ceil()', value);
  return callFunction('ceil', [value], NUMBER_RESULT_MAPPER);
}

/** `abs(value)` — read back as a JS number. */
export function abs(value: SqlOperand<number | null | undefined>): SqlFragment<number> {
  requireOperand('abs()', value);
  return callFunction('abs', [value], NUMBER_RESULT_MAPPER);
}

/** `mod(dividend, divisor)` — the remainder, with the sign of the dividend. Read back as a JS number. */
export function mod(dividend: SqlOperand<number | null | undefined>, divisor: SqlOperand<number>): SqlFragment<number> {
  requireOperand('mod()', dividend);
  // No mapper crossing here: the divisor is not a value of the dividend's domain.
  const allPlain = isPlainSqlValue(dividend) && isPlainSqlValue(divisor);
  const operands = [dividend, divisor].map(value => (allPlain ? typedOperand(value) : value));
  return new SqlFragment<number>(['mod(', ', ', ')'], operands, NUMBER_RESULT_MAPPER);
}

// ============================================================================
// Date / time
// ============================================================================

/** Units `date_trunc` accepts. */
export type DateTruncUnit =
  | 'microseconds' | 'milliseconds' | 'second' | 'minute' | 'hour' | 'day' | 'week'
  | 'month' | 'quarter' | 'year' | 'decade' | 'century' | 'millennium';

const DATE_TRUNC_UNITS: ReadonlySet<string> = new Set<DateTruncUnit>([
  'microseconds', 'milliseconds', 'second', 'minute', 'hour', 'day', 'week',
  'month', 'quarter', 'year', 'decade', 'century', 'millennium',
]);

/** Fields `EXTRACT` accepts. */
export type DatePartField =
  | 'century' | 'day' | 'decade' | 'dow' | 'doy' | 'epoch' | 'hour' | 'isodow' | 'isoyear'
  | 'julian' | 'microseconds' | 'millennium' | 'milliseconds' | 'minute' | 'month'
  | 'quarter' | 'second' | 'timezone' | 'timezone_hour' | 'timezone_minute' | 'week' | 'year';

const DATE_PART_FIELDS: ReadonlySet<string> = new Set<DatePartField>([
  'century', 'day', 'decade', 'dow', 'doy', 'epoch', 'hour', 'isodow', 'isoyear',
  'julian', 'microseconds', 'millennium', 'milliseconds', 'minute', 'month',
  'quarter', 'second', 'timezone', 'timezone_hour', 'timezone_minute', 'week', 'year',
]);

/** `CURRENT_TIMESTAMP` — the transaction's start time, timestamptz. */
export function currentTimestamp(): SqlFragment<Date> {
  return sqlKeyword<Date>('CURRENT_TIMESTAMP');
}

/** `LOCALTIMESTAMP` — the transaction's start time in the session time zone, timestamp without time zone. */
export function localTimestamp(): SqlFragment<Date> {
  return sqlKeyword<Date>('LOCALTIMESTAMP');
}

/** `CURRENT_DATE` — today in the session time zone. */
export function currentDate(): SqlFragment<Date> {
  return sqlKeyword<Date>('CURRENT_DATE');
}

/**
 * `(now() AT TIME ZONE 'UTC')` — the transaction's start time as a UTC timestamp WITHOUT
 * time zone: the value to compare with or store in `timestamp` columns that hold UTC.
 */
export function utcTimestamp(): SqlFragment<Date> {
  return sqlKeyword<Date>("(now() AT TIME ZONE 'UTC')");
}

/**
 * A date/time operand: a JS Date binds as timestamptz; a plain string stays untyped so
 * PostgreSQL parses it as the date/time type the function needs; columns and expressions
 * pass through.
 */
function dateTimeOperand(value: unknown): unknown {
  if (value instanceof Date) {
    return castTo(value, 'timestamptz');
  }

  if (typeof value === 'string') {
    return value;
  }

  return typedOperand(value);
}

/** A time zone operand: a plain name binds as text; a column/expression is cast to text (enum-safe). */
function timeZoneOperand(zone: unknown): SqlFragment<string> {
  requireOperand('time zone', zone);
  return castTo<string>(zone, 'text');
}

/**
 * `(value AT TIME ZONE zone)`.
 *
 * - timestamptz → the local wall-clock time in `zone` (timestamp without time zone);
 * - timestamp → interpreted AS local time in `zone`, giving a timestamptz.
 *
 * The zone is an IANA name (`'Europe/Vienna'`) or a column/expression holding one; a column
 * is cast to text, so enum-typed zone columns work too.
 *
 * @example
 * // A UTC timestamp column, as wall-clock time in each branch's zone
 * db.visits.select(v => ({ local: atTimeZone(atTimeZone(v.startedAtUtc, 'UTC'), v.branch.timeZone) }))
 */
export function atTimeZone(value: SqlOperand, zone: SqlOperand<string>): SqlFragment<Date> {
  requireOperand('atTimeZone()', value);
  return new SqlFragment<Date>(['(', ' AT TIME ZONE ', ')'], [dateTimeOperand(value), timeZoneOperand(zone)], DRIVER_VALUE_MAPPER);
}

/**
 * `date_trunc('unit', value[, zone])` — truncate to the start of the unit. The optional zone
 * (timestamptz values) truncates in that zone's local time.
 */
export function dateTrunc(unit: DateTruncUnit, value: SqlOperand, zone?: SqlOperand<string>): SqlFragment<Date> {
  if (!DATE_TRUNC_UNITS.has(unit)) {
    throw new Error(`dateTrunc: unknown unit ${JSON.stringify(unit)}`);
  }
  requireOperand('dateTrunc()', value);

  return zone === undefined
    ? new SqlFragment<Date>([`date_trunc('${unit}', `, ')'], [dateTimeOperand(value)], DRIVER_VALUE_MAPPER)
    : new SqlFragment<Date>([`date_trunc('${unit}', `, ', ', ')'], [dateTimeOperand(value), timeZoneOperand(zone)], DRIVER_VALUE_MAPPER);
}

/**
 * `EXTRACT(field FROM value)` — read back as a JS number (PostgreSQL returns numeric).
 *
 * @example
 * db.loans.where(l => eq(datePart('isodow', l.dueAt), 7))   // due on a Sunday
 */
export function datePart(field: DatePartField, value: SqlOperand): SqlFragment<number> {
  if (!DATE_PART_FIELDS.has(field)) {
    throw new Error(`datePart: unknown field ${JSON.stringify(field)}`);
  }
  requireOperand('datePart()', value);

  return new SqlFragment<number>([`EXTRACT(${field.toUpperCase()} FROM `, ')'], [dateTimeOperand(value)], NUMBER_RESULT_MAPPER);
}

/**
 * `to_char(value, format)` — format a date/time or number with a PostgreSQL template
 * (`'YYYY-MM-DD"T"HH24:MI:SS'`).
 */
export function toChar(value: SqlOperand, format: SqlOperand<string>): SqlFragment<string> {
  requireOperand('toChar()', value);
  return new SqlFragment<string>(['to_char(', ', ', ')'], [dateTimeOperand(value), castTo(format, 'text')], DRIVER_VALUE_MAPPER);
}

/** An interval as text (`'1 day 2 hours'`) or as parts. */
export type IntervalSpec =
  | string
  | {
      years?: number;
      months?: number;
      weeks?: number;
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
      milliseconds?: number;
    };

const INTERVAL_PARTS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const;

function intervalText(spec: Exclude<IntervalSpec, string>): string {
  const pieces: string[] = [];

  for (const part of INTERVAL_PARTS) {
    const amount = spec[part];
    if (amount === undefined) {
      continue;
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error(`interval: ${part} must be a finite number, got ${String(amount)}`);
    }
    pieces.push(`${amount} ${part}`);
  }

  if (pieces.length === 0) {
    throw new Error('interval: the spec has no parts');
  }

  return pieces.join(' ');
}

/**
 * An interval value: `CAST($1 AS interval)` from text (`'90 minutes'`) or parts
 * (`{ days: 1, hours: 2 }`), bound as one parameter; a fragment is cast as an expression.
 */
export function toInterval(spec: IntervalSpec | SqlFragment<any>): SqlFragment<string> {
  if (spec instanceof SqlFragment) {
    return castTo<string>(spec, 'interval');
  }

  if (typeof spec === 'string') {
    if (!spec.trim()) {
      throw new Error('toInterval: empty interval text');
    }
    return castTo<string>(spec, 'interval');
  }

  if (!spec || typeof spec !== 'object') {
    throw new TypeError('toInterval: expects interval text, interval parts or a fragment');
  }

  return castTo<string>(intervalText(spec), 'interval');
}

/** `(value + interval)`. */
export function addInterval<T = Date>(value: SqlOperand, spec: IntervalSpec | SqlFragment<any>): SqlFragment<T> {
  requireOperand('addInterval()', value);
  return new SqlFragment<T>(['(', ' + ', ')'], [dateTimeOperand(value), toInterval(spec)], DRIVER_VALUE_MAPPER);
}

/** `(value - interval)`. */
export function subInterval<T = Date>(value: SqlOperand, spec: IntervalSpec | SqlFragment<any>): SqlFragment<T> {
  requireOperand('subInterval()', value);
  return new SqlFragment<T>(['(', ' - ', ')'], [dateTimeOperand(value), toInterval(spec)], DRIVER_VALUE_MAPPER);
}

// ============================================================================
// JSONB
// ============================================================================

/** A JSON path step: an object key (quoted inline), an array index, or a bound key fragment. */
export type JsonbPathKey = string | number | SqlFragment<any> | Placeholder<any>;

function renderPathKey(fnName: string, key: JsonbPathKey): { text?: string; value?: unknown } {
  if (typeof key === 'string') {
    return { text: quoteSqlLiteral(key) };
  }

  if (typeof key === 'number') {
    if (!Number.isSafeInteger(key)) {
      throw new Error(`${fnName}: an array index must be an integer, got ${key}`);
    }
    return { text: key < 0 ? `(${key})` : String(key) };
  }

  if (key instanceof SqlFragment || key instanceof Placeholder) {
    return { value: key };
  }

  throw new TypeError(`${fnName}: a path key must be a string, an integer index or a fragment`);
}

function jsonbPathFragment<T>(fnName: string, target: unknown, keys: readonly JsonbPathKey[], asText: boolean): SqlFragment<T> {
  requireOperand(fnName, target);

  if (keys.length === 0) {
    throw new Error(`${fnName} needs at least one key`);
  }

  // parts[i] precedes values[i]; the last part is the running tail that inline keys extend
  const parts: string[] = ['', ''];
  const values: unknown[] = [target];

  keys.forEach((key, index) => {
    const operator = asText && index === keys.length - 1 ? '->>' : '->';
    const rendered = renderPathKey(fnName, key);

    if (rendered.text !== undefined) {
      parts[parts.length - 1] += `${operator}${rendered.text}`;
    } else {
      parts[parts.length - 1] += operator;
      values.push(rendered.value);
      parts.push('');
    }
  });

  return new SqlFragment<T>(parts, values, DRIVER_VALUE_MAPPER);
}

/**
 * A plain JSON path: `target->'a'->'b'` (jsonb result).
 *
 * Unlike `jsonbSelect`, there is no `#>> '{}'` text round trip: the column is read as the
 * jsonb it is. String keys are inlined as quoted literals, integers are array indexes, and a
 * fragment (`sql\`${key}\``) binds a key as a parameter — one statement text for every key.
 *
 * @example
 * db.shelves.select(s => ({ firstTag: jsonbPath(s.meta, 'tags', 0) }))
 */
export function jsonbPath<T = unknown>(target: SqlOperand, ...keys: JsonbPathKey[]): SqlFragment<T> {
  return jsonbPathFragment<T>('jsonbPath()', target, keys, false);
}

/**
 * A plain JSON path read as text: `target->'a'->>'b'`.
 *
 * @example
 * db.orders.where(o => eq(jsonbPathText(o.payload, 'shipping', 'country'), 'AT'))
 * db.orders.select(o => ({ qty: jsonbPathText(o.payload, 'qty').castAsInt() }))
 */
export function jsonbPathText(target: SqlOperand, ...keys: JsonbPathKey[]): SqlFragment<string> {
  return jsonbPathFragment<string>('jsonbPathText()', target, keys, true);
}

/** A jsonb operand: a plain JS value serialized and cast to jsonb, an expression as is. */
function jsonbOperand(value: unknown): unknown {
  if (!isPlainSqlValue(value)) {
    return value;
  }

  if (value === undefined) {
    throw new Error('A jsonb value is undefined — pass null for JSON null');
  }

  return castTo(JSON.stringify(value), 'jsonb');
}

function textArrayOperand(fnName: string, path: readonly (string | number)[]): SqlFragment<string[]> {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error(`${fnName}: the path must be a non-empty array of keys`);
  }

  return castTo<string[]>(toPgArrayLiteral(path.map(step => String(step))), 'text[]');
}

/**
 * `jsonb_set(target, path, value, createMissing)` — replace (or add) the value at `path`.
 *
 * A plain JS value is serialized to JSON (`'x'` sets the JSON string "x"); an expression
 * must already be jsonb (wrap others in {@link toJsonb}). A NULL target stays NULL, as in
 * PostgreSQL — `coalesce(col, literal('{}', 'jsonb'))` starts from an empty object.
 *
 * @example
 * db.books.where(b => eq(b.id, id)).update(b => ({ meta: jsonbSet(b.meta, ['shelf', 'row'], 3) }))
 */
export function jsonbSet<T = unknown>(
  target: SqlOperand,
  path: readonly (string | number)[],
  value: unknown,
  options?: { createMissing?: boolean }
): SqlFragment<T> {
  requireOperand('jsonbSet()', target);
  const createMissing = options?.createMissing ?? true;

  return new SqlFragment<T>(
    ['jsonb_set(', ', ', ', ', `, ${createMissing ? 'true' : 'false'})`],
    [target, textArrayOperand('jsonbSet()', path), jsonbOperand(value)],
    DRIVER_VALUE_MAPPER
  );
}

/** `(target - key)` / `(target - keys[])` — remove top-level keys. */
export function jsonbRemoveKey<T = unknown>(target: SqlOperand, ...keys: string[]): SqlFragment<T> {
  requireOperand('jsonbRemoveKey()', target);

  if (keys.length === 0) {
    throw new Error('jsonbRemoveKey() needs at least one key');
  }

  const keyOperand = keys.length === 1
    ? castTo(keys[0], 'text')
    : castTo(toPgArrayLiteral(keys), 'text[]');

  return new SqlFragment<T>(['(', ' - ', ')'], [target, keyOperand], DRIVER_VALUE_MAPPER);
}

/** `(target #- path)` — remove the value at a nested path. */
export function jsonbRemovePath<T = unknown>(target: SqlOperand, path: readonly (string | number)[]): SqlFragment<T> {
  requireOperand('jsonbRemovePath()', target);
  return new SqlFragment<T>(['(', ' #- ', ')'], [target, textArrayOperand('jsonbRemovePath()', path)], DRIVER_VALUE_MAPPER);
}

/**
 * `(target @> value)` — jsonb containment; served by a GIN index on the column.
 *
 * @example
 * db.shelves.where(s => jsonbContains(s.meta, { genre: 'poetry' }))
 */
export function jsonbContains(target: SqlOperand, value: unknown): SqlFragment<boolean> {
  requireOperand('jsonbContains()', target);
  return new SqlFragment<boolean>(['(', ' @> ', ')'], [target, jsonbOperand(value)]);
}

/** `(target <@ value)` — `target` is contained in `value`. */
export function jsonbContainedBy(target: SqlOperand, value: unknown): SqlFragment<boolean> {
  requireOperand('jsonbContainedBy()', target);
  return new SqlFragment<boolean>(['(', ' <@ ', ')'], [target, jsonbOperand(value)]);
}

/** `(target ? key)` — the top-level key (or array string element) exists; GIN-indexable. */
export function jsonbHasKey(target: SqlOperand, key: SqlOperand<string>): SqlFragment<boolean> {
  requireOperand('jsonbHasKey()', target);
  return new SqlFragment<boolean>(['(', ' ? ', ')'], [target, castTo(key, 'text')]);
}

/** `(target ?| keys)` — any of the keys exists. */
export function jsonbHasAnyKey(target: SqlOperand, keys: readonly string[]): SqlFragment<boolean> {
  requireOperand('jsonbHasAnyKey()', target);
  return new SqlFragment<boolean>(['(', ' ?| ', ')'], [target, castTo(toPgArrayLiteral(keys), 'text[]')]);
}

/** `(target ?& keys)` — every key exists. */
export function jsonbHasAllKeys(target: SqlOperand, keys: readonly string[]): SqlFragment<boolean> {
  requireOperand('jsonbHasAllKeys()', target);
  return new SqlFragment<boolean>(['(', ' ?& ', ')'], [target, castTo(toPgArrayLiteral(keys), 'text[]')]);
}

/**
 * `jsonb_array_length(target)`. PostgreSQL raises for a non-array value (object, scalar);
 * guard with `caseWhen(eq(jsonbTypeOf(x), 'array'), jsonbArrayLength(x))` when the column
 * can hold other shapes.
 */
export function jsonbArrayLength(target: SqlOperand): SqlFragment<number> {
  requireOperand('jsonbArrayLength()', target);
  return new SqlFragment<number>(['jsonb_array_length(', ')'], [target], DRIVER_VALUE_MAPPER);
}

/** `jsonb_typeof(target)` — `'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'`. */
export function jsonbTypeOf(target: SqlOperand): SqlFragment<'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'> {
  requireOperand('jsonbTypeOf()', target);
  return new SqlFragment(['jsonb_typeof(', ')'], [target], DRIVER_VALUE_MAPPER);
}

/** A value inside jsonb_build_object / jsonb_build_array: nested plain objects and arrays recurse. */
function jsonbBuildOperand(value: unknown): unknown {
  // Columns (FieldRefs are plain objects too), fragments and conditions first
  if (!isPlainSqlValue(value)) {
    return value instanceof WhereConditionBase && !(value instanceof SqlFragment)
      ? asBoolean(value)
      : value;
  }

  if (Array.isArray(value)) {
    return jsonbBuildArray(...value);
  }

  if (isPlainObject(value)) {
    return jsonbBuildObject(value);
  }

  return typedOperand(value);
}

/**
 * `jsonb_build_object('key', value, …)` from an object literal. Keys are inlined as quoted
 * literals; values may be columns, fragments, conditions or plain values, and nested plain
 * objects / arrays become nested jsonb_build_object / jsonb_build_array calls — so column
 * refs anywhere in the tree stay live.
 *
 * @example
 * db.loans.select(l => ({ summary: jsonbBuildObject({ id: l.id, member: { name: l.member.name } }) }))
 */
export function jsonbBuildObject<T = Record<string, unknown>>(entries: Record<string, unknown>): SqlFragment<T> {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new TypeError('jsonbBuildObject() expects an object of key → value');
  }

  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return new SqlFragment<T>(['jsonb_build_object()'], [], DRIVER_VALUE_MAPPER);
  }

  const parts: string[] = [];
  const values: unknown[] = [];
  keys.forEach((key, index) => {
    parts.push(`${index === 0 ? 'jsonb_build_object(' : ', '}${quoteSqlLiteral(key)}, `);
    values.push(jsonbBuildOperand(entries[key]));
  });
  parts.push(')');

  return new SqlFragment<T>(parts, values, DRIVER_VALUE_MAPPER);
}

/** `jsonb_build_array(a, b, …)` — values as in {@link jsonbBuildObject}. */
export function jsonbBuildArray<T = unknown[]>(...values: unknown[]): SqlFragment<T> {
  if (values.length === 0) {
    return new SqlFragment<T>(['jsonb_build_array()'], [], DRIVER_VALUE_MAPPER);
  }

  const parts: string[] = ['jsonb_build_array('];
  for (let i = 1; i < values.length; i++) {
    parts.push(', ');
  }
  parts.push(')');

  return new SqlFragment<T>(parts, values.map(jsonbBuildOperand), DRIVER_VALUE_MAPPER);
}

/** `to_jsonb(value)` — any SQL value as jsonb. */
export function toJsonb<T = unknown>(value: SqlOperand): SqlFragment<T> {
  requireOperand('toJsonb()', value);
  return callFunction<T>('to_jsonb', [value]);
}

/**
 * `jsonb_path_exists(target, path[, vars[, silent]])` — an SQL/JSON path predicate.
 *
 * `vars` is serialized to jsonb and referenced from the path as `$name`; `silent: true`
 * suppresses the structural errors (missing keys, type mismatches) a `strict` path raises.
 *
 * @example
 * db.events.where(e => jsonbPathExists(e.slots, '$[*] ? (@.from <= $day && @.to >= $day)', { vars: { day } }))
 */
export function jsonbPathExists(
  target: SqlOperand,
  path: string,
  options?: { vars?: Record<string, unknown>; silent?: boolean }
): SqlFragment<boolean> {
  requireOperand('jsonbPathExists()', target);

  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('jsonbPathExists(): the path must be a non-empty SQL/JSON path string');
  }

  const pathOperand = castTo(path, 'jsonpath');

  if (options?.vars === undefined && options?.silent === undefined) {
    return new SqlFragment<boolean>(['jsonb_path_exists(', ', ', ')'], [target, pathOperand]);
  }

  const vars = jsonbOperand(options?.vars ?? {});
  return new SqlFragment<boolean>(
    ['jsonb_path_exists(', ', ', ', ', `, ${options?.silent ? 'true' : 'false'})`],
    [target, pathOperand, vars]
  );
}

// ============================================================================
// Array columns
// ============================================================================

/**
 * The bound form of a JS array against an array column: one parameter holding a PostgreSQL
 * array literal, cast to the column's declared array type when the ref carries it.
 */
function arrayOperand(column: unknown, values: unknown): unknown {
  if (!isPlainSqlValue(values)) {
    return values;
  }

  if (!Array.isArray(values)) {
    throw new TypeError('Expected a JS array of values');
  }

  const literalText = toPgArrayLiteral(values as readonly unknown[]);
  const arrayType = declaredSqlType(column);

  return arrayType && arrayType.endsWith(']')
    ? castTo(literalText, arrayType)
    : literalText;
}

/** `(value = ANY(arrayColumn))` — the array contains the value. */
export function arrayContains<V>(column: SqlOperand<V[] | null | undefined>, value: SqlOperand<V>): SqlFragment<boolean> {
  requireOperand('arrayContains()', column);

  const arrayType = declaredSqlType(column);
  const elementType = arrayType && arrayType.endsWith('[]') ? arrayType.slice(0, -2) : undefined;
  const element = isPlainSqlValue(value) && value !== null && value !== undefined && elementType
    ? castTo(value, elementType)
    : (value === null || value === undefined ? NULL_SQL : value);

  return new SqlFragment<boolean>(['(', ' = ANY(', '))'], [element, column]);
}

/** `(arrayColumn @> values)` — the array contains every value. */
export function arrayContainsAll<V>(column: SqlOperand<V[] | null | undefined>, values: readonly V[] | SqlFragment<V[]>): SqlFragment<boolean> {
  requireOperand('arrayContainsAll()', column);
  return new SqlFragment<boolean>(['(', ' @> ', ')'], [column, arrayOperand(column, values)]);
}

/** `(arrayColumn && values)` — the array shares at least one value with the list. */
export function arrayOverlaps<V>(column: SqlOperand<V[] | null | undefined>, values: readonly V[] | SqlFragment<V[]>): SqlFragment<boolean> {
  requireOperand('arrayOverlaps()', column);
  return new SqlFragment<boolean>(['(', ' && ', ')'], [column, arrayOperand(column, values)]);
}

/** `(arrayColumn <@ values)` — every element of the array is in the list. */
export function arrayContainedBy<V>(column: SqlOperand<V[] | null | undefined>, values: readonly V[] | SqlFragment<V[]>): SqlFragment<boolean> {
  requireOperand('arrayContainedBy()', column);
  return new SqlFragment<boolean>(['(', ' <@ ', ')'], [column, arrayOperand(column, values)]);
}

/** `cardinality(arrayColumn)` — the element count (0 for an empty array, NULL for NULL). */
export function arrayLength(column: SqlOperand<unknown[] | null | undefined>): SqlFragment<number> {
  requireOperand('arrayLength()', column);
  return new SqlFragment<number>(['cardinality(', ')'], [column], DRIVER_VALUE_MAPPER);
}

/** `(cardinality(arrayColumn) = 0)` — an empty array. A NULL array is NOT empty (the predicate is NULL). */
export function arrayIsEmpty(column: SqlOperand<unknown[] | null | undefined>): SqlFragment<boolean> {
  requireOperand('arrayIsEmpty()', column);
  return new SqlFragment<boolean>(['(cardinality(', ') = 0)'], [column]);
}

/** `(cardinality(arrayColumn) > 0)` — a non-empty array. */
export function arrayIsNotEmpty(column: SqlOperand<unknown[] | null | undefined>): SqlFragment<boolean> {
  requireOperand('arrayIsNotEmpty()', column);
  return new SqlFragment<boolean>(['(cardinality(', ') > 0)'], [column]);
}
