import { describe, it, expect } from 'vitest';
import { VirtualClock } from '@simnode/clock';
import { SeededRandom, patchMathRandom } from '@simnode/random';
import { TcpInterceptor } from '@simnode/tcp';
import { HttpInterceptor } from '@simnode/http-proxy';
import { VirtualFS } from '@simnode/filesystem';
import * as dns from 'node:dns';
import * as crypto from 'node:crypto';
import type * as fsTypes from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const fs = _require('node:fs') as typeof import('node:fs');

describe('Regression & Integration Bugs', () => {
  it('combines fetch, DNS, fs promises, deterministic crypto, and microtasks', async () => {
    // 1. Setup Environment
    const clock = new VirtualClock(0);
    const vfs = new VirtualFS();
    vfs.seed({
      '/app/config.json': '{"port": 8080}',
      'E:/windows/path.txt': 'canonicalized'
    });
    
    const httpInterceptor = new HttpInterceptor({ clock });
    const tcpInterceptor = new TcpInterceptor({ clock });
    const rng = new SeededRandom(12345);
    
    const uninstalls: Array<() => void> = [];
    
    // Install all interceptors/abstractions
    vfs.install();
    uninstalls.push(() => vfs.uninstall());
    
    const httpInstalled = (await import('@simnode/http-proxy')).install(httpInterceptor);
    uninstalls.push(httpInstalled.uninstall);
    
    tcpInterceptor.install();
    uninstalls.push(() => tcpInterceptor.uninstall());
    
    rng.install();
    uninstalls.push(() => rng.uninstall());
    
    const clockInstalled = (await import('@simnode/clock')).install(clock);
    uninstalls.push(clockInstalled.uninstall);
    
    try {
        // --- 2. Microtasks & Determinism Check --- //
        let microtaskFired = false;
        process.nextTick(() => {
            Promise.resolve().then(() => {
                microtaskFired = true;
            });
        });

        // --- 3. DNS short-circuit check --- //
        tcpInterceptor.dnsConfig.throwOnUnmocked = true;
        await expect(dns.promises.lookup('unmocked.internal'))
          .rejects.toThrow('ENOTFOUND');
        
        tcpInterceptor.mock('postgres://db.internal:5432', { handler: async () => ({} as any) });
        const dnsRes = await dns.promises.lookup('db.internal');
        expect(dnsRes.address).toBe('127.0.0.1');

        // --- 4. HTTP Fetch intercept check --- //
        httpInterceptor.mock('https://api.example.com/data', {
            status: 200,
            body: '{"ok":true}',
            latency: 50
        });
        
        // --- 5. FS + FS Promises + Windows Paths check --- //
        const configStr = await fs.promises.readFile('/app/config.json', 'utf8');
        expect(configStr).toBe('{"port": 8080}');
        
        const winPathStr = fs.readFileSync('\\windows\\path.txt', 'utf8');
        expect(winPathStr).toBe('canonicalized');
        
        // --- 6. Crypto deterministic test --- //
        const bytes1 = crypto.randomBytes(4);
        const bytes2 = crypto.randomBytes(4);
        expect(bytes1).not.toEqual(bytes2);
        
        // Fire clock for fetch
        setTimeout(() => {}, 50); // to make advanceTo do something if fetch is idle
        
        let fetchedData;
        const fetchPromise = fetch('https://api.example.com/data').then(r => r.text()).then(d => {
          fetchedData = d;
        });

        await clock.advance(100);
        await fetchPromise;
        
        // Verify cascade of microtasks during advance
        expect(microtaskFired).toBe(true);
        expect(fetchedData).toBe('{"ok":true}');
        
    } finally {
        for (const u of uninstalls.reverse()) u();
        vfs.reset();
        httpInterceptor.reset();
        tcpInterceptor.reset();
    }
  });
});
