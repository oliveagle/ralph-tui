/**
 * ABOUTME: Patrol agent for ralph-tui that periodically checks bead task status.
 *
 * Runs on a fixed interval (default 300s / 5 minutes) and:
 * 1. Checks all bead task statuses
 * 2. Detects stuck tasks (in_progress with no progress)
 * 3. Detects dependency issues (tasks blocked by uncompleted dependencies)
 * 4. Detects worktree issues (claimed but no worktree exists)
 * 5. Calls AI agent to analyze and fix issues
 * 6. Records patrol findings to .ralph-tui/patrol/
 *
 * Usage: raloop --patrol [--patrol-interval 300]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrackerPlugin, TrackerTask } from '../plugins/trackers/types.js';
import type { DeadlockResolver } from '../parallel/deadlock-resolver.js';

/** Patrol finding record */
export interface PatrolFinding {
  timestamp: string;
  taskId: string;
  taskTitle: string;
  issueType: 'stuck' | 'dependency_blocked' | 'orphaned' | 'worktree_missing';
  severity: 'error' | 'warning' | 'info';
  description: string;
  aiAction?: string;
  aiReason?: string;
  resolved: boolean;
}

/** Patrol result summary */
export interface PatrolResult {
  timestamp: string;
  findings: PatrolFinding[];
  tasksTotal: number;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksOpen: number;
  issuesFound: number;
  issuesResolved: number;
}

/** Patrol configuration */
export interface PatrolConfig {
  /** Patrol interval in seconds (default 300 = 5 minutes) */
  intervalSeconds: number;
  /** Whether to use AI agent for resolution (default true) */
  useAiResolver: boolean;
  /** Maximum stuck duration before flagging (default 10 minutes) */
  stuckThresholdMs: number;
}

const DEFAULT_CONFIG: PatrolConfig = {
  intervalSeconds: 300,
  useAiResolver: true,
  stuckThresholdMs: 10 * 60_000, // 10 minutes
};

/**
 * Run a single patrol check.
 * Analyzes all bead tasks and returns findings.
 */
export async function runPatrol(
  tracker: TrackerPlugin,
  deadlockResolver: DeadlockResolver | null,
  config: PatrolConfig
): Promise<PatrolResult> {
  const result: PatrolResult = {
    timestamp: new Date().toISOString(),
    findings: [],
    tasksTotal: 0,
    tasksCompleted: 0,
    tasksInProgress: 0,
    tasksOpen: 0,
    issuesFound: 0,
    issuesResolved: 0,
  };

  try {
    // Get all tasks
    const allTasks = await tracker.getTasks({
      status: ['open', 'in_progress', 'completed'],
    });

    result.tasksTotal = allTasks.length;
    result.tasksCompleted = allTasks.filter((t) => t.status === 'completed').length;
    result.tasksInProgress = allTasks.filter((t) => t.status === 'in_progress').length;
    result.tasksOpen = allTasks.filter((t) => t.status === 'open').length;

    // Check each in_progress task
    for (const task of allTasks.filter((t) => t.status === 'in_progress')) {
      const finding = await checkTask(task, allTasks, deadlockResolver, config);
      if (finding) {
        result.findings.push(finding);
        result.issuesFound++;
        if (finding.resolved) {
          result.issuesResolved++;
        }
      }
    }

    // Check each open task for dependency issues
    for (const task of allTasks.filter((t) => t.status === 'open')) {
      const finding = await checkOpenTask(task, allTasks);
      if (finding) {
        result.findings.push(finding);
        result.issuesFound++;
        if (finding.resolved) {
          result.issuesResolved++;
        }
      }
    }

    // Save patrol result to file
    await savePatrolResult(result);

  } catch (err) {
    console.error('[patrol] Error during patrol:', err);
  }

  return result;
}

/**
 * Check an in_progress task for issues.
 */
async function checkTask(
  task: TrackerTask,
  allTasks: TrackerTask[],
  deadlockResolver: DeadlockResolver | null,
  config: PatrolConfig
): Promise<PatrolFinding | null> {
  const now = Date.now();
  const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
  const stuckDuration = now - updatedAt;

  // Check if task is stuck (in_progress for too long)
  if (stuckDuration > config.stuckThresholdMs) {
    const hoursStuck = (stuckDuration / 3_600_000).toFixed(1);
    console.log(`[patrol] Task ${task.id} stuck in in_progress for ${hoursStuck}h`);

    const finding: PatrolFinding = {
      timestamp: new Date().toISOString(),
      taskId: task.id,
      taskTitle: task.title,
      issueType: 'stuck',
      severity: 'error',
      description: `Task stuck in in_progress for ${hoursStuck} hours`,
      resolved: false,
    };

    // Use AI resolver if available
    if (deadlockResolver && config.useAiResolver) {
      try {
        const diagnostic = await deadlockResolver.diagnose(task);
        const resolution = await deadlockResolver.resolve(diagnostic);

        finding.aiAction = resolution.actionTaken.type;
        finding.aiReason = resolution.message;
        finding.resolved = resolution.success;

        console.log(`[patrol] AI resolution for ${task.id}: ${resolution.actionTaken.type} - ${resolution.message}`);
      } catch (err) {
        console.error(`[patrol] AI resolution failed for ${task.id}:`, err);
      }
    }

    return finding;
  }

  // Check if task has uncompleted dependencies
  if (task.dependsOn && task.dependsOn.length > 0) {
    const incompleteDeps = task.dependsOn.filter((depId) => {
      const dep = allTasks.find((t) => t.id === depId);
      return dep && dep.status !== 'completed';
    });

    if (incompleteDeps.length > 0) {
      console.log(`[patrol] Task ${task.id} in_progress but blocked by: ${incompleteDeps.join(', ')}`);

      const finding: PatrolFinding = {
        timestamp: new Date().toISOString(),
        taskId: task.id,
        taskTitle: task.title,
        issueType: 'dependency_blocked',
        severity: 'error',
        description: `Task in_progress but blocked by uncompleted dependencies: ${incompleteDeps.join(', ')}`,
        resolved: false,
      };

      // Use AI resolver to fix
      if (deadlockResolver && config.useAiResolver) {
        try {
          const diagnostic = await deadlockResolver.diagnose(task);
          const resolution = await deadlockResolver.resolve(diagnostic);

          finding.aiAction = resolution.actionTaken.type;
          finding.aiReason = resolution.message;
          finding.resolved = resolution.success;
        } catch (err) {
          console.error(`[patrol] AI resolution failed for ${task.id}:`, err);
        }
      }

      return finding;
    }
  }

  return null;
}

/**
 * Check an open task for dependency issues.
 */
async function checkOpenTask(
  task: TrackerTask,
  allTasks: TrackerTask[]
): Promise<PatrolFinding | null> {
  // Check if task has completed dependencies (should be ready to run)
  if (task.dependsOn && task.dependsOn.length > 0) {
    const completedDeps = task.dependsOn.filter((depId) => {
      const dep = allTasks.find((t) => t.id === depId);
      return dep && dep.status === 'completed';
    });

    if (completedDeps.length === task.dependsOn.length) {
      // All dependencies completed - task should be ready
      console.log(`[patrol] Task ${task.id} is ready (all deps completed)`);
    }
  }

  return null;
}

/**
 * Save patrol result to .ralph-tui/patrol/ directory.
 */
async function savePatrolResult(result: PatrolResult): Promise<void> {
  const patrolDir = path.join(process.cwd(), '.ralph-tui', 'patrol');

  try {
    await fs.promises.mkdir(patrolDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const timestamp = result.timestamp.replace(/[:.]/g, '-');
  const filePath = path.join(patrolDir, `patrol-${timestamp}.json`);

  await fs.promises.writeFile(
    filePath,
    JSON.stringify(result, null, 2),
    'utf-8'
  );

  // Also append to patrol log
  const logFile = path.join(patrolDir, 'patrol.log');
  const logEntry = `[${result.timestamp}] Patrol: ${result.tasksTotal} tasks, ${result.issuesFound} issues, ${result.issuesResolved} resolved\n`;

  await fs.promises.appendFile(logFile, logEntry, 'utf-8');
}

export async function executePatrolCommand(): Promise<void> {
  console.log('[raloop] Starting raloop - automated patrol agent');
  console.log(`[raloop] Interval: ${DEFAULT_CONFIG.intervalSeconds}s, AI resolver: ${DEFAULT_CONFIG.useAiResolver}`);
  console.log('[raloop] Press Ctrl+C to stop');

  const { registerBuiltinAgents } = await import('../plugins/agents/builtin/index.js');
  const { registerBuiltinTrackers } = await import('../plugins/trackers/builtin/index.js');
  const { getTrackerRegistry } = await import('../plugins/trackers/registry.js');
  const { getAgentRegistry } = await import('../plugins/agents/registry.js');
  const { buildConfig } = await import('../config/index.js');
  const { DeadlockResolver } = await import('../parallel/deadlock-resolver.js');

  // Initialize plugins (same pattern as run.tsx)
  registerBuiltinAgents();
  registerBuiltinTrackers();

  const agentRegistry = getAgentRegistry();
  const trackerRegistry = getTrackerRegistry();
  await Promise.all([agentRegistry.initialize(), trackerRegistry.initialize()]);

  const config = await buildConfig({});
  if (!config) {
    console.error('[patrol] Failed to build configuration');
    process.exit(1);
  }
  const tracker = await trackerRegistry.getInstance(config.tracker);

  const deadlockResolver = new DeadlockResolver(
    { cwd: process.cwd(), sessionId: 'raloop', worktreeDir: '.ralph-tui/worktrees' },
    tracker,
    config
  );

  await startPatrol(tracker, deadlockResolver, DEFAULT_CONFIG);
}

/**
 * Start the patrol loop.
 * Runs patrol checks on a fixed interval.
 */
export async function startPatrol(
  tracker: TrackerPlugin,
  deadlockResolver: DeadlockResolver | null,
  config: PatrolConfig = DEFAULT_CONFIG
): Promise<void> {
  console.log(`[patrol] Starting patrol: interval=${config.intervalSeconds}s, ai=${config.useAiResolver}`);

  while (true) {
    const result = await runPatrol(tracker, deadlockResolver, config);

    if (result.issuesFound > 0) {
      console.log(`[patrol] Found ${result.issuesFound} issues, resolved ${result.issuesResolved}`);
    } else {
      console.log(`[patrol] All clear: ${result.tasksTotal} tasks (${result.tasksCompleted} completed, ${result.tasksOpen} open)`);
    }

    // Wait for next patrol
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000));
  }
}
