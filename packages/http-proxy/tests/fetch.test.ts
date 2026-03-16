import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install } from '../src/index.js';
import { VirtualClock } from '@simnode/clock';

describe('FETCH / undici patch', () => {
  let clock: VirtualClock;
  let uninstall: () => void;
  let interceptor: any;

  beforeEach(() => {
    clock = new VirtualClock();
    const result = install(clock);
    interceptor = result.interceptor;
    uninstall = result.uninstall;
  });

  afterEach(() => {
    uninstall();
  });

  it('intercepts globalThis.fetch', async () => {
    interceptor.mock('https://api.example.com/data', {
      status: 200,
      body: { message: 'hello from fetch' },
      latency: 50,
    });

    let resolved = false;
    let data: any = null;

    fetch('https://api.example.com/data').then(async (res) => {
      resolved = true;
      data = await res.json();
    });

    expect(resolved).toBe(false);
    
    clock.advance(49);
    // Give promises time to process in the microtask queue (node environment)
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    clock.advance(1);
    await new Promise((r) => setTimeout(r, 0));
    
    expect(resolved).toBe(true);
    expect(data.message).toBe('hello from fetch');
    
    const calls = interceptor.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/data');
    expect(calls[0].method).toBe('GET');
  });
  
  it('supports Request objects', async () => {
    interceptor.mock('https://api.example.com/post', {
      status: 201,
      body: { id: 123 },
    });
    
    const req = new Request('https://api.example.com/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });

    const res = await fetch(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(123);
    
    const calls = interceptor.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe(JSON.stringify({ name: 'test' }));
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  it('fails if no mock matched', async () => {
    await expect(fetch('https://api.example.com/unmocked')).rejects.toThrow(/No mock matched/);
  });
});
