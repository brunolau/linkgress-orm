import { PgClient } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { User } from '../../debug/model/user';
import { Post } from '../../debug/model/post';
import { Order } from '../../debug/model/order';
import { Task } from '../../debug/model/task';
import { TaskLevel } from '../../debug/model/taskLevel';
import { OrderTask } from '../../debug/model/orderTask';
import { PostComment } from '../../debug/model/postComment';
// New imports for complex ecommerce pattern test
import { Product } from '../../debug/model/product';
import { ProductPrice } from '../../debug/model/productPrice';
import { ProductPriceCapacityGroup } from '../../debug/model/productPriceCapacityGroup';
import { CapacityGroup } from '../../debug/model/capacityGroup';
import { Tag } from '../../debug/model/tag';
import { ProductTag } from '../../debug/model/productTag';

/**
 * Create a test database instance
 */
export function createTestDatabase(options?: {
  logQueries?: boolean;
  collectionStrategy?: 'cte' | 'temptable' | 'lateral';
}): AppDatabase {
  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'linkgress_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  return new AppDatabase(client, {
    logQueries: options?.logQueries ?? false,
    logParameters: options?.logQueries ?? false,
    collectionStrategy: options?.collectionStrategy ?? 'cte',
  });
}

/**
 * Setup database for tests - drops and recreates schema
 */
export async function setupDatabase(db: AppDatabase): Promise<void> {
  await db.getSchemaManager().ensureDeleted();
  await db.getSchemaManager().ensureCreated();
}

/**
 * Cleanup database after tests
 */
export async function cleanupDatabase(db: AppDatabase): Promise<void> {
  await db.getSchemaManager().ensureDeleted();
  await db.dispose();
}

/**
 * Seed database with test data
 */
export async function seedTestData(db: AppDatabase) {
  // Create users with .returning() to get the inserted entities with IDs
  const alice = await db.users.insert({
    username: 'alice',
    email: 'alice@test.com',
    age: 25,
    isActive: true,
  }).returning();

  const bob = await db.users.insert({
    username: 'bob',
    email: 'bob@test.com',
    age: 35,
    isActive: true,
  }).returning();

  const charlie = await db.users.insert({
    username: 'charlie',
    email: 'charlie@test.com',
    age: 45,
    isActive: false,
  }).returning();

  // Create posts
  const baseDate = new Date('2024-01-15T10:00:00Z');
  const alicePost1 = await db.posts.insert({
    title: 'Alice Post 1',
    content: 'Content from Alice',
    userId: alice.id,
    views: 100,
    customDate: baseDate,
    publishTime: { hour: 9, minute: 30 },  // Custom mapper: pgHourMinute
  }).returning();

  const alicePost2 = await db.posts.insert({
    title: 'Alice Post 2',
    content: 'More content from Alice',
    userId: alice.id,
    views: 150,
    customDate: new Date('2024-01-16T10:00:00Z'),
    publishTime: { hour: 14, minute: 0 },  // Custom mapper: pgHourMinute
  }).returning();

  const bobPost = await db.posts.insert({
    title: 'Bob Post',
    content: 'Content from Bob',
    userId: bob.id,
    views: 200,
    customDate: baseDate,
    publishTime: { hour: 18, minute: 45 },  // Custom mapper: pgHourMinute
  }).returning();

  // Create orders
  const aliceOrder = await db.orders.insert({
    userId: alice.id,
    status: 'completed',
    totalAmount: 99.99,
  }).returning();

  const bobOrder = await db.orders.insert({
    userId: bob.id,
    status: 'pending',
    totalAmount: 149.99,
  }).returning();

  // Create task levels (need user for createdBy)
  const highPriority = await db.taskLevels.insert({
    name: 'High Priority',
    createdById: alice.id,
  }).returning();

  const lowPriority = await db.taskLevels.insert({
    name: 'Low Priority',
    createdById: bob.id,
  }).returning();

  // Create tasks
  const task1 = await db.tasks.insert({
    title: 'Important Task',
    status: 'pending',
    priority: 'high',
    levelId: highPriority.id,
  }).returning();

  const task2 = await db.tasks.insert({
    title: 'Regular Task',
    status: 'processing',
    priority: 'medium',
    levelId: lowPriority.id,
  }).returning();

  // Create order-task associations
  await db.orderTasks.insert({
    orderId: aliceOrder.id,
    taskId: task1.id,
    sortOrder: 1,
  }).returning();

  await db.orderTasks.insert({
    orderId: bobOrder.id,
    taskId: task2.id,
    sortOrder: 1,
  }).returning();

  // Create post comments (links posts to orders - used for testing sibling collection isolation)
  // Alice's first post mentions Alice's order
  const alicePostComment1 = await db.postComments.insert({
    postId: alicePost1.id,
    orderId: aliceOrder.id,
    comment: 'Related to order',
  }).returning();

  // Alice's second post mentions Bob's order
  const alicePostComment2 = await db.postComments.insert({
    postId: alicePost2.id,
    orderId: bobOrder.id,
    comment: 'Mentions another order',
  }).returning();

  // Bob's post mentions his own order
  const bobPostComment = await db.postComments.insert({
    postId: bobPost.id,
    orderId: bobOrder.id,
    comment: 'My order update',
  }).returning();

  // ============ PRODUCT/PRICE DATA FOR COMPLEX ECOMMERCE PATTERN TEST ============
  // This replicates the schema that triggers the sibling collection isolation bug

  // Create tags
  const summerTag = await db.tags.insert({ name: 'Summer' }).returning();
  const winterTag = await db.tags.insert({ name: 'Winter' }).returning();
  const familyTag = await db.tags.insert({ name: 'Family' }).returning();

  // Create capacity groups
  const adultGroup = await db.capacityGroups.insert({ name: 'Adult' }).returning();
  const childGroup = await db.capacityGroups.insert({ name: 'Child' }).returning();
  const seniorGroup = await db.capacityGroups.insert({ name: 'Senior' }).returning();

  // Create products
  const skiPass = await db.products.insert({ name: 'Ski Pass', active: true }).returning();
  const liftTicket = await db.products.insert({ name: 'Lift Ticket', active: true }).returning();

  // Create product prices for skiPass (multiple seasons)
  const skiPassPrice1 = await db.productPrices.insert({
    productId: skiPass.id,
    seasonId: 1, // Winter season
    price: 100.00,
  }).returning();

  const skiPassPrice2 = await db.productPrices.insert({
    productId: skiPass.id,
    seasonId: 2, // Summer season
    price: 50.00,
  }).returning();

  // Create product prices for liftTicket
  const liftTicketPrice1 = await db.productPrices.insert({
    productId: liftTicket.id,
    seasonId: 1,
    price: 75.00,
  }).returning();

  // Create product price capacity groups (nested collection data)
  await db.productPriceCapacityGroups.insert({
    productPriceId: skiPassPrice1.id,
    capacityGroupId: adultGroup.id,
  }).returning();

  await db.productPriceCapacityGroups.insert({
    productPriceId: skiPassPrice1.id,
    capacityGroupId: childGroup.id,
  }).returning();

  await db.productPriceCapacityGroups.insert({
    productPriceId: skiPassPrice2.id,
    capacityGroupId: adultGroup.id,
  }).returning();

  await db.productPriceCapacityGroups.insert({
    productPriceId: liftTicketPrice1.id,
    capacityGroupId: seniorGroup.id,
  }).returning();

  // Create product tags (sibling collection)
  await db.productTags.insert({
    productId: skiPass.id,
    tagId: winterTag.id,
    sortOrder: 1,
  }).returning();

  await db.productTags.insert({
    productId: skiPass.id,
    tagId: familyTag.id,
    sortOrder: 2,
  }).returning();

  await db.productTags.insert({
    productId: liftTicket.id,
    tagId: summerTag.id,
    sortOrder: 1,
  }).returning();

  return {
    users: { alice, bob, charlie },
    posts: { alicePost1, alicePost2, bobPost },
    orders: { aliceOrder, bobOrder },
    taskLevels: { highPriority, lowPriority },
    tasks: { task1, task2 },
    postComments: { alicePostComment1, alicePostComment2, bobPostComment },
    // New data for complex ecommerce pattern
    tags: { summerTag, winterTag, familyTag },
    capacityGroups: { adultGroup, childGroup, seniorGroup },
    products: { skiPass, liftTicket },
    productPrices: { skiPassPrice1, skiPassPrice2, liftTicketPrice1 },
  };
}

/**
 * Execute a test with database setup and cleanup
 */
export async function withDatabase<T>(
  testFn: (db: AppDatabase) => Promise<T>,
  options?: {
    logQueries?: boolean;
    collectionStrategy?: 'cte' | 'temptable' | 'lateral';
  }
): Promise<T> {
  const db = createTestDatabase(options);
  try {
    await setupDatabase(db);
    return await testFn(db);
  } finally {
    await cleanupDatabase(db);
  }
}
