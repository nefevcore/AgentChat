// ============================================================
// ac-client-ui-goal/client/goalApi.ts —— goal 前端数据面
//（M28 P1 §4.1 原案：自 conversation 随域迁入——useGoalTracking 数据源；
// 2026-10 增写面：dock 卡直编目标）
//
// goal/get RPC 直连（桶键 = conversationId：1v1 对键 / singles sid）。
// 写面 goal/update · goal/delete 同服务直编（写口与 Agent goal 工具同一
// GoalsService，最终一致）；rpc error 语义沿用「服务未装载/连接失败」
// null 归一（dock 静默）——写失败抛 Error 由调用方呈现。
// TaskGoal 视图类型归本包 goalCard（数据管线同源）。
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

/** goal 更新补丁（undefined 字段 = 保持不变；note='' = 清除） */
export interface TaskGoalPatch {
  objective?: string;
  note?: string;
  status?: TaskGoal['status'];
  blockedReason?: string;
  maxRounds?: number;
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

/** 更新当前目标（服务端返回更新后的 goal；失败抛 Error——调用方呈现） */
export async function updateGoal(
  agentId: string,
  conversationId: string,
  patch: TaskGoalPatch,
  rpc: Rpc,
): Promise<TaskGoal> {
  const r = await rpc.call<{ goal?: TaskGoal }>('goal/update', {
    agentId,
    conversationId,
    patch: {
      ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.blockedReason !== undefined ? { blocked_reason: patch.blockedReason } : {}),
      ...(patch.maxRounds !== undefined ? { max_rounds: patch.maxRounds } : {}),
    },
  });
  if (!r.goal) throw new Error('goal/update 返回异常（缺 goal）');
  return r.goal;
}

/** 删除当前目标（放弃，不入历史；失败抛 Error——调用方呈现） */
export async function deleteGoal(
  agentId: string,
  conversationId: string,
  rpc: Rpc,
): Promise<void> {
  await rpc.call('goal/delete', { agentId, conversationId });
}
