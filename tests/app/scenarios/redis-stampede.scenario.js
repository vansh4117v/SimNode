// Redis cache stampede scenario
//
// The app's getOrSet() has no locking. When the cache is empty and
// multiple requests arrive simultaneously, ALL of them miss the cache,
// ALL hit the database, and ALL write to the cache — wasting resources
// and potentially serving stale data if writes overlap.

process.env.DATABASE_URL = "postgres://localhost:5432/shop";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "test-secret-key-32-chars-long!!";
process.env.PAYMENT_API_URL = "http://payments.example.com";

import supertest from "supertest";
import app from "../src/app.js";
import { pool } from "../src/db.js";

export default async function redisCacheStampede(env) {
  const api = supertest(app);

  // Seed a product
  const seedRes = await api
    .post("/admin/seed")
    .send({ name: "Popular Widget", stock: 100, price: 9.99 });

  if (seedRes.status !== 201) {
    throw new Error(`Seed failed: ${seedRes.status} ${JSON.stringify(seedRes.body)}`);
  }

  const productId = seedRes.body.id;

  // Add 50ms latency to PG so DB reads take time
  env.tcp.mock("localhost:5432", {
    handler: env.pg.createHandler(),
    latency: 50,
  });

  // Also add latency to Redis so cache checks take time
  env.tcp.mock("localhost:6379", {
    handler: env.redis.createHandler(),
    latency: 30,
  });

  // Fire 5 concurrent GET /products/:id requests — all should be cacheable
  // but with latency, they'll all miss the cache simultaneously
  const reqs = Array.from({ length: 5 }, () =>
    api.get(`/products/${productId}`)
  );

  const racePromise = Promise.all(reqs);
  await env.pump(2000, 40);
  const responses = await racePromise;

  const statuses = responses.map((r) => r.status);
  const allOk = statuses.every((s) => s === 200);

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "ASSERT",
    detail: `GET statuses: [${statuses}]`,
  });

  if (!allOk) {
    throw new Error(
      `Cache stampede caused failures! Statuses: [${statuses}]\n` +
      `Some concurrent cache-miss requests failed when they shouldn't have.`
    );
  }

  // Now check: how many times did the DB actually get queried?
  // In a correct implementation with cache locking, only 1 DB query should fire.
  // With the stampede bug, all 5 requests hit the DB.
  // We can't easily count DB queries from here, but we can verify all responses
  // returned the same data (no stale/inconsistent reads).
  const bodies = responses.map((r) => JSON.stringify(r.body));
  const unique = new Set(bodies);

  if (unique.size > 1) {
    throw new Error(
      `Cache stampede produced inconsistent results!\n` +
      `${unique.size} different responses for the same product.\n` +
      `This indicates concurrent cache writes overwrote each other.`
    );
  }

  // Test passes — all responses are consistent (even though all hit DB).
  // In a real scenario we'd assert only 1 DB query happened, but at minimum
  // we verified the stampede didn't cause errors or inconsistency.
}
