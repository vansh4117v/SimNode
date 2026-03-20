import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Re-export shared types so consumers import from a single entry point.
export type { SimEnv, TimelineEvent } from './env.js';
export { Timeline, FaultInjector } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Resolve the worker script across both production (dist/) and development (src/) layouts.
function _resolveWorkerScript(): string {
  const candidates = [
    join(__dirname, 'simulation-worker.js'),               // production: sibling in dist/
    join(__dirname, '..', 'dist', 'simulation-worker.js'), // dev: vitest runs from src/, worker in dist/
    resolve(__dirname, '..', 'dist', 'simulation-worker.cjs'), // CJS fallback
  ];
  const found = candidates.find(p => existsSync(p));
  if (!found) {
    throw new Error(
      `SimNode: Cannot locate simulation-worker.js. Searched:\n` +
      candidates.map(p => `  - ${p}`).join('\n') +
      `\nRun \`npm run build\` in @simnode/core first.`,
    );
  }
  return found;
}
const WORKER_SCRIPT = _resolveWorkerScript();

interface ScenarioDef {
  name: string;
  /** Absolute path to a scenario module (preferred). */
  path?: string;
  /** Inline function — serialised via fn.toString() for the worker (legacy). */
  fn?: (env: import('./env.js').SimEnv) => Promise<void>;
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

interface WorkerResult {
  name: string;
  seed: number;
  passed: boolean;
  error?: string;
  timeline: string;
}

export class Simulation {
  private _baseSeed: number;
  private _timeout: number;
  private _scenarios: ScenarioDef[] = [];

  constructor(opts?: { seed?: number; timeout?: number }) {
    this._baseSeed = opts?.seed ?? 0;
    this._timeout  = opts?.timeout ?? 30_000;
  }

  /**
   * Register a scenario.
   *
   * @param name     Unique scenario name.
   * @param fnOrPath Either an **absolute file path** (string) to a module whose
   *                 default export is `async (env: SimEnv) => void`, OR an
   *                 inline async function (serialised for the worker — closures
   *                 over outer-scope variables are NOT available).
   */
  scenario(name: string, fnOrPath: string | ((env: import('./env.js').SimEnv) => Promise<void>)): void {
    if (typeof fnOrPath === 'string') {
      this._scenarios.push({ name, path: resolve(fnOrPath) });
    } else {
      this._scenarios.push({ name, fn: fnOrPath });
    }
  }

  async run(opts?: { seeds?: number }): Promise<SimResult> {
    const seedCount = opts?.seeds ?? 1;
    const results: SimResult['scenarios'] = [];
    const [mongo, redis] = await Promise.all([_startMongo(), _startRedis()]);
    try {
      for (let s = 0; s < seedCount; s++) {
        const seed = this._baseSeed + s;
        for (const scenario of this._scenarios) {
          const r = await this._runScenario(scenario, seed, mongo, redis);
          results.push(r);
        }
      }
    } finally {
      await Promise.all([_stopMongo(mongo), _stopRedis(redis)]);
    }
    return { passed: results.every(r => r.passed), scenarios: results };
  }

  async replay(opts: { seed: number; scenario: string }): Promise<SimResult> {
    const found = this._scenarios.find(s => s.name === opts.scenario);
    if (!found) throw new Error(`Scenario not found: ${opts.scenario}`);
    const [mongo, redis] = await Promise.all([_startMongo(), _startRedis()]);
    try {
      const r = await this._runScenario(found, opts.seed, mongo, redis);
      return { passed: r.passed, scenarios: [r] };
    } finally {
      await Promise.all([_stopMongo(mongo), _stopRedis(redis)]);
    }
  }

  private async _runScenario(scenario: ScenarioDef, seed: number, mongo: MongoServerInfo, redis: RedisServerInfo): Promise<WorkerResult> {
    const workerPayload: Record<string, unknown> = {
      seed,
      scenarioName: scenario.name,
      timeout: this._timeout,
      mongoHost: mongo.host,
      mongoPort: mongo.port,
      mongoDbName: `sim_db_${seed}`,
      redisHost: redis.host,
      redisPort: redis.port,
    };

    if (scenario.path) {
      workerPayload.scenarioPath = scenario.path;
    } else {
      // Legacy inline function — serialised for vm eval
      workerPayload.fnSource = scenario.fn!.toString();
    }

    const worker = new Worker(WORKER_SCRIPT, { workerData: workerPayload });

    try {
      return await new Promise<WorkerResult>((resolve, reject) => {
        worker.once('message', (result: WorkerResult) => resolve(result));
        worker.once('error',   (err)                   => reject(err));
        worker.once('exit',    (code) => {
          if (code !== 0) {
            reject(new Error(`Worker exited with code ${code} for scenario "${scenario.name}"`));
          }
        });
      });
    } finally {
      // Always terminate — prevents zombie workers on timeout, error, or early exit.
      await worker.terminate();
    }
  }
}

// ── MongoDB server lifecycle (one server per Simulation.run()) ────────────────

interface MongoServerInfo {
  host: string;
  port: number;
  stop: () => Promise<void>;
}

async function _startMongo(): Promise<MongoServerInfo> {
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create();
    const uri = server.getUri();
    const url = new URL(uri);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10),
      stop: () => server.stop().then(() => {}),
    };
  } catch {
    // mongodb-memory-server not available — return a sentinel that disables mongo
    return { host: '127.0.0.1', port: 27017, stop: async () => {} };
  }
}

async function _stopMongo(info: MongoServerInfo): Promise<void> {
  try { await info.stop(); } catch { /* ignore */ }
}

// ── Redis server lifecycle (one server per Simulation.run()) ──────────────────

interface RedisServerInfo {
  host: string;
  port: number;
  stop: () => Promise<void>;
}

async function _startRedis(): Promise<RedisServerInfo> {
  try {
    const { RedisMemoryServer } = await import('redis-memory-server');
    const server = new RedisMemoryServer();
    const host = await server.getHost();
    const port = await server.getPort();
    return {
      host,
      port,
      stop: () => server.stop().then(() => {}),
    };
  } catch {
    // redis-memory-server not available — return a sentinel that disables redis
    return { host: '127.0.0.1', port: 6379, stop: async () => {} };
  }
}

async function _stopRedis(info: RedisServerInfo): Promise<void> {
  try { await info.stop(); } catch { /* ignore */ }
}
