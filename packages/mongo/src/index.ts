/**
 * @simnode/mongo
 *
 * In-process MongoDB wire-protocol mock backed by a Map-based store.
 * Implements MongoDB wire protocol OP_MSG (opCode 2013) with BSON.
 *
 * Supports: find, insert, update, delete, listCollections, createCollection,
 *           drop, ping, getMore, endSessions, isMaster/hello.
 *
 * Does NOT depend on any external binary or mongodb-memory-server.
 */

import type { TcpMockHandler, TcpMockContext, TcpHandlerResult } from '@simnode/tcp';
import * as net from 'node:net';

export class SimNodeUnsupportedMongoFeature extends Error {
  constructor(detail: string) {
    super(`SimNode: Unsupported MongoDB feature: ${detail}`);
    this.name = 'SimNodeUnsupportedMongoFeature';
  }
}

// ---------------------------------------------------------------------------
// Minimal BSON encoder / decoder (no external dependency)
// ---------------------------------------------------------------------------

type BsonValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | BsonDoc
  | BsonValue[]
  | Buffer
  | bigint;

export type BsonDoc = { [key: string]: BsonValue };

const BSON_FLOAT64    = 0x01;
const BSON_STRING     = 0x02;
const BSON_DOCUMENT   = 0x03;
const BSON_ARRAY      = 0x04;
const BSON_BINARY     = 0x05;
const BSON_BOOLEAN    = 0x08;
const BSON_NULL       = 0x0a;
const BSON_INT32      = 0x10;
const BSON_INT64      = 0x12;

function readCString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.toString('utf8', offset, end), next: end + 1 };
}

function writeCString(buf: Buffer[], str: string): void {
  buf.push(Buffer.from(str, 'utf8'), Buffer.from([0]));
}

export function decodeBson(buf: Buffer, offset = 0): BsonDoc {
  const docLen = buf.readInt32LE(offset);
  const end = offset + docLen;
  let pos = offset + 4;
  const doc: BsonDoc = {};

  while (pos < end - 1) {
    const type = buf[pos++];
    const { value: key, next } = readCString(buf, pos);
    pos = next;

    switch (type) {
      case BSON_FLOAT64: {
        doc[key] = buf.readDoubleLE(pos);
        pos += 8;
        break;
      }
      case BSON_STRING: {
        const strLen = buf.readInt32LE(pos); pos += 4;
        doc[key] = buf.toString('utf8', pos, pos + strLen - 1);
        pos += strLen;
        break;
      }
      case BSON_DOCUMENT: {
        const subLen = buf.readInt32LE(pos);
        doc[key] = decodeBson(buf, pos);
        pos += subLen;
        break;
      }
      case BSON_ARRAY: {
        const arrLen = buf.readInt32LE(pos);
        const arrDoc = decodeBson(buf, pos);
        pos += arrLen;
        // Convert numeric-keyed doc to array
        const maxIdx = Object.keys(arrDoc).length;
        const arr: BsonValue[] = [];
        for (let i = 0; i < maxIdx; i++) arr.push(arrDoc[String(i)] ?? null);
        doc[key] = arr;
        break;
      }
      case BSON_BINARY: {
        const binLen = buf.readInt32LE(pos); pos += 4;
        const _subtype = buf[pos++];
        doc[key] = buf.slice(pos, pos + binLen);
        pos += binLen;
        break;
      }
      case BSON_BOOLEAN: {
        doc[key] = buf[pos++] !== 0;
        break;
      }
      case BSON_NULL: {
        doc[key] = null;
        break;
      }
      case BSON_INT32: {
        doc[key] = buf.readInt32LE(pos); pos += 4;
        break;
      }
      case BSON_INT64: {
        doc[key] = Number(buf.readBigInt64LE(pos)); pos += 8;
        break;
      }
      default:
        // Unknown type — skip rest of document
        pos = end;
    }
  }

  return doc;
}

export function encodeBson(doc: BsonDoc): Buffer {
  const parts: Buffer[] = [];
  for (const [key, val] of Object.entries(doc)) {
    if (val === undefined) continue;
    parts.push(...encodeElement(key, val));
  }
  const body = Buffer.concat(parts);
  const total = 4 + body.length + 1;
  const header = Buffer.alloc(4);
  header.writeInt32LE(total, 0);
  return Buffer.concat([header, body, Buffer.from([0])]);
}

function encodeElement(key: string, val: BsonValue): Buffer[] {
  const keyBuf = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0])]);

  if (val === null || val === undefined) {
    return [Buffer.from([BSON_NULL]), keyBuf];
  }
  if (typeof val === 'boolean') {
    return [Buffer.from([BSON_BOOLEAN]), keyBuf, Buffer.from([val ? 1 : 0])];
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val) && val >= -2147483648 && val <= 2147483647) {
      const b = Buffer.alloc(4); b.writeInt32LE(val, 0);
      return [Buffer.from([BSON_INT32]), keyBuf, b];
    }
    const b = Buffer.alloc(8); b.writeDoubleLE(val, 0);
    return [Buffer.from([BSON_FLOAT64]), keyBuf, b];
  }
  if (typeof val === 'bigint') {
    const b = Buffer.alloc(8); b.writeBigInt64LE(val, 0);
    return [Buffer.from([BSON_INT64]), keyBuf, b];
  }
  if (typeof val === 'string') {
    const strBuf = Buffer.from(val, 'utf8');
    const lenBuf = Buffer.alloc(4); lenBuf.writeInt32LE(strBuf.length + 1, 0);
    return [Buffer.from([BSON_STRING]), keyBuf, lenBuf, strBuf, Buffer.from([0])];
  }
  if (Buffer.isBuffer(val)) {
    const lenBuf = Buffer.alloc(4); lenBuf.writeInt32LE(val.length, 0);
    return [Buffer.from([BSON_BINARY]), keyBuf, lenBuf, Buffer.from([0]), val];
  }
  if (Array.isArray(val)) {
    const arrDoc: BsonDoc = {};
    val.forEach((item, i) => { arrDoc[String(i)] = item as BsonValue; });
    const encoded = encodeBson(arrDoc);
    return [Buffer.from([BSON_ARRAY]), keyBuf, encoded];
  }
  if (typeof val === 'object') {
    const encoded = encodeBson(val as BsonDoc);
    return [Buffer.from([BSON_DOCUMENT]), keyBuf, encoded];
  }
  return [];
}

// ---------------------------------------------------------------------------
// OP_MSG wire protocol parser / builder
// ---------------------------------------------------------------------------

// MongoDB message header: messageLength(4) requestID(4) responseTo(4) opCode(4)
const OP_MSG = 2013;
const OP_REPLY = 1;

interface MsgFrame {
  requestId: number;
  responseTo: number;
  opCode: number;
  body: Buffer;
}

function parseFrame(buf: Buffer): MsgFrame | null {
  if (buf.length < 16) return null;
  const messageLength = buf.readInt32LE(0);
  if (buf.length < messageLength) return null;
  const requestId = buf.readInt32LE(4);
  const responseTo = buf.readInt32LE(8);
  const opCode = buf.readInt32LE(12);
  const body = buf.slice(16, messageLength);
  return { requestId, responseTo, opCode, body };
}

function buildOpMsg(requestId: number, responseTo: number, doc: BsonDoc): Buffer {
  const bson = encodeBson(doc);
  // flagBits(4) + section kind(1) + bson
  const flagBits = Buffer.alloc(4); // 0 = no special flags
  const sectionKind = Buffer.from([0]); // kind 0 = body
  const body = Buffer.concat([flagBits, sectionKind, bson]);
  const msgLen = 16 + body.length;
  const header = Buffer.alloc(16);
  header.writeInt32LE(msgLen, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_MSG, 12);
  return Buffer.concat([header, body]);
}

function buildOpReply(responseTo: number, doc: BsonDoc): Buffer {
  const bson = encodeBson(doc);
  // flags(4) cursorID(8) startingFrom(4) numberReturned(4) documents...
  const replyHeader = Buffer.alloc(20);
  replyHeader.writeInt32LE(0, 0); // flags
  replyHeader.writeBigInt64LE(0n, 4); // cursorID
  replyHeader.writeInt32LE(0, 12); // startingFrom
  replyHeader.writeInt32LE(1, 16); // numberReturned
  const body = Buffer.concat([replyHeader, bson]);
  const msgLen = 16 + body.length;
  const header = Buffer.alloc(16);
  header.writeInt32LE(msgLen, 0);
  header.writeInt32LE(1, 4); // requestId
  header.writeInt32LE(responseTo, 8);
  header.writeInt32LE(OP_REPLY, 12);
  return Buffer.concat([header, body]);
}

function parseOpMsg(body: Buffer): BsonDoc {
  // skip flagBits(4) + sectionKind(1)
  const bsonStart = 5;
  return decodeBson(body, bsonStart);
}

// Legacy OP_QUERY (opCode 2004) — used by old drivers for initial handshake
const OP_QUERY = 2004;
function parseOpQuery(body: Buffer): { collection: string; query: BsonDoc } {
  // flags(4) + cstring(collectionName) + numberToSkip(4) + numberToReturn(4) + query(bson)
  let pos = 4; // skip flags
  const { value: ns, next } = readCString(body, pos);
  pos = next;
  pos += 8; // skip numberToSkip + numberToReturn
  const query = decodeBson(body, pos);
  return { collection: ns, query };
}

// ---------------------------------------------------------------------------
// MongoMock options
// ---------------------------------------------------------------------------

export interface MongoMockOpts {
  /** Hostname of the shared MongoMemoryServer (provided by Simulation.run()). */
  mongoHost?: string;
  /** Port of the shared MongoMemoryServer. */
  mongoPort?: number;
  /** Per-scenario database name (e.g. sim_db_42). */
  mongoDbName?: string;
}

// ---------------------------------------------------------------------------
// MongoProxyConnection — per-client-connection TCP proxy to real mongod
// ---------------------------------------------------------------------------


/** A pending upstream request waiting for its response. */
interface PendingResponse {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

/**
 * One proxy connection to the real mongod process.
 * Incoming bytes are forwarded verbatim; responses are reassembled from the
 * MongoDB wire-protocol framing (first 4 bytes = LE message length) and
 * delivered back to the caller as Promises so the scheduler can inject
 * virtual latency before the bytes are handed to the simulated client.
 */
class MongoProxyConnection {
  private _upstream: net.Socket;
  private _recvBuf  = Buffer.alloc(0);
  private _pending: PendingResponse[] = [];
  private _closed   = false;

  constructor(
    host: string,
    port: number,
    /** Real (pre-patch) net.createConnection so we bypass the TcpInterceptor. */
    realConnect: (port: number, host: string) => net.Socket,
  ) {
    this._upstream = realConnect(port, host);
    this._upstream.on('data',  (chunk: Buffer) => this._onData(chunk));
    this._upstream.on('error', (err: Error)    => this._onError(err));
    this._upstream.on('close', ()              => { this._closed = true; this._onError(new Error('mongod connection closed')); });
  }

  async send(data: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this._closed) { reject(new Error('mongod connection closed')); return; }
      this._pending.push({ resolve, reject });
      this._upstream.write(data);
    });
  }

  destroy(): void {
    this._closed = true;
    this._upstream.destroy();
  }

  private _onData(chunk: Buffer): void {
    this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
    // Drain complete MongoDB frames (framed by first 4 bytes = LE message length)
    while (this._recvBuf.length >= 4) {
      const msgLen = this._recvBuf.readInt32LE(0);
      if (this._recvBuf.length < msgLen) break;
      const frame = this._recvBuf.slice(0, msgLen);
      this._recvBuf  = this._recvBuf.slice(msgLen);
      const waiter  = this._pending.shift();
      if (waiter) waiter.resolve(frame);
    }
  }

  private _onError(err: Error): void {
    for (const w of this._pending) w.reject(err);
    this._pending = [];
  }
}

// ---------------------------------------------------------------------------
// MongoMock — public API
// ---------------------------------------------------------------------------

export class MongoMock {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _dbName: string;
  private _proxies = new Map<number, MongoProxyConnection>();
  /** Captured before TcpInterceptor patches net.createConnection. */
  private _realConnect: (port: number, host: string) => net.Socket;
  /** Lazily created MongoClient for assertion methods (find, drop). */
  private _clientPromise: Promise<import('mongodb').MongoClient> | null = null;

  constructor(opts?: MongoMockOpts) {
    this._host   = opts?.mongoHost   ?? '127.0.0.1';
    this._port   = opts?.mongoPort   ?? 27017;
    this._dbName = opts?.mongoDbName ?? 'test';
    // Capture REAL net.createConnection before TcpInterceptor patches it.
    this._realConnect = net.createConnection.bind(net) as unknown as (port: number, host: string) => net.Socket;
  }

  // ── Assertion API ───────────────────────────────────────────────────────────

  /**
   * Query the scenario's MongoDB database directly via the driver.
   * Returns plain objects (EJSON-decoded by the driver).
   */
  async find(collection: string, filter: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const client = await this._getClient();
    return client.db(this._dbName).collection(collection).find(filter).toArray() as Promise<Record<string, unknown>[]>;
  }

  /**
   * Drop the scenario's database and close the driver connection.
   * Called in the worker's finally block for clean isolation.
   */
  async drop(): Promise<void> {
    if (!this._clientPromise) return;
    try {
      const client = await this._clientPromise;
      await client.db(this._dbName).dropDatabase();
      await client.close();
    } catch { /* ignore if db was never used */ }
    this._clientPromise = null;
    for (const p of this._proxies.values()) p.destroy();
    this._proxies.clear();
  }

  // ── TCP handler ─────────────────────────────────────────────────────────────

  /**
   * Returns a TcpMockHandler that proxies raw MongoDB wire-protocol bytes to
   * the shared mongod.  Latency injection is handled by TcpInterceptor.
   */
  createHandler(): TcpMockHandler {
    return async (data: Buffer, ctx: TcpMockContext): Promise<TcpHandlerResult> => {
      if (!this._proxies.has(ctx.socketId)) {
        this._proxies.set(
          ctx.socketId,
          new MongoProxyConnection(this._host, this._port, this._realConnect),
        );
      }
      const proxy = this._proxies.get(ctx.socketId)!;
      try {
        return await proxy.send(data);
      } catch {
        return null;
      }
    };
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _getClient(): Promise<import('mongodb').MongoClient> {
    if (!this._clientPromise) {
      this._clientPromise = import('mongodb').then(({ MongoClient }) =>
        MongoClient.connect(`mongodb://${this._host}:${this._port}`),
      );
    }
    return this._clientPromise;
  }
}
