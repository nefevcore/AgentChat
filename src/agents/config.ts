// ============================================================
// src/agents/config.ts —— Agent 配置（L2 装配层）
//
// 职责：
//   1. AgentConfig —— 正式 Agent 配置，以 L1 CurrentContext 为基类
//      （Omit 掉运行时注入字段），配置文件形态持有 llm/tools/hooks 设置。
//   2. AgentAssembly —— 装配依赖注入（llm/tools/history/hooks/emit 的实现
//      由上层 L3/L4/L5 提供），L2 保持纯运行时、不触碰全局状态与文件 IO。
//   3. createAgentContext —— 装配工厂（对应 §7.4 createLoop）：
//      AgentConfig + AgentAssembly + 单次投递输入 → 可执行 CurrentContext。
//
// 依赖方向：仅依赖 src/core（相对导入），零 npm 依赖。
// ============================================================

import type {
  CurrentContext,
  FallbackHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
  TurnEndHook,
  TurnStartHook,
} from '@core/context';
import { createContext } from '@core/context';
import type { LLMConfig, LLMProvider, LLMRequestMessage, Message, Tool } from '@core/types';

// ============================================================
// 插件装配单元与钩子名字
// ============================================================

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

// ============================================================
// 命名空间配置读取
// ============================================================

/** 读取 Agent 配置的命名空间（缺省返回空对象） */
export function getNamespaceConfig(config: AgentConfig, ns: string): Record<string, unknown> {
  const v = config[ns];
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// 注：路径穿透白名单读取（security.allowedPaths）归 L3 ——
// 唯一消费方是工具沙箱 resolveSafePath（src/plugins/builtin/tools/shared.ts）。

// ============================================================
// 插件聚合
// ============================================================

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

// ============================================================
// AgentConfig —— 以 CurrentContext 为基类的正式 Agent 配置
// ============================================================

/**
 * 正式 Agent 配置。
 *
 * 继承 CurrentContext 的「非运行时注入」字段（deepThink / maxTurns 等），
 * 并 Omit 掉运行时装配字段（llm 实例 / tools Map / history / steer / hooks 数组等）
 * 以配置文件形态重新声明：
 *   · llm      → LLMConfig | string（池引用/内嵌配置）
 *   · plugins  → AgentPlugin[]（工具 + 五类钩子的名字声明）
 *
 * 运行时装配（llm 实例、tools Map、history、steer、钩子数组）由
 * createAgentContext 补全，配置文件本身只描述"设置"。
 */
export interface AgentConfig extends Omit<CurrentContext,
  // 运行时注入字段（装配函数补全，配置文件中不存在）
  | 'llm' | 'systemPrompt' | 'history' | 'currentMessage' | 'tools' | 'steer' | 'signal'
  | 'dialogId' | 'emit'
  | 'turnStartHook' | 'turnEndHook' | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'
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
  /** 插件装配单元：工具 + 五类钩子的名字声明（替代旧 tools/pre_hooks/post_hooks） */
  plugins?: AgentPlugin[];
  /**
   * 扩展/工具/安全命名空间配置。
   *   工具/扩展：  "tool.bash": { "defaultTimeout": 30000 }
   *   路径沙箱：   "security": { "allowedPaths": ["/tmp/scratch/"] }
   *                （write/edit/bash 三个内置工具共享管控，见 getNamespaceConfig）
   */
  [key: string]: any;
}

// ============================================================
// AgentAssembly —— 装配依赖注入
// ============================================================

/**
 * L2 装配依赖注入（由上层 L3/L4/L5 提供实现）。
 *
 * L2 保持"纯运行时"：不读全局配置、不加载插件、不落盘——
 * llm/tools/hooks/history/emit 全部经此接口注入，router 只做分发。
 * 缺省能力（resolveHooks/systemPrompt/emit）可选，缺省时装配最小 ctx。
 */
export interface AgentAssembly {
  /** 解析 LLM：config.llm（内嵌配置 / 池引用字符串）→ LLMProvider 实例 */
  createLLM: (config: LLMConfig | string) => LLMProvider;
  /** 解析工具：聚合后的工具名列表 + Agent 配置 → 工具实例表（L3 插件层；config 用于 per-Agent 烘焙，如 security 沙箱 / tool.* 命名空间） */
  resolveTools: (names: string[] | undefined, config: AgentConfig) => Map<string, Tool>;
  /** 加载会话历史（L4 持久化层提供）；convKey = dialogId 或群组 ID；空数组 = 新会话 */
  loadHistory: (convKey: string) => LLMRequestMessage[];
  /** 解析钩子：聚合后的钩子名集合 + Agent 配置 → 各类钩子数组（L3 插件层提供实现；config 供工厂烘焙） */
  resolveHooks?: (names: HookNames, config: AgentConfig) => Partial<Pick<CurrentContext,
    | 'runStartHook' | 'runEndHook' | 'turnStartHook' | 'turnEndHook'
    | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'>>;
  /** 事件发射（L5 传输层提供；缺省 → loop 走非流式 fast-path） */
  emit?: CurrentContext['emit'];
  /** 系统提示词生成（L3 扩展提供；缺省为空串） */
  systemPrompt?: (config: AgentConfig) => string;
}

// ============================================================
// createAgentContext —— 装配工厂（对应 §7.4 createLoop）
// ============================================================

/** 单次投递输入（router 每次 send/trigger 时传入） */
export interface AgentContextInput {
  /** 当前用户消息（receive 模式） */
  currentMessage?: Message;
  /** 会话键（dialogId）：1v1 chat~<lo>~<hi> 或群组 group~<gid>~<aid> */
  dialogId?: string;
  /** 中止信号（外部取消/优雅关闭） */
  signal?: AbortSignal;
  /** 覆写最大 ReAct 轮次（trigger 模式防失控） */
  maxTurns?: number;
  /** 覆写深度思考开关 */
  deepThink?: boolean;
}

/**
 * 装配工厂：AgentConfig + 注入能力 + 单次投递输入 → 可执行 CurrentContext。
 *
 * 每次投递调用一次（历史/当前消息按会话即时装配）；steer 由 createContext
 * 初始化为空队列，router 在运行中经 pushSteer 注入转向消息。
 */
export function createAgentContext(
  config: AgentConfig,
  assembly: AgentAssembly,
  input: AgentContextInput = {},
): CurrentContext {
  const llm = assembly.createLLM(config.llm ?? {});
  const tools = assembly.resolveTools(collectToolNames(config.plugins), config);
  const history = input.dialogId ? assembly.loadHistory(input.dialogId) : [];
  const hooks = assembly.resolveHooks?.(collectHookNames(config.plugins), config) ?? {};

  return createContext({
    llm,
    systemPrompt: assembly.systemPrompt?.(config) ?? '',
    history,
    currentMessage: input.currentMessage,
    tools,
    agentId: config.agent_id,
    deepThink: input.deepThink ?? config.deepThink,
    maxTurns: input.maxTurns ?? config.maxTurns,
    dialogId: input.dialogId,
    signal: input.signal,
    emit: assembly.emit,
    ...hooks,
  });
}

// re-export 钩子类型（供上层装配引用）
export type {
  CurrentContext,
  FallbackHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
  TurnEndHook,
  TurnStartHook,
  LLMConfig,
  LLMProvider,
  LLMRequestMessage,
  Message,
  Tool,
};
