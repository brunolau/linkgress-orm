import { Catalog, Relation } from '../catalog/catalog';
import { Executor } from '../exec/executor';
import { StatementState } from '../exec/runtime';
import type { Session } from '../session';
import { SessionHost } from '../session';
import { Tuple } from '../storage/mvcc';

/** Helper giving DDL code an executor over the current (possibly private) catalog. */
export class DdlContext {
  readonly st: StatementState;
  readonly host: SessionHost;
  readonly executor: Executor;

  constructor(
    readonly session: Session,
    catalog: Catalog,
    params: unknown[] = [],
    paramTypes: number[] = []
  ) {
    const snapshot = session.takeSnapshot();
    snapshot.curCid = session.txn!.cid + 1;
    this.st = new StatementState(session, catalog, params, paramTypes, snapshot);
    this.st.cid = session.txn!.cid;
    this.host = new SessionHost(session, this.st);
    this.executor = new Executor(this.st, this.host);
    this.host.executor = this.executor;
  }

  /** Visible tuples of a relation (including its partitions). */
  visibleTuples(rel: Relation): { rel: Relation; tuple: Tuple }[] {
    const out: { rel: Relation; tuple: Tuple }[] = [];
    const vis = this.session.db.store.vis;
    for (const part of this.host.relationHeaps(rel, true, this.st)) {
      for (const t of part.heap.tuples) {
        if (vis.visible(t, this.st.snapshot)) {
          out.push({ rel: part.rel, tuple: t });
        }
      }
    }
    return out;
  }
}
