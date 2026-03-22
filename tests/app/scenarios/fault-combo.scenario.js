// Fault injection combo scenario
//
// Tests SimNode's fault injection features together:
// 1. Clock skew — verify JWT expiry is affected
// 2. Disk full — verify audit log failure is handled gracefully
// 3. Slow database — verify requests still complete under high latency
// 4. Network partition — verify external API calls fail cleanly

process.env.DATABASE_URL = "postgres://localhost:5432/shop";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "test-secret-key-32-chars-long!!";
process.env.PAYMENT_API_URL = "http://payments.example.com";

import supertest from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app.js";

export default async function faultCombo(env) {
  const api = supertest(app);

  // Mock the external payment API — always succeeds
  env.http.mock("http://payments.example.com/charge", {
    status: 200,
    body: { ok: true, txId: "tx-789" },
  });

  // Seed product
  const seedRes = await api
    .post("/admin/seed")
    .send({ name: "Fault Test Widget", stock: 10, price: 19.99 });

  if (seedRes.status !== 201) {
    throw new Error(`Seed failed: ${seedRes.status} ${JSON.stringify(seedRes.body)}`);
  }
  const productId = seedRes.body.id;

  // ── Test 1: Clock skew breaks JWT ───────────────────────────────────
  // Advance past rate-limit window first (virtual clock starts at 0)
  await env.clock.advance(200);

  // Create a token that expires in 1 hour
  const token = jwt.sign(
    { id: "user-1" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );

  // Advance clock by 2 hours — token should be expired
  await env.clock.advance(2 * 60 * 60 * 1000);

  const expiredRes = await api
    .post("/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ productId, quantity: 1 });

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "CLOCK_SKEW",
    detail: `Expired JWT response: ${expiredRes.status}`,
  });

  if (expiredRes.status !== 401) {
    throw new Error(
      `Clock advance did not expire JWT! Expected 401 but got ${expiredRes.status}.\n` +
      `This means SimNode's virtual clock is not affecting jwt.verify().`
    );
  }

  // ── Test 2: Disk full — audit log write should fail gracefully ──────
  env.faults.diskFull("/var/log");

  // Create a fresh token (relative to current virtual time)
  const freshToken = jwt.sign(
    { id: "user-2" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );

  // .then(r=>r) triggers the HTTP request before pump starts
  const diskFullPromise = api
    .post("/orders")
    .set("Authorization", `Bearer ${freshToken}`)
    .send({ productId, quantity: 1 })
    .then(r => r);
  await env.pump(500, 200);
  await env.pump(2000, 200);
  const diskFullRes = await diskFullPromise;

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "DISK_FULL",
    detail: `Order under disk-full: ${diskFullRes.status} ${JSON.stringify(diskFullRes.body)}`,
  });

  // The order should still succeed — audit log failure is non-fatal
  if (diskFullRes.status !== 201) {
    throw new Error(
      `Disk full caused order failure! Status: ${diskFullRes.status}\n` +
      `The audit log write error should be caught and ignored.\n` +
      `Body: ${JSON.stringify(diskFullRes.body)}`
    );
  }

  // ── Test 3: Slow database — requests should still complete ──────────
  env.tcp.mock("localhost:5432", {
    handler: env.pg.createHandler(),
    latency: 200,
  });

  const slowToken = jwt.sign(
    { id: "user-3" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );

  // .then(r=>r) triggers the request; generous pump for 200ms PG latency
  const slowPromise = api
    .post("/orders")
    .set("Authorization", `Bearer ${slowToken}`)
    .send({ productId, quantity: 1 })
    .then(r => r);

  await env.pump(2000, 200);
  await env.pump(3000, 200);
  const slowRes = await slowPromise;

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "SLOW_DB",
    detail: `Order under slow DB: ${slowRes.status}`,
  });

  if (slowRes.status !== 201) {
    throw new Error(
      `Slow database caused order failure! Status: ${slowRes.status}\n` +
      `With 200ms latency, the order should still complete within the pump window.\n` +
      `Body: ${JSON.stringify(slowRes.body)}`
    );
  }

  // ── Test 4: Network partition — payment should fail cleanly ─────────
  env.http.blockAll(5000);

  const partitionToken = jwt.sign(
    { id: "user-4" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );

  // .then(r=>r) triggers the request
  const partitionPromise = api
    .post("/orders")
    .set("Authorization", `Bearer ${partitionToken}`)
    .send({ productId, quantity: 1 })
    .then(r => r);

  await env.pump(500, 200);
  await env.pump(2000, 200);
  const partitionRes = await partitionPromise;

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "PARTITION",
    detail: `Order under partition: ${partitionRes.status} ${JSON.stringify(partitionRes.body)}`,
  });

  // The order should fail because the payment API is partitioned
  if (partitionRes.status === 201) {
    throw new Error(
      `Order succeeded despite network partition!\n` +
      `The payment API should have been unreachable, but the order went through.`
    );
  }

  // 500 is acceptable — it means the payment HTTP call failed
  if (partitionRes.status !== 500) {
    throw new Error(
      `Unexpected status under partition: ${partitionRes.status}\n` +
      `Expected 500 (payment unreachable). Body: ${JSON.stringify(partitionRes.body)}`
    );
  }

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "END",
    detail: "All fault injection tests passed",
  });
}
