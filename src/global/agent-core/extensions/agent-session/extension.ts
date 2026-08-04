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

import { AgentContext, Extension, Message, LLMRequestMessage, PreProcessHook, PostProcessHook } from '@core/types';
import { getAppState } from '@core/app-state';
import * as fs from 'fs';
import * as path from 'path';
import { cfg, meta } from './meta';
import { loadHistory, appendJSONL, estimateMessagesTokens, loadGroupHistory, genMessageId, flushDeferredMessagesForAgent, truncateMessagesByTokenBudget, safeSplitIdx } from './history';
import { generateSummary } from './summary';
import { getPendingMessages, clearPendingMessages, requestArchive, completeArchiveReview } from './archive';
import { resetIdleTimer, idleArchive } from './idle-timer';
import { logUsage } from './utils';
import { PersistedMessage } from './types';
import { logger } from '../../../../utils/logger';
import { resolveCompressMarkerPath, resolveSelfDialogueArchiveDir, resolveGroupParticipationDir, resolveArchiveDir } from './paths';

/**
 * 计算 ISO 周号（YYYY-Www）。用于 A→Group 群聊参与归档按周分片。
 * ISO 8601：周一为一周开始，每年第一周含至少 4 天。
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // 周一=0 ... 周日=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // 移到本周四
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 追加一条消息到社交活动归档文件（自对话按天 / 群聊按周）。
 * 仅供复盘分析，不参与消息查询/上下文加载。
 */
function appendSocialArchive(filePath: string, msg: PersistedMessage): void {
  try {
    const dir = require('path').dirname(filePath);
    const fs = require('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(msg) + '\n', 'utf-8');
  } catch (err: any) {
    logger.warn(`[agent-session] 社交归档写入失败: ${filePath}: ${err?.message}`);
  }
}

/** 生成 LLM 标识（provider/model），供 usage 记录按模型统计 */
function llmLabel(ctx: AgentContext): string | undefined {
  const c = ctx.llmConfig;
  if (!c) return undefined;
  return c.model ? `${c.provider ?? 'openai'}/${c.model}` : c.provider;
}

// ============================================================
// preHook —— Agent.run() 调用前执行
// ============================================================

/**
 * 截断群聊历史到 token 预算（保留尾部近期），不拆分 tool-call/response 对。
 * 群聊加载超限时用（groupLoadLimitTokens 安全阀）。
 */
function truncateGroupHistory(history: LLMRequestMessage[], tokenBudget: number): LLMRequestMessage[] {
  const truncated = truncateMessagesByTokenBudget(history, tokenBudget);
  // 安全分割点：不拆分 tool-call/response 对（结构判定，与 1:1 一致）
  const splitIdx = safeSplitIdx(history, history.length - truncated.length);
  return history.slice(Math.max(0, splitIdx));
}

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const agent = ctx.receiver;
  const counterpart = ctx.sender;
  const maxTokens = cfg(ctx.runtimeConfig).maxContextTokens;

  // ---- 1. 加载历史 ----
  let systemPrompt = ctx.systemPrompt;

  // 群组模式：加载房间共享历史
  let history: LLMRequestMessage[];
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

    // v0.4.x 群聊双阈值：单 Agent 加载超限 → 立即触发归档 + 截断本次加载
    // 群聊是共享历史多参与者，每个 Agent 都全量加载，必须控制单次加载量
    const sessionCfg = cfg(ctx.runtimeConfig);
    const groupLoadLimit = sessionCfg.groupLoadLimitTokens;
    const loadedTokens = estimateMessagesTokens(history);
    if (loadedTokens > groupLoadLimit) {
      logger.info(`[agent-session] 群聊加载超限 ${loadedTokens} > ${groupLoadLimit}，触发归档并截断 (${ctx.group_id})`);
      // 触发归档（幂等：pending 已存在则跳过）
      try {
        const { maybeRequestGroupArchive } = await import('./group-archive.js');
        maybeRequestGroupArchive(ctx.group_id);
      } catch { /* 归档模块未就绪时跳过 */ }
      // 截断本次加载到加载上限（保留尾部近期）
      history = truncateGroupHistory(history, groupLoadLimit);
      logger.info(`[agent-session] 群聊加载已截断到 ${history.length} 条 (${ctx.group_id})`);
    }
  } else {
    history = loadHistory(agent, counterpart);
  }

  // ---- 1.5 注入历史归档摘要（SUMMARY.md，如有）----
  // 归档时生成的 SUMMARY.md 持久化早期对话要点，跨会话注入避免"会话割裂"
  // （归档后 Agent 丢失关键决策/待办上下文）。仅 1:1 会话注入；群聊有独立 summary_<n>.md。
  if (!ctx.group_id) {
    try {
      const summaryPath = path.join(resolveArchiveDir(agent, counterpart), 'SUMMARY.md');
      if (fs.existsSync(summaryPath)) {
        const summary = fs.readFileSync(summaryPath, 'utf-8').trim();
        if (summary) {
          // 限制注入长度，防止多轮归档摘要无限累积撑爆提示词（取尾部最近内容）
          const maxLen = cfg(ctx.runtimeConfig).archiveSummaryInjectLen;
          const injected = summary.length > maxLen ? summary.slice(-maxLen) : summary;
          systemPrompt = `${systemPrompt}\n\n[历史归档摘要 — 早期对话已归档压缩，含关键决策与待办事项]\n${injected}`;
        }
      }
    } catch { /* 摘要读取失败不影响主流程 */ }
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

    // 找到安全的分割点：不能拆分 tool-call/response 对（结构判定，无需视角）
    splitIdx = safeSplitIdx(history, splitIdx);
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

  // ── A→A 自对话指引（2026-08-03 更新）──
  // 自对话（agent === counterpart）不写活跃消息历史（B1），
  // 但已按天归档到 sessions/<A>/<A>/archive/self_YYYY-MM-DD.jsonl 供复盘。
  // 因此提示词告知 Agent：本轮对话仅归档不参与后续上下文，值得记忆的内容请自行更新文档。
  if (agent === counterpart) {
    systemPrompt = `${systemPrompt}\n\n[系统提示] 本轮为系统自主触发的自对话（Agent 与自己），对话记录已归档（不参与后续上下文）。\n如有需要记忆的重要信息，请自行更新 memory.md / TODO.md / note/ 等相关文档。`;
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
  // ── 归档整理轮：不落盘，只写完成标记 + 检查归档 ──
  // preHook 已加载完整历史（尚未归档），ReAct 整理 memory/TODO/note；
  // 此处跳过一切持久化/用量/定时器副作用，仅标记本侧完成。
  // 注意：必须在 group_id 判断之前，群聊整理轮带 group_id
  if (ctx.archiveReview) {
    // 群聊整理轮：标记该参与者完成（不写 1:1 会话）
    if (ctx.group_id) {
      const failed = (ctx.loopMessages ?? []).some(m => m.role === 'error');
      const { completeGroupArchiveReview } = await import('./group-archive.js');
      await completeGroupArchiveReview(ctx.group_id, ctx.receiver, failed);
      return;
    }
    const agent = ctx.receiver;
    const counterpart = ctx.sender;
    // 判断本侧整理是否失败（LLM 错误）：loopMessages 含 role=error
    const failed = (ctx.loopMessages ?? []).some(m => m.role === 'error');
    await completeArchiveReview(agent, counterpart, ctx, failed);
    return;
  }

  // DEBUG: 如需排查房间 Agent 行为，可注释以下 return 以启用 sessions/ 持久化
  // 群组消息由 GroupManager 负责持久化，session 扩展不重复处理
  if (ctx.group_id) {
    logUsage(ctx.cumulativeUsage, ctx.receiver, `group:${ctx.group_id}`, llmLabel(ctx));
    // #3 A→Group 群聊参与归档（2026-08-03）：
    logger.info(`[agent-session] 群聊归档检测 ${ctx.receiver}@${ctx.group_id}: currentMessage=${!!ctx.currentMessage} loop=${ctx.loopMessages?.length ?? 0}`);
    // 把本轮 A 的完整参与（收到的群聊消息 + A 的思考/工具调用/回复）
    // 写入 sessions/<A>/group__<群ID>/archive/history_<ISO周>.jsonl，
    // 按周分片。仅供分析 Agent 对群消息的处理，不加载回上下文、不影响共享历史。
    try {
      const archiveDir = resolveGroupParticipationDir(ctx.receiver, ctx.group_id);
      const weekKey = isoWeekKey(new Date());
      const filePath = `${archiveDir}/history_${weekKey}.jsonl`;

      // 1. 收到的群聊消息（触发 A 的消息）
      if (ctx.currentMessage) {
        appendSocialArchive(filePath, {
          role: 'trigger',
          content: ctx.currentMessage.content,
          agent_id: ctx.sender,
          message_id: genMessageId(),
          timestamp: new Date().toISOString(),
        });
      }

      // 2. A 的响应链（assistant + tool，含思维链），空回复不落盘
      for (const msg of ctx.loopMessages ?? []) {
        if (msg.role === 'assistant' && !msg.content && !msg.tool_calls?.length && !msg.reasoning_content) {
          continue;
        }
        const p: PersistedMessage = {
          role: msg.role === 'assistant' || msg.role === 'user' ? 'agent' : msg.role,
          content: msg.content,
          agent_id: ctx.receiver,
          message_id: genMessageId(),
          name: msg.name,
          tool_calls: msg.tool_calls?.length
            ? msg.tool_calls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              }))
            : undefined,
          tool_call_id: msg.tool_call_id,
          reasoning_content: msg.reasoning_content,
          label: msg.label,
          timestamp: new Date().toISOString(),
        };
        appendSocialArchive(filePath, p);
      }

      // 兼容：loopMessages 为空（纯回复无工具调用）时，归档最终回复文本
      if (!ctx.loopMessages?.length && _response && String(_response).trim()) {
        appendSocialArchive(filePath, {
          role: 'agent',
          content: _response,
          agent_id: ctx.receiver,
          message_id: genMessageId(),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      logger.warn(`[agent-session] 群聊参与归档失败 ${ctx.receiver}@${ctx.group_id}: ${err?.message}`);
    }
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
        // 2026-08-02：trigger 为一等内存角色，直接依据 role 判定（不再嗅探正文）
        role: ctx.currentMessage.role === 'trigger' ? 'trigger' : 'agent',
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

  // ── A→A 自对话：永不落盘消息历史（2026-08-02）──
  // 自对话仅承载系统自主触发（报时/定时/记忆审查/归档整理/自我续推），
  // 历史无保留价值；且 Agent 常对 trigger 静默 → 空回复 + 连续 user trigger 墙，
  // 污染上下文并触发 OpenAI 过滤警告。这里仍记录用量（可观测性）+ 清空本轮
  // 缓存，跳过一切消息持久化/归档检测/空闲归档定时器。
  // ── A→A 自对话（2026-08-02）──
  // 自对话仅承载系统自主触发（报时/定时/记忆审查/归档整理/自我续推），历史无保留价值，
  // 且 Agent 常对 trigger 静默 → 空回复 + 连续 trigger 墙污染上下文。
  // B1：仅跳过「消息持久化」+「空闲定时器重置」，其余流程（延迟刷新/压缩标记/归档检测/用量）正常走。
  const isSelfDialogue = agent === counterpart;

  // ---- 1. 持久化本轮完整对话（含工具调用、工具结果、思维链） ----

  // #2 A→A 自对话归档（2026-08-03）：
  // 不写活跃 messages.jsonl（B1 不污染推理上下文），但按天归档到
  // sessions/<A>/<A>/archive/self_YYYY-MM-DD.jsonl 供复盘。
  // 仅归档，不参与消息查询/上下文加载；空回复不落盘。
  if (isSelfDialogue) {
    try {
      const archiveDir = resolveSelfDialogueArchiveDir(agent);
      const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filePath = `${archiveDir}/self_${dayKey}.jsonl`;

      // 触发的自对话消息（含 trigger 提示）
      if (ctx.currentMessage) {
        appendSocialArchive(filePath, {
          role: ctx.currentMessage.role === 'trigger' ? 'trigger' : 'agent',
          content: ctx.currentMessage.content,
          agent_id: ctx.sender,
          message_id: genMessageId(),
          timestamp: new Date().toISOString(),
        });
      }

      // A 的响应链（assistant + tool，含思维链），空回复不落盘
      for (const msg of ctx.loopMessages ?? []) {
        if (msg.role === 'assistant' && !msg.content && !msg.tool_calls?.length && !msg.reasoning_content) {
          continue;
        }
        const p: PersistedMessage = {
          role: msg.role === 'assistant' || msg.role === 'user' ? 'agent' : msg.role,
          content: msg.content,
          agent_id: ctx.receiver,
          message_id: genMessageId(),
          name: msg.name,
          tool_calls: msg.tool_calls?.length
            ? msg.tool_calls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              }))
            : undefined,
          tool_call_id: msg.tool_call_id,
          reasoning_content: msg.reasoning_content,
          label: msg.label,
          timestamp: new Date().toISOString(),
        };
        appendSocialArchive(filePath, p);
      }

      // 兼容：loopMessages 为空（纯问答无工具调用）时，归档最终回复文本
      if (!ctx.loopMessages?.length && _response && String(_response).trim()) {
        appendSocialArchive(filePath, {
          role: 'agent',
          content: _response,
          agent_id: ctx.receiver,
          message_id: genMessageId(),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      logger.warn(`[agent-session] 自对话归档失败 ${agent}: ${err?.message}`);
    }
  }

  // A→A 自对话不落盘消息历史（活跃 messages.jsonl），仅归档（见上）。
  if (!isSelfDialogue) {
  // 先持久化用户消息：ctx.loopMessages 只含 assistant + tool 消息，
  // 不含用户消息，因此需单独从 ctx.currentMessage 中提取并写入。
  // agent_id = ctx.sender：标识消息来源方（counterpart 发送给当前 agent）
  if (ctx.currentMessage) {
    const userMsg: PersistedMessage = {
      // 2026-08-02：trigger 为一等内存角色，直接依据 role 判定（不再嗅探正文）
      role: ctx.currentMessage.role === 'trigger' ? 'trigger' : 'agent',
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
    //
    // 空回复（静默：Agent 判断无任务无需回复）不落盘空 assistant，
    // 避免历史积累空消息 → 每次加载触发 OpenAI "已过滤空 assistant" 警告。
    if (_response && String(_response).trim()) {
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
    }
  } else {
    for (const msg of messagesToPersist) {
      // 跳过空 assistant（静默回复/异常收尾产生的无内容、无工具调用、无思考消息）。
      // 判定与 OpenAI buildRequestBody 的空消息过滤一致，这类消息本就不会发给 LLM。
      if (msg.role === 'assistant' && !msg.content && !msg.tool_calls?.length && !msg.reasoning_content) {
        continue;
      }
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
  } // end isSelfDialogue（A→A 不落盘）

  // ---- 1.5 刷新延迟持久化消息（VirtualAgent 产生的消息） ----
  // VirtualAgent 在 send_agent 调用期间将消息加入延迟缓冲区。
  // 此时发送方 Agent 的自身消息已全部持久化完毕，可以安全刷入。
  // 按 Agent 维度（而非 pair 维度）刷新，覆盖级联场景：
  // 如 A→B→user 时，B 的 postHook 会同时刷入 (A,B) 和 (B,user)。
  flushDeferredMessagesForAgent(agent);

  // ---- 2. 压缩归档标记检测（session.compress 触发） ----
  // 用户点击"压缩对话"→ handler 写入 .memory_archive_needed 标记
  // → postHook 在此检测并走归档流程（先整理后归档，与新阈值归档统一）。
  const compressMarkerPath = resolveCompressMarkerPath(agent, counterpart);
  if (fs.existsSync(compressMarkerPath)) {
    logger.info(`[agent-session] 压缩标记触发归档: ${agent}/${counterpart}`);
    requestArchive(agent, counterpart);
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
  // 每次会话完成后重置定时器，若长时间无新对话则自动触发归档。
  // A→A 自对话跳过：自会话无历史，空闲归档无意义，持续自触发不应让无意义定时器常驻。
  if (!isSelfDialogue) resetIdleTimer(agent, counterpart);
};

// ============================================================
// Extension 统一入口
// ============================================================

export const extension: Extension = {
  ...meta,
  preHook,
  postHook,
};
