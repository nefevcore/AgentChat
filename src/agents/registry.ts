// ============================================================
// AgentRegistry —— Agent 注册表
// 存储所有 Agent 实例，提供查找能力
// 支持虚拟 Agent（VirtualAgent 实例，走 Hook 管道但无 LLM 推理）
// ============================================================

import { Agent } from '@core/loop';
import { VirtualAgent } from './virtual-agent';
import { logger } from '@utils/logger';

/** Agent 实例类型（真实或虚拟） */
export type AgentInstance = Agent | VirtualAgent;

/** 虚拟 Agent 元数据（已废弃：现在虚拟 Agent 也创建 VirtualAgent 实例） */
export interface VirtualAgentInfo {
  id: string;
  name: string;
}

export class AgentRegistry {
  private agents = new Map<string, AgentInstance>();
  /** 虚拟 Agent 元数据（兼容旧接口，实际以 agents Map 为准） */
  private virtualAgents = new Map<string, VirtualAgentInfo>();

  /** 注册 Agent 实例 */
  register(id: string, agent: Agent): void {
    if (this.agents.has(id)) {
      logger.warn(`[Registry] Agent "${id}" 已注册，正在覆盖`);
    }
    this.agents.set(id, agent);
    // 如果之前注册了同名的虚拟 Agent，移除元数据
    this.virtualAgents.delete(id);
    logger.info(`[Registry] 已注册 Agent：${id}`);
  }

  /** 注册虚拟 Agent（VirtualAgent 实例） */
  registerVirtual(agent: VirtualAgent): void {
    if (this.agents.has(agent.agentId)) {
      logger.warn(`[Registry] 虚拟 Agent "${agent.agentId}" 与真实 Agent 冲突，已跳过`);
      return;
    }
    this.agents.set(agent.agentId, agent);
    this.virtualAgents.set(agent.agentId, { id: agent.agentId, name: agent.name });
    logger.info(`[Registry] 已注册虚拟 Agent：${agent.agentId}`);
  }

  /** 获取 Agent 实例（含虚拟 Agent） */
  getAgent(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  /** 获取 Agent 名称 */
  getAgentName(id: string): string {
    const agent = this.agents.get(id);
    if (agent) return agent.name;
    const virt = this.virtualAgents.get(id);
    return virt?.name ?? id;
  }

  /** 取消注册 Agent */
  unregister(id: string): void {
    this.agents.delete(id);
    this.virtualAgents.delete(id);
    logger.info(`[Registry] 已取消注册 Agent：${id}`);
  }

  /** 是否为虚拟 Agent（无 LLM 的 VirtualAgent 实例） */
  isVirtual(id: string): boolean {
    const agent = this.agents.get(id);
    return agent instanceof VirtualAgent;
  }

  /** 获取所有已注册的 Agent ID（含虚拟） */
  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** 检查 Agent 是否存在（含虚拟） */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** Agent 数量（含虚拟） */
  get size(): number {
    return this.agents.size;
  }
}
