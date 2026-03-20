import type { HttpInterceptor, IScheduler, RecordedCall } from './HttpInterceptor.js';
import { Buffer } from 'node:buffer';

let _fetchReqCounter = 0;

export function createFetchPatch(interceptor: HttpInterceptor, originalFetch: typeof globalThis.fetch) {
  return async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    // 1. Normalize input to URL string and extract method/headers/body
    let url: string;
    let method = 'GET';
    const headers: Record<string, string> = {};
    let body = '';

    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      input.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      if (input.body) {
         try {
            const ab = await input.arrayBuffer();
            body = Buffer.from(ab).toString('utf-8');
         } catch {
            body = '';
         }
      }
    } else {
      url = typeof input === 'string' ? input : input.toString();
    }

    if (init) {
      if (init.method) method = init.method.toUpperCase();
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [key, value] of init.headers) {
            headers[key.toLowerCase()] = value;
          }
        } else {
          for (const [key, value] of Object.entries(init.headers)) {
            headers[key.toLowerCase()] = value as string;
          }
        }
      }
      if (init.body) {
         if (typeof init.body === 'string') {
            body = init.body;
         } else if (init.body instanceof Buffer) {
            body = init.body.toString('utf-8');
         } else {
             body = String(init.body);
         }
      }
    }

    return new Promise((resolve, reject) => {
       const anyInterceptor = interceptor as any;
       const route = anyInterceptor._routes.find((r: any) => r.matches(url));

       const call: RecordedCall = {
         method,
         url,
         headers,
         body,
         timestamp: anyInterceptor._clock?.now() ?? Date.now(),
       };
       anyInterceptor._allCalls.push(call);

       // Network partition check
       if (anyInterceptor._partitioned) {
         return reject(Object.assign(new TypeError(`fetch failed: Network partition active — ${method} ${url} rejected`), { code: 'ECONNREFUSED' }));
       }

       if (!route) {
         return reject(new TypeError(`fetch failed: No mock matched: ${method} ${url}`));
       }

       let result: { error?: string; status: number; headers: Record<string, string>; body: string };
       try {
         result = route.respond(call);
       } catch (err: unknown) {
         return reject(err instanceof Error ? err : new TypeError(String(err)));
       }

       const deliver = (): void => {
         if (result.error) {
           return reject(new TypeError(result.error));
         }

         const responseHeaders = new Headers(result.headers);
         const response = new Response(result.body, {
            status: result.status,
            statusText: 'MOCKED',
            headers: responseHeaders,
         });

         resolve(response);
       };

       const latency = route.config.latency;
       if (latency && latency > 0 && anyInterceptor._clock) {
         const when = anyInterceptor._clock.now() + latency;
         // Fix #6: use scheduler for deterministic same-tick ordering
         if (anyInterceptor._scheduler) {
           const opId = `fetch-${++_fetchReqCounter}`;
           (anyInterceptor._scheduler as IScheduler).enqueueCompletion({
             id: opId,
             when,
             run: () => { deliver(); return Promise.resolve(); },
           });
         } else {
           anyInterceptor._clock.setTimeout(deliver, latency);
         }
       } else {
         deliver();
       }
    });
  };
}
