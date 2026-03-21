/**
 * @simnode/mongo
 *
 * MongoDB mock backed by a shared MongoMemoryServer (started once per
 * Simulation.run()).  Connections are proxied verbatim to the real mongod
 * process via MongoProxyConnection — no custom BSON or wire-protocol
 * encoding is needed here.
 */

import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as net from 'node:net';

// ---------------------------------------------------------------------------
// MongoMock options
// ---------------------------------------------------------------------------

export interface MongoMockOpts {
  /** Hostname of the shared MongoMemoryServer (provided by Simulation.run()). */
  mongoHost?: string;
  /** Port of the shared MongoMemoryServer. */
  mongoPort?: number;
  /** Per-scenario database name (e.g. sim_db_42). */
  mongoDbName?: string;
}

// ---------------------------------------------------------------------------
// MongoProxyConnection — per-client-connection TCP proxy to real mongod
// ---------------------------------------------------------------------------


/** A pending upstream request waiting for its response. */
interface PendingResponse {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

/**
 * One proxy connection to the real mongod process.
 * Incoming bytes are forwarded verbatim; responses are reassembled from the
 * MongoDB wire-protocol framing (first 4 bytes = LE message length) and
 * delivered back to the caller as Promises so the scheduler can inject
 * virtual latency before the bytes are handed to the simulated client.
 */
class MongoProxyConnection {
  private _upstream: net.Socket;
  private _recvBuf  = Buffer.alloc(0);
  private _pending: PendingResponse[] = [];
  private _closed   = false;

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
    this._upstream.on('close', ()              => { this._closed = true; this._onError(new Error('mongod connection closed')); });
  }

  async send(data: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this._closed) { reject(new Error('mongod connection closed')); return; }
      this._pending.push({ resolve, reject });
      this._upstream.write(data);
    });
  }

  destroy(): void {
    this._closed = true;
    this._upstream.destroy();
  }

  private _onData(chunk: Buffer): void {
    this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
    // Drain complete MongoDB frames (framed by first 4 bytes = LE message length)
    while (this._recvBuf.length >= 4) {
      const msgLen = this._recvBuf.readInt32LE(0);
      if (this._recvBuf.length < msgLen) break;
      const frame = this._recvBuf.slice(0, msgLen);
      this._recvBuf  = this._recvBuf.slice(msgLen);
      const waiter  = this._pending.shift();
      if (waiter) waiter.resolve(frame);
    }
  }

  private _onError(err: Error): void {
    for (const w of this._pending) w.reject(err);
    this._pending = [];
  }
}

// ---------------------------------------------------------------------------
// MongoMock — public API
// ---------------------------------------------------------------------------

export class MongoMock {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _dbName: string;
  private _proxies = new Map<number, MongoProxyConnection>();
  /** Real Socket.prototype.connect captured before TcpInterceptor patches it. */
  private _realSocketConnect: Function;
  /** Lazily created MongoClient for assertion methods (find, drop). */
  private _clientPromise: Promise<import('mongodb').MongoClient> | null = null;

  constructor(opts?: MongoMockOpts) {
    this._host   = opts?.mongoHost   ?? '127.0.0.1';
    this._port   = opts?.mongoPort   ?? 27017;
    this._dbName = opts?.mongoDbName ?? 'test';
    // Capture REAL Socket.prototype.connect before TcpInterceptor patches it.
    this._realSocketConnect = net.Socket.prototype.connect;
  }

  // ── Assertion API ───────────────────────────────────────────────────────────

  /**
   * Query the scenario's MongoDB database directly via the driver.
   * Returns plain objects (EJSON-decoded by the driver).
   */
  async find(collection: string, filter: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const client = await this._getClient();
    return client.db(this._dbName).collection(collection).find(filter).toArray() as Promise<Record<string, unknown>[]>;
  }

  /**
   * Drop the scenario's database and close the driver connection.
   * Called in the worker's finally block for clean isolation.
   */
  async drop(): Promise<void> {
    if (!this._clientPromise) return;
    try {
      const client = await this._clientPromise;
      await client.db(this._dbName).dropDatabase();
      await client.close();
    } catch { /* ignore if db was never used */ }
    this._clientPromise = null;
    for (const p of this._proxies.values()) p.destroy();
    this._proxies.clear();
  }

  // ── TCP handler ─────────────────────────────────────────────────────────────

  /**
   * Returns a TcpMockHandler that proxies raw MongoDB wire-protocol bytes to
   * the shared mongod.  Latency injection is handled by TcpInterceptor.
   */
  createHandler(): TcpMockHandler {
    return async (data: Buffer, ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      if (!this._proxies.has(ctx.socketId)) {
        this._proxies.set(
          ctx.socketId,
          new MongoProxyConnection(this._host, this._port, this._realSocketConnect),
        );
      }
      const proxy = this._proxies.get(ctx.socketId)!;
      try {
        return await proxy.send(data);
      } catch {
        return null;
      }
    };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _getClient(): Promise<import('mongodb').MongoClient> {
    if (!this._clientPromise) {
      this._clientPromise = import('mongodb').then(({ MongoClient }) =>
        MongoClient.connect(`mongodb://${this._host}:${this._port}`),
      );
    }
    return this._clientPromise;
  }
}
