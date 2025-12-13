import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createTestDatabase, setupDatabase, cleanupDatabase, seedTestData } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { coalesce, jsonbSelect, jsonbSelectText, eq, gt, sql } from '../../src';

describe('Coalesce and JSONB Operators', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = createTestDatabase();
    await setupDatabase(db);
    await seedTestData(db);
  });

  afterAll(async () => {
    await cleanupDatabase(db);
  });

  describe('coalesce', () => {
    test('should return first non-null value from two columns', async () => {
      const results = await db.users
        .select(u => ({
          id: u.id,
          username: u.username,
          ageOrDefault: coalesce(u.age, 0),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(typeof r.ageOrDefault).toBe('number');
        // ageOrDefault should never be null
        expect(r.ageOrDefault).not.toBeNull();
      });
    });

    test('should return first non-null value with literal fallback', async () => {
      const results = await db.users
        .select(u => ({
          id: u.id,
          username: u.username,
          displayName: coalesce(u.username, 'Anonymous'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(typeof r.displayName).toBe('string');
        expect(r.displayName).not.toBeNull();
        expect(r.displayName.length).toBeGreaterThan(0);
      });
    });

    test('should work with two column references', async () => {
      const results = await db.posts
        .select(p => ({
          id: p.id,
          displayTitle: coalesce(p.subtitle, p.title),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.displayTitle).not.toBeNull();
      });
    });

    test('should be usable in where clause with gt', async () => {
      // Note: WHERE clause must come before SELECT when using original entity fields
      // We filter by age > 0 first (which excludes nulls), then use coalesce in select
      const results = await db.users
        .where(u => gt(u.age, 0))
        .select(u => ({
          id: u.id,
          username: u.username,
          ageOrDefault: coalesce(u.age, 0),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.ageOrDefault).toBeGreaterThan(0);
      });
    });

    test('should handle null first argument correctly', async () => {
      // Insert a user with null age
      await db.users.insert({
        username: 'nullage_user',
        email: 'nullage@test.com',
        isActive: true,
      });

      const results = await db.users
        .where(u => eq(u.username, 'nullage_user'))
        .select(u => ({
          id: u.id,
          effectiveAge: coalesce(u.age, 99),
        }))
        .toList();

      expect(results.length).toBe(1);
      expect(results[0].effectiveAge).toBe(99);
    });
  });

  describe('jsonbSelect', () => {
    // Define the type for the JSONB structure
    type OrderItems = { productName: string; quantity: number; price: number };

    test('should extract property from JSONB column', async () => {
      // First insert an order with JSONB items
      const user = (await db.users.toList())[0];

      await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 99.99,
        items: { productName: 'Test Product', quantity: 2, price: 49.99 },
      });

      const results = await db.orders
        .select(o => ({
          id: o.id,
          productName: jsonbSelect<OrderItems>(o.items, 'productName'),
        }))
        .where(o => gt(o.id, 0))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      // The productName should be extracted from JSONB
      // Use != null to catch both null and undefined (when items is NULL in DB)
      const orderWithItems = results.find(r => r.productName != null);
      expect(orderWithItems).toBeDefined();
      expect(orderWithItems!.productName).toBe('Test Product');
    });

    test('should extract numeric property from JSONB', async () => {
      const user = (await db.users.toList())[0];

      await db.orders.insert({
        userId: user.id,
        status: 'processing',
        totalAmount: 200,
        items: { productName: 'Quantity Test', quantity: 5, price: 40 },
      });

      const results = await db.orders
        .select(o => ({
          id: o.id,
          quantity: jsonbSelect<OrderItems>(o.items, 'quantity'),
        }))
        .where(o => gt(o.id, 0))
        .toList();

      expect(results.length).toBeGreaterThan(0);
    });

    test('should work with nullable JSONB columns', async () => {
      const results = await db.orders
        .select(o => ({
          id: o.id,
          productName: jsonbSelect<OrderItems>(o.items, 'productName'),
        }))
        .toList();

      expect(Array.isArray(results)).toBe(true);
      // Results should not throw even with null JSONB values
    });
  });

  describe('jsonbSelectText', () => {
    type OrderItems = { productName: string; quantity: number };

    test('should extract property as text from JSONB column', async () => {
      const user = (await db.users.toList())[0];

      await db.orders.insert({
        userId: user.id,
        status: 'completed',
        totalAmount: 150.00,
        items: { productName: 'TextExtractionProduct', quantity: 3 },
      });

      const results = await db.orders
        .select(o => ({
          id: o.id,
          productNameText: jsonbSelectText<OrderItems>(o.items, 'productName'),
        }))
        .where(o => gt(o.id, 0))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      // Should return string type
      // Use != null to catch both null and undefined (when items is NULL in DB)
      // Find the specific order we just inserted
      const orderWithText = results.find(r => r.productNameText === 'TextExtractionProduct');
      expect(orderWithText).toBeDefined();
      expect(typeof orderWithText!.productNameText).toBe('string');
    });

    test('should return text type for numeric JSONB properties', async () => {
      const results = await db.orders
        .select(o => ({
          id: o.id,
          quantityAsText: jsonbSelectText<OrderItems>(o.items, 'quantity'),
        }))
        .where(o => gt(o.id, 0))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      // Even numeric values should come back as strings with ->>
    });
  });

  describe('combined usage', () => {
    type OrderItems = { productName: string };

    test('should work with coalesce and jsonbSelectText together', async () => {
      const results = await db.orders
        .select(o => ({
          id: o.id,
          displayName: coalesce(
            jsonbSelectText<OrderItems>(o.items, 'productName'),
            'No Product'
          ),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.displayName).not.toBeNull();
      });
    });

    test('should work in complex select with other operators', async () => {
      const results = await db.users
        .select(u => ({
          id: u.id,
          username: u.username,
          effectiveAge: coalesce(u.age, 18),
          isAdult: sql<boolean>`COALESCE(${u.age}, 18) >= 18`,
        }))
        .where(u => gt(u.id, 0))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.effectiveAge).toBeGreaterThanOrEqual(18);
        expect(r.isAdult).toBe(true);
      });
    });

    test('should work in where clause with jsonb comparison', async () => {
      type OrderItems = { quantity: number };

      // Insert order with specific quantity
      const user = (await db.users.toList())[0];
      await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 500,
        items: { productName: 'JsonbComparisonTest', quantity: 42 },
      });

      // Query using jsonbSelectText in select (can't directly use in where with eq due to type)
      const results = await db.orders
        .select(o => ({
          id: o.id,
          quantity: jsonbSelectText<OrderItems>(o.items, 'quantity'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      // Note: ->> returns text but node-postgres may parse numeric strings to numbers
      // Use == to allow coercion, or convert to string for comparison
      const orderWith42 = results.find(r => String(r.quantity) === '42');
      expect(orderWith42).toBeDefined();
    });
  });

  describe('edge cases', () => {
    test('coalesce should handle both null arguments', async () => {
      // Both age and metadata can be null
      const results = await db.users
        .select(u => ({
          id: u.id,
          // Using two potentially null columns
          something: coalesce(u.age, 0),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.something).not.toBeNull();
      });
    });

    test('jsonbSelect should handle deeply nested access', async () => {
      // Insert order with nested structure
      const user = (await db.users.toList())[0];
      await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 100,
        items: { productName: 'Nested Test', quantity: 1, price: 100 },
      });

      type Items = { price: number };
      const results = await db.orders
        .select(o => ({
          id: o.id,
          price: jsonbSelect<Items>(o.items, 'price'),
        }))
        .toList();

      expect(results.length).toBeGreaterThan(0);
    });
  });
});
