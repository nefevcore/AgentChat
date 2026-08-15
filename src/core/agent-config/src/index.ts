// ============================================================
// @agentchat/agent-config —— 单 Agent 配置契约（零运行时依赖）
//
// 从 @agentchat/agents 拆出：AgentConfig / AgentPlugin / HookNames /
// getNamespaceConfig / collectToolNames / collectHookNames。
// 只描述"一个 Agent 的设置"，不包含 AgentAssembly 与 createAgentContext。
//
// 铁律：仅类型与纯函数，不 import 任何运行时服务。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { CurrentContext } from '@agentchat/agent-loop';
import type { LLMConfig } from '@agentchat/llm';

export * from './manifest';

/** 七类钩子的名字集合（与 L1 钩子一一对齐，零映射） */
export interface HookNames {
  /** 整次执行开始钩子名（L1 runStartHook ↔ chat.start） */
  runStart?: string[];
  /** 整次执行结束钩子名（L1 runEndHook ↔ chat.end） */
  runEnd?: string[];
  /** 回合开始钩子名（L1 turnStartHook ↔ chat.turn.start） */
  turnStart?: string[];
  /** 回合结束钩子名（L1 turnEndHook ↔ chat.turn.end） */
  turnEnd?: string[];
  /** 工具执行前钩子名（L1 toolExecutionStartHook ↔ chat.tool_execution.start） */
  toolExecutionStart?: string[];
  /** 工具执行后钩子名（L1 toolExecutionEndHook ↔ chat.tool_execution.end） */
  toolExecutionEnd?: string[];
  /** 兜底钩子名（L1 fallbackHook，失败路径兜底） */
  fallback?: string[];
}

/**
 * 插件装配单元 —— 聚合工具与各阶段钩子的名字声明。
 *
 * 替代旧的扁平字段（tools / pre_hooks / post_hooks）：
 * 每个插件 = 一组工具 + 各阶段钩子，装配时按插件聚合。
 * 字段值为名字（字符串数组），由 L3 插件层按名解析为实例。
 */
export interface AgentPlugin extends HookNames {
  /** 插件名（可选，日志/审计用；纯分组声明，不参与装配） */
  name?: string;
  /** 该插件提供的工具名列表 */
  tools?: string[];
}

/** 读取 Agent 配置的命名空间（缺省返回空对象） */
export function getNamespaceConfig(config: AgentConfig, ns: string): Record<string, unknown> {
  const v = config[ns];
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** 按 agent_id 在 agentsDir 中解析 Agent 目录（读 config.json 匹配，失败返回 null） */
export function resolveAgentDir(agentId: string, agentsDir: string): string | null {
  if (!fs.existsSync(agentsDir)) return null;
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.join(agentsDir, entry.name, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.agent_id === agentId) {
        return path.join(agentsDir, entry.name);
      }
    } catch { /* skip */ }
  }
  return null;
}

/** 聚合所有插件的工具名（去重、保序；无插件返回 undefined） */
export function collectToolNames(plugins: AgentPlugin[] | undefined): string[] | undefined {
  if (!plugins || plugins.length === 0) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of plugins) {
    for (const n of p.tools ?? []) {
      if (!seen.has(n)) { seen.add(n); names.push(n); }
    }
  }
  return names.length > 0 ? names : undefined;
}

/** 聚合所有插件的钩子名（按类型分别合并、去重、保序） */
export function collectHookNames(plugins: AgentPlugin[] | undefined): HookNames {
  const merged: HookNames = {};
  for (const p of plugins ?? []) {
    for (const kind of ['runStart', 'runEnd', 'turnStart', 'turnEnd', 'toolExecutionStart', 'toolExecutionEnd', 'fallback'] as const) {
      const list = p[kind];
      if (!list) continue;
      const acc = (merged[kind] ??= []);
      for (const n of list) {
        if (!acc.includes(n)) acc.push(n);
      }
    }
  }
  return merged;
}

/**
 * 正式 Agent 配置。
 *
 * 继承 CurrentContext 的「非运行时注入」字段（deepThink / maxTurns 等），
 * 并 Omit 掉运行时装配字段（llm 实例 / tools Map / history / steer / hooks 数组等）
 * 以配置文件形态重新声明：
 *   · llm     → LLMConfig | string（池引用/内嵌配置）
 *   · presets → string[]（启用哪些插件 = 插件级候选过滤；顺序无意义）
 *   · tools   → string[]（显式工具追加；requires 仍按 tags 匹配）
 *   · hooks   → HookNames（全局钩子顺序表；顺序即执行顺序，未启用插件也照写）
 *
 * 旧契约 plugins?: AgentPlugin[] 保留为兼容输入（迁移期），
 * createAgentContext 在 presets/tools/hooks 缺省时回退聚合旧 plugins。
 *
 * 运行时装配（llm 实例、tools Map、history、steer、钩子数组）由
 * createAgentContext 补全，配置文件本身只描述"设置"。
 */
export interface AgentConfig extends Omit<CurrentContext,
  // 运行时注入字段（装配函数补全，配置文件中不存在）
  | 'llm' | 'systemPrompt' | 'history' | 'currentMessage' | 'tools' | 'steer' | 'signal'
  | 'dialogId' | 'emit'
  | 'turnStartHook' | 'turnEndHook' | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'
  | 'redactResult'
> {
  /** Agent 唯一标识 */
  agent_id: string;
  /** 昵称 */
  name: string;
  /** 是否为虚拟 Agent（无 LLM，仅作路由端点，如 user） */
  virtual?: boolean;
  /** 能力标签（组合式能力声明，工具 requires 为 AND 语义） */
  tags?: string[];
  /** 头像文件名（位于 agents/<目录>/ 下） */
  avatar?: string;
  /** LLM 设置：池引用字符串 / 内嵌配置 / 引用+覆盖 */
  llm?: LLMConfig | string;
  /** 启用哪些插件（cordis 插件 name 列表 = 候选范围过滤器；顺序无意义） */
  presets?: string[];
  /** 显式工具追加（requires 为空的工具只能在此启用；仍受 tags 门控） */
  tools?: string[];
  /** 全局钩子顺序表（顺序即执行顺序；未启用插件的钩子也照写，启用后生效） */
  hooks?: HookNames;
  /** @deprecated 旧插件装配单元（迁移期兼容输入，新配置请用 presets/tools/hooks） */
  plugins?: AgentPlugin[];
  /**
   * 扩展/工具/安全命名空间配置。
   *   工具/扩展：  "tool.bash": { "defaultTimeout": 30000 }
   *   路径沙箱：   "security": { "allowedPaths": ["/tmp/scratch/"] }
   *                （write/edit/bash 三个内置工具共享管控，见 getNamespaceConfig）
   */
  [key: string]: any;
}
