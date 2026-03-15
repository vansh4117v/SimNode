# @simnode/tcp

TCP interception layer for SimNode. Patches `net.createConnection`, `net.connect`, and `net.Socket.prototype.connect` to route all outbound TCP connections through registered mock handlers. No real network I/O ever occurs.

## Usage

```ts
import { TcpInterceptor } from '@simnode/tcp';
import { VirtualClock } from '@simnode/clock';
import { Scheduler } from '@simnode/scheduler';

const clock = new VirtualClock(0);
const scheduler = new Scheduler({ prngSeed: 42 });
const tcp = new TcpInterceptor({ clock, scheduler });

// Register mock — accepts "host:port" or URL strings
tcp.mock('postgres://localhost:5432', {
  handler: (data, ctx) => {
    // data: raw bytes from client
    // return Buffer or Buffer[] as response
    return Buffer.from('response-bytes');
  },
  latency: 80, // virtual ms
});

tcp.install();

// All net.createConnection(5432, 'localhost') calls now
// go through the mock handler. Responses are delivered
// via the scheduler for deterministic ordering.

tcp.uninstall();
```

## Safety

Unmocked connections throw `SimNodeUnmockedTCPConnectionError` — preventing any real network access during simulation.
