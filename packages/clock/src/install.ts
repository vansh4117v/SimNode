import { VirtualClock } from './VirtualClock.js';
import { createVirtualDate } from './VirtualDate.js';

export interface ClockInstallResult {
  clock: VirtualClock;
  uninstall: () => void;
}

export interface ClockInstallOptions {
  /**
   * If true (the default), patch `process.nextTick` to route through the virtual clock.
   * This ensures deterministic ordering of nextTick callbacks relative to timers.
   *
   * Set to false only when your scenario uses dynamic `import()`, undici, or other
   * Node.js internals that rely on `process.nextTick` for initialization, and those
   * operations run outside of any `advance()` call (which would otherwise drain the
   * virtual nextTick queue via `_flushMicrotasks`).
   *
   * @default true
   */
  patchNextTick?: boolean;
}

/**
 * Patch all global time primitives to use a VirtualClock.
 *
 * Returns the clock instance and an `uninstall` function that restores
 * every original global.
 */
export function install(clockOrStart?: VirtualClock | number, opts?: ClockInstallOptions): ClockInstallResult {
  const clock =
    clockOrStart instanceof VirtualClock
      ? clockOrStart
      : new VirtualClock(clockOrStart);

  const originals = {
    Date: globalThis.Date,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
    nextTick: globalThis.process?.nextTick,
    performanceNow: globalThis.performance.now.bind(globalThis.performance),
  };

  globalThis.Date = createVirtualDate(clock);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  (globalThis as any).setTimeout = (
    cb: (...a: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => clock.setTimeout(cb, delay ?? 0, ...args);

  (globalThis as any).clearTimeout = (id: number) => clock.clearTimeout(id);

  (globalThis as any).setInterval = (
    cb: (...a: unknown[]) => void,
    delay: number,
    ...args: unknown[]
  ) => clock.setInterval(cb, delay, ...args);

  (globalThis as any).clearInterval = (id: number) => clock.clearInterval(id);

  if (typeof globalThis.setImmediate !== 'undefined') {
    (globalThis as any).setImmediate = (cb: (...a: unknown[]) => void, ...args: unknown[]) => clock.setImmediate(cb, ...args);
    (globalThis as any).clearImmediate = (id: number) => clock.clearImmediate(id);
  }

  if (opts?.patchNextTick !== false && globalThis.process && typeof globalThis.process.nextTick === 'function') {
    globalThis.process.nextTick = (cb: (...a: unknown[]) => void, ...args: unknown[]) => clock.nextTick(cb, ...args);
  }

  globalThis.performance.now = () => clock.now();

  function uninstall(): void {
    globalThis.Date = originals.Date;
    globalThis.setTimeout = originals.setTimeout;
    globalThis.clearTimeout = originals.clearTimeout;
    globalThis.setInterval = originals.setInterval;
    globalThis.clearInterval = originals.clearInterval;
    if (originals.setImmediate) globalThis.setImmediate = originals.setImmediate;
    if (originals.clearImmediate) globalThis.clearImmediate = originals.clearImmediate;
    if (originals.nextTick && globalThis.process) globalThis.process.nextTick = originals.nextTick;
    globalThis.performance.now = originals.performanceNow;
  }

  return { clock, uninstall };
}
