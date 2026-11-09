// @vitest-environment jsdom
// ============================================================
// ask-draft-reactive.test.ts —— 作答草稿响应式回归（cr-960 根修）
// 根因：3d716a72 把 InteractionBar 作答草稿从 ref 改为 draftsByCard
// 普通 Map + computed 视图——computed 依赖仅 interaction.value，草稿对象
// 是普通对象，onCustomInput/choose 改字段不触发任何响应式更新 → answered
// computed 首算后缓存恒 false：填自定义回答后 Enter 报「请选择一个选项或
// 填写自定义回答」+ 提交按钮恒灰。修复 = 草稿入 Map 前 reactive() 包装。
// 挂载真实组件（setClientRuntime 注入真实 chat-core + recordingRpc），
// 驱动输入事件走完整响应链，不 mock 组件内部实现。
// ============================================================
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { RosterCore } from 'ac-client-ui-agents/client';
import { setClientRuntime, resetClientRuntime } from 'ac-client-runtime';
import InteractionBar from '../client/InteractionBar.vue';
import { VIEWER_ID } from '../client/viewer.ts';
import { bucketKey } from '../client/feed.ts';

let feedCore: typeof import('../client/feed-core.ts');
let chatCore: typeof import('../client/chat-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  chatCore = await import('../client/chat-core.ts');
});

const convKey = () => bucketKey(VIEWER_ID.value, 'alpha');

function recordingRpc() {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const eventHandlers: Array<(type: string, args: unknown[]) => void> = [];
  return {
    calls,
    eventHandlers,
    call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method === 'agents/list') return Promise.resolve({ agents: [{ id: 'alpha' }] });
      if (method === 'conversation/stats') return Promise.resolve({ running: [] });
      if (method === 'interaction/list') return Promise.resolve({ interactions: [] });
      return Promise.resolve({});
    },
    onEvent(handler: (type: string, args: unknown[]) => void) {
      eventHandlers.push(handler);
      return () => undefined;
    },
    onOpen() { return () => undefined; },
    onAck() { return () => undefined; },
  };
}

function openedFrame(id: string, createdAt: number, question: string, multi = false) {
  return {
    id, kind: 'ask_questions', key: convKey(), owner: 'alpha', createdAt,
    questions: [{ question, options: ['是', '否'], ...(multi ? { multi: true } : {}) }],
  };
}

/** 挂载真实 InteractionBar：chatStore 经 setClientRuntime 绑到真实 chat-core
 *  （recordingRpc 桩传输），事件驱动 opened 帧入列——与 app 内同构。 */
async function mountBar() {
  const rpc = recordingRpc();
  const roster = new RosterCore();
  roster.bindRpc(rpc as never);
  const feed = feedCore.createFeedCore(rpc as never, () => roster);
  const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => roster);
  core.init();
  roster.selectAgent('alpha');
  await new Promise((r) => setTimeout(r, 30));
  setClientRuntime({ sessions: { chat: core } } as never);
  const pinia = createPinia();
  setActivePinia(pinia);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(InteractionBar) });
  app.use(pinia);
  app.mount(root);
  await nextTick();
  return { rpc, core, root, app };
}

afterEach(() => { resetClientRuntime(); });

describe('InteractionBar 作答草稿响应式（cr-960）', () => {
  it('填自定义回答后主按钮解禁、Enter 提交（不再误报"请选择一个选项"）', async () => {
    const { rpc, root, app } = await mountBar();
    try {
      for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-1', 1000, '选一个')]);
      await new Promise((r) => setTimeout(r, 10));
      await nextTick();
      const primary = () => root.querySelector<HTMLButtonElement>('.ib-actions .ib-btn.primary')!;
      // 未作答：主按钮禁用
      expect(primary().disabled).toBe(true);
      // 填自定义回答（受控 input 的 input 事件——onCustomInput 写草稿 custom）
      const input = root.querySelector<HTMLInputElement>('.ib-custom-input')!;
      input.value = '自定义答案甲';
      input.dispatchEvent(new Event('input'));
      await nextTick();
      // 草稿字段变化必须触发 answered 重算（修复前：普通对象 → 恒 false）
      expect(primary().disabled).toBe(false);
      expect(root.textContent).not.toContain('请选择一个选项');
      // Enter 提交（onCustomKeydown → continueFlow → submitAll）
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await new Promise((r) => setTimeout(r, 20));
      const reply = rpc.calls.find((c) => c.method === 'interaction/reply');
      expect(reply?.params?.id).toBe('dur-1');
      expect((reply?.params?.answer as { answers: string[] }).answers).toEqual(['自定义答案甲']);
    } finally {
      app.unmount();
      root.remove();
    }
  });

  it('多选末题勾选→主按钮解禁（selected 数组同样走响应链）', async () => {
    const { rpc, root, app } = await mountBar();
    try {
      for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-2', 2000, '勾选', true)]);
      await new Promise((r) => setTimeout(r, 10));
      await nextTick();
      const primary = () => root.querySelector<HTMLButtonElement>('.ib-actions .ib-btn.primary')!;
      expect(primary().disabled).toBe(true);
      const optA = Array.from(root.querySelectorAll('.ui-opt')).find((el) => el.textContent?.includes('是'))!;
      optA.dispatchEvent(new MouseEvent('click'));
      await nextTick();
      // 多选不翻页、停留本题——answered 必须即时反映勾选（修复前：普通数组
      // push 不触发 → 恒禁用，Enter 直接误报"请至少勾选一项"）
      expect(primary().disabled).toBe(false);
      primary().click();
      await new Promise((r) => setTimeout(r, 20));
      const reply = rpc.calls.find((c) => c.method === 'interaction/reply');
      // 多选题答案 = 勾选项数组（submitAll：q.multi → selected 整组提交）
      expect((reply?.params?.answer as { answers: string[][] }).answers).toEqual([['是']]);
    } finally {
      app.unmount();
      root.remove();
    }
  });
});
