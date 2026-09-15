import { PgError, SqlState } from '../errors';
import { Heap, INVALID_XID, LockStrength, TransactionTable, Tuple, Visibility, WaitForTransaction } from './mvcc';

/** Physical storage of a database: heaps by storage id, transaction status, visibility rules. */
export class Store {
  readonly txns = new TransactionTable();
  readonly vis = new Visibility(this.txns);
  private heaps = new Map<number, Heap>();
  private nextStorageId = 1;

  createHeap(): Heap {
    const h = new Heap(this.nextStorageId++);
    this.heaps.set(h.storageId, h);
    return h;
  }

  getHeap(storageId: number): Heap {
    let h = this.heaps.get(storageId);
    if (!h) {
      h = new Heap(storageId);
      this.heaps.set(storageId, h);
    }
    return h;
  }

  dropHeap(storageId: number): void {
    this.heaps.delete(storageId);
  }

  /** Recreate a heap holding frozen (visible to everyone) rows, in physical order (snapshots). */
  restoreHeap(storageId: number, rows: unknown[][]): Heap {
    const h = new Heap(storageId);
    h.restoreFrozen(rows);
    this.heaps.set(storageId, h);
    if (storageId >= this.nextStorageId) {
      this.nextStorageId = storageId + 1;
    }
    return h;
  }

  /** Copy all tuples visible to `snapshotXids` into a fresh heap (table rewrite). */
  cloneHeap(src: Heap): Heap {
    const h = this.createHeap();
    for (const t of src.tuples) {
      h.tuples.push({ ...t, next: null });
    }
    return h;
  }
}

const LOCK_CONFLICTS: Record<LockStrength, LockStrength[]> = {
  'KEY SHARE': ['UPDATE'],
  SHARE: ['NO KEY UPDATE', 'UPDATE'],
  'NO KEY UPDATE': ['SHARE', 'NO KEY UPDATE', 'UPDATE'],
  UPDATE: ['KEY SHARE', 'SHARE', 'NO KEY UPDATE', 'UPDATE'],
};

export type LockOutcome = 'ok' | 'skip' | 'deleted' | { updatedTo: Tuple };

/**
 * Acquire a row lock (or check write access) on a tuple version for transaction `xid`.
 * Throws WaitForTransaction when another running transaction holds a conflicting lock.
 */
export function lockTuple(
  store: Store,
  tuple: Tuple,
  xid: number,
  strength: LockStrength,
  waitPolicy: 'BLOCK' | 'SKIP' | 'NOWAIT',
  relName: string,
  recordLock: boolean
): LockOutcome {
  const txns = store.txns;
  // `xid` may be a subtransaction: rows updated or locked by any (sub)transaction of the same
  // top-level transaction are our own (e.g. locked by a statement inside a released savepoint)
  const myTop = txns.topLevel(xid);
  // updated/deleted by someone else?
  if (tuple.xmax !== INVALID_XID) {
    const top = txns.topLevel(tuple.xmax);
    const status = txns.getStatus(tuple.xmax);
    if (top !== myTop && status === 'running') {
      if (waitPolicy === 'NOWAIT') {
        throw new PgError(SqlState.LOCK_NOT_AVAILABLE, `could not obtain lock on row in relation "${relName}"`);
      }
      if (waitPolicy === 'SKIP') {
        return 'skip';
      }
      throw new WaitForTransaction(tuple.xmax, relName);
    }
    if (status === 'committed' && top !== myTop) {
      if (tuple.next) {
        return { updatedTo: tuple.next };
      }
      return 'deleted';
    }
  }
  if (tuple.locks) {
    for (const [holder, held] of tuple.locks) {
      const status = txns.getStatus(holder);
      if (status !== 'running') {
        tuple.locks.delete(holder);
        continue;
      }
      if (holder === xid || txns.topLevel(holder) === myTop) {
        continue;
      }
      if (LOCK_CONFLICTS[strength].includes(held)) {
        if (waitPolicy === 'NOWAIT') {
          throw new PgError(SqlState.LOCK_NOT_AVAILABLE, `could not obtain lock on row in relation "${relName}"`);
        }
        if (waitPolicy === 'SKIP') {
          return 'skip';
        }
        throw new WaitForTransaction(holder, relName);
      }
    }
  }
  if (recordLock) {
    if (!tuple.locks) {
      tuple.locks = new Map();
    }
    const existing = tuple.locks.get(xid);
    const rank = ['KEY SHARE', 'SHARE', 'NO KEY UPDATE', 'UPDATE'];
    if (!existing || rank.indexOf(existing) < rank.indexOf(strength)) {
      tuple.locks.set(xid, strength);
    }
  }
  return 'ok';
}
