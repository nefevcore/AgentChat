// ============================================================
// composables/useGoalTracking.ts —— 会话级目标追踪状态（goal）
//
// DSH 投影姿势的 Port B 形态：本 composable 不持领域 store——活值经
// goal/get RPC 拉取，刷新时机全事件化：
//   · 会话上下文切换（agentId/conversationId watch，immediate）
//   · tool/after-execute 帧（name=goal 且 conversationId 命中本桶）
//   · loop/after-run 帧（同桶收束兜底——后台过滤抑制的帧之后仍能对齐）
// 服务未装载（ac-goal 行摘除）→ fetch 返回 null → 状态收敛为
// undefined，dock 静默隐藏。
// todo 半边已随行走迁 ac-todo/client（M27 S3——TodoDockCard 自理）。
// ============================================================

import { ref, watch, onUnmounted, type Ref } from 'vue';
import { wireRpc } from '../api/wire.ts';
import { fetchGoal, type TaskGoal } from '../api/tasks.ts';

export interface GoalTracking {
  /** 当前未完成目标（undefined = 面不可用；null = 无目标——两者都不渲染） */
  goal: Ref<TaskGoal | null | undefined>;
  /** 手动刷新（会话切换/帧触发之外的对账口） */
  refresh: () => Promise<void>;
}

export function useGoalTracking(
  agentId: Ref<string | null | undefined>,
  conversationId: Ref<string | null | undefined>,
): GoalTracking {
  const goal = ref<TaskGoal | null | undefined>(undefined);

  async function refresh(): Promise<void> {
    const a = agentId.value;
    const c = conversationId.value;
    if (!a || !c) {
      goal.value = undefined;
      return;
    }
    const g = await fetchGoal(a, c);
    // 拉取期间会话已切换 → 丢弃过期结果（防串台）
    if (agentId.value !== a || conversationId.value !== c) return;
    goal.value = g === null ? undefined : (g.current ?? null);
  }

  watch([agentId, conversationId], () => void refresh(), { immediate: true });

  const off = wireRpc.onWireEvent((type, args) => {
    const c = conversationId.value;
    if (!c) return;
    if (type === 'tool/after-execute') {
      const [call] = args as Array<{ name?: string; conversationId?: string } | undefined>;
      if (call?.name === 'goal' && call?.conversationId === c) {
        void refresh();
      }
      return;
    }
    if (type === 'loop/after-run') {
      const [request] = args as Array<{ conversationId?: string } | undefined>;
      if (request?.conversationId === c) void refresh();
    }
  });
  onUnmounted(() => off());

  return { goal, refresh };
}
