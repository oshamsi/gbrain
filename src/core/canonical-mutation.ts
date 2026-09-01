import { readFileSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import type { CanonicalPageProjection } from './page-canonical.ts';
import {
  applyCanonicalMarkdownToStore,
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  projectionIsFresh,
  sha256Utf8,
} from './page-canonical.ts';
import {
  writePageThrough,
  type WriteThroughLogger,
  type WriteThroughResult,
} from './write-through.ts';

export class CanonicalMutationPartialError<T = unknown> extends Error {
  readonly code = 'CANONICAL_FILE_WRITE_FAILED' as const;

  constructor(
    readonly sourceId: string,
    readonly slug: string,
    readonly committed: T,
    readonly writeThrough: WriteThroughResult,
  ) {
    super(
      `canonical file write failed for ${sourceId}/${slug}: ` +
      `${writeThrough.error ?? writeThrough.skipped ?? 'unknown'}`,
    );
    this.name = 'CanonicalMutationPartialError';
  }
}

/**
 * Caller must hold withPutPageOperationLock for the complete read/modify call.
 * No file byte is touched until engine.transaction has committed.
 */
export async function commitCanonicalMarkdownMutation<T>(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  markdown: string,
  mutateDb: (tx: BrainEngine) => Promise<T>,
  opts: {
    logger?: WriteThroughLogger;
    expectedPath: string;
    /** Exact file digest captured while preparing this RMW; null means absent. */
    expectedTargetSha256: string | null;
  },
): Promise<{
  value: T;
  projection: CanonicalPageProjection;
  file: WriteThroughResult;
}> {
  const committed = await engine.transaction(async (tx) => {
    const value = await mutateDb(tx);
    const projection = await applyCanonicalMarkdownToStore(tx, sourceId, slug, markdown);
    return { value, projection };
  }); // DB COMMIT is complete here.

  const file = await writePageThrough(engine, slug, {
    sourceId,
    logger: opts.logger,
    expectedPath: opts.expectedPath,
    expectedTargetSha256: opts.expectedTargetSha256,
  });
  const current = await loadCanonicalProjection(engine, sourceId, slug);
  let rawFileMatches = false;
  if (file.written === true && file.path) {
    try {
      const bytes = readFileSync(file.path);
      rawFileMatches = sha256Utf8(bytes) === committed.projection.sha256
        && bytes.length === committed.projection.sizeBytes;
    } catch { /* typed partial below */ }
  }
  const verified = file.written === true
    && file.path === opts.expectedPath
    && current != null
    && projectionIsFresh(current)
    && current.sha256 === committed.projection.sha256
    && current.content === committed.projection.content
    && rawFileMatches;
  if (!verified) {
    throw new CanonicalMutationPartialError(
      sourceId,
      slug,
      committed.value,
      file,
    );
  }
  return { ...committed, file };
}

export async function commitCanonicalRowMutation<T>(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  mutateDb: (tx: BrainEngine) => Promise<T>,
  opts: {
    logger?: WriteThroughLogger;
    expectedPath: string;
    expectedTargetSha256: string | null;
  },
): Promise<{
  value: T;
  projection: CanonicalPageProjection;
  file: WriteThroughResult;
}> {
  const committed = await engine.transaction(async (tx) => {
    const value = await mutateDb(tx);
    const projection = await persistCanonicalProjectionFromRow(
      tx,
      sourceId,
      slug,
    );
    return { value, projection };
  });

  const file = await writePageThrough(engine, slug, {
    sourceId,
    logger: opts.logger,
    expectedPath: opts.expectedPath,
    expectedTargetSha256: opts.expectedTargetSha256,
  });
  const current = await loadCanonicalProjection(engine, sourceId, slug);
  let rawFileMatches = false;
  if (file.written === true && file.path) {
    try {
      const bytes = readFileSync(file.path);
      rawFileMatches = sha256Utf8(bytes) === committed.projection.sha256
        && bytes.length === committed.projection.sizeBytes;
    } catch { /* typed partial below */ }
  }
  if (
    file.written !== true
    || file.path !== opts.expectedPath
    || current == null
    || !projectionIsFresh(current)
    || current.sha256 !== committed.projection.sha256
    || current.content !== committed.projection.content
    || !rawFileMatches
  ) {
    throw new CanonicalMutationPartialError(
      sourceId,
      slug,
      committed.value,
      file,
    );
  }
  return { ...committed, file };
}
