import * as net from 'node:net';
import { createRequire } from 'node:module';
import { VirtualSocket } from './VirtualSocket.js';
import type { IClock, IScheduler, TcpMockConfig } from './types.js';
import { SimNodeUnmockedTCPConnectionError } from './types.js';

// CJS reference for mutable patching (same technique as @simnode/http-proxy)
const _require = createRequire(import.meta.url);
const netCjs = _require('node:net') as typeof net;

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

  private _origCreateConnection?: typeof net.createConnection;
  private _origConnect?: typeof net.connect;
  private _origSocketConnect?: typeof net.Socket.prototype.connect;

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
    return this;
  }

  /** Remove all registered mocks and recorded sockets. */
  reset(): void {
    this._mocks.clear();
    this._sockets.length = 0;
  }

  /** All VirtualSockets created during this session. */
  get sockets(): ReadonlyArray<VirtualSocket> {
    return this._sockets;
  }

  // patching

  install(): void {
    this._origCreateConnection = netCjs.createConnection;
    this._origConnect = netCjs.connect;
    this._origSocketConnect = netCjs.Socket.prototype.connect;

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
  }

  // internal

  private _intercept(host: string, port: number): VirtualSocket {
    const key = `${host}:${port}`;
    const config = this._mocks.get(key);

    if (!config) {
      throw new SimNodeUnmockedTCPConnectionError(host, port);
    }

    const socket = new VirtualSocket({
      host,
      port,
      config,
      clock: this._clock,
      scheduler: this._scheduler,
    });

    this._sockets.push(socket);

    // Simulate async connection establishment
    queueMicrotask(() => socket._simulateConnect());

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
