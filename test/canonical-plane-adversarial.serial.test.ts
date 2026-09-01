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
import { parseMarkdown } from '../src/core/markdown.ts';
import { PageWriteConflictError } from '../src/core/page-cas.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import {
  buildCanonicalPageProjection,
  loadCanonicalProjection,
  projectionIsFresh,
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
import { __testing as pagesTesting } from '../src/core/ops/pages.ts';
import { createFileWatcherSource } from '../src/core/ingestion/sources/file-watcher.ts';
import { IngestionTestHarness } from '../src/core/ingestion/test-harness.ts';
import type { FSWatcher } from 'chokidar';

let engine: PGLiteEngine;
let repo: string;
let tmp: string;

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-adv-tmp-'));
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
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
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

  test('trusted stale reads repair the file or expose degraded planes', async () => {
    const slug = 'inbox/stale-trusted-read';
    await putPage.handler(makeCtx(), {
      slug, content: '---\ntitle: Stale Read\n---\n\nOLD\n',
    });
    const file = path.join(repo, `${slug}.md`);
    const oldDisk = fs.readFileSync(file, 'utf8');
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth=$1, updated_at=now()
        WHERE source_id=$2 AND slug=$3`,
      ['NEW\n', 'default', slug],
    );
    await engine.executeRaw(
      `UPDATE sources SET local_path=$1 WHERE id='default'`,
      [path.join(repo, 'missing-repo')],
    );

    const degraded = await getPage.handler(makeCtx(), {
      slug, include_content: true,
    }) as Record<string, unknown>;
    expect(degraded.content).toContain('NEW');
    expect(degraded.canonical_file_status).toBe('repair_failed');
    expect(degraded.canonical_planes_degraded).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(oldDisk);

    await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [repo]);

    const raced = await pagesTesting.loadTrustedCanonicalRead(
      makeCtx(),
      'default',
      slug,
      () => fs.writeFileSync(file, 'EXTERNAL EDIT\n'),
    );
    expect(raced.content).toContain('NEW');
    expect(raced.fileStatus).toBe('repair_failed');
    expect(raced.planesDegraded).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('EXTERNAL EDIT\n');

    const repaired = await fetchPage.handler(makeCtx(), { id: slug }) as {
      text: string;
      metadata: Record<string, unknown>;
    };
    expect(repaired.metadata.canonical_file_status).toBe('repaired');
    expect(repaired.metadata.canonical_planes_degraded).toBeUndefined();
    expect(repaired.metadata.canonical_projection_missing).toBeUndefined();
    expect(repaired.metadata.canonical_projection_stale).toBeUndefined();
    expect(repaired.text).toContain('NEW');
    expect(fs.readFileSync(file, 'utf8')).toBe(repaired.text);
    expect((await loadCanonicalProjection(engine, 'default', slug))!.content).toBe(repaired.text);
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

test('convergence never commits or anchors post-verification file bytes', async () => {
  const slug = 'inbox/stage-race';
  await importFromContent(
    engine,
    slug,
    '---\ntitle: Stage Race\n---\n\nCANONICAL\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const file = path.join(repo, `${slug}.md`);
  const canonical = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, canonical.replace('title: Stage Race', 'title: Stage Race\nextra: stale'));
  const [sourceBefore] = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  );

  const result = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default',
    yes: true,
    _afterCommitSnapshotForTest: () => fs.writeFileSync(file, 'RACED\n'),
  });

  expect(result.exitCode).toBe(1);
  expect(result.report.anchor_not_advanced).toBe(true);
  const [sourceAfter] = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  );
  expect(sourceAfter!.last_commit).toBe(sourceBefore!.last_commit);
  expect(fs.readFileSync(file, 'utf8')).toBe('RACED\n');

  if (result.report.commit.created) {
    const sha = result.report.commit.sha!;
    const committed = execFileSync(
      'git', ['-C', repo, 'show', `${sha}:${slug}.md`], { encoding: 'utf8' },
    );
    expect(committed).not.toBe('RACED\n');
    expect(sha256Utf8(committed)).toBe(
      (await loadCanonicalProjection(engine, 'default', slug))!.sha256,
    );
  }
  expect(result.report.conflicts.some(
    (c) => c.reason === 'git_file_changed',
  )).toBe(true);
});

test('published convergence commit preserves a target staged after snapshot', async () => {
  const slug = 'inbox/index-race';
  await importFromContent(
    engine, slug, '---\ntitle: Index Race\n---\n\nCANONICAL\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const file = path.join(repo, `${slug}.md`);
  const canonical = fs.readFileSync(file);
  fs.writeFileSync(file, canonical.toString('utf8').replace(
    'title: Index Race', 'title: Index Race\nextra: stale',
  ));
  const [sourceBefore] = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  );

  const result = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default',
    yes: true,
    _beforeCommitIndexLeaseForTest: () => {
      fs.writeFileSync(file, 'USER STAGED\n');
      execFileSync('git', [
        '--literal-pathspecs', '-C', repo, 'add', '--', `${slug}.md`,
      ]);
      fs.writeFileSync(file, canonical);
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.report.commit.created).toBe(false); // rejected before ref CAS
  expect(result.report.anchor_not_advanced).toBe(true);
  expect(result.report.conflicts.some(
    (conflict) => conflict.reason === 'git_index_changed',
  )).toBe(true);
  expect(execFileSync(
    'git', ['-C', repo, 'show', `:${slug}.md`], { encoding: 'utf8' },
  )).toBe('USER STAGED\n');
  expect(fs.readFileSync(file)).toEqual(canonical);
  expect((await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  ))[0]!.last_commit).toBe(sourceBefore!.last_commit);
  const journalRaw = execFileSync('git', [
    '-C', repo, 'rev-parse', '--git-path', 'gbrain-converge-default.json',
  ], { encoding: 'utf8' }).trim();
  const journal = path.isAbsolute(journalRaw)
    ? journalRaw : path.resolve(repo, journalRaw);
  expect(fs.existsSync(journal)).toBe(false);
});

test('canonical untracked target is committed while unrelated ?? stays untouched', async () => {
  const slug = 'inbox/untracked-canonical';
  await importFromContent(
    engine, slug, '---\ntitle: Untracked Canonical\n---\n\nBODY\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const file = path.join(repo, `${slug}.md`);
  const unrelated = path.join(repo, 'unrelated.tmp');
  fs.writeFileSync(unrelated, 'DO NOT COMMIT\n');
  expect(execFileSync(
    'git', ['-C', repo, 'status', '--porcelain=v1', '--', `${slug}.md`],
    { encoding: 'utf8' },
  ).startsWith('??')).toBe(true);
  const headBefore = execFileSync(
    'git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();

  const dry = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default', yes: false,
  });
  expect(dry.exitCode).toBe(1);
  expect(dry.report.would_commit).toBe(1);
  expect(execFileSync(
    'git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim()).toBe(headBefore);

  const applied = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default', yes: true,
  });
  expect(applied.exitCode).toBe(0);
  expect(applied.report.commit.created).toBe(true);
  expect(execFileSync(
    'git', ['-C', repo, 'show', `HEAD:${slug}.md`], { encoding: 'utf8' },
  )).toBe(fs.readFileSync(file, 'utf8'));
  expect(execFileSync(
    'git', ['-C', repo, 'status', '--porcelain=v1', '--', 'unrelated.tmp'],
    { encoding: 'utf8' },
  ).startsWith('??')).toBe(true);
});

test('HEAD blob identity defeats assume-unchanged and accepts exact staged restart bytes', async () => {
  const slug = 'inbox/index-flags';
  await importFromContent(
    engine, slug, '---\ntitle: Index Flags\n---\n\nOLD\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const file = path.join(repo, `${slug}.md`);
  execFileSync('git', ['-C', repo, 'add', '--', `${slug}.md`]);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'gbrain: write-through fixture']);
  const fixtureHead = execFileSync(
    'git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();
  await engine.executeRaw(
    `UPDATE sources SET last_commit=$1, last_sync_at=now() WHERE id='default'`,
    [fixtureHead],
  );

  await importFromContent(
    engine, slug, '---\ntitle: Index Flags\n---\n\nNEW\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const canonical = fs.readFileSync(file);
  const oldHead = execFileSync(
    'git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();
  execFileSync('git', ['-C', repo, 'update-index', '--assume-unchanged', `${slug}.md`]);
  expect(execFileSync(
    'git', ['-C', repo, 'status', '--porcelain=v1', '--', `${slug}.md`],
    { encoding: 'utf8' },
  )).toBe('');

  const dry = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default', yes: false,
  });
  expect(dry.report.would_commit).toBe(1);
  expect(execFileSync(
    'git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim()).toBe(oldHead);

  // Simulate an interrupted older run that already staged exactly the
  // canonical bytes. This is owned resume state, not arbitrary user staging.
  execFileSync('git', ['-C', repo, 'update-index', '--no-assume-unchanged', `${slug}.md`]);
  execFileSync('git', ['-C', repo, 'add', '--', `${slug}.md`]);
  const applied = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default', yes: true,
  });
  expect(applied.exitCode).toBe(0);
  expect(execFileSync(
    'git', ['-C', repo, 'show', `HEAD:${slug}.md`],
  )).toEqual(canonical);
});

test('convergence scrubs inherited alternate Git index', async () => {
  const slug = 'inbox/real-index-only';
  await importFromContent(
    engine, slug, '---\ntitle: Real Index\n---\n\nBODY\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const indexRaw = execFileSync(
    'git', ['-C', repo, 'rev-parse', '--git-path', 'index'], { encoding: 'utf8' },
  ).trim();
  const realIndex = path.isAbsolute(indexRaw) ? indexRaw : path.resolve(repo, indexRaw);
  const alternate = path.join(tmp, 'attacker-index');
  fs.copyFileSync(realIndex, alternate);
  const alternateBefore = fs.readFileSync(alternate);
  const previous = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternate;
  try {
    const result = await runCanonicalPlaneConvergence(engine, {
      sourceId: 'default', yes: true,
    });
    expect(result.exitCode).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
  expect(fs.readFileSync(alternate)).toEqual(alternateBefore);
  const afterRaw = execFileSync(
    'git', ['-C', repo, 'rev-parse', '--git-path', 'index'], { encoding: 'utf8' },
  ).trim();
  expect(path.isAbsolute(afterRaw) ? afterRaw : path.resolve(repo, afterRaw))
    .toBe(realIndex);
  expect(execFileSync(
    'git', ['-C', repo, 'show', `HEAD:${slug}.md`],
  )).toEqual(fs.readFileSync(path.join(repo, `${slug}.md`)));
});

test('a verified subset may commit but can never anchor an incomplete source', async () => {
  const good = 'inbox/partial-good';
  const missing = 'inbox/partial-missing';
  for (const slug of [good, missing]) {
    await importFromContent(
      engine, slug, `---\ntitle: ${slug}\n---\n\nBODY\n`,
      { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
    );
    await writePageThrough(engine, slug, { sourceId: 'default' });
  }
  const missingFile = path.join(repo, `${missing}.md`);
  const anchorBefore = (await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  ))[0]!.last_commit;
  // Keep `good` canonical and untracked: it is eligible for a real commit
  // without making the tracked tree dirty. Only the second page is absent.
  expect(execFileSync(
    'git', ['-C', repo, 'status', '--porcelain=v1', '--', `${good}.md`],
    { encoding: 'utf8' },
  ).startsWith('??')).toBe(true);
  fs.unlinkSync(missingFile);

  const result = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default', yes: true,
  });
  expect(result.exitCode).toBe(1);
  expect(result.report.missing_file).toBeGreaterThan(0);
  expect(result.report.commit.created).toBe(true);
  expect(result.report.anchor_not_advanced).toBe(true);
  expect((await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  ))[0]!.last_commit).toBe(anchorBefore);
  const walRaw = execFileSync(
    'git', ['-C', repo, 'rev-parse', '--git-path', 'gbrain-converge-default.json'],
    { encoding: 'utf8' },
  ).trim();
  expect(fs.existsSync(path.isAbsolute(walRaw) ? walRaw : path.resolve(repo, walRaw)))
    .toBe(false); // deliberate partial completed; Git history is the resume proof
});

test('a page created after the snapshot makes the source-epoch anchor CAS miss', async () => {
  const anchorBefore = (await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  ))[0]!.last_commit;
  const result = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default',
    yes: true,
    _afterPageScanForTest: async () => {
      await importFromContent(
        engine,
        'inbox/late-page',
        '---\ntitle: Late Page\n---\n\nLATE\n',
        { noEmbed: true, sourceId: 'default', sourcePath: 'inbox/late-page.md' },
      );
      await writePageThrough(engine, 'inbox/late-page', { sourceId: 'default' });
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.report.anchor_not_advanced).toBe(true);
  expect(result.report.errors.some(
    (error) => error.reason.endsWith(':canonical_routing_moved'),
  )).toBe(true);
  expect((await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  ))[0]!.last_commit).toBe(anchorBefore);
});

test('convergence auto-push is push-only and never executes the rebase hook', async () => {
  const slug = 'inbox/push-order';
  await importFromContent(
    engine, slug, '---\ntitle: Push Order\n---\n\nCANONICAL\n',
    { noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md` },
  );
  await writePageThrough(engine, slug, { sourceId: 'default' });
  const file = path.join(repo, `${slug}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
    'title: Push Order', 'title: Push Order\nextra: stale',
  ));

  const gitPath = (name: string): string => {
    const raw = execFileSync(
      'git', ['-C', repo, 'rev-parse', '--git-path', name], { encoding: 'utf8' },
    ).trim();
    return path.isAbsolute(raw) ? raw : path.resolve(repo, raw);
  };
  const marker = path.join(tmp, 'managed-hook-must-not-run');
  const journal = gitPath('gbrain-converge-default.json');
  const hook = gitPath('hooks/post-commit');
  const shq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh
# gbrain brain-durability post-commit hook (v0.42.44+)
echo EXECUTED > ${shq(marker)}
exit 99
`);
  fs.chmodSync(hook, 0o755);

  const remote = path.join(tmp, 'push-only.git');
  execFileSync('git', ['init', '--bare', remote]);
  try { execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin']); } catch { /* absent */ }
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  const expectedRef = execFileSync(
    'git', ['-C', repo, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8' },
  ).trim();
  execFileSync('git', [
    '-C', repo, 'push', '--no-verify', 'origin', `HEAD:${expectedRef}`,
  ]);

  const result = await runCanonicalPlaneConvergence(engine, {
    sourceId: 'default', yes: true,
  });
  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(journal)).toBe(false);
  expect(fs.existsSync(marker)).toBe(false); // banner was inspected, hook not run
  const anchoredHead = execFileSync(
    'git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();
  expect((await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id='default'`,
  ))[0]!.last_commit).toBe(anchoredHead);

  let remoteHead = '';
  for (let attempt = 0; attempt < 100 && remoteHead !== anchoredHead; attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    try {
      remoteHead = execFileSync(
        'git', ['--git-dir', remote, 'rev-parse', expectedRef], { encoding: 'utf8' },
      ).trim();
    } catch { /* detached push is still in flight */ }
  }
  expect(remoteHead).toBe(anchoredHead);
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

describe('atomic canonical identity', () => {
  function taggedMarkdown(body: string, tags: string[]): string {
    return `---\ntitle: Atomic Identity\ntags:\n${tags.map((tag) => `  - ${tag}`).join('\n')}\n---\n\n${body}\n`;
  }

  test('unchanged reconciliation conflicts on a provenance race', async () => {
    const slug = 'inbox/atomic-provenance';
    const content = taggedMarkdown('BODY-1', ['base']);
    await importFromContent(engine, slug, content, {
      noEmbed: true, sourceId: 'default',
      source_kind: 'manual', ingested_via: 'test',
    });
    const initial = await engine.getPage(slug, { sourceId: 'default' });
    const initialProjection = await loadCanonicalProjection(engine, 'default', slug);
    const projected = parseMarkdown(initialProjection!.content, `${slug}.md`);
    const dbAt = new Date(initial!.ingested_at!).toISOString();
    expect(projected.frontmatter.ingested_at).toBe(dbAt);

    const savedTransaction = engine.transaction;
    const originalTransaction = engine.transaction.bind(engine);
    let injected = false;
    engine.transaction = async (fn) => {
      if (!injected) {
        injected = true;
        await engine.executeRaw(
          `UPDATE pages SET ingested_via='racer'
            WHERE source_id='default' AND slug=$1`,
          [slug],
        );
      }
      return originalTransaction(fn);
    };
    try {
      await expect(importFromContent(engine, slug, content, {
        noEmbed: true,
        sourceId: 'default',
        expectedContentHash: initial!.content_hash,
        source_kind: 'manual',
        ingested_via: 'test',
      })).rejects.toBeInstanceOf(PageWriteConflictError);
    } finally {
      engine.transaction = savedTransaction;
    }
  });

  test('successful unchanged legacy adoption uses exactly one clock', async () => {
    const slug = 'inbox/atomic-one-clock';
    const content = taggedMarkdown('UNCHANGED', ['base']);
    await importFromContent(engine, slug, content, {
      noEmbed: true,
      sourceId: 'default',
      source_kind: 'manual',
      ingested_via: 'test',
    });
    const before = await engine.getPage(slug, { sourceId: 'default' });

    await engine.executeRaw(
      `UPDATE pages SET
         ingested_at = NULL,
         frontmatter = frontmatter - 'ingested_at',
         canonical_input_generation = COALESCE(canonical_input_generation, 0) + 1
       WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    const stale = await loadCanonicalProjection(engine, 'default', slug);
    expect(stale!.semanticContentHash).toBe(before!.content_hash);
    expect(String(stale!.inputGeneration)).not.toBe(String(stale!.basisGeneration));

    const result = await importFromContent(engine, slug, content, {
      noEmbed: true,
      sourceId: 'default',
      source_kind: 'manual',
      ingested_via: 'test',
    });
    expect(result).toMatchObject({ status: 'skipped', skip_reason: 'unchanged' });

    const row = await engine.getPage(slug, { sourceId: 'default' });
    const projection = await loadCanonicalProjection(engine, 'default', slug);
    const projected = parseMarkdown(projection!.content, `${slug}.md`);
    const rowAt = new Date(row!.ingested_at!).toISOString();
    expect(rowAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row!.frontmatter.ingested_at).toBe(rowAt);
    expect(projected.frontmatter.ingested_at).toBe(rowAt);
    expect(String(projection!.inputGeneration))
      .toBe(String(projection!.basisGeneration));
  });

  test('changed source reimport hashes the effective additive tag union', async () => {
    const slug = 'inbox/atomic-tags';
    await importFromContent(engine, slug, taggedMarkdown('BODY-1', ['base']), {
      noEmbed: true, sourceId: 'default',
    });
    const added = await addTag.handler(makeCtx(), {
      slug, tag: 'enrich',
    }) as { status: string };
    expect(added.status).toBe('ok');

    const changed = await importFromContent(
      engine,
      slug,
      taggedMarkdown('BODY-2', ['base']),
      { noEmbed: true, sourceId: 'default' },
    );
    expect(changed.status).toBe('imported');
    const fileWrite = await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(fileWrite.written).toBe(true);
    expect((await engine.getTags(slug, { sourceId: 'default' })).sort())
      .toEqual(['base', 'enrich']);
    const page = await engine.getPage(slug, { sourceId: 'default' });
    const projection = await loadCanonicalProjection(engine, 'default', slug);
    expect(page!.content_hash).toBe(projection!.semanticContentHash);
    expect(projection!.content).toContain('BODY-2');
    expect(fs.readFileSync(path.join(repo, `${slug}.md`), 'utf8'))
      .toBe(projection!.content);
  });

  test('engine putPage requires caller-resolved ingested_at with provenance', async () => {
    await expect(engine.putPage('inbox/missing-clock', {
      type: 'note', title: 'Clock', compiled_truth: 'body', timeline: '',
      frontmatter: {}, source_kind: 'manual', ingested_via: 'test',
    }, { sourceId: 'default' })).rejects.toThrow(
      'provenance requires caller-resolved ingested_at',
    );

    const at = new Date('2026-08-01T00:00:00.000Z');
    await engine.putPage('inbox/one-clock', {
      type: 'note', title: 'Clock', compiled_truth: 'body', timeline: '',
      frontmatter: {}, source_kind: 'manual', ingested_via: 'test', ingested_at: at,
    }, { sourceId: 'default' });
    await persistCanonicalProjectionFromRow(engine, 'default', 'inbox/one-clock');
    const storedClock = await engine.getPage('inbox/one-clock', { sourceId: 'default' });
    const clockProjection = await loadCanonicalProjection(engine, 'default', 'inbox/one-clock');
    expect(new Date(storedClock!.ingested_at!).toISOString()).toBe(at.toISOString());
    expect(parseMarkdown(clockProjection!.content, 'one-clock.md').frontmatter.ingested_at)
      .toBe(at.toISOString());
  });

  test('same-content URI reimport is incoming-non-null-wins', async () => {
    const slug = 'inbox/atomic-uri';
    const content = taggedMarkdown('URI-BODY', ['base']);
    await importFromContent(engine, slug, content, {
      noEmbed: true, sourceId: 'default', source_uri: 'urn:old',
    });
    const result = await importFromContent(engine, slug, content, {
      noEmbed: true, sourceId: 'default', source_uri: 'urn:new',
    });
    expect(result.status).toBe('skipped');
    const row = await engine.getPage(slug, { sourceId: 'default' });
    expect(row!.source_uri).toBe('urn:new');
    const projection = await loadCanonicalProjection(engine, 'default', slug);
    expect(projectionIsFresh(projection!)).toBe(true);
  });
});
