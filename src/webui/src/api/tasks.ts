// ============================================================
// api/tasks.ts —— 任务追踪读面（goal）
//
// goal 半边 owning = ac-client-ui-goal/client（M28 P1 §4.1 原案：
// goalApi + goalCard 数据管线随域迁入）；本模块薄包装维持旧签名
//（rpc 缺省 wireRpc）。todo 半边住 ac-client-ui-todo/client（M27.1）。
// ============================================================

import { wireRpc } from './wire.ts';
import { fetchGoal as pkgFetchGoal, type TaskGoalSnapshot } from 'ac-client-ui-goal/client/goalApi.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

export type { TaskGoal } from 'ac-client-ui-goal/client/goalCard.ts';
export type { TaskGoalSnapshot };

/** 读取某会话桶的当前目标（服务未装载 → null，dock 静默隐藏） */
export function fetchGoal(
  agentId: string,
  conversationId: string,
  rpc: Rpc = wireRpc,
): Promise<TaskGoalSnapshot | null> {
  return pkgFetchGoal(agentId, conversationId, rpc);
}
