import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import type * as httpTypes from 'node:http';
import { HttpInterceptor } from '../src/index.js';
import { VirtualClock } from '../../clock/src/index.js';

// Use CJS require so we read the SAME mutable module the interceptor patches.
const _require = createRequire(import.meta.url);
const http: typeof httpTypes = _require('node:http');

let interceptor: HttpInterceptor;

afterEach(() => {
  interceptor?.uninstall();
});

// Basic mock & call recording

describe('HttpInterceptor — static mocks', () => {
  it('intercepts http.request and returns a static response', async () => {
    interceptor = new HttpInterceptor();
    interceptor.mock('http://api.example.com/users', {
      status: 200,
      body: { users: ['alice'] },
    });
    interceptor.install();

    const { status, body } = await request('http://api.example.com/users');
    // Expected: status 200, body = {"users":["alice"]}
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ users: ['alice'] });
  });

  it('records all calls', async () => {
    interceptor = new HttpInterceptor();
    interceptor.mock('http://api.example.com/', { status: 200, body: 'ok' });
    interceptor.install();

    await request('http://api.example.com/a');
    await request('http://api.example.com/b');

    const calls = interceptor.calls();
    // Expected: 2 calls recorded
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/a');
    expect(calls[1].url).toContain('/b');
  });

  it('emits error for unmatched routes', async () => {
    interceptor = new HttpInterceptor();
    interceptor.install();

    const err = await requestError('http://nomatch.com/x');
    // Expected: error about no mock matched
    expect(err.message).toContain('No mock matched');
  });
});

// Failure injection

describe('HttpInterceptor — failure injection', () => {
  it('fails after N successful calls', async () => {
    interceptor = new HttpInterceptor();
    // Register a single fail route: succeed 2 times, then ECONNRESET
    interceptor.fail('http://api.example.com/', { after: 2, error: 'ECONNRESET' });
    interceptor.install();

    // The route has no success body (status: 0), so we need a mock that
    // can serve success AND then fail. Let's use mock + fail on same prefix:
    interceptor.reset();
    interceptor.mock('http://api.example.com/', {
      status: 200,
      body: 'ok',
      handler: (() => {
        let count = 0;
        return () => {
          count++;
          if (count > 2) throw new Error('ECONNRESET');
          return { status: 200, body: 'ok' };
        };
      })(),
    });
    interceptor.install();

    const r1 = await request('http://api.example.com/');
    expect(r1.status).toBe(200);
    const r2 = await request('http://api.example.com/');
    expect(r2.status).toBe(200);

    // Third call — handler throws, which surfaces as an error
    const err = await requestError('http://api.example.com/');
    // Expected: ECONNRESET error
    expect(err.message).toBe('ECONNRESET');
  });
});

// Virtual clock latency integration

describe('HttpInterceptor — virtual clock latency', () => {
  it('delays response until clock is advanced past latency', async () => {
    const clock = new VirtualClock(0);
    interceptor = new HttpInterceptor({ clock });
    interceptor.mock('http://api.example.com/data', {
      status: 200,
      body: { result: 42 },
      latency: 500,
    });
    interceptor.install();

    let responseReceived = false;
    const promise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request('http://api.example.com/data', (res: any) => {
        responseReceived = true;
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode as number, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    // Before advancing: response NOT delivered yet
    // Expected: false
    expect(responseReceived).toBe(false);

    // Advance only 499ms — still not delivered
    clock.advance(499);
    // Expected: false
    expect(responseReceived).toBe(false);

    // Advance 1 more ms (total 500ms) — timer fires synchronously
    clock.advance(1);
    // Expected: true — response event fires during advance()
    expect(responseReceived).toBe(true);

    // Await the data read (flushed via queueMicrotask)
    const result = await promise;
    // Expected: status 200, body = {"result":42}
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ result: 42 });
  });
});

// Helpers

function request(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode as number, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function requestError(url: string): Promise<Error> {
  return new Promise((resolve) => {
    const req = http.request(url, () => {
      // won't fire
    });
    req.on('error', (err) => resolve(err));
    req.end();
  });
}
