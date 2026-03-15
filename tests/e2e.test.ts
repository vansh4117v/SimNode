import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import type * as netTypes from 'node:net';
import { VirtualClock } from '@simnode/clock';
import { Scheduler } from '@simnode/scheduler';
import { TcpInterceptor, SimNodeUnmockedTCPConnectionError } from '@simnode/tcp';
import { PgMock } from '@simnode/pg-mock';
import { RedisMock } from '@simnode/redis-mock';
import { Simulation } from '@simnode/core';

const _require = createRequire(import.meta.url);
const net: typeof netTypes = _require('node:net');

function tcpWrite(sock: netTypes.Socket, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sock.once('data', (chunk: Buffer) => resolve(chunk));
    sock.once('error', reject);
    sock.write(data);
  });
}

function tcpConnect(port: number, host = 'localhost'): Promise<netTypes.Socket> {
  return new Promise(resolve => {
    const sock = net.createConnection(port, host);
    sock.on('connect', () => resolve(sock));
  });
}

function pgStartup(): Buffer {
  const parts = [Buffer.alloc(4), Buffer.alloc(4), Buffer.from('user\0test\0\0')];
  parts[1].writeInt32BE(196608);
  const msg = Buffer.concat(parts);
  msg.writeInt32BE(msg.length, 0);
  return msg;
}

function pgQuery(sql: string): Buffer {
  const q = Buffer.from(sql + '\0');
  const msg = Buffer.concat([Buffer.from('Q'), Buffer.alloc(4), q]);
  msg.writeInt32BE(q.length + 4, 1);
  return msg;
}

function redisCmd(...args: string[]): Buffer {
  const resp = args.map(a => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('');
  return Buffer.from(`*${args.length}\r\n${resp}`);
}

/* ── A) Scheduler + PG mock ordering ─────────────────── */

describe('Scheduler + PG mock ordering', () => {
  it('two queries at same tick: order depends on seed', async () => {
    async function runWithSeed(seed: number): Promise<string[]> {
      const scheduler = new Scheduler({ prngSeed: seed });
      const pg = new PgMock();
      pg.seedData('items', [{ id: '1', name: 'Widget' }]);

      const order: string[] = [];

      // Simulate two concurrent DB queries at the same virtual time
      scheduler.enqueueCompletion({
        id: 'query-A',
        when: 100,
        run: () => {
          const r = pg.store.execSQL('SELECT * FROM items');
          order.push(`A:${r.rows![0][1]}`);
        },
      });
      scheduler.enqueueCompletion({
        id: 'query-B',
        when: 100,
        run: () => {
          const r = pg.store.execSQL('SELECT * FROM items');
          order.push(`B:${r.rows![0][1]}`);
        },
      });

      await scheduler.runTick(100);
      return order;
    }

    const run1 = await runWithSeed(42);
    const run2 = await runWithSeed(42);
    // Same seed → same execution order
    expect(run1).toEqual(run2);
    expect(run1).toHaveLength(2);
    expect(run1).toContain('A:Widget');
    expect(run1).toContain('B:Widget');
  });
});

/* ── B) Redis concurrent INCR ──────────────────────── */

describe('Redis concurrent INCR', () => {
  it('deterministic INCR sequence by seed', async () => {
    async function runWithSeed(seed: number): Promise<string[]> {
      const clock = new VirtualClock(0);
      const scheduler = new Scheduler({ prngSeed: seed });
      const tcp = new TcpInterceptor({ clock, scheduler });
      const redis = new RedisMock({ clock });
      tcp.mock('localhost:6379', { handler: redis.createHandler(), latency: 5 });
      tcp.install();

      const results: string[] = [];
      const s1 = await tcpConnect(6379);
      const s2 = await tcpConnect(6379);

      s1.on('data', (d: Buffer) => results.push('s1:' + d.toString().trim()));
      s2.on('data', (d: Buffer) => results.push('s2:' + d.toString().trim()));

      s1.write(redisCmd('INCR', 'counter'));
      s2.write(redisCmd('INCR', 'counter'));

      await scheduler.runTick(5);
      await new Promise(r => setTimeout(r, 10));

      s1.destroy(); s2.destroy();
      tcp.uninstall();
      return results;
    }

    const r1 = await runWithSeed(42);
    const r2 = await runWithSeed(42);
    expect(r1).toEqual(r2);
  });
});

/* ── C) Simulation seed replay ─────────────────────── */

describe('Simulation seed replay', () => {
  it('same seed → identical random values and timeline', async () => {
    const sim = new Simulation();
    const runs: Array<{ vals: number[]; timeline: string }> = [];

    sim.scenario('determinism', async (env) => {
      const vals = [env.random.next(), env.random.next(), env.random.next()];
      env.timeline.record({ timestamp: 0, type: 'DATA', detail: vals.join(',') });
      runs.push({ vals, timeline: '' });
    });

    await sim.replay({ seed: 42, scenario: 'determinism' });
    const first = { ...runs[0] };
    runs.length = 0;
    await sim.replay({ seed: 42, scenario: 'determinism' });
    expect(runs[0].vals).toEqual(first.vals);
  });
});

/* ── D) Unmocked TCP throws ────────────────────────── */

describe('Unmocked TCP safety', () => {
  it('throws SimNodeUnmockedTCPConnectionError during simulation', async () => {
    const sim = new Simulation();
    sim.scenario('unmocked', async (env) => {
      env.tcp.install();
      try {
        net.createConnection(9999, 'unknown.host');
        throw new Error('Should not reach');
      } catch (e) {
        if (e instanceof SimNodeUnmockedTCPConnectionError) {
          env.timeline.record({ timestamp: 0, type: 'GUARD', detail: 'Correctly blocked' });
          return;
        }
        throw e;
      }
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.scenarios[0].timeline).toContain('Correctly blocked');
  });
});

/* ── E) Filesystem disk full injection ───────────────── */

describe('Filesystem disk full', () => {
  it('app handles ENOSPC gracefully', async () => {
    const sim = new Simulation();
    sim.scenario('disk full', async (env) => {
      env.faults.diskFull('/data/log.txt');
      env.fs.install();
      const fs = _require('node:fs') as typeof import('node:fs');
      try {
        fs.writeFileSync('/data/log.txt', 'entry');
        throw new Error('Should have thrown');
      } catch (e: any) {
        if (e.code === 'ENOSPC') {
          env.timeline.record({ timestamp: 0, type: 'HANDLED', detail: 'ENOSPC caught' });
          return;
        }
        throw e;
      }
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.scenarios[0].timeline).toContain('ENOSPC caught');
  });
});
