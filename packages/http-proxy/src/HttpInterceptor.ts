import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

// Types

/** Minimal virtual-clock interface (duck-typed). */
export interface IClock {
  now(): number;
  setTimeout(cb: (...args: unknown[]) => void, delay: number): number;
}

/** Minimal scheduler interface (duck-typed). */
export interface IScheduler {
  enqueueCompletion(op: { id: string; when: number; run: () => Promise<void> | void }): void;
}

export interface MockResponseConfig {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Virtual-clock latency in ms (requires an IClock instance). */
  latency?: number;
  /** Dynamic handler — overrides static body/status when provided. */
  handler?: (call: RecordedCall) => { status: number; body?: unknown; headers?: Record<string, string> };
}

export interface FailConfig {
  /** Succeed the first N calls, then error. */
  after?: number;
  error: string;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
}

// Fakes

class FakeIncomingMessage extends EventEmitter {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;

  constructor(status: number, headers: Record<string, string>, private readonly _body: string) {
    super();
    this.statusCode = status;
    this.statusMessage = http.STATUS_CODES[status] ?? '';
    this.headers = headers;
  }

  _flush(): void {
    queueMicrotask(() => {
      this.emit('data', Buffer.from(this._body));
      this.emit('end');
    });
  }
}

class FakeClientRequest extends EventEmitter {
  private _chunks: Buffer[] = [];
  headersSent = false;

  write(chunk: string | Buffer): boolean {
    this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) this.write(chunk);
    this.emit('_end');
    return this;
  }

  get body(): string {
    return Buffer.concat(this._chunks).toString();
  }

  // no-ops for compat
  setHeader(): this { return this; }
  getHeader(): undefined { return undefined; }
  removeHeader(): void {}
  flushHeaders(): void {}
  setTimeout(): this { return this; }
  setNoDelay(): void {}
  setSocketKeepAlive(): void {}
  abort(): void {}
  destroy(): this { return this; }
}

// Route

class MockRoute {
  readonly calls: RecordedCall[] = [];
  private _callCount = 0;

  constructor(
    readonly urlPrefix: string,
    readonly config: MockResponseConfig,
    readonly failConfig?: FailConfig,
  ) {}

  matches(url: string): boolean {
    return url.startsWith(this.urlPrefix);
  }

  respond(call: RecordedCall): { error?: string; status: number; headers: Record<string, string>; body: string } {
    this.calls.push(call);
    this._callCount++;

    if (this.failConfig) {
      const limit = this.failConfig.after ?? 0;
      if (this._callCount > limit) {
        return { error: this.failConfig.error, status: 0, headers: {}, body: '' };
      }
    }

    if (this.config.handler) {
      const r = this.config.handler(call);
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
      return { status: r.status, headers: r.headers ?? { 'content-type': 'application/json' }, body };
    }

    const body = typeof this.config.body === 'string'
      ? this.config.body
      : JSON.stringify(this.config.body ?? '');
    return {
      status: this.config.status ?? 200,
      headers: this.config.headers ?? { 'content-type': 'application/json' },
      body,
    };
  }
}

// Interceptor

// We need to write directly to the module object's internal property.
// ESM `import * as http` creates a frozen namespace — we can't assign
// to it.  Instead we grab the *CJS* module from require.cache and
// patch the exports object there, which IS mutable.
//
// We use createRequire so this file can stay ESM.
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const httpCjs = _require('node:http') as typeof http;
const httpsCjs = _require('node:https') as typeof https;

let _httpReqCounter = 0;

export class HttpInterceptor {
  private readonly _routes: MockRoute[] = [];
  private readonly _allCalls: RecordedCall[] = [];
  private readonly _clock?: IClock;
  private readonly _scheduler?: IScheduler;

  private _partitioned = false;

  private _origHttpRequest?: typeof http.request;
  private _origHttpGet?: typeof http.get;
  private _origHttpsRequest?: typeof https.request;
  private _origHttpsGet?: typeof https.get;

  constructor(opts?: { clock?: IClock; scheduler?: IScheduler }) {
    this._clock = opts?.clock;
    this._scheduler = opts?.scheduler;
  }

  // mock registration

  mock(urlPrefix: string, config: MockResponseConfig): this {
    this._routes.push(new MockRoute(urlPrefix, config));
    return this;
  }

  fail(urlPrefix: string, config: FailConfig): this {
    this._routes.push(new MockRoute(urlPrefix, { status: 0 }, config));
    return this;
  }

  calls(method?: string, urlPrefix?: string): RecordedCall[] {
    return this._allCalls.filter((c) => {
      if (method && c.method !== method.toUpperCase()) return false;
      if (urlPrefix && !c.url.startsWith(urlPrefix)) return false;
      return true;
    });
  }

  /**
   * Block all HTTP requests for `duration` virtual ms.
   * Requests made during the partition receive a connection-refused error.
   */
  blockAll(duration: number): void {
    this._partitioned = true;
    if (this._clock) {
      this._clock.setTimeout(() => { this._partitioned = false; }, duration);
    } else {
      setTimeout(() => { this._partitioned = false; }, duration);
    }
  }

  // patching

  install(): void {
    this._origHttpRequest = httpCjs.request;
    this._origHttpGet = httpCjs.get;
    this._origHttpsRequest = httpsCjs.request;
    this._origHttpsGet = httpsCjs.get;

    const self = this;

    const makeRequest = (proto: string) =>
      function fakeRequest(this: unknown, ...args: unknown[]): FakeClientRequest {
        const { url, method, headers, callback } = normalizeArgs(proto, args);
        return self._intercept(url, method, headers, callback);
      } as unknown as typeof http.request;

    const makeGet = (reqFn: typeof http.request) =>
      function fakeGet(this: unknown, ...args: unknown[]): FakeClientRequest {
        const req = (reqFn as any)(...args) as FakeClientRequest;
        req.end();
        return req;
      } as unknown as typeof http.get;

    httpCjs.request = makeRequest('http:');
    httpCjs.get = makeGet(httpCjs.request);
    httpsCjs.request = makeRequest('https:');
    httpsCjs.get = makeGet(httpsCjs.request);
  }

  uninstall(): void {
    if (this._origHttpRequest) httpCjs.request = this._origHttpRequest;
    if (this._origHttpGet) httpCjs.get = this._origHttpGet;
    if (this._origHttpsRequest) httpsCjs.request = this._origHttpsRequest;
    if (this._origHttpsGet) httpsCjs.get = this._origHttpsGet;
    this._partitioned = false;
  }

  reset(): void {
    this._routes.length = 0;
    this._allCalls.length = 0;
    this._partitioned = false;
  }

  // internal

  private _intercept(
    url: string,
    method: string,
    headers: Record<string, string>,
    callback?: (res: FakeIncomingMessage) => void,
  ): FakeClientRequest {
    const route = this._routes.find((r) => r.matches(url));
    const fakeReq = new FakeClientRequest();
    if (callback) fakeReq.on('response', callback);

    fakeReq.on('_end', () => {
      const call: RecordedCall = {
        method,
        url,
        headers,
        body: fakeReq.body,
        timestamp: this._clock?.now() ?? Date.now(),
      };
      this._allCalls.push(call);

      // Network partition: reject with error
      if (this._partitioned) {
        fakeReq.emit('error', Object.assign(new Error(`Network partition: ${method} ${url} rejected`), { code: 'ECONNREFUSED' }));
        return;
      }

      if (!route) {
        fakeReq.emit('error', new Error(`No mock matched: ${method} ${url}`));
        return;
      }

      let result: { error?: string; status: number; headers: Record<string, string>; body: string };
      try {
        result = route.respond(call);
      } catch (err: unknown) {
        fakeReq.emit('error', err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const deliver = (): void => {
        if (result.error) {
          fakeReq.emit('error', new Error(result.error));
          return;
        }
        const fakeRes = new FakeIncomingMessage(result.status, result.headers, result.body);
        fakeReq.emit('response', fakeRes);
        fakeRes._flush();
      };

      const latency = route.config.latency;
      if (latency && latency > 0 && this._clock) {
        const when = this._clock.now() + latency;
        // Fix #6: route through scheduler for deterministic same-tick ordering
        if (this._scheduler) {
          const opId = `http-${++_httpReqCounter}`;
          this._scheduler.enqueueCompletion({
            id: opId,
            when,
            run: () => { deliver(); return Promise.resolve(); },
          });
        } else {
          this._clock.setTimeout(deliver, latency);
        }
      } else {
        deliver();
      }
    });

    return fakeReq;
  }
}

// Helpers

function normalizeArgs(
  defaultProto: string,
  args: unknown[],
): { url: string; method: string; headers: Record<string, string>; callback?: (res: any) => void } {
  let url: string;
  let options: Record<string, any> = {};
  let callback: ((res: any) => void) | undefined;

  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    const parsed = new URL(args[0].toString());
    url = parsed.toString();
    if (typeof args[1] === 'function') {
      callback = args[1] as (res: any) => void;
    } else if (typeof args[1] === 'object' && args[1] !== null) {
      options = args[1] as Record<string, any>;
      if (typeof args[2] === 'function') callback = args[2] as (res: any) => void;
    }
  } else {
    options = (args[0] ?? {}) as Record<string, any>;
    if (typeof args[1] === 'function') callback = args[1] as (res: any) => void;
    const proto = (options.protocol as string) ?? defaultProto;
    const host = (options.hostname ?? options.host ?? 'localhost') as string;
    const port = options.port ? `:${options.port as string}` : '';
    const path = (options.path ?? '/') as string;
    url = `${proto}//${host}${port}${path}`;
  }

  return {
    url,
    method: ((options.method as string) ?? 'GET').toUpperCase(),
    headers: (options.headers ?? {}) as Record<string, string>,
    callback,
  };
}
