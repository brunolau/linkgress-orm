import * as fs from 'fs';
import * as path from 'path';
import { DatabaseContext } from '../entity/db-context';
import { MigrationConfig } from './migration.interface';
import { MigrationLoader } from './migration-loader';
import { MigrationOperation } from './db-schema-manager';
import { TableSchema } from '../schema/table-builder';
import { ColumnConfig } from '../schema/column-builder';
import { SequenceConfig } from '../schema/sequence-builder';
import { RawSql } from '../query/conditions';

/**
 * Generates migration scaffold files from schema differences.
 *
 * The scaffold generator:
 * - Uses DbSchemaManager.analyze() to detect schema differences
 * - Generates TypeScript migration files with up() and down() methods
 * - Creates SQL statements for each detected change
 *
 * @example
 * ```typescript
 * const scaffold = new MigrationScaffold(db, {
 *   migrationsDirectory: './migrations',
 * });
 *
 * // Generate migration from schema diff
 * const result = await scaffold.scaffold('../schema/appDatabase');
 * console.log(`Created: ${result.filename} with ${result.operations} operations`);
 *
 * // Generate empty migration template
 * const empty = await scaffold.scaffoldEmpty();
 * ```
 */
export class MigrationScaffold {
  private loader: MigrationLoader;

  constructor(
    private db: DatabaseContext,
    private config: MigrationConfig
  ) {
    this.loader = new MigrationLoader(config.migrationsDirectory);
  }

  /**
   * Generate SQL for a migration operation (UP direction).
   * Returns an array of statements for operations that need multiple queries.
   */
  private generateUpSql(op: MigrationOperation): string[] {
    switch (op.type) {
      case 'create_schema':
        return [`CREATE SCHEMA IF NOT EXISTS "${op.schemaName}"`];

      case 'create_enum': {
        const enumValues = op.values.map((v: string) => `'${v}'`).join(', ');
        return [`DO $$ BEGIN CREATE TYPE "${op.enumName}" AS ENUM (${enumValues}); EXCEPTION WHEN duplicate_object THEN NULL; END $$`];
      }

      case 'create_sequence':
        return [this.buildCreateSequenceSql(op.config)];

      case 'create_table':
        return this.buildCreateTableSql(op.tableName, op.schema);

      case 'drop_table':
        return [`DROP TABLE IF EXISTS "${op.tableName}" CASCADE`];

      case 'add_column':
        return [this.buildAddColumnSql(op.tableName, op.columnName, op.config, op.schema)];

      case 'drop_column': {
        const qualifiedTable = op.schema
          ? `"${op.schema}"."${op.tableName}"`
          : `"${op.tableName}"`;
        return [`ALTER TABLE ${qualifiedTable} DROP COLUMN IF EXISTS "${op.columnName}"`];
      }

      case 'alter_column':
        return [this.buildAlterColumnSql(op.tableName, op.columnName, op.from, op.to, op.schema)];

      case 'create_index':
        return this.buildCreateIndexSql(
          op.tableName,
          op.indexName,
          op.columns,
          op.isUnique,
          op.schema
        );

      case 'drop_index': {
        const qualifiedIndex = op.schema
          ? `"${op.schema}"."${op.indexName}"`
          : `"${op.indexName}"`;
        return [`DROP INDEX IF EXISTS ${qualifiedIndex}`];
      }

      case 'create_foreign_key':
        return this.buildCreateForeignKeySql(op.tableName, op.constraint, op.schema);

      case 'drop_foreign_key': {
        const fkTable = op.schema
          ? `"${op.schema}"."${op.tableName}"`
          : `"${op.tableName}"`;
        return [`ALTER TABLE ${fkTable} DROP CONSTRAINT IF EXISTS "${op.constraintName}"`];
      }

      default:
        return [`-- Unknown operation: ${(op as any).type}`];
    }
  }

  /**
   * Generate SQL for a migration operation (DOWN direction - reverse).
   */
  private generateDownSql(op: MigrationOperation): string[] {
    switch (op.type) {
      case 'create_schema':
        return [`DROP SCHEMA IF EXISTS "${op.schemaName}" CASCADE`];

      case 'create_enum':
        return [`DROP TYPE IF EXISTS "${op.enumName}" CASCADE`];

      case 'create_sequence': {
        const seqName = op.config.schema
          ? `"${op.config.schema}"."${op.config.name}"`
          : `"${op.config.name}"`;
        return [`DROP SEQUENCE IF EXISTS ${seqName} CASCADE`];
      }

      case 'create_table': {
        const tableName = op.schema?.schema
          ? `"${op.schema.schema}"."${op.tableName}"`
          : `"${op.tableName}"`;
        return [`DROP TABLE IF EXISTS ${tableName} CASCADE`];
      }

      case 'drop_table':
        return [`-- Cannot auto-generate: recreate table "${op.tableName}"`];

      case 'add_column': {
        const addColTable = op.schema
          ? `"${op.schema}"."${op.tableName}"`
          : `"${op.tableName}"`;
        return [`ALTER TABLE ${addColTable} DROP COLUMN IF EXISTS "${op.columnName}"`];
      }

      case 'drop_column':
        return [`-- Cannot auto-generate: recreate column "${op.columnName}" on table "${op.tableName}"`];

      case 'alter_column':
        return [`-- Cannot auto-generate: revert column "${op.columnName}" changes on table "${op.tableName}"`];

      case 'create_index': {
        const idxName = op.schema
          ? `"${op.schema}"."${op.indexName}"`
          : `"${op.indexName}"`;
        return [`DROP INDEX IF EXISTS ${idxName}`];
      }

      case 'drop_index':
        return [`-- Cannot auto-generate: recreate index "${op.indexName}"`];

      case 'create_foreign_key': {
        const fkTable = op.schema
          ? `"${op.schema}"."${op.tableName}"`
          : `"${op.tableName}"`;
        return [`ALTER TABLE ${fkTable} DROP CONSTRAINT IF EXISTS "${op.constraint.name}"`];
      }

      case 'drop_foreign_key':
        return [`-- Cannot auto-generate: recreate foreign key "${op.constraintName}"`];

      default:
        return [`-- Unknown operation reversal: ${(op as any).type}`];
    }
  }

  /**
   * Build CREATE SEQUENCE SQL.
   */
  private buildCreateSequenceSql(config: SequenceConfig): string {
    const name = config.schema
      ? `"${config.schema}"."${config.name}"`
      : `"${config.name}"`;

    let sql = `CREATE SEQUENCE ${name}`;
    const options: string[] = [];

    if (config.startWith !== undefined) options.push(`START WITH ${config.startWith}`);
    if (config.incrementBy !== undefined) options.push(`INCREMENT BY ${config.incrementBy}`);
    if (config.minValue !== undefined) options.push(`MINVALUE ${config.minValue}`);
    if (config.maxValue !== undefined) options.push(`MAXVALUE ${config.maxValue}`);
    if (config.cache !== undefined) options.push(`CACHE ${config.cache}`);
    if (config.cycle) options.push(`CYCLE`);

    if (options.length > 0) sql += ` ${options.join(' ')}`;
    return sql;
  }

  /**
   * Build CREATE TABLE SQL from schema.
   * Returns an array: CREATE TABLE IF NOT EXISTS with PK columns only,
   * followed by ADD COLUMN IF NOT EXISTS for each remaining column.
   */
  private buildCreateTableSql(tableName: string, schema: TableSchema): string[] {
    const qualifiedName = schema.schema
      ? `"${schema.schema}"."${tableName}"`
      : `"${tableName}"`;

    const statements: string[] = [];
    const pkColumnDefs: string[] = [];
    const primaryKeys: string[] = [];
    const nonPkColumns: { name: string; def: string }[] = [];

    for (const [colKey, colBuilder] of Object.entries(schema.columns)) {
      const config = (colBuilder as any).build() as ColumnConfig;
      let def = `"${config.name}" ${config.type}`;

      if (config.length) {
        def += `(${config.length})`;
      } else if (config.precision && config.scale) {
        def += `(${config.precision}, ${config.scale})`;
      } else if (config.precision) {
        def += `(${config.precision})`;
      }

      if (config.identity) {
        def += ' GENERATED ALWAYS AS IDENTITY';
        const seqOptions: string[] = [];
        if (config.identity.startWith !== undefined) {
          seqOptions.push(`START WITH ${config.identity.startWith}`);
        }
        if (config.identity.incrementBy !== undefined) {
          seqOptions.push(`INCREMENT BY ${config.identity.incrementBy}`);
        }
        if (seqOptions.length > 0) def += ` (${seqOptions.join(' ')})`;
      }

      if (!config.nullable) def += ' NOT NULL';
      if (config.unique && !config.primaryKey) def += ' UNIQUE';
      if (config.default !== undefined && !config.identity) {
        def += ` DEFAULT ${this.formatDefault(config.default)}`;
      }

      if (config.primaryKey) {
        pkColumnDefs.push(def);
        primaryKeys.push(`"${config.name}"`);
      } else {
        nonPkColumns.push({ name: config.name, def });
      }
    }

    // CREATE TABLE IF NOT EXISTS with PK columns only
    const createParts = [...pkColumnDefs];
    if (primaryKeys.length > 0) {
      createParts.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
    }
    statements.push(`CREATE TABLE IF NOT EXISTS ${qualifiedName} (\n    ${createParts.join(',\n    ')}\n  )`);

    // ADD COLUMN IF NOT EXISTS for each non-PK column
    for (const col of nonPkColumns) {
      statements.push(`ALTER TABLE ${qualifiedName} ADD COLUMN IF NOT EXISTS ${col.def}`);
    }

    return statements;
  }

  /**
   * Build ADD COLUMN SQL.
   */
  private buildAddColumnSql(
    tableName: string,
    columnName: string,
    config: ColumnConfig,
    schema?: string
  ): string {
    const qualifiedTable = schema
      ? `"${schema}"."${tableName}"`
      : `"${tableName}"`;

    let def = config.type;
    if (config.length) def += `(${config.length})`;
    else if (config.precision && config.scale) def += `(${config.precision}, ${config.scale})`;
    else if (config.precision) def += `(${config.precision})`;

    if (!config.nullable) def += ' NOT NULL';
    if (config.unique) def += ' UNIQUE';
    if (config.default !== undefined) def += ` DEFAULT ${this.formatDefault(config.default)}`;

    return `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS "${columnName}" ${def}`;
  }

  /**
   * Build ALTER COLUMN SQL statements.
   */
  private buildAlterColumnSql(
    tableName: string,
    columnName: string,
    from: any,
    to: ColumnConfig,
    schema?: string
  ): string {
    const qualifiedTable = schema
      ? `"${schema}"."${tableName}"`
      : `"${tableName}"`;

    const statements: string[] = [];

    // Type change - resolve ARRAY/USER-DEFINED via udt_name for proper comparison
    const fromType = this.resolveDbType(from);
    if (fromType !== to.type) {
      statements.push(
        `ALTER TABLE ${qualifiedTable} ALTER COLUMN "${columnName}" TYPE ${to.type}`
      );
    }

    // Nullability change
    const fromNullable = from.is_nullable === 'YES';
    if (fromNullable !== to.nullable) {
      if (to.nullable) {
        statements.push(
          `ALTER TABLE ${qualifiedTable} ALTER COLUMN "${columnName}" DROP NOT NULL`
        );
      } else {
        statements.push(
          `ALTER TABLE ${qualifiedTable} ALTER COLUMN "${columnName}" SET NOT NULL`
        );
      }
    }

    return statements.length > 0 ? statements.join(';\n    ') : `-- No changes for column "${columnName}"`;
  }

  /**
   * Resolve the effective type from database column info.
   * Handles ARRAY and USER-DEFINED types by using udt_name.
   */
  private resolveDbType(dbInfo: any): string {
    const dataType = dbInfo.data_type;

    if (dataType === 'ARRAY' && dbInfo.udt_name) {
      const baseType = dbInfo.udt_name.replace(/^_/, '');
      const udtMap: Record<string, string> = {
        'int4': 'integer', 'int2': 'smallint', 'int8': 'bigint',
        'float4': 'real', 'float8': 'double precision',
        'bool': 'boolean', 'numeric': 'decimal',
      };
      return `${udtMap[baseType] || baseType}[]`;
    }

    if (dataType === 'USER-DEFINED' && dbInfo.udt_name) {
      return dbInfo.udt_name;
    }

    return dataType;
  }

  /**
   * Build CREATE INDEX SQL.
   * Returns [DROP IF EXISTS, CREATE] for idempotency.
   */
  private buildCreateIndexSql(
    tableName: string,
    indexName: string,
    columns: string[],
    isUnique?: boolean,
    schema?: string
  ): string[] {
    const qualifiedTable = schema
      ? `"${schema}"."${tableName}"`
      : `"${tableName}"`;

    const qualifiedIndex = schema
      ? `"${schema}"."${indexName}"`
      : `"${indexName}"`;

    const uniqueStr = isUnique ? 'UNIQUE ' : '';
    const columnList = columns.map(c => `"${c}"`).join(', ');

    return [
      `DROP INDEX IF EXISTS ${qualifiedIndex}`,
      `CREATE ${uniqueStr}INDEX "${indexName}" ON ${qualifiedTable} (${columnList})`
    ];
  }

  /**
   * Build CREATE FOREIGN KEY SQL.
   * Returns [DROP IF EXISTS, ADD CONSTRAINT] for idempotency.
   */
  private buildCreateForeignKeySql(
    tableName: string,
    constraint: any,
    schema?: string
  ): string[] {
    const qualifiedTable = schema
      ? `"${schema}"."${tableName}"`
      : `"${tableName}"`;

    const columnList = constraint.columns.map((c: string) => `"${c}"`).join(', ');
    const refColumnList = constraint.referencedColumns.map((c: string) => `"${c}"`).join(', ');

    let addSql = `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT "${constraint.name}" `;
    addSql += `FOREIGN KEY (${columnList}) REFERENCES "${constraint.referencedTable}" (${refColumnList})`;

    if (constraint.onDelete) addSql += ` ON DELETE ${constraint.onDelete.toUpperCase()}`;
    if (constraint.onUpdate) addSql += ` ON UPDATE ${constraint.onUpdate.toUpperCase()}`;

    return [
      `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT IF EXISTS "${constraint.name}"`,
      addSql
    ];
  }

  /**
   * Format a default value for SQL.
   */
  private formatDefault(value: any): string {
    if (value === null) return 'NULL';
    if (value instanceof RawSql) return value.value;
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return `'${value.toISOString()}'`;
    return String(value);
  }

  /**
   * Generate a migration file from schema differences.
   *
   * Compares the current database state to the DataContext model
   * and generates a migration file with the necessary SQL statements.
   *
   * @param contextImportPath - Optional import path for the DataContext class
   * @returns Information about the generated migration file
   * @throws Error if no schema differences are detected
   */
  async scaffold(contextImportPath?: string): Promise<{
    filename: string;
    path: string;
    operations: number;
  }> {
    // Use DbSchemaManager.analyze() to get differences
    const schemaManager = this.db.getSchemaManager();
    const operations = await schemaManager.analyze();

    if (operations.length === 0) {
      throw new Error('No schema differences detected. Database is in sync with model.');
    }

    // Generate filename
    const filename = this.loader.generateFilename();

    // Build migration file content (flatten since operations can produce multiple statements)
    const upStatements = operations.flatMap(op => this.generateUpSql(op));
    const downStatements = operations.map(op => this.generateDownSql(op)).reverse().flat();

    const content = this.generateMigrationFile(upStatements, downStatements, contextImportPath);

    // Write file
    this.loader.ensureDirectory();
    const filePath = path.join(this.loader.getAbsoluteDirectory(), filename);
    fs.writeFileSync(filePath, content, 'utf-8');

    return {
      filename,
      path: filePath,
      operations: operations.length,
    };
  }

  /**
   * Generate an empty migration file template.
   *
   * @param contextImportPath - Optional import path for the DataContext class
   * @returns Information about the generated migration file
   */
  async scaffoldEmpty(contextImportPath?: string): Promise<{
    filename: string;
    path: string;
  }> {
    const filename = this.loader.generateFilename();
    const content = this.generateEmptyMigrationFile(contextImportPath);

    this.loader.ensureDirectory();
    const filePath = path.join(this.loader.getAbsoluteDirectory(), filename);
    fs.writeFileSync(filePath, content, 'utf-8');

    return { filename, path: filePath };
  }

  /**
   * Generate migration file content with SQL statements.
   */
  private generateMigrationFile(
    upStatements: string[],
    downStatements: string[],
    contextImportPath?: string
  ): string {
    const contextImport = contextImportPath
      ? `import type { AppDatabase } from '${contextImportPath}';`
      : `import type { DbContext } from 'linkgress-orm';`;

    const contextType = contextImportPath ? 'AppDatabase' : 'DbContext';

    return `import type { Migration } from 'linkgress-orm';
${contextImport}

export default class implements Migration {
  async up(db: ${contextType}): Promise<void> {
    // Execute each statement separately for compatibility with all database clients
${upStatements.map(s => `    await db.query(\`${s}\`);`).join('\n')}
  }

  async down(db: ${contextType}): Promise<void> {
    // Execute each statement separately for compatibility with all database clients
${downStatements.map(s => `    await db.query(\`${s}\`);`).join('\n')}
  }
}
`;
  }

  /**
   * Generate an empty migration file template.
   */
  private generateEmptyMigrationFile(contextImportPath?: string): string {
    const contextImport = contextImportPath
      ? `import type { AppDatabase } from '${contextImportPath}';`
      : `import type { DbContext } from 'linkgress-orm';`;

    const contextType = contextImportPath ? 'AppDatabase' : 'DbContext';

    return `import type { Migration } from 'linkgress-orm';
${contextImport}

export default class implements Migration {
  async up(db: ${contextType}): Promise<void> {
    // Add your migration SQL here
    await db.query(\`
      -- Your UP migration SQL
    \`);
  }

  async down(db: ${contextType}): Promise<void> {
    // Add your rollback SQL here
    await db.query(\`
      -- Your DOWN migration SQL
    \`);
  }
}
`;
  }
}
