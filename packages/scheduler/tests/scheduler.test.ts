import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/index.js';

// 1. Completion barrier semantics

describe('completion barrier', () => {
  it('holds completions until runTick is called', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({ id: 'a', when: 100, run: () => { order.push('a'); } });
    sched.enqueueCompletion({ id: 'b', when: 100, run: () => { order.push('b'); } });

    // Before runTick: nothing has executed
    // Expected: []
    expect(order).toEqual([]);
    expect(sched.pendingCount).toBe(2);

    await sched.runTick(100);

    // After runTick: both ran
    // Expected: order has length 2, contains both 'a' and 'b'
    expect(order).toHaveLength(2);
    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(sched.pendingCount).toBe(0);
  });

  it('does not release ops whose `when` is beyond the tick', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({ id: 'early', when: 50, run: () => { order.push('early'); } });
    sched.enqueueCompletion({ id: 'late', when: 200, run: () => { order.push('late'); } });

    await sched.runTick(100);

    // Expected: only 'early' ran — 'late' is still pending
    // Expected: ["early"]
    expect(order).toEqual(['early']);
    expect(sched.pendingCount).toBe(1);
  });
});

// 2. Deterministic ordering by seed

describe('deterministic ordering', () => {
  it('seed A produces one order, seed B produces another', async () => {
    async function runWithSeed(seed: number): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];

      sched.enqueueCompletion({ id: 'op1', when: 100, run: () => { order.push('op1'); } });
      sched.enqueueCompletion({ id: 'op2', when: 100, run: () => { order.push('op2'); } });

      await sched.runTick(100);
      return order;
    }

    const orderA = await runWithSeed(42);
    const orderB = await runWithSeed(99);

    // Expected with seed 42: ["op1", "op2"]
    // Expected with seed 99: ["op2", "op1"]
    expect(orderA).toEqual(['op1', 'op2']);
    expect(orderB).toEqual(['op2', 'op1']);
  });

  it('same seed always produces the same order', async () => {
    async function runWithSeed(seed: number): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];

      sched.enqueueCompletion({ id: 'x', when: 50, run: () => { order.push('x'); } });
      sched.enqueueCompletion({ id: 'y', when: 50, run: () => { order.push('y'); } });
      sched.enqueueCompletion({ id: 'z', when: 50, run: () => { order.push('z'); } });

      await sched.runTick(50);
      return order;
    }

    const run1 = await runWithSeed(7);
    const run2 = await runWithSeed(7);

    // Expected: identical order on both runs
    expect(run1).toEqual(run2);
  });
});

// 3. Timestamp ordering

describe('timestamp ordering', () => {
  it('ops at earlier virtual time run before later ones', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    // Enqueue in reverse chronological order
    sched.enqueueCompletion({ id: 'late', when: 200, run: () => { order.push('late'); } });
    sched.enqueueCompletion({ id: 'early', when: 100, run: () => { order.push('early'); } });
    sched.enqueueCompletion({ id: 'mid', when: 150, run: () => { order.push('mid'); } });

    await sched.runTick(300);

    // Expected: ["early", "mid", "late"] — always in timestamp order
    expect(order).toEqual(['early', 'mid', 'late']);
  });
});

// 4. drain()

describe('drain', () => {
  it('flushes all pending ops regardless of when', async () => {
    const sched = new Scheduler({ prngSeed: 0 });
    const order: string[] = [];

    sched.enqueueCompletion({ id: 'a', when: 999_999, run: () => { order.push('a'); } });
    sched.enqueueCompletion({ id: 'b', when: 1, run: () => { order.push('b'); } });

    await sched.drain();

    // Expected: both ran, 'b' before 'a' (timestamp order)
    expect(order).toEqual(['b', 'a']);
    expect(sched.pendingCount).toBe(0);
  });
});

// 5. Cascading completions within same tick

describe('cascading completions', () => {
  it('allows ops to enqueue new ops in the same tick', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({
      id: 'A',
      when: 100,
      run: () => {
        order.push('A');

        // Schedule new op at same virtual time
        sched.enqueueCompletion({
          id: 'B',
          when: 100,
          run: () => {
            order.push('B');
          }
        });
      }
    });

    sched.enqueueCompletion({
      id: 'C',
      when: 100,
      run: () => {
        order.push('C');
      }
    });

    await sched.runTick(100);

    // A must run before B because B is created by A
    const indexA = order.indexOf('A');
    const indexB = order.indexOf('B');

    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThan(indexA);

    // All ops must run
    expect(order.sort()).toEqual(['A', 'B', 'C'].sort());
  });
});

// 6. Microtask flushing

describe('microtask flushing', () => {
  it('runs microtasks between operations', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({
      id: 'A',
      when: 100,
      run: async () => {
        order.push('A');

        Promise.resolve().then(() => {
          order.push('A-microtask');
        });
      }
    });

    sched.enqueueCompletion({
      id: 'B',
      when: 100,
      run: () => {
        order.push('B');
      }
    });

    await sched.runTick(100);

    // Microtask from A must run before B
    expect(order).toEqual(['A', 'A-microtask', 'B']);
  });
});

// 7. requestRunTick() auto-drain

describe('requestRunTick', () => {
  it('drains ready ops without explicit runTick call', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({ id: 'a', when: 0, run: () => { order.push('a'); } });
    sched.requestRunTick(0);

    await new Promise<void>(r => setTimeout(r, 0));
    expect(order).toEqual(['a']);
  });

  it('coalesces same-turn requests and drains all ready ops once', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({ id: 'a', when: 0, run: () => { order.push('a'); } });
    sched.enqueueCompletion({ id: 'b', when: 0, run: () => { order.push('b'); } });
    sched.requestRunTick(0);
    sched.requestRunTick(0);

    await new Promise<void>(r => setTimeout(r, 0));
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(['a', 'b']));
    expect(sched.pendingCount).toBe(0);
  });
});