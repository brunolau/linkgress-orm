import { PgClient } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';

// Shared database instances per strategy (reuse connections)
const sharedDatabases: Map<string, AppDatabase> = new Map();

// Shared PgClient (single connection pool for all strategies)
let sharedClient: PgClient | null = null;

function getSharedClient(): PgClient {
  if (!sharedClient) {
    sharedClient = new PgClient({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'linkgress_test',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    });
  }
  return sharedClient;
}

/**
 * Create a test database instance (uses shared client)
 */
export function createTestDatabase(options?: {
  logQueries?: boolean;
  collectionStrategy?: 'cte' | 'temptable' | 'lateral';
}): AppDatabase {
  return new AppDatabase(getSharedClient(), {
    logQueries: options?.logQueries ?? false,
    logParameters: options?.logQueries ?? false,
    collectionStrategy: options?.collectionStrategy ?? 'cte',
  });
}

/**
 * Create a fresh PgClient for tests that need their own isolated schema
 * (e.g., tests that use a custom DbContext with different tables)
 */
export function createFreshClient(): PgClient {
  return new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'linkgress_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
}

/**
 * Get or create a shared database instance for the given strategy
 */
export function getSharedDatabase(options?: {
  logQueries?: boolean;
  collectionStrategy?: 'cte' | 'temptable' | 'lateral';
}): AppDatabase {
  const strategy = options?.collectionStrategy ?? 'cte';
  const key = strategy;

  if (!sharedDatabases.has(key)) {
    sharedDatabases.set(key, createTestDatabase(options));
  }
  return sharedDatabases.get(key)!;
}

/**
 * Setup database for tests
 * Schema is created in globalSetup, this just truncates tables
 * If truncation fails (schema was dropped), recreate the schema
 */
export async function setupDatabase(db: AppDatabase): Promise<void> {
  try {
    await truncateAllTables(db);
  } catch (error: any) {
    // If truncation fails because tables don't exist, recreate the schema
    if (error.message?.includes('does not exist')) {
      await db.getSchemaManager().ensureDeleted();
      await db.getSchemaManager().ensureCreated();
    } else {
      throw error;
    }
  }
}

/**
 * Cleanup database after tests
 * No-op - cleanup happens via truncate on next setupDatabase
 */
export async function cleanupDatabase(_db: AppDatabase): Promise<void> {
  // With shared client, cleanup is handled by truncate in setupDatabase
}


/**
 * Truncate all tables (fast cleanup between tests)
 * Uses TRUNCATE CASCADE to handle foreign key constraints
 */
async function truncateAllTables(db: AppDatabase): Promise<void> {
  // Using TRUNCATE CASCADE handles foreign key constraints automatically
  // RESTART IDENTITY resets auto-increment sequences
  await db.query(`
    TRUNCATE TABLE
      product_tags,
      product_price_capacity_groups,
      product_prices,
      products,
      tags,
      capacity_groups,
      post_comments,
      order_task,
      tasks,
      task_levels,
      orders,
      posts,
      schema_posts,
      auth.schema_users,
      users
    RESTART IDENTITY CASCADE
  `);
}


/**
 * Dispose the shared database connection (call at end of test suite)
 */
export async function disposeSharedDatabase(): Promise<void> {
  sharedDatabases.clear();
  if (sharedClient) {
    await sharedClient.end();
    sharedClient = null;
  }
}

/**
 * Seed database with test data using bulk inserts for better performance
 */
export async function seedTestData(db: AppDatabase) {
  const baseDate = new Date('2024-01-15T10:00:00Z');

  // Create users with bulk insert
  const [alice, bob, charlie] = await db.users.insertBulk([
    { username: 'alice', email: 'alice@test.com', age: 25, isActive: true, lastActiveAt: new Date('2025-03-15T08:00:00Z') },
    { username: 'bob', email: 'bob@test.com', age: 35, isActive: true, lastActiveAt: new Date('2025-06-20T14:30:00Z') },
    { username: 'charlie', email: 'charlie@test.com', age: 45, isActive: false, lastActiveAt: new Date('2025-01-10T22:00:00Z') },
  ]).returning();

  // Create posts with bulk insert
  const [alicePost1, alicePost2, bobPost] = await db.posts.insertBulk([
    {
      title: 'Alice Post 1',
      content: 'Content from Alice',
      userId: alice.id,
      views: 100,
      customDate: baseDate,
      publishTime: { hour: 9, minute: 30 },
    },
    {
      title: 'Alice Post 2',
      content: 'More content from Alice',
      userId: alice.id,
      views: 150,
      customDate: new Date('2024-01-16T10:00:00Z'),
      publishTime: { hour: 14, minute: 0 },
    },
    {
      title: 'Bob Post',
      content: 'Content from Bob',
      userId: bob.id,
      views: 200,
      customDate: baseDate,
      publishTime: { hour: 18, minute: 45 },
    },
  ]).returning();

  // Create orders with bulk insert
  const [aliceOrder, bobOrder] = await db.orders.insertBulk([
    { userId: alice.id, status: 'completed', totalAmount: 99.99 },
    { userId: bob.id, status: 'pending', totalAmount: 149.99 },
  ]).returning();

  // Create task levels with bulk insert
  const [highPriority, lowPriority] = await db.taskLevels.insertBulk([
    { name: 'High Priority', createdById: alice.id },
    { name: 'Low Priority', createdById: bob.id },
  ]).returning();

  // Create tasks with bulk insert
  const [task1, task2] = await db.tasks.insertBulk([
    { title: 'Important Task', status: 'pending', priority: 'high', levelId: highPriority.id },
    { title: 'Regular Task', status: 'processing', priority: 'medium', levelId: lowPriority.id },
  ]).returning();

  // Create order-task associations with bulk insert
  await db.orderTasks.insertBulk([
    { orderId: aliceOrder.id, taskId: task1.id, sortOrder: 1 },
    { orderId: bobOrder.id, taskId: task2.id, sortOrder: 1 },
  ]);

  // Create post comments with bulk insert
  const [alicePostComment1, alicePostComment2, bobPostComment] = await db.postComments.insertBulk([
    { postId: alicePost1.id, orderId: aliceOrder.id, comment: 'Related to order' },
    { postId: alicePost2.id, orderId: bobOrder.id, comment: 'Mentions another order' },
    { postId: bobPost.id, orderId: bobOrder.id, comment: 'My order update' },
  ]).returning();

  // ============ PRODUCT/PRICE DATA FOR COMPLEX ECOMMERCE PATTERN TEST ============

  // Create tags with bulk insert
  const [summerTag, winterTag, familyTag] = await db.tags.insertBulk([
    { name: 'Summer' },
    { name: 'Winter' },
    { name: 'Family' },
  ]).returning();

  // Create capacity groups with bulk insert
  const [adultGroup, childGroup, seniorGroup] = await db.capacityGroups.insertBulk([
    { name: 'Adult' },
    { name: 'Child' },
    { name: 'Senior' },
  ]).returning();

  // Create products with bulk insert
  const [skiPass, liftTicket] = await db.products.insertBulk([
    { name: 'Ski Pass', active: true },
    { name: 'Lift Ticket', active: true },
  ]).returning();

  // Create product prices with bulk insert
  const [skiPassPrice1, skiPassPrice2, liftTicketPrice1] = await db.productPrices.insertBulk([
    { productId: skiPass.id, seasonId: 1, price: 100.00 },
    { productId: skiPass.id, seasonId: 2, price: 50.00 },
    { productId: liftTicket.id, seasonId: 1, price: 75.00 },
  ]).returning();

  // Create product price capacity groups with bulk insert
  await db.productPriceCapacityGroups.insertBulk([
    { productPriceId: skiPassPrice1.id, capacityGroupId: adultGroup.id },
    { productPriceId: skiPassPrice1.id, capacityGroupId: childGroup.id },
    { productPriceId: skiPassPrice2.id, capacityGroupId: adultGroup.id },
    { productPriceId: liftTicketPrice1.id, capacityGroupId: seniorGroup.id },
  ]);

  // Create product tags with bulk insert
  await db.productTags.insertBulk([
    { productId: skiPass.id, tagId: winterTag.id, sortOrder: 1 },
    { productId: skiPass.id, tagId: familyTag.id, sortOrder: 2 },
    { productId: liftTicket.id, tagId: summerTag.id, sortOrder: 1 },
  ]);

  return {
    users: { alice, bob, charlie },
    posts: { alicePost1, alicePost2, bobPost },
    orders: { aliceOrder, bobOrder },
    taskLevels: { highPriority, lowPriority },
    tasks: { task1, task2 },
    postComments: { alicePostComment1, alicePostComment2, bobPostComment },
    tags: { summerTag, winterTag, familyTag },
    capacityGroups: { adultGroup, childGroup, seniorGroup },
    products: { skiPass, liftTicket },
    productPrices: { skiPassPrice1, skiPassPrice2, liftTicketPrice1 },
  };
}

/**
 * Execute a test with database setup and cleanup
 * Uses a shared database connection and truncates tables between tests for performance
 */
export async function withDatabase<T>(
  testFn: (db: AppDatabase) => Promise<T>,
  options?: {
    logQueries?: boolean;
    collectionStrategy?: 'cte' | 'temptable' | 'lateral';
  }
): Promise<T> {
  const db = getSharedDatabase(options);
  await setupDatabase(db);
  return await testFn(db);
}

