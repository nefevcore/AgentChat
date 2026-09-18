// @vitest-environment jsdom
// ============================================================
// webui/tests/system-prompt-preview-refresh.test.ts —— System Prompt
// 预览随会话工具调用模式切换重取（2026-12 预览失真修复）
//
// 程序化模式（tc-* 会话覆盖）改变 system prompt 装配面（SDK 投影块
// 注入/指引块收窄）。后端干跑已按会话模式收窄（admin 侧）；本测试锁
// 前端链路：ChatInput 写口成功 → chatStore.convToolMode bump →
// 常驻 aux 面板（keepAlive——边聊边看场景）与打开中的 modal 即时重取。
// chatStore 面 mock（项目惯例，参照 interaction-mount-crash.test.ts；
// 注意组件用相对说明符 './chatStore.ts' 导入——mock 路径须与之一致）。
// ============================================================
import { describe, it, expect, vi } from 'vitest';

// ---- chatStore 面 mock（convToolMode 真 Vue ref——被测 watch 的响应式
//      依赖必须可追踪；普通 getter 不触发 watch。requestSystemPrompt
//      计数器断言重取发生）----
const state = vi.hoisted(() => ({
  convToolMode: { value: '' as string }, // 占位（真 ref 于工厂内换装）
  promptOpen: { value: false },
  requests: 0,
  refs: null as null | { convToolMode: { value: string }; promptOpen: { value: boolean } },
}));
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<Record<string, unknown>>();
  const { ref } = vue as { ref: <T>(v: T) => { value: T } };
  state.refs = {
    convToolMode: ref(''),
    promptOpen: ref(false),
  };
  return vue;
});
vi.mock('ac-client-ui-conversation/client/chatStore.ts', () => ({
  useChatStore: () => ({
    get convToolMode() { return state.refs!.convToolMode.value; },
    setConvToolMode: (v: string) => { state.refs!.convToolMode.value = v; },
    systemPromptContent: '旧模式装配的 prompt',
    systemPromptLoading: false,
    systemPromptError: '',
    requestSystemPrompt: (..._args: unknown[]) => { state.requests++; },
    clearSystemPrompt: vi.fn(),
    copyFeedback: false,
  }),
}));
// uiStore 面 mock（modal 的 visible 判定 + panel 的当选判定）
vi.mock('ac-client-ui-layout/client/uiStore.ts', () => ({
  useUiStore: () => ({
    get systemPromptOpen() { return state.refs!.promptOpen.value; },
    systemPromptAgentName: 'helper',
    openSystemPrompt: () => { state.refs!.promptOpen.value = true; },
    closeSystemPrompt: () => { state.refs!.promptOpen.value = false; },
    auxPanel: '',
    auxVisible: false,
    auxIntent: 0,
    auxIntentPanel: '',
    selectAuxPanel: vi.fn(),
    applyAuxPanelWidth: vi.fn(),
    openAux: vi.fn(),
  }),
}));
// roster 面 mock（Panel 的 agentId 解析链：回落 activeAgentId）
vi.mock('ac-client-ui-agents/client/rosterAccess.ts', () => ({
  useRosterCore: () => ({
    activeAgentId: { value: 'helper' },
    agents: { value: [] },
    presets: { value: [] },
    defaultPresetId: { value: '__standard__' },
    getAgentName: (id: string) => id,
  }),
}));

import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import SystemPromptPanel from 'ac-client-ui-conversation/client/SystemPromptPanel.vue';
import SystemPromptModal from 'ac-client-ui-conversation/client/SystemPromptModal.vue';

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await nextTick();
  await Promise.resolve();
}

async function mount(comp: unknown): Promise<() => void> {
  document.body.innerHTML = ''; // 隔离：清掉上个测试的挂载
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp({ render: () => h(comp as never) });
  app.use(createPinia());
  app.mount(root);
  await flush();
  return () => app.unmount(); // 卸载钩子：彻底停掉组件 watch（防跨测试触发）
}

describe('System Prompt 预览随模式切换重取', () => {
  it('aux 常驻面板：convToolMode bump → 重取（程序化 SDK 投影块可见）', async () => {
    state.requests = 0;
    state.refs!.convToolMode.value = '';
    const unmount = await mount(SystemPromptPanel);
    expect(state.requests).toBe(0); // 已有内容不重复请求（当选兜底不触发）
    state.refs!.convToolMode.value = 'tc-programmatic'; // ChatInput 写口成功后的 bump
    await flush();
    expect(state.requests).toBe(1); // 重取发生——新模式装配面（SDK 投影块）
    unmount();
  });

  it('modal：打开中 bump → 重取；关闭后 bump 不触发', async () => {
    state.requests = 0;
    state.refs!.convToolMode.value = '';
    state.refs!.promptOpen.value = false;
    const unmount = await mount(SystemPromptModal);
    expect(state.requests).toBe(0); // 关闭态不请求
    // 打开弹窗（ui.openSystemPrompt 的职责等价）
    state.refs!.promptOpen.value = true;
    await flush();
    // 关闭态 bump：不重取（open=false 时 watch 守卫拦截）
    state.refs!.promptOpen.value = false;
    await flush();
    state.refs!.convToolMode.value = 'tc-none';
    await flush();
    expect(state.requests).toBe(0);
    // 重新打开 + bump：重取
    state.refs!.promptOpen.value = true;
    await flush();
    state.refs!.convToolMode.value = 'tc-base';
    await flush();
    expect(state.requests).toBe(1);
    unmount();
  });
});
