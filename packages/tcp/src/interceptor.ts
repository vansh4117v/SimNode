import * as net from 'node:net';
import * as dns from 'node:dns';
import { createRequire } from 'node:module';
import { VirtualSocket } from './VirtualSocket.js';
import { patchDns, registerMockedHost, clearMockedHosts, dnsConfig } from './dns.js';
import type { IClock, IScheduler, TcpMockConfig } from './types.js';
import { SimNodeUnmockedTCPConnectionError } from './types.js';

// CJS reference for mutable patching (same technique as @simnode/http-proxy)
const _require = createRequire(import.meta.url);
const netCjs = _require('node:net') as typeof net;
const dnsCjs = _require('node:dns') as typeof dns;

export interface TcpInterceptorOptions {
  clock?: IClock;
  scheduler?: IScheduler;
}

/**
 * Intercepts all outbound TCP connections and routes them to registered
 * mock handlers.  Real network is never touched.
 *
 * Patches:
 * - `net.createConnection`
 * - `net.connect`
 * - `new net.Socket()` + `.connect()`
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
    const hostname = key.split(':')[0];
    if (hostname) registerMockedHost(hostname);
    return this;
  }

  /** Remove all registered mocks and recorded sockets. */
  reset(): void {
    this._mocks.clear();
    this._sockets.length = 0;
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
      // Fall back to real timer for unblock
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

    const { customLookup, customResolve, customResolve4 } = patchDns({
        lookup: this._origDnsLookup,
        resolve: this._origDnsResolve,
        resolve4: this._origDnsResolve4,
    });

    (dnsCjs as any).lookup = customLookup;
    (dnsCjs as any).resolve = customResolve;
    (dnsCjs as any).resolve4 = customResolve4;
    if (dnsCjs.promises) {
        (dnsCjs.promises as any).lookup = customLookup;
        (dnsCjs.promises as any).resolve = customResolve;
        (dnsCjs.promises as any).resolve4 = customResolve4;
    }

    const self = this;

    const fakeCreateConnection = function (
      this: unknown,
      ...args: unknown[]
    ): VirtualSocket {
      const { host, port } = normalizeNetArgs(args);
      return self._intercept(host, port);
    } as unknown as typeof net.createConnection;

    netCjs.createConnection = fakeCreateConnection;
    netCjs.connect = fakeCreateConnection as typeof net.connect;

    // Patch Socket.prototype.connect so `new net.Socket().connect()`
    // also goes through the interceptor.
    netCjs.Socket.prototype.connect = function (
      this: net.Socket,
      ...args: unknown[]
    ): net.Socket {
      const { host, port } = normalizeNetArgs(args);
      const vs = self._intercept(host, port);
      // Copy event listeners from the real Socket to the VirtualSocket
      // (in case the consumer attached listeners before calling .connect())
      for (const event of ['data', 'error', 'close', 'connect', 'end'] as const) {
        for (const listener of this.listeners(event)) {
          vs.on(event, listener as (...a: unknown[]) => void);
        }
      }
      return vs as unknown as net.Socket;
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
  }

  // internal

  private _intercept(host: string, port: number): VirtualSocket {
    if (this._partitioned) {
      throw Object.assign(
        new Error(`SimNode: Network partition active — TCP connection to ${host}:${port} rejected`),
        { code: 'ECONNREFUSED' },
      );
    }

    const key = `${host}:${port}`;
    const config = this._mocks.get(key);

    if (!config) {
      throw new SimNodeUnmockedTCPConnectionError(host, port);
    }

    // Merge extra latency from fault injection
    const effectiveConfig: TcpMockConfig =
      this._extraLatency > 0
        ? { ...config, latency: (config.latency ?? 0) + this._extraLatency }
        : config;

    const socket = new VirtualSocket({
      host,
      port,
      config: effectiveConfig,
      clock: this._clock,
      scheduler: this._scheduler,
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
 * Normalize a target string to `"host:port"`.
 * Accepts `"host:port"`, `"postgres://host:port"`, `"redis://host:port/0"`, etc.
 */
function normalizeTarget(target: string): string {
  if (target.includes('://')) {
    try {
      const u = new URL(target);
      const port = u.port || (u.protocol === 'postgres:' || u.protocol === 'postgresql:' ? '5432' : '6379');
      return `${u.hostname}:${port}`;
    } catch {
      // fall through to raw split
    }
  }
  // Already "host:port"
  return target;
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
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { host, port: first };
  }

  if (typeof first === 'object' && first !== null) {
    const opts = first as Record<string, unknown>;
    return {
      host: (opts.host as string) ?? 'localhost',
      port: (opts.port as number) ?? 0,
    };
  }

  return { host: 'localhost', port: 0 };
}
