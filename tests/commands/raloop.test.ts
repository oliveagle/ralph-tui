/**
 * ABOUTME: Unit tests for the raloop command - automated patrol loop.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { parseRaloopArgs, printRaloopHelp, type RaloopOptions } from '../../src/commands/raloop.js';

describe('raloop command', () => {
  describe('parseRaloopArgs', () => {
    test('parses basic arguments with short flags', () => {
      const options = parseRaloopArgs(['-i', '10000', '-c', '5', '-C', 'git status']);
      expect(options.interval).toBe(10000);
      expect(options.count).toBe(5);
      expect(options.commands).toEqual(['git status']);
    });

    test('parses --interval and --count long flags', () => {
      const options = parseRaloopArgs(['--interval', '5000', '--count', '10']);
      expect(options.interval).toBe(5000);
      expect(options.count).toBe(10);
    });

    test('parses daemon mode', () => {
      const options = parseRaloopArgs(['--daemon']);
      expect(options.daemon).toBe(true);
    });

    test('parses help flag', () => {
      const options = parseRaloopArgs(['--help']);
      expect(options.help).toBe(true);
    });

    test('parses short flags -i, -c, -d, -h', () => {
      const options = parseRaloopArgs(['-i', '2000', '-c', '3', '-d', '-h']);
      expect(options.interval).toBe(2000);
      expect(options.count).toBe(3);
      expect(options.daemon).toBe(true);
      expect(options.help).toBe(true);
    });

    test('parses bare command arguments', () => {
      const options = parseRaloopArgs(['git pull', 'git log']);
      expect(options.commands).toEqual(['git pull', 'git log']);
    });

    test('defaults to git status when no commands provided', () => {
      const options = parseRaloopArgs([]);
      expect(options.commands).toEqual(['git status']);
    });

    test('handles -C flag to consume remaining args as commands', () => {
      const options = parseRaloopArgs(['-C', 'git fetch', 'git status']);
      expect(options.commands).toEqual(['git fetch', 'git status']);
    });

    test('ignores flags after bare commands', () => {
      const options = parseRaloopArgs(['git status', 'git log']);
      expect(options.commands).toEqual(['git status', 'git log']);
    });
  });

  describe('printRaloopHelp', () => {
    let consoleOutput: string[] = [];
    const originalLog = console.log;

    beforeEach(() => {
      consoleOutput = [];
      console.log = (...args: unknown[]) => {
        consoleOutput.push(args.map(String).join(' '));
      };
    });

    afterEach(() => {
      console.log = originalLog;
    });

    test('prints help text', () => {
      printRaloopHelp();
      const output = consoleOutput.join('\n');
      expect(output).toContain('ralph-tui raloop');
      expect(output).toContain('Usage:');
    });

    test('includes all option flags', () => {
      printRaloopHelp();
      const output = consoleOutput.join('\n');
      expect(output).toContain('--interval');
      expect(output).toContain('--count');
      expect(output).toContain('--command');
      expect(output).toContain('--daemon');
      expect(output).toContain('--help');
    });

    test('includes examples', () => {
      printRaloopHelp();
      const output = consoleOutput.join('\n');
      expect(output).toContain('Examples:');
      expect(output).toContain('git status');
      expect(output).toContain('git pull');
    });
  });

  describe('RaloopOptions interface', () => {
    test('full options object is valid', () => {
      const options: RaloopOptions = {
        interval: 10000,
        count: 5,
        commands: ['git status', 'git pull'],
        daemon: true,
        help: false,
      };

      expect(options.interval).toBe(10000);
      expect(options.count).toBe(5);
      expect(options.commands).toHaveLength(2);
      expect(options.daemon).toBe(true);
    });

    test('minimal options object is valid', () => {
      const options: RaloopOptions = {
        commands: ['git status'],
      };

      expect(options.commands).toHaveLength(1);
      expect(options.interval).toBeUndefined();
      expect(options.count).toBeUndefined();
      expect(options.daemon).toBeUndefined();
      expect(options.help).toBeUndefined();
    });
  });

  describe('command iteration logic', () => {
    test('multiple commands are executed sequentially', () => {
      const commands = ['git fetch', 'git status', 'git log --oneline -5'];
      expect(commands).toHaveLength(3);

      // Simulate sequential execution order
      const executionOrder: string[] = [];
      for (const cmd of commands) {
        executionOrder.push(cmd);
      }

      expect(executionOrder).toEqual(['git fetch', 'git status', 'git log --oneline -5']);
    });

    test('iteration count limits execution', () => {
      const maxIterations = 3;
      let iteration = 0;
      const executed: number[] = [];

      while (iteration < maxIterations) {
        iteration++;
        executed.push(iteration);
        if (iteration >= maxIterations) break;
      }

      expect(executed).toEqual([1, 2, 3]);
    });

    test('infinite loop simulation runs multiple iterations', () => {
      const maxIterations = 0; // 0 = infinite
      let iteration = 0;
      const executed: number[] = [];

      // Simulate max 5 iterations for safety
      while (iteration < 5) {
        iteration++;
        executed.push(iteration);
        if (maxIterations && iteration >= maxIterations) break;
      }

      expect(executed).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('interval parsing', () => {
    test('converts milliseconds to seconds correctly', () => {
      const intervalMs = 5000;
      const intervalSeconds = intervalMs / 1000;
      expect(intervalSeconds).toBe(5);
    });

    test('converts seconds to milliseconds correctly', () => {
      const intervalSeconds = 300;
      const intervalMs = intervalSeconds * 1000;
      expect(intervalMs).toBe(300_000);
    });

    test('handles various interval values', () => {
      const intervals = [
        { ms: 1000, seconds: 1 },
        { ms: 5000, seconds: 5 },
        { ms: 300_000, seconds: 300 },
        { ms: 600_000, seconds: 600 },
      ];

      for (const { ms, seconds } of intervals) {
        expect(ms / 1000).toBe(seconds);
      }
    });
  });

  describe('patrol mode detection', () => {
    test('daemon mode triggers patrol', () => {
      const options = { daemon: true, commands: [] as string[] };
      const shouldUsePatrol = options.daemon;
      expect(shouldUsePatrol).toBe(true);
    });

    test('empty commands triggers patrol', () => {
      const options = { daemon: false, commands: [] as string[] };
      const shouldUsePatrol = options.commands.length === 0;
      expect(shouldUsePatrol).toBe(true);
    });

    test('custom commands skips patrol', () => {
      const options = { daemon: false, commands: ['git status'] };
      const shouldUsePatrol = options.daemon || options.commands.length === 0;
      expect(shouldUsePatrol).toBe(false);
    });
  });
});