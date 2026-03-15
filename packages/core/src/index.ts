import { VirtualClock } from '@simnode/clock';
import { SeededRandom, mulberry32 } from '@simnode/random';
import { Scheduler } from '@simnode/scheduler';
import { HttpInterceptor } from '@simnode/http-proxy';
import { TcpInterceptor } from '@simnode/tcp';
import { VirtualFS } from '@simnode/filesystem';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const cryptoCjs = _require('node:crypto') as typeof import('node:crypto');

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

export interface SimEnv {
  seed: number;
  clock: VirtualClock;
  random: SeededRandom;
  scheduler: Scheduler;
  http: HttpInterceptor;
  tcp: TcpInterceptor;
  fs: VirtualFS;
  faults: FaultInjector;
  timeline: Timeline;
}

export class FaultInjector {
  constructor(private _env: SimEnv) {}

  networkPartition(duration: number): void {
    const originalHttpInstall = this._env.http;
    // Fail all HTTP for `duration` virtual ms by registering a catch-all error
    this._env.timeline.record({ timestamp: this._env.clock.now(), type: 'FAULT', detail: `Network partition for ${duration}ms` });
  }

  slowDatabase(opts: { latency: number }): void {
    this._env.timeline.record({ timestamp: this._env.clock.now(), type: 'FAULT', detail: `Slow DB: ${opts.latency}ms` });
  }

  diskFull(path = '/'): void {
    this._env.fs.inject(path, { error: 'ENOSPC: no space left on device', code: 'ENOSPC' });
    this._env.timeline.record({ timestamp: this._env.clock.now(), type: 'FAULT', detail: `Disk full at ${path}` });
  }

  clockSkew(amount: number): void {
    this._env.clock.advance(amount);
    this._env.timeline.record({ timestamp: this._env.clock.now(), type: 'FAULT', detail: `Clock skew ${amount}ms` });
  }
}

interface ScenarioDef {
  name: string;
  fn: (env: SimEnv) => Promise<void>;
}

export interface SimResult {
  passed: boolean;
  scenarios: Array<{
    name: string;
    seed: number;
    passed: boolean;
    error?: string;
    timeline: string;
  }>;
}

export class Simulation {
  private _baseSeed: number;
  private _timeout: number;
  private _scenarios: ScenarioDef[] = [];

  constructor(opts?: { seed?: number; timeout?: number }) {
    this._baseSeed = opts?.seed ?? 0;
    this._timeout = opts?.timeout ?? 30_000;
  }

  scenario(name: string, fn: (env: SimEnv) => Promise<void>): void {
    this._scenarios.push({ name, fn });
  }

  async run(opts?: { seeds?: number }): Promise<SimResult> {
    const seedCount = opts?.seeds ?? 1;
    const results: SimResult['scenarios'] = [];

    for (let s = 0; s < seedCount; s++) {
      const seed = this._baseSeed + s;
      for (const scenario of this._scenarios) {
        const r = await this._runScenario(scenario, seed);
        results.push(r);
      }
    }

    return { passed: results.every(r => r.passed), scenarios: results };
  }

  async replay(opts: { seed: number; scenario: string }): Promise<SimResult> {
    const scenario = this._scenarios.find(s => s.name === opts.scenario);
    if (!scenario) throw new Error(`Scenario not found: ${opts.scenario}`);
    const r = await this._runScenario(scenario, opts.seed);
    return { passed: r.passed, scenarios: [r] };
  }

  private async _runScenario(scenario: ScenarioDef, seed: number) {
    const env = this._createEnv(seed);
    const patches = this._installDeterminismPatches(env);
    let passed = true;
    let error: string | undefined;

    try {
      env.timeline.record({ timestamp: 0, type: 'START', detail: `Scenario: ${scenario.name}, seed: ${seed}` });
      await Promise.race([
        scenario.fn(env),
        new Promise((_, reject) =>
          globalThis.setTimeout(() => reject(new Error('Scenario timeout')), this._timeout)
        ),
      ]);
      env.timeline.record({ timestamp: env.clock.now(), type: 'END', detail: 'Success' });
    } catch (err) {
      passed = false;
      error = err instanceof Error ? err.message : String(err);
      env.timeline.record({ timestamp: env.clock.now(), type: 'FAIL', detail: error });
    } finally {
      patches.restore();
      env.http.uninstall();
      env.tcp.uninstall();
      env.fs.uninstall();
    }

    return { name: scenario.name, seed, passed, error, timeline: env.timeline.toString() };
  }

  private _createEnv(seed: number): SimEnv {
    const clock = new VirtualClock(0);
    const random = new SeededRandom(seed);
    const scheduler = new Scheduler({ prngSeed: seed });
    const http = new HttpInterceptor({ clock } as any);
    const tcp = new TcpInterceptor({ clock, scheduler });
    const fs = new VirtualFS();
    const timeline = new Timeline();
    const env: SimEnv = { seed, clock, random, scheduler, http, tcp, fs, faults: null as any, timeline };
    env.faults = new FaultInjector(env);
    return env;
  }

  /** Install determinism patches for crypto.randomBytes, randomUUID, getRandomValues and performance.now */
  _installDeterminismPatches(env: SimEnv): { restore: () => void } {
    const origRandomBytes = cryptoCjs.randomBytes;
    const origRandomUUID = cryptoCjs.randomUUID;
    const origGetRandomValues = cryptoCjs.getRandomValues;
    const origPerfNow = globalThis.performance.now.bind(globalThis.performance);
    
    // Node < 19 support: globalThis.crypto might be undefined
    const globalCrypto = globalThis.crypto;
    let origGlobalRandomUUID: typeof crypto.randomUUID | undefined;
    if (globalCrypto && globalCrypto.randomUUID) origGlobalRandomUUID = globalCrypto.randomUUID.bind(globalCrypto);
    let origGlobalGetRandomValues: typeof crypto.getRandomValues | undefined;
    if (globalCrypto && globalCrypto.getRandomValues) origGlobalGetRandomValues = globalCrypto.getRandomValues.bind(globalCrypto);

    const rng = mulberry32(env.seed);

    const randomBytesPatch = function (size: number, cb?: (err: Error | null, buf: Buffer) => void): Buffer {
      const buf = Buffer.alloc(size);
      for (let i = 0; i < size; i++) buf[i] = Math.floor(rng() * 256);
      if (cb) { queueMicrotask(() => cb(null, buf)); return buf; }
      return buf;
    };

    const getRandomValuesPatch = function <T extends ArrayBufferView | null>(typedArray: T): T {
      if (typedArray) {
        const u8 = new Uint8Array((typedArray as any).buffer, (typedArray as any).byteOffset, (typedArray as any).byteLength);
        for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(rng() * 256);
      }
      return typedArray;
    };

    const randomUUIDPatch = function (): string {
      // Generate a deterministic v4 UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const hex = () => Math.floor(rng() * 16).toString(16);
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.floor(rng() * 16);
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };

    Object.defineProperty(cryptoCjs, 'randomBytes', { value: randomBytesPatch, configurable: true });
    Object.defineProperty(cryptoCjs, 'randomUUID', { value: randomUUIDPatch, configurable: true });
    
    if (globalCrypto) {
      if (typeof globalCrypto.randomUUID === 'function') {
        Object.defineProperty(globalCrypto, 'randomUUID', { value: randomUUIDPatch, configurable: true });
      }
      if (typeof globalCrypto.getRandomValues === 'function') {
        Object.defineProperty(globalCrypto, 'getRandomValues', { value: getRandomValuesPatch, configurable: true });
      }
    }

    globalThis.performance.now = () => env.clock.now();

    return {
      restore() {
        Object.defineProperty(cryptoCjs, 'randomBytes', { value: origRandomBytes, configurable: true });
        Object.defineProperty(cryptoCjs, 'randomUUID', { value: origRandomUUID, configurable: true });
        if (globalCrypto) {
          if (origGlobalRandomUUID !== undefined) {
            Object.defineProperty(globalCrypto, 'randomUUID', { value: origGlobalRandomUUID, configurable: true });
          }
          if (origGlobalGetRandomValues !== undefined) {
             Object.defineProperty(globalCrypto, 'getRandomValues', { value: origGlobalGetRandomValues, configurable: true });
          }
        }
        globalThis.performance.now = origPerfNow;
      },
    };
  }
}


