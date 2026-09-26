import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, gt, literal, MutationBatch, ne, notExists } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createFreshClient, seedTestData, setupDatabase } from '../utils/test-database';

/**
 * The TYPED row guard of `MutationBatch.addInsertBulk`: `rowGuard: v => Condition` over the candidate
 * row `v` (a column row whose refs render `"v"."col"`). The leg keeps the guarded shape
 *
 *   INSERT INTO t (cols) SELECT v."c1", … FROM (VALUES …) AS v(cols) WHERE <guard>
 *
 * and the guard's parameters continue the VALUES cells' numbering, so the batch's whole-leg
 * renumbering keeps them right when the leg is not the first one.
 */
describe('MutationBatch typed rowGuard', () => {
  let db: AppDatabase;
  const captured: string[] = [];

  beforeAll(() => {
    db = new AppDatabase(createFreshClient(), {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
  });

  afterAll(async () => {
    await db.dispose();
  });

  const fresh = async () => {
    await setupDatabase(db);
    const seeded = await seedTestData(db);
    captured.length = 0;

    return seeded;
  };

  const post = (userId: number, title: string, views: number) => ({
    title,
    content: 'guarded',
    userId,
    views,
    publishTime: { hour: 8, minute: 30 },
  });

  test('renders the guarded shape; the guard\'s parameters continue the VALUES cells\' numbering', async () => {
    await fresh();

    const built = (db.posts as any)._buildGuardedInsertBulkStatement(
      [post(1, 'A', 3), post(2, 'B', 9)],
      (v: any) => and(gt(v.views, 5), ne(v.title, 'blocked')),
      'test rowGuard'
    );

    expect(built.sql).toBe(
      'INSERT INTO "posts" ("title", "content", "user_id", "views", "publish_time")\n'
      + 'SELECT v."title", v."content", v."user_id", v."views", v."publish_time" FROM (VALUES '
      + '($1::varchar, $2::text, $3::integer, $4::integer, $5::smallint), '
      + '($6::varchar, $7::text, $8::integer, $9::integer, $10::smallint)) '
      + 'AS v("title", "content", "user_id", "views", "publish_time")\n'
      + 'WHERE ("v"."views" > $11 AND "v"."title" != $12)'
    );
    expect(built.params).toEqual(['A', 'guarded', 1, 3, 510, 'B', 'guarded', 2, 9, 510, 5, 'blocked']);
  });

  test('a guard binding parameters admits exactly the rows it holds for', async () => {
    const { users } = await fresh();

    const batch = new MutationBatch();
    const key = batch.addInsertBulk(db.posts, [
      post(users.alice.id, 'Low views', 3),
      post(users.bob.id, 'High views', 9),
      post(users.charlie.id, 'Blocked title', 9),
    ], 'guarded', { rowGuard: v => and(gt(v.views, 5), ne(v.title, 'Blocked title')) });

    await batch.executeBatch();

    expect(batch.getAffectedCount(key!)).toBe(1);
    const inserted = await db.posts.where(p => eq(p.content, 'guarded')).select(p => ({ title: p.title, userId: p.userId })).toList();
    expect(inserted).toEqual([{ title: 'High views', userId: users.bob.id }]);
  });

  test('a correlated NOT EXISTS guard blocks exactly the candidate rows whose author already has a popular post', async () => {
    const { users } = await fresh();

    // Seed: alice's posts have 100 and 150 views, bob's 200, charlie has none. Over 120 views blocks.
    const batch = new MutationBatch();
    const key = batch.addInsertBulk(db.posts, [
      post(users.alice.id, 'alice candidate', 1),
      post(users.bob.id, 'bob candidate', 1),
      post(users.charlie.id, 'charlie candidate', 1),
    ], 'guarded', {
      rowGuard: v => notExists(
        db.posts
          .where(p => and(eq(p.userId, v.userId), gt(p.views, 120)))
          .select(() => ({ one: literal(1) }))
          .asSubquery()
      ),
    });

    await batch.executeBatch();

    expect(batch.getAffectedCount(key!)).toBe(1);
    const candidates = await db.posts.where(p => eq(p.content, 'guarded')).select(p => ({ title: p.title })).toList();
    expect(candidates).toEqual([{ title: 'charlie candidate' }]);

    const statement = captured.find(line => line.includes('NOT EXISTS'))!;
    expect(statement).toContain('WHERE (NOT EXISTS (SELECT 1 as "one"\nFROM "posts"\nWHERE ("posts"."user_id" = "v"."user_id" AND "posts"."views" > $16)))');
  });

  test('a guarded leg after another leg: the whole leg — guard parameters included — is renumbered', async () => {
    const { users } = await fresh();

    const batch = new MutationBatch();
    const tagKey = batch.addInsertBulk(db.tags, [{ name: 'offset-shifter' }, { name: 'second-tag' }], 'tags');
    const guardedKey = batch.addInsertBulk(db.posts, [
      post(users.alice.id, 'kept', 7),
      post(users.bob.id, 'dropped', 2),
    ], 'guarded', { rowGuard: v => gt(v.views, 5) });

    await batch.executeBatch();

    expect(batch.getAffectedCount(tagKey!)).toBe(2);
    expect(batch.getAffectedCount(guardedKey!)).toBe(1);
    expect(await db.posts.where(p => eq(p.content, 'guarded')).select(p => ({ title: p.title })).toList()).toEqual([{ title: 'kept' }]);

    // 2 tag cells, then 10 post cells: the guard's own parameter is $13 in the fused statement
    const fused = captured.find(line => line.startsWith('WITH "__mb_0"'))!;
    expect(fused).toContain('WHERE "v"."views" > $13\nRETURNING 1');
    const parameters = captured.find(line => line.startsWith('[Parameters]'))!;
    expect(JSON.parse(parameters.slice('[Parameters] '.length))).toEqual([
      'offset-shifter', 'second-tag',
      'kept', 'guarded', users.alice.id, 7, 510,
      'dropped', 'guarded', users.bob.id, 2, 510,
      5,
    ]);
  });

  test('a guard reading a column no row provides is refused at registration', async () => {
    const { users } = await fresh();
    const batch = new MutationBatch();

    expect(() => batch.addInsertBulk(db.posts, [post(users.alice.id, 'x', 1)], 'guarded', {
      rowGuard: v => eq(v.subtitle, 'nope'),
    })).toThrow('MutationBatch: leg "guarded" rowGuard reads v.subtitle, but no row provides "subtitle"');
  });

  test('a guard reading a navigation of v is refused — only the row\'s own columns are in scope', async () => {
    const { users } = await fresh();
    const batch = new MutationBatch();

    expect(() => batch.addInsertBulk(db.posts, [post(users.alice.id, 'x', 1)], 'guarded', {
      rowGuard: (v: any) => eq(v.user.username, 'alice'),
    })).toThrow('MutationBatch: leg "guarded" rowGuard: navigation "user" is not available — only the row\'s own columns are in scope');
  });

  test('a typed guard cannot be combined with onConflictDoNothing / overridingSystemValue', async () => {
    const { users } = await fresh();
    const batch = new MutationBatch();

    expect(() => batch.addInsertBulk(db.posts, [post(users.alice.id, 'x', 1)], 'guarded', {
      rowGuard: v => gt(v.views, 0),
      onConflictDoNothing: true,
    })).toThrow(/combines rowGuard with onConflictDoNothing/);
    expect(() => batch.addInsertBulk(db.posts, [post(users.alice.id, 'x', 1)], 'guarded2', {
      rowGuard: v => gt(v.views, 0),
      overridingSystemValue: true,
    })).toThrow(/combines rowGuard with onConflictDoNothing/);
  });

  test('`v` is typed as the table\'s column row', () => {
    const batch = new MutationBatch();
    const typedOnly = () => batch.addInsertBulk(db.posts, [post(1, 'x', 1)], 'typed', {
      rowGuard: v =>
        // @ts-expect-error — `v` is the posts column row: there is no such column
        eq(v.noSuchColumn, 1),
    });

    expect(typeof typedOnly).toBe('function');
  });
});
