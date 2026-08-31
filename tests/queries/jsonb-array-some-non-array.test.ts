import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, jsonb, eq, and, jsonbArraySome } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * `jsonbArraySome` must tolerate rows whose JSONB column does NOT hold an array.
 *
 * `jsonb_array_elements()` is strict: handed an object it raises
 * `cannot extract elements from an object`, handed a scalar
 * `cannot extract elements from a scalar`. Because the generated EXISTS runs
 * per candidate row, ONE malformed row anywhere in the scanned set aborts the
 * whole statement — a query that should simply not match that row instead
 * fails outright, taking the caller down with it.
 *
 * A JSONB column is schema-less by definition: nothing in PostgreSQL stops a
 * migration, a hand-fix, or a double-encoding bug from parking `{}` or `"x"`
 * in a column the application believes is an array. The predicate must answer
 * "no match" for those rows, exactly as it already does for SQL NULL.
 */

interface ShelfTag {
  kind: string;
  code: string;
}

class Shelf extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  tags?: DbColumn<any>;
}

class ShelfTestDatabase extends DbContext {
  get shelves(): DbEntityTable<Shelf> {
    return this.table(Shelf);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(Shelf, entity => {
      entity.toTable('jsonb_guard_shelf_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'jsonb_guard_shelf_test_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 100)).isRequired();
      entity.property(e => e.tags).hasType(jsonb('tags'));
    });
  }
}

describe('jsonbArraySome — non-array JSONB values', () => {
  let db: ShelfTestDatabase;

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();

    const client = createFreshClient();
    db = new ShelfTestDatabase(client);

    await client.query(`DROP TABLE IF EXISTS jsonb_guard_shelf_test CASCADE`);
    await db.getSchemaManager().ensureCreated();

    // Every row is written as raw SQL with an explicit ::jsonb cast. The
    // malformed shapes below cannot be expressed through the ORM at all (the
    // column is typed as an array) — which is exactly why a database can still
    // end up holding them — and writing the well-formed rows the same way keeps
    // this test about the READ path only, free of driver array-encoding
    // differences between the pg / postgres / bun clients.
    const insert = (label: string, tagsJson: string) =>
      client.query(`INSERT INTO jsonb_guard_shelf_test (label, tags) VALUES ('${label}', ${tagsJson})`);

    await insert('matching-array', `'[{"kind":"fiction","code":"AAA"},{"kind":"poetry","code":"BBB"}]'::jsonb`);
    await insert('non-matching-array', `'[{"kind":"poetry","code":"CCC"}]'::jsonb`);
    await insert('sql-null', `NULL`);
    await insert('empty-array', `'[]'::jsonb`);
    await insert('object', `'{}'::jsonb`);
    await insert('populated-object', `'{"kind":"fiction"}'::jsonb`);
    await insert('scalar-string', `'"fiction"'::jsonb`);
    await insert('scalar-number', `'42'::jsonb`);
    await insert('json-null', `'null'::jsonb`);
  });

  afterAll(async () => {
    await (db as any).client.query(`DROP TABLE IF EXISTS jsonb_guard_shelf_test CASCADE`);
    await db.dispose();
  });

  test('matches array rows without erroring on object/scalar rows', async () => {
    const results = await db.shelves
      .where(s => jsonbArraySome<ShelfTag>(s.tags, t => eq(t.kind, 'fiction')))
      .toList();

    expect(results.map(r => r.label)).toEqual(['matching-array']);
  });

  test('nested predicate is unaffected by malformed rows', async () => {
    const results = await db.shelves
      .where(s => jsonbArraySome<ShelfTag>(s.tags, t => and(
        eq(t.kind, 'fiction'),
        eq(t.code, 'AAA'),
      )))
      .toList();

    expect(results.map(r => r.label)).toEqual(['matching-array']);
  });

  test('a predicate matching nothing returns no rows rather than raising', async () => {
    const results = await db.shelves
      .where(s => jsonbArraySome<ShelfTag>(s.tags, t => eq(t.kind, 'no-such-kind')))
      .toList();

    expect(results).toEqual([]);
  });

  test('malformed rows stay invisible even when the object carries the sought key', async () => {
    // 'populated-object' holds {"kind":"fiction"} — the RIGHT key/value, but as
    // an object rather than a one-element array. It must not match: the
    // predicate asks about array ELEMENTS.
    const results = await db.shelves
      .where(s => jsonbArraySome<ShelfTag>(s.tags, t => eq(t.kind, 'fiction')))
      .toList();

    expect(results.map(r => r.label)).not.toContain('populated-object');
  });
});
