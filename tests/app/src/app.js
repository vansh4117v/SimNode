import express from "express";
import jwt from "jsonwebtoken";
import { getProduct, decrementStock, createOrder, seedProduct, initDB } from "./db.js";
import { getOrSet, invalidateCache } from "./cache.js";
import { chargePayment } from "./payment.js";
import fs from "node:fs";

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-key-32-chars-long!!";

// Simple auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET, {
      issuer: "shop-api",
      audience: "shop-client",
    });
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Simple rate limiter — stores last request time per user
const rateLimits = new Map();
function rateLimit(windowMs = 1000) {
  return (req, res, next) => {
    const userId = req.user?.id || "anon";
    const now = Date.now();
    const last = rateLimits.get(userId) || 0;
    if (now - last < windowMs) {
      return res.status(429).json({ error: "Rate limited" });
    }
    rateLimits.set(userId, now);
    next();
  };
}

// GET /products/:id — cached read
app.get("/products/:id", async (req, res) => {
  try {
    const product = await getOrSet(
      `product:${req.params.id}`,
      () => getProduct(req.params.id),
      30
    );
    if (!product) return res.status(404).json({ error: "Not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /orders — purchase a product (auth + rate limited)
// BUG: check-then-act race on stock decrement
app.post("/orders", auth, rateLimit(100), async (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity) {
    return res.status(400).json({ error: "productId and quantity required" });
  }

  try {
    // 1. Read product (possibly from cache)
    const product = await getOrSet(
      `product:${productId}`,
      () => getProduct(productId),
      30
    );
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (product.stock < quantity) {
      return res.status(409).json({ error: "Insufficient stock" });
    }

    // 2. Decrement stock (race: another request may have decremented between check and update)
    const newStock = await decrementStock(productId, quantity);

    // 3. Charge payment via external API
    const total = product.price * quantity;
    const payment = await chargePayment(null, total);

    // 4. Create order
    const order = await createOrder(productId, quantity, total);

    // 5. Invalidate cache
    await invalidateCache(`product:${productId}`);

    // 6. Audit log
    try {
      const logLine = `${new Date().toISOString()} ORDER ${order.id} user=${req.user.id} product=${productId} qty=${quantity} total=${total}\n`;
      fs.appendFileSync("/var/log/shop/audit.log", logLine);
    } catch {
      // audit log failure is non-fatal
    }

    res.status(201).json({ order, payment, remainingStock: newStock });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/seed — seed a product (for testing)
app.post("/admin/seed", async (req, res) => {
  try {
    await initDB();
    const product = await seedProduct(
      req.body.name || "Widget",
      req.body.stock ?? 10,
      req.body.price ?? 9.99
    );
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default app;
export { JWT_SECRET };
