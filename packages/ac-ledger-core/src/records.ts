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
type LedgerRole = 'agent' | 'context';

/**
 * 多模态附件引用（cr-1278）：与 ac-llm 的 LlmAttachment 结构同形——本包
 * 零依赖（不 import ac-llm），同形由 ac-ledger fold 的类型赋值锁定。
 * 只存引用（http(s) 直传 / workspace 相对路径），base64 物化收敛在
 * provider 适配层；落盘几十字节，前缀缓存不受污染。
 */
export type LedgerAttachment =
  | { kind: 'image'; ref: string; mime?: string; filename?: string; detail?: 'low' | 'high' | 'original' | 'auto' }
  | { kind: 'video'; ref: string; mime?: string; filename?: string }
  | { kind: 'file'; ref: string; mime?: string; filename?: string };

/** 单个附件上限（与前端采集闸、provider 约束同口径） */
export const ATTACHMENT_LIMIT = 50;
/** ref 长度上限（防误传整段 base64 进账本） */
export const ATTACHMENT_REF_MAX = 2048;

/**
 * 附件白名单窄化（cr-1278 入口单源）：deliver / group/send / 壳侧入站行
 * 三处共用。kind ∈ image|video|file（缺省 image——多模态一期契约），ref
 * 非空且 ≤2048，超限截断（不静默扩容）。非法项丢弃而非炸轮（单图缺失
 * 由适配层降级占位）。
 */
export function normalizeAttachments(input: unknown, limit = ATTACHMENT_LIMIT): LedgerAttachment[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: LedgerAttachment[] = [];
  for (const raw of input) {
    if (out.length >= limit) break;
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === 'string' ? r.kind : 'image';
    const ref = typeof r.ref === 'string' ? r.ref : '';
    if (ref === '' || ref.length > ATTACHMENT_REF_MAX) continue;
    const base = { ref, ...(typeof r.mime === 'string' ? { mime: r.mime } : {}), ...(typeof r.filename === 'string' ? { filename: r.filename } : {}) };
    if (kind === 'image') {
      const detail = r.detail === 'low' || r.detail === 'high' || r.detail === 'original' || r.detail === 'auto' ? r.detail : undefined;
      out.push({ kind: 'image', ...base, ...(detail !== undefined ? { detail } : {}) });
      continue;
    }
    if (kind === 'video') { out.push({ kind: 'video', ...base }); continue; }
    if (kind === 'file') { out.push({ kind: 'file', ...base }); }
  }
  return out.length > 0 ? out : undefined;
}

/** 账本行（messages.jsonl 每行一 JSON） */
export interface LedgerRow {
  role: LedgerRole;
  /** v2 判别键（cr-974：message / context；存量 v1 行缺席——读侧按行判别归一） */
  type?: 'message' | 'context';
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
  /**
   * run 成因（cr-1238 B5）：run 行（run-end/步级）携带的机制维度——
   * viewer/timer/archive/subagent/bench/goal/job/interaction/mechanism。
   * 与 source 正交（拓扑 × 机制）；旧 run 行缺席——消费面反推降级。
   */
  origin?: string;
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
  /** 结构化载荷（cr-765 #4 起公共数据面；cr-1107 泛化：问答卡 Q/A /
   *  memory 水位 memoryBaseline 等按词携带——键域随 source 词开放） */
  payload?: Record<string, unknown>;
  /**
   * 多模态附件引用（cr-1278）：发言行的入站附件旁路——回放层还原为
   * LlmMessage.attachments（provider 边界物化），UI 刷新后恢复附件 chips。
   * 存量行缺席 = 无附件（向后兼容，零迁移）。
   */
  attachments?: LedgerAttachment[];
  /** 单调序号（writer 按文件分配——崩溃检测 + 去重锚） */
  seq?: number;
  /**
   * 投递标记（cr-1332 白名单词汇——IM 视图行集判据，落盘词）：
   *  通道投递入站/出站行 = true；终稿行 = 'final'（origin 门控——用户裁决
   *  独特值便于观察打标/不打标效果）；机制行/notice 转投/第三方写面缺省
   *  不打标（opt-in，宁漏不误）。读侧 im 档：会话内任一行有标 → 白名单
   *  模式（值直取）；零标存量会话 → 回退排除法。
   */
  delivered?: boolean | 'final';
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
  /**
   * 步内相位序（cr-946 / cr-804 回归修复）：true = 正文分片先于工具调用
   * 到达。渲染序契约（正文/工具卡相对序）由本标记定——缺省 = 工具先行。
   * 直播由前端自判，历史/刷新/收束重拉只能靠落盘值，故必须随步透传。
   */
  textBeforeTools?: boolean;
  /** 中止步标记（cr-766）——前端据此渲染中断态（部分正文 + 「已中断」） */
  aborted?: boolean;
  /** 思考相位时长（毫秒，cr-766——历史回放恢复「已思考 · XmYs」） */
  reasoningMs?: number;
  /** 正文相位时长（毫秒，cr-766） */
  textMs?: number;
  /** 步身份键（cr-772 落盘透传）——历史合并键控对齐（存量步投影缺席） */
  stepId?: string;
  /**
   * 步行 journal seq（B2 步级 seq 保留）：物化时随步透传——直播帧携带
   * runId+seq 后按步配对/去重的锚（「journal 步行 seq A → messages 段行
   * 重新 allocSeq 拿 seq B」的原 seq 在此保全；存量行缺席回落启发式）。
   * 跨 run 边界用 runId 分段；tool-result 补行仍按 toolCallId 合并、
   * 永不按 seq 排序（现状保持）。
   */
  seq?: number;
  /**
   * 本步 API 流时间（毫秒，cr-772）+ 步用量——历史链栏速率段数据源。
   * completion/elapsedMs 成对消费（输出口径速率 = Σcompletion/Σms）。
   */
  elapsedMs?: number;
  usage?: { prompt: number; completion: number; total?: number };
  ts?: number;
  toolCalls?: Array<{ id: string; name: string; arguments: string; result: unknown; subcall?: boolean; durationMs?: number }>;
}

/** 头行（writer 首建文件时写入；cr-974 起新建文件 version:2——
 *  v2 单文件事件日志，v1 存量头行永不重写） */
export interface LedgerHeader {
  type: 'session-header';
  version: 1 | 2;
  createdAt: string;
  /** participants（端点集合——D4.1 header.json 元数据并进首行） */
  participants: string[];
  /** 形态标记（user/agent/group/… 开放词汇） */
  kind: string;
  /** 升头继承键（M-A cr-1270）：迁移产物头携带 migratedFrom；过渡态
   *  旧头可能携带 migrated——splitHeader 白名单外全进 extra 原样继承 */
  migratedFrom?: number;
  migrated?: boolean;
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
   * 步内相位序（cr-946 / cr-804 回归修复）：LoopStepRecord 同名字段原样
   * 落盘（ac-agent-loop 产出）——读面 projectStep 随步透传，前端据此决定
   * 步内「正文 / 工具卡」相对渲染序。
   */
  textBeforeTools?: boolean;
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
  /** 结构化载荷（cr-765 #4 问答卡；cr-1107 泛化为公共数据面——键域随
   *  injectSource 词开放：durable-interaction = questions/answers/outcome、
   *  memory-* = memoryBaseline 等；旧行缺席 → 消费方各自回落） */
  payload?: Record<string, unknown>;
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
 * UsageRunMeter 同形（schema owning 在彼） */
import type { UsageRunMeter } from 'ac-envelope-core';
export type RunUsage = UsageRunMeter;

/** 行类型判别（读侧路由） */
export type JournalLine = JournalStep | JournalInject | JournalToolResult | JournalSettled;
