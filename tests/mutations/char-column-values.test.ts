import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { char, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, integer, literal, MutationBatch, serial, text } from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * A `char(n)` column through every builder that casts a bound value to the column's type — `insertFrom`'s SELECT
 * list, a row-guarded `MutationBatch` leg, `insertWithChildren`, `bulkUpdate` and `mergeBulk` (VALUES cells):
 * the cast type carries no typmod (`bpchar`, not `char` = `character(1)`, which truncates silently), so the value
 * keeps all its characters, a short one is padded and an over-long one raises 22001 — exactly like
 * `INSERT … VALUES`.
 */

class CcCode extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
  label!: DbColumn<string>;
  n!: DbColumn<number>;
}

class CcLine extends DbEntity {
  id!: DbColumn<number>;
  codeId!: DbColumn<number>;
  tag!: DbColumn<string>;
}

class CharColumnDatabase extends DbContext {
  get codes(): DbEntityTable<CcCode> {
    return this.table(CcCode);
  }

  get lines(): DbEntityTable<CcLine> {
    return this.table(CcLine);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(CcCode, entity => {
      entity.toTable('cc_codes');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.code).hasType(char('code', 6)).isRequired();
      entity.property(e => e.label).hasType(text('label')).isRequired();
      entity.property(e => e.n).hasType(integer('n')).isRequired();
    });
    model.entity(CcLine, entity => {
      entity.toTable('cc_lines');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.codeId).hasType(integer('code_id')).isRequired();
      entity.property(e => e.tag).hasType(char('tag', 4)).isRequired();
    });
  }
}

describe('char(n) columns keep their value through cast-typed VALUES and SELECT lists', () => {
  let client: DatabaseClient;
  let db: CharColumnDatabase;
  const captured: string[] = [];

  const lastStatement = (fragment: string): string => {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].includes(fragment)) {
        return captured[i];
      }
    }
    throw new Error(`No captured statement contains ${fragment}`);
  };

  const codeOf = async (label: string): Promise<string | undefined> =>
    (await db.codes.where(c => eq(c.label, label)).select(c => ({ code: c.code })).toList())[0]?.code;

  /** a one-row table source for insertFrom: the n of the seeded row */
  const seedSource = () => db.codes.where(c => eq(c.label, 'seed')).select(c => ({ n: c.n })).asSubquery('table');

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new CharColumnDatabase(client, {
      logQueries: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS cc_lines CASCADE');
    await client.query('DROP TABLE IF EXISTS cc_codes CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS cc_lines CASCADE');
    await client.query('DROP TABLE IF EXISTS cc_codes CASCADE');
    await db.dispose();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE cc_lines, cc_codes RESTART IDENTITY');
    await db.codes.insert({ code: 'ABCDEF', label: 'seed', n: 1 });
    captured.length = 0;
  });

  test('INSERT … VALUES (the reference): the full value', async () => {
    expect(await codeOf('seed')).toBe('ABCDEF');
  });

  test('insertFrom: the plain value is cast to bpchar — kept whole, a short one padded, an over-long one 22001', async () => {
    await db.codes.insertFrom(seedSource(), s => ({ code: 'GHIJKL', label: 'via insertFrom', n: s.n }));

    expect(lastStatement('INSERT INTO')).toContain('SELECT CAST($2 AS bpchar), CAST($3 AS text), "src"."n" FROM (');
    expect(await codeOf('via insertFrom')).toBe('GHIJKL');

    await db.codes.insertFrom(seedSource(), s => ({ code: 'GH', label: 'short via insertFrom', n: s.n }));
    expect(await codeOf('short via insertFrom')).toBe('GH    ');

    const error = await expectToReject(db.codes.insertFrom(seedSource(), s => ({ code: 'GHIJKLMN', label: 'long', n: s.n })));
    expect(sqlStateOf(error)).toBe('22001');
  });

  test('a row-guarded MutationBatch leg: $n::bpchar cells', async () => {
    const batch = new MutationBatch();
    batch.addInsertBulk(db.codes, [{ code: 'MNOPQR', label: 'via guarded leg', n: 2 }], 'g', { rowGuard: v => eq(v.n, literal(2)) });
    await batch.executeBatch();

    expect(lastStatement('INSERT INTO')).toContain('(VALUES ($1::bpchar, $2::text, $3::integer))');
    expect(await codeOf('via guarded leg')).toBe('MNOPQR');

    const tooLong = new MutationBatch();
    tooLong.addInsertBulk(db.codes, [{ code: 'MNOPQRST', label: 'long', n: 2 }], 'g', { rowGuard: v => eq(v.n, literal(2)) });
    expect(sqlStateOf(await expectToReject(tooLong.executeBatch()))).toBe('22001');
  });

  test('insertWithChildren: the parent and the child char(n) values are kept', async () => {
    const result = await db.codes.insertWithChildren({
      row: { code: 'STUVWX', label: 'via insertWithChildren', n: 3 },
      children: { table: db.lines, foreignKey: 'codeId', rows: [{ tag: 'WXYZ' }, { tag: 'AB' }] },
      returning: { parent: c => ({ code: c.code }), children: l => ({ tag: l.tag }) },
    });

    expect(result.parent).toEqual({ code: 'STUVWX' });
    expect(result.children).toEqual([{ tag: 'WXYZ' }, { tag: 'AB  ' }]);
    expect(await codeOf('via insertWithChildren')).toBe('STUVWX');
  });

  test('bulkUpdate: $n::bpchar cells — kept whole, an over-long one 22001', async () => {
    await db.codes.bulkUpdate([{ id: 1, code: 'ZYXWVU' }]);

    expect(lastStatement('UPDATE')).toContain('$2::bpchar');
    expect(await codeOf('seed')).toBe('ZYXWVU');

    expect(sqlStateOf(await expectToReject(db.codes.bulkUpdate([{ id: 1, code: 'ZYXWVUTS' }])))).toBe('22001');
    expect(await codeOf('seed')).toBe('ZYXWVU');
  });

  test('mergeBulk: the first row\'s cells cast to bpchar — kept whole on insert and on update', async () => {
    await db.codes.mergeBulk([{ code: 'QRSTUV', label: 'via mergeBulk', n: 40 }], { on: ['n'] });

    expect(lastStatement('MERGE INTO')).toContain('$1::bpchar');
    expect(await codeOf('via mergeBulk')).toBe('QRSTUV');

    await db.codes.mergeBulk([{ code: 'VUTSRQ', label: 'via mergeBulk', n: 40 }], { on: ['n'] });
    expect(await codeOf('via mergeBulk')).toBe('VUTSRQ');
  });
});
