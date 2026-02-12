import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { gt } from '../../src';

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
