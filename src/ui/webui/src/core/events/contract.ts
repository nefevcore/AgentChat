// ============================================================
// core/events/contract.ts —— WS 事件契约（单一来源）
//
// 所有出站/入站事件名与载荷类型集中于此，杜绝散落字符串。
// 约束：与后端协议对齐，勿私自改名（改事件名只改这一处）。
// ============================================================

// ── 出站事件（客户端 → 服务器）──
export const WS_SEND = {
  chatSend: 'chat.send',
  chatInterrupt: 'chat.interrupt',
  chatContinue: 'chat.continue',
  chatSubscribe: 'chat.subscribe',
  chatDeleteMessage: 'chat.delete_message',
  chatInteractRespond: 'chat.interact.respond',
  historyRequest: 'history.request',
  agentList: 'agent.list',
  agentSystemPrompt: 'agent.system_prompt',
  agentToolDefs: 'agent.tool_defs',
  sessionCompress: 'session.compress',
  systemRestart: 'system.restart',
  groupMessage: 'group.message',
} as const;

// ── 入站事件（服务器 → 客户端）──
export const WS_EVENT = {
  // 消息流（feed ingest 处理）
  chatStart: 'chat.start',
  chatTurnStart: 'chat.turn.start',
  chatTurnEnd: 'chat.turn.end',
  chatInterrupted: 'chat.interrupted',
  chatEnd: 'chat.end',
  chatMessageStart: 'chat.message.start',
  chatMessageUpdate: 'chat.message.update',
  chatMessageEnd: 'chat.message.end',
  chatMessageError: 'chat.message.error',
  chatThinkingStart: 'chat.thinking.start',
  chatThinkingUpdate: 'chat.thinking.update',
  chatThinkingEnd: 'chat.thinking.end',
  chatToolcallStart: 'chat.toolcall.start',
  chatToolcallUpdate: 'chat.toolcall.update',
  chatToolcallEnd: 'chat.toolcall.end',
  chatToolExecutionStart: 'chat.tool_execution.start',
  chatToolExecutionUpdate: 'chat.tool_execution.update',
  chatToolExecutionEnd: 'chat.tool_execution.end',
  chatSessionResume: 'chat.session.resume',
  chatVirtualReceive: 'chat.virtual.receive',
  historyResponse: 'history.response',
  groupMessage: 'group.message',

  // 非消息类（chat store 处理）
  agentListResponse: 'agent.list.response',
  agentProfileUpdated: 'agent.profile.updated',
  chatSendAck: 'chat.send.ack',
  chatInteraction: 'chat.interaction',
  chatInteractRespond: 'chat.interact.respond',
  sessionCompressed: 'session.compressed',
  sessionArchived: 'session.archived',
  systemRestarting: 'system.restarting',
  agentSystemPromptResponse: 'agent.system_prompt.response',
  agentToolDefsResponse: 'agent.tool_defs.response',

  // 群组（App / 群组列表维护）
  groupCreated: 'group.created',
  groupDeleted: 'group.deleted',
  groupJoin: 'group.join',
  groupLeave: 'group.leave',
} as const;

// ── 载荷类型（出站）──
export interface ChatSendPayload {
  to: string;
  content: string;
  deepThink: boolean;
  files: unknown[];
}

export interface ChatInterruptPayload { to: string }
export interface ChatSubscribePayload { to: string }
export interface ChatContinuePayload { to: string }
export interface ChatDeleteMessagePayload { agent: string; counterpart: string; messageId: string }
export interface ChatInteractRespondPayload { interaction_id: string; choice: string }
export interface HistoryRequestPayload { from: string; to: string; limit: number; offset: number }
export interface AgentIdPayload { agentId: string }
export interface SessionCompressPayload { agent: string; counterpart: string }
export interface GroupMessageSendPayload { group_id: string; content: string; from: string }

// ── 入站关键载荷 ──
/** chat.message.update / thinking.update / tool_execution.update 的增量载荷 */
export interface StreamDeltaPayload { delta?: string; agentId?: string; agent?: string }
/** chat.message.end 汇总载荷 */
export interface MessageEndPayload {
  content?: string;
  reasoning?: string;
  tool_calls?: unknown;
  agentId?: string;
  agent?: string;
}
/** group.message 入站事件 */
export interface GroupMessageEvent {
  group_id: string;
  from: string;
  payload?: string;
  content?: string;
}
/** 消息流事件的公共字段（agentId / agent / sender / dialogId） */
export interface StreamEventBase {
  agentId?: string;
  agent?: string;
  sender?: string;
  dialogId?: string;
}
