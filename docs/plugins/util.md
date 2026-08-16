# @agentchat/util
> 包路径 `src/util/util` · 版本 0.1.0 · 文档对应 v0.6.2（2026-08-15）

## 概述
横切工具包：提供零依赖最小日志器 `createLogger` 与 Supervisor 托管模式判断 `isSupervised`。它是 L1 引擎不依赖上层日志实现时的内置替代品，被 `@agentchat/llm`、`@agentchat/agent-loop` 等核心包直接 import；不是 cordis 插件，不注册任何 ctx 服务。

## 目录
| 文件 | 职责 |
| --- | --- |
| `index.ts` | re-export `logger` 与 `supervisor` |
| `logger.ts` | `createLogger`/`setLogSink`/`setLogLevel`/`readLogs`/`clearLogBuffer` + 环形缓冲与 ANSI 着色 |
| `supervisor.ts` | `isSupervised()`：读 `AGENTCHAT_SUPERVISED` 环境变量 |

## 插件行
无插件行（纯运行库）。由 `@agentchat/llm`（`createLogger('[OpenAIChatLLM]')`）、`@agentchat/agent-loop`（`createLogger('[core:loop]')`）等直接 import 使用。

## 提供的能力
### 日志器
| 能力 | 签名 / 语义 |
| --- | --- |
| `createLogger(prefix)` | 返回 `LogSink`（`debug/info/warn/error`）；输出行格式 `HH:MM:SS.mmm LEVEL [prefix] message`，TTY 下按级别着色（debug 青 / info 绿 / warn 黄 / error 粗红） |
| `setLogSink(sink)` | 注入自定义 sink（`Partial<LogSink>` 与默认 console 合并；测试捕获/静默用） |
| `setLogLevel(level)` | 设置级别过滤：`debug < info < warn < error` |
| `readLogs(opts?)` | 读取最近日志：`{ level?, keyword?, limit? }`，limit 默认 100、最大 500 |
| `clearLogBuffer()` | 清空环形缓冲 |
| 环形缓冲 | 最多 2000 条 `LogEntry`（`level/ts/line/message`），FIFO 丢弃最旧 |
| 环境变量 | `AGENTCHAT_LOG_LEVEL`（默认 `info`，可选 `debug/warn/error`）；`FORCE_COLOR=1` 强制着色、`NO_COLOR` 非空强制无色 |

### Supervisor
| 能力 | 签名 / 语义 |
| --- | --- |
| `isSupervised()` | `process.env.AGENTCHAT_SUPERVISED === '1'`；父进程托管、重启约定判断，被 L3（system_restart 门控）与 L5（shutdown 重启退出码）共用 |

## 关键契约 / API
```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  debug: (...args: any[]) => void;
  info:  (...args: any[]) => void;
  warn:  (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface LogEntry {
  level: string;    // debug/info/warn/error
  ts: string;       // ISO 时间戳
  line: string;     // 格式化完整行
  message: string;  // 原始消息（去格式）
}

export function createLogger(prefix: string): LogSink;
export function setLogSink(sink: Partial<LogSink>): void;
export function setLogLevel(level: LogLevel): void;
export function readLogs(opts?: { level?: LogLevel; keyword?: string; limit?: number }): LogEntry[];
export function clearLogBuffer(): void;
export function isSupervised(): boolean;
```
- `createLogger` 每次调用都会把格式化后的行写入环形缓冲（供 `read_logs` 工具 / 调试），并转发到当前 sink。
- 颜色仅在 `process.stdout/stderr` 为 TTY 或 `FORCE_COLOR=1` 时输出；缓冲与自定义 sink 始终存无色纯文本。

## 配置
无配置命名空间；行为仅由环境变量控制：`AGENTCHAT_LOG_LEVEL`、`FORCE_COLOR`、`NO_COLOR`、`AGENTCHAT_SUPERVISED`。

## 与其他插件的关系
- 工作区依赖：无（package.json 零依赖）。
- 典型使用方：`@agentchat/llm`、`@agentchat/agent-loop`（直接 import `createLogger`）；L3/L5 共享 `isSupervised`。

## 测试
无独立测试（package.json 仅 `typecheck`）。

## 相关文档
[插件索引](./README.md) · [架构](../architecture.md) · [配置参考](../configuration.md) · [插件开发](../plugin-dev-guide.md)
