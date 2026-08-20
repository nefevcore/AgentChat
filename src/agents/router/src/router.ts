// ============================================================
// src/agents/router.ts —— 电话交换机（L2 调度核心）
//
// 核心职责：
//   1. 消息分发：根据 message.to 从注册表取配置 → 装配 ctx → loop.run
//   2. steer 注入决策：同会话（convKey）运行中 → pushSteer 到活跃 ctx，
//      不新开 run（对应架构文档「队列内化为 per-conv runningMap + steer」）
//   3. 虚拟 Agent（user 端点）路由：不走 LLM
//   4. correlation_id 透传（会话/事件关联用，L5 WS 层消费；不做去重/跳数防护）
//   5. 关机模式（shutdown）：进入后新消息入 pending 队列（内存），L4 supervisor 落盘/重启后 flush
//   6. 群组消息：内置 GroupManager（构造自动接线 group.trigger）并委托投递
//   7. 事件面：'message.received'（入站消息）+ 群组事件（见类上方事件表）
//
// 路由模型（重构后）：
//   input(receive | trigger) → lifecycleGate(live | shutdown)
//     → route(target × delivery × placement)
//   · target：agent_id / '*'（广播）/ group_id
//   · delivery：await / fire-and-forget（仅 receive 可 await；trigger 永远 fire-and-forget）
//   · placement：steer / next-run（submit() 唯一决策点）
//
// 已移除（相对旧实现）：网络失效模式（down 队列 + base_url 探测）——
//   LLM 异常由 L1 fallbackHook 捕捉，run 永不抛给调用方，无需 router 级兜底。
//
// 依赖方向：仅依赖 src/core 与本层 config/registry/group/virtual-agent（相对导入）。
// ============================================================

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { CurrentContext } from '@agentchat/agent-loop';
import { CHAT_START_META_KEY, GROUP_SYNC_META_KEY, GROUP_CONTRACT_TEXT } from '@agentchat/contracts';
import type { MessageInbox, RunStartMeta, GroupFeed, GroupFeedAnchor } from '@agentchat/contracts';
import { createLogger } from '@agentchat/util';
import type { AgentMessage, DeliveryLane, MessageDelivery, MessageSource, MessageSourceKind } from '@agentchat/types';
import type { AgentConfig } from '@agentchat/agent-config';
import { groupContractTextOf } from '@agentchat/agent-config';
import type { AgentAssembly } from '@agentchat/agents';
import { createAgentContext } from '@agentchat/agents';
import { AgentRegistry } from '@agentchat/agents';
import { GroupManager } from './group';
import type { GroupMessage } from './group';
import { chatDialogKey, groupDialogKey, singleDialogKey, counterpartOfDialog, DIALOG_SEP, wrapGroupMsg } from '@agentchat/agents';

/** 群消息投递模式选项（单通道化 v3，docs/group-single-channel-design.md §2.3-2.4；boot 从全局配置读取后注入） */
export interface RouterGroupDeliveryOptions {
  /** 群消息内容通道实现（GroupService；boot 装配后绑定） */
  groupFeed?: GroupFeed;
  /** legacy = 现行 hint 双通道；notify = 纯通知 + 本体读取（默认 legacy，可安全回滚） */
  delivery?: 'legacy' | 'notify';
  /** notify 模式触发消息位置 A/B 变量：tail（currentMessage 携带全文）| history（全文留在历史） */
  deliveryVariant?: 'tail' | 'history';
}

const log = createLogger('[agents:router]');

/**
 * run 结束后因 next-turn 自动连跑的最大次数（仅系统/自主来源：
 * timer/group/continue/restart/archive）。用户或 Agent 发来的消息不受限。
 * 防"完成→自触发→再完成"的自激链（对齐 DSH maxConsecutiveWakes 思想）。
 */
const MAX_AUTO_WAKES = 3;

/** 是否为自主触发来源（受自动连跑预算约束） */
function isAutonomousSource(source?: MessageSource): boolean {
  return !!source && source.kind !== 'user' && source.kind !== 'agent';
}

// ============================================================
// 路由协议类型（电话模式）
// ============================================================

/** 内部消息类型：路由协议 + 流式输出 + 系统/文件/房间类 */
export type AgentMessageType =
  // 路由协议
  | 'request' | 'response' | 'broadcast'
  // 聊天流式输出
  | 'chat.send' | 'chat.interrupt'
  | 'chat.start' | 'chat.end'
  | 'chat.step.start' | 'chat.step.end' | 'chat.step.steered'
  | 'chat.message.start' | 'chat.message.update' | 'chat.message.end' | 'chat.message.error'
  | 'chat.thinking.start' | 'chat.thinking.update' | 'chat.thinking.end'
  | 'chat.toolcall.start' | 'chat.toolcall.update' | 'chat.toolcall.end'
  | 'chat.tool_execution.start' | 'chat.tool_execution.update' | 'chat.tool_execution.end'
  // 系统类
  | 'agent.list' | 'agent.list.response'
  | 'history.request' | 'history.response'
  // 文件类
  | 'file.upload' | 'file.upload.progress' | 'file.upload.complete'
  // 房间类
  | 'group.create' | 'group.message' | 'group.join' | 'group.leave'
  | 'group.list' | 'group.list.response'
  | 'group.history.request' | 'group.history.response'
  // 虚拟 Agent 消息实时推送
  | 'chat.virtual.receive'
  // 自主推理触发（内部使用）
  | 'trigger';

/** 会话繁忙时的投递策略 */
export type BusyPlacement = 'steer' | 'next-run';

/** 内部投递模式（只属于 send；trigger 永远 fire-and-forget） */
type DeliveryMode = 'await' | 'fire-and-forget';

/** Agent 间通讯消息（电话协议） */
export interface RouterMessage {
  /** 发送者 Agent ID */
  from: string;
  /** 接收者 Agent ID（broadcast 时可为 '*'） */
  to: string;
  /** 消息类型 */
  type: AgentMessageType;
  /** 负载 */
  payload: string;
  /** 关联 ID：会话/事件关联用（L5 WS 层据此把流式事件关联到会话），透传不加工 */
  correlation_id?: string;
  /** 附加数据（结构化数据，流式等场景） */
  data?: Record<string, any>;
  /** 群组 ID（仅群组消息） */
  group_id?: string;
  /** 独立会话 ID（仅 single 会话：convKey = single~<sid>，历史/上下文与 pair 隔离） */
  session_id?: string;
  /** pending 恢复用：原始输入形态（receive/trigger） */
  input?: 'receive' | 'trigger';
  /** pending 恢复用：是否等待目标回复（仅 receive 有效） */
  wait?: boolean;
  /** pending 恢复用：会话繁忙策略 */
  placement?: BusyPlacement;
  /** pending 恢复用：trigger 完整选项（shutdown 时序列化，flush 时重建 plan） */
  triggerOptions?: TriggerOptions;
}

/** Agent 自主推理触发选项（无 currentMessage 的 ReAct 循环） */
export interface TriggerOptions {
  /** 最大 ReAct 步数，默认不限制 */
  maxSteps?: number;
  /** 是否启用深度思考 */
  deepThink?: boolean;
  /** 覆写思考强度（low/high/max；缺省 = 模型配置 reasoning_effort） */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** 触发来源标识（日志/审计用），如 "hourly-cron"、"file-watcher" */
  source?: string;
  /** 结构化来源元数据（kind/form/summary；入站消息与持久化 event 的 source） */
  sourceMeta?: MessageSource;
  /** 可选的上下文提示，作为普通 user 消息注入（不再使用 `<trigger>` 正文包装） */
  hint?: string;
  /** @deprecated 旧正文包装开关已废弃：trigger 语义改由 sourceMeta 表达，忽略此字段 */
  wrapHint?: boolean;
  /** 推理结果目标 Agent ID（trigger 的 source 通常为 system，结果可能需发给另一 Agent） */
  target?: string;
  /** 群组 ID（仅房间 trigger） */
  group_id?: string;
  /** 独立会话 ID（single~：convKey 与持久化按会话隔离） */
  session_id?: string;
  /** 独立会话模型覆盖（池引用/内嵌/$ref+覆盖；透传 llmOverride） */
  sessionModel?: unknown;
  /** 独立会话路径白名单（挂载的用户工作区文件夹；透传 extraAllowedPaths） */
  sessionAllowedPaths?: string[];
  /** 执行扩展元数据（语义化键 → 任意载荷；经 createAgentContext 透传到 CurrentContext.meta） */
  meta?: Record<string, unknown>;
  /** 会话繁忙策略；默认 'steer'，带 run 级选项时强制 'next-run' */
  placement?: BusyPlacement;
}

/** send() 选项：wait 只属于 send；placement 控制会话繁忙策略 */
export interface SendOptions {
  /** 是否等待目标回复；默认 true（保持 send 现状） */
  wait?: boolean;
  /** 会话繁忙策略；默认 'steer' */
  placement?: BusyPlacement;
  /** 外部中断信号 */
  signal?: AbortSignal;
}

// ============================================================
// 内部类型：单一 route 路径
// ============================================================

interface ReceiveInput {
  mode: 'receive';
  message: RouterMessage;
}

interface TriggerInput {
  mode: 'trigger';
  agentId: string;
  options?: TriggerOptions;
}

type AgentInput = ReceiveInput | TriggerInput;

interface RunPlan {
  convKey: string;
  agentId: string;
  /** 构造 CurrentContext；run 级选项只存在于这里 */
  buildCtx: (controller: AbortController) => CurrentContext;
  /** busy + steer 时注入活跃 run 的消息（next-step） */
  steerMessages: AgentMessage[];
  /** 新 run 启动前作为初始 next-step 注入的消息（合并投递 / trigger hint） */
  initialSteer: AgentMessage[];
  /** 跨 run 存活的会话 inbox（next-turn/next-step 双队列） */
  inbox: MessageInbox;
}

interface SubmitOptions {
  delivery: DeliveryMode;
  placement: BusyPlacement;
  signal?: AbortSignal;
  /** 虚拟 Agent 的回执分支 */
  virtualReply?: string;
  /** 虚拟 Agent 的回执消息（run 完成后发射 chat.virtual.receive） */
  virtualMessage?: RouterMessage;
  /** fire-and-forget 空闲受理确认文案（trigger 用） */
  fireAck?: string;
}

type PreparedTriggerPlan =
  | { ok: true; plan: RunPlan; placement: BusyPlacement }
  | { ok: false; reason: string };

// ============================================================
// L2 事件面（EventEmitter）
//
// AgentRouter：
//   'message.received' — 收到一条要投递的点到点/广播消息（入站，供 L4 持久化 / L5 WebUI 监听）；
//                        群组消息不走此事件（见下方 'group.message.received'）
//
// GroupManager（经 router.getGroupManager() 订阅）：
//   'group.created' / 'group.deleted' / 'group.join' / 'group.leave' / 'group.renamed' — 群组生命周期
//   'group.message.received' — 群组消息已投递（L4 落盘 / L5 展示监听）
//   'group.trigger'   — 通知参与者自主推理（router 内部桥接，外部勿订阅）
// ============================================================

// ============================================================
// AgentRouter
// ============================================================

export class AgentRouter extends EventEmitter {
  private assembly: AgentAssembly;
  /** 内置 Agent 注册表（电话本）——1:1 生命周期，外部经 getRegistry() 访问 */
  private registry = new AgentRegistry();
  /** 内置群组管理器（分机）——构造时自动接线，无需 bootstrap 注入 */
  private groupManager: GroupManager;

  /** 活跃会话：convKey → { ctx, controller, agentId }（串行化 + steer 注入载体） */
  private running = new Map<string, { ctx: CurrentContext; controller: AbortController; agentId: string }>();

  /** 会话 inbox：convKey → 跨 run 存活的 next-turn/next-step 队列 */
  private inboxes = new Map<string, MessageInbox>();

  /** 关机模式：为 true 时新消息进入 pending 队列（不投递），落盘 <ws>/.router_pending.jsonl，重启后 flush */
  private _shutdownMode = false;
  private _pendingMessages: RouterMessage[] = [];
  private workspaceDir: string;

  // ---- 群消息投递模式（单通道化 v3，docs/group-single-channel-design.md §2.3-2.4）----
  /** 群消息内容通道：legacy = hint 双通道（现行）；notify = 纯通知 + 本体读取 */
  private groupDelivery: 'legacy' | 'notify' = 'legacy';
  /** notify 模式触发消息位置：tail = currentMessage 携带全文（历史按 id 剔除）；history = 全文留在历史 */
  private groupDeliveryVariant: 'tail' | 'history' = 'history';
  /** 群消息内容通道实现（boot 注入 GroupService；缺省 = notify 不可用，回落 legacy） */
  private groupFeed?: GroupFeed;

  constructor(assembly: AgentAssembly, opts?: RouterGroupDeliveryOptions) {
    super();
    this.assembly = assembly;
    this.workspaceDir = assembly.workspaceDir ?? process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default';
    this.groupManager = new GroupManager(this.registry);
    this.applyGroupDelivery(opts);
    this._wireGroupTriggers();
  }

  /** 绑定/更新群消息投递模式（boot 装配后调用；GroupService 在 Router 之后构造） */
  applyGroupDelivery(opts?: RouterGroupDeliveryOptions): void {
    if (opts?.groupFeed) this.groupFeed = opts.groupFeed;
    if (opts?.delivery) this.groupDelivery = opts.delivery;
    if (opts?.deliveryVariant) this.groupDeliveryVariant = opts.deliveryVariant;
    // notify 模式依赖 groupFeed；未注入时强制回落 legacy（可回滚开关的失效安全侧）
    if (this.groupDelivery === 'notify' && !this.groupFeed) this.groupDelivery = 'legacy';
  }

  /** 当前群消息投递模式（诊断/测试用） */
  get groupDeliveryMode(): { delivery: 'legacy' | 'notify'; variant: 'tail' | 'history' } {
    return { delivery: this.groupDelivery, variant: this.groupDeliveryVariant };
  }

  // ============================================================
  // 群组接线
  // ============================================================

  /** 获取或创建会话 inbox（跨 run 存活；空 inbox 在会话空闲后惰性保留，内存开销可忽略） */
  private inboxFor(convKey: string): MessageInbox {
    let inbox = this.inboxes.get(convKey);
    if (!inbox) {
      inbox = { nextTurn: [], nextStep: [] };
      this.inboxes.set(convKey, inbox);
    }
    return inbox;
  }

  /** 获取内置 Agent 注册表（L4/L5 注册/查询 Agent 用） */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /** 获取内置群组管理器 */
  getGroupManager(): GroupManager {
    return this.groupManager;
  }

  /** 构造时接线群组 trigger → router.trigger()（群聊投递用 trigger 语义） */
  private _wireGroupTriggers(): void {
    this.groupManager.on('group.trigger', (delivery: {
      group_id: string;
      group_name: string;
      from: string;
      to: string;
      payload: string;
      correlation_id?: string;
      data?: Record<string, any>;
    }) => {
      // 虚拟 Agent 不需要 trigger
      if (this.registry.isVirtual(delivery.to)) return;
      if (!this.registry.get(delivery.to)) return;

      // 单通道化 notify 模式：通知不携带正文，内容经本体文件进入上下文
      if (this.groupDelivery === 'notify' && this.groupFeed) {
        void this.deliverGroupNotify(delivery);
        return;
      }

      // legacy 模式（现行 hint 双通道；含字符串对账兜底，Phase 3 拆除）
      const senderName = this.registry.getAgentName(delivery.from);
      const groupName = delivery.group_name || delivery.group_id;
      // 契约按目标 Agent 配置取（agent.session.groupContractText 可覆盖；空回落正典）
      const contract = groupContractTextOf(this.registry.get(delivery.to));

      const now = new Date();
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const nowText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${weekdays[now.getDay()]}`;
      const hint = wrapGroupMsg({ from: delivery.from, displayName: senderName, groupName, content: delivery.payload }) +
        `\n\n[当前时间] ${nowText}\n${contract}`;

      void this.trigger(delivery.to, {
        hint,
        source: `group:${delivery.group_id}`,
        sourceMeta: {
          kind: 'group',
          form: 'hint',
          summary: delivery.payload.slice(0, 60),
          // 落盘行同源 id：历史加载按 id 剔除 / 通知化锚点定位（Phase 1 贯通）
          ...(delivery.correlation_id ? { message_id: delivery.correlation_id } : {}),
        },
        target: delivery.group_id,
        group_id: delivery.group_id,
      });
    });
  }

  /**
   * notify 模式群消息投递（单通道化 §2.3）：
   *   busy → readSince(锚点) 增量 steer（免契约：本 run 上下文已含）→ 推进锚点
   *   idle → 按 variant 触发：tail = currentMessage 携带 <msg>全文+时间（历史按 id 剔除）
   *          history = 极简通知（全文经历史进入，无需剔除）
   * 契约由 agent-session.group-contract 钩子注入（kind=group 识别），此处不拼。
   */
  private async deliverGroupNotify(delivery: {
    group_id: string; group_name: string; from: string; to: string;
    payload: string; correlation_id?: string;
  }): Promise<void> {
    try {
      const gid = delivery.group_id;
      const convKey = groupDialogKey(gid, delivery.to);
      const active = this.running.get(convKey);

      // busy（运行中且未中止）：锚点增量注入
      if (active && !active.ctx.signal?.aborted) {
        const anchor = (active.ctx.meta as Record<string, unknown> | undefined)?.[GROUP_SYNC_META_KEY] as GroupFeedAnchor | undefined;
        const page = await this.groupFeed!.readSince(gid, anchor, { viewer: delivery.to });
        if (page.injected) {
          this.assembly.engine.steer(active.ctx, {
            role: 'user',
            content: page.injected,
            source: { kind: 'group', form: 'hint', summary: delivery.payload.slice(0, 60) },
          });
          (active.ctx.meta as Record<string, unknown>)[GROUP_SYNC_META_KEY] = page.anchor;
        }
        return;
      }

      // idle：按 variant 构造注入单元（契约由钩子注入，不在此拼）
      const senderName = this.registry.getAgentName(delivery.from);
      const groupName = delivery.group_name || delivery.group_id;
      const sourceMeta: MessageSource = {
        kind: 'group',
        form: 'hint',
        summary: delivery.payload.slice(0, 60),
      };
      let hint: string;
      if (this.groupDeliveryVariant === 'tail') {
        const now = new Date();
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const nowText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${weekdays[now.getDay()]}`;
        hint = wrapGroupMsg({ from: delivery.from, displayName: senderName, groupName, content: delivery.payload }) +
          `\n\n[当前时间] ${nowText}`;
        // tail：全文随注入单元进入 → 历史按 id 剔除（loadHistory excludeIds）
        if (delivery.correlation_id) sourceMeta.message_id = delivery.correlation_id;
      } else {
        // history：全文经历史进入（通知极简，不设 message_id → 不剔除）
        const preview = delivery.payload.length > 60 ? `${delivery.payload.slice(0, 60)}…` : delivery.payload;
        hint = `群聊「${groupName}」新消息：${senderName}：${preview}\n（全文见上下文最新历史，按群聊契约决定是否回应）`;
      }

      await this.trigger(delivery.to, {
        hint,
        source: `group:${gid}`,
        sourceMeta,
        target: gid,
        group_id: gid,
      });
    } catch (err: any) {
      log.error(`[Router] 群消息 notify 投递失败 ${delivery.group_id}→${delivery.to}: ${err?.message ?? String(err)}`);
    }
  }

  // ============================================================
  // 查询 / 中断
  // ============================================================

  /** 所有已注册 Agent ID（含虚拟） */
  getAgentIds(): string[] {
    return this.registry.listIds();
  }

  /** 取消指定 Agent 的所有活跃会话（软中断） */
  abortSession(agentId: string): boolean {
    let aborted = false;
    for (const entry of this.running.values()) {
      if (entry.agentId === agentId) {
        entry.controller.abort();
        aborted = true;
      }
    }
    return aborted;
  }

  /**
   * 取消指定会话键（convKey）的活跃会话（软中断，会话级精确中断）。
   * 独立会话隔离用：single~<sid> 只中止该会话，不影响同一 Agent 的
   * 其他 single 会话或 1v1 会话（abortSession 按 agentId 全杀会误伤）。
   */
  abortDialog(convKey: string): boolean {
    const entry = this.running.get(convKey);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** 检查指定 Agent 是否有活跃会话 */
  hasActiveSession(agentId: string): boolean {
    return Array.from(this.running.values()).some(entry => entry.agentId === agentId);
  }

  /**
   * 等待所有活跃会话收尾（关机/重启前调用）。
   *
   * 用途：gracefulShutdown 在 abortSession 之后调用本方法，等待被中止的 run
   * 走完 runEnd 钩子（agent-session.save-session 落盘）再从 running 清理，避免
   * process.exit 抢先执行导致进行中的会话消息未持久化而丢失。
   *
   * 说明：中止后的 run 在 runWithGate 的 finally 中清理 running 条目，因此
   * running 清空即代表该 run 已走完 runEnd（saveSession 为同步写盘）。
   *
   * @param timeoutMs 超时上限（默认 10s；超时放弃，保证关闭流程不卡死）
   * @returns true=已全部收尾；false=超时（可能仍有会话未落盘）
   */
  async waitRunningDrained(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0) {
      if (Date.now() >= deadline) {
        const active = Array.from(this.running.keys()).join(', ');
        log.warn(`[Router] 等待活跃会话收尾超时（${timeoutMs}ms）→ 仍在运行: ${active}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  }

  // ============================================================
  // 关机模式（内存 pending；落盘由 L4 supervisor 负责）
  // ============================================================

  /** 是否处于关机模式 */
  isShutdownMode(): boolean {
    return this._shutdownMode;
  }

  /** 主动入队 pending（Agent 请求重启时塞"继续会话"消息） */
  enqueuePending(message: RouterMessage): number {
    this._pendingMessages.push(message);
    log.info(`[Router] 消息入队 pending (${message.from} → ${message.to})，当前 ${this._pendingMessages.length} 条`);
    // 已进入关机模式：立即落盘，保证进程退出时 pending 不丢（重启后 flush 恢复）
    if (this._shutdownMode) this.persistPending();
    return this._pendingMessages.length;
  }

  /** 进入关机模式：后续 send/sendAsync/trigger 不再投递，进入 pending 队列 */
  enterShutdownMode(): void {
    if (this._shutdownMode) return;
    this._shutdownMode = true;
    log.warn(`[Router] 进入关机模式，后续消息将进入 pending 队列（落盘 ${this.pendingFilePath()}）`);
    this.persistPending();
  }

  /** 落盘 pending 到 <ws>/.router_pending.jsonl（进程级重启需文件持久化，内存会在退出时丢失） */
  private persistPending(): void {
    try {
      const file = this.pendingFilePath();
      if (this._pendingMessages.length > 0) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, this._pendingMessages.map(m => JSON.stringify(m)).join('\n'), 'utf-8');
        log.warn(`[Router] pending 已落盘 ${this._pendingMessages.length} 条 → ${file}`);
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err: any) {
      log.error(`[Router] pending 落盘失败: ${err?.message ?? String(err)}`);
    }
  }

  /** pending 落盘文件路径（对齐旧架构：工作区根 .router_pending.jsonl） */
  private pendingFilePath(): string {
    return path.resolve(this.workspaceDir, '.router_pending.jsonl');
  }

  /**
   * 退出关机模式并重投 pending 消息（重启后 bootstrap 调用）。
   *
   * 序列化格式（RouterMessage 扩展字段）：
   *   · input='receive' + wait/placement → 恢复 send 语义；同 convKey 合并（首条 current + 其余 initial steer）
   *   · input='trigger' + triggerOptions/placement → 重建内部 submit plan（delivery='await'，
   *     保留 flush 的成功/失败判定；不调用公开 trigger，因为公开 trigger 永远 fire-and-forget）
   *   · 无 input 的旧 pending 文件按 type==='trigger' 一次性推断
   */
  async flushPendingMessages(): Promise<number> {
    this._shutdownMode = false;
    const file = this.pendingFilePath();
    // 读盘（进程已重启时内存 pending 为空，需从 .router_pending.jsonl 恢复）。
    // 不立即删除文件：重投结果决定去留，重投失败时保留供下次重启重试。
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        const loaded = content.split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l) as RouterMessage; } catch { return null; }
        }).filter((m): m is RouterMessage => m != null);
        if (loaded.length > 0) {
          this._pendingMessages.push(...loaded);
          log.warn(`[Router] 已从文件恢复 ${loaded.length} 条 pending 消息`);
        }
      }
    } catch (err: any) {
      log.error(`[Router] pending 文件读取失败: ${err?.message ?? String(err)}`);
    }

    const pending = this._pendingMessages;
    this._pendingMessages = [];
    if (pending.length === 0) {
      // 无待投递：清理残留文件
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
      return 0;
    }

    log.warn(`[Router] 重启完成，重投 ${pending.length} 条 pending 消息`);

    // 按运行态会话键分组（chatDialogKey/groupDialogKey，与 live 路径同一套规则）；
    // 同一键内 receive 与 trigger 再分桶处理，避免形态混合（trigger 永远独立重投）。
    const groups = new Map<string, RouterMessage[]>();
    for (const msg of pending) {
      const key = this.pendingKeyOf(msg);
      const list = groups.get(key);
      if (list) list.push(msg);
      else groups.set(key, [msg]);
    }

    let sent = 0;
    const failed: RouterMessage[] = [];
    const markFailed = (msgs: RouterMessage[]) => {
      for (const m of msgs) {
        failed.push(m);
        log.error(`[Router] pending 重投失败 ${m.from} → ${m.to}（已保留，下次重启重试）`);
      }
    };

    await Promise.all(Array.from(groups.values()).map(async (msgs) => {
      const triggers = msgs.filter(m => m.input === 'trigger' || (m.input == null && m.type === 'trigger'));
      const receives = msgs.filter(m => !triggers.includes(m));

      // trigger：逐条重投（不合并）；内部 submit plan + delivery='await' 保证失败可判定
      for (const m of triggers) {
        try {
          await this.redeliverPendingTrigger(m);
          sent++;
        } catch (err: any) {
          log.error(`[Router] pending trigger 重投失败 ${m.from} → ${m.to}: ${err.message}`);
          markFailed([m]);
        }
      }

      if (receives.length === 0) return;

      // 群组/广播：不合并，逐条投递
      if (receives.some(m => m.group_id || m.to === '*')) {
        for (const m of receives) {
          try {
            await this.send(m, {
              wait: m.wait !== false,
              placement: m.placement ?? 'steer',
            });
            sent++;
          } catch (err: any) {
            log.error(`[Router] pending 重投失败 ${m.from} → ${m.to}: ${err.message}`);
            markFailed([m]);
          }
        }
        return;
      }

      // 1v1 receive：同 convKey 内按目标 Agent 合并（首条 currentMessage + 其余 initial steer）；
      // 同一 convKey 但 to 不同（from/to 倒序）分别成 run，避免把消息投错目标。
      const byTarget = new Map<string, RouterMessage[]>();
      for (const m of receives) {
        const t = byTarget.get(m.to);
        if (t) t.push(m);
        else byTarget.set(m.to, [m]);
      }
      for (const msgs of byTarget.values()) {
        const [first, ...rest] = msgs;
        const config = this.registry.get(first.to);
        if (!config) {
          log.error(`[Router] pending 重投失败：Agent "${first.to}" 未在注册表中`);
          markFailed(msgs);
          continue;
        }
        try {
          const delivery: DeliveryMode = first.wait === false ? 'fire-and-forget' : 'await';
          await this.deliverOne(first.to, first, delivery, first.placement ?? 'steer', undefined, rest);
          sent++;
        } catch (err: any) {
          log.error(`[Router] pending 重投失败 ${first.from} → ${first.to}: ${err.message}`);
          markFailed(msgs);
        }
      }
    }));

    // 重投结果落盘：全部成功 → 清理文件；有失败 → 写回失败消息（下次重启重试，不丢恢复信号）
    if (failed.length === 0) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
    } else {
      try {
        fs.writeFileSync(file, failed.map(m => JSON.stringify(m)).join('\n'), 'utf-8');
        log.warn(`[Router] ${failed.length} 条 pending 重投失败已保留 → ${file}（下次重启自动重试）`);
      } catch (err: any) {
        log.error(`[Router] pending 失败消息写回失败: ${err?.message ?? String(err)}`);
      }
    }
    return sent;
  }

  /** pending 分组键：与运行态 chatDialogKey/groupDialogKey/singleDialogKey 完全一致 */
  private pendingKeyOf(msg: RouterMessage): string {
    if (msg.session_id) {
      return singleDialogKey(msg.session_id);
    }
    if (msg.group_id) {
      return groupDialogKey(msg.group_id, msg.to);
    }
    if (msg.input === 'trigger' || (msg.input == null && msg.type === 'trigger')) {
      const gid = msg.triggerOptions?.group_id;
      if (gid) return groupDialogKey(gid, msg.to);
      return chatDialogKey(msg.to, (msg.data?.target as string) ?? 'system');
    }
    return chatDialogKey(msg.from, msg.to);
  }

  /** 构造 shutdown 时落盘的 RouterMessage（只做序列化，不投递） */
  private pendingOf(input: AgentInput, delivery: DeliveryMode, placement: BusyPlacement = 'steer'): RouterMessage {
    if (input.mode === 'receive') {
      const m = input.message;
      return {
        ...m,
        input: 'receive',
        wait: delivery === 'await',
        placement,
      };
    }

    const { agentId, options } = input;
    const resolvedPlacement = this.triggerPlacementOf(options);
    const msg: RouterMessage = {
      from: 'system',
      to: agentId,
      type: 'trigger',
      payload: options?.hint ?? '',
      correlation_id: options?.source,
      input: 'trigger',
      triggerOptions: options,
      placement: resolvedPlacement,
      data: { target: options?.target },
    };
    return msg;
  }

  /**
   * 为所有活跃 1v1 会话入队「继续会话」trigger（通用重启恢复）。
   * gracefulShutdown 时调用（关机模式 + 落盘），重启后 flushPendingMessages 自动重投恢复。
   *
   * 覆盖所有重启路径（WebUI 重启按钮 / supervisor / system_restart 工具之外的场景）：
   * 只要 gracefulShutdown 前仍有活跃会话，重启后 Agent 都会基于对话历史自动继续。
   *
   * 跳过规则：
   *   · 已入队 continue 的会话（如 runWithGate restart-requested 分支已处理）→ 不重复恢复
   *   · 群聊会话（group~）→ 跳过（恢复语义复杂，1v1 先覆盖）
   *
   * @returns 本次入队数量
   */
  enqueueResumeForActiveSessions(): number {
    if (!this._shutdownMode) {
      this.enterShutdownMode();
    }
    let n = 0;
    for (const [convKey, entry] of this.running) {
      if (convKey.startsWith(`group${DIALOG_SEP}`)) continue; // 群聊：跳过
      const target = counterpartOfDialog(convKey, entry.agentId);
      if (!target || target === '?') continue;
      // 已入队过该 Agent 的 continue（runWithGate restart-requested 分支）→ 跳过避免重复恢复
      if (this._pendingMessages.some(m => m.to === entry.agentId && m.type === 'trigger')) continue;
      this.enqueuePending(this.makeResumeTriggerMessage(
        entry.agentId,
        '系统已重启完成。重启前会话已中断，请基于对话历史继续之前的任务。',
        `restart-resume-${Date.now()}-${n}`,
        target,
      ));
      n++;
    }
    if (n > 0) log.warn(`[Router] 已为 ${n} 个活跃会话入队「继续会话」trigger（重启后自动恢复）`);
    return n;
  }

  /** 统一构造「继续会话」trigger pending 消息（runWithGate restart-requested / gracefulShutdown 共用） */
  private makeResumeTriggerMessage(agentId: string, hint: string, source: string, target: string): RouterMessage {
    return {
      from: 'system',
      to: agentId,
      type: 'trigger',
      payload: hint,
      correlation_id: source,
      data: { target },
      input: 'trigger',
      placement: 'steer',
      triggerOptions: {
        hint,
        source,
        target,
        sourceMeta: { kind: 'restart', form: 'resume', summary: hint.slice(0, 60) },
      },
    };
  }

  // ============================================================
  // 公开 API：send / sendAsync / trigger / whenSessionIdle
  // ============================================================

  /**
   * 发送消息到目标 Agent（电话协议）。
   * @param options.wait 默认 true：等待目标回复；false：受理后立即返回
   * @returns 目标 Agent 的响应内容（或系统提示字符串）
   */
  async send(message: RouterMessage, options: SendOptions = {}): Promise<string> {
    return this.route(
      { mode: 'receive', message },
      options.wait === false ? 'fire-and-forget' : 'await',
      options.placement ?? 'steer',
      options.signal,
    );
  }

  /** 糖：send(msg, { wait: false })，立即返回 */
  async sendAsync(message: RouterMessage): Promise<string> {
    return this.send(message, { wait: false });
  }

  // ============================================================
  // 显式 inbox 投递原语（对齐 DSH followup/steer/inject）
  // ============================================================

  /**
   * 统一投递原语：把一条已构造好的入站 AgentMessage 放进会话 inbox。
   * @param delivery.lane   next-turn = 当前 run 结束后独立后续 run；next-step = 当前 run 下一 ReAct step
   * @param delivery.wakeup idle 时是否开新 run（inject=false 只入队挂起）
   */
  async deliverInput(
    agentId: string,
    message: AgentMessage,
    delivery: MessageDelivery = { lane: 'next-step', wakeup: true },
    opts: { target?: string; group_id?: string; session_id?: string; sessionModel?: unknown; sessionAllowedPaths?: string[]; correlationId?: string } = {},
  ): Promise<string> {
    const lane: DeliveryLane = delivery.lane ?? message.delivery?.lane ?? 'next-step';
    const wakeup = delivery.wakeup ?? message.delivery?.wakeup ?? true;

    if (this._shutdownMode) {
      this.enqueuePending({
        from: message.agent_id ?? 'system',
        to: agentId,
        type: 'trigger',
        payload: message.content,
        correlation_id: opts.correlationId ?? message.source?.kind,
        input: 'trigger',
        placement: 'steer',
        triggerOptions: {
          hint: message.content,
          source: message.source?.kind,
          sourceMeta: message.source,
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.group_id !== undefined ? { group_id: opts.group_id } : {}),
          ...(opts.session_id !== undefined ? { session_id: opts.session_id } : {}),
        },
      });
      return `[Router] 系统正在重启，消息已入队，重启后将自动投递（${lane}）。`;
    }

    const config = this.registry.get(agentId);
    if (!config) {
      return `[Router] Agent "${agentId}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }
    if (config.virtual) {
      return `[Router] "${agentId}" 是虚拟 Agent，不接受 inbox 投递。`;
    }

    const convKey = opts.session_id
      ? singleDialogKey(opts.session_id)
      : opts.group_id
        ? groupDialogKey(opts.group_id, agentId)
        : chatDialogKey(opts.target ?? 'system', agentId);

    const active = this.running.get(convKey);
    if (active) {
      if (active.ctx.signal?.aborted) {
        await this.waitAbortedClear(convKey);
      } else {
        this.assembly.engine.enqueue(active.ctx, message, lane);
        return `[Router] "${agentId}" 正在处理消息，本条已注入 ${lane}。`;
      }
    }

    const inbox = this.inboxFor(convKey);
    if (!wakeup && lane === 'next-step') {
      // inject：只入队，不唤醒。空闲会话等待后续 followup/steer 再消费。
      inbox.nextStep.push(message);
      return `[Router] 上下文已注入 "${agentId}"（未唤醒，等待后续输入）。`;
    }

    const autonomous = isAutonomousSource(message.source);
    const controller = this.makeController();
    const ctx = createAgentContext(config, this.assembly, {
      currentMessage: lane === 'next-turn' ? message : undefined,
      dialogId: convKey,
      inbox,
      signal: controller.signal,
      maxSteps: autonomous ? (delivery.maxSteps ?? message.delivery?.maxSteps) : undefined,
      // 独立会话模型覆盖（single~；park/late-reply 唤醒场景；缺省 = Agent 原配置）
      llmOverride: opts.session_id ? opts.sessionModel as any : undefined,
      // 独立会话路径白名单（挂载的用户工作区文件夹；缺省 = Agent 原配置）
      extraAllowedPaths: opts.session_id ? opts.sessionAllowedPaths : undefined,
      meta: { [CHAT_START_META_KEY]: { source: message.source } satisfies RunStartMeta },
      correlationId: opts.correlationId ?? (autonomous ? `trigger-${agentId}-${Date.now()}` : undefined),
    });
    if (lane === 'next-step') this.assembly.engine.steer(ctx, message);

    return this.runWithGate(convKey, agentId, ctx, controller);
  }

  /** followup：入队 next-turn，空闲时开新 run */
  followup(agentId: string, message: AgentMessage, opts: { target?: string; group_id?: string; session_id?: string; sessionModel?: unknown; sessionAllowedPaths?: string[]; correlationId?: string } = {}): Promise<string> {
    return this.deliverInput(agentId, message, { lane: 'next-turn', wakeup: true }, opts);
  }

  /** steer：入队 next-step，空闲时开新 run */
  steer(agentId: string, message: AgentMessage, opts: { target?: string; group_id?: string; session_id?: string; sessionModel?: unknown; sessionAllowedPaths?: string[]; correlationId?: string } = {}): Promise<string> {
    return this.deliverInput(agentId, message, { lane: 'next-step', wakeup: true }, opts);
  }

  /** inject：入队 next-step，不唤醒空闲会话 */
  inject(agentId: string, message: AgentMessage, opts: { target?: string; group_id?: string; session_id?: string; sessionModel?: unknown; sessionAllowedPaths?: string[]; correlationId?: string } = {}): Promise<string> {
    return this.deliverInput(agentId, message, { lane: 'next-step', wakeup: false }, opts);
  }

  /**
   * 触发 Agent 自主推理（无 incoming 用户消息）。
   * 永远 fire-and-forget：解析到「已受理」即返回，不返回 run 最终内容。
   * 需要等待 run 收尾的调用方（如 WS chat.continue）请使用 whenSessionIdle()。
   */
  async trigger(agentId: string, options?: TriggerOptions, signal?: AbortSignal): Promise<string> {
    return this.route({ mode: 'trigger', agentId, options }, 'fire-and-forget', undefined, signal);
  }

  /**
   * 等待会话空闲；供需要「触发后等到 run 收尾」的调用方（WS chat.continue）。
   * trigger 在 running 已注册 / steer 已注入之后才 resolve，因此本方法不会因竞态提前返回。
   *
   * @param convKey 会话键（chatDialogKey/groupDialogKey）
   * @param timeoutMs 超时上限（默认 190s，对齐 LLM 180s 超时兜底 + 余量）
   * @returns true=会话已空闲；false=超时放弃
   */
  async whenSessionIdle(convKey: string, timeoutMs = 190_000): Promise<boolean> {
    return this.waitSessionIdle(convKey, timeoutMs);
  }

  // ============================================================
  // 内部：route → fanout → submit → startRun（单一路径）
  // ============================================================

  /**
   * 唯一投递入口：
   *   1. lifecycleGate：唯一 shutdown 检查
   *   2. trigger 输入 → routeTrigger
   *   3. 群组消息 → GroupManager 委托（不做 1v1 dispatch）
   *   4. 入站事件 → target 解析（1v1 = fanout(1)，广播 = fanout(N)）
   */
  private async route(
    input: AgentInput,
    delivery: DeliveryMode,
    placement: BusyPlacement = 'steer',
    signal?: AbortSignal,
  ): Promise<string> {
    // 1. 生命周期闸门：唯一 shutdown 检查
    if (this._shutdownMode) {
      this.enqueuePending(this.pendingOf(input, delivery, placement));
      return input.mode === 'trigger'
        ? '[Router] 系统正在重启，trigger 已入队，重启后将自动投递。'
        : '[Router] 系统正在重启，消息已入队，重启后将自动投递。';
    }

    if (input.mode === 'trigger') {
      return this.routeTrigger(input, signal);
    }

    const msg = input.message;

    // 2. 群组：走 GroupManager，不做 1v1 dispatch
    if (msg.group_id) {
      try {
        const result = await this.groupManager.deliverGroupMessage(msg as GroupMessage);
        return `[Group] 消息已投递到群组 "${msg.group_id}"，已触发 ${result.triggered.length} 个参与者`;
      } catch (err: any) {
        return `[Group] 群组消息投递失败：${err.message}`;
      }
    }

    // 3. 入站事件：仍只对 1v1/广播发射
    this.emit('message.received', msg);

    // 4. target 解析：1v1 = fanout(1)
    const targets = msg.to === '*'
      ? this.registry.listIds().filter(id => id !== msg.from)
      : [msg.to];

    return this.fanout(targets, msg, delivery, placement, signal);
  }

  /** 目标展开：n=1 即 1v1；fire-and-forget 逐个后台投递，await 并行等待 */
  private async fanout(
    targets: string[],
    msg: RouterMessage,
    delivery: DeliveryMode,
    placement: BusyPlacement,
    signal?: AbortSignal,
  ): Promise<string> {
    const run = (id: string) => this.deliverOne(id, { ...msg, to: id }, delivery, placement, signal);

    if (delivery === 'fire-and-forget') {
      for (const id of targets) {
        void run(id).catch(err => log.error(`[Router] 异步投递失败 ${msg.from} → ${id}: ${err?.message ?? String(err)}`));
      }
      return `[Router] 已异步投递到 ${targets.length} 个 Agent`;
    }

    const results = await Promise.all(targets.map(async (id) => {
      try {
        return { id, text: await run(id) };
      } catch (err: any) {
        return { id, text: `[Router] 来自 "${id}" 的错误：${err?.message ?? String(err)}` };
      }
    }));
    return targets.length === 1
      ? results[0]?.text ?? ''
      : results
          .filter((r) => r.text)
          .map((r) => `[${r.id}] ${r.text}`)
          .join('\n');
  }

  /** receive 输入 → RunPlan（虚拟 Agent 回执分支保持在这里，不进 submit 通用逻辑） */
  private deliverOne(
    agentId: string,
    msg: RouterMessage,
    delivery: DeliveryMode,
    placement: BusyPlacement,
    signal?: AbortSignal,
    extraSteer: RouterMessage[] = [],
  ): Promise<string> {
    const config = this.registry.get(agentId);
    if (!config) {
      return Promise.resolve(`[Router] Agent "${agentId}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`);
    }

    const convKey = msg.session_id
      ? singleDialogKey(msg.session_id)
      : msg.group_id ? groupDialogKey(msg.group_id, msg.to) : chatDialogKey(msg.from, msg.to);
    const steerMessage = this.toSteerMessage(msg);
    const inbox = this.inboxFor(convKey);
    const plan: RunPlan = {
      convKey,
      agentId,
      inbox,
      buildCtx: (c) => createAgentContext(config, this.assembly, {
        currentMessage: steerMessage,
        dialogId: convKey,
        inbox,
        signal: c.signal,
        // 前端 per-message 思考控制（chat.send data.deepThink/reasoningEffort；
        // 缺省 = Agent 配置 deepThink / 模型配置 reasoning_effort）
        deepThink: typeof msg.data?.deepThink === 'boolean' ? msg.data.deepThink : undefined,
        reasoningEffort: msg.data?.reasoningEffort,
        // 独立会话模型覆盖（session.json 的 model：池引用字符串 / 内嵌 / $ref+覆盖，
        // 三形态走 resolveLLMPool 同一解析链）；pair/群聊无此字段 = Agent 原配置
        llmOverride: msg.session_id ? msg.data?.sessionModel as any : undefined,
        // 独立会话路径白名单（挂载的用户工作区文件夹；pair/群聊无此字段）
        extraAllowedPaths: msg.session_id ? msg.data?.sessionAllowedPaths as string[] | undefined : undefined,
        // receive 同样写 chat.start source：前台/后台分类统一走 MessageSource
        meta: { [CHAT_START_META_KEY]: { source: steerMessage.source } satisfies RunStartMeta },
      }),
      // busy 时注入当前消息（next-step）；新 run 由 currentMessage 承载，不重复注入
      steerMessages: [steerMessage, ...extraSteer.map(m => this.toSteerMessage(m))],
      initialSteer: extraSteer.map(m => this.toSteerMessage(m)),
    };
    const opts: SubmitOptions = { delivery, placement, signal };
    if (config.virtual) {
      opts.virtualReply = `[VirtualAgent] "${config.agent_id}" 已收到消息。`;
      opts.virtualMessage = msg;
    }
    return this.submit(plan, opts);
  }

  /** trigger 输入 → RunPlan；公开 trigger 永远 fire-and-forget */
  private async routeTrigger(input: TriggerInput, signal?: AbortSignal): Promise<string> {
    const { agentId, options } = input;
    const prepared = this.prepareTriggerPlan(agentId, options);
    if (!prepared.ok) return Promise.resolve(prepared.reason);

    log.info(`[Router] trigger → ${agentId}` + (options?.source ? ` (source: ${options.source})` : ''));

    // trigger 永远 fire-and-forget；受理失败只记日志，不向调用方抛错
    try {
      return await this.submit(prepared.plan, {
        delivery: 'fire-and-forget',
        placement: prepared.placement,
        signal,
        fireAck: `[Router] 已触发 "${agentId}" 自主推理。`,
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.error(`[Router] trigger 受理失败 ${agentId}: ${message}`);
      return `[Router] 触发 "${agentId}" 失败：${message}`;
    }
  }

  /**
   * 构造 trigger RunPlan（routeTrigger / flush 恢复共用）。
   * run 级选项不能降级为 steer：带 meta/maxSteps/deepThink 时默认 placement='next-run'。
   */
  private prepareTriggerPlan(agentId: string, options?: TriggerOptions): PreparedTriggerPlan {
    const config = this.registry.get(agentId);
    if (!config) {
      return {
        ok: false,
        reason: `[Router] Agent "${agentId}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`,
      };
    }
    if (config.virtual) {
      return { ok: false, reason: `[VirtualAgent] "${agentId}" 是虚拟 Agent，不支持自主推理。` };
    }

    const convKey = options?.session_id
      ? singleDialogKey(options.session_id)
      : options?.group_id
        ? groupDialogKey(options.group_id, agentId)
        : chatDialogKey(options?.target ?? 'system', agentId);

    const placement = this.triggerPlacementOf(options);
    const hint = this.makeHintSteer(options);
    const source = this.sourceMetaOf(options);
    const inbox = this.inboxFor(convKey);
    const runStartMeta: RunStartMeta = {
      ...(options?.hint !== undefined ? { hint: options.hint } : {}),
      source,
    };

    const plan: RunPlan = {
      convKey,
      agentId,
      inbox,
      buildCtx: (c) => createAgentContext(config, this.assembly, {
        dialogId: convKey,
        inbox,
        signal: c.signal,
        maxSteps: options?.maxSteps,
        deepThink: options?.deepThink,
        reasoningEffort: options?.reasoningEffort,
        // 独立会话模型覆盖（single~；缺省 = Agent 原配置）
        llmOverride: options?.session_id ? options.sessionModel as any : undefined,
        // 独立会话路径白名单（single~；缺省 = Agent 原配置）
        extraAllowedPaths: options?.session_id ? options.sessionAllowedPaths : undefined,
        // trigger 来源归一化为 MessageSource，经 meta['chat.start'] 透传到 chat.start。
        // 是否 background 由 WS/前端用 isBackgroundRunSource(source) 判定，loop 不再判断 isTrigger。
        meta: {
          ...options?.meta,
          [CHAT_START_META_KEY]: runStartMeta,
        },
        correlationId: options?.source ?? `trigger-${agentId}-${Date.now()}`,
      }),
      // trigger hint：busy 时注入活跃 run（next-step）；新 run 作为初始 next-step
      steerMessages: hint ? [hint] : [],
      initialSteer: hint ? [hint] : [],
    };
    return { ok: true, plan, placement };
  }

  /** trigger placement 决策（公开 shutdown 序列化 / prepare plan 共用） */
  private triggerPlacementOf(options?: TriggerOptions): BusyPlacement {
    const hasRunScopedOptions = !!(options?.meta || options?.maxSteps !== undefined || options?.deepThink !== undefined);
    return options?.placement ?? (hasRunScopedOptions ? 'next-run' : 'steer');
  }

  /** 唯一 busy 决策点：运行中 → steer / next-run / 清理后重开 */
  private async submit(plan: RunPlan, opts: SubmitOptions): Promise<string> {
    const active = this.running.get(plan.convKey);
    const fire = opts.delivery === 'fire-and-forget';

    // 运行中且将死：等待清理后 startRun
    if (active?.ctx.signal?.aborted) {
      if (fire) {
        void this.waitThenStart(plan, opts, 'aborted-clear');
        return '[Router] 已受理，等待旧会话清理后执行。';
      }
      await this.waitAbortedClear(plan.convKey);
      return this.startRun(plan, opts);
    }

    // 运行中且可 steer
    if (active && opts.placement === 'steer') {
      for (const m of plan.steerMessages) {
        this.assembly.engine.steer(active.ctx, m);
      }
      return '[Router] 会话运行中，消息已注入为下一步 steer（next-step）。';
    }

    // 运行中且要求独立 run
    if (active && opts.placement === 'next-run') {
      if (fire) {
        void this.waitThenStart(plan, opts, 'idle');
        return '[Router] 已受理，会话空闲后作为独立 run 执行。';
      }
      const idle = await this.waitSessionIdle(plan.convKey);
      if (!idle) return '[Router] 会话繁忙，next-run 等待超时，已放弃。';
      return this.startRun(plan, opts);
    }

    return this.startRun(plan, opts);
  }

  /**
   * fire-and-forget 的非立即路径：后台等待 aborted 清理或会话空闲后 startRun。
   * 超时/异常只记日志，不向 trigger 调用方抛错。
   */
  private async waitThenStart(plan: RunPlan, opts: SubmitOptions, mode: 'aborted-clear' | 'idle'): Promise<void> {
    try {
      if (mode === 'aborted-clear') {
        await this.waitAbortedClear(plan.convKey);
      } else if (!(await this.waitSessionIdle(plan.convKey))) {
        log.warn(`[Router] next-run 等待会话空闲超时，放弃（${plan.convKey}）`);
        return;
      }
      await this.startRun(plan, opts);
    } catch (err: any) {
      log.error(`[Router] fire-and-forget 后台投递失败 ${plan.agentId}: ${err?.message ?? String(err)}`);
    }
  }

  /** 新 run 启动：构造 ctx → 注入 initialSteer（next-step） → runWithGate（同步注册 running Map） */
  private async startRun(plan: RunPlan, opts: SubmitOptions): Promise<string> {
    const controller = this.makeController(opts.signal);
    const ctx = plan.buildCtx(controller);
    for (const m of plan.initialSteer) this.assembly.engine.steer(ctx, m);

    const promise = this.runWithGate(plan.convKey, plan.agentId, ctx, controller);

    if (opts.delivery === 'fire-and-forget') {
      // runWithGate 已同步写入 running Map，因此返回时会话一定已注册或已 steer
      void promise
        .then((content) => this.finishVirtualRun(opts, content))
        .catch(err => log.error(`[Router] 异步投递失败 ${plan.agentId}: ${err?.message ?? String(err)}`));
      return opts.fireAck ?? '[Router] 消息已异步投递。';
    }

    const content = await promise;
    this.finishVirtualRun(opts, content);
    if (opts.virtualReply !== undefined) return content || opts.virtualReply;
    return content;
  }

  /** 虚拟 Agent 收尾：run 完成后发射 chat.virtual.receive（wait=false 也由后台 run 完成后发射） */
  private finishVirtualRun(opts: SubmitOptions, _content: string): void {
    if (!opts.virtualMessage) return;
    const message = opts.virtualMessage;
    this.emit('message', {
      from: message.from,
      to: message.to,
      type: 'chat.virtual.receive',
      payload: message.payload,
      correlation_id: message.correlation_id,
      data: {
        agent: message.to,
        from: message.from,
        payload: message.payload,
        label: message.data?.label,
      },
    });
  }

  /** 构造 steer 消息（运行中注入 / 合并投递 / 新 run currentMessage 共用） */
  private toSteerMessage(m: RouterMessage): AgentMessage {
    const source: MessageSource = m.from === 'user'
      ? { kind: 'user', form: 'prompt' }
      : m.from === 'system'
        ? { kind: 'system', form: 'notice' }
        : { kind: 'agent', form: 'relay' };
    return {
      role: 'user',
      content: m.payload,
      agent_id: m.from,
      source,
      timestamp: new Date().toISOString(),
      delivery: { lane: 'next-step', wakeup: true },
    };
  }

  /** 旧 source 字符串 → 来源 kind（旧 pending 文件兼容推断） */
  private inferSourceKind(source?: string): MessageSourceKind {
    const s = source ?? '';
    if (s.startsWith('group:')) return 'group';
    if (s.startsWith('continue:') || s === 'continue') return 'continue';
    if (s.startsWith('restart')) return 'restart';
    if (s === 'archive-review' || s.startsWith('archive')) return 'archive';
    if (s === 'cron' || s.startsWith('timer')) return 'timer';
    return 'system';
  }

  /**
   * trigger 来源元数据：归一化为非空 MessageSource。
   *   · sourceMeta 优先（缺 form 时补 'hint'）
   *   · 否则旧 source 字符串推断 kind，form 缺省 'hint'
   *   · 完全无 options 时兜底 { kind:'system', form:'hint' }
   * 保证 chat.start.source 始终可用于 isBackgroundRunSource 分类。
   */
  private sourceMetaOf(options?: TriggerOptions): MessageSource {
    if (options?.sourceMeta) {
      const sm = options.sourceMeta;
      return {
        kind: sm.kind,
        form: sm.form ?? 'hint',
        ...(sm.summary !== undefined ? { summary: sm.summary } : {}),
        ...(sm.message_id !== undefined ? { message_id: sm.message_id } : {}),
        ...(sm.legacyRole ? { legacyRole: sm.legacyRole } : {}),
      };
    }
    return {
      kind: this.inferSourceKind(options?.source),
      form: 'hint',
    };
  }

  /**
   * 构造 trigger hint 的 steer 消息（运行中注入 / 启动注入共用）。
   * 新模型：统一 role='user' + source 元数据，不再使用 role='trigger' 与 `<trigger>` 正文包装。
   */
  private makeHintSteer(options?: TriggerOptions): AgentMessage | undefined {
    if (!options?.hint) return undefined;
    const meta = this.sourceMetaOf(options);
    return {
      role: 'user',
      content: options.hint,
      source: {
        kind: meta?.kind ?? 'system',
        form: meta?.form ?? 'hint',
        summary: meta?.summary ?? options.hint.slice(0, 60),
        ...(meta?.legacyRole ? { legacyRole: meta.legacyRole } : {}),
      },
      delivery: {
        lane: 'next-step',
        wakeup: true,
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      },
    };
  }

  /**
   * 串行化门：注册活跃会话 → loop.run → 清理 → 依序消费 next-turn。
   *
   * run() 内部已内置兜底（fallbackHook/handleFatal 不抛），此方法保证
   * runningMap 无论成功失败都清理。next-turn 是"当前 run 结束后的独立轮次"：
   * 每个 run 取一条作为 currentMessage；用户/Agent 消息不受预算限制，系统/自主
   * 来源连续自动连跑受 MAX_AUTO_WAKES 约束，防"完成→自触发→再完成"自激。
   *
   * 引用保护：仅当 runningMap 仍指向本 entry 才删除 —— 避免超时等待后
   * 新建会话覆盖旧 entry 时，旧 loop 收尾误删新会话。
   */
  private async runWithGate(
    convKey: string,
    agentId: string,
    ctx: CurrentContext,
    controller: AbortController,
  ): Promise<string> {
    let firstContent = '';
    let first = true;
    let autoWakes = 0;
    let activeCtx = ctx;
    let activeController = controller;
    let interrupted = false;

    while (true) {
      const entry = { ctx: activeCtx, controller: activeController, agentId };
      this.running.set(convKey, entry);
      let result: import('@agentchat/agent-loop').RunResult;
      try {
        result = await this.assembly.engine.run(activeCtx);
        if (first) {
          firstContent = result.content;
          first = false;
        }
        interrupted = result.interrupted;

        // restart-requested（system_restart 工具）：入队"继续会话"消息 + 进入关机模式 + 请求后端重启。
        if (result.interruptReason?.type === 'restart-requested') {
          const reason = result.interruptReason.reason;
          try {
            this.enqueuePending(this.makeResumeTriggerMessage(
              agentId,
              `系统已重启完成。请基于对话历史继续（重启前 Agent 请求了重启${reason ? `：${reason}` : ''}）。`,
              `restart-continue-${Date.now()}`,
              activeCtx.currentMessage?.agent_id ?? 'user',
            ));
            this.enterShutdownMode();
            log.warn(`[Router] Agent "${agentId}" 请求重启：已入队继续会话 trigger，进入关机模式`);
          } catch (err: any) {
            log.error(`[Router] 处理 restart-requested 失败: ${err?.message || String(err)}`);
          }
          this.assembly.requestRestart?.(reason ?? `agent-${agentId}-restart`);
        }
      } finally {
        if (this.running.get(convKey) === entry) this.running.delete(convKey);
      }

      if (interrupted || this._shutdownMode) break;

      // ---- next-turn 消费：当前 run 完全结束后才允许开下一个独立 run ----
      const next = activeCtx.inbox.nextTurn.shift();
      if (!next) break;
      const autonomous = isAutonomousSource(next.source);
      if (autonomous) {
        if (autoWakes >= MAX_AUTO_WAKES) {
          // 预算用尽：放回队首，等外部输入带来的下一次自然唤醒
          activeCtx.inbox.nextTurn.unshift(next);
          log.warn(`[Router] 系统来源自动连跑已达上限 ${MAX_AUTO_WAKES}（${convKey}），剩余 next-turn 挂起`);
          break;
        }
        autoWakes++;
      } else {
        autoWakes = 0;
      }

      const config = this.registry.get(agentId);
      if (!config) break;
      activeController = new AbortController();
      activeCtx = createAgentContext(config, this.assembly, {
        currentMessage: next,
        dialogId: convKey,
        inbox: activeCtx.inbox,
        signal: activeController.signal,
        maxSteps: next.delivery?.maxSteps,
        meta: { [CHAT_START_META_KEY]: { source: next.source } satisfies RunStartMeta },
        correlationId: activeCtx.correlationId,
      });
    }

    return firstContent;
  }

  /** flush 恢复 trigger：重建内部 submit plan，delivery='await' 保留失败判定 */
  private async redeliverPendingTrigger(msg: RouterMessage): Promise<string> {
    const options: TriggerOptions = msg.triggerOptions ?? {
      hint: msg.payload,
      source: msg.correlation_id ?? 'pending-trigger',
      ...(msg.data?.target != null ? { target: String(msg.data.target) } : {}),
      ...(msg.data?.group_id != null ? { group_id: String(msg.data.group_id) } : {}),
    };
    const prepared = this.prepareTriggerPlan(msg.to, options);
    if (!prepared.ok) {
      // 虚拟 Agent 不支持自主推理：与旧行为一致，视为已处理（成功落账，避免 pending 永久保留）
      if (prepared.reason.startsWith('[VirtualAgent]')) return prepared.reason;
      throw new Error(prepared.reason);
    }
    // 落盘 placement 优先（shutdown 时刻决策）；旧文件无 placement 时用当前决策
    const placement = msg.placement ?? prepared.placement;
    return this.submit(prepared.plan, { delivery: 'await', placement });
  }

  /**
   * 等待同会话已中止（中断/优雅关闭收尾中）的运行清理完成，
   * 上限 5s（极端卡死由 LLM 180s 超时兜底清理）。
   */
  private async waitAbortedClear(convKey: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (this.running.has(convKey) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * 等待同会话活跃 run 自然结束（不中止它）。
   * 用于 next-run 语义：在会话空闲后作为独立 run 重试。
   * 上限 190s（对齐 LLM 180s 超时兜底 + 余量）；超时后放弃（调用方 fallbackHook 兜底）。
   * @returns true=会话已空闲；false=超时放弃
   */
  private async waitSessionIdle(convKey: string, timeoutMs = 190_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const sleep = () => new Promise<void>((r) => setTimeout(r, 50));
    while (true) {
      while (this.running.has(convKey)) {
        if (Date.now() >= deadline) {
          log.warn(`[Router] 等待会话空闲超时（${timeoutMs}ms）→ ${convKey}`);
          return false;
        }
        await sleep();
      }
      // 观察到空闲后再确认一拍：覆盖「旧 run 刚清理、后台 next-run 尚未注册」的间隙
      await sleep();
      if (!this.running.has(convKey)) return true;
      if (Date.now() >= deadline) return false;
    }
  }

  /** 创建会话 AbortController，并链接外部信号（外部 abort → 内部 controller） */
  private makeController(external?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (external) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    return controller;
  }
}
