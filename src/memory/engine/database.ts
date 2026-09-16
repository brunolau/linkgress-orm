import { BuiltinCatalog, Catalog, OidAllocator } from './catalog/catalog';
import { ParsedStatement } from './ast';
import { parseSql } from './parser-ddl';
import { Store } from './storage/store';
import { Session } from './session';

/** Statement texts whose parse tree (and, through it, their analysis) is kept. */
const PARSE_CACHE_MAX = 8000;

export interface InMemoryDatabaseOptions {
  /** database name reported by current_database() (default "postgres") */
  databaseName?: string;
  /** user name (default "postgres") */
  userName?: string;
  /** session TimeZone default (default: the process' local IANA zone) */
  timeZone?: string;
  /**
   * Default text collation: "C" for bytewise ordering, or a BCP 47 locale (default "en-US")
   * approximating a libc/ICU linguistic collation.
   */
  collation?: string;
  /** default settings (GUC name -> value) */
  settings?: Record<string, string>;
}

let processNextPid = 10000;

/**
 * An in-memory PostgreSQL-compatible database shared by any number of sessions (connections).
 */
export class Database {
  readonly builtin = BuiltinCatalog.get();
  readonly store = new Store();
  readonly oids = new OidAllocator();
  /** committed catalog */
  catalog: Catalog;
  readonly options: Required<Omit<InMemoryDatabaseOptions, 'settings'>> & { settings: Record<string, string> };
  private nextPid = 10000;
  readonly sessions = new Set<Session>();
  /** transaction id holding the DDL lock */
  ddlLockHolder = 0;
  /** advisory locks: key -> holder session pid & count */
  advisoryLocks = new Map<string, { pid: number; count: number; xact: number }>();
  private parseCache = new Map<string, ParsedStatement[]>();
  /** channels -> listening sessions */
  readonly listeners = new Map<string, Set<Session>>();

  constructor(options: InMemoryDatabaseOptions = {}) {
    this.catalog = new Catalog(this.builtin);
    let tz = options.timeZone;
    if (!tz) {
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        tz = 'UTC';
      }
    }
    this.options = {
      databaseName: options.databaseName ?? 'postgres',
      userName: options.userName ?? 'postgres',
      timeZone: tz,
      collation: options.collation ?? 'en-US',
      settings: options.settings ?? {},
    };
  }

  allocatePid(): number {
    // unique across the databases of the process (cancel requests find a backend by pid alone)
    this.nextPid = Math.max(this.nextPid, processNextPid);
    processNextPid = this.nextPid + 1;
    return this.nextPid++;
  }

  createSession(): Session {
    const s = new Session(this);
    this.sessions.add(s);
    return s;
  }

  closeSession(s: Session): void {
    s.terminate();
    this.sessions.delete(s);
  }

  /**
   * Called when a transaction ends: removes versions no transaction can see any more from the heaps
   * written since (like autovacuum). A version deleted by xid X is kept while X is at or above the
   * horizon: the oldest running transaction and, for every open REPEATABLE READ / SERIALIZABLE
   * snapshot, the oldest transaction it saw as running (or its xmax).
   */
  autovacuum(): void {
    let horizon = this.store.txns.oldestRunning();
    for (const s of this.sessions) {
      const snap = s.heldSnapshot();
      if (!snap) {
        continue;
      }
      horizon = Math.min(horizon, snap.xmax);
      for (const x of snap.xip) {
        horizon = Math.min(horizon, x);
      }
    }
    this.store.autovacuum(horizon);
  }

  /** Diagnostics: sizes of the structures a long-lived database accumulates. */
  stats(): Record<string, number> {
    let liveTuples = 0;
    let allTuples = 0;
    let heaps = 0;
    let indexEntries = 0;
    const heapsSeen = new Set<number>();
    for (const rel of this.catalog.relations.values()) {
      if (!rel.storageId || heapsSeen.has(rel.storageId)) {
        continue;
      }
      heapsSeen.add(rel.storageId);
      const h = this.store.getHeap(rel.storageId);
      heaps++;
      allTuples += h.tuples.length;
      liveTuples += h.tuples.filter((t) => t.xmax === 0).length;
      for (const e of h.indexCache.values()) {
        indexEntries += e.map.size;
      }
    }
    let storedExprCacheEntries = 0;
    for (const rel of this.catalog.relations.values()) {
      for (const c of rel.columns) {
        storedExprCacheEntries += Object.keys(c.defaultExpr?.cache ?? {}).length;
      }
    }
    return {
      heaps,
      allTuples,
      liveTuples,
      indexEntries,
      parseCache: this.parseCache.size,
      sessions: this.sessions.size,
      xids: this.store.txns.nextXid,
      catalogVersion: this.catalog.version,
      relations: this.catalog.relations.size,
      storedExprCacheEntries,
    };
  }

  parse(sql: string): ParsedStatement[] {
    const cached = this.parseCache.get(sql);
    if (cached) {
      // Re-inserted so the Map's insertion order is recency order (see the eviction below).
      this.parseCache.delete(sql);
      this.parseCache.set(sql, cached);
      return cached;
    }
    const parsed = parseSql(sql);
    this.parseCache.set(sql, parsed);
    // Evict the least recently used one, never the whole cache: the analyzed form of a statement
    // hangs off its parse tree, so clearing threw away every prepared statement's analysis at once
    // and a workload with more distinct texts than the cap re-parsed AND re-analyzed everything it
    // came back to. A test suite is exactly that workload.
    while (this.parseCache.size > PARSE_CACHE_MAX) {
      const oldest = this.parseCache.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      this.parseCache.delete(oldest);
    }

    return parsed;
  }
}
