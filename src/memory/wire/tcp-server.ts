import * as net from 'net';
import type { Database } from '../engine/database';
import { DatabaseResolver, ServerConnection } from './server-connection';

export interface InMemoryListenOptions {
  /** TCP port; 0 (default) picks a free one */
  port?: number;
  /** interface to bind; defaults to the loopback interface */
  host?: string;
}

/** A TCP endpoint serving an in-memory database to other processes (psql, child servers, ...). */
export interface InMemoryDatabaseListener {
  readonly host: string;
  readonly port: number;
  /** A `postgresql://` connection string for this endpoint. */
  connectionString(database?: string): string;
  /** Stop accepting connections and close the open ones. */
  close(): Promise<void>;
}

/**
 * Accept PostgreSQL wire-protocol connections on a TCP port. Every connection is a session of the
 * database `getDatabase` returns (called on the first connection, so the listener can be opened
 * before the database is built).
 */
export function listenTcp(
  getDatabase: () => Database | DatabaseResolver,
  userName: () => string,
  databaseName: () => string,
  options: InMemoryListenOptions = {}
): Promise<InMemoryDatabaseListener> {
  const host = options.host ?? '127.0.0.1';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let connection: ServerConnection;
    try {
      connection = new ServerConnection(getDatabase(), {
        send: (data) => {
          if (!socket.destroyed) {
            socket.write(data);
          }
        },
        close: () => {
          if (!socket.destroyed) {
            socket.end();
          }
        },
      });
    } catch {
      socket.destroy();
      return;
    }
    socket.on('data', (chunk: Buffer) => connection.receive(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      connection.disconnect();
    });
  });
  // never keep the process alive just for this endpoint
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      const address = server.address() as net.AddressInfo;
      resolve({
        host,
        port: address.port,
        connectionString: (database?: string) =>
          `postgresql://${encodeURIComponent(userName())}@${host.includes(':') ? `[${host}]` : host}:${address.port}/${encodeURIComponent(database ?? databaseName())}`,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) {
              s.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}
