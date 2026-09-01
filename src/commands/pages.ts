/**
 * gbrain pages — page-level operator commands. v0.26.5+.
 *
 * Subcommands:
 *   pages purge-deleted [--older-than HOURS] [--dry-run]
 *   pages converge-canonical --source <id> [--dry-run | --yes] [--json]
 */
import type { BrainEngine } from '../core/engine.ts';
import { formatConvergenceReport, runCanonicalPlaneConvergence } from '../core/page-plane-convergence.ts';

const SOFT_DELETE_TTL_HOURS_DEFAULT = 72;

function parseOlderThanHours(args: string[]): number {
  const idx = args.indexOf('--older-than');
  if (idx === -1 || idx === args.length - 1) return SOFT_DELETE_TTL_HOURS_DEFAULT;
  const raw = args[idx + 1];
  const trimmed = raw.trim();
  const dayMatch = trimmed.match(/^(\d+)d$/);
  if (dayMatch) return Math.max(0, parseInt(dayMatch[1], 10) * 24);
  const hourMatch = trimmed.match(/^(\d+)h?$/);
  if (hourMatch) return Math.max(0, parseInt(hourMatch[1], 10));
  console.error(`Invalid --older-than value: "${raw}". Expected hours (e.g. 72 or 72h) or days (e.g. 3d).`);
  process.exit(2);
}

function parseSourceFlag(args: string[]): string | null {
  const idx = args.indexOf('--source');
  if (idx === -1 || idx === args.length - 1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

async function runPurgeDeleted(engine: BrainEngine, args: string[]): Promise<void> {
  const olderThanHours = parseOlderThanHours(args);
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');

  if (dryRun) {
    const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true });
    if (json) {
      console.log(JSON.stringify({ dry_run: true, older_than_hours: olderThanHours, count: preview.count, slugs: preview.slugs }, null, 2));
      return;
    }
    console.log(`(dry-run) Would purge ${preview.count} page(s) soft-deleted more than ${olderThanHours}h ago.`);
    for (const p of preview.pages ?? []) console.log(`  ${p.slug}  deleted_at=${p.deleted_at.toISOString()}`);
    return;
  }

  const result = await engine.purgeDeletedPages(olderThanHours);
  if (json) {
    console.log(JSON.stringify({ older_than_hours: olderThanHours, count: result.count, slugs: result.slugs }, null, 2));
    return;
  }
  if (result.count === 0) {
    console.log(`No pages to purge (older than ${olderThanHours}h).`);
  } else {
    console.log(`Purged ${result.count} page(s) (older than ${olderThanHours}h):`);
    for (const slug of result.slugs) console.log(`  ${slug}`);
  }
}

async function runConvergeCanonical(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = parseSourceFlag(args);
  const json = args.includes('--json');
  const yes = args.includes('--yes');
  const dryRunFlag = args.includes('--dry-run');
  if (!sourceId) {
    console.error('gbrain pages converge-canonical requires --source <source-id>.');
    process.exit(2);
  }
  if (yes && dryRunFlag) {
    console.error('Pass either --dry-run or --yes, not both.');
    process.exit(2);
  }
  const { report, exitCode } = await runCanonicalPlaneConvergence(engine, {
    sourceId,
    yes,
    json,
  });
  console.log(formatConvergenceReport(report, json));
  if (exitCode !== 0) process.exit(exitCode);
}

function printHelp(): void {
  console.log(`gbrain pages — page-level operator commands (v0.26.5)

Subcommands:
  purge-deleted [--older-than HOURS|Nd] [--dry-run] [--json]
                                    Hard-delete soft-deleted pages older than the cutoff
                                    (default 72h). Cascades to chunks/links/edges.
                                    Mirror of the autopilot purge phase.

  converge-canonical --source <id> [--dry-run | --yes] [--json]
                                    Backfill stored canonical projections and rewrite
                                    existing files that differ. Dry-run is the default;
                                    refuse mutation without --yes. Never recreates
                                    missing files.

Notes:
  Soft-delete a page via the MCP \`delete_page\` op. Restore via \`restore_page\`.
  This command is the manual operator escape hatch — the autopilot cycle's
  purge phase already calls the same library function on every run.
`);
}

export async function runPages(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'purge-deleted': return runPurgeDeleted(engine, rest);
    case 'converge-canonical': return runConvergeCanonical(engine, rest);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}
