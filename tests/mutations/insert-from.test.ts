import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  add, and, between, bigint, boolean as pgBoolean, coalesce, concat, createCustomType, DbColumn, DbContext, DbEntity,
  DbEntityTable, DbModelConfig, eq, gt, integer, lte, serial, smallint, text,
} from '../../src';
import type { DatabaseClient, LogSection } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { sqlStateOf } from '../../src/database/sql-state';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * `DbEntityTable.insertFrom(source, map, { where, expectedErrorCodes })` — `INSERT … SELECT` from a table
 * subquery:
 *
 *   INSERT INTO <table> (<cols>) SELECT <values> FROM (<source>) AS "src" [WHERE <cond>] [RETURNING …]
 *
 * A `src` ref renders `"src"."<key>"`, a fragment inline, a plain value binds through the column's mapper and
 * is cast to the column's type. Parameters: the source's, then the SELECT list's, then the WHERE's.
 */

type Tier = 'silver' | 'gold';

/** smallint ↔ tier name: proves plain values bind through the column's toDriver and RETURNING reads back through fromDriver */
const tierMapper = createCustomType<{ data: Tier; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Tier | null | undefined) => (value == null ? null : value === 'gold' ? 2 : 1),
  fromDriver: (value: any) => (Number(value) === 2 ? 'gold' : 'silver'),
});

class IfBadge extends DbEntity {
  id!: DbColumn<number>;
  badgeNumber!: DbColumn<number>;
  holderId!: DbColumn<number>;
  tier!: DbColumn<Tier>;
  active!: DbColumn<boolean>;
  label?: DbColumn<string | null>;
}

class InsertFromDatabase extends DbContext {
  get badges(): DbEntityTable<IfBadge> {
    return this.table(IfBadge);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(IfBadge, entity => {
      entity.toTable('if_badges');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.badgeNumber).hasType(bigint('badge_number')).isRequired();
      entity.property(e => e.holderId).hasType(integer('holder_id')).isRequired();
      entity.property(e => e.tier).hasType(smallint('tier')).isRequired().hasCustomMapper(tierMapper);
      entity.property(e => e.active).hasType(pgBoolean('active')).isRequired();
      entity.property(e => e.label).hasType(text('label'));
      entity.hasIndex('ux_if_badges_number', e => [e.badgeNumber]).isUnique();
    });
  }
}

const MIN = 4000000000000;
const MAX = 4000000000100;

describe('insertFrom (INSERT … SELECT)', () => {
  let client: DatabaseClient;
  let db: InsertFromDatabase;
  const captured: string[] = [];

  const lastStatement = (fragment: string): string => {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].includes(fragment)) {
        return captured[i];
      }
    }
    throw new Error(`No captured statement contains ${fragment}`);
  };

  /** COALESCE(MAX(badge number of a gold badge in the band), MIN) + gap — one row, also over an empty band */
  const nextGoldNumber = (target: InsertFromDatabase, gap: number) => target.badges
    .where(b => and(eq(b.tier, 'gold' as Tier), between(b.badgeNumber, MIN, MAX)))
    .select(b => ({ badgeNumber: b.badgeNumber }))
    .groupBy(() => ({}))
    .select(g => ({ nextNumber: add(coalesce(g.max(b => b.badgeNumber), MIN), gap) }))
    .asSubquery('table');

  const mintGold = (target: InsertFromDatabase, holderId: number, gap: number) => target.badges.insertFrom(
    nextGoldNumber(target, gap),
    src => ({ badgeNumber: src.nextNumber, holderId, tier: 'gold', active: true }),
    { where: src => lte(src.nextNumber, MAX) }
  );

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new InsertFromDatabase(client, {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS if_badges CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS if_badges CASCADE');
    await db.dispose();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE if_badges RESTART IDENTITY');
    captured.length = 0;
  });

  test('renders INSERT … SELECT … FROM (<source>) AS "src" WHERE …; parameters: source, SELECT list, WHERE', async () => {
    const rows = await mintGold(db, 17, 5).returning(b => ({ id: b.id, badgeNumber: b.badgeNumber, tier: b.tier }));

    expect(lastStatement('INSERT INTO')).toBe(
      'INSERT INTO "if_badges" ("badge_number", "holder_id", "tier", "active") '
      + 'SELECT "src"."nextNumber", CAST($6 AS integer), CAST($7 AS smallint), CAST($8 AS boolean) '
      + 'FROM (SELECT (COALESCE(MAX("if_badges"."badge_number"), $4) + $5) as "nextNumber"\nFROM "if_badges"\n'
      + 'WHERE ("if_badges"."tier" = $1 AND "if_badges"."badge_number" BETWEEN $2 AND $3)) AS "src" '
      + 'WHERE "src"."nextNumber" <= $9 '
      + 'RETURNING "id" AS "id", "badge_number" AS "badgeNumber", "tier" AS "tier"'
    );
    expect(JSON.parse(lastStatement('[Parameters]').slice('[Parameters] '.length))).toEqual([2, MIN, MAX, MIN, 5, 17, 2, true, MAX]);

    // an empty band: MIN + gap; the tier reads back through the column's mapper
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(Number(rows[0].badgeNumber)).toBe(MIN + 5);
    expect(rows[0].tier).toBe('gold');
  });

  test('computes from the table\'s current rows: MAX + gap', async () => {
    await mintGold(db, 1, 10);
    await mintGold(db, 2, 10);
    const [third] = await mintGold(db, 3, 3).returning(b => ({ badgeNumber: b.badgeNumber, holderId: b.holderId }));

    expect(Number(third.badgeNumber)).toBe(MIN + 23);
    expect(third.holderId).toBe(3);
    expect((await db.badges.orderBy(b => b.id).select(b => ({ n: b.badgeNumber })).toList()).map(r => Number(r.n))).toEqual([MIN + 10, MIN + 20, MIN + 23]);
  });

  test('a WHERE that holds for no source row inserts nothing: [] from returning(), undefined awaited bare', async () => {
    await mintGold(db, 1, 99);

    expect(await mintGold(db, 2, 99).returning(b => ({ id: b.id }))).toEqual([]);
    expect(await mintGold(db, 3, 99)).toBeUndefined();
    expect(await db.badges.count()).toBe(1);
  });

  test('zero source rows insert nothing', async () => {
    const none = db.badges.where(b => gt(b.id, 1000)).select(b => ({ n: b.badgeNumber })).asSubquery('table');

    expect(await db.badges.insertFrom(none, src => ({ badgeNumber: src.n, holderId: 1, tier: 'silver', active: false })).returning()).toEqual([]);
  });

  test('returning() reads whole entities through the columns\' mappers', async () => {
    const [badge] = await mintGold(db, 42, 1).returning();

    expect({ ...badge }).toEqual({ id: 1, badgeNumber: badge.badgeNumber, holderId: 42, tier: 'gold', active: true, label: null } as any);
    expect(Number(badge.badgeNumber)).toBe(MIN + 1);
  });

  test('a fragment value renders inline, its parameters in sequence; a NULL plain value is a typed NULL', async () => {
    const source = nextGoldNumber(db, 2);
    const [row] = await db.badges.insertFrom(
      source,
      src => ({ badgeNumber: src.nextNumber, holderId: 5, tier: 'silver', active: true, label: concat('B-', src.nextNumber) }),
    ).returning(b => ({ label: b.label }));

    expect(lastStatement('INSERT INTO')).toContain(
      'SELECT "src"."nextNumber", CAST($6 AS integer), CAST($7 AS smallint), CAST($8 AS boolean), concat(CAST($9 AS text), "src"."nextNumber") FROM ('
    );
    expect(row.label).toBe(`B-${MIN + 2}`);

    await db.badges.insertFrom(source, src => ({ badgeNumber: add(src.nextNumber, 1000), holderId: 6, tier: 'gold', active: false, label: null }));
    expect(lastStatement('INSERT INTO')).toContain('CAST(NULL AS text) FROM (');
  });

  test('runs on the context\'s executor: inside a transaction it rolls back with it', async () => {
    await expectToReject(db.transaction(async tx => {
      await mintGold(tx, 7, 1);
      expect(await tx.badges.count()).toBe(1);
      throw new Error('roll back');
    }), 'roll back');

    expect(await db.badges.count()).toBe(0);
  });

  test('refuses a map key that is not a column, and a source that is not a table subquery', async () => {
    const source = nextGoldNumber(db, 1);

    await expectToReject(
      db.badges.insertFrom(source, src => ({ badgeNumber: src.nextNumber, nope: 1 } as any)),
      'insertFrom: "nope" is not a column of "if_badges"'
    );
    await expectToReject(
      db.badges.insertFrom(db.badges.select(b => b.id).asSubquery('scalar') as any, () => ({ holderId: 1 })),
      'insertFrom: the source must be a table subquery'
    );
  });

  describe('expectedErrorCodes', () => {
    const recorder = () => {
      const entries: Array<{ msg: string; section?: LogSection }> = [];
      return {
        errors: () => entries.filter(e => e.section === 'error'),
        logger: (msg: string, section?: LogSection) => {
          entries.push({ msg, section });
        },
      };
    };

    /** a context that logs nothing but failures, as a production context does */
    const failureLogging = (logger: (msg: string, section?: LogSection) => void) => new InsertFromDatabase(client, {
      logQueries: false,
      logFailedQueries: true,
      logger,
    });

    /** re-inserts badge 1's number: a unique violation */
    const duplicate = (target: InsertFromDatabase, expectedErrorCodes?: readonly string[]) => target.badges.insertFrom(
      target.badges.where(b => eq(b.id, 1)).select(b => ({ n: b.badgeNumber })).asSubquery('table'),
      src => ({ badgeNumber: src.n, holderId: 9, tier: 'silver', active: true }),
      expectedErrorCodes ? { expectedErrorCodes } : undefined
    );

    beforeEach(async () => {
      await mintGold(db, 1, 1);
    });

    test('a listed SQLSTATE is still thrown but not reported by the failed-query logger', async () => {
      const rec = recorder();
      const quiet = failureLogging(rec.logger);

      const error = await expectToReject(duplicate(quiet, ['23505']));

      expect(sqlStateOf(error)).toBe('23505');
      expect(rec.errors()).toHaveLength(0);
    });

    test('an unlisted SQLSTATE is reported as before', async () => {
      const rec = recorder();
      const logging = failureLogging(rec.logger);

      expect(sqlStateOf(await expectToReject(duplicate(logging)))).toBe('23505');
      expect(sqlStateOf(await expectToReject(duplicate(logging, ['40001'])))).toBe('23505');

      const errors = rec.errors();
      expect(errors).toHaveLength(2);
      expect(errors[0].msg).toContain('[SQL Error]');
      expect(errors[0].msg).toContain('INSERT INTO "if_badges"');
    });
  });
});
