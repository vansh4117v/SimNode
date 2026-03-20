import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import type * as netTypes from 'node:net';
import { VirtualClock } from '@simnode/clock';
import { Scheduler } from '@simnode/scheduler';
import { TcpInterceptor, SimNodeUnmockedTCPConnectionError } from '@simnode/tcp';
import { PgMock } from '@simnode/pg-mock';
import { RedisMock } from '@simnode/redis-mock';
import { Simulation } from '@simnode/core';
import type { SimEnv } from '@simnode/core';

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

      // Wait for PGlite to initialise and seed data before scheduling
      await pg.ready();

      // Simulate two concurrent DB queries at the same virtual time
      scheduler.enqueueCompletion({
        id: 'query-A',
        when: 100,
        run: async () => {
          const r = await pg.query('SELECT * FROM items');
          const row = r.rows[0] as { id: string; name: string };
          order.push(`A:${row.name}`);
        },
      });
      scheduler.enqueueCompletion({
        id: 'query-B',
        when: 100,
        run: async () => {
          const r = await pg.query('SELECT * FROM items');
          const row = r.rows[0] as { id: string; name: string };
          order.push(`B:${row.name}`);
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
  }, 30_000);
});

/* ── B) Redis concurrent INCR ──────────────────────── */

describe('Redis concurrent INCR', () => {
  let redisHost: string;
  let redisPort: number;
  let stopRedis: () => Promise<void>;

  // Start a real redis-server for this describe block
  it('deterministic INCR sequence by seed', async () => {
    const { RedisMemoryServer } = await import('redis-memory-server');
    const server = new RedisMemoryServer();
    redisHost = await server.getHost();
    redisPort = await server.getPort();
    stopRedis = () => server.stop().then(() => {});

    try {
      async function runWithSeed(seed: number): Promise<string[]> {
        const clock = new VirtualClock(0);
        const scheduler = new Scheduler({ prngSeed: seed });
        // Create RedisMock BEFORE installing TcpInterceptor so it captures real net.createConnection
        const redis = new RedisMock({ redisHost, redisPort });
        const tcp = new TcpInterceptor({ clock, scheduler });
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
        await redis.flush();
        return results;
      }

      const r1 = await runWithSeed(42);
      const r2 = await runWithSeed(42);
      expect(r1).toEqual(r2);
    } finally {
      await stopRedis();
    }
  }, 30_000);
});

/* ── C) Simulation seed replay ─────────────────────── */
// NOTE: Scenario functions run inside a Worker thread — closures over
// variables defined outside the scenario body are NOT available.
// Results must be communicated exclusively via env.timeline.

describe('Simulation seed replay', () => {
  it('same seed → identical random values and timeline', async () => { // runs 2 workers

    const sim = new Simulation();

    sim.scenario('determinism', async (env: SimEnv) => {
      const vals = [env.random.next(), env.random.next(), env.random.next()];
      env.timeline.record({ timestamp: 0, type: 'DATA', detail: vals.join(',') });
    });

    const r1 = await sim.replay({ seed: 42, scenario: 'determinism' });
    const r2 = await sim.replay({ seed: 42, scenario: 'determinism' });

    // Extract the DATA line from each timeline and compare
    const extractData = (tl: string): string => tl.match(/DATA: ([^\n]+)/)?.[1] ?? '';
    expect(extractData(r1.result.timeline)).toBe(extractData(r2.result.timeline));
    expect(extractData(r1.result.timeline)).not.toBe('');
  }, 30_000);
});

/* ── D) Unmocked TCP throws ────────────────────────── */
// The scenario imports `node:net` directly inside the worker context so it
// does not need the outer-scope `net` or `SimNodeUnmockedTCPConnectionError`.

describe('Unmocked TCP safety', () => {
  it('throws SimNodeUnmockedTCPConnectionError during simulation', async () => {
    const sim = new Simulation();
    sim.scenario('unmocked', async (env: SimEnv) => {
      // env.tcp is already installed by the Simulation runner (simulation-worker.ts).
      // require() is injected into the vm sandbox by the worker.
      const net = require('node:net');
      try {
        net.createConnection(9999, 'unknown.host');
        throw new Error('Should not reach');
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (err.name === 'SimNodeUnmockedTCPConnectionError') {
          env.timeline.record({ timestamp: 0, type: 'GUARD', detail: 'Correctly blocked' });
          return;
        }
        throw e;
      }
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.passes).toBe(1);
    // Verify timeline via replay since passing scenario timelines are not retained in run()
    const replayed = await sim.replay({ seed: 0, scenario: 'unmocked' });
    expect(replayed.result.timeline).toContain('Correctly blocked');
  });
});

/* ── E) Filesystem disk full injection ───────────────── */
// Use dynamic import inside the scenario so the worker has access to node:fs.

describe('Filesystem disk full', () => {
  it('app handles ENOSPC gracefully', async () => {
    const sim = new Simulation();
    sim.scenario('disk full', async (env: SimEnv) => {
      env.faults.diskFull('/data/log.txt');
      // env.fs is already installed by the worker; re-install is a no-op.
      env.fs.install();
      // require() is injected into the vm sandbox by the worker.
      const fs = require('node:fs');
      try {
        fs.writeFileSync('/data/log.txt', 'entry');
        throw new Error('Should have thrown');
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err.code === 'ENOSPC') {
          env.timeline.record({ timestamp: 0, type: 'HANDLED', detail: 'ENOSPC caught' });
          return;
        }
        throw e;
      }
    });
    const result = await sim.run();
    expect(result.passed).toBe(true);
    expect(result.passes).toBe(1);
    const replayed = await sim.replay({ seed: 0, scenario: 'disk full' });
    expect(replayed.result.timeline).toContain('ENOSPC caught');
  });
});
