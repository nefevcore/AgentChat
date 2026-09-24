// ============================================================
// transcript-remount.test.ts —— 窗口化挂载 + 重挂/重入路径验证（2026-12 大会话切换卡顿收口）
// ① 首载/切入只挂尾部 INITIAL_WINDOW 条，不自动补挂；
// ② 重挂组件（视角切换语义：新实例 + items 已就位）→ 窗口化（不全量）；
// ③ 同实例切走再切回已完整挂载的会话 → 短路保持（零重建）。
// ============================================================
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createApp, h, ref, nextTick } from 'vue';
import { createPinia } from 'pinia';
import TranscriptList from '../client/TranscriptList.vue';
import type { DisplayItem } from '../client/types.ts';

function mkItems(n: number, base = 0): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push({ type: 'turn', key: 'turn-a-' + (base + i), turn: { agent_id: 'a', steps: [], final: { id: 'f' + i, role: 'agent', content: 'x', timestamp: base + i } as never } } as never);
  }
  return items;
}

async function mountList(initial: { cid: string; items: DisplayItem[] }) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const cid = ref(initial.cid);
  const items = ref(initial.items);
  const count = ref(initial.items.length);
  const app = createApp({
    render: () => h(TranscriptList as never, {
      items: items.value,
      messageCount: count.value,
      streamingTailLen: 0,
      onTopThreshold: () => {},
      loading: false,
      firstLoadPending: false,
      emptyText: '空',
      showActions: false,
      settingsAgentId: 'user',
      conversationId: cid.value,
    }),
  });
  app.use(createPinia());
  app.mount(root);
  return {
    root, cid, items, count,
    unmount: () => { app.unmount(); root.remove(); },
    turns: () => root.querySelectorAll('.turn-item').length,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('TranscriptList 窗口化挂载', () => {
  it('① 首载（0→30）只挂尾部 24 条；不自动补挂', async () => {
    const t = await mountList({ cid: 'conv-a', items: [] });
    await nextTick();
    expect(t.turns()).toBe(0);
    t.items.value = mkItems(30);
    t.count.value = 30;
    await nextTick();
    expect(t.turns()).toBe(24);
    await sleep(60);
    expect(t.turns()).toBe(24); // 无交互不补挂
    t.unmount();
  });

  it('② 重挂组件（视角切换语义）items 已就位 → 仍窗口化（非全量）', async () => {
    const big = mkItems(30);
    const t = await mountList({ cid: 'conv-a', items: big }); // 挂载即有数据（immediate 路径）
    await nextTick();
    expect(t.turns()).toBe(24); // 不因「挂载时已在」而全量（旧缺陷：800+ 条单帧）
    t.unmount();
  });

  it('③ 同实例切走再切回（fullyMounted 短路不适用：未完整挂载）→ 仍窗口化', async () => {
    const big = mkItems(30);
    const t = await mountList({ cid: 'conv-a', items: [] });
    await nextTick();
    t.items.value = big;
    t.count.value = 30;
    await nextTick();
    expect(t.turns()).toBe(24);
    // 切走（清空）
    t.cid.value = 'conv-b';
    t.items.value = [];
    t.count.value = 0;
    await nextTick();
    expect(t.turns()).toBe(0);
    // 切回（firstLoad 路径——本会话未完整挂载过）→ 窗口化
    t.cid.value = 'conv-a';
    t.items.value = big;
    t.count.value = 30;
    await nextTick();
    expect(t.turns()).toBe(24);
    t.unmount();
  });
});