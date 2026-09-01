/**
 * Identical-content CAS put_page must be a true no-op: no store rewrite,
 * no updated_at bump, no canonical-file restamp. Changed-content CAS still
 * writes both planes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-cas-noop-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

const BODY = `---
title: CAS no-op probe
---

# probe

- [x] checkbox-1
`;

const BODY_FLIPPED = `---
title: CAS no-op probe
---

# probe

- [ ] checkbox-1
`;

describe('put_page identical CAS is a store/file no-op', () => {
  test('same-content CAS keeps hash, updated_at, and file mtime', async () => {
    const ctx = makeCtx();
    const created = await putPage.handler(ctx, { slug: 'scratch/cas-noop', content: BODY }) as {
      write_through?: { written?: boolean; path?: string };
      no_op?: boolean;
      partial?: boolean;
    };
    expect(created.write_through?.written).toBe(true);
    expect(created.no_op).toBeUndefined();
    expect(created.partial).toBeUndefined();

    const page1 = await engine.getPage('scratch/cas-noop');
    expect(page1?.content_hash).toBeTruthy();
    const hash1 = page1!.content_hash!;
    const updated1 = page1!.updated_at.getTime();
    const filePath = created.write_through!.path!;
    const stat1 = fs.statSync(filePath);
    const disk1 = fs.readFileSync(filePath, 'utf8');

    await Bun.sleep(50);

    const noop = await putPage.handler(ctx, {
      slug: 'scratch/cas-noop',
      content: BODY,
      expected_content_hash: hash1,
    }) as {
      status?: string;
      changed?: boolean;
      no_op?: boolean;
      file_repaired?: boolean;
      file_status?: string;
      partial?: boolean;
      write_through?: { written?: boolean; skipped?: string };
    };
    expect(noop.no_op).toBe(true);
    expect(noop.changed).toBe(false);
    expect(noop.file_repaired).toBe(false);
    expect(noop.file_status).toBe('healthy');
    expect(noop.partial).toBeUndefined();
    expect(noop.write_through?.written).toBe(false);
    expect(noop.write_through?.skipped).toBe('unchanged');

    const page2 = await engine.getPage('scratch/cas-noop');
    expect(page2?.content_hash).toBe(hash1);
    expect(page2!.updated_at.getTime()).toBe(updated1);
    const stat2 = fs.statSync(filePath);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(disk1);
  });

  test('changed-content CAS still updates hash, timestamp, and file', async () => {
    const ctx = makeCtx();
    await putPage.handler(ctx, { slug: 'scratch/cas-change', content: BODY });
    const page1 = await engine.getPage('scratch/cas-change');
    const hash1 = page1!.content_hash!;
    const updated1 = page1!.updated_at.getTime();
    const filePath = path.join(brainDir, 'scratch/cas-change.md');
    const mtime1 = fs.statSync(filePath).mtimeMs;

    await Bun.sleep(50);

    const changed = await putPage.handler(ctx, {
      slug: 'scratch/cas-change',
      content: BODY_FLIPPED,
      expected_content_hash: hash1,
    }) as {
      no_op?: boolean;
      partial?: boolean;
      write_through?: { written?: boolean };
    };
    expect(changed.no_op).toBeUndefined();
    expect(changed.partial).toBeUndefined();
    expect(changed.write_through?.written).toBe(true);

    const page2 = await engine.getPage('scratch/cas-change');
    expect(page2?.content_hash).not.toBe(hash1);
    expect(page2!.updated_at.getTime()).toBeGreaterThan(updated1);
    expect(fs.statSync(filePath).mtimeMs).toBeGreaterThan(mtime1);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('- [ ] checkbox-1');
  });

  test('same-content CAS repairs a missing canonical file without bumping updated_at', async () => {
    const ctx = makeCtx();
    const created = await putPage.handler(ctx, { slug: 'scratch/cas-repair-missing', content: BODY }) as {
      write_through?: { path?: string };
    };
    const filePath = created.write_through!.path!;
    const page1 = await engine.getPage('scratch/cas-repair-missing');
    const hash1 = page1!.content_hash!;
    const updated1 = page1!.updated_at.getTime();
    fs.unlinkSync(filePath);
    expect(fs.existsSync(filePath)).toBe(false);

    const repaired = await putPage.handler(ctx, {
      slug: 'scratch/cas-repair-missing',
      content: BODY,
      expected_content_hash: hash1,
    }) as {
      no_op?: boolean;
      file_repaired?: boolean;
      file_status?: string;
      partial?: boolean;
      write_through?: { written?: boolean; path?: string };
    };
    expect(repaired.no_op).toBe(true);
    expect(repaired.file_repaired).toBe(true);
    expect(repaired.file_status).toBe('repaired');
    expect(repaired.partial).toBeUndefined();
    expect(repaired.write_through?.written).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('- [x] checkbox-1');
    const page2 = await engine.getPage('scratch/cas-repair-missing');
    expect(page2?.content_hash).toBe(hash1);
    expect(page2!.updated_at.getTime()).toBe(updated1);
  });

  test('same-content CAS repairs a divergent canonical file without restamping a healthy retry', async () => {
    const ctx = makeCtx();
    const created = await putPage.handler(ctx, { slug: 'scratch/cas-repair-stale', content: BODY }) as {
      write_through?: { path?: string };
    };
    const filePath = created.write_through!.path!;
    const page1 = await engine.getPage('scratch/cas-repair-stale');
    const hash1 = page1!.content_hash!;
    const updated1 = page1!.updated_at.getTime();
    fs.writeFileSync(filePath, BODY_FLIPPED);

    const repaired = await putPage.handler(ctx, {
      slug: 'scratch/cas-repair-stale',
      content: BODY,
      expected_content_hash: hash1,
    }) as {
      no_op?: boolean;
      file_repaired?: boolean;
      file_status?: string;
      write_through?: { written?: boolean };
    };
    expect(repaired.no_op).toBe(true);
    expect(repaired.file_repaired).toBe(true);
    expect(repaired.file_status).toBe('repaired');
    expect(repaired.write_through?.written).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('- [x] checkbox-1');
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('- [ ] checkbox-1');
    expect((await engine.getPage('scratch/cas-repair-stale'))!.updated_at.getTime()).toBe(updated1);

    await Bun.sleep(50);
    const healthy = await putPage.handler(ctx, {
      slug: 'scratch/cas-repair-stale',
      content: BODY,
      expected_content_hash: hash1,
    }) as {
      file_repaired?: boolean;
      file_status?: string;
      write_through?: { written?: boolean; skipped?: string };
    };
    const mtimeAfterRepair = fs.statSync(filePath).mtimeMs;
    expect(healthy.file_repaired).toBe(false);
    expect(healthy.file_status).toBe('healthy');
    expect(healthy.write_through?.written).toBe(false);
    expect(healthy.write_through?.skipped).toBe('unchanged');
    expect(fs.statSync(filePath).mtimeMs).toBe(mtimeAfterRepair);
  });
});
