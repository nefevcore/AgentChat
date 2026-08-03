// ============================================================
// AgentRouter —— 电话交换机
//
// 核心职责：
//   1. 根据 message.to 查找目标 Agent
//   2. 调用 Agent.receive() 方法
//   3. 防止"电话死循环"（多 Agent 死锁）：
//      - maxHops: 最大转发次数（默认 5）
//      - correlation_id 去重：相同 ID 不重复处理
//   4. 通过 EventEmitter 发出 message 事件，供 MessageStore / WebUI 监听
// ============================================================

import { EventEmitter } from 'events';
import { AgentMessage, TriggerOptions } from '@core/types';
import { getGlobalConfig } from '@core/config';
import { AgentRegistry } from './registry';
import { GroupManager } from './group-manager';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export class AgentRouter extends EventEmitter {
  private registry: AgentRegistry;
  private groupManager: GroupManager | null = null;
  private maxHops: number;

  /** 记录已处理的消息 correlation_id，防止死循环 */
  private seenCorrelationIds = new Set<string>();

  /** 每个 Agent 当前活跃的 AbortController（用于软中断） */
  private activeSessions = new Map<string, AbortController>();

  /**
   * 重启模式：为 true 时新消息进入 pending 队列（不投递），
   * 由 gracefulShutdown 落盘、重启后 flush 重新投递。
   */
  private _restartMode = false;
  private _pendingMessages: AgentMessage[] = [];
  /** 网络失效模式：网络异常时新消息入队，恢复后重投（区别于重启模式的进程级 pending） */
  private _networkDown = false;
  private _networkDownMessages: AgentMessage[] = [];
  private _networkProbeTimer: NodeJS.Timeout | null = null;
  /** 连续网络错误计数（>=2 才进入 down，防单次抖动） */
  private _networkErrStreak = 0;
  /** 上次网络错误时间戳（时间窗口判定：5 分钟内连续才累计） */
  private _lastNetworkErrTime = 0;
  /** 网络错误时间窗口（毫秒） */
  private static readonly NETWORK_ERR_WINDOW = 5 * 60 * 1000;

  constructor(registry: AgentRegistry, maxHops = 5) {
    super();
    this.registry = registry;
    this.maxHops = maxHops;
  }

  /** 是否处于重启模式（禁止投递，消息入队） */
  isRestartMode(): boolean {
    return this._restartMode;
  }

  /**
   * 主动入队 pending（供 Agent 请求重启时塞"继续会话"消息）。
   * 无论是否在重启模式都入队；若已进入重启模式立即落盘。
   * @returns 当前 pending 队列长度
   */
  enqueuePending(message: AgentMessage): number {
    this._pendingMessages.push(message);
    logger.info(`[Router] 消息入队 pending (${message.from} → ${message.to})，当前 ${this._pendingMessages.length} 条`);
    if (this._restartMode) {
      // 已进入重启模式：立即落盘，确保进程退出时 pending 不丢
      try {
        const file = this.pendingFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, this._pendingMessages.map(m => JSON.stringify(m)).join('\n'), 'utf-8');
        logger.notice(`[Router] pending 已落盘: ${this._pendingMessages.length} 条 → ${file}`);
      } catch (err: any) {
        logger.error(`[Router] pending 落盘失败: ${err.message}`);
      }
    }
    return this._pendingMessages.length;
  }

  /**
   * 进入重启模式：后续 send/sendAsync/trigger 的消息不再投递，进入 pending 队列。
   * 同时将 pending 落盘（重启是进程级，内存会在退出时丢失）。
   */
  enterRestartMode(): void {
    if (this._restartMode) return;
    this._restartMode = true;
    logger.notice(`[Router] 进入重启模式，后续消息将进入 pending 队列`);
    try {
      const file = this.pendingFilePath();
      if (this._pendingMessages.length > 0) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, this._pendingMessages.map(m => JSON.stringify(m)).join('\n'), 'utf-8');
        logger.notice(`[Router] pending 消息已落盘: ${this._pendingMessages.length} 条 → ${file}`);
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err: any) {
      logger.error(`[Router] pending 落盘失败: ${err.message}`);
    }
  }

  /**
   * 通知网络异常（由 LLM 调用识别网络类错误时调用）。
   * 连续多次网络错误才进入 network-down，防止单次抖动误伤。
   */
  notifyNetworkError(): void {
    const now = Date.now();
    // 时间窗口：超过 5 分钟的错误不累计（跨天两次偶然错误不该触发全局 down）
    if (now - this._lastNetworkErrTime > AgentRouter.NETWORK_ERR_WINDOW) {
      this._networkErrStreak = 0;
    }
    this._lastNetworkErrTime = now;
    this._networkErrStreak++;
    if (this._networkDown) return; // 已在 down，无需重复
    if (this._networkErrStreak >= 2) {
      this._networkDown = true;
      logger.notice(`[Router] 检测到连续 ${this._networkErrStreak} 次网络错误，进入网络失效模式，新消息将入队`);
      // 启动探测定时器：每 30s 尝试恢复
      this._startNetworkProbe();
    }
  }

  /**
   * 网络探测：进入 down 后每 30s 尝试一次轻量连通性探测（fetch 任一 LLM baseURL），
   * 成功即退出 down 模式并重投入队消息。
   */
  private _startNetworkProbe(): void {
    if (this._networkProbeTimer) return;
    this._networkErrStreak = 0;
    this._networkProbeTimer = setInterval(async () => {
      try {
        // 取任一 LLM provider 的 base_url 做连通性探测（HEAD 请求，不消耗 token）
        const providers = getGlobalConfig().llmProviders ?? {};
        const baseUrl = (Object.values(providers)[0] as any)?.base_url;
        if (!baseUrl) return; // 无 provider，保持 down 等待
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          await fetch(baseUrl, { method: 'HEAD', signal: controller.signal });
        } finally { clearTimeout(timer); }
        // 能连上 → 恢复
        logger.notice('[Router] 网络探测成功，退出网络失效模式');
        await this.notifyNetworkRecover();
      } catch (err: any) {
        logger.debug(`[Router] 网络探测失败（仍失效）: ${err.message}`);
      }
    }, 30_000);
  }

  /**
   * 通知网络恢复：退出 down 模式，重投入队消息。
   * 由外部（Agent LLM 调用成功 / 定时探测成功）调用。
   */
  async notifyNetworkRecover(): Promise<number> {
    if (!this._networkDown) return 0;
    this._networkDown = false;
    this._networkErrStreak = 0;
    if (this._networkProbeTimer) { clearTimeout(this._networkProbeTimer); this._networkProbeTimer = null; }
    const pending = this._networkDownMessages;
    this._networkDownMessages = [];
    if (pending.length === 0) return 0;
    logger.notice(`[Router] 网络已恢复，重投 ${pending.length} 条入队消息`);
    let sent = 0;
    for (const msg of pending) {
      try { await this.send(msg); sent++; }
      catch (err: any) { logger.error(`[Router] 网络恢复重投失败 ${msg.from} → ${msg.to}: ${err.message}`); }
    }
    return sent;
  }

  /** 当前网络是否失效 */
  isNetworkDown(): boolean { return this._networkDown; }

  /**
   * 退出重启模式并重投 pending 消息（重启后 bootstrap 调用）。
   * @returns 重投的消息条数
   */
  async flushPendingMessages(): Promise<number> {
    // 先读盘（若进程已重启，内存 pending 为空，需从文件恢复）
    const file = this.pendingFilePath();
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8');
        const loaded = content.split('\n').filter(Boolean).map(l => {
          try { return JSON.parse(l) as AgentMessage; } catch { return null; }
        }).filter((m): m is AgentMessage => m != null);
        this._pendingMessages.push(...loaded);
        fs.unlinkSync(file);
      }
    } catch (err: any) {
      logger.error(`[Router] pending 文件读取失败: ${err.message}`);
    }

    this._restartMode = false;
    const pending = this._pendingMessages;
    this._pendingMessages = [];
    if (pending.length === 0) return 0;

    logger.notice(`[Router] 重启完成，重投 ${pending.length} 条 pending 消息`);
    let sent = 0;
    for (const msg of pending) {
      try {
        // 重投时绕过重启模式（已关闭），异步投递避免阻塞
        await this.send(msg);
        sent++;
      } catch (err: any) {
        logger.error(`[Router] pending 重投失败 ${msg.from} → ${msg.to}: ${err.message}`);
      }
    }
    return sent;
  }

  private pendingFilePath(): string {
    const ws = process.env.AGENTCHAT_WORKSPACE || 'workspace/default';
    return path.resolve(process.cwd(), ws, '.router_pending.jsonl');
  }

  /** 获取所有已注册 Agent 的 ID 列表（含虚拟 Agent） */
  getAgentIds(): string[] {
    return this.registry.listIds();
  }

  /** 设置 GroupManager（由 bootstrap 注入） */
  setGroupManager(rm: GroupManager): void {
    this.groupManager = rm;

    // 监听房间 trigger 事件，通过 router.trigger() 通知 Agent。
    // 2026-08-03：群聊投递用 trigger 语义（role='trigger'，由 agent.ts 包 <trigger>），
    // hint 内部消息体统一 <msg> 标签（与历史加载 loadGroupHistory 同构，含 group 群名）。
    // 教训 1：hint 太弱 → Agent 只输出文本不调 send_group。
    // 教训 2：强制"务必调用" → 全员刷屏回声循环。
    // 教训 3：改 send 语义（role='user' 不包 <trigger>）→ 嵌套 <msg> 死循环
    //        （Agent 把收到的 <msg> 标签原样复制回群聊，层层叠加）。
    // 结论：trigger 外壳（标明是系统触发的新消息）+ <msg> 消息体（标明群聊来源），
    //       引导平衡（值得才回），并明确"勿复制标签、只发自己内容"防嵌套。
    rm.on('group.trigger', (delivery: {
      group_id: string;
      group_name: string;
      from: string;
      to: string;
      payload: string;
      correlation_id?: string;
      data?: Record<string, any>;
    }) => {
      // 虚拟 Agent 不需要 trigger
      if (this.registry.isVirtual(delivery.to)) {
        return;
      }

      const target = this.registry.getAgent(delivery.to);
      if (!target) return;

      // 发送者显示名 + 群名
      const senderName = this.registry.getAgent(delivery.from)?.name
        ?? this.registry.getAgentName?.(delivery.from)
        ?? delivery.from;
      const groupName = delivery.group_name || delivery.group_id;

      // hint：<msg> 消息体 + 明确动作提示。
      // 2026-08-03 修复「空转」：直接输出文本不会投递到群聊（须调 reply_group/send_group 才进 messages.jsonl），
      // 见 sessions/news/group__*/archive/history_2026-W32.jsonl。引导保持平衡（教训 2：强制"务必调用"
      // → 全员刷屏回声循环，故保留沉默选项）。主推 reply_group（回复语义清晰，测试14 全员自动使用）。
      const hint = `<msg from="${delivery.from}" name="${senderName}" group="${groupName}">${delivery.payload}</msg>` +
        `\n\n（收到群聊消息：若值得回应，请调用工具 reply_group 把回复发回群聊——直接输出文本不会发送到群聊、其他成员看不到；若无话可说则保持沉默。）`;

      this.trigger(delivery.to, {
        hint,
        source: `group:${delivery.group_id}`,
        target: delivery.group_id,
        group_id: delivery.group_id,
      }).catch(err => {
        logger.error(`[Router] 房间 trigger 失败 ${delivery.from} → ${delivery.to}: ${err.message}`);
      });
    });
  }

  /** 获取 GroupManager */
  getGroupManager(): GroupManager | null {
    return this.groupManager;
  }

  /**
   * 取消指定 Agent 的当前活跃会话
   * @returns 是否有活跃会话被取消
   */
  abortSession(agentId: string): boolean {
    const controller = this.activeSessions.get(agentId);
    if (controller) {
      controller.abort();
      this.activeSessions.delete(agentId);
      return true;
    }
    return false;
  }

  /**
   * 检查指定 Agent 是否有活跃会话
   */
  hasActiveSession(agentId: string): boolean {
    return this.activeSessions.has(agentId);
  }

  /**
   * 触发 Agent 自主推理（无 incoming 用户消息）。
   *
   * 与 send() 的区别：不走消息协议，不构造 currentMessage，
   * Agent 仅基于 system prompt + history 进行推理。
   *
   * @param agentId - 目标 Agent ID
   * @param options - 触发选项（maxTurns、deepThink、hint 等）
   * @param externalSignal - 可选的外部 AbortSignal，用于中断 trigger 会话
   * @returns Agent 的推理结果
   */
  async trigger(agentId: string, options?: TriggerOptions, externalSignal?: AbortSignal): Promise<string> {
    // ---- 重启模式：不投递，转 send 走 pending 队列 ----
    if (this._restartMode) {
      const msg: AgentMessage = {
        from: 'system',
        to: agentId,
        type: 'trigger' as any,
        payload: options?.hint ?? '',
        correlation_id: options?.source,
      };
      this._pendingMessages.push(msg);
      logger.info(`[Router] 重启模式，trigger 入队 pending → ${agentId}`);
      return `[Router] 系统正在重启，trigger 已入队，重启后将自动投递。`;
    }
    // ---- 网络失效模式：trigger 入队，恢复后重投 ----
    if (this._networkDown) {
      const msg: AgentMessage = {
        from: 'system',
        to: agentId,
        type: 'trigger' as any,
        payload: options?.hint ?? '',
        correlation_id: options?.source,
      };
      this._networkDownMessages.push(msg);
      logger.info(`[Router] 网络失效，trigger 入队 → ${agentId}，当前 ${this._networkDownMessages.length} 条`);
      return `[Router] 网络异常，trigger 已入队，网络恢复后将自动投递。`;
    }

    const target = this.registry.getAgent(agentId);
    if (!target) {
      return `[Router] Agent "${agentId}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    logger.info(
      `[Router] trigger → ${agentId}` +
      (options?.source ? ` (source: ${options.source})` : '')
    );

    // 为 trigger 会话创建 AbortController（与 send() 共享 activeSessions）
    const controller = new AbortController();
    this.activeSessions.set(agentId, controller);

    // 链接外部信号 → 内部 controller
    const onExternalAbort = () => { controller.abort(); };
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    try {
      const { content } = await target.trigger(options, controller.signal);
      return content;
    } catch (err: any) {
      return `[Router] 自主推理错误 (${agentId}): ${err.message}`;
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      this.activeSessions.delete(agentId);
    }
  }

  /**
   * 发送消息到目标 Agent
   * @param message 电话协议消息
   * @param signal 可选：AbortSignal，关联到此会话的取消控制器
   * @returns 目标 Agent 的响应
   */
  async send(message: AgentMessage, signal?: AbortSignal): Promise<string> {
    // ---- 重启模式：不投递，进 pending 队列（重启后 flush 重投）----
    if (this._restartMode) {
      this._pendingMessages.push(message);
      logger.info(`[Router] 重启模式，消息入队 pending (${message.from} → ${message.to})，当前 ${this._pendingMessages.length} 条`);
      return `[Router] 系统正在重启，消息已入队，重启后将自动投递。`;
    }
    // ---- 网络失效模式：消息入队，恢复后重投 ----
    if (this._networkDown) {
      this._networkDownMessages.push(message);
      logger.info(`[Router] 网络失效，消息入队 (${message.from} → ${message.to})，当前 ${this._networkDownMessages.length} 条`);
      return `[Router] 网络异常，消息已入队，网络恢复后将自动投递。`;
    }

    // ---- 群组消息：委托给 GroupManager 投递 ---- 
    if (message.group_id && this.groupManager) {
      try {
        const result = await this.groupManager.deliverGroupMessage(message as import('@core/types').GroupMessage);
        return `[Group] 消息已投递到群组 "${message.group_id}"，已触发 ${result.triggered.length} 个参与者`;
      } catch (err: any) {
        return `[Group] 群组消息投递失败：${err.message}`;
      }
    }
    if (message.correlation_id) {
      if (this.seenCorrelationIds.has(message.correlation_id)) {
        return `[Router] 消息 correlation_id "${message.correlation_id}" 已处理 — 已阻止以防止无限循环。`;
      }
      this.seenCorrelationIds.add(message.correlation_id);

      // 清理过旧的 ID（保留最近 200 条）
      if (this.seenCorrelationIds.size > 200) {
        const toDelete = Array.from(this.seenCorrelationIds).slice(0, 100);
        for (const id of toDelete) {
          this.seenCorrelationIds.delete(id);
        }
      }
    }

    // ---- 死循环防护 2: maxHops ----
    const hopCount = this.parseHopCount(message);
    if (hopCount > this.maxHops) {
      return `[Router] 超过最大跳数 (${this.maxHops}) — 已阻止以防止无限递归。`;
    }

    // ---- 触发 message 事件（供 MessageStore / WebUI 监听） ----
    this.emit('message', message);

    // ---- 广播模式 ----
    if (message.to === '*') {
      return this.broadcast(message);
    }

    // ---- 点对点模式 ----
    const target = this.registry.getAgent(message.to);
    if (!target) {
      return `[Router] Agent "${message.to}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    logger.info(
      `[Router] ${message.from} → ${message.to} [${message.type}]` +
      (message.correlation_id ? ` (cid: ${message.correlation_id})` : '')
    );

    try {
      const { content } = await target.receive(message, signal);
      return content;
    } catch (err: any) {
      return `[Router] 来自 "${message.to}" 的错误：${err.message}`;
    }
  }

  /**
   * 异步投递消息（fire-and-forget）：不等待目标 Agent 回复即返回。
   * 适用于对话已建立的场景，Agent 会自行回复。
   * @param message 电话协议消息
   * @returns 投递确认字符串
   */
  async sendAsync(message: AgentMessage): Promise<string> {
    // ---- 重启模式：不投递，进 pending 队列 ----
    if (this._restartMode) {
      this._pendingMessages.push(message);
      logger.info(`[Router] 重启模式，消息入队 pending (${message.from} → ${message.to})`);
      return `[Router] 系统正在重启，消息已入队，重启后将自动投递。`;
    }
    // ---- 网络失效模式：消息入队，恢复后重投 ----
    if (this._networkDown) {
      this._networkDownMessages.push(message);
      logger.info(`[Router] 网络失效，消息入队 (${message.from} → ${message.to})，当前 ${this._networkDownMessages.length} 条`);
      return `[Router] 网络异常，消息已入队，网络恢复后将自动投递。`;
    }

    // ---- 群组消息：委托给 GroupManager 投递 ----
    if (message.group_id && this.groupManager) {
      try {
        const result = await this.groupManager.deliverGroupMessage(message as import('@core/types').GroupMessage);
        return `[Group] 消息已投递到群组 "${message.group_id}"，已触发 ${result.triggered.length} 个参与者`;
      } catch (err: any) {
        return `[Group] 群组消息投递失败：${err.message}`;
      }
    }

    if (message.correlation_id) {
      if (this.seenCorrelationIds.has(message.correlation_id)) {
        return `[Router] 消息 correlation_id "${message.correlation_id}" 已处理 — 已阻止以防止无限循环。`;
      }
      this.seenCorrelationIds.add(message.correlation_id);

      if (this.seenCorrelationIds.size > 200) {
        const toDelete = Array.from(this.seenCorrelationIds).slice(0, 100);
        for (const id of toDelete) {
          this.seenCorrelationIds.delete(id);
        }
      }
    }

    const hopCount = this.parseHopCount(message);
    if (hopCount > this.maxHops) {
      return `[Router] 超过最大跳数 (${this.maxHops}) — 已阻止以防止无限递归。`;
    }

    this.emit('message', message);

    if (message.to === '*') {
      // 广播模式：异步投递到所有目标
      const targets = this.registry.listIds().filter((id) => id !== message.from);
      for (const targetId of targets) {
        const agent = this.registry.getAgent(targetId);
        if (agent) {
          agent.receive({ ...message, to: targetId, type: 'request' }).catch(err => {
            logger.error(`[Router] 异步广播投递失败 ${message.from} → ${targetId}: ${err.message}`);
          });
        }
      }
      return `[Router] 已异步投递到 ${targets.length} 个 Agent`;
    }

    const target = this.registry.getAgent(message.to);
    if (!target) {
      return `[Router] Agent "${message.to}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    logger.info(
      `[Router] ${message.from} → ${message.to} [${message.type}] (async)` +
      (message.correlation_id ? ` (cid: ${message.correlation_id})` : '')
    );

    // VirtualAgent 无 LLM 推理，receive() 极快（纯内存 + 文件读取），
    // 改为 await 以确保其 deferMessage() 在 sendAsync 返回前完成，
    // 消除与发送方 postHook 的写入竞态。
    if (this.registry.isVirtual(message.to)) {
      try {
        await target.receive(message);
      } catch (err: any) {
        logger.error(`[Router] VirtualAgent 异步投递失败 ${message.from} → ${message.to}: ${err.message}`);
      }
    } else {
      // 真实 Agent：fire-and-forget，不等待 LLM 推理
      target.receive(message).catch(err => {
        logger.error(`[Router] 异步投递失败 ${message.from} → ${message.to}: ${err.message}`);
      });
    }

    return `[Router] 消息已异步投递到 "${message.to}"`;
  }

  /**
   * 广播消息到所有 Agent（除发送者）
   */
  private async broadcast(message: AgentMessage): Promise<string> {
    const results: string[] = [];
    const targets = this.registry.listIds().filter((id) => id !== message.from);

    for (const targetId of targets) {
      const targetMsg: AgentMessage = {
        ...message,
        to: targetId,
        type: 'request',
      };
      const resp = await this.send(targetMsg);
      results.push(`[${targetId}] ${resp}`);
    }

    return results.join('\n');
  }

  /**
   * 从消息中解析跳数（通过 correlation_id 中的 `/hop:N` 后缀）
   */
  private parseHopCount(message: AgentMessage): number {
    if (!message.correlation_id) return 1;
    const match = message.correlation_id.match(/\/hop:(\d+)$/);
    return match ? parseInt(match[1], 10) : 1;
  }
}
