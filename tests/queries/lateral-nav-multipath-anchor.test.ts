/**
 * Repro test:
 *   A nested collection projection (`parent.children.select(...).toList()`) that navigates
 *   MORE THAN ONE HOP away from the collection root, on a root that ALSO carries a competing
 *   one-hop FK to the very same target table, resolved its deepest joins against the WRONG
 *   anchor and silently returned another row's data.
 *
 *   Shape:
 *
 *     loan -> edition -> book -> category   (the path the projection asks for)
 *     loan -> book                          (competing one-hop FK, `featured_book_id`)
 *
 *   Projection: `ln.edition.book.category.name`
 *
 * THE BUG (before the fix):
 *   `CollectionQueryBuilder.resolveNavigationJoins` snapshots `joinedSchemas` ONCE per outer
 *   iteration. `book` is two hops from the collection root, so it is joined mid-iteration and
 *   never lands in that snapshot. The very next alias (`category`) therefore fails the direct
 *   relation lookup, falls through to `findNavigationPath` — a name-based BFS over the whole
 *   schema graph that has no knowledge of the projection's actual path — and the BFS reaches
 *   `category` one hop sooner via `loan.featured_book_id -> book`. Emitted SQL:
 *
 *     LEFT JOIN "books"      "featuredBook" ON "lateral_0_loans"."featured_book_id" = ...
 *     LEFT JOIN "categories" "category"     ON "featuredBook"."category_id" = "category"."id"   <-- WRONG
 *
 *   Consumer symptom: every line on a loan listing rendered the category of its
 *   *featured* book instead of the category of the book actually borrowed.
 *
 * THE FIX:
 *   Run the direct-relation lookups to a FIXPOINT (keeping `joinedSchemas` current as joins are
 *   added) BEFORE any BFS fallback, so a two-hop parent can anchor its own children. Emitted SQL
 *   becomes `LEFT JOIN "categories" "category" ON "book"."category_id" = "category"."id"` and the
 *   `featuredBook` join disappears entirely (nothing in the projection asked for it).
 *
 * These tests MUST FAIL before the fix and PASS after.
 */

import { describe, test, expect } from '@jest/globals';
import { withCapturedSql } from '../utils/test-database';
import {
  DatabaseClient,
  DbContext,
  DbEntityTable,
  DbModelConfig,
  DbEntity,
  DbColumn,
  integer,
  varchar,
} from '../../src';

// ---------------------------------------------------------------------------
// Schema: member -> loan -> edition -> book -> {category, format}
// plus the competing one-hop loan.featured_book_id -> book
// ---------------------------------------------------------------------------

class NmaCategory extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NmaFormat extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NmaBook extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  categoryId!: DbColumn<number>;
  formatId!: DbColumn<number>;

  category?: NmaCategory;
  format?: NmaFormat;
}

class NmaEdition extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;
  uuid!: DbColumn<string>;

  book?: NmaBook;
}

class NmaMember extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;

  loans?: NmaLoan[];
}

class NmaLoan extends DbEntity {
  id!: DbColumn<number>;
  memberId!: DbColumn<number>;
  editionId!: DbColumn<number>;
  // Nullable in the DB (no .isRequired() on the property config) — the competing FK
  featuredBookId!: DbColumn<number | null>;
  title!: DbColumn<string>;

  member?: NmaMember;
  edition?: NmaEdition;
  featuredBook?: NmaBook;
}

class NmaDatabase extends DbContext {
  get nmaCategories(): DbEntityTable<NmaCategory> {
    return this.table(NmaCategory);
  }

  get nmaFormats(): DbEntityTable<NmaFormat> {
    return this.table(NmaFormat);
  }

  get nmaBooks(): DbEntityTable<NmaBook> {
    return this.table(NmaBook);
  }

  get nmaEditions(): DbEntityTable<NmaEdition> {
    return this.table(NmaEdition);
  }

  get nmaMembers(): DbEntityTable<NmaMember> {
    return this.table(NmaMember);
  }

  get nmaLoans(): DbEntityTable<NmaLoan> {
    return this.table(NmaLoan);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(NmaCategory, entity => {
      entity.toTable('nma_categories');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_categories_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(NmaFormat, entity => {
      entity.toTable('nma_formats');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_formats_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
    });

    model.entity(NmaBook, entity => {
      entity.toTable('nma_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_books_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      entity.property(e => e.categoryId).hasType(integer('category_id')).isRequired();
      entity.property(e => e.formatId).hasType(integer('format_id')).isRequired();

      entity.hasOne(e => e.category, () => NmaCategory)
        .withForeignKey(p => p.categoryId)
        .withPrincipalKey(r => r.id)
        .onDelete('cascade');

      entity.hasOne(e => e.format, () => NmaFormat)
        .withForeignKey(p => p.formatId)
        .withPrincipalKey(t => t.id)
        .onDelete('cascade');
    });

    model.entity(NmaEdition, entity => {
      entity.toTable('nma_editions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_editions_id_seq' }));
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.uuid).hasType(varchar('uuid', 36)).isRequired();

      entity.hasOne(e => e.book, () => NmaBook)
        .withForeignKey(pp => pp.bookId)
        .withPrincipalKey(p => p.id)
        .onDelete('cascade');
    });

    model.entity(NmaMember, entity => {
      entity.toTable('nma_members');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_members_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 50)).isRequired();

      entity.hasMany(e => e.loans, () => NmaLoan)
        .withForeignKey(ln => ln.memberId)
        .withPrincipalKey(o => o.id);
    });

    model.entity(NmaLoan, entity => {
      entity.toTable('nma_loans');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nma_loans_id_seq' }));
      entity.property(e => e.memberId).hasType(integer('member_id')).isRequired();
      entity.property(e => e.editionId).hasType(integer('edition_id')).isRequired();
      entity.property(e => e.featuredBookId).hasType(integer('featured_book_id'));
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();

      entity.hasOne(e => e.member, () => NmaMember)
        .withForeignKey(ln => ln.memberId)
        .withPrincipalKey(o => o.id)
        .onDelete('cascade');

      entity.hasOne(e => e.edition, () => NmaEdition)
        .withForeignKey(ln => ln.editionId)
        .withPrincipalKey(pp => pp.id)
        .onDelete('cascade');

      // The competing one-hop FK to the SAME table the two-hop path ends on
      entity.hasOne(e => e.featuredBook, () => NmaBook)
        .withForeignKey(ln => ln.featuredBookId)
        .withPrincipalKey(p => p.id)
        .onDelete('set null');
    });
  }
}

async function cleanupSchema(client: DatabaseClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS nma_loans CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_members CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_editions CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_books CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_formats CASCADE');
  await client.query('DROP TABLE IF EXISTS nma_categories CASCADE');
}

interface SeedIds {
  borrowedCategoryId: number;
  featuredCategoryId: number;
  editionId: number;
  borrowedBookId: number;
  featuredBookId: number;
  memberId: number;
}

async function seed(db: NmaDatabase): Promise<SeedIds> {
  const [borrowedCategory, featuredCategory] = await db.nmaCategories.insertBulk([
    { name: 'Fiction' },
    { name: 'Reference' },
  ]).returning();

  const [borrowedFormat, featuredFormat] = await db.nmaFormats.insertBulk([
    { name: 'Hardback' },
    { name: 'Audiobook' },
  ]).returning();

  const [borrowedBook, featuredBook] = await db.nmaBooks.insertBulk([
    { name: 'Borrowed title',      categoryId: borrowedCategory.id, formatId: borrowedFormat.id },
    { name: 'Featured title', categoryId: featuredCategory.id,  formatId: featuredFormat.id  },
  ]).returning();

  const [edition] = await db.nmaEditions.insertBulk([
    { bookId: borrowedBook.id, uuid: 'ed-nma-0001' },
  ]).returning();

  const [order] = await db.nmaMembers.insertBulk([
    { code: 'NMA-597' },
  ]).returning();

  await db.nmaLoans.insertBulk([
    {
      memberId: order.id,
      editionId: edition.id,
      featuredBookId: featuredBook.id,
      title: 'Line 1',
    },
  ]);

  return {
    borrowedCategoryId: borrowedCategory.id,
    featuredCategoryId: featuredCategory.id,
    editionId: edition.id,
    borrowedBookId: borrowedBook.id,
    featuredBookId: featuredBook.id,
    memberId: order.id,
  };
}

/**
 * Helper: fresh DB with logQueries hooked up to a capture array so the emitted
 * lateral / CTE SQL can be asserted structurally, not just semantically.
 */
async function withCapture<T>(
  strategy: 'cte' | 'lateral' | 'temptable',
  testFn: (db: NmaDatabase, captured: string[]) => Promise<T>,
): Promise<T> {
  return withCapturedSql(
    (client, options) => new NmaDatabase(client, options),
    strategy,
    cleanupSchema,
    testFn,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nested-collection navigation anchors on the projected path, not a same-table sibling FK', () => {

  // -----------------------------------------------------------------------
  // PRIMARY DEFECT-PROVING TEST
  // -----------------------------------------------------------------------
  test('lateral: ln.edition.book.category.name resolves via book, not via featuredBook', async () => {
    await withCapture('lateral', async (db, captured) => {
      const ids = await seed(db);

      // Drop the DDL / INSERT chatter so the assertions below see only the SELECT
      captured.length = 0;

      const results = await db.nmaMembers
        .select(o => ({
          id: o.id,
          code: o.code,
          items: o.loans!.select(ln => ({
            id: ln.id,
            bookId: ln.edition!.bookId,
            categoryId: ln.edition!.book!.categoryId,
            categoryName: ln.edition!.book!.category!.name,
            formatName: ln.edition!.book!.format!.name,
          })).toList(),
        }))
        .toList();

      expect(results).toHaveLength(1);

      const items = results[0].items as any[];
      expect(items).toHaveLength(1);

      // Semantic: the borrowed book's category / type, NOT the featured book's
      expect(items[0].bookId).toBe(ids.borrowedBookId);
      expect(items[0].categoryId).toBe(ids.borrowedCategoryId);
      expect(items[0].categoryName).toBe('Fiction');
      expect(items[0].formatName).toBe('Hardback');

      // Structural: the category / format joins must anchor on "book"
      const sql = captured.join('\n');
      expect(sql).toContain('"book"."category_id"');
      expect(sql).toContain('"book"."format_id"');

      // ...and the projection never asked for featuredBook, so it must not be joined at all
      expect(sql).not.toContain('"featuredBook"');
      expect(sql).not.toContain('featured_book_id');
    });
  });

  // -----------------------------------------------------------------------
  // Same defect via the CTE strategy (shares resolveNavigationJoins)
  // -----------------------------------------------------------------------
  test('cte: ln.edition.book.category.name resolves via book, not via featuredBook', async () => {
    await withCapture('cte', async (db, captured) => {
      const ids = await seed(db);

      captured.length = 0;

      const results = await db.nmaMembers
        .select(o => ({
          id: o.id,
          items: o.loans!.select(ln => ({
            id: ln.id,
            categoryId: ln.edition!.book!.categoryId,
            categoryName: ln.edition!.book!.category!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items[0].categoryId).toBe(ids.borrowedCategoryId);
      expect(items[0].categoryName).toBe('Fiction');

      const sql = captured.join('\n');
      expect(sql).toContain('"book"."category_id"');
      expect(sql).not.toContain('"featuredBook"');
    });
  });

  // -----------------------------------------------------------------------
  // MINIMAL PROJECTION — the hardest shape.
  // The two tests above co-project `bookId` / `categoryId`, which puts the
  // intermediate aliases (`edition`, `book`) into `allTableAliases`
  // incidentally. Here the projection names ONLY the deep leaf, so the
  // intermediates have to come from the projection's own navigation chain
  // (`__navigationAliases`) — nothing else can supply them.
  // -----------------------------------------------------------------------
  test('lateral: leaf-only projection (no sibling scalars) still anchors on book', async () => {
    await withCapture('lateral', async (db, captured) => {
      await seed(db);

      captured.length = 0;

      const results = await db.nmaMembers
        .select(o => ({
          id: o.id,
          items: o.loans!.select(ln => ({
            categoryName: ln.edition!.book!.category!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items).toHaveLength(1);
      expect(items[0].categoryName).toBe('Fiction');

      const sql = captured.join('\n');
      expect(sql).toContain('"book"."category_id"');
      expect(sql).not.toContain('"featuredBook"');
    });
  });

  test('cte: leaf-only projection (no sibling scalars) still anchors on book', async () => {
    await withCapture('cte', async (db, captured) => {
      await seed(db);

      captured.length = 0;

      const results = await db.nmaMembers
        .select(o => ({
          id: o.id,
          items: o.loans!.select(ln => ({
            categoryName: ln.edition!.book!.category!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items).toHaveLength(1);
      expect(items[0].categoryName).toBe('Fiction');

      const sql = captured.join('\n');
      expect(sql).toContain('"book"."category_id"');
      expect(sql).not.toContain('"featuredBook"');
    });
  });

  // -----------------------------------------------------------------------
  // Counter-test: the one-hop sibling FK must STILL resolve correctly when the
  // projection genuinely asks for it. Guards against "always prefer the long path".
  // -----------------------------------------------------------------------
  test('lateral: an explicit ln.featuredBook.category.name still resolves via featuredBook', async () => {
    await withCapture('lateral', async (db, captured) => {
      const ids = await seed(db);

      captured.length = 0;

      const results = await db.nmaMembers
        .select(o => ({
          id: o.id,
          items: o.loans!.select(ln => ({
            id: ln.id,
            featuredBookId: ln.featuredBook!.id,
            featuredCategoryId: ln.featuredBook!.categoryId,
            featuredCategoryName: ln.featuredBook!.category!.name,
          })).toList(),
        }))
        .toList();

      const items = results[0].items as any[];
      expect(items[0].featuredBookId).toBe(ids.featuredBookId);
      expect(items[0].featuredCategoryId).toBe(ids.featuredCategoryId);
      expect(items[0].featuredCategoryName).toBe('Reference');

      const sql = captured.join('\n');
      expect(sql).toContain('"featuredBook"."category_id"');
    });
  });

  // -----------------------------------------------------------------------
  // Control: the same navigation on a FLAT root query was always correct
  // (the intermediate `book` join lands before its children are resolved).
  // Regression guard — must pass before AND after the fix.
  // -----------------------------------------------------------------------
  test('flat root query on loan resolves the same navigation correctly — regression guard', async () => {
    await withCapture('lateral', async (db) => {
      const ids = await seed(db);

      const rows = await db.nmaLoans
        .select(ln => ({
          id: ln.id,
          categoryId: ln.edition!.book!.categoryId,
          categoryName: ln.edition!.book!.category!.name,
        }))
        .toList();

      expect(rows).toHaveLength(1);
      expect(rows[0].categoryId).toBe(ids.borrowedCategoryId);
      expect(rows[0].categoryName).toBe('Fiction');
    });
  });
});
