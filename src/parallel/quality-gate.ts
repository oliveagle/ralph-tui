/**
 * ABOUTME: Quality gate validation for AI merge conflict resolution.
 * Runs project quality checks and provides feedback for AI self-correction.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface QualityGateResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export interface QualityGateOptions {
  cwd: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * Run quality gate validation on a file.
 *
 * The quality gate checks (in order):
 * 1. Project quality scripts (if exist in package.json or scripts/)
 * 2. Standard lint/typecheck commands
 * 3. Git hooks (if configured)
 *
 * @param filePath - Path to the file to validate
 * @param content - Content to write and validate
 * @param options - Quality gate options
 * @returns Validation result with errors/warnings
 */
export async function runQualityGate(
  filePath: string,
  content: string,
  options: QualityGateOptions
): Promise<QualityGateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Write content to temp file for validation
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ralph-qg-'));
  const tempFile = path.join(tempDir, path.basename(filePath));

  try {
    await fs.writeFile(tempFile, content, 'utf-8');

    // 1. Check for project quality scripts
    const scriptErrors = await runProjectQualityScripts(tempFile, options.cwd, options.timeoutMs);
    errors.push(...scriptErrors);

    // 2. Run standard checks based on file type
    const typeErrors = await runStandardChecks(tempFile, options.timeoutMs);
    errors.push(...typeErrors);

    // 3. Check for git hooks
    const hookErrors = await runGitHooks(tempFile, options.cwd, options.timeoutMs);
    if (hookErrors.length > 0) {
      errors.push(...hookErrors);
    }

    return {
      passed: errors.length === 0,
      errors,
      warnings,
    };
  } finally {
    // Cleanup temp file
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

/**
 * Run project-specific quality scripts.
 * Looks for scripts in package.json or scripts/ directory.
 */
async function runProjectQualityScripts(
  filePath: string,
  cwd: string,
  timeoutMs?: number
): Promise<string[]> {
  const errors: string[] = [];

  // Check package.json for quality scripts
  try {
    const packageJsonPath = path.join(cwd, 'package.json');
    if (fsSync.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8'));
      const scripts = packageJson.scripts || {};

      // Look for common quality script names
      const qualityScripts = [
        'quality',
        'check',
        'verify',
        'gate',
        'premerge',
        'test:merge',
      ];

      for (const scriptName of qualityScripts) {
        if (scripts[scriptName]) {
          try {
            execFileSync('sh', ['-c', `cd "${cwd}" && bun run ${scriptName}`], {
              encoding: 'utf-8',
              timeout: timeoutMs ?? 60000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch (err) {
            const stderr = (err as Error).message || '';
            errors.push(`Quality script '${scriptName}' failed: ${stderr}`);
          }
        }
      }
    }
  } catch {
    // Best effort - continue with other checks
  }

  // Check for scripts/ directory
  const scriptsDir = path.join(cwd, 'scripts');
  if (fsSync.existsSync(scriptsDir) && fsSync.statSync(scriptsDir).isDirectory()) {
    const files = fsSync.readdirSync(scriptsDir);
    for (const file of files) {
      if (file.startsWith('quality') || file.startsWith('gate') || file.startsWith('check')) {
        const scriptPath = path.join(scriptsDir, file);
        if (fsSync.statSync(scriptPath).isFile()) {
          try {
            execFileSync('sh', [scriptPath, filePath], {
              encoding: 'utf-8',
              timeout: timeoutMs ?? 60000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch (err) {
            const stderr = (err as Error).message || '';
            errors.push(`Script '${file}' failed: ${stderr}`);
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Run standard quality checks based on file type.
 */
async function runStandardChecks(
  filePath: string,
  timeoutMs?: number
): Promise<string[]> {
  const ext = path.extname(filePath).toLowerCase();
  const errors: string[] = [];

  switch (ext) {
    case '.ts':
    case '.tsx': {
      // TypeScript: run tsc --noEmit
      try {
        execFileSync('bun', ['run', 'typecheck'], {
          cwd: path.dirname(filePath),
          encoding: 'utf-8',
          timeout: timeoutMs ?? 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        errors.push(`TypeScript check failed: ${(err as Error).message}`);
      }
      break;
    }

    case '.js':
    case '.jsx':
    case '.mjs': {
      // JavaScript: run eslint on the file
      try {
        execFileSync('bun', ['run', 'lint', '--', filePath], {
          cwd: path.dirname(filePath),
          encoding: 'utf-8',
          timeout: timeoutMs ?? 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        errors.push(`ESLint check failed: ${(err as Error).message}`);
      }
      break;
    }

    case '.py': {
      // Python: run py_compile
      try {
        execFileSync('python3', ['-m', 'py_compile', filePath], {
          encoding: 'utf-8',
          timeout: timeoutMs ?? 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        errors.push(`Python syntax check failed: ${(err as Error).message}`);
      }
      break;
    }

    case '.json': {
      // JSON: validate syntax
      try {
        JSON.parse(await fs.readFile(filePath, 'utf-8'));
      } catch (err) {
        errors.push(`JSON syntax error: ${(err as Error).message}`);
      }
      break;
    }

    case '.yaml':
    case '.yml': {
      // YAML: basic structure check
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.includes('\t')) {
        errors.push('YAML should not use tabs (use spaces instead)');
      }
      break;
    }
  }

  return errors;
}

/**
 * Run git hooks (pre-commit, pre-merge-commit, etc.) if configured.
 */
async function runGitHooks(
  _filePath: string,
  cwd: string,
  timeoutMs?: number
): Promise<string[]> {
  const errors: string[] = [];

  // Check for .git/hooks/pre-commit
  const hookPath = path.join(cwd, '.git', 'hooks', 'pre-commit');
  if (fsSync.existsSync(hookPath) && fsSync.statSync(hookPath).isFile()) {
    try {
      execFileSync(hookPath, [], {
        cwd,
        encoding: 'utf-8',
        timeout: timeoutMs ?? 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      errors.push(`pre-commit hook failed: ${(err as Error).message}`);
    }
  }

  // Check for pre-merge-commit hook
  const preMergeHook = path.join(cwd, '.git', 'hooks', 'pre-merge-commit');
  if (fsSync.existsSync(preMergeHook) && fsSync.statSync(preMergeHook).isFile()) {
    try {
      execFileSync(preMergeHook, [], {
        cwd,
        encoding: 'utf-8',
        timeout: timeoutMs ?? 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      errors.push(`pre-merge-commit hook failed: ${(err as Error).message}`);
    }
  }

  return errors;
}
