import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { runCanonicalPlaneConvergence } from '../src/core/page-plane-convergence.ts';
import { persistCanonicalProjectionFromRow } from '../src/core/page-canonical.ts';

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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-converge-'));
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

describe('converge-canonical', () => {
  test('dry-run is the default and changes nothing', async () => {
    await importFromContent(engine, 'inbox/a', '---\ntitle: A\n---\n\none\n', { noEmbed: true, sourceId: 'default', sourcePath: 'inbox/a.md' });
    await writePageThrough(engine, 'inbox/a', { sourceId: 'default' });
    const file = path.join(repo, 'inbox/a.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('title: A', 'title: A\nextra: 1'));
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const { report, exitCode } = await runCanonicalPlaneConvergence(engine, { sourceId: 'default' });
    expect(exitCode).toBe(0);
    expect(report.would_rewrite).toBeGreaterThan(0);
    expect(report.rewritten).toBe(0);
    expect(report.commit.created).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('extra: 1');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(beforeHead);
  });

  test('refuses a dirty tracked unrelated file with zero writes', async () => {
    await importFromContent(engine, 'inbox/b', '---\ntitle: B\n---\n\ntwo\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/b', { sourceId: 'default' });
    fs.writeFileSync(path.join(repo, 'unrelated.md'), 'dirt\n');
    execSync('git add unrelated.md', { cwd: repo, stdio: 'pipe' });
    const { report, exitCode } = await runCanonicalPlaneConvergence(engine, { sourceId: 'default', yes: true });
    expect(exitCode).toBe(2);
    expect(report.errors.some((e) => e.reason === 'dirty_tracked_tree')).toBe(true);
    expect(report.rewritten).toBe(0);
    expect(report.commit.created).toBe(false);
  });

  test('missing file is reported and not recreated', async () => {
    await importFromContent(engine, 'inbox/missing', '---\ntitle: M\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await persistCanonicalProjectionFromRow(engine, 'default', 'inbox/missing');
    const { report, exitCode } = await runCanonicalPlaneConvergence(engine, { sourceId: 'default' });
    expect(report.missing_file).toBeGreaterThan(0);
    expect(exitCode).toBe(1);
    expect(fs.existsSync(path.join(repo, 'inbox/missing.md'))).toBe(false);
  });
});
