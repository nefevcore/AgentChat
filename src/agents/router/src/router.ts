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
// 已移除（相对旧实现）：网络失效模式（down 队列 + base_url 探测）——
//   LLM 异常由 L1 fallbackHook 捕捉，run 永不抛给调用方，无需 router 级兜底。
//
// 依赖方向：仅依赖 src/core 与本层 config/registry/group/virtual-agent（相对导入）。
// ============================================================

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { CurrentContext } from '@agentchat/agent-loop';
import { createLogger } from '@agentchat/util';
import type { AgentMessage } from '@agentchat/types';
import type { AgentConfig } from '@agentchat/agent-config';
import type { AgentAssembly } from '@agentchat/agents';
import { createAgentContext } from '@agentchat/agents';
import { AgentRegistry } from '@agentchat/agents';
import { VirtualAgent } from './virtual-agent';
import { GroupManager } from './group';
import type { GroupMessage } from './group';
import { chatDialogKey, groupDialogKey, counterpartOfDialog, DIALOG_SEP } from '@agentchat/agents';

const log = createLogger('[agents:router]');

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
  | 'chat.turn.start' | 'chat.turn.end' | 'chat.turn.steered'
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
}

/** Agent 自主推理触发选项（无 currentMessage 的 ReAct 循环） */
export interface TriggerOptions {
  /** 最大 ReAct 轮次，默认不限制 */
  maxTurns?: number;
  /** 是否启用深度思考 */
  deepThink?: boolean;
  /** 触发来源标识（日志/审计用），如 "hourly-cron"、"file-watcher" */
  source?: string;
  /** 可选的上下文提示，默认以 `<trigger>hint</trigger>` 格式注入 */
  hint?: string;
  /** 是否用 `<trigger>` 标签包裹 hint（默认 true） */
  wrapHint?: boolean;
  /** 推理结果目标 Agent ID（trigger 的 source 通常为 system，结果可能需发给另一 Agent） */
  target?: string;
  /** 群组 ID（仅房间 trigger） */
  group_id?: string;
  /** 执行扩展元数据（语义化键 → 任意载荷；经 createAgentContext 透传到 CurrentContext.meta） */
  meta?: Record<string, unknown>;
}

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

  /** 关机模式：为 true 时新消息进入 pending 队列（不投递），落盘 <ws>/.router_pending.jsonl，重启后 flush */
  private _shutdownMode = false;
  private _pendingMessages: RouterMessage[] = [];
  private workspaceDir: string;

  constructor(assembly: AgentAssembly) {
    super();
    this.assembly = assembly;
    this.workspaceDir = assembly.workspaceDir ?? process.env.AGENTCHAT_WORKSPACE ?? 'workspace/default';
    this.groupManager = new GroupManager(this.registry);
    this._wireGroupTriggers();
  }

  // ============================================================
  // 群组接线
  // ============================================================

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

      const senderName = this.registry.getAgentName(delivery.from);
      const groupName = delivery.group_name || delivery.group_id;

      const now = new Date();
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const nowText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${weekdays[now.getDay()]}`;
      const hint = `<msg from="${delivery.from}" name="${senderName}" group="${groupName}">${delivery.payload}</msg>` +
        `\n\n[当前时间] ${nowText}\n收到群聊消息：若值得回应，请调用工具 send_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默，请注意不要刷屏。`;

      this.trigger(delivery.to, {
        hint,
        source: `group:${delivery.group_id}`,
        target: delivery.group_id,
        group_id: delivery.group_id,
      }).catch(err => {
        log.error(`[Router] 房间 trigger 失败 ${delivery.from} → ${delivery.to}: ${err.message}`);
      });
    });
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

  /** 退出关机模式并重投 pending 消息（重启后 bootstrap 调用） */
  /** 退出关机模式并重投 pending 消息（重启后 bootstrap 调用） */
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

    // 按会话分组：同会话消息合并为一个 run（首条 currentMessage + 其余初始 steer）；
    // 不同会话并行投递；群组/广播语义不同（触发参与者/展开），组内逐条走 send。
    const groups = new Map<string, RouterMessage[]>();
    for (const msg of pending) {
      const key = msg.group_id ?? `${msg.from}__${msg.to}`;
      const list = groups.get(key);
      if (list) list.push(msg);
      else groups.set(key, [msg]);
    }

    let sent = 0;
    const failed: RouterMessage[] = [];
    const markFailed = (m: RouterMessage) => {
      failed.push(m);
      log.error(`[Router] pending 重投失败 ${m.from} → ${m.to}（已保留，下次重启重试）`);
    };
    await Promise.all(Array.from(groups.values()).map(async (msgs) => {
      const [first, ...rest] = msgs;
      // 群组/广播：不合并，逐条投递
      if (first.group_id || first.to === '*') {
        for (const m of msgs) {
          try { await this.send(m); sent++; }
          catch (err: any) { log.error(`[Router] pending 重投失败 ${m.from} → ${m.to}: ${err.message}`); markFailed(m); }
        }
        return;
      }
      // trigger 恢复消息（如 system_restart 的"继续会话"）：走 trigger 语义（<trigger> 注入），
      // 而非普通 user 消息；data.target 指向原会话对方，保证加载重启前历史。
      if (first.type === 'trigger') {
        for (const m of msgs) {
          try {
            const target = (m.data as any)?.target;
            await this.trigger(m.to, {
              hint: m.payload,
              source: m.correlation_id ?? 'pending-trigger',
              ...(target ? { target } : {}),
            });
            sent++;
          } catch (err: any) {
            log.error(`[Router] pending trigger 重投失败 ${m.from} → ${m.to}: ${err.message}`);
            markFailed(m);
          }
        }
        return;
      }
      const config = this.registry.get(first.to);
      if (!config) {
        log.error(`[Router] pending 重投失败：Agent "${first.to}" 未在注册表中`);
        markFailed(first);
        return;
      }
      try {
        await this.dispatch(config, first, undefined, rest);
        sent++;
      } catch (err: any) {
        log.error(`[Router] pending 重投失败 ${first.from} → ${first.to}: ${err.message}`);
        markFailed(first);
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
      this.enqueuePending({
        from: 'system',
        to: entry.agentId,
        type: 'trigger',
        payload: '系统已重启完成。重启前会话已中断，请基于对话历史继续之前的任务。',
        correlation_id: `restart-resume-${Date.now()}-${n}`,
        data: { target },
      });
      n++;
    }
    if (n > 0) log.warn(`[Router] 已为 ${n} 个活跃会话入队「继续会话」trigger（重启后自动恢复）`);
    return n;
  }
  // ============================================================
  // 发送
  // ============================================================

  /**
   * 发送消息到目标 Agent（电话协议）：同步投递，等待目标回复。
   * @returns 目标 Agent 的响应内容（或系统提示字符串）
   */
  async send(message: RouterMessage, signal?: AbortSignal): Promise<string> {
    return this.deliver(message, 'sync', signal);
  }

  /**
   * 异步投递消息（fire-and-forget）：不等待目标 Agent 回复即返回。
   * 适用于对话已建立的场景，Agent 会自行回复。
   */
  async sendAsync(message: RouterMessage): Promise<string> {
    return this.deliver(message, 'async');
  }

  /**
   * 投递核心（send/sendAsync 共享）：关机检查 → 群组委托 → 入站事件 → 广播/点到点。
   * @param mode 'sync'：等待点到点回复 / 广播串行展开；'async'：fire-and-forget
   */
  private async deliver(message: RouterMessage, mode: 'sync' | 'async', signal?: AbortSignal): Promise<string> {
    // ---- 关机模式：不投递，进 pending 队列 ----
    if (this._shutdownMode) {
      this._pendingMessages.push(message);
      log.info(`[Router] 关机模式，消息入队 pending (${message.from} → ${message.to})`);
      return `[Router] 系统正在重启，消息已入队，重启后将自动投递。`;
    }

    // ---- 群组消息：委托内置 GroupManager 投递（同步/异步一致，均等待投递确认） ----
    if (message.group_id) {
      try {
        const result = await this.groupManager.deliverGroupMessage(message as GroupMessage);
        return `[Group] 消息已投递到群组 "${message.group_id}"，已触发 ${result.triggered.length} 个参与者`;
      } catch (err: any) {
        return `[Group] 群组消息投递失败：${err.message}`;
      }
    }

    // ---- 入站事件：供 L4 持久化 / L5 WebUI 监听 ----
    this.emit('message.received', message);

    // ---- 广播模式 ----
    if (message.to === '*') {
      return mode === 'sync' ? this.broadcast(message) : this.broadcastAsync(message);
    }

    const config = this.registry.get(message.to);
    if (!config) {
      return `[Router] Agent "${message.to}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    log.info(
      `[Router] ${message.from} → ${message.to} [${message.type}]` +
      (message.correlation_id ? ` (cid: ${message.correlation_id})` : '') +
      (mode === 'async' ? ' (async)' : '')
    );

    // ---- 点到点投递 ----
    if (mode === 'async') {
      // fire-and-forget：不阻塞调用方
      this.dispatch(config, message).catch(err => {
        log.error(`[Router] 异步投递失败 ${message.from} → ${message.to}: ${err.message}`);
      });
      return `[Router] 消息已异步投递到 "${message.to}"`;
    }
    try {
      return await this.dispatch(config, message, signal);
    } catch (err: any) {
      return `[Router] 来自 "${message.to}" 的错误：${err.message}`;
    }
  }

  /**
   * 触发 Agent 自主推理（无 incoming 用户消息）。
   * Agent 仅基于 system prompt + history 推理；hint 经 <trigger> 注入。
   */
  async trigger(agentId: string, options?: TriggerOptions, signal?: AbortSignal): Promise<string> {
    // ---- 关机模式：不投递，转 pending ----
    if (this._shutdownMode) {
      const msg: RouterMessage = {
        from: 'system', to: agentId, type: 'trigger',
        payload: options?.hint ?? '', correlation_id: options?.source,
      };
      this._pendingMessages.push(msg);
      log.info(`[Router] 关机模式，trigger 入队 pending → ${agentId}`);
      return `[Router] 系统正在重启，trigger 已入队，重启后将自动投递。`;
    }

    const config = this.registry.get(agentId);
    if (!config) {
      return `[Router] Agent "${agentId}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    // ---- 虚拟 Agent：不支持自主推理 ----
    if (config.virtual) {
      const va = new VirtualAgent(config);
      const { content } = await va.trigger(options, signal);
      return content;
    }

    log.info(`[Router] trigger → ${agentId}` + (options?.source ? ` (source: ${options.source})` : ''));

    // 会话键：群组 trigger 按参与者隔离（group~<gid>~<agentId>，同群多 Agent 并行）；
    // 其余用 chat~<lo>~<hi>（lo/hi 排序，双方共享同一会话）
    const convKey = options?.group_id
      ? groupDialogKey(options.group_id, agentId)
      : chatDialogKey(options?.target ?? 'system', agentId);

    // ---- 串行化：同会话运行中 → hint 注入为 steer ----
    const active = this.running.get(convKey);
    if (active) {
      // 活跃会话已中止（中断/优雅关闭收尾中）：将死会话不会消费 steer，
      // 等待 runningMap 清理后新建会话，避免消息丢失。
      if (active.ctx.signal?.aborted) {
        await this.waitAbortedClear(convKey);
      } else if (options?.meta) {
        // 带 meta 的执行（如归档整理轮）不能降级为 steer——meta 是整次 run 的
        // 执行身份（runEnd 判定依赖），steer 只携带 hint 文本、会丢失 meta。
        // 等待当前 run 结束后作为独立 run 重试，保证 meta 完整传递到 ctx。
        log.info(`[Router] "${agentId}" 正在自主推理，带 meta 的触发等待当前 run 结束后重试`);
        const idle = await this.waitSessionIdle(convKey);
        if (!idle) {
          log.warn(`[Router] 带 meta 的触发等待超时，放弃（${agentId}，source=${options?.source ?? '?'}）`);
          return `[Router] "${agentId}" 会话繁忙，带 meta 的触发已放弃（等待 190s 超时）。`;
        }
        return this.trigger(agentId, options, signal);
      } else {
        const hintSteer = this.makeHintSteer(options);
        if (hintSteer) {
          this.assembly.engine.pushSteer(active.ctx, hintSteer);
          log.info(`[Router] "${agentId}" 正在自主推理，新触发已注入为转向消息`);
        }
        return `[Router] "${agentId}" 正在自主推理，新触发已注入。`;
      }
    }

    const controller = this.makeController(signal);
    const ctx = createAgentContext(config, this.assembly, {
      dialogId: convKey,
      signal: controller.signal,
      maxTurns: options?.maxTurns,
      deepThink: options?.deepThink,
      meta: options?.meta,
    });

    // hint 注入：作为 trigger 角色消息（wrapHint=false → 普通 user 文本）
    const hintSteer = this.makeHintSteer(options);
    if (hintSteer) this.assembly.engine.pushSteer(ctx, hintSteer);

    return this.runWithGate(convKey, config.agent_id, ctx, controller);
  }

  // ============================================================
  // 内部：分发 / 串行化 / 广播
  // ============================================================

  /**
   * 分发到单个 Agent（虚拟/真实统一路径）：
   *   · createAgentContext（虚拟 Agent 注入空 LLM）→ 串行化门 + runWithGate → loop.run
   *   · 虚拟 Agent 额外：emit chat.virtual.receive 推送 + 空结果兜底回执
   * @param extraSteer 同会话追加消息（flush 合并用）：作为初始 steer，loop 首轮消费
   */
  private async dispatch(
    config: AgentConfig,
    message: RouterMessage,
    signal?: AbortSignal,
    extraSteer: RouterMessage[] = [],
  ): Promise<string> {

    // ---- 串行化 + steer 注入：同会话运行中 → pushSteer 到活跃 ctx ----
    const convKey = message.group_id ? groupDialogKey(message.group_id, message.to) : chatDialogKey(message.from, message.to);
    const active = this.running.get(convKey);
    if (active) {
      // 活跃会话已中止（中断/优雅关闭收尾中）：将死会话不会消费 steer，
      // 等待 runningMap 清理后新建会话，避免消息丢失。
      if (active.ctx.signal?.aborted) {
        await this.waitAbortedClear(convKey);
      } else {
        this.assembly.engine.pushSteer(active.ctx, this.toSteerMessage(message));
        for (const m of extraSteer) this.assembly.engine.pushSteer(active.ctx, this.toSteerMessage(m));
        log.info(`[Router] ${message.to} 正在处理上一条消息，已注入为转向消息（conv=${convKey}）`);
        return `[Router] "${message.to}" 正在处理上一条消息，本条已注入为转向消息。`;
      }
    }

    const controller = this.makeController(signal);
    const ctx = createAgentContext(config, this.assembly, {
      currentMessage: { role: 'user', content: message.payload, agent_id: message.from },
      dialogId: convKey,
      signal: controller.signal,
    });
    // 同会话合并：追加消息作为初始 steer（loop 首轮消费，不依赖运行时机）
    for (const m of extraSteer) this.assembly.engine.pushSteer(ctx, this.toSteerMessage(m));

    const content = await this.runWithGate(convKey, config.agent_id, ctx, controller);

    // 虚拟 Agent（无 LLM）：与真实 Agent 统一 run 流程——createAgentContext 注入空 LLM
    // （不误用默认模型），loop 空回复不 record、runEnd saveSession 落盘 currentMessage。
    // 此处仅补充两件事：
    //   1. 实时推送 emit chat.virtual.receive —— L5 WS 层监听 router 'message' 广播到前端，
    //      前端在 user 对话中实时显示发送方 Agent 的消息；
    //   2. 空结果兜底回执（send_agent 工具拿到确认文本，而非空字符串）。
    if (config.virtual) {
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
      return content || `[VirtualAgent] "${config.agent_id}" 已收到消息。`;
    }

    return content;
  }

  /** 构造 steer 消息（运行中注入 / 合并投递共用） */
  private toSteerMessage(m: RouterMessage): AgentMessage {
    return { role: 'user', content: m.payload, agent_id: m.from, timestamp: new Date().toISOString() };
  }

  /**
   * 构造 trigger hint 的 steer 消息（运行中注入 / 启动注入共用）。
   * wrapHint=false → 普通 user 文本；缺省 → role='trigger' + `<trigger>` 标签（LLM 渲染约定 + 旧数据兼容）。
   */
  private makeHintSteer(options?: TriggerOptions): AgentMessage | undefined {
    if (!options?.hint) return undefined;
    const wrap = options.wrapHint !== false;
    return {
      role: wrap ? 'trigger' : 'user',
      content: wrap ? `<trigger>${options.hint}</trigger>` : options.hint,
    };
  }

  /**
   * 串行化门：注册活跃会话 → loop.run → 清理。
   * run() 内部已内置兜底（fallbackHook/handleFatal 不抛），此方法保证
   * runningMap 无论成功失败都清理，且并发消息经 pushSteer 注入活跃 ctx。
   * 引用保护：仅当 runningMap 仍指向本 entry 才删除 —— 避免超时等待后
   * 新建会话覆盖旧 entry 时，旧 loop 收尾误删新会话。
   */
  private async runWithGate(
    convKey: string,
    agentId: string,
    ctx: CurrentContext,
    controller: AbortController,
  ): Promise<string> {
    const entry = { ctx, controller, agentId };
    this.running.set(convKey, entry);
    try {
      const result = await this.assembly.engine.run(ctx);
      // restart-requested（system_restart 工具）：入队"继续会话"消息 + 进入关机模式 + 请求后端重启。
      // 对齐旧架构：重启后 flushPendingMessages 重投 → Agent 基于对话历史自动继续（不丢会话）。
      if (result.interruptReason?.type === 'restart-requested') {
        const reason = result.interruptReason.reason;
        try {
          // trigger 语义（非普通 user 消息）：系统自动注入的恢复信号，重启后 Agent 基于对话历史继续。
          // from=system（系统触发，区别于用户消息）；data.target=原会话对方，
          // 使 trigger 落回重启前的会话（chatDialogKey(target, agentId)）以加载历史。
          this.enqueuePending({
            from: 'system',
            to: agentId,
            type: 'trigger',
            payload: `系统已重启完成。请基于对话历史继续（重启前 Agent 请求了重启${reason ? `：${reason}` : ''}）。`,
            correlation_id: `restart-continue-${Date.now()}`,
            data: { target: ctx.currentMessage?.agent_id ?? 'user' },
          });
          this.enterShutdownMode();
          log.warn(`[Router] Agent "${agentId}" 请求重启：已入队继续会话 trigger，进入关机模式`);
        } catch (err: any) {
          log.error(`[Router] 处理 restart-requested 失败: ${err?.message || String(err)}`);
        }
        this.assembly.requestRestart?.(reason ?? `agent-${agentId}-restart`);
      }
      return result.content;
    } finally {
      if (this.running.get(convKey) === entry) this.running.delete(convKey);
    }
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
   * 用于带 meta 的执行（归档整理轮）在会话空闲后作为独立 run 重试。
   * 上限 190s（对齐 LLM 180s 超时兜底 + 余量）；超时后放弃（调用方 fallbackHook 兜底）。
   * @returns true=会话已空闲；false=超时放弃
   */
  private async waitSessionIdle(convKey: string): Promise<boolean> {
    const deadline = Date.now() + 190_000;
    while (this.running.has(convKey)) {
      if (Date.now() >= deadline) {
        log.warn(`[Router] 等待会话空闲超时（190s）→ ${convKey}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
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

  /** 广播消息到所有 Agent（除发送者）：不同目标（不同会话）并行投递，结果按注册顺序汇总 */
  private async broadcast(message: RouterMessage): Promise<string> {
    const targets = this.registry.listIds().filter(id => id !== message.from);
    const results = await Promise.all(targets.map(async (targetId) => {
      const config = this.registry.get(targetId);
      if (!config) return '';
      const resp = await this.dispatch(config, { ...message, to: targetId, type: 'request' });
      return `[${targetId}] ${resp}`;
    }));
    return results.filter(Boolean).join('\n');
  }

  /** 异步广播：fire-and-forget 投递到所有目标（除发送者） */
  private async broadcastAsync(message: RouterMessage): Promise<string> {
    const targets = this.registry.listIds().filter(id => id !== message.from);
    for (const targetId of targets) {
      const config = this.registry.get(targetId);
      if (!config) continue;
      this.dispatch(config, { ...message, to: targetId, type: 'request' }).catch(err => {
        log.error(`[Router] 异步广播投递失败 ${message.from} → ${targetId}: ${err.message}`);
      });
    }
    return `[Router] 已异步投递到 ${targets.length} 个 Agent`;
  }
}
