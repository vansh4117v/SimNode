# @simnode/random

Deterministic seeded PRNG for Node.js, backed by the Mulberry32 algorithm.

## Usage

```ts
import { mulberry32, SeededRandom, patchMathRandom } from '@simnode/random';

// Low-level
const rng = mulberry32(42);
rng(); // always the same first value for seed 42

// Class API
const sr = new SeededRandom(42);
sr.next();              // [0, 1)
sr.intBetween(1, 6);    // dice roll
sr.pick(['a', 'b']);    // random element
sr.shuffle([1, 2, 3]);  // Fisher-Yates

// Scoped Math.random patching
const values = patchMathRandom(42, () => {
  return [Math.random(), Math.random(), Math.random()];
});
// Same seed → same values every time
```
