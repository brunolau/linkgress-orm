import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  boolean as pgBoolean, caseWhen, createCustomType, DbColumn, DbContext, DbCteBuilder, DbEntity, DbEntityTable, DbModelConfig,
  eq, integer, isNull, serial, smallint, text, varchar,
} from '../../src';
import type { DatabaseClient } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { NestedDataModifyingCteError } from '../../src/query/cte-builder';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';

/**
 * A bulk INSERT feeding a second INSERT in ONE statement — the generated codes and one audit row per code
 * that landed:
 *
 *   WITH "ins" AS (INSERT INTO codes (…) VALUES (…), (…) ON CONFLICT DO NOTHING RETURNING …)
 *   INSERT INTO audit (…) SELECT … FROM (SELECT … FROM "ins") AS "src" [RETURNING …]
 *
 * - `insertBulk(...).toStatement(selector)` compiles the bulk insert without executing it (the executed
 *   path's columns, ON CONFLICT DO NOTHING and mappers; RETURNING typed for `withMutation`), and refuses
 *   rows execution would split into several chunks;
 * - `insertFrom(source, map, { with: [cte] })` declares the data-modifying CTE at the statement's top
 *   level, where the source (`db.selectFromCte(cte)…asSubquery('table')`) reads it by name.
 *
 * A code that conflicts is absent from the CTE's RETURNING, so it gets no audit row.
 */

type Channel = 'web' | 'import';
type Actor = 'admin' | 'system';

/** smallint ↔ channel name: the compiled bulk insert binds through toDriver, the CTE's RETURNING reads through fromDriver */
const channelMapper = createCustomType<{ data: Channel; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Channel | null | undefined) => (value == null ? null : value === 'import' ? 2 : 1),
  fromDriver: (value: any) => (Number(value) === 2 ? 'import' : 'web'),
});

/** smallint ↔ actor kind: insertFrom binds a plain value through toDriver, its RETURNING reads through fromDriver */
const actorMapper = createCustomType<{ data: Actor; driverData: number }>({
  dataType: () => 'smallint',
  toDriver: (value: Actor | null | undefined) => (value == null ? null : value === 'admin' ? 1 : 2),
  fromDriver: (value: any) => (Number(value) === 1 ? 'admin' : 'system'),
});

class McCode extends DbEntity {
  id!: DbColumn<number>;
  discountId!: DbColumn<number>;
  code!: DbColumn<string>;
  userId?: DbColumn<number | null>;
  channel!: DbColumn<Channel>;
  active!: DbColumn<boolean>;
}

class McAudit extends DbEntity {
  id!: DbColumn<number>;
  action!: DbColumn<string>;
  source!: DbColumn<string>;
  discountId!: DbColumn<number>;
  codeId!: DbColumn<number>;
  code!: DbColumn<string>;
  actorType!: DbColumn<Actor>;
  actorAdminId?: DbColumn<number | null>;
  customerId?: DbColumn<number | null>;

  codeRow?: McCode;
}

class MutationCteDatabase extends DbContext {
  get codes(): DbEntityTable<McCode> {
    return this.table(McCode);
  }

  get audit(): DbEntityTable<McAudit> {
    return this.table(McAudit);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(McCode, entity => {
      entity.toTable('mc_codes');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.discountId).hasType(integer('discount_id')).isRequired();
      entity.property(e => e.code).hasType(varchar('code', 64)).isRequired();
      entity.property(e => e.userId).hasType(integer('user_id'));
      entity.property(e => e.channel).hasType(smallint('channel')).isRequired().hasCustomMapper(channelMapper);
      entity.property(e => e.active).hasType(pgBoolean('active')).isRequired();
      entity.hasIndex('ux_mc_codes_code', e => [e.code]).isUnique();
    });

    model.entity(McAudit, entity => {
      entity.toTable('mc_audit');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.action).hasType(text('action')).isRequired();
      entity.property(e => e.source).hasType(text('source')).isRequired();
      entity.property(e => e.discountId).hasType(integer('discount_id')).isRequired();
      entity.property(e => e.codeId).hasType(integer('code_id')).isRequired();
      entity.property(e => e.code).hasType(varchar('code', 64)).isRequired();
      entity.property(e => e.actorType).hasType(smallint('actor_type')).isRequired().hasCustomMapper(actorMapper);
      entity.property(e => e.actorAdminId).hasType(integer('actor_admin_id'));
      entity.property(e => e.customerId).hasType(integer('customer_id'));

      entity.hasOne(e => e.codeRow, () => McCode)
        .withForeignKey(a => a.codeId)
        .withPrincipalKey(c => c.id);
    });
  }
}

const DISCOUNT = 70;
const ADMIN = 900;

describe('insert as a data-modifying CTE feeding insertFrom (one statement)', () => {
  let client: DatabaseClient;
  let db: MutationCteDatabase;
  const captured: string[] = [];

  const statements = (fragment: string): string[] => captured.filter(entry => entry.includes(fragment));

  const lastParams = (): unknown[] => {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].startsWith('[Parameters] ')) {
        return JSON.parse(captured[i].slice('[Parameters] '.length));
      }
    }
    throw new Error('No parameters captured');
  };

  /** The codes to generate: `userId` set = assigned to a customer (BULK_ASSIGN), null = GENERATE */
  const generated = (codes: Array<[string, number | null]>) => db.codes.insertBulk(
    codes.map(([code, userId]) => ({ discountId: DISCOUNT, code, userId, channel: 'import' as Channel, active: true })),
    { onConflictDoNothing: true }
  );

  /** The one statement: the codes as CTE "ins", one CODE_CREATED audit row per code its RETURNING yields */
  const generateWithAudit = (codes: Array<[string, number | null]>) => {
    const ins = new DbCteBuilder().withMutation(
      'ins',
      generated(codes).toStatement(c => ({ id: c.id, code: c.code, userId: c.userId, channel: c.channel }))
    );
    const landed = db.selectFromCte(ins.cte)
      .select(r => ({ id: r.id, code: r.code, userId: r.userId }))
      .asSubquery('table');

    return db.audit.insertFrom(
      landed,
      src => ({
        action: 'CODE_CREATED',
        source: caseWhen(isNull(src.userId), 'GENERATE').else('BULK_ASSIGN'),
        discountId: DISCOUNT,
        codeId: src.id,
        code: src.code,
        actorType: 'admin',
        actorAdminId: ADMIN,
        customerId: src.userId,
      }),
      { with: [ins.cte] }
    );
  };

  const codeRows = async () => (await db.codes.orderBy(c => c.code).select(c => ({ id: c.id, code: c.code, userId: c.userId, channel: c.channel })).toList())
    .map(row => ({ ...row }));

  const auditRows = async () => (await db.audit.orderBy(a => a.code).select(a => ({
    action: a.action, source: a.source, discountId: a.discountId, codeId: a.codeId, code: a.code,
    actorType: a.actorType, actorAdminId: a.actorAdminId, customerId: a.customerId,
  })).toList()).map(row => ({ ...row }));

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new MutationCteDatabase(client, {
      logQueries: true,
      logParameters: true,
      logger: (message: string) => {
        captured.push(message);
      },
    });
    await client.query('DROP TABLE IF EXISTS mc_audit CASCADE');
    await client.query('DROP TABLE IF EXISTS mc_codes CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS mc_audit CASCADE');
    await client.query('DROP TABLE IF EXISTS mc_codes CASCADE');
    await db.dispose();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE mc_audit, mc_codes RESTART IDENTITY');
    captured.length = 0;
  });

  describe('insertBulk(...).toStatement()', () => {
    test('compiles the executed statement — columns, mappers, ON CONFLICT DO NOTHING, RETURNING — without running it', async () => {
      const statement = generated([['A1', null], ['B2', 7]])
        .toStatement(c => ({ id: c.id, code: c.code, channel: c.channel, batch: 'b-1' }));

      expect(statement.sql).toBe(
        'INSERT INTO "mc_codes" ("discount_id", "code", "user_id", "channel", "active") VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10) '
        + 'ON CONFLICT DO NOTHING RETURNING "id" AS "id", "code" AS "code", "channel" AS "channel", $11 AS "batch"'
      );
      // the channel through its mapper ('import' → 2); the RETURNING's constant binds last
      expect(statement.params).toEqual([DISCOUNT, 'A1', null, 2, true, DISCOUNT, 'B2', 7, 2, true, 'b-1']);
      expect(captured).toHaveLength(0);
      expect(await db.codes.count()).toBe(0);

      // Without a selector: no RETURNING; insert(row) compiles like a one-row insertBulk
      expect(generated([['A1', null]]).toStatement().sql).not.toContain('RETURNING');
      expect(db.codes.insert({ discountId: 1, code: 'X', channel: 'web', active: false }).toStatement(c => ({ id: c.id })).sql).toBe(
        'INSERT INTO "mc_codes" ("discount_id", "code", "channel", "active") VALUES ($1, $2, $3, $4) RETURNING "id" AS "id"'
      );
    });

    test('runs as a data-modifying CTE: withMutation reads its RETURNING through the columns\' mappers', async () => {
      const ins = new DbCteBuilder().withMutation('ins', generated([['A1', null], ['B2', 7]]).toStatement(c => ({ code: c.code, channel: c.channel })));

      const rows = await db.selectFromCte(ins.cte).orderBy(r => r.code).select(r => ({ code: r.code, channel: r.channel })).toList();

      expect(rows.map(row => ({ ...row }))).toEqual([{ code: 'A1', channel: 'import' }, { code: 'B2', channel: 'import' }]);
      expect(await db.codes.count()).toBe(2);
    });

    test('refuses rows execution would split into several chunks, and zero rows', () => {
      const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ discountId: 1, code: `C${i}`, channel: 'web' as Channel, active: true }));

      expect(() => db.codes.insertBulk(rows(3), { chunkSize: 2 }).toStatement(c => ({ id: c.id })))
        .toThrow('toStatement(): 3 rows exceed the 2-row chunk of one insert into "mc_codes" — insertBulk() would execute them as 2 statements');

      // 4 columns: the automatic chunk is floor(floor(65535 / 4) * 0.6) = 9829 rows
      expect(() => db.codes.insertBulk(rows(9830)).toStatement()).toThrow('toStatement(): 9830 rows exceed the 9829-row chunk');
      expect(db.codes.insertBulk(rows(9829)).toStatement().params).toHaveLength(9829 * 4);

      expect(() => db.codes.insertBulk([]).toStatement()).toThrow('toStatement(): insertBulk() into "mc_codes" has no rows');
    });
  });

  describe('insertFrom(source, map, { with })', () => {
    test('one statement: the codes and one audit row per code, the CTE\'s parameters first', async () => {
      await generateWithAudit([['A1', null], ['B2', 7], ['C3', null]]);

      const inserts = statements('INSERT INTO');
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toBe(
        'WITH "ins" AS (INSERT INTO "mc_codes" ("discount_id", "code", "user_id", "channel", "active") '
        + 'VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ($11, $12, $13, $14, $15) ON CONFLICT DO NOTHING '
        + 'RETURNING "id" AS "id", "code" AS "code", "user_id" AS "userId", "channel" AS "channel")\n'
        + 'INSERT INTO "mc_audit" ("action", "source", "discount_id", "code_id", "code", "actor_type", "actor_admin_id", "customer_id") '
        + 'SELECT CAST($16 AS text), CASE WHEN "src"."userId" IS NULL THEN CAST($17 AS text) ELSE CAST($18 AS text) END, CAST($19 AS integer), "src"."id", "src"."code", '
        + 'CAST($20 AS smallint), CAST($21 AS integer), "src"."userId" '
        + 'FROM (SELECT "ins"."id" as "id", "ins"."code" as "code", "ins"."userId" as "userId"\nFROM "ins") AS "src"'
      );
      expect(lastParams()).toEqual([
        DISCOUNT, 'A1', null, 2, true, DISCOUNT, 'B2', 7, 2, true, DISCOUNT, 'C3', null, 2, true,
        'CODE_CREATED', 'GENERATE', 'BULK_ASSIGN', DISCOUNT, 1, ADMIN,
      ]);

      const codes = await codeRows();
      expect(codes).toEqual([
        { id: 1, code: 'A1', userId: null, channel: 'import' },
        { id: 2, code: 'B2', userId: 7, channel: 'import' },
        { id: 3, code: 'C3', userId: null, channel: 'import' },
      ]);
      expect(await auditRows()).toEqual([
        { action: 'CODE_CREATED', source: 'GENERATE', discountId: DISCOUNT, codeId: 1, code: 'A1', actorType: 'admin', actorAdminId: ADMIN, customerId: null },
        { action: 'CODE_CREATED', source: 'BULK_ASSIGN', discountId: DISCOUNT, codeId: 2, code: 'B2', actorType: 'admin', actorAdminId: ADMIN, customerId: 7 },
        { action: 'CODE_CREATED', source: 'GENERATE', discountId: DISCOUNT, codeId: 3, code: 'C3', actorType: 'admin', actorAdminId: ADMIN, customerId: null },
      ]);

      // the mappers wrote the stored values: channel 'import' → 2, actor 'admin' → 1
      const stored = await client.query('SELECT (SELECT array_agg(DISTINCT channel) FROM mc_codes) AS channels, (SELECT array_agg(DISTINCT actor_type) FROM mc_audit) AS actors');
      expect(String(stored.rows[0].channels)).toBe('2');
      expect(String(stored.rows[0].actors)).toBe('1');
    });

    test('ON CONFLICT DO NOTHING: a code that already exists is not in the RETURNING, so it gets no audit row', async () => {
      await db.codes.insert({ discountId: 1, code: 'B2', userId: 99, channel: 'web', active: false });

      await generateWithAudit([['A1', null], ['B2', 7], ['C3', 8]]);

      const codes = await codeRows();
      expect(codes.map(c => [c.code, c.userId, c.channel])).toEqual([['A1', null, 'import'], ['B2', 99, 'web'], ['C3', 8, 'import']]);

      const audit = await auditRows();
      expect(audit.map(a => [a.code, a.source, a.customerId])).toEqual([['A1', 'GENERATE', null], ['C3', 'BULK_ASSIGN', 8]]);
      const ids = new Map(codes.map(c => [c.code, c.id]));
      expect(audit.map(a => a.codeId)).toEqual([ids.get('A1')!, ids.get('C3')!]);

      // every code conflicting: nothing inserted anywhere, [] returned
      expect(await generateWithAudit([['A1', null], ['C3', 8]]).returning(a => ({ id: a.id }))).toEqual([]);
      expect(await db.codes.count()).toBe(3);
      expect(await db.audit.count()).toBe(2);
    });

    test('returning() on the outer insert reads its rows through the mappers', async () => {
      const rows = await generateWithAudit([['A1', null], ['B2', 7]])
        .returning(a => ({ code: a.code, source: a.source, actorType: a.actorType, customerId: a.customerId }));

      expect(rows.map(row => ({ ...row })).sort((a, b) => a.code.localeCompare(b.code))).toEqual([
        { code: 'A1', source: 'GENERATE', actorType: 'admin', customerId: null },
        { code: 'B2', source: 'BULK_ASSIGN', actorType: 'admin', customerId: 7 },
      ]);
      expect(statements('INSERT INTO')).toHaveLength(1);
      expect(statements('INSERT INTO')[0]).toContain(' RETURNING "code" AS "code", "source" AS "source", "actor_type" AS "actorType", "customer_id" AS "customerId"');

      const whole = await generateWithAudit([['C3', 5]]).returning();
      expect(whole).toHaveLength(1);
      expect(whole[0].actorType).toBe('admin');
      expect(whole[0].code).toBe('C3');
      expect(await db.audit.count()).toBe(3);
    });

    test('inside a transaction both inserts roll back with it', async () => {
      await expectToReject(db.transaction(async tx => {
        const ins = new DbCteBuilder().withMutation(
          'ins',
          tx.codes.insertBulk([{ discountId: 1, code: 'T1', channel: 'web', active: true }]).toStatement(c => ({ id: c.id, code: c.code }))
        );
        await tx.audit.insertFrom(
          tx.selectFromCte(ins.cte).select(r => ({ id: r.id, code: r.code })).asSubquery('table'),
          src => ({ action: 'CODE_CREATED', source: 'GENERATE', discountId: 1, codeId: src.id, code: src.code, actorType: 'system' }),
          { with: [ins.cte] }
        );
        expect(await tx.audit.count()).toBe(1);
        throw new Error('roll back');
      }), 'roll back');

      expect(await db.codes.count()).toBe(0);
      expect(await db.audit.count()).toBe(0);
    });

    test('a data-modifying CTE the source reads but `with` does not declare is refused with the fix', async () => {
      const ins = new DbCteBuilder().withMutation('ins', generated([['A1', null]]).toStatement(c => ({ id: c.id, code: c.code })));
      const landed = db.selectFromCte(ins.cte).select(r => ({ id: r.id, code: r.code })).asSubquery('table');
      const map = (src: any) => ({ action: 'X', source: 'Y', discountId: 1, codeId: src.id, code: src.code, actorType: 'admin' as Actor });

      const refusal = await expectToReject(db.audit.insertFrom(landed, map), 'insertFrom: the statement reads the data-modifying CTE "ins"');
      // Backward compatible: still the NestedDataModifyingCteError (and its cteName) a caller may catch.
      expect(refusal).toBeInstanceOf(NestedDataModifyingCteError);
      expect((refusal as NestedDataModifyingCteError).cteName).toBe('ins');

      // As a compiled statement it would be a CTE body, where PostgreSQL refuses a nested DML CTE
      expect(() => db.audit.insertFrom(landed, map, { with: [ins.cte] }).toStatement(a => ({ id: a.id })))
        .toThrow('toStatement(): this insertFrom() declares the data-modifying CTE "ins"');

      expect(await db.codes.count()).toBe(0);
    });

    test('a plain CTE in `with` is declared once and read by name; its parameters number first', async () => {
      await db.codes.insertBulk([
        { discountId: 1, code: 'K1', userId: 3, channel: 'web', active: true },
        { discountId: 2, code: 'K2', userId: 4, channel: 'web', active: true },
      ]);
      const picked = new DbCteBuilder().with('picked', db.codes.where(c => eq(c.discountId, 2)).select(c => ({ id: c.id, code: c.code })));

      const rows = await db.audit.insertFrom(
        db.selectFromCte(picked.cte).select(r => ({ id: r.id, code: r.code })).asSubquery('table'),
        src => ({ action: 'SEEN', source: 'S', discountId: 2, codeId: src.id, code: src.code, actorType: 'system' }),
        { with: [picked.cte] }
      ).returning(a => ({ code: a.code, actorType: a.actorType }));

      expect(rows.map(row => ({ ...row }))).toEqual([{ code: 'K2', actorType: 'system' }]);
      const statement = statements('INSERT INTO "mc_audit"')[0];
      expect(statement.startsWith('WITH "picked" AS (SELECT')).toBe(true);
      expect(statement.match(/"picked" AS/g)).toHaveLength(1);
      expect(lastParams()).toEqual([2, 'SEEN', 'S', 2, 2]);

      // A navigation RETURNING wraps the insert in its own mutation CTE: the statement's CTEs lead the ONE WITH
      const viaNavigation = await db.audit.insertFrom(
        db.selectFromCte(picked.cte).select(r => ({ id: r.id, code: r.code })).asSubquery('table'),
        src => ({ action: 'SEEN', source: 'S', discountId: 2, codeId: src.id, code: src.code, actorType: 'system' }),
        { with: [picked.cte] }
      ).returning(a => ({ code: a.code, codeChannel: a.codeRow!.channel, codeUserId: a.codeRow!.userId }));

      expect(viaNavigation.map(row => ({ ...row }))).toEqual([{ code: 'K2', codeChannel: 'web', codeUserId: 4 }]);
      const navigationStatement = statements('INSERT INTO "mc_audit"').at(-1)!;
      expect(navigationStatement.startsWith('WITH "picked" AS (SELECT')).toBe(true);
      expect(navigationStatement).toContain('),\n"__mutation__" AS (');
      expect(navigationStatement.match(/WITH /g)).toHaveLength(1);
    });
  });
});
