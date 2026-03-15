import { VirtualClock } from './VirtualClock.js';
import { createVirtualDate } from './VirtualDate.js';

export interface ClockInstallResult {
  clock: VirtualClock;
  uninstall: () => void;
}

/**
 * Patch all global time primitives to use a VirtualClock.
 *
 * Returns the clock instance and an `uninstall` function that restores
 * every original global.
 */
export function install(clockOrStart?: VirtualClock | number): ClockInstallResult {
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

  globalThis.performance.now = () => clock.now();

  function uninstall(): void {
    globalThis.Date = originals.Date;
    globalThis.setTimeout = originals.setTimeout;
    globalThis.clearTimeout = originals.clearTimeout;
    globalThis.setInterval = originals.setInterval;
    globalThis.clearInterval = originals.clearInterval;
    globalThis.performance.now = originals.performanceNow;
  }

  return { clock, uninstall };
}
