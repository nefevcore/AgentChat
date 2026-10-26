// ============================================================
// ac-wire-format/src/bridge-events.ts —— 事件桥接目录（cr-108）
//
// 问题：emit 面 → 前端帧的桥接策略（后台过滤/群 hint 过滤/载荷整形）曾内联
// 在 ws-bridge 的监听器里；remote-link 另持 13 事件白名单转发原始 args——
// 两链走散（手机端缺群消息/决策卡/列表刷新等 29 种事件，且 durable-interaction
// 载荷不同构）。
//
// 本目录是两条下行链路的**同源桥接策略层**（零 cordis、零域依赖——过滤判定
// 经 CatalogDeps 注入，域词汇留在各域包）：
//   · createBridgeCatalog(deps)：目录工厂（每链路一份实例——后台过滤登记表
//     随实例走，互不串扰）；
//   · 每项 { name, wire(args) }：wire 返回 undefined = 过滤本帧，否则为
//     整形后的帧 args；
//   · llm/delta 家族标记 kind:'delta'——批器是消费侧性能机制（30ms 微批
//     实例独立），目录只声明投影（wireLlmInput）；
//   · waterfall 事件（before-*/transform-*）不在目录——拦截链不是广播面
//     （挂上等于静默 veto 下游默认行为，2026-09-26 事故）。
// ============================================================
import { wireLlmInput } from './index.ts';

/** 桥接目录项（wire = 单帧策略：整形或过滤） */
export interface BridgeEvent {
  /** 事件名（= 帧 type 直转） */
  name: string;
  /** llm/delta 家族：消费侧批器接管（首帧投影经 wire，见 createBridgeCatalog） */
  kind?: 'delta';
  /** 单帧策略：返回 undefined = 过滤；否则为帧 args */
  wire?: (args: unknown[]) => unknown[] | undefined;
}

/** 过滤判定注入（域词汇留各域包——本纯库不 import 域依赖） */
export interface CatalogDeps {
  /** 后台来源判定（source 为后台机制来源 = 候选隐藏） */
  isBackgroundSender: (source: string | undefined) => boolean;
  /** 归档整理 run 判定（meta[archive-review]——维护 run 恒隐藏）；meta 为事件原参（宽容形状） */
  isArchiveReviewRun: (meta: Record<string, unknown> | undefined) => boolean;
  /** 群 hint 判定（hint 信封不进前端——群内容唯一源 = message-posted 的 post 行）；meta 形状宽容 */
  isGroupHint: (meta: Record<string, unknown> | undefined) => boolean;
  /** 后台过滤开关（缺省开；诊断用可关） */
  backgroundFilter?: boolean;
}

/** 自会话桶判定（a~a 对角线）：定时自唤醒等机制 run 的隐藏面 */
function isSelfPairConversation(conversationId: string | undefined): boolean {
  if (!conversationId || !conversationId.includes('~')) return false;
  const [a, b] = conversationId.split('~');
  return a === b;
}

/** run 寻址 key（tool 级事件的 sender 兜底查询） */
function runKey(agent: string | undefined, conversationId: string | undefined): string {
  return `${agent ?? ''}|${conversationId ?? ''}`;
}

/** durable-interaction wire 整形（M7 §二B：ask_questions payload.questions 上提顶层） */
interface WireQuestions {
  questions: Array<{ question: string; options: string[]; multi?: boolean }>;
}
function interactionWire(record: unknown): unknown {
  if (record === null || typeof record !== 'object') return record;
  const r = record as Record<string, unknown>;
  if (
    r.kind === 'ask_questions' && r.payload !== null &&
    typeof r.payload === 'object' &&
    Array.isArray((r.payload as WireQuestions).questions)
  ) {
    const { payload, ...rest } = r;
    void payload;
    return { ...rest, questions: (r.payload as WireQuestions).questions };
  }
  return record;
}

/** 目录实例（后台过滤登记表随实例；wire 策略见 buildCatalog） */
export interface BridgeCatalog {
  events: BridgeEvent[];
  /** 后台过滤开关（缺省开） */
  readonly backgroundFilter: boolean;
}

export function createBridgeCatalog(deps: CatalogDeps): BridgeCatalog {
  const filterEnabled = deps.backgroundFilter !== false;

  /** run 级隐藏判定：机制来源（source=event）的 run 只在【自会话桶 a~a】与
   * 【归档整理 meta[archive-review]】隐藏流式帧；用户可见会话里的机制唤醒
   * （job 通知/插件回触/重载续跑/ask_questions 晚到回答）照常广播。
   * user/agent 来源恒可见。 */
  function isHiddenRun(
    source: string | undefined,
    conversationId: string | undefined,
    meta: Record<string, unknown> | undefined,
  ): boolean {
    if (!filterEnabled) return false;
    if (!deps.isBackgroundSender(source)) return false;
    if (deps.isArchiveReviewRun(meta)) return true;
    return isSelfPairConversation(conversationId);
  }

  /** run 级隐藏登记（run-started 判定一次；tool 级事件无 source 载荷查表；
   *  未登记（桥接中途装载等）退回逐帧判定） */
  const hiddenRuns = new Map<string, boolean>();
  const hiddenOf = (
    agent: string | undefined,
    conversationId: string | undefined,
    source: string | undefined,
  ): boolean => hiddenRuns.get(runKey(agent, conversationId))
    ?? isHiddenRun(source, conversationId, undefined);

  /** run 边界登记/清除（边界事件恒广播——前端渲染分隔符需要边界可见） */
  const registerRun = (agent: string | undefined, conversationId: string | undefined, source: string | undefined, meta: Record<string, unknown> | undefined): void => {
    hiddenRuns.set(runKey(agent, conversationId), isHiddenRun(source, conversationId, meta));
  };
  const clearRun = (agent: string | undefined, conversationId: string | undefined): void => {
    hiddenRuns.delete(runKey(agent, conversationId));
  };

  const deltaHidden = (input: unknown, meta: unknown): boolean => {
    const i = input as { meta?: { agent?: string; conversationId?: string; source?: string } } | undefined;
    const m = meta as { agent?: string; conversationId?: string; source?: string } | undefined;
    return hiddenOf(
      m?.agent ?? i?.meta?.agent,
      m?.conversationId ?? i?.meta?.conversationId,
      m?.source ?? i?.meta?.source,
    );
  };

  const events: BridgeEvent[] = [
    // ── L1 llm：流式细分（run 级隐藏登记查表，缺省逐帧判定） ──
    { name: 'llm/chat-error', wire: (a) => a },
    { name: 'llm/delta-start', kind: 'delta', wire: ([input, meta]) => (deltaHidden(input, meta) ? undefined : [wireLlmInput(input), meta]) },
    { name: 'llm/delta', kind: 'delta', wire: ([input, chunk, meta]) => (deltaHidden(input, meta) ? undefined : [wireLlmInput(input), chunk, meta]) },
    { name: 'llm/delta-end', kind: 'delta', wire: ([input, meta]) => (deltaHidden(input, meta) ? undefined : [wireLlmInput(input), meta]) },
    // ── 工具执行通知（无 sender 载荷 → run 登记表判定） ──
    { name: 'tool/started', wire: ([call]) => {
      const c = call as { agentId?: string; conversationId?: string } | undefined;
      return hiddenOf(c?.agentId, c?.conversationId, undefined) ? undefined : [call];
    } },
    { name: 'tool/after-execute', wire: (a) => {
      const c = a[0] as { agentId?: string; conversationId?: string } | undefined;
      return hiddenOf(c?.agentId, c?.conversationId, undefined) ? undefined : a;
    } },
    { name: 'tool/progress', wire: ([call, chunk]) => {
      const c = call as { agentId?: string; conversationId?: string } | undefined;
      return hiddenOf(c?.agentId, c?.conversationId, undefined) ? undefined : [call, chunk];
    } },
    // ── L2 loop：run 边界广播不过滤（登记/清表）；step 级按 envelope ──
    { name: 'loop/run-started', wire: ([request]) => {
      const r = request as { agent?: string; conversationId?: string; source?: string; meta?: Record<string, unknown> } | undefined;
      registerRun(r?.agent, r?.conversationId, r?.source, r?.meta);
      return [request];
    } },
    { name: 'loop/step-started', wire: (a) => {
      const envelope = a[3] as { conversationId?: string; source?: string } | undefined;
      return hiddenOf(a[0] as string, envelope?.conversationId, envelope?.source) ? undefined : a;
    } },
    { name: 'loop/after-step', wire: (a) => {
      const envelope = a[2] as { conversationId?: string; source?: string } | undefined;
      return hiddenOf(a[0] as string, envelope?.conversationId, envelope?.source) ? undefined : a;
    } },
    { name: 'loop/after-run', wire: ([request, result]) => {
      const r = request as { agent?: string; conversationId?: string } | undefined;
      clearRun(r?.agent, r?.conversationId);
      return [request, result]; // 边界事件：隐藏 run 也广播
    } },
    // ── L3 router / conversation / group ──
    { name: 'router/message-received', wire: ([agentId, message, conversationId, sender, source, meta]) =>
      (deps.isGroupHint(meta as Record<string, unknown> | undefined) ? undefined : [agentId, message, conversationId, sender, source]) },
    { name: 'router/reply-completed', wire: (a) => a },
    { name: 'conversation/steered', wire: ([agentId, message, conversationId, handle, sender, source, meta]) =>
      (deps.isGroupHint(meta as Record<string, unknown> | undefined) ? undefined : [agentId, message, conversationId, handle, sender, source]) },
    { name: 'conversation/queue-changed', wire: (a) => a },
    { name: 'session/context-injected', wire: (a) => a },
    { name: 'session/run-settled', wire: (a) => a },
    { name: 'group/created', wire: (a) => a },
    { name: 'group/deleted', wire: (a) => a },
    { name: 'group/renamed', wire: (a) => a },
    { name: 'group/description-set', wire: (a) => a },
    { name: 'group/member-added', wire: (a) => a },
    { name: 'group/member-removed', wire: (a) => a },
    { name: 'group/message-posted', wire: (a) => a },
    // ── 持久化 / 任务 / 交互 ──
    { name: 'config/changed', wire: (a) => a },
    { name: 'job/started', wire: (a) => a },
    { name: 'job/settled', wire: (a) => a },
    { name: 'durable-interaction/opened', wire: ([payload]) => [interactionWire(payload)] },
    { name: 'durable-interaction/replied', wire: (a) => a },
    { name: 'durable-interaction/closed', wire: (a) => a },
    { name: 'archive/completed', wire: (a) => a },
    { name: 'agents/updated', wire: (a) => a },
    { name: 'singles/updated', wire: (a) => a },
    { name: 'subagents/updated', wire: (a) => a },
    { name: 'remote/device-paired', wire: (a) => a },
    { name: 'remote/device-revoked', wire: (a) => a },
    { name: 'remote/device-online', wire: (a) => a },
    { name: 'remote/device-offline', wire: (a) => a },
    { name: 'plugin/updated', wire: (a) => a },
    { name: 'webui/extensions-changed', wire: (a) => a },
    { name: 'webui/boot-graph-changed', wire: (a) => a },
    { name: 'system/restarting', wire: (a) => a },
  ];

  return { events, backgroundFilter: filterEnabled };
}
