// ============================================================
// utils/logger.ts —— 分级日志（纯 TS）
// ============================================================

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const ENABLED_LEVEL: Level = (import.meta.env?.VITE_LOG_LEVEL as Level) || 'info';

function log(level: Level, ...args: any[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[ENABLED_LEVEL]) return;
  const prefix = `[${new Date().toLocaleTimeString()}][${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const logger = {
  debug: (...args: any[]) => log('debug', ...args),
  info: (...args: any[]) => log('info', ...args),
  warn: (...args: any[]) => log('warn', ...args),
  error: (...args: any[]) => log('error', ...args),
};
