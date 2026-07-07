// ====================================================================
// agent-session history —— 历史消息读写
// ====================================================================

import * as fs from 'fs';
import * as path from 'path';
import { Message } from '../../../core/types';
import { resolveMessagePath } from './paths';
import { PersistedMessage } from './types';

// ====================================================================
// Token 估算 —— 用于摘要触发阈值与归档触发阈值判断
// ====================================================================

/**
 * 估算文本 token 数。
 * 中文字符约 0.6 token/字，英文字符约 0.3 token/字。
 * 这是一个近似值，用于阈值判断，不要求精确匹配 LLM tokenizer。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.3;
  }
  return Math.ceil(tokens);
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// ====================================================================
// 工具函数
// ====================================================================

/** 安全的 JSON 解析，失败时返回空对象 */
export function safeJsonParse(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ====================================================================
// 角色校正 —— 基于 agent_id 还原消息的"显示角色"
//
// messages.jsonl 中 role 是从接收方视角记录的，多 Agent 会话中需要
// 从加载方视角重新校正，确保 LLM 上下文符合 user/assistant 交替规范。
// ====================================================================

/**
 * 基于 agent_id 校正消息角色。
 *
 * @param storedRole  JSONL 中存储的原始 role
 * @param agentId     消息的 agent_id（谁产生的）
 * @param loadingAgent 正在加载历史的 Agent ID
 * @returns 校正后的 role
 */
export function resolveRole(
  storedRole: string,
  agentId: string | undefined,
  loadingAgent: string,
): 'system' | 'user' | 'assistant' | 'tool' {
  // tool 角色无歧义，直接返回
  if (storedRole === 'tool') return 'tool';

  // 旧数据兼容：无 agent_id 时保持原始 role
  if (!agentId) return storedRole as 'user' | 'assistant';

  // 人类用户万年 user
  if (agentId === 'user') return 'user';

  // 当前 Agent 自己产生的消息 → assistant
  if (agentId === loadingAgent) return 'assistant';

  // 其他 Agent 发来的消息 → user
  return 'user';
}

// ====================================================================
// 历史消息 —— messages.jsonl 读写
// ====================================================================

/**
 * 从 messages.jsonl 加载历史消息，并基于 agent_id 校正角色。
 *
 * 背景：Agent 间会话共享 messages.jsonl，消息的 role 字段是从"接收方"视角记录的。
 * 例如 chat_agent → coding_agent 的消息在 JSONL 中 role="user"（coding_agent 视角），
 * 但 loadingAgent=chat_agent 时这条消息应该是 assistant（自己发出的）。
 *
 * 角色校正规则：
 *   - tool 角色 → 不变（工具消息无歧义）
 *   - agent_id === 'user' → 保持原始 role（人类用户万年 user）
 *   - agent_id === loadingAgent → role 校正为 assistant（自己产生的消息）
 *   - agent_id 为其他 Agent → role 校正为 user（对方发来的消息）
 *   - agent_id 缺失（旧数据兼容）→ 保持原始 role
 *
 * 其他转换说明：
 *   - PersistedMessage.tool_calls (OpenAI 格式) → Message.tool_calls (简化格式)
 *   - 空 tool_calls 数组被过滤（避免 assistant 消息附带 [] 导致下游异常）
 *   - reasoning_content 刻意不加载到 Message 中（思考内容是临时草稿，
 *     跨轮传入浪费 token 且可能干扰模型判断）
 */
export function loadHistory(loadingAgent: string, counterpart: string): Message[] {
  const filePath = resolveMessagePath(loadingAgent, counterpart);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);

    return lines
      .map((line) => {
        try {
          const p = JSON.parse(line) as PersistedMessage;
          // Convert PersistedMessage.tool_calls → Message.ToolCall[]
          const rawToolCalls = p.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: safeJsonParse(tc.function.arguments),
          }));
          const toolCalls = rawToolCalls?.length ? rawToolCalls : undefined;

          // 基于 agent_id 校正 role
          const role = resolveRole(p.role, p.agent_id, loadingAgent);

          // 注意：刻意不传入 reasoning_content。
          // 思考内容是模型针对当前问题的临时草稿，跨轮次传入会浪费大量 token
          // 且可能干扰模型判断（DeepSeek 官方也建议不要跨轮传入）。
          // 持久化层（JSONL）仍保留 reasoning_content 用于调试和 UI 展示。
          return {
            role,
            content: p.content ?? '',
            agent_id: p.agent_id,
            name: p.name,
            tool_calls: toolCalls,
            tool_call_id: p.tool_call_id,
            label: p.label,
          } as Message;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Message[];
  } catch {
    return [];
  }
}

/**
 * 追加一条消息到 messages.jsonl。
 * JSONL 格式：每行一个 JSON 对象，行间以换行分隔。
 * 首次写入时不添加前导换行（避免文件以空行开头）。
 */
export function appendJSONL(agent: string, counterpart: string, msg: PersistedMessage): void {
  const filePath = resolveMessagePath(agent, counterpart);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(msg) + '\n';

  fs.appendFileSync(filePath,  line, 'utf-8');
}
