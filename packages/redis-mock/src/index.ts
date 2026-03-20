/**
 * @simnode/redis-mock
 *
 * Redis mock backed by a real Redis process (started via redis-memory-server
 * or externally).  Connections are proxied verbatim to the real redis-server
 * via RedisProxyConnection — no custom RESP encoding or command
 * implementation is needed.
 */

import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as net from 'node:net';

// ---------------------------------------------------------------------------
// RedisMock options
// ---------------------------------------------------------------------------

export interface RedisMockOpts {
  /** Hostname of the Redis server (provided by Simulation.run()). */
  redisHost?: string;
  /** Port of the Redis server. */
  redisPort?: number;
}

// ---------------------------------------------------------------------------
// RESP response framer — only used for frame boundary detection,
// NOT for command execution.  Measures the byte-length of one
// complete RESP value starting at `offset`, or returns -1 if incomplete.
// ---------------------------------------------------------------------------

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
      // Inline response — consume to \r\n
      return lineEnd - offset + 2;
  }
}

/**
 * Count the number of top-level RESP commands in a request buffer.
 * Commands are either `*<N>\r\n...` arrays or inline `CMD arg...\r\n`.
 */
function countRESPCommands(buf: Buffer): number {
  let count = 0;
  let offset = 0;
  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) break;

    if (buf[offset] === 0x2a /* '*' */) {
      // RESP array command — skip it entirely
      const len = respValueLength(buf, offset);
      if (len < 0) break;
      offset += len;
      count++;
    } else {
      // Inline command
      offset = lineEnd + 2;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// RedisProxyConnection — per-client-connection TCP proxy to real redis-server
// ---------------------------------------------------------------------------

interface PendingRedisResponse {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  expected: number;
}

class RedisProxyConnection {
  private _upstream: net.Socket;
  private _recvBuf = Buffer.alloc(0);
  private _pending: PendingRedisResponse[] = [];
  private _closed = false;

  constructor(
    host: string,
    port: number,
    /** Real (pre-patch) Socket.prototype.connect so we bypass TcpInterceptor. */
    realSocketConnect: Function,
  ) {
    this._upstream = new net.Socket();
    realSocketConnect.call(this._upstream, { host, port });
    this._upstream.on('data',  (chunk: Buffer) => this._onData(chunk));
    this._upstream.on('error', (err: Error)    => this._onError(err));
    this._upstream.on('close', ()              => { this._closed = true; this._onError(new Error('redis connection closed')); });
  }

  async send(data: Buffer): Promise<Buffer> {
    const expected = countRESPCommands(data);
    return new Promise<Buffer>((resolve, reject) => {
      if (this._closed) { reject(new Error('redis connection closed')); return; }
      this._pending.push({ resolve, reject, expected });
      this._upstream.write(data);
    });
  }

  destroy(): void {
    this._closed = true;
    this._upstream.destroy();
  }

  private _onData(chunk: Buffer): void {
    this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
    this._drain();
  }

  private _drain(): void {
    while (this._pending.length > 0) {
      const front = this._pending[0];
      // Try to consume `expected` complete RESP values
      let consumed = 0;
      let count = 0;
      while (count < front.expected) {
        const vLen = respValueLength(this._recvBuf, consumed);
        if (vLen < 0) return; // incomplete — wait for more data
        consumed += vLen;
        count++;
      }
      // Got all responses for this request batch
      const responseBytes = Buffer.from(this._recvBuf.subarray(0, consumed));
      this._recvBuf = this._recvBuf.subarray(consumed);
      this._pending.shift();
      front.resolve(responseBytes);
    }
  }

  private _onError(err: Error): void {
    for (const w of this._pending) w.reject(err);
    this._pending = [];
  }
}

// ---------------------------------------------------------------------------
// RESP encoder (used only by seedData to build commands)
// ---------------------------------------------------------------------------

function encodeCommand(...args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return Buffer.from(parts.join(''));
}

// ---------------------------------------------------------------------------
// RedisMock — public API
// ---------------------------------------------------------------------------

export class RedisMock {
  private readonly _host: string;
  private readonly _port: number;
  private _proxies = new Map<number, RedisProxyConnection>();
  /** Real Socket.prototype.connect captured before TcpInterceptor patches it. */
  private _realSocketConnect: Function;
  /** Queued seedData commands to replay on a fresh proxy. */
  private _seedCommands: Buffer[] = [];

  constructor(opts?: RedisMockOpts) {
    this._host = opts?.redisHost ?? '127.0.0.1';
    this._port = opts?.redisPort ?? 6379;
    // Capture REAL Socket.prototype.connect before TcpInterceptor patches it.
    this._realSocketConnect = net.Socket.prototype.connect;
  }

  /**
   * Seed a key-value pair into the Redis server.
   * The command is queued and sent on first connection.
   */
  seedData(key: string, value: string): void {
    this._seedCommands.push(encodeCommand('SET', key, value));
  }

  /**
   * Flush the database and destroy all proxy connections.
   * Called during teardown for clean isolation.
   */
  async flush(): Promise<void> {
    // Send FLUSHDB on a temporary connection
    try {
      const proxy = new RedisProxyConnection(this._host, this._port, this._realSocketConnect);
      await proxy.send(encodeCommand('FLUSHDB'));
      proxy.destroy();
    } catch { /* ignore if server is gone */ }
    for (const p of this._proxies.values()) p.destroy();
    this._proxies.clear();
  }

  // ── TCP handler ─────────────────────────────────────────────────────────

  createHandler(): TcpMockHandler {
    return async (data: Buffer, ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      if (!this._proxies.has(ctx.socketId)) {
        const proxy = new RedisProxyConnection(this._host, this._port, this._realSocketConnect);
        this._proxies.set(ctx.socketId, proxy);
        // Replay seed commands on this new connection
        for (const cmd of this._seedCommands) {
          await proxy.send(cmd);
        }
      }
      const proxy = this._proxies.get(ctx.socketId)!;
      try {
        return await proxy.send(data);
      } catch {
        return null;
      }
    };
  }
}
