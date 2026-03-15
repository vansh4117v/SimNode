// PG wire protocol v3 encoding helpers
const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s: string): Buffer => Buffer.from(s + '\0', 'utf8');

function pgMsg(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]);
}

export const authOk = (): Buffer => pgMsg('R', int32(0));
export const paramStatus = (k: string, v: string): Buffer => pgMsg('S', Buffer.concat([cstr(k), cstr(v)]));
export const backendKeyData = (): Buffer => pgMsg('K', Buffer.concat([int32(1), int32(1)]));
export const readyForQuery = (s: 'I' | 'T' | 'E'): Buffer => pgMsg('Z', Buffer.from(s));

export function rowDescription(cols: string[]): Buffer {
  const parts: Buffer[] = [int16(cols.length)];
  for (const c of cols) {
    // name, tableOID, colAttrNum, typeOID(text=25), typeSize(-1), typeMod(-1), formatCode(0=text)
    const typeSizeBuf = Buffer.alloc(2);
    typeSizeBuf.writeInt16BE(-1);
    parts.push(cstr(c), int32(0), int16(0), int32(25), typeSizeBuf, int32(-1), int16(0));
  }
  return pgMsg('T', Buffer.concat(parts));
}

export function dataRow(vals: (string | null)[]): Buffer {
  const parts: Buffer[] = [int16(vals.length)];
  for (const v of vals) {
    if (v === null) { parts.push(int32(-1)); }
    else { const b = Buffer.from(v, 'utf8'); parts.push(int32(b.length), b); }
  }
  return pgMsg('D', Buffer.concat(parts));
}

export const commandComplete = (tag: string): Buffer => pgMsg('C', cstr(tag));

export function errorResponse(msg: string, code = '42000'): Buffer {
  return pgMsg('E', Buffer.concat([
    Buffer.from('S'), cstr('ERROR'),
    Buffer.from('C'), cstr(code),
    Buffer.from('M'), cstr(msg),
    Buffer.from([0]),
  ]));
}

export function startupResponse(): Buffer {
  return Buffer.concat([
    authOk(),
    paramStatus('server_version', '15.0'),
    paramStatus('client_encoding', 'UTF8'),
    backendKeyData(),
    readyForQuery('I'),
  ]);
}

export function parseStartupMsg(data: Buffer): { isSSL: boolean } | { user: string; database: string } {
  if (data.length >= 8 && data.readInt32BE(4) === 80877103) return { isSSL: true };
  let off = 8;
  const params: Record<string, string> = {};
  while (off < data.length - 1) {
    const kEnd = data.indexOf(0, off); if (kEnd < 0) break;
    const key = data.toString('utf8', off, kEnd); off = kEnd + 1;
    const vEnd = data.indexOf(0, off); if (vEnd < 0) break;
    params[key] = data.toString('utf8', off, vEnd); off = vEnd + 1;
  }
  return { user: params.user ?? 'unknown', database: params.database ?? 'unknown' };
}

export function parseQueryMsg(data: Buffer): string {
  // 'Q' + Int32 length + query\0
  const nul = data.indexOf(0, 5);
  return data.toString('utf8', 5, nul >= 0 ? nul : data.length);
}
