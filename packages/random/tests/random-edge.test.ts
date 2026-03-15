import { describe, it, expect } from 'vitest';
import { mulberry32, SeededRandom, patchMathRandom } from '../src/index.js';

// Determinism across multiple instantiations

describe('cross-instance determinism', () => {
  it('two SeededRandom instances with same seed produce identical sequences of 1000 values', () => {
    const a = new SeededRandom(12345);
    const b = new SeededRandom(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('mulberry32 with same seed across separate calls matches', () => {
    const seq1 = Array.from({ length: 100 }, (() => { const r = mulberry32(42); return () => r(); })());
    const rng = mulberry32(42);
    const seq2 = Array.from({ length: 100 }, () => rng());
    // Both should be identical (same seed, same call order)
    // Actually seq1 is wrong — let me fix this
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });
});

// Edge seeds

describe('edge seed values', () => {
  it.each([0, -1, 1, 2147483647, -2147483648, Number.MAX_SAFE_INTEGER])(
    'seed %d produces valid [0,1) output',
    (seed) => {
      const rng = mulberry32(seed);
      for (let i = 0; i < 100; i++) {
        const v = rng();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    },
  );

  it('seed 0 and seed 1 produce different sequences', () => {
    const a = mulberry32(0);
    const b = mulberry32(1);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

// Large sequence stability

describe('large sequence stability', () => {
  it('10,000 values stay deterministic', () => {
    const rng1 = mulberry32(777);
    const rng2 = mulberry32(777);
    for (let i = 0; i < 10_000; i++) {
      expect(rng1()).toBe(rng2());
    }
  });
});

// shuffle determinism

describe('shuffle determinism', () => {
  it('shuffle of 100 elements is identical across runs', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    expect(a.shuffle(arr)).toEqual(b.shuffle(arr));
  });

  it('shuffle does not modify the original array', () => {
    const arr = [1, 2, 3, 4, 5];
    const copy = [...arr];
    const rng = new SeededRandom(1);
    rng.shuffle(arr);
    expect(arr).toEqual(copy);
  });
});

// install / uninstall isolation

describe('install / uninstall isolation', () => {
  it('Math.random is deterministic while installed', () => {
    const rng = new SeededRandom(10);
    rng.install();
    const values = Array.from({ length: 5 }, () => Math.random());
    rng.uninstall();

    const rng2 = new SeededRandom(10);
    rng2.install();
    const values2 = Array.from({ length: 5 }, () => Math.random());
    rng2.uninstall();

    expect(values).toEqual(values2);
  });

  it('patchMathRandom restores even if fn throws', () => {
    const before = Math.random;
    try {
      patchMathRandom(1, () => { throw new Error('boom'); });
    } catch { /* expected */ }
    expect(Math.random).toBe(before);
  });
});
