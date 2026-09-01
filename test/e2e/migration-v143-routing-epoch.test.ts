/**
 * E2E: migration v143 routing-epoch distinct-value triggers on real Postgres.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-v143-routing-epoch.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping v143 routing-epoch E2E tests (DATABASE_URL not set)');
}

const v142 = MIGRATIONS.find((m) => m.version === 142);
const v143 = MIGRATIONS.find((m) => m.version === 143);

describeE2E('migration v143: distinct-value routing epoch (Postgres)', () => {
  beforeAll(async () => {
    await setupDB();
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('v142 same-value UPDATE is +1; v143 is +0; real route change is +1', async () => {
    const engine = getEngine();
    expect(v142?.sql).toBeTruthy();
    expect(v143?.sql).toBeTruthy();

    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, title, type, compiled_truth)
       VALUES ('default', 'inbox/v143-pg', 'PG', 'note', 'BODY')
       ON CONFLICT (source_id, slug) DO NOTHING`,
    );

    const epoch = async (): Promise<bigint> => {
      const [row] = await engine.executeRaw<{ epoch: string }>(
        `SELECT epoch::text AS epoch FROM canonical_routing_state WHERE singleton = 1`,
      );
      return BigInt(row!.epoch);
    };
    const delta = async (work: () => Promise<void>): Promise<bigint> => {
      const before = await epoch();
      await work();
      return (await epoch()) - before;
    };

    await engine.runMigration(142, v142!.sql!);
    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET page_kind = page_kind, source_path = source_path,
                          source_uri = source_uri
          WHERE source_id = 'default' AND slug = 'inbox/v143-pg'`,
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
          WHERE source_id = 'default' AND slug = 'inbox/v143-pg'`,
      );
    })).toBe(0n);
    expect(await delta(async () => {
      await engine.executeRaw(
        `UPDATE pages SET source_path = 'inbox/v143-pg.md'
          WHERE source_id = 'default' AND slug = 'inbox/v143-pg'`,
      );
    })).toBe(1n);
  });
});
