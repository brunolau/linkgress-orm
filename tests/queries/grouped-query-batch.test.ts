import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test';
import postgres from 'postgres';
import {
  agg,
  and,
  bigint,
  boolean,
  bytea,
  castAsDate,
  createCustomType,
  DatabaseClient,
  date,
  datePart,
  dateTrunc,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  doublePrecision,
  eq,
  FutureCountQuery,
  FutureQuery,
  FutureQueryRunner,
  FutureSingleQuery,
  GroupedJoinedQueryBuilder,
  GroupedSelectQueryBuilder,
  gt,
  gte,
  inArray,
  integer,
  isNotNull,
  jsonbBuildObject,
  lt,
  ne,
  numeric,
  PostgresClient,
  QueryBatch,
  serial,
  sql,
  timestamp,
  timestamptz,
  unnest,
  varchar,
} from '../../src';
import type { BatchCountKey, BatchItemKey, BatchListKey } from '../../src';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import type { AssertType, Equals } from '../utils/type-tester';

/**
 * Grouped queries (`.groupBy(...).select(...)`, and a grouped query joined to a CTE or a subquery) as
 * members of a QueryBatch: `future()`, `futureFirstOrDefault()` and `futureCount()` on both grouped
 * builders, the batch reading them in its ONE round trip, and every batched result identical to the
 * grouped query's own execution — the values AND their JS types (a Date stays a Date, an int8 / numeric
 * the driver's exact text, a Buffer a Buffer, a mapped column goes through its mapper) and each row's
 * key order.
 *
 * A small team tracker (defined here):
 *
 *   team      budget    members (joined on)
 *   Atlas     1250.50   Ana (2021-02-01), Ben (2022-06-15)
 *   Borealis   980.25   Cho (2020-11-30)
 *   Cygnus    3000.75   Dev (2023-01-09)            — no tasks
 *
 *   task  team      assignee  title    status   points  estimate  weight            due on      opened at            closed at (UTC)   effort  checksum  milestones
 *   T1    Atlas     Ana       alpha    open     3       2.50      9007199254740993  2024-03-04  2024-03-01 09:15:00  -                 1h30    01        03-04, 03-08
 *   T2    Atlas     Ana       beta     done     5       4.75      12                2024-03-04  2024-03-01 14:40:00  2024-03-05 10:00  2h30    02        03-08
 *   T3    Atlas     Ben       gamma    done     8       2.50      12                2024-03-11  2024-03-02 08:05:00  2024-03-12 16:30  0h45    01        -
 *   T4    Atlas     -         delta    open     1       1.25      7                 -           2024-03-02 17:20:00  -                 -       -         -
 *   T5    Borealis  Cho       epsilon  open     13      7.10      9007199254740993  2024-03-11  2024-03-03 11:00:00  -                 5h00    ff00      03-04
 *   T6    Borealis  Cho       zeta     done     2       4.75      7                 2024-03-18  2024-03-03 23:59:59  2024-03-19 08:00  0h45    02        (empty)
 *   T7    Borealis  -         eta      blocked  5       3.00      12                -           2024-03-04 06:30:00  -                 0h20    -         -
 *   T8    Atlas     Ben       theta    blocked  2       1.25      7                 2024-03-18  2024-03-04 12:00:00  -                 1h30    01        -
 *
 *   timesheet  task  member  logged on   minutes  billable  rate
 *   S1         T1    Ana     2024-03-04  30       yes       1.5
 *   S2         T1    Ana     2024-03-05  45       no        1.5
 *   S3         T2    Ana     2024-03-05  60       yes       2.25
 *   S4         T3    Ben     2024-03-11  15       yes       1
 *   S5         T5    Cho     2024-03-11  120      yes       3.5
 *   S6         T5    Cho     2024-03-12  90       no        3.5
 *   S7         T6    Cho     2024-03-18  30       yes       2
 *   S8         T8    Ben     2024-03-18  10       no        0.75
 *
 * Every value type a grouping reads back differently from its JSON form is here: int8 beyond 2^53 and
 * numeric (the drivers deliver their exact text), date / timestamp / timestamptz (Dates), bytea
 * (Buffers), a mapped column, NULL groups — as columns, as expressions (the grouped subquery form, whose
 * keys render as "q1"."key"), as aggregates, and on either side of a grouped join.
 */

interface Effort {
  hours: number;
  minutes: number;
}

/** Minutes of effort, stored as an integer and read back as hours + minutes. */
const effortType = createCustomType<{ data: Effort; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value: Effort | null | undefined) => (value == null ? null : value.hours * 60 + value.minutes) as number,
  fromDriver: (value: number | null | undefined) =>
    (value == null ? null : { hours: Math.floor(Number(value) / 60), minutes: Number(value) % 60 }) as Effort,
});

/**
 * A timestamp whose DRIVER value is the text-protocol string ('YYYY-MM-DD HH:MM:SS', a parser
 * passthrough) and whose value is its ISO 'T' form: a mapper doing string surgery on the driver text.
 * A Date passes through, for the Date-parsing drivers of the other tests.
 */
const textStampType = createCustomType<{ data: string; driverData: string }>({
  dataType: () => 'timestamp',
  toDriver: (value: string | null | undefined) => (value == null ? null : value.replace('T', ' ')) as string,
  fromDriver: (value: any) => (value == null ? null : typeof value === 'string' ? value.replace(' ', 'T') : value),
});

class GqbTeam extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  budget!: DbColumn<number>;

  tasks?: GqbTask[];
  members?: GqbMember[];
}

class GqbMember extends DbEntity {
  id!: DbColumn<number>;
  teamId!: DbColumn<number>;
  name!: DbColumn<string>;
  joinedOn!: DbColumn<Date>;

  team?: GqbTeam;
}

class GqbTask extends DbEntity {
  id!: DbColumn<number>;
  teamId!: DbColumn<number>;
  assigneeId?: DbColumn<number | null>;
  title!: DbColumn<string>;
  status!: DbColumn<string>;
  points!: DbColumn<number>;
  estimate!: DbColumn<number>;
  weight!: DbColumn<string>;
  dueOn?: DbColumn<Date | null>;
  openedAt!: DbColumn<Date>;
  closedAt?: DbColumn<Date | null>;
  effort?: DbColumn<Effort | null>;
  checksum?: DbColumn<Uint8Array | null>;
  milestones?: DbColumn<Date[] | null>;
  stampedAt?: DbColumn<string | null>;

  team?: GqbTeam;
  assignee?: GqbMember;
  timesheets?: GqbTimesheet[];
}

class GqbTimesheet extends DbEntity {
  id!: DbColumn<number>;
  taskId!: DbColumn<number>;
  memberId!: DbColumn<number>;
  loggedOn!: DbColumn<Date>;
  minutes!: DbColumn<number>;
  billable!: DbColumn<boolean>;
  rate!: DbColumn<number>;

  task?: GqbTask;
  member?: GqbMember;
}

class TeamTrackerDatabase extends DbContext {
  get teams(): DbEntityTable<GqbTeam> {
    return this.table(GqbTeam);
  }

  get members(): DbEntityTable<GqbMember> {
    return this.table(GqbMember);
  }

  get tasks(): DbEntityTable<GqbTask> {
    return this.table(GqbTask);
  }

  get timesheets(): DbEntityTable<GqbTimesheet> {
    return this.table(GqbTimesheet);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(GqbTeam, entity => {
      entity.toTable('gqb_teams');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.budget).hasType(numeric('budget', 12, 2)).isRequired();

      entity.hasMany(e => e.tasks, () => GqbTask)
        .withForeignKey(t => t.teamId)
        .withPrincipalKey(t => t.id);

      entity.hasMany(e => e.members, () => GqbMember)
        .withForeignKey(m => m.teamId)
        .withPrincipalKey(t => t.id);
    });

    model.entity(GqbMember, entity => {
      entity.toTable('gqb_members');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.teamId).hasType(integer('team_id')).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.joinedOn).hasType(date('joined_on')).isRequired();

      entity.hasOne(e => e.team, () => GqbTeam)
        .withForeignKey(m => m.teamId)
        .withPrincipalKey(t => t.id);
    });

    model.entity(GqbTask, entity => {
      entity.toTable('gqb_tasks');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.teamId).hasType(integer('team_id')).isRequired();
      entity.property(e => e.assigneeId).hasType(integer('assignee_id'));
      entity.property(e => e.title).hasType(varchar('title', 64)).isRequired();
      entity.property(e => e.status).hasType(varchar('status', 16)).isRequired();
      entity.property(e => e.points).hasType(integer('points')).isRequired();
      entity.property(e => e.estimate).hasType(numeric('estimate', 10, 2)).isRequired();
      entity.property(e => e.weight).hasType(bigint('weight')).isRequired();
      entity.property(e => e.dueOn).hasType(date('due_on'));
      entity.property(e => e.openedAt).hasType(timestamp('opened_at')).isRequired();
      entity.property(e => e.closedAt).hasType(timestamptz('closed_at'));
      entity.property(e => e.effort).hasType(integer('effort_minutes')).hasCustomMapper(effortType);
      entity.property(e => e.checksum).hasType(bytea('checksum'));
      entity.property(e => e.milestones).hasType(date('milestones').array());
      entity.property(e => e.stampedAt).hasType(timestamp('stamped_at')).hasCustomMapper(textStampType);

      entity.hasOne(e => e.team, () => GqbTeam)
        .withForeignKey(t => t.teamId)
        .withPrincipalKey(t => t.id);

      entity.hasOne(e => e.assignee, () => GqbMember)
        .withForeignKey(t => t.assigneeId!)
        .withPrincipalKey(m => m.id);

      entity.hasMany(e => e.timesheets, () => GqbTimesheet)
        .withForeignKey(s => s.taskId)
        .withPrincipalKey(t => t.id);
    });

    model.entity(GqbTimesheet, entity => {
      entity.toTable('gqb_timesheets');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.taskId).hasType(integer('task_id')).isRequired();
      entity.property(e => e.memberId).hasType(integer('member_id')).isRequired();
      entity.property(e => e.loggedOn).hasType(date('logged_on')).isRequired();
      entity.property(e => e.minutes).hasType(integer('minutes')).isRequired();
      entity.property(e => e.billable).hasType(boolean('billable')).isRequired();
      entity.property(e => e.rate).hasType(doublePrecision('rate')).isRequired();

      entity.hasOne(e => e.task, () => GqbTask)
        .withForeignKey(s => s.taskId)
        .withPrincipalKey(t => t.id);

      entity.hasOne(e => e.member, () => GqbMember)
        .withForeignKey(s => s.memberId)
        .withPrincipalKey(m => m.id);
    });
  }
}

const TABLES = ['gqb_timesheets', 'gqb_tasks', 'gqb_members', 'gqb_teams'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

interface TrackerIds {
  atlas: number;
  borealis: number;
  cygnus: number;
  ana: number;
  ben: number;
  cho: number;
  dev: number;
}

const seedTracker = async (db: TeamTrackerDatabase): Promise<TrackerIds> => {
  const [atlas, borealis, cygnus] = await db.teams.insertBulk([
    { name: 'Atlas', budget: 1250.5 },
    { name: 'Borealis', budget: 980.25 },
    { name: 'Cygnus', budget: 3000.75 },
  ]).returning();

  // A date binds as its 'YYYY-MM-DD' text and a timestamp WITHOUT time zone as its wall-clock text,
  // so every driver stores exactly these values whatever the process time zone is
  const day = (text: string) => text as unknown as Date;
  const days = (...texts: string[]) => texts as unknown as Date[];
  const bytes = (...values: number[]) => Uint8Array.from(values);

  const [ana, ben, cho, dev] = await db.members.insertBulk([
    { teamId: atlas.id, name: 'Ana', joinedOn: day('2021-02-01') },
    { teamId: atlas.id, name: 'Ben', joinedOn: day('2022-06-15') },
    { teamId: borealis.id, name: 'Cho', joinedOn: day('2020-11-30') },
    { teamId: cygnus.id, name: 'Dev', joinedOn: day('2023-01-09') },
  ]).returning();

  const tasks = await db.tasks.insertBulk([
    { teamId: atlas.id, assigneeId: ana.id, title: 'alpha', status: 'open', points: 3, estimate: 2.5, weight: '9007199254740993', dueOn: day('2024-03-04'), openedAt: day('2024-03-01 09:15:00'), closedAt: null, effort: { hours: 1, minutes: 30 }, checksum: bytes(1), milestones: days('2024-03-04', '2024-03-08') },
    { teamId: atlas.id, assigneeId: ana.id, title: 'beta', status: 'done', points: 5, estimate: 4.75, weight: '12', dueOn: day('2024-03-04'), openedAt: day('2024-03-01 14:40:00'), closedAt: new Date('2024-03-05T10:00:00Z'), effort: { hours: 2, minutes: 30 }, checksum: bytes(2), milestones: days('2024-03-08') },
    { teamId: atlas.id, assigneeId: ben.id, title: 'gamma', status: 'done', points: 8, estimate: 2.5, weight: '12', dueOn: day('2024-03-11'), openedAt: day('2024-03-02 08:05:00'), closedAt: new Date('2024-03-12T16:30:00Z'), effort: { hours: 0, minutes: 45 }, checksum: bytes(1), milestones: null },
    { teamId: atlas.id, assigneeId: null, title: 'delta', status: 'open', points: 1, estimate: 1.25, weight: '7', dueOn: null, openedAt: day('2024-03-02 17:20:00'), closedAt: null, effort: null, checksum: null, milestones: null },
    { teamId: borealis.id, assigneeId: cho.id, title: 'epsilon', status: 'open', points: 13, estimate: 7.1, weight: '9007199254740993', dueOn: day('2024-03-11'), openedAt: day('2024-03-03 11:00:00'), closedAt: null, effort: { hours: 5, minutes: 0 }, checksum: bytes(255, 0), milestones: days('2024-03-04') },
    { teamId: borealis.id, assigneeId: cho.id, title: 'zeta', status: 'done', points: 2, estimate: 4.75, weight: '7', dueOn: day('2024-03-18'), openedAt: day('2024-03-03 23:59:59'), closedAt: new Date('2024-03-19T08:00:00Z'), effort: { hours: 0, minutes: 45 }, checksum: bytes(2), milestones: days() },
    { teamId: borealis.id, assigneeId: null, title: 'eta', status: 'blocked', points: 5, estimate: 3, weight: '12', dueOn: null, openedAt: day('2024-03-04 06:30:00'), closedAt: null, effort: { hours: 0, minutes: 20 }, checksum: null, milestones: null },
    { teamId: atlas.id, assigneeId: ben.id, title: 'theta', status: 'blocked', points: 2, estimate: 1.25, weight: '7', dueOn: day('2024-03-18'), openedAt: day('2024-03-04 12:00:00'), closedAt: null, effort: { hours: 1, minutes: 30 }, checksum: bytes(1), milestones: null },
  ]).returning();

  const [t1, t2, t3, , t5, t6, , t8] = tasks;

  await db.timesheets.insertBulk([
    { taskId: t1.id, memberId: ana.id, loggedOn: day('2024-03-04'), minutes: 30, billable: true, rate: 1.5 },
    { taskId: t1.id, memberId: ana.id, loggedOn: day('2024-03-05'), minutes: 45, billable: false, rate: 1.5 },
    { taskId: t2.id, memberId: ana.id, loggedOn: day('2024-03-05'), minutes: 60, billable: true, rate: 2.25 },
    { taskId: t3.id, memberId: ben.id, loggedOn: day('2024-03-11'), minutes: 15, billable: true, rate: 1 },
    { taskId: t5.id, memberId: cho.id, loggedOn: day('2024-03-11'), minutes: 120, billable: true, rate: 3.5 },
    { taskId: t5.id, memberId: cho.id, loggedOn: day('2024-03-12'), minutes: 90, billable: false, rate: 3.5 },
    { taskId: t6.id, memberId: cho.id, loggedOn: day('2024-03-18'), minutes: 30, billable: true, rate: 2 },
    { taskId: t8.id, memberId: ben.id, loggedOn: day('2024-03-18'), minutes: 10, billable: false, rate: 0.75 },
  ]);

  return { atlas: atlas.id, borealis: borealis.id, cygnus: cygnus.id, ana: ana.id, ben: ben.id, cho: cho.id, dev: dev.id };
};

/** A date column's value as the drivers read it: local midnight of that day. */
const localDay = (text: string): Date => {
  const [year, month, dayOfMonth] = text.split('-').map(Number);

  return new Date(year, month - 1, dayOfMonth);
};

/** A timestamp-without-time-zone value as the drivers read it: that wall-clock time, local. */
const localTime = (text: string): Date => new Date(text.replace(' ', 'T'));

/** At runtime a grouping key IS its column ref (typed as its value for the projection). */
const keyRef = (key: unknown): any => key;

/**
 * Deep equality that also asserts every leaf's JS type (a Date stays a Date, a Buffer a Buffer, text
 * stays text) — and the key ORDER of a row (an object of a result list, or the one result).
 */
const expectSameShape = (batched: unknown, standalone: unknown, path = '$', isRow = false): void => {
  if (standalone === null || standalone === undefined) {
    expect({ path, value: batched }).toEqual({ path, value: standalone });

    return;
  }

  expect({ path, type: typeof batched }).toEqual({ path, type: typeof standalone });

  if (typeof standalone !== 'object') {
    expect({ path, value: batched }).toEqual({ path, value: standalone });

    return;
  }

  expect({ path, constructor: (batched as object).constructor }).toEqual({ path, constructor: (standalone as object).constructor });

  if (standalone instanceof Date) {
    expect({ path, time: (batched as Date).getTime() }).toEqual({ path, time: standalone.getTime() });

    return;
  }

  if (ArrayBuffer.isView(standalone)) {
    expect({ path, bytes: Array.from(batched as Uint8Array) }).toEqual({ path, bytes: Array.from(standalone as Uint8Array) });

    return;
  }

  if (Array.isArray(standalone)) {
    expect({ path, length: (batched as unknown[]).length }).toEqual({ path, length: standalone.length });
    standalone.forEach((item, ix) => expectSameShape((batched as unknown[])[ix], item, `${path}[${ix}]`, path === '$'));

    return;
  }

  const standaloneKeys = Object.keys(standalone);
  const batchedKeys = Object.keys(batched as object);

  // A row keeps the key order of the projection; a JSON document is compared by its keys
  expect({ path, keys: isRow ? batchedKeys : [...batchedKeys].sort() })
    .toEqual({ path, keys: isRow ? standaloneKeys : [...standaloneKeys].sort() });

  for (const key of standaloneKeys) {
    expectSameShape((batched as any)[key], (standalone as any)[key], `${path}.${key}`);
  }
};

/** Anything with the future factories QueryBatch reads — a grouped select, a grouped join, a plain select. */
interface Batchable {
  future(): FutureQuery<any>;
  futureFirstOrDefault(): FutureSingleQuery<any>;
  futureCount(): FutureCountQuery;
  toList(): Promise<any[]>;
  firstOrDefault(): Promise<any>;
}

describe('grouped queries in a QueryBatch', () => {
  let db: TeamTrackerDatabase;
  let client: DatabaseClient;
  let ids: TrackerIds;
  const captured: string[] = [];

  beforeAll(async () => {
    client = createFreshClient();
    db = new TeamTrackerDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });

    await dropTables(client);
    await db.getSchemaManager().ensureCreated();
    ids = await seedTracker(db);
  });

  afterAll(async () => {
    await dropTables(client);
    await db.dispose();
  });

  /** The statements logged since the last reset, without the logger's headers. */
  const statements = (): string[] => captured.filter(entry => !entry.trimStart().startsWith('['));

  /** Executes the batch, asserting it took exactly ONE round trip — one statement. Returns its SQL. */
  const executeInOneRoundTrip = async (batch: QueryBatch): Promise<string> => {
    const querySpy = jest.spyOn(client, 'query');
    captured.length = 0;

    try {
      await batch.executeBatch();

      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }

    const logged = statements();
    expect(logged).toHaveLength(1);

    return logged[0];
  };

  /**
   * Runs the query standalone (`toList()` / `firstOrDefault()`), then — built afresh — through a batch
   * of its own in one round trip, and asserts the two results are identical: values, JS types, row
   * key order. Returns the standalone result, for the test to pin what it is.
   */
  const expectBatchedLikeStandalone = async <T>(build: () => Batchable, kind: 'list' | 'first' = 'list'): Promise<T> => {
    const standalone = kind === 'list' ? await build().toList() : await build().firstOrDefault();

    const batch = new QueryBatch();
    const key = kind === 'list' ? batch.addList(build(), 'probe') : batch.addFirstOrDefault(build(), 'probe');
    await executeInOneRoundTrip(batch);
    const batched = kind === 'list' ? batch.getList(key as BatchListKey<unknown>) : batch.getItem(key as BatchItemKey<unknown>);

    expect(batched).toEqual(standalone);
    expectSameShape(batched, standalone, '$', kind === 'first');

    return standalone as T;
  };

  /** Tasks grouped by team: tasks, points and the last title per team (unordered — `orderBy()` appends a key). */
  const tasksPerTeamUnordered = () => db.tasks
    .select(t => ({ teamId: t.teamId, points: t.points, title: t.title }))
    .groupBy(r => ({ teamId: r.teamId }))
    .select(g => ({ teamId: g.key.teamId, tasks: g.count(), points: g.sum(r => r.points), lastTitle: g.max(r => r.title) }));

  /** Tasks per team, in team order. */
  const tasksPerTeam = () => tasksPerTeamUnordered().orderBy(r => r.teamId);

  /** Tasks grouped by the day they were opened on — an expression key: the grouped subquery form ("q1"). Unordered. */
  const tasksPerOpeningDayUnordered = () => db.tasks
    .select(t => ({ day: dateTrunc('day', t.openedAt), points: t.points }))
    .groupBy(r => ({ day: r.day }))
    .select(g => ({ day: g.key.day, tasks: g.count(), points: g.sum(r => r.points) }));

  /** Tasks per opening day, in day order. */
  const tasksPerOpeningDay = () => tasksPerOpeningDayUnordered().orderBy(r => r.day);

  /** A CTE of every member of every team (their joined-on date a `date` column). */
  const teamRosterCte = () => new DbCteBuilder().with(
    'gqb_team_roster',
    db.members.select(m => ({ rosterTeamId: m.teamId, memberName: m.name, joinedOn: m.joinedOn }))
  ).cte;

  /** Tasks per team LEFT JOINed to the team roster: a grouped join. */
  const tasksPerTeamWithRoster = () => db.tasks
    .select(t => ({ teamId: t.teamId, points: t.points }))
    .groupBy(r => ({ teamId: r.teamId }))
    .select(g => ({ teamId: g.key.teamId, tasks: g.count(), points: g.sum(r => r.points) }))
    .leftJoin(
      teamRosterCte(),
      (grouped, roster) => eq(grouped.teamId, roster.rosterTeamId),
      (grouped, roster) => ({ teamId: grouped.teamId, tasks: grouped.tasks, points: grouped.points, member: roster.memberName, joinedOn: roster.joinedOn })
    )
    .orderBy(r => [r.teamId, r.member]);

  describe('the grouped builders have the future API', () => {
    test('a grouped select: future(), futureFirstOrDefault() and futureCount() build the three futures', () => {
      const list = tasksPerTeam().future();
      const first = tasksPerTeam().futureFirstOrDefault();
      const count = tasksPerTeam().futureCount();

      expect(list).toBeInstanceOf(FutureQuery);
      expect(first).toBeInstanceOf(FutureSingleQuery);
      expect(count).toBeInstanceOf(FutureCountQuery);
      expect(list.getSql()).toContain('GROUP BY "gqb_tasks"."team_id"');
      expect(list.getParams()).toEqual([]);
      expect(first.getSql()).toMatch(/LIMIT 1$/);
      expect(count.getSql()).toMatch(/^SELECT COUNT\(\*\) as count FROM \(/);
    });

    test('a grouped join: future(), futureFirstOrDefault() and futureCount() build the three futures', () => {
      const joined = tasksPerTeamWithRoster();

      expect(joined).toBeInstanceOf(GroupedJoinedQueryBuilder);
      expect(joined.future()).toBeInstanceOf(FutureQuery);
      expect(joined.future().getSql()).toContain('LEFT JOIN "gqb_team_roster"');
      expect(tasksPerTeamWithRoster().futureFirstOrDefault()).toBeInstanceOf(FutureSingleQuery);
      expect(tasksPerTeamWithRoster().futureFirstOrDefault().getSql()).toMatch(/LIMIT 1$/);
      expect(tasksPerTeamWithRoster().futureCount()).toBeInstanceOf(FutureCountQuery);
    });

    test('addList(): a grouped read rides the batch and reads exactly what toList() reads', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(tasksPerTeam);

      expect(rows).toEqual([
        { teamId: ids.atlas, tasks: 5, points: 19, lastTitle: 'theta' },
        { teamId: ids.borealis, tasks: 3, points: 20, lastTitle: 'zeta' },
      ]);
    });

    test('addFirstOrDefault(): the first group, exactly as firstOrDefault() reads it', async () => {
      const first = await expectBatchedLikeStandalone<any>(() => tasksPerTeamUnordered().orderBy(r => [[r.points, 'DESC']]), 'first');

      expect(first).toEqual({ teamId: ids.borealis, tasks: 3, points: 20, lastTitle: 'zeta' });
    });

    test('addCount(): the number of groups', async () => {
      const batch = new QueryBatch();
      const teamsKey = batch.addCount(tasksPerTeam(), 'teams');
      const daysKey = batch.addCount(tasksPerOpeningDay(), 'days');
      await executeInOneRoundTrip(batch);

      expect(batch.getCount(teamsKey)).toBe((await tasksPerTeam().toList()).length);
      expect(batch.getCount(teamsKey)).toBe(2);
      expect(batch.getCount(daysKey)).toBe(4);
    });

    test('the futures also run on their own: execute() reads what toList() / firstOrDefault() read', async () => {
      expect(await tasksPerTeam().future().execute()).toEqual(await tasksPerTeam().toList());
      expect(await tasksPerTeam().futureFirstOrDefault().execute()).toEqual(await tasksPerTeam().firstOrDefault());
      expect(await tasksPerTeam().futureCount().execute()).toBe(2);
      expect(await tasksPerTeamWithRoster().future().execute()).toEqual(await tasksPerTeamWithRoster().toList());
      expect(await tasksPerTeamWithRoster().futureCount().execute()).toBe(3);
    });

    test('FutureQueryRunner runs grouped futures next to plain ones', async () => {
      const [perTeam, firstDay, teamCount, members] = await FutureQueryRunner.runAsync([
        tasksPerTeam().future(),
        tasksPerOpeningDay().futureFirstOrDefault(),
        tasksPerTeam().futureCount(),
        db.members.select(m => ({ name: m.name })).orderBy(m => m.name).future(),
      ] as const);

      expect(perTeam).toEqual(await tasksPerTeam().toList());
      expect(firstDay).toEqual({ day: localTime('2024-03-01 00:00:00'), tasks: 2, points: 8 });
      expect(teamCount).toBe(2);
      expect(members.map(m => m.name)).toEqual(['Ana', 'Ben', 'Cho', 'Dev']);
    });
  });

  describe('grouping keys', () => {
    test('several column keys', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, status: t.status, points: t.points }))
        .groupBy(r => ({ teamId: r.teamId, status: r.status }))
        .select(g => ({ teamId: g.key.teamId, status: g.key.status, tasks: g.count(), points: g.sum(r => r.points) }))
        .orderBy(r => [r.teamId, r.status]));

      expect(rows).toEqual([
        { teamId: ids.atlas, status: 'blocked', tasks: 1, points: 2 },
        { teamId: ids.atlas, status: 'done', tasks: 2, points: 13 },
        { teamId: ids.atlas, status: 'open', tasks: 2, points: 4 },
        { teamId: ids.borealis, status: 'blocked', tasks: 1, points: 5 },
        { teamId: ids.borealis, status: 'done', tasks: 1, points: 2 },
        { teamId: ids.borealis, status: 'open', tasks: 1, points: 13 },
      ]);
    });

    test('a nullable key: the NULL group reads null', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ assigneeId: t.assigneeId, title: t.title }))
        .groupBy(r => ({ assigneeId: r.assigneeId }))
        .select(g => ({ assigneeId: g.key.assigneeId, tasks: g.count(), first: g.min(r => r.title) }))
        .orderBy(r => [[r.assigneeId, 'ASC NULLS FIRST']]));

      expect(rows).toEqual([
        { assigneeId: null, tasks: 2, first: 'delta' },
        { assigneeId: ids.ana, tasks: 2, first: 'alpha' },
        { assigneeId: ids.ben, tasks: 2, first: 'gamma' },
        { assigneeId: ids.cho, tasks: 2, first: 'epsilon' },
      ]);
    });

    test('a date column key: every group a Date (local midnight), the NULL group null', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ dueOn: t.dueOn, points: t.points }))
        .groupBy(r => ({ dueOn: r.dueOn }))
        .select(g => ({ dueOn: g.key.dueOn, points: g.sum(r => r.points) }))
        .orderBy(r => r.dueOn));

      expect(rows).toEqual([
        { dueOn: localDay('2024-03-04'), points: 8 },
        { dueOn: localDay('2024-03-11'), points: 21 },
        { dueOn: localDay('2024-03-18'), points: 4 },
        { dueOn: null, points: 6 },
      ]);
      expect(rows[0].dueOn).toBeInstanceOf(Date);
    });

    test('a timestamptz column key: Dates of the exact instants', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ closedAt: t.closedAt, id: t.id }))
        .groupBy(r => ({ closedAt: r.closedAt }))
        .select(g => ({ closedAt: g.key.closedAt, tasks: g.count() }))
        .orderBy(r => r.closedAt));

      expect(rows.map(r => [r.closedAt === null ? null : (r.closedAt as Date).toISOString(), r.tasks])).toEqual([
        ['2024-03-05T10:00:00.000Z', 1],
        ['2024-03-12T16:30:00.000Z', 1],
        ['2024-03-19T08:00:00.000Z', 1],
        [null, 5],
      ]);
    });

    test('an expression key of a timestamp (dateTrunc — the "q1" subquery form): Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(tasksPerOpeningDay);

      expect(rows).toEqual([
        { day: localTime('2024-03-01 00:00:00'), tasks: 2, points: 8 },
        { day: localTime('2024-03-02 00:00:00'), tasks: 2, points: 9 },
        { day: localTime('2024-03-03 00:00:00'), tasks: 2, points: 15 },
        { day: localTime('2024-03-04 00:00:00'), tasks: 2, points: 7 },
      ]);
      expect(tasksPerOpeningDay().future().getSql()).toContain('"q1"."day"');
    });

    test('an expression key cast to a date (castAsDate): Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ day: castAsDate(t.openedAt), title: t.title }))
        .groupBy(r => ({ day: r.day }))
        .select(g => ({ day: g.key.day, titles: g.count(), first: g.min(r => r.title) }))
        .orderBy(r => [[r.day, 'DESC']]));

      expect(rows).toEqual([
        { day: localDay('2024-03-04'), titles: 2, first: 'eta' },
        { day: localDay('2024-03-03'), titles: 2, first: 'epsilon' },
        { day: localDay('2024-03-02'), titles: 2, first: 'delta' },
        { day: localDay('2024-03-01'), titles: 2, first: 'alpha' },
      ]);
    });

    test('a numeric column key: the exact decimal text the drivers deliver', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ estimate: t.estimate, id: t.id }))
        .groupBy(r => ({ estimate: r.estimate }))
        .select(g => ({ estimate: g.key.estimate, tasks: g.count() }))
        .orderBy(r => r.estimate));

      expect(rows).toEqual([
        { estimate: '1.25', tasks: 2 },
        { estimate: '2.50', tasks: 2 },
        { estimate: '3.00', tasks: 1 },
        { estimate: '4.75', tasks: 2 },
        { estimate: '7.10', tasks: 1 },
      ] as any);
    });

    test('a bigint column key beyond 2^53: its exact text', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ weight: t.weight, points: t.points }))
        .groupBy(r => ({ weight: r.weight }))
        .select(g => ({ weight: g.key.weight, points: g.sum(r => r.points) }))
        .orderBy(r => r.weight));

      expect(rows).toEqual([
        { weight: '7', points: 5 },
        { weight: '12', points: 18 },
        { weight: '9007199254740993', points: 16 },
      ]);
    });

    test('a numeric expression key (round — the "q1" form): the exact text', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ rounded: sql<string>`round(${t.estimate}, 0)`, title: t.title }))
        .groupBy(r => ({ rounded: r.rounded }))
        .select(g => ({ rounded: g.key.rounded, tasks: g.count(), last: g.max(r => r.title) }))
        .orderBy(r => r.rounded));

      expect(rows).toEqual([
        { rounded: '1', tasks: 2, last: 'theta' },
        { rounded: '3', tasks: 3, last: 'gamma' },
        { rounded: '5', tasks: 2, last: 'zeta' },
        { rounded: '7', tasks: 1, last: 'epsilon' },
      ]);
    });

    test('an integer expression key (length): numbers', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ size: sql<number>`length(${t.title})`, points: t.points }))
        .groupBy(r => ({ size: r.size }))
        .select(g => ({ size: g.key.size, tasks: g.count(), points: g.sum(r => r.points) }))
        .orderBy(r => r.size));

      expect(rows).toEqual([
        { size: 3, tasks: 1, points: 5 },
        { size: 4, tasks: 2, points: 7 },
        { size: 5, tasks: 4, points: 14 },
        { size: 7, tasks: 1, points: 13 },
      ]);
    });

    test('a text expression key with a column key, HAVING and ORDER BY over the "q1" keys', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ initial: sql<string>`upper(substr(${t.status}, 1, 1))`, teamId: t.teamId, points: t.points }))
        .groupBy(r => ({ initial: r.initial, teamId: r.teamId }))
        .having(g => and(ne(g.key.initial, 'B'), gt(g.sum(r => r.points), 2)))
        .select(g => ({ initial: g.key.initial, teamId: g.key.teamId, points: g.sum(r => r.points) }))
        .orderBy(r => [[r.points, 'DESC'], r.teamId]));

      expect(rows).toEqual([
        { initial: 'D', teamId: ids.atlas, points: 13 },
        { initial: 'O', teamId: ids.borealis, points: 13 },
        { initial: 'O', teamId: ids.atlas, points: 4 },
      ]);
    });

    test('a navigation column key: the join renders inside the batch branch', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamName: t.team!.name, budget: t.team!.budget, points: t.points }))
        .groupBy(r => ({ teamName: r.teamName, budget: r.budget }))
        .select(g => ({ teamName: g.key.teamName, budget: g.key.budget, points: g.sum(r => r.points) }))
        .orderBy(r => r.teamName));

      expect(rows).toEqual([
        { teamName: 'Atlas', budget: '1250.50', points: 19 },
        { teamName: 'Borealis', budget: '980.25', points: 20 },
      ] as any);
    });

    test('a key of a manually joined table: its column read as the joined table declares it', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .innerJoin(db.teams, (t, team) => eq(t.teamId, team.id), (t, team) => ({ budget: team.budget, teamName: team.name, points: t.points }))
        .groupBy(r => ({ budget: r.budget, teamName: r.teamName }))
        .select(g => ({ budget: g.key.budget, teamName: g.key.teamName, points: g.sum(r => r.points) }))
        .orderBy(r => r.teamName));

      expect(rows).toEqual([
        { budget: '1250.50', teamName: 'Atlas', points: 19 },
        { budget: '980.25', teamName: 'Borealis', points: 20 },
      ] as any);
    });

    test('a key of a set-returning lateral join (unnest of a date[] column): Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .crossJoinLateral(t => unnest(t.milestones), (t, milestone) => ({ milestone: milestone.value, points: t.points }), 'milestone')
        .groupBy(r => ({ milestone: r.milestone }))
        .select(g => ({ milestone: g.key.milestone, tasks: g.count(), points: g.sum(r => r.points) }))
        .orderBy(r => r.milestone));

      expect(rows).toEqual([
        { milestone: localDay('2024-03-04'), tasks: 2, points: 16 },
        { milestone: localDay('2024-03-08'), tasks: 2, points: 8 },
      ]);
    });

    test('a mapped column key: every group through the column mapper', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ effort: t.effort, id: t.id }))
        .groupBy(r => ({ effort: r.effort }))
        .select(g => ({ effort: g.key.effort, tasks: g.count() }))
        .orderBy(r => r.effort));

      expect(rows).toEqual([
        { effort: { hours: 0, minutes: 20 }, tasks: 1 },
        { effort: { hours: 0, minutes: 45 }, tasks: 2 },
        { effort: { hours: 1, minutes: 30 }, tasks: 2 },
        { effort: { hours: 2, minutes: 30 }, tasks: 1 },
        { effort: { hours: 5, minutes: 0 }, tasks: 1 },
        { effort: null, tasks: 1 },
      ]);
    });

    // A postgres.js client of its own, on the server's database — which a PGlite run does not build
    test.skipIf(process.env.LINKGRESS_TEST_DRIVER === 'pglite')('a timestamp key with a custom mapper gets the driver TEXT form through the batch, as standalone', async () => {
      // The app configures timestamp parser PASSTHROUGH — the driver delivers 'YYYY-MM-DD HH:MM:SS'
      // strings — and a custom mapper does string surgery on that text. The batch hands a mapped
      // key and a mapped MIN / MAX that text form, as a plain select's batch hands a mapped column.
      await db.tasks.where(t => inArray(t.title, ['alpha', 'beta'])).update({ stampedAt: '2024-03-01T09:15:00' });
      await db.tasks.where(t => eq(t.title, 'gamma')).update({ stampedAt: '2024-03-02T08:05:00' });

      const instance = postgres({
        ...testConnectionConfig(),
        max: 1,
        types: {
          timestamp: { to: 1114, from: [1114], serialize: (x: string) => x, parse: (x: string) => x },
        },
      });
      const textDb = new TeamTrackerDatabase(new PostgresClient(instance), { logQueries: false });

      try {
        const build = () => textDb.tasks
          .where(t => isNotNull(t.stampedAt))
          .select(t => ({ stampedAt: t.stampedAt, points: t.points }))
          .groupBy(r => ({ stampedAt: r.stampedAt }))
          .select(g => ({ stampedAt: g.key.stampedAt, points: g.sum(r => r.points), latest: g.max(r => r.stampedAt) }))
          .orderBy(r => r.stampedAt);

        const standalone = await build().toList();
        expect(standalone).toEqual([
          { stampedAt: '2024-03-01T09:15:00', points: 8, latest: '2024-03-01T09:15:00' },
          { stampedAt: '2024-03-02T08:05:00', points: 8, latest: '2024-03-02T08:05:00' },
        ]);

        const batch = new QueryBatch();
        const key = batch.addList(build(), 'stamps');
        await batch.executeBatch();

        expect(batch.getList(key)).toEqual(standalone);
        expectSameShape(batch.getList(key), standalone);
      } finally {
        await db.tasks.where(t => isNotNull(t.stampedAt)).update({ stampedAt: null });
        await instance.end();
      }
    });

    test('a bytea column key: Buffers', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ checksum: t.checksum, points: t.points }))
        .groupBy(r => ({ checksum: r.checksum }))
        .select(g => ({ checksum: g.key.checksum, points: g.sum(r => r.points) }))
        .orderBy(r => r.checksum));

      expect(rows.map(r => [r.checksum === null ? null : Array.from(r.checksum as Uint8Array), r.points])).toEqual([
        [[1], 13],
        [[2], 7],
        [[255, 0], 13],
        [null, 6],
      ]);
      expect(Buffer.isBuffer(rows[0].checksum)).toBe(true);
    });

    test('read-typed expressions (withReadType) read as their type through the batch', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ day: sql<Date>`CAST(${t.openedAt} AS date)`.withReadType('date'), weight: t.weight }))
        .groupBy(r => ({ day: r.day }))
        .select(g => ({
          day: g.key.day,
          heaviest: sql<number>`${g.max(r => r.weight)}`.withReadType('bigint'),
          span: sql<number>`${g.count()} * 1.5`.withReadType('numeric'),
          label: sql<string>`${g.count()} || ' tasks'`.withReadType('text'),
        }))
        .orderBy(r => r.day));

      expect(rows).toEqual([
        { day: localDay('2024-03-01'), heaviest: 9007199254740992, span: 3, label: '2 tasks' },
        { day: localDay('2024-03-02'), heaviest: 12, span: 3, label: '2 tasks' },
        { day: localDay('2024-03-03'), heaviest: 9007199254740992, span: 3, label: '2 tasks' },
        { day: localDay('2024-03-04'), heaviest: 12, span: 3, label: '2 tasks' },
      ]);
    });
  });

  describe('aggregates', () => {
    test('count / sum / avg / min / max of an integer column', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ status: t.status, points: t.points }))
        .groupBy(r => ({ status: r.status }))
        .select(g => ({
          status: g.key.status,
          n: g.count(),
          total: g.sum(r => r.points),
          mean: g.avg(r => r.points),
          least: g.min(r => r.points),
          most: g.max(r => r.points),
        }))
        .orderBy(r => r.status));

      expect(rows).toEqual([
        { status: 'blocked', n: 2, total: 7, mean: 3.5, least: 2, most: 5 },
        { status: 'done', n: 3, total: 15, mean: 5, least: 2, most: 8 },
        { status: 'open', n: 3, total: 17, mean: 17 / 3, least: 1, most: 13 },
      ]);
    });

    test('min / max of text, date, timestamp and timestamptz columns', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, title: t.title, dueOn: t.dueOn, openedAt: t.openedAt, closedAt: t.closedAt }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({
          teamId: g.key.teamId,
          firstTitle: g.min(r => r.title),
          lastDue: g.max(r => r.dueOn),
          firstOpened: g.min(r => r.openedAt),
          lastClosed: g.max(r => r.closedAt),
        }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        {
          teamId: ids.atlas,
          firstTitle: 'alpha',
          lastDue: localDay('2024-03-18'),
          firstOpened: localTime('2024-03-01 09:15:00'),
          lastClosed: new Date('2024-03-12T16:30:00Z'),
        },
        {
          teamId: ids.borealis,
          firstTitle: 'epsilon',
          lastDue: localDay('2024-03-18'),
          firstOpened: localTime('2024-03-03 11:00:00'),
          lastClosed: new Date('2024-03-19T08:00:00Z'),
        },
      ]);
    });

    test('min / max of numeric and bigint columns read numbers, as standalone', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, estimate: t.estimate, weight: t.weight }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, cheapest: g.min(r => r.estimate), priciest: g.max(r => r.estimate), heaviest: g.max(r => r.weight) }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, cheapest: 1.25, priciest: 4.75, heaviest: 9007199254740992 },
        { teamId: ids.borealis, cheapest: 3, priciest: 7.1, heaviest: 9007199254740992 },
      ] as any);
    });

    test('min / max of a mapped column go through its mapper', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, effort: t.effort }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, least: g.min(r => r.effort), most: g.max(r => r.effort) }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, least: { hours: 0, minutes: 45 }, most: { hours: 2, minutes: 30 } },
        { teamId: ids.borealis, least: { hours: 0, minutes: 20 }, most: { hours: 5, minutes: 0 } },
      ]);
    });

    test('sum / avg of numeric columns', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, estimate: t.estimate, weight: t.weight }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, estimated: g.sum(r => r.estimate), meanEstimate: g.avg(r => r.estimate), weights: g.sum(r => r.weight) }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, estimated: 12.25, meanEstimate: 2.45, weights: 9007199254741032 },
        { teamId: ids.borealis, estimated: 14.85, meanEstimate: 4.95, weights: 9007199254741012 },
      ]);
    });

    test('sum / avg of double precision columns and of an expression', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.timesheets
        .select(s => ({ memberId: s.memberId, minutes: s.minutes, rate: s.rate, cost: sql<number>`${s.minutes} * ${s.rate}` }))
        .groupBy(r => ({ memberId: r.memberId }))
        .select(g => ({ memberId: g.key.memberId, minutes: g.sum(r => r.minutes), meanRate: g.avg(r => r.rate), cost: g.sum(r => r.cost) }))
        .orderBy(r => r.memberId));

      expect(rows).toEqual([
        { memberId: ids.ana, minutes: 135, meanRate: 1.75, cost: 247.5 },
        { memberId: ids.ben, minutes: 25, meanRate: 0.875, cost: 22.5 },
        { memberId: ids.cho, minutes: 240, meanRate: 3, cost: 795 },
      ]);
    });

    test('agg.count().filter(), agg.countDistinct(), agg.sum({ distinct }) and agg.avg() over the grouped rows', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({
          teamId: g.key.teamId,
          all: agg.count(),
          open: agg.count().filter(sql<boolean>`"gqb_tasks"."status" = 'open'`),
          statuses: agg.countDistinct(sql`"gqb_tasks"."status"`),
          distinctPoints: agg.sum(sql`"gqb_tasks"."points"`, { distinct: true }),
          meanPoints: agg.avg(sql`"gqb_tasks"."points"`),
          laterTeams: agg.count().filter(gt(keyRef(g.key.teamId), ids.atlas)),
        }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, all: 5, open: 2, statuses: 3, distinctPoints: 19, meanPoints: 3.8, laterTeams: 0 },
        { teamId: ids.borealis, all: 3, open: 1, statuses: 3, distinctPoints: 20, meanPoints: 20 / 3, laterTeams: 3 },
      ]);
    });

    test('agg.arrayAgg with ORDER BY and DISTINCT, agg.jsonbAgg', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({
          teamId: g.key.teamId,
          titles: agg.arrayAgg(sql<string>`"gqb_tasks"."title"`, { orderBy: [[sql`"gqb_tasks"."title"`, 'DESC']] }),
          points: agg.arrayAgg(sql<number>`"gqb_tasks"."points"`, { distinct: true, orderBy: [[sql`"gqb_tasks"."points"`, 'ASC']] }),
          cards: agg.jsonbAgg(jsonbBuildObject({ t: sql`"gqb_tasks"."title"`, p: sql`"gqb_tasks"."points"` }), { orderBy: [[sql`"gqb_tasks"."title"`, 'ASC']] }),
        }))
        .orderBy(r => r.teamId));

      expect(rows.map(r => r.titles)).toEqual([['theta', 'gamma', 'delta', 'beta', 'alpha'], ['zeta', 'eta', 'epsilon']]);
      expect(rows.map(r => r.points)).toEqual([[1, 2, 3, 5, 8], [2, 5, 13]]);
      expect(rows[1].cards).toEqual([{ t: 'epsilon', p: 13 }, { t: 'eta', p: 5 }, { t: 'zeta', p: 2 }]);
    });

    test('agg.min / agg.max of date and timestamp values read Dates', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.timesheets
        .select(s => ({ billable: s.billable }))
        .groupBy(r => ({ billable: r.billable }))
        .select(g => ({
          billable: g.key.billable,
          firstDay: agg.min(sql<Date>`"gqb_timesheets"."logged_on"`),
          lastDay: agg.max(sql<Date>`"gqb_timesheets"."logged_on"`),
          lastLogged: agg.max(sql<Date>`CAST("gqb_timesheets"."logged_on" AS timestamp)`),
        }))
        .orderBy(r => r.billable));

      expect(rows).toEqual([
        { billable: false, firstDay: localDay('2024-03-05'), lastDay: localDay('2024-03-18'), lastLogged: localTime('2024-03-18 00:00:00') },
        { billable: true, firstDay: localDay('2024-03-04'), lastDay: localDay('2024-03-18'), lastLogged: localTime('2024-03-18 00:00:00') },
      ]);
    });

    test('an sql expression over aggregates reads as the driver delivers it — int8 / numeric text', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, points: t.points }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({
          teamId: g.key.teamId,
          perTask: sql`${g.sum(r => r.points)} / ${g.count()}`,
          share: sql`round(${g.sum(r => r.points)} * 100.0 / 39, 2)`,
          scaled: sql`${g.count()} * 1000`,
        }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, perTask: '3', share: '48.72', scaled: '5000' },
        { teamId: ids.borealis, perTask: '6', share: '51.28', scaled: '3000' },
      ]);
    });

    test('mapWith() and datePart() expressions read through their mappers', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ month: datePart('month', t.openedAt), points: t.points }))
        .groupBy(r => ({ month: r.month }))
        .select(g => ({
          month: g.key.month,
          label: sql<string>`count(*)`.mapWith((value: string) => `${value} tasks`),
          weighted: sql<string>`${g.sum(r => r.points)} * 2`.mapWith(Number),
        }))
        .orderBy(r => r.month));

      expect(rows).toEqual([{ month: 3, label: '8 tasks', weighted: 78 }]);
    });

    test('constants and NULL in the projection read back as themselves', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, kind: 'team', none: null, flag: true, big: 42, n: g.count() }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, kind: 'team', none: null, flag: true, big: 42, n: 5 },
        { teamId: ids.borealis, kind: 'team', none: null, flag: true, big: 42, n: 3 },
      ]);
    });

    test('aggregates over NULL-only groups and a projected condition', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .where(t => eq(t.status, 'open'))
        .select(t => ({ teamId: t.teamId, closedAt: t.closedAt, dueOn: t.dueOn }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({
          teamId: g.key.teamId,
          lastClosed: g.max(r => r.closedAt),
          anyClosed: isNotNull(keyRef(g.max(r => r.closedAt))),
          lastDue: g.max(r => r.dueOn),
        }))
        .orderBy(r => r.teamId));

      expect(rows).toEqual([
        { teamId: ids.atlas, lastClosed: null, anyClosed: false, lastDue: localDay('2024-03-04') },
        { teamId: ids.borealis, lastClosed: null, anyClosed: false, lastDue: localDay('2024-03-11') },
      ]);
    });
  });

  describe('HAVING, ORDER BY, paging and first', () => {
    test('HAVING over a count, ORDER BY an aggregate DESC: the batch keeps the order', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => db.timesheets
        .select(s => ({ loggedOn: s.loggedOn, minutes: s.minutes }))
        .groupBy(r => ({ loggedOn: r.loggedOn }))
        .having(g => gte(g.count(), 1))
        .select(g => ({ loggedOn: g.key.loggedOn, minutes: g.sum(r => r.minutes) }))
        .orderBy(r => [[r.minutes, 'DESC']]));

      expect(rows).toEqual([
        { loggedOn: localDay('2024-03-11'), minutes: 135 },
        { loggedOn: localDay('2024-03-05'), minutes: 105 },
        { loggedOn: localDay('2024-03-12'), minutes: 90 },
        { loggedOn: localDay('2024-03-18'), minutes: 40 },
        { loggedOn: localDay('2024-03-04'), minutes: 30 },
      ]);
    });

    test('HAVING parameters are renumbered after the branches before them', async () => {
      const heavyDays = () => tasksPerOpeningDay().having(g => gt(g.sum(r => r.points), 7));
      const standalone = await heavyDays().toList();

      const batch = new QueryBatch();
      const plainKey = batch.addList(db.members.where(m => eq(m.name, 'Cho')).select(m => ({ name: m.name })), 'plain');
      const heavyKey = batch.addList(heavyDays(), 'heavy');
      const smallKey = batch.addList(tasksPerTeam().having(g => lt(g.count(), 4)), 'small');
      const statement = await executeInOneRoundTrip(batch);

      expect(batch.getList(plainKey)).toEqual([{ name: 'Cho' }]);
      expect(batch.getList(heavyKey)).toEqual(standalone);
      expectSameShape(batch.getList(heavyKey), standalone);
      expect(standalone.map(r => r.points)).toEqual([8, 9, 15]);
      expect(batch.getList(smallKey)).toEqual([{ teamId: ids.borealis, tasks: 3, points: 20, lastTitle: 'zeta' }]);
      expect(statement).toMatch(/HAVING SUM\("q1"\."__arg\d+"\) > \$2/);
      expect(statement).toMatch(/HAVING COUNT\(\*\) < \$3/);
    });

    test('LIMIT and OFFSET', async () => {
      const rows = await expectBatchedLikeStandalone<any[]>(() => tasksPerOpeningDay().limit(2).offset(1));

      expect(rows.map(r => r.points)).toEqual([9, 15]);
    });

    test('futureFirstOrDefault(): LIMIT 1 for the future only — the builder keeps its own paging', async () => {
      const grouped = tasksPerOpeningDayUnordered().orderBy(r => [[r.points, 'DESC']]);
      const future = grouped.futureFirstOrDefault();

      expect(future.getSql()).toMatch(/LIMIT 1$/);
      expect((await grouped.toList()).map(r => r.points)).toEqual([15, 9, 8, 7]);

      const batch = new QueryBatch();
      const key = batch.addFirstOrDefault(grouped, 'top');
      await executeInOneRoundTrip(batch);

      expect(batch.getItem(key)).toEqual({ day: localTime('2024-03-03 00:00:00'), tasks: 2, points: 15 });
      expect(await grouped.toList()).toHaveLength(4);
    });

    test('no groups: [] / null / 0', async () => {
      const none = () => tasksPerTeam().having(g => gt(g.count(), 99));
      const noRows = () => db.tasks
        .where(t => eq(t.status, 'archived'))
        .select(t => ({ status: t.status, due: t.dueOn }))
        .groupBy(r => ({ status: r.status }))
        .select(g => ({ status: g.key.status, lastDue: g.max(r => r.due) }));

      const batch = new QueryBatch();
      const listKey = batch.addList(none(), 'list');
      const itemKey = batch.addFirstOrDefault(noRows(), 'item');
      const countKey = batch.addCount(noRows(), 'count');
      const emptyJoinKey = batch.addList(tasksPerTeamWithRoster().limit(0), 'join');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(listKey)).toEqual([]);
      expect(batch.getItem(itemKey)).toBeNull();
      expect(batch.getCount(countKey)).toBe(0);
      expect(batch.getList(emptyJoinKey)).toEqual([]);
      expect(await none().toList()).toEqual([]);
      expect(await noRows().firstOrDefault()).toBeNull();
    });

    test('futureCount() counts the groups HAVING keeps — ORDER BY, LIMIT and OFFSET aside', async () => {
      const paged = () => tasksPerOpeningDay().having(g => gt(g.sum(r => r.points), 7)).limit(1).offset(1);

      const batch = new QueryBatch();
      const pageKey = batch.addList(paged(), 'page');
      const countKey = batch.addCount(paged(), 'total');
      const allKey = batch.addCount(tasksPerOpeningDay(), 'all');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(pageKey)).toEqual([{ day: localTime('2024-03-02 00:00:00'), tasks: 2, points: 9 }]);
      expect(batch.getCount(countKey)).toBe(3);
      expect(batch.getCount(allKey)).toBe(4);
      expect(paged().futureCount().getSql()).not.toMatch(/LIMIT|OFFSET|ORDER BY/);
      expect(await paged().futureCount().execute()).toBe(3);
    });
  });

  describe('grouped joins', () => {
    test('LEFT JOIN a CTE: its date column, and the unmatched side reading null', async () => {
      const withoutCho = () => new DbCteBuilder().with(
        'gqb_roster_without_cho',
        db.members.where(m => ne(m.name, 'Cho')).select(m => ({ rosterTeamId: m.teamId, memberName: m.name, joinedOn: m.joinedOn }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, points: t.points }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, tasks: g.count(), points: g.sum(r => r.points) }))
        .leftJoin(
          withoutCho(),
          (grouped, roster) => eq(grouped.teamId, roster.rosterTeamId),
          (grouped, roster) => ({ teamId: grouped.teamId, tasks: grouped.tasks, points: grouped.points, member: roster.memberName, joinedOn: roster.joinedOn })
        )
        .orderBy(r => [r.teamId, r.member]));

      expect(rows).toEqual([
        { teamId: ids.atlas, tasks: 5, points: 19, member: 'Ana', joinedOn: localDay('2021-02-01') },
        { teamId: ids.atlas, tasks: 5, points: 19, member: 'Ben', joinedOn: localDay('2022-06-15') },
        { teamId: ids.borealis, tasks: 3, points: 20, member: null, joinedOn: null },
      ] as any);
    });

    test('INNER JOIN a table subquery: its numeric column and the grouped date / bigint extremes', async () => {
      const teams = db.teams.select(t => ({ id: t.id, name: t.name, budget: t.budget })).asSubquery('table');

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ teamId: t.teamId, dueOn: t.dueOn, weight: t.weight }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, lastDue: g.max(r => r.dueOn), heaviest: g.max(r => r.weight), tasks: g.count() }))
        .innerJoin(
          teams,
          (grouped, team) => eq(grouped.teamId, team.id),
          (grouped, team) => ({ name: team.name, budget: team.budget, lastDue: grouped.lastDue, heaviest: grouped.heaviest, tasks: grouped.tasks }),
          'team'
        )
        .orderBy(r => r.name));

      expect(rows).toEqual([
        { name: 'Atlas', budget: '1250.50', lastDue: localDay('2024-03-18'), heaviest: 9007199254740992, tasks: 5 },
        { name: 'Borealis', budget: '980.25', lastDue: localDay('2024-03-18'), heaviest: 9007199254740992, tasks: 3 },
      ] as any);
    });

    test('INNER JOIN a subquery whose columns are expressions: each read by its runtime type', async () => {
      const tenure = db.members
        .select(m => ({ memberTeamId: m.teamId, weekAfter: sql<Date>`${m.joinedOn} + 7`, year: sql<string>`extract(year from ${m.joinedOn})` }))
        .asSubquery('table');

      const rows = await expectBatchedLikeStandalone<any[]>(() => tasksPerTeamUnordered()
        .innerJoin(
          tenure,
          (grouped, member) => eq(grouped.teamId, member.memberTeamId),
          (grouped, member) => ({ teamId: grouped.teamId, tasks: grouped.tasks, weekAfter: member.weekAfter, year: member.year }),
          'tenure'
        )
        .orderBy(r => [r.teamId, r.weekAfter]));

      expect(rows).toEqual([
        { teamId: ids.atlas, tasks: 5, weekAfter: localDay('2021-02-08'), year: '2021' },
        { teamId: ids.atlas, tasks: 5, weekAfter: localDay('2022-06-22'), year: '2022' },
        { teamId: ids.borealis, tasks: 3, weekAfter: localDay('2020-12-07'), year: '2020' },
      ]);
    });

    test('LEFT JOIN a withAggregation CTE: its JSON list travels as the driver parses it', async () => {
      const lists = () => new DbCteBuilder().withAggregation(
        'gqb_member_lists',
        db.members.where(m => ne(m.name, 'Ben')).select(m => ({ listTeamId: m.teamId, name: m.name, joinedOn: m.joinedOn })),
        m => ({ listTeamId: m.listTeamId }),
        'people'
      );

      const rows = await expectBatchedLikeStandalone<any[]>(() => tasksPerTeamUnordered()
        .leftJoin(
          lists(),
          (grouped, list) => eq(grouped.teamId, list.listTeamId),
          (grouped, list) => ({ teamId: grouped.teamId, points: grouped.points, people: list.people })
        )
        .orderBy(r => r.teamId));

      expect(rows.map(r => [r.teamId, r.points, r.people.map((person: any) => person.name)])).toEqual([
        [ids.atlas, 19, ['Ana']],
        [ids.borealis, 20, ['Cho']],
      ]);
    });

    test('a join of an expression-keyed grouping (the "q1" form inside the left subquery)', async () => {
      const minutesPerDay = new DbCteBuilder().with(
        'gqb_minutes_per_day',
        db.timesheets.select(s => ({ loggedOn: s.loggedOn, minutes: s.minutes }))
      ).cte;

      const rows = await expectBatchedLikeStandalone<any[]>(() => db.tasks
        .select(t => ({ day: castAsDate(t.openedAt), points: t.points }))
        .groupBy(r => ({ day: r.day }))
        .select(g => ({ day: g.key.day, points: g.sum(r => r.points) }))
        .leftJoin(
          minutesPerDay,
          (grouped, logged) => eq(grouped.day, logged.loggedOn),
          (grouped, logged) => ({ day: grouped.day, points: grouped.points, loggedOn: logged.loggedOn, minutes: logged.minutes })
        )
        .orderBy(r => [r.day, r.minutes]));

      expect(rows).toEqual([
        { day: localDay('2024-03-01'), points: 8, loggedOn: null, minutes: null },
        { day: localDay('2024-03-02'), points: 9, loggedOn: null, minutes: null },
        { day: localDay('2024-03-03'), points: 15, loggedOn: null, minutes: null },
        { day: localDay('2024-03-04'), points: 7, loggedOn: localDay('2024-03-04'), minutes: 30 },
      ] as any);
    });

    test('a joined projection\'s expressions and literals; first-or-default; a count past its LIMIT', async () => {
      const joined = () => tasksPerTeam()
        .leftJoin(
          teamRosterCte(),
          (grouped, roster) => eq(grouped.teamId, roster.rosterTeamId),
          (grouped, roster) => ({
            teamId: grouped.teamId,
            member: roster.memberName,
            shout: sql<string>`upper(${roster.memberName})`,
            dayAfter: sql<Date>`${roster.joinedOn} + 1`,
            source: 'roster',
          })
        )
        .orderBy(r => [[r.teamId, 'DESC'], r.member]);

      const rows = await expectBatchedLikeStandalone<any[]>(joined);
      expect(rows).toEqual([
        { teamId: ids.borealis, member: 'Cho', shout: 'CHO', dayAfter: localDay('2020-12-01'), source: 'roster' },
        { teamId: ids.atlas, member: 'Ana', shout: 'ANA', dayAfter: localDay('2021-02-02'), source: 'roster' },
        { teamId: ids.atlas, member: 'Ben', shout: 'BEN', dayAfter: localDay('2022-06-16'), source: 'roster' },
      ]);

      const first = await expectBatchedLikeStandalone<any>(joined, 'first');
      expect(first).toEqual(rows[0]);

      const batch = new QueryBatch();
      const countKey = batch.addCount(joined().limit(1), 'rows');
      await executeInOneRoundTrip(batch);
      expect(batch.getCount(countKey)).toBe(3);
    });
  });

  describe('batch composition', () => {
    test('only grouped reads — selects and joins — in ONE round trip, each identical to standalone', async () => {
      const builders: Record<string, () => Batchable> = {
        perTeam: tasksPerTeam,
        perDay: tasksPerOpeningDay,
        withRoster: tasksPerTeamWithRoster,
        perMember: () => db.timesheets
          .select(s => ({ memberId: s.memberId, minutes: s.minutes }))
          .groupBy(r => ({ memberId: r.memberId }))
          .select(g => ({ memberId: g.key.memberId, minutes: g.sum(r => r.minutes) }))
          .orderBy(r => r.memberId),
      };

      const expected: Record<string, any[]> = {};
      for (const [name, build] of Object.entries(builders)) {
        expected[name] = await build().toList();
      }

      const batch = new QueryBatch();
      const keys = Object.fromEntries(Object.entries(builders).map(([name, build]) => [name, batch.addList(build(), name)]));
      const statement = await executeInOneRoundTrip(batch);

      expect(statement.match(/UNION ALL/g)).toHaveLength(3);
      expect(statement.match(/GROUP BY/g)!.length).toBeGreaterThanOrEqual(4);

      for (const name of Object.keys(builders)) {
        expect(batch.getList(keys[name])).toEqual(expected[name]);
        expectSameShape(batch.getList(keys[name]), expected[name]);
      }
      expect(expected.perMember.map(r => r.minutes)).toEqual([135, 25, 240]);
      expect(expected.withRoster.map(r => r.member)).toEqual(['Ana', 'Ben', 'Cho']);
    });

    test('only a branch with a value to send as its text pays for the fenced envelope; the others keep 1.0.10\'s row_to_json', async () => {
      const batch = new QueryBatch();
      const plainKey = batch.addList(db.members.select(m => ({ name: m.name, joinedOn: m.joinedOn })).orderBy(m => m.name), 'plain');
      const daysKey = batch.addList(tasksPerOpeningDay(), 'days');
      const teamsKey = batch.addList(tasksPerTeam(), 'teams');
      const weightsKey = batch.addList(db.tasks
        .select(t => ({ weight: t.weight }))
        .groupBy(r => ({ weight: r.weight }))
        .select(g => ({ weight: g.key.weight, n: g.count() }))
        .orderBy(r => r.weight), 'weights');
      const statement = await executeInOneRoundTrip(batch);
      const branches = statement.split('UNION ALL');

      expect(branches).toHaveLength(4);
      // A plain select (a declared date: revived as in 1.0.10) and a grouping of columns, counts and sums:
      // the envelope as it always was
      for (const ix of [0, 2]) {
        expect(branches[ix].trim()).toMatch(new RegExp(`^SELECT ${ix} AS __batch_ix, coalesce\\(json_agg\\(row_to_json\\(__batch_q\\)\\), '\\[\\]'::json\\) AS __batch_items FROM \\(\n`));
        expect(branches[ix].trim().endsWith('\n) __batch_q')).toBe(true);
        expect(branches[ix]).not.toContain('pg_typeof');
      }
      // An expression key and a declared int8 key: the rows themselves (as records), the value's texts when its
      // type needs them, its type ONCE for the branch — never in a row — over the query fenced to run once per row
      for (const [ix, column] of [[1, 'day'], [3, 'weight']] as const) {
        const value = `(__batch_q."${column}")`;
        // The type a domain is over when the server sends its text (a user-defined one): one catalog lookup
        expect(branches[ix]).toContain(`SELECT ${ix} AS __batch_ix, json_build_object('t', to_json(__batch_s.t::bigint[]), `
          + '\'d\', (SELECT json_object_agg(__batch_t.oid, __batch_t.typbasetype::bigint) FROM pg_catalog.pg_type __batch_t '
          + 'WHERE __batch_t.oid = ANY(__batch_s.t) AND __batch_t.typtype = \'d\' AND (__batch_t.oid >= 16384)), '
          + '\'r\', __batch_s.r, \'x\', to_json(__batch_s.x)) AS __batch_items ');
        expect(branches[ix]).toContain(`FROM (SELECT coalesce(json_agg(__batch_q.*), '[]'::json) AS r, ARRAY[json_agg(concat(${value})) FILTER (WHERE (pg_typeof(${value})::oid = ANY('{`);
        expect(branches[ix]).toContain(`ARRAY[min(pg_typeof(${value})::oid)] AS t FROM (SELECT * FROM (\n`);
        expect(branches[ix].trim().endsWith('\n) __batch_q0 OFFSET 0) __batch_q) __batch_s')).toBe(true);
      }
      expect(statement).not.toContain('to_jsonb');

      expect(batch.getList(plainKey).map(m => m.name)).toEqual(['Ana', 'Ben', 'Cho', 'Dev']);
      expect(batch.getList(daysKey)).toHaveLength(4);
      expect(batch.getList(teamsKey)).toHaveLength(2);
      expect(batch.getList(weightsKey)).toEqual([{ weight: '7', n: 3 }, { weight: '12', n: 3 }, { weight: '9007199254740993', n: 2 }]);
    });

    test('the same grouped query registered twice reads the same rows twice', async () => {
      const batch = new QueryBatch();
      const first = batch.addList(tasksPerOpeningDay(), 'first');
      const second = batch.addList(tasksPerOpeningDay(), 'second');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(first)).toEqual(batch.getList(second));
      expect(batch.getList(first)).toEqual(await tasksPerOpeningDay().toList());
      expect(batch.getList(first)).toHaveLength(4);
    });

    test('grouped reads next to a plain list, first, count and union — one round trip, parameters routed', async () => {
      const heavy = () => tasksPerTeam().having(g => gt(g.sum(r => r.points), 19));
      const openPerDay = () => db.tasks
        .where(t => eq(t.status, 'open'))
        .select(t => ({ day: castAsDate(t.openedAt), points: t.points }))
        .groupBy(r => ({ day: r.day }))
        .select(g => ({ day: g.key.day, points: g.sum(r => r.points) }))
        .orderBy(r => r.day);
      const plainList = () => db.tasks.where(t => gt(t.points, 7)).select(t => ({ title: t.title })).orderBy(t => t.title);
      const plainFirst = () => db.members.where(m => eq(m.name, 'Dev')).select(m => ({ name: m.name, joinedOn: m.joinedOn }));
      const plainCount = () => db.tasks.where(t => eq(t.status, 'blocked'));
      const union = () => db.members.where(m => eq(m.teamId, ids.atlas)).select(m => ({ name: m.name }))
        .unionAll(db.members.where(m => eq(m.teamId, ids.cygnus)).select(m => ({ name: m.name })))
        .orderBy((r: any) => r.name);

      const batch = new QueryBatch();
      const plainListKey = batch.addList(plainList(), 'plainList');
      const heavyKey = batch.addList(heavy(), 'heavy');
      const plainFirstKey = batch.addFirstOrDefault(plainFirst(), 'plainFirst');
      const openPerDayKey = batch.addList(openPerDay(), 'openPerDay');
      const plainCountKey = batch.addCount(plainCount(), 'plainCount');
      const unionKey = batch.addList(union(), 'union');
      const groupsKey = batch.addCount(openPerDay(), 'groups');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(plainListKey)).toEqual([{ title: 'epsilon' }, { title: 'gamma' }]);
      expect(batch.getList(heavyKey)).toEqual([{ teamId: ids.borealis, tasks: 3, points: 20, lastTitle: 'zeta' }]);
      expect(batch.getItem(plainFirstKey)).toEqual({ name: 'Dev', joinedOn: localDay('2023-01-09') });
      expect(batch.getList(openPerDayKey)).toEqual([
        { day: localDay('2024-03-01'), points: 3 },
        { day: localDay('2024-03-02'), points: 1 },
        { day: localDay('2024-03-03'), points: 13 },
      ]);
      expect(batch.getList(openPerDayKey)).toEqual(await openPerDay().toList());
      expect(batch.getCount(plainCountKey)).toBe(2);
      expect(batch.getList(unionKey)).toEqual([{ name: 'Ana' }, { name: 'Ben' }, { name: 'Dev' }]);
      expect(batch.getCount(groupsKey)).toBe(3);
    });

    test('inside a transaction: grouped reads share its connection and see its writes', async () => {
      await db.transaction(async trx => {
        const delta = await trx.tasks.where(t => eq(t.title, 'delta')).select(t => ({ id: t.id })).first();
        await trx.timesheets.insert({ taskId: delta!.id, memberId: ids.ben, loggedOn: '2024-03-20' as unknown as Date, minutes: 5, billable: true, rate: 1 });

        const perMember = () => trx.timesheets
          .select(s => ({ memberId: s.memberId, minutes: s.minutes, loggedOn: s.loggedOn }))
          .groupBy(r => ({ memberId: r.memberId }))
          .select(g => ({ memberId: g.key.memberId, minutes: g.sum(r => r.minutes), lastDay: g.max(r => r.loggedOn) }))
          .orderBy(r => r.memberId);
        const expected = await perMember().toList();

        const batch = new QueryBatch();
        const key = batch.addList(perMember(), 'perMember');
        const countKey = batch.addCount(trx.timesheets.where(s => eq(s.memberId, ids.ben)), 'benEntries');
        await batch.executeBatch();

        expect(batch.getList(key)).toEqual(expected);
        expectSameShape(batch.getList(key), expected);
        expect(expected.map(r => [r.minutes, r.lastDay])).toEqual([
          [135, localDay('2024-03-05')],
          [30, localDay('2024-03-20')],
          [240, localDay('2024-03-18')],
        ]);
        expect(batch.getCount(countKey)).toBe(3);

        throw new Error('roll back');
      }).catch((error: Error) => {
        expect(error.message).toBe('roll back');
      });

      expect(await db.timesheets.where(s => eq(s.memberId, ids.ben)).count()).toBe(2);
    });

    test('a future is fixed when it is created: changing the builder afterwards changes nothing', async () => {
      const grouped = tasksPerOpeningDay();
      const future = grouped.future();
      grouped.limit(1);

      const batch = new QueryBatch();
      const key = batch.addList({ future: () => future }, 'fixed');
      await executeInOneRoundTrip(batch);

      expect(batch.getList(key)).toHaveLength(4);
      expect(await grouped.toList()).toHaveLength(1);
    });

    test('a grouped query with a timeout of its own runs on its own executor — the batch refuses to mix it', async () => {
      const batch = new QueryBatch();
      batch.addList(tasksPerTeam(), 'shared');
      batch.addList(tasksPerOpeningDay().withTimeout(5000), 'own');

      await expectToReject(batch.executeBatch(), /"own" uses a different database client or transaction/);
    });

    test('batched rows keep the projection\'s key order, also for values that travel as text or typed', async () => {
      const build = () => db.tasks
        .select(t => ({ weight: t.weight, estimate: t.estimate, day: dateTrunc('day', t.openedAt), title: t.title }))
        .groupBy(r => ({ weight: r.weight, estimate: r.estimate, day: r.day }))
        .select(g => ({ z: g.key.weight, a: g.key.estimate, m: g.key.day, b: g.count(), y: g.max(r => r.title) }))
        .orderBy(r => [r.m, r.a]);

      const standalone = await build().toList();
      const batch = new QueryBatch();
      const key = batch.addList(build(), 'ordered');
      await executeInOneRoundTrip(batch);
      const batched = batch.getList(key);

      expect(standalone).toHaveLength(8);
      expect(batched.map(row => Object.keys(row))).toEqual(standalone.map(row => Object.keys(row)));
      expect(Object.keys(batched[0])).toEqual(['z', 'a', 'm', 'b', 'y']);
      expectSameShape(batched, standalone);
    });
  });

  describe('types', () => {
    test('future() is a FutureQuery of exactly the grouped projection — the element toList() reads', () => {
      const grouped = db.tasks
        .select(t => ({ teamId: t.teamId, points: t.points, openedAt: t.openedAt, title: t.title }))
        .groupBy(r => ({ teamId: r.teamId }))
        .select(g => ({ teamId: g.key.teamId, n: g.count(), total: g.sum(r => r.points), first: g.min(r => r.openedAt), last: g.max(r => r.title) }));

      const future = grouped.future();
      type Element = typeof future extends FutureQuery<infer R> ? R : never;
      type ListElement = Awaited<ReturnType<typeof grouped.toList>>[number];

      const sameAsList: Equals<Element, ListElement> = true;
      const exact: AssertType<Element, { teamId: number; n: number; total: number; first: Date; last: string }> = null as unknown as Element;
      expect(sameAsList).toBe(true);
      expect(exact).toBeNull();
      expect(grouped).toBeInstanceOf(GroupedSelectQueryBuilder);
    });

    test('futureFirstOrDefault() / futureCount() and the batch keys carry the projection type', () => {
      const first: FutureSingleQuery<{ teamId: number; tasks: number; points: number; lastTitle: string }> = tasksPerTeam().futureFirstOrDefault();
      const count: FutureCountQuery = tasksPerTeam().futureCount();

      const batch = new QueryBatch();
      const listKey = batch.addList(tasksPerOpeningDay(), 'days');
      const itemKey = batch.addFirstOrDefault(tasksPerTeam(), 'team');
      const countKey = batch.addCount(tasksPerTeam(), 'teams');

      const listKeyTyped: AssertType<typeof listKey, BatchListKey<{ day: Date; tasks: number; points: number }>> = listKey;
      const itemKeyTyped: AssertType<typeof itemKey, BatchItemKey<{ teamId: number; tasks: number; points: number; lastTitle: string }>> = itemKey;
      const countKeyTyped: BatchCountKey = countKey;

      // @ts-expect-error — the element is the projection, not any other shape
      const wrong: FutureQuery<{ teamId: string }> = tasksPerTeam().future();

      // The compile-time checks above are the point; at run time each value is what its type says
      expect(first).toBeInstanceOf(FutureSingleQuery);
      expect(count).toBeInstanceOf(FutureCountQuery);
      expect(wrong).toBeInstanceOf(FutureQuery);
      expect([listKeyTyped, itemKeyTyped, countKeyTyped]).toEqual([
        { id: 'days', kind: 'list' },
        { id: 'team', kind: 'first' },
        { id: 'teams', kind: 'count' },
      ]);
    });

    test('a grouped join\'s futures carry the joined projection type', () => {
      const joined = tasksPerTeamWithRoster();
      const future = joined.future();
      type Element = typeof future extends FutureQuery<infer R> ? R : never;
      type ListElement = Awaited<ReturnType<typeof joined.toList>>[number];

      const sameAsList: Equals<Element, ListElement> = true;
      const exact: AssertType<Element, { teamId: number; tasks: number; points: number; member: string; joinedOn: Date }> = null as unknown as Element;
      const single: FutureSingleQuery<Element> = tasksPerTeamWithRoster().futureFirstOrDefault();
      const count: FutureCountQuery = tasksPerTeamWithRoster().futureCount();

      expect(sameAsList).toBe(true);
      expect(exact).toBeNull();
      expect(single).toBeInstanceOf(FutureSingleQuery);
      expect(count).toBeInstanceOf(FutureCountQuery);
    });
  });
});
