import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  bigint, boolean as pgBoolean, cast, caseOf, caseWhen, char, createCustomType, date, DbColumn, DbContext, DbCteBuilder, DbEntity,
  DbEntityTable, DbModelConfig, enumColumn, eq, fromSet, greatest, integer, jsonb, nullIf, numeric, pgEnum, serial, smallint, sql, text,
  timestamp, timestamptz, unnestZip, uuid, varchar,
} from '../../src';
import type { DatabaseClient, PgCastType } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * `insertFrom`'s map writes an EXPRESSION as a column's value: it is cast to the column's type,
 *
 *   INSERT INTO t ("ts") SELECT CAST(CASE WHEN … THEN CAST($1 AS text) ELSE NULL END AS timestamp) FROM (…) AS "src"
 *
 * — an expression's type is what PostgreSQL resolves for it (a CASE of string values is text), and a text value
 * is not assignable to a timestamp, a uuid, an enum, a number, a jsonb or an array column (42804 "column … is of
 * type … but expression is of type text"). A string column takes any value (every type assigns to text), so its
 * expressions render as they did; a source ref and a plain value render as they did (a plain value already binds
 * cast to the column's type).
 *
 * The matrix: every column type × every kind of expression (CASE, simple CASE, GREATEST, NULLIF, an `sql`
 * expression, a bare `sql` parameter, an explicit cast) × the value as a JS string and in its native JS type × two
 * sources × executed and compiled as a data-modifying CTE. The ORACLE is the same value inserted as a plain value
 * through the column's mapper (`insertBulk`): both rows read back equal. The SQL is the expression as it rendered
 * before — wrapped in `CAST(… AS <the column's type>)` for every column that is not a string column.
 */

type Level = 'low' | 'high';

/** smallint ↔ level name; an expression writes the DRIVER value (the mapper binds plain values only) */
const levelMapper = createCustomType<{ data: Level; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Level | null | undefined) => (value == null ? null : value === 'high' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'high' : 'low'),
});

const shadeEnum = pgEnum('xc_shade', ['light', 'dark'] as const);

class XcTarget extends DbEntity {
  id!: DbColumn<number>;
  ts?: DbColumn<Date | null>;
  tstz?: DbColumn<Date | null>;
  day?: DbColumn<Date | null>;
  num?: DbColumn<number | null>;
  small?: DbColumn<number | null>;
  big?: DbColumn<string | null>;
  dec?: DbColumn<string | null>;
  flag?: DbColumn<boolean | null>;
  token?: DbColumn<string | null>;
  doc?: DbColumn<unknown>;
  shade?: DbColumn<'light' | 'dark' | null>;
  label?: DbColumn<string | null>;
  short?: DbColumn<string | null>;
  fixed?: DbColumn<string | null>;
  ints?: DbColumn<number[] | null>;
  level?: DbColumn<Level | null>;
}

class XcSource extends DbEntity {
  id!: DbColumn<number>;
  flag!: DbColumn<boolean>;
  label!: DbColumn<string>;
}

class ExpressionCastDatabase extends DbContext {
  get targets(): DbEntityTable<XcTarget> {
    return this.table(XcTarget);
  }

  get sources(): DbEntityTable<XcSource> {
    return this.table(XcSource);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(XcTarget, entity => {
      entity.toTable('xc_targets');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.ts).hasType(timestamp('ts'));
      entity.property(e => e.tstz).hasType(timestamptz('tstz'));
      entity.property(e => e.day).hasType(date('day'));
      entity.property(e => e.num).hasType(integer('num'));
      entity.property(e => e.small).hasType(smallint('small'));
      entity.property(e => e.big).hasType(bigint('big'));
      entity.property(e => e.dec).hasType(numeric('dec', 12, 3));
      entity.property(e => e.flag).hasType(pgBoolean('flag'));
      entity.property(e => e.token).hasType(uuid('token'));
      entity.property(e => e.doc).hasType(jsonb('doc'));
      entity.property(e => e.shade).hasType(enumColumn('shade', shadeEnum));
      entity.property(e => e.label).hasType(text('label'));
      entity.property(e => e.short).hasType(varchar('short', 16));
      entity.property(e => e.fixed).hasType(char('fixed', 4));
      entity.property(e => e.ints).hasType(integer('ints').array());
      entity.property(e => e.level).hasType(smallint('level')).hasCustomMapper(levelMapper);
    });

    model.entity(XcSource, entity => {
      entity.toTable('xc_sources');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.flag).hasType(pgBoolean('flag')).isRequired();
      entity.property(e => e.label).hasType(text('label')).isRequired();
    });
  }
}

type Column = keyof Omit<XcTarget, 'id'>;

interface ColumnCase {
  column: Column;
  /** The type the expression is cast to — the cast a plain value of the column gets; undefined: a string column */
  castType?: string;
  /** The value in each form: its JS string, and its native JS type where it has one */
  forms: Array<{ form: 'string' | 'native'; value: unknown; other: unknown }>;
  /** The same value as a plain value of the column (bound through its mapper by insertBulk) */
  oracle: unknown;
}

const COLUMNS: ColumnCase[] = [
  { column: 'ts', castType: 'timestamp', forms: [{ form: 'string', value: '2026-03-04 05:06:07', other: '1999-01-01 00:00:00' }], oracle: '2026-03-04 05:06:07' },
  {
    column: 'tstz',
    castType: 'timestamptz',
    forms: [
      { form: 'string', value: '2026-03-04 05:06:07+00', other: '1999-01-01 00:00:00+00' },
      { form: 'native', value: new Date(Date.UTC(2026, 2, 4, 5, 6, 7)), other: new Date(Date.UTC(1999, 0, 1)) },
    ],
    oracle: new Date(Date.UTC(2026, 2, 4, 5, 6, 7)),
  },
  { column: 'day', castType: 'date', forms: [{ form: 'string', value: '2026-03-04', other: '1999-01-01' }], oracle: '2026-03-04' },
  { column: 'num', castType: 'integer', forms: [{ form: 'string', value: '42', other: '0' }, { form: 'native', value: 42, other: 0 }], oracle: 42 },
  { column: 'small', castType: 'smallint', forms: [{ form: 'string', value: '7', other: '0' }, { form: 'native', value: 7, other: 0 }], oracle: 7 },
  {
    column: 'big',
    castType: 'bigint',
    forms: [{ form: 'string', value: '9007199254740993', other: '0' }, { form: 'native', value: 1234, other: 0 }],
    oracle: undefined, // per form: see oracleOf
  },
  { column: 'dec', castType: 'numeric', forms: [{ form: 'string', value: '12.345', other: '0' }, { form: 'native', value: 12.5, other: 0 }], oracle: undefined },
  { column: 'flag', castType: 'boolean', forms: [{ form: 'string', value: 'true', other: 'false' }, { form: 'native', value: true, other: false }], oracle: true },
  {
    column: 'token',
    castType: 'uuid',
    forms: [{ form: 'string', value: '6f1c2a5e-8f3b-4c2d-9e1a-2b3c4d5e6f70', other: '00000000-0000-0000-0000-000000000000' }],
    oracle: '6f1c2a5e-8f3b-4c2d-9e1a-2b3c4d5e6f70',
  },
  {
    column: 'doc',
    castType: 'jsonb',
    forms: [{ form: 'string', value: '{"a": [1, 2]}', other: '{}' }, { form: 'native', value: { a: [1, 2] }, other: { b: 1 } }],
    oracle: '{"a": [1, 2]}',
  },
  { column: 'shade', castType: 'xc_shade', forms: [{ form: 'string', value: 'dark', other: 'light' }], oracle: 'dark' },
  { column: 'label', forms: [{ form: 'string', value: '0042', other: 'zzz' }], oracle: '0042' },
  { column: 'short', forms: [{ form: 'string', value: 'abc', other: 'zzz' }], oracle: 'abc' },
  { column: 'fixed', forms: [{ form: 'string', value: 'ab', other: 'zz' }], oracle: 'ab' },
  { column: 'ints', castType: 'integer[]', forms: [{ form: 'string', value: '{1,2,3}', other: '{}' }], oracle: [1, 2, 3] },
  { column: 'level', castType: 'smallint', forms: [{ form: 'string', value: '2', other: '1' }, { form: 'native', value: 2, other: 1 }], oracle: 'high' },
];

/** The plain value the oracle row binds: the same value, in the form the column's own binding takes */
const oracleOf = (c: ColumnCase, value: unknown): unknown => (c.column === 'big' || c.column === 'dec' ? value : c.oracle);

type ExpressionKind = 'caseWhen' | 'caseWhen-else' | 'caseOf' | 'greatest' | 'nullIf' | 'sql-expression' | 'sql-parameter' | 'cast';

const EXPRESSIONS: ExpressionKind[] = ['caseWhen', 'caseWhen-else', 'caseOf', 'greatest', 'nullIf', 'sql-expression', 'sql-parameter', 'cast'];

/** `kind` of `value` over the source row; undefined where the kind does not apply to the value's form */
function expressionOf(kind: ExpressionKind, src: any, value: unknown, other: unknown, c: ColumnCase): unknown {
  switch (kind) {
    case 'caseWhen':
      return caseWhen(eq(src.flag, true), value).else(null);
    case 'caseWhen-else':
      return caseWhen(eq(src.flag, false), other).else(value);
    case 'caseOf':
      return caseOf(src.flag).when(true, value).else(null);
    case 'greatest':
      // the larger of the value and itself: the value
      return greatest(value, value);
    case 'nullIf':
      return nullIf(value, other);
    case 'sql-expression':
      return typeof value === 'string' ? sql`(${value} || '')` : undefined;
    case 'sql-parameter':
      return sql`${value}`;
    case 'cast':
      return cast(value as any, (c.castType ?? 'text') as PgCastType);
  }
}

type SourceKind = 'entity' | 'set';
type Terminal = 'returning' | 'statement';

describe('insertFrom casts an expression to its column\'s type', () => {
  let client: DatabaseClient;
  let db: ExpressionCastDatabase;
  const captured: string[] = [];

  const sourceOf = (kind: SourceKind, target: ExpressionCastDatabase = db) => (kind === 'entity'
    ? target.sources.where(s => eq(s.id, 1)).select(s => ({ flag: s.flag, label: s.label })).asSubquery('table')
    : fromSet(unnestZip({ flag: { values: [true], type: 'boolean' }, label: { values: ['x'], type: 'text' } }), 'one')
      .select(o => ({ flag: o.flag, label: o.label }))
      .asSubquery('table'));

  /** The SELECT-list item of a compiled insertFrom of ONE column */
  const selectItem = (statementSql: string): string => {
    const start = statementSql.indexOf(' SELECT ') + ' SELECT '.length;

    return statementSql.slice(start, statementSql.indexOf(' FROM (', start));
  };

  const readColumn = async (column: Column, id: number, target: ExpressionCastDatabase = db) => {
    const rows = await target.targets.where(t => eq(t.id, id)).select(t => ({ v: (t as any)[column] })).toList();

    return rows[0].v;
  };

  const ROLLBACK = new Error('rolled back');

  /** Runs `body` in a transaction that is rolled back — no commit per statement, nothing left behind */
  const inRolledBackTransaction = async (body: (tx: ExpressionCastDatabase) => Promise<void>): Promise<void> => {
    try {
      await db.transaction(async tx => {
        await body(tx as ExpressionCastDatabase);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) {
        throw error;
      }
    }
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new ExpressionCastDatabase(client, {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS xc_targets, xc_sources CASCADE');
    await client.query('DROP TYPE IF EXISTS xc_shade CASCADE');
    await db.getSchemaManager().ensureCreated();
    await db.sources.insert({ flag: true, label: 'x' });
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS xc_targets, xc_sources CASCADE');
    await client.query('DROP TYPE IF EXISTS xc_shade CASCADE');
    await db.dispose();
  });

  describe('matrix: column × expression × value form × source × terminal', () => {
    for (const c of COLUMNS) {
      for (const { form, value, other } of c.forms) {
        for (const kind of EXPRESSIONS) {
          if (expressionOf(kind, { flag: { __dbColumnName: 'flag', __fieldName: 'flag' } }, value, other, c) === undefined) {
            continue;
          }

          for (const sourceKind of ['entity', 'set'] as SourceKind[]) {
            for (const terminal of ['returning', 'statement'] as Terminal[]) {
              test(`${String(c.column)} | ${kind} | ${form} | ${sourceKind} | ${terminal}`, async () => {
                await inRolledBackTransaction(async tx => {
                  const map = (src: any) => ({ [c.column]: expressionOf(kind, src, value, other, c) }) as any;
                  const insert = tx.targets.insertFrom(sourceOf(sourceKind, tx), map);
                  let insertedId: number;

                  if (terminal === 'returning') {
                    const rows = await insert.returning(t => ({ id: t.id }));
                    expect(rows).toHaveLength(1);
                    insertedId = rows[0].id;
                  } else {
                    const ins = new DbCteBuilder().withMutation('xc_ins', insert.toStatement(t => ({ id: t.id })));
                    const rows = await tx.selectFromCte(ins.cte).select(r => ({ id: r.id })).toList();
                    expect(rows).toHaveLength(1);
                    insertedId = rows[0].id;
                  }

                  // The oracle: the same value as a plain value of the column
                  const [oracleRow] = await tx.targets.insertBulk([{ [c.column]: oracleOf(c, value) } as any]).returning(t => ({ id: t.id }));
                  expect(await readColumn(c.column, insertedId, tx)).toEqual(await readColumn(c.column, oracleRow.id, tx));

                  // The SQL: the expression as it rendered before, cast to the column's type unless it is a string column
                  const item = selectItem(insert.toStatement().sql);
                  const asString = selectItem(tx.targets.insertFrom(sourceOf(sourceKind, tx), (src: any) => ({ label: expressionOf(kind, src, value, other, c) }) as any)
                    .toStatement().sql);

                  if (c.castType === undefined) {
                    expect(item).toBe(asString);
                  } else {
                    expect(item).toBe(`CAST(${asString} AS ${c.castType})`);
                  }
                });
              });
            }
          }
        }
      }
    }
  });

  describe('what is not an expression renders as before', () => {
    test('a source ref into any column and a plain value render as they did — one cast, the plain value\'s', () => {
      const statement = db.targets.insertFrom(
        db.sources.select(s => ({ id: s.id, flag: s.flag, label: s.label })).asSubquery('table'),
        src => ({ num: src.id, flag: src.flag, label: src.label, ts: '2026-01-01 00:00:00' as any, level: 'high' })
      ).toStatement().sql;

      expect(statement).toBe(
        'INSERT INTO "xc_targets" ("num", "flag", "label", "ts", "level") SELECT "src"."id", "src"."flag", "src"."label", '
        + 'CAST($1 AS timestamp), CAST($2 AS smallint) FROM (SELECT "xc_sources"."id" as "id", "xc_sources"."flag" as "flag", '
        + '"xc_sources"."label" as "label"\nFROM "xc_sources") AS "src"'
      );
    });
  });

  describe('engine parity', () => {
    test('a text expression assigned to a timestamp column is refused with 42804 on every engine; cast, it is stored', async () => {
      const refused = await expectToReject(client.query(
        'INSERT INTO xc_targets (ts) SELECT CASE WHEN true THEN CAST($1 AS text) ELSE NULL END',
        ['2026-03-04 05:06:07']
      ));
      expect(sqlStateOf(refused)).toBe('42804');

      const stored = await client.query(
        'INSERT INTO xc_targets (ts) SELECT CAST(CASE WHEN true THEN CAST($1 AS text) ELSE NULL END AS timestamp) RETURNING id',
        ['2026-03-04 05:06:07']
      );
      expect(stored.rows).toHaveLength(1);
    });
  });
});
