# @simnode/mongo

High-fidelity MongoDB proxy for deterministic simulation testing. 

Instead of a partial JS-only mock, this package uses a **TCP Proxy model** to route traffic from your application to a real MongoDB binary (`mongodb-memory-server`). This ensures 100% protocol fidelity — including complex aggregation pipelines, transactions, and change streams — while still allowing SimNode to inject deterministic virtual latency.

## Features

- **100% Fidelity:** Since it proxies to a real `mongod` process, every MongoDB feature works exactly as it does in production.
- **Per-Seed Isolation:** Each simulation seed automatically uses a unique database name (`sim_db_<seed>`) which is dropped after the run.
- **Virtual Latency:** Integrated with `@simnode/tcp` and `@simnode/clock` to hold response bytes until the virtual clock advances.
- **Assertion API:** Direct access to the database via `env.mongo.find()` for easy test assertions without needing a separate driver setup in your scenario.

## Installation

```sh
npm install --save-dev @simnode/mongo
```

Note: This package is included by default in the main `simnode` package.

## Usage (Internal SimNode API)

In a SimNode scenario, `@simnode/mongo` is available on the `env` object:

```javascript
export default async function scenario(env) {
  // 1. The environment automatically rewrites MONGODB_URI to point to the proxy
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const db = client.db();

  // 2. Perform operations (these will be intercepted and proxied)
  await db.collection('users').insertOne({ name: 'Alice' });

  // 3. Advance virtual time (the proxy holds the response until this happens)
  await env.clock.advance(50);

  // 4. Use the assertion API to verify state directly
  const users = await env.mongo.find('users', { name: 'Alice' });
  if (users.length !== 1) throw new Error('User not found');
}
```

## How it Works

1. **Shared Server:** The `Simulation` runner starts one `MongoMemoryServer` process for the entire test run.
2. **TCP Interception:** When your app connects to `localhost:27017`, `@simnode/tcp` intercepts the connection.
3. **Message Framing:** `MongoMock` reassembles raw TCP chunks into valid MongoDB wire-protocol frames (based on the 4-byte length prefix).
4. **Latency Injection:** Complete response frames from the real `mongod` are held by the `Scheduler` and only released to your app when the virtual clock reaches the scheduled time.
5. **Auto-Cleanup:** The `mongo.drop()` method is called after every seed to ensure the shared process stays clean for the next run.

## License

MIT
