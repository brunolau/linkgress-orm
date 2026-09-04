import type { DatabaseClient } from '../database/database-client.interface';
import { QueryExecutor } from '../entity/db-context';
import type { OrderDirection } from '../entity/db-context';
import {
  Condition,
  ConditionBuilder,
  FieldRef,
  SqlBuildContext,
  SqlFragment,
  UnwrapSelection,
  sql,
} from './conditions';
import { DbCte } from './cte-builder';
import { parseOrderBy } from './query-utils';
import { renumberPlaceholders } from './sql-utils';
import { Subquery } from './subquery';

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
 * with the CTE's own name as the table alias. Mirrors
 * `SelectQueryBuilder.createMockRowForCte` so column mappers / aggregation-array
 * markers carried on the CTE's `selectionMetadata` survive into the projection.
 */
function createCteFieldRefProxy<TColumns extends Record<string, any>>(cte: DbCte<TColumns>): TColumns {
  return new Proxy({} as any, {
    get(_target, prop: string | symbol) {
      if (typeof prop === 'symbol') {
        return undefined;
      }

      if (cte.selectionMetadata && prop in cte.selectionMetadata) {
        const value = cte.selectionMetadata[prop];

        // SqlFragment / column with a fromDriver mapper — preserve it so the
        // projection re-applies the mapper to the joined column.
        if (typeof value === 'object' && value !== null && typeof (value as any).getMapper === 'function') {
          return {
            __fieldName: prop,
            __dbColumnName: prop,
            __tableAlias: cte.name,
            getMapper: () => (value as any).getMapper(),
          };
        }

        // CTE aggregation-array marker (json_agg column) — preserve the inner
        // metadata so nested items can be mapped.
        if (typeof value === 'object' && value !== null && '__isAggregationArray' in value && (value as any).__isAggregationArray) {
          return {
            __fieldName: prop,
            __dbColumnName: prop,
            __tableAlias: cte.name,
            __isAggregationArray: true,
            __innerSelectionMetadata: (value as any).__innerSelectionMetadata,
          };
        }
      }

      return {
        __fieldName: prop,
        __dbColumnName: prop,
        __tableAlias: cte.name,
      } as FieldRef;
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
  private orderByFields: Array<{ table: string; field: string; direction: 'ASC' | 'DESC' }> = [];
  private limitValue?: number;
  private offsetValue?: number;
  private lockClause?: string;

  constructor(
    protected rootCte: DbCte<TRootColumns>,
    protected client: DatabaseClient,
    protected executor?: QueryExecutor
  ) {}

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
      this.executor
    );
    next.joinSteps = this.joinSteps;
    next.selector = selector as any;
    next.orderByFields = this.orderByFields;
    next.limitValue = this.limitValue;
    next.offsetValue = this.offsetValue;
    return next;
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
    const mockRow = new Proxy({} as any, {
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
      this.executor
    );
    next._inheritJoins([...this.joinSteps, { type, cte, condition }]);
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
    orderByFields: Array<{ table: string; field: string; direction: 'ASC' | 'DESC' }>,
    limitValue: number | undefined,
    offsetValue: number | undefined
  ): void {
    this.joinSteps = joinSteps;
    this.selector = selector;
    this.orderByFields = orderByFields;
    this.limitValue = limitValue;
    this.offsetValue = offsetValue;
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
    // Parameters of every CTE body come first, in WITH declaration order
    // (root, then each join). The bodies already carry sequential `$N`
    // placeholders assigned by DbCteBuilder, so just concatenate their params.
    params.push(...this.rootCte.params);
    for (const step of this.joinSteps) {
      params.push(...step.cte.params);
    }

    // The ON predicates are appended after all CTE-body params. Their next free
    // placeholder index is therefore (paramsSoFar + 1).
    const ctx: SqlBuildContext = {
      paramCounter: params.length + 1,
      params,
    };

    // FROM root
    const fromClause = this.buildFromClause(ctx);

    // Build the WITH clause from every referenced CTE, in declaration order.
    const cteDecls = this.collectCtes().map(cte => declareCte(cte, cte.query));

    // Build SELECT from the projection (root + joined CTE FieldRefs).
    const selection = this.evaluateSelection();
    const selectParts = buildSelectParts(selection, ctx, this.rootCte.name);

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
      `SELECT ${selectParts.join(', ')}\n${fromClause}${orderByClause}${limitClause}${lockClause}`;

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

    const selection = this.evaluateSelection();
    return transformRows(result.rows, selection) as TSelection[];
  }

  /** Execute and return the first row, or null. */
  async first(): Promise<TSelection | null> {
    const results = await this.limit(1).toList();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Every CTE this query references, in `WITH` declaration order: the FROM
   * root first, then each joined CTE. Their bodies carry placeholders numbered
   * sequentially from `$1` across the whole list (a shared `DbCteBuilder`
   * assigns them), which is what lets both build paths treat the list as one
   * contiguous parameter block.
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
   * @internal
   */
  private buildNestedSql(outerContext: SqlBuildContext): string {
    if (!this.selector) {
      throw new Error('A selection is required. Call .select(...) before using a CTE-rooted query as a subquery.');
    }

    const ctes = this.collectCtes();
    const hoisted = ctes.filter(cte => outerContext.hoistedCteNames?.has(cte.name));

    // A partially-hoisted list cannot be renumbered. Every body's `$N` is
    // relative to a single contiguous block that starts at the FIRST CTE, so
    // relocating only some of them would need a per-CTE offset that the baked-in
    // numbering no longer describes — the survivors would silently bind to the
    // wrong parameters. Refuse instead of emitting wrong SQL (same stance
    // `UnionQueryBuilder` takes on a CTE name collision).
    if (hoisted.length > 0 && hoisted.length !== ctes.length) {
      const hoistedNames = hoisted.map(cte => `"${cte.name}"`).join(', ');
      const localNames = ctes.filter(cte => !hoisted.includes(cte)).map(cte => `"${cte.name}"`).join(', ');
      throw new Error(
        `Cannot nest this CTE-rooted subquery: ${hoistedNames} ${hoisted.length === 1 ? 'is' : 'are'} already ` +
          `declared at statement level while ${localNames} ${localNames.includes(',') ? 'are' : 'is'} not. ` +
          'Attach every CTE the subquery reads to the enclosing statement (.with(...)), or none of them.'
      );
    }

    const allHoisted = hoisted.length === ctes.length;

    // Parameter contract, preserved from the outermost path: every CTE body's
    // parameters come first, in WITH declaration order, before any ON-predicate
    // or projection parameter. The bodies number their placeholders from `$1`,
    // so nesting shifts the whole block by however many parameters the
    // enclosing statement has already bound.
    const offset = outerContext.paramCounter - 1;
    const cteDecls: string[] = [];

    if (!allHoisted) {
      for (const cte of ctes) {
        outerContext.params.push(...cte.params);
        outerContext.paramCounter += cte.params.length;
        cteDecls.push(declareCte(cte, offset === 0 ? cte.query : renumberPlaceholders(cte.query, offset)));
      }
    }

    const fromClause = this.buildFromClause(outerContext);
    const selectParts = buildSelectParts(this.evaluateSelection(), outerContext, this.rootCte.name);

    let tail = '';
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

  /** FROM root + every join step, appending ON-predicate params to `ctx`. */
  private buildFromClause(ctx: SqlBuildContext): string {
    let fromClause = `FROM "${this.rootCte.name}"`;

    for (const step of this.joinSteps) {
      const keyword = CTE_JOIN_SQL[step.type];
      if (step.type === 'CROSS') {
        fromClause += `\n${keyword} "${step.cte.name}"`;
        continue;
      }

      const condBuilder = new ConditionBuilder();
      const { sql: condSql, params: condParams, paramCounter } = condBuilder.build(step.condition!, ctx.paramCounter);
      ctx.paramCounter = paramCounter;
      ctx.params.push(...condParams);
      fromClause += `\n${keyword} "${step.cte.name}" ON ${condSql}`;
    }

    return fromClause;
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

    return new Subquery(sqlBuilder, mode, selectionMetadata) as any;
  }

  /** Evaluate the user selector against fresh CTE FieldRef proxies. */
  protected evaluateSelection(): Record<string, any> {
    const rootMock = createCteFieldRefProxy(this.rootCte);
    const joinMocks = this.joinSteps.map(step => createCteFieldRefProxy(step.cte));
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
  _inheritJoins(steps: CteJoinStep[]): void {
    this._joinSteps = steps;
    this._setState(steps, undefined, [], undefined, undefined);
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
      this.executor
    );
    next._setState(this._joinSteps, selector as any, [], undefined, undefined);
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
 * Build SELECT list fragments from a projection object whose leaves are
 * FieldRefs (qualified with their CTE/table alias), SqlFragments, or literals.
 */
function buildSelectParts(
  selection: Record<string, any>,
  ctx: SqlBuildContext,
  defaultAlias: string
): string[] {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(selection)) {
    if (value instanceof SqlFragment) {
      const fragmentSql = value.buildSql(ctx);
      parts.push(`${fragmentSql} as "${key}"`);
    } else if (typeof value === 'object' && value !== null && '__dbColumnName' in value) {
      const alias = (value as any).__tableAlias || defaultAlias;
      parts.push(`"${alias}"."${(value as any).__dbColumnName}" as "${key}"`);
    } else if (typeof value === 'string') {
      // Bare column name string — qualify with the root alias.
      parts.push(`"${defaultAlias}"."${value}" as "${key}"`);
    } else {
      // Literal value
      ctx.params.push(value);
      parts.push(`$${ctx.paramCounter++} as "${key}"`);
    }
  }

  return parts;
}

/**
 * Transform driver rows into the projected shape, re-applying any column /
 * SqlFragment fromDriver mappers and coercing Postgres numeric strings to
 * numbers. NULLs are preserved as `null` (faithful to the SQL — a CTE-rooted
 * projection mirrors raw column output, unlike the entity path which maps
 * absent columns to `undefined`).
 */
function transformRows(rows: any[], selection: Record<string, any>): any[] {
  // Pre-analyze each selected field once.
  const fields: Array<{ key: string; mapper?: { fromDriver: (v: any) => any } }> = [];
  for (const [key, value] of Object.entries(selection)) {
    let mapper: { fromDriver: (v: any) => any } | undefined;
    if (value && typeof value === 'object' && typeof (value as any).getMapper === 'function') {
      let m = (value as any).getMapper();
      if (m && typeof m.getType === 'function') {
        m = m.getType();
      }
      if (m && typeof m.fromDriver === 'function') {
        mapper = m;
      }
    }
    fields.push({ key, mapper });
  }

  return rows.map(row => {
    const out: any = {};
    for (const { key, mapper } of fields) {
      const raw = row[key];
      if (mapper) {
        out[key] = mapper.fromDriver(raw);
      } else if (typeof raw === 'string' && NUMERIC_REGEX.test(raw)) {
        out[key] = +raw;
      } else {
        out[key] = raw;
      }
    }
    return out;
  });
}
