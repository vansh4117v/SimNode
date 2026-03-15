import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualClock, install, MinHeap } from '../src/index.js';

// MinHeap

describe('MinHeap', () => {
  it('pops elements in ascending order', () => {
    const h = new MinHeap<number>((a, b) => a - b);
    [5, 3, 8, 1, 4].forEach((n) => h.push(n));
    const out: number[] = [];
    while (h.size > 0) out.push(h.pop()!);
    // Expected: [1, 3, 4, 5, 8]
    expect(out).toEqual([1, 3, 4, 5, 8]);
  });

  it('removes by predicate', () => {
    const h = new MinHeap<number>((a, b) => a - b);
    [10, 20, 30].forEach((n) => h.push(n));
    h.remove((v) => v === 20);
    const out: number[] = [];
    while (h.size > 0) out.push(h.pop()!);
    // Expected: [10, 30]
    expect(out).toEqual([10, 30]);
  });
});

// VirtualClock

describe('VirtualClock', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = new VirtualClock(0);
  });

  it('starts at the given time', () => {
    // Expected: 0
    expect(clock.now()).toBe(0);
  });

  it('advance() moves time forward', () => {
    clock.advance(100);
    // Expected: 100
    expect(clock.now()).toBe(100);
  });

  it('fires timers in scheduled order', () => {
    const order: number[] = [];
    clock.setTimeout(() => order.push(3), 300);
    clock.setTimeout(() => order.push(1), 100);
    clock.setTimeout(() => order.push(2), 200);
    clock.advance(300);
    // Expected: [1, 2, 3]
    expect(order).toEqual([1, 2, 3]);
  });

  it('FIFO for same-time timers', () => {
    const order: string[] = [];
    clock.setTimeout(() => order.push('a'), 50);
    clock.setTimeout(() => order.push('b'), 50);
    clock.setTimeout(() => order.push('c'), 50);
    clock.advance(50);
    // Expected: ["a", "b", "c"]  — insertion order preserved
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('handles timers that schedule timers within the same window', () => {
    const order: number[] = [];
    clock.setTimeout(() => {
      order.push(1);
      // This sub-timer is at virtual time 100 + 50 = 150, within the 200 window
      clock.setTimeout(() => order.push(2), 50);
    }, 100);
    clock.setTimeout(() => order.push(3), 200);
    clock.advance(200);
    // Expected: [1, 2, 3]  — sub-timer (150ms) fires before the 200ms timer
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not fire timers beyond the advance window', () => {
    const order: number[] = [];
    clock.setTimeout(() => order.push(1), 100);
    clock.setTimeout(() => order.push(2), 300);
    clock.advance(200);
    // Expected: [1]  — only the 100ms timer fires
    expect(order).toEqual([1]);
    // Expected: 200
    expect(clock.now()).toBe(200);
  });

  it('clearTimeout cancels a pending timer', () => {
    const order: string[] = [];
    const id = clock.setTimeout(() => order.push('cancelled'), 100);
    clock.setTimeout(() => order.push('kept'), 200);
    clock.clearTimeout(id);
    clock.advance(200);
    // Expected: ["kept"]
    expect(order).toEqual(['kept']);
  });

  it('setInterval fires repeatedly', () => {
    const ticks: number[] = [];
    clock.setInterval(() => ticks.push(clock.now()), 100);
    clock.advance(350);
    // Expected: [100, 200, 300] — fires at 100, 200, 300; not at 350
    expect(ticks).toEqual([100, 200, 300]);
  });

  it('clearInterval stops a repeating timer', () => {
    const ticks: number[] = [];
    const id = clock.setInterval(() => ticks.push(clock.now()), 100);
    clock.advance(250);
    clock.clearInterval(id);
    clock.advance(200);
    // Expected: [100, 200] — fires at 100, 200; cleared before 300
    expect(ticks).toEqual([100, 200]);
  });

  it('freeze() prevents advancement', () => {
    clock.freeze();
    clock.advance(1000);
    // Expected: 0  — frozen clock doesn't move
    expect(clock.now()).toBe(0);
    clock.unfreeze();
    clock.advance(100);
    // Expected: 100  — after unfreezing, works again
    expect(clock.now()).toBe(100);
  });

  it('pending() lists all scheduled timers', () => {
    clock.setTimeout(() => {}, 300);
    clock.setTimeout(() => {}, 100);
    const p = clock.pending();
    // Expected: sorted ascending by scheduledTime
    expect(p.map((t) => t.scheduledTime)).toEqual([100, 300]);
  });

  it('advanceTo() jumps to an exact timestamp', () => {
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(1), 50);
    clock.setTimeout(() => fired.push(2), 150);
    clock.advanceTo(100);
    // Expected: [1]  — only 50ms timer fires
    expect(fired).toEqual([1]);
    // Expected: 100
    expect(clock.now()).toBe(100);
  });
});

// install() / uninstall()

describe('install / uninstall', () => {
  it('patches Date.now() and performance.now()', () => {
    const { clock, uninstall } = install(5000);
    try {
      // Expected: 5000
      expect(Date.now()).toBe(5000);
      expect(performance.now()).toBe(5000);
      clock.advance(100);
      // Expected: 5100
      expect(Date.now()).toBe(5100);
    } finally {
      uninstall();
    }
    // After uninstall, Date.now() should return real time (not 5100)
    expect(Date.now()).not.toBe(5100);
  });
});
