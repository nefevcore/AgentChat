// ============================================================
// agent-session group-archive —— 群聊归档（v0.4.x）
//
// 与 1:1 归档同模式：先整理后归档。差异：
//   · 触发点：GroupManager.deliverGroupMessage（非 postHook）
//   · 参与者：群内所有真实 Agent（user 等虚拟 Agent 不参与整理）
//   · 记忆：每个参与者对群聊的独立记忆
//       sessions/<agent>/group__<groupId>/memory.md（方向敏感）
//   · 归档文件：groups/<id>/archive/history_N.jsonl
//   · 摘要锚点：groups/<id>/archive/summary.md（归档时生成）
//
// 标记（系统管理）：
//   groups/<id>/.archive_pending         待归档（含参与者）
//   groups/<id>/.archive_done_<agentId>  该参与者整理完成
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalConfig } from '@core/config';
import { getAppState } from '@core/app-state';
import { resolveGroupMessagePath } from '@routing/group-manager';
import { logger } from '../../../../utils/logger';
import { ARCHIVE_REVIEW_PREFIX } from './archive';
import { estimateMessagesTokens } from './history';
import { cfg } from './meta';

/** 群聊归档超时（毫秒） */
const GROUP_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

function groupDirOf(groupId: string): string {
  return path.join(getGlobalConfig().groupsDir, groupId);
}
function pendingMarkerPath(groupId: string): string {
  return path.join(groupDirOf(groupId), '.archive_pending');
}
function doneMarkerPath(groupId: string, who: string): string {
  return path.join(groupDirOf(groupId), `.archive_done_${who}`);
}

/** 群聊归档记忆路径（方向敏感：每个 Agent 独立） */
export function resolveGroupAgentMemoryPath(agent: string, groupId: string): string {
  return path.join(getGlobalConfig().sessionsDir, agent, `group__${groupId}`, 'memory.md');
}

/** 读取群聊参与者（真实 Agent，排除虚拟） */
function getGroupParticipants(groupId: string): string[] {
  try {
    const state = getAppState();
    const registry = (state as any).registry as
      | { listIds?: () => string[]; isVirtual?: (id: string) => boolean }
      | undefined;
    // AppState 键为 GroupManager（大写 G，见 bootstrap），兼容小写
    const gm = (state as any).GroupManager ?? (state as any).groupManager as
      | { getGroup?: (id: string) => { participants: string[] } | undefined }
      | undefined;
    const group = gm?.getGroup?.(groupId);
    logger.info(`[group-archive] getGroupParticipants: group=${groupId} found=${!!group} registry=${!!registry} keys=${Object.keys(state).join(',')}`);
    if (!group || !registry) return [];
    const participants = group.participants.filter((p: string) => !registry.isVirtual?.(p));
    logger.info(`[group-archive] getGroupParticipants: participants=${participants.join(',')} raw=${group.participants.join(',')}`);
    return participants;
  } catch (err: any) {
    logger.error(`[group-archive] getGroupParticipants 异常: ${err?.message}`);
    return [];
  }
}

/** 读取群聊全部消息（用于 token 估算/归档） */
function readGroupMessages(groupId: string): Array<Record<string, any>> {
  const filePath = resolveGroupMessagePath(groupId);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * 请求群聊归档：写 .archive_pending + 触发所有参与者整理轮。
 * deliverGroupMessage 检测 token 超阈值时调用。幂等。
 */
export function requestGroupArchive(groupId: string): void {
  const pendingPath = pendingMarkerPath(groupId);
  logger.info(`[group-archive] requestGroupArchive: group=${groupId} pending=${fs.existsSync(pendingPath)}`);
  if (fs.existsSync(pendingPath)) return;

  const participants = getGroupParticipants(groupId);
  logger.info(`[group-archive] requestGroupArchive: participants=${participants.join(',')} count=${participants.length}`);
  if (participants.length === 0) return;

  const dir = groupDirOf(groupId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pendingPath, JSON.stringify({
    group_id: groupId,
    participants,
    requestedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  logger.info(`[group-archive] 已写 pending: ${pendingPath}`);

  for (const p of participants) {
    triggerGroupReview(groupId, p);
  }
}

/** 触发单个参与者的群聊整理轮 */
function triggerGroupReview(groupId: string, agent: string): void {
  try {
    const router = (getAppState() as any).router as
      | { trigger: (id: string, opts: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    logger.info(`[group-archive] triggerGroupReview: group=${groupId} agent=${agent} router=${!!router}`);
    if (!router?.trigger) {
      logger.warn(`[group-archive] 无 router，降级写 done: ${agent}`);
      completeGroupArchiveReview(groupId, agent, true);
      return;
    }

    const hint =
      `${ARCHIVE_REVIEW_PREFIX} 群聊 "${groupId}" 达到归档阈值，` +
      `请在归档前整理你对这个群聊的记忆：基于完整群聊历史，把重要信息更新到 ` +
      `sessions/<你的ID>/group__${groupId}/memory.md（及各 Agent 协作要点）。` +
      `整理完成后系统会自动归档，无需管理标记。`;

    setTimeout(() => {
      logger.info(`[group-archive] 触发整理轮: agent=${agent} group=${groupId} source=group-archive-review`);
      router.trigger(agent, {
        hint,
        source: `group-archive-review:${groupId}`,
        target: agent, // 群聊整理轮：sender=自己，group_id 指定群
        group_id: groupId,
        archiveReview: true,
        maxTurns: 12,
      }).then(() => {
        logger.info(`[group-archive] 整理轮 trigger 成功返回: agent=${agent}`);
      }).catch((err: Error) => {
        logger.warn(`[group-archive] 整理轮 trigger 失败: agent=${agent} err=${err?.message}`);
        completeGroupArchiveReview(groupId, agent, true);
      });
    }, 300);
  } catch (err: any) {
    logger.warn(`[group-archive] triggerGroupReview 异常: ${err?.message}`);
    completeGroupArchiveReview(groupId, agent, true);
  }
}

/**
 * 群聊整理轮完成：写 .archive_done_<agent>，全部完成 → 归档。
 */
export async function completeGroupArchiveReview(
  groupId: string, agent: string, failed = false,
): Promise<void> {
  const dir = groupDirOf(groupId);
  const pendingPath = pendingMarkerPath(groupId);
  logger.info(`[group-archive] completeGroupArchiveReview: group=${groupId} agent=${agent} failed=${failed} pending=${fs.existsSync(pendingPath)}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(doneMarkerPath(groupId, agent), '', 'utf-8');
    logger.info(`[group-archive] 已写 done: ${agent} failed=${failed}`);
    if (failed) {
      logger.warn(`[group-archive] 群聊整理失败/跳过: ${groupId} ${agent}`);
    }

    if (!fs.existsSync(pendingPath)) return;
    let pending: { participants?: string[] };
    try {
      pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
    } catch {
      return;
    }
    const participants: string[] = pending.participants || [];
    const allDone = participants.every(p => fs.existsSync(doneMarkerPath(groupId, p)));
    if (!allDone) {
      const done = participants.filter(p => fs.existsSync(doneMarkerPath(groupId, p)));
      logger.info(`[agent-session] 群聊整理 ${done.join(',')} 已完成，等待全部 (${groupId})`);
      return;
    }

    // 全部完成 → 归档
    logger.info(`[agent-session] 群聊整理全部完成，执行归档 ${groupId}`);
    archiveGroupMessages(groupId);

    // 清理标记
    try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
    for (const p of participants) {
      try { fs.unlinkSync(doneMarkerPath(groupId, p)); } catch { /* ignore */ }
    }
  } catch (err: any) {
    logger.error(`[agent-session] 群聊归档完成处理失败: ${err.message}`);
  }
}

/** 生成群聊摘要（机械提取：有内容的 agent 消息，截断拼接） */
function generateGroupSummary(msgs: Array<Record<string, any>>, maxMsgs = 30): string {
  const items: string[] = [];
  for (const m of msgs) {
    if (items.length >= maxMsgs) break;
    if (m.role === 'tool') continue;
    const content = (m.content || '').trim();
    if (!content) continue;
    // 跳过 trigger 消息：新数据 role='trigger'，旧数据正文以 <trigger> 开头
    if (m.role === 'trigger' || content.startsWith('<trigger>')) continue;
    const ts = m.timestamp ? m.timestamp.slice(0, 16).replace('T', ' ') : '';
    const sender = m.agent_id || 'unknown';
    const truncated = content.length > 150 ? content.slice(0, 150) + '…' : content;
    items.push(`- [${ts}] ${sender}: ${truncated.replace(/\n/g, ' ')}`);
  }
  return items.join('\n');
}

/** 执行群聊归档：旧消息 → archive/history_N.jsonl + 保留近期 + 写摘要锚点 */
function archiveGroupMessages(groupId: string): void {
  const msgPath = resolveGroupMessagePath(groupId);
  if (!fs.existsSync(msgPath)) return;

  const allMessages = readGroupMessages(groupId);
  if (allMessages.length === 0) return;

  const archiveDir = path.join(groupDirOf(groupId), 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  // 计算归档编号
  const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.jsonl'));
  const archiveIndex = archiveFiles.length + 1;

  // 保留近期（按 token 预算，默认 30k）
  const safeTarget = 30000;
  const truncated = truncateGroupMessages(allMessages, safeTarget);
  const truncStart = allMessages.length - truncated.length;
  const archiveMessages = allMessages.slice(0, Math.max(0, truncStart));

  // 写归档
  if (archiveMessages.length > 0) {
    const archivePath = path.join(archiveDir, `history_${archiveIndex}.jsonl`);
    for (const m of archiveMessages) {
      fs.appendFileSync(archivePath, JSON.stringify(m) + '\n', 'utf-8');
    }
    logger.info(`[agent-session] 群聊归档 ${groupId}: ${archiveMessages.length} 条 → ${archivePath}`);

    // 写摘要锚点（供 agent-prompt 注入）
    const summary = generateGroupSummary(archiveMessages);
    if (summary) {
      const summaryPath = path.join(archiveDir, `summary_${archiveIndex}.md`);
      const header = `# 群聊 ${groupId} 早期摘要（归档 ${new Date().toISOString().slice(0, 16)}）\n\n`;
      fs.writeFileSync(summaryPath, header + summary + '\n', 'utf-8');
      logger.info(`[agent-session] 群聊摘要锚点已写入: ${summaryPath}`);
    }
  }

  // 重建 messages.jsonl（保留近期）
  fs.writeFileSync(msgPath, truncated.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  const dropped = allMessages.length - truncated.length;
  if (dropped > 0) {
    logger.info(`[agent-session] 群聊归档截断 ${dropped} 条早期消息，保留 ${truncated.length} 条 (${groupId})`);
  }
}

/** 按 token 预算从尾部保留群聊消息 */
function truncateGroupMessages(msgs: Array<Record<string, any>>, tokenBudget: number): Array<Record<string, any>> {
  let accumulated = 0;
  let splitIdx = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const tokens = estimateMessagesTokens([{ role: 'user', content: msgs[i].content ?? '' } as any]);
    if (accumulated + tokens > tokenBudget * 1.5 && accumulated > 0) break;
    accumulated += tokens;
    splitIdx = i;
  }
  return msgs.slice(Math.max(0, splitIdx));
}

/** 全局超时降级：扫描群聊 .archive_pending，超时 → 强制归档 */
/** 全局超时降级：扫描群聊 .archive_pending，超时 → 强制归档 */
export function startGroupArchiveWatcher(): void {
  const interval = 5 * 60 * 1000;
  setInterval(() => {
    try {
      const groupsDir = getGlobalConfig().groupsDir;
      if (!fs.existsSync(groupsDir)) return;
      const now = Date.now();
      for (const g of fs.readdirSync(groupsDir, { withFileTypes: true })) {
        if (!g.isDirectory()) continue;
        const pendingPath = path.join(groupsDir, g.name, '.archive_pending');
        if (!fs.existsSync(pendingPath)) continue;
        try {
          const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
          const requestedAt = new Date(pending.requestedAt || 0).getTime();
          if (now - requestedAt > GROUP_ARCHIVE_TIMEOUT_MS) {
            logger.warn(`[agent-session] 群聊归档超时，强制归档 ${g.name}`);
            archiveGroupMessages(g.name);
            try { fs.unlinkSync(pendingPath); } catch { /* ignore */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* 扫描失败静默 */ }
  }, interval);
}

/**
 * 阈值检测包装：群聊消息 token 超阈值时触发归档。
 * 由 GroupManager.deliverGroupMessage 调用。
 */
export function maybeRequestGroupArchive(groupId: string): void {
  try {
    const msgs = readGroupMessages(groupId);
    if (msgs.length === 0) return;
    const tokens = estimateMessagesTokens(
      msgs.map(m => ({ role: 'user', content: m.content ?? '' }) as any)
    );
    const threshold = cfg().groupArchiveTokens;
    logger.info(`[group-archive] maybeRequest: group=${groupId} msgs=${msgs.length} tokens=${tokens} threshold=${threshold} trigger=${tokens > threshold}`);
    if (tokens > threshold) {
      requestGroupArchive(groupId);
    }
  } catch (err: any) {
    logger.warn(`[group-archive] 阈值检测失败: ${err.message}`);
  }
}

// 启动群聊归档超时降级监视（模块加载时一次）
startGroupArchiveWatcher();
