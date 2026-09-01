/**
 * Canonical-plane adversarial matrix (FIX ROUND 2 S5).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import {
  buildCanonicalPageProjection,
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  sha256Utf8,
} from '../src/core/page-canonical.ts';
import { runCanonicalPlaneConvergence } from '../src/core/page-plane-convergence.ts';
import {
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  redactFactsFenceForRemote,
  renderFactsTable,
} from '../src/core/facts-fence.ts';
import {
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
  redactTakesFenceForRemote,
  renderTakesFence,
  takesRedactedPlaceholder,
} from '../src/core/takes-fence.ts';
import { registerSelfWrite, _resetSelfWriteGuardForTest } from '../src/core/self-write-guard.ts';
import { createFileWatcherSource } from '../src/core/ingestion/sources/file-watcher.ts';
import { IngestionTestHarness } from '../src/core/ingestion/test-harness.ts';
import type { FSWatcher } from 'chokidar';

let engine: PGLiteEngine;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  }).trim();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  _resetSelfWriteGuardForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-adv-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'seed.md'), 'seed\n');
  execSync('git add -A && git commit -m init', { cwd: repo, stdio: 'pipe' });
  await engine.setConfig('sync.repo_path', repo);
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1, last_commit = $2 WHERE id = 'default'`,
    [repo, git(repo, 'rev-parse', 'HEAD')],
  );
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;
const getPage = operations.find((o) => o.name === 'get_page')!;
const addTag = operations.find((o) => o.name === 'add_tag')!;
const fetchPage = operations.find((op) => op.name === 'fetch')!;

describe('canonical-plane adversarial matrix', () => {
  test('remote get/put round-trip restores private Facts and Takes', async () => {
    const slug = 'inbox/privacy-rt';
    const facts = renderFactsTable([
      {
        rowNum: 1, claim: 'Public founding year', kind: 'fact', confidence: 1,
        visibility: 'world', notability: 'high', active: true,
      },
      {
        rowNum: 2, claim: 'Private salary band', kind: 'fact', confidence: 0.9,
        visibility: 'private', notability: 'medium', active: true,
      },
    ]);
    const takes = renderTakesFence([
      {
        rowNum: 1, claim: 'Will ship this quarter', kind: 'bet', holder: 'brain',
        weight: 0.7, active: true,
      },
    ]);
    const content = `---\ntitle: Privacy\n---\n\nintro\n\n${facts}\n\n${takes}\n`;
    await putPage.handler(makeCtx({ remote: false }), { slug, content });
    const remote = await getPage.handler(makeCtx({ remote: true }), { slug, include_content: true }) as {
      content: string;
      content_redacted: boolean;
    };
    expect(remote.content_redacted).toBe(true);
    expect(remote.content).toContain('Public founding year');
    expect(remote.content).not.toContain('Private salary band');
    expect(remote.content).not.toContain('Will ship this quarter');
    const beforeRoundTrip = (await loadCanonicalProjection(
      engine, 'default', slug,
    ))!.content;
    // The production fixture has a marker-only Takes fence: no heading survives
    // for a reinsertion heuristic. The response must retain exactly one slot.
    expect(beforeRoundTrip).toContain(TAKES_FENCE_BEGIN);
    expect(beforeRoundTrip).not.toContain('## Takes');
    expect(remote.content).not.toContain(TAKES_FENCE_BEGIN);
    const canonicalPage = await engine.getPage(slug, { sourceId: 'default' });
    const takesSlot = takesRedactedPlaceholder(canonicalPage!.compiled_truth);
    expect(remote.content.split(takesSlot)).toHaveLength(2);

    const fetched = await fetchPage.handler(makeCtx({ remote: true }), {
      id: slug,
    }) as { text: string };
    expect(fetched.text.split(takesSlot)).toHaveLength(2);
    expect(fetched.text).not.toContain(TAKES_FENCE_BEGIN);

    await putPage.handler(makeCtx({ remote: true }), {
      slug, content: remote.content,
    });
    const afterRoundTrip = (await loadCanonicalProjection(
      engine, 'default', slug,
    ))!.content;
    expect(afterRoundTrip).toBe(beforeRoundTrip);
    expect(fs.readFileSync(path.join(repo, `${slug}.md`), 'utf8'))
      .toBe(beforeRoundTrip);
    const trusted = await getPage.handler(makeCtx({ remote: false }), { slug, include_content: true }) as {
      content: string;
    };
    expect(trusted.content).toContain('Private salary band');
    expect(trusted.content).toContain('Will ship this quarter');
    const stored = await loadCanonicalProjection(engine, 'default', slug);
    expect(stored?.content).toContain('Private salary band');
    expect(fs.readFileSync(path.join(repo, `${slug}.md`), 'utf8')).toBe(stored!.content);

    const visibleAgain = await getPage.handler(makeCtx({ remote: true }), {
      slug, include_content: true,
    }) as { content: string };
    const beforeAttack = (await loadCanonicalProjection(engine, 'default', slug))!.content;

    const collidingFacts = renderFactsTable([{
      rowNum: 2,
      claim: 'Attacker replacement',
      kind: 'fact',
      confidence: 1,
      visibility: 'world',
      notability: 'high',
      active: true,
    }]);
    const collisionBody = visibleAgain.content.replace(
      /<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/,
      collidingFacts,
    );
    await expect(
      putPage.handler(makeCtx({ remote: true }), { slug, content: collisionBody }),
    ).rejects.toMatchObject({ code: 'write_conflict' });

    const attackerTakes = renderTakesFence([{
      rowNum: 99,
      claim: 'Attacker take',
      kind: 'bet',
      holder: 'brain',
      weight: 1,
      active: true,
    }]);
    await expect(
      putPage.handler(makeCtx({ remote: true }), {
        slug,
        content: `${visibleAgain.content}\n\n## Takes\n\n${attackerTakes}\n`,
      }),
    ).rejects.toMatchObject({ code: 'write_conflict' });

    // Missing/duplicated server placeholder and every malformed real fence fail
    // before any write. These pin the fail-closed parser path, not only attacks
    // that happen to contain a well-formed fence.
    for (const malformed of [
      visibleAgain.content.replace(takesSlot, ''),
      visibleAgain.content.replace(
        takesSlot,
        `${takesSlot}${takesSlot}`,
      ),
      `${visibleAgain.content}\n${FACTS_FENCE_BEGIN}\n| broken |\n`,
      visibleAgain.content.replace(
        takesSlot,
        `${TAKES_FENCE_BEGIN}\n| broken |\n`,
      ),
    ]) {
      await expect(
        putPage.handler(makeCtx({ remote: true }), { slug, content: malformed }),
      ).rejects.toMatchObject({ code: 'write_conflict' });
    }

    expect((await loadCanonicalProjection(engine, 'default', slug))!.content).toBe(beforeAttack);
    expect(fs.readFileSync(path.join(repo, `${slug}.md`), 'utf8')).toBe(beforeAttack);

    const privateCreate = `---\ntitle: Private Create\n---\n\n${renderFactsTable([{
      rowNum: 1, claim: 'secret create', kind: 'fact', confidence: 1,
      visibility: 'private', notability: 'high', active: true,
    }])}\n`;
    const takesCreate = `---\ntitle: Takes Create\n---\n\n${attackerTakes}\n`;
    for (const [newSlug, content] of [
      ['inbox/remote-private-create', privateCreate],
      ['inbox/remote-takes-create', takesCreate],
    ] as const) {
      await expect(putPage.handler(makeCtx({ remote: true }), {
        slug: newSlug, content,
      })).rejects.toMatchObject({ code: 'write_conflict' });
      expect(await engine.getPage(newSlug, { sourceId: 'default' })).toBeNull();
    }
  });

  test('remote fence redactors fail closed on multiple and malformed blocks', () => {
    const takeA = {
      rowNum: 1, claim: 'SECRET-A', kind: 'take', holder: 'brain',
      weight: 1, active: true,
    } as const;
    const worldFact = {
      rowNum: 1, claim: 'PUBLIC', kind: 'fact', confidence: 1,
      visibility: 'world', notability: 'medium', active: true,
    } as const;
    const privateFact = {
      rowNum: 2, claim: 'PRIVATE-SECOND-BLOCK', kind: 'fact', confidence: 1,
      visibility: 'private', notability: 'high', active: true,
    } as const;
    const oldLiteral = takesRedactedPlaceholder('some other canonical body');
    const twoTakes = `VISIBLE\n${renderTakesFence([{ ...takeA, claim: 'SECRET-A' }])}\n`
      + `${renderTakesFence([{ ...takeA, rowNum: 2, claim: 'SECRET-B' }])}\n`;
    const takesRedacted = redactTakesFenceForRemote(twoTakes);
    expect(takesRedacted).not.toContain('SECRET-A');
    expect(takesRedacted).not.toContain('SECRET-B');

    const placeholderCollisionBody = `VISIBLE ${oldLiteral}\n${renderTakesFence([takeA])}\n`;
    const currentSlot = takesRedactedPlaceholder(placeholderCollisionBody);
    const collisionRedacted = redactTakesFenceForRemote(placeholderCollisionBody);
    expect(collisionRedacted).toContain(oldLiteral);
    expect(collisionRedacted.split(currentSlot)).toHaveLength(2);

    const twoFacts = `${renderFactsTable([worldFact])}\n${renderFactsTable([privateFact])}`;
    const factsRedacted = redactFactsFenceForRemote(twoFacts);
    expect(factsRedacted).not.toContain(privateFact.claim);

    for (const malformedTakes of [
      `TAKES-PREFIX-SECRET\n${TAKES_FENCE_END}`,
      `${TAKES_FENCE_END}\nTAKES-MIDDLE-SECRET\n${TAKES_FENCE_BEGIN}`,
    ]) {
      const redacted = redactTakesFenceForRemote(malformedTakes);
      expect(redacted).not.toContain('SECRET');
      expect(redacted).toBe(takesRedactedPlaceholder(malformedTakes));
    }
    for (const malformedFacts of [
      `FACTS-PREFIX-SECRET\n${FACTS_FENCE_END}`,
      `${FACTS_FENCE_END}\nFACTS-MIDDLE-SECRET\n${FACTS_FENCE_BEGIN}`,
    ]) {
      const redacted = redactFactsFenceForRemote(malformedFacts);
      expect(redacted).not.toContain('SECRET');
      expect(redacted).toBe('');
    }
  });

  test('--yes rewrites, one literal-path commit, then idempotent zero-change', async () => {
    await importFromContent(engine, 'inbox/c', '---\ntitle: C\n---\n\nthree\n', {
      noEmbed: true, sourceId: 'default', sourcePath: 'inbox/c.md',
    });
    await writePageThrough(engine, 'inbox/c', { sourceId: 'default' });
    const file = path.join(repo, 'inbox/c.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('title: C', 'title: C\nextra: 1'));
    fs.writeFileSync(path.join(repo, 'unrelated.md'), 'leave me\n');
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const first = await runCanonicalPlaneConvergence(engine, { sourceId: 'default', yes: true });
    expect(first.exitCode).toBe(0);
    expect(first.report.rewritten).toBeGreaterThan(0);
    expect(first.report.commit.created).toBe(true);
    expect(first.report.post_verify_divergent).toBe(0);
    expect(first.report.commit.sha).not.toBe(beforeHead);
    const changed = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', first.report.commit.sha!);
    expect(changed.split('\n').filter(Boolean)).toEqual(['inbox/c.md']);
    expect(fs.readFileSync(path.join(repo, 'unrelated.md'), 'utf8')).toBe('leave me\n');
    const stored = await loadCanonicalProjection(engine, 'default', 'inbox/c');
    expect(fs.readFileSync(file, 'utf8')).toBe(stored!.content);
    expect(stored!.content).not.toContain('extra: 1');

    const second = await runCanonicalPlaneConvergence(engine, { sourceId: 'default', yes: true });
    expect(second.exitCode).toBe(0);
    expect(second.report.rewritten).toBe(0);
    expect(second.report.commit.created).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(first.report.commit.sha);
  });

  test('literal pathspecs do not commit glob-magic neighbors', async () => {
    const weird = ':(glob)*.md';
    await importFromContent(engine, 'inbox/glob', '---\ntitle: G\n---\n\nbody\n', {
      noEmbed: true, sourceId: 'default', sourcePath: weird,
    });
    await engine.executeRaw(
      `UPDATE pages SET source_path = $1 WHERE slug = $2 AND source_id = $3`,
      [weird, 'inbox/glob', 'default'],
    );
    await persistCanonicalProjectionFromRow(engine, 'default', 'inbox/glob');
    fs.writeFileSync(path.join(repo, weird), 'stale\n');
    fs.writeFileSync(path.join(repo, 'unrelated.md'), 'nope\n');
    const { report, exitCode } = await runCanonicalPlaneConvergence(engine, { sourceId: 'default', yes: true });
    expect(exitCode).toBe(0);
    expect(report.commit.created).toBe(true);
    const names = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', report.commit.sha!);
    expect(names).toContain(weird);
    expect(names).not.toContain('unrelated.md');
  });

  test('commit-before-anchor crash rerun repairs the journaled HEAD', async () => {
    await importFromContent(engine, 'inbox/j', '---\ntitle: J\n---\n\nbody\n', {
      noEmbed: true, sourceId: 'default', sourcePath: 'inbox/j.md',
    });
    await writePageThrough(engine, 'inbox/j', { sourceId: 'default' });
    const file = path.join(repo, 'inbox/j.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('title: J', 'title: J\nextra: 9'));
    const pre = git(repo, 'rev-parse', 'HEAD');
    const first = await runCanonicalPlaneConvergence(engine, { sourceId: 'default', yes: true });
    expect(first.report.commit.created).toBe(true);
    const convergeSha = first.report.commit.sha!;
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1 WHERE id = 'default'`,
      [pre],
    );
    fs.writeFileSync(
      path.join(repo, '.git', 'gbrain-converge-default.json'),
      JSON.stringify({ sourceId: 'default', preHead: pre, at: new Date().toISOString() }),
    );
    const rerun = await runCanonicalPlaneConvergence(engine, { sourceId: 'default', yes: true });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.report.commit.created).toBe(false);
    const row = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    expect(row[0]?.last_commit).toBe(convergeSha);
  });

  test('add_tag updates semantic content_hash; repo loss is partial', async () => {
    await importFromContent(engine, 'inbox/taghash', '---\ntitle: T\n---\n\nbody\n', {
      noEmbed: true, sourceId: 'default',
    });
    await writePageThrough(engine, 'inbox/taghash', { sourceId: 'default' });
    const ok = await addTag.handler(makeCtx(), { slug: 'inbox/taghash', tag: 'alpha' }) as { status: string };
    expect(ok.status).toBe('ok');
    const page = await engine.getPage('inbox/taghash', { sourceId: 'default' });
    const tags = await engine.getTags('inbox/taghash', { sourceId: 'default' });
    const built = buildCanonicalPageProjection(page!, tags);
    expect(page!.content_hash).toBe(built.semanticContentHash);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [path.join(repo, 'missing-mount')],
    );
    const lost = await addTag.handler(makeCtx(), { slug: 'inbox/taghash', tag: 'beta' }) as {
      status: string; partial?: boolean;
    };
    expect(lost.status).toBe('partial');
    expect(lost.partial).toBe(true);
  });
});

describe('watcher self-origin and static renderer guard', () => {
  test('self-write registration suppresses the matching watcher emit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-fw-self-'));
    const f = path.join(tmp, 'note.md');
    const body = '# Hello\n';
    fs.writeFileSync(f, body);
    const emitter = new EventEmitter();
    const state = { readyFired: false };
    const stub = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'ready' && state.readyFired) {
          queueMicrotask(() => handler());
          return stub;
        }
        emitter.on(event, handler);
        return stub;
      },
      once(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'ready' && state.readyFired) {
          queueMicrotask(() => handler());
          return stub;
        }
        emitter.once(event, handler);
        return stub;
      },
      close: async () => {},
      getWatched: () => ({}),
    } as unknown as FSWatcher;
    const source = createFileWatcherSource({
      brainDir: tmp,
      debounceMs: 30,
      _watchFactory: () => stub,
    });
    const harness = new IngestionTestHarness();
    const start = harness.run(source);
    state.readyFired = true;
    emitter.emit('ready');
    await start;
    registerSelfWrite(f, { sha256: sha256Utf8(body) });
    emitter.emit('add', f);
    await new Promise((r) => setTimeout(r, 120));
    expect(harness.events).toHaveLength(0);
    fs.writeFileSync(f, '# User edit\n');
    emitter.emit('change', f);
    await new Promise((r) => setTimeout(r, 120));
    expect(harness.events.length).toBe(1);
    await harness.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('canonical writers do not keep independent markdown serializers as file sinks', () => {
    const root = path.join(import.meta.dir, '..', 'src');
    const files = [
      'core/takes-write.ts',
      'core/facts/fence-write.ts',
      'core/timeline-write-through.ts',
      'core/cycle/patterns.ts',
      'core/output/writer.ts',
      'core/write-through.ts',
      'core/ops/tags.ts',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src.includes('writePageThrough') || src.includes('persistCanonicalProjectionFromRow') || src.includes('applyCanonicalMarkdownToStore')).toBe(true);
      expect(src).not.toMatch(/writeFileSync\([^)]*serializeMarkdown/);
      expect(src).not.toMatch(/writeFileSync\([^)]*serializePageToMarkdown/);
    }
    const canonical = fs.readFileSync(path.join(root, 'core/page-canonical.ts'), 'utf8');
    expect(canonical).toContain('export function buildCanonicalPageProjection');
  });
});
