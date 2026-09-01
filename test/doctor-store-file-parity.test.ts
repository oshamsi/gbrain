import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { computeStoreFileParity } from '../src/core/page-plane-parity.ts';
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-parity-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
  _resetWriteThroughCacheForTest();
});

describe('computeStoreFileParity', () => {
  test('exact match is zero-divergent', async () => {
    await importFromContent(engine, 'inbox/ok', '---\ntitle: Ok\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/ok', { sourceId: 'default' });
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.divergent_pages).toBe(0);
    expect(report.hash_mismatches).toBe(0);
  });

  test('same-length ingested_at byte change warns despite equal semantic hash', async () => {
    await importFromContent(engine, 'inbox/ts', '---\ntitle: Ts\n---\n\nbody\n', {
      noEmbed: true,
      sourceId: 'default',
      source_kind: 'put_page',
      ingested_via: 'put_page',
    });
    await writePageThrough(engine, 'inbox/ts', { sourceId: 'default' });
    const file = path.join(brainDir, 'inbox/ts.md');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/ingested_at:/);
    const mutated = text.replace(/(\d)(\d)(?=\d*Z)/, '$2$1');
    expect(mutated).not.toBe(text);
    expect(mutated.length).toBe(text.length);
    fs.writeFileSync(file, mutated);
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.divergent_pages).toBeGreaterThan(0);
    expect(report.hash_mismatches + report.size_mismatches).toBeGreaterThan(0);
  });

  test('missing file is divergent', async () => {
    await importFromContent(engine, 'inbox/miss', '---\ntitle: M\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/miss', { sourceId: 'default' });
    fs.unlinkSync(path.join(brainDir, 'inbox/miss.md'));
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.missing_files).toBe(1);
    expect(report.divergent_pages).toBeGreaterThan(0);
  });

  test('NULL projection is unmeasured', async () => {
    await engine.putPage('inbox/nullproj', {
      type: 'note',
      title: 'N',
      compiled_truth: 'body',
      timeline: '',
      frontmatter: {},
    });
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.unmeasured_pages).toBeGreaterThan(0);
    expect(report.divergent_pages).toBeGreaterThan(0);
  });

  test('write_through disabled pages are not_projected', async () => {
    await engine.setConfig('sync.write_through', 'false');
    await importFromContent(engine, 'inbox/dbo', '---\ntitle: D\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.not_projected_pages).toBeGreaterThan(0);
    expect(report.divergent_pages).toBe(0);
  });

  test('direct row update without projection refresh is stale_projection', async () => {
    await importFromContent(engine, 'inbox/stale', '---\ntitle: S\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/stale', { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'mutated without projection' WHERE slug = $1`,
      ['inbox/stale'],
    );
    const stored = await loadCanonicalProjection(engine, 'default', 'inbox/stale');
    expect(stored).not.toBeNull();
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.stale_projections).toBeGreaterThan(0);
    expect(report.divergent_pages).toBeGreaterThan(0);
  });

  test('configured-but-missing repo is divergent, not not_projected', async () => {
    await importFromContent(engine, 'inbox/lost', '---\ntitle: Lost\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/lost', { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [path.join(tmpRoot, 'does-not-exist')],
    );
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.not_projected_pages).toBe(0);
    expect(report.divergent_pages).toBeGreaterThan(0);
    expect(report.sample.some((s) => s.reason === 'repo_not_found')).toBe(true);
  });

  test('source-scoped leak guard still sees sibling local_path roots', async () => {
    const sibling = path.join(tmpRoot, 'sibling');
    fs.mkdirSync(sibling, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', $1)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [sibling],
    );
    await engine.setConfig('sync.repo_path', sibling);
    await importFromContent(engine, 'inbox/leak', '---\ntitle: Leak\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    const scoped = await computeStoreFileParity(engine, { sourceId: 'default' });
    const unscoped = await computeStoreFileParity(engine);
    expect(scoped.not_projected_pages).toBeGreaterThan(0);
    expect(scoped.divergent_pages).toBe(0);
    expect(unscoped.not_projected_pages).toBeGreaterThan(0);
  });

  test('sample is divergent-only and lexicographically stable', async () => {
    for (const slug of ['inbox/z-last', 'inbox/a-first', 'inbox/m-mid']) {
      await importFromContent(engine, slug, `---\ntitle: ${slug}\n---\n\nbody\n`, { noEmbed: true, sourceId: 'default' });
      await writePageThrough(engine, slug, { sourceId: 'default' });
      fs.unlinkSync(path.join(brainDir, `${slug}.md`));
    }
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.sample.every((s) => s.reason !== 'not_projected')).toBe(true);
    expect(report.sample[0]?.slug).toBe('inbox/a-first');
  });

  test('BIGINT generations above MAX_SAFE_INTEGER compare losslessly', async () => {
    await importFromContent(engine, 'inbox/big', '---\ntitle: Big\n---\n\nbody\n', { noEmbed: true, sourceId: 'default' });
    await writePageThrough(engine, 'inbox/big', { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE pages
          SET canonical_input_generation = 9007199254740993,
              canonical_basis_generation = 9007199254740992
        WHERE slug = $1 AND source_id = $2`,
      ['inbox/big', 'default'],
    );
    const report = await computeStoreFileParity(engine, { sourceId: 'default' });
    expect(report.stale_projections).toBeGreaterThan(0);
    expect(report.divergent_pages).toBeGreaterThan(0);
  });
});
