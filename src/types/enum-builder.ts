/**
 * PostgreSQL ENUM type builder
 */

export interface EnumTypeDefinition {
  name: string;
  values: string[];
}

/**
 * Registry to store all enum types defined in the schema
 */
export class EnumTypeRegistry {
  private static enums = new Map<string, EnumTypeDefinition>();

  static register(name: string, values: string[]): void {
    this.enums.set(name, { name, values });
  }

  static get(name: string): EnumTypeDefinition | undefined {
    return this.enums.get(name);
  }

  static getAll(): Map<string, EnumTypeDefinition> {
    return new Map(this.enums);
  }

  static clear(): void {
    this.enums.clear();
  }

  static has(name: string): boolean {
    return this.enums.has(name);
  }
}

/**
 * Create a PostgreSQL ENUM type
 *
 * @example
 * const statusEnum = pgEnum('order_status', ['pending', 'processing', 'completed', 'cancelled']);
 * entity.property(e => e.status).hasType(enumColumn('status', statusEnum));
 */
export function pgEnum<T extends readonly string[]>(
  name: string,
  values: T
): EnumTypeDefinition {
  const enumDef: EnumTypeDefinition = {
    name,
    values: [...values] as string[],
  };

  // Register the enum type globally
  EnumTypeRegistry.register(name, enumDef.values);

  return enumDef;
}

/**
 * Type helper to extract enum values as a union type
 */
export type EnumValues<T extends EnumTypeDefinition> = T['values'][number];
