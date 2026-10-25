// @vitest-environment jsdom
// ============================================================
// session-list-pending-badge.test.ts —— 会话列表待答徽标（cr-684）
//
// pending ask_questions 只在其所属会话内弹窗（key 路由），列表无标记
// 时用户不知道去哪答（两次实锤现场）。验收：命中 key 的会话行显示
// 「待答」徽标，未命中不显示；pending 清空后徽标消失。
// 手法：session-list-buckets 同款（stub ctx + pinia 挂载）+ vi.mock
// chatStore（interaction-mount-crash 同款拦截——chat-core 真面另有
// 测试族覆盖，此处只验列表消费面）。
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp, nextTick, provide, h, reactive, ref, computed, type App } from 'vue';
import { CLIENT_CONTEXT_KEY } from 'ac-client-runtime';
import type { ClientContext } from 'ac-client-runtime';

const pending = ref<Array<{ interaction_id: string; key?: string }>>([]);
// reactive 包装：computed 属性访问即解包（与真 pinia store 的 ref 解包同形）
const store = reactive({ pendingInteractions: computed(() => pending.value) });
vi.mock('ac-client-ui-conversation/client/chatStore.ts', () => ({
  useChatStore: () => store,
}));

import SessionList from 'ac-client-ui-singles/client/SessionList.vue';

function makeCtx(): ClientContext {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  return {
    rpc: null,
    singleBoard: {
      activeSingles: ref([
        { id: 's-ask', title: 's-ask', agentId: '', status: 'active', workspaceId: 'ws-a', lastActivity: iso, createdAt: iso },
        { id: 's-plain', title: 's-plain', agentId: '', status: 'active', workspaceId: 'ws-a', lastActivity: iso, createdAt: iso },
      ]),
      activeSingleId: ref(''),
      refresh: () => Promise.resolve(),
      selectSingle: () => {},
      titleOf: (s: { title: string }) => s.title,
      create: () => Promise.resolve({ single: null }),
      createQuick: () => Promise.resolve({ single: null }),
      remove: () => Promise.resolve(),
    },
    workspaceBoard: {
      workspaces: ref([{ id: 'ws-a', name: '项目甲', path: 'C:/proj/a' }]),
      refresh: () => Promise.resolve(),
      create: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      rename: () => Promise.resolve(),
    },
  } as unknown as ClientContext;
}

let app: App | null = null;
async function mountSessionList(): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  app = createApp({ setup() { provide(CLIENT_CONTEXT_KEY, makeCtx()); return () => h(SessionList); } });
  const { createPinia } = await import('pinia');
  app.use(createPinia());
  app.mount(root);
  await nextTick();
  return root;
}

beforeEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  localStorage.clear();
  pending.value = [];
});

function rowOf(root: HTMLElement, id: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('.list-item')].find((el) => el.textContent?.includes(id));
}

describe('SessionList 待答徽标（cr-684）', () => {
  it('pending key 命中的会话行显示「待答」徽标，未命中的行不显示', async () => {
    pending.value = [{ interaction_id: 'dur-1', key: 's-ask' }];
    const root = await mountSessionList();
    expect(rowOf(root, 's-ask')?.querySelector('.pending-ask-badge')?.textContent).toBe('待答');
    expect(rowOf(root, 's-plain')?.querySelector('.pending-ask-badge')).toBeNull();
  });

  it('作答/关闭后（pending 清空）徽标响应式消失', async () => {
    pending.value = [{ interaction_id: 'dur-1', key: 's-ask' }];
    const root = await mountSessionList();
    expect(rowOf(root, 's-ask')?.querySelector('.pending-ask-badge')).not.toBeNull();
    pending.value = [];
    await nextTick();
    expect(rowOf(root, 's-ask')?.querySelector('.pending-ask-badge')).toBeNull();
  });

  it('无 key 的旧载荷不点亮任何会话行（key 路由语义——回落 agent 匹配只在弹窗面）', async () => {
    pending.value = [{ interaction_id: 'dur-2' }];
    const root = await mountSessionList();
    expect(root.querySelector('.pending-ask-badge')).toBeNull();
  });
});
