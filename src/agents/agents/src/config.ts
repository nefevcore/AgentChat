// ============================================================
// src/agents/config.ts —— Agent 装配层（单 Agent 运行时）
//
// 职责：
//   1. AgentConfig / AgentPlugin / HookNames / 聚合纯函数 —— 已下沉
//      @agentchat/agent-config，本文件 re-export 保持兼容。
//   2. AgentAssembly —— 装配依赖注入（llm/tools/history/hooks/emit 的实现
//      由上层 L3/L4/L5 提供），本层保持纯运行时、不触碰全局状态与文件 IO。
//   3. createAgentContext —— 装配工厂（对应 §7.4 createLoop）：
//      AgentConfig + AgentAssembly + 单次投递输入 → 可执行 CurrentContext。
//
// 依赖方向：仅依赖 agent-config/agent-loop/llm（相对运行时零外部依赖）。
// ============================================================

import type {
  CurrentContext,
  FallbackHook,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
  TurnEndHook,
  TurnStartHook,
  ReloadScope,
  Tool,
  AgentLoopEngine,
} from '@agentchat/agent-loop';
import type { LLMConfig, LLMProvider, LLMResponse } from '@agentchat/llm';
import type { AgentMessage, LLMRequestMessage } from '@agentchat/types';
import { ChatStream } from '@agentchat/llm';
import type { AgentConfig, HookNames } from '@agentchat/agent-config';
import { collectToolNames, collectHookNames } from '@agentchat/agent-config';

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
  /** ReAct 引擎入口（ctx.agentLoop 注入；契约化后引擎经服务提供，不直接 import） */
  engine: AgentLoopEngine;
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
  /** 热重载执行体（reload-requested 中断时调用；L5 装配注入；缺省仅重烘焙工具） */
  performReload?: (scope: ReloadScope, config: AgentConfig) => void | Promise<void>;
  /** 请求后端重启（restart-requested 中断时调用；L5 装配注入 requestRestart） */
  requestRestart?: (reason?: string) => void;
  /** 工具结果变换（输出脱敏）：L5 装配注入 redactor；缺省 = 不脱敏 */
  redactResult?: (content: string, toolName: string) => string;
  /** 工作区根（router pending 落盘等用；L5 注入） */
  workspaceDir?: string;
}

// ============================================================
// createAgentContext —— 装配工厂（对应 §7.4 createLoop）
// ============================================================

/** 单次投递输入（router 每次 send/trigger 时传入） */
export interface AgentContextInput {
  /** 当前用户消息（receive 模式） */
  currentMessage?: AgentMessage;
  /** 会话键（dialogId）：1v1 chat~<lo>~<hi> 或群组 group~<gid>~<aid> */
  dialogId?: string;
  /** 中止信号（外部取消/优雅关闭） */
  signal?: AbortSignal;
  /** 覆写最大 ReAct 轮次（trigger 模式防失控） */
  maxTurns?: number;
  /** 覆写深度思考开关 */
  deepThink?: boolean;
  /** 执行扩展元数据（语义化键 → 任意载荷；透传到 CurrentContext.meta） */
  meta?: Record<string, unknown>;
}

/**
 * 虚拟 Agent 的空 LLM（装配占位）：虚拟 Agent 不装配真实模型。
 * loop 对 ctx.virtual 跳过推理，chat/stream 实际不会被调用；仅满足
 * CurrentContext.llm 必填契约（logRunUsage 等读 ctx.llm.model）。
 */
function makeVirtualLLM(): LLMProvider {
  const empty = (): LLMResponse => ({ content: '', toolCalls: [], finishReason: 'stop' });
  return {
    model: 'virtual',
    async chat() { return empty(); },
    stream() {
      const cs = new ChatStream();
      cs.done(empty());
      return cs;
    },
    toProviderMessages: (m) => m as any[],
    fromProviderMessages: (m) => m as any[],
  };
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
  const llm = config.virtual ? makeVirtualLLM() : assembly.createLLM(config.llm ?? {});
  // 新契约（presets/tools/hooks）优先；旧 plugins 聚合作为兼容回退
  const toolNames = config.tools ?? collectToolNames(config.plugins);
  const hookNames = config.hooks ?? collectHookNames(config.plugins);
  const tools = assembly.resolveTools(toolNames, config);
  const history = input.dialogId ? assembly.loadHistory(input.dialogId) : [];
  const hooks = assembly.resolveHooks?.(hookNames, config) ?? {};

  const context = assembly.engine.createContext({
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
    redactResult: assembly.redactResult,
    meta: input.meta,
    ...hooks,
  });

  // reload-requested 中断的执行体：先执行 L5 注入的热重载，再重烘焙当前上下文工具集
  // （新工具立即可用，对齐旧架构 reload 后 reinit 继续推理）。
  if (assembly.performReload) {
    context.performReload = async (scope) => {
      await assembly.performReload!(scope, config);
      context.tools = assembly.resolveTools(toolNames, config);
    };
  }

  return context;
}
