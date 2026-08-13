/**
 * Repro test for QA_AT-399 (linkgress-orm side):
 *   A nested collection projection (`parent.children.select(...).toList()`) that navigates
 *   MORE THAN ONE HOP away from the collection root, on a root that ALSO carries a competing
 *   one-hop FK to the very same target table, resolved its deepest joins against the WRONG
 *   anchor and silently returned another row's data.
 *
 *   Shape (mirrors gopass-eshop `order_item`):
 *
 *     order_item -> product_price -> product -> resort      (the path the projection asks for)
 *     order_item -> product                                 (competing one-hop FK, `cashback_product_id`)
 *
 *   Projection: `oi.productPrice.product.resort.name`
 *
 * THE BUG (before the fix):
 *   `CollectionQueryBuilder.resolveNavigationJoins` snapshots `joinedSchemas` ONCE per outer
 *   iteration. `product` is two hops from the collection root, so it is joined mid-iteration and
 *   never lands in that snapshot. The very next alias (`resort`) therefore fails the direct
 *   relation lookup, falls through to `findNavigationPath` — a name-based BFS over the whole
 *   schema graph that has no knowledge of the projection's actual path — and the BFS reaches
 *   `resort` one hop sooner via `order_item.cashback_product_id -> product`. Emitted SQL:
 *
 *     LEFT JOIN "products" "cashbackProduct" ON "lateral_0_orderItems"."cashback_product_id" = ...
 *     LEFT JOIN "resorts"  "resort"          ON "cashbackProduct"."resort_id" = "resort"."id"   <-- WRONG
 *
 *   Consumer symptom: every order line on the customer's order detail rendered the resort of its
 *   *cashback* product instead of the resort of the product actually purchased.
 *
 * THE FIX:
 *   Run the direct-relation lookups to a FIXPOINT (keeping `joinedSchemas` current as joins are
 *   added) BEFORE any BFS fallback, so a two-hop parent can anchor its own children. Emitted SQL
 *   becomes `LEFT JOIN "resorts" "resort" ON "product"."resort_id" = "resort"."id"` and the
 *   `cashbackProduct` join disappears entirely (nothing in the projection asked for it).
 *
 * These tests MUST FAIL before the fix and PASS after.
 */

import { describe, test, expect } from '@jest/globals';
import { withCapturedSql } from '../utils/test-database';
import {
  DatabaseClient,
  DbContext,
  DbEntityTable,
  DbModelConfig,
  DbEntity,
  DbColumn,
  integer,
  varchar,
} from '../../src';

// ---------------------------------------------------------------------------
// Schema: order -> order_item -> product_price -> product -> {resort, product_type}
// plus the competing one-hop order_item.cashback_product_id -> product
// ---------------------------------------------------------------------------

class NmaResort extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NmaProductType extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NmaProduct extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  resortId!: DbColumn<number>;
  productTypeId!: DbColumn<number>;

  resort?: NmaResort;
  productType?: NmaProductType;
}

class NmaProductPrice extends DbEntity {
  id!: DbColumn<number>;
  productId!: DbColumn<number>;
  uuid!: DbColumn<string>;

  product?: NmaProduct;
}

class NmaOrder extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;

  orderItems?: NmaOrderItem[];
}

class NmaOrderItem extends DbEntity {
  id!: DbColumn<number>;
  orderId!: DbColumn<number>;
  productPriceId!: DbColumn<number>;
  // Nullable in the DB (no .isRequired() on the property config) — the competing FK
  cashbackProductId!: DbColumn<number | null>;
  title!: DbColumn<string>;

  order?: NmaOrder;
  productPrice?: NmaProductPrice;
  cashbackProduct?: NmaProduct;
}

class NmaDatabase extends DbContext {
  get nmaResorts(): DbEntityTable<NmaResort> {
    return this.table(NmaResort);
  }

  get nmaProductTypes(): DbEntityTable<NmaProductType> {
    return this.table(NmaProductType);
  }

  get nmaProducts(): DbEntityTable<NmaProduct> {
    return this.table(NmaProduct);
  }

  get nmaProductPrices(): DbEntityTable<NmaProductPrice> {
    return this.table(NmaProductPrice);
  }

  get nmaOrders(): DbEntityTable<NmaOrder> {
    return this.table(NmaOrder);
  }

  get nmaOrderItems(): DbEntityTable<NmaOrderItem> {
    return this.table(NmaOrderItem);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(NmaResort, entity => {
      entity.toTable('nma_resorts');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_resorts_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(NmaProductType, entity => {
      entity.toTable('nma_product_types');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_product_types_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(NmaProduct, entity => {
      entity.toTable('nma_products');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_products_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.resortId).hasType(integer('resort_id')).isRequired();
      entity.property(e => e.productTypeId).hasType(integer('product_type_id')).isRequired();

      entity.hasOne(e => e.resort, () => NmaResort)
        .withForeignKey(p => p.resortId)
        .withPrincipalKey(r => r.id)
        .onDelete('cascade');

      entity.hasOne(e => e.productType, () => NmaProductType)
        .withForeignKey(p => p.productTypeId)
        .withPrincipalKey(t => t.id)
        .onDelete('cascade');
    });

    model.entity(NmaProductPrice, entity => {
      entity.toTable('nma_product_prices');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_product_prices_id_seq' }));
      entity.property(e => e.productId).hasType(integer('product_id')).isRequired();
      entity.property(e => e.uuid).hasType(varchar('uuid', 36)).isRequired();

      entity.hasOne(e => e.product, () => NmaProduct)
        .withForeignKey(pp => pp.productId)
        .withPrincipalKey(p => p.id)
        .onDelete('cascade');
    });

    model.entity(NmaOrder, entity => {
      entity.toTable('nma_orders');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_orders_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 50)).isRequired();

      entity.hasMany(e => e.orderItems, () => NmaOrderItem)
        .withForeignKey(oi => oi.orderId)
        .withPrincipalKey(o => o.id);
    });

    model.entity(NmaOrderItem, entity => {
      entity.toTable('nma_order_items');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_order_items_id_seq' }));
      entity.property(e => e.orderId).hasType(integer('order_id')).isRequired();
      entity.property(e => e.productPriceId).hasType(integer('product_price_id')).isRequired();
      entity.property(e => e.cashbackProductId).hasType(integer('cashback_product_id'));
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();

      entity.hasOne(e => e.order, () => NmaOrder)
        .withForeignKey(oi => oi.orderId)
        .withPrincipalKey(o => o.id)
        .onDelete('cascade');

      entity.hasOne(e => e.productPrice, () => NmaProductPrice)
        .withForeignKey(oi => oi.productPriceId)
        .withPrincipalKey(pp => pp.id)
        .onDelete('cascade');

      // The competing one-hop FK to the SAME table the two-hop path ends on
      entity.hasOne(e => e.cashbackProduct, () => NmaProduct)
        .withForeignKey(oi => oi.cashbackProductId)
        .withPrincipalKey(p => p.id)
        .onDelete('set null');
    });
  }
}

async function cleanupSchema(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS nma_order_items CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_orders CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_product_prices CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_products CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_product_types CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_resorts CASCADE');
}

interface SeedIds {
  purchasedResortId: number;
  cashbackResortId: number;
  productPriceId: number;
  purchasedProductId: number;
  cashbackProductId: number;
  orderId: number;
}

async function seed(db: NmaDatabase): Promise<SeedIds> {
  const [purchasedResort, cashbackResort] = await db.nmaResorts.insertBulk([
    { name: 'Jasna' },
    { name: 'Sachticky' },
  ]).returning();

  const [purchasedType, cashbackType] = await db.nmaProductTypes.insertBulk([
    { name: 'Skipas' },
    { name: 'Cashback' },
  ]).returning();

  const [purchasedProduct, cashbackProduct] = await db.nmaProducts.insertBulk([
    { name: 'Season pass',      resortId: purchasedResort.id, productTypeId: purchasedType.id },
    { name: 'Cashback product', resortId: cashbackResort.id,  productTypeId: cashbackType.id  },
  ]).returning();

  const [productPrice] = await db.nmaProductPrices.insertBulk([
    { productId: purchasedProduct.id, uuid: 'pp-nma-0001' },
  ]).returning();

  const [order] = await db.nmaOrders.insertBulk([
    { code: 'NMA-597' },
  ]).returning();

  await db.nmaOrderItems.insertBulk([
    {
      orderId: order.id,
      productPriceId: productPrice.id,
      cashbackProductId: cashbackProduct.id,
      title: 'Line 1',
    },
  ]);

  return {
    purchasedResortId: purchasedResort.id,
    cashbackResortId: cashbackResort.id,
    productPriceId: productPrice.id,
    purchasedProductId: purchasedProduct.id,
    cashbackProductId: cashbackProduct.id,
    orderId: order.id,
  };
}

/**
 * Helper: fresh DB with logQueries hooked up to a capture array so the emitted
 * lateral / CTE SQL can be asserted structurally, not just semantically.
 */
async function withCapture<T>(
  strategy: 'cte' | 'lateral' | 'temptable',
  testFn: (db: NmaDatabase, captured: string[]) => Promise<T>,
): Promise<T> {
  return withCapturedSql(
    (client, options) => new NmaDatabase(client, options),
    strategy,
    cleanupSchema,
    testFn,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QA_AT-399: nested-collection navigation anchors on the projected path, not a same-table sibling FK', () => {

  // -----------------------------------------------------------------------
  // PRIMARY DEFECT-PROVING TEST
  // -----------------------------------------------------------------------
  test('lateral: oi.productPrice.product.resort.name resolves via product, not via cashbackProduct', async () => {
    await withCapture('lateral', async (db, captured) => {
      const ids = await seed(db);

      // Drop the DDL / INSERT chatter so the assertions below see only the SELECT
      captured.length = 0;

      const results = await db.nmaOrders
        .select(o => ({
          id: o.id,
          code: o.code,
          items: o.orderItems!.select(oi => ({
            id: oi.id,
            productId: oi.productPrice!.productId,
            resortId: oi.productPrice!.product!.resortId,
            resortName: oi.productPrice!.product!.resort!.name,
            productTypeName: oi.productPrice!.product!.productType!.name,
          })).toList(),
        }))
        .toList();

      expect(results).toHaveLength(1);

      const items = results[0].items as any[];
      expect(items).toHaveLength(1);

      // Semantic: the purchased product's resort / type, NOT the cashback product's
      expect(items[0].productId).toBe(ids.purchasedProductId);
      expect(items[0].resortId).toBe(ids.purchasedResortId);
      expect(items[0].resortName).toBe('Jasna');
      expect(items[0].productTypeName).toBe('Skipas');

      // Structural: the resort / product_type joins must anchor on "product"
      const sql = captured.join('\n');
      expect(sql).toContain('"product"."resort_id"');
      expect(sql).toContain('"product"."product_type_id"');

      // ...and the projection never asked for cashbackProduct, so it must not be joined at all
      expect(sql).not.toContain('"cashbackProduct"');
      expect(sql).not.toContain('cashback_product_id');
    });
  });

  // -----------------------------------------------------------------------
  // Same defect via the CTE strategy (shares resolveNavigationJoins)
  // -----------------------------------------------------------------------
  test('cte: oi.productPrice.product.resort.name resolves via product, not via cashbackProduct', async () => {
    await withCapture('cte', async (db, captured) => {
      const ids = await seed(db);

      captured.length = 0;

      const results = await db.nmaOrders
        .select(o => ({
          id: o.id,
          items: o.orderItems!.select(oi => ({
            id: oi.id,
            resortId: oi.productPrice!.product!.resortId,
            resortName: oi.productPrice!.product!.resort!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items[0].resortId).toBe(ids.purchasedResortId);
      expect(items[0].resortName).toBe('Jasna');

      const sql = captured.join('\n');
      expect(sql).toContain('"product"."resort_id"');
      expect(sql).not.toContain('"cashbackProduct"');
    });
  });

  // -----------------------------------------------------------------------
  // MINIMAL PROJECTION — the hardest shape.
  // The two tests above co-project `productId` / `resortId`, which puts the
  // intermediate aliases (`productPrice`, `product`) into `allTableAliases`
  // incidentally. Here the projection names ONLY the deep leaf, so the
  // intermediates have to come from the projection's own navigation chain
  // (`__navigationAliases`) — nothing else can supply them.
  // -----------------------------------------------------------------------
  test('lateral: leaf-only projection (no sibling scalars) still anchors on product', async () => {
    await withCapture('lateral', async (db, captured) => {
      await seed(db);

      captured.length = 0;

      const results = await db.nmaOrders
        .select(o => ({
          id: o.id,
          items: o.orderItems!.select(oi => ({
            resortName: oi.productPrice!.product!.resort!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items).toHaveLength(1);
      expect(items[0].resortName).toBe('Jasna');

      const sql = captured.join('\n');
      expect(sql).toContain('"product"."resort_id"');
      expect(sql).not.toContain('"cashbackProduct"');
    });
  });

  test('cte: leaf-only projection (no sibling scalars) still anchors on product', async () => {
    await withCapture('cte', async (db, captured) => {
      await seed(db);

      captured.length = 0;

      const results = await db.nmaOrders
        .select(o => ({
          id: o.id,
          items: o.orderItems!.select(oi => ({
            resortName: oi.productPrice!.product!.resort!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items).toHaveLength(1);
      expect(items[0].resortName).toBe('Jasna');

      const sql = captured.join('\n');
      expect(sql).toContain('"product"."resort_id"');
      expect(sql).not.toContain('"cashbackProduct"');
    });
  });

  // -----------------------------------------------------------------------
  // Counter-test: the one-hop sibling FK must STILL resolve correctly when the
  // projection genuinely asks for it. Guards against "always prefer the long path".
  // -----------------------------------------------------------------------
  test('lateral: an explicit oi.cashbackProduct.resort.name still resolves via cashbackProduct', async () => {
    await withCapture('lateral', async (db, captured) => {
      const ids = await seed(db);

      captured.length = 0;

      const results = await db.nmaOrders
        .select(o => ({
          id: o.id,
          items: o.orderItems!.select(oi => ({
            id: oi.id,
            cashbackProductId: oi.cashbackProduct!.id,
            cashbackResortId: oi.cashbackProduct!.resortId,
            cashbackResortName: oi.cashbackProduct!.resort!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items[0].cashbackProductId).toBe(ids.cashbackProductId);
      expect(items[0].cashbackResortId).toBe(ids.cashbackResortId);
      expect(items[0].cashbackResortName).toBe('Sachticky');

      const sql = captured.join('\n');
      expect(sql).toContain('"cashbackProduct"."resort_id"');
    });
  });

  // -----------------------------------------------------------------------
  // Control: the same navigation on a FLAT root query was always correct
  // (the intermediate `product` join lands before its children are resolved).
  // Regression guard — must pass before AND after the fix.
  // -----------------------------------------------------------------------
  test('flat root query on order_item resolves the same navigation correctly — regression guard', async () => {
    await withCapture('lateral', async (db) => {
      const ids = await seed(db);

      const rows = await db.nmaOrderItems
        .select(oi => ({
          id: oi.id,
          resortId: oi.productPrice!.product!.resortId,
          resortName: oi.productPrice!.product!.resort!.name,
        }))
        .toList();

      expect(rows).toHaveLength(1);
      expect(rows[0].resortId).toBe(ids.purchasedResortId);
      expect(rows[0].resortName).toBe('Jasna');
    });
  });
});
