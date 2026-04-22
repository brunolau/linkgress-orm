import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt } from '../../src';

const STRATEGIES = ['lateral', 'cte'] as const;

describe('sum() with nested scalar subquery summand', () => {
  for (const strategy of STRATEGIES) {
    describe(`collectionStrategy: ${strategy}`, () => {
      test('sum(row => otherCollection.where(...).count()) with sibling toNumberList projections', async () => {
        await withDatabase(async (db) => {
          const seeded = await seedTestData(db);
          const alice = seeded.users.alice;

          const result = await db.users
            .where(u => eq(u.id, alice.id))
            .select(u => ({
              id: u.id,
              username: u.username,
              postIds: u.posts!
                .select(p => ({ id: p.id }))
                .toNumberList(),
              orderIds: u.orders!
                .select(o => ({ id: o.id }))
                .toNumberList(),
              totalComments: u.posts!.sum(p =>
                p.postComments!
                  .where(pc => gt(pc.id, 0))
                  .count()
              ),
            }))
            .firstOrDefault();

          expect(result).not.toBeNull();
          expect(result!.username).toBe('alice');
          expect(result!.postIds.length).toBe(2);
          expect(result!.orderIds.length).toBe(1);
          expect(result!.totalComments).toBe(2);
        }, { collectionStrategy: strategy });
      });

      test('sum(row => otherCollection.where(...).count()) WITHOUT sibling collections', async () => {
        await withDatabase(async (db) => {
          const seeded = await seedTestData(db);
          const alice = seeded.users.alice;

          const result = await db.users
            .where(u => eq(u.id, alice.id))
            .select(u => ({
              id: u.id,
              username: u.username,
              totalComments: u.posts!.sum(p =>
                p.postComments!
                  .where(pc => gt(pc.id, 0))
                  .count()
              ),
            }))
            .firstOrDefault();

          expect(result).not.toBeNull();
          expect(result!.username).toBe('alice');
          expect(result!.totalComments).toBe(2);
        }, { collectionStrategy: strategy });
      });

      test('sum(row => otherCollection.count()) returns 0 when outer collection is empty', async () => {
        await withDatabase(async (db) => {
          const seeded = await seedTestData(db);
          const charlie = seeded.users.charlie;

          const result = await db.users
            .where(u => eq(u.id, charlie.id))
            .select(u => ({
              username: u.username,
              totalComments: u.posts!.sum(p => p.postComments!.count()),
            }))
            .firstOrDefault();

          expect(result).not.toBeNull();
          expect(result!.username).toBe('charlie');
          expect(result!.totalComments ?? 0).toBe(0);
        }, { collectionStrategy: strategy });
      });
    });
  }
});
