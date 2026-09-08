// ============================================================
// ac-client-ui-goal/client/goalApi.ts —— goal 读面
//（M28 P1 §4.1 原案：自 conversation 随域迁入——useGoalTracking 数据源）
//
// goal/get RPC 直连（桶键 = conversationId：1v1 对键 / singles sid）。
// 写路径归 Agent 工具（goal）——本面只读；变更随 tool/after-execute 帧
// 触发上层刷新。TaskGoal 视图类型归本包 goalCard（数据管线同源）。
// rpc 必传（契约面）；原 webui api/tasks.ts 门面已退役〔M28 §4.2〕。
// ============================================================
import type { RpcClientFace } from 'ac-client-runtime';
import type { TaskGoal } from './goalCard.ts';

type Rpc = Pick<RpcClientFace, 'call'>;

/** 目标桶快照（= ac-goal GoalSnapshot） */
export interface TaskGoalSnapshot {
  current?: TaskGoal;
  history: TaskGoal[];
}

/** 读取某会话桶的当前目标（服务未装载 → null，dock 静默隐藏） */
export async function fetchGoal(
  agentId: string,
  conversationId: string,
  rpc: Rpc,
): Promise<TaskGoalSnapshot | null> {
  try {
    const r = await rpc.call<{ goal?: TaskGoalSnapshot }>('goal/get', { agentId, conversationId });
    return r.goal ?? { history: [] };
  } catch {
    return null; // 可选能力未装载 / 连接失败：不渲染，不报错
  }
}
