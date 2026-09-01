/**
 * Single canonical markdown projection for file-backed pages.
 *
 * This is the only function allowed to produce `pages.canonical_content`
 * or the bytes written to a canonical `.md` file. Callers must not pass
 * a clock, frontmatterOverrides, or sink-specific metadata.
 */

import { createHash } from 'node:crypto';
import type { Page, PageType } from './types.ts';
import { serializeMarkdown } from './markdown.ts';
import { contentHash } from './utils.ts';
import type { BrainEngine } from './engine.ts';

export const RESERVED_PROVENANCE_KEYS = ['source_kind', 'ingested_via', 'ingested_at'] as const;

export type CanonicalPageProjection = {
  content: string;
  sha256: string;
  sizeBytes: number;
  semanticContentHash: string;
};

export type CanonicalProjectionRow = CanonicalPageProjection & {
  inputGeneration: number | null;
  basisGeneration: number | null;
};

function utcIso(value: Date | string | null | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function sortedUniqueTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => String(tag)))].sort();
}

/**
 * Deterministic canonical markdown for one structured page + effective tags.
 *
 * Frontmatter key order: type, title, remaining non-reserved keys in their
 * existing relative order, then source_kind / ingested_via / ingested_at
 * (omit absent), then tags when non-empty. Body contract matches
 * serializeMarkdown: compiled_truth, optional timeline sentinel, trailing LF.
 */
export function buildCanonicalPageProjection(
  page: Pick<
    Page,
    'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter' | 'source_kind' | 'ingested_via' | 'ingested_at'
  >,
  effectiveTags: readonly string[],
): CanonicalPageProjection {
  const rest: Record<string, unknown> = { ...(page.frontmatter ?? {}) };
  delete rest.type;
  delete rest.title;
  delete rest.tags;
  delete rest.slug;
  for (const key of RESERVED_PROVENANCE_KEYS) delete rest[key];

  const frontmatter: Record<string, unknown> = { ...rest };
  if (page.source_kind) frontmatter.source_kind = page.source_kind;
  if (page.ingested_via) frontmatter.ingested_via = page.ingested_via;
  const ingestedAt = utcIso(page.ingested_at ?? undefined);
  if (ingestedAt) frontmatter.ingested_at = ingestedAt;

  const tags = sortedUniqueTags(effectiveTags);
  const content = serializeMarkdown(
    frontmatter,
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as PageType) ?? 'note',
      title: page.title ?? '',
      tags,
    },
  );
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const semanticContentHash = contentHash({
    title: page.title,
    type: page.type,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: {
      ...rest,
      ...(page.source_kind ? { source_kind: page.source_kind } : {}),
      ...(page.ingested_via ? { ingested_via: page.ingested_via } : {}),
    },
    tags,
  });
  return { content, sha256, sizeBytes, semanticContentHash };
}

/** Response-only redacted markdown. Never stored or assigned canonical_sha256. */
export function serializeRedactedPageForRead(
  page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>,
  tags: readonly string[],
): string {
  return serializeMarkdown(
    { ...(page.frontmatter ?? {}) },
    page.compiled_truth ?? '',
    page.timeline ?? '',
    {
      type: (page.type as PageType) ?? 'note',
      title: page.title ?? '',
      tags: sortedUniqueTags(tags),
    },
  );
}

export function sha256Utf8(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function loadCanonicalProjection(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<CanonicalProjectionRow | null> {
  const rows = await engine.executeRaw<{
    canonical_content: string | null;
    canonical_sha256: string | null;
    canonical_size_bytes: string | number | null;
    canonical_input_generation: string | number | null;
    canonical_basis_generation: string | number | null;
    content_hash: string | null;
  }>(
    `SELECT canonical_content, canonical_sha256, canonical_size_bytes,
            canonical_input_generation, canonical_basis_generation, content_hash
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, slug],
  );
  const row = rows[0];
  if (!row || row.canonical_content == null || row.canonical_sha256 == null || row.canonical_size_bytes == null) {
    return null;
  }
  return {
    content: row.canonical_content,
    sha256: row.canonical_sha256,
    sizeBytes: Number(row.canonical_size_bytes),
    semanticContentHash: row.content_hash ?? '',
    inputGeneration: row.canonical_input_generation == null ? null : Number(row.canonical_input_generation),
    basisGeneration: row.canonical_basis_generation == null ? null : Number(row.canonical_basis_generation),
  };
}

export async function persistCanonicalProjectionFromRow(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<CanonicalPageProjection> {
  // Load structured fields via executeRaw so this stays on the same
  // transaction connection and does not consume/engine-mock getPage.
  const rows = await engine.executeRaw<{
    type: string;
    title: string;
    compiled_truth: string;
    timeline: string | null;
    frontmatter: Record<string, unknown> | string | null;
    source_kind: string | null;
    ingested_via: string | null;
    ingested_at: Date | string | null;
  }>(
    `SELECT type, title, compiled_truth, timeline, frontmatter,
            source_kind, ingested_via, ingested_at
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, slug],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`persistCanonicalProjectionFromRow: page ${sourceId}/${slug} not found`);
  }
  const frontmatter = typeof row.frontmatter === 'string'
    ? JSON.parse(row.frontmatter) as Record<string, unknown>
    : (row.frontmatter ?? {});
  const tags = await engine.getTags(slug, { sourceId });
  const projection = buildCanonicalPageProjection(
    {
      type: row.type,
      title: row.title,
      compiled_truth: row.compiled_truth,
      timeline: row.timeline ?? '',
      frontmatter,
      source_kind: row.source_kind,
      ingested_via: row.ingested_via,
      ingested_at: row.ingested_at == null ? null : new Date(row.ingested_at),
    },
    tags,
  );
  await engine.executeRaw(
    `UPDATE pages SET
       canonical_content = $1,
       canonical_sha256 = $2,
       canonical_size_bytes = $3,
       canonical_basis_generation = canonical_input_generation
     WHERE source_id = $4 AND slug = $5 AND deleted_at IS NULL`,
    [projection.content, projection.sha256, projection.sizeBytes, sourceId, slug],
  );
  return projection;
}
