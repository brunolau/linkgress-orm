import { memoryDatabase } from './shared-memory-db';

/**
 * Stand-in for the `pg` module when LINKGRESS_TEST_DB=memory (installed by tests/setup.ts with
 * `mock.module`): the real node-postgres, with every Pool/Client connecting to the in-memory database.
 */
export function createMemoryPg(realPg: any): any {
  const withMemoryStream = (config: unknown): Record<string, unknown> => {
    const base = typeof config === 'string' ? { connectionString: config } : ((config as Record<string, unknown>) ?? {});

    return memoryDatabase().pgPoolConfig(base);
  };

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

  const memoryPg = Object.assign(Object.create(realPg), realPg, { Client, Pool });
  memoryPg.default = memoryPg;

  return memoryPg;
}
