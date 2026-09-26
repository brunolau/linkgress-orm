import { describe, test, expect, beforeEach } from 'bun:test';
import {
  bigint, boolean as pgBoolean, cast, DbColumn, DbContext, DbEntity, DbEntityTable, DbModelConfig, eq, integer, literal, lower,
  regexpReplace, serial, smallint, sql, text, varchar,
} from '../../src';
import type { DatabaseClient, SqlFragment } from '../../src';
import { EntityMetadataStore } from '../../src/entity/entity-base';
import { compareIndexDefinition, normalizeIndexFragment } from '../../src/migration/index-sql';
import type { MigrationOperation } from '../../src/migration/db-schema-manager';
import { createFreshClient } from '../utils/test-database';

/**
 * Index expressions written with the query builders — `withExpression(e => <fragment>)` — so an expression
 * index and the query that must use it share ONE definition. The callback receives the table's columns as
 * UNQUALIFIED refs; the fragment renders bind-free, verbatim when it is one function call or one
 * parenthesised group (PostgreSQL's own `pg_get_indexdef` spelling), otherwise wrapped in `( … )`. The
 * index normaliser folds `CAST(x AS t)` like `x::t`, so builder-rendered indexes pass the reconcile's fast
 * comparison against what existing databases hold.
 */

const TABLE = 'ixb_items';

class IxbGroup extends DbEntity {
  id!: DbColumn<number>;
}

/** The columns every model version below shares (one physical table). */
class IxbItem extends DbEntity {
  id!: DbColumn<number>;
  n!: DbColumn<number>;
  code!: DbColumn<string>;
  name!: DbColumn<string>;
  active!: DbColumn<boolean>;
  flags!: DbColumn<number>;
  groupId!: DbColumn<number | null>;
  group?: IxbGroup;
}

/** Shared by the indexes and the queries: the last seven digits of `n` — `%` (an operator), an inline bigint modulus. */
const suffixKey = (n: unknown): SqlFragment<number> => sql<number>`${n} % ${literal(10000000, 'bigint')}`;
/** Every digit of a code, separators dropped. */
const digitsKey = (code: unknown): SqlFragment<string> => regexpReplace(code as any, literal('[^0-9]'), literal(''), literal('g'));

function defineColumns(entity: any): void {
  entity.toTable(TABLE);
  entity.property((e: IxbItem) => e.id).hasType(serial('id')).isPrimaryKey();
  entity.property((e: IxbItem) => e.n).hasType(bigint('n')).isRequired();
  entity.property((e: IxbItem) => e.code).hasType(varchar('code', 32)).isRequired();
  entity.property((e: IxbItem) => e.name).hasType(text('name')).isRequired();
  entity.property((e: IxbItem) => e.active).hasType(pgBoolean('active')).isRequired();
  entity.property((e: IxbItem) => e.flags).hasType(smallint('flags')).isRequired();
  entity.property((e: IxbItem) => e.groupId).hasType(integer('group_id'));
}

// ---- model versions (distinct entity classes, one table) ----

class LegacyItem extends IxbItem {}
class BuilderItem extends IxbItem {}

/** Today's raw-text spelling of the three indexes. */
class LegacyDb extends DbContext {
  get items(): DbEntityTable<LegacyItem> { return this.table(LegacyItem); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(LegacyItem, e => {
      defineColumns(e);
      e.hasIndex('ix_ixb_suffix7').withExpression('(n % 10000000::bigint)');
      e.hasIndex('ix_ixb_digits').withExpression("(regexp_replace(code, '[^0-9]', '', 'g'))");
      e.hasIndex('ix_ixb_name_lower').withExpression('lower(name)');
    });
  }
}

/** The same three indexes from the builders the queries use. */
class BuilderDb extends DbContext {
  get items(): DbEntityTable<BuilderItem> { return this.table(BuilderItem); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(IxbGroup, e => {
      e.toTable('ixb_groups');
      e.property(g => g.id).hasType(serial('id')).isPrimaryKey();
    });
    model.entity(BuilderItem, e => {
      defineColumns(e);
      e.hasOne(i => i.group, () => IxbGroup).withForeignKey(i => i.groupId).withPrincipalKey(g => g.id).isInverseNavigation();
      e.hasIndex('ix_ixb_suffix7').withExpression(i => suffixKey(i.n));
      e.hasIndex('ix_ixb_digits').withExpression(i => digitsKey(i.code));
      e.hasIndex('ix_ixb_name_lower').withExpression(i => lower(i.name));
      e.hasStatistics('stx_ixb_flag_bit').withExpression(i => sql`(${i.flags} & ${literal(1, 'smallint')})`);
    });
  }
}

/** A compound expression cast (`CAST(flags + 1 AS bigint) * 2`) and a bare cast, both from builders. */
const flagExpr = (flags: unknown): SqlFragment<number> => sql<number>`${cast(sql`${flags} + ${literal(1)}`, 'bigint')} * ${literal(2)}`;

class PlainExprItem extends IxbItem {}
class CastExprItem extends IxbItem {}

/** `ix_ixb_flag_expr` WITHOUT the cast: `flags + 1 * 2` — a different expression. */
class PlainExprDb extends DbContext {
  get items(): DbEntityTable<PlainExprItem> { return this.table(PlainExprItem); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(PlainExprItem, e => {
      defineColumns(e);
      e.hasIndex('ix_ixb_flag_expr').withExpression('(flags + 1 * 2)');
    });
  }
}

class CastExprDb extends DbContext {
  get items(): DbEntityTable<CastExprItem> { return this.table(CastExprItem); }
  protected override setupModel(model: DbModelConfig): void {
    model.entity(CastExprItem, e => {
      defineColumns(e);
      e.hasIndex('ix_ixb_flag_expr').withExpression(i => flagExpr(i.flags));
      e.hasIndex('ix_ixb_code_text').withExpression(i => cast(i.code, 'text'));
    });
  }
}

function indexOps(ops: MigrationOperation[]): MigrationOperation[] {
  return ops.filter(o => o.type === 'create_index' || o.type === 'recreate_index' || o.type === 'drop_index');
}

async function canonicalDef(client: DatabaseClient, indexName: string): Promise<string> {
  const result = await client.query('SELECT pg_get_indexdef(to_regclass($1)::oid, 0, true) AS d', [indexName]);
  return result.rows[0].d;
}

/** A client that records every statement it runs (to see whether the reconcile needed its mirror table). */
function recording(client: DatabaseClient): { client: DatabaseClient; statements: string[] } {
  const statements: string[] = [];
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sql: string, params?: any[], options?: any) => {
          statements.push(sql);
          return (target as any).query(sql, params, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { client: proxy, statements };
}

describe('index expressions from builders', () => {
  beforeEach(() => {
    (EntityMetadataStore as any).metadata.clear();
  });

  describe('rendering', () => {
    const expressionsOf = (build: (e: any) => void): string[] => {
      new DbModelConfig().entity(IxbItem, entity => {
        defineColumns(entity);
        build(entity);
      });
      return EntityMetadataStore.getMetadata(IxbItem)!.indexes.find(ix => ix.name === 'ix_probe')!.expressions!;
    };

    test('one function call or one parenthesised group is kept verbatim, anything else is wrapped', () => {
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => digitsKey(i.code)))).toEqual([`regexp_replace("code", '[^0-9]', '', 'g')`]);
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => suffixKey(i.n)))).toEqual(['("n" % CAST(10000000 AS bigint))']);
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => sql`(${i.n} % 7)`))).toEqual(['("n" % 7)']);
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => sql`${lower(i.code)} || ${lower(i.name)}`))).toEqual(['(lower("code") || lower("name"))']);
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => eq(i.active, literal(true))))).toEqual(['("active" = TRUE)']);
      // string forms are kept exactly as written, and may be mixed with builders
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression('lower(code)', (i: any) => i.name))).toEqual(['lower(code)', '"name"']);
    });

    test('the paren scan skips quoted literals and identifiers', () => {
      // the pattern's parentheses are inside a literal: still ONE call
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => sql`substring(${i.code}, ${literal('^[0-9]+-([0-9]+)-[0-9]+$')})`)))
        .toEqual([`substring("code", '^[0-9]+-([0-9]+)-[0-9]+$')`]);
      // quoted parentheses that would balance a naive scan: two calls, wrapped
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression(() => sql`upper(${literal('(')}) || lower(${literal(')')})`)))
        .toEqual([`(upper('(') || lower(')'))`]);
      // an escape-string literal (a backslash) and a quoted identifier with a parenthesis
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression(() => sql`upper(${literal('x\\)')})`))).toEqual([`upper(E'x\\\\)')`]);
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression(() => sql`lower("odd)name")`))).toEqual([`lower("odd)name")`]);
      // a keyword before a parenthesis is no function call
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => sql`NOT (${i.active})`))).toEqual(['(NOT ("active"))']);
      // nor is CAST (pg_get_indexdef prints a cast element as `((code)::text)`)
      expect(expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => cast(i.code, 'text')))).toEqual(['(CAST("code" AS text))']);
    });

    test('the statistics builder takes the same builders', () => {
      new DbModelConfig().entity(IxbItem, entity => {
        defineColumns(entity);
        entity.hasStatistics('stx_probe').withExpression((i: any) => sql`(${i.flags} & ${literal(1, 'smallint')})`, (i: any) => lower(i.name));
      });

      expect(EntityMetadataStore.getMetadata(IxbItem)!.statistics!.find(s => s.name === 'stx_probe')!.expressions)
        .toEqual(['("flags" & CAST(1 AS smallint))', 'lower("name")']);
    });

    test('a bound parameter or a placeholder is refused — an index expression takes constants inline', () => {
      expect(() => expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => eq(i.active, true))))
        .toThrow('Index "ix_probe": index expression binds a parameter — inline constants with literal()');
      expect(() => expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => sql`${i.n} % ${10}`)))
        .toThrow('index expression binds a parameter');
      expect(() => expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => eq(i.n, sql.placeholder('n')))))
        .toThrow('index expression binds a parameter');
    });

    test('navigations and unknown properties are not in scope', () => {
      expect(() => expressionsOf(e => {
        e.hasOne((i: IxbItem) => i.group, () => IxbGroup).withForeignKey((i: IxbItem) => i.groupId).withPrincipalKey((g: IxbGroup) => g.id);
        e.hasIndex('ix_probe').withExpression((i: any) => lower(i.group.id));
      })).toThrow('Index "ix_probe": navigation "group" is not available — only the row\'s own columns are in scope');
      expect(() => expressionsOf(e => e.hasIndex('ix_probe').withExpression((i: any) => lower(i.nope))))
        .toThrow('Index "ix_probe": e.nope is not a column of "ixb_items"');
    });

    test('the index normaliser folds CAST(x AS t) like x::t', () => {
      expect(normalizeIndexFragment('("n" % CAST(10000000 AS bigint))')).toBe(normalizeIndexFragment('(n % 10000000::bigint)'));
      expect(normalizeIndexFragment('CAST(CAST("a" AS text) AS varchar(255))')).toBe('a');
      expect(normalizeIndexFragment(`f(CAST(("a" + 1) AS integer), 'cast(x as y)')`)).toBe(`f((a + 1), 'cast(x as y)')`);
      expect(normalizeIndexFragment('forecast("a")')).toBe('forecast(a)');
    });

    test('CAST folding keeps the grouping of a compound argument, as PostgreSQL prints `(a + b)::bigint`', () => {
      const model = { name: 'ix', columns: [], expressions: ['(CAST("a" + "b" AS bigint) * 2)'] };

      // pg_get_indexdef(oid, 0, true) of PostgreSQL 18: `a + b * 2` is another expression, `(a + b)::bigint * 2` this one
      expect(compareIndexDefinition('CREATE INDEX ix ON public.t USING btree ((a + b * 2))', model).changed).toBe(true);
      expect(compareIndexDefinition('CREATE INDEX ix ON public.t USING btree (((a + b)::bigint * 2))', model).changed).toBe(false);

      // an atomic argument — identifier, constant, literal, one call, one group — folds bare
      expect(normalizeIndexFragment('CAST("a" + "b" AS bigint)')).toBe('(a + b)');
      expect(normalizeIndexFragment('CAST((a + b) AS bigint) * 2')).toBe('(a + b) * 2');
      expect(normalizeIndexFragment('CAST(CAST("a" + "b" AS bigint) AS text)')).toBe('(a + b)');
      expect(normalizeIndexFragment(`CAST(lower("s") AS varchar) || CAST('x' AS text) || CAST(1.5 AS numeric)`)).toBe(`lower(s) || 'x' || 1.5`);
      expect(normalizeIndexFragment('CAST(-"a" AS bigint)')).toBe('(-a)');
    });
  });

  describe('reconcile', () => {
    const dropTables = async (client: DatabaseClient) => {
      await client.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await client.query('DROP TABLE IF EXISTS ixb_groups CASCADE');
    };

    test('builder indexes created fresh reconcile to no change — the CAST-spelled one is confirmed by the mirror, not recreated', async () => {
      const base = createFreshClient();
      const { client, statements } = recording(base);
      const db = new BuilderDb(client);
      try {
        await dropTables(base);
        await db.getSchemaManager().ensureCreated();

        expect(await canonicalDef(base, 'ix_ixb_suffix7')).toMatch(/USING btree \(\(n % '?10000000'?(::bigint)?\)\)/);

        statements.length = 0;
        expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
        // The fast comparison folds CAST(…) away, so it cannot tell an ADDED cast from this one: the suffix7
        // index (`CAST(10000000 AS bigint)`) is settled on PostgreSQL's own canonical form instead.
        expect(statements.some(s => s.includes('_lkg_idxchk_'))).toBe(true);
      } finally {
        await dropTables(base);
        await db.dispose();
      }
    });

    test('an existing index in today\'s raw spelling is not recreated for its builder twin — the mirror confirms the CAST-spelled one', async () => {
      const legacyClient = createFreshClient();
      const legacy = new LegacyDb(legacyClient);
      let builder: BuilderDb | null = null;
      try {
        await dropTables(legacyClient);
        await legacy.getSchemaManager().ensureCreated();
        const before = {
          suffix: await canonicalDef(legacyClient, 'ix_ixb_suffix7'),
          digits: await canonicalDef(legacyClient, 'ix_ixb_digits'),
          lower: await canonicalDef(legacyClient, 'ix_ixb_name_lower'),
        };
        await legacy.dispose();

        (EntityMetadataStore as any).metadata.clear();
        const base = createFreshClient();
        const { client, statements } = recording(base);
        builder = new BuilderDb(client);

        const modelIndexes = (builder as any).schemaRegistry.get(TABLE).indexes;
        for (const [name, def] of [['ix_ixb_suffix7', before.suffix], ['ix_ixb_digits', before.digits], ['ix_ixb_name_lower', before.lower]] as const) {
          const comparison = compareIndexDefinition(def, modelIndexes.find((ix: any) => ix.name === name));
          expect({ name, changed: comparison.changed, reason: comparison.reason }).toEqual({ name, changed: false, reason: undefined });
          // …but an equality the CAST fold produced is only a candidate: suffix7 alone is spelled with a cast.
          expect({ name, needsConfirmation: comparison.needsConfirmation }).toEqual({ name, needsConfirmation: name === 'ix_ixb_suffix7' });
        }

        statements.length = 0;
        const ops = indexOps(await builder.getSchemaManager().analyze());
        expect(ops).toHaveLength(0);
        expect(statements.some(s => s.includes('_lkg_idxchk_'))).toBe(true);

        await builder.getSchemaManager().migrate();
        expect(await canonicalDef(base, 'ix_ixb_suffix7')).toBe(before.suffix);
        expect(await canonicalDef(base, 'ix_ixb_digits')).toBe(before.digits);
      } finally {
        const cleanup = createFreshClient();
        await dropTables(cleanup);
        await cleanup.end();
        if (builder) {
          await builder.dispose();
        }
      }
    });

    test('cast indexes from builders — a bare cast and a compound cast argument — reconcile to no change, confirmed by the mirror', async () => {
      const base = createFreshClient();
      const { client, statements } = recording(base);
      const db = new CastExprDb(client);
      try {
        await dropTables(base);
        await db.getSchemaManager().ensureCreated();

        statements.length = 0;
        expect(indexOps(await db.getSchemaManager().analyze())).toHaveLength(0);
        expect(statements.some(s => s.includes('_lkg_idxchk_'))).toBe(true);
      } finally {
        await dropTables(base);
        await db.dispose();
      }
    });

    test('adding a cast around a compound argument is a change: the index is recreated', async () => {
      const plainClient = createFreshClient();
      const plain = new PlainExprDb(plainClient);
      let withCast: CastExprDb | null = null;
      try {
        await dropTables(plainClient);
        await plain.getSchemaManager().ensureCreated();
        await plain.dispose();

        (EntityMetadataStore as any).metadata.clear();
        withCast = new CastExprDb(createFreshClient());
        const ops = indexOps(await withCast.getSchemaManager().analyze());

        expect(ops.map(o => [o.type, (o as any).indexName]).sort()).toEqual([['create_index', 'ix_ixb_code_text'], ['recreate_index', 'ix_ixb_flag_expr']]);
      } finally {
        const cleanup = createFreshClient();
        await dropTables(cleanup);
        await cleanup.end();
        if (withCast) {
          await withCast.dispose();
        }
      }
    });

    test('a query written with the same builder expression uses the index', async () => {
      const client = createFreshClient();
      const db = new BuilderDb(client);
      try {
        await dropTables(client);
        await db.getSchemaManager().ensureCreated();
        await db.items.insertBulk(Array.from({ length: 150 }, (_, i) => ({
          n: 4000000000000 + i * 131,
          code: `${i}-${i * 7}-${i}`,
          name: `Item ${i}`,
          active: i % 2 === 0,
          flags: i % 4,
        })));
        await client.query(`ANALYZE ${TABLE}`);

        const plans = await db.transaction(async tx => {
          await tx.query('SET LOCAL enable_seqscan = off');
          const explain = async (query: { buildSql(ctx: any): string }) => {
            const context = { paramCounter: 1, params: [] as any[] };
            const text = query.buildSql(context);
            const rows = await tx.query(`EXPLAIN ${text}`, context.params);
            return rows.map((r: any) => r['QUERY PLAN']).join('\n');
          };

          return {
            suffix: await explain(tx.items.where(i => eq(suffixKey(i.n), 262)).select(i => ({ id: i.id })).asSubquery('table')),
            digits: await explain(tx.items.where(i => eq(digitsKey(i.code), '1071')).select(i => ({ id: i.id })).asSubquery('table')),
          };
        });

        expect(plans.suffix).toContain('ix_ixb_suffix7');
        expect(plans.digits).toContain('ix_ixb_digits');
      } finally {
        await dropTables(client);
        await db.dispose();
      }
    });
  });
});
