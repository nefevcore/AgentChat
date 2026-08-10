// ============================================================
// src/plugins/builtin/hooks/session.ts —— 会话持久化钩子（L3，替代旧 agent-session 核心）
//
// 整次执行结束（runEnd）即记录 —— 作为 runEndHook 与执行流同层。
// 同时提供 loadHistory 服务（L2 AgentAssembly.loadHistory 的实现，具名导出）。
//
// 存储约定（基于 workspaceDir，AGENTCHAT_WORKSPACE 覆盖）：
//   · 1v1 会话：<ws>/sessions/chat~<lo>~<hi>/messages.jsonl（lo/hi 排序保证唯一）
//   · 群聊本体：<ws>/sessions/group~<gid>/messages.jsonl（回话，无思考/工具，参与功能逻辑）
//   · 群聊思考：<ws>/sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl
//     （全量含思考/工具，每 Agent 每周增量，仅分析复盘，不参与功能逻辑）
//   · 归属约定：消息 agent_id = selfId（显式 ctx.agentId；1v1 排序后不可从 dialogId 反推）
//
// 归档/压缩/截断（上下文管理）为后续增量，本轮只做「记录 + 读取」。
//
// 依赖方向：仅依赖 src/core + Node fs/path + 本层 paths。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { LLMRequestMessage, Message, MessageRole, RunResult } from '@core/types';
import type { CurrentContext } from '@core/context';
import { createLogger } from '@core/logger';
import { workspaceRoot, estimateTokens } from '../tools/shared';
import {
  isGroupDialog, groupIdOfDialog, groupHistoryFile, groupSessionFile, sessionFileOf, counterpartOfDialog,
} from '../paths';
import { META_ARCHIVE_REVIEW } from '../namespaces';

const log = createLogger('[builtin:session]');

/** 从 dialogId 解析当前 Agent（兼容旧 __ 格式末段；新逻辑优先显式 ctx.agentId） */
export function agentOfDialog(dialogId: string): string {
  const idx = dialogId.lastIndexOf('__');
  return idx >= 0 ? dialogId.slice(idx + 2) : dialogId.slice(dialogId.lastIndexOf('~') + 1);
}

/** 语义化中断原因 → 控制台可读文本 */
function formatInterruptReason(r?: import('@core/interrupt').InterruptReason): string {
  if (!r) return 'unknown';
  switch (r.type) {
    case 'user-abort': return `用户打断${r.detail ? `：${r.detail}` : ''}`;
    case 'tool-interrupt': return `工具中止（${r.tool}）${r.detail ? `：${r.detail}` : ''}`;
    case 'reload-requested': return '请求热重载';
    case 'restart-requested': return `请求重启${r.reason ? `：${r.reason}` : ''}`;
    case 'max-turns': return '达到最大推理轮次';
  }
}

/** 内存角色 → 持久化角色（与旧 toPersistedRole 对齐；user/assistant → agent） */
export function toPersistedRole(role: MessageRole): 'agent' | 'system' | 'tool' | 'trigger' | 'error' {
  if (role === 'user' || role === 'assistant') return 'agent';
  return role;
}

/** 加载会话历史（L2 AgentAssembly.loadHistory 实现；返回持久化格式，provider 做视角转换）
 *  1v1 读会话文件；群聊由 loadGroupHistory 注入（runStart 钩子 makeLoadHistoryHook 调用），此处返回空。 */
export function loadHistory(dialogId: string): LLMRequestMessage[] {
  if (isGroupDialog(dialogId)) return [];
  const file = sessionFileOf(dialogId);
  if (!fs.existsSync(file)) return [];
  const out: LLMRequestMessage[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as LLMRequestMessage;
      // 兼容旧数据：无 message_id 的补稳定 ID（供去重/归档二次去重/前端 persistedMsgId）
      if (!m.message_id) m.message_id = stableMessageIdOf(dialogId, m);
      out.push(m);
    } catch {
      // 忽略损坏行
    }
  }
  return out;
}

/** 对 <msg> 标签属性值进行转义，防止 XML 注入（与旧 loadGroupHistory 一致） */
function escapeMsgAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 加载群聊历史（恢复旧架构 agent-session loadGroupHistory 行为）。
 *
 * 读取群聊本体 <ws>/sessions/group~<gid>/messages.jsonl（只含 send_group 投递的真实回话，
 * 无思考/工具调用），注入未归档的群聊历史。特殊处理流程（与旧实现逐条对齐）：
 *   · 非当前视角（agent_id≠viewer）的 agent 消息，内容封装 <msg from=... name=... group=...> 标签
 *     —— 与实时群聊 trigger 的 hint 格式（router.ts）统一，Agent 能识别"这是群聊发言"；
 *   · 合并相邻"对方视角"的纯发言消息（2026-08-03 空转修复：连续 user 稀释注意力、多占 token）；
 *   · 按 groupLoadLimitTokens 从尾部截断保留近期（群聊共享历史多参与者全量加载，必须控制单次加载量）。
 *
 * 名称映射（getName）与群名（getGroupName）由调用方注入（registry/groupManager）；
 * 群名缺省回退读 group.json，再回退 groupId。
 *
 * @param groupId  群组 ID
 * @param viewer   当前视角（自己）Agent ID——自己的消息不套 <msg>，provider 视角转换后成 assistant
 */
export function loadGroupHistory(
  groupId: string,
  viewer: string,
  opts?: {
    getName?: (agentId: string) => string;
    getGroupName?: (groupId: string) => string | undefined;
    groupLoadLimitTokens?: number;
  },
): LLMRequestMessage[] {
  const filePath = groupSessionFile(groupId);
  if (!fs.existsSync(filePath)) return [];

  // 群名（<msg group=...> 用）：优先注入的 getGroupName，回退读 group.json，再回退群 ID
  let groupName = groupId;
  if (opts?.getGroupName) {
    try {
      const n = opts.getGroupName(groupId);
      if (n) groupName = n;
    } catch { /* 回退 */ }
  }
  if (groupName === groupId) {
    try {
      const cfgPath = path.join(workspaceRoot(), 'groups', groupId, 'group.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg?.name) groupName = cfg.name;
      }
    } catch { /* 群配置不可用时用群 ID */ }
  }

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const parsed = lines
      .map((line) => {
        try {
          const p = JSON.parse(line) as LLMRequestMessage;
          const displayName = opts?.getName ? opts.getName(p.agent_id ?? '') : null;
          const senderName = displayName && displayName !== p.agent_id ? displayName : (p.agent_id ?? '');
          let content = p.content ?? '';
          // 非当前视角的 agent 消息封装 <msg> 标签（展示/提示层约定，源自旧 agent-prompt）
          if (p.role === 'agent' && p.agent_id !== viewer) {
            content = `<msg from="${p.agent_id ?? ''}" name="${escapeMsgAttr(senderName)}" group="${escapeMsgAttr(groupName)}">${content}</msg>`;
          }
          return {
            role: p.role,
            content,
            agent_id: p.agent_id,
            name: p.name,
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

    // 合并相邻"对方视角"的纯发言消息（群聊多参与者连续发言 → 连续多条 user，
    // 合成一条；<msg> 标签已区分发言人）。仅合并 role='agent'、非 viewer、无 tool_calls 的
    // 相邻消息；自身消息、tool/trigger/error/system 及带工具调用的不参与。
    const merged: LLMRequestMessage[] = [];
    for (const m of parsed) {
      const last = merged[merged.length - 1];
      const isPeerSpeech = m.role === 'agent' && m.agent_id !== viewer && !m.tool_calls?.length;
      if (
        isPeerSpeech &&
        last &&
        last.role === 'agent' &&
        last.agent_id !== viewer &&
        !last.tool_calls?.length
      ) {
        last.content = `${last.content}\n${m.content}`;
      } else {
        merged.push(m);
      }
    }

    // 超限截断（保留尾部近期）：群聊本体无 tool_calls，无需 safeSplitIdx
    const limit = opts?.groupLoadLimitTokens;
    if (typeof limit === 'number' && limit > 0) {
      const loaded = merged.reduce((acc, m) => acc + estimateTokens(m.content ?? ''), 0);
      if (loaded > limit) {
        let acc = 0;
        let start = merged.length;
        for (let i = merged.length - 1; i >= 0; i--) {
          const t = estimateTokens(merged[i].content ?? '');
          if (acc + t > limit && acc > 0) break;
          acc += t;
          start = i;
        }
        const truncated = merged.slice(Math.max(0, start));
        log.info(`[builtin:session] 群聊历史 ${groupId} 超限 ${loaded} > ${limit}，截断保留尾部 ${truncated.length} 条`);
        return truncated;
      }
    }
    return merged;
  } catch {
    return [];
  }
}

/** 把内存消息转为持久化格式 */
function toPersisted(m: Message, selfId: string): Record<string, unknown> {
  const isSpeech = m.role === 'user' || m.role === 'assistant';
  return {
    role: toPersistedRole(m.role),
    content: m.content ?? '',
    // 消息唯一 ID（WebUI 历史去重/persistedMsgId 标记/消息删除都依赖）。
    // 缺省时生成（对齐旧架构 appendJSONL 的 genMessageId）；已存在则保留（归档重建时透传原 ID）。
    message_id: m.message_id ?? genMessageId(),
    ...(isSpeech ? { agent_id: m.agent_id ?? selfId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.label ? { label: m.label } : {}),
    timestamp: m.timestamp ?? new Date().toISOString(),
  };
}

/** 生成消息唯一 ID（对齐旧架构 genMessageId：msg-时间戳-随机串） */
export function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 为无 message_id 的历史消息生成稳定 ID（旧数据兼容）。
 * 基于 dialogId + timestamp + content，同一消息跨读取 ID 恒定，
 * 供归档二次去重 / 前端 persistedMsgId / 消息删除使用。
 */
export function stableMessageIdOf(dialogId: string, m: { timestamp?: string; role?: string; content?: string | null }): string {
  const ts = m.timestamp ?? '';
  const content = String(m.content ?? '').slice(0, 200);
  const seed = `${dialogId}|${ts}|${m.role ?? ''}|${content}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return `hist-${Math.abs(h).toString(36)}-${ts.replace(/[^\d]/g, '').slice(-8) || '0'}`;
}

// ============================================================
// runEnd 钩子：整次执行结束记录（会话持久化 + Token 用量）
// ============================================================

/**
 * 会话持久化（runEnd 钩子：整次执行结束唯一写盘）。
 * 接收整次 RunResult.messages（完整、唯一），避免多轮 turnEnd 重复追加。
 */
export async function saveSession(
  ctx: CurrentContext,
  result: RunResult,
): Promise<void> {
  // 归档整理轮不落盘（仅整理记忆/写 SUMMARY.md，不污染会话文件）
  if (ctx.meta?.[META_ARCHIVE_REVIEW]) return;
  const dialogId = ctx.dialogId;
  const loopMessages = result.messages;
  if (!dialogId || loopMessages.length === 0) return;
  // 1v1 排序共享会话键后不可从 dialogId 反推 selfId，显式优先
  const selfId = ctx.agentId ?? agentOfDialog(dialogId);
  try {
    const lines = loopMessages.map(m => JSON.stringify(toPersisted(m, selfId)));
    if (isGroupDialog(dialogId)) {
      // 群聊：仅写周归档（全量，含思考/工具，仅分析复盘）。
      // 群聊本体 messages.jsonl 由 L4 GroupService 监听 group.message.received
      // 统一落盘——只记录 send_group 工具投递/用户 WebUI 发到群里的真实消息，
      // 避免思考/工具调用污染功能历史。
      const gid = groupIdOfDialog(dialogId);
      const afile = groupHistoryFile(gid, selfId);
      fs.mkdirSync(path.dirname(afile), { recursive: true });
      fs.appendFileSync(afile, lines.join('\n') + '\n', 'utf-8');
      return;
    }
    // 1v1：写入会话文件
    const file = sessionFileOf(dialogId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.join('\n') + '\n', 'utf-8');
  } catch (err: any) {
    log.error(`会话持久化失败（${dialogId}）: ${err?.message ?? String(err)}`);
  }
}

// ============================================================
// runEnd 钩子：整次执行结束记录 Token 用量（照搬旧 agent-session logUsage）
// ============================================================

/**
 * runEnd：记录整次执行的 Token 用量到 <ws>/usage/token_<date>.jsonl。
 * 旧实现放在每轮 postHook；usage 是整次 run 累计的，放 runEnd 更准确。
 */
export async function logRunUsage(
  ctx: CurrentContext,
  result: import('@core/types').RunResult,
): Promise<void> {
  const dialogId = ctx.dialogId;
  const selfId = ctx.agentId ?? (dialogId ? agentOfDialog(dialogId) : '?');
  const counterpart = dialogId ? counterpartOfDialog(dialogId, selfId) : '?';
  const model = ctx.llm?.model ?? 'unknown';
  const usage = result.usage;

  // 完成标志（总是打印，便于控制台分辨 Agent 是否仍在推理；与旧 agent-session 一致）
  const status = result.interrupted
    ? `中断（${formatInterruptReason(result.interruptReason)}）`
    : '完成';
  console.log(`[agent-session] ${selfId}${counterpart !== '?' ? `/${counterpart}` : ''} 执行${status}（${model}）`);

  if (!usage) return;

  const turns = usage.react_turns ?? 0;
  const accPrompt = usage.accumulated_prompt_tokens ?? usage.prompt_tokens;
  const accTotal = usage.accumulated_total_tokens ?? usage.total_tokens;
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
  const cacheTotal = cacheHit + cacheMiss;
  const hitRate = cacheTotal > 0 ? ((cacheHit / cacheTotal) * 100).toFixed(1) : '-';

  const parts: string[] = [];
  if (turns > 0) parts.push(`ReAct 迭代 ${turns} 次`);
  parts.push(`模型 ${model}`);
  parts.push(`本次输入 ${usage.prompt_tokens}`);
  parts.push(`总输入 ${accPrompt}`);
  parts.push(`总输出 ${usage.completion_tokens}`);
  if (cacheTotal > 0) {
    parts.push(`总缓存命中 ${cacheHit}`);
    parts.push(`总缓存未命中 ${cacheMiss}`);
    parts.push(`缓存命中率 ${hitRate}%`);
  }
  parts.push(`总计 ${accTotal}`);
  console.log(`[agent-session] Token 用量 ${selfId}/${counterpart}：${parts.join(' | ')}`);

  try {
    const date = new Date().toISOString().slice(0, 10);
    const usageDir = path.join(workspaceRoot(), 'usage');
    if (!fs.existsSync(usageDir)) {
      fs.mkdirSync(usageDir, { recursive: true });
    }
    const record = {
      timestamp: new Date().toISOString(),
      agent: selfId,
      counterpart,
      model,
      react_turns: turns,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      accumulated_prompt_tokens: accPrompt,
      accumulated_total_tokens: accTotal,
      prompt_cache_hit_tokens: cacheHit,
      prompt_cache_miss_tokens: cacheMiss,
      cache_hit_rate: hitRate === '-' ? null : parseFloat(hitRate),
    };
    fs.appendFileSync(
      path.join(usageDir, `token_${date}.jsonl`),
      JSON.stringify(record) + '\n',
      'utf-8',
    );
  } catch (err: any) {
    log.warn(`用量记录失败: ${err?.message ?? String(err)}`);
  }
}
