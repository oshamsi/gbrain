import type { BrainEngine } from './engine.ts';

export interface PageIndexIdentity {
  id: number;
  source_id: string;
  slug: string;
}

export interface PageIdentitySetDiff {
  equal: boolean;
  missing: PageIndexIdentity[];
  unexpected: PageIndexIdentity[];
}

export interface PagesIndexHeapParityResult {
  tablePresent: boolean;
  status: 'ok' | 'mismatch' | 'inconclusive';
  heapRows: number;
  primaryIndexRows: number;
  sourceSlugIndexRows: number;
  primaryDiff: PageIdentitySetDiff;
  sourceSlugDiff: PageIdentitySetDiff;
  plans: {
    primary: string;
    sourceSlug: string;
  };
  reason?: string;
}

function identityKey(row: PageIndexIdentity): string {
  return `${Number(row.id)}\u0000${row.source_id}\u0000${row.slug}`;
}

function normalizeIdentity(row: PageIndexIdentity): PageIndexIdentity {
  return { id: Number(row.id), source_id: row.source_id, slug: row.slug };
}

/** Exact multiset comparison. Equal row counts are not sufficient: a damaged
 * index can omit one heap row while exposing a different stale row, and plain
 * set comparison would hide duplicate physical entries. */
export function comparePageIdentitySets(
  heapRows: PageIndexIdentity[],
  indexRows: PageIndexIdentity[],
): PageIdentitySetDiff {
  const toMultiset = (rows: PageIndexIdentity[]) => {
    const counts = new Map<string, { row: PageIndexIdentity; count: number }>();
    for (const value of rows) {
      const row = normalizeIdentity(value);
      const key = identityKey(row);
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { row, count: 1 });
    }
    return counts;
  };
  const repeat = (row: PageIndexIdentity, count: number): PageIndexIdentity[] =>
    Array.from({ length: count }, () => row);
  const sort = (rows: PageIndexIdentity[]) => rows.sort(
    (a, b) => a.id - b.id || a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug),
  );

  // Compare multiplicity as well as identity. An index with a duplicated
  // physical entry must not look healthy merely because a Map deduplicated it.
  const heap = toMultiset(heapRows);
  const indexed = toMultiset(indexRows);
  const missing = sort([...heap.entries()].flatMap(([key, value]) =>
    repeat(value.row, Math.max(0, value.count - (indexed.get(key)?.count ?? 0))),
  ));
  const unexpected = sort([...indexed.entries()].flatMap(([key, value]) =>
    repeat(value.row, Math.max(0, value.count - (heap.get(key)?.count ?? 0))),
  ));
  return { equal: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

function explainText(rows: Array<Record<string, unknown>>): string {
  return rows
    .map((row) => String(row['QUERY PLAN'] ?? Object.values(row)[0] ?? ''))
    .join('\n');
}

const EMPTY_DIFF: PageIdentitySetDiff = { equal: true, missing: [], unexpected: [] };

/**
 * Compare the physical pages heap with two forced B-tree traversals.
 *
 * pg_index.indisvalid only describes catalog state; it remains true when an
 * index silently loses heap entries. The planner controls and all reads run
 * inside one transaction so SET LOCAL cannot leak to pooled callers and every
 * result observes one snapshot.
 */
export async function checkPagesIndexHeapParity(
  engine: BrainEngine,
): Promise<PagesIndexHeapParityResult> {
  return engine.transaction(async (tx) => {
    // PostgreSQL transactions default to READ COMMITTED, where each statement
    // gets a new snapshot. Pin one snapshot before even the catalog probe so a
    // normal concurrent page write cannot manufacture a heap/index mismatch.
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const table = await tx.executeRaw<{ present: boolean }>(
      `SELECT to_regclass('public.pages') IS NOT NULL AS present`,
    );
    if (!table[0]?.present) {
      return {
        tablePresent: false,
        status: 'ok',
        heapRows: 0,
        primaryIndexRows: 0,
        sourceSlugIndexRows: 0,
        primaryDiff: EMPTY_DIFF,
        sourceSlugDiff: EMPTY_DIFF,
        plans: { primary: '', sourceSlug: '' },
      };
    }

    await tx.executeRaw('SET LOCAL enable_indexscan = off');
    await tx.executeRaw('SET LOCAL enable_indexonlyscan = off');
    await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
    await tx.executeRaw('SET LOCAL enable_seqscan = on');
    const heap = await tx.executeRaw<PageIndexIdentity>(
      'SELECT id, source_id, slug FROM pages ORDER BY id',
    );

    await tx.executeRaw('SET LOCAL enable_seqscan = off');
    await tx.executeRaw('SET LOCAL enable_bitmapscan = off');
    await tx.executeRaw('SET LOCAL enable_indexscan = on');
    await tx.executeRaw('SET LOCAL enable_indexonlyscan = on');
    await tx.executeRaw('SET LOCAL enable_sort = off');
    await tx.executeRaw('SET LOCAL enable_incremental_sort = off');

    const primaryPlanRows = await tx.executeRaw<Record<string, unknown>>(
      'EXPLAIN (FORMAT TEXT) SELECT id, source_id, slug FROM pages ORDER BY id',
    );
    const primaryPlan = explainText(primaryPlanRows);
    const primary = await tx.executeRaw<PageIndexIdentity>(
      'SELECT id, source_id, slug FROM pages ORDER BY id',
    );

    const sourceSlugPlanRows = await tx.executeRaw<Record<string, unknown>>(
      'EXPLAIN (FORMAT TEXT) SELECT id, source_id, slug FROM pages ORDER BY source_id, slug',
    );
    const sourceSlugPlan = explainText(sourceSlugPlanRows);
    const sourceSlug = await tx.executeRaw<PageIndexIdentity>(
      'SELECT id, source_id, slug FROM pages ORDER BY source_id, slug',
    );

    const primaryDiff = comparePageIdentitySets(heap, primary);
    const sourceSlugDiff = comparePageIdentitySets(heap, sourceSlug);
    const primaryPlanConfirmed = primaryPlan.includes('pages_pkey');
    const sourceSlugPlanConfirmed = sourceSlugPlan.includes('pages_source_slug_key');
    if (!primaryPlanConfirmed || !sourceSlugPlanConfirmed) {
      const missingPlans = [
        !primaryPlanConfirmed ? 'pages_pkey' : null,
        !sourceSlugPlanConfirmed ? 'pages_source_slug_key' : null,
      ].filter(Boolean).join(', ');
      return {
        tablePresent: true,
        status: 'inconclusive',
        heapRows: heap.length,
        primaryIndexRows: primary.length,
        sourceSlugIndexRows: sourceSlug.length,
        primaryDiff,
        sourceSlugDiff,
        plans: { primary: primaryPlan, sourceSlug: sourceSlugPlan },
        reason: `planner did not confirm forced traversal through ${missingPlans}`,
      };
    }

    return {
      tablePresent: true,
      status: primaryDiff.equal && sourceSlugDiff.equal ? 'ok' : 'mismatch',
      heapRows: heap.length,
      primaryIndexRows: primary.length,
      sourceSlugIndexRows: sourceSlug.length,
      primaryDiff,
      sourceSlugDiff,
      plans: { primary: primaryPlan, sourceSlug: sourceSlugPlan },
    };
  });
}
