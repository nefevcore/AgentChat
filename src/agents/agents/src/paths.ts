// ============================================================
// src/agents/paths.ts —— 会话键纯函数（L2，零依赖）
//
// 新存储规范（2026-08-08 定稿；2026-08-19 增 single 三形态）：
//   · 分隔符 `~`（Windows 安全；不含数字/字母/下划线）
//   · 1v1 会话键：chat~<lo>~<hi>（lo/hi 排序，双方共享，保证唯一）
//   · 群聊会话键：group~<gid>~<aid>（per-Agent 隔离）
//   · 独立会话键：single~<sid>（单会话一等实体：Agent 引用 + 模型覆盖，
//     历史/上下文与 pair 会话隔离；元数据在 workspace/singles/<sid>/session.json）
//   · 群聊本体：  sessions/group~<gid>/messages.jsonl（功能历史，无思考/工具）
//   · 记忆对象键：1v1 = 对方 id；群聊 = group~<gid>；独立会话 = <sid>
//     （会话级隔离：每个 single 各自空白记忆，互不污染）
//
// 归位说明（2026-08-08 修订）：会话键构造是 L2（agents）的核心职责——
//   · L2 router 构造 dialogKey 直接消费本模块
//   · L3/L4 解析 dialogKey（isGroupDialog/groupIdOfDialog/...）也从本模块引入，
//     避免把构造职责下沉到 L1 core
//   · 纯文件路径函数见 @plugins/builtin/paths（L3，依赖本模块键函数）
//
// 注意：1v1 排序共享会话键后无法反推当前 Agent，selfId 一律显式传递。
// ============================================================

/** 会话键分隔符（Windows 文件名安全；非数字/字母/下划线） */
export const DIALOG_SEP = '~';

/** 1v1 会话键：chat~<lo>~<hi>（两 id 排序保证唯一） */
export function chatDialogKey(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return `chat${DIALOG_SEP}${lo}${DIALOG_SEP}${hi}`;
}

/** 群聊会话键（per-Agent）：group~<gid>~<aid> */
export function groupDialogKey(groupId: string, agentId: string): string {
  return `group${DIALOG_SEP}${groupId}${DIALOG_SEP}${agentId}`;
}

/** 独立会话键：single~<sid>（sid = workspace/singles/<sid> 的会话 id） */
export function singleDialogKey(sessionId: string): string {
  return `single${DIALOG_SEP}${sessionId}`;
}

/** 是否群聊会话键 */
export function isGroupDialog(dialogId: string): boolean {
  return dialogId.startsWith(`group${DIALOG_SEP}`);
}

/** 是否独立会话键（single~<sid>） */
export function isSingleDialog(dialogId: string): boolean {
  return dialogId.startsWith(`single${DIALOG_SEP}`);
}

/** 独立会话键 → session id（single~<sid> → <sid>） */
export function sessionIdOfDialog(dialogId: string): string {
  return dialogId.split(DIALOG_SEP)[1] ?? '';
}

/** 会话键末段（群聊 = agentId；1v1 为排序后 hi，不用于推断当前 Agent） */
export function lastSegmentOf(dialogId: string): string {
  const idx = dialogId.lastIndexOf(DIALOG_SEP);
  return idx >= 0 ? dialogId.slice(idx + 1) : dialogId;
}

/** 群聊会话键 → group id（group~<gid>~<aid> → <gid>） */
export function groupIdOfDialog(dialogId: string): string {
  return dialogId.split(DIALOG_SEP)[1] ?? '';
}

/**
 * 对话对象键（记忆文件命名用）：
 *   1v1 → 对方 id（selfId 之外的另一个）；群聊 → group~<gid>；
 *   独立会话 → <sid>（会话级隔离记忆：每个 single 独立空白开始）
 */
export function counterpartOfDialog(dialogId: string, selfId: string): string {
  const seg = dialogId.split(DIALOG_SEP);
  if (isGroupDialog(dialogId)) {
    return `group${DIALOG_SEP}${seg[1]}`; // ['group', gid, aid]
  }
  if (isSingleDialog(dialogId)) {
    return seg[1]; // ['single', sid]
  }
  return seg[1] === selfId ? seg[2] : seg[1]; // ['chat', lo, hi]
}

/** ISO 8601 年-周（YYYY-WW） */
export function yearWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}
