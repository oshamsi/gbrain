/**
 * BrainWriter — transaction-scoped writer with pre-commit validators.
 *
 * The anti-hallucination contract:
 *   1. Every mutation flows through a WriteTx.
 *   2. On commit, validators run over the touched pages.
 *   3. Strict mode: any validator error rolls back the tx + throws.
 *   4. Lint mode: validators warn but don't block (default behavior pre-flip).
 *   5. Pages with `validate: false` frontmatter skip the validators entirely
 *      (grandfathered legacy pages).
 *
 * The writer does NOT do engine I/O itself — it wraps engine.transaction and
 * delegates to the transactional engine. Routing callers (publish.ts,
 * put_page, etc.) is PR 2.5.
 *
 * Pre-commit validation is the key win over "write now, lint later":
 * a bad citation or dangling back-link never lands on disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { PageType, TimelineInput } from '../types.ts';
import type { ResolverContext } from '../resolvers/interface.ts';
import { SlugRegistry } from './slug-registry.ts';
import {
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  projectionIsFresh,
  sha256Utf8,
} from '../page-canonical.ts';
import {
  isWriteThroughDisabled,
  resolvePageWriteTarget,
  writePageThrough,
  type WriteThroughResult,
} from '../write-through.ts';
import { withPutPageOperationLock } from '../ops/put-page-lock.ts';
import {
  renderTimelineEntry,
  spliceTimelineBlock,
} from '../timeline-write-through.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrictMode = 'strict' | 'lint' | 'off';

type CanonicalFlushPlan =
  | {
      mode: 'file';
      slug: string;
      projectionSha256: string;
      projectionSizeBytes: number;
      filePath: string;
      expectedTargetSha256: string | null;
    }
  | {
      mode: 'not_projected';
      slug: string;
      projectionSha256: string;
    };

type CanonicalTargetPreimage =
  | {
      mode: 'file';
      slug: string;
      filePath: string;
      expectedTargetSha256: string | null;
    }
  | { mode: 'not_projected'; slug: string };

export interface BrainWriterOptions {
  /**
   * 'strict' — validators run and a single error rolls back the transaction.
   * 'lint'   — validators run and report; writes commit regardless.
   * 'off'    — validators are skipped entirely.
   * Default: 'lint' (the safe default for PR 2 rollout; strict flips in a
   * follow-on release after soak).
   */
  strictMode?: StrictMode;
  /**
   * Source every read AND write in this writer targets. Default 'default'
   * (matches engine.putPage's schema default). Pre-fix the writer's reads
   * were UNSCOPED (first slug match across ANY source) while its writes
   * landed in 'default' — the exact unscoped-check/scoped-write bug class:
   * setCompiledTruth could read source B's page and clobber the default
   * source's row with it.
   */
  sourceId?: string;
  _afterCommitBeforeFlushForTest?: (plans: readonly CanonicalFlushPlan[]) => void;
  _afterPageReadBeforeMutationForTest?: (slug: string) => void;
}

export interface EntityInput {
  /** Desired slug (e.g. "people/alice-smith"). May be disambiguated. */
  desiredSlug: string;
  displayName: string;
  type: PageType;
  compiledTruth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
}

export interface ValidationFinding {
  slug: string;
  validator: string;
  severity: 'error' | 'warning';
  line?: number;
  message: string;
}

export interface ValidationReport {
  findings: ValidationFinding[];
  errorCount: number;
  warningCount: number;
  /** Slugs that were touched during the transaction. */
  touchedSlugs: string[];
}

export class WriteError extends Error {
  constructor(
    public code: 'validation_failed' | 'invalid_input' | 'slug_collision' | 'unknown'
      | 'canonical_target_unavailable' | 'canonical_file_diverged' | 'partial_write',
    message: string,
    public findings?: ValidationFinding[],
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

/**
 * Validator contract. Each validator gets a page slug + its current state
 * (post-pending-write, pre-commit) and returns findings. Pure — validators
 * must not do their own writes.
 */
export interface PageValidator {
  readonly id: string;
  validate(ctx: PageValidationContext): Promise<ValidationFinding[]>;
}

export interface PageValidationContext {
  slug: string;
  type: PageType;
  compiledTruth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  engine: BrainEngine;
  /** Exact scalar source for source-qualified validation reads. */
  sourceId?: string;
  /** Federated read scope; when non-empty, takes precedence over sourceId. */
  sourceIds?: string[];
}

// ---------------------------------------------------------------------------
// WriteTx — the transactional surface callers use
// ---------------------------------------------------------------------------

export interface WriteTx {
  createEntity(input: EntityInput): Promise<string>;
  appendTimeline(slug: string, entry: TimelineInput): Promise<void>;
  setCompiledTruth(slug: string, body: string): Promise<void>;
  setFrontmatterField(slug: string, key: string, value: unknown): Promise<void>;
  putRawData(slug: string, source: string, data: object): Promise<void>;
  /**
   * Add an outbound link AND the reverse back-link atomically. Wraps
   * engine.addLink both directions inside this transaction. `context` and
   * `linkType` mirror engine.addLink semantics.
   */
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  /** Set of slugs touched in this transaction. Read-only; validators use it. */
  readonly touchedSlugs: Set<string>;
  /** Context the BrainWriter was opened with. Validators inspect ctx.remote. */
  readonly context: ResolverContext;
}

/**
 * Advisory-lock key for the createEntity slug-claim critical section.
 * Source-scoped (PR6 D5): slug uniqueness is (source_id, slug), so two
 * writers claiming the same desiredSlug in DIFFERENT sources are not in
 * conflict — a shared per-slug key serialized them for nothing, while
 * same-(source, slug) claimants still serialize. `?? 'default'` mirrors
 * engine.putPage's implicit default source (WriteTxImpl.scope()), so the
 * lock key names the exact source the paired putPage will land in.
 */
export function slugRegistryLockKey(sourceId: string | undefined, slug: string): string {
  return `slug_registry:${sourceId ?? 'default'}:${slug}`;
}

class WriteTxImpl implements WriteTx {
  readonly touchedSlugs = new Set<string>();
  private slugRegistry: SlugRegistry;
  private readonly canonicalTargets = new Map<string, CanonicalTargetPreimage>();
  readonly canonicalPages = new Map<string, CanonicalFlushPlan>();

  constructor(
    private engine: BrainEngine,
    public readonly context: ResolverContext,
    private sourceId?: string,
    private afterPageReadBeforeMutationForTest?: (slug: string) => void,
  ) {
    this.slugRegistry = new SlugRegistry(engine, sourceId);
  }

  /** Read+write scope: mirrors engine.putPage's implicit 'default'. */
  private scope(): { sourceId: string } {
    return { sourceId: this.sourceId ?? 'default' };
  }

  private async prepareCanonicalTarget(
    slug: string,
    opts: { creating?: boolean; expectedContentHash?: string } = {},
  ): Promise<void> {
    if (this.canonicalTargets.has(slug)) return;
    const sourceId = this.scope().sourceId;
    if (!opts.creating) {
      if (!opts.expectedContentHash) {
        throw new WriteError(
          'canonical_file_diverged',
          `BrainWriter cannot fence a page without its semantic hash: ${sourceId}/${slug}`,
        );
      }
      const locked = await this.engine.executeRaw<{ id: number | string }>(
        `SELECT id FROM pages
          WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
            AND content_hash = $3
          FOR UPDATE`,
        [sourceId, slug, opts.expectedContentHash],
      );
      if (locked.length !== 1) {
        throw new WriteError(
          'canonical_file_diverged',
          `BrainWriter page moved after its logical read: ${sourceId}/${slug}`,
        );
      }
    }
    if (await isWriteThroughDisabled(this.engine)) {
      this.canonicalTargets.set(slug, { mode: 'not_projected', slug });
      return;
    }
    const target = await resolvePageWriteTarget(this.engine, slug, sourceId);
    if (!target.ok) {
      if (
        target.skipped === 'no_repo_configured'
        || target.skipped === 'source_repo_belongs_to_other_source'
      ) {
        this.canonicalTargets.set(slug, { mode: 'not_projected', slug });
        return;
      }
      throw new WriteError(
        'canonical_target_unavailable',
        `BrainWriter canonical target unavailable for ${sourceId}/${slug}: ${target.skipped}`,
      );
    }

    let expectedTargetSha256: string | null = null;
    if (existsSync(target.filePath)) {
      if (opts.creating) {
        throw new WriteError(
          'canonical_file_diverged',
          `BrainWriter refuses to create ${sourceId}/${slug} over an orphan canonical file`,
        );
      }
      let before = await loadCanonicalProjection(this.engine, sourceId, slug);
      if (!before || !projectionIsFresh(before)) {
        before = await persistCanonicalProjectionFromRow(this.engine, sourceId, slug);
      }
      if (
        opts.expectedContentHash !== undefined
        && before.semanticContentHash !== opts.expectedContentHash
      ) {
        throw new WriteError(
          'canonical_file_diverged',
          `BrainWriter page moved between logical read and canonical preflight: ${sourceId}/${slug}`,
        );
      }
      const bytes = readFileSync(target.filePath);
      expectedTargetSha256 = sha256Utf8(bytes);
      if (
        expectedTargetSha256 !== before.sha256
        || bytes.length !== before.sizeBytes
      ) {
        throw new WriteError(
          'canonical_file_diverged',
          `BrainWriter canonical file differs from the pre-mutation store projection: ${target.filePath}`,
        );
      }
    } else if (!opts.creating) {
      // Prove that an existing row really has a fresh canonical projection even
      // when its file is absent. The post-commit sink may then create it with a
      // null CAS; any file appearing in the meantime makes that CAS fail.
      let before = await loadCanonicalProjection(this.engine, sourceId, slug);
      if (!before || !projectionIsFresh(before)) {
        before = await persistCanonicalProjectionFromRow(this.engine, sourceId, slug);
      }
      if (
        opts.expectedContentHash !== undefined
        && before.semanticContentHash !== opts.expectedContentHash
      ) {
        throw new WriteError(
          'canonical_file_diverged',
          `BrainWriter page moved between logical read and canonical preflight: ${sourceId}/${slug}`,
        );
      }
    }
    this.canonicalTargets.set(slug, {
      mode: 'file',
      slug,
      filePath: target.filePath,
      expectedTargetSha256,
    });
  }

  private async project(slug: string): Promise<void> {
    const prepared = this.canonicalTargets.get(slug);
    if (!prepared) {
      throw new WriteError(
        'unknown',
        `BrainWriter internal error: ${slug} mutated before canonical target preparation`,
      );
    }
    const sourceId = this.scope().sourceId;
    const projection = await persistCanonicalProjectionFromRow(
      this.engine,
      sourceId,
      slug,
    );
    if (prepared.mode === 'file') {
      this.canonicalPages.set(slug, {
        ...prepared,
        projectionSha256: projection.sha256,
        projectionSizeBytes: projection.sizeBytes,
      });
    } else {
      this.canonicalPages.set(slug, {
        ...prepared,
        projectionSha256: projection.sha256,
      });
    }
  }

  async createEntity(input: EntityInput): Promise<string> {
    if (!input.desiredSlug || !input.displayName || !input.type) {
      throw new WriteError('invalid_input', 'createEntity requires desiredSlug, displayName, and type');
    }
    // Cross-process TOCTOU guard: take a transaction-scoped advisory lock
    // keyed on (source, desired slug) so two putPage('people/alice') calls
    // from separate processes serialize at the DB level. The second caller's
    // slugRegistry.create() then observes the first's write and disambiguates.
    // PGLite is single-process so this is a harmless no-op there.
    //
    // TX SCOPE (PR6 D5 — why there is no `engine.transaction` wrap here):
    // WriteTxImpl is constructed in exactly one place — inside
    // BrainWriter.transaction's `engine.transaction(async (txEngine) => ...)`
    // — and `this.engine` IS that txEngine (its `sql`/`db` route to the tx
    // connection on both engines). So this xact lock is ALREADY taken inside
    // the one wrapping transaction and is held across slugRegistry.create's
    // existence probes AND the putPage below, until the outer commit — the
    // full TOCTOU window. Adding another engine.transaction here would NEST,
    // which throws on both engines (postgres tx clones have no `.begin`;
    // PGLite tx proxies have no `.transaction`). Pinned by
    // test/lock-keys.test.ts (single-transaction routing proof).
    //
    // hashtext (not hashtextextended): must behave identically on BOTH
    // engines and any failure is SILENTLY swallowed by the catch below — an
    // erroring primitive would quietly drop the lock. hashtext is the
    // primitive every advisory-lock site in this repo already proves on both
    // engines; keep the family uniform.
    try {
      await this.engine.executeRaw(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [slugRegistryLockKey(this.sourceId, input.desiredSlug)],
      );
    } catch {
      // Some engines/test doubles may not support advisory locks. Fall
      // through — within-process collisions are still caught by the existing
      // getPage() check, and this only reduces protection against
      // cross-process races (which don't exist on embedded engines anyway).
    }
    const { slug } = await this.slugRegistry.create({
      desiredSlug: input.desiredSlug,
      displayName: input.displayName,
      type: input.type,
    });
    await this.prepareCanonicalTarget(slug, { creating: true });
    this.afterPageReadBeforeMutationForTest?.(slug);
    await this.engine.putPage(slug, {
      type: input.type,
      title: input.displayName,
      compiled_truth: input.compiledTruth,
      timeline: input.timeline ?? '',
      frontmatter: input.frontmatter ?? {},
    }, this.scope());
    await this.project(slug);
    this.touchedSlugs.add(slug);
    return slug;
  }

  async appendTimeline(slug: string, entry: TimelineInput): Promise<void> {
    const page = await this.engine.getPage(slug, this.scope());
    if (!page) throw new WriteError('invalid_input', `appendTimeline: page not found: ${slug}`);
    if (!page.content_hash) throw new WriteError('canonical_file_diverged', `appendTimeline: page has no semantic hash: ${slug}`);
    await this.prepareCanonicalTarget(slug, {
      expectedContentHash: page.content_hash,
    });
    this.afterPageReadBeforeMutationForTest?.(slug);
    const rendered = renderTimelineEntry(entry, slug);
    if (!rendered) {
      throw new WriteError('invalid_input', `appendTimeline: entry does not round-trip: ${slug}`);
    }
    const inserted = await this.engine.addTimelineEntry(slug, { // gbrain-allow-direct-insert: BrainWriter is the canonical synthesize-phase write surface — output gets fenced into pages via putPage in the same transaction
      ...entry,
      date: rendered.canonical.date,
      source: rendered.canonical.source,
      summary: rendered.canonical.summary,
    }, this.scope());
    if (!inserted) throw new WriteError('invalid_input', `appendTimeline: duplicate entry: ${slug}`);
    await this.engine.putPage(slug, {
      type: page.type,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: spliceTimelineBlock(page.timeline ?? '', entry.date, rendered.block),
      frontmatter: page.frontmatter,
    }, this.scope());
    await this.project(slug);
    this.touchedSlugs.add(slug);
  }

  async setCompiledTruth(slug: string, body: string): Promise<void> {
    const existing = await this.engine.getPage(slug, this.scope());
    if (!existing) throw new WriteError('invalid_input', `setCompiledTruth: page not found: ${slug}`);
    if (!existing.content_hash) throw new WriteError('canonical_file_diverged', `setCompiledTruth: page has no semantic hash: ${slug}`);
    await this.prepareCanonicalTarget(slug, {
      expectedContentHash: existing.content_hash,
    });
    this.afterPageReadBeforeMutationForTest?.(slug);
    await this.engine.putPage(slug, {
      type: existing.type,
      title: existing.title,
      compiled_truth: body,
      timeline: existing.timeline,
      frontmatter: existing.frontmatter,
    }, this.scope());
    await this.project(slug);
    this.touchedSlugs.add(slug);
  }

  async setFrontmatterField(slug: string, key: string, value: unknown): Promise<void> {
    const existing = await this.engine.getPage(slug, this.scope());
    if (!existing) throw new WriteError('invalid_input', `setFrontmatterField: page not found: ${slug}`);
    if (!existing.content_hash) throw new WriteError('canonical_file_diverged', `setFrontmatterField: page has no semantic hash: ${slug}`);
    await this.prepareCanonicalTarget(slug, {
      expectedContentHash: existing.content_hash,
    });
    this.afterPageReadBeforeMutationForTest?.(slug);
    const nextFm = { ...existing.frontmatter, [key]: value };
    await this.engine.putPage(slug, {
      type: existing.type,
      title: existing.title,
      compiled_truth: existing.compiled_truth,
      timeline: existing.timeline,
      frontmatter: nextFm,
    }, this.scope());
    await this.project(slug);
    this.touchedSlugs.add(slug);
  }

  async putRawData(slug: string, source: string, data: object): Promise<void> {
    await this.engine.putRawData(slug, source, data, this.scope());
    this.touchedSlugs.add(slug);
  }

  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    // Both endpoints scoped to this writer's source — synthesize-phase links
    // are within-source by definition, and unscoped endpoints resolve against
    // 'default'-source rows (wrong page or missing) in a scoped writer.
    const sid = this.scope().sourceId;
    const linkScope = { fromSourceId: sid, toSourceId: sid };
    await this.engine.addLink(from, to, context, linkType, undefined, undefined, undefined, linkScope); // gbrain-allow-direct-insert: BrainWriter is the canonical synthesize-phase write surface
    // Reverse back-link — both directions inside the same outer transaction.
    // Uses 'backlink' label on the reverse if no linkType was specified so
    // the reverse is distinguishable from the forward semantic type.
    await this.engine.addLink(to, from, context, linkType ? `${linkType}_back` : 'backlink', undefined, undefined, undefined, linkScope); // gbrain-allow-direct-insert: BrainWriter synthesize-phase reverse back-link in the same transaction as the forward addLink above
    this.touchedSlugs.add(from);
    this.touchedSlugs.add(to);
  }
}

// ---------------------------------------------------------------------------
// BrainWriter
// ---------------------------------------------------------------------------

export class BrainWriter {
  private validators: PageValidator[] = [];
  private strictMode: StrictMode;
  private sourceId?: string;
  private readonly afterCommitBeforeFlushForTest?:
    (plans: readonly CanonicalFlushPlan[]) => void;
  private readonly afterPageReadBeforeMutationForTest?: (slug: string) => void;

  constructor(
    private engine: BrainEngine,
    opts: BrainWriterOptions = {},
  ) {
    this.strictMode = opts.strictMode ?? 'lint';
    this.sourceId = opts.sourceId;
    this.afterCommitBeforeFlushForTest = opts._afterCommitBeforeFlushForTest;
    this.afterPageReadBeforeMutationForTest =
      opts._afterPageReadBeforeMutationForTest;
  }

  register(validator: PageValidator): void {
    this.validators.push(validator);
  }

  /**
   * Run `fn` inside an engine transaction. On success, run validators across
   * all touched slugs. If strict mode + any error-severity finding → rollback.
   * Validators never run against pages with `validate: false` frontmatter
   * (grandfathered pages opt out until `gbrain integrity` repairs them).
   */
  async transaction<T>(fn: (tx: WriteTx) => Promise<T>, ctx: ResolverContext): Promise<{ result: T; report: ValidationReport }> {
    const strict = this.strictMode;
    const validators = this.validators;

    let report: ValidationReport | null = null;

    const strictSourceId = this.sourceId;
    let canonicalPages: CanonicalFlushPlan[] = [];
    const txResult = await this.engine.transaction(async (txEngine) => {
      const tx = new WriteTxImpl(
        txEngine,
        ctx,
        strictSourceId,
        this.afterPageReadBeforeMutationForTest,
      );
      const result = await fn(tx);

      // Validators run before the outer transaction commits.
      if (strict !== 'off') {
        report = await runValidators(txEngine, validators, tx.touchedSlugs, {
          sourceId: strictSourceId ?? 'default',
        });
        // `ctx.logger.info` would be nice but keep validator behavior uniform
        // regardless of strict/lint mode. Caller inspects the report.
        if (strict === 'strict' && report.errorCount > 0) {
          throw new WriteError('validation_failed', `BrainWriter: ${report.errorCount} validator error(s) — transaction rolled back`, report.findings);
        }
      }

      canonicalPages = [...tx.canonicalPages.values()]
        .sort((a, b) => a.slug.localeCompare(b.slug));
      return result;
    }); // COMMITTED; validator rollback exits before any file sink.

    this.afterCommitBeforeFlushForTest?.(canonicalPages);

    const failures: Array<{ slug: string; outcome: WriteThroughResult }> = [];
    for (const expected of canonicalPages) {
      if (expected.mode === 'not_projected') continue;
      try {
        await withPutPageOperationLock(
          this.engine,
          strictSourceId ?? 'default',
          expected.slug,
          async () => {
            const sourceId = strictSourceId ?? 'default';
            const before = await loadCanonicalProjection(
              this.engine, sourceId, expected.slug,
            );
            if (
              !before
              || !projectionIsFresh(before)
              || before.sha256 !== expected.projectionSha256
              || before.sizeBytes !== expected.projectionSizeBytes
            ) {
              failures.push({
                slug: expected.slug,
                outcome: { written: false, error: 'projection_moved_before_file_flush' },
              });
              return;
            }
            if (await isWriteThroughDisabled(this.engine)) {
              failures.push({
                slug: expected.slug,
                outcome: { written: false, error: 'projection_mode_moved_after_commit' },
              });
              return;
            }
            const target = await resolvePageWriteTarget(this.engine, expected.slug, sourceId);
            if (!target.ok) {
              failures.push({
                slug: expected.slug,
                outcome: { written: false, skipped: target.skipped },
              });
              return;
            }
            if (target.filePath !== expected.filePath) {
              failures.push({
                slug: expected.slug,
                outcome: { written: false, error: 'projection_target_moved_after_commit' },
              });
              return;
            }
            const currentTargetSha256 = existsSync(target.filePath)
              ? sha256Utf8(readFileSync(target.filePath))
              : null;
            if (currentTargetSha256 !== expected.expectedTargetSha256) {
              failures.push({
                slug: expected.slug,
                outcome: { written: false, error: 'canonical_file_preimage_moved' },
              });
              return;
            }
            const outcome = await writePageThrough(this.engine, expected.slug, {
              sourceId,
              expectedPath: expected.filePath,
              expectedTargetSha256: expected.expectedTargetSha256,
            });
            const after = await loadCanonicalProjection(
              this.engine, sourceId, expected.slug,
            );
            let fileMatches = false;
            if (outcome.written && outcome.path === target.filePath) {
              const bytes = readFileSync(target.filePath);
              fileMatches = sha256Utf8(bytes) === expected.projectionSha256
                && bytes.length === expected.projectionSizeBytes;
            }
            if (
              !outcome.written
              || !after
              || !projectionIsFresh(after)
              || after.sha256 !== expected.projectionSha256
              || !fileMatches
            ) failures.push({ slug: expected.slug, outcome });
          },
          { timeoutMs: 5_000 },
        );
      } catch (error) {
        failures.push({
          slug: expected.slug,
          outcome: {
            written: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (failures.length > 0) {
      throw new WriteError(
        'partial_write',
        `BrainWriter committed store rows but canonical file verification failed: ${JSON.stringify(failures)}`,
      );
    }
    return { result: txResult, report: report ?? emptyReport() };
  }

  /** Testing hook: set strict mode without re-instantiating. */
  setStrictMode(mode: StrictMode): void {
    this.strictMode = mode;
  }

  get registeredValidators(): string[] {
    return this.validators.map(v => v.id);
  }
}

// ---------------------------------------------------------------------------
// Validation runner
// ---------------------------------------------------------------------------

async function runValidators(
  engine: BrainEngine,
  validators: PageValidator[],
  touchedSlugs: Set<string>,
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<ValidationReport> {
  const findings: ValidationFinding[] = [];
  const sourceOpts = scope.sourceIds && scope.sourceIds.length > 0
    ? { sourceIds: scope.sourceIds }
    : scope.sourceId
      ? { sourceId: scope.sourceId }
      : undefined;

  for (const slug of touchedSlugs) {
    const page = await engine.getPage(slug, sourceOpts);
    if (!page) continue; // could have been deleted in this tx

    // Grandfather opt-out
    if (page.frontmatter?.validate === false) continue;

    const ctx: PageValidationContext = {
      slug,
      type: page.type,
      compiledTruth: page.compiled_truth,
      timeline: page.timeline,
      frontmatter: page.frontmatter ?? {},
      engine,
      sourceId: scope.sourceId,
      sourceIds: scope.sourceIds,
    };

    for (const v of validators) {
      const out = await v.validate(ctx);
      for (const f of out) findings.push(f);
    }
  }

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;

  return {
    findings,
    errorCount,
    warningCount,
    touchedSlugs: [...touchedSlugs],
  };
}

function emptyReport(): ValidationReport {
  return { findings: [], errorCount: 0, warningCount: 0, touchedSlugs: [] };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export { SlugRegistry } from './slug-registry.ts';
export type { CreateSlugInput, CreatedSlug } from './slug-registry.ts';
export * from './scaffold.ts';
