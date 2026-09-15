/* eslint-disable @typescript-eslint/no-var-requires */
import * as path from 'path';
import { memoryDatabase } from './shared-memory-db';

/**
 * Stand-in for the `pg` module when LINKGRESS_TEST_DB=memory (wired via jest moduleNameMapper):
 * the real node-postgres, with every Pool/Client connecting to the in-memory database.
 */
const realPg = require(path.resolve(__dirname, '../../node_modules/pg/lib/index.js'));

function withMemoryStream(config: unknown): Record<string, unknown> {
  const base = typeof config === 'string' ? { connectionString: config } : ((config as Record<string, unknown>) ?? {});

  return memoryDatabase.pgPoolConfig(base);
}

class Client extends realPg.Client {
  constructor(config?: unknown) {
    super(withMemoryStream(config));
  }
}

class Pool extends realPg.Pool {
  constructor(config?: unknown) {
    super({ ...withMemoryStream(config), Client });
  }
}

module.exports = Object.assign(Object.create(realPg), realPg, { Client, Pool });
module.exports.default = module.exports;
