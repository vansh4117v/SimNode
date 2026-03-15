# @simnode/clock

Deterministic virtual clock for Node.js. Replaces `Date`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, and `performance.now()` with manually-controllable fakes.

## Usage

```ts
import { VirtualClock, install } from '@simnode/clock';

// Standalone (no global patching)
const clock = new VirtualClock(0);
const order: number[] = [];
clock.setTimeout(() => order.push(1), 100);
clock.setTimeout(() => order.push(2), 200);
clock.advance(200);
// order = [1, 2]

// With global patching
const { clock: c, uninstall } = install(0);
console.log(Date.now()); // 0
c.advance(5000);
console.log(Date.now()); // 5000
uninstall();
```

## Key Features

- **Min-heap timer queue** — O(log n) insertion and removal
- **Deterministic ordering** — same-time timers fire in FIFO order
- **Cascading timers** — timers that schedule sub-timers within the same `advance()` window are picked up and executed in order
- **`freeze()` / `unfreeze()`** — pause time progression
- **`pending()`** — inspect all scheduled timers
