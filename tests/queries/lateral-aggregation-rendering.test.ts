import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, gt, integer, serial, sql, varchar } from '../../src';
import type { DatabaseClient, QueryOptions } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';
import { createFreshClient, seedTestData, setupDatabase, withCapturedSql } from '../utils/test-database';

/**
 * Pins the SQL the LATERAL collection strategy renders for a projection — select-list order and
 * aliasing, the `json_build_object` text, where the nested lateral joins land, marker rewriting
 * in WHERE / ORDER BY, the `firstOrDefault` form, navigation joins inside a collection — and the
 * rows those statements return, against the CTE strategy for the same projections.
 *
 * `buildJsonbAggregation` / `buildSingleJsonAggregation` render the fields in ONE recursive pass
 * (`renderFields`); the walk order and the text must stay exactly what the three separate walks
 * they replaced produced.
 */
describe('lateral aggregation rendering', () => {
  const captured: string[] = [];
  const lateralDb = new AppDatabase(createFreshClient(), {
    logQueries: true,
    logParameters: false,
    collectionStrategy: 'lateral',
    logger: (message: string, kind?: string) => {
      if (kind === 'sql' && message !== '\n[SQL Query]') {
        captured.push(message);
      }
    },
  });
  const cteDb = new AppDatabase(createFreshClient(), { collectionStrategy: 'cte' });

  const lastSql = (): string => {
    const statement = captured[captured.length - 1];
    expect(statement).toBeDefined();
    return statement;
  };

  const byId = <T extends { id: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id - b.id);

  beforeAll(async () => {
    await setupDatabase(lateralDb);
    await seedTestData(lateralDb);
  });

  afterAll(async () => {
    await lateralDb.dispose();
    await cteDb.dispose();
  });

  test('a flat projection keeps the select-list order, qualifies bare columns and aliases every leaf', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        posts: u.posts!.select(p => ({ postTitle: p.title, views: p.views })).orderBy(p => [[p.views, 'DESC']]).toList('posts'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toContain('SELECT "lateral_0_posts"."title" as "postTitle", "lateral_0_posts"."views" as "views"');
    expect(statement).toContain("json_build_object('postTitle', \"postTitle\", 'views', \"views\")");
    expect(statement).toContain('FROM "posts" "lateral_0_posts"');
    expect(statement).toContain('ORDER BY "views" DESC');
    expect(statement).toContain('LEFT JOIN LATERAL (');
    expect(rows.map(r => r.posts.map(p => p.views))).toEqual([[150, 100], [200], []]);
  });

  test('a nested object flattens to prefixed aliases and nests the json_build_object', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        posts: u.posts!.select(p => ({ meta: { title: p.title, stats: { views: p.views } } })).toList('posts'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toContain('SELECT "lateral_0_posts"."title" as "meta__title", "lateral_0_posts"."views" as "meta__stats__views"');
    expect(statement).toContain("json_build_object('meta', json_build_object('title', \"meta__title\", 'stats', json_build_object('views', \"meta__stats__views\")))");
    expect(rows[1].posts).toEqual([{ meta: { title: 'Bob Post', stats: { views: 200 } } }]);
  });

  test('a fragment leaf has the collection marker rewritten to the inner alias and is aliased', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        posts: u.posts!.select(p => ({ doubled: sql<number>`${p.views} * 2`, bumped: sql<number>`${p.views} + ${5}`, title: p.title })).orderBy(p => [[p.title, 'ASC']]).toList('posts'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toContain('"lateral_0_posts"."views" * 2 as "doubled"');
    expect(statement).toMatch(/"lateral_0_posts"\."views" \+ \$\d+ as "bumped"/);
    expect(statement).not.toContain('__collection_posts__');
    expect(rows[0].posts.map(p => [p.doubled, p.bumped])).toEqual([[200, 105], [300, 155]]);
  });

  test('WHERE and ORDER BY inside the lateral are rewritten, LIMIT is applied per parent row', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        top: u.posts!.where(p => gt(p.views, 100)).select(p => ({ title: p.title, views: p.views })).orderBy(p => [[p.views, 'DESC']]).limit(1).toList('top'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toMatch(/AND "lateral_0_posts"\."views" > \$\d+/);
    expect(statement).toContain('ORDER BY "views" DESC');
    expect(statement).toContain('LIMIT 1');
    expect(statement).not.toContain('__collection_posts__');
    expect(rows.map(r => r.top)).toEqual([[{ title: 'Alice Post 2', views: 150 }], [{ title: 'Bob Post', views: 200 }], []]);
  });

  test('firstOrDefault renders the single-object form with LIMIT 1 and yields null for an empty collection', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        latest: u.posts!.select(p => ({ title: p.title, views: p.views })).orderBy(p => [[p.views, 'DESC']]).firstOrDefault('latest'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toContain("SELECT json_build_object('title', \"title\", 'views', \"views\") as data");
    expect(statement).toContain('LIMIT 1');
    expect(statement).not.toContain('json_agg(');
    expect(rows.map(r => r.latest)).toEqual([{ title: 'Alice Post 2', views: 150 }, { title: 'Bob Post', views: 200 }, null]);
  });

  test('nested collections land after the navigation joins, in projection order, own join before children', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        posts: u.posts!.select(p => ({
          author: p.user!.username,
          comments: p.postComments!.select(c => ({ text: c.comment })).toList('comments'),
          first: p.postComments!.select(c => ({ text: c.comment })).orderBy(c => [[c.text, 'ASC']]).firstOrDefault('first'),
          title: p.title,
        })).orderBy(p => [[p.title, 'ASC']]).toList('posts'),
      }))
      .toList());
    const statement = lastSql();

    const userJoin = statement.indexOf('JOIN "users" "user" ON "lateral_0_posts"."user_id" = "user"."id"');
    const commentsJoin = statement.indexOf(') "lateral_1" ON true');
    const firstJoin = statement.indexOf(') "lateral_2" ON true');
    const where = statement.indexOf('WHERE "lateral_0_posts"');
    expect(userJoin).toBeGreaterThan(-1);
    expect(commentsJoin).toBeGreaterThan(userJoin);
    expect(firstJoin).toBeGreaterThan(commentsJoin);
    expect(where).toBeGreaterThan(firstJoin);
    expect(statement).toContain('"user"."username" as "author"');
    expect(statement).toContain('COALESCE("lateral_1".data, \'[]\'::json) as "comments"');
    expect(statement).toContain('"lateral_2".data as "first"');
    expect(statement).toContain('FROM "post_comments" "lateral_1_postComments"');
    expect(statement).toContain('WHERE "lateral_2_postComments"."post_id" = "lateral_0_posts"."id"');
    expect(rows[0].posts).toEqual([
      { author: 'alice', comments: [{ text: 'Related to order' }], first: { text: 'Related to order' }, title: 'Alice Post 1' },
      { author: 'alice', comments: [{ text: 'Mentions another order' }], first: { text: 'Mentions another order' }, title: 'Alice Post 2' },
    ]);
    expect(rows[2].posts).toEqual([]);
  });

  test('multi-level navigation inside a collection resolves the second and third hop, not only direct relations', async () => {
    const rows = byId(await lateralDb.orders
      .select(o => ({
        id: o.id,
        tasks: o.orderTasks!.select(ot => ({ level: ot.task!.level!.name, creator: ot.task!.level!.createdBy!.username })).toList('tasks'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toContain('JOIN "tasks" "task"');
    expect(statement).toContain('JOIN "task_levels" "level"');
    expect(statement).toContain('JOIN "users" "createdBy"');
    expect(statement).toContain('"level"."name" as "level"');
    expect(statement).toContain('"createdBy"."username" as "creator"');
    expect(rows.map(r => r.tasks)).toEqual([[{ level: 'High Priority', creator: 'alice' }], [{ level: 'Low Priority', creator: 'bob' }]]);
  });

  test('the same navigation referenced twice is joined once', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        posts: u.posts!.select(p => ({ author: p.user!.username, email: p.user!.email })).toList('posts'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement.split('JOIN "users" "user"').length - 1).toBe(1);
    expect(rows[1].posts).toEqual([{ author: 'bob', email: 'bob@test.com' }]);
  });

  test('selectDistinct renders DISTINCT on the inner select', async () => {
    const rows = byId(await lateralDb.users
      .select(u => ({
        id: u.id,
        owners: u.posts!.selectDistinct(p => ({ userId: p.userId })).toList('owners'),
      }))
      .toList());
    const statement = lastSql();

    expect(statement).toContain('SELECT DISTINCT "lateral_0_posts"."user_id" as "userId"');
    expect(rows.map(r => r.owners.length)).toEqual([1, 1, 0]);
  });

  test('a hasOne navigation read several times from one mock row is one mock target row (root and collection item)', async () => {
    const rootReads: any[] = [];
    const itemReads: any[] = [];
    const rows = byId(await lateralDb.posts
      .select(p => {
        rootReads.push(p.user, p.user);
        return {
          id: p.id,
          author: p.user!.username,
          email: p.user!.email,
          comments: p.postComments!.select(c => {
            itemReads.push(c.post, c.post);
            return { text: c.comment, postTitle: c.post!.title, postViews: c.post!.views };
          }).toList('comments'),
        };
      })
      .toList());
    const statement = lastSql();

    // the same row, read twice, yields the same navigation row — not a new builder + row per access
    expect(rootReads[0]).toBe(rootReads[1]);
    expect(itemReads[0]).toBe(itemReads[1]);
    // … and the join is still emitted once per level
    expect(statement.split('JOIN "users" AS "user"').length - 1).toBe(1);   // root-level navigation join
    expect(statement.split('JOIN "posts" "post"').length - 1).toBe(1);      // navigation join inside the lateral
    expect(rows[0]).toEqual({
      id: rows[0].id,
      author: 'alice',
      email: 'alice@test.com',
      comments: [{ text: 'Related to order', postTitle: 'Alice Post 1', postViews: 100 }],
    });
  });

  test('navigation rows are per mock row: two builds do not share them, and a hasMany read stays a fresh builder', async () => {
    const reads: any[] = [];
    const runQuery = () => lateralDb.posts
      .select(p => {
        reads.push({ user: p.user, comments: p.postComments, commentsAgain: p.postComments });
        return { id: p.id, author: p.user!.username };
      })
      .toList();
    await runQuery();
    await runQuery();

    expect(reads).toHaveLength(2);
    expect(reads[0].user).not.toBe(reads[1].user);
    expect(reads[0].user.username.__fieldName).toBe('username');
    // a collection navigation is a builder with its own where/select state: one per access, as before
    expect(reads[0].comments).not.toBe(reads[0].commentsAgain);
  });

  test('lateral and cte strategies return identical rows for a projection that uses every rendered form', async () => {
    const projection = (db: AppDatabase) => db.users
      .select(u => ({
        id: u.id,
        name: u.username,
        postCount: u.posts!.count(),
        viewCounts: u.posts!.select(p => p.views!).toNumberList('viewCounts'),
        latest: u.posts!.select(p => ({ title: p.title })).orderBy(p => [[p.title, 'DESC']]).firstOrDefault('latest'),
        posts: u.posts!.select(p => ({
          title: p.title,
          author: p.user!.username,
          doubled: sql<number>`${p.views} * 2`,
          meta: { views: p.views, deep: { userId: p.userId } },
          comments: p.postComments!.select(c => ({ text: c.comment })).orderBy(c => [[c.text, 'ASC']]).toList('comments'),
        })).orderBy(p => [[p.title, 'ASC']]).toList('posts'),
      }))
      .toList();

    const lateralRows = byId(await projection(lateralDb));
    const cteRows = byId(await projection(cteDb));

    expect(lateralRows).toEqual(cteRows);
    expect(lateralRows[0].posts[0]).toEqual({
      title: 'Alice Post 1',
      author: 'alice',
      doubled: 200,
      meta: { views: 100, deep: { userId: lateralRows[0].id } },
      comments: [{ text: 'Related to order' }],
    });
    expect(lateralRows.map(r => [r.postCount, r.viewCounts, r.latest])).toEqual([
      [2, [100, 150], { title: 'Alice Post 2' }],
      [1, [200], { title: 'Bob Post' }],
      [0, [], null],
    ]);
  });
});

/**
 * The inner alias is `lateral_<n>_<relation>`; the navigation-join builder used to recover the
 * relation name from that alias by splitting on `_`, so a relation name that itself contains an
 * underscore is the case that must keep remapping the join's source to the inner alias.
 */
describe('lateral aggregation with an underscore in the relation name', () => {
  class LatParent extends DbEntity {
    id!: DbColumn<number>;
    name!: DbColumn<string>;
    child_items?: LatChildItem[];
  }

  class LatChildItem extends DbEntity {
    id!: DbColumn<number>;
    parentId!: DbColumn<number>;
    label!: DbColumn<string>;
    parent?: LatParent;
  }

  class LatDb extends DbContext {
    get parents(): DbEntityTable<LatParent> {
      return this.table(LatParent);
    }

    get childItems(): DbEntityTable<LatChildItem> {
      return this.table(LatChildItem);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(LatParent, entity => {
        entity.toTable('lat_parents');
        entity.property(e => e.id).hasType(serial('id').primaryKey());
        entity.property(e => e.name).hasType(varchar('name', 100));
        entity.hasMany(e => e.child_items, () => LatChildItem).withForeignKey(c => c.parentId);
      });
      model.entity(LatChildItem, entity => {
        entity.toTable('lat_child_items');
        entity.property(e => e.id).hasType(serial('id').primaryKey());
        entity.property(e => e.parentId).hasType(integer('parent_id'));
        entity.property(e => e.label).hasType(varchar('label', 100));
        entity.hasOne(e => e.parent, () => LatParent).withForeignKey(c => c.parentId);
      });
    }
  }

  const dropTables = async (client: DatabaseClient): Promise<void> => {
    await client.query('DROP TABLE IF EXISTS "lat_child_items" CASCADE');
    await client.query('DROP TABLE IF EXISTS "lat_parents" CASCADE');
  };

  test('a navigation join inside the collection anchors on the inner alias', async () => {
    await withCapturedSql(
      (client: DatabaseClient, options: QueryOptions) => new LatDb(client, options),
      'lateral',
      dropTables,
      async (db, captured) => {
        const [first, second] = await db.parents.insertBulk([{ name: 'first' }, { name: 'second' }]).returning();
        await db.childItems.insertBulk([
          { parentId: first.id, label: 'a' },
          { parentId: first.id, label: 'b' },
          { parentId: second.id, label: 'c' },
        ]);

        const rows = await db.parents
          .select(p => ({
            id: p.id,
            child_items: p.child_items!.select(c => ({ label: c.label, owner: c.parent!.name })).orderBy(c => [[c.label, 'ASC']]).toList('child_items'),
          }))
          .toList();
        const statement = captured.filter(m => m.includes('LATERAL')).pop() ?? '';

        expect(statement).toContain('FROM "lat_child_items" "lateral_0_child_items"');
        expect(statement).toContain('LEFT JOIN "lat_parents" "parent" ON "lateral_0_child_items"."parent_id" = "parent"."id"');
        expect(statement).toContain('"parent"."name" as "owner"');
        expect([...rows].sort((a, b) => a.id - b.id).map(r => r.child_items)).toEqual([
          [{ label: 'a', owner: 'first' }, { label: 'b', owner: 'first' }],
          [{ label: 'c', owner: 'second' }],
        ]);
      },
    );
  });
});
