import { describe, test, expect } from '@jest/globals';
import { withDatabase, seedTestData } from '../utils/test-database';
import { eq, gt, lt, gte, lte, and, or, like, IEntityQueryable } from '../../src';
import { User } from '../../debug/model/user';

describe('IEntityQueryable Interface', () => {
  describe('Variable assignment pattern', () => {
    test('should allow query variable with IEntityQueryable type', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Use IEntityQueryable<User> as the variable type
        let query: IEntityQueryable<User> = db.users;

        // Add first where condition
        query = query.where(u => eq(u.isActive, true));

        // Add second where condition
        query = query.where(u => gt(u.age!, 30));

        // Execute the query
        const users = await query.toList();

        // Only bob (35, active) matches both conditions
        expect(users.length).toBe(1);
        expect(users[0].username).toBe('bob');
      });
    });

    test('should allow conditional where clauses with variable', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Start with base query
        let query: IEntityQueryable<User> = db.users;

        // Conditionally add filters
        const onlyActive = true;
        const minAge = 30;
        const maxAge: number | undefined = undefined;

        if (onlyActive) {
          query = query.where(u => eq(u.isActive, true));
        }

        if (minAge !== undefined) {
          query = query.where(u => gte(u.age!, minAge));
        }

        if (maxAge !== undefined) {
          query = query.where(u => lte(u.age!, maxAge));
        }

        const users = await query.toList();

        // alice (25) and bob (35) are active, but only bob has age >= 30
        expect(users.length).toBe(1);
        expect(users[0].username).toBe('bob');
      });
    });

    test('should allow building query in a function', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Function that builds a query based on parameters
        function buildUserQuery(
          baseQuery: IEntityQueryable<User>,
          filters: { onlyActive?: boolean; minAge?: number; usernameContains?: string }
        ): IEntityQueryable<User> {
          let query = baseQuery;

          if (filters.onlyActive) {
            query = query.where(u => eq(u.isActive, true));
          }

          if (filters.minAge !== undefined) {
            query = query.where(u => gte(u.age!, filters.minAge!));
          }

          if (filters.usernameContains) {
            query = query.where(u => like(u.username, `%${filters.usernameContains}%`));
          }

          return query;
        }

        // Build query with filters
        const filteredQuery = buildUserQuery(db.users, {
          onlyActive: true,
          minAge: 25,
          usernameContains: 'a',
        });

        const users = await filteredQuery.toList();

        // Only alice (25, active, contains 'a') matches all conditions
        // bob is 35 and active but username doesn't contain 'a'
        expect(users.length).toBe(1);
        expect(users[0].username).toBe('alice');
      });
    });

    test('should chain multiple where calls and get count', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.isActive, true));
        query = query.where(u => gte(u.age!, 25));

        const count = await query.count();

        // alice (25, active) and bob (35, active) match
        expect(count).toBe(2);
      });
    });

    test('should use first() and firstOrDefault() on IEntityQueryable', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.username, 'alice'));

        const user = await query.first();
        expect(user.username).toBe('alice');

        // Test firstOrDefault with no match
        let emptyQuery: IEntityQueryable<User> = db.users;
        emptyQuery = emptyQuery.where(u => eq(u.username, 'nonexistent'));

        const noUser = await emptyQuery.firstOrDefault();
        expect(noUser).toBeNull();
      });
    });

    test('should allow select() after where() chaining', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.isActive, true));
        query = query.where(u => gt(u.age!, 30));

        // select() transitions to EntitySelectQueryBuilder
        const selectedUsers = await query
          .select(u => ({
            name: u.username,
            userAge: u.age,
          }))
          .toList();

        expect(selectedUsers.length).toBe(1);
        expect(selectedUsers[0].name).toBe('bob');
        expect(selectedUsers[0].userAge).toBe(35);
      });
    });

    test('should allow orderBy() after where() chaining', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.isActive, true));

        // orderBy() returns EntitySelectQueryBuilder
        const users = await query
          .orderBy(u => [[u.age, 'DESC']])
          .toList();

        expect(users.length).toBe(2);
        // Ordered by age DESC: bob (35) first, then alice (25)
        expect(users[0].username).toBe('bob');
        expect(users[1].username).toBe('alice');
      });
    });

    test('should allow limit() and offset() after where() chaining', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.isActive, true));

        // Get first user with limit
        const limitedUsers = await query.limit(1).toList();
        expect(limitedUsers.length).toBe(1);

        // Get second user with offset
        const offsetUsers = await query.offset(1).limit(1).toList();
        expect(offsetUsers.length).toBe(1);
        // Should be different from first
        expect(offsetUsers[0].username).not.toBe(limitedUsers[0].username);
      });
    });
  });

  describe('Type safety', () => {
    test('should preserve entity type through where chaining', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // TypeScript should infer the correct types
        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.isActive, true));

        const users = await query.toList();

        // Verify we get properly typed User entities
        users.forEach(user => {
          expect(typeof user.id).toBe('number');
          expect(typeof user.username).toBe('string');
          expect(typeof user.email).toBe('string');
          expect(user.isActive === true || user.isActive === false).toBe(true);
        });
      });
    });

    test('should work with dynamic filter building', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Simulate dynamic filter building from API parameters
        interface UserFilters {
          isActive?: boolean;
          minAge?: number;
          maxAge?: number;
          emailDomain?: string;
        }

        function applyFilters(
          query: IEntityQueryable<User>,
          filters: UserFilters
        ): IEntityQueryable<User> {
          if (filters.isActive !== undefined) {
            query = query.where(u => eq(u.isActive, filters.isActive!));
          }
          if (filters.minAge !== undefined) {
            query = query.where(u => gte(u.age!, filters.minAge!));
          }
          if (filters.maxAge !== undefined) {
            query = query.where(u => lte(u.age!, filters.maxAge!));
          }
          if (filters.emailDomain) {
            query = query.where(u => like(u.email, `%@${filters.emailDomain}`));
          }
          return query;
        }

        // Test with various filter combinations
        const filters: UserFilters = {
          isActive: true,
          emailDomain: 'test.com',
        };

        const results = await applyFilters(db.users, filters).toList();

        expect(results.length).toBe(2); // alice and bob are active with test.com emails
        results.forEach(user => {
          expect(user.isActive).toBe(true);
          expect(user.email).toContain('@test.com');
        });
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle empty where conditions gracefully', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Start with base query, don't add any conditions
        const query: IEntityQueryable<User> = db.users;

        const allUsers = await query.toList();

        // Should return all users
        expect(allUsers.length).toBe(3);
      });
    });

    test('should handle multiple reassignments', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;

        // Multiple reassignments
        query = query.where(u => eq(u.isActive, true));
        query = query.where(u => gte(u.age!, 20));
        query = query.where(u => lte(u.age!, 40));
        query = query.where(u => like(u.email, '%@test.com'));

        const users = await query.toList();

        // alice (25) and bob (35) match all conditions
        expect(users.length).toBe(2);
      });
    });

    test('should work with no results', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        let query: IEntityQueryable<User> = db.users;
        query = query.where(u => eq(u.username, 'nonexistent'));

        const users = await query.toList();
        expect(users.length).toBe(0);

        const count = await query.count();
        expect(count).toBe(0);
      });
    });
  });
});
