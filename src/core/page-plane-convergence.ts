/**
 * One-time canonical-plane convergence: backfill stored projections and
 * rewrite existing files that differ. Dry-run is the default.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from './engine.ts';
import { fetchSource } from './sources-load.ts';
import { withRefreshingLock, syncLockId } from './db-lock.ts';
import { withPutPageOperationLock } from './ops/put-page-lock.ts';
import {
  buildCanonicalPageProjection,
  generationKey,
  loadCanonicalProjection,
  materializeProvenanceFrontmatter,
  persistCanonicalProjectionFromRow,
  projectionIsFresh,
  resolveSetOnceProvenance,
  sha256Utf8,
  type ProvenanceTuple,
} from './page-canonical.ts';
import { parseMarkdown } from './markdown.ts';
import {
  isWriteThroughDisabled,
  resolvePageWriteTargetFromLoadedMeta,
} from './write-through.ts';
import { msysToNativePath } from './path-confine.ts';
import { atomicWriteFileSync } from './atomic-write.ts';
import { writeSyncAnchor } from './sync-anchor.ts';
import { commitWriteThroughFiles } from './brain-repo-durability.ts';
import {
  effectiveDbOnlyDirs,
  loadStorageConfig,
} from './storage-config.ts';

export type ConvergenceConflict = {
  source_id: string;
  slug: string;
  reason: string;
  expected_hash: string | null;
  actual_hash: string | null;
};

export type ConvergenceReport = {
  source_id: string;
  repo: string | null;
  pre_head: string | null;
  scanned: number;
  projection_backfilled: number;
  already_equal: number;
  would_rewrite: number;
  rewritten: number;
  missing_file: number;
  not_projected: number;
  resumed_canonical_dirty: number;
  conflicts: ConvergenceConflict[];
  errors: Array<{ source_id: string; slug: string; reason: string }>;
  verified_equal: number;
  commit: { created: boolean; sha: string | null; path_count: number };
  post_verify_divergent: number;
  anchor_not_advanced?: boolean;
};

export type ConvergenceResult = {
  report: ConvergenceReport;
  exitCode: number;
};

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

function tryGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

function isTrackedDirty(line: string): boolean {
  return !line.startsWith('??') && !line.startsWith('!!');
}

function dirtyPath(line: string): string {
  const raw = line.slice(3).replace(/\\/g, '/');
  const arrow = raw.indexOf(' -> ');
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
}

function isDbOnlySlug(slug: string, prefixes: readonly string[]): boolean {
  const lower = slug.toLowerCase();
  return prefixes.some((prefix) => {
    const p = prefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    return p.length > 0 && (lower === p || lower.startsWith(`${p}/`));
  });
}

function isGbrainPlaneCommit(subject: string): boolean {
  return subject.startsWith('gbrain: write-through ')
    || subject.startsWith('gbrain: converge canonical page planes (');
}

function journalPath(repo: string, sourceId: string): string {
  return join(repo, '.git', `gbrain-converge-${sourceId}.json`);
}

function writeJournal(repo: string, sourceId: string, preHead: string): void {
  writeFileSync(journalPath(repo, sourceId), JSON.stringify({
    sourceId,
    preHead,
    at: new Date().toISOString(),
  }));
}

function readJournal(repo: string, sourceId: string): { preHead: string } | null {
  const p = journalPath(repo, sourceId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { preHead?: string };
    return parsed.preHead ? { preHead: parsed.preHead } : null;
  } catch {
    return null;
  }
}

function clearJournal(repo: string, sourceId: string): void {
  try { unlinkSync(journalPath(repo, sourceId)); } catch { /* absent is fine */ }
}

async function threePlaneEqual(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  filePath: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{
    canonical_content: string | null;
    canonical_sha256: string | null;
    canonical_size_bytes: string | number | null;
    canonical_input_generation: string | number | null;
    canonical_basis_generation: string | number | null;
  }>(
    `SELECT canonical_content, canonical_sha256, canonical_size_bytes,
            canonical_input_generation, canonical_basis_generation
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, slug],
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || row.canonical_content == null || row.canonical_sha256 == null || row.canonical_size_bytes == null) {
    return false;
  }
  if (generationKey(row.canonical_input_generation) !== generationKey(row.canonical_basis_generation)) {
    return false;
  }
  if (!existsSync(filePath)) return false;
  const file = readFileSync(filePath);
  const fileSha = sha256Utf8(file);
  const contentSha = sha256Utf8(row.canonical_content);
  if (fileSha !== row.canonical_sha256 || contentSha !== row.canonical_sha256) return false;
  const size = Number(row.canonical_size_bytes);
  if (file.length !== size || Buffer.byteLength(row.canonical_content, 'utf8') !== size) return false;
  return true;
}

async function applyTupleThenPersist(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  tuple: ProvenanceTuple,
  semanticContentHash: string,
  snapshot: {
    content_hash: string | null;
    updated_at: Date | string | null;
    canonical_input_generation: string | number | null;
    frontmatter: Record<string, unknown>;
  },
): Promise<boolean> {
  const fm = { ...snapshot.frontmatter };
  materializeProvenanceFrontmatter(fm, tuple);
  const updatedAt = snapshot.updated_at instanceof Date
    ? snapshot.updated_at.toISOString()
    : (snapshot.updated_at ?? null);
  const written = await engine.executeRaw(
    `UPDATE pages SET
       frontmatter = $1::jsonb,
       source_kind = COALESCE(pages.source_kind, $2),
       ingested_via = COALESCE(pages.ingested_via, $3),
       ingested_at = COALESCE(pages.ingested_at, $4::timestamptz),
       content_hash = $5
     WHERE source_id = $6 AND slug = $7 AND deleted_at IS NULL
       AND content_hash IS NOT DISTINCT FROM $8
       AND canonical_input_generation IS NOT DISTINCT FROM $9::bigint
       AND updated_at IS NOT DISTINCT FROM $10::timestamptz
     RETURNING slug`,
    [
      JSON.stringify(fm),
      tuple.source_kind,
      tuple.ingested_via,
      tuple.ingested_at ? tuple.ingested_at.toISOString() : null,
      semanticContentHash,
      sourceId,
      slug,
      snapshot.content_hash,
      snapshot.canonical_input_generation,
      updatedAt,
    ],
  );
  if (!Array.isArray(written) || written.length === 0) return false;
  await persistCanonicalProjectionFromRow(engine, sourceId, slug);
  return true;
}

export async function runCanonicalPlaneConvergence(
  engine: BrainEngine,
  opts: { sourceId: string; yes?: boolean; json?: boolean },
): Promise<ConvergenceResult> {
  const sourceId = opts.sourceId.trim();
  const mutate = opts.yes === true;
  const emptyCommit = { created: false, sha: null as string | null, path_count: 0 };
  const report: ConvergenceReport = {
    source_id: sourceId,
    repo: null,
    pre_head: null,
    scanned: 0,
    projection_backfilled: 0,
    already_equal: 0,
    would_rewrite: 0,
    rewritten: 0,
    missing_file: 0,
    not_projected: 0,
    resumed_canonical_dirty: 0,
    conflicts: [],
    errors: [],
    verified_equal: 0,
    commit: emptyCommit,
    post_verify_divergent: 0,
  };

  if (!sourceId) {
    return { report, exitCode: 2 };
  }

  const source = await fetchSource(engine, sourceId);
  if (!source) {
    report.errors.push({ source_id: sourceId, slug: '', reason: 'source_not_found' });
    return { report, exitCode: 2 };
  }
  const repo = source.local_path ? msysToNativePath(source.local_path) : (await engine.getConfig('sync.repo_path'));
  if (!repo || !existsSync(repo)) {
    report.errors.push({ source_id: sourceId, slug: '', reason: 'repo_not_found' });
    return { report, exitCode: 2 };
  }
  report.repo = repo;

  if (await isWriteThroughDisabled(engine)) {
    report.errors.push({ source_id: sourceId, slug: '', reason: 'write_through_disabled' });
    return { report, exitCode: 2 };
  }

  try {
  return await withRefreshingLock(engine, syncLockId(sourceId), async () => {
    const head = tryGit(repo, ['rev-parse', 'HEAD']);
    const symbolic = tryGit(repo, ['symbolic-ref', '-q', 'HEAD']);
    if (!head) {
      report.errors.push({ source_id: sourceId, slug: '', reason: 'not_a_git_repo' });
      return { report, exitCode: 2 };
    }
    if (symbolic == null) {
      report.errors.push({ source_id: sourceId, slug: '', reason: 'detached_head' });
      return { report, exitCode: 2 };
    }
    report.pre_head = head;

    const statusOut = tryGit(repo, ['status', '--porcelain=v1', '-uall']);
    if (statusOut == null) {
      report.errors.push({ source_id: sourceId, slug: '', reason: 'git_status_failed' });
      return { report, exitCode: 2 };
    }
    const dirty = statusOut.split('\n').filter(Boolean);
    const trackedDirty = dirty.filter(isTrackedDirty).map(dirtyPath);

    const pages = (await engine.listAllPageRefs()).filter((p) => p.source_id === sourceId);

    const otherLocals = new Set<string>();
    const srcRows = await engine.executeRaw<{ id: string; local_path: string | null; archived: boolean | null }>(
      `SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL`,
    ).catch(async () => engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
    ).then((rows) => rows.map((r) => ({ ...r, archived: null as boolean | null }))));
    for (const row of srcRows) {
      if (row.id !== sourceId && row.local_path) otherLocals.add(msysToNativePath(row.local_path));
    }

    let dbOnlyPrefixes: string[] = [];
    try {
      dbOnlyPrefixes = effectiveDbOnlyDirs(loadStorageConfig(repo)?.db_only ?? []);
    } catch {
      dbOnlyPrefixes = [];
    }
    const sourceArchived = (source as { archived?: boolean | null }).archived === true;

    const pathRows = await engine.executeRaw<{
      slug: string;
      source_path: string | null;
      source_uri: string | null;
    }>(
      `SELECT slug, source_path, source_uri FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL`,
      [sourceId],
    );
    const absToSlug = new Map<string, string>();
    for (const row of Array.isArray(pathRows) ? pathRows : []) {
      const target = resolvePageWriteTargetFromLoadedMeta({
        sourceId,
        slug: row.slug,
        sourceLocalPath: source.local_path,
        sourcePath: row.source_path,
        sourceUri: row.source_uri,
        repoPath: repo,
        otherSourceLocalPaths: otherLocals,
      });
      if (target.ok) absToSlug.set(resolve(target.filePath), row.slug);
    }

    const dirtyAbs = new Set<string>();
    if (trackedDirty.length > 0) {
      let allResume = true;
      for (const rel of trackedDirty) {
        const abs = resolve(repo, rel);
        dirtyAbs.add(abs);
        const slug = absToSlug.get(abs);
        if (!slug) {
          allResume = false;
          break;
        }
        const stored = await loadCanonicalProjection(engine, sourceId, slug);
        if (!stored || !existsSync(abs) || sha256Utf8(readFileSync(abs)) !== stored.sha256) {
          allResume = false;
          break;
        }
        report.resumed_canonical_dirty++;
      }
      if (!allResume) {
        report.errors.push({ source_id: sourceId, slug: '', reason: 'dirty_tracked_tree' });
        return { report, exitCode: 2 };
      }
    }

    const recorded = source.last_commit;
    if (recorded) {
      const mb = tryGit(repo, ['merge-base', recorded, head]);
      if (mb !== recorded) {
        report.errors.push({ source_id: sourceId, slug: '', reason: 'anchor_not_ancestor' });
        return { report, exitCode: 2 };
      }
      const subjects = tryGit(repo, ['log', '--format=%s', `${recorded}..${head}`]);
      if (subjects == null) {
        report.errors.push({ source_id: sourceId, slug: '', reason: 'anchor_history_unreadable' });
        return { report, exitCode: 2 };
      }
      for (const subject of subjects.split('\n').filter(Boolean)) {
        if (!isGbrainPlaneCommit(subject)) {
          report.errors.push({ source_id: sourceId, slug: '', reason: 'unknown_history' });
          return { report, exitCode: 2 };
        }
      }
      const changed = tryGit(repo, ['diff', '--name-only', `${recorded}..${head}`]);
      if (changed == null) {
        report.errors.push({ source_id: sourceId, slug: '', reason: 'anchor_history_unreadable' });
        return { report, exitCode: 2 };
      }
      for (const rel of changed.split('\n').filter(Boolean)) {
        if (!rel.toLowerCase().endsWith('.md')) {
          report.errors.push({ source_id: sourceId, slug: '', reason: 'unmaterialized_history_path' });
          return { report, exitCode: 2 };
        }
        const abs = resolve(repo, rel);
        const slug = absToSlug.get(abs);
        if (!slug || !existsSync(abs)) {
          report.errors.push({ source_id: sourceId, slug: slug ?? '', reason: 'unmaterialized_history_path' });
          return { report, exitCode: 2 };
        }
        const stored = await loadCanonicalProjection(engine, sourceId, slug);
        if (!stored || sha256Utf8(readFileSync(abs)) !== stored.sha256) {
          report.errors.push({ source_id: sourceId, slug, reason: 'history_not_byte_equal' });
          return { report, exitCode: 2 };
        }
      }
    }

    if (mutate) writeJournal(repo, sourceId, head);

    const verifiedPaths: string[] = [];

    for (const ref of pages) {
      report.scanned++;
      try {
        const outcome = await withPutPageOperationLock(engine, sourceId, ref.slug, async () => {
          if (sourceArchived || isDbOnlySlug(ref.slug, dbOnlyPrefixes)) {
            report.not_projected++;
            return 'not_projected' as const;
          }
          const page = await engine.getPage(ref.slug, { sourceId });
          if (!page || (page as { page_kind?: string }).page_kind === 'code') {
            report.not_projected++;
            return 'not_projected' as const;
          }
          const metaRows = await engine.executeRaw<{
            source_path: string | null;
            source_uri: string | null;
            page_kind: string | null;
            content_hash: string | null;
            updated_at: Date | string;
            canonical_input_generation: string | number | null;
            canonical_sha256: string | null;
            frontmatter: Record<string, unknown> | string | null;
          }>(
            `SELECT source_path, source_uri, page_kind, content_hash, updated_at,
                    canonical_input_generation, canonical_sha256, frontmatter
               FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
            [sourceId, ref.slug],
          );
          const meta = Array.isArray(metaRows) ? metaRows[0] : undefined;
          if (!meta || (meta.page_kind && meta.page_kind !== 'markdown')) {
            report.not_projected++;
            return 'not_projected' as const;
          }
          const target = resolvePageWriteTargetFromLoadedMeta({
            sourceId,
            slug: ref.slug,
            sourceLocalPath: source.local_path,
            sourcePath: meta.source_path,
            sourceUri: meta.source_uri,
            repoPath: repo,
            otherSourceLocalPaths: otherLocals,
          });
          if (!target.ok) {
            report.not_projected++;
            return 'not_projected' as const;
          }

          const fileExists = existsSync(target.filePath);
          let fileFm: Record<string, unknown> | null = null;
          let fileSha: string | null = null;
          if (fileExists) {
            const raw = readFileSync(target.filePath);
            fileSha = sha256Utf8(raw);
            try {
              fileFm = parseMarkdown(raw.toString('utf8'), `${ref.slug}.md`).frontmatter;
            } catch {
              fileFm = null;
            }
          }

          const tags = await engine.getTags(ref.slug, { sourceId });
          const tuple = resolveSetOnceProvenance(
            page,
            { source_kind: null, ingested_via: null },
            new Date(),
            {
              legacyAdoption: fileFm ? 'source-file' : 'existing-frontmatter',
              sourceFrontmatter: fileFm ?? page.frontmatter ?? null,
              inventTimestamp: false,
            },
          );
          const projection = buildCanonicalPageProjection(
            {
              type: page.type,
              title: page.title,
              compiled_truth: page.compiled_truth,
              timeline: page.timeline,
              frontmatter: page.frontmatter ?? {},
              source_kind: tuple.source_kind,
              ingested_via: tuple.ingested_via,
              ingested_at: tuple.ingested_at,
            },
            tags,
          );

          const stored = await loadCanonicalProjection(engine, sourceId, ref.slug);
          const needsBackfill = !stored || stored.sha256 !== projection.sha256
            || stored.content !== projection.content
            || page.source_kind !== tuple.source_kind
            || page.ingested_via !== tuple.ingested_via
            || !projectionIsFresh(stored);

          const snapshot = {
            content_hash: meta.content_hash,
            updated_at: meta.updated_at,
            canonical_input_generation: meta.canonical_input_generation,
            frontmatter: typeof meta.frontmatter === 'string'
              ? JSON.parse(meta.frontmatter) as Record<string, unknown>
              : (meta.frontmatter ?? {}),
          };

          if (!fileExists) {
            if (mutate && needsBackfill) {
              const ok = await applyTupleThenPersist(
                engine, sourceId, ref.slug, tuple, projection.semanticContentHash, snapshot,
              );
              if (!ok) {
                report.conflicts.push({
                  source_id: sourceId,
                  slug: ref.slug,
                  reason: 'store_changed',
                  expected_hash: projection.sha256,
                  actual_hash: stored?.sha256 ?? null,
                });
                return 'conflict' as const;
              }
              report.projection_backfilled++;
            } else if (needsBackfill) {
              report.projection_backfilled++;
            }
            report.missing_file++;
            return 'missing_file' as const;
          }

          if (fileSha === projection.sha256 && stored?.sha256 === projection.sha256 && !needsBackfill) {
            if (!(await threePlaneEqual(engine, sourceId, ref.slug, target.filePath))) {
              report.post_verify_divergent++;
              report.errors.push({ source_id: sourceId, slug: ref.slug, reason: 'post_verify_divergent' });
              return 'error' as const;
            }
            report.already_equal++;
            report.verified_equal++;
            if (dirtyAbs.has(resolve(target.filePath))) verifiedPaths.push(target.filePath);
            return 'already_equal' as const;
          }

          if (!mutate) {
            if (needsBackfill) report.projection_backfilled++;
            if (fileSha !== projection.sha256) report.would_rewrite++;
            else report.already_equal++;
            return 'dry' as const;
          }

          if (needsBackfill) {
            const ok = await applyTupleThenPersist(
              engine, sourceId, ref.slug, tuple, projection.semanticContentHash, snapshot,
            );
            if (!ok) {
              report.conflicts.push({
                source_id: sourceId,
                slug: ref.slug,
                reason: 'store_changed',
                expected_hash: projection.sha256,
                actual_hash: stored?.sha256 ?? null,
              });
              return 'conflict' as const;
            }
            report.projection_backfilled++;
          }

          const live = await loadCanonicalProjection(engine, sourceId, ref.slug);
          if (!live || live.sha256 !== projection.sha256 || !projectionIsFresh(live)) {
            report.conflicts.push({
              source_id: sourceId,
              slug: ref.slug,
              reason: 'projection_moved',
              expected_hash: projection.sha256,
              actual_hash: live?.sha256 ?? null,
            });
            return 'conflict' as const;
          }

          if (fileSha !== live.sha256) {
            const currentFileSha = existsSync(target.filePath) ? sha256Utf8(readFileSync(target.filePath)) : null;
            if (currentFileSha !== fileSha) {
              report.conflicts.push({
                source_id: sourceId,
                slug: ref.slug,
                reason: 'file_changed',
                expected_hash: fileSha,
                actual_hash: currentFileSha,
              });
              return 'conflict' as const;
            }
            try {
              atomicWriteFileSync(target.filePath, live.content, {
                expectedTargetHash: fileSha ?? undefined,
              });
            } catch (err) {
              report.conflicts.push({
                source_id: sourceId,
                slug: ref.slug,
                reason: err instanceof Error ? err.message : 'file_write_conflict',
                expected_hash: fileSha,
                actual_hash: existsSync(target.filePath) ? sha256Utf8(readFileSync(target.filePath)) : null,
              });
              return 'conflict' as const;
            }
            report.rewritten++;
          } else {
            report.already_equal++;
          }

          if (!(await threePlaneEqual(engine, sourceId, ref.slug, target.filePath))) {
            report.post_verify_divergent++;
            report.errors.push({ source_id: sourceId, slug: ref.slug, reason: 'post_verify_divergent' });
            return 'error' as const;
          }
          verifiedPaths.push(target.filePath);
          report.verified_equal++;
          return 'ok' as const;
        });
        void outcome;
      } catch (err) {
        report.errors.push({
          source_id: sourceId,
          slug: ref.slug,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (mutate) {
      const headNow = tryGit(repo, ['rev-parse', 'HEAD']);
      if (headNow !== report.pre_head) {
        report.errors.push({ source_id: sourceId, slug: '', reason: 'head_moved' });
      } else if (verifiedPaths.length > 0) {
        const sha = commitWriteThroughFiles(
          repo,
          verifiedPaths,
          `gbrain: converge canonical page planes (${sourceId})`,
        );
        if (sha) {
          report.commit = { created: true, sha, path_count: verifiedPaths.length };
        } else {
          report.errors.push({ source_id: sourceId, slug: '', reason: 'commit_failed' });
        }
      }
    }

    const complete = report.conflicts.length === 0
      && report.errors.length === 0
      && report.missing_file === 0
      && report.post_verify_divergent === 0;

    if (mutate && complete && report.commit.created && report.commit.sha) {
      await writeSyncAnchor(engine, sourceId, 'last_commit', report.commit.sha, undefined, repo);
      clearJournal(repo, sourceId);
    } else if (mutate && complete && !report.commit.created) {
      const journal = readJournal(repo, sourceId);
      const headNow = tryGit(repo, ['rev-parse', 'HEAD']);
      const parent = headNow ? tryGit(repo, ['rev-parse', `${headNow}^`]) : null;
      const subject = headNow ? tryGit(repo, ['log', '-1', '--format=%s', headNow]) : null;
      const recordedStillAncestor = !recorded
        || (headNow != null && tryGit(repo, ['merge-base', recorded, headNow]) === recorded);
      if (
        journal
        && headNow
        && parent === journal.preHead
        && subject
        && isGbrainPlaneCommit(subject)
        && recordedStillAncestor
      ) {
        await writeSyncAnchor(engine, sourceId, 'last_commit', headNow, undefined, repo);
        report.commit = { created: false, sha: headNow, path_count: 0 };
        clearJournal(repo, sourceId);
      } else {
        report.anchor_not_advanced = true;
      }
    } else if (mutate && !complete) {
      report.anchor_not_advanced = true;
    }

    let exitCode = 0;
    if (!complete) {
      exitCode = mutate ? 1 : (report.errors.length > 0 && report.scanned === 0 ? 2 : 1);
    }
    if (!mutate) {
      const preflight = report.errors.some((e) =>
        e.reason === 'dirty_tracked_tree'
        || e.reason === 'anchor_not_ancestor'
        || e.reason === 'unknown_history'
        || e.reason === 'git_status_failed'
        || e.reason === 'detached_head'
        || e.reason === 'not_a_git_repo',
      );
      if (preflight && report.scanned === 0) exitCode = 2;
      else if (!complete) exitCode = 1;
      else exitCode = 0;
    }
    return { report, exitCode };
  });
  } catch (err) {
    report.errors.push({
      source_id: sourceId,
      slug: '',
      reason: err instanceof Error ? err.message : String(err),
    });
    return { report, exitCode: 2 };
  }
}

export function formatConvergenceReport(report: ConvergenceReport, json: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  const lines = [
    `source=${report.source_id} repo=${report.repo ?? '-'} pre_head=${report.pre_head ?? '-'}`,
    `scanned=${report.scanned} backfilled=${report.projection_backfilled} already_equal=${report.already_equal} would_rewrite=${report.would_rewrite} rewritten=${report.rewritten}`,
    `missing_file=${report.missing_file} not_projected=${report.not_projected} resumed_canonical_dirty=${report.resumed_canonical_dirty} verified_equal=${report.verified_equal} post_verify_divergent=${report.post_verify_divergent}`,
    `commit created=${report.commit.created} sha=${report.commit.sha ?? '-'} path_count=${report.commit.path_count}`,
    `conflicts=${report.conflicts.length} errors=${report.errors.length}`,
  ];
  for (const c of report.conflicts) {
    lines.push(`  conflict ${c.source_id}/${c.slug} ${c.reason}`);
  }
  for (const e of report.errors) {
    lines.push(`  error ${e.source_id}/${e.slug} ${e.reason}`);
  }
  if (report.anchor_not_advanced) lines.push('anchor_not_advanced');
  return lines.join('\n');
}
