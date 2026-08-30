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
// 归档/压缩/截断（上下文管理）为后续增量，本次只做「记录 + 读取」。
//
// 依赖方向：仅依赖 src/core + Node fs/path + 本层 paths。
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import type { CurrentContext, RunResult } from '@agentchat/agent-loop';
import type { AgentMessage, LLMRequestMessage, MessageRole, MessageSource } from '@agentchat/types';
import { createLogger } from '@agentchat/util';
import { workspaceRoot, estimateTokens, groupSessionFile } from '@agentchat/toolkit';
import {
  isGroupDialog, groupIdOfDialog, groupHistoryFile, sessionFileOf, counterpartOfDialog,
  groupArchiveRoot,
} from '@agentchat/tools';
import { wrapGroupMsg } from '@agentchat/contracts';
import { META_ARCHIVE_REVIEW } from '@agentchat/tools';

const log = createLogger('[builtin:session]');

/** 从 dialogId 解析当前 Agent（兼容旧 __ 格式末段；新逻辑优先显式 ctx.agentId） */
export function agentOfDialog(dialogId: string): string {
  const idx = dialogId.lastIndexOf('__');
  return idx >= 0 ? dialogId.slice(idx + 2) : dialogId.slice(dialogId.lastIndexOf('~') + 1);
}

/** 语义化中断原因 → 控制台可读文本 */
function formatInterruptReason(r?: import('@agentchat/agent-loop').InterruptReason): string {
  if (!r) return 'unknown';
  switch (r.type) {
    case 'user-abort': return `用户打断${r.detail ? `：${r.detail}` : ''}`;
    case 'tool-interrupt': return `工具中止（${r.tool}）${r.detail ? `：${r.detail}` : ''}`;
    case 'reload-requested': return '请求热重载';
    case 'restart-requested': return `请求重启${r.reason ? `：${r.reason}` : ''}`;
    case 'max-steps': return '达到最大推理步数';
  }
}

/** 事件源判定：系统注入语义（原 trigger）→ 持久化为中性 event 角色 */
export function isEventSource(source?: MessageSource): boolean {
  if (!source) return false;
  if (source.form === 'hint' || source.form === 'notice' || source.form === 'resume') return true;
  switch (source.kind) {
    case 'system':
    case 'timer':
    case 'group':
    case 'subagent':
    case 'continue':
    case 'restart':
    case 'archive':
      return true;
    default:
      return false;
  }
}

/** 内存角色 → 持久化角色（user/assistant → agent；user + 事件来源 → event） */
export function toPersistedRole(role: MessageRole, source?: MessageSource): 'agent' | 'system' | 'tool' | 'event' | 'error' {
  if (role === 'user' && isEventSource(source)) return 'event';
  if (role === 'user' || role === 'assistant') return 'agent';
  return role;
}

/** 旧 `<trigger>…</trigger>` 正文解包（新数据不再用正文包装，历史数据读取时归一化） */
export function unwrapTriggerContent(content: string | null | undefined): string {
  const text = content ?? '';
  const match = /^<trigger>([\s\S]*)<\/trigger>$/.exec(text.trim());
  return match ? match[1].trim() : text;
}

/** 旧 role='trigger' 数据的来源元数据（归一化时保留诊断标记） */
export function legacyTriggerSource(content: string | null | undefined): MessageSource {
  return {
    kind: 'system',
    form: 'hint',
    summary: (unwrapTriggerContent(content) || '').slice(0, 60) || undefined,
    legacyRole: 'trigger',
  };
}

/**
 * 把持久化/历史行归一化为内存消息（LLM 可消费格式）：
 *   · 新 role='event' → role='user' + 原 source（事件触发入站语义）
 *   · 旧 role='trigger' → role='user' + legacyTriggerSource
 *   · 历史损坏（trigger/event + tool_call_id）→ 运行时兜底为 tool
 */
export function normalizeLoadedMessage(raw: Record<string, any>): LLMRequestMessage {
  const base: Record<string, any> = { ...raw };
  if (raw.role === 'event' || raw.role === 'trigger') {
    if (raw.tool_call_id) {
      return { ...base, role: 'tool', content: raw.content ?? '' } as LLMRequestMessage;
    }
    const source: MessageSource = (raw.source as MessageSource | undefined)
      ?? legacyTriggerSource(raw.content);
    return {
      ...base,
      role: 'user',
      content: raw.role === 'trigger' ? unwrapTriggerContent(raw.content) : (raw.content ?? ''),
      source,
    } as LLMRequestMessage;
  }
  if (raw.role !== 'system' && raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'tool' && raw.role !== 'error' && raw.role !== 'agent') {
    return { ...base, role: 'user', content: raw.content ?? '' } as LLMRequestMessage;
  }
  return base as LLMRequestMessage;
}

/** 加载会话历史（L2 AgentAssembly.loadHistory 实现；返回内存格式，provider 做视角转换）
 *  1v1 读会话文件；群聊由 loadGroupHistory 注入（runStart 钩子 makeLoadHistoryHook 调用），此处返回空。 */
export function loadHistory(dialogId: string): LLMRequestMessage[] {
  if (isGroupDialog(dialogId)) return [];
  const file = sessionFileOf(dialogId);
  if (!fs.existsSync(file)) return [];
  const out: LLMRequestMessage[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = normalizeLoadedMessage(JSON.parse(line) as Record<string, any>);
      // 兼容旧数据：无 message_id 的补稳定 ID（供去重/归档二次去重/前端 persistedMsgId）
      if (!m.message_id) m.message_id = stableMessageIdOf(dialogId, m);
      out.push(m);
    } catch {
      // 忽略损坏行
    }
  }
  return out;
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
    /** 剔除的 message_id 集合：合并前的原始行级过滤（trigger 消息已由 hint/通知携带，历史不再注入） */
    excludeIds?: Set<string>;
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
          const p = normalizeLoadedMessage(JSON.parse(line) as Record<string, any>);
          const displayName = opts?.getName ? opts.getName(p.agent_id ?? '') : null;
          const senderName = displayName && displayName !== p.agent_id ? displayName : (p.agent_id ?? '');
          let content = p.content ?? '';
          // 非当前视角的 agent 消息封装 <msg> 标签（群消息视图单一事实源，与 router hint/GroupFeed 共用）
          if (p.role === 'agent' && p.agent_id !== viewer) {
            content = wrapGroupMsg({ from: p.agent_id ?? '', displayName: senderName, groupName, content });
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
            message_id: p.message_id,
            timestamp: p.timestamp,
            source: p.source,
          } as LLMRequestMessage;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as LLMRequestMessage[];

    // 按 message_id 剔除（pre-merge 行级过滤）：id 精确、不受合并块边界影响，
    // 替代事后对合并块做字符串手术（8/17 复现根因，设计文档 §1.2）
    const excludeIds = opts?.excludeIds;
    const kept = excludeIds && excludeIds.size > 0
      ? parsed.filter(m => !excludeIds.has((m as { message_id?: string }).message_id ?? ''))
      : parsed;
    const parsedFinal = kept;

    // 合并相邻"对方视角"的纯发言消息（群聊多参与者连续发言 → 连续多条 user，
    // 合成一条；<msg> 标签已区分发言人）。仅合并 role='agent'、非 viewer、无 tool_calls 的
    // 相邻消息；自身消息、tool/event/error/system 及带工具调用的不参与。
    const merged: LLMRequestMessage[] = [];
    for (const m of parsedFinal) {
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
        return withArchiveSummary(groupId, truncated);
      }
    }
    return withArchiveSummary(groupId, merged);
  } catch {
    return [];
  }
}

/**
 * 读取最新归档摘要（GroupService 轮转产物 summary_N.md；无归档返回 null）
 * 并注入为历史头部消息（Phase 2.5：恢复 v0.4.x"摘要锚点注入提示词"语义——
 * 本体轮转后早期消息移入 archive/history_N.jsonl，此摘要是其长期记忆入口）。
 * 截断后注入（始终在场，~60 条 × 150 字有界），超压时正文先丢、摘要保留。
 */
function withArchiveSummary(groupId: string, history: LLMRequestMessage[]): LLMRequestMessage[] {
  try {
    const dir = groupArchiveRoot(groupId);
    if (!fs.existsSync(dir)) return history;
    const files = fs.readdirSync(dir)
      .filter((f) => /^summary_\d+\.md$/.test(f))
      .sort((a, b) => Number((b.match(/\d+/) ?? ['0'])[0]) - Number((a.match(/\d+/) ?? ['0'])[0]));
    if (files.length === 0) return history;
    const summary = fs.readFileSync(path.join(dir, files[0]), 'utf-8').trim();
    if (!summary) return history;
    return [
      { role: 'user', content: `（本群更早的消息已归档，以下为归档摘要，供了解背景）\n${summary}`, source: { kind: 'archive', form: 'notice' } } as LLMRequestMessage,
      ...history,
    ];
  } catch {
    return history;
  }
}

/**
 * 群聊本体尾部锚点：最新一行的 message_id + 行号（0 起，空文件/不存在 = {line:0}）。
 * runStart 加载群历史后写入 ctx.meta[GROUP_SYNC_META_KEY]，供 busy 注入
 * （GroupFeed.readSince）计算增量；纯 run 作用域，不持久化——消费位置由
 * 每个 idle run 的全量重读自动确立（docs/group-single-channel-design.md §2.2）。
 */
export function groupTailAnchor(groupId: string): { message_id?: string; line: number } {
  const filePath = groupSessionFile(groupId);
  try {
    if (!fs.existsSync(filePath)) return { line: 0 };
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return { line: 0 };
    const parsedLine = JSON.parse(lastLine) as { message_id?: string };
    return {
      ...(parsedLine.message_id ? { message_id: parsedLine.message_id } : {}),
      line: lines.length - 1,
    };
  } catch {
    return { line: 0 };
  }
}

/**
 * 把内存消息转为持久化格式。
 *
 * 幂等标识：message_id/timestamp 缺省时在首次序列化就固化到消息对象上
 * （AgentMessage 两字段均为可选），之后再序列化同一对象产出完全相同的行。
 * 背景（2026-08-17 重复消息 bug）：同一消息对象经两个 loopMessages 数组
 * （重复投递派生的第二个 run）各自入队时，旧实现每次序列化都生成新
 * message_id（msg-时间戳-随机串），落成"内容/tool_call_id/时间戳全同、
 * id 不同"的重复行，下游按 message_id 的去重（history 合并/归档/WebUI）
 * 全部失效。固化后重复落盘至少产出同 id 行，可被任何一层去重。
 */
export function toPersisted(m: AgentMessage, selfId: string): Record<string, unknown> {
  const persistedRole = toPersistedRole(m.role, m.source);
  const isSpeech = (m.role === 'user' || m.role === 'assistant') && persistedRole !== 'event';
  if (!m.message_id) m.message_id = genMessageId();
  if (!m.timestamp) m.timestamp = new Date().toISOString();
  return {
    role: persistedRole,
    content: m.content ?? '',
    // 消息唯一 ID（WebUI 历史去重/persistedMsgId 标记/消息删除都依赖）。
    // 已存在则保留（归档重建时透传原 ID）；缺省在上方固化生成（幂等）。
    message_id: m.message_id,
    ...(isSpeech ? { agent_id: m.agent_id ?? selfId } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.label ? { label: m.label } : {}),
    ...(m.source ? { source: m.source } : {}),
    timestamp: m.timestamp,
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
 * 接收整次 RunResult.messages（完整、唯一），避免多步 stepEnd 重复追加。
 */
export async function saveSession(
  ctx: CurrentContext,
  result: RunResult,
): Promise<void> {
  // 归档整理 run 不落盘（仅整理记忆/写 SUMMARY.md，不污染会话文件）
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
 * 旧实现放在每步 postHook；usage 是整次 run 累计的，放 runEnd 更准确。
 */
export async function logRunUsage(
  ctx: CurrentContext,
  result: import('@agentchat/agent-loop').RunResult,
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

  const steps = usage.react_steps ?? 0;
  const accPrompt = usage.accumulated_prompt_tokens ?? usage.prompt_tokens;
  const accTotal = usage.accumulated_total_tokens ?? usage.total_tokens;
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
  const cacheTotal = cacheHit + cacheMiss;
  const hitRate = cacheTotal > 0 ? ((cacheHit / cacheTotal) * 100).toFixed(1) : '-';

  const parts: string[] = [];
  if (steps > 0) parts.push(`ReAct ${steps} 步`);
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
      // usage API 按 llm 字段聚合；model 保留作为可读字段/旧版兼容
      llm: model,
      react_steps: steps,
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
