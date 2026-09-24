import { describe, expect, test } from 'bun:test';
import { eq, like, sql } from '../../src';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * A mutation's RETURNING reads each value through the mapper of what it IS — the column it reads
 * (whichever key it is returned under), the table a navigation's column belongs to, an expression's
 * own `mapWith` — and a collection's items the way a SELECT reads them.
 *
 * The rows used to be mapped by their result KEYS against the mutated table's columns: a mapped
 * column returned under another key came back as its storage value (`t: 570` for 09:30), a value
 * returned under a mapped column's name went through that column's mapper (`customDate: <views as
 * a date>`), and a collection's items came back raw.
 */
describe('mutation RETURNING: mappers', () => {
  const at0930 = { hour: 9, minute: 30 };

  test('an aliased mapped column reads through its mapper on every mutation', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const post = (title: string) => ({ title, userId: users.alice.id, views: 1, publishTime: at0930 });

      // insert — the plain RETURNING, and the navigation one
      expect(await db.posts.insert(post('rm-1')).returning(p => ({ when: p.publishTime }))).toEqual({ when: at0930 });
      expect(await db.posts.insert(post('rm-2')).returning(p => ({ when: p.publishTime, author: p.user!.username })))
        .toEqual({ when: at0930, author: 'alice' });

      // where().update() / where().delete() — plain and navigation
      const updated = await db.posts.where(p => like(p.title, 'rm-%')).update({ views: 2 }).returning(p => ({ when: p.publishTime }));
      expect(updated).toEqual([{ when: at0930 }, { when: at0930 }]);
      const updatedNav = await db.posts.where(p => like(p.title, 'rm-%')).update({ views: 3 })
        .returning(p => ({ when: p.publishTime, author: p.user!.username }));
      expect(updatedNav).toEqual([{ when: at0930, author: 'alice' }, { when: at0930, author: 'alice' }]);

      // bulkUpdate, upsertBulk, mergeBulk
      const [rm1] = await db.posts.where(p => eq(p.title, 'rm-1')).select(p => ({ id: p.id })).toList();
      expect(await db.posts.bulkUpdate([{ id: rm1.id, views: 4 }] as any).returning(p => ({ when: p.publishTime })))
        .toEqual([{ when: at0930 }]);
      expect(await db.posts.bulkUpdate([{ id: rm1.id, views: 5 }] as any).returning(p => ({ when: p.publishTime, author: p.user!.username })))
        .toEqual([{ when: at0930, author: 'alice' }]);
      expect(
        await db.posts.upsertBulk([{ id: rm1.id, ...post('rm-1') }] as any, { primaryKey: 'id', overridingSystemValue: true } as any)
          .returning(p => ({ when: p.publishTime }))
      ).toEqual([{ when: at0930 }]);
      expect(
        await db.posts.mergeBulk([post('rm-1')] as any, { on: ['title', 'userId'] } as any).returning(p => ({ when: p.publishTime }))
      ).toEqual([{ when: at0930 }]);

      const deleted = await db.posts.where(p => like(p.title, 'rm-%')).delete().returning(p => ({ when: p.publishTime, author: p.user!.username }));
      expect(deleted).toEqual([{ when: at0930, author: 'alice' }, { when: at0930, author: 'alice' }]);
    });
  });

  test('a value returned under a mapped column\'s name keeps its own value', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      const values = { title: 'rm-collide', userId: users.alice.id, views: 7, publishTime: at0930 };

      // An expression, another column and a literal, each under the name of a MAPPED column
      const inserted = await db.posts.insert(values).returning(p => ({
        publishTime: sql<number>`41 + 1`,
        customDate: p.views,
        stringStampedAt: 'literal',
      }));
      expect(inserted).toEqual({ publishTime: 42, customDate: 7, stringStampedAt: 'literal' });

      const updated = await db.posts.where(p => eq(p.title, 'rm-collide')).update({ views: 8 }).returning(p => ({
        publishTime: sql<number>`41 + 1`,
        customDate: p.views,
        author: p.user!.username,
      }));
      expect(updated).toEqual([{ publishTime: 42, customDate: 8, author: 'alice' }]);
    });
  });

  test('a navigation\'s mapped column reads through the mapper of the table it belongs to', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const row = await db.posts
        .insert({ title: 'rm-nav', userId: users.alice.id, views: 0 })
        .returning(p => ({ seen: p.user!.lastActiveAt, info: { seenAgain: p.user!.lastActiveAt } }));

      expect(row.seen).toEqual(new Date('2025-03-15T08:00:00Z'));
      expect(row.info.seenAgain).toEqual(new Date('2025-03-15T08:00:00Z'));
    });
  });

  test('collection items read through their columns\' mappers', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const [updated] = await db.users.where(u => eq(u.id, users.alice.id)).update({ age: 26 }).returning(u => ({
        times: u.posts!.orderBy(p => p.id).select(p => ({ t: p.publishTime })).toList(),
        scalarTimes: u.posts!.orderBy(p => p.id).select(p => p.publishTime).toList(),
        first: u.posts!.orderBy(p => p.id).select(p => p.customDate).firstOrDefault(),
        firstRow: u.posts!.orderBy(p => p.id).select(p => ({ day: p.customDate, t: p.publishTime })).firstOrDefault(),
      }));

      expect(updated.times).toEqual([{ t: { hour: 9, minute: 30 } }, { t: { hour: 14, minute: 0 } }]);
      expect(updated.scalarTimes).toEqual([{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }]);
      expect(updated.first).toEqual(new Date('2024-01-15T10:00:00Z'));
      expect(updated.firstRow).toEqual({ day: new Date('2024-01-15T10:00:00Z'), t: { hour: 9, minute: 30 } });

      // The same through an insert's navigation RETURNING
      const [upserted] = await db.users
        .upsertBulk([{ username: 'alice', email: 'alice@test.com', age: 27 }] as any, { primaryKey: 'username' } as any)
        .returning(u => ({ times: u.posts!.orderBy(p => p.id).select(p => p.publishTime).toList() }));
      expect(upserted.times).toEqual([{ hour: 9, minute: 30 }, { hour: 14, minute: 0 }]);
    });
  });

  test('an expression reads through its own mapWith, next to columns', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const row = await db.posts.insert({ title: 'rm-with', userId: users.alice.id, views: 21 }).returning(p => ({
        doubled: sql<number>`${p.views} * 2`.mapWith(value => `n=${value}`),
        author: sql<string>`upper(${p.user!.username})`.mapWith(value => `[${value}]`),
      }));

      expect(row).toEqual({ doubled: 'n=42', author: '[ALICE]' });
    });
  });

  test('returning() of an update and a delete maps every column', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);
      await db.posts.insert({ title: 'rm-all', userId: users.bob.id, views: 1, publishTime: at0930, customDate: new Date('2024-02-01T00:00:00Z') });

      const [updated] = await db.posts.where(p => eq(p.title, 'rm-all')).update({ views: 2 }).returning();
      expect(updated.publishTime).toEqual(at0930);
      expect(updated.customDate).toEqual(new Date('2024-02-01T00:00:00Z'));

      const [deleted] = await db.posts.where(p => eq(p.title, 'rm-all')).delete().returning();
      expect(deleted.publishTime).toEqual(at0930);
      expect(deleted.views).toBe(2);
    });
  });

  test('a selector returning ONE mapped column reads through the mapper', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      expect(await db.posts.insert({ title: 'rm-one', userId: users.alice.id, publishTime: at0930 }).returning(p => p.publishTime)).toEqual(at0930);
      expect(await db.posts.where(p => eq(p.title, 'rm-one')).update({ views: 3 }).returning(p => p.publishTime)).toEqual([at0930]);
      expect(await db.posts.insert({ title: 'rm-two', userId: users.bob.id }).returning(p => p.user!.lastActiveAt))
        .toEqual(new Date('2025-06-20T14:30:00Z'));
    });
  });
});
