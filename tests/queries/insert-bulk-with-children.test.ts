import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

// ============================================================================
// insertBulkWithChildren — N parents + their children in ONE statement
// ============================================================================
// The bulk sibling of `insertWithChildren`: task-DAG-style persists (N task
// rows + one audit row each) used to cost two statements; this fuses them.
// Parent identity mapping rides the SAME serial-ascend guarantee the single-
// parent variant already relies on: the parent leg inserts ORDER BY an input
// ordinal, so generated serial ids ascend in input-row order, and a
// row_number-over-pk CTE recovers each parent's input index for the child
// join. v1 restrictions (documented on the method): flat returning selectors
// on BOTH sides, single-column serial PKs, no unlessExists guard, and EVERY
// parent must carry at least one child (parents are returned through the
// child join).

class BulkParent extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  weight!: DbColumn<number>;
}

class BulkChild extends DbEntity {
  id!: DbColumn<number>;
  parentId!: DbColumn<number>;
  note!: DbColumn<string>;
}

class BulkTestDatabase extends DbContext {
  get bulkParents(): DbEntityTable<BulkParent> {
    return this.table(BulkParent);
  }

  get bulkChildren(): DbEntityTable<BulkChild> {
    return this.table(BulkChild);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(BulkParent, entity => {
      entity.toTable('ibwc_parent_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ibwc_parent_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 60)).isRequired();
      entity.property(e => e.weight).hasType(integer('weight')).isRequired();
    });

    model.entity(BulkChild, entity => {
      entity.toTable('ibwc_child_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'ibwc_child_test_id_seq' }));
      entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
      entity.property(e => e.note).hasType(varchar('note', 60)).isRequired();
    });
  }
}

describe('insertBulkWithChildren', () => {
  let db: BulkTestDatabase;
  let client: ReturnType<typeof createFreshClient>;

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new BulkTestDatabase(client);
    await client.query('DROP TABLE IF EXISTS ibwc_child_test CASCADE');
    await client.query('DROP TABLE IF EXISTS ibwc_parent_test CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS ibwc_child_test CASCADE');
    await client.query('DROP TABLE IF EXISTS ibwc_parent_test CASCADE');
    await db.dispose();
  });

  test('inserts N parents with index-mapped children in one call', async () => {
    const result = await db.bulkParents.insertBulkWithChildren({
      rows: [
        { label: 'p0', weight: 10 },
        { label: 'p1', weight: 20 },
        { label: 'p2', weight: 30 },
      ],
      children: {
        table: db.bulkChildren,
        foreignKey: 'parentId',
        rows: [
          { parentIndex: 0, row: { note: 'c0-a' } },
          { parentIndex: 2, row: { note: 'c2-a' } },
          { parentIndex: 0, row: { note: 'c0-b' } },
          { parentIndex: 1, row: { note: 'c1-a' } },
        ],
      },
      returning: {
        parents: p => ({ id: p.id, label: p.label, weight: p.weight }),
        children: c => ({ id: c.id, parentId: c.parentId, note: c.note }),
      },
    });

    // Parents come back in INPUT order with ascending serial ids.
    expect(result.parents.map(p => p.label)).toEqual(['p0', 'p1', 'p2']);
    expect(result.parents[0].id).toBeLessThan(result.parents[1].id);
    expect(result.parents[1].id).toBeLessThan(result.parents[2].id);
    expect(result.parents.map(p => p.weight)).toEqual([10, 20, 30]);

    // Children map to THEIR parent by index, in child input order.
    expect(result.children.map(c => c.note)).toEqual(['c0-a', 'c2-a', 'c0-b', 'c1-a']);
    const byLabel = new Map(result.parents.map(p => [p.label, p.id]));
    expect(result.children[0].parentId).toBe(byLabel.get('p0'));
    expect(result.children[1].parentId).toBe(byLabel.get('p2'));
    expect(result.children[2].parentId).toBe(byLabel.get('p0'));
    expect(result.children[3].parentId).toBe(byLabel.get('p1'));

    // Persisted truth matches.
    const persistedChildren = await db.bulkChildren.toList();
    expect(persistedChildren.filter(c => c.parentId === byLabel.get('p0'))).toHaveLength(2);
  });

  test('rejects a child row whose parentIndex is out of range', async () => {
    expect(() => db.bulkParents.insertBulkWithChildren({
      rows: [{ label: 'solo', weight: 1 }],
      children: {
        table: db.bulkChildren,
        foreignKey: 'parentId',
        rows: [{ parentIndex: 1, row: { note: 'orphan' } }],
      },
      returning: {
        parents: p => ({ id: p.id }),
        children: c => ({ id: c.id }),
      },
    })).toThrow(/parentIndex/);
  });

  test('rejects a parent that no child references (v1 join-through restriction)', async () => {
    expect(() => db.bulkParents.insertBulkWithChildren({
      rows: [
        { label: 'covered', weight: 1 },
        { label: 'childless', weight: 2 },
      ],
      children: {
        table: db.bulkChildren,
        foreignKey: 'parentId',
        rows: [{ parentIndex: 0, row: { note: 'only' } }],
      },
      returning: {
        parents: p => ({ id: p.id }),
        children: c => ({ id: c.id }),
      },
    })).toThrow(/child/);
  });

  test('rejects a child row that carries the foreign-key property', async () => {
    expect(() => db.bulkParents.insertBulkWithChildren({
      rows: [{ label: 'p', weight: 1 }],
      children: {
        table: db.bulkChildren,
        foreignKey: 'parentId',
        rows: [{ parentIndex: 0, row: { parentId: 99, note: 'smuggled' } }],
      },
      returning: {
        parents: p => ({ id: p.id }),
        children: c => ({ id: c.id }),
      },
    })).toThrow(/foreign-key/);
  });

  test('single-statement atomicity: a failing child leg rolls the parents back', async () => {
    const before = await db.bulkParents.toList();

    await expect(db.bulkParents.insertBulkWithChildren({
      rows: [{ label: 'doomed', weight: 1 }],
      children: {
        table: db.bulkChildren,
        foreignKey: 'parentId',
        // note is NOT NULL — a null value fails the child leg inside the statement.
        rows: [{ parentIndex: 0, row: { note: null as unknown as string } }],
      },
      returning: {
        parents: p => ({ id: p.id }),
        children: c => ({ id: c.id }),
      },
    })).rejects.toThrow();

    const after = await db.bulkParents.toList();
    expect(after.length).toBe(before.length);
    expect(after.find(p => p.label === 'doomed')).toBeUndefined();
  });
});
