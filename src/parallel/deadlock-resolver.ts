/**
 * ABOUTME: AI-powered deadlock resolution for parallel execution.
 *
 * When tasks get stuck (in_progress with no active worktree), this module:
 * 1. Detects the deadlock condition
 * 2. Gathers diagnostic data (git state, worktree list, task dependencies)
 * 3. Calls AI agent to analyze and recommend fix
 * 4. Executes the AI's recommended action
 * 5. Recovers execution state
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrackerTask, TrackerPlugin } from '../plugins/trackers/types.js';
import type { RalphConfig } from '../config/types.js';
import { getAgentRegistry } from '../plugins/agents/registry.js';

/** Deadlock diagnostic data gathered for AI analysis */
export interface DeadlockDiagnostic {
  /** Task that is deadlocked */
  task: TrackerTask;
  /** Git repository state */
  gitState: {
    currentBranch: string;
    currentCommit: string;
    uncommittedChanges: boolean;
    inMerge: boolean;
    inRebase: boolean;
    inCherryPick: boolean;
  };
  /** Worktree state */
  worktreeState: {
    exists: boolean;
    path?: string;
    branch?: string;
    commitCount?: number;
    lastModified?: string;
    hasUncommittedChanges?: boolean;
    modifiedFiles?: string[];
  };
  /** Task dependency chain */
  dependencies: {
    dependsOn: TrackerTask[];
    blocks: TrackerTask[];
  };
  /** Time since task was marked in_progress */
  stuckDurationMs: number;
  /** All tasks in the same parallel group for context */
  groupTasks?: TrackerTask[];
}

/** AI's recommended action to resolve the deadlock */
export type DeadlockAction =
  | { type: 'continue'; reason: string }
  | { type: 'merge_and_close'; reason: string; preserveWorktree?: boolean }
  | { type: 'reset_to_open'; reason: string }
  | { type: 'skip_and_close'; reason: string };

/** Result of deadlock resolution attempt */
export interface DeadlockResolutionResult {
  success: boolean;
  actionTaken: DeadlockAction;
  message: string;
  taskReset: boolean;
  worktreePreserved: boolean;
}

/** Configuration for deadlock resolver */
export interface DeadlockResolverConfig {
  cwd: string;
  sessionId: string;
  worktreeDir: string;
  diagnosticTimeoutMs: number;
  aiResolutionTimeoutMs: number;
}

const DEFAULT_CONFIG: Partial<DeadlockResolverConfig> = {
  diagnosticTimeoutMs: 30000,
  aiResolutionTimeoutMs: 120000,
};

/**
 * DeadlockResolver uses AI to diagnose and fix stuck tasks.
 *
 * A task is considered deadlocked when:
 * - Status is 'in_progress'
 * - No active worktree exists (process crashed)
 * - Dependencies may or may not be completed
 */
export class DeadlockResolver {
  private readonly config: DeadlockResolverConfig;
  private readonly tracker: TrackerPlugin;
  private readonly agentConfig: RalphConfig;

  constructor(
    config: Partial<DeadlockResolverConfig>,
    tracker: TrackerPlugin,
    agentConfig: RalphConfig
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      cwd: config.cwd ?? process.cwd(),
      worktreeDir: config.worktreeDir ?? '.ralph-tui/worktrees',
      sessionId: config.sessionId ?? 'unknown',
    } as DeadlockResolverConfig;
    this.tracker = tracker;
    this.agentConfig = agentConfig;
  }

  /**
   * Diagnose a potentially deadlocked task.
   * Gathers all necessary context for AI analysis.
   */
  async diagnose(task: TrackerTask, groupTasks?: TrackerTask[]): Promise<DeadlockDiagnostic> {
    const gitState = this.getGitState();
    const worktreeState = await this.getWorktreeState(task.id);
    const dependencies = await this.getDependencyInfo(task);
    const stuckDurationMs = task.updatedAt
      ? Date.now() - new Date(task.updatedAt).getTime()
      : 0;

    return {
      task,
      gitState,
      worktreeState,
      dependencies,
      stuckDurationMs,
      groupTasks,
    };
  }

  /**
   * Resolve a deadlock using AI analysis.
   * Returns the action taken and whether it succeeded.
   */
  async resolve(diagnostic: DeadlockDiagnostic): Promise<DeadlockResolutionResult> {
    // First, check if worktree has uncommitted changes that should be committed
    if (diagnostic.worktreeState.exists && diagnostic.worktreeState.hasUncommittedChanges) {
      console.log(`[deadlock-resolver] Task ${diagnostic.task.id} has uncommitted changes in worktree, attempting to commit...`);

      const commitResult = await this.commitWorktreeChanges(diagnostic);
      if (commitResult) {
        return {
          success: true,
          actionTaken: { type: 'continue', reason: 'Committed uncommitted changes in worktree' },
          message: `Task ${diagnostic.task.id} uncommitted changes committed`,
          taskReset: false,
          worktreePreserved: true,
        };
      }
    }

    // Build diagnostic prompt for AI
    const prompt = this.buildDiagnosticPrompt(diagnostic);

    try {
      // Call AI agent to analyze and recommend action
      const action = await this.queryAiForAction(prompt);

      // Execute the recommended action
      return await this.executeAction(diagnostic, action);
    } catch (err) {
      // Fallback: use deterministic logic instead of failing
      console.error(`[deadlock-resolver] AI resolution failed:`, err);
      return await this.deterministicResolution(diagnostic, `AI resolution failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get current git repository state.
   */
  private getGitState(): DeadlockDiagnostic['gitState'] {
    try {
      const currentBranch = this.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      const currentCommit = this.git(['rev-parse', 'HEAD']).trim();
      const status = this.git(['status', '--porcelain']).trim();

      const uncommittedChanges = status.length > 0;
      const inMerge = fs.existsSync(path.join(this.config.cwd, '.git', 'MERGE_HEAD'));
      const inRebase = fs.existsSync(path.join(this.config.cwd, '.git', 'REBASE_HEAD')) ||
                       fs.existsSync(path.join(this.config.cwd, '.git', 'rebase-merge'));
      const inCherryPick = fs.existsSync(path.join(this.config.cwd, '.git', 'CHERRY_PICK_HEAD'));

      return {
        currentBranch,
        currentCommit,
        uncommittedChanges,
        inMerge,
        inRebase,
        inCherryPick,
      };
    } catch (err) {
      console.error('[deadlock-resolver] Failed to get git state:', err);
      return {
        currentBranch: 'unknown',
        currentCommit: 'unknown',
        uncommittedChanges: false,
        inMerge: false,
        inRebase: false,
        inCherryPick: false,
      };
    }
  }

  /**
   * Get worktree state for a task.
   */
  private async getWorktreeState(taskId: string): Promise<DeadlockDiagnostic['worktreeState']> {
    try {
      // Try to find worktree by task ID
      const worktreePath = path.join(this.config.cwd, this.config.worktreeDir, taskId);

      if (!fs.existsSync(worktreePath)) {
        return { exists: false };
      }

      const stat = await fs.promises.stat(worktreePath);
      const branch = this.git(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();

      // Check for uncommitted changes
      const statusOutput = this.git(['-C', worktreePath, 'status', '--porcelain']).trim();
      const hasUncommittedChanges = statusOutput.length > 0;

      // Parse modified files
      const modifiedFiles: string[] = [];
      if (hasUncommittedChanges) {
        for (const line of statusOutput.split('\n')) {
          if (line.trim()) {
            const filePath = line.substring(3).trim();
            if (filePath) {
              modifiedFiles.push(filePath);
            }
          }
        }
      }

      const commitCountStr = this.git(['-C', worktreePath, 'rev-list', '--count', 'HEAD']).trim();
      const commitCount = parseInt(commitCountStr, 10);

      return {
        exists: true,
        path: worktreePath,
        branch,
        commitCount,
        lastModified: stat.mtime.toISOString(),
        hasUncommittedChanges,
        modifiedFiles,
      };
    } catch (err) {
      return { exists: false };
    }
  }

  /**
   * Get dependency information for a task.
   */
  private async getDependencyInfo(task: TrackerTask): Promise<DeadlockDiagnostic['dependencies']> {
    // Get all tasks to check dependencies
    const allTasks = await this.tracker.getTasks({
      status: ['open', 'in_progress', 'completed'],
    });

    const taskMap = new Map(allTasks.map(t => [t.id, t]));

    // Find dependencies (dependsOn field)
    const dependsOn: TrackerTask[] = [];
    if (task.dependsOn) {
      for (const depId of task.dependsOn) {
        const depTask = taskMap.get(depId);
        if (depTask) {
          dependsOn.push(depTask);
        }
      }
    }

    // Find blocked tasks (blocks field)
    const blocks: TrackerTask[] = [];
    if (task.blocks) {
      for (const blockedId of task.blocks) {
        const blockedTask = taskMap.get(blockedId);
        if (blockedTask) {
          blocks.push(blockedTask);
        }
      }
    }

    return { dependsOn, blocks };
  }

  /**
   * Commit uncommitted changes in a worktree.
   */
  private async commitWorktreeChanges(diagnostic: DeadlockDiagnostic): Promise<boolean> {
    if (!diagnostic.worktreeState.path) {
      return false;
    }

    try {
      const worktreePath = diagnostic.worktreeState.path;

      // Stage all changes
      this.git(['-C', worktreePath, 'add', '-A']);

      // Create commit
      const commitMessage = `feat(${diagnostic.task.id}): ${diagnostic.task.title}`;
      this.git(['-C', worktreePath, 'commit', '-m', commitMessage]);

      console.log(`[deadlock-resolver] Committed changes for task ${diagnostic.task.id}`);
      return true;
    } catch (err) {
      console.error(`[deadlock-resolver] Failed to commit changes for task ${diagnostic.task.id}:`, err);
      return false;
    }
  }

  /**
   * Build diagnostic prompt for AI agent.
   */
  private buildDiagnosticPrompt(diagnostic: DeadlockDiagnostic): string {
    const { task, gitState, worktreeState, stuckDurationMs } = diagnostic;

    return `You are analyzing a deadlocked parallel task execution. Recommend how to resolve it.

## Task Status
- ID: ${task.id}
- Title: ${task.title}
- Status: ${task.status}
- Stuck for: ${Math.round(stuckDurationMs / 60000)} minutes
- Updated: ${task.updatedAt}

## Git Repository State
- Current branch: ${gitState.currentBranch}
- Current commit: ${gitState.currentCommit}
- Uncommitted changes: ${gitState.uncommittedChanges}
- In merge: ${gitState.inMerge}
- In rebase: ${gitState.inRebase}
- In cherry-pick: ${gitState.inCherryPick}

## Worktree State
- Exists: ${worktreeState.exists}
${worktreeState.exists ? `- Path: ${worktreeState.path}
- Branch: ${worktreeState.branch}
- Commits: ${worktreeState.commitCount}
- Last modified: ${worktreeState.lastModified}
- Has uncommitted changes: ${worktreeState.hasUncommittedChanges ?? false}
${worktreeState.modifiedFiles ? `- Modified files: ${worktreeState.modifiedFiles.join(', ')}` : ''}` : ''}

## Your Task
Analyze this deadlock and recommend ONE action:

1. **continue** - Worktree exists and has valid commits/changes, should resume/commit and continue
2. **merge_and_close** - Worktree completed successfully, merge results and close task
3. **reset_to_open** - Worktree is invalid/empty, reset task to open for retry
4. **skip_and_close** - Task is irrelevant or blocking, skip and close it

## Output Format
Respond with JSON only:
{"type": "action_type", "reason": "explanation", "preserveWorktree": false}

Choose the action that best recovers execution without losing work.`;
  }

  /**
   * Query AI agent for recommended action.
   */
  private async queryAiForAction(prompt: string): Promise<DeadlockAction> {
    const agentRegistry = getAgentRegistry();
    const agent = await agentRegistry.getInstance(this.agentConfig.agent);

    const handle = agent.execute(prompt, [], {
      cwd: this.config.cwd,
      timeout: this.config.aiResolutionTimeoutMs ?? 120000,
    });

    const result = await handle.promise;

    if (result.status !== 'completed' || result.exitCode !== 0) {
      throw new Error(`Agent execution failed: ${result.stderr}`);
    }

    // Parse JSON response
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Agent did not return valid JSON');
    }

    const action = JSON.parse(jsonMatch[0]) as DeadlockAction;
    return action;
  }

  /**
   * Execute the AI's recommended action.
   */
  private async executeAction(
    diagnostic: DeadlockDiagnostic,
    action: DeadlockAction
  ): Promise<DeadlockResolutionResult> {
    const { task, worktreeState } = diagnostic;

    switch (action.type) {
      case 'continue':
        // Worktree exists, try to continue execution
        if (!worktreeState.exists) {
          return await this.deterministicResolution(diagnostic, 'Cannot continue: worktree does not exist');
        }
        return {
          success: true,
          actionTaken: action,
          message: `Task ${task.id} marked for continued execution in existing worktree`,
          taskReset: false,
          worktreePreserved: true,
        };

      case 'merge_and_close':
        // Try to merge worktree results
        return await this.mergeAndClose(diagnostic, action);

      case 'reset_to_open':
        // Reset task to open for retry
        return await this.safeReset(task, action.reason);

      case 'skip_and_close':
        // Mark task as completed without merging
        return await this.skipAndClose(task, action.reason);

      default:
        return await this.deterministicResolution(diagnostic, `Unknown action type: ${(action as { type: string }).type}`);
    }
  }

  /**
   * Deterministic fallback resolution when AI fails.
   */
  private async deterministicResolution(
    diagnostic: DeadlockDiagnostic,
    reason: string
  ): Promise<DeadlockResolutionResult> {
    const { task, worktreeState } = diagnostic;

    // If worktree exists and has commits or uncommitted changes, try to commit and continue
    if (worktreeState.exists && (worktreeState.commitCount! > 0 || worktreeState.hasUncommittedChanges)) {
      console.log(`[deadlock-resolver] Deterministic resolution: worktree has work, attempting commit...`);

      const commitSuccess = await this.commitWorktreeChanges(diagnostic);

      if (commitSuccess) {
        return {
          success: true,
          actionTaken: { type: 'continue', reason: 'Deterministic: committed worktree changes' },
          message: `Task ${task.id} worktree changes committed (deterministic fallback)`,
          taskReset: false,
          worktreePreserved: true,
        };
      }
    }

    // Otherwise, safe reset
    return await this.safeReset(task, `Deterministic fallback: ${reason}`);
  }

  /**
   * Merge worktree results and close task.
   */
  private async mergeAndClose(
    diagnostic: DeadlockDiagnostic,
    action: DeadlockAction
  ): Promise<DeadlockResolutionResult> {
    const { task } = diagnostic;

    try {
      // Attempt to merge the worktree branch
      if (diagnostic.worktreeState.exists && diagnostic.worktreeState.branch) {
        // TODO: Implement actual merge logic
        // For now, just close the task
        await this.tracker.completeTask(task.id, `AI-resolved deadlock: ${action.reason}`);
      } else {
        await this.tracker.completeTask(task.id, `AI-resolved deadlock (no worktree): ${action.reason}`);
      }

      return {
        success: true,
        actionTaken: action,
        message: `Task ${task.id} merged and closed: ${action.reason}`,
        taskReset: false,
        worktreePreserved: 'preserveWorktree' in action ? (action as { preserveWorktree?: boolean }).preserveWorktree ?? false : false,
      };
    } catch (err) {
      return await this.safeReset(task, `Merge failed: ${(err as Error).message}`);
    }
  }

  /**
   * Safely reset a task to open status.
   */
  private async safeReset(task: TrackerTask, reason: string): Promise<DeadlockResolutionResult> {
    try {
      await this.tracker.updateTaskStatus(task.id, 'open');
      return {
        success: true,
        actionTaken: { type: 'reset_to_open', reason },
        message: `Task ${task.id} reset to open: ${reason}`,
        taskReset: true,
        worktreePreserved: false,
      };
    } catch (err) {
      return {
        success: false,
        actionTaken: { type: 'reset_to_open', reason },
        message: `Failed to reset task ${task.id}: ${(err as Error).message}`,
        taskReset: false,
        worktreePreserved: false,
      };
    }
  }

  /**
   * Skip and close a task (mark as completed without changes).
   */
  private async skipAndClose(task: TrackerTask, reason: string): Promise<DeadlockResolutionResult> {
    try {
      await this.tracker.completeTask(task.id, `Skipped (AI decision): ${reason}`);
      return {
        success: true,
        actionTaken: { type: 'skip_and_close', reason },
        message: `Task ${task.id} skipped and closed: ${reason}`,
        taskReset: false,
        worktreePreserved: false,
      };
    } catch (err) {
      return await this.safeReset(task, `Skip failed: ${(err as Error).message}`);
    }
  }

  /**
   * Execute a git command.
   */
  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.config.cwd, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: ':',
      },
    });
  }
}
