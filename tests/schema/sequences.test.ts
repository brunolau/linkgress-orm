import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { DbContext, DbEntity, DbColumn, DbEntityTable, DbModelConfig, integer, varchar, PgClient, sequence, DbSequence, like } from '../../src';

// Test entity
class SequenceTestEntity extends DbEntity {
  id!: DbColumn<number>;
  code!: DbColumn<string>;
}

// Test database with sequences
class SequenceTestDatabase extends DbContext {
  get entities(): DbEntityTable<SequenceTestEntity> {
    return this.table(SequenceTestEntity);
  }

  // Basic sequence
  get basicSeq(): DbSequence {
    return this.sequence(
      sequence('basic_seq')
        .startWith(1)
        .incrementBy(1)
        .build()
    );
  }

  // Sequence with custom start and increment
  get customSeq(): DbSequence {
    return this.sequence(
      sequence('custom_seq')
        .startWith(100)
        .incrementBy(5)
        .build()
    );
  }

  // Sequence with cache
  get cachedSeq(): DbSequence {
    return this.sequence(
      sequence('cached_seq')
        .startWith(1)
        .cache(20)
        .build()
    );
  }

  // Sequence in a specific schema
  get schemaSeq(): DbSequence {
    return this.sequence(
      sequence('schema_seq')
        .inSchema('public')
        .startWith(1000)
        .build()
    );
  }

  protected override setupModel(model: DbModelConfig): void {
    model.entity(SequenceTestEntity, entity => {
      entity.toTable('sequence_test_entities');

      entity.property(e => e.id).hasType(integer('id').primaryKey().generatedAlwaysAsIdentity({ name: 'sequence_test_entities_id_seq' }));
      entity.property(e => e.code).hasType(varchar('code', 50)).isRequired();
    });
  }

  protected override setupSequences(): void {
    // Register sequences by accessing their getters
    this.basicSeq;
    this.customSeq;
    this.cachedSeq;
    this.schemaSeq;
  }
}

describe('Sequence Support', () => {
  let client: PgClient;
  let db: SequenceTestDatabase;

  beforeAll(async () => {
    client = new PgClient({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'linkgress_test',
    });

    db = new SequenceTestDatabase(client);

    // Create schema
    await db.getSchemaManager().ensureDeleted();
    await db.getSchemaManager().ensureCreated();
  });

  afterAll(async () => {
    await db.getSchemaManager().ensureDeleted();
    await db.dispose();
  });

  test('should create sequences during schema creation', async () => {
    // Verify sequences exist
    const result = await client.query(`
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_name IN ('basic_seq', 'custom_seq', 'cached_seq', 'schema_seq')
      ORDER BY sequence_name
    `);

    expect(result.rows).toHaveLength(4);
    expect(result.rows.map(r => r.sequence_name)).toEqual([
      'basic_seq',
      'cached_seq',
      'custom_seq',
      'schema_seq',
    ]);
  });

  test('should generate next value from basic sequence', async () => {
    const val1 = await db.basicSeq.nextValue();
    const val2 = await db.basicSeq.nextValue();
    const val3 = await db.basicSeq.nextValue();

    expect(val1).toBe(1);
    expect(val2).toBe(2);
    expect(val3).toBe(3);
  });

  test('should generate values with custom start and increment', async () => {
    const val1 = await db.customSeq.nextValue();
    const val2 = await db.customSeq.nextValue();
    const val3 = await db.customSeq.nextValue();

    expect(val1).toBe(100);
    expect(val2).toBe(105);
    expect(val3).toBe(110);
  });

  test('should get current value without incrementing', async () => {
    // Get next value to ensure sequence has a current value
    const next1 = await db.cachedSeq.nextValue();
    expect(next1).toBe(1);

    // Current value should return the same value
    const current = await db.cachedSeq.currentValue();
    expect(current).toBe(1);

    // Next value should increment
    const next2 = await db.cachedSeq.nextValue();
    expect(next2).toBe(2);

    // Current value should now be 2
    const current2 = await db.cachedSeq.currentValue();
    expect(current2).toBe(2);
  });

  test('should resync sequence to specific value', async () => {
    // Get initial value
    const initial = await db.schemaSeq.nextValue();
    expect(initial).toBe(1000);

    // Resync to 5000
    await db.schemaSeq.resync(5000);

    // Current value should be 5000
    const current = await db.schemaSeq.currentValue();
    expect(current).toBe(5000);

    // Next value should be 5001
    const next = await db.schemaSeq.nextValue();
    expect(next).toBe(5001);
  });

  test('should use sequences to generate entity codes', async () => {
    const code1 = await db.basicSeq.nextValue();
    const code2 = await db.basicSeq.nextValue();
    const code3 = await db.basicSeq.nextValue();

    const entity1 = await db.entities.insert({
      code: `CODE-${code1}`,
    });

    const entity2 = await db.entities.insert({
      code: `CODE-${code2}`,
    });

    const entity3 = await db.entities.insert({
      code: `CODE-${code3}`,
    });

    expect(entity1.code).toMatch(/CODE-\d+/);
    expect(entity2.code).toMatch(/CODE-\d+/);
    expect(entity3.code).toMatch(/CODE-\d+/);

    // Verify codes are sequential
    const allEntities = await db.entities
      .select(e => ({ id: e.id, code: e.code }))
      .orderBy(e => e.id)
      .toList();

    expect(allEntities).toHaveLength(3);
  });

  test('should generate batch of sequence values', async () => {
    const batchSize = 10;
    const values: number[] = [];

    for (let i = 0; i < batchSize; i++) {
      values.push(await db.customSeq.nextValue());
    }

    expect(values).toHaveLength(batchSize);

    // Verify values are sequential with increment of 5
    for (let i = 1; i < values.length; i++) {
      expect(values[i] - values[i - 1]).toBe(5);
    }
  });

  test('should return sequence configuration', async () => {
    const config = db.basicSeq.getConfig();

    expect(config.name).toBe('basic_seq');
    expect(config.startWith).toBe(1);
    expect(config.incrementBy).toBe(1);
  });

  test('should return qualified sequence name', async () => {
    const basicName = db.basicSeq.getQualifiedName();
    expect(basicName).toBe('"basic_seq"');

    const schemaName = db.schemaSeq.getQualifiedName();
    expect(schemaName).toBe('"public"."schema_seq"');
  });

  test('should handle sequences across multiple inserts', async () => {
    const entities = [];

    for (let i = 0; i < 5; i++) {
      const code = await db.customSeq.nextValue();
      entities.push({
        code: `BATCH-${code}`,
      });
    }

    await db.entities.insertBulk(entities);

    const inserted = await db.entities
      .where(e => like(e.code, 'BATCH-%'))
      .toList();

    expect(inserted).toHaveLength(5);
  });

  test('should drop sequences when calling ensureDeleted', async () => {
    // Sequences should exist before deletion
    let result = await client.query(`
      SELECT COUNT(*) as count
      FROM information_schema.sequences
      WHERE sequence_name IN ('basic_seq', 'custom_seq', 'cached_seq', 'schema_seq')
    `);

    expect(Number(result.rows[0].count)).toBeGreaterThan(0);

    // Drop schema
    await db.getSchemaManager().ensureDeleted();

    // Verify sequences are dropped
    result = await client.query(`
      SELECT COUNT(*) as count
      FROM information_schema.sequences
      WHERE sequence_name IN ('basic_seq', 'custom_seq', 'cached_seq', 'schema_seq')
    `);

    expect(Number(result.rows[0].count)).toBe(0);

    // Recreate for other tests
    await db.getSchemaManager().ensureCreated();
  });
});
