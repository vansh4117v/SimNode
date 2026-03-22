// PostgreSQL inventory double-spend race condition
//
// The app's decrementStock() does check-then-act:
//   SELECT stock → if stock >= qty → UPDATE stock = stock - qty
// Two concurrent orders can both read stock=1, both pass the check,
// and both decrement — resulting in negative stock.

process.env.DATABASE_URL = "postgres://localhost:5432/shop";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "test-secret-key-32-chars-long!!";
process.env.PAYMENT_API_URL = "http://payments.example.com";

import supertest from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app.js";

export default async function pgInventoryRace(env) {
  const api = supertest(app);

  // Mock the external payment API — always succeeds
  env.http.mock("http://payments.example.com/charge", {
    status: 200,
    body: { ok: true, txId: "tx-123" },
  });

  // Seed a product with stock=1 (only one available)
  // Direct await works for seed — no mocked HTTP or latency yet
  const seedRes = await api
    .post("/admin/seed")
    .send({ name: "Limited Widget", stock: 1, price: 29.99 });

  if (seedRes.status !== 201) {
    throw new Error(`Seed failed: ${seedRes.status} ${JSON.stringify(seedRes.body)}`);
  }

  const productId = seedRes.body.id;

  const token = jwt.sign(
    { id: "user-1" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );
  // Second user needs a different token for rate limiter
  const token2 = jwt.sign(
    { id: "user-2" },
    process.env.JWT_SECRET,
    { expiresIn: "1h", issuer: "shop-api", audience: "shop-client" }
  );

  // Add 50ms latency to PG so the scheduler holds DB responses
  env.tcp.mock("localhost:5432", {
    handler: env.pg.createHandler(),
    latency: 50,
  });

  // Advance clock past rate-limit window (virtual clock starts at 0)
  await env.clock.advance(200);

  // Fire two concurrent purchase requests for stock=1 item.
  // Promise.all calls .then() on each Test, triggering the HTTP requests.
  // Generous pump (many steps) for PG→Redis→HTTP→PG chain.
  const order = (tkn) =>
    api
      .post("/orders")
      .set("Authorization", `Bearer ${tkn}`)
      .send({ productId, quantity: 1 });

  const racePromise = Promise.all([order(token), order(token2)]);
  await env.pump(500, 200);
  await env.pump(2000, 200);
  const [res1, res2] = await racePromise;

  const statuses = [res1.status, res2.status].sort((a, b) => a - b);

  env.timeline.record({
    timestamp: env.clock.now(),
    type: "ASSERT",
    detail: `Order statuses: [${statuses}], bodies: ${JSON.stringify([res1.body, res2.body])}`,
  });

  // Correct behaviour: one 201 (order placed) + one 409 (insufficient stock).
  // Bug: both get 201 because both read stock=1 before either decrements.
  if (statuses[0] === 201 && statuses[1] === 409) {
    return; // handled correctly
  }

  if (statuses[0] === 201 && statuses[1] === 201) {
    throw new Error(
      `Double-spend race condition! Both orders succeeded for stock=1 item.\n` +
      `The check-then-act pattern in decrementStock() let both requests read stock=1,\n` +
      `both pass the "stock >= quantity" check, and both decrement.\n` +
      `Fix: use SELECT ... FOR UPDATE, or UPDATE ... WHERE stock >= $1 RETURNING.`
    );
  }

  if (statuses[0] === 201 && statuses[1] === 500) {
    throw new Error(
      `Race condition detected — second request got 500 instead of 409.\n` +
      `Statuses: [${statuses}]\n` +
      `The concurrent decrement caused an unexpected error instead of a clean conflict.`
    );
  }

  throw new Error(
    `Unexpected statuses: [${statuses}]\n` +
    `res1: ${JSON.stringify(res1.body)}\nres2: ${JSON.stringify(res2.body)}`
  );
}
