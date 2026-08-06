/**
 * 前端 Logger — 与后端 logger.ts 接口一致，
 * 通过 localStorage 或 URL 参数控制 LOG_LEVEL。
 *
 * 输出格式：HH:mm:ss │ LVL │ [TAG____________] message
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const LEVEL_LABEL: Record<string, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERR  ' };
const TAG_WIDTH = 18;

function getLogLevel(): LogLevel {
  const urlParam = new URLSearchParams(window.location.search).get('LOG_LEVEL');
  const raw = (urlParam || localStorage.getItem('LOG_LEVEL') || 'info').toLowerCase();
  if (raw in LEVEL_WEIGHT) return raw as LogLevel;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[getLogLevel()];
}

function splitTag(message: string): { tag: string; rest: string } {
  const trimmed = message.trimStart();
  const m = trimmed.match(/^(\[.+?\])\s*/);
  if (m) {
    const leading = message.slice(0, message.length - trimmed.length);
    return { tag: m[1], rest: leading + trimmed.slice(m[0].length) };
  }
  return { tag: '', rest: message };
}

function formatLine(level: string, message: string): string {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  const lvl = LEVEL_LABEL[level] ?? level.toUpperCase().padEnd(5);

  const { tag, rest } = splitTag(message);
  if (tag) {
    return `${ts} │ ${lvl} │ ${tag.padEnd(TAG_WIDTH)} ${rest}`;
  }
  return `${ts} │ ${lvl} │ ${''.padEnd(TAG_WIDTH)} ${message}`;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) console.log(formatLine('debug', message), ...args);
  },
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) console.log(formatLine('info', message), ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(formatLine('warn', message), ...args);
  },
  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) console.error(formatLine('error', message), ...args);
  },
};
