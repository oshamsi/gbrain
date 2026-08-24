import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../db-lock.ts';
import { PageLockTimeoutError, withPageLock, type AcquirePageLockOpts } from '../page-lock.ts';
import { OperationError } from './contract.ts';

const PUT_PAGE_LOCK_TIMEOUT_MS = 30_000;
const PUT_PAGE_DB_LOCK_TTL_MINUTES = 30;
const PUT_PAGE_DB_REFRESH_MS = 30_000;

export interface PutPageOperationLockOpts extends AcquirePageLockOpts {
  /** DB-row mutex polling cadence. Defaults to pollMs, then 100ms. */
  dbPollMs?: number;
  /** Test seam; production uses the 30-minute generic DB-lock default. */
  dbTtlMinutes?: number;
  /** Test seam for the DB lease heartbeat cadence. */
  dbRefreshMs?: number;
}

/** Stable, bounded lock id; source and slug are both part of the fence key. */
export function putPageDbLockId(sourceId: string, normalizedSlug: string): string {
  const digest = createHash('sha256').update(sourceId).update('\0').update(normalizedSlug).digest('hex');
  return `put-page:${digest}`;
}

function preWorkConflict(normalizedSlug: string, detail: string): OperationError {
  return new OperationError(
    'write_conflict',
    `put_page: ${detail} for '${normalizedSlug}'; this write was not started.`,
    `Re-read '${normalizedSlug}' with include_content: true, then retry the intended edit with its current content_hash.`,
  );
}

function outcomeUnknown(normalizedSlug: string, detail: string): OperationError {
  return new OperationError(
    'write_outcome_unknown',
    `put_page: work ran for '${normalizedSlug}', but ${detail}; the committed outcome must be verified before any retry.`,
    `Re-read '${normalizedSlug}' with include_content: true and compare its content_hash/content. Do not retry blindly.`,
  );
}

async function acquireDbMutex(
  engine: BrainEngine,
  lockId: string,
  deadline: number,
  pollMs: number,
  ttlMinutes: number,
): Promise<DbLockHandle | null> {
  for (;;) {
    const handle = await tryAcquireDbLock(engine, lockId, ttlMinutes);
    if (handle) return handle;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

/**
 * Serialize the complete DB→disk→post-hook put_page workflow per page.
 *
 * The DB row lease is authoritative across hosts and GBRAIN_HOME layouts.
 * The existing raw-slug file lease stays nested inside it so put_page also
 * coordinates with facts/takes/timeline markdown writers that use that lock.
 * Atomic page CAS remains the final stale-reader fence.
 */
export async function withPutPageOperationLock<T>(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  work: () => Promise<T>,
  opts: PutPageOperationLockOpts = {},
): Promise<T> {
  const normalizedSlug = slug.toLowerCase();
  const timeoutMs = opts.timeoutMs ?? PUT_PAGE_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const lockId = putPageDbLockId(sourceId, normalizedSlug);
  const dbHandle = await acquireDbMutex(
    engine,
    lockId,
    deadline,
    Math.max(1, opts.dbPollMs ?? opts.pollMs ?? 100),
    opts.dbTtlMinutes ?? PUT_PAGE_DB_LOCK_TTL_MINUTES,
  );
  if (!dbHandle) {
    throw preWorkConflict(normalizedSlug, 'another writer still holds the database page lock');
  }

  let refreshChain = Promise.resolve();
  let ownershipLost = false;
  const refreshTimer = setInterval(() => {
    refreshChain = refreshChain.then(async () => {
      if (ownershipLost) return;
      try {
        if (!await dbHandle.refresh()) ownershipLost = true;
      } catch {
        // A transient refresh error is not proof of theft. The final fenced
        // refresh below must positively prove ownership before success returns.
      }
    });
  }, opts.dbRefreshMs ?? PUT_PAGE_DB_REFRESH_MS);
  refreshTimer.unref?.();

  try {
    const remaining = Math.max(0, deadline - Date.now());
    const result = await withPageLock(normalizedSlug, work, {
      ...opts,
      timeoutMs: remaining,
    });
    await refreshChain;
    if (ownershipLost) {
      throw outcomeUnknown(normalizedSlug, 'database page-lock ownership was lost during the write');
    }
    try {
      if (!await dbHandle.refresh()) {
        throw outcomeUnknown(normalizedSlug, 'database page-lock ownership was lost during the write');
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw outcomeUnknown(normalizedSlug, 'database page-lock ownership could not be verified after the write');
    }
    return result;
  } catch (error) {
    if (error instanceof PageLockTimeoutError) {
      throw preWorkConflict(normalizedSlug, 'another writer still holds the filesystem page lock');
    }
    throw error;
  } finally {
    clearInterval(refreshTimer);
    await refreshChain;
    try {
      await dbHandle.release();
    } catch (error) {
      // Release is fenced and the TTL/process-cleanup hooks are backstops.
      // A cleanup failure must never mask either a verified write result or
      // the primary pre-work/outcome-unknown error and invite a blind retry.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[put-page-lock] ${lockId}: fenced release failed (${message}); TTL cleanup remains active\n`);
    }
  }
}
