/**
 * Serial regression coverage for the status/doctor freshness split.
 *
 * A source last synced 88h ago used to be reported as 16h of adjusted lag
 * (and therefore "fresh") by get_status_snapshot while doctor observed the
 * moved checkout and correctly used the full 88h. Both surfaces now consume
 * one evaluator and one strict threshold mapping.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { buildSyncStatusReport } from '../src/commands/sync.ts';
import { checkSyncFreshness } from '../src/commands/doctor.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  _setGitCleanProbeForTests,
  _setGitHeadProbeForTests,
} from '../src/core/git-head.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { evaluateSyncFreshnessSources } from '../src/core/sync-freshness.ts';

const HOUR = 3_600_000;

interface SourceFixture {
  id: string;
  name: string;
  local_path: string;
  last_sync_at: string | Date | null;
  last_commit: string | null;
  chunker_version: string | null;
  newest_content_at: string | Date | null;
}

function makeEngine(rows: SourceFixture[]): BrainEngine {
  return {
    kind: 'fixture',
    executeRaw: async (sql: string) => {
      if (sql.includes('SELECT id, name, local_path, last_sync_at, last_commit')) {
        return rows;
      }
      if (sql.includes('SELECT id, last_commit, last_sync_at, chunker_version')) {
        return rows;
      }
      if (sql.includes('SELECT id, name, local_path, config FROM sources')) {
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          local_path: row.local_path,
          config: { syncEnabled: true },
        }));
      }
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

function sourceSummaries(rows: SourceFixture[]) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    local_path: row.local_path,
    config: { syncEnabled: true },
  }));
}

function doctorVerdicts(result: Awaited<ReturnType<typeof checkSyncFreshness>>) {
  return (result.details?.source_verdicts ?? []) as Array<{
    source_id: string;
    staleness_class: string;
    check_status: string;
    reason: string;
    staleness_hours: number | null;
  }>;
}

afterEach(() => {
  _setGitHeadProbeForTests(null);
  _setGitCleanProbeForTests(null);
});

describe('sync freshness parity', () => {
  test('88h moved checkout cannot be reduced to a fresh 16h ceiling-ramp verdict', async () => {
    const now = 2_000_000_000_000;
    const rows: SourceFixture[] = [{
      id: 'vault-source',
      name: 'Vault source',
      local_path: '/registered/vault-source',
      last_sync_at: new Date(now - 88 * HOUR),
      last_commit: 'recorded-head',
      chunker_version: String(CHUNKER_VERSION),
      newest_content_at: new Date(now - 200 * HOUR),
    }];
    const engine = makeEngine(rows);

    _setGitHeadProbeForTests(() => 'new-live-head');
    _setGitCleanProbeForTests(() => true);

    // This pins the old lie's arithmetic: stored content predates the sync,
    // so 88h wall-clock minus the 72h ceiling produces a fresh-looking 16h.
    const stored = await buildSyncStatusReport(engine, sourceSummaries(rows), {
      nowMs: now,
      freshnessMode: 'stored',
    });
    expect(stored.sources[0].hours_since_last_sync).toBe(88);
    expect(stored.sources[0].staleness_hours).toBe(16);
    expect(stored.sources[0].staleness_class).toBe('fresh');

    const status = await buildSyncStatusReport(engine, sourceSummaries(rows), {
      nowMs: now,
      freshnessMode: 'host',
    });
    const doctor = await checkSyncFreshness(engine, { nowMs: now });

    expect(status.sources[0].staleness_hours).toBe(88);
    expect(status.sources[0].staleness_class).toBe('severe');
    expect(doctor.status).toBe('fail');
    expect(doctorVerdicts(doctor)[0]).toMatchObject({
      source_id: 'vault-source',
      staleness_class: 'severe',
      check_status: 'fail',
      reason: 'fail_age',
      staleness_hours: 88,
    });
  });

  test('admin get_status_snapshot and doctor agree for every registered source and evidence path', async () => {
    const now = Date.now();
    const rows: SourceFixture[] = [
      ['unchanged', 88 * HOUR, 'recorded-head', String(CHUNKER_VERSION), null],
      ['recent', 2 * HOUR, 'recorded-head', String(CHUNKER_VERSION), null],
      ['warn', 40 * HOUR, 'recorded-head', String(CHUNKER_VERSION), null],
      ['fail', 88 * HOUR, 'recorded-head', String(CHUNKER_VERSION), null],
      // Missing clone + matching chunker uses the stored content fallback.
      ['unavailable', 88 * HOUR, 'recorded-head', String(CHUNKER_VERSION), 200 * HOUR],
      // A matching checkout cannot hide a pending re-chunk.
      ['rechunk', 88 * HOUR, 'recorded-head', 'old-chunker', null],
    ].map(([id, age, lastCommit, chunkerVersion, contentAge]) => ({
      id: id as string,
      name: id as string,
      local_path: `/registered/${id}`,
      last_sync_at: new Date(now - (age as number)),
      last_commit: lastCommit as string,
      chunker_version: chunkerVersion as string,
      newest_content_at: contentAge === null ? null : new Date(now - (contentAge as number)),
    }));
    rows.push(
      {
        id: 'never', name: 'never', local_path: '/registered/never',
        last_sync_at: null, last_commit: null,
        chunker_version: String(CHUNKER_VERSION), newest_content_at: null,
      },
      {
        id: 'future', name: 'future', local_path: '/registered/future',
        last_sync_at: new Date(now + HOUR), last_commit: 'recorded-head',
        chunker_version: String(CHUNKER_VERSION), newest_content_at: null,
      },
      {
        id: 'invalid', name: 'invalid', local_path: '/registered/invalid',
        last_sync_at: 'not-a-timestamp', last_commit: 'recorded-head',
        chunker_version: String(CHUNKER_VERSION), newest_content_at: null,
      },
    );
    const engine = makeEngine(rows);
    _setGitHeadProbeForTests((path) => {
      if (path.endsWith('/unchanged') || path.endsWith('/rechunk')) return 'recorded-head';
      if (path.endsWith('/unavailable')) return null;
      return 'new-live-head';
    });
    _setGitCleanProbeForTests(() => true);

    const snapshot = await operationsByName.get_status_snapshot.handler({
      engine,
      config: { engine: 'pglite' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
    }, {}) as any;
    const doctor = await checkSyncFreshness(engine, { nowMs: now });

    const statusVerdicts = snapshot.sync.sources.map((source: any) => ({
      source_id: source.source_id,
      staleness_class: source.staleness_class,
    }));
    const checkVerdicts = doctorVerdicts(doctor).map((source) => ({
      source_id: source.source_id,
      staleness_class: source.staleness_class,
    }));
    expect(statusVerdicts).toEqual(checkVerdicts);
    expect(statusVerdicts).toEqual([
      { source_id: 'unchanged', staleness_class: 'fresh' },
      { source_id: 'recent', staleness_class: 'fresh' },
      { source_id: 'warn', staleness_class: 'stale' },
      { source_id: 'fail', staleness_class: 'severe' },
      { source_id: 'unavailable', staleness_class: 'fresh' },
      { source_id: 'rechunk', staleness_class: 'severe' },
      { source_id: 'never', staleness_class: 'severe' },
      { source_id: 'future', staleness_class: 'stale' },
      { source_id: 'invalid', staleness_class: 'unknown' },
    ]);
  });

  test('strict 24h/72h boundaries agree for every source', async () => {
    const now = 2_000_000_000_000;
    const rows: SourceFixture[] = [
      ['at-warn', 24 * HOUR],
      ['past-warn', 24 * HOUR + 1],
      ['at-fail', 72 * HOUR],
      ['past-fail', 72 * HOUR + 1],
    ].map(([id, age]) => ({
      id: id as string,
      name: id as string,
      local_path: `/registered/${id}`,
      last_sync_at: new Date(now - (age as number)),
      last_commit: `old-${id}`,
      chunker_version: String(CHUNKER_VERSION),
      newest_content_at: null,
    }));
    const engine = makeEngine(rows);
    _setGitHeadProbeForTests(() => 'new-live-head');
    _setGitCleanProbeForTests(() => true);

    const status = await buildSyncStatusReport(engine, sourceSummaries(rows), {
      nowMs: now,
      freshnessMode: 'host',
    });
    const doctor = await checkSyncFreshness(engine, { nowMs: now });

    const expected = [
      ['at-warn', 'fresh'],
      ['past-warn', 'stale'],
      ['at-fail', 'stale'],
      ['past-fail', 'severe'],
    ];
    expect(status.sources.map((source) => [source.source_id, source.staleness_class])).toEqual(expected);
    expect(doctorVerdicts(doctor).map((source) => [source.source_id, source.staleness_class])).toEqual(expected);
  });

  test('host evidence has one total budget and timeout falls back conservatively', async () => {
    const now = 2_000_000_000_000;
    const rows: SourceFixture[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({
      id,
      name: id,
      local_path: `/registered/${id}`,
      last_sync_at: new Date(now - 88 * HOUR),
      last_commit: 'recorded-head',
      chunker_version: String(CHUNKER_VERSION),
      // If timeout were mislabeled "clone unavailable", this old content
      // would ceiling-ramp to 16h/fresh and recreate the original lie.
      newest_content_at: new Date(now - 200 * HOUR),
    }));
    let started = 0;
    const startedAt = performance.now();
    const verdicts = await evaluateSyncFreshnessSources(makeEngine(rows), rows, {
      mode: 'host',
      nowMs: now,
      lockProbe: async () => null,
      gitProbeBudgetMs: 8,
      gitProbeTimeoutMs: 5,
      gitProbeMaxSources: 64,
      gitProbe: async () => {
        started++;
        return new Promise(() => {});
      },
    });
    const elapsed = performance.now() - startedAt;

    expect(started).toBeLessThan(rows.length);
    expect(elapsed).toBeLessThan(100);
    expect(verdicts.every((verdict) => verdict.staleness_class === 'severe')).toBe(true);
  });

  test('host evidence source cap is conservative for unprobed sources', async () => {
    const now = 2_000_000_000_000;
    const rows: SourceFixture[] = ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      local_path: `/registered/${id}`,
      last_sync_at: new Date(now - 88 * HOUR),
      last_commit: 'recorded-head',
      chunker_version: String(CHUNKER_VERSION),
      newest_content_at: new Date(now - 200 * HOUR),
    }));
    let started = 0;
    const verdicts = await evaluateSyncFreshnessSources(makeEngine(rows), rows, {
      mode: 'host',
      nowMs: now,
      lockProbe: async () => null,
      gitProbeBudgetMs: 1_000,
      gitProbeTimeoutMs: 100,
      gitProbeMaxSources: 1,
      gitProbe: async () => {
        started++;
        return 'unchanged';
      },
    });

    expect(started).toBe(1);
    expect(verdicts.map((verdict) => verdict.staleness_class)).toEqual([
      'fresh', 'severe', 'severe',
    ]);
  });
});
