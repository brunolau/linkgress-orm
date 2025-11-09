import 'dotenv/config';
import { eq, gt, and, PgClient } from '../src';
import { AppDatabase } from '../debug/schema/appDatabase';

/**
 * Manual Join Examples
 *
 * Demonstrates strongly-typed leftJoin and innerJoin operations
 */

async function main() {
  console.log('Linkgress ORM - Manual Joins Example\n');

  const client = new PgClient({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'linkgress_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const db = new AppDatabase(client, {
    logQueries: true,
    logExecutionTime: true,
    logParameters: true,
  });

  try {
    console.log('Setting up database...');
    await db.ensureDeleted();
    await db.ensureCreated();

    // Insert test data
    const user1 = await db.users.insert({
      username: 'john_doe',
      email: 'john@example.com',
      age: 30,
      isActive: true,
    });

    const user2 = await db.users.insert({
      username: 'jane_smith',
      email: 'jane@example.com',
      age: 28,
      isActive: true,
    });

    await db.posts.insert({
      title: 'Getting Started',
      content: 'Welcome to Linkgress ORM',
      userId: user1.id,
      views: 100,
    });

    await db.posts.insert({
      title: 'Advanced Patterns',
      content: 'Complex queries made easy',
      userId: user1.id,
      views: 50,
    });

    await db.posts.insert({
      title: 'TypeScript Tips',
      content: 'Fully typed queries',
      userId: user2.id,
      views: 75,
    });

    console.log('✓ Test data inserted\n');

    // Example 1: Simple LEFT JOIN
    console.log('1. LEFT JOIN - All users with their posts (includes users without posts):');
    const leftJoinResult = await db.users
      .leftJoin(
        db.posts,
        // Join condition - strongly typed
        (user, post) => eq(user.id, post.userId),
        // Select columns from both tables - strongly typed
        (user, post) => ({
          userId: user.id,
          username: user.username,
          postId: post.id,
          postTitle: post.title,
          postViews: post.views,
        })
      )
      .toList();

    console.log('   ✓ Results:', JSON.stringify(leftJoinResult, null, 2));
    console.log('');

    // Example 2: INNER JOIN
    console.log('2. INNER JOIN - Only users who have posts:');
    const innerJoinResult = await db.users
      .innerJoin(
        db.posts,
        // Join condition
        (user, post) => eq(user.id, post.userId),
        // Select columns
        (user, post) => ({
          userId: user.id,
          username: user.username,
          email: user.email,
          postId: post.id,
          postTitle: post.title,
          content: post.content,
          postViews: post.views,
        })
      )
      .toList();

    console.log('   ✓ Results:', JSON.stringify(innerJoinResult, null, 2));
    console.log('');

    // Example 3: JOIN with WHERE clause
    console.log('3. JOIN with WHERE - Posts with more than 50 views:');
    const joinWithWhereResult = await db.users
      .innerJoin(
        db.posts,
        (user, post) => eq(user.id, post.userId),
        (user, post) => ({
          userId: user.id,
          username: user.username,
          postTitle: post.title,
          postViews: post.views,
        })
      )
      .where((joined) => gt(joined.postViews, 50))
      .toList();

    console.log('   ✓ Results:', JSON.stringify(joinWithWhereResult, null, 2));
    console.log('');

    // Example 4: JOIN with ORDER BY and LIMIT
    console.log('4. JOIN with ORDER BY and LIMIT - Top 2 posts by views:');
    const joinWithOrderResult = await db.users
      .innerJoin(
        db.posts,
        (user, post) => eq(user.id, post.userId),
        (user, post) => ({
          username: user.username,
          postTitle: post.title,
          postViews: post.views,
        })
      )
      .orderBy(p => [p.postTitle, 'DESC'])
      .limit(2)
      .toList();

    console.log('   ✓ Results:', JSON.stringify(joinWithOrderResult, null, 2));
    console.log('');

    // Example 5: JOIN with complex conditions
    console.log('5. JOIN with complex conditions - Active users with high-view posts:');
    const complexJoinResult = await db.users
      .innerJoin(
        db.posts,
        (user, post) => eq(user.id, post.userId),
        (user, post) => ({
          userId: user.id,
          username: user.username,
          isActive: user.isActive,
          postTitle: post.title,
          postViews: post.views,
        })
      )
      .where((joined) => and(
        eq(joined.isActive, true),
        gt(joined.postViews, 40)
      ))
      .toList();

    console.log('   ✓ Results:', JSON.stringify(complexJoinResult, null, 2));
    console.log('');

    // Example 6: Accessing navigation properties in join selector
    console.log('6. JOIN with navigation properties - Access post.user.name:');
    const navJoinResult = await db.users
      .leftJoin(
        db.posts,
        (user, post) => eq(user.id, post.userId),
        (user, post) => ({
          id: user.id,
          username: user.username,
          // Can access nested navigation properties
          postUsername: post.user?.username, // This should work if navigation is properly set up
          postTitle: post.title,
        })
      )
      .toList();

    console.log('   ✓ Results:', JSON.stringify(navJoinResult, null, 2));
    console.log('');

    console.log('✅ All join examples completed!');

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
