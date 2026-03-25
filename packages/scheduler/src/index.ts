import type { IClock, PendingOp } from './types.js';
import { mulberry32, shuffleInPlace } from './prng.js';

export type { IClock, PendingOp } from './types.js';

export interface SchedulerOptions {
  /** Optional virtual clock. When attached, the scheduler can be called from clock.advance(). */
  clock?: IClock;
  /** Seed for the PRNG that determines execution order of same-tick ops. */
  prngSeed?: number;
}

/**
 * Cooperative deterministic scheduler.
 *
 * Holds mock-I/O completions until their virtual time arrives, then
 * releases them in a PRNG-determined order — making all macro-level
 * race conditions reproducible across runs with the same seed.
 *
 * **This scheduler does NOT intercept V8 microtasks or Promise internals.**
 * It controls ordering exclusively at mock I/O boundaries.
 */
export class Scheduler {
  private _clock: IClock | undefined;
  private readonly _rng: () => number;
  private readonly _pending: PendingOp[] = [];
  private _runChain: Promise<void> = Promise.resolve();
  private _autoDrainScheduled = false;
  private _requestedTick: number | null = null;

  /**
   * When set, VirtualSocket._write uses this value instead of clock.now()
   * for computing `when` and the op ID.  The pump sets this at pump-start
   * so late-arriving writes still land at the correct virtual time.
   */
  writeTimeOverride?: number;

  /**
   * When true, requestRunTick() records the requested tick but does NOT
   * schedule the microtask drain.  Ops accumulate in the pending queue
   * until an explicit runTick() call (e.g. from clock.advance()) drains
   * them together — ensuring the PRNG shuffle covers all concurrent I/O.
   *
   * The pump sets this during Phase 1 + Phase 2 so that real-event-loop
   * jitter in Express/Mongoose processing cannot cause ops to be drained
   * individually (which would bypass the deterministic shuffle).
   */
  holdDrain = false;

  constructor(opts: SchedulerOptions = {}) {
    this._clock = opts.clock;
    this._rng = mulberry32(opts.prngSeed ?? 0);
  }

  // public API

  /**
   * Enqueue a mock-I/O completion.
   *
   * The `run` callback is **not** invoked immediately — it is held in the
   * pending queue until `runTick(t)` is called with `t >= op.when`.
   */
  enqueueCompletion(op: PendingOp): void {
    this._pending.push(op);
  }

  /**
   * Request an asynchronous drain for ops ready at `virtualTime`.
   *
   * Multiple calls in the same turn are coalesced into one microtask and the
   * highest requested virtual time is used.
   */
  requestRunTick(virtualTime: number): void {
    this._requestedTick = this._requestedTick == null
      ? virtualTime
      : Math.max(this._requestedTick, virtualTime);

    if (this.holdDrain || this._autoDrainScheduled) return;
    this._autoDrainScheduled = true;

    queueMicrotask(() => {
      this._autoDrainScheduled = false;
      const tick = this._requestedTick;
      this._requestedTick = null;
      if (tick == null) return;
      void this.runTick(tick).catch(() => {
        // Errors still surface to explicit runTick callers; requestRunTick is
        // best-effort and must not throw asynchronously.
      });
      if (this._requestedTick != null) {
        this.requestRunTick(this._requestedTick);
      }
    });
  }

  /**
   * Attach (or replace) the clock reference.
   *
   * Integration contract: when the clock advances to time `t`, it should
   * call `await scheduler.runTick(t)`.
   */
  attachClock(clock: IClock): void {
    this._clock = clock;
  }

  /**
   * Collect all enqueued ops with `when <= virtualTime`, shuffle them
   * deterministically via the seeded PRNG, then execute their `run()`
   * callbacks **sequentially** in that shuffled order, awaiting one
   * microtask checkpoint (`await Promise.resolve()`) between each.
   */
  async runTick(virtualTime: number): Promise<void> {
    const run = async (): Promise<void> => {
      // Loop to handle cascading completions: ops enqueued during callback
      // execution that are also ready at this virtual time are picked up
      // in the next iteration, preserving causal ordering.
      while (true) {
        // 1. Partition: pull out all ops ready at this tick.
        const ready: PendingOp[] = [];
        const remaining: PendingOp[] = [];
        for (const op of this._pending) {
          if (op.when <= virtualTime) {
            ready.push(op);
          } else {
            remaining.push(op);
          }
        }
        this._pending.length = 0;
        this._pending.push(...remaining);

        if (ready.length === 0) break;

        // 2. Stable-sort by `when` ascending so earlier ops run first,
        //    then shuffle within each same-`when` group via PRNG.
        ready.sort((a, b) => a.when - b.when);

        // Group by `when` and shuffle each group.
        let i = 0;
        while (i < ready.length) {
          let j = i;
          while (j < ready.length && ready[j].when === ready[i].when) j++;
          if (j - i > 1) {
            const group = ready.slice(i, j);
            // Sort by id first so the shuffle always starts from the same
            // canonical order regardless of real-event-loop enqueue order.
            // Without this, two ops enqueued as [A,B] vs [B,A] (due to
            // non-deterministic real timing) would produce different shuffle
            // outcomes for the same seed, breaking replay determinism.
            group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            shuffleInPlace(group, this._rng);
            for (let k = 0; k < group.length; k++) {
              ready[i + k] = group[k];
            }
          }
          i = j;
        }

        // 3. Execute sequentially, with a microtask boundary between each.
        for (const op of ready) {
          await op.run();
          await Promise.resolve(); // microtask checkpoint
        }
      }
    };

    const chained = this._runChain.then(run);
    this._runChain = chained.catch(() => {});
    return chained;
  }

  /**
   * Drain **all** pending ops immediately, regardless of their `when`.
   * Useful for test teardown.
   */
  async drain(): Promise<void> {
    await this.runTick(Number.MAX_SAFE_INTEGER);
  }

  /** Number of operations currently held in the pending queue. */
  get pendingCount(): number {
    return this._pending.length;
  }
}
