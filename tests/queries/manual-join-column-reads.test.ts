import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test';
import {
  agg,
  and,
  coalesce,
  createCustomType,
  DatabaseClient,
  date,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  eqAny,
  gt,
  integer,
  numeric,
  QueryBatch,
  serial,
  timestamp,
  varchar,
} from '../../src';
import type { BatchItemKey, BatchListKey, FutureQuery, FutureSingleQuery } from '../../src';
import { createFreshClient } from '../utils/test-database';

/**
 * A column of a MANUALLY joined table (`leftJoin` / `innerJoin` on a table) reads the way its own table
 * says — standalone and through a QueryBatch alike. The reads used to look the column up by its NAME on
 * the query's own (base) table:
 *
 * - a joined column named like a MAPPED base column read through THAT column's mapper (a machine's hour
 *   counter `600` came back `{ hours: 10, minutes: 0 }`);
 * - a MAPPED joined column the base table has no column of read through none (`90` for 1 h 30 min), and
 *   a condition on it bound its value unconverted;
 * - a joined text column read like an expression: digits became a number (`'00042'` → `42`);
 * - through a batch, a joined timestamp / date column the base table lacks came back as its ISO text,
 *   and a joined text column named like a base TIMESTAMP column as an Invalid Date.
 *
 * The navigation form (`j.machine!.service`) always read these columns correctly; it is pinned next to
 * them. A small workshop (defined here). A job's `runtime` is MAPPED (minutes ↔ hours + minutes), its
 * `due` is a timestamp and its `load` an integer (percent); a machine's `runtime` is a plain integer (its
 * hour counter), its `service` interval is mapped, its `due` is a text, its `serial` a text of digits and
 * its `load` a numeric (kW):
 *
 *   site   opened on   shift
 *   North  2019-04-01  8h00
 *   South  2021-09-15  6h30
 *
 *   machine  site   runtime  service  installed at         due      serial  load
 *   Lathe    North  600      1h30     2020-01-15 08:30:00  weekly   00042   72.25
 *   Press    South  480      0h45     2021-06-01 14:00:00  monthly  00107   55.50
 *
 *   job     machine  backup  follows  runtime  due                  load
 *   shaft   Lathe    Press   -        0h30     2024-03-01 09:00:00  40
 *   flange  Press    Lathe   shaft    0h45     2024-03-02 10:00:00  65
 *   manual  -        -       flange   1h00     2024-03-03 11:00:00  10
 */

interface Span {
  hours: number;
  minutes: number;
}

/** Minutes, read back as hours + minutes. */
const spanType = createCustomType<{ data: Span; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value: Span | null | undefined) => (value == null ? null : value.hours * 60 + value.minutes) as number,
  fromDriver: (value: number | null | undefined) =>
    (value == null ? null : { hours: Math.floor(Number(value) / 60), minutes: Number(value) % 60 }) as Span,
});

class MjcSite extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  openedOn!: DbColumn<Date>;
  shift!: DbColumn<Span>;
}

class MjcMachine extends DbEntity {
  id!: DbColumn<number>;
  siteId!: DbColumn<number>;
  name!: DbColumn<string>;
  runtime!: DbColumn<number>;
  service!: DbColumn<Span>;
  installedAt!: DbColumn<Date>;
  due!: DbColumn<string>;
  serial!: DbColumn<string>;
  load!: DbColumn<string>;

  site?: MjcSite;
}

class MjcJob extends DbEntity {
  id!: DbColumn<number>;
  machineId!: DbColumn<number | null>;
  backupId!: DbColumn<number | null>;
  followsId!: DbColumn<number | null>;
  title!: DbColumn<string>;
  runtime!: DbColumn<Span>;
  due!: DbColumn<Date>;
  load!: DbColumn<number>;

  machine?: MjcMachine;
  backup?: MjcMachine;
  follows?: MjcJob;
}

class WorkshopDatabase extends DbContext {
  get sites(): DbEntityTable<MjcSite> {
    return this.table(MjcSite);
  }

  get machines(): DbEntityTable<MjcMachine> {
    return this.table(MjcMachine);
  }

  get jobs(): DbEntityTable<MjcJob> {
    return this.table(MjcJob);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(MjcSite, entity => {
      entity.toTable('mjc_sites');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.openedOn).hasType(date('opened_on')).isRequired();
      entity.property(e => e.shift).hasType(integer('shift_minutes')).hasCustomMapper(spanType).isRequired();
    });

    model.entity(MjcMachine, entity => {
      entity.toTable('mjc_machines');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.siteId).hasType(integer('site_id')).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.runtime).hasType(integer('runtime')).isRequired();
      entity.property(e => e.service).hasType(integer('service_minutes')).hasCustomMapper(spanType).isRequired();
      entity.property(e => e.installedAt).hasType(timestamp('installed_at')).isRequired();
      entity.property(e => e.due).hasType(varchar('due', 16)).isRequired();
      entity.property(e => e.serial).hasType(varchar('serial', 16)).isRequired();
      entity.property(e => e.load).hasType(numeric('load_kw', 6, 2)).isRequired();

      entity.hasOne(e => e.site, () => MjcSite)
        .withForeignKey(m => m.siteId)
        .withPrincipalKey(s => s.id);
    });

    model.entity(MjcJob, entity => {
      entity.toTable('mjc_jobs');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.machineId).hasType(integer('machine_id'));
      entity.property(e => e.backupId).hasType(integer('backup_id'));
      entity.property(e => e.followsId).hasType(integer('follows_id'));
      entity.property(e => e.title).hasType(varchar('title', 64)).isRequired();
      entity.property(e => e.runtime).hasType(integer('runtime_minutes')).hasCustomMapper(spanType).isRequired();
      entity.property(e => e.due).hasType(timestamp('due_at')).isRequired();
      entity.property(e => e.load).hasType(integer('load_percent')).isRequired();

      entity.hasOne(e => e.machine, () => MjcMachine)
        .withForeignKey(j => j.machineId)
        .withPrincipalKey(m => m.id);
      entity.hasOne(e => e.backup, () => MjcMachine)
        .withForeignKey(j => j.backupId)
        .withPrincipalKey(m => m.id);
      entity.hasOne(e => e.follows, () => MjcJob)
        .withForeignKey(j => j.followsId)
        .withPrincipalKey(p => p.id);
    });
  }
}

const TABLES = ['mjc_jobs', 'mjc_machines', 'mjc_sites'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

const span = (hours: number, minutes: number): Span => ({ hours, minutes });

/** A date as the drivers read it: local midnight of that day. */
const localDay = (value: string): Date => {
  const [year, month, dayOfMonth] = value.split('-').map(Number);

  return new Date(year, month - 1, dayOfMonth);
};

/** A timestamp-without-time-zone value as the drivers read it: that wall-clock time, local. */
const localTime = (value: string): Date => new Date(value.replace(' ', 'T'));

/**
 * Deep equality that also asserts every leaf's JS type (a Date stays a Date, text stays text, NULL stays
 * null or undefined as it was) and the key order of every row.
 */
const expectSameShape = (actual: unknown, expected: unknown, path = '$', isRow = false): void => {
  if (expected === null || expected === undefined) {
    expect({ path, value: actual, isNull: actual === null }).toEqual({ path, value: expected, isNull: expected === null });

    return;
  }

  expect({ path, type: typeof actual }).toEqual({ path, type: typeof expected });

  if (typeof expected !== 'object') {
    expect({ path, value: actual }).toEqual({ path, value: expected });

    return;
  }

  expect({ path, constructor: (actual as object).constructor }).toEqual({ path, constructor: (expected as object).constructor });

  if (expected instanceof Date) {
    expect({ path, time: (actual as Date).getTime() }).toEqual({ path, time: expected.getTime() });

    return;
  }

  if (Array.isArray(expected)) {
    expect({ path, length: (actual as unknown[]).length }).toEqual({ path, length: expected.length });
    expected.forEach((item, ix) => expectSameShape((actual as unknown[])[ix], item, `${path}[${ix}]`, path === '$'));

    return;
  }

  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual as object);

  expect({ path, keys: isRow ? actualKeys : [...actualKeys].sort() })
    .toEqual({ path, keys: isRow ? expectedKeys : [...expectedKeys].sort() });

  for (const key of expectedKeys) {
    expectSameShape((actual as any)[key], (expected as any)[key], `${path}.${key}`);
  }
};

/** A query a batch lists and reads the first row of. */
interface Batchable {
  future(): FutureQuery<any>;
  futureFirstOrDefault(): FutureSingleQuery<any>;
  toList(): Promise<any[]>;
  firstOrDefault(): Promise<any>;
}

describe('a manually joined table\'s columns read as that table says — standalone and through a QueryBatch', () => {
  let db: WorkshopDatabase;
  let client: DatabaseClient;
  let shaft: number;
  let flange: number;
  let manual: number;
  let lathe: number;
  let press: number;
  const captured: string[] = [];

  beforeAll(async () => {
    client = createFreshClient();
    db = new WorkshopDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });

    await dropTables(client);
    await db.getSchemaManager().ensureCreated();

    // A date binds as its 'YYYY-MM-DD' text and a timestamp WITHOUT time zone as its wall-clock text,
    // so every driver stores exactly these values whatever the process time zone is
    const day = (value: string) => value as unknown as Date;

    const [north, south] = await db.sites.insertBulk([
      { name: 'North', openedOn: day('2019-04-01'), shift: span(8, 0) },
      { name: 'South', openedOn: day('2021-09-15'), shift: span(6, 30) },
    ]).returning();

    const [latheRow, pressRow] = await db.machines.insertBulk([
      { siteId: north.id, name: 'Lathe', runtime: 600, service: span(1, 30), installedAt: day('2020-01-15 08:30:00'), due: 'weekly', serial: '00042', load: '72.25' },
      { siteId: south.id, name: 'Press', runtime: 480, service: span(0, 45), installedAt: day('2021-06-01 14:00:00'), due: 'monthly', serial: '00107', load: '55.50' },
    ]).returning();
    lathe = latheRow.id;
    press = pressRow.id;

    const [shaftRow] = await db.jobs.insertBulk([
      { machineId: lathe, backupId: press, followsId: null, title: 'shaft', runtime: span(0, 30), due: day('2024-03-01 09:00:00'), load: 40 },
    ]).returning();
    const [flangeRow] = await db.jobs.insertBulk([
      { machineId: press, backupId: lathe, followsId: shaftRow.id, title: 'flange', runtime: span(0, 45), due: day('2024-03-02 10:00:00'), load: 65 },
    ]).returning();
    const [manualRow] = await db.jobs.insertBulk([
      { machineId: null, backupId: null, followsId: flangeRow.id, title: 'manual', runtime: span(1, 0), due: day('2024-03-03 11:00:00'), load: 10 },
    ]).returning();
    shaft = shaftRow.id;
    flange = flangeRow.id;
    manual = manualRow.id;
  });

  afterAll(async () => {
    await dropTables(client);
    await db.dispose();
  });

  /** The SELECTs the context logged since `captured` was last cleared. */
  const loggedSelects = (): string[] => captured.filter(entry => entry.trimStart().startsWith('SELECT')).map(entry => entry.replace(/\s+/g, ' ').trim());

  /** Executes the batch, asserting ONE round trip. */
  const executeInOneRoundTrip = async (batch: QueryBatch): Promise<void> => {
    const querySpy = jest.spyOn(client, 'query');

    try {
      await batch.executeBatch();

      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }
  };

  /**
   * Runs the query standalone, then — built afresh — through a batch of its own in one round trip:
   * identical values, JS types and row key order. Returns the standalone result, for the test to pin.
   */
  const expectBatchedLikeStandalone = async <T>(build: () => Batchable, kind: 'list' | 'first' = 'list'): Promise<T> => {
    const standalone = kind === 'list' ? await build().toList() : await build().firstOrDefault();

    const batch = new QueryBatch();
    const key = kind === 'list' ? batch.addList(build() as any, 'probe') : batch.addFirstOrDefault(build() as any, 'probe');
    await executeInOneRoundTrip(batch);
    const batched = kind === 'list' ? batch.getList(key as BatchListKey<unknown>) : batch.getItem(key as BatchItemKey<unknown>);

    expect(batched).toEqual(standalone);
    expectSameShape(batched, standalone, '$', kind === 'first');

    return standalone as T;
  };

  /** What each job's machine reads as, through the job's own columns and its machine's. */
  const machineRows = () => [
    {
      id: shaft,
      title: 'shaft',
      jobRuntime: span(0, 30),
      jobDue: localTime('2024-03-01 09:00:00'),
      machineRuntime: 600,
      machineService: span(1, 30),
      machineInstalledAt: localTime('2020-01-15 08:30:00'),
      machineDue: 'weekly',
      machineSerial: '00042',
      machineLoad: '72.25',
    },
    {
      id: flange,
      title: 'flange',
      jobRuntime: span(0, 45),
      jobDue: localTime('2024-03-02 10:00:00'),
      machineRuntime: 480,
      machineService: span(0, 45),
      machineInstalledAt: localTime('2021-06-01 14:00:00'),
      machineDue: 'monthly',
      machineSerial: '00107',
      machineLoad: '55.50',
    },
  ];

  /** The same columns read through the job's `machine` navigation — the form that always read them right. */
  const viaNavigation = () => db.jobs
    .select(j => ({
      id: j.id,
      title: j.title,
      jobRuntime: j.runtime,
      jobDue: j.due,
      machineRuntime: j.machine!.runtime,
      machineService: j.machine!.service,
      machineInstalledAt: j.machine!.installedAt,
      machineDue: j.machine!.due,
      machineSerial: j.machine!.serial,
      machineLoad: j.machine!.load,
    }))
    .orderBy(r => r.id);

  describe('the navigation form (pinned: it always read its columns right)', () => {
    test('a navigation\'s columns read as their table says — standalone and batched', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(viaNavigation);

      expect(rows.slice(0, 2)).toEqual(machineRows());
      expect(rows[2].id).toBe(manual);
      expect(rows[2].machineService).toBeNull();
      expect(rows[2].machineRuntime ?? null).toBeNull();
    });
  });

  describe('a joined table\'s columns', () => {
    const viaLeftJoin = () => db.jobs
      .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({
        id: j.id,
        title: j.title,
        jobRuntime: j.runtime,
        jobDue: j.due,
        machineRuntime: m.runtime,
        machineService: m.service,
        machineInstalledAt: m.installedAt,
        machineDue: m.due,
        machineSerial: m.serial,
        machineLoad: m.load,
      }))
      .orderBy(r => r.id);

    test('leftJoin: each column reads as its own table says — exactly as the navigation form reads it', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(viaLeftJoin);

      expect(rows.slice(0, 2)).toEqual(machineRows());
      // The unmatched job: every machine column NULL, read as the navigation form reads it
      expect(rows[2].id).toBe(manual);
      expectSameShape(rows, await viaNavigation().toList());
    });

    test('innerJoin: the same reads — and firstOrDefault() reads its row the same way', async () => {
      const viaInnerJoin = () => db.jobs
        .innerJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({
          id: j.id,
          title: j.title,
          jobRuntime: j.runtime,
          jobDue: j.due,
          machineRuntime: m.runtime,
          machineService: m.service,
          machineInstalledAt: m.installedAt,
          machineDue: m.due,
          machineSerial: m.serial,
          machineLoad: m.load,
        }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(viaInnerJoin);
      expect(rows).toEqual(machineRows());

      const first = await expectBatchedLikeStandalone<any>(viaInnerJoin, 'first');
      expect(first).toEqual(machineRows()[0]);
    });

    test('the same table joined twice under two aliases: each alias reads its own row', async () => {
      const twice = () => db.jobs
        .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({
          id: j.id,
          backupId: j.backupId,
          mainRuntime: m.runtime,
          mainService: m.service,
          mainDue: m.due,
        }))
        .leftJoin(db.machines, (l, b) => eq(l.backupId, b.id), (l, b) => ({
          id: l.id,
          mainRuntime: l.mainRuntime,
          mainService: l.mainService,
          mainDue: l.mainDue,
          backupRuntime: b.runtime,
          backupService: b.service,
          backupDue: b.due,
          backupInstalledAt: b.installedAt,
        }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(twice);

      expect(rows.slice(0, 2)).toEqual([
        {
          id: shaft,
          mainRuntime: 600,
          mainService: span(1, 30),
          mainDue: 'weekly',
          backupRuntime: 480,
          backupService: span(0, 45),
          backupDue: 'monthly',
          backupInstalledAt: localTime('2021-06-01 14:00:00'),
        },
        {
          id: flange,
          mainRuntime: 480,
          mainService: span(0, 45),
          mainDue: 'monthly',
          backupRuntime: 600,
          backupService: span(1, 30),
          backupDue: 'weekly',
          backupInstalledAt: localTime('2020-01-15 08:30:00'),
        },
      ]);

      // The navigation form of the same two machines reads the same
      const navigation = await db.jobs
        .select(j => ({ id: j.id, mainRuntime: j.machine!.runtime, mainService: j.machine!.service, backupRuntime: j.backup!.runtime, backupService: j.backup!.service }))
        .orderBy(r => r.id)
        .toList();
      expect(rows.map(r => ({ id: r.id, mainRuntime: r.mainRuntime, mainService: r.mainService, backupRuntime: r.backupRuntime, backupService: r.backupService })))
        .toEqual(navigation);
    });

    test('a self-join: the joined row\'s columns are the base table\'s own — as they always read', async () => {
      const selfJoin = () => db.jobs
        .leftJoin(db.jobs, (j, p) => eq(j.followsId, p.id), (j, p) => ({ id: j.id, prevTitle: p.title, prevRuntime: p.runtime, prevDue: p.due }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(selfJoin);

      expect(rows.slice(1)).toEqual([
        { id: flange, prevTitle: 'shaft', prevRuntime: span(0, 30), prevDue: localTime('2024-03-01 09:00:00') },
        { id: manual, prevTitle: 'flange', prevRuntime: span(0, 45), prevDue: localTime('2024-03-02 10:00:00') },
      ]);
      expect([rows[0].prevTitle ?? null, rows[0].prevRuntime ?? null, rows[0].prevDue ?? null]).toEqual([null, null, null]);

      const navigation = await db.jobs
        .select(j => ({ id: j.id, prevTitle: j.follows!.title, prevRuntime: j.follows!.runtime, prevDue: j.follows!.due }))
        .orderBy(r => r.id)
        .toList();
      expectSameShape(rows, navigation);
    });

    test('a join chained after another join: the second table\'s columns read as its own, the first\'s still as theirs', async () => {
      const chained = () => db.jobs
        .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({ id: j.id, siteId: m.siteId, machineService: m.service }))
        .leftJoin(db.sites, (l, s) => eq(l.siteId, s.id), (l, s) => ({
          id: l.id,
          machineService: l.machineService,
          siteName: s.name,
          siteOpenedOn: s.openedOn,
          siteShift: s.shift,
        }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(chained);

      expect(rows.slice(0, 2)).toEqual([
        { id: shaft, machineService: span(1, 30), siteName: 'North', siteOpenedOn: localDay('2019-04-01'), siteShift: span(8, 0) },
        { id: flange, machineService: span(0, 45), siteName: 'South', siteOpenedOn: localDay('2021-09-15'), siteShift: span(6, 30) },
      ]);
      expect(rows[2].id).toBe(manual);
    });

    test('an aggregate over a joined column reads as one over a column of the queried table (its mapper, its type)', async () => {
      const extremes = () => db.jobs
        .innerJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({
          longest: agg.max(m.service),
          shortest: agg.min(m.service),
          newest: agg.max(m.installedAt),
          heaviest: agg.max(m.load),
        }));

      const row = await expectBatchedLikeStandalone<any>(extremes, 'first');

      expect(row).toEqual({ longest: span(1, 30), shortest: span(0, 45), newest: localTime('2021-06-01 14:00:00'), heaviest: 72.25 });
    });

    test('an expression over a joined MAPPED column binds its values and reads its result through that mapper', async () => {
      const intervals = () => db.jobs
        .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({ id: j.id, interval: coalesce(m.service, span(0, 0)) }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(intervals);

      expect(rows).toEqual([
        { id: shaft, interval: span(1, 30) },
        { id: flange, interval: span(0, 45) },
        { id: manual, interval: span(0, 0) },
      ]);
    });

    test('a select() over the joined projection reads its columns the same way', async () => {
      const reprojected = () => db.jobs
        .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({ id: j.id, machineRuntime: m.runtime, machineService: m.service, machineSerial: m.serial }))
        .select(r => ({ id: r.id, counter: r.machineRuntime, interval: r.machineService, serial: r.machineSerial }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(reprojected);

      expect(rows.slice(0, 2)).toEqual([
        { id: shaft, counter: 600, interval: span(1, 30), serial: '00042' },
        { id: flange, counter: 480, interval: span(0, 45), serial: '00107' },
      ]);
    });

    test('a navigation off a joined table: its columns read as their table says', async () => {
      const offJoined = () => db.jobs
        .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({
          id: j.id,
          siteName: m.site!.name,
          siteOpenedOn: m.site!.openedOn,
          siteShift: m.site!.shift,
        }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(offJoined);

      expect(rows.slice(0, 2)).toEqual([
        { id: shaft, siteName: 'North', siteOpenedOn: localDay('2019-04-01'), siteShift: span(8, 0) },
        { id: flange, siteName: 'South', siteOpenedOn: localDay('2021-09-15'), siteShift: span(6, 30) },
      ]);
    });

    test('a join inside a CTE: the CTE\'s columns read as the joined columns do', async () => {
      const jobMachines = () => new DbCteBuilder().with(
        'mjc_job_machines',
        db.jobs.leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({
          cteJobId: j.id,
          machineRuntime: m.runtime,
          machineService: m.service,
          machineInstalledAt: m.installedAt,
          machineDue: m.due,
          machineSerial: m.serial,
        }))
      ).cte;

      const viaCte = () => db.jobs
        .leftJoin(jobMachines(), (j, c) => eq(j.id, c.cteJobId), (j, c) => ({
          id: j.id,
          machineRuntime: c.machineRuntime,
          machineService: c.machineService,
          machineInstalledAt: c.machineInstalledAt,
          machineDue: c.machineDue,
          machineSerial: c.machineSerial,
        }))
        .orderBy(r => r.id);

      const rows = await expectBatchedLikeStandalone<any[]>(viaCte);

      expect(rows.slice(0, 2)).toEqual([
        { id: shaft, machineRuntime: 600, machineService: span(1, 30), machineInstalledAt: localTime('2020-01-15 08:30:00'), machineDue: 'weekly', machineSerial: '00042' },
        { id: flange, machineRuntime: 480, machineService: span(0, 45), machineInstalledAt: localTime('2021-06-01 14:00:00'), machineDue: 'monthly', machineSerial: '00107' },
      ]);
    });
  });

  describe('conditions and ordering on joined columns', () => {
    test('a WHERE / ORDER BY on joined columns renders exactly as before — only the values read change', async () => {
      const filtered = () => db.jobs
        .innerJoin(db.machines, (j, m) => and(eq(j.machineId, m.id), gt(m.runtime, 100)), (j, m) => ({ id: j.id, machineName: m.name, machineRuntime: m.runtime }))
        .where(r => gt(r.machineRuntime, 500))
        .orderBy(r => [[r.machineName, 'DESC']]);

      captured.length = 0;
      await filtered().toList();
      expect(loggedSelects()).toEqual([
        'SELECT "mjc_jobs"."id" as "id", "mjc_machines_0"."name" as "machineName", "mjc_machines_0"."runtime" as "machineRuntime" FROM "mjc_jobs" INNER JOIN "mjc_machines" AS "mjc_machines_0" ON ("mjc_jobs"."machine_id" = "mjc_machines_0"."id" AND "mjc_machines_0"."runtime" > $2) WHERE "mjc_machines_0"."runtime" > $1 ORDER BY "machineName" DESC',
      ]);

      const rows = await expectBatchedLikeStandalone<any[]>(filtered);
      expect(rows).toEqual([{ id: shaft, machineName: 'Lathe', machineRuntime: 600 }]);
    });

    test('a condition on a joined MAPPED column binds its value through the column\'s mapper', async () => {
      const serviced = () => db.jobs
        .leftJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({ id: j.id, machineService: m.service }))
        .where(r => gt(r.machineService, span(1, 0)))
        .orderBy(r => r.id);

      expect(await expectBatchedLikeStandalone<any[]>(serviced)).toEqual([{ id: shaft, machineService: span(1, 30) }]);

      const inJoin = () => db.jobs
        .innerJoin(db.machines, (j, m) => and(eq(j.machineId, m.id), eq(m.service, span(0, 45))), (j, m) => ({ id: j.id, machineService: m.service }))
        .orderBy(r => r.id);

      expect(await expectBatchedLikeStandalone<any[]>(inJoin)).toEqual([{ id: flange, machineService: span(0, 45) }]);
    });

    test('a type-aware helper over a joined column renders as over a column of the queried table', async () => {
      const listed = () => db.jobs
        .innerJoin(db.machines, (j, m) => and(eq(j.machineId, m.id), eqAny(m.runtime, [600, 480])), (j, m) => ({ id: j.id, machineRuntime: m.runtime }))
        .orderBy(r => r.id);

      captured.length = 0;
      expect(await listed().toList()).toEqual([
        { id: shaft, machineRuntime: 600 },
        { id: flange, machineRuntime: 480 },
      ]);
      expect(loggedSelects()[0]).toContain('("mjc_machines_0"."runtime" = ANY($1::integer[]))');

      captured.length = 0;
      await db.machines.where(m => eqAny(m.runtime, [600, 480])).toList();
      expect(loggedSelects()[0]).toContain('("mjc_machines"."runtime" = ANY($1::integer[]))');
    });
  });
});

/**
 * A table joined in from ANOTHER context: its column refs carry their table's type and mapper, and every
 * read takes them — also when the reading context's schema registry does not hold that table, and when
 * it maps the same table otherwise (fewer columns). Vessels berth at harbors; a harbor's `depth` is a
 * numeric, its `openedOn` a date and its `tide` a mapped interval.
 */
class MjvVessel extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  harborId!: DbColumn<number | null>;
}

class MjvHarbor extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  depth!: DbColumn<number>;
  openedOn!: DbColumn<Date>;
  tide!: DbColumn<Span>;
}

/** The same table, mapped by another context without its other columns. */
class MjvHarborName extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

const vesselModel = (model: DbModelConfig): void => {
  model.entity(MjvVessel, entity => {
    entity.toTable('mjv_vessels');
    entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
    entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
    entity.property(e => e.harborId).hasType(integer('harbor_id'));
  });
};

/** Knows vessels only. */
class VesselDatabase extends DbContext {
  get vessels(): DbEntityTable<MjvVessel> {
    return this.table(MjvVessel);
  }

  protected override setupModel(model: DbModelConfig): void {
    vesselModel(model);
  }
}

/** Knows harbors only. */
class HarborDatabase extends DbContext {
  get harbors(): DbEntityTable<MjvHarbor> {
    return this.table(MjvHarbor);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(MjvHarbor, entity => {
      entity.toTable('mjv_harbors');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.depth).hasType(numeric('depth', 8, 2)).isRequired();
      entity.property(e => e.openedOn).hasType(date('opened_on')).isRequired();
      entity.property(e => e.tide).hasType(integer('tide_minutes')).hasCustomMapper(spanType).isRequired();
    });
  }
}

/** Knows vessels, and the harbors table as names only. */
class VesselRosterDatabase extends DbContext {
  get vessels(): DbEntityTable<MjvVessel> {
    return this.table(MjvVessel);
  }

  get harborNames(): DbEntityTable<MjvHarborName> {
    return this.table(MjvHarborName);
  }

  protected override setupModel(model: DbModelConfig): void {
    vesselModel(model);
    model.entity(MjvHarborName, entity => {
      entity.toTable('mjv_harbors');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
    });
  }
}

describe('a table joined in from another context reads its columns as its own context maps them', () => {
  let client: DatabaseClient;
  let dbV: VesselDatabase;
  let dbH: HarborDatabase;
  let dbR: VesselRosterDatabase;
  let aurora: number;
  let borealis: number;

  const dropVesselTables = async (): Promise<void> => {
    await client.query('DROP TABLE IF EXISTS mjv_vessels CASCADE');
    await client.query('DROP TABLE IF EXISTS mjv_harbors CASCADE');
  };

  beforeAll(async () => {
    client = createFreshClient();
    dbV = new VesselDatabase(client);
    dbH = new HarborDatabase(client);
    dbR = new VesselRosterDatabase(client);

    await dropVesselTables();
    await dbH.getSchemaManager().ensureCreated();
    await dbV.getSchemaManager().ensureCreated();

    const day = (value: string) => value as unknown as Date;
    const [pier, dock] = await dbH.harbors.insertBulk([
      { name: 'Pier Nine', depth: 12.5, openedOn: day('2018-05-20'), tide: span(2, 15) },
      { name: 'Dock Two', depth: 8.75, openedOn: day('2020-11-02'), tide: span(1, 30) },
    ]).returning();
    const [auroraRow, borealisRow] = await dbV.vessels.insertBulk([
      { name: 'Aurora', harborId: pier.id },
      { name: 'Borealis', harborId: dock.id },
      { name: 'Drifter', harborId: null },
    ]).returning();
    aurora = auroraRow.id;
    borealis = borealisRow.id;
  });

  afterAll(async () => {
    await dropVesselTables();
    await dbV.dispose();
  });

  /** Standalone, then — built afresh — through a batch of its own in one round trip: the same rows. */
  const expectBatchedLikeStandalone = async (build: () => Batchable): Promise<any[]> => {
    const standalone = await build().toList();
    const batch = new QueryBatch();
    const key = batch.addList(build() as any, 'probe');
    const querySpy = jest.spyOn(client, 'query');

    try {
      await batch.executeBatch();
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }

    const batched = batch.getList(key as BatchListKey<unknown>);
    expect(batched).toEqual(standalone);
    expectSameShape(batched, standalone);

    return standalone;
  };

  const berths = (vessels: () => DbEntityTable<MjvVessel>) => () => vessels()
    .leftJoin(dbH.harbors, (v, h) => eq(v.harborId, h.id), (v, h) => ({
      id: v.id,
      harbor: h.name,
      depth: h.depth,
      openedOn: h.openedOn,
      tide: h.tide,
    }))
    .orderBy(r => r.id);

  const expectedBerths = () => [
    { id: aurora, harbor: 'Pier Nine', depth: 12.5, openedOn: localDay('2018-05-20'), tide: span(2, 15) },
    { id: borealis, harbor: 'Dock Two', depth: 8.75, openedOn: localDay('2020-11-02'), tide: span(1, 30) },
  ];

  test('a context whose registry does not hold the joined table', async () => {
    const rows = await expectBatchedLikeStandalone(berths(() => dbV.vessels));

    expect(rows.slice(0, 2)).toEqual(expectedBerths());
  });

  test('a context that maps the joined table otherwise (without these columns)', async () => {
    const rows = await expectBatchedLikeStandalone(berths(() => dbR.vessels));

    expect(rows.slice(0, 2)).toEqual(expectedBerths());
  });
});
