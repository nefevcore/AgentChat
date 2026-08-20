// ============================================================
// @agentchat/agent-datetime/src/datetime-hook.ts —— 日期注入钩子
//
// runStart 钩子（agent-datetime.datetime，清单钩子——需在 config.hooks
// 显式列出才启用，无 automatic）：
//   · 把仅日期的 [当前时间] 行追加到 ctx.systemPrompt 尾部（每 run
//     一次；run 内多 step 复用同一 system prompt，KV cache 稳定）
//   · 不触碰消息流——currentMessage 与落盘历史保持干净
//   · 独立会话（single~）硬性跳过：会话提示词全静态，保持最大
//     KV cache（预设 Agent 均不启用本钩子，双保险）
//   · 无会话键（子 Agent）不注入，与 build-system-prompt / persona 对齐
//
// 建议排在 agent-prompt.build-system-prompt 之后（日期行落在装配结果尾部）。
// ============================================================
import { getNamespaceConfig } from '@agentchat/agent-config';
import { isSingleDialog } from '@agentchat/agents';
import { NS_AGENT_DATETIME } from '@agentchat/toolkit';
import type { AgentConfig } from '@agentchat/agent-config';
import type { CurrentContext, RunStartHook } from '@agentchat/agent-loop';
import { datetimeLine } from './datetime';

/**
 * 钩子工厂：读 agent.datetime.enabled（缺省 true；false → 返回 null，
 * HooksService collect 对 null 不入列，钩子数组零开销）。
 */
export function makeDatetimeHook(config: AgentConfig): RunStartHook | null {
  const ns = getNamespaceConfig(config, NS_AGENT_DATETIME) as Record<string, unknown>;
  if (ns.enabled === false) return null;

  return async (ctx: CurrentContext): Promise<void> => {
    if (!ctx.dialogId) return;                    // 无会话键（子 Agent）：无需日期
    if (isSingleDialog(ctx.dialogId)) return;     // 独立会话：全静态提示词（最大 KV cache）

    const line = datetimeLine(new Date());
    ctx.systemPrompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${line}` : line;
  };
}
