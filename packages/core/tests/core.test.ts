import { describe, it, expect } from 'vitest';
import { Simulation } from '../src/index.js';

describe('Simulation harness', () => {
  it('runs a passing scenario', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('simple pass', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'TEST', detail: 'hello' });
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].timeline).toContain('hello');
  });

  it('captures failing scenario', async () => {
    const sim = new Simulation({ seed: 0 });
    sim.scenario('will fail', async () => { throw new Error('boom'); });
    const result = await sim.run();
    expect(result.passed).toBe(false);
    expect(result.scenarios[0].error).toBe('boom');
    expect(result.scenarios[0].timeline).toContain('FAIL');
  });

  it('runs multiple seeds', async () => {
    const sim = new Simulation({ seed: 0 });
    const seenSeeds: number[] = [];
    sim.scenario('seed tracker', async (env) => { seenSeeds.push(env.seed); });
    await sim.run({ seeds: 5 });
    expect(seenSeeds).toEqual([0, 1, 2, 3, 4]);
  });

  it('replay reproduces a specific seed', async () => {
    const sim = new Simulation({ seed: 0 });
    const values: number[] = [];
    sim.scenario('prng test', async (env) => {
      values.push(env.random.next());
    });
    await sim.replay({ seed: 42, scenario: 'prng test' });
    const first = values[0];
    values.length = 0;
    await sim.replay({ seed: 42, scenario: 'prng test' });
    expect(values[0]).toBe(first);
  });

  it('creates env with all mocked services', async () => {
    const sim = new Simulation();
    sim.scenario('env check', async (env) => {
      expect(env.clock).toBeDefined();
      expect(env.random).toBeDefined();
      expect(env.scheduler).toBeDefined();
      expect(env.http).toBeDefined();
      expect(env.tcp).toBeDefined();
      expect(env.fs).toBeDefined();
      expect(env.faults).toBeDefined();
      expect(env.timeline).toBeDefined();
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
  });

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
    expect(result.scenarios[0].timeline).toContain('Disk full');
  });

  it('fault injector: clockSkew advances time', async () => {
    const sim = new Simulation();
    sim.scenario('time skip', async (env) => {
      expect(env.clock.now()).toBe(0);
      env.faults.clockSkew(5000);
      expect(env.clock.now()).toBe(5000);
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
  });
});

describe('Timeline', () => {
  it('toString formats events', async () => {
    const sim = new Simulation();
    sim.scenario('timeline', async (env) => {
      env.timeline.record({ timestamp: 0, type: 'OP', detail: 'read' });
      env.timeline.record({ timestamp: 100, type: 'OP', detail: 'write' });
    });
    const result = await sim.run();
    expect(result.scenarios[0].timeline).toContain('[0ms] START');
    expect(result.scenarios[0].timeline).toContain('[0ms] OP: read');
    expect(result.scenarios[0].timeline).toContain('[100ms] OP: write');
  });
});
