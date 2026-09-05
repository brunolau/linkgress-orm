import type { DatabaseClient } from '../database/database-client.interface';
import { renumberPlaceholders } from './query-batch';

const POSTGRES_MAX_PARAMS = 65535;

/** Typed handle returned by MutationBatch.addInsertBulk / addBulkUpdate. */
export interface MutationBatchKey {
  readonly id: string;
}

/**
 * The structural surface MutationBatch needs from an entity table — the
 * internal compile methods {@link DbEntityTable} exposes for it. Structural on
 * purpose: it avoids a value import of the (heavyweight) entity module from
 * the query layer.
 * @internal
 */
interface MutationCapableTable {
  _buildInsertBulkStatement(
    data: Record<string, any>[],
    overridingSystemValue?: boolean,
    onConflictDoNothing?: boolean
  ): { sql: string; params: any[] } | null;
  _buildBulkUpdateStatement(data: Record<string, any>[], primaryKeys: string[]): { sql: string; params: any[] };
  _buildDeleteWhereInStatement(field: string, values: any[]): { sql: string; params: any[] } | null;
  _buildUpdateWhereInStatement(
    field: string,
    values: any[],
    set: Record<string, any> | ((row: any) => Record<string, any>)
  ): { sql: string; params: any[] } | null;
  _buildUpsertBulkStatement(
    values: Record<string, any>[],
    config: { primaryKey: string | string[]; updateColumns?: string[] }
  ): { sql: string; params: any[] } | null;
  _buildDependentInsertSelectStatement(
    row: Record<string, any>,
    whereColumnAlias: string,
    whereNotEquals: any
  ): { sql: string; params: any[] };
  _buildInsertBulkWithChildrenCtes(config: {
    rows: Record<string, any>[];
    children: { table: any; foreignKey: string; rows: Array<{ parentIndex: number; row: Record<string, any> }> };
  }): { ctes: Array<{ suffix: string; sql: string }>; params: any[] };
  _resolveColumnDbNames(props: string[]): Array<{ prop: string; dbName: string }>;
  _resolveBulkUpdatePrimaryKeys(data: Record<string, any>[], config?: { primaryKey?: string | string[] }): string[];
  _getClient(): DatabaseClient;
  _getExecutor(): { query: (sql: string, params: any[]) => Promise<any> } | undefined;
}

interface MutationLeg {
  id: string;
  sql: string;
  params: any[];
  client: DatabaseClient;
  executor: { query: (sql: string, params: any[], execution?: { prepare?: boolean }) => Promise<any> } | undefined;
  /** Explicit RETURNING list for this leg's CTE (default legs return the bare `1`). */
  returningSql?: string;
  /** When set, the leg's RETURNING rows are read back via json_agg → {@link MutationBatch.getLegRows}. */
  readRows?: boolean;
  /** Dependent legs reference this parent leg's CTE (the `__MB_PARENT__` token rewrite). */
  dependsOnLegId?: string;
  /**
   * Multi-CTE legs (insertBulkWithChildren): the CTE triple replaces the
   * single wrapped statement — no `RETURNING 1` appending, count from the
   * parent CTE, optional parent-row readback via `rowsSelect` (both use the
   * `__MB_SELF__` prefix token rewritten at assembly).
   */
  multi?: { ctes: Array<{ suffix: string; sql: string }>; rowsSelect?: string };
}

/**
 * Composes heterogeneous INDEPENDENT mutations (insertBulk / bulkUpdate /
 * deleteWhereIn legs) into ONE data-modifying-CTE statement executed in a
 * single round trip:
 *
 *   WITH "__mb_0" AS (INSERT ... RETURNING 1),
 *        "__mb_1" AS (UPDATE ... RETURNING 1)
 *   SELECT (SELECT count(*)::int FROM "__mb_0") AS "0", ...
 *
 * Each leg's SQL is EXACTLY what its standalone execution would run (same
 * column mappers, same `"col__provided"` CASE semantics for bulkUpdate), so
 * batched results are value-identical to sequential execution — under
 * PostgreSQL's data-modifying-CTE rules:
 *
 *  - all legs run against the SAME snapshot; one leg's writes are INVISIBLE to
 *    the others — legs must be mutually independent;
 *  - modifying the same ROW from two legs is unsupported by PostgreSQL (one
 *    silently wins) — never point two legs at the same rows;
 *  - the statement is atomic: any leg's error rolls back every leg.
 *
 * Registration semantics: empty row arrays register NOTHING and return null
 * (mirroring insertBulk/bulkUpdate early returns), so call sites with
 * conditional legs need no guards; an empty batch's executeBatch() is a no-op.
 * A leg larger than the single-statement parameter budget throws at
 * registration — chunked mutations cannot ride one statement, execute those
 * standalone.
 *
 * @example
 * const batch = new MutationBatch();
 * batch.addBulkUpdate(db.orderItems, itemUpdates, 'items');
 * batch.addInsertBulk(db.itemOptionValues, optionRows, 'options');
 * batch.addInsertBulk(db.itemAttributes, attrRows, 'attrs');
 * await batch.executeBatch();            // ONE round trip (no-op when all legs were empty)
 * batch.getAffectedCount('items');       // rows the update leg matched
 */
export class MutationBatch {
  private readonly legs: MutationLeg[] = [];
  private counts: Map<string, number> | null = null;
  private rows: Map<string, any[]> | null = null;

  /**
   * Register a bulk INSERT leg. Returns null (and registers nothing) for an
   * empty row array or rows resolving to zero insertable columns.
   */
  addInsertBulk(
    table: MutationCapableTable,
    rows: Record<string, any>[],
    id: string,
    options?: { overridingSystemValue?: boolean; onConflictDoNothing?: boolean }
  ): MutationBatchKey | null {
    if (rows.length === 0) {
      return null;
    }

    this.assertRegisterable(id);
    MutationBatch.assertSingleStatementBudget(rows, id);

    const built = table._buildInsertBulkStatement(rows, options?.overridingSystemValue, options?.onConflictDoNothing);

    if (!built) {
      return null;
    }

    this.legs.push({ id, sql: built.sql, params: built.params, client: table._getClient(), executor: table._getExecutor() });

    return { id };
  }

  /**
   * Register a DELETE leg: `DELETE FROM t WHERE "col" IN (…)`, values run
   * through the column's toDriver mapper. Returns null (and registers
   * nothing) for an empty values array.
   *
   * Parent + child rows CAN be deleted by two legs of one batch when the
   * child's foreign key is NO ACTION (PostgreSQL's default): NO ACTION is
   * checked at END of statement, when both legs' deletes are already visible
   * to the constraint. A RESTRICT foreign key (checked per-row) would still
   * reject the parent leg — keep such pairs in separate statements.
   */
  addDeleteWhereIn(
    table: MutationCapableTable,
    field: string,
    values: any[],
    id: string
  ): MutationBatchKey | null {
    if (values.length === 0) {
      return null;
    }

    this.assertRegisterable(id);
    // Same single-statement parameter budget the row-based legs enforce, at
    // one parameter per value (single-column IN list).
    MutationBatch.assertSingleStatementBudget(values.map(value => ({ value })), id);

    const built = table._buildDeleteWhereInStatement(field, values);

    if (!built) {
      return null;
    }

    this.legs.push({ id, sql: built.sql, params: built.params, client: table._getClient(), executor: table._getExecutor() });

    return { id };
  }

  /**
   * Register an `UPDATE .. WHERE "col" IN (…)` leg. SET semantics mirror the
   * fluent `update()` — plain values through column mappers, `SqlFragment`
   * values inlined (flag operators, CASE expressions), lambda form resolving
   * column refs. Returns null for an empty values array.
   *
   * `options.exposeColumns` / `options.exposeOldColumns` publish columns on
   * the leg's CTE for dependent legs: plain columns under their prop name,
   * pre-update values via PostgreSQL 18's `old.` RETURNING qualifier under
   * `old__<prop>`. Exposed legs still report counts; their rows are NOT
   * readable via getLegRows (register an upsert leg with `returning` for
   * readback).
   */
  addUpdateWhereIn(
    table: MutationCapableTable,
    field: string,
    values: any[],
    set: Record<string, any> | ((row: any) => Record<string, any>),
    id: string,
    options?: { exposeColumns?: string[]; exposeOldColumns?: string[] }
  ): MutationBatchKey | null {
    if (values.length === 0) {
      return null;
    }

    this.assertRegisterable(id);
    MutationBatch.assertSingleStatementBudget(values.map(value => ({ value })), id);

    const built = table._buildUpdateWhereInStatement(field, values, set);

    if (!built) {
      return null;
    }

    const exposeParts: string[] = [];

    for (const col of table._resolveColumnDbNames(options?.exposeColumns ?? [])) {
      exposeParts.push(`"${col.dbName}" AS "${col.prop}"`);
    }

    for (const col of table._resolveColumnDbNames(options?.exposeOldColumns ?? [])) {
      exposeParts.push(`old."${col.dbName}" AS "old__${col.prop}"`);
    }

    this.legs.push({
      id,
      sql: built.sql,
      params: built.params,
      client: table._getClient(),
      executor: table._getExecutor(),
      returningSql: exposeParts.length > 0 ? exposeParts.join(', ') : undefined,
    });

    return { id };
  }

  /**
   * Register an `INSERT .. ON CONFLICT DO UPDATE` (upsert) leg — EXCLUDED
   * semantics, `SqlFragment` cells supported (accumulator folds computed in
   * the statement). Returns null for an empty row array. `options.returning`
   * (prop names) exposes the upserted rows to {@link getLegRows} — raw JSON
   * values (json_agg readback, no fromDriver pass), suited to scalar
   * accumulator reads.
   */
  addUpsertBulk(
    table: MutationCapableTable,
    rows: Record<string, any>[],
    config: { primaryKey: string | string[]; updateColumns?: string[] },
    id: string,
    options?: { returning?: string[] }
  ): MutationBatchKey | null {
    if (rows.length === 0) {
      return null;
    }

    this.assertRegisterable(id);
    MutationBatch.assertSingleStatementBudget(rows, id);

    const built = table._buildUpsertBulkStatement(rows, config);

    if (!built) {
      return null;
    }

    const returningCols = table._resolveColumnDbNames(options?.returning ?? []);

    this.legs.push({
      id,
      sql: built.sql,
      params: built.params,
      client: table._getClient(),
      executor: table._getExecutor(),
      returningSql: returningCols.length > 0 ? returningCols.map(c => `"${c.dbName}" AS "${c.prop}"`).join(', ') : undefined,
      readRows: returningCols.length > 0,
    });

    return { id };
  }

  /**
   * Register a SINGLE-row INSERT that fires iff the PARENT leg's exposed
   * column differs from the sentinel — the conditional-audit-log shape
   * (`old status ≠ final` → write the log; idempotent replay writes none).
   * The parent must be registered FIRST with the referenced column exposed
   * (see addUpdateWhereIn's expose options); `whereColumn` is the EXPOSED
   * alias (`old__<prop>` for old-columns). Cell values run through column
   * mappers with `$n::type` casts. The sentinel comparison is `<>` on
   * non-null values (v1: no NULL-sentinel support).
   */
  addDependentInsert(
    table: MutationCapableTable,
    row: Record<string, any>,
    dependency: { onLeg: MutationBatchKey | string; whereColumn: string; whereNotEquals: any },
    id: string
  ): MutationBatchKey | null {
    this.assertRegisterable(id);

    const parentId = typeof dependency.onLeg === 'string' ? dependency.onLeg : dependency.onLeg.id;
    const parent = this.legs.find(leg => leg.id === parentId);

    if (!parent) {
      throw new Error(`MutationBatch: dependent leg "${id}" references unregistered parent leg "${parentId}" — register the parent first`);
    }

    if (!parent.returningSql || !parent.returningSql.includes(`"${dependency.whereColumn}"`)) {
      throw new Error(
        `MutationBatch: dependent leg "${id}" reads column "${dependency.whereColumn}" which parent leg "${parentId}" does not expose — pass it via exposeColumns/exposeOldColumns`
      );
    }

    const built = table._buildDependentInsertSelectStatement(row, dependency.whereColumn, dependency.whereNotEquals);

    this.legs.push({
      id,
      sql: built.sql,
      params: built.params,
      client: table._getClient(),
      executor: table._getExecutor(),
      dependsOnLegId: parentId,
    });

    return { id };
  }

  /**
   * Register an insertBulkWithChildren leg: N parent rows + their index-mapped
   * children ride this batch's statement as a sibling CTE triple (parent
   * insert with input-ordinal ORDER BY → serial-ascend ordinal recovery →
   * child insert joining the ordinal for the FK). Returns null for an empty
   * parent array. `getAffectedCount` reports PARENT rows;
   * `options.parentReturning` (prop names) exposes the parent rows in INPUT
   * order via {@link getLegRows} (raw JSON values — e.g. read back generated
   * task ids to publish after the batch commits). Unlike the standalone form,
   * childless parents are allowed.
   */
  addInsertBulkWithChildren(
    table: MutationCapableTable,
    config: {
      rows: Record<string, any>[];
      children: { table: any; foreignKey: string; rows: Array<{ parentIndex: number; row: Record<string, any> }> };
    },
    id: string,
    options?: { parentReturning?: string[] }
  ): MutationBatchKey | null {
    if (config.rows.length === 0) {
      return null;
    }

    this.assertRegisterable(id);
    MutationBatch.assertSingleStatementBudget([...config.rows, ...config.children.rows.map(child => child.row)], id);

    const built = table._buildInsertBulkWithChildrenCtes(config);
    const returningCols = table._resolveColumnDbNames(options?.parentReturning ?? []);
    const rowsSelect = returningCols.length > 0
      ? `(SELECT COALESCE(json_agg(json_build_object(${returningCols.map(c => `'${c.prop}', o."${c.dbName}"`).join(', ')}) ORDER BY o."__mbw_ord"), '[]'::json) FROM "__MB_SELF___o" o)`
      : undefined;

    this.legs.push({
      id,
      sql: '',
      params: built.params,
      client: table._getClient(),
      executor: table._getExecutor(),
      readRows: rowsSelect != null,
      multi: { ctes: built.ctes, rowsSelect },
    });

    return { id };
  }

  /**
   * Register a bulk UPDATE leg (same per-row `"col__provided"` semantics as
   * standalone bulkUpdate). Returns null for an empty row array.
   */
  addBulkUpdate(
    table: MutationCapableTable,
    rows: Record<string, any>[],
    id: string,
    config?: { primaryKey?: string | string[] }
  ): MutationBatchKey | null {
    if (rows.length === 0) {
      return null;
    }

    this.assertRegisterable(id);
    MutationBatch.assertSingleStatementBudget(rows, id);

    const primaryKeys = table._resolveBulkUpdatePrimaryKeys(rows, config);
    const built = table._buildBulkUpdateStatement(rows, primaryKeys);

    this.legs.push({ id, sql: built.sql, params: built.params, client: table._getClient(), executor: table._getExecutor() });

    return { id };
  }

  /** Number of registered (non-empty) legs. */
  get size(): number {
    return this.legs.length;
  }

  /**
   * Execute every registered leg as ONE statement and store the per-leg
   * affected counts. A batch with zero legs resolves without touching the
   * database. One-shot: a batch that already executed throws.
   */
  async executeBatch(): Promise<void> {
    if (this.counts) {
      throw new Error('MutationBatch has already been executed — create a new batch for further mutations');
    }

    if (this.legs.length === 0) {
      this.counts = new Map();
      this.rows = new Map();

      return;
    }

    const first = this.legs[0];

    for (const leg of this.legs) {
      if (leg.client !== first.client || leg.executor !== first.executor) {
        throw new Error(
          `MutationBatch: leg "${leg.id}" uses a different database client or transaction than the rest of the batch — all legs must share one connection context`
        );
      }
    }

    const cteParts: string[] = [];
    const selectParts: string[] = [];
    const params: any[] = [];
    const indexById = new Map<string, number>(this.legs.map((leg, ix) => [leg.id, ix]));

    this.legs.forEach((leg, ix) => {
      const offset = params.length;

      // Multi-CTE legs (insertBulkWithChildren) contribute their CTE triple as
      // siblings under the leg's prefix; count comes from the parent CTE and
      // the optional readback from the ordinal CTE.
      if (leg.multi != null) {
        const prefix = `__mb_${ix}`;

        for (const cte of leg.multi.ctes) {
          const renamed = cte.sql.replace(/__MB_SELF__/g, prefix);
          cteParts.push(`"${prefix}_${cte.suffix}" AS (\n${offset === 0 ? renamed : renumberPlaceholders(renamed, offset)}\n)`);
        }

        selectParts.push(`(SELECT count(*)::int FROM "${prefix}_p") AS "${ix}"`);

        if (leg.multi.rowsSelect != null) {
          selectParts.push(`${leg.multi.rowsSelect.replace(/__MB_SELF__/g, prefix)} AS "${ix}__rows"`);
        }

        params.push(...leg.params);

        return;
      }

      let legSql = offset === 0 ? leg.sql : renumberPlaceholders(leg.sql, offset);

      // Dependent legs reference their parent's CTE via the compile-time token
      // (the parent's index is only known here). Registration order guarantees
      // the parent CTE is defined before this one.
      if (leg.dependsOnLegId != null) {
        legSql = legSql.replace(/__MB_PARENT__/g, `__mb_${indexById.get(leg.dependsOnLegId)}`);
      }

      cteParts.push(`"__mb_${ix}" AS (\n${legSql}\nRETURNING ${leg.returningSql ?? '1'}\n)`);
      selectParts.push(`(SELECT count(*)::int FROM "__mb_${ix}") AS "${ix}"`);

      if (leg.readRows === true) {
        selectParts.push(`(SELECT COALESCE(json_agg(row_to_json("__mb_${ix}")), '[]'::json) FROM "__mb_${ix}") AS "${ix}__rows"`);
      }

      params.push(...leg.params);
    });

    const sql = `WITH ${cteParts.join(',\n')}\nSELECT ${selectParts.join(', ')}`;
    // The fused statement's text follows this batch's legs and their VALUES lists — unique per
    // call, so a prepared statement would be cached and never reused (see QueryOptions.preparedStatements).
    const result = first.executor ? await first.executor.query(sql, params, { prepare: false }) : await first.client.query(sql, params);

    const row = result.rows[0] ?? {};
    const counts = new Map<string, number>();
    const rows = new Map<string, any[]>();

    this.legs.forEach((leg, ix) => {
      counts.set(leg.id, Number(row[String(ix)] ?? 0));

      if (leg.readRows === true) {
        const raw = row[`${ix}__rows`];
        rows.set(leg.id, typeof raw === 'string' ? JSON.parse(raw) : (raw ?? []));
      }
    });

    this.counts = counts;
    this.rows = rows;
  }

  /**
   * The RETURNING rows of a leg registered with `returning` (currently the
   * upsert leg). Raw JSON values — json_agg readback, no fromDriver pass.
   * Only valid after executeBatch(); throws for legs without returning.
   */
  getLegRows(key: MutationBatchKey | string): Record<string, unknown>[] {
    if (!this.rows) {
      throw new Error('MutationBatch has not been executed yet — call executeBatch() before reading rows');
    }

    const id = typeof key === 'string' ? key : key.id;
    const legRows = this.rows.get(id);

    if (legRows === undefined) {
      throw new Error(`MutationBatch: leg "${id}" was not registered with a returning list — no rows to read`);
    }

    return legRows;
  }

  /** Rows the leg inserted/matched. Only valid after executeBatch(). */
  getAffectedCount(key: MutationBatchKey | string): number {
    if (!this.counts) {
      throw new Error('MutationBatch has not been executed yet — call executeBatch() before reading counts');
    }

    const id = typeof key === 'string' ? key : key.id;
    const count = this.counts.get(id);

    if (count === undefined) {
      throw new Error(`MutationBatch: no leg registered under "${id}"`);
    }

    return count;
  }

  private assertRegisterable(id: string): void {
    if (this.counts) {
      throw new Error('MutationBatch has already been executed — create a new batch for further mutations');
    }

    if (this.legs.some(leg => leg.id === id)) {
      throw new Error(`MutationBatch: duplicate leg identifier "${id}"`);
    }
  }

  /**
   * A leg must fit one statement — the same parameter-budget formula the
   * standalone mutations use to CHUNK large inputs. A chunked mutation cannot
   * ride a single-statement batch, so oversize inputs are rejected here.
   */
  private static assertSingleStatementBudget(rows: Record<string, any>[], id: string): void {
    const columnCount = Math.max(1, Object.keys(rows[0]).length);
    const maxRowsPerBatch = Math.floor(POSTGRES_MAX_PARAMS / columnCount);
    const singleStatementLimit = Math.floor(maxRowsPerBatch * 0.6);

    if (rows.length > singleStatementLimit) {
      throw new Error(
        `MutationBatch: leg "${id}" carries ${rows.length} rows, above the ~${singleStatementLimit}-row single statement budget for ${columnCount} columns — execute this mutation standalone (it needs chunking)`
      );
    }
  }
}
