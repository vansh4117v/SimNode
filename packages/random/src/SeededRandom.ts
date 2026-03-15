import { mulberry32 } from './mulberry32.js';

/**
 * Deterministic random number generator backed by mulberry32.
 *
 * Can patch `Math.random` within a scope or globally.
 */
export class SeededRandom {
  private readonly _next: () => number;
  private _originalRandom: (() => number) | null = null;

  constructor(seed: number) {
    this._next = mulberry32(seed);
  }

  /** Next float in [0, 1). */
  next(): number {
    return this._next();
  }

  /** Integer in [min, max] (inclusive). */
  intBetween(min: number, max: number): number {
    return min + Math.floor(this._next() * (max - min + 1));
  }

  /** Pick a random element from `arr`. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this._next() * arr.length)];
  }

  /** Return a new array with Fisher-Yates shuffle. */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Replace `Math.random` with this PRNG. */
  install(): void {
    this._originalRandom = Math.random;
    Math.random = () => this._next();
  }

  /** Restore the original `Math.random`. */
  uninstall(): void {
    if (this._originalRandom) {
      Math.random = this._originalRandom;
      this._originalRandom = null;
    }
  }
}

/**
 * Run `fn` with `Math.random` temporarily replaced by a seeded PRNG.
 */
export function patchMathRandom<T>(seed: number, fn: () => T): T {
  const rng = new SeededRandom(seed);
  rng.install();
  try {
    return fn();
  } finally {
    rng.uninstall();
  }
}
