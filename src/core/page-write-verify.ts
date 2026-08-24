import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';

export interface PageWriteVerification {
  outcome: 'current' | 'superseded';
  page: Page;
}

/**
 * Prove a committed page is readable. For an atomic CAS write, a different
 * non-null hash can only be a later successful writer; report supersession so
 * the caller can discard its stale parsed-content hooks. A missing row (or a
 * hashless row) remains a loud index-integrity failure.
 */
export async function verifyPageReadable(
  engine: BrainEngine,
  slug: string,
  expectedHash: string,
  sourceId: string | undefined,
  caller: string,
  opts: { allowSuperseded?: boolean; committedPage?: Pick<Page, 'id' | 'updated_at'> } = {},
): Promise<PageWriteVerification> {
  const resolvedSource = sourceId ?? 'default';
  const readBack = await engine.getPage(slug, { sourceId: resolvedSource });
  if (!readBack) {
    const detail = `page '${slug}' not found after write (source: ${resolvedSource}). Silent desync — DB index did not pick up the write.`;
    await logFailure(engine, slug, sourceId, caller, detail);
    throw new Error(
      `[${caller}] post-write read-back failed: ${detail} The page was written but the DB index ` +
      `did not pick it up. This indicates a silent desync — the operation must fail loudly.`,
    );
  }
  if (opts.committedPage && readBack.id !== opts.committedPage.id) {
    const detail = `page '${slug}' resolved to the wrong page row after write (expected id ${opts.committedPage.id}, got ${readBack.id}; source: ${resolvedSource}). Silent desync — DB index returned a different identity.`;
    await logFailure(engine, slug, sourceId, caller, detail);
    throw new Error(`[${caller}] post-write read-back failed: ${detail}`);
  }
  if (readBack.content_hash !== expectedHash) {
    const committedAt = opts.committedPage?.updated_at.getTime();
    const readAt = readBack.updated_at.getTime();
    // Postgres timestamps have finer precision than JavaScript Date. Two
    // successful commits can therefore round to the same millisecond after
    // hydration. Once row identity is proven, an equal timestamp plus a
    // different non-null hash is still a legitimate successor, not stale
    // index data.
    if (opts.allowSuperseded && readBack.content_hash && committedAt !== undefined && readAt >= committedAt) {
      return { outcome: 'superseded', page: readBack };
    }
    const detail = `page '${slug}' has stale content_hash (expected ${expectedHash.slice(0, 12)}, got ${(readBack.content_hash ?? '').slice(0, 12)}; source: ${resolvedSource}). Silent desync — DB index has a stale row.`;
    await logFailure(engine, slug, sourceId, caller, detail);
    throw new Error(
      `[${caller}] post-write read-back failed: ${detail} The page was written but the DB index ` +
      `has a stale row. This indicates a silent desync — the operation must fail loudly.`,
    );
  }
  return { outcome: 'current', page: readBack };
}

async function logFailure(
  engine: BrainEngine,
  slug: string,
  sourceId: string | undefined,
  caller: string,
  detail: string,
): Promise<void> {
  try {
    await engine.logIngest({
      source_type: 'write-verify-guard',
      source_ref: slug,
      pages_updated: [],
      summary: `[${caller}] post-write read-back failed: ${detail}`,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  } catch {
    // Best-effort: never mask the integrity failure when its audit write fails.
  }
}
