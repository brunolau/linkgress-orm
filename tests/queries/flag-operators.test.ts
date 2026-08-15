import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, smallint, bigint, varchar, flagHas, flagHasAll, flagHasAny, flagHasNone, flagSet, flagUnset } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

// Define flag enum for testing
enum UserStateFlags {
  None = 0,
  Active = 1,
  Verified = 2,
  Admin = 4,
  Banned = 8,
  Premium = 16,
}

// Test entity with flags column
class FlagUser extends DbEntity {
  id!: DbColumn<number>;
  username!: DbColumn<string>;
  state!: DbColumn<number>;
}

// Test database with flag column
class FlagTestDatabase extends DbContext {
  get flagUsers(): DbEntityTable<FlagUser> {
    return this.table(FlagUser);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(FlagUser, entity => {
      entity.toTable('flag_users_test');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'flag_users_test_id_seq' }));
      entity.property(e => e.username).hasType(varchar('username', 100)).isRequired();
      entity.property(e => e.state).hasType(integer('state')).isRequired();
    });
  }
}

describe('Flag Operators', () => {
  let db: FlagTestDatabase;

  beforeAll(async () => {
    // Clear metadata store to avoid conflicts
    (EntityMetadataStore as any).metadata.clear();

    const client = createFreshClient();
    db = new FlagTestDatabase(client);

    // Only create/drop the test table, not the whole schema
    await client.query(`DROP TABLE IF EXISTS flag_users_test CASCADE`);
    await db.getSchemaManager().ensureCreated();

    // Seed test data with various flag combinations
    await db.flagUsers.insert({ username: 'none', state: UserStateFlags.None });
    await db.flagUsers.insert({ username: 'active', state: UserStateFlags.Active });
    await db.flagUsers.insert({ username: 'verified', state: UserStateFlags.Verified });
    await db.flagUsers.insert({ username: 'active_verified', state: UserStateFlags.Active | UserStateFlags.Verified });
    await db.flagUsers.insert({ username: 'admin', state: UserStateFlags.Admin });
    await db.flagUsers.insert({ username: 'active_admin', state: UserStateFlags.Active | UserStateFlags.Admin });
    await db.flagUsers.insert({ username: 'banned', state: UserStateFlags.Banned });
    await db.flagUsers.insert({ username: 'premium_active', state: UserStateFlags.Premium | UserStateFlags.Active });
    await db.flagUsers.insert({ username: 'all_flags', state: UserStateFlags.Active | UserStateFlags.Verified | UserStateFlags.Admin | UserStateFlags.Premium });
  });

  afterAll(async () => {
    // Only drop the test table
    await (db as any).client.query(`DROP TABLE IF EXISTS flag_users_test CASCADE`);
    await db.dispose();
  });

  describe('flagHas', () => {
    test('should find users with Active flag set', async () => {
      const results = await db.flagUsers
        .where(u => flagHas(u.state, UserStateFlags.Active))
        .toList();

      expect(results.length).toBe(5); // active, active_verified, active_admin, premium_active, all_flags
      results.forEach(r => {
        expect(r.state & UserStateFlags.Active).not.toBe(0);
      });
    });

    test('should find users with Admin flag set', async () => {
      const results = await db.flagUsers
        .where(u => flagHas(u.state, UserStateFlags.Admin))
        .toList();

      expect(results.length).toBe(3); // admin, active_admin, all_flags
      results.forEach(r => {
        expect(r.state & UserStateFlags.Admin).not.toBe(0);
      });
    });

    test('should find users with Banned flag set', async () => {
      const results = await db.flagUsers
        .where(u => flagHas(u.state, UserStateFlags.Banned))
        .toList();

      expect(results.length).toBe(1); // banned
      expect(results[0].username).toBe('banned');
    });

    test('should not find users when flag is not set', async () => {
      // No user has only Premium without Active
      const results = await db.flagUsers
        .where(u => flagHas(u.state, UserStateFlags.Premium))
        .toList();

      expect(results.length).toBe(2); // premium_active, all_flags
    });
  });

  describe('flagHasAll', () => {
    test('should find users with both Active AND Verified flags', async () => {
      const results = await db.flagUsers
        .where(u => flagHasAll(u.state, UserStateFlags.Active | UserStateFlags.Verified))
        .toList();

      expect(results.length).toBe(2); // active_verified, all_flags
      results.forEach(r => {
        expect(r.state & UserStateFlags.Active).not.toBe(0);
        expect(r.state & UserStateFlags.Verified).not.toBe(0);
      });
    });

    test('should find users with Active AND Admin flags', async () => {
      const results = await db.flagUsers
        .where(u => flagHasAll(u.state, UserStateFlags.Active | UserStateFlags.Admin))
        .toList();

      expect(results.length).toBe(2); // active_admin, all_flags
      results.forEach(r => {
        expect(r.state & UserStateFlags.Active).not.toBe(0);
        expect(r.state & UserStateFlags.Admin).not.toBe(0);
      });
    });

    test('should find users with three flags set', async () => {
      const results = await db.flagUsers
        .where(u => flagHasAll(u.state, UserStateFlags.Active | UserStateFlags.Verified | UserStateFlags.Admin))
        .toList();

      expect(results.length).toBe(1); // all_flags
      expect(results[0].username).toBe('all_flags');
    });

    test('should not match if only some flags are set', async () => {
      // User 'active' only has Active, not Verified
      const results = await db.flagUsers
        .where(u => flagHasAll(u.state, UserStateFlags.Active | UserStateFlags.Verified | UserStateFlags.Banned))
        .toList();

      expect(results.length).toBe(0);
    });
  });

  describe('flagHasAny', () => {
    test('should find users with Active OR Verified flag', async () => {
      const results = await db.flagUsers
        .where(u => flagHasAny(u.state, UserStateFlags.Active | UserStateFlags.Verified))
        .toList();

      // active, verified, active_verified, active_admin, premium_active, all_flags
      expect(results.length).toBe(6);
    });

    test('should find users with Admin OR Banned flag', async () => {
      const results = await db.flagUsers
        .where(u => flagHasAny(u.state, UserStateFlags.Admin | UserStateFlags.Banned))
        .toList();

      expect(results.length).toBe(4); // admin, active_admin, banned, all_flags
    });

    test('should find users with Premium OR Banned', async () => {
      const results = await db.flagUsers
        .where(u => flagHasAny(u.state, UserStateFlags.Premium | UserStateFlags.Banned))
        .toList();

      expect(results.length).toBe(3); // banned, premium_active, all_flags
    });
  });

  describe('flagHasNone', () => {
    test('should find users without Active flag', async () => {
      const results = await db.flagUsers
        .where(u => flagHasNone(u.state, UserStateFlags.Active))
        .toList();

      expect(results.length).toBe(4); // none, verified, admin, banned
      results.forEach(r => {
        expect(r.state & UserStateFlags.Active).toBe(0);
      });
    });

    test('should find users without Banned flag', async () => {
      const results = await db.flagUsers
        .where(u => flagHasNone(u.state, UserStateFlags.Banned))
        .toList();

      expect(results.length).toBe(8); // all except banned
      results.forEach(r => {
        expect(r.state & UserStateFlags.Banned).toBe(0);
      });
    });

    test('should find users without Admin flag', async () => {
      const results = await db.flagUsers
        .where(u => flagHasNone(u.state, UserStateFlags.Admin))
        .toList();

      expect(results.length).toBe(6); // none, active, verified, active_verified, banned, premium_active
      results.forEach(r => {
        expect(r.state & UserStateFlags.Admin).toBe(0);
      });
    });
  });

  describe('combined usage', () => {
    test('should work with select projection', async () => {
      const results = await db.flagUsers
        .select(u => ({
          id: u.id,
          username: u.username,
          isActive: flagHas(u.state, UserStateFlags.Active),
          isAdmin: flagHas(u.state, UserStateFlags.Admin),
        }))
        .toList();

      expect(results.length).toBe(9);

      const activeUser = results.find(r => r.username === 'active');
      expect(activeUser?.isActive).toBe(true);
      expect(activeUser?.isAdmin).toBe(false);

      const adminUser = results.find(r => r.username === 'admin');
      expect(adminUser?.isActive).toBe(false);
      expect(adminUser?.isAdmin).toBe(true);

      const allFlagsUser = results.find(r => r.username === 'all_flags');
      expect(allFlagsUser?.isActive).toBe(true);
      expect(allFlagsUser?.isAdmin).toBe(true);
    });

    test('should combine multiple flag conditions with and()', async () => {
      const { and } = await import('../../src');

      const results = await db.flagUsers
        .where(u => and(
          flagHas(u.state, UserStateFlags.Active),
          flagHasNone(u.state, UserStateFlags.Banned)
        ))
        .toList();

      expect(results.length).toBe(5); // active, active_verified, active_admin, premium_active, all_flags
      results.forEach(r => {
        expect(r.state & UserStateFlags.Active).not.toBe(0);
        expect(r.state & UserStateFlags.Banned).toBe(0);
      });
    });

    test('should combine flag conditions with or()', async () => {
      const { or } = await import('../../src');

      const results = await db.flagUsers
        .where(u => or(
          flagHas(u.state, UserStateFlags.Admin),
          flagHas(u.state, UserStateFlags.Premium)
        ))
        .toList();

      expect(results.length).toBe(4); // admin, active_admin, premium_active, all_flags
    });
  });
});

// Typed mask emission — the flag helpers resolve the COLUMN's integer width and
// cast the mask to it explicitly (`& $1::smallint` / `& $1::bigint`; int4 needs
// nothing). Semantically the cast changes nothing at runtime: an untyped bind
// parameter was already inferred to the column's width by describe. What it
// buys is a DETERMINISTIC expression tree: SQL reconstructed from logs with
// inlined int4 literals used to promote the COLUMN instead
// (`(col)::integer & 1` — a different tree that expression statistics built for
// the runtime form do not match; that mismatch cost a production query 13× in
// plan quality before it was caught).
describe('Flag Operators — typed mask (column-width casts)', () => {
  class WidthResort extends DbEntity {
    id!: DbColumn<number>;
    name!: DbColumn<string>;
    mode!: DbColumn<number>;
    flags!: DbColumn<number>;
    bigFlags!: DbColumn<number>;
  }

  class WidthProduct extends DbEntity {
    id!: DbColumn<number>;
    resortId!: DbColumn<number>;
    resort!: WidthResort;
  }

  class WidthTestDatabase extends DbContext {
    get widthResorts(): DbEntityTable<WidthResort> {
      return this.table(WidthResort);
    }

    get widthProducts(): DbEntityTable<WidthProduct> {
      return this.table(WidthProduct);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(WidthResort, entity => {
        entity.toTable('flag_width_resort_test');
        entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'flag_width_resort_test_id_seq' }));
        entity.property(e => e.name).hasType(varchar('name', 100)).isRequired();
        entity.property(e => e.mode).hasType(smallint('mode').default(0));
        entity.property(e => e.flags).hasType(integer('flags').default(0));
        entity.property(e => e.bigFlags).hasType(bigint('big_flags').default(0));
      });

      model.entity(WidthProduct, entity => {
        entity.toTable('flag_width_product_test');
        entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'flag_width_product_test_id_seq' }));
        entity.property(e => e.resortId).hasType(integer('resort_id'));
        entity.hasOne(e => e.resort, () => WidthResort).withForeignKey(e => e.resortId).withPrincipalKey(e => e.id);
      });
    }
  }

  const emittedSql = (query: { future: () => unknown }): string =>
    (query.future() as { _sql: string })._sql;

  test('smallint column: mask is cast ::smallint in every helper', async () => {
    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db2 = new WidthTestDatabase(client);

    try {
      expect(emittedSql(db2.widthResorts.where(r => flagHasNone(r.mode, 1)).select(r => ({ id: r.id }))))
        .toContain('& $1::smallint) = 0');
      expect(emittedSql(db2.widthResorts.where(r => flagHas(r.mode, 1)).select(r => ({ id: r.id }))))
        .toContain('& $1::smallint) != 0');
      expect(emittedSql(db2.widthResorts.where(r => flagHasAny(r.mode, 3)).select(r => ({ id: r.id }))))
        .toContain('& $1::smallint) != 0');
      expect(emittedSql(db2.widthResorts.where(r => flagHasAll(r.mode, 3)).select(r => ({ id: r.id }))))
        .toContain('& $1::smallint) = $2::smallint');
    } finally {
      await db2.dispose();
    }
  });

  test('integer column: no cast (bare parameter already resolves to int4)', async () => {
    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db2 = new WidthTestDatabase(client);

    try {
      const sql = emittedSql(db2.widthResorts.where(r => flagHasNone(r.flags, 1)).select(r => ({ id: r.id })));
      expect(sql).toContain('& $1) = 0');
      expect(sql).not.toContain('::smallint');
      expect(sql).not.toContain('::bigint');
    } finally {
      await db2.dispose();
    }
  });

  test('bigint column: mask is cast ::bigint', async () => {
    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db2 = new WidthTestDatabase(client);

    try {
      expect(emittedSql(db2.widthResorts.where(r => flagHasNone(r.bigFlags, 1)).select(r => ({ id: r.id }))))
        .toContain('& $1::bigint) = 0');
    } finally {
      await db2.dispose();
    }
  });

  test('navigation column keeps its width: reference-path smallint gets ::smallint', async () => {
    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db2 = new WidthTestDatabase(client);

    try {
      const sql = emittedSql(db2.widthProducts.where(p => flagHasNone(p.resort.mode, 1)).select(p => ({ id: p.id })));
      expect(sql).toContain('"mode" & $1::smallint) = 0');
    } finally {
      await db2.dispose();
    }
  });

  test('filters correctly end-to-end across all three widths', async () => {
    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db2 = new WidthTestDatabase(client);

    try {
      await client.query('DROP TABLE IF EXISTS flag_width_product_test CASCADE');
      await client.query('DROP TABLE IF EXISTS flag_width_resort_test CASCADE');
      await db2.getSchemaManager().ensureCreated();

      await db2.widthResorts.insert({ name: 'both', mode: 1, flags: 1, bigFlags: 1 } as never);
      await db2.widthResorts.insert({ name: 'none', mode: 4, flags: 4, bigFlags: 4 } as never);

      const bySmall = await db2.widthResorts.where(r => flagHas(r.mode, 1)).select(r => ({ name: r.name })).toList();
      const byInt = await db2.widthResorts.where(r => flagHasNone(r.flags, 1)).select(r => ({ name: r.name })).toList();
      const byBig = await db2.widthResorts.where(r => flagHasAll(r.bigFlags, 1)).select(r => ({ name: r.name })).toList();

      expect(bySmall.map(r => r.name)).toEqual(['both']);
      expect(byInt.map(r => r.name)).toEqual(['none']);
      expect(byBig.map(r => r.name)).toEqual(['both']);
    } finally {
      await client.query('DROP TABLE IF EXISTS flag_width_product_test CASCADE');
      await client.query('DROP TABLE IF EXISTS flag_width_resort_test CASCADE');
      await db2.dispose();
    }
  });
});

// ============================================================================
// Value-side flag operators — flagSet / flagUnset in UPDATE assignments
// ============================================================================
// The read-modify-write alternative (SELECT flags → OR in JS → UPDATE) costs
// two roundtrips and carries a lost-update window; these emit the bit-op
// SQL-side so a flag flip is ONE atomic statement (`col = col | $1`,
// `col = col & ~($1)`) and idempotency is bit algebra. Masks reuse the same
// flagMaskCast as the condition operators, so width-typed columns keep the
// deterministic `$N::smallint` / `$N::bigint` expression tree the block above
// pins for WHERE clauses.
describe('Flag Operators — value side (flagSet / flagUnset)', () => {
  enum MarkFlags {
    None = 0,
    A = 1,
    B = 2,
    C = 4,
  }

  class MarkRow extends DbEntity {
    id!: DbColumn<number>;
    name!: DbColumn<string>;
    state!: DbColumn<number>;
    mode!: DbColumn<number>;
  }

  class MarkTestDatabase extends DbContext {
    get markRows(): DbEntityTable<MarkRow> {
      return this.table(MarkRow);
    }

    protected override setupModel(model: DbModelConfig): void {
      model.entity(MarkRow, entity => {
        entity.toTable('flag_value_ops_test');
        entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'flag_value_ops_test_id_seq' }));
        entity.property(e => e.name).hasType(varchar('name', 60)).isRequired();
        entity.property(e => e.state).hasType(integer('state')).isRequired();
        entity.property(e => e.mode).hasType(smallint('mode')).isRequired();
      });
    }
  }

  let db2: MarkTestDatabase;
  let client: ReturnType<typeof createFreshClient>;

  const seedRow = async (name: string, state: number, mode = 0): Promise<void> => {
    await db2.markRows.insert({ name, state, mode });
  };

  const stateOf = async (name: string): Promise<number> => {
    const found = await db2.markRows.toList();
    return found.find(r => r.name === name)!.state;
  };

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db2 = new MarkTestDatabase(client);
    await client.query(`DROP TABLE IF EXISTS flag_value_ops_test CASCADE`);
    await db2.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS flag_value_ops_test CASCADE`);
    await db2.dispose();
  });

  test('flagSet sets the bit and preserves the others', async () => {
    await seedRow('set-basic', MarkFlags.A | MarkFlags.B);

    await db2.markRows.update(r => ({ state: flagSet(r.state, MarkFlags.C) }));

    expect(await stateOf('set-basic')).toBe(MarkFlags.A | MarkFlags.B | MarkFlags.C);
  });

  test('flagSet is idempotent (bit algebra, no read required)', async () => {
    await seedRow('set-idem', MarkFlags.A);

    await db2.markRows.update(r => ({ state: flagSet(r.state, MarkFlags.C) }));
    await db2.markRows.update(r => ({ state: flagSet(r.state, MarkFlags.C) }));

    expect(await stateOf('set-idem')).toBe(MarkFlags.A | MarkFlags.C);
  });

  test('flagUnset clears only the targeted bit', async () => {
    await seedRow('unset-basic', MarkFlags.A | MarkFlags.B | MarkFlags.C);

    await db2.markRows.update(r => ({ state: flagUnset(r.state, MarkFlags.B) }));

    expect(await stateOf('unset-basic')).toBe(MarkFlags.A | MarkFlags.C);

    // Clearing an absent bit is a no-op.
    await db2.markRows.update(r => ({ state: flagUnset(r.state, MarkFlags.B) }));

    expect(await stateOf('unset-basic')).toBe(MarkFlags.A | MarkFlags.C);
  });

  test('smallint column round-trips through both value operators', async () => {
    await seedRow('int2-row', 0, MarkFlags.A);

    await db2.markRows.update(r => ({ mode: flagSet(r.mode, MarkFlags.C) }));
    let rows = await db2.markRows.toList();
    expect(rows.find(r => r.name === 'int2-row')!.mode).toBe(MarkFlags.A | MarkFlags.C);

    await db2.markRows.update(r => ({ mode: flagUnset(r.mode, MarkFlags.A) }));
    rows = await db2.markRows.toList();
    expect(rows.find(r => r.name === 'int2-row')!.mode).toBe(MarkFlags.C);
  });

  test('width-typed refs carry the deterministic mask cast; untyped refs stay bare', () => {
    const partsOf = (fragment: unknown): string => ((fragment as { sqlParts: string[] }).sqlParts).join('|');

    expect(partsOf(flagSet({ __sqlType: 'smallint' } as never, MarkFlags.C))).toContain('::smallint');
    expect(partsOf(flagSet({ __sqlType: 'bigint' } as never, MarkFlags.C))).toContain('::bigint');
    expect(partsOf(flagSet({} as never, MarkFlags.C))).not.toContain('::');

    expect(partsOf(flagUnset({ __sqlType: 'smallint' } as never, MarkFlags.C))).toContain('::smallint');
    // `~($1)` on a bare parameter is ambiguous to Postgres (`operator is not
    // unique: ~ unknown`) — flagUnset therefore always casts, int4 fallback.
    expect(partsOf(flagUnset({} as never, MarkFlags.C))).toContain('::integer');
  });
});
