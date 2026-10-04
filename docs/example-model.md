# Example Model and Seed Data

> **For agents:** Which tables, columns, relations, indexes and seed rows does `AppDatabase`, the model every docs example queries, have?
> **Use this page when:** an example names a table, column or relation you need to look up (`productTags.sortOrder`, `postComments.postId`), a result comment depends on the seed values, or you want to rebuild the example database to run a docs example yourself. **Look elsewhere when:** declaring your own model → [Schema Configuration](./guides/schema-configuration.md); picking a query for a data need → [Choosing the Right Query](./choosing-the-right-query.md)
> **Key APIs:** `db.users`, `db.posts`, `db.postComments`, `db.orders`, `db.orderTasks`, `db.tasks`, `db.taskLevels`, `db.products`, `db.productPrices`, `db.productTags`, `db.tags`, `db.carts`, `db.cartItems`

In every example `db` is `new AppDatabase(client)`, the model of the repository's test suite
([`debug/schema/appDatabase.ts`](https://github.com/brunolau/linkgress-orm/blob/main/debug/schema/appDatabase.ts), entity
classes in [`debug/model/`](https://github.com/brunolau/linkgress-orm/tree/main/debug/model); neither ships in the npm
package, so this page describes them). Queries read property names (`userId`); the SQL uses column names
(`"user_id"`). [Schema Configuration](./guides/schema-configuration.md#complete-example-the-core-of-the-docs-model) shows
the code of its six core entities.

## Contents

- [Find a table](#find-a-table)
- [Look up a table's columns, keys and indexes](#look-up-a-tables-columns-keys-and-indexes)
- [Follow the relations: navigations and collections](#follow-the-relations-navigations-and-collections)
- [Know the seed rows the result comments show](#know-the-seed-rows-the-result-comments-show)
- [Rebuild the example database](#rebuild-the-example-database)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Find a table

| Getter | Class | Table | Primary key | Seed rows |
|---|---|---|---|---|
| `db.users` | `User` | `users` | `id` | 3 |
| `db.posts` | `Post` | `posts` | `id` | 3 |
| `db.postComments` | `PostComment` | `post_comments` | `id` | 3 |
| `db.orders` | `Order` | `orders` | `id` | 2 |
| `db.orderTasks` | `OrderTask` | `order_task` | (`order_id`, `task_id`) | 2 |
| `db.tasks` | `Task` | `tasks` | `id` | 2 |
| `db.taskLevels` | `TaskLevel` | `task_levels` | `id` | 2 |
| `db.products` | `Product` | `products` | `id` | 2 |
| `db.productPrices` | `ProductPrice` | `product_prices` | `id` | 3 |
| `db.productTags` | `ProductTag` | `product_tags` | (`product_id`, `tag_id`) | 3 |
| `db.tags` | `Tag` | `tags` | `id` | 3 |
| `db.carts` | `Cart` | `carts` | `id` | 2 |
| `db.cartItems` | `CartItem` | `cart_items` | `id` | 3 |

Every `id` is `integer GENERATED ALWAYS AS IDENTITY`: an insert leaves it out, and `.returning()` reads it.

The model has ten more tables, which the docs use only where a feature needs them: `db.capacityGroups`
(`capacity_groups`) and `db.productPriceCapacityGroups` (`product_price_capacity_groups`, the grandchildren of
`selectMany()` examples), `db.registryItems` (`registry_items`, `mergeBulk()` without a unique index), `db.schemaUsers`
and `db.schemaPosts` (`auth.schema_users`, `schema_posts`: tables in another schema), `db.typeZoo` (`type_zoo`: one
nullable column per column type), `db.discounts`, `db.discountCodes`, `db.discountProducts` and `db.cartDiscountCodes`.
`db.getSchemaManager().ensureCreated()` creates all 23 tables in 35 statements: the schema `auth`, 4 enum checks and 4
`CREATE TYPE`, 23 `CREATE TABLE`, 3 `CREATE INDEX`.

## Look up a table's columns, keys and indexes

Type, NULL and DEFAULT are the DDL `ensureCreated()` sends. A `decimal` column is declared `number` but reads as a
string at the top level on `PgClient`, `PostgresClient` and `PGliteClient` (`'99.99'`) and as a number inside a
collection item.

### `users`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `id` | `id` | `integer` | identity, primary key |
| `username` | `username` | `varchar(100)` | NOT NULL, UNIQUE (constraint `users_username_key`) |
| `email` | `email` | `text` | NOT NULL |
| `age` | `age` | `integer` | nullable |
| `isActive` | `is_active` | `boolean` | DEFAULT TRUE |
| `createdAt` | `created_at` | `timestamp` | DEFAULT NOW() |
| `metadata` | `metadata` | `jsonb` | nullable |
| `lastActiveAt` | `last_active_at` | `integer` | nullable; custom mapper: a `Date` stored as seconds since 2025-01-01T00:00:00Z |

Collections: `posts`, `orders`.

### `posts`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `id` | `id` | `integer` | identity, primary key |
| `title` | `title` | `varchar(200)` | NOT NULL |
| `subtitle` | `subtitle` | `varchar(200)` | nullable |
| `content` | `content` | `text` | nullable |
| `userId` | `user_id` | `integer` | NOT NULL; `FK_posts_users_user_id` → `users.id` ON DELETE CASCADE |
| `publishedAt` | `published_at` | `timestamp` | DEFAULT NOW() |
| `views` | `views` | `integer` | DEFAULT 0 |
| `publishTime` | `publish_time` | `smallint` | nullable; custom mapper: `{ hour, minute }` stored as minutes since midnight (`{ hour: 9, minute: 30 }` is `570`) |
| `customDate` | `custom_date` | `integer` | nullable; custom mapper: a `Date`, as `users.last_active_at` |
| `stringStampedAt` | `string_stamped_at` | `timestamp` | nullable; custom mapper (test-only) |
| `category` | `category` | enum `post_category`: `tech`, `lifestyle`, `business`, `entertainment` | DEFAULT `'tech'` |

Navigation: `user`. Collection: `postComments`. Index: `ix_posts_query` on (`user_id`, `published_at`).

### `post_comments`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `id` | `id` | `integer` | identity, primary key |
| `postId` | `post_id` | `integer` | NOT NULL; → `posts.id` ON DELETE CASCADE; no index |
| `orderId` | `order_id` | `integer` | NOT NULL; → `orders.id` ON DELETE CASCADE; no index |
| `comment` | `comment` | `text` | NOT NULL |

Navigations: `post`, `order`.

### `orders`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `id` | `id` | `integer` | identity, primary key |
| `userId` | `user_id` | `integer` | NOT NULL; → `users.id` ON DELETE CASCADE |
| `status` | `status` | enum `order_status`: `pending`, `processing`, `completed`, `cancelled`, `refunded` | DEFAULT `'pending'` |
| `totalAmount` | `total_amount` | `decimal(10, 2)` | NOT NULL |
| `createdAt` | `created_at` | `timestamp` | DEFAULT NOW() |
| `items` | `items` | `jsonb` | nullable |

Navigation: `user`. Collection: `orderTasks`. Indexes: `IX_Orders_UserId_Status` on (`user_id`, `status`),
`IX_Orders_CreatedAt` on (`created_at`).

### `order_task`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `orderId` | `order_id` | `integer` | primary key part; → `orders.id` ON DELETE CASCADE |
| `taskId` | `task_id` | `integer` | primary key part; → `tasks.id` ON DELETE CASCADE |
| `sortOrder` | `sort_order` | `integer` | nullable |

Navigations: `order`, `task`. It links orders to tasks (many-to-many).

### `tasks`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `id` | `id` | `integer` | identity, primary key |
| `title` | `title` | `varchar(200)` | NOT NULL |
| `status` | `status` | enum `task_status`: `pending`, `processing`, `completed`, `cancelled` | NOT NULL |
| `priority` | `priority` | enum `task_priority`: `low`, `medium`, `high` | NOT NULL |
| `levelId` | `level_id` | `integer` | nullable; → `task_levels.id` ON DELETE CASCADE |

Navigation: `level`.

### `task_levels`

| Property | Column | Type | Constraints · default |
|---|---|---|---|
| `id` | `id` | `integer` | identity, primary key |
| `name` | `name` | `varchar(100)` | NOT NULL |
| `createdById` | `created_by_id` | `integer` | NOT NULL; → `users.id` ON DELETE CASCADE |

Navigation: `createdBy`.

### `products`, `product_prices`, `product_tags`, `tags`

| Table | Property | Column | Type | Constraints · default |
|---|---|---|---|---|
| `products` | `id` | `id` | `integer` | identity, primary key |
| `products` | `name` | `name` | `varchar(200)` | NOT NULL |
| `products` | `active` | `active` | `boolean` | DEFAULT TRUE |
| `product_prices` | `id` | `id` | `integer` | identity, primary key |
| `product_prices` | `productId` | `product_id` | `integer` | NOT NULL; → `products.id` ON DELETE CASCADE; no index |
| `product_prices` | `seasonId` | `season_id` | `integer` | NOT NULL |
| `product_prices` | `price` | `price` | `decimal(10, 2)` | NOT NULL |
| `product_tags` | `productId` | `product_id` | `integer` | primary key part; → `products.id` ON DELETE CASCADE |
| `product_tags` | `tagId` | `tag_id` | `integer` | primary key part; → `tags.id` ON DELETE CASCADE |
| `product_tags` | `sortOrder` | `sort_order` | `integer` | DEFAULT 0 |
| `tags` | `id` | `id` | `integer` | identity, primary key |
| `tags` | `name` | `name` | `varchar(100)` | NOT NULL; no unique index |

`products` has the collections `productPrices` and `productTags`; `product_prices` the navigation `product` (and the
collection `productPriceCapacityGroups`); `product_tags`, the many-to-many link of products and tags, the navigations
`product` and `tag`. `tags` has no relation of its own.

### `carts`, `cart_items`

| Table | Property | Column | Type | Constraints · default |
|---|---|---|---|---|
| `carts` | `id` | `id` | `integer` | identity, primary key |
| `carts` | `uuid` | `uuid` | `varchar(36)` | NOT NULL, UNIQUE |
| `cart_items` | `id` | `id` | `integer` | identity, primary key |
| `cart_items` | `cartId` | `cart_id` | `integer` | NOT NULL; → `carts.id` ON DELETE CASCADE; no index |
| `cart_items` | `productId` | `product_id` | `integer` | NOT NULL; no foreign key and no navigation to `products` |

`carts` has the collections `cartItems` (and `cartDiscountCodes`); `cart_items` the navigation `cart`. Reading a cart
item's product name takes a join or a scalar subquery
([Subqueries](./guides/subquery-guide.md#project-a-per-row-value-a-scalar-subquery-in-select)).

## Follow the relations: navigations and collections

A navigation declared `.isRequired()` renders `INNER JOIN`, any other `LEFT JOIN`; each hop joins under its relation
name. A walk over four navigations of `order_task`:

```ts
const lines = await db.orderTasks
  .orderBy(ot => ot.orderId)
  .select(ot => ({
    orderId: ot.orderId,
    task: ot.task!.title,
    level: ot.task!.level!.name,
    status: ot.order!.status,
    customer: ot.order!.user!.username,
  }))
  .toList();
// [{ orderId: 1, task: 'Important Task', level: 'High Priority', status: 'completed', customer: 'alice' },
//  { orderId: 2, task: 'Regular Task', level: 'Low Priority', status: 'pending', customer: 'bob' }]
```

```sql
SELECT "order_task"."order_id" as "orderId", "task"."title" as "task", "level"."name" as "level", "order"."status" as "status", "user"."username" as "customer"
FROM "order_task"
LEFT JOIN "tasks" AS "task" ON "order_task"."task_id" = "task"."id"
LEFT JOIN "orders" AS "order" ON "order_task"."order_id" = "order"."id"
LEFT JOIN "task_levels" AS "level" ON "task"."level_id" = "level"."id"
INNER JOIN "users" AS "user" ON "order"."user_id" = "user"."id"
ORDER BY "orderId" ASC
```

| Navigation | Target | Join | Kind |
|---|---|---|---|
| `Post.user` | `users` | `"posts"."user_id" = "user"."id"` | INNER (required) |
| `Order.user` | `users` | `"orders"."user_id" = "user"."id"` | INNER (required) |
| `PostComment.post` | `posts` | `"post_comments"."post_id" = "post"."id"` | LEFT |
| `PostComment.order` | `orders` | `"post_comments"."order_id" = "order"."id"` | LEFT |
| `OrderTask.order` | `orders` | `"order_task"."order_id" = "order"."id"` | LEFT |
| `OrderTask.task` | `tasks` | `"order_task"."task_id" = "task"."id"` | LEFT |
| `Task.level` | `task_levels` | `"tasks"."level_id" = "level"."id"` | LEFT |
| `TaskLevel.createdBy` | `users` | `"task_levels"."created_by_id" = "createdBy"."id"` | LEFT |
| `ProductPrice.product` | `products` | `"product_prices"."product_id" = "product"."id"` | LEFT |
| `ProductTag.product` | `products` | `"product_tags"."product_id" = "product"."id"` | LEFT |
| `ProductTag.tag` | `tags` | `"product_tags"."tag_id" = "tag"."id"` | LEFT |
| `CartItem.cart` | `carts` | `"cart_items"."cart_id" = "cart"."id"` | LEFT |

| Collection | Items | Foreign key | Index that serves it |
|---|---|---|---|
| `User.posts` | `posts` | `posts.user_id` | `ix_posts_query` (its first column) |
| `User.orders` | `orders` | `orders.user_id` | `IX_Orders_UserId_Status` (its first column) |
| `Post.postComments` | `post_comments` | `post_comments.post_id` | none |
| `Order.orderTasks` | `order_task` | `order_task.order_id` | the primary key (its first column) |
| `Product.productPrices` | `product_prices` | `product_prices.product_id` | none |
| `Product.productTags` | `product_tags` | `product_tags.product_id` | the primary key (its first column) |
| `Cart.cartItems` | `cart_items` | `cart_items.cart_id` | none |

Many-to-many relations go through their link table: products and tags through `productTags`
(`p.productTags!.select(pt => pt.tag!.name).toList()`), orders and tasks through `orderTasks`
([Querying](./guides/querying.md#many-to-many-and-grandchildren-selectmany)).

## Know the seed rows the result comments show

The examples run on an empty database seeded with these rows, inserted in this order, so the generated ids are the
ones shown. `created_at` / `published_at` hold the seeding time; `users.metadata`, `orders.items`, `posts.subtitle`
and `posts.string_stamped_at` are NULL (an example that needs a document stores one first and says so).

`users`

| id | username | email | age | isActive | lastActiveAt |
|---|---|---|---|---|---|
| 1 | alice | alice@test.com | 25 | true | 2025-03-15T08:00:00Z |
| 2 | bob | bob@test.com | 35 | true | 2025-06-20T14:30:00Z |
| 3 | charlie | charlie@test.com | 45 | false | 2025-01-10T22:00:00Z |

`posts` (every `category` is `tech`)

| id | title | content | userId | views | publishTime | customDate |
|---|---|---|---|---|---|---|
| 1 | Alice Post 1 | Content from Alice | 1 | 100 | `{ hour: 9, minute: 30 }` | 2024-01-15T10:00:00Z |
| 2 | Alice Post 2 | More content from Alice | 1 | 150 | `{ hour: 14, minute: 0 }` | 2024-01-16T10:00:00Z |
| 3 | Bob Post | Content from Bob | 2 | 200 | `{ hour: 18, minute: 45 }` | 2024-01-15T10:00:00Z |

`orders`, `post_comments`

| id | userId | status | totalAmount |
|---|---|---|---|
| 1 | 1 | completed | 99.99 |
| 2 | 2 | pending | 149.99 |

| id | postId | orderId | comment |
|---|---|---|---|
| 1 | 1 | 1 | Related to order |
| 2 | 2 | 2 | Mentions another order |
| 3 | 3 | 2 | My order update |

`task_levels`, `tasks`, `order_task`

| id | name | createdById |
|---|---|---|
| 1 | High Priority | 1 |
| 2 | Low Priority | 2 |

| id | title | status | priority | levelId |
|---|---|---|---|---|
| 1 | Important Task | pending | high | 1 |
| 2 | Regular Task | processing | medium | 2 |

| orderId | taskId | sortOrder |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 1 |

`tags`, `products`, `product_prices`, `product_tags`

| id | name (`tags`) |
|---|---|
| 1 | Summer |
| 2 | Winter |
| 3 | Family |

| id | name (`products`) | active |
|---|---|---|
| 1 | Hardback | true |
| 2 | Lift Ticket | true |

| id | productId | seasonId | price |
|---|---|---|---|
| 1 | 1 | 1 | 100.00 |
| 2 | 1 | 2 | 50.00 |
| 3 | 2 | 1 | 75.00 |

| productId | tagId | sortOrder |
|---|---|---|
| 1 | 2 (Winter) | 1 |
| 1 | 3 (Family) | 2 |
| 2 | 1 (Summer) | 1 |

`carts`, `cart_items`

| id | uuid |
|---|---|
| 1 | cart-uuid-a |
| 2 | cart-uuid-b |

| id | cartId | productId |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 1 | 2 |
| 3 | 2 | 1 |

The facts most result comments rest on: alice has 2 posts (100 + 150 = 250 views) and 1 completed order of 99.99;
bob 1 post (200 views) and 1 pending order of 149.99; charlie is inactive, with no posts and no orders; the 3 posts
hold 450 views. Hardback carries the tags Winter and Family, Lift Ticket the tag Summer.

The repository's seed also fills the test-only tables: capacity groups Adult, Child and Senior (prices 1 and 2 carry
Adult, price 1 also Child, price 3 Senior), discounts `SUMMER10` and `WINTER20` with their codes and products, and the
discount codes of both carts. `registry_items` stays empty.

## Rebuild the example database

To run a docs example yourself: the repository's `AppDatabase` on the in-memory database, created with
`ensureCreated()` and seeded with the rows above. `seedExampleRows()` fills the 13 tables of this page, 1 statement per
table; the repository's own seed is `seedTestData()` in
[`tests/utils/test-database.ts`](https://github.com/brunolau/linkgress-orm/blob/main/tests/utils/test-database.ts).

```ts
import { createInMemoryDatabase, PgClient } from 'linkgress-orm';
import { AppDatabase } from './schema/appDatabase';   // the repository's debug/schema/appDatabase.ts

const memory = createInMemoryDatabase();
const db = new AppDatabase(new PgClient(memory.pgPoolConfig()));
await db.getSchemaManager().ensureCreated();   // 35 statements
await seedExampleRows(db);                     // 13 statements

// RETURNING order is not guaranteed: generated keys are looked up by a natural key.
async function seedExampleRows(db: AppDatabase): Promise<void> {
  const users = await db.users.insertBulk([
    { username: 'alice', email: 'alice@test.com', age: 25, isActive: true, lastActiveAt: new Date('2025-03-15T08:00:00Z') },
    { username: 'bob', email: 'bob@test.com', age: 35, isActive: true, lastActiveAt: new Date('2025-06-20T14:30:00Z') },
    { username: 'charlie', email: 'charlie@test.com', age: 45, isActive: false, lastActiveAt: new Date('2025-01-10T22:00:00Z') },
  ]).returning(u => ({ id: u.id, key: u.username }));
  const user = (key: string) => users.find(r => r.key === key)!.id;

  const posts = await db.posts.insertBulk([
    { title: 'Alice Post 1', content: 'Content from Alice', userId: user('alice'), views: 100, customDate: new Date('2024-01-15T10:00:00Z'), publishTime: { hour: 9, minute: 30 } },
    { title: 'Alice Post 2', content: 'More content from Alice', userId: user('alice'), views: 150, customDate: new Date('2024-01-16T10:00:00Z'), publishTime: { hour: 14, minute: 0 } },
    { title: 'Bob Post', content: 'Content from Bob', userId: user('bob'), views: 200, customDate: new Date('2024-01-15T10:00:00Z'), publishTime: { hour: 18, minute: 45 } },
  ]).returning(p => ({ id: p.id, key: p.title }));
  const post = (key: string) => posts.find(r => r.key === key)!.id;

  const orders = await db.orders.insertBulk([
    { userId: user('alice'), status: 'completed', totalAmount: 99.99 },
    { userId: user('bob'), status: 'pending', totalAmount: 149.99 },
  ]).returning(o => ({ id: o.id, key: o.userId }));
  const orderOf = (userKey: string) => orders.find(r => r.key === user(userKey))!.id;

  const levels = await db.taskLevels.insertBulk([
    { name: 'High Priority', createdById: user('alice') },
    { name: 'Low Priority', createdById: user('bob') },
  ]).returning(l => ({ id: l.id, key: l.name }));
  const level = (key: string) => levels.find(r => r.key === key)!.id;

  const tasks = await db.tasks.insertBulk([
    { title: 'Important Task', status: 'pending', priority: 'high', levelId: level('High Priority') },
    { title: 'Regular Task', status: 'processing', priority: 'medium', levelId: level('Low Priority') },
  ]).returning(t => ({ id: t.id, key: t.title }));
  const task = (key: string) => tasks.find(r => r.key === key)!.id;

  await db.orderTasks.insertBulk([
    { orderId: orderOf('alice'), taskId: task('Important Task'), sortOrder: 1 },
    { orderId: orderOf('bob'), taskId: task('Regular Task'), sortOrder: 1 },
  ]);
  await db.postComments.insertBulk([
    { postId: post('Alice Post 1'), orderId: orderOf('alice'), comment: 'Related to order' },
    { postId: post('Alice Post 2'), orderId: orderOf('bob'), comment: 'Mentions another order' },
    { postId: post('Bob Post'), orderId: orderOf('bob'), comment: 'My order update' },
  ]);

  const tags = await db.tags.insertBulk([{ name: 'Summer' }, { name: 'Winter' }, { name: 'Family' }])
    .returning(t => ({ id: t.id, key: t.name }));
  const tag = (key: string) => tags.find(r => r.key === key)!.id;
  const products = await db.products.insertBulk([{ name: 'Hardback', active: true }, { name: 'Lift Ticket', active: true }])
    .returning(p => ({ id: p.id, key: p.name }));
  const product = (key: string) => products.find(r => r.key === key)!.id;

  await db.productPrices.insertBulk([
    { productId: product('Hardback'), seasonId: 1, price: 100 },
    { productId: product('Hardback'), seasonId: 2, price: 50 },
    { productId: product('Lift Ticket'), seasonId: 1, price: 75 },
  ]);
  await db.productTags.insertBulk([
    { productId: product('Hardback'), tagId: tag('Winter'), sortOrder: 1 },
    { productId: product('Hardback'), tagId: tag('Family'), sortOrder: 2 },
    { productId: product('Lift Ticket'), tagId: tag('Summer'), sortOrder: 1 },
  ]);

  const carts = await db.carts.insertBulk([{ uuid: 'cart-uuid-a' }, { uuid: 'cart-uuid-b' }])
    .returning(c => ({ id: c.id, key: c.uuid }));
  const cart = (key: string) => carts.find(r => r.key === key)!.id;
  await db.cartItems.insertBulk([
    { cartId: cart('cart-uuid-a'), productId: product('Hardback') },
    { cartId: cart('cart-uuid-a'), productId: product('Lift Ticket') },
    { cartId: cart('cart-uuid-b'), productId: product('Hardback') },
  ]);
}
```

The first statement it sends (the mapped `lastActiveAt` binds seconds since 2025-01-01):

```sql
INSERT INTO "users" ("username", "email", "age", "is_active", "last_active_at") VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ($11, $12, $13, $14, $15) RETURNING "id" AS "id", "username" AS "key"
-- params: [ "alice", "alice@test.com", 25, true, 6336000, "bob", "bob@test.com", 35, true, 14740200, "charlie", "charlie@test.com", 45, false, 856800 ]
```

Run on that database, the examples return the result comments the docs show; a write example that runs after other
writes sees later ids.

## Pitfalls

- **Don't** write a column name where a query reads a property (`p.user_id`) → **Do** use the property (`p.userId`);
  the column names appear only in the SQL.
- **Don't** read `cartItem.product` → **Do** join `products` or project a scalar subquery: `cart_items.product_id` has
  no navigation and no foreign key.
- **Don't** expect `orders.totalAmount` and `productPrices.price` to read as numbers at the top level → **Do**
  convert them where you read them (or aggregate with `agg.sum()`): the drivers deliver `decimal` as a string (`'99.99'`).
- **Don't** read `t.level!.name` and expect every task → **Do** remember `tasks.level_id` is nullable and `Task.level`
  optional: a LEFT JOIN, so a task without a level reads `undefined` there, and a filter on `level.name` drops it.
- **Don't** copy the example model's unindexed foreign keys (`post_comments.post_id`, `product_prices.product_id`,
  `cart_items.cart_id`) → **Do** index every foreign key a collection reads in your own model
  ([Schema Configuration](./guides/schema-configuration.md#index-what-your-queries-filter-join-and-sort-on-hasindex)).

## See also

- [Schema Configuration](./guides/schema-configuration.md) — how such a model is declared: columns, relations, indexes, enums, custom mappers.
- [Choosing the Right Query](./choosing-the-right-query.md) — the queries the docs run on this model, by data need.
- [Querying](./guides/querying.md) — navigations, collections and many-to-many reads over these relations.
- [In-Memory Database](./guides/in-memory-database.md) — the database the docs' SQL was captured on.
- [Getting Started](./getting-started.md) — a two-table slice of this model, from install to the first queries.
