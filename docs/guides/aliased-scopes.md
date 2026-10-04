# Aliased Subquery Scopes

> **For agents:** How to write a correlated subquery over tables under explicit aliases with `db.<table>.as(alias)`, turned into ONE fragment (`(SELECT …)`, `EXISTS (…)`, `(NOT EXISTS (…))`) that goes wherever a fragment goes; the tool for same-table correlations and top-1 lookups with joins.
> **Use this page when:** a subquery reads the same table as the outer row (another post of the same author), you need a per-row top-1 value or aggregate with joins or a condition sort key, or an existence probe inside an UPDATE, a CTE body, a collection item, a HAVING, a `MutationBatch` row guard or another scope. **Look elsewhere when:** a navigation models the relation → [Subqueries](./subquery-guide.md) (`exists(u.posts!…)`, `u.posts!.count()`); you need several columns of the matched row → a collection's `firstOrDefault()` ([Subqueries](./subquery-guide.md#read-several-columns-of-the-same-related-row-use-a-collection)).
> **Key APIs:** `db.<table>.as(alias)`, `AliasedScope`: `innerJoin()`, `leftJoin()`, `where()`, `orderBy()`, `limit()`, `scalar()`, `exists()`, `notExists()`, `row` · **Round trips:** 0 of its own: a scope renders inside the enclosing statement (1 round trip in total).

## Contents

- [Choose a scope or another tool](#choose-a-scope-or-another-tool)
- [Test for another row of the same table: `exists()`](#test-for-another-row-of-the-same-table-exists)
- [Read the top value per row: `orderBy()` + `limit(1)` + `scalar()`](#read-the-top-value-per-row-orderby--limit1--scalar)
- [Aggregate per row: `scalar(() => agg.count())`](#aggregate-per-row-scalar--aggcount)
- [Join tables inside the probe: `innerJoin()` / `leftJoin()`](#join-tables-inside-the-probe-innerjoin--leftjoin)
- [Keep rows without a match: `notExists()`](#keep-rows-without-a-match-notexists)
- [Reuse one scope for several probes](#reuse-one-scope-for-several-probes)
- [Read the outer row's navigations](#read-the-outer-rows-navigations)
- [Use a scope anywhere a fragment goes](#use-a-scope-anywhere-a-fragment-goes)
- [How a scope renders](#how-a-scope-renders)
- [How a scope reads back](#how-a-scope-reads-back)
- [What a scope refuses](#what-a-scope-refuses)
- [Pitfalls](#pitfalls)
- [See also](#see-also)

## Choose a scope or another tool

A scope is the typed spelling of a hand-written `EXISTS (SELECT 1 FROM "t" AS x WHERE x."col" = …)`. Its table renders under the alias you give it, never under a name the ORM generates (a `<table>_0` join counter, a navigation named like the table), so with a private alias it neither borrows nor shadows an alias of the enclosing statement: the same scope renders correctly inside a LATERAL collection, a CTE body, an UPDATE, a row guard and a `QueryBatch` leg, and it covers the same-table correlation that `db.<table>.where(…).asSubquery()` refuses.

| Need | Use | SQL shape · round trips | Avoid |
|---|---|---|---|
| A probe over the outer row's own table | `db.posts.as('rival').where(…).exists()` | `EXISTS (SELECT 1 FROM "posts" AS "rival" WHERE …)` · 1 | `db.posts.where(…).asSubquery()` (refused for a same-table correlation) |
| A per-row top-1 value | `.orderBy(…).limit(1).scalar(x => x.col)` | `(SELECT "p2"."title" FROM "posts" AS "p2" … ORDER BY … LIMIT 1)` · 1 | one scope per column of the same row |
| A per-row aggregate no navigation models, or over joined tables | `.scalar(() => agg.count())` | `(SELECT count(*) FROM …)` · 1 | a scope where `u.posts!.count()` works |
| Joins inside the probe | `.innerJoin(db.users.as('au'), …)` / `.leftJoin(…)` | `… INNER JOIN "users" AS "au" ON …` · 1 | a navigation on a scope row (refused) |
| Several columns of the matched row | a collection's `firstOrDefault()`, or a join | `LEFT JOIN LATERAL (… LIMIT 1)` (`lateral`), a `ROW_NUMBER()` CTE (`cte`) · 1 | one `scalar()` per column |
| A navigation models the relation | `exists(u.posts!.where(…))`, `u.posts!.count()` ([Subqueries](./subquery-guide.md)) | `EXISTS (SELECT 1 FROM "posts" …)` · 1 | a scope (longer; no collection-strategy choice) |

## Test for another row of the same table: `exists()`

`exists()` renders `EXISTS (SELECT 1 FROM "<table>" AS "<alias>" WHERE …)`. Inside `where()` the callback's row is the scope's row; every other column it reads (`p.userId`) is a correlation to the enclosing statement.

```ts
import { and, eq, gt } from 'linkgress-orm';

const rows = await db.posts
  .select(p => ({
    title: p.title,
    // Does another post of the same author have more views? A same-table correlation.
    outranked: db.posts.as('rival')
      .where(r => and(eq(r.userId, p.userId), gt(r.views, p.views)))
      .exists(),
  }))
  .orderBy(p => p.title)
  .toList();
// [{ title: 'Alice Post 1', outranked: true }, { title: 'Alice Post 2', outranked: false }, { title: 'Bob Post', outranked: false }]
```

```sql
SELECT "posts"."title" as "title", EXISTS (SELECT 1 FROM "posts" AS "rival" WHERE ("rival"."user_id" = "posts"."user_id" AND "rival"."views" > "posts"."views")) as "outranked"
FROM "posts"
ORDER BY "title" ASC
```

The same probe as a WHERE condition: `db.posts.where(p => db.posts.as('rival').where(…).exists())`. Without the scope, `db.posts.where(p2 => …).asSubquery()` correlated to `p` is refused: both sides would render as `"posts"` and the correlation would compare the inner row with itself (see [Subqueries over the outer row's own table](./subquery-guide.md#subqueries-over-the-outer-rows-own-table)).

> **Efficiency:** the same plan as a hand-written correlated `EXISTS`: it stops at the first matching row, and PostgreSQL can plan it in a WHERE as a semi-join. Index the correlation column (`posts.user_id` here).

## Read the top value per row: `orderBy()` + `limit(1)` + `scalar()`

`scalar(selection)` renders `(SELECT <selection> FROM … [ORDER BY …] [LIMIT n])`. `orderBy()` takes `[key, 'ASC' | 'DESC']` pairs; `limit(n)` renders an inline integer.

```ts
import { eq } from 'linkgress-orm';

const top = await db.users
  .select(u => ({
    username: u.username,
    topPost: db.posts.as('p2')
      .where(p => eq(p.userId, u.id))
      .orderBy(p => [[p.views, 'DESC']])
      .limit(1)
      .scalar(p => p.title),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', topPost: 'Alice Post 2' }, { username: 'bob', topPost: 'Bob Post' }, { username: 'charlie', topPost: undefined }]
```

```sql
SELECT "users"."username" as "username", (SELECT "p2"."title" FROM "posts" AS "p2" WHERE "p2"."user_id" = "users"."id" ORDER BY "p2"."views" DESC LIMIT 1) as "topPost"
FROM "users"
ORDER BY "username" ASC
```

When no row qualifies the value is NULL, which a mapper-less column reads as `undefined` at the top level (see [How a scope reads back](#how-a-scope-reads-back)).

> **Pitfall:** `scalar()` adds no `LIMIT`. A probe that matches several rows without `limit(1)` (or an aggregate) fails with `more than one row returned by a subquery used as an expression`.

## Aggregate per row: `scalar(() => agg.count())`

An aggregate over no rows gives its own value: `count(*)` is `0`, not NULL.

```ts
import { agg, eq } from 'linkgress-orm';

const counts = await db.users
  .select(u => ({
    username: u.username,
    postCount: db.posts.as('p2').where(p => eq(p.userId, u.id)).scalar(() => agg.count()),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', postCount: 2 }, { username: 'bob', postCount: 1 }, { username: 'charlie', postCount: 0 }]
```

```sql
SELECT "users"."username" as "username", (SELECT count(*) FROM "posts" AS "p2" WHERE "p2"."user_id" = "users"."id") as "postCount"
FROM "users"
ORDER BY "username" ASC
```

When the model has the navigation, `u.posts!.count()` returns the same values and follows the [collection strategy](../collection-strategies.md); a scope pays off when the aggregate needs joins or a table no navigation reaches.

> **Efficiency:** a correlated scalar runs once per outer row: fine for a page, costly over a whole table. For all rows of a large table, join a grouped `'table'` subquery ([Join a derived table](./subquery-guide.md#join-a-derived-table-innerjoin--leftjoin-with-a-table-subquery)).

## Join tables inside the probe: `innerJoin()` / `leftJoin()`

`innerJoin(db.<other>.as(alias), on)` / `leftJoin(…)` add `INNER JOIN` / `LEFT JOIN "<table>" AS "<alias>" ON <on>`. The `on` callback and every later callback receive one row per table, in join order. Several `where()` calls are AND-combined; a condition used as a sort key renders parenthesized.

```ts
import { and, eq, gt, literal } from 'linkgress-orm';

const pick = await db.posts
  .select(p => ({
    title: p.title,
    // the title of the least-viewed post above 50 views by an active user, bob's posts first
    pick: db.posts.as('p2')
      .innerJoin(db.users.as('au'), (q, a) => eq(a.id, q.userId))
      .where((_q, a) => eq(a.isActive, literal(true)))
      .where(q => gt(q.views, 50))
      .orderBy((q, a) => [[eq(a.username, 'bob'), 'DESC'], [q.views, 'ASC']])
      .limit(1)
      .scalar(q => q.title),
  }))
  .orderBy(p => p.title)
  .toList();
// every row: pick = 'Bob Post'
```

```sql
SELECT "posts"."title" as "title", (SELECT "p2"."title" FROM "posts" AS "p2" INNER JOIN "users" AS "au" ON "au"."id" = "p2"."user_id" WHERE ("au"."is_active" = TRUE AND "p2"."views" > $1) ORDER BY ("au"."username" = $2) DESC, "p2"."views" ASC LIMIT 1) as "pick"
FROM "posts"
ORDER BY "title" ASC
-- params: [50, "bob"]
```

`literal(true)` renders inline (`TRUE`); a plain value binds a parameter (`$2` for `'bob'`).

`leftJoin` keeps the left rows without a match; the joined row's columns are NULL then. Comments received per author, `0` for an author without comments:

```ts
import { agg, eq } from 'linkgress-orm';

const received = await db.users
  .select(u => ({
    username: u.username,
    comments: db.posts.as('p3')
      .leftJoin(db.postComments.as('c3'), (p, c) => eq(c.postId, p.id))
      .where(p => eq(p.userId, u.id))
      .scalar((_p, c) => agg.count(c.id)),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', comments: 2 }, { username: 'bob', comments: 1 }, { username: 'charlie', comments: 0 }]
```

```sql
SELECT "users"."username" as "username", (SELECT count("c3"."id") FROM "posts" AS "p3" LEFT JOIN "post_comments" AS "c3" ON "c3"."post_id" = "p3"."id" WHERE "p3"."user_id" = "users"."id") as "comments"
FROM "users"
ORDER BY "username" ASC
```

`leftJoin` + `isNull` on the joined key is an anti-join inside the probe:

```ts
import { and, eq, isNull } from 'linkgress-orm';

// Users with a post nobody commented on
const uncommented = await db.users
  .where(u => db.posts.as('p4')
    .leftJoin(db.postComments.as('c4'), (p, c) => eq(c.postId, p.id))
    .where((p, c) => and(eq(p.userId, u.id), isNull(c.id)))
    .exists())
  .select(u => ({ username: u.username }))
  .toList();
// [] (every seeded post has a comment)
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE EXISTS (SELECT 1 FROM "posts" AS "p4" LEFT JOIN "post_comments" AS "c4" ON "c4"."post_id" = "p4"."id" WHERE ("p4"."user_id" = "users"."id" AND "c4"."id" IS NULL))
```

The joined scope must be a bare table scope (`db.<table>.as(alias)`): write its filters in the `on` predicate or in `where()`.

## Keep rows without a match: `notExists()`

`notExists()` renders `(NOT EXISTS (SELECT 1 …))`, parenthesized so it stays one operand under `IS`, a comparison, `IN` or `BETWEEN`.

```ts
import { and, eq, gt } from 'linkgress-orm';

// Users without a post above 120 views
const quiet = await db.users
  .where(u => db.posts.as('p5').where(p => and(eq(p.userId, u.id), gt(p.views, 120))).notExists())
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'charlie' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (NOT EXISTS (SELECT 1 FROM "posts" AS "p5" WHERE ("p5"."user_id" = "users"."id" AND "p5"."views" > $1)))
-- params: [120]
```

## Reuse one scope for several probes

Every method returns a NEW scope and leaves the one it was called on unchanged. One base scope can feed two probes, or both legs of an `or()`:

```ts
import { and, eq, gt, lt, or } from 'linkgress-orm';

const authored = db.posts.as('p6');

const extremes = await db.users
  .where(u => or(
    authored.where(p => and(eq(p.userId, u.id), gt(p.views, 180))).exists(),
    authored.where(p => and(eq(p.userId, u.id), lt(p.views, 120))).exists(),
  ))
  .select(u => ({ username: u.username }))
  .toList();
// [{ username: 'alice' }, { username: 'bob' }]
```

```sql
SELECT "users"."username" as "username"
FROM "users"
WHERE (EXISTS (SELECT 1 FROM "posts" AS "p6" WHERE ("p6"."user_id" = "users"."id" AND "p6"."views" > $1)) OR EXISTS (SELECT 1 FROM "posts" AS "p6" WHERE ("p6"."user_id" = "users"."id" AND "p6"."views" < $2)))
-- params: [180, 120]
```

## Read the outer row's navigations

A scope's fragment reports exactly its outer refs (`getFieldRefs()`), so the enclosing query joins the navigations those refs need, at any depth. A nested scope contributes its own outer refs, already filtered. The scope's own aliases never reach the enclosing query.

```ts
import { eq } from 'linkgress-orm';

const creators = await db.tasks
  .select(t => ({
    title: t.title,
    creatorAge: db.users.as('u2').where(u => eq(u.id, t.level!.createdBy!.id)).scalar(u => u.age),
  }))
  .orderBy(t => t.title)
  .toList();
// [{ title: 'Important Task', creatorAge: 25 }, { title: 'Regular Task', creatorAge: 35 }]
```

```sql
SELECT "tasks"."title" as "title", (SELECT "u2"."age" FROM "users" AS "u2" WHERE "u2"."id" = "createdBy"."id") as "creatorAge"
FROM "tasks"
LEFT JOIN "task_levels" AS "level" ON "tasks"."level_id" = "level"."id"
LEFT JOIN "users" AS "createdBy" ON "level"."created_by_id" = "createdBy"."id"
ORDER BY "title" ASC
```

## Use a scope anywhere a fragment goes

A scope renders with the enclosing statement's build context: parameters continue its numbering, and an outer column renders the way it renders anywhere in that statement (a LATERAL collection's item under its lateral alias, the column of an `UPDATE` under its table, a grouping key under its derived table). So the same scope works in a projection, a WHERE, a CASE, an ORDER BY, a HAVING, an `UPDATE … SET` / `WHERE`, a CTE body, a collection item, a `QueryBatch` leg, a `MutationBatch` row guard and another scope.

**In a collection item**, correlated to the item (here under the default `lateral` strategy; the `cte` strategy renders it inside its CTE body with the same results):

```ts
import { and, eq, ne } from 'linkgress-orm';

const withRivals = await db.users
  .select(u => ({
    username: u.username,
    posts: u.posts!.select(p => ({
      title: p.title,
      rival: db.posts.as('p2').where(q => and(eq(q.userId, p.userId), ne(q.id, p.id))).scalar(q => q.title),
    })).toList('posts'),
  }))
  .orderBy(u => u.username)
  .toList();
// alice: [{ title: 'Alice Post 1', rival: 'Alice Post 2' }, { title: 'Alice Post 2', rival: 'Alice Post 1' }]
// bob:   [{ title: 'Bob Post', rival: null }]   (NULL inside a collection item reads null)
```

```sql
SELECT "users"."username" as "username", COALESCE("lateral_0".data, '[]'::json) as "posts"
FROM "users"
LEFT JOIN LATERAL (SELECT json_agg(
  json_build_object('title', "title", 'rival', "rival")
) as data
FROM (
  SELECT "lateral_0_posts"."title" as "title", (SELECT "p2"."title" FROM "posts" AS "p2" WHERE ("p2"."user_id" = "lateral_0_posts"."user_id" AND "p2"."id" != "lateral_0_posts"."id")) as "rival"
  FROM "posts" "lateral_0_posts"
  WHERE "lateral_0_posts"."user_id" = "users"."id"
) sub) "lateral_0" ON true
ORDER BY "username" ASC
```

**In a CTE body:**

```ts
import { DbCteBuilder, eq } from 'linkgress-orm';

const cteBuilder = new DbCteBuilder();
const flags = cteBuilder.with('author_flags', db.users.select(u => ({
  id: u.id,
  hasPosts: db.posts.as('p2').where(p => eq(p.userId, u.id)).exists(),
})));
const flagRows = await db.selectFromCte(flags.cte).select(f => ({ id: f.id, hasPosts: f.hasPosts })).orderBy(f => f.id).toList();
// [{ id: 1, hasPosts: true }, { id: 2, hasPosts: true }, { id: 3, hasPosts: false }]
```

```sql
WITH "author_flags" AS (SELECT "users"."id" as "id", EXISTS (SELECT 1 FROM "posts" AS "p2" WHERE "p2"."user_id" = "users"."id") as "hasPosts"
FROM "users")
SELECT "author_flags"."id" as "id", "author_flags"."hasPosts" as "hasPosts"
FROM "author_flags"
ORDER BY "id" ASC
```

**In a HAVING**, reading the grouping key (it renders qualified by the grouped derived table, never as the scope's own column):

```ts
import { add, and, eq, gt } from 'linkgress-orm';

const having = await db.posts
  .select(p => ({ userId: p.userId }))
  .groupBy(p => ({ id: add(p.userId, 0) }))
  .having(g => db.users.as('u2').where(u => and(eq(u.id, g.key.id), gt(u.age, 30))).exists())
  .select(g => ({ uid: g.key.id, n: g.count() }))
  .toList();
// [{ uid: 2, n: 1 }]
```

```sql
SELECT "q1"."id" as "uid", CAST(COUNT(*) AS INTEGER) as "n"
FROM (SELECT ("posts"."user_id" + $1) as "id"
FROM "posts") "q1"
GROUP BY "id"
HAVING EXISTS (SELECT 1 FROM "users" AS "u2" WHERE ("u2"."id" = "q1"."id" AND "u2"."age" > $2))
-- params: [0, 30]
```

**Inside another scope** (the inner scope correlates to the outer scope's row):

```ts
import { eq } from 'linkgress-orm';

const best = await db.users
  .select(u => ({
    username: u.username,
    best: db.users.as('u2')
      .where(v => eq(v.id, u.id))
      .scalar(v => db.posts.as('p2').where(p => eq(p.userId, v.id)).orderBy(p => [[p.views, 'DESC']]).limit(1).scalar(p => p.title)),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', best: 'Alice Post 2' }, { username: 'bob', best: 'Bob Post' }, { username: 'charlie', best: undefined }]
```

```sql
SELECT "users"."username" as "username", (SELECT (SELECT "p2"."title" FROM "posts" AS "p2" WHERE "p2"."user_id" = "u2"."id" ORDER BY "p2"."views" DESC LIMIT 1) FROM "users" AS "u2" WHERE "u2"."id" = "users"."id") as "best"
FROM "users"
ORDER BY "username" ASC
```

**An entity subquery inside a scope** reads the scope's row as a correlation, even when the scope's alias equals one of that query's navigations: a scope row carries an identity of its own, not only an alias name. (Resolved by alias name alone, it used to be that query's own navigation, joined inside it and compared with itself.) Here the alias `user` is also the posts' navigation to users, and no second `"user"` is joined:

```ts
import { and, eq, exists, gt, literal } from 'linkgress-orm';

const hot = await db.users
  .select(u => ({
    username: u.username,
    hot: db.users.as('user')
      .where(s => and(
        eq(s.id, u.id),
        exists(db.posts.where(p => and(eq(p.userId, s.id), gt(p.views, 180))).select(() => ({ one: literal(1) })).asSubquery()),
      ))
      .exists(),
  }))
  .orderBy(u => u.username)
  .toList();
// [{ username: 'alice', hot: false }, { username: 'bob', hot: true }, { username: 'charlie', hot: false }]
```

```sql
SELECT "users"."username" as "username", EXISTS (SELECT 1 FROM "users" AS "user" WHERE ("user"."id" = "users"."id" AND EXISTS (SELECT 1 as "one"
FROM "posts"
WHERE ("posts"."user_id" = "user"."id" AND "posts"."views" > $1)))) as "hot"
FROM "users"
ORDER BY "username" ASC
-- params: [180]
```

**In an UPDATE** WHERE and SET, correlated to the updated row, its parameters numbered with the statement's:

```ts
import { agg, and, eq, gt } from 'linkgress-orm';

await db.users
  .where(u => and(gt(u.age, 20), db.posts.as('p2').where(p => and(eq(p.userId, u.id), gt(p.views, 120))).exists()))
  .update({ age: 99 });

await db.users
  .where(u => eq(u.username, 'charlie'))
  .update(u => ({ age: db.posts.as('p2').where(p => eq(p.userId, u.id)).scalar(() => agg.count()) }));
```

```sql
UPDATE "users" SET "age" = $1 WHERE ("users"."age" > $2 AND EXISTS (SELECT 1 FROM "posts" AS "p2" WHERE ("p2"."user_id" = "users"."id" AND "p2"."views" > $3)))
-- params: [99, 20, 120]
```

```sql
UPDATE "users" SET "age" = (SELECT count(*) FROM "posts" AS "p2" WHERE "p2"."user_id" = "users"."id") WHERE "users"."username" = $1
-- params: ["charlie"]
```

**In a `MutationBatch` row guard**, correlated to the candidate row `v`: insert a title only when its author has no post of that title yet (see [`rowGuard`](./insert-update-guide.md#insert-only-the-rows-that-pass-a-per-row-check-rowguard)):

```ts
import { MutationBatch, and, eq } from 'linkgress-orm';

const batch = new MutationBatch();
batch.addInsertBulk(db.posts, [
  { title: 'Alice Post 1', content: 'x', userId: 1, views: 1 },
  { title: 'Alice Post 3', content: 'x', userId: 1, views: 1 },
], 'unique', {
  // insert a title only when its author has no post of that title yet
  rowGuard: v => db.posts.as('dup').where(d => and(eq(d.userId, v.userId), eq(d.title, v.title))).notExists(),
});
await batch.executeBatch();
batch.getAffectedCount('unique'); // 1: 'Alice Post 1' exists already
```

```sql
WITH "__mb_0" AS (
INSERT INTO "posts" ("title", "content", "user_id", "views")
SELECT v."title", v."content", v."user_id", v."views" FROM (VALUES ($1::varchar, $2::text, $3::integer, $4::integer), ($5::varchar, $6::text, $7::integer, $8::integer)) AS v("title", "content", "user_id", "views")
WHERE (NOT EXISTS (SELECT 1 FROM "posts" AS "dup" WHERE ("dup"."user_id" = "v"."user_id" AND "dup"."title" = "v"."title")))
RETURNING 1
)
SELECT (SELECT count(*)::int FROM "__mb_0") AS "0"
```

**In a [`QueryBatch`](./batching-and-prepared-queries.md#read-several-independent-results-in-one-round-trip-querybatch) leg** the scope renders inside the batch's one statement unchanged: `batch.addList(db.posts.select(p => ({ title: p.title, outranked: db.posts.as('rival')….exists() })), 'ranked')` returns the same rows as the first example on this page.

## How a scope renders

```ts
// fragment: the declared API (src/query/aliased-scope.ts, src/entity/db-context.ts)
class DbEntityTable<TEntity> {
  as<TScope extends DbEntity = TEntity>(alias: string): AliasedScope<[ColumnRow<TScope>]>;
}

class AliasedScope<TRows extends readonly unknown[]> {
  readonly row: TRows[0];                                                                     // the FROM table's row
  innerJoin<TRow>(source: AliasedScope<[TRow]>, on: (...rows: [...TRows, TRow]) => Condition): AliasedScope<[...TRows, TRow]>;
  leftJoin<TRow>(source: AliasedScope<[TRow]>, on: (...rows: [...TRows, TRow]) => Condition): AliasedScope<[...TRows, TRow]>;
  where(predicate: (...rows: TRows) => Condition): AliasedScope<TRows>;                       // repeated calls AND
  orderBy(keys: (...rows: TRows) => ReadonlyArray<AliasedScopeOrderKey>): AliasedScope<TRows>; // replaces an earlier orderBy()
  limit(count: number): AliasedScope<TRows>;                                                  // a non-negative integer
  scalar<T>(selection: (...rows: TRows) => SqlOperand<T>): SqlFragment<T>;
  exists(): SqlFragment<boolean>;
  notExists(): SqlFragment<boolean>;
}

type AliasedScopeOrderKey = readonly [SqlOperand | Condition, 'ASC' | 'DESC'];
```

| Terminal | SQL |
|---|---|
| `scalar(s)` | `(SELECT <s> FROM "<t0>" AS "<a0>"[ INNER\|LEFT JOIN "<ti>" AS "<ai>" ON <on>]*[ WHERE <where>][ ORDER BY <k> ASC\|DESC, …][ LIMIT <n>])` |
| `exists()` | `EXISTS (SELECT 1 FROM …[ WHERE <where>][ ORDER BY …][ LIMIT <n>])` |
| `notExists()` | `(NOT EXISTS (SELECT 1 FROM …))`, parenthesized so it stays one operand under `IS`, a comparison, `IN` or `BETWEEN` |

- The table follows `FROM` / `JOIN` directly: `"<table>" AS "<alias>"`, schema-qualified (`"auth"."schema_users" AS "su"`) only when the entity lives in a schema.
- `<where>` is the predicate's own SQL (an `and(…)` brings its parentheses); several `where()` calls are AND-combined.
- A **condition** sort key renders parenthesized (`("au"."username" = $2) DESC`); the direction is always written. A plain JS value as a key is refused.
- `LIMIT` is an inline integer. `exists()` / `notExists()` render the scope's `ORDER BY` and `LIMIT` too, when set: `EXISTS (SELECT 1 FROM "posts" AS "p7" WHERE "p7"."user_id" = "users"."id" ORDER BY "p7"."id" DESC LIMIT 1)`.
- Parameters continue the enclosing statement's numbering, in textual order: the selection, the joins' ON predicates, the WHERE, the ORDER BY.
- **Rows are column-only** (`ColumnRow<T>`): each column renders `"<alias>"."<column>"` and carries its column's mapper and SQL type. A navigation is not on the type (`Property 'user' does not exist on type 'ColumnRow<Post>'`), and reading one at runtime throws. Whatever else a callback reads is an outer ref, a column of the enclosing query.

## How a scope reads back

| Terminal and selection | Reads as | NULL (no row qualifies) |
|---|---|---|
| `scalar()` of a column with a custom mapper (`v.lastActiveAt`) | through the mapper (a `Date`) | `null` |
| `scalar()` of a helper with a driver-value read (`castAsInt(v.age)`) | the driver value (a number) | `null` |
| `scalar()` of a column without a custom mapper (of the scope's rows, or an outer ref) | a value of its SQL type (`withReadType(<its type>)`): a text column's `'0042'` stays `'0042'`, an integer column reads a number | `undefined` at the top level, `null` inside a nested object or a collection item |
| `scalar()` of a raw `sql` fragment | like any mapper-less expression: a numeric string becomes a number (`count(*)`'s int8 text → `2`, `'0042'` → `42`) | `undefined` at the top level, `null` inside a nested object or a collection item |
| `exists()` / `notExists()` | the driver's boolean; no mapper | never NULL |

An aggregate over no rows gives its own value (`count(*)` is `0`). Chain `.mapWith(…)` or `.withReadType(…)` on the fragment to read it otherwise:

```ts
import { castAsInt, eq, sql } from 'linkgress-orm';

const reads = await db.users
  .select(u => ({
    username: u.username,
    lastActive: db.users.as('u2').where(v => eq(v.id, u.id)).scalar(v => v.lastActiveAt),             // mapper: Date
    ageInt: db.users.as('u3').where(v => eq(v.id, u.id)).scalar(v => castAsInt(v.age)),                // helper: number
    email: db.users.as('u4').where(v => eq(v.id, u.id)).scalar(v => v.email),                          // column: text
    rawCount: db.posts.as('p2').where(p => eq(p.userId, u.id)).scalar(() => sql<number>`count(*)`),    // raw: '2' -> 2
    rawText: db.posts.as('p3').where(p => eq(p.userId, u.id)).limit(1).scalar(() => sql<string>`'0042'`),  // raw: 42
    typedText: db.posts.as('p4').where(p => eq(p.userId, u.id)).limit(1).scalar(() => sql<string>`'0042'`).withReadType<string>('text'), // '0042'
  }))
  .orderBy(u => u.username)
  .toList();
// alice: { lastActive: new Date('2025-03-15T08:00:00.000Z'), ageInt: 25, email: 'alice@test.com', rawCount: 2, rawText: 42, typedText: '0042' }
// charlie (no posts): rawCount 0, rawText undefined, typedText undefined
```

```sql
SELECT "users"."username" as "username", (SELECT "u2"."last_active_at" FROM "users" AS "u2" WHERE "u2"."id" = "users"."id") as "lastActive", (SELECT CAST("u3"."age" AS integer) FROM "users" AS "u3" WHERE "u3"."id" = "users"."id") as "ageInt", (SELECT "u4"."email" FROM "users" AS "u4" WHERE "u4"."id" = "users"."id") as "email", (SELECT count(*) FROM "posts" AS "p2" WHERE "p2"."user_id" = "users"."id") as "rawCount", (SELECT '0042' FROM "posts" AS "p3" WHERE "p3"."user_id" = "users"."id" LIMIT 1) as "rawText", (SELECT '0042' FROM "posts" AS "p4" WHERE "p4"."user_id" = "users"."id" LIMIT 1) as "typedText"
FROM "users"
ORDER BY "username" ASC
```

## What a scope refuses

Each refusal throws before anything is sent.

| Refused | Message (start) | Do instead |
|---|---|---|
| An alias that is not a plain identifier (letters, digits, `_`, `$`; starting with a letter or `_`) | `users.as(): the alias "bad alias" is not a plain identifier` | a plain identifier |
| An alias longer than 63 bytes (PostgreSQL would truncate it) | `… is longer than PostgreSQL's 63-byte identifier limit` | a shorter alias |
| An alias used twice in one scope | `Aliased scope innerJoin(): the alias "u" is already used in this scope` | unique aliases |
| A joined scope with its own `where()` / `orderBy()` / `limit()` or joins | `Aliased scope innerJoin(): the joined scope must be a bare table scope` | filters in the `on` predicate or in `where()`; each table joined onto the outer scope |
| A correlation to an outer row whose alias is one of the scope's aliases (thrown when the statement is built) | `Aliased scope: the alias "posts" is both one of the scope's own aliases and the alias of the column "posts"."user_id" it correlates to.` | give the scope another alias |
| A navigation on a scope row (`p.user`; also a compile error) | `Aliased scope "p2": navigation "user" is not available — only the row's own columns are in scope` | `innerJoin(db.users.as('au'), …)` |
| `scalar()` of a row or an object of columns (`scalar(r => r)`) | `Aliased scope scalar(): got an object holding column refs` | one column or expression per `scalar()` |
| A constant sort key (`[[5, 'ASC']]`) | `Aliased scope orderBy(): entry 0 is the constant 5` | a column, an expression or a condition |
| A direction other than `'ASC'` / `'DESC'` | `Aliased scope orderBy(): entry 0 has the direction "UP"` | `'ASC'` or `'DESC'` (no `NULLS FIRST` / `LAST` here) |
| A negative or non-integer `limit()` | `Aliased scope limit(): expected a non-negative integer, got -1` | a non-negative integer |
| A `where()` / `on` callback that returns no condition | `… expected a condition (eq(), and(), exists(), a boolean sql fragment, …)` | return a condition |

The alias rule exists because inside the scope that alias names the scope's own row: the correlation would compare the row with itself, true for every row, with no SQL error:

```ts
import { eq } from 'linkgress-orm';

await db.posts.select(p => ({ x: db.posts.as('posts').where(r => eq(r.userId, p.userId)).exists() })).toList();
// throws: Aliased scope: the alias "posts" is both one of the scope's own aliases and the alias of the column "posts"."user_id" it correlates to. …
```

## Pitfalls

- **Don't** give a scope the alias of a table or navigation the enclosing statement reads (`db.posts.as('posts')` inside a `db.posts` query): when the scope reads an outer column under that alias, the statement is refused when it is built. **Do** pick a private alias (`'rival'`, `'p2'`).
- **Don't** read a navigation on a scope row (`p.user!.username`): rows are column-only; it does not compile, and it throws at runtime. **Do** join the table with `innerJoin(db.users.as('au'), …)`.
- **Don't** use `scalar()` for a probe that can match several rows without `limit(1)` or an aggregate: `more than one row returned by a subquery used as an expression`. **Do** add `orderBy(…).limit(1)`, or aggregate.
- **Don't** write one `scalar()` per column of the same matched row (each is its own probe). **Do** read the row once with a collection's `firstOrDefault()` or a join.
- **Don't** use a scope when a navigation models the relation (`u.posts`): `exists(u.posts!.where(…))` and `u.posts!.count()` are shorter and follow the collection strategy. **Do** keep scopes for same-table correlations, joins inside the probe and places a navigation cannot reach.
- **Don't** expect `null` from a scalar of a mapper-less column when no row matches at the top level: it reads `undefined` (a mapped column and a collection item read `null`). **Do** test both with `value == null`.
- **Don't** filter or order a joined scope before joining it (`innerJoin(db.posts.as('p').where(…), …)`): refused. **Do** put the filter in the `on` predicate or in `where()`.
- **Don't** rely on a raw `sql` scalar to keep digits as text (`'0042'` reads `42`). **Do** chain `.withReadType('text')`.

## See also

- [Choosing the right query](../choosing-the-right-query.md): start here; every data need mapped to its API, SQL shape and round trips.
- [Subqueries](./subquery-guide.md): `exists` / `inSubquery` / scalar subqueries over other tables, joins of derived tables, and when a join or a collection is better.
- [Querying guide](./querying.md): collections (`u.posts!…`), their aggregates and `firstOrDefault()`.
- [CTE guide](./cte-guide.md): CTE bodies, `db.selectFromCte()`, and `selectFromCte(cte, alias)` for a correlated read over the same CTE.
- [Insert, update and delete](./insert-update-guide.md): UPDATE SET / WHERE, `MutationBatch` row guards.
- [Batching and prepared queries](./batching-and-prepared-queries.md): `QueryBatch` legs, `MutationBatch`.
- [SQL expressions](./sql-expressions.md): `agg`, `castAsInt`, `literal`, `withReadType` / `mapWith`.
- Tests with more cases: `tests/queries/aliased-scope.test.ts`, `tests/queries/cross-feature-integration.test.ts`.
