/**
 * Type testing utilities for compile-time type assertions
 *
 * These types allow you to verify type inference at compile time.
 * If types don't match, TypeScript will produce a compile error.
 */

/**
 * Checks if two types are exactly equal (not just assignable)
 * Returns `true` if types are equal, `never` otherwise
 */
export type Equals<T, U> =
  (<G>() => G extends T ? 1 : 2) extends (<G>() => G extends U ? 1 : 2) ? true : never;

/**
 * Forbids `unknown` type - returns `never` if T is `unknown`
 */
export type NotUnknown<T> = unknown extends T ? (T extends unknown ? ([T] extends [never] ? T : never) : T) : T;

/**
 * Combined type check: Asserts T equals Expected AND T is not unknown
 * Usage: const x: AssertType<typeof value, ExpectedType> = value;
 *
 * This will fail compilation if:
 * 1. typeof value is `unknown`
 * 2. typeof value doesn't exactly match ExpectedType
 *
 * @example
 * const s: string = 'test';
 * const check: AssertType<typeof s, string> = s; //  compiles
 *
 * const u: unknown = 'test';
 * const check2: AssertType<typeof u, string> = u; //  compile error - unknown not allowed
 *
 * const n: number = 42;
 * const check3: AssertType<typeof n, string> = n; //  compile error - number !== string
 */
export type AssertType<T, Expected> =
  unknown extends T
    ? never  // Forbid unknown
    : Equals<T, Expected> extends true
      ? T
      : never;

/**
 * Simpler version that just checks assignability (not strict equality)
 * and forbids unknown
 *
 * @example
 * const s: string = 'test';
 * const check: TypeIs<typeof s, string> = s; //  compiles
 */
export type TypeIs<T, Expected> =
  unknown extends T
    ? never
    : T extends Expected
      ? T
      : never;

/**
 * One-liner assertion function - use in tests
 * Just call it and if types don't match, compilation fails
 *
 * @example
 * assertType<string, typeof myValue>(myValue);
 */
export function assertType<Expected, T extends Expected>(value: NotUnknown<T>): T {
  return value;
}
