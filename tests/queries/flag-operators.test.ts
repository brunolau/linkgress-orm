import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createTestDatabase } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, flagHas, flagHasAll, flagHasAny, flagHasNone } from '../../src';
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

    const client = (createTestDatabase() as any).client;
    db = new FlagTestDatabase(client);

    await db.getSchemaManager().ensureDeleted();
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
    await db.getSchemaManager().ensureDeleted();
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
