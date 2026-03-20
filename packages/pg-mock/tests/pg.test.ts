import { describe, it, expect } from 'vitest';
import { PgMock } from '../src/index.js';

describe('PgMock SQL execution via PGlite', () => {
  it('SELECT literal', async () => {
    const pg = new PgMock();
    await pg.ready();
    const r = await pg.query('SELECT 1');
    const row = r.rows[0] as Record<string, unknown>;
    expect(row['?column?']).toBe(1);
  }, 30_000);

  it('SELECT from seeded table', async () => {
    const pg = new PgMock();
    pg.seedData('users', [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
    await pg.ready();
    const r = await pg.query<{ id: string; name: string }>('SELECT id, name FROM users');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ id: '1', name: 'Alice' });
  }, 30_000);

  it('SELECT with WHERE', async () => {
    const pg = new PgMock();
    pg.seedData('users', [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]);
    await pg.ready();
    const r = await pg.query<{ name: string }>("SELECT name FROM users WHERE id = '1'");
    expect(r.rows).toEqual([{ name: 'Alice' }]);
  }, 30_000);

  it('INSERT adds row', async () => {
    const pg = new PgMock();
    await pg.ready();
    await pg.query("CREATE TABLE users (id TEXT, name TEXT)");
    await pg.query("INSERT INTO users (id, name) VALUES ('1', 'Carol')");
    const q = await pg.query('SELECT * FROM users');
    expect(q.rows).toHaveLength(1);
  }, 30_000);

  it('UPDATE modifies row', async () => {
    const pg = new PgMock();
    pg.seedData('accounts', [{ id: '1', balance: '100' }]);
    await pg.ready();
    await pg.query("UPDATE accounts SET balance = '0' WHERE id = '1'");
    const q = await pg.query<{ balance: string }>("SELECT balance FROM accounts WHERE id = '1'");
    expect(q.rows[0].balance).toBe('0');
  }, 30_000);

  it('DELETE removes row', async () => {
    const pg = new PgMock();
    pg.seedData('users', [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]);
    await pg.ready();
    await pg.query("DELETE FROM users WHERE id = '1'");
    const q = await pg.query('SELECT * FROM users');
    expect(q.rows).toHaveLength(1);
  }, 30_000);

  it('transaction BEGIN/COMMIT', async () => {
    const pg = new PgMock();
    await pg.ready();
    await pg.query('BEGIN');
    await pg.query("CREATE TABLE t (v TEXT)");
    await pg.query("INSERT INTO t VALUES ('hello')");
    await pg.query('COMMIT');
    const r = await pg.query('SELECT * FROM t');
    expect(r.rows).toHaveLength(1);
  }, 30_000);

  it('reports error for invalid SQL', async () => {
    const pg = new PgMock();
    await pg.ready();
    await expect(pg.query('SELECT * FROM nonexistent_table_xyz')).rejects.toThrow();
  }, 30_000);
});

describe('PG wire protocol', () => {
  it('handler responds to startup', async () => {
    const pg = new PgMock();
    const handler = pg.createHandler();

    // Build startup message
    const parts = [
      Buffer.alloc(4), // length placeholder
      Buffer.alloc(4), // protocol version
      Buffer.from('user\0test\0database\0testdb\0\0'),
    ];
    parts[1].writeInt32BE(196608);
    const startup = Buffer.concat(parts);
    startup.writeInt32BE(startup.length, 0);

    const result = await handler(startup, { remoteHost: 'localhost', remotePort: 5432, socketId: 0 });
    const buf = result as Buffer;
    // Should contain 'R' (auth ok) and 'Z' (ready for query)
    expect(buf[0]).toBe(0x52); // 'R'
    expect(buf.includes(Buffer.from('Z'))).toBe(true);
  });

  it('handler responds to query after startup', async () => {
    const pg = new PgMock();
    pg.seedData('users', [{ id: '1', name: 'Alice' }]);
    const handler = pg.createHandler();
    const ctx2 = { remoteHost: 'localhost', remotePort: 5432, socketId: 2 };

    // Startup
    const startup = Buffer.concat([
      Buffer.alloc(4), Buffer.alloc(4),
      Buffer.from('user\0test\0\0'),
    ]);
    startup.writeInt32BE(196608, 4);
    startup.writeInt32BE(startup.length, 0);
    await handler(startup, ctx2);

    // Wait for PGlite to initialise and seed data to be mirrored
    await pg.ready();

    // Query
    const query = Buffer.from('SELECT * FROM users');
    const qMsg = Buffer.concat([
      Buffer.from('Q'),
      Buffer.alloc(4),
      query, Buffer.from([0]),
    ]);
    qMsg.writeInt32BE(query.length + 5, 1);
    const result = await handler(qMsg, ctx2);
    const buf = result as Buffer;

    // Should contain 'T' (row desc), 'D' (data row), 'C' (command complete), 'Z' (ready)
    const types = [];
    let off = 0;
    while (off < buf.length) {
      types.push(String.fromCharCode(buf[off]));
      const len = buf.readInt32BE(off + 1);
      off += 1 + len;
    }
    expect(types).toContain('T');
    expect(types).toContain('D');
    expect(types).toContain('C');
    expect(types).toContain('Z');
  }, 30_000);
});
