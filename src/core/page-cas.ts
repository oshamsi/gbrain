export type PageProvenanceFence = {
  source_kind: string | null;
  ingested_via: string | null;
  ingested_at: Date | string | null;
};

type PutPageBaseOptions = {
  sourceId?: string;
  allowEmptyOverwrite?: boolean;
};

export type PutPageOptions = PutPageBaseOptions & (
  | { expectedContentHash?: undefined; expectedProvenance?: never }
  | { expectedContentHash: string; expectedProvenance: PageProvenanceFence }
);

/** Stable engine-layer signal for an optimistic page-write conflict. */
export class PageWriteConflictError extends Error {
  constructor(
    public readonly slug: string,
    public readonly sourceId: string,
    public readonly expectedContentHash: string,
  ) {
    super(
      `putPage: page '${sourceId}/${slug}' changed or disappeared after it was read ` +
      `(expected content_hash ${expectedContentHash.slice(0, 12)}...)`,
    );
    this.name = 'PageWriteConflictError';
  }
}

/** Fail fast before expensive import work; the engine still repeats this atomically. */
export function assertExpectedPageHash(
  page: { content_hash?: string | null } | null,
  slug: string,
  sourceId: string,
  expectedContentHash?: string,
): void {
  if (expectedContentHash !== undefined && (!page || page.content_hash !== expectedContentHash)) {
    throw new PageWriteConflictError(slug, sourceId, expectedContentHash);
  }
}

/**
 * Engine-parity SQL for an optimistic page-row compare-and-swap.
 *
 * Positional parameters are deliberately identical for PGLite and Postgres;
 * both engines bind this through `executeRaw` on their current connection,
 * including a transaction-scoped clone. UPDATE-only semantics make a stale
 * or vanished row observable as zero RETURNING rows.
 */
export const PAGE_CAS_UPDATE_SQL = `
  UPDATE pages SET
    type = $1, page_kind = $2, title = $3,
    compiled_truth = $4, timeline = $5, frontmatter = $6::jsonb,
    content_hash = $7, updated_at = now(), deleted_at = NULL,
    effective_date = COALESCE($8::timestamptz, pages.effective_date),
    effective_date_source = COALESCE($9, pages.effective_date_source),
    import_filename = COALESCE($10, pages.import_filename),
    chunker_version = COALESCE($11, pages.chunker_version),
    source_path = COALESCE($12, pages.source_path),
    source_kind = COALESCE(pages.source_kind, $13),
    source_uri = COALESCE($14, pages.source_uri),
    ingested_via = COALESCE(pages.ingested_via, $15),
    ingested_at = COALESCE(pages.ingested_at, $16::timestamptz)
  WHERE source_id = $17
    AND slug = $18
    AND content_hash = $19
    AND deleted_at IS NULL
    AND pages.source_kind IS NOT DISTINCT FROM $20
    AND pages.ingested_via IS NOT DISTINCT FROM $21
    AND pages.ingested_at IS NOT DISTINCT FROM $22::timestamptz
  RETURNING id, source_id, slug, type, title, compiled_truth, timeline,
    frontmatter, content_hash, created_at, updated_at, effective_date,
    effective_date_source, import_filename, source_kind, source_uri,
    ingested_via, ingested_at`;

export async function lockExpectedPageSnapshot(
  engine: {
    executeRaw<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]>;
  },
  slug: string,
  sourceId: string,
  expectedContentHash: string,
  expectedProvenance: PageProvenanceFence,
): Promise<void> {
  const at = expectedProvenance.ingested_at;
  const rows = await engine.executeRaw<{ id: number | string }>(
    `SELECT id
       FROM pages
      WHERE source_id = $1
        AND slug = $2
        AND content_hash = $3
        AND deleted_at IS NULL
        AND source_kind IS NOT DISTINCT FROM $4
        AND ingested_via IS NOT DISTINCT FROM $5
        AND ingested_at IS NOT DISTINCT FROM $6::timestamptz
      FOR UPDATE`,
    [
      sourceId,
      slug,
      expectedContentHash,
      expectedProvenance.source_kind,
      expectedProvenance.ingested_via,
      at == null || at === ''
        ? null
        : (at instanceof Date ? at.toISOString() : String(at)),
    ],
  );
  if (rows.length !== 1) {
    throw new PageWriteConflictError(slug, sourceId, expectedContentHash);
  }
}

export function requireResolvedIngestedAt(page: {
  source_kind?: string | null;
  source_uri?: string | null;
  ingested_via?: string | null;
  ingested_at?: Date | string | null;
}): Date | null {
  // Preserve 68d75a4 behavior: URI-only provenance also owns an ingest clock,
  // even though source_uri is not serialized into canonical frontmatter.
  const hasCanonicalProvenance = Boolean(
    page.source_kind || page.source_uri || page.ingested_via,
  );
  if (hasCanonicalProvenance && page.ingested_at == null) {
    throw new TypeError('putPage: provenance requires caller-resolved ingested_at');
  }
  if (page.ingested_at == null) return null;
  const value = page.ingested_at instanceof Date
    ? page.ingested_at
    : new Date(page.ingested_at);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('putPage: invalid ingested_at');
  }
  return value;
}
