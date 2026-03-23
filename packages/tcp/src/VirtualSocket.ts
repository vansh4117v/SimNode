import { Duplex } from 'node:stream';
import type { TcpMockHandler, TcpMockConfig, IClock, IScheduler, TcpHandlerResult } from './types.js';

let nextSocketId = 0;

/**
 * In-memory duplex stream that replaces a real `net.Socket`.
 *
 * - `write()` feeds data to the registered mock handler.
 * - Handler responses are emitted as `'data'` events, optionally delayed
 *   via the virtual clock / scheduler.
 * - All completions go through `scheduler.enqueueCompletion` when a scheduler
 *   is attached — even zero-latency ones — ensuring PRNG ordering applies to
 *   all same-tick I/O completions.
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
  private readonly _getLatency: () => number;
  private readonly _clock?: IClock;
  private readonly _scheduler?: IScheduler;
  private _connected = false;

  constructor(opts: {
    host: string;
    port: number;
    config: TcpMockConfig;
    clock?: IClock;
    scheduler?: IScheduler;
    /** Optional dynamic latency getter. When provided, overrides config.latency on every write. */
    getLatency?: () => number;
  }) {
    super({ allowHalfOpen: true });
    this.id = nextSocketId++;
    this.remoteAddress = opts.host;
    this.remotePort = opts.port;
    this._handler = opts.config.handler;
    this._getLatency = opts.getLatency ?? (() => opts.config.latency ?? 0);
    this._clock = opts.clock;
    this._scheduler = opts.scheduler;
  }

  // Connection lifecycle

  /** Simulate connection establishment (called by the interceptor). */
  _simulateConnect(): void {
    // Guard against destroyed socket to prevent connect race
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

    // Read latency dynamically so that re-mocking a target with new latency
    // affects existing sockets (no disconnect/reconnect needed).
    const latency = this._getLatency();

    // When a scheduler is present it receives ALL completions — both zero
    // and nonzero latency — so PRNG-controlled ordering covers every I/O op.
    // Without a scheduler, nonzero latency uses clock.setTimeout.  Having
    // neither scheduler nor clock is a misconfiguration: throw rather than
    // silently falling back to non-deterministic microtask delivery.
    if (this._scheduler) {
      const now = this._clock?.now() ?? 0;
      const when = now + Math.max(0, latency);
      this._scheduler.enqueueCompletion({
        id: `tcp-${this.id}-${now}`,
        when,
        run: deliver,
      });
      if (latency <= 0) {
        this._scheduler.requestRunTick?.(now);
      }
    } else if (this._clock && latency > 0) {
      // Clock-only path (no scheduler), nonzero latency.
      this._clock.setTimeout(() => { void deliver(); }, latency);
    } else {
      callback(new Error(
        '[SimNode] VirtualSocket: a Scheduler is required for deterministic I/O delivery. ' +
        'Pass { scheduler } when constructing TcpInterceptor.',
      ));
      return;
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
