import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { install, VirtualClock } from '../src/index.js';

describe('Virtual microtask queue', () => {
  let clock: VirtualClock;
  let uninstall: () => void;

  beforeEach(() => {
    const installed = install(undefined, { patchNextTick: true });
    clock = installed.clock;
    uninstall = installed.uninstall;
  });

  afterEach(() => {
    uninstall();
  });

  it('executes in correct order: nextTick -> microtasks -> setImmediate', async () => {
    const executionOrder: string[] = [];

    setTimeout(() => {
      executionOrder.push('timer-root');
      
      setImmediate(() => {
        executionOrder.push('immediate-1');
        Promise.resolve().then(() => executionOrder.push('microtask-in-immediate'));
      });
      
      process.nextTick(() => {
        executionOrder.push('nextTick-1');
        process.nextTick(() => executionOrder.push('nextTick-nested'));
      });
      
      Promise.resolve().then(() => {
        executionOrder.push('microtask-1');
        process.nextTick(() => executionOrder.push('nextTick-in-microtask'));
      });
    }, 10);

    await clock.advance(10);

    expect(executionOrder).toEqual([
      'timer-root',
      'nextTick-1',
      'nextTick-nested',
      'microtask-1',
      'nextTick-in-microtask',
      'immediate-1',
      'microtask-in-immediate'
    ]);
  });

  it('cancels setImmediate using clearImmediate', async () => {
    const executionOrder: string[] = [];

    setTimeout(() => {
      const id1 = setImmediate(() => executionOrder.push('immediate-1'));
      const id2 = setImmediate(() => executionOrder.push('immediate-2'));
      
      clearImmediate(id1);
    }, 10);

    await clock.advance(10);

    expect(executionOrder).toEqual(['immediate-2']);
  });
});
