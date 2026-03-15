import { MinHeap } from './MinHeap.js';

/** Internal timer entry stored in the heap. */
export interface TimerEntry {
  id: number;
  callback: (...args: unknown[]) => void;
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
  private _nextId = 1;
  private _frozen = false;
  private _timers: MinHeap<TimerEntry>;
  private readonly _cancelledIds = new Set<number>();

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
    return this._now;
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
  advance(duration: number): void {
    this.advanceTo(this._now + duration);
  }

  /**
   * Jump to an absolute virtual timestamp, draining timers along the way.
   */
  advanceTo(timestamp: number): void {
    if (this._frozen) return;
    if (timestamp < this._now) return; // never go backward
    while (this._timers.size > 0) {
      const next = this._timers.peek()!;
      if (next.scheduledTime > timestamp) break;
      this._timers.pop();
      // Skip timers cancelled during a previous callback in this advance.
      if (this._cancelledIds.has(next.id)) {
        this._cancelledIds.delete(next.id);
        continue;
      }
      this._now = next.scheduledTime;
      next.callback(...next.args);
      // If this was an interval AND not cancelled during the callback,
      // reschedule for the next tick.
      if (next.interval !== undefined && !this._cancelledIds.has(next.id)) {
        this._timers.push({
          ...next,
          scheduledTime: next.scheduledTime + next.interval,
        });
      }
      this._cancelledIds.delete(next.id);
    }
    this._now = timestamp;
  }

  freeze(): void {
    this._frozen = true;
  }

  unfreeze(): void {
    this._frozen = false;
  }

  // timer primitives

  setTimeout(
    callback: (...args: unknown[]) => void,
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
    callback: (...args: unknown[]) => void,
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

  // lifecycle

  reset(startTime: number = 0): void {
    this._now = startTime;
    this._nextId = 1;
    this._frozen = false;
    this._timers = new MinHeap<TimerEntry>((a, b) =>
      a.scheduledTime !== b.scheduledTime
        ? a.scheduledTime - b.scheduledTime
        : a.id - b.id,
    );
  }
}
