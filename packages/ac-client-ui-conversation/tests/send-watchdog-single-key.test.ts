// ============================================================
// send-watchdog-single-key.test.ts —— 发送看门狗判活键回归（cr-999）
// 根因两处：①single 分区权威键此前取 feed.activeAgentId || sessionId——
// 进入独立会话时 roster 选中被显式清空（SessionList.selectSingle），
// 回落 sessionId 匹配 stats.running[].agentId 恒 miss，30s 采样落进步
// 边界空窗（after-step 已关占位、下一步 delta 未到）即误杀活 run；
// ②stats RPC 失败按断链杀——探针/Dock 均不定罪，唯看门狗例外，网络
// 瞬断即闪红条。修复：single 键 = singleMeta 登记的目标 Agent；RPC
// 失败重新武装下一轮。
// ============================================================
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let chatCore: typeof import('../client/chat-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  chatCore = await import('../client/chat-core.ts');
});

/** single 分区：发送即点亮 streaming 的最小形态（ sendMessage 同款写口） */
function armedSingleFeed(rpc: { call(method: string, ...rest: unknown[]): Promise<unknown> }) {
  const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
  const dlg = 'single:ses-1' as never;
  feed.ensureById(dlg).streaming = true;
  return { feed, dlg };
}

describe('发送看门狗 single 判活键（cr-999 根因 ①）', () => {
  it('stats 权威命中（真实 agentId + sid）→ 不杀、重新武装', async () => {
    vi.useFakeTimers();
    try {
      // stats 按调用序应答：第 1 次 = setSingleContext 的 subscribeResume（回空，
      // 不合成 resume 快照——本用例验的是步边界空窗采样，分区无占位才成立）；
      // 之后 = 看门狗采样（回 running 命中）。
      let statsCalls = 0;
      const rpc = {
        call(method: string) {
          if (method === 'conversation/stats') {
            statsCalls++;
            if (statsCalls === 1) return Promise.resolve({ running: [] });
            return Promise.resolve({
              running: [{ agentId: 'alpha', conversationId: 'ses-1' }],
            });
          }
          return Promise.resolve({ records: [] });
        },
      };
      const { feed, dlg } = armedSingleFeed(rpc);
      const { reactive } = await import('vue');
      const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => new RosterCore());
      // 关键前置：single 激活登记目标 Agent，且 roster 选中为空（selectSingle 语义）
      core.setSingleContext('ses-1', 'alpha');
      expect(core.resolveContext()).toEqual({ kind: 'single', agentId: 'alpha', sessionId: 'ses-1' });
      core.sendMessage('hi');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(feed.getDialog(dlg)?.streaming).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('权威明确说不在跑（双空）→ 仍然杀（修复不弱化死行收敛）', async () => {
    vi.useFakeTimers();
    try {
      const rpc = { call() { return Promise.resolve({ running: [], spawning: [] }); } };
      const { feed, dlg } = armedSingleFeed(rpc);
      const { reactive } = await import('vue');
      const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => new RosterCore());
      core.setSingleContext('ses-1', 'alpha');
      core.sendMessage('hi');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(feed.getDialog(dlg)?.streaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('发送看门狗 RPC 失败不定罪（cr-999 根因 ②）', () => {
  it('stats 拒答 → 不杀、重新武装下一轮', async () => {
    vi.useFakeTimers();
    try {
      const rpc = {
        call(method: string) {
          if (method === 'conversation/stats') return Promise.reject(new Error('暂时不可达'));
          return Promise.resolve({});
        },
      };
      const { feed, dlg } = armedSingleFeed(rpc);
      const { reactive } = await import('vue');
      const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => new RosterCore());
      core.setSingleContext('ses-1', 'alpha');
      core.sendMessage('hi');
      // 两轮采样都拒答——分区态必须原样保留
      await vi.advanceTimersByTimeAsync(60_000);
      expect(feed.getDialog(dlg)?.streaming).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
