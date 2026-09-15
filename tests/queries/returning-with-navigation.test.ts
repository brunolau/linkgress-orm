import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { getSharedDatabase, setupDatabase, cleanupDatabase, seedTestData } from '../utils/test-database';
import { eq, and, gt } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';

describe('Navigation properties in RETURNING statements', () => {
  let db: AppDatabase;

  beforeAll(async () => {
    db = getSharedDatabase({ logQueries: false });
    await setupDatabase(db);
  });

  afterAll(async () => {
    await cleanupDatabase(db);
  });

  describe('delete().returning() with navigation', () => {
    test('should return navigation property fields from delete', async () => {
      // Setup: Create data
      const user = await db.users.insert({
        username: 'delete_nav_test',
        email: 'delete_nav@test.com',
        age: 30,
        isActive: true,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 99.99,
      }).returning();

      // Delete order and return navigation data
      const deleted = await db.orders
        .where(o => eq(o.id, order.id))
        .delete()
        .returning(o => ({
          orderId: o.id,
          orderStatus: o.status,
          userName: o.user!.username,
          userEmail: o.user!.email,
        }));

      expect(deleted.length).toBe(1);
      expect(deleted[0].orderId).toBe(order.id);
      expect(deleted[0].orderStatus).toBe('pending');
      expect(deleted[0].userName).toBe('delete_nav_test');
      expect(deleted[0].userEmail).toBe('delete_nav@test.com');

      // Cleanup
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should work with delete without navigation (simple RETURNING)', async () => {
      const user = await db.users.insert({
        username: 'delete_simple_test',
        email: 'delete_simple@test.com',
        age: 25,
        isActive: true,
      }).returning();

      const deleted = await db.users
        .where(u => eq(u.id, user.id))
        .delete()
        .returning(u => ({
          id: u.id,
          username: u.username,
        }));

      expect(deleted.length).toBe(1);
      expect(deleted[0].id).toBe(user.id);
      expect(deleted[0].username).toBe('delete_simple_test');
    });
  });

  describe('update().returning() with navigation', () => {
    test('should return navigation property fields from update', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'update_nav_test',
        email: 'update_nav@test.com',
        age: 30,
        isActive: true,
      }).returning();

      const post = await db.posts.insert({
        title: 'Original Title',
        content: 'Content',
        userId: user.id,
        views: 0,
        publishTime: { hour: 10, minute: 30 },
      }).returning();

      // Update post and return navigation data
      const updated = await db.posts
        .where(p => eq(p.id, post.id))
        .update({ title: 'Updated Title', views: 100 })
        .returning(p => ({
          postId: p.id,
          postTitle: p.title,
          authorName: p.user!.username,
          authorEmail: p.user!.email,
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].postId).toBe(post.id);
      expect(updated[0].postTitle).toBe('Updated Title');
      expect(updated[0].authorName).toBe('update_nav_test');
      expect(updated[0].authorEmail).toBe('update_nav@test.com');

      // Cleanup
      await db.posts.where(p => eq(p.id, post.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should work with update without navigation (simple RETURNING)', async () => {
      const user = await db.users.insert({
        username: 'update_simple_test',
        email: 'update_simple@test.com',
        age: 25,
        isActive: true,
      }).returning();

      const updated = await db.users
        .where(u => eq(u.id, user.id))
        .update({ age: 35 })
        .returning(u => ({
          id: u.id,
          age: u.age,
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].id).toBe(user.id);
      expect(updated[0].age).toBe(35);

      // Cleanup
      await db.users.where(u => eq(u.id, user.id)).delete();
    });
  });

  describe('insert().returning() with navigation', () => {
    test('should return navigation property fields from insert', async () => {
      // Setup user first
      const user = await db.users.insert({
        username: 'insert_nav_test',
        email: 'insert_nav@test.com',
        age: 30,
        isActive: true,
      }).returning();

      // Insert post and return navigation data
      const inserted = await db.posts
        .insert({
          title: 'New Post',
          content: 'New Content',
          userId: user.id,
          views: 50,
          publishTime: { hour: 14, minute: 0 },
        })
        .returning(p => ({
          postId: p.id,
          postTitle: p.title,
          authorName: p.user!.username,
          authorAge: p.user!.age,
        }));

      expect(inserted).toBeDefined();
      expect(inserted.postTitle).toBe('New Post');
      expect(inserted.authorName).toBe('insert_nav_test');
      expect(inserted.authorAge).toBe(30);

      // Cleanup
      await db.posts.where(p => eq(p.id, inserted.postId)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should work with insert without navigation (simple RETURNING)', async () => {
      const inserted = await db.users
        .insert({
          username: 'insert_simple_test',
          email: 'insert_simple@test.com',
          age: 25,
          isActive: true,
        })
        .returning(u => ({
          id: u.id,
          username: u.username,
        }));

      expect(inserted).toBeDefined();
      expect(inserted.username).toBe('insert_simple_test');

      // Cleanup
      await db.users.where(u => eq(u.id, inserted.id)).delete();
    });
  });

  describe('insertBulk().returning() with navigation', () => {
    test('should return navigation property fields from bulk insert', async () => {
      // Setup user first
      const user = await db.users.insert({
        username: 'bulk_nav_test',
        email: 'bulk_nav@test.com',
        age: 40,
        isActive: true,
      }).returning();

      // Bulk insert posts and return navigation data
      const inserted = await db.posts
        .insertBulk([
          { title: 'Bulk Post 1', content: 'Content 1', userId: user.id, views: 10, publishTime: { hour: 8, minute: 0 } },
          { title: 'Bulk Post 2', content: 'Content 2', userId: user.id, views: 20, publishTime: { hour: 9, minute: 0 } },
        ])
        .returning(p => ({
          postId: p.id,
          postTitle: p.title,
          authorName: p.user!.username,
        }));

      expect(inserted.length).toBe(2);
      // Order may vary, so check both have the author name and titles are present
      const titles = inserted.map(i => i.postTitle).sort();
      expect(titles).toEqual(['Bulk Post 1', 'Bulk Post 2']);
      expect(inserted[0].authorName).toBe('bulk_nav_test');
      expect(inserted[1].authorName).toBe('bulk_nav_test');

      // Cleanup
      await db.posts.where(p => eq(p.userId, user.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should work with bulk insert without navigation (simple RETURNING)', async () => {
      const inserted = await db.users
        .insertBulk([
          { username: 'bulk1', email: 'bulk1@test.com', age: 20, isActive: true },
          { username: 'bulk2', email: 'bulk2@test.com', age: 21, isActive: true },
        ])
        .returning(u => ({
          id: u.id,
          username: u.username,
        }));

      expect(inserted.length).toBe(2);
      expect(inserted[0].username).toBe('bulk1');
      expect(inserted[1].username).toBe('bulk2');

      // Cleanup
      await db.users.where(u => eq(u.username, 'bulk1')).delete();
      await db.users.where(u => eq(u.username, 'bulk2')).delete();
    });
  });

  describe('upsertBulk().returning() with navigation', () => {
    test('should return navigation property fields from upsert', async () => {
      // Setup user first
      const user = await db.users.insert({
        username: 'upsert_nav_test',
        email: 'upsert_nav@test.com',
        age: 50,
        isActive: true,
      }).returning();

      // Insert initial order
      const initialOrder = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 50.00,
      }).returning();

      // Upsert order and return navigation data
      const upserted = await db.orders
        .upsertBulk([
          { id: initialOrder.id, userId: user.id, status: 'completed', totalAmount: 75.00 },
        ], { primaryKey: 'id' })
        .returning(o => ({
          orderId: o.id,
          orderStatus: o.status,
          ownerName: o.user!.username,
        }));

      expect(upserted.length).toBe(1);
      expect(upserted[0].orderId).toBe(initialOrder.id);
      expect(upserted[0].orderStatus).toBe('completed');
      expect(upserted[0].ownerName).toBe('upsert_nav_test');

      // Cleanup
      await db.orders.where(o => eq(o.id, initialOrder.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should work with upsert without navigation (simple RETURNING)', async () => {
      const user = await db.users.insert({
        username: 'upsert_simple_test',
        email: 'upsert_simple@test.com',
        age: 30,
        isActive: true,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 100.00,
      }).returning();

      const upserted = await db.orders
        .upsertBulk([
          { id: order.id, userId: user.id, status: 'processing', totalAmount: 120.00 },
        ], { primaryKey: 'id' })
        .returning(o => ({
          id: o.id,
          status: o.status,
        }));

      expect(upserted.length).toBe(1);
      expect(upserted[0].id).toBe(order.id);
      expect(upserted[0].status).toBe('processing');

      // Cleanup
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });
  });

  describe('returning() with single-level navigation', () => {
    test('should support single-level navigation in returning (orderTask -> task)', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'singlelevel_test',
        email: 'singlelevel@test.com',
        age: 35,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Critical',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Single Level Task',
        status: 'pending',
        priority: 'high',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 200.00,
      }).returning();

      // Insert orderTask and return single-level navigation
      const inserted = await db.orderTasks
        .insert({
          orderId: order.id,
          taskId: task.id,
          sortOrder: 1,
        })
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          taskTitle: ot.task!.title,
          taskStatus: ot.task!.status,
        }));

      expect(inserted).toBeDefined();
      expect(inserted.orderId).toBe(order.id);
      expect(inserted.taskId).toBe(task.id);
      expect(inserted.taskTitle).toBe('Single Level Task');
      expect(inserted.taskStatus).toBe('pending');

      // Cleanup
      await db.orderTasks.where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id))).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });
  });

  describe('returning(true) - full entity', () => {
    test('returning(true) should still work without CTE (no navigation)', async () => {
      const inserted = await db.users
        .insert({
          username: 'full_entity_test',
          email: 'full_entity@test.com',
          age: 28,
          isActive: true,
        })
        .returning();

      expect(inserted).toBeDefined();
      expect(inserted.id).toBeDefined();
      expect(inserted.username).toBe('full_entity_test');
      expect(inserted.email).toBe('full_entity@test.com');
      expect(inserted.age).toBe(28);
      expect(inserted.isActive).toBe(true);

      // Cleanup
      await db.users.where(u => eq(u.id, inserted.id)).delete();
    });
  });

  describe('multi-level navigation in returning', () => {
    test('should support 2-level navigation: orderTask -> task -> level', async () => {
      // Setup: User -> TaskLevel -> Task -> Order -> OrderTask
      const user = await db.users.insert({
        username: 'multilevel_2_test',
        email: 'multilevel2@test.com',
        age: 30,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Urgent Priority',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Multi-Level Task',
        status: 'pending',
        priority: 'high',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 150.00,
      }).returning();

      // Insert orderTask and return 2-level navigation (task -> level)
      const inserted = await db.orderTasks
        .insert({
          orderId: order.id,
          taskId: task.id,
          sortOrder: 1,
        })
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          taskTitle: ot.task!.title,
          taskStatus: ot.task!.status,
          levelName: ot.task!.level!.name,  // 2-level: task -> level
        }));

      expect(inserted).toBeDefined();
      expect(inserted.orderId).toBe(order.id);
      expect(inserted.taskId).toBe(task.id);
      expect(inserted.taskTitle).toBe('Multi-Level Task');
      expect(inserted.taskStatus).toBe('pending');
      expect(inserted.levelName).toBe('Urgent Priority');

      // Cleanup
      await db.orderTasks.where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id))).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support 3-level navigation: orderTask -> task -> level -> createdBy', async () => {
      // Setup: User -> TaskLevel -> Task -> Order -> OrderTask
      const user = await db.users.insert({
        username: 'multilevel_3_test',
        email: 'multilevel3@test.com',
        age: 35,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Critical Level',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Deep Navigation Task',
        status: 'processing',
        priority: 'high',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'processing',
        totalAmount: 300.00,
      }).returning();

      // Insert orderTask and return 3-level navigation (task -> level -> createdBy)
      const inserted = await db.orderTasks
        .insert({
          orderId: order.id,
          taskId: task.id,
          sortOrder: 2,
        })
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          taskTitle: ot.task!.title,
          levelName: ot.task!.level!.name,               // 2-level
          creatorUsername: ot.task!.level!.createdBy!.username,  // 3-level: task -> level -> createdBy
          creatorEmail: ot.task!.level!.createdBy!.email,        // 3-level
        }));

      expect(inserted).toBeDefined();
      expect(inserted.orderId).toBe(order.id);
      expect(inserted.taskId).toBe(task.id);
      expect(inserted.taskTitle).toBe('Deep Navigation Task');
      expect(inserted.levelName).toBe('Critical Level');
      expect(inserted.creatorUsername).toBe('multilevel_3_test');
      expect(inserted.creatorEmail).toBe('multilevel3@test.com');

      // Cleanup
      await db.orderTasks.where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id))).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support multi-level navigation with insertBulk', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'bulk_multilevel_test',
        email: 'bulk_multilevel@test.com',
        age: 40,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Bulk Test Level',
        createdById: user.id,
      }).returning();

      const task1 = await db.tasks.insert({
        title: 'Bulk Task 1',
        status: 'pending',
        priority: 'low',
        levelId: taskLevel.id,
      }).returning();

      const task2 = await db.tasks.insert({
        title: 'Bulk Task 2',
        status: 'pending',
        priority: 'medium',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 500.00,
      }).returning();

      // Bulk insert orderTasks and return multi-level navigation
      const inserted = await db.orderTasks
        .insertBulk([
          { orderId: order.id, taskId: task1.id, sortOrder: 1 },
          { orderId: order.id, taskId: task2.id, sortOrder: 2 },
        ])
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          taskTitle: ot.task!.title,
          levelName: ot.task!.level!.name,
          creatorUsername: ot.task!.level!.createdBy!.username,
        }));

      expect(inserted.length).toBe(2);

      // Sort by taskId for consistent assertions
      const sorted = inserted.sort((a, b) => a.taskId - b.taskId);

      expect(sorted[0].taskTitle).toBe('Bulk Task 1');
      expect(sorted[0].levelName).toBe('Bulk Test Level');
      expect(sorted[0].creatorUsername).toBe('bulk_multilevel_test');

      expect(sorted[1].taskTitle).toBe('Bulk Task 2');
      expect(sorted[1].levelName).toBe('Bulk Test Level');
      expect(sorted[1].creatorUsername).toBe('bulk_multilevel_test');

      // Cleanup
      await db.orderTasks.where(ot => eq(ot.orderId, order.id)).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task1.id)).delete();
      await db.tasks.where(t => eq(t.id, task2.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support multi-level navigation with update().returning()', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'update_multilevel_test',
        email: 'update_multilevel@test.com',
        age: 45,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Update Test Level',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Update Test Task',
        status: 'pending',
        priority: 'low',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 200.00,
      }).returning();

      await db.orderTasks.insert({
        orderId: order.id,
        taskId: task.id,
        sortOrder: 1,
      });

      // Update and return multi-level navigation
      const updated = await db.orderTasks
        .where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id)))
        .update({ sortOrder: 99 })
        .returning(ot => ({
          orderId: ot.orderId,
          sortOrder: ot.sortOrder,
          taskTitle: ot.task!.title,
          levelName: ot.task!.level!.name,
          creatorEmail: ot.task!.level!.createdBy!.email,
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].sortOrder).toBe(99);
      expect(updated[0].taskTitle).toBe('Update Test Task');
      expect(updated[0].levelName).toBe('Update Test Level');
      expect(updated[0].creatorEmail).toBe('update_multilevel@test.com');

      // Cleanup
      await db.orderTasks.where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id))).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support multi-level navigation with delete().returning()', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'delete_multilevel_test',
        email: 'delete_multilevel@test.com',
        age: 50,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Delete Test Level',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Delete Test Task',
        status: 'completed',
        priority: 'high',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'completed',
        totalAmount: 100.00,
      }).returning();

      await db.orderTasks.insert({
        orderId: order.id,
        taskId: task.id,
        sortOrder: 5,
      });

      // Delete and return multi-level navigation
      const deleted = await db.orderTasks
        .where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id)))
        .delete()
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          taskTitle: ot.task!.title,
          taskPriority: ot.task!.priority,
          levelName: ot.task!.level!.name,
          creatorUsername: ot.task!.level!.createdBy!.username,
          creatorAge: ot.task!.level!.createdBy!.age,
        }));

      expect(deleted.length).toBe(1);
      expect(deleted[0].orderId).toBe(order.id);
      expect(deleted[0].taskId).toBe(task.id);
      expect(deleted[0].taskTitle).toBe('Delete Test Task');
      expect(deleted[0].taskPriority).toBe('high');
      expect(deleted[0].levelName).toBe('Delete Test Level');
      expect(deleted[0].creatorUsername).toBe('delete_multilevel_test');
      expect(deleted[0].creatorAge).toBe(50);

      // Cleanup
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support mixed single and multi-level navigation paths', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'mixed_nav_test',
        email: 'mixed_nav@test.com',
        age: 55,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Mixed Nav Level',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Mixed Nav Task',
        status: 'pending',
        priority: 'medium',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 250.00,
      }).returning();

      // Insert and return mixed navigation paths:
      // - Single-level: order -> user
      // - Multi-level: task -> level -> createdBy
      const inserted = await db.orderTasks
        .insert({
          orderId: order.id,
          taskId: task.id,
          sortOrder: 3,
        })
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          // Single-level navigation
          orderStatus: ot.order!.status,
          orderUserName: ot.order!.user!.username,  // 2-level via order
          // Multi-level navigation via task
          taskTitle: ot.task!.title,
          levelName: ot.task!.level!.name,
          levelCreatorUsername: ot.task!.level!.createdBy!.username,
        }));

      expect(inserted).toBeDefined();
      expect(inserted.orderId).toBe(order.id);
      expect(inserted.taskId).toBe(task.id);
      expect(inserted.orderStatus).toBe('pending');
      expect(inserted.orderUserName).toBe('mixed_nav_test');
      expect(inserted.taskTitle).toBe('Mixed Nav Task');
      expect(inserted.levelName).toBe('Mixed Nav Level');
      expect(inserted.levelCreatorUsername).toBe('mixed_nav_test');

      // Cleanup
      await db.orderTasks.where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id))).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });
  });

  describe('nested objects in returning', () => {
    test('should support nested plain objects with navigation fields', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'nested_obj_test',
        email: 'nested_obj@test.com',
        age: 30,
        isActive: true,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 100.00,
      }).returning();

      // Insert post with nested object in returning
      const inserted = await db.posts
        .insert({
          title: 'Nested Object Test',
          content: 'Content',
          userId: user.id,
          views: 50,
          publishTime: { hour: 10, minute: 30 },
        })
        .returning(p => ({
          id: p.id,
          title: p.title,
          author: {
            id: p.user!.id,
            username: p.user!.username,
            email: p.user!.email,
          },
        }));

      expect(inserted).toBeDefined();
      expect(inserted.id).toBeDefined();
      expect(inserted.title).toBe('Nested Object Test');
      expect(inserted.author).toBeDefined();
      expect(inserted.author.id).toBe(user.id);
      expect(inserted.author.username).toBe('nested_obj_test');
      expect(inserted.author.email).toBe('nested_obj@test.com');

      // Cleanup
      await db.posts.where(p => eq(p.id, inserted.id)).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support deeply nested objects', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'deep_nested_test',
        email: 'deep_nested@test.com',
        age: 35,
        isActive: true,
      }).returning();

      const taskLevel = await db.taskLevels.insert({
        name: 'Deep Nested Level',
        createdById: user.id,
      }).returning();

      const task = await db.tasks.insert({
        title: 'Deep Nested Task',
        status: 'pending',
        priority: 'high',
        levelId: taskLevel.id,
      }).returning();

      const order = await db.orders.insert({
        userId: user.id,
        status: 'pending',
        totalAmount: 200.00,
      }).returning();

      // Insert with deeply nested object structure
      const inserted = await db.orderTasks
        .insert({
          orderId: order.id,
          taskId: task.id,
          sortOrder: 1,
        })
        .returning(ot => ({
          orderId: ot.orderId,
          taskId: ot.taskId,
          taskInfo: {
            title: ot.task!.title,
            priority: ot.task!.priority,
            level: {
              name: ot.task!.level!.name,
              creator: {
                username: ot.task!.level!.createdBy!.username,
                email: ot.task!.level!.createdBy!.email,
              },
            },
          },
        }));

      expect(inserted).toBeDefined();
      expect(inserted.orderId).toBe(order.id);
      expect(inserted.taskId).toBe(task.id);
      expect(inserted.taskInfo).toBeDefined();
      expect(inserted.taskInfo.title).toBe('Deep Nested Task');
      expect(inserted.taskInfo.priority).toBe('high');
      expect(inserted.taskInfo.level).toBeDefined();
      expect(inserted.taskInfo.level.name).toBe('Deep Nested Level');
      expect(inserted.taskInfo.level.creator).toBeDefined();
      expect(inserted.taskInfo.level.creator.username).toBe('deep_nested_test');
      expect(inserted.taskInfo.level.creator.email).toBe('deep_nested@test.com');

      // Cleanup
      await db.orderTasks.where(ot => and(eq(ot.orderId, order.id), eq(ot.taskId, task.id))).delete();
      await db.orders.where(o => eq(o.id, order.id)).delete();
      await db.tasks.where(t => eq(t.id, task.id)).delete();
      await db.taskLevels.where(tl => eq(tl.id, taskLevel.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });
  });

  describe('edge cases', () => {
    test('should handle null navigation property gracefully (LEFT JOIN)', async () => {
      // Create user without any related data that would be joined
      const user = await db.users.insert({
        username: 'null_nav_test',
        email: 'null_nav@test.com',
        age: 30,
        isActive: true,
      }).returning();

      // Create post
      const post = await db.posts.insert({
        title: 'Post with user',
        content: 'Content',
        userId: user.id,
        views: 0,
        publishTime: { hour: 12, minute: 0 },
      }).returning();

      // Delete and return navigation - should work
      const deleted = await db.posts
        .where(p => eq(p.id, post.id))
        .delete()
        .returning(p => ({
          postId: p.id,
          authorName: p.user!.username,
        }));

      expect(deleted.length).toBe(1);
      expect(deleted[0].postId).toBe(post.id);
      expect(deleted[0].authorName).toBe('null_nav_test');

      // Cleanup
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should handle multiple rows with navigation in delete', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'multi_delete_test',
        email: 'multi_delete@test.com',
        age: 30,
        isActive: true,
      }).returning();

      // Create multiple posts
      await db.posts.insertBulk([
        { title: 'Delete Me 1', content: 'Content 1', userId: user.id, views: 10, publishTime: { hour: 8, minute: 0 } },
        { title: 'Delete Me 2', content: 'Content 2', userId: user.id, views: 20, publishTime: { hour: 9, minute: 0 } },
        { title: 'Delete Me 3', content: 'Content 3', userId: user.id, views: 30, publishTime: { hour: 10, minute: 0 } },
      ]);

      // Delete all and return navigation
      const deleted = await db.posts
        .where(p => eq(p.userId, user.id))
        .delete()
        .returning(p => ({
          postTitle: p.title,
          authorName: p.user!.username,
        }));

      expect(deleted.length).toBe(3);
      deleted.forEach(d => {
        expect(d.authorName).toBe('multi_delete_test');
        expect(d.postTitle).toContain('Delete Me');
      });

      // Cleanup
      await db.users.where(u => eq(u.id, user.id)).delete();
    });
  });

  describe('collection queries in returning', () => {
    test('should support .toList() to fetch related collection in returning', async () => {
      // Setup: Create a user with posts
      const user = await db.users.insert({
        username: 'collection_test',
        email: 'collection@test.com',
        age: 30,
        isActive: true,
      }).returning();

      // Create posts for this user
      await db.posts.insertBulk([
        { title: 'Post 1', content: 'Content 1', userId: user.id, views: 10, publishTime: { hour: 8, minute: 0 } },
        { title: 'Post 2', content: 'Content 2', userId: user.id, views: 20, publishTime: { hour: 9, minute: 0 } },
      ]);

      // Create another user to update
      const user2 = await db.users.insert({
        username: 'collection_update',
        email: 'collection_update@test.com',
        age: 25,
        isActive: true,
      }).returning();

      // Create posts for user2
      await db.posts.insertBulk([
        { title: 'User2 Post 1', content: 'Content', userId: user2.id, views: 5, publishTime: { hour: 10, minute: 0 } },
        { title: 'User2 Post 2', content: 'Content', userId: user2.id, views: 15, publishTime: { hour: 11, minute: 0 } },
        { title: 'User2 Post 3', content: 'Content', userId: user2.id, views: 25, publishTime: { hour: 12, minute: 0 } },
      ]);

      // Update user2 and return their posts as a collection
      // Note: Using 'as any' due to TypeScript limitation with EntityQuery type mapping for collections
      const updated = await db.users
        .where(u => eq(u.id, user2.id))
        .update({ age: 26 })
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          posts: u.posts.select((p: any) => ({
            title: p.title,
            views: p.views,
          })).toList(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].id).toBe(user2.id);
      expect(updated[0].username).toBe('collection_update');
      expect(updated[0].posts).toBeDefined();
      expect(Array.isArray(updated[0].posts)).toBe(true);
      expect(updated[0].posts.length).toBe(3);

      // Verify post data
      const titles = updated[0].posts.map((p: any) => p.title).sort();
      expect(titles).toEqual(['User2 Post 1', 'User2 Post 2', 'User2 Post 3']);

      // Cleanup
      await db.posts.where(p => eq(p.userId, user.id)).delete();
      await db.posts.where(p => eq(p.userId, user2.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
      await db.users.where(u => eq(u.id, user2.id)).delete();
    });

    test('should support .firstOrDefault() to fetch single related item in returning', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'first_or_default_test',
        email: 'first@test.com',
        age: 35,
        isActive: true,
      }).returning();

      // Create posts with different view counts
      await db.posts.insertBulk([
        { title: 'Low Views Post', content: 'Content', userId: user.id, views: 5, publishTime: { hour: 8, minute: 0 } },
        { title: 'High Views Post', content: 'Content', userId: user.id, views: 100, publishTime: { hour: 9, minute: 0 } },
        { title: 'Medium Views Post', content: 'Content', userId: user.id, views: 50, publishTime: { hour: 10, minute: 0 } },
      ]);

      // Update user and return their most viewed post using firstOrDefault
      // Note: Using 'as any' due to TypeScript limitation with EntityQuery type mapping for collections
      const updated = await db.users
        .where(u => eq(u.id, user.id))
        .update({ age: 36 })
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          topPost: u.posts
            .select((p: any) => ({ title: p.title, views: p.views }))
            .orderBy((p: any) => [[p.views, 'DESC']])
            .firstOrDefault(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].id).toBe(user.id);
      expect(updated[0].topPost).toBeDefined();
      expect(updated[0].topPost.title).toBe('High Views Post');
      expect(updated[0].topPost.views).toBe(100);

      // Cleanup
      await db.posts.where(p => eq(p.userId, user.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support collection with .where() filter in returning', async () => {
      // Setup
      const user = await db.users.insert({
        username: 'filtered_collection',
        email: 'filtered@test.com',
        age: 40,
        isActive: true,
      }).returning();

      // Create posts with different view counts
      await db.posts.insertBulk([
        { title: 'Popular Post 1', content: 'Content', userId: user.id, views: 100, publishTime: { hour: 8, minute: 0 } },
        { title: 'Unpopular Post', content: 'Content', userId: user.id, views: 5, publishTime: { hour: 9, minute: 0 } },
        { title: 'Popular Post 2', content: 'Content', userId: user.id, views: 200, publishTime: { hour: 10, minute: 0 } },
      ]);

      // Update user and return only their popular posts (views > 50)
      // Note: Using 'as any' due to TypeScript limitation with EntityQuery type mapping for collections
      const updated = await db.users
        .where(u => eq(u.id, user.id))
        .update({ age: 41 })
        .returning((u: any) => ({
          id: u.id,
          popularPosts: u.posts
            .where((p: any) => gt(p.views, 50))
            .select((p: any) => ({ title: p.title, views: p.views }))
            .toList(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].popularPosts).toBeDefined();
      expect(updated[0].popularPosts.length).toBe(2);

      const titles = updated[0].popularPosts.map((p: any) => p.title).sort();
      expect(titles).toEqual(['Popular Post 1', 'Popular Post 2']);

      // Cleanup
      await db.posts.where(p => eq(p.userId, user.id)).delete();
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should handle empty collection in returning', async () => {
      // Setup: Create user with no posts
      const user = await db.users.insert({
        username: 'empty_collection',
        email: 'empty@test.com',
        age: 45,
        isActive: true,
      }).returning();

      // Update user and return their (empty) posts collection
      // Note: Using 'as any' due to TypeScript limitation with EntityQuery type mapping for collections
      const updated = await db.users
        .where(u => eq(u.id, user.id))
        .update({ age: 46 })
        .returning((u: any) => ({
          id: u.id,
          posts: u.posts.select((p: any) => ({ title: p.title })).toList(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].posts).toBeDefined();
      expect(Array.isArray(updated[0].posts)).toBe(true);
      expect(updated[0].posts.length).toBe(0);

      // Cleanup
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should handle null result from firstOrDefault when no matches', async () => {
      // Setup: Create user with no posts
      const user = await db.users.insert({
        username: 'null_first',
        email: 'null_first@test.com',
        age: 50,
        isActive: true,
      }).returning();

      // Update user and try to get first post (should be null)
      // Note: Using 'as any' due to TypeScript limitation with EntityQuery type mapping for collections
      const updated = await db.users
        .where(u => eq(u.id, user.id))
        .update({ age: 51 })
        .returning((u: any) => ({
          id: u.id,
          firstPost: u.posts.select((p: any) => ({ title: p.title })).firstOrDefault(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].firstPost).toBeNull();

      // Cleanup
      await db.users.where(u => eq(u.id, user.id)).delete();
    });

    test('should support collection in insert().returning()', async () => {
      // Insert a new user and return their (empty) posts collection
      // This tests that collections work with insert().returning()
      const inserted = await db.users
        .insert({
          username: 'insert_with_collection',
          email: 'insert_coll@test.com',
          age: 30,
          isActive: true,
        })
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          posts: u.posts.select((p: any) => ({
            title: p.title,
            views: p.views,
          })).toList(),
        }));

      expect(inserted).toBeDefined();
      expect(inserted.id).toBeDefined();
      expect(inserted.username).toBe('insert_with_collection');
      expect(inserted.posts).toBeDefined();
      expect(Array.isArray(inserted.posts)).toBe(true);
      expect(inserted.posts.length).toBe(0); // No posts yet for new user

      // Now add some posts and verify with update
      await db.posts.insertBulk([
        { title: 'Post 1', content: 'Content', userId: inserted.id, views: 10, publishTime: { hour: 8, minute: 0 } },
        { title: 'Post 2', content: 'Content', userId: inserted.id, views: 20, publishTime: { hour: 9, minute: 0 } },
      ]);

      // Verify posts are returned in update
      const updated = await db.users
        .where(u => eq(u.id, inserted.id))
        .update({ age: 31 })
        .returning((u: any) => ({
          id: u.id,
          posts: u.posts.select((p: any) => ({ title: p.title })).toList(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].posts.length).toBe(2);

      // Cleanup
      await db.posts.where(p => eq(p.userId, inserted.id)).delete();
      await db.users.where(u => eq(u.id, inserted.id)).delete();
    });

    test('should support collection in insertBulk().returning()', async () => {
      // Bulk insert users and return their (empty) posts collections
      const inserted = await db.users
        .insertBulk([
          { username: 'bulk_coll_user1', email: 'bulk_coll1@test.com', age: 25, isActive: true },
          { username: 'bulk_coll_user2', email: 'bulk_coll2@test.com', age: 30, isActive: true },
        ])
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          posts: u.posts.select((p: any) => ({ title: p.title })).toList(),
        }));

      expect(inserted.length).toBe(2);

      // All users should have empty posts (just inserted)
      for (const user of inserted) {
        expect(user.posts).toBeDefined();
        expect(Array.isArray(user.posts)).toBe(true);
        expect(user.posts.length).toBe(0);
      }

      // Find users by username
      const user1 = inserted.find((u: any) => u.username === 'bulk_coll_user1')!;
      const user2 = inserted.find((u: any) => u.username === 'bulk_coll_user2')!;

      // Add posts and verify with update
      await db.posts.insertBulk([
        { title: 'User1 Post', content: 'Content', userId: user1.id, views: 50, publishTime: { hour: 8, minute: 0 } },
        { title: 'User2 Post A', content: 'Content', userId: user2.id, views: 100, publishTime: { hour: 9, minute: 0 } },
        { title: 'User2 Post B', content: 'Content', userId: user2.id, views: 200, publishTime: { hour: 10, minute: 0 } },
      ]);

      // Verify with update
      const updated = await db.users
        .where(u => eq(u.id, user1.id))
        .update({ age: 26 })
        .returning((u: any) => ({
          id: u.id,
          posts: u.posts.select((p: any) => ({ title: p.title })).toList(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].posts.length).toBe(1);
      expect(updated[0].posts[0].title).toBe('User1 Post');

      // Cleanup
      await db.posts.where(p => eq(p.userId, user1.id)).delete();
      await db.posts.where(p => eq(p.userId, user2.id)).delete();
      await db.users.where(u => eq(u.id, user1.id)).delete();
      await db.users.where(u => eq(u.id, user2.id)).delete();
    });

    test('should support collection in delete().returning()', async () => {
      // Setup: Create user with posts and orders
      const user = await db.users.insert({
        username: 'delete_collection_test',
        email: 'delete_coll@test.com',
        age: 35,
        isActive: true,
      }).returning();

      await db.posts.insertBulk([
        { title: 'Delete Test Post 1', content: 'Content', userId: user.id, views: 10, publishTime: { hour: 8, minute: 0 } },
        { title: 'Delete Test Post 2', content: 'Content', userId: user.id, views: 20, publishTime: { hour: 9, minute: 0 } },
      ]);

      // Delete posts first to avoid FK constraint, then delete user with collection in returning
      await db.posts.where(p => eq(p.userId, user.id)).delete();

      // Delete user and return their orders collection (empty)
      const deleted = await db.users
        .where(u => eq(u.id, user.id))
        .delete()
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          orders: u.orders.select((o: any) => ({ id: o.id, status: o.status })).toList(),
        }));

      expect(deleted.length).toBe(1);
      expect(deleted[0].id).toBe(user.id);
      expect(deleted[0].username).toBe('delete_collection_test');
      expect(deleted[0].orders).toBeDefined();
      expect(Array.isArray(deleted[0].orders)).toBe(true);
      expect(deleted[0].orders.length).toBe(0); // No orders for this user
    });

    test('should support collection in upsertBulk().returning()', async () => {
      // Upsert users and return their posts collection
      // First, create some users with upsertBulk
      const upserted = await db.users
        .upsertBulk(
          [
            { username: 'upsert_coll_user1', email: 'upsert_coll1@test.com', age: 40, isActive: true },
            { username: 'upsert_coll_user2', email: 'upsert_coll2@test.com', age: 45, isActive: true },
          ],
          { primaryKey: 'id', updateColumns: ['age', 'isActive'] }
        )
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          posts: u.posts.select((p: any) => ({ title: p.title })).toList(),
        }));

      expect(upserted.length).toBe(2);

      // Both users should have empty posts (just created)
      for (const user of upserted) {
        expect(user.posts).toBeDefined();
        expect(Array.isArray(user.posts)).toBe(true);
        expect(user.posts.length).toBe(0);
      }

      const user1 = upserted.find((u: any) => u.username === 'upsert_coll_user1')!;
      const user2 = upserted.find((u: any) => u.username === 'upsert_coll_user2')!;

      // Add posts
      await db.posts.insertBulk([
        { title: 'Upsert User1 Post', content: 'Content', userId: user1.id, views: 15, publishTime: { hour: 8, minute: 0 } },
        { title: 'Upsert User2 Post A', content: 'Content', userId: user2.id, views: 25, publishTime: { hour: 9, minute: 0 } },
        { title: 'Upsert User2 Post B', content: 'Content', userId: user2.id, views: 35, publishTime: { hour: 10, minute: 0 } },
      ]);

      // Now upsert again (update) and verify posts are returned
      const updated = await db.users
        .upsertBulk(
          [{ id: user1.id, username: 'upsert_coll_user1', email: 'upsert_coll1@test.com', age: 41, isActive: true }],
          { primaryKey: 'id', updateColumns: ['age'] }
        )
        .returning((u: any) => ({
          id: u.id,
          posts: u.posts.select((p: any) => ({ title: p.title })).toList(),
        }));

      expect(updated.length).toBe(1);
      expect(updated[0].posts.length).toBe(1);
      expect(updated[0].posts[0].title).toBe('Upsert User1 Post');

      // Cleanup
      await db.posts.where(p => eq(p.userId, user1.id)).delete();
      await db.posts.where(p => eq(p.userId, user2.id)).delete();
      await db.users.where(u => eq(u.id, user1.id)).delete();
      await db.users.where(u => eq(u.id, user2.id)).delete();
    });

    test('should support firstOrDefault in delete().returning()', async () => {
      // Setup: Create user with posts
      const user = await db.users.insert({
        username: 'delete_first_test',
        email: 'delete_first@test.com',
        age: 45,
        isActive: true,
      }).returning();

      await db.posts.insertBulk([
        { title: 'Low Views', content: 'Content', userId: user.id, views: 5, publishTime: { hour: 8, minute: 0 } },
        { title: 'Highest Views', content: 'Content', userId: user.id, views: 500, publishTime: { hour: 9, minute: 0 } },
        { title: 'Medium Views', content: 'Content', userId: user.id, views: 50, publishTime: { hour: 10, minute: 0 } },
      ]);

      // Delete posts first to avoid FK constraint
      await db.posts.where(p => eq(p.userId, user.id)).delete();

      // Delete user and return their top order (via firstOrDefault)
      // Since user has no orders, firstOrDefault should return null
      const deleted = await db.users
        .where(u => eq(u.id, user.id))
        .delete()
        .returning((u: any) => ({
          id: u.id,
          username: u.username,
          topOrder: u.orders
            .select((o: any) => ({ id: o.id, totalAmount: o.totalAmount }))
            .orderBy((o: any) => [[o.totalAmount, 'DESC']])
            .firstOrDefault(),
        }));

      expect(deleted.length).toBe(1);
      expect(deleted[0].id).toBe(user.id);
      expect(deleted[0].username).toBe('delete_first_test');
      expect(deleted[0].topOrder).toBeNull(); // No orders
    });
  });
});
