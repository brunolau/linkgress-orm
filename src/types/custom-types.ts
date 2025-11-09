import { ColumnType } from './column-types';

/**
 * Custom type definition
 * Allows defining custom PostgreSQL types with TypeScript mapping
 */
export interface CustomType<TData = any, TDriver = any> {
  /**
   * PostgreSQL type name
   */
  dataType: string;

  /**
   * Convert TypeScript value to database value
   */
  toDriver(value: TData): TDriver;

  /**
   * Convert database value to TypeScript value
   */
  fromDriver(value: TDriver): TData;
}

/**
 * Custom type builder
 */
export class CustomTypeBuilder<TData = any, TDriver = any> {
  constructor(
    private config: {
      dataType: string;
      toDriver: (value: TData) => TDriver;
      fromDriver: (value: TDriver) => TData;
    }
  ) {}

  /**
   * Gets the custom type definition
   */
  getType(): CustomType<TData, TDriver> {
    return {
      dataType: this.config.dataType,
      toDriver: this.config.toDriver,
      fromDriver: this.config.fromDriver,
    };
  }

  /**
   * Gets the PostgreSQL type name
   */
  get dataType(): string {
    return this.config.dataType;
  }
}

/**
 * Creates a custom type
 */
export function customType<TData = any, TDriver = any>(config: {
  dataType: string;
  toDriver: (value: TData) => TDriver;
  fromDriver: (value: TDriver) => TData;
}): CustomTypeBuilder<TData, TDriver> {
  return new CustomTypeBuilder(config);
}

/**
 * Common custom types
 */

/**
 * JSON type with automatic serialization
 */
export const json = <T = any>() =>
  customType<T, string>({
    dataType: 'jsonb',
    toDriver: (value: T) => JSON.stringify(value),
    fromDriver: (value: string) => JSON.parse(value),
  });

/**
 * Array type
 */
export const array = <T = any>(itemType: string) =>
  customType<T[], string>({
    dataType: `${itemType}[]`,
    toDriver: (value: T[]) => JSON.stringify(value),
    fromDriver: (value: string) => JSON.parse(value),
  });

/**
 * Enum type
 */
export const enumType = <T extends string>(
  enumName: string,
  values: readonly T[]
) =>
  customType<T, string>({
    dataType: enumName,
    toDriver: (value: T) => value,
    fromDriver: (value: string) => value as T,
  });

/**
 * Point type (geometric)
 */
export interface Point {
  x: number;
  y: number;
}

export const point = () =>
  customType<Point, string>({
    dataType: 'point',
    toDriver: (value: Point) => `(${value.x},${value.y})`,
    fromDriver: (value: string) => {
      const match = value.match(/\((-?\d+\.?\d*),(-?\d+\.?\d*)\)/);
      if (!match) throw new Error(`Invalid point format: ${value}`);
      return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
    },
  });

/**
 * Vector type (for pgvector extension)
 */
export const vector = (dimensions: number) =>
  customType<number[], string>({
    dataType: `vector(${dimensions})`,
    toDriver: (value: number[]) => `[${value.join(',')}]`,
    fromDriver: (value: string) => {
      const match = value.match(/\[(.*)\]/);
      if (!match) throw new Error(`Invalid vector format: ${value}`);
      return match[1].split(',').map(parseFloat);
    },
  });

/**
 * Interval type
 */
export interface Interval {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export const interval = () =>
  customType<Interval, string>({
    dataType: 'interval',
    toDriver: (value: Interval) => {
      const parts: string[] = [];
      if (value.years) parts.push(`${value.years} years`);
      if (value.months) parts.push(`${value.months} months`);
      if (value.days) parts.push(`${value.days} days`);
      if (value.hours) parts.push(`${value.hours} hours`);
      if (value.minutes) parts.push(`${value.minutes} minutes`);
      if (value.seconds) parts.push(`${value.seconds} seconds`);
      return parts.join(' ');
    },
    fromDriver: (value: string) => {
      const interval: Interval = {};
      const parts = value.split(' ');
      for (let i = 0; i < parts.length; i += 2) {
        const num = parseFloat(parts[i]);
        const unit = parts[i + 1];
        if (unit.startsWith('year')) interval.years = num;
        else if (unit.startsWith('mon')) interval.months = num;
        else if (unit.startsWith('day')) interval.days = num;
        else if (unit.startsWith('hour')) interval.hours = num;
        else if (unit.startsWith('min')) interval.minutes = num;
        else if (unit.startsWith('sec')) interval.seconds = num;
      }
      return interval;
    },
  });
