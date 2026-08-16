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
  InterruptHandler,
  MessageInbox,
  ReloadScope,
  StepEndHook,
  StepStartHook,
  Tool,
  ToolExecutionEndHook,
  ToolExecutionStartHook,
} from '@agentchat/contracts';
import type { AgentLoopEngine } from '@agentchat/agent-loop';
import type { LLMConfig, LLMProvider, LLMResponse } from '@agentchat/llm';
import type { AgentMessage, LLMRequestMessage } from '@agentchat/types';
import { ChatStream } from '@agentchat/llm';
import type { AgentConfig } from '@agentchat/agent-config';

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
  /** 解析工具：Agent 配置（presets + tools 意图覆盖）→ 工具实例表（L3 插件层；config 用于 per-Agent 烘焙，如 security 沙箱 / tool.* 命名空间） */
  resolveTools: (config: AgentConfig) => Map<string, Tool>;
  /** 加载会话历史（L4 持久化层提供）；convKey = dialogId 或群组 ID；空数组 = 新会话 */
  loadHistory: (convKey: string) => LLMRequestMessage[];
  /** 解析钩子：Agent 配置（hooks 启用清单）→ 各类钩子数组（L3 插件层提供实现；config 供工厂烘焙） */
  resolveHooks?: (config: AgentConfig) => Partial<Pick<CurrentContext,
    | 'runStartHook' | 'runEndHook' | 'stepStartHook' | 'stepEndHook'
    | 'toolExecutionStartHook' | 'toolExecutionEndHook' | 'fallbackHook'>>;
  /** 事件发射（L5 传输层提供；缺省 → loop 走非流式 fast-path） */
  emit?: CurrentContext['emit'];
  /** 系统提示词生成（L3 扩展提供；缺省为空串） */
  systemPrompt?: (config: AgentConfig) => string;
  /** 热重载执行体（reload-requested 中断时由装配的中断处理器调用；L5 装配注入） */
  reloadAgents?: (scope: ReloadScope, config: AgentConfig) => void | Promise<void>;
  /** 请求后端重启（restart-requested 中断时调用；L5 装配注入 requestRestart） */
  requestRestart?: (reason?: string) => void;
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
  /** 跨 run 存活的 next-turn/next-step 双队列（router 持有；缺省由 createContext 创建） */
  inbox?: MessageInbox;
  /** 中止信号（外部取消/优雅关闭） */
  signal?: AbortSignal;
  /** 覆写最大 ReAct 步数（trigger 模式防失控） */
  maxSteps?: number;
  /** 覆写深度思考开关 */
  deepThink?: boolean;
  /** 执行扩展元数据（语义化键 → 任意载荷；透传到 CurrentContext.meta） */
  meta?: Record<string, unknown>;
  /** trigger 关联 ID（事件 correlation_id 用） */
  correlationId?: string;
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
 * 每次投递调用一次（历史/当前消息按会话即时装配）；inbox 由 router 跨 run
 * 复用，loop 只消费 next-step、next-turn 由 router 在 run 边界消费。
 */
export function createAgentContext(
  config: AgentConfig,
  assembly: AgentAssembly,
  input: AgentContextInput = {},
): CurrentContext {
  const llm = config.virtual ? makeVirtualLLM() : assembly.createLLM(config.llm ?? {});
  // 新契约：presets/tools/hooks 为单一意图来源（旧 plugins/disabled* 由解析服务归一化）
  const tools = assembly.resolveTools(config);
  const history = input.dialogId ? assembly.loadHistory(input.dialogId) : [];
  const hooks = assembly.resolveHooks?.(config) ?? {};

  const context = assembly.engine.createContext({
    llm,
    systemPrompt: assembly.systemPrompt?.(config) ?? '',
    history,
    currentMessage: input.currentMessage,
    inbox: input.inbox,
    tools,
    agentId: config.agent_id,
    deepThink: input.deepThink ?? config.deepThink,
    maxSteps: input.maxSteps ?? config.maxSteps,
    dialogId: input.dialogId,
    signal: input.signal,
    emit: assembly.emit,
    meta: input.meta,
    correlationId: input.correlationId,
    ...hooks,
  });

  // reload-requested 中断策略：装配层注入 reloadAgents 时转成通用 interruptHandler。
  // 处理器执行热重载后返回 continue + 补丁（tools/systemPrompt），loop 应用补丁继续推理；
  // 不再通过闭包偷偷改 ctx.tools（旧 performReload 行为）。
  if (assembly.reloadAgents) {
    const reloadHandler: InterruptHandler = async (current, reason) => {
      if (reason.type !== 'reload-requested') return;
      await assembly.reloadAgents!(reason.scope, config);
      return {
        action: 'continue',
        patch: {
          tools: assembly.resolveTools(config),
          systemPrompt: assembly.systemPrompt?.(config) ?? current.systemPrompt,
        },
      };
    };
    context.interruptHandlers = [reloadHandler];
  }

  return context;
}
