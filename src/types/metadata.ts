import { ColumnType } from './column-types';

/**
 * Metadata storage key
 */
export const METADATA_KEY = Symbol('linkgress:metadata');

/**
 * Column metadata
 */
export interface ColumnMetadata {
  propertyKey: string;
  columnName: string;
  type: ColumnType;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique: boolean;
  default?: any;
  length?: number;
  precision?: number;
  scale?: number;
}

/**
 * Navigation property types
 */
export enum NavigationType {
  OneToMany = 'OneToMany',
  ManyToOne = 'ManyToOne',
  ManyToMany = 'ManyToMany',
}

/**
 * Navigation property metadata
 */
export interface NavigationMetadata {
  propertyKey: string;
  type: NavigationType;
  targetEntity: () => Function;
  foreignKey?: string;
  inverseSide?: string;
  joinTable?: {
    name: string;
    joinColumn: string;
    inverseJoinColumn: string;
  };
}

/**
 * Table metadata
 */
export interface TableMetadata {
  tableName: string;
  schema?: string;
  columns: Map<string, ColumnMetadata>;
  navigations: Map<string, NavigationMetadata>;
  primaryKeys: string[];
}

/**
 * DbEntity metadata storage
 */
export class MetadataStorage {
  private static tables = new Map<Function, TableMetadata>();

  static getTableMetadata(target: Function): TableMetadata | undefined {
    return this.tables.get(target);
  }

  static setTableMetadata(target: Function, metadata: TableMetadata): void {
    this.tables.set(target, metadata);
  }

  static ensureTableMetadata(target: Function): TableMetadata {
    let metadata = this.tables.get(target);
    if (!metadata) {
      metadata = {
        tableName: target.name,
        columns: new Map(),
        navigations: new Map(),
        primaryKeys: [],
      };
      this.tables.set(target, metadata);
    }
    return metadata;
  }

  static addColumn(target: Function, column: ColumnMetadata): void {
    const metadata = this.ensureTableMetadata(target);
    metadata.columns.set(column.propertyKey, column);
    if (column.primaryKey) {
      metadata.primaryKeys.push(column.propertyKey);
    }
  }

  static addNavigation(target: Function, navigation: NavigationMetadata): void {
    const metadata = this.ensureTableMetadata(target);
    metadata.navigations.set(navigation.propertyKey, navigation);
  }

  static getAllMetadata(): Map<Function, TableMetadata> {
    return this.tables;
  }
}
