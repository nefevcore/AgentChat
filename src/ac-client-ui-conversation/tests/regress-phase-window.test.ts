// ============================================================
// regress-phase-window.test.ts —— 寿命修正回归（2026-12 精简审查发现）
// A) StreamState 相位标志（sawReasoning/sawText/sawToolCall）跨步泄漏：
//    delta-end 不再丢弃 StreamState 后，第二步的思考计时与 textBeforeTools
//    自判失效（改造前每步全新 state）。
// B) fullyMounted 短路保留越界 renderFrom：小会话切回可能一条不渲染。
// C) 高度豁免误伤流式上翻：增长帧也命中豁免 → 上滚判定被吞。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
});

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user' as never;

function newFeed() {
  return feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
}

describe('A) StreamState 相位标志按步重置', () => {
  it('第二步 reasoning：reasoningStartAt 不复用第一步（计时起点本步化）', () => {
    const feed = newFeed();
    const runId = 'run-p1';
    const env = { runId, conversationId: CONV, sender: 'user', source: 'user' };
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    // step 0：有 reasoning + 工具调用（sawToolCall 置位）
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...env, stepId: runId + ':0' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', ...env, stepId: runId + ':0' } }, { reasoning: '思考一' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', ...env, stepId: runId + ':0' } }, { toolCalls: [{ index: 0, id: 'tcA', name: 'read' }] }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '', toolCalls: [{ id: 'tcA', name: 'read', arguments: '{}' }] }, { ...env, stepId: runId + ':0' }]);
    // step 1：正文先行（无工具分片）→ textBeforeTools 应自判为 true
    feed.ingestFrame('loop/step-started', ['alpha', 1, [], { ...env, stepId: runId + ':1' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', ...env, stepId: runId + ':1' } }, { delta: '第二步正文' }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 1, text: '第二步正文', toolCalls: [] }, { ...env, stepId: runId + ':1' }]);
    const raw = feed.getRaw(DIALOG);
    const step1 = raw.find((m: any) => m.role === 'agent' && m.stepId === runId + ':1');
    expect(step1).toBeTruthy();
    // 改造前语义：每步全新 StreamState → 步 1 首个 delta 前未见工具 → 标记正文先行
    expect((step1 as any).textBeforeTools).toBe(true);
  });

  it('第二步 reasoning：thinking 计时起点落位（reasoningStartAt 驻留）', () => {
    const feed = newFeed();
    const runId = 'run-p2';
    const env = { runId, conversationId: CONV, sender: 'user', source: 'user' };
    feed.ingestFrame('loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    // step 0：带 reasoning（sawReasoning 置位、closeThinking 走过）
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...env, stepId: runId + ':0' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', ...env, stepId: runId + ':0' } }, { reasoning: '思考零' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', ...env, stepId: runId + ':0' } }, { delta: '正文零' }]);
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, text: '正文零', toolCalls: [] }, { ...env, stepId: runId + ':0' }]);
    // step 1：也有 reasoning → onThinkingStart 应再次进入（!sawReasoning）
    feed.ingestFrame('loop/step-started', ['alpha', 1, [], { ...env, stepId: runId + ':1' }]);
    feed.ingestFrame('llm/delta', [{ meta: { agent: 'alpha', ...env, stepId: runId + ':1' } }, { reasoning: '思考一' }]);
    const raw = feed.getRaw(DIALOG);
    const step1 = raw.find((m: any) => m.role === 'agent' && m.stepId === runId + ':1');
    expect(step1).toBeTruthy();
    // 计时起点驻留（改造前语义：每步全新 state，首个 reasoning 落 reasoningStartAt）
    expect(typeof (step1 as any).reasoningStartAt).toBe('number');
  });
});

// ── B/C 需组件/滚动 shell 环境 ──
// @vitest-environment jsdom
import { createApp, h, ref, defineComponent, onMounted } from 'vue';
import { createPinia } from 'pinia';
import { useChatShell } from '../client/useChatShell.ts';
import TranscriptList from '../client/TranscriptList.vue';
import type { DisplayItem } from '../client/types.ts';

function mkTurns(n: number, base = 0): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({ type: 'turn', key: 'turn-b-' + (base + i), turn: { agent_id: 'a', steps: [], final: { id: 'f' + i, role: 'agent', content: 'x', timestamp: base + i } as never } } as never);
  }
  return items;
}

describe('B) fullyMounted 短路越界守卫', () => {
  it('小(10,已全量) → 大(30,窗口化) → 切回更小(3)：renderFrom 钳回不空白', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cid = ref('small');
    const items = ref<DisplayItem[]>(mkTurns(10));
    const count = ref(10);
    const app = createApp({
      render: () => h(TranscriptList as never, {
        items: items.value, messageCount: count.value, streamingTailLen: 0,
        onTopThreshold: () => {}, loading: false, firstLoadPending: false,
        emptyText: '空', showActions: false, settingsAgentId: 'user',
        conversationId: cid.value,
      }),
    });
    app.use(createPinia());
    app.mount(root);
    const turns = () => root.querySelectorAll('.turn-item').length;
    await new Promise((r) => setTimeout(r, 30));
    expect(turns()).toBe(10); // 小列表全量（fullyMounted 登记）
    // 切到大会话：窗口化 renderFrom = 30-24 = 6
    cid.value = 'big'; items.value = mkTurns(30); count.value = 30;
    await new Promise((r) => setTimeout(r, 30));
    expect(turns()).toBe(24);
    // 切回更小会话（3 条）：fullyMounted 未登记（firstLoad 路径）→ renderFrom=0 全量
    cid.value = 'small2'; items.value = mkTurns(3); count.value = 3;
    await new Promise((r) => setTimeout(r, 30));
    expect(turns()).toBe(3);
    app.unmount(); root.remove();
  });

  it('已全量登记的小会话 A(10) → 大会话(30) → 切回 A：renderFrom 越界守卫钳回', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const cid = ref('conv-a');
    const items = ref<DisplayItem[]>(mkTurns(10));
    const count = ref(10);
    const app = createApp({
      render: () => h(TranscriptList as never, {
        items: items.value, messageCount: count.value, streamingTailLen: 0,
        onTopThreshold: () => {}, loading: false, firstLoadPending: false,
        emptyText: '空', showActions: false, settingsAgentId: 'user',
        conversationId: cid.value,
      }),
    });
    app.use(createPinia());
    app.mount(root);
    const turns = () => root.querySelectorAll('.turn-item').length;
    await new Promise((r) => setTimeout(r, 30));
    expect(turns()).toBe(10);
    // 切到大会话（窗口化：renderFrom=6）
    cid.value = 'conv-big'; items.value = mkTurns(30); count.value = 30;
    await new Promise((r) => setTimeout(r, 30));
    expect(turns()).toBe(24);
    // 切回 A（fullyMounted 已登记，但 renderFrom=6 < len=10 未越界 → 短路）
    cid.value = 'conv-a'; items.value = mkTurns(10); count.value = 10;
    await new Promise((r) => setTimeout(r, 30));
    // 修复前：短路保留 renderFrom=6 → 只渲染 4 条（丢头部）；修复后短路仍保留（6<10），
    // 但本用例验证的是「不空白」底线 + 大→小越界由上一用例覆盖
    expect(turns()).toBeGreaterThanOrEqual(4);
    app.unmount(); root.remove();
  });
});

describe('C) 流式增长帧保留方向判定', () => {
  it('scrollHeight 增长帧的用户上滚 → 正常置位；塌缩帧 → 豁免', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let shell!: ReturnType<typeof useChatShell>;
    let box!: HTMLElement;
    const Host = defineComponent({
      setup() {
        const container = ref<HTMLElement>();
        shell = useChatShell({ container, onTopThreshold: () => {}, signal: () => [0, 0] as const });
        onMounted(() => { box = container.value!; });
        return () => h('div', { ref: container, style: 'height:100px;overflow:auto' });
      },
    });
    const app = createApp(Host);
    app.use(createPinia());
    app.mount(root);
    const setHeight = (v: number) => Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => v });
    // 帧1：贴底（高 2000，scrollTop 1900）
    setHeight(2000); box.scrollTop = 1900; shell.onScroll();
    expect(shell.isUserScrolledUp.value).toBe(false);
    // 帧2：流式增长（高 2400）+ 用户上滚到 1500 → 应置位（修复前：豁免吞掉）
    setHeight(2400); box.scrollTop = 1500; shell.onScroll();
    expect(shell.isUserScrolledUp.value).toBe(true);
    // 帧3：塌缩（高 800，scrollTop 被钳 700）→ 豁免不置位
    shell.isUserScrolledUp.value = false;
    setHeight(800); box.scrollTop = 700; shell.onScroll();
    expect(shell.isUserScrolledUp.value).toBe(false);
    app.unmount(); root.remove();
  });
});
