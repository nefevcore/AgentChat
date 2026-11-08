// ============================================================
// user.ts —— user 账本（形态二：独立账本，仅终稿层）
//
// 裁决簿〈webui 读投影〉三拆之三 + R-2：user 端点必须有壳——
// webui 形态 = 宿主进程内极薄 user 壳（单进程天然串行）。写者循
// R-2 已裁语义；webui = user 账本唯一数据源（会话列表/群视图/回放）。
//
// 投影分层（D4.2）：字量大头（思考/工具调用与结果）归产生方独占，
// 重复的只有终稿层。webui 需展开对方思考/工具内容时，按 run 键关联
// agent 账本文件直读带出——取值逻辑细节，不另立承载。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LedgerWriter } from './writer.ts';
import { readLedger } from './reader.ts';

/** user 会话目录：<dataRoot>/viewer/sessions/<uuid>/（viewer 投影轴——与
 *  agents/ 身份树平级且刻意异名：这里是 webui 视角终稿投影，不是 Agent 域
 *  账本；cr-609 前名 users/user 与 agents/user 一字之差曾致混淆） */
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
 * 会话标题读取（session.json 由宿主 singles 行单写——本函数只读）。
 * 壳侧命名行据此跳过已命名会话（壳 idle-exit/restart 频繁，重算标题是
 * 纯浪费），宿主派生面亦据此判定「已有标题」——路径与字段口径单源（cr-672）。
 */
export function readSessionTitle(dataRoot: string, uuid: string): string | undefined {
  const raw = readUserMetaObject(dataRoot, uuid);
  if (raw === null) return undefined;
  const title = raw.title;
  return typeof title === 'string' && title.trim() !== '' ? title : undefined;
}

/**
 * 终稿写穿行（peer 终稿 → user 账本）：user 壳收到 agent 终稿回复后
 * 经 writeThrough 写进 user 账本（own/peer 投影通例——user 视角的
 * 对方发言）。写者 = webui user 壳（单进程串行，R-2a）。run 键关联：
 * webui 展开对方思考/工具内容时按 run 键直读 agent 账本 journal 带出。
 */
export interface UserProjectionRow {
  /** 说话人端点（agent id） */
  agentId: string;
  /** 终稿文本 */
  content: string;
  /** 会话身份键 */
  uuid: string;
  /** 产生该终稿的 run（run 键关联——agent 账本直读带出用） */
  run?: string;
  /** run 墙钟耗时（毫秒，cr-772——终稿行 runMs 透传；历史链栏耗时锚） */
  runMs?: number;
  /** 投递幂等键（同 requestId 重投不重写） */
  requestId?: string;
  /** 行时间戳（cr-698 派生行携带各自账本原时间戳——派生时刻 ≠ 发言时刻；
   *  缺省 = 落行时刻） */
  timestamp?: string;
}

/** user 视角回放行（终稿层投影） */
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

/**
 * user 账本单会话面：终稿写穿（幂等）+ user 视角回放。
 * 内持一个 LedgerWriter（deliver 承载写穿——requestId 准入即幂等）。
 */
export class UserLedger {
  private readonly writer: LedgerWriter;
  private readonly dir: string;
  private readonly uuid: string;

  constructor(dataRoot: string, uuid: string, participants: string[]) {
    this.dir = userSessionDir(dataRoot, uuid);
    this.uuid = uuid;
    // reseedSeqPerWrite（cr-946）：viewer 账本多写者（user 桩 writeOwn +
    // 派生器每次新建）——每分配前对账尾行，防 seq 重号。
    this.writer = new LedgerWriter(this.dir, { participants, kind: 'user' }, undefined, { reseedSeqPerWrite: true });
  }

  /**
   * 终稿写穿：peer 终稿（agent 发言）落 user 账本。requestId 幂等
   * 由 deliver 内 AdmissionGate 承载（同键重投短路返回 false）。
   */
  async writeThrough(row: UserProjectionRow): Promise<boolean> {
    return this.writer.deliver({
      role: 'agent',
      content: row.content,
      agent_id: row.agentId,
      requestId: row.requestId,
      uuid: row.uuid,
      source: row.run !== undefined ? 'run:' + row.run : undefined,
      ...(row.runMs !== undefined ? { runMs: row.runMs } : {}),
      ...(row.timestamp !== undefined ? { timestamp: row.timestamp } : {}),
    });
  }

  /** user 自己的发言写穿（own 层——user 发消息时同步落账） */
  async writeOwn(text: string, requestId: string): Promise<boolean> {
    return this.writer.deliver({
      role: 'agent',
      content: text,
      agent_id: 'user',
      requestId,
      uuid: this.uuid,
    });
  }

  /** user 视角回放（终稿层投影：agent_id === 'user' → user 角色） */
  replay(): UserReplayRow[] {
    const { rows } = readLedger(this.dir);
    return rows.map((r) => ({
      role: r.agent_id === 'user' ? 'user' : 'peer',
      agentId: r.agent_id,
      content: r.content,
      run: r.source?.startsWith('run:') ? r.source.slice(4) : undefined,
      // run 墙钟耗时透传（cr-772）：历史链栏「用时」段持久锚
      ...(r.runMs !== undefined ? { runMs: r.runMs } : {}),
      ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
      timestamp: r.timestamp,
      ...(r.seq !== undefined ? { seq: r.seq } : {}),
    }));
  }
}
