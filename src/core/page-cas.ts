/** Options for the page-row write primitive. */
export interface PutPageOptions {
  sourceId?: string;
  allowEmptyOverwrite?: boolean;
  /** Existing-row optimistic-concurrency precondition. */
  expectedContentHash?: string;
  /** Snapshotted set-once provenance; CAS refuses if the live tuple moved. */
  expectedProvenance?: {
    source_kind: string | null;
    ingested_via: string | null;
    ingested_at: Date | string | null;
  };
}

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
  WHERE source_id = $17 AND slug = $18 AND content_hash = $19
    AND deleted_at IS NULL
    AND (
      $20::boolean IS NOT TRUE
      OR (
        pages.source_kind IS NOT DISTINCT FROM $21
        AND pages.ingested_via IS NOT DISTINCT FROM $22
        AND pages.ingested_at IS NOT DISTINCT FROM $23::timestamptz
      )
    )
  RETURNING id, source_id, slug, type, title, compiled_truth, timeline,
    frontmatter, content_hash, created_at, updated_at, effective_date,
    effective_date_source, import_filename, source_kind, source_uri,
    ingested_via, ingested_at`;

/**
 * Atomic compare-only fence for identical-content CAS.
 *
 * Confirms the live row still carries `expectedContentHash` without writing
 * page fields or bumping `updated_at`. Zero RETURNING rows means the row
 * moved, vanished, or was tombstoned — callers must fall through to the
 * normal CAS write, which then conflicts.
 */
// TODO: SET slug = slug is a real UPDATE and advances the statement-level
// page-generation/cache clock even though it does not bump updated_at.
// Prefer a compare-only SELECT ... FOR UPDATE if that cache churn matters.
export const PAGE_CAS_COMPARE_SQL = `
  UPDATE pages
     SET slug = slug
   WHERE source_id = $1 AND slug = $2 AND content_hash = $3
     AND deleted_at IS NULL
     AND (
       $4::boolean IS NOT TRUE
       OR (
         pages.source_kind IS NOT DISTINCT FROM $5
         AND pages.ingested_via IS NOT DISTINCT FROM $6
         AND pages.ingested_at IS NOT DISTINCT FROM $7::timestamptz
       )
     )
  RETURNING id`;

export async function pageHashStillMatches(
  engine: { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> },
  slug: string,
  sourceId: string,
  expectedContentHash: string,
  expectedProvenance?: {
    source_kind: string | null;
    ingested_via: string | null;
    ingested_at: Date | string | null;
  } | null,
): Promise<boolean> {
  const fence = expectedProvenance != null;
  const at = expectedProvenance?.ingested_at;
  const atIso = at == null || at === ''
    ? null
    : (at instanceof Date ? at.toISOString() : String(at));
  const rows = await engine.executeRaw(PAGE_CAS_COMPARE_SQL, [
    sourceId,
    slug,
    expectedContentHash,
    fence,
    expectedProvenance?.source_kind ?? null,
    expectedProvenance?.ingested_via ?? null,
    atIso,
  ]);
  return rows.length > 0;
}
