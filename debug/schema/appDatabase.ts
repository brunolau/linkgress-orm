
import { DbContext, DbEntityTable, DbModelConfig, integer, varchar, boolean, timestamp, jsonb, decimal, text, smallint, sql, pgEnum, enumColumn } from "../../src";
import { Order } from "../model/order";
import { Post } from "../model/post";
import { User } from "../model/user";
import { Task } from "../model/task";
import { TaskLevel } from "../model/taskLevel";
import { SchemaUser } from "../model/schema-user";
import { SchemaPost } from "../model/schema-post";
import { pgHourMinute } from "../types/hour-minute";
import { pgIntDatetime } from "../types/int-datetime";
import { OrderTask } from "../model/orderTask";
import { PostComment } from "../model/postComment";
// New entities for testing sibling collection isolation (complex ecommerce pattern)
import { Product } from "../model/product";
import { ProductPrice } from "../model/productPrice";
import { ProductPriceCapacityGroup } from "../model/productPriceCapacityGroup";
import { CapacityGroup } from "../model/capacityGroup";
import { Tag } from "../model/tag";
import { ProductTag } from "../model/productTag";

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

    get orderTasks(): DbEntityTable<OrderTask> {
        return this.table(OrderTask);
    }

    get tasks(): DbEntityTable<Task> {
        return this.table(Task);
    }

    get taskLevels(): DbEntityTable<TaskLevel> {
        return this.table(TaskLevel);
    }

    get schemaUsers(): DbEntityTable<SchemaUser> {
        return this.table(SchemaUser);
    }

    get schemaPosts(): DbEntityTable<SchemaPost> {
        return this.table(SchemaPost);
    }

    get postComments(): DbEntityTable<PostComment> {
        return this.table(PostComment);
    }

    // New tables for testing sibling collection isolation (complex ecommerce pattern)
    get products(): DbEntityTable<Product> {
        return this.table(Product);
    }

    get productPrices(): DbEntityTable<ProductPrice> {
        return this.table(ProductPrice);
    }

    get productPriceCapacityGroups(): DbEntityTable<ProductPriceCapacityGroup> {
        return this.table(ProductPriceCapacityGroup);
    }

    get capacityGroups(): DbEntityTable<CapacityGroup> {
        return this.table(CapacityGroup);
    }

    get tags(): DbEntityTable<Tag> {
        return this.table(Tag);
    }

    get productTags(): DbEntityTable<ProductTag> {
        return this.table(ProductTag);
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
            entity.property(e => e.category).hasType(enumColumn('category', postCategoryEnum)).hasDefaultValue(`'tech'`);

            entity.hasOne(e => e.user, () => User)
                .withForeignKey(p => p.userId)
                .withPrincipalKey(u => sql`${u.id}`)
                .onDelete('cascade')
                .onUpdate('no action')
                .hasDbName('FK_posts_users_user_id')
                .isRequired();

            entity.hasMany(e => e.postComments, () => PostComment)
                .withForeignKey(pc => pc.postId)
                .withPrincipalKey(p => p.id);

            // Add an index on userId and publishedAt for better query performance
            entity.hasIndex('ix_posts_query', e => [e.userId, e.publishedAt]);
        });

        // Configure PostComment entity (links posts to orders for testing sibling collection isolation)
        model.entity(PostComment, entity => {
            entity.toTable('post_comments');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'post_comments_id_seq' }));
            entity.property(e => e.postId).hasType(integer('post_id')).isRequired();
            entity.property(e => e.orderId).hasType(integer('order_id')).isRequired();
            entity.property(e => e.comment).hasType(text('comment')).isRequired();

            entity.hasOne(e => e.post, () => Post)
                .withForeignKey(pc => pc.postId)
                .withPrincipalKey(p => p.id)
                .onDelete('cascade');

            entity.hasOne(e => e.order, () => Order)
                .withForeignKey(pc => pc.orderId)
                .withPrincipalKey(o => o.id)
                .onDelete('cascade');
        });

        // Configure Order entity
        model.entity(Order, entity => {
            entity.toTable('orders');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'orders_id_seq' }));
            entity.property(e => e.userId).hasType(integer('user_id')).isRequired();
            entity.property(e => e.status).hasType(enumColumn('status', orderStatusEnum)).hasDefaultValue(`'pending'`);
            entity.property(e => e.totalAmount).hasType(decimal('total_amount', 10, 2)).isRequired();
            entity.property(e => e.createdAt).hasType(timestamp('created_at')).hasDefaultValue('NOW()');
            entity.property(e => e.items).hasType(jsonb('items'));

            entity.hasOne(e => e.user, () => User)
                .withForeignKey(o => o.userId)
                .withPrincipalKey(u => u.id)
                .onDelete('cascade')
                .isRequired();

            entity.hasMany(e => e.orderTasks, () => OrderTask)
                .withForeignKey(e => e.orderId)
                .withPrincipalKey(e => e.id);

            // Add composite index for efficient filtering by user and status
            entity.hasIndex('IX_Orders_UserId_Status', e => [e.userId, e.status]);

            // Add index on createdAt for date-based queries
            entity.hasIndex('IX_Orders_CreatedAt', e => [e.createdAt]);
        });

        model.entity(OrderTask, (entity) => {
            entity.toTable('order_task');

            entity.property(e => e.orderId).hasType(integer('order_id')).isPrimaryKey();
            entity.property(e => e.taskId).hasType(integer('task_id')).isPrimaryKey();
            entity.property(e => e.sortOrder).hasType(integer('sort_order'));

            entity.hasOne(e => e.order, () => Order)
                .withForeignKey(e => e.orderId)
                .withPrincipalKey(e => e.id)
                .onDelete('cascade');

            entity.hasOne(e => e.task, () => Task)
                .withForeignKey(e => e.taskId)
                .withPrincipalKey(e => e.id)
                .onDelete('cascade');
        });

        // Configure TaskLevel entity
        model.entity(TaskLevel, entity => {
            entity.toTable('task_levels');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'task_levels_id_seq' }));
            entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
            entity.property(e => e.createdById).hasType(integer('created_by_id')).isRequired();

            entity.hasOne(e => e.createdBy, () => User)
                .withForeignKey(e => e.createdById)
                .withPrincipalKey(u => u.id)
                .onDelete('cascade');
        });

        // Configure Task entity
        model.entity(Task, entity => {
            entity.toTable('tasks');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'tasks_id_seq' }));
            entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
            entity.property(e => e.status).hasType(enumColumn('status', taskStatusEnum)).isRequired();
            entity.property(e => e.priority).hasType(enumColumn('priority', taskPriorityEnum)).isRequired();
            entity.property(e => e.levelId).hasType(integer('level_id'));

            entity.hasOne(e => e.level, () => TaskLevel)
                .withForeignKey(e => sql`${e.levelId}`)
                .withPrincipalKey(l => l.id)
                .onDelete('cascade');
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

        // ============ NEW ENTITIES FOR SIBLING COLLECTION ISOLATION TEST ============
        // These mirror a complex ecommerce schema pattern that triggers the bug

        // Configure Product entity
        model.entity(Product, entity => {
            entity.toTable('products');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'products_id_seq' }));
            entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
            entity.property(e => e.active).hasType(boolean('active')).hasDefaultValue(true);

            entity.hasMany(e => e.productPrices, () => ProductPrice)
                .withForeignKey(pp => pp.productId)
                .withPrincipalKey(p => p.id);

            entity.hasMany(e => e.productTags, () => ProductTag)
                .withForeignKey(pt => pt.productId)
                .withPrincipalKey(p => p.id);
        });

        // Configure ProductPrice entity
        model.entity(ProductPrice, entity => {
            entity.toTable('product_prices');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'product_prices_id_seq' }));
            entity.property(e => e.productId).hasType(integer('product_id')).isRequired();
            entity.property(e => e.seasonId).hasType(integer('season_id')).isRequired();
            entity.property(e => e.price).hasType(decimal('price', 10, 2)).isRequired();

            entity.hasOne(e => e.product, () => Product)
                .withForeignKey(pp => pp.productId)
                .withPrincipalKey(p => p.id)
                .onDelete('cascade');

            entity.hasMany(e => e.productPriceCapacityGroups, () => ProductPriceCapacityGroup)
                .withForeignKey(ppcg => ppcg.productPriceId)
                .withPrincipalKey(pp => pp.id);
        });

        // Configure ProductPriceCapacityGroup entity (join table)
        model.entity(ProductPriceCapacityGroup, entity => {
            entity.toTable('product_price_capacity_groups');

            entity.property(e => e.productPriceId).hasType(integer('product_price_id')).isPrimaryKey();
            entity.property(e => e.capacityGroupId).hasType(integer('capacity_group_id')).isPrimaryKey();

            entity.hasOne(e => e.productPrice, () => ProductPrice)
                .withForeignKey(ppcg => ppcg.productPriceId)
                .withPrincipalKey(pp => pp.id)
                .onDelete('cascade');

            entity.hasOne(e => e.capacityGroup, () => CapacityGroup)
                .withForeignKey(ppcg => ppcg.capacityGroupId)
                .withPrincipalKey(cg => cg.id)
                .onDelete('cascade');
        });

        // Configure CapacityGroup entity
        model.entity(CapacityGroup, entity => {
            entity.toTable('capacity_groups');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'capacity_groups_id_seq' }));
            entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
        });

        // Configure Tag entity
        model.entity(Tag, entity => {
            entity.toTable('tags');

            entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'tags_id_seq' }));
            entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
        });

        // Configure ProductTag entity (join table linking products to tags)
        model.entity(ProductTag, entity => {
            entity.toTable('product_tags');

            entity.property(e => e.productId).hasType(integer('product_id')).isPrimaryKey();
            entity.property(e => e.tagId).hasType(integer('tag_id')).isPrimaryKey();
            entity.property(e => e.sortOrder).hasType(integer('sort_order')).hasDefaultValue(0);

            entity.hasOne(e => e.product, () => Product)
                .withForeignKey(pt => pt.productId)
                .withPrincipalKey(p => p.id)
                .onDelete('cascade');

            entity.hasOne(e => e.tag, () => Tag)
                .withForeignKey(pt => pt.tagId)
                .withPrincipalKey(t => t.id)
                .onDelete('cascade');
        });
    }
}
