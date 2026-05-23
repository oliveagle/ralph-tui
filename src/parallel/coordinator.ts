/**
 * ABOUTME: Coordinator Agent for parallel task execution.
 * Runs in the main directory and is responsible for:
 * - Monitoring worktree completion
 * - Executing merges
 * - Resolving conflicts
 * - Closing tasks in the tracker
 * - Cleaning up worktrees on completion
 */

import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { RalphConfig } from '../config/types.js';
import type { TrackerPlugin, TrackerTask } from '../plugins/trackers/types.js';
import { MergeEngine } from './merge-engine.js';
import { ConflictResolver, type AiResolverCallback } from './conflict-resolver.js';
import { createAiResolver } from './ai-resolver.js';
import type { MergeOperation } from './types.js';

export interface CoordinatorConfig {
  cwd: string;
  sessionId: string;
  maxConflictsRetries: number;
  conflictResolutionTimeoutMs: number;
}

export interface WorktreeCompletion {
  worktreeId: string;
  taskId: string;
  branchName: string;
  completedAt: string;
  commitCount: number;
}

/**
 * Coordinator Agent - dedicated agent for merge and conflict resolution.
 *
 * Unlike workers that implement tasks, the Coordinator runs in the main directory
 * and is responsible for the merge pipeline. It monitors worktree completion,
 * executes merges, resolves conflicts, and closes tasks.
 */
export class CoordinatorAgent extends EventEmitter {
  private readonly config: CoordinatorConfig;
  private readonly tracker: TrackerPlugin;
  private readonly mergeEngine: MergeEngine;
  private readonly conflictResolver: ConflictResolver;
  private readonly aiResolver: AiResolverCallback;

  private pendingMerges: Map<string, MergeOperation> = new Map();
  private completedTasks: Set<string> = new Set();
  private failedTasks: Set<string> = new Set();

  constructor(
    config: CoordinatorConfig,
    tracker: TrackerPlugin,
    baseConfig: RalphConfig
  ) {
    super();
    this.config = config;
    this.tracker = tracker;

    this.mergeEngine = new MergeEngine(config.cwd);
    this.conflictResolver = new ConflictResolver(config.cwd);

    // Create AI resolver using the session's agent
    this.aiResolver = createAiResolver(baseConfig);
    this.conflictResolver.setAiResolver(this.aiResolver);

    // Wire up merge events
    this.mergeEngine.on((event) => this.emit('event', event));
    this.conflictResolver.on((event) => this.emit('event', event));
  }

  /**
   * Get the Coordinator's system prompt for rendering agent instructions.
   * This prompt tells the agent what to do for merge operations.
   */
  getSystemPrompt(): string {
    return `## Coordinator Agent - Merge Pipeline

You are the Coordinator Agent for parallel task execution.

### Your Responsibilities

1. **Monitor Worktree Completion**
   - Track worktrees that have completed their tasks
   - Update task status to 'merging' when worktree signals completion

2. **Execute Merges**
   - Merge completed worktree branches into the session branch
   - Handle both fast-forward and merge-commit scenarios
   - Track merge status for each task

3. **Resolve Conflicts**
   - Auto-resolve trivial conflicts (.beads JSONL, progress.md, etc.)
   - Use AI agent for complex code conflicts
   - Maximum ${this.config.maxConflictsRetries} retries per conflict

4. **Close Tasks**
   - On successful merge: call tracker.completeTask()
   - On merge failure: reset task to 'open' for retry

5. **Cleanup**
   - Remove worktree directories after successful merge
   - Preserve worktrees for failed tasks (for recovery)

### Worktree Completion Protocol

When a worktree agent sends <promise>COMPLETE</promise>:
1. Update task status to 'merging' via tracker.updateTaskStatus(taskId, 'merging')
2. Add worktree to merge queue
3. Execute merge with conflict resolution
4. On success: tracker.completeTask() and cleanup worktree
5. On failure: tracker.updateTaskStatus(taskId, 'open') and preserve worktree

### Conflict Resolution Priority

1. **Auto-resolve** (always attempted first):
   - .beads/issues.jsonl: Merge all unique JSONL entries
   - progress.md: Merge unique task entries by date header
   - README.md: Use ours version (main branch priority)

2. **AI-resolve** (if auto fails):
   - Call the configured AI agent with conflict context
   - 2 minute timeout per file
   - Retry up to ${this.config.maxConflictsRetries} times

3. **Abort** (if AI fails):
   - Rollback to pre-merge state
   - Reset task to 'open' for retry in next batch

### Example Commands

\`\`\`bash
# Update task to merging
tracker.updateTaskStatus('beads-test-6bf', 'merging')

# Execute merge
git merge --ff-only ralph-parallel/session-id/beads-test-6bf

# On conflict: auto-resolve then commit
git add -A && git commit -m "Merge: beads-test-6bf"

# Close task on success
tracker.completeTask('beads-test-6bf', 'Merged and completed')
\`\`\`

### Stop Condition

When all tasks are completed or all worktrees are cleaned up, signal completion with:
<promise>COMPLETE</promise>
`;
  }

  /**
   * Register a completion callback for worktree agents.
   * Called when a worktree agent sends COMPLETE signal.
   */
  async onWorktreeComplete(completion: WorktreeCompletion): Promise<void> {
    // Update task to merging status
    try {
      await this.tracker.updateTaskStatus(completion.taskId, 'merging');
    } catch (err) {
      console.error(`[coordinator] Failed to update task ${completion.taskId} to merging:`, err);
    }

    // Create merge operation
    const operation = this.mergeEngine.enqueue({
      workerId: completion.worktreeId,
      task: {
        id: completion.taskId,
        title: '',
        status: 'merging',
        priority: 2,
      } as TrackerTask,
      success: true,
      iterationsRun: 0,
      taskCompleted: true,
      durationMs: 0,
      branchName: completion.branchName,
      commitCount: completion.commitCount,
    });

    this.pendingMerges.set(completion.taskId, operation);

    // Process the merge
    await this.processMerge(completion.taskId);
  }

  /**
   * Process a single merge operation.
   */
  private async processMerge(taskId: string): Promise<void> {
    const operation = this.pendingMerges.get(taskId);
    if (!operation) {
      return;
    }

    // Execute merge
    const result = await this.mergeEngine.processNext();

    if (result?.success) {
      // Merge succeeded - close the task
      await this.closeTask(taskId);
    } else if (result?.hadConflicts) {
      // Merge had conflicts - resolve them
      const resolved = await this.resolveConflicts(operation);

      if (resolved) {
        await this.closeTask(taskId);
      } else {
        await this.failTask(taskId);
      }
    } else {
      // Merge failed (non-conflict)
      await this.failTask(taskId);
    }
  }

  /**
   * Execute a git command in the session's working directory.
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

  /**
   * Resolve conflicts using auto-resolve and AI.
   */
  private async resolveConflicts(operation: MergeOperation): Promise<boolean> {
    let retries = 0;
    const maxRetries = this.config.maxConflictsRetries;

    while (retries < maxRetries) {
      const results = await this.conflictResolver.resolveConflicts(operation);
      const allResolved = results.every((r) => r.success);

      if (allResolved) {
        return true;
      }

      retries++;

      if (retries < maxRetries) {
        console.warn(`[coordinator] Conflict resolution attempt ${retries} failed, retrying...`);
        // Retry the merge
        try {
          this.git(['merge', '--abort']);
        } catch {
          // Ignore
        }
      }
    }

    return false;
  }

  /**
   * Close a task after successful merge.
   */
  private async closeTask(taskId: string): Promise<void> {
    try {
      await this.tracker.completeTask(taskId);
      this.completedTasks.add(taskId);
      this.pendingMerges.delete(taskId);
      console.log(`[coordinator] Task ${taskId} completed successfully`);
    } catch (err) {
      console.error(`[coordinator] Failed to close task ${taskId}:`, err);
    }
  }

  /**
   * Handle task failure - reset to open for retry.
   */
  private async failTask(taskId: string): Promise<void> {
    try {
      await this.tracker.updateTaskStatus(taskId, 'open');
      this.failedTasks.add(taskId);
      this.pendingMerges.delete(taskId);
      console.warn(`[coordinator] Task ${taskId} merge failed - reset to open`);
    } catch (err) {
      console.error(`[coordinator] Failed to reset task ${taskId}:`, err);
    }
  }

  /**
   * Get current status of all pending and completed tasks.
   */
  getStatus(): {
    pendingMerges: number;
    completedTasks: number;
    failedTasks: number;
    completedTaskIds: string[];
    failedTaskIds: string[];
  } {
    return {
      pendingMerges: this.pendingMerges.size,
      completedTasks: this.completedTasks.size,
      failedTasks: this.failedTasks.size,
      completedTaskIds: Array.from(this.completedTasks),
      failedTaskIds: Array.from(this.failedTasks),
    };
  }

  /**
   * Check if all tasks are processed.
   */
  isComplete(): boolean {
    return this.pendingMerges.size === 0 &&
      (this.completedTasks.size > 0 || this.failedTasks.size > 0);
  }
}