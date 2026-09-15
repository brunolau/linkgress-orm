import { Duplex } from 'stream';
import type { Database } from '../engine/database';
import { ServerConnection } from './server-connection';

/**
 * How server output reaches the driver: after the current call stack, never re-entrantly from inside
 * the driver's own write. Node: `setImmediate`, so I/O and timers get their turn between messages.
 * Bun: `process.nextTick` — `bun test` does not wake for immediates queued as a test settles, so each
 * such response waited for the next timer tick (~0.1–0.9 s between tests).
 */
const deliver: (fn: () => void) => void =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? (fn) => process.nextTick(fn) : (fn) => setImmediate(fn);

/**
 * An in-process duplex stream that looks like a TCP socket to PostgreSQL drivers and speaks the
 * frontend/backend protocol with an in-memory database. Usable as pg's `stream` option and as
 * postgres.js' `socket` option, so the real driver code performs all serialization and parsing.
 */
export class MemorySocket extends Duplex {
  private readonly server: ServerConnection;
  private serverClosed = false;
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 5432;
  connecting = false;

  constructor(db: Database) {
    super({ allowHalfOpen: false });
    this.server = new ServerConnection(db, {
      send: (data) => {
        deliver(() => {
          if (!this.destroyed) {
            this.push(data);
          }
        });
      },
      close: () => {
        if (this.serverClosed) {
          return;
        }
        this.serverClosed = true;
        deliver(() => {
          if (!this.destroyed) {
            this.push(null);
            this.destroy();
          }
        });
      },
    });
  }

  get readyState(): string {
    return this.destroyed || this.serverClosed ? 'closed' : 'open';
  }

  connect(): this {
    deliver(() => this.emit('connect'));
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
    return this;
  }

  unref(): this {
    return this;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.server.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  override _read(): void {
    // data is pushed by the server connection
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.server.disconnect();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.server.disconnect();
    callback(error);
  }
}
