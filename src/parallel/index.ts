/**
 * ABOUTME: ParallelExecutor — top-level coordinator for parallel task execution.
 * Analyzes task dependencies, groups independent tasks, executes them in parallel
 * git worktrees, and merges results back sequentially with conflict resolution.
 */

import { readFile, writeFile, appendFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { RalphConfig } from '../config/types.js';
import type { TrackerPlugin, TrackerTask } from '../plugins/trackers/types.js';
import type { EngineEventListener } from '../engine/types.js';
import { analyzeTaskGraph, shouldRunParallel } from './task-graph.js';
import { WorktreeManager } from './worktree-manager.js';
import { MergeEngine } from './merge-engine.js';
import { ConflictResolver, type AiResolverCallback } from './conflict-resolver.js';
import { Worker } from './worker.js';
import type {
  MergeOperation,
  ParallelExecutorConfig,
  ParallelExecutorState,
  ParallelExecutorStatus,
  TaskGraphAnalysis,
  WorktreeInfo,
  WorkerDisplayState,
  WorkerResult,
  MergeResult,
  FileConflict,
} from './types.js';
import type {
  ParallelEvent,
  ParallelEventListener,
} from './events.js';

/** Default parallel executor configuration */
const DEFAULT_PARALLEL_CONFIG: ParallelExecutorConfig = {
  maxWorkers: 3,
  worktreeDir: '.ralph-tui/worktrees',
  cwd: process.cwd(),
  maxIterationsPerWorker: 10,
  iterationDelay: 1000,
  aiConflictResolution: true,
  maxRequeueCount: 1,
};

interface PendingConflictEntry {
  operation: MergeOperation;
  workerResult: WorkerResult;
}

/**
 * Coordinates parallel execution of independent tasks using git worktrees.
 *
 * Execution flow:
 * 1. Fetch all tasks from the tracker
 * 2. Run TaskGraphAnalysis to find parallel groups
 * 3. For each group (in topological order):
 *    a. Acquire worktrees (up to maxWorkers per batch)
 *    b. Create + start workers (one per task)
 *    c. Wait for all workers in the group to complete
 *    d. Merge completed workers via merge queue (sequential)
 *    e. Handle merge conflicts (rollback + re-queue if needed)
 *    f. Release worktrees
 * 4. After all groups: cleanup all worktrees, emit completion
 */
export class ParallelExecutor {
  private readonly config: ParallelExecutorConfig;
  private readonly baseConfig: RalphConfig;
  private readonly tracker: TrackerPlugin;

  private readonly worktreeManager: WorktreeManager;
  private readonly mergeEngine: MergeEngine;
  private readonly conflictResolver: ConflictResolver;

  private status: ParallelExecutorStatus = 'idle';
  private taskGraph: TaskGraphAnalysis | null = null;
  private currentGroupIndex = 0;
  private activeWorkers: Worker[] = [];
  private completedResults: WorkerResult[] = [];
  private totalTasksCompleted = 0;
  private totalTasksFailed = 0;
  private totalMergesCompleted = 0;
  private totalConflictsResolved = 0;
  private startedAt: string | null = null;
  private sessionId: string;
  private shouldStop = false;
  private paused = false;
  private statusBeforePause: ParallelExecutorStatus | null = null;
  private pauseWaiters: Array<() => void> = [];
  private returnToOriginalBranchError: string | null = null;

  private readonly parallelListeners: ParallelEventListener[] = [];
  private readonly engineListeners: EngineEventListener[] = [];

  /** Track re-queue counts per task to prevent infinite loops */
  private requeueCounts = new Map<string, number>();

  /** Pending conflicts that need user-driven retry/skip actions */
  private pendingConflicts: PendingConflictEntry[] = [];

  /**
   * Worktrees intentionally preserved on cleanup for manual recovery.
   * These correspond to branches with failed or unmerged results.
   */
  private preservedRecoveryWorktrees: WorktreeInfo[] = [];

  constructor(
    baseConfig: RalphConfig,
    tracker: TrackerPlugin,
    parallelConfig?: Partial<ParallelExecutorConfig>
  ) {
    this.baseConfig = baseConfig;
    this.tracker = tracker;
    this.sessionId = baseConfig.sessionId ?? `parallel-${Date.now()}`;

    this.config = {
      ...DEFAULT_PARALLEL_CONFIG,
      cwd: baseConfig.cwd,
      maxIterationsPerWorker: baseConfig.maxIterations,
      iterationDelay: baseConfig.iterationDelay,
      ...parallelConfig,
    };

    this.worktreeManager = new WorktreeManager({
      cwd: this.config.cwd,
      worktreeDir: this.config.worktreeDir,
      maxWorktrees: this.config.maxWorkers * 2, // Buffer for re-queued tasks
    });

    this.mergeEngine = new MergeEngine(this.config.cwd);
    this.conflictResolver = new ConflictResolver(this.config.cwd);

    // Wire up merge and conflict events
    this.mergeEngine.on((event) => this.emitParallel(event));
    this.conflictResolver.on((event) => this.emitParallel(event));
  }

  /**
   * Register a parallel event listener.
   * @returns Unsubscribe function
   */
  on(listener: ParallelEventListener): () => void {
    this.parallelListeners.push(listener);
    return () => {
      const idx = this.parallelListeners.indexOf(listener);
      if (idx >= 0) this.parallelListeners.splice(idx, 1);
    };
  }

  /**
   * Register an engine event listener for forwarded worker events.
   * @returns Unsubscribe function
   */
  onEngineEvent(listener: EngineEventListener): () => void {
    this.engineListeners.push(listener);
    return () => {
      const idx = this.engineListeners.indexOf(listener);
      if (idx >= 0) this.engineListeners.splice(idx, 1);
    };
  }

  /**
   * Set the AI conflict resolver callback.
   */
  setAiResolver(resolver: AiResolverCallback): void {
    this.conflictResolver.setAiResolver(resolver);
  }

  /**
   * Retry conflict resolution for the pending failed operation.
   * Returns true if retry was initiated, false if no pending conflict.
   */
  async retryConflictResolution(): Promise<boolean> {
    const pending = this.pendingConflicts[0];
    const operation = pending?.operation;
    const workerResult = pending?.workerResult;

    if (!operation || !workerResult) {
      return false;
    }

    // Save tracker state before resolution to prevent stale worktree state from overwriting
    const savedState = await this.saveTrackerState();

    try {
      // Re-attempt resolution
      const resolutions = await this.conflictResolver.resolveConflicts(operation);
      const allResolved = resolutions.every((r) => r.success);

      if (allResolved) {
        // Success! Remove the resolved pending entry and mark task as complete.
        this.removePendingConflictByOperationId(operation.id);

        try {
          await this.tracker.completeTask(workerResult.task.id);
        } catch {
          // Log but don't fail after successful resolution
        }

        await this.mergeProgressFile(workerResult);
        this.totalConflictsResolved += resolutions.length;
        this.totalMergesCompleted++;
        this.emitNextPendingConflictIfAny();
        return true;
      }

      // Still failed - keep pending state for another retry
      return false;
    } finally {
      // Always restore tracker state to prevent stale worktree data from persisting
      await this.restoreTrackerState(savedState);
    }
  }

  /**
   * Skip the pending failed conflict and continue execution.
   * The task's merge will be abandoned (task remains incomplete).
   */
  skipFailedConflict(): void {
    const pending = this.pendingConflicts.shift();
    if (!pending) {
      return;
    }

    this.markConflictOperationRolledBack(
      pending.operation.id,
      'Skipped by user after failed conflict resolution'
    );

    // Emit an event so the TUI knows to close the conflict panel.
    this.emitParallel({
      type: 'conflict:resolved',
      timestamp: new Date().toISOString(),
      operationId: pending.operation.id,
      taskId: pending.workerResult.task.id,
      results: [],
    });

    this.emitNextPendingConflictIfAny();
  }

  /**
   * Check if there's a pending conflict operation.
   */
  hasPendingConflict(): boolean {
    return this.pendingConflicts.length > 0;
  }

  /**
   * Reset internal state so the executor can run again.
   * Call this before `execute()` when restarting after completion or stop.
   */
  reset(): void {
    this.shouldStop = false;
    this.status = 'idle';
    this.taskGraph = null;
    this.currentGroupIndex = 0;
    this.activeWorkers = [];
    this.completedResults = [];
    this.totalTasksCompleted = 0;
    this.totalTasksFailed = 0;
    this.totalMergesCompleted = 0;
    this.totalConflictsResolved = 0;
    this.startedAt = null;
    this.requeueCounts.clear();
    this.sessionId = `parallel-${Date.now()}`;
    this.paused = false;
    this.statusBeforePause = null;
    this.pauseWaiters = [];
    this.pendingConflicts = [];
    this.preservedRecoveryWorktrees = [];
    this.returnToOriginalBranchError = null;
    // Clear merge queue to prevent stale operations from interfering with new execution
    this.mergeEngine.clearQueue();
  }

  /**
   * Analyze tasks and run parallel execution.
   * Main entry point for the parallel execution flow.
   */
  async execute(): Promise<void> {
    this.startedAt = new Date().toISOString();
    this.status = 'analyzing';

    try {
      // Fetch all tasks from the tracker
      let tasks = await this.tracker.getTasks({
        status: ['open', 'in_progress'],
      });

      // Apply task ID filter if provided (for --task-range support)
      if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
        const filteredIdSet = new Set(this.config.filteredTaskIds);
        tasks = tasks.filter((t) => filteredIdSet.has(t.id));
      }

      // Filter out epics - they cannot be claimed/processed by workers
      tasks = tasks.filter((t) => t.type !== 'epic');

      // Auto-poll mode: wait for tasks instead of exiting immediately
      if (tasks.length === 0) {
        if (this.config.autoPoll) {
          this.emitParallel({
            type: 'parallel:group-started',
            timestamp: new Date().toISOString(),
            group: null,
            groupIndex: -1,
            totalGroups: 0,
            workerCount: this.config.maxWorkers,
            isContinuousFetch: true,
          });
          await this.pollForTasks();
          tasks = await this.tracker.getTasks({
            status: ['open', 'in_progress'],
          });
          if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
            const filteredIdSet = new Set(this.config.filteredTaskIds);
            tasks = tasks.filter((t) => filteredIdSet.has(t.id));
          }
          tasks = tasks.filter((t) => t.type !== 'epic');
        }

        if (tasks.length === 0) {
          this.status = 'completed';
          return;
        }
      }

      // Analyze task graph
      this.taskGraph = analyzeTaskGraph(tasks);

      if (!shouldRunParallel(this.taskGraph)) {
        // In auto-poll mode, wait for more tasks instead of exiting immediately
        if (this.config.autoPoll) {
          this.emitParallel({
            type: 'parallel:group-started',
            timestamp: new Date().toISOString(),
            group: null,
            groupIndex: -1,
            totalGroups: 0,
            workerCount: this.config.maxWorkers,
            isContinuousFetch: true,
          });
          await this.pollForTasks();
          // After polling, re-fetch and re-analyze tasks
          tasks = await this.tracker.getTasks({
            status: ['open', 'in_progress'],
          });
          if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
            const filteredIdSet = new Set(this.config.filteredTaskIds);
            tasks = tasks.filter((t) => filteredIdSet.has(t.id));
          }
          tasks = tasks.filter((t) => t.type !== 'epic');
          if (tasks.length === 0) {
            this.status = 'completed';
            return;
          }
          this.taskGraph = analyzeTaskGraph(tasks);
          // If still not enough tasks for parallel, exit
          if (!shouldRunParallel(this.taskGraph)) {
            this.status = 'completed';
            return;
          }
        } else {
          // Fall back — this shouldn't happen if the caller checked first
          this.status = 'completed';
          return;
        }
      }

      // Initialize session branch unless directMerge is enabled.
      // The session branch holds all worker merges, keeping the original branch clean.
      if (!this.config.directMerge) {
        const { branch, original } = this.mergeEngine.initializeSessionBranch(
          this.sessionId,
          this.config.sessionBranchName
        );

        this.emitParallel({
          type: 'parallel:session-branch-created',
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          sessionBranch: branch,
          originalBranch: original,
        });
      }

      // Create session backup (on the session branch if one was created)
      this.mergeEngine.createSessionBackup(this.sessionId);

      this.emitParallel({
        type: 'parallel:started',
        timestamp: this.startedAt,
        sessionId: this.sessionId,
        analysis: this.taskGraph,
        totalGroups: this.taskGraph.groups.length,
        totalTasks: this.taskGraph.actionableTaskCount,
        maxWorkers: this.config.maxWorkers,
        scopes: this.config.scopes,
      });

      // Execute groups in topological order
      for (let i = 0; i < this.taskGraph.groups.length; i++) {
        if (this.shouldStop) break;
        await this.waitWhilePaused();
        if (this.shouldStop) break;

        this.currentGroupIndex = i;
        const group = this.taskGraph.groups[i];

        await this.executeGroup(group, i);
      }

      // Continuous mode: after completing all initial tasks, keep fetching and processing new tasks.
      // Workers are continuously restarted to pick up newly available tasks.
      while (!this.shouldStop) {
        await this.waitWhilePaused();
        if (this.shouldStop) break;

        // Check if there are new tasks available
        const newTasks = await this.tracker.getTasks({
          status: ['open', 'in_progress'],
        });

        if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
          const filteredIdSet = new Set(this.config.filteredTaskIds);
          newTasks.filter((t) => filteredIdSet.has(t.id));
        }

        const actionableTasks = newTasks.filter((t) => t.type !== 'epic');
        if (actionableTasks.length === 0) {
          if (this.config.autoPoll) {
            // Auto-loop mode: wait for tasks instead of exiting
            this.emitParallel({
              type: 'parallel:group-started',
              timestamp: new Date().toISOString(),
              group: null,
              groupIndex: -1,
              totalGroups: 0,
              workerCount: this.config.maxWorkers,
              isContinuousFetch: true,
            });
            await this.pollForTasks();
            // Re-fetch tasks after polling
            const postPollTasks = await this.tracker.getTasks({
              status: ['open', 'in_progress'],
            });
            let filtered = postPollTasks;
            if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
              const filteredIdSet = new Set(this.config.filteredTaskIds);
              filtered = postPollTasks.filter((t) => filteredIdSet.has(t.id));
            }
            const postPollActionable = filtered.filter((t) => t.type !== 'epic');
            if (postPollActionable.length === 0) {
              // Still no tasks after polling, exit continuous mode
              break;
            }
            // Continue to analyze and process the new tasks
            const newTaskGraph = analyzeTaskGraph(postPollActionable);
            if (!shouldRunParallel(newTaskGraph)) {
              // Not enough tasks for parallel, exit continuous mode
              break;
            }
            this.taskGraph = newTaskGraph;
          } else {
            // No new tasks, break out of continuous mode
            break;
          }
        } else {
          // Analyze task graph for new tasks
          const newTaskGraph = analyzeTaskGraph(actionableTasks);
          if (!shouldRunParallel(newTaskGraph)) {
            // No parallel work available
            break;
          }

          this.taskGraph = newTaskGraph;
        }
        this.currentGroupIndex = 0;

        this.emitParallel({
          type: 'parallel:group-started',
          timestamp: new Date().toISOString(),
          group: null,
          groupIndex: -1,
          totalGroups: this.taskGraph.groups.length,
          workerCount: this.config.maxWorkers,
          isContinuousFetch: true,
        });

        // Execute all groups again
        for (let i = 0; i < this.taskGraph.groups.length; i++) {
          if (this.shouldStop) break;
          await this.waitWhilePaused();
          if (this.shouldStop) break;

          this.currentGroupIndex = i;
          const group = this.taskGraph.groups[i];

          await this.executeGroup(group, i);
        }
      }

      const allActionableTasksCompleted =
        this.totalTasksCompleted >= this.taskGraph.actionableTaskCount &&
        this.totalTasksFailed === 0;
      this.status = this.shouldStop || !allActionableTasksCompleted
        ? 'interrupted'
        : 'completed';

      this.emitParallel({
        type: 'parallel:completed',
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        totalTasksCompleted: this.totalTasksCompleted,
        totalTasksFailed: this.totalTasksFailed,
        totalMergesCompleted: this.totalMergesCompleted,
        totalConflictsResolved: this.totalConflictsResolved,
        durationMs: Date.now() - new Date(this.startedAt).getTime(),
      });
    } catch (err) {
      this.status = 'failed';
      const error = err instanceof Error ? err.message : String(err);

      this.emitParallel({
        type: 'parallel:failed',
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        error,
        tasksCompletedBeforeFailure: this.totalTasksCompleted,
      });

      throw err;
    } finally {
      // Always cleanup
      await this.cleanup();
    }
  }

  /**
   * Stop parallel execution gracefully.
   * Stops all active workers and waits for them to finish.
   */
  async stop(): Promise<void> {
    this.shouldStop = true;
    this.paused = false;
    this.statusBeforePause = null;
    this.releasePauseWaiters();

    // Stop all active workers
    const stopPromises = this.activeWorkers.map((w) => w.stop());
    await Promise.allSettled(stopPromises);

    this.status = 'interrupted';
  }

  /**
   * Pause all active workers after their current iterations complete.
   */
  pause(): void {
    if (this.paused || this.status === 'completed' || this.status === 'failed') {
      return;
    }

    this.paused = true;
    this.statusBeforePause = this.status;
    this.status = 'paused';

    for (const worker of this.activeWorkers) {
      worker.pause();
    }
  }

  /**
   * Resume all active workers from paused state.
   */
  resume(): void {
    if (!this.paused) {
      return;
    }

    this.paused = false;
    this.status = this.statusBeforePause ?? 'executing';
    this.statusBeforePause = null;
    this.releasePauseWaiters();

    for (const worker of this.activeWorkers) {
      worker.resume();
    }
  }

  /**
   * Get the current executor state for TUI rendering.
   */
  getState(): ParallelExecutorState {
    // Get merge queue to detect active merge operations
    const mergeQueue = this.mergeEngine.getQueue();
    const hasActiveMerges = mergeQueue.some(op =>
      op.status === 'queued' || op.status === 'in-progress' || op.status === 'conflicted'
    );

    return {
      status: this.status,
      taskGraph: this.taskGraph,
      currentGroupIndex: this.currentGroupIndex,
      totalGroups: this.taskGraph?.groups.length ?? 0,
      workers: this.activeWorkers.map((w) => w.getDisplayState()),
      maxWorkers: this.config.maxWorkers,
      workerResults: [...this.completedResults],
      mergeQueue: [...mergeQueue],
      completedMerges: [],
      activeConflicts: mergeQueue
        .filter(op => op.status === 'conflicted' && (op.conflictedFiles?.length ?? 0) > 0)
        .flatMap(op => (op.conflictedFiles ?? []).map((filePath): FileConflict => ({
          filePath,
          oursContent: '',
          theirsContent: '',
          baseContent: '',
          conflictMarkers: '',
        }))),
      totalTasksCompleted: this.totalTasksCompleted,
      totalTasks: this.taskGraph?.actionableTaskCount ?? 0,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt
        ? Date.now() - new Date(this.startedAt).getTime()
        : 0,
      scopes: this.config.scopes,
      hasActiveMerges,
    };
  }

  /**
   * Get the session branch name (e.g., "ralph-session/a4d1aae7").
   * @returns Session branch name, or null if using directMerge mode
   */
  getSessionBranch(): string | null {
    return this.mergeEngine.getSessionBranch();
  }

  /**
   * Get the original branch name before session branch was created.
   * @returns Original branch name, or null if using directMerge mode
   */
  getOriginalBranch(): string | null {
    return this.mergeEngine.getOriginalBranch();
  }

  /**
   * Get any error encountered when trying to return to the original branch.
   */
  getReturnToOriginalBranchError(): string | null {
    return this.returnToOriginalBranchError;
  }

  /**
   * Get worktrees that were intentionally preserved for manual recovery.
   */
  getPreservedRecoveryWorktrees(): WorktreeInfo[] {
    return [...this.preservedRecoveryWorktrees];
  }

  /**
   * Get display states for all active workers.
   */
  getWorkerStates(): WorkerDisplayState[] {
    return this.activeWorkers.map((w) => w.getDisplayState());
  }

  /**
   * Process a single merge operation and return the result.
   * This is a one-shot function that processes exactly one merge and exits.
   * Use this to spawn a fresh coordinator for each merge, preventing
   * long-running instability.
   *
   * @param workerResult - Result from a completed worker
   * @returns Merge result, or null if the merge should be skipped
   */
  async runSingleMerge(workerResult: WorkerResult): Promise<{
    success: boolean;
    hadConflicts: boolean;
    mergeResult?: MergeResult;
  }> {
    // Check if merge should be attempted
    const shouldMerge = workerResult.success &&
      (workerResult.taskCompleted || workerResult.commitCount > 0);

    if (!shouldMerge) {
      const skipReason = !workerResult.success
        ? `worker failed: ${workerResult.error ?? 'unknown error'}`
        : workerResult.commitCount === 0
          ? 'no commits made (files may be in .gitignore)'
          : 'unexpected state';

      console.warn(`[parallel] Skipping merge for task ${workerResult.task.id}: ${skipReason}`);
      return { success: false, hadConflicts: false };
    }

    // Save tracker state before merge
    const savedState = await this.saveTrackerState();

    try {
      // Enqueue and process the merge
      this.mergeEngine.enqueue(workerResult);
      const mergeResult = await this.mergeEngine.processNext();

      if (!mergeResult) {
        return { success: false, hadConflicts: false };
      }

      if (mergeResult.success) {
        // Merge succeeded - complete the task
        try {
          console.log(`[parallel] Completing task ${workerResult.task.id} after merge success`);
          const completeResult = await this.tracker.completeTask(workerResult.task.id);
          console.log(`[parallel] completeTask result for ${workerResult.task.id}: success=${completeResult.success}, message=${completeResult.message}`);
          if (!completeResult.success) {
            console.error(`[parallel] Failed to complete task ${workerResult.task.id}: ${completeResult.message}`);
          }
        } catch (err) {
          console.error(`[parallel] Exception completing task ${workerResult.task.id}:`, err);
        }
        // Merge worker's progress.md into main
        await this.mergeProgressFile(workerResult);
        this.totalMergesCompleted++;
        // Cleanup worktree after successful merge
        await this.worktreeManager.cleanupByBranch(workerResult.branchName);
        return { success: true, hadConflicts: false, mergeResult };
      }

      if (mergeResult.hadConflicts) {
        // Conflict resolution will be handled separately
        // Note: worktree cleanup will happen after conflict resolution
        return { success: false, hadConflicts: true, mergeResult };
      }

      // Merge failed (non-conflict)
      // Cleanup worktree even on merge failure
      await this.worktreeManager.cleanupByBranch(workerResult.branchName);
      return { success: false, hadConflicts: false, mergeResult };
    } finally {
      // Always restore tracker state
      await this.restoreTrackerState(savedState);
    }
  }

  /**
   * Resolve a single merge conflict operation.
   * This is a one-shot function that resolves exactly one conflict and exits.
   *
   * @param operation - The merge operation with conflicts
   * @param workerResult - The worker result that produced the merge
   * @returns True if resolution succeeded, false otherwise
   */
  async runSingleConflictResolution(
    operation: MergeOperation,
    workerResult: WorkerResult
  ): Promise<boolean> {
    // Save tracker state before conflict resolution
    const savedState = await this.saveTrackerState();

    try {
      const resolutions = await this.conflictResolver.resolveConflicts(operation);
      const allResolved = resolutions.every((r) => r.success);

      if (allResolved) {
        // Conflict resolution succeeded - complete the task
        try {
          await this.tracker.completeTask(workerResult.task.id);
        } catch {
          // Log but don't fail after successful resolution
        }
        // Merge worker's progress.md into main
        await this.mergeProgressFile(workerResult);
        this.totalConflictsResolved += resolutions.length;
        this.totalMergesCompleted++;
        // Cleanup worktree after successful conflict resolution
        await this.worktreeManager.cleanupByBranch(workerResult.branchName);
        return true;
      }

      // Conflict resolution failed - cleanup worktree
      await this.worktreeManager.cleanupByBranch(workerResult.branchName);
      return false;
    } finally {
      // Always restore tracker state
      await this.restoreTrackerState(savedState);
    }
  }

  /**
   * Execute a single parallel group.
   */
  private async executeGroup(
    group: { index: number; tasks: TrackerTask[]; depth: number },
    groupIndex: number
  ): Promise<void> {
    this.status = 'executing';
    const totalGroups = this.taskGraph!.groups.length;

    this.emitParallel({
      type: 'parallel:group-started',
      timestamp: new Date().toISOString(),
      group: { ...group, maxPriority: group.tasks[0]?.priority ?? 2 },
      groupIndex,
      totalGroups,
      workerCount: Math.min(group.tasks.length, this.config.maxWorkers),
    });

    // Process tasks in batches, allowing failed merges to be re-queued.
    const pendingTasks = [...group.tasks];
    let groupTasksCompleted = 0;
    let groupTasksFailed = 0;
    let groupMergesCompleted = 0;
    let groupMergesFailed = 0;

    while (pendingTasks.length > 0) {
      if (this.shouldStop) break;
      await this.waitWhilePaused();
      if (this.shouldStop) break;

      const [batch] = this.batchTasks(pendingTasks);
      if (!batch || batch.length === 0) {
        break;
      }
      pendingTasks.splice(0, batch.length);

      // Execute batch of workers in parallel
      const results = await this.executeBatch(batch);

      // Phase 1: Attempt all merges first, collect conflicts
      this.status = 'merging';
      const retryTasks: TrackerTask[] = [];
      const pendingConflicts: Array<{
        operation: MergeOperation;
        workerResult: WorkerResult;
      }> = [];

      for (const result of results) {
        if (this.shouldStop) {
          // Stop was requested mid-batch: do not merge partial work, reopen task instead.
          groupTasksFailed++;
          this.totalTasksFailed++;
          await this.resetTaskToOpen(result.task.id);
          continue;
        }

        // Each merge is handled via runSingleMerge — a one-shot function that
        // processes exactly one merge and exits. This prevents long-running
        // instability by ensuring each merge is an isolated operation.
        const mergeOutcome = await this.runSingleMerge(result);

        if (mergeOutcome.success) {
          // Merge succeeded via runSingleMerge
          this.requeueCounts.delete(result.task.id);
          groupTasksCompleted++;
          this.totalTasksCompleted++;
          groupMergesCompleted++;
        } else if (mergeOutcome.hadConflicts && mergeOutcome.mergeResult !== undefined) {
          // Conflict detected — collect for one-shot resolution
          const mergeResult = mergeOutcome.mergeResult; // narrow the type
          const operation = this.mergeEngine
            .getQueue()
            .find((op) => op.id === mergeResult.operationId);

          if (operation && this.config.aiConflictResolution) {
            pendingConflicts.push({ operation, workerResult: result });
          } else if (operation) {
            // AI conflict resolution disabled - requeue/fail based on retry budget.
            const requeued = await this.handleMergeFailure(result, operation);
            if (requeued) {
              retryTasks.push(result.task);
            } else {
              groupTasksFailed++;
              this.totalTasksFailed++;
              groupMergesFailed++;
            }
          }
        } else {
          // Merge failed or skipped (non-conflict) - requeue/fail based on retry budget.
          const requeued = await this.handleMergeFailure(result);
          if (requeued) {
            retryTasks.push(result.task);
          } else {
            groupTasksFailed++;
            this.totalTasksFailed++;
            groupMergesFailed++;
          }
        }
      }

      // Phase 2: Resolve all collected conflicts after all merges attempted
      if (pendingConflicts.length > 0) {
        if (this.shouldStop) {
          for (const { operation, workerResult } of pendingConflicts) {
            groupTasksFailed++;
            this.totalTasksFailed++;
            groupMergesFailed++;
            this.markConflictOperationRolledBack(
              operation.id,
              'Parallel execution stopped before conflict resolution'
            );
            await this.resetTaskToOpen(workerResult.task.id);
          }
          continue;
        }

        for (const { operation, workerResult } of pendingConflicts) {
          if (this.shouldStop) {
            groupTasksFailed++;
            this.totalTasksFailed++;
            groupMergesFailed++;
            this.markConflictOperationRolledBack(
              operation.id,
              'Parallel execution stopped before conflict resolution'
            );
            await this.resetTaskToOpen(workerResult.task.id);
            continue;
          }

          // Resolve conflicts using one-shot handler (exits after resolution)
          const resolutionSucceeded = await this.runSingleConflictResolution(operation, workerResult);

          if (resolutionSucceeded) {
            this.requeueCounts.delete(workerResult.task.id);
            groupTasksCompleted++;
            this.totalTasksCompleted++;
            groupMergesCompleted++;
          } else {
            // Conflict resolution failed - requeue first, then track as pending only
            // if retries are exhausted so the conflict queue reflects actionable items.
            const requeued = await this.handleMergeFailure(workerResult, operation);
            if (requeued) {
              retryTasks.push(workerResult.task);
              this.emitParallel({
                type: 'conflict:resolved',
                timestamp: new Date().toISOString(),
                operationId: operation.id,
                taskId: workerResult.task.id,
                results: [],
              });
            } else {
              this.enqueuePendingConflict(operation, workerResult);
              groupTasksFailed++;
              this.totalTasksFailed++;
              groupMergesFailed++;
            }
          }
        }
      }

      this.enqueueRetryTasks(pendingTasks, retryTasks);
    }

    this.emitParallel({
      type: 'parallel:group-completed',
      timestamp: new Date().toISOString(),
      groupIndex,
      totalGroups,
      tasksCompleted: groupTasksCompleted,
      tasksFailed: groupTasksFailed,
      mergesCompleted: groupMergesCompleted,
      mergesFailed: groupMergesFailed,
    });
  }

  /**
   * Execute a batch of tasks in parallel using workers.
   */
  private async executeBatch(tasks: TrackerTask[]): Promise<WorkerResult[]> {
    this.activeWorkers = [];

    // Create workers
    // Track branch names from worktree acquisition for failure result construction
    const branchNames: string[] = [];
    // Track tasks that failed to be claimed (blocked by dependencies)
    const blockedTasks: TrackerTask[] = [];
    // Track tasks that were successfully claimed
    const claimedTasks: TrackerTask[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const workerId = `w${this.currentGroupIndex}-${i}`;

      // Acquire worktree - use the sanitized branch name returned by acquire()
      // since acquire() sanitizes task IDs into valid git branch names
      const executionScope = (task as { executionScope?: { id: string } }).executionScope;
      const worktreeInfo = await this.worktreeManager.acquire(
        workerId,
        task.id,
        {
          sessionId: this.sessionId,
          scopeId: executionScope?.id,
        }
      );
      branchNames.push(worktreeInfo.branch);

      // Try to mark task as in_progress. For beads-rust, this triggers claim validation.
      // If the task is blocked by dependencies, the claim will fail — we should skip it.
      const updatedTask = await this.tracker.updateTaskStatus(task.id, 'in_progress');
      if (!updatedTask) {
        // Task is blocked by dependencies or claim failed — release worktree and skip
        this.worktreeManager.release(`worker-${workerId}`);
        blockedTasks.push(task);
        continue;
      }
      claimedTasks.push(task);

      const worker = new Worker(
        {
          id: workerId,
          task,
          worktreePath: worktreeInfo.path,
          branchName: worktreeInfo.branch,
          cwd: this.config.cwd,
        },
        this.config.maxIterationsPerWorker
      );

      // Forward worker events
      worker.on((event) => this.emitParallel(event));
      worker.onEngineEvent((event) => {
        for (const listener of this.engineListeners) {
          try {
            listener(event);
          } catch {
            // Don't let listener errors propagate
          }
        }
      });

      // Add worker to activeWorkers BEFORE initialize so that worker:created event
      // handler can see it in getWorkerStates() (fixes TUI showing fewer running
      // workers than expected during worker creation)
      this.activeWorkers.push(worker);

      // Initialize the worker engine with the shared tracker
      await worker.initialize(this.baseConfig, this.tracker);
    }

    // If no tasks were claimed, return empty results
    if (this.activeWorkers.length === 0) {
      return blockedTasks.map((task) => ({
        workerId: '',
        task,
        success: false,
        iterationsRun: 0,
        taskCompleted: false,
        durationMs: 0,
        error: 'Task is blocked by dependencies — could not claim',
        branchName: '',
        commitCount: 0,
      }));
    }

    // Start all workers in parallel
    const workerPromises = this.activeWorkers.map((w) => w.start());
    const results = await Promise.allSettled(workerPromises);

    // Collect results
    const workerResults: WorkerResult[] = results.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Worker promise rejected — create a failure result
      const task = claimedTasks[i];
      return {
        workerId: this.activeWorkers[i].id,
        task,
        success: false,
        iterationsRun: 0,
        taskCompleted: false,
        durationMs: 0,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        branchName: branchNames[i],
        commitCount: 0,
      };
    });

    // Release worktrees for active workers (use "worker-" prefix to match acquire's worktreeId format)
    for (const worker of this.activeWorkers) {
      this.worktreeManager.release(`worker-${worker.id}`);
    }

    this.completedResults.push(...workerResults);
    this.activeWorkers = [];

    return workerResults;
  }

  /**
   * Handle a merge failure by tracking retries and resetting the task to open.
   */
  private async handleMergeFailure(
    result: WorkerResult,
    operation?: MergeOperation
  ): Promise<boolean> {
    const taskId = result.task.id;
    const currentCount = this.requeueCounts.get(taskId) ?? 0;
    const shouldRequeue = currentCount < this.config.maxRequeueCount;

    if (shouldRequeue) {
      this.requeueCounts.set(taskId, currentCount + 1);
    }

    if (operation?.status === 'conflicted') {
      this.markConflictOperationRolledBack(
        operation.id,
        'Conflict resolution failed; task reset to open'
      );
    }

    await this.mergeProgressFile(result);
    await this.resetTaskToOpen(taskId);
    return shouldRequeue;
  }

  /**
   * Best-effort reset of a task status to open.
   * Prevents tasks from remaining stuck in in_progress after cancellation/failure.
   */
  private async resetTaskToOpen(taskId: string): Promise<void> {
    try {
      await this.tracker.updateTaskStatus(taskId, 'open');
    } catch {
      // Best effort
    }
  }

  /**
   * Split tasks into batches of maxWorkers size.
   */
  private batchTasks(tasks: TrackerTask[]): TrackerTask[][] {
    const batches: TrackerTask[][] = [];
    for (let i = 0; i < tasks.length; i += this.config.maxWorkers) {
      batches.push(tasks.slice(i, i + this.config.maxWorkers));
    }
    return batches;
  }

  /**
   * Clean up all resources.
   */
  private async cleanup(): Promise<void> {
    const branchesToPreserve = this.getBranchesToPreserveForRecovery();
    this.preservedRecoveryWorktrees = this.worktreeManager
      .getAllWorktrees()
      .filter((info) => branchesToPreserve.has(info.branch))
      .map((info) => ({ ...info }));
    try {
      const preserved = await this.worktreeManager.cleanupAll({
        preserveBranches: branchesToPreserve,
      });
      this.preservedRecoveryWorktrees = preserved.map((info) => ({ ...info }));
    } catch {
      // Best effort cleanup
    }

    try {
      this.mergeEngine.cleanupTags();
    } catch {
      // Best effort cleanup
    }

    // Return to original branch if a session branch was created.
    // This leaves the session branch with all merged changes, but the user
    // is back on their original branch ready for next steps.
    if (!this.config.directMerge) {
      try {
        this.mergeEngine.returnToOriginalBranch();
        this.returnToOriginalBranchError = null;
      } catch (error) {
        this.returnToOriginalBranchError = error instanceof Error
          ? error.message
          : String(error);
      }
    }
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.shouldStop) {
      await new Promise<void>((resolve) => {
        this.pauseWaiters.push(resolve);
      });
    }
  }

  private releasePauseWaiters(): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private enqueuePendingConflict(
    operation: MergeOperation,
    workerResult: WorkerResult
  ): void {
    if (this.pendingConflicts.some((entry) => entry.operation.id === operation.id)) {
      return;
    }
    this.pendingConflicts.push({ operation, workerResult });
  }

  private removePendingConflictByOperationId(operationId: string): void {
    this.pendingConflicts = this.pendingConflicts.filter(
      (entry) => entry.operation.id !== operationId
    );
  }

  private emitNextPendingConflictIfAny(): void {
    const next = this.pendingConflicts[0];
    if (!next) {
      return;
    }

    const conflictedFiles = next.operation.conflictedFiles ?? [];
    this.emitParallel({
      type: 'conflict:detected',
      timestamp: new Date().toISOString(),
      operationId: next.operation.id,
      taskId: next.workerResult.task.id,
      conflicts: conflictedFiles.map((filePath) => ({
        filePath,
        oursContent: '',
        theirsContent: '',
        baseContent: '',
        conflictMarkers: '',
      })),
    });
  }

  private enqueueRetryTasks(
    pendingTasks: TrackerTask[],
    retryTasks: TrackerTask[]
  ): void {
    if (retryTasks.length === 0) {
      return;
    }

    const existingTaskIds = new Set(pendingTasks.map((task) => task.id));
    for (const task of retryTasks) {
      if (existingTaskIds.has(task.id)) {
        continue;
      }
      pendingTasks.push(task);
      existingTaskIds.add(task.id);
    }
  }

  private markConflictOperationRolledBack(
    operationId: string,
    reason: string
  ): void {
    this.mergeEngine.markOperationRolledBack(operationId, reason);
  }

  /**
   * Determine which worker branches should be preserved for manual recovery.
   * Keep any branch that did not merge successfully and contains potentially
   * useful work (failed execution or unmerged commits).
   */
  private getBranchesToPreserveForRecovery(): Set<string> {
    const mergedBranches = new Set(
      this.mergeEngine
        .getQueue()
        .filter((operation) => operation.status === 'completed')
        .map((operation) => operation.sourceBranch)
    );

    const preserveBranches = new Set(
      this.mergeEngine
        .getQueue()
        .filter((operation) => operation.status !== 'completed')
        .map((operation) => operation.sourceBranch)
    );

    for (const result of this.completedResults) {
      if (mergedBranches.has(result.branchName)) {
        continue;
      }

      if (!result.success || result.commitCount > 0) {
        preserveBranches.add(result.branchName);
      }
    }

    return preserveBranches;
  }

  /**
   * Poll for new tasks in auto-poll mode.
   * Keeps checking for tasks until some are available or stop is requested.
   */
  private async pollForTasks(): Promise<void> {
    const POLL_INTERVAL_MS = 5000; // Check every 5 seconds

    while (!this.shouldStop) {
      await this.waitWhilePaused();
      if (this.shouldStop) break;

      const newTasks = await this.tracker.getTasks({
        status: ['open', 'in_progress'],
      });

      let filteredTasks = newTasks;
      if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
        const filteredIdSet = new Set(this.config.filteredTaskIds);
        filteredTasks = newTasks.filter((t) => filteredIdSet.has(t.id));
      }

      const actionableTasks = filteredTasks.filter((t) => t.type !== 'epic');
      if (actionableTasks.length > 0) {
        // Tasks available - return to start processing
        return;
      }

      // No tasks - wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * Merge a worker's progress.md into the main progress.md.
   * This allows learnings from completed tasks to be visible to subsequent workers.
   */
  private async mergeProgressFile(workerResult: WorkerResult): Promise<void> {
    if (!workerResult.worktreePath) return;

    const workerProgressPath = join(workerResult.worktreePath, '.ralph-tui', 'progress.md');
    const mainProgressPath = join(this.config.cwd, '.ralph-tui', 'progress.md');

    try {
      // Check if worker's progress file exists
      await access(workerProgressPath, constants.R_OK);

      // Read the worker's progress content
      const workerProgress = await readFile(workerProgressPath, 'utf-8');
      if (!workerProgress.trim()) return;

      // Append to main progress file with a separator
      const separator = `\n\n---\n\n## Parallel Task: ${workerResult.task.title} (${workerResult.task.id})\n\n`;
      await appendFile(mainProgressPath, separator + workerProgress);
    } catch {
      // Silently ignore if worker progress file doesn't exist or can't be read
    }
  }

  /**
   * Save tracker state files before a merge operation.
   * Returns a map of file paths to their contents for later restoration.
   *
   * This prevents git merge from overwriting tracker state (like task completion status)
   * with stale versions from worker worktrees.
   */
  private async saveTrackerState(): Promise<Map<string, string>> {
    const savedState = new Map<string, string>();

    if (typeof this.tracker.getStateFiles !== 'function') {
      return savedState;
    }

    const stateFiles = this.tracker.getStateFiles();
    for (const filePath of stateFiles) {
      try {
        const content = await readFile(filePath, 'utf-8');
        savedState.set(filePath, content);
      } catch {
        // File may not exist yet - that's fine
      }
    }

    return savedState;
  }

  /**
   * Restore tracker state files after a merge operation.
   * This ensures tracker state (task completion status) is not overwritten
   * by stale versions from worker worktrees during git merge.
   */
  private async restoreTrackerState(savedState: Map<string, string>): Promise<void> {
    for (const [filePath, content] of savedState) {
      try {
        await writeFile(filePath, content, 'utf-8');
        // Clear tracker's cache so it re-reads the restored content
        const tracker = this.tracker as unknown as { clearCache?: () => void };
        if (typeof tracker.clearCache === 'function') {
          tracker.clearCache();
        }
      } catch {
        // Best effort - log but don't fail
      }
    }
  }

  /**
   * Emit a parallel event to all listeners.
   */
  private emitParallel(event: ParallelEvent): void {
    for (const listener of this.parallelListeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the executor
      }
    }
  }
}

// Re-export key types and functions for convenient imports
export { analyzeTaskGraph, shouldRunParallel, recommendParallelism } from './task-graph.js';
export { WorktreeManager } from './worktree-manager.js';
export { MergeEngine } from './merge-engine.js';
export { ConflictResolver } from './conflict-resolver.js';
export { Worker } from './worker.js';
export type {
  ParallelExecutorConfig,
  ParallelExecutorState,
  ParallelExecutorStatus,
  TaskGraphAnalysis,
  ParallelGroup,
  WorkerResult,
  WorkerDisplayState,
  MergeResult,
  MergeOperation,
  FileConflict,
  ConflictResolutionResult,
  ParallelismRecommendation,
  ParallelismConfidence,
} from './types.js';
export type {
  ParallelEvent,
  ParallelEventType,
  ParallelEventListener,
} from './events.js';
