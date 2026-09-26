import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  createCustomType, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, integer, ne, serial, smallint,
  text, timestamp, varchar,
} from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * PostgreSQL 18's `old` row in a mutation's RETURNING: `update(…).returning((row, old) => …)` and
 * `delete().returning((row, old) => …)`. `old.<column>` renders `old."<db_column>"` — the pre-update values of
 * an UPDATE, the deleted row of a DELETE — and reads back through the column's own mapper, as `row.<column>`
 * does. Runs on PostgreSQL 18 and on the in-memory engine.
 */

/** A wall-clock timestamp the mapper builds from whatever the driver hands back (Date or text). */
class WallClock {
  constructor(readonly text: string) {}
}

const pad = (n: number) => String(n).padStart(2, '0');

const wallClock = createCustomType<{ data: WallClock; driverData: string }>({
  dataType: () => 'timestamp',
  toDriver: (value: WallClock | null | undefined) => (value == null ? null : value.text) as any,
  fromDriver: (value: any) => {
    if (value == null) {
      return null as any;
    }
    if (value instanceof Date) {
      return new WallClock(`${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`);
    }
    return new WallClock(String(value).replace('T', ' ').slice(0, 19));
  },
});

class RoOwner extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class RoTask extends DbEntity {
  id!: DbColumn<number>;
  status!: DbColumn<number>;
  note?: DbColumn<string | null>;
  finishedAt?: DbColumn<WallClock | null>;
  ownerId!: DbColumn<number | null>;
  owner?: RoOwner;
}

class ReturningOldDatabase extends DbContext {
  get owners(): DbEntityTable<RoOwner> {
    return this.table(RoOwner);
  }

  get tasks(): DbEntityTable<RoTask> {
    return this.table(RoTask);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(RoOwner, entity => {
      entity.toTable('ro_owners');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 40)).isRequired();
    });

    model.entity(RoTask, entity => {
      entity.toTable('ro_tasks');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.status).hasType(smallint('status')).isRequired();
      entity.property(e => e.note).hasType(text('note'));
      entity.property(e => e.finishedAt).hasType(timestamp('finished_at')).hasCustomMapper(wallClock);
      entity.property(e => e.ownerId).hasType(integer('owner_id'));
      entity.hasOne(e => e.owner, () => RoOwner).withForeignKey(t => t.ownerId).withPrincipalKey(o => o.id);
    });
  }
}

describe('RETURNING old (PostgreSQL 18)', () => {
  let client: DatabaseClient;
  let db: ReturningOldDatabase;
  const captured: string[] = [];
  let ownerId: number;
  let taskId: number;

  const lastStatement = (fragment: string): string => {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].includes(fragment)) {
        return captured[i];
      }
    }
    throw new Error(`No captured statement contains ${fragment}`);
  };

  const dropTables = async () => {
    await client.query('DROP TABLE IF EXISTS ro_tasks CASCADE');
    await client.query('DROP TABLE IF EXISTS ro_owners CASCADE');
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new ReturningOldDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await dropTables();
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await dropTables();
    await db.dispose();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE ro_tasks, ro_owners RESTART IDENTITY');
    const owner = await db.owners.insert({ name: 'Ada' }).returning(o => ({ id: o.id }));
    ownerId = owner.id;
    const task = await db.tasks.insert({ status: 1, note: 'first', finishedAt: new WallClock('2024-01-15 10:30:00'), ownerId })
      .returning(t => ({ id: t.id }));
    taskId = task.id;
    captured.length = 0;
  });

  test('UPDATE: old.<column> renders old."<column>" and reads the pre-update value, row.<column> the new one', async () => {
    const rows = await db.tasks
      .where(t => eq(t.id, taskId))
      .update({ status: 2 })
      .returning((t, old) => ({ id: t.id, status: t.status, oldStatus: old.status }));

    expect(lastStatement('UPDATE')).toBe(
      'UPDATE "ro_tasks" SET "status" = $1 WHERE "ro_tasks"."id" = $2 RETURNING "id" AS "id", "status" AS "status", old."status" AS "oldStatus"'
    );
    expect(rows).toEqual([{ id: taskId, status: 2, oldStatus: 1 }]);
    expect(typeof rows[0].oldStatus).toBe('number');

    // a replayed transition sees its own previous write as `old`
    const replay = await db.tasks.where(t => eq(t.id, taskId)).update({ status: 2 }).returning((t, old) => ({ oldStatus: old.status }));
    expect(replay).toEqual([{ oldStatus: 2 }]);
  });

  test('a mapped timestamp column reads through its own mapper on both sides', async () => {
    const before = await db.tasks.where(t => eq(t.id, taskId)).select(t => ({ finishedAt: t.finishedAt })).first();

    const [row] = await db.tasks
      .where(t => eq(t.id, taskId))
      .update({ finishedAt: new WallClock('2024-06-30 18:45:10') })
      .returning((t, old) => ({ before: old.finishedAt, after: t.finishedAt }));

    const after = await db.tasks.where(t => eq(t.id, taskId)).select(t => ({ finishedAt: t.finishedAt })).first();

    expect(row.before).toBeInstanceOf(WallClock);
    expect(row.after).toBeInstanceOf(WallClock);
    expect(row.before).toEqual(before.finishedAt);
    expect(row.after).toEqual(after.finishedAt);
    expect((row.before as WallClock).text).not.toBe((row.after as WallClock).text);
  });

  test('old refs inside an expression render old."<column>" next to the row\'s own columns', async () => {
    const rows = await db.tasks
      .where(t => eq(t.id, taskId))
      .update({ status: 5 })
      .returning((t, old) => ({ changed: ne(t.status, old.status), unchanged: eq(t.note, old.note) }));

    expect(lastStatement('RETURNING')).toContain('RETURNING ("status" != old."status") AS "changed", ("note" = old."note") AS "unchanged"');
    expect(rows).toEqual([{ changed: true, unchanged: true }]);
  });

  test('a selector returning ONE old value reads as that value', async () => {
    const statuses = await db.tasks.where(t => eq(t.id, taskId)).update({ status: 7 }).returning((_t, old) => old.status);

    expect(statuses).toEqual([1]);
  });

  test('a WHERE through a navigation (UPDATE … FROM): own columns qualified, old unqualified', async () => {
    const rows = await db.tasks
      .where(t => eq(t.owner!.name, 'Ada'))
      .update({ status: 3 })
      .returning((t, old) => ({ id: t.id, oldStatus: old.status }));

    expect(lastStatement('UPDATE')).toContain('RETURNING "ro_tasks"."id" AS "id", old."status" AS "oldStatus"');
    expect(rows).toEqual([{ id: taskId, oldStatus: 1 }]);
  });

  test('the whole-table update() takes the old row too', async () => {
    const rows = await db.tasks.update({ note: 'rewritten' }).returning((t, old) => ({ note: t.note, oldNote: old.note }));

    expect(rows).toEqual([{ note: 'rewritten', oldNote: 'first' }]);
  });

  test('DELETE: old is the deleted row', async () => {
    const rows = await db.tasks
      .where(t => eq(t.id, taskId))
      .delete()
      .returning((t, old) => ({ id: t.id, oldNote: old.note, oldFinishedAt: old.finishedAt }));

    expect(lastStatement('DELETE')).toBe(
      'DELETE FROM "ro_tasks" WHERE "ro_tasks"."id" = $1 RETURNING "id" AS "id", old."note" AS "oldNote", old."finished_at" AS "oldFinishedAt"'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(taskId);
    expect(rows[0].oldNote).toBe('first');
    expect(rows[0].oldFinishedAt).toBeInstanceOf(WallClock);
  });

  test('a navigation of old is refused — only the table\'s own columns are in scope', async () => {
    await expectToReject(
      db.tasks.where(t => eq(t.id, taskId)).update({ status: 2 }).returning((_t, old: any) => ({ ownerName: old.owner.name })),
      'RETURNING old: navigation "owner" is not available — only the row\'s own columns are in scope'
    );
  });

  test('old next to a navigation of the row (the navigation RETURNING) is refused with a clear error', async () => {
    await expectToReject(
      db.tasks.where(t => eq(t.id, taskId)).update({ status: 2 }).returning((t, old) => ({ ownerName: t.owner!.name, oldStatus: old.status })),
      'RETURNING old cannot be combined with navigations or collections'
    );
    await expectToReject(
      db.tasks.where(t => eq(t.id, taskId)).delete().returning((t, old) => ({ ownerName: t.owner!.name, oldNote: old.note })),
      'RETURNING old cannot be combined with navigations or collections'
    );

    // nothing ran
    expect(await db.tasks.where(t => eq(t.id, taskId)).select(t => ({ status: t.status })).first()).toEqual({ status: 1 });
  });

  test('`old` is typed as the table\'s column row', () => {
    const typedOnly = () => db.tasks.where(t => eq(t.id, 1)).update({ status: 2 }).returning((_t, old) => ({
      // @ts-expect-error — `old` is the tasks column row: there is no such column
      x: old.noSuchColumn,
    }));

    expect(typeof typedOnly).toBe('function');
  });
});
