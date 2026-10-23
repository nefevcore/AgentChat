// ============================================================
// records.ts —— 账本行协议（D4.1：messages.jsonl 行协议不变——
// role + agent_id + content；viewer 投影内建于行协议）
//
// 形态平移自 ac-session SessionRecord（v1 中性格式），差异：
//   · 会话目录 = agents/<id>/sessions/<uuid>/（per-agent，非全局桶）
//   · 每行增 envelope 键（requestId/uuid 关联——账本身份键恒端点 A5）
//   · seq 单调序号沿用（崩溃/丢行检测 + 去重锚）
// ============================================================

/** 行角色（消费通道）：agent = 真实发言；context = 上下文材料 */
export type LedgerRole = 'agent' | 'context';

/** 账本行（messages.jsonl 每行一 JSON） */
export interface LedgerRow {
  role: LedgerRole;
  content: string;
  message_id: string;
  timestamp: string;
  /** 说话人端点 id（viewer 投影按 agent_id === viewer 赋予角色） */
  agent_id: string;
  /** 信封关联（requestId = 投递幂等键；uuid = 会话身份键） */
  requestId?: string;
  uuid?: string;
  /** context 行来源词（event/error/skill…开放） */
  source?: string;
  /** 段行 run 关联（导入迁移：settlement 切段物化产物——旧侧 run 键随终稿行保留，供 webui run 键带出） */
  run?: string;
  /** 单调序号（writer 按文件分配——崩溃检测 + 去重锚） */
  seq?: number;
}

/** 头行（writer 首建文件时写入） */
export interface LedgerHeader {
  type: 'session-header';
  version: 1;
  createdAt: string;
  /** participants（端点集合——D4.1 header.json 元数据并进首行） */
  participants: string[];
  /** 形态标记（user/agent/group/… 开放词汇） */
  kind: string;
}

/** journal 步行（partials.jsonl——run 周期台账；行序 = 模型消息数组实际序） */
export interface JournalStep {
  type: 'journal-step';
  run: string;
  /** 步序（run 内单调） */
  step: number;
  content: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** 工具执行结果（与 tool_calls 一一对应——service.journalStep 落盘；读侧 steps 投影合并进 result） */
  toolResults?: Array<{ ok: boolean; output?: unknown; error?: string }>;
  seq?: number;
}

/** journal 注入行（steer/事件按消费点真序落） */
export interface JournalInject {
  type: 'journal-inject';
  run: string;
  content: string;
  requestId?: string;
  seq?: number;
}

/** 工具结果补行（cr-596，主线 ac-session「tool/after-execute → 结果补行」同义）：
 * loop/after-step 在工具执行**前**发射（副作用前 durable 语义——步行先落），
 * toolResults 此刻恒空；结果到达（tool/after-execute）即追加本补行，读侧
 * stepsOfRun 按 toolCallId 覆盖合并。run_code 子调用（runId 继承）同路带出。 */
export interface JournalToolResult {
  type: 'journal-tool-result';
  run: string;
  /** 模型侧工具调用 id（tool_calls[].id——run_code 子调用为 <宿主callId>#<seq> 形） */
  toolCallId: string;
  result: { ok: boolean; output?: unknown; error?: string };
  /** 子调用档案（runCodeSubcall 时携带——宿主步行只有宿主 run_code 调用，
   * 子调用的名/参无处可寻，档案随补行落盘；读侧注入宿主卡后平铺） */
  subcall?: boolean;
  name?: string;
  /** 参数原始 JSON 串（子调用档案） */
  arguments?: string;
  seq?: number;
}

/** run 收束行（settlement 物化标记——吸收同 run 全部部分行）。
 * usage 计量（cr-538）：settle 时随行携带 run 级聚合——journal 计量是
 * usage 自报的数据基础（R2 ledger 行「usage 自报（journal 计量 + 事件信）」）。
 * 字段对齐主线 UsageAuditLine（ac-usage）——聚合并回读恒等。 */
export interface JournalSettled {
  type: 'journal-settled';
  run: string;
  finish: 'ok' | 'interrupted' | 'error';
  /** 本 run 用量聚合（LoopRunUsage 原样——无计量步的 run 缺席） */
  usage?: RunUsage;
  /** 计量模型（request.model）——聚合并 byModel 维度数据源 */
  model?: string;
  seq?: number;
}

/** run 级用量聚合（主线 LoopRunUsage 形状——双轨制）；envelope-core
 * UsageRunMeter 同形（schema owning 在彼——journal 计量词汇 re-export） */
import type { UsageRunMeter } from 'ac-envelope-core';
export type RunUsage = UsageRunMeter;
export type { UsageRunMeter };

/** 行类型判别（读侧路由） */
export type JournalLine = JournalStep | JournalInject | JournalToolResult | JournalSettled;

export function journalLineType(line: string): 'step' | 'inject' | 'tool-result' | 'settled' | null {
  const t = line.trimStart();
  if (t.startsWith('{"type":"journal-step"')) return 'step';
  if (t.startsWith('{"type":"journal-inject"')) return 'inject';
  if (t.startsWith('{"type":"journal-tool-result"')) return 'tool-result';
  if (t.startsWith('{"type":"journal-settled"')) return 'settled';
  return null;
}
