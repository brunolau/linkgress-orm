import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, sql, exists, notExists, and } from '../../src';

describe('exists() in SELECT projections', () => {
  test('exists() should work in WHERE clause (baseline)', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Baseline: exists() in WHERE - this already works
      const result = await db.users
        .where(u => exists(
          db.posts
            .where(p => eq(p.userId, u.id))
            .select(p => ({ id: p.id }))
            .asSubquery('table')
        ))
        .select(u => ({
          username: u.username,
        }))
        .toList();

      // Alice has 2 posts, Bob has 1 post, Charlie has 0
      expect(result.length).toBe(2);
      expect(result.map(r => r.username).sort()).toEqual(['alice', 'bob']);
    });
  });

  test('exists() should work in SELECT projection and return boolean', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .select(u => ({
          username: u.username,
          hasPosts: exists(
            db.posts
              .where(p => eq(p.userId, u.id))
              .select(p => ({ id: p.id }))
              .asSubquery('table')
          ),
        }))
        .toList();

      expect(result.length).toBe(3);

      // Type is boolean (ExistsCondition extends SqlFragment<boolean>)
      expect(typeof result[0].hasPosts).toBe('boolean');

      const alice = result.find(r => r.username === 'alice');
      const bob = result.find(r => r.username === 'bob');
      const charlie = result.find(r => r.username === 'charlie');

      expect(alice?.hasPosts).toBe(true);
      expect(bob?.hasPosts).toBe(true);
      expect(charlie?.hasPosts).toBe(false);
    });
  });

  test('notExists() should work in SELECT projection and return boolean', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .select(u => ({
          username: u.username,
          hasNoPosts: notExists(
            db.posts
              .where(p => eq(p.userId, u.id))
              .select(p => ({ id: p.id }))
              .asSubquery('table')
          ),
        }))
        .toList();

      expect(result.length).toBe(3);

      const alice = result.find(r => r.username === 'alice');
      const charlie = result.find(r => r.username === 'charlie');

      expect(alice?.hasNoPosts).toBe(false);
      expect(charlie?.hasNoPosts).toBe(true);
      expect(typeof result[0].hasNoPosts).toBe('boolean');
    });
  });

  test('exists() should work in leftJoin projection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .leftJoin(
          db.productPrices,
          (product, price) => eq(product.id, price.productId),
          (product, _price) => ({
            id: product.id,
            name: product.name,
            hasCapacityGroups: exists(
              db.productPriceCapacityGroups
                .where(ppcg => eq(ppcg.productPrice!.productId, product.id))
                .select(ppcg => ({ id: ppcg.productPriceId }))
                .asSubquery('table')
            ),
          }),
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);

      // Both products have capacity groups based on seed data
      for (const row of result) {
        expect(typeof row.hasCapacityGroups).toBe('boolean');
      }
    });
  });
});

describe('collection.exists() in SELECT projections', () => {
  test('collection.exists() should return true/false for each parent', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .select(u => ({
          username: u.username,
          hasPosts: u.posts!.exists(),
        }))
        .toList();

      expect(result.length).toBe(3);
      expect(typeof result[0].hasPosts).toBe('boolean');

      const alice = result.find(r => r.username === 'alice');
      const bob = result.find(r => r.username === 'bob');
      const charlie = result.find(r => r.username === 'charlie');

      expect(alice?.hasPosts).toBe(true);
      expect(bob?.hasPosts).toBe(true);
      expect(charlie?.hasPosts).toBe(false);
    });
  });

  test('collection.exists() with where filter', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.users
        .select(u => ({
          username: u.username,
          hasPopularPosts: u.posts!.where(p => sql<boolean>`${p.views} > 150`).exists(),
        }))
        .toList();

      expect(result.length).toBe(3);

      const alice = result.find(r => r.username === 'alice');
      const bob = result.find(r => r.username === 'bob');
      const charlie = result.find(r => r.username === 'charlie');

      // Alice posts: 100, 150 views (neither > 150). Bob post: 200 views (> 150).
      expect(alice?.hasPopularPosts).toBe(false);
      expect(bob?.hasPopularPosts).toBe(true);
      expect(charlie?.hasPopularPosts).toBe(false);
    });
  });

  test('collection.exists() with product/price relationship', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          hasPrices: p.productPrices!.exists(),
        }))
        .toList();

      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(typeof row.hasPrices).toBe('boolean');
        // Both products should have prices based on seed data
        expect(row.hasPrices).toBe(true);
      }
    });
  });
});

describe('selectMany() with aggregations', () => {
  test('selectMany().exists() should flatten nested collection and check existence', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          hasCapacityGroups: p.productPrices!.selectMany(pp => pp.productPriceCapacityGroups!).exists(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      const liftTicket = result.find(r => r.name === 'Lift Ticket');

      expect(skiPass?.hasCapacityGroups).toBe(true);
      expect(liftTicket?.hasCapacityGroups).toBe(true);
    });
  });

  test('selectMany().count() should count flattened items', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          capacityGroupCount: p.productPrices!.selectMany(pp => pp.productPriceCapacityGroups!).count(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      const liftTicket = result.find(r => r.name === 'Lift Ticket');

      // Ski Pass: price1 has Adult+Child, price2 has Adult = 3 total
      expect(skiPass?.capacityGroupCount).toBe(3);
      // Lift Ticket: price1 has Senior = 1 total
      expect(liftTicket?.capacityGroupCount).toBe(1);
    });
  });
});

describe('selectMany() with select/toList', () => {
  test('selectMany().select().toList() should return flattened list of projected objects', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          capacityGroupLinks: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .select(ppcg => ({
              id: ppcg.capacityGroupId,
            }))
            .toList(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      const liftTicket = result.find(r => r.name === 'Lift Ticket');

      // Ski Pass: 3 capacity group links (Adult, Child, Adult)
      expect(Array.isArray(skiPass?.capacityGroupLinks)).toBe(true);
      expect(skiPass?.capacityGroupLinks).toHaveLength(3);
      expect(skiPass?.capacityGroupLinks.every((item: any) => typeof item.id === 'number')).toBe(true);

      // Lift Ticket: 1 capacity group link (Senior)
      expect(liftTicket?.capacityGroupLinks).toHaveLength(1);
    });
  });

  test('selectMany().select() with multiple fields in projection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          links: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .select(ppcg => ({
              priceId: ppcg.productPriceId,
              groupId: ppcg.capacityGroupId,
            }))
            .toList(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      expect(skiPass?.links).toHaveLength(3);

      // Each item should have both priceId and groupId
      for (const link of skiPass?.links || []) {
        expect(typeof link.priceId).toBe('number');
        expect(typeof link.groupId).toBe('number');
      }
    });
  });

  test('selectMany().toList() should return full flattened entity list', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          capacityGroupLinks: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .toList(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      expect(skiPass?.capacityGroupLinks).toHaveLength(3);

      // Full entities should have productPriceId and capacityGroupId
      for (const link of skiPass?.capacityGroupLinks || []) {
        expect(link.productPriceId).toBeDefined();
        expect(link.capacityGroupId).toBeDefined();
      }
    });
  });
});

describe('selectMany() with where filter', () => {
  test('selectMany().where().exists() should filter the flattened collection', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      // Check if product has any capacity group links with a specific capacityGroupId
      const result = await db.products
        .select(p => ({
          name: p.name,
          hasAdultGroup: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .where(ppcg => eq(ppcg.capacityGroupId, seed.capacityGroups.adultGroup.id))
            .exists(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      const liftTicket = result.find(r => r.name === 'Lift Ticket');

      // Ski Pass has Adult group (price1 + price2), Lift Ticket only has Senior
      expect(skiPass?.hasAdultGroup).toBe(true);
      expect(liftTicket?.hasAdultGroup).toBe(false);
    });
  });

  test('selectMany().where().count() should count filtered flattened items', async () => {
    await withDatabase(async (db) => {
      const seed = await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          adultGroupCount: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .where(ppcg => eq(ppcg.capacityGroupId, seed.capacityGroups.adultGroup.id))
            .count(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      const liftTicket = result.find(r => r.name === 'Lift Ticket');

      // Ski Pass: price1 has Adult, price2 has Adult = 2 adult links
      expect(skiPass?.adultGroupCount).toBe(2);
      // Lift Ticket: no adult groups
      expect(liftTicket?.adultGroupCount).toBe(0);
    });
  });
});

describe('selectMany() combined with other collection operations', () => {
  test('mixed exists() and selectMany().exists() in same projection', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const result = await db.products
        .select(p => ({
          name: p.name,
          hasPrices: p.productPrices!.exists(),
          hasCapacityGroups: p.productPrices!.selectMany(pp => pp.productPriceCapacityGroups!).exists(),
          priceCount: p.productPrices!.count(),
          capacityGroupCount: p.productPrices!.selectMany(pp => pp.productPriceCapacityGroups!).count(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      const liftTicket = result.find(r => r.name === 'Lift Ticket');

      // Ski Pass: 2 prices, 3 capacity group links
      expect(skiPass?.hasPrices).toBe(true);
      expect(skiPass?.hasCapacityGroups).toBe(true);
      expect(skiPass?.priceCount).toBe(2);
      expect(skiPass?.capacityGroupCount).toBe(3);

      // Lift Ticket: 1 price, 1 capacity group link
      expect(liftTicket?.hasPrices).toBe(true);
      expect(liftTicket?.hasCapacityGroups).toBe(true);
      expect(liftTicket?.priceCount).toBe(1);
      expect(liftTicket?.capacityGroupCount).toBe(1);
    });
  });

  test('selectMany() with navigation property on inner item', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Access the capacityGroup navigation property through the join table
      const result = await db.products
        .select(p => ({
          name: p.name,
          capacityGroups: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .select(ppcg => ({
              groupName: ppcg.capacityGroup!.name,
            }))
            .toList(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      expect(skiPass?.capacityGroups).toHaveLength(3);

      // Should contain Adult (x2) and Child (x1)
      const groupNames = skiPass?.capacityGroups.map((g: any) => g.groupName).sort();
      expect(groupNames).toEqual(['Adult', 'Adult', 'Child']);

      const liftTicket = result.find(r => r.name === 'Lift Ticket');
      expect(liftTicket?.capacityGroups).toHaveLength(1);
      expect(liftTicket?.capacityGroups[0].groupName).toBe('Senior');
    });
  });

  test('selectMany() with selectDistinct on inner items', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      // Get distinct capacity group IDs per product (Ski Pass has Adult twice)
      const result = await db.products
        .select(p => ({
          name: p.name,
          distinctGroupIds: p.productPrices!
            .selectMany(pp => pp.productPriceCapacityGroups!)
            .selectDistinct(ppcg => ppcg.capacityGroupId)
            .toNumberList(),
        }))
        .toList();

      expect(result.length).toBe(2);

      const skiPass = result.find(r => r.name === 'Ski Pass');
      // Ski Pass has Adult (x2) + Child = 2 distinct group IDs
      expect(skiPass?.distinctGroupIds).toHaveLength(2);

      const liftTicket = result.find(r => r.name === 'Lift Ticket');
      // Lift Ticket has only Senior = 1 distinct group ID
      expect(liftTicket?.distinctGroupIds).toHaveLength(1);
    });
  });
});
