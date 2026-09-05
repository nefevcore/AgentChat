// ============================================================
// ac-ws-bridge —— WS 事件桥接订阅行（地图 §3.3：WSHandler 的桥接半边）
//
// src WSHandler 的 preview 形态：**零业务状态**——不 inject 任何业务服务，
// 只做 ctx.on(emit 面) → ctx.webServer.broadcast(type=事件名, {args})。
//
//   · 桥接词汇：帧 type = 事件名直转（机器可读事件目录即协议目录）；
//     帧载荷 { args: [...] }（事件参数序同名目录，前端按目录解构）
//   · waterfall 事件（before-*/transform-*）绝不桥——拦截链不是广播面
//   · 后台会话过滤（2026-09-02 反馈精化——run 级判定，run-started 登记）：
//     - 机制来源（source='event'）的 run 只在【自会话桶 a~a】与【归档
//       整理（meta[archive-review]）】隐藏流式帧；用户可见会话里的机制
//       唤醒（job 通知/插件回触/重载续跑）照常流式广播
//     - 事件自带 source 载荷（llm/delta-* 的 meta、loop/step-* 的
//       envelope）→ 逐帧独立判定（同一 run 的 source 恒定）
//     - tool/after-execute 无 source 载荷 → 查 run 登记表
//       （run-started 登记、after-run 清除——纯派生缓存，非业务状态）
//     - 边界事件（run-started/after-run）不过滤（src 同款：前端渲染
//       分隔符需要边界可见）
//   · 摘行即静默：桥接面消失，webServer 与事件源互不影响
// ============================================================
import type { Context } from '@agentchat/cordis';
import { isArchiveReviewRun } from 'ac-agent-loop';
import { isGroupHint } from 'ac-core-utils';
import { isBackgroundSender } from 'ac-ws-protocol';

// 桥接面类型增强（type-only；运行时零依赖——只经 ctx.on 订阅）
import type {} from 'ac-llm';
import type {} from 'ac-tools';
import type {} from 'ac-router';
import type {} from 'ac-conversation';
import type {} from 'ac-group';
import type {} from 'ac-config';
import type {} from 'ac-jobs';
import type {} from 'ac-durable-interaction';
import type {} from 'ac-plugin-registry';
import type {} from 'ac-webui';
import type {} from 'ac-archive';
import type {} from 'ac-agents';
import type {} from 'ac-restart';

export const name = 'ac-ws-bridge';

// ── 扩展自述（A1 注册制目录：ac-web-api 扫 cordis registry 读取本声明——插件清单 label 数据源）──
import type { ExtensionMeta } from 'ac-extension-core';
export const extension: ExtensionMeta = {
  name: 'ws-bridge',
  label: 'WS 事件桥',
  description: 'emit 面 → WS 帧桥接（router/*、loop/*、llm/delta-* 等事件流转发前端）',
  automatic: true,
};

export const inject = ['webServer'];

export interface WsBridgeRowOptions {
  /**
   * 后台会话过滤开关（缺省开）。关闭时全部事件广播（诊断用）。
   */
  backgroundFilter?: boolean;
}

/** run 边界登记 key（tool 级事件的 sender 兜底查询） */
function runKey(agent: string | undefined, conversationId: string | undefined): string {
  return `${agent ?? ''}|${conversationId ?? ''}`;
}

export function apply(ctx: Context, options: WsBridgeRowOptions = {}) {
  const filterEnabled = options.backgroundFilter !== false;

  /** run 寻址 key（run 级隐藏登记） */
  function runKey(agent: string | undefined, conversationId: string | undefined): string {
    return `${agent ?? ''}|${conversationId ?? ''}`;
  }

  /** 自会话桶判定（a~a 对角线）：定时自唤醒等机制 run 的隐藏面 */
  function isSelfPairConversation(conversationId: string | undefined): boolean {
    if (!conversationId || !conversationId.includes('~')) return false;
    const [a, b] = conversationId.split('~');
    return a === b;
  }

  /**
   * run 级隐藏判定（2026-09-02 反馈修正）：机制来源（source='event'）的
   * run 只在【自会话桶 a~a】与【归档整理（meta[archive-review]，维护 run）】
   * 隐藏流式帧——其余机制唤醒（job 完成通知、插件回执回触、reload 续跑、
   * ask_questions 晚到回答）如今都发生在用户可见会话（a⇋b / 群 / singles），
   * 必须流式广播。此前按 source 一刀切隐藏：表现为"回执可见但 Agent 运行
   * 隐形，不刷新看不到流式推理"。user/agent 来源恒可见（原语义不变）。
   */
  const isHiddenRun = (
    source: string | undefined,
    conversationId: string | undefined,
    meta: Record<string, unknown> | undefined,
  ): boolean => {
    if (!filterEnabled) return false;
    if (!isBackgroundSender(source)) return false;
    if (isArchiveReviewRun(meta)) return true;
    return isSelfPairConversation(conversationId);
  };

  /** run 级登记（run-started 判定一次；tool 级事件无 source 载荷查表；
   *  未登记（桥接中途装载等）退回逐帧判定） */
  const hiddenRuns = new Map<string, boolean>();
  const hiddenOf = (
    agent: string | undefined,
    conversationId: string | undefined,
    source: string | undefined,
  ): boolean => hiddenRuns.get(runKey(agent, conversationId)) ?? isHiddenRun(source, conversationId, undefined);

  // ---- 通用转发：帧载荷 { args: [...] } ----
  const forward = (name: string, ...args: unknown[]) => {
    ctx.webServer.broadcast(name, { args });
  };

  /** 统一桥接注册：ctx.on 包装——自动附监听器描述（事件视图叶节点/治理面透出）。
   *  类型面 = Context['on'] 原签名（调用点保留事件名 → 监听器参数推断）。 */
  const fwd: Context['on'] = ((name: unknown, listener: unknown) =>
    ctx.on(name as never, listener as never, {
      description: `WS 桥接：转发 ${String(name)} 为前端帧（后台会话过滤）`,
    })) as Context['on'];

  // ---- interaction wire 整形（M7 §二B：record → 前端友好形） ----
  // ask_questions：payload.questions 上提为顶层 questions（已整形
  // question/options）；其余 kind 原样透传（含 payload）。帧载荷仍是
  // { args: [wire] }——与全部业务帧同构。
  interface WireQuestions {
    questions: Array<{ question: string; options: string[] }>;
  }
  const interactionWire = (record: unknown): unknown => {
    if (record === null || typeof record !== 'object') return record;
    const r = record as Record<string, unknown>;
    if (
      r.kind === 'ask_questions' &&
      r.payload !== null &&
      typeof r.payload === 'object' &&
      Array.isArray((r.payload as WireQuestions).questions)
    ) {
      const { payload, ...rest } = r;
      void payload;
      return { ...rest, questions: (r.payload as WireQuestions).questions };
    }
    return record;
  };

  // ============ L1 llm：流式细分（run 级隐藏登记查表，缺省逐帧判定） ============
  // 帧载荷瘦身（2026-09-05 OOM 事故）：事件载荷 input 携带完整 messages/
  // tools（会话全量上下文，长会话可达 MB 级），而 delta 帧以 chunk 频率广播
  // ——全量直转 = O(历史 × chunk 数) 的载荷放大（实测 ~1MB × 50-100
  // chunk/s，慢消费端把 ws 发送队列滞留成 4GB 活对象 → 后端 OOM）。
  // 帧面只保留前端实际消费的字段：model（展示）+ meta（feed 主路径读
  // 独立 meta 参，此为 input.meta 兜位的同源对象）。进程内事件契约不变
  // （ac-session/CLI 等仍见全量 input）；频率有界的 llm/chat-error 维持
  // 直转（前端经 input.meta 路由，瘦身后无独立 meta 参可回落）。
  const wireLlmInput = (input: unknown): unknown =>
    input && typeof input === 'object'
      ? { model: (input as { model?: unknown }).model, meta: (input as { meta?: unknown }).meta }
      : input;
  fwd('llm/chat-error', (input, error) => forward('llm/chat-error', input, error));
  fwd('llm/delta-start', (input, meta) => {
    if (hiddenOf(meta?.agent ?? input?.meta?.agent, meta?.conversationId ?? input?.meta?.conversationId, meta?.source ?? input?.meta?.source)) return;
    forward('llm/delta-start', wireLlmInput(input), meta);
  });
  fwd('llm/delta', (input, chunk, meta) => {
    if (hiddenOf(meta?.agent ?? input?.meta?.agent, meta?.conversationId ?? input?.meta?.conversationId, meta?.source ?? input?.meta?.source)) return;
    forward('llm/delta', wireLlmInput(input), chunk, meta);
  });
  fwd('llm/delta-end', (input, meta) => {
    if (hiddenOf(meta?.agent ?? input?.meta?.agent, meta?.conversationId ?? input?.meta?.conversationId, meta?.source ?? input?.meta?.source)) return;
    forward('llm/delta-end', wireLlmInput(input), meta);
  });

  // ============ 工具执行通知（无 sender 载荷 → run 登记表判定） ============
  fwd('tool/after-execute', (call, result, error) => {
    if (hiddenOf(call.agentId, call.conversationId, undefined)) return;
    forward('tool/after-execute', call, result, error);
  });
  // 工具流式进度（M7）：与 after-execute 同一过滤语义（run 登记表）
  fwd('tool/progress', (call, chunk) => {
    if (hiddenOf(call.agentId, call.conversationId, undefined)) return;
    forward('tool/progress', call, chunk);
  });

  // ============ L2 loop：run 边界广播不过滤；step 级按 envelope ============
  fwd('loop/run-started', (request) => {
    hiddenRuns.set(runKey(request.agent, request.conversationId), isHiddenRun(request.source, request.conversationId, request.meta));
    forward('loop/run-started', request);
  });
  fwd('loop/step-started', (agent, index, messages, envelope) => {
    if (hiddenOf(agent, envelope?.conversationId, envelope?.source)) return;
    forward('loop/step-started', agent, index, messages, envelope);
  });
  fwd('loop/after-step', (agent, step, envelope) => {
    if (hiddenOf(agent, envelope?.conversationId, envelope?.source)) return;
    forward('loop/after-step', agent, step, envelope);
  });
  fwd('loop/after-run', (request, result) => {
    hiddenRuns.delete(runKey(request.agent, request.conversationId));
    forward('loop/after-run', request, result); // 边界事件：隐藏 run 也广播
  });

  // ============ L3 router / conversation / group ============
  // 群 hint 投递触发器不进前端（M26 同口径——ac-session 不入账/视图不投影）：
  // 群内容唯一源 = group/message-posted 的 post 行。曾致前端等待群回复时把
  // 逐成员 hint 信封渲染成 N-1 条 <msg>…</msg>[当前时间] 幽灵消息（刷新即
  // 消失——与落盘历史无对应）。
  fwd('router/message-received', (agentId, message, conversationId, sender, source, meta) => {
    if (isGroupHint(meta)) return;
    forward('router/message-received', agentId, message, conversationId, sender, source);
  });
  fwd('router/reply-completed', (agentId, text, result, conversationId, sender, source) =>
    forward('router/reply-completed', agentId, text, result, conversationId, sender, source));
  fwd('conversation/steered', (agentId, message, conversationId, handle, sender, source, meta) => {
    if (isGroupHint(meta)) return; // 同上（busy 成员的群 hint steer 注入）
    forward('conversation/steered', agentId, message, conversationId, handle, sender, source);
  });
  // next-turn 队列权威快照（排队 UI 数据面；载荷含 agentId+conversationId
  // → 前端 routeDialog 分区路由，无需另设过滤）
  fwd('conversation/queue-changed', (agentId, conversationId, handle, items) =>
    forward('conversation/queue-changed', agentId, conversationId, handle, items));
  fwd('group/created', (group) => forward('group/created', group));
  fwd('group/deleted', (groupId, group) => forward('group/deleted', groupId, group));
  fwd('group/renamed', (groupId, name, group) => forward('group/renamed', groupId, name, group));
  // 群简介变更：description = string | undefined（undefined = 清空）
  fwd('group/description-set', (groupId, description, group) =>
    forward('group/description-set', groupId, description, group));
  fwd('group/member-added', (groupId, agentId, group) =>
    forward('group/member-added', groupId, agentId, group));
  fwd('group/member-removed', (groupId, agentId, group) =>
    forward('group/member-removed', groupId, agentId, group));
  // 群主（记忆属主）变更：owner = string | undefined（undefined = 解除）
  fwd('group/memory-owner-set', (groupId, owner, group) =>
    forward('group/memory-owner-set', groupId, owner, group));
  fwd('group/message-posted', (groupId, message) =>
    forward('group/message-posted', groupId, message));

  // ============ 持久化 / 任务 / 交互 ============
  fwd('config/changed', (path) => forward('config/changed', path));
  fwd('job/started', (job) => forward('job/started', job));
  fwd('job/settled', (job) => forward('job/settled', job));
  fwd('durable-interaction/opened', (payload) =>
    forward('durable-interaction/opened', interactionWire(payload)));
  fwd('durable-interaction/replied', (payload) => forward('durable-interaction/replied', payload));
  fwd('durable-interaction/closed', (payload) => forward('durable-interaction/closed', payload));
  // ============ M7：归档完成 / Agent 档案变更 ============
  fwd('archive/completed', (payload) => forward('archive/completed', payload));
  fwd('agents/updated', (config, change) => forward('agents/updated', config, change));
  // ============ M18-G：独立会话元数据变更（前端 singles 列表刷新） ============
  fwd('singles/updated', (meta, action) => forward('singles/updated', meta, action));

  // ============ M13：插件域 / Web UI 域 ============
  fwd('plugin/installed', (summary) => forward('plugin/installed', summary));
  fwd('plugin/reloaded', (info) => forward('plugin/reloaded', info));
  fwd('plugin/catalog-changed', (payload) => forward('plugin/catalog-changed', payload));
  fwd('webui/extensions-changed', (payload) => forward('webui/extensions-changed', payload));

  // ============ M17：系统重启受理通知 ============
  fwd('system/restarting', (reason) => forward('system/restarting', reason));
}
