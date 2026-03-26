import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import type * as netTypes from 'node:net';
import { TcpInterceptor, VirtualSocket, SimNodeUnmockedTCPConnectionError } from '../src/index.js';
import { VirtualClock } from '@crashlab/clock';
import { Scheduler } from '@crashlab/scheduler';

const _require = createRequire(import.meta.url);
const net: typeof netTypes = _require('node:net');

let interceptor: TcpInterceptor;
afterEach(() => { interceptor?.uninstall(); });

// Helpers

/** Connect and wait for the 'connect' event. */
function connect(port: number, host = 'localhost'): Promise<netTypes.Socket> {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host);
    sock.on('connect', () => resolve(sock));
  });
}

/** Write data and collect the first response. */
function writeAndRead(sock: netTypes.Socket, data: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sock.on('data', (chunk: Buffer) => resolve(chunk));
    sock.on('error', reject);
    sock.write(data);
  });
}

// 1. net.createConnection is intercepted

describe('TCP interception', () => {
  it('net.createConnection returns a VirtualSocket', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:5432', {
      handler: () => Buffer.from('hello'),
    });
    interceptor.install();

    const sock = await connect(5432);
    // Expected: VirtualSocket instance
    expect(sock).toBeInstanceOf(VirtualSocket);
    sock.destroy();
  });

  it('accepts URL-style targets (postgres://)', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('postgres://localhost:5432', {
      handler: () => Buffer.from('pg-ok'),
    });
    interceptor.install();

    const sock = await connect(5432);
    const res = await writeAndRead(sock, 'query');
    // Expected: "pg-ok"
    expect(res.toString()).toBe('pg-ok');
    sock.destroy();
  });

  it('accepts URL-style targets (redis://)', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('redis://localhost:6379', {
      handler: () => Buffer.from('+PONG\r\n'),
    });
    interceptor.install();

    const sock = await connect(6379);
    const res = await writeAndRead(sock, 'PING\r\n');
    expect(res.toString()).toBe('+PONG\r\n');
    sock.destroy();
  });

  it('uses MongoDB default port for mongodb:// URLs without explicit port', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('mongodb://localhost', {
      handler: () => Buffer.from('mongo-ok'),
    });
    interceptor.install();

    const sock = await connect(27017);
    const res = await writeAndRead(sock, 'ping');
    expect(res.toString()).toBe('mongo-ok');
    sock.destroy();
  });
});

// 2. VirtualSocket stream behavior

describe('VirtualSocket stream', () => {
  it('emits connect event on connection', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:9000', { handler: () => null });
    interceptor.install();

    const connected = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection(9000);
      sock.on('connect', () => resolve(true));
    });
    expect(connected).toBe(true);
  });

  it('echoes data through the handler', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:9000', {
      handler: (data) => Buffer.from(`echo:${data.toString()}`),
    });
    interceptor.install();

    const sock = await connect(9000);
    const res = await writeAndRead(sock, 'hello');
    // Expected: "echo:hello"
    expect(res.toString()).toBe('echo:hello');
    sock.destroy();
  });

  it('handler can return multiple buffers', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:9000', {
      handler: () => [Buffer.from('part1'), Buffer.from('part2')],
    });
    interceptor.install();

    const sock = await connect(9000);
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.write('go');

    // Wait for microtask delivery
    await new Promise(r => setTimeout(r, 20));
    const combined = Buffer.concat(chunks).toString();
    // Expected: "part1part2"
    expect(combined).toBe('part1part2');
    sock.destroy();
  });

  it('handler returning null emits no data', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:9000', { handler: () => null });
    interceptor.install();

    const sock = await connect(9000);
    let received = false;
    sock.on('data', () => { received = true; });
    sock.write('ignored');

    await new Promise(r => setTimeout(r, 20));
    expect(received).toBe(false);
    sock.destroy();
  });

  it('emits close on destroy', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:9000', { handler: () => null });
    interceptor.install();

    const sock = await connect(9000);
    const closed = new Promise<boolean>((resolve) => {
      sock.on('close', () => resolve(true));
    });
    sock.destroy();
    expect(await closed).toBe(true);
  });

  it('handler errors are emitted on the socket', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:9000', {
      handler: () => { throw new Error('handler-boom'); },
    });
    interceptor.install();

    const sock = await connect(9000);
    const err = await new Promise<Error>((resolve) => {
      sock.on('error', (e) => resolve(e as Error));
      sock.write('trigger');
    });
    expect(err.message).toBe('handler-boom');
    sock.destroy();
  });
});

// 3. Scheduler controls response ordering

describe('scheduler integration', () => {
  it('responses are held until scheduler.runTick()', async () => {
    const clock = new VirtualClock(0);
    const scheduler = new Scheduler({ prngSeed: 1 });

    interceptor = new TcpInterceptor({ clock, scheduler });
    interceptor.mock('localhost:5432', {
      handler: (data) => Buffer.from(`res:${data.toString()}`),
      latency: 100,
    });
    interceptor.install();

    const sock = await connect(5432);
    let responseData = '';
    sock.on('data', (c: Buffer) => { responseData += c.toString(); });
    sock.write('query1');

    // Before scheduler tick: no response yet
    await new Promise(r => setTimeout(r, 10));
    expect(responseData).toBe('');

    // Run the tick at virtual time 100
    await scheduler.runTick(100);
    // Expected: "res:query1"
    expect(responseData).toBe('res:query1');
    sock.destroy();
  });

  it('zero-latency responses auto-drain through scheduler without explicit runTick', async () => {
    const clock = new VirtualClock(0);
    const scheduler = new Scheduler({ prngSeed: 7 });

    interceptor = new TcpInterceptor({ clock, scheduler });
    interceptor.mock('localhost:5432', {
      handler: () => Buffer.from('ready'),
      latency: 0,
    });
    interceptor.install();

    const sock = await connect(5432);
    let responseData = '';
    sock.on('data', (c: Buffer) => { responseData += c.toString(); });
    sock.write('query');

    await new Promise(r => setTimeout(r, 10));
    expect(responseData).toBe('ready');
    sock.destroy();
  });

  it('deterministic ordering of two sockets at same virtual time', async () => {
    async function runScenario(seed: number): Promise<string[]> {
      const clock = new VirtualClock(0);
      const scheduler = new Scheduler({ prngSeed: seed });
      const tcp = new TcpInterceptor({ clock, scheduler });
      tcp.mock('localhost:5432', {
        handler: (data) => Buffer.from(data.toString().toUpperCase()),
        latency: 50,
      });
      tcp.install();

      const sock1 = await connect(5432);
      const sock2 = await connect(5432);
      const order: string[] = [];
      sock1.on('data', (c: Buffer) => { order.push(c.toString()); });
      sock2.on('data', (c: Buffer) => { order.push(c.toString()); });
      sock1.write('alpha');
      sock2.write('beta');

      await scheduler.runTick(50);
      // Small delay for Duplex push → data event propagation
      await new Promise(r => setTimeout(r, 10));

      sock1.destroy();
      sock2.destroy();
      tcp.uninstall();
      return order;
    }

    // Same seed → same order
    const run1 = await runScenario(42);
    const run2 = await runScenario(42);
    expect(run1).toHaveLength(2);
    expect(run1).toEqual(run2);

    // Different seed → may produce different order
    const run3 = await runScenario(99);
    expect(run3).toHaveLength(2);
    expect(run3).toContain('ALPHA');
    expect(run3).toContain('BETA');
  });

  it('generates distinct scheduler op IDs for identical payloads on different sockets', async () => {
    const clock = new VirtualClock(0);
    const scheduler = new Scheduler({ prngSeed: 123 });

    interceptor = new TcpInterceptor({ clock, scheduler });
    interceptor.mock('localhost:5432', {
      handler: (data) => Buffer.from(data),
      latency: 10,
    });
    interceptor.install();

    const ids: string[] = [];
    const originalEnqueue = scheduler.enqueueCompletion.bind(scheduler);
    scheduler.enqueueCompletion = (op) => {
      ids.push(op.id);
      originalEnqueue(op);
    };

    const sock1 = await connect(5432);
    const sock2 = await connect(5432);

    sock1.write('same-payload');
    sock2.write('same-payload');

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toEqual(ids[1]);

    sock1.destroy();
    sock2.destroy();
  });

  it('generates distinct scheduler op IDs for repeated identical payloads on the same socket', async () => {
    const clock = new VirtualClock(0);
    const scheduler = new Scheduler({ prngSeed: 123 });

    interceptor = new TcpInterceptor({ clock, scheduler });
    interceptor.mock('localhost:5432', {
      handler: (data) => Buffer.from(data),
      latency: 10,
    });
    interceptor.install();

    const ids: string[] = [];
    const originalEnqueue = scheduler.enqueueCompletion.bind(scheduler);
    scheduler.enqueueCompletion = (op) => {
      ids.push(op.id);
      originalEnqueue(op);
    };

    const sock = await connect(5432);

    sock.write('same-payload');
    sock.write('same-payload');

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toEqual(ids[1]);

    sock.destroy();
  });
});

// 4. Virtual latency with clock.advance()

describe('virtual latency with clock', () => {
  it('response is delayed until clock advances past latency', async () => {
    const clock = new VirtualClock(0);
    interceptor = new TcpInterceptor({ clock });
    interceptor.mock('localhost:5432', {
      handler: () => Buffer.from('delayed'),
      latency: 200,
    });
    interceptor.install();

    const sock = await connect(5432);
    let received = false;
    sock.on('data', () => { received = true; });
    sock.write('go');

    // At virtual time 0, not delivered
    expect(received).toBe(false);

    clock.advance(199);
    expect(received).toBe(false);

    clock.advance(1); // now at 200
    // clock.setTimeout fires synchronously during advance
    // but the handler delivery is async (queueMicrotask inside deliver)
    await new Promise(r => setTimeout(r, 10));
    expect(received).toBe(true);

    sock.destroy();
  });
});

// 5. Unmocked connections throw

describe('unmocked TCP safety', () => {
  it('throws SimNodeUnmockedTCPConnectionError for unknown hosts', () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.install();

    expect(() => net.createConnection(9999, 'unknown.host'))
      .toThrow(SimNodeUnmockedTCPConnectionError);
  });

  it('MySQL (port 3306) throws SimNodeUnsupportedProtocolError', () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.install();

    expect(() => net.createConnection(3306, 'db.prod.internal'))
      .toThrow(/MySQL is not supported/);
  });
});

// 6. Sockets tracking

describe('socket tracking', () => {
  it('records all created sockets', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:5432', { handler: () => null });
    interceptor.install();

    await connect(5432);
    await connect(5432);

    expect(interceptor.sockets).toHaveLength(2);
  });

  it('reset clears sockets and mocks', async () => {
    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('localhost:5432', { handler: () => null });
    interceptor.install();

    await connect(5432);
    interceptor.reset();

    expect(interceptor.sockets).toHaveLength(0);
    // After a full reset, previously-mocked ports are no longer intercepted;
    // connections pass through to the real network without a synchronous throw.
    const sock = net.createConnection(5432);
    sock.destroy();
  });
});
