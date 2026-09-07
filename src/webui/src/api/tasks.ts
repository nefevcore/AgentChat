// ============================================================
// api/tasks.ts —— 任务追踪读面（goal Port B；todo 半边已随 UI 行走迁
// ac-client-ui-todo/client/tasks.ts——M27.1 前端行拆包）
//
// goal/get RPC 直连（桶键 = conversationId：1v1 对键 / singles sid）。
// 写路径归 Agent 工具（goal）——本面只读；变更随 tool/after-execute 帧
// 触发上层刷新（composables/useGoalTracking）。
//
// goal 会话流卡片的数据归一化（normalizeGoalCard）已随 tool 件迁
// ac-client-ui-tool/client/goalCard.ts（M27.2-2 出包——ToolResultGoal
// 数据管线）；TaskGoal 视图类型同走（本模块 re-export 维持旧路径）。
// ============================================================

import { wireRpc } from './wire.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

export type { TaskGoal } from 'ac-client-ui-tool/client/goalCard.ts';
import type { TaskGoal } from 'ac-client-ui-tool/client/goalCard.ts';

/** 目标桶快照（= ac-goal GoalSnapshot） */
export interface TaskGoalSnapshot {
  current?: TaskGoal;
  history: TaskGoal[];
}

/** 读取某会话桶的当前目标（服务未装载 → null，dock 静默隐藏） */
export async function fetchGoal(
  agentId: string,
  conversationId: string,
  rpc: Rpc = wireRpc,
): Promise<TaskGoalSnapshot | null> {
  try {
    const r = await rpc.call<{ goal?: TaskGoalSnapshot }>('goal/get', { agentId, conversationId });
    return r.goal ?? { history: [] };
  } catch {
    return null; // 可选能力未装载 / 连接失败：不渲染，不报错
  }
}
