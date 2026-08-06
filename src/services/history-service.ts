// ============================================================
// HistoryService —— 消息历史/归档服务（v0.5.0 审查修复）
//
// 审查发现：src/server 仍直接 import 插件内部 6 处
// （message-query/idle-archive/archive/memory/history）。
// 按架构约束"webui 只 import services"，这里聚合插件能力为门面。
//
// 注意：内部实现仍在插件层（agent-session/agent-memory），
// 本服务是薄包装，对外隐藏插件内部路径。
// ============================================================

import { getAppState } from '@agents/app-state';
import type { IMessageQuery } from '@plugins/builtin/extensions/agent-session/message-query';
import { requestArchive as pluginRequestArchive } from '@plugins/builtin/extensions/agent-session/archive';
import { idleArchive as pluginIdleArchive } from '@plugins/builtin/extensions/agent-session/idle-timer';
import { markMemoryReviewNeeded as pluginMarkMemoryReviewNeeded } from '@plugins/builtin/extensions/agent-memory/memory';
import { deleteFromJSONL as pluginDeleteFromJSONL } from '@plugins/builtin/extensions/agent-session/history';

export class HistoryService {
  /** 消息查询（读历史）—— 从服务注册表/AppState 获取插件 messageQuery */
  get query(): IMessageQuery | undefined {
    const state = getAppState() as Record<string, unknown>;
    return (state.serviceRegistry as any)?.get?.('messageQuery')
      ?? state.messageQuery as IMessageQuery | undefined;
  }

  /** 触发归档（1:1 会话）—— 委托插件 agent-session/archive */
  async requestArchive(agentId: string, counterpart: string): Promise<void> {
    await pluginRequestArchive(agentId, counterpart);
  }

  /** 空闲归档（后台定时） */
  async idleArchive(agent: string, counterpart: string): Promise<void> {
    pluginIdleArchive(agent, counterpart);
  }

  /** 标记记忆需审查 */
  async markMemoryReviewNeeded(agentId: string, counterpart: string): Promise<void> {
    pluginMarkMemoryReviewNeeded(agentId, counterpart);
  }

  /** 从 jsonl 删除消息 */
  async deleteFromJSONL(agentId: string, counterpart: string, messageId: string): Promise<boolean> {
    return pluginDeleteFromJSONL(agentId, counterpart, messageId);
  }
}
