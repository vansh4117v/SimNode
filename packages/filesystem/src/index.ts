import { createRequire } from 'node:module';
import * as path from 'node:path';
import { normalizePath } from './internalPaths.js';

const _require = createRequire(import.meta.url);
const fsCjs = _require('node:fs') as typeof import('node:fs');

interface VFSEntry { content: Buffer; isDir: boolean }
interface InjectedError { error: string; code: string; after?: number }

interface FileDescriptor {
  id: number;
  normPath: string;
  position: number;
  flags: string;
}

/** Minimal virtual clock interface for stat timestamps. */
interface IClock { now(): number; }

export class VirtualFS {
  private _store = new Map<string, VFSEntry>();
  private _injections = new Map<string, InjectedError>();
  private _originals: Record<string, unknown> = {};
  private _writeCount = new Map<string, number>();

  private _fdTable = new Map<number, FileDescriptor>();
  private _nextFd = 1000;

  private readonly _clock?: IClock;

  constructor(opts?: { clock?: IClock }) {
    this._clock = opts?.clock;
  }

  seed(files: Record<string, string | Buffer>): void {
    for (const [p, content] of Object.entries(files)) {
      const norm = normalizePath(p);
      this._store.set(norm, { content: Buffer.isBuffer(content) ? content : Buffer.from(content), isDir: false });
      // Ensure parent dirs exist
      let dir = path.dirname(norm);
      while (dir && dir !== path.dirname(dir)) {
        if (!this._store.has(dir)) this._store.set(dir, { content: Buffer.alloc(0), isDir: true });
        dir = path.dirname(dir);
      }
    }
  }

  inject(filePath: string, opts: { error: string; code?: string; after?: number }): void {
    this._injections.set(normalizePath(filePath), { error: opts.error, code: opts.code ?? 'EIO', after: opts.after });
  }

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

  private _clockNow(): number {
    return this._clock?.now() ?? 0;
  }

  private _getStat(norm: string) {
      const entry = this._store.get(norm);
      if (!entry) {
        const err = new Error(`ENOENT: no such file or directory, stat '${norm}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const ts = this._clockNow();
      const d = new Date(ts);
      return {
        isFile: () => !entry.isDir,
        isDirectory: () => entry.isDir,
        isSymbolicLink: () => false,
        size: entry.content.length,
        mtimeMs: ts,
        mtime: d,
        atimeMs: ts,
        atime: d,
        ctimeMs: ts,
        ctime: d,
        birthtimeMs: ts,
        birthtime: d,
        mode: entry.isDir ? 0o755 : 0o644,
        nlink: 1,
        uid: 0,
        gid: 0,
        dev: 1,
        ino: 0,
        rdev: 0,
        blksize: 4096,
        blocks: Math.ceil(entry.content.length / 512),
      };
  }

  install(): void {
    const self = this;

    // Save originals
    const origNames = [
      'readFileSync', 'writeFileSync', 'appendFileSync',
      'existsSync', 'mkdirSync', 'readdirSync',
      'unlinkSync', 'statSync', 'openSync', 'closeSync',
      'fstatSync', 'readSync', 'writeSync',
      'accessSync', 'renameSync', 'chmodSync',
      'readFile', 'writeFile', 'appendFile',
      'open', 'close', 'fstat', 'stat',
      'access', 'rename', 'chmod',
    ];
    for (const k of origNames) {
        if (k in fsCjs) this._originals[k] = (fsCjs as any)[k];
    }

    if (fsCjs.promises) {
        this._originals['promises.readFile'] = fsCjs.promises.readFile;
        this._originals['promises.writeFile'] = fsCjs.promises.writeFile;
        this._originals['promises.appendFile'] = (fsCjs.promises as any).appendFile;
        this._originals['promises.open'] = fsCjs.promises.open;
        this._originals['promises.stat'] = fsCjs.promises.stat;
        this._originals['promises.access'] = (fsCjs.promises as any).access;
        this._originals['promises.rename'] = (fsCjs.promises as any).rename;
        this._originals['promises.chmod'] = (fsCjs.promises as any).chmod;
    }

    // --- SYNC VARIANTS --- //

    (fsCjs as any).readFileSync = function (p: string | Buffer | URL | number, opts?: any): string | Buffer {
      if (typeof p === 'number') {
        const fd = self._fdTable.get(p);
        if (!fd) throw new Error('EBADF: bad file descriptor');
        p = fd.normPath;
      }
      const norm = normalizePath(String(p));
      self._checkInjection(norm, 'read');
      const entry = self._store.get(norm);
      if (!entry || entry.isDir) {
        const err = new Error(`ENOENT: no such file: '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
      if (opts?.encoding || typeof opts === 'string') return entry.content.toString(typeof opts === 'string' ? opts : opts.encoding);
      return Buffer.from(entry.content);
    };

    (fsCjs as any).writeFileSync = function (p: string | Buffer | URL | number, data: string | Buffer): void {
      if (typeof p === 'number') {
        const fd = self._fdTable.get(p);
        if (!fd) throw new Error('EBADF: bad file descriptor');
        p = fd.normPath;
      }
      const norm = normalizePath(String(p));
      self._checkInjection(norm, 'write');
      self._store.set(norm, { content: Buffer.isBuffer(data) ? data : Buffer.from(data), isDir: false });
    };

    (fsCjs as any).appendFileSync = function (p: string | Buffer | URL | number, data: string | Buffer, _opts?: any): void {
      if (typeof p === 'number') {
        const fd = self._fdTable.get(p);
        if (!fd) throw new Error('EBADF: bad file descriptor');
        p = fd.normPath;
      }
      const norm = normalizePath(String(p));
      self._checkInjection(norm, 'write');
      const existing = self._store.get(norm);
      const existing_content = (existing && !existing.isDir) ? existing.content : Buffer.alloc(0);
      const newData = Buffer.isBuffer(data) ? data : Buffer.from(data);
      self._store.set(norm, { content: Buffer.concat([existing_content, newData]), isDir: false });
    };

    (fsCjs as any).existsSync = function (p: string): boolean {
      return self._store.has(normalizePath(String(p)));
    };

    (fsCjs as any).mkdirSync = function (p: string, opts?: any): void {
      const norm = normalizePath(String(p));
      if (opts?.recursive) {
        // Create all parent directories
        let dir = norm;
        const dirs: string[] = [];
        while (dir && dir !== path.dirname(dir)) {
          dirs.unshift(dir);
          dir = path.dirname(dir);
        }
        for (const d of dirs) {
          if (!self._store.has(d)) self._store.set(d, { content: Buffer.alloc(0), isDir: true });
        }
      } else {
        self._store.set(norm, { content: Buffer.alloc(0), isDir: true });
      }
    };

    (fsCjs as any).readdirSync = function (p: string): string[] {
      const norm = normalizePath(String(p));
      const result: string[] = [];
      for (const key of self._store.keys()) {
        if (path.dirname(key) === norm && key !== norm) result.push(path.basename(key));
      }
      return result;
    };

    (fsCjs as any).unlinkSync = function (p: string): void {
      const norm = normalizePath(String(p));
      if (!self._store.delete(norm)) {
        const err = new Error(`ENOENT: '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
    };

    (fsCjs as any).statSync = function (p: string): any {
      const norm = normalizePath(String(p));
      return self._getStat(norm);
    };

    (fsCjs as any).accessSync = function (p: string, _mode?: number): void {
      const norm = normalizePath(String(p));
      if (!self._store.has(norm)) {
        const err = new Error(`ENOENT: no such file or directory, access '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
      // No permission model — always accessible
    };

    (fsCjs as any).renameSync = function (oldPath: string, newPath: string): void {
      const oldNorm = normalizePath(String(oldPath));
      const newNorm = normalizePath(String(newPath));
      const entry = self._store.get(oldNorm);
      if (!entry) {
        const err = new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT'; throw err;
      }
      self._store.delete(oldNorm);
      self._store.set(newNorm, entry);
    };

    (fsCjs as any).chmodSync = function (_p: string, _mode: string | number): void {
      // Virtual FS has no permission model — no-op
    };

    // FD table abstractions
    (fsCjs as any).openSync = function (p: string, flags: string, mode?: any): number {
        const norm = normalizePath(String(p));
        const entry = self._store.get(norm);

        const isWrite = flags.includes('w') || flags.includes('a');

        if (!entry && !isWrite) {
            const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
            err.code = 'ENOENT'; throw err;
        }

        if (!entry && isWrite) {
            self._store.set(norm, { content: Buffer.alloc(0), isDir: false });
        } else if (entry && flags.includes('w')) {
            // truncate
            entry.content = Buffer.alloc(0);
        }

        const fd = self._nextFd++;
        self._fdTable.set(fd, { id: fd, normPath: norm, position: 0, flags });
        return fd;
    };

    (fsCjs as any).closeSync = function (fd: number): void {
        if (!self._fdTable.has(fd)) {
            const err = new Error(`EBADF: bad file descriptor, close`) as NodeJS.ErrnoException;
            err.code = 'EBADF'; throw err;
        }
        self._fdTable.delete(fd);
    };

    (fsCjs as any).fstatSync = function (fd: number): any {
        const fdObj = self._fdTable.get(fd);
        if (!fdObj) {
           const err = new Error(`EBADF: bad file descriptor, fstat`) as NodeJS.ErrnoException;
           err.code = 'EBADF'; throw err;
        }
        return self._getStat(fdObj.normPath);
    };

    // --- CALLBACK VARIANTS --- //

    (fsCjs as any).readFile = function (p: any, opts: any, cb: any): void {
        const callback = cb || opts;
        const options = typeof opts === 'function' ? null : opts;
        queueMicrotask(() => {
            try {
                const res = fsCjs.readFileSync(p, options);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).writeFile = function (p: any, data: any, opts: any, cb: any): void {
        const callback = cb || opts;
        queueMicrotask(() => {
            try {
                fsCjs.writeFileSync(p, data);
                callback(null);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).appendFile = function (p: any, data: any, opts: any, cb: any): void {
        const callback = cb || opts;
        queueMicrotask(() => {
            try {
                (fsCjs as any).appendFileSync(p, data);
                callback(null);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).stat = function (p: any, opts: any, cb: any): void {
        const callback = cb || opts;
        queueMicrotask(() => {
            try {
                const res = fsCjs.statSync(p);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).open = function (p: any, flags: any, mode: any, cb: any): void {
        const callback = cb || mode || flags;
        const f = typeof flags === 'function' ? 'r' : flags;
        queueMicrotask(() => {
            try {
                const res = fsCjs.openSync(p, f);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).close = function (fd: number, cb: any): void {
         queueMicrotask(() => {
          try {
              fsCjs.closeSync(fd);
              if (cb) cb(null);
          } catch(e) {
              if (cb) cb(e);
          }
       });
    };

    (fsCjs as any).fstat = function (fd: number, opts: any, cb: any): void {
        const callback = cb || opts;
        queueMicrotask(() => {
            try {
                const res = fsCjs.fstatSync(fd);
                callback(null, res);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).access = function (p: any, mode: any, cb: any): void {
        const callback = cb || mode;
        queueMicrotask(() => {
            try {
                (fsCjs as any).accessSync(p);
                callback(null);
            } catch(e) {
                callback(e);
            }
        });
    };

    (fsCjs as any).rename = function (oldPath: any, newPath: any, cb: any): void {
        queueMicrotask(() => {
            try {
                (fsCjs as any).renameSync(oldPath, newPath);
                cb(null);
            } catch(e) {
                cb(e);
            }
        });
    };

    (fsCjs as any).chmod = function (p: any, mode: any, cb: any): void {
        queueMicrotask(() => {
            cb(null); // no-op
        });
    };

    // --- PROMISES --- //

    if (fsCjs.promises) {
        (fsCjs.promises as any).readFile = function(p: any, opts: any) {
            return new Promise((resolve, reject) => {
                fsCjs.readFile(p, opts, (err: any, data: any) => err ? reject(err) : resolve(data));
            });
        };
        (fsCjs.promises as any).writeFile = function(p: any, data: any, opts: any) {
            return new Promise((resolve, reject) => {
                fsCjs.writeFile(p, data, opts, (err: any) => err ? reject(err) : resolve(undefined));
            });
        };
        (fsCjs.promises as any).appendFile = function(p: any, data: any, opts: any) {
            return new Promise((resolve, reject) => {
                (fsCjs as any).appendFile(p, data, opts, (err: any) => err ? reject(err) : resolve(undefined));
            });
        };
        (fsCjs.promises as any).stat = function(p: any, opts?: any) {
            return new Promise((resolve, reject) => {
                fsCjs.stat(p, opts, (err: any, data: any) => err ? reject(err) : resolve(data));
            });
        };
        (fsCjs.promises as any).access = function(p: any, mode?: any) {
            return new Promise((resolve, reject) => {
                (fsCjs as any).access(p, mode, (err: any) => err ? reject(err) : resolve(undefined));
            });
        };
        (fsCjs.promises as any).rename = function(oldPath: any, newPath: any) {
            return new Promise((resolve, reject) => {
                (fsCjs as any).rename(oldPath, newPath, (err: any) => err ? reject(err) : resolve(undefined));
            });
        };
        (fsCjs.promises as any).chmod = function(p: any, mode: any) {
            return new Promise<void>((resolve) => {
                resolve(undefined); // no-op
            });
        };
        (fsCjs.promises as any).open = function(p: any, flags: any, mode?: any) {
            return new Promise((resolve, reject) => {
                fsCjs.open(p, flags, mode, (err: any, fd: any) => {
                    if (err) return reject(err);

                    // Return a FileHandle mock
                    resolve({
                        fd,
                        stat: () => fsCjs.promises.stat(p),
                        readFile: (opts: any) => fsCjs.promises.readFile(fd, opts),
                        writeFile: (data: any, opts: any) => fsCjs.promises.writeFile(fd, data, opts),
                        appendFile: (data: any, opts: any) => (fsCjs.promises as any).appendFile(fd, data, opts),
                        close: () => new Promise<void>((r, rj) => fsCjs.close(fd, (ce: any) => ce ? rj(ce) : r())),
                    });
                });
            });
        };
    }
  }

  uninstall(): void {
    for (const [name, orig] of Object.entries(this._originals)) {
        if (name.startsWith('promises.')) {
            if (fsCjs.promises) (fsCjs.promises as any)[name.replace('promises.', '')] = orig;
        } else {
            (fsCjs as any)[name] = orig;
        }
    }
    this._originals = {};
  }

  reset(): void {
    this._store.clear();
    this._injections.clear();
    this._writeCount.clear();
    this._fdTable.clear();
    this._nextFd = 1000;
  }
}
