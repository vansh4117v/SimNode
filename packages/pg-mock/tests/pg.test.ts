import { describe, it, expect } from 'vitest';
import { PgMock, SimNodeUnsupportedPGFeature, proto } from '../src/index.js';

describe('PgStore SQL execution', () => {
  it('SELECT literal', () => {
    const pg = new PgMock();
    const r = pg.store.execSQL('SELECT 1');
    expect(r.tag).toBe('SELECT 1');
    expect(r.columns).toEqual(['?column?']);
    expect(r.rows).toEqual([['1']]);
  });

  it('SELECT from seeded table', () => {
    const pg = new PgMock();
    pg.seedData('users', [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
    const r = pg.store.execSQL('SELECT id, name FROM users');
    expect(r.tag).toBe('SELECT 2');
    expect(r.columns).toEqual(['id', 'name']);
    expect(r.rows).toEqual([['1', 'Alice'], ['2', 'Bob']]);
  });

  it('SELECT with WHERE', () => {
    const pg = new PgMock();
    pg.seedData('users', [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]);
    const r = pg.store.execSQL("SELECT name FROM users WHERE id = 1");
    expect(r.rows).toEqual([['Alice']]);
  });

  it('INSERT adds row', () => {
    const pg = new PgMock();
    pg.seedData('users', []);
    const r = pg.store.execSQL("INSERT INTO users (id, name) VALUES (1, 'Carol')");
    expect(r.tag).toBe('INSERT 0 1');
    const q = pg.store.execSQL('SELECT * FROM users');
    expect(q.rows).toHaveLength(1);
  });

  it('UPDATE modifies row', () => {
    const pg = new PgMock();
    pg.seedData('accounts', [{ id: '1', balance: '100' }]);
    pg.store.execSQL("UPDATE accounts SET balance = 0 WHERE id = 1");
    const q = pg.store.execSQL('SELECT balance FROM accounts WHERE id = 1');
    expect(q.rows).toEqual([['0']]);
  });

  it('DELETE removes row', () => {
    const pg = new PgMock();
    pg.seedData('users', [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]);
    pg.store.execSQL("DELETE FROM users WHERE id = 1");
    const q = pg.store.execSQL('SELECT * FROM users');
    expect(q.rows).toHaveLength(1);
  });

  it('BEGIN/COMMIT/ROLLBACK', () => {
    const pg = new PgMock();
    expect(pg.store.execSQL('BEGIN').tag).toBe('BEGIN');
    expect(pg.store.execSQL('COMMIT').tag).toBe('COMMIT');
    expect(pg.store.execSQL('ROLLBACK').tag).toBe('ROLLBACK');
  });

  it('throws SimNodeUnsupportedPGFeature for unknown SQL', () => {
    const pg = new PgMock();
    expect(() => pg.store.execSQL('CREATE TABLE foo (id INT)')).toThrow(SimNodeUnsupportedPGFeature);
  });
});

describe('PG wire protocol', () => {
  it('handler responds to startup', () => {
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

    const result = handler(startup, { remoteHost: 'localhost', remotePort: 5432, socketId: 0 });
    const buf = Buffer.isBuffer(result) ? result : Buffer.concat(result as Buffer[]);
    // Should contain 'R' (auth ok) and 'Z' (ready for query)
    expect(buf[0]).toBe(0x52); // 'R'
    expect(buf.includes(Buffer.from('Z'))).toBe(true);
  });

  it('handler responds to query after startup', () => {
    const pg = new PgMock();
    pg.seedData('users', [{ id: '1', name: 'Alice' }]);
    const handler = pg.createHandler();

    // Startup
    const startup = Buffer.concat([
      Buffer.alloc(4), Buffer.alloc(4),
      Buffer.from('user\0test\0\0'),
    ]);
    startup.writeInt32BE(196608, 4);
    startup.writeInt32BE(startup.length, 0);
    handler(startup, { remoteHost: 'localhost', remotePort: 5432, socketId: 1 });

    // Query
    const query = Buffer.from('SELECT * FROM users');
    const qMsg = Buffer.concat([
      Buffer.from('Q'),
      Buffer.alloc(4),
      query, Buffer.from([0]),
    ]);
    qMsg.writeInt32BE(query.length + 5, 1);
    const result = handler(qMsg, { remoteHost: 'localhost', remotePort: 5432, socketId: 1 });
    const buf = Buffer.isBuffer(result) ? result : Buffer.concat(result as Buffer[]);

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
  });
});
