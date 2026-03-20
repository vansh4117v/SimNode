import path from 'node:path';

/**
 * Normalizes an arbitrary path string to a canonical absolute internal representation
 * using `/` as the separator, regardless of the underlying OS.
 *
 * Handles:
 * - Windows backslashes: `\app\build\foo.js` → `/app/build/foo.js`
 * - Windows drive letters: `C:\foo\bar` or `C:/foo/bar` → `/foo/bar`
 * - Mixed separators: `/app\build/foo.js` → `/app/build/foo.js`
 */
export function normalizePath(p: string): string {
  // 1. Convert all backslashes to forward slashes
  let normalized = p.replace(/\\/g, '/');

  // 2. Strip Windows drive letter (e.g. "C:", "E:") at the start
  //    This lets VirtualFS treat Windows absolute paths as Unix-absolute.
  normalized = normalized.replace(/^[A-Za-z]:/, '');

  // 3. Resolve to an absolute path, normalize `.` and `..`
  const resolved = path.resolve(normalized);

  // 4. Replace any remaining backslashes (actual Windows execution)
  return resolved.replace(/\\/g, '/');
}
