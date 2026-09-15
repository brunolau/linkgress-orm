import type { Database } from '../engine/database';
import { PgError, SqlState } from '../engine/errors';
import type { FieldInfo, PreparedInfo, Session, StatementResult } from '../engine/session';
import { sendBinary } from '../engine/types/binary';
import { outputValue } from '../engine/types/io';

const PROTOCOL_V3 = 196608;
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

/** Reported server version (matches the PostgreSQL release the builtin catalog was generated from). */
export const SERVER_VERSION = '18.3';
const SERVER_VERSION_NUM = '180003';

interface CancelKey {
  secret: number;
  connection: ServerConnection;
}

/** cancel keys by backend pid (pids are unique across the databases of a process) */
const cancelRegistry = new Map<number, CancelKey>();

/** Chooses the database a connection works with from its startup `database` parameter. */
export type DatabaseResolver = (databaseName: string | undefined) => Database;

/** Growable output buffer for backend messages. */
class Writer {
  private buf = Buffer.allocUnsafe(4096);
  private pos = 0;
  private msgStart = -1;

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.pos + n) {
        size *= 2;
      }
      const next = Buffer.allocUnsafe(size);
      this.buf.copy(next, 0, 0, this.pos);
      this.buf = next;
    }
  }

  begin(type: string): this {
    this.ensure(5);
    this.buf[this.pos++] = type.charCodeAt(0);
    this.msgStart = this.pos;
    this.pos += 4;
    return this;
  }

  end(): void {
    this.buf.writeInt32BE(this.pos - this.msgStart, this.msgStart);
    this.msgStart = -1;
  }

  byte(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v;
    return this;
  }

  int16(v: number): this {
    this.ensure(2);
    this.buf.writeInt16BE(v, this.pos);
    this.pos += 2;
    return this;
  }

  uint16(v: number): this {
    this.ensure(2);
    this.buf.writeUInt16BE(v, this.pos);
    this.pos += 2;
    return this;
  }

  int32(v: number): this {
    this.ensure(4);
    this.buf.writeInt32BE(v | 0, this.pos);
    this.pos += 4;
    return this;
  }

  uint32(v: number): this {
    this.ensure(4);
    this.buf.writeUInt32BE(v >>> 0, this.pos);
    this.pos += 4;
    return this;
  }

  cstr(s: string): this {
    const len = Buffer.byteLength(s);
    this.ensure(len + 1);
    this.buf.write(s, this.pos, 'utf8');
    this.pos += len;
    this.buf[this.pos++] = 0;
    return this;
  }

  bytesWithLength(s: string | Buffer | null): this {
    if (s === null) {
      return this.int32(-1);
    }
    if (typeof s !== 'string') {
      this.ensure(s.length + 4);
      this.buf.writeInt32BE(s.length, this.pos);
      this.pos += 4;
      s.copy(this.buf, this.pos);
      this.pos += s.length;
      return this;
    }
    const len = Buffer.byteLength(s);
    this.ensure(len + 4);
    this.buf.writeInt32BE(len, this.pos);
    this.pos += 4;
    this.buf.write(s, this.pos, 'utf8');
    this.pos += len;
    return this;
  }

  get length(): number {
    return this.pos;
  }

  take(): Buffer {
    const out = Buffer.from(this.buf.subarray(0, this.pos));
    this.pos = 0;
    if (this.buf.length > 1 << 20) {
      this.buf = Buffer.allocUnsafe(4096);
    }
    return out;
  }
}

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  byte(): number {
    return this.buf[this.pos++];
  }

  int16(): number {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  /** message counts (parameters, formats) are unsigned 16-bit */
  uint16(): number {
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  int32(): number {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  uint32(): number {
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  cstr(): string {
    const end = this.buf.indexOf(0, this.pos);
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return s;
  }

  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

interface Portal {
  info: PreparedInfo;
  params: unknown[];
  /** result-column format codes from Bind (0 text, 1 binary): none (all text), one for all, or one per column */
  resultFormats: number[];
  /** buffered result once executed */
  result: StatementResult | null;
  sent: number;
}

/** Command tag as PostgreSQL reports it in CommandComplete. */
/** The format code of result column `i` for Bind's result-format codes. */
function columnFormat(formats: number[], i: number): number {
  return formats.length === 0 ? 0 : formats.length === 1 ? formats[0] : formats[i] ?? 0;
}

export function commandTag(r: StatementResult): string {
  switch (r.command) {
    case 'SELECT':
      return `SELECT ${r.rowCount ?? r.rows.length}`;
    case 'INSERT':
      return `INSERT 0 ${r.rowCount ?? 0}`;
    case 'UPDATE':
    case 'DELETE':
    case 'MERGE':
    case 'MOVE':
    case 'FETCH':
    case 'COPY':
      return `${r.command} ${r.rowCount ?? 0}`;
    default:
      return r.command;
  }
}

export interface ServerConnectionHooks {
  /** deliver bytes to the client */
  send(data: Buffer): void;
  /** close the transport */
  close(): void;
}

/**
 * Server side of one PostgreSQL frontend/backend protocol (v3) connection, backed by an
 * in-memory database session.
 */
export class ServerConnection {
  private inbuf: Buffer = Buffer.alloc(0);
  private processing = false;
  private startupDone = false;
  private terminated = false;
  private session: Session | null = null;
  private secret = 0;
  private out = new Writer();
  private ignoreTillSync = false;
  /** the unnamed statement (named ones live in the session, shared with SQL PREPARE) */
  private unnamedStatement: PreparedInfo | null = null;
  private portals = new Map<string, Portal>();
  private reported = new Map<string, string>();
  /** statement being processed (diagnostics) */
  private currentSql = '';

  private db: Database | null;
  private readonly resolveDatabase: DatabaseResolver | null;

  /** `database`: the database every connection uses, or a resolver choosing one by the startup `database` name */
  constructor(
    database: Database | DatabaseResolver,
    private readonly hooks: ServerConnectionHooks
  ) {
    if (typeof database === 'function') {
      this.db = null;
      this.resolveDatabase = database;
    } else {
      this.db = database;
      this.resolveDatabase = null;
    }
  }

  receive(chunk: Buffer): void {
    if (this.terminated) {
      return;
    }
    this.inbuf = this.inbuf.length === 0 ? chunk : Buffer.concat([this.inbuf, chunk]);
    if (!this.processing) {
      void this.pump();
    }
  }

  /** Transport closed by the client without a Terminate message. */
  disconnect(): void {
    this.terminate();
  }

  private async pump(): Promise<void> {
    this.processing = true;
    try {
      for (;;) {
        if (this.terminated) {
          return;
        }
        const msg = this.nextMessage();
        if (!msg) {
          break;
        }
        await this.handle(msg.type, msg.body);
      }
    } catch (e) {
      // protocol-level failure: report and close like a backend FATAL
      this.errorResponse(e, 'FATAL');
      this.flush();
      this.terminate();
    } finally {
      this.processing = false;
      this.flush();
    }
  }

  private nextMessage(): { type: number; body: Buffer } | null {
    const b = this.inbuf;
    if (!this.startupDone) {
      if (b.length < 4) {
        return null;
      }
      const len = b.readInt32BE(0);
      if (b.length < len) {
        return null;
      }
      this.inbuf = b.subarray(len);
      return { type: -1, body: b.subarray(4, len) };
    }
    if (b.length < 5) {
      return null;
    }
    const len = b.readInt32BE(1);
    if (b.length < len + 1) {
      return null;
    }
    this.inbuf = b.subarray(len + 1);
    return { type: b[0], body: b.subarray(5, len + 1) };
  }

  private flush(): void {
    if (this.out.length > 0) {
      this.hooks.send(this.out.take());
    }
  }

  private terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    if (this.session) {
      cancelRegistry.delete(this.session.backendPid);
      this.session.onNotify = null;
      this.session.onNotice = null;
      this.db!.closeSession(this.session);
      this.session = null;
    }
    this.hooks.close();
  }

  // ---------------------------------------------------------------------------
  // Message dispatch
  // ---------------------------------------------------------------------------

  private async handle(type: number, body: Buffer): Promise<void> {
    const trace = process.env.LINKGRESS_WIRE_TRACE;
    if (trace && type === 66) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').appendFileSync(trace, `    bind ${body.length}b\n`);
    }
    if (trace && (type === 81 || type === 80)) {
      const r = new Reader(body);
      if (type === 80) {
        r.cstr();
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').appendFileSync(trace, `[${this.session?.backendPid}] ${String.fromCharCode(type)} ${r.cstr().replace(/\s+/g, ' ').slice(0, Number(process.env.LINKGRESS_WIRE_TRACE_SQL_CHARS ?? 300))}\n`);
    }
    if (type === -1) {
      this.handleStartup(body);
      return;
    }
    const ch = String.fromCharCode(type);
    if (ch === 'X') {
      this.flush();
      this.terminate();
      return;
    }
    if (this.ignoreTillSync && ch !== 'S') {
      return;
    }
    switch (ch) {
      case 'Q':
        await this.simpleQuery(new Reader(body).cstr());
        return;
      case 'P':
        this.extended(() => this.parseMessage(new Reader(body)));
        return;
      case 'B':
        this.extended(() => this.bindMessage(new Reader(body)));
        return;
      case 'D':
        this.extended(() => this.describeMessage(new Reader(body)));
        return;
      case 'E':
        await this.executeMessage(new Reader(body));
        return;
      case 'C':
        this.extended(() => this.closeMessage(new Reader(body)));
        return;
      case 'H':
        this.flush();
        return;
      case 'S':
        this.ignoreTillSync = false;
        this.session!.sync();
        if (!this.session!.txn) {
          // non-holdable portals do not survive the end of their transaction
          this.portals.clear();
        }
        this.readyForQuery();
        return;
      case 'p':
        // password message: authentication is not required
        return;
      case 'd':
      case 'c':
      case 'f':
        return;
      default:
        throw new PgError(SqlState.PROTOCOL_VIOLATION, `invalid frontend message type ${type}`);
    }
  }

  private extended(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.extendedError(e);
    }
  }

  private extendedError(e: unknown): void {
    this.errorResponse(e);
    this.ignoreTillSync = true;
    const s = this.session!;
    if (s.txn) {
      s.txn.failed = true;
    }
  }

  private handleStartup(body: Buffer): void {
    const r = new Reader(body);
    const code = r.int32();
    if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
      this.out.byte('N'.charCodeAt(0));
      this.flush();
      return;
    }
    if (code === CANCEL_REQUEST) {
      const pid = r.int32();
      const secret = r.int32();
      const key = cancelRegistry.get(pid);
      if (key && key.secret === secret) {
        key.connection.session?.requestCancel();
      }
      this.terminate();
      return;
    }
    if (code !== PROTOCOL_V3) {
      throw new PgError(SqlState.PROTOCOL_VIOLATION, `unsupported frontend protocol ${code >> 16}.${code & 0xffff}: server supports 3.0 to 3.2`);
    }
    const params: Record<string, string> = {};
    while (r.pos < body.length - 1) {
      const k = r.cstr();
      if (!k) {
        break;
      }
      params[k] = r.cstr();
    }
    this.startupDone = true;
    if (!this.db) {
      // routed by name; an unknown database is refused like PostgreSQL does (FATAL 3D000)
      this.db = this.resolveDatabase!(params.database ?? params.user);
    }
    const session = this.db.createSession();
    this.session = session;
    if (params.database) {
      session.connectedDatabaseName = params.database;
    }
    for (const [k, v] of Object.entries(params)) {
      if (k === 'user' || k === 'database' || k === 'replication' || k === 'options') {
        continue;
      }
      try {
        session.setSetting(k, v, false);
      } catch {
        // PG rejects unknown startup parameters with FATAL; drivers only send valid ones
      }
    }
    this.secret = (Math.random() * 0x7fffffff) | 0;
    cancelRegistry.set(session.backendPid, { secret: this.secret, connection: this });
    session.onNotice = (notice) => this.errorResponse(notice);
    session.onNotify = () => {
      if (!this.processing && !this.terminated && (!session.txn || !session.txn.explicit)) {
        this.deliverNotifications();
        this.flush();
      }
    };

    this.out.begin('R').int32(0).end();
    for (const name of ['application_name', 'client_encoding', 'DateStyle', 'default_transaction_read_only', 'in_hot_standby', 'integer_datetimes', 'IntervalStyle', 'is_superuser', 'scram_iterations', 'search_path', 'server_encoding', 'server_version', 'session_authorization', 'standard_conforming_strings', 'TimeZone']) {
      this.parameterStatus(name, this.reportedValue(name));
    }
    this.out.begin('K').int32(session.backendPid).int32(this.secret).end();
    this.readyForQuery();
  }

  private reportedValue(name: string): string {
    const s = this.session!;
    switch (name) {
      case 'server_version':
        return SERVER_VERSION;
      case 'server_version_num':
        return SERVER_VERSION_NUM;
      case 'in_hot_standby':
        return 'off';
      case 'is_superuser':
        return 'on';
      case 'session_authorization':
        return s.userName;
      default:
        try {
          return s.showSetting(name);
        } catch {
          return '';
        }
    }
  }

  private parameterStatus(name: string, value: string): void {
    this.reported.set(name, value);
    this.out.begin('S').cstr(name).cstr(value).end();
  }

  /** Report changed GUC_REPORT settings (sent after each command, like PG). */
  private reportChangedSettings(): void {
    for (const [name, prev] of this.reported) {
      const cur = this.reportedValue(name);
      if (cur !== prev) {
        this.parameterStatus(name, cur);
      }
    }
  }

  private readyForQuery(): void {
    const s = this.session!;
    this.reportChangedSettings();
    if (!s.txn || !s.txn.explicit) {
      this.deliverNotifications();
    }
    this.out.begin('Z').byte(s.transactionStatus().charCodeAt(0)).end();
    this.flush();
  }

  private deliverNotifications(): void {
    const s = this.session;
    if (!s || s.notifications.length === 0) {
      return;
    }
    const list = s.notifications.splice(0);
    for (const n of list) {
      this.out.begin('A').int32(n.pid).cstr(n.channel).cstr(n.payload).end();
    }
  }

  // ---------------------------------------------------------------------------
  // Simple query protocol
  // ---------------------------------------------------------------------------

  private async simpleQuery(sql: string): Promise<void> {
    const s = this.session!;
    let parsed;
    this.currentSql = sql;
    try {
      parsed = this.db!.parse(sql);
    } catch (e) {
      this.errorResponse(e);
      if (s.txn && s.txn.explicit) {
        s.txn.failed = true;
      }
      this.readyForQuery();
      return;
    }
    if (parsed.length === 0) {
      this.out.begin('I').end();
      this.readyForQuery();
      return;
    }
    const multi = parsed.length > 1;
    for (const ps of parsed) {
      this.currentSql = ps.text;
      try {
        const started = Date.now();
        const r = await s.executeSimple(ps, multi);
        this.noteDuration(ps.text, Date.now() - started);
        if (r.hasRows) {
          this.rowDescription(r.fields);
        }
        this.dataRows(r, 0, r.rows.length);
        this.commandComplete(r);
      } catch (e) {
        this.errorResponse(e);
        break;
      }
    }
    if (multi) {
      s.sync();
    }
    this.readyForQuery();
  }

  // ---------------------------------------------------------------------------
  // Extended query protocol
  // ---------------------------------------------------------------------------

  private parseMessage(r: Reader): void {
    const name = r.cstr();
    const sql = r.cstr();
    const n = r.uint16();
    const types: number[] = [];
    for (let i = 0; i < n; i++) {
      types.push(r.uint32());
    }
    const s = this.session!;
    if (name !== '' && s.preparedStatements.has(name)) {
      throw new PgError(SqlState.DUPLICATE_PSTATEMENT, `prepared statement "${name}" already exists`);
    }
    this.currentSql = sql;
    const info = s.prepare(sql, types);
    info.name = name;
    if (name === '') {
      this.unnamedStatement = info;
    } else {
      s.preparedStatements.set(name, {
        text: sql,
        argTypes: info.paramTypes,
        resultTypes: info.fields ? info.fields.map((f) => f.typeOid) : [],
        fromSql: false,
        prepareTime: s.clockTimestamp(),
        info,
      });
    }
    this.out.begin('1').end();
  }

  private bindMessage(r: Reader): void {
    const portalName = r.cstr();
    const stmtName = r.cstr();
    const nFormats = r.uint16();
    const formats: number[] = [];
    for (let i = 0; i < nFormats; i++) {
      formats.push(r.int16());
    }
    const nParams = r.uint16();
    const values: (Uint8Array | null)[] = [];
    for (let i = 0; i < nParams; i++) {
      const len = r.int32();
      values.push(len === -1 ? null : r.bytes(len));
    }
    const nResultFormats = r.uint16();
    const resultFormats: number[] = [];
    for (let i = 0; i < nResultFormats; i++) {
      resultFormats.push(r.int16());
    }
    if (nFormats > 1 && nFormats !== nParams) {
      throw new PgError(SqlState.PROTOCOL_VIOLATION, `bind message has ${nFormats} parameter formats but ${nParams} parameters`);
    }
    let info = this.lookupStatement(stmtName);
    if (stmtName !== '') {
      const entry = this.session!.preparedStatements.get(stmtName)!;
      info = this.session!.revalidate(info);
      entry.info = info;
    }
    if (portalName !== '' && this.portals.has(portalName)) {
      throw new PgError(SqlState.DUPLICATE_CURSOR, `cursor "${portalName}" already exists`);
    }
    const params = this.session!.bindParams(info, values, formats);
    // PortalSetResultFormat
    const columns = info.fields ? info.fields.length : 0;
    if (nResultFormats > 1 && nResultFormats !== columns) {
      throw new PgError(SqlState.PROTOCOL_VIOLATION, `bind message has ${nResultFormats} result formats but query has ${columns} columns`);
    }
    for (const f of resultFormats) {
      if (f !== 0 && f !== 1) {
        throw new PgError(SqlState.INVALID_PARAMETER_VALUE, `unsupported format code: ${f}`);
      }
    }
    this.portals.set(portalName, { info, params, resultFormats, result: null, sent: 0 });
    this.out.begin('2').end();
  }

  private describeMessage(r: Reader): void {
    const kind = String.fromCharCode(r.byte());
    const name = r.cstr();
    if (kind === 'S') {
      const info = this.lookupStatement(name);
      this.out.begin('t').uint16(info.paramTypes.length);
      for (const t of info.paramTypes) {
        this.out.uint32(t);
      }
      this.out.end();
      if (info.fields) {
        this.rowDescription(info.fields);
      } else {
        this.out.begin('n').end();
      }
      return;
    }
    const portal = this.lookupPortal(name);
    if (portal.info.fields) {
      this.rowDescription(portal.info.fields, portal.resultFormats);
    } else {
      this.out.begin('n').end();
    }
  }

  private async executeMessage(r: Reader): Promise<void> {
    const portalName = r.cstr();
    const maxRows = r.int32();
    const s = this.session!;
    try {
      const portal = this.lookupPortal(portalName);
      if (!portal.info.ps) {
        this.out.begin('I').end();
        return;
      }
      this.currentSql = portal.info.ps.text;
      const first = !portal.result;
      if (!portal.result) {
        const started = Date.now();
        portal.result = await s.executeBound(portal.info, portal.params);
        this.noteDuration(portal.info.ps.text, Date.now() - started, portal.info, portal.params);
        portal.sent = 0;
      }
      const res = portal.result;
      const total = res.rows.length;
      const start = portal.sent;
      const end = maxRows > 0 ? Math.min(total, start + maxRows) : total;
      this.dataRows(res, start, end, portal.resultFormats);
      portal.sent = end;
      if (maxRows > 0 && end < total) {
        this.out.begin('s').end();
        return;
      }
      if (first) {
        this.commandComplete(res);
      } else {
        // a portal resumed after PortalSuspended reports the rows of this fetch only
        this.commandComplete(res.command === 'SELECT' ? { ...res, rowCount: end - start } : res);
      }
    } catch (e) {
      this.extendedError(e);
    }
  }

  /**
   * Diagnostics: LINKGRESS_MEMORY_SLOW_LOG=<file>[:<ms>] records statements slower than the threshold;
   * with LINKGRESS_MEMORY_SLOW_LOG_FULL set, `<file>.jsonl` also gets the full text and parameters.
   */
  private noteDuration(sql: string, ms: number, info?: PreparedInfo, params?: unknown[]): void {
    const spec = process.env.LINKGRESS_MEMORY_SLOW_LOG;
    if (!spec) {
      return;
    }
    const m = /^(.*?)(?::(\d+))?$/.exec(spec)!;
    if (ms >= Number(m[2] ?? 100)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      fs.appendFileSync(m[1], `${ms}ms ${sql.replace(/\s+/g, ' ').slice(0, 400)}\n`);
      if (process.env.LINKGRESS_MEMORY_SLOW_LOG_FULL) {
        const io = this.session!.io;
        const text = (params ?? []).map((v, i) => (v === null || v === undefined ? null : outputValue(info!.paramTypes[i], v, io)));
        fs.appendFileSync(`${m[1]}.jsonl`, `${JSON.stringify({ ms, sql, params: text })}\n`);
      }
    }
  }

  private lookupStatement(name: string): PreparedInfo {
    const info = name === '' ? this.unnamedStatement : this.session!.preparedStatements.get(name)?.info;
    if (!info) {
      throw new PgError('26000', name ? `prepared statement "${name}" does not exist` : 'unnamed prepared statement does not exist');
    }
    return info;
  }

  private lookupPortal(name: string): Portal {
    const portal = this.portals.get(name);
    if (!portal) {
      throw new PgError(SqlState.INVALID_CURSOR_NAME, name ? `portal "${name}" does not exist` : 'unnamed portal does not exist');
    }
    return portal;
  }

  private closeMessage(r: Reader): void {
    const kind = String.fromCharCode(r.byte());
    const name = r.cstr();
    if (kind === 'S') {
      if (name === '') {
        this.unnamedStatement = null;
      } else {
        this.session!.preparedStatements.delete(name);
      }
    } else {
      this.portals.delete(name);
    }
    this.out.begin('3').end();
  }

  // ---------------------------------------------------------------------------
  // Result encoding
  // ---------------------------------------------------------------------------

  private rowDescription(fields: FieldInfo[], formats: number[] = []): void {
    const cat = this.session!.catalog();
    this.out.begin('T').int16(fields.length);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      // domains are described as their base type and typmod (printtup.c)
      let typeOid = f.typeOid;
      let typmod = f.typmod;
      let t = cat.getType(typeOid);
      while (t && t.typtype === 'd' && t.baseType) {
        typmod = t.typmod;
        typeOid = t.baseType;
        t = cat.getType(typeOid);
      }
      this.out.cstr(f.name).uint32(f.tableOid).int16(f.columnAttnum).uint32(typeOid).int16(t ? t.len : -1).int32(typmod).int16(columnFormat(formats, i));
    }
    this.out.end();
  }

  private dataRows(r: StatementResult, from: number, to: number, formats: number[] = []): void {
    const io = this.session!.io;
    const fields = r.fields;
    const n = fields.length;
    const binary = fields.map((_, c) => columnFormat(formats, c) === 1);
    for (let i = from; i < to; i++) {
      const row = r.rows[i];
      this.out.begin('D').int16(n);
      for (let c = 0; c < n; c++) {
        const v = row[c];
        if (v === null || v === undefined) {
          this.out.bytesWithLength(null);
        } else if (binary[c]) {
          this.out.bytesWithLength(sendBinary(fields[c].typeOid, v, io));
        } else {
          this.out.bytesWithLength(outputValue(fields[c].typeOid, v, io));
        }
      }
      this.out.end();
      if (this.out.length > 1 << 16) {
        this.flush();
      }
    }
  }

  private commandComplete(r: StatementResult): void {
    const trace = process.env.LINKGRESS_WIRE_TRACE;
    if (trace) {
      const io = this.session!.io;
      const rows = r.rows.slice(0, 20).map((row) => row.map((v, i) => (v === null || v === undefined ? null : outputValue(r.fields[i].typeOid, v, io))));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').appendFileSync(trace, `    => ${commandTag(r)} ${JSON.stringify(rows).slice(0, 1500)}\n`);
    }
    if (r.command === '') {
      this.out.begin('I').end();
      return;
    }
    this.out.begin('C').cstr(commandTag(r)).end();
  }

  private errorResponse(e: unknown, severity = 'ERROR'): void {
    let err: PgError;
    if (e instanceof PgError) {
      err = e;
    } else {
      const message = e instanceof Error ? e.message : String(e);
      err = new PgError(SqlState.INTERNAL_ERROR, message);
    }
    const debugFile = process.env.LINKGRESS_MEMORY_DEBUG;
    if (debugFile && (debugFile.endsWith('+') || !(e instanceof PgError))) {
      const stack = e instanceof Error ? e.stack : String(e);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').appendFileSync(debugFile.replace(/\+$/, ''), `=== ${err.code} ${err.message}\n--- sql: ${this.currentSql}\n${e instanceof PgError ? '' : stack}\n`);
    }
    const sev = severity === 'FATAL' ? 'FATAL' : err.severity;
    const w = this.out.begin(sev === 'ERROR' || sev === 'FATAL' || sev === 'PANIC' ? 'E' : 'N');
    w.byte(83).cstr(sev); // S
    w.byte(86).cstr(sev); // V
    w.byte(67).cstr(err.code); // C
    w.byte(77).cstr(err.message); // M
    const opt = (code: string, v: string | number | undefined) => {
      if (v !== undefined && v !== null) {
        w.byte(code.charCodeAt(0)).cstr(String(v));
      }
    };
    opt('D', err.detail);
    opt('H', err.hint);
    opt('P', err.position);
    opt('p', err.internalPosition);
    opt('q', err.internalQuery);
    opt('W', err.where);
    opt('s', err.schema);
    opt('t', err.table);
    opt('c', err.column);
    opt('d', err.dataType);
    opt('n', err.constraint);
    opt('R', err.routine);
    w.byte(0);
    w.end();
  }
}
