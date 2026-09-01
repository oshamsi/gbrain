/**
 * One-time canonical-plane convergence: backfill stored projections and
 * rewrite existing files that differ. Dry-run is the default.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from './engine.ts';
import { fetchSource } from './sources-load.ts';
import { withRefreshingLock, syncLockId } from './db-lock.ts';
import { withPutPageOperationLock } from './ops/put-page-lock.ts';
import {
  buildCanonicalPageProjection,
  loadCanonicalProjection,
  resolveSetOnceProvenance,
  sha256Utf8,
  persistCanonicalProjectionFromRow,
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

function porcelain(repo: string): string[] {
  const out = tryGit(repo, ['status', '--porcelain=v1', '-uall']);
  if (out == null) return [];
  return out.split('\n').filter(Boolean);
}

function isTrackedDirty(line: string): boolean {
  return !line.startsWith('??') && !line.startsWith('!!');
}

function dirtyPath(line: string): string {
  const raw = line.slice(3).replace(/\\/g, '/');
  const arrow = raw.indexOf(' -> ');
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
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

  const dirty = porcelain(repo);
  const trackedDirty = dirty.filter(isTrackedDirty).map(dirtyPath);

  if (await isWriteThroughDisabled(engine)) {
    report.errors.push({ source_id: sourceId, slug: '', reason: 'write_through_disabled' });
    return { report, exitCode: 2 };
  }

  const pages = (await engine.listAllPageRefs()).filter((p) => p.source_id === sourceId);

  const otherLocals = new Set<string>();
  const srcRows = await engine.executeRaw<{ id: string; local_path: string | null }>(
    `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
  );
  for (const row of srcRows) {
    if (row.id !== sourceId && row.local_path) otherLocals.add(msysToNativePath(row.local_path));
  }

  async function projectionFor(slug: string): Promise<string | null> {
    const loaded = await loadCanonicalProjection(engine, sourceId, slug);
    return loaded?.content ?? null;
  }

  if (trackedDirty.length > 0) {
    let allResume = true;
    for (const rel of trackedDirty) {
      const abs = resolve(repo, rel);
      const slugGuess = rel.replace(/\\/g, '/').replace(/\.md$/i, '');
      const stored = await projectionFor(slugGuess.toLowerCase()) ?? await projectionFor(slugGuess);
      if (!stored || !existsSync(abs) || readFileSync(abs, 'utf8') !== stored) {
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
  }

  try {
  return await withRefreshingLock(engine, syncLockId(sourceId), async () => {
    const verifiedPaths: string[] = [];

    for (const ref of pages) {
      report.scanned++;
      try {
        const outcome = await withPutPageOperationLock(engine, sourceId, ref.slug, async () => {
          const page = await engine.getPage(ref.slug, { sourceId });
          if (!page || (page as { page_kind?: string }).page_kind === 'code') {
            report.not_projected++;
            return 'not_projected' as const;
          }
          const pathRows = await engine.executeRaw<{
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
          const meta = pathRows[0];
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
          const now = new Date();
          const tuple = resolveSetOnceProvenance(
            page,
            { source_kind: null, ingested_via: null },
            now,
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
            || page.ingested_via !== tuple.ingested_via;

          if (!fileExists) {
            if (mutate && needsBackfill) {
              await persistCanonicalProjectionFromRow(engine, sourceId, ref.slug);
              report.projection_backfilled++;
            } else if (needsBackfill) {
              report.projection_backfilled++;
            }
            report.missing_file++;
            return 'missing_file' as const;
          }

          if (fileSha === projection.sha256 && stored?.sha256 === projection.sha256 && !needsBackfill) {
            report.already_equal++;
            report.verified_equal++;
            return 'already_equal' as const;
          }

          if (!mutate) {
            if (needsBackfill) report.projection_backfilled++;
            if (fileSha !== projection.sha256) report.would_rewrite++;
            else report.already_equal++;
            return 'dry' as const;
          }

          if (needsBackfill) {
            const fm = { ...(typeof meta.frontmatter === 'string' ? JSON.parse(meta.frontmatter) : (meta.frontmatter ?? {})) };
            if (tuple.source_kind) fm.source_kind = tuple.source_kind;
            if (tuple.ingested_via) fm.ingested_via = tuple.ingested_via;
            if (tuple.ingested_at) fm.ingested_at = tuple.ingested_at.toISOString();
            const rows = await engine.executeRaw(
              `UPDATE pages SET
                 frontmatter = $1::jsonb,
                 source_kind = COALESCE(pages.source_kind, $2),
                 ingested_via = COALESCE(pages.ingested_via, $3),
                 ingested_at = COALESCE(pages.ingested_at, $4::timestamptz),
                 canonical_content = $5,
                 canonical_sha256 = $6,
                 canonical_size_bytes = $7,
                 canonical_basis_generation = canonical_input_generation
               WHERE source_id = $8 AND slug = $9 AND deleted_at IS NULL
                 AND content_hash = $10
                 AND canonical_input_generation IS NOT DISTINCT FROM $11
               RETURNING slug`,
              [
                JSON.stringify(fm),
                tuple.source_kind,
                tuple.ingested_via,
                tuple.ingested_at ? tuple.ingested_at.toISOString() : null,
                projection.content,
                projection.sha256,
                projection.sizeBytes,
                sourceId,
                ref.slug,
                meta.content_hash,
                meta.canonical_input_generation == null ? null : Number(meta.canonical_input_generation),
              ],
            );
            if (rows.length === 0) {
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

          if (fileSha !== projection.sha256) {
            const live = await loadCanonicalProjection(engine, sourceId, ref.slug);
            if (!live || live.sha256 !== projection.sha256) {
              report.conflicts.push({
                source_id: sourceId,
                slug: ref.slug,
                reason: 'projection_moved',
                expected_hash: projection.sha256,
                actual_hash: live?.sha256 ?? null,
              });
              return 'conflict' as const;
            }
            try {
              atomicWriteFileSync(target.filePath, projection.content, {
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
            const after = sha256Utf8(readFileSync(target.filePath));
            if (after !== projection.sha256) {
              report.errors.push({ source_id: sourceId, slug: ref.slug, reason: 'post_write_digest_mismatch' });
              report.post_verify_divergent++;
              return 'error' as const;
            }
            report.rewritten++;
            verifiedPaths.push(target.filePath);
            report.verified_equal++;
          } else {
            report.already_equal++;
            report.verified_equal++;
          }
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

    if (mutate && verifiedPaths.length > 0) {
      const sha = commitWriteThroughFiles(
        repo,
        verifiedPaths,
        `gbrain: converge canonical page planes (${sourceId})`,
      );
      if (sha) {
        report.commit = { created: true, sha, path_count: verifiedPaths.length };
      } else if (verifiedPaths.length > 0) {
        report.errors.push({ source_id: sourceId, slug: '', reason: 'commit_failed' });
      }
    }

    const complete = report.conflicts.length === 0
      && report.errors.length === 0
      && report.missing_file === 0
      && report.post_verify_divergent === 0;
    if (mutate && complete && report.commit.created && report.commit.sha) {
      await writeSyncAnchor(engine, sourceId, 'last_commit', report.commit.sha, undefined, repo);
    } else if (mutate && !complete) {
      report.anchor_not_advanced = true;
    }

    let exitCode = 0;
    if (!mutate) {
      exitCode = 0;
    } else if (!complete) {
      exitCode = 1;
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
