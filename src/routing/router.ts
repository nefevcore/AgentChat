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
import { AgentMessage } from '@core/types';
import { AgentRegistry } from './registry';

export class AgentRouter extends EventEmitter {
  private registry: AgentRegistry;
  private maxHops: number;

  /** 记录已处理的消息 correlation_id，防止死循环 */
  private seenCorrelationIds = new Set<string>();

  /** 每个 Agent 当前活跃的 AbortController（用于软中断） */
  private activeSessions = new Map<string, AbortController>();

  constructor(registry: AgentRegistry, maxHops = 5) {
    super();
    this.registry = registry;
    this.maxHops = maxHops;
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
   * 发送消息到目标 Agent
   * @param message 电话协议消息
   * @param signal 可选：AbortSignal，关联到此会话的取消控制器
   * @returns 目标 Agent 的响应
   */
  async send(message: AgentMessage, signal?: AbortSignal): Promise<string> {
    // ---- 死循环防护 1: correlation_id 去重 ----
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
    // 虚拟 Agent（如 user）不能 receive，消息到虚拟 Agent 由 emitter 直接处理
    if (this.registry.isVirtual(message.to)) {
      console.log(
        `[Router] ${message.from} → ${message.to} (virtual) [${message.type}]` +
        (message.correlation_id ? ` (cid: ${message.correlation_id})` : '')
      );
      return `[Router] 已送达虚拟 Agent "${message.to}"`;
    }

    const target = this.registry.getAgent(message.to);
    if (!target) {
      return `[Router] Agent "${message.to}" 未在注册表中找到。可用：${this.registry.listIds().join(', ')}`;
    }

    console.log(
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
