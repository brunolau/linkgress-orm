import { MockRowCache } from './mock-row-cache';

export interface NavigationPathStep {
  alias: string;
  relation: any;
  sourceAlias: string;
}

/**
 * Memo for the transitive navigation-path search (`findNavigationPath`): the BFS over the
 * schema graph that resolves a projected alias which no directly-joined schema relates to.
 *
 * The search is a pure function of (schema registry, target alias, the ordered set of already
 * joined alias→table pairs), and the same query shapes ask the same question on every build —
 * on a real workload it was the single largest remaining query-build cost after the mock-row
 * prototype cache (~9 % of request CPU on the gopass-eshop `order/create` path).
 *
 * Storage is per registry (WeakMap, so a dropped DbContext frees its entries) and bounded.
 * Gated by the SAME opt-in switch as the mock-row cache (`MockRowCache.setEnabled`): the host
 * application already decides once at boot whether query-build caches may retain state.
 * With the switch off every call runs the search afresh, exactly as before.
 */
export class NavigationPathCache {
  /** Hard bound on retained paths across all registries — beyond it, paths are computed uncached. */
  static readonly MAX_ENTRIES = 5_000;

  private static byRegistry = new WeakMap<object, Map<string, NavigationPathStep[]>>();
  private static retained = 0;

  private constructor() {
    // static class — never instantiated
  }

  /**
   * Returns the memoised path for `key` under `registry`, computing and storing it on first use
   * (switch on, bound not exceeded). Always hands back a FRESH array — callers may keep or mutate
   * their copy without touching the retained one.
   */
  static getOrBuild(registry: object, key: string, build: () => NavigationPathStep[]): NavigationPathStep[] {
    if (!MockRowCache.isEnabled()) {
      return build();
    }

    let paths = NavigationPathCache.byRegistry.get(registry);

    if (paths == null) {
      paths = new Map();
      NavigationPathCache.byRegistry.set(registry, paths);
    }

    let cached = paths.get(key);

    if (cached == null) {
      cached = build();

      if (NavigationPathCache.retained < NavigationPathCache.MAX_ENTRIES) {
        paths.set(key, cached);
        NavigationPathCache.retained++;
      }
    }

    return cached.slice();
  }

  /** Runtime visibility: switch state plus retained-entry count. */
  static diagnostics(): { enabled: boolean; entries: number; maxEntries: number } {
    return {
      enabled: MockRowCache.isEnabled(),
      entries: NavigationPathCache.retained,
      maxEntries: NavigationPathCache.MAX_ENTRIES,
    };
  }

  /** Test seam: drops every retained path (the switch itself lives on MockRowCache). */
  static reset(): void {
    NavigationPathCache.byRegistry = new WeakMap();
    NavigationPathCache.retained = 0;
  }
}
