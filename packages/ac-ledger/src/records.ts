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
  /** 行来源词（开放：event/error/skill… 终稿行 = 'run:<id>' 联查键；
   *  段行 = 'segment' / 注入行 = 'inject'——cr-697 settlement 段行物化产物） */
  source?: string;
  /** 段行 run 关联（导入迁移：settlement 切段物化产物——旧侧 run 键随终稿行保留，供 webui run 键带出） */
  run?: string;
  /**
   * run 墙钟耗时（毫秒，cr-772；终稿行在场——LoopRunResult.wallMs 取源）。
   * 历史链栏「用时」段的持久锚：直播期 runCalibMs 校准对随 run 消失，
   * 刷新后由此恢复。存量行缺席（前端回落时间戳推导）。
   */
  runMs?: number;
  /** 段行 steps（source='segment' 行在场）：已合并工具结果（含 run_code 子调用
   *  平铺）的步序——journal 步行物化的落账形态；journal 随之剔除该 run 步行
   *  （收束即清，cr-697——journal 回归 run 周期台账本义，治永源膨胀） */
  steps?: ProjectedStep[];
  /** 注入行来源决策词（source='inject' 行的语义来源：durable-interaction /
   *  skill / memory 等——UI 注入卡 kind；cr-707） */
  injectSource?: string;
  /** 注入行 UI 文案（cr-707：与直播帧 label 同源——流式与刷新两路径同形） */
  label?: string;
  /** 单调序号（writer 按文件分配——崩溃检测 + 去重锚） */
  seq?: number;
}

/**
 * run 步投影行（webui history steps 带出——主线 SessionStepRecord 的前端
 * 消费最小面）：思考折叠（reasoning）+ 工具卡（toolCalls 含内联 result——
 * journal 分列 toolCalls/toolResults 在此合并）。
 * ts = 落行时刻（cr-697 起 journal 行盖戳、物化随行带出；存量行缺席）。
 */
export interface ProjectedStep {
  content: string;
  reasoning?: string;
  /** 中止步标记（cr-766）——前端据此渲染中断态（部分正文 + 「已中断」） */
  aborted?: boolean;
  /** 思考相位时长（毫秒，cr-766——历史回放恢复「已思考 · XmYs」） */
  reasoningMs?: number;
  /** 正文相位时长（毫秒，cr-766） */
  textMs?: number;
  /** 步身份键（cr-772 落盘透传）——历史合并键控对齐（存量步投影缺席） */
  stepId?: string;
  /**
   * 本步 API 流时间（毫秒，cr-772）+ 步用量——历史链栏速率段数据源。
   * completion/elapsedMs 成对消费（输出口径速率 = Σcompletion/Σms）。
   */
  elapsedMs?: number;
  usage?: { prompt: number; completion: number; total?: number };
  ts?: number;
  toolCalls?: Array<{ id: string; name: string; arguments: string; result: unknown; subcall?: boolean; durationMs?: number }>;
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
  /**
   * 步身份键（cr-772 落盘透传）：= `${runId}:${index}——loop 盖章、直播
   * delta 帧 meta.stepId 与此同值，历史合并键控对齐（存量行缺席）。
   */
  stepId?: string;
  content: string;
  reasoning?: string;
  /**
   * 中止步标记（cr-766）：LLM 流被 abort 时的部分聚合步——toolCalls 可能
   * 不完整，续跑/轨迹重建读侧据此剔除。步记录照常落盘（中断前模型已
   * 流出的思考/正文是会话事实）。
   */
  aborted?: boolean;
  /** 思考相位时长（毫秒；cr-766 起随步行落盘——历史回放恢复耗时） */
  reasoningMs?: number;
  /** 正文相位时长（毫秒；cr-766——步内相位粒度第二段） */
  textMs?: number;
  /**
   * 本步 API 流时间（毫秒，cr-772 落盘透传）+ 步用量——历史链栏速率段
   * （Σcompletion/ΣelapsedMs）数据源；与直播 after-step 帧同字段面。
   */
  elapsedMs?: number;
  usage?: { prompt: number; completion: number; total?: number };
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** 工具执行结果（与 tool_calls 一一对应——service.journalStep 落盘；读侧 steps 投影合并进 result） */
  toolResults?: Array<{ ok: boolean; output?: unknown; error?: string }>;
  /** 落行时刻（epoch ms——cr-697 起盖戳；物化段行/步级 ts 的取源；存量行缺席） */
  ts?: number;
  seq?: number;
}

/** journal 注入行（steer/事件按消费点真序落） */
export interface JournalInject {
  type: 'journal-inject';
  run: string;
  content: string;
  requestId?: string;
  /** 注入身份键（cr-707：物化注入行 message_id 取源——直播行与刷新行同锚） */
  injectionId?: string;
  /** 注入来源决策词（cr-707：物化行 injectSource 取源——UI 注入卡 kind） */
  injectSource?: string;
  /** 注入行 UI 文案（cr-707：物化行 label 取源——正文对卡片标题过长） */
  label?: string;
  /** 落行时刻（epoch ms——cr-697 起盖戳；物化注入行时间戳取源） */
  ts?: number;
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
  /** 工具执行耗时（毫秒，cr-766——tool/after-execute 的 ToolTransform.durationMs；历史回放工具卡耗时） */
  durationMs?: number;
  /** 子调用档案（runCodeSubcall 时携带——宿主步行只有宿主 run_code 调用，
   * 子调用的名/参无处可寻，档案随补行落盘；读侧注入宿主卡后平铺） */
  subcall?: boolean;
  name?: string;
  /** 参数原始 JSON 串（子调用档案） */
  arguments?: string;
  /** 落行时刻（epoch ms——cr-697 起盖戳） */
  ts?: number;
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
