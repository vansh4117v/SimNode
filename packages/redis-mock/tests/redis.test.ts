import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RedisMock } from '../src/index.js';

// Encode a RESP command buffer from string arguments
function encode(...args: string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) parts.push(`$${Buffer.byteLength(a)}\r\n${a}\r\n`);
  return Buffer.from(parts.join(''));
}

let redisHost: string;
let redisPort: number;
let stopServer: () => Promise<void>;

beforeAll(async () => {
  const { RedisMemoryServer } = await import('redis-memory-server');
  const server = new RedisMemoryServer();
  redisHost = await server.getHost();
  redisPort = await server.getPort();
  stopServer = () => server.stop().then(() => {});
}, 30_000);

afterAll(async () => {
  await stopServer();
});

describe('Redis commands (real redis-server)', () => {
  let mock: RedisMock;

  afterEach(async () => {
    if (mock) await mock.flush();
  });

  async function cmd(...args: string[]): Promise<string> {
    const handler = mock.createHandler();
    const ctx = { remoteHost: 'localhost', remotePort: redisPort, socketId: 1 };
    const result = await handler(encode(...args), ctx);
    return Buffer.isBuffer(result) ? result.toString() : '';
  }

  it('PING → PONG', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    expect(await cmd('PING')).toBe('+PONG\r\n');
  });

  it('GET/SET', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('SET', 'key1', 'hello');
    expect(await cmd('GET', 'key1')).toContain('hello');
  });

  it('DEL', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('SET', 'k', 'v');
    expect(await cmd('DEL', 'k')).toBe(':1\r\n');
    expect(await cmd('GET', 'k')).toBe('$-1\r\n');
  });

  it('INCR/DECR', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('SET', 'counter', '10');
    expect(await cmd('INCR', 'counter')).toBe(':11\r\n');
    expect(await cmd('DECR', 'counter')).toBe(':10\r\n');
    expect(await cmd('INCR', 'new')).toBe(':1\r\n');
  });

  it('LPUSH/RPUSH/LPOP/RPOP', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('RPUSH', 'list', 'a');
    await cmd('RPUSH', 'list', 'b');
    await cmd('LPUSH', 'list', 'z');
    expect(await cmd('LPOP', 'list')).toContain('z');
    expect(await cmd('RPOP', 'list')).toContain('b');
  });

  it('HSET/HGET', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('HSET', 'user:1', 'name', 'Alice');
    expect(await cmd('HGET', 'user:1', 'name')).toContain('Alice');
  });

  it('SADD/SMEMBERS', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('SADD', 'myset', 'a');
    await cmd('SADD', 'myset', 'b');
    await cmd('SADD', 'myset', 'a'); // duplicate
    const r = await cmd('SMEMBERS', 'myset');
    expect(r).toContain('a');
    expect(r).toContain('b');
  });

  it('ZADD/ZRANGE', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('ZADD', 'zs', '1', 'alice', '2', 'bob', '0.5', 'charlie');
    const r = await cmd('ZRANGE', 'zs', '0', '-1');
    expect(r).toContain('charlie');
    expect(r).toContain('alice');
    expect(r).toContain('bob');
  });

  it('EXPIRE/TTL with real redis', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    await cmd('SET', 'k', 'v');
    await cmd('EXPIRE', 'k', '10');
    const ttl = await cmd('TTL', 'k');
    // TTL should be close to 10 (real time)
    const ttlVal = parseInt(ttl.replace(':', '').trim());
    expect(ttlVal).toBeGreaterThanOrEqual(9);
    expect(ttlVal).toBeLessThanOrEqual(10);
  });

  it('seedData', async () => {
    mock = new RedisMock({ redisHost, redisPort });
    mock.seedData('greeting', 'hello');
    expect(await cmd('GET', 'greeting')).toContain('hello');
  });
});
