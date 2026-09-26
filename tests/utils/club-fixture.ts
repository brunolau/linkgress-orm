import { createFreshClient } from './test-database';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient,
  serial, integer, bigint, numeric, varchar, text, boolean, smallint, jsonb, ixNormalized,
} from '../../src';
import { SqlBuildContext } from '../../src/query/conditions';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { pgIntDatetime } from '../../debug/types/int-datetime';

/**
 * A small clubs / members schema for the expression-helper, aggregate and subquery-operand
 * suites: one column per read semantic those helpers must get right — a nullable integer, a
 * numeric(10, 2), a bigint beyond 2^53, a smallint bit mask, a digits-only text, an integer column
 * behind a custom mapper (Date <-> seconds), a boolean and a jsonb document — plus a navigation
 * (member -> club) and a club without members.
 */

export class FxClub extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  city!: DbColumn<string>;
  members?: FxMember[];
}

export class FxMember extends DbEntity {
  id!: DbColumn<number>;
  clubId!: DbColumn<number>;
  name!: DbColumn<string>;
  nickname?: DbColumn<string | null>;
  points?: DbColumn<number | null>;
  score?: DbColumn<number | null>;
  big?: DbColumn<string | null>;
  flags!: DbColumn<number>;
  joinedAt?: DbColumn<Date | null>;
  active!: DbColumn<boolean>;
  prefs?: DbColumn<Record<string, unknown> | null>;
  club?: FxClub;
}

export class ClubTestDatabase extends DbContext {
  get clubs(): DbEntityTable<FxClub> {
    return this.table(FxClub);
  }

  get members(): DbEntityTable<FxMember> {
    return this.table(FxMember);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(FxClub, entity => {
      entity.toTable('fx_clubs');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.city).hasType(varchar('city', 64)).isRequired();

      entity.hasMany(e => e.members, () => FxMember)
        .withForeignKey(m => m.clubId)
        .withPrincipalKey(c => c.id);
    });

    model.entity(FxMember, entity => {
      entity.toTable('fx_members');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.clubId).hasType(integer('club_id')).isRequired();
      entity.property(e => e.name).hasType(varchar('name', 64)).isRequired();
      entity.property(e => e.nickname).hasType(text('nickname'));
      entity.property(e => e.points).hasType(integer('points'));
      entity.property(e => e.score).hasType(numeric('score', 10, 2));
      entity.property(e => e.big).hasType(bigint('big'));
      entity.property(e => e.flags).hasType(smallint('flags')).isRequired();
      entity.property(e => e.joinedAt).hasType(integer('joined_at')).hasCustomMapper(pgIntDatetime);
      entity.property(e => e.active).hasType(boolean('active')).isRequired();
      entity.property(e => e.prefs).hasType(jsonb('prefs'));

      entity.hasOne(e => e.club, () => FxClub)
        .withForeignKey(m => m.clubId)
        .withPrincipalKey(c => c.id);

      // Makes the schema manager install public.search_normalize (searchNormalize() reads)
      entity.hasIndex('ix_fx_members_nickname_norm', e => [ixNormalized(e.nickname)]);
    });
  }
}

/** The `joinedAt` values of the seed (the mapper stores whole seconds). */
export const JOINED = {
  ann: new Date('2025-03-01T00:00:00.000Z'),
  bob: new Date('2025-01-15T00:00:00.000Z'),
  dee: new Date('2025-06-30T00:00:00.000Z'),
};

export interface ClubFixture {
  db: ClubTestDatabase;
  client: DatabaseClient;
  /** Every statement the context logged, in order (logQueries is on). */
  captured: string[];
  /** The last captured statement that contains the given text (default SELECT). */
  lastStatement(text?: string): string;
}

/**
 * Build the schema on a fresh client and seed it (ids are 1-based, in this order):
 *
 * | club | name | city |
 * |---|---|---|
 * | 1 | North | Oslo |
 * | 2 | South | Lima |
 * | 3 | Empty | Nowhere (no members) |
 *
 * | member | club | name | nickname | points | score | big | flags | joinedAt | active | prefs |
 * |---|---|---|---|---|---|---|---|---|---|---|
 * | 1 | 1 | ann | 'A' | 10 | 1.50 | 9007199254740993 | 1 | JOINED.ann | true | {"lang":"en","level":1} |
 * | 2 | 1 | bob | NULL | 20 | 2.25 | 5 | 2 | JOINED.bob | false | {"lang":"de"} |
 * | 3 | 1 | cyd | 'C' | 10 | NULL | NULL | 4 | NULL | true | NULL |
 * | 4 | 2 | dee | '007' | NULL | 3.00 | 7 | 3 | JOINED.dee | true | {"lang":"en"} |
 */
export async function createClubFixture(): Promise<ClubFixture> {
  (EntityMetadataStore as any).metadata.clear();

  const client = createFreshClient();
  const captured: string[] = [];
  const db = new ClubTestDatabase(client, {
    logQueries: true,
    logParameters: false,
    logger: (message: string) => {
      captured.push(message);
    },
  });

  await client.query('DROP TABLE IF EXISTS fx_members CASCADE');
  await client.query('DROP TABLE IF EXISTS fx_clubs CASCADE');
  await db.getSchemaManager().ensureCreated();

  await db.clubs.insertBulk([
    { name: 'North', city: 'Oslo' },
    { name: 'South', city: 'Lima' },
    { name: 'Empty', city: 'Nowhere' },
  ]);

  await db.members.insert({
    clubId: 1, name: 'ann', nickname: 'A', points: 10, score: 1.5, big: '9007199254740993', flags: 1,
    joinedAt: JOINED.ann, active: true, prefs: { lang: 'en', level: 1 },
  });
  await db.members.insert({
    clubId: 1, name: 'bob', nickname: null, points: 20, score: 2.25, big: '5', flags: 2,
    joinedAt: JOINED.bob, active: false, prefs: { lang: 'de' },
  });
  await db.members.insert({
    clubId: 1, name: 'cyd', nickname: 'C', points: 10, score: null, big: null, flags: 4,
    joinedAt: null, active: true, prefs: null,
  });
  await db.members.insert({
    clubId: 2, name: 'dee', nickname: '007', points: null, score: 3, big: '7', flags: 3,
    joinedAt: JOINED.dee, active: true, prefs: { lang: 'en' },
  });

  captured.length = 0;

  return {
    db,
    client,
    captured,
    lastStatement(textToFind = 'SELECT') {
      for (let i = captured.length - 1; i >= 0; i--) {
        if (captured[i].includes(textToFind)) {
          return captured[i];
        }
      }
      throw new Error(`No captured statement contains ${textToFind}`);
    },
  };
}

export async function disposeClubFixture(fixture: ClubFixture | undefined): Promise<void> {
  if (!fixture) {
    return;
  }

  await fixture.client.query('DROP TABLE IF EXISTS fx_members CASCADE');
  await fixture.client.query('DROP TABLE IF EXISTS fx_clubs CASCADE');
  await fixture.db.dispose();
}

/** Render a fragment (or condition) with a fresh parameter sequence. */
export function build(fragment: { buildSql(context: SqlBuildContext): string }, context: Partial<SqlBuildContext> = {}): { sql: string; params: any[] } {
  const ctx: SqlBuildContext = { paramCounter: 1, params: [], ...context };
  const text = fragment.buildSql(ctx);
  return { sql: text, params: ctx.params };
}

/** A FieldRef as a schema-aware mock row hands it to a selector. */
export function ref(column: string, options: { alias?: string; sqlType?: string; mapper?: unknown } = {}): any {
  return {
    __dbColumnName: column,
    __fieldName: column,
    __tableAlias: options.alias ?? 'fx_members',
    __sqlType: options.sqlType,
    __mapper: options.mapper,
  };
}
