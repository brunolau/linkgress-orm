/**
 * PostgreSQL COLLATION type builder
 */

export interface CollationDefinition {
  name: string;
  provider: string;
  locale: string;
  deterministic: boolean;
}

/**
 * Registry to store all collation types defined in the schema
 */
export class CollationRegistry {
  private static collations = new Map<string, CollationDefinition>();

  static register(def: CollationDefinition): void {
    this.collations.set(def.name, def);
  }

  static get(name: string): CollationDefinition | undefined {
    return this.collations.get(name);
  }

  static getAll(): Map<string, CollationDefinition> {
    return new Map(this.collations);
  }

  static clear(): void {
    this.collations.clear();
  }

  static has(name: string): boolean {
    return this.collations.has(name);
  }
}

/**
 * Create a PostgreSQL COLLATION
 *
 * @example
 * const ndCiAi = pgCollation({
 *   name: 'nd_ci_ai',
 *   provider: 'icu',
 *   locale: 'und-u-ks-level1',
 *   deterministic: false,
 * });
 *
 * entity.property(e => e.name).hasType(varchar('name', 200)).hasCollation(ndCiAi);
 */
export function pgCollation(config: CollationDefinition): CollationDefinition {
  CollationRegistry.register(config);
  return config;
}
