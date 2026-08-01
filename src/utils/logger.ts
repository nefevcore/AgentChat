// ============================================================
// 统一 Logger
//
//   提供分级日志输出，通过 LOG_LEVEL 环境变量控制详细程度：
//     debug  — 输出所有日志
//     info   — 默认，输出 info / notice / warn / error
//     notice — 仅输出 notice / warn / error
//     warn   — 仅输出 warn / error
//     error  — 仅输出 error
//     silent — 完全静默
//
//   输出格式：
//     HH:mm:ss │ LVL │ [TAG____________] message
//
//   设计原则：
//     1. 保持 [Tag] 前缀约定：`logger.info('[Tag] message')`
//     2. [Tag] 自动对齐到固定宽度，方便快速扫描
//     3. debug 用于开发调试细节（定时器补偿、MCP 握手等），默认不输出
//     4. 预留 writeToFile 扩展点，未来可按需将 error 写入文件
// ============================================================

type LogLevel = 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warn: 3,
  error: 4,
  silent: 5,
};

const LEVEL_LABEL: Record<string, string> = {
  debug:  'DEBUG',
  info:   'INFO ',
  notice: 'NOTE ',
  warn:   'WARN ',
  error:  'ERR  ',
};

// ANSI 转义码
const C = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
};

/** 各级别对应的颜色 */
const LEVEL_COLOR: Record<string, string> = {
  debug:  C.gray,
  info:   C.green,
  notice: C.blue + C.bold,
  warn:   C.yellow,
  error:  C.red,
};

/** Tag 右对齐宽度（含方括号） */
const TAG_WIDTH = 18;

function getLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVEL_WEIGHT) return raw as LogLevel;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[getLogLevel()];
}

// ---- 环形日志缓冲 ----
// 内存保留最近 N 条日志，供 read_logs 工具 / WebUI 查询。
// 无文件 IO，进程内共享；重启即清空。

/** 环形缓冲最大条数 */
const LOG_BUFFER_MAX = 2000;

/** 单条日志结构 */
export interface LogEntry {
  /** 级别：debug/info/notice/warn/error */
  level: string;
  /** ISO 时间戳 */
  ts: string;
  /** 格式化后的完整行（含时间/级别/标签） */
  line: string;
  /** 原始消息（去格式） */
  message: string;
}

/** 环形缓冲（FIFO，超出丢弃最旧） */
const logBuffer: LogEntry[] = [];

function pushLog(level: string, message: string): void {
  // 只在真正输出时记录（与 shouldLog 一致）
  logBuffer.push({
    level,
    ts: new Date().toISOString(),
    line: formatLine(level, message),
    message,
  });
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  }
}

/**
 * 读取最近日志（供 read_logs 工具 / 调试）。
 * @param opts 过滤选项：level 最低级别 / keyword 关键词 / limit 条数（默认 100，最大 500）
 */
export function readLogs(opts?: {
  level?: LogLevel;
  keyword?: string;
  limit?: number;
}): LogEntry[] {
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

// ---- 格式化 ----

/** 提取消息开头的 [Tag]（跳过前导空白），返回 { tag, rest }；无 Tag 时将整个消息视为 rest */
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
  const color = LEVEL_COLOR[level] ?? '';

  // 提取前导换行（用于视觉分组）
  let leadingNewlines = '';
  const stripped = message.replace(/^(\n+)/, (_, nl) => {
    leadingNewlines = nl;
    return '';
  });

  const { tag, rest } = splitTag(stripped);

  // 时间 | 级别 | [标签] 消息
  const tagCol = tag
    ? `${C.cyan}${tag.padEnd(TAG_WIDTH)}${C.reset}`
    : ''.padEnd(TAG_WIDTH);
  const msgColor = level === 'error' ? C.red : '';

  const body = `${C.dim}${ts}${C.reset} │ ${color}${lvl}${C.reset} │ ${tagCol} ${msgColor}${rest}${C.reset}`;

  return leadingNewlines + body;
}

// ── 公开 API ──

export const logger = {
  /** 调试追踪（定时器补偿、MCP 握手、请求详情等），仅 LOG_LEVEL=debug 时输出 */
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      pushLog('debug', message);
      console.log(formatLine('debug', message), ...args);
    }
  },

  /** 常规信息（工具注册、配置加载等） */
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      pushLog('info', message);
      console.log(formatLine('info', message), ...args);
    }
  },

  /** 关键通知（启动完成、状态初始化等，即使 LOG_LEVEL=notice 也可见） */
  notice(message: string, ...args: unknown[]): void {
    if (shouldLog('notice')) {
      pushLog('notice', message);
      console.log(formatLine('notice', message), ...args);
    }
  },

  /** 警告（文件缺失、配置回退、降级等可恢复问题） */
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      pushLog('warn', message);
      console.warn(formatLine('warn', message), ...args);
    }
  },

  /** 错误（LLM 失败、路由投递失败、致命错误等） */
  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      pushLog('error', message);
      console.error(formatLine('error', message), ...args);
    }
  },
};

// ── 直接导出工厂函数，方便模块创建带默认 Tag 的子 logger ──

export function createLogger(defaultTag: string) {
  return {
    debug(msg: string, ...args: unknown[]): void {
      logger.debug(`[${defaultTag}] ${msg}`, ...args);
    },
    info(msg: string, ...args: unknown[]): void {
      logger.info(`[${defaultTag}] ${msg}`, ...args);
    },
    notice(msg: string, ...args: unknown[]): void {
      logger.notice(`[${defaultTag}] ${msg}`, ...args);
    },
    warn(msg: string, ...args: unknown[]): void {
      logger.warn(`[${defaultTag}] ${msg}`, ...args);
    },
    error(msg: string, ...args: unknown[]): void {
      logger.error(`[${defaultTag}] ${msg}`, ...args);
    },
  };
}
