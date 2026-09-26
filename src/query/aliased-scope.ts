import { ColumnRow, createColumnRow } from '../entity/column-row';
import type { TableSchema } from '../schema/table-builder';
import {
  and,
  castTo,
  Condition,
  FieldRef,
  getValueMapper,
  isPlainSqlValue,
  SqlBuildContext,
  SqlFragment,
  WhereConditionBase,
} from './conditions';
import { quoteTableReference } from './join-utils';
import { holdsSqlValue, nextChainId } from './query-builder';
import { pgTypeOfValue } from './sql-functions';
import type { SqlOperand } from './sql-functions';
import { Subquery } from './subquery';

/** A plain SQL identifier: what an explicit alias may be (it is rendered double-quoted). */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** UTF-8 length of an identifier — what PostgreSQL's 63-byte identifier limit counts. */
function identifierBytes(identifier: string): number {
  let bytes = 0;

  for (const char of identifier) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }

  return bytes;
}

/**
 * Validates an alias a caller names explicitly (an aliased scope, a set-returning source): a plain
 * identifier of at most 63 bytes. A longer one would be truncated by PostgreSQL and could then equal
 * another alias of the statement. @internal
 */
export function assertExplicitAlias(alias: unknown, usage: string): string {
  if (typeof alias !== 'string' || !PLAIN_IDENTIFIER.test(alias)) {
    throw new Error(
      `${usage}: the alias ${JSON.stringify(alias)} is not a plain identifier — use letters, digits, _ and $, `
      + 'starting with a letter or _'
    );
  }

  if (identifierBytes(alias) > 63) {
    throw new Error(`${usage}: the alias "${alias}" is longer than PostgreSQL's 63-byte identifier limit`);
  }

  return alias;
}

/** One key of an aliased scope's ORDER BY: an operand (a column, an expression) or a condition, and its direction. */
export type AliasedScopeOrderKey = readonly [SqlOperand | Condition, 'ASC' | 'DESC'];

/** One table of an aliased scope: the FROM root, or a join onto it. */
interface ScopeSource {
  readonly table: string;
  readonly schemaName?: string;
  readonly alias: string;
  readonly join?: { readonly kind: 'INNER' | 'LEFT'; readonly on: Condition };
}

/** Everything a scope holds; a scope never changes it after construction (see AliasedScope). */
interface ScopeState {
  readonly sources: readonly ScopeSource[];
  readonly rows: readonly object[];
  readonly predicates: readonly Condition[];
  readonly orderKeys: readonly { readonly key: unknown; readonly direction: 'ASC' | 'DESC' }[];
  readonly limitCount?: number;
}

/** Why `value` cannot be read as an operand of a scope's expression, or `undefined` when it can. */
function describeInvalidOperand(value: unknown): string | undefined {
  if (value === undefined) {
    return 'undefined (a property the row does not have?)';
  }

  if (typeof value === 'function') {
    return 'a function';
  }

  if (Array.isArray(value)) {
    return 'an array';
  }

  // A row, or an object of columns: bound as a value, its column refs would be serialized into it
  if (isPlainSqlValue(value) && holdsSqlValue(value)) {
    return 'an object holding column refs';
  }

  return undefined;
}

/** A value an expression of the scope reads: a column, a fragment, a subquery, a plain value (bound). */
function operandFragment(value: unknown, usage: string): SqlFragment<any> {
  const invalid = describeInvalidOperand(value);

  if (invalid !== undefined) {
    throw new Error(`${usage}: got ${invalid} — return a column of the scope's rows, an SQL expression or a value`);
  }

  if (value instanceof SqlFragment) {
    return value;
  }

  if (value === null) {
    return new SqlFragment(['NULL'], []);
  }

  if (isPlainSqlValue(value)) {
    // A plain value is typed from its JS type: `SELECT $1` alone would leave PostgreSQL to guess
    const pgType = pgTypeOfValue(value);

    if (pgType === undefined) {
      throw new Error(`${usage}: a ${typeof value} cannot be bound as a value`);
    }

    return castTo(value, pgType);
  }

  // A column ref, a condition, a subquery: rendered the way a fragment renders an interpolated value
  return new SqlFragment(['', ''], [value]);
}

/** A column ref — of the scope's rows or of an enclosing query — rather than a fragment, a condition or a subquery. */
function isColumnRef(value: unknown): boolean {
  return value !== null && typeof value === 'object' && '__dbColumnName' in value && !(value instanceof WhereConditionBase);
}

/**
 * `fragment` read as a column of `sqlType` (withReadType). A type name the cast grammar cannot spell
 * (a custom type declared with non-numeric arguments) leaves the read as it was.
 */
function readAsColumnType<T>(fragment: SqlFragment<T>, sqlType: string): SqlFragment<T> {
  try {
    return fragment.withReadType<T>(sqlType);
  } catch {
    return fragment;
  }
}

/** The refs an operand of the scope reads (a condition's, a fragment's, a subquery's outer ones). */
function refsOf(value: unknown): FieldRef[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }

  if (value instanceof WhereConditionBase) {
    return value.getFieldRefs();
  }

  if (value instanceof Subquery) {
    return value.getOuterFieldRefs();
  }

  if ('__dbColumnName' in value) {
    return [value as FieldRef];
  }

  return [];
}

/**
 * The body of a scope's terminal — `SELECT <selection> FROM … [WHERE …] [ORDER BY …] [LIMIT n]` —
 * as the value of a fragment: the fragment renders it in parentheses (`(SELECT …)`, `EXISTS (SELECT …)`)
 * with the enclosing statement's build context, and reports only its outer refs (see
 * {@link AliasedScope}).
 */
class AliasedScopeBody {
  private outerRefsCache?: FieldRef[];

  constructor(
    private readonly state: ScopeState,
    private readonly ownRefs: ReadonlySet<object>,
    /** `undefined` for EXISTS: `SELECT 1` */
    private readonly selection: SqlFragment<any> | undefined,
    private readonly selectionRefs: readonly FieldRef[]
  ) {}

  /** The refs the scope reads from its enclosing statement: every ref inside that is not one of its own rows'. */
  getOuterFieldRefs(): FieldRef[] {
    if (this.outerRefsCache === undefined) {
      const refs: FieldRef[] = [...this.selectionRefs];

      for (const source of this.state.sources) {
        if (source.join) {
          refs.push(...source.join.on.getFieldRefs());
        }
      }

      for (const predicate of this.state.predicates) {
        refs.push(...predicate.getFieldRefs());
      }

      for (const { key } of this.state.orderKeys) {
        refs.push(...refsOf(key));
      }

      const seen = new Set<object>();
      this.outerRefsCache = refs.filter(ref => {
        if (this.ownRefs.has(ref) || seen.has(ref)) {
          return false;
        }

        seen.add(ref);
        return true;
      });
    }

    return this.outerRefsCache;
  }

  buildSql(context: SqlBuildContext): string {
    const aliases = new Set(this.state.sources.map(source => source.alias));

    // A correlation to a row whose alias the scope reuses would read the scope's OWN row inside it:
    // the predicate would compare the row with itself — true for every row, no error anywhere
    for (const ref of this.getOuterFieldRefs()) {
      const alias = (ref as any).__tableAlias;

      if (typeof alias === 'string' && aliases.has(alias)) {
        throw new Error(
          `Aliased scope: the alias "${alias}" is both one of the scope's own aliases and the alias of the column `
          + `"${alias}"."${ref.__dbColumnName}" it correlates to. Inside the scope "${alias}" names the scope's own row, `
          + 'so the correlation would compare that row with itself — give the scope another alias.'
        );
      }
    }

    // Our own columns render as themselves: a substitution of the enclosing statement (a grouped
    // query's keys) is for ITS rows
    const previous = context.substitute;
    if (previous) {
      context.substitute = (value, ctx) => (this.ownRefs.has(value) ? undefined : previous(value, ctx));
    }

    try {
      // Parameters number in textual order: SELECT list, joins' ON, WHERE, ORDER BY
      const selectSql = this.selection ? this.selection.buildSql(context) : '1';
      let sql = `SELECT ${selectSql} FROM `;

      for (const source of this.state.sources) {
        const table = `${quoteTableReference(source.table, source.schemaName)} AS "${source.alias}"`;

        sql += source.join
          ? ` ${source.join.kind} JOIN ${table} ON ${source.join.on.buildSql(context)}`
          : table;
      }

      const predicates = this.state.predicates;

      if (predicates.length > 0) {
        const where = predicates.length === 1 ? predicates[0] : and(...predicates);
        sql += ` WHERE ${where.buildSql(context)}`;
      }

      if (this.state.orderKeys.length > 0) {
        const keys = this.state.orderKeys.map(({ key, direction }) => `${orderKeySql(key, context)} ${direction}`);
        sql += ` ORDER BY ${keys.join(', ')}`;
      }

      if (this.state.limitCount !== undefined) {
        sql += ` LIMIT ${this.state.limitCount}`;
      }

      return sql;
    } finally {
      context.substitute = previous;
    }
  }
}

/** One ORDER BY key: a condition parenthesised, anything else as the operand renders. */
function orderKeySql(key: unknown, context: SqlBuildContext): string {
  if (key instanceof WhereConditionBase && !(key instanceof SqlFragment)) {
    return `(${key.buildSql(context)})`;
  }

  return operandFragment(key, 'Aliased scope orderBy()').buildSql(context);
}

/**
 * A correlated subquery over tables under EXPLICIT aliases: `db.<table>.as('a')`, optionally joined to
 * more tables (`.innerJoin(db.<other>.as('b'), (a, b) => …)`), filtered, ordered and limited, and
 * turned into ONE expression — a scalar `(SELECT … LIMIT n)`, `EXISTS (…)` or `(NOT EXISTS (…))` —
 * usable wherever a fragment is: a projection, a WHERE, a CASE, an UPDATE, a row guard, a CTE body,
 * inside a LATERAL collection, inside another scope.
 *
 * - The rows are column-only ({@link ColumnRow}): `"a"."col"`; a navigation throws.
 * - Anything else the callbacks read is an OUTER ref: it renders as it always does (a lateral item
 *   under its lateral alias, a column of an UPDATE under its table) and is reported by the fragment's
 *   `getFieldRefs()`, so the enclosing query joins the navigations it needs. The scope's own aliases
 *   never leak out.
 * - The alias of an outer ref may not be one of the scope's aliases (it would read the scope's own
 *   row): building such a scope throws.
 * - Every method returns a NEW scope — one scope can feed two probes, or both legs of an `or()`.
 *
 * @example
 * // Does any other post of the same author have more views? (a same-table correlation)
 * db.posts.select(p => ({
 *   title: p.title,
 *   outranked: db.posts.as('rival')
 *     .where(r => and(eq(r.userId, p.userId), gt(r.views, p.views)))
 *     .exists(),
 * }))
 */
export class AliasedScope<TRows extends readonly unknown[]> {
  private constructor(private readonly state: ScopeState) {}

  /** @internal — `DbEntityTable.as(alias)` */
  static forTable<TEntity>(schema: TableSchema, alias: string): AliasedScope<[ColumnRow<TEntity>]> {
    assertExplicitAlias(alias, `${schema.name}.as()`);

    // Its refs carry a chain identity of their own: an entity query nested in the scope reads them as
    // correlations — resolved by alias NAME, `user` was that query's own `user` navigation, which it
    // joined and compared with itself
    const row = createColumnRow<TEntity>(schema, alias, `Aliased scope "${alias}"`, nextChainId());

    return new AliasedScope<[ColumnRow<TEntity>]>({
      sources: [{ table: schema.name, schemaName: schema.schema, alias }],
      rows: [row],
      predicates: [],
      orderKeys: [],
    });
  }

  /** The row of the scope's FROM table: its columns, qualified by the scope's alias. */
  get row(): TRows[0] {
    return this.state.rows[0] as TRows[0];
  }

  /**
   * `INNER JOIN "<table>" AS "<alias>" ON <on>` — `source` is a bare table scope (`db.<table>.as(alias)`),
   * its alias unused in this scope; `on` receives every row so far plus the joined one.
   */
  innerJoin<TRow>(
    source: AliasedScope<[TRow]>,
    on: (...rows: [...TRows, TRow]) => Condition
  ): AliasedScope<[...TRows, TRow]> {
    return this.join('INNER', source, on);
  }

  /** `LEFT JOIN "<table>" AS "<alias>" ON <on>` — see {@link innerJoin}. The joined row's columns are NULL without a match. */
  leftJoin<TRow>(
    source: AliasedScope<[TRow]>,
    on: (...rows: [...TRows, TRow]) => Condition
  ): AliasedScope<[...TRows, TRow]> {
    return this.join('LEFT', source, on);
  }

  /** Add a WHERE predicate over the scope's rows; repeated calls combine with AND. */
  where(predicate: (...rows: TRows) => Condition): AliasedScope<TRows> {
    const condition = predicate(...(this.state.rows as unknown as TRows));
    assertCondition('Aliased scope where()', condition);

    return new AliasedScope<TRows>({ ...this.state, predicates: [...this.state.predicates, condition] });
  }

  /**
   * The ORDER BY: `[key, 'ASC' | 'DESC']` pairs over the scope's rows — a column, an expression, or a
   * condition (rendered parenthesised: `("a"."x" = $1) DESC`). Replaces a previous orderBy().
   */
  orderBy(keys: (...rows: TRows) => ReadonlyArray<AliasedScopeOrderKey>): AliasedScope<TRows> {
    const result = keys(...(this.state.rows as unknown as TRows));

    if (!Array.isArray(result)) {
      throw new Error("Aliased scope orderBy(): return an array of [key, 'ASC' | 'DESC'] pairs");
    }

    const orderKeys = result.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`Aliased scope orderBy(): entry ${index} is not a [key, 'ASC' | 'DESC'] pair`);
      }

      const [key, direction] = pair;

      if (direction !== 'ASC' && direction !== 'DESC') {
        throw new Error(`Aliased scope orderBy(): entry ${index} has the direction ${JSON.stringify(direction)} — use 'ASC' or 'DESC'`);
      }

      if (isPlainSqlValue(key)) {
        throw new Error(
          `Aliased scope orderBy(): entry ${index} is the constant ${JSON.stringify(key) ?? String(key)} — `
          + 'a key is a column of the scope\'s rows, an SQL expression or a condition'
        );
      }

      return { key, direction: direction as 'ASC' | 'DESC' };
    });

    return new AliasedScope<TRows>({ ...this.state, orderKeys });
  }

  /** `LIMIT n` — an inline non-negative integer. */
  limit(count: number): AliasedScope<TRows> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Aliased scope limit(): expected a non-negative integer, got ${String(count)}`);
    }

    return new AliasedScope<TRows>({ ...this.state, limitCount: count });
  }

  /**
   * The scope as ONE value: `(SELECT <selection> FROM … [WHERE …] [ORDER BY …] [LIMIT n])` — NULL when
   * no row qualifies (an aggregate over no rows gives its own value: `count(*)` 0).
   *
   * It reads back the way the selection reads: through its mapper (a column's custom type, a helper's
   * driver-value read); a column without a mapper as a column of its SQL type (a text column's
   * `'0042'` stays text); a mapper-less expression like any other (a numeric string becomes a number,
   * NULL reads as `undefined` at the top level). Chain `.mapWith()` / `.withReadType()` to read it
   * otherwise.
   */
  scalar<T>(selection: (...rows: TRows) => SqlOperand<T>): SqlFragment<T> {
    const value = selection(...(this.state.rows as unknown as TRows));
    const fragment = operandFragment(value, 'Aliased scope scalar()');
    const body = new AliasedScopeBody(this.state, this.ownRefs(), fragment, refsOf(value));
    // A column's own mapper (the wrapper fragment has none); a plain value reads as its typed bind does
    const mapper = isPlainSqlValue(value) ? getValueMapper(fragment) : getValueMapper(value);
    const scalar = new SqlFragment<T>(['', ''], [body], mapper);

    // A column without a mapper reads as a column of its type — through the generic read, a text
    // column's digits came back as a number
    const columnType = !mapper && isColumnRef(value) ? (value as any).__sqlType : undefined;

    return typeof columnType === 'string' ? readAsColumnType(scalar, columnType) : scalar;
  }

  /** `EXISTS (SELECT 1 FROM … [WHERE …])` — a boolean, never NULL; it carries no mapper. */
  exists(): SqlFragment<boolean> {
    return new SqlFragment<boolean>(['EXISTS ', ''], [new AliasedScopeBody(this.state, this.ownRefs(), undefined, [])]);
  }

  /**
   * `(NOT EXISTS (SELECT 1 FROM … [WHERE …]))` — a boolean, never NULL; it carries no mapper. Parenthesised
   * as a whole: a bare prefix NOT composed under IS / a comparison / IN / BETWEEN negated all of it
   * (`isDistinctFrom(scope.notExists(), flag)` read `NOT (EXISTS (…) IS DISTINCT FROM flag)`).
   */
  notExists(): SqlFragment<boolean> {
    return new SqlFragment<boolean>(['(NOT EXISTS ', ')'], [new AliasedScopeBody(this.state, this.ownRefs(), undefined, [])]);
  }

  /** The column refs of the scope's own rows — by identity: a row hands out the same ref on every access. */
  private ownRefs(): Set<object> {
    const refs = new Set<object>();

    for (const row of this.state.rows) {
      for (const ref of Object.values(row)) {
        refs.add(ref as object);
      }
    }

    return refs;
  }

  private join<TRow>(
    kind: 'INNER' | 'LEFT',
    source: AliasedScope<[TRow]>,
    on: (...rows: [...TRows, TRow]) => Condition
  ): AliasedScope<[...TRows, TRow]> {
    const method = kind === 'INNER' ? 'innerJoin' : 'leftJoin';

    if (!(source instanceof AliasedScope)) {
      throw new Error(`Aliased scope ${method}(): join a table scope — db.<table>.as('<alias>')`);
    }

    const joined = source.state;

    if (joined.sources.length !== 1 || joined.predicates.length > 0 || joined.orderKeys.length > 0 || joined.limitCount !== undefined) {
      throw new Error(
        `Aliased scope ${method}(): the joined scope must be a bare table scope (db.<table>.as('<alias>')) — `
        + 'write its filters in the ON predicate or in where()'
      );
    }

    const alias = joined.sources[0].alias;

    if (this.state.sources.some(existing => existing.alias === alias)) {
      throw new Error(`Aliased scope ${method}(): the alias "${alias}" is already used in this scope`);
    }

    const rows = [...this.state.rows, joined.rows[0]] as unknown as [...TRows, TRow];
    const condition = on(...rows);
    assertCondition(`Aliased scope ${method}()`, condition);

    return new AliasedScope<[...TRows, TRow]>({
      ...this.state,
      sources: [...this.state.sources, { ...joined.sources[0], join: { kind, on: condition } }],
      rows: rows as unknown as readonly object[],
    });
  }
}

function assertCondition(usage: string, condition: unknown): asserts condition is Condition {
  if (!(condition instanceof WhereConditionBase)) {
    throw new Error(`${usage}: expected a condition (eq(), and(), exists(), a boolean sql fragment, …)`);
  }
}
