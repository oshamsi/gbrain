import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  checkPagesIndexHeapParity,
  comparePageIdentitySets,
  type PageIndexIdentity,
} from '../src/core/pages-index-integrity.ts';
import { pagesIndexHeapParityCheck } from '../src/commands/doctor/checks/core-health.ts';

const A: PageIndexIdentity = { id: 1, source_id: 'default', slug: 'notes/a' };
const B: PageIndexIdentity = { id: 2, source_id: 'default', slug: 'notes/b' };
const C: PageIndexIdentity = { id: 3, source_id: 'default', slug: 'notes/c' };

describe('comparePageIdentitySets', () => {
  test('detects a missing indexed heap row', () => {
    const diff = comparePageIdentitySets([A, B], [A]);
    expect(diff.equal).toBe(false);
    expect(diff.missing).toEqual([B]);
    expect(diff.unexpected).toEqual([]);
  });

  test('detects equal-count but different row sets', () => {
    const diff = comparePageIdentitySets([A, B], [A, C]);
    expect(diff.equal).toBe(false);
    expect(diff.missing).toEqual([B]);
    expect(diff.unexpected).toEqual([C]);
  });

  test('detects a duplicate heap identity hidden by set comparison', () => {
    const diff = comparePageIdentitySets([A, A], [A]);
    expect(diff.equal).toBe(false);
    expect(diff.missing).toEqual([A]);
    expect(diff.unexpected).toEqual([]);
  });

  test('detects a duplicate physical index entry hidden by set comparison', () => {
    const diff = comparePageIdentitySets([A], [A, A]);
    expect(diff.equal).toBe(false);
    expect(diff.missing).toEqual([]);
    expect(diff.unexpected).toEqual([A]);
  });
});

describe('checkPagesIndexHeapParity', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('notes/a', {
      type: 'concept', title: 'A', compiled_truth: 'alpha', timeline: '', frontmatter: {},
    });
    await engine.putPage('notes/b', {
      type: 'concept', title: 'B', compiled_truth: 'beta', timeline: '', frontmatter: {},
    });
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('healthy PGLite heap matches both forced index scans', async () => {
    const result = await checkPagesIndexHeapParity(engine);
    expect(result.status).toBe('ok');
    expect(result.heapRows).toBe(2);
    expect(result.primaryIndexRows).toBe(2);
    expect(result.sourceSlugIndexRows).toBe(2);
    expect(result.plans.primary).toContain('pages_pkey');
    expect(result.plans.sourceSlug).toContain('pages_source_slug_key');
  });

  test('doctor emits an ok integrity check on a healthy store', async () => {
    const check = await pagesIndexHeapParityCheck(engine);
    expect(check.name).toBe('pages_index_heap_parity');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('2 rows');
  });

  test('stubbed physical mismatch fails with backup-first guidance', async () => {
    let scan: 'heap' | 'index' = 'heap';
    const statements: string[] = [];
    const stub = {
      transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(stub as unknown as BrainEngine),
      executeRaw: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("to_regclass('public.pages')")) return [{ present: true }];
        if (sql.includes('enable_indexscan = off')) { scan = 'heap'; return []; }
        if (sql.includes('enable_indexscan = on')) { scan = 'index'; return []; }
        if (sql.startsWith('SET LOCAL')) return [];
        if (sql.startsWith('EXPLAIN') && sql.includes('ORDER BY id')) {
          return [{ 'QUERY PLAN': 'Index Scan using pages_pkey on pages' }];
        }
        if (sql.startsWith('EXPLAIN')) {
          return [{ 'QUERY PLAN': 'Index Scan using pages_source_slug_key on pages' }];
        }
        if (sql.includes('ORDER BY source_id')) return scan === 'heap' ? [A, B] : [A];
        if (sql.includes('ORDER BY id')) return scan === 'heap' ? [A, B] : [A];
        return [];
      },
    } as unknown as BrainEngine;

    const check = await pagesIndexHeapParityCheck(stub);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('missing IDs');
    expect(check.message).toContain('unexpected IDs');
    expect(check.message).toContain('verified backup');
    expect(statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  });

  test('doctor reports unexpected duplicate index entries', async () => {
    let scan: 'heap' | 'index' = 'heap';
    const stub = {
      transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(stub as unknown as BrainEngine),
      executeRaw: async (sql: string) => {
        if (sql.includes("to_regclass('public.pages')")) return [{ present: true }];
        if (sql.includes('enable_indexscan = off')) { scan = 'heap'; return []; }
        if (sql.includes('enable_indexscan = on')) { scan = 'index'; return []; }
        if (sql.startsWith('SET')) return [];
        if (sql.startsWith('EXPLAIN') && sql.includes('ORDER BY id')) {
          return [{ 'QUERY PLAN': 'Index Scan using pages_pkey on pages' }];
        }
        if (sql.startsWith('EXPLAIN')) {
          return [{ 'QUERY PLAN': 'Index Scan using pages_source_slug_key on pages' }];
        }
        if (sql.includes('ORDER BY source_id')) return scan === 'heap' ? [A] : [A, A];
        if (sql.includes('ORDER BY id')) return scan === 'heap' ? [A] : [A, A];
        return [];
      },
    } as unknown as BrainEngine;

    const check = await pagesIndexHeapParityCheck(stub);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('unexpected IDs pkey=[1], source_slug=[1]');
    expect(check.details).toMatchObject({
      primary_unexpected_ids: [1],
      source_slug_unexpected_ids: [1],
    });
  });
});
