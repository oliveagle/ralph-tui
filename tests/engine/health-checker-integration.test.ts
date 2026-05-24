/**
 * ABOUTME: Integration tests for task health checker with deadlock detection and cascading resets.
 * Tests end-to-end scenarios where health issues affect parallel execution workflow.
 */

import { describe, test, expect } from 'bun:test';
import { checkTaskHealth, applyHealthFixes } from '../../src/parallel/task-health-checker.js';
import type { TrackerTask } from '../../src/plugins/trackers/types.js';

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

describe('health check integration', () => {
  describe('deadlock detection and cascading reset chain', () => {
    test('full chain: A(open) -> B(in_progress) -> C(in_progress) -> D(in_progress)', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }),
        task('C', { status: 'in_progress', dependsOn: ['B'] }),
        task('D', { status: 'in_progress', dependsOn: ['C'] }),
      ];

      const result = checkTaskHealth(tasks);

      // B is directly deadlocked (A not completed)
      expect(result.issues.find(i => i.type === 'deadlock' && i.taskId === 'B')).toBeDefined();
      expect(result.fixedTaskIds).toContain('B');

      // C and D are cascaded (depend on B which was reset)
      expect(result.cascadedResetTaskIds).toContain('C');
      expect(result.cascadedResetTaskIds).toContain('D');

      // After fixes, all blocked tasks should be reset to open
      const fixedTasks = applyHealthFixes(tasks, result);
      expect(fixedTasks.find(t => t.id === 'A')?.status).toBe('open');
      expect(fixedTasks.find(t => t.id === 'B')?.status).toBe('open');
      expect(fixedTasks.find(t => t.id === 'C')?.status).toBe('open');
      expect(fixedTasks.find(t => t.id === 'D')?.status).toBe('open');
    });

    test('parallel deadlocks: multiple tasks blocked by same incomplete dependency', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }),
        task('C', { status: 'in_progress', dependsOn: ['A'] }),
        task('D', { status: 'in_progress', dependsOn: ['A'] }),
      ];

      const result = checkTaskHealth(tasks);

      // All three tasks are deadlocked by A
      expect(result.issues.filter(i => i.type === 'deadlock')).toHaveLength(3);
      expect(result.fixedTaskIds).toContain('B');
      expect(result.fixedTaskIds).toContain('C');
      expect(result.fixedTaskIds).toContain('D');
    });

    test('partial chain: some tasks healthy, some deadlocked', () => {
      const tasks = [
        task('A', { status: 'completed' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }), // healthy
        task('C', { status: 'open' }),
        task('D', { status: 'in_progress', dependsOn: ['C'] }), // deadlocked
      ];

      const result = checkTaskHealth(tasks);

      // Only D is deadlocked
      expect(result.issues.find(i => i.taskId === 'B')).toBeUndefined();
      expect(result.issues.find(i => i.taskId === 'D' && i.type === 'deadlock')).toBeDefined();
      expect(result.fixedTaskIds).toContain('D');
      expect(result.fixedTaskIds).not.toContain('B');
    });
  });

  describe('mixed health issues (deadlock + orphan + missing dep)', () => {
    test('detects and reports multiple issue types simultaneously', () => {
      const oldDate = new Date(Date.now() - 4 * 60_000).toISOString(); // 4 min ago (over 10 min threshold? no)
      const veryOldDate = new Date(Date.now() - 2 * 60_000 * 60_000).toISOString(); // very old

      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'], updatedAt: oldDate }), // deadlock
        task('C', { status: 'in_progress', dependsOn: ['NONEXISTENT'] }), // missing dep + deadlock
        task('D', { status: 'in_progress', updatedAt: veryOldDate }), // orphaned
      ];

      const result = checkTaskHealth(tasks);

      // Should detect deadlock on B
      expect(result.issues.some(i => i.type === 'deadlock' && i.taskId === 'B')).toBe(true);

      // Should detect missing dependency on C
      expect(result.issues.some(i => i.type === 'missing_dependency' && i.taskId === 'C')).toBe(true);

      // Should detect orphaned on D
      expect(result.issues.some(i => i.type === 'orphaned' && i.taskId === 'D')).toBe(true);
    });
  });

  describe('orphaned task threshold', () => {
    test('fresh in_progress tasks are not orphaned', () => {
      const recentDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const tasks = [
        task('A', { status: 'in_progress', updatedAt: recentDate }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.issues.some(i => i.type === 'orphaned')).toBe(false);
      expect(result.healthy).toBe(true);
    });

    test('stale in_progress tasks are orphaned', () => {
      const oldDate = new Date(Date.now() - 11 * 60_000).toISOString(); // 11 minutes ago
      const tasks = [
        task('A', { status: 'in_progress', updatedAt: oldDate }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.issues.some(i => i.type === 'orphaned')).toBe(true);
      expect(result.fixedTaskIds).toContain('A');
    });
  });

  describe('dependency integrity', () => {
    test('handles tasks with multiple dependencies', () => {
      const tasks = [
        task('A', { status: 'completed' }),
        task('B', { status: 'open' }),
        task('C', { status: 'in_progress', dependsOn: ['A', 'B'] }),
      ];

      const result = checkTaskHealth(tasks);

      // C is deadlocked because B is not completed
      expect(result.issues.some(i => i.type === 'deadlock')).toBe(true);
      expect(result.issues[0].relatedTaskIds).toContain('B');
    });

    test('completes all dependencies clears deadlock', () => {
      const tasks = [
        task('A', { status: 'completed' }),
        task('B', { status: 'completed' }),
        task('C', { status: 'in_progress', dependsOn: ['A', 'B'] }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.issues).toHaveLength(0);
      expect(result.healthy).toBe(true);
    });
  });

  describe('health check with DeadlockResolver integration', () => {
    test('health checker and deadlock resolver work together', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('deadlock');
      expect(result.fixedTaskIds).toContain('B');

      // After applying fixes, deadlock resolver should have no stuck tasks
      const fixedTasks = applyHealthFixes(tasks, result);
      expect(fixedTasks.find(t => t.id === 'B')?.status).toBe('open');
    });
  });

  describe('summary generation', () => {
    test('generates human-readable summary for healthy tasks', () => {
      const tasks = [
        task('A', { status: 'completed' }),
        task('B', { status: 'completed', dependsOn: ['A'] }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.summary).toContain('no issues');
    });

    test('generates summary with error counts', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }),
        task('C', { status: 'in_progress', dependsOn: ['A'] }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.summary).toContain('2 error');
      expect(result.summary).toContain('2 task(s) auto-fixed');
    });

    test('includes cascade count in summary', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }),
        task('C', { status: 'in_progress', dependsOn: ['B'] }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.summary).toContain('1 dependent task(s) cascaded');
    });
  });

  describe('empty and edge cases', () => {
    test('empty task list is healthy', () => {
      const result = checkTaskHealth([]);
      expect(result.healthy).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test('all open tasks are healthy', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'open' }),
        task('C', { status: 'open' }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.healthy).toBe(true);
    });

    test('all completed tasks are healthy', () => {
      const tasks = [
        task('A', { status: 'completed' }),
        task('B', { status: 'completed', dependsOn: ['A'] }),
        task('C', { status: 'completed', dependsOn: ['A', 'B'] }),
      ];

      const result = checkTaskHealth(tasks);
      expect(result.healthy).toBe(true);
    });
  });

  describe('HealthCheckResult type', () => {
    test('result has all required fields', () => {
      const tasks = [
        task('A', { status: 'in_progress', dependsOn: ['B'] }),
        task('B', { status: 'open' }),
      ];

      const result = checkTaskHealth(tasks);

      expect(result).toHaveProperty('healthy');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('fixedTaskIds');
      expect(result).toHaveProperty('cascadedResetTaskIds');
      expect(result).toHaveProperty('summary');
      expect(typeof result.healthy).toBe('boolean');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(Array.isArray(result.fixedTaskIds)).toBe(true);
      expect(Array.isArray(result.cascadedResetTaskIds)).toBe(true);
      expect(typeof result.summary).toBe('string');
    });
  });

  describe('HealthIssue type', () => {
    test('deadlock issue has correct structure', () => {
      const tasks = [
        task('A', { status: 'open' }),
        task('B', { status: 'in_progress', dependsOn: ['A'] }),
      ];

      const result = checkTaskHealth(tasks);
      const deadlock = result.issues.find(i => i.type === 'deadlock');

      expect(deadlock).toBeDefined();
      expect(deadlock!.severity).toBe('error');
      expect(deadlock!.taskId).toBe('B');
      expect(deadlock!.message).toContain('in_progress');
      expect(deadlock!.message).toContain('uncompleted dependencies');
    });

    test('orphaned issue has correct structure', () => {
      const oldDate = new Date(Date.now() - 11 * 60_000).toISOString();
      const tasks = [
        task('A', { status: 'in_progress', updatedAt: oldDate }),
      ];

      const result = checkTaskHealth(tasks);
      const orphaned = result.issues.find(i => i.type === 'orphaned');

      expect(orphaned).toBeDefined();
      expect(orphaned!.severity).toBe('warning');
      expect(orphaned!.taskId).toBe('A');
      expect(orphaned!.message).toContain('in_progress');
    });
  });
});