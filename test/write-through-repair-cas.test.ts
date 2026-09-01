/**
 * Pin verifyOrRepairPageFile CAS: an editor write after the repair preimage
 * is read must not be overwritten.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, verifyOrRepairPageFile } from '../src/core/write-through.ts';
import { loadCanonicalProjection } from '../src/core/page-canonical.ts';

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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-repair-cas-'));
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

describe('write-through repair CAS', () => {
  test('editor write after repair preimage is preserved', async () => {
    const slug = 'inbox/repair-cas';
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
});
