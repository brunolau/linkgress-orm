import { describe, test, expect, beforeEach } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import { DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar, ixNormalized } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

class NormUser extends DbEntity {
  id!: DbColumn<number>;
  email!: DbColumn<string>;
  hash!: DbColumn<string>;
  username!: DbColumn<string>;
}

function defineColumns(entity: any, table: string): void {
  entity.toTable(table);
  entity.property((e: NormUser) => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: `${table}_id_seq` }));
  entity.property((e: NormUser) => e.email).hasType(varchar('email', 255)).isRequired();
  entity.property((e: NormUser) => e.hash).hasType(varchar('hash', 64)).isRequired();
  entity.property((e: NormUser) => e.username).hasType(varchar('username', 200)).isRequired();
}

// Unique btree expression index — the user's example shape
class BtreeNormDb extends DbContext {
  get users(): DbEntityTable<NormUser> { return this.table(NormUser); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(NormUser, entity => {
      defineColumns(entity, 'users_norm_btree');
      entity.hasIndex('user_admin_query', e => [ixNormalized(e.email), e.hash]).isUnique();
    });
  }
}

// Trigram GIN index opted-in via the ixNormalized param
class GinNormDb extends DbContext {
  get users(): DbEntityTable<NormUser> { return this.table(NormUser); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(NormUser, entity => {
      defineColumns(entity, 'users_norm_gin');
      entity.hasIndex('user_name_search', e => [ixNormalized(e.username, { gin: true })]);
    });
  }
}

// Invalid: GIN cannot be unique
class GinUniqueNormDb extends DbContext {
  get users(): DbEntityTable<NormUser> { return this.table(NormUser); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(NormUser, entity => {
      defineColumns(entity, 'users_norm_gin_unique');
      entity.hasIndex('bad_idx', e => [ixNormalized(e.username, { gin: true })]).isUnique();
    });
  }
}

// Query-only opt-in: no ixNormalized index, but model.useSearchNormalize()
class OptInNormDb extends DbContext {
  get users(): DbEntityTable<NormUser> { return this.table(NormUser); }
  protected override setupModel(model: DbModelConfig): void {
    model.useSearchNormalize();
    model.entity(NormUser, entity => {
      defineColumns(entity, 'users_norm_optin');
    });
  }
}

async function functionExists(client: any): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM pg_proc WHERE proname = 'search_normalize'`);
  return res.rows.length > 0;
}

async function extensionExists(client: any, name: string): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM pg_extension WHERE extname = $1`, [name]);
  return res.rows.length > 0;
}

describe('ixNormalized / search_normalize support', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  test('btree ixNormalized index auto-creates unaccent + search_normalize function', async () => {
    const client = createFreshClient();
    const db = new BtreeNormDb(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_norm_btree CASCADE`);
      // Prove auto-creation: remove the function first
      await client.query(`DROP FUNCTION IF EXISTS public.search_normalize(text) CASCADE`);
      expect(await functionExists(client)).toBe(false);

      await db.getSchemaManager().ensureCreated();

      expect(await functionExists(client)).toBe(true);
      expect(await extensionExists(client, 'unaccent')).toBe(true);

      const indexResult = await client.query(`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'users_norm_btree' AND indexname = 'user_admin_query'
      `);
      expect(indexResult.rows).toHaveLength(1);
      const def: string = indexResult.rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      expect(def).toContain('search_normalize');
      expect(def).not.toContain('USING gin');
      // text_pattern_ops makes normalizedStartsWith (LIKE 'prefix%') index-usable
      // on non-C collations while still serving normalizedEq and UNIQUE.
      expect(def).toContain('text_pattern_ops');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_norm_btree CASCADE`);
      await db.dispose();
    }
  });

  test('normalizedStartsWith is index-usable on the btree (text_pattern_ops) index', async () => {
    const client = createFreshClient();
    const db = new BtreeNormDb(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_norm_btree CASCADE`);
      await db.getSchemaManager().ensureCreated();

      await client.query(`
        INSERT INTO users_norm_btree (email, hash, username)
        SELECT 'José' || lpad(g::text, 6, '0') || '@x.com', md5(g::text), 'u' || g
        FROM generate_series(1, 5000) g
      `);
      await client.query('ANALYZE users_norm_btree');

      // Mirrors the SQL produced by normalizedStartsWith(email, 'JOSÉ000123')
      const plan = await client.query(
        `EXPLAIN (COSTS OFF) SELECT * FROM users_norm_btree
         WHERE public.search_normalize(email) LIKE public.search_normalize($1) || '%'`,
        ['JOSÉ000123']
      );
      const text = plan.rows.map((r: any) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('user_admin_query'); // the index is used
      expect(text).not.toContain('Seq Scan');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_norm_btree CASCADE`);
      await db.dispose();
    }
  });

  test('ixNormalized(col, { gin: true }) builds a trigram GIN index and installs pg_trgm', async () => {
    const client = createFreshClient();
    const db = new GinNormDb(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_norm_gin CASCADE`);
      await db.getSchemaManager().ensureCreated();

      expect(await extensionExists(client, 'pg_trgm')).toBe(true);

      const indexResult = await client.query(`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'users_norm_gin' AND indexname = 'user_name_search'
      `);
      expect(indexResult.rows).toHaveLength(1);
      const def: string = indexResult.rows[0].indexdef;
      expect(def).toContain('USING gin');
      expect(def).toContain('search_normalize');
      expect(def).toContain('gin_trgm_ops');
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_norm_gin CASCADE`);
      await db.dispose();
    }
  });

  test('rejects a UNIQUE GIN normalized index', async () => {
    const client = createFreshClient();
    const db = new GinUniqueNormDb(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_norm_gin_unique CASCADE`);
      await expect(db.getSchemaManager().ensureCreated()).rejects.toThrow(/UNIQUE and a GIN/i);
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_norm_gin_unique CASCADE`);
      await db.dispose();
    }
  });

  test('sets the transferable hasNormalizedIndex flag on the indexed column only', () => {
    (EntityMetadataStore as any).metadata.clear();
    const client = createFreshClient();
    const db = new BtreeNormDb(client);

    const metadata = EntityMetadataStore.getMetadata(NormUser)!;
    expect(metadata.properties.get('email' as any)?.hasNormalizedIndex).toBe(true);
    expect(metadata.properties.get('username' as any)?.hasNormalizedIndex).toBeUndefined();
    // mirrored onto the built column config
    expect((metadata.properties.get('email' as any)?.columnBuilder as any).build().hasNormalizedIndex).toBe(true);

    return db.dispose();
  });

  test('model.useSearchNormalize() creates the function without any index', async () => {
    const client = createFreshClient();
    const db = new OptInNormDb(client);

    try {
      await client.query(`DROP TABLE IF EXISTS users_norm_optin CASCADE`);
      await client.query(`DROP FUNCTION IF EXISTS public.search_normalize(text) CASCADE`);
      expect(await functionExists(client)).toBe(false);

      await db.getSchemaManager().ensureCreated();

      expect(await functionExists(client)).toBe(true);
      expect(await extensionExists(client, 'unaccent')).toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS users_norm_optin CASCADE`);
      await db.dispose();
    }
  });
});
