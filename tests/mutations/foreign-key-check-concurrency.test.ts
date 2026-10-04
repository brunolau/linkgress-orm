import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig, eq, integer, literal, notExists, serial, text } from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';

/**
 * The foreign-key check of a statement that writes a referencing row while ANOTHER transaction holds the referenced
 * row. PostgreSQL's check (RI_FKey_check) is `SELECT 1 FROM ONLY <referenced> WHERE <key> FOR KEY SHARE` on a
 * snapshot of its own:
 *
 *  - a parent another transaction inserted and has not committed is not there: 23503 at once — it never waits for it;
 *  - a parent another transaction deletes, whose key it changes, or that it holds FOR UPDATE: the check waits for
 *    that transaction, then finds the parent gone (a committed delete or key change: 23503) or there (a rollback, a
 *    released lock: the row is written) — also a parent it updated (no key change) and then deleted: the lock
 *    follows the update chain;
 *  - a non-key update and the weaker locks (FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE) do not conflict: written at
 *    once.
 *
 * The in-memory engine waited for the uncommitted parent (a statement of a second session inside a transaction that
 * had just inserted the parent hung until cancelled, where PostgreSQL raises 23503), wrote over a pending delete or
 * key change at once — a child of a parent that was then deleted —, let FOR UPDATE take a parent a check held, and
 * failed with XX000 a COMMIT whose deferred check had to wait. The matrix: the writer's isolation (an autocommit
 * statement under READ COMMITTED; a REPEATABLE READ transaction whose snapshot predates the holder's action) × the
 * holder's action × how it ends (commit / rollback) × how the referencing row is written (INSERT, an UPDATE of the
 * foreign key, a data-modifying CTE read back, an INSERT under a DEFERRABLE INITIALLY DEFERRED foreign key — checked
 * at COMMIT, which waits like the statement would); and the other order — the writer references the parent first
 * and keeps its transaction open (its check holds the parent FOR KEY SHARE), the holder acts after it. The ORACLE:
 * PostgreSQL's rule — and no child without its parent, ever. Under REPEATABLE READ a parent deleted or re-keyed by a
 * transaction that committed after the writer's snapshot is a serialization failure on PostgreSQL (40001); the
 * in-memory engine, which models none, refuses the write as 23503 — an error on both, never an orphan.
 *
 * Needs a second session beside an open transaction — PGlite runs one: skipped there, like the suite's other
 * two-session cases.
 */

class FkcParent extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class FkcChild extends DbEntity {
  id!: DbColumn<number>;
  parentId!: DbColumn<number>;
  note!: DbColumn<string>;
  parent?: FkcParent;
}

class FkcDatabase extends DbContext {
  get parents(): DbEntityTable<FkcParent> {
    return this.table(FkcParent);
  }

  get children(): DbEntityTable<FkcChild> {
    return this.table(FkcChild);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(FkcParent, entity => {
      entity.toTable('fkc_parents');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(text('name')).isRequired();
    });

    model.entity(FkcChild, entity => {
      entity.toTable('fkc_children');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
      entity.property(e => e.note).hasType(text('note')).isRequired();
      entity.hasOne(e => e.parent, () => FkcParent).withForeignKey(c => c.parentId).withPrincipalKey(p => p.id);
    });
  }
}

const PGLITE = process.env.LINKGRESS_TEST_DRIVER === 'pglite';
const MEMORY = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory';

/** The parent every case writes a child of; parent 1 holds the child an UPDATE moves */
const HELD = 2;

type Action =
  | 'insert' | 'delete' | 'key-update' | 'non-key-update' | 'non-key-update, then delete'
  | 'for-update' | 'for-no-key-update' | 'for-share' | 'for-key-share';
type End = 'commit' | 'rollback';
type Write = 'insert' | 'update' | 'cte' | 'deferred';
type Isolation = 'read committed' | 'repeatable read';
type Outcome = 'written' | '23503' | 'serialization';

/** What the holder does to the parent, in its open transaction */
const ACTIONS: Record<Action, string[]> = {
  insert: [`INSERT INTO fkc_parents (id, name) VALUES (${HELD}, 'held')`],
  delete: [`DELETE FROM fkc_parents WHERE id = ${HELD}`],
  'key-update': [`UPDATE fkc_parents SET id = ${HELD + 100} WHERE id = ${HELD}`],
  'non-key-update': [`UPDATE fkc_parents SET name = 'renamed' WHERE id = ${HELD}`],
  'non-key-update, then delete': [`UPDATE fkc_parents SET name = 'renamed' WHERE id = ${HELD}`, `DELETE FROM fkc_parents WHERE id = ${HELD}`],
  'for-update': [`SELECT id FROM fkc_parents WHERE id = ${HELD} FOR UPDATE`],
  'for-no-key-update': [`SELECT id FROM fkc_parents WHERE id = ${HELD} FOR NO KEY UPDATE`],
  'for-share': [`SELECT id FROM fkc_parents WHERE id = ${HELD} FOR SHARE`],
  'for-key-share': [`SELECT id FROM fkc_parents WHERE id = ${HELD} FOR KEY SHARE`],
};

/** PostgreSQL's rule: whether the referencing write waits for the holder, and its outcome after each end (READ COMMITTED) */
const RULE: Record<Action, { waits: boolean; commit: Outcome; rollback: Outcome }> = {
  insert: { waits: false, commit: '23503', rollback: '23503' },
  delete: { waits: true, commit: '23503', rollback: 'written' },
  'key-update': { waits: true, commit: '23503', rollback: 'written' },
  'non-key-update': { waits: false, commit: 'written', rollback: 'written' },
  'non-key-update, then delete': { waits: true, commit: '23503', rollback: 'written' },
  'for-update': { waits: true, commit: 'written', rollback: 'written' },
  'for-no-key-update': { waits: false, commit: 'written', rollback: 'written' },
  'for-share': { waits: false, commit: 'written', rollback: 'written' },
  'for-key-share': { waits: false, commit: 'written', rollback: 'written' },
};

/** REPEATABLE READ: the parent a committed delete or key change took is a serialization failure, not a missing row */
const ruleOf = (isolation: Isolation, action: Action) => (isolation === 'repeatable read' && RULE[action].commit === '23503' && action !== 'insert'
  ? { ...RULE[action], commit: 'serialization' as Outcome }
  : RULE[action]);

const ACTION_KINDS = Object.keys(ACTIONS) as Action[];
const ENDS: End[] = ['commit', 'rollback'];
const WRITES: Write[] = ['insert', 'update', 'cte', 'deferred'];
const ISOLATIONS: Isolation[] = ['read committed', 'repeatable read'];

/** How long a write that waits stays pending before the holder ends; how long one that does not may take */
const WAITS_FOR_MS = 300;
const AT_ONCE_WITHIN_MS = 5000;

const PENDING = Symbol('pending');

const settleWithin = async (work: Promise<unknown>, ms: number): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise(resolve => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });

  try {
    return await Promise.race([work, pending]);
  } finally {
    clearTimeout(timer);
  }
};

describe('a foreign-key check while another transaction holds the referenced row', () => {
  let holderClient: DatabaseClient;
  let writerClient: DatabaseClient;
  let db: FkcDatabase;
  let writer: FkcDatabase;

  const reset = async (action: Action) => {
    await holderClient.query('DELETE FROM fkc_deferred');
    await holderClient.query('DELETE FROM fkc_children');
    await holderClient.query('DELETE FROM fkc_parents');
    await db.parents.insertBulk(action === 'insert' ? [{ id: 1, name: 'one' }] : [{ id: 1, name: 'one' }, { id: HELD, name: 'held' }]);
    await db.children.insertBulk([{ parentId: 1, note: 'moved by an update' }]);
  };

  /** The referencing write, on the second session (`on`: its root context or a transaction's): the child it wrote, or the error */
  const write = (kind: Write, on: FkcDatabase = writer): Promise<unknown> => {
    switch (kind) {
      case 'insert':
        return Promise.resolve(on.children.insert({ parentId: HELD, note: 'inserted' }).returning(c => ({ parentId: c.parentId })))
          .then(row => [row.parentId], error => error);
      case 'update':
        return Promise.resolve(on.children.where(c => eq(c.parentId, 1)).update({ parentId: HELD }).returning(c => ({ parentId: c.parentId })))
          .then(rows => rows.map(r => r.parentId), error => error);
      case 'cte': {
        const added = new DbCteBuilder().withMutation('fkc_added', on.children
          .insertBulk([{ parentId: HELD, note: 'inserted by a CTE' }])
          .toStatement(c => ({ parentId: c.parentId })));

        return on.selectFromCte(added.cte).select(r => ({ parentId: r.parentId })).toList()
          .then(rows => rows.map(r => r.parentId), error => error);
      }
      case 'deferred': {
        // the schema manager declares no DEFERRABLE foreign key: the table is created by DDL (beforeAll)
        const insert = (context: FkcDatabase) => context
          .query<{ parent_id: number }>('INSERT INTO fkc_deferred (parent_id, note) VALUES ($1, $2) RETURNING parent_id', [HELD, 'checked at commit'])
          .then(rows => rows.map(r => r.parent_id));

        // checked at COMMIT — of a transaction of its own, or of the one it runs in
        return (on === writer ? writer.transaction(trx => insert(trx)) : insert(on)).then(value => value, error => error);
      }
    }
  };

  /**
   * The write in a REPEATABLE READ transaction of the second session whose snapshot is taken BEFORE the holder acts:
   * `snapshot` resolves once it is taken, `act()` lets the write go. A failed write rolls the transaction back.
   */
  const writeInRepeatableRead = (kind: Write) => {
    let act!: () => void;
    let taken!: () => void;
    const acted = new Promise<void>(resolve => {
      act = resolve;
    });
    const snapshot = new Promise<void>(resolve => {
      taken = resolve;
    });
    const written = writer.transaction(async trx => {
      await trx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await trx.query('SELECT count(*) FROM fkc_parents');
      taken();
      await acted;
      const outcome = await write(kind, trx);

      if (sqlStateOf(outcome) !== undefined) {
        throw outcome;
      }

      return outcome;
    }).then(value => value, error => error);

    return { snapshot, act, written };
  };

  const orphans = async () => await db.children
    .where(c => notExists(db.parents.where(p => eq(p.id, c.parentId)).select(() => ({ one: literal(1) })).asSubquery()))
    .count()
    + Number((await holderClient.query('SELECT count(*) AS n FROM fkc_deferred d WHERE NOT EXISTS (SELECT 1 FROM fkc_parents p WHERE p.id = d.parent_id)')).rows[0].n);

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    holderClient = createFreshClient();
    writerClient = createFreshClient();
    db = new FkcDatabase(holderClient);
    writer = new FkcDatabase(writerClient);
    await holderClient.query('DROP TABLE IF EXISTS fkc_deferred, fkc_children, fkc_parents CASCADE');
    await db.getSchemaManager().ensureCreated();
    await holderClient.query(
      'CREATE TABLE fkc_deferred (id serial PRIMARY KEY, parent_id integer NOT NULL REFERENCES fkc_parents (id) DEFERRABLE INITIALLY DEFERRED, note text NOT NULL)'
    );
  });

  afterAll(async () => {
    await holderClient.query('DROP TABLE IF EXISTS fkc_deferred, fkc_children, fkc_parents CASCADE');
    await writer.dispose();
    await db.dispose();
  });

  for (const isolation of ISOLATIONS) {
    for (const action of ACTION_KINDS) {
      for (const end of ENDS) {
        for (const kind of WRITES) {
          const rule = ruleOf(isolation, action);

          test.skipIf(PGLITE)(`${isolation} | ${action} | ${end} | ${kind}: ${rule.waits ? 'waits, then ' : 'at once: '}${rule[end]}`, async () => {
            await reset(action);
            let written!: Promise<unknown>;
            const ROLLBACK = new Error('roll back');
            const repeatable = isolation === 'repeatable read' ? writeInRepeatableRead(kind) : undefined;
            await repeatable?.snapshot;

            const holder = holderClient.transaction(async query => {
              for (const statement of ACTIONS[action]) {
                await query(statement);
              }

              if (repeatable) {
                written = repeatable.written;
                repeatable.act();
              } else {
                written = write(kind);
              }

              const early = await settleWithin(written, rule.waits ? WAITS_FOR_MS : AT_ONCE_WITHIN_MS);

              // a write that waits is still waiting; one that does not has finished while the holder is still open
              expect(early === PENDING).toBe(rule.waits);

              if (end === 'rollback') {
                throw ROLLBACK;
              }
            });

            try {
              await holder;
            } catch (error) {
              if (error !== ROLLBACK) {
                throw error;
              }
            }

            const outcome = await written;
            const expected = rule[end];

            if (expected === 'written') {
              expect(outcome).toEqual([HELD]);
            } else {
              // the in-memory engine models no serialization failure: it refuses the write as a missing parent
              expect(sqlStateOf(outcome)).toBe(expected === 'serialization' ? (MEMORY ? '23503' : '40001') : '23503');
            }

            expect(await orphans()).toBe(0);
          });
        }
      }
    }
  }

  /**
   * The other order: the writer references the parent first, in a transaction it keeps open — its check holds the
   * parent FOR KEY SHARE until it ends — and the holder acts after it. A delete, a key change or FOR UPDATE waits for
   * the writer, then meets its child (the writer committed: 23503 for a delete or key change) or not (it rolled
   * back); a non-key update and the weaker locks do not wait — a delete the holder makes after its non-key update
   * does: the lock follows the row to its new version.
   */
  const WRITER_FIRST: Record<Exclude<Action, 'insert'>, { waits: boolean; commit: 'done' | '23503'; rollback: 'done' | '23503' }> = {
    delete: { waits: true, commit: '23503', rollback: 'done' },
    'key-update': { waits: true, commit: '23503', rollback: 'done' },
    'non-key-update': { waits: false, commit: 'done', rollback: 'done' },
    'non-key-update, then delete': { waits: true, commit: '23503', rollback: 'done' },
    'for-update': { waits: true, commit: 'done', rollback: 'done' },
    'for-no-key-update': { waits: false, commit: 'done', rollback: 'done' },
    'for-share': { waits: false, commit: 'done', rollback: 'done' },
    'for-key-share': { waits: false, commit: 'done', rollback: 'done' },
  };

  for (const action of ACTION_KINDS.filter((a): a is Exclude<Action, 'insert'> => a !== 'insert')) {
    for (const end of ENDS) {
      // a deferred check holds nothing until COMMIT
      for (const kind of WRITES.filter(w => w !== 'deferred')) {
        const rule = WRITER_FIRST[action];

        test.skipIf(PGLITE)(`writer first | ${action} | the writer ${end === 'commit' ? 'commits' : 'rolls back'} | ${kind}: the holder ${rule.waits ? 'waits, then ' : 'at once: '}${rule[end]}`, async () => {
          await reset(action);
          const ROLLBACK = new Error('roll back');
          let wrote!: (outcome: unknown) => void;
          let release!: () => void;
          const write1 = new Promise<unknown>(resolve => {
            wrote = resolve;
          });
          const released = new Promise<void>(resolve => {
            release = resolve;
          });

          const writing = writer.transaction(async trx => {
            const outcome = await write(kind, trx);
            wrote(outcome);
            await released;

            if (end === 'rollback') {
              throw ROLLBACK;
            }
          }).then(() => undefined, error => (error === ROLLBACK ? undefined : error));

          let acting!: Promise<unknown>;

          try {
            // the child is written (the check passed: the parent is there) and the writer's transaction stays open
            expect(await write1).toEqual([HELD]);

            acting = holderClient.transaction(async query => {
              for (const statement of ACTIONS[action]) {
                await query(statement);
              }
            }).then(() => 'done', error => error);
            const early = await settleWithin(acting, rule.waits ? WAITS_FOR_MS : AT_ONCE_WITHIN_MS);

            // a holder that waits is still waiting; one that does not has finished while the writer is still open
            expect(early === PENDING).toBe(rule.waits);
          } finally {
            release();
          }

          expect(await writing).toBeUndefined();
          const outcome = await acting;

          if (rule[end] === 'done') {
            expect(outcome).toBe('done');
          } else {
            expect(sqlStateOf(outcome)).toBe('23503');
          }

          expect(await orphans()).toBe(0);
        });
      }
    }
  }
});
