// ============================================================
// AgentRouter —�?电话交换�?
//
// 核心职责�?
//   1. 根据 message.to 查找目标 Agent
//   2. 调用 Agent.receive() 方法
//   3. 防止"电话死循�?（多 Agent 死锁）：
//      - maxHops: 最大转发次数（默认 5�?
//      - correlation_id 去重：相�?ID 不重复处�?
//   4. 通过 EventEmitter 发出 message 事件，供 MessageStore / WebUI 监听
// ============================================================

import { EventEmitter } from 'events';
import { AgentMessage, TriggerOptions } from '@core/types';
import { AgentRegistry } from './registry';
import { GroupManager } from './group-manager';
import { logger } from '../utils/logger';

export class AgentRouter extends EventEmitter {
  private registry: AgentRegistry;
  private groupManager: GroupManager | null = null;
  private maxHops: number;

  /** 记录已处理的消息 correlation_id，防止死循环 */
  private seenCorrelationIds = new Set<string>();

  /** 每个 Agent 当前活跃�?AbortController（用于软中断�?*/
  private activeSessions = new Map<string, AbortController>();

  constructor(registry: AgentRegistry, maxHops = 5) {
    super();
    this.registry = registry;
    this.maxHops = maxHops;
  }

  /** 获取所有已注册 Agent �?ID 列表（含虚拟 Agent�?*/
  getAgentIds(): string[] {
    return this.registry.listIds();
  }

  /** 设置 GroupManager（由 bootstrap 注入�?*/
  setGroupManager(rm: GroupManager): void {
    this.groupManager = rm;

    // 监听房间 trigger 事件，通过 router.trigger() 通知 Agent
    rm.on('group.trigger', (delivery: {
      group_id: string;
      room_name: string;
      from: string;
      to: string;
      payload: string;
      correlation_id?: string;
      data?: Record<string, any>;
    }) => {
      // 虚拟 Agent 不需�?trigger
      if (this.registry.isVirtual(delivery.to)) {
        return;
      }

      const target = this.registry.getAgent(delivery.to);
      if (!target) return;

      // 构�?trigger hint：告�?Agent 群聊有新消息�?
      // 注意：hint 中的关键词直接影�?LLM 对工具的联想。必须使�?群聊"
      // 等与 send_group 工具名一致的词汇�?
      const senderName = this.registry.getAgent(delivery.from)?.name
        ?? this.registry.getAgentName?.(delivery.from)
        ?? delivery.from;

      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      const hint = `[群聊 ${delivery.group_id}] ${senderName} 发来消息�?{delivery.payload}\n\n（当前时�? ${ts}，星�?{['�?,'一','�?,'�?,'�?,'�?,'�?][now.getDay()]}）\n\n使用 send_group 工具回复。`;

      this.trigger(delivery.to, {
        hint,
        source: `group:${delivery.group_id}`,
        target: delivery.group_id,
        group_id: delivery.group_id,
      }).catch(err => {
        logger.error(`[Router] 房间 trigger 失败 ${delivery.from} �?${delivery.to}: ${err.message}`);
      });
    });
  }

  /** 获取 GroupManager */
  getGroupManager(): GroupManager | null {
    return this.groupManager;
  }

  /**
   * 取消指定 Agent 的当前活跃会�?
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
   * 检查指�?Agent 是否有活跃会�?
   */
  hasActiveSession(agentId: string): boolean {
    return this.activeSessions.has(agentId);
  }

  /**
   * 触发 Agent 自主推理（无 incoming 用户消息）�?
   *
   * �?send() 的区别：不走消息协议，不构�?currentMessage�?
   * Agent 仅基�?system prompt + history 进行推理�?
   *
   * @param agentId - 目标 Agent ID
   * @param options - 触发选项（maxTurns、deepThink、hint 等）
   * @param externalSignal - 可选的外部 AbortSignal，用于中�?trigger 会话
   * @returns Agent 的推理结�?
   */
  async trigger(agentId: string, options?: TriggerOptions, externalSignal?: AbortSignal): Promise<string> {
    const target = this.registry.getAgent(agentId);
    if (!target) {
      return `[Router] Agent "${agentId}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    logger.info(
      `[Router] trigger �?${agentId}` +
      (options?.source ? ` (source: ${options.source})` : '')
    );

    // �?trigger 会话创建 AbortController（与 send() 共享 activeSessions�?
    const controller = new AbortController();
    this.activeSessions.set(agentId, controller);

    // 链接外部信号 �?内部 controller
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
   * @param signal 可选：AbortSignal，关联到此会话的取消控制�?
   * @returns 目标 Agent 的响�?
   */
  async send(message: AgentMessage, signal?: AbortSignal): Promise<string> {
    // ---- 群组消息：委托给 GroupManager 投�?---- 
    if (message.group_id && this.groupManager) {
      try {
        const result = this.groupManager.deliverGroupMessage(message as import('@core/types').GroupMessage);
        return `[Group] 消息已投递到房间 "${message.group_id}"，已触发 ${result.triggered.length} 个参与者`;
      } catch (err: any) {
        return `[Group] 群组消息投递失败：${err.message}`;
      }
    }
    if (message.correlation_id) {
      if (this.seenCorrelationIds.has(message.correlation_id)) {
        return `[Router] 消息 correlation_id "${message.correlation_id}" 已处�?�?已阻止以防止无限循环。`;
      }
      this.seenCorrelationIds.add(message.correlation_id);

      // 清理过旧�?ID（保留最�?200 条）
      if (this.seenCorrelationIds.size > 200) {
        const toDelete = Array.from(this.seenCorrelationIds).slice(0, 100);
        for (const id of toDelete) {
          this.seenCorrelationIds.delete(id);
        }
      }
    }

    // ---- 死循环防�?2: maxHops ----
    const hopCount = this.parseHopCount(message);
    if (hopCount > this.maxHops) {
      return `[Router] 超过最大跳�?(${this.maxHops}) �?已阻止以防止无限递归。`;
    }

    // ---- 触发 message 事件（供 MessageStore / WebUI 监听�?----
    this.emit('message', message);

    // ---- 广播模式 ----
    if (message.to === '*') {
      return this.broadcast(message);
    }

    // ---- 点对点模�?----
    const target = this.registry.getAgent(message.to);
    if (!target) {
      return `[Router] Agent "${message.to}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    logger.info(
      `[Router] ${message.from} �?${message.to} [${message.type}]` +
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
   * 异步投递消息（fire-and-forget）：不等待目�?Agent 回复即返回�?
   * 适用于对话已建立的场景，Agent 会自行回复�?
   * @param message 电话协议消息
   * @returns 投递确认字符串
   */
  async sendAsync(message: AgentMessage): Promise<string> {
    // ---- 群组消息：委托给 GroupManager 投�?----
    if (message.group_id && this.groupManager) {
      try {
        const result = this.groupManager.deliverGroupMessage(message as import('@core/types').GroupMessage);
        return `[Group] 消息已投递到房间 "${message.group_id}"，已触发 ${result.triggered.length} 个参与者`;
      } catch (err: any) {
        return `[Group] 群组消息投递失败：${err.message}`;
      }
    }

    if (message.correlation_id) {
      if (this.seenCorrelationIds.has(message.correlation_id)) {
        return `[Router] 消息 correlation_id "${message.correlation_id}" 已处�?�?已阻止以防止无限循环。`;
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
      return `[Router] 超过最大跳�?(${this.maxHops}) �?已阻止以防止无限递归。`;
    }

    this.emit('message', message);

    if (message.to === '*') {
      // 广播模式：异步投递到所有目�?
      const targets = this.registry.listIds().filter((id) => id !== message.from);
      for (const targetId of targets) {
        const agent = this.registry.getAgent(targetId);
        if (agent) {
          agent.receive({ ...message, to: targetId, type: 'request' }).catch(err => {
            logger.error(`[Router] 异步广播投递失�?${message.from} �?${targetId}: ${err.message}`);
          });
        }
      }
      return `[Router] 已异步投递到 ${targets.length} �?Agent`;
    }

    const target = this.registry.getAgent(message.to);
    if (!target) {
      return `[Router] Agent "${message.to}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    logger.info(
      `[Router] ${message.from} �?${message.to} [${message.type}] (async)` +
      (message.correlation_id ? ` (cid: ${message.correlation_id})` : '')
    );

    // VirtualAgent �?LLM 推理，receive() 极快（纯内存 + 文件读取），
    // 改为 await 以确保其 deferMessage() �?sendAsync 返回前完成，
    // 消除与发送方 postHook 的写入竞态�?
    if (this.registry.isVirtual(message.to)) {
      try {
        await target.receive(message);
      } catch (err: any) {
        logger.error(`[Router] VirtualAgent 异步投递失�?${message.from} �?${message.to}: ${err.message}`);
      }
    } else {
      // 真实 Agent：fire-and-forget，不等待 LLM 推理
      target.receive(message).catch(err => {
        logger.error(`[Router] 异步投递失�?${message.from} �?${message.to}: ${err.message}`);
      });
    }

    return `[Router] 消息已异步投递到 "${message.to}"`;
  }

  /**
   * 广播消息到所�?Agent（除发送者）
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
   * 从消息中解析跳数（通过 correlation_id 中的 `/hop:N` 后缀�?
   */
  private parseHopCount(message: AgentMessage): number {
    if (!message.correlation_id) return 1;
    const match = message.correlation_id.match(/\/hop:(\d+)$/);
    return match ? parseInt(match[1], 10) : 1;
  }
}
