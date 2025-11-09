/**
 * Base class for all entities
 * Provides common functionality and ensures proper type handling
 */
export abstract class DbEntity {
  /** @internal */
  static readonly __isEntity = true;

  /** @internal */
  static __tableName?: string;

  /** @internal */
  static __tableBuilder?: any;

  /**
   * Converts entity to plain object
   */
  toJSON(): Record<string, any> {
    return { ...this };
  }

  /**
   * Creates entity from plain object
   */
  static fromJSON<T extends DbEntity>(this: new () => T, data: Record<string, any>): T {
    const instance = new this();
    Object.assign(instance, data);
    return instance;
  }
}
