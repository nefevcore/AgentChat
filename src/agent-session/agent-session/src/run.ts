// ============================================================
// src/plugins/builtin/hooks/run.ts —— 整次执行边界钩子（runStart/runEnd）
//
// 整次 run() 生命周期（可能多步）的初始化装配与收尾：
//
//   runStart（chat.start 后）：
//     · build-system-prompt —— 构建 system prompt（角色/环境/术语/标签/指引/技能/存储/对话信息）
//     · load-history         —— 加载历史对话到 ctx.history
//   （记忆加载为独立钩子 agent-memory.load-memory，见 memory.ts makeLoadMemoryHook）
//   runEnd（chat.end 前）：
//     · idle-reset           —— 重置空闲归档计时器（旧 agent-session idle-timer）
//     · archive-session      —— 上下文超长归档（旧 agent-session archive）
//
// 说明：这些钩子需要 config/services，由 PluginHooks 工厂烘焙
// （(config, services) => PluginHooks）。
//
// 依赖方向：仅依赖 src/core + @agents/config + 本层 + Node 内置。
// ============================================================

import type { RunStartHook, RunEndHook, CurrentContext } from '@agentchat/agent-loop';
import { CHAT_START_META_KEY, GROUP_SYNC_META_KEY, GROUP_CONTRACT_TEXT, isGroupDialog, groupIdOfDialog } from '@agentchat/contracts';
import type { RunStartMeta } from '@agentchat/contracts';
import type { LLMRequestMessage } from '@agentchat/types';
import { createLogger } from '@agentchat/util';
import type { AgentConfig } from '@agentchat/agent-config';
import { getNamespaceConfig, groupContractTextOf } from '@agentchat/agent-config';
import type { ToolContext } from '@agentchat/tools';
import { buildSystemPrompt } from '@agentchat/agent-prompt';
import { loadHistory, loadGroupHistory, groupTailAnchor } from './session';
import { META_ARCHIVE_REVIEW, NS_AGENT_SESSION } from '@agentchat/toolkit';
import type { ConfigField } from '@agentchat/toolkit';

const log = createLogger('[agent-session:run]');

// ============================================================
// 会话上下文命名空间 Schema（agent.session；archive-session / load-history 钩子消费，
// PluginDefinition.configs 声明，UI 弹窗内编辑该命名空间配置）
// ============================================================

export const SESSION_CONFIG_SCHEMA: ConfigField[] = [
  { name: 'maxContextTokens', label: '上下文 Token 上限', description: '会话上下文最大 Token 数', type: 'number', default: 1000000 },
  { name: 'keepRecentRatio', label: '保留近期比例', description: '截断时保留最近消息的比例 (0-1)', type: 'ratio', min: 0, max: 1, step: 0.01, display: 'percent', default: 0.03 },
  { name: 'summaryPreviewLen', label: '摘要预览长度', description: '会话摘要预览字符数', type: 'number', default: 4000 },
  { name: 'idleArchiveSec', label: '空闲归档秒数', description: '空闲多少秒后自动归档', type: 'number', default: 14400 },
  { name: 'messageQueryDefaultLimit', label: '消息查询默认条数', description: '历史消息查询默认返回条数', type: 'number', default: 20 },
  { name: 'archiveTokenRatio', label: '归档触发比例', description: '超出上下文预算比例时触发归档 (0-1)', type: 'ratio', min: 0, max: 1, step: 0.05, display: 'percent', default: 0.5 },
];

/**
 * 群聊行为契约命名空间 Schema（agent.group；group-contract 钩子专属——
 * 独立于 agent.session，钩子弹窗只显示本域字段，不混入会话上下文管理配置）。
 * 描述内嵌正典全文（动态引用 contracts 常量，正典更新描述随之更新）。
 */
export const GROUP_CONFIG_SCHEMA: ConfigField[] = [
  {
    name: 'groupContractText',
    label: '群聊行为契约',
    description: `群聊触发时注入的行为契约文本（怎么回复/直接输出无效/沉默权/不刷屏）。留空使用内置正典：「${GROUP_CONTRACT_TEXT}」。自定义文案建议对照观察沉默率与回复质量（A/B）`,
    type: 'text',
    default: '',
  },
];

// ============================================================
// runStart：构建系统提示词（记忆加载拆至 memory.ts makeLoadMemoryHook）
// ============================================================

/**
 * runStart：构建 system prompt。
 * 旧 agent-prompt 完整装配（角色/环境/术语/标签/指引/技能/存储/对话信息）。
 * 记忆加载为独立钩子 agent-memory.load-memory（见 memory.ts makeLoadMemoryHook）。
 * 通过工厂烘焙拿到 config + services；sender/groupId 从 dialogId 推断。
 */
// ============================================================
// runStart：加载历史对话
// ============================================================

/** 群聊单次加载上限默认值（对齐旧 agent-session groupLoadLimitTokens 默认 30000） */
export const DEFAULT_GROUP_LOAD_LIMIT_TOKENS = 30000;

/**
 * 群聊行为契约（正典见 @agentchat/contracts GROUP_CONTRACT_TEXT——router legacy hint
 * 与本钩子共用同一常量，杜绝文案漂移；I11 快照测试锚定）。
 * 位置契约：放注入单元/历史尾部而非系统提示词——系统提示词在长上下文中
 * 注意力稀释失效（群聊恰是最长上下文场景），契约必须位于"回/不回"决策点。
 * 迁移史：router.ts hint 内联文案 → v3 机制化为 group-contract 钩子
 * （docs/group-single-channel-design.md §2.4）。
 */
export const GROUP_CONTRACT_TEXT_CANONICAL = GROUP_CONTRACT_TEXT;

/**
 * runStart：群聊行为契约注入（automatic 钩子，注册顺序在 load-history 之后）。
 *
 * kind=group 触发的 run：把契约追加到 ctx.history 尾部（= 已加载历史之后、
 * currentMessage 之前——上下文倒数第二区）。不写入群聊本体（进 loopMessages
 * 后由 writer 落周归档，仅分析复盘，不参与后续 run 上下文）。
 * busy steer 不携带契约：契约已在本 run 上下文中，增量注入无需重复。
 */
export function makeGroupContractHook(config: AgentConfig): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    if (!ctx.dialogId || !isGroupDialog(ctx.dialogId)) return;
    if (ctx.meta?.[META_ARCHIVE_REVIEW]) return;
    const startMeta = ctx.meta?.[CHAT_START_META_KEY] as RunStartMeta | undefined;
    if (startMeta?.source?.kind !== 'group') return;
    ctx.history.push({
      role: 'user',
      content: groupContractTextOf(config), // agent.session.groupContractText 可覆盖（空回落正典）
      source: { kind: 'group', form: 'notice' },
    } as LLMRequestMessage);
  };
}

/** 从 hint 文本提取全部 <msg …>…</msg> 段（非群聊 hint / 无段时返回空数组） */
function extractGroupMsgSegments(hint: string | undefined | null): string[] {
  if (!hint || !hint.includes('<msg ')) return [];
  const segments: string[] = [];
  let idx = 0;
  while (idx < hint.length) {
    const start = hint.indexOf('<msg ', idx);
    if (start === -1) break;
    const end = hint.indexOf('</msg>', start);
    if (end === -1) break;
    segments.push(hint.slice(start, end + '</msg>'.length));
    idx = end + '</msg>'.length;
  }
  return segments;
}

/**
 * 从已加载群聊历史中剔除 hint 已携带的消息段（边界感知，覆盖 loadGroupHistory 合并块）：
 * 整条等于段 / 合并块以段开头 / 段居中 / 块尾；被剥空的消息整条移除（hint 已携带，不重复注入）。
 */
function stripHintSegmentsFromHistory(history: LLMRequestMessage[], segments: string[]): LLMRequestMessage[] {
  if (segments.length === 0) return history;
  const out: LLMRequestMessage[] = [];
  for (const m of history) {
    let content = m.content ?? '';
    for (const seg of segments) {
      if (content === '') break;
      if (content === seg) { content = ''; break; }
      if (content.startsWith(seg + '\n')) { content = content.slice(seg.length + 1); continue; }
      if (content.endsWith('\n' + seg)) { content = content.slice(0, content.length - seg.length - 1); continue; }
      const mid = content.indexOf('\n' + seg + '\n');
      if (mid !== -1) content = content.slice(0, mid + 1) + content.slice(mid + seg.length + 2);
    }
    if (content.trim() === '') continue;
    if (content !== (m.content ?? '')) m.content = content;
    out.push(m);
  }
  return out;
}

/**
 * runStart：加载历史对话到 ctx.history。
 *   · 群聊：注入未归档群聊历史（恢复旧架构 preHook 的 loadGroupHistory 行为）——
 *     装配层 AgentAssembly.loadHistory 对群聊返回空，此处经 loadGroupHistory 完整注入：
 *     <msg> 标签格式化（含名称/群名映射）+ 合并相邻发言 + 超限截断（groupLoadLimitTokens）。
 *   · 1v1：若装配层已加载则复用；否则在此加载 messages.jsonl。
 */
export function makeLoadHistoryHook(config: AgentConfig, services: ToolContext): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    if (!ctx.dialogId) return;

    // 群聊：由本钩子完整加载（覆盖装配层的空 history）
    if (isGroupDialog(ctx.dialogId)) {
      const registry = services.router?.getRegistry();
      const gm = services.router?.getGroupManager();
      const ns = getNamespaceConfig(config, NS_AGENT_SESSION);
      const limit = (typeof ns.groupLoadLimitTokens === 'number' && ns.groupLoadLimitTokens > 0)
        ? ns.groupLoadLimitTokens
        : DEFAULT_GROUP_LOAD_LIMIT_TOKENS;
      // trigger 消息身份集合（Phase 1 ID 贯通）：本 run 的 hint（startMeta.source）
      // 与待注入 steer（inbox.nextStep 各消息 source）携带的 message_id。
      // 这些消息将随注入进入上下文 → 加载历史时按 id 在合并前行级剔除。
      const startMeta = ctx.meta?.[CHAT_START_META_KEY] as RunStartMeta | undefined;
      const excludeIds = new Set<string>();
      if (startMeta?.source?.message_id) excludeIds.add(startMeta.source.message_id);
      for (const pending of ctx.inbox?.nextStep ?? []) {
        const pid = pending?.source?.message_id;
        if (pid) excludeIds.add(pid);
      }
      ctx.history = loadGroupHistory(groupIdOfDialog(ctx.dialogId), ctx.agentId ?? config.agent_id, {
        getName: registry ? (id: string) => registry.getAgentName(id) : undefined,
        getGroupName: gm ? (gid: string) => gm.getGroup(gid)?.name : undefined,
        groupLoadLimitTokens: limit,
        excludeIds,
      });
      // 兜底（旧数据 / 无 id 的 hint）：按 <msg> 段字符串在历史内做边界感知剔除。
      // 背景：deliverGroupMessage 先落盘后 trigger，历史与 hint 双通道注入同一消息
      // （8/16 复现；8/17 补全合并块首/块中/块尾全边界）。id 路径（上方 excludeIds，
      // pre-merge 行级精确剔除）已覆盖 ID 贯通后的新数据，本兜底仅服务旧数据，
      // Phase 3 单通道化后随对账层整层拆除（设计文档 docs/group-single-channel-design.md）。
      const segments = extractGroupMsgSegments(startMeta?.hint);
      for (const pending of ctx.inbox?.nextStep ?? []) {
        segments.push(...extractGroupMsgSegments(pending?.content));
      }
      ctx.history = stripHintSegmentsFromHistory(ctx.history, segments);
      // 读取锚点（run 作用域，单通道化 §2.3）：= 本体文件尾。busy 注入
      // （GroupFeed.readSince）据此计算增量；随 run 生灭，不持久化。
      (ctx.meta ??= {})[GROUP_SYNC_META_KEY] = groupTailAnchor(groupIdOfDialog(ctx.dialogId));
      return;
    }

    // 1v1：若装配层已加载（AgentAssembly.loadHistory）则复用；否则在此加载
    if (ctx.history && ctx.history.length > 0) return;
    ctx.history = loadHistory(ctx.dialogId);
  };
}

/** automatic runStart 钩子：在显式 load-history 之后执行宿主注入的历史恢复调和 */
export function makeRecoverHistoryHook(config: AgentConfig, services: ToolContext): RunStartHook {
  return async (ctx: CurrentContext): Promise<void> => {
    ctx.history = recoverHistory(services, ctx);
  };
}

/** 历史恢复调和：宿主注入的 recoverHistory（ask_questions 崩溃恢复等） */
function recoverHistory(services: ToolContext, ctx: CurrentContext): LLMRequestMessage[] {
  const recovery = services.recoverHistory;
  if (!recovery || !ctx.dialogId) return ctx.history;
  try {
    return recovery(ctx.history, {
      dialogId: ctx.dialogId,
      agentId: ctx.agentId ?? '',
    });
  } catch (err: any) {
    log.error(`历史恢复调和失败（${ctx.dialogId}）: ${err?.message ?? String(err)}`);
    return ctx.history;
  }
}

// ============================================================
// runEnd：空闲计时器（占位，L5 装配注入实现）
// ============================================================

/** runEnd：重置空闲归档计时器（旧 agent-session idle-timer；实现由 L5 注入 ArchiveService） */
export function makeIdleResetHook(_config: AgentConfig, services: ToolContext): RunEndHook {
  return async (ctx: CurrentContext): Promise<void> => {
    // 整理 run 不重置空闲计时器（仅标记完成；空闲归档由主对话驱动）
    if (ctx.meta?.[META_ARCHIVE_REVIEW]) return;
    const reset = (services as any).idleReset as ((dialogId: string, selfId?: string) => void) | undefined;
    if (reset && ctx.dialogId) {
      try { reset(ctx.dialogId, ctx.agentId); } catch { /* ignore */ }
    }
  };
}

// ============================================================
// runEnd：上下文超长归档（占位，L5 装配注入实现）
// ============================================================

/**
 * runEnd：上下文超长归档（旧 agent-session archive；实现由 L5 注入 ArchiveService）。
 *
 * 统一入口（handleRunEnd）：
 *   · meta['archive-review']（整理 run）→ 写 done 标记 + 检查全部完成 → archiveAndRebuild
 *   · 否则 → 超阈值检测（API 实际 token / 估算兜底）→ requestArchive（写 pending + 触发整理 run）
 * 群聊由 save-session 周归档承载，不参与 1:1 编排。
 */
export function makeArchiveSessionHook(_config: AgentConfig, services: ToolContext): RunEndHook {
  return async (ctx: CurrentContext, result): Promise<void> => {
    const archive = (services as any).archiveSession as
      | ((ctx: CurrentContext, result: import('@agentchat/agent-loop').RunResult) => Promise<void> | void)
      | undefined;
    if (archive && ctx.dialogId) {
      try { await archive(ctx, result); } catch { /* ignore */ }
    }
  };
}
