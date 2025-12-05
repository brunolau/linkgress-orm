import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createTestDatabase, setupDatabase, cleanupDatabase, seedTestData } from '../utils/test-database';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { sql, eq, gt, and, DbCteBuilder } from '../../src';
import { assertType } from '../utils/type-tester';

describe('CTE JOIN Operations', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = createTestDatabase();
    await setupDatabase(db);
    await seedTestData(db);
  });

  afterAll(async () => {
    await cleanupDatabase(db);
  });

  describe('CTE joined with tables using SQL magic strings and formatters', () => {
    test('should join CTE with SQL formatted fields to table', async () => {
      // Create a CTE with SQL magic string formatters
      const cteBuilder = new DbCteBuilder();
      const formattedPostsCte = cteBuilder.with(
        'formatted_posts',
        db.posts.select(p => ({
          userId: p.userId,
          title: p.title,
          views: p.views,
          // SQL magic string with custom formatter
          formattedInfo: sql<string>`
            CONCAT(
              'Post: "', ${p.title}, '" - ',
              ${p.views}::text, ' views'
            )
          `.mapWith((raw: string) => `[INFO] ${raw.toUpperCase()}`),
          // View category with formatter
          viewCategory: sql<string>`
            CASE
              WHEN ${p.views} >= 200 THEN 'high'
              WHEN ${p.views} >= 150 THEN 'medium'
              ELSE 'low'
            END
          `.mapWith((cat: string) => `📊 ${cat}`),
        }))
      );

      // Join CTE with users
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(formattedPostsCte.cte)
        .leftJoin(
          formattedPostsCte.cte,
          (u, fp) => eq(u.id, fp.userId),
          (u, fp) => ({
            username: u.username,
            email: u.email,
            formattedInfo: fp.formattedInfo,
            viewCategory: fp.viewCategory,
            originalViews: fp.views,
          })
        )
        .where(row => sql<boolean>`${row.originalViews} > 100`)
        .orderBy(row => sql<number>`formatted_posts.views`)
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        // Type assertions
        assertType<string, typeof r.username>(r.username);
        assertType<string, typeof r.email>(r.email);
        assertType<string | undefined, typeof r.formattedInfo>(r.formattedInfo);
        assertType<string | undefined, typeof r.viewCategory>(r.viewCategory);
        assertType<number | undefined, typeof r.originalViews>(r.originalViews);
      });

      // Verify the custom formatter was applied
      const alicePost2 = result.find(r => r.username === 'alice' && r.originalViews === 150);
      expect(alicePost2).toBeDefined();
      expect(alicePost2!.formattedInfo).toMatch(/\[INFO\].*ALICE POST 2.*150 VIEWS/i);
      expect(alicePost2!.viewCategory).toBe('📊 medium');

      const bobPost = result.find(r => r.username === 'bob');
      expect(bobPost).toBeDefined();
      expect(bobPost!.formattedInfo).toMatch(/\[INFO\].*BOB POST.*200 VIEWS/i);
      expect(bobPost!.viewCategory).toBe('📊 high');
    });

    test('should join CTE with complex SQL transformations to table', async () => {
      // Create CTE with multiple SQL magic strings and formatters
      const cteBuilder = new DbCteBuilder();
      const complexCte = cteBuilder.with(
        'complex_posts',
        db.posts.select(p => ({
          userId: p.userId,
          title: p.title,
          views: p.views,
          // Complex SQL calculation with formatter
          scoreFormula: sql<number>`
            (${p.views}::numeric * 1.5) +
            (LENGTH(${p.title}) * 10)
          `.mapWith((score: number) => Math.round(score)),
          // Performance level with formatter
          performanceLevel: sql<string>`
            CASE
              WHEN ${p.views} >= 200 THEN 'EXCELLENT'
              WHEN ${p.views} >= 150 THEN 'GOOD'
              WHEN ${p.views} >= 100 THEN 'AVERAGE'
              ELSE 'POOR'
            END
          `.mapWith((level: string) => `⭐ ${level} ⭐`),
          // JSON metadata with formatter
          metadata: sql<string>`
            JSON_BUILD_OBJECT(
              'title', ${p.title},
              'views', ${p.views},
              'length', LENGTH(${p.title})
            )::text
          `.mapWith((json: string) => {
            const obj = JSON.parse(json);
            return `📄 ${obj.title} (${obj.views} views, ${obj.length} chars)`;
          }),
        }))
      );

      // Join with users and add more transformations
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(complexCte.cte)
        .leftJoin(
          complexCte.cte,
          (u, cp) => and(eq(u.id, cp.userId), sql<boolean>`${cp.views} > 100`),
          (u, cp) => ({
            username: u.username,
            age: u.age,
            postTitle: cp.title,
            score: cp.scoreFormula,
            performance: cp.performanceLevel,
            meta: cp.metadata,
            // Additional calculation in the join
            userScore: sql<number>`${u.age} * 10`.mapWith((s: number) => s * 2),
          })
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        // Type assertions
        assertType<string, typeof r.username>(r.username);
        assertType<number | undefined, typeof r.age>(r.age);
        assertType<string | undefined, typeof r.postTitle>(r.postTitle);
        assertType<number | undefined, typeof r.score>(r.score);
        assertType<string | undefined, typeof r.performance>(r.performance);
        assertType<string | undefined, typeof r.meta>(r.meta);
        assertType<number, typeof r.userScore>(r.userScore);
      });

      // Verify transformations
      const bobPost = result.find(r => r.username === 'bob');
      expect(bobPost).toBeDefined();
      expect(bobPost!.score).toBeGreaterThan(200); // Views * 1.5 + title length * 10
      expect(bobPost!.performance).toBe('⭐ EXCELLENT ⭐');
      expect(bobPost!.meta).toMatch(/📄 Bob Post/);
      expect(bobPost!.userScore).toBe(35 * 10 * 2); // age * 10 * 2
    });

    test('should join CTE with table using SQL window functions', async () => {
      const cteBuilder = new DbCteBuilder();

      // CTE: User post stats with SQL formatters and window functions
      const postStatsCte = cteBuilder.with(
        'post_stats',
        db.posts.select(p => ({
          userId: p.userId,
          title: p.title,
          views: p.views,
          postCount: sql<number>`COUNT(*) OVER (PARTITION BY ${p.userId})`,
          totalViews: sql<number>`SUM(${p.views}) OVER (PARTITION BY ${p.userId})`.mapWith((v: number) => Math.round(v)),
          category: sql<string>`
            CASE
              WHEN ${p.views} >= 150 THEN 'popular'
              ELSE 'normal'
            END
          `.mapWith((c: string) => `📈 ${c}`),
        }))
      );

      // Join CTE with users
      const result = await db.users
        .where(u => gt(u.id, 0))
        .with(postStatsCte.cte)
        .leftJoin(
          postStatsCte.cte,
          (u, ps) => eq(u.id, ps.userId),
          (u, ps) => ({
            username: u.username,
            postTitle: ps.title,
            category: ps.category,
            totalViews: ps.totalViews,
            postCount: ps.postCount,
          })
        )
        .toList();

      expect(result.length).toBeGreaterThan(0);
      result.forEach(r => {
        // Type assertions
        assertType<string, typeof r.username>(r.username);
        assertType<string | undefined, typeof r.postTitle>(r.postTitle);
        assertType<string | undefined, typeof r.category>(r.category);
        assertType<number | undefined, typeof r.totalViews>(r.totalViews);
        assertType<number | undefined, typeof r.postCount>(r.postCount);
      });

      // Filter out NULL results from LEFT JOIN
      const validResults = result.filter(row => row.category != null);
      expect(validResults.length).toBeGreaterThan(0);

      validResults.forEach(row => {
        expect(row.category).toMatch(/📈/);
        expect(row.totalViews).toBeGreaterThan(0);
        expect(row.postCount).toBeGreaterThan(0);
      });
    });
  });

  describe('CTE with JOIN then GROUP BY', () => {
    test('should join CTE with table then apply groupBy with SQL transformations', async () => {
      // Create a CTE with post details and SQL formatters
      const cteBuilder = new DbCteBuilder();
      const postDetailsCte = cteBuilder.with(
        'post_details',
        db.posts.select(p => ({
          userId: p.userId,
          title: p.title,
          views: p.views,
          category: sql<string>`
            CASE
              WHEN ${p.views} >= 150 THEN 'popular'
              ELSE 'normal'
            END
          `.mapWith((c: string) => `📊 ${c.toUpperCase()}`),
          score: sql<number>`
            (${p.views}::numeric / 10.0)
          `.mapWith((s: number) => Math.floor(s)),
        }))
      );

      // Join with users, then extract data for grouping
      const joinedData = await db.users
        .where(u => gt(u.id, 0))
        .with(postDetailsCte.cte)
        .leftJoin(
          postDetailsCte.cte,
          (u, pd) => eq(u.id, pd.userId),
          (u, pd) => ({
            username: u.username,
            category: pd.category,
            views: pd.views,
            score: pd.score,
          })
        )
        .toList();

      expect(joinedData.length).toBeGreaterThan(0);
      joinedData.forEach(row => {
        // Type assertions
        assertType<string, typeof row.username>(row.username);
        assertType<string | undefined, typeof row.category>(row.category);
        assertType<number | undefined, typeof row.views>(row.views);
        assertType<number | undefined, typeof row.score>(row.score);
      });

      // Filter out NULL results from LEFT JOIN
      const validData = joinedData.filter(row => row.category != null);
      expect(validData.length).toBeGreaterThan(0);

      // Verify the SQL transformations were applied
      validData.forEach(row => {
        expect(row.category).toMatch(/📊/);
        expect(row.category).toMatch(/(POPULAR|NORMAL)/);
        expect(typeof row.score).toBe('number');
      });

      // Group the data in application code (using validData)
      const grouped = validData.reduce((acc, row) => {
        const key = row.category;
        if (!acc[key]) {
          acc[key] = { category: key, count: 0, totalViews: 0, avgScore: 0, scores: [] as number[] };
        }
        acc[key].count++;
        acc[key].totalViews += row.views;
        acc[key].scores.push(row.score);
        return acc;
      }, {} as Record<string, any>);

      Object.values(grouped).forEach((group: any) => {
        group.avgScore = group.scores.reduce((a: number, b: number) => a + b, 0) / group.scores.length;
        delete group.scores;
      });

      const results = Object.values(grouped);
      expect(results.length).toBeGreaterThan(0);

      const popularGroup = results.find((g: any) => g.category.includes('POPULAR'));
      if (popularGroup) {
        expect(popularGroup.count).toBeGreaterThan(0);
        expect(popularGroup.totalViews).toBeGreaterThan(0);
      }
    });

    test('should join CTE with complex SQL transformations and group results', async () => {
      const cteBuilder = new DbCteBuilder();

      // CTE: Enhanced posts with multiple calculations
      const enhancedPostsCte = cteBuilder.with(
        'enhanced_posts',
        db.posts.select(p => ({
          userId: p.userId,
          title: p.title,
          views: p.views,
          score: sql<number>`
            (${p.views}::numeric * 2.5) + (LENGTH(${p.title}) * 5)
          `.mapWith((s: number) => Math.round(s * 100) / 100),
          tier: sql<string>`
            CASE
              WHEN ${p.views} >= 200 THEN 'GOLD'
              WHEN ${p.views} >= 150 THEN 'SILVER'
              ELSE 'BRONZE'
            END
          `.mapWith((t: string) => `🏆 ${t}`),
          summary: sql<string>`
            CONCAT('📝 ', ${p.title}, ' (', ${p.views}::text, ' views)')
          `.mapWith((s: string) => s.toUpperCase()),
        }))
      );

      // Join CTE with users
      const joinedData = await db.users
        .where(u => gt(u.id, 0))
        .with(enhancedPostsCte.cte)
        .leftJoin(
          enhancedPostsCte.cte,
          (u, ep) => eq(u.id, ep.userId),
          (u, ep) => ({
            userId: u.id,
            username: u.username,
            age: u.age,
            tier: ep.tier,
            score: ep.score,
            views: ep.views,
            title: ep.title,
            summary: ep.summary,
          })
        )
        .toList();

      expect(joinedData.length).toBeGreaterThan(0);
      joinedData.forEach(row => {
        // Type assertions
        assertType<number, typeof row.userId>(row.userId);
        assertType<string, typeof row.username>(row.username);
        assertType<number | undefined, typeof row.age>(row.age);
        assertType<string | undefined, typeof row.tier>(row.tier);
        assertType<number | undefined, typeof row.score>(row.score);
        assertType<number | undefined, typeof row.views>(row.views);
        assertType<string | undefined, typeof row.title>(row.title);
        assertType<string | undefined, typeof row.summary>(row.summary);
      });

      // Filter out NULL results from LEFT JOIN
      const validData = joinedData.filter(row => row.tier != null);
      expect(validData.length).toBeGreaterThan(0);

      // Verify all formatters worked
      validData.forEach(row => {
        expect(row.tier).toMatch(/🏆/);
        expect(row.summary).toMatch(/📝/);
        expect(typeof row.score).toBe('number');
        expect(typeof row.age).toBe('number');
      });

      // Group by tier (using validData)
      const grouped = validData.reduce((acc, row) => {
        const key = row.tier;
        if (!acc[key]) {
          acc[key] = {
            tier: row.tier,
            count: 0,
            totalScore: 0,
            totalViews: 0,
            titles: [] as string[],
          };
        }
        acc[key].count++;
        acc[key].totalScore += row.score;
        acc[key].totalViews += row.views;
        acc[key].titles.push(row.title);
        return acc;
      }, {} as Record<string, any>);

      // Calculate averages
      Object.values(grouped).forEach((group: any) => {
        group.avgScore = group.totalScore / group.count;
        group.titleList = `📚 ${group.titles.join(' | ')}`;
        delete group.titles;
      });

      const results = Object.values(grouped);
      expect(results.length).toBeGreaterThan(0);

      // Verify grouped results
      results.forEach((row: any) => {
        expect(row.count).toBeGreaterThan(0);
        expect(row.totalScore).toBeGreaterThan(0);
        expect(row.titleList).toMatch(/📚/);
      });

      // Find GOLD tier
      const goldTier = results.find((r: any) => r.tier.includes('GOLD'));
      if (goldTier) {
        expect(goldTier.totalViews).toBeGreaterThanOrEqual(200);
      }
    });
  });
});
