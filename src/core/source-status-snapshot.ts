/** Canonical data builder for `gbrain sources status`. */
import type { BrainEngine } from './engine.ts';
import { loadAllSources } from './sources-load.ts';
import { computeAllSourceMetrics, type SourceMetrics } from './source-health.ts';
import {
  evaluateSyncFreshnessSources,
  loadOperationalSyncSources,
  type SyncFreshnessReason,
  type SyncStalenessClass,
} from './sync-freshness.ts';

export interface SourceStatusMetric extends SourceMetrics {
  staleness_class: SyncStalenessClass;
  freshness_reason: SyncFreshnessReason | 'unknown';
  sync_running: boolean;
  sync_holder: { holder_pid: number; holder_host: string } | null;
}

/**
 * Compose count/job metrics with the same source set, lock snapshot, and
 * freshness verdict used by doctor and get_status_snapshot.
 */
export async function buildSourceStatusMetrics(
  engine: BrainEngine,
): Promise<SourceStatusMetric[]> {
  const allSources = await loadAllSources(engine, { includeArchived: false });
  const freshnessSources = await loadOperationalSyncSources(engine);
  const sourceById = new Map(allSources.map((source) => [source.id, source]));
  const metricSources = freshnessSources
    .map((source) => sourceById.get(source.id))
    .filter((source): source is NonNullable<typeof source> => source !== undefined);
  const metrics = await computeAllSourceMetrics(
    engine,
    metricSources,
  );
  const verdicts = await evaluateSyncFreshnessSources(engine, freshnessSources, { mode: 'host' });
  const verdictBySource = new Map(verdicts.map((verdict) => [verdict.source_id, verdict]));

  return metrics.map((metric) => {
    const verdict = verdictBySource.get(metric.source_id);
    const running = verdict?.reason === 'sync_in_progress' && verdict.lock !== null;
    return {
      ...metric,
      // Stable legacy field, canonical value.
      lag_seconds: verdict?.threshold_age_ms == null
        ? null
        : Math.floor(verdict.threshold_age_ms / 1000),
      staleness_class: verdict?.staleness_class ?? 'unknown',
      freshness_reason: verdict?.reason ?? 'unknown',
      sync_running: running,
      sync_holder: running
        ? { holder_pid: verdict.lock!.holder_pid, holder_host: verdict.lock!.holder_host }
        : null,
    };
  });
}
