import { describe, test, expect, jest, mock } from 'bun:test';

// Mock result sets faithful to real Bun.SQL shapes: a result set is a REAL
// array of row objects carrying `command` and `count` properties (verified
// against Bun 1.3.14 — see debug/bun-sql-binary-array-repro.ts probes).
const makeResultSet = (rows: any[], command: string): any => {
  const resultSet: any = [...rows];
  resultSet.command = command;
  resultSet.count = rows.length;
  return resultSet;
};

const mockResult = makeResultSet([
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
], 'SELECT');

const mockEmptyResult = makeResultSet([], 'SELECT');

const mockInsertResult = makeResultSet([{ id: 3, name: 'Charlie' }], 'INSERT');

// Create mock SQL instance
const createMockSql = () => {
  const mockReserved = {
    unsafe: jest.fn<any>().mockResolvedValue(mockResult as any),
    release: jest.fn<any>(),
  };

  const mockSql: any = jest.fn<any>();
  mockSql.unsafe = jest.fn<any>().mockImplementation((_sql: string, _params?: any[]) => {
    // Return a thenable that also has .simple()
    const result = Promise.resolve(mockResult) as any;
    result.simple = jest.fn<any>().mockResolvedValue([mockResult, mockInsertResult] as any);
    return result;
  });
  mockSql.close = jest.fn<any>().mockResolvedValue(undefined as any);
  mockSql.reserve = jest.fn<any>().mockResolvedValue(mockReserved as any);
  mockSql.begin = jest.fn<any>().mockImplementation(async (callback: Function) => {
    const txSql: any = {};
    txSql.unsafe = jest.fn<any>().mockResolvedValue(mockInsertResult as any);
    return await callback(txSql);
  });

  return { mockSql, mockReserved };
};

// Mock the require for bun:sql
mock.module('bun:sql', () => {
  return {
    SQL: jest.fn<any>().mockImplementation((_config: any) => {
      const { mockSql } = createMockSql();
      return mockSql;
    }),
  };
});

// Import after mocking
import { BunClient } from '../../src/database/bun-client';
import { TransactionalClient } from '../../src/database/database-client.interface';

describe('BunClient', () => {
  describe('constructor', () => {
    test('should accept an existing SQL instance', () => {
      const { mockSql } = createMockSql();

      // Pass the mock SQL instance directly
      const client = new BunClient(mockSql);

      expect(client.getDriverName()).toBe('bun');
      expect(client.getSql()).toBe(mockSql);
    });

    test('should detect if value is a Bun SQL instance', () => {
      const { mockSql } = createMockSql();

      // A valid Bun SQL instance has unsafe() and close() methods
      expect(mockSql.unsafe).toBeDefined();
      expect(mockSql.close).toBeDefined();

      // BunClient should accept it
      const client = new BunClient(mockSql);
      expect(client).toBeDefined();
    });
  });

  describe('query', () => {
    test('should execute query with parameters using sql.unsafe()', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.query('SELECT * FROM users WHERE id = $1', [1]);

      // Bun SQL uses .unsafe() for parameterized dynamic SQL strings
      expect(mockSql.unsafe).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ id: 1, name: 'Alice' });
      expect(result.rows[1]).toEqual({ id: 2, name: 'Bob' });
      expect(result.rowCount).toBe(2);
    });

    test('should execute query without parameters', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.query('SELECT * FROM users');

      expect(mockSql.unsafe).toHaveBeenCalledWith('SELECT * FROM users', []);
      expect(result.rows).toHaveLength(2);
    });

    test('should handle empty result', async () => {
      const { mockSql } = createMockSql();
      mockSql.unsafe = jest.fn<any>().mockResolvedValue(mockEmptyResult as any);
      const client = new BunClient(mockSql);

      const result = await client.query('SELECT * FROM users WHERE id = $1', [999]);

      expect(result.rows).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });
  });

  describe('connect', () => {
    test('should return a pooled connection using reserve()', async () => {
      const { mockSql, mockReserved } = createMockSql();
      const client = new BunClient(mockSql);

      const connection = await client.connect();

      expect(mockSql.reserve).toHaveBeenCalled();
      expect(connection).toBeDefined();

      // Test query on pooled connection
      const result = await connection.query('SELECT 1');
      expect(mockReserved.unsafe).toHaveBeenCalled();
      expect(result.rows).toHaveLength(2);
    });

    test('should release connection', async () => {
      const { mockSql, mockReserved } = createMockSql();
      const client = new BunClient(mockSql);

      const connection = await client.connect();
      connection.release();

      expect(mockReserved.release).toHaveBeenCalled();
    });
  });

  describe('end', () => {
    test('should not close connection when not owning it', async () => {
      const { mockSql } = createMockSql();
      // When passing an existing SQL instance, ownsConnection is false
      const client = new BunClient(mockSql);

      await client.end();

      // Should NOT close because we don't own the connection
      expect(mockSql.close).not.toHaveBeenCalled();
    });
  });

  describe('transaction', () => {
    test('should execute callback within transaction using sql.begin()', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.transaction(async (query) => {
        const insertResult = await query('INSERT INTO users (name) VALUES ($1) RETURNING *', ['Charlie']);
        return insertResult.rows[0];
      });

      expect(mockSql.begin).toHaveBeenCalled();
      expect(result).toEqual({ id: 3, name: 'Charlie' });
    });

    test('should pass query function to callback', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      await client.transaction(async (query) => {
        const result = await query('SELECT 1');
        expect(result.rows).toBeDefined();
        expect(result.rowCount).toBeDefined();
        return result;
      });
    });
  });

  describe('getDriverName', () => {
    test('should return "bun"', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.getDriverName()).toBe('bun');
    });
  });

  describe('supportsMultiStatementQueries', () => {
    test('should return true', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.supportsMultiStatementQueries()).toBe(true);
    });
  });

  describe('supportsBinaryProtocol', () => {
    test('should return false (uses binary internally but no explicit control)', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.supportsBinaryProtocol()).toBe(false);
    });
  });

  describe('querySimple', () => {
    test('should execute multi-statement query using .simple()', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const result = await client.querySimple('SELECT 1; SELECT 2;');

      // Should return the last result set
      expect(result.rows).toBeDefined();
    });
  });

  describe('querySimpleMulti', () => {
    test('should return all result sets', async () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      const results = await client.querySimpleMulti('SELECT 1; SELECT 2;');

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      results.forEach(result => {
        expect(result.rows).toBeDefined();
        expect(result.rowCount).toBeDefined();
      });
    });
  });

  describe('getSql', () => {
    test('should return underlying SQL instance', () => {
      const { mockSql } = createMockSql();
      const client = new BunClient(mockSql);

      expect(client.getSql()).toBe(mockSql);
    });
  });
});

describe('BunClient integration patterns', () => {
  test('should work with typical ORM usage pattern', async () => {
    const { mockSql } = createMockSql();
    const client = new BunClient(mockSql);

    // Simulate typical ORM operations

    // 1. Simple select
    const users = await client.query('SELECT * FROM users');
    expect(users.rows.length).toBeGreaterThan(0);

    // 2. Insert with returning
    mockSql.unsafe = jest.fn<any>().mockResolvedValue(mockInsertResult as any);
    const inserted = await client.query(
      'INSERT INTO users (name) VALUES ($1) RETURNING *',
      ['NewUser']
    );
    expect(inserted.rows[0]).toHaveProperty('id');

    // 3. Transaction
    const txResult = await client.transaction(async (query) => {
      await query('INSERT INTO orders (user_id) VALUES ($1)', [1]);
      await query('UPDATE users SET order_count = order_count + 1 WHERE id = $1', [1]);
      return { success: true };
    });
    expect(txResult).toEqual({ success: true });

    // 4. Cleanup
    await client.end();
  });

  test('should handle connection pooling pattern', async () => {
    const { mockSql, mockReserved } = createMockSql();
    const client = new BunClient(mockSql);

    // Get a dedicated connection
    const conn = await client.connect();

    // Use it for multiple queries
    await conn.query('BEGIN');
    await conn.query('INSERT INTO users (name) VALUES ($1)', ['Test']);
    await conn.query('COMMIT');

    // Release back to pool
    conn.release();

    expect(mockReserved.release).toHaveBeenCalled();
  });
});

describe('BunSqlOptions type', () => {
  test('should accept various configuration options', () => {
    // This is a compile-time type test
    const postgresConfig = {
      hostname: 'localhost',
      port: 5432,
      database: 'mydb',
      username: 'user',
      password: 'pass',
      max: 20,
      idleTimeout: 30,
    };

    const mysqlConfig = {
      adapter: 'mysql' as const,
      hostname: 'localhost',
      port: 3306,
      database: 'mydb',
      username: 'user',
      password: 'pass',
    };

    const sqliteConfig = {
      adapter: 'sqlite' as const,
      filename: ':memory:',
      readonly: false,
      create: true,
    };

    // Type checks pass if this compiles
    expect(postgresConfig.hostname).toBe('localhost');
    expect(mysqlConfig.adapter).toBe('mysql');
    expect(sqliteConfig.filename).toBe(':memory:');
  });
});

/**
 * The parameters BunClient hands Bun (see normalizeParam in bun-client.ts): a Date as its ISO
 * instant in both modes (Bun sends Date.prototype.toString() wherever the server does not describe
 * a timestamp, and everywhere in text mode); in text mode, plain objects and arrays as JSON text,
 * bytes and value classes (a toString() of their own) left to Bun.
 */
describe('BunClient parameter normalization', () => {
  /** A client in the given mode whose statements a mock captures. */
  const clientCapturing = (textMode: boolean): { client: BunClient; sent: () => any[] } => {
    const { mockSql } = createMockSql();
    // prepare: false is only known from an options object; Bun's SQL connects lazily, so none opens here
    const client = textMode ? new BunClient({ hostname: '127.0.0.1', port: 1, prepare: false }) : new BunClient(mockSql);
    (client as any).sql = mockSql;

    return { client, sent: () => mockSql.unsafe.mock.calls[0][1] };
  };

  class Money {
    constructor(private readonly cents: number) {}

    toString(): string {
      return (this.cents / 100).toFixed(2);
    }
  }

  test.each([false, true])('a Date is sent as its ISO instant (text mode: %p)', async (textMode) => {
    const { client, sent } = clientCapturing(textMode);
    await client.query('SELECT $1', [new Date('2024-03-10T23:30:00.000Z')]);

    expect(sent()).toEqual(['2024-03-10T23:30:00.000Z']);
  });

  test.each([false, true])('an invalid Date is left to fail in the driver (text mode: %p)', async (textMode) => {
    const { client, sent } = clientCapturing(textMode);
    const invalid = new Date('not a date');
    await client.query('SELECT $1', [invalid]);

    expect(sent()[0]).toBe(invalid);
  });

  test('text mode: a plain object and an array are sent as JSON text', async () => {
    const { client, sent } = clientCapturing(true);
    await client.query('SELECT $1, $2', [{ a: 1 }, [1, 'x']]);

    expect(sent()).toEqual(['{"a":1}', '[1,"x"]']);
  });

  test('text mode: bytes are left to Bun', async () => {
    const { client, sent } = clientCapturing(true);
    const bytes = new Uint8Array([1, 2, 255]);
    const buffer = Buffer.from([3]);
    const arrayBuffer = new Uint8Array([4]).buffer;
    await client.query('SELECT $1, $2, $3', [bytes, buffer, arrayBuffer]);

    expect(sent()[0]).toBe(bytes);
    expect(sent()[1]).toBe(buffer);
    expect(sent()[2]).toBe(arrayBuffer);
  });

  test('text mode: a value class with a toString() of its own is left to Bun', async () => {
    const { client, sent } = clientCapturing(true);
    const money = new Money(1999);
    await client.query('SELECT $1', [money]);

    expect(sent()[0]).toBe(money);
  });

  test('prepared mode: objects and arrays are left to Bun (it serializes jsonb itself)', async () => {
    const { client, sent } = clientCapturing(false);
    const payload = { a: 1 };
    const list = [1, 2];
    await client.query('SELECT $1, $2', [payload, list]);

    expect(sent()[0]).toBe(payload);
    expect(sent()[1]).toBe(list);
  });

  test.each([false, true])('a parameter list with nothing to change is passed as it is (text mode: %p)', async (textMode) => {
    const { client, sent } = clientCapturing(textMode);
    const params = [1, 'a', null, true, 9007199254740993n];
    await client.query('SELECT $1, $2, $3, $4, $5', params);

    expect(sent()).toBe(params);
  });

  test('prepared mode: typed-array result values read as plain arrays; bytes stay bytes', async () => {
    const { mockSql } = createMockSql();
    const bytes = new Uint8Array([1, 2]);
    mockSql.unsafe = jest.fn<any>().mockResolvedValue(makeResultSet([
      { i4: null, f4: new Float32Array([1.5]), i8: new BigInt64Array([9007199254740993n]), bytes, text: ['a'] },
      { i4: new Int32Array([1, 2]), f4: null, i8: null, bytes: null, text: null },
    ], 'SELECT') as any);
    const client = new BunClient(mockSql);

    const { rows } = await client.query('SELECT 1');

    // a column NULL in the first row is still found from a later one
    expect(rows[1].i4).toEqual([1, 2]);
    expect(Array.isArray(rows[1].i4)).toBe(true);
    expect(rows[0].f4).toEqual([1.5]);
    expect(rows[0].i8).toEqual(['9007199254740993']);
    expect(rows[0].bytes).toBe(bytes);
    expect(rows[0].text).toEqual(['a']);
    expect(rows[0].i4).toBeNull();
  });

  test('a changed list is a copy: the caller\'s array is not modified', async () => {
    const { client, sent } = clientCapturing(true);
    const date = new Date('2024-01-01T00:00:00.000Z');
    const params: unknown[] = [date, { a: 1 }];
    await client.query('SELECT $1, $2', params);

    expect(sent()).not.toBe(params);
    expect(params[0]).toBe(date);
  });

  test('a numeric zero loses its scale only in prepared (binary) mode — and the client says so', () => {
    // Bun's binary numeric decoder reads numeric(20, 4) 0.0000 as "0"; text results keep "0.0000".
    // The ORM restores the scale of a declared numeric(p, s) zero from this flag.
    expect(clientCapturing(false).client.losesNumericZeroScale()).toBe(true);
    expect(clientCapturing(true).client.losesNumericZeroScale()).toBe(false);
  });

  test('a transaction\'s client answers like the client it runs on', () => {
    // db.transaction() runs its queries through a TransactionalClient over the parent client
    const prepared = new TransactionalClient(async () => ({ rows: [], rowCount: 0 }), clientCapturing(false).client);
    const text = new TransactionalClient(async () => ({ rows: [], rowCount: 0 }), clientCapturing(true).client);

    expect(prepared.losesNumericZeroScale()).toBe(true);
    expect(text.losesNumericZeroScale()).toBe(false);
  });
});
