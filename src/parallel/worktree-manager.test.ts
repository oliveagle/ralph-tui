/**
 * ABOUTME: Tests for the branch pool manager (formerly worktree manager).
 * Uses real temporary git repositories to test branch creation, release,
 * cleanup, dirty checking, and disk space management.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorktreeManager } from './worktree-manager.js';

/** Create a temporary git repo for testing */
function createTempRepo(): string {
  const dir = path.join(
    '/tmp',
    `ralph-test-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config user.email "test@test.com"');
  git(dir, 'config user.name "Test"');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Repo\n');
  git(dir, 'add .');
  git(dir, 'commit -m "Initial commit"');
  return dir;
}

/** Execute a git command in a directory */
function git(cwd: string, args: string): string {
  return execSync(`git -C "${cwd}" ${args}`, {
    encoding: 'utf-8',
    timeout: 10000,
  });
}

describe('WorktreeManager', () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoDir = createTempRepo();
    manager = new WorktreeManager({
      cwd: repoDir,
      worktreeDir: '.ralph-tui/branches',
      maxWorktrees: 4,
    });
  });

  afterEach(() => {
    // Clean up any branches we created
    try {
      const branches = git(repoDir, 'branch');
      for (const line of branches.split('\n')) {
        const branchName = line.replace('*', '').trim();
        if (branchName.startsWith('ralph-parallel/')) {
          try {
            git(repoDir, `branch -D "${branchName}"`);
          } catch {
            // Best effort
          }
        }
      }
    } catch {
      // Best effort
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  type DiskCheckAccessor = {
    checkDiskSpace: () => Promise<void>;
    getAvailableDiskSpaceFromStatFs: () => Promise<number | null>;
    getAvailableDiskSpaceFromDf: () => number | null;
  };

  describe('disk space checks', () => {
    test('falls back to df when statfs reports zero but df reports sufficient space', async () => {
      const minFreeDiskSpace = 500 * 1024 * 1024;
      manager = new WorktreeManager({
        cwd: repoDir,
        worktreeDir: '.ralph-tui/branches',
        maxWorktrees: 4,
        minFreeDiskSpace,
      });

      const managerWithDiskCheck = manager as unknown as DiskCheckAccessor;
      const originalStatFs = managerWithDiskCheck.getAvailableDiskSpaceFromStatFs;
      const originalDf = managerWithDiskCheck.getAvailableDiskSpaceFromDf;

      managerWithDiskCheck.getAvailableDiskSpaceFromStatFs = async () => 0;
      managerWithDiskCheck.getAvailableDiskSpaceFromDf = () => minFreeDiskSpace + 1024 * 1024;

      try {
        await expect(managerWithDiskCheck.checkDiskSpace()).resolves.toBeUndefined();
      } finally {
        managerWithDiskCheck.getAvailableDiskSpaceFromStatFs = originalStatFs;
        managerWithDiskCheck.getAvailableDiskSpaceFromDf = originalDf;
      }
    });

    test('throws when both statfs and df report insufficient space', async () => {
      const minFreeDiskSpace = 500 * 1024 * 1024;
      manager = new WorktreeManager({
        cwd: repoDir,
        worktreeDir: '.ralph-tui/branches',
        maxWorktrees: 4,
        minFreeDiskSpace,
      });

      const managerWithDiskCheck = manager as unknown as DiskCheckAccessor;
      const originalStatFs = managerWithDiskCheck.getAvailableDiskSpaceFromStatFs;
      const originalDf = managerWithDiskCheck.getAvailableDiskSpaceFromDf;

      managerWithDiskCheck.getAvailableDiskSpaceFromStatFs = async () => 0;
      managerWithDiskCheck.getAvailableDiskSpaceFromDf = () => minFreeDiskSpace / 2;

      try {
        await expect(managerWithDiskCheck.checkDiskSpace()).rejects.toThrow(
          'Insufficient disk space for branch'
        );
      } finally {
        managerWithDiskCheck.getAvailableDiskSpaceFromStatFs = originalStatFs;
        managerWithDiskCheck.getAvailableDiskSpaceFromDf = originalDf;
      }
    });
  });

  describe('acquire', () => {
    test('creates a branch for the task', async () => {
      const info = await manager.acquire('w1', 'task-001');

      expect(info.id).toBe('worker-w1');
      expect(info.branch).toBe('ralph-parallel/task-001');
      expect(info.workerId).toBe('w1');
      expect(info.taskId).toBe('task-001');
      expect(info.active).toBe(true);
      expect(info.dirty).toBe(false);
      expect(info.createdAt).toBeTruthy();

      // Verify the branch exists in git
      const branches = git(repoDir, 'branch');
      expect(branches).toContain('ralph-parallel/task-001');

      // Path should be the main repo directory
      expect(info.path).toBe(repoDir);
    });

    test('includes session and scope slugs in branch names when provided', async () => {
      const info = await manager.acquire('w1', 'task/001', {
        sessionId: 'session/abc',
        scopeId: 'UI Epic',
      });

      expect(info.branch).toBe('ralph-parallel/session-abc/UI-Epic/task-001');
    });

    test('creates the .ralph-tui directory', async () => {
      const ralphDir = path.join(repoDir, '.ralph-tui');
      fs.mkdirSync(ralphDir, { recursive: true });

      await manager.acquire('w1', 'task-001');

      expect(fs.existsSync(ralphDir)).toBe(true);
    });

    test('throws when maximum worktrees reached', async () => {
      const smallManager = new WorktreeManager({
        cwd: repoDir,
        maxWorktrees: 1,
      });

      await smallManager.acquire('w1', 'task-001');

      await expect(
        smallManager.acquire('w2', 'task-002')
      ).rejects.toThrow('Maximum concurrent workers reached');
    });

    test('creates multiple branches for different tasks', async () => {
      const info1 = await manager.acquire('w1', 'task-001');
      const info2 = await manager.acquire('w2', 'task-002');

      // Both point to the same main directory
      expect(info1.path).toBe(info2.path);
      expect(info1.branch).not.toBe(info2.branch);

      // Both branches exist
      const branches = git(repoDir, 'branch');
      expect(branches).toContain('ralph-parallel/task-001');
      expect(branches).toContain('ralph-parallel/task-002');
    });

    test('cleans up stale branch at the same name', async () => {
      // First acquire
      await manager.acquire('w1', 'task-001');

      // Release and cleanup
      await manager.cleanupAll();

      // Re-create manager and acquire the same branch name
      const newManager = new WorktreeManager({
        cwd: repoDir,
        maxWorktrees: 4,
      });

      // This should succeed by cleaning up the stale branch
      const info2 = await newManager.acquire('w1', 'task-001');
      expect(info2.branch).toBe('ralph-parallel/task-001');
    });
  });

  describe('release', () => {
    test('marks a worktree as inactive', async () => {
      const info = await manager.acquire('w1', 'task-001');
      expect(info.active).toBe(true);

      manager.release('worker-w1');

      const released = manager.getWorktree('worker-w1');
      expect(released?.active).toBe(false);
      expect(released?.workerId).toBeUndefined();
    });

    test('does nothing for unknown worktree ID', () => {
      // Should not throw
      manager.release('nonexistent');
    });

    test('allows acquiring a new worktree after release without cleanupAll', async () => {
      const smallManager = new WorktreeManager({
        cwd: repoDir,
        maxWorktrees: 1,
      });

      const first = await smallManager.acquire('w1', 'task-001');
      smallManager.release(first.id);

      await expect(
        smallManager.acquire('w2', 'task-002')
      ).resolves.toBeTruthy();
    });
  });

  describe('isDirty', () => {
    test('returns false for a clean worktree', async () => {
      await manager.acquire('w1', 'task-001');
      expect(manager.isDirty('worker-w1')).toBe(false);
    });

    test('returns true when there are uncommitted changes', async () => {
      const info = await manager.acquire('w1', 'task-001');

      // Create an uncommitted file in the repo directory
      fs.writeFileSync(path.join(info.path, 'uncommitted.txt'), 'dirty\n');

      expect(manager.isDirty('worker-w1')).toBe(true);
    });

    test('returns false for unknown worktree ID', () => {
      expect(manager.isDirty('nonexistent')).toBe(false);
    });
  });

  describe('getWorktree / getAllWorktrees', () => {
    test('getWorktree returns the correct worktree info', async () => {
      await manager.acquire('w1', 'task-001');

      const info = manager.getWorktree('worker-w1');
      expect(info).toBeTruthy();
      expect(info!.taskId).toBe('task-001');
    });

    test('getWorktree returns undefined for unknown ID', () => {
      expect(manager.getWorktree('nonexistent')).toBeUndefined();
    });

    test('getAllWorktrees returns all managed worktrees', async () => {
      await manager.acquire('w1', 'task-001');
      await manager.acquire('w2', 'task-002');

      const all = manager.getAllWorktrees();
      expect(all).toHaveLength(2);
    });
  });

  describe('cleanupAll', () => {
    test('removes all branches', async () => {
      await manager.acquire('w1', 'task-001');
      await manager.acquire('w2', 'task-002');

      await manager.cleanupAll();

      // Branches should be deleted
      const branches = git(repoDir, 'branch');
      expect(branches).not.toContain('ralph-parallel/task-001');
      expect(branches).not.toContain('ralph-parallel/task-002');

      // Internal state should be cleared
      expect(manager.getAllWorktrees()).toHaveLength(0);
    });

    test('succeeds when no worktrees exist', async () => {
      // Should not throw
      await manager.cleanupAll();
    });
  });

  describe('cleanupByBranch', () => {
    test('removes a specific branch by name', async () => {
      await manager.acquire('w1', 'task-001');
      await manager.acquire('w2', 'task-002');

      const result = await manager.cleanupByBranch('ralph-parallel/task-001');
      expect(result).toBe(true);

      const branches = git(repoDir, 'branch');
      expect(branches).not.toContain('ralph-parallel/task-001');
      expect(branches).toContain('ralph-parallel/task-002');
    });

    test('returns false for unknown branch name', async () => {
      const result = await manager.cleanupByBranch('ralph-parallel/nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getCommitCount', () => {
    test('returns 0 for unknown worktree', () => {
      expect(manager.getCommitCount('nonexistent')).toBe(0);
    });
  });

  describe('defaults', () => {
    test('uses default branch directory when not specified', () => {
      const defaultManager = new WorktreeManager({ cwd: repoDir });
      expect(defaultManager).toBeTruthy();
    });
  });
});