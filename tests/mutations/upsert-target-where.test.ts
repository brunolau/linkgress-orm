import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  add, and, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, integer, isNotNull, isNull, literal, lower,
  MutationBatch, not, smallint, sql, text, boolean as pgBoolean, serial, varchar,
} from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * The typed `targetWhere` of an upsert — the `ON CONFLICT (<cols>) WHERE <predicate>` that makes a PARTIAL
 * unique index the arbiter. PostgreSQL infers the index at PLAN time from that predicate, so the typed form
 * renders the target row's columns UNQUALIFIED and refuses any bound parameter (a generic plan cannot prove
 * `x = $1` implies the index predicate — 42P10). Runs on PostgreSQL and on the in-memory engine, whose
 * arbiter inference normalises and compares the predicates as PostgreSQL's planner does for these spellings
 * (the in-memory guide lists the forms it does not prove).
 */

class TwOwner extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class TwLink extends DbEntity {
  id!: DbColumn<number>;
  ownerRef!: DbColumn<string>;
  slot!: DbColumn<number>;
  isCurrent!: DbColumn<boolean>;
  note?: DbColumn<string | null>;
  ownerId!: DbColumn<number | null>;
  owner?: TwOwner;
}

class TwIdentity extends DbEntity {
  id!: DbColumn<number>;
  provider!: DbColumn<string>;
  subject?: DbColumn<string | null>;
  active!: DbColumn<boolean>;
  hits!: DbColumn<number>;
}

/** One partial unique index per predicate shape: a smallint equality, a varchar equality, an IS NOT NULL. */
class TwTicket extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
  ref!: DbColumn<string>;
  seat!: DbColumn<number>;
  status!: DbColumn<number>;
  lane!: DbColumn<string>;
  holder?: DbColumn<string | null>;
}

class TargetWhereDatabase extends DbContext {
  get owners(): DbEntityTable<TwOwner> {
    return this.table(TwOwner);
  }

  get tickets(): DbEntityTable<TwTicket> {
    return this.table(TwTicket);
  }

  get links(): DbEntityTable<TwLink> {
    return this.table(TwLink);
  }

  get identities(): DbEntityTable<TwIdentity> {
    return this.table(TwIdentity);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(TwOwner, entity => {
      entity.toTable('tw_owners');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 40)).isRequired();
    });

    model.entity(TwLink, entity => {
      entity.toTable('tw_links');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.ownerRef).hasType(varchar('owner_ref', 40)).isRequired();
      entity.property(e => e.slot).hasType(integer('slot')).isRequired();
      entity.property(e => e.isCurrent).hasType(pgBoolean('is_current')).isRequired();
      entity.property(e => e.note).hasType(text('note'));
      entity.property(e => e.ownerId).hasType(integer('owner_id'));
      entity.hasOne(e => e.owner, () => TwOwner).withForeignKey(l => l.ownerId).withPrincipalKey(o => o.id);
      entity.hasIndex('ux_tw_links_current', e => [e.ownerRef, e.slot]).isUnique().where('is_current = true');
    });

    model.entity(TwIdentity, entity => {
      entity.toTable('tw_identities');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.provider).hasType(varchar('provider', 20)).isRequired();
      entity.property(e => e.subject).hasType(varchar('subject', 64));
      entity.property(e => e.active).hasType(pgBoolean('active')).isRequired();
      entity.property(e => e.hits).hasType(integer('hits')).isRequired();
      entity.hasIndex('ux_tw_identities_subject', e => [e.provider, e.subject]).isUnique().where('active = true AND subject IS NOT NULL');
    });

    model.entity(TwTicket, entity => {
      entity.toTable('tw_tickets');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.code).hasType(varchar('code', 20)).isRequired();
      entity.property(e => e.ref).hasType(varchar('ref', 20)).isRequired();
      entity.property(e => e.seat).hasType(integer('seat')).isRequired();
      entity.property(e => e.status).hasType(smallint('status')).isRequired();
      entity.property(e => e.lane).hasType(varchar('lane', 10)).isRequired();
      entity.property(e => e.holder).hasType(text('holder'));
      entity.hasIndex('ux_tw_tickets_open', e => [e.code]).isUnique().where('status = 1');
      entity.hasIndex('ux_tw_tickets_lane', e => [e.ref]).isUnique().where("lane = 'x'");
      entity.hasIndex('ux_tw_tickets_held', e => [e.seat]).isUnique().where('holder IS NOT NULL');
    });
  }
}

describe('upsert targetWhere (typed arbiter predicate)', () => {
  let client: DatabaseClient;
  let db: TargetWhereDatabase;
  const captured: string[] = [];

  const lastStatement = (fragment: string): string => {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].includes(fragment)) {
        return captured[i];
      }
    }
    throw new Error(`No captured statement contains ${fragment}`);
  };

  const dropTables = async () => {
    await client.query('DROP TABLE IF EXISTS tw_links CASCADE');
    await client.query('DROP TABLE IF EXISTS tw_identities CASCADE');
    await client.query('DROP TABLE IF EXISTS tw_tickets CASCADE');
    await client.query('DROP TABLE IF EXISTS tw_owners CASCADE');
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new TargetWhereDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await dropTables();
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await dropTables();
    await db.dispose();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE tw_links, tw_identities, tw_tickets, tw_owners RESTART IDENTITY');
    captured.length = 0;
  });

  const currentLink = (ownerRef: string, slot: number, note: string) => ({ ownerRef, slot, isCurrent: true, note });

  describe('rendering', () => {
    test('a single-conjunct predicate renders unqualified, the constant inline', async () => {
      await db.links.upsertBulk([currentLink('o1', 1, 'first')], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: e => eq(e.isCurrent, literal(true)),
        updateColumnFilter: () => false,
      });

      expect(lastStatement('ON CONFLICT')).toBe(
        'INSERT INTO "tw_links" ("owner_ref", "slot", "is_current", "note") VALUES ($1, $2, $3, $4) '
        + 'ON CONFLICT ("owner_ref", "slot") WHERE "is_current" = TRUE DO NOTHING'
      );
    });

    test('an AND predicate keeps its parentheses; the DO UPDATE arm is unaffected', async () => {
      await db.identities.upsertBulk([{ provider: 'g', subject: 's1', active: true, hits: 1 }], {
        primaryKey: ['provider', 'subject'],
        targetWhere: e => and(eq(e.active, literal(true)), isNotNull(e.subject)),
        updateSet: existing => ({ hits: add(existing.hits, literal(1)) }),
      });

      expect(lastStatement('ON CONFLICT')).toBe(
        'INSERT INTO "tw_identities" ("provider", "subject", "active", "hits") VALUES ($1, $2, $3, $4) '
        + 'ON CONFLICT ("provider", "subject") WHERE ("active" = TRUE AND "subject" IS NOT NULL) '
        + 'DO UPDATE SET "hits" = ("tw_identities"."hits" + 1)'
      );
    });

    test('the string form keeps rendering verbatim', async () => {
      await db.links.upsertBulk([currentLink('o1', 1, 'first')], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: 'is_current = true',
        updateColumnFilter: () => false,
      });

      expect(lastStatement('ON CONFLICT')).toContain('ON CONFLICT ("owner_ref", "slot") WHERE is_current = true DO NOTHING');
    });

    test('the MutationBatch upsert leg takes the same typed predicate', async () => {
      await db.links.insert(currentLink('o1', 1, 'existing'));
      captured.length = 0;

      const batch = new MutationBatch();
      const key = batch.addUpsertBulk(db.links, [currentLink('o1', 1, 'upserted'), currentLink('o1', 2, 'new')], {
        primaryKey: ['ownerRef', 'slot'],
        updateColumns: ['note'],
        targetWhere: e => eq(e.isCurrent, literal(true)),
      }, 'links');

      await batch.executeBatch();

      expect(batch.getAffectedCount(key!)).toBe(2);
      expect(lastStatement('WITH "__mb_0"')).toContain(
        'ON CONFLICT ("owner_ref", "slot") WHERE "is_current" = TRUE DO UPDATE SET "note" = EXCLUDED."note"'
      );
      const rows = await db.links.orderBy(l => l.slot).select(l => ({ slot: l.slot, note: l.note })).toList();
      expect(rows).toEqual([{ slot: 1, note: 'upserted' }, { slot: 2, note: 'new' }]);
    });

    test('the values() builder takes the same typed predicate', async () => {
      await db.links.insert(currentLink('o1', 1, 'existing'));

      await db.links.values(currentLink('o1', 1, 'ignored'))
        .onConflict(['owner_ref', 'slot'])
        .targetWhere(e => eq(e.isCurrent, literal(true)))
        .doNothing()
        .execute();

      expect(lastStatement('ON CONFLICT')).toContain('ON CONFLICT ("owner_ref", "slot") WHERE "is_current" = TRUE DO NOTHING');
      expect(await db.links.select(l => ({ note: l.note })).toList()).toEqual([{ note: 'existing' }]);
    });
  });

  describe('refusals', () => {
    const refusal = 'upsert targetWhere: the conflict-arbiter predicate must not bind parameters — PostgreSQL infers the partial unique index from it at plan time; write constants with literal()';

    test('a predicate that binds a parameter is refused before anything runs', async () => {
      await expectToReject(db.links.upsertBulk([currentLink('o1', 1, 'x')], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: e => eq(e.isCurrent, true),
        updateColumnFilter: () => false,
      }), refusal);

      expect(captured.some(line => line.includes('INSERT INTO'))).toBe(false);
    });

    test('a predicate reaching a placeholder is refused', async () => {
      await expectToReject(db.links.upsertBulk([currentLink('o1', 1, 'x')], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: e => eq(e.isCurrent, sql.placeholder('current')),
        updateColumnFilter: () => false,
      }), refusal);
    });

    test('the MutationBatch leg refuses a bound predicate at registration', () => {
      const batch = new MutationBatch();

      expect(() => batch.addUpsertBulk(db.links, [currentLink('o1', 1, 'x')], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: e => eq(e.slot, 1),
      }, 'links')).toThrow(refusal);
    });

    test('a navigation is not in scope in the arbiter predicate', async () => {
      await expectToReject(db.links.upsertBulk([currentLink('o1', 1, 'x')], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: (e: any) => eq(e.owner.name, literal('a')),
        updateColumnFilter: () => false,
      }), 'upsert targetWhere: navigation "owner" is not available — only the row\'s own columns are in scope');
    });
  });

  describe('arbiter inference (PostgreSQL and the in-memory engine)', () => {
    test('DO NOTHING: a current row arbitrates, a retired one does not', async () => {
      const upsert = (note: string) => db.links.upsertBulk([currentLink('o1', 1, note)], {
        primaryKey: ['ownerRef', 'slot'],
        targetWhere: e => eq(e.isCurrent, literal(true)),
        updateColumnFilter: () => false,
      });

      await upsert('first');
      await upsert('second — conflicts with the current row, skipped');
      expect(await db.links.select(l => ({ note: l.note, isCurrent: l.isCurrent })).toList()).toEqual([{ note: 'first', isCurrent: true }]);

      await db.links.update({ isCurrent: false });
      await upsert('third — the retired row is outside the index');

      const rows = await db.links.orderBy(l => l.id).select(l => ({ note: l.note, isCurrent: l.isCurrent })).toList();
      expect(rows).toEqual([
        { note: 'first', isCurrent: false },
        { note: 'third — the retired row is outside the index', isCurrent: true },
      ]);
    });

    test('DO UPDATE: the AND predicate infers the index and updates the active identity only', async () => {
      const upsert = (active: boolean) => db.identities.upsertBulk([{ provider: 'g', subject: 's1', active, hits: 1 }], {
        primaryKey: ['provider', 'subject'],
        targetWhere: e => and(eq(e.active, literal(true)), isNotNull(e.subject)),
        updateSet: existing => ({ hits: add(existing.hits, literal(1)) }),
      });

      await upsert(true);
      await upsert(true);
      await upsert(false); // an inactive row is outside the partial index: inserted, never a conflict

      const rows = await db.identities.orderBy(i => i.id).select(i => ({ active: i.active, hits: i.hits })).toList();
      expect(rows).toEqual([{ active: true, hits: 2 }, { active: false, hits: 1 }]);
    });

    test('literal(v, pgType), not(isNull(x)) and a strict call of x infer their index on both engines', async () => {
      await db.tickets.insert({ code: 'c1', ref: 'r1', seat: 1, status: 1, lane: 'x', holder: 'h@x' });
      const skipIfTaken = (row: { code: string; ref: string; seat: number; status: number; lane: string; holder: string | null }, primaryKey: Array<'code' | 'ref' | 'seat'>, targetWhere: (e: any) => any) =>
        db.tickets.upsertBulk([row], { primaryKey, targetWhere, updateColumnFilter: () => false });

      // each row collides with the seeded one on exactly one partial index, so DO NOTHING skips it
      await skipIfTaken({ code: 'c1', ref: 'r9', seat: 9, status: 1, lane: 'y', holder: null }, ['code'], e => eq(e.status, literal(1, 'smallint')));
      expect(lastStatement('ON CONFLICT')).toContain('ON CONFLICT ("code") WHERE "status" = CAST(1 AS smallint) DO NOTHING');

      await skipIfTaken({ code: 'c9', ref: 'r1', seat: 8, status: 2, lane: 'x', holder: null }, ['ref'], e => eq(e.lane, literal('x', 'varchar')));
      expect(lastStatement('ON CONFLICT')).toContain('ON CONFLICT ("ref") WHERE "lane" = CAST(\'x\' AS varchar) DO NOTHING');

      await skipIfTaken({ code: 'c8', ref: 'r8', seat: 1, status: 2, lane: 'y', holder: 'other' }, ['seat'], e => not(isNull(e.holder)));
      expect(lastStatement('ON CONFLICT')).toContain('ON CONFLICT ("seat") WHERE NOT ("holder" IS NULL) DO NOTHING');

      await skipIfTaken({ code: 'c7', ref: 'r7', seat: 1, status: 2, lane: 'y', holder: 'h@x' }, ['seat'], e => eq(lower(e.holder), literal('h@x')));
      expect(lastStatement('ON CONFLICT')).toContain('ON CONFLICT ("seat") WHERE lower("holder") = \'h@x\' DO NOTHING');

      expect(await db.tickets.count()).toBe(1);
    });

    test('a weaker predicate does not imply the index predicate: 42P10', async () => {
      const error = await expectToReject(db.identities.upsertBulk([{ provider: 'g', subject: 's1', active: true, hits: 1 }], {
        primaryKey: ['provider', 'subject'],
        targetWhere: e => eq(e.active, literal(true)),
        updateSet: existing => ({ hits: add(existing.hits, literal(1)) }),
      }), /there is no unique or exclusion constraint matching the ON CONFLICT specification/);

      expect(sqlStateOf(error)).toBe('42P10');
    });

    test('under a GENERIC plan the typed predicate keeps inferring the index; a bound one does not', async () => {
      await db.transaction(async tx => {
        await tx.query('SET LOCAL plan_cache_mode = force_generic_plan');

        // named prepared statements where the driver has them (postgres.js); generic plans everywhere
        for (let run = 0; run < 7; run++) {
          await tx.links.withPreparedStatements(true).upsertBulk([currentLink('o1', 1, `run ${run}`)], {
            primaryKey: ['ownerRef', 'slot'],
            targetWhere: e => eq(e.isCurrent, literal(true)),
            updateColumns: ['note'],
          });
        }
      });

      expect(await db.links.select(l => ({ note: l.note })).toList()).toEqual([{ note: 'run 6' }]);

      const error = await expectToReject(db.transaction(async tx => {
        await tx.query('SET LOCAL plan_cache_mode = force_generic_plan');
        await tx.query(
          'INSERT INTO "tw_links" ("owner_ref", "slot", "is_current", "note") VALUES ($1, $2, true, $3) '
          + 'ON CONFLICT ("owner_ref", "slot") WHERE "is_current" = $4 DO NOTHING',
          ['o1', 1, 'bound', true]
        );
      }), /there is no unique or exclusion constraint matching the ON CONFLICT specification/);

      expect(sqlStateOf(error)).toBe('42P10');
    });
  });
});
