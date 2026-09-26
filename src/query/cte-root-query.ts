import type { DatabaseClient } from '../database/database-client.interface';
import { QueryExecutor } from '../entity/db-context';
import type { OrderDirection } from '../entity/db-context';
import {
  and,
  Condition,
  FieldRef,
  SqlBuildContext,
  SqlFragment,
  UnwrapSelection,
  WhereConditionBase,
  sql,
} from './conditions';
import { assertExplicitAlias } from './aliased-scope';
import { assertStatementLevelCtes, cteBodyAt, DbCte, declareStatementCtes, isStatementCte, stampChainId } from './cte-builder';
import {
  BIGINT_LITERAL_READ,
  aggregatedItemReads,
  assertProjectionArrayOfValues,
  coercesNumericText,
  fromDriverMapper,
  holdsSqlValue,
  isScalarLiteralSelection,
  mapAggregatedItems,
  nextChainId,
  projectionLiteralSql,
} from './query-builder';
import { parseOrderBy } from './query-utils';
import { Subquery } from './subquery';
import { projectedValueRoot, selectorProjectingConditions } from './sql-functions';
import { renderProjectedFragment } from './set-returning';

/**
 * Join types supported when a CTE is the FROM root.
 *
 * Unlike the entity-anchored {@link JoinQueryBuilder} (which only models
 * `INNER`/`LEFT`), a CTE-rooted query can express the full set of SQL join
 * flavours — including `FULL OUTER` and `CROSS` — because both sides are
 * already materialized, independent relations (the CTE bodies). This is what
 * makes a `spend FULL OUTER JOIN current_tier ON TRUE` shape expressible.
 */
export type CteJoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL OUTER' | 'CROSS';

/**
 * The value type a single-column projection carries.
 *
 * `'scalar'` and `'array'` subqueries must return exactly ONE column — `x IN
 * (SELECT ...)` and `x = (SELECT ...)` are not row-comparisons here — so their
 * result type is that column's type, not the projection object's. This is what
 * lets `.select(r => ({ id: r.id })).asSubquery('array')` satisfy
 * `inSubquery(field, Subquery<number[], 'array'>)` without a cast.
 */
export type SingleColumnValue<TSelection> = TSelection extends Record<string, any>
  ? TSelection[keyof TSelection]
  : TSelection;

/**
 * A CTE's row as a condition reads it: one column ref per column, typed by the column's value — what
 * {@link CteRootQueryBuilder.where} hands its predicate (a projection reads the columns as values).
 */
export type CteColumnRefs<TColumns> = {
  readonly [K in keyof TColumns]-?: FieldRef<K & string, TColumns[K]>;
};

/** SQL keyword emitted for each {@link CteJoinType}. */
const CTE_JOIN_SQL: Record<CteJoinType, string> = {
  INNER: 'INNER JOIN',
  LEFT: 'LEFT JOIN',
  RIGHT: 'RIGHT JOIN',
  'FULL OUTER': 'FULL OUTER JOIN',
  CROSS: 'CROSS JOIN',
};

/**
 * A constant `TRUE` join predicate, for cross-product joins written as
 * `… JOIN … ON TRUE`. Equivalent to a `CROSS JOIN` but keeps the `ON`
 * keyword, which Postgres requires for `FULL OUTER JOIN` (a bare
 * `FULL OUTER JOIN` with no `ON`/`USING` is a syntax error).
 *
 * @example
 * cteBuilder
 *   .selectFromCte(spendCte)
 *   .fullOuterJoin(currentTierCte, onTrue(), (s, t) => ({ ... }))
 */
export function onTrue(): Condition {
  return sql<boolean>`TRUE`;
}

/**
 * Build a mock row that yields {@link FieldRef}s for a CTE's columns, qualified
 * with `alias` (the CTE's own name unless the query aliases its root). The same refs
 * `SelectQueryBuilder.createMockRowForCte` mints (`DbCte.columnRef`), so each
 * carries how its column reads: the body column's own mapper, a json_agg
 * column's item metadata, a literal's type (see projectedColumnRef) — and the
 * query's chain identity: a query nested in it tells its correlations from its
 * own rows by it, not by alias name.
 */
function createCteFieldRefProxy<TColumns extends Record<string, any>>(cte: DbCte<TColumns>, alias: string, chainId: number): TColumns {
  return new Proxy({} as any, {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') {
        return undefined;
      }

      return stampChainId(cte.columnRef(prop, alias), chainId);
    },
    has() {
      return true;
    },
    ownKeys() {
      return cte.columnDefs ? Object.keys(cte.columnDefs as object) : [];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  }) as TColumns;
}

const NUMERIC_REGEX = /^-?\d+(\.\d+)?$/;

/** The column a selector returning ONE value (`r => r.id`, `() => 'x'`) is projected under. */
const SCALAR_COLUMN = 'value';

/** @internal {@link SCALAR_COLUMN}, for the set-returning source (set-returning.ts) that reads projections the same way. */
export const SCALAR_SELECTION_COLUMN = SCALAR_COLUMN;

/**
 * Whether a selector returned ONE value — a column, an expression, a subquery, a literal — rather
 * than an object of fields. It reads as that value: its keys (`__fieldName`, …) used to be
 * projected as the fields of an object, a string as its characters.
 * @internal
 */
export function isSingleValueSelection(selection: unknown): boolean {
  return isScalarLiteralSelection(selection)
    || selection instanceof SqlFragment
    || selection instanceof Subquery
    || (typeof selection === 'object' && selection !== null && '__dbColumnName' in selection);
}

/** A plain nested projection object — flattened under path aliases, rebuilt by {@link transformRows}. */
function isNestedProjection(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype
    && !('__dbColumnName' in value)
    && !('__isAggregationArray' in value);
}

/**
 * A single joined CTE step (the right-hand relation + how it is attached).
 */
interface CteJoinStep {
  type: CteJoinType;
  cte: DbCte<any>;
  /** ON predicate. Always undefined for `CROSS` joins. */
  condition?: Condition;
}

/**
 * A query whose FROM root is a {@link DbCte} (rather than an entity table),
 * joined to one or more further CTEs with any SQL join flavour.
 *
 * This complements the entity-anchored `db.<table>.with(...).leftJoin(cte, …)`
 * path: there the FROM root must be a real table and joins are `INNER`/`LEFT`
 * only. Here the FROM root is itself a CTE and `FULL OUTER` / `RIGHT` / `CROSS`
 * joins (and `ON TRUE` predicates) are available — exactly what a
 * `WITH a AS (…), b AS (…) SELECT … FROM a FULL OUTER JOIN b ON TRUE` shape
 * needs.
 *
 * Parameter ordering: every CTE body's parameters are emitted first, in `WITH`
 * declaration order (root CTE, then each joined CTE), followed by any `ON`
 * predicate parameters — so the whole statement keeps a single, sequential
 * `$1..$n` numbering, matching how the entity-rooted CTE path orders params.
 *
 * @typeParam TRootColumns - the column shape of the root CTE
 * @typeParam TSelection - the projected output row shape (after `.select(...)`)
 */
export class CteRootQueryBuilder<TRootColumns extends Record<string, any>, TSelection = TRootColumns> {
  private joinSteps: CteJoinStep[] = [];
  private selector?: (...sources: any[]) => any;
  private orderByFields: Array<{ table: string; field: string; direction: OrderDirection }> = [];
  private limitValue?: number;
  private offsetValue?: number;
  private lockClause?: string;
  /** The where() conditions, combined with AND. */
  protected whereConds: Condition[] = [];
  /** `FROM "<cte>" AS "<rootAlias>"` — see `DbContext.selectFromCte(cte, alias)`; the CTE's name when undefined. */
  protected rootAlias?: string;
  /** @internal The query's chain identity, stamped on the rows it hands out (see createCteFieldRefProxy). */
  protected chainId: number;

  constructor(
    protected rootCte: DbCte<TRootColumns>,
    protected client: DatabaseClient,
    protected executor?: QueryExecutor,
    rootAlias?: string,
    chainId?: number
  ) {
    this.rootAlias = rootAlias === undefined ? undefined : assertExplicitAlias(rootAlias, 'selectFromCte()');
    this.chainId = chainId ?? nextChainId();
  }

  /** The alias the root CTE's row renders under. */
  protected get rootName(): string {
    return this.rootAlias ?? this.rootCte.name;
  }

  /** Override the per-query timeout (ms). Pass `0` to disable. */
  withTimeout(timeoutMs: number): this {
    this.executor = this.executor
      ? this.executor.withTimeout(timeoutMs)
      : new QueryExecutor(this.client, undefined, timeoutMs);
    return this;
  }

  /** Flag this query as expected to finish within `expectedMs` (ms). */
  expectedExecutionTime(expectedMs: number): this {
    this.executor = this.executor
      ? this.executor.withExpectedExecutionTime(expectedMs)
      : new QueryExecutor(this.client, undefined, undefined, expectedMs);
    return this;
  }

  /**
   * `INNER JOIN` another CTE.
   */
  innerJoin<TRight extends Record<string, any>>(
    cte: DbCte<TRight>,
    condition: Condition
  ): CteJoinedQueryBuilder<TRootColumns, TRight> {
    return this.addJoin('INNER', cte, condition);
  }

  /**
   * `LEFT JOIN` another CTE.
   */
  leftJoin<TRight extends Record<string, any>>(
    cte: DbCte<TRight>,
    condition: Condition
  ): CteJoinedQueryBuilder<TRootColumns, TRight> {
    return this.addJoin('LEFT', cte, condition);
  }

  /**
   * `RIGHT JOIN` another CTE.
   */
  rightJoin<TRight extends Record<string, any>>(
    cte: DbCte<TRight>,
    condition: Condition
  ): CteJoinedQueryBuilder<TRootColumns, TRight> {
    return this.addJoin('RIGHT', cte, condition);
  }

  /**
   * `FULL OUTER JOIN` another CTE.
   *
   * Postgres requires an `ON`/`USING` clause on a `FULL OUTER JOIN`, so pass a
   * predicate — use {@link onTrue} for the cross-product (`ON TRUE`) form that
   * keeps every row of both sides while pairing them up.
   */
  fullOuterJoin<TRight extends Record<string, any>>(
    cte: DbCte<TRight>,
    condition: Condition
  ): CteJoinedQueryBuilder<TRootColumns, TRight> {
    return this.addJoin('FULL OUTER', cte, condition);
  }

  /**
   * `CROSS JOIN` another CTE (cartesian product, no `ON`).
   */
  crossJoin<TRight extends Record<string, any>>(
    cte: DbCte<TRight>
  ): CteJoinedQueryBuilder<TRootColumns, TRight> {
    return this.addJoin('CROSS', cte, undefined);
  }

  /**
   * Project the root CTE's columns directly (no join).
   */
  select<TNewSelection>(
    selector: (root: TRootColumns) => TNewSelection
  ): CteRootQueryBuilder<TRootColumns, UnwrapSelection<TNewSelection>> {
    const next = new CteRootQueryBuilder<TRootColumns, UnwrapSelection<TNewSelection>>(
      this.rootCte,
      this.client,
      this.executor,
      this.rootAlias,
      this.chainId
    );
    next.joinSteps = this.joinSteps;
    next.selector = selectorProjectingConditions(selector as any);
    next.orderByFields = this.orderByFields;
    next.limitValue = this.limitValue;
    next.offsetValue = this.offsetValue;
    next.whereConds = this.whereConds;
    return next;
  }

  /**
   * Filter the rows — `WHERE <condition>` after the FROM and its joins, before ORDER BY. The
   * predicate reads the root CTE's row and, after a join, every joined CTE's (in FROM order),
   * whatever the projection is. A column of an enclosing query it reads is a correlation: it renders
   * as that column, and the subquery form (`asSubquery()`) reports it so the enclosing query joins
   * the navigation it needs. Repeated calls combine with AND; the WHERE's parameters follow the ON
   * predicates'.
   *
   * @example
   * db.products.with(prices.cte).select(p => ({
   *   prices: db.selectFromCte(prices.cte)
   *     .where(r => eq(r.productId, p.id))
   *     .select(r => r.amount)
   *     .asSubquery('array'),
   * }))
   */
  where(predicate: (root: CteColumnRefs<TRootColumns>, ...joined: any[]) => Condition): this {
    const condition = predicate(
      createCteFieldRefProxy(this.rootCte, this.rootName, this.chainId) as unknown as CteColumnRefs<TRootColumns>,
      ...this.joinSteps.map(step => createCteFieldRefProxy(step.cte, step.cte.name, this.chainId))
    );

    if (!(condition instanceof WhereConditionBase)) {
      throw new Error('selectFromCte().where(): expected a condition (eq(), and(), exists(), a boolean sql fragment, …)');
    }

    this.whereConds = [...this.whereConds, condition];
    return this;
  }

  /**
   * Order the result. Selector returns one or more projected columns (by their
   * output alias) — `ORDER BY "alias"` — supporting the same shapes as the
   * other builders (`r => r.col`, `r => [a, b]`, `r => [[a, 'DESC']]`).
   */
  orderBy<T>(selector: (row: TSelection) => T): this;
  orderBy<T>(selector: (row: TSelection) => T[]): this;
  orderBy<T>(selector: (row: TSelection) => Array<[T, OrderDirection]>): this;
  orderBy<T>(selector: (row: TSelection) => T | T[] | Array<[T, OrderDirection]>): this {
    // A selection of one value orders by that value (`select(x => x.id).orderBy(id => id)`)
    const mockRow = this.selector !== undefined && this.selectsSingleValue()
      ? { __fieldName: SCALAR_COLUMN, __dbColumnName: SCALAR_COLUMN } as FieldRef
      : new Proxy({} as any, {
        get: (_t, prop: string | symbol) => {
          if (typeof prop === 'symbol') {
            return undefined;
          }
          return { __fieldName: prop, __dbColumnName: prop } as FieldRef;
        },
        has: () => true,
      });
    const result = selector(mockRow as TSelection);
    this.orderByFields = [];
    parseOrderBy(result, this.orderByFields, undefined, () => '');
    return this;
  }

  /** Limit the result set. */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /** Offset the result set. */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Append `FOR UPDATE` (optionally `SKIP LOCKED` / `NOWAIT`) to this CTE-rooted
   * SELECT. Locks the rows the ROOT CTE's body read (the join legs are CTEs and
   * lock nothing themselves). This is the atomic guard leg of the
   * fused-conditional-INSERT pattern: put `FOR UPDATE` on the leg that reads the
   * guard rows (e.g. `capacity_group`), then a data-modifying leg conditioned on
   * it — check + write in one statement, no app-level lock, no TOCTOU.
   *
   * Pair with `.orderBy(...)` on a stable key (ascending id) when locking
   * multiple rows, so concurrent fused statements cannot deadlock each other.
   */
  forUpdate(options?: { skipLocked?: boolean; noWait?: boolean }): this {
    if (options?.skipLocked && options?.noWait) {
      throw new Error('forUpdate: skipLocked and noWait are mutually exclusive');
    }

    this.lockClause = options?.skipLocked
      ? 'FOR UPDATE SKIP LOCKED'
      : options?.noWait
        ? 'FOR UPDATE NOWAIT'
        : 'FOR UPDATE';

    return this;
  }

  private addJoin<TRight extends Record<string, any>>(
    type: CteJoinType,
    cte: DbCte<TRight>,
    condition?: Condition
  ): CteJoinedQueryBuilder<TRootColumns, TRight> {
    const next = new CteJoinedQueryBuilder<TRootColumns, TRight>(
      this.rootCte,
      this.client,
      this.executor,
      this.rootAlias,
      this.chainId
    );
    next._inheritJoins([...this.joinSteps, { type, cte, condition }], this.whereConds);
    return next;
  }

  /** @internal — used by the joined builder to share the build machinery. */
  _getRootCte(): DbCte<TRootColumns> {
    return this.rootCte;
  }

  /** @internal */
  _setState(
    joinSteps: CteJoinStep[],
    selector: ((...sources: any[]) => any) | undefined,
    orderByFields: Array<{ table: string; field: string; direction: OrderDirection }>,
    limitValue: number | undefined,
    offsetValue: number | undefined,
    whereConds: Condition[] = []
  ): void {
    this.joinSteps = joinSteps;
    this.selector = selector && selectorProjectingConditions(selector);
    this.orderByFields = orderByFields;
    this.limitValue = limitValue;
    this.offsetValue = offsetValue;
    this.whereConds = whereConds;
  }

  /**
   * Build the SQL + ordered parameter array for this CTE-rooted query.
   * @internal
   */
  buildQuery(): { sql: string; params: any[] } {
    if (!this.selector) {
      throw new Error('A selection is required. Call .select(...) before executing a CTE-rooted query.');
    }

    const params: unknown[] = [];
    // Parameters of every CTE body come first, in WITH declaration order (root, then each join); each
    // body is renumbered from where ITS parameters land (a builder numbers its CTEs as one block: its
    // second CTE as the root used to keep `$2` and bind the next CTE's value)
    const ctes = this.collectCtes();
    const cteDecls = ctes.map(cte => {
      const declaration = declareCte(cte, cteBodyAt(cte, params.length + 1));
      params.push(...cte.params);

      return declaration;
    });

    // The ON predicates are appended after all CTE-body params. Their next free
    // placeholder index is therefore (paramsSoFar + 1). Everything nested in the
    // statement reads its CTEs by name: they are declared here, at statement level.
    const ctx: SqlBuildContext = {
      paramCounter: params.length + 1,
      params,
      hoistedCteNames: declareStatementCtes(undefined, ctes),
      // The driver reads the projected values directly: an arrayAgg a value IS renders as JSON on a
      // driver without native array results (buildSelectParts marks each value's root)
      jsonArrayProjection: !this.client.supportsBinaryArrayResults(),
    };

    // FROM root, then the WHERE (its params follow the ON predicates')
    const fromClause = this.buildFromClause(ctx);
    const whereClause = this.buildWhereClause(ctx);

    // Build SELECT from the projection (root + joined CTE FieldRefs).
    const selection = this.evaluateSelection();
    const selectParts = buildSelectParts(selection, ctx, this.rootName, false);

    let orderByClause = '';
    if (this.orderByFields.length > 0) {
      const orderParts = this.orderByFields.map(({ field, direction }) => `"${field}" ${direction}`);
      orderByClause = `\nORDER BY ${orderParts.join(', ')}`;
    }

    let limitClause = '';
    if (this.limitValue !== undefined) {
      limitClause = `\nLIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== undefined) {
      limitClause += `\nOFFSET ${this.offsetValue}`;
    }

    // Row-level lock clause (forUpdate) — after LIMIT/OFFSET per SQL grammar.
    const lockClause = this.lockClause ? `\n${this.lockClause}` : '';

    const sqlText =
      `WITH ${cteDecls.join(', ')}\n` +
      `SELECT ${selectParts.join(', ')}\n${fromClause}${whereClause}${orderByClause}${limitClause}${lockClause}`;

    return { sql: sqlText, params: ctx.params };
  }

  /** Generate the SQL string (for debugging / assertions). */
  toSql(): string {
    return this.buildQuery().sql;
  }

  /** Execute and return all rows. */
  async toList(): Promise<TSelection[]> {
    const { sql: sqlText, params } = this.buildQuery();
    const result = this.executor
      ? await this.executor.query(sqlText, params)
      : await this.client.query(sqlText, params);

    const rows = transformRows(result.rows, this.evaluateSelection());

    // A selector returning one value reads as that value
    return (this.selectsSingleValue() ? rows.map(row => row[SCALAR_COLUMN]) : rows) as TSelection[];
  }

  /** Execute and return the first row, or null. */
  async first(): Promise<TSelection | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Every CTE this query references, in `WITH` declaration order: the FROM
   * root first, then each joined CTE. Each body is renumbered from where its
   * own parameters land (see cteBodyAt): the CTEs need not come from one
   * builder, nor in the order it created them.
   */
  private collectCtes(): DbCte<any>[] {
    return [this.rootCte, ...this.joinSteps.map(step => step.cte)];
  }

  /**
   * Render this CTE-rooted query as the body of a NESTED subquery, using the
   * enclosing statement's build context.
   *
   * Two shapes, chosen by whether the enclosing builder already declared these
   * CTEs at statement level (`SqlBuildContext.hoistedCteNames`, set by
   * `UnionQueryBuilder.buildSql` for the legs' `.with(...)` CTEs):
   *
   * - **Not declared upstream** — the subquery is self-contained: it emits its
   *   own `WITH` inside its own parentheses and contributes its CTE bodies'
   *   parameters. PostgreSQL scopes that `WITH` to this subquery, so nothing
   *   leaks out; the cost is that a CTE referenced from N such subqueries is
   *   written — and executed — N times.
   * - **Already declared upstream** — the subquery emits neither the `WITH` nor
   *   the parameters (the hoisting builder contributed both) and simply reads
   *   the statement-level relation by name. This is the shape that lets several
   *   subqueries share ONE materialization of an expensive candidate set.
   *
   * The two mix: a CTE declared upstream is read from there, the others are
   * declared here — each body renumbered from where its own parameters land. A
   * DIFFERENT CTE under a name the statement declares is refused (see isStatementCte).
   *
   * @internal
   */
  private buildNestedSql(outerContext: SqlBuildContext): string {
    if (!this.selector) {
      throw new Error('A selection is required. Call .select(...) before using a CTE-rooted query as a subquery.');
    }

    const ctes = this.collectCtes();
    const declaredHere = ctes.filter(cte => !isStatementCte(outerContext.hoistedCteNames, cte));

    // Declared here, inside the subquery: a data-modifying CTE cannot be (PostgreSQL allows it only in
    // the WITH of the statement that executes, where it runs once)
    assertStatementLevelCtes(declaredHere, undefined);

    // Parameter contract, preserved from the outermost path: every CTE body's
    // parameters come first, in WITH declaration order, before any ON-predicate
    // or projection parameter — each body renumbered from where they land.
    const cteDecls: string[] = [];

    for (const cte of declaredHere) {
      cteDecls.push(declareCte(cte, cteBodyAt(cte, outerContext.paramCounter)));
      outerContext.params.push(...cte.params);
      outerContext.paramCounter += cte.params.length;
    }

    // Whatever is nested in this subquery reads these CTEs by name — declared upstream, or just above
    const outerHoisted = outerContext.hoistedCteNames;
    outerContext.hoistedCteNames = declareStatementCtes(outerHoisted, ctes);

    let fromClause: string;
    let whereClause: string;
    let selectParts: string[];

    try {
      fromClause = this.buildFromClause(outerContext);
      whereClause = this.buildWhereClause(outerContext);
      // The enclosing query reads these columns: literals render typed (untyped, `true` reached it as 'true')
      selectParts = buildSelectParts(this.evaluateSelection(), outerContext, this.rootName, true);
    } finally {
      outerContext.hoistedCteNames = outerHoisted;
    }

    let tail = whereClause;
    if (this.orderByFields.length > 0) {
      tail += `\nORDER BY ${this.orderByFields.map(({ field, direction }) => `"${field}" ${direction}`).join(', ')}`;
    }
    if (this.limitValue !== undefined) {
      tail += `\nLIMIT ${this.limitValue}`;
    }
    if (this.offsetValue !== undefined) {
      tail += `\nOFFSET ${this.offsetValue}`;
    }

    const withClause = cteDecls.length > 0 ? `WITH ${cteDecls.join(', ')}\n` : '';

    return `${withClause}SELECT ${selectParts.join(', ')}\n${fromClause}${tail}`;
  }

  /**
   * FROM root + every join step, appending ON-predicate params to `ctx` — rendered in `ctx` itself, so
   * a subquery in an ON predicate sees the statement's CTEs (and its placeholders) too.
   */
  private buildFromClause(ctx: SqlBuildContext): string {
    let fromClause = this.rootAlias === undefined ? `FROM "${this.rootCte.name}"` : `FROM "${this.rootCte.name}" AS "${this.rootAlias}"`;

    for (const step of this.joinSteps) {
      const keyword = CTE_JOIN_SQL[step.type];
      if (step.type === 'CROSS') {
        fromClause += `\n${keyword} "${step.cte.name}"`;
        continue;
      }

      fromClause += `\n${keyword} "${step.cte.name}" ON ${step.condition!.buildSql(ctx)}`;
    }

    return fromClause;
  }

  /** `\nWHERE <conditions AND-combined>`, or '' — appending the WHERE's params to `ctx`. */
  private buildWhereClause(ctx: SqlBuildContext): string {
    if (this.whereConds.length === 0) {
      return '';
    }

    const condition = this.whereConds.length === 1 ? this.whereConds[0] : and(...this.whereConds);

    return `\nWHERE ${condition.buildSql(ctx)}`;
  }

  /**
   * The refs this query reads from an ENCLOSING query — every ref of its WHERE, ON predicates and
   * projection that is not a column of one of its own rows: a correlation, which the subquery form
   * reports so the enclosing query joins the navigations it needs.
   *
   * A ref under one of OUR aliases minted by another query (its chain identity) is a correlation to an
   * enclosing query over the same CTE: inside this query the alias names our own row, so the
   * correlation would compare that row with itself. Refused — as the entity path refuses a same-table
   * correlation — unless one side takes a distinct alias (`selectFromCte(cte, alias)`).
   */
  private outerFieldRefs(): FieldRef[] {
    const own = new Set([this.rootName, ...this.joinSteps.map(step => step.cte.name)]);
    const refs: FieldRef[] = [];
    const seen = new Set<object>();

    const add = (ref: FieldRef): void => {
      const alias = (ref as any).__tableAlias;

      if (seen.has(ref)) {
        return;
      }

      if (typeof alias === 'string' && own.has(alias)) {
        const chainId = (ref as any).__chainId;

        if (chainId != null && chainId !== this.chainId) {
          throw new Error(
            `selectFromCte(): the query correlates to the enclosing row "${alias}"."${ref.__dbColumnName}" under the alias `
            + `"${alias}", which names its own CTE row too — inside it both would read the same row and the comparison `
            + 'would hold for every row. Give one of them a distinct alias: selectFromCte(cte, \'<alias>\').'
          );
        }

        return;
      }

      seen.add(ref);
      refs.push(ref);
    };

    const visit = (value: unknown, depth: number): void => {
      if (value === null || typeof value !== 'object' || depth > 16) {
        return;
      }

      if (value instanceof WhereConditionBase) {
        value.getFieldRefs().forEach(add);
      } else if (value instanceof Subquery) {
        value.getOuterFieldRefs().forEach(add);
      } else if ('__dbColumnName' in value) {
        add(value as FieldRef);
      } else if (isNestedProjection(value)) {
        for (const nested of Object.values(value)) {
          visit(nested, depth + 1);
        }
      }
    };

    this.whereConds.forEach(condition => visit(condition, 0));
    this.joinSteps.forEach(step => visit(step.condition, 0));

    if (this.selector) {
      visit(this.evaluateSelection(), 0);
    }

    return refs;
  }

  /**
   * Turn this CTE-rooted select into a {@link Subquery} usable anywhere the ORM
   * accepts one — `inSubquery` / `notInSubquery`, `exists` / `notExists`, the
   * scalar comparisons, or a joined table source.
   *
   * @param mode `'table'` (default), `'array'` (for `inSubquery` / `notInSubquery`)
   *   or `'scalar'`.
   *
   * @example
   * const scope = cteBuilder.with('discount_scope', visibleDiscounts, { materialized: true });
   * const scopeIds = db.selectFromCte(scope.cte).select(r => ({ id: r.id })).asSubquery('array');
   *
   * // Self-contained: emits its own WITH inside the IN (...) parentheses.
   * await db.links.where(l => inSubquery(l.discountId, scopeIds)).count();
   *
   * // Shared: `.with(scope.cte)` hoists ONE declaration to statement level and
   * // every reader — both union legs here — reads that single materialization.
   * await db.campaigns.where(c => inSubquery(c.discountId, scopeIds))
   *   .select(c => ({ id: c.id }))
   *   .with(scope.cte)
   *   .unionAll(db.products.where(p => inSubquery(p.discountId, scopeIds)).select(p => ({ id: p.productId })))
   *   .count();
   */
  asSubquery<TMode extends 'scalar' | 'array' | 'table' = 'table'>(
    mode: TMode = 'table' as TMode
  ): Subquery<
    TMode extends 'scalar'
      ? SingleColumnValue<TSelection>
      : TMode extends 'array'
        ? SingleColumnValue<TSelection>[]
        : TSelection,
    TMode
  > {
    const sqlBuilder = (outerContext: SqlBuildContext & { tableAlias?: string }): string =>
      this.buildNestedSql(outerContext);

    const selectionMetadata = mode === 'table' ? this.evaluateSelection() : undefined;

    return new Subquery(sqlBuilder, mode, selectionMetadata, this.outerFieldRefs()) as any;
  }

  /**
   * Evaluate the user selector against fresh CTE FieldRef proxies. A selector returning ONE value
   * is projected as the one field {@link SCALAR_COLUMN}.
   */
  protected evaluateSelection(): Record<string, any> {
    const selection = this.evaluateSelector();

    return isSingleValueSelection(selection) ? { [SCALAR_COLUMN]: selection } : selection;
  }

  /** Whether the selector returns one value (see isSingleValueSelection). */
  private selectsSingleValue(): boolean {
    return isSingleValueSelection(this.evaluateSelector());
  }

  private evaluateSelector(): any {
    const rootMock = createCteFieldRefProxy(this.rootCte, this.rootName, this.chainId);
    const joinMocks = this.joinSteps.map(step => createCteFieldRefProxy(step.cte, step.cte.name, this.chainId));
    return this.selector!(rootMock, ...joinMocks);
  }
}

/**
 * The result of joining a CTE onto a CTE-rooted query. Carries the same build
 * machinery as {@link CteRootQueryBuilder} but its `.select(...)` selector
 * receives a FieldRef proxy per source (root first, then each joined CTE in
 * order), and further joins can still be chained.
 */
export class CteJoinedQueryBuilder<
  TRootColumns extends Record<string, any>,
  TRight extends Record<string, any>,
  TSelection = TRootColumns & TRight
> extends CteRootQueryBuilder<TRootColumns, TSelection> {
  private _joinSteps: CteJoinStep[] = [];

  /** @internal */
  _inheritJoins(steps: CteJoinStep[], whereConds: Condition[] = []): void {
    this._joinSteps = steps;
    this._setState(steps, undefined, [], undefined, undefined, whereConds);
  }

  /**
   * {@link CteRootQueryBuilder.where} over the root row and every joined CTE's row, in FROM order —
   * the single-join case typed as `(root, right)`.
   */
  where(predicate: (root: CteColumnRefs<TRootColumns>, right: CteColumnRefs<TRight>, ...more: any[]) => Condition): this {
    return super.where(predicate as (root: CteColumnRefs<TRootColumns>, ...joined: any[]) => Condition);
  }

  /**
   * Project columns from the root CTE plus every joined CTE. The selector is
   * called with `(root, ...joined)` FieldRef proxies in FROM declaration order.
   *
   * The common single-join case is fully typed: `(root, right)` where `right`
   * is the joined CTE ({@link TRight}). For 3+ way joins, the additional joined
   * sources arrive (in FROM order) as loosely-typed rest arguments.
   */
  select<TNewSelection>(
    selector: (root: TRootColumns, right: TRight) => TNewSelection
  ): CteRootQueryBuilder<TRootColumns, UnwrapSelection<TNewSelection>>;
  select<TNewSelection>(
    selector: (root: TRootColumns, ...joined: any[]) => TNewSelection
  ): CteRootQueryBuilder<TRootColumns, UnwrapSelection<TNewSelection>>;
  select<TNewSelection>(
    selector: (root: TRootColumns, ...joined: any[]) => TNewSelection
  ): CteRootQueryBuilder<TRootColumns, UnwrapSelection<TNewSelection>> {
    const next = new CteRootQueryBuilder<TRootColumns, UnwrapSelection<TNewSelection>>(
      this._getRootCte(),
      this.client,
      this.executor,
      this.rootAlias,
      this.chainId
    );
    next._setState(this._joinSteps, selector as any, [], undefined, undefined, this.whereConds);
    return next;
  }

  /**
   * Typed `fullOuterJoin` that exposes both already-joined sources (root +
   * first right) to the predicate. (Re-declared so the chained right side keeps
   * a useful element type rather than collapsing to the base signature.)
   */
  fullOuterJoin<TThird extends Record<string, any>>(
    cte: DbCte<TThird>,
    condition: Condition
  ): CteJoinedQueryBuilder<TRootColumns, TThird> {
    return super.fullOuterJoin(cte, condition) as any;
  }
}

/**
 * One `WITH` entry for a CTE, preserving its `AS MATERIALIZED` optimizer fence.
 * `body` is passed separately because the nested path renumbers placeholders.
 */
function declareCte(cte: DbCte<any>, body: string): string {
  return `"${cte.name}" AS ${cte.materialized ? 'MATERIALIZED ' : ''}(${body})`;
}

/**
 * Build SELECT list fragments from a projection object whose leaves are FieldRefs (qualified with
 * their CTE/table alias), SqlFragments, subqueries, nested objects (flattened under
 * `__nested__<path>` aliases) or literals.
 *
 * - A string is a value, as its type says — a parameter. It used to render as a column of that
 *   NAME of the root CTE: an error, or another column's data.
 * - A nested object used to be bound as ONE parameter, its column refs serialized into it.
 * - A list of values is read back from the projection itself (see transformRows) and has no column,
 *   unless the enclosing query reads the columns (`typedLiterals`) — then it is a jsonb value. A list
 *   of columns has no one SQL value and is refused.
 * - With `typedLiterals` (a subquery) a literal renders typed from its JS type.
 * - A set-returning function (`unnest(r.tags)`) renders as its call: a set-returning select-list item.
 * @internal
 */
export function buildSelectParts(
  selection: Record<string, any>,
  ctx: SqlBuildContext,
  defaultAlias: string,
  typedLiterals: boolean,
  pathPrefix?: string,
  parts: string[] = []
): string[] {
  for (const [key, value] of Object.entries(selection)) {
    const alias = pathPrefix === undefined ? key : `${pathPrefix}__${key}`;

    if (value instanceof SqlFragment || value instanceof Subquery) {
      // The driver reads the value directly: an arrayAgg (or scalar subquery) it IS renders as JSON
      // on a driver without native array results — only while this one value renders
      ctx.jsonArrayRoot = ctx.jsonArrayProjection ? projectedValueRoot(value) : undefined;

      try {
        parts.push(value instanceof SqlFragment
          ? `${renderProjectedFragment(value, ctx)} as "${alias}"`
          : `(${value.buildSql(ctx)}) as "${alias}"`);
      } finally {
        ctx.jsonArrayRoot = undefined;
      }
    } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
      const tableAlias = (value as any).__tableAlias || defaultAlias;
      parts.push(`"${tableAlias}"."${(value as any).__dbColumnName}" as "${alias}"`);
    } else if (isNestedProjection(value)) {
      buildSelectParts(value, ctx, defaultAlias, typedLiterals, pathPrefix === undefined ? `__nested__${key}` : alias, parts);
    } else if (value === undefined) {
      continue;
    } else {
      const path = pathPrefix === undefined ? key : alias.substring('__nested__'.length).split('__').join('.');
      assertProjectionArrayOfValues(value, path, 'selectFromCte().select()');

      if (Array.isArray(value) && !typedLiterals) {
        continue;
      }

      const literalContext = { paramCounter: ctx.paramCounter, allParams: ctx.params, typedLiterals };
      const literalSql = projectionLiteralSql(value, literalContext);
      ctx.paramCounter = literalContext.paramCounter;
      parts.push(`${literalSql} as "${alias}"`);
    }
  }

  return parts;
}

/** How one projected value reads back (compiled once per query by {@link compileRead}). */
interface CteFieldRead {
  key: string;
  /** The row key the value is delivered under (a nested value's path alias) */
  rowKey: string;
  kind: 'literal' | 'mapper' | 'value' | 'nested' | 'items';
  value?: unknown;
  mapper?: { fromDriver: (v: any) => any };
  /** 'value': a numeric string becomes a number (not for a text column, see coercesNumericText) */
  coerce?: boolean;
  children?: CteFieldRead[];
  itemReads?: Record<string, any>;
}

function compileRead(key: string, rowKey: string, value: any): CteFieldRead {
  if (value === undefined || isScalarLiteralSelection(value) || (Array.isArray(value) && !holdsSqlValue(value))) {
    // A literal reads back as itself (a parameter of unknown type comes back as text)
    return { key, rowKey, kind: 'literal', value };
  }

  if (isNestedProjection(value)) {
    const prefix = rowKey.startsWith('__nested__') ? rowKey : `__nested__${key}`;

    return {
      key,
      rowKey,
      kind: 'nested',
      children: Object.keys(value).map(childKey => compileRead(childKey, `${prefix}__${childKey}`, value[childKey])),
    };
  }

  if (value.__isAggregationArray) {
    // A withAggregation CTE's items, through the aggregated query's own mappers
    return { key, rowKey, kind: 'items', itemReads: aggregatedItemReads(value.__innerSelectionMetadata) };
  }

  const literalColumn = value.__cteKind === 'literal';
  const mapper = literalColumn
    ? (value.__bigintLiteral ? BIGINT_LITERAL_READ : undefined)
    : fromDriverMapper(value.__mapper) ?? (typeof value.getMapper === 'function' ? fromDriverMapper(value.getMapper()) : undefined);

  if (mapper) {
    return { key, rowKey, kind: 'mapper', mapper };
  }

  // A column of the CTE body keeps its text ('01234' used to read back as 1234); an expression's
  // numeric string (a SUM, a NUMERIC) becomes a number — unless it is read as a column of its type
  // (withReadType)
  const sqlType = value.__sqlType ?? (typeof value.getReadType === 'function' ? value.getReadType() : undefined);
  return { key, rowKey, kind: 'value', coerce: coercesNumericText(sqlType) };
}

function readValue(read: CteFieldRead, row: any): any {
  switch (read.kind) {
    case 'literal':
      return read.value;
    case 'nested': {
      const out: any = {};

      for (const child of read.children!) {
        out[child.key] = readValue(child, row);
      }

      return out;
    }
    case 'items': {
      const items = row[read.rowKey];

      return read.itemReads && Array.isArray(items) ? mapAggregatedItems(items, read.itemReads) : items;
    }
    case 'mapper':
      return read.mapper!.fromDriver(row[read.rowKey]);
    default: {
      const raw = row[read.rowKey];

      return read.coerce && typeof raw === 'string' && NUMERIC_REGEX.test(raw) ? +raw : raw;
    }
  }
}

/**
 * Transform driver rows into the projected shape: each value read the way its projection says —
 * a column through its OWN mapper (the CTE body's column's, carried on the ref), a literal as
 * itself, a nested object rebuilt from its path aliases, a json_agg column's items through the
 * aggregated query's mappers. NULLs are preserved as `null` (faithful to the SQL — a CTE-rooted
 * projection mirrors raw column output, unlike the entity path which maps absent columns to
 * `undefined`).
 * @internal
 */
export function transformRows(rows: any[], selection: Record<string, any>): any[] {
  // Pre-analyze each selected field once.
  const reads = Object.keys(selection).map(key => compileRead(key, key, selection[key]));

  return rows.map(row => {
    const out: any = {};

    for (const read of reads) {
      out[read.key] = readValue(read, row);
    }

    return out;
  });
}
