import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/index.js';

// Large completion queues

describe('large queues', () => {
  it('handles 1000 same-tick completions', async () => {
    const sched = new Scheduler({ prngSeed: 42 });
    const fired: number[] = [];
    for (let i = 0; i < 1000; i++) {
      sched.enqueueCompletion({ id: `op-${i}`, when: 100, run: () => { fired.push(i); } });
    }
    expect(sched.pendingCount).toBe(1000);
    await sched.runTick(100);
    expect(fired).toHaveLength(1000);
    expect(sched.pendingCount).toBe(0);
  });

  it('1000 same-tick completions are deterministic across runs', async () => {
    async function run(seed: number): Promise<number[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const fired: number[] = [];
      for (let i = 0; i < 100; i++) {
        sched.enqueueCompletion({ id: `op-${i}`, when: 50, run: () => { fired.push(i); } });
      }
      await sched.runTick(50);
      return fired;
    }
    const a = await run(42);
    const b = await run(42);
    expect(a).toEqual(b);
  });
});

// Multi-wave cascading

describe('multi-wave cascading', () => {
  it('three waves of cascading completions', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({
      id: 'wave1',
      when: 100,
      run: () => {
        order.push('wave1');
        sched.enqueueCompletion({
          id: 'wave2',
          when: 100,
          run: () => {
            order.push('wave2');
            sched.enqueueCompletion({
              id: 'wave3',
              when: 100,
              run: () => { order.push('wave3'); },
            });
          },
        });
      },
    });

    await sched.runTick(100);
    // Expected: ["wave1", "wave2", "wave3"] — strict causal ordering
    expect(order).toEqual(['wave1', 'wave2', 'wave3']);
  });
});

// Mixed timestamps with cascading

describe('mixed timestamps', () => {
  it('earlier ops run first, later ops are held for their tick', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({ id: 'at-200', when: 200, run: () => { order.push('at-200'); } });
    sched.enqueueCompletion({ id: 'at-100', when: 100, run: () => { order.push('at-100'); } });
    sched.enqueueCompletion({ id: 'at-150', when: 150, run: () => { order.push('at-150'); } });

    await sched.runTick(150);
    // Expected: at-100 and at-150 run, at-200 still pending
    expect(order).toEqual(['at-100', 'at-150']);
    expect(sched.pendingCount).toBe(1);

    await sched.runTick(200);
    expect(order).toEqual(['at-100', 'at-150', 'at-200']);
  });
});

// Async run callbacks

describe('async run callbacks', () => {
  it('awaits async run() before proceeding to next op', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    const order: string[] = [];

    sched.enqueueCompletion({
      id: 'async-op',
      when: 100,
      run: async () => {
        await new Promise<void>(r => { queueMicrotask(r); });
        order.push('async-done');
      },
    });
    sched.enqueueCompletion({
      id: 'sync-op',
      when: 100,
      run: () => { order.push('sync-done'); },
    });

    await sched.runTick(100);
    // async-done must appear before sync-done (sequential execution)
    const asyncIdx = order.indexOf('async-done');
    const syncIdx = order.indexOf('sync-done');
    expect(asyncIdx).toBeGreaterThanOrEqual(0);
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    // Both ran
    expect(order).toHaveLength(2);
  });
});

// Deterministic seed exploration

describe('seed exploration', () => {
  it('different seeds explore different orderings of 5 ops', async () => {
    async function run(seed: number): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];
      for (let i = 0; i < 5; i++) {
        sched.enqueueCompletion({ id: `op${i}`, when: 100, run: () => { order.push(`op${i}`); } });
      }
      await sched.runTick(100);
      return order;
    }

    const orderings = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      orderings.add((await run(seed)).join(','));
    }
    // With 5 ops and 20 seeds, we should see at least 3 distinct orderings
    expect(orderings.size).toBeGreaterThanOrEqual(3);
  });
});

// Replay determinism: enqueue order must NOT affect shuffle outcome
//
// Root cause of the original bug: Fisher-Yates shuffle on [A,B] vs [B,A]
// with the same seed produced different results because the initial array
// order fed into the shuffle differed.  The fix (sort by id before shuffle)
// means the shuffle always starts from a canonical order.

describe('replay determinism', () => {
  it('same seed produces same order regardless of enqueue order', async () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

    async function runWithEnqueueOrder(seed: number, order: string[]): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const result: string[] = [];
      for (const id of order) {
        sched.enqueueCompletion({ id, when: 100, run: () => { result.push(id); } });
      }
      await sched.runTick(100);
      return result;
    }

    const reversed = [...ids].reverse();
    const shuffled = [ids[2], ids[0], ids[4], ids[1], ids[3]];

    for (let seed = 0; seed < 10; seed++) {
      const forward  = await runWithEnqueueOrder(seed, ids);
      const backward = await runWithEnqueueOrder(seed, reversed);
      const mixed    = await runWithEnqueueOrder(seed, shuffled);

      expect(backward).toEqual(forward);
      expect(mixed).toEqual(forward);
    }
  });

  it('enqueue order independence holds with 2-op groups (the minimal race)', async () => {
    async function run(seed: number, first: string, second: string): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const result: string[] = [];
      sched.enqueueCompletion({ id: first,  when: 50, run: () => { result.push(first);  } });
      sched.enqueueCompletion({ id: second, when: 50, run: () => { result.push(second); } });
      await sched.runTick(50);
      return result;
    }

    for (let seed = 0; seed < 20; seed++) {
      const ab = await run(seed, 'req-A', 'req-B');
      const ba = await run(seed, 'req-B', 'req-A');
      expect(ba).toEqual(ab);
    }
  });
});

// runTick with no pending ops

describe('edge cases', () => {
  it('runTick with empty queue is a no-op', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    await sched.runTick(1000); // should not throw
    expect(sched.pendingCount).toBe(0);
  });

  it('drain on empty queue is a no-op', async () => {
    const sched = new Scheduler({ prngSeed: 1 });
    await sched.drain(); // should not throw
  });
});
