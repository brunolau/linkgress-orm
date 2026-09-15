import { Blob } from 'buffer';
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGliteClient } from '../../src';
import type { ClientQueryResult, PooledConnection, QueryExecutionOptions } from '../../src';
import { AppDatabase } from '../../debug/schema/appDatabase';

/**
 * LINKGRESS_TEST_DRIVER=pglite: the suite's "server" is an in-process PGlite.
 *
 * tests/globalSetup.ts builds the AppDatabase schema once and dumps the data directory to a
 * tarball; every test file then boots its own instance from that snapshot (~150 ms, against
 * ~700 ms for an empty initdb before even building the schema). One PGlite per file mirrors
 * jest giving every file its own module registry.
 */

/** Env var through which globalSetup hands the snapshot's path to the test files. */
export const PGLITE_SNAPSHOT_ENV = 'LINKGRESS_TEST_PGLITE_SNAPSHOT';

/**
 * Extensions the suite creates: pg_trgm (trigram GIN indexes) and unaccent (search_normalize
 * support). PGlite can only CREATE EXTENSION what was registered at startup. Loaded with
 * require(): the contrib subpaths resolve through package exports, which this repo's
 * `moduleResolution: node` cannot see at compile time.
 */
export function pgliteTestExtensions(): Record<string, any> {
  const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
  const { unaccent } = require('@electric-sql/pglite/contrib/unaccent');

  return { pg_trgm, unaccent };
}

/**
 * The state every test file starts from: the AppDatabase schema, plus the extensions the suite
 * uses — which a long-lived test server already has from earlier runs.
 */
async function prepareTestDatabase(client: PGliteClient): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await client.query('CREATE EXTENSION IF NOT EXISTS unaccent');

  await new AppDatabase(client, { logQueries: false, logParameters: false, collectionStrategy: 'cte' })
    .getSchemaManager()
    .ensureCreated();
}

/**
 * Build the AppDatabase schema on a fresh PGlite and dump its data directory to a temp
 * tarball; returns the tarball's path.
 */
export async function buildPgliteSnapshot(): Promise<string> {
  const client = new PGliteClient({ extensions: pgliteTestExtensions() });

  try {
    await prepareTestDatabase(client);

    const tarball = await client.getPGlite().dumpDataDir('none');
    const file = join(tmpdir(), `linkgress-pglite-schema-${process.pid}.tar`);
    writeFileSync(file, Buffer.from(await tarball.arrayBuffer()));

    return file;
  } finally {
    await client.end();
  }
}

/**
 * Holds every call until the server's schema is in place. It only ever waits when there was
 * no snapshot to boot from (runners that skip tests/globalSetup.ts).
 */
class GatedPGliteClient extends PGliteClient {
  constructor(pglite: any, private schemaReady: Promise<void>) {
    super(pglite);
  }

  async query<T = any>(sql: string, params?: any[], options?: QueryExecutionOptions): Promise<ClientQueryResult<T>> {
    await this.schemaReady;
    return super.query<T>(sql, params, options);
  }

  async connect(): Promise<PooledConnection> {
    await this.schemaReady;
    return super.connect();
  }

  async transaction<T>(callback: (query: (sql: string, params?: any[], options?: QueryExecutionOptions) => Promise<ClientQueryResult>) => Promise<T>): Promise<T> {
    await this.schemaReady;
    return super.transaction(callback);
  }

  async querySimple<T = any>(sql: string): Promise<ClientQueryResult<T>> {
    await this.schemaReady;
    return super.querySimple<T>(sql);
  }

  async querySimpleMulti(sql: string): Promise<ClientQueryResult[]> {
    await this.schemaReady;
    return super.querySimpleMulti(sql);
  }
}

/**
 * One test file's PGlite "server". `client()` hands out clients that borrow it — their
 * `end()` leaves it running, the way ending one pool leaves a real server up — and `stop()`
 * shuts it down.
 */
export class PgliteTestServer {
  private readonly owner: PGliteClient;
  private readonly schemaReady: Promise<void>;

  constructor() {
    const snapshot = process.env[PGLITE_SNAPSHOT_ENV];

    this.owner = new PGliteClient({
      extensions: pgliteTestExtensions(),
      ...(snapshot ? { loadDataDir: new Blob([readFileSync(snapshot)]) } : {}),
    });

    this.schemaReady = snapshot ? Promise.resolve() : prepareTestDatabase(this.owner);
    // Surfaced through the clients that await it; don't report it as unhandled as well.
    this.schemaReady.catch(() => undefined);
  }

  client(): PGliteClient {
    return new GatedPGliteClient(this.owner.getPGlite(), this.schemaReady);
  }

  async stop(): Promise<void> {
    await this.owner.end();
  }
}
