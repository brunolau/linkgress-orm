import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  bigint,
  boolean,
  bytea,
  createCustomType,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  integer,
  jsonb,
  serial,
  sql,
  text,
  timestamptz,
  varchar,
} from '../../src';
import { toPgArrayLiteral } from '../../src/types/custom-types';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * A native array column (`text('tags').array()`) binds a JS array as a PostgreSQL array LITERAL
 * (`{"a","b"}`), the one form every driver accepts: pg and postgres.js build the same array from a
 * JS array themselves, but Bun's SQL client cannot bind a JS array to an array parameter at all
 * (prepared: "insufficient data left in message"; text mode: `1,2,3` without braces). The column
 * gets that as its default mapper; a mapper of its own replaces it.
 *
 * What was stored is read back through its PostgreSQL TEXT form (and element functions), which is
 * the same whichever driver decodes the result.
 */

class ArrayRow extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  tags?: DbColumn<string[] | null>;
  slots?: DbColumn<number[] | null>;
  big?: DbColumn<Array<bigint | number | string> | null>;
  flags?: DbColumn<boolean[] | null>;
  moments?: DbColumn<Date[] | null>;
  blobs?: DbColumn<Uint8Array[] | null>;
  docs?: DbColumn<object[] | null>;
  grid?: DbColumn<number[][] | null>;
  piped?: DbColumn<string | null>;
}

/** A property kept as "a|b" and stored as text[] — a column mapper of its own on an array column. */
const pipedText = createCustomType<{ data: string; driverData: string[] }>({
  dataType: () => 'text[]',
  toDriver: (value: string | null | undefined) => (value == null ? null : toPgArrayLiteral(value.split('|')) as any),
  fromDriver: (value: string[] | null | undefined) => (value == null ? null : value.join('|')) as any,
});

class ArrayDatabase extends DbContext {
  get rows(): DbEntityTable<ArrayRow> {
    return this.table(ArrayRow);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(ArrayRow, entity => {
      entity.toTable('array_binding_rows');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.label).hasType(varchar('label', 64)).isRequired();
      entity.property(e => e.tags).hasType(text('tags').array());
      entity.property(e => e.slots).hasType(integer('slots').array());
      entity.property(e => e.big).hasType(bigint('big').array());
      entity.property(e => e.flags).hasType(boolean('flags').array());
      entity.property(e => e.moments).hasType(timestamptz('moments').array());
      entity.property(e => e.blobs).hasType(bytea('blobs').array());
      entity.property(e => e.docs).hasType(jsonb('docs').array());
      entity.property(e => e.grid).hasType(integer('grid').array());
      entity.property(e => e.piped).hasType(text('piped').array()).hasCustomMapper(pipedText);
    });
  }
}

/** Strings with every character an array literal has to escape. */
const NASTY = ['plain', 'with,comma', 'with "quote"', 'back\\slash', '{braces}', ' spaced ', 'NULL', '', 'ěšč 🎿'];

describe('native array columns', () => {
  let client: DatabaseClient;
  let db: ArrayDatabase;

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new ArrayDatabase(client);
    await client.query('DROP TABLE IF EXISTS array_binding_rows CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS array_binding_rows CASCADE');
    await db.dispose();
  });

  /** The PostgreSQL text of each array column of the row labelled `label`. */
  const stored = async (label: string) => {
    const [row] = await db.rows
      .where(r => eq(r.label, label))
      .select(r => ({
        tags: sql<string | null>`CAST(${r.tags} AS text)`,
        slots: sql<string | null>`CAST(${r.slots} AS text)`,
        big: sql<string | null>`CAST(${r.big} AS text)`,
        flags: sql<string | null>`CAST(${r.flags} AS text)`,
        grid: sql<string | null>`CAST(${r.grid} AS text)`,
        piped: sql<string | null>`CAST(${r.piped} AS text)`,
        tagCount: sql<number | null>`array_length(${r.tags}, 1)`,
      }))
      .toList();

    return row;
  };

  test('insert: strings with every escaped character, NULL elements, empty arrays', async () => {
    await db.rows.insert({ label: 'nasty', tags: NASTY, slots: [], flags: [true, false, null as any] });

    const row = await stored('nasty');
    const elements = await db.rows
      .where(r => eq(r.label, 'nasty'))
      .select(r => ({ third: sql<string>`(${r.tags})[3]`, fourth: sql<string>`(${r.tags})[4]`, seventh: sql<string>`(${r.tags})[7]`, last: sql<string>`(${r.tags})[9]` }))
      .toList();

    expect(row.tagCount).toBe(NASTY.length);
    expect(elements[0]).toEqual({ third: 'with "quote"', fourth: 'back\\slash', seventh: 'NULL', last: 'ěšč 🎿' });
    expect(row.slots).toBe('{}');
    expect(row.flags).toBe('{t,f,NULL}');
  });

  test('insertBulk, numbers and bigints beyond float precision', async () => {
    await db.rows.insertBulk([
      { label: 'bulk-1', slots: [1, -2, 3], big: [9007199254740993n, '-42', 7] },
      { label: 'bulk-2', slots: [0], big: [] },
    ]);

    expect((await stored('bulk-1')).slots).toBe('{1,-2,3}');
    expect((await stored('bulk-1')).big).toBe('{9007199254740993,-42,7}');
    expect((await stored('bulk-2')).big).toBe('{}');
  });

  test('a two-dimensional array', async () => {
    await db.rows.insert({ label: 'grid', grid: [[1, 2], [3, 4]] });

    expect((await stored('grid')).grid).toBe('{{1,2},{3,4}}');
  });

  test('Dates, bytes and JSON objects as elements', async () => {
    const at = new Date('2024-03-10T23:30:00.000Z');
    await db.rows.insert({
      label: 'typed',
      moments: [at, new Date('2025-01-01T00:00:00.000Z')],
      blobs: [new Uint8Array([0, 1, 255]), Buffer.from([0xab, 0xcd])],
      docs: [{ a: 1, s: 'x "y"' }, { list: [1, 2] }],
    });

    const [row] = await db.rows
      .where(r => eq(r.label, 'typed'))
      .select(r => ({
        firstEpoch: sql<number>`CAST(extract(epoch from (${r.moments})[1]) AS integer)`,
        firstBlob: sql<string>`encode((${r.blobs})[1], 'hex')`,
        secondBlob: sql<string>`encode((${r.blobs})[2], 'hex')`,
        firstDoc: sql<string>`CAST((${r.docs})[1] AS text)`,
        secondDocType: sql<string>`jsonb_typeof((${r.docs})[2] -> 'list')`,
      }))
      .toList();

    expect(Number(row.firstEpoch)).toBe(at.getTime() / 1000);
    expect(row.firstBlob).toBe('0001ff');
    expect(row.secondBlob).toBe('abcd');
    expect(row.firstDoc).toBe('{"a": 1, "s": "x \\"y\\""}');
    expect(row.secondDocType).toBe('array');
  });

  test('update, upsert, upsertBulk, bulkUpdate and mergeBulk bind the literal too', async () => {
    const inserted = await db.rows.insert({ label: 'writes', tags: ['a'] }).returning(r => ({ id: r.id }));

    await db.rows.where(r => eq(r.id, inserted.id)).update({ tags: ['updated', 'x,y'] });
    expect((await stored('writes')).tags).toBe('{updated,"x,y"}');

    await db.rows.upsert([{ id: inserted.id, label: 'writes', tags: ['upserted'] }] as any, { primaryKey: 'id' });
    expect((await stored('writes')).tags).toBe('{upserted}');

    await db.rows.upsertBulk([{ id: inserted.id, label: 'writes', tags: ['upserted', 'bulk'] }] as any, { primaryKey: 'id' });
    expect((await stored('writes')).tags).toBe('{upserted,bulk}');

    await db.rows.bulkUpdate([{ id: inserted.id, tags: ['bulk-updated'] }] as any);
    expect((await stored('writes')).tags).toBe('{bulk-updated}');

    await db.rows.mergeBulk([{ label: 'writes', tags: ['merged', '"q"'] }], { on: 'label', updateColumns: ['tags'] });
    expect((await stored('writes')).tags).toBe('{merged,"\\"q\\""}');
  });

  test('a condition comparing the column to an array binds the literal', async () => {
    await db.rows.insert({ label: 'where', tags: ['p', 'q,r'] });

    const found = await db.rows.where(r => eq(r.tags, ['p', 'q,r'] as any)).select(r => r.label).toList();

    expect(found).toEqual(['where']);
  });

  test('NULL binds as NULL; an sql fragment assigned in an update renders as SQL', async () => {
    await db.rows.insert({ label: 'null-and-sql', tags: null });
    await db.rows.where(r => eq(r.label, 'null-and-sql')).update({ slots: sql`ARRAY[4, 5]` as any });

    const row = await stored('null-and-sql');

    // (an sql projection reads a NULL as undefined)
    expect(row.tags ?? null).toBeNull();
    expect(row.slots).toBe('{4,5}');
  });

  test('a mapper of the column\'s own replaces the default', async () => {
    await db.rows.insert({ label: 'piped', piped: 'a|b,c|d' });

    const [read] = await db.rows.where(r => eq(r.label, 'piped')).select(r => ({ piped: r.piped })).toList();

    expect((await stored('piped')).piped).toBe('{a,"b,c",d}');
    expect(read.piped).toBe('a|b,c|d');
  });
});

describe('toPgArrayLiteral', () => {
  test('numbers, bigints, booleans, NULL', () => {
    expect(toPgArrayLiteral([1, -2.5, 9007199254740993n, true, false, null, undefined])).toBe('{1,-2.5,9007199254740993,t,f,NULL,NULL}');
  });

  test('strings are quoted, their quotes and backslashes escaped', () => {
    expect(toPgArrayLiteral(['a', 'b,c', 'd"e', 'f\\g', '', 'NULL'])).toBe('{"a","b,c","d\\"e","f\\\\g","","NULL"}');
  });

  test('nested arrays are a multidimensional literal', () => {
    expect(toPgArrayLiteral([[1, 2], [3, null]])).toBe('{{1,2},{3,NULL}}');
    expect(toPgArrayLiteral([])).toBe('{}');
  });

  test('a Date is its ISO instant', () => {
    expect(toPgArrayLiteral([new Date('2024-03-10T23:30:00.000Z')])).toBe('{"2024-03-10T23:30:00.000Z"}');
  });

  test('bytes are the bytea hex form', () => {
    expect(toPgArrayLiteral([new Uint8Array([0, 15, 255])])).toBe('{"\\\\x000fff"}');
    expect(toPgArrayLiteral([Buffer.from('A')])).toBe('{"\\\\x41"}');
    expect(toPgArrayLiteral([new Uint8Array([1, 2]).buffer])).toBe('{"\\\\x0102"}');
  });

  test('a view over part of a buffer reads only its own bytes', () => {
    const backing = new Uint8Array([9, 1, 2, 9]);

    expect(toPgArrayLiteral([new Uint8Array(backing.buffer, 1, 2)])).toBe('{"\\\\x0102"}');
  });

  test('a plain object is its JSON text', () => {
    expect(toPgArrayLiteral([{ a: 1, s: 'x"y' }])).toBe('{"{\\"a\\":1,\\"s\\":\\"x\\\\\\"y\\"}"}');
  });

  test('a value class is its own string form', () => {
    class Code {
      toString(): string {
        return 'C-1';
      }
    }

    expect(toPgArrayLiteral([new Code()])).toBe('{"C-1"}');
  });
});
