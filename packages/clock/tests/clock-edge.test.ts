import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualClock, install } from '../src/index.js';

// Cascading timers

describe('cascading timers', () => {
  let clock: VirtualClock;
  beforeEach(() => { clock = new VirtualClock(0); });

  it('timer callback can schedule a timer that fires within the same advance window', () => {
    const order: string[] = [];
    clock.setTimeout(() => {
      order.push('parent');
      clock.setTimeout(() => order.push('child'), 50); // fires at 150
    }, 100);
    clock.setTimeout(() => order.push('peer-200'), 200);
    clock.advance(200);
    // Expected: ["parent", "child", "peer-200"]
    expect(order).toEqual(['parent', 'child', 'peer-200']);
  });

  it('deeply nested cascading timers execute in correct order', () => {
    const order: number[] = [];
    clock.setTimeout(() => {
      order.push(1);
      clock.setTimeout(() => {
        order.push(2);
        clock.setTimeout(() => {
          order.push(3);
        }, 10); // fires at 120
      }, 10); // fires at 110
    }, 100); // fires at 100
    clock.advance(200);
    // Expected: [1, 2, 3]
    expect(order).toEqual([1, 2, 3]);
  });

  it('child scheduled beyond advance window is NOT fired', () => {
    const order: string[] = [];
    clock.setTimeout(() => {
      order.push('parent');
      clock.setTimeout(() => order.push('child'), 200); // fires at 300
    }, 100);
    clock.advance(200);
    // Expected: ["parent"] — child is at 300, beyond 200
    expect(order).toEqual(['parent']);
    expect(clock.pending()).toHaveLength(1);
  });
});

// Cancel during execution

describe('cancel during execution', () => {
  let clock: VirtualClock;
  beforeEach(() => { clock = new VirtualClock(0); });

  it('a timer can cancel a sibling timer during its callback', () => {
    const order: string[] = [];
    let siblingId: number;
    clock.setTimeout(() => {
      order.push('first');
      clock.clearTimeout(siblingId);
    }, 100);
    siblingId = clock.setTimeout(() => order.push('cancelled'), 200);
    clock.advance(300);
    // Expected: ["first"] — sibling was cancelled
    expect(order).toEqual(['first']);
  });

  it('clearInterval inside its own callback stops further ticks', () => {
    const ticks: number[] = [];
    const id = clock.setInterval(() => {
      ticks.push(clock.now());
      if (ticks.length === 3) clock.clearInterval(id);
    }, 100);
    clock.advance(1000);
    // Expected: [100, 200, 300] — stops after 3 invocations
    expect(ticks).toEqual([100, 200, 300]);
  });
});

// setInterval precision

describe('setInterval precision', () => {
  let clock: VirtualClock;
  beforeEach(() => { clock = new VirtualClock(0); });

  it('fires at exact multiples of the delay', () => {
    const times: number[] = [];
    clock.setInterval(() => times.push(clock.now()), 250);
    clock.advance(1000);
    // Expected: [250, 500, 750, 1000]
    expect(times).toEqual([250, 500, 750, 1000]);
  });

  it('interleaves correctly with setTimeout', () => {
    const order: string[] = [];
    clock.setInterval(() => order.push('interval-' + clock.now()), 100);
    clock.setTimeout(() => order.push('timeout-150'), 150);
    clock.advance(200);
    // Expected: interval at 100, timeout at 150, interval at 200
    expect(order).toEqual(['interval-100', 'timeout-150', 'interval-200']);
  });
});

// Large number of timers

describe('large timer counts', () => {
  it('handles 1000 timers correctly', () => {
    const clock = new VirtualClock(0);
    const fired: number[] = [];
    for (let i = 0; i < 1000; i++) {
      clock.setTimeout(() => fired.push(i), i + 1);
    }
    clock.advance(1000);
    // Expected: all 1000 timers fire in order 0..999
    expect(fired).toHaveLength(1000);
    expect(fired).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  it('handles 1000 timers at the exact same time (FIFO)', () => {
    const clock = new VirtualClock(0);
    const fired: number[] = [];
    for (let i = 0; i < 1000; i++) {
      clock.setTimeout(() => fired.push(i), 100);
    }
    clock.advance(100);
    // Expected: all fire in insertion order
    expect(fired).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });
});

// advanceTo edge cases

describe('advanceTo edge cases', () => {
  let clock: VirtualClock;
  beforeEach(() => { clock = new VirtualClock(0); });

  it('advanceTo same as now is a no-op', () => {
    clock.advance(100);
    const fired: boolean[] = [];
    clock.setTimeout(() => fired.push(true), 0); // at 100
    clock.advanceTo(100);
    // Timer is at 100 and advanceTo(100) processes <= 100
    expect(fired).toHaveLength(1);
  });

  it('advanceTo before now is a no-op (no backward time travel)', () => {
    clock.advance(500);
    expect(clock.now()).toBe(500);
    clock.advanceTo(200); // attempt to go backward
    // Expected: time stays at 500
    expect(clock.now()).toBe(500);
  });
});

// pending() correctness

describe('pending() correctness', () => {
  it('reflects timer additions and removals', () => {
    const clock = new VirtualClock(0);
    const id1 = clock.setTimeout(() => {}, 100);
    const id2 = clock.setTimeout(() => {}, 200);
    clock.setTimeout(() => {}, 300);

    expect(clock.pending()).toHaveLength(3);

    clock.clearTimeout(id1);
    expect(clock.pending()).toHaveLength(2);
    expect(clock.pending().map(t => t.id)).not.toContain(id1);

    clock.clearTimeout(id2);
    expect(clock.pending()).toHaveLength(1);
  });

  it('is empty after all timers have fired', () => {
    const clock = new VirtualClock(0);
    clock.setTimeout(() => {}, 50);
    clock.setTimeout(() => {}, 100);
    clock.advance(200);
    expect(clock.pending()).toHaveLength(0);
  });
});

// VirtualDate edge cases

describe('VirtualDate via install', () => {
  it('new Date() reflects virtual time', () => {
    const { clock, uninstall } = install(1_000_000);
    try {
      const d = new Date();
      expect(d.getTime()).toBe(1_000_000);
      clock.advance(5000);
      const d2 = new Date();
      expect(d2.getTime()).toBe(1_005_000);
    } finally {
      uninstall();
    }
  });

  it('new Date(specific) ignores virtual clock', () => {
    const { uninstall } = install(999);
    try {
      const d = new Date(0);
      expect(d.getTime()).toBe(0);
      const d2 = new Date('2024-01-01T00:00:00Z');
      expect(d2.getFullYear()).toBe(2024);
    } finally {
      uninstall();
    }
  });
});
