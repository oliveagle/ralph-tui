/**
 * ABOUTME: Terminal color utilities for colored console output.
 * Provides ANSI color codes for different log levels.
 */

/** ANSI color codes for terminal output */
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',

  fg: {
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
  },

  bg: {
    black: '\x1b[40m',
    red: '\x1b[41m',
    green: '\x1b[42m',
    yellow: '\x1b[43m',
    blue: '\x1b[44m',
    magenta: '\x1b[45m',
    cyan: '\x1b[46m',
    white: '\x1b[47m',
  },
} as const;

/** Color a string with the given ANSI color code */
export function colorize(text: string, colorCode: string): string {
  return `${colorCode}${text}${colors.reset}`;
}

/** Color shortcuts for common log levels */
export const logColors = {
  error: (text: string) => colorize(text, colors.fg.red),
  warn: (text: string) => colorize(text, colors.fg.yellow),
  info: (text: string) => colorize(text, colors.fg.blue),
  success: (text: string) => colorize(text, colors.fg.green),
  debug: (text: string) => colorize(text, colors.dim),
  worker: (text: string) => colorize(text, colors.fg.cyan),
  progress: (text: string) => colorize(text, `\x1b[38;5;183m`),  // 淡紫色 (lavender)
  merge: (text: string) => colorize(text, colors.fg.blue),
} as const;

/** Format a log line with timestamp, level, and colored message */
export function formatLogLine(
  timestamp: string,
  level: string,
  component: string,
  message: string
): string {
  const levelUpper = level.toUpperCase();
  let colorFn: (text: string) => string;

  switch (levelUpper) {
    case 'ERROR':
      colorFn = logColors.error;
      break;
    case 'WARN':
      colorFn = logColors.warn;
      break;
    case 'INFO':
      colorFn = logColors.info;
      break;
    case 'SUCCESS':
      colorFn = logColors.success;
      break;
    case 'PROGRESS':
      colorFn = logColors.progress;
      break;
    case 'WORKER':
      colorFn = logColors.worker;
      break;
    case 'MERGE':
      colorFn = logColors.merge;
      break;
    default:
      colorFn = (text) => text;
  }

  const coloredLevel = colorFn(`[${levelUpper}]`);
  return `[${timestamp}] ${coloredLevel} [${component}] ${message}`;
}

/**
 * Strip ANSI color codes from a string.
 * Useful for writing to log files where colors should be removed.
 */
export function stripColors(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
