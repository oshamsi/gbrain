/**
 * Shared takes write-through core — consumed by the `gbrain takes` CLI
 * (src/commands/takes.ts) and the takes_* MCP ops (src/core/ops/takes.ts).
 *
 * MARKDOWN IS CANONICAL (the extract-takes contract, src/core/cycle/
 * extract-takes.ts): the md→DB reconcile upserts ON CONFLICT(page_id,row_num)
 * and the extract rebuild lane deletes+reinserts from md, so any writer that
 * creates DB-only rows gets silently clobbered by the next sync/extract. Every
 * mutation here is therefore md-FIRST — row numbers derive from the fence
 * (takes-fence.ts), the .md file is written before the DB — and the markdown
 * write is REQUIRED: when the page file can't be located the write REFUSES
 * (TakesWriteError 'mirror_unavailable') instead of creating divergence.
 *
 * Every mutate runs this pipeline:
 *
 *   lock(slug, timeout) ─▶ page id (DB, source-scoped) ─▶ read .md
 *        │                                                   │
 *        │                    row lookup + holder fence ◀────┘ (fence rows,
 *        │                          │                          md-canonical)
 *        │                    fence edit ─▶ write .md ─▶ DB mirror ─▶ release
 *        ▼
 *   [contended → 'page_locked' (retryable)]
 *
 * The DB mirror for add/update/supersede is addTakesBatch's upsert of the
 * affected fence rows — the same primitive the extract pipeline uses, so the
 * mirror can never disagree with a later reconcile. Its DO UPDATE clause
 * touches base columns only (resolution columns preserved). resolve mirrors
 * via engine.resolveTake (resolution fields aren't in TakeBatchInput);
 * a drifted DB missing the row is self-healed by upserting the base row
 * first — md is the truth being propagated.
 *
 * Holder fence (remote callers): callers pass `allowList` (null/undefined =
 * trusted local, unfenced; [] = deny-all). Row-level checks look up the
 * PARSED FENCE row and a fenced holder presents as 'row_not_found' — the
 * same shape as a genuinely missing row — hiding content and holder.
 * (Existence-by-count via dense row numbers is a documented, accepted
 * limitation — see ops/takes.ts.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine, TakeBatchInput, TakeKind } from './engine.ts';
import {
  parseTakesFence,
  renderTakesFence,
  upsertTakeRow,
  supersedeRow,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
  type ParsedTake,
  type ParseResult,
} from './takes-fence.ts';
import { withPutPageOperationLock } from './ops/put-page-lock.ts';
import { OperationError } from './ops/contract.ts';
import { resolvePageFilePath, resolveSourceLocalFilePath } from './markdown.ts';
import { sanitizeRecordedSourcePath, recordedPathFromFileUri, verifyOrRepairPageFile } from './write-through.ts';
import { isWriteTargetContained, msysToNativePath } from './path-confine.ts';
import {
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  projectionIsFresh,
  sha256Utf8,
} from './page-canonical.ts';
import {
  CanonicalMutationPartialError,
  commitCanonicalMarkdownMutation,
} from './canonical-mutation.ts';

export type TakesWriteErrorCode =
  | 'page_not_found'      // slug has no pages row (scoped)
  | 'row_not_found'       // fence lacks the row OR the holder fence masks it
  | 'already_resolved'    // resolved rows are immutable; supersede instead
  | 'row_inactive'        // superseded rows can't be updated/resolved again
  | 'holder_denied'       // add with a holder outside the allow-list
  | 'no_fields'           // update with zero mutable fields
  | 'mirror_unavailable'  // sync.repo_path unset, page file absent, or write target escapes the source root
  | 'page_locked'         // lock contention within the timeout (retryable)
  | 'fence_unparsed'      // the page's fence has parser-skipped rows a whole-fence re-render would delete
  | 'invalid_input'       // free-text field carries control chars, fence markers, or out-of-range values
  | 'partial_write';      // store committed; canonical file verification failed

export class TakesWriteError extends Error {
  code: TakesWriteErrorCode;
  hint?: string;
  constructor(code: TakesWriteErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'TakesWriteError';
    this.code = code;
    this.hint = hint;
  }
}

/** null/undefined = trusted local (unfenced); [] = deny-all. */
export type HolderAllowList = readonly string[] | null | undefined;

export interface TakesWriteTarget {
  engine: BrainEngine;
  slug: string;
  /** Brain repo dir (resolveTakesRepoDir or an explicit CLI --dir). */
  brainDir: string;
  /** Scalar source scope for the pages lookup (writes are scalar). */
  sourceId?: string;
  allowList?: HolderAllowList;
  /** Lock wait budget. CLI keeps the 30s default; ops pass ~2000. */
  lockTimeoutMs?: number;
}

/**
 * The markdown write always succeeds before the DB mirror is attempted, and md
 * is canonical — so a failed DB mirror is NOT fatal (the next reconcile heals
 * it; throwing would make the caller retry and duplicate the durable md row).
 * `mirror_warning` carries the DB-mirror error when it happened; `written` is
 * still true because the markdown row is on disk.
 */
export interface TakeMirror { written: true; path: string; mirror_warning?: string }

/**
 * Resolve the markdown brain dir for takes write-through. Returns null when
 * `sync.repo_path` is unset or missing on disk — callers decide the refusal
 * shape (ops: 'mirror_unavailable'; CLI: its historical error text + exit 1).
 */
export async function resolveTakesRepoDir(engine: BrainEngine): Promise<string | null> {
  const configured = await engine.getConfig('sync.repo_path');
  if (configured && existsSync(configured)) return configured;
  return null;
}

/**
 * P1-1 (source isolation): resolve the ACTUAL per-source markdown path for a
 * write, mirroring write-through.ts's topology so a source-scoped take lands in
 * the SAME working tree `gbrain sync` reads it back from. The old
 * `join(brainDir, slug.md)` ignored the page's source entirely, so a non-default
 * source's write clobbered a same-slug file in the wrong tree.
 *
 *   1. Source has its OWN `local_path` working tree → use the page's recorded
 *      `source_path`, removing a duplicated Git-root scope when local_path is
 *      a repo subdirectory; a DB-born page falls back to `<local_path>/<slug>.md`.
 *   2. No per-source `local_path` → the shared host repo (`brainDir`): default
 *      source at the root, non-default nested under `.sources/<id>/`.
 *
 * #3605: in BOTH topologies the page's vetted recorded path (`source_path`,
 * or a contained `file://` `source_uri` from `gbrain capture --file`) is
 * preferred over a slug-derived name — the on-disk name is often NOT the slug
 * (`people/Jane Doe.md` has slug `people/jane-doe`), so deriving `<slug>.md`
 * minted a stray twin on add and refused update/resolve with
 * 'mirror_unavailable' even though the page's file was right there. A hostile
 * or unusable recorded path sanitizes to null and falls back to the slug path.
 *
 * The returned `writeRoot` is the containment boundary enforced before any write
 * (P1-2). `resolvePageFilePath` does the slug→path join for the fallback case.
 */
async function resolveTakesFilePath(
  engine: BrainEngine,
  brainDir: string,
  slug: string,
  sourceId?: string,
): Promise<{ path: string; writeRoot: string }> {
  const src = sourceId ?? 'default';
  const rows = await engine.executeRaw<
    { local_path: string | null; source_path: string | null; source_uri: string | null }
  >(
    `SELECT s.local_path, p.source_path, p.source_uri
       FROM sources s
       LEFT JOIN pages p ON p.source_id = s.id AND p.slug = $2 AND p.deleted_at IS NULL
      WHERE s.id = $1
      LIMIT 1`,
    [src, slug],
  );
  // #2955: heal Git Bash/MSYS-recorded local_path (`/c/Users/x`) before any
  // join/containment math — same normalization as write-through.ts. Without
  // it the writeRoot resolves to a phantom `<cwd-drive>:\c\...` on Windows.
  const sourceLocalPath = rows[0]?.local_path ? msysToNativePath(rows[0].local_path) : null;
  const recordedSourcePath = rows[0]?.source_path ?? null;
  const recordedUri = rows[0]?.source_uri ?? null;
  if (sourceLocalPath) {
    const recordedPath =
      resolveSourceLocalFilePath(sourceLocalPath, recordedSourcePath) ??
      (() => {
        const fromUri = recordedPathFromFileUri(recordedUri, sourceLocalPath);
        return fromUri ? join(sourceLocalPath, fromUri) : null;
      })();
    // A null recorded path means a DB-born page. Keep the established slug path.
    const path = recordedPath ?? resolvePageFilePath(sourceLocalPath, slug, 'default');
    return { path, writeRoot: sourceLocalPath };
  }
  const pageRoot = src === 'default' ? brainDir : join(brainDir, '.sources', src);
  const knownPath =
    sanitizeRecordedSourcePath(recordedSourcePath) ??
    recordedPathFromFileUri(recordedUri, pageRoot);
  const path = knownPath
    ? join(pageRoot, knownPath)
    : resolvePageFilePath(brainDir, slug, src);
  return { path, writeRoot: brainDir };
}

/** Test seam: pins the #2955 msys local_path healing at THIS read site. */
export const __takesWriteTesting = { resolveTakesFilePath };

async function getPageId(
  engine: BrainEngine,
  slug: string,
  sourceId?: string,
): Promise<number> {
  const sid = sourceId ?? 'default';
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sid, slug],
  );
  if (!rows[0]) {
    throw new TakesWriteError(
      'page_not_found',
      `Page not found in brain: ${slug} (source=${sid}).`,
      'Run a brain sync first, or check the slug/source.',
    );
  }
  return rows[0].id;
}

function assertHolderAllowed(holder: string, allowList: HolderAllowList): void {
  if (allowList === null || allowList === undefined) return; // trusted local
  if (!allowList.includes(holder)) {
    throw new TakesWriteError(
      'holder_denied',
      `holder '${holder}' is not in this caller's takes-holder allow-list.`,
      'holder_not_in_allowlist',
    );
  }
}

/**
 * Fence-injection guard for free-text cells. Every user-supplied string that
 * lands in a fence cell must be single-line (control chars — newlines
 * included — would let one cell mint extra table rows) and must not carry the
 * fence-marker text: 'gbrain:takes' is the tightest common substring of
 * TAKES_FENCE_BEGIN/TAKES_FENCE_END, so a cell containing it could terminate
 * the fence early or open a second one, rewriting rows the caller doesn't own.
 */
const CELL_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n\r\t]/;
const FENCE_MARKER_SUBSTRING = 'gbrain:takes';
function assertSafeCellText(field: string, value: string | undefined): void {
  if (typeof value !== 'string') return;
  if (CELL_CONTROL_CHARS.test(value)) {
    throw new TakesWriteError(
      'invalid_input',
      `${field} contains control characters (newlines included) — takes fence cells are single-line.`,
    );
  }
  if (value.includes(FENCE_MARKER_SUBSTRING)) {
    throw new TakesWriteError(
      'invalid_input',
      `${field} contains the takes fence marker text ('${FENCE_MARKER_SUBSTRING}') — refusing a fence-injection write.`,
    );
  }
  // F2: a wholly-strikethrough value (`~~x~~`) round-trips as active:false —
  // fence-shared.ts stripStrikethrough matches ^~~(.+?)~~$ — so writing it as an
  // active claim would silently mark the take inactive on the next parse.
  if (/^~~[\s\S]*~~$/.test(value.trim())) {
    throw new TakesWriteError(
      'invalid_input',
      `${field} is wholly strikethrough-wrapped; that markup marks a take inactive on the next parse.`,
    );
  }
}

/**
 * The param docs promise weight 0..1 and the DB clamps out-of-range values
 * (normalizeWeightForStorage) — writing the raw value to md would diverge the
 * markdown from the DB mirror, so out-of-range is refused up front.
 */
function assertValidWeight(weight: number | undefined): void {
  if (weight === undefined) return;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new TakesWriteError('invalid_input', `weight must be a number in [0, 1] (got ${weight}).`);
  }
}

const SINCE_DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;
function assertValidSinceDate(value: string | undefined): void {
  if (value === undefined) return;
  if (!SINCE_DATE_RE.test(value)) {
    throw new TakesWriteError(
      'invalid_input',
      `since date must be 'YYYY-MM' or 'YYYY-MM-DD' (got '${value}').`,
    );
  }
}

/**
 * Row lookup with the no-existence-leak masking: a row that is absent from
 * the fence AND a row whose holder the caller cannot see produce the SAME
 * error shape.
 */
function findFenceRow(takes: ParsedTake[], rowNum: number, allowList: HolderAllowList, slug: string): ParsedTake {
  const target = takes.find(t => t.rowNum === rowNum);
  const visible = target
    && (allowList === null || allowList === undefined || allowList.includes(target.holder));
  if (!target || !visible) {
    throw new TakesWriteError('row_not_found', `Row #${rowNum} not found on ${slug}.`);
  }
  return target;
}

async function readCanonicalPageBody(
  target: TakesWriteTarget,
  path: string,
): Promise<{ body: string; expectedTargetSha256: string }> {
  const sourceId = target.sourceId ?? 'default';
  let projection = await loadCanonicalProjection(target.engine, sourceId, target.slug);
  if (!projection || !projectionIsFresh(projection)) {
    projection = await persistCanonicalProjectionFromRow(target.engine, sourceId, target.slug);
  }
  const health = await verifyOrRepairPageFile(
    target.engine,
    target.slug,
    projection.semanticContentHash,
    { sourceId },
  );
  if (
    (health.file_status !== 'healthy' && health.file_status !== 'repaired')
    || health.path !== path
  ) {
    throw new TakesWriteError(
      'mirror_unavailable',
      health.error ?? health.skipped ?? 'canonical file unavailable',
      'takes_mirror_unavailable',
    );
  }
  const bytes = readFileSync(path);
  return { body: bytes.toString('utf8'), expectedTargetSha256: sha256Utf8(bytes) };
}

async function commitTakesMarkdown<T>(
  target: TakesWriteTarget,
  markdown: string,
  writeRoot: string,
  path: string,
  expectedTargetSha256: string,
  mutateDb: (tx: BrainEngine) => Promise<T>,
): Promise<string> {
  if (!isWriteTargetContained(path, writeRoot)) {
    throw new TakesWriteError(
      'mirror_unavailable',
      'takes write target escapes the source root',
      'path_escapes_source_root',
    );
  }
  try {
    const result = await commitCanonicalMarkdownMutation(
      target.engine,
      target.sourceId ?? 'default',
      target.slug,
      markdown,
      mutateDb,
      { expectedPath: path, expectedTargetSha256 },
    );
    if (!result.file.path) throw new Error('canonical writer returned no path');
    return result.file.path;
  } catch (error) {
    if (error instanceof CanonicalMutationPartialError) {
      throw new TakesWriteError(
        'partial_write',
        error.message,
        'The store committed; an identical retry may repair only the canonical file.',
      );
    }
    throw error;
  }
}

/**
 * F1 (cross-holder data-loss guard): the row-targeting mutates re-render the
 * WHOLE fence from `parsed.takes`, so any row parseTakesFence skipped (duplicate
 * row_num, unknown kind outside {fact,take,bet,hunch}, malformed cells) — or any
 * row it flagged — would be permanently deleted on the next write, INCLUDING a
 * row held by an identity a world-fenced caller can't see. Refuse the write when
 * the fence carries any parse warning; it must be reconciled first.
 */
function assertFenceRoundTrips(parsed: ParseResult): void {
  if (parsed.warnings.length > 0) {
    throw new TakesWriteError(
      'fence_unparsed',
      `The page's takes fence has rows this version can't safely round-trip: ${parsed.warnings[0]}`,
      // #3697: this used to name `gbrain extract takes --slugs`, which is not the
      // command grammar (extract has links/timeline/all; takes extraction lives
      // under `gbrain takes extract`). Point at surfaces that exist.
      "Reconcile the page's takes fence before mutating — it contains rows this version can't safely round-trip. Fix the malformed fence rows by hand, or re-extract via `gbrain takes extract --from-pages --include-covered`.",
    );
  }
}

function replaceFence(body: string, rows: ParsedTake[]): string {
  const newFence = renderTakesFence(rows);
  const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
  const endIdx = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
  return body.slice(0, beginIdx) + newFence + body.slice(endIdx + TAKES_FENCE_END.length);
}

function toBatchInput(pageId: number, t: ParsedTake, supersededBy?: number | null): TakeBatchInput {
  return {
    page_id: pageId,
    row_num: t.rowNum,
    claim: t.claim,
    kind: t.kind,
    holder: t.holder,
    weight: t.weight,
    since_date: t.sinceDate,
    until_date: t.untilDate,
    source: t.source,
    active: t.active,
    superseded_by: supersededBy ?? null,
  };
}

async function withTakesLock<T>(target: TakesWriteTarget, fn: () => Promise<T>): Promise<T> {
  try {
    return await withPutPageOperationLock(
      target.engine,
      target.sourceId ?? 'default',
      target.slug,
      fn,
      { ...(target.lockTimeoutMs !== undefined ? { timeoutMs: target.lockTimeoutMs } : {}) },
    );
  } catch (error) {
    if (error instanceof TakesWriteError) throw error;
    if (error instanceof OperationError && error.code === 'write_conflict') {
      throw new TakesWriteError('page_locked', error.message, 'retryable');
    }
    throw error;
  }
}

export interface AddTakeInput {
  claim: string;
  kind: TakeKind;
  holder: string;
  weight?: number;
  source?: string;
  sinceDate?: string;
}

export async function addTakeToPage(
  target: TakesWriteTarget,
  input: AddTakeInput,
): Promise<{ rowNum: number; mirror: TakeMirror }> {
  assertHolderAllowed(input.holder, target.allowList);
  // Fence-injection + range guards run before any I/O (invalid input must
  // never acquire the lock or touch the page).
  assertSafeCellText('claim', input.claim);
  assertSafeCellText('kind', input.kind);
  assertSafeCellText('holder', input.holder);
  assertSafeCellText('source', input.source);
  assertValidWeight(input.weight);
  assertValidSinceDate(input.sinceDate);
  return withTakesLock(target, async () => {
    // Resolve the page BEFORE touching the markdown (the historical CLI
    // ordering): failing after a fence write would leave a take on disk the
    // DB never saw until the next reconcile.
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    // add is the one mutate that may CREATE the page file + fence (first take
    // on a page) — readPageBody's existence refusal applies to row-targeting
    // mutates, not appends; the page itself was verified in the DB above.
    const { path, writeRoot } = await resolveTakesFilePath(
      target.engine, target.brainDir, target.slug, target.sourceId,
    );
    const { body, expectedTargetSha256 } = await readCanonicalPageBody(target, path);
    assertFenceRoundTrips(parseTakesFence(body));
    const { body: nextBody, rowNum } = upsertTakeRow(body, {
      claim: input.claim,
      kind: input.kind,
      holder: input.holder,
      weight: input.weight ?? 0.5,
      source: input.source,
      sinceDate: input.sinceDate,
      active: true,
    });
    const writtenPath = await commitTakesMarkdown(
      target,
      nextBody,
      writeRoot,
      path,
      expectedTargetSha256,
      async (tx) => {
        const mirrored = await tx.addTakesBatch([{
          page_id: pageId,
          row_num: rowNum,
          claim: input.claim,
          kind: input.kind,
          holder: input.holder,
          weight: input.weight ?? 0.5,
          since_date: input.sinceDate,
          source: input.source,
          active: true,
          superseded_by: null,
        }], { inTransaction: true });
        if (mirrored !== 1) throw new Error('TAKES_MIRROR_COUNT_MISMATCH');
      },
    );
    return { rowNum, mirror: { written: true, path: writtenPath } };
  });
}

export interface UpdateTakeFields {
  weight?: number;
  source?: string;
  sinceDate?: string;
}

export async function updateTakeOnPage(
  target: TakesWriteTarget,
  rowNum: number,
  fields: UpdateTakeFields,
): Promise<{ rowNum: number; mirror: TakeMirror }> {
  if (fields.weight === undefined && fields.source === undefined && fields.sinceDate === undefined) {
    throw new TakesWriteError('no_fields', 'No mutable fields given (weight, source, since date).');
  }
  assertSafeCellText('source', fields.source);
  assertValidWeight(fields.weight);
  assertValidSinceDate(fields.sinceDate);
  return withTakesLock(target, async () => {
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    const { path, writeRoot } = await resolveTakesFilePath(
      target.engine, target.brainDir, target.slug, target.sourceId,
    );
    const { body, expectedTargetSha256 } = await readCanonicalPageBody(target, path);
    const parsed = parseTakesFence(body);
    assertFenceRoundTrips(parsed); // F1: refuse a whole-fence re-render that would drop skipped rows.
    const targetRow = findFenceRow(parsed.takes, rowNum, target.allowList, target.slug);
    if (targetRow.resolvedAt) {
      throw new TakesWriteError('already_resolved', `Row #${rowNum} on ${target.slug} is resolved — resolved takes are immutable.`, 'Supersede instead.');
    }
    if (!targetRow.active) {
      // A superseded row's mirror upsert would also wipe its superseded_by
      // pointer — refuse, matching supersedeTakeOnPage's guard.
      throw new TakesWriteError('row_inactive', `Row #${rowNum} on ${target.slug} is already superseded.`);
    }
    const updated: ParsedTake = {
      ...targetRow,
      weight: fields.weight ?? targetRow.weight,
      source: fields.source ?? targetRow.source,
      sinceDate: fields.sinceDate ?? targetRow.sinceDate,
    };
    const allRows = parsed.takes.map(t => (t.rowNum === rowNum ? updated : t));
    const writtenPath = await commitTakesMarkdown(
      target,
      replaceFence(body, allRows),
      writeRoot,
      path,
      expectedTargetSha256,
      async (tx) => {
        const mirrored = await tx.addTakesBatch([toBatchInput(pageId, updated)], { inTransaction: true });
        if (mirrored !== 1) throw new Error('TAKES_MIRROR_COUNT_MISMATCH');
      },
    );
    return { rowNum, mirror: { written: true, path: writtenPath } };
  });
}

export interface SupersedeTakeInput {
  claim: string;
  kind?: TakeKind;
  holder?: string;
  weight?: number;
  source?: string;
  sinceDate?: string;
}

export async function supersedeTakeOnPage(
  target: TakesWriteTarget,
  rowNum: number,
  input: SupersedeTakeInput,
): Promise<{ oldRow: number; newRow: number; mirror: TakeMirror }> {
  assertSafeCellText('claim', input.claim);
  assertSafeCellText('kind', input.kind);
  assertSafeCellText('holder', input.holder);
  assertSafeCellText('source', input.source);
  assertValidWeight(input.weight);
  assertValidSinceDate(input.sinceDate);
  return withTakesLock(target, async () => {
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    const { path, writeRoot } = await resolveTakesFilePath(
      target.engine, target.brainDir, target.slug, target.sourceId,
    );
    const { body, expectedTargetSha256 } = await readCanonicalPageBody(target, path);
    const parsed = parseTakesFence(body);
    assertFenceRoundTrips(parsed); // F1: refuse a whole-fence re-render that would drop skipped rows.
    const targetRow = findFenceRow(parsed.takes, rowNum, target.allowList, target.slug);
    if (!targetRow.active) {
      throw new TakesWriteError('row_inactive', `Row #${rowNum} on ${target.slug} is already superseded.`);
    }
    if (targetRow.resolvedAt) {
      throw new TakesWriteError('already_resolved', `Row #${rowNum} on ${target.slug} is resolved — resolved takes are immutable.`, 'Add a new take instead.');
    }
    const holder = input.holder ?? targetRow.holder;
    // An explicit replacement holder must clear the fence too (an allow-listed
    // caller must not mint rows held by identities it can't see).
    if (input.holder !== undefined) assertHolderAllowed(input.holder, target.allowList);
    // CLI-parity default: unset weight decays the target's by 0.1.
    const weight = input.weight ?? Math.max(0, targetRow.weight - 0.1);
    const { body: nextBody, newRowNum } = supersedeRow(body, rowNum, {
      claim: input.claim,
      kind: input.kind ?? targetRow.kind,
      holder,
      weight,
      sinceDate: input.sinceDate,
      source: input.source,
    });
    const writtenPath = await commitTakesMarkdown(
      target,
      nextBody,
      writeRoot,
      path,
      expectedTargetSha256,
      async (tx) => {
        const after = parseTakesFence(nextBody).takes;
        const oldAfter = after.find(t => t.rowNum === rowNum);
        const newAfter = after.find(t => t.rowNum === newRowNum);
        const mirrorRows: TakeBatchInput[] = [];
        if (oldAfter) mirrorRows.push(toBatchInput(pageId, oldAfter, newRowNum));
        if (newAfter) mirrorRows.push(toBatchInput(pageId, newAfter, null));
        const mirrored = await tx.addTakesBatch(mirrorRows, { inTransaction: true });
        if (mirrored !== mirrorRows.length) throw new Error('TAKES_MIRROR_COUNT_MISMATCH');
      },
    );
    return { oldRow: rowNum, newRow: newRowNum, mirror: { written: true, path: writtenPath } };
  });
}

export type ResolveQuality = 'correct' | 'incorrect' | 'partial' | 'unresolvable';

export interface ResolveTakeInput {
  quality: ResolveQuality;
  /** Evidence text (stored as the resolution source). */
  evidence?: string;
  value?: number;
  unit?: string;
  resolvedBy: string;
}

export async function resolveTakeOnPage(
  target: TakesWriteTarget,
  rowNum: number,
  input: ResolveTakeInput,
): Promise<{ rowNum: number; quality: ResolveQuality; mirror: TakeMirror }> {
  assertSafeCellText('evidence', input.evidence);
  assertSafeCellText('unit', input.unit);
  assertSafeCellText('resolved_by', input.resolvedBy);
  return withTakesLock(target, async () => {
    const pageId = await getPageId(target.engine, target.slug, target.sourceId);
    const { path, writeRoot } = await resolveTakesFilePath(
      target.engine, target.brainDir, target.slug, target.sourceId,
    );
    const { body, expectedTargetSha256 } = await readCanonicalPageBody(target, path);
    const parsed = parseTakesFence(body);
    assertFenceRoundTrips(parsed); // F1: refuse a whole-fence re-render that would drop skipped rows.
    const targetRow = findFenceRow(parsed.takes, rowNum, target.allowList, target.slug);
    if (targetRow.resolvedAt) {
      throw new TakesWriteError('already_resolved', `Row #${rowNum} on ${target.slug} is already resolved.`);
    }
    if (!targetRow.active) {
      // Resolving a superseded row would feed calibration with an already-
      // revised claim — resolve the replacement row instead.
      throw new TakesWriteError('row_inactive', `Row #${rowNum} on ${target.slug} is already superseded.`, 'Resolve the replacement row instead.');
    }
    // quality → outcome per the schema CHECK (v74): correct↔true,
    // incorrect↔false, partial/unresolvable↔NULL.
    const outcome = input.quality === 'correct' ? true
      : input.quality === 'incorrect' ? false : undefined;
    const updated: ParsedTake = {
      ...targetRow,
      resolvedAt: new Date().toISOString().slice(0, 10),
      resolvedQuality: input.quality,
      resolvedOutcome: outcome,
      resolvedEvidence: input.evidence,
      resolvedValue: input.value,
      resolvedUnit: input.unit,
      resolvedBy: input.resolvedBy,
    };
    const allRows = parsed.takes.map(t => (t.rowNum === rowNum ? updated : t));
    const resolveArgs = {
      quality: input.quality,
      outcome,
      value: input.value,
      unit: input.unit,
      source: input.evidence,
      resolvedBy: input.resolvedBy,
    };
    const writtenPath = await commitTakesMarkdown(
      target,
      replaceFence(body, allRows),
      writeRoot,
      path,
      expectedTargetSha256,
      async (tx) => {
        try {
          await tx.resolveTake(pageId, rowNum, resolveArgs);
        } catch (err) {
          if (err instanceof Error && err.message.includes('TAKE_ROW_NOT_FOUND')) {
            await tx.addTakesBatch([toBatchInput(pageId, targetRow)], { inTransaction: true });
            await tx.resolveTake(pageId, rowNum, resolveArgs);
          } else {
            throw err;
          }
        }
      },
    );
    return { rowNum, quality: input.quality, mirror: { written: true, path: writtenPath } };
  });
}
