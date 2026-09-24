/**
 * Collections over the SAME table as the row they are read from, under every collection strategy:
 * a table related to itself (a tree: `n.children`, `n.parent.children`), a collection reached back
 * through a navigation (`ed.book.editions` from an edition, `ln.member.loans` from a loan), and a
 * nested collection whose WHERE reads its enclosing collection's row.
 *
 * Tree (st_nodes), ids in this order:
 *
 *   root
 *   ├── a
 *   │   ├── a1
 *   │   └── a2
 *   └── b
 *       └── b1
 *
 * Library: tests/utils/library-fixture.ts (Dune: E-2, E-3, E-5; Emma: E-1, E-4; loans L1 < L2 < L3,
 * Ada holds L1 "first" and L2 "second", Bo holds L3 "third").
 *
 * Every one of these used to read the INNER row where it meant the outer one — no SQL error:
 * - LATERAL: the collection registered its table under its own inner alias before it rendered its
 *   own correlation, so `c.children` correlated to itself; the first hop of `ed.book.editions` was
 *   joined from the inner edition (`inner.book_id = book.id` holds for every edition);
 * - `exists()` in a WHERE left its table unaliased, shadowing an outer row of the same table;
 * - a nested collection's refs to its enclosing collection's row carry that collection's marker,
 *   which names a TABLE: over the same table the inner collection rewrote them to its own alias
 *   (`x.id > x.id`), over another table nobody rewrote them (`missing FROM-clause entry`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, DatabaseClient, eq, exists, gt, integer, varchar } from '../../src';
import { createFreshClient } from '../utils/test-database';
import { createLibraryFixture, disposeLibraryFixture, LIBRARY_STRATEGIES, LibraryFixture } from '../utils/library-fixture';

class StNode extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  parentId?: DbColumn<number | null>;

  parent?: StNode;
  children?: StNode[];
}

class TreeDatabase extends DbContext {
  get nodes(): DbEntityTable<StNode> {
    return this.table(StNode);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(StNode, entity => {
      entity.toTable('st_nodes');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'st_nodes_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.parentId).hasType(integer('parent_id'));

      entity.hasOne(e => e.parent, () => StNode).withForeignKey(n => n.parentId!).withPrincipalKey(p => p.id);
      entity.hasMany(e => e.children, () => StNode).withForeignKey(n => n.parentId!).withPrincipalKey(p => p.id);
    });
  }
}

let treeClient: DatabaseClient;
let tree: TreeDatabase;
const treeCaptured: string[] = [];
let fx: LibraryFixture;

beforeAll(async () => {
  treeClient = createFreshClient();
  tree = new TreeDatabase(treeClient, { logQueries: true, logger: (message: string) => { treeCaptured.push(message); } });

  await treeClient.query('DROP TABLE IF EXISTS st_nodes CASCADE');
  await tree.getSchemaManager().ensureCreated();

  const [root] = await tree.nodes.insertBulk([{ name: 'root', parentId: null }]).returning();
  const [a, b] = await tree.nodes.insertBulk([{ name: 'a', parentId: root.id }, { name: 'b', parentId: root.id }]).returning();
  await tree.nodes.insertBulk([{ name: 'a1', parentId: a.id }, { name: 'a2', parentId: a.id }, { name: 'b1', parentId: b.id }]).returning();

  fx = await createLibraryFixture();
});

afterAll(async () => {
  await treeClient.query('DROP TABLE IF EXISTS st_nodes CASCADE');
  await tree.dispose();
  await disposeLibraryFixture(fx);
});

/** The tree's logged statements (without the logger's `[…]` headers) since the last call. */
const treeStatements = (): string => {
  const text = treeCaptured.filter(entry => !entry.trimStart().startsWith('[')).join('\n');
  treeCaptured.length = 0;

  return text;
};

for (const strategy of LIBRARY_STRATEGIES) {
  const nodes = () => tree.nodes.withQueryOptions({ collectionStrategy: strategy }).orderBy(n => n.name);

  describe(`a table related to itself — ${strategy}`, () => {
    test('children: list, count, flat list', async () => {
      const rows = await nodes()
        .select(n => ({
          name: n.name,
          kids: n.children!.orderBy(c => c.name).select(c => ({ name: c.name })).toList('kids'),
          count: n.children!.count(),
          names: n.children!.orderBy(c => c.name).select(c => c.name).toStringList('names'),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'a', kids: [{ name: 'a1' }, { name: 'a2' }], count: 2, names: ['a1', 'a2'] },
        { name: 'a1', kids: [], count: 0, names: [] },
        { name: 'a2', kids: [], count: 0, names: [] },
        { name: 'b', kids: [{ name: 'b1' }], count: 1, names: ['b1'] },
        { name: 'b1', kids: [], count: 0, names: [] },
        { name: 'root', kids: [{ name: 'a' }, { name: 'b' }], count: 2, names: ['a', 'b'] },
      ]);
    });

    test('grandchildren: the children of each child', async () => {
      const rows = await nodes()
        .where(n => eq(n.name, 'root'))
        .select(n => ({
          name: n.name,
          kids: n.children!.orderBy(c => c.name).select(c => ({
            name: c.name,
            kids: c.children!.orderBy(g => g.name).select(g => ({ name: g.name })).toList('kids'),
            count: c.children!.count(),
          })).toList('kids'),
        }))
        .toList();

      expect(rows).toEqual([
        {
          name: 'root',
          kids: [
            { name: 'a', kids: [{ name: 'a1' }, { name: 'a2' }], count: 2 },
            { name: 'b', kids: [{ name: 'b1' }], count: 1 },
          ],
        },
      ]);
    });

    test('children filtered by the parent row itself', async () => {
      // Only the children whose name sorts after their parent's: every child of `a` and `b`, none of root's
      const rows = await nodes()
        .where(n => eq(n.name, 'root'))
        .select(n => ({ name: n.name, kids: n.children!.where(c => gt(c.name, n.name)).select(c => ({ name: c.name })).toList('kids') }))
        .toList();
      const rowsOfA = await nodes()
        .where(n => eq(n.name, 'a'))
        .select(n => ({ name: n.name, kids: n.children!.where(c => gt(c.name, n.name)).orderBy(c => c.name).select(c => ({ name: c.name })).toList('kids') }))
        .toList();

      expect(rows).toEqual([{ name: 'root', kids: [] }]);
      expect(rowsOfA).toEqual([{ name: 'a', kids: [{ name: 'a1' }, { name: 'a2' }] }]);
    });

    test('siblings through the parent, and the later ones among them', async () => {
      const rows = await nodes()
        .select(n => ({
          name: n.name,
          siblings: n.parent!.children!.orderBy(c => c.name).select(c => ({ name: c.name })).toList('siblings'),
          later: n.parent!.children!.where(c => gt(c.id, n.id)).count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'a', siblings: [{ name: 'a' }, { name: 'b' }], later: 1 },
        { name: 'a1', siblings: [{ name: 'a1' }, { name: 'a2' }], later: 1 },
        { name: 'a2', siblings: [{ name: 'a1' }, { name: 'a2' }], later: 0 },
        { name: 'b', siblings: [{ name: 'a' }, { name: 'b' }], later: 0 },
        { name: 'b1', siblings: [{ name: 'b1' }], later: 0 },
        { name: 'root', siblings: [], later: 0 },
      ]);
    });

    test("a child's later siblings — a nested collection reading its enclosing collection's row", async () => {
      const rows = await nodes()
        .select(n => ({
          name: n.name,
          kids: n.children!.orderBy(c => c.name).select(c => ({
            name: c.name,
            laterSiblings: c.parent!.children!.where(s => gt(s.id, c.id)).orderBy(s => s.name).select(s => ({ name: s.name })).toList('laterSiblings'),
            laterCount: c.parent!.children!.where(s => gt(s.id, c.id)).count(),
          })).toList('kids'),
        }))
        .toList();

      expect(rows).toEqual([
        {
          name: 'a',
          kids: [
            { name: 'a1', laterSiblings: [{ name: 'a2' }], laterCount: 1 },
            { name: 'a2', laterSiblings: [], laterCount: 0 },
          ],
        },
        { name: 'a1', kids: [] },
        { name: 'a2', kids: [] },
        { name: 'b', kids: [{ name: 'b1', laterSiblings: [], laterCount: 0 }] },
        { name: 'b1', kids: [] },
        {
          name: 'root',
          kids: [
            { name: 'a', laterSiblings: [{ name: 'b' }], laterCount: 1 },
            { name: 'b', laterSiblings: [], laterCount: 0 },
          ],
        },
      ]);
    });
  });

  const editions = () => fx.db.libEditions.withQueryOptions({ collectionStrategy: strategy }).orderBy(ed => ed.label);
  const members = () => fx.db.libMembers.withQueryOptions({ collectionStrategy: strategy }).orderBy(m => m.name);

  describe(`a collection reached back through a navigation to its own table — ${strategy}`, () => {
    test('ed.book.editions: the editions of the same book, as a list and a flat list', async () => {
      const rows = await editions()
        .select(ed => ({
          label: ed.label,
          siblings: ed.book!.editions!.orderBy(x => x.label).select(x => ({ label: x.label })).toList('siblings'),
          labels: ed.book!.editions!.orderBy(x => x.label).select(x => x.label).toStringList('labels'),
        }))
        .toList();

      const dune = ['E-2', 'E-3', 'E-5'];
      const emma = ['E-1', 'E-4'];
      expect(rows).toEqual(['E-1', 'E-2', 'E-3', 'E-4', 'E-5'].map(label => {
        const labels = dune.includes(label) ? dune : emma;

        return { label, siblings: labels.map(sibling => ({ label: sibling })), labels };
      }));
    });

    test('ed.book.editions: limited, offset-counted, firstOrDefault, exists', async () => {
      const rows = await editions()
        .select(ed => ({
          label: ed.label,
          firstTwo: ed.book!.editions!.orderBy(x => x.label).limit(2).select(x => ({ label: x.label })).toList('firstTwo'),
          afterFirst: ed.book!.editions!.orderBy(x => x.label).offset(1).count(),
          last: ed.book!.editions!.orderBy(x => [[x.label, 'DESC']]).select(x => ({ label: x.label })).firstOrDefault('last'),
          hasE4: ed.book!.editions!.where(x => eq(x.label, 'E-4')).exists(),
        }))
        .toList();

      const dune = { firstTwo: [{ label: 'E-2' }, { label: 'E-3' }], afterFirst: 2, last: { label: 'E-5' }, hasE4: false };
      const emma = { firstTwo: [{ label: 'E-1' }, { label: 'E-4' }], afterFirst: 1, last: { label: 'E-4' }, hasE4: true };
      expect(rows).toEqual([
        { label: 'E-1', ...emma },
        { label: 'E-2', ...dune },
        { label: 'E-3', ...dune },
        { label: 'E-4', ...emma },
        { label: 'E-5', ...dune },
      ]);
    });

    test('ln.member.loans inside a member\'s loans: every loan of the same member', async () => {
      const rows = await members()
        .select(m => ({
          name: m.name,
          loans: m.loans!.orderBy(ln => ln.note).select(ln => ({
            note: ln.note,
            memberLoans: ln.member!.loans!.orderBy(x => x.note).select(x => ({ note: x.note })).toList('memberLoans'),
            memberNotes: ln.member!.loans!.orderBy(x => x.note).select(x => x.note).toStringList('memberNotes'),
            memberCount: ln.member!.loans!.count(),
          })).toList('loans'),
        }))
        .toList();

      const ada = { memberLoans: [{ note: 'first' }, { note: 'second' }], memberNotes: ['first', 'second'], memberCount: 2 };
      expect(rows).toEqual([
        { name: 'Ada', loans: [{ note: 'first', ...ada }, { note: 'second', ...ada }] },
        { name: 'Bo', loans: [{ note: 'third', memberLoans: [{ note: 'third' }], memberNotes: ['third'], memberCount: 1 }] },
        { name: 'Cy', loans: [] },
      ]);
    });
  });

  describe(`a nested collection reading its enclosing collection's row — ${strategy}`, () => {
    test('over the same table: the member\'s later loans of each loan', async () => {
      const rows = await members()
        .select(m => ({
          name: m.name,
          loans: m.loans!.orderBy(ln => ln.note).select(ln => ({
            note: ln.note,
            later: ln.member!.loans!.where(x => gt(x.id, ln.id)).select(x => ({ note: x.note })).toList('later'),
            laterCount: ln.member!.loans!.where(x => gt(x.id, ln.id)).count(),
          })).toList('loans'),
        }))
        .toList();

      expect(rows).toEqual([
        {
          name: 'Ada',
          loans: [
            { note: 'first', later: [{ note: 'second' }], laterCount: 1 },
            { note: 'second', later: [], laterCount: 0 },
          ],
        },
        { name: 'Bo', loans: [{ note: 'third', later: [], laterCount: 0 }] },
        { name: 'Cy', loans: [] },
      ]);
    });

    test('over the same table, in the enclosing collection\'s WHERE: loans followed by another of the member', async () => {
      const rows = await members()
        .select(m => ({
          name: m.name,
          loans: m.loans!.where(ln => exists(ln.member!.loans!.where(x => gt(x.id, ln.id)))).select(ln => ({ note: ln.note })).toList('loans'),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ada', loans: [{ note: 'first' }] },
        { name: 'Bo', loans: [] },
        { name: 'Cy', loans: [] },
      ]);
    });

    test('two levels down, over the same table: reading the outermost collection\'s row', async () => {
      const rows = await members()
        .select(m => ({
          name: m.name,
          loans: m.loans!.orderBy(ln => ln.id).select(ln => ({
            note: ln.note,
            memberLoans: ln.member!.loans!.orderBy(x => x.id).select(x => ({
              note: x.note,
              // The member's loans made after the OUTER loan `ln`, not after `x`
              laterThanOuter: x.member!.loans!.where(y => gt(y.id, ln.id)).count(),
            })).toList('memberLoans'),
          })).toList('loans'),
        }))
        .toList();

      expect(rows).toEqual([
        {
          name: 'Ada',
          loans: [
            { note: 'first', memberLoans: [{ note: 'first', laterThanOuter: 1 }, { note: 'second', laterThanOuter: 1 }] },
            { note: 'second', memberLoans: [{ note: 'first', laterThanOuter: 0 }, { note: 'second', laterThanOuter: 0 }] },
          ],
        },
        { name: 'Bo', loans: [{ note: 'third', memberLoans: [{ note: 'third', laterThanOuter: 0 }] }] },
        { name: 'Cy', loans: [] },
      ]);
    });

    test("over another table: the own book's editions after the loan's edition", async () => {
      const rows = await members()
        .select(m => ({
          name: m.name,
          loans: m.loans!.orderBy(ln => ln.note).select(ln => ({
            note: ln.note,
            editions: ln.book!.editions!.where(ed => gt(ed.id, ln.editionId)).orderBy(ed => ed.label).select(ed => ({ label: ed.label })).toList('editions'),
            editionCount: ln.book!.editions!.where(ed => gt(ed.id, ln.editionId)).count(),
          })).toList('loans'),
        }))
        .toList();

      // L1: own book Dune, edition E-1 · L2: own book Emma, edition E-2 · L3: own book Emma, edition E-3
      expect(rows).toEqual([
        {
          name: 'Ada',
          loans: [
            { note: 'first', editions: [{ label: 'E-2' }, { label: 'E-3' }, { label: 'E-5' }], editionCount: 3 },
            { note: 'second', editions: [{ label: 'E-4' }], editionCount: 1 },
          ],
        },
        { name: 'Bo', loans: [{ note: 'third', editions: [{ label: 'E-4' }], editionCount: 1 }] },
        { name: 'Cy', loans: [] },
      ]);
    });
  });
}

describe('exists() / count() over the same table in a root WHERE or projection', () => {
  test('a table related to itself', async () => {
    const withChildren = await tree.nodes.where(n => exists(n.children!)).orderBy(n => n.name).select(n => ({ name: n.name })).toList();
    const withA1 = await tree.nodes.where(n => exists(n.children!.where(c => eq(c.name, 'a1')))).select(n => ({ name: n.name })).toList();
    const withLaterSibling = await tree.nodes.where(n => exists(n.parent!.children!.where(c => gt(c.id, n.id)))).orderBy(n => n.name).select(n => ({ name: n.name })).toList();

    expect(withChildren).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'root' }]);
    expect(withA1).toEqual([{ name: 'a' }]);
    expect(withLaterSibling).toEqual([{ name: 'a' }, { name: 'a1' }]);
  });

  test('back through a navigation', async () => {
    const withE4 = await fx.db.libEditions
      .where(ed => exists(ed.book!.editions!.where(x => eq(x.label, 'E-4'))))
      .orderBy(ed => ed.label)
      .select(ed => ({ label: ed.label }))
      .toList();
    const followed = await fx.db.libLoans
      .where(ln => exists(ln.member!.loans!.where(x => gt(x.id, ln.id))))
      .select(ln => ({ note: ln.note }))
      .toList();
    const laterCounts = await fx.db.libLoans
      .orderBy(ln => ln.note)
      .select(ln => ({ note: ln.note, later: ln.member!.loans!.where(x => gt(x.id, ln.id)).count() }))
      .toList();

    expect(withE4).toEqual([{ label: 'E-1' }, { label: 'E-4' }]);
    expect(followed).toEqual([{ note: 'first' }]);
    expect(laterCounts).toEqual([
      { note: 'first', later: 1 },
      { note: 'second', later: 0 },
      { note: 'third', later: 0 },
    ]);
  });
});

describe('the SQL of a collection over the same table', () => {
  test('exists() names its own table apart from the outer row of the same table', async () => {
    treeStatements();
    await tree.nodes.where(n => exists(n.children!)).select(n => ({ name: n.name })).toList();

    const text = treeStatements();
    expect(text).toContain('EXISTS (SELECT 1 FROM "st_nodes" "children__exists"');
    expect(text).toContain('"children__exists"."parent_id" = "st_nodes"."id"');
  });

  test('an exists() that shadows nothing keeps its plain form', async () => {
    fx.resetCapture();
    await fx.db.libMembers.where(m => exists(m.loans!)).select(m => ({ name: m.name })).toList();

    expect(fx.lastStatement('EXISTS')).toContain('EXISTS (SELECT 1 FROM "lib_loans"\n');
  });

  test('LATERAL joins the first hop of the path from the OUTER row, and correlates the item to it', async () => {
    fx.resetCapture();
    await fx.db.libEditions
      .withQueryOptions({ collectionStrategy: 'lateral' })
      .select(ed => ({ label: ed.label, siblings: ed.book!.editions!.select(x => ({ label: x.label })).toList('siblings') }))
      .toList();

    const text = fx.lastStatement('LATERAL');
    expect(text).toContain('LEFT JOIN "lib_books" "book" ON "lib_editions"."book_id" = "book"."id"');
    expect(text).not.toContain('ON "lateral_0_editions"."book_id"');
    expect(text).toContain('WHERE "lateral_0_editions"."book_id" = "book"."id"');
  });

  test('LATERAL correlates a table related to itself to the outer row', async () => {
    treeStatements();
    await tree.nodes
      .withQueryOptions({ collectionStrategy: 'lateral' })
      .select(n => ({ name: n.name, kids: n.children!.select(c => ({ name: c.name })).toList('kids') }))
      .toList();

    expect(treeStatements()).toContain('WHERE "lateral_0_children"."parent_id" = "st_nodes"."id"');
  });
});
