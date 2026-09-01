/**
 * Cheap store/file canonical-plane parity probe used by `gbrain doctor`
 * and the converge-canonical preflight. Compares file SHA/size to stored
 * canonical_sha256 — never to semantic content_hash.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { msysToNativePath } from './path-confine.ts';
import {
  isWriteThroughDisabled,
  resolvePageWriteTargetFromLoadedMeta,
} from './write-through.ts';
import {
  effectiveDbOnlyDirs,
  loadStorageConfig,
} from './storage-config.ts';
import { generationKey } from './page-canonical.ts';

export type StoreFileParityReason =
  | 'stale_projection'
  | 'hash_mismatch'
  | 'size_mismatch'
  | 'missing_file'
  | 'unreadable_file'
  | 'unmeasured'
  | 'not_projected'
  | 'repo_not_found'
  | 'path_escapes_source_root';

export type StoreFileParitySample = {
  source_id: string;
  slug: string;
  reason: StoreFileParityReason;
};

export type StoreFileParityReport = {
  eligible_pages: number;
  checked_pages: number;
  divergent_pages: number;
  stale_projections: number;
  hash_mismatches: number;
  size_mismatches: number;
  missing_files: number;
  unreadable_files: number;
  unmeasured_pages: number;
  not_projected_pages: number;
  sample: StoreFileParitySample[];
};

const HASH_CONCURRENCY = 8;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function isDbOnlySlug(slug: string, prefixes: readonly string[]): boolean {
  const lower = slug.toLowerCase();
  return prefixes.some((prefix) => {
    const p = prefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    return p.length > 0 && (lower === p || lower.startsWith(`${p}/`));
  });
}

export async function computeStoreFileParity(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<StoreFileParityReport> {
  const empty: StoreFileParityReport = {
    eligible_pages: 0,
    checked_pages: 0,
    divergent_pages: 0,
    stale_projections: 0,
    hash_mismatches: 0,
    size_mismatches: 0,
    missing_files: 0,
    unreadable_files: 0,
    unmeasured_pages: 0,
    not_projected_pages: 0,
    sample: [],
  };

  const writeThroughOff = await isWriteThroughDisabled(engine);
  const repoPath = await engine.getConfig('sync.repo_path');

  let sources: Array<{ id: string; local_path: string | null; archived: boolean | null }>;
  try {
    sources = await engine.executeRaw(
      `SELECT id, local_path, archived FROM sources`,
    );
  } catch {
    sources = await engine.executeRaw(
      `SELECT id, local_path FROM sources`,
    );
    sources = sources.map((s) => ({ ...s, archived: null }));
  }
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const otherLocalPaths = (selfId: string): Set<string> => {
    const set = new Set<string>();
    for (const s of sources) {
      if (s.id === selfId || !s.local_path) continue;
      set.add(msysToNativePath(s.local_path));
    }
    return set;
  };

  const dbOnlyBySource = new Map<string, string[]>();
  for (const s of sources) {
    const root = s.local_path ? msysToNativePath(s.local_path) : repoPath;
    let declared: string[] = [];
    if (root) {
      try {
        declared = loadStorageConfig(root)?.db_only ?? [];
      } catch {
        declared = [];
      }
    }
    dbOnlyBySource.set(s.id, effectiveDbOnlyDirs(declared));
  }

  const pageSql = opts.sourceId
    ? `SELECT source_id, slug, page_kind, source_path, source_uri,
              canonical_input_generation, canonical_basis_generation,
              canonical_sha256, canonical_size_bytes
         FROM pages
        WHERE deleted_at IS NULL AND source_id = $1
        ORDER BY source_id, slug`
    : `SELECT source_id, slug, page_kind, source_path, source_uri,
              canonical_input_generation, canonical_basis_generation,
              canonical_sha256, canonical_size_bytes
         FROM pages
        WHERE deleted_at IS NULL
        ORDER BY source_id, slug`;
  const pages = await engine.executeRaw<{
    source_id: string;
    slug: string;
    page_kind: string | null;
    source_path: string | null;
    source_uri: string | null;
    canonical_input_generation: string | number | null;
    canonical_basis_generation: string | number | null;
    canonical_sha256: string | null;
    canonical_size_bytes: string | number | null;
  }>(pageSql, opts.sourceId ? [opts.sourceId] : []);

  const samples: StoreFileParitySample[] = [];
  const divergentKeys = new Set<string>();
  let stale = 0, hashMis = 0, sizeMis = 0, missing = 0, unread = 0, unmeasured = 0, notProjected = 0;
  let eligible = 0, checked = 0;

  type HashJob = { source_id: string; slug: string; path: string; expected: string };
  const hashJobs: HashJob[] = [];

  const mark = (source_id: string, slug: string, reason: StoreFileParityReason): void => {
    const key = `${source_id}\0${slug}`;
    if (reason === 'not_projected') return;
    divergentKeys.add(key);
    samples.push({ source_id, slug, reason });
  };

  for (const page of pages) {
    const src = sourceById.get(page.source_id);
    const archived = src?.archived === true;
    const dbOnly = isDbOnlySlug(page.slug, dbOnlyBySource.get(page.source_id) ?? []);
    const nonMarkdown = page.page_kind != null && page.page_kind !== 'markdown';
    if (writeThroughOff || archived || dbOnly || nonMarkdown || !src) {
      notProjected++;
      mark(page.source_id, page.slug, 'not_projected');
      continue;
    }

    const target = resolvePageWriteTargetFromLoadedMeta({
      sourceId: page.source_id,
      slug: page.slug,
      sourceLocalPath: src.local_path,
      sourcePath: page.source_path,
      sourceUri: page.source_uri,
      repoPath,
      otherSourceLocalPaths: otherLocalPaths(page.source_id),
    });
    if (!target.ok) {
      if (target.skipped === 'no_repo_configured' || target.skipped === 'source_repo_belongs_to_other_source') {
        notProjected++;
        continue;
      }
      eligible++;
      unread++;
      mark(
        page.source_id,
        page.slug,
        target.skipped === 'path_escapes_source_root' ? 'path_escapes_source_root' : 'repo_not_found',
      );
      continue;
    }

    eligible++;
    const inputGen = generationKey(page.canonical_input_generation);
    const basisGen = generationKey(page.canonical_basis_generation);
    if (page.canonical_sha256 == null || page.canonical_size_bytes == null || basisGen == null) {
      unmeasured++;
      mark(page.source_id, page.slug, 'unmeasured');
      continue;
    }
    if (inputGen !== basisGen) {
      stale++;
      mark(page.source_id, page.slug, 'stale_projection');
      continue;
    }

    checked++;
    if (!existsSync(target.filePath)) {
      missing++;
      mark(page.source_id, page.slug, 'missing_file');
      continue;
    }
    let st;
    try {
      st = statSync(target.filePath);
    } catch {
      unread++;
      mark(page.source_id, page.slug, 'unreadable_file');
      continue;
    }
    if (!st.isFile()) {
      unread++;
      mark(page.source_id, page.slug, 'unreadable_file');
      continue;
    }
    if (st.size !== Number(page.canonical_size_bytes)) {
      sizeMis++;
      mark(page.source_id, page.slug, 'size_mismatch');
      continue;
    }
    hashJobs.push({
      source_id: page.source_id,
      slug: page.slug,
      path: target.filePath,
      expected: page.canonical_sha256,
    });
  }

  const hashOutcomes = await mapLimit(hashJobs, HASH_CONCURRENCY, async (job) => {
    try {
      const digest = await sha256File(job.path);
      return digest === job.expected ? 'ok' : 'hash_mismatch';
    } catch {
      return 'unreadable_file';
    }
  });
  for (let i = 0; i < hashJobs.length; i++) {
    const outcome = hashOutcomes[i];
    if (outcome === 'hash_mismatch') {
      hashMis++;
      mark(hashJobs[i].source_id, hashJobs[i].slug, 'hash_mismatch');
    } else if (outcome === 'unreadable_file') {
      unread++;
      mark(hashJobs[i].source_id, hashJobs[i].slug, 'unreadable_file');
    }
  }

  samples.sort((a, b) => a.slug.localeCompare(b.slug) || a.source_id.localeCompare(b.source_id) || a.reason.localeCompare(b.reason));
  const sample = samples.slice(0, 5);

  return {
    eligible_pages: eligible,
    checked_pages: checked,
    divergent_pages: divergentKeys.size,
    stale_projections: stale,
    hash_mismatches: hashMis,
    size_mismatches: sizeMis,
    missing_files: missing,
    unreadable_files: unread,
    unmeasured_pages: unmeasured,
    not_projected_pages: notProjected,
    sample,
  };
}
