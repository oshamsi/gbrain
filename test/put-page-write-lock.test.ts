import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PageWriteConflictError } from '../src/core/page-cas.ts';
import { DuplicatePageIdentityError, importFromContent } from '../src/core/import-file.ts';
import { contentHash, contentHashLegacy } from '../src/core/utils.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';
import { putPageDbLockId, withPutPageOperationLock } from '../src/core/ops/put-page-lock.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
const putPageOp = operations.find(operation => operation.name === 'put_page')!;

function pageBody(text: string) {
  return {
    type: 'note' as const,
    title: 'CAS page',
    compiled_truth: text,
    timeline: '',
    frontmatter: {},
  };
}

function taskContent(rows: string): string {
  return `---\ntype: project\ntitle: Tasks\n---\n\n# Tasks\n\n## P1 — Today\n${rows}\n\n## Deferred\n\n## Completed\n`;
}

const task = (id: string, text: string, checked = false) =>
  `- [${checked ? 'x' : ' '}] <!-- id: ${id} --> ${text}`;

function context(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

async function expectOperationError(
  params: Record<string, unknown>,
): Promise<OperationError> {
  try {
    await putPageOp.handler(context(), params);
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected put_page operation to reject');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('sync.write_through', 'false');
  resetGateway();
});

describe('putPage engine compare-and-swap', () => {
  test('first stale-reader write wins and the second is rejected', async () => {
    const seeded = await engine.putPage('notes/concurrent', pageBody('base'));
    const expected = seeded.content_hash!;

    await engine.putPage('notes/concurrent', pageBody('writer one'), {
      expectedContentHash: expected,
    });
    await expect(
      engine.putPage('notes/concurrent', pageBody('writer two'), {
        expectedContentHash: expected,
      }),
    ).rejects.toBeInstanceOf(PageWriteConflictError);

    expect((await engine.getPage('notes/concurrent'))?.compiled_truth).toBe('writer one');
  });

  test('an expected hash never creates a missing or wrong-source row', async () => {
    const seeded = await engine.putPage('notes/source-bound', pageBody('default source'));
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('team-x', 'team-x')");

    await expect(
      engine.putPage('notes/missing', pageBody('must not create'), {
        expectedContentHash: seeded.content_hash!,
      }),
    ).rejects.toBeInstanceOf(PageWriteConflictError);
    await expect(
      engine.putPage('notes/source-bound', pageBody('wrong target'), {
        sourceId: 'team-x',
        expectedContentHash: seeded.content_hash!,
      }),
    ).rejects.toBeInstanceOf(PageWriteConflictError);

    expect(await engine.getPage('notes/missing')).toBeNull();
    expect(await engine.getPage('notes/source-bound', { sourceId: 'team-x' })).toBeNull();
  });

  test('an expected-hash write cannot resurrect a concurrently soft-deleted row', async () => {
    const seeded = await engine.putPage('notes/deleted', pageBody('base'));
    await engine.softDeletePage('notes/deleted', { sourceId: 'default' });

    await expect(engine.putPage('notes/deleted', pageBody('resurrected'), {
      expectedContentHash: seeded.content_hash!,
    })).rejects.toBeInstanceOf(PageWriteConflictError);

    const tombstone = await engine.getPage('notes/deleted', { includeDeleted: true });
    expect(tombstone?.compiled_truth).toBe('base');
    expect(tombstone?.deleted_at).not.toBeNull();
  });

  test('CAS same-hash fences with compare-only (no version snapshot); legacy-refresh CAS still writes', async () => {
    const content = '---\ntype: note\ntitle: CAS page\n---\n\nbase';
    const first = await importFromContent(engine, 'notes/same-hash', content, { noEmbed: true });
    const snapshot = await engine.getPage('notes/same-hash');
    const same = await importFromContent(engine, 'notes/same-hash', content, {
      noEmbed: true,
      expectedContentHash: snapshot!.content_hash!,
    });
    expect(first.status).toBe('imported');
    expect(same.status).toBe('skipped');
    expect(same.skip_reason).toBe('unchanged');
    expect((await engine.getVersions('notes/same-hash')).length).toBe(0);

    const legacyContent = '---\ntype: note\ntitle: Legacy\n---\n\nlegacy body';
    const legacyHash = contentHashLegacy({
      title: 'Legacy', type: 'note', compiled_truth: 'legacy body', timeline: '', frontmatter: {},
    });
    await engine.putPage('notes/legacy', {
      ...pageBody('legacy body'), title: 'Legacy', content_hash: legacyHash,
    });
    const legacy = await importFromContent(engine, 'notes/legacy', legacyContent, {
      noEmbed: true,
      expectedContentHash: legacyHash,
    });
    expect(legacy.status).toBe('imported');
    expect((await engine.getVersions('notes/legacy')).length).toBe(1);
    expect((await engine.getPage('notes/legacy'))?.content_hash).not.toBe(legacyHash);
  });

  test('an expected-hash import rejects another live page external identity without mutating either page', async () => {
    const incomingHash = contentHash({
      type: 'note', title: 'Target', compiled_truth: 'target update', timeline: '',
      frontmatter: { id: 'shared-external-id' }, tags: [],
    });
    // Lower-id hash-only decoy must not mask the later true identity owner.
    await engine.putPage('notes/hash-only-decoy', {
      ...pageBody('unrelated decoy'),
      frontmatter: { id: 'different-external-id' },
      content_hash: incomingHash,
    });
    await engine.putPage('notes/external-owner', {
      ...pageBody('other page'), frontmatter: { id: 'shared-external-id' },
    });
    const target = await engine.putPage('notes/target', pageBody('target base'));
    await expect(importFromContent(
      engine,
      'notes/target',
      '---\ntype: note\ntitle: Target\nid: shared-external-id\n---\n\ntarget update',
      { noEmbed: true, expectedContentHash: target.content_hash! },
    )).rejects.toBeInstanceOf(DuplicatePageIdentityError);

    expect((await engine.getPage('notes/target'))?.compiled_truth).toBe('target base');
    expect((await engine.getPage('notes/external-owner'))?.compiled_truth).toBe('other page');
    expect((await engine.getPage('notes/hash-only-decoy'))?.compiled_truth).toBe('unrelated decoy');
    expect(await engine.getVersions('notes/target')).toHaveLength(0);
    expect(await engine.getChunks('notes/target')).toHaveLength(0);
  });

  test('same-hash CAS still rejects a colliding live external identity', async () => {
    const content = '---\ntype: note\ntitle: CAS page\nid: shared-on-retry\n---\n\nbase';
    const first = await importFromContent(engine, 'notes/same-hash-id', content, { noEmbed: true });
    expect(first.status).toBe('imported');
    await engine.putPage('notes/later-owner', {
      ...pageBody('other page'), frontmatter: { id: 'shared-on-retry' },
    });
    const snapshot = await engine.getPage('notes/same-hash-id');
    await expect(importFromContent(engine, 'notes/same-hash-id', content, {
      noEmbed: true,
      expectedContentHash: snapshot!.content_hash!,
    })).rejects.toBeInstanceOf(DuplicatePageIdentityError);
    expect((await engine.getPage('notes/same-hash-id'))?.compiled_truth).toBe('base');
    expect((await engine.getPage('notes/later-owner'))?.compiled_truth).toBe('other page');
  });

  test('CAS read-back treats a different row id as integrity failure, not supersession', async () => {
    const target = await engine.putPage('notes/readback-target', pageBody('base'));
    const wrong = await engine.putPage('notes/wrong-row', pageBody('wrong row'));
    const originalGetPage = engine.getPage.bind(engine);
    let reads = 0;
    engine.getPage = (async (slug: string, opts?: Parameters<typeof engine.getPage>[1]) => {
      if (slug !== 'notes/readback-target') return originalGetPage(slug, opts);
      reads += 1;
      if (reads === 2) {
        return {
          ...wrong,
          slug,
          content_hash: 'f'.repeat(64),
          updated_at: new Date(target.updated_at.getTime() + 5_000),
        };
      }
      return originalGetPage(slug, opts);
    }) as typeof engine.getPage;

    try {
      await expect(importFromContent(
        engine,
        'notes/readback-target',
        '---\ntype: note\ntitle: Target\n---\n\nwriter A',
        { noEmbed: true, expectedContentHash: target.content_hash! },
      )).rejects.toThrow(/wrong page row/);
    } finally {
      engine.getPage = originalGetPage;
    }
  });
});

describe('put_page operation write lock and ops/tasks guard', () => {
  test('preserves put_page slug grammar for dots, underscores, and normalization', async () => {
    const result = await putPageOp.handler(context(), {
      slug: 'Notes/release_notes.v1',
      content: '---\ntype: note\ntitle: Release Notes\n---\n\nbody',
    }) as Record<string, unknown>;
    expect(result.slug).toBe('notes/release_notes.v1');
    expect((await engine.getPage('notes/release_notes.v1'))?.compiled_truth).toBe('body');
  });

  test('page-lock timeout maps to a retryable write_conflict', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gbrain-put-page-lock-'));
    const held = await acquirePageLock('notes/busy', { lockRoot });
    try {
      await expect(withPutPageOperationLock(
        engine,
        'default',
        'Notes/Busy',
        async () => 'unreachable',
        { lockRoot, timeoutMs: 20, pollMs: 5 },
      )).rejects.toMatchObject({ code: 'write_conflict' });
    } finally {
      await held!.release();
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test('database row mutex serializes writers even when filesystem lock roots differ', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'gbrain-put-db-lock-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'gbrain-put-db-lock-b-'));
    let markEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = withPutPageOperationLock(
      engine,
      'default',
      'notes/db-authoritative',
      async () => {
        markEntered();
        await release;
        return 'first';
      },
      { lockRoot: firstRoot, timeoutMs: 1_000, dbPollMs: 5 },
    );

    try {
      await entered;
      await expect(withPutPageOperationLock(
        engine,
        'default',
        'notes/db-authoritative',
        async () => 'second',
        { lockRoot: secondRoot, timeoutMs: 25, dbPollMs: 5 },
      )).rejects.toMatchObject({ code: 'write_conflict' });
    } finally {
      releaseFirst();
      await expect(first).resolves.toBe('first');
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  test('lost database lease after work reports an ambiguous outcome, never a blind-retry conflict', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gbrain-put-db-lock-lost-'));
    const lockId = putPageDbLockId('default', 'notes/lost-db-lease');
    try {
      await expect(withPutPageOperationLock(
        engine,
        'default',
        'notes/lost-db-lease',
        async () => {
          await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [lockId]);
          return 'work-ran';
        },
        { lockRoot, timeoutMs: 1_000 },
      )).rejects.toMatchObject({
        code: 'write_outcome_unknown',
        suggestion: expect.stringContaining('Do not retry blindly'),
      });
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test('a transient fenced-release failure cannot mask a verified work result', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'gbrain-put-db-lock-release-'));
    const lockId = putPageDbLockId('default', 'notes/release-cleanup');
    const rawDb = (engine as unknown as {
      db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
    }).db;
    const originalQuery = rawDb.query.bind(rawDb);
    let failRelease = false;
    rawDb.query = (async (sql: string, params?: unknown[]) => {
      if (failRelease && /^DELETE FROM gbrain_cycle_locks WHERE id/.test(sql.trim())) {
        throw new Error('simulated release transport failure');
      }
      return originalQuery(sql, params);
    }) as typeof rawDb.query;

    try {
      await expect(withPutPageOperationLock(
        engine,
        'default',
        'notes/release-cleanup',
        async () => {
          failRelease = true;
          return 'verified-result';
        },
        { lockRoot, timeoutMs: 1_000 },
      )).resolves.toBe('verified-result');
    } finally {
      rawDb.query = originalQuery;
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [lockId]);
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test('serializes the full same-page operation before the stale writer preflight', async () => {
    const slug = 'notes/serialized';
    const seeded = await engine.putPage(slug, pageBody('base'));
    const originalGetPage = engine.getPage.bind(engine);
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    let paused = false;
    engine.getPage = (async (requested: string, opts?: Parameters<typeof engine.getPage>[1]) => {
      if (requested === slug && !paused) {
        paused = true;
        markEntered();
        await release;
      }
      return originalGetPage(requested, opts);
    }) as typeof engine.getPage;

    const first = putPageOp.handler(context(), {
      slug, content: '---\ntype: note\ntitle: First\n---\n\nfirst writer',
      expected_content_hash: seeded.content_hash,
    });
    await entered;
    const second = putPageOp.handler(context(), {
      slug, content: '---\ntype: note\ntitle: Second\n---\n\nsecond writer',
      expected_content_hash: seeded.content_hash,
    }).catch(error => error as OperationError);
    releaseFirst();

    try {
      await expect(first).resolves.toMatchObject({ status: 'created_or_updated' });
      await expect(second).resolves.toMatchObject({ code: 'write_conflict' });
    } finally {
      engine.getPage = originalGetPage;
    }
    expect((await engine.getPage(slug))?.compiled_truth).toBe('first writer');
  });

  test('maps a deliberate stale-read second write to write_conflict', async () => {
    await putPageOp.handler(context(), {
      slug: 'notes/operation-cas',
      content: '---\ntype: note\ntitle: CAS\n---\n\nbase',
    });
    const snapshot = await engine.getPage('notes/operation-cas');

    await putPageOp.handler(context(), {
      slug: 'notes/operation-cas',
      content: '---\ntype: note\ntitle: CAS\n---\n\nwriter one',
      expected_content_hash: snapshot!.content_hash,
    });
    const error = await expectOperationError({
      slug: 'notes/operation-cas',
      content: '---\ntype: note\ntitle: CAS\n---\n\nwriter two',
      expected_content_hash: snapshot!.content_hash,
    });

    expect(error.code).toBe('write_conflict');
    expect(error.suggestion).toContain('include_content: true');
    expect((await engine.getPage('notes/operation-cas'))?.compiled_truth).toContain('writer one');
  });

  test('maps a CAS external-id collision to duplicate_identity without exposing the owner slug', async () => {
    await engine.putPage('private/existing-owner', {
      ...pageBody('owner'), frontmatter: { id: 'external-identity-1' },
    });
    const target = await engine.putPage('notes/new-owner', pageBody('target base'));
    const error = await expectOperationError({
      slug: 'notes/new-owner',
      expected_content_hash: target.content_hash,
      content: '---\ntype: note\ntitle: Target\nid: external-identity-1\n---\n\nconflicting update',
    });

    expect(error.code).toBe('duplicate_identity');
    expect(error.message).not.toContain('private/existing-owner');
    expect((await engine.getPage('notes/new-owner'))?.compiled_truth).toBe('target base');
  });

  test('atomic operation CAS closes the preflight-to-transaction race for unchanged incoming content', async () => {
    const slug = 'meetings/toctou-unchanged';
    const seeded = await engine.putPage(slug, pageBody('base'));
    const originalGetPage = engine.getPage.bind(engine);
    let reads = 0;
    engine.getPage = (async (requested: string, opts?: Parameters<typeof engine.getPage>[1]) => {
      if (requested !== slug) return originalGetPage(requested, opts);
      reads += 1;
      const snapshot = await originalGetPage(requested, opts);
      if (reads === 2) {
        await engine.putPage(slug, pageBody('rival won'), {
          expectedContentHash: snapshot!.content_hash!,
        });
      }
      return snapshot;
    }) as typeof engine.getPage;

    let error: OperationError;
    try {
      error = await expectOperationError({
        slug,
        expected_content_hash: seeded.content_hash,
        content: '---\ntype: note\ntitle: CAS page\n---\n\nbase',
      });
    } finally {
      engine.getPage = originalGetPage;
    }

    expect(error.code).toBe('write_conflict');
    expect((await engine.getPage(slug))?.compiled_truth).toBe('rival won');
    expect(await engine.getVersions(slug)).toHaveLength(0);
    expect(await engine.getChunks(slug)).toHaveLength(0);
  });

  test('atomic operation CAS closes the preflight-to-transaction race without side effects', async () => {
    const slug = 'meetings/toctou';
    const seeded = await engine.putPage(slug, pageBody('base'));
    const originalGetPage = engine.getPage.bind(engine);
    let reads = 0;
    engine.getPage = (async (requested: string, opts?: Parameters<typeof engine.getPage>[1]) => {
      if (requested !== slug) return originalGetPage(requested, opts);
      reads += 1;
      const snapshot = await originalGetPage(requested, opts);
      if (reads === 2) {
        await engine.putPage(slug, pageBody('rival won'), {
          expectedContentHash: snapshot!.content_hash!,
        });
      }
      return snapshot;
    }) as typeof engine.getPage;

    let error: OperationError;
    try {
      error = await expectOperationError({
        slug,
        expected_content_hash: seeded.content_hash,
        content: [
          '---', 'type: note', 'title: Failed writer', 'aliases: [failed-alias]', '---', '',
          'failed body citing code/src/core/engine.ts', '', '<!-- timeline -->',
          '- 2026-08-25: failed timeline hook',
        ].join('\n'),
      });
    } finally {
      engine.getPage = originalGetPage;
    }

    expect(error.code).toBe('write_conflict');
    expect((await engine.getPage(slug))?.compiled_truth).toBe('rival won');
    expect(await engine.getVersions(slug)).toHaveLength(0);
    expect(await engine.getChunks(slug)).toHaveLength(0);
    expect((await engine.resolveAliases(['failed-alias'], { sourceId: 'default' })).get('failed-alias')).toBeUndefined();
    const sideEffects = await engine.executeRaw<Record<string, number>>(`
      SELECT
        (SELECT COUNT(*)::int FROM page_links) AS links,
        (SELECT COUNT(*)::int FROM timeline_entries) AS timeline,
        (SELECT COUNT(*)::int FROM minion_jobs) AS jobs
    `);
    expect(sideEffects[0]).toEqual({ links: 0, timeline: 0, jobs: 0 });
  });

  test('a newer equal-millisecond commit at CAS read-back supersedes stale parsed-content post-hooks', async () => {
    const slug = 'meetings/superseded';
    const seeded = await engine.putPage(slug, pageBody('base'));
    await engine.setConfig('auto_link', 'true');
    await engine.setConfig('auto_timeline', 'true');
    const originalGetPage = engine.getPage.bind(engine);
    let reads = 0;
    engine.getPage = (async (requested: string, opts?: Parameters<typeof engine.getPage>[1]) => {
      if (requested !== slug) return originalGetPage(requested, opts);
      reads += 1;
      const page = await originalGetPage(requested, opts);
      if (reads === 3) {
        await engine.putPage(slug, { ...pageBody('writer B'), title: 'Writer B' }, {
          expectedContentHash: page!.content_hash!,
        });
        await engine.executeRaw(
          'UPDATE pages SET updated_at = $1::timestamptz WHERE source_id = $2 AND slug = $3',
          [page!.updated_at.toISOString(), 'default', slug],
        );
        return originalGetPage(requested, opts);
      }
      return page;
    }) as typeof engine.getPage;

    let result: Record<string, unknown>;
    try {
      result = await putPageOp.handler({ ...context(), remote: false }, {
        slug,
        expected_content_hash: seeded.content_hash,
        content: [
          '---', 'type: note', 'title: Writer A', 'aliases: [writer-a-alias]', '---', '',
          'writer A body', '', '<!-- timeline -->', '- 2026-08-25: writer A event',
        ].join('\n'),
      }) as Record<string, unknown>;
    } finally {
      engine.getPage = originalGetPage;
    }

    expect(result.status).toBe('created_or_updated');
    expect(result.superseded_after_commit).toBe(true);
    expect(result.auto_links).toEqual({ skipped: 'superseded_after_commit' });
    expect(result.auto_timeline).toEqual({ skipped: 'superseded_after_commit' });
    expect(result.facts_backstop).toEqual({ skipped: 'superseded_after_commit' });
    expect(result.chronicle_backstop).toEqual({ skipped: 'superseded_after_commit' });
    expect((await engine.getPage(slug))?.compiled_truth).toBe('writer B');
    expect((await engine.resolveAliases(['writer-a-alias'], { sourceId: 'default' })).get('writer-a-alias')).toBeUndefined();
  });

  test('requires the hash and rejects an unexplained active-id drop', async () => {
    const initial = taskContent([
      task('t-20260115-01', 'keep one'),
      task('t-20260115-02', 'keep two'),
    ].join('\n'));
    await putPageOp.handler(context(), { slug: 'ops/tasks', content: initial });
    const snapshot = await engine.getPage('ops/tasks');

    const missingHash = await expectOperationError({
      slug: 'ops/tasks',
      content: initial,
    });
    expect(missingHash.code).toBe('precondition_required');

    const dropped = await expectOperationError({
      slug: 'ops/tasks',
      content: taskContent(task('t-20260115-02', 'keep two')),
      expected_content_hash: snapshot!.content_hash,
    });
    expect(dropped.code).toBe('task_guard_failed');
    expect(dropped.message).toContain('t-20260115-01');
    expect((await engine.getPage('ops/tasks'))?.compiled_truth).toContain('keep one');
  });

  test('YAML and fenced-code decoys cannot satisfy task identity retention', async () => {
    const initial = taskContent(task('t-20260115-01', 'must remain'));
    await putPageOp.handler(context(), { slug: 'ops/tasks', content: initial });
    const snapshot = await engine.getPage('ops/tasks');
    const decoys = [
      [
        '---', 'type: project', 'title: Tasks', 'decoy: |',
        `  ${task('t-20260115-01', 'yaml example')}`, '---', '', '# Tasks', '', '## P1 — Today', '',
      ].join('\n'),
      taskContent(`\`\`\`md\n${task('t-20260115-01', 'fenced example')}\n\`\`\``),
    ];

    for (const content of decoys) {
      const error = await expectOperationError({
        slug: 'ops/tasks', content, expected_content_hash: snapshot!.content_hash,
      });
      expect(error.code).toBe('task_guard_failed');
      expect(error.message).toContain('t-20260115-01');
    }
    expect((await engine.getPage('ops/tasks'))?.compiled_truth).toContain('must remain');
  });

  test('rejects duplicate ids and accepts explicit complete/defer/remove transitions', async () => {
    const initial = taskContent([
      task('t-20260115-01', 'complete me'),
      task('t-20260115-02', 'defer me'),
      task('t-20260115-03', 'remove me'),
    ].join('\n'));
    await putPageOp.handler(context(), { slug: 'ops/tasks', content: initial });
    let snapshot = await engine.getPage('ops/tasks');

    const duplicate = await expectOperationError({
      slug: 'ops/tasks',
      content: taskContent([
        task('t-20260115-01', 'one'),
        task('t-20260115-01', 'duplicate'),
      ].join('\n')),
      expected_content_hash: snapshot!.content_hash,
    });
    expect(duplicate.code).toBe('task_guard_failed');
    expect(duplicate.message).toContain('duplicate task id');

    const transitioned = [
      '---',
      'type: project',
      'title: Tasks',
      '---',
      '',
      '# Tasks',
      '',
      '## P1 — Today',
      '',
      '## Deferred',
      task('t-20260115-02', 'defer me (deferred until: 2026-02-01; reason: waiting)'),
      '',
      '## Completed',
      task('t-20260115-01', 'complete me (completed: 2026-01-16)', true),
      '',
    ].join('\n');
    await putPageOp.handler(context(), {
      slug: 'ops/tasks',
      content: transitioned,
      expected_content_hash: snapshot!.content_hash,
      removed_task_ids: ['t-20260115-03'],
    });
    snapshot = await engine.getPage('ops/tasks');
    expect(snapshot!.compiled_truth).toContain('completed: 2026-01-16');
    expect(snapshot!.compiled_truth).toContain('deferred until: 2026-02-01');
    expect(snapshot!.compiled_truth).not.toContain('t-20260115-03');
  });
});
