/**
 * Canonical writer-closure pinning tests (APPLY ROUND pack section 2).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { writePageThrough, verifyOrRepairPageFile } from '../src/core/write-through.ts';
import {
  loadCanonicalProjection,
  persistCanonicalProjectionFromRow,
  sha256Utf8,
} from '../src/core/page-canonical.ts';
import {
  CanonicalMutationPartialError,
  commitCanonicalMarkdownMutation,
} from '../src/core/canonical-mutation.ts';
import { withPutPageOperationLock } from '../src/core/ops/put-page-lock.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { BrainWriter } from '../src/core/output/writer.ts';
import type { ResolverContext } from '../src/core/resolvers/interface.ts';
import { partitionSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { runImport } from '../src/commands/import.ts';
import { rejectFailedImportJob } from '../src/commands/jobs.ts';
import { runQuarantine } from '../src/commands/quarantine.ts';
import { isQuarantined } from '../src/core/quarantine.ts';
import { addTakeToPage } from '../src/core/takes-write.ts';
import { writeTimelineEntryThrough } from '../src/core/timeline-write-through.ts';
import { __testing as patternsTesting } from '../src/core/cycle/patterns.ts';
import { renderTimelineEntry } from '../src/core/timeline-write-through.ts';

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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-closure-'));
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

describe('canonical writer closure', () => {
  test('canonical mutation rolls back before files and throws typed partial after DB commit', async () => {
    const slug = 'inbox/closure';
    await importFromContent(engine, slug, '---\ntitle: Closure\n---\n\nOLD\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const file = path.join(repo, `${slug}.md`);
    const before = fs.readFileSync(file);
    const beforeMtime = fs.statSync(file).mtimeMs;

    await expect(withPutPageOperationLock(engine, 'default', slug, () =>
      commitCanonicalMarkdownMutation(
        engine, 'default', slug,
        '---\ntitle: Closure\n---\n\nROLLED BACK\n',
        async (tx) => {
          await tx.executeRaw(`UPDATE pages SET compiled_truth='ROLLED BACK' WHERE source_id='default' AND slug=$1`, [slug]);
          throw new Error('force rollback');
        },
        {
          expectedPath: file,
          expectedTargetSha256: sha256Utf8(before),
        },
      ),
    )).rejects.toThrow('force rollback');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.statSync(file).mtimeMs).toBe(beforeMtime);

    const missingRoot = path.join(repo, 'missing');
    await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [missingRoot]);
    await expect(withPutPageOperationLock(engine, 'default', slug, () =>
      commitCanonicalMarkdownMutation(
        engine, 'default', slug,
        '---\ntitle: Closure\n---\n\nCOMMITTED\n',
        async () => undefined,
        {
          expectedPath: path.join(missingRoot, `${slug}.md`),
          expectedTargetSha256: null,
        },
      ),
    )).rejects.toBeInstanceOf(CanonicalMutationPartialError);
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('COMMITTED');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  test('facts retry accepts only the identical committed mirror tuple', async () => {
    const fact = {
      row_num: 1,
      source_markdown_slug: 'inbox/fact-retry',
      fact: 'Pinned tuple',
      source: 'test',
      kind: 'fact' as const,
      visibility: 'world' as const,
      notability: 'medium' as const,
      confidence: 1,
      valid_from: new Date('2026-09-01T00:00:00.000Z'),
    };
    const insert = (row: typeof fact) => engine.transaction((tx) =>
      tx.insertFacts([row], { source_id: 'default' }, {
        inTransaction: true,
        verifyIdenticalOnConflict: true,
      }),
    );
    expect((await insert(fact)).inserted).toBe(1);
    expect((await insert(fact)).inserted).toBe(1);
    expect((await insert({ ...fact, fact: 'row-number collision' })).inserted).toBe(0);
  });

  test('facts retry repairs store-new/file-old without appending a second row', async () => {
    const slug = 'people/fact-partial-retry';
    await importFromContent(engine, slug, '---\ntitle: Fact Retry\n---\n\nBODY\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const file = path.join(repo, `${slug}.md`);
    const preFactBytes = fs.readFileSync(file);
    const input = {
      fact: 'One durable fact', kind: 'fact' as const, notability: 'medium' as const,
      source: 'test', visibility: 'world' as const, confidence: 1,
      embedding: null, sessionId: 'retry-session',
    };
    expect((await writeFactsToFence(engine, {
      sourceId: 'default', localPath: repo, slug,
    }, [input])).inserted).toBe(1);

    fs.writeFileSync(file, preFactBytes);
    const retried = await writeFactsToFence(engine, {
      sourceId: 'default', localPath: repo, slug,
    }, [input]);
    expect(retried.inserted).toBe(1);
    expect(parseFactsFence(fs.readFileSync(file, 'utf8')).facts).toHaveLength(1);
    const rows = await engine.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM facts
        WHERE source_id='default' AND source_markdown_slug=$1`,
      [slug],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    expect(fs.readFileSync(file, 'utf8'))
      .toBe((await loadCanonicalProjection(engine, 'default', slug))!.content);
  });

  test('BrainWriter never blesses an edit made after its logical page read', async () => {
    const slug = 'inbox/writer-preimage';
    await importFromContent(engine, slug, '---\ntitle: Writer\n---\n\nOLD\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const file = path.join(repo, `${slug}.md`);
    const writer = new BrainWriter(engine, {
      sourceId: 'default',
      _afterPageReadBeforeMutationForTest: () => fs.writeFileSync(file, 'EDITOR WON\n'),
    });
    await expect(writer.transaction(
      (tx) => tx.setCompiledTruth(slug, 'STORE COMMITTED\n'),
      {} as ResolverContext,
    )).rejects.toMatchObject({ code: 'partial_write' });
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth)
      .toBe('STORE COMMITTED\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('EDITOR WON\n');
  });

  test('post-commit source rewrite exceptions return a hard partial', async () => {
    const file = path.join(repo, 'inbox', 'sync-partial.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\ntitle: Sync Partial\n---\n\nBODY\n');
    const result = await importFromFile(engine, file, 'inbox/sync-partial.md', {
      noEmbed: true,
      sourceId: 'default',
      _beforeCanonicalRewriteForTest: () => { throw new Error('EACCES injected'); },
    });
    expect(result).toMatchObject({
      partial: true,
      file_status: 'repair_failed',
      error: 'EACCES injected',
    });

    const inbox = path.join(repo, 'inbox-prod');
    fs.mkdirSync(inbox, { recursive: true });
    const prodFile = path.join(inbox, 'prod-partial.md');
    fs.writeFileSync(prodFile, '---\ntitle: Prod Partial\n---\n\nBODY\n');
    fs.chmodSync(prodFile, 0o444);
    fs.chmodSync(inbox, 0o555);
    let ran;
    try {
      ran = await runImport(engine, [inbox, '--no-embed'], { sourceId: 'default' });
    } finally {
      fs.chmodSync(inbox, 0o755);
      try { fs.chmodSync(prodFile, 0o644); } catch { /* rewritten or gone */ }
    }
    expect(ran.failures.some((failure) => failure.hard === true)).toBe(true);
    expect(ran.imported).toBe(0);
    expect(ran.errors).toBeGreaterThan(0);
    expect(partitionSyncFailures(ran.failures).sentinels.length).toBeGreaterThan(0);
    expect(partitionSyncFailures(ran.failures).fileFailures).toHaveLength(0);
    expect(() => rejectFailedImportJob(ran)).toThrow(/import job failed/);
    expect(() => rejectFailedImportJob({
      errors: 0,
      failures: [],
    })).not.toThrow();
  });

  async function captureQuarantine(fn: () => Promise<void>): Promise<{
    out: string;
    exitCode: number | undefined;
  }> {
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exitCode;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    process.exitCode = 0;
    try {
      await fn();
      return { out: lines.join('\n'), exitCode: process.exitCode };
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = origExit;
    }
  }

  test('quarantine clear retry repairs store-new/file-old via the production command', async () => {
    const slug = 'inbox/clear-retry';
    const file = path.join(repo, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const junk = '---\ntitle: Clear Retry\n---\n\nCloudflare Ray ID: abc. junk\n';
    const clean = '---\ntitle: Clear Retry\n---\n\nplain clean prose.\n';
    await importFromContent(engine, slug, junk, {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    expect(isQuarantined((await engine.getPage(slug, { sourceId: 'default' }))!.frontmatter))
      .toBe(true);
    const markedFile = fs.readFileSync(file, 'utf8');
    expect(markedFile).toContain('quarantine:');

    await importFromContent(engine, slug, clean, {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await persistCanonicalProjectionFromRow(engine, 'default', slug);
    expect(isQuarantined((await engine.getPage(slug, { sourceId: 'default' }))!.frontmatter))
      .toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(markedFile);

    const ran = await captureQuarantine(() => runQuarantine(engine, ['clear', slug, '--json']));
    expect(ran.exitCode).toBe(0);
    const stored = await loadCanonicalProjection(engine, 'default', slug);
    expect(stored).not.toBeNull();
    expect(sha256Utf8(fs.readFileSync(file, 'utf8'))).toBe(stored!.sha256);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('quarantine:');
  });

  test('quarantine scan retry repairs store-new/file-old via the production command', async () => {
    const slug = 'inbox/scan-retry';
    const file = path.join(repo, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const junk = '---\ntitle: Scan Retry\n---\n\nCloudflare Ray ID: zzz. This junk predates the gate.\n';
    await importFromContent(engine, slug, junk, {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await persistCanonicalProjectionFromRow(engine, 'default', slug);
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const stored = await loadCanonicalProjection(engine, 'default', slug);
    expect(stored).not.toBeNull();
    expect(isQuarantined((await engine.getPage(slug, { sourceId: 'default' }))!.frontmatter))
      .toBe(true);
    fs.writeFileSync(file, '---\ntitle: Scan Retry\n---\n\nSTALE FILE\n');
    expect(sha256Utf8(fs.readFileSync(file, 'utf8'))).not.toBe(stored!.sha256);

    const ran = await captureQuarantine(
      () => runQuarantine(engine, ['scan', '--apply', '--no-embed', '--json']),
    );
    expect(ran.exitCode).toBe(0);
    const jsonStart = ran.out.indexOf('{');
    const jsonEnd = ran.out.lastIndexOf('}');
    const payload = JSON.parse(ran.out.slice(jsonStart, jsonEnd + 1)) as {
      partial?: boolean; write_failures?: unknown[];
    };
    expect(payload.partial).toBe(false);
    expect(payload.write_failures ?? []).toEqual([]);
    const after = await loadCanonicalProjection(engine, 'default', slug);
    expect(after).not.toBeNull();
    expect(sha256Utf8(fs.readFileSync(file, 'utf8'))).toBe(after!.sha256);
    expect(fs.readFileSync(file, 'utf8')).toContain('quarantine:');
  });

  test('Takes without sourceId never mirrors to a same-slug named-source page', async () => {
    const slug = 'inbox/takes-default';
    await importFromContent(engine, slug, '---\ntitle: Default\n---\n\nBODY\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('named', 'named', $1)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [repo],
    );
    await importFromContent(engine, slug, '---\ntitle: Named\n---\n\nNAMED BODY\n', {
      noEmbed: true, sourceId: 'named', sourcePath: `${slug}.md`,
    });
    const namedBefore = (await engine.getPage(slug, { sourceId: 'named' }))!;
    const defaultPage = (await engine.getPage(slug, { sourceId: 'default' }))!;
    await addTakeToPage({
      engine,
      slug,
      brainDir: repo,
    }, {
      claim: 'Default-only take',
      kind: 'take',
      holder: 'brain',
    });
    const takes = await engine.executeRaw<{ page_id: number }>(
      `SELECT page_id FROM takes WHERE claim = 'Default-only take'`,
    );
    expect(takes).toHaveLength(1);
    expect(Number(takes[0]!.page_id)).toBe(Number(defaultPage.id));
    expect((await engine.getPage(slug, { sourceId: 'named' }))!.compiled_truth)
      .toBe(namedBefore.compiled_truth);
  });

  test('verifyOrRepairPageFile preserves an editor write injected after its preimage read', async () => {
    const slug = 'inbox/repair-cas-closure';
    await importFromContent(engine, slug, '---\ntitle: Repair\n---\n\nSTORE NEW\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const file = path.join(repo, `${slug}.md`);
    fs.writeFileSync(file, 'FILE OLD\n');
    const projection = await loadCanonicalProjection(engine, 'default', slug);
    const result = await verifyOrRepairPageFile(
      engine,
      slug,
      projection!.semanticContentHash,
      {
        sourceId: 'default',
        _beforeRepairWriteForTest: () => {
          fs.writeFileSync(file, 'EDITOR WON\n');
        },
      },
    );
    expect(result.file_status).toBe('repair_failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('EDITOR WON\n');
  });

  test('reverse-write reports non-OK when a DB winner lands after the file sink', async () => {
    const slug = 'inbox/reverse-winner';
    await importFromContent(engine, slug, '---\ntitle: Reverse\n---\n\nOLD\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const report = await patternsTesting.reverseWriteRefs(
      engine,
      repo,
      [{ slug, source_id: 'default' }],
      'default',
      {
        afterWriteBeforeProof: async () => {
          await engine.executeRaw(
            `UPDATE pages SET compiled_truth = 'WINNER' WHERE source_id='default' AND slug=$1`,
            [slug],
          );
          await persistCanonicalProjectionFromRow(engine, 'default', slug);
        },
      },
    );
    expect(report.written).toBe(0);
    expect(report.failures).toHaveLength(1);
  });

  test('timeline substring decoys do not satisfy the exact duplicate tuple', async () => {
    const slug = 'inbox/timeline-decoy';
    await importFromContent(engine, slug, '---\ntitle: Timeline\n---\n\nBODY\n', {
      noEmbed: true, sourceId: 'default', sourcePath: `${slug}.md`,
    });
    await writePageThrough(engine, slug, { sourceId: 'default' });
    const entry = {
      date: '2026-09-01',
      summary: 'Shipped the fence',
      source: 'manual',
      detail: '',
    };
    const rendered = renderTimelineEntry(entry, slug);
    expect(rendered).toBeTruthy();
    const first = await writeTimelineEntryThrough(engine, slug, 'default', entry);
    expect(first.kind).toBe('written');
    const file = path.join(repo, `${slug}.md`);
    const beforeSecond = fs.readFileSync(file, 'utf8');
    const decoy = beforeSecond.replace(
      'BODY',
      `BODY\n\n<!-- ${rendered!.block} -->`,
    );
    fs.writeFileSync(file, decoy);
    const second = await writeTimelineEntryThrough(engine, slug, 'default', entry);
    expect(second.kind).toBe('duplicate');
    const rows = await engine.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
        WHERE p.source_id='default' AND p.slug=$1 AND te.summary=$2`,
      [slug, entry.summary],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
