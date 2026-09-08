// ============================================================
// api/runs.ts —— 运行跟踪 Port B（阶段二第五梯）
//
// runs/snapshot·interrupt 直连。RunsSnapshot 合成（src 矩阵契约：
// members/pairs/groups/running/convKey ~ 分隔格式）与 convKey→
// conversationId 换算是本模块视图代码。
// M27.2-2：历史回放族（toHistoryMessages/parseToolArgs/
// PMediaAttachment/fetchPairHistory）已随 conversation 件迁
// ac-client-ui-conversation/client/historyApi.ts——本模块 re-export
// 维持旧路径。
// ============================================================

import { wireRpc } from './wire.ts';
import type { PAgentConfig } from './roster.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

// ---- src 视图契约（M27 S3：owning package = ac-client-ui-runview/client——
// 契约随行走；本模块 re-export 维持既有消费面 import 路径不变） ----
export type {
  RunsMember, WindowCounts, RunsPairSession, RunsGroupSession,
  RunsSingleSession, RunsRunningEntry, RunsGroupArchive, RunsSnapshot,
} from 'ac-client-ui-runview/client';
import { toRunsSnapshot } from 'ac-client-ui-runview/client';
import type { PRunsSnapshot, RosterAgentView, RunsSnapshot } from 'ac-client-ui-runview/client';
export type { PRunsSnapshot, RosterAgentView } from 'ac-client-ui-runview/client';
export { toRunsSnapshot } from 'ac-client-ui-runview/client';

// ---- 历史回放族（M27.2-2：owning = ac-client-ui-conversation/client） ----

export type { PMediaAttachment } from 'ac-client-ui-conversation/client/historyApi.ts';
export {
  toHistoryMessages,
  parseToolArgs,
} from 'ac-client-ui-conversation/client/historyApi.ts';
import { fetchPairHistory as pkgFetchPairHistory } from 'ac-client-ui-conversation/client/historyApi.ts';

/** src convKey（chat~a~b / group~g~a / single~s）→ preview conversationId（M19：
 *  chat 对键双向保留——'chat~a~b' → 'a~b'，不再剥 user 特判） */
export function convKeyToId(convKey: string): string {
  if (convKey.startsWith('single~')) return convKey.slice('single~'.length);
  if (convKey.startsWith('group~')) return convKey.split('~')[1] ?? convKey;
  if (convKey.startsWith('chat~')) return convKey.slice('chat~'.length);
  return convKey;
}

// ---- API ----

/** 运行跟踪快照（3s 轮询；snapshot + agents/list 双 RPC 聚合） */
export async function fetchRuns(rpc: Rpc = wireRpc): Promise<RunsSnapshot> {
  const [snapshot, agentsR] = await Promise.all([
    rpc.call<PRunsSnapshot>('runs/snapshot'),
    rpc.call<{ agents?: PAgentConfig[] }>('agents/list'),
  ]);
  return toRunsSnapshot(snapshot ?? {}, agentsR.agents ?? []);
}

/** 中断指定会话键的运行中 run（软中断：run 走完 runEnd 落盘后退出） */
export async function interruptRun(convKey: string, rpc: Rpc = wireRpc): Promise<{ success: boolean; error?: string }> {
  const r = await rpc.call<{ aborted?: number }>('runs/interrupt', { conversationId: convKeyToId(convKey) });
  return { success: (r.aborted ?? 0) > 0 };
}

/** Agent 会话对（pair）只读历史（薄包装维持旧签名——rpc 缺省 wireRpc） */
export const fetchPairHistory = (
  from: string,
  to: string,
  limit = 100,
  offset = 0,
  rpc: Rpc = wireRpc,
) => pkgFetchPairHistory(from, to, limit, offset, rpc);