/**
 * `lateralJoin(row => row.<reference>)`: ONE reference navigation joined as a LATERAL probe of its
 * target's key instead of a plain join.
 *
 *   regions <- authors (region, mentor -> authors) <- books (author, activeAuthor, shelf -> shelves)
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
 * The fixture: Gamma has no author (an unmatched LEFT join), Ben is not active (the constant key part of
 * `activeAuthor` matches him nowhere), Cyd has no region, Ann has no mentor.
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
// Refused uses
// ---------------------------------------------------------------------------

describe('lateralJoin() — refused uses', () => {
  test('the selector must return a reference navigation of the row itself', async () => {
    await withCapture('lateral', async (db) => {
      expect(() => db.lnjBooks.lateralJoin(b => b.title)).toThrow(/lateralJoin\(\) takes a reference navigation of the "lnj_books" row/);
      expect(() => db.lnjBooks.lateralJoin(b => b.author!.region)).toThrow(/lateralJoin\(\) takes a reference navigation of the "lnj_books" row/);
      expect(() => db.lnjShelves.lateralJoin(s => s.books)).toThrow(/lateralJoin\(\): "books" is a collection of "lnj_shelves"/);

      await expectToReject(
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
});
