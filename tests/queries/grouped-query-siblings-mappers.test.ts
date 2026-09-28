import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createCustomType,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  eq,
  gt,
  integer,
  QueryBatch,
  serial,
  sql,
  varchar,
} from '../../src';
import { createFreshClient } from '../utils/test-database';

/**
 * Two things of a grouped select that are not about batching, found while batching it:
 *
 * 1. Sibling grouped selects of ONE `groupBy()` shared one ORDER BY list: `orderBy()` on one of them
 *    ordered the other too — a sibling that does not project the key failed (`column … does not
 *    exist`), one that does silently took the other's order.
 * 2. A grouping key read through the mapper found by its column NAME on the grouped table: a key read
 *    from a navigation or a joined table whose column is named like a mapped column of the grouped
 *    table went through THAT column's mapper; a mapped navigation column went through none.
 *
 * A small workshop (defined here). A job's `runtime` is MAPPED (minutes ↔ hours + minutes); a
 * machine's `runtime` is a plain integer (its hour counter) and its `service` interval is mapped —
 * a job has no column of that name.
 *
 *   machine  runtime  service   jobs (runtime, priority)
 *   Lathe    600      1h30      shaft (0h30, 1), flange (0h45, 2), bushing (0h30, 1)
 *   Press    480      0h45      bracket (1h30, 3), plate (1h00, 2)
 *   Mill     300      0h30      -
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

class WksMachine extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  runtime!: DbColumn<number>;
  service!: DbColumn<Span>;

  jobs?: WksJob[];
}

class WksJob extends DbEntity {
  id!: DbColumn<number>;
  machineId!: DbColumn<number>;
  title!: DbColumn<string>;
  runtime!: DbColumn<Span>;
  priority!: DbColumn<number>;

  machine?: WksMachine;
}

class WorkshopDatabase extends DbContext {
  get machines(): DbEntityTable<WksMachine> {
    return this.table(WksMachine);
  }

  get jobs(): DbEntityTable<WksJob> {
    return this.table(WksJob);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(WksMachine, entity => {
      entity.toTable('wks_machines');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.runtime).hasType(integer('runtime')).isRequired();
      entity.property(e => e.service).hasType(integer('service_minutes')).hasCustomMapper(spanType).isRequired();

      entity.hasMany(e => e.jobs, () => WksJob)
        .withForeignKey(j => j.machineId)
        .withPrincipalKey(m => m.id);
    });

    model.entity(WksJob, entity => {
      entity.toTable('wks_jobs');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.machineId).hasType(integer('machine_id')).isRequired();
      entity.property(e => e.title).hasType(varchar('title', 64)).isRequired();
      entity.property(e => e.runtime).hasType(integer('runtime_minutes')).hasCustomMapper(spanType).isRequired();
      entity.property(e => e.priority).hasType(integer('priority')).isRequired();

      entity.hasOne(e => e.machine, () => WksMachine)
        .withForeignKey(j => j.machineId)
        .withPrincipalKey(m => m.id);
    });
  }
}

const TABLES = ['wks_jobs', 'wks_machines'];

const dropTables = async (client: DatabaseClient): Promise<void> => {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};

const span = (hours: number, minutes: number): Span => ({ hours, minutes });

describe('grouped selects: siblings of one groupBy(), and the mapper a key reads through', () => {
  let db: WorkshopDatabase;
  let client: DatabaseClient;
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

    const [latheRow, pressRow] = await db.machines.insertBulk([
      { name: 'Lathe', runtime: 600, service: span(1, 30) },
      { name: 'Press', runtime: 480, service: span(0, 45) },
      { name: 'Mill', runtime: 300, service: span(0, 30) },
    ]).returning();
    lathe = latheRow.id;
    press = pressRow.id;

    await db.jobs.insertBulk([
      { machineId: lathe, title: 'shaft', runtime: span(0, 30), priority: 1 },
      { machineId: lathe, title: 'flange', runtime: span(0, 45), priority: 2 },
      { machineId: lathe, title: 'bushing', runtime: span(0, 30), priority: 1 },
      { machineId: press, title: 'bracket', runtime: span(1, 30), priority: 3 },
      { machineId: press, title: 'plate', runtime: span(1, 0), priority: 2 },
    ]);
  });

  afterAll(async () => {
    await dropTables(client);
    await db.dispose();
  });

  /** The last SELECT the context logged. */
  const lastSelect = (): string => {
    const statements = captured.filter(entry => entry.trimStart().startsWith('SELECT'));

    return statements[statements.length - 1].replace(/\s+/g, ' ');
  };

  describe('sibling grouped selects of one groupBy()', () => {
    /** One grouping; each test selects its siblings from it. */
    const jobsByMachine = () => db.jobs
      .select(j => ({ machineId: j.machineId, priority: j.priority, title: j.title }))
      .groupBy(r => ({ machineId: r.machineId }));

    test('a sibling that does not project the other\'s ORDER BY key runs — it used to fail naming it', async () => {
      const grouping = jobsByMachine();
      const byTotal = grouping.select(g => ({ machineId: g.key.machineId, total: g.sum(r => r.priority) })).orderBy(r => [[r.total, 'DESC']]);
      const counts = grouping.select(g => ({ machineId: g.key.machineId, jobs: g.count() }));

      const countRows = await counts.toList();

      expect([...countRows].sort((a, b) => a.machineId - b.machineId)).toEqual([
        { machineId: lathe, jobs: 3 },
        { machineId: press, jobs: 2 },
      ]);
      expect(await byTotal.toList()).toEqual([
        { machineId: press, total: 5 },
        { machineId: lathe, total: 4 },
      ]);
    });

    test('a sibling projecting the same fields keeps its own order — and one without orderBy() has none', async () => {
      const grouping = jobsByMachine();
      const mostJobs = grouping.select(g => ({ machineId: g.key.machineId, jobs: g.count() })).orderBy(r => [[r.jobs, 'DESC']]);
      const unordered = grouping.select(g => ({ machineId: g.key.machineId, jobs: g.count() }));
      const byMachineDesc = grouping.select(g => ({ machineId: g.key.machineId, jobs: g.count() })).orderBy(r => [[r.machineId, 'DESC']]);

      captured.length = 0;
      await unordered.toList();
      expect(lastSelect()).not.toContain('ORDER BY');

      expect(await byMachineDesc.toList()).toEqual([
        { machineId: press, jobs: 2 },
        { machineId: lathe, jobs: 3 },
      ]);
      expect(lastSelect()).toContain('ORDER BY "machineId" DESC');
      expect(lastSelect()).not.toContain('"jobs" DESC');

      expect(await mostJobs.toList()).toEqual([
        { machineId: lathe, jobs: 3 },
        { machineId: press, jobs: 2 },
      ]);
      expect(lastSelect()).toContain('ORDER BY "jobs" DESC');
      expect(lastSelect()).not.toContain('"machineId" DESC');
    });

    test('each sibling keeps its own ORDER BY and LIMIT — also through a batch', async () => {
      const grouping = jobsByMachine();
      const busiest = grouping.select(g => ({ machineId: g.key.machineId, total: g.sum(r => r.priority) })).orderBy(r => [[r.total, 'DESC']]).limit(1);
      const firstMachine = grouping.select(g => ({ machineId: g.key.machineId, jobs: g.count() })).orderBy(r => r.machineId).limit(1);

      expect(await firstMachine.toList()).toEqual([{ machineId: lathe, jobs: 3 }]);
      expect(await busiest.toList()).toEqual([{ machineId: press, total: 5 }]);

      const batch = new QueryBatch();
      const busiestKey = batch.addList(busiest, 'busiest');
      const firstKey = batch.addList(firstMachine, 'first');
      await batch.executeBatch();

      expect(batch.getList(busiestKey)).toEqual([{ machineId: press, total: 5 }]);
      expect(batch.getList(firstKey)).toEqual([{ machineId: lathe, jobs: 3 }]);
    });

    test('siblings keep their own HAVING — as they did', async () => {
      const grouping = jobsByMachine();
      const busy = grouping.select(g => ({ machineId: g.key.machineId })).having(g => gt(g.count(), 2));
      const all = grouping.select(g => ({ machineId: g.key.machineId }));

      expect(await busy.toList()).toEqual([{ machineId: lathe }]);
      expect((await all.toList()).map(r => r.machineId).sort((a, b) => a - b)).toEqual([lathe, press]);
    });
  });

  describe('the mapper a grouping key reads through is its SOURCE column\'s', () => {
    /** Jobs grouped by their machine's hour counter — a navigation column named like the job's MAPPED runtime. */
    const byMachineRuntime = () => db.jobs
      .select(j => ({ machineRuntime: j.machine!.runtime, priority: j.priority }))
      .groupBy(r => ({ machineRuntime: r.machineRuntime }))
      .select(g => ({ machineRuntime: g.key.machineRuntime, jobs: g.count() }))
      .orderBy(r => r.machineRuntime);

    test('a navigation column named like a mapped column of the grouped table: read as ITS column (unmapped)', async () => {
      expect(await byMachineRuntime().toList()).toEqual([
        { machineRuntime: 480, jobs: 2 },
        { machineRuntime: 600, jobs: 3 },
      ]);
    });

    test('a column of a manually joined table named like a mapped column of the grouped table: read as ITS column', async () => {
      const rows = await db.jobs
        .innerJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({ machineRuntime: m.runtime, title: j.title }))
        .groupBy(r => ({ machineRuntime: r.machineRuntime }))
        .select(g => ({ machineRuntime: g.key.machineRuntime, jobs: g.count() }))
        .orderBy(r => r.machineRuntime)
        .toList();

      expect(rows).toEqual([
        { machineRuntime: 480, jobs: 2 },
        { machineRuntime: 600, jobs: 3 },
      ]);
    });

    test('a MAPPED navigation column the grouped table has no column of: read through ITS mapper', async () => {
      const rows = await db.jobs
        .select(j => ({ service: j.machine!.service, priority: j.priority }))
        .groupBy(r => ({ service: r.service }))
        .select(g => ({ service: g.key.service, jobs: g.count() }))
        .orderBy(r => r.service)
        .toList();

      expect(rows).toEqual([
        { service: span(0, 45), jobs: 2 },
        { service: span(1, 30), jobs: 3 },
      ]);
    });

    test('the grouped table\'s own mapped column: through its mapper — as it was', async () => {
      const rows = await db.jobs
        .select(j => ({ runtime: j.runtime, title: j.title }))
        .groupBy(r => ({ runtime: r.runtime }))
        .select(g => ({ runtime: g.key.runtime, jobs: g.count() }))
        .orderBy(r => r.runtime)
        .toList();

      expect(rows).toEqual([
        { runtime: span(0, 30), jobs: 2 },
        { runtime: span(0, 45), jobs: 1 },
        { runtime: span(1, 0), jobs: 1 },
        { runtime: span(1, 30), jobs: 1 },
      ]);
    });

    test('a key NAMED like the mapped column but read from another column, or an expression: no mapper — as it was', async () => {
      const fromColumn = await db.jobs
        .select(j => ({ runtime: j.priority, title: j.title }))
        .groupBy(r => ({ runtime: r.runtime }))
        .select(g => ({ runtime: g.key.runtime, jobs: g.count() }))
        .orderBy(r => r.runtime)
        .toList();
      const fromExpression = await db.jobs
        .select(j => ({ runtime: sql<number>`${j.priority} * 10`, title: j.title }))
        .groupBy(r => ({ runtime: r.runtime }))
        .select(g => ({ runtime: g.key.runtime, jobs: g.count() }))
        .orderBy(r => r.runtime)
        .toList();

      expect(fromColumn).toEqual([{ runtime: 1, jobs: 2 }, { runtime: 2, jobs: 2 }, { runtime: 3, jobs: 1 }]);
      expect(fromExpression).toEqual([{ runtime: 10, jobs: 2 }, { runtime: 20, jobs: 2 }, { runtime: 30, jobs: 1 }]);
    });

    test('a MIN / MAX of such a navigation column: its own column — as it was', async () => {
      const rows = await db.jobs
        .select(j => ({ machineId: j.machineId, machineRuntime: j.machine!.runtime, service: j.machine!.service }))
        .groupBy(r => ({ machineId: r.machineId }))
        .select(g => ({ machineId: g.key.machineId, hours: g.max(r => r.machineRuntime), service: g.min(r => r.service) }))
        .orderBy(r => r.machineId)
        .toList();

      expect(rows).toEqual([
        { machineId: lathe, hours: 600, service: span(1, 30) },
        { machineId: press, hours: 480, service: span(0, 45) },
      ]);
    });

    test('a join of the grouped query reads the key as its source column', async () => {
      const machineNames = new DbCteBuilder().with('wks_machine_names', db.machines.select(m => ({ hours: m.runtime, name: m.name }))).cte;

      const rows = await byMachineRuntime()
        .leftJoin(
          machineNames,
          (grouped, names) => eq(grouped.machineRuntime, names.hours),
          (grouped, names) => ({ machineRuntime: grouped.machineRuntime, jobs: grouped.jobs, name: names.name })
        )
        .orderBy(r => r.machineRuntime)
        .toList();

      expect(rows).toEqual([
        { machineRuntime: 480, jobs: 2, name: 'Press' },
        { machineRuntime: 600, jobs: 3, name: 'Lathe' },
      ]);
    });

    test('a CTE of the grouped query hands its readers the key\'s source column (no mapper)', async () => {
      const loads = new DbCteBuilder().with('wks_machine_loads', byMachineRuntime()).cte;

      const rows = await db.machines
        .leftJoin(loads, (m, l) => eq(m.runtime, l.machineRuntime), (m, l) => ({ name: m.name, machineRuntime: l.machineRuntime, jobs: l.jobs }))
        .orderBy(r => r.name)
        .toList();

      expect(rows).toEqual([
        { name: 'Lathe', machineRuntime: 600, jobs: 3 },
        { name: 'Mill', machineRuntime: undefined, jobs: undefined },
        { name: 'Press', machineRuntime: 480, jobs: 2 },
      ] as any);
    });

    test('every key source reads the same through a batch', async () => {
      const builders = {
        navigation: byMachineRuntime,
        mappedNavigation: () => db.jobs
          .select(j => ({ service: j.machine!.service, priority: j.priority }))
          .groupBy(r => ({ service: r.service }))
          .select(g => ({ service: g.key.service, jobs: g.count() }))
          .orderBy(r => r.service),
        manualJoin: () => db.jobs
          .innerJoin(db.machines, (j, m) => eq(j.machineId, m.id), (j, m) => ({ machineRuntime: m.runtime, title: j.title }))
          .groupBy(r => ({ machineRuntime: r.machineRuntime }))
          .select(g => ({ machineRuntime: g.key.machineRuntime, jobs: g.count() }))
          .orderBy(r => r.machineRuntime),
      };

      const expected: Record<string, unknown[]> = {};
      for (const [name, build] of Object.entries(builders)) {
        expected[name] = await build().toList();
      }

      const batch = new QueryBatch();
      const keys = Object.fromEntries(Object.entries(builders).map(([name, build]) => [name, batch.addList(build() as any, name)]));
      await batch.executeBatch();

      for (const name of Object.keys(builders)) {
        expect(batch.getList(keys[name])).toEqual(expected[name]);
      }
      expect(expected.navigation).toEqual([{ machineRuntime: 480, jobs: 2 }, { machineRuntime: 600, jobs: 3 }]);
      expect(expected.mappedNavigation).toEqual([{ service: span(0, 45), jobs: 2 }, { service: span(1, 30), jobs: 3 }]);
    });
  });
});
