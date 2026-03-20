import { MinHeap } from './MinHeap.js';

/** Internal timer entry stored in the heap. */
export interface TimerEntry {
  id: number;
  callback: (...args: unknown[]) => void | Promise<void>;
  scheduledTime: number;
  interval?: number;
  args: unknown[];
}

/**
 * A manually-controllable virtual clock.
 *
 * Replaces all time primitives so that `advance(duration)` fires timers
 * deterministically, in scheduled-time order.  Timers that schedule new
 * timers within the same advance window ARE picked up and executed in
 * the correct order (the heap is re-checked after every callback).
 */
export class VirtualClock {
  private _now: number;
  private _skew: number = 0;
  private _nextId = 1;
  private _frozen = false;
  private _timers: MinHeap<TimerEntry>;
  private readonly _cancelledIds = new Set<number>();

  private readonly _virtualNextTickQueue: Array<(...args: unknown[]) => void> = [];
  private readonly _virtualImmediateQueue: Array<{ id: number; callback: (...args: unknown[]) => void | Promise<void>; args: unknown[]; }> = [];
  private _nextImmediateId = 1;
  private readonly _cancelledImmediates = new Set<number>();

  /**
   * Optional hook called after each timer fires (and after microtask flush).
   * The clock attaches the scheduler here so that advancing time drives I/O.
   */
  onTick?: (time: number) => Promise<void>;

  constructor(startTime: number = 0) {
    this._now = startTime;
    this._timers = new MinHeap<TimerEntry>((a, b) =>
      a.scheduledTime !== b.scheduledTime
        ? a.scheduledTime - b.scheduledTime
        : a.id - b.id, // FIFO tie-break
    );
  }

  // queries

  now(): number {
    return this._now + this._skew;
  }

  pending(): Array<{ id: number; scheduledTime: number }> {
    return this._timers
      .toArray()
      .map((t) => ({ id: t.id, scheduledTime: t.scheduledTime }))
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  }

  // time control

  /**
   * Advance the clock by `duration` ms, firing every timer whose
   * scheduled time falls within `[now, now + duration]` in order.
   */
  async advance(duration: number): Promise<void> {
    await this.advanceTo(this._now + duration);
  }

  /**
   * Jump to an absolute virtual timestamp, draining timers along the way.
   */
  async advanceTo(timestamp: number): Promise<void> {
    if (this._frozen) return;
    if (timestamp < this._now) return; // never go backward

    while (this._timers.size > 0) {
      const next = this._timers.peek()!;
      if (next.scheduledTime > timestamp) break;

      // If cancelled while it was in queue
      if (this._cancelledIds.has(next.id)) {
        this._timers.pop();
        this._cancelledIds.delete(next.id);
        continue;
      }

      // Pop right before execution
      this._timers.pop();
      if (this._cancelledIds.has(next.id)) {
         this._cancelledIds.delete(next.id);
         continue;
      }

      this._now = next.scheduledTime;

      try {
        // Call synchronously first so that process.nextTick callbacks
        // registered inside the timer run before native Promise microtasks.
        // If the callback is async, await its returned Promise afterward.
        const maybePromise = next.callback(...next.args);
        await this._flushMicrotasks();
        if (maybePromise instanceof Promise) await maybePromise;
      } catch (err) {
        throw new Error(`VirtualClock timer callback failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }

      await this._flushMicrotasks();

      // Call onTick hook so the scheduler can run I/O completions for this tick
      if (this.onTick) {
        await this.onTick(this._now + this._skew);
        await this._flushMicrotasks();
      }

      // If this was an interval AND not cancelled during the callback or microtasks,
      // reschedule for the next tick.
      if (next.interval !== undefined && !this._cancelledIds.has(next.id)) {
        this._timers.push({
          ...next,
          scheduledTime: next.scheduledTime + next.interval,
        });
      }
      this._cancelledIds.delete(next.id);

      await this._flushImmediates();
    }
    this._now = timestamp;

    // End of advance flush
    await this._flushMicrotasks();
    if (this.onTick) {
      await this.onTick(this._now + this._skew);
      await this._flushMicrotasks();
    }
    await this._flushImmediates();
  }

  private async _flushMicrotasks(): Promise<void> {
    let draining = true;
    while (draining) {
      // Phase 1: drain the virtual nextTick queue synchronously (nextTick runs before native microtasks)
      while (this._virtualNextTickQueue.length > 0) {
        const cb = this._virtualNextTickQueue.shift()!;
        try {
          cb();
        } catch (err) {
          throw new Error(`VirtualClock nextTick failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
      // Phase 2: one V8 microtask checkpoint (lets native Promise chains resolve)
      await Promise.resolve();
      // Phase 3: if new nextTick callbacks were enqueued by those microtasks, loop again;
      // otherwise we're stable.
      if (this._virtualNextTickQueue.length === 0) {
        draining = false;
      }
    }
  }

  private async _flushImmediates(): Promise<void> {
    const immediates = [...this._virtualImmediateQueue];
    this._virtualImmediateQueue.length = 0;

    for (const imm of immediates) {
      if (this._cancelledImmediates.has(imm.id)) {
        this._cancelledImmediates.delete(imm.id);
        continue;
      }
      try {
        await Promise.resolve(imm.callback(...imm.args));
      } catch (err) {
        throw new Error(`VirtualClock immediate failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      await this._flushMicrotasks();
      this._cancelledImmediates.delete(imm.id);
    }
  }

  freeze(): void {
    this._frozen = true;
  }

  unfreeze(): void {
    this._frozen = false;
  }

  /**
   * Apply a clock skew offset (ms). Does NOT fire timers.
   * `now()` returns `_now + _skew`.
   */
  skew(amount: number): void {
    this._skew += amount;
  }

  // timer primitives

  setTimeout(
    callback: (...args: unknown[]) => void | Promise<void>,
    delay: number = 0,
    ...args: unknown[]
  ): number {
    const id = this._nextId++;
    this._timers.push({
      id,
      callback,
      scheduledTime: this._now + Math.max(0, delay),
      args,
    });
    return id;
  }

  setInterval(
    callback: (...args: unknown[]) => void | Promise<void>,
    delay: number,
    ...args: unknown[]
  ): number {
    const id = this._nextId++;
    this._timers.push({
      id,
      callback,
      scheduledTime: this._now + Math.max(0, delay),
      interval: Math.max(1, delay),
      args,
    });
    return id;
  }

  clearTimeout(id: number): void {
    this._cancelledIds.add(id);
    this._timers.remove((t) => t.id === id);
  }

  clearInterval(id: number): void {
    this._cancelledIds.add(id);
    this._timers.remove((t) => t.id === id);
  }

  setImmediate(callback: (...args: unknown[]) => void | Promise<void>, ...args: unknown[]): number {
    const id = this._nextImmediateId++;
    this._virtualImmediateQueue.push({ id, callback, args });
    return id;
  }

  clearImmediate(id: number): void {
    this._cancelledImmediates.add(id);
  }

  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
    this._virtualNextTickQueue.push(() => callback(...args));
  }

  // lifecycle

  reset(startTime: number = 0): void {
    this._now = startTime;
    this._skew = 0;
    this._nextId = 1;
    this._frozen = false;
    this._timers = new MinHeap<TimerEntry>((a, b) =>
      a.scheduledTime !== b.scheduledTime
        ? a.scheduledTime - b.scheduledTime
        : a.id - b.id,
    );
    this._cancelledIds.clear();
    this._virtualNextTickQueue.length = 0;
    this._virtualImmediateQueue.length = 0;
    this._cancelledImmediates.clear();
    this._nextImmediateId = 1;
    this.onTick = undefined;
  }
}
