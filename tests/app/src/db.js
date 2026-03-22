import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres://localhost:5432/shop",
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(10,2) NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

export async function getProduct(id) {
  const { rows } = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function decrementStock(productId, quantity) {
  // BUG: check-then-act race — read stock, check, then update separately
  const product = await getProduct(productId);
  if (!product) throw new Error("Product not found");
  if (product.stock < quantity) throw new Error("Insufficient stock");

  await pool.query(
    "UPDATE products SET stock = stock - $1 WHERE id = $2",
    [quantity, productId]
  );
  return product.stock - quantity;
}

export async function createOrder(productId, quantity, total) {
  const { rows } = await pool.query(
    "INSERT INTO orders (product_id, quantity, total, status) VALUES ($1, $2, $3, 'confirmed') RETURNING *",
    [productId, quantity, total]
  );
  return rows[0];
}

export async function seedProduct(name, stock, price) {
  const { rows } = await pool.query(
    "INSERT INTO products (name, stock, price) VALUES ($1, $2, $3) RETURNING *",
    [name, stock, price]
  );
  return rows[0];
}

export { pool };
