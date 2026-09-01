/**
 * Tags operation cluster — pure move from operations.ts (v0.46.x tranche 1).
 * Op consts stay module-private; `tagsOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts } from './context.ts';
import { withPutPageOperationLock } from './put-page-lock.ts';
import { persistCanonicalProjectionFromRow } from '../page-canonical.ts';
import { verifyOrRepairPageFile } from '../write-through.ts';
import type { BrainEngine } from '../engine.ts';

async function mutateTagAndProject(
  ctx: OperationContext,
  slug: string,
  mutate: (tx: BrainEngine, sourceId: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const sourceId = ctx.sourceId ?? 'default';
  return withPutPageOperationLock(ctx.engine, sourceId, slug, async () => {
    await ctx.engine.transaction(async (tx) => {
      await mutate(tx, sourceId);
      await persistCanonicalProjectionFromRow(tx, sourceId, slug);
    });
    const projection = await verifyOrRepairPageFile(ctx.engine, slug, '', {
      sourceId,
      logger: ctx.logger,
    });
    const notProjected = projection.file_status === 'not_projected';
    const healthy = projection.file_status === 'healthy' || projection.skipped === 'unchanged';
    const partial = !notProjected && !healthy && projection.file_status === 'repair_failed';
    return {
      status: partial ? 'partial' : 'ok',
      write_through: projection,
      file_status: projection.file_status,
      ...(partial ? { partial: true } : {}),
    };
  });
}

// --- Tags ---

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true, description: "Slug of the page to tag, e.g. 'people/alice-example'." },
    tag: { type: 'string', required: true, description: "Tag to add — a plain string like 'founder' or 'follow-up', not a slug." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'add_tag');
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    const slug = p.slug as string;
    const tag = p.tag as string;
    return mutateTagAndProject(ctx, slug, async (tx, sourceId) => {
      await tx.addTag(slug, tag, { sourceId });
    });
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page to untag.' },
    tag: { type: 'string', required: true, description: 'Tag to remove (exact match against the tags get_tags returns).' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    enforceClientSlugFence(ctx, p.slug as string, 'remove_tag');
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    const slug = p.slug as string;
    const tag = p.tag as string;
    return mutateTagAndProject(ctx, slug, async (tx, sourceId) => {
      await tx.removeTag(slug, tag, { sourceId });
    });
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the page whose tags to list.' },
  },
  handler: async (ctx, p) => {
    // #2200: route through sourceScopeOpts so a federated read grant
    // (ctx.auth.allowedSources) reaches the engine, not just scalar ctx.sourceId.
    // Was `ctx.sourceId ? {sourceId} : {}` — a federated client got '{}' →
    // engine fell back to 'default' (functionality gap + cross-source leak).
    const sourceOpts = sourceScopeOpts(ctx);
    return ctx.engine.getTags(p.slug as string, sourceOpts);
  },
  scope: 'read',
  cliHints: { name: 'tags', positional: ['slug'] },
};


// Ops in EXACTLY the canonical `operations` array order.
export const tagsOperations: Operation[] = [add_tag, remove_tag, get_tags];
