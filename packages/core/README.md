# @simnode/core

Simulation harness for SimNode. Orchestrates all modules: virtual clock, seeded PRNG, scheduler, HTTP/TCP interceptors, virtual filesystem, and fault injector. Provides `Simulation` class with `scenario()`, `run({ seeds })`, and `replay({ seed, scenario })`. Includes `simnode` CLI with `run` and `replay` commands.
