// ============================================================
// @agentchat/agent-persona/src/persona-hook.ts —— persona 人设注入钩子
//
// 独立插件（agentchat-agent-persona）：人设装配与 agent-prompt 的框架装配
// 彻底解耦，可按 Agent 单独挂载/摘除（presets + hooks 清单控制）。
//
// 组合语义：
//   · 推荐排在 agent-prompt.build-system-prompt **之前**（角色块先行写入，
//     框架块追加其后）；后置亦可 —— 本钩子前置注入，两种顺序收敛到同一结构。
//   · SYSTEM.md 存在时跳过（完全覆盖语义保留：SYSTEM.md 即完整人设）。
//   · 无会话键（如子 Agent）不装配，与 build-system-prompt 对齐。
// ============================================================
import { createLogger } from '@agentchat/util';
import type { AgentConfig } from '@agentchat/agent-config';
import type { CurrentContext, RunStartHook } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import { personaPromptBlock } from './persona';

const logger = createLogger('[agent-persona]');

/**
 * runStart：装载并前置注入 persona 角色块。
 * 来源优先级：AGENT.md（目录实体，支持本地覆盖预设定义）→ config.persona（内联，
 * 预设 Agent 定义携带）。均无 → 不注入（standard 预设保持无人设）。
 */
export function makePersonaPromptHook(config: AgentConfig, services: ToolContext): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    if (!ctx.dialogId) return; // 无会话键（如子 Agent）：无需装配

    const block = personaPromptBlock(config, services.agentsDir ?? '');
    if (!block) return;

    ctx.systemPrompt = ctx.systemPrompt ? `${block}\n\n${ctx.systemPrompt}` : block;
    logger.info(`Agent "${config.agent_id}" 注入人设`);
  };
}
