import { describe, it, expect } from 'vitest';
import { Simulation } from '../src/index.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Simulation harness', () => {
  it('runs a passing scenario', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('simple pass', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'TEST', detail: 'hello' });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.passes).toBe(1);
    expect(result.failures).toHaveLength(0);
    // Verify timeline content via replay (passing timelines are not retained in run())
    const replayed = await sim.replay({ seed: 0, scenario: 'simple pass' });
    expect(replayed.result.timeline).toContain('hello');
  }, 30_000);

  it('captures failing scenario', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('will fail', async () => { throw new Error('boom'); });
    const result = await sim.run();
    expect(result.passed).toBe(false);
    expect(result.failures[0].error).toBe('boom');
    expect(result.failures[0].timeline).toContain('FAIL');
  });

  it('runs multiple seeds', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('seed tracker', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'SEED', detail: String(env.seed) });
    });
    const result = await sim.run({ seeds: 5, stopOnFirstFailure: false });
    expect(result.passes).toBe(5);
    expect(result.failures).toHaveLength(0);
  }, 30_000);

  it('stopOnFirstFailure stops after first failing seed', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('always fails', async () => { throw new Error('always fails'); });
    // With 10 seeds + stopOnFirstFailure, only 1 failure should be recorded
    const result = await sim.run({ seeds: 10, stopOnFirstFailure: true });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.passes).toBe(0);
  });

  it('stopOnFirstFailure: false collects all failures', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('always fails', async () => { throw new Error('fail'); });
    const result = await sim.run({ seeds: 3, stopOnFirstFailure: false });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.passes).toBe(0);
  }, 30_000);

  it('replay reproduces a specific seed', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('prng test', async (env) => {
      const v = env.random.next();
      env.timeline.record({ timestamp: 0, type: 'RNG', detail: String(v) });
    });
    const r1 = await sim.replay({ seed: 42, scenario: 'prng test' });
    const r2 = await sim.replay({ seed: 42, scenario: 'prng test' });
    const extract = (tl: string) => tl.match(/RNG: ([^\n]+)/)?.[1];
    expect(extract(r1.result.timeline)).toBe(extract(r2.result.timeline));
  }, 30_000);

  it('creates env with all mocked services', async () => {
    const sim = new Simulation();
    sim.scenario('env check', async (env) => {
      const allDefined = [env.clock, env.random, env.scheduler, env.http,
        env.tcp, env.fs, env.faults, env.timeline].every(v => v != null);
      env.timeline.record({ timestamp: 0, type: 'CHECK', detail: allDefined ? 'all-defined' : 'missing' });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.passes).toBe(1);
    const replayed = await sim.replay({ seed: 0, scenario: 'env check' });
    expect(replayed.result.timeline).toContain('all-defined');
  }, 30_000);

  it('hunt counts completed seeds (not per-scenario runs)', async () => {
    const sim = new Simulation({ seed: 100 });
    const progress: Array<{ seed: number; passed: boolean }> = [];

    sim.scenario('pass-first', async () => {});
    sim.scenario('fail-second', async () => { throw new Error('hunt-fail'); });

    const result = await sim.hunt({
      timeout: 10_000,
      onProgress: (seed, passed) => progress.push({ seed, passed }),
    });

    expect(result.failure).not.toBeNull();
    expect(result.seedsRun).toBe(1);
    expect(progress).toEqual([{ seed: 100, passed: false }]);
  }, 30_000);

  it('fault injector: diskFull records timeline event', async () => {
    const sim = new Simulation();
    sim.scenario('disk full', async (env) => {
      env.faults.diskFull('/tmp/data');
      env.fs.install();
      try {
        const fs = (await import('node:fs')).default;
        // This would only throw if we use the CJS fs patched by VirtualFS
      } catch (e) {
        // expected
      }
    });
    const result = await sim.run();
    // diskFull scenario passes — verify the timeline via replay
    expect(result.passed).toBe(true);
    const replayed = await sim.replay({ seed: 0, scenario: 'disk full' });
    expect(replayed.result.timeline).toContain('Disk full');
  }, 30_000);

  it('fault injector: clockSkew advances time', async () => {
    const sim = new Simulation();
    sim.scenario('time skip', async (env) => {
      env.faults.clockSkew(5000);
      env.timeline.record({ timestamp: env.clock.now(), type: 'SKEW', detail: String(env.clock.now()) });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    const replayed = await sim.replay({ seed: 0, scenario: 'time skip' });
    expect(replayed.result.timeline).toContain('SKEW: 5000');
  }, 30_000);

  it('applies per-seed Mongo URI patch before scenario import', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'simnode-scenario-'));
    const scenarioPath = join(tempDir, 'mongo-capture.mjs');

    writeFileSync(
      scenarioPath,
      [
        "const CAPTURED = process.env.MONGODB_URI || '';",
        'export default async function scenario(env) {',
        "  env.timeline.record({ timestamp: 0, type: 'MONGO_URI', detail: CAPTURED });",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const originalMongoUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb://localhost:27017/shared_db';

    try {
      const sim = new Simulation({ seed: 0 });
      sim.scenario('mongo import capture', scenarioPath);

      const replayed = await sim.replay({ seed: 7, scenario: 'mongo import capture' });
      expect(replayed.result.timeline).toContain('MONGO_URI: mongodb://localhost:27017/sim');
    } finally {
      if (originalMongoUri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = originalMongoUri;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('intercepts top-level TCP side effects during scenario import', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'simnode-scenario-'));
    const depPath = join(tempDir, 'top-level-net.mjs');
    const scenarioPath = join(tempDir, 'scenario.mjs');

    writeFileSync(
      depPath,
      [
        "import net from 'node:net';",
        "let errName = 'none';",
        'try {',
        "  net.createConnection(9999, 'unknown.host');",
        '} catch (err) {',
        "  errName = (err && typeof err === 'object' && 'name' in err) ? String(err.name) : String(err);",
        '}',
        'export default errName;',
        '',
      ].join('\n'),
      'utf8',
    );

    writeFileSync(
      scenarioPath,
      [
        "import errName from './top-level-net.mjs';",
        'export default async function scenario(env) {',
        "  env.timeline.record({ timestamp: 0, type: 'TOP_LEVEL_NET', detail: errName });",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const sim = new Simulation({ seed: 0 });
      sim.scenario('import side effects are intercepted', scenarioPath);

      const replayed = await sim.replay({ seed: 0, scenario: 'import side effects are intercepted' });
      expect(replayed.result.timeline).toContain('TOP_LEVEL_NET: SimNodeUnmockedTCPConnectionError');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('patches Mongo URI without explicit /db path before scenario import', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'simnode-scenario-'));
    const scenarioPath = join(tempDir, 'mongo-capture-nodb.mjs');

    writeFileSync(
      scenarioPath,
      [
        "const CAPTURED = process.env.MONGODB_URI || '';",
        'export default async function scenario(env) {',
        "  env.timeline.record({ timestamp: 0, type: 'MONGO_URI', detail: CAPTURED });",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const originalMongoUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb://localhost:27017?directConnection=true';

    try {
      const sim = new Simulation({ seed: 0 });
      sim.scenario('mongo import capture no-db', scenarioPath);

      const replayed = await sim.replay({ seed: 9, scenario: 'mongo import capture no-db' });
      expect(replayed.result.timeline).toContain('MONGO_URI: mongodb://localhost:27017/sim_db_9');
    } finally {
      if (originalMongoUri === undefined) delete process.env.MONGODB_URI;
      else process.env.MONGODB_URI = originalMongoUri;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves holdDrain during pump when tcp.mock barrier exits', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'simnode-scenario-'));
    const scenarioPath = join(tempDir, 'hold-drain-barrier.mjs');

    writeFileSync(
      scenarioPath,
      [
        'export default async function scenario(env) {',
        '  env.tcp.mock("localhost:27017", {',
        '    handler: env.mongo.createHandler(),',
        '    latency: 50,',
        '  });',
        '',
        '  const pumpPromise = env.pump(100, 4);',
        '  await Promise.resolve();',
        '  const duringPump = env.scheduler.holdDrain;',
        '  env.timeline.record({',
        '    timestamp: env.clock.now(),',
        '    type: "HOLD_DRAIN",',
        '    detail: String(duringPump),',
        '  });',
        '  await pumpPromise;',
        '',
        '  if (!duringPump) {',
        '    throw new Error("holdDrain was clobbered during pump");',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const sim = new Simulation({ seed: 0 });
      sim.scenario('holdDrain barrier', scenarioPath);

      const replayed = await sim.replay({ seed: 42, scenario: 'holdDrain barrier' });
      expect(replayed.passed).toBe(true);
      expect(replayed.result.timeline).toContain('HOLD_DRAIN: true');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
  
  it('ignores remock latency change when active sockets already exist', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'simnode-scenario-'));
    const scenarioPath = join(tempDir, 'remock-active-sockets.mjs');
    
    writeFileSync(
      scenarioPath,
      [
        'import net from "node:net";',
        'const connect = (port, host = "localhost") => new Promise((resolve, reject) => {',
        '  const sock = net.createConnection(port, host);',
        '  sock.once("connect", () => resolve(sock));',
        '  sock.once("error", reject);',
        '});',
        '',
        'export default async function scenario(env) {',
        '  const sock = await connect(27017, "localhost");',
        '  env.tcp.mock("localhost:27017", { handler: env.mongo.createHandler(), latency: 50 });',
        '  const internal = env.tcp;',
        '  const latency = internal._mocks.get("localhost:27017")?.latency ?? -1;',
        '  env.timeline.record({ timestamp: env.clock.now(), type: "LATENCY", detail: String(latency) });',
        '  sock.destroy();',
        '  if (latency !== 0) throw new Error(`expected latency to remain 0, got ${latency}`);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    
    try {
      const sim = new Simulation({ seed: 0 });
      sim.scenario('remock active sockets keeps latency', scenarioPath);
      
      const replayed = await sim.replay({ seed: 42, scenario: 'remock active sockets keeps latency' });
      expect(replayed.passed).toBe(true);
      expect(replayed.result.timeline).toContain('LATENCY: 0');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

});

describe('Timeline', () => {
  it('toString formats events', async () => {
    const sim = new Simulation();
    sim.scenario('timeline', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'OP', detail: 'read' });
      env.timeline.record({ timestamp: 100, type: 'OP', detail: 'write' });
    });
    // Use replay to inspect passing-scenario timeline content
    const replayed = await sim.replay({ seed: 0, scenario: 'timeline' });
    expect(replayed.result.timeline).toContain('[0ms] START');
    expect(replayed.result.timeline).toContain('[0ms] OP: read');
    expect(replayed.result.timeline).toContain('[100ms] OP: write');
  });
});
