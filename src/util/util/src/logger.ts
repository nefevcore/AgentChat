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

// ============================================================
// 控制台着色（ANSI，零依赖；环形缓冲/自定义 sink 始终存无色的纯文本）
// ============================================================

/** 各级别颜色（ANSI 转义码） */
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[1m\x1b[31m', // bold red
};

/** 时间戳颜色（暗灰） */
const TIME_COLOR = '\x1b[2m\x1b[90m';
/** 前缀（类型/组件）颜色（品红） */
const PREFIX_COLOR = '\x1b[35m';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function colorize(code: string, text: string): string {
  return `${code}${text}\x1b[0m`;
}

/** 是否输出 ANSI 颜色：非 TTY 默认关闭，FORCE_COLOR=1 强制开启，NO_COLOR 强制关闭 */
function colorsEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  if (process.env?.FORCE_COLOR === '1') return true;
  if (process.env?.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  return !!(process.stdout?.isTTY || process.stderr?.isTTY);
}

/** 组装控制台行：HH:MM:SS.mmm LEVEL [prefix] message（着色视 TTY 而定） */
function formatConsoleLine(level: LogLevel, prefix: string, args: any[]): string {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const levelTag = level.toUpperCase().padEnd(5, ' ');
  const message = args.join(' ');

  if (!colorsEnabled()) {
    return `${time} ${levelTag} ${prefix} ${message}`;
  }
  return [
    colorize(TIME_COLOR, time),
    colorize(LEVEL_COLOR[level], levelTag),
    colorize(PREFIX_COLOR, prefix),
    message,
  ].join(' ');
}

/** 创建带前缀的 Logger（console 输出带时间戳 + 级别 + 前缀，并着色） */
export function createLogger(prefix: string): LogSink {
  const emit = (level: LogLevel, args: any[]): void => {
    pushLog(level, [prefix, ...args].join(' '));
    _sink[level](formatConsoleLine(level, prefix, args));
  };
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}
