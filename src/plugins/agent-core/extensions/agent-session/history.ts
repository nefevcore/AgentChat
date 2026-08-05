// ============================================================
// agent-session history —— 历史消息读写
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { LLMRequestMessage } from '@core/types';
import { estimateTokens, sanitizeSurrogates } from '@utils/tokens';
import { getGlobalConfig } from '@core/config';
import { resolveMessagePath } from './paths';
import { PersistedMessage } from './types';
import { resolveGroupMessagePath } from '@routing/group-manager';
import type { PersistedGroupMessage } from '@core/types';

// ============================================================
// Token 估算 —— 用于摘要触发阈值与归档触发阈值判断
// 2026-08-02（B3）：实现收拢到共享模块 src/utils/tokens.ts，此处仅再导出
// ============================================================

export { estimateTokens, estimateMessagesTokens } from '@utils/tokens';

/**
 * 按 token 预算从尾部截取消息。所有归档路径共享此逻辑。
 *
 * 从数组尾部向前累积 token，超出预算则停止。
 * 预算允许 1.5x 溢出以保证至少保留一条完整消息。
 *
 * 注意：调用方需自行处理 tool-call/response 成对保护（不同类型字段名不同）。
 */
export function truncateMessagesByTokenBudget<T extends { content?: string | null; reasoning_content?: string | null }>(
  messages: T[],
  tokenBudget: number,
): T[] {
  let accumulated = 0;
  let splitIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    let msgTokens = estimateTokens(messages[i].content ?? '');
    if (messages[i].reasoning_content) {
      msgTokens += estimateTokens(messages[i].reasoning_content ?? '');
    }
    if (accumulated + msgTokens > tokenBudget * 1.5 && accumulated > 0) break;
    accumulated += msgTokens;
    splitIdx = i;
  }

  splitIdx = Math.max(0, splitIdx);
  return messages.slice(splitIdx);
}

/**
 * 调整截断/归档分割点：若分割点落在 tool 消息上，回退到其配对 agent 消息之前，
 * 保证不拆分 tool-call/response 对。
 *
 * 结构判定（无需视角，兼容持久化与内存格式）：
 *   · role='tool' → 属于某对，向前回找其配对发起者
 *   · 配对发起者：role='agent'（持久化，非人类用户且带 tool_calls）
 *     或 role='assistant'（内存，带 tool_calls）
 *   · 其余（trigger / error / system / 人类 user / 无 tool_calls 的 agent）→ 入站边界
 *
 * 保留所有 Agent 的 tool 对是必要的（B2）：tool 对完整使上下文分块稳定，
 * 利于 DeepSeek 的 prompt_cache_hit_tokens 前缀缓存命中。
 */
export function safeSplitIdx(messages: LLMRequestMessage[], splitIdx: number): number {
  while (splitIdx > 0 && splitIdx < messages.length) {
    const atSplit = messages[splitIdx];
    if (atSplit.role !== 'tool') break;
    let found = false;
    for (let j = splitIdx - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.role === 'tool') continue; // 同一批工具结果，继续回找
      if (prev.role === 'assistant' && prev.tool_calls?.length) { splitIdx = j; found = true; break; }
      if (prev.role === 'agent' && prev.agent_id !== 'user' && prev.tool_calls?.length) { splitIdx = j; found = true; break; }
      break; // 入站边界
    }
    if (!found) break;
  }
  return splitIdx;
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
// 历史消息 —— messages.jsonl 读写
//
// 2026-08-02：loadHistory 返回「持久化消息格式」（role=agent/tool/trigger/error/system），
// 不再在加载时做视角转换（原 resolveRole 已移除）。LLM 所需的 user/assistant 交替序列
// 由 provider 的 toProviderMessages 依据 LLMRequest.viewer（当前视角 Agent ID）统一解析：
//   · agent + agent_id===viewer → assistant（当前视角自己发的）
//   · agent + agent_id≠viewer   → user（对方）
//   · agent_id === 'user'       → user（人类用户）
// ============================================================

/**
 * 从 messages.jsonl 加载历史消息（持久化格式，不解析视角）。
 *
 * 说明：
 *   - 返回 role ∈ agent/system/tool/trigger/error，与 messages.jsonl 存储一致；
 *   - tool_calls 保持 OpenAI 原生格式（LLMToolCall），交由 provider 归一化；
 *   - 2026-08-02：历史损坏（trigger+tool_call_id）与旧角色（user/assistant）已由
 *     session-maint.js migrate 一次性迁移，此处不再做运行时归一化。
 */
export function loadHistory(loadingAgent: string, counterpart: string): LLMRequestMessage[] {
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

          return {
            role: p.role,
            content: p.content ?? '',
            message_id: p.message_id,
            agent_id: p.agent_id,
            name: p.name,
            // 保持 OpenAI 原生格式，由 provider 归一化 + 视角安全裁剪
            tool_calls: p.tool_calls,
            tool_call_id: p.tool_call_id,
            reasoning_content: p.reasoning_content,
            label: p.label,
            // 保留原始时间戳：归档时不再重写，避免历史时间批量失真
            timestamp: p.timestamp,
          } as LLMRequestMessage;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as LLMRequestMessage[];
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

  // 纵深防御：写入前清洗 lone surrogate（2026-08-05，query_history 截断污染实测）。
  // 防毒数据进入会话历史 → 后续 LLM 请求 JSON.stringify 转义 → DeepSeek 400。
  const clean: PersistedMessage = {
    ...msg,
    content: sanitizeSurrogates(msg.content ?? ''),
    reasoning_content: msg.reasoning_content ? sanitizeSurrogates(msg.reasoning_content) : msg.reasoning_content,
  };

  const line = JSON.stringify(clean) + '\n';

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
 * 加载群组历史消息（持久化格式，2026-08-02 与 1:1 收拢）。
 *
 * 与 1:1 一致：返回 role ∈ agent/tool/trigger/error/system 的持久化格式，
 * user/assistant 视角由 provider 的 toProviderMessages 依据 viewer（loadingAgent）推导。
 * 此处仅做展示/提示层约定（源自 agent-prompt，与 LLM provider 无关）：
 *   · 非当前视角（agent_id≠viewer）的 agent 消息，内容封装 <msg from=... name=...> 标签
 *   · tool_calls 保持 OpenAI 原生格式（provider 依据视角保留/裁剪）
 *   · trigger 消息不再套 <msg>（其自身 <trigger> 包装已标识来源）
 *
 * @param groupId       群组 ID
 * @param loadingAgent  当前视角（viewer）Agent ID
 */
export function loadGroupHistory(groupId: string, loadingAgent: string, getName?: (agentId: string) => string): LLMRequestMessage[] {
  const filePath = resolveGroupMessagePath(groupId);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  // 2026-08-03：读取群名，给 <msg> 加 group 属性（与实时群聊消息统一格式）
  let groupName = groupId;
  try {
    const groupCfgPath = path.join(getGlobalConfig().groupsDir, groupId, 'group.json');
    if (fs.existsSync(groupCfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(groupCfgPath, 'utf-8'));
      if (cfg?.name) groupName = cfg.name;
    }
  } catch { /* 群配置不可用时用群ID */ }

  try {
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);

    const parsed = lines
      .map((line) => {
        try {
          const p = JSON.parse(line) as PersistedGroupMessage;
          // 2026-08-02：旧角色（user/assistant）已由 session-maint.js migrate 一次性迁移，
          // 此处直接使用持久化 role（群组文件历史即存储 'agent'）。
          const role = p.role as LLMRequestMessage['role'];
          const displayName = getName ? getName(p.agent_id) : null;
          const senderName = (displayName && displayName !== p.agent_id) ? displayName : p.agent_id;

          // 非当前视角的 agent 消息封装 <msg> 标签（展示/提示层约定，源自 agent-prompt）
          // 2026-08-03：群聊历史加 group 属性（群名），与实时群聊消息的
          // <msg from=... name=... group=...> 格式统一，Agent 能识别"这是群聊发言"
          let content = p.content ?? '';
          if (role === 'agent' && p.agent_id !== loadingAgent) {
            content = `<msg from="${p.agent_id}" name="${escapeMsgAttr(senderName)}" group="${escapeMsgAttr(groupName)}">${content}</msg>`;
          }

          return {
            role,
            content,
            agent_id: p.agent_id,
            name: p.name,
            // 保持 OpenAI 原生格式，由 provider 依据视角保留/裁剪（A3：user 视角丢弃 tool_calls）
            tool_calls: p.tool_calls,
            tool_call_id: p.tool_call_id,
            reasoning_content: p.reasoning_content,
            label: p.label,
            timestamp: p.timestamp,
          } as LLMRequestMessage;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as LLMRequestMessage[];

    // 2026-08-03：合并相邻"对方视角"的纯发言消息（provider 视角转换后成为 user）。
    // 群聊多参与者连续发言 → 连续多条 user，原样透传会稀释注意力、多占 token（重复的角色标记）；
    // 此处合成一条（<msg> 标签已区分发言人）。仅合并 role='agent'、非 loadingAgent、无 tool_calls
    // 的相邻消息；自身消息（转 assistant）、tool/trigger/error/system 及带工具调用的消息
    // 不参与（避免拆散 tool-call/response 对）。
    const merged: LLMRequestMessage[] = [];
    for (const m of parsed) {
      const last = merged[merged.length - 1];
      const isPeerSpeech =
        m.role === 'agent' && m.agent_id !== loadingAgent && !m.tool_calls?.length;
      if (
        isPeerSpeech &&
        last &&
        last.role === 'agent' &&
        last.agent_id !== loadingAgent &&
        !last.tool_calls?.length
      ) {
        last.content = `${last.content}\n${m.content}`;
      } else {
        merged.push(m);
      }
    }
    return merged;
  } catch {
    return [];
  }
}
