/**
 * ABOUTME: Branch pool manager for parallel execution without worktrees.
 * Creates and tracks git branches for workers operating directly
 * in the main repository directory.
 *
 * Design: Instead of creating git worktrees (separate working directories),
 * workers operate in the main directory by switching branches sequentially.
 * This eliminates disk I/O overhead of worktree creation and the complexity
 * of managing separate working directories.
 *
 * Workers run one at a time — each switches to its branch, does its work,
 * commits, then switches back. This preserves the task graph analysis
 * (knowing which tasks CAN run in parallel) while simplifying execution.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { WorktreeInfo, WorktreeManagerConfig } from './types.js';

export interface CleanupAllOptions {
  preserveBranches?: ReadonlySet<string>;
}

function sanitizeBranchName(taskId: string): string {
  let sanitized = taskId;
  sanitized = sanitized.replace(/[\s~^:?*\[\\@{]/g, '-');
  sanitized = sanitized.replace(/\p{Cc}/gu, '');
  sanitized = sanitized.replace(/\/+/g, '/').replace(/-+/g, '-');
  sanitized = sanitized.replace(/\.{2,}/g, '.');
  sanitized = sanitized.replace(/^[./-]+|[./-]+$/g, '');
  if (sanitized.endsWith('.lock')) {
    sanitized = sanitized.slice(0, -5);
  }
  if (!sanitized) {
    sanitized = Buffer.from(taskId).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'task';
  }
  return sanitized;
}

function sanitizeBranchSegment(value: string): string {
  return sanitizeBranchName(value).replace(/\/+/g, '-') || 'segment';
}

const DEFAULT_MIN_FREE_DISK_SPACE = 500 * 1024 * 1024;

export class WorktreeManager {
  private readonly config: WorktreeManagerConfig;
  private readonly worktrees = new Map<string, WorktreeInfo>();
  private originalBranch: string | null = null;

  constructor(config: Partial<WorktreeManagerConfig> & { cwd: string }) {
    this.config = {
      worktreeDir: config.worktreeDir ?? '.ralph-tui/branches',
      cwd: config.cwd,
      maxWorktrees: config.maxWorktrees ?? 8,
      minFreeDiskSpace: config.minFreeDiskSpace ?? DEFAULT_MIN_FREE_DISK_SPACE,
    };
  }

  getOriginalBranch(): string {
    if (!this.originalBranch) {
      this.originalBranch = this.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    }
    return this.originalBranch;
  }

  /**
   * Acquire a branch for a worker. Creates the branch from HEAD
   * but does NOT switch to it — the Worker handles branch switching.
   */
  async acquire(
    workerId: string,
    taskId: string,
    branchParts?: { sessionId?: string; scopeId?: string }
  ): Promise<WorktreeInfo> {
    const activeCount = this.getActiveWorktreeCount();
    if (activeCount >= this.config.maxWorktrees) {
      throw new Error(
        `Maximum concurrent workers reached (${this.config.maxWorktrees}). ` +
          'Wait for existing workers to complete before starting new ones.'
      );
    }

    await this.checkDiskSpace();

    const worktreeId = `worker-${workerId}`;
    const sanitizedTaskId = branchParts ? sanitizeBranchSegment(taskId) : sanitizeBranchName(taskId);
    const branchSegments = [
      'ralph-parallel',
      branchParts?.sessionId ? sanitizeBranchSegment(branchParts.sessionId) : undefined,
      branchParts?.scopeId ? sanitizeBranchSegment(branchParts.scopeId) : undefined,
      sanitizedTaskId,
    ].filter((segment): segment is string => Boolean(segment));
    const branchName = branchSegments.join('/');

    this.getOriginalBranch();

    await this.cleanupStaleBranch(branchName);

    this.git(['branch', branchName]);

    const info: WorktreeInfo = {
      id: worktreeId,
      path: this.config.cwd,
      branch: branchName,
      workerId,
      taskId,
      active: true,
      dirty: false,
      createdAt: new Date().toISOString(),
    };

    this.worktrees.set(worktreeId, info);
    console.log(`[branch-pool] Acquired branch '${branchName}' for worker ${workerId} (task: ${taskId})`);
    return info;
  }

  release(worktreeId: string): void {
    const info = this.worktrees.get(worktreeId);
    if (info) {
      info.active = false;
      info.workerId = undefined;
    }
  }

  isDirty(worktreeId: string): boolean {
    const info = this.worktrees.get(worktreeId);
    if (!info) return false;
    try {
      const status = this.git(['status', '--porcelain']);
      const dirty = status.trim().length > 0;
      info.dirty = dirty;
      return dirty;
    } catch {
      return false;
    }
  }

  getWorktree(worktreeId: string): WorktreeInfo | undefined {
    return this.worktrees.get(worktreeId);
  }

  getAllWorktrees(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  private getActiveWorktreeCount(): number {
    let count = 0;
    for (const info of this.worktrees.values()) {
      if (info.active) count++;
    }
    return count;
  }

  getCommitCount(worktreeId: string): number {
    const info = this.worktrees.get(worktreeId);
    if (!info) return 0;
    try {
      const log = this.git(['log', '--oneline', info.branch, '--not', 'HEAD']);
      return log.trim().split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  async cleanupAll(options?: CleanupAllOptions): Promise<WorktreeInfo[]> {
    const errors: string[] = [];
    const preserved: WorktreeInfo[] = [];
    const preserveBranches = options?.preserveBranches ?? new Set<string>();

    for (const [id, info] of this.worktrees.entries()) {
      if (preserveBranches.has(info.branch)) {
        preserved.push(info);
        continue;
      }
      try {
        await this.removeBranch(info.branch);
      } catch (err) {
        errors.push(`Failed to clean up ${id}: ${err}`);
      }
    }

    this.worktrees.clear();

    if (errors.length > 0) {
      throw new Error(`Branch cleanup had ${errors.length} error(s):\n${errors.join('\n')}`);
    }
    return preserved;
  }

  async cleanupByBranch(branchName: string): Promise<boolean> {
    let foundWorktreeId: string | null = null;
    for (const [id, info] of this.worktrees.entries()) {
      if (info.branch === branchName) {
        foundWorktreeId = id;
        break;
      }
    }
    if (!foundWorktreeId) return false;

    try {
      await this.removeBranch(branchName);
    } catch {
      // Best effort
    }

    this.worktrees.delete(foundWorktreeId);
    return true;
  }

  private async removeBranch(branchName: string): Promise<void> {
    try {
      this.git(['branch', '-D', branchName]);
      console.log(`[branch-pool] Deleted branch '${branchName}'`);
    } catch {
      // Branch may already be deleted
    }
  }

  private async cleanupStaleBranch(branchName: string): Promise<void> {
    try {
      this.git(['rev-parse', '--verify', `refs/heads/${branchName}`]);
      try {
        this.git(['branch', '-D', branchName]);
      } catch {
        // Best effort
      }
    } catch {
      // Branch doesn't exist
    }
  }

  private async checkDiskSpace(): Promise<void> {
    try {
      let available = await this.getAvailableDiskSpaceFromStatFs();
      if (available === null || available <= 0) {
        available = this.getAvailableDiskSpaceFromDf();
      }
      if (available === null) return;

      if (available < this.config.minFreeDiskSpace) {
        const availMB = Math.round(available / (1024 * 1024));
        const reqMB = Math.round(this.config.minFreeDiskSpace / (1024 * 1024));
        throw new Error(`Insufficient disk space for branch operations: ${availMB}MB available, ${reqMB}MB required`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Insufficient disk space')) {
        throw err;
      }
    }
  }

  private async getAvailableDiskSpaceFromStatFs(): Promise<number | null> {
    try {
      const stats = await fs.promises.statfs(this.config.cwd);
      const available = Number(stats.bavail) * Number(stats.bsize);
      return Number.isFinite(available) ? available : null;
    } catch {
      return null;
    }
  }

  private getAvailableDiskSpaceFromDf(): number | null {
    try {
      const output = execFileSync('df', ['-k', this.config.cwd], { encoding: 'utf-8' });
      return this.parseDfAvailableBytes(output);
    } catch {
      return null;
    }
  }

  private parseDfAvailableBytes(output: string): number | null {
    const lines = output.trim().split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) return null;

    const header = lines[0]?.toLowerCase();
    if (!header) return null;

    const normalizedHeader = header.trim().split(/\s+/).map((v) => v.replace('%', '').trim());
    const availIndex = normalizedHeader.findIndex((h) => h === 'avail' || h === 'available');
    if (availIndex < 0) return null;

    const dataLine = lines.at(-1);
    if (!dataLine) return null;

    const values = dataLine.trim().split(/\s+/);
    if (values.length <= availIndex) return null;

    const availableKb = Number.parseInt(values[availIndex] ?? '', 10);
    if (Number.isNaN(availableKb) || !Number.isFinite(availableKb) || availableKb < 0) return null;

    return availableKb * 1024;
  }

  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.config.cwd, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}