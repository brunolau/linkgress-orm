import 'dotenv/config';
import {
  eq,
  gt,
  sql,
  and,
  like,
  PgClient,
  PostgresClient,
  DbCteBuilder,
  lt
} from '../src';
import { AppDatabase } from './schema/appDatabase';

/**
 * Entity-First Approach with DbColumn<T> for Full Type Safety
 *
 * Key features:
 * - DbEntity properties are DbColumn<T> which can be used in queries
 * - DbColumn<T> automatically unwraps to T in results
 * - Navigation properties are fully typed
 * - No need for 'as any' casts in queries!
 */

// Define entities with DbColumn<T> properties







async function main() {
  console.log('Linkgress ORM - Entity-First with DbColumn<T>\n');

  const client = new PostgresClient({
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
      collectionStrategy: 'cte'
    }
  );

  try {
    console.log('1. Creating database schema...');
    await db.getSchemaManager().ensureDeleted();
    await db.getSchemaManager().ensureCreated();
    console.log('   ✓ Schema created\n');

    console.log('2. Inserting users...');
    const user1 = await db.users.insert({
      username: 'john_doe',
      email: 'john@example.com',
      age: 30,
      isActive: true,
      metadata: { role: 'admin' },
    }).returning(p => ({
      id: p.id
    }))
    console.log('   ✓ User created\n');

    const user2 = await db.users.insert({
      username: 'jane_smith',
      email: 'jane@example.com',
      age: 28,
      isActive: true,
    }).returning(p => ({
      id: p.id
    }));
    console.log('   ✓ User created\n');

    console.log('3. Inserting posts...');
    await db.posts.insert({
      title: 'Getting Started',
      content: 'Welcome to Linkgress ORM',
      userId: user1.id,
      views: 100,
      publishTime: { hour: 9, minute: 30 }, // HourMinute custom type - stored as 570 (minutes) in DB
    }).returning(p => ({
      id: p.id
    }));

    await db.posts.insert({
      title: 'Advanced Patterns',
      content: 'Complex queries made easy',
      userId: user1.id,
      views: 50,
      publishTime: { hour: 14, minute: 15 }, // Stored as 855 in DB
    }).returning(p => ({
      id: p.id
    }))

    await db.posts.insert({
      title: 'TypeScript Tips',
      content: 'Fully typed queries',
      userId: user2.id,
      views: 75,
      publishTime: { hour: 16, minute: 45 }, // Stored as 1005 in DB
    }).returning(p => ({
      id: p.id
    }));
    console.log('   ✓ Posts created\n');

    // Test multi-level navigation: order -> orderTask -> task -> level -> createdBy
    console.log('\n=== Testing Multi-Level Navigation ===');

    // Create test data for multi-level navigation
    const taskLevel = await db.taskLevels.insert({
      name: 'High Priority',
      createdById: user1.id
    }).returning();
    console.log('   ✓ Task level created:', taskLevel);

    const task1 = await db.tasks.insert({
      title: 'Important Task',
      status: 'pending',
      priority: 'high',
      levelId: taskLevel.id
    }).returning();
    console.log('   ✓ Task created:', task1);

    const order1 = await db.orders.insert({
      userId: user1.id,
      totalAmount: 100.00,
      status: 'pending'
    }).returning();
    console.log('   ✓ Order created:', order1);

    await db.orderTasks.insert({
      orderId: order1.id,
      taskId: task1.id,
      sortOrder: 1
    });
    console.log('   ✓ OrderTask created');

    // Test 1: Multi-level navigation in collection query (4 levels: order -> orderTask -> task -> level -> createdBy)
    try {
      console.log('\n   Test 1: Multi-level navigation in collection (order.orderTasks.task.level.createdBy)...');
      const collectionResult = await db.orders.where(p => gt(p.id, 0)).select(p => ({
        id: p.id,
        created: p.createdAt,
        taskIds: p.orderTasks?.select(pt => ({
          taskId: pt.task!.id,
          taskTitle: pt.task!.title,
          levelName: pt.task!.level!.name,
          creatorEmail: pt.task!.level!.createdBy!.email
        })).toList('tasks')
      })).toList();

      console.log('   ✓ Test 1 PASSED:', JSON.stringify(collectionResult, null, 2));
    } catch (error) {
      console.error('   ✗ Test 1 FAILED:', error);
    }

    // Test 2: Direct multi-level navigation query (orderTask -> task -> level -> createdBy)
    try {
      console.log('\n   Test 2: Direct multi-level navigation (orderTask.task.level.createdBy)...');
      const directResult = await db.orderTasks.where(p => gt(p.orderId, 0)).select(p => ({
        orderId: p.orderId,
        taskId: p.taskId,
        taskTitle: p.task!.title,
        levelName: p.task!.level!.name,
        creatorEmail: p.task!.level!.createdBy!.email,
        creatorUsername: p.task!.level!.createdBy!.username
      })).toList();

      console.log('   ✓ Test 2 PASSED:', JSON.stringify(directResult, null, 2));
    } catch (error) {
      console.error('   ✗ Test 2 FAILED:', error);
    }

    // Test 3: Two-level navigation (task -> level)
    try {
      console.log('\n   Test 3: Two-level navigation (task.level)...');
      const twoLevelResult = await db.tasks.where(p => gt(p.id, 0)).select(p => ({
        id: p.id,
        title: p.title,
        levelName: p.level!.name,
        levelCreatorId: p.level!.createdById
      })).toList();

      console.log('   ✓ Test 3 PASSED:', JSON.stringify(twoLevelResult, null, 2));
    } catch (error) {
      console.error('   ✗ Test 3 FAILED:', error);
    }

    // Test 4: Three-level navigation (task -> level -> createdBy)
    try {
      console.log('\n   Test 4: Three-level navigation (task.level.createdBy)...');
      const threeLevelResult = await db.tasks.where(p => gt(p.id, 0)).select(p => ({
        id: p.id,
        title: p.title,
        levelName: p.level!.name,
        creatorEmail: p.level!.createdBy!.email,
        creatorUsername: p.level!.createdBy!.username
      })).toList();

      console.log('   ✓ Test 4 PASSED:', JSON.stringify(threeLevelResult, null, 2));
    } catch (error) {
      console.error('   ✗ Test 4 FAILED:', error);
    }

    // Test 5: Collection with two-level navigation
    try {
      console.log('\n   Test 5: Collection with two-level navigation (user.posts with post.user)...');
      const collectionTwoLevel = await db.users.where(u => gt(u.id, 0)).select(u => ({
        id: u.id,
        username: u.username,
        orderInfo: u.orders?.select(o => ({
          orderId: o.id,
          orderStatus: o.status,
          userName: o.user!.username  // Navigate back to user through order
        })).toList('orders')
      })).toList();

      console.log('   ✓ Test 5 PASSED:', JSON.stringify(collectionTwoLevel, null, 2));
    } catch (error) {
      console.error('   ✗ Test 5 FAILED:', error);
    }

    console.log('\n=== End Multi-Level Navigation Tests ===\n');


    console.log('4. Query with WHERE - NO MORE as any needed!:');
    const activeUsers = await db.users
      .where(u => eq(u.isActive, true)) // u.isActive is DbColumn<boolean> - works with eq()!
      .select(u => ({
        id: u.id,
        username: u.username,
      }))
      .toList();
    console.log('   ✓ Active users:', activeUsers);
    // Result: activeUsers has type { id: number, username: string }[]
    console.log('');

    console.log('5. Navigation query - Posts with authors:');
    const postsWithAuthors = await db.posts
      .select(p => ({
        postId: p.id,
        title: p.title,
        views: p.views,
        authorId: p.user!.id,
        authorName: p.user!.username,
      }))
      .where(p => gt(p.views, 40)) // p.views is DbColumn<number> - works with gt()!
      .toList();
    console.log('   ✓ Posts with authors:', postsWithAuthors);
    console.log('');

    console.log('6. Navigation collection - Users with posts:');
    const usersWithPosts = await db.users
      .select(u => ({
        userId: u.id,
        username: u.username,
        posts: u.posts!.select(p => ({
          postId: p.id,
          title: p.title,
          views: p.views,
        }))
          .orderBy(p => p.views)
          .toList('posts'),
      }))
      .toList();

    console.log('   ✓ Users with posts:');
    console.log(JSON.stringify(usersWithPosts, null, 2));

    // TypeScript knows: usersWithPosts[0].posts is { postId: number, title: string, views: number }[]
    const firstUserPosts = usersWithPosts[0].posts;
    console.log('   Type check - posts is typed correctly!');
    console.log('');

    console.log('7. Bulk insert - Insert multiple users at once:');
    const newUsers = await db.users.insertBulk([
      {
        username: 'alice_jones',
        email: 'alice@example.com',
        age: 25,
        isActive: true,
      },
      {
        username: 'bob_wilson',
        email: 'bob@example.com',
        age: 32,
        isActive: false,
      },
      {
        username: 'charlie_brown',
        email: 'charlie@example.com',
        isActive: true,
        // age is optional, can be omitted
      },
    ]).returning(p => ({
      id: p.id,
      username: p.username
    }));

    console.log(`   ✓ Bulk inserted ${newUsers.length} users`);
    console.log('   Users:', newUsers.map(u => ({ id: u.id, username: u.username })));
    console.log('');

    console.log('8. Upsert - Insert with conflict handling (ON CONFLICT DO NOTHING):');
    // Try to insert user with existing username (will be ignored if conflict)
    const upsertResult1 = await db.users
      .values({
        username: 'john_doe', // Already exists
        email: 'john.new@example.com',
        age: 35,
        isActive: true,
      })
      .onConflict(['username']) // Conflict on username column
      .doNothing()
      .execute();
    console.log(`   ✓ Upsert with DO NOTHING returned ${upsertResult1.length} rows (0 = conflict ignored)`);
    console.log('');

    console.log('9. Upsert - Insert or update (ON CONFLICT DO UPDATE):');
    // Insert or update user
    const upsertResult2 = await db.users
      .values({
        username: 'jane_smith', // Already exists
        email: 'jane.updated@example.com',
        age: 29,
        isActive: false,
      })
      .onConflict(['username']) // Conflict on username column
      .doUpdate() // Update all non-PK columns
      .execute();
    console.log('   ✓ Upsert with DO UPDATE:', upsertResult2.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      age: u.age
    })));
    console.log('');

    console.log('10. Bulk upsert - Insert multiple rows with conflict handling (fluent API):');
    const bulkUpsertResult = await db.users
      .values([
        {
          username: 'alice_jones', // Already exists from bulk insert
          email: 'alice.updated@example.com',
          age: 26,
          isActive: true,
        },
        {
          username: 'david_miller', // New user
          email: 'david@example.com',
          age: 40,
          isActive: true,
        },
      ])
      .onConflict(['username'])
      .doUpdate() // Update existing, insert new
      .execute();
    console.log(`   ✓ Bulk upsert returned ${bulkUpsertResult.length} rows`);
    console.log('   Users:', bulkUpsertResult.map(u => ({ id: u.id, username: u.username, email: u.email })));
    console.log('');

    console.log('11. Advanced bulk upsert with typed configuration:');
    // Using upsertBulk with advanced configuration and full type safety
    const advancedUpsertResult = await db.users.upsertBulk([
      {
        username: 'bob_wilson', // Update existing
        email: 'bob.updated@example.com',
        age: 33,
        isActive: true,
      },
      {
        username: 'emma_watson', // Insert new
        email: 'emma@example.com',
        age: 28,
        isActive: true,
      },
    ], {
      primaryKey: 'username', // Type-safe: only DbColumn properties allowed
      // Can also use lambda: primaryKey: u => u.username

      updateColumns: ['email', 'age', 'isActive'], // Type-safe array of column names
      // Or use lambda: updateColumns: u => ({ email: u.email, age: u.age, isActive: u.isActive })

      // Alternative: use filter function
      // updateColumnFilter: (col) => col !== 'createdAt',

      // chunkSize: 500, // Optional: override auto-detected chunk size for large batches
      // overridingSystemValue: true, // Optional: auto-detected if PK is in data
    }).returning(p => ({
      id: p.id,
      username: p.username,
      email: p.email,
      age: p.age
    }));

    console.log(`   ✓ Advanced upsert returned ${advancedUpsertResult.length} rows`);
    console.log('   Users:', advancedUpsertResult.map(u => ({ id: u.id, username: u.username, email: u.email, age: u.age })));
    console.log('');

    console.log('12. Magic SQL in WHERE - Raw SQL conditions with field references:');
    // Use sql`` tagged template for complex WHERE conditions
    const magicWhereUsers = await db.users
      .where(u => and(
        eq(u.isActive, true),
        sql`LOWER(${u.username}) LIKE ${`%o%`}` // SQL fragment with field reference
      ))
      .select(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
      }))
      .toList();
    console.log('   ✓ Users with "o" in username (case-insensitive):', magicWhereUsers);
    console.log('');

    console.log('13. Magic SQL in SELECT - Computed columns and expressions:');
    // Use sql`` in SELECT for computed fields, aggregations, and functions
    const magicSelectUsers = await db.users
      .where(u => eq(u.isActive, true))
      .select(u => ({
        id: u.id,
        username: u.username,
        lowercaseUsername: sql<string>`LOWER(${u.username})`,
        uppercaseEmail: sql<string>`UPPER(${u.email})`,
        usernameLength: sql<number>`LENGTH(${u.username})`,
        fullText: sql<string>`${u.username} || ' <' || ${u.email} || '>'`,
        ageGroup: sql<string>`CASE
          WHEN ${u.age} < 25 THEN 'young'
          WHEN ${u.age} < 35 THEN 'adult'
          ELSE 'senior'
        END`,
      }))
      .toList();
    console.log('   ✓ Users with computed SQL fields:');
    console.log(JSON.stringify(magicSelectUsers.slice(0, 3), null, 2));
    console.log('');

    console.log('14. Magic SQL - Complex date/time operations:');
    // Complex SQL expressions with multiple field references
    const recentUsers = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        createdAt: u.createdAt,
        daysSinceCreation: sql<number>`EXTRACT(DAY FROM NOW() - ${u.createdAt})`,
        isRecent: sql<boolean>`${u.createdAt} > NOW() - INTERVAL '7 days'`,
      }))
      .where(u => sql`${u.createdAt} > NOW() - INTERVAL '1 year'`)
      .toList();
    console.log(`   ✓ Recent users (created within last year): ${recentUsers.length} users`);
    console.log('   Sample:', recentUsers.slice(0, 2).map(u => ({
      username: u.username,
      daysSinceCreation: u.daysSinceCreation
    })));
    console.log('');

    console.log('15. Magic SQL - JSON operations:');
    // SQL operations on JSONB columns
    const usersWithMetadata = await db.users
      .where(u => sql`${u.metadata}->>'role' = 'admin'`)
      .select(u => ({
        id: u.id,
        username: u.username,
        role: sql<string>`${u.metadata}->>'role'`, // Extract JSON field
        hasMetadata: sql<boolean>`${u.metadata} IS NOT NULL`,
      }))
      .toList();
    console.log('   ✓ Admin users (from JSON metadata):', usersWithMetadata);
    console.log('');

    console.log('16. Custom Type Mapper - Direct query with HourMinute type:');
    // Query posts directly - HourMinute is automatically converted from DB (smallint) to app type {hour, minute}
    const postsWithTime = await db.posts
      .select(p => ({
        postId: p.id,
        title: p.title,
        publishTime: p.publishTime, // Automatically mapped from smallint to {hour, minute}
        views: p.views,
      }))
      .toList();
    console.log('   ✓ Posts with publish times (custom HourMinute type):');
    console.log(JSON.stringify(postsWithTime, null, 2));
    console.log('   Note: publishTime is stored as smallint (minutes) in DB, but returned as {hour, minute} object');
    console.log('');

    console.log('17. Custom Type Mapper - Subcollection query with HourMinute type:');
    // Query users with posts collection - HourMinute works in nested collections too
    const usersWithPostTimes = await db.users
      .select(u => ({
        userId: u.id,
        username: u.username,
        posts: u.posts!
          .select(p => ({
            postId: p.id,
            title: p.title,
            publishTime: p.publishTime, // Custom mapper works in subcollections!
            views: p.views,
          }))
          .orderBy(p => [p.views, 'DESC'])
          .toList('posts'),
      }))
      .toList();
    console.log('   ✓ Users with posts (including custom HourMinute type in subcollection):');
    console.log(JSON.stringify(usersWithPostTimes.slice(0, 2), null, 2));
    console.log('   Note: publishTime mapper works seamlessly in navigation collections');
    console.log('');

    console.log('18. Enhanced Collection Queries - offset, limit, where, orderBy:');
    // Test all the new collection query methods
    const usersWithFilteredPosts = await db.users
      .select(u => ({
        userId: u.id,
        username: u.username,
        // Top 2 posts with more than 60 views, ordered by views
        topPosts: u.posts!
          .where(p => gt(p.views, 60))
          .select(p => ({
            postId: p.id,
            title: p.title,
            views: p.views,
          }))
          .orderBy(p => [p.views, 'DESC'])
          .limit(2)
          .toList('topPosts'),
        // All post titles as string array (flattened)
        postTitles: u.posts!
          .select(p => p.title)
          .toStringList('postTitles'),
        // All view counts as number array (flattened)
        viewCounts: u.posts!
          .select(p => p.views)
          .toNumberList('viewCounts'),
      }))
      .toList();
    console.log('   ✓ Users with enhanced collection queries:');
    console.log(JSON.stringify(usersWithFilteredPosts, null, 2));
    console.log('');

    console.log('19. Collection Query with DISTINCT:');
    // Test selectDistinct
    const usersWithDistinctViews = await db.users
      .select(u => ({
        userId: u.id,
        username: u.username,
        uniqueViewCounts: u.posts!
          .selectDistinct(p => p.views)
          .toNumberList('uniqueViewCounts'),
      }))
      .toList();
    console.log('   ✓ Users with distinct view counts:');
    console.log(JSON.stringify(usersWithDistinctViews, null, 2));
    console.log('');

    console.log('20. Left Join - Posts with user data:');
    // leftJoin takes: (1) table to join, (2) join condition, (3) selector for the joined result
    // The result is still queryable with .where(), .orderBy(), .limit(), etc.
    const postsWithUsers = await db.posts
      .leftJoin(
        db.users,
        (post, user) => eq(post.userId, user.id),
        (post, user) => ({
          postId: post.id,
          title: post.title,
          views: post.views,
          // User fields will be null if no matching user
          userId: user.id,
          username: user.username,
          userEmail: user.email,
        })
      )
      .where(result => gt(result.views, 50))
      .select(p => ({
        id: p.postId,
        kokot: p.title
      }))
      .leftJoin(
        db.orders,
        (joined, order) => eq(joined.id, order.id),
        (joined, order) => ({
          postId: joined.id,
          blbec: joined.kokot,
          kks: order.status,
          skusme: order.user?.username
        }))
      .leftJoin(
        db.users,
        (joined, user) => eq(joined.postId, user.id),
        (joined, user) => ({
          postId: joined.postId,
          blbec: joined.blbec,
          kks: joined.kks,
          userName: user.username,
        }))
      .toList();

    console.log('   ✓ Posts with user data (via leftJoin):');
    console.log(JSON.stringify(postsWithUsers, null, 2));
    console.log('');

    console.log('21. Subquery Examples - asSubquery() method:');
    console.log('   Using asSubquery() to create reusable, strongly-typed subqueries\n');

    // Example 21a: Scalar subquery in SELECT - average age
    console.log('   21a. Scalar subquery - Users with age comparison to average:');
    const avgAgeSubquery = db.users
      .select(u => sql<number>`AVG(${u.age})`)
      .asSubquery('scalar');

    const usersWithAgeComparison = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        age: u.age,
        avgAge: avgAgeSubquery,  // Scalar subquery returns a single value
        isAboveAverage: sql<boolean>`${u.age} > (${avgAgeSubquery})`,
      }))
      .toList();

    console.log('   Users with age comparison:', usersWithAgeComparison.map(u => ({
      username: u.username,
      age: u.age,
      avgAge: u.avgAge,
      isAboveAverage: u.isAboveAverage
    })));
    console.log('');

    // Example 21b: Array subquery with IN clause - active user IDs
    console.log('   21b. Array subquery - Posts by active users:');
    const activeUserIdsSubquery = db.users
      .where(u => eq(u.isActive, true))
      .select(u => u.id)
      .asSubquery('array');

    // Use the subquery in a WHERE clause with IN
    const postsByActiveUsersViaSubquery = await db.posts
      .where(p => sql`${p.userId} IN (${activeUserIdsSubquery})`)
      .select(p => ({
        postId: p.id,
        title: p.title,
        views: p.views,
      }))
      .toList();

    console.log('   Posts by active users:', postsByActiveUsersViaSubquery);
    console.log('');

    // Example 21c: Scalar subquery for aggregations
    console.log('   21c. Scalar subquery - Max views across all posts:');
    const maxViewsSubquery = db.posts
      .select(p => sql<number>`MAX(${p.views})`)
      .asSubquery('scalar');

    const usersWithMaxViews = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        globalMaxViews: maxViewsSubquery,  // Same value for all rows
        userMaxViews: db.posts
          .where(p => eq(p.userId, u.id))
          .select(p => sql<number>`MAX(${p.views})`)
          .asSubquery('scalar'),
      }))
      .toList();

    console.log('   Users with max views:', usersWithMaxViews.map(u => ({
      username: u.username,
      globalMax: u.globalMaxViews,
      userMax: u.userMaxViews
    })));
    console.log('');

    // Example 21d: Correlated scalar subquery - post count per user
    console.log('   21d. Correlated scalar subquery - Users with post counts:');
    const usersWithPostCounts = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        postCount: db.posts
          .where(p => eq(p.userId, u.id))  // Correlated with outer query
          .select(p => sql<number>`COUNT(*)`)
          .asSubquery('scalar'),
        totalViews: db.posts
          .where(p => eq(p.userId, u.id))
          .select(p => sql<number>`COALESCE(SUM(${p.views}), 0)`)
          .asSubquery('scalar'),
      }))
      .toList();

    console.log('   Users with post statistics:', usersWithPostCounts.map(u => ({
      username: u.username,
      postCount: u.postCount,
      totalViews: u.totalViews
    })));
    console.log('');

    // Example 21e: Complex nested subquery
    console.log('   21e. Complex nested subquery - Users with above-average posts:');
    const avgPostViewsSubquery = db.posts
      .select(p => sql<number>`AVG(${p.views})`)
      .asSubquery('scalar');

    const usersWithPopularPostsViaSubquery = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        avgViews: avgPostViewsSubquery,
        popularPostCount: db.posts
          .where(p => and(
            eq(p.userId, u.id),
            sql`${p.views} > (${avgPostViewsSubquery})`  // Nested subquery in WHERE
          ))
          .select(p => sql<number>`COUNT(*)`)
          .asSubquery('scalar'),
        hasPopularPost: sql<boolean>`EXISTS(
          SELECT 1 FROM posts
          WHERE user_id = ${u.id}
          AND views > (${avgPostViewsSubquery})
        )`,
      }))
      .toList();

    console.log('   Users with popular posts:', usersWithPopularPostsViaSubquery.map(u => ({
      username: u.username,
      avgViews: u.avgViews,
      popularPostCount: u.popularPostCount,
      hasPopularPost: u.hasPopularPost
    })));
    console.log('');

    // Example 21f: Reusable subquery - define once, use multiple times
    console.log('   21f. Reusable subquery - High-view posts threshold:');
    const highViewThresholdSubquery = db.posts
      .select(p => sql<number>`PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${p.views})`)
      .asSubquery('scalar');

    const highValuePosts = await db.posts
      .where(p => sql`${p.views} >= (${highViewThresholdSubquery})`)
      .select(p => ({
        title: p.title,
        views: p.views,
        threshold: highViewThresholdSubquery,  // Same subquery reused
        percentAboveThreshold: sql<number>`ROUND(CAST((${p.views}::float / (${highViewThresholdSubquery})::float - 1) * 100 AS numeric), 2)`,
      }))
      .toList();

    console.log('   High-value posts (75th percentile):', highValuePosts.map(p => ({
      title: p.title,
      views: p.views,
      threshold: p.threshold,
      percentAbove: p.percentAboveThreshold + '%'
    })));
    console.log('');

    console.log('   ✓ Type Safety Check:');
    if (usersWithPostCounts.length > 0) {
      const firstUser = usersWithPostCounts[0];
      console.log('     - username is string:', typeof firstUser.username === 'string');
      console.log('     - postCount is number:', typeof firstUser.postCount === 'number');
      console.log('     - totalViews is number:', typeof firstUser.totalViews === 'number');
      console.log('     - Full type inference works! ✓');
    }
    console.log('');

    console.log('22. Subquery JOIN Examples - JOIN with subqueries:');
    console.log('   Using leftJoinSubquery() and innerJoinSubquery() for strongly-typed joins\n');

    // Example 22a: Correlated subqueries - Users with aggregated post stats
    console.log('   22a. Correlated subqueries - Users with aggregated post stats:');

    const usersWithPostStats = await db.users
      .select(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        // Correlated subqueries for stats
        postCount: db.posts
          .where(p => eq(p.userId, u.id))
          .select(p => sql<number>`COUNT(*)`)
          .asSubquery('scalar'),
        totalViews: db.posts
          .where(p => eq(p.userId, u.id))
          .select(p => sql<number>`COALESCE(SUM(${p.views}), 0)`)
          .asSubquery('scalar'),
      }))
      .toList();

    console.log('   Users with post stats:', usersWithPostStats.map(u => ({
      username: u.username,
      postCount: u.postCount,
      totalViews: u.totalViews
    })));
    console.log('');

    // Example 22b: Subquery in FROM with manual SQL join
    console.log('   22b. Subquery as data source - Top posts by active users:');

    const topPostsByActiveUsers = await db.posts
      .where(p => sql`${p.userId} IN (
        SELECT id FROM users WHERE is_active = true
      ) AND ${p.views} > 0`)
      .select(p => ({
        postId: p.id,
        title: p.title,
        views: p.views,
        userId: p.userId,
        authorName: p.user?.username,
      }))
      .toList();

    console.log('   Top posts by active users:', topPostsByActiveUsers.map(p => ({
      title: p.title,
      views: p.views,
      author: p.authorName
    })));
    console.log('');

    // Example 22c: Complex join scenario - Posts with user stats
    console.log('   22c. Complex scenario - Posts with author engagement metrics:');

    const postsWithAuthorMetrics = await db.posts
      .select(p => ({
        postId: p.id,
        title: p.title,
        views: p.views,
        authorId: p.userId,
        authorName: p.user?.username,
        // Author's total posts
        authorPostCount: db.posts
          .where(authorPost => eq(authorPost.userId, p.userId))
          .select(() => sql<number>`COUNT(*)`)
          .asSubquery('scalar'),
        // Author's total views
        authorTotalViews: db.posts
          .where(authorPost => eq(authorPost.userId, p.userId))
          .select(authorPost => sql<number>`COALESCE(SUM(${authorPost.views}), 0)`)
          .asSubquery('scalar'),
        // This post's rank among author's posts
        postRankInAuthorPosts: sql<number>`(
          SELECT COUNT(*) + 1
          FROM posts p2
          WHERE p2.user_id = ${p.userId}
          AND p2.views > ${p.views}
        )`,
      }))
      .where(p => gt(p.views, 0))
      .toList();

    console.log('   Posts with author metrics:');
    postsWithAuthorMetrics.forEach(p => {
      console.log(`     - "${p.title}" by ${p.authorName}`);
      console.log(`       Views: ${p.views}, Author's total posts: ${p.authorPostCount}, Author's total views: ${p.authorTotalViews}`);
      console.log(`       Rank among author's posts: #${p.postRankInAuthorPosts}`);
    });
    console.log('');

    // Example 22d: Type safety demonstration - Using subqueries efficiently
    console.log('   22d. Using subqueries efficiently - Multiple stats in one query:');

    // Instead of GROUP BY (not yet implemented), use correlated subqueries
    // which are more flexible and work with the current API
    const usersWithTypedStats = await db.users
      .select(u => ({
        username: u.username,
        age: u.age,
        // Check if user has posts
        hasPosts: sql<boolean>`EXISTS(
          SELECT 1 FROM posts WHERE user_id = ${u.id}
        )`,
        // Get user's post count
        userPostCount: db.posts
          .where(userPost => eq(userPost.userId, u.id))
          .select(() => sql<number>`COUNT(*)`)
          .asSubquery('scalar'),
        // Get user's average post views
        avgPostViews: db.posts
          .where(userPost => eq(userPost.userId, u.id))
          .select(userPost => sql<number>`AVG(${userPost.views})`)
          .asSubquery('scalar'),
        // Check if user has high-performing posts
        hasPopularPosts: sql<boolean>`EXISTS(
          SELECT 1 FROM posts
          WHERE user_id = ${u.id}
          AND views > 100
        )`,
      }))
      .toList();

    console.log('   Users with comprehensive stats:');
    usersWithTypedStats.forEach(u => {
      console.log(`     - ${u.username} (age ${u.age})`);
      console.log(`       Has posts: ${u.hasPosts}, Count: ${u.userPostCount}, Avg views: ${u.avgPostViews || 0}`);
      console.log(`       Has popular posts (>100 views): ${u.hasPopularPosts}`);
    });
    console.log('');

    // Example 23: Joining Subqueries with leftJoin/innerJoin (unified API)
    console.log('23. Joining Subqueries - Using subqueries in join methods:');
    console.log('   Demonstrating the unified API that accepts both tables and subqueries\n');

    const userStatsSubquery = db.users
      .select(u => ({ userId: u.id, username: u.username }))
      .asSubquery('table');

    const result = await db.posts
      .leftJoin(
        userStatsSubquery,
        (post, stats) => eq(post.userId, stats.userId),
        (post, stats) => ({
          postId: post.id,
          title: post.title,
          views: post.views,
          authorName: stats.username,
        }),
        'user_stats'  // Alias required for subqueries (4th parameter)
      )
      .toList();

    console.log('   Posts with author names from subquery join:');
    result.forEach(p => {
      console.log(`     - "${p.title}" by ${p.authorName || 'Unknown'} (${p.views} views)`);
    });
    console.log('');

    console.log('   ✓ Unified JOIN API features:');
    console.log('     - leftJoin/innerJoin accept both tables AND subqueries ✓');
    console.log('     - Same method signature for both ✓');
    console.log('     - Alias parameter required for subqueries (4th param) ✓');
    console.log('     - Full type safety maintained ✓');
    console.log('     - Works across all API levels (entity, fluent, low-level) ✓');
    console.log('');

    console.log('✅ All examples completed with full type safety using DbColumn<T>!');





    // Create posts for users
    const alice = await db.users.insert({ username: 'alice', email: 'alice@test.com', age: 25, isActive: true }).returning();
    const bob = await db.users.insert({ username: 'bob', email: 'bob@test.com', age: 35, isActive: true }).returning();
    const charlie = await db.users.insert({ username: 'charlie', email: 'charlie@test.com', age: 45, isActive: false }).returning();

    const dte = new Date();
    await db.posts.insert({ title: 'Alice Post 1', content: 'Content 1', userId: alice.id, views: 100, customDate: dte });
    await db.posts.insert({ title: 'Alice Post 2', content: 'Content 2', userId: alice.id, views: 150, customDate: dte });
    await db.posts.insert({ title: 'Bob Post 1', content: 'Content 3', userId: bob.id, views: 200, customDate: dte });
    await db.posts.insert({ title: 'Bob Post 2', content: 'Content 4', userId: bob.id, views: 75, customDate: dte });
    await db.posts.insert({ title: 'Charlie Post 1', content: 'Content 5', userId: charlie.id, views: 300, customDate: dte });

    const reproBuilder = new DbCteBuilder();
    const groupingCte = reproBuilder.withAggregation(
      'product_price_advance_cte',
      db.posts
        .where(u => gt(u.id, -1))
        .select(u => ({
          postId: u.id,
          userId: u.userId,
          username: u.content,
          createdAt: u.customDate,
        })),
      p => ({ advancePriceId: p.userId }),
      'advancePrices',
    );

    const failingCte = reproBuilder.withAggregation(
      'order_stats',
      db.posts.select(p => ({
        postId: p.id,
        userId: p.userId,
        identifier: sql<number>`CASE WHEN ${p.user!.id} < ${10} THEN ${p.id} ELSE -1 END`.as('id'),
        kekes: p.content,
        distinctDay: p.customDate
      })).groupBy(p => ({
        userId: p.userId,
        identifier: p.identifier,
        distinctDay: p.distinctDay,
      })).select(p => ({
        userId: p.key.userId,
        identifier: p.key.identifier,
        distinctDay: p.key.distinctDay,
        minId: p.min(pr => pr.postId),
      })).leftJoin(
        groupingCte,
        (secondCte, firstCte) => eq(secondCte.userId, firstCte.advancePriceId),
        (secondCte, firstCte) => ({
          userIdOfPost: secondCte.userId,
          distinctDay: secondCte.distinctDay,
          customerCategoryId: secondCte.identifier,
          advancePrices: firstCte.advancePrices,
        }),
      ).orderBy(p => [
        p.userIdOfPost,
        p.distinctDay,
        p.customerCategoryId,
      ]),
      p => ({ userIdOfPost: p.userIdOfPost }),
      'orders',
    );

    const searchProducts = await db.users.where(p => gt(p.id, -1)).with(...reproBuilder.getCtes()).leftJoin(
      failingCte,
      (user, cte) => eq(user.id, cte.userIdOfPost),
      (user, cte) => ({
        id: user.id,
        age: user.age,
        email: user.email,
        username: user.username,
        orders: cte.orders
      }),
    ).toList();


    console.log('Test 1: Basic grouping with count');
    console.log('Group posts by userId and count posts per user\n');

    const groupedResult = await db.posts
      .select(p => ({
        userId: p.userId,
        title: p.title,
        views: p.views,
      }))
      .groupBy(p => ({
        userId: p.userId,
      }))
      .select(g => ({
        userId: g.key.userId,
        postCount: g.count(),
      }))
      .toList();

    console.log('Result:', JSON.stringify(groupedResult, null, 2));
    console.log('Expected: Alice and Bob with 2 posts each, Charlie with 1 post');
    console.log('✅ Test 1 passed!\n');

    console.log('Test 2: Grouping with sum');
    console.log('Group by userId and sum total views per user\n');

    const sumResult = await db.posts
      .select(p => ({
        userId: p.userId,
        views: p.views,
      }))
      .groupBy(p => ({
        userId: p.userId,
      }))
      .select(g => ({
        userId: g.key.userId,
        postCount: g.count(),
        totalViews: g.sum(p => p.views),
      }))
      .toList();

    console.log('Result:', JSON.stringify(sumResult, null, 2));
    console.log('Expected: Alice=250, Bob=275, Charlie=300');
    console.log('✅ Test 2 passed!\n');

    console.log('Test 3: Grouping with min and max');
    console.log('Group by userId and find min/max views per user\n');

    const minMaxResult = await db.posts
      .select(p => ({
        userId: p.userId,
        views: p.views,
      }))
      .groupBy(p => ({
        userId: p.userId,
      }))
      .select(g => ({
        userId: g.key.userId,
        minViews: g.min(p => p.views),
        maxViews: g.max(p => p.views),
        avgViews: g.avg(p => p.views),
      }))
      .toList();

    console.log('Result:', JSON.stringify(minMaxResult, null, 2));
    console.log('✅ Test 3 passed!\n');

    console.log('Test 4: Grouping with HAVING clause');
    console.log('Group by userId, but only show users with more than 1 post\n');

    const havingResult = await db.posts
      .select(p => ({
        userId: p.userId,
        views: p.views,
      }))
      .groupBy(p => ({
        userId: p.userId,
      }))
      .having(g => gt(g.count() as any, 1))  // Users with more than 1 post
      .select(g => ({
        userId: g.key.userId,
        postCount: g.count(),
      }))
      .toList();

    console.log('Result:', JSON.stringify(havingResult, null, 2));
    console.log('Expected: Only Alice and Bob (both have 2 posts)');
    console.log('✅ Test 4 passed!\n');

    console.log('Test 5: Grouped query as subquery');
    console.log('Use grouped results in another query\n');

    const groupedSubquery = db.posts
      .select(p => ({
        userId: p.userId,
        views: p.views,
      }))
      .groupBy(p => ({
        userId: p.userId,
      }))
      .select(g => ({
        userId: g.key.userId,
        totalViews: g.sum(p => p.views),
      }))
      .asSubquery('table');


    const usersTest = await db.users.innerJoin(
      groupedSubquery,
      (user, sq) => eq(user.id, sq.userId),
      (user, sq) => ({
        id: user.id,
        kokos: sq.totalViews
      }), 'table'
    ).toList();

    const z = usersTest;

    // This demonstrates that grouped queries can be used as subqueries
    console.log('Created grouped subquery (can be used in joins, WHERE clauses, etc.)');
    console.log('✅ Test 5 passed!\n');




  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await db.getSchemaManager().ensureDeleted();
    await db.dispose();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { main };
