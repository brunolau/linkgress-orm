import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src';

describe('Transaction Support', () => {
  describe('Successful transactions', () => {
    test('should commit changes when transaction succeeds and verify reads within transaction', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Get initial count
        const initialCount = await db.users.count();

        // Execute transaction that inserts a user and verifies reads within transaction
        await db.transaction(async (ctx) => {
          // Insert a user
          await ctx.users.insert({
            username: 'transaction_user',
            email: 'transaction@test.com',
            isActive: true,
          });

          // READ WITHIN TRANSACTION: Verify count increased
          const countInTx = await ctx.users.count();
          expect(countInTx).toBe(initialCount + 1);

          // READ WITHIN TRANSACTION: Query the inserted user
          const userInTx = await ctx.users
            .where(u => eq(u.username, 'transaction_user'))
            .firstOrDefault();
          expect(userInTx).not.toBeNull();
          expect(userInTx?.email).toBe('transaction@test.com');
        });

        // Verify the user was committed (outside transaction)
        const finalCount = await db.users.count();
        expect(finalCount).toBe(initialCount + 1);

        // Verify we can query the inserted user (outside transaction)
        const user = await db.users
          .where(u => eq(u.username, 'transaction_user'))
          .firstOrDefault();
        expect(user).not.toBeNull();
        expect(user?.email).toBe('transaction@test.com');
      });
    });

    test('should return value from transaction callback with reads', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.transaction(async (ctx) => {
          const user = await ctx.users.insert({
            username: 'return_value_user',
            email: 'return@test.com',
            isActive: true,
          }).returning();

          // READ WITHIN TRANSACTION: Verify the user exists and can be queried
          const queriedUser = await ctx.users
            .where(u => eq(u.id, user.id))
            .firstOrDefault();
          expect(queriedUser).not.toBeNull();
          expect(queriedUser?.username).toBe('return_value_user');

          return { insertedId: user.id, username: user.username };
        });

        expect(result.insertedId).toBeDefined();
        expect(result.username).toBe('return_value_user');
      });
    });

    test('should support multiple operations with reads verifying each step', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const initialUserCount = await db.users.count();
        const initialPostCount = await db.posts.count();
        const initialOrderCount = await db.orders.count();

        await db.transaction(async (ctx) => {
          // Insert a user
          const user = await ctx.users.insert({
            username: 'multi_op_user',
            email: 'multi@test.com',
            isActive: true,
          }).returning();

          // READ WITHIN TRANSACTION: Verify user count increased
          const userCountAfterInsert = await ctx.users.count();
          expect(userCountAfterInsert).toBe(initialUserCount + 1);

          // READ WITHIN TRANSACTION: Verify user can be queried
          const queriedUser = await ctx.users
            .where(u => eq(u.username, 'multi_op_user'))
            .firstOrDefault();
          expect(queriedUser).not.toBeNull();
          expect(queriedUser?.id).toBe(user.id);

          // Insert a post for that user
          await ctx.posts.insert({
            title: 'Transaction Post',
            content: 'Created in transaction',
            userId: user.id,
            views: 0,
          });

          // READ WITHIN TRANSACTION: Verify post count increased
          const postCountAfterInsert = await ctx.posts.count();
          expect(postCountAfterInsert).toBe(initialPostCount + 1);

          // READ WITHIN TRANSACTION: Verify post can be queried
          const queriedPost = await ctx.posts
            .where(p => eq(p.title, 'Transaction Post'))
            .firstOrDefault();
          expect(queriedPost).not.toBeNull();
          expect(queriedPost?.userId).toBe(user.id);

          // Insert an order for that user
          await ctx.orders.insert({
            userId: user.id,
            totalAmount: 99.99,
            status: 'pending',
          });

          // READ WITHIN TRANSACTION: Verify order count increased
          const orderCountAfterInsert = await ctx.orders.count();
          expect(orderCountAfterInsert).toBe(initialOrderCount + 1);

          // READ WITHIN TRANSACTION: Verify order can be queried
          const queriedOrder = await ctx.orders
            .where(o => eq(o.userId, user.id))
            .firstOrDefault();
          expect(queriedOrder).not.toBeNull();
        });

        // Verify all operations were committed (outside transaction)
        const user = await db.users
          .where(u => eq(u.username, 'multi_op_user'))
          .firstOrDefault();
        expect(user).not.toBeNull();

        const post = await db.posts
          .where(p => eq(p.title, 'Transaction Post'))
          .firstOrDefault();
        expect(post).not.toBeNull();

        const order = await db.orders
          .where(o => eq(o.userId, user!.id))
          .firstOrDefault();
        expect(order).not.toBeNull();
      });
    });
  });

  describe('Failed transactions (rollback)', () => {
    test('should rollback all changes when transaction throws (with reads verifying data existed before rollback)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const initialCount = await db.users.count();

        // Execute transaction that will fail
        await expect(
          db.transaction(async (ctx) => {
            // Insert a user
            await ctx.users.insert({
              username: 'rollback_user',
              email: 'rollback@test.com',
              isActive: true,
            });

            // READ WITHIN TRANSACTION: Verify the insert is visible before we throw
            const countInTx = await ctx.users.count();
            expect(countInTx).toBe(initialCount + 1);

            const userInTx = await ctx.users
              .where(u => eq(u.username, 'rollback_user'))
              .firstOrDefault();
            expect(userInTx).not.toBeNull();
            expect(userInTx?.email).toBe('rollback@test.com');

            // Throw an error to trigger rollback
            throw new Error('Intentional error for rollback test');
          })
        ).rejects.toThrow('Intentional error for rollback test');

        // Verify the user was NOT committed (rolled back)
        const finalCount = await db.users.count();
        expect(finalCount).toBe(initialCount);

        // Verify the user does not exist
        const user = await db.users
          .where(u => eq(u.username, 'rollback_user'))
          .firstOrDefault();
        expect(user).toBeNull();
      });
    });

    test('should rollback multiple operations when transaction fails (with reads verifying data existed)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const initialUserCount = await db.users.count();
        const initialPostCount = await db.posts.count();

        await expect(
          db.transaction(async (ctx) => {
            // Insert a user
            const user = await ctx.users.insert({
              username: 'rollback_multi_user',
              email: 'rollback_multi@test.com',
              isActive: true,
            }).returning();

            // READ WITHIN TRANSACTION: Verify user was inserted
            const userCountInTx = await ctx.users.count();
            expect(userCountInTx).toBe(initialUserCount + 1);

            const queriedUser = await ctx.users
              .where(u => eq(u.username, 'rollback_multi_user'))
              .firstOrDefault();
            expect(queriedUser).not.toBeNull();

            // Insert a post
            await ctx.posts.insert({
              title: 'Rollback Post',
              content: 'This should be rolled back',
              userId: user.id,
              views: 0,
            });

            // READ WITHIN TRANSACTION: Verify post was inserted
            const postCountInTx = await ctx.posts.count();
            expect(postCountInTx).toBe(initialPostCount + 1);

            const queriedPost = await ctx.posts
              .where(p => eq(p.title, 'Rollback Post'))
              .firstOrDefault();
            expect(queriedPost).not.toBeNull();
            expect(queriedPost?.userId).toBe(user.id);

            // Throw error after multiple inserts
            throw new Error('Rollback all operations');
          })
        ).rejects.toThrow('Rollback all operations');

        // Verify both operations were rolled back
        const finalUserCount = await db.users.count();
        const finalPostCount = await db.posts.count();

        expect(finalUserCount).toBe(initialUserCount);
        expect(finalPostCount).toBe(initialPostCount);

        // Verify neither user nor post exist
        const user = await db.users
          .where(u => eq(u.username, 'rollback_multi_user'))
          .firstOrDefault();
        expect(user).toBeNull();

        const post = await db.posts
          .where(p => eq(p.title, 'Rollback Post'))
          .firstOrDefault();
        expect(post).toBeNull();
      });
    });

    test('should rollback on database constraint violation (with read verifying first insert existed)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const initialCount = await db.users.count();

        // Try to insert a user, then insert another with duplicate username (unique constraint)
        await expect(
          db.transaction(async (ctx) => {
            await ctx.users.insert({
              username: 'constraint_user1',
              email: 'constraint1@test.com',
              isActive: true,
            });

            // READ WITHIN TRANSACTION: Verify first user was inserted
            const countAfterFirst = await ctx.users.count();
            expect(countAfterFirst).toBe(initialCount + 1);

            const firstUser = await ctx.users
              .where(u => eq(u.username, 'constraint_user1'))
              .firstOrDefault();
            expect(firstUser).not.toBeNull();
            expect(firstUser?.email).toBe('constraint1@test.com');

            // Try to insert with same username - should violate unique constraint on username
            await ctx.users.insert({
              username: 'constraint_user1', // Duplicate username
              email: 'constraint2@test.com',
              isActive: true,
            });
          })
        ).rejects.toThrow(); // Database constraint error

        // Verify both inserts were rolled back (including the successful first one)
        const finalCount = await db.users.count();
        expect(finalCount).toBe(initialCount);

        const user = await db.users
          .where(u => eq(u.username, 'constraint_user1'))
          .firstOrDefault();
        expect(user).toBeNull();
      });
    });
  });

  describe('Transaction isolation', () => {
    test('should read own writes within transaction', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await db.transaction(async (ctx) => {
          // Insert a user
          await ctx.users.insert({
            username: 'read_own_writes',
            email: 'readown@test.com',
            isActive: true,
          });

          // Should be able to read our own insert within the same transaction
          const user = await ctx.users
            .where(u => eq(u.username, 'read_own_writes'))
            .firstOrDefault();

          expect(user).not.toBeNull();
          expect(user?.email).toBe('readown@test.com');
        });
      });
    });

    test('should support updates within transaction', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        await db.transaction(async (ctx) => {
          // Update alice's email
          await ctx.users
            .where(u => eq(u.id, users.alice.id))
            .update({ email: 'alice_updated@test.com' });

          // Verify the update is visible within transaction
          const alice = await ctx.users
            .where(u => eq(u.id, users.alice.id))
            .firstOrDefault();

          expect(alice?.email).toBe('alice_updated@test.com');
        });

        // Verify the update persisted after commit
        const alice = await db.users
          .where(u => eq(u.id, users.alice.id))
          .firstOrDefault();
        expect(alice?.email).toBe('alice_updated@test.com');
      });
    });

    test('should support deletes within transaction', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const initialCount = await db.users.count();

        await db.transaction(async (ctx) => {
          // Delete charlie
          await ctx.users
            .where(u => eq(u.id, users.charlie.id))
            .delete();

          // Verify charlie is gone within transaction
          const charlie = await ctx.users
            .where(u => eq(u.id, users.charlie.id))
            .firstOrDefault();
          expect(charlie).toBeNull();
        });

        // Verify delete persisted
        const finalCount = await db.users.count();
        expect(finalCount).toBe(initialCount - 1);
      });
    });
  });

  describe('Nested operations', () => {
    test('should handle queries with navigation properties in transaction', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.transaction(async (ctx) => {
          // Query with navigation/join
          const usersWithPosts = await ctx.users
            .select(u => ({
              id: u.id,
              username: u.username,
              posts: u.posts!.toList(),
            }))
            .where(u => eq(u.id, users.alice.id))
            .toList();

          return usersWithPosts;
        });

        expect(result).toHaveLength(1);
        expect(result[0].username).toBe('alice');
        expect(result[0].posts.length).toBeGreaterThan(0);
      });
    });
  });
});
