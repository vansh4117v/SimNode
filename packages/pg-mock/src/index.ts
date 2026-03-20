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

  constructor(private _pglite: Promise<PGliteInstance>) {}

  async processData(data: Buffer): Promise<Buffer> {
    // ── Startup / SSL handshake ───────────────────────────────────────────────
    if (this._phase === 'startup') {
      const parsed = proto.parseStartupMsg(data);
      if ('isSSL' in parsed) return Buffer.from('N');
      this._phase = 'ready';
      return proto.startupResponse();
    }

    // ── Simple Query ('Q') ────────────────────────────────────────────────────
    if (data[0] === 0x51) {
      const sql = proto.parseQueryMsg(data);
      return this._execQuery(sql);
    }

    // ── Extended protocol (Parse/Bind/Execute/Sync) ───────────────────────────
    // Process a multi-message pipeline; collect all responses and flush at Sync.
    const responses: Buffer[] = [];
    let offset = 0;

    while (offset < data.length) {
      const msgType = String.fromCharCode(data[offset]);
      const msgLen  = data.readInt32BE(offset + 1);
      const payload = data.slice(offset + 5, offset + 1 + msgLen);
      offset += 1 + msgLen;

      switch (msgType) {
        case 'P': { // Parse
          responses.push(proto.parseComplete());
          break;
        }
        case 'B': { // Bind
          responses.push(proto.bindComplete());
          break;
        }
        case 'D': { // Describe
          responses.push(proto.noData());
          break;
        }
        case 'E': { // Execute
          const sql = proto.parseExecuteMsg(payload);
          if (sql) {
            const r = await this._execQuery(sql);
            responses.push(r);
          }
          break;
        }
        case 'S': { // Sync
          responses.push(proto.readyForQuery(this._txState));
          break;
        }
        default:
          // Silently ignore unknown message types
          break;
      }
    }

    return responses.length > 0 ? Buffer.concat(responses) : proto.readyForQuery(this._txState);
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
