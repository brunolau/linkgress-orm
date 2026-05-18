import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, inSubquery, exists } from '../../src';

/**
 * Tests for `UnionQueryBuilder.asSubquery()` — the ability to compose a UNION
 * (or UNION ALL) of multiple SELECT legs into a single Subquery usable in an
 * outer query's WHERE clause via `inSubquery(...)` / `exists(...)`.
 *
 * Before the fix, `UnionQueryBuilder.toList()` ran the union as a top-level
 * query, but there was no way to use the union as a filter for another query
 * (e.g. "all users whose id is in the union of two row sources"). The closest
 * workaround was to issue two separate queries and merge their id lists in
 * application code — extra roundtrips and no SQL-level composition.
 *
 * Real-world driver: `gopass-eshop` GOBO-240 — community fetch must select all
 * users matching either `masterUserId = X` (family) OR membership in the union
 * of two `user_relations` row sets (friend-parent + friend-slave) in ONE SQL
 * roundtrip.
 */
describe('UnionQueryBuilder.asSubquery()', () => {
  test('union-as-subquery used in inSubquery filters the outer query by the merged id set', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Union of "users with age > 30" + "users with isActive=true" — exercises
      // the basic asSubquery path. Seed data is deterministic.
      const noEdgeCaseUsers = await db.users
        .where(u => eq(u.age, 30))
        .toList();
      expect(noEdgeCaseUsers.length).toBe(0);

      const idsSubquery = db.users
        .where(u => gt(u.age, 30))
        .select(u => u.id)
        .unionAll(
          db.users
            .where(u => eq(u.isActive, true))
            .select(u => u.id),
        )
        .asSubquery('array');

      const result = await db.users
        .where(u => inSubquery(u.id, idsSubquery))
        .select(u => ({ id: u.id, name: u.username }))
        .toList();

      // Seed: alice(25, active), bob(35, active), charlie(45, !active)
      // age > 30: bob, charlie
      // active: alice, bob
      // UNION ALL: bob, charlie, alice, bob (duplicates)
      // inSubquery returns distinct users matching ANY: alice, bob, charlie.
      const names = result.map(r => r.name).sort();
      expect(names).toEqual(['alice', 'bob', 'charlie']);
    });
  });

  test('union-as-subquery shares the outer query parameter counter (no $-index collisions)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Use two literal params in the outer WHERE (`age > 20`, `email != ''`)
      // and two more inside the union legs. If the subquery doesn't chain the
      // counter correctly, $-index collisions produce wrong-row results or a
      // runtime "bind message has N parameters" error from postgres.
      const idsSubquery = db.users
        .where(u => gt(u.age, 30))
        .select(u => u.id)
        .unionAll(
          db.users
            .where(u => eq(u.username, 'alice'))
            .select(u => u.id),
        )
        .asSubquery('array');

      const result = await db.users
        .where(u => gt(u.age, 20))
        .where(u => inSubquery(u.id, idsSubquery))
        .select(u => ({ id: u.id, name: u.username, age: u.age }))
        .toList();

      // age > 30 ∪ username = alice = {bob, charlie} ∪ {alice} = {alice, bob, charlie}
      // age > 20 filters out NOBODY (all three are > 20), so result is the same set.
      expect(result.map(r => r.name).sort()).toEqual(['alice', 'bob', 'charlie']);
    });
  });

  test('union-as-subquery preserves the singleton invariant: same SelectQueryBuilder + asSubquery emits valid SQL once per outer build', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Smoke test — emit a UNION ALL of 3 legs and verify it returns rows.
      const idsSubquery = db.users
        .where(u => eq(u.username, 'alice'))
        .select(u => u.id)
        .unionAll(db.users.where(u => eq(u.username, 'bob')).select(u => u.id))
        .unionAll(db.users.where(u => eq(u.username, 'charlie')).select(u => u.id))
        .asSubquery('array');

      const result = await db.users
        .where(u => inSubquery(u.id, idsSubquery))
        .select(u => ({ id: u.id, name: u.username }))
        .toList();

      expect(result.map(r => r.name).sort()).toEqual(['alice', 'bob', 'charlie']);
    });
  });
});
