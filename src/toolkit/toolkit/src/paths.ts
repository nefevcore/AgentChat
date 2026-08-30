// ============================================================
// @agentchat/toolkit/src/paths.ts —— 会话文件路径（库级，工具域共享）
//
// 契约化阶段②（2026-08-14）：从 @agentchat/tools/src/paths.ts 下沉
// chatSessionFile/groupSessionFile —— 消除 session-tools→tools 值级环
// （tools 保留 re-export 兼容；新代码直接从本模块导入）。
//
// 依赖方向：仅 Node + 本包 shared（workspaceRoot）+ @agentchat/contracts
// 的会话键纯函数（2026-08-20 键函数下沉契约层，toolkit 不再上依赖 agents）。
// ============================================================
import * as path from 'path';
import { chatDialogKey, DIALOG_SEP } from '@agentchat/contracts';
import { workspaceRoot } from './shared';

/** 1v1 会话文件：sessions/chat~<lo>~<hi>/messages.jsonl */
export function chatSessionFile(a: string, b: string): string {
  return path.join(workspaceRoot(), 'sessions', chatDialogKey(a, b), 'messages.jsonl');
}

/** 群聊本体文件：sessions/group~<gid>/messages.jsonl */
export function groupSessionFile(groupId: string): string {
  return path.join(workspaceRoot(), 'sessions', `group${DIALOG_SEP}${groupId}`, 'messages.jsonl');
}
