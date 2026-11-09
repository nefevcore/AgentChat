// ============================================================
// user.ts —— user 会话域词汇与元数据读面
//
// 裁决簿〈webui 读投影〉三拆之三 + R-2：user 端点无进程，宿主进程内
// 极薄 user 壳（单进程天然串行）。cr-973（cr-972 第一刀）起 viewer
// 物化账本退役：终稿层 = project.ts 读时投影（agent 域账本纯函数），
// 本文件只保留目录词汇、singles 元数据读面与 replay 行形状。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** user 会话目录（viewer 投影轴——cr-973 起仅存量兼容读与 singles
 *  身份目录词汇；与 agents/ 身份树平级且刻意异名：cr-609 前名
 *  users/user 与 agents/user 一字之差曾致混淆） */
export function userSessionDir(dataRoot: string, uuid: string): string {
  if (uuid.length === 0 || /[/\\]/.test(uuid) || uuid === '.' || uuid === '..') {
    throw new Error('user 会话路径组件非法：' + uuid);
  }
  return path.join(dataRoot, 'viewer', 'sessions', uuid);
}

/**
 * 独立会话元数据路径（数据分层第二层：<dataRoot>/meta/sessions/<uuid>.json
 * ——宿主 singles 行单写）。此前寄居 viewer 投影目录（第三层），「清投影」
 * 会连源数据一起清——迁出后 viewer 整树可删（boot 投影对账自愈）。
 */
export function userMetaFile(dataRoot: string, uuid: string): string {
  if (uuid.length === 0 || /[/\\]/.test(uuid) || uuid === '.' || uuid === '..') {
    throw new Error('user 会话路径组件非法：' + uuid);
  }
  return path.join(dataRoot, 'meta', 'sessions', uuid + '.json');
}

/** 独立会话元数据旧路径（viewer 投影寄居期形态——读侧兼容窗，写侧恒新路径） */
export function legacyUserMetaFile(dataRoot: string, uuid: string): string {
  return path.join(userSessionDir(dataRoot, uuid), 'session.json');
}

/**
 * 独立会话元数据读取（新路径优先，回落旧路径——兼容窗内旧文件不迁移）。
 * 缺席/损坏/非法路径组件 = null。读面单源：singles 行 / workspace 面 /
 * 壳侧垫片共用（防四处各写一份 fallback 走散）。
 */
export function readUserMetaObject(dataRoot: string, uuid: string): Record<string, unknown> | null {
  if (uuid.length === 0 || /[/\\]/.test(uuid) || uuid === '.' || uuid === '..') return null;
  for (const file of [userMetaFile(dataRoot, uuid), legacyUserMetaFile(dataRoot, uuid)]) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    } catch { /* 该路径缺席/损坏 → 试下一处 */ }
  }
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

/** user 视角回放行（终稿层投影——projectUserReplay 的输出形状；
 *  兼容窗直读 viewer 存量文件时同样映射到本形状） */
export interface UserReplayRow {
  role: 'user' | 'peer';
  agentId: string;
  content: string;
  run?: string;
  /** run 墙钟耗时（毫秒，cr-772——终稿行 runMs 透传；历史链栏耗时锚） */
  runMs?: number;
  /** 行投递幂等键透传（cr-739：读面跨域关联——busy-steer 插队消息在 agent
   *  域另有同键注入行，消费方据此去重） */
  requestId?: string;
  /** 行时间戳（cr-716：读面历史排序/分组的事实键——缺席曾致 user 行沉底乱序） */
  timestamp: string;
  /** 行级单调序号（B1 行级 seq 持久化——透传 session/history 行；存量行缺席） */
  seq?: number;
}
