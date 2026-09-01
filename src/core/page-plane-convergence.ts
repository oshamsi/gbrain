/**
 * One-time canonical-plane convergence: backfill stored projections and
 * rewrite existing files that differ. Dry-run is the default.
 */

import {
  existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync,
  copyFileSync, renameSync, fsyncSync, rmSync, linkSync, statSync, fstatSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
  parseWriteThroughDisabled,
  resolvePageWriteTargetFromLoadedMeta,
} from './write-through.ts';
import { msysToNativePath } from './path-confine.ts';
import { atomicWriteFileSync } from './atomic-write.ts';
import { sourceCommitAnchorAllowed } from './sync-anchor.ts';
import {
  commitWriteThroughFiles,
  convergencePublicationRef,
  triggerManagedDurabilityPushOnly,
  type VerifiedBatchCommitOutcome,
} from './brain-repo-durability.ts';
import {
  effectiveDbOnlyDirs,
  parseStorageConfigContent,
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
  pre_ref: string | null;
  scanned: number;
  projection_backfilled: number;
  already_equal: number;
  would_rewrite: number;
  would_commit: number;
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

function controlledGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}


function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: controlledGitEnv(),
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

function repositoryRoot(repo: string): string {
  const raw = git(repo, ['rev-parse', '--show-toplevel']);
  return isAbsolute(raw) ? raw : resolve(repo, raw);
}

type TrackedBlob = { mode: '100644' | '100755'; oid: string };
type GitObjectFormat = 'sha1' | 'sha256';

function gitObjectFormat(repo: string): GitObjectFormat {
  const format = git(repo, ['rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256') {
    throw new Error(`unsupported Git object format: ${format}`);
  }
  return format;
}

function gitBlobOid(bytes: Buffer, format: GitObjectFormat): string {
  return createHash(format)
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function trackedBlobsAtCommit(repo: string, commit: string): Map<string, TrackedBlob> {
  const root = repositoryRoot(repo);
  const raw = execFileSync('git', [
    '-C', root, 'ls-tree', '-r', '-z', '--full-tree', commit,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: controlledGitEnv(),
  });
  if (raw.length > 0 && raw[raw.length - 1] !== 0) {
    throw new Error('unterminated ls-tree blob manifest');
  }
  const entries = new Map<string, TrackedBlob>();
  const body = raw.length > 0 ? raw.subarray(0, raw.length - 1) : raw;
  for (const record of body.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('malformed ls-tree blob manifest');
    const [mode, type, oid, extra] = record.slice(0, tab).split(/ +/);
    const relPath = record.slice(tab + 1);
    if (extra !== undefined || !mode || !type || !oid || !relPath) {
      throw new Error('malformed ls-tree entry');
    }
    // Unrelated symlinks (120000 blobs), submodules (160000 commits), and
    // trees are valid repository material but cannot be canonical Markdown
    // targets. Skip them; a target at that path is simply not HEAD-healthy.
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    if (entries.has(relPath)) throw new Error('duplicate ls-tree entry');
    entries.set(relPath, { mode, oid });
  }
  return entries;
}

function sameLeaseIdentity(
  lockPath: string,
  expected: { dev: string; ino: string },
): boolean {
  try {
    const stat = statSync(lockPath, { bigint: true });
    return stat.dev.toString() === expected.dev
      && stat.ino.toString() === expected.ino;
  } catch {
    return false;
  }
}

type RoutingSnapshot = {
  epoch: string;
  source: Awaited<ReturnType<typeof fetchSource>> & {};
  sourceRows: Array<{
    id: string;
    local_path: string | null;
    archived: boolean | null;
  }>;
  syncRepoPath: string | null;
  writeThrough: string | null;
  storageConfig: {
    fingerprint: OptionalFileFingerprint;
    text: string | null;
  };
  pages: Array<{
    source_id: string;
    slug: string;
    source_path: string | null;
    source_uri: string | null;
    page_kind: string | null;
  }>;
};

type OptionalFileFingerprint =
  | { kind: 'missing' }
  | { kind: 'file'; sha256: string; size: number };

function readOptionalFileSnapshot(filePath: string): {
  fingerprint: OptionalFileFingerprint;
  text: string | null;
} {
  try {
    const bytes = readFileSync(filePath);
    return {
      fingerprint: {
        kind: 'file',
        sha256: sha256Utf8(bytes),
        size: bytes.length,
      },
      text: bytes.toString('utf8'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { fingerprint: { kind: 'missing' }, text: null };
    }
    throw error;
  }
}

function optionalFileFingerprint(filePath: string): OptionalFileFingerprint {
  return readOptionalFileSnapshot(filePath).fingerprint;
}

function sameOptionalFileFingerprint(
  a: OptionalFileFingerprint,
  b: OptionalFileFingerprint,
): boolean {
  return a.kind === b.kind
    && (a.kind === 'missing'
      || (b.kind === 'file' && a.sha256 === b.sha256 && a.size === b.size));
}

async function threePlaneEqual(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  filePath: string,
  expectedSha?: string,
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
  const row = rows[0];
  if (
    !row
    || row.canonical_content == null
    || row.canonical_sha256 == null
    || row.canonical_size_bytes == null
  ) return false;
  if (
    generationKey(row.canonical_input_generation)
      !== generationKey(row.canonical_basis_generation)
  ) return false;
  if (expectedSha && row.canonical_sha256 !== expectedSha) return false;
  if (!existsSync(filePath)) return false;
  const file = readFileSync(filePath);
  const fileSha = sha256Utf8(file);
  const contentSha = sha256Utf8(row.canonical_content);
  if (fileSha !== row.canonical_sha256 || contentSha !== row.canonical_sha256) {
    return false;
  }
  const size = Number(row.canonical_size_bytes);
  return file.length === size
    && Buffer.byteLength(row.canonical_content, 'utf8') === size;
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

type VerifiedConvergencePath = {
  sourceId: string;
  slug: string;
  filePath: string;
  sha256: string;
};

type JournalFileReceipt = {
  dev: string;
  ino: string;
  sha256: string;
};

type PublishedIndexProof = {
  expectedRef: string;
  targetHead: string;
  indexIdentity: { dev: string; ino: string };
};

type PublishedIndexResult =
  | { ok: true; proof: PublishedIndexProof }
  | { ok: false; reason: string };

type PendingRecovery =
  | {
      kind: 'current';
      journal: ConvergenceJournal;
      journalReceipt: JournalFileReceipt;
      ref: string;
      head: string;
      indexProof: PublishedIndexProof;
    }
  | {
      kind: 'legacy';
      journal: LegacyConvergenceJournal;
      journalReceipt: JournalFileReceipt;
      ref: string;
      head: string;
    };

type ConvergenceJournalBase = {
  sourceId: string;
  expectedRef: string;
  preHead: string;
  expectedCommit: string;
  expectedTree: string;
  routeEpoch: string;
  storageConfigFingerprint: OptionalFileFingerprint;
  /** Exact inode of the standard index.lock owned at WAL publication. */
  indexLeaseIdentity: { dev: string; ino: string };
  /** Exact subset whose index entries the publisher updates after ref CAS. */
  commitPaths: string[];
  files: Array<{
    sourceId: string;
    slug: string;
    relPath: string;
    sha256: string;
  }>;
};

type ConvergenceJournalV4 = ConvergenceJournalBase & { version: 4 };
type ConvergenceJournalV5 = ConvergenceJournalBase & {
  version: 5;
  publicationNonce: string;
};
type ConvergenceJournal = ConvergenceJournalV4 | ConvergenceJournalV5;

type LegacyConvergenceJournal = {
  sourceId: string;
  preHead: string;
  at?: string;
};

type ConvergenceJournalRead =
  | { kind: 'none' }
  | { kind: 'current'; journal: ConvergenceJournal; receipt: JournalFileReceipt }
  | { kind: 'legacy'; journal: LegacyConvergenceJournal; receipt: JournalFileReceipt }
  | { kind: 'invalid'; reason: 'partial_or_malformed'; receipt: JournalFileReceipt };

type GitTreeEntry = { mode: string; type: string; oid: string };
type GitIndexEntry = { mode: string; oid: string };

function gitTreeSnapshot(repo: string, commit: string): Map<string, GitTreeEntry> {
  const root = repositoryRoot(repo);
  const raw = execFileSync('git', [
    '-C', root, 'ls-tree', '-r', '-z', '--full-tree', commit,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: controlledGitEnv(),
  });
  if (raw.length > 0 && raw[raw.length - 1] !== 0) {
    throw new Error('unterminated ls-tree output');
  }
  const entries = new Map<string, GitTreeEntry>();
  const body = raw.length > 0 ? raw.subarray(0, raw.length - 1) : raw;
  for (const record of body.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('malformed ls-tree record');
    const [mode, type, oid, extra] = record.slice(0, tab).split(/ +/);
    const relPath = record.slice(tab + 1);
    if (
      extra !== undefined
      || !mode
      || !type
      || !oid
      || entries.has(relPath)
    ) throw new Error('malformed or duplicate ls-tree record');
    entries.set(relPath, { mode, type, oid });
  }
  return entries;
}

function gitIndexSnapshot(
  repo: string,
  relPaths: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
): Map<string, GitIndexEntry> {
  const root = repositoryRoot(repo);
  if (relPaths.length === 0) return new Map();
  const raw = execFileSync('git', [
    '-C', root, '--literal-pathspecs',
    'ls-files', '--stage', '-z', '--', ...relPaths,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env,
  });
  if (raw.length > 0 && raw[raw.length - 1] !== 0) {
    throw new Error('unterminated ls-files output');
  }
  const entries = new Map<string, GitIndexEntry>();
  const body = raw.length > 0 ? raw.subarray(0, raw.length - 1) : raw;
  for (const record of body.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('malformed ls-files record');
    const [mode, oid, stage, extra] = record.slice(0, tab).split(/ +/);
    const relPath = record.slice(tab + 1);
    if (
      extra !== undefined
      || !mode
      || !oid
      || stage !== '0'
      || entries.has(relPath)
    ) throw new Error('unmerged, malformed, or duplicate index record');
    entries.set(relPath, { mode, oid });
  }
  return entries;
}

function sameIndexEntry(
  actual: GitIndexEntry | undefined,
  expected: GitTreeEntry | undefined,
): boolean {
  return actual == null
    ? expected == null
    : expected != null
      && expected.type === 'blob'
      && actual.mode === expected.mode
      && actual.oid === expected.oid;
}

function reconcilePublishedIndex(
  repo: string,
  journal: ConvergenceJournal,
  expectedRef: string,
  targetHead: string,
): PublishedIndexResult {
  const root = repositoryRoot(repo);
  const indexRaw = git(root, ['rev-parse', '--git-path', 'index']);
  const indexPath = isAbsolute(indexRaw) ? indexRaw : resolve(root, indexRaw);
  const lockPath = `${indexPath}.lock`;
  let ownsLock = false;
  let installed = false;
  let ownedIdentity: { dev: string; ino: string } | null = null;
  let repairPath: string | null = null;
  try {
    if (
      tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
      || tryGit(root, ['rev-parse', 'HEAD']) !== targetHead
    ) return { ok: false, reason: 'index_repair_head_moved' };

    if (existsSync(lockPath)) {
      if (!sameLeaseIdentity(lockPath, journal.indexLeaseIdentity)) {
        return { ok: false, reason: 'foreign_index_lock' };
      }
      // A SIGKILL after WAL publication left our fully prepared standard lock.
      ownsLock = true;
      ownedIdentity = journal.indexLeaseIdentity;
    } else {
      const fd = openSync(lockPath, 'wx', 0o600);
      closeSync(fd);
      ownsLock = true;
      if (!existsSync(indexPath)) throw new Error('real git index is absent');
      copyFileSync(indexPath, lockPath);
      const stat = statSync(lockPath, { bigint: true });
      ownedIdentity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
    }
    const lockEnv = { ...controlledGitEnv(), GIT_INDEX_FILE: lockPath };

    const oldTree = gitTreeSnapshot(repo, journal.preHead);
    const candidateTree = gitTreeSnapshot(repo, journal.expectedCommit);
    const targetTree = gitTreeSnapshot(repo, targetHead);
    // Read the copied index only after owning index.lock. A concurrent git add
    // either completed before this snapshot (and is detected) or blocks.
    const index = gitIndexSnapshot(repo, journal.commitPaths, lockEnv);
    const needsReset: string[] = [];
    for (const relPath of journal.commitPaths) {
      const next = targetTree.get(relPath);
      if (next && (
        next.type !== 'blob'
        || (next.mode !== '100644' && next.mode !== '100755')
      )) return { ok: false, reason: `index_repair_bad_target:${relPath}` };
      const current = index.get(relPath);
      if (sameIndexEntry(current, next)) continue;
      if (
        !sameIndexEntry(current, oldTree.get(relPath))
        && !sameIndexEntry(current, candidateTree.get(relPath))
      ) {
        // Only the journal's captured pre-commit entry, its published entry,
        // or the exact live-HEAD entry is owned by recovery. A fourth value is
        // user staging and must survive untouched.
        return { ok: false, reason: `index_repair_user_stage:${relPath}` };
      }
      needsReset.push(relPath);
    }

    if (needsReset.length > 0) {
      if (
        tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
        || tryGit(root, ['rev-parse', 'HEAD']) !== targetHead
      ) return { ok: false, reason: 'index_repair_head_moved' };

      repairPath = `${lockPath}.repair-${process.pid}-${
        randomBytes(8).toString('hex')
      }`;
      copyFileSync(lockPath, repairPath);
      const repairEnv = { ...controlledGitEnv(), GIT_INDEX_FILE: repairPath };
      execFileSync('git', [
        '--literal-pathspecs', '-C', root,
        'reset', '--quiet', targetHead, '--', ...needsReset,
      ], {
        stdio: 'ignore', timeout: 30_000, env: repairEnv,
      });
      const repaired = gitIndexSnapshot(repo, needsReset, repairEnv);
      for (const relPath of needsReset) {
        if (!sameIndexEntry(repaired.get(relPath), targetTree.get(relPath))) {
          return { ok: false, reason: `index_repair_verify_failed:${relPath}` };
        }
      }
      // Copy complete bytes into the still-owned inode; do not replace its inode.
      copyFileSync(repairPath, lockPath);
    }

    // This block is unconditional. An adopted equal-target lease is still the
    // prepared transaction that SIGKILL prevented from being installed.
    if (
      tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
      || tryGit(root, ['rev-parse', 'HEAD']) !== targetHead
    ) return { ok: false, reason: 'index_repair_head_moved' };
    if (!ownedIdentity || !sameLeaseIdentity(lockPath, ownedIdentity)) {
      return { ok: false, reason: 'foreign_index_lock' };
    }

    const prepared = gitIndexSnapshot(repo, journal.commitPaths, lockEnv);
    for (const relPath of journal.commitPaths) {
      if (!sameIndexEntry(prepared.get(relPath), targetTree.get(relPath))) {
        return { ok: false, reason: `index_repair_verify_failed:${relPath}` };
      }
    }
    const fd = openSync(lockPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (!sameLeaseIdentity(lockPath, ownedIdentity)) {
      return { ok: false, reason: 'foreign_index_lock' };
    }

    renameSync(lockPath, indexPath);
    installed = true; // set immediately: finally must not remove the renamed inode
    fsyncParentDirectory(indexPath);

    if (!sameLeaseIdentity(indexPath, ownedIdentity)) {
      return { ok: false, reason: 'index_install_identity_mismatch' };
    }
    const realEnv = { ...controlledGitEnv(), GIT_INDEX_FILE: indexPath };
    const live = gitIndexSnapshot(repo, journal.commitPaths, realEnv);
    for (const relPath of journal.commitPaths) {
      if (!sameIndexEntry(live.get(relPath), targetTree.get(relPath))) {
        return { ok: false, reason: `index_install_verify_failed:${relPath}` };
      }
    }
    if (
      tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
      || tryGit(root, ['rev-parse', 'HEAD']) !== targetHead
    ) return { ok: false, reason: 'index_repair_head_moved' };

    return {
      ok: true,
      proof: { expectedRef, targetHead, indexIdentity: ownedIdentity },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `index_repair_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (repairPath) {
      rmSync(`${repairPath}.lock`, { force: true });
      rmSync(repairPath, { force: true });
    }
    if (ownsLock && !installed && ownedIdentity
      && sameLeaseIdentity(lockPath, ownedIdentity)) {
      rmSync(lockPath, { force: true });
    }
  }
}

function verifyAndDiscardUnpublishedLease(
  repo: string,
  journal: ConvergenceJournalV5,
  expectedRef: string,
  liveHead: string,
): AnchorFenceResult {
  const root = repositoryRoot(repo);
  const indexRaw = git(root, ['rev-parse', '--git-path', 'index']);
  const indexPath = isAbsolute(indexRaw) ? indexRaw : resolve(root, indexRaw);
  const lockPath = `${indexPath}.lock`;
  let ownsTemporaryGuard = false;
  let adoptedWalLease = false;
  let ownedIdentity: { dev: string; ino: string } | null = null;
  try {
    if (
      tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
      || tryGit(root, ['rev-parse', 'HEAD']) !== liveHead
    ) return { ok: false, reason: 'unpublished_head_moved' };

    if (existsSync(lockPath)) {
      if (!sameLeaseIdentity(lockPath, journal.indexLeaseIdentity)) {
        return { ok: false, reason: 'foreign_index_lock' };
      }
      adoptedWalLease = true;
      ownedIdentity = journal.indexLeaseIdentity;
    } else {
      const fd = openSync(lockPath, 'wx', 0o600);
      closeSync(fd);
      ownsTemporaryGuard = true;
      const stat = statSync(lockPath, { bigint: true });
      ownedIdentity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
    }

    // Candidate was proven unpublished. The real index is authoritative; never
    // copy candidate-prepared bytes into it. Merely prove its WAL paths agree
    // with the current live HEAD while the standard lock blocks Git writers.
    const liveTree = gitTreeSnapshot(repo, liveHead);
    const realEnv = { ...controlledGitEnv(), GIT_INDEX_FILE: indexPath };
    const realIndex = gitIndexSnapshot(repo, journal.commitPaths, realEnv);
    for (const relPath of journal.commitPaths) {
      if (!sameIndexEntry(realIndex.get(relPath), liveTree.get(relPath))) {
        return { ok: false, reason: `unpublished_index_not_live:${relPath}` };
      }
    }
    if (
      tryGit(root, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
      || tryGit(root, ['rev-parse', 'HEAD']) !== liveHead
    ) return { ok: false, reason: 'unpublished_head_moved' };

    if (!ownedIdentity || !sameLeaseIdentity(lockPath, ownedIdentity)) {
      return { ok: false, reason: 'foreign_index_lock' };
    }
    unlinkSync(lockPath);
    fsyncParentDirectory(lockPath);
    adoptedWalLease = false;
    ownsTemporaryGuard = false;
    return (
      tryGit(root, ['symbolic-ref', '-q', 'HEAD']) === expectedRef
      && tryGit(root, ['rev-parse', 'HEAD']) === liveHead
    ) ? { ok: true } : { ok: false, reason: 'unpublished_head_moved' };
  } catch (error) {
    return {
      ok: false,
      reason: `unpublished_index_probe_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    // Preserve an adopted WAL lease on failure. It is recovery evidence. Remove
    // only the temporary guard this invocation created.
    if (ownsTemporaryGuard && ownedIdentity
      && sameLeaseIdentity(lockPath, ownedIdentity)) {
      unlinkSync(lockPath);
      fsyncParentDirectory(lockPath);
    }
    void adoptedWalLease;
  }
}

function gitTreeContainsReceipts(
  repo: string,
  commit: string,
  files: readonly VerifiedConvergencePath[],
  requireCurrentFile = true,
): boolean {
  try {
    const root = repositoryRoot(repo);
    const algorithm = git(repo, ['rev-parse', '--show-object-format']);
    if (algorithm !== 'sha1' && algorithm !== 'sha256') return false;
    const entries = gitTreeSnapshot(repo, commit);
    for (const file of files) {
      const relPath = relative(root, resolve(file.filePath)).replace(/\\/g, '/');
      if (
        !relPath
        || relPath === '..'
        || relPath.startsWith('../')
        || isAbsolute(relPath)
      ) return false;
      const entry = entries.get(relPath);
      if (
        !entry
        || entry.type !== 'blob'
        || (entry.mode !== '100644' && entry.mode !== '100755')
      ) return false;
      const committedBytes = execFileSync('git', [
        '-C', root, 'cat-file', 'blob', entry.oid,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        env: controlledGitEnv(),
      });
      if (sha256Utf8(committedBytes) !== file.sha256) return false;
      const oid = createHash(algorithm)
        .update(Buffer.from(`blob ${committedBytes.length}\0`, 'utf8'))
        .update(committedBytes)
        .digest('hex');
      if (oid !== entry.oid) return false;
      if (requireCurrentFile) {
        const diskBytes = readFileSync(file.filePath);
        if (sha256Utf8(diskBytes) !== file.sha256) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function journalPath(repo: string, sourceId: string): string {
  const raw = git(repo, [
    'rev-parse', '--git-path', `gbrain-converge-${sourceId}.json`,
  ]);
  return isAbsolute(raw) ? raw : resolve(repo, raw);
}

function writeJournal(
  repo: string,
  sourceId: string,
  expectedRef: string,
  preHead: string,
  expectedCommit: string,
  expectedTree: string,
  routeEpoch: string,
  storageConfigFingerprint: OptionalFileFingerprint,
  indexLeaseIdentity: { dev: string; ino: string },
  publicationNonce: string,
  commitFiles: readonly VerifiedConvergencePath[],
  files: readonly VerifiedConvergencePath[],
): JournalFileReceipt {
  const root = repositoryRoot(repo);
  if (
    expectedCommit === preHead
    || tryGit(repo, ['rev-parse', `${expectedCommit}^`]) !== preHead
    || tryGit(repo, ['rev-parse', `${expectedCommit}^{tree}`]) !== expectedTree
  ) throw new Error('candidate convergence commit does not match its receipt');
  const serialized = files.map((file) => {
    const relPath = relative(root, file.filePath).replace(/\\/g, '/');
    if (
      file.sourceId !== sourceId
      || !relPath
      || relPath === '..'
      || relPath.startsWith('../')
      || isAbsolute(relPath)
    ) throw new Error(`invalid convergence WAL path: ${file.filePath}`);
    return {
      sourceId: file.sourceId,
      slug: file.slug,
      relPath,
      sha256: file.sha256,
    };
  });
  if (serialized.length === 0) {
    throw new Error('refusing to create an empty convergence WAL');
  }
  const receiptByPath = new Map(serialized.map((file) => [file.relPath, file]));
  const commitPaths = commitFiles.map((file) => {
    const relPath = relative(root, file.filePath).replace(/\\/g, '/');
    const receipt = receiptByPath.get(relPath);
    if (
      !receipt
      || receipt.sourceId !== file.sourceId
      || receipt.slug !== file.slug
      || receipt.sha256 !== file.sha256
    ) throw new Error(`commit path lacks an exact anchor receipt: ${file.filePath}`);
    return relPath;
  });
  if (commitPaths.length === 0 || new Set(commitPaths).size !== commitPaths.length) {
    throw new Error('invalid convergence WAL commit path set');
  }
  convergencePublicationRef(
    expectedRef, preHead, expectedCommit, publicationNonce,
  );
  const journal: ConvergenceJournalV5 = {
    version: 5,
    sourceId,
    expectedRef,
    preHead,
    expectedCommit,
    expectedTree,
    routeEpoch,
    storageConfigFingerprint,
    indexLeaseIdentity,
    publicationNonce,
    commitPaths,
    files: serialized,
  };
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
  const journalFile = journalPath(repo, sourceId);
  const tmp = `${journalFile}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let tmpPublished = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    let tmpReceipt!: JournalFileReceipt;
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const stat = fstatSync(fd, { bigint: true });
      tmpReceipt = {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } finally {
      closeSync(fd);
    }
    // link, rather than rename, is the existing no-overwrite single-slot CAS.
    linkSync(tmp, journalFile);
    tmpPublished = true;
    fsyncParentDirectory(journalFile);
    const published = readJournalFile(journalFile);
    if (!sameJournalReceipt(published.receipt, tmpReceipt)
      || !published.bytes.equals(bytes)) {
      throw new Error('published convergence WAL identity mismatch');
    }
    unlinkSync(tmp);
    fsyncParentDirectory(journalFile);
    tmpPublished = false;
    return published.receipt;
  } finally {
    // Never remove journalFile here: it is the recovery record. Remove only the
    // private hard-link name; if publication succeeded both names share an inode.
    if (existsSync(tmp)) {
      unlinkSync(tmp);
      fsyncParentDirectory(tmp);
    }
    void tmpPublished;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJournal(repo: string, sourceId: string): ConvergenceJournalRead {
  const journalFile = journalPath(repo, sourceId);
  let fd: number;
  try {
    fd = openSync(journalFile, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  let bytes: Buffer;
  let stat: ReturnType<typeof fstatSync>;
  try {
    stat = fstatSync(fd, { bigint: true });
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const receipt: JournalFileReceipt = {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'partial_or_malformed', receipt };
  }
  if (!isRecord(parsed)) {
    return { kind: 'invalid', reason: 'partial_or_malformed', receipt };
  }

  // Exact 68d75a4 eager-WAL shape. It named only the preflight HEAD and could
  // exist even when no commit was attempted, so it is never interpreted as a
  // receipt for an arbitrary current commit.
  if (
    parsed.version === undefined
    && parsed.sourceId === sourceId
    && typeof parsed.preHead === 'string'
    && /^[0-9a-f]{40,64}$/.test(parsed.preHead)
    && (parsed.at === undefined || typeof parsed.at === 'string')
  ) {
    return {
      kind: 'legacy',
      journal: {
        sourceId,
        preHead: parsed.preHead,
        ...(typeof parsed.at === 'string' ? { at: parsed.at } : {}),
      },
      receipt,
    };
  }

  try {
    const value = parsed as unknown as ConvergenceJournal;
    const root = repositoryRoot(repo);
    if (
      (value.version !== 4 && value.version !== 5)
      || (value.version === 5 && !/^[0-9a-f]{64}$/.test(value.publicationNonce))
      || value.sourceId !== sourceId
      || typeof value.expectedRef !== 'string'
      || !value.expectedRef.startsWith('refs/heads/')
      || typeof value.preHead !== 'string'
      || !/^[0-9a-f]{40,64}$/.test(value.preHead)
      || typeof value.expectedCommit !== 'string'
      || !/^[0-9a-f]{40,64}$/.test(value.expectedCommit)
      || typeof value.expectedTree !== 'string'
      || !/^[0-9a-f]{40,64}$/.test(value.expectedTree)
      || typeof value.routeEpoch !== 'string'
      || !/^\d+$/.test(value.routeEpoch)
      || !isRecord(value.indexLeaseIdentity)
      || typeof value.indexLeaseIdentity.dev !== 'string'
      || !/^\d+$/.test(value.indexLeaseIdentity.dev)
      || typeof value.indexLeaseIdentity.ino !== 'string'
      || !/^\d+$/.test(value.indexLeaseIdentity.ino)
      || !isOptionalFileFingerprint(value.storageConfigFingerprint)
      || !Array.isArray(value.commitPaths)
      || value.commitPaths.length === 0
      || !Array.isArray(value.files)
      || value.files.length === 0
    ) throw new Error('invalid header');
    const seenPaths = new Set<string>();
    const seenPages = new Set<string>();
    for (const file of value.files) {
      if (!isRecord(file)) throw new Error('invalid file receipt');
      const abs = resolve(root, file.relPath);
      const back = relative(root, abs).replace(/\\/g, '/');
      const pageKey = `${file.sourceId}\0${file.slug}`;
      if (
        file.sourceId !== sourceId
        || !file.slug
        || back !== file.relPath
        || !back
        || back === '..'
        || back.startsWith('../')
        || isAbsolute(back)
        || !/^[0-9a-f]{64}$/.test(file.sha256)
        || seenPaths.has(back)
        || seenPages.has(pageKey)
      ) throw new Error('invalid file receipt');
      seenPaths.add(back);
      seenPages.add(pageKey);
    }
    const seenCommitPaths = new Set<string>();
    for (const relPath of value.commitPaths) {
      if (
        typeof relPath !== 'string'
        || !seenPaths.has(relPath)
        || seenCommitPaths.has(relPath)
      ) throw new Error('invalid commit path receipt');
      seenCommitPaths.add(relPath);
    }
    if (value.version === 5) {
      convergencePublicationRef(
        value.expectedRef,
        value.preHead,
        value.expectedCommit,
        value.publicationNonce,
      );
    }
    return { kind: 'current', journal: value, receipt };
  } catch {
    return { kind: 'invalid', reason: 'partial_or_malformed', receipt };
  }
}

function isOptionalFileFingerprint(value: unknown): value is OptionalFileFingerprint {
  return isRecord(value) && (
    value.kind === 'missing'
    || (
      value.kind === 'file'
      && typeof value.sha256 === 'string'
      && /^[0-9a-f]{64}$/.test(value.sha256)
      && typeof value.size === 'number'
      && Number.isSafeInteger(value.size)
      && value.size >= 0
    )
  );
}

function journalFiles(
  repo: string,
  journal: ConvergenceJournal,
): VerifiedConvergencePath[] {
  const root = repositoryRoot(repo);
  return journal.files.map((file) => ({
    sourceId: file.sourceId,
    slug: file.slug,
    filePath: resolve(root, file.relPath),
    sha256: file.sha256,
  }));
}

function readJournalFile(file: string): {
  bytes: Buffer;
  receipt: JournalFileReceipt;
} {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    const bytes = readFileSync(fd);
    return {
      bytes,
      receipt: {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    closeSync(fd);
  }
}

function sameJournalReceipt(
  actual: JournalFileReceipt,
  expected: JournalFileReceipt,
): boolean {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.sha256 === expected.sha256;
}

type JournalRetireResult =
  | { ok: true; retired: true; headStable: boolean }
  | { ok: false; retired: false; reason: string; preservedAt: string }
  | { ok: false; retired: true; reason: string };

function restoreClaimedJournal(claimed: string, finalPath: string): string {
  try {
    linkSync(claimed, finalPath);
    fsyncParentDirectory(finalPath);
    unlinkSync(claimed);
    fsyncParentDirectory(finalPath);
    return finalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return claimed;
    throw error;
  }
}

function retireJournalIfHead(
  repo: string,
  sourceId: string,
  expectedRef: string,
  expectedHead: string,
  expectedReceipt: JournalFileReceipt,
): JournalRetireResult {
  const finalPath = journalPath(repo, sourceId);
  const claimed = finalPath + '.retire-' + process.pid + '-'
    + randomBytes(8).toString('hex');
  if (
    tryGit(repo, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
    || tryGit(repo, ['rev-parse', 'HEAD']) !== expectedHead
  ) return {
    ok: false, retired: false, reason: 'head_moved', preservedAt: finalPath,
  };
  let claimedByUs = false;
  try {
    // Claim first. Verification can no longer unlink a replacement pathname.
    renameSync(finalPath, claimed);
    claimedByUs = true;
    fsyncParentDirectory(finalPath);
  } catch (error) {
    let preservedAt = finalPath;
    if (claimedByUs && existsSync(claimed)) {
      try { preservedAt = restoreClaimedJournal(claimed, finalPath); }
      catch { preservedAt = claimed; }
    }
    return {
      ok: false,
      retired: false,
      reason: 'journal_claim_failed:'
        + (error instanceof Error ? error.message : String(error)),
      preservedAt,
    };
  }
  let unlinked = false;
  try {
    const actual = readJournalFile(claimed).receipt;
    if (!sameJournalReceipt(actual, expectedReceipt)) {
      const preservedAt = restoreClaimedJournal(claimed, finalPath);
      return {
        ok: false, retired: false, reason: 'journal_replaced', preservedAt,
      };
    }
    if (
      tryGit(repo, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
      || tryGit(repo, ['rev-parse', 'HEAD']) !== expectedHead
    ) {
      const preservedAt = restoreClaimedJournal(claimed, finalPath);
      return { ok: false, retired: false, reason: 'head_moved', preservedAt };
    }
    unlinkSync(claimed);
    unlinked = true;
    fsyncParentDirectory(finalPath);
    // A concurrent invocation may have claimed the now-free slot. It is not
    // ours and must survive; tell the caller not to start another publication.
    if (existsSync(finalPath)) {
      return { ok: false, retired: true, reason: 'replacement_wal_present' };
    }
    const headStable = tryGit(repo, ['symbolic-ref', '-q', 'HEAD']) === expectedRef
      && tryGit(repo, ['rev-parse', 'HEAD']) === expectedHead;
    return { ok: true, retired: true, headStable };
  } catch (error) {
    if (unlinked) {
      return {
        ok: false,
        retired: true,
        reason: 'journal_retire_durability_failed:'
          + (error instanceof Error ? error.message : String(error)),
      };
    }
    const preservedAt = existsSync(claimed)
      ? restoreClaimedJournal(claimed, finalPath)
      : finalPath;
    return {
      ok: false,
      retired: false,
      reason: 'journal_retire_failed:'
        + (error instanceof Error ? error.message : String(error)),
      preservedAt,
    };
  }
}

type ExactRefRead =
  | { kind: 'present'; oid: string }
  | { kind: 'missing' }
  | { kind: 'error'; reason: string };

function readExactRef(repo: string, ref: string): ExactRefRead {
  try {
    const oid = execFileSync(
      'git', ['-C', repositoryRoot(repo), 'show-ref', '--verify', '--hash', ref],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        env: controlledGitEnv(),
      },
    ).trim();
    return /^[0-9a-f]{40,64}$/.test(oid)
      ? { kind: 'present', oid }
      : { kind: 'error', reason: 'invalid_oid' };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    const reason = error instanceof Error ? error.message : String(error);
    // `git show-ref --verify` exits 1 or 128 with "not a valid ref" when absent.
    if (status === 1 || (status === 128 && /not a valid ref/.test(reason))) {
      return { kind: 'missing' };
    }
    return { kind: 'error', reason };
  }
}

function fsyncParentDirectory(filePath: string): void {
  // Windows does not support opening a directory as a normal fs fd. The live
  // Hive and supported durability deployments are POSIX; retain portability
  // without pretending Windows provided a directory-fsync guarantee.
  if (process.platform === 'win32') return;
  const dirFd = openSync(dirname(filePath), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

async function withVerifiedPageLocks<T>(
  engine: BrainEngine,
  files: readonly VerifiedConvergencePath[],
  work: () => Promise<T>,
): Promise<T> {
  const refs = [...new Map(files.map((file) => [
    `${file.sourceId}\0${file.slug}`,
    { sourceId: file.sourceId, slug: file.slug },
  ])).values()].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) || a.slug.localeCompare(b.slug));
  const acquire = (index: number): Promise<T> => index === refs.length
    ? work()
    : withPutPageOperationLock(
        engine,
        refs[index]!.sourceId,
        refs[index]!.slug,
        () => acquire(index + 1),
        { timeoutMs: 30_000 },
      );
  return acquire(0);
}

type AnchorFenceResult =
  | { ok: true }
  | { ok: false; reason: string };

async function advanceConvergenceAnchor(
  engine: BrainEngine,
  sourceId: string,
  repo: string,
  expectedRef: string,
  expectedHead: string,
  expectedRecorded: string | null,
  expectedCanonicalRouteEpoch: string,
  expectedStorageConfigFingerprint: OptionalFileFingerprint,
  expectedPageKeys: readonly string[],
  files: readonly VerifiedConvergencePath[],
  advanceAnchor: boolean,
  betweenProofAndCas?: () => void | Promise<void>,
): Promise<AnchorFenceResult> {
  try {
    return await engine.transaction(async (tx) => {
      // Global routing lock is first and remains held until transaction commit.
      // All route-changing triggers update this row and therefore cannot pass
      // between this proof and a source-anchor UPDATE.
      const [route] = await tx.executeRaw<{ epoch: string }>(
        `SELECT epoch::text AS epoch
           FROM canonical_routing_state
          WHERE singleton = 1
          FOR UPDATE`,
      );
      if (!route || route.epoch !== expectedCanonicalRouteEpoch) {
        return { ok: false, reason: 'canonical_routing_moved' };
      }
      const rows = await tx.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = $1 FOR UPDATE`,
        [sourceId],
      );
      if (
        rows.length !== 1
        || (rows[0]!.last_commit ?? null) !== expectedRecorded
      ) return { ok: false, reason: 'source_anchor_moved' };
      const livePages = await tx.executeRaw<{ source_id: string; slug: string }>(
        `SELECT source_id, slug FROM pages
          WHERE source_id = $1 AND deleted_at IS NULL`,
        [sourceId],
      );
      const livePageKeys = livePages
        .map((page) => `${page.source_id}\0${page.slug}`)
        .sort();
      if (
        livePageKeys.length !== expectedPageKeys.length
        || livePageKeys.some((key, index) => key !== expectedPageKeys[index])
      ) return { ok: false, reason: 'source_page_set_moved' };
      const ownership = await sourceCommitAnchorAllowed(tx, sourceId, repo);
      if (!ownership.owns) return { ok: false, reason: 'source_repo_moved' };
      if (!sameOptionalFileFingerprint(
        optionalFileFingerprint(join(repo, 'gbrain.yml')),
        expectedStorageConfigFingerprint,
      )) return { ok: false, reason: 'storage_config_moved' };

      const verify = async (): Promise<boolean> => {
        if (
          (await tx.executeRaw<{ epoch: string }>(
            `SELECT epoch::text AS epoch
               FROM canonical_routing_state WHERE singleton = 1`,
          ))[0]?.epoch !== expectedCanonicalRouteEpoch
          || !sameOptionalFileFingerprint(
            optionalFileFingerprint(join(repo, 'gbrain.yml')),
            expectedStorageConfigFingerprint,
          )
          ||
          tryGit(repo, ['symbolic-ref', '-q', 'HEAD']) !== expectedRef
          || tryGit(repo, ['rev-parse', expectedRef]) !== expectedHead
          || tryGit(repo, ['rev-parse', 'HEAD']) !== expectedHead
        ) return false;
        // A DB/file proof alone can bless a commit whose tree contains old
        // bytes. Bind every receipt to a regular blob in this exact commit.
        if (!gitTreeContainsReceipts(repo, expectedHead, files)) return false;
        for (const file of files) {
          if (!(await threePlaneEqual(
            tx, file.sourceId, file.slug, file.filePath, file.sha256,
          ))) return false;
        }
        return true;
      };

      if (!await verify()) return { ok: false, reason: 'pre_anchor_fence_missed' };
      await betweenProofAndCas?.();
      if (!await verify()) return { ok: false, reason: 'pre_anchor_fence_moved' };
      if (!advanceAnchor) return { ok: true };
      const updated = await tx.executeRaw<{ id: string }>(
        `UPDATE sources
            SET last_commit = $1, last_sync_at = now()
          WHERE id = $2
            AND last_commit IS NOT DISTINCT FROM $3
          RETURNING id`,
        [expectedHead, sourceId, expectedRecorded],
      );
      if (updated.length !== 1) {
        throw new Error('source_anchor_cas_missed');
      }
      if (!await verify()) {
        // Throw, rather than return, so the anchor UPDATE rolls back.
        throw new Error('post_anchor_fence_moved');
      }
      return { ok: true };
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function finalizeConvergenceAnchor(
  engine: BrainEngine,
  sourceId: string,
  repo: string,
  expectedRef: string,
  expectedHead: string,
  expectedRecorded: string | null,
  expectedCanonicalRouteEpoch: string,
  expectedStorageConfigFingerprint: OptionalFileFingerprint,
  expectedPageKeys: readonly string[],
  files: readonly VerifiedConvergencePath[],
  advanceAnchor: boolean,
  betweenProofAndCas?: () => void | Promise<void>,
): Promise<AnchorFenceResult> {
  return withVerifiedPageLocks(engine, files, () =>
    advanceConvergenceAnchor(
      engine, sourceId, repo, expectedRef, expectedHead,
      expectedRecorded, expectedCanonicalRouteEpoch,
      expectedStorageConfigFingerprint, expectedPageKeys,
      files, advanceAnchor, betweenProofAndCas,
    ));
}

function convergenceComplete(report: ConvergenceReport): boolean {
  return report.conflicts.length === 0
    && report.errors.length === 0
    && report.would_commit === 0
    && report.missing_file === 0
    && report.post_verify_divergent === 0
    && report.anchor_not_advanced !== true;
}

export async function runCanonicalPlaneConvergence(
  engine: BrainEngine,
  opts: {
  sourceId: string;
  yes?: boolean;
  json?: boolean;
  _beforeCommitIndexLeaseForTest?: () => void;
  _afterCommitSnapshotForTest?: () => void;
  _afterCommitRefPublishForTest?: () => void;
  _beforeCommitRefCasForTest?: () => void;
  _afterPageScanForTest?: () => void | Promise<void>;
  _betweenAnchorProofAndCasForTest?: () => void | Promise<void>;
},
): Promise<ConvergenceResult> {
  const sourceId = opts.sourceId.trim();
  const mutate = opts.yes === true;
  const emptyCommit = { created: false, sha: null as string | null, path_count: 0 };
  const report: ConvergenceReport = {
    source_id: sourceId,
    repo: null,
    pre_head: null,
    pre_ref: null,
    scanned: 0,
    projection_backfilled: 0,
    already_equal: 0,
    would_rewrite: 0,
    would_commit: 0,
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

  try {
  return await withRefreshingLock(engine, syncLockId(sourceId), async () => {
    const routing = await engine.transaction(async (tx): Promise<RoutingSnapshot | null> => {
      const [state] = await tx.executeRaw<{ epoch: string }>(
        `SELECT epoch::text AS epoch
           FROM canonical_routing_state
          WHERE singleton = 1
          FOR SHARE`,
      );
      if (!state) throw new Error('canonical_routing_state_missing');

      const source = await fetchSource(tx, sourceId);
      if (!source) return null;
      const sourceRows = await tx.executeRaw<{
        id: string; local_path: string | null; archived: boolean | null;
      }>(
        `SELECT id, local_path, archived FROM sources ORDER BY id`,
      );
      const configRows = await tx.executeRaw<{ key: string; value: string | null }>(
        `SELECT key, value FROM config
          WHERE key IN ('sync.repo_path', 'sync.write_through')
          ORDER BY key`,
      );
      const config = new Map(configRows.map((row) => [row.key, row.value]));
      const pages = await tx.executeRaw<RoutingSnapshot['pages'][number]>(
        `SELECT source_id, slug, source_path, source_uri, page_kind
           FROM pages
          WHERE source_id = $1 AND deleted_at IS NULL
          ORDER BY slug COLLATE "C"`,
        [sourceId],
      );
      const repoRaw = source.local_path ?? config.get('sync.repo_path') ?? null;
      const repo = repoRaw ? msysToNativePath(repoRaw) : null;
      const storageConfig = repo
        ? readOptionalFileSnapshot(join(repo, 'gbrain.yml'))
        : { fingerprint: { kind: 'missing' } as const, text: null };
      return {
        epoch: state.epoch,
        source,
        sourceRows,
        syncRepoPath: config.get('sync.repo_path') ?? null,
        writeThrough: config.get('sync.write_through') ?? null,
        storageConfig,
        pages,
      };
    });
    if (!routing) {
      report.errors.push({ source_id: sourceId, slug: '', reason: 'source_not_found' });
      return { report, exitCode: 2 };
    }
    const expectedCanonicalRouteEpoch = routing.epoch;
    const source = routing.source;
    const repoRaw = source.local_path ?? routing.syncRepoPath;
    const repo = repoRaw ? msysToNativePath(repoRaw) : null;
    const otherLocals = new Set(
      routing.sourceRows
        .filter((row) => row.id !== sourceId && row.local_path != null)
        .map((row) => msysToNativePath(row.local_path!)),
    );
    const pages = routing.pages;
    if (!repo || !existsSync(repo)) {
      report.errors.push({ source_id: sourceId, slug: '', reason: 'repo_not_found' });
      return { report, exitCode: 2 };
    }
    report.repo = repo;
    if (parseWriteThroughDisabled(routing.writeThrough)) {
      report.errors.push({
        source_id: sourceId, slug: '', reason: 'write_through_disabled',
      });
      return { report, exitCode: 2 };
    }
    let recorded = source.last_commit;
    let pushAtTerminalReturn: {
      expectedRef: string;
      expectedHead: string;
    } | null = null;

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
    report.pre_ref = symbolic;

    const gitRoot = repositoryRoot(repo);
    const objectFormat = gitObjectFormat(repo);
    const headTrackedBlobs = trackedBlobsAtCommit(repo, head);

    const statusOut = tryGit(repo, ['status', '--porcelain=v1', '-uall']);
    if (statusOut == null) {
      report.errors.push({ source_id: sourceId, slug: '', reason: 'git_status_failed' });
      return { report, exitCode: 2 };
    }
    const dirty = statusOut.split('\n').filter(Boolean);
    const trackedDirty = dirty.filter(isTrackedDirty).map(dirtyPath);
    const sourceArchived = (source as { archived?: boolean | null }).archived === true;

    const dbOnlyPrefixes = effectiveDbOnlyDirs(
      routing.storageConfig.text == null
        ? []
        : (parseStorageConfigContent(
            routing.storageConfig.text,
            join(repo, 'gbrain.yml'),
          )?.db_only ?? []),
    );

    const scannedPageKeys = [...pages]
      .map((page) => `${page.source_id}\0${page.slug}`)
      .sort();

    const absToSlug = new Map<string, string>();
    for (const row of pages) {
      const target = resolvePageWriteTargetFromLoadedMeta({
        sourceId,
        slug: row.slug,
        sourceLocalPath: source.local_path,
        sourcePath: row.source_path,
        sourceUri: row.source_uri,
        repoPath: repo,
        otherSourceLocalPaths: otherLocals,
      });
      if (!target.ok) continue;
      const key = resolve(target.filePath);
      const owner = absToSlug.get(key);
      if (owner && owner !== row.slug) {
        report.errors.push({
          source_id: sourceId,
          slug: row.slug,
          reason: `canonical_target_collision:${owner}`,
        });
        return { report, exitCode: 2 };
      }
      absToSlug.set(key, row.slug);
    }

    async function validatedTrackedDirtyAbs(
      relPaths: readonly string[],
      countResume: boolean,
      failureReason: string,
    ): Promise<Set<string> | null> {
      const next = new Set<string>();
      const gitRepo = repo!;
      for (const rel of relPaths) {
        const abs = resolve(gitRepo, rel);
        next.add(abs);
        const slug = absToSlug.get(abs);
        if (!slug) {
          report.errors.push({ source_id: sourceId, slug: '', reason: failureReason });
          return null;
        }
        const stored = await loadCanonicalProjection(engine, sourceId, slug);
        if (!stored || !existsSync(abs)
          || sha256Utf8(readFileSync(abs)) !== stored.sha256) {
          report.errors.push({ source_id: sourceId, slug, reason: failureReason });
          return null;
        }
        if (countResume) report.resumed_canonical_dirty++;
      }
      return next;
    }

    let dirtyAbs = await validatedTrackedDirtyAbs(
      trackedDirty,
      true,
      'dirty_tracked_tree',
    );
    if (!dirtyAbs) return { report, exitCode: 2 };

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

    let pendingRecovery: PendingRecovery | null = null;
    const journalRead: ConvergenceJournalRead = mutate
      ? readJournal(repo, sourceId)
      : { kind: 'none' };

    if (mutate && journalRead.kind !== 'none') {
      const refNow = tryGit(repo, ['symbolic-ref', '-q', 'HEAD']);
      const headNow = tryGit(repo, ['rev-parse', 'HEAD']);
      if (
        !refNow
        || !headNow
        || refNow !== report.pre_ref
        || headNow !== report.pre_head
      ) {
        report.errors.push({
          source_id: sourceId, slug: '', reason: 'head_moved_before_journal_recovery',
        });
        return { report, exitCode: 2 }; // WAL is deliberately preserved.
      }

      if (journalRead.kind === 'invalid') {
        // With no usable receipt, retirement is safe only when the source anchor
        // already names this exact live commit: there is no unanchored result to
        // recover. Otherwise preserve the file for explicit operator inspection.
        if (recorded !== headNow) {
          report.errors.push({
            source_id: sourceId, slug: '', reason: 'legacy_wal_unattributed',
          });
          return { report, exitCode: 2 };
        }
        const retired = retireJournalIfHead(
          repo, sourceId, refNow, headNow, journalRead.receipt,
        );
        if (!retired.ok || !retired.headStable) {
          report.errors.push({
            source_id: sourceId, slug: '', reason: 'legacy_wal_unattributed',
          });
          return { report, exitCode: 2 };
        }
      } else if (journalRead.kind === 'legacy') {
        const legacy = journalRead.journal;
        if (headNow === legacy.preHead || recorded === headNow) {
          const retired = retireJournalIfHead(
            repo, sourceId, refNow, headNow, journalRead.receipt,
          );
          if (!retired.ok || !retired.headStable) {
            report.errors.push({
              source_id: sourceId, slug: '', reason: 'head_moved_retiring_legacy_wal',
            });
            return { report, exitCode: 2 };
          }
        } else if (
          tryGit(repo, ['rev-parse', `${headNow}^`]) === legacy.preHead
          && isGbrainPlaneCommit(tryGit(repo, ['log', '-1', '--format=%s', headNow]) ?? '')
        ) {
          // The old format has no tree/blob receipts. The already-completed
          // anchor..HEAD materialization preflight plus the full scan below are
          // the only admissible proof; do not anchor here.
          pendingRecovery = {
            kind: 'legacy',
            journal: legacy,
            journalReceipt: journalRead.receipt,
            ref: refNow,
            head: headNow,
          };
        } else {
          report.errors.push({
            source_id: sourceId, slug: '', reason: 'legacy_wal_unattributed',
          });
          return { report, exitCode: 2 };
        }
      } else {
        const journal = journalRead.journal;
        const files = journalFiles(repo, journal);
        if (
          journal.expectedRef !== refNow
          || tryGit(repo, ['rev-parse', `${journal.expectedCommit}^`]) !== journal.preHead
          || tryGit(repo, ['rev-parse', `${journal.expectedCommit}^{tree}`])
            !== journal.expectedTree
          || !gitTreeContainsReceipts(repo, journal.expectedCommit, files, false)
        ) {
          report.errors.push({
            source_id: sourceId, slug: '', reason: 'journal_commit_mismatch',
          });
          return { report, exitCode: 2 };
        }

        const liveDescendsPre = headNow === journal.preHead
          || tryGit(repo, ['merge-base', journal.preHead, headNow]) === journal.preHead;
        const subjects = liveDescendsPre
          ? tryGit(repo, ['log', '--format=%s', `${journal.preHead}..${headNow}`])
          : null;
        if (
          !liveDescendsPre
          || subjects == null
          || subjects.split('\n').filter(Boolean).some((s) => !isGbrainPlaneCommit(s))
        ) {
          report.errors.push({
            source_id: sourceId, slug: '', reason: 'journal_head_unrelated',
          });
          return { report, exitCode: 2 };
        }

        const candidateInLiveHistory = headNow === journal.expectedCommit
          || tryGit(repo, ['merge-base', journal.expectedCommit, headNow])
            === journal.expectedCommit;

        let publication: 'published' | 'published_superseded' | 'never_published';
        if (journal.version === 4) {
          if (!candidateInLiveHistory) {
            report.errors.push({
              source_id: sourceId, slug: '', reason: 'journal_publication_ambiguous',
            });
            return { report, exitCode: 2 };
          }
          publication = 'published';
        } else {
          const proofRef = convergencePublicationRef(
            journal.expectedRef,
            journal.preHead,
            journal.expectedCommit,
            journal.publicationNonce,
          );
          const proof = readExactRef(repo, proofRef);
          if (proof.kind === 'error') {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: `journal_publication_probe_failed:${proof.reason}`,
            });
            return { report, exitCode: 2 };
          }
          if (proof.kind === 'present' && proof.oid !== journal.expectedCommit) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: 'journal_publication_marker_mismatch',
            });
            return { report, exitCode: 2 };
          }
          if (proof.kind === 'missing' && candidateInLiveHistory) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: 'journal_publication_evidence_inconsistent',
            });
            return { report, exitCode: 2 };
          }
          publication = proof.kind === 'missing'
            ? 'never_published'
            : (candidateInLiveHistory ? 'published' : 'published_superseded');
        }

        if (publication === 'never_published') {
          // Only v5 can enter this branch.
          const discarded = verifyAndDiscardUnpublishedLease(
            repo, journal as ConvergenceJournalV5, refNow, headNow,
          );
          if (!discarded.ok) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: 'journal_recovery_failed:' + discarded.reason,
            });
            return { report, exitCode: 2 };
          }
          const retired = retireJournalIfHead(
            repo, sourceId, refNow, headNow, journalRead.receipt,
          );
          if (!retired.ok || !retired.headStable) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: retired.ok
                ? 'head_moved_after_retiring_unpublished_wal'
                : 'unpublished_wal_retire_failed:' + retired.reason,
            });
            return { report, exitCode: 2 };
          }
          // Continue the normal scan on live HEAD. Never assign/anchor expectedCommit.
        } else {
          // Both live/ancestor and published-then-superseded candidates are known to
          // have published. A superseding recognized HEAD is the target, never C.
          if (
            journal.routeEpoch !== expectedCanonicalRouteEpoch
            || !sameOptionalFileFingerprint(
              journal.storageConfigFingerprint,
              routing.storageConfig.fingerprint,
            )
          ) {
            report.errors.push({
              source_id: sourceId, slug: '', reason: 'journal_routing_moved',
            });
            return { report, exitCode: 2 };
          }
          const indexRepair = reconcilePublishedIndex(repo, journal, refNow, headNow);
          if (!indexRepair.ok) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: 'journal_recovery_failed:' + indexRepair.reason,
            });
            return { report, exitCode: 2 };
          }
          const repairedStatus = tryGit(repo, ['status', '--porcelain=v1', '-uall']);
          if (repairedStatus == null) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: 'git_status_failed_after_index_repair',
            });
            return { report, exitCode: 2 }; // WAL retained
          }
          const refreshed = await validatedTrackedDirtyAbs(
            repairedStatus.split('\n').filter(Boolean)
              .filter(isTrackedDirty)
              .map(dirtyPath),
            false,
            'dirty_tracked_tree_after_index_repair',
          );
          if (!refreshed) return { report, exitCode: 2 }; // WAL retained
          dirtyAbs = refreshed;
          pendingRecovery = {
            kind: 'current',
            journal,
            journalReceipt: journalRead.receipt,
            ref: refNow,
            head: headNow,
            indexProof: indexRepair.proof,
          };
        }
      }
    }

    const verifiedPaths = new Map<string, VerifiedConvergencePath>();
    const anchorReceipts = new Map<string, VerifiedConvergencePath>();

    function rememberAnchorReceipt(
      slug: string,
      filePath: string,
      sha256: string,
    ): boolean {
      const key = resolve(filePath);
      const owner = anchorReceipts.get(key);
      if (owner && (owner.sourceId !== sourceId || owner.slug !== slug)) {
        report.errors.push({
          source_id: sourceId,
          slug,
          reason: `canonical_target_collision:${owner.sourceId}/${owner.slug}`,
        });
        return false;
      }
      anchorReceipts.set(key, { sourceId, slug, filePath, sha256 });
      return true;
    }

    function rememberVerified(
      slug: string,
      filePath: string,
      sha256: string,
    ): boolean {
      if (!rememberAnchorReceipt(slug, filePath, sha256)) return false;
      const key = resolve(filePath);
      const owner = verifiedPaths.get(key);
      if (owner && (owner.sourceId !== sourceId || owner.slug !== slug)) {
        report.errors.push({
          source_id: sourceId,
          slug,
          reason: `canonical_target_collision:${owner.sourceId}/${owner.slug}`,
        });
        return false;
      }
      verifiedPaths.set(key, { sourceId, slug, filePath, sha256 });
      return true;
    }

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
            if (!(await threePlaneEqual(
              engine, sourceId, ref.slug, target.filePath, projection.sha256,
            ))) {
              report.post_verify_divergent++;
              report.errors.push({
                source_id: sourceId, slug: ref.slug, reason: 'post_verify_divergent',
              });
              return 'error' as const;
            }
            report.already_equal++;
            report.verified_equal++;
            if (!rememberAnchorReceipt(ref.slug, target.filePath, projection.sha256)) {
              return 'error' as const;
            }
            const relPath = relative(gitRoot, resolve(target.filePath)).replace(/\\/g, '/');
            if (
              !relPath
              || relPath === '..'
              || relPath.startsWith('../')
              || isAbsolute(relPath)
            ) {
              report.errors.push({
                source_id: sourceId, slug: ref.slug, reason: 'canonical_target_outside_repo',
              });
              return 'error' as const;
            }
            // Status is only a hint: assume-unchanged/skip-worktree can hide a tracked
            // byte delta and ignored/untracked canonical files may not appear at all.
            // Compare the exact HEAD blob identity to the just-verified canonical bytes.
            const canonicalBytes = readFileSync(target.filePath);
            if (sha256Utf8(canonicalBytes) !== projection.sha256) {
              report.post_verify_divergent++;
              report.errors.push({
                source_id: sourceId, slug: ref.slug, reason: 'file_changed_after_verify',
              });
              return 'error' as const;
            }
            const headBlob = headTrackedBlobs.get(relPath);
            const headBlobHealthy = headBlob != null
              && headBlob.oid === gitBlobOid(canonicalBytes, objectFormat);
            const needsGitCommit = dirtyAbs.has(resolve(target.filePath)) || !headBlobHealthy;
            if (needsGitCommit && !mutate) {
              report.would_commit++;
              return 'dry' as const;
            }
            if (needsGitCommit) {
              if (!rememberVerified(ref.slug, target.filePath, projection.sha256)) {
                return 'error' as const;
              }
            }
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

          if (!(await threePlaneEqual(
            engine, sourceId, ref.slug, target.filePath, live.sha256,
          ))) {
            report.post_verify_divergent++;
            report.errors.push({
              source_id: sourceId, slug: ref.slug, reason: 'post_verify_divergent',
            });
            return 'error' as const;
          }
          if (!rememberVerified(ref.slug, target.filePath, live.sha256)) {
            return 'error' as const;
          }
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

    await opts._afterPageScanForTest?.();

    // Construction of a current PendingRecovery was possible only after
    // reconcilePublishedIndex installed and reread the real index; the status
    // refresh in §5.1 also completed. It is now safe to free the single WAL slot
    // for the successor. If this process dies in the following gap, the old
    // source anchor plus recognized, fully materialized Git history recovers H.
    if (mutate && pendingRecovery && verifiedPaths.size > 0) {
      const retired = retireJournalIfHead(
        repo,
        sourceId,
        pendingRecovery.ref,
        pendingRecovery.head,
        pendingRecovery.journalReceipt,
      );
      if (!retired.ok || !retired.headStable) {
        report.errors.push({
          source_id: sourceId,
          slug: '',
          reason: retired.ok
            ? 'head_moved_after_settling_recovery'
            : `recovered_wal_retire_failed:${retired.reason}`,
        });
        report.anchor_not_advanced = true;
        return { report, exitCode: 1 };
      }
      pendingRecovery = null; // exact receipt is gone, never before index proof
    }

    let freshJournalReceipt: JournalFileReceipt | null = null;
    function requireFreshJournalReceipt(): JournalFileReceipt | null {
      if (freshJournalReceipt) return freshJournalReceipt;
      report.errors.push({
        source_id: sourceId, slug: '', reason: 'fresh_wal_receipt_missing',
      });
      report.anchor_not_advanced = true;
      return null;
    }

    if (mutate && verifiedPaths.size > 0) {
      const inputs = [...verifiedPaths.values()];
      const anchorFiles = [...anchorReceipts.values()];
      const advanceFreshAnchor = convergenceComplete(report);
      let publishedOutcome: VerifiedBatchCommitOutcome | null = null;

      // Page operation locks and the DB routing-row lock nest in this order.
      // Every trigger that changes source/page/config routing needs the singleton
      // row, so it cannot commit while the synchronous Git publisher is inside
      // this transaction. The source anchor is updated before that lock releases.
      const publication = await withVerifiedPageLocks(engine, anchorFiles, async () => {
        try {
          return await engine.transaction(async (tx) => {
            const [route] = await tx.executeRaw<{ epoch: string }>(
              `SELECT epoch::text AS epoch
                 FROM canonical_routing_state
                WHERE singleton = 1
                FOR UPDATE`,
            );
            if (!route || route.epoch !== expectedCanonicalRouteEpoch) {
              return {
                outcome: null,
                fence: { ok: false, reason: 'canonical_routing_moved' } as AnchorFenceResult,
                anchored: false,
              };
            }
            const [lockedSource] = await tx.executeRaw<{ last_commit: string | null }>(
              `SELECT last_commit FROM sources WHERE id = $1 FOR UPDATE`,
              [sourceId],
            );
            if (!lockedSource
              || (lockedSource.last_commit ?? null) !== (recorded ?? null)) {
              return {
                outcome: null,
                fence: { ok: false, reason: 'source_anchor_moved' } as AnchorFenceResult,
                anchored: false,
              };
            }

            const verify = async (
              expectedSourceAnchor: string | null,
              expectedGitHead?: string,
            ): Promise<AnchorFenceResult> => {
              const [liveRoute] = await tx.executeRaw<{ epoch: string }>(
                `SELECT epoch::text AS epoch
                   FROM canonical_routing_state WHERE singleton = 1`,
              );
              if (!liveRoute || liveRoute.epoch !== expectedCanonicalRouteEpoch) {
                return { ok: false, reason: 'canonical_routing_moved' };
              }
              const [liveSource] = await tx.executeRaw<{ last_commit: string | null }>(
                `SELECT last_commit FROM sources WHERE id = $1`, [sourceId],
              );
              if (!liveSource
                || (liveSource.last_commit ?? null) !== expectedSourceAnchor) {
                return { ok: false, reason: 'source_anchor_moved' };
              }
              const livePages = await tx.executeRaw<{ source_id: string; slug: string }>(
                `SELECT source_id, slug FROM pages
                  WHERE source_id = $1 AND deleted_at IS NULL`,
                [sourceId],
              );
              const liveKeys = livePages
                .map((page) => `${page.source_id}\0${page.slug}`)
                .sort();
              if (liveKeys.length !== scannedPageKeys.length
                || liveKeys.some((key, index) => key !== scannedPageKeys[index])) {
                return { ok: false, reason: 'source_page_set_moved' };
              }
              const ownership = await sourceCommitAnchorAllowed(tx, sourceId, repo);
              if (!ownership.owns) return { ok: false, reason: 'source_repo_moved' };
              if (!sameOptionalFileFingerprint(
                optionalFileFingerprint(join(repo, 'gbrain.yml')),
                routing.storageConfig.fingerprint,
              )) return { ok: false, reason: 'storage_config_moved' };
              for (const file of anchorFiles) {
                if (!(await threePlaneEqual(
                  tx, file.sourceId, file.slug, file.filePath, file.sha256,
                ))) return { ok: false, reason: `page_moved:${file.slug}` };
              }
              if (expectedGitHead != null && (
                tryGit(repo, ['symbolic-ref', '-q', 'HEAD']) !== report.pre_ref
                || tryGit(repo, ['rev-parse', 'HEAD']) !== expectedGitHead
                || !gitTreeContainsReceipts(repo, expectedGitHead, anchorFiles)
              )) return { ok: false, reason: 'git_plane_moved' };
              return { ok: true };
            };

            const firstProof = await verify(recorded ?? null);
            if (!firstProof.ok) {
              return { outcome: null, fence: firstProof, anchored: false };
            }
            await opts._betweenAnchorProofAndCasForTest?.();
            const secondProof = await verify(recorded ?? null);
            if (!secondProof.ok) {
              return { outcome: null, fence: secondProof, anchored: false };
            }

            const outcome = commitWriteThroughFiles(
              repo,
              inputs.map((item) => ({
                absPath: item.filePath,
                expectedSha256: item.sha256,
              })),
              `gbrain: converge canonical page planes (${sourceId})`,
              {
                expectedHead: report.pre_head!,
                expectedRef: report.pre_ref!,
                beforePublish: ({
                  commitSha,
                  treeSha,
                  publishedFiles,
                  indexLeaseIdentity,
                  publicationNonce,
                }) => {
                  const published = new Set(
                    publishedFiles.map((file) => resolve(file.absPath)),
                  );
                  const commitFiles = inputs.filter(
                    (file) => published.has(resolve(file.filePath)),
                  );
                  if (commitFiles.length !== published.size) {
                    throw new Error('published path lacks convergence receipt');
                  }
                  freshJournalReceipt = writeJournal(
                    repo,
                    sourceId,
                    report.pre_ref!,
                    report.pre_head!,
                    commitSha,
                    treeSha,
                    expectedCanonicalRouteEpoch,
                    routing.storageConfig.fingerprint,
                    indexLeaseIdentity,
                    publicationNonce,
                    commitFiles,
                    anchorFiles,
                  );
                },
                _beforeIndexLeaseForTest: opts._beforeCommitIndexLeaseForTest,
                _afterSnapshotForTest: opts._afterCommitSnapshotForTest,
                _beforeRefCasForTest: opts._beforeCommitRefCasForTest,
                _afterRefPublishForTest: opts._afterCommitRefPublishForTest,
              },
            );
            publishedOutcome = outcome;
            if (outcome.status !== 'committed') {
              return { outcome, fence: { ok: true } as AnchorFenceResult, anchored: false };
            }

            const postPublish = await verify(recorded ?? null, outcome.sha);
            if (!postPublish.ok) {
              // No DB write occurred. Commit/index and WAL remain for exact retry.
              return { outcome, fence: postPublish, anchored: false };
            }
            if (!advanceFreshAnchor) {
              return { outcome, fence: { ok: true } as AnchorFenceResult, anchored: false };
            }

            const updated = await tx.executeRaw<{ id: string }>(
              `UPDATE sources
                  SET last_commit = $1, last_sync_at = now()
                WHERE id = $2 AND last_commit IS NOT DISTINCT FROM $3
                RETURNING id`,
              [outcome.sha, sourceId, recorded ?? null],
            );
            if (updated.length !== 1) throw new Error('source_anchor_cas_missed');
            const postAnchor = await verify(outcome.sha, outcome.sha);
            if (!postAnchor.ok) {
              // Throw so the anchor update rolls back; Git/WAL remain recoverable.
              throw new Error(`post_anchor_fence_moved:${postAnchor.reason}`);
            }
            return { outcome, fence: { ok: true } as AnchorFenceResult, anchored: true };
          });
        } catch (error) {
          return {
            outcome: publishedOutcome,
            fence: {
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            } as AnchorFenceResult,
            anchored: false,
          };
        }
      });

      const outcome = publication.outcome;
      if (outcome == null) {
        report.errors.push({
          source_id: sourceId, slug: '',
          reason: `publication_fence_failed:${
            publication.fence.ok ? 'unknown' : publication.fence.reason
          }`,
        });
        report.anchor_not_advanced = true;
        return { report, exitCode: 1 };
      }

      if (outcome.status === 'committed') {
        report.commit = {
          created: true, sha: outcome.sha, path_count: outcome.pathCount,
        };
      } else if (outcome.status === 'conflict') {
        if (outcome.committedSha) {
          report.commit = {
            created: true,
            sha: outcome.committedSha,
            path_count: outcome.pathCount ?? inputs.length,
          };
          report.anchor_not_advanced = true;
        }
        const item = outcome.path
          ? verifiedPaths.get(resolve(outcome.path))
          : undefined;
        report.conflicts.push({
          source_id: sourceId,
          slug: item?.slug ?? '',
          reason: `git_${outcome.reason}`,
          expected_hash: outcome.expected ?? item?.sha256 ?? report.pre_head,
          actual_hash: outcome.actual ?? tryGit(repo, ['rev-parse', 'HEAD']),
        });
      } else if (outcome.status === 'error') {
        if (outcome.committedSha) {
          report.commit = {
            created: true,
            sha: outcome.committedSha,
            path_count: outcome.pathCount ?? inputs.length,
          };
          report.anchor_not_advanced = true;
        }
        report.errors.push({
          source_id: sourceId, slug: '', reason: `commit_failed:${outcome.detail}`,
        });
      }

      if (outcome.status === 'committed' && advanceFreshAnchor) {
        if (publication.fence.ok && publication.anchored) {
          // The source transaction is already committed here.
          recorded = outcome.sha;
          pushAtTerminalReturn = {
            expectedRef: report.pre_ref!, expectedHead: outcome.sha,
          };
          const receipt = requireFreshJournalReceipt();
          const retired = receipt == null ? null : retireJournalIfHead(
            repo, sourceId, report.pre_ref!, outcome.sha, receipt,
          );
          if (!retired || !retired.ok || !retired.headStable) {
            report.errors.push({
              source_id: sourceId, slug: '',
              reason: !retired
                ? 'anchored_wal_receipt_unavailable'
                : retired.ok
                  ? 'head_moved_after_retiring_anchored_wal'
                  : `anchored_wal_retire_failed:${retired.reason}`,
            });
          }
        } else {
          report.errors.push({
            source_id: sourceId,
            slug: '',
            reason: `anchor_fence_failed:${
              publication.fence.ok ? 'anchor_not_written' : publication.fence.reason
            }`,
          });
          report.anchor_not_advanced = true;
        }
      } else if (outcome.status === 'committed' && publication.fence.ok) {
        // commitWriteThroughFiles returned committed only after ref, real index,
        // commit blobs, and final disk receipts were proved. S3 permits this verified
        // subset commit while the source anchor remains old.
        report.anchor_not_advanced = true;
        const receipt = requireFreshJournalReceipt();
        const retired = receipt == null ? null : retireJournalIfHead(
          repo, sourceId, report.pre_ref!, outcome.sha, receipt,
        );
        if (!retired || !retired.ok || !retired.headStable) {
          report.errors.push({
            source_id: sourceId, slug: '',
            reason: !retired
              ? 'partial_wal_receipt_unavailable'
              : retired.ok
                ? 'head_moved_after_settling_partial_commit'
                : `partial_wal_retire_failed:${retired.reason}`,
          });
        }
      } else if (!publication.fence.ok) {
        // A ref may already have published. Preserve its WAL and old DB anchor.
        report.errors.push({
          source_id: sourceId, slug: '',
          reason: `publication_fence_failed:${publication.fence.reason}`,
        });
        report.anchor_not_advanced = true;
      }
    }

    let complete = convergenceComplete(report);
    if (
      mutate
      && complete
      && !report.commit.created
      && recorded !== report.pre_head
    ) {
      const caughtUp = await finalizeConvergenceAnchor(
        engine,
        sourceId,
        repo,
        report.pre_ref!,
        report.pre_head!,
        recorded ?? null,
        expectedCanonicalRouteEpoch,
        routing.storageConfig.fingerprint,
        scannedPageKeys,
        [...anchorReceipts.values()],
        true,
        opts._betweenAnchorProofAndCasForTest,
      );
      if (caughtUp.ok) {
        // The DB transaction has committed. Report that truth even if WAL retirement
        // subsequently fails; never pretend or try to roll the anchor back.
        recorded = report.pre_head!;
        report.commit = { created: false, sha: report.pre_head!, path_count: 0 };
        pushAtTerminalReturn = {
          expectedRef: report.pre_ref!, expectedHead: report.pre_head!,
        };

        if (pendingRecovery) {
          const retired = retireJournalIfHead(
            repo,
            sourceId,
            pendingRecovery.ref,
            pendingRecovery.head,
            pendingRecovery.journalReceipt,
          );
          if (!retired.ok || !retired.headStable) {
            report.errors.push({
              source_id: sourceId,
              slug: '',
              reason: retired.ok
                ? 'head_moved_after_retiring_anchored_wal'
                : `anchored_wal_retire_failed:${retired.reason}`,
            });
            // The anchor DID advance. The nonzero result means cleanup is incomplete.
          } else {
            pendingRecovery = null;
          }
        }
      } else {
        report.errors.push({
          source_id: sourceId, slug: '',
          reason: `anchor_fence_failed:${caughtUp.reason}`,
        });
        report.anchor_not_advanced = true;
      }
    }
    if (
      mutate
      && complete
      && !report.commit.created
      && report.commit.sha == null
      && recorded === report.pre_head
    ) {
      // A clean/no-anchor run still needs a point-in-time whole-source proof.
      // `advanceAnchor=false` takes the source-row lock, compares the exact page
      // set/epoch, and rechecks every receipt without updating last_sync_at.
      const provenClean = await finalizeConvergenceAnchor(
        engine,
        sourceId,
        repo,
        report.pre_ref!,
        report.pre_head!,
        recorded ?? null,
        expectedCanonicalRouteEpoch,
        routing.storageConfig.fingerprint,
        scannedPageKeys,
        [...anchorReceipts.values()],
        false,
        opts._betweenAnchorProofAndCasForTest,
      );
      if (!provenClean.ok) {
        report.errors.push({
          source_id: sourceId, slug: '',
          reason: `completion_fence_failed:${provenClean.reason}`,
        });
        report.anchor_not_advanced = true;
      } else if (pendingRecovery) {
        const retired = retireJournalIfHead(
          repo,
          sourceId,
          pendingRecovery.ref,
          pendingRecovery.head,
          pendingRecovery.journalReceipt,
        );
        if (!retired.ok || !retired.headStable) {
          report.errors.push({
            source_id: sourceId, slug: '',
            reason: retired.ok
              ? 'head_moved_after_retiring_proven_clean_wal'
              : `proven_clean_wal_retire_failed:${retired.reason}`,
          });
        } else {
          pendingRecovery = null;
        }
      }
    }
    if (mutate && !complete) {
      report.anchor_not_advanced = true;
      // Incomplete scan that did not enter a successor publication must preserve
      // pendingRecovery and its WAL. A later run repeats classification.
    }
    complete = convergenceComplete(report);

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
    // Existing `let exitCode ...` calculation is complete above this point.
    if (pushAtTerminalReturn) {
      triggerManagedDurabilityPushOnly(
        repo,
        pushAtTerminalReturn.expectedRef,
        pushAtTerminalReturn.expectedHead,
      );
    }
    return { report, exitCode };
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
    `source=${report.source_id} repo=${report.repo ?? '-'} pre_head=${report.pre_head ?? '-'} pre_ref=${report.pre_ref ?? '-'}`,
    `scanned=${report.scanned} backfilled=${report.projection_backfilled} already_equal=${report.already_equal} would_rewrite=${report.would_rewrite} would_commit=${report.would_commit} rewritten=${report.rewritten}`,
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
