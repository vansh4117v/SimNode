import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as proto from './protocol.js';

export class SimNodeUnsupportedPGFeature extends Error {
  constructor(detail: string) {
    super(`SimNode: Unsupported PostgreSQL feature: ${detail}`);
    this.name = 'SimNodeUnsupportedPGFeature';
  }
}

type Row = Record<string, string | null>;

export class PgStore {
  private _tables = new Map<string, Row[]>();

  seedData(table: string, rows: Row[]): void {
    this._tables.set(table.toLowerCase(), rows.map(r => ({ ...r })));
  }

  getTable(name: string): Row[] {
    return this._tables.get(name.toLowerCase()) ?? [];
  }

  execSQL(sql: string): { tag: string; columns?: string[]; rows?: (string | null)[][] } {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper === 'BEGIN') return { tag: 'BEGIN' };
    if (upper === 'COMMIT') return { tag: 'COMMIT' };
    if (upper === 'ROLLBACK') return { tag: 'ROLLBACK' };

    // SELECT <literal>  e.g. SELECT 1, SELECT 'hello'
    const litMatch = trimmed.match(/^SELECT\s+(.+)$/i);
    if (litMatch && !upper.includes(' FROM ')) {
      const expr = litMatch[1].replace(/;$/, '').trim();
      const vals = expr.split(',').map(v => v.trim().replace(/^'|'$/g, ''));
      const cols = vals.map((_, i) => vals.length === 1 ? '?column?' : `col${i + 1}`);
      return { tag: 'SELECT 1', columns: cols, rows: [vals] };
    }

    // SELECT cols FROM table [WHERE ...]
    const selMatch = trimmed.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?;?$/i);
    if (selMatch) {
      const colExpr = selMatch[1].trim();
      const table = selMatch[2];
      const where = selMatch[3];
      let rows = this.getTable(table);
      if (where) rows = this._filterWhere(rows, where);
      const cols = colExpr === '*'
        ? (rows.length > 0 ? Object.keys(rows[0]) : [])
        : colExpr.split(',').map(c => c.trim());
      const data = rows.map(r => cols.map(c => r[c] ?? null));
      return { tag: `SELECT ${data.length}`, columns: cols, rows: data };
    }

    // INSERT INTO table (cols) VALUES (vals)
    const insMatch = trimmed.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\);?$/i);
    if (insMatch) {
      const table = insMatch[1];
      const cols = insMatch[2].split(',').map(c => c.trim());
      const vals = insMatch[3].split(',').map(v => v.trim().replace(/^'|'$/g, ''));
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = vals[i] ?? null; });
      const existing = this._tables.get(table.toLowerCase()) ?? [];
      existing.push(row);
      this._tables.set(table.toLowerCase(), existing);
      return { tag: 'INSERT 0 1' };
    }

    // UPDATE table SET col=val WHERE col=val
    const updMatch = trimmed.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+?);?$/i);
    if (updMatch) {
      const table = updMatch[1];
      const sets = this._parseAssignments(updMatch[2]);
      const rows = this.getTable(table);
      let count = 0;
      for (const r of rows) {
        if (this._matchesWhere(r, updMatch[3])) {
          for (const [k, v] of Object.entries(sets)) r[k] = v;
          count++;
        }
      }
      return { tag: `UPDATE ${count}` };
    }

    // DELETE FROM table WHERE col=val
    const delMatch = trimmed.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+?);?$/i);
    if (delMatch) {
      const tName = delMatch[1].toLowerCase();
      const rows = this._tables.get(tName) ?? [];
      const remaining = rows.filter(r => !this._matchesWhere(r, delMatch[2]));
      const count = rows.length - remaining.length;
      this._tables.set(tName, remaining);
      return { tag: `DELETE ${count}` };
    }

    throw new SimNodeUnsupportedPGFeature(sql);
  }

  private _filterWhere(rows: Row[], where: string): Row[] {
    return rows.filter(r => this._matchesWhere(r, where));
  }

  private _matchesWhere(row: Row, where: string): boolean {
    const m = where.match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) return false;
    const val = m[2].trim().replace(/^'|'$/g, '');
    return row[m[1].trim()] === val;
  }

  private _parseAssignments(expr: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const part of expr.split(',')) {
      const [k, v] = part.split('=').map(s => s.trim());
      result[k] = v.replace(/^'|'$/g, '');
    }
    return result;
  }
}

class PgConnection {
  private _phase: 'startup' | 'ready' = 'startup';
  private _txState: 'I' | 'T' | 'E' = 'I';

  constructor(private _store: PgStore) {}

  processData(data: Buffer): TcpHandlerResult {
    if (this._phase === 'startup') {
      const parsed = proto.parseStartupMsg(data);
      if ('isSSL' in parsed) return Buffer.from('N');
      this._phase = 'ready';
      return proto.startupResponse();
    }

    if (data[0] !== 0x51) { // Not 'Q'
      throw new SimNodeUnsupportedPGFeature(`Message type: ${String.fromCharCode(data[0])}`);
    }

    const sql = proto.parseQueryMsg(data);
    try {
      const result = this._store.execSQL(sql);
      if (result.tag === 'BEGIN') this._txState = 'T';
      else if (result.tag === 'COMMIT' || result.tag === 'ROLLBACK') this._txState = 'I';

      const bufs: Buffer[] = [];
      if (result.columns && result.rows) {
        bufs.push(proto.rowDescription(result.columns));
        for (const row of result.rows) bufs.push(proto.dataRow(row));
      }
      bufs.push(proto.commandComplete(result.tag));
      bufs.push(proto.readyForQuery(this._txState));
      return Buffer.concat(bufs);
    } catch (err) {
      if (err instanceof SimNodeUnsupportedPGFeature) throw err;
      return Buffer.concat([
        proto.errorResponse(err instanceof Error ? err.message : String(err)),
        proto.readyForQuery(this._txState === 'T' ? 'E' : 'I'),
      ]);
    }
  }
}

export class PgMock {
  readonly store: PgStore;
  private _connections = new Map<number, PgConnection>();

  constructor() { this.store = new PgStore(); }

  seedData(table: string, rows: Row[]): void { this.store.seedData(table, rows); }

  createHandler(): TcpMockHandler {
    return (data: Buffer, ctx: TcpMockContext): TcpHandlerResult => {
      if (!this._connections.has(ctx.socketId)) {
        this._connections.set(ctx.socketId, new PgConnection(this.store));
      }
      return this._connections.get(ctx.socketId)!.processData(data);
    };
  }
}

export { proto };
