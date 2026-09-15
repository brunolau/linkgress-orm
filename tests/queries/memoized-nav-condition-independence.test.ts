import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createFreshClient, seedTestData, setupDatabase } from '../utils/test-database';
import { eq, exists, notExists, or, sql } from '../../src';

/**
 * Regression suite for the shared memoized-navigation-node miscompilation (v0.4.85).
 *
 * A collection navigation reached through a REFERENCE (`pc.order!.orderTasks!`) is handed
 * out by a per-row memo (ReferenceQueryBuilder.buildMockRowDescriptors): every access inside
 * one lambda used to return the SAME CollectionQueryBuilder instance. `.where()` mutates the
 * builder in place and `.exists()` used to as well, so the natural two-leg gate
 *
 *   or(notExists(pc.order!.orderTasks!),
 *      exists(pc.order!.orderTasks!.where(P)))
 *
 * compiled BOTH legs from one object: the second leg's `.where(P)` rewrote the node the
 * first leg had already captured, emitting `NOT EXISTS(P) OR EXISTS(P)` ≡ TRUE — valid SQL,
 * no error, every row returned (shipped downstream as a coupon gate that stopped gating).
 *
 * The fix (see CollectionQueryBuilder.captureSnapshot and the memo getter's re-mint):
 *  - terminal reads (`exists()`, `count()`, `min`/`max`/`sum`, `toList` family) snapshot the
 *    builder instead of writing into it — each captured leg owns its predicate state;
 *  - in-place ops (`where`/`orderBy`/`limit`/`offset`) flag the instance and the memo never
 *    hands a written instance out again — a re-retrieved node is always pristine.
 *
 * File-local databases only (the `withDatabase` shared harness must not be mixed with
 * fresh-client instances in one file — same pattern as lateral-aggregation-rendering).
 * Seeded once; every test is read-only against this state:
 *   alicePostComment1 → aliceOrder → task1 'pending'
 *   alicePostComment2, bobPostComment → bobOrder → task2 'processing'
 *   tasklessComment → tasklessOrder → NO order_task rows (added below)
 */
describe('memoized navigation nodes: condition legs stay independent', () => {
  const captured: string[] = [];
  const captureDb = new AppDatabase(createFreshClient(), {
    logQueries: true,
    logParameters: false,
    collectionStrategy: 'cte',
    logger: (message: string, kind?: string) => {
      if (kind === 'sql' && message !== '\n[SQL Query]') {
        captured.push(message);
      }
    },
  });
  const lateralDb = new AppDatabase(createFreshClient(), { collectionStrategy: 'lateral' });

  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let tasklessCommentId: number;

  const lastSql = (): string => {
    const statement = captured[captured.length - 1];
    expect(statement).toBeDefined();
    return statement;
  };

  const sortedIds = (rows: Array<{ id: number }>): number[] => rows.map(r => r.id).sort((a, b) => a - b);

  beforeAll(async () => {
    await setupDatabase(captureDb);
    seed = await seedTestData(captureDb);

    // An order with NO tasks + a comment on it — the row the notExists leg is FOR.
    const [tasklessOrder] = await captureDb.orders.insertBulk([
      { userId: seed.users.charlie.id, status: 'pending', totalAmount: 10 },
    ]).returning();
    const [tasklessComment] = await captureDb.postComments.insertBulk([
      { postId: seed.posts.bobPost.id, orderId: tasklessOrder.id, comment: 'No tasks behind this one' },
    ]).returning();
    tasklessCommentId = tasklessComment.id;
  });

  afterAll(async () => {
    await captureDb.dispose();
    await lateralDb.dispose();
  });

  test('two-leg gate: NOT EXISTS leg stays predicate-free, EXISTS leg carries it — rows actually gated', async () => {
    captured.length = 0;

    const rows = await captureDb.postComments
      .where(pc => or(
        notExists(pc.order!.orderTasks!),
        exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending'))),
      ))
      .select(pc => ({ id: pc.id }))
      .toList();

    const statement = lastSql();

    // The predicate must exist in exactly ONE leg (the bug emitted it in both).
    expect((statement.match(/"task"\."status"/g) ?? []).length).toBe(1);

    const notExistsStart = statement.indexOf('NOT EXISTS');
    const orExistsStart = statement.indexOf('OR EXISTS');
    expect(notExistsStart).toBeGreaterThanOrEqual(0);
    expect(orExistsStart).toBeGreaterThan(notExistsStart);
    const notExistsLeg = statement.slice(notExistsStart, orExistsStart);
    const existsLeg = statement.slice(orExistsStart);
    expect(notExistsLeg).not.toContain('"task"."status"');
    expect(existsLeg).toContain('"task"."status"');

    // Passes: the comment whose order carries a 'pending' task, and the comment
    // whose order has no tasks at all. Excluded: the two comments linked to the
    // 'processing'-only order — exactly the rows the tautology used to let through.
    expect(sortedIds(rows)).toEqual([
      seed.postComments.alicePostComment1.id,
      tasklessCommentId,
    ].sort((a, b) => a - b));
  });

  test('two-leg gate over a CAPTURED node: legs snapshot at capture time', async () => {
    const rows = await captureDb.postComments
      .where(pc => {
        // The downstream consumer's natural shape, with the node captured once —
        // notExists() must snapshot BEFORE the second leg's .where(P) runs.
        const links = pc.order!.orderTasks!;

        return or(
          notExists(links),
          exists(links.where(ot => eq(ot.task!.status, 'pending'))),
        );
      })
      .select(pc => ({ id: pc.id }))
      .toList();

    expect(sortedIds(rows)).toEqual([
      seed.postComments.alicePostComment1.id,
      tasklessCommentId,
    ].sort((a, b) => a - b));
  });

  test('re-retrieved node after an in-place where(): sequential legs never fuse into AND', async () => {
    captured.length = 0;

    const rows = await captureDb.postComments
      .where(pc => or(
        exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending'))),
        exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'completed'))),
      ))
      .select(pc => ({ id: pc.id }))
      .toList();

    const statement = lastSql();

    // One status predicate per leg. The old shared node AND-chained the second
    // .where() onto the first ("status" = $1 AND "status" = $2 — matches nothing).
    expect((statement.match(/"task"\."status"/g) ?? []).length).toBe(2);
    expect(statement).not.toMatch(/"task"\."status" = \$\d+ AND "task"\."status"/);

    // 'pending' matches alicePostComment1; 'completed' matches nothing.
    // Fused legs returned []; the tautology returned everything.
    expect(rows.map(r => r.id)).toEqual([seed.postComments.alicePostComment1.id]);
  });

  test('separate sequential .where() conditions reusing the same navigation stay independent', async () => {
    let q = captureDb.postComments
      .where(pc => notExists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'completed'))));
    q = q.where(pc => exists(pc.order!.orderTasks!));

    const rows = await q.select(pc => ({ id: pc.id })).toList();

    // No order has a 'completed' task, so the first condition passes every comment;
    // the second keeps only comments whose order has SOME task. Contamination of the
    // second condition by the first's 'completed' predicate would drop all rows.
    expect(sortedIds(rows)).toEqual([
      seed.postComments.alicePostComment1.id,
      seed.postComments.alicePostComment2.id,
      seed.postComments.bobPostComment.id,
    ].sort((a, b) => a - b));
  });

  const dualExistsProjectionBody = async (db: AppDatabase) => {
    // Inside the collection selector, `pc.order` is a memoized reference row and
    // `pc.order!.orderTasks!` its memoized collection node — the second projected
    // fragment used to AND its predicate into the builder the first had captured,
    // so BOTH verdicts rendered the fused (always-false) predicate.
    const rows = await db.posts
      .select(p => ({
        id: p.id,
        comments: p.postComments!
          .select(pc => ({
            id: pc.id,
            hasPending: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending')))}`,
            hasProcessing: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'processing')))}`,
          }))
          .toList('comments'),
      }))
      .toList();

    const verdicts = new Map<number, { hasPending: boolean; hasProcessing: boolean }>();
    for (const row of rows) {
      for (const comment of (row.comments ?? []) as { id: number; hasPending: boolean; hasProcessing: boolean }[]) {
        verdicts.set(comment.id, comment);
      }
    }

    // aliceOrder carries the 'pending' task; bobOrder the 'processing' one.
    expect(verdicts.get(seed.postComments.alicePostComment1.id)).toMatchObject({ hasPending: true, hasProcessing: false });
    expect(verdicts.get(seed.postComments.alicePostComment2.id)).toMatchObject({ hasPending: false, hasProcessing: true });
    expect(verdicts.get(seed.postComments.bobPostComment.id)).toMatchObject({ hasPending: false, hasProcessing: true });
    expect(verdicts.get(tasklessCommentId)).toMatchObject({ hasPending: false, hasProcessing: false });
  };

  test('two exists() fragments off one memoized navigation in a collection selector stay distinct (cte)', async () => {
    await dualExistsProjectionBody(captureDb);
  });

  test('two exists() fragments off one memoized navigation in a collection selector stay distinct (lateral)', async () => {
    await dualExistsProjectionBody(lateralDb);
  });

  test('captured collection node: count() and max() snapshots stay distinct aggregations', async () => {
    // Both terminals read ONE captured node. The old in-place terminals made both
    // selection properties the SAME object — the later max() overwrote count(),
    // so `n` silently rendered as MAX(views).
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;

        return { id: u.id, n: posts.count(), maxViews: posts.max(p => p.views) };
      })
      .toList();

    const byId = new Map(rows.map(r => [r.id, r]));
    const alice = byId.get(seed.users.alice.id)!;
    const bob = byId.get(seed.users.bob.id)!;

    expect(Number(alice.n)).toBe(2);           // two posts
    expect(Number(alice.maxViews!)).toBe(150); // views 100 / 150
    expect(Number(bob.n)).toBe(1);
    expect(Number(bob.maxViews!)).toBe(200);
  });
});
