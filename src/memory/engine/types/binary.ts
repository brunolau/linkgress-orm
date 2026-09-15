import { TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import { inputValue, IoContext } from './io';
import { parseJsonb } from './json';

function need(buf: Buffer, n: number, typeName: string): void {
  if (buf.length !== n) {
    throw new PgError(SqlState.INVALID_BINARY_REPRESENTATION ?? '22P03', `incorrect binary data format in bind parameter`, { detail: `${typeName} expects ${n} bytes` });
  }
}

/** Binary-format parameter input (typreceive) for the types drivers send in binary. */
export function receiveBinary(typeOid: number, bytes: Uint8Array, ctx: IoContext): unknown {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (typeOid) {
    case TypeOid.bytea:
      return new Uint8Array(buf);
    case TypeOid.bool:
      need(buf, 1, 'boolean');
      return buf[0] !== 0;
    case TypeOid.int2:
      need(buf, 2, 'smallint');
      return buf.readInt16BE(0);
    case TypeOid.int4:
      need(buf, 4, 'integer');
      return buf.readInt32BE(0);
    case TypeOid.int8:
      need(buf, 8, 'bigint');
      return buf.readBigInt64BE(0);
    case TypeOid.float4:
      need(buf, 4, 'real');
      return buf.readFloatBE(0);
    case TypeOid.float8:
      need(buf, 8, 'double precision');
      return buf.readDoubleBE(0);
    case TypeOid.uuid: {
      need(buf, 16, 'uuid');
      const h = buf.toString('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    case TypeOid.jsonb:
      if (buf[0] !== 1) {
        throw new PgError(SqlState.INVALID_BINARY_REPRESENTATION ?? '22P03', `unsupported jsonb version number ${buf[0]}`);
      }
      return parseJsonb(buf.toString('utf8', 1));
    case TypeOid.date:
      need(buf, 4, 'date');
      return buf.readInt32BE(0);
    case TypeOid.timestamp:
    case TypeOid.timestamptz:
      need(buf, 8, 'timestamp');
      return Number(buf.readBigInt64BE(0));
    default:
      // text-like types have identical binary and text representations
      return inputValue(typeOid, buf.toString('utf8'), -1, ctx);
  }
}
