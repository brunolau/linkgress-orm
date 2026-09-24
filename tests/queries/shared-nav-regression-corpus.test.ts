import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createFreshClient, seedTestData, setupDatabase } from '../utils/test-database';
import { eq, exists, gt, not, notExists, or, and, sql } from '../../src';

/**
 * Systematic regression corpus for the shared memoized-navigation-node
 * miscompilation fixed in v0.4.85 (see memoized-nav-condition-independence.test.ts
 * for the mechanism write-up: per-row memoized collection navigation +
 * in-place `.where()`/terminal mutation = condition legs compiled from ONE object).
 *
 * Every test name carries a corpus id (A1, C5, ...). Tests marked `[guard]` pin
 * behavior that was ALREADY correct before the fix and must stay correct (root-level
 * navs, statement-style in-place accumulation, fluent AND-chaining, the
 * select()-derive workaround downstream consumers shipped). All other tests FAIL on
 * pristine 0.4.84 and pass with the fix — verified by file-swap during development.
 *
 * Dimensions crossed:
 *  - composition: or() two-leg / three-leg, and(), not(), nested or(and(...)),
 *    exists-only and notExists-only pairs
 *  - node acquisition: re-retrieved per leg vs captured variable; reference-chain
 *    depth 1 (`pc.order!.orderTasks!`) and depth 2 (`pc.order!.user!.posts!`);
 *    root-level collections (guards)
 *  - terminals: exists / count / min / max / sum / toList / firstOrDefault snapshots
 *  - mutator sequences: fluent where-chains (guards), post-capture mutation
 *    (where / limit / orderBy after a captured terminal), the select()-orderBy
 *    array-alias leak (SQL-pinned)
 *  - strategies: projection shapes under BOTH cte and lateral (temptable excluded:
 *    nested exists-fragments inside a collection selector are a pre-existing
 *    unsupported shape there, unrelated to this fix)
 *  - sequential conditions from one memoized nav (2- and 3-in-a-row)
 *
 * Seeded once (read-only tests). Truth table:
 *   comments: c1 → aliceOrder → tasks {pending(sort 1), processing(sort 7)}
 *             c2, c3 → bobOrder → tasks {processing(sort 1)}
 *             c4 → tasklessOrder → NO tasks
 *   order users: aliceOrder→alice (post views 100, 150), bobOrder→bob (200),
 *                tasklessOrder→charlie (no posts)
 */
describe('shared-nav regression corpus', () => {
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
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  let c4 = 0;

  const lastSql = (): string => {
    const statement = captured[captured.length - 1];
    expect(statement).toBeDefined();
    return statement;
  };

  const ids = (rows: Array<{ id: number }>): number[] => rows.map(r => r.id).sort((a, b) => a - b);
  const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b);

  const commentIds = async (
    db: AppDatabase,
    where: (pc: any) => any
  ): Promise<number[]> => ids(await db.postComments.where(where).select(pc => ({ id: pc.id })).toList());

  beforeAll(async () => {
    await setupDatabase(captureDb);
    seed = await seedTestData(captureDb);
    c1 = seed.postComments.alicePostComment1.id;
    c2 = seed.postComments.alicePostComment2.id;
    c3 = seed.postComments.bobPostComment.id;

    // Second task on aliceOrder ('processing', distinct sortOrder) — makes
    // and(exists(P1), exists(P2)) satisfiable by one parent but never by one child row.
    const [extraTask] = await captureDb.tasks.insertBulk([
      { title: 'Extra processing task', status: 'processing', priority: 'low', levelId: seed.taskLevels.highPriority.id },
    ]).returning();
    await captureDb.orderTasks.insertBulk([
      { orderId: seed.orders.aliceOrder.id, taskId: extraTask.id, sortOrder: 7 },
    ]);

    // An order with NO tasks + a comment on it — the notExists leg's target row.
    const [tasklessOrder] = await captureDb.orders.insertBulk([
      { userId: seed.users.charlie.id, status: 'pending', totalAmount: 10 },
    ]).returning();
    const [tasklessComment] = await captureDb.postComments.insertBulk([
      { postId: seed.posts.bobPost.id, orderId: tasklessOrder.id, comment: 'No tasks behind this one' },
    ]).returning();
    c4 = tasklessComment.id;
  });

  afterAll(async () => {
    await captureDb.dispose();
    await lateralDb.dispose();
  });

  // ── A. or() two-leg gate, reference-chain depth 1 ────────────────────────────

  test('A1: or(notExists(nav), exists(nav.where(P))) — re-retrieved node per leg', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
    ));
    expect(rows).toEqual(sorted([c1, c4]));
  });

  test('A2: or(notExists(links), exists(links.where(P))) — captured node', async () => {
    const rows = await commentIds(captureDb, (pc: any) => {
      const links = pc.order!.orderTasks!;

      return or(notExists(links), exists(links.where((ot: any) => eq(ot.task!.status, 'pending'))));
    });
    expect(rows).toEqual(sorted([c1, c4]));
  });

  test('A3: or(exists(nav.where(P)), notExists(nav)) — legs reversed, re-retrieved', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
      notExists(pc.order!.orderTasks!),
    ));
    expect(rows).toEqual(sorted([c1, c4]));
  });

  test('A4: SQL pin — two-leg gate emits the predicate in exactly one leg', async () => {
    captured.length = 0;
    await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
    ));
    const statement = lastSql();
    expect((statement.match(/"task"\."status"/g) ?? []).length).toBe(1);
    const notExistsLeg = statement.slice(statement.indexOf('NOT EXISTS'), statement.indexOf('OR EXISTS'));
    expect(notExistsLeg).not.toContain('"task"."status"');
  });

  // ── B. or() three-leg ────────────────────────────────────────────────────────

  test('B1: or(notExists(nav), exists(nav.where(P1)), exists(nav.where(P2)))', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
    ));
    expect(rows).toEqual(sorted([c1, c4]));
  });

  test('B2: three exists-only legs with distinct predicates', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'processing'))),
    ));
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  test('B3: SQL pin — three-leg gate carries exactly one predicate per predicated leg', async () => {
    captured.length = 0;
    await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
    ));
    expect((lastSql().match(/"task"\."status"/g) ?? []).length).toBe(2);
  });

  // ── C. and() / not() / nested composition / same-polarity pairs ─────────────

  test('C1: and(exists(nav), notExists(nav.where(P)))', async () => {
    const rows = await commentIds(captureDb, (pc: any) => and(
      exists(pc.order!.orderTasks!),
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
    ));
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  test('C2: or(and(exists(nav.where(P)), exists(nav)), notExists(nav)) — nested', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      and(
        exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
        exists(pc.order!.orderTasks!),
      ),
      notExists(pc.order!.orderTasks!),
    ));
    expect(rows).toEqual(sorted([c1, c4]));
  });

  test('C3: not(or(notExists(nav), exists(nav.where(P)))) — negated gate', async () => {
    const rows = await commentIds(captureDb, (pc: any) => not(or(
      notExists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
    )));
    expect(rows).toEqual(sorted([c2, c3]));
  });

  test('C4: and() of two exists legs — satisfiable per parent, never per child row', async () => {
    const rows = await commentIds(captureDb, (pc: any) => and(
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'processing'))),
    ));
    expect(rows).toEqual([c1]);
  });

  test('C5: and() of two notExists legs with distinct predicates', async () => {
    const rows = await commentIds(captureDb, (pc: any) => and(
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
    ));
    expect(rows).toEqual(sorted([c2, c3, c4]));
  });

  test('C6: or() of two notExists legs with distinct predicates', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'processing'))),
    ));
    expect(rows).toEqual(sorted([c2, c3, c4]));
  });

  test('C7: and(not(exists(nav.where(P))), exists(nav)) — not() around exists', async () => {
    const rows = await commentIds(captureDb, (pc: any) => and(
      not(exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed')))),
      exists(pc.order!.orderTasks!),
    ));
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  test('C8: or(and(notExists(nav), <plain predicate>), exists(nav.where(P)))', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      and(notExists(pc.order!.orderTasks!), gt(pc.id, 0)),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
    ));
    expect(rows).toEqual(sorted([c1, c4]));
  });

  // ── D. reference-chain depth 2 (`pc.order!.user!.posts!`) ────────────────────

  test('D1: depth-2 two-leg gate — re-retrieved node per leg', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.user!.posts!),
      exists(pc.order!.user!.posts!.where((p: any) => gt(p.views, 160))),
    ));
    expect(rows).toEqual(sorted([c2, c3, c4]));
  });

  test('D2: depth-2 two-leg gate — captured node', async () => {
    const rows = await commentIds(captureDb, (pc: any) => {
      const posts = pc.order!.user!.posts!;

      return or(notExists(posts), exists(posts.where((p: any) => gt(p.views, 160))));
    });
    expect(rows).toEqual(sorted([c2, c3, c4]));
  });

  test('D3: depth-2 exists-only pair with distinct predicates', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      exists(pc.order!.user!.posts!.where((p: any) => eq(p.views, 100))),
      exists(pc.order!.user!.posts!.where((p: any) => gt(p.views, 160))),
    ));
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  test('D4: SQL pin — depth-2 gate emits the views predicate in exactly one leg', async () => {
    captured.length = 0;
    await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.user!.posts!),
      exists(pc.order!.user!.posts!.where((p: any) => gt(p.views, 160))),
    ));
    expect((lastSql().match(/"views"/g) ?? []).length).toBe(1);
  });

  // ── E. projection shapes (strategy-crossed where marked) ─────────────────────

  const threeFragmentBody = async (db: AppDatabase) => {
    const rows = await db.posts
      .select(p => ({
        id: p.id,
        comments: p.postComments!
          .select(pc => ({
            id: pc.id,
            hasPending: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending')))}`,
            hasProcessing: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'processing')))}`,
            hasCompleted: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'completed')))}`,
          }))
          .toList('comments'),
      }))
      .toList();

    const verdicts = new Map<number, { hasPending: boolean; hasProcessing: boolean; hasCompleted: boolean }>();
    for (const row of rows) {
      for (const comment of (row.comments ?? []) as any[]) {
        verdicts.set(comment.id, comment);
      }
    }
    expect(verdicts.get(c1)).toMatchObject({ hasPending: true, hasProcessing: true, hasCompleted: false });
    expect(verdicts.get(c2)).toMatchObject({ hasPending: false, hasProcessing: true, hasCompleted: false });
    expect(verdicts.get(c3)).toMatchObject({ hasPending: false, hasProcessing: true, hasCompleted: false });
    expect(verdicts.get(c4)).toMatchObject({ hasPending: false, hasProcessing: false, hasCompleted: false });
  };

  test('E1: three exists-fragments off one memoized nav in a collection selector (cte)', async () => {
    await threeFragmentBody(captureDb);
  });

  test('E2: three exists-fragments off one memoized nav in a collection selector (lateral)', async () => {
    await threeFragmentBody(lateralDb);
  });

  const gatePlusFragmentBody = async (db: AppDatabase) => {
    const rows = await db.posts
      .select(p => ({
        id: p.id,
        comments: p.postComments!
          .select(pc => ({
            id: pc.id,
            gateOpen: sql<boolean>`${or(
              notExists(pc.order!.orderTasks!),
              exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'pending'))),
            )}`,
            hasProcessing: sql<boolean>`${exists(pc.order!.orderTasks!.where(ot => eq(ot.task!.status, 'processing')))}`,
          }))
          .toList('comments'),
      }))
      .toList();

    const verdicts = new Map<number, { gateOpen: boolean; hasProcessing: boolean }>();
    for (const row of rows) {
      for (const comment of (row.comments ?? []) as any[]) {
        verdicts.set(comment.id, comment);
      }
    }
    expect(verdicts.get(c1)).toMatchObject({ gateOpen: true, hasProcessing: true });
    expect(verdicts.get(c2)).toMatchObject({ gateOpen: false, hasProcessing: true });
    expect(verdicts.get(c3)).toMatchObject({ gateOpen: false, hasProcessing: true });
    expect(verdicts.get(c4)).toMatchObject({ gateOpen: true, hasProcessing: false });
  };

  test('E3: projected gate + independent fragment off one memoized nav (cte)', async () => {
    await gatePlusFragmentBody(captureDb);
  });

  test('E4: projected gate + independent fragment off one memoized nav (lateral)', async () => {
    await gatePlusFragmentBody(lateralDb);
  });

  const minMaxSumBody = async (db: AppDatabase) => {
    const rows = await db.users
      .select(u => {
        const posts = u.posts!;

        return { id: u.id, minV: posts.min(p => p.views), maxV: posts.max(p => p.views), sumV: posts.sum(p => p.views) };
      })
      .toList();

    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(seed.users.alice.id)).toMatchObject({ minV: 100, maxV: 150, sumV: 250 });
    expect(byId.get(seed.users.bob.id)).toMatchObject({ minV: 200, maxV: 200, sumV: 200 });
    expect(byId.get(seed.users.charlie.id)).toMatchObject({ minV: null, maxV: null, sumV: null });
  };

  test('E5: captured node min()/max()/sum() trio stays three distinct aggregations (cte)', async () => {
    await minMaxSumBody(captureDb);
  });

  test('E6: captured node min()/max()/sum() trio stays three distinct aggregations (lateral)', async () => {
    await minMaxSumBody(lateralDb);
  });

  test('E7: captured node count() + exists() pair', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;

        return { id: u.id, n: posts.count(), any: sql<boolean>`${exists(posts)}` };
      })
      .toList();

    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(seed.users.alice.id)).toMatchObject({ n: 2, any: true });
    expect(byId.get(seed.users.bob.id)).toMatchObject({ n: 1, any: true });
    expect(byId.get(seed.users.charlie.id)).toMatchObject({ n: 0, any: false });
  });

  test('E8: captured node sum() + count() pair', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;

        return { id: u.id, s: posts.sum(p => p.views), n: posts.count() };
      })
      .toList();

    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(seed.users.alice.id)).toMatchObject({ s: 250, n: 2 });
    expect(byId.get(seed.users.bob.id)).toMatchObject({ s: 200, n: 1 });
  });

  test('E9: captured node toList() then firstOrDefault() — list stays a full list', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;

        return { id: u.id, all: posts.toList('all'), one: posts.firstOrDefault('one') };
      })
      .toList();

    const alice = rows.find(r => r.id === seed.users.alice.id)! as any;
    expect(Array.isArray(alice.all)).toBe(true);
    expect(alice.all).toHaveLength(2);
    expect(Array.isArray(alice.one)).toBe(false);
    expect(alice.one).toBeTruthy();
  });

  test('E10: captured node firstOrDefault() then toList() — single stays single, list stays full', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;

        return { id: u.id, one: posts.firstOrDefault('one'), all: posts.toList('all') };
      })
      .toList();

    const alice = rows.find(r => r.id === seed.users.alice.id)! as any;
    expect(Array.isArray(alice.one)).toBe(false);
    expect(alice.one).toBeTruthy();
    expect(Array.isArray(alice.all)).toBe(true);
    expect(alice.all).toHaveLength(2);
  });

  // ── F. mutator sequences and the select()-orderBy alias leak ─────────────────

  test('F1 [guard]: fluent two-deep where-chain still ANDs', async () => {
    const rows = await commentIds(captureDb, (pc: any) => exists(
      pc.order!.orderTasks!
        .where((ot: any) => eq(ot.task!.status, 'processing'))
        .where((ot: any) => eq(ot.sortOrder, 7)),
    ));
    expect(rows).toEqual([c1]);
  });

  test('F2 [guard]: fluent three-deep where-chain still ANDs', async () => {
    const rows = await commentIds(captureDb, (pc: any) => exists(
      pc.order!.orderTasks!
        .where((ot: any) => eq(ot.task!.status, 'processing'))
        .where((ot: any) => eq(ot.sortOrder, 7))
        .where((ot: any) => gt(ot.taskId, 0)),
    ));
    expect(rows).toEqual([c1]);
  });

  test('F3: SQL pin — orderBy on one select()-derived list no longer leaks into a sibling', async () => {
    captured.length = 0;
    await captureDb.users
      .select(u => {
        const posts = u.posts!;

        return {
          id: u.id,
          a: posts.select(x => ({ id: x.id, views: x.views })).orderBy(x => [[x.views, 'DESC']]).toList('a'),
          b: posts.select(x => ({ id: x.id })).toList('b'),
        };
      })
      .toList();

    // The CTE strategy renders each ordered list's ORDER BY once, in its json_agg, so ONE
    // ordered list = exactly 1 DESC occurrence. Pre-fix, select() aliased the parent's
    // orderByFields array, so the DESC entry pushed through list `a` leaked into list `b`
    // as well — 2 occurrences.
    expect((lastSql().match(/ DESC/g) ?? []).length).toBe(1);
  });

  test('F4 [guard]: statement-style offset() accumulation still applies', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;
        posts.offset(1);

        return { id: u.id, rest: posts.toList('rest') };
      })
      .toList();

    const alice = rows.find(r => r.id === seed.users.alice.id)! as any;
    expect(alice.rest).toHaveLength(1);
  });

  test('F5 [guard]: statement-style where() then count() counts the FILTERED set', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;
        posts.where(p => gt(p.views, 120));

        return { id: u.id, n: posts.count() };
      })
      .toList();

    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(seed.users.alice.id)).toMatchObject({ n: 1 });  // only views=150
    expect(byId.get(seed.users.bob.id)).toMatchObject({ n: 1 });
    expect(byId.get(seed.users.charlie.id)).toMatchObject({ n: 0 });
  });

  test('F6 [guard]: statement-style where() then exists() sees the filter', async () => {
    const rows = await commentIds(captureDb, (pc: any) => {
      const links = pc.order!.orderTasks!;
      links.where((ot: any) => eq(ot.task!.status, 'pending'));

      return exists(links);
    });
    expect(rows).toEqual([c1]);
  });

  // ── G. sequential conditions from one memoized nav ───────────────────────────

  test('G1: three sequential legs (notExists+exists+exists) combined with and()', async () => {
    const rows = await commentIds(captureDb, (pc: any) => and(
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
      exists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'processing'))),
    ));
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  test('G2: two sequential opposite-polarity legs combined with or()', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'processing'))),
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))),
    ));
    expect(rows).toEqual([c4]);
  });

  test('G3 [guard]: three chained .where() calls still AND across calls', async () => {
    let q = captureDb.postComments
      .where((pc: any) => notExists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'completed'))));
    q = q.where((pc: any) => exists(pc.order!.orderTasks!));
    q = q.where((pc: any) => exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'processing'))));

    const rows = ids(await q.select((pc: any) => ({ id: pc.id })).toList());
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  // ── H. post-capture mutation: captured legs must be immune ───────────────────

  test('H1: leg captured via exists(), nav mutated afterwards — leg unaffected', async () => {
    const rows = await commentIds(captureDb, (pc: any) => {
      const links = pc.order!.orderTasks!;
      const leg = exists(links);
      links.where((ot: any) => eq(ot.task!.status, 'completed'));

      return leg;
    });
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });

  test('H2: firstOrDefault() captured, node where()-mutated afterwards — snapshot unaffected', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;
        const one = posts.firstOrDefault('one');
        posts.where(p => gt(p.views, 1000));

        return { id: u.id, one };
      })
      .toList();

    const alice = rows.find(r => r.id === seed.users.alice.id)! as any;
    expect(alice.one).toBeTruthy();
  });

  test('H3: toList() captured, node limit()-mutated afterwards — list stays full', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;
        const all = posts.toList('all');
        posts.limit(1);

        return { id: u.id, all };
      })
      .toList();

    const alice = rows.find(r => r.id === seed.users.alice.id)! as any;
    expect(alice.all).toHaveLength(2);
  });

  test('H4: count() captured, node where()-mutated afterwards — count stays unfiltered', async () => {
    const rows = await captureDb.users
      .select(u => {
        const posts = u.posts!;
        const n = posts.count();
        posts.where(p => gt(p.views, 120));

        return { id: u.id, n };
      })
      .toList();

    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(seed.users.alice.id)).toMatchObject({ n: 2 });
    expect(byId.get(seed.users.bob.id)).toMatchObject({ n: 1 });
  });

  // ── I. already-safe guards ───────────────────────────────────────────────────

  test('I1 [guard]: root-level collection two-leg gate (fresh builders per access)', async () => {
    const rows = await captureDb.posts
      .where(p => or(
        notExists(p.postComments!),
        exists(p.postComments!.where(pc => eq(pc.comment, 'Related to order'))),
      ))
      .select(p => ({ id: p.id }))
      .toList();
    expect(ids(rows)).toEqual([seed.posts.alicePost1.id]);
  });

  test('I2 [guard]: two DIFFERENT navs off one memoized reference row stay independent', async () => {
    const rows = await commentIds(captureDb, (pc: any) => and(
      exists(pc.order!.orderTasks!.where((ot: any) => eq(ot.task!.status, 'pending'))),
      exists(pc.order!.user!.posts!.where((p: any) => gt(p.views, 120))),
    ));
    expect(rows).toEqual([c1]);
  });

  test('I3 [guard]: the select()-derive workaround shape keeps working', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      notExists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!.select((ot: any) => ({ id: ot.id })).where((ot: any) => eq(ot.task!.status, 'pending'))),
    ));
    expect(rows).toEqual(sorted([c1, c4]));
  });

  test('I4 [guard]: pure double-read of one memoized nav — identical legs stay valid', async () => {
    const rows = await commentIds(captureDb, (pc: any) => or(
      exists(pc.order!.orderTasks!),
      exists(pc.order!.orderTasks!),
    ));
    expect(rows).toEqual(sorted([c1, c2, c3]));
  });
});
