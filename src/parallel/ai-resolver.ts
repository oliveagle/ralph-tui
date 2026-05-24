/**
 * ABOUTME: AI-powered conflict resolution using the session's configured agent.
 * Provides fast-path heuristics for trivial cases and LLM-based resolution for complex ones.
 * Works on any node (local or remote) as long as the agent CLI is available.
 */

import { getAgentRegistry } from '../plugins/agents/registry.js';
import type { RalphConfig } from '../config/types.js';
import type { FileConflict } from './types.js';
import type { AiResolverCallback } from './conflict-resolver.js';

/** Default timeout for AI resolution per file (2 minutes) */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Merge content from two versions by combining unique lines.
 * Used when parallel workers created/modified a file independently.
 * Preserves line order from 'ours' first, then adds unique lines from 'theirs'.
 */
function mergeContentLines(ours: string, theirs: string): string {
  const seen = new Set<string>();
  const result: string[] = [];

  const addUniqueLines = (content: string) => {
    for (const line of content.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed === '' || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(line);
    }
  };

  addUniqueLines(ours);
  addUniqueLines(theirs);

  const combined = result.join('\n');
  const hasTrailingNewline = ours.endsWith('\n') || theirs.endsWith('\n');
  return hasTrailingNewline && combined !== '' ? combined + '\n' : combined;
}

/**
 * Creates an AI resolver callback that spawns the session's configured agent.
 * The callback is injected into ConflictResolver via ParallelExecutor.setAiResolver().
 *
 * @param config - The session's RalphConfig containing agent configuration
 * @returns AiResolverCallback for use with ConflictResolver
 */
export function createAiResolver(config: RalphConfig): AiResolverCallback {
  const timeout = config.conflictResolution?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (conflict, taskContext) => {
    // Fast-path: Check for trivial cases before spawning agent
    const fastResult = tryFastPathResolution(conflict);
    if (fastResult !== null) {
      return fastResult;
    }

    // Spawn agent for complex resolution
    try {
      const agentRegistry = getAgentRegistry();
      const agent = await agentRegistry.getInstance(config.agent);

      const prompt = buildConflictPrompt(conflict, taskContext);

      const handle = agent.execute(prompt, [], {
        cwd: config.cwd,
        timeout,
      });

      const result = await handle.promise;

      if (result.status !== 'completed' || result.exitCode !== 0) {
        return null;
      }

      return extractResolvedContent(result.stdout);
    } catch {
      // Agent execution failed - return null to signal failure
      return null;
    }
  };
}

/**
 * Fast-path resolution for trivial conflict cases.
 * Avoids spawning an agent for cases that can be resolved deterministically.
 *
 * @param conflict - The file conflict to analyze
 * @returns Resolved content if trivial case detected, null if AI is needed
 */
export function tryFastPathResolution(conflict: FileConflict): string | null {
  const baseEmpty = conflict.baseContent.trim() === '';
  const oursEmpty = conflict.oursContent.trim() === '';
  const theirsEmpty = conflict.theirsContent.trim() === '';

  // One side is empty → take the non-empty side
  if (oursEmpty && !theirsEmpty) {
    return conflict.theirsContent;
  }
  if (!oursEmpty && theirsEmpty) {
    return conflict.oursContent;
  }

  // Both sides identical → either works
  if (conflict.oursContent === conflict.theirsContent) {
    return conflict.oursContent;
  }

  // Base is empty and both sides have content → merge all unique lines
  // This handles parallel workers independently creating/modifying a file
  if (baseEmpty && !oursEmpty && !theirsEmpty) {
    return mergeContentLines(conflict.oursContent, conflict.theirsContent);
  }

  // For all other cases, let AI handle it with improved instructions
  return null;
}

/**
 * Build the prompt for AI conflict resolution.
 * Includes task context so AI understands the purpose of the worker's changes.
 *
 * @param conflict - The file conflict with all three versions
 * @param ctx - Task context (what the worker was implementing)
 * @returns Formatted prompt string
 */
export function buildConflictPrompt(
  conflict: FileConflict,
  ctx: { taskId: string; taskTitle: string }
): string {
  return `You are resolving a git merge conflict. Output ONLY the resolved file content.

## Context
File: ${conflict.filePath}
Task: ${ctx.taskTitle} (${ctx.taskId})

## Base Version (common ancestor)
\`\`\`
${conflict.baseContent || '(file did not exist)'}
\`\`\`

## Main Branch (ours)
\`\`\`
${conflict.oursContent}
\`\`\`

## Worker Branch (theirs - implementing the task)
\`\`\`
${conflict.theirsContent}
\`\`\`

## Instructions
1. CRITICAL: COMBINE ALL CONTENT from both branches - they represent parallel work that should be merged together
2. The worker was implementing "${ctx.taskTitle}" - preserve their functional changes
3. Keep main branch updates (formatting, unrelated fixes) where possible
4. For file creation/modification: merge ALL unique content from both sides
5. When both sides modified the same lines: apply intelligent judgment based on semantic meaning
6. NEVER discard content from one side in favor of the other unless they are truly mutually exclusive

OUTPUT ONLY THE RESOLVED FILE CONTENT. No explanation, no markdown code fences.`;
}

/**
 * Extract the resolved file content from agent output.
 * Strips markdown fences if the agent included them despite instructions.
 *
 * @param stdout - Raw stdout from the agent execution
 * @returns Extracted content or null if empty
 */
export function extractResolvedContent(stdout: string): string | null {
  let content = stdout.trim();

  // Strip markdown code fences if present (agent might add them despite instructions)
  const fenceMatch = content.match(/^```[\w]*\n([\s\S]*)\n```$/);
  if (fenceMatch) {
    content = fenceMatch[1] ?? content;
  }

  // Validate we got something
  if (content.length === 0) {
    return null;
  }

  return content;
}
