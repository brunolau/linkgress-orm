/**
 * Repro test for QA_GO-429 Bug D (linkgress-orm side):
 *   Navigation properties may declare CONSTANT FK predicates by extending the
 *   `withForeignKey` / `withPrincipalKey` arrays beyond the actual column
 *   equality. Example (from a real consumer codebase):
 *
 *     entity.hasMany(e => e.children, () => Child)
 *       .withForeignKey(c => [c.parentId, c.isCurrent])  // FK side
 *       .withPrincipalKey(p => [p.id,    true]);          // PK side (literal `true`)
 *
 *   Intent: every projection of `parent.children` automatically restricts to
 *   currently-active child rows (parent.children = WHERE child.parent_id = parent.id
 *   AND child.is_current = TRUE).
 *
 * THE BUG (current main): when the relation is projected via
 *   `.select(...).toList(...)`, the emitted lateral / CTE / temptable SQL is:
 *
 *     SELECT ... FROM "child" "lateral_0_children"
 *     WHERE "lateral_0_children"."parent_id" = "parent"."id"
 *     -- MISSING: AND "lateral_0_children"."is_current" = true
 *
 *   The first FK pair (column equality) fires, but the second / third / Nth
 *   pair (constant predicates) is silently dropped — `CollectionQueryBuilder`
 *   discards everything past `foreignKeys[0]` at construction time.
 *
 * Symptom in real consumers: SCD2-closed (historical) rows leak through
 * navigation property projections, producing "zombie" tags / discounts /
 * payments after delete + reload.
 *
 * These tests:
 *  1. Insert mixed-current and stale rows on the child side.
 *  2. Project `parent.children` via `.select(...).toList()`.
 *  3. Assert ONLY the current row(s) are returned (semantic).
 *  4. Assert the emitted SQL contains the constant predicate (structural).
 *
 * The tests MUST FAIL on current main and PASS after the fix.
 */

import { describe, test, expect } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import {
  DbContext,
  DbEntityTable,
  DbModelConfig,
  DbEntity,
  DbColumn,
  integer,
  varchar,
  boolean,
} from '../../src';
import { eq } from '../../src/query/conditions';

// ---------------------------------------------------------------------------
// Schema: Parent + Child, where Child is SCD2 (carries is_current flag) and
// the Parent.children navigation filters to is_current = true via a constant
// FK predicate.
// ---------------------------------------------------------------------------

class CfkParent extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;

  // hasMany — constant FK predicate: only current children
  children?: CfkChild[];
  // For 3-column variant
  flaggedChildren?: CfkChild3[];
}

class CfkChild extends DbEntity {
  id!: DbColumn<number>;
  parentId!: DbColumn<number>;
  isCurrent!: DbColumn<boolean>;
  label!: DbColumn<string>;
}

// Variant with a 3-column FK array: column + boolean literal + numeric literal
class CfkChild3 extends DbEntity {
  id!: DbColumn<number>;
  parentId!: DbColumn<number>;
  isCurrent!: DbColumn<boolean>;
  generation!: DbColumn<number>;
  label!: DbColumn<string>;
}

class CfkProjectionDatabase extends DbContext {
  get cfkParents(): DbEntityTable<CfkParent> {
    return this.table(CfkParent);
  }

  get cfkChildren(): DbEntityTable<CfkChild> {
    return this.table(CfkChild);
  }

  get cfkChildren3(): DbEntityTable<CfkChild3> {
    return this.table(CfkChild3);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(CfkParent, entity => {
      entity.toTable('cfk_parents');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'cfk_parents_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();

      // Composite FK with constant predicate (the load-bearing definition!)
      entity.hasMany(e => e.children, () => CfkChild)
        .withForeignKey(c => [c.parentId, c.isCurrent])
        .withPrincipalKey(p => [p.id, true]);

      // 3-column variant: column + boolean-literal + numeric-literal
      entity.hasMany(e => e.flaggedChildren, () => CfkChild3)
        .withForeignKey(c => [c.parentId, c.isCurrent, c.generation])
        .withPrincipalKey(p => [p.id, true, 2]);
    });

    model.entity(CfkChild, entity => {
      entity.toTable('cfk_children');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'cfk_children_id_seq' }));
      entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
      entity.property(e => e.isCurrent).hasType(boolean('is_current')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();
    });

    model.entity(CfkChild3, entity => {
      entity.toTable('cfk_children_3');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'cfk_children_3_id_seq' }));
      entity.property(e => e.parentId).hasType(integer('parent_id')).isRequired();
      entity.property(e => e.isCurrent).hasType(boolean('is_current')).isRequired();
      entity.property(e => e.generation).hasType(integer('generation')).isRequired();
      entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();
    });
  }
}

async function cleanupSchema(client: any): Promise<void> {
  await client.query('DROP TABLE IF EXISTS cfk_children_3 CASCADE');
  await client.query('DROP TABLE IF EXISTS cfk_children CASCADE');
  await client.query('DROP TABLE IF EXISTS cfk_parents CASCADE');
}

/**
 * Helper: create a fresh DB with logQueries hooked up to a capture array, then
 * run the test body. Captures all SQL emitted via the QueryExecutor logger so we
 * can assert against the generated lateral / CTE SQL.
 */
async function withCapture<T>(
  strategy: 'cte' | 'lateral' | 'temptable',
  testFn: (db: CfkProjectionDatabase, captured: string[]) => Promise<T>,
): Promise<T> {
  const client = createFreshClient();
  const captured: string[] = [];
  const db = new CfkProjectionDatabase(client, {
    logQueries: true,
    logParameters: false,
    collectionStrategy: strategy,
    logger: (msg: string) => {
      captured.push(msg);
    },
  });

  try {
    await cleanupSchema(client);
    await db.getSchemaManager().ensureCreated();
    return await testFn(db, captured);
  } finally {
    await cleanupSchema(client);
    await db.dispose();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Navigation constant FK predicates are emitted in projection SQL (lateral/cte/temptable)', () => {

  // -----------------------------------------------------------------------
  // PRIMARY DEFECT-PROVING TEST
  // -----------------------------------------------------------------------
  test('lateral projection: parent.children with [col,isCurrent]+[id,true] only returns current children', async () => {
    await withCapture('lateral', async (db, captured) => {
      // Seed: 1 parent, 1 current child, 2 closed (historical) children
      const [parent] = await db.cfkParents.insertBulk([
        { name: 'P1' },
      ]).returning();

      await db.cfkChildren.insertBulk([
        { parentId: parent.id, isCurrent: true,  label: 'current'   },
        { parentId: parent.id, isCurrent: false, label: 'closed-1'  },
        { parentId: parent.id, isCurrent: false, label: 'closed-2'  },
      ]);

      const results = await db.cfkParents
        .select(p => ({
          id: p.id,
          name: p.name,
          children: p.children!.select(c => ({
            id: c.id,
            label: c.label,
          })).toList(),
        }))
        .toList();

      // Find the parent and its projected children
      const projectedParent = results.find(r => r.id === parent.id);
      expect(projectedParent).toBeDefined();
      const childLabels = (projectedParent!.children.map((c: any) => c.label) as string[]).slice().sort();

      // SEMANTIC ASSERTION (the bug): without the constant predicate, all 3 rows leak
      expect(childLabels).toEqual(['current']);

      // STRUCTURAL ASSERTION: the SELECT SQL must contain the constant predicate
      const lateralSql = captured.find(s =>
        /^\s*SELECT/i.test(s)
        && s.includes('"cfk_children"')
        && s.includes('"parent_id"'));
      expect(lateralSql).toBeDefined();
      // The fix must emit: AND "<alias>"."is_current" = true
      // (i.e. both the column-equality AND the literal predicate)
      expect(lateralSql!).toMatch(/"is_current"\s*=\s*true/i);
    });
  });

  test('cte projection: parent.children with [col,isCurrent]+[id,true] only returns current children', async () => {
    await withCapture('cte', async (db, captured) => {
      const [parent] = await db.cfkParents.insertBulk([
        { name: 'P-cte' },
      ]).returning();

      await db.cfkChildren.insertBulk([
        { parentId: parent.id, isCurrent: true,  label: 'live'   },
        { parentId: parent.id, isCurrent: false, label: 'stale'  },
      ]);

      const results = await db.cfkParents
        .select(p => ({
          id: p.id,
          children: p.children!.select(c => ({ label: c.label })).toList(),
        }))
        .toList();

      const proj = results.find(r => r.id === parent.id);
      expect(proj).toBeDefined();
      expect(proj!.children.map((c: any) => c.label)).toEqual(['live']);

      // CTE SQL must contain the constant predicate
      const cteSql = captured.find(s =>
        /WITH\b/i.test(s) && s.includes('"cfk_children"'));
      expect(cteSql).toBeDefined();
      expect(cteSql!).toMatch(/"is_current"\s*=\s*true/i);
    });
  });

  // -----------------------------------------------------------------------
  // ADDITIONAL COVERAGE
  // -----------------------------------------------------------------------

  test('3-column FK array: [parentId, isCurrent, generation] + [id, true, 2] emits both literal predicates', async () => {
    await withCapture('lateral', async (db, captured) => {
      const [parent] = await db.cfkParents.insertBulk([
        { name: 'P-3col' },
      ]).returning();

      await db.cfkChildren3.insertBulk([
        { parentId: parent.id, isCurrent: true,  generation: 2, label: 'match'           },
        { parentId: parent.id, isCurrent: true,  generation: 1, label: 'wrong-gen'       },
        { parentId: parent.id, isCurrent: false, generation: 2, label: 'closed-right-gen' },
      ]);

      const results = await db.cfkParents
        .select(p => ({
          id: p.id,
          flaggedChildren: p.flaggedChildren!.select(c => ({ label: c.label })).toList(),
        }))
        .toList();

      const proj = results.find(r => r.id === parent.id);
      expect(proj).toBeDefined();
      // Only the 'match' row satisfies BOTH constant predicates
      expect(proj!.flaggedChildren.map((c: any) => c.label)).toEqual(['match']);

      const sql = captured.find(s =>
        /^\s*SELECT/i.test(s)
        && s.includes('"cfk_children_3"')
        && s.includes('"parent_id"'));
      expect(sql).toBeDefined();
      expect(sql!).toMatch(/"is_current"\s*=\s*true/i);
      expect(sql!).toMatch(/"generation"\s*=\s*2/);
    });
  });

  test('user .where() composes with constant FK predicates instead of replacing them', async () => {
    await withCapture('lateral', async (db, captured) => {
      const [parent] = await db.cfkParents.insertBulk([
        { name: 'P-where' },
      ]).returning();

      await db.cfkChildren.insertBulk([
        { parentId: parent.id, isCurrent: true,  label: 'live-A'  },
        { parentId: parent.id, isCurrent: true,  label: 'live-B'  },
        { parentId: parent.id, isCurrent: false, label: 'stale-A' },
      ]);

      // Compose user-where with the constant FK predicate
      // The user's `.where()` must AND with — not replace — the literal predicate
      const results = await db.cfkParents
        .select(p => ({
          id: p.id,
          children: p.children!
            .where(c => eq(c.label, 'live-A'))
            .select(c => ({ label: c.label }))
            .toList(),
        }))
        .toList();

      const proj = results.find(r => r.id === parent.id);
      expect(proj).toBeDefined();
      // Semantic: only 'live-A' matches user-where AND constant predicate
      expect(proj!.children.map((c: any) => c.label)).toEqual(['live-A']);

      // SQL must include BOTH the user predicate AND constant predicate
      const sql = captured.find(s =>
        /^\s*SELECT/i.test(s)
        && s.includes('"cfk_children"')
        && s.includes('"parent_id"'));
      expect(sql).toBeDefined();
      expect(sql!).toMatch(/"is_current"\s*=\s*true/i);
    });
  });

  test('temptable projection: parent.children with [col,isCurrent]+[id,true] only returns current children', async () => {
    await withCapture('temptable', async (db, captured) => {
      const [parent] = await db.cfkParents.insertBulk([
        { name: 'P-tt' },
      ]).returning();

      await db.cfkChildren.insertBulk([
        { parentId: parent.id, isCurrent: true,  label: 'tt-live'  },
        { parentId: parent.id, isCurrent: false, label: 'tt-stale' },
      ]);

      const results = await db.cfkParents
        .select(p => ({
          id: p.id,
          children: p.children!.select(c => ({ label: c.label })).toList(),
        }))
        .toList();

      const proj = results.find(r => r.id === parent.id);
      expect(proj).toBeDefined();
      expect(proj!.children.map((c: any) => c.label)).toEqual(['tt-live']);

      // Temptable strategy: WHERE-filter or JOIN must include literal predicate
      const sql = captured.find(s =>
        /SELECT/i.test(s)
        && s.includes('"cfk_children"')
        && s.includes('parent_id'));
      expect(sql).toBeDefined();
      expect(sql!).toMatch(/"is_current"\s*=\s*true/i);
    });
  });
});
