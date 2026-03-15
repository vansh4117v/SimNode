# @simnode/http-proxy

Lightweight HTTP interceptor for deterministic simulation testing. Patches `http.request`/`https.request`, records calls, serves static mocks, and integrates with `@simnode/clock` for virtual latency.

## Usage

```ts
import { HttpInterceptor } from '@simnode/http-proxy';
import { VirtualClock } from '@simnode/clock';
import * as http from 'node:http';

const clock = new VirtualClock(0);
const interceptor = new HttpInterceptor({ clock });

interceptor.mock('http://api.stripe.com/v1/charges', {
  status: 200,
  body: { id: 'ch_123', status: 'succeeded' },
  latency: 80,
});

interceptor.install();

// Make request — response is delayed by 80 virtual ms
const req = http.request('http://api.stripe.com/v1/charges', (res) => {
  console.log(res.statusCode); // 200
});
req.end();

clock.advance(80); // fires the response synchronously

// Query recorded calls
interceptor.calls('GET', 'http://api.stripe.com');

interceptor.uninstall();
```

## Features

- **Static & dynamic mocks** — respond with fixed data or a handler function
- **Call recording** — inspect all intercepted requests
- **Failure injection** — handler-level error throwing
- **Virtual latency** — integrates with any `IClock` implementation (duck-typed, no hard dependency)
