import { describe, expect, test } from 'bun:test';
import { sql } from '../../src';
import type { SqlFragment } from '../../src';
import type { ReturningRow } from '../../src/entity/db-context';
import type { DbColumn, UnwrapDbColumns } from '../../src/entity/db-column';
import type { Equals } from '../utils/type-tester';
import { seedTestData, withDatabase } from '../utils/test-database';

/**
 * The types a mutation's RETURNING — and every entity read — resolves to keep a value object as it
 * is, whatever it looks like: `UnwrapDbColumns` tested "is this a navigation entity?" against an EMPTY
 * marker interface, which every object and every function satisfies. A value object no type test
 * recognizes as one (a Temporal type declared only through augmentations — nothing but symbol-keyed
 * methods) was therefore walked as an entity, each of its methods turned into `{}`, and
 * `insert(...).returning(p => ({ at: p.at }))` no longer type-checked against the column's type.
 *
 * The checks are compile-time: this file fails `tsc -p tests/tsconfig.json` when one regresses.
 */

declare const toJsDate: unique symbol;
declare const toWire: unique symbol;

/** A value type known only through symbol-keyed methods. */
interface SymbolOnlyValue {
  [toJsDate](): Date;
  [toWire](): string;
}

/** A value object with string-keyed methods and no `valueOf` of its own. */
interface ValueWithMethods {
  readonly epoch: number;
  plus(minutes: number): ValueWithMethods;
}

type TypeChecks = [
  Equals<ReturningRow<{ id: number; at: SymbolOnlyValue }>['at'], SymbolOnlyValue>,
  Equals<ReturningRow<{ id: DbColumn<number>; at: DbColumn<SymbolOnlyValue> }>['at'], SymbolOnlyValue>,
  Equals<ReturningRow<{ at: DbColumn<ValueWithMethods> }>['at'], ValueWithMethods>,
  Equals<ReturningRow<{ id: DbColumn<number> }>['id'], number>,
  Equals<ReturningRow<{ up: SqlFragment<string> }>['up'], string>,
  Equals<ReturningRow<{ nested: { n: SqlFragment<number>; at: SymbolOnlyValue } }>['nested']['n'], number>,
  Equals<ReturningRow<{ nested: { n: SqlFragment<number>; at: SymbolOnlyValue } }>['nested']['at'], SymbolOnlyValue>,
  Equals<UnwrapDbColumns<{ at: SymbolOnlyValue }>['at'], SymbolOnlyValue>,
  Equals<UnwrapDbColumns<{ at: ValueWithMethods }>['at'], ValueWithMethods>,
  // An optional column still unwraps (the empty marker used to do that by accident)
  Equals<UnwrapDbColumns<{ id: DbColumn<number>; age?: DbColumn<number> }>['age'], number | undefined>,
  Equals<UnwrapDbColumns<{ id: DbColumn<number> }>['id'], number>,
];

const typeChecks: TypeChecks = [true, true, true, true, true, true, true, true, true, true, true];

describe('RETURNING value types', () => {
  test('value objects keep their type; columns, expressions and optional columns unwrap', () => {
    expect(typeChecks.every(Boolean)).toBe(true);
  });

  test('an entity read and a RETURNING read type-check against the column types', async () => {
    await withDatabase(async db => {
      const { users } = await seedTestData(db);

      const inserted = await db.posts.insert({ title: 'typed', userId: users.alice.id, views: 1, customDate: new Date('2024-02-02T00:00:00Z') })
        .returning(p => ({ id: p.id, day: p.customDate, time: p.publishTime, loud: sql<string>`upper(${p.title})` }));
      const day: Date | undefined = inserted.day;
      const loud: string = inserted.loud;

      expect(day).toEqual(new Date('2024-02-02T00:00:00Z'));
      expect(loud).toBe('TYPED');

      const whole = await db.users.insert({ username: 'typed-user', email: 't@x' }).returning();
      const age: number | undefined = whole.age;
      const id: number = whole.id;

      expect(age).toBeNull();
      expect(id).toBeGreaterThan(0);
    });
  });
});
