/**
 * ABOUTME: Tests for the task health checker.
 */

import { describe, test, expect } from 'bun:test';
import { checkTaskHealth, applyHealthFixes } from './task-health-checker.js';
import type { TrackerTask } from '../plugins/trackers/types.js';

function task(id: string, overrides: Partial<TrackerTask> = {}): TrackerTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    priority: 2,
    dependsOn: [],
    blocks: [],
    ...overrides,
  };
}

describe('checkTaskHealth', () => {
  test('returns healthy for all completed tasks', () => {
    const tasks = [
      task('A', { status: 'completed' }),
      task('B', { status: 'completed', dependsOn: ['A'] }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.healthy).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('detects deadlock: in_progress with incomplete dependency', () => {
    const tasks = [
      task('A', { status: 'open' }),
      task('B', { status: 'in_progress', dependsOn: ['A'] }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.healthy).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe('deadlock');
    expect(result.issues[0].taskId).toBe('B');
    expect(result.fixedTaskIds).toContain('B');
  });

  test('does not flag in_progress with completed dependency', () => {
    const tasks = [
      task('A', { status: 'completed' }),
      task('B', { status: 'in_progress', dependsOn: ['A'] }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.issues.filter((i) => i.type === 'deadlock')).toHaveLength(0);
  });

  test('detects multiple deadlocked tasks', () => {
    const tasks = [
      task('A', { status: 'open' }),
      task('B', { status: 'in_progress', dependsOn: ['A'] }),
      task('C', { status: 'in_progress', dependsOn: ['A'] }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.issues.filter((i) => i.type === 'deadlock')).toHaveLength(2);
    expect(result.fixedTaskIds).toContain('B');
    expect(result.fixedTaskIds).toContain('C');
  });

  test('detects missing dependency', () => {
    const tasks = [
      task('A', { status: 'in_progress', dependsOn: ['NONEXISTENT'] }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.issues.some((i) => i.type === 'missing_dependency')).toBe(true);
  });

  test('detects orphaned task (stale in_progress)', () => {
    const oldDate = new Date(Date.now() - 4 * 3_600_000).toISOString(); // 4 hours ago
    const tasks = [
      task('A', { status: 'in_progress', updatedAt: oldDate }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.issues.some((i) => i.type === 'orphaned')).toBe(true);
    expect(result.fixedTaskIds).toContain('A');
  });

  test('does not flag fresh in_progress tasks as orphaned', () => {
    const recentDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const tasks = [
      task('A', { status: 'in_progress', updatedAt: recentDate }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.issues.filter((i) => i.type === 'orphaned')).toHaveLength(0);
  });

  test('builds correct summary', () => {
    const tasks = [
      task('A', { status: 'open' }),
      task('B', { status: 'in_progress', dependsOn: ['A'] }),
    ];
    const result = checkTaskHealth(tasks);
    expect(result.summary).toContain('1 error');
    expect(result.summary).toContain('1 task');
  });
});

describe('applyHealthFixes', () => {
  test('resets deadlocked tasks to open', () => {
    const tasks = [
      task('A', { status: 'open' }),
      task('B', { status: 'in_progress', dependsOn: ['A'] }),
    ];
    const healthResult = checkTaskHealth(tasks);
    const fixed = applyHealthFixes(tasks, healthResult);

    expect(fixed[0].status).toBe('open'); // unchanged
    expect(fixed[1].status).toBe('open'); // reset from in_progress
  });

  test('does not modify completed tasks', () => {
    const tasks = [
      task('A', { status: 'completed' }),
      task('B', { status: 'completed', dependsOn: ['A'] }),
    ];
    const healthResult = checkTaskHealth(tasks);
    const fixed = applyHealthFixes(tasks, healthResult);

    expect(fixed[0].status).toBe('completed');
    expect(fixed[1].status).toBe('completed');
  });

  test('does not modify tasks with completed dependencies', () => {
    const tasks = [
      task('A', { status: 'completed' }),
      task('B', { status: 'in_progress', dependsOn: ['A'] }),
    ];
    const healthResult = checkTaskHealth(tasks);
    const fixed = applyHealthFixes(tasks, healthResult);

    // No deadlocks detected, so task B should stay in_progress
    expect(fixed[1].status).toBe('in_progress');
  });
});
