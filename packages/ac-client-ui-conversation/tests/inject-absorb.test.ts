// ============================================================
// inject-absorb.test.ts —— cr-767 注入卡展开体回归：
// inFlight 首屏合并的同锚注入行——历史行是 contextContent 唯一载体，
// 直播行丢弃语义会让正文永久缺席（卡片裸 label 不可展开）。吸收语义：
// 丢弃历史行前把 contextContent 补进直播行。
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

const INJ_BODY = '<system-reminder>技能正文（5525 字）</system-reminder>';

function rpcStub() {
  const eventHandlers: Array<(type: string, args: unknown[]) => void> = [];
  const state = { records: [] as unknown[] };
  return {
    eventHandlers,
    state,
    call(method: string) {
      if (method === 'session/history') {
        return Promise.resolve({ records: state.records, total: state.records.length, hasMore: false });
      }
      if (method === 'conversation/stats') return Promise.resolve({ running: [] });
      return Promise.resolve({});
    },
    onEvent(h: (type: string, args: unknown[]) => void) { eventHandlers.push(h); return () => undefined; },
    onOpen() { return () => undefined; },
    onAck() { return () => undefined; },
  };
}

describe('cr-767 注入卡展开体：inFlight 同锚吸收', () => {
  it('注入帧上屏（无正文）→ 重拉合并（带正文历史行）→ 直播行吸收 contextContent', async () => {
    const rpc = rpcStub();
    const roster = new RosterCore();
    const feed = feedCore.createFeedCore(rpc as never, () => roster);
    const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => roster);
    core.init();
    roster.selectAgent('alpha');
    await new Promise((r) => setTimeout(r, 30));
    // ① run 进行中：流式步占位在场（inFlight 判定源：run-started 点亮分区 streaming）
    for (const h of rpc.eventHandlers) h('loop/run-started', [{ agent: 'alpha', conversationId: 'alpha~user', sender: 'user' }]);
    // ② 注入帧上屏（直播行无正文，锚 inj-1）
    for (const h of rpc.eventHandlers) h('session/context-injected', ['alpha~user', 'alpha', { source: 'skill', label: '已加载技能 demo', injectionId: 'inj-1' }]);
    await new Promise((r) => setTimeout(r, 40));
    // ③ 服务端权威行已落账（重拉返回同锚带正文历史行）
    rpc.state.records = [
      { role: 'user', content: '问', agent_id: 'user', message_id: 'u1', timestamp: new Date(500).toISOString() },
      { role: 'context', content: INJ_BODY, source: 'skill', label: '已加载技能 demo', message_id: 'inj-1', timestamp: new Date(1000).toISOString(), agent_id: 'alpha' },
    ];
    // ④ 触发重拉：注入帧自调度的 500ms 延迟重拉（cr-767 修复面）
    await new Promise((r) => setTimeout(r, 600));
    // ⑤ 断言：直播注入行已吸收正文（修复前恒 undefined → 卡片不可展开）
    const dialogs = (feed as unknown as { dialogs: { value: Record<string, { rawMessages: Array<Record<string, unknown>> }> } }).dialogs;
    const all = Object.values(dialogs.value).flatMap((d) => d.rawMessages);
    const inj = all.find((m) => m.persistedMsgId === 'inj-1');
    expect(inj).toBeTruthy();
    expect((inj as { contextContent?: string }).contextContent).toBe(INJ_BODY);
  });
});