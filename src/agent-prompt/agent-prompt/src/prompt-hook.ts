// ============================================================
// @agentchat/agent-prompt/src/prompt-hook.ts —— build-system-prompt 钩子
// 从 agent-session/run.ts 移入（prompt 域钩子；避免依赖环）。
// ============================================================
import { counterpartOfDialog, isGroupDialog, groupIdOfDialog } from '@agentchat/agents';
import type { AgentConfig } from '@agentchat/agent-config';
import type { CurrentContext, RunStartHook } from '@agentchat/agent-loop';
import type { ToolContext } from '@agentchat/tools';
import { buildSystemPrompt } from './prompt';

export function makeBuildSystemPromptHook(config: AgentConfig, services: ToolContext): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    const dialogId = ctx.dialogId;
    if (!dialogId) {
      // 无会话键（如子 Agent）：无需任何装配
      return;
    }

    const selfId = ctx.agentId ?? '';
    // 群组 trigger 由 dialogId 解析（group~<gid>~<aid>）；点到点缺省
    const groupId = isGroupDialog(dialogId) ? groupIdOfDialog(dialogId) : undefined;
    // 1v1：对话对象必须从 dialogId 反解（chat~<lo>~<hi>），不能用 selfId——
    // 否则 admin↔user 会被提示成「对话对象=admin（自己）」，Agent 把 user 当成艾吉。
    const counterpart = counterpartOfDialog(dialogId, selfId);
    const sender = groupId ? selfId : (counterpart && counterpart !== '?' ? counterpart : 'user');

    ctx.systemPrompt = buildSystemPrompt(config, services, {
      toolNames: Array.from(ctx.tools.keys()),
      sender,
      groupId,
    });
  };
}
