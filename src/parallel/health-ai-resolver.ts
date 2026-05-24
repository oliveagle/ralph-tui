/**
 * ABOUTME: AI-driven health check resolver for parallel execution.
 *
 * Uses AI DeadlockResolver to analyze and fix stuck tasks detected by
 * checkTaskHealth. This is the main entry point for AI-driven deadlock
 * resolution in the parallel executor.
 */

import type { TrackerPlugin } from '../plugins/trackers/types.js';
import type { DeadlockResolver } from './deadlock-resolver.js';
import { checkTaskHealth } from './task-health-checker.js';

/**
 * Run health check and use AI DeadlockResolver to fix stuck tasks.
 *
 * Flow:
 * 1. Detect health issues (deadlocks, orphaned tasks)
 * 2. For each issue, use AI DeadlockResolver to diagnose and fix
 * 3. AI agent analyzes git state, worktree status, and dependency chains
 * 4. AI recommends action (continue, merge_and_close, reset_to_open, skip_and_close)
 * 5. Execute AI's decision
 *
 * @returns true if any issues were found and resolved
 */
export async function runHealthCheckAndResolve(
  tracker: TrackerPlugin,
  deadlockResolver: DeadlockResolver,
): Promise<boolean> {
  const tasks = await tracker.getTasks({
    status: ['open', 'in_progress', 'completed'],
  });

  const activeTasks = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress');

  if (activeTasks.length === 0) {
    return false;
  }

  const healthCheck = checkTaskHealth(activeTasks, {
    autoFixDeadlocks: false,
    autoFixOrphaned: false,
  });

  if (healthCheck.issues.length === 0) {
    return false;
  }

  let issuesResolved = 0;
  for (const issue of healthCheck.issues) {
    if (issue.severity !== 'error' && issue.severity !== 'warning') {
      continue;
    }

    const stuckTask = activeTasks.find((t) => t.id === issue.taskId);
    if (!stuckTask) continue;

    console.log(`[health-ai] AI resolving: ${issue.taskId} (${issue.type}): ${issue.message}`);

    try {
      const diagnostic = await deadlockResolver.diagnose(stuckTask);
      const resolution = await deadlockResolver.resolve(diagnostic);

      console.log(`[health-ai] AI decision: ${resolution.actionTaken.type} - ${resolution.message}`);
      issuesResolved++;
    } catch (err) {
      console.error(`[health-ai] AI resolution failed for ${issue.taskId}:`, err);
    }
  }

  return issuesResolved > 0;
}
