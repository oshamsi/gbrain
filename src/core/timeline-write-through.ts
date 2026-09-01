/**
 * #1856 — write-through for manual timeline entries.
 *
 * `add_timeline_entry` historically wrote ONLY the `timeline_entries` table.
 * On an FS/git-canonical brain (markdown on disk is the committable source of
 * truth) that stranded every manual entry: invisible to git, absent from
 * `gbrain get <slug>`, and silently lost on any FS→DB rebuild because no
 * bullet in the canonical markdown could reconstruct it.
 *
 * This module routes manual timeline writes through the SAME target seam
 * pages and facts use (`resolvePageWriteTarget`, the #4204 precedent): when
 * the brain resolves a disk target for the page, the entry is
 *   1. rendered as a canonical `- **date** | source — summary` bullet,
 *   2. spliced date-ordered into the ON-DISK file via a locked
 *      read-modify-write (mirrors fence-write.ts: `withPageLock` + read the
 *      current file + splice the bullet into the timeline section + atomic
 *      tmp+rename). NEVER whole-file regeneration from the DB row — the disk
 *      file is the merge point for file-only edits (facts fences, hand
 *      edits) that the pages row doesn't know about, and regenerating from
 *      the row silently reverted them (fence loss then cascaded to
 *      fact-row reconcile deletions),
 *   3. spliced date-ordered into the page row's `timeline` text, and
 *   4. inserted into `timeline_entries` with the tuple the FS extractor
 *      (`extractTimelineFromContent`) recovers from that exact bullet.
 *
 * Step 4 is the dedup-critical part the issue called out: the table's
 * uniqueness is `(page_id, date, summary, source)`, and sync re-extracts the
 * bullet on every pass — if the stored tuple differed from the re-extracted
 * one, every sync would insert a duplicate. We derive the stored tuple BY
 * RUNNING the extractor over the rendered block, so convergence holds by
 * construction. When derivation can't produce exactly one entry (pathological
 * source strings), we return `handled: false` and the caller falls back to
 * the legacy DB-only insert — an entry is never dropped. Same when the
 * on-disk file is missing or unreadable: we fall back to the DB-only path
 * rather than fabricating a file from the DB row.
 *
 * DB-only brains (no repo target, or `sync.write_through` off) always take
 * the `handled: false` path, so their behavior is byte-identical to before.
 *
 * Reconcile note: the pages row's `content_hash` is deliberately NOT updated
 * here — the on-disk file now hashes differently from the stored hash, so the
 * next `gbrain sync` re-imports the page (refreshing chunks + re-extracting
 * the timeline, which conflicts-no-ops against the row written here). Same
 * eventual-consistency contract as the facts fence lane.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { BrainEngine } from './engine.ts';
import {
  isWriteThroughDisabled,
  resolvePageWriteTarget,
  verifyOrRepairPageFile,
  type WriteThroughLogger,
  type WriteThroughResult,
} from './write-through.ts';
import {
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  projectionIsFresh,
  sha256Utf8,
} from './page-canonical.ts';
import { withPutPageOperationLock } from './ops/put-page-lock.ts';
import {
  CanonicalMutationPartialError,
  commitCanonicalMarkdownMutation,
} from './canonical-mutation.ts';
import { findTimelineSplitIndex } from './markdown.ts';
import { extractTimelineFromContent } from './timeline-extract.ts';

/** Raw op params for one manual timeline entry (date pre-validated by caller). */
export interface TimelineEntryWriteInput {
  /** Strict YYYY-MM-DD (the op validates before calling). */
  date: string;
  summary: string;
  source?: string;
  detail?: string;
}

/** Canonical tuple actually stored (matches FS re-extraction of the bullet). */
export interface CanonicalTimelineTuple {
  date: string;
  source: string;
  summary: string;
}

export type TimelineWriteThroughOutcome =
  | { kind: 'written'; handled: true; file: WriteThroughResult; entry: CanonicalTimelineTuple }
  | { kind: 'db_only'; handled: false; skipped: 'disabled_by_config' | 'no_repo_configured' | 'source_repo_belongs_to_other_source' }
  | { kind: 'duplicate'; handled: false }
  | { kind: 'partial'; handled: false; file?: WriteThroughResult; error: string };

class DuplicateTimelineEntryError extends Error {
  constructor() { super('duplicate timeline entry'); }
}

/**
 * Default source label for manual entries with no provenance ref. A bullet
 * MUST carry a source segment: the FS extractor assigns `'markdown'` to
 * delimiter-less bullets and splits summary-first bullets on interior dashes
 * (#1856 Bug 1's fragmentation class), so rendering `| <summary>` alone can
 * never round-trip to `source: ''`. `'manual'` is honest provenance for a
 * hand-added entry and contains no delimiter the extractor could mis-split.
 */
const DEFAULT_MANUAL_SOURCE = 'manual';

/** Collapse a free-text field onto one line (the bullet is line-anchored). */
function inlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Rendered markdown block + the tuple the FS extractor recovers from it. */
export interface RenderedTimelineEntry {
  /** Bullet line plus indented detail lines (when representable). */
  block: string;
  canonical: CanonicalTimelineTuple;
}

/**
 * Render one entry as a canonical source-first bullet and derive the tuple
 * the FS extractor will recover from it. Returns null when the rendered
 * block does not round-trip to exactly one entry with the requested date —
 * the caller then keeps the entry DB-only rather than writing a bullet that
 * would fragment or duplicate on the next sync.
 */
export function renderTimelineEntry(
  entry: TimelineEntryWriteInput,
  slug: string,
): RenderedTimelineEntry | null {
  const summary = inlineText(entry.summary ?? '');
  if (!summary) return null;
  const source = inlineText(entry.source ?? '') || DEFAULT_MANUAL_SOURCE;
  const line = `- **${entry.date}** | ${source} — ${summary}`;
  // Detail rides along as indented continuation lines so the canonical file
  // keeps the full content (the FS extractor ignores continuation lines; the
  // DB-path parser reads them back as detail).
  const detailLines = (entry.detail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `  ${l}`);

  const derive = (block: string): CanonicalTimelineTuple | null => {
    const entries = extractTimelineFromContent(block, slug);
    if (entries.length !== 1) return null;
    if (entries[0].date !== entry.date) return null;
    return { date: entries[0].date, source: entries[0].source ?? '', summary: entries[0].summary };
  };

  let block = [line, ...detailLines].join('\n');
  let canonical = derive(block);
  if (!canonical && detailLines.length > 0) {
    // A detail line can carry its own `[Source: …, date]` citation that the
    // extractor's Format 3 would file as a second entry. Keep detail out of
    // the file in that case (it stays in the DB row) rather than planting a
    // block that re-extracts to more than one entry.
    block = line;
    canonical = derive(block);
  }
  if (!canonical) return null;
  return { block, canonical };
}

/** Line-anchored Format-1 bullet detector (date capture only). */
const BULLET_DATE_RE = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|/;

/**
 * Splice a rendered entry block into a page's `timeline` text, date-ordered
 * among the existing Format-1 bullets. Preserves the list's existing sort
 * direction (ascending unless the first bullet's date is greater than the
 * last's). Insertion lands immediately BEFORE the first bullet that should
 * follow the new entry, so a neighbor's indented detail lines are never
 * split; when no bullet follows, the block is appended at the end.
 */
export function spliceTimelineBlock(timelineText: string, date: string, block: string): string {
  const text = (timelineText ?? '').trimEnd();
  if (!text.trim()) {
    return `## Timeline\n\n${block}`;
  }
  const lines = text.split('\n');
  const bullets: Array<{ index: number; date: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BULLET_DATE_RE.exec(lines[i]);
    if (m) bullets.push({ index: i, date: m[1] });
  }
  if (bullets.length === 0) {
    return `${text}\n\n${block}`;
  }
  const descending = bullets.length >= 2 && bullets[0].date > bullets[bullets.length - 1].date;
  let insertBefore = -1;
  for (const b of bullets) {
    if (descending ? b.date < date : b.date > date) {
      insertBefore = b.index;
      break;
    }
  }
  if (insertBefore === -1) {
    return `${text}\n${block}`;
  }
  return [...lines.slice(0, insertBefore), ...block.split('\n'), ...lines.slice(insertBefore)].join('\n');
}

/** True for an indented continuation line (a bullet's detail lines). */
const CONTINUATION_RE = /^\s{2,}\S/;

/**
 * Splice a rendered entry block into RAW on-disk markdown text (frontmatter +
 * body + optional timeline sentinel). Every existing byte outside the
 * insertion point is preserved — this function never regenerates the file
 * from the DB row, so file-only content (facts fences, hand edits) survives.
 *
 * Placement mirrors `spliceTimelineBlock`'s date-ordering, but is
 * BULLET-BOUNDED: when no bullet should follow the new entry, it lands right
 * after the last bullet (plus its continuation lines), NOT at the end of the
 * region — the region can carry later sections (e.g. a `## Facts` fence,
 * which upsertFactRow appends at EOF) that a naive tail-append would corrupt.
 */
export function spliceTimelineIntoFileText(fileText: string, date: string, block: string): string {
  const lines = fileText.split('\n');
  // Skip YAML frontmatter so its `---` delimiters can't be mistaken for the
  // bare-`---` timeline sentinel (findTimelineSplitIndex rule 3 expects body
  // lines, matching splitBody's own call shape).
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }
  const rel = findTimelineSplitIndex(lines.slice(bodyStart));
  const blockLines = block.split('\n');

  if (rel === -1) {
    // No timeline sentinel on disk yet — append a fresh section at EOF.
    const base = fileText.replace(/\s+$/, '');
    return `${base}\n\n<!-- timeline -->\n\n## Timeline\n\n${block}\n`;
  }

  const sentinel = bodyStart + rel;
  const bullets: Array<{ index: number; date: string }> = [];
  for (let i = sentinel + 1; i < lines.length; i++) {
    const m = BULLET_DATE_RE.exec(lines[i]);
    if (m) bullets.push({ index: i, date: m[1] });
  }

  let insertAt: number;
  if (bullets.length === 0) {
    // Empty timeline section (possibly followed by other sections): insert
    // right below the `## Timeline`/`## History` heading when one exists in
    // the region, else right below the sentinel line itself.
    let anchor = sentinel;
    for (let i = sentinel + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^##\s+(timeline|history)\b/i.test(trimmed)) {
        anchor = i;
        break;
      }
      if (/^#{1,6}\s/.test(trimmed)) break; // some OTHER section began
    }
    insertAt = anchor + 1;
  } else {
    const descending = bullets.length >= 2 && bullets[0].date > bullets[bullets.length - 1].date;
    let before = -1;
    for (const b of bullets) {
      if (descending ? b.date < date : b.date > date) {
        before = b.index;
        break;
      }
    }
    if (before !== -1) {
      insertAt = before;
    } else {
      // After the LAST bullet, past its indented continuation (detail) lines.
      insertAt = bullets[bullets.length - 1].index + 1;
      while (insertAt < lines.length && CONTINUATION_RE.test(lines[insertAt])) insertAt++;
    }
  }

  return [...lines.slice(0, insertAt), ...blockLines, ...lines.slice(insertAt)].join('\n');
}

/**
 * Write one manual timeline entry through the page/facts write-through seam.
 *
 * Trust gating (subagent sandbox, dry-run) stays at the CALLER, exactly like
 * `writePageThrough` — this helper only does "target resolves → locked splice
 * into the on-disk file + row splice + insert". Never throws: failures return
 * `handled: false` so the caller's legacy DB-only insert still records the
 * entry (with `entry` carrying the canonical tuple when the bullet already
 * reached the disk file — see TimelineWriteThroughOutcome.entry).
 */
export async function writeTimelineEntryThrough(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  entry: TimelineEntryWriteInput,
  opts: { logger?: WriteThroughLogger } = {},
): Promise<TimelineWriteThroughOutcome> {
  try {
    if (await isWriteThroughDisabled(engine)) {
      return { kind: 'db_only', handled: false, skipped: 'disabled_by_config' };
    }
    const target = await resolvePageWriteTarget(engine, slug, sourceId);
    if (!target.ok) {
      if (
        target.skipped === 'no_repo_configured'
        || target.skipped === 'source_repo_belongs_to_other_source'
      ) return { kind: 'db_only', handled: false, skipped: target.skipped };
      return { kind: 'partial', handled: false, error: target.skipped };
    }

    const page = await engine.getPage(slug, { sourceId });
    if (!page) {
      return { kind: 'partial', handled: false, error: 'page_not_found' };
    }

    const rendered = renderTimelineEntry(entry, slug);
    if (!rendered) {
      return { kind: 'partial', handled: false, error: 'render_not_roundtrippable' };
    }

    return await withPutPageOperationLock(
      engine,
      sourceId,
      slug,
      async (): Promise<TimelineWriteThroughOutcome> => {
        const health = await verifyOrRepairPageFile(
          engine, slug, page.content_hash ?? '', { sourceId, logger: opts.logger },
        );
        if (health.file_status !== 'healthy' && health.file_status !== 'repaired') {
          return {
            kind: 'partial',
            handled: false,
            file: health,
            error: health.error ?? health.skipped ?? 'canonical file unavailable',
          };
        }
        if (health.path !== target.filePath) {
          return { kind: 'partial', handled: false, error: 'timeline target moved' };
        }
        const dir = dirname(target.filePath);
        const base = basename(target.filePath);
        if (existsSync(dir) && !readdirSync(dir).includes(base) && existsSync(target.filePath)) {
          return { kind: 'partial', handled: false, error: 'case_insensitive_collision' };
        }
        const beforeBytes = readFileSync(target.filePath);
        const expectedTargetSha256 = sha256Utf8(beforeBytes);
        const afterText = spliceTimelineIntoFileText(
          beforeBytes.toString('utf8'),
          entry.date,
          rendered.block,
        );
        const roundTrips = extractTimelineFromContent(afterText, slug).some(
          (e) =>
            e.date === rendered.canonical.date &&
            (e.source ?? '') === rendered.canonical.source &&
            e.summary === rendered.canonical.summary,
        );
        if (!roundTrips) {
          return { kind: 'partial', handled: false, error: 'splice_not_roundtrippable' };
        }

        try {
          const committed = await commitCanonicalMarkdownMutation(
            engine,
            sourceId,
            slug,
            afterText,
            async (tx) => {
              const inserted = await tx.addTimelineEntry(slug, { // gbrain-allow-direct-insert: timeline write-through — the canonical markdown gains the same entry in this call, and the stored tuple is derived from the rendered bullet so sync/extract reconciliation dedups against it
                date: rendered.canonical.date,
                source: rendered.canonical.source,
                summary: rendered.canonical.summary,
                detail: entry.detail || '',
              }, { sourceId, skipExistenceCheck: true });
              if (!inserted) throw new DuplicateTimelineEntryError();
              return rendered.canonical;
            },
            {
              logger: opts.logger,
              expectedPath: target.filePath,
              expectedTargetSha256,
            },
          );
          return { kind: 'written', handled: true, file: committed.file, entry: committed.value };
        } catch (error) {
          if (error instanceof DuplicateTimelineEntryError) {
            try {
              const duplicateRows = await engine.executeRaw<{ detail: string | null }>(
                `SELECT te.detail
                   FROM timeline_entries te
                   JOIN pages p ON p.id = te.page_id
                  WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
                    AND te.date = $3::date AND te.summary = $4 AND te.source = $5
                  LIMIT 1`,
                [
                  sourceId,
                  slug,
                  rendered.canonical.date,
                  rendered.canonical.summary,
                  rendered.canonical.source,
                ],
              );
              if (
                duplicateRows.length !== 1
                || (duplicateRows[0]!.detail ?? '') !== (entry.detail ?? '')
              ) {
                return {
                  kind: 'partial',
                  handled: false,
                  error: 'timeline duplicate key exists with different detail',
                };
              }
              let duplicateProjection = await loadCanonicalProjection(engine, sourceId, slug);
              if (!duplicateProjection || !projectionIsFresh(duplicateProjection)) {
                duplicateProjection = await persistCanonicalProjectionFromRow(engine, sourceId, slug);
              }
              const duplicatePage = await engine.getPage(slug, { sourceId });
              if (!duplicatePage) {
                return {
                  kind: 'partial', handled: false,
                  error: 'timeline page disappeared while repairing duplicate',
                };
              }
              const duplicateMaterialized = extractTimelineFromContent(
                duplicatePage.timeline ?? '',
                slug,
              ).some((candidate) =>
                candidate.date === rendered.canonical.date
                && (candidate.source ?? '') === rendered.canonical.source
                && candidate.summary === rendered.canonical.summary
              );
              if (!duplicateMaterialized) {
                const materialized = await commitCanonicalMarkdownMutation(
                  engine,
                  sourceId,
                  slug,
                  afterText,
                  async () => rendered.canonical,
                  {
                    logger: opts.logger,
                    expectedPath: target.filePath,
                    expectedTargetSha256,
                  },
                );
                return {
                  kind: 'written',
                  handled: true,
                  file: materialized.file,
                  entry: materialized.value,
                };
              }

              const repaired = await verifyOrRepairPageFile(
                engine,
                slug,
                duplicateProjection.semanticContentHash,
                { sourceId, logger: opts.logger },
              );
              if (
                (repaired.file_status === 'healthy' || repaired.file_status === 'repaired')
                && repaired.path === target.filePath
              ) {
                return { kind: 'duplicate', handled: false };
              }
              return {
                kind: 'partial',
                handled: false,
                file: repaired,
                error: repaired.error ?? repaired.skipped
                  ?? 'duplicate row exists but file is not canonical',
              };
            } catch (repairError) {
              return {
                kind: 'partial',
                handled: false,
                error: repairError instanceof Error ? repairError.message : String(repairError),
              };
            }
          }
          if (error instanceof CanonicalMutationPartialError) {
            return {
              kind: 'partial',
              handled: false,
              file: error.writeThrough,
              error: error.message,
            };
          }
          return {
            kind: 'partial',
            handled: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { timeoutMs: 5_000 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.logger?.warn(`[timeline-write-through] failed for ${slug}: ${msg}`);
    return { kind: 'partial', handled: false, error: msg };
  }
}
