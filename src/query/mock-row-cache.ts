/**
 * Static switch + storage for the reference mock-row descriptor cache (see
 * `ReferenceQueryBuilder.createMockTargetRow`).
 *
 * The cache is a pure optimization: property descriptors for mock rows are built once per
 * (schema, alias, navigation-path) signature instead of once per row. Semantics are
 * identical either way; with the switch OFF every row gets a fresh descriptor set and
 * nothing is retained beyond a row's lifetime (the pre-0.4.66 memory profile).
 *
 * Deliberately a STATIC, programmatic switch the HOST APPLICATION flips at boot from its
 * own configuration — the library itself stays free of environment access so it remains
 * runtime-agnostic (Node, Bun) and testable. Default: OFF.
 */
export class MockRowCache {
  /** Hard bound on retained signature entries — beyond it, rows are built uncached. */
  static readonly MAX_ENTRIES = 2_000;

  private static enabled = false;
  private static descriptors = new Map<string, PropertyDescriptorMap>();

  private constructor() {
    // static class — never instantiated
  }

  /** Enables/disables the cross-row descriptor cache. Takes effect on the next `createMockTargetRow` call. */
  static setEnabled(value: boolean): void {
    MockRowCache.enabled = value === true;
  }

  static isEnabled(): boolean {
    return MockRowCache.enabled;
  }

  /**
   * Cached descriptor lookup: returns the shared `PropertyDescriptorMap` for a signature,
   * building and storing it on first use (while the switch is on and the entry bound is
   * not exceeded). With the switch off, a FRESH descriptor map is built per call.
   */
  static getOrBuild(cacheKey: string, build: () => PropertyDescriptorMap): PropertyDescriptorMap {
    if (!MockRowCache.enabled) {
      return build();
    }

    let cached = MockRowCache.descriptors.get(cacheKey);

    if (cached == null) {
      cached = build();

      if (MockRowCache.descriptors.size < MockRowCache.MAX_ENTRIES) {
        MockRowCache.descriptors.set(cacheKey, cached);
      }
    }

    return cached;
  }

  /** Runtime visibility: switch state plus current/max signature-entry counts. */
  static diagnostics(): { enabled: boolean; entries: number; maxEntries: number } {
    return {
      enabled: MockRowCache.enabled,
      entries: MockRowCache.descriptors.size,
      maxEntries: MockRowCache.MAX_ENTRIES,
    };
  }

  /** Test seam: drops all retained entries and disables the switch (restores the default state). */
  static reset(): void {
    MockRowCache.enabled = false;
    MockRowCache.descriptors.clear();
  }
}
