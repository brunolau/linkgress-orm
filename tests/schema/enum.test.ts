import { describe, test, expect } from '@jest/globals';
import { expectToReject } from '../utils/expect-rejects';
import { withDatabase, createTestDatabase, createFreshClient } from '../utils/test-database';
import { eq, inArray, DbContext, DbEntityTable, DbEntity, DbColumn, DbModelConfig, integer, varchar, pgEnum, enumColumn } from '../../src';

// Isolated test enums with unique names for Schema Deletion test
const testEnumTaskStatus = pgEnum('test_enum_task_status', ['pending', 'done'] as const);
const testEnumTaskPriority = pgEnum('test_enum_task_priority', ['low', 'high'] as const);

class EnumTestTask extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  status!: DbColumn<'pending' | 'done'>;
  priority!: DbColumn<'low' | 'high'>;
}

class EnumTestDatabase extends DbContext {
  get tasks(): DbEntityTable<EnumTestTask> {
    return this.table(EnumTestTask);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(EnumTestTask, entity => {
      entity.toTable('enum_test_tasks');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'enum_test_tasks_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.status).hasType(enumColumn('status', testEnumTaskStatus)).isRequired();
      entity.property(e => e.priority).hasType(enumColumn('priority', testEnumTaskPriority)).isRequired();
    });
  }
}

describe('PostgreSQL ENUM Support', () => {
  describe('Schema Creation', () => {
    test('should create enum types', async () => {
      await withDatabase(async (db) => {
        const client = (db as any).client;

        // Query to check if enum types exist
        const result = await client.query(`
          SELECT typname
          FROM pg_type
          WHERE typname IN ('task_status', 'task_priority')
          ORDER BY typname
        `);

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].typname).toBe('task_priority');
        expect(result.rows[1].typname).toBe('task_status');
      });
    });

    test('should have correct enum values', async () => {
      await withDatabase(async (db) => {
        const client = (db as any).client;

        const result = await client.query(`
          SELECT e.enumlabel as value
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          WHERE t.typname = 'task_status'
          ORDER BY e.enumsortorder
        `);

        const values = result.rows.map((row: any) => row.value);
        expect(values).toEqual(['pending', 'processing', 'completed', 'cancelled']);
      });
    });

    test('should create table with enum columns', async () => {
      await withDatabase(async (db) => {
        const client = (db as any).client;

        const result = await client.query(`
          SELECT column_name, udt_name
          FROM information_schema.columns
          WHERE table_name = 'tasks'
          AND column_name IN ('status', 'priority')
          ORDER BY column_name
        `);

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].column_name).toBe('priority');
        expect(result.rows[0].udt_name).toBe('task_priority');
        expect(result.rows[1].column_name).toBe('status');
        expect(result.rows[1].udt_name).toBe('task_status');
      });
    });
  });

  describe('Insert and Query', () => {
    test('should insert records with enum values', async () => {
      await withDatabase(async (db) => {
        const task = await db.tasks.insert({
          title: 'Test task',
          status: 'pending',
          priority: 'high',
        }).returning();

        expect(task.title).toBe('Test task');
        expect(task.status).toBe('pending');
        expect(task.priority).toBe('high');
      });
    });

    test('should query records with enum values', async () => {
      await withDatabase(async (db) => {
        await db.tasks.insert({ title: 'Task 1', status: 'pending', priority: 'low' });
        await db.tasks.insert({ title: 'Task 2', status: 'processing', priority: 'high' });
        await db.tasks.insert({ title: 'Task 3', status: 'completed', priority: 'medium' });

        const tasks = await db.tasks.toList();

        expect(tasks).toHaveLength(3);
        expect(tasks[0].status).toBe('pending');
        expect(tasks[1].status).toBe('processing');
        expect(tasks[2].status).toBe('completed');
      });
    });

    test('should filter by enum values', async () => {
      await withDatabase(async (db) => {
        await db.tasks.insert({ title: 'Task 1', status: 'pending', priority: 'low' });
        await db.tasks.insert({ title: 'Task 2', status: 'processing', priority: 'high' });
        await db.tasks.insert({ title: 'Task 3', status: 'pending', priority: 'medium' });

        const pendingTasks = await db.tasks
          .where(t => eq(t.status, 'pending'))
          .toList();

        expect(pendingTasks).toHaveLength(2);
        expect(pendingTasks[0].status).toBe('pending');
        expect(pendingTasks[1].status).toBe('pending');
      });
    });

    test('should filter by multiple enum values', async () => {
      await withDatabase(async (db) => {
        await db.tasks.insert({ title: 'Task 1', status: 'pending', priority: 'low' });
        await db.tasks.insert({ title: 'Task 2', status: 'processing', priority: 'high' });
        await db.tasks.insert({ title: 'Task 3', status: 'completed', priority: 'medium' });
        await db.tasks.insert({ title: 'Task 4', status: 'cancelled', priority: 'low' });

        const activeTasks = await db.tasks
          .where(t => inArray(t.status, ['pending', 'processing']))
          .toList();

        expect(activeTasks).toHaveLength(2);
        expect(activeTasks[0].status).toBe('pending');
        expect(activeTasks[1].status).toBe('processing');
      });
    });

    test('should reject invalid enum values', async () => {
      await withDatabase(async (db) => {
        await expectToReject(async () => {
          await db.tasks.insert({
            title: 'Invalid task',
            status: 'invalid_status' as any,
            priority: 'low',
          });
        });
      });
    });
  });

  describe('Enum Migration', () => {
    test('should add new enum values', async () => {
      await withDatabase(async (db) => {
        const client = (db as any).client;

        // Add a new value to the enum
        await client.query(`ALTER TYPE "task_status" ADD VALUE 'archived'`);

        // Verify the new value was added
        const result = await client.query(`
          SELECT e.enumlabel as value
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          WHERE t.typname = 'task_status'
          ORDER BY e.enumsortorder
        `);

        const values = result.rows.map((row: any) => row.value);
        expect(values).toContain('archived');
      });
    });
  });

  describe('Schema Deletion', () => {
    test('should drop enum types when schema is deleted', async () => {
      const client = createFreshClient();
      const db = new EnumTestDatabase(client);

      try {
        // Clean up any previous test runs
        await client.query(`DROP TABLE IF EXISTS enum_test_tasks CASCADE`);
        await client.query(`DROP TYPE IF EXISTS test_enum_task_status, test_enum_task_priority CASCADE`);

        // Create schema with enums
        await db.getSchemaManager().ensureCreated();

        // Verify enums exist
        let result = await client.query(`
          SELECT typname
          FROM pg_type
          WHERE typname IN ('test_enum_task_status', 'test_enum_task_priority')
        `);
        expect(result.rows).toHaveLength(2);

        // Drop schema
        await db.getSchemaManager().ensureDeleted();

        // Verify enums are dropped
        result = await client.query(`
          SELECT typname
          FROM pg_type
          WHERE typname IN ('test_enum_task_status', 'test_enum_task_priority')
        `);

        expect(result.rows).toHaveLength(0);
      } finally {
        await db.dispose();
      }
    });
  });
});
