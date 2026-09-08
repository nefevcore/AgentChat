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

/** src convKey（chat~a~b / group~g~a / single~s）→ preview conversationId
 *  ——owning = ac-client-ui-runview/client（M27.2-2 sidebar 面板壳随件迁） */
export { convKeyToId } from 'ac-client-ui-runview/client';
import { interruptRun as pkgInterruptRun } from 'ac-client-ui-runview/client';

// ---- API ----

/** 运行跟踪快照（3s 轮询；snapshot + agents/list 双 RPC 聚合） */
export async function fetchRuns(rpc: Rpc = wireRpc): Promise<RunsSnapshot> {
  const [snapshot, agentsR] = await Promise.all([
    rpc.call<PRunsSnapshot>('runs/snapshot'),
    rpc.call<{ agents?: PAgentConfig[] }>('agents/list'),
  ]);
  return toRunsSnapshot(snapshot ?? {}, agentsR.agents ?? []);
}

/** 中断指定会话键的运行中 run（软中断）——owning =
 *  ac-client-ui-runview/client（薄包装补 wireRpc 缺省维持旧签名） */
export function interruptRun(convKey: string, rpc: Rpc = wireRpc): Promise<{ success: boolean; error?: string }> {
  return pkgInterruptRun(convKey, rpc);
}

/** Agent 会话对（pair）只读历史（薄包装维持旧签名——rpc 缺省 wireRpc） */
export const fetchPairHistory = (
  from: string,
  to: string,
  limit = 100,
  offset = 0,
  rpc: Rpc = wireRpc,
) => pkgFetchPairHistory(from, to, limit, offset, rpc);