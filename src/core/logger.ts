// ============================================================
// src/core/logger.ts —— 零依赖最小日志器
//
// L1 引擎不依赖 @utils/logger（上层实现），故内置一个零依赖实现：
//   · 默认输出到 console（带前缀）
//   · 支持注入自定义 sink（测试可捕获/静默日志）
//   · 级别过滤：debug < info < warn < error
//
// 铁律：零外部依赖，仅使用 console 与 process.env。
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志写入接口（可注入，默认 console） */
export interface LogSink {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

/** 默认 sink：console */
const consoleSink: LogSink = {
  debug: (...args) => { if (isLevelEnabled('debug')) console.debug(...args); },
  info: (...args) => { if (isLevelEnabled('info')) console.info(...args); },
  warn: (...args) => { if (isLevelEnabled('warn')) console.warn(...args); },
  error: (...args) => { if (isLevelEnabled('error')) console.error(...args); },
};

let _sink: LogSink = consoleSink;
let _level: LogLevel = defaultLevel();

function defaultLevel(): LogLevel {
  const env = (typeof process !== 'undefined' ? process.env?.AGENTCHAT_LOG_LEVEL : undefined) ?? '';
  if (env === 'debug') return 'debug';
  if (env === 'warn') return 'warn';
  if (env === 'error') return 'error';
  return 'info';
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[_level];
}

/** 注入自定义 sink（测试捕获/静默用） */
export function setLogSink(sink: Partial<LogSink>): void {
  _sink = { ...consoleSink, ...sink };
}

/** 设置日志级别 */
export function setLogLevel(level: LogLevel): void {
  _level = level;
}

// ============================================================
// 环形缓冲（照搬旧 utils/logger：read_logs 工具 / 调试用）
// ============================================================

/** 环形缓冲最大条数 */
const LOG_BUFFER_MAX = 2000;

/** 单条日志结构 */
export interface LogEntry {
  /** 级别：debug/info/warn/error */
  level: string;
  /** ISO 时间戳 */
  ts: string;
  /** 格式化后的完整行 */
  line: string;
  /** 原始消息（去格式） */
  message: string;
}

/** 级别权重（read_logs 过滤用） */
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 环形缓冲（FIFO，超出丢弃最旧） */
const logBuffer: LogEntry[] = [];

function pushLog(level: string, message: string): void {
  logBuffer.push({
    level,
    ts: new Date().toISOString(),
    line: `[${new Date().toTimeString().slice(0, 8)}] ${level.toUpperCase()} ${message}`,
    message,
  });
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  }
}

/** 读取最近日志（供 read_logs 工具 / 调试）。level 最低级别 / keyword 关键词 / limit 条数（默认 100，最大 500） */
export function readLogs(opts?: { level?: LogLevel; keyword?: string; limit?: number }): LogEntry[] {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const minWeight = opts?.level ? LEVEL_WEIGHT[opts.level] : 0;
  const kw = opts?.keyword?.toLowerCase();

  let result = logBuffer;
  if (minWeight > 0) {
    result = result.filter(e => LEVEL_WEIGHT[e.level as LogLevel] >= minWeight);
  }
  if (kw) {
    result = result.filter(e => e.line.toLowerCase().includes(kw));
  }
  return result.slice(-limit);
}

/** 清空环形缓冲（调试用） */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

/** 创建带前缀的 Logger */
export function createLogger(prefix: string): LogSink {
  const fmt = (...args: any[]) => [prefix, ...args];
  return {
    debug: (...args) => { pushLog('debug', [prefix, ...args].join(' ')); _sink.debug(...fmt(...args)); },
    info: (...args) => { pushLog('info', [prefix, ...args].join(' ')); _sink.info(...fmt(...args)); },
    warn: (...args) => { pushLog('warn', [prefix, ...args].join(' ')); _sink.warn(...fmt(...args)); },
    error: (...args) => { pushLog('error', [prefix, ...args].join(' ')); _sink.error(...fmt(...args)); },
  };
}
