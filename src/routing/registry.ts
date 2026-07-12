// ============================================================
// AgentRegistry —— Agent 注册表
// 存储所有 Agent 实例，提供查找能力
// 支持虚拟 Agent（无 LLM 实例，仅作路由端点标记）
// ============================================================

import { Agent } from '@core/agent';

/** 虚拟 Agent 元数据 */
export interface VirtualAgentInfo {
  id: string;
  name: string;
}

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  /** 虚拟 Agent 元数据（如 user），不含 Agent 实例 */
  private virtualAgents = new Map<string, VirtualAgentInfo>();

  /** 注册 Agent 实例 */
  register(id: string, agent: Agent): void {
    if (this.agents.has(id)) {
      console.warn(`[Registry] Agent "${id}" 已注册，正在覆盖`);
    }
    this.agents.set(id, agent);
    // 如果之前注册了同名的虚拟 Agent，移除
    this.virtualAgents.delete(id);
    console.log(`[Registry] 已注册 Agent：${id}`);
  }

  /** 注册虚拟 Agent（仅元数据，无 LLM 实例） */
  registerVirtual(info: VirtualAgentInfo): void {
    if (this.agents.has(info.id)) {
      console.warn(`[Registry] 虚拟 Agent "${info.id}" 与真实 Agent 冲突，已跳过`);
      return;
    }
    this.virtualAgents.set(info.id, info);
    console.log(`[Registry] 已注册虚拟 Agent：${info.id}`);
  }

  /** 获取 Agent 实例（虚拟 Agent 返回 undefined） */
  getAgent(id: string): Agent | undefined {
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
    console.log(`[Registry] 已取消注册 Agent：${id}`);
  }

  /** 是否为虚拟 Agent */
  isVirtual(id: string): boolean {
    return this.virtualAgents.has(id) && !this.agents.has(id);
  }

  /** 获取所有已注册的 Agent ID（含虚拟） */
  listIds(): string[] {
    const ids = Array.from(this.agents.keys());
    for (const id of this.virtualAgents.keys()) {
      if (!this.agents.has(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  /** 检查 Agent 是否存在（含虚拟） */
  has(id: string): boolean {
    return this.agents.has(id) || this.virtualAgents.has(id);
  }

  /** Agent 数量（含虚拟） */
  get size(): number {
    return this.agents.size + this.virtualAgents.size;
  }
}
