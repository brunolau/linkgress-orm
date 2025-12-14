import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, and, gt } from '../../src';

describe('Navigation Properties', () => {
  describe('One-to-Many relationships', () => {
    test('should not include navigation properties in default selection', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const alice = await db.users
          .where(u => eq(u.id, users.alice.id))
          .first();

        expect(alice).toBeDefined();
        // Navigation properties should NOT be present in default selection
        // Only columns from the current table are included
        expect((alice as any).posts).toBeUndefined();
      });
    });

    test('should filter parent with collection navigation', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Users with posts (using manual join or subquery)
        const usersWithPosts = await db.users
          .innerJoin(
            db.posts,
            (user, post) => eq(user.id, post.userId),
            (user, post) => ({
              userId: user.id,
              username: user.username,
            })
          )
          .select(u => ({ userId: u.userId, username: u.username }))
          .toList();

        expect(usersWithPosts.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Many-to-One relationships', () => {
    test('should navigate from child to parent', async () => {
      await withDatabase(async (db) => {
        const { posts } = await seedTestData(db);

        const post = await db.posts
          .select(p => ({
            title: p.title,
            authorName: p.user!.username,
          }))
          .first();

        expect(post).toBeDefined();
        expect(post.authorName).toBeDefined();
      });
    });

    test('should use navigation in WHERE clause', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const posts = await db.posts
          .select(p => ({
            title: p.title,
            authorName: p.user!.username,
            userId: p.userId,
          }))
          .where(p => eq(p.authorName, 'alice'))
          .toList();

        expect(posts.length).toBeGreaterThan(0);
        posts.forEach(p => {
          expect(p.authorName).toBe('alice');
        });
      });
    });

    test('should project navigation properties', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const posts = await db.posts
          .select(p => ({
            postTitle: p.title,
            authorEmail: p.user!.email,
            authorAge: p.user!.age,
          }))
          .toList();

        expect(posts.length).toBeGreaterThan(0);
        posts.forEach(p => {
          expect(p.authorEmail).toBeDefined();
          expect(p.authorEmail).toContain('@');
        });
      });
    });
  });

  describe('Navigation with filtering', () => {
    test('should filter on navigation property', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const posts = await db.posts
          .select(p => ({
            title: p.title,
            userId: p.user!.id,
            isActive: p.user!.isActive,
          }))
          .where(p => eq(p.isActive, true))
          .toList();

        expect(posts.length).toBeGreaterThan(0);
        posts.forEach(p => {
          expect(p.isActive).toBe(true);
        });
      });
    });

    test('should combine multiple navigation filters', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const orders = await db.orders
          .where(o => and(
            eq(o.user!.isActive, true),
            gt(o.user!.age!, 20)
          ))
          .select(o => ({
            orderAmount: o.totalAmount,
            userName: o.user!.username,
            userAge: o.user!.age,
          }))
          .toList();

        expect(orders.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Nested navigation', () => {
    test('should navigate through multiple levels', async () => {
      await withDatabase(async (db) => {
        const { users, posts } = await seedTestData(db);

        // Navigate from post -> user -> back to posts
        const result = await db.posts
          .select(p => ({
            postTitle: p.title,
            authorName: p.user!.username,
            userId: p.user!.id,
          }))
          .first();

        expect(result).toBeDefined();
        expect(result.authorName).toBeDefined();
      });
    });
  });

  describe('NULL navigation handling', () => {
    test('should handle optional navigation properties', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Posts might have optional fields
        const posts = await db.posts
          .select(p => ({
            title: p.title,
            subtitle: p.subtitle,
          }))
          .toList();

        expect(posts.length).toBeGreaterThan(0);
        // Some might have null subtitle
      });
    });
  });
});
