// ============================================================
// agent-session 扩展 —— 会话持久化插件
//
// 概述：
//   本插件是 AgentChat 的默认会话持久化实现，通过 preHook / postHook
//   机制介入 Agent.run() 的生命周期，管理对话历史和上下文压缩。
//
//   长期记忆（记忆提取、跨会话保留）已拆分至 agent-memory 扩展，
//   两者独立运作，通过 hook 链自然组合。
//
// ---- 摘要 (Summary) ----
//   · 触发条件：preHook 中历史消息 token 超过 maxContextTokens 阈值
//   · 目的：压缩上下文，防止 LLM 上下文窗口溢出导致调用失败
//   · 生命周期：仅当前 Agent.run() 调用有效，不持久化
//
// ---- preHook 流程 ----
//   1. 加载历史消息 (messages.jsonl) → 填充 ctx.history
//   2. token 超阈值时 → 将早期消息压缩为 LLM 摘要 → 拼接到系统提示词
//
// ---- postHook 流程 ----
//   1. 持久化本轮完整对话到 messages.jsonl（含 user / assistant / tool）
//   2. token 超阈值时 → 归档旧消息到 archive/，重建 messages.jsonl
//   3. 记录本轮 LLM Token 用量
//   4. 重置空闲归档定时器 → 长时间无对话后自动归档
//
// ---- 空闲归档 ----
//   每次 postHook 完成后重置该会话对的空闲定时器（默认 30 分钟）。
//   若定时器到期（即长时间无新对话），自动将 messages.jsonl 移入 archive/，
//   下一轮对话将从空白历史开始。可通过全局 config.json 的 idleArchiveSec
//   字段配置阈值（单位：秒）。
//
// ---- token 阈值双重判断 ----
//   preHook  判断：压缩上下文 → 防止 LLM 调用失败（罕见兜底）
//   postHook 判断：归档 JSONL → 防止消息文件无限增长
//   两者使用同一阈值 (maxContextTokens)，但服务于不同目的。
//   postHook 归档时主动将重建文件控制在安全水位（≤ 80% maxContextTokens），
//   因此正常情况下 preHook 压缩不会触发；只在异常长单轮消息时作为兜底。
//
// ---- 路径规范 ----
//   <workspace>/sessions/<lo>/<hi>/messages.jsonl              (Canonical 排序，共享消息)
//   <workspace>/sessions/<lo>/<hi>/archive/history_<N>.jsonl   (归档)
//   <workspace>/usage/token_<YYYY-MM-DD>.jsonl                 (Token 用量，JSONL 按日分片)
// ============================================================

import { AgentContext, Extension, Message, PreProcessHook, PostProcessHook } from '@core/types';
import { getAppState } from '@core/app-state';
import * as fs from 'fs';
import { cfg, meta } from './meta';
import { loadHistory, appendJSONL, estimateMessagesTokens, loadGroupHistory, genMessageId, flushDeferredMessagesForAgent } from './history';
import { generateSummary } from './summary';
import { getPendingMessages, clearPendingMessages, requestArchive, completeArchiveReview } from './archive';
import { resetIdleTimer, idleArchive } from './idle-timer';
import { logUsage } from './utils';
import { PersistedMessage } from './types';
import { logger } from '../../../../utils/logger';
import { resolveCompressMarkerPath } from './paths';

/** 生成 LLM 标识（provider/model），供 usage 记录按模型统计 */
function llmLabel(ctx: AgentContext): string | undefined {
  const c = ctx.llmConfig;
  if (!c) return undefined;
  return c.model ? `${c.provider ?? 'openai'}/${c.model}` : c.provider;
}

// ============================================================
// preHook —— Agent.run() 调用前执行
// ============================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const agent = ctx.receiver;
  const counterpart = ctx.sender;
  const maxTokens = cfg(ctx.runtimeConfig).maxContextTokens;

  // ---- 1. 加载历史 ----
  let systemPrompt = ctx.systemPrompt;

  // 群组模式：加载房间共享历史
  let history: Message[];
  if (ctx.group_id) {
    // 构建 agent_id → name 映射，让历史消息中显示可读名称
    const agentNames = new Map<string, string>();
    try {
      const state = getAppState();
      const registry = state.registry as any;
      if (registry?.listIds) {
        for (const id of registry.listIds() as string[]) {
          // 优先从真实 Agent 实例获取 name，回退到虚拟 Agent 的 getAgentName
          const a = registry.getAgent(id);
          if (a?.name) {
            agentNames.set(id, a.name);
          } else if (typeof registry.getAgentName === 'function') {
            const name = registry.getAgentName(id);
            if (name && name !== id) agentNames.set(id, name);
          }
        }
      }
    } catch { /* registry 可能尚未就绪 */ }
    history = loadGroupHistory(ctx.group_id, agent, (id) => agentNames.get(id) ?? id);
    logger.info(`[agent-session] 群组模式 ${ctx.group_id}：${agent} 加载了 ${history.length} 条房间历史`);
  } else {
    history = loadHistory(agent, counterpart);
  }

  // ---- 3. 上下文压缩并生成摘要（防止超过 LLM 上下文长度导致会话失败） ----
  if (estimateMessagesTokens(history) > maxTokens) {
    // 从最新消息向前累积，保留约 10% maxTokens 的 recent 消息
    const recentTargetTokens = Math.ceil(maxTokens * 0.10);
    let recentTokens = 0;
    let splitIdx = history.length; // 从尾部开始

    for (let i = history.length - 1; i >= 0; i--) {
      const msgTokens = estimateMessagesTokens([history[i]]);
      // 允许稍微超出 target，但不能超过 2x
      if (recentTokens + msgTokens > recentTargetTokens * 2 && recentTokens > 0) {
        break;
      }
      recentTokens += msgTokens;
      splitIdx = i;
    }

    // 找到安全的分割点：不能拆分 tool-call/response 对
    while (splitIdx > 0 && splitIdx < history.length) {
      const atSplit = history[splitIdx];
      if (atSplit.role === 'tool') {
        let foundAssistant = false;
        for (let j = splitIdx - 1; j >= 0; j--) {
          if (history[j].role === 'assistant' && history[j].tool_calls?.length) {
            splitIdx = j;
            foundAssistant = true;
            break;
          }
          if ((history[j].role === 'assistant' && !history[j].tool_calls?.length) || history[j].role === 'user') {
            break;
          }
        }
        if (!foundAssistant) break;
      } else {
        break;
      }
    }
    splitIdx = Math.max(1, splitIdx);

    const recent = history.slice(splitIdx);
    const older = history.slice(0, splitIdx);

    // 使用 LLM 生成自然摘要（ctx.llm 由 Agent.run() 自动注入）
    const summaryContent = await generateSummary(ctx.llm, older, counterpart, agent, cfg(ctx.runtimeConfig).summaryPreviewLen);

    // 将摘要合并到系统提示词，而非作为独立 system 消息注入 history。
    // LLM 规范要求只有一条 system 消息，agent.ts 已将 systemPrompt
    // 作为首条消息，此处合并以保证合规。
    systemPrompt = `${systemPrompt}\n\n[上下文摘要 — 早期对话已压缩]\n${summaryContent}`;
    history = recent;
    logger.info(
      `[agent-session] 上下文已压缩 ${agent}/${counterpart}：` +
      `${older.length} 条 → 摘要 (${estimateMessagesTokens([{ role: 'system', content: summaryContent }])} tokens)，` +
      `保留 ${recent.length} 条 (${recentTokens} tokens)`
    );
  }

  return {
    ...ctx,
    systemPrompt,
    history,
  };
};

// ============================================================
// postHook —— Agent.run() 调用后执行
// ============================================================

const postHook: PostProcessHook = async (
  ctx: AgentContext,
  _response: string,
): Promise<void> => {
  // DEBUG: 如需排查房间 Agent 行为，可注释以下 return 以启用 sessions/ 持久化
  // 群组消息由 GroupManager 负责持久化，session 扩展不重复处理
  if (ctx.group_id) {
    logUsage(ctx.cumulativeUsage, ctx.receiver, `group:${ctx.group_id}`, llmLabel(ctx));
    return;
  }

  // ── 归档整理轮：不落盘，只写完成标记 + 检查归档 ──
  // preHook 已加载完整历史（尚未归档），ReAct 整理 memory/TODO/note；
  // 此处跳过一切持久化/用量/定时器副作用，仅标记本侧完成。
  if (ctx.archiveReview) {
    const agent = ctx.receiver;
    const counterpart = ctx.sender;
    // 判断本侧整理是否失败（LLM 错误）：loopMessages 含 role=error
    const failed = (ctx.loopMessages ?? []).some(m => m.role === 'error');
    await completeArchiveReview(agent, counterpart, ctx, failed);
    return;
  }

  // VirtualAgent 消息由发送方 Agent 的 postHook 延迟持久化，此处跳过
  if (ctx.skipPersist) {
    return;
  }

  // VirtualAgent：仅持久化收到的消息（currentMessage，agent_id = ctx.sender = 发送方），
  // 不持久化自己的确认回复，跳过归档/压缩/用量/定时器等副作用。
  // 修复：曾用 skipPersist:true 完全跳过 → send_agent(user) 的消息丢失。
  if (ctx.persistIncomingOnly) {
    if (ctx.currentMessage) {
      const incomingMsg: PersistedMessage = {
        role: (ctx.currentMessage.content?.startsWith('<trigger>') || ctx.currentMessage.content?.includes('<trigger>')) ? 'trigger' : 'agent',
        content: ctx.currentMessage.content,
        agent_id: ctx.sender,
        message_id: genMessageId(),
        timestamp: new Date().toISOString(),
      };
      appendJSONL(ctx.receiver, ctx.sender, incomingMsg);
      getPendingMessages(ctx).push(incomingMsg);
    }
    // 仍刷新延迟缓冲区（兼容旧的 deferMessage 遗留消息）
    flushDeferredMessagesForAgent(ctx.receiver);
    return;
  }

  const agent = ctx.receiver;
  const counterpart = ctx.sender;

  // ---- 1. 持久化本轮完整对话（含工具调用、工具结果、思维链） ----

  // 先持久化用户消息：ctx.loopMessages 只含 assistant + tool 消息，
  // 不含用户消息，因此需单独从 ctx.currentMessage 中提取并写入。
  // agent_id = ctx.sender：标识消息来源方（counterpart 发送给当前 agent）
  if (ctx.currentMessage) {
    const userMsg: PersistedMessage = {
      role: (ctx.currentMessage.content?.startsWith('<trigger>') || ctx.currentMessage.content?.includes('<trigger>')) ? 'trigger' : 'agent',
      content: ctx.currentMessage.content,
      agent_id: ctx.sender,
      message_id: genMessageId(),
      timestamp: new Date().toISOString(),
    };
    getPendingMessages(ctx).push(userMsg);
    appendJSONL(agent, counterpart, userMsg);
  }

  // 持久化 ReAct 循环产生的 assistant + tool 消息
  const messagesToPersist = ctx.loopMessages ?? [];

  if (messagesToPersist.length === 0) {
    // 兼容路径：loopMessages 为空（如简单问答无工具调用），
    // 至少持久化 assistant 的最终回复文本。
    // agent_id = ctx.receiver：标识消息由当前 agent 生成
    const assistantMsg: PersistedMessage = {
      role: 'agent',
      content: _response,
      agent_id: ctx.receiver,
      label: ctx.currentMessage?.label,
      message_id: genMessageId(),
      timestamp: new Date().toISOString(),
    };
    getPendingMessages(ctx).push(assistantMsg);
    appendJSONL(agent, counterpart, assistantMsg);
  } else {
    for (const msg of messagesToPersist) {
      // user 角色消息（如转向消息）保留原始 agent_id，
      // assistant / tool 角色均由当前 agent 产生 → agent_id = ctx.receiver
      const msgAgentId = msg.role === 'user'
        ? (msg.agent_id || ctx.sender)
        : ctx.receiver;
      const p: PersistedMessage = {
        role: msg.role === 'assistant' || msg.role === 'user' ? 'agent' : msg.role,
        content: msg.content,
        agent_id: msgAgentId,
        message_id: genMessageId(),
        name: msg.name,
        tool_calls: msg.tool_calls?.length
          ? msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            }))
          : undefined,
        // tool 消息必须有 tool_call_id。SSE 解析器已保证非空，
        // 若此处仍为空则说明存在未预期的上游 bug，记录告警。
        tool_call_id: msg.tool_call_id
          || (msg.role === 'tool' ? (logger.warn(`[agent-session] 严重：tool 消息缺少 tool_call_id！`), `call_missing`) : undefined),
        reasoning_content: msg.reasoning_content,
        label: msg.label,
        timestamp: new Date().toISOString(),
      };
      getPendingMessages(ctx).push(p);
      appendJSONL(agent, counterpart, p);
    }
  }

  // ---- 1.5 刷新延迟持久化消息（VirtualAgent 产生的消息） ----
  // VirtualAgent 在 send_agent 调用期间将消息加入延迟缓冲区。
  // 此时发送方 Agent 的自身消息已全部持久化完毕，可以安全刷入。
  // 按 Agent 维度（而非 pair 维度）刷新，覆盖级联场景：
  // 如 A→B→user 时，B 的 postHook 会同时刷入 (A,B) 和 (B,user)。
  flushDeferredMessagesForAgent(agent);

  // ---- 2. 压缩归档标记检测（session.compress 触发） ----
  // 用户点击"压缩对话"→ handler 写入 .memory_archive_needed 标记
  // → postHook 在此检测并执行 idleArchive，保证在消息持久化完成后才归档。
  const compressMarkerPath = resolveCompressMarkerPath(agent, counterpart);
  if (fs.existsSync(compressMarkerPath)) {
    logger.info(`[agent-session] 压缩标记触发归档: ${agent}/${counterpart}`);
    idleArchive(agent, counterpart);
    try { fs.unlinkSync(compressMarkerPath); } catch { /* ignore */ }
  }

  // ---- 3. 归档（token 超阈值时触发） ----
  // 将当前 messages.jsonl 移动到 archive/，然后用压缩后的历史 + 本轮消息重建。
  // 与 preHook 的压缩互不依赖：preHook 防止 LLM 调用失败，postHook 防止文件膨胀。
  //
  // 双重判断：优先 DeepSeek API 返回的实际 token 数，启发式估算作为兜底。
  const sessionCfg = cfg(ctx.runtimeConfig);
  const actualTotal = ctx.cumulativeUsage?.total_tokens ?? 0;
  const estimatedTotal = estimateMessagesTokens(ctx.history)
    + estimateMessagesTokens(ctx.loopMessages ?? []);
  const threshold = Math.ceil(sessionCfg.maxContextTokens * sessionCfg.archiveTokenRatio);

  if (actualTotal > threshold || estimatedTotal > threshold) {
    // v0.4.x 归档重构：先触发双方整理轮（完整上下文），全部完成后才归档
    requestArchive(agent, counterpart);
  }

  // ---- 3. 记录本轮 LLM Token 用量 ----
  logUsage(ctx.cumulativeUsage, agent, counterpart, llmLabel(ctx));

  // 清理本轮缓存
  clearPendingMessages(ctx);

  // ---- 4. 重置空闲归档定时器 ----
  // 每次会话完成后重置定时器，若长时间无新对话则自动触发归档
  resetIdleTimer(agent, counterpart);
};

// ============================================================
// Extension 统一入口
// ============================================================

export const extension: Extension = {
  ...meta,
  preHook,
  postHook,
};
