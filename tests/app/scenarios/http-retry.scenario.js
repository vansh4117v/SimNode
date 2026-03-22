// HTTP external API retry under network partition
//
// The app's chargePayment() makes a single HTTP call to the payment
// gateway with NO retry logic. Under a transient network partition,
// the payment fails and the entire order fails — even though the
// stock was already decremented (partial failure / data inconsistency).

process.env.DATABASE_URL = "postgres://localhost:5432/shop";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "test-secret-key-32-chars-long!!";
process.env.PAYMENT_API_URL = "http://payments.example.com";

import supertest from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app.js";

export default async function httpRetryUnderPartition(env) {
  const api = supertest(app);

  // Mock payment API — first call fails, second would succeed
  let callCount = 0;
  env.http.mock("http://payments.example.com/charge", {
    handler: (call) => {
      callCount++;
      if (callCount === 1) {
        return { status: 503, body: { error: "Service temporarily unavailable" } };
      }
      return { status: 200, body: { ok: true, txId: "tx-456" } };
    },
  });

  // Seed product (direct await — no pump needed for simple PG inserts)
  const seedRes = await api
    .post("/admin/seed")
    .send({ name: "Premium Widget", stock: 5, price: 49.99 });

  if (seedRes.status !== 201) {
    throw new Error(`Seed failed: ${seedRes.status} ${JSON.stringify(seedRes.body)}`);
  }

  const productId = seedRes.body.id;

  const token = jwt.sign(
    { id: "user-1" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );

  // Advance clock past the rate-limit window (100ms).
  // SimNode's virtual clock starts at 0, exposing a bug in the rate limiter:
  // `rateLimits.get(userId) || 0` treats first request as if last was at t=0,
  // so Date.now() - 0 < 100 → always rate-limited. Real clocks never hit this.
  await env.clock.advance(200);

  // Place an order — the payment API will return 503 on the first call.
  // The Express→PG→Redis→HTTP mock chain needs many real event-loop yields
  // so we use generous pump steps (small clock advance, many yields).
  // .then(r => r) converts the supertest Test into a real Promise, which
  // triggers the actual HTTP request.  Without this, the request isn't
  // sent until `await`, and the pump would run with nothing in flight.
  const orderPromise = api
    .post("/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({ productId, quantity: 1 })
    .then(r => r);
  await env.pump(500, 200);
  await env.pump(2000, 200);
  const res = await orderPromise;

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "ASSERT",
    detail: `Order status: ${res.status}, body: ${JSON.stringify(res.body)}, payment calls: ${callCount}`,
  });

  // The order should fail because the payment API returned 503
  // and there's no retry logic.
  if (res.status === 500 && callCount === 1) {
    // Bug confirmed: stock was decremented but payment failed,
    // leaving the system in an inconsistent state.
    // The app should either:
    // 1. Retry the payment, OR
    // 2. Roll back the stock decrement on payment failure
    throw new Error(
      `Payment failure caused data inconsistency!\n` +
      `Stock was decremented but payment failed (503), order returned 500.\n` +
      `The app has no retry logic and no rollback — stock is now permanently lost.\n` +
      `Fix: add retry logic to chargePayment(), or wrap stock+payment in a transaction.`
    );
  }

  if (res.status === 201) {
    // Somehow the payment succeeded — this shouldn't happen on first call
    return;
  }

  throw new Error(
    `Unexpected result: status=${res.status}, body=${JSON.stringify(res.body)}`
  );
}
