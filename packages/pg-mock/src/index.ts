import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as proto from './protocol.js';

export class SimNodeUnsupportedPGFeature extends Error {
  constructor(detail: string) {
    super(`SimNode: Unsupported PostgreSQL feature: ${detail}`);
    this.name = 'SimNodeUnsupportedPGFeature';
  }
}

// ── PGlite helpers ────────────────────────────────────────────────────────────

// Dynamically imported so the package remains optional at load time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PGliteInstance = any;

function createPGliteInstance(): Promise<PGliteInstance> {
  return import('@electric-sql/pglite').then(({ PGlite }) => new PGlite());
}

/** Infer a PostgreSQL command tag from the SQL statement and affected-row count. */
function inferTag(sql: string, rowCount: number, affected?: number): string {
  const verb = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  switch (verb) {
    case 'SELECT': return `SELECT ${rowCount}`;
    case 'INSERT': return `INSERT 0 ${affected ?? rowCount}`;
    case 'UPDATE': return `UPDATE ${affected ?? rowCount}`;
    case 'DELETE': return `DELETE ${affected ?? rowCount}`;
    case 'CREATE': return 'CREATE TABLE';
    case 'DROP':   return 'DROP TABLE';
    case 'BEGIN':  return 'BEGIN';
    case 'COMMIT': return 'COMMIT';
    case 'ROLLBACK': return 'ROLLBACK';
    default:       return verb;
  }
}

// ── PgConnection ──────────────────────────────────────────────────────────────

class PgConnection {
  private _phase: 'startup' | 'ready' = 'startup';
  private _txState: 'I' | 'T' | 'E' = 'I';
  private _buf: Buffer = Buffer.alloc(0);

  /** Prepared statements: statement name → SQL. '' = unnamed statement. */
  private _statements = new Map<string, string>();
  /** Bound portals: portal name → { sql, params }. '' = unnamed portal. */
  private _portals = new Map<string, { sql: string; params: string[] }>();

  constructor(private _pglite: Promise<PGliteInstance>) {}

  async processData(data: Buffer): Promise<Buffer> {
    this._buf = this._buf.length > 0 ? Buffer.concat([this._buf, data]) : data;

    // ── Startup / SSL handshake ───────────────────────────────────────────────
    if (this._phase === 'startup') {
      // SSL probe is exactly 8 bytes; startup message has a 4-byte length prefix
      if (this._buf.length < 4) return Buffer.alloc(0);
      const msgLen = this._buf.readInt32BE(0);
      if (this._buf.length < msgLen) return Buffer.alloc(0);

      const msg = this._buf.subarray(0, msgLen);
      this._buf = this._buf.subarray(msgLen);

      const parsed = proto.parseStartupMsg(msg);
      if ('isSSL' in parsed) return Buffer.from('N');
      this._phase = 'ready';
      return proto.startupResponse();
    }

    // ── Ready phase: consume complete framed messages ──────────────────────────
    const responses: Buffer[] = [];

    while (this._buf.length >= 5) {
      const msgType = String.fromCharCode(this._buf[0]);
      const msgLen  = this._buf.readInt32BE(1); // includes self (4 bytes) but not type byte
      const totalLen = 1 + msgLen;
      if (this._buf.length < totalLen) break;   // incomplete — wait for more data

      const payload = this._buf.subarray(5, totalLen);
      this._buf = this._buf.subarray(totalLen);

      // Simple Query ('Q')
      if (msgType === 'Q') {
        const nul = payload.indexOf(0);
        const sql = payload.toString('utf8', 0, nul >= 0 ? nul : payload.length);
        responses.push(await this._execQuery(sql));
        continue;
      }

      switch (msgType) {
        case 'P': { // Parse: statement_name\0 + query\0 + Int16(numParams) + ...
          const nameEnd = payload.indexOf(0);
          const stmtName = nameEnd > 0 ? payload.toString('utf8', 0, nameEnd) : '';
          const queryStart = nameEnd + 1;
          const queryEnd = payload.indexOf(0, queryStart);
          const sql = payload.toString('utf8', queryStart, queryEnd >= 0 ? queryEnd : payload.length);
          this._statements.set(stmtName, sql);
          responses.push(proto.parseComplete());
          break;
        }
        case 'B': { // Bind: portal\0 + statement\0 + formats + params + result_formats
          const { portal, statement, params } = this._parseBind(payload);
          const boundSql = this._statements.get(statement) ?? '';
          this._portals.set(portal, { sql: boundSql, params });
          responses.push(proto.bindComplete());
          break;
        }
        case 'D': { // Describe
          responses.push(proto.noData());
          break;
        }
        case 'E': { // Execute: portal\0 + maxRows(Int32)
          const portalEnd = payload.indexOf(0);
          const portalName = portalEnd > 0 ? payload.toString('utf8', 0, portalEnd) : '';
          const bound = this._portals.get(portalName);
          if (bound && bound.sql) {
            const r = await this._execQueryWithParams(bound.sql, bound.params);
            responses.push(r);
          }
          break;
        }
        case 'S': { // Sync
          responses.push(proto.readyForQuery(this._txState));
          break;
        }
        case 'X': { // Terminate
          break;
        }
        default:
          // Silently ignore unknown message types
          break;
      }
    }

    return responses.length > 0 ? Buffer.concat(responses) : Buffer.alloc(0);
  }

  /** Parse a Bind message payload into portal, statement, and parameter values. */
  private _parseBind(payload: Buffer): { portal: string; statement: string; params: string[] } {
    let off = 0;
    // portal name \0
    const portalEnd = payload.indexOf(0, off);
    const portal = portalEnd > off ? payload.toString('utf8', off, portalEnd) : '';
    off = portalEnd + 1;
    // statement name \0
    const stmtEnd = payload.indexOf(0, off);
    const statement = stmtEnd > off ? payload.toString('utf8', off, stmtEnd) : '';
    off = stmtEnd + 1;
    // Int16 num format codes + format codes (skip)
    const numFormats = payload.readInt16BE(off); off += 2;
    off += numFormats * 2; // skip format codes
    // Int16 num params
    const numParams = payload.readInt16BE(off); off += 2;
    const params: string[] = [];
    for (let i = 0; i < numParams; i++) {
      const len = payload.readInt32BE(off); off += 4;
      if (len === -1) {
        params.push('NULL');
      } else {
        params.push(payload.toString('utf8', off, off + len));
        off += len;
      }
    }
    return { portal, statement, params };
  }

  /** Execute a parameterized query — substitutes $1, $2, … and runs via PGlite. */
  private async _execQueryWithParams(sql: string, params: string[]): Promise<Buffer> {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper === 'BEGIN')    { this._txState = 'T'; return proto.commandComplete('BEGIN'); }
    if (upper === 'COMMIT')   { this._txState = 'I'; return proto.commandComplete('COMMIT'); }
    if (upper === 'ROLLBACK') { this._txState = 'I'; return proto.commandComplete('ROLLBACK'); }

    const db = await this._pglite;
    try {
      // PGlite supports parameterized queries directly
      const result = await db.query(trimmed, params);
      const fields: Array<{ name: string }> = result.fields ?? [];
      const rows:   Array<Record<string, unknown>> = result.rows ?? [];

      const bufs: Buffer[] = [];
      if (fields.length > 0) {
        bufs.push(proto.rowDescription(fields.map((f: { name: string }) => f.name)));
        for (const row of rows) {
          bufs.push(proto.dataRow(fields.map((f: { name: string }) => {
            const v = row[f.name];
            return v === null || v === undefined ? null : String(v);
          })));
        }
      }

      const tag = inferTag(trimmed, rows.length, result.affectedRows as number | undefined);
      bufs.push(proto.commandComplete(tag));
      return Buffer.concat(bufs);
    } catch (err) {
      return proto.errorResponse(err instanceof Error ? err.message : String(err));
    }
  }

  private async _execQuery(sql: string): Promise<Buffer> {
    const trimmed = sql.trim();
    const upper   = trimmed.toUpperCase();

    if (upper === 'BEGIN')    { this._txState = 'T'; return Buffer.concat([proto.commandComplete('BEGIN'),    proto.readyForQuery('T')]); }
    if (upper === 'COMMIT')   { this._txState = 'I'; return Buffer.concat([proto.commandComplete('COMMIT'),   proto.readyForQuery('I')]); }
    if (upper === 'ROLLBACK') { this._txState = 'I'; return Buffer.concat([proto.commandComplete('ROLLBACK'), proto.readyForQuery('I')]); }

    const db = await this._pglite;
    try {
      const result = await db.query(trimmed);
      const fields: Array<{ name: string }> = result.fields ?? [];
      const rows:   Array<Record<string, unknown>> = result.rows  ?? [];

      const bufs: Buffer[] = [];

      if (fields.length > 0) {
        bufs.push(proto.rowDescription(fields.map((f: { name: string }) => f.name)));
        for (const row of rows) {
          bufs.push(proto.dataRow(fields.map((f: { name: string }) => {
            const v = row[f.name];
            return v === null || v === undefined ? null : String(v);
          })));
        }
      }

      const tag = inferTag(trimmed, rows.length, result.affectedRows as number | undefined);
      if (tag === 'BEGIN') this._txState = 'T';
      else if (tag === 'COMMIT' || tag === 'ROLLBACK') this._txState = 'I';

      bufs.push(proto.commandComplete(tag));
      bufs.push(proto.readyForQuery(this._txState));
      return Buffer.concat(bufs);
    } catch (err) {
      return Buffer.concat([
        proto.errorResponse(err instanceof Error ? err.message : String(err)),
        proto.readyForQuery(this._txState === 'T' ? 'E' : 'I'),
      ]);
    }
  }
}

// ── PgMock ────────────────────────────────────────────────────────────────────

export class PgMock {
  /** Shared PGlite instance (one per PgMock, lazy-initialised). */
  private _pglite: Promise<PGliteInstance>;
  /** Tracks all in-flight seed operations so ready() can await them. */
  private _seedPromise: Promise<void> = Promise.resolve();
  private _connections = new Map<number, PgConnection>();

  constructor() {
    this._pglite = createPGliteInstance();
  }

  /**
   * Resolves once PGlite is initialised AND all pending seedData() calls have
   * been mirrored into PGlite.  Await this before making wire-protocol queries
   * in tests that call seedData().
   */
  async ready(): Promise<void> {
    await this._pglite;
    await this._seedPromise;
  }

  /**
   * Seed data directly into PGlite.
   * Creates a simple text-column table with the supplied rows.
   */
  seedData(table: string, rows: Array<Record<string, string | null>>): void {
    // Write directly to PGlite (no legacy sync store).
    this._seedPromise = this._seedPromise.then(() => this._seedPGlite(table, rows));
  }

  private async _seedPGlite(table: string, rows: Array<Record<string, string | null>>): Promise<void> {
    if (rows.length === 0) return;
    const db = await this._pglite;
    const cols = Object.keys(rows[0]);
    const colDefs = cols.map(c => `"${c}" TEXT`).join(', ');
    try {
      await db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs})`);
      for (const row of rows) {
        const vals = cols.map(c => row[c] === null ? 'NULL' : `'${String(row[c]).replace(/'/g, "''")}'`).join(', ');
        await db.exec(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${vals})`);
      }
    } catch {
      // Ignore duplicate table errors on repeated seeding
    }
  }

  /**
   * Execute a raw SQL query against the embedded PGlite instance.
   * Returns rows as plain objects keyed by column name.
   */
  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; fields: Array<{ name: string }> }> {
    const db = await this._pglite;
    return db.query(sql) as Promise<{ rows: T[]; fields: Array<{ name: string }> }>;
  }

  createHandler(): TcpMockHandler {
    return async (data: Buffer, ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      if (!this._connections.has(ctx.socketId)) {
        this._connections.set(ctx.socketId, new PgConnection(this._pglite));
      }
      return this._connections.get(ctx.socketId)!.processData(data);
    };
  }
}

export { proto };
