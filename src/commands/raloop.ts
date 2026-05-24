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

  // If --patrol mode is enabled via daemon flag or explicit detection
  if (options.daemon || commands.length === 0) {
    // Patrol mode: integrate with patrol.ts
    await executePatrolMode(intervalMs);
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
 * Execute raloop in patrol mode using patrol.ts integration.
 */
async function executePatrolMode(intervalMs: number): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    Ralph Patrol Mode Started                  ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Interval:   ${intervalMs}ms (${intervalMs / 1000}s)`);
  console.log('  Mode:       Beads task monitoring');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  const { registerBuiltinAgents } = await import('../plugins/agents/builtin/index.js');
  const { registerBuiltinTrackers } = await import('../plugins/trackers/builtin/index.js');
  const { getTrackerRegistry } = await import('../plugins/trackers/registry.js');
  const { getAgentRegistry } = await import('../plugins/agents/registry.js');
  const { buildConfig } = await import('../config/index.js');
  const { DeadlockResolver } = await import('../parallel/deadlock-resolver.js');

  // Initialize plugins (same pattern as run.tsx)
  registerBuiltinAgents();
  registerBuiltinTrackers();

  const agentRegistry = getAgentRegistry();
  const trackerRegistry = getTrackerRegistry();
  await Promise.all([agentRegistry.initialize(), trackerRegistry.initialize()]);

  const config = await buildConfig({});
  if (!config) {
    console.error('[raloop] Failed to build configuration');
    process.exit(1);
  }
  const tracker = await trackerRegistry.getInstance(config.tracker);

  const deadlockResolver = new DeadlockResolver(
    { cwd: process.cwd(), sessionId: 'raloop', worktreeDir: '.ralph-tui/worktrees' },
    tracker,
    config
  );

  const patrolConfig: PatrolConfig = {
    intervalSeconds: Math.floor(intervalMs / 1000),
    useAiResolver: true,
    stuckThresholdMs: 10 * 60_000,
  };

  await startPatrol(tracker, deadlockResolver, patrolConfig);
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
ralph-tui raloop - Run an automated patrol loop

Usage: ralph-tui raloop [options]

Options:
  -i, --interval <ms>   Loop interval in milliseconds (default: 5000)
  -c, --count <n>       Number of iterations (default: infinite)
  -C, --command <cmd>   Commands to run each iteration (default: git status)
  -d, --daemon          Run as a background daemon
  -h, --help            Show this help message

Description:
  Runs commands in a loop at a specified interval. This is a convenience
  wrapper around the patrol functionality, providing a dedicated CLI command
  for automated polling and monitoring.

  Multiple commands can be specified with repeated -C flags or as arguments
  after --command. They are executed sequentially each iteration.

Examples:
  ralph-tui raloop                           # Run 'git status' every 5s
  ralph-tui raloop -C 'git pull'             # Run 'git pull' every 5s
  ralph-tui raloop -i 10000 -C 'git status'  # Every 10 seconds
  ralph-tui raloop -c 5 -C 'git status'      # Run 5 times then stop
  ralph-tui raloop -C 'git status' 'git log' # Multiple commands per iteration
  ralph-tui raloop --daemon                  # Run as background daemon
`);
}
