/**
 * `lateralJoin(row => row.<reference>)`: ONE reference navigation joined as a LATERAL probe of its
 * target's key instead of a plain join.
 *
 *   landmarks -> regions <- authors (region, mentor -> authors) <- books (author, activeAuthor, shelf -> shelves)
 *
 * A plain navigation join leaves the planner free to pick any join method. When the statistics of the
 * foreign-key column lag far behind the referenced table (the newest referenced rows are missing from
 * them), PostgreSQL may merge-join a handful of driving rows against the referenced table's WHOLE
 * primary-key index. `lateralJoin(b => b.author)` renders that one navigation as
 *
 *   LEFT JOIN LATERAL (SELECT "author__probe".* FROM "lnj_authors" "author__probe"
 *                      WHERE "author__probe"."id" = "lnj_books"."author_id" OFFSET 0) "author" ON true
 *
 * — a key probe per driving row, the only join that can be made of it (`OFFSET 0` keeps the subquery
 * from being pulled up into a plain join again) — while every other navigation, and every query that
 * does not opt in, renders exactly as before. The rows are the same either way: each test compares the
 * opted-in query with the same query without `lateralJoin()`.
 *
 * A reference reached through other references (`lateralJoin(b => b.author.region)`) probes the LAST hop,
 * correlated on the join of the hop before it — which keeps its own join:
 *
 *   LEFT JOIN "lnj_authors" AS "author" ON "lnj_books"."author_id" = "author"."id"
 *   LEFT JOIN LATERAL (SELECT "region__probe".* FROM "lnj_regions" "region__probe"
 *                      WHERE "region__probe"."id" = "author"."region_id" OFFSET 0) "region" ON true
 *
 * A collection reached through a probed path (`b.author.region.landmarks`) joins that path anew inside its own
 * subquery — its LATERAL, its count() / exists() — and probes there the hops the query probes, never joining
 * them plainly again:
 *
 *   FROM "lnj_landmarks" "lateral_0_landmarks"
 *   LEFT JOIN "lnj_authors" "author" ON "lnj_books"."author_id" = "author"."id"
 *   LEFT JOIN LATERAL (SELECT "region__probe".* FROM "lnj_regions" "region__probe"
 *                      WHERE "region__probe"."id" = "author"."region_id" OFFSET 0) "region" ON true
 *
 * The fixture: Gamma has no author (an unmatched LEFT join), Ben is not active (the constant key part of
 * `activeAuthor` matches him nowhere), Cyd has no region, Ann has no mentor. North has two landmarks, South one.
 */

import { describe, test, expect } from 'bun:test';
import { withCapturedSql } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { AssertType } from '../utils/type-tester';
import {
  DatabaseClient,
  DbContext,
  DbEntityTable,
  DbModelConfig,
  DbEntity,
  DbColumn,
  IEntityQueryable,
  LateralSqlCache,
  MockRowCache,
  QueryBatch,
  boolean,
  integer,
  varchar,
  eq,
  exists,
  gt,
  sql,
} from '../../src';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

class LnjRegion extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;

  authors?: LnjAuthor[];
  landmarks?: LnjLandmark[];
}

class LnjLandmark extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  regionId!: DbColumn<number>;
}

class LnjAuthor extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  active!: DbColumn<boolean>;
  regionId!: DbColumn<number | null>;
  mentorId!: DbColumn<number | null>;

  region?: LnjRegion;
  mentor?: LnjAuthor;
  books?: LnjBook[];
}

class LnjShelf extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;

  books?: LnjBook[];
}

class LnjBook extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  shelfId!: DbColumn<number>;
  authorId!: DbColumn<number | null>;

  shelf?: LnjShelf;
  author?: LnjAuthor;
  activeAuthor?: LnjAuthor;
}

class LnjDatabase extends DbContext {
  get lnjRegions(): DbEntityTable<LnjRegion> {
    return this.table(LnjRegion);
  }

  get lnjLandmarks(): DbEntityTable<LnjLandmark> {
    return this.table(LnjLandmark);
  }

  get lnjAuthors(): DbEntityTable<LnjAuthor> {
    return this.table(LnjAuthor);
  }

  get lnjShelves(): DbEntityTable<LnjShelf> {
    return this.table(LnjShelf);
  }

  get lnjBooks(): DbEntityTable<LnjBook> {
    return this.table(LnjBook);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(LnjRegion, entity => {
      entity.toTable('lnj_regions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lnj_regions_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();

      entity.hasMany(e => e.authors, () => LnjAuthor)
        .withForeignKey(a => a.regionId)
        .withPrincipalKey(r => r.id);

      entity.hasMany(e => e.landmarks, () => LnjLandmark)
        .withForeignKey(l => l.regionId)
        .withPrincipalKey(r => r.id);
    });

    model.entity(LnjLandmark, entity => {
      entity.toTable('lnj_landmarks');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lnj_landmarks_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.regionId).hasType(integer('region_id')).isRequired();
    });

    model.entity(LnjAuthor, entity => {
      entity.toTable('lnj_authors');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lnj_authors_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.active).hasType(boolean('active')).isRequired();
      entity.property(e => e.regionId).hasType(integer('region_id'));
      entity.property(e => e.mentorId).hasType(integer('mentor_id'));

      entity.hasOne(e => e.region, () => LnjRegion)
        .withForeignKey(a => a.regionId)
        .withPrincipalKey(r => r.id);

      // A navigation of the table to itself
      entity.hasOne(e => e.mentor, () => LnjAuthor)
        .withForeignKey(a => a.mentorId)
        .withPrincipalKey(m => m.id);

      entity.hasMany(e => e.books, () => LnjBook)
        .withForeignKey(b => b.authorId)
        .withPrincipalKey(a => a.id);
    });

    model.entity(LnjShelf, entity => {
      entity.toTable('lnj_shelves');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lnj_shelves_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();

      entity.hasMany(e => e.books, () => LnjBook)
        .withForeignKey(b => b.shelfId)
        .withPrincipalKey(s => s.id);
    });

    model.entity(LnjBook, entity => {
      entity.toTable('lnj_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'lnj_books_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 100)).isRequired();
      entity.property(e => e.shelfId).hasType(integer('shelf_id')).isRequired();
      entity.property(e => e.authorId).hasType(integer('author_id'));

      // Required: an INNER join
      entity.hasOne(e => e.shelf, () => LnjShelf)
        .withForeignKey(b => b.shelfId)
        .withPrincipalKey(s => s.id)
        .isRequired();

      entity.hasOne(e => e.author, () => LnjAuthor)
        .withForeignKey(b => b.authorId)
        .withPrincipalKey(a => a.id);

      // A constant key part: the author, when active (its foreign key is `author`'s: no constraint of its own)
      entity.hasOne(e => e.activeAuthor, () => LnjAuthor)
        .withForeignKey(b => [b.authorId, true])
        .withPrincipalKey(a => [a.id, a.active])
        .isInverseNavigation();
    });
  }
}

async function cleanupSchema(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS lnj_books CASCADE');
  await client.query('DROP TABLE IF EXISTS lnj_shelves CASCADE');
  await client.query('DROP TABLE IF EXISTS lnj_authors CASCADE');
  await client.query('DROP TABLE IF EXISTS lnj_landmarks CASCADE');
  await client.query('DROP TABLE IF EXISTS lnj_regions CASCADE');
}

interface SeedIds {
  fiction: number;
  poetry: number;
}

async function seed(db: LnjDatabase): Promise<SeedIds> {
  const [north, south] = await db.lnjRegions.insertBulk([
    { name: 'North' },
    { name: 'South' },
  ]).returning();

  await db.lnjLandmarks.insertBulk([
    { name: 'Fjord', regionId: north.id },
    { name: 'Glacier', regionId: north.id },
    { name: 'Dune', regionId: south.id },
  ]);

  const [ann] = await db.lnjAuthors.insertBulk([{ name: 'Ann', active: true, regionId: north.id }]).returning();
  const [ben] = await db.lnjAuthors.insertBulk([{ name: 'Ben', active: false, regionId: south.id, mentorId: ann.id }]).returning();
  const [cyd] = await db.lnjAuthors.insertBulk([{ name: 'Cyd', active: true, mentorId: ben.id }]).returning();

  const [fiction, poetry] = await db.lnjShelves.insertBulk([
    { label: 'Fiction' },
    { label: 'Poetry' },
  ]).returning();

  await db.lnjBooks.insertBulk([
    { title: 'Alpha', shelfId: fiction.id, authorId: ann.id },
    { title: 'Beta', shelfId: fiction.id, authorId: ben.id },
    { title: 'Gamma', shelfId: fiction.id },
    { title: 'Delta', shelfId: poetry.id, authorId: cyd.id },
    { title: 'Eps', shelfId: poetry.id, authorId: ann.id },
  ]);

  return { fiction: fiction.id, poetry: poetry.id };
}

type Strategy = 'cte' | 'lateral' | 'temptable';

/** Fresh schema per test, with the executed statements captured. */
async function withCapture<T>(
  strategy: Strategy,
  testFn: (db: LnjDatabase, captured: string[], ids: SeedIds) => Promise<T>,
): Promise<T> {
  return withCapturedSql(
    (client, options) => new LnjDatabase(client, options),
    strategy,
    cleanupSchema,
    async (db, captured) => {
      const ids = await seed(db);

      // Drop the DDL / INSERT chatter so the assertions see only what the test ran
      captured.length = 0;

      return testFn(db, captured, ids);
    },
  );
}

/** The executed statements, without the logger's `[SQL Query]` headers. */
const statements = (captured: string[]): string[] => captured.filter(entry => !entry.trimStart().startsWith('['));

/** The last executed statement. */
const lastStatement = (captured: string[]): string => {
  const all = statements(captured);

  return all[all.length - 1] ?? '';
};

const byId = <T extends { id: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id - b.id);

/** A value as the fixture names it: a root projection reads SQL NULL as `undefined`, a JSON item as `null`. */
const value = (v: unknown): unknown => v ?? null;

const AUTHOR_PROBE = 'LEFT JOIN LATERAL (SELECT "author__probe".* FROM "lnj_authors" "author__probe" '
  + 'WHERE "author__probe"."id" = "lnj_books"."author_id" OFFSET 0) "author" ON true';
const AUTHOR_PLAIN = 'LEFT JOIN "lnj_authors" AS "author" ON "lnj_books"."author_id" = "author"."id"';

// ---------------------------------------------------------------------------
// Root query
// ---------------------------------------------------------------------------

describe('lateralJoin() — root query', () => {
  test('renders the opted-in navigation as a LATERAL key probe; the other navigations and a query without it stay plain', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjBooks
        .select(b => ({ id: b.id, title: b.title, author: b.author!.name, shelf: b.shelf!.label }))
        .orderBy(b => b.id)
        .toList();
      const plainText = lastStatement(captured);

      const probed = await db.lnjBooks
        .lateralJoin(b => b.author)
        .select(b => ({ id: b.id, title: b.title, author: b.author!.name, shelf: b.shelf!.label }))
        .orderBy(b => b.id)
        .toList();
      const probedText = lastStatement(captured);

      expect(probed).toEqual(plain);
      expect(probed.map(b => [b.title, value(b.author), b.shelf])).toEqual([
        ['Alpha', 'Ann', 'Fiction'],
        ['Beta', 'Ben', 'Fiction'],
        ['Gamma', null, 'Fiction'],
        ['Delta', 'Cyd', 'Poetry'],
        ['Eps', 'Ann', 'Poetry'],
      ]);

      // Opt-in: without lateralJoin() the navigation keeps its plain join
      expect(plainText).toContain(AUTHOR_PLAIN);
      expect(plainText).not.toContain('LATERAL');

      // Only the opted-in navigation changes; the required one stays a plain INNER join
      expect(probedText).toContain(AUTHOR_PROBE);
      expect(probedText).not.toContain(AUTHOR_PLAIN);
      expect(probedText).toContain('INNER JOIN "lnj_shelves" AS "shelf" ON "lnj_books"."shelf_id" = "shelf"."id"');
      expect(probedText.replace(AUTHOR_PROBE, AUTHOR_PLAIN)).toBe(plainText);
    });
  });

  test('the untyped builders: QueryBuilder (getTable().where()) and SelectQueryBuilder (getTable().select())', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjBooks.select(b => ({ id: b.id, author: b.author!.name })).orderBy(b => b.id).toList();
      const books = (db as any).getTable('lnj_books');

      const fromWhere = await books
        .where((b: any) => gt(b.id, 0))
        .lateralJoin((b: any) => b.author)
        .select((b: any) => ({ id: b.id, author: b.author.name }))
        .orderBy((b: any) => b.id)
        .toList();
      expect(fromWhere).toEqual(plain);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);

      const fromSelect = await books
        .select((b: any) => ({ id: b.id, author: b.author.name }))
        .lateralJoin((b: any) => b.author)
        .orderBy((b: any) => b.id)
        .toList();
      expect(fromSelect).toEqual(plain);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);
    });
  });

  test('a required navigation renders INNER JOIN LATERAL', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjBooks.select(b => ({ id: b.id, shelf: b.shelf!.label })).orderBy(b => b.id).toList();

      const probed = await db.lnjBooks.lateralJoin(b => b.shelf).select(b => ({ id: b.id, shelf: b.shelf!.label })).orderBy(b => b.id).toList();

      expect(probed).toEqual(plain);
      expect(probed).toHaveLength(5);
      expect(lastStatement(captured)).toContain(
        'INNER JOIN LATERAL (SELECT "shelf__probe".* FROM "lnj_shelves" "shelf__probe" '
        + 'WHERE "shelf__probe"."id" = "lnj_books"."shelf_id" OFFSET 0) "shelf" ON true'
      );
    });
  });

  test('a constant key part goes into the probe\'s WHERE', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjBooks.select(b => ({ id: b.id, author: b.activeAuthor!.name })).orderBy(b => b.id).toList();

      const probed = await db.lnjBooks.lateralJoin(b => b.activeAuthor).select(b => ({ id: b.id, author: b.activeAuthor!.name })).orderBy(b => b.id).toList();

      expect(probed).toEqual(plain);
      // Ben is not active
      expect(probed.map(b => value(b.author))).toEqual(['Ann', null, null, 'Cyd', 'Ann']);
      expect(lastStatement(captured)).toContain(
        'LEFT JOIN LATERAL (SELECT "activeAuthor__probe".* FROM "lnj_authors" "activeAuthor__probe" '
        + 'WHERE "activeAuthor__probe"."id" = "lnj_books"."author_id" AND "activeAuthor__probe"."active" = true OFFSET 0) "activeAuthor" ON true'
      );
    });
  });

  test('a navigation reached through the lateral alias joins off it, in the projection and in the WHERE', async () => {
    await withCapture('lateral', async (db, captured) => {
      const query = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author) : db.lnjBooks)
        .where(b => eq(b.author!.region!.name, 'North'))
        .select(b => ({ id: b.id, title: b.title, author: b.author!.name, region: b.author!.region!.name }))
        .orderBy(b => b.id)
        .toList();

      const plain = await query(false);
      const probed = await query(true);

      expect(probed).toEqual(plain);
      expect(probed.map(b => [b.title, b.author, b.region])).toEqual([['Alpha', 'Ann', 'North'], ['Eps', 'Ann', 'North']]);

      const text = lastStatement(captured);
      expect(text).toContain(`${AUTHOR_PROBE}\nLEFT JOIN "lnj_regions" AS "region" ON "author"."region_id" = "region"."id"`);
    });
  });

  test('a navigation of a table to itself probes under an alias of its own, not the outer row\'s name', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjAuthors.select(a => ({ id: a.id, name: a.name, mentor: a.mentor!.name })).orderBy(a => a.id).toList();

      const probed = await db.lnjAuthors.lateralJoin(a => a.mentor).select(a => ({ id: a.id, name: a.name, mentor: a.mentor!.name })).orderBy(a => a.id).toList();

      expect(probed).toEqual(plain);
      expect(probed.map(a => [a.name, value(a.mentor)])).toEqual([['Ann', null], ['Ben', 'Ann'], ['Cyd', 'Ben']]);
      expect(lastStatement(captured)).toContain(
        'LEFT JOIN LATERAL (SELECT "mentor__probe".* FROM "lnj_authors" "mentor__probe" '
        + 'WHERE "mentor__probe"."id" = "lnj_authors"."mentor_id" OFFSET 0) "mentor" ON true'
      );
    });
  });

  test('count(), exists() and max() join the opted-in navigation as the probe too', async () => {
    await withCapture('lateral', async (db, captured) => {
      const north = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author) : db.lnjBooks)
        .where(b => eq(b.author!.region!.name, 'North'));

      expect(await north(false).count()).toBe(2);
      captured.length = 0;
      expect(await north(true).count()).toBe(2);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);

      expect(await north(true).exists()).toBe(true);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);

      const plainMax = await north(false).select(b => ({ id: b.id })).max(r => r.id);
      const probedMax = await north(true).select(b => ({ id: b.id })).max(r => r.id);
      expect(probedMax).toBe(plainMax);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);
    });
  });
});

// ---------------------------------------------------------------------------
// The select builder
// ---------------------------------------------------------------------------

/** A query taken as code written before lateralJoin() existed takes one: any builder of a table's rows. */
interface QueryOptions {
  baseQuery: IEntityQueryable<any>;
}

const baseQueryOf = (options: QueryOptions): IEntityQueryable<any> => options.baseQuery;

describe('lateralJoin() — the select builder', () => {
  test('every select builder is an IEntityQueryable, as before lateralJoin() existed, and probes through it', async () => {
    await withCapture('lateral', async (db, captured) => {
      // 1.0.23 added lateralJoin() to IEntityQueryable but not to EntitySelectQueryBuilder — the type of select(),
      // selectDistinct(), innerJoin(), leftJoin() and their chains — and every assignment below, each of which
      // compiled on 1.0.22, failed to compile:
      //   TS2741: Property 'lateralJoin' is missing in type 'EntitySelectQueryBuilder<LnjBook, …>'
      //           but required in type 'IEntityQueryable<any>'.
      const filtered: IEntityQueryable<any> = db.lnjBooks.where(b => gt(b.id, 0)).select(b => ({ id: b.id, author: b.author!.name }));
      const projected: IEntityQueryable<any> = db.lnjBooks.select(b => ({ id: b.id, author: b.author!.name }));
      const distinct: IEntityQueryable<any> = db.lnjBooks.selectDistinct(b => ({ author: b.author!.name }));
      const chained: IEntityQueryable<any> = db.lnjBooks
        .select(b => ({ id: b.id, author: b.author!.name }))
        .where(r => gt(r.id, 0))
        .orderBy(r => r.id)
        .limit(3)
        .offset(1);
      const joined: IEntityQueryable<any> = db.lnjBooks
        .innerJoin(db.lnjShelves, (b, s) => eq(b.shelfId, s.id), (b, s) => ({ id: b.id, author: b.author!.name, label: s.label }));
      const leftJoined: IEntityQueryable<any> = db.lnjBooks
        .leftJoin(db.lnjShelves, (b, s) => eq(b.shelfId, s.id), (b, s) => ({ id: b.id, author: b.author!.name, label: s.label }));
      const options: QueryOptions = { baseQuery: db.lnjBooks.where(b => gt(b.id, 0)).select(b => ({ id: b.id, author: b.author!.name })) };
      // Not run: PostgreSQL refuses FOR UPDATE on the nullable side of an outer join, plain or probed
      const locking: IEntityQueryable<any> = db.lnjBooks.select(b => ({ id: b.id, author: b.author!.name })).withTimeout(5_000).forUpdate();
      // The table always was one
      const table: IEntityQueryable<LnjBook> = db.lnjBooks;

      expect(typeof locking.lateralJoin).toBe('function');
      expect(typeof table.lateralJoin).toBe('function');

      // Through the interface, lateralJoin() swaps the author's plain join for the probe and changes nothing else
      // (rows compared as sets: without an ORDER BY, the two joins may return them in different orders)
      const rowSet = (rows: unknown[]): string[] => rows.map(row => JSON.stringify(row)).sort();

      for (const query of [filtered, projected, distinct, chained, joined, leftJoined, options.baseQuery]) {
        const plainRows = await query.toList();
        const plainText = lastStatement(captured);
        const probedRows = await query.lateralJoin(b => b.author).toList();
        const probedText = lastStatement(captured);

        expect(plainText).toContain(AUTHOR_PLAIN);
        expect(probedText).toContain(AUTHOR_PROBE);
        expect(probedText.replace(AUTHOR_PROBE, AUTHOR_PLAIN)).toBe(plainText);
        expect(probedRows.length).toBeGreaterThan(0);
        expect(rowSet(probedRows)).toEqual(rowSet(plainRows));
      }

      expect(await baseQueryOf(options).count()).toBe(5);
    });
  });

  test('lateralJoin() after select() renders the statement it renders before select(), and reads the same rows', async () => {
    await withCapture('lateral', async (db, captured) => {
      const project = (query: IEntityQueryable<LnjBook>) =>
        query.select(b => ({ id: b.id, title: b.title, author: b.author!.name, region: b.author!.region!.name }));
      const run = async (query: { toList(): Promise<object[]> }) => ({ rows: await query.toList(), text: lastStatement(captured) });

      const plain = await run(project(db.lnjBooks.where(b => gt(b.id, 0))).orderBy(r => r.id));
      const before = await run(project(db.lnjBooks.where(b => gt(b.id, 0)).lateralJoin(b => b.author)).orderBy(r => r.id));

      // The select builder's own lateralJoin() keeps the builder — its projection, and the chain after it
      const projected = project(db.lnjBooks.where(b => gt(b.id, 0)));
      const probed = projected.lateralJoin(b => b.author);
      const kept: AssertType<typeof probed, typeof projected> = probed;
      const after = await run(kept.orderBy(r => r.id));

      // At the end of the chain, and through the IEntityQueryable a caller took the builder as
      const last = await run(project(db.lnjBooks.where(b => gt(b.id, 0))).orderBy(r => r.id).lateralJoin(b => b.author));
      const taken = await run(
        baseQueryOf({ baseQuery: project(db.lnjBooks.where(b => gt(b.id, 0))).orderBy(r => r.id) }).lateralJoin(b => b.author),
      );

      expect(before.text).toContain(AUTHOR_PROBE);
      expect(before.text).toContain('LEFT JOIN "lnj_regions" AS "region" ON "author"."region_id" = "region"."id"');
      expect(before.text.replace(AUTHOR_PROBE, AUTHOR_PLAIN)).toBe(plain.text);
      expect(before.rows).toEqual(plain.rows);

      for (const probedRun of [after, last, taken]) {
        expect(probedRun.text).toBe(before.text);
        expect(probedRun.rows).toEqual(plain.rows);
      }

      expect((after.rows as Array<{ title: string; author?: string; region?: string }>).map(r => [r.title, value(r.author), value(r.region)])).toEqual([
        ['Alpha', 'Ann', 'North'],
        ['Beta', 'Ben', 'South'],
        ['Gamma', null, null],
        ['Delta', 'Cyd', null],
        ['Eps', 'Ann', 'North'],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

describe('lateralJoin() — collections', () => {
  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`an item navigation of a collection (${strategy} strategy)`, async () => {
      await withCapture(strategy, async (db, captured) => {
        const query = (probe: boolean) => db.lnjShelves
          .select(s => ({
            id: s.id,
            label: s.label,
            books: (probe ? s.books!.lateralJoin(b => b.author) : s.books!)
              .orderBy(b => b.title)
              .select(b => ({ title: b.title, author: b.author!.name, region: b.author!.region!.name }))
              .toList(),
          }))
          .orderBy(s => s.id)
          .toList();

        const plain = await query(false);
        captured.length = 0;
        const probed = await query(true);

        expect(probed).toEqual(plain);
        expect(probed.map(s => ({
          label: s.label,
          books: s.books.map(b => ({ title: b.title, author: value(b.author), region: value(b.region) })),
        }))).toEqual([
          {
            label: 'Fiction',
            books: [
              { title: 'Alpha', author: 'Ann', region: 'North' },
              { title: 'Beta', author: 'Ben', region: 'South' },
              { title: 'Gamma', author: null, region: null },
            ],
          },
          {
            label: 'Poetry',
            books: [
              { title: 'Delta', author: 'Cyd', region: null },
              { title: 'Eps', author: 'Ann', region: 'North' },
            ],
          },
        ]);

        // The probe reads the foreign key of the collection's own row, as the strategy renders it
        const text = statements(captured).join('\n');
        const itemRow = strategy === 'lateral' ? 'lateral_\\d+_books' : 'lnj_books';
        expect(text).toMatch(new RegExp(
          'LEFT JOIN LATERAL \\(SELECT "author__probe"\\.\\* FROM "lnj_authors" "author__probe" '
          + `WHERE "author__probe"\\."id" = "${itemRow}"\\."author_id" OFFSET 0\\) "author" ON true`
        ));
        expect(text).toContain('LEFT JOIN "lnj_regions" "region" ON "author"."region_id" = "region"."id"');
        expect(text).not.toContain('LEFT JOIN "lnj_authors" "author" ON');
      });
    });
  }

  test('an exists() over a collection whose filter reads the opted-in navigation', async () => {
    await withCapture('lateral', async (db, captured) => {
      const query = (probe: boolean) => db.lnjShelves
        .where(s => exists((probe ? s.books!.lateralJoin(b => b.author) : s.books!).where(b => eq(b.author!.name, 'Cyd'))))
        .select(s => ({ id: s.id, label: s.label }))
        .toList();

      const plain = await query(false);
      const probed = await query(true);

      expect(probed).toEqual(plain);
      expect(probed.map(s => s.label)).toEqual(['Poetry']);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);
    });
  });

  test('a count() of a collection whose filter reads the opted-in navigation', async () => {
    await withCapture('lateral', async (db, captured) => {
      const query = (probe: boolean) => db.lnjShelves
        .select(s => ({
          id: s.id,
          north: (probe ? s.books!.lateralJoin(b => b.author) : s.books!).where(b => eq(b.author!.region!.name, 'North')).count(),
        }))
        .orderBy(s => s.id)
        .toList();

      const plain = await query(false);
      const probed = await query(true);

      expect(probed).toEqual(plain);
      expect(probed.map(s => s.north)).toEqual([1, 1]);
      expect(lastStatement(captured)).toMatch(/LEFT JOIN LATERAL \(SELECT "author__probe"\.\* FROM "lnj_authors" "author__probe" WHERE "author__probe"\."id" = "lateral_\d+_books"\."author_id" OFFSET 0\) "author" ON true/);
    });
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe('lateralJoin() — composition', () => {
  test('a QueryBatch leg and a UNION ALL leg carry the probe and read the same rows', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const books = () => db.lnjBooks.lateralJoin(b => b.author).select(b => ({ id: b.id, author: b.author!.name })).orderBy(b => b.id);
      const standalone = await books().toList();

      const batch = new QueryBatch();
      const key = batch.addList(books(), 'books');
      captured.length = 0;
      await batch.executeBatch();

      expect(batch.getList(key)).toEqual(standalone);
      expect(statements(captured)).toHaveLength(1);
      expect(lastStatement(captured)).toContain(AUTHOR_PROBE);

      const leg = (shelfId: number, probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author) : db.lnjBooks)
        .where(b => eq(b.shelfId, shelfId))
        .select(b => ({ id: b.id, author: b.author!.name }));

      const plainUnion = await leg(ids.fiction, false).unionAll(leg(ids.poetry, false)).toList();
      const probedUnion = await leg(ids.fiction, true).unionAll(leg(ids.poetry, false)).toList();

      expect(byId(probedUnion)).toEqual(byId(plainUnion));
      expect(byId(probedUnion)).toEqual(standalone);
      // The first leg probes, the second keeps its plain join
      const unionText = lastStatement(captured);
      expect(unionText).toContain(AUTHOR_PROBE);
      expect(unionText).toContain(AUTHOR_PLAIN);
    });
  });

  test('prepared statements: one text per query, and prepare() reads the same rows', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const run = () => db.lnjBooks
        .withPreparedStatements(true)
        .lateralJoin(b => b.author)
        .where(b => eq(b.shelfId, ids.fiction))
        .select(b => ({ id: b.id, author: b.author!.name }))
        .orderBy(b => b.id)
        .toList();

      const first = await run();
      const second = await run();
      const texts = statements(captured);

      expect(second).toEqual(first);
      expect(first.map(b => value(b.author))).toEqual(['Ann', 'Ben', null]);
      // The same text both times: ONE cached plan per connection
      expect(texts).toHaveLength(2);
      expect(texts[1]).toBe(texts[0]);
      expect(texts[0]).toContain(AUTHOR_PROBE);

      const prepared = db.lnjBooks
        .lateralJoin(b => b.author)
        .where(b => eq(b.shelfId, sql.placeholder('shelfId')))
        .select(b => ({ id: b.id, author: b.author!.name }))
        .orderBy(b => b.id)
        .prepare('lnj_books_of_shelf');

      expect(await prepared.execute({ shelfId: ids.fiction })).toEqual(first);
    });
  });
});

// ---------------------------------------------------------------------------
// A nested reference path
// ---------------------------------------------------------------------------

const REGION_PROBE = 'LEFT JOIN LATERAL (SELECT "region__probe".* FROM "lnj_regions" "region__probe" '
  + 'WHERE "region__probe"."id" = "author"."region_id" OFFSET 0) "region" ON true';
const REGION_PLAIN = 'LEFT JOIN "lnj_regions" AS "region" ON "author"."region_id" = "region"."id"';
/** The same plain join inside a collection's subquery, which renders its joins without `AS`. */
const ITEM_REGION_PLAIN = 'LEFT JOIN "lnj_regions" "region" ON "author"."region_id" = "region"."id"';

/** Each book's title, its author and the author's region, as the fixture names them. */
const BOOK_REGIONS = [
  ['Alpha', 'Ann', 'North'],
  ['Beta', 'Ben', 'South'],
  ['Gamma', null, null],
  ['Delta', 'Cyd', null],
  ['Eps', 'Ann', 'North'],
];

describe('lateralJoin() — a nested reference path', () => {
  test('a reference reached through another one probes the last hop, correlated on the join of the hop before it', async () => {
    await withCapture('lateral', async (db, captured) => {
      const query = (probe: boolean) => {
        const filtered = db.lnjBooks.where(b => gt(b.id, 0));

        return (probe ? filtered.lateralJoin(b => b.author!.region) : filtered)
          .select(b => ({ id: b.id, title: b.title, author: b.author!.name, region: b.author!.region!.name }))
          .orderBy(b => b.id)
          .toList();
      };

      const plain = await query(false);
      const plainText = lastStatement(captured);
      const probed = await query(true);
      const probedText = lastStatement(captured);

      expect(probed).toEqual(plain);
      expect(probed.map(b => [b.title, value(b.author), value(b.region)])).toEqual(BOOK_REGIONS);

      expect(plainText).toContain(`${AUTHOR_PLAIN}\n${REGION_PLAIN}`);
      expect(plainText).not.toContain('LATERAL');

      // The intermediate hop keeps its plain join, the last hop probes off its alias, and nothing else changes
      expect(probedText).toContain(`${AUTHOR_PLAIN}\n${REGION_PROBE}`);
      expect(probedText).not.toContain(REGION_PLAIN);
      expect(probedText.replace(REGION_PROBE, REGION_PLAIN)).toBe(plainText);
    });
  });

  test('both hops probed: the last hop\'s probe reads the alias of the first one\'s, in either call order', async () => {
    await withCapture('lateral', async (db, captured) => {
      const project = (query: IEntityQueryable<LnjBook>) => query
        .select(b => ({ id: b.id, title: b.title, author: b.author!.name, region: b.author!.region!.name }))
        .orderBy(b => b.id)
        .toList();

      const plain = await project(db.lnjBooks);
      const plainText = lastStatement(captured);
      const probed = await project(db.lnjBooks.lateralJoin(b => b.author).lateralJoin(b => b.author!.region));
      const probedText = lastStatement(captured);
      const reversed = await project(db.lnjBooks.lateralJoin(b => b.author!.region).lateralJoin(b => b.author));
      const reversedText = lastStatement(captured);

      expect(probed).toEqual(plain);
      expect(reversed).toEqual(plain);
      expect(probedText).toContain(`${AUTHOR_PROBE}\n${REGION_PROBE}`);
      expect(probedText.replace(AUTHOR_PROBE, AUTHOR_PLAIN).replace(REGION_PROBE, REGION_PLAIN)).toBe(plainText);
      expect(reversedText).toBe(probedText);
    });
  });

  test('every builder takes the path: the untyped QueryBuilder and SelectQueryBuilder, a select builder, an IEntityQueryable', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjBooks.select(b => ({ id: b.id, region: b.author!.region!.name })).orderBy(b => b.id).toList();
      const plainText = lastStatement(captured);
      const books = (db as any).getTable('lnj_books');

      const fromWhere = await books
        .where((b: any) => gt(b.id, 0))
        .lateralJoin((b: any) => b.author.region)
        .select((b: any) => ({ id: b.id, region: b.author.region.name }))
        .orderBy((b: any) => b.id)
        .toList();
      expect(fromWhere).toEqual(plain);
      expect(lastStatement(captured)).toContain(`${AUTHOR_PLAIN}\n${REGION_PROBE}`);

      const fromSelect = await books
        .select((b: any) => ({ id: b.id, region: b.author.region.name }))
        .lateralJoin((b: any) => b.author.region)
        .orderBy((b: any) => b.id)
        .toList();
      expect(fromSelect).toEqual(plain);
      expect(lastStatement(captured).replace(REGION_PROBE, REGION_PLAIN)).toBe(plainText);

      // The typed select builder keeps its projection and its chain
      const projected = db.lnjBooks.select(b => ({ id: b.id, region: b.author!.region!.name }));
      const probed = projected.lateralJoin(b => b.author!.region);
      const kept: AssertType<typeof probed, typeof projected> = probed;
      expect(await kept.orderBy(r => r.id).toList()).toEqual(plain);
      expect(lastStatement(captured).replace(REGION_PROBE, REGION_PLAIN)).toBe(plainText);

      const taken = await baseQueryOf({ baseQuery: db.lnjBooks.select(b => ({ id: b.id, region: b.author!.region!.name })).orderBy(r => r.id) })
        .lateralJoin(b => b.author.region)
        .toList();
      expect(taken).toEqual(plain);
      expect(lastStatement(captured).replace(REGION_PROBE, REGION_PLAIN)).toBe(plainText);
    });
  });

  test('the probe follows the alias the navigation plan gives its path — never another path ending in the same relation', async () => {
    await withCapture('lateral', async (db, captured) => {
      // Two paths end in `region`: the shallower one keeps the plain alias, the other renders as "mentor__region"
      const MENTOR_REGION_PLAIN = 'LEFT JOIN "lnj_regions" AS "mentor__region" ON "mentor"."region_id" = "mentor__region"."id"';
      const MENTOR_REGION_PROBE = 'LEFT JOIN LATERAL (SELECT "mentor__region__probe".* FROM "lnj_regions" "mentor__region__probe" '
        + 'WHERE "mentor__region__probe"."id" = "mentor"."region_id" OFFSET 0) "mentor__region" ON true';
      const project = (query: IEntityQueryable<LnjBook>) => query
        .select(b => ({ id: b.id, title: b.title, region: b.author!.region!.name, mentorRegion: b.author!.mentor!.region!.name }))
        .orderBy(b => b.id)
        .toList();

      const plain = await project(db.lnjBooks);
      const plainText = lastStatement(captured);
      const deep = await project(db.lnjBooks.lateralJoin(b => b.author!.mentor!.region));
      const deepText = lastStatement(captured);
      const shallow = await project(db.lnjBooks.lateralJoin(b => b.author!.region));
      const shallowText = lastStatement(captured);

      expect(plain.map(b => [b.title, value(b.region), value(b.mentorRegion)])).toEqual([
        ['Alpha', 'North', null],
        ['Beta', 'South', 'North'],
        ['Gamma', null, null],
        ['Delta', null, 'South'],
        ['Eps', 'North', null],
      ]);
      expect(deep).toEqual(plain);
      expect(shallow).toEqual(plain);
      expect(plainText).toContain(REGION_PLAIN);
      expect(plainText).toContain(MENTOR_REGION_PLAIN);

      // Three hops deep, under its path alias: only that join changes
      expect(deepText).toContain(MENTOR_REGION_PROBE);
      expect(deepText.replace(MENTOR_REGION_PROBE, MENTOR_REGION_PLAIN)).toBe(plainText);

      // The shallower path ending in the same relation: only ITS join changes
      expect(shallowText).toContain(REGION_PROBE);
      expect(shallowText).toContain(MENTOR_REGION_PLAIN);
      expect(shallowText.replace(REGION_PROBE, REGION_PLAIN)).toBe(plainText);
    });
  });

  test('count(), exists() and max() probe the path too, with a WHERE on the probed alias', async () => {
    await withCapture('lateral', async (db, captured) => {
      const north = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author!.region) : db.lnjBooks)
        .where(b => eq(b.author!.region!.name, 'North'));

      expect(await north(false).count()).toBe(2);
      const plainCount = lastStatement(captured);
      expect(await north(true).count()).toBe(2);
      expect(lastStatement(captured)).toContain(REGION_PROBE);
      expect(lastStatement(captured).replace(REGION_PROBE, REGION_PLAIN)).toBe(plainCount);

      expect(await north(true).exists()).toBe(true);
      expect(lastStatement(captured)).toContain(REGION_PROBE);

      const plainMax = await north(false).select(b => ({ id: b.id })).max(r => r.id);
      const probedMax = await north(true).select(b => ({ id: b.id })).max(r => r.id);
      expect(probedMax).toBe(plainMax);
      expect(lastStatement(captured)).toContain(REGION_PROBE);
    });
  });

  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`an item path of a collection (${strategy} strategy)`, async () => {
      await withCapture(strategy, async (db, captured) => {
        const query = (probe: boolean) => db.lnjShelves
          .select(s => ({
            id: s.id,
            label: s.label,
            books: (probe ? s.books!.lateralJoin(b => b.author!.region) : s.books!)
              .orderBy(b => b.title)
              .select(b => ({ title: b.title, author: b.author!.name, region: b.author!.region!.name }))
              .toList(),
          }))
          .orderBy(s => s.id)
          .toList();

        const plain = await query(false);
        captured.length = 0;
        const probed = await query(true);

        expect(probed).toEqual(plain);
        expect(probed.map(s => ({
          label: s.label,
          books: s.books.map(b => [b.title, value(b.author), value(b.region)]),
        }))).toEqual([
          { label: 'Fiction', books: BOOK_REGIONS.slice(0, 3) },
          { label: 'Poetry', books: BOOK_REGIONS.slice(3) },
        ]);

        // The item's own hop keeps its plain join off the row the strategy renders the item as; the last hop probes off it
        const text = statements(captured).join('\n');
        const itemRow = strategy === 'lateral' ? 'lateral_\\d+_books' : 'lnj_books';
        expect(text).toMatch(new RegExp(`LEFT JOIN "lnj_authors" "author" ON "${itemRow}"\\."author_id" = "author"\\."id"`));
        expect(text).toContain(REGION_PROBE);
        expect(text).not.toContain(ITEM_REGION_PLAIN);
      });
    });
  }

  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`a navigation and a collection hanging off the nested probe read its alias (${strategy} strategy)`, async () => {
      await withCapture(strategy, async (db, captured) => {
        const MENTOR_PROBE = 'LEFT JOIN LATERAL (SELECT "mentor__probe".* FROM "lnj_authors" "mentor__probe" '
          + 'WHERE "mentor__probe"."id" = "author"."mentor_id" OFFSET 0) "mentor" ON true';
        const project = (b: any) => ({
          title: b.title,
          mentor: b.author.mentor.name,
          mentorRegion: b.author.mentor.region.name,
          mentorBooks: b.author.mentor.books.orderBy((m: any) => m.title).select((m: any) => ({ title: m.title })).toList(),
        });

        // Off the root row
        const rootQuery = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author!.mentor) : db.lnjBooks)
          .select(b => ({ id: b.id, ...project(b) }))
          .orderBy(b => b.id)
          .toList();

        const rootPlain = await rootQuery(false);
        captured.length = 0;
        const rootProbed = await rootQuery(true);

        expect(rootProbed).toEqual(rootPlain);
        expect(statements(captured).join('\n')).toContain(`${MENTOR_PROBE}\nLEFT JOIN "lnj_regions" AS "region" ON "mentor"."region_id" = "region"."id"`);

        // Off a collection's item
        const itemQuery = (probe: boolean) => db.lnjShelves
          .select(s => ({
            id: s.id,
            books: (probe ? s.books!.lateralJoin(b => b.author!.mentor) : s.books!).orderBy(b => b.title).select(b => project(b)).toList(),
          }))
          .orderBy(s => s.id)
          .toList();

        const itemPlain = await itemQuery(false);
        captured.length = 0;
        const itemProbed = await itemQuery(true);

        expect(itemProbed).toEqual(itemPlain);
        expect(itemProbed.map(s => s.books.map((b: any) => [b.title, value(b.mentor), value(b.mentorRegion), b.mentorBooks.map((m: any) => m.title)]))).toEqual([
          [['Alpha', null, null, []], ['Beta', 'Ann', 'North', ['Alpha', 'Eps']], ['Gamma', null, null, []]],
          [['Delta', 'Ben', 'South', ['Beta']], ['Eps', null, null, []]],
        ]);
        const itemText = statements(captured).join('\n');
        expect(itemText).toContain(MENTOR_PROBE);
        expect(itemText).toContain('LEFT JOIN "lnj_regions" "region" ON "mentor"."region_id" = "region"."id"');
      });
    });
  }

  test('a collection\'s count() and exists() whose filter reads the probed path', async () => {
    await withCapture('lateral', async (db, captured) => {
      const counted = (probe: boolean) => db.lnjShelves
        .select(s => ({
          id: s.id,
          north: (probe ? s.books!.lateralJoin(b => b.author!.region) : s.books!).where(b => eq(b.author!.region!.name, 'North')).count(),
        }))
        .orderBy(s => s.id)
        .toList();

      const plainCounts = await counted(false);
      const probedCounts = await counted(true);
      expect(probedCounts).toEqual(plainCounts);
      expect(probedCounts.map(s => s.north)).toEqual([1, 1]);
      expect(lastStatement(captured)).toContain(REGION_PROBE);
      expect(lastStatement(captured)).not.toContain(ITEM_REGION_PLAIN);

      const south = (probe: boolean) => db.lnjShelves
        .where(s => exists((probe ? s.books!.lateralJoin(b => b.author!.region) : s.books!).where(b => eq(b.author!.region!.name, 'South'))))
        .select(s => ({ id: s.id, label: s.label }))
        .toList();

      const plainShelves = await south(false);
      const probedShelves = await south(true);
      expect(probedShelves).toEqual(plainShelves);
      expect(probedShelves.map(s => s.label)).toEqual(['Fiction']);
      expect(lastStatement(captured)).toContain(REGION_PROBE);
      expect(lastStatement(captured)).not.toContain(ITEM_REGION_PLAIN);
    });
  });

  test('a QueryBatch leg and a UNION ALL leg carry the nested probe and read the same rows', async () => {
    await withCapture('lateral', async (db, captured, ids) => {
      const leg = (shelfId: number, probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author!.region) : db.lnjBooks)
        .where(b => eq(b.shelfId, shelfId))
        .select(b => ({ id: b.id, region: b.author!.region!.name }));

      const plainFiction = await leg(ids.fiction, false).orderBy(b => b.id).toList();
      const standalone = await leg(ids.fiction, true).orderBy(b => b.id).toList();
      expect(standalone).toEqual(plainFiction);

      const batch = new QueryBatch();
      const key = batch.addList(leg(ids.fiction, true).orderBy(b => b.id), 'books');
      captured.length = 0;
      await batch.executeBatch();

      expect(batch.getList(key)).toEqual(standalone);
      expect(statements(captured)).toHaveLength(1);
      expect(lastStatement(captured)).toContain(REGION_PROBE);

      const plainUnion = await leg(ids.fiction, false).unionAll(leg(ids.poetry, false)).toList();
      const probedUnion = await leg(ids.fiction, true).unionAll(leg(ids.poetry, false)).toList();

      expect(byId(probedUnion)).toEqual(byId(plainUnion));
      expect(byId(probedUnion).map(b => value(b.region))).toEqual(['North', 'South', null, null, 'North']);
      // The first leg probes, the second keeps its plain join
      const unionText = lastStatement(captured);
      expect(unionText).toContain(REGION_PROBE);
      expect(unionText).toContain(REGION_PLAIN);
    });
  });

  test('refused: a path ending in or running through a collection, a column, and the uses that refuse any probe', async () => {
    await withCapture('lateral', async (db) => {
      // @ts-expect-error — a path ending in a collection: refused at compile time as well
      expect(() => db.lnjBooks.lateralJoin(b => b.author!.books)).toThrow(/lateralJoin\(\): "author\.books" is a collection of "lnj_authors"/);
      expect(() => db.lnjShelves.lateralJoin((s: any) => s.books.author)).toThrow(/lateralJoin\(\): "books" is a collection of "lnj_shelves"/);
      // @ts-expect-error — a column reached through navigations: refused at compile time as well
      expect(() => db.lnjBooks.lateralJoin(b => b.author!.region!.name)).toThrow(/lateralJoin\(\) takes a reference navigation of the "lnj_books" row/);

      expect(() => db.lnjBooks.lateralJoin(b => b.author!.region).where(b => eq(b.author!.region!.name, 'North')).update({ title: 'x' }))
        .toThrow(/lateralJoin\(\) cannot be combined with update\(\)/);
      expect(() => db.lnjBooks.lateralJoin(b => b.author!.region).where(b => eq(b.author!.region!.name, 'North')).delete())
        .toThrow(/lateralJoin\(\) cannot be combined with delete\(\)/);
      expect(() => db.lnjBooks
        .lateralJoin(b => b.author!.region)
        .select(b => ({ id: b.id, region: b.author!.region!.name }))
        .groupBy(r => ({ region: r.region })))
        .toThrow(/lateralJoin\(\) is not supported on a grouped query/);

      // In a collection, the path is read off the item's relations
      await expectToReject(
        // @ts-expect-error — a path ending in a collection: refused at compile time as well
        () => db.lnjShelves.select(s => ({ titles: s.books!.lateralJoin(b => b.author!.books).select(b => b.title).toList() })).toList(),
        /lateralJoin\(\): "author\.books" is a collection of "lnj_authors"/,
      );
      await expectToReject(
        () => db.lnjRegions.select(r => ({ titles: r.authors!.selectMany(a => a.books!).lateralJoin(b => b.author!.region).select(b => b.title).toList() })).toList(),
        /lateralJoin\(\) is not supported on a collection flattened by selectMany\(\)/,
      );

      // Nothing was written
      expect(await db.lnjBooks.count()).toBe(5);
      expect(await db.lnjBooks.where(b => eq(b.title, 'x')).count()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// A collection hanging off a probed path
// ---------------------------------------------------------------------------

/** The plain join of the mentor inside a collection's subquery (which renders its joins without `AS`). */
const ITEM_MENTOR_PLAIN = 'LEFT JOIN "lnj_authors" "mentor" ON "author"."mentor_id" = "mentor"."id"';
/** The probe of the mentor, off the author's join. */
const MENTOR_PROBE_OFF_AUTHOR = 'LEFT JOIN LATERAL (SELECT "mentor__probe".* FROM "lnj_authors" "mentor__probe" '
  + 'WHERE "mentor__probe"."id" = "author"."mentor_id" OFFSET 0) "mentor" ON true';

const occurrences = (text: string, part: string): number => text.split(part).length - 1;
const replaced = (text: string, from: string, to: string): string => text.split(from).join(to);
/** A text of the books' region path with every join of the region — the row's own and a subquery's — as the probe. */
const regionProbed = (text: string): string => replaced(replaced(text, REGION_PLAIN, REGION_PROBE), ITEM_REGION_PLAIN, REGION_PROBE);

describe('lateralJoin() — a collection hanging off the probed path', () => {
  // A collection reached through a navigation path (`b.author.mentor.region.landmarks`) correlates through that path:
  // its LATERAL subquery — and the subquery of its count() / exists() — joins the path anew from the row the path
  // starts from. A hop of it the query probes is probed there as well, never joined plainly again.
  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`collections of the item off the probed hop and off a hop beyond it (${strategy} strategy)`, async () => {
      await withCapture(strategy, async (db, captured) => {
        const query = (probe: boolean) => db.lnjShelves
          .select(s => ({
            id: s.id,
            books: (probe ? s.books!.lateralJoin(b => b.author!.mentor) : s.books!)
              .orderBy(b => b.title)
              .select(b => ({
                title: b.title,
                // Off a hop beyond the probed one
                landmarks: b.author!.mentor!.region!.landmarks!.orderBy(l => l.name).select(l => ({ name: l.name })).toList(),
                landmarkCount: sql<number>`${b.author!.mentor!.region!.landmarks!.count()}`,
                // Off the probed hop itself, ordered and limited
                mentorFirstBook: b.author!.mentor!.books!.orderBy(m => m.title).select(m => ({ title: m.title })).limit(1).toList(),
              }))
              .toList(),
          }))
          .orderBy(s => s.id)
          .toList();

        const plain = await query(false);
        const plainText = statements(captured).join('\n');
        captured.length = 0;
        const probed = await query(true);
        const probedText = statements(captured).join('\n');

        expect(probed).toEqual(plain);
        expect(probed.map(s => s.books.map(b => [
          b.title,
          b.landmarks.map(l => l.name),
          Number(b.landmarkCount),
          b.mentorFirstBook.map(m => m.title),
        ]))).toEqual([
          [['Alpha', [], 0, []], ['Beta', ['Fjord', 'Glacier'], 2, ['Alpha']], ['Gamma', [], 0, []]],
          [['Delta', ['Dune'], 1, ['Beta']], ['Eps', [], 0, []]],
        ]);

        // Every join of the probed hop is the probe: the collection's own, and each the subqueries hanging off it
        // make from the book row — the count's under every strategy, the lists' under LATERAL (also nested in the
        // temp-table aggregation; the CTE aggregations join nothing of the path) — and nothing else changed
        expect(probedText).not.toContain(ITEM_MENTOR_PLAIN);
        expect(occurrences(probedText, MENTOR_PROBE_OFF_AUTHOR)).toBe(strategy === 'cte' ? 2 : 4);
        expect(probedText).toBe(replaced(plainText, ITEM_MENTOR_PLAIN, MENTOR_PROBE_OFF_AUTHOR));
      });
    });
  }

  for (const strategy of ['lateral', 'cte', 'temptable'] as const) {
    test(`collections of the root row off the probed hop (${strategy} strategy)`, async () => {
      await withCapture(strategy, async (db, captured) => {
        const query = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author!.region) : db.lnjBooks)
          .select(b => ({
            id: b.id,
            title: b.title,
            landmarks: b.author!.region!.landmarks!.orderBy(l => l.name).select(l => ({ name: l.name })).toList(),
            topLandmarks: b.author!.region!.landmarks!.orderBy(l => l.name).select(l => ({ name: l.name })).limit(1).toList(),
            firstLandmark: b.author!.region!.landmarks!.orderBy(l => l.name).select(l => ({ name: l.name })).firstOrDefault(),
            landmarkCount: sql<number>`${b.author!.region!.landmarks!.count()}`,
            // Correlated to the row's own join of the region — the probe — and joins nothing of the path itself
            landmarkNames: b.author!.region!.landmarks!.orderBy(l => l.name).select(l => l.name).toStringList(),
          }))
          .orderBy(b => b.id)
          .toList();

        const plain = await query(false);
        const plainText = statements(captured).join('\n');
        captured.length = 0;
        const probed = await query(true);
        const probedText = statements(captured).join('\n');

        expect(probed).toEqual(plain);
        expect(probed.map(b => [
          b.title,
          b.landmarks.map(l => l.name),
          b.topLandmarks.map(l => l.name),
          b.firstLandmark?.name ?? null,
          Number(b.landmarkCount),
          b.landmarkNames,
        ])).toEqual([
          ['Alpha', ['Fjord', 'Glacier'], ['Fjord'], 'Fjord', 2, ['Fjord', 'Glacier']],
          ['Beta', ['Dune'], ['Dune'], 'Dune', 1, ['Dune']],
          ['Gamma', [], [], null, 0, []],
          ['Delta', [], [], null, 0, []],
          ['Eps', ['Fjord', 'Glacier'], ['Fjord'], 'Fjord', 2, ['Fjord', 'Glacier']],
        ]);

        // The row's own join of the region and every re-join a subquery makes of it: the probe — the LATERAL
        // lists' and the count's (the CTE and temp-table aggregations join nothing of the path)
        expect(probedText).not.toContain(ITEM_REGION_PLAIN);
        expect(occurrences(probedText, REGION_PROBE)).toBe(strategy === 'lateral' ? 5 : 2);
        expect(probedText).toBe(regionProbed(plainText));
      });
    });
  }

  test('a probed first hop: the re-join\'s probe reads the foreign key of the row the path starts from — the root\'s, an item\'s', async () => {
    await withCapture('lateral', async (db, captured) => {
      const AUTHOR_ITEM_PLAIN = 'LEFT JOIN "lnj_authors" "author" ON "lnj_books"."author_id" = "author"."id"';
      const project = (b: any) => ({
        title: b.title,
        sameAuthor: b.author.books.orderBy((x: any) => x.title).select((x: any) => ({ title: x.title })).toList() as { title: string }[],
        sameAuthorCount: sql<number>`${b.author.books.count()}`,
      });

      const rootQuery = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author) : db.lnjBooks)
        .select(b => ({ id: b.id, ...project(b) }))
        .orderBy(b => b.id)
        .toList();

      const rootPlain = await rootQuery(false);
      const rootPlainText = lastStatement(captured);
      const rootProbed = await rootQuery(true);
      const rootProbedText = lastStatement(captured);

      expect(rootProbed).toEqual(rootPlain);
      expect(rootProbed.map(b => [b.title, b.sameAuthor.map(x => x.title), Number(b.sameAuthorCount)])).toEqual([
        ['Alpha', ['Alpha', 'Eps'], 2],
        ['Beta', ['Beta'], 1],
        ['Gamma', [], 0],
        ['Delta', ['Delta'], 1],
        ['Eps', ['Alpha', 'Eps'], 2],
      ]);
      // The list's LATERAL and the count's subquery each re-join the author off the book row: both are the probe
      expect(rootProbedText).not.toContain(AUTHOR_ITEM_PLAIN);
      expect(occurrences(rootProbedText, AUTHOR_PROBE)).toBe(2);
      expect(rootProbedText).toBe(replaced(rootPlainText, AUTHOR_ITEM_PLAIN, AUTHOR_PROBE));

      const itemQuery = (probe: boolean) => db.lnjShelves
        .select(s => ({
          id: s.id,
          books: (probe ? s.books!.lateralJoin(b => b.author) : s.books!).orderBy(b => b.title).select(b => project(b)).toList(),
        }))
        .orderBy(s => s.id)
        .toList();

      const itemPlain = await itemQuery(false);
      const itemPlainText = lastStatement(captured);
      const itemProbed = await itemQuery(true);
      const itemProbedText = lastStatement(captured);
      const itemAuthorPlain = /LEFT JOIN "lnj_authors" "author" ON "(lateral_\d+_books)"\."author_id" = "author"\."id"/g;

      expect(itemProbed).toEqual(itemPlain);
      // Off the item's row, as the lateral renders it
      expect(itemProbedText).not.toMatch(itemAuthorPlain);
      expect(itemProbedText).toBe(itemPlainText.replace(itemAuthorPlain, (_, item: string) => AUTHOR_PROBE.replace('"lnj_books"', `"${item}"`)));
    });
  });

  test('an exists() and a count() through the probed path, in a WHERE — of the root row and of a collection\'s item', async () => {
    await withCapture('lateral', async (db, captured) => {
      const southern = (probe: boolean) => (probe ? db.lnjBooks.lateralJoin(b => b.author!.region) : db.lnjBooks)
        .where(b => exists(b.author!.region!.landmarks!.where(l => eq(l.name, 'Dune'))))
        .select(b => ({ id: b.id, title: b.title }))
        .orderBy(b => b.id)
        .toList();

      const plainBooks = await southern(false);
      const plainBooksText = lastStatement(captured);
      const probedBooks = await southern(true);
      const probedBooksText = lastStatement(captured);

      expect(probedBooks).toEqual(plainBooks);
      expect(probedBooks.map(b => b.title)).toEqual(['Beta']);
      expect(probedBooksText).not.toContain(ITEM_REGION_PLAIN);
      expect(probedBooksText).toContain(REGION_PROBE);
      expect(probedBooksText).toBe(regionProbed(plainBooksText));

      const counted = (probe: boolean) => db.lnjShelves
        .select(s => ({
          id: s.id,
          withFjord: (probe ? s.books!.lateralJoin(b => b.author!.region) : s.books!)
            .where(b => exists(b.author!.region!.landmarks!.where(l => eq(l.name, 'Fjord'))))
            .count(),
        }))
        .orderBy(s => s.id)
        .toList();

      const plainCounts = await counted(false);
      const plainCountsText = lastStatement(captured);
      const probedCounts = await counted(true);
      const probedCountsText = lastStatement(captured);

      expect(probedCounts).toEqual(plainCounts);
      expect(probedCounts.map(s => s.withFjord)).toEqual([1, 1]);
      expect(probedCountsText).not.toContain(ITEM_REGION_PLAIN);
      expect(probedCountsText).toContain(REGION_PROBE);
      expect(probedCountsText).toBe(regionProbed(plainCountsText));
    });
  });

  test('every builder carries the probe into the collection: the untyped builders, lateralJoin() after select(), a QueryBatch leg', async () => {
    await withCapture('lateral', async (db, captured) => {
      const landmarks = (b: any) => b.author.region.landmarks.orderBy((l: any) => l.name).select((l: any) => ({ name: l.name })).toList();

      const plain = await db.lnjBooks.select(b => ({ id: b.id, landmarks: landmarks(b) as { name: string }[] })).orderBy(b => b.id).toList();
      const plainText = lastStatement(captured);
      expect(plain.map(b => b.landmarks.map(l => l.name))).toEqual([['Fjord', 'Glacier'], ['Dune'], [], [], ['Fjord', 'Glacier']]);
      expect(plainText).toContain(ITEM_REGION_PLAIN);

      const books = (db as any).getTable('lnj_books');
      const fromWhere = await books
        .where((b: any) => gt(b.id, 0))
        .lateralJoin((b: any) => b.author.region)
        .select((b: any) => ({ id: b.id, landmarks: landmarks(b) }))
        .orderBy((b: any) => b.id)
        .toList();
      expect(fromWhere).toEqual(plain);
      expect(lastStatement(captured)).not.toContain(ITEM_REGION_PLAIN);
      expect(lastStatement(captured)).toContain(REGION_PROBE);

      const fromSelect = await books
        .select((b: any) => ({ id: b.id, landmarks: landmarks(b) }))
        .lateralJoin((b: any) => b.author.region)
        .orderBy((b: any) => b.id)
        .toList();
      expect(fromSelect).toEqual(plain);
      expect(lastStatement(captured)).toBe(regionProbed(plainText));

      const afterSelect = await db.lnjBooks
        .select(b => ({ id: b.id, landmarks: landmarks(b) as { name: string }[] }))
        .lateralJoin(b => b.author!.region)
        .orderBy(b => b.id)
        .toList();
      expect(afterSelect).toEqual(plain);
      expect(lastStatement(captured)).toBe(regionProbed(plainText));

      const batch = new QueryBatch();
      const key = batch.addList(
        db.lnjBooks.lateralJoin(b => b.author!.region).select(b => ({ id: b.id, landmarks: landmarks(b) as { name: string }[] })).orderBy(b => b.id),
        'books',
      );
      captured.length = 0;
      await batch.executeBatch();
      expect(batch.getList(key)).toEqual(plain);
      expect(statements(captured)).toHaveLength(1);
      expect(lastStatement(captured)).not.toContain(ITEM_REGION_PLAIN);
      expect(lastStatement(captured)).toContain(REGION_PROBE);
    });
  });

  test('with the query-build caches on, the probed and the plain shape each keep the text a fresh build renders', async () => {
    await withCapture('lateral', async (db, captured) => {
      const query = (probe: boolean) => db.lnjShelves
        .select(s => ({
          id: s.id,
          books: (probe ? s.books!.lateralJoin(b => b.author!.region) : s.books!)
            .orderBy(b => b.title)
            .select(b => ({ title: b.title, landmarks: b.author!.region!.landmarks!.orderBy(l => l.name).select(l => ({ name: l.name })).toList() }))
            .toList(),
        }))
        .orderBy(s => s.id)
        .toList();

      const plain = await query(false);
      const plainText = lastStatement(captured);
      await query(true);
      const probedText = lastStatement(captured);
      expect(probedText).not.toContain(ITEM_REGION_PLAIN);
      expect(probedText).toBe(regionProbed(plainText));

      // The mock-row prototypes and the LATERAL text memo are shared by every build of a shape; the probe is part of
      // the shape: neither text is ever served for the other
      MockRowCache.setEnabled(true);

      try {
        for (let round = 0; round < 2; round++) {
          expect(await query(true)).toEqual(plain);
          expect(lastStatement(captured)).toBe(probedText);
          expect(await query(false)).toEqual(plain);
          expect(lastStatement(captured)).toBe(plainText);
        }
      } finally {
        MockRowCache.reset();
        LateralSqlCache.reset();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Refused uses
// ---------------------------------------------------------------------------

describe('lateralJoin() — refused uses', () => {
  test('the selector must return a reference navigation of the row itself', async () => {
    await withCapture('lateral', async (db) => {
      // @ts-expect-error — a column: refused at compile time as well
      expect(() => db.lnjBooks.lateralJoin(b => b.title)).toThrow(/lateralJoin\(\) takes a reference navigation of the "lnj_books" row/);
      // A column reached through a navigation (a path of references is taken: see "a nested reference path")
      // @ts-expect-error — a column reached through a navigation: refused at compile time as well
      expect(() => db.lnjBooks.lateralJoin(b => b.author!.name)).toThrow(/lateralJoin\(\) takes a reference navigation of the "lnj_books" row/);
      // @ts-expect-error — a collection: refused at compile time as well
      expect(() => db.lnjShelves.lateralJoin(s => s.books)).toThrow(/lateralJoin\(\): "books" is a collection of "lnj_shelves"/);

      await expectToReject(
        // @ts-expect-error — a column: refused at compile time as well
        () => db.lnjShelves.select(s => ({ titles: s.books!.lateralJoin(b => b.title).select(b => b.title).toList() })).toList(),
        /lateralJoin\(\) takes a reference navigation of the "lnj_books" row/,
      );
    });
  });

  test('update() and delete() refuse it: PostgreSQL lets no LATERAL subquery read the row they write', async () => {
    await withCapture('lateral', async (db) => {
      expect(() => db.lnjBooks.lateralJoin(b => b.author).where(b => eq(b.author!.name, 'Ann')).update({ title: 'x' }))
        .toThrow(/lateralJoin\(\) cannot be combined with update\(\)/);
      expect(() => db.lnjBooks.lateralJoin(b => b.author).where(b => eq(b.author!.name, 'Ann')).delete())
        .toThrow(/lateralJoin\(\) cannot be combined with delete\(\)/);

      // Nothing was written
      expect(await db.lnjBooks.count()).toBe(5);
      expect(await db.lnjBooks.where(b => eq(b.title, 'x')).count()).toBe(0);
    });
  });

  test('a grouped query refuses it', async () => {
    await withCapture('lateral', async (db) => {
      expect(() => db.lnjBooks
        .lateralJoin(b => b.author)
        .select(b => ({ id: b.id, author: b.author!.name }))
        .groupBy(r => ({ author: r.author })))
        .toThrow(/lateralJoin\(\) is not supported on a grouped query/);
    });
  });

  test('a collection flattened by selectMany() refuses it, before or after', async () => {
    await withCapture('lateral', async (db) => {
      await expectToReject(
        () => db.lnjRegions.select(r => ({ titles: r.authors!.lateralJoin(a => a.mentor).selectMany(a => a.books!).select(b => b.title).toList() })).toList(),
        /lateralJoin\(\) is not supported on a collection flattened by selectMany\(\)/,
      );
      await expectToReject(
        () => db.lnjRegions.select(r => ({ titles: r.authors!.selectMany(a => a.books!).lateralJoin(b => b.shelf).select(b => b.title).toList() })).toList(),
        /lateralJoin\(\) is not supported on a collection flattened by selectMany\(\)/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

describe('lateralJoin() — planner', () => {
  // The in-memory engine has no join planner to ask: there the test compares the rows only
  const planner = process.env.LINKGRESS_TEST_DB !== 'memory';

  test('the plain join can be merge-joined; the probe leaves only a per-row key lookup', async () => {
    await withCapture('lateral', async (db, captured) => {
      const plain = await db.lnjBooks.select(b => ({ id: b.id, author: b.author!.name })).toList();
      const plainText = lastStatement(captured);
      const probed = await db.lnjBooks.lateralJoin(b => b.author).select(b => ({ id: b.id, author: b.author!.name })).toList();
      const probedText = lastStatement(captured);

      expect(byId(probed)).toEqual(byId(plain));

      if (!planner) {
        return;
      }

      // Hash joins and nested loops off: a plain join falls back to a merge join, while the probe CAN
      // only be a nested loop over an index lookup of the author's key
      const explain = (text: string) => db.transaction(async tx => {
        await tx.query('SET LOCAL enable_hashjoin = off');
        await tx.query('SET LOCAL enable_nestloop = off');
        await tx.query('SET LOCAL enable_seqscan = off');
        const rows = await tx.query(`EXPLAIN (COSTS OFF) ${text}`);

        return rows.map((row: any) => row['QUERY PLAN']).join('\n');
      });

      const plainPlan = await explain(plainText);
      const probedPlan = await explain(probedText);

      expect(plainPlan).toMatch(/Merge (Left |Right )?Join/);
      expect(probedPlan).not.toMatch(/Merge (Left |Right )?Join/);
      expect(probedPlan).toMatch(/Nested Loop/);
      expect(probedPlan).toMatch(/Index (Only )?Scan using \S+ on lnj_authors author__probe/);
    });
  });

  test('a nested probe takes the merge join of its own hop away, and only that one', async () => {
    await withCapture('lateral', async (db, captured) => {
      const project = (query: IEntityQueryable<LnjBook>) => query.select(b => ({ id: b.id, region: b.author!.region!.name })).toList();

      const plain = await project(db.lnjBooks);
      const plainText = lastStatement(captured);
      const nested = await project(db.lnjBooks.lateralJoin(b => b.author!.region));
      const nestedText = lastStatement(captured);
      const both = await project(db.lnjBooks.lateralJoin(b => b.author).lateralJoin(b => b.author!.region));
      const bothText = lastStatement(captured);

      expect(byId(nested)).toEqual(byId(plain));
      expect(byId(both)).toEqual(byId(plain));

      if (!planner) {
        return;
      }

      const explain = (text: string) => db.transaction(async tx => {
        await tx.query('SET LOCAL enable_hashjoin = off');
        await tx.query('SET LOCAL enable_nestloop = off');
        await tx.query('SET LOCAL enable_seqscan = off');
        const rows = await tx.query(`EXPLAIN (COSTS OFF) ${text}`);

        return rows.map((row: any) => row['QUERY PLAN']).join('\n');
      });
      const mergeJoins = (plan: string): number => (plan.match(/Merge (Left |Right |Full )?Join/g) ?? []).length;

      const plainPlan = await explain(plainText);
      const nestedPlan = await explain(nestedText);
      const bothPlan = await explain(bothText);

      // Plain: both hops merge-joined. The nested probe: books → authors still is, the region is one key lookup per
      // row (the regions are read nowhere else). Both hops probed: no merge join left
      expect(mergeJoins(plainPlan)).toBe(2);
      expect(mergeJoins(nestedPlan)).toBe(1);
      expect(nestedPlan).toMatch(/Index (Only )?Scan using \S+ on lnj_regions region__probe/);
      expect(nestedPlan).not.toMatch(/on lnj_regions region(?!__)/);
      expect(mergeJoins(bothPlan)).toBe(0);
      expect(bothPlan).toMatch(/Index (Only )?Scan using \S+ on lnj_authors author__probe/);
      expect(bothPlan).toMatch(/Index (Only )?Scan using \S+ on lnj_regions region__probe/);
    });
  });

  test('a collection hanging off the probed path reads it through the probes only — its re-join of the path included', async () => {
    await withCapture('lateral', async (db, captured) => {
      const project = (probes: 'none' | 'region' | 'both') => db.lnjShelves
        .select((s) => {
          const books = probes === 'none'
            ? s.books!
            : probes === 'region'
              ? s.books!.lateralJoin(b => b.author!.region)
              : s.books!.lateralJoin(b => b.author).lateralJoin(b => b.author!.region);

          return {
            id: s.id,
            books: books
              .orderBy(b => b.id)
              .select(b => ({
                id: b.id,
                region: b.author!.region!.name,
                landmarks: b.author!.region!.landmarks!.orderBy(l => l.name).select(l => ({ name: l.name })).toList(),
              }))
              .toList(),
          };
        })
        .orderBy(s => s.id)
        .toList();

      const plain = await project('none');
      const plainText = lastStatement(captured);
      const region = await project('region');
      const regionText = lastStatement(captured);
      const both = await project('both');
      const bothText = lastStatement(captured);

      expect(region).toEqual(plain);
      expect(both).toEqual(plain);

      if (!planner) {
        return;
      }

      const explain = (text: string) => db.transaction(async tx => {
        await tx.query('SET LOCAL enable_hashjoin = off');
        await tx.query('SET LOCAL enable_nestloop = off');
        await tx.query('SET LOCAL enable_seqscan = off');
        const rows = await tx.query(`EXPLAIN (COSTS OFF) ${text}`);

        return rows.map((row: any) => row['QUERY PLAN']).join('\n');
      });
      const mergeJoins = (plan: string): number => (plan.match(/Merge (Left |Right |Full )?Join/g) ?? []).length;

      const plainPlan = await explain(plainText);
      const regionPlan = await explain(regionText);
      const bothPlan = await explain(bothText);

      // The landmarks' subquery joins the path anew from the book row. Plain: both hops are merge-joined in the books'
      // FROM, and again in that subquery (the landmarks merged in on the region's key). The region probed: the
      // regions are read through key lookups of the probe only — in the subquery as well, which has no merge join
      // left — and the books → authors hop of the books' FROM is the one merge join. Both hops probed: none
      expect(mergeJoins(plainPlan)).toBe(4);
      expect(plainPlan).toMatch(/on lnj_regions region(?!__)/);
      expect(mergeJoins(regionPlan)).toBe(1);
      expect(regionPlan).not.toMatch(/on lnj_regions region(?!__)/);
      expect(regionPlan).toMatch(/Index (Only )?Scan using \S+ on lnj_regions region__probe/);
      expect(mergeJoins(bothPlan)).toBe(0);
      expect(bothPlan).not.toMatch(/on lnj_authors author(?!__)/);
      expect(bothPlan).not.toMatch(/on lnj_regions region(?!__)/);
    });
  });
});
