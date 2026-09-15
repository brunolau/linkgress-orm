/* eslint-disable @typescript-eslint/no-var-requires */
import * as path from 'path';
import { memoryDatabase } from './shared-memory-db';

/**
 * Stand-in for the `postgres` module when LINKGRESS_TEST_DB=memory (wired via jest
 * moduleNameMapper): the real postgres.js, with every connection going to the in-memory database.
 */
const realPostgres = require(path.resolve(__dirname, '../../node_modules/postgres/cjs/src/index.js'));

function postgres(a?: unknown, b?: unknown) {
  if (typeof a === 'string') {
    return realPostgres(a, memoryDatabase.postgresOptions((b as Record<string, unknown>) ?? {}));
  }

  return realPostgres(memoryDatabase.postgresOptions((a as Record<string, unknown>) ?? {}));
}

Object.assign(postgres, realPostgres);

module.exports = postgres;
module.exports.default = postgres;
