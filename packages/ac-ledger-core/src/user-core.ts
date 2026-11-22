// ============================================================
// user-core.ts —— user 会话域词汇与元数据纯核（cr-1245 B1 自 ac-ledger user.ts 拆入——类型与路径词；fs 读面留 ac-ledger user.ts）
//
// 裁决簿〈webui 读投影〉三拆之三 + R-2：user 端点无进程，宿主进程内
// 极薄 user 壳（单进程天然串行）。cr-973（cr-972 第一刀）起 viewer
// 物化账本退役：终稿层 = project.ts 读时投影（agent 域账本纯函数），
// 本文件只保留目录词汇、singles 元数据读面与 replay 行形状。cr-998：
// viewer 旧位元数据兼容窗退役（meta/ 单源）。
// ============================================================
import * as path from 'node:path';

/**
 * singles 独立会话键词法（cr-1120）：uuid 形（v4/v7 兼容）——签发源恒此形
 * （服务端 issueConversationId / 前端 issueLocalConversationId）。agents 域
 * sessions/ 另住对桶键 'a~b'（agent⇄agent / 群成员流 gid~member）与子 Agent
 * 键 'sub_*'——非 singles 身份。判词单源（cr-1179）：宿主 singles 行与壳侧
 * auto-title 行同源——壳行据此只命名 singles 会话（非此形键 title.set 必被
 * 宿主词汇锁拒收）。
 */
export { isUuidKey as isSingleSessionId } from 'ac-conv-keys'; // 判词本体已迁 ac-conv-keys（cr-1238 D1）——兼容 re-export，收官清零

/** user 会话目录（viewer 投影轴——cr-973 起仅存量兼容读与 singles
 *  身份目录词汇；与 agents/ 身份树平级且刻意异名：cr-609 前名
 *  users/user 与 agents/user 一字之差曾致混淆） */
export function userSessionDir(dataRoot: string, uuid: string): string {
  if (uuid.length === 0 || /[/\\]/.test(uuid) || uuid === '.' || uuid === '..') {
    throw new Error('user 会话路径组件非法：' + uuid);
  }
  return path.join(dataRoot, 'viewer', 'sessions', uuid);
}

/** 独立会话元数据目录（meta/sessions——cr-1209 单源：singles 行与 agent
 *  删除级联共用；此前各写一份 path.join 字面量） */
export function metaSessionsDir(dataRoot: string): string {
  return path.join(dataRoot, 'meta', 'sessions');
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



/** user 视角回放行（终稿层投影——projectUserReplay 的输出形状；
 *  兼容窗直读 viewer 存量文件时同样映射到本形状） */
export interface UserReplayRow {
  role: 'user' | 'peer';
  agentId: string;
  content: string;
  /** 行锚（cr-1132：peer 行透出——主投影 message_id / 注入卡 anchor 目标；
   *  归一化层保证恒 string，空串 = 无锚） */
  messageId?: string;
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
