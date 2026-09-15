import { describe, test, expect, afterEach } from 'bun:test';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn,
  integer, varchar, boolean, eq, MockRowCache,
} from '../../src';
import {
  DatabaseClient, QueryResult, PooledConnection, QueryExecutionOptions,
} from '../../src/database/database-client.interface';

/**
 * v0.4.74 — the select-all row a table-level `where()` / `with()` / filter-join hands to a
 * chained selector keeps its COLUMNS as own enumerable properties, but inherits its
 * NAVIGATION getters from one prototype per schema instead of redefining them per row.
 *
 * The observable surface must not move: `Object.keys` / `Object.entries` / spread / `for...in`
 * saw only columns before (navigations were non-enumerable own getters) and must still see
 * only columns now; navigations must still resolve for chained selectors; and a `where()`
 * with no chained `select()` must still project every column.
 */

class SapUser extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  email!: DbColumn<string>;
  active!: DbColumn<boolean>;
  profileId!: DbColumn<number>;

  posts?: SapPost[];
  profile?: SapProfile;
}

class SapPost extends DbEntity {
  id!: DbColumn<number>;
  userId!: DbColumn<number>;
  title!: DbColumn<string>;

  user?: SapUser;
}

class SapProfile extends DbEntity {
  id!: DbColumn<number>;
  bio!: DbColumn<string>;
}

/** Records the last statement; nothing here needs a database. */
class RecordingClient extends DatabaseClient {
  last: { sql: string; params: any[] } | null = null;

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    this.last = { sql, params: params ?? [] };

    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PooledConnection> {
    throw new Error('not needed');
  }

  async end(): Promise<void> {
    // no pool to close
  }

  getDriverName(): string {
    return 'postgres';
  }

  async transaction<T>(
    callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<QueryResult>) => Promise<T>
  ): Promise<T> {
    return callback((sql, params) => this.query(sql, params));
  }
}

class SelectAllPrototypeDatabase extends DbContext {
  get sapUsers(): DbEntityTable<SapUser> {
    return this.table(SapUser);
  }

  get sapPosts(): DbEntityTable<SapPost> {
    return this.table(SapPost);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SapUser, entity => {
      entity.toTable('sap_users');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.name).hasType(varchar('name', 80));
      entity.property(e => e.email).hasType(varchar('email', 120));
      entity.property(e => e.active).hasType(boolean('active'));
      entity.property(e => e.profileId).hasType(integer('profile_id'));

      entity.hasMany(e => e.posts, () => SapPost).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
      entity.hasOne(e => e.profile, () => SapProfile).withForeignKey(u => u.profileId).withPrincipalKey(p => p.id);
    });

    model.entity(SapPost, entity => {
      entity.toTable('sap_posts');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.userId).hasType(integer('user_id'));
      entity.property(e => e.title).hasType(varchar('title', 200));

      entity.hasOne(e => e.user, () => SapUser).withForeignKey(p => p.userId).withPrincipalKey(u => u.id);
    });

    model.entity(SapProfile, entity => {
      entity.toTable('sap_profiles');
      entity.property(e => e.id).hasType(integer('id').primaryKey());
      entity.property(e => e.bio).hasType(varchar('bio', 400));
    });
  }
}

const makeDb = () => {
  const client = new RecordingClient();

  return { client, db: new SelectAllPrototypeDatabase(client, { collectionStrategy: 'lateral' }) };
};

/** Captures the select-all row a chained selector receives. */
const captureSelectAllRow = async (db: SelectAllPrototypeDatabase): Promise<any> => {
  let captured: any;

  await db.sapUsers.where(u => eq(u.id, 1)).select((u: any) => {
    captured = u;

    return { a: u.id };
  }).toList();

  return captured;
};

describe('select-all rows inherit their navigation getters from a per-schema prototype', () => {
  afterEach(() => {
    MockRowCache.reset();
  });

  describe('the emitted SQL is unchanged', () => {
    test('where() with no chained select still projects every column', async () => {
      const { client, db } = makeDb();

      await db.sapUsers.where(u => eq(u.id, 1)).toList();

      expect(client.last!.sql).toContain('"sap_users"."id" as "id"');
      expect(client.last!.sql).toContain('"sap_users"."name" as "name"');
      expect(client.last!.sql).toContain('"sap_users"."email" as "email"');
      expect(client.last!.sql).toContain('"sap_users"."active" as "active"');
      expect(client.last!.sql).toContain('"sap_users"."profile_id" as "profileId"');
      // navigations stay OUT of the default projection
      expect(client.last!.sql).not.toContain('"posts"');
      expect(client.last!.sql).not.toContain('"profile"');
    });

    test('a chained select narrows the projection to the selected columns', async () => {
      const { client, db } = makeDb();

      await db.sapUsers.where(u => eq(u.id, 1)).select(u => ({ a: u.id, b: u.name })).toList();

      expect(client.last!.sql).toContain('"sap_users"."id" as "a"');
      expect(client.last!.sql).toContain('"sap_users"."name" as "b"');
      expect(client.last!.sql).not.toContain('as "email"');
    });

    test('a chained selector still reaches a hasMany navigation', async () => {
      const { client, db } = makeDb();

      await db.sapUsers
        .where(u => eq(u.id, 1))
        .select(u => ({ a: u.id, posts: u.posts!.select(p => ({ t: p.title })).toList() }))
        .toList();

      expect(client.last!.sql).toContain('LATERAL');
      expect(client.last!.sql).toContain('sap_posts');
      expect(client.last!.sql).toContain('as "posts"');
    });

    test('a chained selector still reaches a hasOne navigation', async () => {
      const { client, db } = makeDb();

      await db.sapPosts.where(p => eq(p.id, 1)).select(p => ({ t: p.title, author: p.user!.name })).toList();

      expect(client.last!.sql).toContain('JOIN "sap_users"');
      expect(client.last!.sql).toContain('as "author"');
    });
  });

  describe('the select-all row keeps its observable shape', () => {
    test('columns are OWN enumerable properties; navigations are not enumerated', async () => {
      const { db } = makeDb();
      const row = await captureSelectAllRow(db);

      expect(Object.keys(row).sort()).toEqual(['active', 'email', 'id', 'name', 'profileId']);
      expect(Object.keys({ ...row }).sort()).toEqual(['active', 'email', 'id', 'name', 'profileId']);

      const forIn: string[] = [];
      for (const key in row) {
        forIn.push(key);
      }

      expect(forIn.sort()).toEqual(['active', 'email', 'id', 'name', 'profileId']);
    });

    test('navigations resolve through the prototype but are not own properties', async () => {
      const { db } = makeDb();
      const row = await captureSelectAllRow(db);

      expect(Object.prototype.hasOwnProperty.call(row, 'posts')).toBe(false);
      expect(row.posts).toBeDefined();
      expect(row.profile).toBeDefined();
      expect('posts' in row).toBe(true);
    });

    test('the row still reads as a plain object (what isPlainObject tests)', async () => {
      const { db } = makeDb();
      const row = await captureSelectAllRow(db);

      expect(row.constructor).toBe(Object);
      expect(JSON.stringify(Object.keys(row).sort())).toBe(JSON.stringify(['active', 'email', 'id', 'name', 'profileId']));
    });

    test('the internal source slot is not enumerable and does not leak into a spread', async () => {
      const { db } = makeDb();
      const row = await captureSelectAllRow(db);

      expect(Object.getOwnPropertySymbols({ ...row })).toHaveLength(0);
    });
  });

  describe('the prototype is actually shared (the optimization itself)', () => {
    test('two separate where() calls on one schema share one navigation prototype', async () => {
      const { db } = makeDb();
      const first = await captureSelectAllRow(db);
      const second = await captureSelectAllRow(db);

      expect(first).not.toBe(second);
      expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(second));
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(first)).sort()).toEqual(['posts', 'profile']);
    });

    test('a different schema gets a different prototype', async () => {
      const { db } = makeDb();
      const userRow = await captureSelectAllRow(db);

      let postRow: any;
      await db.sapPosts.where(p => eq(p.id, 1)).select((p: any) => {
        postRow = p;

        return { a: p.id };
      }).toList();

      expect(Object.getPrototypeOf(postRow)).not.toBe(Object.getPrototypeOf(userRow));
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(postRow))).toEqual(['user']);
    });
  });
});
