// ============================================================
// ac-ws-bridge —— WS 事件桥接订阅行（地图 §3.3：WSHandler 的桥接半边）
//
// src WSHandler 的 preview 形态：**零业务状态**——不 inject 任何业务服务，
// 只做 ctx.on(emit 面) → ctx.webServer.broadcast(type=事件名, {args})。
//
//   · 桥接词汇：帧 type = 事件名直转（机器可读事件目录即协议目录）；
//     帧载荷 { args: [...] }（事件参数序同名目录，前端按目录解构）
//   · waterfall 事件（before-*/transform-*）绝不桥——拦截链不是广播面
//   · 后台会话过滤（src backgroundSessionCids 的无状态化）：
//     - 事件自带 source 载荷（llm/delta-* 的 meta、loop/step-* 的
//       envelope）→ 逐事件独立判定（同一 run 的 source 恒定）
//     - tool/after-execute 无 source 载荷 → 查 run 边界登记表
//       （run-started 登记 agent|convId→source、after-run 清除——
//       纯派生缓存，非业务状态）
//     - 边界事件（run-started/after-run）不过滤（src 同款：前端渲染
//       分隔符需要边界可见）
//   · 摘行即静默：桥接面消失，webServer 与事件源互不影响
// ============================================================
import type { Context } from '@agentchat/cordis';
import { isBackgroundSender } from 'ac-ws-protocol';

// 桥接面类型增强（type-only；运行时零依赖——只经 ctx.on 订阅）
import type {} from 'ac-llm';
import type {} from 'ac-tools';
import type {} from 'ac-agent-loop';
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
  /** run-started 登记 / after-run 清除的 source 拓扑词派生缓存 */
  const backgroundRuns = new Map<string, string>();

  const isBackground = (source: string | undefined): boolean =>
    filterEnabled && isBackgroundSender(source);

  /** 无 source 载荷的事件（tool/*）：按 run 登记表判定 */
  const registeredBackground = (agent: string | undefined, conversationId: string | undefined): boolean => {
    if (!filterEnabled) return false;
    if (conversationId !== undefined) {
      return backgroundRuns.get(runKey(agent, conversationId)) === 'event';
    }
    // 无会话键（机制 run）：任一同 agent 的后台登记即视为后台
    for (const [key, source] of backgroundRuns) {
      if (source === 'event' && key.startsWith(`${agent ?? ''}|`)) return true;
    }
    return false;
  };

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

  // ============ L1 llm：流式细分（meta 载荷自判后台） ============
  fwd('llm/chat-error', (input, error) => forward('llm/chat-error', input, error));
  fwd('llm/delta-start', (input, meta) => {
    if (isBackground(meta?.source)) return;
    forward('llm/delta-start', input, meta);
  });
  fwd('llm/delta', (input, chunk, meta) => {
    if (isBackground(meta?.source)) return;
    forward('llm/delta', input, chunk, meta);
  });
  fwd('llm/delta-end', (input, meta) => {
    if (isBackground(meta?.source)) return;
    forward('llm/delta-end', input, meta);
  });

  // ============ 工具执行通知（无 sender 载荷 → 登记表兜底） ============
  fwd('tool/after-execute', (call, result, error) => {
    if (registeredBackground(call.agentId, call.conversationId)) return;
    forward('tool/after-execute', call, result, error);
  });
  // 工具流式进度（M7）：与 after-execute 同一过滤语义（run 登记表兜底）
  fwd('tool/progress', (call, chunk) => {
    if (registeredBackground(call.agentId, call.conversationId)) return;
    forward('tool/progress', call, chunk);
  });

  // ============ L2 loop：run 边界广播不过滤；step 级按 envelope ============
  fwd('loop/run-started', (request) => {
    backgroundRuns.set(runKey(request.agent, request.conversationId), request.source ?? 'user');
    forward('loop/run-started', request);
  });
  fwd('loop/step-started', (agent, index, messages, envelope) => {
    if (isBackground(envelope?.source)) return;
    forward('loop/step-started', agent, index, messages, envelope);
  });
  fwd('loop/after-step', (agent, step, envelope) => {
    if (isBackground(envelope?.source)) return;
    forward('loop/after-step', agent, step, envelope);
  });
  fwd('loop/after-run', (request, result) => {
    backgroundRuns.delete(runKey(request.agent, request.conversationId));
    forward('loop/after-run', request, result); // 边界事件：后台 run 也广播
  });

  // ============ L3 router / conversation / group ============
  fwd('router/message-received', (agentId, message, conversationId, sender, source) =>
    forward('router/message-received', agentId, message, conversationId, sender, source));
  fwd('router/reply-completed', (agentId, text, result, conversationId, sender, source) =>
    forward('router/reply-completed', agentId, text, result, conversationId, sender, source));
  fwd('conversation/steered', (agentId, message, conversationId, handle, sender, source) =>
    forward('conversation/steered', agentId, message, conversationId, handle, sender, source));
  fwd('group/created', (group) => forward('group/created', group));
  fwd('group/deleted', (groupId, group) => forward('group/deleted', groupId, group));
  fwd('group/renamed', (groupId, name, group) => forward('group/renamed', groupId, name, group));
  fwd('group/member-added', (groupId, agentId, group) =>
    forward('group/member-added', groupId, agentId, group));
  fwd('group/member-removed', (groupId, agentId, group) =>
    forward('group/member-removed', groupId, agentId, group));
  fwd('group/message-posted', (groupId, message) =>
    forward('group/message-posted', groupId, message));

  // ============ 持久化 / 任务 / 交互 ============
  fwd('config/changed', (path) => forward('config/changed', path));
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
