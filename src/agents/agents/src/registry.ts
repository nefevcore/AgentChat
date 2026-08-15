// ============================================================
// src/agents/registry.ts —— Agent 注册表（仅存储配置，无实例）
//
// §7.3 无状态化：只存 AgentConfig，不持有 Agent/VirtualAgent 实例。
// 实例化/装配由 router 每次投递时经 createAgentContext 按需完成。
//
// 依赖方向：仅依赖 src/core 与本层 config（相对导入）。
// ============================================================

import { createLogger } from '@agentchat/util';
import type { AgentConfig } from '@agentchat/agent-config';

const log = createLogger('[agents:registry]');

/** Agent 注册表 —— 只存配置，无实例 */
export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();

  /** 注册（或覆盖）Agent 配置 */
  register(config: AgentConfig): void {
    if (this.agents.has(config.agent_id)) {
      log.warn(`[Registry] Agent "${config.agent_id}" 已注册，正在覆盖`);
    }
    this.agents.set(config.agent_id, config);
    log.info(`[Registry] 已注册 Agent：${config.agent_id}`);
  }

  /** 取消注册 */
  unregister(id: string): void {
    this.agents.delete(id);
    log.info(`[Registry] 已取消注册 Agent：${id}`);
  }

  /** 获取 Agent 配置 */
  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  /** 获取 Agent 昵称（缺省回退为 ID） */
  getAgentName(id: string): string {
    return this.agents.get(id)?.name ?? id;
  }

  /** 是否为虚拟 Agent（virtual: true，无 LLM 仅作端点） */
  isVirtual(id: string): boolean {
    return this.agents.get(id)?.virtual === true;
  }

  /** 是否已注册 */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** 所有已注册 Agent ID */
  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** 所有已注册 Agent 配置 */
  list(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /** Agent 数量 */
  get size(): number {
    return this.agents.size;
  }
}
