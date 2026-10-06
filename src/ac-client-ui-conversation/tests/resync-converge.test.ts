// ============================================================
// resync-converge.test.ts —— remote/resync 历史对账（cr-281）：
// 链路重握手信令到达时，当前分区必须强制收敛（禁指纹短路的
// 权威重拉）+ 名册重取——否则死窗期 boot 的页面永远停在旧消息。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { reactive } from 'vue';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let chatCore: typeof import('../client/chat-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  chatCore = await import('../client/chat-core.ts');
});

interface RecordedCall { method: string; params?: Record<string, unknown> }

/** 记录 rpc 调用的桩（session/history 带 fingerprint 参数透传） */
function recordingRpc() {
  const calls: RecordedCall[] = [];
  const eventHandlers: Array<(type: string, args: unknown[]) => void> = [];
  return {
    calls,
    eventHandlers,
    call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method === 'agents/list') return Promise.resolve({ agents: [] });
      if (method === 'conversation/stats') return Promise.resolve({ running: [] });
      if (method === 'interaction/list') return Promise.resolve({ interactions: [] });
      return Promise.resolve({});
    },
    onEvent(handler: (type: string, args: unknown[]) => void) {
      eventHandlers.push(handler);
      return () => undefined;
    },
    onOpen() { return () => undefined; },
    onAck() { return () => undefined; },
  };
}

function newRoster() {
  return new RosterCore();
}

describe('remote/resync 历史对账（cr-281）', () => {
  it('resync 到达 → 当前分区强制收敛（session/history 不带 fingerprint）', async () => {
    const rpc = recordingRpc();
    const roster = newRoster();
    const feed = feedCore.createFeedCore(rpc as never, () => roster);
    const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => roster);
    core.init();
    // 模拟用户选中 Agent → 分区建立（activeDialogId 联动）
    roster.bindRpc(rpc as never);
    await roster.requestAgents();
    roster.selectAgent('alpha');
    await new Promise((r) => setTimeout(r, 30));
    rpc.calls.length = 0;
    // 发 resync 信令
    for (const h of rpc.eventHandlers) h('remote/resync', []);
    await new Promise((r) => setTimeout(r, 50));
    const hist = rpc.calls.filter(c => c.method === 'session/history');
    expect(hist.length).toBeGreaterThanOrEqual(1);
    // 关键断言：对账请求禁指纹短路（fingerprint 字段不得出现）
    expect(hist.some(c => c.params && 'fingerprint' in c.params)).toBe(false);
  });

  it('resync 到达 → 名册重取（agents/list 次数增加）', async () => {
    const rpc = recordingRpc();
    const roster = newRoster();
    roster.bindRpc(rpc as never);
    const feed = feedCore.createFeedCore(rpc as never, () => roster);
    const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => roster);
    core.init();
    await new Promise((r) => setTimeout(r, 20));
    const before = rpc.calls.filter(c => c.method === 'agents/list').length;
    for (const h of rpc.eventHandlers) h('remote/resync', []);
    await new Promise((r) => setTimeout(r, 50));
    const after = rpc.calls.filter(c => c.method === 'agents/list').length;
    expect(after).toBeGreaterThan(before);
  });
});
