/**
 * Collections over tables OUTSIDE the default schema, under every collection strategy.
 *
 *   sq_owners (public)  <- sq_zoo.sq_pets -> sq_zoo.sq_kinds
 *                              ^
 *                              +-- sq_zoo.sq_toys
 *
 *   owner  pets (id order)   pet's kind   pet's toys
 *   Ann    Tom, Rex          dog, cat     Tom: ball, rope — Rex: mouse
 *   Ben    Fido              dog          -
 *   Cid    -
 *
 * Root queries and navigations always named a table's schema, but a collection read its table
 * unqualified: every strategy's SQL said `FROM "sq_pets"`, which resolves through the search_path
 * — `relation "sq_pets" does not exist`, or silently another schema's table of the same name. So
 * did the `exists()` / `count()` subquery of a collection in a WHERE or a `sql` fragment, the hop
 * of a navigation a collection hangs off (`p.kind.pets`), a selectMany bridge, and the single
 * round-trip temp-table form of the multi-statement drivers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DbColumn,
  DbContext,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  DatabaseClient,
  PostgresClient,
  eq,
  exists,
  gt,
  integer,
  sql,
  varchar,
} from '../../src';
import type { CollectionStrategyType } from '../../src/query/collection-strategy.interface';
import { createFreshClient, testConnectionConfig } from '../utils/test-database';

class SqOwner extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;

  pets?: SqPet[];
}

class SqPet extends DbEntity {
  id!: DbColumn<number>;
  name!: DbColumn<string>;
  ownerId!: DbColumn<number>;
  kindId!: DbColumn<number>;

  kind?: SqKind;
  toys?: SqToy[];
}

class SqKind extends DbEntity {
  id!: DbColumn<number>;
  label!: DbColumn<string>;

  pets?: SqPet[];
}

class SqToy extends DbEntity {
  id!: DbColumn<number>;
  title!: DbColumn<string>;
  petId!: DbColumn<number>;
}

class ZooDatabase extends DbContext {
  get owners(): DbEntityTable<SqOwner> {
    return this.table(SqOwner);
  }

  get pets(): DbEntityTable<SqPet> {
    return this.table(SqPet);
  }

  get kinds(): DbEntityTable<SqKind> {
    return this.table(SqKind);
  }

  get toys(): DbEntityTable<SqToy> {
    return this.table(SqToy);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SqOwner, entity => {
      entity.toTable('sq_owners');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'sq_owners_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();

      entity.hasMany(e => e.pets, () => SqPet).withForeignKey(p => p.ownerId).withPrincipalKey(o => o.id);
    });

    model.entity(SqPet, entity => {
      entity.toTable('sq_pets');
      entity.toSchema('sq_zoo');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'sq_pets_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 50)).isRequired();
      entity.property(e => e.ownerId).hasType(integer('owner_id')).isRequired();
      entity.property(e => e.kindId).hasType(integer('kind_id')).isRequired();

      entity.hasOne(e => e.kind, () => SqKind).withForeignKey(p => p.kindId).withPrincipalKey(k => k.id);
      entity.hasMany(e => e.toys, () => SqToy).withForeignKey(t => t.petId).withPrincipalKey(p => p.id);
    });

    model.entity(SqKind, entity => {
      entity.toTable('sq_kinds');
      entity.toSchema('sq_zoo');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'sq_kinds_id_seq' }));
      entity.property(e => e.label).hasType(varchar('label', 50)).isRequired();

      entity.hasMany(e => e.pets, () => SqPet).withForeignKey(p => p.kindId).withPrincipalKey(k => k.id);
    });

    model.entity(SqToy, entity => {
      entity.toTable('sq_toys');
      entity.toSchema('sq_zoo');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'sq_toys_id_seq' }));
      entity.property(e => e.title).hasType(varchar('title', 50)).isRequired();
      entity.property(e => e.petId).hasType(integer('pet_id')).isRequired();
    });
  }
}

const STRATEGIES: readonly CollectionStrategyType[] = ['lateral', 'cte', 'temptable'];

interface ZooIds {
  cat: number;
  dog: number;
  ann: number;
  ben: number;
  cid: number;
  tom: number;
  rex: number;
  fido: number;
}

const dropZoo = async (client: DatabaseClient): Promise<void> => {
  await client.query('DROP TABLE IF EXISTS sq_owners CASCADE');
  await client.query('DROP SCHEMA IF EXISTS sq_zoo CASCADE');
};

let client: DatabaseClient;
let db: ZooDatabase;
let ids: ZooIds;
const captured: string[] = [];

beforeAll(async () => {
  client = createFreshClient();
  db = new ZooDatabase(client, { logQueries: true, logger: (message: string) => { captured.push(message); } });

  await dropZoo(client);
  await db.getSchemaManager().ensureCreated();

  const [cat, dog] = await db.kinds.insertBulk([{ label: 'cat' }, { label: 'dog' }]).returning();
  const [ann, ben, cid] = await db.owners.insertBulk([{ name: 'Ann' }, { name: 'Ben' }, { name: 'Cid' }]).returning();
  const [tom, rex, fido] = await db.pets.insertBulk([
    { name: 'Tom', ownerId: ann.id, kindId: dog.id },
    { name: 'Rex', ownerId: ann.id, kindId: cat.id },
    { name: 'Fido', ownerId: ben.id, kindId: dog.id },
  ]).returning();
  await db.toys.insertBulk([
    { title: 'ball', petId: tom.id },
    { title: 'rope', petId: tom.id },
    { title: 'mouse', petId: rex.id },
  ]).returning();

  ids = { cat: cat.id, dog: dog.id, ann: ann.id, ben: ben.id, cid: cid.id, tom: tom.id, rex: rex.id, fido: fido.id };
});

afterAll(async () => {
  await dropZoo(client);
  await db.dispose();
});

/** The logged statements (without the logger's `[…]` headers) since the last call. */
const takeStatements = (): string[] => {
  const statements = captured.filter(entry => !entry.trimStart().startsWith('['));
  captured.length = 0;

  return statements;
};

for (const strategy of STRATEGIES) {
  const owners = () => db.owners.withQueryOptions({ collectionStrategy: strategy }).orderBy(o => o.id);

  describe(`a collection over a table of another schema — ${strategy}`, () => {
    test('a list reads the schema-qualified table', async () => {
      takeStatements();
      const rows = await owners()
        .select(o => ({ name: o.name, pets: o.pets!.orderBy(p => p.id).select(p => ({ id: p.id, name: p.name })).toList('pets') }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ann', pets: [{ id: ids.tom, name: 'Tom' }, { id: ids.rex, name: 'Rex' }] },
        { name: 'Ben', pets: [{ id: ids.fido, name: 'Fido' }] },
        { name: 'Cid', pets: [] },
      ]);
      expect(takeStatements().join('\n')).toContain('"sq_zoo"."sq_pets"');
    });

    test('a navigation of the item into the same schema, projected and ordered by', async () => {
      const rows = await owners()
        .select(o => ({ name: o.name, pets: o.pets!.orderBy(p => p.kind!.label).select(p => ({ name: p.name, kind: p.kind!.label })).toList('pets') }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ann', pets: [{ name: 'Rex', kind: 'cat' }, { name: 'Tom', kind: 'dog' }] },
        { name: 'Ben', pets: [{ name: 'Fido', kind: 'dog' }] },
        { name: 'Cid', pets: [] },
      ]);
    });

    test('count, max, a flat list and exists', async () => {
      const rows = await owners()
        .select(o => ({
          name: o.name,
          count: o.pets!.count(),
          maxId: o.pets!.max(p => p.id),
          names: o.pets!.orderBy(p => p.name).select(p => p.name).toStringList('names'),
          hasRex: o.pets!.where(p => eq(p.name, 'Rex')).exists(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ann', count: 2, maxId: ids.rex, names: ['Rex', 'Tom'], hasRex: true },
        { name: 'Ben', count: 1, maxId: ids.fido, names: ['Fido'], hasRex: false },
        { name: 'Cid', count: 0, maxId: null, names: [], hasRex: false },
      ]);
    });

    test('a limited list, a limited count and firstOrDefault', async () => {
      const rows = await owners()
        .select(o => ({
          name: o.name,
          first: o.pets!.orderBy(p => p.name).limit(1).select(p => ({ name: p.name })).toList('first'),
          rest: o.pets!.orderBy(p => p.name).offset(1).count(),
          last: o.pets!.orderBy(p => [[p.name, 'DESC']]).select(p => ({ name: p.name })).firstOrDefault('last'),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ann', first: [{ name: 'Rex' }], rest: 1, last: { name: 'Tom' } },
        { name: 'Ben', first: [{ name: 'Fido' }], rest: 0, last: { name: 'Fido' } },
        { name: 'Cid', first: [], rest: 0, last: null },
      ]);
    });

    test('a collection nested in it, over the same schema', async () => {
      const rows = await owners()
        .select(o => ({
          name: o.name,
          pets: o.pets!.orderBy(p => p.id).select(p => ({
            name: p.name,
            toys: p.toys!.orderBy(t => t.title).select(t => ({ title: t.title })).toList('toys'),
            toyCount: p.toys!.count(),
          })).toList('pets'),
        }))
        .toList();

      expect(rows).toEqual([
        {
          name: 'Ann',
          pets: [
            { name: 'Tom', toys: [{ title: 'ball' }, { title: 'rope' }], toyCount: 2 },
            { name: 'Rex', toys: [{ title: 'mouse' }], toyCount: 1 },
          ],
        },
        { name: 'Ben', pets: [{ name: 'Fido', toys: [], toyCount: 0 }] },
        { name: 'Cid', pets: [] },
      ]);
    });

    test('a collection hanging off a navigation into the schema (`p.kind.pets`)', async () => {
      const rows = await db.pets
        .withQueryOptions({ collectionStrategy: strategy })
        .orderBy(p => p.id)
        .select(p => ({
          name: p.name,
          sameKind: p.kind!.pets!.orderBy(x => x.id).select(x => ({ name: x.name })).toList('sameKind'),
          sameKindCount: p.kind!.pets!.count(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Tom', sameKind: [{ name: 'Tom' }, { name: 'Fido' }], sameKindCount: 2 },
        { name: 'Rex', sameKind: [{ name: 'Rex' }], sameKindCount: 1 },
        { name: 'Fido', sameKind: [{ name: 'Tom' }, { name: 'Fido' }], sameKindCount: 2 },
      ]);
    });

    test('selectMany through the schema', async () => {
      const rows = await owners()
        .select(o => ({
          name: o.name,
          toys: o.pets!.selectMany(p => p.toys!).orderBy(t => t.title).select(t => ({ title: t.title })).toList('toys'),
          hasToys: o.pets!.selectMany(p => p.toys!).exists(),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ann', toys: [{ title: 'ball' }, { title: 'mouse' }, { title: 'rope' }], hasToys: true },
        { name: 'Ben', toys: [], hasToys: false },
        { name: 'Cid', toys: [], hasToys: false },
      ]);
    });
  });
}

describe('a collection over a table of another schema — conditions, fragments, RETURNING', () => {
  test('exists() in a WHERE, through a navigation of the item', async () => {
    const rows = await db.owners
      .where(o => exists(o.pets!.where(p => eq(p.kind!.label, 'cat'))))
      .select(o => ({ name: o.name }))
      .toList();

    expect(rows).toEqual([{ name: 'Ann' }]);
  });

  test('count() inside a sql fragment, in the projection and in the WHERE', async () => {
    const counted = await db.owners
      .orderBy(o => o.id)
      .select(o => ({ name: o.name, count: sql<number>`${o.pets!.count()}::int` }))
      .toList();

    expect(counted).toEqual([
      { name: 'Ann', count: 2 },
      { name: 'Ben', count: 1 },
      { name: 'Cid', count: 0 },
    ]);

    const filtered = await db.owners
      .where(o => sql`(${o.pets!.where(p => eq(p.name, 'Fido')).count()}) > 0`)
      .select(o => ({ name: o.name }))
      .toList();

    expect(filtered).toEqual([{ name: 'Ben' }]);
  });

  test('a collection and a count in UPDATE … RETURNING', async () => {
    const rows = await db.owners
      .where(o => eq(o.name, 'Ann'))
      .update({ name: 'Ann' })
      // RETURNING selectors are typed as row data; the navigations are there at runtime
      .returning((o: any) => ({ name: o.name, pets: o.pets!.orderBy((p: any) => p.id).select((p: any) => ({ name: p.name })).toList('pets'), count: o.pets!.count() }));

    expect(rows as any).toEqual([{ name: 'Ann', pets: [{ name: 'Tom' }, { name: 'Rex' }], count: 2 }]);
  });
});

// The single round-trip temp-table form: only multi-statement drivers take it
describe.skipIf(process.env.LINKGRESS_TEST_DRIVER === 'pglite')('temp-table strategy on a multi-statement driver (postgres.js)', () => {
  let multiDb: ZooDatabase;
  const multiCaptured: string[] = [];

  beforeAll(() => {
    multiDb = new ZooDatabase(new PostgresClient(testConnectionConfig()), {
      logQueries: true,
      collectionStrategy: 'temptable',
      logger: (message: string) => { multiCaptured.push(message); },
    });
  });

  afterAll(async () => {
    await multiDb.dispose();
  });

  const statements = (): string => {
    const text = multiCaptured.filter(entry => !entry.trimStart().startsWith('[')).join('\n');
    multiCaptured.length = 0;

    return text;
  };

  test('a plain list is served by one multi-statement round trip over the schema-qualified table', async () => {
    statements();
    const rows = await multiDb.owners
      .orderBy(o => o.id)
      .select(o => ({ name: o.name, pets: o.pets!.orderBy(p => p.id).select(p => ({ id: p.id, name: p.name })).toList('pets') }))
      .toList();

    expect(rows).toEqual([
      { name: 'Ann', pets: [{ id: ids.tom, name: 'Tom' }, { id: ids.rex, name: 'Rex' }] },
      { name: 'Ben', pets: [{ id: ids.fido, name: 'Fido' }] },
      { name: 'Cid', pets: [] },
    ]);

    const text = statements();
    expect(text).toContain('tmp_base_');
    expect(text).toContain('FROM "sq_zoo"."sq_pets"');
  });

  test('an ORDER BY key the projection reuses as an alias orders by the column, not by the alias', async () => {
    statements();
    // `id` is projected as the KIND id: `ORDER BY "id"` bound to that output column
    const rows = await multiDb.owners
      .orderBy(o => o.id)
      .select(o => ({ name: o.name, pets: o.pets!.orderBy(p => [[p.id, 'DESC']]).select(p => ({ id: p.kindId, name: p.name })).toList('pets') }))
      .toList();

    expect(rows).toEqual([
      { name: 'Ann', pets: [{ id: ids.cat, name: 'Rex' }, { id: ids.dog, name: 'Tom' }] },
      { name: 'Ben', pets: [{ id: ids.dog, name: 'Fido' }] },
      { name: 'Cid', pets: [] },
    ]);
    expect(statements()).toContain('ORDER BY "sq_pets"."id" DESC');
  });

  test('parameters of a filtered collection reach the database as the values they are', async () => {
    const title = `back\\slash 'quoted' $1 -- not a comment`;
    const [toy] = await multiDb.toys.insertBulk([{ title, petId: ids.rex }]).returning();

    try {
      statements();
      const rows = await multiDb.owners
        .orderBy(o => o.id)
        .select(o => ({
          name: o.name,
          pets: o.pets!.where(p => gt(p.id, -1)).orderBy(p => p.id).select(p => ({
            name: p.name,
            toys: p.toys!.where(t => eq(t.title, title)).select(t => ({ title: t.title })).toList('toys'),
          })).toList('pets'),
        }))
        .toList();

      expect(rows).toEqual([
        { name: 'Ann', pets: [{ name: 'Tom', toys: [] }, { name: 'Rex', toys: [{ title }] }] },
        { name: 'Ben', pets: [{ name: 'Fido', toys: [] }] },
        { name: 'Cid', pets: [] },
      ]);
      // The two-phase form ran, with the values written into the statement
      expect(statements()).toContain('(-1)');
    } finally {
      await multiDb.toys.where(t => eq(t.id, toy.id)).delete();
    }
  });

  test('a projected `parent_id` does not collide with the parent key the rows are grouped by', async () => {
    statements();
    const rows = await multiDb.owners
      .orderBy(o => o.id)
      .select(o => ({ name: o.name, pets: o.pets!.orderBy(p => p.id).select(p => ({ parent_id: p.kindId, name: p.name })).toList('pets') }))
      .toList();

    expect(rows).toEqual([
      { name: 'Ann', pets: [{ parent_id: ids.dog, name: 'Tom' }, { parent_id: ids.cat, name: 'Rex' }] },
      { name: 'Ben', pets: [{ parent_id: ids.dog, name: 'Fido' }] },
      { name: 'Cid', pets: [] },
    ]);
    expect(statements()).not.toContain('tmp_base_');
  });
});
