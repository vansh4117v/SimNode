import { describe, it, expect } from 'vitest';
import { mulberry32, SeededRandom, patchMathRandom } from '../src/index.js';

// mulberry32

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    // Expected: seqA === seqB — identical sequences
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    // Expected: sequences differ
    expect(seqA).not.toEqual(seqB);
  });

  it('outputs values in [0, 1)', () => {
    const rng = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// SeededRandom

describe('SeededRandom', () => {
  it('intBetween stays within bounds', () => {
    const rng = new SeededRandom(99);
    for (let i = 0; i < 200; i++) {
      const v = rng.intBetween(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  it('shuffle is deterministic with same seed', () => {
    const a = new SeededRandom(7);
    const b = new SeededRandom(7);
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    // Expected: same shuffle result
    expect(a.shuffle(arr)).toEqual(b.shuffle(arr));
  });

  it('pick returns an element from the array', () => {
    const rng = new SeededRandom(1);
    const items = ['x', 'y', 'z'];
    for (let i = 0; i < 50; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });
});

// patchMathRandom

describe('patchMathRandom', () => {
  it('makes Math.random deterministic within scope', () => {
    const a = patchMathRandom(42, () => Array.from({ length: 5 }, () => Math.random()));
    const b = patchMathRandom(42, () => Array.from({ length: 5 }, () => Math.random()));
    // Expected: identical sequences
    expect(a).toEqual(b);
  });

  it('restores Math.random after scope exits', () => {
    const before = Math.random;
    patchMathRandom(1, () => {});
    // Expected: Math.random is restored
    expect(Math.random).toBe(before);
  });
});
