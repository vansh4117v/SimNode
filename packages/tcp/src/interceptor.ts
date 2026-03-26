import * as net from 'node:net';
import * as dns from 'node:dns';
import { createRequire } from 'node:module';
import { VirtualSocket } from './VirtualSocket.js';
import { patchDns, registerMockedHost, clearMockedHosts, dnsConfig } from './dns.js';
import type { IClock, IScheduler, TcpMockConfig, TcpMockHandler } from './types.js';
import { SimNodeUnmockedTCPConnectionError, SimNodeUnsupportedProtocolError } from './types.js';

// CJS reference for mutable patching (same technique as @crashlab/http-proxy)
const _require = createRequire(import.meta.url);
const netCjs = _require('node:net') as typeof net;
const dnsCjs = _require('node:dns') as typeof dns;


export interface TcpInterceptorOptions {
  clock?: IClock;
  scheduler?: IScheduler;
}

/** Handle returned by addLocalServer. Lets callers stop a specific local server. */
export interface LocalServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Intercepts all outbound TCP connections and routes them to registered
 * mock handlers.  Real network is never touched.
 *
 * Patches:
 * - `net.createConnection`
 * - `net.connect`
 * - `new net.Socket()` + `.connect()`
 *
 * Additionally supports a "local TCP server" layer: `addLocalServer(port, handler)`
 * starts a real `net.Server` bound to `127.0.0.1:<port>` so that out-of-process
 * binaries (e.g. Prisma's query engine) can connect to a loopback address and have
 * their data routed through the same mock handler + scheduler pipeline.
 */
export class TcpInterceptor {
  private readonly _mocks = new Map<string, TcpMockConfig>();
  private readonly _clock?: IClock;
  private readonly _scheduler?: IScheduler;
  private readonly _sockets: VirtualSocket[] = [];

  private _partitioned = false;
  private _extraLatency = 0;

  private _origCreateConnection?: typeof net.createConnection;
  private _origConnect?: typeof net.connect;
  private _origSocketConnect?: typeof net.Socket.prototype.connect;
  private _origDnsLookup?: any;
  private _origDnsResolve?: any;
  private _origDnsResolve4?: any;

  /** Local TCP servers started via addLocalServer(). */
  private readonly _localServers: Map<number, net.Server> = new Map();
  /** Auto-incrementing socket ID for local server connections (offset to avoid collision with VirtualSocket IDs). */
  private _nextLocalSocketId = 100_000;
  /** Auto-incrementing socket ID for client VirtualSockets. */
  private _nextSocketId = 0;

  /** Keys that have ever been registered via mock() during this interceptor's lifetime. */
  private _everMockedKeys = new Set<string>();

  constructor(opts?: TcpInterceptorOptions) {
    this._clock = opts?.clock;
    this._scheduler = opts?.scheduler;
  }

  // mock registration

  /**
   * Register a TCP mock.
   *
   * @param target  `"host:port"` or a URL string like `"postgres://localhost:5432"`
   * @param config  Handler + optional latency
   */
  mock(target: string, config: TcpMockConfig): this {
    const key = normalizeTarget(target);
    this._mocks.set(key, config);
    this._everMockedKeys.add(key);
    const hostname = key.split(':')[0];
    if (hostname) registerMockedHost(hostname);
    return this;
  }

  /** Remove all registered mocks and recorded sockets. */
  reset(): void {
    this._mocks.clear();
    this._everMockedKeys.clear();
    this._sockets.length = 0;
    this._nextSocketId = 0;
    this._partitioned = false;
    this._extraLatency = 0;
    clearMockedHosts();
  }

  /** Expose DNS config */
  get dnsConfig(): { throwOnUnmocked: boolean } {
     return dnsConfig;
  }

  /** All VirtualSockets created during this session. */
  get sockets(): ReadonlyArray<VirtualSocket> {
    return this._sockets;
  }

  /**
   * Block all new TCP connections for `duration` virtual ms.
   * If a clock is attached, an automatic unblock is scheduled.
   */
  blockAll(duration: number): void {
    this._partitioned = true;
    if (this._clock) {
      this._clock.setTimeout(() => { this._partitioned = false; }, duration);
    } else {
      console.warn(
        'SimNode: TcpInterceptor.blockAll() called without a virtual clock. ' +
        'Falling back to real setTimeout — partition duration will be wall-clock, not deterministic.',
      );
      setTimeout(() => { this._partitioned = false; }, duration);
    }
  }

  /**
   * Add extra latency (ms) to all subsequent TCP responses.
   * Accumulates — call with 0 to reset.
   */
  setDefaultLatency(ms: number): void {
    this._extraLatency = ms;
  }

  // --------------------------------------------------------------------------
  // Local TCP server layer
  // --------------------------------------------------------------------------

  /**
   * Start a real `net.Server` on `127.0.0.1:<port>` that routes incoming
   * connections through `handler` using the same latency + scheduler pipeline
   * as the client-side interceptor.
   *
   * This is required for out-of-process binaries (e.g. Prisma's Rust query
   * engine) that cannot be intercepted via module patching.
   *
   * The returned `LocalServerHandle` lets the caller stop this specific server.
   * `uninstall()` automatically stops all local servers.
   */
  addLocalServer(port: number, handler: TcpMockHandler, latency = 0, onError?: (err: Error) => void): LocalServerHandle {
    if (this._localServers.has(port)) {
      // Already listening — return a handle to the existing server
      const existing = this._localServers.get(port)!;
      return {
        port,
        close: () => new Promise<void>((res, rej) => existing.close(err => err ? rej(err) : res())),
      };
    }

    const clock = this._clock;
    const scheduler = this._scheduler;
    const sockets = this._sockets;
    const extraLatencyRef = () => this._extraLatency;

    const server = net.createServer((socket) => {
      const localSocketId = this._nextLocalSocketId++;
      let localWriteSeq = 0;
      socket.on('data', (data: Buffer) => {
        const effectiveLatency = latency + extraLatencyRef();
        const deliver = async () => {
          try {
            const result = await handler(data, {
              remoteHost: socket.remoteAddress ?? '127.0.0.1',
              remotePort: socket.remotePort ?? port,
              socketId: localSocketId,
            });
            if (result == null) return;
            const bufs = Array.isArray(result) ? result : [result];
            for (const buf of bufs) {
              if (!socket.destroyed) socket.write(buf);
            }
          } catch (err) {
            if (!socket.destroyed) {
              socket.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          }
        };

        if (scheduler) {
          const writeSeq = localWriteSeq++;
          const now = clock?.now() ?? 0;
          const when = now + Math.max(0, effectiveLatency);
          const opId = `local-${port}-${localSocketId}-${writeSeq}-${now}`;
          scheduler.enqueueCompletion({ id: opId, when, run: deliver });
          if (effectiveLatency <= 0) {
            scheduler.requestRunTick?.(now);
          }
        } else if (clock && effectiveLatency > 0) {
          clock.setTimeout(() => { void deliver(); }, effectiveLatency);
        } else {
          socket.destroy(new Error(
            '[SimNode] local server: a Scheduler is required for deterministic I/O delivery. ' +
            'Pass { scheduler } when constructing TcpInterceptor.',
          ));
        }
      });
    });

    server.on('error', (err: Error) => { onError?.(err); });
    server.listen(port, '127.0.0.1');
    this._localServers.set(port, server);

    return {
      port,
      close: () => new Promise<void>((res, rej) => server.close(err => err ? rej(err) : res())),
    };
  }

  /** Stop all local TCP servers (called automatically by uninstall()). */
  stopLocalServers(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [port, server] of this._localServers) {
      this._localServers.delete(port);
      if (!server.listening) continue; // never bound (e.g. EADDRINUSE) — skip
      closes.push(new Promise<void>((res) => server.close(() => res())));
    }
    return Promise.all(closes).then(() => undefined);
  }

  // patching

  install(): void {
    this._origCreateConnection = netCjs.createConnection;
    this._origConnect = netCjs.connect;
    this._origSocketConnect = netCjs.Socket.prototype.connect;

    this._origDnsLookup = dns.lookup;
    this._origDnsResolve = dns.resolve;
    this._origDnsResolve4 = dns.resolve4;

    // Register all currently mocked hosts
    for (const key of this._mocks.keys()) {
        const hostname = key.split(':')[0];
        if (hostname) registerMockedHost(hostname);
    }

    const { customLookup, customResolve, customResolve4, customResolve6 } = patchDns({
        lookup: this._origDnsLookup,
        resolve: this._origDnsResolve,
        resolve4: this._origDnsResolve4,
    });

    (dnsCjs as any).lookup = customLookup;
    (dnsCjs as any).resolve = customResolve;
    (dnsCjs as any).resolve4 = customResolve4;
    (dnsCjs as any).resolve6 = customResolve6;
    if (dnsCjs.promises) {
        (dnsCjs.promises as any).lookup = customLookup;
        (dnsCjs.promises as any).resolve = customResolve;
        (dnsCjs.promises as any).resolve4 = customResolve4;
        (dnsCjs.promises as any).resolve6 = customResolve6;
    }

    const self = this;

    const fakeCreateConnection = function (
      this: unknown,
      ...args: unknown[]
    ): VirtualSocket | net.Socket {
      const { host, port } = normalizeNetArgs(args);
      // Passthrough: unmocked localhost connections use real sockets.
      // This allows supertest, local test servers, etc. to work.
      // Only truly unknown ports pass through — ports that were ever
      // registered via mock() still go through the interceptor.
      const key = `${normalizeHost(host)}:${port}`;
      if (!self._mocks.has(key) && !self._everMockedKeys.has(key) && normalizeHost(host) === 'localhost') {
        return self._origCreateConnection!.apply(null, args as any);
      }
      return self._intercept(host, port);
    } as unknown as typeof net.createConnection;

    netCjs.createConnection = fakeCreateConnection;
    netCjs.connect = fakeCreateConnection as typeof net.connect;

    // Patch Socket.prototype.connect so `new net.Socket().connect()`
    // also goes through the interceptor.
    //
    // Libraries like `pg` do `const s = new net.Socket(); s.connect(...)`.
    // They keep a reference to `s` (the real Socket) and write/read on it.
    // We cannot simply return a VirtualSocket — the caller ignores the
    // return value.  Instead we turn the REAL socket into a proxy:
    //  - Override _write so writes go to VirtualSocket's mock handler.
    //  - Pipe VirtualSocket responses back via the real socket's push().
    //  - Forward lifecycle events (connect, close, error, end).
    netCjs.Socket.prototype.connect = function (
      this: net.Socket,
      ...args: unknown[]
    ): net.Socket {
      const { host, port } = normalizeNetArgs(args);
      // Passthrough: unmocked localhost connections use real sockets.
      const key = `${normalizeHost(host)}:${port}`;
      if (!self._mocks.has(key) && !self._everMockedKeys.has(key) && normalizeHost(host) === 'localhost') {
        return self._origSocketConnect!.apply(this, args as any);
      }
      const vs = self._intercept(host, port);
      // The caller (e.g. pg) holds a reference to `this` (the real
      // net.Socket) and will read/write on it.  We turn it into a thin
      // proxy that delegates everything to the VirtualSocket `vs`.
      const realSocket = this;
      const rs = realSocket as any;

      // Override the internal Duplex _write so data goes to VirtualSocket.
      rs._write = (
        chunk: Buffer | string,
        encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void => {
        vs._write(chunk as any, encoding, callback);
      };

      // Override _writev for batched/corked writes (pg corks the stream for
      // extended query protocol messages, then uncorks → Node calls _writev).
      rs._writev = (
        chunks: Array<{ chunk: Buffer | string; encoding: BufferEncoding }>,
        callback: (error?: Error | null) => void,
      ): void => {
        const combined = Buffer.concat(
          chunks.map(c => Buffer.isBuffer(c.chunk) ? c.chunk : Buffer.from(c.chunk, c.encoding)),
        );
        vs._write(combined as any, 'buffer' as BufferEncoding, callback);
      };

      // Override _read (pull-based reads) — data arrives via push(), no-op.
      rs._read = (): void => {};

      // Override end() to bypass the normal shutdown path that requires
      // a real TCP handle + ShutdownWrap.
      rs.end = (...args: unknown[]): net.Socket => {
        // Extract optional callback from end(data?, enc?, cb?) signature
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() as () => void : undefined;
        // If there's final data, write it first
        const data = args[0];
        if (data != null) realSocket.write(data as any, args[1] as any);
        // Signal writable end
        const ws = (realSocket as any)._writableState;
        if (ws && !ws.ended) ws.ended = true;
        vs.end();
        if (cb) queueMicrotask(cb);
        return realSocket;
      };

      // Override destroy to clean up both sockets without touching handles.
      rs.destroy = (err?: Error): net.Socket => {
        if (rs.destroyed) return realSocket;
        rs.destroyed = true;
        rs.connecting = false;
        if (err) vs.destroy(err); else vs.destroy();
        realSocket.emit('close', !!err);
        return realSocket;
      };

      // Pipe responses: VirtualSocket data → real socket readable side.
      vs.on('data', (data: Buffer) => {
        if (!rs.destroyed) realSocket.push(data);
      });

      // Forward lifecycle events from VirtualSocket → real socket.
      vs.on('connect', () => {
        rs.connecting = false;
        realSocket.emit('connect');
        realSocket.emit('ready');
      });
      vs.on('error', (err: Error) => {
        if (!rs.destroyed) realSocket.emit('error', err);
      });
      vs.on('end', () => {
        if (!rs.destroyed) {
          realSocket.push(null);
          realSocket.emit('end');
        }
      });

      return this;
    } as typeof net.Socket.prototype.connect;
  }

  uninstall(): void {
    if (this._origCreateConnection) netCjs.createConnection = this._origCreateConnection;
    if (this._origConnect) netCjs.connect = this._origConnect;
    if (this._origSocketConnect) netCjs.Socket.prototype.connect = this._origSocketConnect;

    if (this._origDnsLookup) {
        (dnsCjs as any).lookup = this._origDnsLookup;
        if (dnsCjs.promises) (dnsCjs.promises as any).lookup = this._origDnsLookup;
    }
    if (this._origDnsResolve) {
        (dnsCjs as any).resolve = this._origDnsResolve;
        if (dnsCjs.promises) (dnsCjs.promises as any).resolve = this._origDnsResolve;
    }
    if (this._origDnsResolve4) {
        (dnsCjs as any).resolve4 = this._origDnsResolve4;
        if (dnsCjs.promises) (dnsCjs.promises as any).resolve4 = this._origDnsResolve4;
    }

    this._partitioned = false;
    this._extraLatency = 0;

    // Stop all local servers (non-blocking; caller should await stopLocalServers() separately
    // if they need to wait for full teardown)
    void this.stopLocalServers();
  }

  // internal

  private _intercept(host: string, port: number): VirtualSocket {
    if (this._partitioned) {
      throw Object.assign(
        new Error(`SimNode: Network partition active — TCP connection to ${host}:${port} rejected`),
        { code: 'ECONNREFUSED' },
      );
    }

    // Explicitly unsupported protocols — give a clear, actionable error
    if (port === 3306) throw new SimNodeUnsupportedProtocolError('MySQL');

    const key = `${normalizeHost(host)}:${port}`;
    const config = this._mocks.get(key);

    if (!config) {
      throw new SimNodeUnmockedTCPConnectionError(host, port);
    }

    // Dynamic latency getter: reads from the live _mocks map on every write
    // so that re-mocking a target with new latency affects existing sockets.
    const mocks = this._mocks;
    const extraLatencyRef = this;
    const getLatency = (): number => {
      const current = mocks.get(key);
      return (current?.latency ?? 0) + extraLatencyRef._extraLatency;
    };

    const socket = new VirtualSocket({
      id: this._nextSocketId++,
      host,
      port,
      config,
      clock: this._clock,
      scheduler: this._scheduler,
      getLatency,
    });

    this._sockets.push(socket);

    // Simulate async connection establishment — guard against destroyed sockets
    queueMicrotask(() => {
      if (!socket.destroyed) socket._simulateConnect();
    });

    return socket;
  }
}

// Helpers

/**
 * Canonicalize loopback addresses so that `127.0.0.1`, `::1`, `[::1]`,
 * and `localhost` all resolve to the single key `"localhost"`.
 */
function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  if (h === '127.0.0.1' || h === '::1' || h === '[::1]') return 'localhost';
  return h;
}

/**
 * Normalize a target string to `"host:port"`.
 * Accepts `"host:port"`, `"postgres://host:port"`, `"redis://host:port/0"`, etc.
 */
function normalizeTarget(target: string): string {
  if (target.includes('://')) {
    try {
      const u = new URL(target);
      const defaultPort =
        u.protocol === 'postgres:' || u.protocol === 'postgresql:' ? '5432' :
        u.protocol === 'redis:' || u.protocol === 'rediss:' ? '6379' :
        u.protocol === 'mongodb:' || u.protocol === 'mongodb+srv:' ? '27017' :
        undefined;
      const port = u.port || defaultPort || '6379';
      return `${normalizeHost(u.hostname)}:${port}`;
    } catch {
      // fall through to raw split
    }
  }
  // Already "host:port"
  const [rawHost, ...rest] = target.split(':');
  return `${normalizeHost(rawHost)}:${rest.join(':')}`;
}

/**
 * Normalize the overloaded argument shapes of net.createConnection / net.connect.
 *
 * Supported forms:
 * - `(port, host?)`
 * - `({ port, host? })`
 * - `(port, host?, connectListener?)`
 * - `({ port, host? }, connectListener?)`
 */
function normalizeNetArgs(args: unknown[]): { host: string; port: number } {
  const first = args[0];

  if (typeof first === 'number') {
    const host = typeof args[1] === 'string' ? normalizeHost(args[1]) : 'localhost';
    return { host, port: first };
  }

  if (typeof first === 'object' && first !== null) {
    const opts = first as Record<string, unknown>;
    return {
      host: normalizeHost((opts.host as string) ?? 'localhost'),
      port: (opts.port as number) ?? 0,
    };
  }

  return { host: 'localhost', port: 0 };
}
