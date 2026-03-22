import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

export async function getCached(key) {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}

export async function setCache(key, value, ttlSeconds = 60) {
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

export async function invalidateCache(key) {
  await redis.del(key);
}

// BUG: cache stampede — no locking. If cache misses, multiple concurrent
// requests all hit the DB simultaneously and all write to cache.
export async function getOrSet(key, fetchFn, ttlSeconds = 60) {
  const cached = await getCached(key);
  if (cached) return cached;

  const value = await fetchFn();
  await setCache(key, value, ttlSeconds);
  return value;
}

export { redis };
