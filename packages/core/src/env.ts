import { VirtualClock } from '@simnode/clock';
import { install as installClock } from '@simnode/clock';
import { SeededRandom, mulberry32 } from '@simnode/random';
import { Scheduler } from '@simnode/scheduler';
import { HttpInterceptor } from '@simnode/http-proxy';
import { TcpInterceptor } from '@simnode/tcp';
import { VirtualFS } from '@simnode/filesystem';
import { PgMock } from '@simnode/pg-mock';
import { RedisMock } from '@simnode/redis-mock';
import { MongoMock } from '@simnode/mongo';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const cryptoCjs = _require('node:crypto') as typeof import('node:crypto');

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  timestamp: number;
  type: string;
  detail: string;
}

export class Timeline {
  private _events: TimelineEvent[] = [];
  record(evt: TimelineEvent): void { this._events.push(evt); }
  get events(): ReadonlyArray<TimelineEvent> { return this._events; }
  toString(): string {
    return this._events.map(e => `[${e.timestamp}ms] ${e.type}: ${e.detail}`).join('\n');
  }
}

// ── SimEnv ────────────────────────────────────────────────────────────────────

export interface SimEnv {
  seed: number;
  clock: VirtualClock;
  random: SeededRandom;
  scheduler: Scheduler;
  http: HttpInterceptor;
  tcp: TcpInterceptor;
  fs: VirtualFS;
  pg: PgMock;
  redis: RedisMock;
  mongo: MongoMock;
  faults: FaultInjector;
  timeline: Timeline;
}

// ── FaultInjector ─────────────────────────────────────────────────────────────

export class FaultInjector {
  constructor(private _env: SimEnv) {}

  networkPartition(duration: number): void {
    this._env.http.blockAll(duration);
    this._env.tcp.blockAll(duration);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Network partition for ${duration}ms`,
    });
  }

  slowDatabase(opts: { latency: number }): void {
    this._env.tcp.setDefaultLatency(opts.latency);
    this._env.http.setDefaultLatency(opts.latency);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Slow DB: ${opts.latency}ms extra latency`,
    });
  }

  diskFull(path = '/'): void {
    this._env.fs.inject(path, { error: 'ENOSPC: no space left on device', code: 'ENOSPC' });
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Disk full at ${path}`,
    });
  }

  clockSkew(amount: number): void {
    this._env.clock.skew(amount);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: 'FAULT',
      detail: `Clock skew +${amount}ms`,
    });
  }

  processRestart(server: { stop?: () => void; start?: () => void }, delay: number): void {
    const now = this._env.clock.now();
    const stopAt = now + Math.floor(delay / 2);
    const startAt = now + delay;

    this._env.scheduler.enqueueCompletion({
      id: `fault-stop-${now}`,
      when: stopAt,
      run: async () => {
        server.stop?.();
        this._env.timeline.record({ timestamp: stopAt, type: 'FAULT', detail: 'Process stop (restart)' });
      },
    });
    this._env.scheduler.enqueueCompletion({
      id: `fault-start-${now}`,
      when: startAt,
      run: async () => {
        server.start?.();
        this._env.timeline.record({ timestamp: startAt, type: 'FAULT', detail: 'Process start (restart)' });
      },
    });

    this._env.timeline.record({
      timestamp: now,
      type: 'FAULT',
      detail: `Process restart scheduled in ${delay}ms`,
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Call tcp.addLocalServer() and silently swallow listen errors (e.g. EADDRINUSE).
 * The in-process interceptor still handles connections even if the loopback
 * server can't bind.
 */
function _tryAddLocalServer(tcp: TcpInterceptor, port: number, handler: import('@simnode/tcp').TcpMockHandler): void {
  try {
    const handle = tcp.addLocalServer(port, handler);
    // Attach an error listener to the underlying net.Server to swallow EADDRINUSE
    // (addLocalServer returns a handle but doesn't expose the raw server).
    // The only way to intercept the listen error is via an 'error' event on the
    // returned handle's internal server. Since the handle doesn't expose it, we
    // tolerate that stopLocalServers() may encounter a non-listening server and
    // guard there instead.
    void handle;
  } catch {
    // Synchronous errors (e.g. invalid port) are ignored
  }
}

// ── createEnv ─────────────────────────────────────────────────────────────────

export interface MongoOpts {
  mongoHost: string;
  mongoPort: number;
  mongoDbName: string;
}

/**
 * Build a fresh, isolated SimEnv for one scenario run.
 * mongoOpts receives the host/port of the shared MongoMemoryServer started
 * by Simulation.run() and a per-scenario db name for isolation.
 */
export async function createEnv(seed: number, mongoOpts?: MongoOpts): Promise<SimEnv> {
  const clock = new VirtualClock(0);
  const random = new SeededRandom(seed);
  const scheduler = new Scheduler({ prngSeed: seed });

  const http = new HttpInterceptor({ clock, scheduler });
  const tcp = new TcpInterceptor({ clock, scheduler });
  const fs = new VirtualFS({ clock });

  const timeline = new Timeline();

  const pg = new PgMock();
  const redis = new RedisMock();
  const mongo = new MongoMock(mongoOpts);

  const env: SimEnv = {
    seed, clock, random, scheduler,
    http, tcp, fs,
    pg, redis, mongo,
    faults: null as unknown as FaultInjector,
    timeline,
  };
  env.faults = new FaultInjector(env);

  // Inject loopback URLs so libraries that read process.env at startup
  // (Prisma, pg, mongoose, ioredis) find the simulation endpoints.
  process.env.DATABASE_URL = 'postgres://localhost:5432/sim';
  process.env.PGURL        = 'postgres://localhost:5432/sim';
  process.env.REDIS_URL    = 'redis://localhost:6379';
  process.env.MONGODB_URI  = 'mongodb://localhost:27017/sim';

  // Register well-known protocol mocks as in-process TCP routes.
  tcp.mock('localhost:5432',  { handler: pg.createHandler() });
  tcp.mock('localhost:6379',  { handler: redis.createHandler() });
  tcp.mock('localhost:27017', { handler: mongo.createHandler() });

  // Start loopback TCP servers for out-of-process binaries (e.g. Prisma engine).
  // Errors (e.g. EADDRINUSE) are swallowed — in-process interceptor still works.
  _tryAddLocalServer(tcp, 5432,  pg.createHandler());
  _tryAddLocalServer(tcp, 6379,  redis.createHandler());
  _tryAddLocalServer(tcp, 27017, mongo.createHandler());

  return env;
}

// ── installDeterminismPatches ─────────────────────────────────────────────────

export interface DeterminismPatchHandle {
  restore: () => void;
  realSetTimeout: typeof globalThis.setTimeout;
}

/**
 * Patch global time + crypto primitives to be deterministic.
 * Must be called AFTER createEnv() so the VirtualClock is ready.
 * Returns a handle whose restore() undoes every patch.
 */
export function installDeterminismPatches(env: SimEnv): DeterminismPatchHandle {
  // Capture the real setTimeout BEFORE the clock patch overwrites it.
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);

  const origRandomBytes = cryptoCjs.randomBytes;
  const origRandomUUID  = cryptoCjs.randomUUID;

  const globalCrypto = globalThis.crypto;
  let origGlobalRandomUUID: typeof crypto.randomUUID | undefined;
  if (globalCrypto?.randomUUID) origGlobalRandomUUID = globalCrypto.randomUUID.bind(globalCrypto);
  let origGlobalGetRandomValues: typeof crypto.getRandomValues | undefined;
  if (globalCrypto?.getRandomValues) origGlobalGetRandomValues = globalCrypto.getRandomValues.bind(globalCrypto);

  const rng = mulberry32(env.seed);

  const randomBytesPatch = (size: number, cb?: (err: Error | null, buf: Buffer) => void): Buffer => {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256);
    if (cb) { queueMicrotask(() => cb(null, buf)); }
    return buf;
  };

  const getRandomValuesPatch = <T extends ArrayBufferView | null>(typedArray: T): T => {
    if (typedArray) {
      const u8 = new Uint8Array(
        (typedArray as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }).buffer,
        (typedArray as unknown as { byteOffset: number }).byteOffset,
        (typedArray as unknown as { byteLength: number }).byteLength,
      );
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rng() * 256);
    }
    return typedArray;
  };

  const randomUUIDPatch = (): `${string}-${string}-${string}-${string}-${string}` =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.floor(rng() * 16);
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }) as `${string}-${string}-${string}-${string}-${string}`;

  Object.defineProperty(cryptoCjs, 'randomBytes', { value: randomBytesPatch, configurable: true });
  Object.defineProperty(cryptoCjs, 'randomUUID',  { value: randomUUIDPatch,  configurable: true });

  if (globalCrypto) {
    if (typeof globalCrypto.randomUUID === 'function') {
      Object.defineProperty(globalCrypto, 'randomUUID',      { value: randomUUIDPatch,      configurable: true });
    }
    if (typeof globalCrypto.getRandomValues === 'function') {
      Object.defineProperty(globalCrypto, 'getRandomValues', { value: getRandomValuesPatch, configurable: true });
    }
  }

  const clockResult = installClock(env.clock, { patchNextTick: false });

  return {
    realSetTimeout,
    restore() {
      clockResult.uninstall();
      Object.defineProperty(cryptoCjs, 'randomBytes', { value: origRandomBytes, configurable: true });
      Object.defineProperty(cryptoCjs, 'randomUUID',  { value: origRandomUUID,  configurable: true });
      if (globalCrypto) {
        if (origGlobalRandomUUID !== undefined) {
          Object.defineProperty(globalCrypto, 'randomUUID',      { value: origGlobalRandomUUID,      configurable: true });
        }
        if (origGlobalGetRandomValues !== undefined) {
          Object.defineProperty(globalCrypto, 'getRandomValues', { value: origGlobalGetRandomValues, configurable: true });
        }
      }
    },
  };
}
