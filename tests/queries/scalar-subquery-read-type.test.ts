import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  bigint, boolean as pgBoolean, char, createCustomType, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig,
  enumColumn, eq, fromSet, integer, jsonb, numeric, pgEnum, QueryBatch, serial, smallint, sql, text, timestamp, unnest, uuid, varchar,
} from '../../src';
import type { DatabaseClient, PgCastType } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * A SCALAR subquery that projects ONE column — `….select(m => m.code).asSubquery('scalar')` — reads like that
 * column: a text column's digits-only value stays the string it is ('0042', never the number 42), a mapped column
 * reads through its mapper, a numeric column reads as before. It used to read like a raw `sql` fragment: every
 * numeric-looking string became a number, a mapped column came back as its stored value.
 *
 * The matrix: every builder a scalar subquery comes from (an entity query projecting the column or an object of
 * it, a navigation column, a CTE-rooted query, a set, a grouped query's key and aggregate, a union) × every place
 * it is projected (an entity query, a nested object, a CTE-rooted query, a set query, a QueryBatch, a CTE body
 * read back through `selectFromCte`; a grouped query refuses a subquery in its projection) × column kinds (text / varchar / char / uuid / enum /
 * jsonb holding digits-only text, a mapped column, integer, bigint, numeric, timestamp, boolean). The ORACLE is
 * the column's own value, read directly.
 */

type Tier = 'bronze' | 'gold';

const tierMapper = createCustomType<{ data: Tier; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Tier | null | undefined) => (value == null ? null : value === 'gold' ? 2 : 1) as number,
  fromDriver: (value: any) => (value == null ? value : Number(value) === 2 ? 'gold' : 'bronze'),
});

const moodEnum = pgEnum('ssr_mood', ['calm', 'busy'] as const);

class SsrGroup extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
  motto!: DbColumn<string>;
  rank!: DbColumn<number>;
}

class SsrMember extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
  ref!: DbColumn<string>;
  pin!: DbColumn<string>;
  qty!: DbColumn<number>;
  big!: DbColumn<string>;
  amount!: DbColumn<string>;
  token!: DbColumn<string>;
  mood!: DbColumn<'calm' | 'busy'>;
  tier!: DbColumn<Tier>;
  seenAt!: DbColumn<Date>;
  flag!: DbColumn<boolean>;
  doc!: DbColumn<unknown>;
  groupId!: DbColumn<number>;

  group?: SsrGroup;
}

class ScalarReadDatabase extends DbContext {
  get groups(): DbEntityTable<SsrGroup> {
    return this.table(SsrGroup);
  }

  get members(): DbEntityTable<SsrMember> {
    return this.table(SsrMember);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SsrGroup, entity => {
      entity.toTable('ssr_groups');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.label).hasType(text('label')).isRequired();
      entity.property(e => e.motto).hasType(varchar('motto', 20)).isRequired();
      entity.property(e => e.rank).hasType(integer('rank')).isRequired();
    });

    model.entity(SsrMember, entity => {
      entity.toTable('ssr_members');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.code).hasType(text('code')).isRequired();
      entity.property(e => e.ref).hasType(varchar('ref', 12)).isRequired();
      entity.property(e => e.pin).hasType(char('pin', 4)).isRequired();
      entity.property(e => e.qty).hasType(integer('qty')).isRequired();
      entity.property(e => e.big).hasType(bigint('big')).isRequired();
      entity.property(e => e.amount).hasType(numeric('amount', 10, 2)).isRequired();
      entity.property(e => e.token).hasType(uuid('token')).isRequired();
      entity.property(e => e.mood).hasType(enumColumn('mood', moodEnum)).isRequired();
      entity.property(e => e.tier).hasType(smallint('tier')).isRequired().hasCustomMapper(tierMapper);
      entity.property(e => e.seenAt).hasType(timestamp('seen_at')).isRequired();
      entity.property(e => e.flag).hasType(pgBoolean('flag')).isRequired();
      entity.property(e => e.doc).hasType(jsonb('doc')).isRequired();
      entity.property(e => e.groupId).hasType(integer('group_id')).isRequired();
      entity.hasOne(e => e.group, () => SsrGroup).withForeignKey(m => m.groupId).withPrincipalKey(g => g.id);
    });
  }
}

type MemberColumn = 'code' | 'ref' | 'pin' | 'qty' | 'big' | 'amount' | 'token' | 'mood' | 'tier' | 'seenAt' | 'flag' | 'doc';
type GroupColumn = 'label' | 'motto' | 'rank';

/** Member 1 — the row every subquery reads */
const SUBJECT = {
  code: '0042',
  ref: '0007',
  pin: '0123',
  qty: 42,
  big: '123',
  amount: '12.50',
  token: '00000000-0000-4000-8000-000000000042',
  mood: 'busy' as const,
  tier: 'gold' as Tier,
  seenAt: new Date(2026, 2, 4, 5, 6, 7),
  flag: true,
  doc: '0042',
};

/** What each column reads as: a text kind keeps its text, a mapped column maps, a numeric kind reads as a number (as before) */
const EXPECTED: Record<MemberColumn | GroupColumn, unknown> = {
  code: '0042',
  ref: '0007',
  pin: '0123',
  qty: 42,
  big: 123,
  amount: 12.5,
  token: SUBJECT.token,
  mood: 'busy',
  tier: 'gold',
  seenAt: SUBJECT.seenAt,
  flag: true,
  doc: '0042',
  label: '0099',
  motto: '0001',
  rank: 5,
};

/** The SQL type of each column, for a set source of the same values */
const SET_TYPES: Partial<Record<MemberColumn, PgCastType>> = {
  code: 'text', ref: 'varchar', qty: 'integer', big: 'bigint', amount: 'numeric', token: 'uuid', flag: 'boolean',
};

const MEMBER_COLUMNS: MemberColumn[] = ['code', 'ref', 'pin', 'qty', 'big', 'amount', 'token', 'mood', 'tier', 'seenAt', 'flag', 'doc'];
const GROUP_COLUMNS: GroupColumn[] = ['label', 'motto', 'rank'];
/** Columns with a max(): no uuid, boolean or jsonb */
const ORDERED: MemberColumn[] = ['code', 'ref', 'pin', 'qty', 'big', 'amount', 'mood', 'tier', 'seenAt'];

type Producer = 'entity-column' | 'entity-object' | 'navigation' | 'cte' | 'set' | 'grouped-key' | 'grouped-aggregate' | 'union';
type Consumer = 'entity' | 'nested' | 'cte-root' | 'set' | 'batch' | 'cte-column';

const PRODUCERS: Array<{ producer: Producer; columns: ReadonlyArray<MemberColumn | GroupColumn> }> = [
  { producer: 'entity-column', columns: MEMBER_COLUMNS },
  { producer: 'entity-object', columns: MEMBER_COLUMNS },
  { producer: 'navigation', columns: GROUP_COLUMNS },
  { producer: 'cte', columns: MEMBER_COLUMNS },
  { producer: 'set', columns: Object.keys(SET_TYPES) as MemberColumn[] },
  { producer: 'grouped-key', columns: MEMBER_COLUMNS },
  { producer: 'grouped-aggregate', columns: ORDERED },
  { producer: 'union', columns: MEMBER_COLUMNS },
];

const CONSUMERS: Consumer[] = ['entity', 'nested', 'cte-root', 'set', 'batch', 'cte-column'];

describe('a scalar subquery of one column reads like that column', () => {
  let client: DatabaseClient;
  let db: ScalarReadDatabase;

  /** The scalar subquery of `producer` over `column` of member 1 */
  const subqueryOf = (producer: Producer, column: MemberColumn | GroupColumn): any => {
    const subject = () => db.members.where(m => eq(m.id, 1));

    switch (producer) {
      case 'entity-column':
        return subject().select(m => (m as any)[column]).asSubquery('scalar');
      case 'entity-object':
        return subject().select(m => ({ v: (m as any)[column] })).asSubquery('scalar');
      case 'navigation':
        return subject().select(m => (m.group as any)[column]).asSubquery('scalar');
      case 'cte': {
        const all = new DbCteBuilder().with('ssr_all', db.members.select(m => ({
          id: m.id, code: m.code, ref: m.ref, pin: m.pin, qty: m.qty, big: m.big, amount: m.amount, token: m.token, mood: m.mood,
          tier: m.tier, seenAt: m.seenAt, flag: m.flag, doc: m.doc,
        })));

        return db.selectFromCte(all.cte).where(r => eq(r.id, 1)).select(r => (r as any)[column]).asSubquery('scalar');
      }
      case 'set':
        return fromSet(unnest([(SUBJECT as any)[column]], SET_TYPES[column as MemberColumn]!), 'u').select(u => u.value).asSubquery('scalar');
      case 'grouped-key':
        return (subject() as any).groupBy((m: any) => ({ k: m[column] })).select((g: any) => ({ v: g.key.k })).asSubquery('scalar');
      case 'grouped-aggregate':
        return (subject() as any).groupBy((m: any) => ({ id: m.id })).select((g: any) => ({ v: g.max((m: any) => m[column]) })).asSubquery('scalar');
      case 'union':
        return subject().select(m => (m as any)[column])
          .unionAll(db.members.where(m => eq(m.id, 0)).select(m => (m as any)[column]))
          .asSubquery('scalar');
    }
  };

  /** Member 2's query projecting the subquery, by `consumer` — the value read */
  const readThrough = async (consumer: Consumer, subquery: any): Promise<unknown> => {
    const outer = () => db.members.where(m => eq(m.id, 2));

    switch (consumer) {
      case 'entity':
        return (await outer().select(() => ({ v: subquery })).toList())[0].v;
      case 'nested':
        return (await outer().select(() => ({ n: { v: subquery } })).toList())[0].n.v;
      case 'cte-root': {
        const ids = new DbCteBuilder().with('ssr_ids', db.members.select(m => ({ id: m.id })));
        return (await db.selectFromCte(ids.cte).where(r => eq(r.id, 2)).select(() => ({ v: subquery })).toList())[0].v;
      }
      case 'set':
        return (await db.selectFromSet(unnest([1], 'integer'), 'one').select(() => ({ v: subquery })).toList())[0].v;
      case 'batch': {
        const batch = new QueryBatch();
        batch.addList(outer().select(() => ({ v: subquery })), 'rows');
        await batch.executeBatch();
        return batch.getList('rows')[0].v;
      }
      case 'cte-column': {
        const projected = new DbCteBuilder().with('ssr_projected', outer().select(() => ({ v: subquery })));
        return (await db.selectFromCte(projected.cte).select(r => ({ v: r.v })).toList())[0].v;
      }
    }
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new ScalarReadDatabase(client, { logQueries: false });
    await client.query('DROP TABLE IF EXISTS ssr_members, ssr_groups CASCADE');
    await client.query('DROP TYPE IF EXISTS ssr_mood CASCADE');
    await db.getSchemaManager().ensureCreated();

    await db.groups.insertBulk([{ label: '0099', motto: '0001', rank: 5 }, { label: 'other', motto: 'other', rank: 1 }]);
    await db.members.insertBulk([
      { ...SUBJECT, doc: JSON.stringify(SUBJECT.doc), groupId: 1 } as any,
      {
        code: 'zz', ref: 'zz', pin: 'zz', qty: 1, big: '1', amount: '1', token: '00000000-0000-4000-8000-000000000001', mood: 'calm', tier: 'bronze',
        seenAt: new Date(2020, 0, 1), flag: false, doc: JSON.stringify('x'), groupId: 2,
      } as any,
    ]);
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS ssr_members, ssr_groups CASCADE');
    await client.query('DROP TYPE IF EXISTS ssr_mood CASCADE');
    await db.dispose();
  });

  test('the oracle: each column read directly', async () => {
    const [direct] = await db.members.where(m => eq(m.id, 1)).select(m => ({
      code: m.code, ref: m.ref, pin: m.pin, qty: m.qty, token: m.token, mood: m.mood, tier: m.tier, seenAt: m.seenAt, flag: m.flag, doc: m.doc,
      label: m.group!.label, motto: m.group!.motto, rank: m.group!.rank,
    })).toList();

    expect({ ...direct }).toEqual({
      code: '0042', ref: '0007', pin: '0123', qty: 42, token: SUBJECT.token, mood: 'busy', tier: 'gold', seenAt: SUBJECT.seenAt, flag: true, doc: '0042',
      label: '0099', motto: '0001', rank: 5,
    });
  });

  describe('matrix: producer × consumer × column', () => {
    for (const { producer, columns } of PRODUCERS) {
      for (const consumer of CONSUMERS) {
        for (const column of columns) {
          test(`${producer} | ${consumer} | ${column}`, async () => {
            expect(await readThrough(consumer, subqueryOf(producer, column))).toEqual(EXPECTED[column]);
          });
        }
      }
    }
  });

  describe('as before', () => {
    test('NULL reads undefined at the top of a projection and null in a nested object', async () => {
      const none = () => db.members.where(m => eq(m.id, 0)).select(m => m.code).asSubquery('scalar');
      const [row] = await db.members.where(m => eq(m.id, 2)).select(() => ({ v: none(), n: { v: none() } })).toList();

      expect(row.v).toBeUndefined();
      expect(row.n.v).toBeNull();
    });

    test('a scalar subquery of an expression reads as before: raw, unless the expression declares its type', async () => {
      const expression = () => db.members.where(m => eq(m.id, 1));
      const [row] = await db.members.where(m => eq(m.id, 2)).select(() => ({
        raw: expression().select(m => sql<string>`${m.code} || ''`).asSubquery('scalar'),
        typed: expression().select(m => sql<string>`${m.code} || ''`.withReadType('text')).asSubquery('scalar'),
      })).toList();

      expect(row.raw as unknown).toBe(42);
      expect(row.typed).toBe('0042');
    });
  });
});
