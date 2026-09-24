import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DatabaseClient, eq, inArray } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createFreshClient, seedTestData, setupDatabase } from '../utils/test-database';

/**
 * A client whose driver drops the scale of a numeric ZERO (Bun's binary decoder reads a
 * `numeric(10, 2)` `0.00` as `"0"`) says so through `losesNumericZeroScale()`, and every read path
 * gives such a column's zero its scale back — the entity rows, a projection, a single-value
 * projection, and every mutation's RETURNING (plain and navigation). A column without a declared
 * scale, and any non-zero value, are left as the driver delivered them.
 *
 * The driver quirk is simulated by wrapping the suite's client, so the paths run on every driver.
 */
function zeroScaleDroppingClient(inner: DatabaseClient, reportsLoss: boolean): DatabaseClient {
  const drop = (value: unknown): unknown => (typeof value === 'string' && /^-?0\.0+$/.test(value) ? '0' : value);

  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'losesNumericZeroScale') {
        return () => reportsLoss;
      }

      if (prop === 'query') {
        return async (...args: any[]) => {
          const result = await (target as any).query(...args);

          return {
            ...result,
            rows: result.rows.map((row: Record<string, unknown>) => {
              const out: Record<string, unknown> = {};
              for (const key of Object.keys(row)) {
                out[key] = drop(row[key]);
              }
              return out;
            }),
          };
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('numeric zero scale', () => {
  let client: DatabaseClient;

  beforeAll(() => {
    client = createFreshClient();
  });

  afterAll(async () => {
    await client.end();
  });

  const databaseFor = (reportsLoss: boolean) =>
    new AppDatabase(zeroScaleDroppingClient(client, reportsLoss), { collectionStrategy: 'lateral' });

  test('every read path gives a numeric(10, 2) zero its scale back', async () => {
    const db = databaseFor(true);
    await setupDatabase(db);
    const { users } = await seedTestData(db);
    const zero = { userId: users.alice.id, totalAmount: 0, status: 'pending' as const };

    // Mutation RETURNING: the whole row, a projection, a navigation projection, one value
    const inserted = await db.orders.insert(zero).returning();
    expect(inserted.totalAmount as unknown).toBe('0.00');
    expect((await db.orders.insert(zero).returning(o => ({ amount: o.totalAmount }))).amount as unknown).toBe('0.00');
    expect((await db.orders.insert(zero).returning(o => ({ amount: o.totalAmount, who: o.user!.username }))).amount as unknown).toBe('0.00');
    expect(await db.orders.insert(zero).returning(o => o.totalAmount) as unknown).toBe('0.00');

    // Reads: entity rows, a projection, one value
    const [row] = await db.orders.where(o => eq(o.id, inserted.id)).toList();
    expect(row.totalAmount as unknown).toBe('0.00');
    expect((await db.orders.where(o => eq(o.id, inserted.id)).select(o => ({ amount: o.totalAmount })).toList())[0].amount as unknown).toBe('0.00');
    expect(await db.orders.where(o => eq(o.id, inserted.id)).select(o => o.totalAmount).toList() as unknown).toEqual(['0.00']);

    // update / delete RETURNING
    const [updated] = await db.orders.where(o => eq(o.id, inserted.id)).update({ status: 'completed' }).returning();
    expect(updated.totalAmount as unknown).toBe('0.00');
    const [updatedAmount] = await db.orders.where(o => eq(o.id, inserted.id)).update({ status: 'pending' }).returning(o => ({ amount: o.totalAmount }));
    expect(updatedAmount.amount as unknown).toBe('0.00');
    expect(await db.orders.where(o => eq(o.id, inserted.id)).delete().returning(o => o.totalAmount) as unknown).toEqual(['0.00']);

    // A non-zero value is left as it is
    const seeded = await db.orders.orderBy(o => o.id).select(o => o.totalAmount).first();
    expect(seeded as unknown).toBe('99.99');
  });

  test('a client that does not report the loss gets no restoration', async () => {
    const db = databaseFor(false);
    await setupDatabase(db);
    const { users } = await seedTestData(db);

    const inserted = await db.orders.insert({ userId: users.bob.id, totalAmount: 0, status: 'pending' }).returning(o => ({ id: o.id, amount: o.totalAmount }));

    // What the (simulated) driver delivered
    expect(inserted.amount as unknown).toBe('0');
  });

  test('only a column with a declared scale is restored', async () => {
    const db = databaseFor(true);
    const labels = ['nz-zero'];
    await db.typeZoo.where(z => inArray(z.label, labels)).delete();

    try {
      const row = await db.typeZoo.insert({ label: 'nz-zero', vDecimal: 0, vNumeric: 0 } as any).returning(z => ({ dec: z.vDecimal, num: z.vNumeric }));

      // numeric(20, 4) gets its scale back; an unconstrained numeric has none to restore
      expect(row.dec as unknown).toBe('0.0000');
      expect(row.num as unknown).toBe('0');
    } finally {
      await db.typeZoo.where(z => inArray(z.label, labels)).delete();
    }
  });
});
