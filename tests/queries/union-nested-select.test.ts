import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, sql } from '../../src';

/**
 * Defect-proving tests for nested-object projections inside UNION ALL legs.
 *
 * BEFORE the Phase B fix:
 *   `buildQueryCore` (used by every UNION leg via `buildUnionSql`) does NOT
 *   call `tryBuildFlatNestedSelect`. When a UNION leg projects something like
 *   `{ id, address: { street, city } }`, the entire nested object falls
 *   through to the "else { selectParts.push(`$N as "${key}"`) }" branch in
 *   buildQueryCore — meaning the nested object is bound as a SINGLE parameter
 *   value, not flattened into individual columns. The Postgres driver
 *   serialises the object as a JSON-ish string, the column count between legs
 *   differs from what the type system claims, and the resulting rows have an
 *   `address` field that is either a stringified blob or undefined. The
 *   `nestedPaths` reconstruction is ALSO skipped by `UnionQueryBuilder.toList`
 *   so even if columns were flattened, the post-fetch step wouldn't run.
 *
 * AFTER the Phase B fix:
 *   `buildQueryCore` calls `tryBuildFlatNestedSelect` for nested objects (just
 *   like `buildQuery` does), emitting flat path-encoded columns (e.g.
 *   `"address_street"`, `"address_city"`) with deterministic ordering across
 *   legs. `UnionQueryBuilder.toList` collects `nestedPaths` from the FIRST leg
 *   (all legs MUST share the same shape per UNION semantics) and applies
 *   `reconstructNestedObjects` to every row.
 *
 * Each test is annotated with the failure mode on unmodified linkgress so
 * future readers know what bug it catches.
 */
describe('UNION ALL — nested-object projections (defect-proving)', () => {
  test('2-leg UNION ALL with nested address object reconstructs correctly', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Seed users have no street/city in the schema, so use posts + orders as
      // two distinct sources with a synthetic `address` nested via SQL literals.
      // We model "active users" + "older users" UNION ALL and project a nested
      // info object on each leg.
      //
      // FAILURE MODE BEFORE FIX:
      //   - Postgres throws `Buffer.byteLength` TypeError when the object is
      //     passed as a single param, OR
      //   - The driver serialises `{ street: '...', city: '...' }` to a JSON
      //     string, which arrives as the value of column `info` in the result
      //     row — the `info.street` access yields undefined.
      const activeUsersQuery = db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({
          id: u.id,
          name: u.username,
          info: {
            street: sql<string>`'Main St'`,
            city: u.email, // re-use an existing column to prove FieldRef works inside nesting
          },
        }));

      const olderUsersQuery = db.users
        .where(u => gt(u.age, 30))
        .select(u => ({
          id: u.id,
          name: u.username,
          info: {
            street: sql<string>`'Other St'`,
            city: u.email,
          },
        }));

      const result = await activeUsersQuery.unionAll(olderUsersQuery).toList();

      // Seed: alice(25, active), bob(35, active), charlie(45, !active).
      // UNION ALL: active = {alice, bob}, age>30 = {bob, charlie}, total 4 rows.
      expect(result.length).toBe(4);

      // EVERY row must have a properly-structured `info` object — not a string,
      // not undefined, not null.
      for (const row of result) {
        expect(row).toHaveProperty('id');
        expect(row).toHaveProperty('name');
        expect(row).toHaveProperty('info');
        expect(typeof row.info).toBe('object');
        expect(row.info).not.toBeNull();
        expect(row.info).toHaveProperty('street');
        expect(row.info).toHaveProperty('city');
        expect(typeof row.info.street).toBe('string');
        expect(typeof row.info.city).toBe('string');
        expect(row.info.city).toMatch(/@test\.com$/);
      }

      // Sanity: streets differ across legs.
      const streets = new Set(result.map(r => r.info.street));
      expect(streets.has('Main St')).toBe(true);
      expect(streets.has('Other St')).toBe(true);
    });
  });

  test('2-leg UNION ALL with deep (2-level) nested object reconstructs correctly', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // FAILURE MODE BEFORE FIX: same as test 1 but worse — both leaves of the
      // 2-level nesting collapse to a single param.
      const left = db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({
          id: u.id,
          contact: {
            primary: {
              email: u.email,
              source: sql<string>`'primary-left'`,
            },
            secondary: {
              email: sql<string>`'none@nowhere.com'`,
              source: sql<string>`'secondary-left'`,
            },
          },
        }));

      const right = db.users
        .where(u => gt(u.age, 30))
        .select(u => ({
          id: u.id,
          contact: {
            primary: {
              email: u.email,
              source: sql<string>`'primary-right'`,
            },
            secondary: {
              email: sql<string>`'none@nowhere.com'`,
              source: sql<string>`'secondary-right'`,
            },
          },
        }));

      const result = await left.unionAll(right).toList();

      expect(result.length).toBe(4);
      for (const row of result) {
        expect(row).toHaveProperty('contact');
        expect(row.contact).toHaveProperty('primary');
        expect(row.contact).toHaveProperty('secondary');
        expect(row.contact.primary).toHaveProperty('email');
        expect(row.contact.primary).toHaveProperty('source');
        expect(row.contact.secondary).toHaveProperty('email');
        expect(row.contact.secondary).toHaveProperty('source');
        expect(typeof row.contact.primary.email).toBe('string');
        expect(typeof row.contact.primary.source).toBe('string');
        expect(['primary-left', 'primary-right']).toContain(row.contact.primary.source);
        expect(['secondary-left', 'secondary-right']).toContain(row.contact.secondary.source);
      }
    });
  });

  test('mixed top-level + nested projection reconstructs correctly', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // FAILURE MODE BEFORE FIX:
      //   - `id` and `name` come through fine (flat scalars).
      //   - `address` is the single-column blob or undefined.
      const left = db.users
        .where(u => eq(u.isActive, true))
        .select(u => ({
          id: u.id,
          name: u.username,
          age: u.age,
          address: {
            line1: sql<string>`'Line 1 left'`,
            zip: sql<string>`'00000'`,
          },
        }));

      const right = db.users
        .where(u => gt(u.age, 30))
        .select(u => ({
          id: u.id,
          name: u.username,
          age: u.age,
          address: {
            line1: sql<string>`'Line 1 right'`,
            zip: sql<string>`'99999'`,
          },
        }));

      const rows = await left.unionAll(right).toList();
      expect(rows.length).toBe(4);
      for (const row of rows) {
        expect(typeof row.id).toBe('number');
        expect(typeof row.name).toBe('string');
        expect(typeof row.age).toBe('number');
        expect(typeof row.address).toBe('object');
        expect(row.address).not.toBeNull();
        expect(row.address).toHaveProperty('line1');
        expect(row.address).toHaveProperty('zip');
        expect(['Line 1 left', 'Line 1 right']).toContain(row.address.line1);
      }
    });
  });
});
