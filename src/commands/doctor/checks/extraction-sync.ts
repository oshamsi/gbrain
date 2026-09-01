/**
 * Extraction + sync-lag check cluster (incl. checkSyncFreshness) — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import {
  evaluateSyncFreshnessSources,
  loadOperationalSyncSources,
  type SyncFreshnessMode,
} from '../../../core/sync-freshness.ts';
import { resolveEnvNumber, warnOnceForEnv } from '../../../core/env-number.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../../core/link-extraction.ts';
import { isUndefinedColumnError } from '../../../core/utils.ts';
import {
  loadStorageConfig,
  effectiveDbOnlyDirs,
  DERIVE_PHASE_DB_ONLY_DEFAULTS,
  findDbOnlyCollisions,
} from '../../../core/storage-config.ts';
import { slugifyPath, slugifyCodePath, isCodeFilePath } from '../../../core/sync.ts';
import { resolveSourceLocalFilePath } from '../../../core/markdown.ts';
import { unverifiedExtractionFragment } from '../../../core/extraction-review.ts';
import type { Check } from '../../doctor.ts';

/** Local aliases; the shared warn-once memo lives in core so it can't fork per module. */
const _resolveEnvNumber = resolveEnvNumber;

/**
 * v0.42.7 (#1696): single source of truth for the extraction-lag warn
 * threshold (percent). Both the `links_extraction_lag` doctor check AND the
 * end-of-sync nudge (`sync.ts:maybeExtractionNudge`) resolve through this +
 * `_resolveEnvNumber` so "the nudge fires iff doctor would warn" can't drift.
 */
export const EXTRACTION_LAG_WARN_PCT_DEFAULT = 20;
/** Min non-deleted page count below which extraction-lag is vacuous-skipped
 *  (unless an explicit --source scope is set). Shared by doctor + the sync
 *  nudge (D6/C4) so their skip predicates match exactly. */
export const EXTRACTION_LAG_MIN_PAGES = 100;

/**
 * Sync freshness check (v0.32.4) — verify that sources with local_path have
 * been synced recently. Detects the silent failure mode where `gbrain sync`
 * stopped running and brain search now misses recent pages.
 *
 * Classification is delegated to `core/sync-freshness.ts`, the same evaluator
 * used by `get_status_snapshot`. The host-aware mode checks only registered
 * source rows, uses shell-free Git argv calls with timeouts, and falls back to
 * the stored content timestamp when a checkout is unavailable. Callers that
 * cannot inspect the host can explicitly request `freshnessMode: 'stored'`.
 *
 * Thresholds (env-overridable, default = 24h warn / 72h fail):
 *   - GBRAIN_SYNC_FRESHNESS_WARN_HOURS
 *   - GBRAIN_SYNC_FRESHNESS_FAIL_HOURS
 * Invalid values (NaN, ≤0) fall back to defaults with a once-per-process warn.
 *
 * Edge cases handled:
 *   - last_sync_at IS NULL → fail "never synced"
 *   - last_sync_at > now() (clock skew / corrupted timestamp) → warn
 *   - mixed sources → highest-severity drives the overall status
 *   - executeRaw throws → outer-catch warn so doctor keeps running
 *
 * Failure messages embed `source.id` so the fix command
 * `gbrain sync --source <id>` matches what the user copy-pastes.
 */

/**
 * v0.42.7 (#1696) — links_extraction_lag doctor check.
 *
 * The signal that surfaces the "imported ≠ curated" root cause: pages whose
 * link/timeline extraction is stale (never run, edited-since, or extractor
 * bumped). Without it, a brain can run for months at 0% typed-edge coverage
 * with nothing warning the operator.
 *
 * Warn-only by DEFAULT (>20% stale). Hard-fail ONLY when the operator opts in
 * via GBRAIN_EXTRACTION_LAG_FAIL_PCT — so a just-upgraded 280K-page brain
 * (every page NULL → 100% stale) gets a loud WARN, never a non-zero exit that
 * would break a CI/cron pipeline gating on `gbrain doctor`.
 *
 * Vacuous-skip on tiny brains (<100 pages, no --source) like orphan_ratio.
 * Pre-v112 brains (column missing) degrade to OK via isUndefinedColumnError.
 * Strictly SQL — no filesystem/git access — so it's safe to wire into the
 * thin-client doctorReportRemote path (CDX-5 trust boundary).
 *
 * `opts.sourceId` scopes both the denominator and the stale count to one
 * source (the explicit-only `--source` parse, like orphan_ratio).
 */
export async function checkLinksExtractionLag(
  engine: BrainEngine,
  opts?: { sourceId?: string },
): Promise<Check> {
  const name = 'links_extraction_lag';
  const sourceId = opts?.sourceId;
  const fix = "Run: gbrain extract --stale";
  try {
    const totalRows = await engine.executeRaw<{ count: number }>(
      sourceId
        ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
        : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
      sourceId ? [sourceId] : [],
    );
    const total = Number(totalRows[0]?.count ?? 0);
    if (total === 0) {
      return { name, status: 'ok', message: 'Extraction lag not applicable (no pages)' };
    }
    // Vacuous-skip tiny brains unless explicitly source-scoped. Shared floor
    // const so the sync nudge (D6/C4) skips on the exact same predicate.
    if (total < EXTRACTION_LAG_MIN_PAGES && !sourceId) {
      return { name, status: 'ok', message: `Extraction lag not applicable (${total} pages — too few to assess)` };
    }

    const stale = await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS });
    const pct = (stale / total) * 100;
    const pctStr = pct.toFixed(0);
    const scope = sourceId ? ` in source '${sourceId}'` : '';

    const warnPct = _resolveEnvNumber('GBRAIN_EXTRACTION_LAG_WARN_PCT', EXTRACTION_LAG_WARN_PCT_DEFAULT, { unit: '%' });
    // Fail threshold is DISABLED unless explicitly set (warn-only default). A
    // bare unset env var → no hard-fail; invalid value → warn-once + disabled.
    let failPct: number | undefined;
    const failRaw = process.env.GBRAIN_EXTRACTION_LAG_FAIL_PCT;
    if (failRaw !== undefined && failRaw !== '') {
      const n = Number(failRaw);
      if (Number.isFinite(n) && n > 0) {
        failPct = n;
      } else {
        warnOnceForEnv(
          'GBRAIN_EXTRACTION_LAG_FAIL_PCT',
          `[gbrain] Ignoring invalid GBRAIN_EXTRACTION_LAG_FAIL_PCT=${failRaw}; hard-fail stays disabled.`,
        );
      }
    }

    const details = { total, stale, pct: Number(pctStr), warn_pct: warnPct, fail_pct: failPct ?? null, source_id: sourceId ?? null };
    if (failPct !== undefined && pct > failPct) {
      return { name, status: 'fail', message: `${stale}/${total} pages (${pctStr}%)${scope} need link/timeline extraction (> ${failPct}% fail threshold). ${fix}`, details };
    }
    if (pct > warnPct) {
      return { name, status: 'warn', message: `${stale}/${total} pages (${pctStr}%)${scope} have un-extracted edges. ${fix}`, details };
    }
    return { name, status: 'ok', message: `Extraction current: ${stale}/${total} pages (${pctStr}%) stale${scope}`, details };
  } catch (e) {
    // Pre-v112 brain: links_extracted_at column doesn't exist yet. Graceful OK
    // (migration/bootstrap adds it; nothing to assess until then).
    if (isUndefinedColumnError(e, 'links_extracted_at')) {
      return { name, status: 'ok', message: 'links_extracted_at not present (pre-v112 brain)' };
    }
    return { name, status: 'warn', message: `Could not check links_extraction_lag: ${(e as Error).message}` };
  }
}

/**
 * issue #160 — unverified_extractions doctor check.
 *
 * The extraction quarantine lane parks auto-extracted entity stubs
 * (frontmatter `provenance: 'auto-extracted'` + `status: 'unverified'`)
 * until the owner promotes or rejects them. A queue nobody reviews decays
 * into invisible clutter, so this check counts stubs older than N days
 * (default 7) and nudges toward the review surface. Exported for direct
 * testing (mirrors checkLinksExtractionLag).
 */
export async function checkUnverifiedExtractions(
  engine: BrainEngine,
  opts?: { sourceId?: string; days?: number },
): Promise<Check> {
  const name = 'unverified_extractions';
  const days = opts?.days ?? 7;
  const sourceId = opts?.sourceId;
  try {
    const params: unknown[] = [String(days)];
    let srcClause = '';
    if (sourceId) {
      params.push(sourceId);
      srcClause = 'AND p.source_id = $2';
    }
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${unverifiedExtractionFragment('p')}
         AND p.created_at < now() - ($1 || ' days')::interval
         ${srcClause}`,
      params,
    );
    const n = Number(rows[0]?.n ?? 0);
    return {
      name,
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} unverified auto-extracted entity stub(s) older than ${days} days awaiting review. List with 'gbrain extraction-pending'; promote/reject with 'gbrain extraction-review <promote|reject> --slugs <slug,...>'.`
        : 'No stale unverified extraction stubs',
      details: { count: n, days, source_id: sourceId ?? null },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check unverified_extractions: ${(e as Error).message}` };
  }
}

/**
 * issue #2250 (reported by @615Works) — content_hash_duplicates.
 *
 * `gbrain import` run from the wrong root (one level too deep) drops the
 * path prefix from every slug, leaving `people/x` and `x` coexisting with
 * identical content. `dream --phase purge` never removes them (they aren't
 * file-backed orphans) and nothing surfaced the condition. One GROUP BY —
 * never an N² hash comparison — flags hash groups that contain BOTH a bare
 * slug (no '/') and a path-prefixed slug.
 */
export async function checkContentHashDuplicates(engine: BrainEngine): Promise<Check> {
  const name = 'content_hash_duplicates';
  const fix = 'Fix: gbrain pages delete <bare-slug> for each pair, then gbrain pages purge-deleted --older-than 0';
  try {
    // #3946: no shape predicates — EVERY same-source duplicate-content group
    // surfaces (HAVING count(*) > 1 alone). Classification happens at render:
    // a group holding BOTH a bare and a path-prefixed slug is the wrong-root
    // import pattern (the bare slug is the accident, so the delete hint is
    // safe); a group WITHOUT that shape (all-nested, or distinct bare slugs)
    // is listed with NO delete hint (#3942 — either copy may be the canonical
    // one that links point at, so deleting one automatically is a guess).
    const rows = await engine.executeRaw<{ source_id: string; content_hash: string; slugs: string }>(
      `SELECT source_id, content_hash,
              string_agg(slug, '|' ORDER BY length(slug), slug) AS slugs
         FROM pages
        WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash <> ''
        GROUP BY source_id, content_hash
       HAVING count(*) > 1
        LIMIT 50`,
    );
    if (rows.length === 0) {
      return { name, status: 'ok', message: 'No same-source content-hash duplicate groups' };
    }
    let pairCount = 0;
    const samples: string[] = [];
    let otherGroupCount = 0;
    const otherSamples: string[] = [];
    for (const r of rows) {
      const slugs = String(r.slugs).split('|');
      const bare = slugs.filter(s => !s.includes('/'));
      const prefixed = slugs.filter(s => s.includes('/'));
      if (bare.length > 0 && prefixed.length > 0) {
        for (const b of bare) {
          const twin = prefixed.find(p => p.endsWith('/' + b)) ?? prefixed[0];
          pairCount++;
          if (samples.length < 5) samples.push(`${b} <-> ${twin}`);
        }
      } else {
        otherGroupCount++;
        if (otherSamples.length < 5) otherSamples.push(slugs.join(' == '));
      }
    }
    const parts: string[] = [];
    if (pairCount > 0) {
      parts.push(
        `${pairCount} content-hash duplicate pair(s) detected (same content, differing slug forms — ` +
        `usually an import run from the wrong root, which drops the path prefix). ` +
        `Sample: ${samples.join('; ')}. ${fix}`,
      );
    }
    if (otherGroupCount > 0) {
      parts.push(
        `${otherGroupCount} duplicate-content group(s) with distinct slugs (no bare/nested wrong-root shape). ` +
        `Sample: ${otherSamples.join('; ')}. Review which slug is canonical and consolidate manually — ` +
        `no automatic delete hint (either copy may be the one links point at).`,
      );
    }
    return {
      name,
      status: 'warn',
      message: parts.join(' '),
      details: {
        pair_count: pairCount,
        hash_groups: rows.length,
        sample_pairs: samples,
        distinct_slug_group_count: otherGroupCount,
        sample_distinct_slug_groups: otherSamples,
      },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check content-hash duplicates: ${(e as Error).message}` };
  }
}

/**
 * issue #3970 — code_chunk_metadata.
 *
 * Code pages whose chunks carry NO symbol metadata (symbol_name IS NULL AND
 * language IS NULL) were chunked before the v0.19/v0.21 code chunker or
 * re-imported through the markdown path — `code-def`, `code-refs`, and
 * `query --lang/--symbol-kind` silently miss them. A plain sync or
 * `reindex-code` never heals them (importCodeFile's content_hash
 * short-circuit skips unchanged pages), so the cure is
 * `gbrain reindex-code --force`. Raw SQL only (works on both engines).
 */
export async function checkCodeChunkMetadata(engine: BrainEngine): Promise<Check> {
  const name = 'code_chunk_metadata';
  try {
    const rows = await engine.executeRaw<{ chunks: string | number; pages: string | number }>(
      `SELECT COUNT(*)::text AS chunks, COUNT(DISTINCT c.page_id)::text AS pages
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.type = 'code' AND p.deleted_at IS NULL
          AND c.symbol_name IS NULL AND c.language IS NULL`,
    );
    const chunks = Number(rows[0]?.chunks ?? 0);
    const pages = Number(rows[0]?.pages ?? 0);
    if (chunks === 0) {
      return { name, status: 'ok', message: 'All code-page chunks carry symbol metadata' };
    }
    return {
      name,
      status: 'warn',
      message:
        `${chunks} chunk(s) on ${pages} code page(s) have no symbol metadata ` +
        `(symbol_name and language both NULL) — code-def/code-refs and ` +
        `--lang/--symbol-kind filters miss them. A plain sync/reindex skips ` +
        `unchanged pages via the content_hash short-circuit. ` +
        `Fix: gbrain reindex-code --force`,
      details: { chunks_missing_metadata: chunks, pages_affected: pages },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check code chunk metadata: ${(e as Error).message}` };
  }
}

/** Walk a repo for markdown files and return their slugified (lowercased) slugs. */
function collectMarkdownSlugs(root: string): Set<string> {
  const out = new Set<string>();
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Hidden directories can contain canonical, tracked knowledge (for
      // example `.archive/`). Only implementation metadata is never a page.
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (/\.mdx?$/i.test(e.name)) out.add(slugifyPath(childRel).toLowerCase());
      // #3766: code files are pages too (code-slug shape). Legacy code rows
      // backfilled by migration 25 carry page_kind='markdown' without a
      // type='code' re-stamp, so their slugs must count as file-backed or
      // every one of them false-positives as "DB-only".
      else if (isCodeFilePath(e.name)) out.add(slugifyCodePath(childRel).toLowerCase());
    }
  }
  return out;
}

/**
 * issue #2784 (reported by @alexputici) — undeclared_db_only_pages.
 *
 * A markdown page with no backing file that sits outside every declared
 * db_only path is invisible to any file-lane backup/recovery reasoning: an
 * operator auditing "what would survive a DB loss" gets a silently wrong
 * answer. The engine's own derive-phase output prefixes
 * (DERIVE_PHASE_DB_ONLY_DEFAULTS) count as implicitly declared so the check
 * stays quiet on healthy brains. Deliberately allowed to stat the source
 * repo (the one thing the SQL-only check registry could never see).
 */
export async function checkUndeclaredDbOnlyPages(engine: BrainEngine): Promise<Check> {
  const name = 'undeclared_db_only_pages';
  try {
    // #3880: archived sources are out of scope for filesystem audits (v34
    // legacy fallback, house style per pickSoleNonDefaultSource).
    let sources: Array<{ id: string; local_path: string | null }>;
    try {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
      );
    } catch {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
      );
    }
    const checkable = sources.filter(s => s.local_path && existsSync(s.local_path));
    if (checkable.length === 0) {
      return { name, status: 'ok', message: 'Not applicable (no sources with a local repo path on this host)' };
    }
    let total = 0;
    const samples: string[] = [];
    const perSource: Record<string, number> = {};
    for (const src of checkable) {
      let declared: string[] = [];
      try {
        declared = loadStorageConfig(src.local_path)?.db_only ?? [];
      } catch {
        // invalid gbrain.yml — treated as no declarations; the sync path
        // already surfaces the config error itself.
      }
      const dbOnlyDirs = effectiveDbOnlyDirs(declared);
      // #3766: skip properly-stamped code pages (type='code') — they live on
      // the code lane, not the markdown backup story. Legacy code rows from
      // the migration-25 backfill (page_kind='markdown', type never
      // re-stamped) still flow through and match via the code-slug backed
      // set collected below.
      const rows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
        `SELECT slug, source_path FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND page_kind = 'markdown' AND type IS DISTINCT FROM 'code'`,
        [src.id],
      );
      if (rows.length === 0) continue;
      let backedWithoutSourcePath: Set<string> | null = null;
      for (const { slug, source_path: sourcePath } of rows) {
        if (dbOnlyDirs.some(dir => slug.startsWith(dir))) continue;
        if (sourcePath) {
          const filePath = resolveSourceLocalFilePath(src.local_path!, sourcePath);
          if (filePath && existsSync(filePath)) continue;
        } else {
          backedWithoutSourcePath ??= collectMarkdownSlugs(src.local_path!);
          if (backedWithoutSourcePath.has(slug.toLowerCase())) continue;
        }
        total++;
        perSource[src.id] = (perSource[src.id] ?? 0) + 1;
        if (samples.length < 5) samples.push(`${slug} (src=${src.id})`);
      }
    }
    if (total === 0) {
      return {
        name,
        status: 'ok',
        message: `Every DB page is file-backed or under a declared/default db_only path (derive-phase defaults: ${DERIVE_PHASE_DB_ONLY_DEFAULTS.join(' ')})`,
      };
    }
    return {
      name,
      status: 'warn',
      message: `${total} DB page(s) have no backing file and sit outside every declared/default db_only path — invisible to file-lane backup/recovery. Sample: ${samples.join('; ')}. Fix: restore or export the files, or declare their prefixes under storage.db_only in gbrain.yml (derive-phase defaults already cover: ${DERIVE_PHASE_DB_ONLY_DEFAULTS.join(' ')})`,
      details: { total, per_source: perSource, sample_slugs: samples },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check undeclared db-only pages: ${(e as Error).message}` };
  }
}

/**
 * issue #2788 (reported by @alexputici) — db_only_collector_collision.
 *
 * Declaring a collector's output dir in storage.db_only silently kills its
 * ingestion: manageGitignore auto-gitignores the dir, the git-walking sync
 * never sees the files, and import honors .gitignore too — everything stays
 * green while nothing reaches the DB (a 7-week outage in the field). The
 * recipe's `output_paths` frontmatter is the ground truth; the same warning
 * also fires at .gitignore-write time inside sync's manageGitignore.
 */
export async function checkDbOnlyCollectorCollision(
  engine: BrainEngine,
  opts?: { collectors?: Array<{ id: string; output_path: string }> },
): Promise<Check> {
  const name = 'db_only_collector_collision';
  try {
    let collectors = opts?.collectors;
    if (!collectors) {
      const { getConfiguredCollectorOutputs } = await import('../../integrations.ts');
      collectors = getConfiguredCollectorOutputs();
    }
    if (collectors.length === 0) {
      return { name, status: 'ok', message: 'No configured collectors declare output paths' };
    }
    // #3880: skip archived sources (v34 legacy fallback).
    let sources: Array<{ id: string; local_path: string | null }>;
    try {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
      );
    } catch {
      sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
      );
    }
    const hits: string[] = [];
    for (const src of sources) {
      if (!src.local_path || !existsSync(src.local_path)) continue;
      let dbOnly: string[] = [];
      try {
        dbOnly = loadStorageConfig(src.local_path)?.db_only ?? [];
      } catch {
        continue;
      }
      if (dbOnly.length === 0) continue;
      for (const hit of findDbOnlyCollisions(collectors, dbOnly)) {
        hits.push(`collector '${hit.id}' writes to '${hit.output_path}' which is inside db_only path '${hit.db_only_dir}' (source ${src.id})`);
      }
    }
    if (hits.length === 0) {
      return { name, status: 'ok', message: 'No collector output dir falls inside a db_only path' };
    }
    return {
      name,
      status: 'warn',
      message: `${hits.length} collector/db_only collision(s): ${hits.join('; ')}. db_only dirs are auto-gitignored, so sync AND import silently skip files there — the collector runs green while nothing reaches the DB. Fix: remove the prefix from storage.db_only in gbrain.yml, or move the collector output.`,
      details: { collisions: hits },
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check collector/db_only collisions: ${(e as Error).message}` };
  }
}

type ExtractAtomsBacklogCounter = (engine: BrainEngine, sourceId?: string) => Promise<number | null>;

async function countExtractAtomsBacklogBySource(
  engine: BrainEngine,
  countBacklog: ExtractAtomsBacklogCounter,
): Promise<Array<{ source_id: string; backlog: number }> | null> {
  try {
    const sources = await engine.executeRaw<{ source_id: string }>(
      `SELECT DISTINCT source_id FROM pages WHERE deleted_at IS NULL ORDER BY source_id`,
    );
    const rows: Array<{ source_id: string; backlog: number }> = [];
    for (const src of sources) {
      const backlog = await countBacklog(engine, src.source_id);
      if (backlog === null) return null;
      if (backlog > 0) rows.push({ source_id: src.source_id, backlog });
    }
    return rows;
  } catch {
    return null;
  }
}

function buildExtractAtomsBacklogFixHint(
  bySource: Array<{ source_id: string; backlog: number }> | null,
): string {
  const suffix = '(or declare extract_atoms in your active schema pack)';
  if (!bySource || bySource.length === 0) {
    return `gbrain dream --phase extract_atoms --drain --source <source-id> --window 120 ${suffix}`;
  }
  if (bySource.length === 1) {
    return `gbrain dream --phase extract_atoms --drain --source ${bySource[0]!.source_id} --window 120 ${suffix}`;
  }
  const sources = bySource.map((row) => row.source_id).join(', ');
  return `gbrain dream --phase extract_atoms --drain --source ${bySource[0]!.source_id} --window 120 (repeat for backlog source(s): ${sources}; or declare extract_atoms in your active schema pack)`;
}

/**
 * issue #1678 — extract_atoms_backlog doctor check.
 *
 * Closes the "silent backlog" gap: extract_atoms is pack-gated, so on a brain
 * whose active pack doesn't declare the phase it NEVER runs in the routine
 * cycle and pages accumulate forever with zero signal (the cycle reports a
 * clean `skipped`). This check counts the eligible-but-unextracted pages and,
 * when the pack doesn't run the phase AND the backlog is real, WARNs with the
 * exact `--drain` command.
 *
 * PAGE-BACKLOG-ONLY (Codex #11): extract_atoms also discovers transcript files
 * at runtime; this counts DB pages only — labeled in details. No
 * synthesize_concepts sibling this wave (Codex #12: that phase is a stub with
 * no real eligibility predicate; a check would be a fake signal).
 */
export async function computeExtractAtomsBacklogCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'extract_atoms_backlog';
  const approx = 'page backlog only; transcript corpus not counted';
  try {
    const { countExtractAtomsBacklog } = await import('../../../core/cycle/extract-atoms.ts');
    const backlog = await countExtractAtomsBacklog(engine); // brain-wide
    if (backlog === null) {
      return { name, status: 'warn', message: 'backlog query failed (could not count eligible pages)' };
    }

    const { packDeclaresPhase } = await import('../../../core/cycle.ts');
    let declared = false;
    try { declared = await packDeclaresPhase(engine, 'extract_atoms'); } catch { declared = false; }

    if (backlog === 0) {
      return {
        name, status: 'ok',
        message: 'no pages awaiting atom extraction',
        details: { backlog, pack_declares_phase: declared, known_approximation: approx },
      };
    }

    // The incident: pack does NOT run the phase but a real backlog exists →
    // it will grow forever without a signal. WARN with the drain command.
    if (!declared && backlog > 10) {
      const backlogBySource = await countExtractAtomsBacklogBySource(engine, countExtractAtomsBacklog);
      const fix = buildExtractAtomsBacklogFixHint(backlogBySource);
      return {
        name, status: 'warn',
        message: `${backlog} pages eligible for atom extraction but the active pack does not run extract_atoms — backlog growing. Fix: ${fix}`,
        details: { backlog, backlog_by_source: backlogBySource ?? undefined, pack_declares_phase: false, fix_hint: fix, known_approximation: approx },
      };
    }

    if (declared) {
      // Pack runs it; the routine cycle drains in bounded batches. Informational.
      return {
        name, status: 'ok',
        message: `${backlog} page(s) pending; active pack runs extract_atoms each cycle`,
        details: { backlog, pack_declares_phase: true, known_approximation: approx },
      };
    }

    // Not declared but below the warn threshold.
    return {
      name, status: 'ok',
      message: `${backlog} page(s) eligible (below warn threshold; pack does not run extract_atoms)`,
      details: { backlog, pack_declares_phase: false, known_approximation: approx },
    };
  } catch (err) {
    return { name, status: 'warn', message: `extract_atoms_backlog check failed: ${(err as Error).message}` };
  }
}

/**
 * v0.42 — extract_health doctor check.
 *
 * Reads the extract_rollup_7d table (migration v106) for the last 7 days
 * and reports per-kind aggregates. Stable JSON envelope schema_version:1.
 *
 * 3-state status:
 *   - OK when rollup is empty (no extractions yet) OR every per-kind
 *     halt rate is below the warn threshold.
 *   - WARN when any per-kind halt rate exceeds 10% (operator-visible
 *     signal that an extractor is failing too often).
 *   - WARN when rollup_write_failures > 0 (audit JSONL is the source of
 *     truth but operator should know the DB cache is degraded).
 *
 * Per-kind columns (per plan A5 + D-EXTRACT-32 spec):
 *   cost_7d_usd, eval_pass_count, eval_fail_count, halt_count,
 *   round_completed_count, last_updated_at
 *
 * The check is empty-rollup-tolerant: a brain that has never extracted
 * shows OK with `kinds: []` rather than warning. Doctor latency stays
 * under 100ms regardless of brain size because the rollup table
 * pre-aggregates (rolled-up at audit-emitter time per F-OUT-19).
 *
 * Empty rollup short-circuits BEFORE hitting the rollup_write_failures
 * branch so a brand-new brain doesn't surface a "0 failures" warning.
 */
export async function computeExtractHealthCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'extract_health';
  try {
    type RollupRow = {
      kind: string;
      cost_7d_usd: number;
      eval_pass_count: number;
      eval_fail_count: number;
      halt_count: number;
      round_completed_count: number;
      rollup_write_failures: number;
      last_updated_at: Date | string | null;
    };

    const rows = await engine.executeRaw<RollupRow>(
      `SELECT
         kind,
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count) AS eval_pass_count,
         SUM(eval_fail_count) AS eval_fail_count,
         SUM(halt_count) AS halt_count,
         SUM(round_completed_count) AS round_completed_count,
         SUM(rollup_write_failures) AS rollup_write_failures,
         MAX(updated_at) AS last_updated_at
       FROM extract_rollup_7d
       WHERE day >= CURRENT_DATE - 7
       GROUP BY kind
       ORDER BY kind`,
      [],
    );

    if (rows.length === 0) {
      return {
        name,
        status: 'ok',
        message: 'no extractions in last 7 days',
        details: {
          schema_version: 1,
          kinds: [],
        },
      };
    }

    type KindAggregate = {
      kind: string;
      cost_7d_usd: number;
      eval_pass_count: number;
      eval_fail_count: number;
      halt_count: number;
      round_completed_count: number;
      halt_rate: number;
      last_updated_at: string | null;
    };

    const kinds: KindAggregate[] = rows.map(r => {
      const halts = Number(r.halt_count) || 0;
      const completed = Number(r.round_completed_count) || 0;
      const total = halts + completed;
      return {
        kind: r.kind,
        cost_7d_usd: Number(r.cost_7d_usd) || 0,
        eval_pass_count: Number(r.eval_pass_count) || 0,
        eval_fail_count: Number(r.eval_fail_count) || 0,
        halt_count: halts,
        round_completed_count: completed,
        halt_rate: total > 0 ? halts / total : 0,
        last_updated_at: r.last_updated_at
          ? new Date(r.last_updated_at).toISOString()
          : null,
      };
    });

    const totalRollupFailures = rows.reduce(
      (acc, r) => acc + (Number(r.rollup_write_failures) || 0),
      0,
    );

    // High halt rates: per F-OUT-19 doctor surfaces extractor health
    // distinctly from rollup write health.
    const highHaltKinds = kinds.filter(k => k.halt_rate > 0.10);

    if (highHaltKinds.length > 0) {
      const top3 = [...highHaltKinds]
        .sort((a, b) => b.halt_rate - a.halt_rate)
        .slice(0, 3)
        .map(k => `${k.kind}=${(k.halt_rate * 100).toFixed(1)}%`)
        .join(', ');
      return {
        name,
        status: 'warn',
        message: `${highHaltKinds.length} kind(s) with halt rate > 10% (top: ${top3})`,
        details: {
          schema_version: 1,
          kinds,
          rollup_write_failures_7d: totalRollupFailures,
        },
      };
    }

    if (totalRollupFailures > 0) {
      return {
        name,
        status: 'warn',
        // #3697: this hint used to name `gbrain extract status --rebuild-rollup`,
        // which does not exist (the JSONL→rollup rebuild is a planned self-heal,
        // not a shipped command). Say what is true instead of sending the
        // operator to a usage error.
        message: `${totalRollupFailures} rollup write failure(s) in last 7d. The rollup table is a best-effort cache — the audit JSONL under ~/.gbrain/audit/ is the source of truth, and counts here may undercount until the 7-day window rolls past the failures. No action needed unless failures keep accumulating (then check DB connectivity/permissions).`,
        details: {
          schema_version: 1,
          kinds,
          rollup_write_failures_7d: totalRollupFailures,
        },
      };
    }

    return {
      name,
      status: 'ok',
      message: `${kinds.length} kind(s) tracked, all halt rates below 10%`,
      details: {
        schema_version: 1,
        kinds,
        rollup_write_failures_7d: totalRollupFailures,
      },
    };
  } catch (err) {
    // Pre-v106 brains lack the extract_rollup_7d table. Don't warn — the
    // bootstrap-coverage / migration framework brings the schema forward
    // and the next run resolves naturally. Stay quiet.
    const msg = (err as Error).message || String(err);
    if (/extract_rollup_7d.*does not exist|no such table/i.test(msg)) {
      return {
        name,
        status: 'ok',
        message: 'extract_rollup_7d not yet present (pre-v0.42 brain or fresh init)',
      };
    }
    return {
      name,
      status: 'warn',
      message: `rollup query failed: ${msg}`,
    };
  }
}

export async function checkSyncFreshness(
  engine: BrainEngine,
  opts?: { nowMs?: number; localOnly?: boolean; freshnessMode?: SyncFreshnessMode },
): Promise<Check> {
  try {
    const sources = await loadOperationalSyncSources(engine);

    if (sources.length === 0) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: 'No federated sources to sync',
        details: {
          unchanged_count: 0,
          synced_recently_count: 0,
          stale_count: 0,
          source_verdicts: [],
        },
      };
    }

    // The default is the host-aware path for both local doctor and the admin
    // MCP doctor surface. `localOnly:false` remains an explicit escape hatch
    // for callers that require the stored-column-only posture.
    const mode = opts?.freshnessMode ?? (opts?.localOnly === false ? 'stored' : 'host');
    const verdicts = await evaluateSyncFreshnessSources(engine, sources, {
      nowMs: opts?.nowMs,
      mode,
    });

    const issues: string[] = [];
    const inProgress: string[] = [];
    let unchanged_count = 0;
    let synced_recently_count = 0;
    let stale_count = 0;
    let hasWarnings = false;
    let hasFailures = false;
    for (const verdict of verdicts) {
      const display = verdict.source_name && verdict.source_name !== verdict.source_id
        ? `'${verdict.source_id}' (${verdict.source_name})`
        : `'${verdict.source_id}'`;
      const ageMs = verdict.threshold_age_ms ?? 0;
      const ageHours = Math.floor(ageMs / 3_600_000);
      const ageDays = Math.floor(ageHours / 24);

      if (verdict.reason === 'unchanged') unchanged_count++;
      else if (verdict.check_status === 'ok') synced_recently_count++;
      else stale_count++;

      if (verdict.check_status === 'fail') hasFailures = true;
      if (verdict.check_status === 'warn') hasWarnings = true;

      switch (verdict.reason) {
        case 'sync_in_progress': {
          const lock = verdict.lock!;
          inProgress.push(`${display} sync in progress (pid ${lock.holder_pid} on ${lock.holder_host})`);
          break;
        }
        case 'wedged_sync_lock': {
          const lock = verdict.lock!;
          const heldFor = lock.age_ms >= 3_600_000
            ? `${Math.floor(lock.age_ms / 3_600_000)}h`
            : `${Math.max(1, Math.floor(lock.age_ms / 60_000))}m`;
          issues.push(
            `Source ${display} has held the sync lock for ${heldFor} ` +
            `(pid ${lock.holder_pid} on ${lock.holder_host}) — heartbeating but not finishing. ` +
            `Run \`gbrain sync --break-lock --source ${verdict.source_id}\` after confirming the holder is wedged.`,
          );
          break;
        }
        case 'never_synced':
          issues.push(`Source ${display} has never been synced`);
          break;
        case 'invalid_last_sync':
          issues.push(`Source ${display} has an invalid last_sync_at timestamp`);
          break;
        case 'future_last_sync':
          issues.push(`Source ${display} has future last_sync_at — clock skew or corrupted timestamp`);
          break;
        case 'fail_age':
          issues.push(`Source ${display} last synced ${ageDays}d ago — brain search is stale!`);
          break;
        case 'warn_age':
          issues.push(`Source ${display} last synced ${ageHours}h ago`);
          break;
        case 'unchanged':
        case 'recent':
          break;
      }
    }

    const details = {
      unchanged_count,
      synced_recently_count,
      stale_count,
      source_verdicts: verdicts.map((verdict) => ({
        source_id: verdict.source_id,
        staleness_class: verdict.staleness_class,
        check_status: verdict.check_status,
        reason: verdict.reason,
        raw_age_hours: verdict.raw_age_ms === null
          ? null
          : Math.round((verdict.raw_age_ms / 3_600_000) * 10) / 10,
        staleness_hours: verdict.threshold_age_ms === null
          ? null
          : Math.round((verdict.threshold_age_ms / 3_600_000) * 10) / 10,
      })),
    };
    const inProgressNote = inProgress.length ? `. ${inProgress.join('; ')}` : '';

    if (hasFailures) {
      return {
        name: 'sync_freshness',
        status: 'fail',
        message: `${issues.join('; ')}. Run \`gbrain sync --source <id>\` for each stale source${inProgressNote}`,
        details,
      };
    }
    if (hasWarnings) {
      return {
        name: 'sync_freshness',
        status: 'warn',
        message: `${issues.join('; ')}. Run \`gbrain sync --source <id>\` to refresh${inProgressNote}`,
        details,
      };
    }
    // v0.41.27.0: D2 ok-message reshape. Three branches surface what the
    // git short-circuit actually did so operators understand "unchanged
    // since last sync" vs "synced recently".
    if (unchanged_count === sources.length) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: `All ${sources.length} federated source(s) up to date (no new commits since last sync)${inProgressNote}`,
        details,
      };
    }
    if (unchanged_count > 0) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: `${sources.length} federated source(s): ${synced_recently_count} synced recently, ${unchanged_count} unchanged since last sync${inProgressNote}`,
        details,
      };
    }
    return {
      name: 'sync_freshness',
      status: 'ok',
      message: `All ${sources.length} federated source(s) synced recently${inProgressNote}`,
      details,
    };
  } catch (e) {
    return {
      name: 'sync_freshness',
      status: 'warn',
      message: `Could not check sync freshness: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}


export async function checkStoreFileParity(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<Check> {
  const name = 'store_file_parity';
  try {
    const { computeStoreFileParity } = await import('../../../core/page-plane-parity.ts');
    const report = await computeStoreFileParity(engine, opts);
    const sample = report.sample.map((s) => `${s.slug} (${s.reason})`).join(', ');
    const sourceHint = opts.sourceId ?? '<source-id>';
    const rem = `Fix: gbrain pages converge-canonical --source ${sourceHint}`;
    if (report.divergent_pages === 0) {
      return {
        name,
        status: 'ok',
        message: `Canonical store/file parity: ${report.checked_pages} page(s) checked, 0 divergent (${report.not_projected_pages} not projected)`,
        details: report as unknown as Record<string, unknown>,
      };
    }
    return {
      name,
      status: 'warn',
      message: `Canonical store/file parity: ${report.divergent_pages} divergent of ${report.eligible_pages} eligible (stale=${report.stale_projections}, hash=${report.hash_mismatches}, size=${report.size_mismatches}, missing=${report.missing_files}, unreadable=${report.unreadable_files}, unmeasured=${report.unmeasured_pages}). Sample: ${sample || 'none'}. ${rem}`,
      details: report as unknown as Record<string, unknown>,
    };
  } catch (e) {
    return { name, status: 'warn', message: `Could not check store/file parity: ${(e as Error).message}` };
  }
}
