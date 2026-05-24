/**
 * ABOUTME: Raloop auto-restart daemon wrapper.
 * Delegates to the Go raloop binary for reliable process-level restart.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Execute the raloop daemon via Go binary.
 * Parses CLI args and passes them through to the compiled Go binary.
 */
export async function executeRaloopCommand(args: string[]): Promise<void> {
  const binary = findRaloopBinary();

  try {
    execFileSync(binary, args, {
      stdio: 'inherit',
    });
  } catch (err) {
    const exitErr = err as Error & { status?: number };
    if (exitErr.status !== undefined && exitErr.status !== 0) {
      process.exit(exitErr.status);
    }
    throw err;
  }
}

/**
 * Print raloop help message by delegating to the Go binary.
 */
export function printRaloopHelp(): void {
  const binary = findRaloopBinary();
  try {
    execFileSync(binary, ['--help'], { stdio: 'inherit' });
  } catch {
    // Fallback help message if binary not available
    console.log(`
Raloop - Auto-restart loop daemon for Ralph TUI (Go binary: raloop_go)

USAGE:
  ralph-tui raloop [options]

OPTIONS:
  --cwd <path>              Working directory (default: .)
  --headless, --no-tui       Run in headless mode (default: TUI)
  --parallel <n>            Enable parallel execution with N workers
  --poll-interval <seconds> Task polling interval (default: 5)
  --restart-delay <seconds> Crash restart delay (default: 5)
  --stuck-timeout <seconds> Timeout for stuck processes (default: 30)
  --max-retries <n>         Max restart attempts (default: 10, 0 = unlimited)
  --log <path>              Log file path (append mode)
  --verbose, -v             Show ralph-tui output in real-time
  --pid <path>              PID file path (default: .ralph-tui/raloop.pid)
  --help, -h                Show this help message

NOTE: Run "raloop_go --help" for full usage information.
`);
  }
}

/**
 * Find the raloop Go binary.
 * Searches in multiple locations:
 * 1. project root/cmd/raloop/
 * 2. dist/
 * 3. ~/.bun/bin/
 * 4. PATH
 */
function findRaloopBinary(): string {
  // Try project cmd/raloop directory
  const projectRoot = path.resolve(__dirname, '..', '..');
  const localBinary = path.join(projectRoot, 'cmd', 'raloop', 'raloop_go');

  if (fileExists(localBinary)) {
    return localBinary;
  }

  // Try dist directory (for built versions)
  const distBinary = path.join(projectRoot, 'dist', 'raloop_go');

  if (fileExists(distBinary)) {
    return distBinary;
  }

  // Try ~/.bun/bin/
  const bunBin = path.join(os.homedir(), '.bun', 'bin', 'raloop_go');

  if (fileExists(bunBin)) {
    return bunBin;
  }

  // Fallback to PATH
  return 'raloop_go';
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
