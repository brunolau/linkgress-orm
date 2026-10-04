import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withDatabase, seedTestData, createFreshClient } from '../utils/test-database';
import {
  add, and, between, caseOf, caseWhen, coalesce, createCustomType, DatabaseClient, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable,
  DbModelConfig, div, eq, eqAny, exists, greatest, gt, gte, inArray, integer, least, lte, MockRowCache, mul, ne, not, nullIf, sql, sub,
  text, timestamp, varchar,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * WHERE the mapper of a collection item's column applies in 1.0.31 — and where it does not.
 *
 * It applies to exactly two things: a value compared DIRECTLY with the bare column inside `collection.where(...)`
 * (bound through `toDriver`), and `min()` / `max()` of the bare column (read through `fromDriver`) — see
 * collection-item-mappers.test.ts. The item's refs carry the mapper under a marker of their own
 * (`__itemMapper`), not under `__mapper`: every expression helper inherits `__mapper` from its operand, binding
 * its plain operands through `toDriver` and reading its result through `fromDriver`.
 *
 * So an EXPRESSION over a mapped item column — `coalesce`, `add` / `sub` / `mul` / `div`, `greatest` / `least` /
 * `nullIf`, `caseOf`, `caseWhen`, an `sql` template — binds and reads exactly as on 1.0.30. Every expectation of
 * the blocks named "as on 1.0.30" is the value 1.0.30 returns for the same query (they pass on the 1.0.30 code,
 * on PostgreSQL, PGlite and in memory); with the mapper under `__mapper` they bound NaN (22P02) or read the
 * stored value back as a mapped object.
 *
 * Seed (AppDatabase): alice — posts at 09:30 (570 minutes, 100 views) and 14:00 (840, 150 views); bob — one at
 * 18:45 (1125, 200 views); charlie — none. `publishTime` is { hour, minute } stored as smallint minutes,
 * `customDate` a Date stored as integer seconds, `stringStampedAt` an ISO text stored as timestamp.
 */
const STRATEGIES = ['cte', 'lateral', 'temptable'] as const;

type PerUser = [alice: unknown, bob: unknown, charlie: unknown];

/** A projected value per user (alice, bob, charlie), each a list, a first item or an aggregate of `u.posts`. */
const PROJECTIONS: Array<{ name: string; project: (u: any) => unknown; expected: PerUser }> = [
  // --- a list's field: an expression over the mapped column and a plain value (bound as written)
  { name: 'coalesce(col, 0)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: coalesce(p.publishTime, 0) })).toList('v'), expected: [[{ t: 570 }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'add(col, 60)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: add(p.publishTime, 60) })).toList('v'), expected: [[{ t: 630 }, { t: 900 }], [{ t: 1185 }], []] },
  { name: 'sub(col, 60)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: sub(p.publishTime, 60) })).toList('v'), expected: [[{ t: 510 }, { t: 780 }], [{ t: 1065 }], []] },
  { name: 'mul(col, 2)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: mul(p.publishTime, 2) })).toList('v'), expected: [[{ t: 1140 }, { t: 1680 }], [{ t: 2250 }], []] },
  { name: 'div(col, 2)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: div(p.publishTime, 2) })).toList('v'), expected: [[{ t: 285 }, { t: 420 }], [{ t: 562 }], []] },
  { name: 'greatest(col, 600)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: greatest(p.publishTime, 600) })).toList('v'), expected: [[{ t: 600 }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'least(col, 600)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: least(p.publishTime, 600) })).toList('v'), expected: [[{ t: 570 }, { t: 600 }], [{ t: 600 }], []] },
  { name: 'nullIf(col, 570)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: nullIf(p.publishTime, 570) })).toList('v'), expected: [[{ t: null }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'caseOf(col).when(570, …)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: caseOf(p.publishTime).when(570, 'morning').else('later') })).toList('v'), expected: [[{ t: 'morning' }, { t: 'later' }], [{ t: 'later' }], []] },
  { name: 'caseWhen(…, col).else(0)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: caseWhen(gt(p.views, 100), p.publishTime).else(0) })).toList('v'), expected: [[{ t: 0 }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'sql`${col} + ${1}`', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: sql<number>`${p.publishTime} + ${1}` })).toList('v'), expected: [[{ t: 571 }, { t: 841 }], [{ t: 1126 }], []] },
  // --- column to column: nothing binds, only the READ could differ — the stored value, as before
  { name: 'coalesce(col, col)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: coalesce(p.publishTime, p.publishTime) })).toList('v'), expected: [[{ t: 570 }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'greatest(col, col)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: greatest(p.publishTime, p.publishTime) })).toList('v'), expected: [[{ t: 570 }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'caseWhen(…, col).else(col)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: caseWhen(gt(p.views, 100), p.publishTime).else(p.publishTime) })).toList('v'), expected: [[{ t: 570 }, { t: 840 }], [{ t: 1125 }], []] },
  { name: 'coalesce(intDate, intDate)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ d: coalesce(p.customDate, p.customDate) })).toList('v'), expected: [[{ d: -30376800 }, { d: -30290400 }], [{ d: -30376800 }], []] },
  // --- the other shapes of a collection
  { name: 'a list of ONE value: coalesce(col, 0)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => coalesce(p.publishTime, 0)).toList('v'), expected: [[570, 840], [1125], []] },
  { name: 'a list of ONE value: coalesce(col, col)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => coalesce(p.publishTime, p.publishTime)).toList('v'), expected: [[570, 840], [1125], []] },
  { name: 'firstOrDefault(): coalesce(col, 0)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: coalesce(p.publishTime, 0) })).firstOrDefault(), expected: [{ t: 570 }, { t: 1125 }, null] },
  { name: 'firstOrDefault(): coalesce(col, col)', project: u => u.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: coalesce(p.publishTime, p.publishTime) })).firstOrDefault(), expected: [{ t: 570 }, { t: 1125 }, null] },
  {
    name: 'a collection nested in a collection: coalesce(col, col)',
    project: u => u.orders.select((o: any) => ({ ps: o.user.posts.orderBy((p: any) => p.id).select((p: any) => ({ t: coalesce(p.publishTime, p.publishTime) })).toList('ps') })).toList('v'),
    expected: [[{ ps: [{ t: 570 }, { t: 840 }] }], [{ ps: [{ t: 1125 }] }], []],
  },
  // --- aggregates of an EXPRESSION: a number, as before (only min() / max() of the BARE column are mapped)
  { name: 'sum(add(col, 5))', project: u => u.posts.sum((p: any) => add(p.publishTime, 5)), expected: [1420, 1130, null] },
  { name: 'max(add(col, 5))', project: u => u.posts.max((p: any) => add(p.publishTime, 5)), expected: [845, 1130, null] },
  { name: 'min(sub(col, 5))', project: u => u.posts.min((p: any) => sub(p.publishTime, 5)), expected: [565, 1120, null] },
  { name: 'max(coalesce(col, 0))', project: u => u.posts.max((p: any) => coalesce(p.publishTime, 0)), expected: [840, 1125, null] },
  { name: 'max(coalesce(col, col))', project: u => u.posts.max((p: any) => coalesce(p.publishTime, p.publishTime)), expected: [840, 1125, null] },
  { name: 'max(sql`${col}`)', project: u => u.posts.max((p: any) => sql`${p.publishTime}`), expected: [840, 1125, null] },
  { name: 'sum(col)', project: u => u.posts.sum((p: any) => p.publishTime), expected: [1410, 1125, null] },
];

/** The users with a post the condition holds for. */
const FILTERS: Array<{ name: string; where: (p: any) => any; expected: string[] }> = [
  { name: 'gt(add(col, 60), 1000)', where: p => gt(add(p.publishTime, 60), 1000), expected: ['bob'] },
  { name: 'gt(mul(col, 2), 2000)', where: p => gt(mul(p.publishTime, 2), 2000), expected: ['bob'] },
  { name: 'gt(coalesce(col, 0), 1000)', where: p => gt(coalesce(p.publishTime, 0), 1000), expected: ['bob'] },
  { name: 'eq(greatest(col, 600), 600)', where: p => eq(greatest(p.publishTime, 600), 600), expected: ['alice'] },
  { name: 'eq(least(col, 600), 600)', where: p => eq(least(p.publishTime, 600), 600), expected: ['alice', 'bob'] },
  { name: 'eq(caseOf(col).when(570, 1).else(0), 1)', where: p => eq(caseOf(p.publishTime).when(570, 1).else(0), 1), expected: ['alice'] },
  { name: 'gt(caseWhen(…, col).else(0), 1000)', where: p => gt(caseWhen(gt(p.views, 100), p.publishTime).else(0), 1000), expected: ['bob'] },
  { name: 'sql`${col} > ${1000}`', where: p => sql<boolean>`${p.publishTime} > ${1000}`, expected: ['bob'] },
  // a timestamp column mapped to an ISO text: the driver's form, bound as written
  { name: "gt(coalesce(textTimestamp, '2000-01-01 00:00:00'), '2024-01-01 00:00:00')", where: p => gt(coalesce(p.stringStampedAt, '2000-01-01 00:00:00'), '2024-01-01 00:00:00'), expected: ['alice'] },
];

describe('an expression over a mapped item column binds and reads as on 1.0.30', () => {
  for (const collectionStrategy of STRATEGIES) {
    describe(`${collectionStrategy} strategy`, () => {
      for (const { name, project, expected } of PROJECTIONS) {
        test(`projection: ${name}`, async () => {
          await withDatabase(async (db: any) => {
            await seedTestData(db);

            const rows = await db.users.select((u: any) => ({ username: u.username, v: project(u) })).orderBy((u: any) => u.username).toList();

            expect(rows.map((row: any) => row.username)).toEqual(['alice', 'bob', 'charlie']);
            expect(rows.map((row: any) => row.v)).toEqual(expected);
          }, { collectionStrategy });
        });
      }

      for (const { name, where, expected } of FILTERS) {
        test(`filter: ${name}`, async () => {
          await withDatabase(async (db: any) => {
            const { users } = await seedTestData(db);

            await db.posts.where((p: any) => eq(p.userId, users.alice.id)).update({ stringStampedAt: '2024-03-01T08:15:00' });

            const viaMethod = await db.users.where((u: any) => u.posts.where(where).exists()).select((u: any) => ({ username: u.username })).orderBy((u: any) => u.username).toList();
            const viaFunction = await db.users.where((u: any) => exists(u.posts.where(where))).select((u: any) => ({ username: u.username })).orderBy((u: any) => u.username).toList();
            const counted = await db.users.select((u: any) => ({ username: u.username, n: u.posts.where(where).count() })).orderBy((u: any) => u.username).toList();

            expect(viaMethod.map((row: any) => row.username)).toEqual(expected);
            expect(viaFunction.map((row: any) => row.username)).toEqual(expected);
            expect(counted.filter((row: any) => row.n > 0).map((row: any) => row.username)).toEqual(expected);
          }, { collectionStrategy });
        });
      }

      test('a timestamp column mapped to a text: an expression of it reads as the engine delivers it', async () => {
        await withDatabase(async (db: any) => {
          const { users } = await seedTestData(db);

          await db.posts.where((p: any) => eq(p.userId, users.alice.id)).update({ stringStampedAt: '2024-03-01T08:15:00' });

          const rows = await db.users
            .select((u: any) => ({
              username: u.username,
              // in a list the value travels as JSON: PostgreSQL's ISO text of the timestamp, not the mapper's
              stamped: u.posts.orderBy((p: any) => p.id).select((p: any) => ({ s: coalesce(p.stringStampedAt, p.stringStampedAt) })).toList('stamped'),
              withDefault: u.posts.orderBy((p: any) => p.id).select((p: any) => ({ s: coalesce(p.stringStampedAt, '2000-01-01 00:00:00') })).toList('withDefault'),
            }))
            .orderBy((u: any) => u.username)
            .toList();

          expect(rows).toEqual([
            {
              username: 'alice',
              stamped: [{ s: '2024-03-01T08:15:00' }, { s: '2024-03-01T08:15:00' }],
              withDefault: [{ s: '2024-03-01T08:15:00' }, { s: '2024-03-01T08:15:00' }],
            },
            { username: 'bob', stamped: [{ s: null }], withDefault: [{ s: '2000-01-01T00:00:00' }] },
            { username: 'charlie', stamped: [], withDefault: [] },
          ]);
        }, { collectionStrategy });
      });

      test('a max() of a mapped column read through a CTE column or a joined table subquery: the stored value', async () => {
        // The mapper is applied where the collection's aggregate is READ as the aggregate — a projection's value, a
        // collection item's, a RETURNING's. Read as a COLUMN of a CTE or of a subquery it is the value the body
        // computed, as it always was.
        await withDatabase(async (db: any) => {
          await seedTestData(db);

          const perUser = () => db.users.select((u: any) => ({ userId: u.id, last: u.posts.max((p: any) => p.publishTime) }));
          const cte = new DbCteBuilder().with('per_user', perUser());
          const throughCte = await db.users
            .with(cte.cte)
            .leftJoin(cte.cte, (u: any, c: any) => eq(u.id, c.userId), (u: any, c: any) => ({ username: u.username, last: c.last }))
            .orderBy((r: any) => r.username)
            .toList();
          const throughSubquery = await db.users
            .leftJoin(perUser().asSubquery('table'), (u: any, s: any) => eq(u.id, s.userId), (u: any, s: any) => ({ username: u.username, last: s.last }), 'pu')
            .orderBy((r: any) => r.username)
            .toList();

          expect(throughCte.map((row: any) => [row.username, row.last ?? null])).toEqual([['alice', 840], ['bob', 1125], ['charlie', null]]);
          expect(throughSubquery.map((row: any) => [row.username, row.last ?? null])).toEqual([['alice', 840], ['bob', 1125], ['charlie', null]]);
        }, { collectionStrategy });
      });
    });
  }
});

// ---------------------------------------------------------------------------
// A Temporal-style mapper: a class instance over a `timestamp` column (not an integer-backed one), an
// array column and a text mapper, on a model of its own: venues <- slots
// ---------------------------------------------------------------------------

/** A wall-clock time as an application object (what a Temporal.PlainDateTime is to its caller). */
class Stamp {
  constructor(readonly iso: string) {}

  static of(iso: string): Stamp {
    return new Stamp(iso);
  }

  /** From what a driver hands back for a `timestamp`: its text, or a Date of the same wall-clock time. */
  static fromDriver(value: unknown): Stamp {
    if (value instanceof Date) {
      const pad = (n: number): string => String(n).padStart(2, '0');

      return new Stamp(`${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`);
    }

    return new Stamp(String(value).replace(' ', 'T').slice(0, 19));
  }
}

const stampMapper = createCustomType<{ data: Stamp; driverData: string }>({
  dataType: () => 'timestamp',
  // a value that is not a Stamp is a bug of the caller: said loudly, as a Temporal value's method would fail
  toDriver: (value: Stamp | null | undefined) => {
    if (value == null) {
      return null as any;
    }
    if (!(value instanceof Stamp)) {
      throw new TypeError(`stampMapper.toDriver: expected a Stamp, got ${typeof value} ${JSON.stringify(value)}`);
    }

    return value.iso.replace('T', ' ');
  },
  fromDriver: (value: any) => (value == null ? null : Stamp.fromDriver(value)) as any,
});

const upperCase = createCustomType<{ data: string; driverData: string }>({
  dataType: () => 'varchar',
  toDriver: (value: string | null | undefined) => (value == null ? null : value.toUpperCase()) as any,
  fromDriver: (value: string | null | undefined) => (value == null ? null : value.toLowerCase()) as any,
});

const reversed = createCustomType<{ data: string; driverData: string }>({
  dataType: () => 'varchar',
  toDriver: (value: string | null | undefined) => (value == null ? null : [...value].reverse().join('')) as any,
  fromDriver: (value: string | null | undefined) => (value == null ? null : [...value].reverse().join('')) as any,
});

class CimVenue extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  slots?: CimSlot[];
}

class CimSlot extends DbEntity {
  id!: DbColumn<number>;
  venueId!: DbColumn<number>;
  startsAt!: DbColumn<Stamp>;
  endsAt?: DbColumn<Stamp | null>;
  code?: DbColumn<string | null>;
  tags?: DbColumn<string[] | null>;
  venue?: CimVenue;
}

const configure = (model: DbModelConfig): void => {
  model.entity(CimVenue, entity => {
    entity.toTable('cim_venues');
    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'cim_venues_id_seq' }));
    entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
    entity.hasMany(e => e.slots, () => CimSlot).withForeignKey(s => s.venueId).withPrincipalKey(v => v.id);
  });
  model.entity(CimSlot, entity => {
    entity.toTable('cim_slots');
    entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'cim_slots_id_seq' }));
    entity.property(e => e.venueId).hasType(integer('venue_id')).isRequired();
    entity.property(e => e.startsAt).hasType(timestamp('starts_at')).hasCustomMapper(stampMapper).isRequired();
    entity.property(e => e.endsAt).hasType(timestamp('ends_at')).hasCustomMapper(stampMapper);
    entity.property(e => e.code).hasType(varchar('code', 16)).hasCustomMapper(upperCase);
    entity.property(e => e.tags).hasType(text('tags').array());
    entity.hasOne(e => e.venue, () => CimVenue).withForeignKey(s => s.venueId).withPrincipalKey(v => v.id);
  });
};

class CimDatabase extends DbContext {
  get venues(): DbEntityTable<CimVenue> {
    return this.table(CimVenue);
  }

  get slots(): DbEntityTable<CimSlot> {
    return this.table(CimSlot);
  }

  protected override setupModel(model: DbModelConfig): void {
    configure(model);
  }
}

/** The same tables, `code` mapped another way: a second model over one table name (see the MockRowCache test). */
class CimAltVenue extends DbEntity {
  id!: DbColumn<number>;
  slots?: CimAltSlot[];
}

class CimAltSlot extends DbEntity {
  id!: DbColumn<number>;
  venueId!: DbColumn<number>;
  code?: DbColumn<string | null>;
}

class CimReversedDatabase extends DbContext {
  get venues(): DbEntityTable<CimAltVenue> {
    return this.table(CimAltVenue);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(CimAltVenue, entity => {
      entity.toTable('cim_venues');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.hasMany(e => e.slots, () => CimAltSlot).withForeignKey(s => s.venueId).withPrincipalKey(v => v.id);
    });
    model.entity(CimAltSlot, entity => {
      entity.toTable('cim_slots');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.venueId).hasType(integer('venue_id')).isRequired();
      entity.property(e => e.code).hasType(varchar('code', 16)).hasCustomMapper(reversed);
    });
  }
}

const at = (time: string): Stamp => Stamp.of(`2026-09-04T${time}`);

/**
 *   venue   slot  starts   ends     code  tags
 *   Hall    1     10:00    12:00    AM    {a,b}
 *   Hall    2     12:00    14:00    PM    {b}
 *   Studio  3     10:00    NULL     AM    {}
 *   Attic   —
 */
describe('a Temporal-style mapper over a timestamp column of a collection item', () => {
  let client: DatabaseClient;

  const dropTables = async (): Promise<void> => {
    await client.query('DROP TABLE IF EXISTS cim_slots CASCADE');
    await client.query('DROP TABLE IF EXISTS cim_venues CASCADE');
  };
  const contextOf = (collectionStrategy: typeof STRATEGIES[number]): CimDatabase => new CimDatabase(client, { logQueries: false, collectionStrategy });

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    await dropTables();

    const db = contextOf('lateral');

    await db.getSchemaManager().ensureCreated();

    const [hall, studio] = await db.venues.insertBulk([{ name: 'Hall' }, { name: 'Studio' }, { name: 'Attic' }]).returning();

    await db.slots.insertBulk([
      { venueId: hall.id, startsAt: at('10:00:00'), endsAt: at('12:00:00'), code: 'am', tags: ['a', 'b'] },
      { venueId: hall.id, startsAt: at('12:00:00'), endsAt: at('14:00:00'), code: 'pm', tags: ['b'] },
      { venueId: studio.id, startsAt: at('10:00:00'), endsAt: null, code: 'am', tags: [] },
    ]);
  });

  afterAll(async () => {
    MockRowCache.reset();
    await dropTables();
    await client.end();
  });

  for (const collectionStrategy of STRATEGIES) {
    describe(`${collectionStrategy} strategy`, () => {
      const venuesWhere = async (where: (s: any) => any): Promise<string[]> => (await contextOf(collectionStrategy).venues
        .where((v: any) => v.slots.where(where).exists())
        .select(v => ({ name: v.name }))
        .orderBy(v => v.name)
        .toList()).map(v => v.name);

      test('1.0.31: a Stamp compared DIRECTLY with the column is bound through toDriver', async () => {
        expect(await venuesWhere(s => eq(s.startsAt, at('12:00:00')))).toEqual(['Hall']);
        expect(await venuesWhere(s => ne(s.startsAt, at('10:00:00')))).toEqual(['Hall']);
        expect(await venuesWhere(s => and(lte(s.startsAt, at('11:00:00')), gte(s.endsAt, at('11:00:00'))))).toEqual(['Hall']);
        expect(await venuesWhere(s => between(s.startsAt, at('11:00:00'), at('13:00:00')))).toEqual(['Hall']);
        expect(await venuesWhere(s => inArray(s.endsAt, [at('14:00:00'), at('16:00:00')]))).toEqual(['Hall']);
        expect(await venuesWhere(s => eqAny(s.startsAt, [at('10:00:00')]))).toEqual(['Hall', 'Studio']);
        expect(await venuesWhere(s => eq(s.code, 'pm'))).toEqual(['Hall']);

        const free = await contextOf(collectionStrategy).venues
          .where((v: any) => not(exists(v.slots.where((s: any) => and(lte(s.startsAt, at('13:00:00')), gte(s.endsAt, at('13:00:00')))))))
          .select(v => ({ name: v.name }))
          .orderBy(v => v.name)
          .toList();

        expect(free.map(v => v.name)).toEqual(['Attic', 'Studio']);
      });

      test('1.0.31: min() / max() of the bare column read through fromDriver', async () => {
        const rows = await contextOf(collectionStrategy).venues
          .select((v: any) => ({
            name: v.name,
            first: v.slots.min((s: any) => s.startsAt),
            last: v.slots.max((s: any) => s.endsAt),
            lastCode: v.slots.max((s: any) => s.code),
            afternoon: v.slots.where((s: any) => gte(s.startsAt, at('12:00:00'))).count(),
          }))
          .orderBy((v: any) => v.name)
          .toList();

        expect(rows).toEqual([
          { name: 'Attic', first: null, last: null, lastCode: null, afternoon: 0 },
          { name: 'Hall', first: at('10:00:00'), last: at('14:00:00'), lastCode: 'pm', afternoon: 1 },
          { name: 'Studio', first: at('10:00:00'), last: null, lastCode: 'am', afternoon: 0 },
        ]);
        expect(rows[1].first).toBeInstanceOf(Stamp);
      });

      test('as on 1.0.30: an expression over the timestamp column binds a plain value as written and reads as the engine delivers it', async () => {
        // bound as written: the driver's text of a timestamp (a Stamp there is what toDriver was never asked to convert)
        expect(await venuesWhere(s => gt(coalesce(s.endsAt, s.startsAt), '2026-09-04 13:00:00'))).toEqual(['Hall']);
        expect(await venuesWhere(s => gt(greatest(s.startsAt, s.endsAt), '2026-09-04 13:00:00'))).toEqual(['Hall']);
        expect(await venuesWhere(s => eq(coalesce(s.code, 'none'), 'PM'))).toEqual(['Hall']);
        expect(await venuesWhere(s => sql<boolean>`${s.startsAt} >= ${'2026-09-04 12:00:00'}::timestamp`)).toEqual(['Hall']);

        const rows = await contextOf(collectionStrategy).venues
          .select((v: any) => ({
            name: v.name,
            // a list's field travels as JSON: PostgreSQL's ISO text, not a Stamp
            ends: v.slots.orderBy((s: any) => s.id).select((s: any) => ({ at: coalesce(s.endsAt, s.startsAt), code: coalesce(s.code, s.code) })).toList('ends'),
            // the stored text of the upper-case column, not the mapped one
            lastCode: v.slots.max((s: any) => coalesce(s.code, s.code)),
          }))
          .orderBy((v: any) => v.name)
          .toList();

        expect(rows).toEqual([
          { name: 'Attic', ends: [], lastCode: null },
          { name: 'Hall', ends: [{ at: '2026-09-04T12:00:00', code: 'AM' }, { at: '2026-09-04T14:00:00', code: 'PM' }], lastCode: 'PM' },
          { name: 'Studio', ends: [{ at: '2026-09-04T10:00:00', code: 'AM' }], lastCode: 'AM' },
        ]);
      });

      test('as on 1.0.30: a JS array compared with a native array column of the item', async () => {
        expect(await venuesWhere(s => eq(s.tags, ['a', 'b']))).toEqual(['Hall']);
        expect(await venuesWhere(s => eq(s.tags, ['b']))).toEqual(['Hall']);
        expect(await venuesWhere(s => eq(s.tags, []))).toEqual(['Studio']);
        expect(await venuesWhere(s => ne(s.tags, ['b']))).toEqual(['Hall', 'Studio']);
      });
    });
  }

  test('the item column refs: the mapper under its own marker, never under __mapper', () => {
    const seen: Record<string, any> = {};

    contextOf('lateral').venues.where((v: any) => v.slots.where((s: any) => {
      seen.mapped = s.startsAt;
      seen.unmapped = s.venueId;

      return eq(s.venueId, 1);
    }).exists()).select(v => ({ id: v.id })).future();

    expect('__mapper' in seen.mapped).toBe(false);
    expect(seen.mapped.__itemMapper.toDriver(at('10:00:00'))).toBe('2026-09-04 10:00:00');
    expect('__itemMapper' in seen.unmapped).toBe(false);
    expect('__mapper' in seen.unmapped).toBe(false);
  });

  test('MockRowCache on: two models over one table name each bind through their OWN item mapper', () => {
    // The cached prototype of a table's item mock is shared by table name; the mapper is read from the
    // schema of the collection that minted the item, not captured in the prototype
    const paramsOf = (db: { venues: DbEntityTable<any> }): unknown[] => db.venues
      .where((v: any) => v.slots.where((s: any) => eq(s.code, 'ab')).exists())
      .select((v: any) => ({ id: v.id }))
      .future()
      .getParams();

    MockRowCache.reset();
    MockRowCache.setEnabled(true);

    try {
      const upper = new CimDatabase(client, { logQueries: false });
      const reverse = new CimReversedDatabase(client, { logQueries: false });

      expect(paramsOf(upper)).toEqual(['AB']);
      expect(paramsOf(reverse)).toEqual(['ba']);
      expect(paramsOf(upper)).toEqual(['AB']);
    } finally {
      MockRowCache.reset();
    }
  });
});
