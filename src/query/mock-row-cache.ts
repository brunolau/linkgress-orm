/**
 * Static switch + storage for the reference mock-row prototype cache (see
 * `ReferenceQueryBuilder.createMockTargetRow`).
 *
 * The cache is a pure optimization: the column/relation getters of a reference mock row are
 * built once per (schema, alias, navigation-path) signature onto a shared PROTOTYPE object,
 * and every mock row of that signature is `Object.create(prototype)` plus its own two
 * symbol-keyed state slots. Semantics are identical either way; with the switch OFF every row
 * still gets a fresh prototype (built and discarded per row — the pre-0.4.66 memory profile,
 * nothing retained beyond a row's lifetime).
 *
 * Why a prototype and not a shared descriptor map (0.4.66): applying a shared map still cost
 * one `Object.defineProperties` per row — `O(columns + relations)` property definitions —
 * which stayed the single largest CPU item of a query build under load (~6 ms per order
 * request on the gopass-eshop checkout burst, ~40 % of the remaining per-request CPU).
 * Inheriting the getters makes a new row `O(1)`.
 *
 * Deliberately a STATIC, programmatic switch the HOST APPLICATION flips at boot from its
 * own configuration — the library itself stays free of environment access so it remains
 * runtime-agnostic (Node, Bun) and testable. Default: OFF.
 */
export class MockRowCache {
  /** Hard bound on retained signature entries — beyond it, rows are built uncached. */
  static readonly MAX_ENTRIES = 2_000;

  private static enabled = false;
  private static prototypes = new Map<string, object>();

  private constructor() {
    // static class — never instantiated
  }

  /** Enables/disables the cross-row prototype cache. Takes effect on the next `createMockTargetRow` call. */
  static setEnabled(value: boolean): void {
    MockRowCache.enabled = value === true;
  }

  static isEnabled(): boolean {
    return MockRowCache.enabled;
  }

  /**
   * Cached prototype lookup: returns the shared prototype object for a signature, building
   * and storing it on first use (while the switch is on and the entry bound is not
   * exceeded). With the switch off, a FRESH prototype is built per call.
   */
  static getOrBuild(cacheKey: string, build: () => object): object {
    if (!MockRowCache.enabled) {
      return build();
    }

    let cached = MockRowCache.prototypes.get(cacheKey);

    if (cached == null) {
      cached = build();

      if (MockRowCache.prototypes.size < MockRowCache.MAX_ENTRIES) {
        MockRowCache.prototypes.set(cacheKey, cached);
      }
    }

    return cached;
  }

  /** Runtime visibility: switch state plus current/max signature-entry counts. */
  static diagnostics(): { enabled: boolean; entries: number; maxEntries: number } {
    return {
      enabled: MockRowCache.enabled,
      entries: MockRowCache.prototypes.size,
      maxEntries: MockRowCache.MAX_ENTRIES,
    };
  }

  /** Test seam: drops all retained entries and disables the switch (restores the default state). */
  static reset(): void {
    MockRowCache.enabled = false;
    MockRowCache.prototypes.clear();
  }
}
