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
 * 会话标题读取（<dir>/session.json 由宿主 singles 行单写——本函数只读）。
 * 壳侧命名行据此跳过已命名会话（壳 idle-exit/restart 频繁，重算标题是
 * 纯浪费），宿主派生面亦据此判定「已有标题」——路径与字段口径单源（cr-672）。
 */
export function readSessionTitle(dataRoot: string, uuid: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(userSessionDir(dataRoot, uuid), 'session.json'), 'utf-8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const title = (raw as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() !== '' ? title : undefined;
  } catch {
    return undefined; // 无 session.json（存量会话/未命名）
  }
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
    this.writer = new LedgerWriter(this.dir, { participants, kind: 'user' });
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
    }));
  }
}
