import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import type * as httpTypes from 'node:http';
import { VirtualClock } from '@simnode/clock';
import { SeededRandom } from '@simnode/random';
import { HttpInterceptor } from '@simnode/http-proxy';
import { Scheduler } from '@simnode/scheduler';

const _require = createRequire(import.meta.url);
const http: typeof httpTypes = _require('node:http');

// Helpers

function httpRequest(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, (res: any) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode as number, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Integration: HTTP latency + virtual clock

describe('HTTP + Clock integration', () => {
  it('multiple requests with different latencies resolve in correct virtual order', async () => {
    const clock = new VirtualClock(0);
    const interceptor = new HttpInterceptor({ clock });
    interceptor.mock('http://fast.api.com/', { status: 200, body: '"fast"', latency: 50 });
    interceptor.mock('http://slow.api.com/', { status: 200, body: '"slow"', latency: 300 });
    interceptor.install();

    const order: string[] = [];
    const p1 = httpRequest('http://fast.api.com/x').then(r => { order.push('fast'); return r; });
    const p2 = httpRequest('http://slow.api.com/x').then(r => { order.push('slow'); return r; });

    clock.advance(50);
    await p1;
    expect(order).toEqual(['fast']);

    clock.advance(250);
    await p2;
    expect(order).toEqual(['fast', 'slow']);

    interceptor.uninstall();
  });

  it('100 concurrent requests all resolve correctly after clock advance', async () => {
    const clock = new VirtualClock(0);
    const interceptor = new HttpInterceptor({ clock });
    interceptor.mock('http://bulk.api.com/', { status: 200, body: '{"n":1}', latency: 200 });
    interceptor.install();

    const promises = Array.from({ length: 100 }, (_, i) =>
      httpRequest(`http://bulk.api.com/${i}`),
    );

    clock.advance(200);
    const results = await Promise.all(promises);
    expect(results).toHaveLength(100);
    results.forEach(r => expect(r.status).toBe(200));

    expect(interceptor.calls()).toHaveLength(100);
    interceptor.uninstall();
  });
});

// Integration: Deterministic replay

describe('deterministic replay', () => {
  it('same seed produces identical scheduler ordering across 10 replays', async () => {
    async function replayWithSeed(seed: number): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];
      for (let i = 0; i < 10; i++) {
        sched.enqueueCompletion({
          id: `req-${i}`,
          when: 100,
          run: () => { order.push(`req-${i}`); },
        });
      }
      await sched.runTick(100);
      return order;
    }

    const baseline = await replayWithSeed(42);
    for (let run = 0; run < 10; run++) {
      const replay = await replayWithSeed(42);
      expect(replay).toEqual(baseline);
    }
  });

  it('same seed produces identical PRNG sequences + scheduler order', async () => {
    async function fullRun(seed: number): Promise<{ randoms: number[]; order: string[] }> {
      const rng = new SeededRandom(seed);
      const randoms = Array.from({ length: 20 }, () => rng.next());

      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];
      for (let i = 0; i < 5; i++) {
        sched.enqueueCompletion({
          id: `op-${i}`,
          when: 50,
          run: () => { order.push(`op-${i}`); },
        });
      }
      await sched.runTick(50);
      return { randoms, order };
    }

    const a = await fullRun(999);
    const b = await fullRun(999);
    expect(a.randoms).toEqual(b.randoms);
    expect(a.order).toEqual(b.order);
  });

  it('different seeds explore different paths', async () => {
    async function run(seed: number) {
      const rng = new SeededRandom(seed);
      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];
      const randoms = Array.from({ length: 5 }, () => rng.next());
      for (let i = 0; i < 5; i++) {
        sched.enqueueCompletion({ id: `op${i}`, when: 100, run: () => { order.push(`op${i}`); } });
      }
      await sched.runTick(100);
      return { randoms, order };
    }

    const r1 = await run(1);
    const r2 = await run(2);
    // At least one of randoms or order should differ
    const randomsDiffer = JSON.stringify(r1.randoms) !== JSON.stringify(r2.randoms);
    const orderDiffer = JSON.stringify(r1.order) !== JSON.stringify(r2.order);
    expect(randomsDiffer || orderDiffer).toBe(true);
  });
});

// Stress: HTTP + clock + scheduler integration

describe('stress: deterministic replay with HTTP', () => {
  it('50 HTTP requests with latency produce identical call order across replays', async () => {
    async function scenario(seed: number): Promise<string[]> {
      const clock = new VirtualClock(0);
      const interceptor = new HttpInterceptor({ clock });

      // Use seed to create varying latencies
      const rng = new SeededRandom(seed);
      for (let i = 0; i < 50; i++) {
        const latency = Math.floor(rng.next() * 500) + 10;
        interceptor.mock(`http://svc-${i}.test.com/`, {
          status: 200,
          body: `"${i}"`,
          latency,
        });
      }
      interceptor.install();

      const completionOrder: string[] = [];
      const promises = Array.from({ length: 50 }, (_, i) =>
        httpRequest(`http://svc-${i}.test.com/`).then(() => {
          completionOrder.push(`svc-${i}`);
        }),
      );

      // Advance enough to fire all timers
      clock.advance(600);
      await Promise.all(promises);

      interceptor.uninstall();
      return completionOrder;
    }

    const baseline = await scenario(123);
    expect(baseline).toHaveLength(50);

    // Replay with same seed — must be identical
    const replay = await scenario(123);
    expect(replay).toEqual(baseline);

    // Different seed — should produce different order
    const different = await scenario(456);
    expect(different).not.toEqual(baseline);
  });
});

// Stress: repeated seed runs

describe('stress: multi-seed exploration', () => {
  it('different seeds produce different scheduler orderings', async () => {
    async function runSeed(seed: number): Promise<string[]> {
      const sched = new Scheduler({ prngSeed: seed });
      const order: string[] = [];
      sched.enqueueCompletion({ id: 'A', when: 100, run: () => { order.push('A'); } });
      sched.enqueueCompletion({ id: 'B', when: 100, run: () => { order.push('B'); } });
      sched.enqueueCompletion({ id: 'C', when: 100, run: () => { order.push('C'); } });
      sched.enqueueCompletion({ id: 'D', when: 100, run: () => { order.push('D'); } });
      sched.enqueueCompletion({ id: 'E', when: 100, run: () => { order.push('E'); } });
      await sched.runTick(100);
      return order;
    }

    // Run with 20 different seeds, expect at least 2 distinct orderings
    const orderings = new Set<string>();
    for (let s = 0; s < 20; s++) {
      const o = await runSeed(s * 7919); // use prime multiplier for spread
      expect(o).toHaveLength(5);
      orderings.add(o.join(','));
    }
    expect(orderings.size).toBeGreaterThanOrEqual(2);
  });
});
