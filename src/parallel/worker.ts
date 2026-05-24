/**
 * ABOUTME: Single parallel worker that wraps an ExecutionEngine for one branch.
 * Each worker operates in the main directory by switching to its assigned branch.
 * The tracker is managed centrally by the ParallelExecutor to prevent concurrent
 * writes to the beads database.
 *
 * Design change: Workers no longer use separate worktrees. Instead, they:
 * 1. Switch to their assigned branch (created by WorktreeManager)
 * 2. Run the execution engine in the main directory
 * 3. Commit changes to their branch
 * 4. Switch back to the original branch on completion
 *
 * This simplifies execution by eliminating worktree management overhead.
 */

import { execFileSync } from 'node:child_process';
import { ExecutionEngine, type WorkerModeOptions } from '../engine/index.js';
import type { EngineEvent, EngineEventListener } from '../engine/types.js';
import type { RalphConfig } from '../config/types.js';
import type { TrackerPlugin, TrackerTask } from '../plugins/trackers/types.js';
import { mkdir, writeFile } from 'node:fs/promises';
import type {
  WorkerConfig,
  WorkerResult,
  WorkerStatus,
  WorkerDisplayState,
} from './types.js';
import type {
  ParallelEventListener,
  ParallelEvent,
} from './events.js';

/**
 * A parallel worker that executes a single task on its assigned branch.
 *
 * Design:
 * - Wraps an ExecutionEngine with a modified config pointing to the main directory
 * - Does NOT use the tracker to pick tasks — the task is pre-assigned
 * - Forwards all engine events with a workerId prefix so the executor can route them
 * - Switches to its branch before starting, switches back after completion
 */
export class Worker {
  readonly id: string;
  readonly config: WorkerConfig;

  private engine: ExecutionEngine | null = null;
  private status: WorkerStatus = 'idle';
  private startTime = 0;
  private currentIteration = 0;
  private maxIterations: number;
  private lastOutput = '';
  private lastCommitSha?: string;
  private commitCount = 0;
  private readonly listeners: ParallelEventListener[] = [];
  private readonly engineListeners: EngineEventListener[] = [];
  private originalBranch: string | null = null;
  private readonly cwd: string;

  constructor(config: WorkerConfig, maxIterations: number) {
    this.id = config.id;
    this.config = config;
    this.maxIterations = maxIterations;
    this.cwd = config.cwd;
  }

  /**
   * Register a parallel event listener.
   */
  on(listener: ParallelEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Register an engine event listener for raw engine events.
   */
  onEngineEvent(listener: EngineEventListener): () => void {
    this.engineListeners.push(listener);
    return () => {
      const idx = this.engineListeners.indexOf(listener);
      if (idx >= 0) this.engineListeners.splice(idx, 1);
    };
  }

  /**
   * Create and initialize the execution engine for this worker.
   * Must be called before start().
   *
   * @param baseConfig - The base RalphConfig to modify
   * @param tracker - Pre-initialized tracker plugin from the parent executor
   */
  async initialize(baseConfig: RalphConfig, tracker: TrackerPlugin): Promise<void> {
    // Save current branch before switching
    this.originalBranch = this.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    // In no-worktree mode, skip branch switching entirely — work on current branch
    if (!this.config.noWorktree) {
      // Switch to the worker's assigned branch
      this.git(['checkout', this.config.branchName]);
      console.log(`[worker] ${this.id} switched to branch '${this.config.branchName}'`);
    } else {
      console.log(`[worker] ${this.id} running in no-worktree mode on branch '${this.originalBranch}'`);
    }

    // Ensure .ralph-tui directory exists
    const ralphDir = `${this.cwd}/.ralph-tui`;
    await mkdir(ralphDir, { recursive: true });
    const progressFilePath = `${ralphDir}/progress.md`;
    try {
      await writeFile(progressFilePath, '', 'utf-8');
    } catch {
      // File may already exist
    }

    // Create a worker-specific config pointing to the main directory
    const workerConfig: RalphConfig = {
      ...baseConfig,
      cwd: this.cwd,
      maxIterations: this.maxIterations,
      outputDir: `${this.cwd}/.ralph-tui/iterations`,
      progressFile: progressFilePath,
      sessionId: `${baseConfig.sessionId ?? 'session'}-${this.id}`,
      autoCommit: true,
    };

    this.engine = new ExecutionEngine(workerConfig);

    this.engine.on((event: EngineEvent) => {
      this.handleEngineEvent(event);
    });

    const workerMode: WorkerModeOptions = {
      tracker,
      forcedTask: this.config.task,
    };
    await this.engine.initialize(workerMode);

    this.emitParallel({
      type: 'worker:created',
      timestamp: new Date().toISOString(),
      workerId: this.id,
      task: this.config.task,
      worktreePath: this.cwd,
      branchName: this.config.branchName,
    });
  }

  /**
   * Start the worker's execution engine.
   * Returns when the engine stops (task completed, max iterations, or error).
   */
  async start(): Promise<WorkerResult> {
    if (!this.engine) {
      throw new Error(`Worker ${this.id} not initialized. Call initialize() first.`);
    }

    this.status = 'running';
    this.startTime = Date.now();
    this.commitCount = 0;
    this.lastCommitSha = undefined;

    this.emitParallel({
      type: 'worker:started',
      timestamp: new Date().toISOString(),
      workerId: this.id,
      task: this.config.task,
    });

    try {
      await this.engine.start();

      if (this.getStatus() === 'cancelled') {
        await this.switchBackToOriginalBranch();
        const result: WorkerResult = {
          workerId: this.id,
          task: this.config.task,
          success: false,
          iterationsRun: this.currentIteration,
          taskCompleted: false,
          durationMs: Date.now() - this.startTime,
          error: 'Worker was cancelled',
          branchName: this.config.branchName,
          commitCount: this.commitCount,
          worktreePath: this.cwd,
        };

        this.emitParallel({
          type: 'worker:failed',
          timestamp: new Date().toISOString(),
          workerId: this.id,
          task: this.config.task,
          error: 'Worker was cancelled',
        });

        return result;
      }

      const engineState = this.engine.getState();
      const taskCompleted = engineState.tasksCompleted > 0;

      this.status = 'completed';

      const result: WorkerResult = {
        workerId: this.id,
        task: this.config.task,
        success: true,
        iterationsRun: engineState.currentIteration,
        taskCompleted,
        durationMs: Date.now() - this.startTime,
        branchName: this.config.branchName,
        commitCount: this.commitCount,
        worktreePath: this.cwd,
      };

      this.emitParallel({
        type: 'worker:completed',
        timestamp: new Date().toISOString(),
        workerId: this.id,
        result,
      });

      return result;
    } catch (err) {
      this.status = 'failed';
      const error = err instanceof Error ? err.message : String(err);

      const result: WorkerResult = {
        workerId: this.id,
        task: this.config.task,
        success: false,
        iterationsRun: this.currentIteration,
        taskCompleted: false,
        durationMs: Date.now() - this.startTime,
        error,
        branchName: this.config.branchName,
        commitCount: this.commitCount,
        worktreePath: this.cwd,
      };

      this.emitParallel({
        type: 'worker:failed',
        timestamp: new Date().toISOString(),
        workerId: this.id,
        task: this.config.task,
        error,
      });

      return result;
    } finally {
      // Always switch back to original branch
      await this.switchBackToOriginalBranch();
    }
  }

  /**
   * Stop the worker's execution engine.
   */
  async stop(): Promise<void> {
    this.status = 'cancelled';
    if (this.engine) {
      await this.engine.stop();
    }
  }

  /**
   * Pause the worker's execution engine after the current iteration completes.
   */
  pause(): void {
    this.engine?.pause();
  }

  /**
   * Resume the worker's execution engine from paused state.
   */
  resume(): void {
    this.engine?.resume();
  }

  /**
   * Get the current display state for TUI rendering.
   */
  getDisplayState(): WorkerDisplayState {
    return {
      id: this.id,
      status: this.status,
      task: this.config.task,
      currentIteration: this.currentIteration,
      maxIterations: this.maxIterations,
      lastOutput: this.lastOutput,
      elapsedMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      worktreePath: this.cwd,
      branchName: this.config.branchName,
      commitSha: this.lastCommitSha,
    };
  }

  /**
   * Get the current worker status.
   */
  getStatus(): WorkerStatus {
    return this.status;
  }

  /**
   * Get the task assigned to this worker.
   */
  getTask(): TrackerTask {
    return this.config.task;
  }

  /**
   * Handle engine events: update internal state and forward to listeners.
   */
  private handleEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'iteration:started':
        this.currentIteration = event.iteration;
        this.emitParallel({
          type: 'worker:progress',
          timestamp: event.timestamp,
          workerId: this.id,
          task: this.config.task,
          currentIteration: event.iteration,
          maxIterations: this.maxIterations,
        });
        break;

      case 'agent:output':
        if (event.stream === 'stdout' && event.data.trim()) {
          this.lastOutput = event.data.trim().slice(-200);
        }
        this.emitParallel({
          type: 'worker:output',
          timestamp: event.timestamp,
          workerId: this.id,
          stream: event.stream,
          data: event.data,
        });
        break;

      case 'task:auto-committed':
        this.commitCount++;
        if (event.commitSha) {
          this.lastCommitSha = event.commitSha;
        }
        break;
    }

    for (const listener of this.engineListeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the worker
      }
    }
  }

  /**
   * Switch back to the original branch after worker completion.
   */
  private async switchBackToOriginalBranch(): Promise<void> {
    // In no-worktree mode, we never switched branches, so skip switching back
    if (this.config.noWorktree) {
      return;
    }
    if (this.originalBranch) {
      try {
        this.git(['checkout', this.originalBranch]);
        console.log(`[worker] ${this.id} switched back to branch '${this.originalBranch}'`);
      } catch (err) {
        console.error(`[worker] ${this.id} failed to switch back to original branch:`, err);
      }
    }
  }

  /**
   * Emit a parallel event to all listeners.
   */
  private emitParallel(event: ParallelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the worker
      }
    }
  }

  /**
   * Execute a git command in the repository.
   */
  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.cwd, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}