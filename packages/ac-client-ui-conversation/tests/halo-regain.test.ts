// @vitest-environment jsdom
// ============================================================
// halo-regain.test.ts —— 运行光环偶发消失根修（cr-802）：
// run 级 streaming（列表头像光环信号源）此前只在 run-started /
// step-started / 发送时点亮。新架构 B3 旁带是瞬态语义——断连 onOpen
// 清场、刷新撞边界帧丢失、看门狗误判回落后，run 边界帧一丢即无帧可
// 重亮点，光环熄到收束（内容照常续流）。修复：llm/delta 到达即重点亮
//（delta 是 run 在流的最高频最确凿在场证据；幂等，收束语义不变）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
});

function stubRpc() {
  const eventHandlers: Array<(type: string, args: unknown[]) => void> = [];
  const openHandlers: Array<() => void> = [];
  return {
    eventHandlers, openHandlers,
    call(method: string) {
      if (method === 'conversation/stats') return Promise.resolve({ running: [] });
      return Promise.resolve({});
    },
    onEvent(handler: (type: string, args: unknown[]) => void) {
      eventHandlers.push(handler);
      return () => undefined;
    },
    onOpen(handler: () => void) { openHandlers.push(handler); return () => undefined; },
  };
}

const CONV = 'alpha~user';
const DLG = 'pair:alpha|user' as never;

function fire(rpc: ReturnType<typeof stubRpc>, type: string, args: unknown[]) {
  rpc.eventHandlers.forEach(h => h(type, args));
}

const DELTA = (step: string): [string, unknown[]] => ['llm/delta', [{ model: 'm', meta: { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user', runId: 'r1', stepId: step } }, { delta: '字' }]];

describe('光环偶发消失根修（cr-802）', () => {
  it('重连清场后 delta 续流 → streaming 重新点亮（光环恢复）', () => {
    const rpc = stubRpc();
    const roster = new RosterCore();
    const feed = feedCore.createFeedCore(rpc as never, () => roster);
    feed.init();
    // 正常点亮 → 断连清场（onOpen 清 streaming）
    fire(rpc, 'loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    expect(feed.getDialog(DLG)?.streaming).toBe(true);
    fire(rpc, 'loop/step-started', ['alpha', 0, [], { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, ...DELTA('r1:s1'));
    rpc.openHandlers.forEach(fn => fn());
    expect(feed.getDialog(DLG)?.streaming).toBe(false); // 重连清场（复现前提）
    // 重连后 run 仍在跑：新步 delta 续流到场 → 光环信号重新点亮
    fire(rpc, ...DELTA('r1:s1'));
    expect(feed.getDialog(DLG)?.streaming).toBe(true); // 修复前：恒 false（光环熄到收束）
  });

  it('自然收束步仍正常熄灭（重点亮不破坏收束语义）', () => {
    const rpc = stubRpc();
    const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
    feed.init();
    fire(rpc, 'loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, 'loop/step-started', ['alpha', 0, [], { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, ...DELTA('r1:s1'));
    // 纯文本步收束（无工具调用）→ streaming 熄灭（边界语义不变）
    fire(rpc, 'loop/after-step', ['alpha', { index: 0, text: 'done', toolCalls: [] }, { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    expect(feed.getDialog(DLG)?.streaming).toBe(false);
  });

  it('步间工具执行窗口：带工具步收束不熄灭 + 下一 delta 保持点亮', () => {
    const rpc = stubRpc();
    const feed = feedCore.createFeedCore(rpc as never, () => new RosterCore());
    feed.init();
    fire(rpc, 'loop/run-started', [{ agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' }]);
    fire(rpc, 'loop/step-started', ['alpha', 0, [], { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    // 首步带工具调用：收束后 run 仍在途（工具执行窗口）
    fire(rpc, 'loop/after-step', ['alpha', { index: 0, text: '', toolCalls: [{ id: 't1', name: 'read', arguments: {} }] }, { runId: 'r1', stepId: 'r1:s1', conversationId: CONV, sender: 'user', source: 'user' }]);
    expect(feed.getDialog(DLG)?.streaming).toBe(true); // 工具执行窗口不熄灭
    // 模拟清场后第二步 delta 到场（重连窗口）→ 重点亮
    rpc.openHandlers.forEach(fn => fn());
    expect(feed.getDialog(DLG)?.streaming).toBe(false);
    fire(rpc, ...DELTA('r1:s2'));
    expect(feed.getDialog(DLG)?.streaming).toBe(true);
  });
});
