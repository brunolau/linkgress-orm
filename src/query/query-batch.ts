import { FutureBatchMeta, FutureCountQuery, FutureQuery, FutureSingleQuery } from './future-query';

/**
 * Typed handle returned by QueryBatch.addList(). Carries the element type so
 * getList(key) infers without manual generics; stringly-typed lookup remains
 * available as an escape hatch.
 */
export interface BatchListKey<T> {
  readonly id: string;
  readonly kind: 'list';
  /** @internal phantom type carrier — never assigned */
  readonly __element?: T;
}

/**
 * Typed handle returned by QueryBatch.addFirstOrDefault().
 */
export interface BatchItemKey<T> {
  readonly id: string;
  readonly kind: 'first';
  /** @internal phantom type carrier — never assigned */
  readonly __element?: T;
}

/**
 * Typed handle returned by QueryBatch.addCount().
 */
export interface BatchCountKey {
  readonly id: string;
  readonly kind: 'count';
}

/** Query sources accepted by the add* methods (any builder exposing the future factories). */
export interface BatchListSource<T> {
  future(): FutureQuery<T>;
}

export interface BatchItemSource<T> {
  futureFirstOrDefault(): FutureSingleQuery<T>;
}

export interface BatchCountSource {
  futureCount(): FutureCountQuery;
}

type BatchKind = 'list' | 'first' | 'count';

interface BatchEntry {
  id: string;
  kind: BatchKind;
  future: FutureQuery<any> | FutureSingleQuery<any> | FutureCountQuery;
}

const PARAM_PLACEHOLDER = /\$(\d+)/g;

/**
 * Collects heterogeneous queries and executes them in a SINGLE database round
 * trip as one UNION ALL statement of json envelopes:
 *
 *   SELECT 0 AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (...) __batch_q
 *   UNION ALL
 *   SELECT 1, ... FROM (...) __batch_q
 *
 * Each branch is planned independently by PostgreSQL (Append node), so every
 * query keeps its own indexes. Results are demultiplexed by ordinal and pushed
 * through the SAME transform pipeline standalone execution uses, after JSON
 * value revival (timestamps/dates/decimals) driven by declared column types.
 *
 * A batch is one-shot: register queries, execute once, read results.
 *
 * @example
 * const batch = new QueryBatch();
 * const ordersKey = batch.addList(db.orders.where(o => eq(o.userId, id)).select(o => ({ id: o.id })), 'orders');
 * const userKey = batch.addFirstOrDefault(db.users.where(u => eq(u.id, id)).select(u => u), 'user');
 * const cntKey = batch.addCount(db.tickets.where(t => eq(t.eventId, ev)), 'tickets');
 * await batch.executeBatch();
 * const orders = batch.getList(ordersKey);   // typed
 * const user = batch.getItem(userKey);       // typed | null
 * const tickets = batch.getCount(cntKey);    // number
 */
export class QueryBatch {
  private readonly entries: BatchEntry[] = [];
  private results: Map<string, { kind: BatchKind; value: any }> | null = null;

  /**
   * Register a query whose full result list is wanted.
   * Returns a typed key for getList().
   */
  addList<T>(query: BatchListSource<T>, id: string): BatchListKey<T> {
    this.register(id, 'list', query.future());

    return { id, kind: 'list' };
  }

  /**
   * Register a query whose first row (or null) is wanted. LIMIT 1 is applied.
   * Returns a typed key for getItem().
   */
  addFirstOrDefault<T>(query: BatchItemSource<T>, id: string): BatchItemKey<T> {
    this.register(id, 'first', query.futureFirstOrDefault());

    return { id, kind: 'first' };
  }

  /**
   * Register a COUNT query. Returns a typed key for getCount().
   */
  addCount(query: BatchCountSource, id: string): BatchCountKey {
    this.register(id, 'count', query.futureCount());

    return { id, kind: 'count' };
  }

  /**
   * Execute every registered query in one round trip and store the results.
   */
  async executeBatch(): Promise<void> {
    if (this.results) {
      throw new Error('QueryBatch has already been executed — create a new batch for further queries');
    }

    if (this.entries.length === 0) {
      throw new Error('QueryBatch is empty — register queries before executing');
    }

    const first = this.entries[0].future;
    const client = first._client;
    const executor = first._executor;

    for (const entry of this.entries) {
      if (entry.future._client !== client || entry.future._executor !== executor) {
        throw new Error(
          `QueryBatch: query "${entry.id}" uses a different database client or transaction than the rest of the batch — all queries must share one connection context`
        );
      }
    }

    const branches: string[] = [];
    const params: any[] = [];

    this.entries.forEach((entry, ix) => {
      const offset = params.length;
      const branchSql =
        offset === 0
          ? entry.future._sql
          : entry.future._sql.replace(PARAM_PLACEHOLDER, (_match, n) => `$${Number(n) + offset}`);

      branches.push(
        `SELECT ${ix} AS __batch_ix, coalesce(json_agg(row_to_json(__batch_q)), '[]'::json) AS __batch_items FROM (\n${branchSql}\n) __batch_q`
      );
      params.push(...entry.future._params);
    });

    const sql = branches.join('\nUNION ALL\n');
    const result = executor ? await executor.query(sql, params) : await client.query(sql, params);

    const itemsByIx = new Map<number, any[]>();

    for (const row of result.rows) {
      const raw = row.__batch_items;
      const items = typeof raw === 'string' ? JSON.parse(raw) : raw;
      itemsByIx.set(Number(row.__batch_ix), Array.isArray(items) ? items : []);
    }

    const results = new Map<string, { kind: BatchKind; value: any }>();

    this.entries.forEach((entry, ix) => {
      const meta: FutureBatchMeta | undefined = entry.future._batchMeta;
      let rows = itemsByIx.get(ix) ?? [];

      if (meta?.reviveJsonRow) {
        rows = rows.map(meta.reviveJsonRow);
      }

      if (entry.kind === 'count') {
        results.set(entry.id, { kind: entry.kind, value: (entry.future as FutureCountQuery)._transform(rows) });
      } else {
        const transformed = (entry.future as FutureQuery<any> | FutureSingleQuery<any>)._transform(rows);
        const value = entry.kind === 'first' ? (transformed.length > 0 ? transformed[0] : null) : transformed;
        results.set(entry.id, { kind: entry.kind, value });
      }
    });

    this.results = results;
  }

  getList<T>(key: BatchListKey<T>): T[];
  getList<T = any>(id: string): T[];
  getList(keyOrId: BatchListKey<any> | string): any[] {
    return this.lookup(keyOrId, 'list');
  }

  getItem<T>(key: BatchItemKey<T>): T | null;
  getItem<T = any>(id: string): T | null;
  getItem(keyOrId: BatchItemKey<any> | string): any {
    return this.lookup(keyOrId, 'first');
  }

  getCount(keyOrId: BatchCountKey | string): number {
    return this.lookup(keyOrId, 'count');
  }

  private register(id: string, kind: BatchKind, future: BatchEntry['future']): void {
    if (this.results) {
      throw new Error('QueryBatch has already been executed — create a new batch for further queries');
    }

    if (this.entries.some((entry) => entry.id === id)) {
      throw new Error(`QueryBatch: identifier "${id}" is already registered`);
    }

    this.entries.push({ id, kind, future });
  }

  private lookup(keyOrId: { id: string } | string, expected: BatchKind): any {
    if (!this.results) {
      throw new Error('QueryBatch results are not available — call executeBatch() first');
    }

    const id = typeof keyOrId === 'string' ? keyOrId : keyOrId.id;
    const entry = this.results.get(id);

    if (!entry) {
      throw new Error(`QueryBatch: unknown identifier "${id}"`);
    }

    if (entry.kind !== expected) {
      throw new Error(`QueryBatch: "${id}" was registered as ${entry.kind}, not ${expected}`);
    }

    return entry.value;
  }
}
