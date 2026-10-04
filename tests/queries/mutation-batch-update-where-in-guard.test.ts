import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  and, createCustomType, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, eqAny, gte, integer, isNull, lt,
  MutationBatch, notExists, serial, smallint, sql, text, varchar,
} from '../../src';
import type { Condition, DatabaseClient, UpdateWhereInLegOptions } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { createFreshClient } from '../utils/test-database';

/**
 * `MutationBatch.addUpdateWhereIn(table, column, values, set, id, { where })`: a guard over the target row, ANDed into
 * the leg's WHERE — `UPDATE t SET <set> WHERE "col" IN (…) AND (<guard>)` — the callback shape `addBulkUpdate`'s
 * `where` takes (a typed condition over the column row `t`), without the VALUES row the leg does not have. Only the
 * rows the guard lets through are updated, counted (`getAffectedCount`) and exposed to dependent legs.
 *
 * The matrix: table placement (public, schema-qualified) × guard (none; true for every row, for none, for some — one
 * column, a compound condition, a NOT EXISTS correlated to `t` over another table and over the SAME table, a
 * parameter-free IS NULL, a raw `sql` fragment) × ids (none, one, many with one missing, duplicated) × SET (constant
 * values through a column mapper, a lambda with an `sql` expression over the column) × options (none;
 * `exposeColumns` / `exposeOldColumns` read by two dependent legs; `ifFits`) × composition (the leg alone; between an
 * insert leg and a delete leg, so its parameters are renumbered). The ORACLE is the same update standalone —
 * `table.where(r => and(eqAny(r.id, ids), guard(r))).update(set)` (its RETURNING with `old` for what dependent legs
 * read) — from the same rows: the same rows written in every table, the same affected count. The standalone query
 * refuses a subquery over its own table correlated to its row, so for that guard the oracle is the update written as
 * SQL; and what every guard lets through of the seeded rows is also stated outright (the anchor). NEUTRALITY:
 * without `where` the leg compiles to exactly the 1.0.31 statement.
 */

type JobState = 'queued' | 'printing' | 'failed' | 'done' | 'jammed';

const STATE_CODES: Record<JobState, number> = { queued: 0, printing: 1, failed: 2, done: 3, jammed: 4 };

const stateOf = (code: unknown): JobState => (Object.keys(STATE_CODES) as JobState[]).find(state => STATE_CODES[state] === Number(code))!;

const stateMapper = createCustomType<{ data: JobState; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: JobState | null | undefined) => (value == null ? null : STATE_CODES[value]) as number,
  fromDriver: (value: any) => stateOf(value),
});

/** A print job — the table the update legs write */
class MbgJob extends DbEntity {
  id!: DbColumn<number>;
  queue!: DbColumn<string>;
  state!: DbColumn<JobState>;
  attempts!: DbColumn<number>;
  note?: DbColumn<string | null>;
  holds?: MbgHold[];
}

/** The same job, in a schema of its own: the target of a schema-qualified UPDATE */
class MbgDepotJob extends DbEntity {
  id!: DbColumn<number>;
  queue!: DbColumn<string>;
  state!: DbColumn<JobState>;
  attempts!: DbColumn<number>;
  note?: DbColumn<string | null>;
}

/** A hold on a job — what the correlated guard reads */
class MbgHold extends DbEntity {
  id!: DbColumn<number>;
  jobId!: DbColumn<number>;
  kind!: DbColumn<string>;
}

/** An event — what the other legs write */
class MbgEvent extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;
}

class GuardDatabase extends DbContext {
  get jobs(): DbEntityTable<MbgJob> {
    return this.table(MbgJob);
  }

  get depotJobs(): DbEntityTable<MbgDepotJob> {
    return this.table(MbgDepotJob);
  }

  get holds(): DbEntityTable<MbgHold> {
    return this.table(MbgHold);
  }

  get events(): DbEntityTable<MbgEvent> {
    return this.table(MbgEvent);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(MbgJob, entity => {
      entity.toTable('mbg_jobs');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.queue).hasType(text('queue')).isRequired();
      entity.property(e => e.state).hasType(smallint('state')).isRequired().hasCustomMapper(stateMapper);
      entity.property(e => e.attempts).hasType(integer('attempts')).isRequired();
      entity.property(e => e.note).hasType(text('note'));
      entity.hasMany(e => e.holds, () => MbgHold).withForeignKey(h => h.jobId).withPrincipalKey(j => j.id);
    });

    model.entity(MbgDepotJob, entity => {
      entity.toTable('mbg_depot_jobs');
      entity.toSchema('mbg_depot');
      entity.property(e => e.id).hasType(integer('id')).isPrimaryKey();
      entity.property(e => e.queue).hasType(text('queue')).isRequired();
      entity.property(e => e.state).hasType(smallint('state')).isRequired().hasCustomMapper(stateMapper);
      entity.property(e => e.attempts).hasType(integer('attempts')).isRequired();
      entity.property(e => e.note).hasType(text('note'));
    });

    model.entity(MbgHold, entity => {
      entity.toTable('mbg_holds');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.jobId).hasType(integer('job_id')).isRequired();
      entity.property(e => e.kind).hasType(varchar('kind', 20)).isRequired();
    });

    model.entity(MbgEvent, entity => {
      entity.toTable('mbg_events');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.label).hasType(varchar('label', 40)).isRequired();
    });
  }
}

type Placement = 'public' | 'schema';
type GuardKind = 'none' | 'all' | 'nothing' | 'partial' | 'compound' | 'correlated' | 'self-correlated' | 'param-free' | 'raw-sql';
type IdsKind = 'empty' | 'one' | 'many' | 'duplicated';
type SetKind = 'constant' | 'lambda';
type OptionKind = 'plain' | 'expose' | 'ifFits';
type Composition = 'alone' | 'between';

const PLACEMENTS: Placement[] = ['public', 'schema'];
const GUARD_KINDS: GuardKind[] = ['none', 'all', 'nothing', 'partial', 'compound', 'correlated', 'self-correlated', 'param-free', 'raw-sql'];
const IDS_KINDS: IdsKind[] = ['empty', 'one', 'many', 'duplicated'];
const SET_KINDS: SetKind[] = ['constant', 'lambda'];
const OPTION_KINDS: OptionKind[] = ['plain', 'expose', 'ifFits'];
const COMPOSITIONS: Composition[] = ['alone', 'between'];

const TABLE_SQL: Record<Placement, string> = { public: '"mbg_jobs"', schema: '"mbg_depot"."mbg_depot_jobs"' };

const IDS: Record<IdsKind, number[]> = { empty: [], one: [2], many: [1, 2, 3, 4, 5, 6, 99], duplicated: [5, 2, 5, 1, 2] };

/**
 * The seeded jobs, and what each guard lets through of them: every row (`attempts >= 0`); none (no job is jammed);
 * the printing ones (1, 2, 5); the printing ones under 3 attempts (1, 2); the jobs without a `hold` (1, 3, 4, 6 —
 * job 1's hold is an `audit`); the jobs whose queue has no failed job — a subquery over the SAME table, correlated to
 * the target row (1, 2, 5, 6); the jobs without a note (1, 3, 4, 5); the jobs at 1–2 attempts (2, 3).
 */
const SEED_JOBS = [
  { id: 1, queue: 'a', state: 'printing' as JobState, attempts: 0, note: null },
  { id: 2, queue: 'a', state: 'printing' as JobState, attempts: 2, note: 'slow' },
  { id: 3, queue: 'b', state: 'failed' as JobState, attempts: 1, note: null },
  { id: 4, queue: 'b', state: 'done' as JobState, attempts: 0, note: null },
  { id: 5, queue: 'c', state: 'printing' as JobState, attempts: 3, note: null },
  { id: 6, queue: 'c', state: 'queued' as JobState, attempts: 0, note: 'new' },
];

/** The parameters each guard binds */
const GUARD_PARAMETERS: Record<GuardKind, number> = {
  'none': 0, 'all': 1, 'nothing': 1, 'partial': 1, 'compound': 2, 'correlated': 1, 'self-correlated': 1, 'param-free': 0, 'raw-sql': 2,
};

/** The SET of the leg: two cells either way — a mapped constant and a plain one, or a mapped constant and an expression */
const SETS: Record<SetKind, Record<string, unknown> | ((job: any) => Record<string, unknown>)> = {
  constant: { state: 'queued', note: 'retry' },
  lambda: (job: any) => ({ state: 'queued', attempts: sql`${job.attempts} + ${1}` }),
};

/** The SET as the leg compiles it, its placeholders numbered from `next` */
const setSql = (kind: SetKind, next: () => string): string => (kind === 'constant'
  ? `"state" = ${next()}, "note" = ${next()}`
  : `"state" = ${next()}, "attempts" = "attempts" + ${next()}`);

describe('MutationBatch.addUpdateWhereIn: a guard ANDed into the leg\'s WHERE', () => {
  let client: DatabaseClient;
  let db: GuardDatabase;
  const captured: string[] = [];

  /**
   * The guards, over the row they are handed — the leg's column row `t`, or the standalone query's row; the
   * self-correlated one reads the leg's own table
   */
  const guardOf = (kind: GuardKind, placement: Placement): ((row: any) => Condition) | undefined => {
    switch (kind) {
      case 'none':
        return undefined;
      case 'all':
        return row => gte(row.attempts, 0);
      case 'nothing':
        return row => eq(row.state, 'jammed');
      case 'partial':
        return row => eq(row.state, 'printing');
      case 'compound':
        return row => and(eq(row.state, 'printing'), lt(row.attempts, 3));
      case 'correlated':
        return row => notExists(db.holds.where(h => and(eq(h.jobId, row.id), eq(h.kind, 'hold'))).select(h => ({ id: h.id })).asSubquery());
      case 'self-correlated':
        return row => notExists(tableOf(placement).where((x: any) => and(eq(x.queue, row.queue), eq(x.state, 'failed'))).select((x: any) => ({ id: x.id })).asSubquery());
      case 'param-free':
        return row => isNull(row.note);
      case 'raw-sql':
        return row => sql<boolean>`${row.attempts} BETWEEN ${1} AND ${2}`;
    }
  };

  /** The guard as the leg renders it after its IN list, whose last placeholder is `$<last>` */
  const guardSql = (kind: GuardKind, last: number): RegExp => {
    const p = (k: number) => `\\$${last + k}`;
    const patterns: Record<Exclude<GuardKind, 'none'>, string> = {
      'all': `"t"\\."attempts" >= ${p(1)}`,
      'nothing': `"t"\\."state" = ${p(1)}`,
      'partial': `"t"\\."state" = ${p(1)}`,
      'compound': `\\(?"t"\\."state" = ${p(1)} AND "t"\\."attempts" < ${p(2)}\\)?`,
      'correlated': `\\(NOT EXISTS \\(.*"mbg_holds"\\."job_id" = "t"\\."id".*${p(1)}.*\\)\\)`,
      'self-correlated': `\\(NOT EXISTS \\(.*= "t"\\."queue".*${p(1)}.*\\)\\)`,
      'param-free': `"t"\\."note" IS NULL`,
      'raw-sql': `"t"\\."attempts" BETWEEN ${p(1)} AND ${p(2)}`,
    };

    return new RegExp(`^${patterns[kind as Exclude<GuardKind, 'none'>]}$`, 's');
  };

  const tableOf = (placement: Placement): DbEntityTable<any> => (placement === 'public' ? db.jobs : db.depotJobs);

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new GuardDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS mbg_jobs, mbg_holds, mbg_events CASCADE');
    await client.query('DROP SCHEMA IF EXISTS mbg_depot CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS mbg_jobs, mbg_holds, mbg_events CASCADE');
    await client.query('DROP SCHEMA IF EXISTS mbg_depot CASCADE');
    await db.dispose();
  });

  /** The seeded rows again — one DELETE statement (a TRUNCATE per case costs PostgreSQL ~20 ms); the holds keep their ids */
  const reset = async (placement: Placement) => {
    await client.query(
      'WITH j AS (DELETE FROM mbg_jobs), d AS (DELETE FROM mbg_depot.mbg_depot_jobs), h AS (DELETE FROM mbg_holds) DELETE FROM mbg_events'
    );
    await tableOf(placement).insertBulk(SEED_JOBS);
    await client.query('INSERT INTO mbg_holds ("id", "job_id", "kind") VALUES (1, 2, \'hold\'), (2, 5, \'hold\'), (3, 1, \'audit\')');
    captured.length = 0;
  };

  /** Every row the legs can write, as stored: the jobs by id, the holds by id, the events' labels (their ids follow the legs' order) */
  const stored = async (placement: Placement) => {
    const row = (await client.query(
      `SELECT (SELECT COALESCE(json_agg(row_to_json(j) ORDER BY j."id"), '[]'::json) FROM ${TABLE_SQL[placement]} j) AS jobs,`
      + ' (SELECT COALESCE(json_agg(row_to_json(h) ORDER BY h."id"), \'[]\'::json) FROM mbg_holds h) AS holds,'
      + ' (SELECT COALESCE(json_agg(e."label"), \'[]\'::json) FROM mbg_events e) AS events'
    )).rows[0];
    const read = (raw: unknown) => (typeof raw === 'string' ? JSON.parse(raw) : raw);

    return { jobs: read(row.jobs), holds: read(row.holds), events: (read(row.events) as string[]).sort() };
  };

  /**
   * The oracle of the self-correlated guard, written by hand: the standalone query REFUSES a subquery over its own
   * table correlated to its row (both would render under the table's name), so the update the leg must equal is
   * stated as SQL — what the database itself makes of it
   */
  const selfCorrelatedUpdate = async (placement: Placement, ids: number[], setKind: SetKind) => {
    const set = setKind === 'constant' ? `"state" = ${STATE_CODES.queued}, "note" = 'retry'` : `"state" = ${STATE_CODES.queued}, "attempts" = t."attempts" + 1`;
    const result = await client.query(
      `UPDATE ${TABLE_SQL[placement]} AS t SET ${set} WHERE t."id" = ANY($1::integer[])`
      + ` AND NOT EXISTS (SELECT 1 FROM ${TABLE_SQL[placement]} x WHERE x."queue" = t."queue" AND x."state" = ${STATE_CODES.failed})`
      + ' RETURNING t."id" AS "id", t."attempts" AS "attempts", old."state" AS "oldState"',
      [`{${ids.join(',')}}`]
    );

    return result.rows.map((row: any) => ({ id: Number(row.id), attempts: Number(row.attempts), oldState: stateOf(row.oldState) }));
  };

  /** The text of the leg registered `index`-th, inside the batch's statement */
  const legText = (statement: string, index: number): string => {
    const match = new RegExp(`"__mb_${index}" AS \\(\\n([\\s\\S]*?)\\nRETURNING `).exec(statement);

    return match?.[1] ?? '';
  };

  for (const placement of PLACEMENTS) {
    for (const guard of GUARD_KINDS) {
      for (const idsKind of IDS_KINDS) {
        for (const setKind of SET_KINDS) {
          for (const option of OPTION_KINDS) {
            for (const composition of COMPOSITIONS) {
              test(`${placement} · guard ${guard} · ids ${idsKind} · set ${setKind} · ${option} · ${composition}`, async () => {
                const table = tableOf(placement);
                const ids = IDS[idsKind];
                const where = guardOf(guard, placement);
                const options: UpdateWhereInLegOptions = {
                  ...(where ? { where } : {}),
                  ...(option === 'expose' ? { exposeColumns: ['attempts'], exposeOldColumns: ['state'] } : {}),
                  ...(option === 'ifFits' ? { ifFits: true } : {}),
                };

                // The batch
                await reset(placement);
                const batch = new MutationBatch();

                if (composition === 'between') {
                  batch.addInsertBulk(db.events, [{ label: 'before-1' }, { label: 'before-2' }], 'before');
                }

                const key = batch.addUpdateWhereIn(table, 'id', ids, SETS[setKind], 'leg', options);

                expect(key).toEqual(ids.length === 0 ? null : { id: 'leg' });

                // What dependent legs read of the leg: its exposed new and old values, one event per exposed row
                const dependents = option === 'expose' && key != null;

                if (dependents) {
                  batch.addDependentInsert(db.events as any, { label: 'was-not-failed' }, { onLeg: key, whereColumn: 'old__state', whereNotEquals: STATE_CODES.failed }, 'log-old');
                  batch.addDependentInsert(db.events as any, { label: 'attempts-not-1' }, { onLeg: key, whereColumn: 'attempts', whereNotEquals: 1 }, 'log-new');
                }

                if (composition === 'between') {
                  batch.addDeleteWhereIn(db.holds, 'kind', ['audit'], 'after');
                }

                const parameters = batch.parameterCount;
                await batch.executeBatch();
                const statements = captured.filter(entry => entry.startsWith('WITH '));

                const got = {
                  leg: key != null ? batch.getAffectedCount(key) : 0,
                  logOld: dependents ? batch.getAffectedCount('log-old') : 0,
                  logNew: dependents ? batch.getAffectedCount('log-new') : 0,
                  before: composition === 'between' ? batch.getAffectedCount('before') : 0,
                  after: composition === 'between' ? batch.getAffectedCount('after') : 0,
                  rows: await stored(placement),
                };

                // The oracle: the same update standalone, from the same rows — then what the other legs write
                await reset(placement);
                const updated = guard === 'self-correlated'
                  ? await selfCorrelatedUpdate(placement, ids, setKind)
                  : await table
                    .where((row: any) => (where ? and(eqAny(row.id, ids), where(row)) : eqAny(row.id, ids)))
                    .update(SETS[setKind] as any)
                    .returning((row: any, old: any) => ({ id: row.id, attempts: row.attempts, oldState: old.state as JobState }));
                const logOld = dependents ? updated.filter(row => row.oldState !== 'failed').length : 0;
                const logNew = dependents ? updated.filter(row => row.attempts !== 1).length : 0;
                const events = [
                  ...(composition === 'between' ? ['before-1', 'before-2'] : []),
                  ...Array.from({ length: logOld }, () => 'was-not-failed'),
                  ...Array.from({ length: logNew }, () => 'attempts-not-1'),
                ];

                if (events.length > 0) {
                  await db.events.insertBulk(events.map(label => ({ label })));
                }

                const after = composition === 'between' ? await db.holds.where(h => eqAny(h.kind, ['audit'])).delete().affectedCount() : 0;

                expect(got).toEqual({
                  leg: updated.length,
                  logOld,
                  logNew,
                  before: composition === 'between' ? 2 : 0,
                  after,
                  rows: await stored(placement),
                });

                // ONE statement — none for a batch left without legs; the leg as compiled
                expect(statements).toHaveLength(batch.size > 0 ? 1 : 0);

                if (key == null) {
                  return;
                }

                const offset = composition === 'between' ? 2 : 0;
                let n = offset;
                const next = () => `$${++n}`;
                const set = setSql(setKind, next);
                const list = ids.map(() => next()).join(', ');
                const text = legText(statements[0], composition === 'between' ? 1 : 0);

                if (where == null) {
                  // Neutral: the 1.0.31 statement, byte for byte
                  expect(text).toBe(`UPDATE ${TABLE_SQL[placement]} SET ${set} WHERE "id" IN (${list})`);
                } else {
                  const head = `UPDATE ${TABLE_SQL[placement]} AS t SET ${set} WHERE "id" IN (${list}) AND (`;

                  expect(text.startsWith(head)).toBe(true);
                  expect(text.endsWith(')')).toBe(true);
                  expect(text.slice(head.length, -1)).toMatch(guardSql(guard, n));
                }

                expect(parameters).toBe((composition === 'between' ? 3 : 0) + 2 + ids.length + GUARD_PARAMETERS[guard] + (dependents ? 4 : 0));
              });
            }
          }
        }
      }
    }
  }

  test('the oracle\'s anchor: the jobs each guard lets through, read off the stored rows', async () => {
    const expected: Record<GuardKind, number[]> = {
      'none': [1, 2, 3, 4, 5, 6],
      'all': [1, 2, 3, 4, 5, 6],
      'nothing': [],
      'partial': [1, 2, 5],
      'compound': [1, 2],
      'correlated': [1, 3, 4, 6],
      'self-correlated': [1, 2, 5, 6],
      'param-free': [1, 3, 4, 5],
      'raw-sql': [2, 3],
    };
    const got: Record<string, number[]> = {};

    for (const placement of PLACEMENTS) {
      for (const guard of GUARD_KINDS) {
        await reset(placement);
        const batch = new MutationBatch();
        const where = guardOf(guard, placement);

        batch.addUpdateWhereIn(tableOf(placement), 'id', IDS.many, { note: 'retry' }, 'leg', where ? { where } : undefined);
        await batch.executeBatch();

        const retried = (await stored(placement)).jobs.filter((job: { note: string | null }) => job.note === 'retry').map((job: { id: number }) => job.id);

        got[`${placement} ${guard}`] = retried;
        expect(batch.getAffectedCount('leg')).toBe(retried.length);
      }
    }

    expect(got).toEqual(Object.fromEntries(PLACEMENTS.flatMap(placement => GUARD_KINDS.map(guard => [`${placement} ${guard}`, expected[guard]]))));
  });

  test('neutral: `where: undefined` compiles to the statement without the option', async () => {
    const run = async (options: UpdateWhereInLegOptions | undefined) => {
      await reset('public');
      const batch = new MutationBatch();

      batch.addUpdateWhereIn(db.jobs, 'id', [1, 2], { attempts: 9 }, 'leg', options);
      await batch.executeBatch();

      return { statements: captured.filter(entry => entry.startsWith('WITH ')), count: batch.getAffectedCount('leg') };
    };

    const plain = await run(undefined);

    expect(plain.statements).toEqual(['WITH "__mb_0" AS (\nUPDATE "mbg_jobs" SET "attempts" = $1 WHERE "id" IN ($2, $3)\nRETURNING 1\n)\nSELECT (SELECT count(*)::int FROM "__mb_0") AS "0"']);
    expect(await run({ where: undefined })).toEqual(plain);
    expect(await run({})).toEqual(plain);
  });

  test('the guard is compiled where the leg registers: a navigation of the target row is refused, nothing registered', () => {
    const batch = new MutationBatch();

    expect(() => batch.addUpdateWhereIn(db.jobs, 'id', [1], { attempts: 0 }, 'leg', { where: (t: any) => t.holds.exists() })).toThrow(
      'addUpdateWhereIn where: navigation "holds" is not available — only the row\'s own columns are in scope'
    );
    expect(batch.size).toBe(0);
  });

  test('a guard that lets nothing through: the leg counts 0, its dependents fire for nothing, the other legs write theirs', async () => {
    await reset('public');
    const batch = new MutationBatch();

    batch.addInsertBulk(db.events, [{ label: 'before' }], 'before');
    const key = batch.addUpdateWhereIn(db.jobs, 'id', [1, 2, 3], { state: 'queued' }, 'leg', { where: t => eq(t.queue, 'nowhere'), exposeOldColumns: ['state'] });
    batch.addDependentInsert(db.events as any, { label: 'requeued' }, { onLeg: key!, whereColumn: 'old__state', whereNotEquals: STATE_CODES.queued }, 'log');
    await batch.executeBatch();

    expect([batch.getAffectedCount('before'), batch.getAffectedCount(key!), batch.getAffectedCount('log')]).toEqual([1, 0, 0]);
    expect((await stored('public')).jobs).toEqual(SEED_JOBS.map(job => ({ ...job, state: STATE_CODES[job.state] })));
  });

  test('typings: `where` is a condition over the target row\'s columns — the table\'s own, typed by its entity', () => {
    const typed = (batch: MutationBatch) => {
      batch.addUpdateWhereIn(db.jobs, 'id', [1], { attempts: 0 }, 'a', { where: t => eq(t.state, 'printing') });
      batch.addUpdateWhereIn(db.jobs, 'id', [1], (j: any) => ({ attempts: sql`${j.attempts} + 1` }), 'b', {
        where: t => and(eq(t.state, 'printing'), isNull(t.note)),
        exposeColumns: ['attempts'],
        exposeOldColumns: ['state'],
        ifFits: true,
      });
      batch.addUpdateWhereIn(db.depotJobs, 'id', [1], { attempts: 0 }, 'c', { where: t => lt(t.attempts, 3) });
      // An untyped table: any column
      batch.addUpdateWhereIn(db.jobs as any, 'id', [1], { attempts: 0 }, 'd', { where: t => eq(t.whatever, 1) });
      // @ts-expect-error — the target row has the table's columns only
      batch.addUpdateWhereIn(db.jobs, 'id', [1], { attempts: 0 }, 'e', { where: t => eq(t.missing, 1) });
      // @ts-expect-error — a navigation is not in scope: the target row is a column row
      batch.addUpdateWhereIn(db.jobs, 'id', [1], { attempts: 0 }, 'f', { where: t => t.holds!.exists() });
      // @ts-expect-error — the guard is a condition
      batch.addUpdateWhereIn(db.jobs, 'id', [1], { attempts: 0 }, 'g', { where: t => t.state });
      // @ts-expect-error — the leg has no VALUES row: the guard takes the target row alone
      batch.addUpdateWhereIn(db.jobs, 'id', [1], { attempts: 0 }, 'h', { where: (t, v) => eq(t.attempts, v.attempts) });

      const options: UpdateWhereInLegOptions<MbgJob> = { where: t => gte(t.attempts, 0), exposeOldColumns: ['state'], ifFits: true };
      // @ts-expect-error — typed by the entity: a column of another table is not there
      const wrong: UpdateWhereInLegOptions<MbgHold> = { where: t => eq(t.attempts, 0) };

      return [options, wrong];
    };

    expect(typeof typed).toBe('function');
  });
});
