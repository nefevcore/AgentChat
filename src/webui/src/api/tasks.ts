// ============================================================
// api/tasks.ts —— 任务追踪读面（goal）
//
// goal 半边 owning = ac-client-ui-conversation/client/goalApi.ts
//（M27.2-2 视图半边随件迁——useGoalTracking 数据源）；本模块薄包装
// 维持旧签名（rpc 缺省 wireRpc）。todo 半边已随 UI 行走迁
// ac-client-ui-todo/client（M27.1）；TaskGoal 视图类型随 tool 件
//（goalCard 数据管线）。
// ============================================================

import { wireRpc } from './wire.ts';
import { fetchGoal as pkgFetchGoal, type TaskGoalSnapshot } from 'ac-client-ui-conversation/client/goalApi.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

export type { TaskGoal } from 'ac-client-ui-tool/client/goalCard.ts';
export type { TaskGoalSnapshot };

/** 读取某会话桶的当前目标（服务未装载 → null，dock 静默隐藏） */
export function fetchGoal(
  agentId: string,
  conversationId: string,
  rpc: Rpc = wireRpc,
): Promise<TaskGoalSnapshot | null> {
  return pkgFetchGoal(agentId, conversationId, rpc);
}
