/**
 * ABOUTME: Raloop command - automated patrol loop with enhanced CLI interface.
 * Wraps the PatrolService to provide a purpose-built command for running
 * patrol loops with configurable interval, count, and commands.
 */

import { spawn } from 'node:child_process';

export interface RaloopOptions {
  interval?: number;
  count?: number;
  commands: string[];
  daemon?: boolean;
  parallel?: number | boolean;
  help?: boolean;
}

import { executePatrolCommand } from './patrol.js';

const DEFAULT_INTERVAL_MS = 300_000; // 5 minutes

/**
 * Parse raloop command arguments.
 */
export function parseRaloopArgs(args: string[]): RaloopOptions {
  const options: RaloopOptions = { commands: [] };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--interval' || arg === '-i') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val > 0) {
        options.interval = val;
      } else {
        console.error(`Invalid interval: ${args[i]}`);
        process.exit(1);
      }
    } else if (arg === '--count' || arg === '-c') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val) && val > 0) {
        options.count = val;
      } else {
        console.error(`Invalid count: ${args[i]}`);
        process.exit(1);
      }
    } else if (arg === '--daemon' || arg === '-d') {
      options.daemon = true;
    } else if (arg === '--parallel' || arg === '-p') {
      // --parallel or --parallel N where N is max workers
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        const val = parseInt(nextArg, 10);
        if (!isNaN(val) && val > 0) {
          options.parallel = val;
          i++;
        } else {
          console.error(`Invalid parallel worker count: ${nextArg}`);
          process.exit(1);
        }
      } else {
        options.parallel = true; // default to 3 workers
      }
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--command' || arg === '-C') {
      // Consume all remaining args as commands
      options.commands = args.slice(i + 1);
      break;
    } else if (!arg.startsWith('-')) {
      // Bare arg treated as command
      options.commands.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    i++;
  }

  if (options.commands.length === 0) {
    options.commands = ['git status'];
  }

  return options;
}

/**
 * Execute a single command via spawn and return output.
 */
function runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Format a timestamp for display.
 */
function formatTime(): string {
  const now = new Date();
  return now.toLocaleTimeString();
}

/**
 * Print separator line.
 */
function printSeparator(label: string): void {
  const border = '─'.repeat(60);
  console.log(`\n${border}`);
  console.log(`  ${label}`);
  console.log(border);
}

/**
 * Execute the raloop command.
 */
export async function executeRaloopCommand(args: string[]): Promise<void> {
  const options = parseRaloopArgs(args);

  if (options.help) {
    printRaloopHelp();
    return;
  }

  const intervalMs = options.interval ?? DEFAULT_INTERVAL_MS;
  const maxIterations = options.count;
  const commands = options.commands;

  // Default: patrol mode (beads task monitoring)
  if (commands.length === 0 || options.parallel) {
    await executePatrolCommand({ parallel: options.parallel });
    return;
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                     Ralph Patrol Loop Started                  ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Interval:   ${intervalMs}ms (${intervalMs / 1000}s)`);
  console.log(`  Commands:   ${commands.join(' && ')}`);
  if (maxIterations) {
    console.log(`  Iterations: ${maxIterations}`);
  } else {
    console.log('  Iterations: infinite (Ctrl+C to stop)');
  }
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Handle daemon mode
  if (options.daemon && process.env.RALPH_DAEMON !== '1') {
    await forkAsDaemon(args);
    return;
  }

  let iteration = 0;
  let running = true;

  const shutdown = () => {
    if (running) {
      running = false;
      console.log('\nRaloop stopped.');
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    iteration++;

    if (maxIterations && iteration > maxIterations) {
      break;
    }

    printSeparator(`Iteration ${iteration} — ${formatTime()}`);
    console.log('');

    for (const cmd of commands) {
      console.log(`$ ${cmd}`);
      try {
        const result = await runCommand(cmd);
        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          console.error(result.stderr);
        }
        if (result.exitCode !== 0) {
          console.error(`[exit ${result.exitCode}]`);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Command failed: ${message}`);
      }
      console.log('');
    }

    if (running && (!maxIterations || iteration < maxIterations)) {
      await sleep(intervalMs);
    }
  }

  console.log('Raloop completed.');
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fork the current process as a daemon.
 */
async function forkAsDaemon(args: string[]): Promise<void> {
  const scriptPath = process.argv[1];
  const child = spawn(process.execPath, [scriptPath, 'raloop', ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RALPH_DAEMON: '1' },
  });

  child.unref();

  console.log('');
  console.log(`Raloop started as daemon (PID: ${child.pid})`);
  console.log('');
}

/**
 * Print raloop command help.
 */
export function printRaloopHelp(): void {
  console.log(`
ralph-tui raloop - Automated patrol loop for beads task monitoring

Usage: ralph-tui raloop [options]

Options:
  -i, --interval <ms>   Loop interval in milliseconds (default: 300000 = 5min)
  -c, --count <n>       Number of iterations (default: infinite)
  -C, --command <cmd>   Commands to run each iteration (default: patrol mode)
  -p, --parallel        Run tasks in parallel mode (--no-worktree by default)
  -d, --daemon          Run as a background daemon
  -h, --help            Show this help message

Description:
  When called without arguments, starts the beads patrol agent that:
  - Monitors all bead task statuses every 5 minutes
  - Detects stuck tasks (in_progress with no progress)
  - Detects dependency issues (blocked tasks)
  - Uses AI agent to analyze and auto-resolve issues
  - Records patrol findings to .ralph-tui/patrol/

  With --parallel, runs tasks sequentially in the main directory without
  worktrees. This is the recommended mode for raloop since patrol tasks
  don't conflict with each other.

  With -C, runs custom shell commands in a loop instead.

Examples:
  ralph-tui raloop                           # Patrol beads tasks every 5min
  ralph-tui raloop --parallel                # Run tasks in no-worktree mode
  ralph-tui raloop -C 'git status'           # Custom command loop every 5min
  ralph-tui raloop -i 10000 -C 'git pull'   # Custom interval and command
  ralph-tui raloop -c 5 -C 'git status'     # Run 5 times then stop
  ralph-tui raloop --daemon                 # Run as background daemon
`);
}
