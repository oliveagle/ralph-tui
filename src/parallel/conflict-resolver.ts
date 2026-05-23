/**
 * ABOUTME: AI-assisted conflict resolution for parallel merge operations.
 * Extracts conflict data from git's merge state, sends it to an AI agent for
 * resolution, and applies the resolved content. Falls back to rollback on failure.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Validate that a string is a valid git ref name.
 * Based on git-check-ref-format rules.
 * @throws Error if the ref name is invalid
 */
function validateGitRef(ref: string, context: string): void {
  // Empty ref is invalid
  if (!ref || ref.trim() === '') {
    throw new Error(`Invalid git ref for ${context}: ref is empty`);
  }
  // Cannot contain spaces
  if (ref.includes(' ')) {
    throw new Error(`Invalid git ref for ${context}: contains spaces`);
  }
  // Cannot contain double dots
  if (ref.includes('..')) {
    throw new Error(`Invalid git ref for ${context}: contains '..'`);
  }
  // Cannot contain control characters
  if (/[\x00-\x1f\x7f]/.test(ref)) {
    throw new Error(`Invalid git ref for ${context}: contains control characters`);
  }
  // Cannot start with a dot
  if (ref.startsWith('.') || ref.includes('/.')) {
    throw new Error(`Invalid git ref for ${context}: starts with '.'`);
  }
  // Cannot end with a dot
  if (ref.endsWith('.')) {
    throw new Error(`Invalid git ref for ${context}: ends with '.'`);
  }
  // Cannot contain consecutive slashes
  if (ref.includes('//')) {
    throw new Error(`Invalid git ref for ${context}: contains consecutive slashes`);
  }
  // Cannot end with .lock
  if (ref.endsWith('.lock')) {
    throw new Error(`Invalid git ref for ${context}: ends with '.lock'`);
  }
  // Cannot contain certain characters
  if (/[~^:?*\[\\]/.test(ref)) {
    throw new Error(`Invalid git ref for ${context}: contains invalid characters (~, ^, :, ?, *, [, \\)`);
  }
  // Cannot contain @{ sequence (used for reflog)
  if (ref.includes('@{')) {
    throw new Error(`Invalid git ref for ${context}: contains '@{' sequence`);
  }
}
import type {
  FileConflict,
  ConflictResolutionResult,
  MergeOperation,
} from './types.js';
import type {
  ParallelEventListener,
  ParallelEvent,
} from './events.js';

/**
 * Callback type for AI resolution.
 * The parallel executor injects the actual AI agent call.
 * Receives the three-way merge context and returns the resolved content.
 */
export type AiResolverCallback = (
  conflict: FileConflict,
  taskContext: { taskId: string; taskTitle: string }
) => Promise<string | null>;

/**
 * Resolves merge conflicts using AI assistance with manual fallback.
 *
 * Resolution flow:
 * 1. Start the merge (do not abort — keep the conflicted index)
 * 2. For each conflicted file:
 *    a. Extract base/ours/theirs from git index stages
 *    b. Send to AI with task context
 *    c. Write resolved content and `git add`
 * 3. If all files resolved: `git commit` to complete the merge
 * 4. If any file fails: `git merge --abort` and rollback
 */
export class ConflictResolver {
  private readonly cwd: string;
  private aiResolver: AiResolverCallback | null = null;
  private readonly listeners: ParallelEventListener[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Set the AI resolver callback.
   * Called by the ParallelExecutor to inject the agent-backed resolver.
   */
  setAiResolver(resolver: AiResolverCallback): void {
    this.aiResolver = resolver;
  }

  /**
   * Register an event listener.
   */
  on(listener: ParallelEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Attempt to resolve conflicts for a merge operation.
   *
   * This method expects the merge to be in a conflicted state
   * (i.e., `git merge` was run but not aborted). It will:
   * 1. Extract conflict data from the index
   * 2. Attempt AI resolution for each file
   * 3. Complete the merge on success, or abort on failure
   *
   * @param operation - The merge operation with conflicts
   * @returns Array of resolution results (one per conflicted file)
   */
  async resolveConflicts(
    operation: MergeOperation
  ): Promise<ConflictResolutionResult[]> {
    const conflictedFiles = operation.conflictedFiles ?? [];
    if (conflictedFiles.length === 0) {
      return [];
    }

    const taskId = operation.workerResult.task.id;
    const taskTitle = operation.workerResult.task.title;
    const results: ConflictResolutionResult[] = [];

    // Check if merge is already in conflicted state
    const currentConflicts = this.getConflictedFiles();
    const alreadyConflicted = currentConflicts.length > 0;

    if (!alreadyConflicted) {
      // Merge was aborted or not in conflict state - try to restart merge
      validateGitRef(operation.sourceBranch, 'sourceBranch');
      try {
        this.git(['merge', '--no-commit', operation.sourceBranch]);
      } catch {
        // Failed to restart merge
        return conflictedFiles.map(filePath => ({
          filePath,
          success: false,
          method: 'auto' as const,
          error: 'Cannot restart merge - merge state is lost',
        }));
      }
    }

    // Emit conflict:detected so UI shows the correct conflict list for this task.
    // Phase 1 emits this too, but when multiple tasks conflict, only the last one's
    // conflicts are shown. Re-emitting here ensures Phase 2 shows the right files.
    const conflicts: FileConflict[] = conflictedFiles.map((filePath) => ({
      filePath,
      oursContent: '',
      theirsContent: '',
      baseContent: '',
      conflictMarkers: '',
    }));
    this.emit({
      type: 'conflict:detected',
      timestamp: new Date().toISOString(),
      operationId: operation.id,
      taskId,
      conflicts,
    });

    // Resolve each conflicted file
    for (const filePath of conflictedFiles) {
      const conflict = this.extractConflict(filePath);
      if (!conflict) {
        results.push({
          filePath,
          success: false,
          method: 'ai',
          error: 'Failed to extract conflict data',
        });
        continue;
      }

      const result = await this.resolveFile(
        conflict,
        operation.id,
        taskId,
        taskTitle
      );
      results.push(result);

      // If any file fails, abort the whole merge
      if (!result.success) {
        this.abortMerge(operation);
        return results;
      }
    }

    // All files resolved — complete the merge
    const allResolved = results.every((r) => r.success);
    if (allResolved) {
      try {
        // Use -m with the message as a separate argument to avoid shell injection
        this.git(['commit', '--no-edit', '-m', operation.commitMessage]);

        // Update operation status to completed (was 'conflicted')
        operation.status = 'completed';
        operation.completedAt = new Date().toISOString();

        this.emit({
          type: 'conflict:resolved',
          timestamp: new Date().toISOString(),
          operationId: operation.id,
          taskId,
          results,
        });
      } catch (err) {
        // Commit failed — abort
        this.abortMerge(operation);
        results.push({
          filePath: '<commit>',
          success: false,
          method: 'ai',
          error: `Failed to commit resolved merge: ${err}`,
        });
      }
    }

    return results;
  }

  /**
   * Get list of currently conflicted files from git status.
   */
  private getConflictedFiles(): string[] {
    try {
      const output = this.git(['status', '--porcelain']);
      const conflicted: string[] = [];

      for (const line of output.split('\n')) {
        const status = line.substring(0, 2);
        if (
          status === 'UU' ||
          status === 'AA' ||
          status === 'DD' ||
          status === 'AU' ||
          status === 'UA' ||
          status === 'DU' ||
          status === 'UD'
        ) {
          conflicted.push(line.substring(3).trim());
        }
      }

      return conflicted;
    } catch {
      return [];
    }
  }

  /**
   * Resolve a single conflicted file.
   * First tries auto-resolution for known file types, then falls back to AI.
   */
  private async resolveFile(
    conflict: FileConflict,
    operationId: string,
    taskId: string,
    taskTitle: string
  ): Promise<ConflictResolutionResult> {
    // Try auto-resolution for known structural conflicts
    const autoResolved = this.tryAutoResolve(conflict);
    if (autoResolved !== null) {
      const absPath = path.resolve(this.cwd, conflict.filePath);
      fs.writeFileSync(absPath, autoResolved, 'utf-8');
      this.git(['add', conflict.filePath]);

      return {
        filePath: conflict.filePath,
        success: true,
        method: 'auto',
        resolvedContent: autoResolved,
      };
    }

    // Try AI resolution if available
    if (this.aiResolver) {
      this.emit({
        type: 'conflict:ai-resolving',
        timestamp: new Date().toISOString(),
        operationId,
        taskId,
        filePath: conflict.filePath,
      });

      try {
        const resolved = await this.aiResolver(conflict, {
          taskId,
          taskTitle,
        });

        if (resolved !== null) {
          // Write resolved content
          const absPath = path.resolve(this.cwd, conflict.filePath);
          fs.writeFileSync(absPath, resolved, 'utf-8');
          this.git(['add', conflict.filePath]);

          const result: ConflictResolutionResult = {
            filePath: conflict.filePath,
            success: true,
            method: 'ai',
            resolvedContent: resolved,
          };

          this.emit({
            type: 'conflict:ai-resolved',
            timestamp: new Date().toISOString(),
            operationId,
            taskId,
            result,
          });

          return result;
        }
      } catch (err) {
        this.emit({
          type: 'conflict:ai-failed',
          timestamp: new Date().toISOString(),
          operationId,
          taskId,
          filePath: conflict.filePath,
          error: `${err}`,
        });
      }
    }

    // AI resolution failed or unavailable
    return {
      filePath: conflict.filePath,
      success: false,
      method: 'auto',
      error: 'Conflict could not be auto-resolved and AI resolution failed',
    };
  }

  /**
   * Try to auto-resolve common structural conflicts.
   * Returns resolved content if successful, null if unable to auto-resolve.
   */
  private tryAutoResolve(conflict: FileConflict): string | null {
    const filePath = conflict.filePath;

    // .beads/issues.jsonl: Merge all unique JSONL entries from both versions
    if (filePath.endsWith('.beads/issues.jsonl')) {
      return this.mergeJsonl(conflict.oursContent, conflict.theirsContent, conflict.baseContent);
    }

    // progress.md: Concatenate entries (avoiding duplicates)
    if (filePath.endsWith('progress.md')) {
      return this.mergeProgressMd(conflict.oursContent, conflict.theirsContent, conflict.baseContent);
    }

    // README.md: Merge sections if both added content
    if (filePath.endsWith('README.md') || filePath.endsWith('readme.md')) {
      return this.mergeReadme(conflict.oursContent, conflict.theirsContent, conflict.baseContent);
    }

    // Default: cannot auto-resolve
    return null;
  }

  /**
   * Merge JSONL files by combining unique entries from all three versions.
   * Each line is a complete JSON object - we can safely deduplicate by line content.
   */
  private mergeJsonl(ours: string, theirs: string, base: string): string {
    const entries = new Set<string>();

    // Add base entries first (for context)
    for (const line of base.trim().split('\n')) {
      if (line.trim()) entries.add(line);
    }

    // Add ours entries
    for (const line of ours.trim().split('\n')) {
      if (line.trim()) entries.add(line);
    }

    // Add theirs entries
    for (const line of theirs.trim().split('\n')) {
      if (line.trim()) entries.add(line);
    }

    return Array.from(entries).join('\n') + '\n';
  }

  /**
   * Merge progress.md by combining unique task entries.
   * Each entry starts with "## [Date]" - we can merge by keeping unique entries.
   */
  private mergeProgressMd(ours: string, theirs: string, base: string): string {
    const entries = new Map<string, string>(); // entry header -> full content

    // Helper to parse entries from content
    const parseEntries = (content: string) => {
      const entries: Map<string, string> = new Map();
      const lines = content.split('\n');
      let currentEntry: string[] = [];
      let currentHeader = '';

      for (const line of lines) {
        if (line.match(/^##\s+\d{4}-\d{2}-\d{2}/)) {
          // New entry
          if (currentHeader && currentEntry.length > 0) {
            entries.set(currentHeader, currentEntry.join('\n'));
          }
          currentHeader = line.trim();
          currentEntry = [line];
        } else if (currentHeader) {
          currentEntry.push(line);
        }
      }

      // Don't forget the last entry
      if (currentHeader && currentEntry.length > 0) {
        entries.set(currentHeader, currentEntry.join('\n'));
      }

      return entries;
    };

    // Merge entries from all three versions
    const baseEntries = parseEntries(base);
    const ourEntries = parseEntries(ours);
    const theirEntries = parseEntries(theirs);

    // Start with base, override with ours and theirs
    for (const [header, content] of baseEntries) {
      entries.set(header, content);
    }
    for (const [header, content] of ourEntries) {
      entries.set(header, content);
    }
    for (const [header, content] of theirEntries) {
      entries.set(header, content);
    }

    // Sort by date (header contains date) and join
    const sortedHeaders = Array.from(entries.keys()).sort();
    return sortedHeaders.map(h => entries.get(h)).join('\n\n') + '\n';
  }

  /**
   * Merge README by intelligently combining sections.
   * If both versions added sections, combine them. Prefer ours for conflicting sections.
   */
  private mergeReadme(ours: string, theirs: string, base: string): string {
    // If one side is empty or same as base, use the other
    if (ours === base || !ours.trim()) return theirs;
    if (theirs === base || !theirs.trim()) return ours;

    // Both have changes - use ours as primary (it's the session branch we're merging into)
    // This is a simple heuristic; for complex README conflicts, AI resolution is better
    return ours;
  }

  /**
   * Extract conflict data for a file from the git index.
   * Uses git's merge stages: :1: (base), :2: (ours), :3: (theirs)
   */
  private extractConflict(filePath: string): FileConflict | null {
    try {
      const baseContent = this.gitContent(`:1:${filePath}`);
      const oursContent = this.gitContent(`:2:${filePath}`);
      const theirsContent = this.gitContent(`:3:${filePath}`);

      // Read the file with conflict markers
      const absPath = path.resolve(this.cwd, filePath);
      const conflictMarkers = fs.existsSync(absPath)
        ? fs.readFileSync(absPath, 'utf-8')
        : '';

      return {
        filePath,
        oursContent,
        theirsContent,
        baseContent,
        conflictMarkers,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get file content from a git index stage.
   */
  private gitContent(ref: string): string {
    try {
      return this.git(['show', ref]);
    } catch {
      return '';
    }
  }

  /**
   * Abort the current merge and rollback.
   */
  private abortMerge(operation: MergeOperation): void {
    try {
      this.git(['merge', '--abort']);
    } catch {
      // Merge may not be in progress
    }

    // Rollback to backup tag
    try {
      validateGitRef(operation.backupTag, 'backupTag');
      this.git(['reset', '--hard', operation.backupTag]);
    } catch {
      // Best effort rollback
    }

    this.emit({
      type: 'merge:rolled-back',
      timestamp: new Date().toISOString(),
      operationId: operation.id,
      taskId: operation.workerResult.task.id,
      backupTag: operation.backupTag,
      reason: 'Conflict resolution failed',
    });
  }

  /**
   * Emit a parallel event to all listeners.
   */
  private emit(event: ParallelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the resolver
      }
    }
  }

  /**
   * Execute a git command in the main repository.
   * Uses execFileSync with argument array to prevent shell injection.
   * Pipes stdio so git output doesn't bleed through to the TUI.
   */
  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.cwd, ...args], {
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}
