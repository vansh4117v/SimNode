/**
 * Determinism stress test.
 *
 * Exercises the exact code path that caused the original replay bug:
 *   concurrent TCP writes → VirtualSocket → scheduler (with latency)
 *   → sort-by-content-hash → PRNG shuffle → execute.
 *
 * For each seed, runs the scenario REPEAT times and asserts that
 * the execution order is identical every time.  Any remaining source
 * of non-determinism (enqueue-order-dependent IDs, insufficient
 * warm-up, unpatched globals) would cause a mismatch.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import type * as netTypes from 'node:net';
import { VirtualClock } from '@crashlab/clock';
import { Scheduler } from '@crashlab/scheduler';
import { TcpInterceptor } from '@crashlab/tcp';
import { RedisMock } from '@crashlab/redis-mock';

const _require = createRequire(import.meta.url);
const net: typeof netTypes = _require('node:net');

function tcpConnect(port: number, host = 'localhost'): Promise<netTypes.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, host);
    sock.on('connect', () => resolve(sock));
    sock.on('error', reject);
  });
}

function redisCmd(...args: string[]): Buffer {
  const resp = args.map(a => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('');
  return Buffer.from(`*${args.length}\r\n${resp}`);
}

/**
 * Scenario: two concurrent INCR commands on the same Redis key.
 * With latency > 0 both ops sit in the scheduler until clock.advance
 * drains them.  The PRNG-determined order decides which socket sees
 * ":1" vs ":2".  This order MUST be identical for the same seed.
 */
async function runConcurrentIncr(seed: number): Promise<string[]> {
  const clock = new VirtualClock(0);
  const scheduler = new Scheduler({ prngSeed: seed });
  clock.onTick = (t) => scheduler.runTick(t);
  const redis = new RedisMock();
  const tcp = new TcpInterceptor({ clock, scheduler });
  tcp.mock('localhost:6379', { handler: redis.createHandler(), latency: 50 });
  tcp.install();

  const results: string[] = [];
  const s1 = await tcpConnect(6379);
  const s2 = await tcpConnect(6379);

  const p1 = new Promise<void>(resolve => {
    s1.on('data', (d: Buffer) => { results.push('s1:' + d.toString().trim()); resolve(); });
  });
  const p2 = new Promise<void>(resolve => {
    s2.on('data', (d: Buffer) => { results.push('s2:' + d.toString().trim()); resolve(); });
  });

  // Both writes enqueue at virtual t=0, when=50
  s1.write(redisCmd('INCR', 'counter'));
  s2.write(redisCmd('INCR', 'counter'));

  // Drain at virtual t=50
  await clock.advance(50);
  await new Promise(r => setTimeout(r, 20));
  await Promise.all([p1, p2]);

  s1.destroy();
  s2.destroy();
  tcp.uninstall();
  await redis.flush();
  return results;
}

/* ── Stress tests ────────────────────────────────────────────────── */

const SEEDS = 10;
const REPEAT = 10;

describe('determinism stress', () => {
  it(`concurrent TCP ops: same seed → same order (${SEEDS} seeds × ${REPEAT} repeats)`, async () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const baseline = await runConcurrentIncr(seed);
      expect(baseline).toHaveLength(2);

      for (let r = 1; r < REPEAT; r++) {
        const result = await runConcurrentIncr(seed);
        expect(result).toEqual(baseline);
      }
    }
  }, 60_000);

  it('different seeds produce at least 2 distinct orders', async () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const result = await runConcurrentIncr(seed);
      orders.add(JSON.stringify(result));
    }
    // With 20 seeds and 2 possible orders, we'd expect both
    expect(orders.size).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
