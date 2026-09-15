import * as fs from 'fs';
import * as path from 'path';
import { Duplex } from 'stream';
import { MessageChannel, MessagePort, Worker } from 'worker_threads';
import type { InMemoryDatabaseOptions } from '../engine/database';
import type { InMemoryListenOptions } from '../wire/tcp-server';

/**
 * A socket to a database hosted by {@link InMemoryDatabaseThread}: a duplex stream over a
 * MessagePort, usable as pg's `stream` / postgres.js' `socket` exactly like `MemorySocket`.
 */
export class ThreadSocket extends Duplex {
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 5432;
  connecting = false;
  private ended = false;

  constructor(private readonly port: MessagePort) {
    super({ allowHalfOpen: false });
    port.on('close', () => {
      this.ended = true;
      if (!this.destroyed) {
        this.push(null);
        this.destroy();
      }
    });
    port.on('message', (chunk: Uint8Array | null) => {
      if (chunk === null) {
        this.ended = true;
        if (!this.destroyed) {
          this.push(null);
          this.destroy();
        }
        return;
      }
      if (process.env.LINKGRESS_THREAD_TRACE) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('fs').appendFileSync(process.env.LINKGRESS_THREAD_TRACE, `${Date.now()} read ${chunk.byteLength} last=${String.fromCharCode(chunk[chunk.byteLength - 6])} destroyed=${this.destroyed}\n`);
      }
      if (!this.destroyed) {
        this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    });
  }

  get readyState(): string {
    return this.destroyed || this.ended ? 'closed' : 'open';
  }

  connect(): this {
    setImmediate(() => this.emit('connect'));
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setTimeout(): this {
    return this;
  }

  ref(): this {
    this.port.ref();
    return this;
  }

  unref(): this {
    this.port.unref();
    return this;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (process.env.LINKGRESS_THREAD_TRACE) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').appendFileSync(process.env.LINKGRESS_THREAD_TRACE, `${Date.now()} write ${chunk.length} ${String.fromCharCode(chunk[0])} ${chunk.toString('latin1', 5, 60).replace(/[^\x20-\x7e]/g, '.')}\n`);
    }
    const copy = new Uint8Array(chunk.length);
    copy.set(chunk);
    this.port.postMessage(copy, [copy.buffer]);
    callback();
  }

  override _read(): void {
    // data is pushed as the database thread sends it
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.hangUp();
    callback();
    // like a TCP socket closed by the client: the readable side ends too, then 'close' is emitted
    setImmediate(() => {
      if (!this.destroyed) {
        this.push(null);
        this.destroy();
      }
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.hangUp();
    callback(error);
  }

  private hangUp(): void {
    if (!this.ended) {
      this.ended = true;
      try {
        this.port.postMessage(null);
      } catch {
        // port already closed
      }
    }
    this.port.close();
  }
}

export interface InMemoryDatabaseThreadOptions {
  /** restore from this snapshot file (read in the thread on first connection; a missing file means an empty database) */
  snapshotPath?: string;
  /** restore from these snapshot bytes */
  snapshot?: Uint8Array;
  /** options for a new (or restored) database */
  database?: InMemoryDatabaseOptions;
  /** also serve the database over TCP; the endpoint is known when `start` returns */
  listen?: InMemoryListenOptions | boolean;
  /**
   * Host a database per connection `database` name, like a server: each distinct name (after the
   * first matching alias, a regular expression source) is its own database, created from the snapshot
   * on its first connection. Without it every connection uses the one database.
   */
  databasePerName?: { aliases?: { pattern: string; flags?: string; name: string }[] };
}

/**
 * An in-memory database running in its own worker thread.
 *
 * Connections made from this thread behave like connections to a server process: the database keeps
 * serving them (and its TCP endpoint) while this thread is busy — or blocked, e.g. in
 * `child_process.spawnSync` running `psql` against {@link InMemoryDatabaseThread.listener}.
 */
export class InMemoryDatabaseThread {
  /** TCP endpoint, when started with `listen` */
  readonly listener: { host: string; port: number } | null;

  private constructor(
    private readonly worker: Worker,
    private readonly options: InMemoryDatabaseThreadOptions,
    listener: { host: string; port: number } | null
  ) {
    this.listener = listener;
  }

  static start(options: InMemoryDatabaseThreadOptions = {}): InMemoryDatabaseThread {
    const listen = options.listen === true ? {} : options.listen || undefined;
    const listenState = listen ? new SharedArrayBuffer(8) : undefined;
    const workerData = { snapshotPath: options.snapshotPath, snapshot: options.snapshot, options: options.database, databasePerName: options.databasePerName, listen, listenState };
    const compiled = path.join(__dirname, 'database-thread.js');
    const source = path.join(__dirname, 'database-thread.ts');
    const worker = fs.existsSync(compiled)
      ? new Worker(compiled, { workerData })
      : process.versions.bun
        ? // running from TypeScript sources under Bun, which runs them directly
          new Worker(source, { workerData })
        : // running from TypeScript sources under Node: load the entry through ts-node
          new Worker(`require('ts-node/register/transpile-only'); require(${JSON.stringify(source)});`, { eval: true, workerData });
    worker.unref();
    let listener: { host: string; port: number } | null = null;
    if (listen && listenState) {
      // the endpoint is needed synchronously (e.g. to build a connection string before tests load)
      const state = new Int32Array(listenState);
      Atomics.wait(state, 1, 0, 60_000);
      if (Atomics.load(state, 1) !== 1) {
        void worker.terminate();
        throw new Error('in-memory database thread could not open its TCP endpoint');
      }
      listener = { host: listen.host ?? '127.0.0.1', port: Atomics.load(state, 0) };
    }
    return new InMemoryDatabaseThread(worker, options, listener);
  }

  /** A new connection socket to the database. */
  createSocket(): ThreadSocket {
    const { port1, port2 } = new MessageChannel();
    this.worker.postMessage({ type: 'connect', port: port2 }, [port2]);
    return new ThreadSocket(port1);
  }

  /** Merge into a `pg` Pool/Client config: connections go to this database. */
  pgPoolConfig<T extends Record<string, unknown>>(config: T = {} as T): T & { stream: () => ThreadSocket } {
    return {
      host: 'linkgress-memory',
      port: 5432,
      user: this.options.database?.userName ?? 'postgres',
      database: this.options.database?.databaseName ?? 'postgres',
      password: '',
      ...config,
      stream: () => this.createSocket(),
    };
  }

  /** Merge into `postgres(options)`: connections go to this database. */
  postgresOptions<T extends Record<string, unknown>>(options: T = {} as T): T & { socket: () => ThreadSocket } {
    return {
      host: 'linkgress-memory',
      port: 5432,
      user: this.options.database?.userName ?? 'postgres',
      database: this.options.database?.databaseName ?? 'postgres',
      pass: '',
      ...options,
      ssl: false,
      socket: () => this.createSocket(),
    };
  }

  /** Serialize the committed state (of the named database, with `databasePerName`). */
  snapshot(database?: string): Promise<Buffer> {
    return this.request<Uint8Array>('snapshot', { database }).then((bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** Database statistics (row / index counts, thread heap). */
  stats(): Promise<Record<string, number>> {
    return this.request('stats');
  }

  /** Stop the thread (open connections end). */
  async terminate(): Promise<void> {
    await this.worker.terminate();
  }

  private request<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    const { port1, port2 } = new MessageChannel();
    return new Promise<T>((resolve) => {
      port1.once('message', (value: T) => {
        port1.close();
        resolve(value);
      });
      this.worker.postMessage({ type, ...extra, reply: port2 }, [port2]);
    });
  }
}
