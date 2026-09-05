// ============================================================
// archive-pending.test.ts —— 归档整理态对话面感知（2026-09-04 认知缺口）
//
// 机制 run（meta[archive-review]）流式被 ws-bridge 隐藏（不扰民），但
// 边界帧（run-started / after-run）对隐藏 run 恒广播——feed 据此维护
// "正在整理"集合；archivePending = 活跃对话是否整理中（输入框占位与
// 会话头状态条的信号源）。原全局 ref 从未置 true（死路径）一并收编。
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn(() => Promise.reject(new Error('no rpc in test'))),
    onWireEvent: vi.fn(() => () => {}),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => () => {}),
  },
}));
// node 环境无 window：logger 读取 LOG_LEVEL 会抛错（store 逻辑不受影响，仅降噪）
vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';

const A = 'alpha';
const META = { 'archive-review': true };

describe('归档整理态（边界帧驱动）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const feed = useFeedStore();
    feed.init();
    useAgentStore().activeAgentId = A; // 直写 ref，避开 lastContext 持久化副作用
  });

  it('run-started(meta archive-review) → archivePending 亮；after-run → 熄', () => {
    const feed = useFeedStore();
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: `${A}~user`, meta: META }]);
    expect(feed.archivePending).toBe(true);
    feed.ingestFrame('loop/after-run', [
      { agent: A, conversationId: `${A}~user`, meta: META },
      { finish: 'stop', text: '整理完成' },
    ]);
    expect(feed.archivePending).toBe(false);
  });

  it('普通 run 边界帧不点亮（仅机制标记 run）', () => {
    const feed = useFeedStore();
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: `${A}~user` }]);
    expect(feed.archivePending).toBe(false);
  });

  it('system/restarting 清空（断线/重启丢 after-run 帧的兜底）', () => {
    const feed = useFeedStore();
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: `${A}~user`, meta: META }]);
    expect(feed.archivePending).toBe(true);
    feed.ingestFrame('system/restarting', []);
    expect(feed.archivePending).toBe(false);
  });

  it('archivePending 跟随活跃对话（非全局）：切走熄灭、切回点亮', () => {
    const feed = useFeedStore();
    feed.ingestFrame('loop/run-started', [{ agent: A, conversationId: `${A}~user`, meta: META }]);
    expect(feed.archivePending).toBe(true);
    useAgentStore().activeAgentId = 'beta'; // 切换 → 活跃对话非整理中
    expect(feed.archivePending).toBe(false);
    useAgentStore().activeAgentId = A; // 切回 → 该对话仍在整理
    expect(feed.archivePending).toBe(true);
  });
});
