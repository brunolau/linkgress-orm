import * as readline from 'readline';
import { DatabaseClient } from '../database/database-client.interface';
import { LogLevel } from '../entity/db-context';
import { TableSchema, IndexMethod } from '../schema/table-builder';
import { ColumnConfig } from '../schema/column-builder';
import { EnumTypeRegistry } from '../types/enum-builder';
import { CollationRegistry, CollationDefinition } from '../types/collation-builder';
import { SequenceConfig } from '../schema/sequence-builder';
import { RawSql } from '../query/conditions';

/**
 * Database column information from pg
 */
interface DbColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  collation_name: string | null;
}

/**
 * Database index information
 */
interface DbIndexInfo {
  index_name: string;
  column_names: string[];
}

/**
 * Database foreign key information
 */
interface DbForeignKeyInfo {
  constraint_name: string;
  column_names: string[];
  referenced_table: string;
  referenced_column_names: string[];
  on_delete: string | null;
  on_update: string | null;
}

/**
 * Migration operation types - describes schema changes to be applied
 */
export type MigrationOperation =
  | { type: 'create_schema'; schemaName: string }
  | { type: 'create_collation'; collation: CollationDefinition }
  | { type: 'create_enum'; enumName: string; values: readonly string[] }
  | { type: 'create_sequence'; config: SequenceConfig }
  | { type: 'create_table'; tableName: string; schema: TableSchema }
  | { type: 'drop_table'; tableName: string }
  | { type: 'add_column'; tableName: string; schema?: string; columnName: string; config: ColumnConfig }
  | { type: 'drop_column'; tableName: string; schema?: string; columnName: string }
  | { type: 'alter_column'; tableName: string; schema?: string; columnName: string; from: DbColumnInfo; to: ColumnConfig }
  | { type: 'create_index'; tableName: string; schema?: string; indexName: string; columns: string[]; isUnique?: boolean; using?: IndexMethod; operatorClass?: string; concurrent?: boolean; expressions?: string[]; where?: string }
  | { type: 'drop_index'; tableName: string; schema?: string; indexName: string }
  | { type: 'create_foreign_key'; tableName: string; schema?: string; constraint: any }
  | { type: 'drop_foreign_key'; tableName: string; schema?: string; constraintName: string };

/**
 * Database schema manager - handles schema creation, deletion, and automatic migrations
 */
export class DbSchemaManager {
  private logQueries: boolean;
  private logger: (message: string, level?: LogLevel) => void;
  private postMigrationHook?: (client: DatabaseClient) => Promise<void>;
  private sequenceRegistry: Map<string, SequenceConfig>;
  private concurrentIndexes: boolean;
  private rl: readline.Interface | null = null;

  constructor(
    private client: DatabaseClient,
    private schemaRegistry: Map<string, TableSchema>,
    options?: {
      logQueries?: boolean;
      logger?: (message: string, level?: LogLevel) => void;
      postMigrationHook?: (client: DatabaseClient) => Promise<void>;
      sequenceRegistry?: Map<string, SequenceConfig>;
      /**
       * When true, every index created by this schema manager uses
       * `CREATE INDEX CONCURRENTLY`, regardless of per-index `.concurrent()`.
       * Must not be used inside a transaction — PostgreSQL disallows it.
       */
      concurrentIndexes?: boolean;
    }
  ) {
    this.logQueries = options?.logQueries ?? false;
    this.logger = options?.logger ?? console.log;
    this.postMigrationHook = options?.postMigrationHook;
    this.sequenceRegistry = options?.sequenceRegistry ?? new Map();
    this.concurrentIndexes = options?.concurrentIndexes ?? false;
  }

  /**
   * Get or create readline interface for interactive prompts
   */
  private getReadlineInterface(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  /**
   * Close readline interface if it exists
   */
  private closeReadlineInterface(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Get qualified table name with schema prefix if specified
   */
  private getQualifiedTableName(tableName: string, schema?: string): string {
    return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
  }

  /**
   * Create all schemas used by tables
   */
  private async createSchemas(): Promise<void> {
    const schemas = new Set<string>();

    // Collect all unique schemas from tables
    for (const tableSchema of this.schemaRegistry.values()) {
      if (tableSchema.schema) {
        schemas.add(tableSchema.schema);
      }
    }

    if (schemas.size === 0) return;

    if (this.logQueries) {
      this.logger('Creating schemas...\n');
    }

    for (const schemaName of schemas) {
      const createSchemaSQL = `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`;

      if (this.logQueries) {
        this.logger(`  Creating schema "${schemaName}"...`);
      }
      await this.client.query(createSchemaSQL);
      if (this.logQueries) {
        this.logger(`  ✓ Schema "${schemaName}" created\n`);
      }
    }
  }

  /**
   * Create all ENUM types used in the schema
   */
  private async createEnumTypes(): Promise<void> {
    const enums = EnumTypeRegistry.getAll();

    if (enums.size === 0) return;

    if (this.logQueries) {
      this.logger('Creating ENUM types...\n');
    }

    for (const [enumName, enumDef] of enums.entries()) {
      // Check if enum already exists
      const checkSQL = `
        SELECT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = $1
        ) as exists
      `;
      const result = await this.client.query(checkSQL, [enumName]);
      const exists = result.rows[0]?.exists;

      if (!exists) {
        const values = enumDef.values.map(v => `'${v}'`).join(', ');
        const createEnumSQL = `CREATE TYPE "${enumName}" AS ENUM (${values})`;

        if (this.logQueries) {
          this.logger(`  Creating ENUM type "${enumName}"...`);
        }
        await this.client.query(createEnumSQL);
        if (this.logQueries) {
          this.logger(`  ✓ ENUM type "${enumName}" created\n`);
        }
      } else if (this.logQueries) {
        this.logger(`  ENUM type "${enumName}" already exists, skipping\n`);
      }
    }
  }

  /**
   * Create all COLLATION types used in the schema
   */
  private async createCollations(): Promise<void> {
    const collations = CollationRegistry.getAll();

    if (collations.size === 0) return;

    if (this.logQueries) {
      this.logger('Creating collations...\n');
    }

    for (const [collationName, collationDef] of collations.entries()) {
      const checkSQL = `
        SELECT EXISTS (
          SELECT 1 FROM pg_collation WHERE collname = $1
        ) as exists
      `;
      const result = await this.client.query(checkSQL, [collationName]);
      const exists = result.rows[0]?.exists;

      if (!exists) {
        const deterministic = collationDef.deterministic ? 'true' : 'false';
        const createSQL = `CREATE COLLATION "${collationName}" (provider = '${collationDef.provider}', locale = '${collationDef.locale}', deterministic = ${deterministic})`;

        if (this.logQueries) {
          this.logger(`  Creating collation "${collationName}"...`);
        }
        await this.client.query(createSQL);
        if (this.logQueries) {
          this.logger(`  ✓ Collation "${collationName}" created\n`);
        }
      } else if (this.logQueries) {
        this.logger(`  Collation "${collationName}" already exists, skipping\n`);
      }
    }
  }

  /**
   * Create all sequences registered in the schema
   */
  private async createSequences(): Promise<void> {
    if (this.sequenceRegistry.size === 0) return;

    if (this.logQueries) {
      this.logger('Creating sequences...\n');
    }

    for (const [_, config] of this.sequenceRegistry.entries()) {
      const qualifiedName = config.schema
        ? `"${config.schema}"."${config.name}"`
        : `"${config.name}"`;

      // Check if sequence already exists
      const checkSQL = config.schema
        ? `SELECT EXISTS (
            SELECT 1 FROM information_schema.sequences
            WHERE sequence_schema = $1 AND sequence_name = $2
          ) as exists`
        : `SELECT EXISTS (
            SELECT 1 FROM information_schema.sequences
            WHERE sequence_name = $1 AND sequence_schema = 'public'
          ) as exists`;

      const checkParams = config.schema ? [config.schema, config.name] : [config.name];
      const result = await this.client.query(checkSQL, checkParams);
      const exists = result.rows[0]?.exists;

      if (!exists) {
        // Build CREATE SEQUENCE statement
        let createSQL = `CREATE SEQUENCE ${qualifiedName}`;
        const options: string[] = [];

        if (config.startWith !== undefined) {
          options.push(`START WITH ${config.startWith}`);
        }
        if (config.incrementBy !== undefined) {
          options.push(`INCREMENT BY ${config.incrementBy}`);
        }
        if (config.minValue !== undefined) {
          options.push(`MINVALUE ${config.minValue}`);
        }
        if (config.maxValue !== undefined) {
          options.push(`MAXVALUE ${config.maxValue}`);
        }
        if (config.cache !== undefined) {
          options.push(`CACHE ${config.cache}`);
        }
        if (config.cycle) {
          options.push(`CYCLE`);
        }

        if (options.length > 0) {
          createSQL += ` ${options.join(' ')}`;
        }

        if (this.logQueries) {
          this.logger(`  Creating sequence ${qualifiedName}...`);
        }
        await this.client.query(createSQL);
        if (this.logQueries) {
          this.logger(`  ✓ Sequence ${qualifiedName} created\n`);
        }
      } else if (this.logQueries) {
        this.logger(`  Sequence ${qualifiedName} already exists, skipping\n`);
      }
    }
  }

  /**
   * Create a single table
   * @param tableName - The table name
   * @param tableSchema - The table schema
   * @param options - Options for table creation
   * @param options.skipForeignKeys - If true, foreign keys will not be added (useful for deferred FK creation)
   */
  private async createTable(
    tableName: string,
    tableSchema: TableSchema,
    options?: { skipForeignKeys?: boolean }
  ): Promise<void> {
    const columnDefs: string[] = [];
    const primaryKeys: string[] = [];
    const skipForeignKeys = options?.skipForeignKeys ?? false;

    for (const [colKey, colBuilder] of Object.entries(tableSchema.columns)) {
      const config = (colBuilder as any).build();
      let def = `"${config.name}" ${config.type}`;

      if (config.length) {
        def += `(${config.length})`;
      } else if (config.precision && config.scale) {
        def += `(${config.precision}, ${config.scale})`;
      } else if (config.precision) {
        def += `(${config.precision})`;
      }

      if (config.collation) {
        def += ` COLLATE "${config.collation}"`;
      }

      // Handle GENERATED ALWAYS AS IDENTITY
      if (config.identity) {
        def += ' GENERATED ALWAYS AS IDENTITY';

        // Add sequence options if specified
        const seqOptions: string[] = [];
        if (config.identity.startWith !== undefined) {
          seqOptions.push(`START WITH ${config.identity.startWith}`);
        }
        if (config.identity.incrementBy !== undefined) {
          seqOptions.push(`INCREMENT BY ${config.identity.incrementBy}`);
        }

        if (seqOptions.length > 0) {
          def += ` (${seqOptions.join(' ')})`;
        }
      }

      if (!config.nullable) {
        def += ' NOT NULL';
      }

      if (config.unique && !config.primaryKey) {
        def += ' UNIQUE';
      }

      if (config.default !== undefined && !config.identity) {
        def += ` DEFAULT ${this.formatDefaultValue(config.default)}`;
      }

      columnDefs.push(def);

      if (config.primaryKey) {
        primaryKeys.push(`"${config.name}"`);
      }
    }

    // Add primary key constraint
    if (primaryKeys.length > 0) {
      columnDefs.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
    }

    // Add foreign key constraints only if not skipped
    if (!skipForeignKeys) {
      // Add foreign key constraints from schema.foreignKeys (includes ON DELETE/ON UPDATE actions)
      const foreignKeys = tableSchema.foreignKeys || [];
      for (const fk of foreignKeys) {
        const columnList = fk.columns.map(c => `"${c}"`).join(', ');
        const refColumnList = fk.referencedColumns.map(c => `"${c}"`).join(', ');

        // Find the referenced table's schema
        const referencedTableSchema = this.schemaRegistry.get(fk.referencedTable);
        const qualifiedReferencedTable = this.getQualifiedTableName(fk.referencedTable, referencedTableSchema?.schema);

        let fkDef = `CONSTRAINT "${fk.name}" FOREIGN KEY (${columnList}) REFERENCES ${qualifiedReferencedTable}(${refColumnList})`;

        if (fk.onDelete) {
          fkDef += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
        }
        if (fk.onUpdate) {
          fkDef += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
        }

        columnDefs.push(fkDef);
      }

      // Fallback: Add foreign key constraints from column references (for backward compatibility)
      // Only add if not already added via foreignKeys array
      const addedFkColumns = new Set(foreignKeys.flatMap(fk => fk.columns));
      for (const [colKey, colBuilder] of Object.entries(tableSchema.columns)) {
        const config = (colBuilder as any).build();
        if (config.references && !addedFkColumns.has(config.name)) {
          columnDefs.push(
            `FOREIGN KEY ("${config.name}") REFERENCES "${config.references.table}"("${config.references.column}")`
          );
        }
      }
    }

    const qualifiedTableName = this.getQualifiedTableName(tableName, tableSchema.schema);
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
        ${columnDefs.join(',\n        ')}
      )
    `;

    if (this.logQueries) {
      this.logger(`  Creating table ${qualifiedTableName}...`);
    }
    await this.client.query(createTableSQL);
    if (this.logQueries) {
      this.logger(`  ✓ Table ${qualifiedTableName} created\n`);
    }
  }

  /**
   * Add foreign key constraints to a table (used after all tables are created)
   */
  private async addForeignKeysToTable(tableName: string, tableSchema: TableSchema): Promise<void> {
    const qualifiedTableName = this.getQualifiedTableName(tableName, tableSchema.schema);

    // Add foreign key constraints from schema.foreignKeys
    const foreignKeys = tableSchema.foreignKeys || [];
    for (const fk of foreignKeys) {
      const columnList = fk.columns.map(c => `"${c}"`).join(', ');
      const refColumnList = fk.referencedColumns.map(c => `"${c}"`).join(', ');

      // Find the referenced table's schema
      const referencedTableSchema = this.schemaRegistry.get(fk.referencedTable);
      const qualifiedReferencedTable = this.getQualifiedTableName(fk.referencedTable, referencedTableSchema?.schema);

      let alterSQL = `ALTER TABLE ${qualifiedTableName} ADD CONSTRAINT "${fk.name}" FOREIGN KEY (${columnList}) REFERENCES ${qualifiedReferencedTable}(${refColumnList})`;

      if (fk.onDelete) {
        alterSQL += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      }
      if (fk.onUpdate) {
        alterSQL += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
      }

      if (this.logQueries) {
        this.logger(`  Adding foreign key ${fk.name} to ${qualifiedTableName}...`);
      }
      await this.client.query(alterSQL);
      if (this.logQueries) {
        this.logger(`  ✓ Foreign key ${fk.name} added\n`);
      }
    }

    // Fallback: Add foreign key constraints from column references (for backward compatibility)
    const addedFkColumns = new Set(foreignKeys.flatMap(fk => fk.columns));
    for (const [colKey, colBuilder] of Object.entries(tableSchema.columns)) {
      const config = (colBuilder as any).build();
      if (config.references && !addedFkColumns.has(config.name)) {
        const fkName = `fk_${tableName}_${config.name}`;
        const alterSQL = `ALTER TABLE ${qualifiedTableName} ADD CONSTRAINT "${fkName}" FOREIGN KEY ("${config.name}") REFERENCES "${config.references.table}"("${config.references.column}")`;

        if (this.logQueries) {
          this.logger(`  Adding foreign key ${fkName} to ${qualifiedTableName}...`);
        }
        await this.client.query(alterSQL);
        if (this.logQueries) {
          this.logger(`  ✓ Foreign key ${fkName} added\n`);
        }
      }
    }
  }

  /**
   * Sort tables in dependency order (topological sort)
   * Tables with no foreign key dependencies come first
   */
  private sortTablesByDependency(): Array<[string, TableSchema]> {
    const tables = Array.from(this.schemaRegistry.entries());
    const tableNames = new Set(tables.map(([name]) => name));

    // Build dependency graph: tableName -> set of tables it depends on
    const dependencies = new Map<string, Set<string>>();

    for (const [tableName, tableSchema] of tables) {
      const deps = new Set<string>();

      // Check foreign keys defined in foreignKeys array
      const foreignKeys = tableSchema.foreignKeys || [];
      for (const fk of foreignKeys) {
        if (tableNames.has(fk.referencedTable) && fk.referencedTable !== tableName) {
          deps.add(fk.referencedTable);
        }
      }

      // Check column references (backward compatibility)
      for (const [_, colBuilder] of Object.entries(tableSchema.columns)) {
        const config = (colBuilder as any).build();
        if (config.references && tableNames.has(config.references.table) && config.references.table !== tableName) {
          deps.add(config.references.table);
        }
      }

      dependencies.set(tableName, deps);
    }

    // Topological sort using Kahn's algorithm
    // in-degree = number of dependencies a table has (tables it references)
    const sorted: Array<[string, TableSchema]> = [];
    const remaining = new Map<string, Set<string>>();

    // Copy dependencies
    for (const [tableName, deps] of dependencies) {
      remaining.set(tableName, new Set(deps));
    }

    // Find all tables with no dependencies
    const queue: string[] = [];
    for (const [tableName, deps] of remaining) {
      if (deps.size === 0) {
        queue.push(tableName);
      }
    }

    // Process tables in order
    while (queue.length > 0) {
      const tableName = queue.shift()!;
      const tableSchema = this.schemaRegistry.get(tableName)!;
      sorted.push([tableName, tableSchema]);

      // Remove this table from other tables' dependencies
      for (const [depTableName, deps] of remaining) {
        if (deps.has(tableName)) {
          deps.delete(tableName);
          if (deps.size === 0 && !sorted.some(([name]) => name === depTableName)) {
            queue.push(depTableName);
          }
        }
      }
    }

    // If we didn't process all tables, there's a circular dependency
    // Fall back to original order and let the database handle it
    if (sorted.length !== tables.length) {
      if (this.logQueries) {
        this.logger('Warning: Circular dependency detected in table foreign keys, using original order\n', 'warn');
      }
      return tables;
    }

    return sorted;
  }

  /**
   * Create all tables in the database
   */
  async ensureCreated(): Promise<void> {
    if (this.logQueries) {
      this.logger('Creating database schema...\n');
    }

    // Create schemas first
    await this.createSchemas();

    // Create collations
    await this.createCollations();

    // Create enum types
    await this.createEnumTypes();

    // Create sequences
    await this.createSequences();

    // Create tables in dependency order
    const sortedTables = this.sortTablesByDependency();
    for (const [tableName, tableSchema] of sortedTables) {
      await this.createTable(tableName, tableSchema);
    }

    // Create indexes
    for (const [tableName, tableSchema] of sortedTables) {
      await this.createIndexes(tableName, tableSchema);
    }

    if (this.logQueries) {
      this.logger('✓ Database schema created successfully\n');
    }

    // Execute post-migration hook if provided
    if (this.postMigrationHook) {
      if (this.logQueries) {
        this.logger('Executing post-migration scripts...\n');
      }
      await this.postMigrationHook(this.client);
      if (this.logQueries) {
        this.logger('✓ Post-migration scripts completed\n');
      }
    }
  }

  /**
   * Create indexes for a table
   */
  private async createIndexes(tableName: string, tableSchema: TableSchema): Promise<void> {
    const indexes = tableSchema.indexes || [];
    for (const index of indexes) {
      await this.executeCreateIndex(tableName, index, tableSchema.schema);
    }
  }

  /**
   * Drop all tables
   */
  async ensureDeleted(): Promise<void> {
    if (this.logQueries) {
      this.logger('Dropping database schema...\n');
    }

    for (const [tableName, tableSchema] of this.schemaRegistry.entries()) {
      const qualifiedTableName = this.getQualifiedTableName(tableName, tableSchema.schema);
      if (this.logQueries) {
        this.logger(`  Dropping table ${qualifiedTableName}...`);
      }
      await this.client.query(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE`);
      if (this.logQueries) {
        this.logger(`  ✓ Table ${qualifiedTableName} dropped\n`);
      }
    }

    // Drop sequences
    if (this.sequenceRegistry.size > 0 && this.logQueries) {
      this.logger('Dropping sequences...\n');
    }

    for (const [_, config] of this.sequenceRegistry.entries()) {
      const qualifiedName = config.schema
        ? `"${config.schema}"."${config.name}"`
        : `"${config.name}"`;

      if (this.logQueries) {
        this.logger(`  Dropping sequence ${qualifiedName}...`);
      }
      await this.client.query(`DROP SEQUENCE IF EXISTS ${qualifiedName} CASCADE`);
      if (this.logQueries) {
        this.logger(`  ✓ Sequence ${qualifiedName} dropped\n`);
      }
    }

    // Drop enum types
    const enums = EnumTypeRegistry.getAll();
    if (enums.size > 0 && this.logQueries) {
      this.logger('Dropping ENUM types...\n');
    }

    for (const [enumName, _] of enums.entries()) {
      if (this.logQueries) {
        this.logger(`  Dropping ENUM type "${enumName}"...`);
      }
      await this.client.query(`DROP TYPE IF EXISTS "${enumName}" CASCADE`);
      if (this.logQueries) {
        this.logger(`  ✓ ENUM type "${enumName}" dropped\n`);
      }
    }

    // Drop schemas (note: CASCADE will drop all objects in the schema)
    const schemas = new Set<string>();
    for (const tableSchema of this.schemaRegistry.values()) {
      if (tableSchema.schema) {
        schemas.add(tableSchema.schema);
      }
    }

    if (schemas.size > 0 && this.logQueries) {
      this.logger('Dropping schemas...\n');
    }

    for (const schemaName of schemas) {
      if (this.logQueries) {
        this.logger(`  Dropping schema "${schemaName}"...`);
      }
      await this.client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      if (this.logQueries) {
        this.logger(`  ✓ Schema "${schemaName}" dropped\n`);
      }
    }

    if (this.logQueries) {
      this.logger('✓ Database schema dropped successfully\n');
    }
  }

  /**
   * Analyze differences between current DB and model schema
   */
  async analyze(): Promise<MigrationOperation[]> {
    this.logger('🔍 Analyzing database schema...\n');

    const operations: MigrationOperation[] = [];

    // Check schemas
    const modelSchemas = new Set<string>();
    for (const tableSchema of this.schemaRegistry.values()) {
      if (tableSchema.schema) {
        modelSchemas.add(tableSchema.schema);
      }
    }

    // Add schema creation operations if needed
    for (const schemaName of modelSchemas) {
      const result = await this.client.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
        ) as exists
      `, [schemaName]);

      if (!result.rows[0]?.exists) {
        operations.push({ type: 'create_schema', schemaName });
      }
    }

    // Check collations
    const modelCollations = CollationRegistry.getAll();
    for (const [collationName, collationDef] of modelCollations.entries()) {
      const result = await this.client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_collation WHERE collname = $1
        ) as exists
      `, [collationName]);

      if (!result.rows[0]?.exists) {
        operations.push({ type: 'create_collation', collation: collationDef });
      }
    }

    // Check enums
    const modelEnums = EnumTypeRegistry.getAll();
    for (const [enumName, enumDef] of modelEnums.entries()) {
      const result = await this.client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = $1
        ) as exists
      `, [enumName]);

      if (!result.rows[0]?.exists) {
        operations.push({ type: 'create_enum', enumName, values: enumDef.values });
      }
    }

    // Check sequences
    for (const [_, config] of this.sequenceRegistry.entries()) {
      const checkSQL = config.schema
        ? `SELECT EXISTS (
            SELECT 1 FROM information_schema.sequences
            WHERE sequence_schema = $1 AND sequence_name = $2
          ) as exists`
        : `SELECT EXISTS (
            SELECT 1 FROM information_schema.sequences
            WHERE sequence_name = $1 AND sequence_schema = 'public'
          ) as exists`;

      const checkParams = config.schema ? [config.schema, config.name] : [config.name];
      const result = await this.client.query(checkSQL, checkParams);

      if (!result.rows[0]?.exists) {
        operations.push({ type: 'create_sequence', config });
      }
    }

    // Get all existing tables
    const existingTables = await this.getExistingTables();
    const modelTables = new Set(this.schemaRegistry.keys());

    // Find tables to create
    for (const [tableName, schema] of this.schemaRegistry.entries()) {
      const tableKey = schema.schema && schema.schema !== 'public' ? `${schema.schema}.${tableName}` : tableName;
      if (!existingTables.has(tableKey)) {
        operations.push({ type: 'create_table', tableName, schema });
      }
    }

    // Compare columns for existing tables
    for (const [tableName, schema] of this.schemaRegistry.entries()) {
      const tableKey = schema.schema && schema.schema !== 'public' ? `${schema.schema}.${tableName}` : tableName;
      if (existingTables.has(tableKey)) {
        const existingColumns = await this.getExistingColumns(tableName, schema.schema);
        const modelColumns = new Map<string, ColumnConfig>();

        // Build model columns map
        for (const [colKey, colBuilder] of Object.entries(schema.columns)) {
          const config = (colBuilder as any).build();
          modelColumns.set(config.name, config);
        }

        // Find columns to add
        for (const [colName, config] of modelColumns.entries()) {
          if (!existingColumns.has(colName)) {
            operations.push({ type: 'add_column', tableName, schema: schema.schema, columnName: colName, config });
          }
        }

        // Find columns to alter
        for (const [colName, dbInfo] of existingColumns.entries()) {
          const modelConfig = modelColumns.get(colName);
          if (modelConfig && this.needsAlter(dbInfo, modelConfig)) {
            operations.push({ type: 'alter_column', tableName, schema: schema.schema, columnName: colName, from: dbInfo, to: modelConfig });
          }
        }

        // Compare indexes
        const existingIndexes = await this.getExistingIndexes(tableName, schema.schema);
        const modelIndexes = schema.indexes || [];

        // Find indexes to create
        for (const modelIndex of modelIndexes) {
          const exists = existingIndexes.some(dbIndex =>
            dbIndex.index_name === modelIndex.name
          );
          if (!exists) {
            operations.push({
              type: 'create_index',
              tableName,
              schema: schema.schema,
              indexName: modelIndex.name,
              columns: modelIndex.columns,
              isUnique: modelIndex.isUnique,
              using: modelIndex.using,
              operatorClass: modelIndex.operatorClass,
              concurrent: modelIndex.concurrent,
              expressions: modelIndex.expressions,
              where: modelIndex.where,
            });
          }
        }

        // Compare foreign key constraints
        const existingForeignKeys = await this.getExistingForeignKeys(tableName, schema.schema);
        const modelForeignKeys = schema.foreignKeys || [];

        // Find foreign keys to create
        for (const modelFk of modelForeignKeys) {
          const exists = existingForeignKeys.some(dbFk =>
            dbFk.constraint_name === modelFk.name
          );
          if (!exists) {
            operations.push({
              type: 'create_foreign_key',
              tableName,
              schema: schema.schema,
              constraint: modelFk
            });
          }
        }
      }
    }

    return operations;
  }

  /**
   * Perform automatic migration - analyze and apply changes
   *
   * Tables are created first without foreign keys, then foreign keys are added
   * in a second pass. This ensures all referenced tables exist before FK constraints
   * are created.
   */
  async migrate(): Promise<void> {
    try {
      const operations = await this.analyze();

      if (operations.length === 0) {
        this.logger('✓ Database schema is already in sync with model\n');
        return;
      }

      // Separate operations into phases:
      // Phase 1: Schema, enum, table creation (without FKs), column additions
      // Phase 2: Foreign key constraints
      // Phase 3: Indexes and other operations
      const phase1Ops: MigrationOperation[] = [];
      const phase2Ops: MigrationOperation[] = [];
      const phase3Ops: MigrationOperation[] = [];

      // Track which tables are being created so we can add their FKs later
      const tablesToCreate = new Set<string>();

      for (const op of operations) {
        if (op.type === 'create_schema' || op.type === 'create_collation' || op.type === 'create_enum' || op.type === 'create_sequence') {
          phase1Ops.push(op);
        } else if (op.type === 'create_table') {
          phase1Ops.push(op);
          tablesToCreate.add(op.tableName);
        } else if (op.type === 'add_column' || op.type === 'drop_column' || op.type === 'alter_column') {
          phase1Ops.push(op);
        } else if (op.type === 'create_foreign_key') {
          phase2Ops.push(op);
        } else if (op.type === 'drop_table' || op.type === 'drop_foreign_key') {
          // Destructive operations go first (before creating new things that might conflict)
          phase1Ops.unshift(op);
        } else {
          phase3Ops.push(op);
        }
      }

      // For newly created tables, we need to add their FK constraints in phase 2
      // and their indexes in phase 3
      // Extract FK and index operations from create_table schemas
      for (const tableName of tablesToCreate) {
        const schema = this.schemaRegistry.get(tableName);
        if (schema) {
          const foreignKeys = schema.foreignKeys || [];
          for (const fk of foreignKeys) {
            phase2Ops.push({
              type: 'create_foreign_key',
              tableName,
              schema: schema.schema,
              constraint: fk
            });
          }

          // Also check column-level references
          const addedFkColumns = new Set(foreignKeys.flatMap(fk => fk.columns));
          for (const [_, colBuilder] of Object.entries(schema.columns)) {
            const config = (colBuilder as any).build();
            if (config.references && !addedFkColumns.has(config.name)) {
              phase2Ops.push({
                type: 'create_foreign_key',
                tableName,
                schema: schema.schema,
                constraint: {
                  name: `fk_${tableName}_${config.name}`,
                  columns: [config.name],
                  referencedTable: config.references.table,
                  referencedColumns: [config.references.column]
                }
              });
            }
          }

          // Add indexes for newly created tables to phase 3
          const indexes = schema.indexes || [];
          for (const index of indexes) {
            phase3Ops.push({
              type: 'create_index',
              tableName,
			  schema: schema.schema,
              indexName: index.name,
              columns: index.columns,
              isUnique: index.isUnique,
              using: index.using,
              operatorClass: index.operatorClass,
              concurrent: index.concurrent,
              expressions: index.expressions,
              where: index.where,
            });
          }
        }
      }

      const totalOps = phase1Ops.length + phase2Ops.length + phase3Ops.length;
      this.logger(`📋 Found ${totalOps} operations to perform:\n`);

      // Show all operations
      let opNum = 1;
      for (const op of [...phase1Ops, ...phase2Ops, ...phase3Ops]) {
        this.logger(`${opNum++}. ${this.describeOperation(op)}`);
      }
      this.logger('');

      // Phase 1: Create schemas, enums, tables (without FKs), column changes
      if (phase1Ops.length > 0) {
        this.logger('📦 Phase 1: Creating schemas, enums, and tables...\n');
        for (const operation of phase1Ops) {
          await this.executeOperation(operation, { skipForeignKeys: tablesToCreate.has((operation as any).tableName) });
        }
      }

      // Phase 2: Add foreign key constraints
      if (phase2Ops.length > 0) {
        this.logger('🔗 Phase 2: Adding foreign key constraints...\n');
        for (const operation of phase2Ops) {
          await this.executeOperation(operation);
        }
      }

      // Phase 3: Create indexes and other operations
      if (phase3Ops.length > 0) {
        this.logger('📇 Phase 3: Creating indexes...\n');
        for (const operation of phase3Ops) {
          await this.executeOperation(operation);
        }
      }

      this.logger('\n✓ Migration completed successfully\n');

      // Execute post-migration hook if provided
      if (this.postMigrationHook) {
        if (this.logQueries) {
          this.logger('Executing post-migration scripts...\n');
        }
        await this.postMigrationHook(this.client);
        if (this.logQueries) {
          this.logger('✓ Post-migration scripts completed\n');
        }
      }
    } finally {
      this.closeReadlineInterface();
    }
  }

  /**
   * Execute a single migration operation
   */
  private async executeOperation(
    operation: MigrationOperation,
    options?: { skipForeignKeys?: boolean }
  ): Promise<void> {
    switch (operation.type) {
      case 'create_schema':
        await this.executeCreateSchema(operation.schemaName);
        break;

      case 'create_collation':
        await this.executeCreateCollation(operation.collation);
        break;

      case 'create_enum':
        await this.executeCreateEnum(operation.enumName, operation.values);
        break;

      case 'create_sequence':
        await this.executeCreateSequence(operation.config);
        break;

      case 'create_table':
        await this.createTable(operation.tableName, operation.schema, { skipForeignKeys: options?.skipForeignKeys });
        break;

      case 'drop_table':
        if (await this.confirm(`Drop table "${operation.tableName}"? This will DELETE ALL DATA in the table.`)) {
          await this.executeDropTable(operation.tableName);
        } else {
          this.logger(`  ⊘ Skipped dropping table "${operation.tableName}"\n`, 'warn');
        }
        break;

      case 'add_column':
        await this.executeAddColumn(operation.tableName, operation.columnName, operation.config, operation.schema);
        break;

      case 'drop_column':
        if (await this.confirm(`Drop column "${operation.tableName}"."${operation.columnName}"? This will DELETE ALL DATA in the column.`)) {
          await this.executeDropColumn(operation.tableName, operation.columnName, operation.schema);
        } else {
          this.logger(`  ⊘ Skipped dropping column "${operation.tableName}"."${operation.columnName}"\n`, 'warn');
        }
        break;

      case 'alter_column':
        await this.executeAlterColumn(operation.tableName, operation.columnName, operation.from, operation.to, operation.schema);
        break;

      case 'create_index':
        await this.executeCreateIndex(operation.tableName, {
          name: operation.indexName,
          columns: operation.columns,
          isUnique: operation.isUnique,
          using: operation.using,
          operatorClass: operation.operatorClass,
          concurrent: operation.concurrent,
          expressions: operation.expressions,
          where: operation.where,
        }, operation.schema);
        break;

      case 'drop_index':
        if (await this.confirm(`Drop index "${operation.indexName}"?`)) {
          await this.executeDropIndex(operation.indexName, operation.schema);
        } else {
          this.logger(`  ⊘ Skipped dropping index "${operation.indexName}"\n`, 'warn');
        }
        break;

      case 'create_foreign_key':
        await this.executeCreateForeignKey(operation.tableName, operation.constraint, operation.schema);
        break;

      case 'drop_foreign_key':
        if (await this.confirm(`Drop foreign key "${operation.constraintName}"?`)) {
          await this.executeDropForeignKey(operation.tableName, operation.constraintName, operation.schema);
        } else {
          this.logger(`  ⊘ Skipped dropping foreign key "${operation.constraintName}"\n`, 'warn');
        }
        break;
    }
  }

  /**
   * Execute create schema
   */
  private async executeCreateSchema(schemaName: string): Promise<void> {
    this.logger(`  Creating schema "${schemaName}"...`);
    await this.client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    this.logger(`  ✓ Schema "${schemaName}" created\n`);
  }

  /**
   * Execute create enum
   */
  private async executeCreateCollation(collation: CollationDefinition): Promise<void> {
    this.logger(`  Creating collation "${collation.name}"...`);
    const deterministic = collation.deterministic ? 'true' : 'false';
    await this.client.query(`CREATE COLLATION IF NOT EXISTS "${collation.name}" (provider = '${collation.provider}', locale = '${collation.locale}', deterministic = ${deterministic})`);
    this.logger(`  ✓ Collation "${collation.name}" created\n`);
  }

  private async executeCreateEnum(enumName: string, values: readonly string[]): Promise<void> {
    this.logger(`  Creating ENUM type "${enumName}"...`);
    const valueList = values.map(v => `'${v}'`).join(', ');
    await this.client.query(`CREATE TYPE "${enumName}" AS ENUM (${valueList})`);
    this.logger(`  ✓ ENUM type "${enumName}" created\n`);
  }

  /**
   * Execute create sequence
   */
  private async executeCreateSequence(config: SequenceConfig): Promise<void> {
    const qualifiedName = config.schema
      ? `"${config.schema}"."${config.name}"`
      : `"${config.name}"`;

    this.logger(`  Creating sequence ${qualifiedName}...`);

    // Build CREATE SEQUENCE statement
    let createSQL = `CREATE SEQUENCE ${qualifiedName}`;
    const options: string[] = [];

    if (config.startWith !== undefined) {
      options.push(`START WITH ${config.startWith}`);
    }
    if (config.incrementBy !== undefined) {
      options.push(`INCREMENT BY ${config.incrementBy}`);
    }
    if (config.minValue !== undefined) {
      options.push(`MINVALUE ${config.minValue}`);
    }
    if (config.maxValue !== undefined) {
      options.push(`MAXVALUE ${config.maxValue}`);
    }
    if (config.cache !== undefined) {
      options.push(`CACHE ${config.cache}`);
    }
    if (config.cycle) {
      options.push(`CYCLE`);
    }

    if (options.length > 0) {
      createSQL += ` ${options.join(' ')}`;
    }

    await this.client.query(createSQL);
    this.logger(`  ✓ Sequence ${qualifiedName} created\n`);
  }

  /**
   * Execute drop table
   */
  private async executeDropTable(tableName: string): Promise<void> {
    this.logger(`  Dropping table "${tableName}"...`);
    await this.client.query(`DROP TABLE "${tableName}" CASCADE`);
    this.logger(`  ✓ Table "${tableName}" dropped\n`);
  }

  /**
   * Execute add column
   */
  private async executeAddColumn(tableName: string, columnName: string, config: ColumnConfig, schema?: string): Promise<void> {
    const qualifiedTableName = this.getQualifiedTableName(tableName, schema);
    this.logger(`  Adding column ${qualifiedTableName}."${columnName}"...`);

    let def = `${config.type}`;

    if (config.length) {
      def += `(${config.length})`;
    } else if (config.precision && config.scale) {
      def += `(${config.precision}, ${config.scale})`;
    } else if (config.precision) {
      def += `(${config.precision})`;
    }

    if (config.collation) {
      def += ` COLLATE "${config.collation}"`;
    }

    if (!config.nullable) {
      def += ' NOT NULL';
    }

    if (config.unique) {
      def += ' UNIQUE';
    }

    if (config.default !== undefined) {
      def += ` DEFAULT ${this.formatDefaultValue(config.default)}`;
    }

    const sql = `ALTER TABLE ${qualifiedTableName} ADD COLUMN "${columnName}" ${def}`;
    await this.client.query(sql);
    this.logger(`  ✓ Column ${qualifiedTableName}."${columnName}" added\n`);
  }

  /**
   * Execute drop column
   */
  private async executeDropColumn(tableName: string, columnName: string, schema?: string): Promise<void> {
    const qualifiedTableName = this.getQualifiedTableName(tableName, schema);
    this.logger(`  Dropping column ${qualifiedTableName}."${columnName}"...`);
    await this.client.query(`ALTER TABLE ${qualifiedTableName} DROP COLUMN "${columnName}"`);
    this.logger(`  ✓ Column ${qualifiedTableName}."${columnName}" dropped\n`);
  }

  /**
   * Execute alter column
   */
  private async executeAlterColumn(tableName: string, columnName: string, from: DbColumnInfo, to: ColumnConfig, schema?: string): Promise<void> {
    const qualifiedTableName = this.getQualifiedTableName(tableName, schema);
    this.logger(`  Altering column ${qualifiedTableName}."${columnName}"...`);
    this.logger(`    From: ${this.describeDbColumn(from)}`);
    this.logger(`    To:   ${this.describeModelColumn(to)}`);

    // PostgreSQL requires separate ALTER COLUMN commands for different changes

    // Change type if needed - resolve ARRAY/USER-DEFINED via udt_name before normalizing
    const fromType = this.normalizeType(this.resolveDbType(from));
    const toType = this.normalizeType(to.type);
    if (fromType !== toType) {
      const typeDef = this.buildTypeDefinition(to);
      await this.client.query(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN "${columnName}" TYPE ${typeDef} USING "${columnName}"::${typeDef}`);
      this.logger(`    ✓ Type changed from ${fromType} to ${toType}`);
    }

    // Change nullability if needed
    const fromNullable = from.is_nullable === 'YES';
    const toNullable = to.nullable;
    if (fromNullable !== toNullable) {
      if (toNullable) {
        await this.client.query(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN "${columnName}" DROP NOT NULL`);
        this.logger(`    ✓ Nullability changed to NULLABLE`);
      } else {
        await this.client.query(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN "${columnName}" SET NOT NULL`);
        this.logger(`    ✓ Nullability changed to NOT NULL`);
      }
    }

    // Change collation if needed
    const fromCollation = from.collation_name;
    const toCollation = to.collation || null;
    if (toCollation && fromCollation !== toCollation) {
      const typeDef = this.buildTypeDefinition(to);
      await this.client.query(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN "${columnName}" TYPE ${typeDef} COLLATE "${toCollation}"`);
      this.logger(`    ✓ Collation changed to "${toCollation}"`);
    }

    // Change default if needed
    const fromDefault = from.column_default;
    const toDefault = to.default !== undefined ? this.formatDefaultValue(to.default) : null;
    if (fromDefault !== toDefault) {
      if (toDefault !== null) {
        await this.client.query(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN "${columnName}" SET DEFAULT ${toDefault}`);
        this.logger(`    ✓ Default changed to ${toDefault}`);
      } else {
        await this.client.query(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN "${columnName}" DROP DEFAULT`);
        this.logger(`    ✓ Default removed`);
      }
    }

    this.logger(`  ✓ Column ${qualifiedTableName}."${columnName}" altered\n`);
  }

  /**
   * Execute create index
   */
  private static readonly VALID_INDEX_METHODS: ReadonlySet<string> = new Set(['btree', 'gin', 'gist', 'hash', 'brin', 'spgist']);
  private static readonly VALID_OPERATOR_CLASS = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  private async executeCreateIndex(tableName: string, index: { name: string; columns: string[]; isUnique?: boolean; using?: IndexMethod; operatorClass?: string; concurrent?: boolean; expressions?: string[]; where?: string }, schema?: string): Promise<void> {
    if (index.using && !DbSchemaManager.VALID_INDEX_METHODS.has(index.using)) {
      throw new Error(`Invalid index method: "${index.using}". Must be one of: ${[...DbSchemaManager.VALID_INDEX_METHODS].join(', ')}`);
    }
    if (index.operatorClass && !DbSchemaManager.VALID_OPERATOR_CLASS.test(index.operatorClass)) {
      throw new Error(`Invalid operator class: "${index.operatorClass}". Must be a valid PostgreSQL identifier.`);
    }

    const uniqueStr = index.isUnique ? 'UNIQUE ' : '';
    const useConcurrent = index.concurrent || this.concurrentIndexes;
    const concurrentStr = useConcurrent ? 'CONCURRENTLY ' : '';
    const usingStr = index.using ? ` USING ${index.using}` : '';
    const qualifiedTableName = this.getQualifiedTableName(tableName, schema);
    this.logger(`  Creating ${uniqueStr}${concurrentStr}index "${index.name}" on ${qualifiedTableName}...`);

    const opClassSuffix = index.operatorClass ? ` ${index.operatorClass}` : '';
    let columnList: string;
    if (index.expressions && index.expressions.length > 0) {
      // Expression-based index: use raw SQL expressions (no quoting)
      columnList = index.expressions.map(expr => `${expr}${opClassSuffix}`).join(', ');
    } else {
      columnList = index.columns.map(col => `"${col}"${opClassSuffix}`).join(', ');
    }
    const whereStr = index.where ? ` WHERE ${index.where}` : '';
    const sql = `CREATE ${uniqueStr}INDEX ${concurrentStr}IF NOT EXISTS "${index.name}" ON ${qualifiedTableName}${usingStr} (${columnList})${whereStr}`;

    await this.client.query(sql);
    this.logger(`  ✓ ${uniqueStr}${concurrentStr}Index "${index.name}" created\n`);
  }

  /**
   * Execute drop index
   */
  private async executeDropIndex(indexName: string, schema?: string): Promise<void> {
    const qualifiedIndexName = schema ? `"${schema}"."${indexName}"` : `"${indexName}"`;
    this.logger(`  Dropping index ${qualifiedIndexName}...`);
    await this.client.query(`DROP INDEX ${qualifiedIndexName}`);
    this.logger(`  ✓ Index ${qualifiedIndexName} dropped\n`);
  }

  /**
   * Execute create foreign key
   */
  private async executeCreateForeignKey(tableName: string, constraint: any, schema?: string): Promise<void> {
    const qualifiedTableName = this.getQualifiedTableName(tableName, schema);
    const referencedTableSchema = this.schemaRegistry?.get(constraint.referencedTable);
    const qualifiedReferencedTable = this.getQualifiedTableName(constraint.referencedTable, referencedTableSchema?.schema);

    this.logger(`  Creating foreign key constraint "${constraint.name}" on ${qualifiedTableName}...`);

    const columnList = constraint.columns.map((col: string) => `"${col}"`).join(', ');
    const refColumnList = constraint.referencedColumns.map((col: string) => `"${col}"`).join(', ');

    let sql = `ALTER TABLE ${qualifiedTableName} ADD CONSTRAINT "${constraint.name}" `;
    sql += `FOREIGN KEY (${columnList}) `;
    sql += `REFERENCES ${qualifiedReferencedTable} (${refColumnList})`;

    if (constraint.onDelete) {
      sql += ` ON DELETE ${constraint.onDelete.toUpperCase()}`;
    }

    if (constraint.onUpdate) {
      sql += ` ON UPDATE ${constraint.onUpdate.toUpperCase()}`;
    }

    await this.client.query(sql);
    this.logger(`  ✓ Foreign key constraint "${constraint.name}" created\n`);
  }

  /**
   * Execute drop foreign key
   */
  private async executeDropForeignKey(tableName: string, constraintName: string, schema?: string): Promise<void> {
    const qualifiedTableName = this.getQualifiedTableName(tableName, schema);
    this.logger(`  Dropping foreign key constraint "${constraintName}" from ${qualifiedTableName}...`);
    await this.client.query(`ALTER TABLE ${qualifiedTableName} DROP CONSTRAINT "${constraintName}"`);
    this.logger(`  ✓ Foreign key constraint "${constraintName}" dropped\n`);
  }

  /**
   * Get all existing tables in the database across all schemas used by the model
   */
  private async getExistingTables(): Promise<Map<string, true>> {
    // Collect all schemas used by the model
    const schemas = new Set<string>();
    for (const [, schema] of this.schemaRegistry.entries()) {
      schemas.add(schema.schema || 'public');
    }

    const tables = new Map<string, true>();
    for (const schemaName of schemas) {
      const result = await this.client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      `, [schemaName]);

      for (const row of result.rows) {
        // Use composite key for non-public schemas to avoid collisions
        const key = schemaName === 'public' ? row.table_name : `${schemaName}.${row.table_name}`;
        tables.set(key, true);
      }
    }
    return tables;
  }

  /**
   * Get all columns for a table
   */
  private async getExistingColumns(tableName: string, schemaName?: string): Promise<Map<string, DbColumnInfo>> {
    const result = await this.client.query<DbColumnInfo>(`
      SELECT
        column_name,
        data_type,
        udt_name,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_nullable,
        column_default,
        collation_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schemaName || 'public', tableName]);

    const columns = new Map<string, DbColumnInfo>();
    for (const row of result.rows) {
      columns.set(row.column_name, row);
    }
    return columns;
  }

  /**
   * Get all indexes for a table
   */
  private async getExistingIndexes(tableName: string, schemaName?: string): Promise<DbIndexInfo[]> {
    const result = await this.client.query(`
      SELECT
        i.relname as index_name,
        array_agg(a.attname ORDER BY k.ordinality) as column_names
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE
        n.nspname = $1
        AND t.relname = $2
        AND NOT ix.indisprimary
      GROUP BY i.relname
    `, [schemaName || 'public', tableName]);

    return result.rows.map(row => ({
      index_name: row.index_name,
      column_names: row.column_names
    }));
  }

  /**
   * Get all foreign key constraints for a table
   */
  private async getExistingForeignKeys(tableName: string, schemaName?: string): Promise<DbForeignKeyInfo[]> {
    const result = await this.client.query(`
      SELECT
        tc.constraint_name,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as column_names,
        ccu.table_name AS referenced_table,
        array_agg(ccu.column_name ORDER BY kcu.ordinal_position) as referenced_column_names,
        rc.delete_rule as on_delete,
        rc.update_rule as on_update
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE
        tc.table_schema = $1
        AND tc.table_name = $2
        AND tc.constraint_type = 'FOREIGN KEY'
      GROUP BY tc.constraint_name, ccu.table_name, rc.delete_rule, rc.update_rule
    `, [schemaName || 'public', tableName]);

    return result.rows.map(row => ({
      constraint_name: row.constraint_name,
      column_names: row.column_names,
      referenced_table: row.referenced_table,
      referenced_column_names: row.referenced_column_names,
      on_delete: row.on_delete,
      on_update: row.on_update
    }));
  }

  /**
   * Check if a column needs to be altered
   */
  private needsAlter(dbInfo: DbColumnInfo, modelConfig: ColumnConfig): boolean {
    // Compare type - resolve ARRAY/USER-DEFINED via udt_name before normalizing
    const dbType = this.normalizeType(this.resolveDbType(dbInfo));
    const modelType = this.normalizeType(modelConfig.type);
    if (dbType !== modelType) {
      return true;
    }

    // Compare nullability
    const dbNullable = dbInfo.is_nullable === 'YES';
    const modelNullable = modelConfig.nullable;
    if (dbNullable !== modelNullable) {
      return true;
    }

    // Compare collation (only when model specifies one)
    if (modelConfig.collation) {
      if (dbInfo.collation_name !== modelConfig.collation) {
        return true;
      }
    }

    // Compare default (normalize for comparison)
    const dbDefault = this.normalizeDefault(dbInfo.column_default);
    const modelDefault = modelConfig.default !== undefined
      ? this.normalizeDefault(this.formatDefaultValue(modelConfig.default))
      : null;

    if (dbDefault !== modelDefault) {
      return true;
    }

    return false;
  }

  /**
   * Normalize default values for comparison
   */
  private normalizeDefault(value: string | null): string | null {
    if (value === null) return null;

    let normalized = value.toLowerCase().trim();

    // Remove type casts like ::character varying, ::regclass
    normalized = normalized.replace(/::[a-z_]+(\s+varying)?/g, '');

    // Remove function call parentheses for comparison
    normalized = normalized.replace(/\(\)/g, '');

    // Remove single quotes around strings for comparison
    normalized = normalized.replace(/^'(.*)'$/, '$1');

    // Normalize nextval sequences
    if (normalized.includes('nextval')) {
      return 'auto'; // Treat all nextval as equivalent
    }

    return normalized;
  }

  /**
   * Resolve the effective type from database column info.
   * Handles ARRAY and USER-DEFINED types by using udt_name.
   */
  private resolveDbType(dbInfo: DbColumnInfo): string {
    const dataType = dbInfo.data_type;

    // For array types, data_type is 'ARRAY' and udt_name has underscore prefix (e.g. '_int4')
    if (dataType === 'ARRAY' && dbInfo.udt_name) {
      const baseType = dbInfo.udt_name.replace(/^_/, '');
      const resolved = this.udtToSqlType(baseType);
      return `${resolved}[]`;
    }

    // For custom/enum types, data_type is 'USER-DEFINED' and udt_name has the actual type name
    if (dataType === 'USER-DEFINED' && dbInfo.udt_name) {
      return dbInfo.udt_name;
    }

    return dataType;
  }

  /**
   * Map PostgreSQL internal udt names to SQL type names
   */
  private udtToSqlType(udtName: string): string {
    const map: Record<string, string> = {
      'int4': 'integer',
      'int2': 'smallint',
      'int8': 'bigint',
      'float4': 'real',
      'float8': 'double precision',
      'bool': 'boolean',
      'varchar': 'varchar',
      'text': 'text',
      'numeric': 'decimal',
      'timestamptz': 'timestamptz',
      'timestamp': 'timestamp',
    };
    return map[udtName] || udtName;
  }

  /**
   * Normalize PostgreSQL type names for comparison
   */
  private normalizeType(type: string): string {
    const normalized = type.toLowerCase().trim();

    // Handle array types - normalize the base type and preserve []
    if (normalized.endsWith('[]')) {
      const baseType = normalized.slice(0, -2);
      return this.normalizeType(baseType) + '[]';
    }

    // Map common variations
    const typeMap: Record<string, string> = {
      'character varying': 'varchar',
      'character': 'char',
      'integer': 'int',
      'bigint': 'int8',
      'smallint': 'int2',
      'double precision': 'float8',
      'real': 'float4',
      'timestamp without time zone': 'timestamp',
      'timestamp with time zone': 'timestamptz',
      'time without time zone': 'time',
      'time with time zone': 'timetz',
      'serial': 'int',
      'bigserial': 'int8',
      'smallserial': 'int2',
      'numeric': 'decimal',
    };

    return typeMap[normalized] || normalized;
  }

  /**
   * Build type definition for ALTER COLUMN TYPE
   */
  private buildTypeDefinition(config: ColumnConfig): string {
    let type = config.type;
    if (type === 'serial') type = 'integer';
    if (type === 'bigserial') type = 'bigint';
    if (type === 'smallserial') type = 'smallint';

    let def = type;

    if (config.length) {
      def += `(${config.length})`;
    } else if (config.precision && config.scale) {
      def += `(${config.precision}, ${config.scale})`;
    } else if (config.precision) {
      def += `(${config.precision})`;
    }

    return def;
  }

  /**
   * Describe a database column
   */
  private describeDbColumn(col: DbColumnInfo): string {
    let desc = col.data_type;
    if (col.character_maximum_length) {
      desc += `(${col.character_maximum_length})`;
    } else if (col.numeric_precision) {
      desc += `(${col.numeric_precision}${col.numeric_scale ? ',' + col.numeric_scale : ''})`;
    }
    desc += col.is_nullable === 'YES' ? ' NULL' : ' NOT NULL';
    if (col.column_default) {
      desc += ` DEFAULT ${col.column_default}`;
    }
    return desc;
  }

  /**
   * Describe a model column
   */
  private describeModelColumn(config: ColumnConfig): string {
    let desc = config.type;
    if (config.length) {
      desc += `(${config.length})`;
    } else if (config.precision) {
      desc += `(${config.precision}${config.scale ? ',' + config.scale : ''})`;
    }
    desc += config.nullable ? ' NULL' : ' NOT NULL';
    if (config.default !== undefined) {
      desc += ` DEFAULT ${this.formatDefaultValue(config.default)}`;
    }
    return desc;
  }

  /**
   * Describe a migration operation
   */
  private describeOperation(operation: MigrationOperation): string {
    switch (operation.type) {
      case 'create_schema':
        return `Create schema "${operation.schemaName}"`;
      case 'create_collation':
        return `Create collation "${operation.collation.name}" (provider=${operation.collation.provider}, locale=${operation.collation.locale}, deterministic=${operation.collation.deterministic})`;
      case 'create_enum':
        return `Create ENUM type "${operation.enumName}" (${operation.values.join(', ')})`;
      case 'create_sequence':
        const seqName = operation.config.schema
          ? `"${operation.config.schema}"."${operation.config.name}"`
          : `"${operation.config.name}"`;
        return `Create sequence ${seqName}`;
      case 'create_table':
        return `Create table "${operation.tableName}"`;
      case 'drop_table':
        return `Drop table "${operation.tableName}" (DESTRUCTIVE)`;
      case 'add_column':
        return `Add column "${operation.tableName}"."${operation.columnName}" (${this.describeModelColumn(operation.config)})`;
      case 'drop_column':
        return `Drop column "${operation.tableName}"."${operation.columnName}" (DESTRUCTIVE)`;
      case 'alter_column':
        return `Alter column "${operation.tableName}"."${operation.columnName}"`;
      case 'create_index':
        const uniquePrefix = operation.isUnique ? 'unique ' : '';
        const concurrentDesc = operation.concurrent ? ' CONCURRENTLY' : '';
        const usingDesc = operation.using ? ` USING ${operation.using}` : '';
        const idxCols = operation.expressions && operation.expressions.length > 0
          ? operation.expressions.join(', ')
          : operation.columns.join(', ');
        const whereDesc = operation.where ? ` WHERE ${operation.where}` : '';
        return `Create ${uniquePrefix}index${concurrentDesc} "${operation.indexName}" on "${operation.tableName}"${usingDesc} (${idxCols})${whereDesc}`;
      case 'drop_index':
        return `Drop index "${operation.indexName}" (DESTRUCTIVE)`;
      case 'create_foreign_key':
        const fk = operation.constraint;
        let desc = `Create foreign key "${fk.name}" on "${operation.tableName}" (${fk.columns.join(', ')}) references "${fk.referencedTable}" (${fk.referencedColumns.join(', ')})`;
        if (fk.onDelete || fk.onUpdate) {
          const actions = [];
          if (fk.onDelete) actions.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
          if (fk.onUpdate) actions.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
          desc += ` [${actions.join(', ')}]`;
        }
        return desc;
      case 'drop_foreign_key':
        return `Drop foreign key "${operation.constraintName}" (DESTRUCTIVE)`;
    }
  }

  /**
   * Ask user for confirmation (CLI prompt)
   */
  private async confirm(question: string): Promise<boolean> {
    // If not running in a TTY (like in tests), default to NO for destructive operations
    if (!process.stdin.isTTY) {
      this.logger(`\n⚠️  ${question} [y/N]: N (non-interactive mode, defaulting to NO)`, 'warn');
      return false;
    }

    const rl = this.getReadlineInterface();
    return new Promise((resolve) => {
      rl.question(`\n⚠️  ${question} [y/N]: `, (answer) => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }

  /**
   * Format default value for SQL
   * Accepts RawSql to pass through raw SQL without formatting
   */
  private formatDefaultValue(value: any): string {
    if (value === null) return 'NULL';
    // RawSql passes through without any formatting
    if (value instanceof RawSql) return value.value;
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return `'${value.toISOString()}'`;
    return String(value);
  }

  /**
   * Close the schema manager and any open resources
   */
  close(): void {
    if (this.rl) {
      this.rl.close();
    }
  }
}
