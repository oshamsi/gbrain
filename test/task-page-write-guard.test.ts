import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertSafeTaskPageWrite,
  TaskPageWriteGuardError,
} from '../src/core/task-page-write-guard.ts';

const task = (id: string, text: string, checked = false) =>
  `- [${checked ? 'x' : ' '}] <!-- id: ${id} --> ${text}`;

function expectGuardError(
  previous: string | null,
  incoming: string,
  removed: string[] = [],
): TaskPageWriteGuardError {
  try {
    assertSafeTaskPageWrite(previous, incoming, removed);
  } catch (error) {
    expect(error).toBeInstanceOf(TaskPageWriteGuardError);
    return error as TaskPageWriteGuardError;
  }
  throw new Error('expected task-page write guard to reject');
}

describe('ops/tasks semantic whole-page guard', () => {
  test('rejects a silent drop of any previously-active id', () => {
    const before = `## P1 — Today\n${task('t-20260115-01', 'keep me')}\n${task('t-20260115-02', 'also keep me')}`;
    const after = `## P1 — Today\n${task('t-20260115-02', 'also keep me')}`;
    const error = expectGuardError(before, after);
    expect(error.reason).toBe('active_ids_dropped');
    expect(error.taskIds).toEqual(['t-20260115-01']);
  });

  test('rejects duplicate incoming ids across sections and case variants', () => {
    const duplicate = [
      '## P1 — Today',
      task('t-20260115-01', 'one'),
      '## Completed',
      task('T-20260115-01', 'copy', true),
    ].join('\n');
    const error = expectGuardError(null, duplicate);
    expect(error.reason).toBe('duplicate_ids');
    expect(error.taskIds).toEqual(['t-20260115-01']);
  });

  test('accepts retained, completed, and explicitly deferred transitions', () => {
    const before = [
      '## P1 — Today',
      task('t-20260115-01', 'retained'),
      task('t-20260115-02', 'complete'),
      task('t-20260115-03', 'defer'),
    ].join('\n');
    const after = [
      '## P2 — This Week',
      task('t-20260115-01', 'retained with an edit'),
      '## Deferred',
      task('t-20260115-03', 'defer (deferred until: 2026-02-01; reason: waiting)'),
      '## Completed',
      task('t-20260115-02', 'complete (completed: 2026-01-16)', true),
    ].join('\n');
    expect(() => assertSafeTaskPageWrite(before, after)).not.toThrow();
  });

  test('accepts only an explicitly-declared removal', () => {
    const before = `## P3 — Backlog\r\n${task('t-20260115-01', 'remove me')}\r\n${task('t-20260115-02', 'keep me')}`;
    const after = `## P3 — Backlog\n${task('t-20260115-02', 'keep me')}`;
    expect(() => assertSafeTaskPageWrite(before, after, ['t-20260115-01'])).not.toThrow();
  });

  test('rejects unknown, duplicate, or still-present removal declarations', () => {
    const before = `## P3 — Backlog\n${task('t-20260115-01', 'active')}`;
    const stillThere = `## P3 — Backlog\n${task('t-20260115-01', 'active')}`;
    expect(expectGuardError(before, stillThere, ['t-20260115-01']).reason).toBe('invalid_removals');
    expect(expectGuardError(before, '', ['t-unknown']).reason).toBe('invalid_removals');
    expect(expectGuardError(before, '', ['t-20260115-01', 'T-20260115-01']).reason).toBe('invalid_removals');
  });

  test('plain-text id mentions and multiline details are not task identities', () => {
    const before = `## P1 — Today\n${task('t-20260115-01', 'real task')}\n  detail mentions t-20260115-02`;
    const after = `${before}\n\n## Timeline\n- recovery referenced t-20260115-01 again`;
    expect(() => assertSafeTaskPageWrite(before, after)).not.toThrow();
  });

  test('a task-shaped audit line after the timeline boundary cannot mask a drop', () => {
    const before = `## P1 — Today\n${task('t-20260115-01', 'real task')}`;
    const after = `## P1 — Today\n\n<!-- timeline -->\n## Timeline\n${task('t-20260115-01', 'audit copy')}`;
    const error = expectGuardError(before, after);
    expect(error.reason).toBe('active_ids_dropped');
  });

  test('task-shaped lines inside backtick or tilde fences cannot mask a drop', () => {
    const before = `## P1 — Today\n${task('t-20260115-01', 'real task')}`;
    for (const fence of ['```md', '~~~~ markdown']) {
      const close = fence.startsWith('`') ? '```' : '~~~~';
      const after = `## P1 — Today\n${fence}\n${task('t-20260115-01', 'example only')}\n${close}`;
      expect(expectGuardError(before, after).reason).toBe('active_ids_dropped');
    }
  });

  test('task-shaped indented code cannot mask a drop', () => {
    const before = `## P1 — Today\n${task('t-20260115-01', 'real task')}`;
    for (const indent of ['    ', '\t']) {
      const after = `## P1 — Today\n${indent}${task('t-20260115-01', 'code example')}`;
      expect(expectGuardError(before, after).reason).toBe('active_ids_dropped');
    }
  });

  test('allows repairing duplicate ids that exist only in the prior page', () => {
    const before = `## P1 — Today\n${task('t-20260115-01', 'one')}\n${task('t-20260115-01', 'duplicate')}`;
    const after = `## P1 — Today\n${task('t-20260115-01', 'one repaired')}`;
    expect(() => assertSafeTaskPageWrite(before, after)).not.toThrow();
  });
});

test('daily-task-manager first run re-reads the initialized page for its hash', () => {
  const skill = readFileSync(new URL('../skills/daily-task-manager/SKILL.md', import.meta.url), 'utf8');
  expect(skill).toContain('then immediately call `get_page("ops/tasks", include_content: true)` again');
  expect(skill).toContain('the create response does not provide the hash needed for the next write');
});
