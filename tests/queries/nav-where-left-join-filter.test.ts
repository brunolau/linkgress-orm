/**
 * Repro test for GOBO-226 bug:
 *   When a WHERE clause references a nav-property column and the relation has
 *   isMandatory=false, Linkgress generates a LEFT JOIN.  In standard SQL three-valued
 *   logic that should be fine — rows whose joined record produces NULL simply fail
 *   the predicate.  However, the *actual* observed symptom in gopass-eshop was that
 *   `eq(p.segment.active, true)` did NOT reliably exclude rows whose segment had
 *   `active = false`.  This test proves that with an isMandatory=false (LEFT JOIN)
 *   relation, all three cases are handled correctly:
 *
 *   A) product with segment(active=true)   → INCLUDED
 *   B) product with segment(active=false)  → EXCLUDED
 *   C) product with no segment (FK = NULL) → EXCLUDED
 *
 * The test MUST FAIL before the fix and PASS after.
 *
 * Investigation finding:
 *   Standard SQL three-valued logic already excludes cases B and C with a LEFT JOIN.
 *   The actual bug surfaces when `count()` (not `toList()`) is used — the navigation
 *   join detection for count() uses a DIFFERENT code path (`buildCountQuery`) that
 *   does NOT call `detectAndAddJoinsFromCondition`, so the WHERE clause references
 *   `"segment"."active"` but there is no JOIN for "segment" in the FROM clause.
 *   PostgreSQL either errors out OR — if an ambient `segment` table exists in the
 *   search_path — silently scans it without the ON condition, producing a cross-join
 *   that inflates or deflates counts unpredictably.
 *
 * Chosen fix approach: INNER JOIN promotion in detectAndAddJoinsFromCondition.
 *   When a nav-property column is referenced in a WHERE clause, the join is forced
 *   to INNER JOIN regardless of the relation's isMandatory flag.  An INNER JOIN
 *   naturally excludes rows with no matching record (case C), and for case B the
 *   predicate evaluates to FALSE and excludes the row.  This matches user intent:
 *   "filter by a nav-property column" implies the record must exist.
 *
 *   Secondary fix: ensure buildCountQuery and buildQueryCore both call
 *   detectAndAddJoinsFromCondition so the WHERE-driven JOIN is present in all
 *   query shapes (toList, count, first, etc.).
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
import { eq, and } from '../../src/query/conditions';

// ---------------------------------------------------------------------------
// Minimal schema: Segment + SegmentProduct
// SegmentProduct.segmentId is nullable → relation isMandatory=false (LEFT JOIN)
// ---------------------------------------------------------------------------

class Segment extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  active!: DbColumn<boolean>;
}

class SegmentProduct extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  // Declared non-optional so TypeScript allows it in withForeignKey();
  // the *column* itself is nullable in the DB (no .isRequired() on the property config).
  segmentId!: DbColumn<number | null>;

  // Navigation — isMandatory will be false (no .isRequired())
  segment?: Segment;
}

class SegmentTestDatabase extends DbContext {
  get segments(): DbEntityTable<Segment> {
    return this.table(Segment);
  }

  get segmentProducts(): DbEntityTable<SegmentProduct> {
    return this.table(SegmentProduct);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Segment, entity => {
      entity.toTable('gobo226_segments');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'gobo226_segments_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
      entity.property(e => e.active).hasType(boolean('active')).isRequired();
    });

    model.entity(SegmentProduct, entity => {
      entity.toTable('gobo226_segment_products');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'gobo226_segment_products_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
      entity.property(e => e.segmentId).hasType(integer('segment_id'));  // nullable — no .isRequired()

      // isMandatory=false because we do NOT call .isRequired() here
      entity.hasOne(e => e.segment, () => Segment)
        .withForeignKey(p => p.segmentId)
        .withPrincipalKey(s => s.id)
        .onDelete('set null');
    });
  }
}

async function cleanupSchema(client: any): Promise<void> {
  await client.query('DROP TABLE IF EXISTS gobo226_segment_products CASCADE');
  await client.query('DROP TABLE IF EXISTS gobo226_segments CASCADE');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GOBO-226: nav-property WHERE with isMandatory=false relation', () => {
  /**
   * Core repro — toList() path.
   * Standard SQL LEFT JOIN + WHERE already excludes non-matching and null-segment rows.
   * This exercises the detectAndAddJoinsFromCondition path used by buildQuery().
   */
  test('toList(): eq on nav.column excludes non-matching segment AND null-segment rows', async () => {
    const client = createFreshClient();
    const db = new SegmentTestDatabase(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [activeSegment, inactiveSegment] = await db.segments.insertBulk([
        { name: 'Active Segment',   active: true  },
        { name: 'Inactive Segment', active: false },
      ]).returning();

      await db.segmentProducts.insertBulk([
        { title: 'Product A', segmentId: activeSegment.id   },  // segment.active = true  → INCLUDE
        { title: 'Product B', segmentId: inactiveSegment.id },  // segment.active = false → EXCLUDE
        { title: 'Product C', segmentId: null                },  // no segment (null FK)   → EXCLUDE
      ]);

      const results = await db.segmentProducts
        .where(p => eq(p.segment!.active, true))
        .select(p => ({ id: p.id, title: p.title }))
        .toList();

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Product A');
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });

  /**
   * Bug repro — count() path.
   * The gopass workaround (`inArray(p.segmentId, activeSegmentIds)`) was adopted
   * because count() returned unexpected numbers.  This tests count() uses the same
   * nav-property JOIN detection as toList().
   *
   * BEFORE the fix: count() returns 3 (all rows) because the WHERE-driven join was
   * missing from the count query path, so `"segment"."active" = true` either errors
   * or is silently dropped depending on the Postgres search_path.
   *
   * AFTER the fix: count() returns 1 (only Product A).
   */
  test('count(): eq on nav.column returns correct count (not all rows)', async () => {
    const client = createFreshClient();
    const db = new SegmentTestDatabase(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [activeSegment, inactiveSegment] = await db.segments.insertBulk([
        { name: 'Active Segment',   active: true  },
        { name: 'Inactive Segment', active: false },
      ]).returning();

      await db.segmentProducts.insertBulk([
        { title: 'Product A', segmentId: activeSegment.id   },  // INCLUDE
        { title: 'Product B', segmentId: inactiveSegment.id },  // EXCLUDE
        { title: 'Product C', segmentId: null                },  // EXCLUDE
      ]);

      const count = await db.segmentProducts
        .where(p => eq(p.segment!.active, true))
        .count();

      // Expected: 1 (only Product A).
      // Before fix: may return 3 (all rows, because the WHERE JOIN was missing in count path).
      expect(count).toBe(1);
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });

  /**
   * Bug repro — first() / firstOrDefault() path.
   */
  test('first(): eq on nav.column returns the correct single row', async () => {
    const client = createFreshClient();
    const db = new SegmentTestDatabase(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [activeSegment, inactiveSegment] = await db.segments.insertBulk([
        { name: 'Active Segment',   active: true  },
        { name: 'Inactive Segment', active: false },
      ]).returning();

      await db.segmentProducts.insertBulk([
        { title: 'Product A', segmentId: activeSegment.id   },
        { title: 'Product B', segmentId: inactiveSegment.id },
        { title: 'Product C', segmentId: null                },
      ]);

      const result = await db.segmentProducts
        .where(p => eq(p.segment!.active, true))
        .select(p => ({ id: p.id, title: p.title }))
        .first();

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Product A');
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });

  /**
   * Variant: the nav property is in an AND compound condition.
   */
  test('toList(): nav.column in AND compound WHERE also excludes null-segment rows', async () => {
    const client = createFreshClient();
    const db = new SegmentTestDatabase(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [seg] = await db.segments.insertBulk([
        { name: 'Active', active: true },
      ]).returning();

      await db.segmentProducts.insertBulk([
        { title: 'X-With-Segment',    segmentId: seg.id },
        { title: 'X-Without-Segment', segmentId: null   },
      ]);

      const results = await db.segmentProducts
        .where(p => and(
          eq(p.segment!.active, true),
          eq(p.title, 'X-With-Segment')
        ))
        .select(p => ({ title: p.title }))
        .toList();

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('X-With-Segment');
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });

  /**
   * Bug repro — min() path (buildAggregationQuery).
   * min() / max() / sum() call buildAggregationQuery which does NOT call
   * detectAndAddJoinsFromCondition.  So if the WHERE clause references a nav-property
   * column, the generated SQL contains "segment"."active" in the WHERE but no JOIN
   * for "segment" in the FROM clause — PostgreSQL throws:
   *   ERROR:  missing FROM-clause entry for table "segment"
   *
   * BEFORE the fix: throws a PostgreSQL error.
   * AFTER the fix:  returns the correct min ID (only Product A's id).
   */
  test('min(): eq on nav.column does not error and returns correct result', async () => {
    const client = createFreshClient();
    const db = new SegmentTestDatabase(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [activeSegment, inactiveSegment] = await db.segments.insertBulk([
        { name: 'Active Segment',   active: true  },
        { name: 'Inactive Segment', active: false },
      ]).returning();

      const [prodA] = await db.segmentProducts.insertBulk([
        { title: 'Product A', segmentId: activeSegment.id   },  // INCLUDE
        { title: 'Product B', segmentId: inactiveSegment.id },  // EXCLUDE
        { title: 'Product C', segmentId: null                },  // EXCLUDE
      ]).returning();

      // Before fix: throws "missing FROM-clause entry for table 'segment'"
      // After fix: returns prodA.id (the only matching product's id)
      const minId = await db.segmentProducts
        .where(p => eq(p.segment!.active, true))
        .select(p => ({ id: p.id }))
        .min(p => p.id);

      expect(minId).toBe(prodA.id);
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });

  /**
   * Bug repro — max() path (buildAggregationQuery).
   * Same issue as min().
   *
   * BEFORE the fix: throws a PostgreSQL error.
   * AFTER the fix:  returns the correct max ID (only Product A's id).
   */
  test('max(): eq on nav.column does not error and returns correct result', async () => {
    const client = createFreshClient();
    const db = new SegmentTestDatabase(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [activeSegment, inactiveSegment] = await db.segments.insertBulk([
        { name: 'Active Segment',   active: true  },
        { name: 'Inactive Segment', active: false },
      ]).returning();

      const [prodA] = await db.segmentProducts.insertBulk([
        { title: 'Product A', segmentId: activeSegment.id   },
        { title: 'Product B', segmentId: inactiveSegment.id },
        { title: 'Product C', segmentId: null                },
      ]).returning();

      // Before fix: throws "missing FROM-clause entry for table 'segment'"
      // After fix: returns prodA.id
      const maxId = await db.segmentProducts
        .where(p => eq(p.segment!.active, true))
        .select(p => ({ id: p.id }))
        .max(p => p.id);

      expect(maxId).toBe(prodA.id);
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });

  /**
   * Control: when the relation IS mandatory (isMandatory=true / .isRequired()),
   * Linkgress already generates an INNER JOIN and the filter works correctly.
   * This test must PASS both before and after the fix — it is a regression guard.
   */
  test('mandatory relation (INNER JOIN) correctly filters — regression guard', async () => {
    class MandatoryDb extends DbContext {
      get segments(): DbEntityTable<Segment> { return this.table(Segment); }
      get segmentProducts(): DbEntityTable<SegmentProduct> { return this.table(SegmentProduct); }

      protected override setupModel(model: DbModelConfig): void {
        model.entity(Segment, entity => {
          entity.toTable('gobo226_segments');
          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'gobo226_segments_id_seq' }));
          entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
          entity.property(e => e.active).hasType(boolean('active')).isRequired();
        });

        model.entity(SegmentProduct, entity => {
          entity.toTable('gobo226_segment_products');
          entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'gobo226_segment_products_id_seq' }));
          entity.property(e => e.title).hasType(varchar('title', 200)).isRequired();
          entity.property(e => e.segmentId).hasType(integer('segment_id'));

          entity.hasOne(e => e.segment, () => Segment)
            .withForeignKey(p => p.segmentId)
            .withPrincipalKey(s => s.id)
            .onDelete('set null')
            .isRequired();    // isMandatory=true → INNER JOIN
        });
      }
    }

    const client = createFreshClient();
    const db = new MandatoryDb(client, { logQueries: false, logParameters: false });

    try {
      await cleanupSchema(client);
      await db.getSchemaManager().ensureCreated();

      const [seg] = await db.segments.insertBulk([
        { name: 'Active', active: true  },
      ]).returning();
      await db.segmentProducts.insertBulk([
        { title: 'Matched', segmentId: seg.id },
      ]);

      const results = await db.segmentProducts
        .where(p => eq(p.segment!.active, true))
        .select(p => ({ title: p.title }))
        .toList();

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Matched');
    } finally {
      await cleanupSchema(client);
      await db.dispose();
    }
  });
});
