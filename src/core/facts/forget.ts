/**
 * v0.32.2 — forget-as-fence path (Codex R2-#3).
 *
 * Before v0.32.2 `gbrain forget` and the MCP `forget_fact` op called
 * `engine.expireFact(id)` directly, which UPDATEs `facts.expired_at`
 * in the DB. After `gbrain rebuild` (v0.32.3) that DB-only mutation
 * would evaporate because the canonical markdown fence is unchanged
 * — the forget would un-happen.
 *
 * The fix: forget becomes a fence rewrite. Strike through the target
 * row's `claim` cell, set its `valid_until` to today, append
 * `forgotten: <reason>` to its `context` cell. The DB's existing
 * `expired_at = valid_until + now()` rule reconstructs the forget
 * state on every rebuild because the fence is canonical.
 *
 * Strikethrough parse contract (extends commit 2's two-mode design):
 *   `~~claim~~` + `context: superseded by #N`    → supersededBy=N
 *   `~~claim~~` + `context: forgotten: <reason>` → forgotten=true
 *   `~~claim~~` + anything else                  → active=false; the
 *      mapper treats this as forgotten for DB-derivation purposes.
 *
 * Two-tier fallback for cross-state safety:
 *   1. If the target row has v51 columns (row_num + source_markdown_slug
 *      + sources.local_path), do the fence rewrite. The forget survives
 *      rebuild.
 *   2. If any of those is missing (pre-v51 legacy row, NULL entity_slug,
 *      no local_path on the source), fall through to the legacy
 *      `engine.expireFact(id)` direct-DB path. A once-per-process
 *      stderr warning names the case so operators see the degraded
 *      mode. These forgets DO NOT survive rebuild — the architecture
 *      doc names this as the explicit DB-only exception for legacy
 *      / thin-client state.
 */

import { readFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { withPutPageOperationLock } from '../ops/put-page-lock.ts';
import {
  isWriteThroughDisabled,
  resolvePageWriteTarget,
  verifyOrRepairPageFile,
} from '../write-through.ts';
import {
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  projectionIsFresh,
  sha256Utf8,
} from '../page-canonical.ts';
import { commitCanonicalMarkdownMutation } from '../canonical-mutation.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';

export interface ForgetFactResult {
  /** True iff the row was found AND a forget was applied (fence or DB). */
  ok: boolean;
  /** Discriminator on the path that handled the forget. */
  path: 'fence' | 'legacy_db' | 'not_found' | 'already_expired';
  /** Human-readable reason captured in `context`; mirrors back what was written. */
  reason: string;
}

interface FactDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  row_num: number | null;
  source_markdown_slug: string | null;
  expired_at: Date | null;
  visibility: string;
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

/** Format today's date as 'YYYY-MM-DD' UTC. Matches extract-from-fence's helper. */
function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString().slice(0, 10);
}

/**
 * Forget a fact by id. Routes through the fence when the row carries
 * v51 columns + the source has a local_path; falls through to legacy
 * `expireFact` otherwise. Idempotent: returns `already_expired` when
 * the row's `expired_at` is already non-null.
 *
 * Reason defaults to `'forgotten'` when the caller doesn't provide one
 * (matches the existing `gbrain forget` CLI which takes no reason
 * argument). MCP `forget_fact` op can pass a more specific reason
 * when the user provides it.
 */
export async function forgetFactInFence(
  engine: BrainEngine,
  factId: number,
  opts: {
    reason?: string;
    /**
     * MEMORY_VERBS v1 trust boundary [ship P1.1]: when set, the fact must
     * belong to this source or the call returns `not_found` (indistinguishable
     * from a truly-missing id — no cross-source existence leak). The `forget`
     * verb passes ctx.sourceId so a remote caller scoped to source A cannot
     * expire facts in source B by guessing global ids.
     */
    sourceId?: string;
    /**
     * When true (remote callers), the fact must be visibility='world' or the
     * call returns `not_found` — a remote caller can't expire private facts it
     * could never read (mirrors recall's remote posture).
     */
    worldOnly?: boolean;
  } = {},
): Promise<ForgetFactResult> {
  const reason = opts.reason ?? 'forgotten';

  const rows = await engine.executeRaw<FactDbRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, visibility
       FROM facts WHERE id = $1`,
    [factId],
  );
  // Trust-boundary scope check BEFORE any state inspection: a row outside the
  // caller's source (or private, for remote callers) is reported as not_found,
  // never distinguished from a missing id.
  if (rows.length === 1) {
    const r = rows[0];
    const outOfScope =
      (opts.sourceId !== undefined && r.source_id !== opts.sourceId) ||
      (opts.worldOnly === true && r.visibility !== 'world');
    if (outOfScope) {
      return { ok: false, path: 'not_found', reason };
    }
  }
  if (rows.length === 0) {
    return { ok: false, path: 'not_found', reason };
  }
  const row = rows[0];
  const wasAlreadyExpired = row.expired_at !== null;

  // Fence path requires v51 fence coordinates. entity_slug is not part of
  // the canonical fence coordinate.
  const canFence =
    row.row_num !== null &&
    row.source_markdown_slug !== null;

  const expireLegacy = async (): Promise<ForgetFactResult> => {
    if (wasAlreadyExpired) {
      return { ok: false, path: 'already_expired', reason };
    }
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / write_through disabled)
    return { ok, path: 'legacy_db', reason };
  };

  if (!canFence) {
    return expireLegacy();
  }

  const sources = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [row.source_id],
  );
  const localPath = sources[0]?.local_path ?? null;
  if (localPath == null) {
    return expireLegacy();
  }
  if (await isWriteThroughDisabled(engine)) {
    return expireLegacy();
  }

  const slug = row.source_markdown_slug!;
  const targetRowNum = row.row_num!;

  return withPutPageOperationLock(engine, row.source_id, slug, async () => {
    if (await isWriteThroughDisabled(engine)) {
      if (wasAlreadyExpired) {
        return { ok: false, path: 'already_expired', reason };
      }
      const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / write_through disabled)
      return { ok, path: 'legacy_db', reason };
    }
    const target = await resolvePageWriteTarget(engine, slug, row.source_id);
    if (!target.ok) {
      throw new Error(`FACT_FORGET_TARGET_UNAVAILABLE:${target.skipped}`);
    }
    let projection = await loadCanonicalProjection(engine, row.source_id, slug);
    if (!projection || !projectionIsFresh(projection)) {
      projection = await persistCanonicalProjectionFromRow(engine, row.source_id, slug);
    }
    const health = await verifyOrRepairPageFile(
      engine,
      slug,
      projection.semanticContentHash,
      { sourceId: row.source_id },
    );
    if (health.file_status !== 'healthy' && health.file_status !== 'repaired') {
      throw new Error(`FACT_FORGET_FILE_UNAVAILABLE:${health.error ?? health.skipped}`);
    }
    if (health.path !== target.filePath) throw new Error('FACT_FORGET_PATH_MOVED');
    const beforeBytes = readFileSync(target.filePath);
    const expectedTargetSha256 = sha256Utf8(beforeBytes);
    const body = beforeBytes.toString('utf8');
    const parsedFence = parseFactsFence(body);
    if (parsedFence.warnings.length > 0) {
      throw new Error(`FACT_FORGET_FENCE_MALFORMED:${parsedFence.warnings.join('|')}`);
    }
    const fenceRow = parsedFence.facts.find((fact) => fact.rowNum === targetRowNum);
    if (!fenceRow) throw new Error('FACT_FORGET_ROW_MISSING');
    if (wasAlreadyExpired) {
      // This is the post-commit retry path. verifyOrRepair above must first heal
      // store-new/file-old; only then may idempotence report already_expired.
      if (fenceRow.active) throw new Error('FACT_FORGET_EXPIRED_BUT_FENCE_ACTIVE');
      return { ok: false, path: 'already_expired', reason };
    }

    const today = todayUtc();
    const existingContext = fenceRow.context?.trim() ?? '';
    const newContext = existingContext
      ? `${existingContext} | forgotten: ${reason}`
      : `forgotten: ${reason}`;

    const updated: ParsedFact[] = parsedFence.facts.map(f =>
      f.rowNum === targetRowNum
        ? {
            ...f,
            active: false,
            validUntil: today,
            context: newContext,
            forgotten: true,
          }
        : f,
    );

    const newFence = renderFactsTable(updated);
    const begin = body.indexOf('<!--- gbrain:facts:begin -->');
    const end = body.indexOf('<!--- gbrain:facts:end -->', begin + 1);
    if (begin === -1 || end === -1) {
      throw new Error('FACT_FORGET_FENCE_MALFORMED:markers');
    }
    const newBody = body.slice(0, begin) + newFence + body.slice(end + '<!--- gbrain:facts:end -->'.length);
    const validate = parseFactsFence(newBody);
    if (validate.warnings.length > 0) {
      throw new Error(`FACT_FORGET_FENCE_MALFORMED:${validate.warnings.join('|')}`);
    }

    await commitCanonicalMarkdownMutation(
      engine,
      row.source_id,
      slug,
      newBody,
      async (tx) => {
        const changed = await tx.executeRaw<{ id: string }>(
          `UPDATE facts
              SET valid_until = $1, expired_at = now()
            WHERE id = $2 AND expired_at IS NULL
            RETURNING id`,
          [today, factId],
        );
        if (!Array.isArray(changed) || changed.length !== 1) {
          throw new Error('FACT_FORGET_CONFLICT');
        }
      },
      {
        expectedPath: target.filePath,
        expectedTargetSha256,
      },
    );
    return { ok: true, path: 'fence', reason };
  }, { timeoutMs: 5_000 });
}
