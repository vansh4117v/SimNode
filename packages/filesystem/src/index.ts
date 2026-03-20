import { createRequire } from 'node:module';
import * as path from 'node:path';
import { normalizePath } from './internalPaths.js';
import { Volume, createFsFromVolume } from 'memfs';

const _require = createRequire(import.meta.url);
const fsCjs = _require('node:fs') as typeof import('node:fs');

interface InjectedError { error: string; code: string; after?: number }

/** Minimal virtual clock interface for stat timestamps. */
interface IClock { now(): number; }

export class VirtualFS {
  private _vol = new Volume();
  private _injections = new Map<string, InjectedError>();
  private _writeCount = new Map<string, number>();
  private _originals: Record<string, unknown> = {};
  private _promiseOriginals: Record<string, unknown> = {};
  private readonly _clock?: IClock;

  constructor(opts?: { clock?: IClock }) {
    this._clock = opts?.clock;
  }

  // ── public API (unchanged) ──────────────────────────────────────────────

  seed(files: Record<string, string | Buffer>): void {
    for (const [p, content] of Object.entries(files)) {
      const norm = normalizePath(p);
      // Ensure parent dirs exist
      const dir = path.dirname(norm);
      this._vol.mkdirSync(dir, { recursive: true });
      this._vol.writeFileSync(norm, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
  }

  inject(filePath: string, opts: { error: string; code?: string; after?: number }): void {
    this._injections.set(normalizePath(filePath), { error: opts.error, code: opts.code ?? 'EIO', after: opts.after });
  }

  // ── install / uninstall ─────────────────────────────────────────────────

  install(): void {
    const memFsCjs = createFsFromVolume(this._vol) as any;

    // Snapshot every writable property on the real fs module
    for (const key of Object.keys(fsCjs)) {
      if (key === 'promises') continue;
      const desc = Object.getOwnPropertyDescriptor(fsCjs, key);
      if (desc && (desc.writable || desc.set || desc.configurable)) {
        this._originals[key] = (fsCjs as any)[key];
      }
    }

    // Snapshot promises sub-object
    if (fsCjs.promises) {
      for (const key of Object.keys(fsCjs.promises)) {
        const desc = Object.getOwnPropertyDescriptor(fsCjs.promises, key);
        if (desc && (desc.writable || desc.set || desc.configurable)) {
          this._promiseOriginals[key] = (fsCjs.promises as any)[key];
        }
      }
    }

    // Overwrite fs properties with memfs counterparts (skip non-writable)
    for (const key of Object.keys(memFsCjs)) {
      if (key === 'promises') continue;
      if (typeof memFsCjs[key] !== 'function') continue;
      if (!(key in this._originals)) continue; // skip if we couldn't snapshot it
      try { (fsCjs as any)[key] = memFsCjs[key]; } catch { /* skip read-only */ }
    }

    // Overwrite fs.promises
    if (fsCjs.promises && memFsCjs.promises) {
      for (const key of Object.keys(memFsCjs.promises)) {
        if (!(key in this._promiseOriginals)) continue;
        try { (fsCjs.promises as any)[key] = memFsCjs.promises[key]; } catch { /* skip read-only */ }
      }
    }

    // Wrap path-accepting functions with normalization + injection checks
    this._wrapInjections();
    this._wrapPathNormalization();
  }

  uninstall(): void {
    for (const [key, orig] of Object.entries(this._originals)) {
      try { (fsCjs as any)[key] = orig; } catch { /* skip read-only */ }
    }
    if (fsCjs.promises) {
      for (const [key, orig] of Object.entries(this._promiseOriginals)) {
        try { (fsCjs.promises as any)[key] = orig; } catch { /* skip read-only */ }
      }
    }
    this._originals = {};
    this._promiseOriginals = {};
  }

  reset(): void {
    // Recreate volume (clears all data)
    const wasInstalled = Object.keys(this._originals).length > 0;
    this._vol = new Volume();
    this._injections.clear();
    this._writeCount.clear();
    // If currently installed, re-install to pick up new volume
    if (wasInstalled) {
      // Restore originals first so install() snapshots correctly
      this.uninstall();
      this.install();
    }
  }

  // ── private ─────────────────────────────────────────────────────────────

  private _checkInjection(p: string, op: 'read' | 'write'): void {
    const norm = normalizePath(p);
    const inj = this._injections.get(norm);
    if (!inj) return;
    if (op === 'write') {
      const count = (this._writeCount.get(norm) ?? 0) + 1;
      this._writeCount.set(norm, count);
      if (inj.after !== undefined && count <= inj.after) return;
    }
    const err = new Error(inj.error) as NodeJS.ErrnoException;
    err.code = inj.code;
    err.errno = -1;
    throw err;
  }

  /**
   * Wrap common path-accepting fs functions with normalizePath()
   * so that Windows-style backslash paths work with memfs.
   */
  private _wrapPathNormalization(): void {
    const originals = this._originals;

    // Helper: normalize + fallback to real fs on ENOENT for read-only sync ops
    const wrapReadSync = (memFn: Function, realFn: Function | undefined) => function (p: any, ...args: any[]) {
      const norm = (typeof p === 'string') ? normalizePath(p) : p;
      try {
        return memFn(norm, ...args);
      } catch (e: any) {
        if (e?.code === 'ENOENT' && realFn) return realFn(p, ...args);
        throw e;
      }
    };
    // Normalize only (write ops — no fallback)
    const wrapWrite = (fn: Function) => function (p: any, ...args: any[]) {
      const norm = (typeof p === 'string') ? normalizePath(p) : p;
      return fn(norm, ...args);
    };
    const wrap2 = (fn: Function) => function (p1: any, p2: any, ...args: any[]) {
      const n1 = (typeof p1 === 'string') ? normalizePath(p1) : p1;
      const n2 = (typeof p2 === 'string') ? normalizePath(p2) : p2;
      return fn(n1, n2, ...args);
    };

    // Read-only sync ops: normalize + fallback to real fs
    const readSyncNames = ['statSync', 'lstatSync', 'accessSync', 'readdirSync'] as const;
    for (const name of readSyncNames) {
      const memFn = (fsCjs as any)[name];
      if (typeof memFn === 'function') {
        (fsCjs as any)[name] = wrapReadSync(memFn, originals[name] as Function | undefined);
      }
    }

    // existsSync: special — returns false instead of throwing
    const memExistsSync = (fsCjs as any).existsSync;
    const realExistsSync = originals['existsSync'] as Function | undefined;
    if (typeof memExistsSync === 'function') {
      (fsCjs as any).existsSync = function (p: any) {
        const norm = (typeof p === 'string') ? normalizePath(p) : p;
        const memResult = memExistsSync(norm);
        if (memResult) return true;
        return realExistsSync ? realExistsSync(p) : false;
      };
    }

    // Write-only sync ops: normalize only
    const writeSyncNames = ['unlinkSync', 'mkdirSync', 'chmodSync', 'rmSync', 'rmdirSync'] as const;
    for (const name of writeSyncNames) {
      const memFn = (fsCjs as any)[name];
      if (typeof memFn === 'function') (fsCjs as any)[name] = wrapWrite(memFn);
    }
    const origRenameSync = (fsCjs as any).renameSync;
    if (typeof origRenameSync === 'function') (fsCjs as any).renameSync = wrap2(origRenameSync);

    // Async callback variants: read ops with fallback
    const readAsyncNames = ['stat', 'lstat', 'access', 'readdir'] as const;
    for (const name of readAsyncNames) {
      const memFn = (fsCjs as any)[name];
      const realFn = originals[name] as Function | undefined;
      if (typeof memFn === 'function') {
        (fsCjs as any)[name] = function (p: any, ...args: any[]) {
          const norm = (typeof p === 'string') ? normalizePath(p) : p;
          const cb = args[args.length - 1];
          const innerArgs = args.slice(0, -1);
          memFn(norm, ...innerArgs, (err: any, ...results: any[]) => {
            if (err?.code === 'ENOENT' && realFn) return realFn(p, ...args);
            cb(err, ...results);
          });
        };
      }
    }

    // Async callback variants: write ops (normalize only)
    const writeAsyncNames = ['unlink', 'mkdir', 'chmod', 'rm', 'rmdir'] as const;
    for (const name of writeAsyncNames) {
      const memFn = (fsCjs as any)[name];
      if (typeof memFn === 'function') (fsCjs as any)[name] = wrapWrite(memFn);
    }
    const origRename = (fsCjs as any).rename;
    if (typeof origRename === 'function') (fsCjs as any).rename = wrap2(origRename);
  }

  /**
   * Wrap the already-installed memfs readFileSync / writeFileSync /
   * appendFileSync with injection-check proxies so that inject() works.
   */
  private _wrapInjections(): void {
    const self = this;
    const memReadFileSync = (fsCjs as any).readFileSync;
    const memWriteFileSync = (fsCjs as any).writeFileSync;
    const memAppendFileSync = (fsCjs as any).appendFileSync;

    const realReadFileSync = self._originals['readFileSync'] as Function | undefined;
    (fsCjs as any).readFileSync = function (p: any, opts?: any) {
      const norm = (typeof p === 'string') ? normalizePath(p) : p;
      if (typeof p === 'string') self._checkInjection(String(p), 'read');
      try {
        return memReadFileSync(norm, opts);
      } catch (e: any) {
        if (e?.code === 'ENOENT' && realReadFileSync) return realReadFileSync(p, opts);
        throw e;
      }
    };

    (fsCjs as any).writeFileSync = function (p: any, data: any, opts?: any) {
      const norm = (typeof p === 'string') ? normalizePath(p) : p;
      if (typeof p === 'string') self._checkInjection(String(p), 'write');
      // Auto-create parent dirs (memfs requires them to exist)
      if (typeof norm === 'string') {
        const dir = path.dirname(norm);
        try { self._vol.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
      }
      return memWriteFileSync(norm, data, opts);
    };

    (fsCjs as any).appendFileSync = function (p: any, data: any, opts?: any) {
      const norm = (typeof p === 'string') ? normalizePath(p) : p;
      if (typeof p === 'string') self._checkInjection(String(p), 'write');
      if (typeof norm === 'string') {
        const dir = path.dirname(norm);
        try { self._vol.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
      }
      return memAppendFileSync(norm, data, opts);
    };

    // Also wrap async readFile / writeFile so injection checks apply
    const memReadFile = (fsCjs as any).readFile;
    const memWriteFile = (fsCjs as any).writeFile;
    const memAppendFile = (fsCjs as any).appendFile;

    const realReadFile = self._originals['readFile'] as Function | undefined;
    (fsCjs as any).readFile = function (p: any, ...args: any[]) {
      if (typeof p === 'string' || (p instanceof URL) || Buffer.isBuffer(p)) {
        try { self._checkInjection(String(p), 'read'); }
        catch (e) { const cb = args[args.length - 1]; if (typeof cb === 'function') return cb(e); throw e; }
      }
      const norm = (typeof p === 'string') ? normalizePath(p) : p;
      const cb = args[args.length - 1];
      const innerArgs = args.slice(0, -1);
      memReadFile(norm, ...innerArgs, (err: any, ...results: any[]) => {
        if (err?.code === 'ENOENT' && realReadFile) return realReadFile(p, ...args);
        if (typeof cb === 'function') cb(err, ...results);
      });
    };

    (fsCjs as any).writeFile = function (p: any, data: any, ...args: any[]) {
      if (typeof p === 'string' || (p instanceof URL) || Buffer.isBuffer(p)) {
        try { self._checkInjection(String(p), 'write'); }
        catch (e) { const cb = args[args.length - 1]; if (typeof cb === 'function') return cb(e); throw e; }
      }
      return memWriteFile(p, data, ...args);
    };

    (fsCjs as any).appendFile = function (p: any, data: any, ...args: any[]) {
      if (typeof p === 'string' || (p instanceof URL) || Buffer.isBuffer(p)) {
        try { self._checkInjection(String(p), 'write'); }
        catch (e) { const cb = args[args.length - 1]; if (typeof cb === 'function') return cb(e); throw e; }
      }
      return memAppendFile(p, data, ...args);
    };

    // Wrap promises for injection checks
    if (fsCjs.promises) {
      const memPReadFile = (fsCjs.promises as any).readFile;
      const memPWriteFile = (fsCjs.promises as any).writeFile;
      const memPAppendFile = (fsCjs.promises as any).appendFile;

      const realPReadFile = self._promiseOriginals['readFile'] as Function | undefined;
      (fsCjs.promises as any).readFile = async (p: any, opts?: any) => {
        if (typeof p === 'string' || (p instanceof URL) || Buffer.isBuffer(p)) {
          self._checkInjection(String(p), 'read');
        }
        const norm = (typeof p === 'string') ? normalizePath(p) : p;
        try {
          return await memPReadFile(norm, opts);
        } catch (e: any) {
          if (e?.code === 'ENOENT' && realPReadFile) return realPReadFile(p, opts);
          throw e;
        }
      };

      (fsCjs.promises as any).writeFile = (p: any, data: any, opts?: any) => {
        if (typeof p === 'string' || (p instanceof URL) || Buffer.isBuffer(p)) {
          try { self._checkInjection(String(p), 'write'); }
          catch (e) { return Promise.reject(e); }
        }
        return memPWriteFile(p, data, opts);
      };

      (fsCjs.promises as any).appendFile = (p: any, data: any, opts?: any) => {
        if (typeof p === 'string' || (p instanceof URL) || Buffer.isBuffer(p)) {
          try { self._checkInjection(String(p), 'write'); }
          catch (e) { return Promise.reject(e); }
        }
        return memPAppendFile(p, data, opts);
      };
    }
  }
}
