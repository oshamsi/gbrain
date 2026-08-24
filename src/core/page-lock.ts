/**
 * v0.28: per-page file lock for atomic markdown read-modify-write.
 *
 * Scoped per page so two parallel `gbrain takes add` calls + a refresh-mode
 * `takes seed` running in autopilot can't race on the same `<slug>.md` file.
 *
 * Lock file path: `~/.gbrain/page-locks/<sha256-of-slug>.lock`. SHA-256
 * keeps filenames safe regardless of slug content (slashes, unicode, etc.).
 *
 * File contents: `{pid}\n{iso-timestamp}\n{ownership-token}`. The pid line
 * is DIAGNOSTIC ONLY. Staleness = mtime older than `LOCK_TTL_MS` (5 min) —
 * i.e. heartbeat/lease recency, nothing else (#2840). PID liveness
 * (`process.kill(pid, 0)`) is deliberately NOT consulted: a PID is only
 * meaningful inside the namespace that produced it, so in containerized
 * deploys sharing `GBRAIN_HOME` across PID namespaces (e.g. `gbrain serve`
 * + `gbrain jobs work` as sibling containers) a LIVE holder resolves to
 * ESRCH and would be stolen milliseconds after it heartbeated — silent
 * last-writer-wins on facts/takes. Same family as the sync lock's
 * refresh-recency rule (GBRAIN_LOCK_STEAL_GRACE): a holder that heartbeated
 * recently is never stolen; dead holders stop refreshing and age past the
 * TTL. Cost: a crashed holder blocks the page for up to the TTL (bounded
 * wait) instead of being reaped instantly on the same host.
 *
 * Ownership for release()/refresh() is the per-acquire random token, never
 * the bare PID — PIDs collide across namespaces, so a same-pid lockfile is
 * not proof it is ours (#2840 false-self direction).
 *
 * Usage:
 *
 *   const lock = await acquirePageLock(slug, { timeoutMs: 30_000 });
 *   try {
 *     // read-modify-write the markdown file
 *   } finally {
 *     await lock.release();
 *   }
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gbrainPath } from './config.ts';

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches eng-review fold spec
const LOCK_REFRESH_MS = Math.floor(LOCK_TTL_MS / 6);
// The canonical lockfile must occasionally be replaced after its holder dies.
// Reaping is itself a read→unlink→create sequence, so serialize that sequence
// (and refresh/release) with short-lived per-attempt tickets. The state section
// is synchronous in production and normally lasts well under a millisecond;
// this TTL only recovers a process that crashed inside it.
const STATE_TICKET_TTL_MS = 30_000;
const STATE_TICKET_POLL_MS = 5;

export class PageLockTimeoutError extends Error {
  constructor(public readonly slug: string, public readonly timeoutMs: number) {
    super(`acquirePageLock: could not acquire lock for slug "${slug}" within ${timeoutMs}ms`);
    this.name = 'PageLockTimeoutError';
  }
}

export interface PageLockHandle {
  /** Release the lock if we still hold it. Idempotent. */
  release: () => Promise<void>;
  /** Refresh the mtime + timestamp so the TTL doesn't expire mid-operation. */
  refresh: () => Promise<void>;
  /** Slug the lock was acquired for (for diagnostics). */
  slug: string;
}

export interface AcquirePageLockOpts {
  /** Total wait budget before giving up. Default 0 (no wait — fail fast). */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 200ms. */
  pollMs?: number;
  /** Override lock root for tests. */
  lockRoot?: string;
  /** Test seam: pause while holding the reaping mutex after observing stale. */
  beforeStaleReap?: () => Promise<void>;
}

function lockPathFor(slug: string, lockRoot?: string): string {
  const sha = createHash('sha256').update(slug).digest('hex');
  const dir = lockRoot ?? gbrainPath('page-locks');
  return join(dir, `${sha}.lock`);
}

/** Line 3 of the lock file. Empty string when absent (pre-#2840 format). */
function tokenOf(content: string): string {
  return content.trim().split('\n')[2] ?? '';
}

type StateMutexResult<T> = { entered: true; value: T } | { entered: false };

/**
 * Enter the tiny lockfile-state critical section.
 *
 * A unique ticket is created before inspecting peers. If another fresh ticket
 * exists, this contender withdraws and retries. That closes the stale-reaper
 * race without recursively needing a reclaimable single mutex file:
 * a late contender necessarily observes the earlier ticket, while contenders
 * that overlap before either scan both withdraw safely.
 */
async function withLockStateMutex<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  timeoutMs: number,
): Promise<StateMutexResult<T>> {
  const dir = join(lockPath, '..');
  mkdirSync(dir, { recursive: true });
  const prefix = `${basename(lockPath)}.state-`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const ticketPath = join(dir, `${prefix}${randomUUID()}`);
    try {
      writeFileSync(ticketPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let peerIsActive = false;
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.startsWith(prefix) || join(dir, entry) === ticketPath) continue;
        try {
          if (Date.now() - statSync(join(dir, entry)).mtimeMs < STATE_TICKET_TTL_MS) {
            peerIsActive = true;
            break;
          }
        } catch {
          // Peer withdrew between readdir/stat; it cannot block this attempt.
        }
      }

      if (!peerIsActive) {
        try {
          return { entered: true, value: await fn() };
        } finally {
          try { unlinkSync(ticketPath); } catch { /* already gone */ }
        }
      }
    } finally {
      // Also covers readdir/stat failures; a failed state inspection must not
      // strand a fresh ticket and block every contender for the ticket TTL.
      try { unlinkSync(ticketPath); } catch { /* already gone */ }
    }

    if (Date.now() >= deadline) return { entered: false };
    await new Promise(r => setTimeout(r, STATE_TICKET_POLL_MS));
  }
}

function makeHandle(slug: string, lockPath: string, pid: number, token: string): PageLockHandle {
  return {
    slug,
    refresh: async () => {
      await withLockStateMutex(lockPath, () => {
        try {
          // Only heartbeat a lock we still own — if our TTL lapsed and another
          // process reclaimed it, overwriting would clobber ITS heartbeat.
          if (tokenOf(readFileSync(lockPath, 'utf-8')) !== token) return;
          writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n${token}\n`);
        } catch {
          /* non-fatal — next acquirer will see it as stale */
        }
      }, 1_000);
    },
    release: async () => {
      await withLockStateMutex(lockPath, () => {
        try {
          // Token match, not PID match: a foreign-namespace process can share
          // our PID number, and unlinking its lock reopens the #2840 race.
          if (tokenOf(readFileSync(lockPath, 'utf-8')) === token) unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }, 1_000);
    },
  };
}

async function tryAcquireOnce(
  slug: string,
  lockPath: string,
  opts: AcquirePageLockOpts,
): Promise<PageLockHandle | null> {
  const dir = join(lockPath, '..');
  mkdirSync(dir, { recursive: true });
  const pid = process.pid;
  // Namespace-stable per-acquire identity. Release/refresh ownership keys on
  // this, never on the PID (#2840: PIDs collide across PID namespaces).
  const token = randomUUID();

  const attempt = await withLockStateMutex(lockPath, async () => {
    if (existsSync(lockPath)) {
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        // Liveness = heartbeat recency ONLY. Do not consult PID liveness:
        // kill(pid, 0) answers "does this PID exist in MY namespace", which is
        // the wrong question for a lockfile on a volume shared across
        // containers — a live foreign holder is ESRCH here and would be
        // stolen while it works (#2840).
        if (ageMs < LOCK_TTL_MS) return null;

        // Hold the state mutex across the stale observation, unlink, and
        // exclusive create. No second reaper can unlink the fresh successor.
        await opts.beforeStaleReap?.();
        try { unlinkSync(lockPath); } catch { /* already gone */ }
      } catch {
        // Stat error → lockfile vanished mid-check (holder released) or is
        // unreadable; fall through to the exclusive create, which decides.
      }
    }

    try {
      writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n${token}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
    return makeHandle(slug, lockPath, pid, token);
  }, 0);

  return attempt.entered ? attempt.value : null;
}

/**
 * Acquire a per-page lock. By default fails fast (timeoutMs=0) — a live
 * holder returns null. Pass timeoutMs > 0 to poll until acquired or the
 * deadline expires.
 */
export async function acquirePageLock(
  slug: string,
  opts: AcquirePageLockOpts = {},
): Promise<PageLockHandle | null> {
  const lockPath = lockPathFor(slug, opts.lockRoot);
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  const pollMs = opts.pollMs ?? 200;

  let attempt = await tryAcquireOnce(slug, lockPath, opts);
  if (attempt) return attempt;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    attempt = await tryAcquireOnce(slug, lockPath, opts);
    if (attempt) return attempt;
  }

  return null;
}

/**
 * Convenience wrapper: acquire, run fn, release. Throws if the lock
 * cannot be acquired within the timeout.
 */
export async function withPageLock<T>(
  slug: string,
  fn: () => Promise<T>,
  opts: AcquirePageLockOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const handle = await acquirePageLock(slug, { ...opts, timeoutMs });
  if (!handle) {
    throw new PageLockTimeoutError(slug, timeoutMs);
  }
  const refreshTimer = setInterval(() => { void handle.refresh(); }, LOCK_REFRESH_MS);
  refreshTimer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(refreshTimer);
    await handle.release();
  }
}
