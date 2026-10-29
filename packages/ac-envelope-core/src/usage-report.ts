// ============================================================
// usage-report.ts —— usage 自报信 payload schema（cr-538；R2 ledger 行
//「usage 自报（journal 计量 + 事件信）」的事件信半边）
//
// run 收束时壳 → host 观察信（kind=receipt：不进 inbox 不激活——A4；
// per-agent D3 修订「宿主不再物理必经敏感操作，计量 = 子树自记 journal
// + 事件信投递（at-least-once + 幂等）」）。投递 = 邮局 ipc 帧
//（postReply 同款通道）；宿主收信面 requestId 幂等去重。
// uuid 键 = usage-<agentId>（每 agent 一条计量流——不复用会话 uuid：
// 邮局登记校验 participants 集合一致性，计量流接收方 host 非会话
// 参与者）。
// ============================================================
import type { Envelope } from './envelope.ts';
import { makeEnvelope } from './envelope.ts';

/** run 级用量聚合（主线 LoopRunUsage 形状——双轨制；两侧 type-only 认识，
 * owning 归 ac-agent-loop 契约，此处本地声明保持纯库零依赖） */
export interface UsageRunMeter {
  prompt: number;
  completion: number;
  total?: number;
  promptAccumulated: number;
  totalAccumulated?: number;
  cacheHit?: number;
  cacheMiss?: number;
  steps: number;
  elapsedMs?: number;
}

/** usage 自报信 payload（kind=receipt；形状对齐主线 UsageAuditLine——宿主聚合并恒等） */
export interface UsageReportPayload {
  subject: 'usage-run';
  /** 计量主体（本壳 agent id） */
  agent: string;
  /** 模型（run request.model） */
  model: string;
  /** run 收束词（settle finish） */
  finish: string;
  /** run 级用量聚合（LoopRunUsage 双轨原样） */
  usage: UsageRunMeter;
  /** 会话键 */
  conversationId: string;
  /** run id */
  runId: string;
  /** 步级缓存序列（有缓存数据步；主线 stepCache 同形。prompt = 本步请求
   *  真实上下文 token（cr-761 上下文占用实时驱动） */
  stepCache?: Array<{ ts: number; hit: number; miss: number; prompt?: number }>;
}

/** 步级缓存信 payload（cr-760 运行中实时性）：after-step 即发——宿主
 *  pendingTimelineMap 入账（conversationTimeline 拼接尾段），run 收束信
 *  （usage-run）到达后由正式记账接管去重（ts 严格大于判重既有语义）。 */
export interface UsageStepPayload {
  subject: 'usage-step';
  /** 计量主体（本壳 agent id） */
  agent: string;
  /** 会话键 */
  conversationId: string;
  /** run id */
  runId: string;
  /** 步序（run 内 0 起——requestId 幂等键组分） */
  step: number;
  ts: number;
  hit: number;
  miss: number;
  /** 本步请求真实上下文 token（LlmUsage.prompt——上下文占用实时信号，cr-761） */
  prompt?: number;
}

/** usage 计量流键（每 agent 一条流——宿主聚合并合并键） */
export function usageStreamKey(agentId: string): string {
  return 'usage-' + agentId;
}

/** 构造 usage 自报信封（壳 → host；run 收束信与步级缓存信共用通道） */
export function makeUsageEnvelope(input: {
  requestId: string;
  payload: UsageReportPayload | UsageStepPayload;
}): Envelope {
  return makeEnvelope({
    uuid: usageStreamKey(input.payload.agent),
    requestId: input.requestId,
    sender: input.payload.agent,
    to: 'host',
    kind: 'receipt',
    budget: 0,
    payload: input.payload,
  });
}

/** payload 结构校验（纯函数 fail-closed——宿主收信面用） */
export function validateUsagePayload(payload: unknown): string[] {
  const issues: string[] = [];
  const p = payload as Partial<UsageReportPayload> & Partial<UsageStepPayload> | null;
  if (p === null || typeof p !== 'object') return ['payload 非对象'];
  const subject: unknown = p.subject;
  if (subject !== 'usage-run' && subject !== 'usage-step') issues.push('subject 非 usage-run/usage-step');
  if (typeof p.agent !== 'string' || p.agent.length === 0) issues.push('agent 缺席');
  if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) issues.push('conversationId 缺席');
  if (typeof p.runId !== 'string' || p.runId.length === 0) issues.push('runId 缺席');
  if (subject === 'usage-step') {
    if (typeof p.step !== 'number') issues.push('step 缺席');
    if (typeof p.ts !== 'number') issues.push('ts 缺席');
    if (typeof p.hit !== 'number') issues.push('hit 缺席');
    if (typeof p.miss !== 'number') issues.push('miss 缺席');
    return issues;
  }
  if (typeof p.model !== 'string') issues.push('model 缺席');
  if (typeof p.finish !== 'string') issues.push('finish 缺席');
  const u = p.usage as Partial<UsageRunMeter> | undefined;
  if (u === undefined
    || typeof u.prompt !== 'number' || typeof u.completion !== 'number'
    || typeof u.promptAccumulated !== 'number' || typeof u.steps !== 'number') {
    issues.push('usage 聚合字段缺失');
  }
  return issues;
}

/** 信封是否 usage 自报（宿主收信面分流——run 收束信与步级缓存信） */
export function isUsageReport(env: Envelope): boolean {
  if (env.kind !== 'receipt') return false;
  const s = (env.payload as { subject?: unknown } | null)?.subject;
  return s === 'usage-run' || s === 'usage-step';
}