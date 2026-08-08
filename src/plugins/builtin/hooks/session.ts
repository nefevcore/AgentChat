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
import { workspaceRoot } from '../tools/shared';
import {
  isGroupDialog, groupIdOfDialog, groupHistoryFile, groupSessionFile, sessionFileOf, counterpartOfDialog,
} from '../paths';

const log = createLogger('[builtin:session]');

/** 从 dialogId 解析当前 Agent（兼容旧 __ 格式末段；新逻辑优先显式 ctx.agentId） */
export function agentOfDialog(dialogId: string): string {
  const idx = dialogId.lastIndexOf('__');
  return idx >= 0 ? dialogId.slice(idx + 2) : dialogId.slice(dialogId.lastIndexOf('~') + 1);
}

/** 内存角色 → 持久化角色（与旧 toPersistedRole 对齐；user/assistant → agent） */
export function toPersistedRole(role: MessageRole): 'agent' | 'system' | 'tool' | 'trigger' | 'error' {
  if (role === 'user' || role === 'assistant') return 'agent';
  return role;
}

/** 加载会话历史（L2 AgentAssembly.loadHistory 实现；返回持久化格式，provider 做视角转换）
 *  1v1 读会话文件；群聊历史不参与功能逻辑（Agent 记忆来自本体/归档分析），返回空。 */
export function loadHistory(dialogId: string): LLMRequestMessage[] {
  if (isGroupDialog(dialogId)) return [];
  const file = sessionFileOf(dialogId);
  if (!fs.existsSync(file)) return [];
  const out: LLMRequestMessage[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LLMRequestMessage);
    } catch {
      // 忽略损坏行
    }
  }
  return out;
}

/** 把内存消息转为持久化格式 */
function toPersisted(m: Message, selfId: string): Record<string, unknown> {
  const isSpeech = m.role === 'user' || m.role === 'assistant';
  return {
    role: toPersistedRole(m.role),
    content: m.content ?? '',
    ...(isSpeech ? { agent_id: m.agent_id ?? selfId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.label ? { label: m.label } : {}),
    timestamp: m.timestamp ?? new Date().toISOString(),
  };
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
  const dialogId = ctx.dialogId;
  const loopMessages = result.messages;
  if (!dialogId || loopMessages.length === 0) return;
  // 1v1 排序共享会话键后不可从 dialogId 反推 selfId，显式优先
  const selfId = ctx.agentId ?? agentOfDialog(dialogId);
  try {
    const lines = loopMessages.map(m => JSON.stringify(toPersisted(m, selfId)));
    if (isGroupDialog(dialogId)) {
      // 群聊双写：
      //   ① 群聊本体 messages.jsonl —— 只落回话（speech，剔除思考/工具），参与功能逻辑
      //   ② 周归档 history_<YYYY>-<WW>.jsonl —— 全量（含思考/工具），仅分析复盘
      const gid = groupIdOfDialog(dialogId);
      const speech = loopMessages
        .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'agent')
        .map(m => JSON.stringify(toPersisted({ ...m, reasoning_content: undefined }, selfId)));
      if (speech.length > 0) {
        const file = groupSessionFile(gid);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, speech.join('\n') + '\n', 'utf-8');
      }
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
  const usage = result.usage;
  if (!usage) return;

  const dialogId = ctx.dialogId;
  if (!dialogId) return;
  const selfId = ctx.agentId ?? agentOfDialog(dialogId);
  const counterpart = counterpartOfDialog(dialogId, selfId);
  const model = ctx.llm?.model ?? 'unknown';

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
  log.info(`Token 用量 ${selfId}/${counterpart}：${parts.join(' | ')}`);

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
