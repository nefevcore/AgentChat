// @vitest-environment jsdom
// ============================================================
// subagent-view-refresh.test.ts —— 子会话视角刷新驱动回归（cr-752）
//
// 根因形态：视角组件刷新 watch 曾押 jobBoard kind=subagent 条目——
// preview 生产链（ShellSubagentService）从不向 jobs 注册表登记，
// watch 永不触发，子 Agent 收束后思考过程不重拉（须手动刷新）。
// 回归锁：subagentBoard 投影 displayStatus 回落（running → done）
// 即重拉 subagents/history；恒 running 不重拉。
// 真 vue 渲染（项目惯例 createApp 直 mount——@vue/test-utils 不可用）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createPinia } from 'pinia';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime/src/vue.ts';
import SubagentConversationView from '../client/SubagentConversationView.vue';
import type { SubagentBoardService } from '../client/board.ts';

/** rpc 桩：只应答 subagents/history，计数调用 */
function rpcStub() {
  const state = { calls: 0 };
  return {
    state,
    call: async (method: string) => {
      if (method !== 'subagents/history') throw new Error('unexpected rpc: ' + method);
      state.calls += 1;
      return { records: [], hasMore: false };
    },
  };
}

/** subagentBoard 桩：subs 投影可变（帧驱动形态） */
function boardStub(subs: { subId: string; displayStatus: string }[]): { board: SubagentBoardService; subs: typeof subs } {
  const r = ref(subs);
  const board = {
    subs: r,
    stopping: ref(new Set<string>()),
    ensureStarted: () => {},
    refresh: async () => {},
    stop: async () => {},
  } as unknown as SubagentBoardService;
  return { board, subs: subs } as never;
}

const unmounts: Array<() => void> = [];
afterEach(() => { for (const off of unmounts.splice(0)) off(); });

function mountView(ctx: Record<string, unknown>): void {
  // 桩 ctx 断言（ClientContext 全量面只用到 rpc/subagentBoard 两键）
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp({ render: () => h(SubagentConversationView, { subId: 'sub-x', name: 't', parentId: 'p' }) });
  app.use(createPinia());
  app.provide(CLIENT_CONTEXT_KEY, ctx as never);
  app.mount(el);
  unmounts.push(() => { app.unmount(); el.remove(); });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('cr-752 · 子会话视角刷新驱动（subagentBoard.displayStatus）', () => {
  it('displayStatus 回落（running → done）重拉 subagents/history；恒 running 不重拉', async () => {
    const rpc = rpcStub();
    const subs = ref([{ subId: 'sub-x', displayStatus: 'running' }]);
    const board = {
      subs,
      stopping: ref(new Set<string>()),
      ensureStarted: () => {},
      refresh: async () => {},
      stop: async () => {},
    };
    mountView({ rpc, subagentBoard: board });
    await settle();
    expect(rpc.state.calls).toBe(1); // 首载一次
    subs.value = [{ subId: 'sub-x', displayStatus: 'running' }];
    await nextTick();
    await settle();
    expect(rpc.state.calls).toBe(1); // 恒 running 不重拉
    subs.value = [{ subId: 'sub-x', displayStatus: 'done' }];
    await nextTick();
    await settle();
    expect(rpc.state.calls).toBe(2); // 收束回落 → 重拉
  });
});