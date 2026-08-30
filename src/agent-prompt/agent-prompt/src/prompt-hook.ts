// ============================================================
// @agentchat/agent-prompt/src/prompt-hook.ts —— build-system-prompt 钩子
// 从 agent-session/run.ts 移入（prompt 域钩子；避免依赖环）。
// ============================================================
import { counterpartOfDialog, isGroupDialog, isSingleDialog, groupIdOfDialog } from '@agentchat/contracts';
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
    // 独立会话（single~<sid>）：counterpartOfDialog 返回的是 sessionId（记忆隔离键），
    // 不是对话对象——会话里对话的另一方恒为用户。曾把 session-id 当 sender 写进
    // 提示词（"[当前对话对象] c19e10bf-…"），模型遂在推理中把 UUID 当对话方分析。
    const isSingle = isSingleDialog(dialogId);
    // 1v1：对话对象必须从 dialogId 反解（chat~<lo>~<hi>），不能用 selfId——
    // 否则 admin↔user 会被提示成「对话对象=admin（自己）」，Agent 把 user 当成艾吉。
    const counterpart = isSingle ? 'user' : counterpartOfDialog(dialogId, selfId);
    const sender = groupId ? selfId : (counterpart && counterpart !== '?' ? counterpart : 'user');

    // 追加式装配：已有内容（如 agent-persona.persona 先行注入的角色块）保留在前，
    // 框架块接续其后 —— 钩子顺序无关地收敛到「persona 块 → 框架块」同一结构
    //（SYSTEM.md 完全覆盖语义不变：该场景 persona 钩子自行跳过，无既有内容）。
    const built = buildSystemPrompt(config, services, {
      toolNames: Array.from(ctx.tools.keys()),
      sender,
      groupId,
    });
    ctx.systemPrompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${built}` : built;
  };
}
