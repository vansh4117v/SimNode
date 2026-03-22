// Minimal PG test — direct pg queries, then supertest, then latency
process.env.DATABASE_URL = "postgres://localhost:5432/shop";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "test-secret-key-32-chars-long!!";
process.env.PAYMENT_API_URL = "http://payments.example.com";

import pg from "pg";
import supertest from "supertest";
import app from "../src/app.js";

export default async function pgMinimal(env) {
  // Direct pg queries — same as what the app does
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  env.timeline.record({ timestamp: env.clock.now(), type: "DEBUG", detail: "Before CREATE TABLE" });
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY, name TEXT, stock INTEGER DEFAULT 0, price NUMERIC(10,2) DEFAULT 0
  )`);
  env.timeline.record({ timestamp: env.clock.now(), type: "DEBUG", detail: "After CREATE TABLE" });

  await pool.query("INSERT INTO products (name, stock, price) VALUES ($1, $2, $3)", ["Widget", 5, 9.99]);
  env.timeline.record({ timestamp: env.clock.now(), type: "DEBUG", detail: "After INSERT (extended protocol)" });

  const res = await pool.query("SELECT * FROM products WHERE name = $1", ["Widget"]);
  env.timeline.record({ timestamp: env.clock.now(), type: "DEBUG", detail: `SELECT result: ${JSON.stringify(res.rows)}` });

  await pool.end();

  if (res.rows.length !== 1) {
    throw new Error(`Expected 1 row, got ${res.rows.length}`);
  }
}
