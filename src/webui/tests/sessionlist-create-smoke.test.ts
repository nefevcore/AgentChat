// @vitest-environment jsdom
// ============================================================
// webui/tests/sessionlist-create-smoke.test.ts —— 新建按钮点击链路冒烟（cr-212 后用户反馈「点击无反应」）
// 手法与 session-list-buckets 相同：桩 ctx 孤立挂载。断言点击 create-btn 会走到
// singleBoard.createQuick / create——定位问题在组件事件层还是 RPC 层。
// ============================================================
import { describe, it, expect } from 'vitest';
import { createApp, nextTick, provide, h, ref, type App } from 'vue';
import { createPinia } from 'pinia';
import SessionList from 'ac-client-ui-singles/client/SessionList.vue';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime';
import type { ClientContext } from 'ac-client-runtime';

describe('SessionList 新建按钮点击链路（冒烟）', () => {
  it('点击 create-btn → createQuick 被调用', async () => {
    let quickCalls = 0;
    const ctx = {
      rpc: null,
      singleBoard: {
        activeSingles: ref([]),
        activeSingleId: ref(''),
        refresh: () => Promise.resolve(),
        selectSingle: () => {},
        titleOf: (s: { title: string }) => s.title,
        create: () => Promise.resolve({ single: null }),
        createQuick: () => { quickCalls++; return Promise.resolve({ single: null }); },
        remove: () => Promise.resolve(),
      },
      workspaceBoard: {
        workspaces: ref([]),
        refresh: () => Promise.resolve(),
        create: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        rename: () => Promise.resolve(),
      },
    } as unknown as ClientContext;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app: App = createApp({
      setup() {
        provide(CLIENT_CONTEXT_KEY, ctx);
        return () => h(SessionList);
      },
    });
    app.use(createPinia());
    app.mount(root);
    await nextTick();
    const btn = root.querySelector('.create-btn') as HTMLButtonElement | null;
    expect(btn, 'create-btn 应渲染').toBeTruthy();
    btn!.click();
    await nextTick();
    await new Promise(r => setTimeout(r, 0));
    expect(quickCalls, '点击应触发 createQuick（未挂工作区、无偏好路径）').toBe(1);
    app.unmount();
    root.remove();
  });
});
