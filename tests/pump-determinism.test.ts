/**
 * pump-determinism.test.ts
 *
 * Verifies the writeTimeOverride mechanism:
 * - VirtualSocket._write during a pump always uses the frozen pump-start
 *   time, even if the clock has advanced internally.
 * - This eliminates the root cause of non-determinism where real-time
 *   jitter in Express processing caused ops to land at different virtual
 *   times between runs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import type * as netTypes from "node:net";
import { VirtualClock } from "@crashlab/clock";
import { Scheduler } from "@crashlab/scheduler";
import { TcpInterceptor } from "@crashlab/tcp";
import type { TcpMockHandler, TcpHandlerResult } from "@crashlab/tcp";

// Use CJS require so that tcp.install() patches are visible
const _require = createRequire(import.meta.url);
const net: typeof netTypes = _require("node:net");

let interceptor: TcpInterceptor;
afterEach(() => {
  interceptor?.uninstall();
});

/** Helper: connect and wait */
function connect(port: number, host = "localhost"): Promise<netTypes.Socket> {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host);
    sock.on("connect", () => resolve(sock));
  });
}

describe("writeTimeOverride determinism", () => {
  it("VirtualSocket writes during clock advance use frozen time when override is set", async () => {
    const clock = new VirtualClock(0);
    const scheduler = new Scheduler({ prngSeed: 42 });
    clock.onTick = async (t: number) => {
      await scheduler.runTick(t);
    };

    interceptor = new TcpInterceptor({ clock, scheduler });

    // Collect enqueued ops
    const ops: Array<{ id: string; when: number }> = [];
    const origEnqueue = scheduler.enqueueCompletion.bind(scheduler);
    scheduler.enqueueCompletion = (op) => {
      ops.push({ id: op.id, when: op.when });
      origEnqueue(op);
    };

    const handler: TcpMockHandler = async (): Promise<TcpHandlerResult> => {
      return Buffer.from("OK");
    };
    interceptor.mock("localhost:27017", { handler, latency: 50 });
    interceptor.install();

    // === WITHOUT writeTimeOverride: write at clock=0, then at clock=100 ===
    const sock1 = await connect(27017);
    sock1.write(Buffer.from("query-A"));
    // Op should be at when = 0 + 50 = 50

    await clock.advance(100); // clock is now 100

    sock1.write(Buffer.from("query-B"));
    // WITHOUT override: when = 100 + 50 = 150

    expect(ops).toHaveLength(2);
    expect(ops[0].when).toBe(50); // query-A at clock=0
    expect(ops[1].when).toBe(150); // query-B at clock=100 — BAD for determinism

    // Reset for second half
    ops.length = 0;
    clock.reset(0);

    // === WITH writeTimeOverride: both writes at frozen time 0 ===
    scheduler.writeTimeOverride = 0; // freeze at pump-start time

    const sock2 = await connect(27017);
    sock2.write(Buffer.from("query-C"));

    await clock.advance(100); // clock internally at 100

    sock2.write(Buffer.from("query-D"));
    // WITH override: when = 0 + 50 = 50 (frozen!)

    scheduler.writeTimeOverride = undefined;

    expect(ops).toHaveLength(2);
    expect(ops[0].when).toBe(50); // query-C at frozen 0
    expect(ops[1].when).toBe(50); // query-D at frozen 0 — DETERMINISTIC!
  });

  it("writeTimeOverride produces identical op IDs across 20 runs", async () => {
    async function runTrial(seed: number): Promise<string[]> {
      const clock = new VirtualClock(0);
      const scheduler = new Scheduler({ prngSeed: seed });
      clock.onTick = async (t: number) => {
        await scheduler.runTick(t);
      };

      const tcp = new TcpInterceptor({ clock, scheduler });
      const ids: string[] = [];
      const origEnqueue = scheduler.enqueueCompletion.bind(scheduler);
      scheduler.enqueueCompletion = (op) => {
        ids.push(op.id);
        origEnqueue(op);
      };

      const handler: TcpMockHandler = async (): Promise<TcpHandlerResult> => Buffer.from("OK");
      tcp.mock("localhost:27017", { handler, latency: 50 });
      tcp.install();

      try {
        const sock = await connect(27017);

        // Simulate pump with writeTimeOverride
        scheduler.writeTimeOverride = clock.now();

        // Write A immediately
        sock.write(Buffer.from("findOne-A"));

        // Advance clock (simulates time passing)
        await clock.advance(75);

        // Write B arrives late (during clock advance in real scenario)
        sock.write(Buffer.from("findOne-B"));

        scheduler.writeTimeOverride = undefined;
        return ids;
      } finally {
        tcp.uninstall();
      }
    }

    // Extract deterministic parts of an op ID (writeSeq + now),
    // ignoring socket ID which increments across trials in tests
    // (in production each Worker has fresh module state).
    const deterministicParts = (ids: string[]) =>
      ids.map((id) => {
        const [, , , writeSeq, now] = id.split("-");
        return `${writeSeq}-${now}`;
      });

    interceptor = new TcpInterceptor({ scheduler: new Scheduler({ prngSeed: 0 }) });
    const baseline = deterministicParts(await runTrial(42));
    expect(baseline).toHaveLength(2);
    // Both ops should have now=0
    expect(baseline[0]).toMatch(/^\d+-0$/);
    expect(baseline[1]).toMatch(/^\d+-0$/);

    // Run 19 more times — deterministic parts must match
    for (let i = 0; i < 19; i++) {
      const trial = deterministicParts(await runTrial(42));
      expect(trial).toEqual(baseline);
    }
  });
});
