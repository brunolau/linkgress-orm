import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createFreshClient } from '../utils/test-database';
import {
  DbContext, DbEntityTable, DbModelConfig, DbEntity, DbColumn, integer, varchar,
  ixNormalized, normalizedEq, normalizedLike, normalizedStartsWith, searchNormalize, containsSearch, sql,
} from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';

class SearchUser extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
}

class NormalizedSearchDb extends DbContext {
  get users(): DbEntityTable<SearchUser> { return this.table(SearchUser); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(SearchUser, entity => {
      entity.toTable('users_norm_search');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'users_norm_search_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 200)).isRequired();
      // Trigram GIN index over search_normalize(name) so substring search is index-assisted
      entity.hasIndex('users_norm_search_name', e => [ixNormalized(e.name, { gin: true })]);
    });
  }
}

describe('Normalized search query helpers', () => {
  let client: ReturnType<typeof createFreshClient>;
  let db: NormalizedSearchDb;

  beforeAll(async () => {
    (EntityMetadataStore as any).metadata.clear();
    client = createFreshClient();
    db = new NormalizedSearchDb(client);

    await client.query(`DROP TABLE IF EXISTS users_norm_search CASCADE`);
    await db.getSchemaManager().ensureCreated();

    // Accent/case variants on purpose
    await db.users.insertBulk([
      { name: 'José' },
      { name: 'jose' },
      { name: 'JOSÉ' },
      { name: 'María' },
      { name: 'Renée' },
      { name: 'Zoe' },
    ]);
  });

  afterAll(async () => {
    try {
      await client.query(`DROP TABLE IF EXISTS users_norm_search CASCADE`);
    } catch {
      // ignore
    }
    await db.dispose();
  });

  test('normalizedEq matches across accents and case', async () => {
    const rows = await db.users.where(u => normalizedEq(u.name, 'jose')).toList();
    const names = rows.map(r => r.name).sort();
    expect(names).toEqual(['JOSÉ', 'José', 'jose'].sort());
  });

  test('normalizedStartsWith matches a normalized prefix', async () => {
    const rows = await db.users.where(u => normalizedStartsWith(u.name, 'jo')).toList();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.name.toLowerCase().startsWith('jo') || r.name === 'JOSÉ' || r.name === 'José')).toBe(true);
  });

  test('normalizedLike with containsSearch finds a normalized substring (case-insensitive pattern)', async () => {
    const rows = await db.users.where(u => normalizedLike(u.name, containsSearch('OS'))).toList();
    // 'José', 'jose', 'JOSÉ' all normalize to contain 'os'
    expect(rows).toHaveLength(3);
  });

  test('low-level sql`` with searchNormalize + containsSearch', async () => {
    const query = 'REN';
    const rows = await db.users
      .where(u => sql<boolean>`${searchNormalize(u.name)} LIKE ${searchNormalize(containsSearch(query))}`)
      .toList();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renée');
  });

  test('normalizedEq with an accented argument also normalizes the argument', async () => {
    const rows = await db.users.where(u => normalizedEq(u.name, 'JOSÉ')).toList();
    expect(rows).toHaveLength(3);
  });
});
