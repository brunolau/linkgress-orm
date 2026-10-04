/**
 * Static switch + storage for the mock-row prototype cache — shared by
 * `ReferenceQueryBuilder.createMockTargetRow`, `SelectQueryBuilder._createMockRow`
 * and `CollectionQueryBuilder.createMockItem`.
 *
 * The cache is a pure optimization: the column/relation getters of a mock row are
 * built once per signature onto a shared PROTOTYPE object, and every mock row of that
 * signature is `Object.create(prototype)` plus its own symbol-keyed state slots.
 * Semantics are identical either way; with the switch OFF every row still gets a fresh
 * prototype (built and discarded per row — the pre-0.4.66 memory profile, nothing
 * retained beyond a row's lifetime).
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
  /** The model each schema registry belongs to (see {@link registerModel}), as its id. */
  private static registryModels = new WeakMap<object, number>();
  private static modelIds = new WeakMap<object, number>();
  private static nextModelId = 1;

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

  /**
   * Tells the cache which MODEL a context's schema registry holds: `model` is what identifies it — the
   * context CLASS of an entity-first context (every instance configures the same entities). A cached prototype
   * holds what its builder read of ITS model — the registry its navigations resolve their targets in, a
   * navigation's column mappers, a collection item's — so the cache keys carry the model ({@link modelKey}): two
   * entity-first models that name a table alike (two context classes in one process) each get prototypes of
   * their own. Keyed by table name alone, the second model's rows read the first one's. A registry nobody
   * registered — a schema-first context's, whose schema object may be made per instance — keeps the key it had:
   * the table name alone (`m0`).
   * @internal
   */
  static registerModel(registry: object, model: object): void {
    let id = MockRowCache.modelIds.get(model);

    if (id === undefined) {
      id = MockRowCache.nextModelId++;
      MockRowCache.modelIds.set(model, id);
    }

    MockRowCache.registryModels.set(registry, id);
  }

  /** The part of a cache key that tells models apart; `m0` for a builder without a registered registry. @internal */
  static modelKey(registry: object | undefined): string {
    return `m${(registry === undefined ? undefined : MockRowCache.registryModels.get(registry)) ?? 0}`;
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
