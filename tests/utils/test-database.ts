import { PgClient } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { User } from '../../debug/model/user';
import { Post } from '../../debug/model/post';
import { Order } from '../../debug/model/order';

/**
 * Create a test database instance
 */
export function createTestDatabase(options?: {
  logQueries?: boolean;
  collectionStrategy?: 'jsonb' | 'temptable';
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
    collectionStrategy: options?.collectionStrategy ?? 'jsonb',
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
  const alicePost1 = await db.posts.insert({
    title: 'Alice Post 1',
    content: 'Content from Alice',
    userId: alice.id,
    views: 100,
  }).returning();

  const alicePost2 = await db.posts.insert({
    title: 'Alice Post 2',
    content: 'More content from Alice',
    userId: alice.id,
    views: 150,
  }).returning();

  const bobPost = await db.posts.insert({
    title: 'Bob Post',
    content: 'Content from Bob',
    userId: bob.id,
    views: 200,
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

  return {
    users: { alice, bob, charlie },
    posts: { alicePost1, alicePost2, bobPost },
    orders: { aliceOrder, bobOrder },
  };
}

/**
 * Execute a test with database setup and cleanup
 */
export async function withDatabase<T>(
  testFn: (db: AppDatabase) => Promise<T>,
  options?: {
    logQueries?: boolean;
    collectionStrategy?: 'jsonb' | 'temptable';
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
