/**
 * `selectMany()` over a collection that was filtered BEFORE it was flattened
 * (`l.shelves.where(s => …).selectMany(s => s.books)`), under every collection strategy, in every
 * terminal and in a WHERE / `sql` fragment.
 *
 * The filter is written on the collection's own items, so its columns carry that collection's
 * marker (`"__collection_smw_shelves__"`). `selectMany()` handed the filter to a builder of the
 * FLATTENED table, which resolves only its own table's marker: the shelves' marker reached the
 * database — `missing FROM-clause entry for table "__collection_smw_shelves__"` — for every terminal
 * and every strategy. Its neighbours failed with it:
 * - a filter through a navigation of the shelf (`s.curator.name`) was resolved from the BOOK, by
 *   relation name, through whatever path the schema offered (a second copy of the shelf);
 * - a second `selectMany()` replaced the first hop instead of adding to it (`column
 *   "smw_books"."library_id" does not exist`);
 * - a hop over the flattened table itself (`t.children.selectMany(c => c.children)`) rendered the
 *   hop under the table's own name: ambiguous under the CTE / temp-table strategies, and under
 *   LATERAL it shadowed the outer node, so every node had no grandchildren;
 * - a constant key part of the flattened relation was read from the flattened table (CTE / temp
 *   table), and the correlated subquery joined a hop on its relation's first key pair only.
 *
 * Each hop now renders under an alias of its own (`<relation>__bridge<n>`, `n` counted from the
 * parent); the filter written on a hop's items reads that alias, and the navigations it traverses
 * are joined from it.
 *
 *   smw_libraries <- smw_shelves -> smw_curators          smw_topics (parent_id -> smw_topics)
 *        |              |    ^                                root
 *        |              v    |                                ├── arts
 *        |          smw_books -> smw_genres                   │   ├── music
 *        |              |    \-> smw_curators                 │   │   ├── jazz
 *        |              v                                     │   │   └── opera
 *        |          smw_reviews                               │   └── painting
 *        v                                                    └── science
 *   smw_vault.smw_crates <- smw_vault.smw_parcels                 └── physics
 *
 *   library  main floor   shelf  curator  code  floor  archived   books (pages, genre, curator)
 *   Central  2            S1     Ivy      A     1      no         Alpha (100, Poetry, Max), Beta (250, Drama, Ivy; hidden)
 *                         S2     Max      B     2      yes        Gamma (300, Poetry, -)
 *   Harbor   1            S3     Ivy      C     1      no         Delta (120, Drama, Max)
 *                         S5     Max      E     2      no         -
 *                         S6     -        F     1      yes        Eta (60, -, -)
 *   Empty    1            -
 *   (none)                S4     -        D     3      no         Epsilon (80, Drama, Ivy)
 *   (no shelf)                                                    Zeta (50, Poetry, -)
 *
 *   reviews (stars, reviewer): Alpha 5 ann, 3 bob · Beta 4 ann · Gamma 2 cid, 5 bob · Delta 1 ann · Epsilon 4 dan
 *   crates: Central north (unsealed: parcels 10, 20), south (sealed: 30) · Harbor east (unsealed: 5)
 *
 * Two relations carry a constant key part: `library.openShelves` (`[library_id, archived] = [id,
 * false]`) and `shelf.visibleBooks` (`[shelf_id, visible] = [id, true]`; only Beta is hidden).
 * `smw_sections` has no primary key (Central: S-A with 2 notes, S-B with 1; Harbor: S-C with 1).
 * `"SmwSlots"` has a composite primary key of mixed-case columns (`"ShelfId"`, `"SlotNo"`), and its tags
 * are keyed on both: A 1 top (red, blue), A 2 mid (green), B 1 low (red), C 1 x (-), C 3 y (blue).
 *
 * The `nt_` tables name their reference navigations after the table they point at (`nt_book.nt_shelf`,
 * `nt_shelf.nt_library`, and `nt_book.nt_library` — a book's HOME library, the inverse of no collection):
 *   library  shelf  books (home library)          slots
 *   North    A      a1 (South), a2 (North)        -
 *            B      b1 (North)                    s1
 *   South    C      c1 (North)                    s2
 *            D      -                             -
 *
 * The second half pins the rest of what a flattening can be written with — each used to be ignored
 * silently or to fail: `orderBy()` / `limit()` / `offset()` BEFORE `selectMany()` (the first rows of
 * each parent are flattened; the flattened items come in the order of the rows they come from), a
 * `where()` / `orderBy()` / `limit()` on the collection the selector returns (per flattened row), a
 * selector returning a flattened collection or a collection of a navigation of its item, the shapes
 * that are refused with an error, and the correlated subquery's own `limit()` / `offset()` and its
 * collections over the same table.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  and,
  boolean,
  eq,
  exists,
  gt,
  integer,
  isNull,
  lt,
  ne,
  not,
  notExists,
  or,
  sql,
  varchar,
} from '../../src';
import type { CollectionStrategyType } from '../../src/query/collection-strategy.interface';
import { expectToReject } from '../utils/expect-rejects';
import { createFreshClient } from '../utils/test-database';

class SmwLibrary extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  mainFloor!: DbColumn<number>;

  shelves?: SmwShelf[];
  openShelves?: SmwShelf[];
  crates?: SmwCrate[];
  sections?: SmwSection[];
}

class SmwCurator extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;

  shelves?: SmwShelf[];
}

class SmwGenre extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class SmwShelf extends DbEntity {
  id!: DbColumn<number>;
  libraryId?: DbColumn<number | null>;
  curatorId?: DbColumn<number | null>;
  code!: DbColumn<string>;
  floor!: DbColumn<number>;
  archived!: DbColumn<boolean>;

  library?: SmwLibrary;
  curator?: SmwCurator;
  books?: SmwBook[];
  visibleBooks?: SmwBook[];
  slots?: SmwSlot[];
}

/** A slot of a shelf: a composite primary key of mixed-case columns (`"SmwSlots"("ShelfId", "SlotNo")`). */
class SmwSlot extends DbEntity {
  shelfId!: DbColumn<number>;
  slotNo!: DbColumn<number>;
  label!: DbColumn<string>;

  tags?: SmwSlotTag[];
}

/** A tag of a slot, keyed on both columns of the slot's key. */
class SmwSlotTag extends DbEntity {
  id!: DbColumn<number>;
  shelfId!: DbColumn<number>;
  slotNo!: DbColumn<number>;
  tag!: DbColumn<string>;
}

// A second small domain whose reference navigations carry the NAME of the table they point at
// (`nt_shelf.nt_library`, `nt_book.nt_shelf`): a join of such a navigation renders under the same bare
// name the outer row of that table is read by

class NtLibrary extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;

  shelves?: NtShelf[];
}

class NtShelf extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
  libraryId!: DbColumn<number>;

  nt_library?: NtLibrary;
  books?: NtBook[];
  slots?: NtSlot[];
}

class NtBook extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  shelfId!: DbColumn<number>;
  homeLibraryId?: DbColumn<number | null>;

  // The inverse of `nt_shelf.books`
  nt_shelf?: NtShelf;
  // The book's home library: named like the library table, and the inverse of no collection
  nt_library?: NtLibrary;
}

class NtSlot extends DbEntity {
  id!: DbColumn<number>;
  shelfId!: DbColumn<number>;
  label!: DbColumn<string>;
}

class SmwBook extends DbEntity {
  id!: DbColumn<number>;
  shelfId?: DbColumn<number | null>;
  genreId?: DbColumn<number | null>;
  curatorId?: DbColumn<number | null>;
  title!: DbColumn<string>;
  pages!: DbColumn<number>;
  visible!: DbColumn<boolean>;

  shelf?: SmwShelf;
  genre?: SmwGenre;
  // The same relation NAME the shelf carries, pointing at another row
  curator?: SmwCurator;
  reviews?: SmwReview[];
}

class SmwReview extends DbEntity {
  id!: DbColumn<number>;
  bookId!: DbColumn<number>;
  stars!: DbColumn<number>;
  reviewer!: DbColumn<string>;

  book?: SmwBook;
}

class SmwTopic extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  parentId?: DbColumn<number | null>;

  parent?: SmwTopic;
  children?: SmwTopic[];
}

/** A table without a primary key. */
class SmwSection extends DbEntity {
  code!: DbColumn<string>;
  libraryId!: DbColumn<number>;

  notes?: SmwNote[];
}

class SmwNote extends DbEntity {
  id!: DbColumn<number>;
  sectionCode!: DbColumn<string>;
  body!: DbColumn<string>;
}

class SmwCrate extends DbEntity {
  id!: DbColumn<number>;
  libraryId!: DbColumn<number>;
  label!: DbColumn<string>;
  sealed!: DbColumn<boolean>;

  parcels?: SmwParcel[];
}

class SmwParcel extends DbEntity {
  id!: DbColumn<number>;
  crateId!: DbColumn<number>;
  weight!: DbColumn<number>;
}

class ShelfDatabase extends DbContext {
  get libraries(): DbEntityTable<SmwLibrary> {
    return this.table(SmwLibrary);
  }

  get curators(): DbEntityTable<SmwCurator> {
    return this.table(SmwCurator);
  }

  get genres(): DbEntityTable<SmwGenre> {
    return this.table(SmwGenre);
  }

  get shelves(): DbEntityTable<SmwShelf> {
    return this.table(SmwShelf);
  }

  get books(): DbEntityTable<SmwBook> {
    return this.table(SmwBook);
  }

  get reviews(): DbEntityTable<SmwReview> {
    return this.table(SmwReview);
  }

  get topics(): DbEntityTable<SmwTopic> {
    return this.table(SmwTopic);
  }

  get sections(): DbEntityTable<SmwSection> {
    return this.table(SmwSection);
  }

  get notes(): DbEntityTable<SmwNote> {
    return this.table(SmwNote);
  }

  get crates(): DbEntityTable<SmwCrate> {
    return this.table(SmwCrate);
  }

  get parcels(): DbEntityTable<SmwParcel> {
    return this.table(SmwParcel);
  }

  get slots(): DbEntityTable<SmwSlot> {
    return this.table(SmwSlot);
  }

  get slotTags(): DbEntityTable<SmwSlotTag> {
    return this.table(SmwSlotTag);
  }

  get ntLibraries(): DbEntityTable<NtLibrary> {
    return this.table(NtLibrary);
  }

  get ntShelves(): DbEntityTable<NtShelf> {
    return this.table(NtShelf);
  }

  get ntBooks(): DbEntityTable<NtBook> {
    return this.table(NtBook);
  }

  get ntSlots(): DbEntityTable<NtSlot> {
    return this.table(NtSlot);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SmwLibrary, entity => {
      entity.toTable('smw_libraries');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_libraries_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.mainFloor).hasType(integer('main_floor')).isRequired();

      entity.hasMany(e => e.shelves, () => SmwShelf).withForeignKey(s => s.libraryId!).withPrincipalKey(l => l.id);
      entity.hasMany(e => e.crates, () => SmwCrate).withForeignKey(c => c.libraryId).withPrincipalKey(l => l.id);
      entity.hasMany(e => e.sections, () => SmwSection).withForeignKey(s => s.libraryId).withPrincipalKey(l => l.id);
      // The shelves that are not archived: a key with a constant part
      entity.hasMany(e => e.openShelves, () => SmwShelf)
        .withForeignKey(s => [s.libraryId!, s.archived])
        .withPrincipalKey(l => [l.id, false])
        .isInverseNavigation();
    });

    model.entity(SmwCurator, entity => {
      entity.toTable('smw_curators');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_curators_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();

      entity.hasMany(e => e.shelves, () => SmwShelf).withForeignKey(s => s.curatorId!).withPrincipalKey(c => c.id);
    });

    model.entity(SmwGenre, entity => {
      entity.toTable('smw_genres');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_genres_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
    });

    model.entity(SmwShelf, entity => {
      entity.toTable('smw_shelves');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_shelves_id_seq' }));
      entity.property(e => e.libraryId).hasType(integer('library_id'));
      entity.property(e => e.curatorId).hasType(integer('curator_id'));
      entity.property(e => e.code).hasType(varchar('code', 10)).isRequired();
      entity.property(e => e.floor).hasType(integer('floor')).isRequired();
      entity.property(e => e.archived).hasType(boolean('archived')).isRequired();

      entity.hasOne(e => e.library, () => SmwLibrary).withForeignKey(s => s.libraryId!).withPrincipalKey(l => l.id);
      entity.hasOne(e => e.curator, () => SmwCurator).withForeignKey(s => s.curatorId!).withPrincipalKey(c => c.id);
      entity.hasMany(e => e.books, () => SmwBook).withForeignKey(b => b.shelfId!).withPrincipalKey(s => s.id);
      // The books that are visible: a key with a constant part
      entity.hasMany(e => e.visibleBooks, () => SmwBook)
        .withForeignKey(b => [b.shelfId!, b.visible])
        .withPrincipalKey(s => [s.id, true])
        .isInverseNavigation();
      entity.hasMany(e => e.slots, () => SmwSlot).withForeignKey(x => x.shelfId).withPrincipalKey(s => s.id).isInverseNavigation();
    });

    model.entity(SmwSlot, entity => {
      entity.toTable('SmwSlots');
      entity.property(e => e.shelfId).hasType(integer('ShelfId').primaryKey());
      entity.property(e => e.slotNo).hasType(integer('SlotNo').primaryKey());
      entity.property(e => e.label).hasType(varchar('Label', 10)).isRequired();

      entity.hasMany(e => e.tags, () => SmwSlotTag)
        .withForeignKey(t => [t.shelfId, t.slotNo])
        .withPrincipalKey(s => [s.shelfId, s.slotNo])
        .isInverseNavigation();
    });

    model.entity(SmwSlotTag, entity => {
      entity.toTable('SmwSlotTags');
      entity.property(e => e.id).hasType(integer('Id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_slot_tags_id_seq' }));
      entity.property(e => e.shelfId).hasType(integer('ShelfId')).isRequired();
      entity.property(e => e.slotNo).hasType(integer('SlotNo')).isRequired();
      entity.property(e => e.tag).hasType(varchar('Tag', 10)).isRequired();
    });

    model.entity(NtLibrary, entity => {
      entity.toTable('nt_library');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nt_library_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 20)).isRequired();

      entity.hasMany(e => e.shelves, () => NtShelf).withForeignKey(s => s.libraryId).withPrincipalKey(l => l.id);
    });

    model.entity(NtShelf, entity => {
      entity.toTable('nt_shelf');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nt_shelf_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 5)).isRequired();
      entity.property(e => e.libraryId).hasType(integer('library_id')).isRequired();

      entity.hasOne(e => e.nt_library, () => NtLibrary).withForeignKey(s => s.libraryId).withPrincipalKey(l => l.id);
      entity.hasMany(e => e.books, () => NtBook).withForeignKey(b => b.shelfId).withPrincipalKey(s => s.id);
      entity.hasMany(e => e.slots, () => NtSlot).withForeignKey(x => x.shelfId).withPrincipalKey(s => s.id);
    });

    model.entity(NtBook, entity => {
      entity.toTable('nt_book');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nt_book_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 10)).isRequired();
      entity.property(e => e.shelfId).hasType(integer('shelf_id')).isRequired();
      entity.property(e => e.homeLibraryId).hasType(integer('home_library_id'));

      entity.hasOne(e => e.nt_shelf, () => NtShelf).withForeignKey(b => b.shelfId).withPrincipalKey(s => s.id);
      entity.hasOne(e => e.nt_library, () => NtLibrary).withForeignKey(b => b.homeLibraryId!).withPrincipalKey(l => l.id);
    });

    model.entity(NtSlot, entity => {
      entity.toTable('nt_slot');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'nt_slot_id_seq' }));
      entity.property(e => e.shelfId).hasType(integer('shelf_id')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 10)).isRequired();
    });

    model.entity(SmwBook, entity => {
      entity.toTable('smw_books');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_books_id_seq' }));
      entity.property(e => e.shelfId).hasType(integer('shelf_id'));
      entity.property(e => e.genreId).hasType(integer('genre_id'));
      entity.property(e => e.curatorId).hasType(integer('curator_id'));
      entity.property(e => e.title).hasType(varchar('title', 50)).isRequired();
      entity.property(e => e.pages).hasType(integer('pages')).isRequired();
      entity.property(e => e.visible).hasType(boolean('visible')).isRequired();

      entity.hasOne(e => e.shelf, () => SmwShelf).withForeignKey(b => b.shelfId!).withPrincipalKey(s => s.id);
      entity.hasOne(e => e.genre, () => SmwGenre).withForeignKey(b => b.genreId!).withPrincipalKey(g => g.id);
      entity.hasOne(e => e.curator, () => SmwCurator).withForeignKey(b => b.curatorId!).withPrincipalKey(c => c.id);
      entity.hasMany(e => e.reviews, () => SmwReview).withForeignKey(r => r.bookId).withPrincipalKey(b => b.id);
    });

    model.entity(SmwReview, entity => {
      entity.toTable('smw_reviews');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_reviews_id_seq' }));
      entity.property(e => e.bookId).hasType(integer('book_id')).isRequired();
      entity.property(e => e.stars).hasType(integer('stars')).isRequired();
      entity.property(e => e.reviewer).hasType(varchar('reviewer', 20)).isRequired();

      entity.hasOne(e => e.book, () => SmwBook).withForeignKey(r => r.bookId).withPrincipalKey(b => b.id);
    });

    model.entity(SmwTopic, entity => {
      entity.toTable('smw_topics');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_topics_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.parentId).hasType(integer('parent_id'));

      entity.hasOne(e => e.parent, () => SmwTopic).withForeignKey(t => t.parentId!).withPrincipalKey(p => p.id);
      entity.hasMany(e => e.children, () => SmwTopic).withForeignKey(t => t.parentId!).withPrincipalKey(p => p.id);
    });

    model.entity(SmwSection, entity => {
      entity.toTable('smw_sections');
      entity.property(e => e.code).hasType(varchar('code', 10)).isRequired();
      entity.property(e => e.libraryId).hasType(integer('library_id')).isRequired();

      // Keyed on the section CODE, which is no key column: no FK constraint
      entity.hasMany(e => e.notes, () => SmwNote)
        .withForeignKey(n => n.sectionCode)
        .withPrincipalKey(s => s.code)
        .isInverseNavigation();
    });

    model.entity(SmwNote, entity => {
      entity.toTable('smw_notes');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_notes_id_seq' }));
      entity.property(e => e.sectionCode).hasType(varchar('section_code', 10)).isRequired();
      entity.property(e => e.body).hasType(varchar('body', 20)).isRequired();
    });

    model.entity(SmwCrate, entity => {
      entity.toTable('smw_crates');
      entity.toSchema('smw_vault');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_crates_id_seq' }));
      entity.property(e => e.libraryId).hasType(integer('library_id')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 20)).isRequired();
      entity.property(e => e.sealed).hasType(boolean('sealed')).isRequired();

      entity.hasMany(e => e.parcels, () => SmwParcel).withForeignKey(p => p.crateId).withPrincipalKey(c => c.id);
    });

    model.entity(SmwParcel, entity => {
      entity.toTable('smw_parcels');
      entity.toSchema('smw_vault');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'smw_parcels_id_seq' }));
      entity.property(e => e.crateId).hasType(integer('crate_id')).isRequired();
      entity.property(e => e.weight).hasType(integer('weight')).isRequired();
    });
  }
}

const STRATEGIES: readonly CollectionStrategyType[] = ['lateral', 'cte', 'temptable'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  await client.query('DROP SCHEMA IF EXISTS smw_vault CASCADE');

  for (const table of [
    'nt_slot',
    'nt_book',
    'nt_shelf',
    'nt_library',
    'SmwSlotTags',
    'SmwSlots',
    'smw_notes',
    'smw_sections',
    'smw_reviews',
    'smw_books',
    'smw_shelves',
    'smw_genres',
    'smw_curators',
    'smw_topics',
    'smw_libraries',
  ]) {
    await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
};

let client: DatabaseClient;
let db: ShelfDatabase;
let poetryId: number;
let dramaId: number;
const captured: string[] = [];

beforeAll(async () => {
  client = createFreshClient();
  db = new ShelfDatabase(client, { logQueries: true, logParameters: false, logger: (message: string) => { captured.push(message); } });

  await dropTables(client);
  await db.getSchemaManager().ensureCreated();

  const [central, harbor] = await db.libraries.insertBulk([
    { name: 'Central', mainFloor: 2 },
    { name: 'Harbor', mainFloor: 1 },
    { name: 'Empty', mainFloor: 1 },
  ]).returning();
  const [ivy, max] = await db.curators.insertBulk([{ name: 'Ivy' }, { name: 'Max' }]).returning();
  const [poetry, drama] = await db.genres.insertBulk([{ name: 'Poetry' }, { name: 'Drama' }]).returning();
  const [s1, s2, s3, s4, , s6] = await db.shelves.insertBulk([
    { libraryId: central.id, curatorId: ivy.id, code: 'A', floor: 1, archived: false },
    { libraryId: central.id, curatorId: max.id, code: 'B', floor: 2, archived: true },
    { libraryId: harbor.id, curatorId: ivy.id, code: 'C', floor: 1, archived: false },
    { libraryId: null, curatorId: null, code: 'D', floor: 3, archived: false },
    { libraryId: harbor.id, curatorId: max.id, code: 'E', floor: 2, archived: false },
    { libraryId: harbor.id, curatorId: null, code: 'F', floor: 1, archived: true },
  ]).returning();
  const [alpha, beta, gamma, delta, epsilon] = await db.books.insertBulk([
    { shelfId: s1.id, genreId: poetry.id, curatorId: max.id, title: 'Alpha', pages: 100, visible: true },
    { shelfId: s1.id, genreId: drama.id, curatorId: ivy.id, title: 'Beta', pages: 250, visible: false },
    { shelfId: s2.id, genreId: poetry.id, curatorId: null, title: 'Gamma', pages: 300, visible: true },
    { shelfId: s3.id, genreId: drama.id, curatorId: max.id, title: 'Delta', pages: 120, visible: true },
    { shelfId: s4.id, genreId: drama.id, curatorId: ivy.id, title: 'Epsilon', pages: 80, visible: true },
    { shelfId: null, genreId: poetry.id, curatorId: null, title: 'Zeta', pages: 50, visible: true },
    { shelfId: s6.id, genreId: null, curatorId: null, title: 'Eta', pages: 60, visible: true },
  ]).returning();
  await db.reviews.insertBulk([
    { bookId: alpha.id, stars: 5, reviewer: 'ann' },
    { bookId: alpha.id, stars: 3, reviewer: 'bob' },
    { bookId: beta.id, stars: 4, reviewer: 'ann' },
    { bookId: gamma.id, stars: 2, reviewer: 'cid' },
    { bookId: gamma.id, stars: 5, reviewer: 'bob' },
    { bookId: delta.id, stars: 1, reviewer: 'ann' },
    { bookId: epsilon.id, stars: 4, reviewer: 'dan' },
  ]).returning();

  await db.sections.insertBulk([
    { code: 'S-A', libraryId: central.id },
    { code: 'S-B', libraryId: central.id },
    { code: 'S-C', libraryId: harbor.id },
  ]).returning();
  await db.notes.insertBulk([
    { sectionCode: 'S-A', body: 'n1' },
    { sectionCode: 'S-A', body: 'n2' },
    { sectionCode: 'S-B', body: 'n3' },
    { sectionCode: 'S-C', body: 'n4' },
  ]).returning();

  const [root] = await db.topics.insertBulk([{ name: 'root', parentId: null }]).returning();
  const [arts, science] = await db.topics.insertBulk([{ name: 'arts', parentId: root.id }, { name: 'science', parentId: root.id }]).returning();
  const [music] = await db.topics.insertBulk([
    { name: 'music', parentId: arts.id },
    { name: 'painting', parentId: arts.id },
    { name: 'physics', parentId: science.id },
  ]).returning();
  await db.topics.insertBulk([{ name: 'jazz', parentId: music.id }, { name: 'opera', parentId: music.id }]).returning();

  await db.slots.insertBulk([
    { shelfId: s1.id, slotNo: 1, label: 'top' },
    { shelfId: s1.id, slotNo: 2, label: 'mid' },
    { shelfId: s2.id, slotNo: 1, label: 'low' },
    { shelfId: s3.id, slotNo: 1, label: 'x' },
    { shelfId: s3.id, slotNo: 3, label: 'y' },
  ]).returning();
  await db.slotTags.insertBulk([
    { shelfId: s1.id, slotNo: 1, tag: 'red' },
    { shelfId: s1.id, slotNo: 1, tag: 'blue' },
    { shelfId: s1.id, slotNo: 2, tag: 'green' },
    { shelfId: s2.id, slotNo: 1, tag: 'red' },
    { shelfId: s3.id, slotNo: 3, tag: 'blue' },
  ]).returning();

  const [north, south, east] = await db.crates.insertBulk([
    { libraryId: central.id, label: 'north', sealed: false },
    { libraryId: central.id, label: 'south', sealed: true },
    { libraryId: harbor.id, label: 'east', sealed: false },
  ]).returning();
  await db.parcels.insertBulk([
    { crateId: north.id, weight: 10 },
    { crateId: north.id, weight: 20 },
    { crateId: south.id, weight: 30 },
    { crateId: east.id, weight: 5 },
  ]).returning();

  const [ntNorth, ntSouth] = await db.ntLibraries.insertBulk([{ name: 'North' }, { name: 'South' }]).returning();
  const [ntA, ntB, ntC] = await db.ntShelves.insertBulk([
    { code: 'A', libraryId: ntNorth.id },
    { code: 'B', libraryId: ntNorth.id },
    { code: 'C', libraryId: ntSouth.id },
    { code: 'D', libraryId: ntSouth.id },
  ]).returning();
  await db.ntBooks.insertBulk([
    { title: 'a1', shelfId: ntA.id, homeLibraryId: ntSouth.id },
    { title: 'a2', shelfId: ntA.id, homeLibraryId: ntNorth.id },
    { title: 'b1', shelfId: ntB.id, homeLibraryId: ntNorth.id },
    { title: 'c1', shelfId: ntC.id, homeLibraryId: ntNorth.id },
  ]).returning();
  await db.ntSlots.insertBulk([{ shelfId: ntB.id, label: 's1' }, { shelfId: ntC.id, label: 's2' }]).returning();

  poetryId = poetry.id;
  dramaId = drama.id;
  captured.length = 0;
});

afterAll(async () => {
  await dropTables(client);
  await db.dispose();
});

/** The logged statements (without the logger's `[…]` headers) since the last call. */
const takeStatements = (): string[] => {
  const statements = captured.filter(entry => !entry.trimStart().startsWith('['));
  captured.length = 0;

  return statements;
};

/** How many times `needle` occurs in `text`. */
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/** Topics in id order: root, arts, science, music, painting, physics, jazz, opera. */
const TOPIC_NAMES = ['root', 'arts', 'science', 'music', 'painting', 'physics', 'jazz', 'opera'];

/** Every topic with its list of names: `lists[name]`, an empty list for the topics `lists` does not name. */
const perTopic = (lists: Record<string, string[]>): Array<{ name: string; names: string[] }> =>
  TOPIC_NAMES.map(name => ({ name, names: lists[name] ?? [] }));

for (const strategy of STRATEGIES) {
  const libraries = () => db.libraries.withQueryOptions({ collectionStrategy: strategy }).orderBy(l => l.id);
  const shelves = () => db.shelves.withQueryOptions({ collectionStrategy: strategy }).orderBy(s => s.id);
  const books = () => db.books.withQueryOptions({ collectionStrategy: strategy }).orderBy(b => b.id);
  const topics = () => db.topics.withQueryOptions({ collectionStrategy: strategy }).orderBy(t => t.id);

  describe(`where() before selectMany(), then every terminal — ${strategy}`, () => {
    test('count() counts only the items reached through the rows the filter keeps', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          kept: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count(),
          all: l.shelves!.selectMany(s => s.books!).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', kept: 2, all: 3 },
        { name: 'Harbor', kept: 1, all: 2 },
        { name: 'Empty', kept: 0, all: 0 },
      ]);
    });

    test('exists(), and notExists() over the same flattening', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          upper: l.shelves!.where(s => gt(s.floor, 1)).selectMany(s => s.books!).exists(),
          noUpper: notExists(l.shelves!.where(s => gt(s.floor, 1)).selectMany(s => s.books!)),
        }))
        .toList();

      // Harbor's only upper shelf (E) holds no book
      expect(rows).toEqual([
        { name: 'Central', upper: true, noUpper: false },
        { name: 'Harbor', upper: false, noUpper: true },
        { name: 'Empty', upper: false, noUpper: true },
      ]);
    });

    test('sum(), min() and max() of the flattened items', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          sum: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).sum(b => b.pages),
          min: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).min(b => b.pages),
          max: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).max(b => b.pages),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', sum: 350, min: 100, max: 250 },
        { name: 'Harbor', sum: 120, min: 120, max: 120 },
        { name: 'Empty', sum: null, min: null, max: null },
      ]);
    });

    test('select().toList() of the flattened items, ordered', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          books: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!)
            .orderBy(b => b.title)
            .select(b => ({ title: b.title, pages: b.pages }))
            .toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', books: [{ title: 'Alpha', pages: 100 }, { title: 'Beta', pages: 250 }] },
        { name: 'Harbor', books: [{ title: 'Delta', pages: 120 }] },
        { name: 'Empty', books: [] },
      ]);
    });

    test('toStringList() and toNumberList()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).orderBy(b => b.pages).select(b => b.title).toStringList(),
          pages: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).orderBy(b => [[b.pages, 'DESC']]).select(b => b.pages).toNumberList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta'], pages: [250, 100] },
        { name: 'Harbor', titles: ['Delta'], pages: [120] },
        { name: 'Empty', titles: [], pages: [] },
      ]);
    });

    test('firstOrDefault()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          longest: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!)
            .orderBy(b => [[b.pages, 'DESC']])
            .select(b => ({ title: b.title }))
            .firstOrDefault(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', longest: { title: 'Beta' } },
        { name: 'Harbor', longest: { title: 'Delta' } },
        { name: 'Empty', longest: null },
      ]);
    });

    test('orderBy() + limit() / offset(), and a count() of a limited flattening', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          top: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).orderBy(b => [[b.pages, 'DESC']]).limit(1).select(b => b.title).toStringList(),
          rest: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).orderBy(b => b.pages).offset(1).select(b => ({ title: b.title })).toList(),
          topCount: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).orderBy(b => b.pages).limit(1).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', top: ['Beta'], rest: [{ title: 'Beta' }], topCount: 1 },
        { name: 'Harbor', top: ['Delta'], rest: [], topCount: 1 },
        { name: 'Empty', top: [], rest: [], topCount: 0 },
      ]);
    });

    test('selectDistinct() lists each value once', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          genres: l.shelves!.where(s => ne(s.code, 'F')).selectMany(s => s.books!).selectDistinct(b => b.genreId).toNumberList(),
        }))
        .toList();

      // Central's books: Alpha (Poetry), Beta (Drama), Gamma (Poetry)
      expect(rows.map(row => ({ name: row.name, genres: [...row.genres].sort((a, b) => a - b) }))).toEqual([
        { name: 'Central', genres: [poetryId, dramaId] },
        { name: 'Harbor', genres: [dramaId] },
        { name: 'Empty', genres: [] },
      ]);
    });

    test('several where() calls before selectMany() are AND-ed', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.where(s => lt(s.floor, 3)).where(s => ne(s.code, 'A')).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          count: l.shelves!.where(s => lt(s.floor, 3)).where(s => ne(s.code, 'A')).selectMany(s => s.books!).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', titles: ['Gamma'], count: 1 },
        { name: 'Harbor', titles: ['Delta', 'Eta'], count: 2 },
        { name: 'Empty', titles: [], count: 0 },
      ]);
    });

    test('where() after selectMany() only filters the flattened items (unchanged)', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, count: l.shelves!.selectMany(s => s.books!).where(b => gt(b.pages, 110)).count() }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 2 },
        { name: 'Harbor', count: 1 },
        { name: 'Empty', count: 0 },
      ]);
    });

    test('where() on both sides of selectMany(), several on each side', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          one: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).where(b => gt(b.pages, 110)).count(),
          many: l.shelves!
            .where(s => eq(s.archived, false))
            .where(s => lt(s.floor, 3))
            .selectMany(s => s.books!)
            .where(b => gt(b.pages, 110))
            .where(b => lt(b.pages, 200))
            .select(b => b.title)
            .toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', one: 1, many: [] },
        { name: 'Harbor', one: 1, many: ['Delta'] },
        { name: 'Empty', one: 0, many: [] },
      ]);
    });

    test('a filter reading the OUTER row', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.where(s => eq(s.floor, l.mainFloor)).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          count: l.shelves!.where(s => eq(s.floor, l.mainFloor)).selectMany(s => s.books!).count(),
        }))
        .toList();

      // Central's main floor is 2 (shelf B), Harbor's is 1 (shelves C and F)
      expect(rows).toEqual([
        { name: 'Central', titles: ['Gamma'], count: 1 },
        { name: 'Harbor', titles: ['Delta', 'Eta'], count: 2 },
        { name: 'Empty', titles: [], count: 0 },
      ]);
    });

    test('a filter through a navigation of the filtered item', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.where(s => eq(s.curator!.name, 'Max')).selectMany(s => s.books!).count(),
          titles: l.shelves!.where(s => eq(s.curator!.name, 'Max')).selectMany(s => s.books!).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 1, titles: ['Gamma'] },
        { name: 'Harbor', count: 0, titles: [] },
        { name: 'Empty', count: 0, titles: [] },
      ]);
    });

    test('the filtered item and the flattened item each navigate a relation of the same name', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          books: l.shelves!.where(s => eq(s.curator!.name, 'Ivy')).selectMany(s => s.books!)
            .orderBy(b => b.title)
            .select(b => ({ title: b.title, curator: b.curator!.name }))
            .toList(),
        }))
        .toList();

      // The SHELF's curator is Ivy; each book names its OWN curator. Read as one join, the filter
      // would keep Beta alone (the only book curated by Ivy)
      expect(rows).toEqual([
        { name: 'Central', books: [{ title: 'Alpha', curator: 'Max' }, { title: 'Beta', curator: 'Ivy' }] },
        { name: 'Harbor', books: [{ title: 'Delta', curator: 'Max' }] },
        { name: 'Empty', books: [] },
      ]);
    });

    test('and(), or() and not() in the filter', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          either: l.shelves!.where(s => or(eq(s.code, 'A'), and(eq(s.archived, false), gt(s.floor, 1)))).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
          negated: l.shelves!.where(s => not(eq(s.code, 'A'))).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', either: ['Alpha', 'Beta'], negated: ['Gamma'] },
        { name: 'Harbor', either: [], negated: ['Delta', 'Eta'] },
        { name: 'Empty', either: [], negated: [] },
      ]);
    });

    test('differently filtered flattenings of one navigation in one select stay apart', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          active: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count(),
          upper: l.shelves!.where(s => gt(s.floor, 1)).selectMany(s => s.books!).count(),
          all: l.shelves!.selectMany(s => s.books!).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', active: 2, upper: 1, all: 3 },
        { name: 'Harbor', active: 1, upper: 0, all: 2 },
        { name: 'Empty', active: 0, upper: 0, all: 0 },
      ]);
    });

    test('a filtered collection stays usable on its own once it has been flattened', async () => {
      const rows = await libraries()
        .select(l => {
          const active = l.shelves!.where(s => eq(s.archived, false));

          return {
            name: l.name,
            shelves: active.count(),
            books: active.selectMany(s => s.books!).count(),
            codes: active.orderBy(s => s.code).select(s => s.code).toStringList(),
          };
        })
        .toList();

      expect(rows).toEqual([
        { name: 'Central', shelves: 1, books: 2, codes: ['A'] },
        { name: 'Harbor', shelves: 2, books: 1, codes: ['C', 'E'] },
        { name: 'Empty', shelves: 0, books: 0, codes: [] },
      ]);
    });

    test('hop rows with a NULL foreign key or a NULL navigation reach no parent', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // Shelf D (the only one above floor 2) belongs to no library
          orphans: l.shelves!.where(s => gt(s.floor, 2)).selectMany(s => s.books!).count(),
          anyOrphan: l.shelves!.where(s => gt(s.floor, 2)).selectMany(s => s.books!).exists(),
          // Shelf F has no curator: `name <> 'Max'` is not true for it
          notMax: l.shelves!.where(s => ne(s.curator!.name, 'Max')).selectMany(s => s.books!).count(),
          noneOrMax: l.shelves!.where(s => or(isNull(s.curatorId), eq(s.curator!.name, 'Max'))).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', orphans: 0, anyOrphan: false, notMax: 2, noneOrMax: ['Gamma'] },
        { name: 'Harbor', orphans: 0, anyOrphan: false, notMax: 1, noneOrMax: ['Eta'] },
        { name: 'Empty', orphans: 0, anyOrphan: false, notMax: 0, noneOrMax: [] },
      ]);
    });

    test('parameters of the hop filter, the item filter and the projection bind in order', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          first: l.shelves!.where(s => and(eq(s.code, 'A'), eq(s.archived, false))).selectMany(s => s.books!).where(b => gt(b.pages, 90)).count(),
          second: l.shelves!.where(s => eq(s.floor, 1)).selectMany(s => s.books!).where(b => ne(b.title, 'Delta')).count(),
          books: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!)
            .orderBy(b => b.title)
            .select(b => ({ title: b.title, long: gt(b.pages, 200) }))
            .toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', first: 2, second: 2, books: [{ title: 'Alpha', long: false }, { title: 'Beta', long: true }] },
        { name: 'Harbor', first: 0, second: 1, books: [{ title: 'Delta', long: false }] },
        { name: 'Empty', first: 0, second: 0, books: [] },
      ]);
    });
    test('a raw sql fragment and a subquery in the filter read the filtered item', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          fragment: l.shelves!.where(s => sql<boolean>`${s.floor} + 1 > 2`).selectMany(s => s.books!).count(),
          subquery: l.shelves!
            .where(s => exists(db.books.where(b => and(eq(b.shelfId, s.id), gt(b.pages, 280))).select(b => ({ id: b.id })).asSubquery('table')))
            .selectMany(s => s.books!)
            .count(),
        }))
        .toList();

      // Upper shelves: B (Gamma) and E (empty). A book over 280 pages: Gamma, on B
      expect(rows).toEqual([
        { name: 'Central', fragment: 1, subquery: 1 },
        { name: 'Harbor', fragment: 0, subquery: 0 },
        { name: 'Empty', fragment: 0, subquery: 0 },
      ]);
    });

    test('a prepared query binds the placeholders of the hop filter and of the item filter', async () => {
      const prepared = libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!
            .where(s => eq(s.floor, sql.placeholder('floor')))
            .selectMany(s => s.books!)
            .where(b => gt(b.pages, sql.placeholder('minPages')))
            .count(),
        }))
        .prepare(`smw_floor_books_${strategy}`);

      expect(await prepared.execute({ floor: 1, minPages: 90 })).toEqual([
        { name: 'Central', count: 2 },
        { name: 'Harbor', count: 1 },
        { name: 'Empty', count: 0 },
      ]);
      expect(await prepared.execute({ floor: 2, minPages: 0 })).toEqual([
        { name: 'Central', count: 1 },
        { name: 'Harbor', count: 0 },
        { name: 'Empty', count: 0 },
      ]);
    });
  });

  describe(`selectMany() of a selectMany() — ${strategy}`, () => {
    test('unfiltered: every review of every book of every shelf', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.selectMany(s => s.books!).selectMany(b => b.reviews!).count(),
          stars: l.shelves!.selectMany(s => s.books!).selectMany(b => b.reviews!).orderBy(r => r.id).select(r => r.stars).toNumberList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 5, stars: [5, 3, 4, 2, 5] },
        { name: 'Harbor', count: 1, stars: [1] },
        { name: 'Empty', count: 0, stars: [] },
      ]);
    });

    test('every level filtered: a count and a list', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!
            .where(s => eq(s.archived, false))
            .selectMany(s => s.books!)
            .where(b => gt(b.pages, 110))
            .selectMany(b => b.reviews!)
            .where(r => gt(r.stars, 2))
            .count(),
          reviews: l.shelves!
            .where(s => eq(s.archived, false))
            .selectMany(s => s.books!)
            .where(b => gt(b.pages, 90))
            .selectMany(b => b.reviews!)
            .where(r => gt(r.stars, 2))
            .orderBy(r => r.id)
            .select(r => ({ stars: r.stars, reviewer: r.reviewer }))
            .toList(),
        }))
        .toList();

      // Dropping any one level's filter changes Central's count (2, 3) or Harbor's (1)
      expect(rows).toEqual([
        { name: 'Central', count: 1, reviews: [{ stars: 5, reviewer: 'ann' }, { stars: 3, reviewer: 'bob' }, { stars: 4, reviewer: 'ann' }] },
        { name: 'Harbor', count: 0, reviews: [] },
        { name: 'Empty', count: 0, reviews: [] },
      ]);
    });

    test('sum() and max() over a chain whose first hop is filtered', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          sum: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).selectMany(b => b.reviews!).sum(r => r.stars),
          max: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).selectMany(b => b.reviews!).max(r => r.stars),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', sum: 12, max: 5 },
        { name: 'Harbor', sum: 1, max: 1 },
        { name: 'Empty', sum: null, max: null },
      ]);
    });

    test('a filter through a navigation two levels deep, next to a flattened item reading a relation of the same name', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The books whose SHELF's curator is Ivy; each review names its BOOK's curator
          reviews: l.shelves!.selectMany(s => s.books!).where(b => eq(b.shelf!.curator!.name, 'Ivy')).selectMany(b => b.reviews!)
            .orderBy(r => r.id)
            .select(r => ({ stars: r.stars, bookCurator: r.book!.curator!.name }))
            .toList(),
          count: l.shelves!.selectMany(s => s.books!).where(b => eq(b.shelf!.curator!.name, 'Ivy')).selectMany(b => b.reviews!).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', reviews: [{ stars: 5, bookCurator: 'Max' }, { stars: 3, bookCurator: 'Max' }, { stars: 4, bookCurator: 'Ivy' }], count: 3 },
        { name: 'Harbor', reviews: [{ stars: 1, bookCurator: 'Max' }], count: 1 },
        { name: 'Empty', reviews: [], count: 0 },
      ]);
    });

    test('three levels over one self-referencing table, each level filtered', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          all: t.children!.selectMany(c => c.children!).selectMany(g => g.children!).orderBy(x => x.name).select(x => x.name).toStringList(),
          kept: t.children!
            .where(c => ne(c.name, 'science'))
            .selectMany(c => c.children!)
            .where(g => eq(g.name, 'music'))
            .selectMany(g => g.children!)
            .where(x => ne(x.name, 'opera'))
            .select(x => x.name)
            .toStringList(),
        }))
        .toList();

      expect(rows).toEqual(TOPIC_NAMES.map(name => (name === 'root' ? { name, all: ['jazz', 'opera'], kept: ['jazz'] } : { name, all: [], kept: [] })));
    });
  });

  describe(`a self-referencing hierarchy — ${strategy}`, () => {
    test('the grandchildren of every node', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          names: t.children!.selectMany(c => c.children!).orderBy(g => g.name).select(g => g.name).toStringList(),
          count: t.children!.selectMany(c => c.children!).count(),
        }))
        .toList();

      expect(rows).toEqual(TOPIC_NAMES.map(name => {
        const names = name === 'root' ? ['music', 'painting', 'physics'] : name === 'arts' ? ['jazz', 'opera'] : [];

        return { name, names, count: names.length };
      }));
    });

    test('the grandchildren through the children the filter keeps', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          names: t.children!.where(c => ne(c.name, 'arts')).selectMany(c => c.children!).orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      expect(rows).toEqual(perTopic({ root: ['physics'], arts: ['jazz', 'opera'] }));
    });

    test('a filter comparing the child with the OUTER node of the same table', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          names: t.children!.where(c => gt(c.name, t.name)).selectMany(c => c.children!).orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      // root keeps science (not arts), arts keeps music and painting, music keeps opera (no children)
      expect(rows).toEqual(perTopic({ root: ['physics'], arts: ['jazz', 'opera'] }));
    });

    test('through the parent: the children of every sibling', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          names: t.parent!.children!.where(c => ne(c.id, t.id)).selectMany(c => c.children!).orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      expect(rows).toEqual(perTopic({ arts: ['physics'], science: ['music', 'painting'], painting: ['jazz', 'opera'] }));
    });

    test("a filter holding an exists() over the child's own children", async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          names: t.children!.where(c => exists(c.children!.where(g => eq(g.name, 'jazz')))).selectMany(c => c.children!)
            .orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      expect(rows).toEqual(perTopic({ arts: ['jazz', 'opera'] }));
    });
    test("a filter holding a flattening of the child's own children", async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          // The children that have grandchildren, and then THEIR children
          names: t.children!.where(c => exists(c.children!.selectMany(g => g.children!))).selectMany(c => c.children!)
            .orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      expect(rows).toEqual(perTopic({ root: ['music', 'painting'] }));
    });
  });

  describe(`reached through a reference navigation — ${strategy}`, () => {
    test('the books on the other shelves of the same library', async () => {
      const rows = await shelves()
        .select(s => ({
          code: s.code,
          count: s.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!).count(),
          // A limited list: the LATERAL strategy joins the path inside its own subquery
          titles: s.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!).orderBy(b => b.title).limit(5).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { code: 'A', count: 1, titles: ['Gamma'] },
        { code: 'B', count: 2, titles: ['Alpha', 'Beta'] },
        { code: 'C', count: 1, titles: ['Eta'] },
        { code: 'D', count: 0, titles: [] },
        { code: 'E', count: 2, titles: ['Delta', 'Eta'] },
        { code: 'F', count: 1, titles: ['Delta'] },
      ]);
    });

    test('two navigation hops before the filtered collection', async () => {
      const rows = await books()
        .select(b => ({
          title: b.title,
          // The books on the active shelves of this book's shelf's curator
          peers: b.shelf!.curator!.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { title: 'Alpha', peers: 3 },
        { title: 'Beta', peers: 3 },
        { title: 'Gamma', peers: 0 },
        { title: 'Delta', peers: 3 },
        { title: 'Epsilon', peers: 0 },
        { title: 'Zeta', peers: 0 },
        { title: 'Eta', peers: 0 },
      ]);
    });
  });

  describe(`tables of another schema — ${strategy}`, () => {
    test('the parcels of the unsealed crates', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          weight: l.crates!.where(c => eq(c.sealed, false)).selectMany(c => c.parcels!).sum(p => p.weight),
          count: l.crates!.where(c => eq(c.sealed, false)).selectMany(c => c.parcels!).count(),
          weights: l.crates!.where(c => eq(c.sealed, false)).selectMany(c => c.parcels!).orderBy(p => p.weight).select(p => p.weight).toNumberList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', weight: 30, count: 2, weights: [10, 20] },
        { name: 'Harbor', weight: 5, count: 1, weights: [5] },
        { name: 'Empty', weight: null, count: 0, weights: [] },
      ]);
    });
  });

  describe(`inside another collection — ${strategy}`, () => {
    test('a flattening in a collection projection, filtered by the enclosing item', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          shelves: l.shelves!.orderBy(s => s.code).select(s => ({
            code: s.code,
            // The enclosing shelf and the filtered shelf are rows of one table
            peers: s.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!).count(),
          })).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', shelves: [{ code: 'A', peers: 1 }, { code: 'B', peers: 2 }] },
        { name: 'Harbor', shelves: [{ code: 'C', peers: 1 }, { code: 'E', peers: 2 }, { code: 'F', peers: 1 }] },
        { name: 'Empty', shelves: [] },
      ]);
    });

    test("a hop filter holding an exists() over the hop item's own collection (unchanged)", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.where(s => exists(s.books!.where(b => gt(b.pages, 280)))).selectMany(s => s.books!).count(),
        }))
        .toList();

      // Only shelf B holds a book over 280 pages (Gamma), and nothing else
      expect(rows).toEqual([
        { name: 'Central', count: 1 },
        { name: 'Harbor', count: 0 },
        { name: 'Empty', count: 0 },
      ]);
    });
  });

  describe(`relations with a constant key part — ${strategy}`, () => {
    test("the constant part of the hop's relation joins the flattened items", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.visibleBooks!).orderBy(b => b.title).select(b => b.title).toStringList(),
          count: l.shelves!.selectMany(s => s.visibleBooks!).count(),
        }))
        .toList();

      // Beta is hidden
      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha'], count: 2 },
        { name: 'Harbor', titles: ['Delta'], count: 2 },
        { name: 'Empty', titles: [], count: 0 },
      ]);
    });

    test('the constant part of the flattened relation filters the hop', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.openShelves!.selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          count: l.openShelves!.where(s => eq(s.floor, 1)).selectMany(s => s.books!).count(),
        }))
        .toList();

      // Open shelves: A (Central), C and E (Harbor); F is archived
      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta'], count: 2 },
        { name: 'Harbor', titles: ['Delta'], count: 1 },
        { name: 'Empty', titles: [], count: 0 },
      ]);
    });
  });

  describe(`orderBy() / limit() / offset() before selectMany() — ${strategy}`, () => {
    test('limit() flattens the first rows of each parent only', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          count: l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).count(),
        }))
        .toList();

      // The first shelf by code: A (Central), C (Harbor)
      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta'], count: 2 },
        { name: 'Harbor', titles: ['Delta'], count: 1 },
        { name: 'Empty', titles: [], count: 0 },
      ]);
    });

    test('offset(), and offset() with limit()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          rest: l.shelves!.orderBy(s => s.code).offset(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          second: l.shelves!.orderBy(s => s.code).offset(1).limit(1).selectMany(s => s.books!).count(),
        }))
        .toList();

      // Past the first shelf: B (Central), E and F (Harbor); the second shelf alone: B, E
      expect(rows).toEqual([
        { name: 'Central', rest: ['Gamma'], second: 1 },
        { name: 'Harbor', rest: ['Eta'], second: 0 },
        { name: 'Empty', rest: [], second: 0 },
      ]);
    });

    test('the filter applies before the limit, wherever it is written', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          filteredFirst: l.shelves!.where(s => eq(s.archived, false)).orderBy(s => [[s.code, 'DESC']]).limit(1).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
          filteredLater: l.shelves!.orderBy(s => [[s.code, 'DESC']]).limit(1).where(s => eq(s.archived, false)).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // The first OPEN shelf by code descending: A (Central), E (Harbor, no books). Ignoring the limit
      // would read C's Delta too; filtering after it would keep nothing of Central (B is archived)
      expect(rows).toEqual([
        { name: 'Central', filteredFirst: ['Alpha', 'Beta'], filteredLater: ['Alpha', 'Beta'] },
        { name: 'Harbor', filteredFirst: [], filteredLater: [] },
        { name: 'Empty', filteredFirst: [], filteredLater: [] },
      ]);
    });

    test('a limit ordered through a navigation of the collection, ascending and descending', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          first: l.shelves!.orderBy(s => s.curator!.name).limit(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          last: l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // Ivy before Max; descending, the shelf without a curator (F) comes first, as PostgreSQL sorts NULL
      expect(rows).toEqual([
        { name: 'Central', first: ['Alpha', 'Beta'], last: ['Gamma'] },
        { name: 'Harbor', first: ['Delta'], last: ['Eta'] },
        { name: 'Empty', first: [], last: [] },
      ]);
    });

    test('orderBy() before selectMany() orders the flattened items: a list, a list of objects, firstOrDefault()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.orderBy(s => [[s.code, 'DESC']]).selectMany(s => s.books!.orderBy(b => b.title)).select(b => b.title).toStringList(),
          books: l.shelves!.orderBy(s => [[s.code, 'DESC']]).selectMany(s => s.books!.orderBy(b => b.title)).select(b => ({ title: b.title, pages: b.pages })).toList(),
          first: l.shelves!.orderBy(s => [[s.code, 'DESC']]).selectMany(s => s.books!.orderBy(b => b.title)).select(b => ({ title: b.title })).firstOrDefault(),
        }))
        .toList();

      // Shelves by code descending, each shelf's books by title
      expect(rows).toEqual([
        {
          name: 'Central',
          titles: ['Gamma', 'Alpha', 'Beta'],
          books: [{ title: 'Gamma', pages: 300 }, { title: 'Alpha', pages: 100 }, { title: 'Beta', pages: 250 }],
          first: { title: 'Gamma' },
        },
        { name: 'Harbor', titles: ['Eta', 'Delta'], books: [{ title: 'Eta', pages: 60 }, { title: 'Delta', pages: 120 }], first: { title: 'Eta' } },
        { name: 'Empty', titles: [], books: [], first: null },
      ]);
    });

    test('orderBy() after selectMany() sorts first; the order before it breaks the ties', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.orderBy(s => [[s.code, 'DESC']]).selectMany(s => s.books!).orderBy(b => b.genreId).select(b => b.title).toStringList(),
        }))
        .toList();

      // Central: Alpha and Gamma share a genre — Gamma's shelf (B) comes first
      expect(rows).toEqual([
        { name: 'Central', titles: ['Gamma', 'Alpha', 'Beta'] },
        { name: 'Harbor', titles: ['Delta', 'Eta'] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('a limit after selectMany() takes the first items in that order: a list and a sum()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.orderBy(s => [[s.code, 'DESC']]).selectMany(s => s.books!.orderBy(b => b.title)).limit(2).select(b => b.title).toStringList(),
          pages: l.shelves!.orderBy(s => [[s.code, 'DESC']]).selectMany(s => s.books!.orderBy(b => b.title)).limit(2).sum(b => b.pages),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', titles: ['Gamma', 'Alpha'], pages: 400 },
        { name: 'Harbor', titles: ['Eta', 'Delta'], pages: 180 },
        { name: 'Empty', titles: [], pages: null },
      ]);
    });

    test('a limit on a flattened collection before a second selectMany()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.selectMany(s => s.books!).orderBy(b => [[b.pages, 'DESC']]).limit(2).selectMany(b => b.reviews!).count(),
          stars: l.shelves!.selectMany(s => s.books!).orderBy(b => [[b.pages, 'DESC']]).limit(2).selectMany(b => b.reviews!)
            .orderBy(r => r.id).select(r => r.stars).toNumberList(),
        }))
        .toList();

      // The two longest books of each library: Gamma and Beta (Central), Delta and Eta (Harbor)
      expect(rows).toEqual([
        { name: 'Central', count: 3, stars: [4, 2, 5] },
        { name: 'Harbor', count: 1, stars: [1] },
        { name: 'Empty', count: 0, stars: [] },
      ]);
    });

    test('limits at two levels', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          stars: l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).orderBy(b => [[b.pages, 'DESC']]).limit(1).selectMany(b => b.reviews!)
            .orderBy(r => r.id).select(r => r.stars).toNumberList(),
        }))
        .toList();

      // The longest book of the first shelf: Beta (Central), Delta (Harbor)
      expect(rows).toEqual([
        { name: 'Central', stars: [4] },
        { name: 'Harbor', stars: [1] },
        { name: 'Empty', stars: [] },
      ]);
    });

    test('offset() without orderBy() skips rows in primary-key order', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, titles: l.shelves!.offset(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList() }))
        .toList();

      // Past the first shelf by id: B (Central), E and F (Harbor)
      expect(rows).toEqual([
        { name: 'Central', titles: ['Gamma'] },
        { name: 'Harbor', titles: ['Eta'] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('a filter through a navigation applies before the limit', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.where(s => eq(s.curator!.name, 'Ivy')).orderBy(s => [[s.code, 'DESC']]).limit(1).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
          skipped: l.shelves!.where(s => eq(s.curator!.name, 'Ivy')).orderBy(s => [[s.code, 'DESC']]).offset(1).selectMany(s => s.books!)
            .select(b => b.title).toStringList(),
        }))
        .toList();

      // Ivy's last shelf by code: A (Central), C (Harbor) — not the library's last shelf, which is Max's or nobody's.
      // Ivy has no second shelf in either library
      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta'], skipped: [] },
        { name: 'Harbor', titles: ['Delta'], skipped: [] },
        { name: 'Empty', titles: [], skipped: [] },
      ]);
    });

    test('a prepared query binds a placeholder the limit reads twice', async () => {
      const prepared = libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.where(s => eq(s.archived, sql.placeholder('archived'))).orderBy(s => [[s.code, 'DESC']]).limit(1).selectMany(s => s.books!)
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .prepare(`smw_first_shelf_books_${strategy}`);

      // The last open shelf by code: A (Central), E (Harbor, no books); the last archived one: B, F
      expect(await prepared.execute({ archived: false })).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta'] },
        { name: 'Harbor', titles: [] },
        { name: 'Empty', titles: [] },
      ]);
      expect(await prepared.execute({ archived: true })).toEqual([
        { name: 'Central', titles: ['Gamma'] },
        { name: 'Harbor', titles: ['Eta'] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('inside a collection projection: the books on the first shelf of each shelf\'s library', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          shelves: l.shelves!.orderBy(s => s.code).select(s => ({
            code: s.code,
            firstShelfBooks: s.library!.shelves!.orderBy(x => x.code).limit(1).selectMany(x => x.books!).count(),
          })).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', shelves: [{ code: 'A', firstShelfBooks: 2 }, { code: 'B', firstShelfBooks: 2 }] },
        { name: 'Harbor', shelves: [{ code: 'C', firstShelfBooks: 1 }, { code: 'E', firstShelfBooks: 1 }, { code: 'F', firstShelfBooks: 1 }] },
        { name: 'Empty', shelves: [] },
      ]);
    });

    test('a self-referencing hierarchy: the children of the first child', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          names: t.children!.orderBy(c => c.name).limit(1).selectMany(c => c.children!).orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      expect(rows).toEqual(perTopic({ root: ['music', 'painting'], arts: ['jazz', 'opera'] }));
    });

    test('a limit over a table without a primary key is refused; the flattening itself is not', async () => {
      const rows = await libraries().select(l => ({ name: l.name, notes: l.sections!.selectMany(s => s.notes!).count() })).toList();

      expect(rows).toEqual([
        { name: 'Central', notes: 3 },
        { name: 'Harbor', notes: 1 },
        { name: 'Empty', notes: 0 },
      ]);
      await expectToReject(
        async () => libraries().select(l => ({ notes: l.sections!.orderBy(s => s.code).limit(1).selectMany(s => s.notes!).count() })).toList(),
        'has no primary key',
      );
    });
  });

  describe(`the collection the selector returns: where(), orderBy(), limit() — ${strategy}`, () => {
    test('its where() filters the flattened items, next to filters before and after selectMany()', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.selectMany(s => s.books!.where(b => gt(b.pages, 110))).count(),
          titles: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!.where(b => gt(b.pages, 90))).where(b => lt(b.pages, 200))
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 2, titles: ['Alpha'] },
        { name: 'Harbor', count: 1, titles: ['Delta'] },
        { name: 'Empty', count: 0, titles: [] },
      ]);
    });

    test('its where() may read the item it flattens', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The books curated by their own shelf's curator
          titles: l.shelves!.selectMany(s => s.books!.where(b => eq(b.curatorId, s.curatorId))).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', titles: ['Beta'] },
        { name: 'Harbor', titles: [] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('its where() may read the item it flattens — over one self-referencing table', async () => {
      const rows = await topics()
        .select(t => ({
          name: t.name,
          // The grandchildren named after their parent
          names: t.children!.selectMany(c => c.children!.where(g => gt(g.name, c.name))).orderBy(g => g.name).select(g => g.name).toStringList(),
        }))
        .toList();

      expect(rows).toEqual(perTopic({ root: ['music', 'painting'], arts: ['opera'] }));
    });

    test('its where() may read the OUTER row', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.selectMany(s => s.books!.where(b => sql<boolean>`${b.pages} > ${l.mainFloor} * 100`)).orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', titles: ['Beta', 'Gamma'] },
        { name: 'Harbor', titles: ['Delta'] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('its orderBy() + limit() keep the first items of each flattened row', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          longest: l.shelves!.selectMany(s => s.books!.orderBy(b => [[b.pages, 'DESC']]).limit(1)).orderBy(b => b.title).select(b => b.title).toStringList(),
          filteredFirst: l.shelves!.selectMany(s => s.books!.where(b => lt(b.pages, 200)).orderBy(b => [[b.pages, 'DESC']]).limit(1))
            .orderBy(b => b.title).select(b => b.title).toStringList(),
          filteredAfter: l.shelves!.selectMany(s => s.books!.orderBy(b => [[b.pages, 'DESC']]).limit(1)).where(b => lt(b.pages, 200))
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // The longest book of each shelf; the longest one under 200 pages; the longest one, if under 200 pages
      expect(rows).toEqual([
        { name: 'Central', longest: ['Beta', 'Gamma'], filteredFirst: ['Alpha'], filteredAfter: [] },
        { name: 'Harbor', longest: ['Delta', 'Eta'], filteredFirst: ['Delta', 'Eta'], filteredAfter: ['Delta', 'Eta'] },
        { name: 'Empty', longest: [], filteredFirst: [], filteredAfter: [] },
      ]);
    });

    test('its filter through a navigation of its items applies before its limit', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.selectMany(s => s.books!.where(b => eq(b.genre!.name, 'Drama')).orderBy(b => b.pages).limit(1))
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // The shortest Drama book of each shelf: Beta (A), Delta (C) — Alpha, A's shortest, is Poetry
      expect(rows).toEqual([
        { name: 'Central', titles: ['Beta'] },
        { name: 'Harbor', titles: ['Delta'] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('its offset()', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, titles: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).offset(1)).select(b => b.title).toStringList() }))
        .toList();

      // Only shelf A holds a second book
      expect(rows).toEqual([
        { name: 'Central', titles: ['Beta'] },
        { name: 'Harbor', titles: [] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test('its limit(), then a second selectMany()', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, count: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).limit(1)).selectMany(b => b.reviews!).count() }))
        .toList();

      // The shortest book of each shelf: Alpha (2 reviews), Gamma (2) — Delta (1), Eta (none)
      expect(rows).toEqual([
        { name: 'Central', count: 4 },
        { name: 'Harbor', count: 1 },
        { name: 'Empty', count: 0 },
      ]);
    });
  });

  describe(`a selector returning a flattened collection — ${strategy}`, () => {
    test('flattens the flattened collection', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.selectMany(s => s.books!.selectMany(b => b.reviews!)).count(),
          stars: l.shelves!.selectMany(s => s.books!.selectMany(b => b.reviews!)).orderBy(r => r.id).select(r => r.stars).toNumberList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 5, stars: [5, 3, 4, 2, 5] },
        { name: 'Harbor', count: 1, stars: [1] },
        { name: 'Empty', count: 0, stars: [] },
      ]);
    });

    test('every level filtered, inside and outside the selector', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!.where(b => gt(b.pages, 110)).selectMany(b => b.reviews!).where(r => gt(r.stars, 2))).count(),
          reviewers: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!.where(b => gt(b.pages, 110)).selectMany(b => b.reviews!).where(r => gt(r.stars, 2)))
            .select(r => r.reviewer).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 1, reviewers: ['ann'] },
        { name: 'Harbor', count: 0, reviewers: [] },
        { name: 'Empty', count: 0, reviewers: [] },
      ]);
    });

    test('its limits apply per flattened row', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The reviews of each shelf's longest book
          ofLongest: l.shelves!.selectMany(s => s.books!.orderBy(b => [[b.pages, 'DESC']]).limit(1).selectMany(b => b.reviews!))
            .orderBy(r => r.id).select(r => r.stars).toNumberList(),
          // The best review of each shelf
          best: l.shelves!.selectMany(s => s.books!.selectMany(b => b.reviews!).orderBy(r => [[r.stars, 'DESC']]).limit(1))
            .orderBy(r => r.id).select(r => r.stars).toNumberList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', ofLongest: [4, 2, 5], best: [5, 5] },
        { name: 'Harbor', ofLongest: [1], best: [1] },
        { name: 'Empty', ofLongest: [], best: [] },
      ]);
    });

    test('the items come in the order of every level', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          stars: l.shelves!.orderBy(s => s.code).selectMany(s => s.books!.orderBy(b => b.title).selectMany(b => b.reviews!.orderBy(r => r.stars)))
            .select(r => r.stars).toNumberList(),
        }))
        .toList();

      // Shelf A: Alpha (3, 5), Beta (4); shelf B: Gamma (2, 5)
      expect(rows).toEqual([
        { name: 'Central', stars: [3, 5, 4, 2, 5] },
        { name: 'Harbor', stars: [1] },
        { name: 'Empty', stars: [] },
      ]);
    });
  });

  describe(`a selector reaching its collection through a navigation — ${strategy}`, () => {
    test("the shelves of each shelf's curator", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.selectMany(s => s.curator!.shelves!).count(),
          codes: l.shelves!.selectMany(s => s.curator!.shelves!).orderBy(x => x.code).select(x => x.code).toStringList(),
        }))
        .toList();

      // Ivy curates A and C, Max B and E; F has no curator. Central: A → A, C; B → B, E
      expect(rows).toEqual([
        { name: 'Central', count: 4, codes: ['A', 'B', 'C', 'E'] },
        { name: 'Harbor', count: 4, codes: ['A', 'B', 'C', 'E'] },
        { name: 'Empty', count: 0, codes: [] },
      ]);
    });

    test('filtered by the item, and ordered at both levels', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          codes: l.shelves!.where(s => eq(s.archived, false)).orderBy(s => s.code)
            .selectMany(s => s.curator!.shelves!.where(x => ne(x.id, s.id)).orderBy(x => x.code))
            .select(x => x.code).toStringList(),
        }))
        .toList();

      // Each open shelf's curator's OTHER shelves: A → C; C → A, E → B
      expect(rows).toEqual([
        { name: 'Central', codes: ['C'] },
        { name: 'Harbor', codes: ['A', 'B'] },
        { name: 'Empty', codes: [] },
      ]);
    });

    test('a limit per flattened row, through the navigation', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          codes: l.shelves!.selectMany(s => s.curator!.shelves!.orderBy(x => x.code).limit(1)).orderBy(x => x.code).select(x => x.code).toStringList(),
        }))
        .toList();

      // The first shelf of each shelf's curator: A (Ivy), B (Max)
      expect(rows).toEqual([
        { name: 'Central', codes: ['A', 'B'] },
        { name: 'Harbor', codes: ['A', 'B'] },
        { name: 'Empty', codes: [] },
      ]);
    });

    test('a flattened collection of the navigation', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          count: l.shelves!.selectMany(s => s.curator!.shelves!.selectMany(x => x.books!)).count(),
          titles: l.shelves!.selectMany(s => s.curator!.shelves!.selectMany(x => x.books!)).orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // The books on the shelves of each shelf's curator: Ivy's A and C, Max's B and E
      expect(rows).toEqual([
        { name: 'Central', count: 4, titles: ['Alpha', 'Beta', 'Delta', 'Gamma'] },
        { name: 'Harbor', count: 4, titles: ['Alpha', 'Beta', 'Delta', 'Gamma'] },
        { name: 'Empty', count: 0, titles: [] },
      ]);
    });

    test('a limit ordered through the navigation the selector reads its collection through', async () => {
      takeStatements();
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          codes: l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).selectMany(s => s.curator!.shelves!)
            .orderBy(x => x.code).select(x => x.code).toStringList(),
          count: l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).selectMany(s => s.curator!.shelves!).count(),
          fragment: sql<number>`${l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).selectMany(s => s.curator!.shelves!).count()}::int`,
        }))
        .toList();
      const statements = takeStatements();
      const found = await libraries()
        .where(l => exists(l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).selectMany(s => s.curator!.shelves!)))
        .select(l => ({ name: l.name }))
        .toList();

      // The last shelf by its curator's name: Central's B (Max, who curates B and E); Harbor's F — no curator,
      // first descending as PostgreSQL sorts NULL — whose curator has no shelves
      expect(rows).toEqual([
        { name: 'Central', codes: ['B', 'E'], count: 2, fragment: 2 },
        { name: 'Harbor', codes: [], count: 0, fragment: 0 },
        { name: 'Empty', codes: [], count: 0, fragment: 0 },
      ]);
      expect(found.map(row => row.name)).toEqual(['Central']);
      // The ranking joins the curator of each shelf it ranks — the key is no constant of the row outside
      expect(statements.join('\n')).toContain(
        'FROM "smw_shelves" "shelves__bridge1"\nLEFT JOIN "smw_curators" "shelves__bridge1__curator" ON "shelves__bridge1"."curator_id" = "shelves__bridge1__curator"."id"',
      );
    });

    test('a limit filtered through the navigation the selector reads its collection through', async () => {
      takeStatements();
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          codes: l.shelves!.where(s => eq(s.curator!.name, 'Max')).orderBy(s => s.code).limit(1).selectMany(s => s.curator!.shelves!)
            .orderBy(x => x.code).select(x => x.code).toStringList(),
          count: l.shelves!.where(s => eq(s.curator!.name, 'Max')).orderBy(s => s.code).limit(1).selectMany(s => s.curator!.shelves!).count(),
          fragment: sql<number>`${l.shelves!.where(s => eq(s.curator!.name, 'Max')).orderBy(s => s.code).limit(1).selectMany(s => s.curator!.shelves!).count()}::int`,
        }))
        .toList();
      const statements = takeStatements();
      const found = await libraries()
        .where(l => exists(l.shelves!.where(s => eq(s.curator!.name, 'Max')).orderBy(s => s.code).limit(1).selectMany(s => s.curator!.shelves!)))
        .select(l => ({ name: l.name }))
        .toList();

      // The first of each library's shelves Max curates — Central's B, Harbor's E — flattens Max's shelves
      expect(rows).toEqual([
        { name: 'Central', codes: ['B', 'E'], count: 2, fragment: 2 },
        { name: 'Harbor', codes: ['B', 'E'], count: 2, fragment: 2 },
        { name: 'Empty', codes: [], count: 0, fragment: 0 },
      ]);
      expect(found.map(row => row.name)).toEqual(['Central', 'Harbor']);
      // The ranking filters each shelf it ranks by its own curator
      expect(statements.join('\n')).toContain(
        'FROM "smw_shelves" "shelves__bridge1"\nLEFT JOIN "smw_curators" "shelves__bridge1__curator" ON "shelves__bridge1"."curator_id" = "shelves__bridge1__curator"."id"',
      );
    });

    test('a limit counting items reached through the navigation is refused', async () => {
      await expectToReject(
        async () => libraries()
          .select(l => ({ n: l.shelves!.selectMany(s => s.curator!.shelves!).orderBy(x => x.code).limit(1).selectMany(x => x.books!).count() }))
          .toList(),
        'navigation',
      );
    });
  });

  describe(`a collection's count() in a sql fragment, inside a collection — ${strategy}`, () => {
    test('its filter holds an exists() over its own items', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          shelves: l.shelves!.orderBy(s => s.code).select(s => ({
            code: s.code,
            reviewed: sql<number>`${s.books!.where(b => exists(b.reviews!)).count()}::int`,
          })).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', shelves: [{ code: 'A', reviewed: 2 }, { code: 'B', reviewed: 1 }] },
        { name: 'Harbor', shelves: [{ code: 'C', reviewed: 1 }, { code: 'E', reviewed: 0 }, { code: 'F', reviewed: 0 }] },
        { name: 'Empty', shelves: [] },
      ]);
    });
  });

  describe(`a flattening or a collection nested in the filter of a flattening — ${strategy}`, () => {
    test("a flattening in the filter of the selector's collection, through the same relations, keeps a hop alias of its own (unchanged)", async () => {
      // Base read no filter here at all — which keeps every book of this data; the next test tells them apart
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The books with a book on ANOTHER shelf of their library
          count: l.shelves!.selectMany(s => s.books!.where(b => exists(b.shelf!.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!)))).count(),
        }))
        .toList();

      // Every book of Central (shelves A, B) and of Harbor (C, F; E holds none) has one on another shelf
      expect(rows).toEqual([
        { name: 'Central', count: 3 },
        { name: 'Harbor', count: 2 },
        { name: 'Empty', count: 0 },
      ]);
    });

    test('the nested flattening filters its own items, and reads the hop of the enclosing one', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The books with a book of over 200 pages on ANOTHER shelf of their library
          titles: l.shelves!.selectMany(s => s.books!.where(b => exists(b.shelf!.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!.where(y => gt(y.pages, 200))))))
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // Central: A's books see Gamma (B), B's Gamma sees Beta (A); Harbor holds no book over 200 pages
      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta', 'Gamma'] },
        { name: 'Harbor', titles: [] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test("a collection of the hop's item in the filter of the selector's collection correlates to that hop", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The books whose shelf holds ANOTHER visible book
          titles: l.shelves!.selectMany(s => s.books!.where(b => exists(s.visibleBooks!.where(v => ne(v.id, b.id))))).orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // Shelf A: Beta sees Alpha (Beta itself is hidden); every other shelf holds a single book
      expect(rows).toEqual([
        { name: 'Central', titles: ['Beta'] },
        { name: 'Harbor', titles: [] },
        { name: 'Empty', titles: [] },
      ]);
    });

    test("a navigation's collection flattened after a filter read the same navigation's collection", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The shelves of the curator of each book whose curator has a shelf
          count: l.shelves!.selectMany(s => s.books!.where(b => exists(b.curator!.shelves!))).selectMany(b => b.curator!.shelves!).count(),
          codes: l.shelves!.selectMany(s => s.books!.where(b => exists(b.curator!.shelves!))).selectMany(b => b.curator!.shelves!)
            .orderBy(x => x.code).select(x => x.code).toStringList(),
        }))
        .toList();

      // Central: Alpha (Max: B, E), Beta (Ivy: A, C); Harbor: Delta (Max: B, E). Gamma and Eta have no curator
      expect(rows).toEqual([
        { name: 'Central', count: 4, codes: ['A', 'B', 'C', 'E'] },
        { name: 'Harbor', count: 2, codes: ['B', 'E'] },
        { name: 'Empty', count: 0, codes: [] },
      ]);
    });
  });

  // select() before selectMany(), and a selector returning a projection, are outside the typed API (hence
  // the casts): base read them as the collection itself — right for a count — and they must not fail now
  describe(`selectDistinct(), select() and a projection around selectMany() — ${strategy}`, () => {
    test('selectDistinct() after a flattening of an ordered collection lists each value once (unchanged)', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          before: l.shelves!.orderBy(s => s.code).selectMany(s => s.books!).selectDistinct(b => b.visible).toList(),
          inside: l.shelves!.selectMany(s => s.books!.orderBy(b => b.title)).selectDistinct(b => b.visible).toList(),
        }))
        .toList();

      // A distinct list has no order: the order the flattened items inherit is dropped
      expect(rows.map(row => ({ name: row.name, before: [...row.before].sort(), inside: [...row.inside].sort() }))).toEqual([
        { name: 'Central', before: [false, true], inside: [false, true] },
        { name: 'Harbor', before: [true], inside: [true] },
        { name: 'Empty', before: [], inside: [] },
      ]);
    });

    test('selectDistinct() after a limit ranked in that order lists the values of the rows the limit keeps', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The last shelf by code; the longest book of each shelf
          before: l.shelves!.orderBy(s => [[s.code, 'DESC']]).limit(1).selectMany(s => s.books!).selectDistinct(b => b.pages).toNumberList(),
          inside: l.shelves!.selectMany(s => s.books!.orderBy(b => [[b.pages, 'DESC']]).limit(1)).selectDistinct(b => b.pages).toNumberList(),
        }))
        .toList();

      const byValue = (values: number[]): number[] => [...values].sort((a, b) => a - b);
      expect(rows.map(row => ({ name: row.name, before: byValue(row.before), inside: byValue(row.inside) }))).toEqual([
        { name: 'Central', before: [300], inside: [250, 300] },
        { name: 'Harbor', before: [60], inside: [60, 120] },
        { name: 'Empty', before: [], inside: [] },
      ]);
    });

    test('select() before selectMany() flattens the collection the projection holds (unchanged)', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, count: (l.shelves!.select(s => ({ books: s.books! })) as any).selectMany((x: any) => x.books).count() }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 3 },
        { name: 'Harbor', count: 2 },
        { name: 'Empty', count: 0 },
      ]);
    });

    test('a projected collection keeps its filter, whatever its field is named', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          long: (l.shelves!.select(s => ({ items: s.books!.where(b => gt(b.pages, 110)) })) as any).selectMany((x: any) => x.items).count(),
          titles: (l.shelves!.where(s => eq(s.archived, false)).select(s => ({ items: s.books! })) as any).selectMany((x: any) => x.items)
            .orderBy((b: any) => b.title).select((b: any) => b.title).toStringList(),
        }))
        .toList();

      // Over 110 pages: Beta, Gamma (Central), Delta (Harbor). The open shelves: A (Central), C and E (Harbor)
      expect(rows).toEqual([
        { name: 'Central', long: 2, titles: ['Alpha', 'Beta'] },
        { name: 'Harbor', long: 1, titles: ['Delta'] },
        { name: 'Empty', long: 0, titles: [] },
      ]);
    });

    test("a selector returning a projection of its collection: the count of the flattened items (unchanged)", async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, count: l.shelves!.selectMany(s => s.books!.select(b => b.title) as any).count() }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', count: 3 },
        { name: 'Harbor', count: 2 },
        { name: 'Empty', count: 0 },
      ]);
    });

    test('a selector returning a projection of its collection: the flattened items are the projection', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          titles: l.shelves!.orderBy(s => s.code).selectMany(s => s.books!.orderBy(b => b.title).select(b => b.title) as any).toStringList(),
          books: (l.shelves!.selectMany(s => s.books!.where(b => gt(b.pages, 110)).orderBy(b => b.pages).select(b => ({ title: b.title, pages: b.pages })) as any) as any).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', titles: ['Alpha', 'Beta', 'Gamma'], books: [{ title: 'Beta', pages: 250 }, { title: 'Gamma', pages: 300 }] },
        { name: 'Harbor', titles: ['Delta', 'Eta'], books: [{ title: 'Delta', pages: 120 }] },
        { name: 'Empty', titles: [], books: [] },
      ]);
    });

    test("a selector's projection may read the row it flattens", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          books: (l.shelves!.selectMany(s => s.books!.orderBy(b => b.title).select(b => ({ title: b.title, code: s.code })) as any) as any).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', books: [{ title: 'Alpha', code: 'A' }, { title: 'Beta', code: 'A' }, { title: 'Gamma', code: 'B' }] },
        { name: 'Harbor', books: [{ title: 'Delta', code: 'C' }, { title: 'Eta', code: 'F' }] },
        { name: 'Empty', books: [] },
      ]);
    });

    test("a selector's projection may aggregate a collection of the flattened item", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          books: (l.shelves!.selectMany(s => s.books!.orderBy(b => b.title).select(b => ({ title: b.title, reviews: b.reviews!.count() })) as any) as any).toList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', books: [{ title: 'Alpha', reviews: 2 }, { title: 'Beta', reviews: 1 }, { title: 'Gamma', reviews: 2 }] },
        { name: 'Harbor', books: [{ title: 'Delta', reviews: 1 }, { title: 'Eta', reviews: 0 }] },
        { name: 'Empty', books: [] },
      ]);
    });

    test("a collection of the flattened row in a selector's projection: refused as a projected aggregate, counted in a sql fragment", async () => {
      const refused = await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({ title: b.title, visible: s.visibleBooks!.count() })) as any) as any).toList(),
        })).toList(),
      );
      expect(refused.message).toBe(
        'The projection of the items of "books" flattened by selectMany() reads "visibleBooks", a collection of a row they were flattened through: '
        + 'it is not aggregated per flattened item. Count it in a sql fragment of this projection instead (sql`${<row>.visibleBooks.count()}`), '
        + 'which reads that row, or read it outside selectMany().',
      );
      // In the projection of a collection nested in that projection, a sql fragment does not reach the row either
      const nested = await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({
            title: b.title,
            reviews: b.reviews!.select(r => ({ stars: r.stars, visible: sql<number>`${s.visibleBooks!.count()}::int` })).toList(),
          })) as any) as any).toList(),
        })).toList(),
      );
      expect(nested.message).toBe(
        'The projection of "reviews" inside the projection of the items of "books" flattened by selectMany() reads "visibleBooks", '
        + 'a collection of a row the flattened items were flattened through: a collection nested there may read collections of its own items only. '
        + 'Read "visibleBooks" outside selectMany(), next to the flattened list.',
      );

      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // Each book with the number of visible books on its shelf
          books: (l.shelves!.selectMany(s => s.books!.orderBy(b => b.title).select(b => ({ title: b.title, visible: sql<number>`${s.visibleBooks!.count()}::int` })) as any) as any).toList(),
          // A count of the items does not read their projection at all
          count: l.shelves!.selectMany(s => s.books!.select(b => ({ title: b.title, visible: s.visibleBooks!.count() })) as any).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', books: [{ title: 'Alpha', visible: 1 }, { title: 'Beta', visible: 1 }, { title: 'Gamma', visible: 1 }], count: 3 },
        { name: 'Harbor', books: [{ title: 'Delta', visible: 1 }, { title: 'Eta', visible: 1 }], count: 2 },
        { name: 'Empty', books: [], count: 0 },
      ]);
    });

    test("a selector's projection reading a collection of a row outside the flattening is refused, however it reads it", async () => {
      const refused = await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({ title: b.title, crates: l.crates!.count() })) as any) as any).toList(),
        })).toList(),
      );
      expect(refused.message).toBe(
        'The projection of the items of "books" flattened by selectMany() reads "crates", a collection of a row outside the flattening: '
        + 'it may read collections of the flattened items only. Read "crates" outside selectMany(), next to the flattened list.',
      );
      // In a sql fragment, and in the projection of a collection the projection holds
      await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({ title: b.title, crates: sql<number>`${l.crates!.count()}::int` })) as any) as any).toList(),
        })).toList(),
        'reads "crates", a collection of a row outside the flattening',
      );
      await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({
            title: b.title,
            reviews: b.reviews!.select(r => ({ stars: r.stars, crates: l.crates!.count() })).toList(),
          })) as any) as any).toList(),
        })).toList(),
        'reads "crates", a collection of a row outside the flattening',
      );

      // A count of those items does not read their projection
      const rows = await libraries()
        .select(l => ({ name: l.name, count: l.shelves!.selectMany(s => s.books!.select(b => ({ title: b.title, crates: l.crates!.count() })) as any).count() }))
        .toList();
      expect(rows).toEqual([
        { name: 'Central', count: 3 },
        { name: 'Harbor', count: 2 },
        { name: 'Empty', count: 0 },
      ]);
    });

    test("a collection nested in a selector's projection reads collections of its own items only; one level up, the flattened item's", async () => {
      const refused = await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({
            title: b.title,
            reviews: b.reviews!.select(r => ({ stars: r.stars, all: b.reviews!.count() })).toList(),
          })) as any) as any).toList(),
        })).toList(),
      );
      expect(refused.message).toBe(
        'The projection of "reviews" inside the projection of the items of "books" flattened by selectMany() reads "reviews", '
        + 'a collection of the flattened items: a collection nested there may read collections of its own items only. '
        + 'Read "reviews" in the projection of the items of "books" itself.',
      );
      await expectToReject(
        async () => libraries().select(l => ({
          books: (l.shelves!.selectMany(s => s.books!.select(b => ({
            title: b.title,
            reviews: b.reviews!.select(r => ({ stars: r.stars, all: sql<number>`${b.reviews!.count()}::int` })).toList(),
          })) as any) as any).toList(),
        })).toList(),
        'reads "reviews", a collection of the flattened items',
      );

      const rows = await libraries()
        .select(l => ({
          name: l.name,
          books: (l.shelves!.selectMany(s => s.books!.orderBy(b => b.title).select(b => ({
            title: b.title,
            all: b.reviews!.count(),
            stars: b.reviews!.orderBy(r => r.id).select(r => r.stars).toNumberList(),
          })) as any) as any).toList(),
        }))
        .toList();
      expect(rows).toEqual([
        {
          name: 'Central',
          books: [{ title: 'Alpha', all: 2, stars: [5, 3] }, { title: 'Beta', all: 1, stars: [4] }, { title: 'Gamma', all: 2, stars: [2, 5] }],
        },
        { name: 'Harbor', books: [{ title: 'Delta', all: 1, stars: [1] }, { title: 'Eta', all: 0, stars: [] }] },
        { name: 'Empty', books: [] },
      ]);
    });

    test("min() / max() / sum() over a selector's projection aggregate the field they select", async () => {
      const projected = (l: any): any => l.shelves!.selectMany((s: any) => s.books!.select((b: any) => ({ p: b.pages })));
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          max: projected(l).max((x: any) => x.p),
          min: projected(l).min((x: any) => x.p),
          sum: projected(l).sum((x: any) => x.p),
          // The projection may read the row the items were flattened through
          shifted: (l.shelves!.selectMany(s => s.books!.select(b => ({ p: sql<number>`${b.pages} + ${s.floor}` })) as any) as any).sum((x: any) => x.p),
        }))
        .toList();

      // Pages plus shelf floor: Alpha 101, Beta 251, Gamma 302 · Delta 121, Eta 61
      expect(rows).toEqual([
        { name: 'Central', max: 300, min: 100, sum: 650, shifted: 654 },
        { name: 'Harbor', max: 120, min: 60, sum: 180, shifted: 182 },
        { name: 'Empty', max: null, min: null, sum: null, shifted: null },
      ]);
    });
  });

  describe(`navigations named like the table they point at — ${strategy}`, () => {
    test(`a nested exists() reading the inverse navigation of its collection, projected${strategy === 'lateral' ? '' : ' (unchanged)'}`, async () => {
      const rows = await db.ntShelves.withQueryOptions({ collectionStrategy: strategy }).orderBy(s => s.id)
        .select(x => ({ code: x.code, n: x.nt_library!.shelves!.where(y => exists(y.books!.where(k => eq(k.nt_shelf!.code, 'B')))).count() }))
        .toList();

      // `k.nt_shelf` is the shelf y of the library's shelves: North counts its shelf B
      expect(rows).toEqual([
        { code: 'A', n: 1 },
        { code: 'B', n: 1 },
        { code: 'C', n: 0 },
        { code: 'D', n: 0 },
      ]);
    });
  });

  describe(`the projection path: a collection of the OUTER row two subqueries deep — ${strategy}`, () => {
    test('a projected count() reading it under a subquery over that row\'s table: the 1.0.10 answer, pinned (unchanged)', async () => {
      const rows = await shelves()
        .select(x => ({ code: x.code, n: x.books!.where(b => exists(b.shelf!.library!.shelves!.where(y => exists(x.slots!)))).count() }))
        .toList();

      // PINNED, NOT RIGHT: shelf F has no slot, so its count is 0 by hand-written SQL (and in the sql-fragment
      // form, tested below) — a projected collection binds the OUTER row's nested collection to the nearest
      // row of that row's table, a defect of the projection path that predates this change (see the report)
      expect(rows).toEqual([
        { code: 'A', n: 2 },
        { code: 'B', n: 1 },
        { code: 'C', n: 1 },
        { code: 'D', n: 0 },
        { code: 'E', n: 0 },
        { code: 'F', n: 1 },
      ]);
    });
  });

  describe(`limit values, and the order a limit reads — ${strategy}`, () => {
    test('a limit that ranks takes a non-negative integer', async () => {
      await expectToReject(
        async () => libraries().select(l => ({ n: l.shelves!.orderBy(s => s.code).limit(-1).selectMany(s => s.books!).count() })).toList(),
        'LIMIT must not be negative',
      );
      await expectToReject(
        async () => libraries().select(l => ({ n: l.shelves!.orderBy(s => s.code).offset(-1).selectMany(s => s.books!).count() })).toList(),
        'OFFSET must not be negative',
      );
      await expectToReject(
        async () => libraries().select(l => ({ n: l.shelves!.orderBy(s => s.code).limit(1.5).selectMany(s => s.books!).count() })).toList(),
        'LIMIT must be an integer',
      );
      await expectToReject(
        async () => libraries().select(l => ({ n: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).limit(-1)).count() })).toList(),
        'LIMIT must not be negative',
      );
      await expectToReject(
        async () => libraries().select(l => ({ n: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).offset(0.5)).count() })).toList(),
        'OFFSET must be an integer',
      );
    });

    test('limit(0) keeps no row, offset(0) every row', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          none: l.shelves!.orderBy(s => s.code).limit(0).selectMany(s => s.books!).count(),
          noneInside: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).limit(0)).count(),
          all: l.shelves!.orderBy(s => s.code).offset(0).selectMany(s => s.books!).count(),
          allInside: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).offset(0)).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', none: 0, noneInside: 0, all: 3, allInside: 3 },
        { name: 'Harbor', none: 0, noneInside: 0, all: 2, allInside: 2 },
        { name: 'Empty', none: 0, noneInside: 0, all: 0, allInside: 0 },
      ]);
    });

    test('a sum() over orderBy(<navigation>).limit(): the order picks the rows it sums (unchanged)', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, floor: l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).sum(s => s.floor) }))
        .toList();

      // The last shelf by curator name: B (Max, floor 2); Harbor's F has no curator and sorts first descending (floor 1)
      expect(rows).toEqual([
        { name: 'Central', floor: 2 },
        { name: 'Harbor', floor: 1 },
        { name: 'Empty', floor: null },
      ]);
    });

    test('a sum() over a flattening ranked by orderBy(<navigation>).limit()', async () => {
      const rows = await libraries()
        .select(l => ({ name: l.name, pages: l.shelves!.orderBy(s => [[s.curator!.name, 'DESC']]).limit(1).selectMany(s => s.books!).sum(b => b.pages) }))
        .toList();

      // The books of B (Gamma) and of F (Eta)
      expect(rows).toEqual([
        { name: 'Central', pages: 300 },
        { name: 'Harbor', pages: 60 },
        { name: 'Empty', pages: null },
      ]);
    });
  });

  describe(`aggregates of 0 — ${strategy}`, () => {
    test(`min() / max() / sum() of 0 read back as 0${strategy === 'temptable' ? '' : ' (unchanged)'}`, async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          min: l.shelves!.min(s => sql<number>`${s.floor} - 1`),
          max: l.shelves!.where(s => eq(s.floor, 1)).max(s => sql<number>`${s.floor} - 1`),
          sum: l.shelves!.where(s => eq(s.floor, 1)).sum(s => sql<number>`${s.floor} - 1`),
        }))
        .toList();

      // Floors less one: 0 on the first floor; Empty has no shelf at all
      expect(rows).toEqual([
        { name: 'Central', min: 0, max: 0, sum: 0 },
        { name: 'Harbor', min: 0, max: 0, sum: 0 },
        { name: 'Empty', min: null, max: null, sum: null },
      ]);
    });

    test("min() over a selector's projection whose least value is 0", async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          min: (l.shelves!.selectMany(s => s.books!.select(b => ({ t: sql<number>`${b.pages} - ${b.pages}` })) as any) as any).min((x: any) => x.t),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', min: 0 },
        { name: 'Harbor', min: 0 },
        { name: 'Empty', min: null },
      ]);
    });
  });

  describe(`rankings over other keys and tables — ${strategy}`, () => {
    test('a composite primary key of mixed-case columns ranks a limited hop and a limited selector collection', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The library's last slot by label, then its tags
          tags: l.shelves!.selectMany(s => s.slots!).orderBy(x => [[x.label, 'DESC']]).limit(1).selectMany(x => x.tags!).orderBy(t => t.tag).select(t => t.tag).toStringList(),
          // Each shelf's last slot by label
          labels: l.shelves!.selectMany(s => s.slots!.orderBy(x => [[x.label, 'DESC']]).limit(1)).orderBy(x => x.label).select(x => x.label).toStringList(),
          // Each slot's first tag: ranked within a row of a composite key
          firstTags: l.shelves!.selectMany(s => s.slots!).selectMany(x => x.tags!.orderBy(t => t.tag).limit(1)).orderBy(t => t.tag).select(t => t.tag).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', tags: ['blue', 'red'], labels: ['low', 'top'], firstTags: ['blue', 'green', 'red'] },
        { name: 'Harbor', tags: ['blue'], labels: ['y'], firstTags: ['blue'] },
        { name: 'Empty', tags: [], labels: [], firstTags: [] },
      ]);
    });

    test('a limited hop of another schema, and a limit on its selector collection', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The parcels of the library's last crate by label
          last: l.crates!.orderBy(c => [[c.label, 'DESC']]).limit(1).selectMany(c => c.parcels!).orderBy(p => p.weight).select(p => p.weight).toNumberList(),
          // The heaviest parcel of each crate
          heaviest: l.crates!.selectMany(c => c.parcels!.orderBy(p => [[p.weight, 'DESC']]).limit(1)).orderBy(p => p.weight).select(p => p.weight).toNumberList(),
        }))
        .toList();

      // Central: south (30) after north (10, 20); Harbor: east (5)
      expect(rows).toEqual([
        { name: 'Central', last: [30], heaviest: [20, 30] },
        { name: 'Harbor', last: [5], heaviest: [5] },
        { name: 'Empty', last: [], heaviest: [] },
      ]);
    });

    test('the constant key part of a relation holds inside the ranking', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The last OPEN shelf by code (`openShelves` keeps `archived = false`), then its books
          lastOpen: l.openShelves!.orderBy(s => [[s.code, 'DESC']]).limit(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
          // Each shelf's longest VISIBLE book (`visibleBooks` keeps `visible = true`)
          longestVisible: l.shelves!.selectMany(s => s.visibleBooks!.orderBy(b => [[b.pages, 'DESC']]).limit(1)).orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      // Ranked without the constant part, Central's archived B and A's hidden Beta would come first and be dropped
      expect(rows).toEqual([
        { name: 'Central', lastOpen: ['Alpha', 'Beta'], longestVisible: ['Alpha', 'Gamma'] },
        { name: 'Harbor', lastOpen: [], longestVisible: ['Delta', 'Eta'] },
        { name: 'Empty', lastOpen: [], longestVisible: [] },
      ]);
    });

    test('a limited hop filter and a limited selector filter reading the OUTER row', async () => {
      const rows = await libraries()
        .select(l => ({
          name: l.name,
          // The last shelf by code at or below the main floor, then its books
          hop: l.shelves!.where(s => sql<boolean>`${s.floor} <= ${l.mainFloor}`).orderBy(s => [[s.code, 'DESC']]).limit(1).selectMany(s => s.books!)
            .select(b => b.title).toStringList(),
          // The shortest book of each shelf with more pages than a hundred per main floor
          item: l.shelves!.selectMany(s => s.books!.where(b => sql<boolean>`${b.pages} > ${l.mainFloor} * 100`).orderBy(b => b.pages).limit(1))
            .orderBy(b => b.title).select(b => b.title).toStringList(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Central', hop: ['Gamma'], item: ['Beta', 'Gamma'] },
        { name: 'Harbor', hop: ['Eta'], item: ['Delta'] },
        { name: 'Empty', hop: [], item: [] },
      ]);
    });
  });

  describe(`the SQL — ${strategy}`, () => {
    test('no collection marker reaches the database', async () => {
      takeStatements();

      await libraries().select(l => ({
        kept: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count(),
        list: l.shelves!.where(s => eq(s.curator!.name, 'Ivy')).selectMany(s => s.books!).orderBy(b => b.title).limit(3).select(b => ({ t: b.title, c: b.curator!.name })).toList(),
        chained: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).where(b => gt(b.pages, 90)).selectMany(b => b.reviews!).select(r => r.stars).toNumberList(),
      })).toList();
      await topics().select(t => ({ names: t.children!.where(c => ne(c.name, 'arts')).selectMany(c => c.children!).select(g => g.name).toStringList() })).toList();

      const statements = takeStatements();
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter(statement => statement.includes('"__collection_'))).toEqual([]);
    });

    test('the filtered hop renders once, under an alias of its own the filter and the correlation read', async () => {
      takeStatements();
      await libraries().select(l => ({ n: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count() })).toList();

      const statement = takeStatements().find(entry => entry.includes('"shelves__bridge1"'));
      expect(statement).toBeDefined();
      expect(statement).toContain('"shelves__bridge1"."archived"');
      expect(statement).toContain('"shelves__bridge1"."library_id"');
      expect(occurrences(statement!, '"smw_shelves"')).toBe(1);
    });

    test('a navigation of the hop named like one of the flattened item is joined apart, from the hop', async () => {
      takeStatements();
      await libraries().select(l => ({
        books: l.shelves!.where(s => eq(s.curator!.name, 'Ivy')).selectMany(s => s.books!).select(b => ({ t: b.title, c: b.curator!.name })).toList(),
      })).toList();

      const statement = takeStatements().find(entry => entry.includes('"shelves__bridge1"'));
      expect(statement).toBeDefined();
      expect(statement).toContain('"shelves__bridge1__curator"."name"');
      expect(statement).toContain('"shelves__bridge1"."curator_id" = "shelves__bridge1__curator"."id"');
      // The flattened item's own navigation keeps its name, and the hop is not joined again through it
      expect(statement).toContain('"curator"."name"');
      expect(occurrences(statement!, '"smw_shelves"')).toBe(1);
    });

    test('no collection marker reaches the database — limits, selector collections, navigations', async () => {
      takeStatements();

      await libraries().select(l => ({
        limited: l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
        inner: l.shelves!.selectMany(s => s.books!.where(b => eq(b.curatorId, s.curatorId)).orderBy(b => b.pages).limit(1)).count(),
        composed: l.shelves!.selectMany(s => s.books!.selectMany(b => b.reviews!).where(r => gt(r.stars, 2))).select(r => r.stars).toNumberList(),
        navigated: l.shelves!.orderBy(s => s.code).selectMany(s => s.curator!.shelves!).select(x => x.code).toStringList(),
      })).toList();

      const statements = takeStatements();
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter(statement => statement.includes('"__collection_'))).toEqual([]);
    });

    test('a limit before selectMany() ranks the rows within each parent', async () => {
      takeStatements();
      await libraries().select(l => ({ n: l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).count() })).toList();

      const statement = takeStatements().find(entry => entry.includes('"shelves__bridge1"'));
      expect(statement).toBeDefined();
      expect(statement).not.toContain('"__collection_');
      if (strategy === 'lateral') {
        // Per parent row: the parent's first shelves, read through the foreign-key index — never a
        // ranking of the whole table for every parent
        expect(statement).toContain('"shelves__bridge1"."id" IN (SELECT "shelves__bridge1"."id"\nFROM "smw_shelves" "shelves__bridge1"\n'
          + 'WHERE "shelves__bridge1"."library_id" = "smw_libraries"."id"\nORDER BY "shelves__bridge1"."code" ASC, "shelves__bridge1"."id" ASC\nLIMIT 1)');
        expect(statement).not.toContain('ROW_NUMBER()');
      } else {
        // One ranking for every parent at once: the aggregation is set-based
        expect(statement).toContain('ROW_NUMBER() OVER (PARTITION BY "shelves__bridge1"."library_id" ORDER BY "shelves__bridge1"."code" ASC, "shelves__bridge1"."id" ASC)');
      }
    });

    test('a limit on the collection the selector returns ranks the items within each flattened row', async () => {
      takeStatements();
      await libraries().select(l => ({ n: l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).limit(1)).count() })).toList();

      const statement = takeStatements().find(entry => entry.includes('"shelves__bridge1"'));
      expect(statement).toBeDefined();
      if (strategy === 'lateral') {
        // Tied to the shelf it ranks within
        expect(statement).toMatch(
          /"(lateral_\d+_shelves)"\."id" IN \(SELECT "\1"\."id"\nFROM "smw_books" "\1"\nWHERE "\1"\."shelf_id" = "shelves__bridge1"\."id"\nORDER BY "\1"\."pages" ASC, "\1"\."id" ASC\nLIMIT 1\)/,
        );
        expect(statement).not.toContain('ROW_NUMBER()');
      } else {
        expect(statement).toContain('ROW_NUMBER() OVER (PARTITION BY "smw_books"."shelf_id" ORDER BY "smw_books"."pages" ASC, "smw_books"."id" ASC)');
      }
    });
  });
}

describe('in a WHERE or a sql fragment — the correlated subquery', () => {
  const names = (rows: Array<{ name: string }>): string[] => rows.map(row => row.name);

  test('exists() in a WHERE', async () => {
    const rows = await db.libraries
      .where(l => exists(l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!)))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();

    expect(names(rows)).toEqual(['Central', 'Harbor']);
  });

  test('notExists() in a WHERE', async () => {
    const rows = await db.libraries
      .where(l => notExists(l.shelves!.where(s => gt(s.floor, 1)).selectMany(s => s.books!)))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();

    expect(names(rows)).toEqual(['Harbor', 'Empty']);
  });

  test('count() in a sql fragment, projected and in a WHERE', async () => {
    const counted = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, count: sql<number>`${l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count()}::int` }))
      .toList();
    const filtered = await db.libraries
      .where(l => sql`(${l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count()}) > 1`)
      .select(l => ({ name: l.name }))
      .toList();

    expect(counted).toEqual([
      { name: 'Central', count: 2 },
      { name: 'Harbor', count: 1 },
      { name: 'Empty', count: 0 },
    ]);
    expect(names(filtered)).toEqual(['Central']);
  });

  test('a chained flattening filtered at every level', async () => {
    const rows = await db.libraries
      .where(l => exists(l.shelves!
        .where(s => eq(s.archived, false))
        .selectMany(s => s.books!)
        .where(b => gt(b.pages, 110))
        .selectMany(b => b.reviews!)
        .where(r => gt(r.stars, 3))))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();

    // Central: Beta's review (4 stars). Harbor: Delta's single review has 1 star
    expect(names(rows)).toEqual(['Central']);
  });

  test('a self-referencing flattening', async () => {
    const rows = await db.topics
      .where(t => exists(t.children!.where(c => ne(c.name, 'arts')).selectMany(c => c.children!)))
      .orderBy(t => t.name)
      .select(t => ({ name: t.name }))
      .toList();

    // root through science (physics), arts through music (jazz, opera)
    expect(names(rows)).toEqual(['arts', 'root']);
  });

  test('a hop filter reading the outer row', async () => {
    const rows = await db.libraries
      .where(l => exists(l.shelves!.where(s => eq(s.floor, l.mainFloor)).selectMany(s => s.books!).where(b => gt(b.pages, 200))))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();

    expect(names(rows)).toEqual(['Central']);
  });

  test("the constant part of a hop's relation joins the hop in a correlated subquery", async () => {
    // No filter anywhere: only the relation's second key pair keeps Beta (hidden) out
    const rows = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, visible: sql<number>`${l.shelves!.selectMany(s => s.visibleBooks!).count()}::int` }))
      .toList();

    expect(rows).toEqual([
      { name: 'Central', visible: 2 },
      { name: 'Harbor', visible: 2 },
      { name: 'Empty', visible: 0 },
    ]);
  });

  test('relations with a constant key part', async () => {
    const rows = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({
        name: l.name,
        visible: sql<number>`${l.shelves!.selectMany(s => s.visibleBooks!).count()}::int`,
        open: sql<number>`${l.openShelves!.where(s => eq(s.floor, 1)).selectMany(s => s.books!).count()}::int`,
      }))
      .toList();

    expect(rows).toEqual([
      { name: 'Central', visible: 2, open: 2 },
      { name: 'Harbor', visible: 2, open: 1 },
      { name: 'Empty', visible: 0, open: 0 },
    ]);
  });

  test('the SQL: the hop renders under an alias of its own, and no marker is left', async () => {
    takeStatements();
    await db.libraries
      .where(l => exists(l.shelves!.where(s => eq(s.curator!.name, 'Max')).selectMany(s => s.books!)))
      .select(l => ({ name: l.name }))
      .toList();

    const statement = takeStatements().find(entry => entry.includes('EXISTS'));
    expect(statement).toBeDefined();
    expect(statement).not.toContain('"__collection_');
    expect(statement).toContain('"shelves__bridge1"."library_id" = "smw_libraries"."id"');
    expect(statement).toContain('"shelves__bridge1"."curator_id"');
    expect(occurrences(statement!, '"smw_shelves"')).toBe(1);
  });
});

describe('refused shapes of selectMany()', () => {
  test('after selectDistinct() or a terminal, and after a select() whose projection holds no collection', async () => {
    await expectToReject(
      async () => db.libraries.select(l => ({ n: (l.shelves!.selectDistinct(s => s.code) as any).selectMany((s: any) => s.books).count() })).toList(),
      'follows selectDistinct()',
    );
    await expectToReject(
      async () => db.libraries.select(l => ({ n: (l.shelves!.count() as any).selectMany((s: any) => s.books).count() })).toList(),
      'count()',
    );
    // The selector is handed the projection: a field it does not hold is no collection
    await expectToReject(
      async () => db.libraries.select(l => ({ n: (l.shelves!.select(s => ({ code: s.code })) as any).selectMany((s: any) => s.books).count() })).toList(),
      'of the projection select() made of the item',
    );
  });

  test('a selector that does not return a collection of its item', async () => {
    // A reference navigation, a terminal, a distinct projection (distinct per flattened row)
    await expectToReject(async () => db.libraries.select(l => ({ n: l.shelves!.selectMany(s => s.curator as any).count() })).toList(), 'collection');
    await expectToReject(async () => db.libraries.select(l => ({ n: l.shelves!.selectMany(s => s.books!.count() as any).count() })).toList(), 'count()');
    await expectToReject(
      async () => db.libraries.select(l => ({ n: l.shelves!.selectMany(s => s.books!.selectDistinct(b => b.genreId) as any).count() })).toList(),
      'selectDistinct()',
    );
    // A collection of the OUTER row, and of an enclosing row of the same table
    await expectToReject(async () => db.libraries.select(l => ({ n: l.shelves!.selectMany(() => l.crates! as any).count() })).toList(), 'another row');
    await expectToReject(async () => db.topics.select(t => ({ n: t.children!.selectMany(() => t.children!).count() })).toList(), 'another row');
  });
});

describe('the correlated subquery: its own limit, and collections over the same table in its filter', () => {
  const names = (rows: Array<{ name: string }>): string[] => rows.map(row => row.name);

  test("a count() in a sql fragment whose filter holds an exists() over the item's collection", async () => {
    const rows = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, withBooks: sql<number>`${l.shelves!.where(s => exists(s.books!)).count()}::int` }))
      .toList();

    expect(rows).toEqual([
      { name: 'Central', withBooks: 2 },
      { name: 'Harbor', withBooks: 2 },
      { name: 'Empty', withBooks: 0 },
    ]);
  });

  test('a self-referencing table: exists() and count() over the children of each child', async () => {
    const withGrandchildren = await db.topics
      .where(t => exists(t.children!.where(c => exists(c.children!))))
      .orderBy(t => t.name)
      .select(t => ({ name: t.name }))
      .toList();
    const counts = await db.topics
      .orderBy(t => t.id)
      .select(t => ({
        name: t.name,
        withChildren: sql<number>`${t.children!.where(c => exists(c.children!)).count()}::int`,
        withSeveral: sql<number>`${t.children!.where(c => sql<boolean>`${c.children!.count()} > 1`).count()}::int`,
      }))
      .toList();

    expect(names(withGrandchildren)).toEqual(['arts', 'root']);
    expect(counts).toEqual(TOPIC_NAMES.map(name => ({
      name,
      withChildren: name === 'root' ? 2 : name === 'arts' ? 1 : 0,
      withSeveral: name === 'root' || name === 'arts' ? 1 : 0,
    })));
  });

  test('a flattening limited per row, filtered after the limit, in a WHERE and a sql fragment', async () => {
    const rows = await db.libraries
      .where(l => exists(l.shelves!.selectMany(s => s.books!.orderBy(b => [[b.pages, 'DESC']]).limit(1)).where(b => lt(b.pages, 200))))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();
    const counts = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, n: sql<number>`${l.shelves!.selectMany(s => s.books!.orderBy(b => [[b.pages, 'DESC']]).limit(1)).where(b => lt(b.pages, 200)).count()}::int` }))
      .toList();

    // The longest book of each shelf, if it has under 200 pages: Delta and Eta (Harbor)
    expect(names(rows)).toEqual(['Harbor']);
    expect(counts).toEqual([
      { name: 'Central', n: 0 },
      { name: 'Harbor', n: 2 },
      { name: 'Empty', n: 0 },
    ]);
  });

  test('its own orderBy() / limit() / offset()', async () => {
    const counts = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({
        name: l.name,
        first: sql<number>`${l.shelves!.orderBy(s => s.code).limit(1).count()}::int`,
        pastTwo: sql<number>`${l.shelves!.orderBy(s => s.code).offset(2).count()}::int`,
        flattened: sql<number>`${l.shelves!.selectMany(s => s.books!).orderBy(b => b.pages).limit(2).count()}::int`,
        firstShelf: sql<number>`${l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).count()}::int`,
      }))
      .toList();
    const secondOpen = await db.libraries
      .where(l => exists(l.shelves!.where(s => eq(s.archived, false)).orderBy(s => s.code).offset(1)))
      .select(l => ({ name: l.name }))
      .toList();

    expect(counts).toEqual([
      { name: 'Central', first: 1, pastTwo: 0, flattened: 2, firstShelf: 2 },
      { name: 'Harbor', first: 1, pastTwo: 1, flattened: 2, firstShelf: 1 },
      { name: 'Empty', first: 0, pastTwo: 0, flattened: 0, firstShelf: 0 },
    ]);
    expect(names(secondOpen)).toEqual(['Harbor']);
  });
});

describe('the correlated subquery: the row a nested collection correlates to', () => {
  const names = (rows: Array<{ name: string }>): string[] => rows.map(row => row.name);

  test('a count() of the OUTER row in the filter of a count() over the same relation (unchanged)', async () => {
    const rows = await db.topics
      .orderBy(t => t.id)
      .select(t => ({ name: t.name, n: sql<number>`${t.children!.where(c => sql<boolean>`${t.children!.count()} > 1`).count()}::int` }))
      .toList();

    // Every child of a node that has more than one child
    expect(rows).toEqual(TOPIC_NAMES.map(name => ({ name, n: name === 'root' || name === 'arts' || name === 'music' ? 2 : 0 })));
  });

  test('an exists() of the OUTER row nested in an exists() over the same relation (unchanged)', async () => {
    const rows = await db.topics
      .where(t => exists(t.children!.where(c => exists(t.children!.where(k => eq(k.name, 'physics'))))))
      .orderBy(t => t.name)
      .select(t => ({ name: t.name }))
      .toList();

    expect(names(rows)).toEqual(['science']);
  });

  test('an exists() of the OUTER row in the filter of a count() reached through a navigation (unchanged)', async () => {
    const rows = await db.shelves
      .orderBy(s => s.id)
      .select(x => ({ code: x.code, n: sql<number>`${x.library!.shelves!.where(y => exists(x.books!)).count()}::int` }))
      .toList();

    // A shelf holding a book counts every shelf of its library
    expect(rows).toEqual([
      { code: 'A', n: 2 },
      { code: 'B', n: 2 },
      { code: 'C', n: 3 },
      { code: 'D', n: 0 },
      { code: 'E', n: 0 },
      { code: 'F', n: 3 },
    ]);
  });

  test("the item's collection and the OUTER row's collection side by side in one filter", async () => {
    const rows = await db.topics
      .orderBy(t => t.id)
      .select(t => ({ name: t.name, n: sql<number>`${t.children!.where(c => and(exists(c.children!), sql<boolean>`${t.children!.count()} > 1`)).count()}::int` }))
      .toList();

    // The children with children, of a node with more than one child: root (arts, science), arts (music)
    expect(rows).toEqual(TOPIC_NAMES.map(name => ({ name, n: name === 'root' ? 2 : name === 'arts' ? 1 : 0 })));
  });

  test("a collection of the hop's item in the filter of the selector's collection correlates to that hop", async () => {
    const rows = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, n: sql<number>`${l.shelves!.selectMany(s => s.books!.where(b => exists(s.visibleBooks!.where(v => ne(v.id, b.id))))).count()}::int` }))
      .toList();

    expect(rows).toEqual([
      { name: 'Central', n: 1 },
      { name: 'Harbor', n: 0 },
      { name: 'Empty', n: 0 },
    ]);
  });

  test("a flattening in the filter of the selector's collection, through the same relations, keeps a hop alias of its own", async () => {
    const counts = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({
        name: l.name,
        n: sql<number>`${l.shelves!.selectMany(s => s.books!.where(b => exists(b.shelf!.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!)))).count()}::int`,
      }))
      .toList();
    const rows = await db.libraries
      .where(l => exists(l.shelves!.selectMany(s => s.books!.where(b => exists(b.shelf!.library!.shelves!.where(x => ne(x.id, s.id)).selectMany(x => x.books!.where(y => gt(y.pages, 200))))))))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();

    expect(counts).toEqual([
      { name: 'Central', n: 3 },
      { name: 'Harbor', n: 2 },
      { name: 'Empty', n: 0 },
    ]);
    // Only Central holds a book over 200 pages on another shelf of a book's library
    expect(names(rows)).toEqual(['Central']);
  });

  test("a navigation's collection flattened after a filter read the same navigation's collection", async () => {
    const rows = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, n: sql<number>`${l.shelves!.selectMany(s => s.books!.where(b => exists(b.curator!.shelves!))).selectMany(b => b.curator!.shelves!).count()}::int` }))
      .toList();

    expect(rows).toEqual([
      { name: 'Central', n: 4 },
      { name: 'Harbor', n: 2 },
      { name: 'Empty', n: 0 },
    ]);
  });

  test('a collection of the OUTER row two subqueries deep, under a subquery over its table (unchanged)', async () => {
    takeStatements();
    const rows = await db.shelves
      .orderBy(s => s.id)
      .select(x => ({ code: x.code, n: sql<number>`${x.library!.shelves!.where(y => exists(y.library!.shelves!.where(z => exists(x.books!)))).count()}::int` }))
      .toList();

    // A shelf holding a book counts every shelf of its library; shelf E holds none
    expect(rows).toEqual([
      { code: 'A', n: 2 },
      { code: 'B', n: 2 },
      { code: 'C', n: 3 },
      { code: 'D', n: 0 },
      { code: 'E', n: 0 },
      { code: 'F', n: 3 },
    ]);
    // The subquery over the shelves nested in the count renders under an alias of its own: under the bare
    // name it shadowed the OUTER shelf, which `x.books` correlates to by that name
    const statement = takeStatements().find(entry => entry.includes('"shelves__count"'));
    expect(statement).toBeDefined();
    expect(statement).toContain('EXISTS (SELECT 1 FROM "smw_shelves" "shelves__exists"');
    expect(statement).toContain('WHERE "smw_books"."shelf_id" = "smw_shelves"."id"');
    expect(occurrences(statement!, 'FROM "smw_shelves"\n')).toBe(1);
  });

  test('an exists() of the OUTER row three levels deep over one self-referencing table (unchanged)', async () => {
    const rows = await db.topics
      .where(t => exists(t.children!.where(x => exists(x.children!.where(y => exists(t.children!.where(z => eq(z.name, 'science'))))))))
      .orderBy(t => t.id)
      .select(t => ({ name: t.name }))
      .toList();
    const counts = await db.topics
      .orderBy(t => t.id)
      .select(t => ({ name: t.name, n: sql<number>`${t.children!.where(x => exists(x.children!.where(y => exists(t.children!.where(z => eq(z.name, 'science')))))).count()}::int` }))
      .toList();

    // The nodes with a grandchild and a child named science: root (both of its children have children)
    expect(names(rows)).toEqual(['root']);
    expect(counts).toEqual(TOPIC_NAMES.map(name => ({ name, n: name === 'root' ? 2 : 0 })));
  });

  test('a collection of the OUTER row under a subquery over its table, reached through a navigation', async () => {
    const rows = await db.shelves
      .orderBy(s => s.id)
      .select(x => ({ code: x.code, n: sql<number>`${x.books!.where(b => exists(b.shelf!.library!.shelves!.where(y => exists(x.slots!)))).count()}::int` }))
      .toList();

    // The books of each shelf that has a slot (A, B, C) and a library; shelf F has no slot
    expect(rows).toEqual([
      { code: 'A', n: 2 },
      { code: 'B', n: 1 },
      { code: 'C', n: 1 },
      { code: 'D', n: 0 },
      { code: 'E', n: 0 },
      { code: 'F', n: 0 },
    ]);
  });

  test('nested collections over other tables keep their SQL (unchanged)', async () => {
    takeStatements();
    const rows = await db.libraries
      .where(l => exists(l.shelves!.where(s => exists(s.books!.where(b => exists(b.reviews!))))))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();
    const statement = takeStatements().find(entry => entry.includes('EXISTS'));

    expect(names(rows)).toEqual(['Central', 'Harbor']);
    expect(statement).toBe(
      'SELECT "smw_libraries"."name" as "name"\nFROM "smw_libraries"\nWHERE EXISTS (SELECT 1 FROM "smw_shelves"\n'
      + 'WHERE "smw_shelves"."library_id" = "smw_libraries"."id" AND EXISTS (SELECT 1 FROM "smw_books"\n'
      + 'WHERE "smw_books"."shelf_id" = "smw_shelves"."id" AND EXISTS (SELECT 1 FROM "smw_reviews"\n'
      + 'WHERE "smw_reviews"."book_id" = "smw_books"."id")))\nORDER BY "smw_libraries"."id" ASC',
    );
  });

  test('a collection of the OUTER row two subqueries deep, under subqueries over other tables', async () => {
    takeStatements();
    const counts = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({ name: l.name, n: sql<number>`${l.shelves!.where(s => exists(s.books!.where(b => exists(l.crates!)))).count()}::int` }))
      .toList();

    // Central and Harbor each have a crate: their shelves holding a book
    expect(counts).toEqual([
      { name: 'Central', n: 2 },
      { name: 'Harbor', n: 2 },
      { name: 'Empty', n: 0 },
    ]);
    // Neither table is the OUTER row's: the books keep their bare name
    const statement = takeStatements().find(entry => entry.includes('"shelves__count"'));
    expect(statement).toContain('EXISTS (SELECT 1 FROM "smw_books"\nWHERE "smw_books"."shelf_id" = "shelves__count"."id"');
    expect(statement).toContain('"smw_crates"."library_id" = "smw_libraries"."id"');
  });
});

describe("the correlated subquery: a limit's order, and the rows a ranking reads", () => {
  const titles = (rows: Array<{ title: string }>): string[] => rows.map(row => row.title);

  test("an exists() with a limit ordered by the OUTER row's navigation (unchanged)", async () => {
    const rows = await db.books
      .where(b => exists(b.shelf!.library!.shelves!.orderBy(x => sql`${x.code} = ${b.curator!.name}`).limit(1)))
      .orderBy(b => b.id)
      .select(b => ({ title: b.title }))
      .toList();

    // Every book on a shelf of a library: not Epsilon (shelf D, no library), not Zeta (no shelf)
    expect(titles(rows)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta']);
  });

  test("the same limit before selectMany(): the ranking reads the OUTER row's navigation", async () => {
    const rows = await db.books
      .where(b => exists(b.shelf!.library!.shelves!.orderBy(x => sql`${x.code} = ${b.curator!.name}`).limit(1).selectMany(x => x.books!)))
      .orderBy(b => b.id)
      .select(b => ({ title: b.title }))
      .toList();

    // No shelf code is a curator's name: the first shelf by id, A (Central) and C (Harbor), both hold a book
    expect(titles(rows)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta']);
  });

  test("a count of a ranking ordered by the OUTER row's navigation, projected and in a WHERE", async () => {
    const counted = await db.books
      .orderBy(b => b.id)
      .select(b => ({
        title: b.title,
        n: sql<number>`${b.shelf!.library!.shelves!.orderBy(x => [[sql`${x.curator!.name} = ${b.curator!.name}`, 'DESC']]).limit(1).selectMany(x => x.books!).count()}::int`,
      }))
      .toList();
    const filtered = await db.books
      .where(b => sql<boolean>`${b.shelf!.library!.shelves!.orderBy(x => [[sql`${x.curator!.name} = ${b.curator!.name}`, 'DESC']]).limit(1).selectMany(x => x.books!).count()} = 1`)
      .orderBy(b => b.id)
      .select(b => ({ title: b.title }))
      .toList();

    // The first shelf of each book's library, its own curator's first — descending, a shelf without a
    // curator (NULL) comes before them all: Alpha (Max) reads B, Beta (Ivy) A, Delta (Max) F, Eta (none) C
    expect(counted).toEqual([
      { title: 'Alpha', n: 1 },
      { title: 'Beta', n: 2 },
      { title: 'Gamma', n: 2 },
      { title: 'Delta', n: 1 },
      { title: 'Epsilon', n: 0 },
      { title: 'Zeta', n: 0 },
      { title: 'Eta', n: 1 },
    ]);
    expect(titles(filtered)).toEqual(['Alpha', 'Delta', 'Eta']);
  });

  test("an exists() over a ranking ordered by the OUTER row's navigation, in a WHERE", async () => {
    const rows = await db.books
      .where(b => exists(b.shelf!.library!.shelves!.orderBy(x => [[sql`${x.curator!.name} = ${b.curator!.name}`, 'DESC']]).limit(1)
        .selectMany(x => x.books!.where(y => eq(y.curatorId, b.curatorId)))))
      .orderBy(b => b.id)
      .select(b => ({ title: b.title }))
      .toList();

    // The shelf each book reads (see above) holds a book of the same curator for Beta alone: Alpha reads B
    // (Gamma, no curator), Delta reads F (Eta, no curator). Any shelf would have kept Alpha and Delta too
    expect(titles(rows)).toEqual(['Beta']);
  });

  test('a ranking with a negative limit fails with the text a LIMIT gets from the database', async () => {
    const lateral = () => db.libraries.withQueryOptions({ collectionStrategy: 'lateral' }).orderBy(l => l.id);

    await expectToReject(async () => lateral().select(l => ({ codes: l.shelves!.orderBy(s => s.code).limit(-1).select(s => s.code).toStringList() })).toList(), 'LIMIT must not be negative');
    await expectToReject(async () => lateral().select(l => ({ n: l.shelves!.orderBy(s => s.code).limit(-1).selectMany(s => s.books!).count() })).toList(), 'LIMIT must not be negative');
    await expectToReject(
      async () => db.libraries.where(l => exists(l.shelves!.orderBy(s => s.code).limit(-1).selectMany(s => s.books!))).select(l => ({ name: l.name })).toList(),
      'LIMIT must not be negative',
    );
  });

  test('the SQL: a count() or an exists() with its own limit renders LIMIT / OFFSET without ORDER BY', async () => {
    takeStatements();
    await db.libraries.orderBy(l => l.id).select(l => ({ n: sql<number>`${l.shelves!.orderBy(s => s.code).limit(1).count()}::int` })).toList();
    await db.libraries.where(l => exists(l.shelves!.orderBy(s => s.curator!.name).offset(1))).select(l => ({ name: l.name })).toList();

    const statements = takeStatements();
    const count = statements.find(statement => statement.includes('"shelves__count__rows"'));
    const offset = statements.find(statement => statement.includes('OFFSET 1'));
    expect(count).toBeDefined();
    expect(offset).toBeDefined();
    // The order cannot change how many rows a limit keeps, nor whether one is past the offset
    expect(count).toContain('WHERE "shelves__count"."library_id" = "smw_libraries"."id"\nLIMIT 1) "shelves__count__rows"');
    expect(count).not.toContain('ORDER BY "shelves__count"');
    expect(offset).not.toContain('ORDER BY "curator"');
    expect(offset).not.toContain('"curator"');
  });

  test('the SQL: the ranking of a correlated subquery is tied to the row it ranks within', async () => {
    takeStatements();
    await db.libraries.orderBy(l => l.id).select(l => ({ n: sql<number>`${l.shelves!.orderBy(s => s.code).limit(1).selectMany(s => s.books!).count()}::int` })).toList();
    await db.libraries.where(l => exists(l.shelves!.selectMany(s => s.books!.orderBy(b => b.pages).limit(1)))).select(l => ({ name: l.name })).toList();
    await db.libraries.orderBy(l => l.id).select(l => ({ n: sql<number>`${l.shelves!.selectMany(s => s.slots!.orderBy(x => x.label).limit(1)).count()}::int` })).toList();

    const statements = takeStatements();
    const perParent = statements.find(statement => statement.includes('"smw_books"') && statement.includes('COUNT(*)'));
    const perRow = statements.find(statement => statement.includes('EXISTS (SELECT 1 FROM "smw_books"'));
    const composite = statements.find(statement => statement.includes('"SmwSlots"'));
    expect(perParent).toBeDefined();
    expect(perRow).toBeDefined();
    expect(composite).toBeDefined();
    // The parent's first shelves, then each shelf's shortest book, then each shelf's first slot (a
    // composite key): read per row, never a ranking of the whole table
    expect(perParent).toContain('"shelves__bridge1"."id" IN (SELECT "shelves__bridge1"."id"\nFROM "smw_shelves" "shelves__bridge1"\n'
      + 'WHERE "shelves__bridge1"."library_id" = "smw_libraries"."id"\nORDER BY "shelves__bridge1"."code" ASC, "shelves__bridge1"."id" ASC\nLIMIT 1)');
    expect(perRow).toContain('"smw_books"."id" IN (SELECT "smw_books"."id"\nFROM "smw_books" "smw_books"\n'
      + 'WHERE "smw_books"."shelf_id" = "shelves__bridge1"."id"\nORDER BY "smw_books"."pages" ASC, "smw_books"."id" ASC\nLIMIT 1)');
    expect(composite).toContain('("SmwSlots"."ShelfId", "SmwSlots"."SlotNo") IN (SELECT "SmwSlots"."ShelfId", "SmwSlots"."SlotNo"\nFROM "SmwSlots" "SmwSlots"\n'
      + 'WHERE "SmwSlots"."ShelfId" = "shelves__bridge1"."id"\nORDER BY "SmwSlots"."Label" ASC, "SmwSlots"."ShelfId" ASC, "SmwSlots"."SlotNo" ASC\nLIMIT 1)');
    expect(statements.join('\n')).not.toContain('ROW_NUMBER()');
  });
});

describe('the correlated subquery: navigations named like the table they point at', () => {
  const codes = (rows: Array<{ code: string }>): string[] => rows.map(row => row.code);
  const names = (rows: Array<{ name: string }>): string[] => rows.map(row => row.name);
  const ntShelves = () => db.ntShelves.orderBy(s => s.id);

  test('a collection of the OUTER shelf under a nested navigation join named like its table', async () => {
    takeStatements();
    const counts = await ntShelves()
      .select(x => ({
        code: x.code,
        n: sql<number>`${x.nt_library!.shelves!.where(y => exists(y.books!.where(bk => exists(bk.nt_shelf!.nt_library!.shelves!.where(z => exists(x.slots!)))))).count()}::int`,
      }))
      .toList();
    const statement = takeStatements().find(entry => entry.includes('"nt_slot"'));
    const rows = await ntShelves()
      .where(x => exists(x.nt_library!.shelves!.where(y => exists(y.books!.where(bk => exists(bk.nt_shelf!.nt_library!.shelves!.where(z => exists(x.slots!))))))))
      .select(x => ({ code: x.code }))
      .toList();

    // A shelf with a slot (B, C) counts the shelves of its library that hold a book
    expect(counts).toEqual([
      { code: 'A', n: 0 },
      { code: 'B', n: 2 },
      { code: 'C', n: 1 },
      { code: 'D', n: 0 },
    ]);
    expect(codes(rows)).toEqual(['B', 'C']);
    // No join of a nested subquery renders under the bare name the OUTER shelf is read by
    expect(statement).toBeDefined();
    expect(statement).not.toContain('"nt_shelf" "nt_shelf"');
    expect(statement).toContain('WHERE "nt_slot"."shelf_id" = "nt_shelf"."id"');
  });

  test('the inverse navigation of a collection whose parent renders under an alias of its own', async () => {
    const counts = await ntShelves()
      .select(x => ({
        code: x.code,
        n: sql<number>`${x.books!.where(bk => exists(bk.nt_shelf!.nt_library!.shelves!.where(y => exists(y.books!.where(k => eq(k.nt_shelf!.code, 'B')))))).count()}::int`,
      }))
      .toList();
    const rows = await ntShelves()
      .where(x => exists(x.books!.where(bk => exists(bk.nt_shelf!.nt_library!.shelves!.where(y => exists(y.books!.where(k => eq(k.nt_shelf!.code, 'B'))))))))
      .select(x => ({ code: x.code }))
      .toList();

    // `k.nt_shelf` is the shelf y the book is reached through: the books of the shelves of North, whose shelf B holds one
    expect(counts).toEqual([
      { code: 'A', n: 2 },
      { code: 'B', n: 1 },
      { code: 'C', n: 0 },
      { code: 'D', n: 0 },
    ]);
    expect(codes(rows)).toEqual(['A', 'B']);
  });

  test('the inverse navigation one level down reads the enclosing item, not the OUTER row of its table', async () => {
    const rows = await ntShelves()
      .where(x => exists(x.nt_library!.shelves!.where(y => exists(y.books!.where(k => eq(k.nt_shelf!.code, 'B'))))))
      .select(x => ({ code: x.code }))
      .toList();
    const counts = await ntShelves()
      .select(x => ({ code: x.code, n: sql<number>`${x.nt_library!.shelves!.where(y => exists(y.books!.where(k => eq(k.nt_shelf!.code, 'B')))).count()}::int` }))
      .toList();

    // North's shelf B holds a book: every North shelf qualifies, and counts that one shelf
    expect(codes(rows)).toEqual(['A', 'B']);
    expect(counts).toEqual([
      { code: 'A', n: 1 },
      { code: 'B', n: 1 },
      { code: 'C', n: 0 },
      { code: 'D', n: 0 },
    ]);
  });

  test('a navigation named like the OUTER table, the inverse of no collection, in a nested subquery', async () => {
    const rows = await db.ntLibraries
      .where(l => exists(l.shelves!.where(s => exists(s.books!.where(k => and(eq(k.nt_library!.name, 'North'), exists(l.shelves!.where(z => eq(z.code, 'D')))))))))
      .orderBy(l => l.id)
      .select(l => ({ name: l.name }))
      .toList();
    const counts = await db.ntLibraries
      .orderBy(l => l.id)
      .select(l => ({
        name: l.name,
        n: sql<number>`${l.shelves!.where(s => exists(s.books!.where(k => and(eq(k.nt_library!.name, 'North'), exists(l.shelves!.where(z => eq(z.code, 'D'))))))).count()}::int`,
      }))
      .toList();

    // The libraries with a shelf D and a shelf holding a book at home in North: South (c1 on C)
    expect(names(rows)).toEqual(['South']);
    expect(counts).toEqual([
      { name: 'North', n: 0 },
      { name: 'South', n: 1 },
    ]);
  });

  test('one level deep, a navigation named like the parent keeps its 1.0.10 SQL (unchanged)', async () => {
    takeStatements();
    const books = await db.ntBooks
      .where(b => exists(b.nt_shelf!.books!.where(k => eq(k.nt_shelf!.code, 'A'))))
      .orderBy(b => b.id)
      .select(b => ({ title: b.title }))
      .toList();
    const [path] = takeStatements();
    const counts = await ntShelves()
      .select(x => ({ code: x.code, n: sql<number>`${x.books!.where(k => eq(k.nt_shelf!.code, 'A')).count()}::int` }))
      .toList();
    const [inverse] = takeStatements();

    expect(books.map(book => book.title)).toEqual(['a1', 'a2']);
    expect(counts).toEqual([
      { code: 'A', n: 2 },
      { code: 'B', n: 0 },
      { code: 'C', n: 0 },
      { code: 'D', n: 0 },
    ]);
    expect(path).toBe(
      'SELECT "nt_book"."title" as "title"\nFROM "nt_book"\nWHERE EXISTS (SELECT 1 FROM "nt_book" "books__exists"\n'
      + 'LEFT JOIN "nt_shelf" "nt_shelf" ON "nt_book"."shelf_id" = "nt_shelf"."id"\n'
      + 'LEFT JOIN "nt_shelf" "nt_book__nt_shelf" ON "books__exists"."shelf_id" = "nt_book__nt_shelf"."id"\n'
      + 'WHERE "books__exists"."shelf_id" = "nt_shelf"."id" AND "nt_book__nt_shelf"."code" = $1)\nORDER BY "nt_book"."id" ASC',
    );
    // The inverse of the collection's key is its parent row: not joined, read under the parent's name
    expect(inverse).toBe(
      'SELECT "nt_shelf"."code" as "code", (SELECT COUNT(*) FROM "nt_book" "books__count"\n'
      + 'WHERE "books__count"."shelf_id" = "nt_shelf"."id" AND "nt_shelf"."code" = $1)::int as "n"\nFROM "nt_shelf"\n\nORDER BY "nt_shelf"."id" ASC',
    );
  });
});

describe('typing', () => {
  test('the flattened items are typed as the inner entity', async () => {
    const rows = await db.libraries
      .orderBy(l => l.id)
      .select(l => ({
        titles: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).orderBy(b => b.title).select(b => b.title).toStringList(),
        pages: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).sum(b => b.pages),
        count: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!).count(),
      }))
      .toList();

    const titles: string[] = rows[0].titles;
    const pages: number | null = rows[0].pages;
    const count: number = rows[0].count;
    expect({ titles, pages, count }).toEqual({ titles: ['Alpha', 'Beta'], pages: 350, count: 2 });

    // Compile-time only: a column of the shelf is not a column of the books it was flattened into
    const typeOnly = () => db.libraries.select(l => ({
      codes: l.shelves!.where(s => eq(s.archived, false)).selectMany(s => s.books!)
        // @ts-expect-error `code` is a column of the shelf, not of the flattened books
        .select(b => b.code)
        .toStringList(),
    }));
    void typeOnly;
  });
});
