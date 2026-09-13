// ============================================================
// tests/interaction-mount-crash.test.ts —— InteractionBar 挂载崩溃回归
//
// 背景（2026-09-12 反馈，控制台实锤）：
//   [slots] entry 崩溃退位：conversation:dock-widget#interaction
//   TypeError: Cannot read properties of undefined (reading 'custom')
//   at InteractionBar (i.value[n.value].custom —— drafts[index].custom)
//
// 根因：watch(interaction) 缺 immediate——【恢复路径】下 dock 卡是
// defineAsyncComponent，挂载完成时 store.interaction 已非空（刷新恢复
// interaction/list 先到 / live opened 已入列），watch 不触发 → drafts
// 恒为空数组 → 模板 v-model="drafts[index]!.custom" 读 undefined.custom
// 崩溃 → slot 错误边界把 interaction 卡【永久退位】——此后所有提问都不再
// 显示，只能重启后端（用户视角：刷新后无法继续回答 + 连弹窗都不出现）。
//
// 本测试用真 vue 渲染（@vue/test-utils 不可用——项目用 vitest + vue 插件
// 直接 mount）钉住：挂载时 interaction 已就位 → 弹窗正常渲染不崩溃。
// ============================================================
import { describe, it, expect, vi } from 'vitest';

// ---- chatStore 面 mock（InteractionBar 消费的最小面） ----
const interactionRef = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('ac-client-ui-conversation/client/chatStore.ts', () => ({
  useChatStore: () => ({
    get interaction() { return interactionRef.value; },
    resolveContext: () => ({ kind: 'pair', agentId: 'helper' }),
    dismissInteraction: vi.fn(),
    respondInteraction: vi.fn(),
  }),
}));

import { createApp, h, nextTick } from 'vue';
import InteractionBar from 'ac-client-ui-conversation/client/InteractionBar.vue';

/** 挂载 InteractionBar（jsdom 缺省 document 需 node 环境用 SSR 渲染字符串） */
async function renderToString(component: unknown): Promise<{ html: string; error: unknown }> {
  let error: unknown = null;
  const app = createApp({
    render: () => h(component as never),
    errorCaptured(err: unknown) { error = err; return false; },
  });
  // node 环境：用渲染器直渲（无 DOM）
  const { renderToString } = await import('vue/server-renderer');
  let html = '';
  try {
    html = await renderToString(app);
  } catch (err) {
    error = err;
  }
  return { html, error };
}

describe('InteractionBar 挂载崩溃回归（watch immediate 修复）', () => {
  it('挂载时 interaction 已就位（恢复路径）：drafts 初始化，不崩（修复前 drafts 恒空 → drafts[0].custom TypeError）', async () => {
    interactionRef.value = {
      interaction_id: 'dur-mount-1',
      agent_id: 'helper',
      key: 'user~helper',
      created_at: Date.now(),
      questions: [{ question: '选哪个？', options: ['A', 'B'] }],
      allow_custom: true,
      timeout_ms: 0,
    };
    const { html, error } = await renderToString(InteractionBar);
    // 修复前：渲染抛 TypeError（reading 'custom'）
    expect(error).toBeNull();
    // 弹窗主体渲染出来（问题与选项可见）
    expect(html).toContain('选哪个？');
    expect(html).toContain('或输入其他回答');
    expect(html).toContain('提交回答');
  });

  it('挂载时 interaction 为空（live 路径首渲染）：不渲染主体，无异常', async () => {
    interactionRef.value = null;
    const { html, error } = await renderToString(InteractionBar);
    expect(error).toBeNull();
    expect(html).not.toContain('选哪个？');
  });
});
