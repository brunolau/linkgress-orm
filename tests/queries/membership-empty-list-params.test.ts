import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  add,
  and,
  arrayContainedBy,
  arrayContainsAll,
  arrayOverlaps,
  castAsJsonb,
  coalesce,
  Condition,
  createCustomType,
  DatabaseClient,
  DbColumn,
  DbContext,
  DbCteBuilder,
  DbEntity,
  DbEntityTable,
  DbModelConfig,
  EntityQuery,
  eq,
  eqAny,
  exists,
  gte,
  inArray,
  inArrayOpt,
  integer,
  jsonb,
  jsonbHasAllKeys,
  jsonbHasAnyKey,
  jsonbPathText,
  LinkgressConfig,
  lt,
  MutationBatch,
  neAll,
  not,
  notInArray,
  notInArrayOpt,
  or,
  param,
  QueryBatch,
  text,
  varchar,
} from '../../src';
import { auditStatementParams, ParamAuditFinding } from '../utils/param-audit';
import { createFreshClient } from '../utils/test-database';

/**
 * A membership condition over an EMPTY list (or a non-array the operator tolerates) is a constant —
 * `x IN ()` is FALSE for every row, NULL `x` included, and `x NOT IN ()` TRUE — and must bind nothing
 * for its operand: the operand never reaches the statement text. A builder that rendered the operand
 * first and only then returned the constant left the operand's bound parameters in the statement's
 * list with no `$N` referencing them. A plain column binds nothing, so only an operand carrying
 * parameters (`coalesce(jsonbPathText(col, param(k)), '')`, a fragment with values) showed it:
 * PostgreSQL refused the statement (`could not determine data type of parameter $N`), and a batch that
 * spliced it into a bigger statement moved the orphan into the middle of the combined list.
 *
 * Every case is generated: builder × context × operand shape × list × pad ladder. Each one asserts
 * (a) no orphan parameter — every bound parameter of every statement the case sent is referenced by a
 * `$N` and every `$N` has a parameter; (b) the statements run; (c) the rows equal what an oracle
 * computes in JS from the seeded data with SQL's three-valued semantics (an empty list: no rows for
 * IN / all rows for NOT IN; a non-empty one: exactly the members). UPDATE / DELETE join a navigation
 * their condition reads as an inner join (`FROM` / `USING`), so their oracle only reaches rows whose
 * navigation exists — whether or not the condition renders the operand: an empty list must not drop
 * the join the operand registered.
 */

// ---------------------------------------------------------------------------
// schema: regions <- makers <- widgets
// ---------------------------------------------------------------------------

interface MxAttributes {
  tier?: string;
  spec?: string;
  [key: string]: unknown;
}

class MxRegion extends DbEntity {
  id!: DbColumn<number>;
  name?: DbColumn<string | null>;
  tags?: DbColumn<string[] | null>;
  attributes?: DbColumn<MxAttributes | null>;
}

class MxMaker extends DbEntity {
  id!: DbColumn<number>;
  name?: DbColumn<string | null>;
  regionId?: DbColumn<number | null>;
  tags?: DbColumn<string[] | null>;
  attributes?: DbColumn<MxAttributes | null>;

  region?: MxRegion;
  widgets?: MxWidget[];
}

class MxWidget extends DbEntity {
  id!: DbColumn<number>;
  code?: DbColumn<string | null>;
  grade?: DbColumn<string | null>;
  tags?: DbColumn<string[] | null>;
  attributes?: DbColumn<MxAttributes | null>;
  makerId?: DbColumn<number | null>;
  revision!: DbColumn<number>;

  maker?: MxMaker;
}

/** Stored upper-case, read lower-case: a list's values must go through `toDriver` to match. */
const upperCaseGrade = createCustomType<{ data: string; driverData: string }>({
  dataType: () => 'varchar',
  toDriver: (value: string | null | undefined) => (value == null ? null : value.toUpperCase()),
  fromDriver: (value: string | null | undefined) => (value == null ? null : value.toLowerCase()),
});

class MembershipDatabase extends DbContext {
  get regions(): DbEntityTable<MxRegion> {
    return this.table(MxRegion);
  }

  get makers(): DbEntityTable<MxMaker> {
    return this.table(MxMaker);
  }

  get widgets(): DbEntityTable<MxWidget> {
    return this.table(MxWidget);
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(MxRegion, entity => {
      entity.toTable('mx_regions');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mx_regions_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 32));
      entity.property(e => e.tags).hasType(text('tags').array());
      entity.property(e => e.attributes).hasType(jsonb('attributes'));
    });

    model.entity(MxMaker, entity => {
      entity.toTable('mx_makers');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mx_makers_id_seq' }));
      entity.property(e => e.name).hasType(varchar('name', 32));
      entity.property(e => e.regionId).hasType(integer('region_id'));
      entity.property(e => e.tags).hasType(text('tags').array());
      entity.property(e => e.attributes).hasType(jsonb('attributes'));

      entity.hasOne(e => e.region, () => MxRegion)
        .withForeignKey(m => m.regionId!)
        .withPrincipalKey(r => r.id);

      entity.hasMany(e => e.widgets, () => MxWidget)
        .withForeignKey(w => w.makerId!)
        .withPrincipalKey(m => m.id);
    });

    model.entity(MxWidget, entity => {
      entity.toTable('mx_widgets');
      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'mx_widgets_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 16));
      entity.property(e => e.grade).hasType(varchar('grade', 16)).hasCustomMapper(upperCaseGrade);
      entity.property(e => e.tags).hasType(text('tags').array());
      entity.property(e => e.attributes).hasType(jsonb('attributes'));
      entity.property(e => e.makerId).hasType(integer('maker_id'));
      entity.property(e => e.revision).hasType(integer('revision')).isRequired();

      entity.hasOne(e => e.maker, () => MxMaker)
        .withForeignKey(w => w.makerId!)
        .withPrincipalKey(m => m.id);
    });
  }
}

const TABLES = ['mx_widgets', 'mx_makers', 'mx_regions'];

// ---------------------------------------------------------------------------
// seed, and the same data as a JS model the oracle reads
// ---------------------------------------------------------------------------

interface RegionModel {
  id: number;
  name: string | null;
  tags: string[] | null;
  attributes: MxAttributes | null;
}

interface MakerModel extends RegionModel {
  region: RegionModel | null;
}

interface WidgetModel {
  id: number;
  code: string | null;
  grade: string | null;
  tags: string[] | null;
  attributes: MxAttributes | null;
  maker: MakerModel | null;
}

interface SeedModel {
  widgets: WidgetModel[];
  makers: MakerModel[];
}

const REGION_SEED: Array<Omit<RegionModel, 'id'>> = [
  { name: 'north', tags: ['cold', 'coast'], attributes: { tier: 'gold' } },
  { name: null, tags: null, attributes: null },
  { name: 'south', tags: [], attributes: { tier: 'silver' } },
];

/** `region`: index into REGION_SEED. The last maker has no widgets. */
const MAKER_SEED: Array<Omit<RegionModel, 'id'> & { region: number | null }> = [
  { name: 'acme', tags: ['steel'], attributes: { tier: 'gold' }, region: 0 },
  { name: null, tags: null, attributes: { spec: 'y' }, region: 1 },
  { name: 'bolt', tags: ['steel', 'wood'], attributes: null, region: 2 },
  { name: 'crux', tags: [], attributes: { tier: 'bronze' }, region: null },
  { name: 'dyna', tags: ['wood'], attributes: { tier: 'silver' }, region: 0 },
];

/** `maker`: index into MAKER_SEED. NULLs in every column, a widget without a maker, one whose maker has no region. */
const WIDGET_SEED: Array<Omit<WidgetModel, 'id' | 'maker'> & { maker: number | null }> = [
  { code: 'a1', grade: 'gold', tags: ['red', 'blue'], attributes: { tier: 'gold' }, maker: 0 },
  { code: 'b2', grade: 'silver', tags: ['red'], attributes: { tier: 'silver' }, maker: 0 },
  { code: null, grade: null, tags: null, attributes: null, maker: 1 },
  { code: 'c3', grade: 'bronze', tags: [], attributes: { spec: 'q' }, maker: 2 },
  { code: 'a1', grade: 'gold', tags: ['green'], attributes: { tier: 'gold' }, maker: null },
  { code: 'd4', grade: 'silver', tags: ['blue', 'green'], attributes: { tier: 'bronze' }, maker: 3 },
  { code: 'e5', grade: null, tags: ['red', 'green'], attributes: { tier: 'silver', spec: 'r' }, maker: 2 },
];

async function dropTables(client: DatabaseClient): Promise<void> {
  for (const table of TABLES) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}

async function seed(db: MembershipDatabase): Promise<SeedModel> {
  const regionRows = await db.regions.insertBulk(REGION_SEED.map(r => ({ ...r }))).returning();
  const regions: RegionModel[] = REGION_SEED.map((r, i) => ({ ...r, id: regionRows[i].id }));

  const makerRows = await db.makers.insertBulk(MAKER_SEED.map(({ region, ...m }) => ({
    ...m,
    regionId: region === null ? null : regions[region].id,
  }))).returning();
  const makers: MakerModel[] = MAKER_SEED.map(({ region, ...m }, i) => ({
    ...m,
    id: makerRows[i].id,
    region: region === null ? null : regions[region],
  }));

  const widgetRows = await db.widgets.insertBulk(WIDGET_SEED.map(({ maker, ...w }) => ({
    ...w,
    makerId: maker === null ? null : makers[maker].id,
    revision: 0,
  }))).returning();
  const widgets: WidgetModel[] = WIDGET_SEED.map(({ maker, ...w }, i) => ({
    ...w,
    id: widgetRows[i].id,
    maker: maker === null ? null : makers[maker],
  }));

  return { widgets, makers };
}

// ---------------------------------------------------------------------------
// the matrix: operand shapes, builders, lists, ladders, contexts
// ---------------------------------------------------------------------------

type WidgetRow = EntityQuery<MxWidget>;
type Truth = boolean | null;
type Group = 'scalar' | 'array' | 'jsonKeys';

interface ShapeSpec {
  name: string;
  /** A column with a custom type mapper: the list's values bind through its `toDriver`. */
  mapped?: true;
  /** The operand over a widget row. */
  operand(w: WidgetRow): unknown;
  /** The operand's value for a seeded widget, as SQL computes it (null: SQL NULL). */
  valueOf(w: WidgetModel): unknown;
  /** Whether the joins the operand's navigation registers find a row — UPDATE / DELETE join them as inner joins. */
  reaches(w: WidgetModel): boolean;
  /** Two values (elements, keys) the data holds; the lists are built from them and from {@link filler}s. */
  present: readonly [unknown, unknown];
  filler(index: number): unknown;
}

const always = (): boolean => true;
const hasMaker = (w: WidgetModel): boolean => w.maker !== null;
const hasRegion = (w: WidgetModel): boolean => w.maker?.region != null;

const SCALAR_SHAPES: ShapeSpec[] = [
  {
    name: 'column',
    operand: w => w.code,
    valueOf: w => w.code,
    reaches: always,
    present: ['a1', 'b2'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'navigation, 1 hop',
    operand: w => w.maker!.name,
    valueOf: w => w.maker?.name ?? null,
    reaches: hasMaker,
    present: ['acme', 'bolt'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'navigation, 2 hops',
    operand: w => w.maker!.region!.name,
    valueOf: w => w.maker?.region?.name ?? null,
    reaches: hasRegion,
    present: ['north', 'south'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'expression, 1 bound param',
    operand: w => jsonbPathText(w.attributes, param('tier', 'text')),
    valueOf: w => w.attributes?.tier ?? null,
    reaches: always,
    present: ['gold', 'silver'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'expression, 2 bound params',
    operand: w => coalesce(jsonbPathText(w.attributes, param('tier', 'text')), ''),
    valueOf: w => w.attributes?.tier ?? '',
    reaches: always,
    present: ['gold', ''],
    filler: i => `zz-${i}`,
  },
  {
    name: 'navigation expression (2 hops), 2 bound params',
    operand: w => coalesce(jsonbPathText(w.maker!.region!.attributes, param('tier', 'text')), ''),
    valueOf: w => w.maker?.region?.attributes?.tier ?? '',
    reaches: hasRegion,
    present: ['gold', ''],
    filler: i => `zz-${i}`,
  },
  {
    name: 'column with a toDriver mapper',
    mapped: true,
    operand: w => w.grade,
    valueOf: w => w.grade,
    reaches: always,
    present: ['gold', 'silver'],
    filler: i => `zz-${i}`,
  },
];

const ARRAY_SHAPES: ShapeSpec[] = [
  {
    name: 'array column',
    operand: w => w.tags,
    valueOf: w => w.tags,
    reaches: always,
    present: ['red', 'blue'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'array navigation, 1 hop',
    operand: w => w.maker!.tags,
    valueOf: w => w.maker?.tags ?? null,
    reaches: hasMaker,
    present: ['steel', 'wood'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'array navigation, 2 hops',
    operand: w => w.maker!.region!.tags,
    valueOf: w => w.maker?.region?.tags ?? null,
    reaches: hasRegion,
    present: ['cold', 'coast'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'array expression, 1 bound param',
    operand: w => coalesce(w.tags, param(['none'], 'text[]')),
    valueOf: w => w.tags ?? ['none'],
    reaches: always,
    present: ['red', 'none'],
    filler: i => `zz-${i}`,
  },
  {
    name: 'array navigation expression, 2 bound params',
    operand: w => coalesce(w.maker!.tags, param(['none'], 'text[]'), param(['never'], 'text[]')),
    valueOf: w => w.maker?.tags ?? ['none'],
    reaches: hasMaker,
    present: ['steel', 'none'],
    filler: i => `zz-${i}`,
  },
];

const JSON_SHAPES: ShapeSpec[] = [
  {
    name: 'jsonb column',
    operand: w => w.attributes,
    valueOf: w => w.attributes,
    reaches: always,
    present: ['tier', 'spec'],
    filler: i => `k-${i}`,
  },
  {
    name: 'jsonb navigation, 1 hop',
    operand: w => w.maker!.attributes,
    valueOf: w => w.maker?.attributes ?? null,
    reaches: hasMaker,
    present: ['tier', 'spec'],
    filler: i => `k-${i}`,
  },
  {
    name: 'jsonb navigation, 2 hops',
    operand: w => w.maker!.region!.attributes,
    valueOf: w => w.maker?.region?.attributes ?? null,
    reaches: hasRegion,
    present: ['tier', 'spec'],
    filler: i => `k-${i}`,
  },
  {
    name: 'jsonb expression, 1 bound param',
    operand: w => coalesce(w.attributes, castAsJsonb({ fallback: true })),
    valueOf: w => w.attributes ?? { fallback: true },
    reaches: always,
    present: ['tier', 'fallback'],
    filler: i => `k-${i}`,
  },
  {
    name: 'jsonb navigation expression, 2 bound params',
    operand: w => coalesce(w.maker!.attributes, castAsJsonb({ fallback: true }), castAsJsonb({ never: true })),
    valueOf: w => w.maker?.attributes ?? { fallback: true },
    reaches: hasMaker,
    present: ['tier', 'fallback'],
    filler: i => `k-${i}`,
  },
];

const SHAPES: Record<Group, ShapeSpec[]> = { scalar: SCALAR_SHAPES, array: ARRAY_SHAPES, jsonKeys: JSON_SHAPES };

interface BuilderSpec {
  name: string;
  group: Group;
  /** Accepts a non-array value (rendering the empty list's constant) instead of throwing. */
  toleratesNonArray: boolean;
  /** Routes through the `inArrayOpt` rendering (`LinkgressConfig.inArrayUsesOpt`) while the case runs. */
  usesOpt?: boolean;
  build(operand: unknown, values: unknown): Condition;
  /** What SQL makes of the condition for an operand value (three-valued; `values` undefined: a non-array). */
  holds(value: unknown, values: readonly unknown[] | undefined): Truth;
}

/** `x IN (…)`: FALSE for an empty list whatever `x` is; NULL `x` otherwise NULL (the lists hold no NULL). */
const isMember = (value: unknown, values: readonly unknown[] | undefined): Truth => {
  if (values === undefined || values.length === 0) {
    return false;
  }

  return value === null ? null : values.includes(value);
};

/** `x NOT IN (…)`: TRUE for an empty list whatever `x` is. */
const isNotMember = (value: unknown, values: readonly unknown[] | undefined): Truth => {
  const member = isMember(value, values);

  if (values === undefined || values.length === 0) {
    return true;
  }

  return member === null ? null : !member;
};

const asArray = (value: unknown): readonly unknown[] => value as readonly unknown[];
const asObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const BUILDERS: BuilderSpec[] = [
  {
    name: 'inArray',
    group: 'scalar',
    toleratesNonArray: true,
    build: (operand, values) => inArray(operand as Parameters<typeof inArray>[0], values as unknown[]),
    holds: isMember,
  },
  {
    name: 'notInArray',
    group: 'scalar',
    toleratesNonArray: true,
    build: (operand, values) => notInArray(operand as Parameters<typeof notInArray>[0], values as unknown[]),
    holds: isNotMember,
  },
  {
    name: 'inArray (inArrayUsesOpt)',
    group: 'scalar',
    toleratesNonArray: true,
    usesOpt: true,
    build: (operand, values) => inArray(operand as Parameters<typeof inArray>[0], values as unknown[]),
    holds: isMember,
  },
  {
    name: 'notInArray (inArrayUsesOpt)',
    group: 'scalar',
    toleratesNonArray: true,
    usesOpt: true,
    build: (operand, values) => notInArray(operand as Parameters<typeof notInArray>[0], values as unknown[]),
    holds: isNotMember,
  },
  {
    name: 'inArrayOpt',
    group: 'scalar',
    toleratesNonArray: true,
    build: (operand, values) => inArrayOpt(operand as Parameters<typeof inArrayOpt>[0], values as readonly unknown[]),
    holds: isMember,
  },
  {
    name: 'notInArrayOpt',
    group: 'scalar',
    toleratesNonArray: true,
    build: (operand, values) => notInArrayOpt(operand as Parameters<typeof notInArrayOpt>[0], values as readonly unknown[]),
    holds: isNotMember,
  },
  {
    name: 'eqAny',
    group: 'scalar',
    toleratesNonArray: false,
    build: (operand, values) => eqAny(operand as Parameters<typeof eqAny>[0], values as readonly unknown[]),
    holds: isMember,
  },
  {
    name: 'neAll',
    group: 'scalar',
    toleratesNonArray: false,
    build: (operand, values) => neAll(operand as Parameters<typeof neAll>[0], values as readonly unknown[]),
    holds: isNotMember,
  },
  {
    name: 'arrayOverlaps',
    group: 'array',
    toleratesNonArray: false,
    build: (operand, values) => arrayOverlaps(operand as Parameters<typeof arrayOverlaps>[0], values as readonly unknown[]),
    holds: (value, values) => (value === null ? null : (values ?? []).some(e => asArray(value).includes(e))),
  },
  {
    name: 'arrayContainsAll',
    group: 'array',
    toleratesNonArray: false,
    build: (operand, values) => arrayContainsAll(operand as Parameters<typeof arrayContainsAll>[0], values as readonly unknown[]),
    holds: (value, values) => (value === null ? null : (values ?? []).every(e => asArray(value).includes(e))),
  },
  {
    name: 'arrayContainedBy',
    group: 'array',
    toleratesNonArray: false,
    build: (operand, values) => arrayContainedBy(operand as Parameters<typeof arrayContainedBy>[0], values as readonly unknown[]),
    holds: (value, values) => (value === null ? null : asArray(value).every(e => (values ?? []).includes(e))),
  },
  {
    name: 'jsonbHasAnyKey',
    group: 'jsonKeys',
    toleratesNonArray: false,
    build: (operand, values) => jsonbHasAnyKey(operand as Parameters<typeof jsonbHasAnyKey>[0], values as readonly string[]),
    holds: (value, values) => (value === null ? null : (values ?? []).some(k => Object.prototype.hasOwnProperty.call(asObject(value), k as string))),
  },
  {
    name: 'jsonbHasAllKeys',
    group: 'jsonKeys',
    toleratesNonArray: false,
    build: (operand, values) => jsonbHasAllKeys(operand as Parameters<typeof jsonbHasAllKeys>[0], values as readonly string[]),
    holds: (value, values) => (value === null ? null : (values ?? []).every(k => Object.prototype.hasOwnProperty.call(asObject(value), k as string))),
  },
];

const THRESHOLD = LinkgressConfig.DEFAULT_IN_ARRAY_OPT_THRESHOLD;

interface ListSpec {
  label: string;
  /** undefined: the non-array value */
  size?: number;
}

const LISTS: ListSpec[] = [
  { label: 'empty list', size: 0 },
  { label: 'non-array (undefined)' },
  { label: '1 element', size: 1 },
  { label: '2 elements', size: 2 },
  { label: `the inArrayOpt threshold (${THRESHOLD})`, size: THRESHOLD },
  { label: `threshold + 1 (${THRESHOLD + 1}: the = ANY form)`, size: THRESHOLD + 1 },
];

/** The list of `size` values for `shape`: its two present values first, then fillers matching nothing. */
function listValues(shape: ShapeSpec, size: number | undefined): unknown[] | undefined {
  if (size === undefined) {
    return undefined;
  }

  return Array.from({ length: size }, (_, i) => (i < shape.present.length ? shape.present[i] : shape.filler(i)));
}

interface LadderSpec {
  label: string;
  buckets: readonly number[] | null;
}

const LADDERS: LadderSpec[] = [
  { label: 'no pad ladder', buckets: null },
  { label: `pad ladder [${LinkgressConfig.DEFAULT_IN_ARRAY_PAD_BUCKETS.join(', ')}]`, buckets: LinkgressConfig.DEFAULT_IN_ARRAY_PAD_BUCKETS },
];

/** The ladder only changes the rendering of the scalar builders; the array / JSON builders run without one. */
const laddersFor = (builder: BuilderSpec): LadderSpec[] => (builder.group === 'scalar' ? LADDERS : [LADDERS[0]]);

type Cond = (w: WidgetRow) => Condition;
type Observed = unknown;

interface OracleInput {
  model: SeedModel;
  /** The condition's truth for a widget. */
  truth(w: WidgetModel): Truth;
  /** Whether an UPDATE / DELETE reaches the widget (the operand's navigation joined as an inner join). */
  reaches(w: WidgetModel): boolean;
}

interface ContextSpec {
  name: string;
  /**
   * The condition is written over the items of a collection navigation, whose column refs carry no
   * custom mapper: values compared with a mapped column bind WITHOUT its `toDriver` there — a separate,
   * pre-existing gap of collection items, not of the membership builders. For a mapped operand the rows
   * are therefore not checked against the oracle (which maps the values); the statement is still checked
   * for orphan parameters and must run.
   */
  itemColumnsUnmapped?: true;
  /** The condition is written over a column row (a bulk update's `t`): navigations are not in scope there. */
  ownColumnsOnly?: true;
  run(db: MembershipDatabase, cond: Cond, model: SeedModel): Promise<Observed>;
  expected(input: OracleInput): Observed;
}

/** A shape that reads only the widget's own columns (its joins never miss a row). */
const readsOwnColumns = (shape: ShapeSpec): boolean => shape.reaches === always;

const sortedIds = (rows: Array<{ id: number }>): number[] => rows.map(r => r.id).sort((a, b) => a - b);
const idsWhere = (widgets: WidgetModel[], keep: (w: WidgetModel) => boolean): number[] => widgets.filter(keep).map(w => w.id).sort((a, b) => a - b);

/** The makers with at least one widget the condition holds for. */
const makersWithMatch = ({ model, truth }: OracleInput): number[] =>
  model.makers.filter(m => model.widgets.some(w => w.maker?.id === m.id && truth(w) === true)).map(m => m.id).sort((a, b) => a - b);

class RolledBack extends Error {
  constructor(readonly value: unknown) {
    super('rolled back on purpose');
  }
}

/** Runs `work` in a transaction that is always rolled back, and returns what it produced. */
async function rolledBack(db: MembershipDatabase, work: (tx: MembershipDatabase) => Promise<unknown>): Promise<unknown> {
  try {
    await db.transaction(async tx => {
      throw new RolledBack(await work(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.value;
    }

    throw error;
  }

  throw new Error('the transaction was expected to roll back');
}

const CONTEXTS: ContextSpec[] = [
  {
    name: 'where',
    run: async (db, cond) => sortedIds(await db.widgets.where(w => cond(w)).select(w => ({ id: w.id })).toList()),
    expected: ({ model, truth }) => idsWhere(model.widgets, w => truth(w) === true),
  },
  {
    name: 'where, the navigation it may read also projected',
    run: async (db, cond) => (await db.widgets
      .where(w => cond(w))
      .select(w => ({ id: w.id, maker: w.maker!.name, region: w.maker!.region!.name }))
      .toList())
      .map(r => ({ id: r.id, maker: r.maker ?? null, region: r.region ?? null }))
      .sort((a, b) => a.id - b.id),
    expected: ({ model, truth }) => model.widgets
      .filter(w => truth(w) === true)
      .map(w => ({ id: w.id, maker: w.maker?.name ?? null, region: w.maker?.region?.name ?? null }))
      .sort((a, b) => a.id - b.id),
  },
  {
    name: 'and(…, a bound comparison after it)',
    run: async (db, cond) => sortedIds(await db.widgets.where(w => and(cond(w), gte(w.id, 0))).select(w => ({ id: w.id })).toList()),
    expected: ({ model, truth }) => idsWhere(model.widgets, w => truth(w) === true),
  },
  {
    name: 'or(…, a bound comparison after it)',
    run: async (db, cond) => sortedIds(await db.widgets.where(w => or(cond(w), lt(w.id, 0))).select(w => ({ id: w.id })).toList()),
    expected: ({ model, truth }) => idsWhere(model.widgets, w => truth(w) === true),
  },
  {
    name: 'not(…)',
    run: async (db, cond) => sortedIds(await db.widgets.where(w => not(cond(w))).select(w => ({ id: w.id })).toList()),
    expected: ({ model, truth }) => idsWhere(model.widgets, w => truth(w) === false),
  },
  {
    name: 'correlated exists() over a collection navigation',
    itemColumnsUnmapped: true,
    run: async (db, cond) => sortedIds(await db.makers
      .where(m => and(gte(m.id, 0), exists(m.widgets!.where(w => cond(w)))))
      .select(m => ({ id: m.id }))
      .toList()),
    expected: makersWithMatch,
  },
  {
    name: 'correlated exists() over a subquery',
    run: async (db, cond) => sortedIds(await db.makers
      .where(m => and(gte(m.id, 0), exists(db.widgets.where(w => and(eq(w.makerId, m.id), cond(w))).select(w => ({ id: w.id })).asSubquery())))
      .select(m => ({ id: m.id }))
      .toList()),
    expected: makersWithMatch,
  },
  {
    name: 'CTE body (DbCteBuilder.with)',
    run: async (db, cond) => {
      const { cte } = new DbCteBuilder().with('mx_picked', db.widgets.where(w => cond(w)).select(w => ({ wid: w.id })));

      return sortedIds(await db.selectFromCte(cte).where(r => gte(r.wid, 0)).select(r => ({ id: r.wid })).toList());
    },
    expected: ({ model, truth }) => idsWhere(model.widgets, w => truth(w) === true),
  },
  {
    name: 'boolean in a select projection',
    run: async (db, cond) => {
      const rows = await db.widgets.where(w => gte(w.id, 0)).select(w => ({ id: w.id, hit: cond(w) })).toList();

      return rows
        .map(r => ({ id: r.id, hit: (r.hit as Truth | undefined) ?? null }))
        .sort((a, b) => a.id - b.id);
    },
    expected: ({ model, truth }) => model.widgets.map(w => ({ id: w.id, hit: truth(w) })).sort((a, b) => a.id - b.id),
  },
  {
    name: 'QueryBatch (one round trip, between two bound branches)',
    run: async (db, cond) => {
      const batch = new QueryBatch();
      const before = batch.addCount(db.widgets.where(w => gte(w.id, 0)), 'before');
      const hits = batch.addList(db.widgets.where(w => cond(w)).select(w => ({ id: w.id })), 'hits');
      const after = batch.addCount(db.makers.where(m => gte(m.id, 0)), 'after');
      await batch.executeBatch();

      return { before: batch.getCount(before), ids: sortedIds(batch.getList(hits)), after: batch.getCount(after) };
    },
    expected: ({ model, truth }) => ({
      before: model.widgets.length,
      ids: idsWhere(model.widgets, w => truth(w) === true),
      after: model.makers.length,
    }),
  },
  {
    name: 'MutationBatch (one fused statement): a bulk-update leg\'s where, between two bound legs',
    ownColumnsOnly: true,
    run: async (db, cond, model) => {
      const batch = new MutationBatch();
      const before = batch.addUpdateWhereIn(db.makers, 'id', [-1], { name: 'none' }, 'before');
      const hits = batch.addBulkUpdate(db.widgets, model.widgets.map(w => ({ id: w.id, revision: 0 })), 'hits', {
        primaryKey: 'id',
        where: target => cond(target as WidgetRow),
      });
      const after = batch.addDeleteWhereIn(db.regions, 'id', [-1], 'after');
      await batch.executeBatch();

      return { before: batch.getAffectedCount(before!), hits: batch.getAffectedCount(hits!), after: batch.getAffectedCount(after!) };
    },
    expected: ({ model, truth }) => ({ before: 0, hits: model.widgets.filter(w => truth(w) === true).length, after: 0 }),
  },
  {
    name: 'update().where()',
    run: async (db, cond) => sortedIds(await db.widgets
      .where(w => cond(w))
      .update(w => ({ revision: add(w.revision, 1) }))
      .returning(w => ({ id: w.id }))),
    expected: ({ model, truth, reaches }) => idsWhere(model.widgets, w => reaches(w) && truth(w) === true),
  },
  {
    name: 'delete().where() (rolled back)',
    run: async (db, cond) => rolledBack(db, async tx => sortedIds(await tx.widgets
      .where(w => cond(w))
      .delete()
      .returning(w => ({ id: w.id })))),
    expected: ({ model, truth, reaches }) => idsWhere(model.widgets, w => reaches(w) && truth(w) === true),
  },
];

// ---------------------------------------------------------------------------
// statement capture
// ---------------------------------------------------------------------------

interface CapturedStatement {
  sql: string;
  params: readonly unknown[] | undefined;
}

type QueryFn = (sql: string, params?: any[], options?: any) => Promise<any>;

/** Records every statement the client sends — on its own, and through a transaction's query function. */
function captureStatements(client: DatabaseClient, into: CapturedStatement[]): void {
  const target = client as unknown as { query: QueryFn; transaction: (callback: (query: QueryFn) => Promise<unknown>) => Promise<unknown> };
  const query = target.query.bind(client);
  const transaction = target.transaction.bind(client);
  const recording = (send: QueryFn): QueryFn => (sql, params, options) => {
    into.push({ sql, params: params === undefined ? undefined : [...params] });

    return send(sql, params, options);
  };

  target.query = recording(query);
  target.transaction = callback => transaction(transactionQuery => callback(recording(transactionQuery)));
}

interface StatementFinding extends ParamAuditFinding {
  bound: number;
  sql: string;
}

const statementFindings = (statements: readonly CapturedStatement[]): StatementFinding[] =>
  statements.flatMap(statement => {
    const finding = auditStatementParams(statement.sql, statement.params);

    return finding === undefined ? [] : [{ ...finding, bound: statement.params?.length ?? 0, sql: statement.sql }];
  });

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

describe('membership over an empty list binds nothing for its operand', () => {
  let client: DatabaseClient;
  let db: MembershipDatabase;
  let model: SeedModel;
  const statements: CapturedStatement[] = [];

  beforeAll(async () => {
    client = createFreshClient();
    db = new MembershipDatabase(client, { logQueries: false });
    await dropTables(client);
    await db.getSchemaManager().ensureCreated();
    model = await seed(db);
    captureStatements(client, statements);
  });

  afterAll(async () => {
    LinkgressConfig.resetToDefaults();
    await dropTables(client);
    await db.dispose();
  });

  for (const builder of BUILDERS) {
    describe(builder.name, () => {
      for (const context of CONTEXTS) {
        describe(context.name, () => {
          for (const shape of SHAPES[builder.group]) {
            if (context.ownColumnsOnly && !readsOwnColumns(shape)) {
              continue;
            }

            for (const list of LISTS) {
              if (list.size === undefined && !builder.toleratesNonArray) {
                continue;
              }

              for (const ladder of laddersFor(builder)) {
                test(`${shape.name} | ${list.label} | ${ladder.label}`, async () => {
                  const values = listValues(shape, list.size);
                  const cond: Cond = w => builder.build(shape.operand(w), values);
                  let observed: Observed;
                  let failure: string | null = null;

                  statements.length = 0;
                  LinkgressConfig.inArrayPadBuckets = ladder.buckets;
                  LinkgressConfig.inArrayUsesOpt = builder.usesOpt === true;

                  try {
                    observed = await context.run(db, cond, model);
                  } catch (error) {
                    failure = error instanceof Error ? error.message : String(error);
                  } finally {
                    LinkgressConfig.resetToDefaults();
                  }

                  // (a) no orphan parameter in any statement the case sent, and (b) they ran
                  expect({ orphans: statementFindings(statements), failure }).toEqual({ orphans: [], failure: null });
                  expect(statements.length).toBeGreaterThan(0);

                  // (c) the rows SQL's own semantics give (see ContextSpec.itemColumnsUnmapped for the one gap)
                  if (!(context.itemColumnsUnmapped && shape.mapped)) {
                    expect(observed).toEqual(context.expected({
                      model,
                      truth: w => builder.holds(shape.valueOf(w), values),
                      reaches: shape.reaches,
                    }));
                  }
                });
              }
            }
          }
        });
      }
    });
  }
});
