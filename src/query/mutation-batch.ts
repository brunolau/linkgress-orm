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
  _resolveBulkUpdatePrimaryKeys(data: Record<string, any>[], config?: { primaryKey?: string | string[] }): string[];
  _getClient(): DatabaseClient;
  _getExecutor(): { query: (sql: string, params: any[]) => Promise<any> } | undefined;
}

interface MutationLeg {
  id: string;
  sql: string;
  params: any[];
  client: DatabaseClient;
  executor: { query: (sql: string, params: any[]) => Promise<any> } | undefined;
}

/**
 * Composes heterogeneous INDEPENDENT mutations (insertBulk / bulkUpdate legs)
 * into ONE data-modifying-CTE statement executed in a single round trip:
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
 * batch.addInsertBulk(db.cfOrderItemDdValues, ddRows, 'dd');
 * batch.addInsertBulk(db.orderItemAttributes, attrRows, 'attrs');
 * await batch.executeBatch();            // ONE round trip (no-op when all legs were empty)
 * batch.getAffectedCount('items');       // rows the update leg matched
 */
export class MutationBatch {
  private readonly legs: MutationLeg[] = [];
  private counts: Map<string, number> | null = null;

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

    this.legs.forEach((leg, ix) => {
      const offset = params.length;
      const legSql = offset === 0 ? leg.sql : renumberPlaceholders(leg.sql, offset);

      cteParts.push(`"__mb_${ix}" AS (\n${legSql}\nRETURNING 1\n)`);
      selectParts.push(`(SELECT count(*)::int FROM "__mb_${ix}") AS "${ix}"`);
      params.push(...leg.params);
    });

    const sql = `WITH ${cteParts.join(',\n')}\nSELECT ${selectParts.join(', ')}`;
    const result = first.executor ? await first.executor.query(sql, params) : await first.client.query(sql, params);

    const row = result.rows[0] ?? {};
    const counts = new Map<string, number>();

    this.legs.forEach((leg, ix) => {
      counts.set(leg.id, Number(row[String(ix)] ?? 0));
    });

    this.counts = counts;
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
