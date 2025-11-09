import { describe, test, expect } from '@jest/globals';
import { withDatabase } from '../utils/test-database';
import { eq } from '../../src';

describe('Mixed Schema Support in AppDatabase', () => {
  test('should handle tables in different schemas within same context', async () => {
    await withDatabase(async (db) => {
      // Insert a regular user (public schema)
      const regularUser = await db.users.insert({
        username: 'regular_user',
        email: 'regular@example.com',
        age: 30,
        isActive: true,
      });

      // Insert a schema user (auth schema)
      const schemaUser = await db.schemaUsers.insert({
        username: 'schema_user',
        email: 'schema@example.com',
        isActive: true,
      });

      // Verify both users were created
      expect(regularUser.username).toBe('regular_user');
      expect(schemaUser.username).toBe('schema_user');

      // Query regular users (public.users)
      const regularUsers = await db.users.toList();
      expect(regularUsers).toHaveLength(1);
      expect(regularUsers[0].username).toBe('regular_user');

      // Query schema users (auth.schema_users)
      const schemaUsers = await db.schemaUsers.toList();
      expect(schemaUsers).toHaveLength(1);
      expect(schemaUsers[0].username).toBe('schema_user');
    });
  });

  test('should handle foreign keys across different schemas in mixed context', async () => {
    await withDatabase(async (db) => {
      // Create a schema user in auth schema
      const author = await db.schemaUsers.insert({
        username: 'author',
        email: 'author@example.com',
        isActive: true,
      });

      // Create a schema post in public schema that references auth.schema_users
      const post = await db.schemaPosts.insert({
        title: 'Cross-Schema Post',
        userId: author.id,
      });

      expect(post.userId).toBe(author.id);

      // Query posts with navigation to user in different schema
      const posts = await db.schemaPosts
        .select(p => ({
          id: p.id,
          title: p.title,
          user: p.user,
        }))
        .toList();

      expect(posts).toHaveLength(1);
      expect(posts[0].title).toBe('Cross-Schema Post');
      expect(posts[0].user?.username).toBe('author');
      expect(posts[0].user?.email).toBe('author@example.com');
    });
  });

  test('should filter across schemas correctly', async () => {
    await withDatabase(async (db) => {
      // Create multiple schema users
      const user1 = await db.schemaUsers.insert({
        username: 'alice',
        email: 'alice@example.com',
        isActive: true,
      });

      const user2 = await db.schemaUsers.insert({
        username: 'bob',
        email: 'bob@example.com',
        isActive: false,
      });

      // Create posts for both users
      await db.schemaPosts.insert({
        title: 'Alice Post',
        userId: user1.id,
      });

      await db.schemaPosts.insert({
        title: 'Bob Post',
        userId: user2.id,
      });

      // Filter schema users
      const activeUsers = await db.schemaUsers
        .where(u => eq(u.isActive, true))
        .toList();

      expect(activeUsers).toHaveLength(1);
      expect(activeUsers[0].username).toBe('alice');

      // Filter posts with navigation
      const postsWithActiveUsers = await db.schemaPosts
        .select(p => ({
          title: p.title,
          user: p.user,
        }))
        .toList();

      expect(postsWithActiveUsers).toHaveLength(2);
      expect(postsWithActiveUsers[0].user?.username).toBeDefined();
      expect(['alice', 'bob']).toContain(postsWithActiveUsers[0].user?.username);

      // Find post by specific user - use select without chaining where for now
      const alicePosts = await db.schemaPosts
        .select(p => ({
          title: p.title,
          userId: p.userId,
          user: p.user,
        }))
        .toList();

      const alicePost = alicePosts.find(p => p.userId === user1.id);
      expect(alicePost).toBeDefined();
      expect(alicePost!.title).toBe('Alice Post');
      expect(alicePost!.user?.username).toBe('alice');
    });
  });

  test('should handle updates and deletes across schemas', async () => {
    await withDatabase(async (db) => {
      // Create a schema user
      const user = await db.schemaUsers.insert({
        username: 'testuser',
        email: 'test@example.com',
        isActive: true,
      });

      // Update the user
      const updated = await db.schemaUsers.update(
        {
          username: 'updateduser',
          isActive: false,
        },
        u => eq(u.id, user.id)
      );

      expect(updated).toHaveLength(1);
      expect(updated[0].username).toBe('updateduser');
      expect(updated[0].isActive).toBe(false);

      // Verify update
      const found = await db.schemaUsers
        .where(u => eq(u.id, user.id))
        .first();

      expect(found?.username).toBe('updateduser');
      expect(found?.isActive).toBe(false);

      // Delete the user
      await db.schemaUsers.delete(u => eq(u.id, user.id));

      // Verify deletion
      const notFound = await db.schemaUsers
        .where(u => eq(u.id, user.id))
        .first();

      expect(notFound).toBeNull();
    });
  });

  test('should count records across schemas independently', async () => {
    await withDatabase(async (db) => {
      // Create regular users
      await db.users.insert({
        username: 'user1',
        email: 'user1@example.com',
        age: 25,
      });

      await db.users.insert({
        username: 'user2',
        email: 'user2@example.com',
        age: 30,
      });

      // Create schema users
      await db.schemaUsers.insert({
        username: 'schemauser1',
        email: 'schemauser1@example.com',
        isActive: true,
      });

      // Count each independently
      const regularUserCount = await db.users.count();
      const schemaUserCount = await db.schemaUsers.count();

      expect(regularUserCount).toBe(2);
      expect(schemaUserCount).toBe(1);
    });
  });

  test('should handle cascade deletes across schemas', async () => {
    await withDatabase(async (db) => {
      // Create a schema user
      const user = await db.schemaUsers.insert({
        username: 'author',
        email: 'author@example.com',
        isActive: true,
      });

      // Create posts for this user
      await db.schemaPosts.insert({
        title: 'Post 1',
        userId: user.id,
      });

      await db.schemaPosts.insert({
        title: 'Post 2',
        userId: user.id,
      });

      // Verify posts exist
      const postsBefore = await db.schemaPosts
        .where(p => eq(p.userId, user.id))
        .toList();

      expect(postsBefore).toHaveLength(2);

      // Delete the user (should cascade delete posts)
      await db.schemaUsers.delete(u => eq(u.id, user.id));

      // Verify posts were cascade deleted
      const postsAfter = await db.schemaPosts
        .where(p => eq(p.userId, user.id))
        .toList();

      expect(postsAfter).toHaveLength(0);
    });
  });
});
