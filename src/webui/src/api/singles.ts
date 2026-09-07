// ============================================================
// api/singles.ts —— 独立会话 Port B（薄包装——M27 S3-1b 契约随行走）
//
// 数据面已迁 ac-singles/client（owning = 行包双半边）；本模块维持旧
// import 路径与旧签名（rpc 缺省 wireRpc + chatPresence.sid 登记桥——
// WS 侧 dialogId 合成 [single~sid 判别] 依赖该集合）。
// ============================================================

import { wireRpc } from './wire.ts';
import { chatPresence } from './chat-ops';
import {
  fetchSingles as rowFetchSingles,
  createSingle as rowCreateSingle,
  updateSingle as rowUpdateSingle,
  archiveSingle as rowArchiveSingle,
  deleteSingle as rowDeleteSingle,
} from 'ac-singles/client';

export type { SingleSession } from 'ac-singles/client';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** presence 桥（webui 侧 chatPresence 登记——行内服务走 sessions 协调面） */
const track = (id: string, removed = false): void => {
  if (removed) chatPresence.knownSingles.delete(id);
  else chatPresence.knownSingles.add(id);
};

export function fetchSingles(rpc: Rpc = wireRpc) {
  return rowFetchSingles(rpc, { track });
}

export function createSingle(payload: Parameters<typeof rowCreateSingle>[0], rpc: Rpc = wireRpc) {
  return rowCreateSingle(payload, rpc, { track });
}

export function updateSingle(id: string, payload: Parameters<typeof rowUpdateSingle>[1], rpc: Rpc = wireRpc) {
  return rowUpdateSingle(id, payload, rpc, { track });
}

export function archiveSingle(id: string, rpc: Rpc = wireRpc) {
  return rowArchiveSingle(id, rpc);
}

export function deleteSingle(id: string, rpc: Rpc = wireRpc) {
  return rowDeleteSingle(id, rpc, { track });
}
