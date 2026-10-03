/**
 * `lateralJoin()` — the coverage matrix.
 *
 * `tests/queries/lateral-navigation-join.test.ts` pins the shapes each release added, one by one. This file
 * generates the cases from the dimensions the feature has and runs every one of them against two oracles:
 *
 *   1. the rows — the query run WITHOUT `lateralJoin()` returns the same rows (in the same order where the
 *      query orders them), on every engine the suite runs on (PostgreSQL, PGlite, in memory);
 *   2. the SQL — every statement is the statement the plain query runs, with each plain join of a probed hop
 *      (the row's own, and every re-join a subquery makes of it) replaced by its LATERAL probe
 *      (`renderLateralNavigationJoin`: every key pair, a constant part included, in the probe's WHERE), and
 *      nothing else changed — the parameters included. At least one join must have been replaced.
 *
 * The dimensions: the builder `lateralJoin()` is called on (a table, after `where()`, after `with()`, after `select()`,
 * after a join of a table or a table subquery, at the end of the chain, through `IEntityQueryable`, the untyped
 * builders); the path (1, 2, 3 hops; optional and
 * required hops; a table navigating to itself; the same table reached by two paths; a prefix and the full path;
 * the same path twice; independent paths); the key (one column; composite; a constant part on either side; a
 * principal key that is not `id`; a nullable and a dangling foreign key; a custom-typed key); what reads the
 * probed row (columns along the path, the row projected whole, nested objects, mapped columns, a WHERE —
 * `isNull()` included —, an ORDER BY, aggregates); the terminal (`toList`, `first*`, `count`, `exists`,
 * `min` / `max` / `sum`, a page, DISTINCT, `countOver`, futures, batches, unions, `prepare()`, subqueries, CTEs,
 * `insertFrom()`, a mutation's WHERE); collections (of the item, off the probed hop, off a hop before and beyond
 * it, nested, with their own filter / order / limit, aggregates) under the three collection strategies; and the
 * query-build caches. Uses that cannot be probed are refused when the query is built — never rendered plainly.
 *
 *   ljm_landmarks -> ljm_regions <- ljm_authors (region, home by code, mentor, publisher by (country, code))
 *                                   ljm_authors <- ljm_books (author, coAuthor, activeAuthor, currentAuthor, shelf)
 *                                   ljm_books <- ljm_copies (book)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import { AssertType } from '../utils/type-tester';
import {
  DatabaseClient,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  FutureQueryRunner,
  IEntityQueryable,
  LateralSqlCache,
  MockRowCache,
  NavigationPathCache,
  QueryBatch,
  and,
  boolean,
  createCustomType,
  date,
  enumColumn,
  eq,
  exists,
  gt,
  inSubquery,
  integer,
  isNotNull,
  isNull,
  jsonbArrayElements,
  jsonb,
  notExists,
  notInSubquery,
  pgEnum,
  sql,
  timestamp,
  varchar,
  win,
} from '../../src';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A key read through a custom mapper: the region's code. */
class RegionCode {
  constructor(readonly value: string) {}
}

const regionCodeType = createCustomType<{ data: RegionCode; driverData: string }>({
  dataType: () => 'varchar',
  toDriver: (value: RegionCode | null | undefined) => (value == null ? null : value.value) as string,
  fromDriver: (value: string | null | undefined) => (value == null ? null : new RegionCode(String(value))) as RegionCode,
});

const authorKind = pgEnum('ljm_author_kind', ['novelist', 'poet'] as const);

class LjmRegion extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<RegionCode>;
  name!: DbColumn<string>;
  population!: DbColumn<number>;

  landmarks?: LjmLandmark[];
  authors?: LjmAuthor[];
  activeAuthors?: LjmAuthor[];
}

class LjmLandmark extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  regionId!: DbColumn<number>;
  height!: DbColumn<number>;

  region?: LjmRegion;
}

class LjmPublisher extends DbEntity {
  country!: DbColumn<string>;
  code!: DbColumn<number>;
  name!: DbColumn<string>;

  authors?: LjmAuthor[];
}

class LjmAuthor extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  active!: DbColumn<boolean>;
  regionId!: DbColumn<number | null>;
  homeCode!: DbColumn<RegionCode>;
  mentorId!: DbColumn<number | null>;
  publisherCountry!: DbColumn<string | null>;
  publisherCode!: DbColumn<number | null>;
  kind!: DbColumn<'novelist' | 'poet'>;
  born!: DbColumn<Date>;
  profile!: DbColumn<{ genres: string[] } | null>;

  region?: LjmRegion;
  home?: LjmRegion;
  mentor?: LjmAuthor;
  publisher?: LjmPublisher;
  books?: LjmBook[];
  mentees?: LjmAuthor[];
}

class LjmShelf extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;

  books?: LjmBook[];
}

class LjmBook extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  shelfId!: DbColumn<number>;
  authorId!: DbColumn<number | null>;
  coAuthorId!: DbColumn<number | null>;
  isCurrent!: DbColumn<boolean>;
  pages!: DbColumn<number>;
  published!: DbColumn<Date>;

  shelf?: LjmShelf;
  author?: LjmAuthor;
  coAuthor?: LjmAuthor;
  activeAuthor?: LjmAuthor;
  currentAuthor?: LjmAuthor;
  authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast?: LjmAuthor;
  copies?: LjmCopy[];
}

class LjmCopy extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;
  condition!: DbColumn<string>;

  book?: LjmBook;
}

class LjmDatabase extends DbContext {
  get ljmRegions(): DbEntityTable<LjmRegion> {
    return this.table(LjmRegion);
  }

  get ljmLandmarks(): DbEntityTable<LjmLandmark> {
    return this.table(LjmLandmark);
  }

  get ljmPublishers(): DbEntityTable<LjmPublisher> {
    return this.table(LjmPublisher);
  }

  get ljmAuthors(): DbEntityTable<LjmAuthor> {
    return this.table(LjmAuthor);
  }

  get ljmShelves(): DbEntityTable<LjmShelf> {
    return this.table(LjmShelf);
  }

  get ljmBooks(): DbEntityTable<LjmBook> {
    return this.table(LjmBook);
  }

  get ljmCopies(): DbEntityTable<LjmCopy> {
    return this.table(LjmCopy);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(LjmRegion, entity => {
      entity.toTable('ljm_regions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ljm_regions_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 8).unique()).isRequired().hasCustomMapper(regionCodeType);
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.population).hasType(integer('population')).isRequired();

      entity.hasMany(e => e.landmarks, () => LjmLandmark).withForeignKey(l => l.regionId).withPrincipalKey(r => r.id);
      entity.hasMany(e => e.authors, () => LjmAuthor).withForeignKey(a => a.regionId).withPrincipalKey(r => r.id);
      // A constant key part on the principal side: the region's active authors
      entity.hasMany(e => e.activeAuthors, () => LjmAuthor)
        .withForeignKey(a => [a.regionId, a.active])
        .withPrincipalKey(r => [r.id, true])
        .isInverseNavigation();
    });

    model.entity(LjmLandmark, entity => {
      entity.toTable('ljm_landmarks');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ljm_landmarks_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.regionId).hasType(integer('region_id')).isRequired();
      entity.property(e => e.height).hasType(integer('height')).isRequired();

      // Required: an INNER join
      entity.hasOne(e => e.region, () => LjmRegion).withForeignKey(l => l.regionId).withPrincipalKey(r => r.id).isRequired();
    });

    model.entity(LjmPublisher, entity => {
      entity.toTable('ljm_publishers');
      entity.property(e => e.country).hasType(varchar('country', 2).primaryKey());
      entity.property(e => e.code).hasType(integer('code').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();

      // A composite key
      entity.hasMany(e => e.authors, () => LjmAuthor)
        .withForeignKey(a => [a.publisherCountry, a.publisherCode])
        .withPrincipalKey(p => [p.country, p.code])
        .isInverseNavigation();
    });

    model.entity(LjmAuthor, entity => {
      entity.toTable('ljm_authors');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ljm_authors_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.active).hasType(boolean('active')).isRequired();
      entity.property(e => e.regionId).hasType(integer('region_id'));
      entity.property(e => e.homeCode).hasType(varchar('home_code', 8)).isRequired().hasCustomMapper(regionCodeType);
      entity.property(e => e.mentorId).hasType(integer('mentor_id'));
      entity.property(e => e.publisherCountry).hasType(varchar('publisher_country', 2));
      entity.property(e => e.publisherCode).hasType(integer('publisher_code'));
      entity.property(e => e.kind).hasType(enumColumn('kind', authorKind)).isRequired();
      entity.property(e => e.born).hasType(date('born')).isRequired();
      entity.property(e => e.profile).hasType(jsonb('profile'));

      entity.hasOne(e => e.region, () => LjmRegion).withForeignKey(a => a.regionId).withPrincipalKey(r => r.id);
      // Required, on a principal key that is not `id` (and a custom-typed one)
      entity.hasOne(e => e.home, () => LjmRegion)
        .withForeignKey(a => a.homeCode)
        .withPrincipalKey(r => r.code)
        .isRequired()
        .isInverseNavigation();
      // A navigation of the table to itself
      entity.hasOne(e => e.mentor, () => LjmAuthor).withForeignKey(a => a.mentorId).withPrincipalKey(m => m.id);
      // A composite key
      entity.hasOne(e => e.publisher, () => LjmPublisher)
        .withForeignKey(a => [a.publisherCountry, a.publisherCode])
        .withPrincipalKey(p => [p.country, p.code])
        .isInverseNavigation();
      entity.hasMany(e => e.books, () => LjmBook).withForeignKey(b => b.authorId).withPrincipalKey(a => a.id);
      entity.hasMany(e => e.mentees, () => LjmAuthor).withForeignKey(m => m.mentorId).withPrincipalKey(a => a.id);
    });

    model.entity(LjmShelf, entity => {
      entity.toTable('ljm_shelves');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ljm_shelves_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();

      entity.hasMany(e => e.books, () => LjmBook).withForeignKey(b => b.shelfId).withPrincipalKey(s => s.id);
    });

    model.entity(LjmBook, entity => {
      entity.toTable('ljm_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ljm_books_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 50)).isRequired();
      entity.property(e => e.shelfId).hasType(integer('shelf_id')).isRequired();
      entity.property(e => e.authorId).hasType(integer('author_id'));
      entity.property(e => e.coAuthorId).hasType(integer('co_author_id'));
      entity.property(e => e.isCurrent).hasType(boolean('is_current')).isRequired();
      entity.property(e => e.pages).hasType(integer('pages')).isRequired();
      entity.property(e => e.published).hasType(timestamp('published')).isRequired();

      // Required: an INNER join
      entity.hasOne(e => e.shelf, () => LjmShelf).withForeignKey(b => b.shelfId).withPrincipalKey(s => s.id).isRequired();
      // No constraint: a book may hold the key of an author that does not exist (a dangling key)
      entity.hasOne(e => e.author, () => LjmAuthor).withForeignKey(b => b.authorId).withPrincipalKey(a => a.id).isInverseNavigation();
      // The same table, reached by another path
      entity.hasOne(e => e.coAuthor, () => LjmAuthor).withForeignKey(b => b.coAuthorId).withPrincipalKey(a => a.id).isInverseNavigation();
      // A constant key part on the principal side of the join: the author, when active
      entity.hasOne(e => e.activeAuthor, () => LjmAuthor)
        .withForeignKey(b => [b.authorId, true])
        .withPrincipalKey(a => [a.id, a.active])
        .isInverseNavigation();
      // A constant key part on the foreign-key side: the author, when the book is current
      entity.hasOne(e => e.currentAuthor, () => LjmAuthor)
        .withForeignKey(b => [b.authorId, b.isCurrent])
        .withPrincipalKey(a => [a.id, true])
        .isInverseNavigation();
      // A navigation whose probe alias ("<alias>__probe") passes PostgreSQL's 63-byte identifier limit
      entity.hasOne(e => e.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast, () => LjmAuthor)
        .withForeignKey(b => b.authorId)
        .withPrincipalKey(a => a.id)
        .isInverseNavigation();
      entity.hasMany(e => e.copies, () => LjmCopy).withForeignKey(c => c.bookId).withPrincipalKey(b => b.id);
    });

    model.entity(LjmCopy, entity => {
      entity.toTable('ljm_copies');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ljm_copies_id_seq' }));
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.condition).hasType(varchar('condition', 20)).isRequired();

      entity.hasOne(e => e.book, () => LjmBook).withForeignKey(c => c.bookId).withPrincipalKey(b => b.id).isRequired().isInverseNavigation();
    });
  }
}

const dropSchema = async (client: DatabaseClient): Promise<void> => {
  for (const table of ['ljm_copies', 'ljm_books', 'ljm_shelves', 'ljm_authors', 'ljm_publishers', 'ljm_landmarks', 'ljm_regions']) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await client.query('DROP TYPE IF EXISTS ljm_author_kind CASCADE');
};

/**
 * The fixture. North (2 landmarks), South (1), East (none). Publishers (SK, 1), (SK, 2), (CZ, 1): two share the
 * first key part. Ann (North, SK 1) mentors Ben (inactive, South, SK 2), who mentors Cyd (no region, home East,
 * no publisher), who mentors Dee (North, CZ 1). Books: Alpha (Ann, co-author Ben), Beta (Ben), Gamma (no author,
 * co-author Ann), Delta (Cyd, co-author Dee, not current), Eps (Ann), Zeta (a dangling author key). Shelves:
 * Fiction (Alpha, Beta, Gamma), Poetry (Delta, Eps, Zeta), Empty.
 */
const seed = async (db: LjmDatabase): Promise<void> => {
  const [north, south] = await db.ljmRegions.insertBulk([
    { code: new RegionCode('N'), name: 'North', population: 100 },
    { code: new RegionCode('S'), name: 'South', population: 200 },
    { code: new RegionCode('E'), name: 'East', population: 300 },
  ]).returning();

  await db.ljmLandmarks.insertBulk([
    { name: 'Fjord', regionId: north.id, height: 50 },
    { name: 'Glacier', regionId: north.id, height: 80 },
    { name: 'Dune', regionId: south.id, height: 20 },
  ]);

  await db.ljmPublishers.insertBulk([
    { country: 'SK', code: 1, name: 'Tatra' },
    { country: 'SK', code: 2, name: 'Danube' },
    { country: 'CZ', code: 1, name: 'Vltava' },
  ]);

  const author = async (values: Record<string, unknown>): Promise<number> => {
    const [row] = await db.ljmAuthors.insertBulk([values as any]).returning();

    return row.id;
  };

  const ann = await author({
    name: 'Ann', active: true, regionId: north.id, homeCode: new RegionCode('N'), publisherCountry: 'SK', publisherCode: 1,
    kind: 'novelist', born: new Date(1970, 0, 15), profile: { genres: ['saga'] },
  });
  const ben = await author({
    name: 'Ben', active: false, regionId: south.id, homeCode: new RegionCode('S'), mentorId: ann, publisherCountry: 'SK', publisherCode: 2,
    kind: 'poet', born: new Date(1980, 5, 1), profile: { genres: ['ode', 'haiku'] },
  });
  const cyd = await author({
    name: 'Cyd', active: true, homeCode: new RegionCode('E'), mentorId: ben, kind: 'poet', born: new Date(1990, 11, 31),
  });
  await author({
    name: 'Dee', active: true, regionId: north.id, homeCode: new RegionCode('N'), mentorId: cyd, publisherCountry: 'CZ', publisherCode: 1,
    kind: 'novelist', born: new Date(2000, 2, 3), profile: { genres: [] },
  });
  const dee = cyd + 1;

  const [fiction, poetry] = await db.ljmShelves.insertBulk([
    { label: 'Fiction' },
    { label: 'Poetry' },
    { label: 'Empty' },
  ]).returning();

  const published = (day: number): Date => new Date(2020, 0, day, 12, 30, 0);
  const books = await db.ljmBooks.insertBulk([
    { title: 'Alpha', shelfId: fiction.id, authorId: ann, coAuthorId: ben, isCurrent: true, pages: 100, published: published(1) },
    { title: 'Beta', shelfId: fiction.id, authorId: ben, isCurrent: true, pages: 200, published: published(2) },
    { title: 'Gamma', shelfId: fiction.id, coAuthorId: ann, isCurrent: true, pages: 300, published: published(3) },
    { title: 'Delta', shelfId: poetry.id, authorId: cyd, coAuthorId: dee, isCurrent: false, pages: 400, published: published(4) },
    { title: 'Eps', shelfId: poetry.id, authorId: ann, isCurrent: true, pages: 500, published: published(5) },
    { title: 'Zeta', shelfId: poetry.id, authorId: 999, isCurrent: true, pages: 600, published: published(6) },
  ]).returning();

  await db.ljmCopies.insertBulk([
    { bookId: books[0].id, condition: 'good' },
    { bookId: books[0].id, condition: 'worn' },
    { bookId: books[3].id, condition: 'good' },
    { bookId: books[5].id, condition: 'new' },
  ]);
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Strategy = 'lateral' | 'cte' | 'temptable';
const STRATEGIES: readonly Strategy[] = ['lateral', 'cte', 'temptable'];

/** The engine this run is on: the in-memory database has no planner to ask. */
const ENGINE = (process.env.LINKGRESS_TEST_DB || '').toLowerCase() === 'memory' ? 'memory' : process.env.LINKGRESS_TEST_DRIVER === 'pglite' ? 'pglite' : 'postgres';

interface Statement {
  readonly sql: string;
  params: unknown[];
}

/** Every statement the contexts ran, in order, with its parameters. */
const log: Statement[] = [];

const logger = (message: string, section?: string): void => {
  if (section === 'params') {
    const last = log[log.length - 1];

    if (last !== undefined && message.startsWith('[Parameters] ')) {
      last.params = JSON.parse(message.slice('[Parameters] '.length));
    }

    return;
  }

  if (!message.trimStart().startsWith('[')) {
    log.push({ sql: message, params: [] });
  }
};

let client: DatabaseClient;
const dbs = {} as Record<Strategy, LjmDatabase>;

beforeAll(async () => {
  client = createFreshClient();

  for (const strategy of STRATEGIES) {
    dbs[strategy] = new LjmDatabase(client, { logQueries: true, logParameters: true, collectionStrategy: strategy, logger: logger as any });
  }

  await dropSchema(client);
  try { await dbs.lateral.getSchemaManager().ensureCreated(); } catch (e) { console.log(log.slice(-3).map(s => s.sql).join('\n---\n')); throw e; }
  await seed(dbs.lateral);
  log.length = 0;
});

afterAll(async () => {
  try {
    await dropSchema(client);
  } finally {
    await client.end();
  }
});

interface Run {
  readonly result: unknown;
  readonly statements: Statement[];
}

const capture = async (run: () => Promise<unknown>): Promise<Run> => {
  const start = log.length;
  const result = await run();

  return { result, statements: log.slice(start) };
};

/**
 * A hop `lateralJoin()` probes, as its plain join renders: the joined table (as the FROM item names it), the
 * alias, and the alias its foreign key is read off — the row's table, a LATERAL's item alias, or the hop before.
 */
interface Hop {
  readonly table: string;
  readonly alias: string;
  readonly source: string | RegExp;
}

const hop = (table: string, alias: string, source: string | RegExp): Hop => ({ table: `"${table}"`, alias, source });

/** A plain navigation join, one per line: `<kind> <table> [AS] "<alias>" ON <pair> [AND <pair>…]`. */
const PLAIN_JOIN = /^([ \t]*)(LEFT JOIN|INNER JOIN|JOIN) ("[^"]+"(?:\."[^"]+")?)(?: AS)? "([^"]+)" ON (.+)$/gm;

/** The ON clause's key pairs: `<source side> = <alias side>`. */
const pairsOf = (on: string): Array<[string, string]> => on.split(' AND ').map((pair) => {
  const [left, right] = pair.split(' = ');

  return [left, right];
});

/** The alias the plain join reads its foreign key off (the first key pair naming a column of another alias). */
const sourceOf = (alias: string, on: string): string | undefined => {
  for (const [left] of pairsOf(on)) {
    const column = /^"([^"]+)"\./.exec(left);

    if (column !== null && column[1] !== alias) {
      return column[1];
    }
  }

  return undefined;
};

/** The probe `renderLateralNavigationJoin` renders for the plain join of `alias` to `table` on `on`. */
const probeOf = (kind: string, table: string, alias: string, on: string): string => {
  const probe = `${alias}__probe`;
  // Plain: `<source side> = <alias side>`. Probe: `<probe side> = <source side>`
  const keys = pairsOf(on).map(([left, right]) => `${right.split(`"${alias}".`).join(`"${probe}".`)} = ${left}`);

  return `${kind === 'LEFT JOIN' ? 'LEFT' : 'INNER'} JOIN LATERAL (SELECT "${probe}".* FROM ${table} "${probe}" WHERE ${keys.join(' AND ')} OFFSET 0) "${alias}" ON true`;
};

const matchesSource = (pattern: string | RegExp, source: string | undefined): boolean =>
  source !== undefined && (typeof pattern === 'string' ? pattern === source : pattern.test(source));

/** `plain` with every plain join of `hops` replaced by its probe, and how many were replaced. */
const withProbes = (plain: string, hops: readonly Hop[]): { text: string; replaced: number } => {
  let replaced = 0;
  const text = plain.replace(PLAIN_JOIN, (line, indent: string, kind: string, table: string, alias: string, rest: string) => {
    // The line may close parentheses the join is nested in (a CTE body, a subquery): they are not the ON's
    let on = rest;
    let closing = '';

    while (on.endsWith(')') && (on.match(/\(/g) ?? []).length < (on.match(/\)/g) ?? []).length) {
      on = on.slice(0, -1);
      closing += ')';
    }

    const source = sourceOf(alias, on);

    if (!hops.some(h => h.table === table && h.alias === alias && matchesSource(h.source, source))) {
      return line;
    }

    replaced++;

    return `${indent}${probeOf(kind, table, alias, on)}${closing}`;
  });

  return { text, replaced };
};

/** Rows compared as a set: a query without ORDER BY may return them in any order, plain or probed. */
const asSet = (value: unknown): unknown => (Array.isArray(value) ? value.map(row => JSON.stringify(row)).sort() : value);

/** One case of the matrix. */
interface MatrixCase {
  /** A stable id: `<group>/<dimension values>`. */
  readonly id: string;
  /** The collection strategies it runs under (those it can tell apart: a query without collections runs once). */
  readonly strategies: readonly Strategy[];
  /** Runs the query, probed or plain, and returns what it read. */
  readonly run: (db: LjmDatabase, probe: boolean) => Promise<unknown>;
  /** The hops whose plain joins the probe replaces (per strategy: a LATERAL renders the item under its own alias). */
  readonly hops: readonly Hop[] | ((strategy: Strategy) => readonly Hop[]);
  /** Whether the rows come in a defined order. */
  readonly ordered: boolean;
  /** What the plain query reads, when the case pins it (both runs must read it). */
  readonly expected?: unknown;
  /** How the read value is reduced before it is compared to `expected`. */
  readonly view?: (result: unknown) => unknown;
  /** `0`: the probe has nothing to replace (the query joins nothing of the path) — the text must not change. */
  readonly probes?: 0;
  /** What both runs must satisfy beyond reading the same rows (a read compared with another builder's, say). */
  readonly assert?: (result: unknown) => void;
}

const checkCase = async (matrixCase: MatrixCase, strategy: Strategy): Promise<void> => {
  const db = dbs[strategy];
  const plain = await capture(() => matrixCase.run(db, false));
  const probed = await capture(() => matrixCase.run(db, true));

  // 1. The same rows
  if (matrixCase.ordered) {
    expect(probed.result).toEqual(plain.result);
  } else {
    expect(asSet(probed.result)).toEqual(asSet(plain.result));
  }

  if (matrixCase.assert !== undefined) {
    matrixCase.assert(plain.result);
    matrixCase.assert(probed.result);
  }

  if (matrixCase.expected !== undefined) {
    const view = matrixCase.view ?? ((result: unknown) => result);
    expect(view(plain.result)).toEqual(matrixCase.expected);
  }

  // 2. The same statements, but every plain join of a probed hop is its probe — and the same parameters
  const hops = typeof matrixCase.hops === 'function' ? matrixCase.hops(strategy) : matrixCase.hops;
  let replaced = 0;
  const expectedTexts = plain.statements.map((statement) => {
    const probedText = withProbes(statement.sql, hops);
    replaced += probedText.replaced;

    return probedText.text;
  });

  expect(probed.statements.map(statement => statement.sql)).toEqual(expectedTexts);
  expect(probed.statements.map(statement => statement.params)).toEqual(plain.statements.map(statement => statement.params));

  if (matrixCase.probes === 0) {
    expect(replaced).toBe(0);
  } else {
    expect(replaced).toBeGreaterThan(0);
  }
};

const runMatrix = (cases: readonly MatrixCase[]): void => {
  for (const matrixCase of cases) {
    for (const strategy of matrixCase.strategies) {
      test(`${matrixCase.id}${matrixCase.strategies.length > 1 ? ` [${strategy}]` : ''}`, async () => {
        await checkCase(matrixCase, strategy);
      });
    }
  }
};

// ---------------------------------------------------------------------------
// The paths
// ---------------------------------------------------------------------------

type Row = any;

/** A path `lateralJoin()` can name, from a book, with what reads it. */
interface ProbePath {
  readonly name: string;
  /** The selectors of `lateralJoin()` — one per probed path (several for the combined forms). */
  readonly probes: ReadonlyArray<(b: Row) => unknown>;
  /** The hops the probes replace in the row's own FROM. */
  readonly hops: readonly Hop[];
  /** A projection reading a column of every hop of the path. */
  readonly read: (b: Row) => Record<string, unknown>;
  /** The probed row projected whole. */
  readonly whole: (b: Row) => unknown;
  /** Mapped columns of the probed row (custom types, enums, dates, JSON). */
  readonly mapped: (b: Row) => Record<string, unknown>;
  /** A column of the probed row, a value it holds for some rows, and a column that is NULL exactly when the row is missing. */
  readonly column: (b: Row) => any;
  readonly value: unknown;
  readonly key: (b: Row) => any;
}

const BOOKS = 'ljm_books';

const PATHS: readonly ProbePath[] = [
  {
    name: 'author (optional, nullable and dangling key)',
    probes: [b => b.author],
    hops: [hop('ljm_authors', 'author', BOOKS)],
    read: b => ({ author: b.author.name }),
    whole: b => b.author,
    mapped: b => ({ kind: b.author.kind, born: b.author.born, profile: b.author.profile, home: b.author.homeCode }),
    column: b => b.author.name,
    value: 'Ann',
    key: b => b.author.id,
  },
  {
    name: 'shelf (required)',
    probes: [b => b.shelf],
    hops: [hop('ljm_shelves', 'shelf', BOOKS)],
    read: b => ({ shelf: b.shelf.label }),
    whole: b => b.shelf,
    mapped: b => ({ label: b.shelf.label, id: b.shelf.id }),
    column: b => b.shelf.label,
    value: 'Poetry',
    key: b => b.shelf.id,
  },
  {
    name: 'activeAuthor (a constant key part on the principal side)',
    probes: [b => b.activeAuthor],
    hops: [hop('ljm_authors', 'activeAuthor', BOOKS)],
    read: b => ({ author: b.activeAuthor.name }),
    whole: b => b.activeAuthor,
    mapped: b => ({ kind: b.activeAuthor.kind, born: b.activeAuthor.born, profile: b.activeAuthor.profile }),
    column: b => b.activeAuthor.name,
    value: 'Ann',
    key: b => b.activeAuthor.id,
  },
  {
    name: 'currentAuthor (a constant key part on the foreign-key side)',
    probes: [b => b.currentAuthor],
    hops: [hop('ljm_authors', 'currentAuthor', BOOKS)],
    read: b => ({ author: b.currentAuthor.name }),
    whole: b => b.currentAuthor,
    mapped: b => ({ kind: b.currentAuthor.kind, home: b.currentAuthor.homeCode }),
    column: b => b.currentAuthor.name,
    value: 'Cyd',
    key: b => b.currentAuthor.id,
  },
  {
    name: 'author.region (two optional hops)',
    probes: [b => b.author.region],
    hops: [hop('ljm_regions', 'region', 'author')],
    read: b => ({ author: b.author.name, region: b.author.region.name }),
    whole: b => b.author.region,
    mapped: b => ({ code: b.author.region.code, population: b.author.region.population }),
    column: b => b.author.region.name,
    value: 'North',
    key: b => b.author.region.id,
  },
  {
    name: 'author.home (optional, then required on a custom-typed principal key that is not id)',
    probes: [b => b.author.home],
    hops: [hop('ljm_regions', 'home', 'author')],
    read: b => ({ author: b.author.name, home: b.author.home.name }),
    whole: b => b.author.home,
    mapped: b => ({ code: b.author.home.code, population: b.author.home.population }),
    column: b => b.author.home.name,
    value: 'East',
    key: b => b.author.home.id,
  },
  {
    name: 'author.publisher (a composite key)',
    probes: [b => b.author.publisher],
    hops: [hop('ljm_publishers', 'publisher', 'author')],
    read: b => ({ author: b.author.name, publisher: b.author.publisher.name }),
    whole: b => b.author.publisher,
    mapped: b => ({ country: b.author.publisher.country, code: b.author.publisher.code }),
    column: b => b.author.publisher.name,
    value: 'Danube',
    key: b => b.author.publisher.country,
  },
  {
    name: 'author.mentor (a table navigating to itself)',
    probes: [b => b.author.mentor],
    hops: [hop('ljm_authors', 'mentor', 'author')],
    read: b => ({ author: b.author.name, mentor: b.author.mentor.name }),
    whole: b => b.author.mentor,
    mapped: b => ({ kind: b.author.mentor.kind, born: b.author.mentor.born }),
    column: b => b.author.mentor.name,
    value: 'Ann',
    key: b => b.author.mentor.id,
  },
  {
    name: 'author.mentor.region (three hops)',
    probes: [b => b.author.mentor.region],
    hops: [hop('ljm_regions', 'region', 'mentor')],
    read: b => ({ author: b.author.name, mentor: b.author.mentor.name, region: b.author.mentor.region.name }),
    whole: b => b.author.mentor.region,
    mapped: b => ({ code: b.author.mentor.region.code }),
    column: b => b.author.mentor.region.name,
    value: 'South',
    key: b => b.author.mentor.region.id,
  },
  {
    name: 'author.mentor.mentor (three hops, the same relation twice)',
    probes: [b => b.author.mentor.mentor],
    hops: [hop('ljm_authors', 'mentor__mentor', 'mentor')],
    read: b => ({ author: b.author.name, mentor: b.author.mentor.name, grandMentor: b.author.mentor.mentor.name }),
    whole: b => b.author.mentor.mentor,
    mapped: b => ({ kind: b.author.mentor.mentor.kind }),
    column: b => b.author.mentor.mentor.name,
    value: 'Ann',
    key: b => b.author.mentor.mentor.id,
  },
  {
    name: 'coAuthor (the same table as author, by another path)',
    probes: [b => b.coAuthor],
    hops: [hop('ljm_authors', 'coAuthor', BOOKS)],
    read: b => ({ author: b.author.name, coAuthor: b.coAuthor.name }),
    whole: b => b.coAuthor,
    mapped: b => ({ kind: b.coAuthor.kind }),
    column: b => b.coAuthor.name,
    value: 'Ben',
    key: b => b.coAuthor.id,
  },
  {
    name: 'a navigation whose probe alias passes 63 bytes',
    probes: [b => b.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast],
    hops: [hop('ljm_authors', 'authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast', BOOKS)],
    read: b => ({ author: b.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast.name }),
    whole: b => b.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast,
    mapped: b => ({ kind: b.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast.kind }),
    column: b => b.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast.name,
    value: 'Ben',
    key: b => b.authorUnderANavigationNameLongEnoughToPushItsProbeAliasPast.id,
  },
  {
    name: 'author and author.region (a prefix and the full path)',
    probes: [b => b.author, b => b.author.region],
    hops: [hop('ljm_authors', 'author', BOOKS), hop('ljm_regions', 'region', 'author')],
    read: b => ({ author: b.author.name, region: b.author.region.name }),
    whole: b => b.author.region,
    mapped: b => ({ code: b.author.region.code, kind: b.author.kind }),
    column: b => b.author.region.name,
    value: 'South',
    key: b => b.author.region.id,
  },
  {
    name: 'author.region and author (the full path first)',
    probes: [b => b.author.region, b => b.author],
    hops: [hop('ljm_authors', 'author', BOOKS), hop('ljm_regions', 'region', 'author')],
    read: b => ({ author: b.author.name, region: b.author.region.name }),
    whole: b => b.author,
    mapped: b => ({ code: b.author.region.code }),
    column: b => b.author.name,
    value: 'Ben',
    key: b => b.author.id,
  },
  {
    name: 'author, author.mentor and author.mentor.region (every hop of three)',
    probes: [b => b.author, b => b.author.mentor, b => b.author.mentor.region],
    hops: [hop('ljm_authors', 'author', BOOKS), hop('ljm_authors', 'mentor', 'author'), hop('ljm_regions', 'region', 'mentor')],
    read: b => ({ author: b.author.name, mentor: b.author.mentor.name, region: b.author.mentor.region.name }),
    whole: b => b.author.mentor,
    mapped: b => ({ code: b.author.mentor.region.code }),
    column: b => b.author.mentor.region.name,
    value: 'North',
    key: b => b.author.mentor.region.id,
  },
  {
    name: 'author and shelf (independent paths)',
    probes: [b => b.author, b => b.shelf],
    hops: [hop('ljm_authors', 'author', BOOKS), hop('ljm_shelves', 'shelf', BOOKS)],
    read: b => ({ author: b.author.name, shelf: b.shelf.label }),
    whole: b => b.shelf,
    mapped: b => ({ kind: b.author.kind, label: b.shelf.label }),
    column: b => b.shelf.label,
    value: 'Fiction',
    key: b => b.author.id,
  },
  {
    name: 'author and coAuthor (one table, two paths, both probed)',
    probes: [b => b.author, b => b.coAuthor],
    hops: [hop('ljm_authors', 'author', BOOKS), hop('ljm_authors', 'coAuthor', BOOKS)],
    read: b => ({ author: b.author.name, coAuthor: b.coAuthor.name }),
    whole: b => b.coAuthor,
    mapped: b => ({ kind: b.author.kind, coKind: b.coAuthor.kind }),
    column: b => b.coAuthor.name,
    value: 'Ann',
    key: b => b.coAuthor.id,
  },
  {
    name: 'author, named twice',
    probes: [b => b.author, b => b.author],
    hops: [hop('ljm_authors', 'author', BOOKS)],
    read: b => ({ author: b.author.name }),
    whole: b => b.author,
    mapped: b => ({ kind: b.author.kind }),
    column: b => b.author.name,
    value: 'Ben',
    key: b => b.author.id,
  },
];

/** `query` with every probe of `path` applied (`lateralJoin()` takes one navigation per call). */
function probed<T extends DbEntity>(query: DbEntityTable<T>, path: ProbePath, probe: boolean): IEntityQueryable<T>;
function probed<Q>(query: Q, path: ProbePath, probe: boolean): Q;
function probed(query: any, path: ProbePath, probe: boolean): any {
  return probe ? path.probes.reduce((q, navigation) => q.lateralJoin(navigation), query) : query;
}

// ---------------------------------------------------------------------------
// Root queries: every path, read every way
// ---------------------------------------------------------------------------

interface Reading {
  readonly name: string;
  readonly select: (path: ProbePath) => (b: Row) => Record<string, unknown>;
  readonly where?: (path: ProbePath) => (b: Row) => any;
}

const READINGS: readonly Reading[] = [
  { name: 'its columns', select: path => b => ({ id: b.id, title: b.title, ...path.read(b) }) },
  { name: 'the probed row whole', select: path => b => ({ id: b.id, row: path.whole(b) }) },
  { name: 'a nested object', select: path => b => ({ id: b.id, nested: { title: b.title, inner: path.read(b) } }) },
  { name: 'mapped columns', select: path => b => ({ id: b.id, ...path.mapped(b) }) },
  { name: 'a WHERE on a probed column', select: path => b => ({ id: b.id, ...path.read(b) }), where: path => b => eq(path.column(b), path.value) },
  { name: 'isNull() of the probed row (LEFT semantics)', select: path => b => ({ id: b.id, ...path.read(b) }), where: path => b => isNull(path.key(b)) },
  { name: 'isNotNull() of the probed row', select: path => b => ({ id: b.id, ...path.read(b) }), where: path => b => isNotNull(path.key(b)) },
];

describe('lateralJoin() matrix — root queries: every path, read every way', () => {
  const cases: MatrixCase[] = [];

  for (const path of PATHS) {
    for (const reading of READINGS) {
      cases.push({
        id: `root/${path.name}/${reading.name}`,
        strategies: ['lateral'],
        hops: path.hops,
        ordered: true,
        run: (db, probe) => {
          const where = reading.where?.(path);
          const filtered = where === undefined ? db.ljmBooks : db.ljmBooks.where(where);

          return probed(filtered, path, probe)
            .select(reading.select(path))
            .orderBy(b => b.id)
            .toList();
        },
      });
    }

    // Ordered by a probed column: NULLs and all
    cases.push({
      id: `root/${path.name}/ORDER BY a probed column`,
      strategies: ['lateral'],
      hops: path.hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, path, probe)
        .orderBy(b => [path.column(b), b.id])
        .select(b => ({ id: b.id, ...path.read(b) }))
        .toList(),
    });
  }

  runMatrix(cases);
});

// ---------------------------------------------------------------------------
// Root queries: every builder lateralJoin() is called on
// ---------------------------------------------------------------------------

/** Takes any builder of a book's rows, as code written before lateralJoin() existed takes one. */
const throughInterface = (query: IEntityQueryable<LjmBook>, path: ProbePath, probe: boolean): IEntityQueryable<LjmBook> => probed(query, path, probe);

interface Builder {
  readonly name: string;
  /** Whether the rows come back without an order of their own. */
  readonly unordered?: boolean;
  readonly run: (db: LjmDatabase, path: ProbePath, probe: boolean) => Promise<unknown>;
}

const BUILDERS: readonly Builder[] = [
  {
    name: 'a table',
    run: (db, path, probe) => probed(db.ljmBooks, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
  },
  {
    name: 'after where()',
    run: (db, path, probe) => probed(db.ljmBooks.where(b => gt(b.id, 0)), path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
  },
  {
    name: 'after select() (the select builder)',
    run: (db, path, probe) => probed(db.ljmBooks.where(b => gt(b.id, 0)).select(b => ({ id: b.id, ...path.read(b) })), path, probe).orderBy(r => r.id).toList(),
  },
  {
    name: 'at the end of the chain',
    run: (db, path, probe) => probed(db.ljmBooks.select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).limit(10).offset(0), path, probe).toList(),
  },
  {
    name: 'an IEntityQueryable',
    run: (db, path, probe) => throughInterface(db.ljmBooks.where(b => gt(b.id, 0)), path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
  },
  {
    name: 'the untyped QueryBuilder (getTable().where())',
    run: (db, path, probe) => probed((db as any).getTable('ljm_books').where((b: Row) => gt(b.id, 0)), path, probe)
      .select((b: Row) => ({ id: b.id, ...path.read(b) }))
      .orderBy((r: Row) => r.id)
      .toList(),
  },
  {
    name: 'the untyped SelectQueryBuilder (getTable().select())',
    run: (db, path, probe) => probed((db as any).getTable('ljm_books').select((b: Row) => ({ id: b.id, ...path.read(b) })), path, probe)
      .orderBy((r: Row) => r.id)
      .toList(),
  },
  {
    name: 'selectDistinct()',
    unordered: true,
    run: (db, path, probe) => probed(db.ljmBooks.selectDistinct(b => path.read(b)), path, probe).toList(),
  },
  {
    name: 'an explicit innerJoin()',
    run: (db, path, probe) => probed(
      db.ljmBooks.innerJoin(db.ljmShelves, (b, s) => eq(b.shelfId, s.id), (b, s) => ({ id: b.id, label: s.label, ...path.read(b) })),
      path,
      probe,
    ).orderBy(r => r.id).toList(),
  },
  {
    name: 'an explicit leftJoin()',
    run: (db, path, probe) => probed(
      db.ljmBooks.leftJoin(db.ljmCopies, (b, c) => eq(b.id, c.bookId), (b, c) => ({ id: b.id, copy: c.id, ...path.read(b) })),
      path,
      probe,
    ).orderBy(r => [r.id, r.copy]).toList(),
  },
  {
    name: 'withPreparedStatements(true)',
    run: (db, path, probe) => probed(db.ljmBooks.where(b => gt(b.id, 0)).withPreparedStatements(true), path, probe)
      .select(b => ({ id: b.id, ...path.read(b) }))
      .orderBy(r => r.id)
      .toList(),
  },
];

describe('lateralJoin() matrix — root queries: every builder', () => {
  const cases: MatrixCase[] = [];

  for (const path of PATHS) {
    for (const builder of BUILDERS) {
      cases.push({
        id: `builder/${builder.name}/${path.name}`,
        strategies: ['lateral'],
        hops: path.hops,
        ordered: builder.unordered !== true,
        run: (db, probe) => builder.run(db, path, probe),
      });
    }
  }

  runMatrix(cases);
});

// ---------------------------------------------------------------------------
// Root queries: every terminal and every composition that renders the query
// ---------------------------------------------------------------------------

/** Runs `work` in a transaction that is rolled back, and returns what it returned. */
const rolledBack = async <T>(db: LjmDatabase, work: (tx: LjmDatabase) => Promise<T>): Promise<T> => {
  const rollback = new Error('ljm: roll back');
  let result: T | undefined;

  try {
    await db.transaction(async (tx) => {
      result = await work(tx as unknown as LjmDatabase);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  }

  return result as T;
};

let preparedNames = 0;

interface Terminal {
  readonly name: string;
  readonly ordered?: boolean;
  /** The probe has nothing to replace: the statement joins nothing of the path. */
  readonly noJoin?: boolean;
  readonly run: (db: LjmDatabase, path: ProbePath, probe: boolean) => Promise<unknown>;
}

const books = (db: LjmDatabase, path: ProbePath, probe: boolean): IEntityQueryable<LjmBook> => probed(db.ljmBooks, path, probe);

const TERMINALS: readonly Terminal[] = [
  { name: 'first()', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => isNotNull(path.key(b))).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).first() },
  { name: 'firstOrDefault() of no row', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => eq(path.column(b), 'nobody')).select(b => ({ id: b.id, ...path.read(b) })).firstOrDefault() },
  { name: 'firstOrThrow()', ordered: true, run: (db, path, probe) => books(db, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).firstOrThrow() },
  { name: 'count() filtered through the probe', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => eq(path.column(b), path.value)).count() },
  { name: 'count() of rows missing the probed row', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => isNull(path.key(b))).count() },
  // Not through the table's own count(): both sides are the select builder lateralJoin() returns
  { name: 'count() that reads nothing of the path', ordered: true, noJoin: true, run: (db, path, probe) => probed(db.ljmBooks.where(b => gt(b.id, 0)), path, probe).count() },
  { name: 'exists() filtered through the probe', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => eq(path.column(b), path.value)).exists() },
  { name: 'exists() of no row', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => eq(path.column(b), 'nobody')).exists() },
  { name: 'max() of a probed column', ordered: true, run: (db, path, probe) => books(db, path, probe).select(b => ({ v: path.column(b) })).max(r => r.v) },
  { name: 'min() of a probed column', ordered: true, run: (db, path, probe) => books(db, path, probe).select(b => ({ v: path.column(b) })).min(r => r.v) },
  { name: 'sum() filtered through the probe', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => isNotNull(path.key(b))).select(b => ({ pages: b.pages })).sum(r => r.pages) },
  { name: 'a page (ORDER BY, LIMIT, OFFSET)', ordered: true, run: (db, path, probe) => books(db, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).limit(2).offset(1).toList() },
  { name: 'a page ordered by a probed column', ordered: true, run: (db, path, probe) => books(db, path, probe).orderBy(b => [path.column(b), b.id]).limit(3).offset(1).select(b => ({ id: b.id, ...path.read(b) })).toList() },
  {
    name: 'countOver()',
    ordered: true,
    run: (db, path, probe) => books(db, path, probe).where(b => isNotNull(path.key(b))).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).limit(2).countOver(),
  },
  { name: 'a window function in the projection', ordered: true, run: (db, path, probe) => books(db, path, probe).select(b => ({ id: b.id, rank: win.rowNumber().over({ orderBy: [path.column(b), b.id] }), ...path.read(b) })).orderBy(r => r.id).toList() },
  { name: 'future()', ordered: true, run: (db, path, probe) => books(db, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).future().execute() },
  { name: 'futureFirstOrDefault()', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => isNotNull(path.key(b))).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).futureFirstOrDefault().execute() },
  { name: 'futureCount()', ordered: true, run: (db, path, probe) => books(db, path, probe).where(b => eq(path.column(b), path.value)).futureCount().execute() },
  {
    name: 'FutureQueryRunner.runAsync() of several futures',
    ordered: true,
    run: async (db, path, probe) => FutureQueryRunner.runAsync([
      books(db, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).future(),
      books(db, path, probe).where(b => eq(path.column(b), path.value)).futureCount(),
    ] as const),
  },
  {
    name: 'QueryBatch legs (a list, a first row, a count)',
    ordered: true,
    run: async (db, path, probe) => {
      const batch = new QueryBatch();
      const list = batch.addList(books(db, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id), 'list');
      const first = batch.addFirstOrDefault(books(db, path, probe).where(b => isNotNull(path.key(b))).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id), 'first');
      const count = batch.addCount(books(db, path, probe).where(b => isNull(path.key(b))), 'count');
      await batch.executeBatch();

      return { list: batch.getList(list), first: batch.getItem(first), count: batch.getCount(count) };
    },
  },
  {
    name: 'unionAll() legs, both probed',
    run: (db, path, probe) => books(db, path, probe).where(b => eq(b.isCurrent, true)).select(b => ({ id: b.id, v: path.column(b) }))
      .unionAll(books(db, path, probe).where(b => eq(b.isCurrent, false)).select(b => ({ id: b.id, v: path.column(b) })))
      .toList(),
  },
  {
    name: 'union() legs, both probed',
    run: (db, path, probe) => books(db, path, probe).where(b => gt(b.pages, 250)).select(b => ({ v: path.column(b) }))
      .union(books(db, path, probe).where(b => isNull(path.key(b))).select(b => ({ v: path.column(b) })))
      .toList(),
  },
  {
    name: 'prepare() with a placeholder',
    ordered: true,
    run: (db, path, probe) => {
      const prepared = books(db, path, probe)
        .where(b => gt(b.pages, sql.placeholder('pages')))
        .select(b => ({ id: b.id, ...path.read(b) }))
        .orderBy(r => r.id)
        .prepare(`ljm_prepared_${++preparedNames}`);
      // A prepared query runs on the client itself, unlogged: its text is the statement
      log.push({ sql: prepared.getSql(), params: [] });

      return prepared.execute({ pages: 150 });
    },
  },
  {
    name: 'a scalar subquery of another query\'s projection',
    ordered: true,
    run: (db, path, probe) => db.ljmShelves
      .select(s => ({
        id: s.id,
        first: books(db, path, probe).where(b => and(eq(b.shelfId, s.id), isNotNull(path.key(b)))).select(b => path.column(b)).orderBy(v => v).limit(1).asSubquery('scalar'),
      }))
      .orderBy(r => r.id)
      .toList(),
  },
  {
    name: 'an array subquery: inSubquery()',
    ordered: true,
    run: (db, path, probe) => db.ljmShelves
      .where(s => inSubquery(s.id, books(db, path, probe).where(b => eq(path.column(b), path.value)).select(b => b.shelfId).asSubquery('array')))
      .select(s => ({ id: s.id, label: s.label }))
      .orderBy(r => r.id)
      .toList(),
  },
  {
    name: 'an array subquery: notInSubquery()',
    ordered: true,
    run: (db, path, probe) => db.ljmShelves
      .where(s => notInSubquery(s.id, books(db, path, probe).where(b => isNull(path.key(b))).select(b => b.shelfId).asSubquery('array')))
      .select(s => ({ id: s.id, label: s.label }))
      .orderBy(r => r.id)
      .toList(),
  },
  {
    name: 'a correlated exists() subquery',
    ordered: true,
    run: (db, path, probe) => db.ljmShelves
      .where(s => exists(books(db, path, probe).where(b => and(eq(b.shelfId, s.id), eq(path.column(b), path.value))).select(b => ({ id: b.id })).asSubquery()))
      .select(s => ({ id: s.id }))
      .orderBy(r => r.id)
      .toList(),
  },
  {
    name: 'a correlated notExists() subquery',
    ordered: true,
    run: (db, path, probe) => db.ljmShelves
      .where(s => notExists(books(db, path, probe).where(b => and(eq(b.shelfId, s.id), isNull(path.key(b)))).select(b => ({ id: b.id })).asSubquery()))
      .select(s => ({ id: s.id }))
      .orderBy(r => r.id)
      .toList(),
  },
  {
    name: 'a CTE body',
    ordered: true,
    run: (db, path, probe) => {
      const { cte } = new DbCteBuilder().with('ljm_probed', books(db, path, probe).select(b => ({ id: b.id, v: path.column(b) })));

      return db.selectFromCte(cte).select(r => ({ id: r.id, v: r.v })).orderBy(r => r.id).toList();
    },
  },
  {
    name: 'the source of insertFrom()',
    ordered: true,
    run: (db, path, probe) => rolledBack(db, async (tx) => {
      await tx.ljmCopies.insertFrom(
        books(tx, path, probe).where(b => isNotNull(path.key(b))).select(b => ({ bookId: b.id, label: path.column(b) })).asSubquery('table'),
        s => ({ bookId: s.bookId, condition: s.label }),
      );

      return tx.ljmCopies.select(c => ({ bookId: c.bookId, condition: c.condition })).orderBy(c => [c.bookId, c.condition]).toList();
    }),
  },
  {
    name: 'an inSubquery() in the WHERE of update()',
    ordered: true,
    run: (db, path, probe) => rolledBack(db, async (tx) => {
      await tx.ljmCopies
        .where(c => inSubquery(c.bookId, books(tx, path, probe).where(b => isNotNull(path.key(b))).select(b => b.id).asSubquery('array')))
        .update({ condition: 'touched' });

      return tx.ljmCopies.select(c => ({ id: c.id, condition: c.condition })).orderBy(c => c.id).toList();
    }),
  },
  {
    name: 'an inSubquery() in the WHERE of delete()',
    ordered: true,
    run: (db, path, probe) => rolledBack(db, async (tx) => {
      await tx.ljmCopies
        .where(c => inSubquery(c.bookId, books(tx, path, probe).where(b => isNull(path.key(b))).select(b => b.id).asSubquery('array')))
        .delete();

      return tx.ljmCopies.select(c => ({ id: c.id })).orderBy(c => c.id).toList();
    }),
  },
];

describe('lateralJoin() matrix — root queries: every terminal and composition', () => {
  const cases: MatrixCase[] = [];

  for (const path of PATHS) {
    for (const terminal of TERMINALS) {
      cases.push({
        id: `terminal/${terminal.name}/${path.name}`,
        strategies: ['lateral'],
        hops: path.hops,
        ordered: terminal.ordered === true,
        probes: terminal.noJoin === true ? 0 : undefined,
        run: (db, probe) => terminal.run(db, path, probe),
      });
    }
  }

  runMatrix(cases);
});

// ---------------------------------------------------------------------------
// Collections: the item's own lateralJoin(), under every strategy
// ---------------------------------------------------------------------------

/**
 * The hops of `path` as a collection of books renders them: a hop off the item reads the item's foreign key off
 * the row the strategy renders the item as — the LATERAL's alias, the table itself in a CTE / temp-table
 * aggregation, the alias of an inline count() / exists() subquery.
 */
const ITEM = /^(ljm_books|lateral_\d+_books|books__(count|exists)(_\d+)?)$/;
const itemHops = (path: ProbePath): Hop[] => path.hops.map(h => (h.source === BOOKS ? { ...h, source: ITEM } : h));

interface ItemShape {
  readonly name: string;
  /** A projection of the shelf reading its books through `books` (the collection, probed or not). */
  readonly project?: (books: any, path: ProbePath) => Record<string, unknown>;
  /** A WHERE of the shelf reading its books through `books`. */
  readonly where?: (books: any, path: ProbePath) => any;
}

const ITEM_SHAPES: readonly ItemShape[] = [
  { name: 'a list', project: (books, path) => ({ books: books.orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, ...path.read(b) })).toList() }) },
  {
    name: 'a list filtered on a probed column',
    project: (books, path) => ({ books: books.where((b: Row) => eq(path.column(b), path.value)).orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, ...path.read(b) })).toList() }),
  },
  {
    name: 'a list filtered by isNull() of the probed row',
    project: (books, path) => ({ books: books.where((b: Row) => isNull(path.key(b))).orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, title: b.title })).toList() }),
  },
  {
    name: 'a list ordered by a probed column it does not project',
    project: (books, path) => ({ books: books.orderBy((b: Row) => [path.column(b), b.id]).select((b: Row) => ({ id: b.id })).toList() }),
  },
  { name: 'the probed row projected whole', project: (books, path) => ({ books: books.orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, row: path.whole(b) })).toList() }) },
  { name: 'mapped columns of the probed row', project: (books, path) => ({ books: books.orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, ...path.mapped(b) })).toList() }) },
  { name: 'a limited list', project: (books, path) => ({ books: books.orderBy((b: Row) => [path.column(b), b.id]).select((b: Row) => ({ id: b.id, ...path.read(b) })).limit(1).toList() }) },
  { name: 'a list with an offset', project: (books, path) => ({ books: books.orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, ...path.read(b) })).offset(1).toList() }) },
  { name: 'firstOrDefault()', project: (books, path) => ({ first: books.where((b: Row) => isNotNull(path.key(b))).orderBy((b: Row) => b.id).select((b: Row) => ({ id: b.id, ...path.read(b) })).firstOrDefault() }) },
  { name: 'a distinct list', project: (books, path) => ({ values: books.selectDistinct((b: Row) => ({ v: path.column(b) })).orderBy((r: Row) => r.v).toList() }) },
  { name: 'count() filtered on a probed column', project: (books, path) => ({ n: books.where((b: Row) => eq(path.column(b), path.value)).count() }) },
  { name: 'count() of items missing the probed row', project: (books, path) => ({ n: books.where((b: Row) => isNull(path.key(b))).count() }) },
  { name: 'exists() filtered on a probed column', project: (books, path) => ({ any: books.where((b: Row) => eq(path.column(b), path.value)).exists() }) },
  { name: 'max() of a probed column', project: (books, path) => ({ top: books.max((b: Row) => path.column(b)) }) },
  { name: 'min() of a probed column', project: (books, path) => ({ low: books.min((b: Row) => path.column(b)) }) },
  { name: 'sum() filtered through the probe', project: (books, path) => ({ pages: books.where((b: Row) => isNotNull(path.key(b))).sum((b: Row) => b.pages) }) },
  { name: 'toStringList() of a probed column', project: (books, path) => ({ names: books.where((b: Row) => isNotNull(path.key(b))).orderBy((b: Row) => b.id).select((b: Row) => path.column(b)).toStringList() }) },
  { name: 'toNumberList() filtered through the probe', project: (books, path) => ({ ids: books.where((b: Row) => isNotNull(path.key(b))).orderBy((b: Row) => b.id).select((b: Row) => b.id).toNumberList() }) },
  { name: 'a count() in a sql fragment', project: (books, path) => ({ n: sql<number>`${books.where((b: Row) => eq(path.column(b), path.value)).count()}` }) },
  { name: 'exists() in the WHERE', where: (books, path) => exists(books.where((b: Row) => eq(path.column(b), path.value))) },
  { name: 'notExists() in the WHERE', where: (books, path) => notExists(books.where((b: Row) => isNotNull(path.key(b)))) },
  { name: 'a count() in a WHERE fragment', where: (books, path) => sql`${books.where((b: Row) => eq(path.column(b), path.value)).count()} > 0` },
  {
    name: 'a nested collection beside the probed path',
    project: (books, path) => ({
      books: books.orderBy((b: Row) => b.id).select((b: Row) => ({
        id: b.id,
        ...path.read(b),
        copies: b.copies.orderBy((c: Row) => c.id).select((c: Row) => ({ condition: c.condition })).toList(),
      })).toList(),
    }),
  },
];

/** The books of a shelf, probed or not (a fresh collection each time: `lateralJoin()` marks it in place). */
const shelfBooks = (s: Row, path: ProbePath, probe: boolean): any => probed(s.books, path, probe);

/** Every path, every shape of a shelf's books, probed by the collection's own lateralJoin(). */
const itemCases = (): MatrixCase[] => PATHS.flatMap(path => ITEM_SHAPES.map((shape): MatrixCase => ({
  id: `item/${shape.name}/${path.name}`,
  strategies: STRATEGIES,
  hops: itemHops(path),
  ordered: true,
  run: (db, probe) => {
    const shelves = shape.where === undefined ? db.ljmShelves : db.ljmShelves.where(s => shape.where!(shelfBooks(s, path, probe), path));

    return shelves
      .select(s => ({ id: s.id, ...(shape.project === undefined ? {} : shape.project(shelfBooks(s, path, probe), path)) }))
      .orderBy(s => s.id)
      .toList();
  },
})));

describe('lateralJoin() matrix — collections: the item\'s own probe, under every strategy', () => {
  runMatrix(itemCases());
});

// ---------------------------------------------------------------------------
// Collections hanging off a probed path: every re-join of the path probes
// ---------------------------------------------------------------------------

/** A collection reached through a path the query probes (`b.author.region.landmarks` under `lateralJoin(b => b.author.region)`). */
interface Hanging {
  readonly name: string;
  readonly path: ProbePath;
  /** The collection, off a book. */
  readonly collection: (b: Row) => any;
  /** A projection of its items; a text column and a number column of an item. */
  readonly item: (x: Row) => Record<string, unknown>;
  readonly text: (x: Row) => any;
  readonly number: (x: Row) => any;
  /** A column of the path the book's own row reads (so its own join of the path is there too). */
  readonly read: (b: Row) => Record<string, unknown>;
  /** The collection's path does not run through the probed hop: only the row's own join of it probes. */
  readonly besidePath?: true;
}

const pathNamed = (name: string): ProbePath => PATHS.find(path => path.name.startsWith(`${name} (`) || path.name === name)!;

const HANGING: readonly Hanging[] = [
  {
    name: 'landmarks off the probed region',
    path: pathNamed('author.region'),
    collection: b => b.author.region.landmarks,
    item: l => ({ name: l.name, height: l.height }),
    text: l => l.name,
    number: l => l.height,
    read: b => ({ region: b.author.region.name }),
  },
  {
    name: 'landmarks off a hop beyond the probed author',
    path: pathNamed('author'),
    collection: b => b.author.region.landmarks,
    item: l => ({ name: l.name }),
    text: l => l.name,
    number: l => l.height,
    read: b => ({ author: b.author.name }),
  },
  {
    name: 'landmarks off both probed hops',
    path: pathNamed('author and author.region'),
    collection: b => b.author.region.landmarks,
    item: l => ({ name: l.name }),
    text: l => l.name,
    number: l => l.height,
    read: b => ({ region: b.author.region.name }),
  },
  {
    name: 'books of the author, a hop before the probed region',
    path: pathNamed('author.region'),
    collection: b => b.author.books,
    item: x => ({ title: x.title }),
    text: x => x.title,
    number: x => x.pages,
    read: b => ({ region: b.author.region.name }),
    besidePath: true,
  },
  {
    name: 'books of the probed activeAuthor (a constant key part)',
    path: pathNamed('activeAuthor'),
    collection: b => b.activeAuthor.books,
    item: x => ({ title: x.title }),
    text: x => x.title,
    number: x => x.pages,
    read: b => ({ author: b.activeAuthor.name }),
  },
  {
    name: 'books of the probed currentAuthor (a constant key part on the foreign-key side)',
    path: pathNamed('currentAuthor'),
    collection: b => b.currentAuthor.books,
    item: x => ({ title: x.title }),
    text: x => x.title,
    number: x => x.pages,
    read: b => ({ author: b.currentAuthor.name }),
  },
  {
    name: 'authors of the probed publisher (a composite key)',
    path: pathNamed('author.publisher'),
    collection: b => b.author.publisher.authors,
    item: a => ({ name: a.name }),
    text: a => a.name,
    number: a => a.id,
    read: b => ({ publisher: b.author.publisher.name }),
  },
  {
    name: 'landmarks of the probed home (a principal key that is not id)',
    path: pathNamed('author.home'),
    collection: b => b.author.home.landmarks,
    item: l => ({ name: l.name }),
    text: l => l.name,
    number: l => l.height,
    read: b => ({ home: b.author.home.name }),
  },
  {
    name: 'books of the probed mentor (a table navigating to itself)',
    path: pathNamed('author.mentor'),
    collection: b => b.author.mentor.books,
    item: x => ({ title: x.title }),
    text: x => x.title,
    number: x => x.pages,
    read: b => ({ mentor: b.author.mentor.name }),
  },
  {
    name: 'mentees of the probed mentor',
    path: pathNamed('author.mentor'),
    collection: b => b.author.mentor.mentees,
    item: a => ({ name: a.name }),
    text: a => a.name,
    number: a => a.id,
    read: b => ({ mentor: b.author.mentor.name }),
  },
  {
    name: 'landmarks off the probed third hop',
    path: pathNamed('author.mentor.region'),
    collection: b => b.author.mentor.region.landmarks,
    item: l => ({ name: l.name }),
    text: l => l.name,
    number: l => l.height,
    read: b => ({ region: b.author.mentor.region.name }),
  },
  {
    name: 'active authors of the probed region (a constant key part on the collection)',
    path: pathNamed('author.region'),
    collection: b => b.author.region.activeAuthors,
    item: a => ({ name: a.name }),
    text: a => a.name,
    number: a => a.id,
    read: b => ({ region: b.author.region.name }),
  },
  {
    name: 'books of the probed coAuthor',
    path: pathNamed('coAuthor'),
    collection: b => b.coAuthor.books,
    item: x => ({ title: x.title }),
    text: x => x.title,
    number: x => x.pages,
    read: b => ({ coAuthor: b.coAuthor.name }),
  },
  {
    name: 'books of the probed (required) shelf — the row\'s own table again',
    path: pathNamed('shelf'),
    collection: b => b.shelf.books,
    item: x => ({ title: x.title }),
    text: x => x.title,
    number: x => x.pages,
    read: b => ({ shelf: b.shelf.label }),
  },
];

interface HangingShape {
  readonly name: string;
  readonly project?: (c: any, h: Hanging) => unknown;
  readonly where?: (c: any, h: Hanging) => any;
}

const HANGING_SHAPES: readonly HangingShape[] = [
  { name: 'a list', project: (c, h) => c.orderBy((x: Row) => h.text(x)).select((x: Row) => h.item(x)).toList() },
  { name: 'a filtered list', project: (c, h) => c.where((x: Row) => gt(h.number(x), 1)).orderBy((x: Row) => h.text(x)).select((x: Row) => h.item(x)).toList() },
  { name: 'a limited list', project: (c, h) => c.orderBy((x: Row) => h.text(x)).select((x: Row) => h.item(x)).limit(1).toList() },
  { name: 'firstOrDefault()', project: (c, h) => c.orderBy((x: Row) => h.text(x)).select((x: Row) => h.item(x)).firstOrDefault() },
  { name: 'count()', project: c => c.count() },
  { name: 'exists()', project: c => c.exists() },
  { name: 'max()', project: (c, h) => c.max((x: Row) => h.text(x)) },
  { name: 'sum()', project: (c, h) => c.sum((x: Row) => h.number(x)) },
  { name: 'toStringList()', project: (c, h) => c.orderBy((x: Row) => h.text(x)).select((x: Row) => h.text(x)).toStringList() },
  { name: 'a count() in a sql fragment', project: c => sql<number>`${c.count()}` },
  { name: 'exists() in the WHERE', where: (c, h) => exists(c.where((x: Row) => gt(h.number(x), 0))) },
  { name: 'notExists() in the WHERE', where: (c, h) => notExists(c.where((x: Row) => gt(h.number(x), 0))) },
  { name: 'a count() in a WHERE fragment', where: c => sql`${c.count()} >= 1` },
];

/** A book's row in a matrix case: the probe paths and what reads it, from the root or from a shelf's books. */
const hangingCase = (h: Hanging, shape: HangingShape, scope: 'root' | 'item', withRead: boolean): MatrixCase => ({
  id: `hanging/${scope}/${shape.name}/${h.name}${withRead ? '' : ' (the row reads nothing else of the path)'}`,
  strategies: STRATEGIES,
  hops: scope === 'root' ? h.path.hops : itemHops(h.path),
  ordered: true,
  // Nothing of the probed hop is joined anywhere: the probe has nothing to replace
  probes: h.besidePath === true && !withRead ? 0 : undefined,
  run: (db, probe) => {
    const project = (b: Row): Record<string, unknown> => ({
      id: b.id,
      ...(withRead ? h.read(b) : {}),
      ...(shape.project === undefined ? {} : { value: shape.project(h.collection(b), h) }),
    });

    if (scope === 'root') {
      const rows = shape.where === undefined ? db.ljmBooks : db.ljmBooks.where(b => shape.where!(h.collection(b), h));

      return probed(rows, h.path, probe).select(project).orderBy(r => r.id).toList();
    }

    return db.ljmShelves
      .select(s => {
        const items = shape.where === undefined ? s.books! : (s.books! as any).where((b: Row) => shape.where!(h.collection(b), h));

        return { id: s.id, books: probed(items, h.path, probe).orderBy((b: Row) => b.id).select(project).toList() };
      })
      .orderBy(s => s.id)
      .toList();
  },
});

/** Every hanging collection, every shape: off the root's probed path (read by the row or not), off an item's. */
const hangingCases = (): MatrixCase[] => HANGING.flatMap(h => HANGING_SHAPES.flatMap(shape => [
  hangingCase(h, shape, 'root', true),
  hangingCase(h, shape, 'root', false),
  hangingCase(h, shape, 'item', true),
]));

describe('lateralJoin() matrix — collections hanging off a probed path', () => {
  runMatrix(hangingCases());
});

/** The root queries the planner is asked about: every path, read in the row's own FROM. */
const rootCasesForPlanner = (): MatrixCase[] => PATHS.map(path => ({
  id: `planner/root/${path.name}`,
  strategies: ['lateral'],
  hops: path.hops,
  ordered: true,
  run: (db: LjmDatabase, probe: boolean) => probed(db.ljmBooks, path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
}));

// ---------------------------------------------------------------------------
// Key shapes: every key part correlates — the rows the fixture pins
// ---------------------------------------------------------------------------

/**
 * An inline `count()` / `exists()` subquery — in a WHERE, in a `sql` fragment — joins the path its collection hangs
 * off anew, and the navigations its own WHERE reads. Both joined on the FIRST key pair only: a constant key part
 * (`activeAuthor`: the author when active; `currentAuthor`: the author when the book is current) and the second
 * column of a composite key (`publisher`: (country, code)) were dropped there, and the subquery counted rows the
 * query's own join of the navigation does not read. Plain and probed alike: the probe renders every pair.
 */
describe('lateralJoin() matrix — every key part of a navigation an inline count() / exists() joins', () => {
  const titles = (rows: unknown): unknown => (rows as Array<{ title: string }>).map(row => row.title);
  const counts = (rows: unknown): unknown => (rows as Array<{ title: string; n: unknown }>).map(row => [row.title, Number(row.n)]);
  const cases: MatrixCase[] = [
    {
      // Beta's author (Ben) is inactive: its activeAuthor is missing, and so are the active author's books
      id: 'key/a constant key part (principal side) of a path hop, exists() in the WHERE',
      strategies: ['lateral'],
      hops: pathNamed('activeAuthor').hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks.where(b => exists(b.activeAuthor!.books!.where(x => gt(x.pages, 0)))), pathNamed('activeAuthor'), probe)
        .select(b => ({ id: b.id, title: b.title, author: b.activeAuthor!.name }))
        .orderBy(r => r.id)
        .toList(),
      view: titles,
      expected: ['Alpha', 'Delta', 'Eps'],
    },
    {
      id: 'key/a constant key part (principal side) of a path hop, count() in a sql fragment',
      strategies: ['lateral'],
      hops: pathNamed('activeAuthor').hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, pathNamed('activeAuthor'), probe)
        .select(b => ({ id: b.id, title: b.title, author: b.activeAuthor!.name, n: sql<number>`${b.activeAuthor!.books!.count()}` }))
        .orderBy(r => r.id)
        .toList(),
      view: counts,
      expected: [['Alpha', 2], ['Beta', 0], ['Gamma', 0], ['Delta', 1], ['Eps', 2], ['Zeta', 0]],
    },
    {
      // Delta is not current: its currentAuthor is missing
      id: 'key/a constant key part (foreign-key side) of a path hop, count() in a sql fragment',
      strategies: ['lateral'],
      hops: pathNamed('currentAuthor').hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, pathNamed('currentAuthor'), probe)
        .select(b => ({ id: b.id, title: b.title, author: b.currentAuthor!.name, n: sql<number>`${b.currentAuthor!.books!.count()}` }))
        .orderBy(r => r.id)
        .toList(),
      view: counts,
      expected: [['Alpha', 2], ['Beta', 1], ['Gamma', 0], ['Delta', 0], ['Eps', 2], ['Zeta', 0]],
    },
    {
      // (SK, 1) and (SK, 2) share the first key part: on it alone, Ann's publisher had Ben among its authors
      id: 'key/a composite key of a path hop, count() in a sql fragment',
      strategies: ['lateral'],
      hops: pathNamed('author.publisher').hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, pathNamed('author.publisher'), probe)
        .select(b => ({ id: b.id, title: b.title, publisher: b.author!.publisher!.name, n: sql<number>`${b.author!.publisher!.authors!.count()}` }))
        .orderBy(r => r.id)
        .toList(),
      view: counts,
      expected: [['Alpha', 1], ['Beta', 1], ['Gamma', 0], ['Delta', 0], ['Eps', 1], ['Zeta', 0]],
    },
    {
      id: 'key/a composite key of a path hop, notExists() in the WHERE',
      strategies: ['lateral'],
      hops: pathNamed('author.publisher').hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks.where(b => notExists(b.author!.publisher!.authors!.where(a => eq(a.name, 'Ben')))), pathNamed('author.publisher'), probe)
        .select(b => ({ id: b.id, title: b.title, publisher: b.author!.publisher!.name }))
        .orderBy(r => r.id)
        .toList(),
      view: titles,
      expected: ['Alpha', 'Gamma', 'Delta', 'Eps', 'Zeta'],
    },
  ];

  // The item's own navigations an inline count() / exists() filters by, under every strategy
  for (const strategy of STRATEGIES) {
    cases.push(
      {
        id: `key/a constant key part (principal side) of an item navigation the WHERE reads [${strategy}]`,
        strategies: [strategy],
        hops: itemHops(pathNamed('activeAuthor')),
        ordered: true,
        run: (db, probe) => db.ljmShelves
          .select(s => ({ id: s.id, label: s.label, n: sql<number>`${probed(s.books!, pathNamed('activeAuthor'), probe).where(b => eq(b.activeAuthor!.name, 'Ben')).count()}` }))
          .orderBy(r => r.id)
          .toList(),
        view: rows => (rows as Array<{ label: string; n: unknown }>).map(row => [row.label, Number(row.n)]),
        expected: [['Fiction', 0], ['Poetry', 0], ['Empty', 0]],
      },
      {
        id: `key/a constant key part (foreign-key side) of an item navigation the WHERE reads [${strategy}]`,
        strategies: [strategy],
        hops: itemHops(pathNamed('currentAuthor')),
        ordered: true,
        run: (db, probe) => db.ljmShelves
          .where(s => exists(probed(s.books!, pathNamed('currentAuthor'), probe).where(b => eq(b.currentAuthor!.name, 'Cyd'))))
          .select(s => ({ id: s.id, label: s.label }))
          .orderBy(r => r.id)
          .toList(),
        expected: [],
      },
      {
        id: `key/a composite key of an item navigation the WHERE reads [${strategy}]`,
        strategies: [strategy],
        hops: itemHops(pathNamed('author.publisher')),
        ordered: true,
        run: (db, probe) => db.ljmShelves
          .select(s => ({ id: s.id, label: s.label, n: sql<number>`${probed(s.books!, pathNamed('author.publisher'), probe).where(b => eq(b.author!.publisher!.name, 'Danube')).count()}` }))
          .orderBy(r => r.id)
          .toList(),
        view: rows => (rows as Array<{ label: string; n: unknown }>).map(row => [row.label, Number(row.n)]),
        expected: [['Fiction', 1], ['Poetry', 0], ['Empty', 0]],
      },
    );
  }

  runMatrix(cases);
});

describe('lateralJoin() matrix — the rows every key shape reads, probed', () => {
  const ROWS: Array<{ path: string; expected: unknown[] }> = [
    { path: 'author', expected: [['Alpha', 'Ann'], ['Beta', 'Ben'], ['Gamma', null], ['Delta', 'Cyd'], ['Eps', 'Ann'], ['Zeta', null]] },
    { path: 'shelf', expected: [['Alpha', 'Fiction'], ['Beta', 'Fiction'], ['Gamma', 'Fiction'], ['Delta', 'Poetry'], ['Eps', 'Poetry'], ['Zeta', 'Poetry']] },
    { path: 'activeAuthor', expected: [['Alpha', 'Ann'], ['Beta', null], ['Gamma', null], ['Delta', 'Cyd'], ['Eps', 'Ann'], ['Zeta', null]] },
    { path: 'currentAuthor', expected: [['Alpha', 'Ann'], ['Beta', 'Ben'], ['Gamma', null], ['Delta', null], ['Eps', 'Ann'], ['Zeta', null]] },
    { path: 'author.region', expected: [['Alpha', 'North'], ['Beta', 'South'], ['Gamma', null], ['Delta', null], ['Eps', 'North'], ['Zeta', null]] },
    // A required hop joins INNER, after an optional one too (as the plain join does): a book without an author has no row
    { path: 'author.home', expected: [['Alpha', 'North'], ['Beta', 'South'], ['Delta', 'East'], ['Eps', 'North']] },
    { path: 'author.publisher', expected: [['Alpha', 'Tatra'], ['Beta', 'Danube'], ['Gamma', null], ['Delta', null], ['Eps', 'Tatra'], ['Zeta', null]] },
    { path: 'author.mentor', expected: [['Alpha', null], ['Beta', 'Ann'], ['Gamma', null], ['Delta', 'Ben'], ['Eps', null], ['Zeta', null]] },
    { path: 'author.mentor.region', expected: [['Alpha', null], ['Beta', 'North'], ['Gamma', null], ['Delta', 'South'], ['Eps', null], ['Zeta', null]] },
    { path: 'author.mentor.mentor', expected: [['Alpha', null], ['Beta', null], ['Gamma', null], ['Delta', 'Ann'], ['Eps', null], ['Zeta', null]] },
    { path: 'coAuthor', expected: [['Alpha', 'Ben'], ['Beta', null], ['Gamma', 'Ann'], ['Delta', 'Dee'], ['Eps', null], ['Zeta', null]] },
  ];

  runMatrix(ROWS.map(({ path: name, expected }) => {
    const path = pathNamed(name);

    return {
      id: `rows/${path.name}`,
      strategies: ['lateral'],
      hops: path.hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, path, probe).select(b => ({ id: b.id, title: b.title, value: path.column(b) })).orderBy(r => r.id).toList(),
      view: rows => (rows as Array<{ title: string; value: unknown }>).map(row => [row.title, row.value ?? null]),
      expected,
    } satisfies MatrixCase;
  }));
});

// ---------------------------------------------------------------------------
// Nesting, other chains, and the remaining FROM items
// ---------------------------------------------------------------------------

describe('lateralJoin() matrix — nested collections, other chains, other FROM items', () => {
  const author = pathNamed('author');
  const region = pathNamed('author.region');
  const both = pathNamed('author and author.region');
  const shelf = pathNamed('shelf');

  const cases: MatrixCase[] = [
    {
      // shelves → books (probe author.region) → landmarks of the probed region → the landmarks' region (probe)
      id: 'nested/three levels, a probe at each',
      strategies: STRATEGIES,
      // The landmarks' own region renders under a path alias: "region" is the path the collection hangs off
      hops: [hop('ljm_regions', 'region', 'author'), hop('ljm_regions', 'ljm_landmarks__region', /^(ljm_landmarks|lateral_\d+_landmarks)$/)],
      ordered: true,
      run: (db, probe) => db.ljmShelves
        .select(s => ({
          id: s.id,
          books: probed(s.books!, region, probe).orderBy(b => b.id).select(b => ({
            id: b.id,
            region: b.author!.region!.name,
            landmarks: (probe ? b.author!.region!.landmarks!.lateralJoin(l => l.region) : b.author!.region!.landmarks!)
              .orderBy(l => l.name)
              .select(l => ({ name: l.name, region: l.region!.population }))
              .toList(),
          })).toList(),
        }))
        .orderBy(s => s.id)
        .toList(),
    },
    {
      // shelves → books (probe author) → the author's books (off the probed hop) → their copies' books' shelves
      id: 'nested/three levels off the probed hop',
      strategies: STRATEGIES,
      hops: itemHops(author),
      ordered: true,
      run: (db, probe) => db.ljmShelves
        .select(s => ({
          id: s.id,
          books: probed(s.books!, author, probe).orderBy(b => b.id).select(b => ({
            id: b.id,
            author: b.author!.name,
            sameAuthor: b.author!.books!.orderBy(x => x.id).select(x => ({
              title: x.title,
              copies: x.copies!.orderBy(c => c.id).select(c => ({ condition: c.condition })).toList(),
            })).toList(),
          })).toList(),
        }))
        .orderBy(s => s.id)
        .toList(),
    },
    {
      // The root probes its author; a collection of the shelf's books reads ITS items' authors: another chain, plain
      id: 'chains/a collection of the same table reads its own items\' navigation plainly',
      strategies: ['lateral'],
      hops: [hop('ljm_authors', 'author', BOOKS)],
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, author, probe)
        .select(b => ({
          id: b.id,
          author: b.author!.name,
          shelfAuthors: b.shelf!.books!.orderBy(x => x.id).select(x => ({ title: x.title, author: x.author!.name })).toList(),
        }))
        .orderBy(r => r.id)
        .toList(),
    },
    {
      // The copies probe their book's author ("author" off "book"); a projected subquery over the books joins ITS
      // author under the same alias, off its own row: another chain, which keeps its plain join
      id: 'chains/a projected subquery joining the same alias off its own row keeps its plain join',
      strategies: ['lateral'],
      hops: [hop('ljm_authors', 'author', 'book')],
      ordered: true,
      run: (db, probe) => (probe ? db.ljmCopies.lateralJoin(c => c.book!.author) : db.ljmCopies)
        .select(c => ({
          id: c.id,
          author: c.book!.author!.name,
          viaSubquery: db.ljmBooks.where(x => eq(x.id, c.bookId)).select(x => x.author!.name).asSubquery('scalar'),
        }))
        .orderBy(r => r.id)
        .toList(),
    },
    {
      id: 'from/crossJoinLateral() after the probe, its argument read through it',
      strategies: ['lateral'],
      hops: author.hops,
      ordered: true,
      run: (db, probe) => (probed(db.ljmBooks, author, probe) as any)
        .crossJoinLateral((b: Row) => jsonbArrayElements(sql`${b.author.profile} -> 'genres'`), (b: Row, g: Row) => ({ id: b.id, author: b.author.name, genre: g.value }), 'g')
        .orderBy((r: Row) => [r.id, r.genre])
        .toList(),
    },
    {
      id: 'from/joinFilter() beside the probe',
      strategies: ['lateral'],
      hops: author.hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, author, probe)
        .joinFilter(db.ljmShelves, (b, s) => eq(b.shelfId, s.id), (_b, s) => eq(s.label, 'Poetry'))
        .select(b => ({ id: b.id, author: b.author!.name }))
        .orderBy(r => r.id)
        .toList(),
    },
    {
      id: 'from/with() of a CTE the query joins',
      strategies: ['lateral'],
      hops: region.hops,
      ordered: true,
      run: (db, probe) => {
        const { cte } = new DbCteBuilder().with('ljm_big', db.ljmShelves.select(s => ({ shelfId: s.id, label: s.label })));

        return probed(db.ljmBooks.where(b => gt(b.id, 0)), region, probe)
          .with(cte)
          .joinFilter(cte, (b, c) => eq(b.shelfId, c.shelfId), (_b, c) => eq(c.label, 'Fiction'))
          .select(b => ({ id: b.id, region: b.author!.region!.name }))
          .orderBy(r => r.id)
          .toList();
      },
    },
    {
      // FOR UPDATE locks the rows of every FROM item: a required navigation's probe is an INNER join, which it may
      id: 'from/forUpdate() with a required navigation probed',
      strategies: ['lateral'],
      hops: shelf.hops,
      ordered: true,
      run: (db, probe) => rolledBack(db, tx => probed(tx.ljmBooks.select(b => ({ id: b.id, shelf: b.shelf!.label })), shelf, probe).orderBy(r => r.id).forUpdate().toList()),
    },
    {
      id: 'from/a selectMany() collection of the root hanging off the probed path',
      strategies: STRATEGIES,
      hops: both.hops,
      ordered: true,
      run: (db, probe) => probed(db.ljmBooks, both, probe)
        .select(b => ({
          id: b.id,
          region: b.author!.region!.name,
          regionBooks: b.author!.region!.authors!.selectMany(a => a.books!).orderBy(x => x.id).select(x => ({ title: x.title })).toList(),
        }))
        .orderBy(r => r.id)
        .toList(),
    },
  ];

  runMatrix(cases);
});

// ---------------------------------------------------------------------------
// with() and subquery joins: the row keeps its navigations
// ---------------------------------------------------------------------------

/**
 * `with(cte)` off a table (typed or untyped, or after an untyped `where()`) and a join of a table subquery started the
 * query from the row itself, and every operator after it read the row through its columns only: a navigation was
 * gone — `b.author` read `undefined` (a TypeError in the projection, `column "undefined"` in a WHERE, an ORDER BY
 * silently dropped). The probe is the same either way: each case runs plain and probed, and reads what the same query
 * reads without `with()` / through the table it joins.
 */
const withCte = (db: LjmDatabase) => new DbCteBuilder().with('ljm_shelf_labels', db.ljmShelves.select(s => ({ shelfId: s.id, label: s.label }))).cte;
const shelfLabels = (db: LjmDatabase) => db.ljmShelves.select(s => ({ shelfId: s.id, label: s.label })).asSubquery('table');

interface RowEntry {
  readonly name: string;
  /** The query, probed or not, up to the operator that reads the row's navigations. */
  readonly run: (db: LjmDatabase, path: ProbePath, probe: boolean) => Promise<unknown>;
}

const ROW_ENTRIES: readonly RowEntry[] = [
  {
    name: 'a table\'s with(cte), then the probe',
    run: (db, path, probe) => probed(db.ljmBooks.with(withCte(db)), path, probe).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
  },
  {
    name: 'the probe, then with(cte)',
    run: (db, path, probe) => probed(db.ljmBooks, path, probe).with(withCte(db)).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
  },
  {
    name: 'a table\'s with(cte), a WHERE on the probed row',
    run: (db, path, probe) => probed(db.ljmBooks.with(withCte(db)), path, probe).where(b => eq(path.column(b), path.value)).select(b => ({ id: b.id, ...path.read(b) })).orderBy(r => r.id).toList(),
  },
  {
    name: 'a table\'s with(cte), the CTE joined as a filter',
    run: (db, path, probe) => {
      const cte = withCte(db);

      return probed(db.ljmBooks.with(cte), path, probe)
        .joinFilter(cte, (b, c) => eq(b.shelfId, c.shelfId), (_b, c) => eq(c.label, 'Poetry'))
        .select(b => ({ id: b.id, ...path.read(b) }))
        .orderBy(r => r.id)
        .toList();
    },
  },
  {
    name: 'the untyped with(cte)',
    run: (db, path, probe) => probed((db as any).getTable('ljm_books').with(withCte(db)), path, probe)
      .select((b: Row) => ({ id: b.id, ...path.read(b) }))
      .orderBy((r: Row) => r.id)
      .toList(),
  },
  {
    name: 'the untyped where().with(cte)',
    run: (db, path, probe) => probed((db as any).getTable('ljm_books').where((b: Row) => gt(b.id, 0)).with(withCte(db)), path, probe)
      .select((b: Row) => ({ id: b.id, ...path.read(b) }))
      .orderBy((r: Row) => r.id)
      .toList(),
  },
  {
    name: 'a leftJoin() of a table subquery, then the probe',
    run: (db, path, probe) => probed(
      db.ljmBooks.leftJoin(shelfLabels(db), (b, s) => eq(b.shelfId, s.shelfId), (b, s) => ({ id: b.id, label: s.label, ...path.read(b) }), 'labels'),
      path,
      probe,
    ).orderBy(r => r.id).toList(),
  },
  {
    name: 'an innerJoin() of a table subquery, then the probe',
    run: (db, path, probe) => probed(
      db.ljmBooks.innerJoin(shelfLabels(db), (b, s) => eq(b.shelfId, s.shelfId), (b, s) => ({ id: b.id, label: s.label, ...path.read(b) }), 'labels'),
      path,
      probe,
    ).orderBy(r => r.id).toList(),
  },
  {
    name: 'the untyped where().leftJoin() of a table subquery',
    run: (db, path, probe) => probed(
      (db as any).getTable('ljm_books').where((b: Row) => gt(b.id, 0))
        .leftJoin(shelfLabels(db), (b: Row, s: Row) => eq(b.shelfId, s.shelfId), (b: Row, s: Row) => ({ id: b.id, label: s.label, ...path.read(b) }), 'labels'),
      path,
      probe,
    ).orderBy((r: Row) => r.id).toList(),
  },
];

describe('lateralJoin() matrix — with() and subquery joins keep the row\'s navigations', () => {
  const cases: MatrixCase[] = [];

  for (const path of PATHS) {
    for (const entry of ROW_ENTRIES) {
      cases.push({
        id: `row/${entry.name}/${path.name}`,
        strategies: ['lateral'],
        hops: path.hops,
        ordered: true,
        run: (db, probe) => entry.run(db, path, probe),
      });
    }

    // Read as the same query reads without with(): an ORDER BY through the probed row is not dropped
    cases.push({
      id: `row/a table's with(cte), ORDER BY the probed row/${path.name}`,
      strategies: ['lateral'],
      hops: path.hops,
      ordered: true,
      run: async (db, probe) => ({
        viaWith: await probed(db.ljmBooks.with(withCte(db)), path, probe).orderBy(b => [path.column(b), b.id]).select(b => ({ id: b.id })).toList(),
        reference: await probed(db.ljmBooks.where(b => gt(b.id, 0)), path, probe).orderBy(b => [path.column(b), b.id]).select(b => ({ id: b.id })).toList(),
      }),
      assert: (result) => {
        const { viaWith, reference } = result as { viaWith: unknown; reference: unknown };
        expect(viaWith).toEqual(reference);
      },
    });
  }

  runMatrix(cases);
});

// ---------------------------------------------------------------------------
// The query-build caches: a probed and a plain shape never share a text
// ---------------------------------------------------------------------------

describe('lateralJoin() matrix — the query-build caches', () => {
  /** A sample of every group: each case's probed and plain texts, built with the caches on, in both orders. */
  const SAMPLE = (): MatrixCase[] => [
    ...hangingCases().filter((_, index) => index % 7 === 0),
    ...itemCases().filter((_, index) => index % 11 === 0),
  ];

  for (const matrixCase of SAMPLE()) {
    for (const strategy of matrixCase.strategies) {
      test(`${matrixCase.id} [${strategy}] — caches on`, async () => {
        const db = dbs[strategy];
        const fresh = {
          plain: (await capture(() => matrixCase.run(db, false))).statements.map(s => s.sql),
          probed: (await capture(() => matrixCase.run(db, true))).statements.map(s => s.sql),
        };

        MockRowCache.setEnabled(true);

        try {
          // Probed first, then plain — and the other way round: neither text is ever served for the other
          for (const order of [[true, false], [false, true], [true, false]] as const) {
            for (const probe of order) {
              const texts = (await capture(() => matrixCase.run(db, probe))).statements.map(s => s.sql);
              expect(texts).toEqual(probe ? fresh.probed : fresh.plain);
            }
          }
        } finally {
          MockRowCache.reset();
          LateralSqlCache.reset();
          NavigationPathCache.reset();
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Refused: every use a probe cannot be rendered in — when the query is built, never a plain join instead
// ---------------------------------------------------------------------------

describe('lateralJoin() matrix — refused uses', () => {
  const REFERENCE = /lateralJoin\(\) takes a reference navigation of the "ljm_books" row/;

  test('a selector that returns no reference navigation of the row', () => {
    const db = dbs.lateral;
    const refused: Array<[string, (b: Row) => unknown, RegExp]> = [
      ['a column', b => b.title, REFERENCE],
      ['a column reached through navigations', b => b.author.region.name, REFERENCE],
      ['the row itself', b => b, REFERENCE],
      ['nothing', () => undefined, REFERENCE],
      ['a constant', () => 1, REFERENCE],
      ['a collection', b => b.copies, /lateralJoin\(\): "copies" is a collection of "ljm_books"/],
      ['a path ending in a collection', b => b.author.books, /lateralJoin\(\): "author\.books" is a collection of "ljm_authors"/],
      ['a path through a collection', b => b.copies.book, /lateralJoin\(\): "copies" is a collection of "ljm_books"/],
    ];

    for (const [, selector, error] of refused) {
      // Every builder refuses it where lateralJoin() is called
      expect(() => db.ljmBooks.lateralJoin(selector)).toThrow(error);
      expect(() => db.ljmBooks.where(b => gt(b.id, 0)).lateralJoin(selector)).toThrow(error);
      expect(() => db.ljmBooks.select(b => ({ id: b.id })).lateralJoin(selector)).toThrow(error);
      expect(() => (db as any).getTable('ljm_books').where((b: Row) => gt(b.id, 0)).lateralJoin(selector)).toThrow(error);
      expect(() => (db as any).getTable('ljm_books').select((b: Row) => ({ id: b.id })).lateralJoin(selector)).toThrow(error);
    }
  });

  test('a collection\'s probe of no reference navigation of its item', async () => {
    const db = dbs.lateral;

    await expectToReject(
      // @ts-expect-error — a column: refused at compile time as well
      () => db.ljmShelves.select(s => ({ titles: s.books!.lateralJoin(b => b.title).select(b => b.title).toList() })).toList(),
      REFERENCE,
    );
    await expectToReject(
      // @ts-expect-error — a collection: refused at compile time as well
      () => db.ljmShelves.select(s => ({ titles: s.books!.lateralJoin(b => b.copies).select(b => b.title).toList() })).toList(),
      /lateralJoin\(\): "copies" is a collection of "ljm_books"/,
    );
  });

  test('update() and delete() of a probed query, in either order, with or without a WHERE', async () => {
    const db = dbs.lateral;
    const UPDATE = /lateralJoin\(\) cannot be combined with update\(\)/;
    const DELETE = /lateralJoin\(\) cannot be combined with delete\(\)/;

    for (const path of PATHS) {
      expect(() => probed(db.ljmBooks.where(b => eq(path.column(b), path.value)), path, true).update({ title: 'x' })).toThrow(UPDATE);
      expect(() => probed(db.ljmBooks.where(b => gt(b.id, 0)), path, true).delete()).toThrow(DELETE);
      expect(() => probed(db.ljmBooks, path, true).where(b => gt(b.id, 0)).update({ pages: 1 })).toThrow(UPDATE);
    }

    // Nothing was written
    expect(await db.ljmBooks.where(b => eq(b.title, 'x')).count()).toBe(0);
    expect(await db.ljmBooks.count()).toBe(6);
  });

  test('a grouped query, grouped before or after the probe', () => {
    const db = dbs.lateral;
    const GROUPED = /lateralJoin\(\) is not supported on a grouped query/;

    for (const path of PATHS) {
      expect(() => probed(db.ljmBooks.select(b => ({ id: b.id, v: path.column(b) })), path, true).groupBy(r => ({ v: r.v }))).toThrow(GROUPED);
      expect(() => probed(db.ljmBooks, path, true).select(b => ({ id: b.id, v: path.column(b) })).groupBy(r => ({ v: r.v }))).toThrow(GROUPED);
    }
  });

  test('a collection flattened by selectMany(), probed before or after flattening', async () => {
    const db = dbs.lateral;
    const FLATTENED = /lateralJoin\(\) is not supported on a collection flattened by selectMany\(\)/;

    await expectToReject(
      () => db.ljmRegions.select(r => ({ titles: r.authors!.lateralJoin(a => a.mentor).selectMany(a => a.books!).select(b => b.title).toList() })).toList(),
      FLATTENED,
    );
    await expectToReject(
      () => db.ljmRegions.select(r => ({ titles: r.authors!.selectMany(a => a.books!).lateralJoin(b => b.author).select(b => b.title).toList() })).toList(),
      FLATTENED,
    );
  });
});

// ---------------------------------------------------------------------------
// The planner: with hash joins and nested loops off, no merge join can read a probed target's key
// ---------------------------------------------------------------------------

describe('lateralJoin() matrix — planner', () => {
  const planner = ENGINE !== 'memory';

  /** The plan PostgreSQL makes of `text` with every join method but the merge join and the probe's nested loop discouraged. */
  const explain = (db: LjmDatabase, statement: Statement): Promise<string> => db.transaction(async (tx) => {
    await tx.query('SET LOCAL enable_hashjoin = off');
    await tx.query('SET LOCAL enable_nestloop = off');
    await tx.query('SET LOCAL enable_seqscan = off');
    const rows = await tx.query(`EXPLAIN (COSTS OFF) ${statement.sql}`, statement.params as any[]);

    return rows.map((row: any) => row['QUERY PLAN']).join('\n');
  });

  /** The probed hops of a sample of every group, each placement of the probe. */
  const SAMPLE = (): MatrixCase[] => [
    ...rootCasesForPlanner(),
    ...hangingCases().filter(c => c.strategies.includes('lateral') && /\/(a list|a count\(\) in a sql fragment|exists\(\) in the WHERE)\//.test(c.id)),
    ...itemCases().filter(c => /\/(a list|count\(\) filtered on a probed column|exists\(\) in the WHERE)\//.test(c.id)),
  ];

  for (const matrixCase of SAMPLE()) {
    test(`${matrixCase.id} — no merge join reads a probed target`, async () => {
      const db = dbs.lateral;
      const run = await capture(() => matrixCase.run(db, true));

      if (!planner) {
        return;
      }

      const hops = typeof matrixCase.hops === 'function' ? matrixCase.hops('lateral') : matrixCase.hops;
      const statement = run.statements.filter(s => /^\s*(WITH|SELECT)/.test(s.sql)).at(-1)!;
      const plan = await explain(db, statement);

      for (const h of hops) {
        const table = h.table.replace(/"/g, '');

        if (!statement.sql.includes(`"${h.alias}__probe"`)) {
          continue;
        }

        // The target is read through the probe's key lookups only: never scanned under the hop's own alias,
        // where a merge join could read it
        // (EXPLAIN quotes a mixed-case alias, and shows one past 63 bytes truncated)
        expect(plan).not.toMatch(new RegExp(`on ${table} "?${h.alias}"?(?:\\s|$)`, 'm'));
        expect(plan).toMatch(new RegExp(`Index (Only )?Scan using \\S+ on ${table} "?${h.alias.slice(0, 50)}`));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Typing: every builder takes lateralJoin() and keeps its type; the builders and IEntityQueryable assign both ways
// ---------------------------------------------------------------------------

describe('lateralJoin() matrix — typing', () => {
  test('every builder keeps its type through lateralJoin(), for paths of one, two and three hops', () => {
    const db = dbs.lateral;

    const table = db.ljmBooks.lateralJoin(b => b.author);
    const whereFirst = db.ljmBooks.where(b => gt(b.id, 0));
    const projected = db.ljmBooks.select(b => ({ id: b.id, author: b.author!.name }));
    const distinct = db.ljmBooks.selectDistinct(b => ({ author: b.author!.name }));
    const joined = db.ljmBooks.innerJoin(db.ljmShelves, (b, s) => eq(b.shelfId, s.id), (b, s) => ({ id: b.id, label: s.label }));

    const t1: AssertType<typeof table, IEntityQueryable<LjmBook>> = table;
    const w1 = whereFirst.lateralJoin(b => b.author!.region);
    const w2: AssertType<typeof w1, typeof whereFirst> = w1;
    const p1 = projected.lateralJoin(b => b.author!.mentor!.region);
    const p2: AssertType<typeof p1, typeof projected> = p1;
    const d1 = distinct.lateralJoin(b => b.author);
    const d2: AssertType<typeof d1, typeof distinct> = d1;
    const j1 = joined.lateralJoin(b => b.author!.region);
    const j2: AssertType<typeof j1, typeof joined> = j1;

    // Every operator after it is still there
    const chained = db.ljmBooks
      .lateralJoin(b => b.author)
      .where(b => gt(b.id, 0))
      .lateralJoin(b => b.author!.region)
      .orderBy(b => b.id)
      .limit(2)
      .offset(0)
      .select(b => ({ id: b.id, region: b.author!.region!.name }))
      .lateralJoin(b => b.shelf)
      .where(r => gt(r.id, 0))
      .orderBy(r => r.id);
    const rows: AssertType<Awaited<ReturnType<typeof chained.toList>>, Array<{ id: number; region: string }>> = [] as Array<{ id: number; region: string }>;

    // A collection: lateralJoin() keeps the collection and every operator before select()
    db.ljmShelves.select(s => ({
      books: s.books!.lateralJoin(b => b.author!.mentor!.mentor).where(b => gt(b.id, 0)).orderBy(b => b.id).limit(1).select(b => ({ id: b.id })).toList(),
    }));

    expect([t1, w2, p2, d2, j2, rows].every(value => value !== undefined)).toBe(true);
  });

  test('every builder is an IEntityQueryable, and an IEntityQueryable probes as the builder it is', () => {
    const db = dbs.lateral;
    const takes = (query: IEntityQueryable<any>): IEntityQueryable<any> => query.lateralJoin(b => b.author);

    const builders: IEntityQueryable<any>[] = [
      db.ljmBooks,
      db.ljmBooks.lateralJoin(b => b.author),
      db.ljmBooks.where(b => gt(b.id, 0)).lateralJoin(b => b.author!.region),
      db.ljmBooks.select(b => ({ id: b.id })).lateralJoin(b => b.author),
      db.ljmBooks.selectDistinct(b => ({ id: b.id })).lateralJoin(b => b.author),
      db.ljmBooks.innerJoin(db.ljmShelves, (b, s) => eq(b.shelfId, s.id), (b, s) => ({ id: b.id, label: s.label })).lateralJoin(b => b.author),
      db.ljmBooks.leftJoin(db.ljmShelves, (b, s) => eq(b.shelfId, s.id), (b, s) => ({ id: b.id, label: s.label })).lateralJoin(b => b.author),
      db.ljmBooks.select(b => ({ id: b.id })).orderBy(r => r.id).limit(1).lateralJoin(b => b.author).withTimeout(5_000),
    ];

    for (const builder of builders) {
      expect(typeof takes(builder).toList).toBe('function');
    }
  });

  test('a selector that returns no reference navigation does not compile, on any typed builder', async () => {
    const db = dbs.lateral;
    const table = db.ljmBooks;
    const queryable: IEntityQueryable<LjmBook> = db.ljmBooks.where(b => gt(b.id, 0));
    const projected = db.ljmBooks.select(b => ({ id: b.id }));
    const REFUSED = /lateralJoin\(\)/;

    // A column, of the row or reached through navigations
    // @ts-expect-error — a column
    expect(() => table.lateralJoin(b => b.title)).toThrow(REFUSED);
    // @ts-expect-error — a column reached through navigations
    expect(() => queryable.lateralJoin(b => b.author!.region!.name)).toThrow(REFUSED);
    // @ts-expect-error — a column of a custom type
    expect(() => projected.lateralJoin(b => b.author!.homeCode)).toThrow(REFUSED);
    // A collection, or a path ending in one
    // @ts-expect-error — a collection
    expect(() => table.lateralJoin(b => b.copies)).toThrow(REFUSED);
    // @ts-expect-error — a path ending in a collection
    expect(() => queryable.lateralJoin(b => b.author!.books)).toThrow(REFUSED);
    // @ts-expect-error — a filtered collection (the selector's row has no collection to filter: it throws there)
    expect(() => projected.lateralJoin(b => b.copies!.where(c => gt(c.id, 0)))).toThrow();
    // A value, or nothing
    // @ts-expect-error — a value
    expect(() => table.lateralJoin(() => 1)).toThrow(REFUSED);
    // @ts-expect-error — nothing
    expect(() => queryable.lateralJoin(() => undefined)).toThrow(REFUSED);
    // A navigation the row does not have, or another table's row
    // @ts-expect-error — a navigation the row does not have
    expect(() => table.lateralJoin(b => b.mentor)).toThrow(REFUSED);
    // @ts-expect-error — a selector of another table's row
    expect(() => table.lateralJoin((s: { label: unknown; books: unknown }) => s.books)).toThrow(REFUSED);

    // A collection's own probe (its selector runs when the query is built)
    const collections = [
      // @ts-expect-error — a column of the item
      () => db.ljmShelves.select(s => ({ a: s.books!.lateralJoin(b => b.title).select(b => b.id).toList() })).toList(),
      // @ts-expect-error — a collection of the item
      () => db.ljmShelves.select(s => ({ a: s.books!.lateralJoin(b => b.copies).select(b => b.id).toList() })).toList(),
    ];

    // Every navigation compiles: optional or asserted, one hop or three, and through an untyped row
    expect(typeof table.lateralJoin(b => b.author).toList).toBe('function');
    expect(typeof table.lateralJoin(b => b.author!.mentor!.region).toList).toBe('function');
    expect(typeof queryable.lateralJoin(b => b.author?.publisher).toList).toBe('function');
    expect(typeof projected.lateralJoin((b: any) => b.shelf).toList).toBe('function');
    expect(typeof (queryable as IEntityQueryable<any>).lateralJoin(b => b.author).toList).toBe('function');

    for (const build of collections) {
      await expectToReject(build, REFUSED);
    }
  });
});
