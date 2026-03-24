import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import type * as httpTypes from 'node:http';
import { HttpInterceptor } from '../src/index.js';
import { VirtualClock } from '@crashlab/clock';
import { Scheduler } from '@crashlab/scheduler';

const _require = createRequire(import.meta.url);
const http: typeof httpTypes = _require('node:http');

let interceptor: HttpInterceptor;
afterEach(() => { interceptor?.uninstall(); });

// Helpers

function request(url: string, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode as number, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestError(url: string): Promise<Error> {
  return new Promise((resolve) => {
    const req = http.request(url, () => {});
    req.on('error', (err) => resolve(err));
    req.end();
  });
}

// Concurrent requests at same virtual timestamp

describe('concurrent requests', () => {
  it('resolves 10 concurrent requests all at the same virtual time', async () => {
    const clock = new VirtualClock(0);
    interceptor = new HttpInterceptor({ clock });
    interceptor.mock('http://api.test.com/', {
      status: 200,
      body: { ok: true },
      latency: 100,
      match: 'prefix',
    });
    interceptor.install();

    const promises = Array.from({ length: 10 }, (_, i) =>
      request(`http://api.test.com/item/${i}`),
    );

    // None resolved yet
    expect(interceptor.calls()).toHaveLength(10); // all recorded
    clock.advance(100);
    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);
    results.forEach(r => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
    });
  });

  it('different latencies resolve at correct virtual times', async () => {
    const clock = new VirtualClock(0);
    interceptor = new HttpInterceptor({ clock });
    interceptor.mock('http://fast.test.com/', { status: 200, body: 'fast', latency: 50, match: 'prefix' });
    interceptor.mock('http://slow.test.com/', { status: 200, body: 'slow', latency: 200, match: 'prefix' });
    interceptor.install();

    let fastDone = false;
    let slowDone = false;

    const p1 = request('http://fast.test.com/').then(r => { fastDone = true; return r; });
    const p2 = request('http://slow.test.com/').then(r => { slowDone = true; return r; });

    clock.advance(50);
    await p1;
    expect(fastDone).toBe(true);
    // slow is still pending at virtual time 50
    expect(slowDone).toBe(false);

    clock.advance(150);
    await p2;
    expect(slowDone).toBe(true);
  });
});

// Dynamic handler

describe('dynamic handler', () => {
  it('receives request body and URL', async () => {
    interceptor = new HttpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('http://echo.test.com/', {
      match: 'prefix',
      handler: (call) => ({
        status: 200,
        body: { echoed: call.body, method: call.method, url: call.url },
      }),
    });
    interceptor.install();

    const res = await request('http://echo.test.com/path', 'POST', '{"msg":"hello"}');
    const parsed = JSON.parse(res.body);
    expect(parsed.echoed).toBe('{"msg":"hello"}');
    expect(parsed.method).toBe('POST');
    expect(parsed.url).toContain('/path');
  });
});

// Call filtering

describe('call filtering', () => {
  it('filters by method', async () => {
    interceptor = new HttpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('http://api.test.com/', { status: 200, body: 'ok', match: 'prefix' });
    interceptor.install();

    await request('http://api.test.com/a', 'GET');
    await request('http://api.test.com/b', 'POST');
    await request('http://api.test.com/c', 'GET');

    expect(interceptor.calls('GET')).toHaveLength(2);
    expect(interceptor.calls('POST')).toHaveLength(1);
    expect(interceptor.calls('DELETE')).toHaveLength(0);
  });

  it('filters by URL prefix', async () => {
    interceptor = new HttpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('http://a.test.com/', { status: 200, body: 'a', match: 'prefix' });
    interceptor.mock('http://b.test.com/', { status: 200, body: 'b', match: 'prefix' });
    interceptor.install();

    await request('http://a.test.com/1');
    await request('http://a.test.com/2');
    await request('http://b.test.com/1');

    expect(interceptor.calls(undefined, 'http://a.test.com')).toHaveLength(2);
    expect(interceptor.calls(undefined, 'http://b.test.com')).toHaveLength(1);
  });
});

// No real network

describe('no real network', () => {
  it('unmatched URL emits error, never touches real network', async () => {
    interceptor = new HttpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.install();
    // If real network were touched, this would attempt DNS resolution
    // and hang or take >1s. The error should be instant.
    const err = await requestError('http://should-not-resolve.invalid/test');
    expect(err.message).toContain('No mock matched');
  });
});

// Replay determinism: enqueue order must NOT affect execution order
//
// Sequential counter IDs (http-1, http-2, …) caused Fisher-Yates to produce
// different orders depending on which request arrived first in real time.
// Content-derived IDs (hash of method+url+body) fix this.

describe('replay determinism', () => {
  it('same seed produces same execution order regardless of request arrival order', async () => {
    async function runWithOrder(seed: number, urlOrder: string[]): Promise<string[]> {
      const clock = new VirtualClock(0);
      const sched = new Scheduler({ prngSeed: seed });
      clock.onTick = (t) => sched.runTick(t);
      const localInterceptor = new HttpInterceptor({ clock, scheduler: sched });
      const completionOrder: string[] = [];

      localInterceptor.mock('http://svc.test.com/', {
        match: 'prefix',
        latency: 100,
        handler: (call) => ({ status: 200, body: call.url.split('/').pop()! }),
      });
      localInterceptor.install();

      const promises = urlOrder.map(url =>
        request(url).then(res => { completionOrder.push(res.body); return res; }),
      );
      await clock.advance(100);
      await Promise.all(promises);
      localInterceptor.uninstall();
      return completionOrder;
    }

    const urls = [
      'http://svc.test.com/alpha',
      'http://svc.test.com/beta',
      'http://svc.test.com/gamma',
    ];
    const reversed = [...urls].reverse();

    for (let seed = 0; seed < 10; seed++) {
      const fwd = await runWithOrder(seed, urls);
      const rev = await runWithOrder(seed, reversed);
      expect(rev).toEqual(fwd);
    }
  });
});

// Reset

describe('reset', () => {
  it('clears all mocks and recorded calls', async () => {
    interceptor = new HttpInterceptor({ scheduler: new Scheduler({ prngSeed: 1 }) });
    interceptor.mock('http://api.test.com/', { status: 200, body: 'ok', match: 'prefix' });
    interceptor.install();

    await request('http://api.test.com/');
    expect(interceptor.calls()).toHaveLength(1);

    interceptor.reset();
    expect(interceptor.calls()).toHaveLength(0);

    // After reset, no mock matches
    const err = await requestError('http://api.test.com/');
    expect(err.message).toContain('No mock matched');
  });
});
