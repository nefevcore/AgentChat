// ============================================================
// archive-complete-routing.test.ts —— 归档完成帧按会话路由回归
//
// 背景 bug（2026-09 复核发现）：compressSession 放开独立会话（single）
// 后，完成处理 onSessionArchived 仍按 activeAgent() 对齐——single 视图
// activeAgentId 恒空（SessionList.selectSingle 清空），载荷 agentId ≠ ''
// 恒早退：
//   · compressPending 永不复位（L484 守卫 → 全 app 归档入口重启前锁死）；
//   · 完成反馈丢失、single 分区不刷新；
//   · activeAgent 恰等于会话 Agent 时重置/重载的是 1v1 对话分区（错分区）。
//
// 修复语义：archive/completed 载荷带 conversationId（ac-archive 收尾 emit），
// 按它路由：命中当前视图会话键（single sid / 1v1 对桶键）才反馈+重载；
// 手工触发的在途归档（pendingArchiveConv）即使切走视图也精确复位 pending；
// 无关会话（后台自动归档）的完成帧不打扰。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ method: string; params?: any; resolve: (v?: any) => void }> = [];
const wireHandlers: Array<(type: string, args: unknown[]) => void> = [];
vi.mock('../src/api/wire', () => ({
  wireRpc: {
    call: vi.fn((method: string, params?: any) => {
      let resolve!: (v?: any) => void;
      const promise = new Promise((r) => { resolve = r; });
      rpcCalls.push({ method, params, resolve });
      return promise;
    }),
    onWireEvent: vi.fn((h: (type: string, args: unknown[]) => void) => {
      wireHandlers.push(h);
      return () => {};
    }),
    onWireOpen: vi.fn(() => () => {}),
    onWireClose: vi.fn(() => () => {}),
    onWireAck: vi.fn(() => {}),
  },
}));
vi.mock('../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { setActivePinia, createPinia } from 'pinia';
import { useChatStore } from '../src/stores/chat';
import { useFeedStore } from '../src/stores/feed';
import { useAgentStore } from '../src/stores/agents';

const A = 'nana';
const SID = 's-single-1';

/** 触发/完成归档的便捷封装 */
function fireArchiveComplete(payload: Record<string, unknown>): void {
  for (const h of [...wireHandlers]) h('archive/completed', [payload]);
}
const historyCalls = () => rpcCalls.filter((c) => c.method === 'session/history');

describe('archive/completed 完成帧按 conversationId 路由', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    wireHandlers.length = 0;
    setActivePinia(createPinia());
    useFeedStore().init();
  });

  it('single 视图：完成帧复位 pending + 反馈 + 重载 single 分区（修复前恒早退）', () => {
    const chat = useChatStore();
    useAgentStore().activeAgentId = ''; // single 视图事实（SessionList 清空）
    chat.setSingleContext(SID, A);

    expect(chat.compressPending).toBe(false);
    void chat.compressSession();
    expect(chat.compressPending).toBe(true); // 触发受理：session/archive 带 sid
    expect(rpcCalls.at(-1)?.method).toBe('session/archive');
    expect(rpcCalls.at(-1)?.params).toMatchObject({ conversationId: SID, agentId: A });
    rpcCalls.at(-1)!.resolve({});

    // 完成帧：agentId=A ≠ activeAgent('') ——按 conversationId=SID 命中
    const before = historyCalls().length;
    fireArchiveComplete({ conversationId: SID, agentId: A, archived: 5, kept: 2 });
    expect(chat.compressPending).toBe(false); // ← 修复前：恒 true（早退不复位）
    expect(chat.compressFeedback).toContain('已归档 5 条');
    expect(historyCalls().length).toBeGreaterThan(before); // single 分区重载
    expect(historyCalls().at(-1)?.params).toMatchObject({ conversationId: SID });
  });

  it('无关会话（后台自动归档）的完成帧：不复位、不反馈、不重载', () => {
    const chat = useChatStore();
    useAgentStore().activeAgentId = ''; // single 视图事实（SessionList 清空）
    chat.setSingleContext(SID, A);
    void chat.compressSession();
    rpcCalls.at(-1)!.resolve({});

    const before = historyCalls().length;
    fireArchiveComplete({ conversationId: 'other~user', agentId: 'beta', archived: 9, kept: 0 });
    expect(chat.compressPending).toBe(true); // 手工归档仍在途——不误清
    expect(chat.compressFeedback).not.toContain('已归档');
    expect(historyCalls().length).toBe(before);

    // 本会话的完成帧到达才复位
    fireArchiveComplete({ conversationId: SID, agentId: A, archived: 3, kept: 1 });
    expect(chat.compressPending).toBe(false);
    expect(chat.compressFeedback).toContain('已归档 3 条');
  });

  it('pair 视图：完成帧按对桶键命中（agentId 对齐口径不再单独依赖）', () => {
    const chat = useChatStore();
    useAgentStore().activeAgentId = A;
    void chat.compressSession();
    expect(rpcCalls.at(-1)?.params).toMatchObject({ conversationId: `${A}~user`, agentId: A });
    rpcCalls.at(-1)!.resolve({});

    const before = historyCalls().length;
    fireArchiveComplete({ conversationId: `${A}~user`, agentId: A, archived: 0, kept: 7 });
    expect(chat.compressPending).toBe(false);
    expect(chat.compressFeedback).toContain('0 条移出'); // 0 条 = 未超水位文案
    expect(historyCalls().length).toBeGreaterThan(before);
    expect(historyCalls().at(-1)?.params).toMatchObject({ conversationId: `${A}~user` });
  });
});
