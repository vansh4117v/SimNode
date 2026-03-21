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
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { createFetchPatch } from '@simnode/http-proxy';
import { createEnv, installDeterminismPatches } from './env.js';
import type { SimEnv } from './env.js';

// A require() scoped to this worker — injected into the vm sandbox.
const _workerRequire = createRequire(import.meta.url);

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

  // Install all interceptors on THIS thread's net/http/fs globals
  env.http.install();
  env.tcp.install();
  env.fs.install();

  // Patch globalThis.fetch to go through the HTTP interceptor (Shift 5)
  const origFetch = globalThis.fetch;
  if (origFetch) globalThis.fetch = createFetchPatch(env.http, origFetch) as typeof globalThis.fetch;

  // Apply determinism patches to THIS thread's globals
  const patches = installDeterminismPatches(env);

  let passed = true;
  let error: string | undefined;

  try {
    env.timeline.record({ timestamp: 0, type: 'START', detail: `Scenario: ${scenarioName}, seed: ${seed}` });

    let scenarioFn: (env: SimEnv) => Promise<void>;

    if (scenarioPath) {
      // ── File-based scenario: import() the module directly.
      // The Worker thread's own global isolation is sufficient — no vm needed.
      const mod = await import(scenarioPath) as { default?: (env: SimEnv) => Promise<void> };
      scenarioFn = mod.default ?? (() => { throw new Error(`${scenarioPath} has no default export`); });
    } else {
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
      scenarioFn(env),
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
    try { await env.mongo.drop(); } catch { /* mongo may not have been used */ }
    try { await env.redis.flush(); } catch { /* redis may not have been used */ }
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
