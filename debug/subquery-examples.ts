import 'dotenv/config';
import {
  eq,
  gt,
  sql,
  and,
  PgClient,
} from '../src';
import { AppDatabase } from './schema/appDatabase';

/**
 * Subquery Examples - Strongly Typed Subqueries
 *
 * This demonstrates how to use subqueries with the sql`` template literal.
 * Subqueries maintain type safety and can be used in:
 * - WHERE clauses (EXISTS, IN, scalar comparisons)
 * - SELECT clauses (scalar subqueries, aggregations)
 * - Complex nested scenarios
 */

async function main() {
  console.log('Linkgress ORM - Subquery Examples\n');

  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'linkgress_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(
    client,
    {
      logQueries: true,
      logExecutionTime: true,
      logParameters: true,
    }
  );

  try {
    console.log('Setting up test data...');
    await db.ensureDeleted();
    await db.ensureCreated();

    // Create test users
    const activeUser = await db.users.insert({
      username: 'active_user',
      email: 'active@example.com',
      age: 30,
      isActive: true,
    });

    const inactiveUser = await db.users.insert({
      username: 'inactive_user',
      email: 'inactive@example.com',
      age: 25,
      isActive: false,
    });

    const oldUser = await db.users.insert({
      username: 'old_user',
      email: 'old@example.com',
      age: 50,
      isActive: true,
    });

    // Create posts for active user
    await db.posts.insert({
      title: 'Popular Post',
      content: 'This is very popular',
      userId: activeUser.id,
      views: 1000,
    });

    await db.posts.insert({
      title: 'Another Post',
      content: 'Also popular',
      userId: activeUser.id,
      views: 500,
    });

    // Create post for inactive user
    await db.posts.insert({
      title: 'Unpopular Post',
      content: 'Not many views',
      userId: inactiveUser.id,
      views: 10,
    });

    console.log('✓ Test data created\n');

    // ========================================================================
    // Example 1: EXISTS - Find users who have posts
    // ========================================================================
    console.log('1. EXISTS - Users who have posts:');

    const usersWithPosts = await db.users
      .where(u => sql`EXISTS(
        SELECT 1 FROM posts WHERE user_id = ${u.id}
      )`)
      .select(u => ({
        id: u.id,
        username: u.username,
      }))
      .toList();

    console.log('   Users with posts:', usersWithPosts);
    console.log('');

    // ========================================================================
    // Example 2: NOT EXISTS - Find users who have NO posts
    // ========================================================================
    console.log('2. NOT EXISTS - Users without posts:');

    const usersWithoutPosts = await db.users
      .where(u => sql`NOT EXISTS(
        SELECT 1 FROM posts WHERE user_id = ${u.id}
      )`)
      .select(u => ({
        id: u.id,
        username: u.username,
      }))
      .toList();

    console.log('   Users without posts:', usersWithoutPosts);
    console.log('');

    // ========================================================================
    // Example 3: IN Subquery - Find posts by active users
    // ========================================================================
    console.log('3. IN Subquery - Posts by active users:');

    const postsByActiveUsers = await db.posts
      .where(p => sql`${p.userId} IN (
        SELECT id FROM users WHERE is_active = true
      )`)
      .select(p => ({
        id: p.id,
        title: p.title,
        views: p.views,
      }))
      .toList();

    console.log('   Posts by active users:', postsByActiveUsers);
    console.log('');

    // ========================================================================
    // Example 4: Scalar Subquery in SELECT - Add post count to each user
    // ========================================================================
    console.log('4. Scalar Subquery in SELECT - Users with post count:');

    const usersWithPostCount = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        age: u.age,
        postCount: sql<number>`(
          SELECT COUNT(*) FROM posts WHERE user_id = ${u.id}
        )`,
      }))
      .toList();

    console.log('   Users with post counts:', usersWithPostCount);
    console.log('');

    // ========================================================================
    // Example 5: Scalar Subquery - Users with max views
    // ========================================================================
    console.log('5. Scalar Subquery - Users with max post views:');

    const usersWithMaxViews = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        maxViews: sql<number>`(
          SELECT COALESCE(MAX(views), 0) FROM posts WHERE user_id = ${u.id}
        )`,
      }))
      .toList();

    console.log('   Users with max views:', usersWithMaxViews);
    console.log('');

    // ========================================================================
    // Example 6: Scalar Comparison - Users older than average
    // ========================================================================
    console.log('6. Scalar Comparison - Users older than average:');

    const olderThanAverage = await db.users
      .where(u => sql`${u.age} > (SELECT AVG(age) FROM users)`)
      .select(u => ({
        id: u.id,
        username: u.username,
        age: u.age,
      }))
      .toList();

    console.log('   Users older than average:', olderThanAverage);
    console.log('');

    // ========================================================================
    // Example 7: Complex Nested Subqueries
    // ========================================================================
    console.log('7. Complex - Users with posts that have above-average views:');

    const usersWithPopularPosts = await db.users
      .where(u => sql`EXISTS(
        SELECT 1 FROM posts
        WHERE user_id = ${u.id}
        AND views > (SELECT AVG(views) FROM posts)
      )`)
      .select(u => ({
        id: u.id,
        username: u.username,
        popularPostCount: sql<number>`(
          SELECT COUNT(*)
          FROM posts
          WHERE user_id = ${u.id}
          AND views > (SELECT AVG(views) FROM posts)
        )`,
      }))
      .toList();

    console.log('   Users with popular posts:', usersWithPopularPosts);
    console.log('');

    // ========================================================================
    // Example 8: Multiple Subqueries in SELECT
    // ========================================================================
    console.log('8. Multiple subqueries - Comprehensive user stats:');

    const usersWithStats = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        totalViews: sql<number>`(
          SELECT COALESCE(SUM(views), 0) FROM posts WHERE user_id = ${u.id}
        )`,
        avgViews: sql<number>`(
          SELECT COALESCE(AVG(views), 0) FROM posts WHERE user_id = ${u.id}
        )`,
        postCount: sql<number>`(
          SELECT COUNT(*) FROM posts WHERE user_id = ${u.id}
        )`,
        hasViralPost: sql<boolean>`EXISTS(
          SELECT 1 FROM posts WHERE user_id = ${u.id} AND views > 500
        )`,
      }))
      .toList();

    console.log('   Users with comprehensive stats:', usersWithStats);
    console.log('');

    console.log('✅ All subquery examples completed successfully!');
    console.log('');
    console.log('Note: The subquery infrastructure is in place, including:');
    console.log('  - Subquery class with type safety');
    console.log('  - asSubquery() method on query builders');
    console.log('  - Helper functions (exists, inSubquery, etc.)');
    console.log('  - Full support in SELECT and WHERE clauses');
    console.log('');
    console.log('These examples use sql`` template for maximum flexibility.');
    console.log('The dedicated subquery API works with the low-level query builders.');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await db.ensureDeleted();
    await db.dispose();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { main };
