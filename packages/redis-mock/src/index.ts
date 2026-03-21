/**
 * @simnode/redis-mock
 *
 * Pure in-memory Redis mock backed by ioredis-mock.  No external Redis
 * binary or compilation step is needed.  Incoming RESP commands from the
 * TCP interceptor are parsed, executed against ioredis-mock, and the
 * results are encoded back into RESP wire format.
 */

import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import Redis from 'ioredis-mock';

// ---------------------------------------------------------------------------
// RESP parser — extract [command, ...args] arrays from raw bytes
// ---------------------------------------------------------------------------

/** Measure the byte-length of one complete RESP value at `offset`, or -1 if incomplete. */
function respValueLength(buf: Buffer, offset: number): number {
  if (offset >= buf.length) return -1;
  const type = buf[offset];
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd < 0) return -1;

  switch (type) {
    case 0x2b: // + Simple string
    case 0x2d: // - Error
    case 0x3a: // : Integer
      return lineEnd - offset + 2;

    case 0x24: { // $ Bulk string
      const len = parseInt(buf.toString('utf8', offset + 1, lineEnd));
      if (len < 0) return lineEnd - offset + 2; // $-1\r\n (null)
      const dataEnd = lineEnd + 2 + len + 2;
      if (dataEnd > buf.length) return -1;
      return dataEnd - offset;
    }

    case 0x2a: { // * Array
      const count = parseInt(buf.toString('utf8', offset + 1, lineEnd));
      if (count < 0) return lineEnd - offset + 2; // *-1\r\n (null array)
      let pos = lineEnd + 2;
      for (let i = 0; i < count; i++) {
        const elemLen = respValueLength(buf, pos);
        if (elemLen < 0) return -1;
        pos += elemLen;
      }
      return pos - offset;
    }

    default:
      return lineEnd - offset + 2;
  }
}

/** Parse a single RESP array command into a string[] of [command, ...args]. */
function parseRESPArray(buf: Buffer, offset: number): { args: string[]; consumed: number } | null {
  if (offset >= buf.length) return null;

  // Inline command (plain text line)
  if (buf[offset] !== 0x2a /* '*' */) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const line = buf.toString('utf8', offset, lineEnd);
    return { args: line.split(/\s+/), consumed: lineEnd + 2 - offset };
  }

  const firstLine = buf.indexOf('\r\n', offset);
  if (firstLine < 0) return null;
  const count = parseInt(buf.toString('utf8', offset + 1, firstLine));
  if (count < 0) return { args: [], consumed: firstLine + 2 - offset };

  let pos = firstLine + 2;
  const args: string[] = [];

  for (let i = 0; i < count; i++) {
    if (pos >= buf.length) return null;
    if (buf[pos] === 0x24 /* '$' */) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd < 0) return null;
      const len = parseInt(buf.toString('utf8', pos + 1, lineEnd));
      if (len < 0) { args.push(''); pos = lineEnd + 2; continue; }
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + len;
      if (dataEnd + 2 > buf.length) return null;
      args.push(buf.toString('utf8', dataStart, dataEnd));
      pos = dataEnd + 2;
    } else {
      // Non-bulk inline element
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd < 0) return null;
      args.push(buf.toString('utf8', pos, lineEnd));
      pos = lineEnd + 2;
    }
  }

  return { args, consumed: pos - offset };
}

/** Parse all RESP commands from a buffer. */
function parseAllCommands(buf: Buffer): string[][] {
  const commands: string[][] = [];
  let offset = 0;
  while (offset < buf.length) {
    const result = parseRESPArray(buf, offset);
    if (!result) break;
    if (result.args.length > 0) commands.push(result.args);
    offset += result.consumed;
  }
  return commands;
}

// ---------------------------------------------------------------------------
// RESP encoder — convert JS values back to RESP wire format
// ---------------------------------------------------------------------------

function encodeBulkString(s: string): string {
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}

/** Encode a JS value to RESP wire format. */
function encodeResp(value: unknown): string {
  if (value === null || value === undefined) return '$-1\r\n';
  if (typeof value === 'number') return `:${Math.floor(value)}\r\n`;
  if (typeof value === 'string') return encodeBulkString(value);
  if (value instanceof Error) return `-ERR ${value.message}\r\n`;
  if (Array.isArray(value)) {
    const parts = [`*${value.length}\r\n`];
    for (const el of value) parts.push(encodeResp(el));
    return parts.join('');
  }
  return encodeBulkString(String(value));
}

// Map of commands whose successful response should be a simple string (+OK)
// rather than a bulk string ($2\r\nOK\r\n).
const SIMPLE_STRING_COMMANDS = new Set([
  'SET', 'MSET', 'FLUSHDB', 'FLUSHALL', 'SELECT', 'PSETEX', 'SETEX',
  'RENAME', 'RESTORE', 'HMSET', 'LSET', 'LTRIM', 'DISCARD', 'MULTI',
  'EXEC', 'WATCH', 'UNWATCH', 'AUTH', 'QUIT', 'OK',
]);

/** Encode a command result, using +OK for commands that return simple strings. */
function encodeCommandResult(cmd: string, value: unknown): string {
  if (value === 'OK' && SIMPLE_STRING_COMMANDS.has(cmd.toUpperCase())) {
    return '+OK\r\n';
  }
  // PING returns simple string
  if (cmd.toUpperCase() === 'PING' && value === 'PONG') {
    return '+PONG\r\n';
  }
  return encodeResp(value);
}

// ---------------------------------------------------------------------------
// RedisMock — public API
// ---------------------------------------------------------------------------

export interface RedisMockOpts {
  /** Initial data to pre-populate (optional). */
  data?: Record<string, unknown>;
}

export class RedisMock {
  private _redis: InstanceType<typeof Redis>;
  /** Queued seedData pairs applied before first command. */
  private _seedPairs: Array<[string, string]> = [];
  private _seeded = false;

  constructor(opts?: RedisMockOpts) {
    this._redis = new Redis({ data: opts?.data ?? {} });
  }

  /**
   * Seed a key-value pair into the store.
   */
  seedData(key: string, value: string): void {
    this._seedPairs.push([key, value]);
  }

  /**
   * Flush the database.
   * Called during teardown for clean isolation.
   */
  async flush(): Promise<void> {
    await this._redis.flushdb();
    this._seeded = false;
  }

  // ── TCP handler ─────────────────────────────────────────────────────────

  createHandler(): TcpMockHandler {
    return async (data: Buffer, _ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      // Apply seed data on first interaction
      if (!this._seeded) {
        this._seeded = true;
        for (const [k, v] of this._seedPairs) {
          await this._redis.set(k, v);
        }
      }

      const commands = parseAllCommands(data);
      if (commands.length === 0) return null;

      const responseParts: string[] = [];

      for (const [cmd, ...args] of commands) {
        const upper = cmd.toUpperCase();
        const lower = cmd.toLowerCase();
        try {
          const fn = (this._redis as any)[lower];
          if (typeof fn !== 'function') {
            responseParts.push(`-ERR unknown command '${upper}'\r\n`);
            continue;
          }
          const result = await fn.apply(this._redis, args);
          responseParts.push(encodeCommandResult(upper, result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          responseParts.push(`-ERR ${msg}\r\n`);
        }
      }

      return Buffer.from(responseParts.join(''));
    };
  }
}
