/**
 * MVCC storage modelled on PostgreSQL's heap:
 *  - every tuple carries xmin/cmin (creator) and xmax/cmax (deleter/updater)
 *  - UPDATE appends a new tuple version at the end of the heap and links the old version to it,
 *    so an unordered sequential scan returns rows in the same order PostgreSQL does for small tables
 *  - visibility follows HeapTupleSatisfiesMVCC; snapshots record in-progress transactions
 */

export const INVALID_XID = 0;
/** xid of rows restored from a snapshot: committed and older than every transaction */
export const FROZEN_XID = 2;

export interface Tuple {
  xmin: number;
  cmin: number;
  xmax: number;
  cmax: number;
  data: unknown[];
  /** newer version (UPDATE chain) */
  next: Tuple | null;
  /** heap position counter (stable identity, used for ctid-like ordering) */
  seq: number;
  /** tuple was removed by vacuum; kept only while referenced */
  vacuumed?: boolean;
  /** row locks held on this tuple version: xid -> strength */
  locks?: Map<number, LockStrength>;
  /** lock-only xmax a version was born with (the row ON CONFLICT DO UPDATE locked, then updated) */
  lockXmax?: number;
}

export type LockStrength = 'KEY SHARE' | 'SHARE' | 'NO KEY UPDATE' | 'UPDATE';

export type XidStatus = 'running' | 'committed' | 'aborted' | 'subcommitted';

export class TransactionTable {
  private nextXidValue = 1000;
  private status = new Map<number, XidStatus>();
  private parent = new Map<number, number>();
  private waiters = new Map<number, Array<() => void>>();
  readonly running = new Set<number>();

  get nextXid(): number {
    return this.nextXidValue;
  }

  begin(parentXid?: number): number {
    const xid = this.nextXidValue++;
    this.status.set(xid, 'running');
    if (parentXid !== undefined) {
      this.parent.set(xid, parentXid);
    } else {
      this.running.add(xid);
    }
    return xid;
  }

  topLevel(xid: number): number {
    let x = xid;
    let p = this.parent.get(x);
    while (p !== undefined) {
      x = p;
      p = this.parent.get(x);
    }
    return x;
  }

  /** Effective status (sub-committed subtransactions inherit their parent's status). */
  getStatus(xid: number): XidStatus {
    let x = xid;
    while (true) {
      const s = this.status.get(x);
      if (s === undefined) {
        // unknown / frozen xids (bootstrap) are committed
        return 'committed';
      }
      if (s !== 'subcommitted') {
        return s;
      }
      const p = this.parent.get(x);
      if (p === undefined) {
        return 'committed';
      }
      x = p;
    }
  }

  isCommitted(xid: number): boolean {
    return this.getStatus(xid) === 'committed';
  }

  isAborted(xid: number): boolean {
    return this.getStatus(xid) === 'aborted';
  }

  isRunning(xid: number): boolean {
    return this.getStatus(xid) === 'running';
  }

  commitSub(xid: number): void {
    this.status.set(xid, 'subcommitted');
  }

  abortSub(xid: number): void {
    this.status.set(xid, 'aborted');
    this.wake(xid);
  }

  commit(xid: number): void {
    this.status.set(xid, 'committed');
    this.running.delete(xid);
    this.wake(xid);
  }

  abort(xid: number): void {
    this.status.set(xid, 'aborted');
    this.running.delete(xid);
    this.wake(xid);
  }

  private wake(xid: number): void {
    const w = this.waiters.get(xid);
    if (w) {
      this.waiters.delete(xid);
      for (const fn of w) {
        fn();
      }
    }
  }

  /** Resolves when the top-level transaction owning xid finishes. */
  waitFor(xid: number): Promise<void> {
    const top = this.topLevel(xid);
    if (this.getStatus(top) !== 'running') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let list = this.waiters.get(top);
      if (!list) {
        list = [];
        this.waiters.set(top, list);
      }
      list.push(resolve);
    });
  }

  /** Smallest running top-level xid (for vacuum horizon). */
  oldestRunning(): number {
    let min = this.nextXidValue;
    for (const x of this.running) {
      if (x < min) {
        min = x;
      }
    }
    return min;
  }
}

export interface Snapshot {
  /** all xids >= xmax are invisible (not yet started when snapshot taken) */
  xmax: number;
  /** top-level xids running at snapshot time */
  xip: Set<number>;
  /** the snapshot owner's top-level xid (0 if none assigned) */
  ownXid: number;
  /** command id of the owner: tuples created with cmin >= curCid are invisible to it */
  curCid: number;
}

export class Visibility {
  constructor(private readonly txns: TransactionTable) {}

  private isOwn(xid: number, snap: Snapshot): boolean {
    return snap.ownXid !== INVALID_XID && this.txns.topLevel(xid) === snap.ownXid;
  }

  private inProgressAtSnapshot(xid: number, snap: Snapshot): boolean {
    if (xid >= snap.xmax) {
      return true;
    }
    return snap.xip.has(this.txns.topLevel(xid));
  }

  visible(t: Tuple, snap: Snapshot): boolean {
    const txns = this.txns;
    const xmin = t.xmin;
    if (this.isOwn(xmin, snap)) {
      if (txns.isAborted(xmin)) {
        return false;
      }
      if (t.cmin >= snap.curCid) {
        return false;
      }
      const xmax = t.xmax;
      if (xmax === INVALID_XID) {
        return true;
      }
      if (txns.isAborted(xmax)) {
        return true;
      }
      if (this.isOwn(xmax, snap)) {
        return t.cmax >= snap.curCid;
      }
      return true;
    }
    if (txns.getStatus(xmin) !== 'committed') {
      return false;
    }
    if (this.inProgressAtSnapshot(xmin, snap)) {
      return false;
    }
    const xmax = t.xmax;
    if (xmax === INVALID_XID) {
      return true;
    }
    if (this.isOwn(xmax, snap)) {
      if (txns.isAborted(xmax)) {
        return true;
      }
      return t.cmax >= snap.curCid;
    }
    if (txns.getStatus(xmax) !== 'committed') {
      return true;
    }
    if (this.inProgressAtSnapshot(xmax, snap)) {
      return true;
    }
    return false;
  }

  /** "Dirty" liveness used by unique checks: is the tuple possibly live for someone? */
  liveness(t: Tuple, ownXid: number): 'dead' | 'live' | { waitFor: number } {
    const txns = this.txns;
    const xminStatus = txns.getStatus(t.xmin);
    // ownXid may be a subtransaction: tuples of the whole top-level transaction are our own
    ownXid = ownXid !== INVALID_XID ? txns.topLevel(ownXid) : INVALID_XID;
    const ownXmin = ownXid !== INVALID_XID && txns.topLevel(t.xmin) === ownXid;
    if (xminStatus === 'aborted') {
      return 'dead';
    }
    if (xminStatus === 'running' && !ownXmin) {
      return { waitFor: t.xmin };
    }
    if (t.xmax === INVALID_XID) {
      return 'live';
    }
    const xmaxStatus = txns.getStatus(t.xmax);
    if (xmaxStatus === 'aborted') {
      return 'live';
    }
    const ownXmax = ownXid !== INVALID_XID && txns.topLevel(t.xmax) === ownXid;
    if (xmaxStatus === 'committed' || ownXmax) {
      return 'dead';
    }
    return { waitFor: t.xmax };
  }

  /** Tuple is dead to every possible snapshot (vacuumable). */
  isDeadForAll(t: Tuple, horizon: number): boolean {
    const txns = this.txns;
    if (txns.isAborted(t.xmin)) {
      return true;
    }
    if (t.xmax !== INVALID_XID && txns.isCommitted(t.xmax) && txns.topLevel(t.xmax) < horizon) {
      return true;
    }
    return false;
  }
}

/** A heap (the storage of one relation version / relfilenode). */
export class Heap {
  tuples: Tuple[] = [];
  private seqCounter = 0;
  /** incremented on every physical change (for cached index structures) */
  version = 0;
  /** versions that may be dead: deleted or replaced ones, and inserts of aborted transactions */
  deadCount = 0;
  /** horizon of the last vacuum pass that had to keep possibly-dead versions (0: none) */
  vacuumHorizon = 0;
  /**
   * Lazily built hash indexes over ALL tuple versions (visibility is checked by readers):
   * key spec -> map. Maintained incrementally on insert; invalidated by vacuum / undo.
   */
  indexCache = new Map<string, { version: number; map: Map<unknown, Tuple[]>; keyOf: (t: Tuple, ctx?: unknown) => unknown; needsContext: boolean }>();

  constructor(readonly storageId: number) {}

  /** Fill an empty heap with frozen rows (xmin = FrozenTransactionId). */
  restoreFrozen(rows: unknown[][]): void {
    for (const data of rows) {
      this.tuples.push({ xmin: FROZEN_XID, cmin: 0, xmax: INVALID_XID, cmax: 0, data, next: null, seq: this.seqCounter++ });
    }
    this.version++;
  }

  /**
   * `ctx` is the inserting statement: indexes whose keys evaluate expressions are maintained with it
   * (the closure that built them may belong to a finished statement); without one they are dropped.
   */
  insert(data: unknown[], xid: number, cid: number, ctx?: unknown): Tuple {
    const t: Tuple = { xmin: xid, cmin: cid, xmax: INVALID_XID, cmax: 0, data, next: null, seq: this.seqCounter++ };
    this.tuples.push(t);
    const prev = this.version++;
    for (const [spec, entry] of this.indexCache) {
      if (entry.version === prev) {
        if (entry.needsContext && ctx === undefined) {
          this.indexCache.delete(spec);
          continue;
        }
        const k = entry.keyOf(t, ctx);
        if (k !== undefined) {
          let list = entry.map.get(k);
          if (!list) {
            list = [];
            entry.map.set(k, list);
          }
          list.push(t);
        }
        entry.version = this.version;
      }
    }
    return t;
  }

  /** Append a new version replacing `old`. The caller has already verified the update is allowed. */
  update(old: Tuple, data: unknown[], xid: number, cid: number, ctx?: unknown): Tuple {
    old.xmax = xid;
    old.cmax = cid;
    const t = this.insert(data, xid, cid, ctx);
    old.next = t;
    this.deadCount++;
    return t;
  }

  delete(t: Tuple, xid: number, cid: number): void {
    t.xmax = xid;
    t.cmax = cid;
    this.deadCount++;
  }

  /** Get or build a cached index; `keyOf` returns undefined for tuples that are not indexed (e.g. NULL keys). */
  getIndex(spec: string, keyOf: (t: Tuple, ctx?: unknown) => unknown, needsContext = false): Map<unknown, Tuple[]> {
    const cached = this.indexCache.get(spec);
    if (cached && cached.version === this.version) {
      return cached.map;
    }
    const map = new Map<unknown, Tuple[]>();
    for (const t of this.tuples) {
      const k = keyOf(t);
      if (k === undefined) {
        continue;
      }
      let list = map.get(k);
      if (!list) {
        list = [];
        map.set(k, list);
      }
      list.push(t);
    }
    this.indexCache.set(spec, { version: this.version, map, keyOf, needsContext });
    return map;
  }

  invalidateIndexes(): void {
    this.indexCache.clear();
    this.version++;
  }

  /** Undo an insert: remove the tuple physically and from the cached indexes (instead of rebuilding them). */
  removeInserted(t: Tuple): void {
    const idx = this.tuples.lastIndexOf(t);
    if (idx < 0) {
      return;
    }
    this.tuples.splice(idx, 1);
    const prev = this.version++;
    for (const [spec, entry] of this.indexCache) {
      if (entry.version !== prev || entry.needsContext) {
        this.indexCache.delete(spec);
        continue;
      }
      const k = entry.keyOf(t);
      if (k !== undefined) {
        const list = entry.map.get(k);
        const i = list ? list.lastIndexOf(t) : -1;
        if (i < 0) {
          this.indexCache.delete(spec);
          continue;
        }
        list!.splice(i, 1);
        if (list!.length === 0) {
          entry.map.delete(k);
        }
      }
      entry.version = this.version;
    }
  }

  /** whether enough versions may be dead to make a pass worthwhile (autovacuum: 50 + 20 % of the tuples) */
  needsVacuum(): boolean {
    return this.deadCount >= VACUUM_BASE_THRESHOLD + this.tuples.length * VACUUM_SCALE_FACTOR;
  }

  /**
   * Remove tuples invisible to everyone, preserving the physical order of the remaining ones, when enough
   * versions may be dead (`needsVacuum`) and the horizon moved past the last pass that had to keep some.
   * An xmax of an aborted transaction is cleared on the way (its version is live). Returns whether
   * versions that may become removable remain.
   */
  vacuum(vis: Visibility, txns: TransactionTable, horizon: number): boolean {
    if (!this.needsVacuum()) {
      return false;
    }
    if (horizon <= this.vacuumHorizon) {
      return true;
    }
    const kept: Tuple[] = [];
    let pending = 0;
    for (const t of this.tuples) {
      if (vis.isDeadForAll(t, horizon)) {
        t.vacuumed = true;
        continue;
      }
      if (t.xmax !== INVALID_XID) {
        if (txns.isAborted(t.xmax)) {
          t.xmax = INVALID_XID;
          t.cmax = 0;
          t.next = null;
        } else {
          pending++;
        }
      }
      kept.push(t);
    }
    if (kept.length !== this.tuples.length) {
      this.tuples = kept;
      this.invalidateIndexes();
    }
    this.deadCount = pending;
    this.vacuumHorizon = pending > 0 ? horizon : 0;
    return this.needsVacuum();
  }
}

/** autovacuum_vacuum_threshold / autovacuum_vacuum_scale_factor */
const VACUUM_BASE_THRESHOLD = 50;
const VACUUM_SCALE_FACTOR = 0.2;

/** Undo log of physical tuple changes made by one statement (for lock-wait restarts). */
export class UndoLog {
  private entries: Array<{ kind: 'insert'; heap: Heap; tuple: Tuple } | { kind: 'xmax'; heap: Heap; tuple: Tuple; xmax: number; cmax: number; next: Tuple | null }> = [];

  recordInsert(heap: Heap, tuple: Tuple): void {
    this.entries.push({ kind: 'insert', heap, tuple });
  }

  recordXmax(heap: Heap, tuple: Tuple): void {
    this.entries.push({ kind: 'xmax', heap, tuple, xmax: tuple.xmax, cmax: tuple.cmax, next: tuple.next });
  }

  get length(): number {
    return this.entries.length;
  }

  /** Forget the recorded changes (they were committed and can no longer be undone). */
  clear(): void {
    this.entries = [];
  }

  rollback(): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === 'insert') {
        e.heap.removeInserted(e.tuple);
      } else {
        e.tuple.xmax = e.xmax;
        e.tuple.cmax = e.cmax;
        e.tuple.next = e.next;
      }
    }
    this.entries = [];
  }
}

/** Signal thrown by the executor when a statement must wait for another transaction and restart. */
export class WaitForTransaction {
  constructor(
    readonly xid: number,
    readonly relationName?: string
  ) {}
}

/** Signal thrown by pg_sleep: the session waits (honoring statement_timeout) then re-runs the statement. */
export class SleepRequest {
  constructor(readonly ms: number) {}
}
