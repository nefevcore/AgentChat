// ============================================================
// ac-client-ui-goal/tests/goal-tracking.test.ts —— useGoalTracking
// 帧触发面（cr-1143）：cr-976 B 案帧族（tool/result · run/settled）
// 刷新回归。核心断言：顶层直调的 tool/result 帧（无 subcall 标记、
// name=goal）也触发刷新——ledger 行 name 恒落后直调模式同权（直调是
// 绝大多数会话形态，cr-1143 前仅 run_code 子调用帧可触发）。
// composable 测试姿势：renderToString 驱动 setup（node 无 DOM；
// onUnmounted 需组件实例——effectScope 裸跑会 warn）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useGoalTracking, type GoalTracking } from '../client/useGoalTracking.ts';

interface RecordedCall { method: string }

function recordingRpc(snapshot: unknown) {
  const calls: RecordedCall[] = [];
  const handlers: Array<(type: string, args: unknown[]) => void> = [];
  return {
    calls,
    emit(type: string, args: unknown[]) { for (const h of handlers) h(type, args); },
    rpc: {
      call(method: string) {
        calls.push({ method });
        return Promise.resolve(snapshot);
      },
      onEvent(handler: (type: string, args: unknown[]) => void) {
        handlers.push(handler);
        return () => undefined;
      },
    },
  };
}

/** setup 内运行 composable 的 SSR 渲染（onUnmounted 语义完好） */
async function mountTracking(agentId: string, conv: string, snapshot: unknown) {
  const rec = recordingRpc(snapshot);
  let tracking!: GoalTracking;
  const app = createSSRApp(defineComponent({
    setup() {
      tracking = useGoalTracking(ref(agentId), ref(conv), rec.rpc as never);
      return () => h('div');
    },
  }));
  await renderToString(app);
  return { ...rec, tracking };
}

const CONV = 'a1~user';
const goalSnapshot = { goal: { current: { objective: '推进迁移', status: 'active', history: [] } } };

describe('useGoalTracking（cr-976 B 案帧族刷新——cr-1143）', () => {
  it('tool/result：name=goal 直调帧（无 subcall 标记）触发刷新', async () => {
    const t = await mountTracking('a1', CONV, goalSnapshot);
    await new Promise((r) => setTimeout(r, 10)); // 首拉（watch immediate）
    expect(t.tracking.goal.value?.objective).toBe('推进迁移');
    t.calls.length = 0;
    t.emit('tool/result', [{ name: 'goal', conversationId: CONV }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.calls.filter((c) => c.method === 'goal/get')).toHaveLength(1);
  });

  it('run/settled：同桶收束兜底触发刷新', async () => {
    const t = await mountTracking('a1', CONV, goalSnapshot);
    await new Promise((r) => setTimeout(r, 10));
    t.calls.length = 0;
    t.emit('run/settled', [{ conversationId: CONV, finish: 'stop' }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.calls.filter((c) => c.method === 'goal/get')).toHaveLength(1);
  });

  it('他人桶 / name 非 goal → 不触发', async () => {
    const t = await mountTracking('a1', CONV, goalSnapshot);
    await new Promise((r) => setTimeout(r, 10));
    t.calls.length = 0;
    t.emit('tool/result', [{ name: 'goal', conversationId: 'b2~user' }]);
    t.emit('tool/result', [{ name: 'read', conversationId: CONV }]);
    t.emit('run/settled', [{ conversationId: 'b2~user' }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.calls).toHaveLength(0);
  });
});
