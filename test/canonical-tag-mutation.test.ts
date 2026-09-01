import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { loadCanonicalProjection } from '../src/core/page-canonical.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

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
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-tags-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

function makeCtx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

const addTag = operations.find((o) => o.name === 'add_tag')!;
const removeTag = operations.find((o) => o.name === 'remove_tag')!;

describe('tag mutations refresh canonical projection and file', () => {
  test('add_tag updates stored projection, file bytes, and basis generation', async () => {
    await importFromContent(engine, 'inbox/tagged', '---\ntitle: T\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/tagged', { sourceId: 'default' });
    const before = await loadCanonicalProjection(engine, 'default', 'inbox/tagged');
    const result = await addTag.handler(makeCtx(), { slug: 'inbox/tagged', tag: 'alpha' }) as {
      status: string;
      partial?: boolean;
    };
    expect(result.status).toBe('ok');
    expect(result.partial).toBeUndefined();
    const after = await loadCanonicalProjection(engine, 'default', 'inbox/tagged');
    expect(after).not.toBeNull();
    expect(after!.content).toContain('alpha');
    expect(after!.content).not.toBe(before!.content);
    expect(after!.inputGeneration).toBe(after!.basisGeneration);
    const file = fs.readFileSync(path.join(brainDir, 'inbox/tagged.md'), 'utf8');
    expect(file).toBe(after!.content);
  });

  test('duplicate add_tag is a no-op on counters', async () => {
    await importFromContent(engine, 'inbox/dup-tag', '---\ntitle: T\ntags: [alpha]\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/dup-tag', { sourceId: 'default' });
    await addTag.handler(makeCtx(), { slug: 'inbox/dup-tag', tag: 'alpha' });
    const first = await loadCanonicalProjection(engine, 'default', 'inbox/dup-tag');
    await addTag.handler(makeCtx(), { slug: 'inbox/dup-tag', tag: 'alpha' });
    const second = await loadCanonicalProjection(engine, 'default', 'inbox/dup-tag');
    expect(second!.inputGeneration).toBe(first!.inputGeneration);
    expect(second!.basisGeneration).toBe(first!.basisGeneration);
  });

  test('remove_tag rewrites projection and file together', async () => {
    await importFromContent(engine, 'inbox/untag', '---\ntitle: T\ntags: [keep, drop]\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/untag', { sourceId: 'default' });
    await removeTag.handler(makeCtx(), { slug: 'inbox/untag', tag: 'drop' });
    const after = await loadCanonicalProjection(engine, 'default', 'inbox/untag');
    expect(after!.content).not.toContain('drop');
    expect(after!.content).toContain('keep');
    expect(fs.readFileSync(path.join(brainDir, 'inbox/untag.md'), 'utf8')).toBe(after!.content);
    expect(after!.inputGeneration).toBe(after!.basisGeneration);
  });
});
