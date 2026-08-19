// ============================================================
// src/plugins/builtin/paths.ts —— 存储文件路径（L3，键函数见 @agents/paths）
//
// 新存储规范（2026-08-08 定稿）：
//   · 1v1 会话：  sessions/chat~<lo>~<hi>/messages.jsonl（lo/hi 排序保证唯一）
//   · 单聊归档：  sessions/chat~<lo>~<hi>/archive/
//   · 群聊本体：  sessions/group~<gid>/messages.jsonl（功能历史：Agent 回话，无思考/工具）
//   · 群聊思考：  sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl
//                （每 Agent 每周增量，含思考/工具，仅分析复盘，不参与功能逻辑）
//   · 记忆：      files/<selfId>/memory/<counterpart>.memory.md（集中管理）
//   · LLM 缓存键：hashDialogId(dialogId)（见 @core/hash）
//
// 注意：1v1 排序共享会话键后无法反推当前 Agent，selfId 一律显式传递。
//
// 依赖方向：仅依赖 Node + @agents/paths + 本层 shared。
// ============================================================

import * as path from 'path';
import { workspaceRoot } from '@agentchat/toolkit';
import {
  DIALOG_SEP, chatDialogKey, groupDialogKey, singleDialogKey, isGroupDialog,
  isSingleDialog, sessionIdOfDialog, lastSegmentOf, groupIdOfDialog,
  counterpartOfDialog, yearWeek, wrapGroupMsg, escapeMsgAttr,
} from '@agentchat/agents';

// 会话键纯函数 re-export（router/HistoryService 等也可直接引 @agents/paths）
export {
  DIALOG_SEP, chatDialogKey, groupDialogKey, singleDialogKey, isGroupDialog,
  isSingleDialog, sessionIdOfDialog, lastSegmentOf, groupIdOfDialog,
  counterpartOfDialog, yearWeek, wrapGroupMsg, escapeMsgAttr,
};

// 契约化阶段②：会话文件路径下沉 @agentchat/toolkit（消除 session-tools→tools
// 值环）；此处保留 re-export 兼容旧导入，新代码直接从 toolkit 引入。
export { chatSessionFile, groupSessionFile } from '@agentchat/toolkit';

// ============================================================
// 会话文件（1v1）
// ============================================================

/** 按会话键的会话文件（1v1；群聊无 messages.jsonl，仅周归档） */
export function sessionFileOf(dialogId: string): string {
  return path.join(workspaceRoot(), 'sessions', dialogId, 'messages.jsonl');
}

// ============================================================
// 群聊本体（功能历史：Agent 回话，无思考/工具）
// ============================================================

/** 单聊归档目录：sessions/chat~<lo>~<hi>/archive */
export function chatArchiveDir(a: string, b: string): string {
  return path.join(workspaceRoot(), 'sessions', chatDialogKey(a, b), 'archive');
}

// ============================================================
// 群聊思考历史（周归档，含思考/工具，仅分析复盘）
// ============================================================

/**
 * 群聊 Agent 历史文件：sessions/group~<gid>/archive/<aid>/history_<YYYY>-<WW>.jsonl
 * 增量追加；仅分析复盘，不参与功能逻辑。
 */
export function groupHistoryFile(groupId: string, agentId: string, date: Date = new Date()): string {
  return path.join(
    workspaceRoot(), 'sessions', `group${DIALOG_SEP}${groupId}`,
    'archive', agentId, `history_${yearWeek(date)}.jsonl`,
  );
}

/** 群聊某 Agent 的归档目录：sessions/group~<gid>/archive/<aid> */
export function groupAgentArchiveDir(groupId: string, agentId: string): string {
  return path.join(workspaceRoot(), 'sessions', `group${DIALOG_SEP}${groupId}`, 'archive', agentId);
}

/** 群聊归档根：sessions/group~<gid>/archive */
export function groupArchiveRoot(groupId: string): string {
  return path.join(workspaceRoot(), 'sessions', `group${DIALOG_SEP}${groupId}`, 'archive');
}

// ============================================================
// 记忆（集中管理：files/<selfId>/memory/）
// ============================================================

/**
 * 记忆文件：files/<selfId>/memory/<counterpart>.memory.md
 * counterpart：1v1 = 对方 Agent id；群聊 = group~<gid>。
 */
export function memoryFile(selfId: string, counterpart: string): string {
  return path.join(workspaceRoot(), 'files', selfId, 'memory', `${counterpart}.memory.md`);
}

/** 按会话键解析记忆文件（需显式 selfId） */
export function memoryFileOf(dialogId: string, selfId: string): string {
  return memoryFile(selfId, counterpartOfDialog(dialogId, selfId));
}

/** 记忆标记文件：files/<selfId>/memory/<counterpart>.memory_<update|review>_needed */
export function memoryMarkerFile(selfId: string, counterpart: string, kind: 'update' | 'review'): string {
  return path.join(workspaceRoot(), 'files', selfId, 'memory', `${counterpart}.memory_${kind}_needed`);
}

// ============================================================
// 兼容读取（迁移前旧格式回退）
// ============================================================

/** 旧架构 canonical 排序嵌套路径：sessions/<lo>/<hi>/messages.jsonl（迁移前回退用） */
export function legacyCanonicalSessionFile(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return path.join(workspaceRoot(), 'sessions', lo, hi, 'messages.jsonl');
}
