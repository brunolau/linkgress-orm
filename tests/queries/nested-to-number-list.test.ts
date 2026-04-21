/**
 * Regression tests for the nested toNumberList() bug.
 *
 * Bug: when toNumberList() (or toStringList()) is used inside a collection selector
 * that shares its parent SELECT with at least one sibling nested list, each element
 * of the resulting array was returned as {} instead of a number.
 *
 * Root cause: transformNestedCollectionValue() iterated each element with
 * `for (const key in item)` — numbers have no enumerable keys, so every element
 * became an empty object.
 *
 * Fix: nestedCollectionInfo now carries flattenResultType; transformNestedCollectionValue
 * returns the array as-is when flattenResultType is set.
 */

import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData, createTestDatabase, setupDatabase } from '../utils/test-database';

// Reusable query builder — runs the same projection on any db instance
async function queryProductsWithSiblingAndNestedNumberList(db: ReturnType<typeof createTestDatabase>) {
  return db.products
    .select(p => ({
      productId: p.id,
      // Sibling list #1 — presence of this list triggered the bug
      tagIds: p.productTags!
        .select(pt => ({ tagId: pt.tagId }))
        .toList(),
      // Sibling list #2 with a nested toNumberList() that was returning [{}]
      prices: p.productPrices!
        .select(pp => ({
          priceId: pp.id,
          capacityGroupIds: pp.productPriceCapacityGroups!
            .select(ppcg => ({ id: ppcg.capacityGroupId }))
            .toNumberList(),
        }))
        .toList(),
    }))
    .toList();
}

// ─────────────────────────────────────────────────────────────────────────────
// CTE strategy
// ─────────────────────────────────────────────────────────────────────────────

describe('Nested toNumberList() bug regression', () => {

  describe('CTE strategy', () => {

    test('toNumberList() nested inside toList() WITH sibling list returns numbers, not {}', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);

        const results = await queryProductsWithSiblingAndNestedNumberList(db);

        expect(results.length).toBeGreaterThan(0);

        for (const product of results) {
          for (const price of product.prices) {
            for (const cgId of price.capacityGroupIds) {
              expect(typeof cgId).toBe('number');
            }
          }
        }

        // Spot-check: skiPassPrice1 has adult + child capacity groups
        const skiPass = results.find(p => p.productId === seeded.products.skiPass.id)!;
        const skiPassPrice1 = skiPass.prices.find(
          p => p.priceId === seeded.productPrices.skiPassPrice1.id
        )!;
        expect(skiPassPrice1.capacityGroupIds.length).toBe(2);
        expect(skiPassPrice1.capacityGroupIds).toContain(seeded.capacityGroups.adultGroup.id);
        expect(skiPassPrice1.capacityGroupIds).toContain(seeded.capacityGroups.childGroup.id);

        // Spot-check: liftTicketPrice1 has only seniorGroup
        const liftTicket = results.find(p => p.productId === seeded.products.liftTicket.id)!;
        const liftPrice = liftTicket.prices[0];
        expect(liftPrice.capacityGroupIds.length).toBe(1);
        expect(liftPrice.capacityGroupIds[0]).toBe(seeded.capacityGroups.seniorGroup.id);
      }, { collectionStrategy: 'cte' });
    });

    test('toNumberList() nested inside toList() WITHOUT sibling list returns numbers', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);

        const results = await db.products
          .select(p => ({
            productId: p.id,
            prices: p.productPrices!
              .select(pp => ({
                priceId: pp.id,
                capacityGroupIds: pp.productPriceCapacityGroups!
                  .select(ppcg => ({ id: ppcg.capacityGroupId }))
                  .toNumberList(),
              }))
              .toList(),
          }))
          .toList();

        for (const product of results) {
          for (const price of product.prices) {
            for (const cgId of price.capacityGroupIds) {
              expect(typeof cgId).toBe('number');
            }
          }
        }

        const skiPass = results.find(p => p.productId === seeded.products.skiPass.id)!;
        const skiPassPrice2 = skiPass.prices.find(
          p => p.priceId === seeded.productPrices.skiPassPrice2.id
        )!;
        expect(skiPassPrice2.capacityGroupIds).toEqual([seeded.capacityGroups.adultGroup.id]);
      }, { collectionStrategy: 'cte' });
    });

    test('correct IDs are returned for each product (not cross-contaminated)', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);

        const results = await queryProductsWithSiblingAndNestedNumberList(db);

        // skiPass prices: price1 → [adult, child], price2 → [adult]
        const skiPass = results.find(p => p.productId === seeded.products.skiPass.id)!;
        expect(skiPass.prices.length).toBe(2);

        const price1 = skiPass.prices.find(p => p.priceId === seeded.productPrices.skiPassPrice1.id)!;
        const price2 = skiPass.prices.find(p => p.priceId === seeded.productPrices.skiPassPrice2.id)!;
        expect([...price1.capacityGroupIds].sort()).toEqual(
          [seeded.capacityGroups.adultGroup.id, seeded.capacityGroups.childGroup.id].sort()
        );
        expect(price2.capacityGroupIds).toEqual([seeded.capacityGroups.adultGroup.id]);

        // liftTicket prices: price1 → [senior]
        const liftTicket = results.find(p => p.productId === seeded.products.liftTicket.id)!;
        expect(liftTicket.prices.length).toBe(1);
        expect(liftTicket.prices[0].capacityGroupIds).toEqual([seeded.capacityGroups.seniorGroup.id]);
      }, { collectionStrategy: 'cte' });
    });

  });

  // ─────────────────────────────────────────────────────────────────────────
  // LATERAL strategy
  // ─────────────────────────────────────────────────────────────────────────

  describe('LATERAL strategy', () => {

    test('toNumberList() nested inside toList() WITH sibling list returns numbers, not {}', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);

        const results = await queryProductsWithSiblingAndNestedNumberList(db);

        for (const product of results) {
          for (const price of product.prices) {
            for (const cgId of price.capacityGroupIds) {
              expect(typeof cgId).toBe('number');
            }
          }
        }

        const skiPass = results.find(p => p.productId === seeded.products.skiPass.id)!;
        const skiPassPrice1 = skiPass.prices.find(
          p => p.priceId === seeded.productPrices.skiPassPrice1.id
        )!;
        expect(skiPassPrice1.capacityGroupIds.length).toBe(2);
        expect(skiPassPrice1.capacityGroupIds).toContain(seeded.capacityGroups.adultGroup.id);
        expect(skiPassPrice1.capacityGroupIds).toContain(seeded.capacityGroups.childGroup.id);
      }, { collectionStrategy: 'lateral' });
    });

    test('toNumberList() nested inside toList() WITHOUT sibling list returns numbers', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.products
          .select(p => ({
            productId: p.id,
            prices: p.productPrices!
              .select(pp => ({
                priceId: pp.id,
                capacityGroupIds: pp.productPriceCapacityGroups!
                  .select(ppcg => ({ id: ppcg.capacityGroupId }))
                  .toNumberList(),
              }))
              .toList(),
          }))
          .toList();

        for (const product of results) {
          for (const price of product.prices) {
            for (const cgId of price.capacityGroupIds) {
              expect(typeof cgId).toBe('number');
            }
          }
        }
      }, { collectionStrategy: 'lateral' });
    });

  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cross-strategy consistency (run sequentially to avoid seed conflicts)
  // ─────────────────────────────────────────────────────────────────────────

  describe('CTE vs LATERAL consistency', () => {

    test('both strategies return the same capacity group IDs when sibling list is present', async () => {
      const cteDb = createTestDatabase({ collectionStrategy: 'cte' });
      await setupDatabase(cteDb);
      const seeded = await seedTestData(cteDb);
      const cteResults = await queryProductsWithSiblingAndNestedNumberList(cteDb);

      const lateralDb = createTestDatabase({ collectionStrategy: 'lateral' });
      await setupDatabase(lateralDb);
      await seedTestData(lateralDb);
      const lateralResults = await queryProductsWithSiblingAndNestedNumberList(lateralDb);

      expect(cteResults.length).toBe(lateralResults.length);

      // Sort by productId so ordering doesn't matter
      const sortedCte = [...cteResults].sort((a, b) => a.productId - b.productId);
      const sortedLat = [...lateralResults].sort((a, b) => a.productId - b.productId);

      for (let i = 0; i < sortedCte.length; i++) {
        const cte = sortedCte[i];
        const lat = sortedLat[i];
        expect(cte.productId).toBe(lat.productId);

        const ctePrices = [...cte.prices].sort((a, b) => a.priceId - b.priceId);
        const latPrices = [...lat.prices].sort((a, b) => a.priceId - b.priceId);
        expect(ctePrices.length).toBe(latPrices.length);

        for (let j = 0; j < ctePrices.length; j++) {
          expect(ctePrices[j].priceId).toBe(latPrices[j].priceId);
          // Sort both before comparing — aggregation order is not guaranteed
          expect([...ctePrices[j].capacityGroupIds].sort()).toEqual(
            [...latPrices[j].capacityGroupIds].sort()
          );
        }
      }

      // Sanity: results contain numbers, not empty objects
      const allIds = [...cteResults, ...lateralResults].flatMap(p =>
        p.prices.flatMap(price => price.capacityGroupIds)
      );
      allIds.forEach(id => expect(typeof id).toBe('number'));
      expect(allIds.length).toBeGreaterThan(0);

      void seeded; // suppress unused warning
    });

  });

  // ─────────────────────────────────────────────────────────────────────────
  // Exact impl.md reproduction: Cart → CartItems + CartDiscountCodes
  //   CartDiscountCode → DiscountCode → Discount → DiscountProducts
  //   scopeProductIds = discountProducts.select(dp => dp.productId).toNumberList()
  // ─────────────────────────────────────────────────────────────────────────

  describe('impl.md exact reproduction (Cart schema)', () => {

    test('CTE: acceptance test from impl.md — scopeProductIds must be number[], not {}[]', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);
        const { cartA } = seeded.carts;

        const raw = await db.carts
          .select(p => ({
            cartId: p.id,
            // Sibling nested list #1
            items: p.cartItems!
              .select(it => ({ id: it.id }))
              .toList('items'),
            // Sibling nested list #2 — contains the deep-nav toNumberList
            appliedCodes: p.cartDiscountCodes!
              .select(cdc => ({
                discountCodeId: cdc.discountCodeId,
                scopeProductIds: cdc.discountCode!.discount!.discountProducts!
                  .select(dp => ({ id: dp.productId }))
                  .toNumberList(),
              }))
              .toList('appliedCodes'),
          }))
          .firstOrDefault();

        expect(raw).not.toBeNull();
        expect(raw!.appliedCodes.length).toBeGreaterThan(0);

        // Core assertion from impl.md acceptance test
        for (const code of raw!.appliedCodes) {
          expect(Array.isArray(code.scopeProductIds)).toBe(true);
          for (const id of code.scopeProductIds) {
            expect(typeof id).toBe('number');
          }
        }

        // Data correctness: find cartA in the results and verify its applied codes
        const allResults = await db.carts
          .select(p => ({
            cartId: p.id,
            items: p.cartItems!.select(it => ({ id: it.id })).toList('items'),
            appliedCodes: p.cartDiscountCodes!
              .select(cdc => ({
                discountCodeId: cdc.discountCodeId,
                scopeProductIds: cdc.discountCode!.discount!.discountProducts!
                  .select(dp => ({ id: dp.productId }))
                  .toNumberList(),
              }))
              .toList('appliedCodes'),
          }))
          .toList();

        const cartAResult = allResults.find(c => c.cartId === cartA.id)!;
        expect(cartAResult).toBeDefined();
        expect(cartAResult.items.length).toBe(2);
        expect(cartAResult.appliedCodes.length).toBe(2);

        // codeA (SUMMER10) covers skiPass + liftTicket (2 products)
        // codeB (WINTER20) covers skiPass (1 product)
        const summerCode = cartAResult.appliedCodes.find(
          c => c.discountCodeId === seeded.discountCodes.codeA.id
        )!;
        expect(summerCode.scopeProductIds.length).toBe(2);
        summerCode.scopeProductIds.forEach(id => expect(typeof id).toBe('number'));

        const winterCode = cartAResult.appliedCodes.find(
          c => c.discountCodeId === seeded.discountCodes.codeB.id
        )!;
        expect(winterCode.scopeProductIds.length).toBe(1);
        expect(typeof winterCode.scopeProductIds[0]).toBe('number');
      }, { collectionStrategy: 'cte' });
    });

    test('LATERAL: acceptance test from impl.md — scopeProductIds must be number[], not {}[]', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);

        const result = await db.carts
          .select(p => ({
            cartId: p.id,
            items: p.cartItems!
              .select(it => ({ id: it.id }))
              .toList('items'),
            appliedCodes: p.cartDiscountCodes!
              .select(cdc => ({
                discountCodeId: cdc.discountCodeId,
                scopeProductIds: cdc.discountCode!.discount!.discountProducts!
                  .select(dp => ({ id: dp.productId }))
                  .toNumberList(),
              }))
              .toList('appliedCodes'),
          }))
          .toList();

        expect(result.length).toBeGreaterThan(0);

        for (const cart of result) {
          for (const code of cart.appliedCodes) {
            expect(Array.isArray(code.scopeProductIds)).toBe(true);
            for (const id of code.scopeProductIds) {
              expect(typeof id).toBe('number');
            }
          }
        }

        // cartA has codeA (summer: 2 products) and codeB (winter: 1 product)
        const cartAResult = result.find(c => c.cartId === seeded.carts.cartA.id)!;
        expect(cartAResult.appliedCodes.length).toBe(2);

        const summerCode = cartAResult.appliedCodes.find(
          c => c.discountCodeId === seeded.discountCodes.codeA.id
        )!;
        expect(summerCode.scopeProductIds.length).toBe(2);

        const winterCode = cartAResult.appliedCodes.find(
          c => c.discountCodeId === seeded.discountCodes.codeB.id
        )!;
        expect(winterCode.scopeProductIds.length).toBe(1);
      }, { collectionStrategy: 'lateral' });
    });

    test('firstOrDefault() variant from impl.md acceptance test', async () => {
      await withDatabase(async (db) => {
        const seeded = await seedTestData(db);

        // This is the exact acceptance test query from impl.md (adapted to the test schema)
        const raw = await db.carts
          .select(p => ({
            items: p.cartItems!
              .select(it => ({ id: it.id }))
              .toList('items'),
            appliedCodes: p.cartDiscountCodes!
              .select(cdc => ({
                scopeProductIds: cdc.discountCode!.discount!.discountProducts!
                  .select(dp => ({ id: dp.productId }))
                  .toNumberList(),
              }))
              .toList('appliedCodes'),
          }))
          .firstOrDefault();

        // Must pass — impl.md acceptance assertion
        expect(raw).not.toBeNull();
        expect(raw!.appliedCodes.every(
          c => c.scopeProductIds.every(id => typeof id === 'number')
        )).toBe(true);

        void seeded;
      }, { collectionStrategy: 'cte' });
    });

  });

});
