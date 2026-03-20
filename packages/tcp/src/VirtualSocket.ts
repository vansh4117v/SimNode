import { Duplex } from 'node:stream';
import type { TcpMockHandler, TcpMockConfig, IClock, IScheduler, TcpHandlerResult } from './types.js';

let nextSocketId = 0;

/**
 * In-memory duplex stream that replaces a real `net.Socket`.
 *
 * - `write()` feeds data to the registered mock handler.
 * - Handler responses are emitted as `'data'` events, optionally delayed
 *   via the virtual clock / scheduler.
 * - No real network I/O ever occurs.
 */
export class VirtualSocket extends Duplex {
  readonly id: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly remoteFamily: string = 'IPv4';

  /** Mirrors net.Socket properties consumers may check. */
  connecting = false;
  destroyed = false;
  readableEnded = false;

  private readonly _handler: TcpMockHandler;
  private readonly _latency: number;
  private readonly _clock?: IClock;
  private readonly _scheduler?: IScheduler;
  private _connected = false;

  constructor(opts: {
    host: string;
    port: number;
    config: TcpMockConfig;
    clock?: IClock;
    scheduler?: IScheduler;
  }) {
    super({ allowHalfOpen: true });
    this.id = nextSocketId++;
    this.remoteAddress = opts.host;
    this.remotePort = opts.port;
    this._handler = opts.config.handler;
    this._latency = opts.config.latency ?? 0;
    this._clock = opts.clock;
    this._scheduler = opts.scheduler;
  }

  // Connection lifecycle

  /** Simulate connection establishment (called by the interceptor). */
  _simulateConnect(): void {
    // Fix #8: guard against destroyed socket to prevent connect race
    if (this.destroyed) return;
    this.connecting = false;
    this._connected = true;
    this.emit('connect');
    this.emit('ready');
  }

  // Duplex implementation

  /** Called by stream internals when the consumer writes data. */
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    const deliver = async (): Promise<void> => {
      try {
        const result = await this._handler(buf, {
          remoteHost: this.remoteAddress,
          remotePort: this.remotePort,
          socketId: this.id,
        });
        this._emitResponse(result);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Schedule the handler through clock/scheduler if available
    if (this._latency > 0 && this._clock) {
      const when = this._clock.now() + this._latency;
      if (this._scheduler) {
        this._scheduler.enqueueCompletion({
          id: `tcp-${this.id}-${this._clock.now()}`,
          when,
          run: deliver,
        });
      } else {
        this._clock.setTimeout(() => { void deliver(); }, this._latency);
      }
    } else if (this._latency > 0 && this._scheduler) {
      // Scheduler without clock: enqueue at current time + latency placeholder
      this._scheduler.enqueueCompletion({
        id: `tcp-${this.id}-fallback`,
        when: this._latency,
        run: deliver,
      });
    } else {
      // No latency: deliver via microtask (avoids synchronous re-entrancy)
      queueMicrotask(() => { void deliver(); });
    }

    callback();
  }

  /** Called by stream internals for read demand. */
  override _read(): void {
    // Data is pushed via _emitResponse; nothing to do here.
  }

  /** Called by stream internals on end(). */
  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.destroyed = true;
    this._connected = false;
    this.emit('close', !!error);
    callback(error);
  }

  // net.Socket compat stubs

  connect(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  setEncoding(): this { return this; }
  setKeepAlive(): this { return this; }
  setNoDelay(): this { return this; }
  setTimeout(): this { return this; }
  address(): Record<string, unknown> {
    return { address: this.remoteAddress, port: this.remotePort, family: this.remoteFamily };
  }

  // Internal

  private _emitResponse(result: TcpHandlerResult): void {
    if (result == null) return;
    const buffers = Array.isArray(result) ? result : [result];
    for (const buf of buffers) {
      this.push(buf);
    }
  }
}
