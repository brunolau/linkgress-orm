/**
 * Example: Using custom sequences in DbContext
 *
 * This example demonstrates how to define and use custom PostgreSQL sequences
 * for generating unique IDs or other sequential values.
 */

import { DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, integer, varchar, text, PgClient, sequence, DbSequence } from '../src';

// Define entities
class Order extends DbEntity {
  id!: DbColumn<number>;
  orderNumber!: DbColumn<string>;
  customerId!: DbColumn<number>;
  total!: DbColumn<number>;
}

class Customer extends DbEntity {
  id!: DbColumn<number>;
  customerCode!: DbColumn<string>;
  name!: DbColumn<string>;
}

// Database context with custom sequences
class AppDatabase extends DbContext {
  // Table accessors
  get orders(): DbEntityTable<Order> {
    return this.table(Order);
  }

  get customers(): DbEntityTable<Customer> {
    return this.table(Customer);
  }

  // Sequence accessors - similar to table accessors!
  get orderNumberSeq(): DbSequence {
    return this.sequence(
      sequence('order_number_seq')
        .startWith(1000)
        .incrementBy(1)
        .build()
    );
  }

  get customerCodeSeq(): DbSequence {
    return this.sequence(
      sequence('customer_code_seq')
        .inSchema('public')
        .startWith(100)
        .incrementBy(5)
        .build()
    );
  }

  get invoiceSeq(): DbSequence {
    return this.sequence(
      sequence('invoice_seq')
        .startWith(1)
        .incrementBy(1)
        .cache(20) // Cache 20 values for better performance
        .build()
    );
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Order, entity => {
      entity.toTable('orders');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'orders_id_seq' }));
      entity.property(e => e.orderNumber).hasType(varchar('order_number', 50)).isRequired();
      entity.property(e => e.customerId).hasType(integer('customer_id')).isRequired();
      entity.property(e => e.total).hasType(integer('total')).isRequired();
    });

    model.entity(Customer, entity => {
      entity.toTable('customers');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'customers_id_seq' }));
      entity.property(e => e.customerCode).hasType(varchar('customer_code', 20)).isRequired();
      entity.property(e => e.name).hasType(text('name')).isRequired();
    });
  }

  protected override setupSequences(): void {
    // Register sequences by accessing their getters
    this.orderNumberSeq;
    this.customerCodeSeq;
    this.invoiceSeq;
  }
}

// Usage example
async function main() {
  const client = new PgClient({
    host: 'localhost',
    port: 5432,
    database: 'myapp',
    user: 'postgres',
    password: 'postgres',
  });

  const db = new AppDatabase(client);

  // Create schema (this will also create the sequences)
  await db.getSchemaManager().ensureDeleted();
  await db.getSchemaManager().ensureCreated();

  console.log('📊 Sequence Examples\n');

  // Example 1: Generate order numbers
  console.log('--- Example 1: Generating Order Numbers ---');
  const orderNum1 = await db.orderNumberSeq.nextValue();
  const orderNum2 = await db.orderNumberSeq.nextValue();
  const orderNum3 = await db.orderNumberSeq.nextValue();

  console.log(`Order Number 1: ORD-${orderNum1}`); // ORD-1000
  console.log(`Order Number 2: ORD-${orderNum2}`); // ORD-1001
  console.log(`Order Number 3: ORD-${orderNum3}`); // ORD-1002

  // Create orders with generated order numbers
  const order1 = await db.orders.insert({
    orderNumber: `ORD-${orderNum1}`,
    customerId: 1,
    total: 99.99,
  });

  const order2 = await db.orders.insert({
    orderNumber: `ORD-${orderNum2}`,
    customerId: 2,
    total: 149.99,
  });

  console.log(`✓ Created orders: ${order1.orderNumber}, ${order2.orderNumber}\n`);

  // Example 2: Generate customer codes (increments by 5)
  console.log('--- Example 2: Generating Customer Codes ---');
  const custCode1 = await db.customerCodeSeq.nextValue();
  const custCode2 = await db.customerCodeSeq.nextValue();
  const custCode3 = await db.customerCodeSeq.nextValue();

  console.log(`Customer Code 1: CUST-${custCode1}`); // CUST-100
  console.log(`Customer Code 2: CUST-${custCode2}`); // CUST-105
  console.log(`Customer Code 3: CUST-${custCode3}`); // CUST-110

  // Create customers
  await db.customers.insert({
    customerCode: `CUST-${custCode1}`,
    name: 'Alice Johnson',
  });

  await db.customers.insert({
    customerCode: `CUST-${custCode2}`,
    name: 'Bob Smith',
  });

  console.log(`✓ Created customers with codes\n`);

  // Example 3: Get current value without incrementing
  console.log('--- Example 3: Current Value ---');
  const currentInvoice = await db.invoiceSeq.nextValue(); // Increments to 1
  console.log(`Invoice sequence next value: ${currentInvoice}`);

  const currentValue = await db.invoiceSeq.currentValue(); // Returns 1 (no increment)
  console.log(`Invoice sequence current value: ${currentValue}`);

  const nextInvoice = await db.invoiceSeq.nextValue(); // Increments to 2
  console.log(`Invoice sequence next value: ${nextInvoice}\n`);

  // Example 4: Resync sequence to a specific value
  console.log('--- Example 4: Resync Sequence ---');
  console.log(`Before resync: ${await db.invoiceSeq.currentValue()}`);

  await db.invoiceSeq.resync(5000);
  console.log(`After resync to 5000: ${await db.invoiceSeq.currentValue()}`);

  const afterResync = await db.invoiceSeq.nextValue();
  console.log(`Next value after resync: ${afterResync}\n`); // 5001

  // Example 5: Using sequences in batch operations
  console.log('--- Example 5: Batch Order Creation ---');
  const batchSize = 5;
  const orderNumbers = [];

  for (let i = 0; i < batchSize; i++) {
    orderNumbers.push(await db.orderNumberSeq.nextValue());
  }

  const batchOrders = orderNumbers.map((num, idx) => ({
    orderNumber: `ORD-${num}`,
    customerId: idx + 1,
    total: (idx + 1) * 10,
  }));

  await db.orders.insertBulk(batchOrders);
  console.log(`✓ Created ${batchSize} orders in batch`);
  console.log(`Order numbers: ${orderNumbers.map(n => `ORD-${n}`).join(', ')}\n`);

  // Query all orders
  const allOrders = await db.orders
    .select(o => ({ orderNumber: o.orderNumber, total: o.total }))
    .toList();

  console.log('All orders:');
  allOrders.forEach(o => console.log(`  ${o.orderNumber}: $${o.total}`));

  await db.dispose();
}

// Uncomment to run
// main().catch(console.error);
