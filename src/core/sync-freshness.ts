/**
 * Canonical per-source sync-freshness evaluator.
 *
 * Both `gbrain doctor` and the status snapshot consume these verdicts. Keeping
 * evidence gathering (live lock, registered-source Git state, stored content
 * timestamp) and threshold classification here prevents the two operational
 * surfaces from independently deciding that the same source is both fresh and
 * stale.
 */
import type { BrainEngine } from './engine.ts';
import {
  probeSourceGitStateAsync,
  type AsyncGitStateProbe,
  type AsyncSourceGitState,
} from './git-head.ts';
import { lagFromContentMs, resolveStalenessCeilingSeconds } from './source-health.ts';
import { resolveEnvNumber, resolveHoursEnv } from './env-number.ts';
import { CHUNKER_VERSION } from './chunkers/code.ts';
import { isUndefinedColumnError } from './utils.ts';

export type SyncFreshnessMode = 'host' | 'stored';
export type SyncStalenessClass = 'fresh' | 'stale' | 'severe' | 'unknown';
export type SyncFreshnessCheckStatus = 'ok' | 'warn' | 'fail';
export type SyncFreshnessReason =
  | 'sync_in_progress'
  | 'wedged_sync_lock'
  | 'never_synced'
  | 'invalid_last_sync'
  | 'future_last_sync'
  | 'unchanged'
  | 'recent'
  | 'warn_age'
  | 'fail_age';

export interface SyncFreshnessSourceInput {
  id: string;
  name: string;
  local_path: string | null;
  last_sync_at: string | Date | null;
  last_commit: string | null;
  chunker_version: string | null;
  newest_content_at: string | Date | null;
}

/** Canonical source selector shared by doctor, snapshot, and local status. */
export interface OperationalSyncSource extends SyncFreshnessSourceInput {
  config: Record<string, unknown> | string | null;
}

export interface LiveSyncLock {
  holder_pid: number;
  holder_host: string;
  age_ms: number;
}

export interface SyncFreshnessVerdict {
  source_id: string;
  source_name: string;
  staleness_class: SyncStalenessClass;
  check_status: SyncFreshnessCheckStatus;
  reason: SyncFreshnessReason;
  /** Raw wall-clock time since last_sync_at. */
  raw_age_ms: number | null;
  /** Evidence-adjusted age used for the warn/fail threshold. */
  threshold_age_ms: number | null;
  lock: LiveSyncLock | null;
}

export interface EvaluateSyncFreshnessOptions {
  /** One clock read for the entire snapshot/check. */
  nowMs?: number;
  /**
   * `host` probes the registered source checkout and catches HEAD/dirty-tree
   * drift. `stored` uses newest_content_at only and never runs Git.
   */
  mode?: SyncFreshnessMode;
  /** Test seam; production reads the canonical per-source sync lock. */
  lockProbe?: (sourceId: string) => Promise<LiveSyncLock | null>;
  /** Test seam; production uses the async, shell-free Git status probe. */
  gitProbe?: AsyncGitStateProbe;
  /** One budget shared by every Git probe in this evaluation. */
  gitProbeBudgetMs?: number;
  /** Maximum child-process time for any one source, capped by the shared budget. */
  gitProbeTimeoutMs?: number;
  /** Hard cap on the number of source checkouts inspected in one operation. */
  gitProbeMaxSources?: number;
}

export const DEFAULT_SYNC_FRESHNESS_GIT_BUDGET_MS = 5_000;
export const DEFAULT_SYNC_FRESHNESS_GIT_TIMEOUT_MS = 1_500;
export const DEFAULT_SYNC_FRESHNESS_GIT_MAX_SOURCES = 64;

/**
 * Read the exact operational source set once. The filter/order is part of the
 * status contract: active rows with a registered local checkout, ordered by id.
 */
export async function loadOperationalSyncSources(
  engine: BrainEngine,
): Promise<OperationalSyncSource[]> {
  try {
    return await engine.executeRaw<OperationalSyncSource>(
      `SELECT id, name, local_path, last_sync_at, last_commit, chunker_version, newest_content_at, config
         FROM sources
        WHERE local_path IS NOT NULL AND archived IS NOT TRUE
        ORDER BY id`,
    );
  } catch (err) {
    if (!['newest_content_at', 'chunker_version', 'archived'].some((column) =>
      isUndefinedColumnError(err, column))) throw err;
    // Pre-newest_content_at brains still have the chunker + archive columns.
    // Keep the active-source filter while making the missing evidence explicit.
    try {
      return await engine.executeRaw<OperationalSyncSource>(
        `SELECT id, name, local_path, last_sync_at, last_commit, chunker_version,
                NULL::timestamptz AS newest_content_at, config
           FROM sources
          WHERE local_path IS NOT NULL AND archived IS NOT TRUE
          ORDER BY id`,
      );
    } catch (legacyErr) {
      if (!['chunker_version', 'archived'].some((column) =>
        isUndefinedColumnError(legacyErr, column))) throw legacyErr;
      // Historical minimum: no archived/chunker/newest columns. Such a brain
      // cannot distinguish archived rows, matching its pre-archive semantics.
      return engine.executeRaw<OperationalSyncSource>(
        `SELECT id, name, local_path, last_sync_at, last_commit,
                NULL::text AS chunker_version,
                NULL::timestamptz AS newest_content_at,
                config
           FROM sources
          WHERE local_path IS NOT NULL
          ORDER BY id`,
      );
    }
  }
}

function timestampMs(value: string | Date | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function ageVerdict(
  source: SyncFreshnessSourceInput,
  rawAgeMs: number,
  thresholdAgeMs: number,
  warnMs: number,
  failMs: number,
): SyncFreshnessVerdict {
  if (thresholdAgeMs > failMs) {
    return {
      source_id: source.id,
      source_name: source.name,
      staleness_class: 'severe',
      check_status: 'fail',
      reason: 'fail_age',
      raw_age_ms: rawAgeMs,
      threshold_age_ms: thresholdAgeMs,
      lock: null,
    };
  }
  if (thresholdAgeMs > warnMs) {
    return {
      source_id: source.id,
      source_name: source.name,
      staleness_class: 'stale',
      check_status: 'warn',
      reason: 'warn_age',
      raw_age_ms: rawAgeMs,
      threshold_age_ms: thresholdAgeMs,
      lock: null,
    };
  }
  return {
    source_id: source.id,
    source_name: source.name,
    staleness_class: 'fresh',
    check_status: 'ok',
    reason: 'recent',
    raw_age_ms: rawAgeMs,
    threshold_age_ms: thresholdAgeMs,
    lock: null,
  };
}

async function defaultLockProbe(
  engine: BrainEngine,
  sourceId: string,
): Promise<LiveSyncLock | null> {
  try {
    const { inspectLock, syncLockId } = await import('./db-lock.ts');
    const snap = await inspectLock(engine, syncLockId(sourceId));
    if (!snap || snap.ttl_expired) return null;
    return {
      holder_pid: snap.holder_pid,
      holder_host: snap.holder_host,
      age_ms: snap.age_ms,
    };
  } catch {
    // Pre-lock-table brains and narrow test stubs retain ordinary staleness.
    return null;
  }
}

async function gitProbeWithinBudget(
  probe: AsyncGitStateProbe,
  source: SyncFreshnessSourceInput,
  timeoutMs: number,
): Promise<AsyncSourceGitState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(source.local_path, source.last_commit, {
        requireCleanWorkingTree: 'ignore-untracked',
        timeoutMs,
      }),
      new Promise<AsyncSourceGitState>((resolve) => {
        timer = setTimeout(() => resolve('indeterminate'), timeoutMs);
      }),
    ]);
  } catch {
    return 'indeterminate';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Evaluate all registered source rows under one clock and one threshold set. */
export async function evaluateSyncFreshnessSources(
  engine: BrainEngine,
  sources: SyncFreshnessSourceInput[],
  opts: EvaluateSyncFreshnessOptions = {},
): Promise<SyncFreshnessVerdict[]> {
  const now = opts.nowMs ?? Date.now();
  const mode = opts.mode ?? 'host';
  const warnMs = resolveHoursEnv('GBRAIN_SYNC_FRESHNESS_WARN_HOURS', 24) * 3_600_000;
  const failMs = resolveHoursEnv('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72) * 3_600_000;
  const ceilingSeconds = resolveStalenessCeilingSeconds();
  const currentChunkerVersion = String(CHUNKER_VERSION);
  const probeLock = opts.lockProbe ?? ((sourceId: string) => defaultLockProbe(engine, sourceId));
  const probeGit = opts.gitProbe ?? probeSourceGitStateAsync;
  const gitBudgetMs = Math.max(1, Math.floor(opts.gitProbeBudgetMs ?? resolveEnvNumber(
    'GBRAIN_SYNC_FRESHNESS_GIT_BUDGET_MS',
    DEFAULT_SYNC_FRESHNESS_GIT_BUDGET_MS,
    { unit: 'ms' },
  )));
  const gitTimeoutMs = Math.max(1, Math.floor(opts.gitProbeTimeoutMs ?? resolveEnvNumber(
    'GBRAIN_SYNC_FRESHNESS_GIT_TIMEOUT_MS',
    DEFAULT_SYNC_FRESHNESS_GIT_TIMEOUT_MS,
    { unit: 'ms' },
  )));
  const gitMaxSources = Math.max(1, Math.floor(opts.gitProbeMaxSources ?? resolveEnvNumber(
    'GBRAIN_SYNC_FRESHNESS_GIT_MAX_SOURCES',
    DEFAULT_SYNC_FRESHNESS_GIT_MAX_SOURCES,
  )));
  let gitBudgetStartedAt: number | null = null;
  let gitProbesStarted = 0;
  const verdicts: SyncFreshnessVerdict[] = [];

  for (const source of sources) {
    const liveLock = await probeLock(source.id);
    if (liveLock) {
      if (liveLock.age_ms <= ceilingSeconds * 1000) {
        verdicts.push({
          source_id: source.id,
          source_name: source.name,
          staleness_class: 'fresh',
          check_status: 'ok',
          reason: 'sync_in_progress',
          raw_age_ms: timestampMs(source.last_sync_at) === null
            ? null
            : now - (timestampMs(source.last_sync_at) as number),
          threshold_age_ms: 0,
          lock: liveLock,
        });
      } else {
        verdicts.push({
          source_id: source.id,
          source_name: source.name,
          staleness_class: 'severe',
          check_status: 'fail',
          reason: 'wedged_sync_lock',
          raw_age_ms: timestampMs(source.last_sync_at) === null
            ? null
            : now - (timestampMs(source.last_sync_at) as number),
          threshold_age_ms: liveLock.age_ms,
          lock: liveLock,
        });
      }
      continue;
    }

    const lastSyncMs = timestampMs(source.last_sync_at);
    if (lastSyncMs === null) {
      verdicts.push({
        source_id: source.id,
        source_name: source.name,
        staleness_class: 'severe',
        check_status: 'fail',
        reason: 'never_synced',
        raw_age_ms: null,
        threshold_age_ms: null,
        lock: null,
      });
      continue;
    }
    if (!Number.isFinite(lastSyncMs)) {
      verdicts.push({
        source_id: source.id,
        source_name: source.name,
        staleness_class: 'unknown',
        check_status: 'warn',
        reason: 'invalid_last_sync',
        raw_age_ms: null,
        threshold_age_ms: null,
        lock: null,
      });
      continue;
    }

    const rawAgeMs = now - lastSyncMs;
    if (rawAgeMs < 0) {
      verdicts.push({
        source_id: source.id,
        source_name: source.name,
        staleness_class: 'stale',
        check_status: 'warn',
        reason: 'future_last_sync',
        raw_age_ms: rawAgeMs,
        threshold_age_ms: rawAgeMs,
        lock: null,
      });
      continue;
    }

    let thresholdAgeMs = rawAgeMs;
    if (mode === 'host') {
      gitBudgetStartedAt ??= performance.now();
      const elapsedMs = performance.now() - gitBudgetStartedAt;
      const remainingMs = Math.max(0, gitBudgetMs - elapsedMs);
      let gitState: AsyncSourceGitState = 'indeterminate';
      if (remainingMs > 0 && gitProbesStarted < gitMaxSources) {
        gitProbesStarted++;
        gitState = await gitProbeWithinBudget(
          probeGit,
          source,
          Math.max(1, Math.min(gitTimeoutMs, Math.floor(remainingMs))),
        );
      }
      const chunkerMatch = source.chunker_version === currentChunkerVersion;
      if (gitState === 'unchanged' && chunkerMatch) {
        verdicts.push({
          source_id: source.id,
          source_name: source.name,
          staleness_class: 'fresh',
          check_status: 'ok',
          reason: 'unchanged',
          raw_age_ms: rawAgeMs,
          threshold_age_ms: 0,
          lock: null,
        });
        continue;
      }
      if (gitState === 'unavailable' && chunkerMatch) {
        const contentMs = timestampMs(source.newest_content_at);
        const lagSeconds = lagFromContentMs(
          contentMs !== null && Number.isFinite(contentMs) ? contentMs : null,
          lastSyncMs,
          now,
          ceilingSeconds,
        );
        thresholdAgeMs = lagSeconds === null ? rawAgeMs : lagSeconds * 1000;
      }
    } else {
      const contentMs = timestampMs(source.newest_content_at);
      const lagSeconds = lagFromContentMs(
        contentMs !== null && Number.isFinite(contentMs) ? contentMs : null,
        lastSyncMs,
        now,
        ceilingSeconds,
      );
      thresholdAgeMs = lagSeconds === null ? rawAgeMs : lagSeconds * 1000;
    }

    verdicts.push(ageVerdict(source, rawAgeMs, thresholdAgeMs, warnMs, failMs));
  }

  return verdicts;
}
