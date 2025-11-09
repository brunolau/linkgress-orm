import * as readline from 'readline';
import { DatabaseClient } from '../database/database-client.interface';
import { TableSchema } from '../schema/table-builder';
import { ColumnConfig } from '../schema/column-builder';
import { EnumTypeRegistry } from '../types/enum-builder';
import { SequenceConfig } from '../schema/sequence-builder';

/**
 * Database column information from pg
 */
interface DbColumnInfo {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
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
 * Migration operation types
 */
type MigrationOperation =
  | { type: 'create_schema'; schemaName: string }
  | { type: 'create_enum'; enumName: string; values: readonly string[] }
  | { type: 'create_table'; tableName: string; schema: TableSchema }
  | { type: 'drop_table'; tableName: string }
  | { type: 'add_column'; tableName: string; columnName: string; config: ColumnConfig }
  | { type: 'drop_column'; tableName: string; columnName: string }
  | { type: 'alter_column'; tableName: string; columnName: string; from: DbColumnInfo; to: ColumnConfig }
  | { type: 'create_index'; tableName: string; indexName: string; columns: string[] }
  | { type: 'drop_index'; tableName: string; indexName: string }
  | { type: 'create_foreign_key'; tableName: string; constraint: any }
  | { type: 'drop_foreign_key'; tableName: string; constraintName: string };

/**
 * Database schema manager - handles schema creation, deletion, and automatic migrations
 */
export class DbSchemaManager {
  private logQueries: boolean;
  private postMigrationHook?: (client: DatabaseClient) => Promise<void>;
  private sequenceRegistry: Map<string, SequenceConfig>;
  private rl: readline.Interface | null = null;

  constructor(
    private client: DatabaseClient,
    private schemaRegistry: Map<string, TableSchema>,
    options?: {
      logQueries?: boolean;
      postMigrationHook?: (client: DatabaseClient) => Promise<void>;
      sequenceRegistry?: Map<string, SequenceConfig>;
    }
  ) {
    this.logQueries = options?.logQueries ?? false;
    this.postMigrationHook = options?.postMigrationHook;
    this.sequenceRegistry = options?.sequenceRegistry ?? new Map();
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
      console.log('Creating schemas...\n');
    }

    for (const schemaName of schemas) {
      const createSchemaSQL = `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`;

      if (this.logQueries) {
        console.log(`  Creating schema "${schemaName}"...`);
      }
      await this.client.query(createSchemaSQL);
      if (this.logQueries) {
        console.log(`  ✓ Schema "${schemaName}" created\n`);
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
      console.log('Creating ENUM types...\n');
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
          console.log(`  Creating ENUM type "${enumName}"...`);
        }
        await this.client.query(createEnumSQL);
        if (this.logQueries) {
          console.log(`  ✓ ENUM type "${enumName}" created\n`);
        }
      } else if (this.logQueries) {
        console.log(`  ENUM type "${enumName}" already exists, skipping\n`);
      }
    }
  }

  /**
   * Create all sequences registered in the schema
   */
  private async createSequences(): Promise<void> {
    if (this.sequenceRegistry.size === 0) return;

    if (this.logQueries) {
      console.log('Creating sequences...\n');
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
          console.log(`  Creating sequence ${qualifiedName}...`);
        }
        await this.client.query(createSQL);
        if (this.logQueries) {
          console.log(`  ✓ Sequence ${qualifiedName} created\n`);
        }
      } else if (this.logQueries) {
        console.log(`  Sequence ${qualifiedName} already exists, skipping\n`);
      }
    }
  }

  /**
   * Create a single table
   */
  private async createTable(tableName: string, tableSchema: TableSchema): Promise<void> {
    const columnDefs: string[] = [];
    const primaryKeys: string[] = [];

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

    const qualifiedTableName = this.getQualifiedTableName(tableName, tableSchema.schema);
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
        ${columnDefs.join(',\n        ')}
      )
    `;

    if (this.logQueries) {
      console.log(`  Creating table ${qualifiedTableName}...`);
    }
    await this.client.query(createTableSQL);
    if (this.logQueries) {
      console.log(`  ✓ Table ${qualifiedTableName} created\n`);
    }
  }

  /**
   * Create all tables in the database
   */
  async ensureCreated(): Promise<void> {
    if (this.logQueries) {
      console.log('Creating database schema...\n');
    }

    // Create schemas first
    await this.createSchemas();

    // Create enum types
    await this.createEnumTypes();

    // Create sequences
    await this.createSequences();

    // Create tables
    for (const [tableName, tableSchema] of this.schemaRegistry.entries()) {
      await this.createTable(tableName, tableSchema);
    }

    if (this.logQueries) {
      console.log('✓ Database schema created successfully\n');
    }

    // Execute post-migration hook if provided
    if (this.postMigrationHook) {
      if (this.logQueries) {
        console.log('Executing post-migration scripts...\n');
      }
      await this.postMigrationHook(this.client);
      if (this.logQueries) {
        console.log('✓ Post-migration scripts completed\n');
      }
    }
  }

  /**
   * Drop all tables
   */
  async ensureDeleted(): Promise<void> {
    if (this.logQueries) {
      console.log('Dropping database schema...\n');
    }

    for (const [tableName, tableSchema] of this.schemaRegistry.entries()) {
      const qualifiedTableName = this.getQualifiedTableName(tableName, tableSchema.schema);
      if (this.logQueries) {
        console.log(`  Dropping table ${qualifiedTableName}...`);
      }
      await this.client.query(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE`);
      if (this.logQueries) {
        console.log(`  ✓ Table ${qualifiedTableName} dropped\n`);
      }
    }

    // Drop sequences
    if (this.sequenceRegistry.size > 0 && this.logQueries) {
      console.log('Dropping sequences...\n');
    }

    for (const [_, config] of this.sequenceRegistry.entries()) {
      const qualifiedName = config.schema
        ? `"${config.schema}"."${config.name}"`
        : `"${config.name}"`;

      if (this.logQueries) {
        console.log(`  Dropping sequence ${qualifiedName}...`);
      }
      await this.client.query(`DROP SEQUENCE IF EXISTS ${qualifiedName} CASCADE`);
      if (this.logQueries) {
        console.log(`  ✓ Sequence ${qualifiedName} dropped\n`);
      }
    }

    // Drop enum types
    const enums = EnumTypeRegistry.getAll();
    if (enums.size > 0 && this.logQueries) {
      console.log('Dropping ENUM types...\n');
    }

    for (const [enumName, _] of enums.entries()) {
      if (this.logQueries) {
        console.log(`  Dropping ENUM type "${enumName}"...`);
      }
      await this.client.query(`DROP TYPE IF EXISTS "${enumName}" CASCADE`);
      if (this.logQueries) {
        console.log(`  ✓ ENUM type "${enumName}" dropped\n`);
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
      console.log('Dropping schemas...\n');
    }

    for (const schemaName of schemas) {
      if (this.logQueries) {
        console.log(`  Dropping schema "${schemaName}"...`);
      }
      await this.client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      if (this.logQueries) {
        console.log(`  ✓ Schema "${schemaName}" dropped\n`);
      }
    }

    if (this.logQueries) {
      console.log('✓ Database schema dropped successfully\n');
    }
  }

  /**
   * Analyze differences between current DB and model schema
   */
  async analyze(): Promise<MigrationOperation[]> {
    console.log('🔍 Analyzing database schema...\n');

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

    // Get all existing tables
    const existingTables = await this.getExistingTables();
    const modelTables = new Set(this.schemaRegistry.keys());

    // Find tables to create
    for (const [tableName, schema] of this.schemaRegistry.entries()) {
      if (!existingTables.has(tableName)) {
        operations.push({ type: 'create_table', tableName, schema });
      }
    }

    // Compare columns for existing tables
    for (const [tableName, schema] of this.schemaRegistry.entries()) {
      if (existingTables.has(tableName)) {
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
            operations.push({ type: 'add_column', tableName, columnName: colName, config });
          }
        }

        // Find columns to alter
        for (const [colName, dbInfo] of existingColumns.entries()) {
          const modelConfig = modelColumns.get(colName);
          if (modelConfig && this.needsAlter(dbInfo, modelConfig)) {
            operations.push({ type: 'alter_column', tableName, columnName: colName, from: dbInfo, to: modelConfig });
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
              indexName: modelIndex.name,
              columns: modelIndex.columns
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
   */
  async migrate(): Promise<void> {
    try {
      const operations = await this.analyze();

      if (operations.length === 0) {
        console.log('✓ Database schema is already in sync with model\n');
        return;
      }

      console.log(`📋 Found ${operations.length} operations to perform:\n`);

      // Show all operations
      for (let i = 0; i < operations.length; i++) {
        console.log(`${i + 1}. ${this.describeOperation(operations[i])}`);
      }
      console.log('');

      // Execute operations with confirmations for destructive ones
      for (const operation of operations) {
        await this.executeOperation(operation);
      }

      console.log('\n✓ Migration completed successfully\n');

      // Execute post-migration hook if provided
      if (this.postMigrationHook) {
        if (this.logQueries) {
          console.log('Executing post-migration scripts...\n');
        }
        await this.postMigrationHook(this.client);
        if (this.logQueries) {
          console.log('✓ Post-migration scripts completed\n');
        }
      }
    } finally {
      this.closeReadlineInterface();
    }
  }

  /**
   * Execute a single migration operation
   */
  private async executeOperation(operation: MigrationOperation): Promise<void> {
    switch (operation.type) {
      case 'create_schema':
        await this.executeCreateSchema(operation.schemaName);
        break;

      case 'create_enum':
        await this.executeCreateEnum(operation.enumName, operation.values);
        break;

      case 'create_table':
        await this.createTable(operation.tableName, operation.schema);
        break;

      case 'drop_table':
        if (await this.confirm(`Drop table "${operation.tableName}"? This will DELETE ALL DATA in the table.`)) {
          await this.executeDropTable(operation.tableName);
        } else {
          console.log(`  ⊘ Skipped dropping table "${operation.tableName}"\n`);
        }
        break;

      case 'add_column':
        await this.executeAddColumn(operation.tableName, operation.columnName, operation.config);
        break;

      case 'drop_column':
        if (await this.confirm(`Drop column "${operation.tableName}"."${operation.columnName}"? This will DELETE ALL DATA in the column.`)) {
          await this.executeDropColumn(operation.tableName, operation.columnName);
        } else {
          console.log(`  ⊘ Skipped dropping column "${operation.tableName}"."${operation.columnName}"\n`);
        }
        break;

      case 'alter_column':
        await this.executeAlterColumn(operation.tableName, operation.columnName, operation.from, operation.to);
        break;

      case 'create_index':
        await this.executeCreateIndex(operation.tableName, operation.indexName, operation.columns);
        break;

      case 'drop_index':
        if (await this.confirm(`Drop index "${operation.indexName}"?`)) {
          await this.executeDropIndex(operation.indexName);
        } else {
          console.log(`  ⊘ Skipped dropping index "${operation.indexName}"\n`);
        }
        break;

      case 'create_foreign_key':
        await this.executeCreateForeignKey(operation.tableName, operation.constraint);
        break;

      case 'drop_foreign_key':
        if (await this.confirm(`Drop foreign key "${operation.constraintName}"?`)) {
          await this.executeDropForeignKey(operation.tableName, operation.constraintName);
        } else {
          console.log(`  ⊘ Skipped dropping foreign key "${operation.constraintName}"\n`);
        }
        break;
    }
  }

  /**
   * Execute create schema
   */
  private async executeCreateSchema(schemaName: string): Promise<void> {
    console.log(`  Creating schema "${schemaName}"...`);
    await this.client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    console.log(`  ✓ Schema "${schemaName}" created\n`);
  }

  /**
   * Execute create enum
   */
  private async executeCreateEnum(enumName: string, values: readonly string[]): Promise<void> {
    console.log(`  Creating ENUM type "${enumName}"...`);
    const valueList = values.map(v => `'${v}'`).join(', ');
    await this.client.query(`CREATE TYPE "${enumName}" AS ENUM (${valueList})`);
    console.log(`  ✓ ENUM type "${enumName}" created\n`);
  }

  /**
   * Execute drop table
   */
  private async executeDropTable(tableName: string): Promise<void> {
    console.log(`  Dropping table "${tableName}"...`);
    await this.client.query(`DROP TABLE "${tableName}" CASCADE`);
    console.log(`  ✓ Table "${tableName}" dropped\n`);
  }

  /**
   * Execute add column
   */
  private async executeAddColumn(tableName: string, columnName: string, config: ColumnConfig): Promise<void> {
    console.log(`  Adding column "${tableName}"."${columnName}"...`);

    let def = `${config.type}`;

    if (config.length) {
      def += `(${config.length})`;
    } else if (config.precision && config.scale) {
      def += `(${config.precision}, ${config.scale})`;
    } else if (config.precision) {
      def += `(${config.precision})`;
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

    const sql = `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${def}`;
    await this.client.query(sql);
    console.log(`  ✓ Column "${tableName}"."${columnName}" added\n`);
  }

  /**
   * Execute drop column
   */
  private async executeDropColumn(tableName: string, columnName: string): Promise<void> {
    console.log(`  Dropping column "${tableName}"."${columnName}"...`);
    await this.client.query(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`);
    console.log(`  ✓ Column "${tableName}"."${columnName}" dropped\n`);
  }

  /**
   * Execute alter column
   */
  private async executeAlterColumn(tableName: string, columnName: string, from: DbColumnInfo, to: ColumnConfig): Promise<void> {
    console.log(`  Altering column "${tableName}"."${columnName}"...`);
    console.log(`    From: ${this.describeDbColumn(from)}`);
    console.log(`    To:   ${this.describeModelColumn(to)}`);

    // PostgreSQL requires separate ALTER COLUMN commands for different changes

    // Change type if needed
    const fromType = this.normalizeType(from.data_type);
    const toType = this.normalizeType(to.type);
    if (fromType !== toType) {
      const typeDef = this.buildTypeDefinition(to);
      await this.client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${typeDef} USING "${columnName}"::${typeDef}`);
      console.log(`    ✓ Type changed from ${fromType} to ${toType}`);
    }

    // Change nullability if needed
    const fromNullable = from.is_nullable === 'YES';
    const toNullable = to.nullable;
    if (fromNullable !== toNullable) {
      if (toNullable) {
        await this.client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP NOT NULL`);
        console.log(`    ✓ Nullability changed to NULLABLE`);
      } else {
        await this.client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET NOT NULL`);
        console.log(`    ✓ Nullability changed to NOT NULL`);
      }
    }

    // Change default if needed
    const fromDefault = from.column_default;
    const toDefault = to.default !== undefined ? this.formatDefaultValue(to.default) : null;
    if (fromDefault !== toDefault) {
      if (toDefault !== null) {
        await this.client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET DEFAULT ${toDefault}`);
        console.log(`    ✓ Default changed to ${toDefault}`);
      } else {
        await this.client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP DEFAULT`);
        console.log(`    ✓ Default removed`);
      }
    }

    console.log(`  ✓ Column "${tableName}"."${columnName}" altered\n`);
  }

  /**
   * Execute create index
   */
  private async executeCreateIndex(tableName: string, indexName: string, columns: string[]): Promise<void> {
    console.log(`  Creating index "${indexName}" on "${tableName}"...`);

    const columnList = columns.map(col => `"${col}"`).join(', ');
    const sql = `CREATE INDEX "${indexName}" ON "${tableName}" (${columnList})`;

    await this.client.query(sql);
    console.log(`  ✓ Index "${indexName}" created\n`);
  }

  /**
   * Execute drop index
   */
  private async executeDropIndex(indexName: string): Promise<void> {
    console.log(`  Dropping index "${indexName}"...`);
    await this.client.query(`DROP INDEX "${indexName}"`);
    console.log(`  ✓ Index "${indexName}" dropped\n`);
  }

  /**
   * Execute create foreign key
   */
  private async executeCreateForeignKey(tableName: string, constraint: any): Promise<void> {
    console.log(`  Creating foreign key constraint "${constraint.name}" on "${tableName}"...`);

    const columnList = constraint.columns.map((col: string) => `"${col}"`).join(', ');
    const refColumnList = constraint.referencedColumns.map((col: string) => `"${col}"`).join(', ');

    let sql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraint.name}" `;
    sql += `FOREIGN KEY (${columnList}) `;
    sql += `REFERENCES "${constraint.referencedTable}" (${refColumnList})`;

    if (constraint.onDelete) {
      sql += ` ON DELETE ${constraint.onDelete.toUpperCase()}`;
    }

    if (constraint.onUpdate) {
      sql += ` ON UPDATE ${constraint.onUpdate.toUpperCase()}`;
    }

    await this.client.query(sql);
    console.log(`  ✓ Foreign key constraint "${constraint.name}" created\n`);
  }

  /**
   * Execute drop foreign key
   */
  private async executeDropForeignKey(tableName: string, constraintName: string): Promise<void> {
    console.log(`  Dropping foreign key constraint "${constraintName}"...`);
    await this.client.query(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}"`);
    console.log(`  ✓ Foreign key constraint "${constraintName}" dropped\n`);
  }

  /**
   * Get all existing tables in the database
   */
  private async getExistingTables(): Promise<Map<string, true>> {
    const result = await this.client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);

    const tables = new Map<string, true>();
    for (const row of result.rows) {
      tables.set(row.table_name, true);
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
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_nullable,
        column_default
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
        AND NOT ix.indisunique
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
    // Compare type
    const dbType = this.normalizeType(dbInfo.data_type);
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
   * Normalize PostgreSQL type names for comparison
   */
  private normalizeType(type: string): string {
    const normalized = type.toLowerCase().trim();

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
      case 'create_enum':
        return `Create ENUM type "${operation.enumName}" (${operation.values.join(', ')})`;
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
        return `Create index "${operation.indexName}" on "${operation.tableName}" (${operation.columns.join(', ')})`;
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
      console.log(`\n⚠️  ${question} [y/N]: N (non-interactive mode, defaulting to NO)`);
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
   */
  private formatDefaultValue(value: any): string {
    if (value === null) return 'NULL';
    if (typeof value === 'string') {
      // Check if it's a SQL function
      if (value.toUpperCase().includes('NOW()') || value.toUpperCase().includes('CURRENT_')) {
        return value;
      }
      return `'${value}'`;
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
