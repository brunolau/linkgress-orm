const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The SQLSTATE of a database error, whichever client raised it: pg, postgres.js, PGlite and the in-memory
 * engine carry it in `code`; Bun's SQL client puts its own error name in `code` and the SQLSTATE in
 * `errno`. `undefined` for anything that is not a database error.
 * @internal
 */
export function sqlStateOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }

  const { code, errno } = error as { code?: unknown; errno?: unknown };

  if (typeof code === 'string' && SQLSTATE.test(code)) {
    return code;
  }

  return typeof errno === 'string' && SQLSTATE.test(errno) ? errno : undefined;
}
