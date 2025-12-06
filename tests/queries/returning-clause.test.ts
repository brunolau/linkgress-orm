import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src/query/conditions';

describe('Returning Clause (Fluent API)', () => {
  describe('insert', () => {
    test('should return void by default (no returning)', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'newuser',
          email: 'new@test.com',
          isActive: true,
        });

        expect(result).toBeUndefined();

        // Verify the record was actually inserted
        const users = await db.users.where(u => eq(u.username, 'newuser')).toList();
        expect(users.length).toBe(1);
      });
    });

    test('should return full entity with .returning()', async () => {
      await withDatabase(async (db) => {
        const user = await db.users.insert({
          username: 'user1',
          email: 'user1@test.com',
          isActive: true,
        }).returning();

        expect(user).toHaveProperty('id');
        expect(user).toHaveProperty('username', 'user1');
        expect(user).toHaveProperty('email', 'user1@test.com');
        expect(typeof user.id).toBe('number');
      });
    });

    test('should return selected columns with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'user2',
          email: 'user2@test.com',
          isActive: true,
        }).returning(u => ({ id: u.id, username: u.username }));

        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('username', 'user2');
        expect(result).not.toHaveProperty('email');
        expect(result).not.toHaveProperty('isActive');
      });
    });

    test('should return single column with alias', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'user3',
          email: 'user3@test.com',
          isActive: true,
        }).returning(u => ({ generatedId: u.id }));

        expect(result).toHaveProperty('generatedId');
        expect(typeof result.generatedId).toBe('number');
      });
    });
  });

  describe('insertMany', () => {
    test('should return void by default', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insertMany([
          { username: 'batch1', email: 'batch1@test.com', isActive: true },
          { username: 'batch2', email: 'batch2@test.com', isActive: false },
        ]);

        expect(result).toBeUndefined();

        // Verify records were inserted
        const users = await db.users.where(u => eq(u.username, 'batch1')).toList();
        expect(users.length).toBe(1);
      });
    });

    test('should return full entities with .returning()', async () => {
      await withDatabase(async (db) => {
        const users = await db.users.insertMany([
          { username: 'batch3', email: 'batch3@test.com', isActive: true },
          { username: 'batch4', email: 'batch4@test.com', isActive: false },
        ]).returning();

        expect(users.length).toBe(2);
        expect(users[0]).toHaveProperty('id');
        expect(users[0]).toHaveProperty('username');
        expect(users[0]).toHaveProperty('email');
      });
    });

    test('should return selected columns with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        const results = await db.users.insertMany([
          { username: 'batch5', email: 'batch5@test.com', isActive: true },
          { username: 'batch6', email: 'batch6@test.com', isActive: true },
        ]).returning(u => ({ id: u.id, username: u.username }));

        expect(results.length).toBe(2);
        expect(results[0]).toHaveProperty('id');
        expect(results[0]).toHaveProperty('username');
        expect(results[0]).not.toHaveProperty('email');
      });
    });
  });

  describe('insertBulk', () => {
    test('should return void by default', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insertBulk([
          { username: 'bulk1', email: 'bulk1@test.com', isActive: true },
        ]);

        expect(result).toBeUndefined();
      });
    });

    test('should return full entities with .returning()', async () => {
      await withDatabase(async (db) => {
        const users = await db.users.insertBulk([
          { username: 'bulk2', email: 'bulk2@test.com', isActive: true },
        ]).returning();

        expect(users.length).toBe(1);
        expect(users[0]).toHaveProperty('id');
        expect(users[0]).toHaveProperty('username', 'bulk2');
      });
    });

    test('should return selected columns with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        const results = await db.users.insertBulk([
          { username: 'bulk3', email: 'bulk3@test.com', isActive: true },
        ]).returning(u => ({ id: u.id }));

        expect(results.length).toBe(1);
        expect(results[0]).toHaveProperty('id');
        expect(results[0]).not.toHaveProperty('username');
      });
    });
  });

  describe('update', () => {
    test('should return void by default', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users.update(
          { age: 99 },
          u => eq(u.id, users.alice.id)
        );

        expect(result).toBeUndefined();

        // Verify the update happened
        const alice = await db.users.where(u => eq(u.id, users.alice.id)).toList();
        expect(alice[0].age).toBe(99);
      });
    });

    test('should return full entities with .returning()', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.update(
          { age: 88 },
          u => eq(u.id, users.alice.id)
        ).returning();

        expect(updated.length).toBe(1);
        expect(updated[0]).toHaveProperty('id', users.alice.id);
        expect(updated[0]).toHaveProperty('age', 88);
        expect(updated[0]).toHaveProperty('username', 'alice');
      });
    });

    test('should return selected columns with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const results = await db.users.update(
          { age: 77 },
          u => eq(u.id, users.alice.id)
        ).returning(u => ({ id: u.id, age: u.age }));

        expect(results.length).toBe(1);
        expect(results[0]).toHaveProperty('id', users.alice.id);
        expect(results[0]).toHaveProperty('age', 77);
        expect(results[0]).not.toHaveProperty('username');
      });
    });

    test('should return multiple updated records', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        // Update all active users
        const results = await db.users.update(
          { age: 50 },
          u => eq(u.isActive, true)
        ).returning(u => ({ id: u.id, age: u.age }));

        expect(results.length).toBeGreaterThan(1);
        expect(results.every(r => r.age === 50)).toBe(true);
      });
    });
  });

  describe('bulkUpdate', () => {
    test('should return void by default', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users.bulkUpdate([
          { id: users.alice.id, age: 100 },
          { id: users.bob.id, age: 200 },
        ]);

        expect(result).toBeUndefined();

        // Verify updates
        const alice = await db.users.where(u => eq(u.id, users.alice.id)).toList();
        expect(alice[0].age).toBe(100);
      });
    });

    test('should return full entities with .returning()', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 111 },
          { id: users.bob.id, age: 222 },
        ]).returning();

        expect(updated.length).toBe(2);
        expect(updated[0]).toHaveProperty('id');
        expect(updated[0]).toHaveProperty('username');
        expect(updated[0]).toHaveProperty('email');
      });
    });

    test('should return selected columns with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const results = await db.users.bulkUpdate([
          { id: users.alice.id, age: 33 },
          { id: users.bob.id, age: 44 },
        ]).returning(u => ({ id: u.id, age: u.age }));

        expect(results.length).toBe(2);
        expect(results[0]).toHaveProperty('id');
        expect(results[0]).toHaveProperty('age');
        expect(results[0]).not.toHaveProperty('username');
      });
    });
  });

  describe('upsertBulk', () => {
    test('should return void by default (insert)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const result = await db.users.upsertBulk([
          { username: 'upsert1', email: 'upsert1@test.com', isActive: true },
        ], {
          primaryKey: 'username',
        });

        expect(result).toBeUndefined();

        // Verify insert
        const users = await db.users.where(u => eq(u.username, 'upsert1')).toList();
        expect(users.length).toBe(1);
      });
    });

    test('should return full entities with .returning() (update)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const results = await db.users.upsertBulk([
          { username: 'alice', email: 'updated@test.com', isActive: false },
        ], {
          primaryKey: 'username',
        }).returning();

        expect(results.length).toBe(1);
        expect(results[0]).toHaveProperty('id', users.alice.id);
        expect(results[0]).toHaveProperty('email', 'updated@test.com');
      });
    });

    test('should return selected columns with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const results = await db.users.upsertBulk([
          { username: 'upsert2', email: 'upsert2@test.com', isActive: true },
        ], {
          primaryKey: 'username',
        }).returning(u => ({ id: u.id, username: u.username }));

        expect(results.length).toBe(1);
        expect(results[0]).toHaveProperty('id');
        expect(results[0]).toHaveProperty('username', 'upsert2');
        expect(results[0]).not.toHaveProperty('email');
      });
    });
  });

  describe('SQL generation', () => {
    test('insert should not include RETURNING when no .returning() called', async () => {
      await withDatabase(async (db) => {
        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.insert({
          username: 'sqltest1',
          email: 'sql1@test.com',
          isActive: true,
        });

        expect(queries.length).toBe(1);
        expect(queries[0].toUpperCase()).not.toContain('RETURNING');
      });
    });

    test('insert should include RETURNING with .returning()', async () => {
      await withDatabase(async (db) => {
        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.insert({
          username: 'sqltest2',
          email: 'sql2@test.com',
          isActive: true,
        }).returning();

        expect(queries.length).toBe(1);
        expect(queries[0].toUpperCase()).toContain('RETURNING');
      });
    });

    test('insert should include RETURNING with selected columns', async () => {
      await withDatabase(async (db) => {
        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.insert({
          username: 'sqltest3',
          email: 'sql3@test.com',
          isActive: true,
        }).returning(u => ({ id: u.id }));

        expect(queries.length).toBe(1);
        expect(queries[0].toUpperCase()).toContain('RETURNING');
        expect(queries[0]).toContain('"id"');
      });
    });

    test('update should not include RETURNING when no .returning() called', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.update(
          { age: 50 },
          u => eq(u.id, users.alice.id)
        );

        expect(queries.some(q => q.toUpperCase().includes('UPDATE'))).toBe(true);
        const updateQuery = queries.find(q => q.toUpperCase().includes('UPDATE'));
        expect(updateQuery!.toUpperCase()).not.toContain('RETURNING');
      });
    });

    test('bulkUpdate should include RETURNING with .returning(selector)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.bulkUpdate([
          { id: users.alice.id, age: 50 },
        ]).returning(u => ({ id: u.id, age: u.age }));

        const updateQuery = queries.find(q => q.toUpperCase().includes('UPDATE'));
        expect(updateQuery).toBeDefined();
        expect(updateQuery!.toUpperCase()).toContain('RETURNING');
      });
    });
  });

  describe('Type safety', () => {
    test('selected returning columns should have correct types', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'typetest',
          email: 'type@test.com',
          isActive: true,
          age: 25,
        }).returning(u => ({ id: u.id, username: u.username, age: u.age, isActive: u.isActive }));

        // Runtime type checks
        expect(typeof result.id).toBe('number');
        expect(typeof result.username).toBe('string');
        expect(typeof result.age).toBe('number');
        expect(typeof result.isActive).toBe('boolean');
      });
    });
  });

  describe('Strict void return verification', () => {
    test('insert without returning should return undefined, not entity', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'voidtest',
          email: 'void@test.com',
          isActive: true,
        });

        // CRITICAL: This must be undefined, not an entity with id
        expect(result).toBeUndefined();

        // Extra check: result should NOT have an id property
        expect((result as any)?.id).toBeUndefined();
      });
    });

    test('insertMany without returning should return undefined, not array', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insertMany([
          { username: 'void1', email: 'void1@test.com', isActive: true },
          { username: 'void2', email: 'void2@test.com', isActive: true },
        ]);

        expect(result).toBeUndefined();
        expect(Array.isArray(result)).toBe(false);
      });
    });

    test('update without returning should return undefined, not array', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users.update(
          { age: 99 },
          u => eq(u.id, users.alice.id)
        );

        expect(result).toBeUndefined();
        expect(Array.isArray(result)).toBe(false);
      });
    });

    test('bulkUpdate without returning should return undefined, not array', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users.bulkUpdate([
          { id: users.alice.id, age: 99 },
        ]);

        expect(result).toBeUndefined();
        expect(Array.isArray(result)).toBe(false);
      });
    });

    test('upsertBulk without returning should return undefined, not array', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.upsertBulk([
          { username: 'voidupsert', email: 'voidupsert@test.com', isActive: true },
        ], {
          primaryKey: 'username',
        });

        expect(result).toBeUndefined();
        expect(Array.isArray(result)).toBe(false);
      });
    });
  });

  describe('Only specified fields returned', () => {
    test('returning with selector should only return specified fields', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'selectivetest',
          email: 'selective@test.com',
          age: 25,
          isActive: true,
        }).returning(u => ({ id: u.id }));

        // Should have id
        expect(result).toHaveProperty('id');
        expect(typeof result.id).toBe('number');

        // Should NOT have other fields
        expect(Object.keys(result)).toEqual(['id']);
        expect(result).not.toHaveProperty('username');
        expect(result).not.toHaveProperty('email');
        expect(result).not.toHaveProperty('age');
        expect(result).not.toHaveProperty('isActive');
      });
    });

    test('returning with multiple fields should only return those fields', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insert({
          username: 'multifield',
          email: 'multi@test.com',
          age: 30,
          isActive: true,
        }).returning(u => ({ id: u.id, username: u.username }));

        // Should have only id and username
        expect(Object.keys(result).sort()).toEqual(['id', 'username']);
        expect(result.id).toBeDefined();
        expect(result.username).toBe('multifield');
        expect(result).not.toHaveProperty('email');
        expect(result).not.toHaveProperty('age');
      });
    });

    test('update with selector should only return specified fields', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const results = await db.users.update(
          { age: 50 },
          u => eq(u.id, users.alice.id)
        ).returning(u => ({ age: u.age }));

        expect(results.length).toBe(1);
        expect(Object.keys(results[0])).toEqual(['age']);
        expect(results[0].age).toBe(50);
        expect(results[0]).not.toHaveProperty('id');
        expect(results[0]).not.toHaveProperty('username');
      });
    });
  });

  describe('Edge cases', () => {
    test('empty array insert should return void by default', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insertMany([]);
        expect(result).toBeUndefined();
      });
    });

    test('empty array insert with .returning() should return empty array', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.insertMany([]).returning();
        expect(result).toEqual([]);
      });
    });

    test('empty array bulkUpdate should return void by default', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.bulkUpdate([]);
        expect(result).toBeUndefined();
      });
    });

    test('empty array bulkUpdate with .returning() should return empty array', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.bulkUpdate([]).returning();
        expect(result).toEqual([]);
      });
    });

    test('empty array upsertBulk should return void by default', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.upsertBulk([]);
        expect(result).toBeUndefined();
      });
    });

    test('empty array upsertBulk with .returning() should return empty array', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.upsertBulk([]).returning();
        expect(result).toEqual([]);
      });
    });
  });
});
