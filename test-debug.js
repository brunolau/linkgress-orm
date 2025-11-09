const { createTestDatabase, seedTestData } = require('./tests/utils/test-database');
const { eq, sql, customType } = require('./src/index');

async function debug() {
  const db = createTestDatabase({ logQueries: true });
  
  try {
    await db.ensureDeleted();
    await db.ensureCreated();
    await seedTestData(db);

    const doublerMapper = customType({
      dataType: 'integer',
      toDriver: (value) => value,
      fromDriver: (value) => {
        console.log('Mapper called with value:', value);
        return value * 2;
      },
    });

    const postsSubquery = db.posts
      .select(p => ({
        userId: p.userId,
        doubledViews: sql`${p.views}`.mapWith(doublerMapper),
      }))
      .asSubquery('table');

    console.log('\n=== Subquery object ===');
    console.log('Type:', typeof postsSubquery);
    console.log('Constructor:', postsSubquery?.constructor?.name);
    console.log('Has buildSql:', typeof postsSubquery?.buildSql);
    
    const result = await db.users
      .innerJoin(
        postsSubquery,
        (user, post) => eq(user.id, post.userId),
        (user, post) => ({
          username: user.username,
          views: post.doubledViews,
        }),
        'post_subquery'
      )
      .limit(1)
      .toList();

    console.log('\n=== Result ===');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.ensureDeleted();
    await db.dispose();
  }
}

debug().catch(console.error);
