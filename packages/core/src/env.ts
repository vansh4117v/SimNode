import { VirtualClock } from "@crashlab/clock";
import { install as installClock } from "@crashlab/clock";
import { SeededRandom, mulberry32 } from "@crashlab/random";
import { Scheduler } from "@crashlab/scheduler";
import { HttpInterceptor } from "@crashlab/http-proxy";
import { TcpInterceptor } from "@crashlab/tcp";
import { VirtualFS } from "@crashlab/filesystem";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const cryptoCjs = _require("node:crypto") as typeof import("node:crypto");

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  timestamp: number;
  type: string;
  detail: string;
}

export class Timeline {
  private _events: TimelineEvent[] = [];
  record(evt: TimelineEvent): void {
    this._events.push(evt);
  }
  get events(): ReadonlyArray<TimelineEvent> {
    return this._events;
  }
  toString(): string {
    return this._events.map((e) => `[${e.timestamp}ms] ${e.type}: ${e.detail}`).join("\n");
  }
}

// ── Optional-mock interfaces ─────────────────────────────────────────────────
// Defined locally so @crashlab/core has zero type-level dependency on the heavy
// mock packages.  The concrete classes (@crashlab/pg-mock etc.) satisfy these
// interfaces via TypeScript structural typing.

export interface PgMockLike {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  seedData(table: string, rows: Record<string, unknown>[]): void;
  ready(): Promise<void>;
  createHandler(): import("@crashlab/tcp").TcpMockHandler;
}

export interface RedisMockLike {
  seedData(key: string, value: string): void;
  flush(): Promise<void>;
  createHandler(): import("@crashlab/tcp").TcpMockHandler;
}

export interface MongoMockLike {
  find(collection: string, filter?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  drop(): Promise<void>;
  createHandler(): import("@crashlab/tcp").TcpMockHandler;
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
  /** null when @crashlab/pg-mock is not installed */
  pg: PgMockLike | null;
  /** null when @crashlab/redis-mock is not installed */
  redis: RedisMockLike | null;
  /** null when @crashlab/mongo is not installed */
  mongo: MongoMockLike | null;
  faults: FaultInjector;
  timeline: Timeline;
  /**
   * Advance the virtual clock by `ms` milliseconds, yielding to the real
   * event loop between small incremental steps.  This allows real-TCP I/O
   * (e.g. supertest HTTP requests) to be processed while the scheduler
   * drains pending completions at each step.
   *
   * Injected by the simulation worker after determinism patches are installed.
   * See `packages/core/docs/API.md` for guidance on when to use `pump()` vs `clock.advance()`.
   */
  pump: (ms: number, steps?: number) => Promise<void>;
}

// ── FaultInjector ─────────────────────────────────────────────────────────────

export class FaultInjector {
  constructor(private _env: SimEnv) {}

  networkPartition(duration: number): void {
    this._env.http.blockAll(duration);
    this._env.tcp.blockAll(duration);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: "FAULT",
      detail: `Network partition for ${duration}ms`,
    });
  }

  slowDatabase(opts: { latency: number }): void {
    this._env.tcp.setDefaultLatency(opts.latency);
    this._env.http.setDefaultLatency(opts.latency);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: "FAULT",
      detail: `Slow DB: ${opts.latency}ms extra latency`,
    });
  }

  diskFull(path = "/"): void {
    this._env.fs.inject(path, { error: "ENOSPC: no space left on device", code: "ENOSPC" });
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: "FAULT",
      detail: `Disk full at ${path}`,
    });
  }

  clockSkew(amount: number): void {
    this._env.clock.skew(amount);
    this._env.timeline.record({
      timestamp: this._env.clock.now(),
      type: "FAULT",
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
        this._env.timeline.record({
          timestamp: stopAt,
          type: "FAULT",
          detail: "Process stop (restart)",
        });
      },
    });
    this._env.scheduler.enqueueCompletion({
      id: `fault-start-${now}`,
      when: startAt,
      run: async () => {
        server.start?.();
        this._env.timeline.record({
          timestamp: startAt,
          type: "FAULT",
          detail: "Process start (restart)",
        });
      },
    });

    this._env.timeline.record({
      timestamp: now,
      type: "FAULT",
      detail: `Process restart scheduled in ${delay}ms`,
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Call tcp.addLocalServer() and record a timeline WARNING if the loopback
 * server fails to bind (e.g. EADDRINUSE from a real database on the same port).
 * In-process drivers (pg, mongoose, ioredis) are unaffected because they are
 * intercepted client-side; only out-of-process binaries (e.g. Prisma engine)
 * may fail to connect.
 */
function _tryAddLocalServer(
  tcp: TcpInterceptor,
  port: number,
  handler: import("@crashlab/tcp").TcpMockHandler,
  timeline: Timeline,
): void {
  try {
    tcp.addLocalServer(port, handler, 0, (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") {
        timeline.record({
          timestamp: 0,
          type: "WARNING",
          detail:
            `Port ${port} already in use (${code}) — out-of-process binaries ` +
            `(e.g. Prisma) may fail to connect, but in-process drivers ` +
            `(pg, mongoose, ioredis) will still function via the client-side interceptor.`,
        });
      }
    });
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
 * Redis is fully in-memory (ioredis-mock) — no external server needed.
 */
export async function createEnv(seed: number, mongoOpts?: MongoOpts): Promise<SimEnv> {
  const clock = new VirtualClock(0);
  const random = new SeededRandom(seed);
  const scheduler = new Scheduler({ prngSeed: seed });

  const http = new HttpInterceptor({ clock, scheduler });
  const tcp = new TcpInterceptor({ clock, scheduler });
  const fs = new VirtualFS({ clock });

  const timeline = new Timeline();

  // Heavy mock packages — loaded lazily and optionally.  Each is wrapped in a
  // try/catch so @crashlab/core works even when a mock is not installed.
  let pg: PgMockLike | null = null;
  let redis: RedisMockLike | null = null;
  let mongo: MongoMockLike | null = null;

  try {
    const { PgMock } = await import("@crashlab/pg-mock");
    pg = new PgMock();
    // Ensure PGlite WASM is fully initialised BEFORE determinism patches
    // replace setTimeout — PGlite's init may use real timers internally.
    await (pg as { ready(): Promise<void> }).ready();
  } catch {
    /* @crashlab/pg-mock not installed — pg stays null */
  }

  try {
    const { RedisMock } = await import("@crashlab/redis-mock");
    redis = new RedisMock();
  } catch {
    /* @crashlab/redis-mock not installed — redis stays null */
  }

  try {
    const { MongoMock } = await import("@crashlab/mongo");
    mongo = new MongoMock(mongoOpts);
  } catch {
    /* @crashlab/mongo not installed — mongo stays null */
  }

  const env: SimEnv = {
    seed,
    clock,
    random,
    scheduler,
    http,
    tcp,
    fs,
    pg,
    redis,
    mongo,
    faults: null as unknown as FaultInjector,
    timeline,
    // Placeholder — replaced by simulation-worker with a version that uses
    // the real (unpatched) setTimeout to yield to the host event loop.
    pump: async (ms: number, _steps?: number) => {
      await clock.advance(ms);
    },
  };
  env.faults = new FaultInjector(env);

  // Inject loopback URLs and register TCP routes only for installed mocks.
  if (pg) {
    process.env.DATABASE_URL = "postgres://localhost:5432/sim";
    process.env.PGURL = "postgres://localhost:5432/sim";
    tcp.mock("localhost:5432", { handler: pg.createHandler() });
    _tryAddLocalServer(tcp, 5432, pg.createHandler(), timeline);
  }
  if (redis) {
    process.env.REDIS_URL = "redis://localhost:6379";
    tcp.mock("localhost:6379", { handler: redis.createHandler() });
    _tryAddLocalServer(tcp, 6379, redis.createHandler(), timeline);
  }
  if (mongo) {
    process.env.MONGODB_URI = "mongodb://localhost:27017/sim";
    tcp.mock("localhost:27017", { handler: mongo.createHandler() });
    _tryAddLocalServer(tcp, 27017, mongo.createHandler(), timeline);
  }

  return env;
}

// ── PRNG patches (early + full) ──────────────────────────────────────────────

/**
 * Handle returned by installEarlyPrngPatches.
 *
 * `originals` holds the **real** (pre-patch) functions so that
 * installDeterminismPatches can restore them on teardown — even though
 * Math.random / crypto have already been overwritten by the early patch.
 */
export interface EarlyPrngPatchHandle {
  origMathRandom: typeof Math.random;
  origRandomBytes: typeof import("node:crypto").randomBytes;
  origRandomUUID: typeof import("node:crypto").randomUUID;
  origGlobalRandomUUID?: typeof crypto.randomUUID;
  origGlobalGetRandomValues?: typeof crypto.getRandomValues;
}

/**
 * Patch **only** the PRNG globals (Math.random, crypto.randomBytes,
 * crypto.randomUUID, crypto.getRandomValues) so that module-level
 * initialisers in third-party libraries (e.g. BSON's `PROCESS_UNIQUE`,
 * `ObjectId.index`) produce deterministic values.
 *
 * **Must be called BEFORE `import(scenarioPath)`** — that import triggers
 * all transitive module initialisers, many of which call Math.random or
 * crypto.randomBytes at load time.
 *
 * Returns a handle containing the captured real originals.  Pass this
 * handle to `installDeterminismPatches` so it can restore them on teardown.
 */
export function installEarlyPrngPatches(seed: number): EarlyPrngPatchHandle {
  // Capture the REAL originals before any patching.
  const origMathRandom = Math.random;
  const origRandomBytes = cryptoCjs.randomBytes;
  const origRandomUUID = cryptoCjs.randomUUID;

  const globalCrypto = globalThis.crypto;
  const origGlobalRandomUUID = globalCrypto?.randomUUID
    ? globalCrypto.randomUUID.bind(globalCrypto)
    : undefined;
  const origGlobalGetRandomValues = globalCrypto?.getRandomValues
    ? globalCrypto.getRandomValues.bind(globalCrypto)
    : undefined;

  // Independent sub-stream for Math.random (XOR'd seed avoids correlation).
  const mathRng = mulberry32(seed ^ 0x6d617468);
  Math.random = () => mathRng();

  // Crypto PRNG stream.
  const rng = mulberry32(seed);

  const randomBytesPatch = (
    size: number,
    cb?: (err: Error | null, buf: Buffer) => void,
  ): Buffer => {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256);
    if (cb) {
      queueMicrotask(() => cb(null, buf));
    }
    return buf;
  };

  const getRandomValuesPatch = <T extends ArrayBufferView | null>(typedArray: T): T => {
    if (typedArray) {
      const u8 = new Uint8Array(
        (
          typedArray as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
        ).buffer,
        (typedArray as unknown as { byteOffset: number }).byteOffset,
        (typedArray as unknown as { byteLength: number }).byteLength,
      );
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rng() * 256);
    }
    return typedArray;
  };

  const randomUUIDPatch = (): `${string}-${string}-${string}-${string}-${string}` =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(rng() * 16);
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }) as `${string}-${string}-${string}-${string}-${string}`;

  Object.defineProperty(cryptoCjs, "randomBytes", { value: randomBytesPatch, configurable: true });
  Object.defineProperty(cryptoCjs, "randomUUID", { value: randomUUIDPatch, configurable: true });

  if (globalCrypto) {
    if (typeof globalCrypto.randomUUID === "function") {
      Object.defineProperty(globalCrypto, "randomUUID", {
        value: randomUUIDPatch,
        configurable: true,
      });
    }
    if (typeof globalCrypto.getRandomValues === "function") {
      Object.defineProperty(globalCrypto, "getRandomValues", {
        value: getRandomValuesPatch,
        configurable: true,
      });
    }
  }

  return {
    origMathRandom,
    origRandomBytes,
    origRandomUUID,
    origGlobalRandomUUID,
    origGlobalGetRandomValues,
  };
}

// ── installDeterminismPatches ─────────────────────────────────────────────────

export interface DeterminismPatchHandle {
  restore: () => void;
  realSetTimeout: typeof globalThis.setTimeout;
}

/**
 * Patch global time + crypto primitives to be deterministic.
 * Must be called AFTER createEnv() so the VirtualClock is ready.
 *
 * If `earlyHandle` is provided (from a prior `installEarlyPrngPatches` call),
 * the PRNG globals are re-initialised with fresh streams (so the scenario
 * starts from a clean PRNG state) and the **real** originals from the handle
 * are used for the restore() teardown.
 *
 * Returns a handle whose restore() undoes every patch.
 */
export function installDeterminismPatches(
  env: SimEnv,
  earlyHandle?: EarlyPrngPatchHandle,
): DeterminismPatchHandle {
  // Capture the real setTimeout BEFORE the clock patch overwrites it.
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);

  // Use the real originals from the early handle if available; otherwise
  // capture them now (for callers that skip the early phase).
  const origRandomBytes = earlyHandle?.origRandomBytes ?? cryptoCjs.randomBytes;
  const origRandomUUID = earlyHandle?.origRandomUUID ?? cryptoCjs.randomUUID;
  const origMathRandom = earlyHandle?.origMathRandom ?? Math.random;

  const globalCrypto = globalThis.crypto;
  const origGlobalRandomUUID =
    earlyHandle?.origGlobalRandomUUID ??
    (globalCrypto?.randomUUID ? globalCrypto.randomUUID.bind(globalCrypto) : undefined);
  const origGlobalGetRandomValues =
    earlyHandle?.origGlobalGetRandomValues ??
    (globalCrypto?.getRandomValues ? globalCrypto.getRandomValues.bind(globalCrypto) : undefined);

  // Fresh PRNG streams for the scenario runtime (independent of whatever
  // the early patch consumed during module initialisation).
  const rng = mulberry32(env.seed);

  const mathRng = mulberry32(env.seed ^ 0x6d617468);
  Math.random = () => mathRng();

  const randomBytesPatch = (
    size: number,
    cb?: (err: Error | null, buf: Buffer) => void,
  ): Buffer => {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256);
    if (cb) {
      queueMicrotask(() => cb(null, buf));
    }
    return buf;
  };

  const getRandomValuesPatch = <T extends ArrayBufferView | null>(typedArray: T): T => {
    if (typedArray) {
      const u8 = new Uint8Array(
        (
          typedArray as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
        ).buffer,
        (typedArray as unknown as { byteOffset: number }).byteOffset,
        (typedArray as unknown as { byteLength: number }).byteLength,
      );
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rng() * 256);
    }
    return typedArray;
  };

  const randomUUIDPatch = (): `${string}-${string}-${string}-${string}-${string}` =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(rng() * 16);
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }) as `${string}-${string}-${string}-${string}-${string}`;

  Object.defineProperty(cryptoCjs, "randomBytes", { value: randomBytesPatch, configurable: true });
  Object.defineProperty(cryptoCjs, "randomUUID", { value: randomUUIDPatch, configurable: true });

  if (globalCrypto) {
    if (typeof globalCrypto.randomUUID === "function") {
      Object.defineProperty(globalCrypto, "randomUUID", {
        value: randomUUIDPatch,
        configurable: true,
      });
    }
    if (typeof globalCrypto.getRandomValues === "function") {
      Object.defineProperty(globalCrypto, "getRandomValues", {
        value: getRandomValuesPatch,
        configurable: true,
      });
    }
  }

  // ── process.hrtime / performance.timeOrigin ──────────────────────────────
  const origHrtime = process.hrtime;
  const hrtimePatch = ((prev?: [number, number]): [number, number] => {
    const now = env.clock.now();
    const secs = Math.floor(now / 1000);
    const nanos = (now % 1000) * 1_000_000;
    if (!prev) return [secs, nanos];
    let ds = secs - prev[0];
    let dn = nanos - prev[1];
    if (dn < 0) {
      ds -= 1;
      dn += 1_000_000_000;
    }
    return [ds, dn];
  }) as typeof process.hrtime;
  hrtimePatch.bigint = (): bigint => BigInt(env.clock.now()) * 1_000_000n;
  process.hrtime = hrtimePatch;

  const origPerfTimeOrigin = performance.timeOrigin;
  Object.defineProperty(performance, "timeOrigin", { value: 0, configurable: true });

  const clockResult = installClock(env.clock, { patchNextTick: false });

  return {
    realSetTimeout,
    restore() {
      clockResult.uninstall();
      Math.random = origMathRandom;
      process.hrtime = origHrtime;
      Object.defineProperty(performance, "timeOrigin", {
        value: origPerfTimeOrigin,
        configurable: true,
      });
      Object.defineProperty(cryptoCjs, "randomBytes", {
        value: origRandomBytes,
        configurable: true,
      });
      Object.defineProperty(cryptoCjs, "randomUUID", { value: origRandomUUID, configurable: true });
      if (globalCrypto) {
        if (origGlobalRandomUUID !== undefined) {
          Object.defineProperty(globalCrypto, "randomUUID", {
            value: origGlobalRandomUUID,
            configurable: true,
          });
        }
        if (origGlobalGetRandomValues !== undefined) {
          Object.defineProperty(globalCrypto, "getRandomValues", {
            value: origGlobalGetRandomValues,
            configurable: true,
          });
        }
      }
    },
  };
}
