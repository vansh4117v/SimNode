/**
 * simulation-worker.ts
 *
 * Runs inside a worker_threads Worker. Receives scenario data via workerData,
 * creates a fresh isolated SimEnv, applies determinism patches to this
 * thread's globals, and executes the scenario.
 *
 * Isolation guarantees:
 *  - Worker thread has its own global scope — patches never leak to main thread.
 *  - File-based scenarios: loaded via dynamic import() — full ES module support.
 *  - Inline scenarios: compiled in vm.runInNewContext — legacy compatibility.
 *  - Worker terminates after posting — no residual timers or module state.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { createFetchPatch } from '@crashlab/http-proxy';
import { createEnv, installEarlyPrngPatches, installDeterminismPatches } from './env.js';
import type { SimEnv } from './env.js';

// A require() scoped to this worker — injected into the vm sandbox.
const _workerRequire = createRequire(import.meta.url);

/**
 * Pre-apply `process.env.X = "..."` assignments found in the scenario source
 * so they are set before import() hoists and evaluates static imports.
 */
function _applyScenarioEnv(filePath: string): void {
  const src = readFileSync(filePath, 'utf8');
  const re = /^\s*process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'`])([^"'`]*)\2\s*;?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    process.env[m[1]] = m[3];
  }
}

/**
 * Replace the database-name segment in every MongoDB URI found in process.env
 * with `dbName`.  This ensures the app always connects to the per-seed
 * isolated database, and that env.mongo.drop() cleans up the correct one.
 */
function _patchMongoDbName(dbName: string): void {
  const re = /^(mongodb(?:\+srv)?:\/\/[^/]+\/)[^?#]*(.*)/i;
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    const m = re.exec(val);
    if (m) process.env[key] = m[1] + dbName + m[2];
  }
}

interface WorkerInput {
  seed: number;
  scenarioName: string;
  timeout: number;
  mongoHost: string;
  mongoPort: number;
  mongoDbName: string;
  /** File-based scenario: absolute path to an ES module. */
  scenarioPath?: string;
  /** Inline legacy scenario: serialised function source. */
  fnSource?: string;
}

const { seed, scenarioName, timeout,
        mongoHost, mongoPort, mongoDbName,
        scenarioPath, fnSource } = workerData as WorkerInput;

async function main(): Promise<void> {
  // Build a fresh env — MongoMock proxies to shared MongoMemoryServer,
  // RedisMock is fully in-memory (ioredis-mock, no external process).
  const env = await createEnv(seed, { mongoHost, mongoPort, mongoDbName });

  // Wire clock → scheduler so advance() drives all I/O completions
  env.clock.onTick = async (t: number) => {
    await env.scheduler.runTick(t);
  };

  // ── Patch PRNG globals BEFORE loading the scenario module so that
  // module-level initialisers (BSON's PROCESS_UNIQUE, ObjectId.index,
  // MongoDB driver session UUIDs, etc.) are deterministic.
  const earlyPrng = installEarlyPrngPatches(seed);

  // ── Load the scenario module BEFORE installing interceptors so that
  // import() (and all transitive require/fs reads) hit the real filesystem.
  // Pre-apply process.env assignments from the scenario source first so that
  // app modules which validate env vars at load time see the correct values
  // (static ESM imports are hoisted and evaluated before module body code).
  let scenarioFn: (env: SimEnv) => Promise<void>;
  if (scenarioPath) {
    _applyScenarioEnv(scenarioPath);
    let mod: { default?: (env: SimEnv) => Promise<void> };
    try {
      mod = await import(scenarioPath) as { default?: (env: SimEnv) => Promise<void> };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (scenarioPath.endsWith('.ts') && /unknown file extension|\.ts/i.test(msg)) {
        throw new Error(
          `[SimNode] Cannot import TypeScript scenario directly: ${scenarioPath}\n` +
          `Run Node with a TypeScript loader, e.g.: node --import tsx/esm  or  node --loader ts-node/esm`,
        );
      }
      throw err;
    }
    // Re-apply after import() in case the app called dotenv.config() at module
    // initialisation and overwrote the values we set above.
    _applyScenarioEnv(scenarioPath);
    // Force all MongoDB URIs to use the per-seed isolated database so that
    // env.mongo.drop() always cleans up the database the app actually used.
    _patchMongoDbName(mongoDbName);
    scenarioFn = mod.default ?? (() => { throw new Error(`${scenarioPath} has no default export`); });
  }

  // Install all interceptors on THIS thread's net/http/fs globals
  env.http.install();
  env.tcp.install();
  env.fs.install();

  // Patch globalThis.fetch to go through the HTTP interceptor (Shift 5)
  const origFetch = globalThis.fetch;
  if (origFetch) globalThis.fetch = createFetchPatch(env.http, origFetch) as typeof globalThis.fetch;

  // Apply determinism patches to THIS thread's globals
  const patches = installDeterminismPatches(env, earlyPrng);

  // Replace the placeholder pump with one that uses the real (unpatched)
  // setTimeout to yield to the host event loop between clock steps.
  // This lets real-TCP I/O (supertest, etc.) be processed while the
  // scheduler drains pending mock completions at each step.
  env.pump = async (ms: number, steps = 20): Promise<void> => {
    const step = ms / steps;

    // ── Freeze the write-time for VirtualSocket ──────────────────────
    // All VirtualSocket._write calls during this pump will use the
    // clock time at pump-start for computing `when` and op IDs.
    // This is the KEY determinism guarantee: even if Express processes
    // a request during a deliver() I/O yield (when the clock has already
    // advanced internally), the write still lands at the correct frozen
    // virtual time.  Without this, real-time jitter in Express processing
    // causes the same request to land at virtual-time 0 in one run but
    // virtual-time 25 in another — the root cause of non-determinism.
    const pumpBase = env.clock.now();
    env.scheduler.writeTimeOverride = pumpBase;
    env.scheduler.holdDrain = true;

    try {
      // ── Phase 1: warm-up ──────────────────────────────────────────
      // Yield to the REAL event loop so that in-flight supertest →
      // Express → VirtualSocket processing can begin.  Not all requests
      // need to finish here — writeTimeOverride guarantees correctness
      // even if some arrive during Phase 2.
      for (let i = 0; i < 50; i++) {
        await new Promise<void>(r => patches.realSetTimeout(r, 2));
      }

      // ── Phase 2: advance the virtual clock in steps ───────────────
      for (let i = 0; i < steps; i++) {
        await new Promise<void>(r => patches.realSetTimeout(r, 1));
        await env.clock.advance(step);
      }
    } finally {
      env.scheduler.holdDrain = false;
      env.scheduler.writeTimeOverride = undefined;
    }
  };

  let passed = true;
  let error: string | undefined;

  try {
    env.timeline.record({ timestamp: 0, type: 'START', detail: `Scenario: ${scenarioName}, seed: ${seed}` });

    if (!scenarioPath) {
      // ── Inline (legacy) scenario: compile in vm sandbox so globals resolve
      // to the patched (virtual) versions installed on this worker thread.
      const sandbox = vm.createContext({
        env,
        Promise,
        queueMicrotask,
        Date:           globalThis.Date,
        setTimeout:     globalThis.setTimeout,
        clearTimeout:   globalThis.clearTimeout,
        setInterval:    globalThis.setInterval,
        clearInterval:  globalThis.clearInterval,
        setImmediate:   globalThis.setImmediate,
        clearImmediate: globalThis.clearImmediate,
        fetch:          globalThis.fetch,  // patched fetch (Shift 5)
        console,
        process,
        Buffer,
        require: _workerRequire,
        Math, JSON, Error, Array, Object, Map, Set,
        Symbol, RegExp, parseInt, parseFloat,
        isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      });
      scenarioFn = vm.runInContext(`(${fnSource!})`, sandbox) as (env: SimEnv) => Promise<void>;
    }

    await Promise.race([
      scenarioFn!(env),
      new Promise<never>((_, reject) =>
        patches.realSetTimeout(() => reject(new Error('Scenario timeout')), timeout),
      ),
    ]);

    env.timeline.record({ timestamp: env.clock.now(), type: 'END', detail: 'Success' });
  } catch (err) {
    passed = false;
    error = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'SimNodeUnsupportedProtocolError') {
      env.timeline.record({ timestamp: env.clock.now(), type: 'BLOCKED_PROTOCOL', detail: error });
    }
    env.timeline.record({ timestamp: env.clock.now(), type: 'FAIL', detail: error });
  } finally {
    patches.restore();
    if (origFetch) globalThis.fetch = origFetch;
    env.http.uninstall();
    env.tcp.uninstall();
    env.fs.uninstall();
    await env.tcp.stopLocalServers();
    // Drop the scenario's MongoDB database and flush Redis for clean isolation
    try { await env.mongo?.drop(); } catch { /* mongo may not have been used */ }
    try { await env.redis?.flush(); } catch { /* redis may not have been used */ }
  }

  parentPort!.postMessage({
    name: scenarioName,
    seed,
    passed,
    error,
    timeline: env.timeline.toString(),
  });
}

main().catch(err => {
  parentPort!.postMessage({
    name: scenarioName,
    seed,
    passed: false,
    error: err instanceof Error ? err.message : String(err),
    timeline: '',
  });
});
