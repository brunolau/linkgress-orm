/**
 * Runner-agnostic replacement for `await expect(promise).rejects.toThrow(match)`.
 *
 * Under bun:test (verified on Bun 1.3.14), `expect(...).rejects` on a
 * DB-backed promise never settles: the test times out and the remaining tests
 * in the same file never run. A plain awaited try/catch behaves correctly
 * under both jest and bun:test, so the suite standardizes on this helper for
 * rejection assertions.
 *
 * Matching semantics mirror `.toThrow`: a string matches as substring, a
 * RegExp via `.test()`, and no matcher asserts any rejection. The thrown
 * error is returned for further assertions.
 */
export async function expectToReject(
  promiseOrFn: PromiseLike<unknown> | (() => PromiseLike<unknown>),
  match?: string | RegExp
): Promise<any> {
  let thrown: unknown;
  let resolved = false;

  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    resolved = true;
  } catch (error) {
    thrown = error;
  }

  if (resolved) {
    throw new Error(`Expected promise to reject${match ? ` with ${String(match)}` : ''}, but it resolved`);
  }

  const error = thrown as any;
  const message = error && typeof error.message === 'string' ? error.message : String(error);

  if (typeof match === 'string' && !message.includes(match)) {
    throw new Error(`Expected rejection message to include "${match}", got "${message}"`);
  }

  if (match instanceof RegExp && !match.test(message)) {
    throw new Error(`Expected rejection message to match ${match}, got "${message}"`);
  }

  return error;
}
