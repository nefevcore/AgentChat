// ============================================================
// ac-agents-dir —— Agent 目录扫描物化行（数据驱动）
//
// src AgentLoader（目录扫描 → AgentAssembly 大对象注入）的消解形态：
// 目录里有什么 = 注册表里有什么。物化 = ctx.agents.register（Agent 是
// 数据），fiber 归属本行——摘行即全部回收，加目录/改 config 重启进程
// 即生效（热重扫待 config/changed 订阅扩展，M14 管理面接入）。
//
// inject ['agents', 'agentStore']：registry = 物化目标；store = 目录
// 读取的唯一合法通道（不直读文件——ADR-5）。
// config（{ root? }）透传 agentStore 同根约定。
// ============================================================
import type { Context } from '@agentchat/cordis';

export const name = 'ac-agents-dir';
export const inject = ['agents', 'agentStore'];

/** 行配置（与 agentStore 同根约定；agentStore 行与本行须指向同一 root） */
export interface AgentsDirRowOptions {
  root?: string;
}

export function apply(ctx: Context, _options: AgentsDirRowOptions = {}) {
  for (const config of ctx.agentStore.listAgents()) {
    try {
      ctx.agents.register(config); // fiber 归属本行 → 摘行全回收
    } catch (err: unknown) {
      // 非法 id（含 ~ 等，M19 承重墙）不拖垮 boot：告警跳过该档案
      ctx.logger.warn(`[agents-dir] 跳过非法 Agent 档案 ${config.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
