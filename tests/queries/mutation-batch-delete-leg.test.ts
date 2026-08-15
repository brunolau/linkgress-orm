import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { withDatabase, seedTestData, createFreshClient } from '../utils/test-database';
import { eq } from '../../src/query/conditions';
import { MutationBatch } from '../../src/query/mutation-batch';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * MutationBatch DELETE leg — `addDeleteWhereIn(table, field, values, id)`
 * registers `DELETE FROM t WHERE "col" IN ($1, …)` as a data-modifying-CTE leg,
 * with each value run through the column's toDriver mapper (same fidelity rule
 * as the insert/update legs).
 *
 * Headline use case: the post-payment cart clear — child rows by FK plus parent
 * rows by PK fused into ONE statement. That relies on PostgreSQL checking
 * NO ACTION foreign keys at END of statement: both legs' deletes are visible to
 * the constraint check together, so deleting parent + child in one statement
 * satisfies an FK that would reject deleting the parent alone. Pinned by the
 * no-action test below so leg composition never regresses that property.
 */
describe('MutationBatch delete leg (addDeleteWhereIn)', () => {
  test('deletes rows by field IN values with per-leg affected count', async () => {
    await withDatabase(async (db) => {
      const { users, posts } = await seedTestData(db);

      const batch = new MutationBatch();
      const key = batch.addDeleteWhereIn(db.posts, 'userId', [users.alice.id], 'alice-posts');

      await batch.executeBatch();

      // Alice seeds two posts; both must be gone, Bob's untouched.
      expect(batch.getAffectedCount(key!)).toBe(2);
      const remaining = await db.posts.toList();
      expect(remaining.map(p => p.id)).toEqual([posts.bobPost.id]);
    });
  });

  test('composes with other legs in ONE statement', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const batch = new MutationBatch();
      batch.addDeleteWhereIn(db.posts, 'userId', [users.alice.id], 'posts');
      batch.addBulkUpdate(db.users, [{ id: users.alice.id, age: 77 }], 'users');

      const client = (db as any).client;
      const querySpy = jest.spyOn(client, 'query');

      try {
        await batch.executeBatch();

        expect(querySpy).toHaveBeenCalledTimes(1);
      } finally {
        querySpy.mockRestore();
      }

      expect(batch.getAffectedCount('posts')).toBe(2);
      expect(batch.getAffectedCount('users')).toBe(1);
    });
  });

  test('values run through the column toDriver mapper', async () => {
    await withDatabase(async (db) => {
      const { posts } = await seedTestData(db);

      // publishTime rides the HourMinute custom mapper (object ↔ smallint);
      // alicePost1 seeds at 09:30 — matching by the OBJECT value proves the
      // leg maps values exactly like standalone mutations do.
      const batch = new MutationBatch();
      const key = batch.addDeleteWhereIn(db.posts, 'publishTime', [{ hour: 9, minute: 30 }], 'by-time');

      await batch.executeBatch();

      expect(batch.getAffectedCount(key!)).toBe(1);
      const remaining = await db.posts.toList();
      expect(remaining.map(p => p.id).sort()).toEqual([posts.alicePost2.id, posts.bobPost.id].sort());
    });
  });

  test('empty values register nothing and return null', async () => {
    await withDatabase(async (db) => {
      await seedTestData(db);

      const batch = new MutationBatch();
      const key = batch.addDeleteWhereIn(db.posts, 'userId', [], 'noop');

      expect(key).toBeNull();
      expect(batch.size).toBe(0);

      // Zero-leg batch is a no-op.
      await batch.executeBatch();
      expect(() => batch.getAffectedCount('noop')).toThrow(/no leg registered/);
    });
  });

  test('duplicate leg identifier throws', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const batch = new MutationBatch();
      batch.addDeleteWhereIn(db.posts, 'userId', [users.alice.id], 'dupe');

      expect(() => batch.addDeleteWhereIn(db.posts, 'userId', [users.bob.id], 'dupe')).toThrow(/duplicate leg identifier/);
    });
  });

  test('unknown field name throws at registration', async () => {
    await withDatabase(async (db) => {
      const { users } = await seedTestData(db);

      const batch = new MutationBatch();

      expect(() => batch.addDeleteWhereIn(db.posts, 'notAColumn', [users.alice.id], 'bad')).toThrow(/notAColumn/);
    });
  });
});

// ============================================================================
// NO ACTION FK: child-by-FK + parent-by-PK fused into one statement
// ============================================================================

class MbdlParent extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class MbdlChild extends DbEntity {
  id!: DbColumn<number>;
  parentId!: DbColumn<number>;
  note!: DbColumn<string>;
  parent?: MbdlParent;
}

class MbdlTestDatabase extends DbContext {
  get mbdlParents(): DbEntityTable<MbdlParent> {
    return this.table(MbdlParent);
  }

  get mbdlChildren(): DbEntityTable<MbdlChild> {
    return this.table(MbdlChild);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(MbdlParent, entity => {
      entity.toTable('mbdl_parent_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mbdl_parent_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 60)).isRequired();
    });

    model.entity(MbdlChild, entity => {
      entity.toTable('mbdl_child_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mbdl_child_test_id_seq' }));
      entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
      entity.property(e => e.note).hasType(varchar('note', 60)).isRequired();
      // Deliberately NO onDelete → PostgreSQL default NO ACTION (checked at
      // END of statement) — the property the one-statement fuse relies on.
      entity.hasOne(e => e.parent, () => MbdlParent)
        .withForeignKey(e => e.parentId)
        .withPrincipalKey(e => e.id);
    });
  }
}

describe('MutationBatch delete legs vs NO ACTION foreign key', () => {
  let db: MbdlTestDatabase;
  let client: ReturnType<typeof createFreshClient>;

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new MbdlTestDatabase(client);
    await client.query('DROP TABLE IF EXISTS mbdl_child_test CASCADE');
    await client.query('DROP TABLE IF EXISTS mbdl_parent_test CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS mbdl_child_test CASCADE');
    await client.query('DROP TABLE IF EXISTS mbdl_parent_test CASCADE');
    await db.dispose();
  });

  test('parent delete alone is rejected by the FK (sanity: the FK is real)', async () => {
    const [parent] = await db.mbdlParents.insertBulk([{ label: 'locked' }]).returning();
    await db.mbdlChildren.insertBulk([{ parentId: parent.id, note: 'holds parent' }]);

    await expect(
      db.mbdlParents.where(p => eq(p.id, parent.id)).delete()
    ).rejects.toThrow(/violates foreign key constraint|verletzt Fremdschl/);

    // Clean up for the next test.
    await db.mbdlChildren.where(c => eq(c.parentId, parent.id)).delete();
    await db.mbdlParents.where(p => eq(p.id, parent.id)).delete();
  });

  test('child-by-FK + parent-by-PK legs succeed in ONE statement', async () => {
    const [keep, drop] = await db.mbdlParents.insertBulk([
      { label: 'keep' },
      { label: 'drop' },
    ]).returning();
    await db.mbdlChildren.insertBulk([
      { parentId: keep.id, note: 'keep-child' },
      { parentId: drop.id, note: 'drop-child-a' },
      { parentId: drop.id, note: 'drop-child-b' },
    ]);

    const batch = new MutationBatch();
    const childKey = batch.addDeleteWhereIn(db.mbdlChildren, 'parentId', [drop.id], 'children');
    const parentKey = batch.addDeleteWhereIn(db.mbdlParents, 'id', [drop.id], 'parents');

    await batch.executeBatch();

    expect(batch.getAffectedCount(childKey!)).toBe(2);
    expect(batch.getAffectedCount(parentKey!)).toBe(1);

    const parents = await db.mbdlParents.toList();
    expect(parents.map(p => p.label)).toEqual(['keep']);
    const children = await db.mbdlChildren.toList();
    expect(children.map(c => c.note)).toEqual(['keep-child']);
  });
});
