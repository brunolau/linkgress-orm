import { describe, expect, test } from 'bun:test';
import { eq, like, sql } from '../../src';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * An `sql` expression is a value every insert path renders inline — in its own parameter sequence,
 * typed like its column where the statement casts — instead of binding the fragment object AS a
 * parameter; and `update()` / `delete()` over EVERY row behave exactly like `where(...).update()` /
 * `where(...).delete()` (column mappers in SET, navigation RETURNING, `toStatement()`).
 *
 * `publishTime` (smallint) and `customDate` (integer) of posts carry custom mappers: 62 is 01:02.
 */
describe('sql expressions as inserted values', () => {
  test('insert and insertBulk: an expression next to plain and mapped values', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const one = await db.posts.insert({
        title: sql<string>`${'vf-'} || ${'insert'}` as any,
        userId: users.alice.id,
        views: sql<number>`${20}::int + ${1}` as any,
        publishTime: { hour: 2, minute: 3 },
      }).returning(p => ({ title: p.title, views: p.views, publishTime: p.publishTime }));
      expect(one).toEqual({ title: 'vf-insert', views: 21, publishTime: { hour: 2, minute: 3 } });

      const many = await db.posts.insertBulk([
        { title: 'vf-plain', userId: users.alice.id, views: 1 },
        // An expression for a mapped column is SQL: it bypasses the mapper's toDriver (62 = 01:02)
        { title: sql<string>`upper(${'vf-shout'})` as any, userId: users.bob.id, views: 2, publishTime: sql<number>`${60}::int + 2` as any },
      ]).returning(p => ({ title: p.title, views: p.views, publishTime: p.publishTime }));
      expect(many as unknown[]).toEqual([
        { title: 'vf-plain', views: 1, publishTime: null },
        { title: 'VF-SHOUT', views: 2, publishTime: { hour: 1, minute: 2 } },
      ]);
    });
  });

  test('upsertBulk: an expression value, taken by the conflict update', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users.upsertBulk(
        [{ username: 'alice', email: sql<string>`${'alice'} || ${'@example.org'}` as any, age: sql<number>`${30}::int + ${3}` as any }] as any,
        { primaryKey: 'username' } as any
      ).returning(u => ({ username: u.username, email: u.email, age: u.age }));

      expect(rows).toEqual([{ username: 'alice', email: 'alice@example.org', age: 33 }]);
    });
  });

  test('values().onConflict().execute(): an expression value, and the rows read back as entities', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users
        .values([{ username: 'vf-values', email: sql<string>`lower(${'VF@EXAMPLE.ORG'})` as any, age: 5, lastActiveAt: new Date('2024-05-05T00:00:00Z') }])
        .onConflict(['username'])
        .doUpdate()
        .execute();

      // Property names and the column's mapper — the rows used to come back keyed by COLUMN name, raw
      expect(rows).toHaveLength(1);
      expect(rows[0].username).toBe('vf-values');
      expect(rows[0].email).toBe('vf@example.org');
      expect(rows[0].isActive).toBe(true);
      expect(rows[0].lastActiveAt).toEqual(new Date('2024-05-05T00:00:00Z'));
      expect('is_active' in (rows[0] as object)).toBe(false);
    });
  });

  test('insertWithChildren and insertBulkWithChildren: expression values in parent and child rows', async () => {
    await withDatabase(async db => {
      const single = await db.users.insertWithChildren({
        row: { username: sql<string>`${'vf-'} || ${'parent'}` as any, email: 'p@x', age: 40 },
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { title: sql<string>`upper(${'vf-child'})` as any, views: sql<number>`${6}::int * ${7}` as any },
            { title: 'vf-child-2', views: 1, publishTime: sql<number>`62` as any },
          ],
        },
        returning: {
          parent: u => ({ username: u.username }),
          children: p => ({ title: p.title, views: p.views, publishTime: p.publishTime }),
        },
      });

      expect(single.parent).toEqual({ username: 'vf-parent' });
      expect(single.children as unknown[]).toEqual([
        { title: 'VF-CHILD', views: 42, publishTime: null },
        { title: 'vf-child-2', views: 1, publishTime: { hour: 1, minute: 2 } },
      ]);

      const bulk = await db.users.insertBulkWithChildren({
        rows: [
          { username: 'vf-bulk-1', email: sql<string>`${'b1'} || ${'@x'}` as any, age: 1 },
          { username: 'vf-bulk-2', email: 'b2@x', age: 2 },
        ],
        children: {
          table: db.posts,
          foreignKey: 'userId',
          rows: [
            { parentIndex: 0, row: { title: sql<string>`${'vf-'} || ${'b1-post'}` as any, views: 3 } },
            { parentIndex: 1, row: { title: 'vf-b2-post', views: sql<number>`${2}::int + ${2}` as any } },
          ],
        },
        returning: {
          parents: u => ({ username: u.username, email: u.email }),
          children: p => ({ title: p.title, views: p.views }),
        },
      });

      expect(bulk.parents).toEqual([{ username: 'vf-bulk-1', email: 'b1@x' }, { username: 'vf-bulk-2', email: 'b2@x' }]);
      expect(bulk.children).toEqual([{ title: 'vf-b1-post', views: 3 }, { title: 'vf-b2-post', views: 4 }]);
    });
  });

  test('bulkUpdate and mergeBulk: expression cells next to mapped values', async () => {
    await withDatabase(async db => {
      const { posts } = await seedTestData(db);

      const updated = await db.posts.bulkUpdate([
        { id: posts.alicePost1.id, views: sql<number>`${1000}::int + ${1}` as any, publishTime: { hour: 3, minute: 4 } },
        { id: posts.bobPost.id, title: sql<string>`upper(${'vf-bulk'})` as any },
      ] as any).returning(p => ({ id: p.id, title: p.title, views: p.views, publishTime: p.publishTime }));

      const byId = [...updated].sort((a, b) => a.id - b.id);
      expect(byId).toEqual([
        { id: posts.alicePost1.id, title: 'Alice Post 1', views: 1001, publishTime: { hour: 3, minute: 4 } },
        { id: posts.bobPost.id, title: 'VF-BULK', views: 200, publishTime: { hour: 18, minute: 45 } },
      ]);

      const merged = await db.posts.mergeBulk(
        [{ title: 'Alice Post 2', userId: posts.alicePost2.userId, views: sql<number>`${7}::int * ${7}` as any }] as any,
        { on: ['title', 'userId'] } as any
      ).returning(p => ({ title: p.title, views: p.views }));
      expect(merged).toEqual([{ title: 'Alice Post 2', views: 49 }]);
    });
  });
});

describe('update() and delete() over every row', () => {
  test('update(): a mapped value goes through the column mapper; affectedCount counts the rows', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const count = await db.posts.update({ publishTime: { hour: 5, minute: 6 } }).affectedCount();
      expect(count).toBe(3);

      const times = await db.posts.select(p => p.publishTime).toList();
      expect(times).toEqual([{ hour: 5, minute: 6 }, { hour: 5, minute: 6 }, { hour: 5, minute: 6 }]);
    });
  });

  test('update(row => …): an expression over the row, and a navigation RETURNING', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.posts
        .update(p => ({ views: sql<number>`${p.views} + ${1}` as any }))
        .returning(p => ({ views: p.views, author: p.user!.username, loud: sql<string>`upper(${p.user!.username})`, kind: 'post' }));

      expect([...rows].sort((a, b) => a.views - b.views)).toEqual([
        { views: 101, author: 'alice', loud: 'ALICE', kind: 'post' },
        { views: 151, author: 'alice', loud: 'ALICE', kind: 'post' },
        { views: 201, author: 'bob', loud: 'BOB', kind: 'post' },
      ]);
    });
  });

  test('update(): a collection in the RETURNING, and toStatement()', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const rows = await db.users.update({ isActive: true }).returning(u => ({ username: u.username, posts: u.posts!.count() }));
      expect([...rows].sort((a, b) => a.username.localeCompare(b.username))).toEqual([
        { username: 'alice', posts: 2 },
        { username: 'bob', posts: 1 },
        { username: 'charlie', posts: 0 },
      ]);

      const compiled = db.users.update({ age: 50 }).toStatement(u => ({ id: u.id }));
      expect(compiled.sql.replace(/\s+/g, ' ')).toBe('UPDATE "users" SET "age" = $1 WHERE TRUE RETURNING "id" AS "id"');
      expect(compiled.params).toEqual([50]);
    });
  });

  test('delete(): affectedCount, and a RETURNING of expressions and navigations', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      const deleted = await db.postComments.delete().returning(c => ({ comment: c.comment, post: c.post!.title, shout: sql<string>`upper(${c.comment})` }));
      expect([...deleted].sort((a, b) => a.comment.localeCompare(b.comment))).toEqual([
        { comment: 'Mentions another order', post: 'Alice Post 2', shout: 'MENTIONS ANOTHER ORDER' },
        { comment: 'My order update', post: 'Bob Post', shout: 'MY ORDER UPDATE' },
        { comment: 'Related to order', post: 'Alice Post 1', shout: 'RELATED TO ORDER' },
      ]);

      expect(await db.orderTasks.delete().affectedCount()).toBe(2);
      expect(await db.orderTasks.count()).toBe(0);
      expect(db.postComments.delete().toStatement(c => ({ id: c.id })).sql.replace(/\s+/g, ' '))
        .toBe('DELETE FROM "post_comments" WHERE TRUE RETURNING "id" AS "id"');
    });
  });

  test('update() on a filtered table still reaches only the rows of its WHERE', async () => {
    await withDatabase(async db => {
      await seedTestData(db);

      await db.posts.where(p => like(p.title, 'Alice%')).update({ views: 0 });
      const views = await db.posts.orderBy(p => p.id).select(p => ({ title: p.title, views: p.views })).toList();

      expect(views).toEqual([
        { title: 'Alice Post 1', views: 0 },
        { title: 'Alice Post 2', views: 0 },
        { title: 'Bob Post', views: 200 },
      ]);
      expect(await db.posts.where(p => eq(p.views, 0)).count()).toBe(2);
    });
  });
});
