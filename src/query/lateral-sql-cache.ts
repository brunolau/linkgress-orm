import { MockRowCache } from './mock-row-cache';

/** One memoised lateral aggregation: everything `buildAggregation` returns except the parameters. */
export interface LateralSqlEntry {
  /**
   * Monotonic, never reused. A parent shape's key names a nested lateral by this id instead
   * of its (long) join-clause text, so the key of a deep projection stays short.
   */
  id: number;
  sql: string;
  joinClause: string;
  selectExpression: string;
  tableName: string;
}

/**
 * Memo for the SQL the lateral collection strategy renders per aggregation shape.
 *
 * Everything `LateralCollectionStrategy.buildAggregation` assembles — the inner SELECT list, the
 * `json_build_object` / `json_agg` wrapper, navigation joins, the parent correlation, the
 * rewritten WHERE / ORDER BY, LIMIT / OFFSET — is a pure function of the aggregation config it is
 * handed (aliases, field expressions, clause TEXT with its `$n` placeholders, flags, joins,
 * nested join clauses) plus the enclosing lateral alias map. The same query shape therefore
 * renders the same text on every build; only the parameter VALUES differ, and those never
 * enter the strategy. Under load that assembly was the largest remaining per-build item of a
 * collection projection once the mock-row and navigation-path caches were on.
 *
 * The key is the concatenation of every input the rendering reads (see `lateralShapeKey` in
 * the strategy). Storage is process-wide and bounded; beyond the bound a shape is rendered
 * uncached, exactly as before. Gated by the SAME opt-in switch as the other query-build caches
 * (`MockRowCache.setEnabled`): the host application decides once at boot whether query-build
 * caches may retain state. With the switch off nothing is looked up or stored.
 */
export class LateralSqlCache {
  /** Hard bound on retained shapes — beyond it, shapes are rendered uncached. */
  static readonly MAX_ENTRIES = 2_000;

  private static entries = new Map<string, LateralSqlEntry>();
  private static nextId = 1;

  private constructor() {
    // static class — never instantiated
  }

  static isEnabled(): boolean {
    return MockRowCache.isEnabled();
  }

  static get(key: string): LateralSqlEntry | undefined {
    return LateralSqlCache.entries.get(key);
  }

  /**
   * Retains a rendered shape while the bound allows. Returns the entry either way; an entry
   * that was NOT retained carries id 0, which tells an enclosing shape to key on the text.
   */
  static store(key: string, rendered: Omit<LateralSqlEntry, 'id'>): LateralSqlEntry {
    if (LateralSqlCache.entries.size >= LateralSqlCache.MAX_ENTRIES) {
      return { id: 0, ...rendered };
    }

    const entry: LateralSqlEntry = { id: LateralSqlCache.nextId++, ...rendered };
    LateralSqlCache.entries.set(key, entry);

    return entry;
  }

  /** Runtime visibility: switch state plus current/max retained-shape counts. */
  static diagnostics(): { enabled: boolean; entries: number; maxEntries: number } {
    return {
      enabled: MockRowCache.isEnabled(),
      entries: LateralSqlCache.entries.size,
      maxEntries: LateralSqlCache.MAX_ENTRIES,
    };
  }

  /** Test seam: drops every retained shape (the switch itself lives on MockRowCache). Ids stay monotonic. */
  static reset(): void {
    LateralSqlCache.entries.clear();
  }
}
