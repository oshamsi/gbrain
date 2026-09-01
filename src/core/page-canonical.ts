/**
 * Single canonical markdown projection for file-backed pages.
 *
 * This is the only function allowed to produce `pages.canonical_content`
 * or the bytes written to a canonical `.md` file. Callers must not pass
 * a clock, frontmatterOverrides, or sink-specific metadata.
 */

import { createHash } from 'node:crypto';
import type { Page, PageType } from './types.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';
import { contentHash } from './utils.ts';
import type { BrainEngine } from './engine.ts';

export const RESERVED_PROVENANCE_KEYS = ['source_kind', 'ingested_via', 'ingested_at'] as const;

export type ProvenanceTuple = {
  source_kind: string | null;
  ingested_via: string | null;
  ingested_at: Date | null;
};

export type ProvenanceCandidate = {
  source_kind?: string | null;
  ingested_via?: string | null;
};

export type ProvenanceLegacyAdoption = 'existing-frontmatter' | 'source-file' | false;

function validProvenanceString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function validProvenanceTimestamp(value: unknown): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Set-once provenance: a non-NULL stored column wins. Ordinary put_page never
 * falls back to the incoming request's reserved frontmatter. Sync may adopt a
 * reviewed source-file stamp. Convergence may adopt a pre-snapshot stored/file
 * stamp but must not invent ingested_at.
 */
export function resolveSetOnceProvenance(
  existing: {
    source_kind?: string | null;
    ingested_via?: string | null;
    ingested_at?: Date | string | null;
    frontmatter?: Record<string, unknown> | null;
  } | null,
  candidate: ProvenanceCandidate,
  now: Date,
  opts: {
    legacyAdoption?: ProvenanceLegacyAdoption;
    sourceFrontmatter?: Record<string, unknown> | null;
    inventTimestamp?: boolean;
  } = {},
): ProvenanceTuple {
  const legacyFm = opts.legacyAdoption === 'existing-frontmatter'
    ? (existing?.frontmatter ?? null)
    : opts.legacyAdoption === 'source-file'
      ? (opts.sourceFrontmatter ?? null)
      : null;
  const source_kind = validProvenanceString(existing?.source_kind)
    ?? (legacyFm ? validProvenanceString(legacyFm.source_kind) : null)
    ?? validProvenanceString(candidate.source_kind);
  const ingested_via = validProvenanceString(existing?.ingested_via)
    ?? (legacyFm ? validProvenanceString(legacyFm.ingested_via) : null)
    ?? validProvenanceString(candidate.ingested_via);
  const ingested_at = validProvenanceTimestamp(existing?.ingested_at)
    ?? (legacyFm ? validProvenanceTimestamp(legacyFm.ingested_at) : null)
    ?? ((opts.inventTimestamp !== false && (source_kind || ingested_via)) ? now : null);
  return { source_kind, ingested_via, ingested_at };
}

export function stripReservedProvenanceKeys(frontmatter: Record<string, unknown> | null | undefined): void {
  if (!frontmatter) return;
  for (const key of RESERVED_PROVENANCE_KEYS) delete frontmatter[key];
}

export function materializeProvenanceFrontmatter(
  frontmatter: Record<string, unknown>,
  tuple: ProvenanceTuple,
): void {
  stripReservedProvenanceKeys(frontmatter);
  if (tuple.source_kind) frontmatter.source_kind = tuple.source_kind;
  if (tuple.ingested_via) frontmatter.ingested_via = tuple.ingested_via;
  if (tuple.ingested_at) frontmatter.ingested_at = tuple.ingested_at.toISOString();
}

export function provenanceTuplesEqual(
  a: ProvenanceTuple | null | undefined,
  b: { source_kind?: string | null; ingested_via?: string | null; ingested_at?: Date | string | null } | null | undefined,
): boolean {
  if (!a || !b) return false;
  if ((a.source_kind ?? null) !== (b.source_kind ?? null)) return false;
  if ((a.ingested_via ?? null) !== (b.ingested_via ?? null)) return false;
  const aAt = a.ingested_at ? a.ingested_at.toISOString() : null;
  const bAt = b.ingested_at == null || b.ingested_at === ''
    ? null
    : (b.ingested_at instanceof Date ? b.ingested_at : new Date(String(b.ingested_at))).toISOString();
  return aAt === bAt;
}

export type CanonicalPageProjection = {
  content: string;
  sha256: string;
  sizeBytes: number;
  semanticContentHash: string;
};

export type CanonicalProjectionRow = CanonicalPageProjection & {
  inputGeneration: string | number | null;
  basisGeneration: string | number | null;
};

export class CanonicalProjectionConflictError extends Error {
  constructor(sourceId: string, slug: string) {
    super(`persistCanonicalProjectionFromRow: snapshot fence missed for ${sourceId}/${slug}`);
    this.name = 'CanonicalProjectionConflictError';
  }
}

export function generationKey(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

export function projectionIsFresh(
  row: { inputGeneration: string | number | null; basisGeneration: string | number | null } | null,
): boolean {
  if (!row) return false;
  const input = generationKey(row.inputGeneration);
  const basis = generationKey(row.basisGeneration);
  return input != null && basis != null && input === basis;
}

function utcIso(value: Date | string | null | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}


export function canonicalizeEffectiveTags(
  ...groups: ReadonlyArray<readonly string[]>
): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    for (const tag of group) out.add(String(tag));
  }
  return [...out].sort();
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

  const tags = canonicalizeEffectiveTags(effectiveTags);
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
      tags: canonicalizeEffectiveTags(tags),
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
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || row.canonical_content == null || row.canonical_sha256 == null || row.canonical_size_bytes == null) {
    return null;
  }
  return {
    content: row.canonical_content,
    sha256: row.canonical_sha256,
    sizeBytes: Number(row.canonical_size_bytes),
    semanticContentHash: row.content_hash ?? '',
    inputGeneration: row.canonical_input_generation ?? null,
    basisGeneration: row.canonical_basis_generation ?? null,
  };
}

export async function persistCanonicalProjectionFromRow(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<CanonicalPageProjection & { inputGeneration: string | number | null; basisGeneration: string | number | null }> {
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
    canonical_input_generation: string | number | null;
    content_hash: string | null;
    updated_at: Date | string | null;
  }>(
    `SELECT type, title, compiled_truth, timeline, frontmatter,
            source_kind, ingested_via, ingested_at,
            canonical_input_generation, content_hash, updated_at
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, slug],
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) {
    if (typeof engine.getPage !== 'function') {
      throw new Error(`persistCanonicalProjectionFromRow: page ${sourceId}/${slug} not found`);
    }
    const page = await engine.getPage(slug, { sourceId });
    if (!page) {
      throw new Error(`persistCanonicalProjectionFromRow: page ${sourceId}/${slug} not found`);
    }
    const tags = await engine.getTags(slug, { sourceId });
    const projection = buildCanonicalPageProjection(page, tags);
    const written = await engine.executeRaw<{
      canonical_input_generation: string | number | null;
      canonical_basis_generation: string | number | null;
    }>(
      `UPDATE pages SET
         canonical_content = $1,
         canonical_sha256 = $2,
         canonical_size_bytes = $3,
         content_hash = $4,
         canonical_basis_generation = canonical_input_generation
       WHERE source_id = $5 AND slug = $6 AND deleted_at IS NULL
       RETURNING canonical_input_generation, canonical_basis_generation`,
      [
        projection.content,
        projection.sha256,
        projection.sizeBytes,
        projection.semanticContentHash,
        sourceId,
        slug,
      ],
    );
    if (!Array.isArray(written)) {
      return { ...projection, inputGeneration: null, basisGeneration: null };
    }
    if (written.length === 0) {
      throw new CanonicalProjectionConflictError(sourceId, slug);
    }
    return {
      ...projection,
      inputGeneration: written[0].canonical_input_generation ?? null,
      basisGeneration: written[0].canonical_basis_generation ?? null,
    };
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
  const updatedAt = row.updated_at instanceof Date
    ? row.updated_at.toISOString()
    : (row.updated_at ?? null);
  const written = await engine.executeRaw<{
    canonical_input_generation: string | number | null;
    canonical_basis_generation: string | number | null;
  }>(
    `UPDATE pages SET
       canonical_content = $1,
       canonical_sha256 = $2,
       canonical_size_bytes = $3,
       content_hash = $4,
       canonical_basis_generation = canonical_input_generation
     WHERE source_id = $5 AND slug = $6 AND deleted_at IS NULL
       AND canonical_input_generation IS NOT DISTINCT FROM $7::bigint
       AND content_hash IS NOT DISTINCT FROM $8
       AND updated_at IS NOT DISTINCT FROM $9::timestamptz
     RETURNING canonical_input_generation, canonical_basis_generation`,
    [
      projection.content,
      projection.sha256,
      projection.sizeBytes,
      projection.semanticContentHash,
      sourceId,
      slug,
      row.canonical_input_generation,
      row.content_hash,
      updatedAt,
    ],
  );
  if (!Array.isArray(written)) {
    return { ...projection, inputGeneration: row.canonical_input_generation ?? null, basisGeneration: row.canonical_input_generation ?? null };
  }
  if (written.length === 0) {
    throw new CanonicalProjectionConflictError(sourceId, slug);
  }
  return {
    ...projection,
    inputGeneration: written[0].canonical_input_generation ?? null,
    basisGeneration: written[0].canonical_basis_generation ?? null,
  };
}

/** Update structured body/timeline from markdown, then persist a fenced projection. */
export async function applyCanonicalMarkdownToStore(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  markdown: string,
): Promise<CanonicalPageProjection> {
  const parsed = parseMarkdown(markdown, `${slug}.md`);
  await engine.executeRaw(
    `UPDATE pages SET compiled_truth = $1, timeline = $2, updated_at = now()
      WHERE source_id = $3 AND slug = $4 AND deleted_at IS NULL`,
    [parsed.compiled_truth, parsed.timeline || '', sourceId, slug],
  );
  return persistCanonicalProjectionFromRow(engine, sourceId, slug);
}
