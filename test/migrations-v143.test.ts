/**
 * Migration v143 — canonical_routing_distinct_value_triggers.
 *
 * Same-value route-column updates must not bump the convergence epoch.
 * Page/source membership INSERT/DELETE still bump. Config bumps only when
 * the (key,value) pair of a relevant key actually changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.generated.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

const SPLIT_TRIGGERS = [
  'bump_canonical_routing_from_page_insert_delete_trg',
  'bump_canonical_routing_from_page_update_trg',
  'bump_canonical_routing_from_source_insert_delete_trg',
  'bump_canonical_routing_from_source_update_trg',
] as const;

const v142 = MIGRATIONS.find((m) => m.version === 142);
const v143 = MIGRATIONS.find((m) => m.version === 143);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function epoch(): Promise<bigint> {
  const [row] = await engine.executeRaw<{ epoch: string }>(
    `SELECT epoch::text AS epoch FROM canonical_routing_state WHERE singleton = 1`,
  );
  return BigInt(row!.epoch);
}

async function triggerNames(): Promise<string[]> {
  const rows = await engine.executeRaw<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgname LIKE 'bump_canonical_routing%'
      ORDER BY tgname`,
  );
  return rows.map((r) => r.tgname);
}

async function delta(work: () => Promise<void>): Promise<bigint> {
  const before = await epoch();
  await work();
  return (await epoch()) - before;
}

describe('migration v143 — structure', () => {
  test('named canonical_routing_distinct_value_triggers, idempotent, shared SQL', () => {
    expect(v143).toBeDefined();
    expect(v143?.name).toBe('canonical_routing_distinct_value_triggers');
    expect(v143?.idempotent).toBe(true);
    expect(v143?.sqlFor).toBeUndefined();
    expect(v143?.sql).toBeTruthy();
    for (const blob of [SCHEMA_SQL, PGLITE_SCHEMA_SQL, v143!.sql!]) {
      expect(blob).toContain('bump_canonical_routing_from_page_insert_delete_trg');
      expect(blob).toContain('bump_canonical_routing_from_page_update_trg');
      expect(blob).toContain('bump_canonical_routing_from_source_insert_delete_trg');
      expect(blob).toContain('bump_canonical_routing_from_source_update_trg');
      expect(blob).toContain('IS DISTINCT FROM');
      expect(blob).toContain('ROW(OLD.key, OLD.value) IS DISTINCT FROM ROW(NEW.key, NEW.value)');
    }
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(143);
  });
});

describe('migration v143 — value-sensitive epoch (PGLite)', () => {
  test('page/source/config membership and distinct values bump; same-value does not', async () => {
    expect(await delta(async () => {
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, title, type, compiled_truth)
         VALUES ('default', 'inbox/v143-page', 'V143', 'note', 'BODY')`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET page_kind = page_kind, source_path = source_path,
                          source_uri = source_uri
          WHERE source_id = 'default' AND slug = 'inbox/v143-page'`,
      );
    })).toBe(0n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET source_path = 'inbox/v143-page.md'
          WHERE source_id = 'default' AND slug = 'inbox/v143-page'`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `DELETE FROM pages WHERE source_id = 'default' AND slug = 'inbox/v143-page'`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path) VALUES ('v143src', 'v143src', '/tmp/v143src')
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE sources SET id = id, local_path = local_path, archived = archived,
                            config = config, trust_frontmatter_overrides = trust_frontmatter_overrides
          WHERE id = 'v143src'`,
      );
    })).toBe(0n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE sources SET local_path = '/tmp/v143src-b' WHERE id = 'v143src'`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'v143src'`);
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sync.repo_path', '/tmp/v143-repo')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE config SET value = value WHERE key = 'sync.repo_path'`,
      );
    })).toBe(0n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE config SET value = '/tmp/v143-repo-b' WHERE key = 'sync.repo_path'`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `INSERT INTO config (key, value) VALUES ('unrelated.v143', 'x')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    })).toBe(0n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE config SET key = 'sync.write_through', value = 'x'
          WHERE key = 'unrelated.v143'`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE config SET key = 'unrelated.v143-b', value = 'x'
          WHERE key = 'sync.write_through'`,
      );
    })).toBe(1n);

    expect(await delta(async () => {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'unrelated.v143-b'`);
    })).toBe(0n);

    expect(await delta(async () => {
      await engine.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sync.repo_path', 'same')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
    })).toBe(1n);
    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE config SET key = 'sync.write_through', value = 'same'
          WHERE key = 'sync.repo_path'`,
      );
    })).toBe(1n);
  });
});

describe('migration v143 — upgrade from v142 (PGLite)', () => {
  test('v142 same-value UPDATE is +1; v143 makes it +0 and is SQL-idempotent', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, title, type, compiled_truth)
       VALUES ('default', 'inbox/v143-upgrade', 'U', 'note', 'BODY')
       ON CONFLICT (source_id, slug) DO NOTHING`,
    );
    expect(v142?.sql).toBeTruthy();
    await engine.runMigration(142, v142!.sql!);
    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET page_kind = page_kind, source_path = source_path,
                          source_uri = source_uri
          WHERE source_id = 'default' AND slug = 'inbox/v143-upgrade'`,
      );
    })).toBe(1n);

    await engine.setConfig('version', '142');
    const applied = await runMigrations(engine);
    expect(applied.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET page_kind = page_kind, source_path = source_path,
                          source_uri = source_uri
          WHERE source_id = 'default' AND slug = 'inbox/v143-upgrade'`,
      );
    })).toBe(0n);
    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET source_path = 'inbox/v143-upgrade.md'
          WHERE source_id = 'default' AND slug = 'inbox/v143-upgrade'`,
      );
    })).toBe(1n);

    await engine.runMigration(143, v143!.sql!);
    await engine.runMigration(143, v143!.sql!);
    const names = await triggerNames();
    for (const name of SPLIT_TRIGGERS) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET page_kind = page_kind
          WHERE source_id = 'default' AND slug = 'inbox/v143-upgrade'`,
      );
    })).toBe(0n);

    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);
  });
});
