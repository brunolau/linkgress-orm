
import { DbContext, DbEntityTable, DbModelConfig, integer, varchar, boolean, timestamp, jsonb, decimal, text, smallint, sql, pgEnum, enumColumn } from "../../src";
import { Order } from "../model/order";
import { Post } from "../model/post";
import { User } from "../model/user";
import { Task } from "../model/task";
import { SchemaUser } from "../model/schema-user";
import { SchemaPost } from "../model/schema-post";
import { pgHourMinute } from "../types/hour-minute";
import { pgIntDatetime } from "../types/int-datetime";

// Define PostgreSQL ENUM types
const orderStatusEnum = pgEnum('order_status', ['pending', 'processing', 'completed', 'cancelled', 'refunded'] as const);
const postCategoryEnum = pgEnum('post_category', ['tech', 'lifestyle', 'business', 'entertainment'] as const);
const taskStatusEnum = pgEnum('task_status', ['pending', 'processing', 'completed', 'cancelled'] as const);
const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high'] as const);

/**
 * Database context with strongly-typed table accessors
 */
export class AppDatabase extends DbContext {
    get users(): DbEntityTable<User> {
        return this.table(User);
    }

    get posts(): DbEntityTable<Post> {
        return this.table(Post);
    }

    get orders(): DbEntityTable<Order> {
        return this.table(Order);
    }

    get tasks(): DbEntityTable<Task> {
        return this.table(Task);
    }

    get schemaUsers(): DbEntityTable<SchemaUser> {
        return this.table(SchemaUser);
    }

    get schemaPosts(): DbEntityTable<SchemaPost> {
        return this.table(SchemaPost);
    }

    protected override setupModel(model: DbModelConfig): void {
        // Configure User entity
        model.entity(User, entity => {
            entity.toTable('users');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_id_seq' }));
            entity.property(e => e.username).hasType(varchar('username', 100)).isRequired().isUnique();
            entity.property(e => e.email).hasType(text('email')).isRequired();
            entity.property(e => e.age).hasType(integer('age'));
            entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);
            entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
            entity.property(e => e.metadata).hasType(jsonb('metadata'));

            entity.hasMany(e => e.posts, () => Post)
                .withForeignKey(p => sql`${p.userId}`)
                .withPrincipalKey(u => u.id);

            entity.hasMany(e => e.orders, () => Order)
                .withForeignKey(o => o.userId)
                .withPrincipalKey(u => u.id);
        });

        // Configure Post entity
        model.entity(Post, entity => {
            entity.toTable('posts');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'posts_id_seq' }));
            entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
            entity.property(e => e.subtitle).hasType(varchar('subtitle', 200));
            entity.property(e => e.content).hasType(text('content'));
            entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
            entity.property(e => e.publishedAt).hasType(timestamp('published_at')).hasDefaultValue('NOW()');
            entity.property(e => e.views).hasType(integer('views')).hasDefaultValue(0);
            entity.property(e => e.publishTime).hasType(smallint('publish_time')).hasCustomMapper(pgHourMinute);
            entity.property(e => e.customDate).hasType(integer('custom_date')).hasCustomMapper(pgIntDatetime);
            entity.property(e => e.category).hasType(enumColumn('category', postCategoryEnum)).hasDefaultValue('tech');

            entity.hasOne(e => e.user, () => User)
                .withForeignKey(p => p.userId)
                .withPrincipalKey(u => sql`${u.id}`)
                .onDelete('cascade')
                .onUpdate('no action')
                .hasDbName('FK_posts_users_user_id')
                .isRequired();

            // Add an index on userId and publishedAt for better query performance
            entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]);
        });

        // Configure Order entity
        model.entity(Order, entity => {
            entity.toTable('orders');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'orders_id_seq' }));
            entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
            entity.property(e => e.status).hasType(enumColumn('status', orderStatusEnum)).hasDefaultValue('pending');
            entity.property(e => e.totalAmount).hasType(decimal('total_amount', 10, 2)).isRequired();
            entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
            entity.property(e => e.items).hasType(jsonb('items'));

            entity.hasOne(e => e.user, () => User)
                .withForeignKey(o => o.userId)
                .withPrincipalKey(u => u.id)
                .onDelete('cascade')
                .isRequired();

            // Add composite index for efficient filtering by user and status
            entity.hasIndex('IX_Orders_UserId_Status', e => [e.userId, e.status]);

            // Add index on createdAt for date-based queries
            entity.hasIndex('IX_Orders_CreatedAt', e => [e.createdAt]);
        });

        // Configure Task entity
        model.entity(Task, entity => {
            entity.toTable('tasks');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'tasks_id_seq' }));
            entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
            entity.property(e => e.status).hasType(enumColumn('status', taskStatusEnum)).isRequired();
            entity.property(e => e.priority).hasType(enumColumn('priority', taskPriorityEnum)).isRequired();
        });

        // Configure SchemaUser entity (in auth schema)
        model.entity(SchemaUser, entity => {
            entity.toTable('schema_users');
            entity.toSchema('auth');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'schema_users_id_seq' }));
            entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
            entity.property(e => e.email).hasType(text('email')).isRequired();
            entity.property(e => e.isActive).hasType(boolean('is_active')).hasDefaultValue(true);

            entity.hasMany(e => e.posts as any, () => SchemaPost)
                .withForeignKey(p => p.userId)
                .withPrincipalKey(u => u.id);
        });

        // Configure SchemaPost entity (in public schema, references auth.schema_users)
        model.entity(SchemaPost, entity => {
            entity.toTable('schema_posts');
            // Posts in public schema (default)

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'schema_posts_id_seq' }));
            entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
            entity.property(e => e.userId).hasType(integer('user_id')).isRequired();

            entity.hasOne(e => e.user, () => SchemaUser)
                .withForeignKey(p => p.userId)
                .withPrincipalKey(u => u.id)
                .onDelete('cascade')
                .isRequired();
        });
    }
}
