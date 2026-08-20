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
  /** 解析 LLM：config.llm（内嵌配置 / 池引用字符串）→ LLMProvider 实例；
   *  agentId 可选——装配层用它隔离 per-Agent services 作用域（并发投递竞态防护） */
  createLLM: (config: LLMConfig | string, agentId?: string) => LLMProvider;
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
  /**
   * 模块热重载执行体（reload-requested scope='modules' 中断时调用；dev 装配注入，
   * 实现 = ctx.hmr.reloadFiles，见 docs/restart-design.md §2.4）。
   * 失败不抛出：回滚已由重载机器完成，旧树继续运行，经报告反馈 agent。
   */
  reloadModules?: (files: string[]) => Promise<ModuleReloadReport>;
  /** 请求后端重启（restart-requested 中断时调用；L5 装配注入 requestRestart） */
  requestRestart?: (reason?: string) => void;
  /** 工作区根（router pending 落盘等用；L5 注入） */
  workspaceDir?: string;
}

/** 模块热重载报告（L1.5 reload-requested scope='modules'） */
export interface ModuleReloadReport {
  /** 是否成功（失败 = 已回滚旧模块、旧树继续运行） */
  ok: boolean;
  /** 成功重载的模块/插件入口清单（可读路径，供日志/反馈） */
  reloaded: string[];
  /** 失败原因（ok=false 时反馈 agent 修复重试） */
  message: string;
}

// ============================================================
// createAgentContext —— 装配工厂（对应 §7.4 createLoop）
// ============================================================

/** 单次投递输入（router 每次 send/trigger 时传入） */
export interface AgentContextInput {
  /** 当前用户消息（receive 模式） */
  currentMessage?: AgentMessage;
  /** 会话键（dialogId）：1v1 chat~<lo>~<hi>、群组 group~<gid>~<aid> 或独立 single~<sid> */
  dialogId?: string;
  /** 跨 run 存活的 next-turn/next-step 双队列（router 持有；缺省由 createContext 创建） */
  inbox?: MessageInbox;
  /** 中止信号（外部取消/优雅关闭） */
  signal?: AbortSignal;
  /** 覆写最大 ReAct 步数（trigger 模式防失控） */
  maxSteps?: number;
  /** 覆写深度思考开关 */
  deepThink?: boolean;
  /** 覆写思考强度（low/high/max；缺省 = 模型配置 reasoning_effort） */
  reasoningEffort?: 'low' | 'high' | 'max';
  /**
   * 会话级模型覆盖（独立会话 single~<sid> 专用；缺省 = Agent 原配置）。
   * 形态与 config.llm 相同：池引用字符串 / 内嵌 LLMConfig / $ref+覆盖，
   * 走 assembly.createLLM → resolveLLMPool 同一解析链。
   */
  llmOverride?: LLMConfig | string;
  /**
   * 会话级路径白名单（独立会话挂载的用户工作区文件夹）。
   * 合并进 effective config 的 security.allowedPaths —— 只影响本次 run
   * 烘焙的工具（read/write/edit/bash 经 resolveSafePath 放行）与系统提示词
   * 的「路径穿透白名单」行，不落盘、不改 Agent 原配置。
   */
  extraAllowedPaths?: string[];
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
 * 会话级路径白名单合并：extra 并入 config 的 security.allowedPaths
 * （不修改原 config；去重保序），并把 extra[0] 写入 security.workdir ——
 * 独立会话挂载的用户文件夹即本会话的沙箱工作目录（相对路径解析基准、
 * bash 缺省 cwd、提示词 [工作目录] 同源）。只影响本次 run 烘焙的工具与提示词。
 * 预览（AgentService.getAgentSystemPrompt）同样经此合并，保证预览=运行时。
 */
export function withExtraAllowedPaths(config: AgentConfig, extra: string[]): AgentConfig {
  const sec = (config as Record<string, unknown>)['security'];
  const base = sec !== null && typeof sec === 'object' && !Array.isArray(sec)
    ? sec as Record<string, unknown>
    : {};
  const existing = Array.isArray(base.allowedPaths) ? base.allowedPaths as unknown[] : [];
  const merged = [...existing.map(String), ...extra.filter(p => !existing.includes(p))];
  return {
    ...config,
    security: { ...base, allowedPaths: merged, workdir: extra[0] },
  } as AgentConfig;
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
  // 会话级路径白名单（独立会话挂载的用户工作区）：合并进 effective config，
  // 供本次 run 的工具烘焙（resolveSafePath）与提示词（路径穿透白名单行）消费。
  const effectiveConfig = input.extraAllowedPaths?.length
    ? withExtraAllowedPaths(config, input.extraAllowedPaths)
    : config;
  // agent_id 传入 createLLM：装配层据此写入 per-Agent 作用域（与 resolveTools 同域，
  // subagent 等烘焙工具读 services.llm/tools 时拿到本 Agent 快照，不串读并发投递的他人状态）。
  // 独立会话（single~）的会话级模型覆盖优先于 Agent 原配置（llmOverride）。
  const llm = config.virtual
    ? makeVirtualLLM()
    : assembly.createLLM(input.llmOverride ?? config.llm ?? {}, config.agent_id);
  // 新契约：presets/tools/hooks 为单一意图来源（旧 plugins/disabled* 由解析服务归一化）
  const tools = assembly.resolveTools(effectiveConfig);
  const history = input.dialogId ? assembly.loadHistory(input.dialogId) : [];
  const hooks = assembly.resolveHooks?.(effectiveConfig) ?? {};

  const context = assembly.engine.createContext({
    llm,
    systemPrompt: assembly.systemPrompt?.(effectiveConfig) ?? '',
    history,
    currentMessage: input.currentMessage,
    inbox: input.inbox,
    tools,
    agentId: config.agent_id,
    deepThink: input.deepThink ?? config.deepThink,
    reasoningEffort: input.reasoningEffort,
    maxSteps: input.maxSteps ?? config.maxSteps,
    dialogId: input.dialogId,
    signal: input.signal,
    emit: assembly.emit,
    meta: input.meta,
    correlationId: input.correlationId,
    ...hooks,
  });

  // reload-requested 中断策略：装配层注入 reloadAgents/reloadModules 时转成通用 interruptHandler。
  // 处理器执行热重载后返回 continue + 补丁（tools/systemPrompt），loop 应用补丁继续推理；
  // 不再通过闭包偷偷改 ctx.tools（旧 performReload 行为）。
  //
  // scope='modules'（L1.5 主动模块重载）：先 reloadModules（模块换血）后 resolveTools
  // （重新烘焙）——顺序反了烘出的还是旧闭包（restart-design §2.4）；失败时回滚已
  // 完成、旧树继续跑，错误经 next-step 续跑消息反馈 agent（可修复后重试）。
  // 补丁重烘焙沿用 effectiveConfig（会话白名单不因重载丢失）。
  if (assembly.reloadAgents || assembly.reloadModules) {
    const reloadHandler: InterruptHandler = async (current, reason) => {
      if (reason.type !== 'reload-requested') return;
      if (reason.scope === 'modules') {
        if (!assembly.reloadModules) return; // 未装配模块重载 → 按中断收尾
        const report = await assembly.reloadModules(reason.files ?? []);
        if (!report.ok) {
          current.inbox.nextStep.push({
            role: 'user',
            content: `[reload_modules] 失败：${report.message}（旧模块已回滚继续运行，修复源码后可重新宣告 reload_modules）`,
          });
        }
        return {
          action: 'continue',
          patch: {
            tools: assembly.resolveTools(effectiveConfig),
            systemPrompt: assembly.systemPrompt?.(effectiveConfig) ?? current.systemPrompt,
          },
        };
      }
      if (!assembly.reloadAgents) return; // 未装配配置热重载 → 按中断收尾
      await assembly.reloadAgents(reason.scope, effectiveConfig);
      return {
        action: 'continue',
        patch: {
          tools: assembly.resolveTools(effectiveConfig),
          systemPrompt: assembly.systemPrompt?.(effectiveConfig) ?? current.systemPrompt,
        },
      };
    };
    context.interruptHandlers = [reloadHandler];
  }

  return context;
}
