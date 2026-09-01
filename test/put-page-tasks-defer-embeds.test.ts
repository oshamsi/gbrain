import { describe, expect, test } from 'bun:test';
import { shouldDeferPutPageEmbeds } from '../src/core/ops/pages.ts';

describe('put_page embedding policy for the canonical task tracker', () => {
  test('always defers ops/tasks so task leases never wait on an embedder', () => {
    expect(shouldDeferPutPageEmbeds('ops/tasks', false, true)).toBe(true);
    expect(shouldDeferPutPageEmbeds('OPS/TASKS', false, true)).toBe(true);
  });

  test('preserves the existing policy for ordinary pages', () => {
    expect(shouldDeferPutPageEmbeds('projects/hive', true, true)).toBe(true);
    expect(shouldDeferPutPageEmbeds('projects/hive', false, false)).toBe(true);
    expect(shouldDeferPutPageEmbeds('projects/hive', false, true)).toBe(false);
  });
});
