import { withDatabase, seedTestData } from '../utils/test-database';
import { eq } from '../../src/query/conditions';

describe('Bulk Update', () => {
  describe('Basic functionality', () => {
    test('should update multiple records by primary key', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Update multiple users at once with .returning() to get updated records
        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 100 },
          { id: users.bob.id, age: 200 },
          { id: users.charlie.id, age: 300 },
        ]).returning();

        // Verify all records were updated
        expect(updated.length).toBe(3);

        // Fetch fresh data to verify
        const alice = await db.users.where(u => eq(u.id, users.alice.id)).toList();
        const bob = await db.users.where(u => eq(u.id, users.bob.id)).toList();
        const charlie = await db.users.where(u => eq(u.id, users.charlie.id)).toList();

        expect(alice[0].age).toBe(100);
        expect(bob[0].age).toBe(200);
        expect(charlie[0].age).toBe(300);
      });
    });

    test('should update different columns for different records', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Update different columns for each record
        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 50 },
          { id: users.bob.id, isActive: false },
          { id: users.charlie.id, age: 99, isActive: true },
        ]).returning();

        expect(updated.length).toBe(3);

        // Verify updates
        const alice = await db.users.where(u => eq(u.id, users.alice.id)).toList();
        expect(alice[0].age).toBe(50);
        expect(alice[0].isActive).toBe(true); // unchanged

        const bob = await db.users.where(u => eq(u.id, users.bob.id)).toList();
        expect(bob[0].isActive).toBe(false);
        expect(bob[0].age).toBe(35); // unchanged (original from seed)

        const charlie = await db.users.where(u => eq(u.id, users.charlie.id)).toList();
        expect(charlie[0].age).toBe(99);
        expect(charlie[0].isActive).toBe(true);
      });
    });

    test('should return updated records with all columns', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 99 },
        ]).returning();

        expect(updated.length).toBe(1);
        expect(updated[0].id).toBe(users.alice.id);
        expect(updated[0].username).toBe('alice');
        expect(updated[0].email).toBe('alice@test.com');
        expect(updated[0].age).toBe(99);
        expect(updated[0].isActive).toBe(true);
      });
    });

    test('should return void by default when no .returning() is called', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const result = await db.users.bulkUpdate([
          { id: users.alice.id, age: 99 },
        ]);

        expect(result).toBeUndefined();

        // Verify the update happened
        const alice = await db.users.where(u => eq(u.id, users.alice.id)).toList();
        expect(alice[0].age).toBe(99);
      });
    });

    test('should return empty array when no data provided with .returning()', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.bulkUpdate([]).returning();
        expect(result).toEqual([]);
      });
    });

    test('should return void when no data provided without .returning()', async () => {
      await withDatabase(async (db) => {
        const result = await db.users.bulkUpdate([]);
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Primary key handling', () => {
    test('should auto-detect primary key from schema', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Should work without specifying primaryKey config
        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 77 },
        ]).returning();

        expect(updated.length).toBe(1);
        expect(updated[0].age).toBe(77);
      });
    });

    test('should use custom primary key when specified', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Use username as primary key (unique column)
        const updated = await db.users.bulkUpdate(
          [{ username: 'alice', age: 88 }],
          { primaryKey: 'username' }
        ).returning();

        expect(updated.length).toBe(1);
        expect(updated[0].username).toBe('alice');
        expect(updated[0].age).toBe(88);
      });
    });

    test('should throw error when primary key is missing in record', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        await expect(
          db.users.bulkUpdate([
            { age: 50 } as any, // Missing id
          ])
        ).rejects.toThrow('Record at index 0 is missing primary key "id"');
      });
    });

    test('should throw error when only primary keys provided (nothing to update)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        await expect(
          db.users.bulkUpdate([
            { id: users.alice.id },
          ])
        ).rejects.toThrow('No columns to update');
      });
    });
  });

  describe('Data types', () => {
    test('should handle string columns', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, email: 'newemail@test.com' },
        ]).returning();

        expect(updated[0].email).toBe('newemail@test.com');
      });
    });

    test('should handle boolean columns', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, isActive: false },
          { id: users.bob.id, isActive: false },
        ]).returning();

        expect(updated.length).toBe(2);
        const alice = updated.find(u => u.id === users.alice.id);
        const bob = updated.find(u => u.id === users.bob.id);
        expect(alice?.isActive).toBe(false);
        expect(bob?.isActive).toBe(false);
      });
    });

    test('should handle null values', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: null as any },
        ]).returning();

        expect(updated[0].age).toBeNull();
      });
    });

    test('should handle JSONB columns', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, metadata: { role: 'admin', level: 5 } },
        ]).returning();

        expect(updated[0].metadata).toEqual({ role: 'admin', level: 5 });
      });
    });
  });

  describe('Query validation', () => {
    test('should not include RETURNING when no .returning() called', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Capture queries
        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.bulkUpdate([
          { id: users.alice.id, age: 50 },
          { id: users.bob.id, age: 60 },
        ]);

        // Verify SQL structure
        expect(queries.length).toBe(1);
        const sql = queries[0];

        // Check for UPDATE...FROM VALUES pattern without RETURNING
        expect(sql).toContain('UPDATE "users" AS t');
        expect(sql).toContain('SET');
        expect(sql).toContain('FROM (VALUES');
        expect(sql).toContain('WHERE t."id" = v."id"');
        expect(sql.toUpperCase()).not.toContain('RETURNING');
      });
    });

    test('should include RETURNING when .returning() is called', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Capture queries
        const queries: string[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          queries.push(sql);
          return originalQuery(sql, params);
        };

        await db.users.bulkUpdate([
          { id: users.alice.id, age: 50 },
          { id: users.bob.id, age: 60 },
        ]).returning();

        // Verify SQL structure
        expect(queries.length).toBe(1);
        const sql = queries[0];

        // Check for UPDATE...FROM VALUES pattern with RETURNING
        expect(sql).toContain('UPDATE "users" AS t');
        expect(sql).toContain('SET');
        expect(sql).toContain('FROM (VALUES');
        expect(sql).toContain('WHERE t."id" = v."id"');
        expect(sql).toContain('RETURNING');
      });
    });

    test('should use parameterized queries', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Capture parameters
        let capturedParams: any[] = [];
        const originalQuery = (db as any).client.query.bind((db as any).client);
        (db as any).client.query = async (sql: string, params: any[]) => {
          capturedParams = params;
          return originalQuery(sql, params);
        };

        await db.users.bulkUpdate([
          { id: users.alice.id, age: 50 },
          { id: users.bob.id, age: 60 },
        ]).returning();

        // Check that values are passed as parameters
        expect(capturedParams).toContain(users.alice.id);
        expect(capturedParams).toContain(50);
        expect(capturedParams).toContain(users.bob.id);
        expect(capturedParams).toContain(60);
      });
    });
  });

  describe('Edge cases', () => {
    test('should handle single record update', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 42 },
        ]).returning();

        expect(updated.length).toBe(1);
        expect(updated[0].age).toBe(42);
      });
    });

    test('should handle non-existent records gracefully', async () => {
      await withDatabase(async (db) => {
        await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: 99999, age: 50 }, // Non-existent ID
        ]).returning();

        // Should return empty since no records matched
        expect(updated.length).toBe(0);
      });
    });

    test('should handle mixed existing and non-existing records', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 50 },
          { id: 99999, age: 60 }, // Non-existent
          { id: users.bob.id, age: 70 },
        ]).returning();

        // Should only return the 2 existing records
        expect(updated.length).toBe(2);
        expect(updated.map(u => u.id).sort()).toEqual([users.alice.id, users.bob.id].sort());
      });
    });

    test('should handle update with same values (no actual change)', async () => {
      await withDatabase(async (db) => {
        const { users } = await seedTestData(db);

        // Update with same age value
        const updated = await db.users.bulkUpdate([
          { id: users.alice.id, age: 25 }, // Same as original
        ]).returning();

        expect(updated.length).toBe(1);
        expect(updated[0].age).toBe(25);
      });
    });
  });

  describe('Posts table tests', () => {
    test('should bulk update posts with integer columns', async () => {
      await withDatabase(async (db) => {
        const { posts } = await seedTestData(db);

        const updated = await db.posts.bulkUpdate([
          { id: posts.alicePost1.id, views: 500 },
          { id: posts.alicePost2.id, views: 600 },
          { id: posts.bobPost.id, views: 700 },
        ]).returning();

        expect(updated.length).toBe(3);

        const post1 = updated.find(p => p.id === posts.alicePost1.id);
        const post2 = updated.find(p => p.id === posts.alicePost2.id);
        const post3 = updated.find(p => p.id === posts.bobPost.id);

        expect(post1?.views).toBe(500);
        expect(post2?.views).toBe(600);
        expect(post3?.views).toBe(700);
      });
    });

    test('should bulk update posts with text columns', async () => {
      await withDatabase(async (db) => {
        const { posts } = await seedTestData(db);

        const updated = await db.posts.bulkUpdate([
          { id: posts.alicePost1.id, title: 'Updated Title 1', content: 'Updated content 1' },
          { id: posts.bobPost.id, title: 'Updated Title 2' },
        ]).returning();

        expect(updated.length).toBe(2);

        const post1 = updated.find(p => p.id === posts.alicePost1.id);
        expect(post1?.title).toBe('Updated Title 1');
        expect(post1?.content).toBe('Updated content 1');

        const post2 = updated.find(p => p.id === posts.bobPost.id);
        expect(post2?.title).toBe('Updated Title 2');
        expect(post2?.content).toBe('Content from Bob'); // Unchanged
      });
    });
  });

  describe('Chunking', () => {
    test('should handle large batch with custom chunk size', async () => {
      await withDatabase(async (db) => {
        // Insert many users with .returning() to get their IDs
        const userIds: number[] = [];
        for (let i = 0; i < 10; i++) {
          const user = await db.users.insert({
            username: `user${i}`,
            email: `user${i}@test.com`,
            isActive: true,
          }).returning();
          userIds.push(user.id);
        }

        // Update all with small chunk size
        const updates = userIds.map(id => ({ id, age: 99 }));
        const updated = await db.users.bulkUpdate(updates, { chunkSize: 3 }).returning();

        expect(updated.length).toBe(10);
        expect(updated.every(u => u.age === 99)).toBe(true);
      });
    });
  });
});
