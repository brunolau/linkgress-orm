import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { withDatabase, seedTestData, createFreshClient } from '../utils/test-database';
import { DatabaseClient, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, gt, integer, smallint, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { pgHourMinute, HourMinute } from '../../debug/types/hour-minute';

/**
 * Tests that custom mappers (fromDriver) are applied when accessing
 * properties with custom mappers through navigation properties at any depth.
 *
 * Post has two custom-mapped fields:
 * - publishTime: HourMinute mapper (smallint -> { hour, minute })
 * - customDate: pgIntDatetime mapper (integer -> Date)
 *
 * User has one custom-mapped field:
 * - lastActiveAt: pgIntDatetime mapper (integer -> Date)
 *
 * Navigation chains tested:
 * - 1-level: PostComment -> Post.publishTime / Post.customDate
 * - 2-level: PostComment -> Post -> User.lastActiveAt
 * - 3-level: OrderTask -> Task -> TaskLevel -> CreatedBy(User).lastActiveAt
 */
describe('Custom mapper on navigation property fields', () => {
  describe('1-level navigation', () => {
    test('should apply HourMinute mapper (PostComment -> Post.publishTime)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.postComments
          .select(pc => ({
            id: pc.id,
            comment: pc.comment,
            publishTime: pc.post!.publishTime,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(row.publishTime).toBeDefined();
          expect(typeof row.publishTime).toBe('object');
          expect(row.publishTime).toHaveProperty('hour');
          expect(row.publishTime).toHaveProperty('minute');
          expect(typeof (row.publishTime as any).hour).toBe('number');
          expect(typeof (row.publishTime as any).minute).toBe('number');
        }
      });
    });

    test('should apply pgIntDatetime mapper (PostComment -> Post.customDate)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.postComments
          .select(pc => ({
            id: pc.id,
            comment: pc.comment,
            customDate: pc.post!.customDate,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(row.customDate).toBeDefined();
          expect(row.customDate).toBeInstanceOf(Date);
        }
      });
    });

    test('should apply mapper alongside direct fields', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.postComments
          .where(pc => gt(pc.id, 0))
          .select(pc => ({
            commentId: pc.id,
            postId: pc.postId,
            postTitle: pc.post!.title,
            publishTime: pc.post!.publishTime,
            customDate: pc.post!.customDate,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(typeof row.commentId).toBe('number');
          expect(typeof row.postId).toBe('number');
          expect(typeof row.postTitle).toBe('string');

          expect(typeof row.publishTime).toBe('object');
          expect(row.publishTime).toHaveProperty('hour');
          expect(row.publishTime).toHaveProperty('minute');

          expect(row.customDate).toBeInstanceOf(Date);
        }
      });
    });
  });

  describe('2-level navigation', () => {
    test('should apply pgIntDatetime mapper (PostComment -> Post -> User.lastActiveAt)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // PostComment -> Post (hasOne) -> User (hasOne) -> lastActiveAt (pgIntDatetime)
        const results = await db.postComments
          .select(pc => ({
            id: pc.id,
            comment: pc.comment,
            postTitle: pc.post!.title,
            authorLastActive: pc.post!.user!.lastActiveAt,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(typeof row.id).toBe('number');
          expect(typeof row.postTitle).toBe('string');
          // 2-level navigation: the mapper must convert integer -> Date
          expect(row.authorLastActive).toBeDefined();
          expect(row.authorLastActive).toBeInstanceOf(Date);
        }
      });
    });

    test('should apply mapper on 2-level nav mixed with 1-level mapped fields', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.postComments
          .select(pc => ({
            id: pc.id,
            // 1-level nav with mapper
            publishTime: pc.post!.publishTime,
            customDate: pc.post!.customDate,
            // 2-level nav with mapper
            authorLastActive: pc.post!.user!.lastActiveAt,
            // 2-level nav without mapper
            authorUsername: pc.post!.user!.username,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          // 1-level: HourMinute
          expect(typeof row.publishTime).toBe('object');
          expect(row.publishTime).toHaveProperty('hour');
          // 1-level: Date
          expect(row.customDate).toBeInstanceOf(Date);
          // 2-level: Date (pgIntDatetime)
          expect(row.authorLastActive).toBeInstanceOf(Date);
          // 2-level: plain string (no mapper)
          expect(typeof row.authorUsername).toBe('string');
        }
      });
    });
  });

  describe('3-level navigation', () => {
    test('should apply pgIntDatetime mapper (OrderTask -> Task -> Level -> CreatedBy.lastActiveAt)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // OrderTask -> Task (hasOne) -> TaskLevel (hasOne) -> User (hasOne) -> lastActiveAt
        const results = await db.orderTasks
          .select(ot => ({
            orderId: ot.orderId,
            taskTitle: ot.task!.title,
            levelName: ot.task!.level!.name,
            creatorLastActive: ot.task!.level!.createdBy!.lastActiveAt,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(typeof row.orderId).toBe('number');
          expect(typeof row.taskTitle).toBe('string');
          expect(typeof row.levelName).toBe('string');
          // 3-level navigation: the mapper must convert integer -> Date
          expect(row.creatorLastActive).toBeDefined();
          expect(row.creatorLastActive).toBeInstanceOf(Date);
        }
      });
    });

    test('should apply mapper on 3-level nav mixed with unmapped fields at every level', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.orderTasks
          .select(ot => ({
            // direct field (0 levels)
            orderId: ot.orderId,
            // 1-level nav, no mapper
            taskTitle: ot.task!.title,
            // 2-level nav, no mapper
            levelName: ot.task!.level!.name,
            // 3-level nav, no mapper
            creatorEmail: ot.task!.level!.createdBy!.email,
            // 3-level nav, WITH mapper (pgIntDatetime)
            creatorLastActive: ot.task!.level!.createdBy!.lastActiveAt,
          }))
          .toList();

        expect(results.length).toBeGreaterThan(0);
        for (const row of results) {
          expect(typeof row.orderId).toBe('number');
          expect(typeof row.taskTitle).toBe('string');
          expect(typeof row.levelName).toBe('string');
          expect(typeof row.creatorEmail).toBe('string');
          // Only this one goes through a custom mapper
          expect(row.creatorLastActive).toBeInstanceOf(Date);
        }
      });
    });
  });
});

/**
 * A navigation's column reads through ITS mapper — also when the root table has a column of the
 * same property name. The result mapping looked the name up in the ROOT's columns first: a root
 * column without a mapper made the navigation's mapper be skipped, and a root column WITH one had
 * it applied to the navigation's value.
 *
 *   shift (root)  start: integer minutes, unmapped     slot  start: smallint, HourMinute mapper
 *   rota  (root)  start: smallint, HourMinute mapper   → shift.start (unmapped)
 */
class NmSlot extends DbEntity {
  id!: DbColumn<number>;
  start!: DbColumn<HourMinute>;
}

class NmShift extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  start!: DbColumn<number>;
  slotId!: DbColumn<number>;
  slot?: NmSlot;
}

class NmRota extends DbEntity {
  id!: DbColumn<number>;
  start!: DbColumn<HourMinute>;
  shiftId!: DbColumn<number>;
  shift?: NmShift;
}

class NameCollisionDatabase extends DbContext {
  get slots(): DbEntityTable<NmSlot> {
    return this.table(NmSlot);
  }

  get shifts(): DbEntityTable<NmShift> {
    return this.table(NmShift);
  }

  get rotas(): DbEntityTable<NmRota> {
    return this.table(NmRota);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(NmSlot, entity => {
      entity.toTable('nm_slots');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nm_slots_id_seq' }));
      entity.property(e => e.start).hasType(smallint('start')).isRequired().hasCustomMapper(pgHourMinute);
    });

    model.entity(NmShift, entity => {
      entity.toTable('nm_shifts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nm_shifts_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 32)).isRequired();
      entity.property(e => e.start).hasType(integer('start')).isRequired();
      entity.property(e => e.slotId).hasType(integer('slot_id')).isRequired();
      entity.hasOne(e => e.slot, () => NmSlot).withForeignKey(s => s.slotId).withPrincipalKey(s => s.id);
    });

    model.entity(NmRota, entity => {
      entity.toTable('nm_rotas');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nm_rotas_id_seq' }));
      entity.property(e => e.start).hasType(smallint('start')).isRequired().hasCustomMapper(pgHourMinute);
      entity.property(e => e.shiftId).hasType(integer('shift_id')).isRequired();
      entity.hasOne(e => e.shift, () => NmShift).withForeignKey(r => r.shiftId).withPrincipalKey(s => s.id);
    });
  }
}

describe('a navigation column named like a column of the root', () => {
  let client: DatabaseClient;
  let db: NameCollisionDatabase;

  const drop = async (): Promise<void> => {
    for (const table of ['nm_rotas', 'nm_shifts', 'nm_slots']) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new NameCollisionDatabase(client);
    await drop();
    await db.getSchemaManager().ensureCreated();

    const [slot] = await db.slots.insertBulk([{ start: { hour: 7, minute: 15 } }]).returning();
    const [shift] = await db.shifts.insertBulk([{ label: 'early', start: 420, slotId: slot.id }]).returning();
    await db.rotas.insert({ start: { hour: 6, minute: 0 }, shiftId: shift.id });
  });

  afterAll(async () => {
    await drop();
    await db.dispose();
  });

  test('an unmapped root column does not keep the navigation\'s mapper from applying', async () => {
    const rows = await db.shifts.select(s => ({ own: s.start, slotStart: s.slot!.start })).toList();

    expect(rows).toEqual([{ own: 420, slotStart: { hour: 7, minute: 15 } }]);
  });

  test('a mapped root column does not lend its mapper to the navigation\'s value', async () => {
    const rows = await db.rotas.select(r => ({ own: r.start, shiftStart: r.shift!.start, slotStart: r.shift!.slot!.start })).toList();

    expect(rows).toEqual([{ own: { hour: 6, minute: 0 }, shiftStart: 420, slotStart: { hour: 7, minute: 15 } }]);
  });

  test('the same holds for a single column read on its own', async () => {
    expect(await db.shifts.select(s => s.slot!.start).toList()).toEqual([{ hour: 7, minute: 15 }]);
    expect(await db.rotas.where(r => eq(r.start, { hour: 6, minute: 0 } as any)).select(r => r.shift!.start).toList()).toEqual([420]);
  });
});
