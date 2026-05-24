/**
 * ABOUTME: Task health checker for detecting and repairing dependency deadlocks.
 *
 * Detects:
 * - Deadlocked tasks: in_progress but dependencies are not completed
 * - Orphaned tasks: in_progress for too long (process crashed)
 * - Dependency integrity: references to non-existent tasks
 *
 * Used by the ParallelExecutor before analyzing the task graph,
 * and can also be run standalone for manual health checks.
 */

import type { TrackerTask } from '../plugins/trackers/types.js';

/** Severity level of a task health issue */
export type HealthSeverity = 'error' | 'warning' | 'info';

/** Type of health issue detected */
export type HealthIssueType =
  | 'deadlock'
  | 'orphaned'
  | 'missing_dependency'
  | 'circular_dependency';

/** A single health issue found during analysis */
export interface HealthIssue {
  /** Issue type */
  type: HealthIssueType;

  /** Severity level */
  severity: HealthSeverity;

  /** Task ID that has the issue */
  taskId: string;

  /** Human-readable description */
  message: string;

  /** Suggested fix (auto-fixable issues) */
  suggestedFix?: string;

  /** Related task IDs (e.g., the dependency causing the deadlock) */
  relatedTaskIds?: string[];
}

/** Result of a task health check */
export interface HealthCheckResult {
  /** Whether the overall task set is healthy */
  healthy: boolean;

  /** Issues found */
  issues: HealthIssue[];

  /** Tasks that were auto-fixed during the check */
  fixedTaskIds: string[];

  /** Tasks that depend on fixed tasks (also need reset) - cascading reset */
  cascadedResetTaskIds: string[];

  /** Summary message */
  summary: string;
}

/**
 * Configuration for the health checker.
 */
export interface HealthCheckerConfig {
  /** Whether to auto-fix deadlocked tasks (reset to open). Default: true */
  autoFixDeadlocks: boolean;

  /** Whether to auto-fix orphaned tasks (reset to open). Default: true */
  autoFixOrphaned: boolean;

  /**
   * Time threshold (in ms) after which an in_progress task is considered orphaned.
   * Default: 1 hour (3600000 ms).
   */
  orphanThresholdMs: number;
}

const DEFAULT_CONFIG: HealthCheckerConfig = {
  autoFixDeadlocks: true,
  autoFixOrphaned: true,
  orphanThresholdMs: 3_600_000, // 1 hour
};

/**
 * Check the health of tasks before parallel execution.
 *
 * Detects tasks that are in a stuck state — e.g., marked as in_progress
 * but their dependencies aren't completed, which would cause the parallel
 * executor to waste time on tasks that can never succeed.
 *
 * @param tasks - All tasks to check (open + in_progress)
 * @param config - Health checker configuration
 * @returns Health check result
 */
export function checkTaskHealth(
  tasks: TrackerTask[],
  config?: Partial<HealthCheckerConfig>
): HealthCheckResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const issues: HealthIssue[] = [];
  const fixedTaskIds: string[] = [];
  const taskMap = new Map<string, TrackerTask>();

  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Check each in_progress task for dependency issues
  for (const task of tasks) {
    if (task.status !== 'in_progress') continue;

    // Check if all dependencies are completed
    checkDependencyHealth(task, taskMap, issues);

    // Check if task has been in_progress for too long (orphaned)
    checkOrphanedHealth(task, cfg, issues);
  }

  // Auto-fix: reset deadlocked and orphaned tasks to open
  for (const issue of issues) {
    if (
      issue.type === 'deadlock' &&
      cfg.autoFixDeadlocks &&
      !fixedTaskIds.includes(issue.taskId)
    ) {
      fixedTaskIds.push(issue.taskId);
      issue.suggestedFix = `Task ${issue.taskId} reset to 'open' — its dependencies are not yet complete`;
    }
    if (
      issue.type === 'orphaned' &&
      cfg.autoFixOrphaned &&
      !fixedTaskIds.includes(issue.taskId)
    ) {
      fixedTaskIds.push(issue.taskId);
      issue.suggestedFix = `Task ${issue.taskId} reset to 'open' — it was stuck in_progress for too long`;
    }
  }

  // Cascading reset: find all in_progress tasks that depend on fixed tasks
  // These tasks are now deadlocked because their dependency was reset
  const cascadedResetTaskIds: string[] = [];
  for (const fixedTaskId of fixedTaskIds) {
    findDependentTasks(fixedTaskId, taskMap, cascadedResetTaskIds);
  }

  const healthy = issues.filter((i) => i.severity === 'error').length === 0;

  return {
    healthy,
    issues,
    fixedTaskIds,
    cascadedResetTaskIds,
    summary: buildSummary(issues, fixedTaskIds, cascadedResetTaskIds),
  };
}

/**
 * Find all in_progress tasks that depend on the given task (directly or indirectly).
 * These tasks need to be reset because their dependency was reset.
 */
function findDependentTasks(
  taskId: string,
  taskMap: Map<string, TrackerTask>,
  result: string[],
  visited = new Set<string>()
): void {
  if (visited.has(taskId)) return;
  visited.add(taskId);

  for (const [id, task] of taskMap) {
    if (task.status !== 'in_progress') continue;
    if (result.includes(id)) continue;

    // Check if this task depends on the target task
    let dependsOnTarget = false;

    // Check dependsOn
    if (task.dependsOn?.includes(taskId)) {
      dependsOnTarget = true;
    }

    // Check blocks (reverse relationship)
    for (const [otherId, other] of taskMap) {
      if (other.blocks?.includes(taskId) && otherId === id) {
        dependsOnTarget = true;
        break;
      }
    }

    if (dependsOnTarget) {
      result.push(id);
      // Recursively find tasks that depend on this one
      findDependentTasks(id, taskMap, result, visited);
    }
  }
}

/**
 * Filter tasks to remove deadlocked in_progress tasks, returning only
 * tasks that are safe to process. Deadlocked tasks have their status
 * conceptually reset to 'open' (the caller must persist this via tracker).
 *
 * @param tasks - All tasks
 * @param healthResult - Result from checkTaskHealth
 * @returns Filtered task list ready for task graph analysis
 */
export function applyHealthFixes(
  tasks: TrackerTask[],
  healthResult: HealthCheckResult
): TrackerTask[] {
  // Combine fixed tasks and cascaded reset tasks
  const allResetTaskIds = new Set([
    ...healthResult.fixedTaskIds,
    ...healthResult.cascadedResetTaskIds,
  ]);

  return tasks.map((task) => {
    if (allResetTaskIds.has(task.id) && task.status === 'in_progress') {
      return { ...task, status: 'open' as const };
    }
    return task;
  });
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Check if an in_progress task has uncompleted dependencies */
function checkDependencyHealth(
  task: TrackerTask,
  taskMap: Map<string, TrackerTask>,
  issues: HealthIssue[]
): void {
  const incompleteDeps: string[] = [];

  // Check dependsOn relationships
  if (task.dependsOn) {
    for (const depId of task.dependsOn) {
      const dep = taskMap.get(depId);
      if (!dep) {
        issues.push({
          type: 'missing_dependency',
          severity: 'warning',
          taskId: task.id,
          message: `Task ${task.id} depends on ${depId} which does not exist`,
          relatedTaskIds: [depId],
        });
        continue;
      }
      if (dep.status !== 'completed') {
        incompleteDeps.push(depId);
      }
    }
  }

  // Check blocks relationships (reverse: if task A is blocked by task B's blocks field)
  // The `blocks` field means "this task blocks the listed tasks", so if any task
  // has this task in its `blocks` field, that listed task depends on this one.
  // We need to check if this task has dependencies from other tasks' blocks fields.
  for (const [otherId, other] of taskMap) {
    if (otherId === task.id) continue;
    if (other.blocks && other.blocks.includes(task.id)) {
      // other.blocks includes task.id → task depends on other
      if (other.status !== 'completed' && !incompleteDeps.includes(otherId)) {
        incompleteDeps.push(otherId);
      }
    }
  }

  if (incompleteDeps.length > 0) {
    issues.push({
      type: 'deadlock',
      severity: 'error',
      taskId: task.id,
      message: `Task "${task.title}" is in_progress but blocked by uncompleted dependencies: ${incompleteDeps.join(', ')}`,
      relatedTaskIds: incompleteDeps,
    });
  }
}

/** Check if an in_progress task has been stuck for too long */
function checkOrphanedHealth(
  task: TrackerTask,
  config: HealthCheckerConfig,
  issues: HealthIssue[]
): void {
  // Skip if we already flagged this task as deadlocked
  // (orphaned check is secondary — a task can be both, but deadlock is more actionable)

  const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
  const now = Date.now();

  if (updatedAt > 0 && now - updatedAt > config.orphanThresholdMs) {
    const hoursAgo = Math.round((now - updatedAt) / 3_600_000 * 10) / 10;
    issues.push({
      type: 'orphaned',
      severity: 'warning',
      taskId: task.id,
      message: `Task "${task.title}" has been in_progress for ${hoursAgo}h (likely from a crashed process)`,
    });
  }
}

/** Build a human-readable summary of health check results */
function buildSummary(issues: HealthIssue[], fixedTaskIds: string[], cascadedResetTaskIds: string[]): string {
  if (issues.length === 0) {
    return 'All tasks are healthy — no issues found';
  }

  const parts: string[] = [];
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  if (errorCount > 0) {
    parts.push(`${errorCount} error(s)`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning(s)`);
  }
  if (fixedTaskIds.length > 0) {
    parts.push(`${fixedTaskIds.length} task(s) auto-fixed`);
  }
  if (cascadedResetTaskIds.length > 0) {
    parts.push(`${cascadedResetTaskIds.length} dependent task(s) cascaded`);
  }

  return parts.join(', ');
}
