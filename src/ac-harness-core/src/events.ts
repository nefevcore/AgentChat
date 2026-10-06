// ============================================================
// ac-harness-core/src/events.ts —— 事件归一（公共词汇）
//
// 两家 JSONL 流 → HarnessEvent 归一形状（工具卡直播与结果 notices
// 共用）。归一规则：claude assistant text 块 / codex agent_message →
// delta；工具执行与文件变更 → notice；终态 → done（终稿 + usage 归一，
// token 两家口径差异保留 optional）。损坏行/未知事件 → 丢弃 + 计数
// （stats.unknownEvents——流不中断，前向兼容 D7）。
// ============================================================

/** 归一事件流（claude-code / codex JSONL 的公共形状） */
export type HarnessEvent =
  | { kind: 'started'; runKey?: string; model?: string }
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'notice'; label: string; detail?: string }
  | { kind: 'done'; finish: 'stop' | 'error'; summary: string };

/** 归一 usage（口径差异保留 optional——如实透传不折算） */
export interface HarnessUsage {
  prompt?: number;
  completion?: number;
  total?: number;
  costUsd?: number;
  turns?: number;
  elapsedMs?: number;
}

/** 每行 JSONL 的解析结果（行级容错面） */
export type LineOutcome =
  | { ok: true; event: HarnessEvent }
  | { ok: true; terminal: TerminalFacts }
  | { ok: false };

/** 终态事实（adapter 终稿组装的原料） */
export interface TerminalFacts {
  finish: 'stop' | 'error';
  text: string;
  runKey?: string;
  usage?: HarnessUsage;
  stats?: { unknownEvents: number; stderrTail?: string };
}

/** 安全截断（notice detail / 终稿 stderr 尾部共用） */
export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `…[截断，共${text.length}字符]` : text;
}

/** JSONL 行安全解析（非 JSON 行 → undefined——损坏行丢弃计数） */
export function parseJsonlLine(line: string): Record<string, unknown> | undefined {
  const s = line.trim();
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 字段提取短手（类型收窄） */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}