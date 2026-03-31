# crashlab

## 1.0.0

### Major Changes

- Release version 1.0.0

### Patch Changes

- Updated dependencies
  - @crashlab/core@1.0.0
  - @crashlab/mongo@1.0.0
  - @crashlab/pg-mock@1.0.0
  - @crashlab/redis-mock@1.0.0

## 0.1.15

### Patch Changes

- Add extensive runtime trace logging (`CrashlabTrace`) across core worker setup, scheduler enqueue/shuffle/execute, and TCP interceptor/VirtualSocket paths to debug replay determinism differences between outcomes.
  - @crashlab/core@0.1.15
  - @crashlab/mongo@0.1.15
  - @crashlab/pg-mock@0.1.15
  - @crashlab/redis-mock@0.1.15

## 0.1.14

### Patch Changes

- Fix replay nondeterminism caused by scenario import-time side effects escaping interception by installing TCP/HTTP/fetch interception before scenario import while keeping filesystem interception after import.

  Includes regression coverage for top-level TCP side effects during module import.

  - @crashlab/core@0.1.14
  - @crashlab/mongo@0.1.14
  - @crashlab/pg-mock@0.1.14
  - @crashlab/redis-mock@0.1.14

## 0.1.13

### Patch Changes

- Fix replay nondeterminism by robustly rewriting MongoDB URIs to per-seed database names even when the URI omits an explicit /db path, while preserving deterministic pre-import environment patching in the worker.
  - @crashlab/core@0.1.13
  - @crashlab/mongo@0.1.13
  - @crashlab/pg-mock@0.1.13
  - @crashlab/redis-mock@0.1.13

## 0.1.12

### Patch Changes

- Fix replay nondeterminism for Mongo-backed scenarios by applying per-seed Mongo DB URI isolation before scenario module import (covering import-time env capture), then reapplying after import for dotenv overrides.
  - @crashlab/core@0.1.12
  - @crashlab/mongo@0.1.12
  - @crashlab/pg-mock@0.1.12
  - @crashlab/redis-mock@0.1.12

## 0.1.11

### Patch Changes

- Fix replay determinism for concurrent identical operations by eliminating scheduler completion ID collisions across TCP, local TCP server, HTTP, and fetch paths.

  Also add regression tests for same-payload concurrent writes across different sockets and repeated writes on the same socket.

  - @crashlab/core@0.1.11
  - @crashlab/mongo@0.1.11
  - @crashlab/pg-mock@0.1.11
  - @crashlab/redis-mock@0.1.11

## 0.1.10

### Patch Changes

- Updated dependencies
  - @crashlab/core@0.1.10
  - @crashlab/mongo@0.1.10
  - @crashlab/pg-mock@0.1.10
  - @crashlab/redis-mock@0.1.10
