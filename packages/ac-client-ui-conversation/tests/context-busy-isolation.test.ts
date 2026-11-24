// ============================================================
// context-busy-isolation.test.ts —— 输入框忙态隔离（cr-1303）
//
// 回归锁：contextBusy 只认**当前活跃会话**的 per-dialog 流式态——
// 全局 turnInProgress 被任何会话的 run 点亮，无活跃会话时回落它会让
// 输入框误显「停止」（点主按钮走 interruptGeneration 而非 send，消息
// 发不出去）。真机实证：creator run 在跑时 designer 会话输入框恒 stopping。
// ============================================================
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { createChatCore } from 'ac-client-ui-conversation/client/chat-core.ts';
import type { FeedView } from 'ac-client-ui-conversation/client/feed-core.ts';

function mockFeed(opts: { activeDialogId: string | null; dialogs?: Record<string, { streaming: boolean }>; turnInProgress?: boolean }) {
  return {
    turnInProgress: ref(opts.turnInProgress ?? false),
    loadingHistory: ref(false),
    hasMoreHistory: ref(false),
    lastStepEndAt: ref(0),
    archivePending: ref(false),
    activeDialogId: opts.activeDialogId,
    activeSingleId: null,
    getDialog: (id: string) => (opts.dialogs ?? {})[id] ?? null,
    getRaw: () => [],
    setRaw: () => {},
  } as unknown as FeedView & Record<string, unknown>;
}

function build(feed: ReturnType<typeof mockFeed>) {
  const rpc = { call: () => Promise.resolve({}), onEvent: () => () => {} };
  return createChatCore(feed, rpc as never, () => ({
    activeAgentId: ref('a1'),
    defaultPresetId: ref(''),
    bumpAgent: () => {},
  }) as never);
}

describe('contextBusy 会话隔离（cr-1303）', () => {
  it('无活跃会话时不读全局 turnInProgress（其他会话 run 不污染输入框）', () => {
    const core = build(mockFeed({ activeDialogId: null, turnInProgress: true }));
    expect(core.turnInProgress.value).toBe(true); // 全局确实在跑
    expect(core.contextBusy.value).toBe(false);   // 但输入框不显示停止
  });

  it('有活跃会话时只认该会话 streaming（别的会话跑不影响）', () => {
    const core = build(mockFeed({
      activeDialogId: 'pair:a1|user',
      turnInProgress: true,
      dialogs: { 'pair:a1|user': { streaming: false } },
    }));
    expect(core.contextBusy.value).toBe(false);
  });

  it('活跃会话自身流式中 → 忙态（正常路径不受影响）', () => {
    const core = build(mockFeed({
      activeDialogId: 'pair:a1|user',
      turnInProgress: true,
      dialogs: { 'pair:a1|user': { streaming: true } },
    }));
    expect(core.contextBusy.value).toBe(true);
  });
});
