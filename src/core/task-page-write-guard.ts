/**
 * Semantic loss guard for the canonical `ops/tasks` tracker.
 *
 * The page is edited as one markdown document, so optimistic concurrency
 * prevents stale overwrites but cannot distinguish an intentional task
 * transition from a malformed edit that silently omits unrelated tasks.
 * This module parses only the stable task identity surface (checkbox + HTML
 * id marker) and verifies that every previously-active id remains accounted
 * for. It is pure so both engines share exactly one policy.
 */

export type TaskWriteGuardReason =
  | 'duplicate_ids'
  | 'active_ids_dropped'
  | 'invalid_removals';

export class TaskPageWriteGuardError extends Error {
  constructor(
    public readonly reason: TaskWriteGuardReason,
    public readonly taskIds: string[],
    message: string,
  ) {
    super(message);
    this.name = 'TaskPageWriteGuardError';
  }
}

type TaskState = 'active' | 'completed' | 'deferred';

interface ParsedTasks {
  byId: Map<string, TaskState>;
  duplicateIds: string[];
}

const HEADING_RE = /^\s*#{2,6}\s+(.+?)\s*$/;
const TASK_LINE_RE = /^ {0,3}[-*+]\s+\[([ xX])\]\s+<!--\s*id:\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s*-->(.*)$/;

function normalizedId(id: string): string {
  return id.trim().toLowerCase();
}

function parseTasks(content: string): ParsedTasks {
  const byId = new Map<string, TaskState>();
  const duplicateIds = new Set<string>();
  let section = '';
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (fence) {
      const close = line.match(/^ {0,3}([`~]+)[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { marker: open[1][0] as '`' | '~', length: open[1].length };
      continue;
    }
    if (line.trim().toLowerCase() === '<!-- timeline -->') break;
    const heading = line.match(HEADING_RE);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      if (section === 'timeline') break;
      continue;
    }

    const task = line.match(TASK_LINE_RE);
    if (!task) continue;
    const id = normalizedId(task[2]);
    const checked = task[1].toLowerCase() === 'x';
    const tail = task[3].toLowerCase();
    const state: TaskState = checked
      ? 'completed'
      : section.includes('deferred') || tail.includes('deferred until:')
        ? 'deferred'
        : 'active';

    if (byId.has(id)) duplicateIds.add(id);
    else byId.set(id, state);
  }

  return { byId, duplicateIds: [...duplicateIds].sort() };
}

/**
 * Assert that one whole-page task rewrite preserves every prior active id.
 *
 * Completion and deferral retain the id in the markdown with an explicit
 * checkbox/section marker. Removal is the sole transition whose id vanishes,
 * so the caller must name it separately in `removedTaskIds`.
 */
export function assertSafeTaskPageWrite(
  previousContent: string | null,
  incomingContent: string,
  removedTaskIds: readonly string[] = [],
): void {
  const previous = parseTasks(previousContent ?? '');
  const incoming = parseTasks(incomingContent);

  if (incoming.duplicateIds.length > 0) {
    throw new TaskPageWriteGuardError(
      'duplicate_ids',
      incoming.duplicateIds,
      `ops/tasks contains duplicate task id(s): ${incoming.duplicateIds.join(', ')}`,
    );
  }

  const normalizedRemovals = removedTaskIds.map(normalizedId);
  const removalSet = new Set(normalizedRemovals);
  const duplicateRemovals = [...new Set(
    normalizedRemovals.filter((id, index) => normalizedRemovals.indexOf(id) !== index),
  )].sort();
  const invalidRemovals = new Set<string>(duplicateRemovals);

  for (const id of removalSet) {
    if (previous.byId.get(id) !== 'active' || incoming.byId.has(id)) {
      invalidRemovals.add(id);
    }
  }
  if (invalidRemovals.size > 0) {
    const ids = [...invalidRemovals].sort();
    throw new TaskPageWriteGuardError(
      'invalid_removals',
      ids,
      `ops/tasks removal declaration is invalid for task id(s): ${ids.join(', ')}`,
    );
  }

  const dropped: string[] = [];
  for (const [id, state] of previous.byId) {
    if (state !== 'active') continue;
    if (!incoming.byId.has(id) && !removalSet.has(id)) dropped.push(id);
  }
  if (dropped.length > 0) {
    dropped.sort();
    throw new TaskPageWriteGuardError(
      'active_ids_dropped',
      dropped,
      `ops/tasks write silently drops active task id(s): ${dropped.join(', ')}`,
    );
  }
}
