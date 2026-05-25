/**
 * ABOUTME: ParallelExecutor — top-level coordinator for parallel task execution.
 * Analyzes task dependencies, groups independent tasks, executes them in parallel
 * git branches in the main directory, and merges results back sequentially with conflict resolution.
 *
 * Design: Workers operate in the main directory by switching to their assigned branches.
 * Each worker creates a branch, does its work, commits to it, switches back, then gets merged.
 * This eliminates worktree overhead while preserving the task graph analysis and merge workflow.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { RalphConfig } from '../config/types.js';
import type { TrackerPlugin, TrackerTask } from '../plugins/trackers/types.js';
import { ExecutionEngine, type WorkerModeOptions } from '../engine/index.js';
import type { EngineEventListener } from '../engine/types.js';
import { analyzeTaskGraph, shouldRunParallel } from './task-graph.js';
import { checkTaskHealth, applyHealthFixes } from './task-health-checker.js';
import { WorktreeManager } from './worktree-manager.js';
import { MergeEngine } from './merge-engine.js';
import { ConflictResolver, type AiResolverCallback } from './conflict-resolver.js';
import { Worker } from './worker.js';
import { DeadlockResolver } from './deadlock-resolver.js';
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
  noWorktree: false,
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
  private readonly deadlockResolver: DeadlockResolver;

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
    this.deadlockResolver = new DeadlockResolver(
      {
        cwd: this.config.cwd,
        sessionId: this.sessionId,
        worktreeDir: this.config.worktreeDir,
      },
      tracker,
      baseConfig
    );

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

      // Check task health for deadlocks and orphaned tasks
      const healthCheck = checkTaskHealth(tasks, {
        autoFixDeadlocks: true,
        autoFixOrphaned: true,
      });

      if (healthCheck.issues.length > 0) {
        console.log(`[parallel] Health check found ${healthCheck.issues.length} issue(s): ${healthCheck.summary}`);
        this.emitParallel({
          type: 'parallel:health-check',
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          healthCheck,
        });

        // Apply auto-fixes: reset deadlocked tasks to 'open' for task graph analysis
        const allResetTaskIds = [...healthCheck.fixedTaskIds, ...healthCheck.cascadedResetTaskIds];
        if (allResetTaskIds.length > 0) {
          console.log(`[parallel] Resetting ${allResetTaskIds.length} deadlocked/blocked task(s) to open: ${allResetTaskIds.join(', ')}`);
          tasks = applyHealthFixes(tasks, healthCheck);

          // Persist the status fixes to the tracker (both fixed and cascaded tasks)
          for (const taskId of allResetTaskIds) {
            try {
              await this.tracker.updateTaskStatus(taskId, 'open');
              console.log(`[parallel] Successfully reset task ${taskId} to 'open'`);
            } catch (err) {
              console.error(`[parallel] Failed to reset task ${taskId} to open:`, err);
            }
          }
        }
      }

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
      console.log(`[parallel] Task graph analysis: ${this.taskGraph.groups.length} group(s), ${this.taskGraph.actionableTaskCount} actionable task(s), cyclic=${this.taskGraph.cyclicTaskIds.length}`);

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

      // noWorktree mode: tasks run directly in the main directory.
      // Don't call executeSequential here - instead, let the normal group-based
      // flow run. executeGroup() will call executeGroupNoWorktree() which
      // supports parallel batches based on maxWorkers.

      // Initialize session branch unless directMerge is enabled.
      // The session branch holds all worker merges, keeping the original branch clean.
      // Skip session branch creation in no-worktree mode (changes go directly to current branch).
      if (!this.config.directMerge && !this.config.noWorktree) {
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

        // Health check before each group to catch new deadlocks
        await this.runHealthCheckAndFix();

        this.currentGroupIndex = i;
        const group = this.taskGraph.groups[i];

        await this.executeGroup(group, i);
      }

      // Continuous mode: after completing all initial tasks, keep fetching and processing new tasks.
      // Workers are continuously restarted to pick up newly available tasks.
      while (!this.shouldStop) {
        await this.waitWhilePaused();
        if (this.shouldStop) break;

        // Health check at the start of each continuous iteration
        await this.runHealthCheckAndFix();

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

          // Health check before each group to catch new deadlocks
          await this.runHealthCheckAndFix();

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
   * Execute tasks sequentially in the main directory (no-worktree mode).
   * Each task runs with a git checkpoint for rollback on failure.
   */
  private async executeSequential(tasks: TrackerTask[]): Promise<void> {
    console.log(`[parallel] Starting no-worktree sequential execution: ${tasks.length} task(s)`);

    this.emitParallel({
      type: 'parallel:started',
      timestamp: this.startedAt!,
      sessionId: this.sessionId,
      analysis: this.taskGraph!,
      totalGroups: this.taskGraph?.groups.length ?? 1,
      totalTasks: this.taskGraph?.actionableTaskCount ?? tasks.length,
      maxWorkers: 1,
    });

    // Sort tasks by topological order to respect dependencies
    const sortedTasks = this.taskGraph
      ? this.taskGraph.groups.flatMap(g => g.tasks)
      : tasks;

    for (const task of sortedTasks) {
      if (this.shouldStop) break;
      await this.waitWhilePaused();
      if (this.shouldStop) break;

      this.status = 'executing';
      this.emitParallel({
        type: 'worker:started',
        timestamp: new Date().toISOString(),
        workerId: 'sequential',
        task,
      });

      // Create git checkpoint before task
      const checkpointTag = `ralph-checkpoint-${this.sessionId}-${Date.now()}`;
      const checkpointSha = this.createGitCheckpoint(checkpointTag);

      try {
        // Run the task using ExecutionEngine directly in main directory
        const taskConfig: RalphConfig = {
          ...this.baseConfig,
          maxIterations: this.config.maxIterationsPerWorker,
          sessionId: `${this.baseConfig.sessionId ?? 'session'}-sequential`,
          autoCommit: true, // Required for sequential mode
        };

        const engine = new ExecutionEngine(taskConfig);

        // Forward engine events with worker context
        engine.on((event) => {
          // Map engine events to parallel worker events
          switch (event.type) {
            case 'engine:started':
              this.emitParallel({
                type: 'worker:started',
                timestamp: event.timestamp,
                workerId: 'sequential',
                task,
              });
              break;
            case 'task:auto-committed':
            case 'task:auto-commit-failed':
            case 'task:auto-commit-skipped':
              // Forward as unknown - these match parallel event shape
              this.emitParallel(event as unknown as ParallelEvent);
              break;
            case 'engine:stopped': {
              const stopEvent = event;
              this.emitParallel({
                type: 'worker:completed',
                timestamp: stopEvent.timestamp,
                workerId: 'sequential',
                result: {
                  workerId: 'sequential',
                  task,
                  success: stopEvent.reason === 'completed',
                  iterationsRun: stopEvent.totalIterations,
                  taskCompleted: stopEvent.tasksCompleted > 0,
                  durationMs: 0,
                  branchName: '',
                  commitCount: 0,
                },
              });
              break;
            }
            default:
              // Ignore other engine events
              break;
          }
        });

        // Initialize in worker mode with forced task
        const workerMode: WorkerModeOptions = {
          tracker: this.tracker,
          forcedTask: task,
        };
        await engine.initialize(workerMode);

        // Run the engine
        await engine.start();

        const engineState = engine.getState();
        const taskCompleted = engineState.tasksCompleted > 0;

        if (taskCompleted) {
          this.totalTasksCompleted++;
          console.log(`[parallel] Task ${task.id} completed successfully`);
          this.emitParallel({
            type: 'worker:completed',
            timestamp: new Date().toISOString(),
            workerId: 'sequential',
            result: {
              workerId: 'sequential',
              task,
              success: true,
              iterationsRun: engineState.currentIteration,
              taskCompleted: true,
              durationMs: Date.now() - Date.parse(this.startedAt!),
              branchName: '',
              commitCount: 0,
            },
          });
        } else {
          throw new Error('Task did not complete within iteration limit');
        }
      } catch (err) {
        this.totalTasksFailed++;
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[parallel] Task ${task.id} failed: ${error}`);

        // Rollback to checkpoint
        this.rollbackGitCheckpoint(checkpointSha);

        // Reset task to open for retry
        try {
          await this.tracker.updateTaskStatus(task.id, 'open');
        } catch {
          // Ignore
        }

        this.emitParallel({
          type: 'worker:failed',
          timestamp: new Date().toISOString(),
          workerId: 'sequential',
          task,
          error,
        });
      }

      // Cleanup checkpoint tag
      try {
        execFileSync('git', ['tag', '-d', checkpointTag], { cwd: this.config.cwd });
      } catch {
        // Ignore
      }
    }

    this.status = 'completed';
    this.emitParallel({
      type: 'parallel:completed',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      totalTasksCompleted: this.totalTasksCompleted,
      totalTasksFailed: this.totalTasksFailed,
      totalMergesCompleted: 0,
      totalConflictsResolved: 0,
      durationMs: Date.now() - Date.parse(this.startedAt!),
    });
  }

  /**
   * Create a git checkpoint by tagging the current HEAD.
   */
  private createGitCheckpoint(tagName: string): string {
    try {
      execFileSync('git', ['tag', tagName, '-m', `Ralph checkpoint for rollback`], {
        cwd: this.config.cwd,
        stdio: 'pipe',
      });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.config.cwd, stdio: 'pipe' }).toString().trim();
      console.log(`[parallel] Created checkpoint ${tagName} at ${sha}`);
      return sha;
    } catch (err) {
      console.error(`[parallel] Failed to create checkpoint: ${err}`);
      throw new Error(`Failed to create git checkpoint: ${err}`);
    }
  }

  /**
   * Rollback to a checkpoint by resetting hard to the tagged commit.
   */
  private rollbackGitCheckpoint(checkpointSha: string): void {
    try {
      execFileSync('git', ['reset', '--hard', checkpointSha], {
        cwd: this.config.cwd,
        stdio: 'pipe',
      });
      console.log(`[parallel] Rolled back to checkpoint ${checkpointSha}`);
    } catch (err) {
      console.error(`[parallel] Failed to rollback to checkpoint: ${err}`);
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
    // Case: task was completed by the agent but no git commits were created
    // (e.g., output files are in .gitignore). The agent already closed the task,
    // so we should complete it in the tracker and skip the merge entirely.
    if (workerResult.taskCompleted && workerResult.commitCount === 0) {
      console.log(`[parallel] Task ${workerResult.task.id} completed by agent but no commits to merge — completing task in tracker only`);
      try {
        await this.tracker.completeTask(workerResult.task.id);
      } catch {
        // Task may already be completed — best effort
      }
      // Merge worker's progress.md into main so learnings are shared
      await this.mergeProgressFile(workerResult);
      // Cleanup worktree
      await this.worktreeManager.cleanupByBranch(workerResult.branchName);
      return { success: true, hadConflicts: false };
    }

    // Check if merge should be attempted
    const shouldMerge = workerResult.success && workerResult.commitCount > 0;

    if (!shouldMerge) {
      const skipReason = !workerResult.success
        ? `worker failed: ${workerResult.error ?? 'unknown error'}`
        : 'no commits made';

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
      // Only reset task to open if the worker didn't complete it successfully.
      // If taskCompleted=true, the worker already called br close and we shouldn't reopen it.
      if (!workerResult.taskCompleted) {
        // Reset task to open so it can be retried in the next session
        await this.resetTaskToOpen(workerResult.task.id);
      }
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
    console.log(`[parallel] executeGroup: group ${groupIndex}, ${group.tasks.length} task(s), depth ${group.depth}`);
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

    // In no-worktree mode, skip merge logic entirely — tasks commit directly to current branch
    if (this.config.noWorktree) {
      await this.executeGroupNoWorktree(group, groupIndex, totalGroups);
      return;
    }

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
          // But only reset if the worker didn't complete it (taskCompleted=true means agent already closed it).
          groupTasksFailed++;
          this.totalTasksFailed++;
          if (!result.taskCompleted) {
            await this.resetTaskToOpen(result.task.id);
          }
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
          // Only reset the task if the worker didn't complete it. If taskCompleted=true,
          // the agent already did the work and we shouldn't undo the completion.
          if (result.taskCompleted) {
            // Worker completed but merge failed — still count as done (work is preserved)
            groupTasksCompleted++;
            this.totalTasksCompleted++;
          } else {
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
            // Only reset if the worker didn't complete it
            if (!workerResult.taskCompleted) {
              await this.resetTaskToOpen(workerResult.task.id);
            }
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
   * Execute a group in no-worktree mode: tasks run in parallel on current branch
   * with worker-specific output directories to prevent conflicts.
   */
  private async executeGroupNoWorktree(
    group: { index: number; tasks: TrackerTask[]; depth: number },
    groupIndex: number,
    totalGroups: number
  ): Promise<void> {
    console.log(`[parallel] executeGroupNoWorktree: group ${groupIndex}, ${group.tasks.length} task(s), ${this.config.maxWorkers} workers max`);
    let groupTasksCompleted = 0;
    let groupTasksFailed = 0;

    const pendingTasks = [...group.tasks];

    // Process tasks in batches, allowing failed tasks to be re-queued
    while (pendingTasks.length > 0) {
      if (this.shouldStop) break;
      await this.waitWhilePaused();
      if (this.shouldStop) break;

      // Determine batch size (up to maxWorkers)
      const batchSize = Math.min(pendingTasks.length, this.config.maxWorkers);
      const batch = pendingTasks.splice(0, batchSize);
      const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.config.cwd,
        encoding: 'utf-8',
      }).trim();

      // Create workers for this batch
      const workers: Array<{ worker: Worker; task: TrackerTask; checkpointName: string; checkpointCreated: boolean }> = [];

      for (const task of batch) {
        const workerId = `w-parallel-${groupIndex}-${task.id}`;

        // Try to mark task as in_progress
        const updatedTask = await this.tracker.updateTaskStatus(task.id, 'in_progress');
        if (!updatedTask) {
          console.log(`[parallel] Task ${task.id} blocked in no-worktree mode, resetting to open`);
          try {
            await this.tracker.updateTaskStatus(task.id, 'open');
          } catch (err) {
            console.error(`[parallel] Failed to reset blocked task ${task.id} to open:`, err);
          }
          groupTasksFailed++;
          this.totalTasksFailed++;
          // Re-queue blocked task
          pendingTasks.push(task);
          continue;
        }

        // Create git checkpoint before running the task
        const checkpointName = `ralph-checkpoint/${this.sessionId}-${task.id}`;
        const checkpointCreated = this.createCheckpoint(checkpointName);

        // Create a no-worktree worker that runs on current branch
        const worker = new Worker(
          {
            id: workerId,
            task,
            worktreePath: this.config.cwd,
            branchName: currentBranch,
            cwd: this.config.cwd,
            noWorktree: true,
          },
          this.config.maxIterationsPerWorker
        );

        // Immediately set status to 'running' so TUI doesn't see idle status
        (worker as any).status = 'running';

        // Forward events
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

        workers.push({ worker, task, checkpointName, checkpointCreated });
      }

      // Set activeWorkers to all workers in this batch
      this.activeWorkers = workers.map((w) => w.worker);

      // Run all workers in parallel
      const results = await Promise.allSettled(
        workers.map(async ({ worker, task, checkpointName, checkpointCreated }) => {
          try {
            await worker.initialize(this.baseConfig, this.tracker);
            const result = await worker.start();

            if (result.success && result.taskCompleted) {
              console.log(`[parallel] no-worktree: task ${task.id} completed successfully`);
              return { task, result, success: true, checkpointCreated, checkpointName };
            } else {
              console.log(`[parallel] no-worktree: task ${task.id} failed (${result.error ?? 'not completed'}), rolling back`);
              // Rollback to checkpoint
              if (checkpointCreated) {
                this.rollbackToCheckpoint(checkpointName);
              }
              return { task, result, success: false, checkpointCreated, checkpointName, shouldRequeue: true };
            }
          } catch (err) {
            console.error(`[parallel] no-worktree: worker ${worker.id} crashed:`, err);
            // Rollback to checkpoint
            if (checkpointCreated) {
              this.rollbackToCheckpoint(checkpointName);
            }
            return { task, result: null as any, success: false, checkpointCreated, checkpointName, shouldRequeue: true };
          }
        })
      );

      // Process results
      for (const settled of results) {
        if (settled.status === 'fulfilled') {
          const { task, result, success, checkpointName, shouldRequeue: shouldRequeueValue } = settled.value;
          if (success) {
            groupTasksCompleted++;
            this.totalTasksCompleted++;
            this.requeueCounts.delete(task.id);
          } else {
            groupTasksFailed++;
            this.totalTasksFailed++;
            // Re-queue task based on retry budget
            const actualShouldRequeue = shouldRequeueValue ?? !result?.taskCompleted;
            if (actualShouldRequeue) {
              const requeued = await this.handleNoWorktreeTaskFailure(task);
              if (requeued) {
                pendingTasks.push(task);
              }
            }
          }
          // Cleanup checkpoint tag
          try {
            this.git(['tag', '-d', checkpointName]);
          } catch {
            // Ignore
          }
        } else {
          // Promise rejected - shouldn't happen with Promise.allSettled but handle it
          groupTasksFailed++;
          this.totalTasksFailed++;
        }
      }

      // Clear activeWorkers after batch completes
      this.activeWorkers = [];
    }

    this.emitParallel({
      type: 'parallel:group-completed',
      timestamp: new Date().toISOString(),
      groupIndex,
      totalGroups,
      tasksCompleted: groupTasksCompleted,
      tasksFailed: groupTasksFailed,
      mergesCompleted: 0,
      mergesFailed: 0,
    });
  }

  /**
   * Create a git checkpoint tag for rollback purposes.
   */
  private createCheckpoint(name: string): boolean {
    try {
      this.git(['tag', '-f', name]);
      console.log(`[parallel] Checkpoint created: ${name}`);
      return true;
    } catch (err) {
      console.error(`[parallel] Failed to create checkpoint ${name}:`, err);
      return false;
    }
  }

  /**
   * Rollback to a git checkpoint tag.
   */
  private rollbackToCheckpoint(name: string): void {
    try {
      this.git(['reset', '--hard', name]);
      this.git(['clean', '-fd']);
      console.log(`[parallel] Rolled back to checkpoint: ${name}`);
    } catch (err) {
      console.error(`[parallel] Failed to rollback to checkpoint ${name}:`, err);
    }
  }

  /**
   * Handle task failure in no-worktree mode by tracking retries.
   */
  private async handleNoWorktreeTaskFailure(task: TrackerTask): Promise<boolean> {
    const taskId = task.id;
    const currentCount = this.requeueCounts.get(taskId) ?? 0;
    const shouldRequeue = currentCount < this.config.maxRequeueCount;

    if (shouldRequeue) {
      this.requeueCounts.set(taskId, currentCount + 1);
      console.log(`[parallel] no-worktree: task ${taskId} requeued (attempt ${currentCount + 1}/${this.config.maxRequeueCount})`);
      try {
        await this.tracker.updateTaskStatus(taskId, 'open');
      } catch {
        // Log but don't fail
      }
    } else {
      console.log(`[parallel] no-worktree: task ${taskId} permanently failed after ${currentCount + 1} attempts`);
    }

    return shouldRequeue;
  }

  /**
   * Execute a batch of tasks sequentially using workers.
   * Workers run one at a time since they all operate in the main directory
   * by switching branches. This preserves the task graph analysis while
   * simplifying execution.
   */
  private async executeBatch(tasks: TrackerTask[]): Promise<WorkerResult[]> {
    console.log(`[parallel] executeBatch: starting with ${tasks.length} task(s), sequential execution`);
    this.activeWorkers = [];
    const workerResults: WorkerResult[] = [];

    // Track tasks that failed to be claimed (blocked by dependencies)
    const blockedTasks: TrackerTask[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const workerId = `w${this.currentGroupIndex}-${i}`;

      // Acquire branch from worktree manager
      const executionScope = (task as { executionScope?: { id: string } }).executionScope;
      const worktreeInfo = await this.worktreeManager.acquire(
        workerId,
        task.id,
        {
          sessionId: this.sessionId,
          scopeId: executionScope?.id,
        }
      );

      // Try to mark task as in_progress. For beads-rust, this triggers claim validation.
      const updatedTask = await this.tracker.updateTaskStatus(task.id, 'in_progress');
      if (!updatedTask) {
        // Task is blocked by dependencies — release and skip
        this.worktreeManager.release(`worker-${workerId}`);
        blockedTasks.push(task);
        try {
          await this.tracker.updateTaskStatus(task.id, 'open');
        } catch (err) {
          console.error(`[parallel] Failed to reset blocked task ${task.id} to open:`, err);
        }
        continue;
      }

      // Create worker
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

      // Immediately set status to 'running' so TUI doesn't see idle status
      // This is necessary because we add to activeWorkers before calling initialize()
      (worker as any).status = 'running';

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

      this.activeWorkers = [worker];

      try {
        // Initialize and start the worker (runs in its branch)
        await worker.initialize(this.baseConfig, this.tracker);
        const result = await worker.start();
        workerResults.push(result);
      } catch (err) {
        // Worker threw an exception - create failure result
        const rawError = err instanceof Error ? err.message : String(err);
        workerResults.push({
          workerId,
          task,
          success: false,
          iterationsRun: 0,
          taskCompleted: false,
          durationMs: 0,
          error: `Worker ${workerId} crashed: ${rawError}`,
          branchName: worktreeInfo.branch,
          commitCount: 0,
        });
      } finally {
        // Release the branch (worker already switched back in start())
        this.worktreeManager.release(`worker-${workerId}`);
        this.activeWorkers = [];
      }
    }

    // Add blocked task results at the end
    for (const task of blockedTasks) {
      workerResults.push({
        workerId: '',
        task,
        success: false,
        iterationsRun: 0,
        taskCompleted: false,
        durationMs: 0,
        error: `Task '${task.id}' is blocked by unresolved dependencies — complete dependency tasks first`,
        branchName: '',
        commitCount: 0,
      });
    }

    this.completedResults.push(...workerResults);
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
        result.taskCompleted
          ? 'Conflict resolution failed but task was already completed by agent'
          : 'Conflict resolution failed; task reset to open'
      );
    }

    await this.mergeProgressFile(result);

    // Only reset task status if the worker didn't complete it.
    // If taskCompleted=true, the agent already closed the task via br close,
    // and resetting it would undo the completion.
    if (!result.taskCompleted) {
      await this.resetTaskToOpen(taskId);
    }
    return shouldRequeue;
  }

  /**
   * Best-effort reset of a task status to open.
   * Prevents tasks from remaining stuck in in_progress after cancellation/failure.
   * Also cascades the reset to any in_progress tasks that depend on this task.
   */
  private async resetTaskToOpen(taskId: string): Promise<void> {
    try {
      await this.tracker.updateTaskStatus(taskId, 'open');

      // Cascading reset: find and reset all in_progress tasks that depend on this task
      const tasks = await this.tracker.getTasks({
        status: ['in_progress'],
      });

      for (const task of tasks) {
        // Check if this task depends on the reset task
        let dependsOnResetTask = false;

        if (task.dependsOn?.includes(taskId)) {
          dependsOnResetTask = true;
        }

        // Check blocks relationship
        if (!dependsOnResetTask) {
          const resetTask = await this.tracker.getTask(taskId);
          if (resetTask?.blocks?.includes(task.id)) {
            dependsOnResetTask = true;
          }
        }

        if (dependsOnResetTask) {
          try {
            await this.tracker.updateTaskStatus(task.id, 'open');
            console.log(`[parallel] Cascaded reset: task ${task.id} depends on reset task ${taskId}`);
          } catch (err) {
            console.error(`[parallel] Failed to cascade reset task ${task.id}:`, err);
          }
        }
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Split tasks into batches of maxWorkers size.
   */
  private batchTasks(tasks: TrackerTask[]): TrackerTask[][] {
    console.log(`[parallel] batchTasks: ${tasks.length} task(s) to batch, maxWorkers=${this.config.maxWorkers}`);
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
   * Since workers operate in the main directory, this merges the progress.md
   * at the time the worker completes (it's the same file we just read).
   */
  private async mergeProgressFile(_workerResult: WorkerResult): Promise<void> {
    // Workers operate in the main directory - the progress.md was already written there
    // during execution. No need to merge from a separate worktree.
    // The progress is already captured by the worker's execution in real-time.
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

  /**
   * Run health check on all tasks and auto-fix any deadlocks or orphaned tasks.
   * Called before each group execution and at the start of continuous mode loops.
   *
   * Uses AI DeadlockResolver to diagnose and fix stuck tasks, rather than
   * blindly resetting task state. The AI agent analyzes git state, worktree
   * status, and dependency chains to determine the correct recovery action.
   */
  private async runHealthCheckAndFix(): Promise<void> {
    try {
      const tasks = await this.tracker.getTasks({
        status: ['open', 'in_progress'],
      });

      // Apply task ID filter if configured
      let filteredTasks = tasks;
      if (this.config.filteredTaskIds && this.config.filteredTaskIds.length > 0) {
        const filteredIdSet = new Set(this.config.filteredTaskIds);
        filteredTasks = tasks.filter((t) => filteredIdSet.has(t.id));
      }

      // Skip epics
      filteredTasks = filteredTasks.filter((t) => t.type !== 'epic');

      // Run health check (detection only — no auto-fix)
      const healthCheck = checkTaskHealth(filteredTasks, {
        autoFixDeadlocks: false, // Let AI resolver handle fixes
        autoFixOrphaned: false,
      });

      if (healthCheck.issues.length > 0) {
        this.emitParallel({
          type: 'parallel:health-check',
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
          healthCheck,
        });

        // Use AI resolver to diagnose and fix each deadlocked task
        for (const issue of healthCheck.issues) {
          if (issue.severity === 'error' || issue.severity === 'warning') {
            console.log(`[parallel] AI deadlock resolution: ${issue.taskId} (${issue.message})`);

            const stuckTask = filteredTasks.find((t) => t.id === issue.taskId);
            if (!stuckTask) continue;

            const diagnostic = await this.deadlockResolver.diagnose(stuckTask);
            const resolution = await this.deadlockResolver.resolve(diagnostic);

            console.log(`[parallel] Deadlock resolved: ${resolution.message}`);

            // Execute the AI's decision
            if (resolution.actionTaken.type === 'reset_to_open' && resolution.taskReset) {
              // Task was already reset by DeadlockResolver, but we need to persist it
              console.log(`[parallel] Task ${stuckTask.id} reset to open per AI decision`);
            } else if (resolution.actionTaken.type === 'continue' && !resolution.taskReset) {
              // AI says to continue - task is already in_progress, just log
              console.log(`[parallel] Task ${stuckTask.id} continuing execution per AI decision`);
            } else if (resolution.actionTaken.type === 'merge_and_close') {
              // AI says to merge and close - this means the task is actually complete
              try {
                await this.tracker.completeTask(stuckTask.id, `AI-resolved: ${resolution.actionTaken.reason}`);
                console.log(`[parallel] Task ${stuckTask.id} closed per AI decision`);
              } catch (err) {
                console.error(`[parallel] Failed to close task ${stuckTask.id}:`, err);
              }
            }

            this.emitParallel({
              type: 'parallel:deadlock-resolved',
              timestamp: new Date().toISOString(),
              sessionId: this.sessionId,
              taskId: stuckTask.id,
              action: resolution.actionTaken,
              taskReset: resolution.taskReset,
              worktreePreserved: resolution.worktreePreserved,
              message: resolution.message,
            });
          }
        }
      }
    } catch (err) {
      console.error('[parallel] Health check failed:', err);
      // Don't fail the whole execution due to health check issues
    }
  }

  /**
   * Run a git command in the executor's working directory.
   */
  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.config.cwd, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
