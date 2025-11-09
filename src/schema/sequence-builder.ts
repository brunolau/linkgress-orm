import { DatabaseClient } from '../database/database-client.interface';

/**
 * PostgreSQL sequence configuration
 */
export interface SequenceConfig {
  name: string;
  schema?: string;
  startWith?: number;
  incrementBy?: number;
  minValue?: number;
  maxValue?: number;
  cache?: number;
  cycle?: boolean;
}

/**
 * Sequence instance for interacting with PostgreSQL sequences
 */
export class DbSequence {
  private qualifiedName: string;

  constructor(
    private client: DatabaseClient,
    private config: SequenceConfig
  ) {
    this.qualifiedName = config.schema
      ? `"${config.schema}"."${config.name}"`
      : `"${config.name}"`;
  }

  /**
   * Get the next value from the sequence
   */
  async nextValue(): Promise<number> {
    const result = await this.client.query(
      `SELECT nextval($1::regclass) as value`,
      [this.qualifiedName]
    );
    return Number(result.rows[0].value);
  }

  /**
   * Get the current value of the sequence (without incrementing)
   */
  async currentValue(): Promise<number> {
    const result = await this.client.query(
      `SELECT currval($1::regclass) as value`,
      [this.qualifiedName]
    );
    return Number(result.rows[0].value);
  }

  /**
   * Set the sequence to a specific value
   */
  async resync(value: number): Promise<void> {
    await this.client.query(
      `SELECT setval($1::regclass, $2, true)`,
      [this.qualifiedName, value]
    );
  }

  /**
   * Get the sequence configuration
   */
  getConfig(): SequenceConfig {
    return { ...this.config };
  }

  /**
   * Get the qualified sequence name (with schema if applicable)
   */
  getQualifiedName(): string {
    return this.qualifiedName;
  }
}

/**
 * Builder for creating sequence configurations
 */
export class SequenceBuilder {
  private config: SequenceConfig;

  constructor(name: string) {
    this.config = {
      name,
      incrementBy: 1,
    };
  }

  /**
   * Set the schema for this sequence
   */
  inSchema(schema: string): this {
    this.config.schema = schema;
    return this;
  }

  /**
   * Set the starting value
   */
  startWith(value: number): this {
    this.config.startWith = value;
    return this;
  }

  /**
   * Set the increment value
   */
  incrementBy(value: number): this {
    this.config.incrementBy = value;
    return this;
  }

  /**
   * Set minimum value
   */
  minValue(value: number): this {
    this.config.minValue = value;
    return this;
  }

  /**
   * Set maximum value
   */
  maxValue(value: number): this {
    this.config.maxValue = value;
    return this;
  }

  /**
   * Set cache size
   */
  cache(value: number): this {
    this.config.cache = value;
    return this;
  }

  /**
   * Enable cycling (restart when reaching max/min value)
   */
  cycle(): this {
    this.config.cycle = true;
    return this;
  }

  /**
   * Build the sequence configuration
   */
  build(): SequenceConfig {
    return { ...this.config };
  }
}

/**
 * Helper function to create a sequence builder
 */
export function sequence(name: string): SequenceBuilder {
  return new SequenceBuilder(name);
}
