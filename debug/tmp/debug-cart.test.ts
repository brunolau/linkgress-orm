import { describe, test } from '@jest/globals';
import { withDatabase, seedTestData } from '../../tests/utils/test-database';

describe('Debug', () => {
  test('cart query SQL', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);
      try {
        const raw = await db.carts
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
          .firstOrDefault();
        console.log('SUCCESS:', JSON.stringify(raw, null, 2));
      } catch (e: any) {
        console.log('ERROR:', e.message);
      }
    }, { collectionStrategy: 'cte', logQueries: true });
  }, 30000);
});
