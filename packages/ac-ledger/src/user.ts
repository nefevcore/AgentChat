// ============================================================
// user.ts —— user 会话域词汇壳（cr-1245 B1：类型与路径词迁 ac-ledger-core user-core.ts；fs 读面 readUserMetaObject/readSessionTitle 本文件保留）
// ============================================================
export { userSessionDir, metaSessionsDir, userMetaFile, isSingleSessionId, type UserReplayRow } from 'ac-ledger-core/src/user-core.ts';
import { userMetaFile } from 'ac-ledger-core/src/user-core.ts';
import * as fs from 'node:fs';

/**
 * 独立会话元数据读取（meta/sessions/<uuid>.json 单源——cr-998 起 viewer
 * 旧位置兼容窗退役，数据根已一次性迁移归零）。缺席/损坏/非法路径组件
 * = null。读面单源：singles 行 / workspace 面 / 壳侧垫片共用（防四处
 * 各写一份 fallback 走散）。
 */
export function readUserMetaObject(dataRoot: string, uuid: string): Record<string, unknown> | null {
  if (uuid.length === 0 || /[/\\]/.test(uuid) || uuid === '.' || uuid === '..') return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(userMetaFile(dataRoot, uuid), 'utf-8'));
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch { /* 缺席/损坏 = null */ }
  return null;
}

/**
 * 会话标题读取（meta/sessions 由宿主 singles 行单写——本函数只读）。
 * 壳侧命名行据此跳过已命名会话（壳 idle-exit/restart 频繁，重算标题是
 * 纯浪费），宿主派生面亦据此判定「已有标题」——路径与字段口径单源（cr-672）。
 */
export function readSessionTitle(dataRoot: string, uuid: string): string | undefined {
  const raw = readUserMetaObject(dataRoot, uuid);
  if (raw === null) return undefined;
  const title = raw.title;
  return typeof title === 'string' && title.trim() !== '' ? title : undefined;
}
