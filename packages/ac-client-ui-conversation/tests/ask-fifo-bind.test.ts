// ============================================================
// ask-fifo-bind.test.ts —— 同会话双 ask_questions 顶换回归：
// 旧实现 pendingInteractions 按 created_at 降序（最新优先），
// interaction computed 取首条——第二条提问到达即顶换正在作答的卡；
// respondInteraction 在提交瞬间取全局现值，把用户想答 Q1 的内容
// 提交到 Q2 的 interaction id 上（「后续提问被前面回答直接回复」）。
// 修复：FIFO 升序（先问先答）+ respondInteraction(id, answers) 显式
// 绑定作答卡。本测试走 chat-core 公共面（事件驱动入列 + 提交投递）。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { reactive } from 'vue';
import { RosterCore } from 'ac-client-ui-agents/client';
import { VIEWER_ID } from 'ac-client-ui-conversation/client/viewer.ts';
import { bucketKey } from 'ac-client-ui-conversation/client/feed.ts';

let feedCore: typeof import('../client/feed-core.ts');
let chatCore: typeof import('../client/chat-core.ts');

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  chatCore = await import('../client/chat-core.ts');
});

/** 会话键（与 interaction computed 路由同口径：pair = bucketKey(viewer, agent)） */
const convKey = () => bucketKey(VIEWER_ID.value, 'alpha');

interface RecordedCall { method: string; params?: Record<string, unknown> }

function recordingRpc() {
  const calls: RecordedCall[] = [];
  const eventHandlers: Array<(type: string, args: unknown[]) => void> = [];
  return {
    calls,
    eventHandlers,
    call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method === 'agents/list') return Promise.resolve({ agents: [{ id: 'alpha' }] });
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

/** live opened 帧载荷（ws-bridge 整形形——questions 上提为顶层） */
function openedFrame(id: string, createdAt: number, question: string) {
  return {
    id, kind: 'ask_questions', key: convKey(), owner: 'alpha', createdAt,
    questions: [{ question, options: ['是', '否'] }],
  };
}

async function setup() {
  const rpc = recordingRpc();
  const roster = new RosterCore();
  roster.bindRpc(rpc as never);
  const feed = feedCore.createFeedCore(rpc as never, () => roster);
  const core = chatCore.createChatCore(reactive(feed) as never, rpc as never, () => roster);
  core.init();
  roster.selectAgent('alpha');
  await new Promise((r) => setTimeout(r, 30));
  return { rpc, core };
}

describe('ask_questions 双提问 FIFO + 提交绑定（顶换回归）', () => {
  it('后到的提问不顶换正在作答的卡（interaction 恒为较早一条）', async () => {
    const { rpc, core } = await setup();
    for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-1', 1000, 'Q1：第一问')]);
    await new Promise((r) => setTimeout(r, 10));
    // 帧已入列（事件订阅经 core.init 注册）
    expect(core.pendingInteractions.value.map((p) => p.interaction_id)).toEqual(['dur-1']);
    expect(core.interaction.value?.interaction_id).toBe('dur-1');
    expect(core.interaction.value?.questions[0]?.question).toBe('Q1：第一问');
    // 用户正在作答时第二条提问到达（此前：降序顶换 → 卡变 Q2）
    for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-2', 2000, 'Q2：第二问')]);
    await new Promise((r) => setTimeout(r, 10));
    expect(core.interaction.value?.interaction_id).toBe('dur-1'); // FIFO：先问先答
    expect(core.pendingInteractions.value.length).toBe(2);
  });

  it('respondInteraction 绑定传入 id——答案不落在新到的提问上', async () => {
    const { rpc, core } = await setup();
    for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-1', 1000, 'Q1：第一问')]);
    for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-2', 2000, 'Q2：第二问')]);
    await new Promise((r) => setTimeout(r, 10));
    // 用户对 Q1 作答提交（调用点绑定 dur-1——组件侧即作答时看到的卡）
    core.respondInteraction('dur-1', ['是']);
    await new Promise((r) => setTimeout(r, 20));
    const reply = rpc.calls.find((c) => c.method === 'interaction/reply');
    expect(reply?.params?.id).toBe('dur-1');
    expect((reply?.params?.answer as { answers: string[] }).answers).toEqual(['是']);
  });

  it('首卡作答出列后，排队中的下一条自动接棒', async () => {
    const { rpc, core } = await setup();
    for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-1', 1000, 'Q1：第一问')]);
    for (const h of rpc.eventHandlers) h('durable-interaction/opened', [openedFrame('dur-2', 2000, 'Q2：第二问')]);
    await new Promise((r) => setTimeout(r, 10));
    core.respondInteraction('dur-1', ['是']);
    await new Promise((r) => setTimeout(r, 20));
    // 后端广播 replied（本端提交成功路径同样按 id 出列）
    for (const h of rpc.eventHandlers) h('durable-interaction/replied', [{ id: 'dur-1' }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(core.interaction.value?.interaction_id).toBe('dur-2'); // 接棒
    expect(core.pendingInteractions.value.length).toBe(1);
  });
});
