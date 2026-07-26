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
import { cfg, meta } from './meta';
import { loadHistory, appendJSONL, estimateMessagesTokens, loadRoomHistory, genMessageId } from './history';
import { generateSummary } from './summary';
import { archiveAndRebuild, getPendingMessages, clearPendingMessages } from './archive';
import { resetIdleTimer } from './idle-timer';
import { logUsage } from './utils';
import { PersistedMessage } from './types';

// ============================================================
// preHook —— Agent.run() 调用前执行
// ============================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const agent = ctx.receiver;
  const counterpart = ctx.sender;
  const maxTokens = cfg(ctx.runtimeConfig).maxContextTokens;

  // ---- 1. 加载历史 ----
  let systemPrompt = ctx.systemPrompt;

  // 群聊模式：加载房间共享历史
  let history: Message[];
  if (ctx.room_id) {
    // 构建 agent_id → name 映射，让历史消息中显示可读名称
    const agentNames = new Map<string, string>();
    try {
      const state = getAppState();
      const registry = state.registry as any;
      if (registry?.listIds) {
        for (const id of registry.listIds() as string[]) {
          const a = registry.getAgent(id);
          if (a?.name) agentNames.set(id, a.name);
        }
      }
    } catch { /* registry 可能尚未就绪 */ }
    history = loadRoomHistory(ctx.room_id, agent, (id) => agentNames.get(id) ?? id);
    console.log(`[agent-session] 房间模式 ${ctx.room_id}：${agent} 加载了 ${history.length} 条群聊历史`);
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
    console.log(
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
  // 房间消息由 RoomManager 负责持久化，session 扩展不重复处理
  if (ctx.room_id) {
    // 仅记录 token 用量
    logUsage(ctx.cumulativeUsage, ctx.receiver, `room:${ctx.room_id}`);
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
      role: ctx.currentMessage.role || 'user',
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
      role: 'assistant',
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
        role: msg.role,
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
          || (msg.role === 'tool' ? (console.warn(`[agent-session] 严重：tool 消息缺少 tool_call_id！`), `call_missing`) : undefined),
        reasoning_content: msg.reasoning_content,
        label: msg.label,
        timestamp: new Date().toISOString(),
      };
      getPendingMessages(ctx).push(p);
      appendJSONL(agent, counterpart, p);
    }
  }

  // ---- 2. 归档（token 超阈值时触发） ----
  // 将当前 messages.jsonl 移动到 archive/，然后用压缩后的历史 + 本轮消息重建。
  // 与 preHook 的压缩互不依赖：preHook 防止 LLM 调用失败，postHook 防止文件膨胀。
  //
  // 双重判断：优先使用 DeepSeek API 返回的实际 token 数（ctx.cumulativeUsage），
  // 启发式估算作为兜底（API 未返回用量数据时）。启发式估算对 JSON/代码密集型消息
  // 偏差可达 3~20 倍，因此实际 API 值才是可靠的归档触发依据。
  const maxTokens = cfg(ctx.runtimeConfig).maxContextTokens;
  const actualTotal = ctx.cumulativeUsage?.total_tokens ?? 0;
  const estimatedTotal = estimateMessagesTokens(ctx.history)
    + estimateMessagesTokens(ctx.loopMessages ?? []);
  if (actualTotal > maxTokens || estimatedTotal > maxTokens) {
    await archiveAndRebuild(agent, counterpart, ctx);
  }

  // ---- 3. 记录本轮 LLM Token 用量 ----
  logUsage(ctx.cumulativeUsage, agent, counterpart);

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
