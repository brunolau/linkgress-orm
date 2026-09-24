import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createFreshClient } from '../utils/test-database';
import { expectToReject } from '../utils/expect-rejects';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, DatabaseClient, MutationBatch,
  serial, integer, varchar, text,
  add, and, caseWhen, coalesce, eq, gt, isNull, lt, literal, sql,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

/**
 * Typed SET / WHERE expressions for the two keyed bulk writes:
 *  - upsertBulk `updateSet` / `updateWhere` over (existing, excluded) — the ON CONFLICT arm;
 *  - bulkUpdate `set` / `where` over (target, values) — the UPDATE … FROM (VALUES …) form;
 * and the same options on the MutationBatch legs.
 */

class TallyGroup extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class Tally extends DbEntity {
  id!: DbColumn<number>;
  key!: DbColumn<string>;
  hits!: DbColumn<number>;
  label?: DbColumn<string | null>;
  note?: DbColumn<string | null>;
  version!: DbColumn<number>;
  groupId?: DbColumn<number | null>;
  group?: TallyGroup;
}

class TallyDatabase extends DbContext {
  get tallyGroups(): DbEntityTable<TallyGroup> {
    return this.table(TallyGroup);
  }

  get tallies(): DbEntityTable<Tally> {
    return this.table(Tally);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(TallyGroup, entity => {
      entity.toTable('expr_tally_groups');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.name).hasType(varchar('name', 32)).isRequired();
    });

    model.entity(Tally, entity => {
      entity.toTable('expr_tallies');
      entity.property(e => e.id).hasType(serial('id')).isPrimaryKey();
      entity.property(e => e.key).hasType(varchar('key', 32)).isRequired().isUnique();
      entity.property(e => e.hits).hasType(integer('hits')).isRequired();
      entity.property(e => e.label).hasType(text('label'));
      entity.property(e => e.note).hasType(text('note'));
      entity.property(e => e.version).hasType(integer('version')).isRequired();
      entity.property(e => e.groupId).hasType(integer('group_id'));
      entity.hasOne(e => e.group, () => TallyGroup)
        .withForeignKey(t => t.groupId!)
        .withPrincipalKey(g => g.id);
    });
  }
}

describe('upsertBulk updateSet / updateWhere and bulkUpdate set / where', () => {
  let db: TallyDatabase;
  let client: DatabaseClient;
  const captured: string[] = [];

  const lastStatement = (keyword: string) => {
    for (let i = captured.length - 1; i >= 0; i--) {
      if (captured[i].includes(keyword)) {
        return captured[i];
      }
    }
    throw new Error(`no captured statement contains ${keyword}`);
  };

  const byKey = async () => {
    const rows = await db.tallies
      .select(t => ({ key: t.key, hits: t.hits, label: t.label, note: t.note, version: t.version }))
      .toList();
    return Object.fromEntries(rows.map(r => [r.key, { hits: r.hits, label: r.label, note: r.note, version: r.version }]));
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new TallyDatabase(client, {
      logQueries: true,
      logParameters: false,
      logger: (message: string) => {
        captured.push(message);
      },
    });

    await client.query('DROP TABLE IF EXISTS expr_tallies CASCADE');
    await client.query('DROP TABLE IF EXISTS expr_tally_groups CASCADE');
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS expr_tallies CASCADE');
    await client.query('DROP TABLE IF EXISTS expr_tally_groups CASCADE');
    await db.dispose();
  });

  beforeEach(async () => {
    await db.tallies.delete();
    await db.tallies.insertBulk([
      { key: 'a', hits: 5, label: 'Alpha', note: null, version: 2 },
      { key: 'b', hits: 1, label: null, note: 'keep', version: 1 },
    ]);
    captured.length = 0;
  });

  describe('upsertBulk updateSet', () => {
    test('accumulates into the existing row; only the named columns are updated', async () => {
      await db.tallies.upsertBulk(
        [
          { key: 'a', hits: 3, label: 'ignored', version: 9 },
          { key: 'c', hits: 7, label: 'Gamma', version: 1 },
        ],
        {
          primaryKey: 'key',
          updateSet: (existing, excluded) => ({ hits: add(existing.hits, excluded.hits) }),
        }
      );

      expect(await byKey()).toEqual({
        a: { hits: 8, label: 'Alpha', note: null, version: 2 },
        b: { hits: 1, label: null, note: 'keep', version: 1 },
        c: { hits: 7, label: 'Gamma', note: null, version: 1 },
      });
      expect(lastStatement('ON CONFLICT')).toContain(
        'ON CONFLICT ("key") DO UPDATE SET "hits" = ("expr_tallies"."hits" + "excluded"."hits")'
      );
    });

    test('combines with updateColumns: listed columns take EXCLUDED, expressions win on overlap', async () => {
      await db.tallies.upsertBulk(
        [{ key: 'a', hits: 3, label: 'Alpha 2', version: 3 }],
        {
          primaryKey: 'key',
          updateColumns: ['label', 'hits', 'version'],
          updateSet: (existing, excluded) => ({ hits: add(existing.hits, excluded.hits) }),
        }
      );

      expect((await byKey()).a).toEqual({ hits: 8, label: 'Alpha 2', note: null, version: 3 });
      const statement = lastStatement('ON CONFLICT');
      expect(statement).toContain('"label" = EXCLUDED."label"');
      expect(statement).toContain('"version" = EXCLUDED."version"');
      expect(statement).not.toContain('"hits" = EXCLUDED."hits"');
    });

    test('keeps the first non-NULL value with coalesce', async () => {
      await db.tallies.upsertBulk(
        [
          { key: 'a', hits: 0, label: 'replacement', version: 1 },
          { key: 'b', hits: 0, label: 'filled', version: 1 },
        ],
        {
          primaryKey: 'key',
          updateSet: (existing, excluded) => ({ label: coalesce(existing.label, excluded.label) }),
        }
      );

      const rows = await byKey();
      expect(rows.a.label).toBe('Alpha');
      expect(rows.b.label).toBe('filled');
    });

    test('binds plain values and renders CASE / conditions', async () => {
      await db.tallies.upsertBulk(
        [
          { key: 'a', hits: 0, version: 1 },
          { key: 'b', hits: 4, version: 1 },
        ],
        {
          primaryKey: 'key',
          updateSet: (existing, excluded) => ({
            note: 'touched',
            hits: caseWhen(gt(excluded.hits, 0), add(existing.hits, excluded.hits)).else(existing.hits),
          }),
        }
      );

      expect(await byKey()).toEqual({
        a: { hits: 5, label: 'Alpha', note: 'touched', version: 2 },
        b: { hits: 5, label: null, note: 'touched', version: 1 },
      });
    });

    test('updateWhere only lets a newer version overwrite', async () => {
      await db.tallies.upsertBulk(
        [
          { key: 'a', hits: 100, label: 'stale', version: 1 },
          { key: 'b', hits: 100, label: 'fresh', version: 5 },
        ],
        {
          primaryKey: 'key',
          updateColumns: ['hits', 'label', 'version'],
          updateWhere: (existing, excluded) => lt(existing.version, excluded.version),
        }
      );

      const rows = await byKey();
      expect(rows.a).toEqual({ hits: 5, label: 'Alpha', note: null, version: 2 });
      expect(rows.b).toEqual({ hits: 100, label: 'fresh', note: 'keep', version: 5 });
      expect(lastStatement('ON CONFLICT')).toContain('WHERE "expr_tallies"."version" < "excluded"."version"');
    });

    test('setWhere and updateWhere are ANDed', async () => {
      await db.tallies.upsertBulk(
        [
          { key: 'a', hits: 1, version: 9 },
          { key: 'b', hits: 1, version: 9 },
        ],
        {
          primaryKey: 'key',
          updateSet: (existing, excluded) => ({ version: excluded.version }),
          setWhere: '"expr_tallies"."note" IS NULL',
          updateWhere: (existing, excluded) => lt(existing.version, excluded.version),
        }
      );

      const rows = await byKey();
      expect(rows.a.version).toBe(9);
      expect(rows.b.version).toBe(1);
      expect(lastStatement('ON CONFLICT')).toMatch(/WHERE \("expr_tallies"\."note" IS NULL\) AND \("expr_tallies"\."version" < "excluded"\."version"\)/);
    });

    test('parameters number on after the VALUES rows', async () => {
      await db.tallies.upsertBulk(
        [{ key: 'a', hits: 1, version: 1 }],
        {
          primaryKey: 'key',
          updateSet: (existing) => ({ note: sql`${'x'}::text || ${'y'}`, hits: add(existing.hits, 10) }),
          updateWhere: (existing) => gt(existing.hits, 0),
        }
      );

      expect((await byKey()).a).toEqual({ hits: 15, label: 'Alpha', note: 'xy', version: 2 });
      const statement = lastStatement('ON CONFLICT');
      expect(statement).toContain('"note" = $4::text || $5');
      expect(statement).toContain('"hits" = ("expr_tallies"."hits" + $6)');
      expect(statement).toContain('WHERE "expr_tallies"."hits" > $7');
    });

    test('returning() sees the result', async () => {
      const rows = await db.tallies
        .upsertBulk([{ key: 'b', hits: 2, version: 1 }], {
          primaryKey: 'key',
          updateSet: (existing, excluded) => ({ hits: add(existing.hits, excluded.hits) }),
        })
        .returning(t => ({ key: t.key, hits: t.hits }));

      expect(rows).toEqual([{ key: 'b', hits: 3 }]);
    });

    test('a navigation is not in scope — refused with a clear error', async () => {
      await expectToReject(
        db.tallies.upsertBulk([{ key: 'a', hits: 1, version: 1 }], {
          primaryKey: 'key',
          updateSet: (existing) => ({ label: (existing as any).group.name }),
        }),
        /navigation "group" is not available/
      );
    });

    test('an unknown column is refused', async () => {
      await expectToReject(
        db.tallies.upsertBulk([{ key: 'a', hits: 1, version: 1 }], {
          primaryKey: 'key',
          updateSet: () => ({ nope: 1 } as any),
        }),
        /unknown column property "nope"/
      );
    });

    test('without updateSet the statement text is unchanged', async () => {
      await db.tallies.upsertBulk([{ key: 'a', hits: 1, label: 'L', version: 1 }], { primaryKey: 'key' });
      expect(lastStatement('ON CONFLICT')).toContain(
        'ON CONFLICT ("key") DO UPDATE SET "hits" = EXCLUDED."hits", "label" = EXCLUDED."label", "version" = EXCLUDED."version"'
      );
    });
  });

  describe('bulkUpdate set / where', () => {
    const ids = async () => Object.fromEntries((await db.tallies.select(t => ({ key: t.key, id: t.id })).toList()).map(r => [r.key, r.id]));

    test('an expression replaces the provided-flag CASE of its column', async () => {
      const { a, b } = await ids();

      await db.tallies.bulkUpdate(
        [
          { id: a, label: 'new A', note: 'n' },
          { id: b, label: 'new B', note: 'n' },
        ],
        { set: (target, values) => ({ label: coalesce(target.label, values.label) }) }
      );

      expect(await byKey()).toEqual({
        a: { hits: 5, label: 'Alpha', note: 'n', version: 2 },
        b: { hits: 1, label: 'new B', note: 'n', version: 1 },
      });
      const statement = lastStatement('UPDATE');
      expect(statement).toContain('"label" = COALESCE("t"."label", "v"."label")');
      expect(statement).toContain('"note" = CASE WHEN v."note__provided" THEN v."note" ELSE t."note" END');
    });

    test('where adds a guard to the key match', async () => {
      const { a, b } = await ids();

      await db.tallies.bulkUpdate(
        [
          { id: a, hits: 50, version: 1 },
          { id: b, hits: 50, version: 7 },
        ],
        { where: (target, values) => lt(target.version, values.version) }
      );

      const rows = await byKey();
      expect(rows.a.hits).toBe(5);
      expect(rows.b.hits).toBe(50);
      expect(lastStatement('UPDATE')).toMatch(/WHERE t\."id" = v\."id" AND \("t"\."version" < "v"\."version"\)/);
    });

    test('set may assign a column no row provides, and rows may carry only the key', async () => {
      const { a, b } = await ids();

      await db.tallies.bulkUpdate([{ id: a }, { id: b }], {
        set: (target) => ({ hits: add(target.hits, 1), note: literal('bumped') }),
      });

      expect(await byKey()).toEqual({
        a: { hits: 6, label: 'Alpha', note: 'bumped', version: 2 },
        b: { hits: 2, label: null, note: 'bumped', version: 1 },
      });
    });

    test('conditions and parameters compose', async () => {
      const { a, b } = await ids();

      await db.tallies.bulkUpdate(
        [
          { id: a, hits: 10 },
          { id: b, hits: 20 },
        ],
        {
          set: (target, values) => ({ hits: add(target.hits, values.hits, 1000) }),
          where: (target) => and(gt(target.hits, 2), isNull(target.note)),
        }
      );

      const rows = await byKey();
      expect(rows.a.hits).toBe(1015);
      expect(rows.b.hits).toBe(1);
    });

    test('returning() reads the updated rows', async () => {
      const { a } = await ids();
      const rows = await db.tallies
        .bulkUpdate([{ id: a, hits: 1 }], { set: (target, values) => ({ hits: add(target.hits, values.hits) }) })
        .returning(t => ({ id: t.id, hits: t.hits }));

      expect(rows).toEqual([{ id: a, hits: 6 }]);
    });

    test('reading a VALUES column no row provides is refused', async () => {
      const { a } = await ids();
      await expectToReject(
        db.tallies.bulkUpdate([{ id: a, hits: 1 }], { set: (target, values) => ({ label: values.label }) }),
        /reads values\.label, but no row provides "label"/
      );
    });

    test('assigning the match key is refused', async () => {
      const { a } = await ids();
      await expectToReject(
        db.tallies.bulkUpdate([{ id: a, hits: 1 }], { set: () => ({ id: 5 }) }),
        /"id" is a match key/
      );
    });

    test('without set / where the statement text is unchanged', async () => {
      const { a } = await ids();
      await db.tallies.bulkUpdate([{ id: a, hits: 9 }]);
      const statement = lastStatement('UPDATE');
      expect(statement).toContain('SET "hits" = CASE WHEN v."hits__provided" THEN v."hits" ELSE t."hits" END');
      expect(statement).toMatch(/WHERE t\."id" = v\."id"$/m);
    });
  });

  describe('MutationBatch legs', () => {
    test('an upsert leg and a bulk-update leg with expressions in one round trip', async () => {
      const { b } = Object.fromEntries((await db.tallies.select(t => ({ key: t.key, id: t.id })).toList()).map(r => [r.key, r.id]));
      const batch = new MutationBatch();

      batch.addUpsertBulk(
        db.tallies,
        [{ key: 'a', hits: 2, version: 1 }, { key: 'z', hits: 9, version: 1 }],
        { primaryKey: 'key', updateSet: (existing: any, excluded: any) => ({ hits: add(existing.hits, excluded.hits) }) },
        'upserts'
      );
      batch.addBulkUpdate(
        db.tallies,
        [{ id: b, label: 'from batch' }],
        'updates',
        { set: (target: any, values: any) => ({ label: coalesce(target.label, values.label) }), where: (target: any) => eq(target.note, 'keep') }
      );

      captured.length = 0;
      await batch.executeBatch();

      expect(batch.getAffectedCount('upserts')).toBe(2);
      expect(batch.getAffectedCount('updates')).toBe(1);
      expect(captured.some(line => line.includes('INSERT INTO "expr_tallies"') && line.includes('UPDATE "expr_tallies"'))).toBe(true);

      const rows = await byKey();
      expect(rows.a.hits).toBe(7);
      expect(rows.z.hits).toBe(9);
      expect(rows.b.label).toBe('from batch');
    });
  });
});
