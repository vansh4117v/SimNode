import type { VirtualClock } from './VirtualClock.js';

/**
 * Build a `DateConstructor` whose `now()` and zero-arg `new Date()`
 * read from the supplied VirtualClock.
 */
export function createVirtualDate(clock: VirtualClock): DateConstructor {
  const OrigDate = Date;

  class VirtualDate extends OrigDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(clock.now());
      } else if (args.length === 1) {
        super(args[0] as string | number);
      } else {
        // Multi-arg (year, month, …): delegate to native Date for
        // local-time semantics, then feed the resulting timestamp to super.
        const tmp = new OrigDate(
          args[0] as number,
          (args[1] as number) ?? 0,
          (args[2] as number) ?? 1,
          (args[3] as number) ?? 0,
          (args[4] as number) ?? 0,
          (args[5] as number) ?? 0,
          (args[6] as number) ?? 0,
        );
        super(tmp.getTime());
      }
    }

    static override now(): number {
      return clock.now();
    }

    static [Symbol.hasInstance](instance: unknown): boolean {
      return instance instanceof OrigDate;
    }
  }

  return VirtualDate as unknown as DateConstructor;
}
