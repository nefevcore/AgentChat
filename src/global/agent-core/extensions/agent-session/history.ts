// ============================================================
// agent-session history —— 历史消息读写
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Message } from '@core/types';
import { resolveMessagePath } from './paths';
import { PersistedMessage } from './types';
import { resolveGroupMessagePath } from '@routing/group-manager';
import type { PersistedGroupMessage } from '@core/types';

// ============================================================
// Token 估算 —— 用于摘要触发阈值与归档触发阈值判断
// ============================================================

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
  return messages.reduce((sum, m) => {
    let t = estimateTokens(m.content);
    // reasoning_content 也需计入：DeepSeek 思考内容可达数千 token，
    // 不计入会导致压缩算法分割点失真（消息被误估为 0 token）。
    if (m.reasoning_content) {
      t += estimateTokens(m.reasoning_content);
    }
    return sum + t;
  }, 0);
}

// ============================================================
// 工具函数
// ============================================================

/** 安全的 JSON 解析，失败时返回空对象 */
export function safeJsonParse(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ============================================================
// 角色校正 —— 基于 agent_id 还原消息的"显示角色"
//
// messages.jsonl 中统一以 role='agent' 存储（避免 user/assistant
// 误导运维检阅），加载时根据 agent_id + loadingAgent 重新构造
// LLM 所需的 user/assistant 交替序列。
// ============================================================

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
  // tool/error 角色无歧义，直接返回
  if (storedRole === 'tool') return 'tool';
  if (storedRole === 'error') return 'tool'; // error 当成 tool 结果

  // 旧数据兼容：无 agent_id 时保持原始 role（user/assistant 旧格式）
  if (!agentId) {
    if (storedRole === 'agent') return 'user'; // 无归属的 agent 消息视为对端
    return storedRole as 'user' | 'assistant';
  }

  // 人类用户万年 user
  if (agentId === 'user') return 'user';

  // agent role → 基于 agent_id 判定：自己发的 = assistant，别人发的 = user
  if (storedRole === 'agent') {
    return agentId === loadingAgent ? 'assistant' : 'user';
  }

  // 旧数据兼容（role = 'user' / 'assistant'）
  if (agentId === loadingAgent) return 'assistant';
  return 'user';
}

// ============================================================
// 历史消息 —— messages.jsonl 读写
// ============================================================

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

          // reasoning_content 保留用于准确的 token 估算。
          // buildRequestBody 仅对最后一条 assistant 消息回传 reasoning_content，
          // 更早轮次的思考内容不会发送给 LLM。
          return {
            role,
            content: p.content ?? '',
            message_id: p.message_id,
            agent_id: p.agent_id,
            name: p.name,
            tool_calls: toolCalls,
            tool_call_id: p.tool_call_id,
            reasoning_content: p.reasoning_content,
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
 * 生成消息唯一 ID（格式：msg-时间戳-随机串）
 */
export function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

// ============================================================
// 延迟持久化 —— VirtualAgent 消息缓冲区
//
// 问题：VirtualAgent 在 send_agent 工具执行期间被同步调用，
// 若立即 persist 则消息会插入到发送方 Agent 的工具调用/回复之前，
// 打乱消息流。
//
// 解决：VirtualAgent 将消息加入延迟缓冲区。缓冲区的所有消息由
// 发送方 Agent 的 postHook 在完成自身持久化后统一刷入。刷新按
// Agent 维度而非 pair 维度，以覆盖级联场景（A→B 时 B→user）。
// ============================================================

/** 延迟持久化消息缓冲区，key = canonical session pair (lo/hi) */
const deferredMessages = new Map<string, PersistedMessage[]>();

function deferredKey(agentA: string, agentB: string): string {
  const [lo, hi] = [agentA, agentB].sort();
  return `${lo}/${hi}`;
}

/** 将消息加入延迟缓冲区（不立即写文件） */
export function deferMessage(agentA: string, agentB: string, msg: PersistedMessage): void {
  const key = deferredKey(agentA, agentB);
  let msgs = deferredMessages.get(key);
  if (!msgs) {
    msgs = [];
    deferredMessages.set(key, msgs);
  }
  msgs.push(msg);
}

/**
 * 刷新指定 Agent 在缓冲区中的所有延迟消息。
 *
 * 遍历所有 pair 键，对包含 agentId 的 pair 执行刷入。
 * 这覆盖了级联场景：A→B→user 时，B 的 postHook 会同时刷新
 * (A,B) 和 (B,user) 两个 pair 的延迟消息。
 */
export function flushDeferredMessagesForAgent(agentId: string): void {
  const toFlush: string[] = [];
  for (const key of deferredMessages.keys()) {
    if (key.startsWith(`${agentId}/`) || key.endsWith(`/${agentId}`)) {
      toFlush.push(key);
    }
  }

  for (const key of toFlush) {
    const msgs = deferredMessages.get(key);
    if (!msgs || msgs.length === 0) continue;

    const [a, b] = key.split('/');
    for (const msg of msgs) {
      appendJSONL(a, b, msg);
    }
    deferredMessages.delete(key);
  }
}

/**
 * 从 messages.jsonl 中删除指定 message_id 的消息行。
 * 逐行读取、过滤、重写文件。也检查归档文件。
 *
 * @returns 是否成功删除至少一条
 */
export function deleteFromJSONL(agent: string, counterpart: string, messageId: string): boolean {
  const filePath = resolveMessagePath(agent, counterpart);
  let deleted = false;

  // 1. 删除活跃消息文件中的匹配行
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const filtered = lines.filter(line => {
      try {
        const obj = JSON.parse(line);
        if (obj.message_id === messageId) { deleted = true; return false; }
        return true;
      } catch { return true; }
    });
    if (deleted) {
      fs.writeFileSync(filePath, filtered.map(l => l + '\n').join(''), 'utf-8');
      return true;
    }
  }

  // 2. 检查归档文件
  const archiveDir = path.join(path.dirname(filePath), 'archive');
  if (fs.existsSync(archiveDir)) {
    const archiveFiles = fs.readdirSync(archiveDir)
      .filter(f => /^history_\d+\.jsonl$/.test(f));
    for (const archiveFile of archiveFiles) {
      const archivePath = path.join(archiveDir, archiveFile);
      const lines = fs.readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean);
      const filtered = lines.filter(line => {
        try {
          const obj = JSON.parse(line);
          if (obj.message_id === messageId) { deleted = true; return false; }
          return true;
        } catch { return true; }
      });
      if (deleted) {
        if (filtered.length === 0) {
          fs.unlinkSync(archivePath);
        } else {
          fs.writeFileSync(archivePath, filtered.map(l => l + '\n').join(''), 'utf-8');
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * 对 <msg> 标签属性值进行转义，防止 XML 注入。
 */
function escapeMsgAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 加载群组历史消息并转换为 Agent 可用的 Message 列表。
 *
 * 角色校正规则（群组模式）：
 *   - 自己的消息 → assistant，内容不变
 *   - 其他人的消息 → user，内容用 <msg from="..." name="...">...</msg> 标签包裹
 *   - tool 角色不变
 *
 * @param roomId       群组 ID
 * @param loadingAgent 正在加载历史的 Agent ID
 */
export function loadGroupHistory(roomId: string, loadingAgent: string, getName?: (agentId: string) => string): Message[] {
  const filePath = resolveGroupMessagePath(roomId);

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
          const p = JSON.parse(line) as PersistedGroupMessage;

          if (p.role === 'tool') {
            return {
              role: 'tool' as const,
              content: p.content ?? '',
              agent_id: p.agent_id,
              name: p.name,
              tool_call_id: p.tool_call_id,
            } as Message;
          }

          const isMine = p.agent_id === loadingAgent;
          const displayName = getName ? getName(p.agent_id) : null;
          const senderName = (displayName && displayName !== p.agent_id) ? displayName : p.agent_id;
          return {
            role: isMine ? 'assistant' as const : 'user' as const,
            content: isMine
              ? (p.content ?? '')
              : `<msg from="${p.agent_id}" name="${escapeMsgAttr(senderName)}">${p.content ?? ''}</msg>`,
            agent_id: p.agent_id,
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
