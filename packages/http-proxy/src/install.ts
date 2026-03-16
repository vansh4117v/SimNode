import { HttpInterceptor } from './HttpInterceptor.js';
import { createFetchPatch } from './fetch-patch.js';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);


export interface HttpProxyInstallResult {
  interceptor: HttpInterceptor;
  uninstall: () => void;
}

export function install(interceptorOrClock?: HttpInterceptor | any): HttpProxyInstallResult {
  let interceptor: HttpInterceptor;
  
  if (interceptorOrClock instanceof HttpInterceptor) {
    interceptor = interceptorOrClock;
  } else {
    interceptor = new HttpInterceptor({ clock: interceptorOrClock });
  }

  // 1. Install http/https patches
  interceptor.install();

  // 2. Install fetch patch
  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = createFetchPatch(interceptor, origFetch);
  }

  // 3. Try to patch undici if available in the module graph
  //    Undici is what powers Node's native fetch. A lot of libraries (like Prisma, Axios in some cases)
  //    might use undici directly.
  let undiciUninstall: (() => void) | undefined;
  try {
    const customRequire = createRequire(process.cwd() + '/'); // Attempt to require from workspace root
    
    let undici: any;
    try {
      undici = customRequire('undici');
    } catch {
       undici = _require('undici');
    }

    if (undici) {
       const origUndiciFetch = undici.fetch;
       const origUndiciRequest = undici.request;

       undici.fetch = createFetchPatch(interceptor, origUndiciFetch);
       // undici.request is a bit different API, but if any libraries use it, we can wrap it.
       // For this fix, wrapping undici.fetch handles most cases. 
       // We can also wrap undici.request if necessary, but returning a dispatcher response is complex.
       // Let's at least wrap fetch.
       
       undiciUninstall = () => {
          undici.fetch = origUndiciFetch;
          undici.request = origUndiciRequest;
       };
    }
  } catch (err) {
    // ignore if undici is not found
  }

  function uninstall(): void {
    interceptor.uninstall();
    globalThis.fetch = origFetch;
    if (undiciUninstall) {
       undiciUninstall();
    }
  }

  return { interceptor, uninstall };
}
