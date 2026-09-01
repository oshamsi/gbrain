/**
 * Watcher/self-write suppression for canonical file rewrites.
 *
 * importFromFile, write-through, and other canonical mutators register a
 * path after they write it. The file-watcher consumes the registration so
 * the rewrite does not re-enter ingestion as a user edit.
 */

import { resolve } from 'node:path';

const DEFAULT_TTL_MS = 8_000;

type Entry = { expires: number; sha256?: string };
const pending = new Map<string, Entry>();

function keyOf(absPath: string): string {
  return resolve(absPath);
}

export function registerSelfWrite(absPath: string, opts?: { ttlMs?: number; sha256?: string }): void {
  pending.set(keyOf(absPath), {
    expires: Date.now() + (opts?.ttlMs ?? DEFAULT_TTL_MS),
    sha256: opts?.sha256,
  });
}

/** True when this path was a recent canonical self-write and should not re-ingest. */
export function consumeSelfWrite(absPath: string, sha256?: string): boolean {
  const key = keyOf(absPath);
  const hit = pending.get(key);
  if (!hit) return false;
  if (Date.now() > hit.expires) {
    pending.delete(key);
    return false;
  }
  if (hit.sha256 && sha256 && hit.sha256 !== sha256) return false;
  pending.delete(key);
  return true;
}

export function _resetSelfWriteGuardForTest(): void {
  pending.clear();
}
